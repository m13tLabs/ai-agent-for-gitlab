<p align="center">
  <img src="./docs/assets/logo.svg" width="128" alt="AI agent for GitLab logo">
</p>

[![Artifact Hub](https://img.shields.io/endpoint?url=https://artifacthub.io/badge/repository/ai-agent-for-gitlab)](https://artifacthub.io/packages/search?repo=ai-agent-for-gitlab)
[![Docker Pulls: gitlab-app](https://img.shields.io/docker/pulls/m13t/ai-agent-for-gitlab-app?logo=docker&label=gitlab-app%20pulls)](https://hub.docker.com/r/m13t/ai-agent-for-gitlab-app)
[![Docker Pulls: agent](https://img.shields.io/docker/pulls/m13t/ai-agent-for-gitlab-agent?logo=docker&label=agent%20pulls)](https://hub.docker.com/r/m13t/ai-agent-for-gitlab-agent)


# `@agent` on Gitlab

![Comments Showcase](./docs/assets/header.png)

This is a system that allows you to trigger an agent with the command @agent, which can then search, edit and commit your code, as well as post comments on your GitLab MR or issue.
The agent runs securely in your pipeline runner.

> This project was forked from [RealMikeChong](https://github.com/RealMikeChong/claude-code-for-gitlab). I used his gitlab webhook app and refactored the runner, added more documentation and added MCP & Opencode Support...
>
> This fork is based on [Schickli/ai-code-for-gitlab](https://github.com/Schickli/ai-code-for-gitlab) and adds merge request reviews on reviewer assignment (no GitLab Duo required) and a Helm chart for Kubernetes.

## Features

- Single webhook endpoint for all projects
- Triggers pipelines when `@ai` is mentioned in comments (or your custom @)
- Reviews merge requests when the AI service account is added as **reviewer** (or assignee) — a GitLab Duo Code Review alternative
- Helm chart for Kubernetes deployments
- Updates comment with progress (emoji reaction)
- Configurable rate limiting (or no rl at all)
- Works with personal access tokens (no OAuth required)
- Docker-ready deployment
- MCP Server Integration

## Quick Start

![Architecture](./docs/assets/architecture.png)

We need to set up a Webhook in GitLab, the GitLab Webhook App that receives events from GitLab, and a Pipeline that runs the agent.

### Comment Webhook

To receive comments from GitLab, you need to set up a webhook in your GitLab project. This webhook will send a POST request to the GitLab Webhook App whenever a comment is made.

Go to your GitLab project settings, then to the **Webhooks** section.  
Enter `https://your-server.com/webhook` as the URL (replace `your-server.com` with your actual server address).

> [!TIP]
> If you are developing locally, use `ngrok` or the built-in port forwarding from VS Code.

Set a secret token for the webhook (you will need to set this in your GitLab Webhook App).  

Add the **Comments** trigger for the webhook. To get reviews on reviewer assignment, also add the **Merge request events** trigger.

> [!TIP]
> Instead of configuring the webhook per project, you can add it once as a **group webhook** (Premium) or a **system hook** (self-managed admin) so all projects are covered.

### Merge Request Reviews on Assignment (GitLab Duo alternative)

Create a dedicated GitLab user (or service account / project/group bot), e.g. `review-agent`, and use its token as `GITLAB_TOKEN` and its username as `AI_GITLAB_USERNAME`. The account needs at least *Developer* access to the projects. On Kubernetes, the Helm chart can do all of this for you: see [Automated GitLab setup](#automated-gitlab-setup-optional).

> [!NOTE]
> GitLab reserves usernames starting with `ai-`, `ai_`, `duo-` and `duo_`, so pick a name like `review-agent`.

The webhook app then starts the agent in two ways:

| Trigger | Webhook event | What happens |
| --- | --- | --- |
| `@ai <prompt>` in an MR/issue comment | Comments | Agent runs the prompt and replies in the same thread |
| `review-agent` added as **reviewer** of an MR | Merge request events | Agent reviews the MR and posts a review comment |
| `review-agent` added as **assignee** of an MR | Merge request events | Same as reviewer (disable with `REVIEW_ON_ASSIGNEE=false`) |

Details:

- A review is only triggered when the AI user is **newly** added (on MR open/reopen or when reviewers/assignees change), so later pushes or title edits do not re-trigger it. Remove and re-add the reviewer to request another review.
- Only open MRs are reviewed; the bot ignores assignments it made itself; the rate limit applies per user/project/MR.
- The pipeline gets `AI_REVIEW=true`, so you can branch on it in `.gitlab-ci.yml` (e.g. a different `CUSTOM_AGENT_PROMPT`).
- The review instructions come from `REVIEW_PROMPT` (a sensible default is built in), combined with `OPENCODE_AGENT_PROMPT` and `CUSTOM_AGENT_PROMPT` as usual.

### GitLab Pipeline

The agent will run in the GitLab CI/CD environment. This is ideal because that way we already have an isolated environment with all necessary tools and permissions.  
For that, we use the `agent-image` Docker image. This provides the agent with the required dependencies for `C#` and `Node.js`, and the opencode CLI for multi-provider LLMs. You can easily customize the base image in `agent-image/Dockerfile`.

#### Build Agent Image

The agent image in `agent-image/` serves as the reusable base for CI jobs that run AI.

- Base image: `mcr.microsoft.com/dotnet/sdk:8.0` (official .NET 8 SDK, can be changed)
  - Node.js 24 LTS copied in from the official `node:24-bookworm-slim` image (can also be changed)
  - Published for `linux/amd64` and `linux/arm64`
- Includes git, curl, jq, opencode CLI, and the modular runner (`ai-runner`).

Build and publish the image to your registry of choice, or use the prebuilt one and reference it in CI via the `AI_AGENT_IMAGE` variable.

Then set in your GitLab CI/CD variables:

- `AI_AGENT_IMAGE=ghcr.io/m13tlabs/ai-agent-for-gitlab-agent:latest`

#### Create Pipeline

You will need to add the following CI/CD variables in your GitLab project (Settings → CI/CD → Variables):

- Provider API key(s) depending on which model you want to use via opencode. Common ones:
  - `OPENAI_API_KEY`
  - `ANTHROPIC_API_KEY`
  - `OPENROUTER_API_KEY`
  - `GROQ_API_KEY`
  - `TOGETHER_API_KEY`
  - `DEEPSEEK_API_KEY`
  - `FIREWORKS_API_KEY`
  - `CEREBRAS_API_KEY`
  - `Z_API_KEY`
  - Or Azure OpenAI envs: `AZURE_API_KEY`, `AZURE_RESOURCE_NAME`: Your Azure OpenAI resource name (e.g., `my-azure-openai`). `OPENCODE_MODEL` then needs to be `azure/{Deployment Name}`.
  - Or Bedrock envs: `AWS_ACCESS_KEY_ID` (or `AWS_PROFILE` / `AWS_BEARER_TOKEN_BEDROCK`)

- `GITLAB_TOKEN`: Your GitLab Personal Access Token (with `api`, `read_repository`, `write_repository` permissions)

> [!CAUTION]
> The variables should not be *protected variables*.  

Copy the `.gitlab-ci.yml` file in `gitlab-utils` to your project root, or add the important parts to your existing configuration. The pipelines variables can also be added. I strongly recommend adapting the existing Agent Prompt. With `CUSTOM_AGENT_PROMPT` you can set repository-specific instructions for the agent. But first look at the default prompt (in the gitlab-app).

### GitLab Webhook App

You can run the prebuilt image locally:

> When using it locally, you must expose your local port 3000 to the internet using either ngrok or the built-in port forwarding from VS Code. You must also change it in the webhook configuration.

Pull the image from the GitHub Container Registry:

```bash
docker pull ghcr.io/m13tlabs/ai-agent-for-gitlab-app:latest
````

> All configuration options can be seen in `.env.example` or the **Configuration** section.
> With this you only build the GitLab Webhook App.

#### Using Docker Compose

Run the following steps in the `gitlab-app` directory:

1. Copy `.env.example` to `.env` and configure:

   ```bash
   cp .env.example .env
   ```

2. Edit `.env` with your GitLab personal access token and all the other variables (or bot credentials with `api`, `read_repository`, `write_repository` permissions):

   ```env
   GITLAB_TOKEN=glpat-xxxxxxxxxxxxxxxxxxxx
   WEBHOOK_SECRET=your-webhook-secret-here
   ...
   ```

3. Deploy the application:

   ```bash
   docker-compose -f docker-compose.yml up -d
   ```

#### Using Kubernetes (Helm)

The chart in [`charts/ai-agent-for-gitlab`](./charts/ai-agent-for-gitlab) deploys the webhook app, optionally a small Redis for rate limiting, and an Ingress so GitLab can reach `/webhook`.

The agent itself does not run as a long-lived pod: it runs as a CI job on your GitLab runners (use the [GitLab Runner Kubernetes executor](https://docs.gitlab.com/runner/executors/kubernetes/) to run those jobs in the same cluster). The chart's `agentImage` value is forwarded to every triggered pipeline as `AI_AGENT_IMAGE`, so you can pin the agent image version for all projects in one place.

1. Create the secret (recommended over putting tokens in values):

   ```bash
   kubectl create namespace ai-agent
   kubectl -n ai-agent create secret generic ai-agent-secrets \
     --from-literal=GITLAB_TOKEN=glpat-xxxxxxxxxxxxxxxxxxxx \
     --from-literal=WEBHOOK_SECRET=$(openssl rand -hex 24) \
     --from-literal=ADMIN_TOKEN=$(openssl rand -hex 24)
   ```

2. Create a `values.yaml`:

   ```yaml
   gitlab:
     url: https://gitlab.company.com
     aiUsername: review-agent
     aiEmail: review-agent@company.com

   secrets:
     existingSecret: ai-agent-secrets

   agentImage:
     repository: m13t/ai-agent-for-gitlab-agent
     tag: "0.1.0"

   agent:
     model: anthropic/claude-sonnet-5
     prompt: |
       You are an assistant that fixes bugs and implements features ...

   ingress:
     enabled: true
     className: nginx
     annotations:
       cert-manager.io/cluster-issuer: letsencrypt
     hosts:
       - host: ai-agent.company.com
         paths:
           - path: /
             pathType: Prefix
     tls:
       - secretName: ai-agent-tls
         hosts: [ai-agent.company.com]
   ```

3. Install:

   ```bash
   helm upgrade --install ai-agent ./charts/ai-agent-for-gitlab -n ai-agent -f values.yaml
   ```

4. Point the GitLab webhook at `https://ai-agent.company.com/webhook` using the `WEBHOOK_SECRET` from step 1.

#### Automated GitLab setup (optional)

<img src="./docs/assets/bot-avatar.svg" width="64" align="right" alt="Bot avatar">

On self-managed GitLab, the chart can configure GitLab itself. Set `gitlabSetup.enabled: true` and give it a GitLab **administrator** token (scopes `api`, `admin_mode`) as `GITLAB_ADMIN_TOKEN` in the Secret (or `secrets.gitlabAdminToken`); `GITLAB_TOKEN` is then not needed. A Job runs on every install/upgrade, and a CronJob (hourly by default) keeps things in sync:

- **Bot account**: creates `gitlab.aiUsername` as a service account (`gitlabSetup.accountType: user` for GitLab versions without the service account API), named `gitlabSetup.botName`, with the bundled bot avatar.
- **Access everywhere**: adds the bot as *Developer* (`gitlabSetup.accessLevel`) to every top-level group, so subgroups and their projects inherit it. Groups created later are picked up by the CronJob. Limit it with `gitlabSetup.groups`.
- **System hook**: registers a system hook for merge request events pointing at the release's in-cluster Service. Set `gitlabSetup.systemHook.url` to the ingress URL when GitLab runs outside the cluster. Reviewer/assignee reviews then work on every project without per-project webhooks.
- **Bot token**: creates the bot's access token (`api` scope, 90 days) and stores it in the Secret `<release>-bot-token`, which the webhook pods use as `GITLAB_TOKEN`. It's rotated 14 days before expiry, and the pods are restarted to load it.

```yaml
gitlab:
  url: https://gitlab.company.com
  aiUsername: review-agent
  aiEmail: review-agent@company.com
secrets:
  existingSecret: ai-agent-secrets   # with GITLAB_ADMIN_TOKEN, WEBHOOK_SECRET, ADMIN_TOKEN
gitlabSetup:
  enabled: true
```

> [!IMPORTANT]
> System hooks can't send comment events, so `@ai` mentions still need a project or group webhook with **Comments** enabled. The CI jobs also still need `GITLAB_TOKEN` as a CI/CD variable (see [Create Pipeline](#create-pipeline)). The chart doesn't set an instance-wide variable, because every pipeline on the instance could read it.
>
> `helm uninstall` leaves the bot account, its group memberships, the system hook and the `<release>-bot-token` Secret in place.

Common chart values:

| Value | Default | Description |
| --- | --- | --- |
| `image.repository` / `image.tag` | `m13t/ai-agent-for-gitlab-app` / release version | Webhook app image; an empty tag falls back to appVersion |
| `agentImage.repository` / `agentImage.tag` | `m13t/ai-agent-for-gitlab-agent` / release version | Forwarded as `AI_AGENT_IMAGE=<repository>:<tag>`; an empty repository keeps each project's own |
| `gitlab.url`, `gitlab.aiUsername`, `gitlab.aiEmail` | `https://gitlab.com`, –, – | GitLab instance and AI service account (`aiUsername` is required) |
| `secrets.existingSecret` | `""` | Existing Secret with `GITLAB_TOKEN`, `WEBHOOK_SECRET`, `ADMIN_TOKEN` (key names configurable via `secrets.keys.*`) |
| `secrets.gitlabToken`, `secrets.webhookSecret`, `secrets.adminToken` | `""` | Used when no existing Secret is given; `adminToken` is generated if empty |
| `secrets.gitlabAdminToken` | `""` | GitLab admin token for `gitlabSetup` (only mounted into the setup Job/CronJob) |
| `gitlabSetup.enabled`, `.groups`, `.accessLevel`, `.systemHook.url`, `.schedule` | `false`, `[]`, `30`, in-cluster Service, hourly | [Automated GitLab setup](#automated-gitlab-setup-optional) |
| `agent.triggerPhrase`, `agent.model`, `agent.prompt` | `@ai`, `azure/gpt-4.1`, `""` | `TRIGGER_PHRASE`, `OPENCODE_MODEL`, `OPENCODE_AGENT_PROMPT` |
| `review.onAssignment`, `review.onAssignee`, `review.prompt` | `true`, `true`, `""` | Reviewer/assignee triggered reviews |
| `rateLimiting.enabled`, `.max`, `.window` | `true`, `3`, `900` | Rate limiting; when disabled no Redis is deployed |
| `redis.enabled`, `redis.externalUrl`, `redis.persistence.enabled` | `true`, `""`, `false` | Bundled Redis, or set `enabled: false` + `externalUrl` for a managed one |
| `ingress.*` | disabled | Standard Ingress settings |
| `extraEnv`, `extraEnvFrom` | `[]` | Any further environment variables for the webhook app |

See [`values.yaml`](./charts/ai-agent-for-gitlab/values.yaml) for all options.

> [!NOTE]
> `/admin/disable` and `/admin/enable` only switch the pod that serves the request. Keep `replicaCount: 1` (the default) if you rely on them.

## Configurations

### Environment Variables for the GitLab Webhook App (in `.env` or Docker build args)

- `GITLAB_URL`: GitLab instance URL (default: [https://gitlab.com](https://gitlab.com), e.g. [https://gitlab.company.com](https://gitlab.company.com))
- `WEBHOOK_SECRET`: Secret that you set in you Gitlab Webhook configuration
- `ADMIN_TOKEN`: Optional admin token for `/admin` endpoints
- `OPENCODE_AGENT_PROMPT`: The custom base prompt for the AI agent. (This appends to the Opencode system prompt and prepends the custom pipeline additions if set)

- `GITLAB_TOKEN`: Personal access token with `api` scope
- `AI_GITLAB_USERNAME`: The GitLab username for the AI user (of the account the Gitlab Token is from)
- `AI_GITLAB_EMAIL`: The GitLab email for the AI user (of the account the Gitlab Token is from)

- `PORT`: Server port (default: 3000)
- `CANCEL_OLD_PIPELINES`: Cancel older pending pipelines (default: true)
- `TRIGGER_PHRASE`: Custom trigger phrase instead of `@ai` (default: `@ai`)
- `BRANCH_PREFIX`: Prefix for branches created by AI (default: `ai`)
- `OPENCODE_MODEL`: The model used by opencode in `provider/model` (for azure its the deployment name) form (e.g., `azure/gpt-4.1`)
- `AI_AGENT_IMAGE`: Optional agent image forwarded to every triggered pipeline (overrides the value in `.gitlab-ci.yml`)
- `REVIEW_ON_ASSIGNMENT`: Review MRs when `AI_GITLAB_USERNAME` is added as reviewer (default: true, needs the *Merge request events* webhook trigger)
- `REVIEW_ON_ASSIGNEE`: Also review when the AI user is added as assignee (default: true)
- `REVIEW_PROMPT`: Custom instructions for assignment-triggered reviews (default: built-in review prompt)
- `START_REACTION_EMOJI`: Emoji awarded when a run starts (default: `robot`)
  
- `RATE_LIMITING_ENABLED`: Enable/disable rate limiting (default: true). If set to `false`, Redis is not used and not required.
- `REDIS_URL`: Redis connection URL
- `RATE_LIMIT_MAX`: Max requests per window (default: 3)
- `RATE_LIMIT_WINDOW`: Time window in seconds (default: 900)

### Pipeline Variables (`.gitlab-ci.yml`)

When a pipeline is triggered, these variables are available:

- `AI_AGENT_IMAGE`: The Docker image for the AI agent
- `CUSTOM_AGENT_PROMPT`: Repository-specific additions to the agent prompt. If set, it is appended to the base prompt defined in the webhook app.
- `AI_REVIEW`: Set to `true` when the run was triggered by a reviewer/assignee assignment instead of a comment.

### GitLab CI/CD Variables (Keys)

Set the appropriate `provider key(s)` for your chosen `OPENCODE_MODEL` as listed above, plus:

- `GITLAB_TOKEN`: Your GitLab Personal Access Token (with `api`, `read_repository`, `write_repository` permissions)

### Agent Prompt Configuration & Combination

1. Base Prompt: Set `OPENCODE_AGENT_PROMPT` in the webhook app.
2. Pipeline Additions (optional): Define a `CUSTOM_AGENT_PROMPT` variable directly in `.gitlab-ci.yml` or via CI/CD variables. If present, it will be appended to the base prompt.
3. Combination: When both exist they are merged.

> [!TIP]
> Keep the base/system behavior prompt in the webhook app and use the pipeline addition only for small repository specific instructions.

### Admin Endpoints

- `GET /health` — Health check
- `GET /admin/disable` — Disable bot (requires `ADMIN_TOKEN` token)
- `GET /admin/enable` — Enable bot (requires `ADMIN_TOKEN` token)

## Branch Creation Behavior

When AI is triggered from a GitLab issue comment:

1. **Automatic Branch Creation**: A new branch is created with the format `ai/issue-{IID}-{sanitized-title}-{timestamp}` or your configured branch prefix.
2. **Unique Branch Names**: Timestamps ensure each branch is unique, preventing conflicts.
3. **No Main Branch Execution**: If branch creation fails, the webhook returns an error. AI will **never** execute on the main/default branch.
4. **Merge Request Source**: For existing merge requests, AI uses the MR's source branch.

This ensures that:

- Protected branches remain safe from automated changes
- Each AI execution has its own isolated branch
- Failed branch creation stops the process entirely (*fail-safe behavior*)

## Roadmap

- [x] Create/Move to agent image to streamline the pipeline configuration
- [x] Move to `opencode`
- [x] Move "In Procress..." comment to the gitlab-app to provide faster feedback
- [x] Show agent working in the pipeline logs
- [x] Refactor the runner to be more modular (So that other tools can be added more easily)
- [x] Try moving the comment and commiting logic to a agent tool (Enables custom commit messaages, better comments)
- [x] Cleanup `@ai` configuration (So that its not needed in both configurations)
- [x] Create the pipeline on the merge request if the comment is on a merge request
- [x] Add option to disable ratelimiting (removes redis dependency)
- [x] Add comment thread as context (So that the agent can see the full discussion)
- [ ] Add a new tool to get the Jira ticket description and comments (So that the agent can see the full ticket)
- [ ] Provide configuration for the MCP Servers (So that other MCP Servers can be added more easily)
- [ ] Add the Sonar MCP Server
- [x] Trigger a review when the AI user is requested as MR reviewer/assignee
- [x] Helm chart for Kubernetes deployments
- [ ] Evaluate the change to listen on mentioned events instead of all comments
- [ ] Add cost to the comment (So that the user knows how much it costed)
