import { before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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

  it("writes opencode.json with the MCP server entry", () => {
    const home = tempDir();
    setOpenCodeMCPServerConfiguration({ name: "srv", command: ["node", "x.ts"], env: { A: "1" } }, home);
    const config = JSON.parse(readFileSync(join(home, ".config", "opencode", "opencode.json"), "utf8"));
    assert.deepEqual(config, {
      $schema: "https://opencode.ai/config.json",
      mcp: { srv: { type: "local", command: ["node", "x.ts"], environment: { A: "1" }, enabled: true } },
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

// Replaces `opencode` on PATH with a script that records its arguments and
// stdin, prints $FAKE_OUTPUT to stderr and exits with $FAKE_EXIT.
describe("runOpencode", () => {
  let dir: string;
  const ctx = () =>
    buildContext({
      OPENCODE_MODEL: "anthropic/claude",
      OPENCODE_AGENT_PROMPT: "system",
      CI_SERVER_URL: "https://gl",
      GITLAB_TOKEN: "t",
      AI_PROJECT_ID: "42",
    });

  before(() => {
    dir = tempDir();
    writeFileSync(
      join(dir, "opencode"),
      [
        "#!/bin/sh",
        `printf '%s\\n' "$@" > "${dir}/args"`,
        `cat > "${dir}/stdin"`,
        `[ -n "$FAKE_OUTPUT" ] && printf '%s\\n' "$FAKE_OUTPUT" >&2`,
        'exit "${FAKE_EXIT:-0}"',
      ].join("\n"),
    );
    chmodSync(join(dir, "opencode"), 0o755);
    process.env.PATH = `${dir}:${process.env.PATH}`;
    process.env.HOME = dir;
  });

  beforeEach(() => {
    silenceConsole();
    delete process.env.FAKE_EXIT;
    delete process.env.FAKE_OUTPUT;
  });

  it("runs opencode with the model, agent prompt and user prompt", async () => {
    await runOpencode(ctx(), "@ai do it");
    assert.deepEqual(readFileSync(join(dir, "args"), "utf8").trim().split("\n"), [
      "run",
      "--print-logs",
      "--model",
      "anthropic/claude",
      "--log-level",
      "ERROR",
    ]);
    assert.equal(readFileSync(join(dir, "stdin"), "utf8"), "system\n@ai do it");
  });

  it("configures the GitLab MCP server first", async () => {
    await runOpencode(ctx(), "x");
    const config = JSON.parse(readFileSync(join(dir, ".config", "opencode", "opencode.json"), "utf8"));
    assert.equal(config.mcp["gitlab-mcp-server"].environment.CI_PROJECT_ID, "42");
  });

  it("returns the auto-rejected permissions", async () => {
    process.env.FAKE_OUTPUT = `! permission requested: read (${process.cwd().slice(1)}/.env); auto-rejecting`;
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
