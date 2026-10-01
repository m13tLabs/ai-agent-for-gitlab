#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { commentEndpoint, gitlabApi } from "../src/gitlab.ts";
import {
  diffLines,
  fallbackBody,
  projectWebUrl,
  suggestionBody,
  type DiffRefs,
  type MergeRequestDiff,
} from "../src/suggestion.ts";
import type { Env } from "../src/types.ts";

// Configuration interface
export interface GitLabConfig {
  serverUrl: string;
  gitlabToken: string;
  projectId: string;
  resourceId: string;
  resourceType: "issue" | "merge_request";
  discussionId?: string; // if present for MR, reply in same discussion
  // false (`/review #inline_comment=False`): no code suggestion tool, so the
  // review goes into a single comment
  inlineSuggestions?: boolean;
}

// Fields the tools read from GitLab's issue / MR payloads.
interface GitLabResource {
  id: number;
  title: string;
  description: string | null;
  state: string;
  author: unknown;
  created_at: string;
  updated_at: string;
  web_url: string;
  source_branch?: string;
  target_branch?: string;
  merge_status?: string;
  diff_refs?: DiffRefs | null;
}

// Schema definitions
const CreateCommentSchema = z.object({
  message: z.string().min(1).max(10000).describe("Comment message"),
});

const CreateCodeSuggestionSchema = z
  .object({
    file_path: z.string().min(1),
    start_line: z.number().int().min(1),
    end_line: z.number().int().min(1).optional(),
    suggestion: z.string().max(10000),
    comment: z.string().max(10000).default(""),
  })
  .refine((a) => (a.end_line ?? a.start_line) >= a.start_line, {
    message: "end_line must not be before start_line",
  });

// Upper bound for GET .../diffs pages (100 files each).
const MAX_DIFF_PAGES = 30;

export class GitLabMCPServer {
  private server: Server;
  private config: GitLabConfig;

