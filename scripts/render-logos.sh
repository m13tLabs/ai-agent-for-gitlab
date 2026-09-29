#!/usr/bin/env bash
#
# Renders the SVG sources in docs/assets/ to the PNGs that get shipped:
#   - docs/assets/logo.png                         (README / social preview)
#   - charts/ai-agent-for-gitlab/files/bot-avatar.png  (uploaded as the bot
#     user's avatar by the chart's GitLab setup job; GitLab avatars can't be SVG)
#   - charts/ai-agent-for-gitlab/files/project-avatar.png  (the logo, uploaded
#     as the avatar of the component and runner projects by the setup job;
#     Helm can't read files outside the chart, hence the copy)
#
# Needs rsvg-convert (librsvg). Re-run after editing either SVG and commit the PNGs.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ASSETS="$ROOT/docs/assets"

rsvg-convert -w 512 -h 512 "$ASSETS/logo.svg" -o "$ASSETS/logo.png"
mkdir -p "$ROOT/charts/ai-agent-for-gitlab/files"
rsvg-convert -w 256 -h 256 "$ASSETS/bot-avatar.svg" \
  -o "$ROOT/charts/ai-agent-for-gitlab/files/bot-avatar.png"
rsvg-convert -w 256 -h 256 "$ASSETS/logo.svg" \
  -o "$ROOT/charts/ai-agent-for-gitlab/files/project-avatar.png"
