import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import {
  triggerPipeline,
  cancelOldPipelines,
  getProject,
  createBranch,
  sanitizeBranchName,
  addReactionToNote,
  addReactionToMergeRequest,
  getDiscussionThread,
} from "./gitlab";
import { limitByUser } from "./limiter";
import { logger } from "./logger";
import type {
  GitLabUserRef,
  MergeRequestHookPayload,
  WebhookPayload,
} from "./types";

const app = new Hono();

// Enforce size limit for CI variable safety
const MAX_PROMPT_CHARS = 8000;

const DEFAULT_REVIEW_PROMPT =
  "You have been requested to review this merge request. Use the context tool to read the MR and its diff against the target branch. " +
  "Post a single review comment covering correctness bugs, security issues, missing tests and notable maintainability concerns, " +
  "each with file/line references and a concrete suggestion. Do not commit or push any changes unless explicitly asked.";

// Variables shared by every AI pipeline, independent of the trigger type
function commonPipelineVariables(triggerPhrase: string): Record<string, string> {
  const variables: Record<string, string> = {
    AI_TRIGGER: "true",
    AI_GITLAB_EMAIL: process.env.AI_GITLAB_EMAIL || "",
    AI_GITLAB_USERNAME: process.env.AI_GITLAB_USERNAME || "",
    OPENCODE_MODEL: process.env.OPENCODE_MODEL || "azure/gpt-4.1",
    OPENCODE_AGENT_PROMPT: process.env.OPENCODE_AGENT_PROMPT || "",
    TRIGGER_PHRASE: triggerPhrase,
  };

  // Pipeline variables take precedence over .gitlab-ci.yml, so this pins the agent image centrally
  if (process.env.AI_AGENT_IMAGE) {
    variables.AI_AGENT_IMAGE = process.env.AI_AGENT_IMAGE;
  }

  return variables;
}

function truncatePrompt(prompt: string): string {
  if (prompt.length <= MAX_PROMPT_CHARS) return prompt;
  logger.warn("Aggregated prompt truncated", {
    original: prompt.length,
    max: MAX_PROMPT_CHARS,
  });
  return prompt.slice(0, MAX_PROMPT_CHARS) + "\n...[truncated]";
}

function includesUser(users: GitLabUserRef[] | undefined, username: string) {
  return !!users?.some((u) => u.username === username);
}

// True if the AI user was newly requested as reviewer/assignee by this event
function aiUserNewlyRequested(
  body: MergeRequestHookPayload,
  aiUsername: string
): boolean {
  const action = body.object_attributes?.action;
  const watchAssignees = process.env.REVIEW_ON_ASSIGNEE !== "false";

  if (action === "open" || action === "reopen") {
    return (
      includesUser(body.reviewers, aiUsername) ||
      (watchAssignees && includesUser(body.assignees, aiUsername))
    );
  }

  if (action !== "update") return false;

  const added = (change?: {
    previous?: GitLabUserRef[];
    current?: GitLabUserRef[];
  }) =>
    !!change &&
    includesUser(change.current, aiUsername) &&
    !includesUser(change.previous, aiUsername);

  return (
    added(body.changes?.reviewers) ||
    (watchAssignees && added(body.changes?.assignees))
  );
}

