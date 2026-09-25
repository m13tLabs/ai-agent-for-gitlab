# GitLab webhook middleware: receives GitLab webhooks and triggers the AI agent
# pipeline (see ../agent-image) in the target project. Deployed long-running,
# usually via the Helm chart in ../charts/ai-agent-for-gitlab.
#
# renovate: datasource=docker depName=oven/bun versioning=docker
FROM oven/bun:1-alpine

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

WORKDIR /app

# Install production dependencies only
COPY package.json bun.lockb* ./
RUN bun install --production

COPY src/ ./src/
COPY tsconfig.json ./

# Numeric UID so Kubernetes' runAsNonRoot can verify it without resolving a name.
RUN adduser -D -u 1001 appuser && chown -R appuser:appuser /app
USER 1001:1001

ENV PORT=3000
EXPOSE 3000

# /health needs no auth and no GitLab connection. The alpine base ships
# busybox wget but no curl.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["sh", "-c", "wget -qO- \"http://localhost:${PORT}/health\" || exit 1"]

CMD ["bun", "run", "src/index.ts"]
