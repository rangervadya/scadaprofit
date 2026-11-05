#!/bin/zsh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
export VDGO_FORCE_LOCAL=1
exec /bin/zsh "$ROOT/start_mac.command"
