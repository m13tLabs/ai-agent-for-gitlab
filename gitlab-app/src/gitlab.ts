import { Gitlab } from "@gitbeaker/rest";
import { logger } from "./logger.ts";

// Initialize GitLab client
const gitlab = new Gitlab({
  host: process.env.GITLAB_URL || "https://gitlab.com",
  token: process.env.GITLAB_TOKEN!,
});

// Optional central runner project (AI_RUNNER_PROJECT: id or full path). When
// set, every pipeline runs there instead of in the project the event came
// from, so projects need no .gitlab-ci.yml changes. The agent learns the
// target from AI_PROJECT_ID / AI_PROJECT_PATH / AI_BRANCH.
const runnerProject = process.env.AI_RUNNER_PROJECT || "";
let runnerRef = process.env.AI_RUNNER_REF || "";

async function pipelineTarget(projectId: number, ref: string): Promise<{ project: string | number; ref: string }> {
  if (!runnerProject) return { project: projectId, ref };
  if (!runnerRef) runnerRef = (await getProject(runnerProject)).default_branch;
  return { project: runnerProject, ref: runnerRef };
}

export async function triggerPipeline(
  projectId: number,
  ref: string,
  variables?: Record<string, string>,
  mrIid?: number
): Promise<number> {
  try {
    logger.debug("Creating pipeline", {
      projectId,
      ref,
      variables: logger.maskSensitive(variables),
      mrIid,
    });

    const gitlabUrl = process.env.GITLAB_URL || "https://gitlab.com";
    const token = process.env.GITLAB_TOKEN!;

    // Transform variables to GitLab API format. AI_PROJECT_ID names the
    // target project even when the pipeline runs in the runner project.
    let pipelineVariables: Array<{ key: string; value: string }> = Object.entries({
      ...variables,
      AI_PROJECT_ID: String(projectId),
    }).map(([key, value]) => ({ key, value }));

    const target = await pipelineTarget(projectId, ref);
    const requestBody = {
      ref: target.ref,
      variables: pipelineVariables,
    };

    // Important: Use the general pipeline endpoint so variables (like AI_TRIGGER) are honored
    const baseUrl = `${gitlabUrl}/api/v4/projects/${encodeURIComponent(String(target.project))}/pipeline`;

    logger.debug("Pipeline request body", {
      url: baseUrl,
      body: {
        ...requestBody,
        variables: logger.maskSensitive(pipelineVariables),
      },
    });

    // Ensure only the AI job is selected by rules in the pipeline (ai_webhook_handler)
    // The .gitlab-ci.yml uses `rules: if: '$AI_TRIGGER == "true"'` on the ai job.
    // We set AI_TRIGGER=true here so that job is included and others can be skipped by rules.
    const hasAiTrigger = pipelineVariables.some((v) => v.key === "AI_TRIGGER");
    if (!hasAiTrigger) {
      pipelineVariables.push({ key: "AI_TRIGGER", value: "true" });
    } else {
      // normalize to "true" if provided differently
      pipelineVariables = pipelineVariables.map((v) =>
        v.key === "AI_TRIGGER" ? { ...v, value: "true" } : v
      );
    }

    const response = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "PRIVATE-TOKEN": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...requestBody,
        variables: pipelineVariables,
      }),
    });

    const responseText = await response.text();
    let responseData;

    try {
      responseData = JSON.parse(responseText);
    } catch (e) {
      logger.error("Failed to parse pipeline response", {
        status: response.status,
        statusText: response.statusText,
        responseText,
      });
      throw new Error(
        `Pipeline API returned invalid JSON: ${response.statusText}`
      );
    }

    if (!response.ok) {
      logger.error("Pipeline creation failed", {
        status: response.status,
        statusText: response.statusText,
        responseBody: responseData,
        projectId,
        ref,
        mrIid,
      });
      // `message` can be validation errors, e.g. {base: ["You do not have sufficient permission ..."]}
      const message = responseData.message || responseData.error;
      throw new Error(
        typeof message === "string"
          ? message
          : message
            ? Object.values(message)
                .flat()
                .map((m) => (typeof m === "string" ? m : JSON.stringify(m)))
                .join("; ")
            : `Pipeline creation failed: ${response.statusText}`
      );
    }

    logger.info("Pipeline created successfully", {
      pipelineId: responseData.id,
      pipelineProject: target.project,
      webUrl: responseData.web_url,
      status: responseData.status,
    });

    return responseData.id;
  } catch (error) {
    logger.error("Failed to create pipeline", {
      error: error instanceof Error ? error.message : error,
      projectId,
      ref,
      mrIid,
    });
    throw error;
  }
}

