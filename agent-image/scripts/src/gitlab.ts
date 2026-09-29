import logger from "./logger.ts";

export interface GitLabConnection {
  serverUrl: string;
  gitlabToken?: string;
}

export interface CommentTarget {
  projectId?: string;
  resourceType?: string;
  resourceId?: string;
  discussionId?: string;
}

// Returns the parsed JSON body, or the raw text when it isn't JSON.
export async function gitlabApi<T = unknown>(
  conn: GitLabConnection,
  method: string,
  path: string,
  data: unknown = null,
): Promise<T> {
  const res = await fetch(`${conn.serverUrl}/api/v4${path}`, {
    method,
    headers: {
      "PRIVATE-TOKEN": conn.gitlabToken ?? "",
      "Content-Type": "application/json",
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`GitLab API error ${res.status}: ${body}`);
  try {
    return JSON.parse(body) as T;
  } catch {
    return body as T;
  }
}

// Issue note, MR thread reply (with a discussion ID) or top-level MR note.
export function commentEndpoint(target: CommentTarget): string {
  const base = `/projects/${target.projectId}`;
  if ((target.resourceType || "").toLowerCase() === "issue") {
    return `${base}/issues/${target.resourceId}/notes`;
  }
  return target.discussionId
    ? `${base}/merge_requests/${target.resourceId}/discussions/${target.discussionId}/notes`
    : `${base}/merge_requests/${target.resourceId}/notes`;
}

// Non-critical: a failure is logged, never thrown.
export async function postComment(context: GitLabConnection & CommentTarget, message: string): Promise<void> {
  const endpoint = commentEndpoint(context);
  const inThread = endpoint.includes("/discussions/");

  try {
    await gitlabApi(context, "POST", endpoint, { body: message });
    logger.info(
      `Posted comment to ${context.resourceType} #${context.resourceId}${
        inThread ? ` (discussion ${context.discussionId})` : ""
      }`,
    );
  } catch (error) {
    logger.error(`Failed to post comment: ${(error as Error).message}`);
  }
}
