# CLAUDE.md

GitLab AI agent: a webhook middleware triggers GitLab CI pipelines that run an opencode-based agent. User-facing setup docs live in `README.md`; this file holds things that aren't obvious from the code.

## Layout

- `gitlab-app/`: webhook middleware (Node.js 24 LTS + Hono, TypeScript run directly via Node's type stripping — no build step). Everything goes through `POST /webhook` in `src/index.ts`.
  - `Note Hook`: `@ai` (the `TRIGGER_PHRASE`) mention in an MR or issue comment.
  - `Merge Request Hook`: `AI_GITLAB_USERNAME` newly added as reviewer or assignee (see `aiUserNewlyRequested`). This is the replacement for GitLab Duo reviews.
  - `commonPipelineVariables()` holds the pipeline variables shared by both triggers. Add new shared variables there.
- `agent-image/`: image for the CI job (`ai-runner`, opencode, MCP server in `scripts/mcp/mcp.ts`). It runs **only as a CI job** on GitLab runners, never as a long-lived pod.
- `charts/ai-agent-for-gitlab/`: Helm chart for the **gitlab-app** (plus optional Redis and Ingress). Its `agentImage.repository`/`.tag` values reach pipelines as `AI_AGENT_IMAGE` (via the `ai-agent.agentImage` helper).
- `gitlab-utils/.gitlab-ci.yml`: template for target projects. The job runs when `AI_TRIGGER == "true"`.

## Behavior worth knowing

- Pipeline trigger variables take precedence over `.gitlab-ci.yml` variables. That is why forwarding `AI_AGENT_IMAGE` from the app pins the image for every project.
- An empty `AI_DISCUSSION_ID` makes the agent post a top-level MR note, which is what reviews use. A non-empty one makes it reply in that thread.
- Assignment reviews fire only on a *transition* (`changes.reviewers/assignees` previous → current) or on `open`/`reopen`, so pushes and title edits never re-trigger.
- `ADMIN_TOKEN` must be set. `bearerAuth` is created when the module loads, so the app fails without it. The chart generates one if none is given.
- The `/admin/disable|enable` state is in memory per process. It does not work across multiple replicas.
- The prompt is truncated to 8000 chars (`MAX_PROMPT_CHARS`) to stay within CI variable limits.
- CI/release use the shared `m13tLabs/gh-actions-templates` workflows (`docker-ci.yml` once per image dir, `docker-release.yml` with `agent-image/` as the "variant" build). One release versions both images together via root `config.json`; they are published as `{ghcr.io/m13tlabs,docker.io/m13t}/ai-agent-for-gitlab-{app,agent}`.
- Both images run Node.js 24 LTS, pinned as `node:24.x.y-*` in the Dockerfiles (Renovate bumps them). The agent image copies `node` + npm from `node:*-bookworm-slim` into `mcr.microsoft.com/dotnet/sdk:8.0`; keep both on the same Debian release (bookworm) so the binary's glibc matches.
- gitlab-app source must stay *erasable* TypeScript (no enums, namespaces, parameter properties) with `.ts` relative imports — `tsconfig.json` enforces this via `erasableSyntaxOnly` / `allowImportingTsExtensions`. Node doesn't type-check, so the Dockerfile's `typecheck` stage runs `tsc` and fails the build.
- A release also runs `scripts/pin-release-version.sh` (the template's `bump_command`) in the release commit: `image.tag`, `agentImage.tag` and Chart.yaml `appVersion` become the release version, the chart's own `version` gets a patch bump (versioned independently, like CloudTooling's charts), and helm-docs regenerates `charts/ai-agent-for-gitlab/README.md`. Keep the `tag:` keys directly inside the top-level `image:` / `agentImage:` blocks, or the script fails the release (`test/pin-release-version.bats` catches this in CI).
- `release.yml`'s `chart` job then packages the chart from that release commit (`release_sha`, not the tag, which a draft release doesn't create) and pushes it to `oci://ghcr.io/m13tlabs/helm-charts`.
- The chart README is helm-docs output (from `# --` comments in `values.yaml`); CI fails if it's stale, so run `helm-docs --chart-search-root charts` after changing values. `ct lint` renders with `charts/ai-agent-for-gitlab/ci/default-values.yaml`.

## Verification

- Image tests (BATS, black-box against a built image, also CI's smoke test via `ci.yml`):

  ```bash
  docker build -t ai-agent-for-gitlab-app:dev gitlab-app
  IMAGE=ai-agent-for-gitlab-app:dev bats test/gitlab-app.bats
  docker build -t ai-agent-for-gitlab-agent:dev agent-image
  IMAGE=ai-agent-for-gitlab-agent:dev bats test/agent-image.bats
  ```

  `gitlab-app.bats` points `GITLAB_URL` at a closed port, so it only covers paths that answer without GitLab (auth, skip/ignore, self-trigger, disable, MR transition rules). A new response path that calls GitLab needs a GitLab mock instead.
- Typecheck: `cd gitlab-app && npm ci && npm run typecheck`. Run locally with `npm start` (Node >= 24.2 for `import.meta.main`).
- Webhook logic without GitLab: import `gitlab-app/src/index.ts` with plain `node` (it only binds a port when run as the entrypoint), set `GITLAB_URL` to a local `node:http` mock and `RATE_LIMITING_ENABLED=false`, then call `app.fetch(new Request(...))` with fake `X-Gitlab-Event` / `X-Gitlab-Token` headers.
- Chart: `helm lint charts/ai-agent-for-gitlab --set secrets.gitlabToken=x,secrets.webhookSecret=y,gitlab.aiUsername=ai-reviewer`.
- Real install test: use kind with a **separate kubeconfig**. The user's default kube context is `prod`, so never install there or switch contexts.

  ```bash
  docker build -t gitlab-app:dev gitlab-app
  kind create cluster --name ai-agent-chart-test --kubeconfig <scratch>/kc
  kind load docker-image gitlab-app:dev --name ai-agent-chart-test
  helm install t charts/ai-agent-for-gitlab --kubeconfig <scratch>/kc --set image.repository=gitlab-app,image.tag=dev,...
  kind delete cluster --name ai-agent-chart-test --kubeconfig <scratch>/kc
  ```

## Chart gotchas

- `readOnlyRootFilesystem: true` works only because the pod sets `HOME=/tmp` and mounts an emptyDir at `/tmp`, so anything writing to `$HOME` has a writable place. Keep both if you touch the deployment.
- `checksum/secret` hashes `.Values.secrets`, not the rendered `secret.yaml`. Rendering the secret calls `randAlphaNum` again, so its hash differs from the stored secret after install and the first no-op upgrade would roll the pods.
- `ADMIN_TOKEN` stays the same across upgrades because the chart uses `lookup` to reuse the existing Secret. `helm template` (no cluster) always shows a fresh random value, which is expected.
- Bundled Redis is rendered only when `rateLimiting.enabled && redis.enabled`. Otherwise `redis.externalUrl` is required if rate limiting is on.

## Conventions

- Match the existing style: raw `fetch` against the GitLab REST API with `PRIVATE-TOKEN`, `logger.*` with a context object, and non-critical GitLab calls (reactions, cancelling pipelines) log a warning instead of throwing.
- Any new env var goes in: `gitlab-app/.env.example`, the chart (`values.yaml` + `templates/configmap.yaml`) and the README configuration section.
- The root `.gitignore` uses `./` prefixes, which Git ignores. The `.gitignore` files in `gitlab-app/` and `agent-image/` are what actually ignore `node_modules`.
