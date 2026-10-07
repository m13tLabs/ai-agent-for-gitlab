# Contributing

We'd love for you to contribute. How the project fits together is in
[DEVELOPER.md](DEVELOPER.md), how it's deployed and configured in [USAGE.md](USAGE.md).

## Issues and feature requests

Search the [issues](https://github.com/m13tLabs/ai-agent-for-gitlab/issues) first. A bug report
should include your environment (GitLab version and edition, deployment method, Node.js
version), the steps leading to the issue, and logs or screenshots.

## Pull requests

- Branch from and open pull requests against **develop**, rebased on the current `develop`.
- Use [Conventional Commits](https://www.conventionalcommits.org/). The changelog is built from
  them with `git-cliff`.
- New functionality and bug fixes need tests (see below), and the test suite and type checks
  must pass.
- Reference related issues in the PR.

## Coding rules

- Match the existing style: raw `fetch` against the GitLab REST API with `PRIVATE-TOKEN`,
  `logger.*` with a context object. Non-critical GitLab calls (reactions, cancelling
  pipelines) log a warning instead of throwing.
- `gitlab-app/` and `agent-image/scripts/` are TypeScript that Node runs directly. Keep it
  *erasable* (no enums, namespaces or parameter properties) and use `.ts` relative imports.
  Each `tsconfig.json` enforces this via `erasableSyntaxOnly` / `allowImportingTsExtensions`.
  Node doesn't type-check, so each Dockerfile runs `tsc` in a build stage and fails the build.
- A new env var goes into `gitlab-app/.env.example`, the chart (`values.yaml` +
  `templates/configmap.yaml`) and the reference in [USAGE.md](USAGE.md#webhook-app-environment).
- After changing chart values, run `helm-docs --chart-search-root charts`. CI fails on a stale
  chart README.
- After changing `templates/agent-runner.yml`, regenerate `templates/README.md`:

  ```bash
  docker run --rm -v "$PWD:/w" -w /w --entrypoint glab-docs m13t/glab-docs:1.0.0 \
    --search-root templates --component-prefix gitlab.com/m13tlabs/ai-agent-for-gitlab \
    --documentation-strict-mode
  ```

- The root `.gitignore` uses `./` prefixes, which Git ignores. The `.gitignore` files in
  `gitlab-app/` and `agent-image/` are what actually ignore `node_modules`.

## Testing

Webhook app (Node.js >= 24.2):

```bash
cd gitlab-app && npm ci && npm run typecheck
npm start    # run locally, configured via .env
```

Agent unit tests (`node:test`, no GitLab or opencode needed: GitLab is a local `node:http`
mock, `opencode` a fake script on `PATH`, git remotes are rewritten to local bare repos). The
agent image build runs the same, on `$BUILDPLATFORM` so they don't repeat under QEMU:

```bash
cd agent-image/scripts && npm ci && npm run typecheck && npm test
```

Image tests (BATS, black-box against a built image; also CI's smoke test):

```bash
docker build -t ai-agent-for-gitlab-app:dev gitlab-app
IMAGE=ai-agent-for-gitlab-app:dev bats test/gitlab-app.bats test/gitlab-setup.bats
docker build -t ai-agent-for-gitlab-agent:dev agent-image
IMAGE=ai-agent-for-gitlab-agent:dev bats test/agent-image.bats
```

`gitlab-app.bats` points `GITLAB_URL` at a closed port, so it only covers paths that answer
without GitLab (auth, skip/ignore, self-trigger, disable, MR transition rules). A new response
path that calls GitLab needs a GitLab mock. `gitlab-setup.bats` does that for
`src/setup.ts`: `test/fixtures/setup-mock.mjs` runs it inside the image against an in-process
GitLab + Kubernetes mock and prints the writes it received.

Webhook logic without GitLab: import `gitlab-app/src/index.ts` with plain `node` (it only binds
a port when run as the entrypoint), set `GITLAB_URL` to a local `node:http` mock and
`RATE_LIMITING_ENABLED=false`, then call `app.fetch(new Request(...))` with fake
`X-Gitlab-Event` / `X-Gitlab-Token` headers.

Chart:

```bash
helm lint charts/ai-agent-for-gitlab \
  --set secrets.gitlabToken=x,secrets.webhookSecret=y,gitlab.aiUsername=review-agent
```

Real install test in kind, with a **separate kubeconfig** so your current context is never
touched:

```bash
docker build -t gitlab-app:dev gitlab-app
kind create cluster --name ai-agent-chart-test --kubeconfig /tmp/kc
kind load docker-image gitlab-app:dev --name ai-agent-chart-test
helm install t charts/ai-agent-for-gitlab --kubeconfig /tmp/kc \
  --set image.repository=gitlab-app,image.tag=dev,...
kind delete cluster --name ai-agent-chart-test --kubeconfig /tmp/kc
```

Anything marked **Not yet verified against a real GitLab** in DEVELOPER.md needs a check on a
real instance before relying on it.
