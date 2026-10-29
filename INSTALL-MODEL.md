# Модель Qwen2.5-VL-3B (Docker, офлайн после загрузки)

Compose 2.4 автоматически проверяет, существует ли `QWEN_MODEL` в общем Docker-volume Ollama. Если нет — сервис `model-init` скачает его до запуска веб-приложения.

По умолчанию модель: `qwen2.5vl:3b`. Чтобы принудительно загрузить/обновить её вручную:

```bash
docker compose exec ollama ollama pull qwen2.5vl:3b
docker compose exec ollama ollama list
docker compose restart app
```

Важно: модель в системной Ollama Ubuntu и модель в Docker-volume — разные экземпляры, если хранилища не смонтированы общими. В полном Docker-режиме `docker compose exec ollama ollama list` — правильная проверка.

После загрузки весов и Docker-образов запросы обрабатываются локально. Не удаляйте volume командой `docker compose down -v`, если хотите сохранить скачанную модель.
