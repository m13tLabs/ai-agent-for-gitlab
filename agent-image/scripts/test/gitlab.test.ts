import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { commentEndpoint, gitlabApi, postComment } from "../src/gitlab.ts";
import { silenceConsole, startGitLabMock, UNREACHABLE_URL, type GitLabMock } from "./helpers.ts";

describe("commentEndpoint", () => {
  const target = { projectId: "42", resourceId: "7" };

  it("posts issue notes", () => {
    assert.equal(commentEndpoint({ ...target, resourceType: "issue" }), "/projects/42/issues/7/notes");
    assert.equal(commentEndpoint({ ...target, resourceType: "Issue" }), "/projects/42/issues/7/notes");
  });

  it("ignores a discussion ID on issues", () => {
    assert.equal(
      commentEndpoint({ ...target, resourceType: "issue", discussionId: "d" }),
      "/projects/42/issues/7/notes",
    );
  });

  it("posts a top-level MR note without a discussion ID", () => {
    assert.equal(commentEndpoint({ ...target, resourceType: "merge_request" }), "/projects/42/merge_requests/7/notes");
    assert.equal(
      commentEndpoint({ ...target, resourceType: "merge_request", discussionId: "" }),
      "/projects/42/merge_requests/7/notes",
    );
  });

  it("replies in the MR thread with a discussion ID", () => {
    assert.equal(
      commentEndpoint({ ...target, resourceType: "merge_request", discussionId: "d1" }),
      "/projects/42/merge_requests/7/discussions/d1/notes",
    );
  });
});

describe("GitLab API", () => {
  let gitlab: GitLabMock;

  before(async () => {
    gitlab = await startGitLabMock();
  });
  after(() => gitlab.close());
  beforeEach(() => {
    gitlab.requests.length = 0;
    silenceConsole();
  });

  describe("gitlabApi", () => {
    it("sends the token and JSON body, returns parsed JSON", async () => {
      gitlab.respond({ status: 201, body: { id: 5 } });
      const res = await gitlabApi({ serverUrl: gitlab.url, gitlabToken: "secret" }, "POST", "/x", { a: 1 });
      assert.deepEqual(res, { id: 5 });
      const [req] = gitlab.requests;
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/api/v4/x");
      assert.equal(req.headers["private-token"], "secret");
      assert.deepEqual(req.body, { a: 1 });
    });

    it("sends no body without data", async () => {
      await gitlabApi({ serverUrl: gitlab.url }, "GET", "/x");
      assert.equal(gitlab.requests[0].body, undefined);
    });

    it("returns non-JSON bodies as text", async () => {
      gitlab.respond({ status: 200, body: "plain" });
      assert.equal(await gitlabApi({ serverUrl: gitlab.url }, "GET", "/x"), "plain");
    });

    it("rejects with status and body on errors", async () => {
      gitlab.respond({ status: 403, body: { message: "403 Forbidden" } });
      await assert.rejects(gitlabApi({ serverUrl: gitlab.url }, "GET", "/x"), {
        message: 'GitLab API error 403: {"message":"403 Forbidden"}',
      });
    });
  });

  describe("postComment", () => {
    const ctx = () => ({
      serverUrl: gitlab.url,
      gitlabToken: "t",
      projectId: "42",
      resourceType: "merge_request",
      resourceId: "7",
      discussionId: "d1",
    });

    it("posts the message to the resolved endpoint", async () => {
      gitlab.respond({ status: 201, body: { id: 1 } });
      await postComment(ctx(), "hello");
      assert.equal(gitlab.requests.length, 1);
      assert.equal(gitlab.requests[0].url, "/api/v4/projects/42/merge_requests/7/discussions/d1/notes");
      assert.deepEqual(gitlab.requests[0].body, { body: "hello" });
    });

    it("logs instead of throwing when GitLab rejects the comment", async () => {
      gitlab.respond({ status: 500, body: "boom" });
      await assert.doesNotReject(postComment(ctx(), "hello"));
    });

    it("logs instead of throwing when GitLab is unreachable", async () => {
      await assert.doesNotReject(postComment({ ...ctx(), serverUrl: UNREACHABLE_URL }, "hello"));
    });
  });
});
