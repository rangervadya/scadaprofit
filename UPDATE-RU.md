# Обновление до 3.1.0

Скопируй ZIP на сервер в `/home/tech/`, затем выполни команды обновления из README.md. Перед этим проект архивируется в `/root/scadaprofit-backup-...tar.gz`. Обновляется только app-контейнер. Не используй `docker compose down -v`; Ollama volume и `.env` должны сохраниться.
