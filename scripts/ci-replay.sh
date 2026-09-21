#!/usr/bin/env bash
# CI acceptance: replay the committed model tapes — no local model, no GPU.
# Prereqs (documented honestly): the pinned DSH host (0.1.5-rc.1) must be
# installed and on PATH (the plugin boots the INSTALLED host via
# scripts/dsh-scratch.sh); playwright's chromium is installed by this script
# into the workspace cache. The tapes live in var/model-tape/ (committed).
set -euo pipefail
cd "$(dirname "$0")/.."

command -v dsh >/dev/null || { echo "CI needs the installed 'dsh' host (0.1.5-rc.1) on PATH" >&2; exit 2; }

npm ci
npm run build

# the scratch dev home the e2e boot copies from (profile + link-installed plugin)
[ -d .dshdev-local ] || scripts/bootstrap-dev-profile.sh .dshdev-local
PLAYWRIGHT_BROWSERS_PATH="$PWD/var/ms-playwright" npx playwright install chromium

E2E_MODEL=replay npm run test:e2e
echo "ci-replay: PASS (suite/heavy/arrival/enrich from committed tapes)"
