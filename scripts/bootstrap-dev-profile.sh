#!/usr/bin/env bash
# Bootstrap the dsh-chapters DEV profile: a fresh scratch DSH_HOME wired for
# the REAL target — the Local Qwen model at a 32K window, the Chapters preset
# as the default preset, and this plugin linked in. Nothing touches ~/.dsh.
#
#   scripts/bootstrap-dev-profile.sh [--home .dshdev-local] [--with-probe] [--force]
#
#   --with-probe   also link the probe (scripted rounds only — the probe
#                  self-exits, so a probe-mounted home is NOT browser-safe)
#   --force        re-template settings.yaml even if it already exists
#
# Then:  scripts/dsh-scratch.sh --home .dshdev-local web --port 0 --no-open
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME_ARG=".dshdev-local"
WITH_PROBE=0
FORCE=0
while [[ $# -gt 0 ]]; do case "$1" in
  --home) HOME_ARG="$2"; shift 2;;
  --with-probe) WITH_PROBE=1; shift;;
  --force) FORCE=1; shift;;
  *) echo "unknown arg: $1" >&2; exit 2;;
esac; done
[[ "$HOME_ARG" = /* ]] || HOME_ARG="$ROOT/$HOME_ARG"
mkdir -p "$HOME_ARG"

cd "$ROOT"
if [[ ! -f lib/index.js ]]; then npm run build; fi

W="$ROOT/scripts/dsh-scratch.sh"
bash "$W" --home "$HOME_ARG" plugin --profile web add "link:$ROOT"

# Profile-level defaults: Local model + Chapters preset, so every new session
# in this profile runs the deterministic compaction engine out of the box.
mkdir -p "$HOME_ARG/profiles/web"
if [[ -f "$HOME_ARG/profiles/web/cordis.patch.yml" ]] && ! grep -q "dsh-chapters DEV profile patch" "$HOME_ARG/profiles/web/cordis.patch.yml"; then
  # `dsh plugin add` scaffolds a starter patch (comments + an empty `[]`) on a
  # fresh home — not a human customization (measured 2026-09-23: the scaffold
  # made this guard exit 2 on every clean CI machine before CI ever shipped).
  # Only a patch carrying real entries is a refusal.
  if grep -vE '^[[:space:]]*(#.*|\[\])?$' "$HOME_ARG/profiles/web/cordis.patch.yml" | grep -q .; then
    echo "refusing to overwrite an existing custom patch: $HOME_ARG/profiles/web/cordis.patch.yml" >&2
    exit 2
  fi
fi
cp "$ROOT/dev/profile-cordis.patch.yml" "$HOME_ARG/profiles/web/cordis.patch.yml"
if [[ -f "$HOME_ARG/settings.yaml" && "$FORCE" -ne 1 ]]; then
  echo "settings: keeping your tuned $HOME_ARG/settings.yaml (use --force to re-template)"
else
  cp "$ROOT/dev/settings.yaml" "$HOME_ARG/settings.yaml"
fi

# Register THIS checkout as a workspace so `New session` binds immediately.
# A fresh home has no storages/workspace.json, and the web UI then shows
# "Choose workspace" — the New-session draft never commits to a session, so
# EVERY browser spec dies at newSessionWithTurn (measured 2026-09-23: passed
# for weeks only because the dev home had accumulated the file by hand; CI
# builds it clean). Written only if absent, so a warm home's real session
# list is never clobbered. The e2e boot copies this exact file into each
# throwaway home (storages/workspace.json is the one storages file it keeps).
if [[ ! -f "$HOME_ARG/storages/workspace.json" ]]; then
  mkdir -p "$HOME_ARG/storages"
  node -e '
    const crypto = require("node:crypto")
    const id = crypto.randomUUID(), now = new Date().toISOString()
    const seed = {
      unit: { name: "workspace", version: 2 },
      global: { initialized: true, workspaceIds: [id], archivedSessionIds: [] },
      tables: { workspaces: { [id]: { path: process.argv[1], title: require(process.argv[1] + "/package.json").name, createdAt: now, updatedAt: now, sessionIds: [] } } },
    }
    require("node:fs").writeFileSync(process.argv[2], JSON.stringify(seed, null, 2))
  ' "$ROOT" "$HOME_ARG/storages/workspace.json"
  echo "workspace: registered $ROOT in the home (browser specs need it bound)"
fi

# Credential refs (LOCAL_API_KEY for the local server's auth; openrouter as a
# fallback). Read-only from the live home; the copy lives only in the scratch home.
if [[ ! -f "$HOME_ARG/.credentials.yaml" && -f "$HOME/.dsh/.credentials.yaml" ]]; then
  cp "$HOME/.dsh/.credentials.yaml" "$HOME_ARG/.credentials.yaml"
  echo "credentials: copied refs from the live home (local server key + openrouter fallback)"
fi

if [[ "$WITH_PROBE" -eq 1 ]]; then
  bash "$W" --home "$HOME_ARG" plugin --profile web add "link:$ROOT/spikes/probe"
fi

echo
echo "dev profile ready: $HOME_ARG"
echo "  model:    local/qwen3.8-flash-next @ 32K (the target regime)"
echo "  preset:   chapters (default) — deterministic compaction engine on every new session"
echo "start:      scripts/dsh-scratch.sh --home $(realpath -m --relative-to="$ROOT" "$HOME_ARG") web --port 0 --no-open"
