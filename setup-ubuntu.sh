#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "Нужен Node.js 20 или новее." >&2
  exit 1
fi

sudo apt update
sudo apt install -y python3 python3-venv python3-opencv tesseract-ocr tesseract-ocr-rus tesseract-ocr-eng libcairo2 curl ca-certificates

if [[ ! -d .venv ]]; then
  python3 -m venv --system-site-packages .venv
fi
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install pytesseract ezdxf cairosvg

if [[ ! -f .env ]]; then cp .env.example .env; fi
npm install
npm run check

.venv/bin/python - <<'PY'
import cv2, pytesseract, ezdxf, cairosvg
print('OpenCV:', cv2.__version__)
print('Tesseract wrapper: OK')
print('ezdxf:', ezdxf.__version__)
print('CairoSVG:', cairosvg.__version__)
PY

tesseract --list-langs || true

echo
echo "Установка завершена. Запуск: PORT=3001 npm start"
echo "Внешний API, Ollama и скачивание AI-модели для векторизации не требуются."
