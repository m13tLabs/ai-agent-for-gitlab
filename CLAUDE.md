# CLAUDE.md

GitLab AI agent: a webhook middleware triggers GitLab CI pipelines that run an opencode-based agent. User-facing setup docs live in `README.md`; this file holds things that aren't obvious from the code.

## Layout

- `gitlab-app/`: webhook middleware (Bun + Hono, TypeScript). Everything goes through `POST /webhook` in `src/index.ts`.
  - `Note Hook`: `@ai` (the `TRIGGER_PHRASE`) mention in an MR or issue comment.
  - `Merge Request Hook`: `AI_GITLAB_USERNAME` newly added as reviewer or assignee (see `aiUserNewlyRequested`). This is the replacement for GitLab Duo reviews.
  - `commonPipelineVariables()` holds the pipeline variables shared by both triggers. Add new shared variables there.
- `agent-image/`: image for the CI job (`ai-runner`, opencode, MCP server in `scripts/mcp/mcp.ts`). It runs **only as a CI job** on GitLab runners, never as a long-lived pod.
- `charts/ai-agent-for-gitlab/`: Helm chart for the **gitlab-app** (plus optional Redis and Ingress). Its `agentImage` value reaches pipelines as `AI_AGENT_IMAGE`.
- `gitlab-utils/.gitlab-ci.yml`: template for target projects. The job runs when `AI_TRIGGER == "true"`.

## Behavior worth knowing

- Pipeline trigger variables take precedence over `.gitlab-ci.yml` variables. That is why forwarding `AI_AGENT_IMAGE` from the app pins the image for every project.
- An empty `AI_DISCUSSION_ID` makes the agent post a top-level MR note, which is what reviews use. A non-empty one makes it reply in that thread.
- Assignment reviews fire only on a *transition* (`changes.reviewers/assignees` previous → current) or on `open`/`reopen`, so pushes and title edits never re-trigger.
- `ADMIN_TOKEN` must be set. `bearerAuth` is created when the module loads, so the app fails without it. The chart generates one if none is given.
- The `/admin/disable|enable` state is in memory per process. It does not work across multiple replicas.
- The prompt is truncated to 8000 chars (`MAX_PROMPT_CHARS`) to stay within CI variable limits.
- CI/release use the shared `m13tLabs/gh-actions-templates` workflows (`docker-ci.yml` once per image dir, `docker-release.yml` with `agent-image/` as the "variant" build). One release versions both images together via root `config.json`; they are published as `{ghcr.io/m13tlabs,docker.io/m13t}/ai-agent-for-gitlab-{app,agent}`.
- The agent image is amd64-only (its `dotnetimages/...` base has no arm64), hence `variant_platforms: linux/amd64` in `release.yml`.
- A release bumps only `config.json`, not the chart's `appVersion`, so bump that by hand if the chart should default to the new image tag.

## Verification

- Typecheck: `cd gitlab-app && npm ci && npx tsc --noEmit --types node`. The plain `npm run typecheck` fails locally because `bun` types aren't installed, and Bun itself isn't installed either.
- Webhook logic without Bun or GitLab: import `gitlab-app/src/index.ts` with `npx tsx`, set `GITLAB_URL` to a local `node:http` mock and `RATE_LIMITING_ENABLED=false`, then call `app.fetch(new Request(...))` with fake `X-Gitlab-Event` / `X-Gitlab-Token` headers.
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

- `readOnlyRootFilesystem: true` works only because the pod sets `HOME=/tmp` and mounts an emptyDir at `/tmp` (Bun cache). Keep both if you touch the deployment.
- `checksum/secret` hashes `.Values.secrets`, not the rendered `secret.yaml`. Rendering the secret calls `randAlphaNum` again, so its hash differs from the stored secret after install and the first no-op upgrade would roll the pods.
- `ADMIN_TOKEN` stays the same across upgrades because the chart uses `lookup` to reuse the existing Secret. `helm template` (no cluster) always shows a fresh random value, which is expected.
- Bundled Redis is rendered only when `rateLimiting.enabled && redis.enabled`. Otherwise `redis.externalUrl` is required if rate limiting is on.

## Conventions

- Match the existing style: raw `fetch` against the GitLab REST API with `PRIVATE-TOKEN`, `logger.*` with a context object, and non-critical GitLab calls (reactions, cancelling pipelines) log a warning instead of throwing.
- Any new env var goes in: `gitlab-app/.env.example`, the chart (`values.yaml` + `templates/configmap.yaml`) and the README configuration section.
- The root `.gitignore` uses `./` prefixes, which Git ignores. The `.gitignore` files in `gitlab-app/` and `agent-image/` are what actually ignore `node_modules`.
