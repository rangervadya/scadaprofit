#!/bin/zsh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# Only choose Docker when its daemon is actually responding. Having the docker CLI
# installed is not enough (a stopped Docker Desktop must fall back to native launch).
if [[ "${VDGO_FORCE_LOCAL:-0}" != "1" ]] && command -v docker >/dev/null 2>&1 \
  && docker compose version >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  echo "Docker Engine доступен. Запускаю Docker Compose: http://localhost:${VDGO_HTTP_PORT:-8080}"
  exec docker compose up --build
fi

echo "Локальный запуск без Docker. Проект: $ROOT"
command -v python3 >/dev/null 2>&1 || { echo "Не найден Python 3.12+. Установите Python."; read -k 1 "?Нажмите клавишу для выхода..."; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Не найден Node.js 24+. Установите Node.js."; read -k 1 "?Нажмите клавишу для выхода..."; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "Не найден npm."; read -k 1 "?Нажмите клавишу для выхода..."; exit 1; }

# Create a private backend environment inside backend/, not in the project root.
cd "$ROOT/backend"
if [[ ! -x .venv/bin/python ]]; then python3 -m venv .venv; fi
.venv/bin/python -m pip install --disable-pip-version-check -r requirements.txt

# Pick a free port once and pass the same address to the backend and Vite proxy.
BACKEND_PORT=8765
while ! .venv/bin/python -c 'import socket,sys; s=socket.socket(); s.bind(("127.0.0.1",int(sys.argv[1]))); s.close()' "$BACKEND_PORT" >/dev/null 2>&1; do
  BACKEND_PORT=$((BACKEND_PORT + 1))
done

VDGO_HOST=127.0.0.1 VDGO_PORT="$BACKEND_PORT" VDGO_NO_BROWSER=1 .venv/bin/python app.py > "$ROOT/backend-local.log" 2>&1 &
BACKEND_PID=$!
cleanup() { kill "$BACKEND_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# Wait for the actual health endpoint and fail with the backend log instead of a blank UI.
ready=0
for _ in {1..30}; do
  if curl -fsS "http://127.0.0.1:${BACKEND_PORT}/health" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [[ "$ready" != "1" ]]; then
  echo "Backend не запустился. Последние строки журнала:"
  tail -60 "$ROOT/backend-local.log" || true
  exit 1
fi

cd "$ROOT/frontend"
if [[ ! -d node_modules ]]; then npm install --no-audit --no-fund; fi
export VDGO_BACKEND_URL="http://127.0.0.1:${BACKEND_PORT}"
echo "Backend: http://127.0.0.1:${BACKEND_PORT}"
echo "Frontend: http://127.0.0.1:5173/"
echo "Оставьте это окно Terminal открытым, пока работает приложение."
npm run dev -- --host 127.0.0.1 --open
