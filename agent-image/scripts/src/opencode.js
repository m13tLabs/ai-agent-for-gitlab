import logger from "./logger.js";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";

export async function runOpencode(context, prompt) {
  logger.start("Running opencode via cli...");

  const configuration = startMCPServer(context);
  setOpenCodeMCPServerConfiguration(configuration);

  const [providerID, modelID] = context.opencodeModel.split('/');
  if (!providerID || !modelID) {
    throw new Error(`Invalid OPENCODE_MODEL format: ${context.opencodeModel}. Expected format: provider/model`);
  }

  logger.info(`Using model: ${modelID} from provider: ${providerID}`);

  logger.info("Sending prompt to model ... this may take a while");

  // Use the "opencode" CLI to send the prompt and get the response
  const cliArgs = [
    "run",
    "--print-logs",
    "--model", 
    context.opencodeModel,
    "--log-level",
    "ERROR"
  ];

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

// Runs the CLI with stdout/stderr passed through to the job log and also
// captured, so a failure can be reported with opencode's own error message.
function runCli(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    const capture = (target) => (chunk) => {
      target.write(chunk);
      output = (output + chunk.toString()).slice(-MAX_CAPTURED_OUTPUT);
    };
    child.stdout.on("data", capture(process.stdout));
    child.stderr.on("data", capture(process.stderr));
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, output }));
    child.stdin.end(input);
  });
}

// Extracts a readable reason from opencode's output, e.g.
//   Error: Forbidden: {"Message":"Authentication failed: ..."}
// becomes "Forbidden: Authentication failed: ...". Falls back to the error of
// the last `level=ERROR` log line. Returns "" when nothing matches.
export function parseOpencodeError(output) {
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
function apiErrorMessage(json) {
  try {
    const body = JSON.parse(json);
    const err = body.error ?? body;
    return typeof err === "string" ? err : err.message || err.Message || body.message || body.Message || "";
  } catch {
    return "";
  }
}

function setOpenCodeMCPServerConfiguration(mcpServerConfig) {
  logger.info("Configuring OpenCode MCP server settings...");

  const configDir = join(homedir(), ".config", "opencode");
  const configPath = join(configDir, "opencode.json");

  try {
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }

    let config = { "$schema": "https://opencode.ai/config.json", mcp: {} };

    config.mcp[mcpServerConfig.name] = {
      type: "local",
      command: mcpServerConfig.command,
      environment: mcpServerConfig.env,
      enabled: true
    };

    writeFileSync(configPath, JSON.stringify(config, null, 2));
    logger.info(`OpenCode configuration updated at ${configPath}`);

  } catch (error) {
    logger.error(`Failed to configure OpenCode MCP server: ${error.message}`);
    // Don't throw here - let the process continue even if config fails
  }
}

function startMCPServer(context) {
  logger.info("Starting GitLab MCP server...");

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const mcpServerPath = join(__dirname, "..", "mcp", "mcp.ts");

  // Set environment variables for the MCP server
  const env = {
    ...process.env,
    CI_SERVER_URL: context.serverUrl,
    GITLAB_TOKEN: context.gitlabToken,
    CI_PROJECT_ID: context.projectId,
  };

  try {
    // Start the MCP server process
    const mcpProcess = spawn("npx", ["tsx", mcpServerPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      cwd: join(__dirname, "..")
    });

    mcpProcess.on("error", (error) => {
      logger.error(`MCP server error: ${error.message}`);
    });

    mcpProcess.stderr.on("data", (data) => {
      logger.info(`MCP server: ${data.toString().trim()}`);
    });

    logger.info("GitLab MCP server started");

    // Return configuration for opencode
    return {
      name: "gitlab-mcp-server",
      command: ["npx", "tsx", mcpServerPath],
      env: {
        CI_SERVER_URL: context.serverUrl,
        GITLAB_TOKEN: context.gitlabToken,
        CI_PROJECT_ID: context.projectId,
        AI_RESOURCE_ID: context.resourceId,
        AI_RESOURCE_TYPE: context.resourceType,
      }
    };
  } catch (error) {
    logger.error(`Failed to start MCP server: ${error.message}`);
    throw error;
  }
}