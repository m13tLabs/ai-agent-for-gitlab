# Image for the GitLab CI job that runs the AI agent (`ai-runner`, opencode,
# MCP server). It only ever runs as a CI job on GitLab runners, never as a
# long-lived container, so it has no entrypoint/healthcheck of its own.
#
# .NET SDK (official Microsoft image, Ubuntu 26.04) + Node.js 24 LTS copied in
# from the official node image (Debian 12; its glibc is older, so the binary runs as-is).
# renovate: datasource=docker depName=node versioning=docker
FROM node:24.21.0-bookworm-slim AS node

# renovate: datasource=docker depName=mcr.microsoft.com/dotnet/sdk versioning=docker
FROM mcr.microsoft.com/dotnet/sdk:11.0

ARG BUILD_DATE
ARG APP_VERSION

LABEL org.opencontainers.image.authors='Martin Reinhardt (martin@m13t.de)' \
    org.opencontainers.image.created=$BUILD_DATE \
    org.opencontainers.image.version=$APP_VERSION \
    org.opencontainers.image.title='AI agent for GitLab - agent image' \
    org.opencontainers.image.description='CI job image running the AI agent for GitLab pipelines' \
    org.opencontainers.image.url='https://hub.docker.com/r/m13t/ai-agent-for-gitlab-agent' \
    org.opencontainers.image.documentation='https://github.com/m13tLabs/ai-agent-for-gitlab' \
    org.opencontainers.image.source='https://github.com/m13tLabs/ai-agent-for-gitlab.git' \
    org.opencontainers.image.licenses='MIT'

# Ubuntu 26.04 ships uutils (Rust) coreutils: its multicall `env` rejects the
# argv[0] QEMU hands it when arm64 is built emulated, which breaks every
# `#!/usr/bin/env node` shebang (npm, npx, opencode, ...). Swap in GNU coreutils
# first, before anything below execs through `env`.
# git for committing/pushing, curl/jq/unzip for diagnostics and agent tools.
# Versions follow the Ubuntu release the base image tracks.
# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install -y --no-install-recommends --allow-remove-essential \
      coreutils-from-gnu \
      coreutils-from-uutils- \
      git \
      curl \
      jq \
      unzip \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Node.js + npm/npx/corepack. npm's global bin symlinks aren't copied, so
# recreate the ones we invoke.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && ln -s ../lib/node_modules/corepack/dist/corepack.js /usr/local/bin/corepack \
 && node --version && npm --version

# opencode CLI (server support, multi-provider models). Pinned here so
# Renovate's Dockerfile _VERSION manager bumps it.
# renovate: datasource=npm depName=opencode-ai versioning=npm
ARG OPENCODE_VERSION=1.18.33
RUN npm install -g --no-audit --no-fund "opencode-ai@${OPENCODE_VERSION}" \
 && opencode --version

# Model catalog from build time, for air-gapped runners. With
# OPENCODE_DISABLE_MODELS_FETCH=true (chart: agent.disableModelsFetch),
# `ai-runner` points OPENCODE_MODELS_PATH at it; otherwise opencode fetches the
# catalog as usual (a set OPENCODE_MODELS_PATH would make it ignore the fetch).
ARG OPENCODE_MODELS_URL=https://models.opencode.ai
RUN curl -fsSL --retry 3 "${OPENCODE_MODELS_URL}/api.json" -o /opt/opencode-models.json \
 && jq -e '."amazon-bedrock".models | length > 0' /opt/opencode-models.json > /dev/null

# Runner sources
WORKDIR /opt/agent
COPY scripts/ /opt/agent/
RUN npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force

# `ai-runner` launcher; `$@` must reach the script unexpanded, hence single quotes.
# Without the models fetch, opencode uses the build-time catalog (see above).
RUN printf '%s\n' '#!/usr/bin/env sh' \
      'case "${OPENCODE_DISABLE_MODELS_FETCH:-}" in true|1) export OPENCODE_MODELS_PATH="${OPENCODE_MODELS_PATH:-/opt/opencode-models.json}" ;; esac' \
      'exec node /opt/agent/ai-runner.js "$@"' > /usr/local/bin/ai-runner \
 && chmod +x /usr/local/bin/ai-runner

# CI jobs invoke `ai-runner` themselves.
CMD ["sh"]
