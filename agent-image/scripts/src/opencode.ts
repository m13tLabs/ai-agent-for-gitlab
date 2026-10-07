import logger from "./logger.ts";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import type { Context } from "./types.ts";

export interface McpServerConfig {
  name: string;
  command: string[];
  env: Record<string, string | undefined>;
}

// A permission request opencode auto-rejected because `opencode run` has
// nobody to ask, e.g. reading a `.env` file.
export interface RejectedPermission {
  tool: string;
  target: string;
}

// Carries the rejected permissions along, since they may explain the failure.
export class OpencodeError extends Error {
  readonly rejectedPermissions: RejectedPermission[];

  constructor(message: string, rejectedPermissions: RejectedPermission[]) {
    super(message);
    this.rejectedPermissions = rejectedPermissions;
  }
}

const REJECTED_PERMISSION = /permission requested: (\S+) \((.*)\); auto-rejecting/;

// Returns the permissions opencode auto-rejected during the run.
export async function runOpencode(context: Context, prompt: string | undefined): Promise<RejectedPermission[]> {
  logger.start("Running opencode via cli...");

  setOpenCodeMCPServerConfiguration(mcpServerConfig(context));

  const model = context.opencodeModel ?? "";
  const [providerID, modelID] = model.split("/");
  if (!providerID || !modelID) {
    throw new Error(`Invalid OPENCODE_MODEL format: ${model}. Expected format: provider/model`);
  }

  logger.info(`Using model: ${modelID} from provider: ${providerID}`);

  logger.info("Sending prompt to model ... this may take a while");

  // Use the "opencode" CLI to send the prompt and get the response
  const cliArgs = ["run", "--print-logs", "--model", model, "--log-level", "ERROR"];

  logger.info(`Running: opencode ${cliArgs.join(" ")}`);

  const { code, signal, output, matches } = await runCli(
    "opencode",
    cliArgs,
    `${context.agentPrompt}\n${prompt}`,
    REJECTED_PERMISSION,
  );
  const rejected = parseRejectedPermissions(matches);
  if (rejected.length > 0) {
    logger.warn(`opencode auto-rejected ${rejected.length} permission request(s)`);
  }

  if (code !== 0) {
    const reason = parseOpencodeError(output) || (signal ? `killed by ${signal}` : `exit code ${code}`);
    logger.error(`opencode CLI failed: ${reason}`);
    throw new OpencodeError(`opencode CLI failed: ${reason}`, rejected);
  }

  logger.success("opencode CLI completed");
  return rejected;
}

// Deduplicated tool/target pairs from opencode's
//   ! permission requested: read (builds/g/p/repo/.env); auto-rejecting
// lines, with targets relative to the working directory where possible
// (opencode logs absolute paths without their leading slash).
export function parseRejectedPermissions(lines: string[], cwd = process.cwd()): RejectedPermission[] {
  const root = `${cwd.replace(/^\/+|\/+$/g, "")}/`;
  const seen = new Map<string, RejectedPermission>();
  for (const line of lines) {
    const match = stripAnsi(line).match(REJECTED_PERMISSION);
    if (!match) continue;
    const [, tool, raw] = match;
    const path = raw.replace(/^\/+/, "");
    const target = root !== "/" && path.startsWith(root) ? path.slice(root.length) : raw;
    seen.set(`${tool}\0${target}`, { tool, target });
  }
  return [...seen.values()];
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

// Only the tail is kept for error parsing; the job log still gets everything.
const MAX_CAPTURED_OUTPUT = 64 * 1024;

export interface CliResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
  // Every output line matching `watch`, however early it was printed.
  matches: string[];
}

