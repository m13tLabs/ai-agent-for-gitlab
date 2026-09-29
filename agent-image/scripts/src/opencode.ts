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

export async function runOpencode(context: Context, prompt: string | undefined): Promise<void> {
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

  const { code, signal, output } = await runCli("opencode", cliArgs, `${context.agentPrompt}\n${prompt}`);

  if (code !== 0) {
    const reason = parseOpencodeError(output) || (signal ? `killed by ${signal}` : `exit code ${code}`);
    logger.error(`opencode CLI failed: ${reason}`);
    throw new Error(`opencode CLI failed: ${reason}`);
  }

  logger.success("opencode CLI completed");
}

// Only the tail is kept for error parsing; the job log still gets everything.
const MAX_CAPTURED_OUTPUT = 64 * 1024;

export interface CliResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  output: string;
}

// Runs the CLI with stdout/stderr passed through to the job log and also
// captured, so a failure can be reported with opencode's own error message.
export function runCli(command: string, args: string[], input: string): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    const capture = (target: NodeJS.WritableStream) => (chunk: Buffer) => {
      target.write(chunk);
      output = (output + chunk.toString()).slice(-MAX_CAPTURED_OUTPUT);
    };
    child.stdout.on("data", capture(process.stdout));
    child.stderr.on("data", capture(process.stderr));
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, output }));
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
  const lines = output.replace(/\x1b\[[0-9;]*m/g, "").split("\n").map((l) => l.trim());

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
    },
  };
}
