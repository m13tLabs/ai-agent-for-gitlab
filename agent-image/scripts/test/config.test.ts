import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateConfig, validateProviderKeys } from "../src/config.ts";
import { buildContext } from "../src/context.ts";

const valid = {
  GITLAB_TOKEN: "t",
  AI_PROJECT_ID: "1",
  AI_PROJECT_PATH: "g/p",
  OPENCODE_MODEL: "anthropic/claude",
};

describe("validateProviderKeys", () => {
  it("is false without any provider credential", () => {
    assert.equal(validateProviderKeys({}), false);
    assert.equal(validateProviderKeys({ ANTHROPIC_API_KEY: "" }), false);
  });

  it("accepts API keys and AWS credentials", () => {
    assert.equal(validateProviderKeys({ ANTHROPIC_API_KEY: "k" }), true);
    assert.equal(validateProviderKeys({ AWS_PROFILE: "default" }), true);
    assert.equal(validateProviderKeys({ AWS_BEARER_TOKEN_BEDROCK: "b" }), true);
  });
});

describe("validateConfig", () => {
  const check = (env: Record<string, string>) => () => validateConfig(buildContext(env), env);

  it("passes a complete config", () => {
    assert.doesNotThrow(check(valid));
  });

  for (const [name, message] of [
    ["GITLAB_TOKEN", /Missing GITLAB_AI_AGENT_TOKEN \(or GITLAB_TOKEN\)/],
    ["AI_PROJECT_ID", /Missing AI_PROJECT_ID/],
    ["AI_PROJECT_PATH", /Missing project path/],
    ["OPENCODE_MODEL", /Missing OPENCODE_MODEL/],
  ] as const) {
    it(`fails without ${name}`, () => {
      const env: Record<string, string> = { ...valid };
      delete env[name];
      assert.throws(check(env), message);
    });
  }

  it("accepts CI_PROJECT_ID in place of AI_PROJECT_ID", () => {
    const { AI_PROJECT_ID: _, ...env } = valid;
    assert.doesNotThrow(check({ ...env, CI_PROJECT_ID: "2" }));
  });

  it("requires AZURE_RESOURCE_NAME for Azure models only", () => {
    const azure = { ...valid, OPENCODE_MODEL: "azure/gpt-4.1" };
    assert.throws(check(azure), /AZURE_RESOURCE_NAME is not set/);
    assert.doesNotThrow(check({ ...azure, AZURE_RESOURCE_NAME: "r" }));
  });
});
