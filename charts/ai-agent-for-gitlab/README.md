# ai-agent-for-gitlab

![Version: 0.2.3](https://img.shields.io/badge/Version-0.2.3-informational?style=flat-square) ![Type: application](https://img.shields.io/badge/Type-application-informational?style=flat-square) ![AppVersion: 0.2.2](https://img.shields.io/badge/AppVersion-0.2.2-informational?style=flat-square)

GitLab webhook middleware that triggers AI agent pipelines on @ai mentions and when the AI user is requested as merge request reviewer/assignee.

**Homepage:** <https://github.com/m13tLabs/ai-agent-for-gitlab>

## Source Code

* <https://github.com/m13tLabs/ai-agent-for-gitlab>

## Values

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| affinity | object | `{}` |  |
| agent.branchPrefix | string | `"ai"` | Prefix for branches created for issues |
| agent.cancelOldPipelines | bool | `true` | Cancel older pending pipelines on the same ref |
| agent.model | string | `"azure/gpt-4.1"` | opencode model in provider/model form |
| agent.prompt | string | `""` | Base prompt for the agent (OPENCODE_AGENT_PROMPT) |
| agent.startReactionEmoji | string | `"robot"` | Emoji awarded when a run starts |
| agent.triggerPhrase | string | `"@ai"` | Mention that triggers the agent in comments |
| agentImage | object | `{"repository":"m13t/ai-agent-for-gitlab-agent","tag":"0.2.2"}` | Image the CI job uses to run the agent, forwarded to pipelines as AI_AGENT_IMAGE=<repository>:<tag>. Pipeline variables override the default in .gitlab-ci.yml, so every project uses this image. Set repository to "" to keep each project's own AI_AGENT_IMAGE. |
| agentImage.tag | string | `"0.2.2"` | Set to the release version by each release (scripts/pin-release-version.sh). "" falls back to .Chart.AppVersion. |
| extraEnv | list | `[]` | Extra environment variables for the middleware container |
| extraEnvFrom | list | `[]` | Extra envFrom sources (e.g. a ConfigMap with OPENCODE_AGENT_PROMPT) |
| fullnameOverride | string | `""` |  |
| gitlab.aiEmail | string | `""` | Email of the AI service account (used for commits) |
| gitlab.aiUsername | string | `""` | Username of the AI service account the token belongs to (e.g. review-agent). GitLab reserves usernames starting with ai-, ai_, duo- and duo_. |
| gitlab.url | string | `"https://gitlab.com"` | GitLab instance URL |
| gitlabSetup.accessLevel | int | `30` | Role in each group: 30 = Developer, 40 = Maintainer |
| gitlabSetup.accountType | string | `"service_account"` | "service_account" (instance service account) or "user" (regular user, for GitLab versions without the service account API) |
| gitlabSetup.avatar | bool | `true` | Upload the bundled bot avatar (files/bot-avatar.png) as the bot's avatar |
| gitlabSetup.botName | string | `"AI Agent"` | Display name of the bot account |
| gitlabSetup.enabled | bool | `false` | Enable the automated GitLab setup (requires secrets.gitlabAdminToken) |
| gitlabSetup.groups | list | `[]` | Full paths of the groups to join; empty = every top-level group |
| gitlabSetup.resources.limits.memory | string | `"256Mi"` |  |
| gitlabSetup.resources.requests.cpu | string | `"10m"` |  |
| gitlabSetup.resources.requests.memory | string | `"64Mi"` |  |
| gitlabSetup.schedule | string | `"17 * * * *"` | CronJob schedule for re-syncing (new groups, token rotation) |
| gitlabSetup.systemHook.enabled | bool | `true` | Register the merge request system hook |
| gitlabSetup.systemHook.sslVerification | bool | `true` | Verify TLS when GitLab calls the hook URL |
| gitlabSetup.systemHook.url | string | `""` | URL GitLab posts to; empty = this release's in-cluster Service (http://<fullname>.<namespace>.svc.cluster.local:<service.port>/webhook). Use the ingress URL when GitLab runs outside the cluster. |
| gitlabSetup.token.expiryDays | int | `90` | Lifetime of the bot token in days |
| gitlabSetup.token.renewBeforeDays | int | `14` | Rotate the bot token this many days before it expires |
| image.pullPolicy | string | `"IfNotPresent"` |  |
| image.repository | string | `"m13t/ai-agent-for-gitlab-app"` |  |
| image.tag | string | `"0.2.2"` | Set to the release version by each release (scripts/pin-release-version.sh). "" falls back to .Chart.AppVersion. |
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
| redis.image.tag | string | `"7-alpine"` |  |
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
| secrets.webhookSecret | string | `""` | Secret token configured on the GitLab webhook |
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
