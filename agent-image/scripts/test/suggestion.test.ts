import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { diffLines, fallbackBody, projectWebUrl, suggestionBody } from "../src/suggestion.ts";

describe("diffLines", () => {
  it("maps added lines without and context lines with an old line", () => {
    const diff = "@@ -10,3 +10,4 @@ fn\n a\n-b\n+c\n+d\n e\n\\ No newline at end of file\n@@ -30,1 +31,1 @@\n f\n";
    const lines = diffLines(diff);
    assert.deepEqual(lines.get(10), { oldLine: 10, newLine: 10 });
    assert.deepEqual(lines.get(11), { newLine: 11 });
    assert.deepEqual(lines.get(12), { newLine: 12 });
    assert.deepEqual(lines.get(13), { oldLine: 12, newLine: 13 });
    assert.deepEqual(lines.get(31), { oldLine: 30, newLine: 31 });
    assert.equal(lines.get(14), undefined);
  });
});

describe("suggestionBody", () => {
  it("anchors a multi-line range on its last line", () => {
    assert.equal(
      suggestionBody("Use stdin.", "  x\n  y\n", 5, 7),
      "Use stdin.\n\n```suggestion:-2+0\n  x\n  y\n```",
    );
  });

  it("uses a longer fence when the code contains backticks", () => {
    assert.equal(suggestionBody("", "a ```b```", 1, 1), "````suggestion:-0+0\na ```b```\n````");
  });
});

describe("fallbackBody", () => {
  it("links the line range", () => {
    assert.equal(
      fallbackBody("Why.", "x", { url: "https://gl/g/p/-/blob/abc/a.ts", path: "a.ts", startLine: 3, endLine: 4 }),
      "Why.\n\nSuggested change for [`a.ts#L3-4`](https://gl/g/p/-/blob/abc/a.ts#L3-4):\n\n```\nx\n```",
    );
  });
});

describe("projectWebUrl", () => {
  it("strips the MR part", () => {
    assert.equal(projectWebUrl("https://gl/g/p/-/merge_requests/7"), "https://gl/g/p");
  });
});
