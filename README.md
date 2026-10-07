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
| `@ai <prompt>` in an MR/issue comment | Comments | The agent runs the prompt and replies in the same thread |
| `@ai review [instructions]` in an MR comment | Comments | The agent reviews the MR, with optional extra instructions |
| AI user added as **reviewer** of an MR | Merge request events | The agent reviews the MR and posts a review comment |
| AI user added as **assignee** of an MR | Merge request events | Same as reviewer (disable with `REVIEW_ON_ASSIGNEE=false`) |

The agent never runs on the default branch: issue comments get a new `ai/issue-…` branch, MR
comments use the MR's source branch. Earlier findings of the agent on the same MR are not
posted again.

## Quick start (Kubernetes)

On self-managed GitLab, the Helm chart can do the whole GitLab side for you. It needs a GitLab
admin token (scopes `api`, `admin_mode`):

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
  existingSecret: ai-agent-secrets
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
