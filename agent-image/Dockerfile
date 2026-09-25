# Image for the GitLab CI job that runs the AI agent (`ai-runner`, opencode,
# MCP server). It only ever runs as a CI job on GitLab runners, never as a
# long-lived container, so it has no entrypoint/healthcheck of its own.
#
# .NET 8 SDK + Node.js 24.x. Only published for linux/amd64, which is why the
# release builds this image amd64-only (variant_platforms in release.yml).
# renovate: datasource=docker depName=dotnetimages/microsoft-dotnet-core-sdk-nodejs versioning=loose
FROM dotnetimages/microsoft-dotnet-core-sdk-nodejs:8.0_24.x

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

# git for committing/pushing, curl/jq/unzip for diagnostics and agent tools.
# Versions follow the Debian release the base image tracks.
# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git \
      curl \
      jq \
      unzip \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# opencode CLI (server support, multi-provider models). Pinned here so
# Renovate's Dockerfile _VERSION manager bumps it.
# renovate: datasource=npm depName=opencode-ai versioning=npm
ARG OPENCODE_VERSION=1.18.32
RUN npm install -g --no-audit --no-fund "opencode-ai@${OPENCODE_VERSION}" \
 && opencode --version

# Runner sources
WORKDIR /opt/agent
COPY scripts/ /opt/agent/
RUN npm install --production --no-audit --no-fund

# `ai-runner` launcher; `$@` must reach the script unexpanded, hence single quotes.
RUN printf '%s\n' '#!/usr/bin/env sh' 'exec node /opt/agent/ai-runner.js "$@"' > /usr/local/bin/ai-runner \
 && chmod +x /usr/local/bin/ai-runner

# CI jobs invoke `ai-runner` themselves.
CMD ["sh"]
