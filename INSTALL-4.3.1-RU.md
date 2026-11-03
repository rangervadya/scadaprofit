# Установка CAD Reconstruction Engine 4.3.1

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

Проверьте `version: 4.3.1`, затем в браузере выполните `Cmd + Shift + R` и обработайте исходную фотографию ещё раз.

Новые диагностические файлы: `primary-overlay.png`, `text-region-mask.png`, `ink-without-text-boxes.png`, `ink-inside-text-boxes.png`, `handwritten-text-blocks.png` (на нём видны рамки найденных многострочных рукописных блоков). В `graph.json` проверьте `summary.semantic_validation`, `summary.cad_primary_total_paths`, `summary.text_block_annotations` и `ocr.qwen.block_diagnostics`.

Слои DXF: `PIPE_MAIN`, `QWEN_REVIEW`, `DETAIL_REVIEW`, `VERIFIED_TEXT`, `TEXT_REVIEW`, `SHEET`, `NOTES`. Не запускайте `docker compose down -v`; Ollama и её модели переустанавливать не требуется.

Автоматические проверки не доказывают точность распознавания конкретной фотографии. Сверьте все соединения, пересечения, размеры и надписи с оригиналом перед использованием.
