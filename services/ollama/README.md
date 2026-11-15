# Ollama vision / CAD reconstruction service

- `api/` — Node.js/Express API, workforce-авторизация, задания, отчёты и CAD API.
  Слои: `domain/` (чистая логика), `repositories/` (БД), `routes/` (HTTP),
  `services/` (use-cases), `validation/` (Zod), `lib/` (инфраструктура);
  `server.js` — composition root.
- `engine/` — Python-пакет пайплайна распознавания, OCR, реконструкции графа и
  экспорта CAD. Подпакеты: `core/` (геометрия, логгер, дедлайн, runtime, ink),
  `ocr/` (Qwen3-VL, рукописный OCR, схемы ответов), `routing/` (семантические
  маршруты), `model/` (модель документа, clean layout, валидация),
  `export/` (CAD/SVG/DXF/PDF, граф, топология), `symbols/` (каталог символов,
  распознавание, каналы). `processor.py` — только `analyze()` + `main()`.
- `package.json` — команды запуска и проверок Node.js.
- `requirements.txt` — Python-зависимости движка.

Запуск движка: `python -m engine.processor --input <file> --out <dir>` из
`services/ollama` (пакет резолвится по `cwd`).

Проверки: `npm run verify` из корня репозитория (Prettier, ESLint, Ruff,
typecheck, node/python/vdgo тесты). Старый `npm run check` удалён.