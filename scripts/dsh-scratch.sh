#!/usr/bin/env bash
# dsh-scratch: run the installed `dsh` against an isolated DSH_HOME, always.
#
# Why this file exists: a `dsh plugin add` WITHOUT DSH_HOME mutates the profile
# THIS session runs inside (~/.dsh/profiles/web). That exact mistake was made
# on 2026-09-15; only the sandbox's read-only ~/.dsh kept it harmless
# ("pnpm failed in profile directory /home/adrian/.dsh/profiles/web", zero
# changes). A guard rail must not depend on the sandbox, so the bare command
# never needs to be typed again.
#
# Usage: scripts/dsh-scratch.sh [--home <dir>] <dsh args...>
#   default home: $DSH_SCRATCH_HOME, else <repo>/.dshdev
#   a relative --home resolves against the repo root
# Refuses (exit 2) any resolved home equal to or nested under the real ~/.dsh.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${1:-}" == "--home" ]]; then
  [[ $# -ge 3 ]] || { echo "dsh-scratch: --home needs a directory and dsh args" >&2; exit 2; }
  SCRATCH="$2"; shift 2
else
  SCRATCH="${DSH_SCRATCH_HOME:-$ROOT/.dshdev}"
fi
[[ $# -gt 0 ]] || { echo "dsh-scratch: no dsh args given" >&2; exit 2; }

case "$SCRATCH" in /*) : ;; *) SCRATCH="$ROOT/$SCRATCH" ;; esac
mkdir -p "$SCRATCH"
RESOLVED="$(cd "$SCRATCH" && pwd -P)"

LIVE="${HOME%/}/.dsh"
if [[ "$RESOLVED" == "$LIVE" || "$RESOLVED" == "$LIVE"/* ]]; then
  echo "dsh-scratch: REFUSED — DSH_HOME would be '$RESOLVED' (inside the live '$LIVE')." >&2
  exit 2
fi

export DSH_HOME="$RESOLVED"
cd "$ROOT"
echo "dsh-scratch: DSH_HOME=$DSH_HOME" >&2
exec dsh "$@"
