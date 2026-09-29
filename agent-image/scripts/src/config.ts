import type { Context, Env } from "./types.ts";

const PROVIDER_ENV_VARS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GROQ_API_KEY",
  "DEEPSEEK_API_KEY",
  "TOGETHER_API_KEY",
  "FIREWORKS_API_KEY",
  "OPENROUTER_API_KEY",
  "AZURE_API_KEY",
  "CEREBRAS_API_KEY",
  "Z_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_PROFILE",
  "AWS_BEARER_TOKEN_BEDROCK",
];

export function validateProviderKeys(env: Env = process.env): boolean {
  return PROVIDER_ENV_VARS.some((k) => !!env[k]);
}

export function validateConfig(context: Context, env: Env = process.env): void {
  if (!context.gitlabToken) throw new Error("Missing GITLAB_TOKEN environment variable");
  if (!context.projectId) throw new Error("Missing AI_PROJECT_ID (or CI_PROJECT_ID) environment variable");

  if (!context.projectPath) {
    throw new Error("Missing project path. Set AI_PROJECT_PATH or CI_PROJECT_PATH (e.g. group/subgroup/project)");
  }

  if (!context.opencodeModel) {
    throw new Error("Missing OPENCODE_MODEL. Set to 'provider/model' (e.g. anthropic/claude-sonnet-4-20250514).");
  }

  if (context.opencodeModel.startsWith("azure/") && !env.AZURE_RESOURCE_NAME) {
    throw new Error(
      "OPENCODE_MODEL targets Azure, but AZURE_RESOURCE_NAME is not set. Define AZURE_RESOURCE_NAME (e.g., 'my-azure-openai').",
    );
  }
}
