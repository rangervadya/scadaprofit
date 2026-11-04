# Установка CAD Reconstruction Engine 4.3.2

1. Распакуйте полный архив и замените файлы в GitHub-репозитории `rangervadya/scadaprofit` (ветка `main`). Сохраните `.env`, `.git`, серверные резервные копии и всю папку `public/`, включая `public/styles.css`.
2. Сделайте Commit в `main`.
3. На сервере выполните:

```bash
cd /opt/scadaprofit
sudo git pull --ff-only origin main
sudo docker compose config --quiet
sudo docker compose build app
sudo docker compose up -d --no-deps app
curl -sS http://127.0.0.1:3001/api/health
```

Проверьте `version: 4.3.2`, затем обновите браузер сочетанием `Cmd + Shift + R` и обработайте ту же фотографию ещё раз. Не удаляйте Ollama и не запускайте `docker compose down -v`.

## Что проверить в новом задании
- `summary.cad_primary_edges`, `summary.cad_primary_paths`, `summary.cad_primary_total_paths`.
- `summary.text_block_rows_detected`, `summary.text_block_rows_returned`, `summary.text_block_rows_verified`.
- `ocr.qwen.block_diagnostics[].row_diagnostics`: для каждой строки будут `text_preview`, `confidence`, `accepted` или `error`.
- `handwritten-text-blocks.png`: должна быть видна рамка блока и отдельная рамка вокруг каждой обнаруженной строки.
- `primary-overlay.png`, `text-region-mask.png`, `ink-without-text-boxes.png`.

Слои DXF: `PIPE_MAIN`, `QWEN_REVIEW`, `DETAIL_REVIEW`, `VERIFIED_TEXT`, `TEXT_REVIEW`, `SHEET`, `NOTES`. В `PIPE_MAIN` остаются только отобранные маршруты, но автоматические тесты не доказывают полную точность на конкретной фотографии. Сверьте соединения, повороты, размеры и текст по оригиналу перед использованием.
