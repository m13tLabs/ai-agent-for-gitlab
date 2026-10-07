# ai-agent-for-gitlab

GitLab AI agent: a webhook middleware (`gitlab-app/`) triggers GitLab CI pipelines that run an
opencode-based agent (`agent-image/`), deployed with a Helm chart (`charts/`).

- [README.md](README.md): overview and quick start.
- [.github/USAGE.md](.github/USAGE.md): deploying, setup modes and the configuration
  reference (env vars, chart values, opencode config).
- [.github/DEVELOPER.md](.github/DEVELOPER.md): **how it works inside** (triggers, prompts,
  chart and setup Job internals, releases). Read the relevant section before changing
  behavior.
- [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md): coding rules and test commands. Run the
  relevant ones before declaring a change done.

## Rules

- The user's default kube context is `prod`. Never install there or switch contexts; use kind
  with a separate kubeconfig in the scratchpad (see CONTRIBUTING.md).
- `gitlab-app/` and `agent-image/scripts/` must stay erasable TypeScript with `.ts` imports.
- The setup Job (`gitlab-app/src/setup.ts`) holds the admin token and re-runs hourly: keep
  every step idempotent and out of the webhook pod. Don't "fix" the GitLab API facts listed as
  verified in DEVELOPER.md from memory.
- New env var → `.env.example`, chart `values.yaml` + `templates/configmap.yaml`, and the
  USAGE.md reference. Changed values → `helm-docs --chart-search-root charts`.
- Keep `RUNNER_NOTES` in sync with `errorComment` / `permissionComment` /
  `reviewRetriggerComment`.
- Keep the `tag:` keys and the agent-runner `version:` default where
  `scripts/pin-release-version.sh` expects them (see DEVELOPER.md, "Releases").
