#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$ROOT/../.." && pwd)"
cd "$ROOT"
if [[ "${VDGO_FORCE_LOCAL:-0}" != "1" ]] && command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  echo "Запускаю Docker Compose: http://localhost:${WEB_PORT:-3001}"
  docker compose -f "$PROJECT_ROOT/compose.yaml" up --build
  exit $?
fi
command -v python3 >/dev/null || { echo "Установите Python 3.12+ или Docker."; exit 1; }
command -v node >/dev/null || { echo "Установите Node.js 22.12+ или Docker."; exit 1; }
cd "$ROOT"
[ -x .venv/bin/python ] || python3 -m venv .venv
.venv/bin/python -m pip install --disable-pip-version-check -r requirements.txt
BACKEND_PORT=8765
while ! .venv/bin/python -c 'import socket,sys; s=socket.socket(); s.bind(("127.0.0.1",int(sys.argv[1]))); s.close()' "$BACKEND_PORT" >/dev/null 2>&1; do BACKEND_PORT=$((BACKEND_PORT+1)); done
VDGO_HOST=127.0.0.1 VDGO_PORT="$BACKEND_PORT" VDGO_NO_BROWSER=1 .venv/bin/python app.py > /tmp/scadaprofit-vdgo-backend-local.log 2>&1 & BACKEND_PID=$!
cleanup() { kill "$BACKEND_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM
cd "$PROJECT_ROOT/frontend"
[ -d node_modules ] || npm ci --no-audit --no-fund
for i in $(seq 1 30); do curl -fsS "http://127.0.0.1:${BACKEND_PORT}/health" >/dev/null 2>&1 && break; sleep 1; done
export VDGO_BACKEND_URL="http://127.0.0.1:${BACKEND_PORT}"
echo "Backend: http://127.0.0.1:${BACKEND_PORT}"
echo "Frontend: http://127.0.0.1:5173/vdgo/"
npm run dev -- --host 127.0.0.1 --open /vdgo/
