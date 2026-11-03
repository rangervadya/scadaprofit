# Обновление до 4.3.1

Замените содержимое репозитория полным архивом 4.3.1, сохранив `.env`, `.git` и серверные резервные копии. Обязательно сохраните каталог `public/`, в том числе `public/styles.css`.

На сервере:

```bash
cd /opt/scadaprofit
sudo git pull --ff-only origin main
sudo docker compose config --quiet
sudo docker compose build app
sudo docker compose up -d --no-deps app
curl -sS http://127.0.0.1:3001/api/health
```

Проверьте `version: 4.3.1`. Для нового анализа откройте страницу и сделайте жёсткое обновление `Cmd + Shift + R`.

Новые слои DXF:
- `PIPE_MAIN` — OpenCV-пути плюс маршруты Qwen, проверенные по чернилам исходного изображения;
- `QWEN_REVIEW` — Qwen-маршруты, не прошедшие валидацию;
- `VERIFIED_TEXT` — распознанный и подтверждённый текст;
- `TEXT_REVIEW` — сомнительные OCR-строки, слой заморожен по умолчанию;
- `DETAIL_REVIEW` — прочие геометрические кандидаты.
