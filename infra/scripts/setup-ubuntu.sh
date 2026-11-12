#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "Нужен Node.js 20 или новее." >&2
  exit 1
fi

sudo apt update
sudo apt install -y python3 python3-venv python3-opencv tesseract-ocr tesseract-ocr-rus tesseract-ocr-eng libcairo2 curl ca-certificates

if [[ ! -d backend/.venv ]]; then
  python3 -m venv --system-site-packages backend/.venv
fi
backend/.venv/bin/python -m pip install --upgrade pip
backend/.venv/bin/python -m pip install -r backend/requirements.txt

if [[ ! -f .env ]]; then cp .env.example .env; fi
npm --prefix backend install
npm --prefix backend run check

backend/.venv/bin/python - <<'PYTHON'
import cv2, pytesseract, ezdxf, cairosvg
print('OpenCV:', cv2.__version__)
print('Tesseract wrapper: OK')
print('ezdxf:', ezdxf.__version__)
print('CairoSVG:', cairosvg.__version__)
PYTHON

tesseract --list-langs || true

echo
echo "Установка завершена. Запуск: npm --prefix backend start"
echo "Для полного набора сервисов используйте: docker compose up -d --build"
