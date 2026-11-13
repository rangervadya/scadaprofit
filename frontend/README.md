# Unified VDGO SPA

Одностраничное React-приложение ПРОФИТ. Роутинг выполняется на клиенте через
`react-router-dom`, без перезагрузок и без отдельных HTML-страниц.

## Запуск в dev

```bash
# 1. Основной API (порт 3000)
cd backend
npm install
PORT=3000 DATA_DIR=/tmp/scadaprofit-data node api/server.js

# 2. Сервис заключений (порт 8765)
cd services/vdgo/backend
VDGO_HOST=127.0.0.1 VDGO_PORT=8765 VDGO_NO_BROWSER=1 python3 app.py

# 3. SPA (порт 5173)
cd frontend
npm install
npm run dev
```

Откройте `http://127.0.0.1:5173/vdgo/`. Vite проксирует `/api` на порт 3000 и
`/vdgo/api`, `/vdgo/generate*`, `/vdgo/preview` на порт 8765.

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

## Сборка

```bash
npm run build
```

Артефакты складываются в `frontend/public/vdgo/` и раздаются основным backend
по префиксу `/vdgo/`.