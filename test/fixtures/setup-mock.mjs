// GitLab + Kubernetes API mock for test/gitlab-setup.bats. Runs inside the
// gitlab-app image (mounted at /test), starts a node:http mock, runs
// /app/src/setup.ts against it and prints every write it received as
// "<METHOD> <path> <json body>", one per line, then "OK" or "FAILED: <error>".
//
// Instance layout:
//   groups   team-a (1), team-a/sub (2), team-b (3), gone (4, marked for deletion)
//   projects team-a/app (10, bot inherits Developer, has our hook),
//            team-a/sub/lib (11), team-b/tool (12), team-a/old (13, archived)
//   bot      review-agent (7); its stored token is valid, so no rotation
import http from "node:http";

const BOT_ID = 7;
const groups = [
  { id: 1, full_path: "team-a" },
  { id: 2, full_path: "team-a/sub" },
  { id: 3, full_path: "team-b" },
  { id: 4, full_path: "gone", marked_for_deletion_on: "2026-09-01" },
];
const projects = [
  { id: 10, path_with_namespace: "team-a/app" },
  { id: 11, path_with_namespace: "team-a/sub/lib" },
  { id: 12, path_with_namespace: "team-b/tool" },
  { id: 13, path_with_namespace: "team-a/old", archived: true },
];
const inherited = { 10: { id: BOT_ID, access_level: 30 } };
const projectHooks = { 10: [{ id: 99, name: "ai-agent-for-gitlab", url: "http://old" }] };

const writes = [];

function route(method, url) {
  const path = url.pathname;
  let m;
  if (path === "/api/v4/user") return [200, { username: "root", is_admin: true }];
  if (path === "/api/v4/users") return [200, [{ id: BOT_ID, username: "review-agent", name: "AI Agent", email: "" }]];
  if (path === "/api/v4/groups") return [200, groups];
  if (path === "/api/v4/projects") return [200, projects];
  if ((m = path.match(/^\/api\/v4\/groups\/([^/]+)$/))) {
    const g = groups.find((g) => g.full_path === decodeURIComponent(m[1]));
    return g ? [200, g] : [404, { message: "404 Group Not Found" }];
  }
  if ((m = path.match(/^\/api\/v4\/projects\/([^/]+)$/))) {
    const p = projects.find((p) => p.path_with_namespace === decodeURIComponent(m[1]));
    return p ? [200, p] : [404, { message: "404 Project Not Found" }];
  }
  if ((m = path.match(/^\/api\/v4\/projects\/(\d+)\/members\/all\/\d+$/))) {
    return inherited[m[1]] ? [200, inherited[m[1]]] : [404, {}];
  }
  if (method === "GET" && path.match(/^\/api\/v4\/(groups|projects)\/\d+\/members(\/all)?\/\d+$/)) return [404, {}];
  if (method === "GET" && (m = path.match(/^\/api\/v4\/projects\/(\d+)\/hooks$/))) return [200, projectHooks[m[1]] ?? []];
  if (method === "GET" && path === "/api/v4/hooks") return [200, []];
  if (path === "/api/v4/personal_access_tokens/self") {
    return [200, { id: 5, active: true, user_id: BOT_ID, expires_at: "2099-01-01" }];
  }
  if (method === "GET" && path.startsWith("/api/v1/namespaces/test/secrets/")) {
    return [200, { data: { GITLAB_TOKEN: Buffer.from("stored-bot-token").toString("base64") } }];
  }
  if (method !== "GET") return [201, { id: 1000 + writes.length }];
  return [404, { message: `unmocked ${method} ${path}` }];
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const url = new URL(req.url, "http://mock");
    if (req.method !== "GET") writes.push(`${req.method} ${url.pathname} ${body}`);
    const [status, payload] = route(req.method, url);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

Object.assign(process.env, {
  GITLAB_URL: base,
  GITLAB_ADMIN_TOKEN: "admin-token",
  AI_GITLAB_USERNAME: "review-agent",
  BOT_NAME: "AI Agent",
  SYSTEM_HOOK_URL: "http://ai-agent/webhook",
  WEBHOOK_SECRET: "hook-secret",
  BOT_TOKEN_SECRET: "bot-token",
  K8S_API_URL: base,
  K8S_NAMESPACE: "test",
  K8S_TOKEN: "k8s-token",
  LOG_LEVEL: "error",
});

const { loadConfig, runSetup } = await import("/app/src/setup.ts");
let result = "OK";
try {
  await runSetup(await loadConfig());
} catch (e) {
  result = `FAILED: ${e instanceof Error ? e.message : e}`;
}
server.close();
console.log([...writes, result].join("\n"));
