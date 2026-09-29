import logger from "./logger.ts";
import { buildContext } from "./context.ts";
import { postComment } from "./gitlab.ts";
import { isInsideGitRepo, setupLocalRepository, ensureBranch, gitSetup } from "./git.ts";
import { validateProviderKeys, validateConfig } from "./config.ts";
import { runOpencode } from "./opencode.ts";
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

    await runOpencode(context, context.prompt);

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
  await postComment(context, errorComment(error.message));
  writeOutput(false, { error: error.message });
  process.exit(1);
}

export function errorComment(message: string, env: Env = process.env): string {
  return `❌ AI encountered an error:\n\n` + `\`\`\`\n${message}\n\`\`\`\n\n` + failedJobLink(env);
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
