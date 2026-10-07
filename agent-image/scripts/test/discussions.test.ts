import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  discussionsPath,
  previousFindingsSection,
  summarizeDiscussions,
  type DiscussionSummary,
  type GitLabDiscussion,
} from "../src/discussions.ts";

describe("discussionsPath", () => {
  it("points at the MR or issue discussions", () => {
    assert.equal(
      discussionsPath({ projectId: "42", resourceType: "merge_request", resourceId: "7" }),
      "/projects/42/merge_requests/7/discussions",
    );
    assert.equal(discussionsPath({ projectId: "42", resourceType: "issue", resourceId: "3" }), "/projects/42/issues/3/discussions");
  });
});

describe("summarizeDiscussions", () => {
  const discussions: GitLabDiscussion[] = [
    {
      id: "diff",
      notes: [
        {
          id: 1,
          body: " Off by one \n",
          author: { username: "bot" },
          created_at: "2026-10-01",
          resolvable: true,
          resolved: false,
          position: { new_path: "src/a.ts", new_line: 12, old_line: null },
        },
        { id: 2, body: "Fixed", author: { name: "Alice" }, resolvable: true, resolved: true },
      ],
    },
    { id: "deleted-line", notes: [{ id: 3, body: "x", resolvable: true, resolved: true, position: { old_path: "b.ts", old_line: 4 } }] },
    { id: "system-only", notes: [{ id: 4, body: "added 1 commit", system: true }] },
    { id: "note", individual_note: true, notes: [{ id: 5, body: "Summary", author: { username: "bot" } }] },
  ];

  it("keeps status, location and notes, and drops system-only discussions", () => {
    assert.deepEqual(summarizeDiscussions(discussions), [
      {
        id: "diff",
        status: "unresolved",
        location: "src/a.ts:12",
        notes: [
          { author: "bot", created_at: "2026-10-01", body: "Off by one" },
          { author: "Alice", body: "Fixed" },
        ],
      },
      { id: "deleted-line", status: "resolved", location: "b.ts:4", notes: [{ author: "unknown", body: "x" }] },
      { id: "note", notes: [{ author: "bot", body: "Summary" }] },
    ]);
  });
});

describe("previousFindingsSection", () => {
  const summaries: DiscussionSummary[] = [
    { id: "d1", status: "resolved", location: "a.ts:3", notes: [{ author: "bot", created_at: "t1", body: "Null check\nmissing" }] },
    { id: "d2", notes: [{ author: "alice", body: "Unrelated question" }] },
    {
      id: "d3",
      status: "unresolved",
      notes: [
        { author: "alice", body: "Why this?" },
        { author: "bot", body: "Because" },
        { author: "alice", body: "Won't fix" },
      ],
    },
  ];

  it("lists the AI user's discussions with status, location and later replies", () => {
    const section = previousFindingsSection(summaries, "bot");
    assert.match(section, /^=== Your previous comments and findings on this merge request ===/);
    assert.match(section, /Do not post any of these findings again/);
    assert.match(section, /^- \[resolved\] a\.ts:3 \(t1\) discussion d1\n {4}Null check missing$/m);
    assert.match(section, /^- \[unresolved\] discussion d3\n {4}Because\n {4}↳ @alice: Won't fix$/m);
    assert.doesNotMatch(section, /Unrelated question|Why this/);
  });

  it("is empty without own discussions", () => {
    assert.equal(previousFindingsSection(summaries, "other-bot"), "");
  });

  it("keeps the newest entries within the budget", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ id: `d${i}`, notes: [{ author: "bot", body: `finding ${i}` }] }));
    const section = previousFindingsSection(many, "bot", { resource: "issue", maxChars: 120 });
    assert.match(section, /on this issue ===/);
    assert.match(section, /\(\d older entries omitted\)/);
    assert.match(section, /finding 4/);
    assert.doesNotMatch(section, /finding 0/);
  });

  it("shortens long notes", () => {
    const section = previousFindingsSection([{ id: "d", notes: [{ author: "bot", body: "x".repeat(1000) }] }], "bot");
    assert.match(section, /x{400}…/);
    assert.doesNotMatch(section, /x{401}/);
  });
});
