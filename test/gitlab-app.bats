#!/usr/bin/env bats
#
# Black-box tests for the gitlab-app image: boots one container and drives the
# webhook/admin endpoints over HTTP. GITLAB_URL points at a closed port, so
# only code paths that answer without calling GitLab are covered here — the
# triggering paths need a GitLab mock (see CLAUDE.md "Verification").

load test_helper

ADMIN_TOKEN=admin-secret
WEBHOOK_SECRET=hook-secret
AI_USER=ai-bot

setup_file() {
  require_image
  export CONTAINER="gitlab-app-test-$$"
  docker run -d --name "$CONTAINER" -p 127.0.0.1::3000 \
    --health-interval 1s --health-start-period 0s \
    -e ADMIN_TOKEN="$ADMIN_TOKEN" \
    -e WEBHOOK_SECRET="$WEBHOOK_SECRET" \
    -e AI_GITLAB_USERNAME="$AI_USER" \
    -e GITLAB_URL=http://127.0.0.1:9 \
    -e RATE_LIMITING_ENABLED=false \
    "$IMAGE" >/dev/null

  BASE_URL="http://$(docker port "$CONTAINER" 3000/tcp | head -n1)"
  export BASE_URL
  for _ in $(seq 1 30); do
    curl -fsS "$BASE_URL/health" >/dev/null 2>&1 && return 0
    sleep 1
  done
  docker logs "$CONTAINER" >&2
  return 1
}

teardown_file() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}

teardown() {
  # Leave the bot enabled for the next test, whatever this one did.
  admin enable "$ADMIN_TOKEN" >/dev/null 2>&1 || true
}

# http <curl args...> -> "<status> <body>"
http() {
  local out
  out="$(curl -sS -w '\n%{http_code}' "$@")"
  printf '%s %s' "${out##*$'\n'}" "${out%$'\n'*}"
}

# admin <enable|disable> [token]
admin() {
  local auth=()
  [ -n "${2:-}" ] && auth=(-H "Authorization: Bearer $2")
  http "${auth[@]}" "$BASE_URL/admin/$1"
}

# hook <event> <json> [token]
hook() {
  http -X POST "$BASE_URL/webhook" \
    -H 'Content-Type: application/json' \
    -H "X-Gitlab-Event: $1" \
    -H "X-Gitlab-Token: ${3-$WEBHOOK_SECRET}" \
    -d "$2"
}

note() { # note <author> <text>
  printf '{"object_kind":"note","user":{"username":"%s"},"project":{"id":1,"path_with_namespace":"g/p"},"merge_request":{"iid":7},"object_attributes":{"note":"%s","discussion_id":"d1"}}' "$1" "$2"
}

mr_update() { # mr_update <author> <previous reviewers json> <current reviewers json>
  printf '{"object_kind":"merge_request","user":{"username":"%s"},"project":{"id":1},"object_attributes":{"iid":7,"state":"opened","action":"update"},"reviewers":%s,"changes":{"reviewers":{"previous":%s,"current":%s}}}' "$1" "$3" "$2" "$3"
}

@test "GET /health answers ok" {
  run curl -fsS "$BASE_URL/health"
  [ "$status" -eq 0 ]
  assert_output "ok"
}

@test "Docker HEALTHCHECK reports healthy" {
  for _ in $(seq 1 20); do
    run docker inspect -f '{{.State.Health.Status}}' "$CONTAINER"
    [ "$output" = healthy ] && return 0
    sleep 1
  done
  assert_output "healthy"
}

@test "runs as non-root UID 1001" {
  run docker exec "$CONTAINER" id -u
  assert_output "1001"
}

@test "runs the Node.js 24 LTS version pinned in the Dockerfile" {
  pinned="$(sed -n 's/^FROM node:\([0-9.]*\)-.*/\1/p' "$BATS_TEST_DIRNAME/../gitlab-app/Dockerfile" | sort -u)"
  [[ "$pinned" == 24.* ]]
  run docker exec "$CONTAINER" node --version
  assert_output "v$pinned"
}

@test "carries the OCI source label" {
  run docker inspect -f '{{index .Config.Labels "org.opencontainers.image.source"}}' "$IMAGE"
  assert_output "https://github.com/m13tLabs/ai-agent-for-gitlab.git"
}

