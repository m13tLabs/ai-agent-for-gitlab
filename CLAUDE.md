# CLAUDE.md

GitLab AI agent: a webhook middleware triggers GitLab CI pipelines that run an opencode-based agent. User-facing setup docs live in `README.md`; this file holds things that aren't obvious from the code.

## Layout

- `gitlab-app/`: webhook middleware (Node.js 24 LTS + Hono, TypeScript run directly via Node's type stripping — no build step). Everything goes through `POST /webhook` in `src/index.ts`.
  - `Note Hook`: `@ai` (the `TRIGGER_PHRASE`) mention in an MR or issue comment.
  - `Merge Request Hook`: `AI_GITLAB_USERNAME` newly added as reviewer or assignee (see `aiUserNewlyRequested`). This is the replacement for GitLab Duo reviews.
  - `commonPipelineVariables()` holds the pipeline variables shared by both triggers. Add new shared variables there.
- `agent-image/`: image for the CI job (`ai-runner`, opencode, MCP server in `scripts/mcp/mcp.ts`). It runs **only as a CI job** on GitLab runners, never as a long-lived pod. The runner is TypeScript run directly by Node, like gitlab-app; opencode starts the MCP server itself (`node mcp.ts`, configured in `~/.config/opencode/opencode.json` by `src/opencode.ts`).
- `charts/ai-agent-for-gitlab/`: Helm chart for the **gitlab-app** (plus optional Redis and Ingress). Its `agentImage.repository`/`.tag` values reach pipelines as `AI_AGENT_IMAGE` (via the `ai-agent.agentImage` helper).
- `gitlab-utils/.gitlab-ci.yml`: template for target projects. The job runs when `AI_TRIGGER == "true"`.
- `templates/agent-runner.yml`: GitLab CI/CD component for the central runner project (`AI_RUNNER_PROJECT`), published from a GitLab mirror as `gitlab.com/m13tlabs/ai-agent-for-gitlab/agent-runner`. `templates/README.md` is generated: `docker run --rm -v "$PWD:/w" -w /w --entrypoint glab-docs m13t/glab-docs:1.0.0 --search-root templates --component-prefix gitlab.com/m13tlabs/ai-agent-for-gitlab --documentation-strict-mode`. `triggerPipeline`/`cancelOldPipelines` in `gitlab.ts` redirect there; the target travels as `AI_PROJECT_ID` (always set, read by the agent before `CI_PROJECT_ID`), `AI_PROJECT_PATH` and `AI_BRANCH`. All runner pipelines share one ref, so cancelling filters by those variables, and the template turns GitLab's auto-cancel off (it would cancel runs for other targets).

## Behavior worth knowing

- Pipeline trigger variables take precedence over `.gitlab-ci.yml` variables. That is why forwarding `AI_AGENT_IMAGE` from the app pins the image for every project.
- An empty `AI_DISCUSSION_ID` makes the agent post a top-level MR note, which is what reviews use. A non-empty one makes it reply in that thread.
- Assignment reviews fire only on a *transition* (`changes.reviewers/assignees` previous → current) or on `open`/`reopen`, so pushes and title edits never re-trigger.
- `ADMIN_TOKEN` must be set. `bearerAuth` is created when the module loads, so the app fails without it. The chart generates one if none is given.
- The `/admin/disable|enable` state is in memory per process. It does not work across multiple replicas.
- The prompt is truncated to 8000 chars (`MAX_PROMPT_CHARS`) to stay within CI variable limits.
- CI/release use the shared `m13tLabs/gh-actions-templates` workflows (`docker-ci.yml` once per image dir, `docker-release.yml` with `agent-image/` as the "variant" build). One release versions both images together via root `config.json`; they are published as `{ghcr.io/m13tlabs,docker.io/m13t}/ai-agent-for-gitlab-{app,agent}`.
- Both images run Node.js 24 LTS, pinned as `node:24.x.y-*` in the Dockerfiles (Renovate bumps them). The agent image copies `node` + npm from `node:*-bookworm-slim` into `mcr.microsoft.com/dotnet/sdk:8.0`; keep both on the same Debian release (bookworm) so the binary's glibc matches.
- The agent image bakes opencode's model catalog in at build time (`/opt/opencode-models.json`) for air-gapped runners. `ai-runner` points `OPENCODE_MODELS_PATH` at it only when `OPENCODE_DISABLE_MODELS_FETCH` is true (chart `agent.disableModelsFetch`, forwarded by the webhook as a pipeline variable only when on). Setting `OPENCODE_MODELS_PATH` unconditionally would be wrong: opencode then ignores whatever it fetches. The flag without the file isn't enough either: opencode's compiled-in snapshot is frozen at its release, so newer Bedrock IDs fail with `Model not found`.
- gitlab-app and `agent-image/scripts` sources must stay *erasable* TypeScript (no enums, namespaces, parameter properties) with `.ts` relative imports — each `tsconfig.json` enforces this via `erasableSyntaxOnly` / `allowImportingTsExtensions`. Node doesn't type-check, so each Dockerfile runs `tsc` in a build stage (`typecheck` / `test`) and fails the build. The agent's `test` stage also runs the unit tests, on `$BUILDPLATFORM` so they don't run again under QEMU per target platform.
- A release also runs `scripts/pin-release-version.sh` (the template's `bump_command`) in the release commit: `image.tag`, `agentImage.tag` and Chart.yaml `appVersion` become the release version, the chart's own `version` gets a patch bump (versioned independently, like CloudTooling's charts), or becomes the release workflow's optional `chart_version` input (second script argument; must be higher than the current version, since the OCI push would otherwise replace a published chart; the `chart-version` job validates it before it goes into the `bump_command` string), and helm-docs regenerates `charts/ai-agent-for-gitlab/README.md`. The same script sets the `version` input default in `templates/agent-runner.yml` to the release version (so `agent-runner@v<version>` runs that release's agent image) and regenerates `templates/README.md` with glab-docs; keep `default:` inside the `version:` input block (6-space indent) or the release fails. Keep the `tag:` keys directly inside the top-level `image:` / `agentImage:` blocks, or the script fails the release (`test/pin-release-version.bats` catches this in CI).
- `release.yml`'s `chart` job then packages the chart from that release commit (`release_sha`, not the tag, which a draft release doesn't create) and pushes it to `oci://ghcr.io/m13tlabs/helm-charts`.
- The chart README is helm-docs output (from `# --` comments in `values.yaml`); CI fails if it's stale, so run `helm-docs --chart-search-root charts` after changing values. `ct lint` renders with `charts/ai-agent-for-gitlab/ci/default-values.yaml`.

## Verification

- Image tests (BATS, black-box against a built image, also CI's smoke test via `ci.yml`):

  ```bash
  docker build -t ai-agent-for-gitlab-app:dev gitlab-app
  IMAGE=ai-agent-for-gitlab-app:dev bats test/gitlab-app.bats test/gitlab-setup.bats
  docker build -t ai-agent-for-gitlab-agent:dev agent-image
  IMAGE=ai-agent-for-gitlab-agent:dev bats test/agent-image.bats
  ```

  `gitlab-app.bats` points `GITLAB_URL` at a closed port, so it only covers paths that answer without GitLab (auth, skip/ignore, self-trigger, disable, MR transition rules). A new response path that calls GitLab needs a GitLab mock instead. `gitlab-setup.bats` does that for `src/setup.ts`: `test/fixtures/setup-mock.mjs` runs it inside the image against an in-process GitLab + Kubernetes mock and prints the writes it received.
- Agent unit tests (`node:test`, no GitLab or opencode needed: GitLab is a local `node:http` mock, `opencode` a fake script on `PATH`, git remotes are rewritten to local bare repos via `url.*.insteadOf`): `cd agent-image/scripts && npm ci && npm run typecheck && npm test`. The agent image build runs the same.
- Typecheck: `cd gitlab-app && npm ci && npm run typecheck`. Run locally with `npm start` (Node >= 24.2 for `import.meta.main`).
- Webhook logic without GitLab: import `gitlab-app/src/index.ts` with plain `node` (it only binds a port when run as the entrypoint), set `GITLAB_URL` to a local `node:http` mock and `RATE_LIMITING_ENABLED=false`, then call `app.fetch(new Request(...))` with fake `X-Gitlab-Event` / `X-Gitlab-Token` headers.
- Chart: `helm lint charts/ai-agent-for-gitlab --set secrets.gitlabToken=x,secrets.webhookSecret=y,gitlab.aiUsername=review-agent`.
- Real install test: use kind with a **separate kubeconfig**. The user's default kube context is `prod`, so never install there or switch contexts.

  ```bash
  docker build -t gitlab-app:dev gitlab-app
  kind create cluster --name ai-agent-chart-test --kubeconfig <scratch>/kc
  kind load docker-image gitlab-app:dev --name ai-agent-chart-test
  helm install t charts/ai-agent-for-gitlab --kubeconfig <scratch>/kc --set image.repository=gitlab-app,image.tag=dev,...
  kind delete cluster --name ai-agent-chart-test --kubeconfig <scratch>/kc
  ```

## Chart gotchas

- `gitlabSetup.enabled` runs `gitlab-app/src/setup.ts` (same image, `node src/setup.ts`) as a post-install/upgrade hook Job plus a CronJob. It holds the GitLab **admin** token, so it runs in its own pods, never in the internet-facing webhook pod. Every step must stay idempotent because the CronJob re-runs it hourly.
- Setup facts verified against a real GitLab 19.4 CE (don't "fix" these from memory):
  - `POST /service_accounts` works on CE. Tokens for service accounts come from `POST /users/:id/personal_access_tokens`; `/service_accounts/:id/personal_access_tokens` returns 404.
  - Usernames starting with `ai-`, `ai_`, `duo-` or `duo_` are rejected as reserved.
  - System hooks deliver `X-Gitlab-Event: System Hook` with the MR payload unchanged (`object_kind: merge_request`, same `changes.reviewers`). They *also* always deliver instance events like `project_create`, which the app has to ignore. They can't deliver comment events.
  - `POST /hooks` defaults `repository_update_events` to true, so setup.ts turns it off explicitly. It finds its hook by `name`, so a URL change updates the hook instead of duplicating it.
  - Group deletion is delayed; groups with `marked_for_deletion_on` are skipped.
- The webhook Deployment reads `GITLAB_TOKEN` from `<fullname>-bot-token` with `optional: true`. That Secret is created by the post-install Job, and without `optional` a `helm install --wait` would deadlock. The Job restarts the Deployment (pod-template annotation) after storing or rotating the token.
- `gitlabSetup.centralPipeline` (setup step 7, runs last so a failure can't block the token rotation): creates the component project empty and syncs it itself on every run: `git clone --bare` of `cloneUrl` into a temp dir under `/tmp` (the setup pods' writable emptyDir), then `git push --porcelain` of `refs/heads/*` and `refs/tags/*` (fast-forward only, no prune) to the project's `http_url_to_repo`, and `PUT default_branch` to the source's HEAD. It deliberately doesn't use `import_url`: GitLab validates that with `git ls-remote` from its own servers and answers 422 `Unable to access repository` when GitLab has no outbound access, while the Job can use a proxy from `additionalEnvs` (git honors `HTTPS_PROXY`/`NO_PROXY` natively). The admin token authenticates the push through `GIT_CONFIG_COUNT`/`KEY`/`VALUE` env vars (an `http.<gitlab origin>/.extraHeader`), never argv, scoped to GitLab's origin so the source clone doesn't see it; git errors pass through `redactUrls()`. The app image installs git for this. Then the Job marks the project a CI/CD Catalog resource through GraphQL (no REST API; `ciCatalogResource(fullPath:)` query, then the `catalogResourcesCreate` mutation), creates the runner project and commits `.gitlab-ci.yml` (kept in sync) + `README.md` (created once) through the Commits API; the first commit to the empty project creates `main`. On top of that, Premium/Ultimate also gets a pull mirror. Edition detection: `GET /metadata` (`enterprise`), then on EE `GET /license` (`plan`, `expired`); only an unexpired `premium`/`ultimate` plan qualifies. The mirror is set with `PUT /projects/:id` (`mirror`, `import_url`, `mirror_trigger_builds: false`, `mirror_overwrites_diverged_branches: true`) plus `POST /projects/:id/mirror/pull` every run; any failure there (GitLab can't reach the source) is only a warning, since the push sync already covers it. `GET /projects/:id` returns `import_url` without credentials, so the mirror URL is compared via `sourceLink()`. The mock runs real git: a local source repo and a bare `file://` target stand in for the source and the component project, so the HTTP auth header path is only exercised against a real GitLab. **Not yet verified against a real GitLab**: the mock only covers the REST/GraphQL shapes assumed here; in particular the catalog calls, project-level Owner (50) memberships, pushing with the admin token (needs `api` or `write_repository` scope) and the mirror calls (Premium only) need a check on a real instance.
- The runner project gets the bot token as CI/CD variable `GITLAB_AI_AGENT_TOKEN` (masked, not protected, raw, with a description). `ensureBotToken` returns the token in use (stored or just rotated) and step 7 passes it on, so the variable follows every rotation; it's only rewritten when value, description or flags differ (a hidden variable reads back as null and is re-sent). The agent reads `GITLAB_AI_AGENT_TOKEN` before `GITLAB_TOKEN` (`context.ts`), so a leftover hand-made `GITLAB_TOKEN` can't shadow it.
- The avatar is uploaded only when its sha256 changes (tracked in a user custom attribute), so the hourly CronJob doesn't pile up uploads.
- Logo/avatar sources are `docs/assets/{logo,bot-avatar}.svg`. Run `scripts/render-logos.sh` (rsvg-convert) after editing them, because GitLab avatars can't be SVG. The chart ships `files/bot-avatar.png` and `files/project-avatar.png` (the logo, for the central pipeline's projects; uploaded only while a project has no avatar) in a ConfigMap. Both are copies inside the chart because Helm can't read files outside it.

- `readOnlyRootFilesystem: true` works only because the pod sets `HOME=/tmp` and mounts an emptyDir at `/tmp`, so anything writing to `$HOME` has a writable place. Keep both if you touch the deployment.
- `checksum/secret` hashes `.Values.secrets`, not the rendered `secret.yaml`. Rendering the secret calls `randAlphaNum` again, so its hash differs from the stored secret after install and the first no-op upgrade would roll the pods.
- Without `lookup` (Argo CD, Flux, `helm template`), a generated `WEBHOOK_SECRET` changes on every render while `checksum/secret` doesn't, so pods kept the old one while setup registered hooks with the new one (every webhook → 401). setup.ts therefore hashes the webhook secret in use into its config checksum and restarts the Deployment when it changed.
- `ADMIN_TOKEN` stays the same across upgrades because the chart uses `lookup` to reuse the existing Secret. `helm template` (no cluster) always shows a fresh random value, which is expected.
- `agent.validateModel` adds a `validate-model` init container to the webhook pods. It runs the **agent** image and checks `agent.model` with `jq` against `/opt/opencode-models.json`, the same catalog opencode resolves models from in the jobs. An agent image without the catalog (built before it was added) skips the check. The catalog is only as new as the agent image build, so with `disableModelsFetch: false` a model released since can pass in the jobs but fail this check; that's what the toggle is for. Verified in kind: a wrong model leaves the old pods running and fails `helm --wait`.
- `additionalEnvs` (helper `ai-agent.additionalEnvs`) goes into the webhook container and the setup pod spec. Verified in the app image (Node 24): `fetch` ignores `HTTP(S)_PROXY` without `NODE_USE_ENV_PROXY=1`, and `NO_PROXY` matches exact IPs and domain suffixes but not CIDRs. Hence the helper adds `NODE_USE_ENV_PROXY=1` and appends `$(KUBERNETES_SERVICE_HOST)` to `NO_PROXY` (the kubelet expands service variables in `$(VAR)`, verified in kind), because setup.ts reaches the Kubernetes API by that IP.
- Bundled Redis is rendered only when `rateLimiting.enabled && redis.enabled`. Otherwise `redis.externalUrl` is required if rate limiting is on.

## Conventions

- Match the existing style: raw `fetch` against the GitLab REST API with `PRIVATE-TOKEN`, `logger.*` with a context object, and non-critical GitLab calls (reactions, cancelling pipelines) log a warning instead of throwing.
- Any new env var goes in: `gitlab-app/.env.example`, the chart (`values.yaml` + `templates/configmap.yaml`) and the README configuration section.
- The root `.gitignore` uses `./` prefixes, which Git ignores. The `.gitignore` files in `gitlab-app/` and `agent-image/` are what actually ignore `node_modules`.
