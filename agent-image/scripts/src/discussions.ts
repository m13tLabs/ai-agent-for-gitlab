import { gitlabApi, type CommentTarget, type GitLabConnection } from "./gitlab.ts";

// Fields read from GitLab's GET .../discussions payload.
export interface GitLabNote {
  id: number;
  body: string;
  author?: { username?: string; name?: string };
  created_at?: string;
  system?: boolean;
  resolvable?: boolean;
  resolved?: boolean;
  position?: {
    new_path?: string;
    old_path?: string;
    new_line?: number | null;
    old_line?: number | null;
  } | null;
}

export interface GitLabDiscussion {
  id: string;
  individual_note?: boolean;
  notes: GitLabNote[];
}

// A discussion without system notes, reduced to what the agent needs to
// recognize an earlier finding.
export interface DiscussionSummary {
  id: string;
  // "resolved" / "unresolved" for MR threads, undefined where GitLab has no
  // resolve state (issue notes, top-level MR notes).
  status?: "resolved" | "unresolved";
  // file:line for diff notes
  location?: string;
  notes: { author: string; created_at?: string; body: string }[];
}

// Upper bound for GET .../discussions pages (100 discussions each).
const MAX_DISCUSSION_PAGES = 20;

export function discussionsPath(target: CommentTarget): string {
  const resource = (target.resourceType || "").toLowerCase() === "issue" ? "issues" : "merge_requests";
  return `/projects/${target.projectId}/${resource}/${target.resourceId}/discussions`;
}

export async function fetchDiscussions(
  conn: GitLabConnection,
  target: CommentTarget,
): Promise<GitLabDiscussion[]> {
  const discussions: GitLabDiscussion[] = [];
  for (let page = 1; page <= MAX_DISCUSSION_PAGES; page++) {
    const batch = await gitlabApi<GitLabDiscussion[]>(
      conn,
      "GET",
      `${discussionsPath(target)}?per_page=100&page=${page}`,
    );
    discussions.push(...batch);
    if (batch.length < 100) break;
  }
  return discussions;
}

// Drops system notes ("changed this line in version 3") and discussions left
// empty by that.
export function summarizeDiscussions(discussions: GitLabDiscussion[]): DiscussionSummary[] {
  return discussions.flatMap((d) => {
    const notes = d.notes.filter((n) => !n.system);
    if (notes.length === 0) return [];
    const first = notes[0];
    const resolvable = notes.some((n) => n.resolvable);
    const pos = first.position;
    const path = pos?.new_path || pos?.old_path;
    const line = pos?.new_line ?? pos?.old_line;
    return [
      {
        id: d.id,
        ...(resolvable && { status: notes.every((n) => !n.resolvable || n.resolved) ? "resolved" : "unresolved" }),
        ...(path && { location: line ? `${path}:${line}` : path }),
        notes: notes.map((n) => ({
          author: n.author?.username || n.author?.name || "unknown",
          ...(n.created_at && { created_at: n.created_at }),
          body: n.body.trim(),
        })),
      } satisfies DiscussionSummary,
    ];
  });
}

// Discussions the AI user started or replied in.
export function aiDiscussions(summaries: DiscussionSummary[], aiUsername: string): DiscussionSummary[] {
  return summaries.filter((s) => s.notes.some((n) => n.author === aiUsername));
}

// Per-note excerpt length and overall budget of the prompt section. The
// prompt goes to opencode on stdin, so this only guards the model's context.
const EXCERPT_CHARS = 400;
const MAX_SECTION_CHARS = 24000;

function excerpt(text: string, max = EXCERPT_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

// Prompt section listing the AI user's earlier comments and findings, newest
// last, with how the thread went on after them. Returns "" when there are none.
export function previousFindingsSection(
  summaries: DiscussionSummary[],
  aiUsername: string,
  { resource = "merge request", maxChars = MAX_SECTION_CHARS }: { resource?: string; maxChars?: number } = {},
): string {
  const entries = aiDiscussions(summaries, aiUsername).map((s) => {
    const own = s.notes.find((n) => n.author === aiUsername)!;
    const head = [
      s.status ? `[${s.status}]` : "[comment]",
      s.location,
      own.created_at && `(${own.created_at})`,
      `discussion ${s.id}`,
    ]
      .filter(Boolean)
      .join(" ");
    const replies = s.notes
      .slice(s.notes.indexOf(own) + 1)
      .map((n) => `    ↳ @${n.author}: ${excerpt(n.body, EXCERPT_CHARS / 2)}`);
    return [`- ${head}`, `    ${excerpt(own.body)}`, ...replies].join("\n");
  });
  if (entries.length === 0) return "";

  // Keep the newest entries when over budget.
  const kept: string[] = [];
  let size = 0;
  for (const entry of [...entries].reverse()) {
    if (size + entry.length > maxChars) break;
    kept.unshift(entry);
    size += entry.length + 1;
  }
  const omitted = entries.length - kept.length;

  return [
    `=== Your previous comments and findings on this ${resource} ===`,
    `You (@${aiUsername}) already commented here in earlier runs. Do not post any of these findings again.`,
    "- [unresolved]: still open. Only reply in that discussion if you have something new to add (e.g. it is still not fixed after new commits); otherwise leave it.",
    "- [resolved]: fixed or dismissed by a human. Do not raise it again, unless the current code clearly reintroduces the problem.",
    "- Replies show how humans reacted; respect a decision not to change something.",
    "In a summary comment, list only new findings and refer to still open earlier ones by their discussion instead of repeating them.",
    "Use the list_gitlab_discussions tool for the full text of all discussions.",
    "",
    ...(omitted > 0 ? [`(${omitted} older entries omitted)`] : []),
    ...kept,
  ].join("\n");
}
