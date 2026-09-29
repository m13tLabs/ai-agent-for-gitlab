import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildContext } from "../src/context.ts";

describe("buildContext", () => {
  it("maps the pipeline variables", () => {
    const ctx = buildContext({
      AI_PROJECT_PATH: "g/p",
      AI_AUTHOR: "alice",
      AI_RESOURCE_TYPE: "merge_request",
      AI_RESOURCE_ID: "7",
      AI_DISCUSSION_ID: "abc",
      DIRECT_PROMPT: "@ai fix it",
      AI_BRANCH: "feature",
      AI_GITLAB_EMAIL: "bot@example.com",
      AI_GITLAB_USERNAME: "bot",
      OPENCODE_MODEL: "anthropic/claude",
      GITLAB_TOKEN: "t",
      CI_SERVER_HOST: "gitlab.example.com",
      CI_SERVER_URL: "https://gitlab.example.com",
      AI_PROJECT_ID: "42",
    });
    assert.deepEqual(ctx, {
      projectPath: "g/p",
      author: "alice",
      resourceType: "merge_request",
      resourceId: "7",
      discussionId: "abc",
      prompt: "@ai fix it",
      branch: "feature",
      email: "bot@example.com",
      username: "bot",
      opencodeModel: "anthropic/claude",
      agentPrompt: "",
      gitlabToken: "t",
      host: "gitlab.example.com",
      projectId: "42",
      serverUrl: "https://gitlab.example.com",
      checkoutDir: "./repo",
    });
  });

  it("defaults to gitlab.com", () => {
    const ctx = buildContext({});
    assert.equal(ctx.host, "gitlab.com");
    assert.equal(ctx.serverUrl, "https://gitlab.com");
  });

  it("prefers AI_PROJECT_ID (target project) over CI_PROJECT_ID (runner project)", () => {
    assert.equal(buildContext({ AI_PROJECT_ID: "1", CI_PROJECT_ID: "2" }).projectId, "1");
    assert.equal(buildContext({ CI_PROJECT_ID: "2" }).projectId, "2");
  });

  describe("agent prompt", () => {
    it("uses whichever prompt is set", () => {
      assert.equal(buildContext({ OPENCODE_AGENT_PROMPT: "app" }).agentPrompt, "app");
      assert.equal(buildContext({ CUSTOM_AGENT_PROMPT: "pipeline" }).agentPrompt, "pipeline");
    });

    it("appends the pipeline prompt to the webhook app prompt", () => {
      const ctx = buildContext({ OPENCODE_AGENT_PROMPT: " app \n", CUSTOM_AGENT_PROMPT: "\npipeline " });
      assert.equal(ctx.agentPrompt, "app\n\n---\n# Pipeline Additions\npipeline");
    });
  });
});
