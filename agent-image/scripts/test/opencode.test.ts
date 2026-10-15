import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  mcpServerConfig,
  OpencodeError,
  parseOpencodeError,
  parseRejectedPermissions,
  runCli,
  runOpencode,
  setOpenCodeMCPServerConfiguration,
} from "../src/opencode.ts";
import { buildContext } from "../src/context.ts";
import { silenceConsole, tempDir } from "./helpers.ts";

describe("parseOpencodeError", () => {
  it("reduces a provider JSON error to prefix and message", () => {
    // Tail of a real Bedrock failure (stderr of `opencode run --print-logs`).
    const log = [
      'timestamp=2026-09-29T05:19:44.994Z level=ERROR message="stream error" providerID=amazon-bedrock error.error="AI_APICallError: Forbidden"',
      'Error: Forbidden: {"Message":"Authentication failed: Please make sure your API Key is valid."}',
    ].join("\n");
    assert.equal(parseOpencodeError(log), "Forbidden: Authentication failed: Please make sure your API Key is valid.");
  });

  it("reads nested error objects and plain error strings", () => {
    assert.equal(parseOpencodeError('Error: {"error":{"type":"x","message":"model not found"}}'), "model not found");
    assert.equal(parseOpencodeError('Error: Bad Request: {"error":"quota exceeded"}'), "Bad Request: quota exceeded");
  });

  it("keeps the whole line when the JSON has no message or doesn't parse", () => {
    assert.equal(parseOpencodeError('Error: Oops {"code":1}'), 'Oops {"code":1}');
    assert.equal(parseOpencodeError("Error: Oops {not json"), "Oops {not json");
  });

  it("returns a plain error line as is", () => {
    assert.equal(parseOpencodeError("Error: Model not found: azure/x"), "Model not found: azure/x");
  });

  it("uses the last error line", () => {
    assert.equal(parseOpencodeError("Error: first\nsomething\nError: second"), "second");
  });

  it("strips ANSI colors", () => {
    assert.equal(parseOpencodeError("\x1b[91m\x1b[1mError: \x1b[0mrate limited"), "rate limited");
  });

  it("falls back to the last level=ERROR log line", () => {
    assert.equal(
      parseOpencodeError('level=ERROR message=x error.error="AI_APICallError: Too Many Requests"'),
      "AI_APICallError: Too Many Requests",
    );
    assert.equal(parseOpencodeError("level=ERROR message=x error=ECONNRESET"), "ECONNRESET");
  });

  it("returns an empty string when nothing matches", () => {
    assert.equal(parseOpencodeError("all good"), "");
    assert.equal(parseOpencodeError(""), "");
  });
});

describe("mcpServerConfig", () => {
  it("runs mcp.ts with this node and passes the GitLab target", () => {
    const ctx = buildContext({
      CI_SERVER_URL: "https://gl",
      GITLAB_TOKEN: "t",
      AI_PROJECT_ID: "42",
      AI_RESOURCE_ID: "7",
      AI_RESOURCE_TYPE: "merge_request",
      AI_DISCUSSION_ID: "d1",
      AI_GITLAB_USERNAME: "bot",
    });
    const config = mcpServerConfig(ctx);
    assert.equal(config.name, "gitlab-mcp-server");
    assert.equal(config.command[0], process.execPath);
    assert.ok(existsSync(config.command[1]), `${config.command[1]} exists`);
    assert.match(config.command[1], /mcp[/\\]mcp\.ts$/);
    assert.deepEqual(config.env, {
      CI_SERVER_URL: "https://gl",
      GITLAB_TOKEN: "t",
      CI_PROJECT_ID: "42",
      AI_RESOURCE_ID: "7",
      AI_RESOURCE_TYPE: "merge_request",
      AI_DISCUSSION_ID: "d1",
      AI_GITLAB_USERNAME: "bot",
    });
  });
});

describe("setOpenCodeMCPServerConfiguration", () => {
  beforeEach(silenceConsole);

  it("writes opencode.json with the MCP server entry, its tools offered directly", () => {
    const home = tempDir();
    setOpenCodeMCPServerConfiguration({ name: "srv", command: ["node", "x.ts"], env: { A: "1" } }, home);
    const config = JSON.parse(readFileSync(join(home, ".config", "opencode", "opencode.json"), "utf8"));
    assert.deepEqual(config, {
      $schema: "https://opencode.ai/config.json",
      mcp: {
        servers: { srv: { type: "local", command: ["node", "x.ts"], environment: { A: "1" }, codemode: false } },
      },
    });
  });

  it("doesn't throw when the config can't be written", () => {
    const file = join(tempDir(), "not-a-dir");
    writeFileSync(file, "");
    assert.doesNotThrow(() => setOpenCodeMCPServerConfiguration({ name: "srv", command: [], env: {} }, file));
  });
});

