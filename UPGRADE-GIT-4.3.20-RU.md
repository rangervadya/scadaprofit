# ScadaProfit 4.3.20 — обновление существующего Git-проекта

## Что добавлено

ScadaProfit 4.3.20 добавляет отдельный редактор ручного CAD для переноса рукописного эскиза в редактируемую геометрию:

- `/manual-cad.html` — отдельная страница редактора;
- `manual-cad-core.js` — нормализация данных и экспорт SVG/DXF;
- `/api/manual-cad/*` — отдельное API для проектов и подложек;
- отдельное хранилище `DATA_DIR/.private/manual-cad/` в уже существующем томе `cad_jobs`;
- ручные трубы, ответвления с явной привязкой, подписи, символы, размеры, редактирование, undo/redo и автосохранение.

**VDGO не затрагивался.** В GitHub Update ZIP нет файлов из `vdgo/`; не изменялись `compose.yaml`, `nginx-unified.conf`, VDGO frontend/backend, БД или volumes.

## Установка

В корне репозитория `/opt/scadaprofit`:

```bash
# 1. Сделай резервную копию корневых файлов приложения
mkdir -p backup-4.3.19-manual-cad
cp -a server.js package.json public/index.html README.md README-RU.md CHANGELOG-RU.md backup-4.3.19-manual-cad/

# 2. Распакуй GitHub Update ZIP в корень репозитория с заменой файлов.
#    Не удаляй .env, .git, vdgo/ и Docker volumes.

# 3. Пересобери только основной app-сервис
#    Сначала проверь npm run check локально/в контейнере сборки,
#    затем выполни:
docker compose build app
docker compose up -d app

# 4. Проверь основной сервис
docker compose ps app
docker compose logs --tail=80 app

# 5. Проверь версию API
curl -s http://127.0.0.1:3001/api/health | head -c 1000
```

Не используй `docker compose down -v`. Не пересобирай `vdgo-frontend` или `vdgo-backend` — это не требуется.

## Использование

Открой `http://АДРЕС-СЕРВЕРА:3001/manual-cad.html` или выбери «Ручной CAD» в переключателе основного приложения. Подробная инструкция — `MANUAL-CAD-USER-GUIDE-RU.md`.

## Где хранятся проекты

Ручные CAD-проекты и исходные изображения находятся в `DATA_DIR/.private/manual-cad/`, который располагается внутри существующего тома `cad_jobs`. Они не хранятся в `/vdgo`, `vdgo_output`, `vdgo_uploads` или `vdgo_postgres_data`.

## Проверки

- `node --check` для server/core/frontend — успешно.
- 4 новых Node-теста Manual CAD — успешно.
- `npm run check` — успешно; все существующие 121 Python-тест также пройдены.
- Docker build и запуск на сервере пользователя в этой среде не выполнялись. После установки проверь статус `app` и открой страницу редактора.
