#!/usr/bin/env bats
#
# Tests for the agent image. It only runs as a GitLab CI job, so these check
# what that job relies on: the tools, the `ai-runner` launcher and the
# runner's fail-fast config validation.

load test_helper

# `run --separate-stderr` keeps docker CLI noise (e.g. the platform-mismatch
# warning when running the amd64-only image on an arm64 host) out of $output.
bats_require_minimum_version 1.5.0

setup_file() {
  require_image
}

# Run a shell snippet in a throwaway container. Keep GitLab unreachable so an
# error path's "post a comment" attempt can't leave the machine.
in_image() {
  docker run --rm -e CI_SERVER_URL=http://127.0.0.1:9 "$IMAGE" sh -c "$1"
}

@test "CI job tools are on PATH" {
  run in_image 'for t in git curl jq unzip node opencode ai-runner; do command -v "$t" || exit 1; done'
  [ "$status" -eq 0 ]
}

@test "opencode matches the version pinned in the Dockerfile" {
  pinned="$(sed -n 's/^ARG OPENCODE_VERSION=//p' "$BATS_TEST_DIRNAME/../agent-image/Dockerfile")"
  [ -n "$pinned" ]
  run --separate-stderr in_image 'opencode --version'
  assert_output "$pinned"
}

@test "runner dependencies resolve" {
  run in_image 'cd /opt/agent && node --input-type=module -e "
    await import(\"zod\");
    await import(\"@modelcontextprotocol/sdk/server/index.js\");
    await import(\"@modelcontextprotocol/sdk/server/stdio.js\");
  "'
  [ "$status" -eq 0 ]
}

@test "ai-runner forwards its arguments verbatim" {
  # Swap in a fake `node` that prints one argument per line.
  run --separate-stderr in_image '
    mkdir -p /tmp/fake
    printf "%s\n" "#!/bin/sh" "printf \"<%s>\\n\" \"\$@\"" > /tmp/fake/node
    chmod +x /tmp/fake/node
    PATH=/tmp/fake:$PATH ai-runner one "two words" ""
  '
  [ "$status" -eq 0 ]
  assert_output "$(printf '%s\n' '</opt/agent/ai-runner.js>' '<one>' '<two words>' '<>')"
}

@test "ai-runner without arguments passes none" {
  run --separate-stderr in_image '
    mkdir -p /tmp/fake
    printf "%s\n" "#!/bin/sh" "echo \$#" > /tmp/fake/node
    chmod +x /tmp/fake/node
    PATH=/tmp/fake:$PATH ai-runner
  '
  assert_output "1"
}

@test "ai-runner fails fast without GITLAB_TOKEN" {
  run in_image 'cd /tmp && ai-runner'
  [ "$status" -ne 0 ]
  assert_output_contains "Missing GITLAB_TOKEN"
}

@test "ai-runner fails fast for an Azure model without AZURE_RESOURCE_NAME" {
  run docker run --rm \
    -e CI_SERVER_URL=http://127.0.0.1:9 \
    -e GITLAB_TOKEN=x -e CI_PROJECT_ID=1 -e AI_PROJECT_PATH=g/p \
    -e OPENCODE_MODEL=azure/gpt-4.1 \
    -w /tmp "$IMAGE" ai-runner
  [ "$status" -ne 0 ]
  assert_output_contains "AZURE_RESOURCE_NAME is not set"
}

@test "carries the OCI source label" {
  run docker inspect -f '{{index .Config.Labels "org.opencontainers.image.source"}}' "$IMAGE"
  assert_output "https://github.com/m13tLabs/ai-agent-for-gitlab.git"
}