describe("parseRejectedPermissions", () => {
  const cwd = "/builds/g/p/repo";

  it("keeps the relative targets opencode 2 logs", () => {
    const log = ["! permission requested: read (themes/.env); auto-rejecting", "✗ Read themes/.env failed"];
    assert.deepEqual(parseRejectedPermissions(log, cwd), [{ tool: "read", target: "themes/.env" }]);
  });

  it("reports targets relative to the working directory", () => {
    const log = [
      "→ Read test/playwright/README.md",
      "! permission requested: read (builds/g/p/repo/themes/.env); auto-rejecting",
      "✗ Read themes/.env failed",
    ];
    assert.deepEqual(parseRejectedPermissions(log, cwd), [{ tool: "read", target: "themes/.env" }]);
  });

  it("keeps targets outside the working directory as logged", () => {
    assert.deepEqual(
      parseRejectedPermissions(["! permission requested: external_directory (/etc/passwd); auto-rejecting"], cwd),
      [{ tool: "external_directory", target: "/etc/passwd" }],
    );
  });

  it("deduplicates and strips colors", () => {
    const line = "\x1b[33m! permission requested: read (builds/g/p/repo/.env); auto-rejecting\x1b[0m";
    assert.deepEqual(parseRejectedPermissions([line, line], cwd), [{ tool: "read", target: ".env" }]);
  });

  it("returns nothing without rejections", () => {
    assert.deepEqual(parseRejectedPermissions(["all good"], cwd), []);
  });
});

describe("runCli", () => {
  it("feeds stdin and captures stdout and stderr", async () => {
    const res = await runCli("sh", ["-c", "cat; echo err >&2"], "in");
    assert.equal(res.code, 0);
    assert.equal(res.signal, null);
    assert.match(res.output, /in/);
    assert.match(res.output, /err/);
  });

  it("reports the exit code", async () => {
    assert.equal((await runCli("sh", ["-c", "exit 3"], "")).code, 3);
  });

  it("collects watched lines beyond the captured tail, including an unterminated last line", async () => {
    const script = "echo 'hit 1'; head -c 200000 /dev/zero | tr '\\0' x; echo; printf 'hit 2' >&2";
    const res = await runCli("sh", ["-c", script], "", /^hit/);
    assert.deepEqual(res.matches, ["hit 1", "hit 2"]);
    assert.doesNotMatch(res.output, /hit 1/);
  });

  it("rejects when the command doesn't exist", async () => {
    await assert.rejects(runCli("definitely-not-a-command", [], ""), { code: "ENOENT" });
  });
});

