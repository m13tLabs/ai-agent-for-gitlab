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
//      or the webhook secret in use changed (CONFIG_CHECKSUM + WEBHOOK_SECRET
//      vs. the annotation the pods last ran with)
//   7. optional (CENTRAL_PIPELINE_ENABLED, runner mode): the component project
//      from COMPONENT_CLONE_URL (a pull mirror, synced every run, on Premium/
//      Ultimate; otherwise imported once), made a CI/CD Catalog resource, and
//      the runner project whose .gitlab-ci.yml includes its agent-runner
//      component; the bot is Owner of both
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
  // Checksum of the chart's gitlab.*/secrets.* values plus the webhook secret
  // in use; "" disables the check.
  configChecksum: string;
  kube: { apiUrl: string; namespace: string; token: string };
  // Runner mode: a project with the agent-runner CI/CD component, imported
  // from cloneUrl, and the runner project including it. Full paths; their
  // groups must exist. `ref` "" = the component project's default branch.
  centralPipeline: {
    enabled: boolean;
    componentProject: string;
    cloneUrl: string;
    // Pull-mirror cloneUrl where the edition allows it (Premium/Ultimate).
    mirror: boolean;
    ref: string;
    runnerProject: string;
    inputs: Json;
    visibility: string;
  };
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

// The chart's CONFIG_CHECKSUM only covers values. A generated webhook secret
// isn't a value and changes whenever the chart is rendered without `lookup`
// (Argo CD, Flux, helm template): the hooks get the new secret from this run,
// so the pods must restart to compare against the same one. Hence the secret
// actually in use is hashed in too.
function configChecksum(chartChecksum: string, webhookSecret: string): string {
  if (!chartChecksum) return "";
  if (!webhookSecret) return chartChecksum;
  return createHash("sha256").update(`${chartChecksum}\0${webhookSecret}`).digest("hex");
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
  const centralPipeline = env.CENTRAL_PIPELINE_ENABLED === "true";
  const inputs = JSON.parse(env.RUNNER_COMPONENT_INPUTS || "{}");
  if (typeof inputs !== "object" || inputs === null || Array.isArray(inputs)) {
    throw new Error(`RUNNER_COMPONENT_INPUTS must be a JSON object, got ${env.RUNNER_COMPONENT_INPUTS}`);
  }

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
    configChecksum: configChecksum(env.CONFIG_CHECKSUM || "", env.WEBHOOK_SECRET || ""),
    kube: {
      apiUrl:
        env.K8S_API_URL ||
        `https://${requireEnv("KUBERNETES_SERVICE_HOST")}:${env.KUBERNETES_SERVICE_PORT || "443"}`,
      namespace: env.K8S_NAMESPACE || (await readIfExists(`${SA_DIR}/namespace`)),
      token: env.K8S_TOKEN || (await readIfExists(`${SA_DIR}/token`)),
    },
    centralPipeline: {
      enabled: centralPipeline,
      componentProject: centralPipeline ? requireEnv("COMPONENT_PROJECT") : "",
      cloneUrl: centralPipeline ? requireEnv("COMPONENT_CLONE_URL") : "",
      mirror: env.COMPONENT_MIRROR !== "false",
      ref: env.COMPONENT_REF || "",
      runnerProject: centralPipeline ? requireEnv("RUNNER_PROJECT") : "",
      inputs,
      visibility: env.CENTRAL_PIPELINE_VISIBILITY || "private",
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

  // The CI/CD Catalog has no REST API. Throws on HTTP or GraphQL errors.
  const graphql = async (query: string, variables: Json): Promise<Json> => {
    const res = await fetchOrExplain(`${cfg.gitlabUrl}/api/graphql`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const text = await res.text();
    const body = text ? JSON.parse(text) : {};
    if (!res.ok || body.errors?.length) {
      const reason = body.errors?.map((e: Json) => e.message).join("; ") || `${res.status} ${text.slice(0, 300)}`;
      throw new GitLabError(res.status, `GitLab GraphQL failed: ${reason}`);
    }
    return body.data ?? {};
  };

  return { request, list, graphql };
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

// ---------------------------------------------------------------------------
// Central pipeline (runner mode)
// ---------------------------------------------------------------------------

const COMPONENT_NAME = "agent-runner";
const OWNER = 50;
const MANAGED_NOTE = "Managed by the ai-agent-for-gitlab setup (Helm value gitlabSetup.centralPipeline)";

// Browsable link for a clone URL: credentials (a token for a private source)
// and the `.git` suffix dropped.
export function sourceLink(cloneUrl: string): string {
  try {
    const url = new URL(cloneUrl);
    url.username = "";
    url.password = "";
    return url.toString().replace(/\/$/, "").replace(/\.git$/, "");
  } catch {
    return cloneUrl;
  }
}

export function runnerCiConfig(componentProject: string, ref: string, inputs: Json): string {
  const lines = [
    `# ${MANAGED_NOTE}; edits here are overwritten.`,
    "# Component inputs: gitlabSetup.centralPipeline.runner.inputs",
    "include:",
    `  - component: $CI_SERVER_FQDN/${componentProject}/${COMPONENT_NAME}@${ref}`,
  ];
  // JSON is valid YAML (flow style), which keeps this free of a YAML dependency.
  if (Object.keys(inputs).length) lines.push(`    inputs: ${JSON.stringify(inputs)}`);
  return `${lines.join("\n")}\n`;
}

export function runnerReadme(cfg: SetupConfig): string {
  const cp = cfg.centralPipeline;
  return `# AI agent runner

Runs the [AI agent for GitLab](${sourceLink(cp.cloneUrl)}) for every project (runner mode). The webhook app starts one pipeline here per \`@${cfg.bot.username}\` mention or review request and passes the target project as pipeline variables (\`AI_PROJECT_ID\`, \`AI_PROJECT_PATH\`, \`AI_BRANCH\`). The agent clones that project itself, so the projects need no CI changes.

- \`.gitlab-ci.yml\` includes the \`${COMPONENT_NAME}\` CI/CD component from [${cp.componentProject}](${cfg.gitlabUrl}/${cp.componentProject}). ${MANAGED_NOTE}: edits to it are overwritten; set the component inputs in the Helm values instead.
- Add these CI/CD variables here (Settings → CI/CD → Variables, not protected), or let a dedicated runner inject them:
  - \`GITLAB_TOKEN\`: a token of @${cfg.bot.username}
  - the provider keys of the model, e.g. \`ANTHROPIC_API_KEY\`, or \`AWS_ACCESS_KEY_ID\`, \`AWS_SECRET_ACCESS_KEY\` and \`AWS_REGION\` for Amazon Bedrock
- The pipeline variables here contain prompts and discussion excerpts of every project the agent works on. Keep this project's membership small.

This README is created once and not overwritten.
`;
}

async function findProject(gl: ReturnType<typeof gitlab>, path: string): Promise<Json | null> {
  try {
    return await gl.request("GET", `/projects/${encodeURIComponent(path)}`);
  } catch (e) {
    if (e instanceof GitLabError && e.status === 404) return null;
    throw e;
  }
}

// New project at `path` in its (existing) parent group.
async function createProject(gl: ReturnType<typeof gitlab>, path: string, attributes: Json): Promise<Json> {
  const slash = path.lastIndexOf("/");
  if (slash < 1) throw new Error(`Project path "${path}" needs a group, e.g. ai/${path}`);
  const groupPath = path.slice(0, slash);
  const name = path.slice(slash + 1);
  let group: Json;
  try {
    group = await gl.request("GET", `/groups/${encodeURIComponent(groupPath)}`);
  } catch (e) {
    if (e instanceof GitLabError && e.status === 404) throw new Error(`Group "${groupPath}" for project ${path} not found`);
    throw e;
  }
  const project = await gl.request("POST", "/projects", { name, path: name, namespace_id: group.id, ...attributes });
  logger.info("Created project", { project: path });
  return project;
}

export interface Edition {
  version: string;
  enterprise: boolean;
  // License plan (premium, ultimate, ...); "" on CE or without a license.
  plan: string;
}

// EE with a valid Premium/Ultimate license; pull mirroring needs that.
export function canPullMirror(edition: Edition): boolean {
  return edition.enterprise && ["premium", "ultimate"].includes(edition.plan);
}

async function detectEdition(gl: ReturnType<typeof gitlab>): Promise<Edition> {
  const optional = async (path: string): Promise<Json | null> => {
    try {
      return await gl.request("GET", path);
    } catch (e) {
      if (e instanceof GitLabError && (e.status === 404 || e.status === 403)) return null;
      throw e;
    }
  };
  // /metadata (GitLab 15.2+) says CE or EE; /license only exists on EE.
  const metadata = await optional("/metadata");
  const enterprise = metadata?.enterprise === true;
  const license = enterprise ? await optional("/license") : null;
  const plan = license && !license.expired ? String(license.plan ?? "").toLowerCase() : "";
  const edition = { version: metadata?.version ?? "unknown", enterprise, plan };
  logger.info("GitLab edition", { ...edition, pullMirroring: canPullMirror(edition) });
  return edition;
}

// Component project from cloneUrl: a pull mirror kept in sync when the
// instance supports it (Premium/Ultimate), otherwise imported once (GitLab
// Free can't mirror; delete the project to re-import). Returns it once its
// first import is done, null while that's still running.
async function ensureComponentProject(cfg: SetupConfig, gl: ReturnType<typeof gitlab>, botId: number): Promise<Json | null> {
  const cp = cfg.centralPipeline;
  const mirror = cp.mirror && canPullMirror(await detectEdition(gl));
  if (cp.mirror && !mirror) logger.info("Pull mirroring needs GitLab Premium or Ultimate; importing the component project once instead");

  const description =
    `CI/CD component "${COMPONENT_NAME}" of the AI agent for GitLab, ${mirror ? "mirrored" : "imported"} from ${sourceLink(cp.cloneUrl)}. ${MANAGED_NOTE}.`;
  // Mirror updates don't start pipelines; diverged branches follow the source.
  const mirrorAttributes = { mirror: true, import_url: cp.cloneUrl, mirror_trigger_builds: false, mirror_overwrites_diverged_branches: true };

  const existing = await findProject(gl, cp.componentProject);
  let project: Json;
  if (!existing) {
    try {
      project = await createProject(gl, cp.componentProject, {
        import_url: cp.cloneUrl,
        description,
        visibility: cp.visibility,
        ...(mirror ? mirrorAttributes : {}),
      });
    } catch (e) {
      // GitLab checks the URL with `git ls-remote` from its own servers first.
      if (e instanceof GitLabError && e.status === 422 && /unable to access repository/i.test(e.message)) {
        throw new Error(
          `GitLab can't reach ${sourceLink(cp.cloneUrl)} to import ${cp.componentProject} (${e.message}). ` +
            "The GitLab server itself clones it, not this Job: give GitLab outbound access (or its proxy settings), " +
            "or set gitlabSetup.centralPipeline.component.cloneUrl to a mirror GitLab can reach; " +
            "a private source needs credentials in the URL."
        );
      }
      throw e;
    }
  } else {
    project = existing;
    // GitLab returns import_url without credentials, hence the comparison by link.
    const mirrorOutdated =
      mirror && (project.mirror !== true || sourceLink(project.import_url ?? "") !== sourceLink(cp.cloneUrl));
    const update = {
      ...(project.description !== description ? { description } : {}),
      ...(mirrorOutdated ? mirrorAttributes : {}),
    };
    if (Object.keys(update).length) {
      await gl.request("PUT", `/projects/${project.id}`, update);
      logger.info("Updated component project", { project: cp.componentProject, fields: Object.keys(update) });
    }
  }
  await ensureMember(gl, "projects", project.id, cp.componentProject, botId, OWNER);

  const { import_status: status, import_error: error } = await gl.request("GET", `/projects/${project.id}/import`);
  // Re-read: default_branch is only known once the repository is imported.
  project = await gl.request("GET", `/projects/${project.id}`);
  if (!project.default_branch) {
    if (status === "failed") {
      throw new Error(`Import of ${cp.componentProject} from ${sourceLink(cp.cloneUrl)} failed: ${error}`);
    }
    logger.info("Component project import still running, finishing on the next run", { project: cp.componentProject, status });
    return null;
  }
  // A later mirror update failed: the last synced state is still usable.
  if (status === "failed") logger.warn("Last mirror update of the component project failed", { project: cp.componentProject, error });

  await ensureCatalogResource(gl, cp.componentProject);
  if (mirror) {
    try {
      await gl.request("POST", `/projects/${project.id}/mirror/pull`);
      logger.info("Started mirror update of the component project", { project: cp.componentProject });
    } catch (e) {
      // e.g. an update already running; GitLab also syncs mirrors on its own schedule.
      logger.warn("Could not start the mirror update", { project: cp.componentProject, error: e instanceof Error ? e.message : e });
    }
  }
  return project;
}

// Marks the project as a CI/CD Catalog resource (Settings > General > "CI/CD
// Catalog project"); needs the description set above.
async function ensureCatalogResource(gl: ReturnType<typeof gitlab>, path: string) {
  try {
    const data = await gl.graphql("query($p: ID!) { ciCatalogResource(fullPath: $p) { id } }", { p: path });
    if (data.ciCatalogResource) return;
  } catch {
    // Older GitLab without this query: let the mutation decide.
  }
  const data = await gl.graphql(
    "mutation($p: ID!) { catalogResourcesCreate(input: { projectPath: $p }) { errors } }",
    { p: path }
  );
  const errors: string[] = data.catalogResourcesCreate?.errors ?? [];
  if (errors.some((e) => /already/i.test(e))) return;
  if (errors.length) throw new Error(`Could not make ${path} a CI/CD Catalog resource: ${errors.join("; ")}`);
  logger.info("Enabled CI/CD Catalog resource", { project: path });
}

// File content on `ref`, null when it (or the whole repository) doesn't exist.
async function fileContent(gl: ReturnType<typeof gitlab>, projectId: number, file: string, ref: string): Promise<string | null> {
  try {
    const f = await gl.request(
      "GET",
      `/projects/${projectId}/repository/files/${encodeURIComponent(file)}?ref=${encodeURIComponent(ref)}`
    );
    return Buffer.from(f.content, "base64").toString("utf8");
  } catch (e) {
    if (e instanceof GitLabError && e.status === 404) return null;
    throw e;
  }
}

// Runner project with a .gitlab-ci.yml including the component (kept in sync)
// and a README (created once).
async function ensureRunnerProject(cfg: SetupConfig, gl: ReturnType<typeof gitlab>, botId: number, component: Json) {
  const cp = cfg.centralPipeline;
  const project =
    (await findProject(gl, cp.runnerProject)) ??
    (await createProject(gl, cp.runnerProject, {
      description: `Runs the AI agent for GitLab for every project, with the CI/CD component from ${cp.componentProject}. ${MANAGED_NOTE}.`,
      visibility: cp.visibility,
    }));
  await ensureMember(gl, "projects", project.id, cp.runnerProject, botId, OWNER);

  const ref = cp.ref || component.default_branch;
  if (!ref) throw new Error(`${cp.componentProject} has no default branch yet; set gitlabSetup.centralPipeline.component.ref`);

  // A new project has no branch yet; the first commit creates it.
  const branch = project.default_branch || "main";
  const files = [
    { path: ".gitlab-ci.yml", content: runnerCiConfig(cp.componentProject, ref, cp.inputs), managed: true },
    { path: "README.md", content: runnerReadme(cfg), managed: false },
  ];
  const actions: Json[] = [];
  for (const file of files) {
    const current = await fileContent(gl, project.id, file.path, branch);
    if (current === null) actions.push({ action: "create", file_path: file.path, content: file.content });
    else if (file.managed && current !== file.content) actions.push({ action: "update", file_path: file.path, content: file.content });
  }
  if (!actions.length) return;

  await gl.request("POST", `/projects/${project.id}/repository/commits`, {
    branch,
    commit_message: `Set up the AI agent runner (${actions.map((a) => a.file_path).join(", ")})`,
    actions,
  });
  logger.info("Updated runner project files", { project: cp.runnerProject, branch, files: actions.map((a) => a.file_path) });
}

async function ensureCentralPipeline(cfg: SetupConfig, gl: ReturnType<typeof gitlab>, botId: number) {
  const component = await ensureComponentProject(cfg, gl, botId);
  if (!component) return;
  await ensureRunnerProject(cfg, gl, botId, component);
  logger.info("Central pipeline in sync", {
    component: cfg.centralPipeline.componentProject,
    runner: cfg.centralPipeline.runnerProject,
  });
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
  // Last, so a failure here (e.g. a missing group) fails the Job only after
  // the token rotation is done.
  if (cfg.centralPipeline.enabled) await ensureCentralPipeline(cfg, gl, bot.id);
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
