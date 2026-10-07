import type { Context, Env } from "./types.ts";

export function buildContext(env: Env = process.env): Context {
  // Combine prompts: webhook (OPENCODE_AGENT_PROMPT) + pipeline (CUSTOM_AGENT_PROMPT)
  const webhookAppPrompt = env.OPENCODE_AGENT_PROMPT || "";
  const pipelinePrompt = env.CUSTOM_AGENT_PROMPT || "";
  let combinedPrompt = "";
  if (webhookAppPrompt && pipelinePrompt) {
    combinedPrompt = `${webhookAppPrompt.trim()}\n\n---\n# Pipeline Additions\n${pipelinePrompt.trim()}`;
  } else {
    combinedPrompt = webhookAppPrompt || pipelinePrompt || "";
  }

  return {
    projectPath: env.AI_PROJECT_PATH,
    author: env.AI_AUTHOR,
    resourceType: env.AI_RESOURCE_TYPE,
    resourceId: env.AI_RESOURCE_ID,
    discussionId: env.AI_DISCUSSION_ID,
    prompt: env.DIRECT_PROMPT,
    review: env.AI_REVIEW === "true",
    triggerPhrase: env.TRIGGER_PHRASE || "@ai",
    branch: env.AI_BRANCH,
    email: env.AI_GITLAB_EMAIL,
    username: env.AI_GITLAB_USERNAME,
    opencodeModel: env.OPENCODE_MODEL,
    agentPrompt: combinedPrompt,
    // GITLAB_AI_AGENT_TOKEN: the bot token gitlabSetup maintains on the runner
    // project; GITLAB_TOKEN: a hand-made CI/CD variable (per-project mode).
    gitlabToken: env.GITLAB_AI_AGENT_TOKEN || env.GITLAB_TOKEN,
    host: env.CI_SERVER_HOST || "gitlab.com",
    // AI_PROJECT_ID is the target project, also when the pipeline runs in a
    // central runner project; CI_PROJECT_ID covers pipelines from older webhooks.
    projectId: env.AI_PROJECT_ID || env.CI_PROJECT_ID,
    serverUrl: env.CI_SERVER_URL || "https://gitlab.com",
    checkoutDir: "./repo",
  };
}
