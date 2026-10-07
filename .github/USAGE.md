# Usage

How to deploy and configure the agent beyond the [README](../README.md) quick start. How it
works inside is in [DEVELOPER.md](DEVELOPER.md).

- [Manual setup](#manual-setup)
- [Runner mode: one central runner project](#runner-mode-one-central-runner-project)
- [Automated GitLab setup](#automated-gitlab-setup)
- [Configuration reference](#configuration-reference)

## Manual setup

Use this without Kubernetes, on gitlab.com, or when you don't want to give the chart an admin
token. Setup has three parts: the bot account, the webhook, and the pipeline that runs the
agent.

### Bot account

Create a dedicated GitLab user, service account or project/group bot, e.g. `review-agent`.
Its token (`api`, `read_repository`, `write_repository`) is `GITLAB_TOKEN`, its username
`AI_GITLAB_USERNAME`. It needs at least *Developer* access to the projects.

> [!NOTE]
> GitLab reserves usernames starting with `ai-`, `ai_`, `duo-` and `duo_`.

### Webhook

In the project's **Settings → Webhooks**, add `https://your-server.com/webhook` with a secret
token (the app's `WEBHOOK_SECRET`). Enable **Comments**, and **Merge request events** for
reviews on reviewer assignment. A **group webhook** (Premium) or a **system hook**
(self-managed admin) covers all projects at once. For local development, expose port 3000 with
`ngrok` or VS Code port forwarding.

### Agent pipeline (per-project mode)

The agent runs as a CI job using the agent image, which ships the .NET 8 SDK, Node.js 24, git,
curl, jq, opencode and `ai-runner` for `linux/amd64` and `linux/arm64`. Change the base image
in `agent-image/Dockerfile` if your projects need other toolchains.

1. Copy [`gitlab-utils/.gitlab-ci.yml`](../gitlab-utils/.gitlab-ci.yml) to the project root, or
   merge its `ai` stage into your pipeline. Only that stage may run when `AI_TRIGGER` is set.
2. Add these CI/CD variables (**not protected**) to the project or group:
   - `GITLAB_TOKEN` (see above)
   - Provider key(s) for your model, e.g. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
     `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `TOGETHER_API_KEY`, `DEEPSEEK_API_KEY`,
     `FIREWORKS_API_KEY`, `CEREBRAS_API_KEY`, `Z_API_KEY`
   - Azure OpenAI: `AZURE_API_KEY`, `AZURE_RESOURCE_NAME`; `OPENCODE_MODEL` is then
     `azure/<deployment name>`
   - Bedrock: `AWS_ACCESS_KEY_ID` (or `AWS_PROFILE` / `AWS_BEARER_TOKEN_BEDROCK`) plus
     `AWS_REGION`; see the [inference profile example](#example-amazon-bedrock-with-an-application-inference-profile)
   - Optionally `AI_AGENT_IMAGE=ghcr.io/m13tlabs/ai-agent-for-gitlab-agent:latest` and
     `CUSTOM_AGENT_PROMPT` for repository-specific instructions

### Webhook app

**Docker Compose**, in `gitlab-app/`:

```bash
cp .env.example .env    # set GITLAB_TOKEN, WEBHOOK_SECRET, ... (see the reference below)
docker-compose -f docker-compose.yml up -d
```

The prebuilt image is `ghcr.io/m13tlabs/ai-agent-for-gitlab-app:latest`.

**Helm** without automated setup:

```bash
kubectl -n ai-agent create secret generic ai-agent-secrets \
  --from-literal=GITLAB_TOKEN=glpat-xxxxxxxxxxxxxxxxxxxx \
  --from-literal=WEBHOOK_SECRET=$(openssl rand -hex 24) \
  --from-literal=ADMIN_TOKEN=$(openssl rand -hex 24)
```

```yaml
gitlab:
  url: https://gitlab.company.com
  aiUsername: review-agent
  aiEmail: review-agent@company.com
secrets:
  existingSecret: ai-agent-secrets
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
      paths: [{path: /, pathType: Prefix}]
  tls:
    - secretName: ai-agent-tls
      hosts: [ai-agent.company.com]
```

Install with `helm upgrade --install ai-agent oci://ghcr.io/m13tlabs/helm-charts/ai-agent-for-gitlab -n ai-agent -f values.yaml`
and point the GitLab webhook at `https://ai-agent.company.com/webhook`. The chart's
`agentImage` is forwarded to every pipeline as `AI_AGENT_IMAGE`, which pins the agent version
for all projects. Use the [GitLab Runner Kubernetes executor](https://docs.gitlab.com/runner/executors/kubernetes/)
to run the agent jobs in the same cluster.

## Runner mode: one central runner project

Per-project mode needs a job in every project's `.gitlab-ci.yml`. In runner mode, all agent
pipelines run in one dedicated project and the other projects stay untouched:

| | Per-project mode (default) | Runner mode |
| --- | --- | --- |
| Where the agent pipeline runs | In the project where `@ai` was mentioned | In the runner project, e.g. `ai/agent-runner` |
| Changes to project `.gitlab-ci.yml` files | An `AI_TRIGGER` job in each project | None |
| `GITLAB_TOKEN` and provider keys | CI/CD variables per project or group | On the runner project only (or injected by its runner) |
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

With `AI_RUNNER_PROJECT` set, the webhook app creates the pipeline in the runner project (on
`AI_RUNNER_REF`, default: its default branch) and passes the target as pipeline variables.
The agent reads `AI_PROJECT_ID` / `AI_PROJECT_PATH` instead of `CI_PROJECT_*` and clones the
target itself.

Manual setup:

1. Create the runner project, e.g. `ai/agent-runner`, with a `.gitlab-ci.yml` that includes the
   [`agent-runner` component](../templates/README.md):

   ```yaml
   include:
     - component: gitlab.com/m13tlabs/ai-agent-for-gitlab/agent-runner@<version>
       inputs:
         tags: [ai-agent]   # optional: a dedicated runner
   ```

   Components can only be included from a GitLab project. On self-managed GitLab, mirror this
   repository and use `$CI_SERVER_FQDN/<group>/ai-agent-for-gitlab/agent-runner@<version>`.
2. Add `GITLAB_TOKEN` (or `GITLAB_AI_AGENT_TOKEN`, which wins) and the provider keys as
   **not protected** CI/CD variables of the runner project, or let a dedicated runner inject
   them and select it with the `tags` input.
3. Set `AI_RUNNER_PROJECT=ai/agent-runner` on the webhook app (chart: `agent.runnerProject`).

Notes:

- The bot needs Developer access to every target project, and must be allowed to run
  pipelines on the runner project's branch. Otherwise GitLab answers
  `You do not have sufficient permission to run a pipeline on 'main'`. On a protected branch
  that takes Maintainer or a matching push/merge rule. Alternatively use an unprotected branch
  such as `agent-runs` (`agent.runnerRef`).
- The agent image must come from the same release as the webhook app. An older one doesn't
  read `AI_PROJECT_ID` and would work on the runner project instead.
- The component sets `workflow:` so only the webhook's pipelines run, and turns off GitLab's
  *auto-cancel redundant pipelines*: all agent pipelines share one branch, so auto-cancel
  would stop runs for other projects. The webhook app cancels only older runs for the same
  project and branch (`CANCEL_OLD_PIPELINES`).
- The runner project's pipeline variables contain prompts and discussion excerpts of every
  target project. Keep its membership small.

## Automated GitLab setup

<img src="../docs/assets/bot-avatar.svg" width="64" align="right" alt="Bot avatar">

On self-managed GitLab, `gitlabSetup.enabled: true` plus an admin token (`api`, `admin_mode`)
as `GITLAB_ADMIN_TOKEN` (or `secrets.gitlabAdminToken`) lets the chart configure GitLab.
`GITLAB_TOKEN` is then not needed. A Job runs on every install/upgrade and a CronJob (hourly)
keeps things in sync:

- **Bot account**: creates `gitlab.aiUsername` as a service account (`gitlabSetup.accountType: user`
  for GitLab versions without the service account API), named `gitlabSetup.botName`, with the
  bundled avatar.
- **Group access**: adds the bot as *Developer* (`gitlabSetup.accessLevel`) to groups matching
  `gitlabSetup.groups` (default `["*"]`). Subgroups whose selected parent already grants the
  role are skipped, so by default only top-level groups get a membership.
- **System hook**: for merge request events, pointing at the in-cluster Service. Set
  `gitlabSetup.systemHook.url` to the ingress URL when GitLab runs outside the cluster.
- **Project webhooks**: for projects matching `gitlabSetup.projects` (default `["*"]`), adds
  the bot as member (unless inherited) and a webhook with **Comments**, so `@ai` mentions work.
  It sends merge request events too only when the system hook is disabled.
- **Bot token**: creates the bot's token (`api`, 90 days), stores it in `<release>-bot-token`
  for the webhook pods, rotates it 14 days before expiry and restarts the pods.
- **Webhook secret**: generated once into the same Secret when none is given.
- **Central pipeline** (optional): see below.

`groups` and `projects` take full paths, glob patterns (`*`, `?`; case-insensitive, `*` also
matches `/`) or objects with per-entry settings. The first match wins, `[]` turns the step off.
New groups and projects are picked up by the CronJob; archived projects and anything marked
for deletion are skipped. Each run makes about three API calls per project, so narrow
`projects` on large instances:

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
> System hooks can't send comment events, so `@ai` mentions only work in projects matching
> `gitlabSetup.projects` (or with a manual webhook with **Comments**). In per-project mode the
> CI jobs still need `GITLAB_TOKEN` as a CI/CD variable; the chart doesn't set an
> instance-wide variable, because every pipeline on the instance could read it.
>
> `helm uninstall` leaves the bot account, its memberships, the hooks and the
> `<release>-bot-token` Secret in place.

### Central pipeline

`gitlabSetup.centralPipeline` automates runner mode steps 1 and 3:

```yaml
gitlabSetup:
  enabled: true
  centralPipeline:
    enabled: true
    component:
      project: ai/ai-agent-for-gitlab       # group "ai" must exist
      cloneUrl: https://github.com/m13tLabs/ai-agent-for-gitlab.git
      ref: ""                               # "" = the chart's release tag, v<appVersion>
    runner:
      project: ai/agent-runner
      inputs: {tags: [ai-agent]}            # optional component inputs
      extraIncludes:                        # optional, appended to `include:`
        - project: infra/jobs/gitlab-components/helpers
          ref: v1.0.0
          file: .gitlab-ci/include.yml
      extraConfig: |                        # optional top-level YAML, kept as is
        ai_webhook_handler:                 # = the component's job-name input
          extends: [.proxy_setup]
additionalEnvs:                             # only if the setup Job needs a proxy
  - HTTPS_PROXY: "http://proxy.corp:3128"
  - NO_PROXY: ".svc,gitlab.corp"
```

- **Component project**: created empty, made a CI/CD Catalog resource, and synced on every run:
  the Job clones `cloneUrl` and pushes branches and tags (fast-forward only), then sets the
  default branch. Only the Job needs access to the source. A branch rewritten at the source
  or changed in the component project fails the Job instead of losing commits.
- **Pull mirror** (Premium/Ultimate, detected and logged as `GitLab edition`): GitLab also
  pull-mirrors `cloneUrl` between runs, without triggering pipelines. If GitLab can't reach
  the source, the Job only warns. `component.mirror: false` turns it off.
- **Runner project**: gets a `.gitlab-ci.yml` including `agent-runner@<ref>` with your inputs
  (kept in sync, edits are overwritten) and a README (created once). `<ref>` defaults to
  `v<appVersion>`, matching the chart's images. `runner.initialSetupOnly: true` creates the
  `.gitlab-ci.yml` only when missing, so you can maintain it by hand afterwards.
- **Bot**: becomes Owner of both projects and its token is stored as the masked, not protected
  CI/CD variable `GITLAB_AI_AGENT_TOKEN` on the runner project, updated on every rotation.
  Maintainers of the runner project can see it.
- **Logo**: both projects get the project logo while they have no avatar
  (`centralPipeline.avatar: false` turns it off).
- `runner.project` is used as `agent.runnerProject` unless set. A source the Job can't clone
  fails it with git's error and a hint about `additionalEnvs`.
- **Still manual**: the provider keys.

## Configuration reference

### Common chart values

All values are in the [chart README](../charts/ai-agent-for-gitlab/README.md).

| Value | Default | Description |
| --- | --- | --- |
| `image.repository` / `image.tag` | `m13t/ai-agent-for-gitlab-app` / release version | Webhook app image |
| `agentImage.repository` / `agentImage.tag` | `m13t/ai-agent-for-gitlab-agent` / release version | Forwarded as `AI_AGENT_IMAGE`; an empty repository keeps each project's own |
| `gitlab.url`, `gitlab.aiUsername`, `gitlab.aiEmail` | `https://gitlab.com`, –, – | GitLab instance and AI account (`aiUsername` is required) |
| `agent.triggerPhrase`, `agent.model`, `agent.prompt` | `@<aiUsername>` with `gitlabSetup`, else `@ai`; `azure/gpt-4.1`; `""` | `TRIGGER_PHRASE`, `OPENCODE_MODEL`, `OPENCODE_AGENT_PROMPT` |
| `agent.validateModel` | `true` | Init container that checks `agent.model` against the agent image's model catalog; an unknown model fails the rollout and the log suggests the full ID |
| `agent.disableModelsFetch` | `false` | Use the model catalog baked into the agent image (air-gapped runners) |
| `agent.runnerProject`, `agent.runnerRef` | `""`, `""` | [Runner mode](#runner-mode-one-central-runner-project) |
| `review.onAssignment`, `review.onAssignee`, `review.prompt` | `true`, `true`, `""` | Reviewer/assignee reviews |
| `secrets.existingSecret` | `""` | Secret with `GITLAB_TOKEN`, `WEBHOOK_SECRET`, `ADMIN_TOKEN` (keys via `secrets.keys.*`) |
| `secrets.gitlabToken`, `.webhookSecret`, `.adminToken` | `""` | Used without an existing Secret; `webhookSecret` and `adminToken` are generated and kept across upgrades. With GitOps/`helm template` set them explicitly, unless `gitlabSetup` generates the webhook secret |
| `secrets.gitlabAdminToken` | `""` | Admin token for `gitlabSetup` (only mounted into the setup pods) |
| `secrets.secretKeyRefs.<token>.name` / `.key` | `""` | Take a single token from another Secret, e.g. `gitlabToken: {name: gitlab-token, key: token}` |
| `gitlabSetup.*` | disabled | [Automated GitLab setup](#automated-gitlab-setup) |
| `additionalEnvs` | `[]` | Env vars for the webhook and setup pods, e.g. a proxy. With `HTTP(S)_PROXY` the chart adds `NODE_USE_ENV_PROXY=1` and the Kubernetes API address to `NO_PROXY`. `NO_PROXY` takes hosts, suffixes and IPs, no CIDRs. Doesn't reach the agent CI jobs |
| `rateLimiting.enabled`, `.max`, `.window` | `true`, `3`, `900` | Rate limiting; when disabled no Redis is deployed |
| `redis.enabled`, `redis.externalUrl` | `true`, `""` | Bundled Redis, or `enabled: false` + `externalUrl` |
| `ingress.*` | disabled | Standard Ingress settings |
| `extraEnv`, `extraEnvFrom` | `[]` | Further env vars for the webhook app |

> [!NOTE]
> `/admin/disable` and `/admin/enable` only switch the pod serving the request. Keep
> `replicaCount: 1` if you rely on them.

### Webhook app environment

| Variable | Default | Description |
| --- | --- | --- |
| `GITLAB_URL` | `https://gitlab.com` | GitLab instance |
| `GITLAB_TOKEN` | – | Bot token (`api` scope) |
| `WEBHOOK_SECRET` | – | Secret token of the GitLab webhook; every webhook is rejected while unset |
| `ADMIN_TOKEN` | – | Bearer token for `/admin/*`; **required**, the app fails to start without it |
| `AI_GITLAB_USERNAME`, `AI_GITLAB_EMAIL` | – | The bot account |
| `TRIGGER_PHRASE` | `@ai` | Mention that triggers the agent |
| `OPENCODE_MODEL` | – | `provider/model`, e.g. `azure/gpt-4.1` (Azure: the deployment name) |
| `OPENCODE_AGENT_PROMPT` | built in | Base prompt, appended to opencode's system prompt |
| `REVIEW_ON_ASSIGNMENT` | `true` | Review when the bot becomes reviewer (needs *Merge request events*) |
| `REVIEW_ON_ASSIGNEE` | `true` | Also review when it becomes assignee |
| `REVIEW_PROMPT` | built in | Instructions for reviews |
| `AI_AGENT_IMAGE` | – | Agent image forwarded to every pipeline (overrides `.gitlab-ci.yml`) |
| `AI_RUNNER_PROJECT`, `AI_RUNNER_REF` | –, default branch | [Runner mode](#runner-mode-one-central-runner-project) |
| `OPENCODE_DISABLE_MODELS_FETCH` | `false` | Forwarded to pipelines: use the image's baked-in model catalog |
| `CANCEL_OLD_PIPELINES` | `true` | Cancel older pending pipelines for the same target |
| `BRANCH_PREFIX` | `ai` | Prefix for branches created from issues |
| `START_REACTION_EMOJI` | `robot` | Emoji awarded when a run starts |
| `RATE_LIMITING_ENABLED` | `true` | `false` removes the Redis dependency |
| `REDIS_URL`, `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW` | –, `3`, `900` | Rate limit per user/project/MR |
| `PORT` | `3000` | Server port |

Endpoints: `POST /webhook`, `GET /health`, `GET /admin/disable` and `GET /admin/enable`
(bearer `ADMIN_TOKEN`).

### Pipeline variables

Set by the webhook app on every triggered pipeline (trigger variables override
`.gitlab-ci.yml`): `AI_TRIGGER=true`, `AI_AGENT_IMAGE`, `AI_REVIEW=true` for reviews (branch
on it, e.g. for a different `CUSTOM_AGENT_PROMPT`), plus the target and prompt variables.
`CUSTOM_AGENT_PROMPT` in `.gitlab-ci.yml` or CI/CD variables is appended to the base prompt.
Keep general behavior in `OPENCODE_AGENT_PROMPT` and only repository specifics in
`CUSTOM_AGENT_PROMPT`. Reviews use `REVIEW_PROMPT` combined with both.

### Custom opencode configuration

The agent's own config (with the GitLab MCP server) is merged with an
[opencode config](https://opencode.ai/docs/config/) from, in increasing precedence:

| Where | How | Scope |
| --- | --- | --- |
| CI/CD variable of type **File** `OPENCODE_CONFIG` | the variable's content is the config | runner project, or group/project |
| `opencode.jsonc` or `.opencode/opencode.jsonc` | committed to the target repository | that repository |
| CI/CD or pipeline variable `OPENCODE_CONFIG_CONTENT` | the config itself | wherever it's defined |

`{env:VAR}` is replaced by that environment variable, so secrets can stay in masked variables.

#### Example: Amazon Bedrock with an application inference profile

Routes every request through one Bedrock application inference profile (e.g. for cost
tracking) and hides all other models. In runner mode, in the Helm values:

```yaml
agent:
  model: amazon-bedrock/anthropic.claude-opus-4-6-v1   # always provider/model

gitlabSetup:
  centralPipeline:
    runner:
      extraConfig: |
        variables:
          # ARN or ID of the application inference profile
          OPENCODE_MODEL_ID: arn:aws:bedrock:eu-central-1:123456789012:application-inference-profile/abc123
          OPENCODE_CONFIG_CONTENT: |
            {
              "$schema": "https://opencode.ai/config.json",
              "disabled_providers": ["opencode"], // only AWS Bedrock
              "autoupdate": false,
              "model": "{env:OPENCODE_MODEL}",
              "small_model": "{env:OPENCODE_MODEL}",
              "provider": {
                "amazon-bedrock": {
                  // the bare model ID, without "amazon-bedrock/"
                  "whitelist": ["anthropic.claude-opus-4-6-v1"],
                  "options": { "region": "eu-central-1" },
                  "models": {
                    "anthropic.claude-opus-4-6-v1": { "id": "{env:OPENCODE_MODEL_ID}" }
                  }
                }
              },
              "share": "disabled"
            }
```

- `model` / `small_model` take the full `provider/model` from `agent.model`. Set
  `small_model` too: opencode's default small model can sit in another region and fail with
  `Forbidden` where only EU inference is allowed.
- `whitelist` and the `models` key take the **bare** model ID. Using the catalog's own ID keeps
  opencode's known limits and lets `agent.validateModel` pass; an own alias needs
  `agent.validateModel: false`.
- `"id"` is what opencode sends to Bedrock, here the inference profile ARN.
- Use `|` for `OPENCODE_CONFIG_CONTENT`. With `>-`, lines can be joined and a `//` comment
  swallows the rest.
- Credentials: `AWS_BEARER_TOKEN_BEDROCK` (a long-term key; short-term ones expire within 12
  hours) and `AWS_REGION` as masked, not protected variables on the runner project. The
  identity needs `bedrock:InvokeModel` on the profile.
- Without runner mode, set `OPENCODE_MODEL_ID` and `OPENCODE_CONFIG_CONTENT` as CI/CD
  variables on the group or project.
