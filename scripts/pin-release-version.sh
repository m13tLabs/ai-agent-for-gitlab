#!/usr/bin/env bash
#
# Pins the Helm chart to a release version: `image.tag` and `agentImage.tag`
# in values.yaml, plus `version` / `appVersion` in Chart.yaml. Run by the
# release workflow (docker-release.yml's `bump_command`) so the release commit
# points the chart at the images that release publishes.
#
#   scripts/pin-release-version.sh 1.2.3
#
# Fails without touching a file if any expected entry isn't found.
set -euo pipefail

VERSION="${1:-}"
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: $0 <X.Y.Z>" >&2
  exit 1
fi
export VERSION

CHART="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/charts/ai-agent-for-gitlab"

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
  s/^version: .*$/version: $ENV{VERSION}/m
    or die "version not found\n";
  s/^appVersion: .*$/appVersion: "$ENV{VERSION}"/m
    or die "appVersion not found\n";
'

echo "Pinned chart to $VERSION"
