// Slash commands in an `@ai` comment, modeled on GitLab quick actions:
//
//   @ai /review [aspect ...] [#inline_comment=False]
//   <optional extra instructions on the following lines>
//   @ai /help
//
// Only the text right after the trigger phrase counts, so `@ai please /review`
// stays a regular prompt. GitLab itself can't parse these: `@ai /review` doesn't
// start the line, and GitLab ignores unknown quick actions anyway.

export const REVIEW_ASPECTS = {
  security:
    "Security: identify vulnerabilities and insecure coding practices, e.g. injection, broken authentication or authorization, " +
    "secrets in code, unsafe deserialization, missing input validation or output encoding, insecure defaults and vulnerable dependency usage. " +
    "Rate each finding's severity and explain how it could be exploited.",
  performance:
    "Performance: find slow or resource-heavy code, e.g. needless work in hot paths or loops, N+1 queries, blocking I/O, " +
    "excessive allocations or copies, missing caching and inefficient algorithms or data structures. Estimate the impact where possible.",
  scalability:
    "Scalability: assess how the code behaves under growing load and data, e.g. unbounded memory or result sets, missing pagination, " +
    "contention on shared state or locks, single points of failure, chatty remote calls, and assumptions that break with multiple instances.",
  codeorg:
    "Code organization: assess readability and maintainability, e.g. naming, function and module size and responsibilities, " +
    "duplication, coupling and cohesion, consistency with the surrounding code, and dead or confusing code.",
  codeoptimize:
    "Optimization: point out concrete opportunities to make the code more efficient and less resource-hungry, " +
    "e.g. simpler algorithms, avoiding repeated computation, cheaper library calls and fewer allocations, without hurting readability.",
} as const;

export type ReviewAspect = keyof typeof REVIEW_ASPECTS;

export interface ReviewCommand {
  name: "review";
  aspects: ReviewAspect[];
  // false: everything in one comment, no inline code suggestions
  inline: boolean;
  instructions: string;
}

export type Command = ReviewCommand | { name: "help" };

export class CommandError extends Error {}

const COMMANDS_HELP =
  "| Command | What it does |\n" +
  "| --- | --- |\n" +
  "| `@ai /review` | General review of the merge request: correctness, security, tests, maintainability |\n" +
  "| `@ai /review security` | Security vulnerabilities and secure coding practices |\n" +
  "| `@ai /review performance` | Slow or resource-heavy code |\n" +
  "| `@ai /review scalability` | How the code copes with growing usage and data |\n" +
  "| `@ai /review codeorg` | Readability, maintainability and code organization |\n" +
  "| `@ai /review codeoptimize` | Opportunities to make the code more efficient |\n" +
  "| `@ai /help` | This list |\n\n" +
  "Aspects can be combined (`@ai /review security performance`). Reviews post code suggestions inline on the diff by default; " +
  "add `#inline_comment=False` to get the whole review in a single comment instead. " +
  "Lines after the command are passed on as extra instructions. Reviews work on merge requests only.";

// The command list, written with the configured trigger phrase.
export function commandsHelp(triggerPhrase = "@ai"): string {
  return COMMANDS_HELP.replaceAll("`@ai ", `\`${triggerPhrase} `);
}

