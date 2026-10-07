// Everything the runner knows about the job, built from the CI variables the
// webhook app passes (see buildContext).
export interface Context {
  projectPath?: string;
  author?: string;
  resourceType?: string;
  resourceId?: string;
  discussionId?: string;
  prompt?: string;
  // Review run (reviewer/assignee request or a "<trigger> review" comment)
  review: boolean;
  triggerPhrase: string;
  branch?: string;
  email?: string;
  username?: string;
  opencodeModel?: string;
  agentPrompt: string;
  gitlabToken?: string;
  host: string;
  projectId?: string;
  serverUrl: string;
  checkoutDir: string;
}

export type Env = Record<string, string | undefined>;
