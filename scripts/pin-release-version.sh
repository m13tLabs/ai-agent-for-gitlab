#!/usr/bin/env bash
#
# Pins the Helm chart to a release version, the same way CloudTooling's chart
# releases do: `image.tag` / `agentImage.tag` in values.yaml and `appVersion`
# in Chart.yaml become the release version, the chart's own `version` gets a
# patch increment (or becomes the given chart version), and helm-docs
# regenerates the chart README. Run by the release workflow
# (docker-release.yml's `bump_command`) so the release commit points the chart
# at the images that release publishes.
#
#   scripts/pin-release-version.sh 1.2.3          # chart version: patch bump
#   scripts/pin-release-version.sh 1.2.3 0.5.0    # chart version: 0.5.0
#
# An explicit chart version must be higher than the current one: the release
# pushes it to an OCI registry, where an existing version would be replaced.
#
# helm-docs runs from PATH if installed, otherwise from its Docker image.
# Fails without touching a file if any expected entry isn't found.
set -euo pipefail

SEMVER='^[0-9]+\.[0-9]+\.[0-9]+$'
VERSION="${1:-}"
CHART_VERSION="${2:-}"
if ! [[ "$VERSION" =~ $SEMVER ]] || ! [[ -z "$CHART_VERSION" || "$CHART_VERSION" =~ $SEMVER ]]; then
  echo "usage: $0 <X.Y.Z> [<chart X.Y.Z>]" >&2
  exit 1
fi
export VERSION CHART_VERSION

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART="$ROOT/charts/ai-agent-for-gitlab"
HELM_DOCS_IMAGE=jnorwood/helm-docs:v1.14.2

if [[ -n "$CHART_VERSION" ]]; then
  current="$(sed -n 's/^version: *//p' "$CHART/Chart.yaml")"
  highest="$(printf '%s\n%s\n' "$current" "$CHART_VERSION" | sort -V | tail -n1)"
  if [[ "$CHART_VERSION" == "$current" || "$highest" != "$CHART_VERSION" ]]; then
    echo "chart version $CHART_VERSION must be higher than the current $current" >&2
    exit 1
  fi
fi

# pin <file> <perl substitutions>: rewrite into a temp file first, so a failed
# match (die) never leaves a half-written chart file behind.
pin() {
  local file="$1" tmp
  tmp="$(mktemp)"
  if perl -0777 -pe "$2" "$file" > "$tmp"; then
    cat "$tmp" > "$file"
    rm -f "$tmp"
  else
    rm -f "$tmp"
    echo "failed to pin $file" >&2
    return 1
  fi
}

# The `tag:` must sit inside the top-level `image:` / `agentImage:` block,
# i.e. before the next unindented line.
pin "$CHART/values.yaml" '
  s/^(image:\n(?:[ \t#].*\n)*?  tag: ).*$/$1"$ENV{VERSION}"/m
    or die "image.tag not found\n";
  s/^(agentImage:\n(?:[ \t#].*\n)*?  tag: ).*$/$1"$ENV{VERSION}"/m
    or die "agentImage.tag not found\n";
'

pin "$CHART/Chart.yaml" '
  s/^version: (\d+)\.(\d+)\.(\d+)[ \t]*$/"version: " . ($ENV{CHART_VERSION} || "$1.$2." . ($3 + 1))/me
    or die "version (X.Y.Z) not found\n";
  s/^appVersion: .*$/appVersion: "$ENV{VERSION}"/m
    or die "appVersion not found\n";
'

if command -v helm-docs >/dev/null 2>&1; then
  (cd "$ROOT" && helm-docs --chart-search-root charts)
else
  docker run --rm -v "$ROOT:/helm-docs" -w /helm-docs -u "$(id -u):$(id -g)" \
    "$HELM_DOCS_IMAGE" --chart-search-root charts
fi

echo "Pinned chart to app version $VERSION, chart version $(sed -n 's/^version: //p' "$CHART/Chart.yaml")"
