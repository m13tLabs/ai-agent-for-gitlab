import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { buildReviewPrompt, CommandError, commandsHelp, commentTemplates, parseCommand } from "../src/commands.ts";

describe("parseCommand", () => {
  it("ignores regular prompts", () => {
    assert.equal(parseCommand("please /review this"), null);
    assert.equal(parseCommand("fix the bug"), null);
    assert.equal(parseCommand(""), null);
  });

  it("parses a bare /review as a general inline review", () => {
    assert.deepEqual(parseCommand("/review"), { name: "review", aspects: [], inline: true, instructions: "" });
  });

  it("parses aspects case-insensitively, without duplicates", () => {
    assert.equal(parseCommand("/Review")?.name, "review");
    assert.deepEqual(parseCommand("/review security PERFORMANCE security"), {
      name: "review",
      aspects: ["security", "performance"],
      inline: true,
      instructions: "",
    });
  });

  it("parses #inline_comment anywhere on the command line", () => {
    for (const [value, inline] of [["False", false], ["false", false], ["0", false], ["True", true], ["yes", true]] as const) {
      const command = parseCommand(`/review #inline_comment=${value} codeorg`);
      assert.deepEqual(command, { name: "review", aspects: ["codeorg"], inline, instructions: "" });
    }
  });

  it("passes the following lines on as instructions", () => {
    const command = parseCommand("/review scalability\nLook at the queue consumer.\n\nIgnore tests.");
    assert.deepEqual(command, {
      name: "review",
      aspects: ["scalability"],
      inline: true,
      instructions: "Look at the queue consumer.\n\nIgnore tests.",
    });
  });

  it("parses /help", () => {
    assert.deepEqual(parseCommand("/help"), { name: "help" });
  });

  it("rejects unknown commands, aspects, options and values with the usage", () => {
    for (const [input, message] of [
      ["/revue", /Unknown command `\/revue`/],
      ["/review securty", /Unknown review aspect `securty`/],
      ["/review #inline=False", /Unknown option `#inline`/],
      ["/review #inline_comment=maybe", /Invalid value in `#inline_comment=maybe`/],
    ] as const) {
      assert.throws(() => parseCommand(input, "@bot"), (error: Error) => {
        assert.ok(error instanceof CommandError);
        assert.match(error.message, message);
        assert.match(error.message, /`@bot \/review security`/);
        return true;
      });
    }
  });
});

describe("commandsHelp", () => {
  it("uses the trigger phrase", () => {
    assert.match(commandsHelp("@agent"), /`@agent \/review codeoptimize`/);
    assert.doesNotMatch(commandsHelp("@agent"), /@ai/);
  });
});

describe("commentTemplates", () => {
  it("has one valid command per template, with the trigger phrase", () => {
    const templates = commentTemplates("@bot");
    assert.equal(templates.length, 8);
    assert.equal(new Set(templates.map((t) => t.name)).size, 8);
    for (const { name, content } of templates) {
      assert.match(name, /^AI agent: /);
      assert.ok(content.startsWith("@bot /"));
      assert.ok(parseCommand(content.slice("@bot ".length)), `${content} must parse`);
    }
  });
});

describe("buildReviewPrompt", () => {
  const mr = { iid: 7, title: "Add cache", source_branch: "feat", target_branch: "main", description: "Adds a cache." };

  it("keeps the general inline review by default", () => {
    const prompt = buildReviewPrompt({ mr });
    assert.match(prompt, /Look for correctness bugs/);
    assert.match(prompt, /code suggestion tool on the affected lines/);
    assert.doesNotMatch(prompt, /Focus this review/);
    assert.match(prompt, /=== Merge Request !7: Add cache ===\nSource: feat -> Target: main\n\nAdds a cache\.$/);
  });

  it("adds the focus, single-comment output and instructions", () => {
    const prompt = buildReviewPrompt({
      basePrompt: "Custom base.",
      aspects: ["security", "performance"],
      inline: false,
      instructions: "Check auth.ts.",
      author: "alice",
      mr,
    });
    assert.match(prompt, /^Custom base\./);
    assert.match(prompt, /following aspects;.*\n- Security: .*\n- Performance: /);
    assert.match(prompt, /Do NOT use the code suggestion tool/);
    assert.doesNotMatch(prompt, /on the affected lines/);
    assert.match(prompt, /Additional instructions from @alice:\nCheck auth\.ts\./);
  });
});

