#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v sudo >/dev/null 2>&1; then
  echo "Нужен sudo для установки системных пакетов." >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "Node.js 20.17+ не найден. Установите актуальный Node.js с https://nodejs.org/ и повторите запуск." >&2
  exit 1
fi

sudo apt update
sudo apt install -y python3 python3-venv python3-opencv tesseract-ocr tesseract-ocr-rus tesseract-ocr-eng curl ca-certificates libcairo2

if ! command -v ollama >/dev/null 2>&1; then
  echo "Устанавливаю Ollama (для первоначальной установки нужен интернет)..."
  curl -fsSL https://ollama.com/install.sh | sh
fi

if [[ ! -d .venv ]]; then
  python3 -m venv --system-site-packages .venv
fi
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install pytesseract ezdxf cairosvg

.venv/bin/python - <<'PY'
import cv2, pytesseract, ezdxf, cairosvg
print('OpenCV:', cv2.__version__)
print('Tesseract wrapper: OK')
print('ezdxf:', ezdxf.__version__)
print('CairoSVG:', cairosvg.__version__)
PY

if ! command -v tesseract >/dev/null 2>&1; then
  echo "Tesseract не установлен." >&2
  exit 1
fi
tesseract --list-langs || true

if command -v systemctl >/dev/null 2>&1; then
  sudo systemctl enable --now ollama || true
fi
if ! curl -fsS --max-time 3 http://127.0.0.1:11434/api/tags >/dev/null; then
  echo "Ollama API пока не отвечает. Попытка запустить сервис..."
  (nohup ollama serve >/tmp/cad-sketch-ollama.log 2>&1 &)
  for attempt in $(seq 1 30); do
    if curl -fsS --max-time 2 http://127.0.0.1:11434/api/tags >/dev/null; then break; fi
    sleep 1
  done
fi

if ! curl -fsS --max-time 3 http://127.0.0.1:11434/api/tags >/dev/null; then
  echo "Не удалось подключиться к Ollama. Проверьте: systemctl status ollama" >&2
  exit 1
fi

echo "Скачиваю Qwen2.5-VL-3B (требуется интернет только на этом этапе)..."
ollama pull qwen2.5vl:3b

if [[ ! -f .env ]]; then cp .env.example .env; fi
npm install
npm run check

echo
echo "Установка завершена. Запустите CAD-режим командой: PORT=3001 npm start (если порт 3000 занят Docker)."
echo "Затем откройте http://localhost:3001 или http://IP_СЕРВЕРА:3001"
echo "После скачивания модели обработка изображений выполняется локально."
