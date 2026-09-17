#!/usr/bin/env bash
# Bootstrap (or repair) the dsh-chapters DEV scratch profile at the repo-root
# home of your choice: builds lib/, links the plugin, installs the Local-Qwen
# @32K settings + profile patch, and copies credential REFS from the live
# ~/.dsh root (read-only there; nothing secret is ever written into the repo).
#
# Usage: scripts/bootstrap-dev-profile.sh [--home .dshdev-local] [--with-probe] [--force]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME_ARG=".dshdev-local"; WITH_PROBE=0; FORCE=0
while [[ $# -gt 0 ]]; do case "$1" in
  --home) HOME_ARG="$2"; shift 2;;
  --with-probe) WITH_PROBE=1; shift;;
  --force) FORCE=1; shift;;
  *) echo "unknown arg $1" >&2; exit 2;;
esac; done
[[ "$HOME_ARG" = /* ]] || HOME_ARG="$ROOT/$HOME_ARG"
mkdir -p "$HOME_ARG"

cd "$ROOT"
[[ -f lib/index.js ]] || npm run build

W="$ROOT/scripts/dsh-scratch.sh"
bash "$W" --home "$HOME_ARG" plugin --profile web add "link:$ROOT" >/dev/null
# Write-if-missing: a user who has tuned their dev settings (window, efforts,
# providers) must not lose the edit to a re-bootstrap. --force overwrites.
if [[ -f "$HOME_ARG/settings.yaml" && "$FORCE" != 1 ]]; then
  echo "settings: existing $HOME_ARG/settings.yaml kept (delete it or pass --force to re-template)"
else
  cp "$ROOT/dev/settings.yaml" "$HOME_ARG/settings.yaml"
  echo "settings: templated $HOME_ARG/settings.yaml"
fi
if [[ ! -f "$HOME_ARG/profiles/web/cordis.patch.yml" || "$FORCE" == 1 ]]; then
  cp "$ROOT/dev/profile-cordis.patch.yml" "$HOME_ARG/profiles/web/cordis.patch.yml"
fi
if [[ -f "$HOME_ARG/.credentials.yaml" ]]; then
  echo "credentials: keeping existing $HOME_ARG/.credentials.yaml"
elif [[ -f "$HOME/.dsh/.credentials.yaml" ]]; then
  cp "$HOME/.dsh/.credentials.yaml" "$HOME_ARG/.credentials.yaml"
  echo "credentials: copied REFS from the live ~/.dsh (LOCAL_API_KEY, OPENROUTER_API_KEY)"
else
  echo "credentials: none found — LOCAL provider may still need apiKeyEnv LOCAL_API_KEY present"
fi
if [[ "$WITH_PROBE" == 1 ]]; then
  bash "$W" --home "$HOME_ARG" plugin --profile web add "link:$ROOT/spikes/probe" >/dev/null
  echo "probe mounted (scripted one-shots that process.exit — remove before browser use)"
fi
echo "dev profile ready at $HOME_ARG"
echo "run:  scripts/dsh-scratch.sh --home $(realpath -m --relative-to="$ROOT" "$HOME_ARG") web --port 0 --no-open"
