import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { errorComment, failedJobLink } from "../src/runner.ts";
import { outputFile, writeOutput } from "../src/output.ts";
import { tempDir } from "./helpers.ts";

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
