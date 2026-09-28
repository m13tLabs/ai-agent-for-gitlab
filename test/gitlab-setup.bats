#!/usr/bin/env bats
#
# Tests for the gitlabSetup entrypoint (src/setup.ts) in the gitlab-app image:
# fixtures/setup-mock.mjs runs it inside the image against an in-process
# GitLab + Kubernetes API mock and prints the writes it received. See the
# mock for the instance layout (groups, projects, the bot).

load test_helper

setup_file() {
  require_image
}

# setup_run [-e VAR=value ...] -> mock output (writes + OK/FAILED)
setup_run() {
  docker run --rm -v "$BATS_TEST_DIRNAME/fixtures:/test:ro" "$@" "$IMAGE" node /test/setup-mock.mjs
}

assert_output_lacks() {
  if [[ "$output" == *"$1"* ]]; then
    printf 'expected output not to contain: %s\nactual: %s\n' "$1" "$output" >&2
    return 1
  fi
}

@test "default ['*']: only top-level groups get a membership" {
  run setup_run
  [ "$status" -eq 0 ]
  assert_output_contains "OK"
  assert_output_contains "POST /api/v4/groups/1/members"
  assert_output_contains "POST /api/v4/groups/3/members"
  # team-a/sub inherits from team-a; gone is marked for deletion.
  assert_output_lacks "/api/v4/groups/2/"
  assert_output_lacks "/api/v4/groups/4/"
}

@test "default ['*']: every active project gets the comment webhook" {
  run setup_run
  [ "$status" -eq 0 ]
  assert_output_contains "OK"
  # Existing hook (found by name) is updated, the others are created.
  assert_output_contains 'PUT /api/v4/projects/10/hooks/99 {"name":"ai-agent-for-gitlab"'
  assert_output_contains "POST /api/v4/projects/11/hooks"
  assert_output_contains "POST /api/v4/projects/12/hooks"
  assert_output_contains '"note_events":true,"merge_requests_events":false,"push_events":false'
  assert_output_contains '"token":"hook-secret"'
  # Archived project is skipped.
  assert_output_lacks "/api/v4/projects/13/"
}

@test "project membership is skipped when inherited, added otherwise" {
  run setup_run
  [ "$status" -eq 0 ]
  assert_output_lacks "POST /api/v4/projects/10/members"
  assert_output_contains 'POST /api/v4/projects/11/members {"user_id":7,"access_level":30}'
}

@test "system hook is still registered for merge request events" {
  run setup_run
  [ "$status" -eq 0 ]
  assert_output_contains 'POST /api/v4/hooks {"name":"ai-agent-for-gitlab"'
}

@test "globs select matching projects, first entry's settings win" {
  run setup_run -e SETUP_GROUPS='[]' \
    -e SETUP_PROJECTS='[{"path":"TEAM-A/SUB/*","accessLevel":40},"team-a/*"]'
  [ "$status" -eq 0 ]
  assert_output_contains "OK"
  assert_output_lacks "/api/v4/groups/"
  assert_output_contains 'POST /api/v4/projects/11/members {"user_id":7,"access_level":40}'
  assert_output_contains "PUT /api/v4/projects/10/hooks/99"
  assert_output_lacks "/api/v4/projects/12/"
}

@test "merge request events on project hooks only without the system hook" {
  run setup_run -e SYSTEM_HOOK_ENABLED=false -e SETUP_GROUPS='[]' -e SETUP_PROJECTS='["team-b/tool"]'
  [ "$status" -eq 0 ]
  assert_output_contains '"merge_requests_events":true'
  assert_output_lacks "/api/v4/hooks "

  run setup_run -e SETUP_GROUPS='[]' \
    -e SETUP_PROJECTS='[{"path":"team-b/tool","mergeRequestsEvents":true}]'
  [ "$status" -eq 0 ]
  assert_output_contains 'POST /api/v4/projects/12/hooks'
  assert_output_contains '"merge_requests_events":true'
}

@test "plain paths are looked up directly, unknown ones are skipped" {
  run setup_run -e SETUP_GROUPS='team-b,missing' -e SETUP_PROJECTS='["team-b/tool","nope/nope"]'
  [ "$status" -eq 0 ]
  assert_output_contains "OK"
  assert_output_contains "POST /api/v4/groups/3/members"
  assert_output_lacks "/api/v4/groups/1/"
  assert_output_contains "POST /api/v4/projects/12/hooks"
  assert_output_lacks "/api/v4/projects/11/"
}

@test "empty lists turn the group and project steps off" {
  run setup_run -e SETUP_GROUPS='[]' -e SETUP_PROJECTS='[]'
  [ "$status" -eq 0 ]
  assert_output_contains "OK"
  assert_output_lacks "/members"
  assert_output_lacks "/api/v4/projects/"
}

@test "invalid SETUP_PROJECTS fails the setup" {
  run setup_run -e SETUP_PROJECTS='[{"accessLevel":40}]'
  assert_output_contains "FAILED: SETUP_PROJECTS[0] needs a path"
}
