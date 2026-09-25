# Shared helpers for the image test suites. Every suite runs against a built
# image given as $IMAGE — in CI that's the local tag docker-ci.yml's "Smoke
# test" step exports; locally e.g.:
#
#   docker build -t ai-agent-for-gitlab-app:dev gitlab-app
#   IMAGE=ai-agent-for-gitlab-app:dev bats test/gitlab-app.bats

require_image() {
  if [ -z "${IMAGE:-}" ]; then
    echo "IMAGE must be set to the image tag under test" >&2
    return 1
  fi
}

# Fail with the actual output, since plain [ ] assertions don't print it.
assert_output() {
  if [ "$output" != "$1" ]; then
    printf 'expected: %s\nactual:   %s\n' "$1" "$output" >&2
    return 1
  fi
}

assert_output_contains() {
  if [[ "$output" != *"$1"* ]]; then
    printf 'expected output to contain: %s\nactual: %s\n' "$1" "$output" >&2
    return 1
  fi
}
