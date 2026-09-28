// GitLab setup for the AI agent, run by the Helm chart's setup Job/CronJob
// (`node src/setup.ts`) when `gitlabSetup.enabled` is true. Needs an admin
// token; it never runs inside the internet-facing webhook pod.
//
// Every step is idempotent, so the CronJob can re-run it to pick up new
// groups/projects and rotate the bot token before it expires:
//   1. bot account: create (service account, or plain user as a fallback),
//      keep name/email in sync, upload the avatar when it changed
//   2. Developer (configurable) on the groups matching `SETUP_GROUPS`
//      (default `*`: every group, but only the topmost ones get a membership)
//   3. system hook for merge request events -> the webhook Service
//   4. for the projects matching `SETUP_PROJECTS` (default `*`): bot
//      membership (unless inherited) and a project webhook with comment events,
//      which system hooks can't deliver
//   5. bot personal access token, stored in a Kubernetes Secret the webhook
//      Deployment reads as GITLAB_TOKEN; rotated before expiry, after which the
//      Deployment is restarted to pick the new token up
//   6. webhook Deployment restarted when the chart's gitlab.*/secrets.* values
//      changed (CONFIG_CHECKSUM vs. the annotation the pods last ran with)
//
// SETUP_GROUPS / SETUP_PROJECTS are JSON arrays of glob patterns (`*`, `?`,
// matched case-insensitively against the full path; `*` also matches `/`) or
// {path, accessLevel, mergeRequestsEvents} objects; the first match wins.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { logger } from "./logger.ts";

const HOOK_NAME = "ai-agent-for-gitlab";
const TOKEN_NAME = "ai-agent-for-gitlab";
const AVATAR_ATTRIBUTE = "ai_agent_for_gitlab_avatar_sha256";
const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";
const CHECKSUM_ANNOTATION = "ai-agent-for-gitlab/config-checksum";

export interface SetupConfig {
  gitlabUrl: string;
  adminToken: string;
  bot: {
    username: string;
    name: string;
    email: string;
    accountType: "service_account" | "user";
    avatarPath: string;
    accessLevel: number;
  };
  // Groups to join and projects to set up; [] = none.
  groups: Target[];
  projects: Target[];
  // `enabled` only gates the system hook; url/token/sslVerification are also
  // used for the project webhooks.
  hook: { enabled: boolean; url: string; token: string; sslVerification: boolean };
  token: {
    expiryDays: number;
    renewBeforeDays: number;
    secretName: string;
    secretKey: string;
    // Deployment restarted after a rotation so pods load the new token.
    deployment: string;
  };
  // Checksum of the chart's gitlab.*/secrets.* values; "" disables the check.
  configChecksum: string;
  kube: { apiUrl: string; namespace: string; token: string };
}

export interface Target {
  // Full path or glob pattern.
  pattern: string;
  // Bot role; defaults to bot.accessLevel.
  accessLevel: number;
  // Projects only: also send merge request events through the project
  // webhook. Defaults to on only without the system hook, which already
  // delivers them (both would trigger every review twice).
  mergeRequestsEvents: boolean;
}

type Json = Record<string, any>;

class GitLabError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} environment variable`);
  return value;
}

async function readIfExists(path: string): Promise<string> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    return "";
  }
}

export async function loadConfig(env = process.env): Promise<SetupConfig> {
  const accountType = env.BOT_ACCOUNT_TYPE || "service_account";
  if (accountType !== "service_account" && accountType !== "user") {
    throw new Error(`BOT_ACCOUNT_TYPE must be service_account or user, got "${accountType}"`);
  }
  const hookEnabled = env.SYSTEM_HOOK_ENABLED !== "false";
  const accessLevel = Number(env.BOT_ACCESS_LEVEL || 30);
  const groups = parseTargets("SETUP_GROUPS", env.SETUP_GROUPS, accessLevel, false);
  const projects = parseTargets("SETUP_PROJECTS", env.SETUP_PROJECTS, accessLevel, !hookEnabled);
  const needsHookTarget = hookEnabled || projects.length > 0;

  return {
    gitlabUrl: (env.GITLAB_URL || "https://gitlab.com").replace(/\/+$/, ""),
    adminToken: requireEnv("GITLAB_ADMIN_TOKEN"),
    bot: {
      username: requireEnv("AI_GITLAB_USERNAME"),
      name: env.BOT_NAME || "AI Agent",
      email: env.AI_GITLAB_EMAIL || "",
      accountType,
      avatarPath: env.BOT_AVATAR_PATH || "",
      accessLevel,
    },
    groups,
    projects,
    hook: {
      enabled: hookEnabled,
      url: needsHookTarget ? requireEnv("SYSTEM_HOOK_URL") : "",
      token: needsHookTarget ? requireEnv("WEBHOOK_SECRET") : "",
      sslVerification: env.SYSTEM_HOOK_SSL_VERIFICATION !== "false",
    },
    token: {
      expiryDays: Number(env.BOT_TOKEN_EXPIRY_DAYS || 90),
      renewBeforeDays: Number(env.BOT_TOKEN_RENEW_BEFORE_DAYS || 14),
      secretName: requireEnv("BOT_TOKEN_SECRET"),
      secretKey: env.BOT_TOKEN_SECRET_KEY || "GITLAB_TOKEN",
      deployment: env.RESTART_DEPLOYMENT || "",
    },
    configChecksum: env.CONFIG_CHECKSUM || "",
    kube: {
      apiUrl:
        env.K8S_API_URL ||
        `https://${requireEnv("KUBERNETES_SERVICE_HOST")}:${env.KUBERNETES_SERVICE_PORT || "443"}`,
      namespace: env.K8S_NAMESPACE || (await readIfExists(`${SA_DIR}/namespace`)),
      token: env.K8S_TOKEN || (await readIfExists(`${SA_DIR}/token`)),
    },
  };
}

