// GitLab setup for the AI agent, run by the Helm chart's setup Job/CronJob
// (`node src/setup.ts`) when `gitlabSetup.enabled` is true. Needs an admin
// token; it never runs inside the internet-facing webhook pod.
//
// Every step is idempotent, so the CronJob can re-run it to pick up new
// top-level groups and rotate the bot token before it expires:
//   1. bot account: create (service account, or plain user as a fallback),
//      keep name/email in sync, upload the avatar when it changed
//   2. Developer (configurable) on every top-level group, or on `SETUP_GROUPS`
//   3. system hook for merge request events -> the webhook Service
//   4. bot personal access token, stored in a Kubernetes Secret the webhook
//      Deployment reads as GITLAB_TOKEN; rotated before expiry, after which the
//      Deployment is restarted to pick the new token up

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { logger } from "./logger.ts";

const HOOK_NAME = "ai-agent-for-gitlab";
const TOKEN_NAME = "ai-agent-for-gitlab";
const AVATAR_ATTRIBUTE = "ai_agent_for_gitlab_avatar_sha256";
const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

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
  // Full paths of the groups to join; empty = every top-level group.
  groups: string[];
  hook: { enabled: boolean; url: string; token: string; sslVerification: boolean };
  token: {
    expiryDays: number;
    renewBeforeDays: number;
    secretName: string;
    secretKey: string;
    // Deployment restarted after a rotation so pods load the new token.
    deployment: string;
  };
  kube: { apiUrl: string; namespace: string; token: string };
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

  return {
    gitlabUrl: (env.GITLAB_URL || "https://gitlab.com").replace(/\/+$/, ""),
    adminToken: requireEnv("GITLAB_ADMIN_TOKEN"),
    bot: {
      username: requireEnv("AI_GITLAB_USERNAME"),
      name: env.BOT_NAME || "AI Agent",
      email: env.AI_GITLAB_EMAIL || "",
      accountType,
      avatarPath: env.BOT_AVATAR_PATH || "",
      accessLevel: Number(env.BOT_ACCESS_LEVEL || 30),
    },
    groups: (env.SETUP_GROUPS || "")
      .split(",")
      .map((g) => g.trim())
      .filter(Boolean),
    hook: {
      enabled: hookEnabled,
      url: hookEnabled ? requireEnv("SYSTEM_HOOK_URL") : "",
      token: hookEnabled ? requireEnv("WEBHOOK_SECRET") : "",
      sslVerification: env.SYSTEM_HOOK_SSL_VERIFICATION !== "false",
    },
    token: {
      expiryDays: Number(env.BOT_TOKEN_EXPIRY_DAYS || 90),
      renewBeforeDays: Number(env.BOT_TOKEN_RENEW_BEFORE_DAYS || 14),
      secretName: requireEnv("BOT_TOKEN_SECRET"),
      secretKey: env.BOT_TOKEN_SECRET_KEY || "GITLAB_TOKEN",
      deployment: env.RESTART_DEPLOYMENT || "",
    },
    kube: {
      apiUrl:
        env.K8S_API_URL ||
        `https://${requireEnv("KUBERNETES_SERVICE_HOST")}:${env.KUBERNETES_SERVICE_PORT || "443"}`,
      namespace: env.K8S_NAMESPACE || (await readIfExists(`${SA_DIR}/namespace`)),
      token: env.K8S_TOKEN || (await readIfExists(`${SA_DIR}/token`)),
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

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
    const res = await fetch(`${cfg.gitlabUrl}/api/v4${path}`, { method, headers, body: payload });
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
      const res = await fetch(`${cfg.gitlabUrl}/api/v4${path}${sep}per_page=100&page=${page}`, {
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
    const res = await fetch(`${cfg.kube.apiUrl}${path}`, {
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
      await gl.request("PUT", `/users/${user.id}`, {
        name: bot.name,
        ...(wantEmail ? { email: wantEmail, skip_reconfirmation: true } : {}),
      });
      logger.info("Updated bot account", { username: bot.username, id: user.id });
    }
  }

  if (bot.avatarPath) await ensureAvatar(gl, user.id, bot.avatarPath);
  return user;
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

async function ensureMemberships(cfg: SetupConfig, gl: ReturnType<typeof gitlab>, userId: number) {
  let groups: Json[];
  if (cfg.groups.length) {
    groups = await Promise.all(
      cfg.groups.map((path) => gl.request("GET", `/groups/${encodeURIComponent(path)}`))
    );
  } else {
    groups = await gl.list("/groups?top_level_only=true&all_available=true");
  }
  // Skip groups pending deletion.
  groups = groups.filter((g) => !g.marked_for_deletion_on);

  let added = 0;
  for (const group of groups) {
    let member: Json | null = null;
    try {
      member = await gl.request("GET", `/groups/${group.id}/members/${userId}`);
    } catch (e) {
      if (!(e instanceof GitLabError && e.status === 404)) throw e;
    }

    if (!member) {
      await gl.request("POST", `/groups/${group.id}/members`, {
        user_id: userId,
        access_level: cfg.bot.accessLevel,
      });
      added++;
      logger.info("Added bot to group", { group: group.full_path, accessLevel: cfg.bot.accessLevel });
    } else if (member.access_level < cfg.bot.accessLevel) {
      // Raise, never lower: an admin may have granted more on purpose.
      await gl.request("PUT", `/groups/${group.id}/members/${userId}`, {
        access_level: cfg.bot.accessLevel,
      });
      logger.info("Raised bot access level", { group: group.full_path, accessLevel: cfg.bot.accessLevel });
    }
  }
  logger.info("Group memberships in sync", { groups: groups.length, added });
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

async function ensureBotToken(cfg: SetupConfig, gl: ReturnType<typeof gitlab>, userId: number) {
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
        return;
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

  await restartDeployment(cfg, k8s);
}

async function restartDeployment(cfg: SetupConfig, k8s: ReturnType<typeof kube>) {
  if (!cfg.token.deployment) return;
  const res = await k8s(
    "PATCH",
    `/apis/apps/v1/namespaces/${cfg.kube.namespace}/deployments/${cfg.token.deployment}`,
    {
      spec: {
        template: {
          metadata: { annotations: { "ai-agent-for-gitlab/token-rotated-at": new Date().toISOString() } },
        },
      },
    },
    "application/strategic-merge-patch+json"
  );
  if (res.status === 404) {
    logger.info("Deployment not found yet, nothing to restart", { deployment: cfg.token.deployment });
  } else if (res.status >= 300) {
    logger.warn("Could not restart deployment after token rotation", { status: res.status });
  } else {
    logger.info("Restarted deployment to load the new token", { deployment: cfg.token.deployment });
  }
}

export async function runSetup(cfg: SetupConfig) {
  const gl = gitlab(cfg);

  const me = await gl.request("GET", "/user");
  if (!me.is_admin) throw new Error(`GITLAB_ADMIN_TOKEN belongs to ${me.username}, who is not an administrator`);

  const bot = await ensureBot(cfg, gl);
  await ensureMemberships(cfg, gl, bot.id);
  if (cfg.hook.enabled) await ensureSystemHook(cfg, gl);
  await ensureBotToken(cfg, gl, bot.id);
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
