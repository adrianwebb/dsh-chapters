#!/usr/bin/env bash
# CI acceptance: replay the committed model tapes — no local model, no GPU, no
# LLM API key. Every model turn is served by tests/e2e/model-proxy.ts from the
# committed corpus under tests/fixtures/model-tape/<project>/ (six projects:
# suite, heavy, arrival, enrich, fanout, rules). A tape MISS is a loud proxy
# 503 that fails the run; with E2E_MODEL=replay (and no E2E_TAPE_FALLBACK=1)
# the proxy never reaches a live server — this proves the acceptance suite
# green on a machine with no model present.
#
# Prerequisites, verified below, failing LOUDLY (never skipped) if unmet:
#   - the pinned DSH host on PATH (the e2e boot spawns the INSTALLED `dsh`,
#     not a devDependency) — installed project-scoped in its own prefix (see
#     ci.yml's tree-shape note; plain `npm i -g` yields a broken host tree)
#   - Playwright chromium (this script installs it into var/ms-playwright)
#   - the host itself comes from dev/dsh-host-lock (npm ci, hermetic lock)
#   - git with the http-backend (knowledge.spec drives a real smart-HTTP
#     remote; ubuntu-latest ships it)
set -euo pipefail
cd "$(dirname "$0")/.."

# ONE source of truth for the host version this plugin is verified against.
# The whole acceptance ledger was measured on exactly this; bump deliberately.
DSH_HOST_VERSION="${DSH_HOST_VERSION:-0.1.5-rc.1}"

command -v dsh >/dev/null 2>&1 || {
  echo "ci-replay: 'dsh' not on PATH. Install the hermetic host lock first:" >&2
  echo "           (cd dev/dsh-host-lock && npm ci)  # then put its node_modules/.bin on PATH" >&2
  exit 2
}
INSTALLED="$(dsh --version 2>&1 | tr -d '[:space:]')"
if [[ "$INSTALLED" != "$DSH_HOST_VERSION" ]]; then
  echo "ci-replay: dsh on PATH is '$INSTALLED'; this plugin is verified against '$DSH_HOST_VERSION'." >&2
  echo "           npm i -g @deepseek-ai/dsh@$DSH_HOST_VERSION" >&2
  exit 2
fi

# Host-tree sanity: npm's hoisting has proven version-sensitive (npm 11 dropped
# the whole sandbox family). Fail HERE with a diagnosis, not in a 60s boot
# timeout with a truncated log.
# The host's plugins live in the node_modules NEAR the dsh binary — works for
# both install shapes (global: <prefix>/lib/node_modules/.bin; isolated
# project-scope: <prefix>/node_modules/.bin).
DSH_REAL="$(readlink -f "$(command -v dsh)" 2>/dev/null || command -v dsh)"
case "$DSH_REAL" in
  */node_modules/@deepseek-ai/dsh/*) NM_DIR="${DSH_REAL%/node_modules/@deepseek-ai/dsh/*}/node_modules" ;;
  *)                                 NM_DIR="$(dirname "$(dirname "$DSH_REAL")")/node_modules" ;;
esac
if [[ ! -d "$NM_DIR/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-sandbox-local" && ! -d "$NM_DIR/@deepseek-ai/dsh-sandbox-local" ]]; then
  echo "ci-replay: the dsh tree beside $NM_DIR is missing @deepseek-ai/dsh-sandbox-local." >&2
  echo "           npm's GLOBAL mode rewrites the host tree (see ci.yml install note);" >&2
  echo "           install project-scoped, one package per prefix." >&2
  exit 2
fi

npm ci
npm run build

# The e2e boot copies a scratch DSH home (profile + link-installed plugin +
# chapters preset) from .dshdev-local; build it if the checkout lacks it.
[[ -d .dshdev-local ]] || bash scripts/bootstrap-dev-profile.sh --home .dshdev-local

# Chromium for Playwright, cached in the workspace so it survives across steps.
PLAYWRIGHT_BROWSERS_PATH="$PWD/var/ms-playwright" npx playwright install chromium

# Strict tape replay across all six projects; any miss fails the chain.
E2E_MODEL=replay npm run test:e2e
echo "ci-replay: PASS — six browser projects replayed green on committed tapes, no LLM present."
