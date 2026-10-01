<p align="center">
  <img src="./docs/assets/logo.svg" width="128" alt="AI agent for GitLab logo">
</p>

[![Artifact Hub](https://img.shields.io/endpoint?url=https://artifacthub.io/badge/repository/ai-agent-for-gitlab)](https://artifacthub.io/packages/helm/ai-agent-for-gitlab/ai-agent-for-gitlab)
[![Docker Pulls: gitlab-app](https://img.shields.io/docker/pulls/m13t/ai-agent-for-gitlab-app?logo=docker&label=gitlab-app%20pulls)](https://hub.docker.com/r/m13t/ai-agent-for-gitlab-app)
[![Docker Pulls: agent](https://img.shields.io/docker/pulls/m13t/ai-agent-for-gitlab-agent?logo=docker&label=agent%20pulls)](https://hub.docker.com/r/m13t/ai-agent-for-gitlab-agent)

# `@agent` on GitLab

![Comments Showcase](./docs/assets/header.png)

Mention `@ai` in a GitLab merge request or issue, or add the AI user as a reviewer, and an
agent searches, edits and commits your code and replies on GitLab. The agent runs inside your
own GitLab CI runners.

> Forked from [RealMikeChong/claude-code-for-gitlab](https://github.com/RealMikeChong/claude-code-for-gitlab)
> via [Schickli/ai-code-for-gitlab](https://github.com/Schickli/ai-code-for-gitlab). This fork
> adds merge request reviews on reviewer assignment (no GitLab Duo required), a central runner
> mode and a Helm chart that can set up GitLab for you.

## Features

- One webhook endpoint for all projects
- `@ai <prompt>` in MR and issue comments, `@ai review` for a review on demand
- MR reviews when the AI user is added as **reviewer** or assignee, a GitLab Duo Code Review
  alternative, with native GitLab code suggestions
- Multi-provider LLMs via [opencode](https://opencode.ai) (OpenAI, Anthropic, Azure, Bedrock, …)
  and a GitLab MCP server for the agent
- Per-project pipelines, or one central runner project that leaves your projects untouched
- Helm chart that can create the bot account, webhooks and runner project
- Optional rate limiting, works with personal access tokens or service accounts

## Overview

```mermaid
flowchart LR
    Dev([Developer]) -- "@ai comment /<br/>reviewer request" --> GL[GitLab]
    GL -- "webhook /<br/>system hook" --> App["Webhook app<br/>(gitlab-app)"]
    App -- "react, trigger pipeline<br/>(AI_TRIGGER=true)" --> GL
    GL -- "runs CI job" --> Agent["Agent job<br/>(agent-image + opencode)"]
    Agent <--> LLM[(LLM provider)]
    Agent -- "commits, comments,<br/>code suggestions" --> GL
```

| Trigger | Webhook event | What happens |
| --- | --- | --- |
| `@ai <prompt>` in an MR/issue comment | Comments | Agent runs the prompt and replies in the same thread |
| `@ai /review [aspect]` in an MR comment | Comments | Agent reviews the MR, optionally focused on one aspect, see [Review commands](#review-commands) |
| `review-agent` added as **reviewer** of an MR | Merge request events | Agent reviews the MR and posts a review comment |
| `review-agent` added as **assignee** of an MR | Merge request events | Same as reviewer (disable with `REVIEW_ON_ASSIGNEE=false`) |

The agent never runs on the default branch: issue comments get a new `ai/issue-…` branch, MR
comments use the MR's source branch. Earlier findings of the agent on the same MR are not
posted again.

## Quick start (Kubernetes)

### Review commands

Slash commands after the trigger phrase, modeled on GitLab quick actions:

| Command | What it does |
| --- | --- |
| `@ai /review` | General review: correctness, security, tests, maintainability (same as a reviewer assignment) |
| `@ai /review security` | Security vulnerabilities and secure coding practices |
| `@ai /review performance` | Slow or resource-heavy code |
| `@ai /review scalability` | How the code copes with growing usage and data |
| `@ai /review codeorg` | Readability, maintainability and code organization |
| `@ai /review codeoptimize` | Opportunities to make the code more efficient |
| `@ai /help` | Replies with this list (no pipeline) |

- Aspects can be combined: `@ai /review security performance`.
- Reviews post code suggestions inline on the diff by default. `@ai /review #inline_comment=False` puts the whole review into a single comment instead; the agent then doesn't get the code suggestion tool at all.
- Lines after the command line are passed on as extra instructions:

  ```text
  @ai /review security
  Pay special attention to the new OAuth callback.
  ```

- The command must follow the trigger phrase directly (`@ai please /review` is a regular prompt). An unknown command, aspect or option gets a reply with the list above; `/review` on an issue gets a reply that it works on merge requests only.
- The pipeline gets `AI_REVIEW=true` like an assignment review, plus `AI_REVIEW_INLINE=false` with `#inline_comment=False`.

> [!NOTE]
> GitLab's `/` autocomplete only lists GitLab's own quick actions, so it can't offer these commands. The bot user does show up in `@` autocomplete when it's a project member. To insert a command with a click, use [comment templates](https://docs.gitlab.com/user/profile/comment_templates/) from the editor toolbar:
>
> - **Premium/Ultimate with the Helm chart's `gitlabSetup`:** the setup Job maintains group templates `AI agent: review`, `AI agent: review security`, ..., `AI agent: help` on the top-level groups of `gitlabSetup.groups`, so every subgroup and project gets them (`gitlabSetup.commentTemplates.enabled`, on by default).
> - **Free/CE:** group and project templates don't exist there; each user can save the commands as personal templates (*Preferences > Comment templates*).

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
  - Or Bedrock envs: `AWS_ACCESS_KEY_ID` (or `AWS_PROFILE` / `AWS_BEARER_TOKEN_BEDROCK`), plus `AWS_REGION`. For an application inference profile, see [the Bedrock example](#example-amazon-bedrock-with-an-application-inference-profile).

- `GITLAB_TOKEN`: Your GitLab Personal Access Token (with `api`, `read_repository`, `write_repository` permissions)

> [!CAUTION]
> The variables should not be *protected variables*.  

Copy the `.gitlab-ci.yml` file in `gitlab-utils` to your project root, or add the important parts to your existing configuration. The pipelines variables can also be added. I strongly recommend adapting the existing Agent Prompt. With `CUSTOM_AGENT_PROMPT` you can set repository-specific instructions for the agent. But first look at the default prompt (in the gitlab-app).

#### Runner mode: one central runner project

The setup above needs a job in every project's `.gitlab-ci.yml`. In **runner mode**, all agent pipelines run in one dedicated project instead, and the other projects stay untouched:

| | Per-project mode (default) | Runner mode |
| --- | --- | --- |
| Where the agent pipeline runs | In the project where `@ai` was mentioned | In the runner project, e.g. `ai/agent-runner` |
| Changes to project `.gitlab-ci.yml` files | An `AI_TRIGGER` job in each project | None |
| `GITLAB_TOKEN` and provider keys | CI/CD variables per project or group | CI/CD variables on the runner project only (or injected by its runner) |
| Pipeline shows up on the MR | Yes | No, in the runner project; the agent still replies on the MR |
| Per-project `CUSTOM_AGENT_PROMPT` | Yes | No, one prompt for all projects (`custom-agent-prompt` input) |

```mermaid
sequenceDiagram
    autonumber
    actor Dev as Developer
    participant P as team-a/app<br/>(MR !3, branch feature)
    participant W as Webhook app
    participant R as ai/agent-runner
    participant J as Agent job<br/>(agent-runner component)
    participant LLM as LLM provider

    Dev->>P: Comment "@ai fix the failing test"
    P->>W: Note Hook
    W->>P: React to the comment
    W->>R: Create pipeline on main with AI_PROJECT_ID=team-a/app's id,<br/>AI_PROJECT_PATH=team-a/app, AI_BRANCH=feature, DIRECT_PROMPT, ...
    W->>R: Cancel older pending pipelines for the same project + branch
    R->>J: Start ai_webhook_handler
    J->>P: Clone team-a/app, check out feature (GITLAB_TOKEN)
    J->>LLM: Run opencode with the prompt
    J->>P: Push commits to feature
    J->>P: Reply in the comment thread
```

The webhook app only switches the target: with `AI_RUNNER_PROJECT` set, it creates the pipeline in the runner project (on `AI_RUNNER_REF`, default: its default branch) and adds the target as pipeline variables. The agent reads `AI_PROJECT_ID` and `AI_PROJECT_PATH` instead of the runner project's `CI_PROJECT_*` and clones the target itself, so the runner project's own files are never checked out.

Setup:

1. Create the runner project, e.g. `ai/agent-runner`, with this `.gitlab-ci.yml`. It includes the [`agent-runner` CI/CD component](templates/README.md) from [`templates/`](templates/agent-runner.yml):

   ```yaml
   include:
     - component: gitlab.com/m13tlabs/ai-agent-for-gitlab/agent-runner@<version>
       inputs:
         tags: [ai-agent]   # optional: a dedicated runner
   ```

   CI/CD components can only be included from a GitLab project. On a self-managed instance, mirror this repository into it and use `$CI_SERVER_FQDN/<group>/ai-agent-for-gitlab/agent-runner@<version>`.
2. Add `GITLAB_TOKEN` (or `GITLAB_AI_AGENT_TOKEN`, which wins) and the provider keys (see [Create Pipeline](#create-pipeline)) as CI/CD variables of the runner project, not protected. Or let a dedicated runner inject them from a Kubernetes Secret, and select it with the `tags` input.
3. Point the webhook app at it: `AI_RUNNER_PROJECT=ai/agent-runner` (chart: `agent.runnerProject`).

With the Helm chart's `gitlabSetup`, steps 1 and 3 are automated by `gitlabSetup.centralPipeline`:

```yaml
gitlabSetup:
  enabled: true
  centralPipeline:
    enabled: true
    component:
      project: ai/ai-agent-for-gitlab       # group "ai" must exist
      cloneUrl: https://github.com/m13tLabs/ai-agent-for-gitlab.git
      ref: ""                               # "" = the chart's release tag, v<appVersion>; or a branch/tag
    runner:
      project: ai/agent-runner
      inputs: {tags: [ai-agent]}            # optional component inputs
      extraIncludes:                        # optional, appended to `include:`
        - project: infra/jobs/gitlab-components/helpers
          ref: v1.0.0
          file: .gitlab-ci/include.yml
      extraConfig: |                        # optional top-level YAML, kept as is
        ai_webhook_handler:                 # = the component's job-name input: merged with the agent job
          extends: [.proxy_setup]
additionalEnvs:                             # only if the setup Job needs a proxy to reach cloneUrl
  - HTTPS_PROXY: "http://proxy.corp:3128"
  - NO_PROXY: ".svc,gitlab.corp"
```

- **Component project:** created empty, with a description that links to the source (credentials in the URL are left out), and made a CI/CD Catalog resource. On every run, the setup Job clones `cloneUrl` itself and pushes its branches and tags into the project, then sets the project's default branch to the source's. So only the Job needs access to the source; GitLab doesn't. The push is fast-forward only: a branch rewritten at the source, or changed directly in the component project, fails the setup Job instead of losing commits.
- **Pull mirror** (Premium or Ultimate): the setup Job detects the edition from `/api/v4/metadata` and the license, and logs it as `GitLab edition`. On Premium or Ultimate it also turns the project into a pull mirror of `cloneUrl` and starts a mirror update every run, so GitLab syncs between runs too. The mirror doesn't start pipelines, and diverged branches follow the source. It needs GitLab itself to reach `cloneUrl`; if it can't, the Job only logs a warning and its own sync carries on. `component.mirror: false` turns the mirror off.
- **Runner project:** created with a `.gitlab-ci.yml` that includes `$CI_SERVER_FQDN/<component project>/agent-runner@<ref>` with your `inputs` (as block YAML), and a README describing the setup. `<ref>` defaults to the chart's release tag `v<appVersion>`, e.g. `v0.7.1`, so the component matches the chart's images; a ref that isn't in the component project fails the setup Job. The setup Job keeps `.gitlab-ci.yml` in sync (edits there are overwritten) and creates the README only once. With `runner.initialSetupOnly: true` it also creates `.gitlab-ci.yml` only when it's missing and never updates it afterwards, so you can maintain it by hand after the first setup. Changes to `inputs`, `extraIncludes`, `extraConfig` or `component.ref` then no longer reach the project.
- **Logo:** both projects get the project logo as avatar while they have none, so a logo you set by hand stays. `centralPipeline.avatar: false` turns that off.
- **Bot:** becomes Owner of both projects, so it can run pipelines on the runner project's protected default branch.
- **Webhook:** `runner.project` is used as `agent.runnerProject` unless you set that yourself.
- **Timing:** the Job pushes the source before it sets up the runner project, so both are done in the same run. A source the Job can't clone fails the setup Job with git's error and a hint about `additionalEnvs`.
- **Bot token:** the setup Job adds the bot's token to the runner project as the masked CI/CD variable `GITLAB_AI_AGENT_TOKEN`, with a description saying so, and updates it whenever it rotates the token. The agent uses it before a `GITLAB_TOKEN`. It isn't protected, so a runner ref on an unprotected branch works too; Maintainers of the runner project can see it, so keep its membership small.
- **Still manual:** the provider keys from step 2.

Notes:

- The bot behind `GITLAB_TOKEN` needs Developer access to every target project. `gitlabSetup` grants it.
- The bot must also be allowed to run pipelines on the runner project's branch (`AI_RUNNER_REF`, default: its default branch). Otherwise GitLab answers `You do not have sufficient permission to run a pipeline on 'main'`. On a protected branch that takes Maintainer, or a push/merge rule that includes the bot. Alternatively, run on an unprotected branch such as `agent-runs`; with the chart that's `agent.runnerProject` plus `agent.runnerRef: agent-runs`. To have `gitlabSetup` add the membership, list the runner project under `gitlabSetup.projects`, e.g. `{path: ai/agent-runner, accessLevel: 40}`.
- The runner mode needs an agent image that reads `AI_PROJECT_ID`, i.e. from the same release as the webhook app. An older one would work on the runner project instead of the target.
- The component sets `workflow:` so that only the webhook's pipelines run, and turns GitLab's *auto-cancel redundant pipelines* off. All agent pipelines share one branch there, so auto-cancel would stop runs for other projects. The webhook app cancels only older runs for the same project and branch (`CANCEL_OLD_PIPELINES`).
- The pipeline variables in the runner project contain the prompts and discussion excerpts of every target project. Keep its membership small.

### GitLab Webhook App

You can run the prebuilt image locally:

> When using it locally, you must expose your local port 3000 to the internet using either ngrok or the built-in port forwarding from VS Code. You must also change it in the webhook configuration.

Pull the image from the GitHub Container Registry:

```bash
kubectl create namespace ai-agent
kubectl -n ai-agent create secret generic ai-agent-secrets \
  --from-literal=GITLAB_ADMIN_TOKEN=glpat-xxxxxxxxxxxxxxxxxxxx \
  --from-literal=ADMIN_TOKEN=$(openssl rand -hex 24)
```

```yaml
# values.yaml
gitlab:
  url: https://gitlab.company.com
  aiUsername: review-agent          # names starting with ai-/duo- are reserved
  aiEmail: review-agent@company.com
secrets:
  existingSecret: ai-agent-secrets   # with GITLAB_ADMIN_TOKEN, WEBHOOK_SECRET, ADMIN_TOKEN
gitlabSetup:
  enabled: true
```

`groups` and `projects` take full paths or glob patterns (`*`, `?`; case-insensitive, `*` also matches `/`), or objects with per-entry settings; the first matching entry wins, `[]` turns the step off. Groups and projects created later are picked up by the CronJob; archived projects and anything marked for deletion are skipped. Every run makes about three API calls per project, so narrow `projects` on large instances:

```yaml
gitlabSetup:
  groups: ["team-a"]
  projects:
    - "team-a/*"                # every project below team-a, incl. subgroups
    - path: other-group/app
      accessLevel: 40           # Maintainer here
      mergeRequestsEvents: true # also MR events via this project's webhook
```

> [!IMPORTANT]
> System hooks can't send comment events, so `@ai` mentions only work in projects matching `gitlabSetup.projects` (or with a manually added project/group webhook with **Comments** enabled). The CI jobs also still need `GITLAB_TOKEN` as a CI/CD variable (see [Create Pipeline](#create-pipeline)). The chart doesn't set an instance-wide variable, because every pipeline on the instance could read it.
>
> `helm uninstall` leaves the bot account, its memberships, the system hook, the project webhooks and the `<release>-bot-token` Secret in place.

Common chart values:

| Value | Default | Description |
| --- | --- | --- |
| `image.repository` / `image.tag` | `m13t/ai-agent-for-gitlab-app` / release version | Webhook app image; an empty tag falls back to appVersion |
| `agent.validateModel` | `true` | Init container that checks `agent.model` against the agent image's model catalog; an unknown model fails the rollout (`helm --wait` fails, the old pods keep running) and the log suggests the full ID, e.g. `…-sonnet-4-5` → `…-sonnet-4-5-20250929-v1:0`. Skipped without `agentImage.repository` |
| `agent.disableModelsFetch` | `false` | `OPENCODE_DISABLE_MODELS_FETCH` for the agent jobs: use the model catalog baked into the agent image (air-gapped runners) |
| `agent.runnerProject`, `agent.runnerRef` | `""`, `""` | [Central runner project](#runner-mode-one-central-runner-project) that runs every agent pipeline; empty = each project's own pipeline |
| `additionalEnvs` | `[]` | Environment variables for the webhook pods and the gitlabSetup Job/CronJob, e.g. an outbound proxy: `[{HTTPS_PROXY: "http://proxy:3128"}, {NO_PROXY: ".svc,gitlab.internal"}]` (a plain map works too). With `HTTP(S)_PROXY` set, the chart adds `NODE_USE_ENV_PROXY=1` (Node's `fetch` ignores proxy variables otherwise) and appends the Kubernetes API address to `NO_PROXY`. `NO_PROXY` takes host names, domain suffixes and IPs, but no CIDRs; list an internal GitLab there. Doesn't affect the agent CI jobs, which get their environment from the runner |
| `agentImage.repository` / `agentImage.tag` | `m13t/ai-agent-for-gitlab-agent` / release version | Forwarded as `AI_AGENT_IMAGE=<repository>:<tag>`; an empty repository keeps each project's own |
| `gitlab.url`, `gitlab.aiUsername`, `gitlab.aiEmail` | `https://gitlab.com`, –, – | GitLab instance and AI service account (`aiUsername` is required) |
| `secrets.existingSecret` | `""` | Existing Secret with `GITLAB_TOKEN`, `WEBHOOK_SECRET`, `ADMIN_TOKEN` (key names configurable via `secrets.keys.*`) |
| `secrets.gitlabToken`, `secrets.webhookSecret`, `secrets.adminToken` | `""` | Used when no existing Secret is given; `webhookSecret` and `adminToken` are generated if empty and kept across upgrades. With `gitlabSetup.enabled` the setup Job generates `webhookSecret` once into the `<fullname>-bot-token` Secret, which also works with Argo CD; otherwise set both explicitly with `helm template`/GitOps, where the chart can't read back the generated value |
| `secrets.gitlabAdminToken` | `""` | GitLab admin token for `gitlabSetup` (only mounted into the setup Job/CronJob) |
| `secrets.secretKeyRefs.<token>.name` / `.key` | `""` | Take a single token (`gitlabToken`, `webhookSecret`, `adminToken`, `gitlabAdminToken`) from another existing Secret, e.g. `gitlabToken: {name: gitlab-token, key: token}`; the chart Secret still holds the others. An empty `key` falls back to `secrets.keys.<token>` |
| `gitlabSetup.enabled`, `.groups`, `.projects`, `.accessLevel`, `.systemHook.url`, `.schedule` | `false`, `["*"]`, `["*"]`, `30`, in-cluster Service, hourly | [Automated GitLab setup](#automated-gitlab-setup-optional) |
| `agent.triggerPhrase`, `agent.model`, `agent.prompt` | `@<gitlab.aiUsername>` with `gitlabSetup.enabled`, else `@ai`; `azure/gpt-4.1`; `""` | `TRIGGER_PHRASE`, `OPENCODE_MODEL`, `OPENCODE_AGENT_PROMPT` |
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
- `AI_RUNNER_PROJECT`: Central project (full path or id) that runs every agent pipeline, see [Runner mode](#runner-mode-one-central-runner-project) (default: each project's own pipeline)
- `AI_RUNNER_REF`: Branch of the runner project to run on (default: its default branch)
- `OPENCODE_DISABLE_MODELS_FETCH`: `true` forwards it to every pipeline, so opencode in the agent job doesn't fetch its model catalog and uses the one baked into the agent image at build time; for air-gapped runners (default: false). Models released after the image build then need a newer agent image.
- `TRIGGER_PHRASE`: Custom trigger phrase instead of `@ai` (default: `@ai`)
- `BRANCH_PREFIX`: Prefix for branches created by AI (default: `ai`)
- `OPENCODE_MODEL`: The model used by opencode in `provider/model` (for azure its the deployment name) form (e.g., `azure/gpt-4.1`)
- `AI_AGENT_IMAGE`: Optional agent image forwarded to every triggered pipeline (overrides the value in `.gitlab-ci.yml`)
- `REVIEW_ON_ASSIGNMENT`: Review MRs when `AI_GITLAB_USERNAME` is added as reviewer (default: true, needs the *Merge request events* webhook trigger)
- `REVIEW_ON_ASSIGNEE`: Also review when the AI user is added as assignee (default: true)
- `REVIEW_PROMPT`: Custom base instructions for reviews, assignment-triggered and `/review` (default: built-in review prompt). The aspect focus and the inline/single-comment instruction are appended to it.
- `START_REACTION_EMOJI`: Emoji awarded when a run starts (default: `robot`)
  
- `RATE_LIMITING_ENABLED`: Enable/disable rate limiting (default: true). If set to `false`, Redis is not used and not required.
- `REDIS_URL`: Redis connection URL
- `RATE_LIMIT_MAX`: Max requests per window (default: 3)
- `RATE_LIMIT_WINDOW`: Time window in seconds (default: 900)

### Pipeline Variables (`.gitlab-ci.yml`)

When a pipeline is triggered, these variables are available:

- `AI_AGENT_IMAGE`: The Docker image for the AI agent
- `CUSTOM_AGENT_PROMPT`: Repository-specific additions to the agent prompt. If set, it is appended to the base prompt defined in the webhook app.
- `AI_REVIEW`: Set to `true` when the run is a review (reviewer/assignee assignment or `@ai /review`).
- `AI_REVIEW_INLINE`: `false` for `@ai /review #inline_comment=False`, unset otherwise.

### GitLab CI/CD Variables (Keys)

Set the appropriate `provider key(s)` for your chosen `OPENCODE_MODEL` as listed above, plus:

- `GITLAB_TOKEN`: Your GitLab Personal Access Token (with `api`, `read_repository`, `write_repository` permissions)

### Custom opencode configuration

The agent job runs opencode, which also reads an [opencode config](https://opencode.ai/docs/config/) (JSON with `//` comments). Your settings are merged with the GitLab MCP server the agent configures itself, so they don't replace it. There are three ways to pass one:

| Where | How | Scope |
| --- | --- | --- |
| CI/CD variable of type **File** named `OPENCODE_CONFIG` | the variable's content is the config; GitLab passes its path | runner project (runner mode), or group/project |
| `opencode.jsonc` or `.opencode/opencode.jsonc` in the target repository | committed to the repository | that repository |
| CI/CD or pipeline variable `OPENCODE_CONFIG_CONTENT` | the config itself | wherever the variable is defined |

Where settings conflict, the later source in this order wins: the agent's own config, `OPENCODE_CONFIG`, the repository's `opencode.jsonc`, `OPENCODE_CONFIG_CONTENT`. `{env:VAR}` inside a config is replaced by that environment variable, so secrets can stay in masked CI/CD variables.

#### Example: Amazon Bedrock with an application inference profile

This routes every request through one Bedrock application inference profile, e.g. for cost tracking, and hides all other models. In runner mode it goes into the Helm values:

```yaml
agent:
  model: anthropic/claude-sonnet-5
gitlabSetup:
  enabled: true                     # bot account, memberships, system + project hooks
  centralPipeline:
    enabled: true                   # one runner project for all agent pipelines,
                                    # ai/agent-runner (group "ai" must exist)
```

```bash
helm upgrade --install ai-agent oci://ghcr.io/m13tlabs/helm-charts/ai-agent-for-gitlab \
  -n ai-agent -f values.yaml
```

Then add your provider key (e.g. `ANTHROPIC_API_KEY`) as a masked, not protected CI/CD
variable of the runner project.

Running without Kubernetes, on gitlab.com, with per-project pipelines or with a custom
opencode config is covered in [USAGE.md](.github/USAGE.md).

## Documentation

- [.github/USAGE.md](.github/USAGE.md): manual setup, runner mode, automated GitLab setup
  and the configuration reference
- [.github/DEVELOPER.md](.github/DEVELOPER.md): how it works inside
- [charts/ai-agent-for-gitlab/README.md](charts/ai-agent-for-gitlab/README.md): all Helm values
- [templates/README.md](templates/README.md): the `agent-runner` CI/CD component
- [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md): building, testing and contributing

## Roadmap

- [ ] Jira tool for ticket description and comments
- [ ] Configuration for additional MCP servers (e.g. Sonar)
- [ ] Listen on mention events instead of all comments
- [ ] Show the run's cost in the comment
