#!/usr/bin/env bash
set -euo pipefail

MODEL="${QWEN_MODEL:-qwen3-vl:4b-instruct}"
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker не найден. Установите Docker Engine и Compose plugin." >&2
  exit 1
fi

echo "Запускаю Ollama..."
docker compose up -d ollama

echo "Загружаю модель ${MODEL}. При первом запуске скачивание может занять время и несколько гигабайт диска."
docker compose exec ollama ollama pull "${MODEL}"

echo "Перезапускаю приложение..."
docker compose restart app

echo "Проверка состояния:"
echo "  curl -s http://127.0.0.1:3001/api/health"
