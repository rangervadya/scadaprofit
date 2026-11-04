# Установка CAD Reconstruction Engine 4.3.3

1. Замените содержимое репозитория полным архивом 4.3.3, сохранив структуру каталогов.
2. Включите все файлы, особенно `processor.py`, `server.js`, `compose.yaml`, `package.json`, `public/app.js`, `public/index.html` и `public/styles.css`.
3. Не заменяйте `.env`, `.git` и резервные копии на сервере.
4. Создайте Commit в `main`, затем на сервере выполните:

```bash
cd /opt/scadaprofit
sudo git pull --ff-only origin main
sudo docker compose config --quiet
sudo docker compose build app
sudo docker compose up -d --no-deps app
curl -sS http://127.0.0.1:3001/api/health
```

Проверьте `version: 4.3.3`, `pipeTileGrid: 3` и `ocrTileGrid: 3`. Обновите браузер через `Cmd + Shift + R`. Не запускайте `docker compose down -v`.
