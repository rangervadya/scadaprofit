# Docker: CAD Sketch Converter 2.5.0

## Запуск

```bash
cp -n .env.example .env
docker compose config --quiet
docker compose up -d --build
```

Приложение доступно по `http://IP_СЕРВЕРА:3001`.

## Обновление текущего проекта

Не стирайте каталог, не удаляйте named volumes и не запускайте `down -v`.

```bash
cd /opt/scadaprofit
tar -czf /root/scadaprofit-backup-$(date +%F-%H%M).tar.gz .
# Распакуйте новый полный архив поверх /opt/scadaprofit
docker compose config --quiet
docker compose build --no-cache app
docker compose up -d --force-recreate app
```

## Ollama

Векторизация и экспорт больше не вызывают Ollama. Сервис и volume `ollama_data` оставлены для сохранения прежней установки, но приложение не зависит от наличия модели. Сервис `model-init` отключён от обычного старта профилем `ai-setup`.

Если требуется вручную загрузить модель для отдельного эксперимента:

```bash
docker compose exec ollama ollama list
docker compose exec ollama ollama pull qwen3-vl:4b-instruct
```

Эта модель не используется для координат труб. Не удаляйте хранилище моделей при обновлении проекта.

## Проверка

```bash
docker compose ps
docker compose exec app node -p "require('./package.json').version"
curl -s http://127.0.0.1:3001/api/health
```

Ожидаемая версия: `2.5.0`. `/api/health` должен показывать `processorReady: true` и `geometryEngine: "opencv-skeleton-graph"`.