// Returns null when the prompt isn't a slash command (a regular `@ai` prompt).
// Throws CommandError for a malformed command, with a message for the user.
export function parseCommand(prompt: string, triggerPhrase = "@ai"): Command | null {
  const match = prompt.match(/^\/([a-z_]+)\b([^\n]*)(?:\n([\s\S]*))?$/i);
  if (!match) return null;

  const [, rawName, args, rest = ""] = match;
  const name = rawName.toLowerCase();
  const usage = commandsHelp(triggerPhrase);

  if (name === "help") return { name: "help" };
  if (name !== "review") {
    throw new CommandError(`Unknown command \`/${rawName}\`. Available commands:\n\n${usage}`);
  }

  const aspects: ReviewAspect[] = [];
  let inline = true;
  for (const token of args.trim().split(/\s+/).filter(Boolean)) {
    const option = token.match(/^#([a-z_]+)=(\S*)$/i);
    if (option) {
      const [, key, value] = option;
      if (key.toLowerCase() !== "inline_comment") {
        throw new CommandError(`Unknown option \`#${key}\`.\n\n${usage}`);
      }
      inline = parseBoolean(value, token, usage);
    } else if (Object.hasOwn(REVIEW_ASPECTS, token.toLowerCase())) {
      const aspect = token.toLowerCase() as ReviewAspect;
      if (!aspects.includes(aspect)) aspects.push(aspect);
    } else {
      throw new CommandError(`Unknown review aspect \`${token}\`.\n\n${usage}`);
    }
  }

  return { name: "review", aspects, inline, instructions: rest.trim() };
}

function parseBoolean(value: string, token: string, usage: string): boolean {
  switch (value.toLowerCase()) {
    case "true":
    case "yes":
    case "1":
      return true;
    case "false":
    case "no":
    case "0":
      return false;
    default:
      throw new CommandError(`Invalid value in \`${token}\`, use \`True\` or \`False\`.\n\n${usage}`);
  }
}

export const DEFAULT_REVIEW_PROMPT =
  "You have been requested to review this merge request. Use the context tool to read the MR and its diff against the target branch. " +
  "Look for correctness bugs, security issues, missing tests and notable maintainability concerns.";

const INLINE_OUTPUT =
  "For each finding with a concrete code fix, post it with the code suggestion tool on the affected lines, so it can be applied from the MR. " +
  "Then post a single summary comment listing all findings with file/line references and links to the posted suggestions.";

const SINGLE_POST_OUTPUT =
  "Do NOT use the code suggestion tool and do not post inline comments. Post the whole review as one single comment: " +
  "group the findings by file, give file/line references for each, and include concrete fixes as fenced code blocks.";

// Full prompt for a review: the base instructions (REVIEW_PROMPT or the
// default), the requested focus, how to post the result, and the MR header.
export function buildReviewPrompt(params: {
  basePrompt?: string;
  aspects?: ReviewAspect[];
  inline?: boolean;
  instructions?: string;
  author?: string;
  mr: { iid: number; title: string; source_branch: string; target_branch: string; description?: string };
}): string {
  const { mr, aspects = [], inline = true, instructions, author } = params;
  const parts = [params.basePrompt || DEFAULT_REVIEW_PROMPT];

  if (aspects.length > 0) {
    parts.push(
      `Focus this review on the following aspect${aspects.length > 1 ? "s" : ""}; ` +
        "skip findings outside of them unless they are severe:\n" +
        aspects.map((a) => `- ${REVIEW_ASPECTS[a]}`).join("\n")
    );
  }

  parts.push(inline ? INLINE_OUTPUT : SINGLE_POST_OUTPUT);
  parts.push("Do not commit or push any changes unless explicitly asked.");

  if (instructions) {
    parts.push(`Additional instructions${author ? ` from @${author}` : ""}:\n${instructions}`);
  }

  parts.push(
    `=== Merge Request !${mr.iid}: ${mr.title} ===\n` +
      `Source: ${mr.source_branch} -> Target: ${mr.target_branch}\n\n${mr.description || ""}`.trim()
  );

  return parts.join("\n\n");
}

// Prefix of the group comment templates the gitlabSetup Job maintains; it
// removes templates with this prefix that aren't in the list (any longer).
export const COMMENT_TEMPLATE_PREFIX = "AI agent: ";

// One comment template per command (Premium/Ultimate group templates, see
// ensureCommentTemplates in setup.ts), inserted from the editor toolbar.
export function commentTemplates(triggerPhrase = "@ai"): { name: string; content: string }[] {
  return [
    ["review", "/review"],
    ...Object.keys(REVIEW_ASPECTS).map((aspect) => [`review ${aspect}`, `/review ${aspect}`]),
    ["review as single comment", "/review #inline_comment=False"],
    ["help", "/help"],
  ].map(([name, command]) => ({ name: COMMENT_TEMPLATE_PREFIX + name, content: `${triggerPhrase} ${command}` }));
}
