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
import type { Env } from "../src/types.ts";

// Configuration interface
export interface GitLabConfig {
  serverUrl: string;
  gitlabToken: string;
  projectId: string;
  resourceId: string;
  resourceType: "issue" | "merge_request";
  discussionId?: string; // if present for MR, reply in same discussion
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
}

// Schema definitions
const CreateCommentSchema = z.object({
  message: z.string().min(1).max(10000).describe("Comment message"),
});

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
      return {
        tools: [
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
            name: "get_current_gitlab_resource",
            description:
              "Get details of the current GitLab issue or merge request",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        ],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        if (name === "create_gitlab_comment") {
          const parsed = CreateCommentSchema.parse(args);
          return await this.createComment(parsed);
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
