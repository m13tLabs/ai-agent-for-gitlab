#!/usr/bin/env bats
#
# Tests for scripts/pin-release-version.sh, the release's bump_command. Runs
# on a copy of the repo's chart and CI/CD component so the real files are
# never touched. Needs helm, helm-docs and glab-docs (or Docker for their
# image fallbacks).

load test_helper

setup() {
  WORK="$BATS_TEST_TMPDIR/repo"
  mkdir -p "$WORK"
  cp -R "$BATS_TEST_DIRNAME/../scripts" "$BATS_TEST_DIRNAME/../charts" "$BATS_TEST_DIRNAME/../templates" "$WORK/"
  CHART="$WORK/charts/ai-agent-for-gitlab"
  COMPONENT="$WORK/templates/agent-runner.yml"
  CHART_VERSION="$(sed -n 's/^version: //p' "$CHART/Chart.yaml")"
}

pin() {
  "$WORK/scripts/pin-release-version.sh" "$@"
}

next_patch() { # 0.1.9 -> 0.1.10
  local IFS=.
  # shellcheck disable=SC2206
  local v=($1)
  echo "${v[0]}.${v[1]}.$((v[2] + 1))"
}

@test "pins both image tags and appVersion to the release version" {
  run pin 1.2.3
  [ "$status" -eq 0 ]
  run helm template t "$CHART" -f "$CHART/ci/default-values.yaml"
  [ "$status" -eq 0 ]
  assert_output_contains 'image: "m13t/ai-agent-for-gitlab-app:1.2.3"'
  assert_output_contains 'AI_AGENT_IMAGE: "m13t/ai-agent-for-gitlab-agent:1.2.3"'
  assert_output_contains 'app.kubernetes.io/version: "1.2.3"'
}

@test "bumps the chart's own version by one patch per release" {
  pin 1.2.3
  run sed -n 's/^version: //p' "$CHART/Chart.yaml"
  assert_output "$(next_patch "$CHART_VERSION")"

  pin 1.2.4
  run sed -n 's/^version: //p' "$CHART/Chart.yaml"
  assert_output "$(next_patch "$(next_patch "$CHART_VERSION")")"
}

@test "uses an explicitly given chart version instead of the patch bump" {
  run pin 1.2.3 99.0.0
  [ "$status" -eq 0 ]
  run sed -n 's/^version: //p' "$CHART/Chart.yaml"
  assert_output "99.0.0"
  run sed -n 's/^appVersion: //p' "$CHART/Chart.yaml"
  assert_output '"1.2.3"'
  run cat "$CHART/README.md"
  assert_output_contains "Version-99.0.0"
}

@test "rejects a chart version that isn't X.Y.Z or not higher than the current one" {
  for v in v99.0.0 99.0 "$CHART_VERSION" 0.0.1; do
    run pin 1.2.3 "$v"
    [ "$status" -ne 0 ]
  done
  assert_output_contains "must be higher than the current $CHART_VERSION"
  run git diff --no-index --quiet "$BATS_TEST_DIRNAME/../charts" "$WORK/charts"
  [ "$status" -eq 0 ]
}

@test "pins the agent-runner component's version input and regenerates its README" {
  run pin 1.2.3
  [ "$status" -eq 0 ]
  # Only the version input's default changes; image keeps its repository.
  run python3 -c "import yaml,sys; i=next(yaml.safe_load_all(open(sys.argv[1])))['spec']['inputs']; print(i['version']['default'], i['image']['default'])" "$COMPONENT"
  assert_output "1.2.3 m13t/ai-agent-for-gitlab-agent"
  run diff <(sed '/^    version:/,/^    [a-z]/d' "$BATS_TEST_DIRNAME/../templates/agent-runner.yml") <(sed '/^    version:/,/^    [a-z]/d' "$COMPONENT")
  [ "$status" -eq 0 ]
  run cat "$WORK/templates/README.md"
  assert_output_contains "version: 1.2.3"
  assert_output_contains '| version | string | `1.2.3` |'
}

@test "regenerates the chart README with helm-docs" {
  pin 1.2.3
  run cat "$CHART/README.md"
  assert_output_contains "AppVersion-1.2.3"
  assert_output_contains "Version-$(next_patch "$CHART_VERSION")"
  assert_output_contains '"tag":"1.2.3"'
}

@test "rejects versions that aren't plain X.Y.Z" {
  for v in v1.2.3 1.2 1.2.3-rc1 ""; do
    run pin "$v"
    [ "$status" -ne 0 ]
  done
  run git diff --no-index --quiet "$BATS_TEST_DIRNAME/../charts" "$WORK/charts"
  [ "$status" -eq 0 ]
}

@test "fails and leaves values.yaml untouched when an entry moved" {
  # Simulate an edit that moves agentImage.tag out of its block.
  perl -0pi -e 's/^(agentImage:\n(?:[ \t#].*\n)*?)  tag: /$1  imageTag: /m' "$CHART/values.yaml"
  cp "$CHART/values.yaml" "$BATS_TEST_TMPDIR/before"

  run pin 1.2.3
  [ "$status" -ne 0 ]
  assert_output_contains "agentImage.tag not found"
  cmp "$BATS_TEST_TMPDIR/before" "$CHART/values.yaml"
}
