import logger from "./logger.js";
import { buildContext } from "./context.js";
import { postComment } from "./gitlab.js";
import { isInsideGitRepo, setupLocalRepository, ensureBranch } from "./git.js";
import { validateProviderKeys, validateConfig } from "./config.js";
import { runOpencode } from "./opencode.js";
import { writeOutput } from "./output.js";
import { gitSetup } from "./git.js";

export async function run() {
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

    // await postComment(context, "🤖 Getting the vibes started...");

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
    await handleError(context, error);
  }
}

async function handleError(context, error) {
  logger.error(error.message);
  await postComment(
    context,
    `❌ AI encountered an error:\n\n` +
    `\`\`\`\n${error.message}\n\`\`\`\n\n` +
    failedJobLink(),
  );
  writeOutput(false, { error: error.message });
  process.exit(1);
}

// Link to this job's log (GitLab's predefined CI variables). In runner mode it
// points into the runner project, which the commenter may not be able to open.
export function failedJobLink(env = process.env) {
  if (!env.CI_JOB_URL) return "Please check the pipeline logs for details.";
  const pipeline = env.CI_PIPELINE_URL
    ? ` of [pipeline #${env.CI_PIPELINE_IID || env.CI_PIPELINE_ID}](${env.CI_PIPELINE_URL})`
    : "";
  return `See the [failed job](${env.CI_JOB_URL})${pipeline} for details.`;
}
