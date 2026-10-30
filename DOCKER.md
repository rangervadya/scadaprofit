# Docker: установка / обновление

Приложение использует сервисы `app` и `ollama` и сохраняет модели в именованном Docker volume `ollama_data`. При обновлении проекта в том же каталоге Compose продолжит использовать существующий volume проекта.

## Установить/обновить

```bash
cd /opt/scadaprofit
# сначала сделай резервную копию проекта

docker compose config --quiet
docker compose build --no-cache app
docker compose up -d --force-recreate app
```

Если Ollama тоже нужно пересоздать (обычно не требуется):

```bash
docker compose up -d --force-recreate ollama app
```

**Никогда не используй `docker compose down -v` для обычного обновления:** это удалит named volume с моделями.

## Проверки

```bash
docker compose exec app node -p "require('./package.json').version"
docker compose exec app printenv QWEN_MODEL
docker compose exec ollama ollama list
curl -s http://127.0.0.1:3001/api/health | python3 -m json.tool
docker compose logs --since=10m app ollama
```

Ожидается версия 2.9.0 и `legacyCadPipeline: false`.

## Логи диагностических этапов

```bash
docker compose logs --since=10m app 2>&1 | grep -E 'QWEN-EXTRACT|QWEN-ROUTE'
```

Для `QWEN-ROUTE` журнал включает причины, по которым raw-ответ не прошёл независимую проверку.
