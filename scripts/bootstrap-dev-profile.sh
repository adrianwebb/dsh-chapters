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
  echo "refusing to overwrite an existing custom patch: $HOME_ARG/profiles/web/cordis.patch.yml" >&2
  exit 2
fi
cp "$ROOT/dev/profile-cordis.patch.yml" "$HOME_ARG/profiles/web/cordis.patch.yml"
if [[ -f "$HOME_ARG/settings.yaml" && "$FORCE" -ne 1 ]]; then
  echo "settings: keeping your tuned $HOME_ARG/settings.yaml (use --force to re-template)"
else
  cp "$ROOT/dev/settings.yaml" "$HOME_ARG/settings.yaml"
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
