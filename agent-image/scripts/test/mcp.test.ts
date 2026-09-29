import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { configFromEnv, GitLabMCPServer, type GitLabConfig } from "../mcp/mcp.ts";
import { startGitLabMock, type GitLabMock } from "./helpers.ts";

describe("configFromEnv", () => {
  it("reads the job variables", () => {
    assert.deepEqual(
      configFromEnv({
        CI_SERVER_URL: "https://gl",
        GITLAB_TOKEN: "t",
        CI_PROJECT_ID: "42",
        AI_RESOURCE_ID: "7",
        AI_RESOURCE_TYPE: "merge_request",
        AI_DISCUSSION_ID: "d1",
      }),
      {
        serverUrl: "https://gl",
        gitlabToken: "t",
        projectId: "42",
        resourceId: "7",
        resourceType: "merge_request",
        discussionId: "d1",
      },
    );
  });

  it("defaults to an issue on gitlab.com without a discussion", () => {
    const config = configFromEnv({ CI_ISSUE_IID: "3", AI_DISCUSSION_ID: "" });
    assert.equal(config.serverUrl, "https://gitlab.com");
    assert.equal(config.resourceType, "issue");
    assert.equal(config.resourceId, "3");
    assert.equal(config.discussionId, undefined);
  });
});

describe("GitLabMCPServer", () => {
  let gitlab: GitLabMock;

  before(async () => {
    gitlab = await startGitLabMock();
  });
  after(() => gitlab.close());
  beforeEach(() => {
    gitlab.requests.length = 0;
  });

  async function connect(overrides: Partial<GitLabConfig> = {}): Promise<Client> {
    const server = new GitLabMCPServer({
      serverUrl: gitlab.url,
      gitlabToken: "t",
      projectId: "42",
      resourceId: "7",
      resourceType: "merge_request",
      ...overrides,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientTransport);
    return client;
  }

  const text = (result: Awaited<ReturnType<Client["callTool"]>>) =>
    (result.content as { type: string; text: string }[])[0].text;

  it("lists its tools", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name),
      ["create_gitlab_comment", "get_current_gitlab_resource"],
    );
  });

  describe("create_gitlab_comment", () => {
    it("replies in the MR discussion", async () => {
      gitlab.respond({ status: 201, body: { id: 99 } });
      const client = await connect({ discussionId: "d1" });
      const result = await client.callTool({ name: "create_gitlab_comment", arguments: { message: "hi" } });
      assert.equal(text(result), "Successfully created comment on merge_request #7. Comment ID: 99");
      assert.equal(gitlab.requests[0].url, "/api/v4/projects/42/merge_requests/7/discussions/d1/notes");
      assert.deepEqual(gitlab.requests[0].body, { body: "hi" });
    });

    it("comments on an issue", async () => {
      const client = await connect({ resourceType: "issue" });
      await client.callTool({ name: "create_gitlab_comment", arguments: { message: "hi" } });
      assert.equal(gitlab.requests[0].url, "/api/v4/projects/42/issues/7/notes");
    });

    it("rejects an empty message without calling GitLab", async () => {
      const client = await connect();
      await assert.rejects(
        client.callTool({ name: "create_gitlab_comment", arguments: { message: "" } }),
        /Invalid parameters/,
      );
      assert.equal(gitlab.requests.length, 0);
    });

    it("reports GitLab errors", async () => {
      gitlab.respond({ status: 404, body: { message: "404 Not found" } });
      const client = await connect();
      await assert.rejects(
        client.callTool({ name: "create_gitlab_comment", arguments: { message: "hi" } }),
        /Failed to create comment: GitLab API error 404/,
      );
    });
  });

  describe("get_current_gitlab_resource", () => {
    const resource = {
      id: 1,
      iid: 7,
      title: "T",
      description: "D",
      state: "opened",
      author: { username: "alice" },
      created_at: "c",
      updated_at: "u",
      web_url: "https://gl/g/p/-/merge_requests/7",
      source_branch: "feature",
      target_branch: "main",
      merge_status: "can_be_merged",
      extra: "dropped",
    };

    it("returns the MR summary with branches", async () => {
      gitlab.respond({ status: 200, body: resource });
      const client = await connect();
      const result = await client.callTool({ name: "get_current_gitlab_resource", arguments: {} });
      assert.equal(gitlab.requests[0].method, "GET");
      assert.equal(gitlab.requests[0].url, "/api/v4/projects/42/merge_requests/7");
      const { iid: _iid, extra: _extra, ...expected } = resource;
      assert.deepEqual(JSON.parse(text(result)), expected);
    });

    it("returns an issue without MR fields", async () => {
      gitlab.respond({ status: 200, body: resource });
      const client = await connect({ resourceType: "issue" });
      const parsed = JSON.parse(text(await client.callTool({ name: "get_current_gitlab_resource", arguments: {} })));
      assert.equal(gitlab.requests[0].url, "/api/v4/projects/42/issues/7");
      assert.equal(parsed.source_branch, undefined);
      assert.equal(parsed.title, "T");
    });
  });

  it("rejects unknown tools", async () => {
    const client = await connect();
    await assert.rejects(client.callTool({ name: "nope", arguments: {} }), /Unknown tool: nope/);
  });
});