// Unset = ["*"] (everything), "" = []. A JSON array of patterns or
// {path, accessLevel, mergeRequestsEvents} objects; a plain comma-separated
// list (the pre-JSON SETUP_GROUPS format) is still accepted.
export function parseTargets(
  name: string,
  raw: string | undefined,
  defaultAccessLevel: number,
  defaultMrEvents: boolean
): Target[] {
  if (raw === undefined) raw = '["*"]';
  raw = raw.trim();
  let entries: unknown[];
  if (raw.startsWith("[")) {
    try {
      entries = JSON.parse(raw);
    } catch (e) {
      throw new Error(`${name} is not valid JSON: ${e instanceof Error ? e.message : e}`);
    }
    if (!Array.isArray(entries)) throw new Error(`${name} must be a JSON array`);
  } else {
    entries = raw.split(",");
  }

  const targets: Target[] = [];
  entries.forEach((entry, i) => {
    const t: Json = typeof entry === "string" ? { path: entry } : (entry as Json) ?? {};
    const pattern = typeof t.path === "string" ? t.path.trim().replace(/^\/+|\/+$/g, "") : "";
    if (!pattern) {
      // Blank strings come from the comma form ("a,,b"); objects need a path.
      if (typeof entry === "string") return;
      throw new Error(`${name}[${i}] needs a path`);
    }
    const accessLevel = t.accessLevel == null ? defaultAccessLevel : Number(t.accessLevel);
    if (!Number.isInteger(accessLevel)) throw new Error(`${name}[${i}].accessLevel must be a number`);
    targets.push({
      pattern,
      accessLevel,
      mergeRequestsEvents: t.mergeRequestsEvents == null ? defaultMrEvents : t.mergeRequestsEvents === true,
    });
  });
  return targets;
}

function isGlob(pattern: string): boolean {
  return /[*?]/.test(pattern);
}

