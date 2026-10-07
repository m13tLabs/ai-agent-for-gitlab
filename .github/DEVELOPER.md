# Developer guide

How the pieces work inside: components, triggers, prompts, chart and setup Job internals, and
releases. Deploying and configuring is in [USAGE.md](USAGE.md), building and testing in
[CONTRIBUTING.md](CONTRIBUTING.md).

- [Components](#components)
- [How it works](#how-it-works)
- [Chart internals](#chart-internals)
- [Releases](#releases)

## Components

| Path | What it is |
| --- | --- |
| `gitlab-app/` | Webhook middleware (Node.js 24 + Hono, TypeScript run directly, no build step). Everything goes through `POST /webhook` in `src/index.ts`. `src/setup.ts` is the chart's GitLab setup Job. |
| `agent-image/` | Image for the CI job: `ai-runner`, opencode and the GitLab MCP server (`scripts/mcp/mcp.ts`). Runs **only as a CI job** on GitLab runners, never as a long-lived pod. |
| `charts/ai-agent-for-gitlab/` | Helm chart for the webhook app, optional Redis, Ingress and the setup Job/CronJob. |
| `gitlab-utils/.gitlab-ci.yml` | Job template for per-project mode. Runs when `AI_TRIGGER == "true"`. |
| `templates/agent-runner.yml` | GitLab CI/CD component for runner mode, published as `gitlab.com/m13tlabs/ai-agent-for-gitlab/agent-runner`. |

## How it works

### Triggers

- `Note Hook`: a `TRIGGER_PHRASE` mention in an MR or issue comment. `@ai review [extra]` on an
  MR runs the review flow instead (`reviewPrompt()`, `AI_REVIEW=true`, empty
  `AI_DISCUSSION_ID`), same as a reviewer request.
- `Merge Request Hook`: `AI_GITLAB_USERNAME` newly added as reviewer or assignee
  (`aiUserNewlyRequested`). Fires only on a *transition* (`changes.reviewers/assignees`
  previous → current) or on `open`/`reopen`, so pushes and title edits never re-trigger. Only
  open MRs are reviewed, and assignments made by the bot itself are ignored.
- `commonPipelineVariables()` holds the variables shared by both triggers. Add new shared
  variables there.
- Pipeline trigger variables take precedence over `.gitlab-ci.yml` variables. That is why
  forwarding `AI_AGENT_IMAGE` from the app pins the image for every project.
- In runner mode, `triggerPipeline` / `cancelOldPipelines` in `gitlab.ts` redirect to
  `AI_RUNNER_PROJECT`. The target travels as `AI_PROJECT_ID` (always set, read by the agent
  before `CI_PROJECT_ID`), `AI_PROJECT_PATH` and `AI_BRANCH`. All runner pipelines share one
  ref, so cancelling filters by those variables.

### Branches

From an issue, a new branch `ai/issue-{IID}-{sanitized-title}-{timestamp}` (`BRANCH_PREFIX`)
is created. From an MR, the MR's source branch is used. If branch creation fails the webhook
returns an error: the agent **never** runs on the default branch.

### Prompt and context

- The prompt is truncated to 8000 chars (`MAX_PROMPT_CHARS`) to stay within CI variable
  limits. For a thread reply, `threadPrompt()` drops the oldest thread notes first, so the
  user's own prompt at the end survives.
- An empty `AI_DISCUSSION_ID` makes the agent post a top-level note (reviews); a non-empty one
  makes it reply in that thread.
- Earlier findings: the webhook only passes the triggering thread. The agent
  (`previousFindings()` in `agent-image/scripts/src/runner.ts`) loads all discussions at
  runtime (`src/discussions.ts`; no CI variable limit, the prompt goes to opencode on stdin)
  and prepends those `AI_GITLAB_USERNAME` started or replied in, with resolve status and
  replies, minus the triggering thread and the runner's own status notes (`RUNNER_NOTES`).
  Resolved findings count as fixed or dismissed. Keep `RUNNER_NOTES` in sync when changing
  `errorComment` / `permissionComment` / `reviewRetriggerComment`. The model can read the same
  data via the `list_gitlab_discussions` MCP tool. After a successful review the runner posts
  `reviewRetriggerComment()`.

### Code suggestions

`create_gitlab_code_suggestion` (MCP, MRs only) posts a diff discussion (`POST .../discussions`
with a `position` from the MR's `diff_refs`) whose body is a ```` ```suggestion:-N+0 ````
block anchored on the range's last line. That line must be in the MR diff (`src/suggestion.ts`
maps it from `GET .../diffs`: added lines send only `new_line`, context lines also
`old_line`). Otherwise, or when GitLab rejects the position, it posts a regular note with a
blob permalink. **Not yet verified against a real GitLab.**

### Agent image

- opencode starts the MCP server itself (`node mcp.ts`, configured in
  `~/.config/opencode/opencode.json` by `src/opencode.ts`).
- The agent reads `GITLAB_AI_AGENT_TOKEN` before `GITLAB_TOKEN` (`context.ts`), so a leftover
  hand-made `GITLAB_TOKEN` can't shadow the setup-managed one.
- Node.js is copied from `node:*-bookworm-slim` into `mcr.microsoft.com/dotnet/sdk:8.0`. Keep
  both on the same Debian release so the binary's glibc matches. Both images pin
  `node:24.x.y-*` (Renovate bumps them).
- opencode's model catalog is baked in at build time (`/opt/opencode-models.json`).
  `ai-runner` points `OPENCODE_MODELS_PATH` at it only when `OPENCODE_DISABLE_MODELS_FETCH` is
  true (forwarded by the webhook only when on). Setting it unconditionally would make opencode
  ignore what it fetches. The flag without the file isn't enough either: opencode's
  compiled-in snapshot is frozen at its release, so newer Bedrock IDs fail with
  `Model not found`.

## Chart internals

- `ADMIN_TOKEN` must be set: `bearerAuth` is created when the module loads. The chart generates
  one and keeps it across upgrades via `lookup`; `helm template` always shows a fresh random
  value, which is expected.
- The `/admin/disable|enable` state is in memory per process, not shared across replicas.
- `readOnlyRootFilesystem: true` works only because the pod sets `HOME=/tmp` and mounts an
  emptyDir at `/tmp`. Keep both.
- `checksum/secret` hashes `.Values.secrets`, not the rendered `secret.yaml`: rendering calls
  `randAlphaNum` again, so its hash would differ and the first no-op upgrade would roll the
  pods.
- Without `lookup` (Argo CD, Flux, `helm template`), a chart-generated `WEBHOOK_SECRET` changes
  on every render while `checksum/secret` doesn't, so pods kept the old secret while setup
  registered hooks with the new one (every webhook → 401). setup.ts therefore hashes the
  secret into its config checksum and restarts the Deployment on change. Since that still
  re-registered hooks on every sync, with `gitlabSetup.enabled` and no secret given (helper
  `ai-agent.webhookSecretGenerated`) the chart doesn't generate it at all: the setup Job
  (`WEBHOOK_SECRET_GENERATE=true`) generates it once into `<fullname>-bot-token` (key
  `secrets.keys.webhookSecret`, merge-patch with `resourceVersion` so a concurrent run gets 409
  and re-reads). Upgrading an existing release rotates it once.
- The Deployment reads `GITLAB_TOKEN` and the generated `WEBHOOK_SECRET` from
  `<fullname>-bot-token` with `optional: true`. The post-install Job creates that Secret, and
  without `optional` `helm install --wait` would deadlock. The Job restarts the Deployment
  (pod-template annotation) after storing or rotating the token.
- `agent.validateModel` adds a `validate-model` init container running the **agent** image,
  which checks `agent.model` with `jq` against `/opt/opencode-models.json`. An agent image
  without the catalog skips the check. Verified in kind: a wrong model leaves the old pods
  running and fails `helm --wait`.
- `additionalEnvs` (helper `ai-agent.additionalEnvs`) goes into the webhook and setup pods.
  Verified on Node 24: `fetch` ignores `HTTP(S)_PROXY` without `NODE_USE_ENV_PROXY=1`, and
  `NO_PROXY` matches exact IPs and suffixes but not CIDRs. Hence the helper adds
  `NODE_USE_ENV_PROXY=1` and appends `$(KUBERNETES_SERVICE_HOST)` (expanded by the kubelet) to
  `NO_PROXY`, because setup.ts reaches the Kubernetes API by that IP.
- Bundled Redis is rendered only when `rateLimiting.enabled && redis.enabled`. Otherwise
  `redis.externalUrl` is required if rate limiting is on.
- The chart README is helm-docs output from `# --` comments in `values.yaml`. CI fails if it's
  stale. `ct lint` renders with `ci/default-values.yaml`.
- Logo and avatar sources are `docs/assets/{logo,bot-avatar}.svg`; run
  `scripts/render-logos.sh` after editing them (GitLab avatars can't be SVG). The chart ships
  copies as `files/bot-avatar.png` / `files/project-avatar.png` in a ConfigMap, because Helm
  can't read files outside the chart.

### Setup Job (`gitlab-app/src/setup.ts`)

Runs as a post-install/upgrade hook Job plus a CronJob, in its own pods, never in the
internet-facing webhook pod, because it holds the admin token. Every step must stay
idempotent, since the CronJob re-runs it hourly.

Facts verified against a real GitLab 19.4 CE (don't "fix" these from memory):

- `POST /service_accounts` works on CE. Service account tokens come from
  `POST /users/:id/personal_access_tokens`; `/service_accounts/:id/personal_access_tokens`
  returns 404.
- Usernames starting with `ai-`, `ai_`, `duo-` or `duo_` are rejected as reserved.
- System hooks deliver `X-Gitlab-Event: System Hook` with the MR payload unchanged
  (`object_kind: merge_request`, same `changes.reviewers`). They also always deliver instance
  events like `project_create`, which the app ignores. They can't deliver comment events.
- `POST /hooks` defaults `repository_update_events` to true, so setup.ts turns it off. It finds
  its hook by `name`, so a URL change updates the hook instead of duplicating it.
- Group deletion is delayed; groups with `marked_for_deletion_on` are skipped.

Other details:

- The avatar is uploaded only when its sha256 changes (tracked in a user custom attribute).
- Central pipeline (step 7, last, so a failure can't block token rotation): the component
  project is created empty and synced by `git clone --bare` of `cloneUrl` into `/tmp`, then
  `git push --porcelain` of `refs/heads/*` and `refs/tags/*` (fast-forward only, no prune) and
  `PUT default_branch`. It deliberately doesn't use `import_url`: GitLab validates that with
  `git ls-remote` from its own servers and answers 422 without outbound access, while the Job
  can use a proxy from `additionalEnvs`. The admin token authenticates the push via
  `GIT_CONFIG_COUNT`/`KEY`/`VALUE` (an `http.<gitlab origin>/.extraHeader`), never argv, and
  scoped to GitLab's origin; git errors pass through `redactUrls()`. The app image installs
  git for this.
- The project becomes a Catalog resource via GraphQL (`ciCatalogResource(fullPath:)`, then
  `catalogResourcesCreate`; there's no REST API). The runner project's files are committed via
  the Commits API; the first commit creates `main`.
- Edition detection: `GET /metadata` (`enterprise`), then on EE `GET /license` (`plan`,
  `expired`); only an unexpired `premium`/`ultimate` plan gets the pull mirror
  (`PUT /projects/:id` with `mirror`, `import_url`, `mirror_trigger_builds: false`,
  `mirror_overwrites_diverged_branches: true`, plus `POST /projects/:id/mirror/pull`). Failures
  there are warnings. `GET /projects/:id` returns `import_url` without credentials, so it's
  compared via `sourceLink()`.
- `GITLAB_AI_AGENT_TOKEN` on the runner project: `ensureBotToken` returns the token in use and
  step 7 passes it on. It's only rewritten when value, description or flags differ (a hidden
  variable reads back as null and is re-sent).
- **Not yet verified against a real GitLab**: the catalog calls, project-level Owner (50)
  memberships, pushing with the admin token (needs `api` or `write_repository`) and the mirror
  calls. The mock covers only the assumed REST/GraphQL shapes; it runs real git against a
  local source and a bare `file://` target, so the HTTP auth header path is untested.

## Releases

CI and release use the shared [`m13tLabs/gh-actions-templates`](https://github.com/m13tLabs/gh-actions-templates)
workflows: `docker-ci.yml` once per image directory, `docker-release.yml` with `agent-image/`
as the "variant" build. One release versions both images together via root `config.json`,
published as `{ghcr.io/m13tlabs,docker.io/m13t}/ai-agent-for-gitlab-{app,agent}`.

`scripts/pin-release-version.sh` (the template's `bump_command`) runs in the release commit:

- `image.tag`, `agentImage.tag` and Chart.yaml `appVersion` become the release version.
- The chart's own `version` gets a patch bump (it's versioned independently), or becomes the
  release workflow's optional `chart_version` input. That must be higher than the current
  version, since the OCI push would otherwise replace a published chart; the `chart-version`
  job validates it before it goes into the `bump_command` string.
- helm-docs regenerates the chart README.
- The `version` input default in `templates/agent-runner.yml` becomes the release version (so
  `agent-runner@v<version>` runs that release's agent image) and glab-docs regenerates
  `templates/README.md`.

Keep `default:` inside the `version:` input block (6-space indent) and the `tag:` keys directly
inside the top-level `image:` / `agentImage:` blocks, or the script fails the release
(`test/pin-release-version.bats` catches this in CI).

`release.yml`'s `chart` job then packages the chart from the release commit (`release_sha`,
not the tag, which a draft release doesn't have) and pushes it to
`oci://ghcr.io/m13tlabs/helm-charts`.