// The webhook flow against a local GitLab mock: which notes and pipelines a
// comment produces.
describe("webhook commands", () => {
  let gitlab: Server;
  let requests: { method: string; url: string; body: any }[];
  let app: { fetch: (request: Request) => Response | Promise<Response> };

  before(async () => {
    gitlab = createServer(async (req: IncomingMessage, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      requests.push({ method: req.method!, url: req.url!, body: raw ? JSON.parse(raw) : undefined });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(req.url!.endsWith("/pipeline") ? { id: 99, status: "created" } : { id: 1 }));
    });
    await new Promise<void>((resolve) => gitlab.listen(0, "127.0.0.1", resolve));
    Object.assign(process.env, {
      GITLAB_URL: `http://127.0.0.1:${(gitlab.address() as AddressInfo).port}`,
      GITLAB_TOKEN: "t",
      ADMIN_TOKEN: "admin",
      WEBHOOK_SECRET: "secret",
      RATE_LIMITING_ENABLED: "false",
      CANCEL_OLD_PIPELINES: "false",
      LOG_LEVEL: "error",
    });
    app = (await import("../src/index.ts")).default;
  });
  after(() => gitlab.close());
  beforeEach(() => {
    requests = [];
  });

  async function comment(note: string, target: "mr" | "issue" = "mr") {
    const payload = {
      object_kind: "note",
      user: { username: "alice" },
      project: { id: 1, path_with_namespace: "g/p" },
      object_attributes: { id: 5, note, discussion_id: "d1" },
      ...(target === "mr"
        ? { merge_request: { iid: 7, title: "Add cache", source_branch: "feat", target_branch: "main", state: "opened" } }
        : { issue: { iid: 3, title: "Bug", state: "opened" } }),
    };
    const res = await app.fetch(
      new Request("http://app/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Gitlab-Event": "Note Hook", "X-Gitlab-Token": "secret" },
        body: JSON.stringify(payload),
      })
    );
    return { status: res.status, body: await res.text() };
  }

  const pipelineVariables = () => {
    const pipeline = requests.find((r) => r.url.endsWith("/pipeline"));
    assert.ok(pipeline, "no pipeline was created");
    return Object.fromEntries(pipeline.body.variables.map((v: { key: string; value: string }) => [v.key, v.value]));
  };

  it("starts a focused single-comment review", async () => {
    const res = await comment("@ai /review security #inline_comment=False");
    assert.equal(res.status, 200);
    const variables = pipelineVariables();
    assert.equal(variables.AI_REVIEW, "true");
    assert.equal(variables.AI_REVIEW_INLINE, "false");
    assert.equal(variables.AI_DISCUSSION_ID, "d1");
    assert.match(variables.DIRECT_PROMPT, /- Security: /);
    assert.match(variables.DIRECT_PROMPT, /=== Merge Request !7: Add cache ===/);
    // The review prompt replaces the thread, so no discussion is fetched
    assert.ok(!requests.some((r) => r.url.includes("/discussions/d1") && r.method === "GET"));
  });

  it("keeps inline suggestions on by default", async () => {
    await comment("@ai /review");
    const variables = pipelineVariables();
    assert.equal(variables.AI_REVIEW, "true");
    assert.equal(variables.AI_REVIEW_INLINE, undefined);
  });

  it("leaves regular prompts untouched", async () => {
    await comment("@ai explain this change");
    const variables = pipelineVariables();
    assert.equal(variables.AI_REVIEW, undefined);
    assert.equal(variables.DIRECT_PROMPT, "explain this change");
  });

  it("answers /help in the thread without a pipeline", async () => {
    assert.deepEqual(await comment("@ai /help"), { status: 200, body: "help" });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/api/v4/projects/1/merge_requests/7/discussions/d1/notes");
    assert.match(requests[0].body.body, /`@ai \/review security`/);
  });

  it("replies with the usage to an invalid command", async () => {
    assert.deepEqual(await comment("@ai /review securty"), { status: 200, body: "invalid-command" });
    assert.equal(requests.length, 1);
    assert.match(requests[0].body.body, /Unknown review aspect `securty`/);
  });

  it("refuses /review on an issue before creating a branch", async () => {
    assert.deepEqual(await comment("@ai /review", "issue"), { status: 200, body: "review-needs-merge-request" });
    assert.deepEqual(
      requests.map((r) => r.url),
      ["/api/v4/projects/1/issues/3/discussions/d1/notes"]
    );
  });
});
