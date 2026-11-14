# Unified VDGO SPA

Одностраничное React-приложение ПРОФИТ. Роутинг клиентский (`react-router-dom`),
без перезагрузок и отдельных HTML-страниц. Старые HTML/JS/CSS лежат в `legacy/`
и в рантайме не раздаются.

## Возможности

- Рабочий стол с метриками, недавними заданиями и заключениями.
- Техническое заключение ВДГО: все разделы, УЗТ-таблицы, дефекты, арматура,
  фото, материалы, предпросмотр PDF и выгрузка в Word.
- Схемы домов: папки улиц/домов, загрузка эскизов, граф распознавания,
  проверка, импорт в CAD.
- CAD-редактор: трубы, узлы, символы, подписи, размеры, сохранение и экспорт
  SVG/DXF.
- Команда: роли «слесарь», «приёмщик», «руководитель», «разработчик»;
  задания, этапы обхода, эскизы, фото дефектов, приёмка и учётные записи.
- Архив: история заключений, CAD-проекты, схемы.
- Сворачиваемый сайдбар (иконки + подписи, состояние в `localStorage`).
- Ленивая загрузка страниц и раздельные чанки сборки.

## Запуск в dev

Нужны три процесса и PostgreSQL (users/sessions хранятся в БД). Для локального
PostgreSQL можно поднять dev-контейнер:

```bash
docker run -d --name scada-pg-dev \
  -e POSTGRES_USER=vdgo -e POSTGRES_PASSWORD=vdgo -e POSTGRES_DB=vdgo \
  -p 55432:5432 postgres:17.7-alpine
```

Затем из корня проекта:

```bash
# 0. Зависимости (один раз)
npm install
npm --prefix frontend install
npm --prefix services/ollama install

# 1. Основной API (порт 3000)
PORT=3000 DATA_DIR=/tmp/scadaprofit-data MASK_PYTHON=python3 \
  AUTH_BACKEND=postgres \
  DATABASE_URL=postgresql://vdgo:vdgo@127.0.0.1:55432/vdgo \
  npm --prefix services/ollama start

# 2. Сервис заключений (порт 8765)
VDGO_HOST=127.0.0.1 VDGO_PORT=8765 VDGO_NO_BROWSER=1 \
  python3 services/vdgo/app.py

# 3. SPA (порт 5173)
npm --prefix frontend run dev
```

Откройте `http://127.0.0.1:5173/vdgo/`.

При первом запуске нажмите «Настроить доступ» и создайте аккаунт разработчика.
Остальные роли создаются в разделе «Команда → Пользователи».

Ollama/Qwen3-VL не обязательны для UI: без них вход, роли, команда, CAD и
заключения работают, а распознавание эскиза получает статус `failed`.
`/api/health` остаётся liveness (`ok:true`), `/api/readyz` возвращает 503, если
Ollama/модель/Tesseract недоступны.

## Маршруты

| Путь | Страница |
| --- | --- |
| `/login` | Вход и первичная настройка |
| `/` | Рабочий стол |
| `/conclusion` | Техническое заключение |
| `/schemes` | Схемы домов |
| `/schemes/:jobId` | Проверка схемы |
| `/archive` | Архив |
| `/team` | Команда и приёмка |
| `/cad` | Список чертежей |
| `/cad/:id` | CAD-редактор |
| `/settings` | Настройки |

## Переменные окружения

| Переменная | Назначение |
| --- | --- |
| `PORT` | Порт основного API (по умолчанию 3000). |
| `DATA_DIR` | Каталог данных workforce и загрузок. |
| `MASK_PYTHON` | Python для движка распознавания (в venv или `python3`). |
| `MAIN_BACKEND_URL` | Куда Vite проксирует `/api` и `/jobs` (по умолчанию `http://127.0.0.1:3000`). |
| `VDGO_BACKEND_URL` | Куда Vite проксирует `/vdgo/*` (по умолчанию `http://127.0.0.1:8765`). |
| `VDGO_FONT_DIR` | Каталог шрифтов Carlito для PDF; есть fallback на `google-carlito-fonts`. |
| `VDGO_MAX_REQUEST_BYTES` | Лимит тела запроса VDGO (по умолчанию 256 МБ). |
| `MAX_CONCURRENT_PYTHON_JOBS` | Сколько Python-джоб одновременно; для одного GPU — 1. |
| `SHUTDOWN_TIMEOUT_MS` | Сколько Node ждёт активные Python-джобы при SIGTERM. |
| `DATABASE_URL` | PostgreSQL для Prisma/аудита; без него audit отключён. |
| `AUTH_BACKEND` | `postgres` (default) или `json` — только для legacy/dev без БД. |

## Сборка

```bash
npm run build
```

Артефакты складываются в `frontend/public/vdgo/` и раздаются основным backend
по префиксу `/vdgo/`. Сборка использует `manualChunks` (React, router, vendor)
и lazy-чанки страниц.

## Проверки

```bash
# всё: Prettier + ESLint + Ruff + typecheck + Node/Python/VDGO тесты
npm run verify

# только backend-тесты
npm --prefix services/ollama run test

# только SPA
npm --prefix frontend run typecheck
npm --prefix frontend run build
```

## Диагностика

- Если вход не работает, проверьте, что backend на `:3000` запущен, а Vite
  проксирует `/api`.
- Если PDF не формируется, проверьте шрифты Carlito и загрузку шаблона в
  «Настройки».
- Если распознавание эскиза падает, нужны Ollama/Qwen3-VL и Tesseract; без них
  UI работает, но схема получает статус `failed`.