// `*` = any characters (including `/`), `?` = one character. GitLab paths
// are case-insensitive.
export function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .split("")
    .map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${source}$`, "i");
}

// First target whose pattern matches the full path, or undefined.
export function matchTarget(targets: Target[], fullPath: string): Target | undefined {
  return targets.find((t) => globToRegExp(t.pattern).test(fullPath));
}

// Groups whose membership is inherited from a selected ancestor with at least
// the same role need no membership of their own.
export function topmostGroups<T extends { path: string; target: Target }>(selected: T[]): T[] {
  const byPath = new Map(selected.map((s) => [s.path.toLowerCase(), s]));
  return selected.filter((s) => {
    const parts = s.path.toLowerCase().split("/");
    for (let i = 1; i < parts.length; i++) {
      const ancestor = byPath.get(parts.slice(0, i).join("/"));
      if (ancestor && ancestor.target.accessLevel >= s.target.accessLevel) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

// fetch() rejects network failures with a bare "fetch failed"; the reason
// (ENOTFOUND, ECONNREFUSED, a TLS error, ...) is only in `cause`. Rethrow with
// the URL and that reason so the setup log says what actually went wrong.
async function fetchOrExplain(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    throw new Error(`${init?.method ?? "GET"} ${url} failed: ${describeCause(e)}`, { cause: e });
  }
}

function describeCause(e: unknown): string {
  const cause = (e as { cause?: unknown })?.cause ?? e;
  if (cause instanceof AggregateError) return cause.errors.map(describeCause).join("; ");
  const { code, message } = cause as { code?: string; message?: string };
  if (!message) return code ?? String(cause);
  return code && !message.includes(code) ? `${code}: ${message}` : message;
}

function gitlab(cfg: SetupConfig) {
  const request = async (
    method: string,
    path: string,
    body?: Json | FormData,
    token = cfg.adminToken
  ): Promise<any> => {
    const headers: Record<string, string> = { "PRIVATE-TOKEN": token };
    let payload: string | FormData | undefined;
    if (body instanceof FormData) {
      payload = body;
    } else if (body) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetchOrExplain(`${cfg.gitlabUrl}/api/v4${path}`, { method, headers, body: payload });
    const text = await res.text();
    if (!res.ok) {
      throw new GitLabError(res.status, `GitLab ${method} ${path} failed: ${res.status} ${text.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : null;
  };

  // Follows GitLab's keyset/offset pagination via the `x-next-page` header.
  const list = async (path: string): Promise<Json[]> => {
    const items: Json[] = [];
    let page = "1";
    while (page) {
      const sep = path.includes("?") ? "&" : "?";
      const res = await fetchOrExplain(`${cfg.gitlabUrl}/api/v4${path}${sep}per_page=100&page=${page}`, {
        headers: { "PRIVATE-TOKEN": cfg.adminToken },
      });
      if (!res.ok) {
        throw new GitLabError(res.status, `GitLab GET ${path} failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
      }
      items.push(...((await res.json()) as Json[]));
      page = res.headers.get("x-next-page") || "";
    }
    return items;
  };

  return { request, list };
}

function kube(cfg: SetupConfig) {
  return async (method: string, path: string, body?: Json, contentType = "application/json") => {
    const res = await fetchOrExplain(`${cfg.kube.apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.kube.token}`,
        "Content-Type": contentType,
        Accept: "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Json) : null };
  };
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

async function ensureBot(cfg: SetupConfig, gl: ReturnType<typeof gitlab>): Promise<Json> {
  const { bot } = cfg;
  const found: Json[] = await gl.request("GET", `/users?username=${encodeURIComponent(bot.username)}`);
  let user = found[0];

  if (!user) {
    if (bot.accountType === "service_account") {
      user = await gl.request("POST", "/service_accounts", {
        name: bot.name,
        username: bot.username,
        ...(bot.email ? { email: bot.email } : {}),
      });
    } else {
      const host = new URL(cfg.gitlabUrl).hostname;
      user = await gl.request("POST", "/users", {
        name: bot.name,
        username: bot.username,
        email: bot.email || `${bot.username}@noreply.${host}`,
        force_random_password: true,
        skip_confirmation: true,
        // Least privilege: the bot only works in existing projects.
        projects_limit: 0,
        can_create_group: false,
      });
    }
    logger.info("Created bot account", { username: bot.username, id: user.id, type: bot.accountType });
  } else {
    // Keep name/email in sync with the chart values.
    const wantEmail = bot.email && user.email !== bot.email ? bot.email : undefined;
    if (user.name !== bot.name || wantEmail) {
      await cosmetic("Could not update bot account", async () => {
        await gl.request("PUT", `/users/${user.id}`, {
          name: bot.name,
          ...(wantEmail ? { email: wantEmail, skip_reconfirmation: true } : {}),
        });
        logger.info("Updated bot account", { username: bot.username, id: user.id });
      });
    }
  }

  if (bot.avatarPath) await cosmetic("Could not upload bot avatar", () => ensureAvatar(gl, user.id, bot.avatarPath));
  return user;
}

// Profile/avatar updates are cosmetic: GitLab can reject them (e.g. a 500 on
// PUT /users/:id for a service account), which must not stop the group
// memberships, system hook and token steps that follow.
async function cosmetic(warning: string, step: () => Promise<void>) {
  try {
    await step();
  } catch (e) {
    logger.warn(warning, { error: e instanceof Error ? e.message : e });
  }
}

// GitLab gives no way to compare avatar contents, so the uploaded file's hash
// is kept in a user custom attribute; upload only when it changed.
async function ensureAvatar(gl: ReturnType<typeof gitlab>, userId: number, path: string) {
  const data = await readFile(path);
  const sha = createHash("sha256").update(data).digest("hex");

  let current = "";
  try {
    current = (await gl.request("GET", `/users/${userId}/custom_attributes/${AVATAR_ATTRIBUTE}`)).value;
  } catch (e) {
    if (!(e instanceof GitLabError && e.status === 404)) throw e;
  }
  if (current === sha) return;

  const form = new FormData();
  form.append("avatar", new Blob([data], { type: "image/png" }), "bot-avatar.png");
  await gl.request("PUT", `/users/${userId}`, form);
  await gl.request("PUT", `/users/${userId}/custom_attributes/${AVATAR_ATTRIBUTE}`, { value: sha });
  logger.info("Uploaded bot avatar", { userId });
}

type Kind = "groups" | "projects";
interface Resolved {
  item: Json;
  path: string;
  target: Target;
}

// Groups/projects matching the targets, minus those pending deletion and
// archived projects. Plain paths are fetched directly; any glob lists the
// whole instance (the admin token sees everything).
async function resolveTargets(gl: ReturnType<typeof gitlab>, kind: Kind, targets: Target[]): Promise<Resolved[]> {
  if (!targets.length) return [];
  const pathOf = (item: Json): string => (kind === "groups" ? item.full_path : item.path_with_namespace);

  let items: Json[] = [];
  if (targets.some((t) => isGlob(t.pattern))) {
    items = await gl.list(kind === "groups" ? "/groups?all_available=true" : "/projects?archived=false");
  } else {
    for (const t of targets) {
      try {
        items.push(await gl.request("GET", `/${kind}/${encodeURIComponent(t.pattern)}`));
      } catch (e) {
        if (!(e instanceof GitLabError && e.status === 404)) throw e;
        logger.warn(`${kind === "groups" ? "Group" : "Project"} not found, skipping`, { path: t.pattern });
      }
    }
  }

  const seen = new Set<number>();
  const resolved: Resolved[] = [];
  for (const item of items) {
    if (seen.has(item.id) || item.marked_for_deletion_on || item.marked_for_deletion_at || item.archived) continue;
    seen.add(item.id);
    const path = pathOf(item);
    const target = matchTarget(targets, path);
    if (target) resolved.push({ item, path, target });
  }
  return resolved;
}

// Adds the bot or raises its role, never lowers it: an admin may have granted
// more on purpose. An inherited role that is high enough is left alone (GitLab
// also rejects a direct membership below an inherited one).
async function ensureMember(
  gl: ReturnType<typeof gitlab>,
  kind: Kind,
  id: number,
  path: string,
  userId: number,
  accessLevel: number
): Promise<boolean> {
  const get = async (suffix: string): Promise<Json | null> => {
    try {
      return await gl.request("GET", `/${kind}/${id}/members/${suffix}`);
    } catch (e) {
      if (!(e instanceof GitLabError && e.status === 404)) throw e;
      return null;
    }
  };
  const context = { [kind === "groups" ? "group" : "project"]: path, accessLevel };

  const effective = await get(`all/${userId}`);
  if (effective && effective.access_level >= accessLevel) return false;

  if (await get(`${userId}`)) {
    await gl.request("PUT", `/${kind}/${id}/members/${userId}`, { access_level: accessLevel });
    logger.info("Raised bot access level", context);
    return false;
  }
  await gl.request("POST", `/${kind}/${id}/members`, { user_id: userId, access_level: accessLevel });
  logger.info(`Added bot to ${kind === "groups" ? "group" : "project"}`, context);
  return true;
}

async function ensureMemberships(cfg: SetupConfig, gl: ReturnType<typeof gitlab>, userId: number) {
  const groups = topmostGroups(await resolveTargets(gl, "groups", cfg.groups));
  let added = 0;
  for (const { item, path, target } of groups) {
    if (await ensureMember(gl, "groups", item.id, path, userId, target.accessLevel)) added++;
  }
  logger.info("Group memberships in sync", { groups: groups.length, added });
}

// One failing project (e.g. missing permissions) must not stop the others or
// the token rotation that follows.
async function ensureProjects(cfg: SetupConfig, gl: ReturnType<typeof gitlab>, userId: number) {
  const projects = await resolveTargets(gl, "projects", cfg.projects);
  let added = 0;
  let failed = 0;
  for (const { item, path, target } of projects) {
    try {
      if (await ensureMember(gl, "projects", item.id, path, userId, target.accessLevel)) added++;
      await ensureProjectHook(cfg, gl, item.id, path, target);
    } catch (e) {
      failed++;
      logger.warn("Could not set up project", { project: path, error: e instanceof Error ? e.message : e });
    }
  }
  logger.info("Projects in sync", { projects: projects.length, added, failed });
}

async function ensureProjectHook(
  cfg: SetupConfig,
  gl: ReturnType<typeof gitlab>,
  projectId: number,
  path: string,
  target: Target
) {
  const hooks = await gl.list(`/projects/${projectId}/hooks`);
  const existing = hooks.find((h) => h.name === HOOK_NAME) || hooks.find((h) => h.url === cfg.hook.url);

  // Project hooks default push_events to true; everything else to false.
  const body = {
    name: HOOK_NAME,
    description: "AI agent for GitLab: comments (@mentions) and, without the system hook, merge request events",
    url: cfg.hook.url,
    token: cfg.hook.token,
    note_events: true,
    merge_requests_events: target.mergeRequestsEvents,
    push_events: false,
    enable_ssl_verification: cfg.hook.sslVerification,
  };

  if (existing) {
    // The token can't be read back, so always re-send it to keep it in sync.
    await gl.request("PUT", `/projects/${projectId}/hooks/${existing.id}`, body);
    logger.debug("Updated project hook", { project: path, id: existing.id });
  } else {
    const hook = await gl.request("POST", `/projects/${projectId}/hooks`, body);
    logger.info("Created project hook", { project: path, id: hook.id, url: cfg.hook.url });
  }
}

async function ensureSystemHook(cfg: SetupConfig, gl: ReturnType<typeof gitlab>) {
  const hooks: Json[] = await gl.request("GET", "/hooks");
  const existing = hooks.find((h) => h.name === HOOK_NAME) || hooks.find((h) => h.url === cfg.hook.url);

  // System hooks can't deliver comment (note) events; @mentions still need a
  // project or group webhook. repository_update_events defaults to true, so
  // switch it (and push/tag events) off explicitly.
  const body = {
    name: HOOK_NAME,
    description: "AI agent for GitLab: merge request events (reviewer/assignee reviews)",
    url: cfg.hook.url,
    token: cfg.hook.token,
    merge_requests_events: true,
    push_events: false,
    tag_push_events: false,
    repository_update_events: false,
    enable_ssl_verification: cfg.hook.sslVerification,
  };

  if (existing) {
    // The token can't be read back, so always re-send it to keep it in sync.
    await gl.request("PUT", `/hooks/${existing.id}`, body);
    logger.info("Updated system hook", { id: existing.id, url: cfg.hook.url });
  } else {
    const hook = await gl.request("POST", "/hooks", body);
    logger.info("Created system hook", { id: hook.id, url: cfg.hook.url });
  }
}

// Returns true when a new token was stored (and the Deployment restarted).
async function ensureBotToken(cfg: SetupConfig, gl: ReturnType<typeof gitlab>, userId: number): Promise<boolean> {
  const k8s = kube(cfg);
  const secretPath = `/api/v1/namespaces/${cfg.kube.namespace}/secrets/${cfg.token.secretName}`;

  const secret = await k8s("GET", secretPath);
  if (secret.status !== 200 && secret.status !== 404) {
    throw new Error(`Reading Secret ${cfg.token.secretName} failed: ${secret.status}`);
  }
  const stored = secret.status === 200 && secret.body?.data?.[cfg.token.secretKey]
    ? Buffer.from(secret.body.data[cfg.token.secretKey], "base64").toString("utf8")
    : "";

  // Keep the stored token while it's valid, belongs to the bot and isn't close to expiry.
  let oldTokenId: number | undefined;
  if (stored) {
    try {
      const self = await gl.request("GET", "/personal_access_tokens/self", undefined, stored);
      oldTokenId = self.id;
      const renewBy = Date.now() + cfg.token.renewBeforeDays * 86_400_000;
      const expires = self.expires_at ? Date.parse(self.expires_at) : Infinity;
      if (self.active && self.user_id === userId && expires > renewBy) {
        logger.info("Bot token still valid", { expiresAt: self.expires_at });
        return false;
      }
      logger.info("Rotating bot token", { expiresAt: self.expires_at, active: self.active });
    } catch (e) {
      if (!(e instanceof GitLabError && e.status === 401)) throw e;
      logger.warn("Stored bot token is invalid or revoked, creating a new one");
    }
  }

  const expiresAt = new Date(Date.now() + cfg.token.expiryDays * 86_400_000).toISOString().slice(0, 10);
  const created = await gl.request("POST", `/users/${userId}/personal_access_tokens`, {
    name: TOKEN_NAME,
    scopes: ["api"],
    expires_at: expiresAt,
  });

  const data = { [cfg.token.secretKey]: Buffer.from(created.token).toString("base64") };
  const res = secret.status === 404
    ? await k8s("POST", `/api/v1/namespaces/${cfg.kube.namespace}/secrets`, {
        apiVersion: "v1",
        kind: "Secret",
        metadata: {
          name: cfg.token.secretName,
          labels: { "app.kubernetes.io/managed-by": "ai-agent-for-gitlab-setup" },
        },
        type: "Opaque",
        data,
      })
    : await k8s("PATCH", secretPath, { data }, "application/merge-patch+json");
  if (res.status >= 300) {
    // Don't leave an unusable token behind.
    await gl.request("DELETE", `/personal_access_tokens/${created.id}`).catch(() => {});
    throw new Error(`Writing Secret ${cfg.token.secretName} failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  logger.info("Stored new bot token", { secret: cfg.token.secretName, expiresAt });

  if (oldTokenId) {
    await gl.request("DELETE", `/personal_access_tokens/${oldTokenId}`).catch((e) =>
      logger.warn("Could not revoke previous bot token", { error: e.message })
    );
  }

  await restartDeployment(cfg, k8s, "load the new token", {
    "ai-agent-for-gitlab/token-rotated-at": new Date().toISOString(),
  });
  return true;
}

// Restarts the Deployment when the chart's gitlab.*/secrets.* values changed
// since its pods were last (re)started by this setup.
async function ensureDeploymentConfig(cfg: SetupConfig) {
  if (!cfg.token.deployment || !cfg.configChecksum) return;
  const k8s = kube(cfg);
  const res = await k8s("GET", deploymentPath(cfg));
  if (res.status === 404) {
    logger.info("Deployment not found yet, nothing to restart", { deployment: cfg.token.deployment });
    return;
  }
  if (res.status >= 300) {
    logger.warn("Could not read deployment", { deployment: cfg.token.deployment, status: res.status });
    return;
  }
  if (res.body?.spec?.template?.metadata?.annotations?.[CHECKSUM_ANNOTATION] === cfg.configChecksum) {
    logger.info("Deployment config unchanged", { deployment: cfg.token.deployment });
    return;
  }
  await restartDeployment(cfg, k8s, "apply changed gitlab/secrets values");
}

function deploymentPath(cfg: SetupConfig) {
  return `/apis/apps/v1/namespaces/${cfg.kube.namespace}/deployments/${cfg.token.deployment}`;
}

// Patching the pod template rolls the pods; the config checksum is recorded on
// every restart so ensureDeploymentConfig doesn't restart them a second time.
async function restartDeployment(
  cfg: SetupConfig,
  k8s: ReturnType<typeof kube>,
  reason: string,
  annotations: Record<string, string> = {}
) {
  if (!cfg.token.deployment) return;
  if (cfg.configChecksum) annotations[CHECKSUM_ANNOTATION] = cfg.configChecksum;
  const res = await k8s(
    "PATCH",
    deploymentPath(cfg),
    { spec: { template: { metadata: { annotations } } } },
    "application/strategic-merge-patch+json"
  );
  if (res.status === 404) {
    logger.info("Deployment not found yet, nothing to restart", { deployment: cfg.token.deployment });
  } else if (res.status >= 300) {
    logger.warn("Could not restart deployment", { deployment: cfg.token.deployment, reason, status: res.status });
  } else {
    logger.info("Restarted deployment", { deployment: cfg.token.deployment, reason });
  }
}

export async function runSetup(cfg: SetupConfig) {
  const gl = gitlab(cfg);

  const me = await gl.request("GET", "/user");
  if (!me.is_admin) throw new Error(`GITLAB_ADMIN_TOKEN belongs to ${me.username}, who is not an administrator`);

  const bot = await ensureBot(cfg, gl);
  await ensureMemberships(cfg, gl, bot.id);
  if (cfg.hook.enabled) await ensureSystemHook(cfg, gl);
  await ensureProjects(cfg, gl, bot.id);
  const restarted = await ensureBotToken(cfg, gl, bot.id);
  if (!restarted) await ensureDeploymentConfig(cfg);
  logger.info("GitLab setup complete", { bot: cfg.bot.username });
}

if (import.meta.main) {
  try {
    await runSetup(await loadConfig());
  } catch (error) {
    logger.error("GitLab setup failed", { error: error instanceof Error ? error.message : error });
    process.exit(1);
  }
}
