// Helpers for posting GitLab code suggestions (```suggestion blocks) as MR
// diff discussions.

export interface DiffRefs {
  base_sha: string;
  head_sha: string;
  start_sha: string;
}

// One entry of GET /projects/:id/merge_requests/:iid/diffs
export interface MergeRequestDiff {
  old_path: string;
  new_path: string;
  diff: string;
  deleted_file?: boolean;
}

// A new-file line that is part of the MR diff: an added line has no old line,
// a context line has both.
export interface DiffLine {
  oldLine?: number;
  newLine: number;
}

// New line number -> diff line, for every added or context line of a file diff.
export function diffLines(diff: string): Map<number, DiffLine> {
  const lines = new Map<number, DiffLine>();
  let oldLine = 0;
  let newLine = 0;
  for (const line of diff.split("\n")) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
    } else if (line.startsWith("+")) {
      lines.set(newLine, { newLine });
      newLine++;
    } else if (line.startsWith("-")) {
      oldLine++;
    } else if (line.startsWith(" ")) {
      lines.set(newLine, { oldLine, newLine });
      oldLine++;
      newLine++;
    }
    // "\ No newline at end of file" and trailing empty lines move nothing
  }
  return lines;
}

// A fence longer than any backtick run in the code, so the code can't close it.
function fence(code: string): string {
  const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longest + 1));
}

// Comment body replacing lines startLine..endLine; the note is anchored on
// endLine, so the range reaches (endLine - startLine) lines above it.
export function suggestionBody(comment: string, code: string, startLine: number, endLine: number): string {
  const f = fence(code);
  const block = `${f}suggestion:-${endLine - startLine}+0\n${code.replace(/\n$/, "")}\n${f}`;
  return comment.trim() ? `${comment.trim()}\n\n${block}` : block;
}

// Fallback for lines outside the diff: a plain note with a permalink and the
// proposed code, since GitLab only anchors suggestions on diff lines.
export function fallbackBody(
  comment: string,
  code: string,
  link: { url: string; path: string; startLine: number; endLine: number },
): string {
  const range = link.startLine === link.endLine ? `L${link.startLine}` : `L${link.startLine}-${link.endLine}`;
  const f = fence(code);
  return [
    comment.trim(),
    `Suggested change for [\`${link.path}#${range}\`](${link.url}#${range}):`,
    `${f}\n${code.replace(/\n$/, "")}\n${f}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

// https://gl/group/project/-/merge_requests/7 -> https://gl/group/project
export function projectWebUrl(mrWebUrl: string): string {
  return mrWebUrl.replace(/\/-\/merge_requests\/\d+\/?$/, "");
}