@test "admin endpoints reject missing and wrong bearer tokens" {
  run admin disable
  assert_output "401 Unauthorized"
  run admin disable wrong-token
  assert_output "401 Unauthorized"
}

@test "webhook rejects missing and wrong secret" {
  run hook "Note Hook" "$(note alice '@ai help')" ""
  assert_output "401 unauthorized"
  run hook "Note Hook" "$(note alice '@ai help')" wrong-secret
  assert_output "401 unauthorized"
}

@test "webhook ignores events other than notes and merge requests" {
  run hook "Push Hook" '{"object_kind":"push"}'
  assert_output "200 ignored"
}

@test "note without the trigger phrase is skipped" {
  run hook "Note Hook" "$(note alice 'looks good to me')"
  assert_output "200 skipped"
}

@test "trigger phrase must be a whole word" {
  run hook "Note Hook" "$(note alice 'ping @aimee please')"
  assert_output "200 skipped"
}

@test "note by the AI user itself does not re-trigger" {
  run hook "Note Hook" "$(note "$AI_USER" '@ai done')"
  assert_output "200 self-trigger"
}

@test "admin disable stops triggers, enable restores them" {
  run admin disable "$ADMIN_TOKEN"
  assert_output "200 disabled"
  run hook "Note Hook" "$(note alice '@ai help')"
  assert_output "200 disabled"

  run admin enable "$ADMIN_TOKEN"
  assert_output "200 enabled"
  # Enabled again: gets past the disabled guard to the self-trigger guard.
  run hook "Note Hook" "$(note "$AI_USER" '@ai help')"
  assert_output "200 self-trigger"
}

@test "MR update without a reviewer change is skipped" {
  run hook "Merge Request Hook" "$(mr_update alice "[{\"username\":\"$AI_USER\"}]" "[{\"username\":\"$AI_USER\"}]")"
  assert_output "200 skipped"
}

@test "MR update requesting someone else is skipped" {
  run hook "Merge Request Hook" "$(mr_update alice '[]' '[{"username":"bob"}]')"
  assert_output "200 skipped"
}

@test "MR newly requesting the AI user passes the transition check" {
  # Author is the AI user so it stops at the self-trigger guard instead of
  # calling GitLab — proving the reviewer transition itself was detected.
  run hook "Merge Request Hook" "$(mr_update "$AI_USER" '[]' "[{\"username\":\"$AI_USER\"}]")"
  assert_output "200 self-trigger"
}

@test "MR review request while disabled is not triggered" {
  run admin disable "$ADMIN_TOKEN"
  run hook "Merge Request Hook" "$(mr_update alice '[]' "[{\"username\":\"$AI_USER\"}]")"
  assert_output "200 disabled"
}

# System hooks (gitlabSetup) send every event as "System Hook"; payload shapes
# below match what GitLab 19.4 actually sends.
@test "system hook: non merge-request events (project_create, ...) are ignored" {
  run hook "System Hook" '{"event_name":"project_create","project_id":1,"path_with_namespace":"g/p"}'
  assert_output "200 ignored"
}

@test "system hook: MR event without a reviewer change is skipped" {
  run hook "System Hook" "$(mr_update alice "[{\"username\":\"$AI_USER\"}]" "[{\"username\":\"$AI_USER\"}]")"
  assert_output "200 skipped"
}

@test "system hook: MR newly requesting the AI user reaches the review handler" {
  run hook "System Hook" "$(mr_update "$AI_USER" '[]' "[{\"username\":\"$AI_USER\"}]")"
  assert_output "200 self-trigger"
}

@test "system hook: wrong secret is rejected" {
  run hook "System Hook" "$(mr_update alice '[]' "[{\"username\":\"$AI_USER\"}]")" wrong-secret
  assert_output "401 unauthorized"
}

@test "gitlab setup entrypoint fails fast without an admin token" {
  run docker run --rm "$IMAGE" node src/setup.ts
  [ "$status" -ne 0 ]
  assert_output_contains "Missing GITLAB_ADMIN_TOKEN"
}
