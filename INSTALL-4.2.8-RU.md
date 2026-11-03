# Установка CAD Reconstruction Engine 4.2.8

В 4.2.8 исправлены не только Python-обработчик, но и браузерный экспорт. Предпросмотр SVG и кнопки скачивания SVG/DXF формируются в `public/app.js`, поэтому замена одного `processor.py` не исправляет старую ветку Qwen-only.

## Файлы, которые должны обновиться в GitHub

- `processor.py`
- `server.js`
- `package.json`
- `public/app.js`
- `public/index.html`
- сопроводительная документация и тесты из архива

Не заменяйте пользовательский `.env`. В архиве `compose.yaml` сохранены настройки OCR 180 секунд / 2048 токенов и трассировки 240 секунд / 2048 токенов; при наличии индивидуальных настроек Compose сравните файл перед заменой.

## Обновление сервера

```bash
cd /opt/scadaprofit
sudo git pull --ff-only origin main
sudo docker compose config --quiet
sudo docker compose build app
sudo docker compose up -d --no-deps app
curl -sS http://127.0.0.1:3001/api/health
```

В ответе ожидается `version: 4.2.8`, а поле `geometry` должно начинаться с `Selected OpenCV graph paths form PIPE_MAIN`.

После обновления страницы браузера выполните новое распознавание исходной фотографии. Старые задания не пересчитываются автоматически.

## Что формирует результат

- `PIPE_MAIN`: отобранные и соединённые CAD-пути графа OpenCV (`cad_include=true`), ручные включения и ручные связи.
- `QWEN_REVIEW`: семантические маршруты Qwen, отдельный замороженный слой для проверки.
- `DETAIL_REVIEW`: неотобранные детекторные фрагменты, отдельный замороженный слой.
- `VERIFIED_TEXT`: надписи, прошедшие автоматический порог OCR; правильность текста всё равно требуется сверить с оригиналом.
