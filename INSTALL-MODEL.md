# Qwen2.5-VL-3B: Docker и host-варианты

## Рекомендуемый вариант — всё в Docker

Основная инструкция находится в `README.md`. Кратко:

```bash
docker compose -f compose.yaml up -d --build
docker compose -f compose.yaml exec ollama ollama pull qwen2.5vl:3b
docker compose -f compose.yaml restart app
```

Модель будет храниться в Docker volume `ollama_data`. Эта копия отдельна от модели, ранее установленной в Ollama на Ubuntu host. Не выполняйте `docker compose down -v`, если хотите сохранить контейнерную модель.

## Альтернатива — использовать уже установленную Ollama на Ubuntu

Если не хотите скачивать вторую копию модели, запустите только веб-приложение в Docker, подключив его к host Ollama:

```bash
docker compose -f compose.host-ollama.yaml up -d --build
```

Для этого варианта host-служба Ollama должна оставаться запущенной. Сервис приложения слушает порт 3001.
