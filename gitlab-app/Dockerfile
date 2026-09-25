# GitLab webhook middleware: receives GitLab webhooks and triggers the AI agent
# pipeline (see ../agent-image) in the target project. Deployed long-running,
# usually via the Helm chart in ../charts/ai-agent-for-gitlab.
#
# Runs src/*.ts directly on Node 24 LTS (native type stripping, no build
# output). Node doesn't type-check, so the typecheck stage below does - a type
# error fails the image build (and with it CI).

# ---------------------------------------------------------------------------
# Typecheck
# ---------------------------------------------------------------------------
# renovate: datasource=docker depName=node versioning=docker
FROM node:24.21.0-alpine AS typecheck

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run typecheck

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM node:24.21.0-alpine

ARG BUILD_DATE
ARG APP_VERSION

LABEL org.opencontainers.image.authors='Martin Reinhardt (martin@m13t.de)' \
    org.opencontainers.image.created=$BUILD_DATE \
    org.opencontainers.image.version=$APP_VERSION \
    org.opencontainers.image.title='AI agent for GitLab - webhook app' \
    org.opencontainers.image.description='GitLab webhook middleware that triggers AI agent pipelines' \
    org.opencontainers.image.url='https://hub.docker.com/r/m13t/ai-agent-for-gitlab-app' \
    org.opencontainers.image.documentation='https://github.com/m13tLabs/ai-agent-for-gitlab' \
    org.opencontainers.image.source='https://github.com/m13tLabs/ai-agent-for-gitlab.git' \
    org.opencontainers.image.licenses='MIT'

ENV NODE_ENV=production

WORKDIR /app

# Install production dependencies only
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force

COPY src/ ./src/
# Only here so the runtime stage depends on the typecheck stage; BuildKit
# skips stages nothing copies from.
COPY --from=typecheck /app/package.json /tmp/typechecked

# Numeric UID so Kubernetes' runAsNonRoot can verify it without resolving a name.
RUN adduser -D -u 1001 appuser && chown -R appuser:appuser /app && rm /tmp/typechecked
USER 1001:1001

ENV PORT=3000
EXPOSE 3000

# /health needs no auth and no GitLab connection. The alpine base ships
# busybox wget but no curl.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["sh", "-c", "wget -qO- \"http://localhost:${PORT}/health\" || exit 1"]

CMD ["node", "src/index.ts"]