async function handleMergeRequestHook(body: MergeRequestHookPayload) {
  const aiUsername = process.env.AI_GITLAB_USERNAME;
  const mr = body.object_attributes;
  const projectId = body.project?.id;
  const authorUsername = body.user?.username;

  if (process.env.REVIEW_ON_ASSIGNMENT === "false") {
    return { status: 200, body: "review-on-assignment-disabled" };
  }

  if (!aiUsername) {
    logger.warn("AI_GITLAB_USERNAME not set, cannot detect reviewer assignment");
    return { status: 200, body: "skipped" };
  }

  if (!mr || mr.state !== "opened" || !aiUserNewlyRequested(body, aiUsername)) {
    logger.debug("AI user not newly requested on merge request", {
      action: mr?.action,
      mrIid: mr?.iid,
    });
    return { status: 200, body: "skipped" };
  }

  if (process.env.AI_DISABLED === "true") {
    logger.warn("Bot is disabled, skipping review trigger");
    return { status: 200, body: "disabled" };
  }

  if (authorUsername === aiUsername) {
    logger.warn("Ignoring self-assigned review");
    return { status: 200, body: "self-trigger" };
  }

  const key = `${authorUsername}:${projectId}:${mr.iid}`;
  if (!(await limitByUser(key))) {
    logger.warn("Rate limit exceeded", { key, author: authorUsername });
    return { status: 200, body: "rate-limited" };
  }

  const triggerPhrase = process.env.TRIGGER_PHRASE || "@ai";
  const reviewPrompt = process.env.REVIEW_PROMPT || DEFAULT_REVIEW_PROMPT;
  const prompt = truncatePrompt(
    `${reviewPrompt}\n\n=== Merge Request !${mr.iid}: ${mr.title} ===\n` +
      `Source: ${mr.source_branch} -> Target: ${mr.target_branch}\n\n${
        mr.description || ""
      }`.trim()
  );

  const minimalPayload = {
    object_kind: body.object_kind,
    project: body.project,
    user: body.user,
    merge_request: { iid: mr.iid, title: mr.title, state: mr.state },
  };

  const variables = {
    ...commonPipelineVariables(triggerPhrase),
    AI_AUTHOR: authorUsername,
    AI_RESOURCE_TYPE: "merge_request",
    AI_RESOURCE_ID: String(mr.iid),
    AI_PROJECT_PATH: body.project.path_with_namespace,
    AI_BRANCH: mr.source_branch,
    AI_DISCUSSION_ID: "",
    AI_REVIEW: "true",
    DIRECT_PROMPT: prompt,
    GITLAB_WEBHOOK_PAYLOAD: JSON.stringify(minimalPayload),
  };

  logger.info("Review requested from AI user", {
    project: body.project.path_with_namespace,
    mrIid: mr.iid,
    requestedBy: authorUsername,
  });

  const pipelineId = await triggerPipeline(
    projectId,
    mr.source_branch,
    variables,
    mr.iid
  );

  await addReactionToMergeRequest({ projectId, mrIid: mr.iid });

  if (process.env.CANCEL_OLD_PIPELINES === "true") {
    await cancelOldPipelines(projectId, pipelineId, mr.source_branch);
  }

  return {
    status: 200,
    body: { status: "started", pipelineId, branch: mr.source_branch },
  };
}

// Log all requests
app.use("*", async (c, next) => {
  const start = Date.now();
  const method = c.req.method;
  const path = c.req.path;

  logger.info(`${method} ${path}`, {
    method,
    path,
    headers: logger.maskSensitive(Object.fromEntries(c.req.raw.headers)),
  });

  await next();

  const duration = Date.now() - start;

  const status = c.res.status;

  logger.info(`${method} ${path} ${status} ${duration}ms`, {
    method,
    path,
    status,
    duration,
  });
});
app.get("/health", (c) => c.text("ok"));

// Optional admin endpoint to disable bot
app.get(
  "/admin/disable",
  bearerAuth({ token: process.env.ADMIN_TOKEN! }),
  (c) => {
    process.env.AI_DISABLED = "true";
    logger.warn("Bot disabled via admin endpoint");
    return c.text("disabled");
  }
);

app.get(
  "/admin/enable",
  bearerAuth({ token: process.env.ADMIN_TOKEN! }),
  (c) => {
    process.env.AI_DISABLED = "false";
    logger.info("Bot enabled via admin endpoint");
    return c.text("enabled");
  }
);

