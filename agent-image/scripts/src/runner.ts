import logger from "./logger.ts";
import { buildContext } from "./context.ts";
import { postComment } from "./gitlab.ts";
import { isInsideGitRepo, setupLocalRepository, ensureBranch, gitSetup } from "./git.ts";
import { validateProviderKeys, validateConfig } from "./config.ts";
import { OpencodeError, runOpencode, type RejectedPermission } from "./opencode.ts";
import { writeOutput } from "./output.ts";
import type { Context, Env } from "./types.ts";

export async function run(): Promise<void> {
  logger.info("AI GitLab Runner Started");

  const context = buildContext();

  logger.info(`Project: ${context.projectPath || "(unknown)"}`);
  logger.info(`Triggered by: @${context.author || "unknown"}`);
  logger.info(`Branch: ${context.branch}`);

  try {
    validateConfig(context);

    gitSetup(context);

    if (!isInsideGitRepo()) {
      setupLocalRepository(context);
    } else {
      // Ensure we're on the correct branch even if we're already in a git repo
      ensureBranch(context);
    }

    logger.info(`Prompt: ${context.prompt}`);

    const hasAnyProviderKey = validateProviderKeys();
    if (!hasAnyProviderKey) {
      logger.warn(
        "No provider API key detected in env. opencode may fail to start unless credentials are pre-configured via 'opencode auth login'.",
      );
    }

    logger.info(`Working directory: ${process.cwd()}`); // Should be /opt/agent/repo

    const rejected = await runOpencode(context, context.prompt);
    if (rejected.length > 0) {
      await postComment(context, permissionComment(rejected));
    }

    logger.info(`Working directory after opencode: ${process.cwd()}`);

    writeOutput(true, {
      prompt: context.prompt,
      branch: context.branch,
    });

    process.exit(0);
  } catch (error) {
    await handleError(context, error as Error);
  }
}

async function handleError(context: Context, error: Error): Promise<never> {
  logger.error(error.message);
  const rejected = error instanceof OpencodeError ? error.rejectedPermissions : [];
  const comment = errorComment(error.message);
  await postComment(context, rejected.length > 0 ? `${comment}\n\n${permissionComment(rejected)}` : comment);
  writeOutput(false, { error: error.message });
  process.exit(1);
}

export function errorComment(message: string, env: Env = process.env): string {
  return `❌ AI encountered an error:\n\n` + `\`\`\`\n${message}\n\`\`\`\n\n` + failedJobLink(env);
}

// opencode runs headless in CI, so every permission it would ask about is
// rejected; tell the commenter why the result may be incomplete.
export function permissionComment(rejected: RejectedPermission[]): string {
  const list = rejected.map((p) => `- \`${p.tool}\` on \`${p.target}\``).join("\n");
  return (
    `⚠️ The AI was denied access it asked for, so its result may be incomplete:\n\n${list}\n\n` +
    "The agent runs non-interactively, so any access opencode would ask about is rejected. " +
    "Secret files such as `.env` are blocked on purpose to keep them out of the model. " +
    "To allow other access, add a [`permission` rule](https://opencode.ai/docs/permissions/) " +
    "to the project's `opencode.json`."
  );
}

// Link to this job's log (GitLab's predefined CI variables). In runner mode it
// points into the runner project, which the commenter may not be able to open.
export function failedJobLink(env: Env = process.env): string {
  if (!env.CI_JOB_URL) return "Please check the pipeline logs for details.";
  const pipeline = env.CI_PIPELINE_URL
    ? ` of [pipeline #${env.CI_PIPELINE_IID || env.CI_PIPELINE_ID}](${env.CI_PIPELINE_URL})`
    : "";
  return `See the [failed job](${env.CI_JOB_URL})${pipeline} for details.`;
}