export async function cancelOldPipelines(
  projectId: number,
  keepPipelineId: number,
  ref: string
): Promise<void> {
  try {
    logger.debug("Fetching pipelines for cancellation", { projectId, ref });

    // List pipelines for the ref
    const target = await pipelineTarget(projectId, ref);
    let pipelines: Array<{ id: number }> = (
      await gitlab.Pipelines.all(target.project, {
        ref: target.ref,
        status: "pending",
      })
    ).filter((p: { id: number }) => p.id !== keepPipelineId);

    // The runner project's ref is shared by every target, so only its
    // pipelines for the same project and branch are "old" ones.
    if (runnerProject) {
      const sameTarget = await Promise.all(
        pipelines.map(async (p) => {
          const vars = await gitlab.Pipelines.allVariables(target.project, p.id);
          const value = (key: string) => vars.find((v) => v.key === key)?.value;
          return value("AI_PROJECT_ID") === String(projectId) && value("AI_BRANCH") === ref;
        })
      );
      pipelines = pipelines.filter((_, i) => sameTarget[i]);
    }

    // Cancel old pipelines
    const cancelPromises = pipelines
      .map((p: { id: number }) =>
        gitlab.Pipelines.cancel(target.project, p.id).catch((err: unknown) => {
          logger.warn(`Failed to cancel pipeline ${p.id}:`, {
            error: err instanceof Error ? err.message : err,
          });
        })
      );

    await Promise.all(cancelPromises);
    logger.info("Old pipelines cancelled", { count: cancelPromises.length });
  } catch (error) {
    logger.error("Error cancelling old pipelines:", {
      error: error instanceof Error ? error.message : error,
    });
    // Don't throw - this is not critical
  }
}

export async function addReactionToNote(params: {
  projectId: number;
  mrIid?: number;
  issueIid?: number;
  noteId: number;
  emoji?: string;
}): Promise<void> {
  const { projectId, mrIid, issueIid, noteId } = params;
  const emoji = params.emoji || process.env.START_REACTION_EMOJI || "robot";

  if (!noteId) {
    logger.warn("addReactionToNote called without noteId", {
      projectId,
      mrIid,
      issueIid,
    });
    return;
  }
  if (!mrIid && !issueIid) {
    logger.warn("addReactionToNote called without mrIid or issueIid", {
      projectId,
    });
    return;
  }
  try {
    const gitlabUrl = process.env.GITLAB_URL || "https://gitlab.com";
    const token = process.env.GITLAB_TOKEN!;

    const basePath = mrIid
      ? `/api/v4/projects/${projectId}/merge_requests/${mrIid}/notes/${noteId}/award_emoji`
      : `/api/v4/projects/${projectId}/issues/${issueIid}/notes/${noteId}/award_emoji`;

    logger.debug("Adding reaction to note", {
      projectId,
      mrIid,
      issueIid,
      noteId,
      emoji,
      url: `${gitlabUrl}${basePath}`,
    });

    const res = await fetch(`${gitlabUrl}${basePath}`, {
      method: "POST",
      headers: {
        "PRIVATE-TOKEN": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: emoji }),
    });

    if (!res.ok) {
      const text = await res.text();
      logger.warn("Failed to add reaction", {
        projectId,
        mrIid,
        issueIid,
        noteId,
        status: res.status,
        statusText: res.statusText,
        body: text,
      });
      return; // non-critical
    }

    logger.info("Reaction added to note", {
      projectId,
      mrIid,
      issueIid,
      noteId,
      emoji,
    });
  } catch (error) {
    logger.warn("Error adding reaction to note", {
      error: error instanceof Error ? error.message : error,
      projectId,
      mrIid,
      issueIid,
      noteId,
    });
  }
}

