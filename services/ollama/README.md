# Ollama vision / CAD reconstruction service

- `api/` — Node.js/Express API, workforce-авторизация, задания, отчёты и CAD API.
- `engine/` — Python-пайплайн распознавания, OCR, реконструкции графа и экспорта CAD.
- `package.json` — команды запуска и проверок Node.js.
- `requirements.txt` — Python-зависимости движка.

Запуск проверок из корня репозитория: `npm --prefix services/ollama run check`.
