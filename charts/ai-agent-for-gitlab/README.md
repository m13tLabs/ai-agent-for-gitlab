# ai-agent-for-gitlab

![Version: 0.5.6](https://img.shields.io/badge/Version-0.5.6-informational?style=flat-square) ![Type: application](https://img.shields.io/badge/Type-application-informational?style=flat-square) ![AppVersion: 0.10.0](https://img.shields.io/badge/AppVersion-0.10.0-informational?style=flat-square)

GitLab webhook middleware that triggers AI agent pipelines on @ai mentions and when the AI user is requested as merge request reviewer/assignee.

**Homepage:** <https://github.com/m13tLabs/ai-agent-for-gitlab>

## Source Code

* <https://github.com/m13tLabs/ai-agent-for-gitlab>

## Values

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| additionalEnvs | list | `[]` | Environment variables for the webhook pods **and** the gitlabSetup Job/CronJob, e.g. an outbound proxy; a map or a list of maps (`[{HTTPS_PROXY: "http://proxy:3128"}, {NO_PROXY: ".svc,gitlab.internal"}]`). With HTTP(S)_PROXY set, NODE_USE_ENV_PROXY=1 is added (Node's fetch ignores the proxy otherwise) and the Kubernetes API address is appended to NO_PROXY. NO_PROXY takes host names, domain suffixes (`.svc`) and IPs, but no CIDRs. |
| affinity | object | `{}` |  |
| agent.branchPrefix | string | `"ai"` | Prefix for branches created for issues |
| agent.cancelOldPipelines | bool | `true` | Cancel older pending pipelines on the same ref |
| agent.disableModelsFetch | bool | `false` | Stop opencode in the agent jobs from fetching its model catalog (OPENCODE_DISABLE_MODELS_FETCH); it then uses the catalog baked into the agent image at build time. For air-gapped runners. |
| agent.model | string | `"azure/gpt-4.1"` | opencode model in provider/model form |
| agent.prompt | string | `""` | Base prompt for the agent (OPENCODE_AGENT_PROMPT) |
| agent.runnerProject | string | `""` | Central project (full path or id) that runs every agent pipeline, so the other projects need no .gitlab-ci.yml changes; see the agent-runner CI/CD component in templates/. Empty = run in each project's own pipeline. |
| agent.runnerRef | string | `""` | Branch of the runner project to run the pipelines on; empty = its default branch |
| agent.startReactionEmoji | string | `"robot"` | Emoji awarded when a run starts |
| agent.triggerPhrase | string | `""` | Mention that triggers the agent in comments. Empty = `@<gitlab.aiUsername>` when gitlabSetup.enabled (the account it creates), else `@ai`. |
| agent.validateModel | bool | `true` | Check `model` against the agent image's model catalog in an init container of the webhook pods; an unknown model fails the rollout. Needs `agentImage.repository`. Turn off for models newer than the agent image, or custom opencode providers. |
| agentImage | object | `{"repository":"m13t/ai-agent-for-gitlab-agent","tag":"0.10.0"}` | Image the CI job uses to run the agent, forwarded to pipelines as AI_AGENT_IMAGE=<repository>:<tag>. Pipeline variables override the default in .gitlab-ci.yml, so every project uses this image. Set repository to "" to keep each project's own AI_AGENT_IMAGE. |
| agentImage.tag | string | `"0.10.0"` | Set to the release version by each release (scripts/pin-release-version.sh). "" falls back to .Chart.AppVersion. |
| extraEnv | list | `[]` | Extra environment variables for the middleware container |
| extraEnvFrom | list | `[]` | Extra envFrom sources (e.g. a ConfigMap with OPENCODE_AGENT_PROMPT) |
| fullnameOverride | string | `""` |  |
| gitlab.aiEmail | string | `""` | Email of the AI service account (used for commits) |
| gitlab.aiUsername | string | `""` | Username of the AI service account the token belongs to (e.g. review-agent). GitLab reserves usernames starting with ai-, ai_, duo- and duo_. |
| gitlab.url | string | `"https://gitlab.com"` | GitLab instance URL |
| gitlabSetup.accessLevel | int | `30` | Default bot role in each group/project: 30 = Developer, 40 = Maintainer. Roles are only raised, never lowered. |
| gitlabSetup.accountType | string | `"service_account"` | "service_account" (instance service account) or "user" (regular user, for GitLab versions without the service account API) |
| gitlabSetup.avatar | bool | `true` | Upload the bundled bot avatar (files/bot-avatar.png) as the bot's avatar |
| gitlabSetup.botName | string | `"AI Agent"` | Display name of the bot account |
| gitlabSetup.centralPipeline.avatar | bool | `true` | Upload the project logo (files/project-avatar.png) as the avatar of both projects while they have none (a logo set by hand stays) |
| gitlabSetup.centralPipeline.component.cloneUrl | string | `"https://github.com/m13tLabs/ai-agent-for-gitlab.git"` | Git URL the component project is synced from. The setup Job clones it on every run and pushes its branches and tags into the component project (fast-forward only), so the Job needs access to it (a proxy goes into `additionalEnvs`), GitLab doesn't. A private source needs credentials in the URL; they're left out of descriptions and logs. |
| gitlabSetup.centralPipeline.component.mirror | bool | `true` | Additionally let GitLab pull-mirror `cloneUrl` between setup runs, where the edition supports it (detected from edition and license: Premium or Ultimate). Needs GitLab itself to reach `cloneUrl`; if it can't, the setup Job logs a warning and its own sync carries on. |
| gitlabSetup.centralPipeline.component.project | string | `"ai/ai-agent-for-gitlab"` | Full path of the component project; its group must exist |
| gitlabSetup.centralPipeline.component.ref | string | `""` | Ref of the component the runner project includes (branch, tag or SHA); empty = this chart's release tag, `v<appVersion>` (e.g. v0.7.1), which the component's `version` input also defaults to |
| gitlabSetup.centralPipeline.enabled | bool | `false` | Create and maintain the component and runner projects |
| gitlabSetup.centralPipeline.runner.extraConfig | string | `""` | Further top-level configuration for the runner project's .gitlab-ci.yml: a YAML string (kept as is) or a map. A job named like the component's `job-name` input is merged with the agent job, e.g. `{ai-review: {extends: [.proxy_setup]}}`. |
| gitlabSetup.centralPipeline.runner.extraIncludes | list | `[]` | Further `include:` entries after the component, e.g. `[{project: infra/helpers, ref: v1.0.0, file: .gitlab-ci/include.yml}]` |
| gitlabSetup.centralPipeline.runner.initialSetupOnly | bool | `false` | Only create the runner project's .gitlab-ci.yml when it's missing and never update it afterwards, e.g. to maintain it by hand after the first setup. The bot's Owner membership is still ensured. |
| gitlabSetup.centralPipeline.runner.inputs | object | `{}` | Inputs for the agent-runner component, e.g. `{tags: [ai-agent]}` |
| gitlabSetup.centralPipeline.runner.project | string | `"ai/agent-runner"` | Full path of the runner project; its group must exist |
| gitlabSetup.centralPipeline.visibility | string | `"private"` | Visibility of both projects (private, internal or public) |
| gitlabSetup.enabled | bool | `false` | Enable the automated GitLab setup (requires secrets.gitlabAdminToken) |
| gitlabSetup.groups | list | `["*"]` | Groups to add the bot to. Each entry is a full path or glob pattern (`*` and `?`, case-insensitive; `*` also matches `/`), or an object `{path: <pattern>, accessLevel: <role>}`; the first matching entry wins. A group is skipped when a selected ancestor already grants at least the same role, so `["*"]` = every group, but only top-level groups get a membership. `[]` = no groups. Groups marked for deletion are skipped. |
| gitlabSetup.projects | list | `["*"]` | Projects to add the bot to and give a project webhook (comment events, needed for @mentions). Same pattern rules as `groups`, matched against the project's full path; objects also take `mergeRequestsEvents` (default: true only when systemHook.enabled is false, since both hooks would trigger every review twice). `["*"]` = every project, `[]` = none. The bot membership is skipped when an inherited role is already high enough; archived projects and projects marked for deletion are skipped. Each CronJob run makes about three API calls per project, so narrow this on large instances, e.g. `["my-group/*", {path: "other/app", accessLevel: 40}]`. |
| gitlabSetup.resources.limits.memory | string | `"256Mi"` |  |
| gitlabSetup.resources.requests.cpu | string | `"10m"` |  |
| gitlabSetup.resources.requests.memory | string | `"64Mi"` |  |
| gitlabSetup.schedule | string | `"17 * * * *"` | CronJob schedule for re-syncing (new groups/projects, token rotation) |
| gitlabSetup.systemHook.enabled | bool | `true` | Register the merge request system hook |
| gitlabSetup.systemHook.sslVerification | bool | `true` | Verify TLS when GitLab calls the hook URL (system hook and project webhooks) |
| gitlabSetup.systemHook.url | string | `""` | URL GitLab posts to, for the system hook and the project webhooks; empty = this release's in-cluster Service (http://<fullname>.<namespace>.svc.cluster.local:<service.port>/webhook). Use the ingress URL when GitLab runs outside the cluster. |
| gitlabSetup.token.expiryDays | int | `90` | Lifetime of the bot token in days |
| gitlabSetup.token.renewBeforeDays | int | `14` | Rotate the bot token this many days before it expires |
| image.pullPolicy | string | `"IfNotPresent"` |  |
| image.repository | string | `"m13t/ai-agent-for-gitlab-app"` |  |
| image.tag | string | `"0.10.0"` | Set to the release version by each release (scripts/pin-release-version.sh). "" falls back to .Chart.AppVersion. |
| imagePullSecrets | list | `[]` |  |
| ingress.annotations | object | `{}` |  |
| ingress.className | string | `""` |  |
| ingress.enabled | bool | `false` |  |
| ingress.hosts[0].host | string | `"ai-agent.example.com"` |  |
| ingress.hosts[0].paths[0].path | string | `"/"` |  |
| ingress.hosts[0].paths[0].pathType | string | `"Prefix"` |  |
| ingress.tls | list | `[]` |  |
| logging.format | string | `"json"` |  |
| logging.level | string | `"info"` |  |
| nameOverride | string | `""` |  |
| nodeSelector | object | `{}` |  |
| podAnnotations | object | `{}` |  |
| podLabels | object | `{}` |  |
| podSecurityContext.fsGroup | int | `1001` |  |
| podSecurityContext.runAsGroup | int | `1001` |  |
| podSecurityContext.runAsNonRoot | bool | `true` |  |
| podSecurityContext.runAsUser | int | `1001` |  |
| podSecurityContext.seccompProfile.type | string | `"RuntimeDefault"` |  |
| rateLimiting.enabled | bool | `true` |  |
| rateLimiting.max | int | `3` | Max triggers per user/project/resource within the window |
| rateLimiting.window | int | `900` | Window in seconds |
| redis.enabled | bool | `true` |  |
| redis.externalUrl | string | `""` | Redis URL to use when redis.enabled is false (e.g. a managed Redis) |
| redis.image.pullPolicy | string | `"IfNotPresent"` |  |
| redis.image.repository | string | `"redis"` |  |
| redis.image.tag | string | `"8-alpine"` |  |
| redis.persistence.enabled | bool | `false` |  |
| redis.persistence.size | string | `"1Gi"` |  |
| redis.persistence.storageClass | string | `""` |  |
| redis.resources.limits.memory | string | `"128Mi"` |  |
| redis.resources.requests.cpu | string | `"10m"` |  |
| redis.resources.requests.memory | string | `"32Mi"` |  |
| replicaCount | int | `1` | Number of webhook middleware replicas. Note: /admin/disable and /admin/enable only affect the pod that serves the request, so keep this at 1 if you rely on the admin endpoints. |
| resources.limits.memory | string | `"256Mi"` |  |
| resources.requests.cpu | string | `"50m"` |  |
| resources.requests.memory | string | `"128Mi"` |  |
| review.onAssignee | bool | `true` | Also start a review when the AI user is added as assignee |
| review.onAssignment | bool | `true` | Start a review when the AI user is added as reviewer on a merge request    (requires the "Merge request events" trigger on the webhook) |
| review.prompt | string | `""` | Prompt used for assignment-triggered reviews (empty = built-in default) |
| secrets.adminToken | string | `""` | Bearer token for /admin endpoints. Generated (and kept across upgrades) when empty. |
| secrets.existingSecret | string | `""` | Name of an existing Secret; if set, no Secret is created by the chart |
| secrets.gitlabAdminToken | string | `""` | GitLab administrator token (scopes: api, admin_mode) for gitlabSetup. Only mounted into the setup Job/CronJob, never into the webhook pods. |
| secrets.gitlabToken | string | `""` | Token of the AI service account (scopes: api, read_repository, write_repository). Not used when gitlabSetup.enabled: the setup job creates and rotates the bot token. |
| secrets.keys | object | `{"adminToken":"ADMIN_TOKEN","gitlabAdminToken":"GITLAB_ADMIN_TOKEN","gitlabToken":"GITLAB_TOKEN","webhookSecret":"WEBHOOK_SECRET"}` | Keys inside the existing Secret |
| secrets.secretKeyRefs | object | `{"adminToken":{"key":"","name":""},"gitlabAdminToken":{"key":"","name":""},"gitlabToken":{"key":"","name":""},"webhookSecret":{"key":"","name":""}}` | Per-token references to other existing Secrets, e.g. `gitlabToken: {name: gitlab-token, key: token}`. A set `name` overrides existingSecret and the inline value for that token only; an empty `key` falls back to secrets.keys.<token>. The chart Secret still holds the rest. |
| secrets.webhookSecret | string | `""` | Secret token configured on the GitLab webhook. Generated when empty; read it from the Secret shown in the install notes. With gitlabSetup.enabled the setup Job generates it once and keeps it in the `<fullname>-bot-token` Secret, so it also survives Argo CD/`helm template` renders. Without gitlabSetup the chart generates it (kept across upgrades via `lookup`); set it explicitly with `helm template`/GitOps tools, where a generated value changes on every render. |
| securityContext.allowPrivilegeEscalation | bool | `false` |  |
| securityContext.capabilities.drop[0] | string | `"ALL"` |  |
| securityContext.readOnlyRootFilesystem | bool | `true` |  |
| service.port | int | `80` |  |
| service.type | string | `"ClusterIP"` |  |
| serviceAccount.annotations | object | `{}` |  |
| serviceAccount.create | bool | `true` |  |
| serviceAccount.name | string | `""` |  |
| tolerations | list | `[]` |  |

----------------------------------------------
Autogenerated from chart metadata using [helm-docs v1.14.2](https://github.com/norwoodj/helm-docs/releases/v1.14.2)