// Runs the CLI with stdout/stderr passed through to the job log and also
// captured, so a failure can be reported with opencode's own error message.
export function runCli(command: string, args: string[], input: string, watch?: RegExp): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    const matches: string[] = [];
    const flushers: Array<() => void> = [];
    const capture = (target: NodeJS.WritableStream) => {
      // Per stream, so interleaved stdout/stderr chunks don't splice lines.
      let partial = "";
      const scan = (lines: string[]) => watch && matches.push(...lines.filter((l) => watch.test(l)));
      flushers.push(() => scan([partial]));
      return (chunk: Buffer) => {
        target.write(chunk);
        const text = chunk.toString();
        output = (output + text).slice(-MAX_CAPTURED_OUTPUT);
        const lines = (partial + text).split("\n");
        partial = lines.pop() ?? "";
        scan(lines);
      };
    };
    child.stdout.on("data", capture(process.stdout));
    child.stderr.on("data", capture(process.stderr));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      flushers.forEach((flush) => flush());
      resolve({ code, signal, output, matches });
    });
    // A CLI that exits before reading the prompt makes this write fail with
    // EPIPE; its exit code (via "close") is what gets reported then.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

// Extracts a readable reason from opencode's output, e.g.
//   Error: Forbidden: {"Message":"Authentication failed: ..."}
// becomes "Forbidden: Authentication failed: ...". Falls back to the error of
// the last `level=ERROR` log line. Returns "" when nothing matches.
export function parseOpencodeError(output: string): string {
  const lines = stripAnsi(output).split("\n").map((l) => l.trim());

  const errorLine = lines.filter((l) => l.startsWith("Error: ")).pop();
  if (errorLine) {
    const text = errorLine.slice("Error: ".length);
    const jsonStart = text.indexOf("{");
    if (jsonStart === -1) return text;
    const prefix = text.slice(0, jsonStart).replace(/[\s:]+$/, "");
    const detail = apiErrorMessage(text.slice(jsonStart));
    return detail ? [prefix, detail].filter(Boolean).join(": ") : text;
  }

  const logLine = lines.filter((l) => l.includes("level=ERROR")).pop();
  const match = logLine?.match(/\berror(?:\.error)?="([^"]+)"/) || logLine?.match(/\berror=(\S+)/);
  return match ? match[1] : "";
}

// Message field of a provider's JSON error body, whichever casing/nesting it uses.
function apiErrorMessage(json: string): string {
  try {
    const body = JSON.parse(json);
    const err = body.error ?? body;
    return typeof err === "string" ? err : err.message || err.Message || body.message || body.Message || "";
  } catch {
    return "";
  }
}

export function setOpenCodeMCPServerConfiguration(mcpServerConfig: McpServerConfig, home = homedir()): void {
  logger.info("Configuring OpenCode MCP server settings...");

  const configDir = join(home, ".config", "opencode");
  const configPath = join(configDir, "opencode.json");

  try {
    mkdirSync(configDir, { recursive: true });

    const config = {
      $schema: "https://opencode.ai/config.json",
      mcp: {
        [mcpServerConfig.name]: {
          type: "local",
          command: mcpServerConfig.command,
          environment: mcpServerConfig.env,
          enabled: true,
        },
      },
    };

    writeFileSync(configPath, JSON.stringify(config, null, 2));
    logger.info(`OpenCode configuration updated at ${configPath}`);
  } catch (error) {
    logger.error(`Failed to configure OpenCode MCP server: ${(error as Error).message}`);
    // Don't throw here - let the process continue even if config fails
  }
}

// opencode starts the GitLab MCP server itself (a `local` MCP entry), with
// this environment on top of its own.
export function mcpServerConfig(context: Context): McpServerConfig {
  return {
    name: "gitlab-mcp-server",
    command: [process.execPath, join(import.meta.dirname, "..", "mcp", "mcp.ts")],
    env: {
      CI_SERVER_URL: context.serverUrl,
      GITLAB_TOKEN: context.gitlabToken,
      CI_PROJECT_ID: context.projectId,
      AI_RESOURCE_ID: context.resourceId,
      AI_RESOURCE_TYPE: context.resourceType,
      AI_DISCUSSION_ID: context.discussionId,
      AI_GITLAB_USERNAME: context.username,
    },
  };
}