  constructor(config: GitLabConfig) {
    this.config = config;
    this.server = new Server(
      {
        name: "gitlab-mcp-server",
        version: "0.1.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = [
          {
            name: "create_gitlab_comment",
            description:
              "Create a comment on a GitLab for the current issue or merge request",
            inputSchema: {
              type: "object",
              properties: {
                message: {
                  type: "string",
                  description: "Comment message",
                },
              },
              required: ["message"],
              additionalProperties: false,
            },
          },
          {
            name: "create_gitlab_code_suggestion",
            description:
              "Merge requests only: post a code suggestion as a diff comment on the MR's changes, " +
              "rendered by GitLab as 'Suggested change' with an 'Apply suggestion' button. " +
              "Use it for every concrete fix instead of pasting code into a regular comment. " +
              "Lines are line numbers in the MR's source branch version of the file and must be part of the MR diff " +
              "(otherwise a regular comment with a link to the lines is posted instead). " +
              "Returns the URL of the posted comment.",
            inputSchema: {
              type: "object",
              properties: {
                file_path: {
                  type: "string",
                  description: "Path of the file in the repository, e.g. src/app.ts",
                },
                start_line: {
                  type: "integer",
                  description: "First line to replace (1-based, source branch version of the file)",
                },
                end_line: {
                  type: "integer",
                  description: "Last line to replace (inclusive); defaults to start_line",
                },
                suggestion: {
                  type: "string",
                  description:
                    "Replacement code for the whole line range, exactly as it should appear in the file " +
                    "(keep the indentation, no Markdown fences). Empty string deletes the lines.",
                },
                comment: {
                  type: "string",
                  description: "Short Markdown explanation shown above the suggestion",
                },
              },
              required: ["file_path", "start_line", "suggestion"],
              additionalProperties: false,
            },
          },
          {
            name: "get_current_gitlab_resource",
            description:
              "Get details of the current GitLab issue or merge request",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        ];
      return {
        tools: tools.filter(
          (t) => this.inlineSuggestions() || t.name !== "create_gitlab_code_suggestion"
        ),
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        if (name === "create_gitlab_comment") {
          const parsed = CreateCommentSchema.parse(args);
          return await this.createComment(parsed);
        } else if (name === "create_gitlab_code_suggestion" && this.inlineSuggestions()) {
          const parsed = CreateCodeSuggestionSchema.parse(args);
          return await this.createCodeSuggestion(parsed);
        } else if (name === "get_current_gitlab_resource") {
          return await this.getCurrentGitLabResource();
        } else {
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Invalid parameters: ${error.message}`
          );
        }
        throw error;
      }
    });
  }

  private async createComment(args: z.infer<typeof CreateCommentSchema>) {
    try {
      const endpoint = commentEndpoint(this.config);

      const response = await gitlabApi<{ id: number }>(this.config, "POST", endpoint, {
        body: args.message,
      });

      return {
        content: [
          {
            type: "text",
            text: `Successfully created comment on ${this.config.resourceType} #${this.config.resourceId}. Comment ID: ${response.id}`,
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to create comment: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  // Posts a diff discussion with a ```suggestion block anchored on end_line.
  // Falls back to a regular note with a permalink when the lines aren't part
  // of the MR diff or GitLab rejects the position.
  private async createCodeSuggestion(args: z.infer<typeof CreateCodeSuggestionSchema>) {
    if (this.config.resourceType !== "merge_request") {
      throw new McpError(ErrorCode.InvalidParams, "Code suggestions are only possible on merge requests");
    }
    const path = args.file_path.replace(/^\.?\//, "");
    const startLine = args.start_line;
    const endLine = args.end_line ?? startLine;
    const mrPath = `/projects/${this.config.projectId}/merge_requests/${this.config.resourceId}`;

    try {
      const mr = await gitlabApi<GitLabResource>(this.config, "GET", mrPath);
      const refs = mr.diff_refs;

      let fallbackReason = "the MR has no diff yet";
      if (refs) {
        const file = (await this.mergeRequestDiffs(mrPath)).find((d) => d.new_path === path);
        const anchor = file && !file.deleted_file ? diffLines(file.diff).get(endLine) : undefined;
        fallbackReason = !file
          ? `${path} is not changed in this MR`
          : `line ${endLine} of ${path} is not part of the MR diff`;

        if (file && anchor) {
          try {
            const discussion = await gitlabApi<{ notes: { id: number }[] }>(
              this.config,
              "POST",
              `${mrPath}/discussions`,
              {
                body: suggestionBody(args.comment, args.suggestion, startLine, endLine),
                position: {
                  position_type: "text",
                  base_sha: refs.base_sha,
                  start_sha: refs.start_sha,
                  head_sha: refs.head_sha,
                  old_path: file.old_path,
                  new_path: file.new_path,
                  new_line: anchor.newLine,
                  ...(anchor.oldLine !== undefined && { old_line: anchor.oldLine }),
                },
              },
            );
            return this.textResult(
              `Posted code suggestion on ${path}:${startLine}-${endLine}: ${mr.web_url}#note_${discussion.notes[0].id}`,
            );
          } catch (error) {
            fallbackReason = `GitLab rejected the diff position (${(error as Error).message})`;
          }
        }
      }

      const blobUrl = `${projectWebUrl(mr.web_url)}/-/blob/${refs?.head_sha ?? mr.source_branch}/${path
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`;
      const note = await gitlabApi<{ id: number }>(this.config, "POST", commentEndpoint(this.config), {
        body: fallbackBody(args.comment, args.suggestion, { url: blobUrl, path, startLine, endLine }),
      });
      return this.textResult(
        `Could not post an inline suggestion because ${fallbackReason}; posted a regular comment with a link to the lines instead: ${mr.web_url}#note_${note.id}`,
      );
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to create code suggestion: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async mergeRequestDiffs(mrPath: string): Promise<MergeRequestDiff[]> {
    const diffs: MergeRequestDiff[] = [];
    for (let page = 1; page <= MAX_DIFF_PAGES; page++) {
      const batch = await gitlabApi<MergeRequestDiff[]>(this.config, "GET", `${mrPath}/diffs?per_page=100&page=${page}`);
      diffs.push(...batch);
      if (batch.length < 100) break;
    }
    return diffs;
  }

  private inlineSuggestions(): boolean {
    return this.config.inlineSuggestions !== false;
  }

  private textResult(text: string) {
    return { content: [{ type: "text", text }] };
  }

  private async getCurrentGitLabResource() {
    try {
      const endpoint =
        this.config.resourceType === "issue"
          ? `/projects/${this.config.projectId}/issues/${this.config.resourceId}`
          : `/projects/${this.config.projectId}/merge_requests/${this.config.resourceId}`;

      const response = await gitlabApi<GitLabResource>(this.config, "GET", endpoint);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                id: response.id,
                title: response.title,
                description: response.description,
                state: response.state,
                author: response.author,
                created_at: response.created_at,
                updated_at: response.updated_at,
                web_url: response.web_url,
                ...(this.config.resourceType === "merge_request" && {
                  source_branch: response.source_branch,
                  target_branch: response.target_branch,
                  merge_status: response.merge_status,
                }),
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (error) {
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to get resource: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  async connect(transport: Transport) {
    await this.server.connect(transport);
  }

  async run() {
    await this.connect(new StdioServerTransport());
    console.error("GitLab MCP server running on stdio");
  }
}

export function configFromEnv(env: Env = process.env): GitLabConfig {
  return {
    serverUrl: env.CI_SERVER_URL || "https://gitlab.com",
    gitlabToken: env.GITLAB_TOKEN || "",
    projectId: env.CI_PROJECT_ID || "",
    resourceId: env.AI_RESOURCE_ID || env.CI_ISSUE_IID || "",
    resourceType: env.AI_RESOURCE_TYPE === "merge_request" ? "merge_request" : "issue",
    discussionId: env.AI_DISCUSSION_ID || undefined,
    inlineSuggestions: env.AI_REVIEW_INLINE !== "false",
  };
}

// Main execution
async function main() {
  const config = configFromEnv();

  if (!config.gitlabToken || !config.projectId) {
    console.error(
      "Error: GITLAB_TOKEN and CI_PROJECT_ID environment variables are required"
    );
    process.exit(1);
  }

  const server = new GitLabMCPServer(config);
  await server.run();
}

// Only run main if this file is executed directly
if (import.meta.main) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