// Replaces `opencode` on PATH with a script. As `serve` it records its
// arguments, password and pid and announces the MCP status mock as its URL;
// as `run` it records its arguments, password and stdin, prints $FAKE_OUTPUT
// to stderr and exits with $FAKE_EXIT.
describe("runOpencode", () => {
  let dir: string;
  let mock: Server;
  let statuses: object[];
  let requests: { url: string; headers: IncomingHttpHeaders }[];
  const ctx = () =>
    buildContext({
      OPENCODE_MODEL: "anthropic/claude",
      OPENCODE_AGENT_PROMPT: "system",
      CI_SERVER_URL: "https://gl",
      GITLAB_TOKEN: "t",
      AI_PROJECT_ID: "42",
    });
  const read = (name: string) => readFileSync(join(dir, name), "utf8").trim();
  const isRunning = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  before(async () => {
    dir = tempDir();
    mock = createServer((req, res) => {
      requests.push({ url: req.url ?? "", headers: req.headers });
      const status = statuses.length > 1 ? statuses.shift() : statuses[0];
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: status ? [{ name: "gitlab-mcp-server", status }] : [] }));
    });
    await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
    writeFileSync(
      join(dir, "opencode"),
      [
        "#!/bin/sh",
        'if [ "$1" = serve ]; then',
        `  printf '%s\\n' "$@" > "${dir}/serve-args"`,
        `  echo "$OPENCODE_SERVER_PASSWORD" > "${dir}/serve-password"`,
        `  echo $$ > "${dir}/serve-pid"`,
        `  echo "server listening on ${url}"`,
        "  exec sleep 30",
        "fi",
        `printf '%s\\n' "$@" > "${dir}/args"`,
        `echo "$OPENCODE_PASSWORD" > "${dir}/run-password"`,
        `cat > "${dir}/stdin"`,
        `[ -n "$FAKE_OUTPUT" ] && printf '%s\\n' "$FAKE_OUTPUT" >&2`,
        'exit "${FAKE_EXIT:-0}"',
      ].join("\n"),
    );
    chmodSync(join(dir, "opencode"), 0o755);
    process.env.PATH = `${dir}:${process.env.PATH}`;
    process.env.HOME = dir;
  });

  after(() => mock.close());

  beforeEach(() => {
    silenceConsole();
    delete process.env.FAKE_EXIT;
    delete process.env.FAKE_OUTPUT;
    statuses = [{ status: "pending" }, { status: "connected" }];
    requests = [];
    writeFileSync(join(dir, "args"), "");
  });

  it("runs the prompt against its own server once the MCP server is connected", async () => {
    await runOpencode(ctx(), "@ai do it");
    const url = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
    assert.deepEqual(read("serve-args").split("\n"), [
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      "0",
      "--print-logs",
      "--log-level",
      "warn",
    ]);
    assert.deepEqual(read("args").split("\n"), [
      "run",
      "--server",
      url,
      "--print-logs",
      "--log-level",
      "error",
      "--model",
      "anthropic/claude",
    ]);
    assert.equal(read("stdin"), "system\n@ai do it");

    const password = read("serve-password");
    assert.ok(password.length >= 32, "a generated password");
    assert.equal(read("run-password"), password);
    assert.equal(requests.length, 2, "polled until connected");
    assert.equal(requests[0].url, `/api/mcp?directory=${encodeURIComponent(process.cwd())}`);
    assert.equal(requests[0].headers.authorization, `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`);
  });

  it("stops its server afterwards", async () => {
    await runOpencode(ctx(), "x");
    assert.equal(isRunning(Number(read("serve-pid"))), false);
  });

  it("fails without running the prompt when the MCP server doesn't start", async () => {
    statuses = [{ status: "pending" }, { status: "failed", error: "exited with code 1" }];
    await assert.rejects(runOpencode(ctx(), "x"), {
      message: "MCP server gitlab-mcp-server didn't start: exited with code 1",
    });
    assert.equal(read("args"), "");
    assert.equal(isRunning(Number(read("serve-pid"))), false);
  });

  it("configures the GitLab MCP server first", async () => {
    await runOpencode(ctx(), "x");
    const config = JSON.parse(readFileSync(join(dir, ".config", "opencode", "opencode.json"), "utf8"));
    assert.equal(config.mcp.servers["gitlab-mcp-server"].environment.CI_PROJECT_ID, "42");
  });

  it("returns the auto-rejected permissions", async () => {
    process.env.FAKE_OUTPUT = "! permission requested: read (.env); auto-rejecting";
    assert.deepEqual(await runOpencode(ctx(), "x"), [{ tool: "read", target: ".env" }]);
  });

  it("attaches the auto-rejected permissions to a failure", async () => {
    process.env.FAKE_EXIT = "1";
    process.env.FAKE_OUTPUT = "! permission requested: read (/x/.env); auto-rejecting";
    await assert.rejects(runOpencode(ctx(), "x"), (error: unknown) => {
      assert.ok(error instanceof OpencodeError);
      assert.deepEqual(error.rejectedPermissions, [{ tool: "read", target: "/x/.env" }]);
      return true;
    });
  });

  it("fails with opencode's own error message", async () => {
    process.env.FAKE_EXIT = "1";
    process.env.FAKE_OUTPUT = 'Error: Forbidden: {"message":"bad key"}';
    await assert.rejects(runOpencode(ctx(), "x"), { message: "opencode CLI failed: Forbidden: bad key" });
  });

  it("falls back to the exit code", async () => {
    process.env.FAKE_EXIT = "2";
    await assert.rejects(runOpencode(ctx(), "x"), { message: "opencode CLI failed: exit code 2" });
  });

  it("rejects a model without provider prefix", async () => {
    await assert.rejects(runOpencode({ ...ctx(), opencodeModel: "claude" }, "x"), /Invalid OPENCODE_MODEL format/);
  });
});
