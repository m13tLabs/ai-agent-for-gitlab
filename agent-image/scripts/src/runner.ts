import logger from "./logger.ts";
import { buildContext } from "./context.ts";
import { postComment } from "./gitlab.ts";
import { isInsideGitRepo, setupLocalRepository, ensureBranch, gitSetup } from "./git.ts";
import { validateProviderKeys, validateConfig } from "./config.ts";
import { OpencodeError, runOpencode, type RejectedPermission } from "./opencode.ts";
import { writeOutput } from "./output.ts";
import { fetchDiscussions, previousFindingsSection, summarizeDiscussions } from "./discussions.ts";
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

    const history = await previousFindings(context);
    const prompt = history ? `${history}\n\n=== Current Request ===\n${context.prompt ?? ""}` : context.prompt;

    const rejected = await runOpencode(context, prompt);
    if (rejected.length > 0) {
      await postComment(context, permissionComment(rejected));
    }
    if (context.review) {
      await postComment(context, reviewRetriggerComment(context.triggerPhrase));
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

// Starts of the notes this runner posts itself; they carry no findings.
const RUNNER_NOTES = ["🔁 To review this merge request again", "❌ AI encountered an error", "⚠️ The AI was denied access"];

// The AI user's earlier comments on the MR/issue, so a later run doesn't post
// the same findings again. Non-critical: without it the run just starts fresh.
// The triggering thread itself is left out, the webhook already puts it into
// the prompt.
export async function previousFindings(context: Context): Promise<string> {
  if (!context.username) {
    logger.warn("AI_GITLAB_USERNAME not set, cannot tell the agent's earlier comments apart");
    return "";
  }
  try {
    const summaries = summarizeDiscussions(await fetchDiscussions(context, context)).filter(
      (s) => s.id !== context.discussionId && !RUNNER_NOTES.some((p) => s.notes[0].body.startsWith(p)),
    );
    const isIssue = (context.resourceType || "").toLowerCase() === "issue";
    const section = previousFindingsSection(summaries, context.username, {
      resource: isIssue ? "issue" : "merge request",
    });
    if (section) logger.info("Passing the agent's previous comments on to opencode");
    return section;
  } catch (error) {
    logger.warn(`Could not load previous discussions: ${(error as Error).message}`);
    return "";
  }
}

export function reviewRetriggerComment(triggerPhrase: string): string {
  return (
    `🔁 To review this merge request again, e.g. after pushing fixes, comment \`${triggerPhrase} review\`. ` +
    `Anything after it is passed on as extra instructions, e.g. \`${triggerPhrase} review focus on error handling\`. ` +
    "Findings from earlier reviews are taken into account, so only new or still open issues are reported."
  );
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