// Single webhook endpoint for all projects
app.post("/webhook", async (c) => {
  const gitlabEvent = c.req.header("x-gitlab-event");
  const gitlabToken = c.req.header("x-gitlab-token");

  logger.debug("Webhook received", {
    event: gitlabEvent,
    hasToken: !!gitlabToken,
  });

  // Verify webhook secret
  if (gitlabToken !== process.env.WEBHOOK_SECRET) {
    logger.warn("Webhook unauthorized - invalid token");
    return c.text("unauthorized", 401);
  }

  // Merge request events trigger a review when the AI user is requested as reviewer/assignee
  if (gitlabEvent === "Merge Request Hook") {
    const mrBody = await c.req.json<MergeRequestHookPayload>();
    try {
      const result = await handleMergeRequestHook(mrBody);
      return typeof result.body === "string"
        ? c.text(result.body, result.status as 200)
        : c.json(result.body, result.status as 200);
    } catch (error) {
      logger.error("Failed to trigger review pipeline", {
        error: error instanceof Error ? error.message : error,
        projectId: mrBody.project?.id,
        mrIid: mrBody.object_attributes?.iid,
      });
      return c.json({ error: "Failed to trigger pipeline" }, 500);
    }
  }

  // Otherwise only handle Note Hook events
  if (gitlabEvent !== "Note Hook") {
    logger.debug("Ignoring non-Note Hook event", { event: gitlabEvent });
    return c.text("ignored");
  }

  const body = await c.req.json<WebhookPayload>();

  // Log webhook payload (with sensitive data masked)
  logger.debug("Webhook payload received", {
    payload: logger.maskSensitive(body),
  });

  const note = body.object_attributes?.note || "";
  const projectId = body.project?.id;
  const projectPath = body.project?.path_with_namespace;
  const mrIid = body.merge_request?.iid;
  const issueIid = body.issue?.iid;
  const issueTitle = body.issue?.title;
  const authorUsername = body.user?.username;

  const discussionId = body.object_attributes?.discussion_id || "";
  // Get trigger phrase from environment or use default
  const triggerPhrase = process.env.TRIGGER_PHRASE || "@ai";
  const triggerRegex = new RegExp(
    `${triggerPhrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
    "i"
  );

  // Check for trigger phrase mention
  if (!triggerRegex.test(note)) {
    logger.debug(`No ${triggerPhrase} mention found in note`);
    return c.text("skipped");
  }

  if (process.env.AI_DISABLED === "true") {
    logger.warn("Bot is disabled, skipping trigger");
    return c.text("disabled");
  }

  // Enable when we have a dedicated bot user
  if (process.env.AI_GITLAB_USERNAME === authorUsername) {
    logger.warn("Ignoring self-triggered note");
    return c.text("self-trigger");
  }

  const resourceId = mrIid || issueIid || "general";
  const key = `${authorUsername}:${projectId}:${resourceId}`;

  if (!(await limitByUser(key))) {
    logger.warn("Rate limit exceeded", { key, author: authorUsername });

    return c.text("rate-limited");
  }

  logger.info(`${triggerPhrase} triggered`, {
    project: projectPath,
    author: authorUsername,
    resourceType: mrIid ? "merge_request" : issueIid ? "issue" : "unknown",
    resourceId: mrIid || issueIid,
  });

  // Determine branch ref
  let ref = body.merge_request?.source_branch;

  // For issues, create a branch
  if (issueIid && !mrIid) {
    try {
      // Get project details for default branch
      const project = await getProject(projectId);
      const defaultBranch = project.default_branch || "main";

      // Generate branch name with timestamp to ensure uniqueness
      const timestamp = Date.now();
      const branchName = `${
        process.env.BRANCH_PREFIX ?? "ai"
      }/issue-${issueIid}-${sanitizeBranchName(issueTitle || "")}-${timestamp}`;

      logger.info("Creating branch for issue", {
        issueIid,
        branchName,
        fromBranch: defaultBranch,
      });

      // Try to create the branch
      await createBranch(projectId, branchName, defaultBranch);
      ref = branchName;
    } catch (error) {
      logger.error("Failed to create branch for issue", {
        issueIid,
        error: error instanceof Error ? error.message : error,
      });

      // Don't fall back to main - fail the request
      return c.text("branch-creation-failed", 500);
    }
  } else if (!ref) {
    // For merge requests without a source branch, fail
    logger.error("No branch ref determined for merge request");
    return c.text("no-branch-ref", 400);
  }

  // Extract the prompt after the trigger phrase
  const promptMatch = note.match(
    new RegExp(
      `${triggerPhrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+(.*)`,
      "is"
    )
  );

  const directPrompt = promptMatch ? promptMatch[1].trim() : "";
  let aggregatedPrompt = directPrompt;

  // If we have a discussion id, attempt to fetch the whole thread and prepend it
  if (discussionId) {
    try {
      // Lazy import to avoid circular deps if any
      const threadNotes = await getDiscussionThread({
        projectId: projectId!,
        mrIid: mrIid ?? undefined,
        issueIid: issueIid ?? undefined,
        discussionId,
        includeSystem: true,
      });

      logger.info(`Using ${threadNotes.length} discussion thread notes`);

      if (threadNotes.length > 0) {
        const formatted = threadNotes
          .map((n) => {
            const author = n.author?.username || n.author?.name || "user";
            const created = n.created_at ? ` (${n.created_at})` : "";
            return `@${author}${created}:\n${n.body.trim()}`;
          })
          .join("\n\n---\n\n");

        aggregatedPrompt =
          `Conversation Thread (most recent first below separator):\n\n${formatted}\n\n=== User Prompt ===\n${directPrompt}`.trim();
      }
    } catch (err) {
      logger.warn("Failed to aggregate discussion thread", {
        error: err instanceof Error ? err.message : err,
        discussionId,
      });
    }
  }

  aggregatedPrompt = truncatePrompt(aggregatedPrompt);

  // Create minimal webhook payload for CI/CD variable (10KB limit)
  const minimalPayload = {
    object_kind: body.object_kind,
    project: body.project,
    user: body.user,
    object_attributes: body.object_attributes
      ? {
          note: body.object_attributes.note,
          noteable_type: body.object_attributes.noteable_type,
        }
      : undefined,
    merge_request: body.merge_request
      ? {
          iid: body.merge_request.iid,
          title: body.merge_request.title,
          state: body.merge_request.state,
        }
      : undefined,
    issue: body.issue
      ? {
          iid: body.issue.iid,
          title: body.issue.title,
          state: body.issue.state,
        }
      : undefined,
  };

  // Trigger pipeline with variables
  const variables = {
    ...commonPipelineVariables(triggerPhrase),
    AI_AUTHOR: authorUsername,
    AI_RESOURCE_TYPE: mrIid ? "merge_request" : "issue",
    AI_RESOURCE_ID: String(mrIid || issueIid || ""),
    AI_PROJECT_PATH: projectPath,
    AI_BRANCH: ref,
    AI_DISCUSSION_ID: discussionId,
    DIRECT_PROMPT: aggregatedPrompt,
    GITLAB_WEBHOOK_PAYLOAD: JSON.stringify(minimalPayload),
  };

  logger.info("Triggering pipeline", {
    projectId,
    ref,
    variables: logger.maskSensitive(variables),
  });

  try {
    const pipelineId = await triggerPipeline(
      projectId,
      ref,
      variables,
      mrIid ?? undefined
    );

    logger.info("Pipeline triggered successfully", {
      pipelineId,
      projectId,
      ref,
    });

    const triggeringNoteId = body.object_attributes?.id;
    if (triggeringNoteId) {
      await addReactionToNote({
        projectId,
        mrIid: mrIid ?? undefined,
        issueIid: issueIid ?? undefined,
        noteId: triggeringNoteId,
      });
    }

    // Cancel old pipelines if configured
    if (process.env.CANCEL_OLD_PIPELINES === "true") {
      await cancelOldPipelines(projectId, pipelineId, ref);
    }

    return c.json({ status: "started", pipelineId, branch: ref });
  } catch (error) {
    logger.error("Failed to trigger pipeline", {
      error: error instanceof Error ? error.message : error,
      projectId,
      ref,
    });
    return c.json({ error: "Failed to trigger pipeline" }, 500);
  }
});

const port = Number(process.env.PORT) || 3000;
logger.info(`GitLab AI Webhook Server starting on port ${port}`);

export default {
  port,
  fetch: app.fetch,
};