// Get project details including default branch
export async function getProject(projectId: number | string): Promise<{
  id: number;
  default_branch: string;
  path_with_namespace: string;
}> {
  try {
    logger.debug("Fetching project details", { projectId });
    const project = await gitlab.Projects.show(projectId);

    return {
      id: project.id,
      default_branch: project.default_branch || "main",
      path_with_namespace: project.path_with_namespace,
    };
  } catch (error) {
    logger.error("Failed to fetch project", {
      error: error instanceof Error ? error.message : error,
      projectId,
    });
    throw error;
  }
}

// Check if a branch exists
export async function branchExists(
  projectId: number,
  branchName: string
): Promise<boolean> {
  try {
    logger.debug("Checking branch existence", { projectId, branchName });
    await gitlab.Branches.show(projectId, branchName);
    return true;
  } catch (error: any) {
    // 404 means branch doesn't exist
    if (error.response?.statusCode === 404) {
      return false;
    }
    logger.error("Error checking branch", {
      error: error instanceof Error ? error.message : error,
      projectId,
      branchName,
    });
    throw error;
  }
}

// Create a new branch
export async function createBranch(
  projectId: number,
  branchName: string,
  ref: string
): Promise<void> {
  try {
    logger.info("Creating new branch", { projectId, branchName, ref });

    // Use raw API for better error handling
    const gitlabUrl = process.env.GITLAB_URL || "https://gitlab.com";
    const token = process.env.GITLAB_TOKEN!;

    const response = await fetch(
      `${gitlabUrl}/api/v4/projects/${projectId}/repository/branches`,
      {
        method: "POST",
        headers: {
          "PRIVATE-TOKEN": token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          branch: branchName,
          ref: ref,
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `Branch creation failed: ${response.statusText}`;

      try {
        const errorData = JSON.parse(errorText);
        errorMessage = errorData.message || errorMessage;
      } catch {
        // Use raw error text if not JSON
        errorMessage = errorText || errorMessage;
      }

      logger.error("Branch creation API error", {
        status: response.status,
        errorMessage,
        projectId,
        branchName,
        ref,
      });

      throw new Error(errorMessage);
    }

    logger.info("Branch created successfully", { projectId, branchName });
  } catch (error) {
    logger.error("Failed to create branch", {
      error: error instanceof Error ? error.message : error,
      projectId,
      branchName,
      ref,
    });
    throw error;
  }
}

// Sanitize branch name for GitLab
export function sanitizeBranchName(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-") // Replace non-alphanumeric chars with dashes
    .replace(/-+/g, "-") // Replace multiple dashes with single dash
    .replace(/^-|-$/g, "") // Remove leading/trailing dashes
    .substring(0, 50); // Limit length
}

// Fetch full discussion thread notes (excluding system notes unless includeSystem=true)
export async function getDiscussionThread(params: {
  projectId: number;
  mrIid?: number;
  issueIid?: number;
  discussionId: string;
  includeSystem?: boolean;
}): Promise<
  Array<{
    id: string | number;
    author: { username?: string; name?: string };
    body: string;
    created_at?: string;
    system?: boolean;
  }>
> {
  const { projectId, mrIid, issueIid, discussionId, includeSystem } = params;

  if (!mrIid && !issueIid) {
    logger.warn("getDiscussionThread called without mrIid or issueIid", {
      projectId,
      discussionId,
    });
    return [];
  }

  try {
    const gitlabUrl = process.env.GITLAB_URL || "https://gitlab.com";
    const token = process.env.GITLAB_TOKEN!;

    // Issues in GitLab have discussions endpoint, merge requests use a similar path
    const basePath = mrIid
      ? `/api/v4/projects/${projectId}/merge_requests/${mrIid}/discussions/${discussionId}`
      : `/api/v4/projects/${projectId}/issues/${issueIid}/discussions/${discussionId}`;

    const url = `${gitlabUrl}${basePath}`;
    logger.debug("Fetching discussion thread", { url });

    const res = await fetch(url, {
      headers: { "PRIVATE-TOKEN": token },
    });

    if (!res.ok) {
      const text = await res.text();
      logger.warn("Failed to fetch discussion thread", {
        status: res.status,
        statusText: res.statusText,
        text,
        projectId,
        mrIid,
        issueIid,
        discussionId,
      });
      return [];
    }

    const data: any = await res.json();
    const notes: any[] = data && Array.isArray(data.notes) ? data.notes : [];

    logger.info(`Fetched ${notes.length} notes in discussion thread`);

    return notes
      .slice(0, -1) // Exclude the newest (last) note
      .filter((n) => includeSystem || !n.system)
      .map((n) => ({
        id: n.id,
        author: {
          username: n.author?.username,
          name: n.author?.name,
        },
        body: n.body || "",
        created_at: n.created_at,
        system: n.system,
      }));
  } catch (error) {
    logger.warn("Error fetching discussion thread", {
      error: error instanceof Error ? error.message : error,
      projectId,
      mrIid,
      issueIid,
      discussionId,
    });
    return [];
  }
}

// Tells the user in GitLab why the agent didn't start: a reply in the
// triggering comment's thread, or a note on the MR/issue when there is no
// thread (reviewer/assignee triggers). Non-critical, like the reactions.
export async function postErrorNote(params: {
  projectId: number;
  mrIid?: number;
  issueIid?: number;
  discussionId?: string;
  error: unknown;
}): Promise<void> {
  const { projectId, mrIid, issueIid, discussionId } = params;
  if (!mrIid && !issueIid) return;

  const reason = (params.error instanceof Error ? params.error.message : String(params.error)).slice(0, 1000);
  const body = `:warning: The AI agent could not be started:\n\n\`\`\`\n${reason}\n\`\`\``;
  const resource = mrIid ? `merge_requests/${mrIid}` : `issues/${issueIid}`;
  const path = discussionId
    ? `/api/v4/projects/${projectId}/${resource}/discussions/${discussionId}/notes`
    : `/api/v4/projects/${projectId}/${resource}/notes`;

  try {
    const gitlabUrl = process.env.GITLAB_URL || "https://gitlab.com";
    const res = await fetch(`${gitlabUrl}${path}`, {
      method: "POST",
      headers: {
        "PRIVATE-TOKEN": process.env.GITLAB_TOKEN!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body }),
    });

    if (!res.ok) {
      logger.warn("Failed to post error note", {
        projectId,
        mrIid,
        issueIid,
        discussionId,
        status: res.status,
        body: await res.text(),
      });
      return;
    }
    logger.info("Error note posted", { projectId, mrIid, issueIid, discussionId });
  } catch (error) {
    logger.warn("Error posting error note", {
      error: error instanceof Error ? error.message : error,
      projectId,
      mrIid,
      issueIid,
    });
  }
}

// Award an emoji on the merge request itself (used when a review is triggered by assignment)
export async function addReactionToMergeRequest(params: {
  projectId: number;
  mrIid: number;
  emoji?: string;
}): Promise<void> {
  const { projectId, mrIid } = params;
  const emoji = params.emoji || process.env.START_REACTION_EMOJI || "robot";

  try {
    const gitlabUrl = process.env.GITLAB_URL || "https://gitlab.com";
    const token = process.env.GITLAB_TOKEN!;

    const res = await fetch(
      `${gitlabUrl}/api/v4/projects/${projectId}/merge_requests/${mrIid}/award_emoji`,
      {
        method: "POST",
        headers: {
          "PRIVATE-TOKEN": token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: emoji }),
      }
    );

    if (!res.ok) {
      // 404 "already awarded" and similar are non-critical
      logger.warn("Failed to add reaction to merge request", {
        projectId,
        mrIid,
        status: res.status,
        body: await res.text(),
      });
      return;
    }

    logger.info("Reaction added to merge request", { projectId, mrIid, emoji });
  } catch (error) {
    logger.warn("Error adding reaction to merge request", {
      error: error instanceof Error ? error.message : error,
      projectId,
      mrIid,
    });
  }
}
