import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  errorComment,
  failedJobLink,
  permissionComment,
  previousFindings,
  reviewRetriggerComment,
} from "../src/runner.ts";
import { buildContext } from "../src/context.ts";
import { outputFile, writeOutput } from "../src/output.ts";
import { silenceConsole, startGitLabMock, tempDir, UNREACHABLE_URL, type GitLabMock } from "./helpers.ts";

describe("failedJobLink", () => {
  it("links job and pipeline", () => {
    assert.equal(
      failedJobLink({ CI_JOB_URL: "https://gl/j/1", CI_PIPELINE_URL: "https://gl/p/9", CI_PIPELINE_IID: "9" }),
      "See the [failed job](https://gl/j/1) of [pipeline #9](https://gl/p/9) for details.",
    );
  });

  it("falls back to the pipeline ID without an IID", () => {
    assert.equal(
      failedJobLink({ CI_JOB_URL: "https://gl/j/1", CI_PIPELINE_URL: "https://gl/p/900", CI_PIPELINE_ID: "900" }),
      "See the [failed job](https://gl/j/1) of [pipeline #900](https://gl/p/900) for details.",
    );
  });

  it("links only the job without a pipeline URL", () => {
    assert.equal(failedJobLink({ CI_JOB_URL: "https://gl/j/1" }), "See the [failed job](https://gl/j/1) for details.");
  });

  it("points at the logs outside CI", () => {
    assert.equal(failedJobLink({}), "Please check the pipeline logs for details.");
  });
});

describe("errorComment", () => {
  it("wraps the message in a code block followed by the job link", () => {
    assert.equal(
      errorComment("boom", { CI_JOB_URL: "https://gl/j/1" }),
      "❌ AI encountered an error:\n\n```\nboom\n```\n\nSee the [failed job](https://gl/j/1) for details.",
    );
  });
});

describe("permissionComment", () => {
  it("lists each rejected permission and hints at the opencode config", () => {
    const comment = permissionComment([
      { tool: "read", target: "themes/.env" },
      { tool: "external_directory", target: "/etc" },
    ]);
    assert.match(comment, /^⚠️ The AI was denied access/);
    assert.match(comment, /^- `read` on `themes\/\.env`\n- `external_directory` on `\/etc`$/m);
    assert.match(comment, /opencode\.ai\/docs\/permissions/);
  });
});

describe("outputFile", () => {
  it("lives in the job's project dir, where the CI templates collect it", () => {
    assert.equal(outputFile({ CI_PROJECT_DIR: "/builds/g/p" }), "/builds/g/p/ai-output.json");
  });

  it("falls back to /opt/agent outside CI", () => {
    assert.equal(outputFile({}), "/opt/agent/ai-output.json");
  });
});

describe("writeOutput", () => {
  it("writes the result with a timestamp", () => {
    const file = join(tempDir(), "ai-output.json");
    const returned = writeOutput(false, { error: "boom" }, file);
    const { timestamp, ...rest } = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(rest, { success: false, error: "boom" });
    assert.equal(timestamp, returned.timestamp);
    assert.ok(!Number.isNaN(Date.parse(timestamp)));
  });
});

describe("reviewRetriggerComment", () => {
  it("names the trigger phrase", () => {
    const comment = reviewRetriggerComment("@review-agent");
    assert.match(comment, /^🔁 To review this merge request again/);
    assert.match(comment, /comment `@review-agent review`/);
    assert.match(comment, /`@review-agent review focus on error handling`/);
  });
});

describe("previousFindings", () => {
  let gitlab: GitLabMock;

  before(async () => {
    gitlab = await startGitLabMock();
  });
  after(() => gitlab.close());
  beforeEach(() => {
    silenceConsole();
    gitlab.requests.length = 0;
  });

  const context = (env: Record<string, string> = {}) =>
    buildContext({
      CI_SERVER_URL: gitlab.url,
      GITLAB_TOKEN: "t",
      AI_PROJECT_ID: "42",
      AI_RESOURCE_TYPE: "merge_request",
      AI_RESOURCE_ID: "7",
      AI_GITLAB_USERNAME: "bot",
      ...env,
    });

  const own = (id: string, body: string) => ({ id, notes: [{ id: 1, body, author: { username: "bot" } }] });

  it("lists the agent's earlier comments, except the current thread and its own status notes", async () => {
    gitlab.respond({
      status: 200,
      body: [
        own("d1", "Missing null check"),
        own("current", "In this thread"),
        own("d2", reviewRetriggerComment("@ai")),
        own("d3", errorComment("boom", {})),
      ],
    });
    const section = await previousFindings(context({ AI_DISCUSSION_ID: "current" }));
    assert.equal(gitlab.requests[0].url, "/api/v4/projects/42/merge_requests/7/discussions?per_page=100&page=1");
    assert.match(section, /discussion d1\n {4}Missing null check/);
    assert.doesNotMatch(section, /In this thread|To review this merge request again|encountered an error/);
  });

  it("is empty without the AI username, without calling GitLab", async () => {
    assert.equal(await previousFindings(context({ AI_GITLAB_USERNAME: "" })), "");
    assert.equal(gitlab.requests.length, 0);
  });

  it("is empty when GitLab can't be reached", async () => {
    assert.equal(await previousFindings(context({ CI_SERVER_URL: UNREACHABLE_URL })), "");
  });
});
