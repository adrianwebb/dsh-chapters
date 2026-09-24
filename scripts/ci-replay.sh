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
#     not a devDependency) — install:  npm i -g @deepseek-ai/dsh@<PIN>
#   - pnpm — a HOST prerequisite only (`dsh plugin` shells to it verbatim);
#     everything this repo itself does is npm
#   - Playwright chromium (this script installs it into var/ms-playwright)
#   - git with the http-backend (knowledge.spec drives a real smart-HTTP
#     remote; ubuntu-latest ships it)
set -euo pipefail
cd "$(dirname "$0")/.."

# ONE source of truth for the host version this plugin is verified against.
# The whole acceptance ledger was measured on exactly this; bump deliberately.
DSH_HOST_VERSION="${DSH_HOST_VERSION:-0.1.5-rc.1}"

command -v pnpm >/dev/null 2>&1 || {
  # NOT our package manager (this repo is npm-only, start to finish) — pnpm is
  # a hard prerequisite of the HOST CLI: `dsh plugin` forwards to pnpm verbatim.
  echo "ci-replay: pnpm not on PATH — the dsh host forwards 'dsh plugin' to it:" >&2
  echo "           npm i -g pnpm" >&2
  exit 2
}

command -v dsh >/dev/null 2>&1 || {
  echo "ci-replay: 'dsh' not on PATH. Install the pinned host first:" >&2
  echo "           npm i -g @deepseek-ai/dsh@$DSH_HOST_VERSION" >&2
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
HOST_DIR="$(dirname "$(dirname "$(command -v dsh)")")/node_modules/@deepseek-ai"
if [[ ! -d "$HOST_DIR/dsh/node_modules/@deepseek-ai/dsh-sandbox-local" && ! -d "$HOST_DIR/dsh-sandbox-local" ]]; then
  echo "ci-replay: the installed dsh tree is missing @deepseek-ai/dsh-sandbox-local" >&2
  echo "           (npm $(npm --version)) — known-bad hoist; use npm 12 (see ci.yml pin)." >&2
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
