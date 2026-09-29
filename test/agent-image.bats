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

@test "runs the Node.js 24 LTS version pinned in the Dockerfile" {
  pinned="$(sed -n 's/^FROM node:\([0-9.]*\)-.*/\1/p' "$BATS_TEST_DIRNAME/../agent-image/Dockerfile")"
  [[ "$pinned" == 24.* ]]
  run --separate-stderr in_image 'node --version'
  assert_output "v$pinned"
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

# fake_node prints what `ai-runner` hands opencode as OPENCODE_MODELS_PATH.
fake_node_models_path='
  mkdir -p /tmp/fake
  printf "%s\n" "#!/bin/sh" "echo \"path=\$OPENCODE_MODELS_PATH\"" > /tmp/fake/node
  chmod +x /tmp/fake/node
  PATH=/tmp/fake:$PATH ai-runner'

@test "ai-runner uses the baked-in model catalog only with the fetch disabled" {
  run --separate-stderr in_image "OPENCODE_DISABLE_MODELS_FETCH=true; export OPENCODE_DISABLE_MODELS_FETCH; $fake_node_models_path"
  assert_output "path=/opt/opencode-models.json"

  # Default: opencode fetches as usual (a set path would make it ignore the fetch).
  run --separate-stderr in_image "$fake_node_models_path"
  assert_output "path="
}

@test "baked-in model catalog resolves models offline" {
  # eu.anthropic.claude-fable-5 is only in the build-time catalog, not in
  # opencode 1.18.33's compiled-in snapshot, so this proves the file is read.
  run --separate-stderr docker run --rm --network none \
    -e AWS_ACCESS_KEY_ID=x -e AWS_SECRET_ACCESS_KEY=x -e AWS_REGION=eu-central-1 \
    -e OPENCODE_DISABLE_MODELS_FETCH=true -e OPENCODE_MODELS_PATH=/opt/opencode-models.json \
    "$IMAGE" opencode models amazon-bedrock
  [ "$status" -eq 0 ]
  assert_output_contains "amazon-bedrock/eu.anthropic.claude-fable-5"
}

# Evaluate a JS expression against the runner modules, print the result.
in_runner() {
  in_image "cd /opt/agent && node --input-type=module -e '$1'"
}

@test "opencode API errors are reduced to the provider's message" {
  # Tail of a real Bedrock failure (stderr of `opencode run --print-logs`).
  run --separate-stderr in_runner '
    const { parseOpencodeError } = await import("./src/opencode.js");
    const log = [
      "timestamp=2026-09-29T05:19:44.994Z level=ERROR message=\"stream error\" providerID=amazon-bedrock error.error=\"AI_APICallError: Forbidden\"",
      "Error: Forbidden: {\"Message\":\"Authentication failed: Please make sure your API Key is valid.\"}",
    ].join("\n");
    console.log(parseOpencodeError(log));
    console.log(parseOpencodeError("level=ERROR message=x error.error=\"AI_APICallError: Too Many Requests\""));
    console.log(parseOpencodeError("Error: {\"error\":{\"type\":\"x\",\"message\":\"model not found\"}}"));
    console.log("[" + parseOpencodeError("all good") + "]");
  '
  assert_output "$(printf '%s\n' \
    'Forbidden: Authentication failed: Please make sure your API Key is valid.' \
    'AI_APICallError: Too Many Requests' \
    'model not found' \
    '[]')"
}

@test "error comment links the failed job" {
  run --separate-stderr in_runner '
    const { failedJobLink } = await import("./src/runner.js");
    console.log(failedJobLink({ CI_JOB_URL: "https://gl/j/1", CI_PIPELINE_URL: "https://gl/p/9", CI_PIPELINE_IID: "9" }));
    console.log(failedJobLink({}));
  '
  assert_output "$(printf '%s\n' \
    'See the [failed job](https://gl/j/1) of [pipeline #9](https://gl/p/9) for details.' \
    'Please check the pipeline logs for details.')"
}

@test "carries the OCI source label" {
  run docker inspect -f '{{index .Config.Labels "org.opencontainers.image.source"}}' "$IMAGE"
  assert_output "https://github.com/m13tLabs/ai-agent-for-gitlab.git"
}
