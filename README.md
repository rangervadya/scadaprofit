**Текущая версия: 4.5.17**

# ScadaProfit 4.5.17

Комплекс для обработки ручных схем, редактирования CAD, распределения выездов слесарям, приёмки схем и дефектных фотографий и подготовки технических заключений.

## Структура проекта

```text
frontend/                 Единое React-приложение для всех ролей
  src/                    Страницы, компоненты, API-клиент и стили
  index.html              Vite entry point
  vite.config.ts           Сборка в frontend/public/vdgo
  public/                  Публичные статические файлы
services/ollama/          Основной Node.js API и Python CAD/recognition engine
  api/                    Авторизация, workforce API, обработка заданий
  engine/                 Распознавание ручных схем и CAD-реконструкция
services/vdgo/            API технических заключений, PDF/Word и PostgreSQL
infra/                    Dockerfile, Nginx, compose overrides и scripts
tests/                    Node.js, Python и VDGO regression tests
docs/                     Руководства, deployment, architecture и changelog
compose.yaml              Единая точка запуска Docker Compose
.env.example              Шаблон локальных настроек
```

## Интерфейс

Оба рабочих интерфейса объединены в один React SPA и один frontend workspace:

- `http://SERVER:3001/` перенаправляет на `/vdgo/`.
- `/vdgo/` — единое приложение с маршрутизацией по ролям.
- Слесарю доступны рабочий стол и раздел «Команда»; приёмщику, руководителям и разработчику — остальные разрешённые разделы.
- API заключений остаётся отдельным сервисом `vdgo-backend`; его маршруты защищены проверкой общей сессии и роли.
- В SPA нет второго frontend-контейнера и отдельной копии зависимостей.

## Первый запуск

1. Скопируйте `.env.example` в `.env`, задайте уникальный `POSTGRES_PASSWORD`; для HTTPS установите `COOKIE_SECURE=1`.
2. Из корня репозитория выполните:

   ```bash
   docker compose config --quiet
   docker compose up -d --build
   ```

3. Откройте `http://SERVER:3001/`. При первом входе создайте аккаунт разработчика, затем создайте аккаунты руководителей, приёмщиков и слесарей.

## Обновление

```bash
git pull --ff-only
docker compose config --quiet
docker compose build --no-cache app vdgo-backend
docker compose up -d --remove-orphans --no-deps --force-recreate app vdgo-backend
docker compose restart gateway
docker compose ps
```

Если `docker compose build` завершился ошибкой, не выполняйте следующий `up`: Docker может оставить старый образ. Сначала исправьте причину и добейтесь успешной сборки. После запуска проверьте версию в логах `app` — должна быть `ScadaProfit 4.5.17`.

Не запускайте `docker compose down -v` и не удаляйте именованные тома: в них хранятся задания, CAD-проекты, аккаунты, фотографии, документы, модели Ollama и PostgreSQL.

## Локальная разработка frontend

```bash
cd frontend
npm ci
npm run dev
```

Vite открывает SPA на `http://127.0.0.1:5173/vdgo/`, проксируя `/api` к основному backend и `/vdgo/api`, `/vdgo/generate*` к backend заключений. Для полной разработки запустите также основной API и `services/vdgo` согласно `docs/deployment/DOCKER.md` и frontend README.

## Проверки

```bash
npm --prefix services/ollama run check
PYTHONPATH=services/ollama python -m unittest discover -s tests/vdgo -p 'test_*.py' -v
cd frontend && npm ci && npm run build
```

## Документация

- [Документация проекта на русском](docs/user-guides/README-RU.md)
- [Развёртывание Docker](docs/deployment/DOCKER.md)
- [Быстрый старт ролей и выездов](docs/user-guides/WORKFORCE-QUICKSTART-RU.md)
- [Руководство CAD](docs/user-guides/MANUAL-CAD-USER-GUIDE-RU.md)
- [История изменений](docs/releases/CHANGELOG-RU.md)
