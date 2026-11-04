# Обновление до 4.3.2

Замените содержимое репозитория полным архивом 4.3.2, сохранив `.env`, `.git` и резервные копии на сервере. Обязательно включите весь каталог `public/`, в частности `public/styles.css`.

После Commit в `main` на сервере выполните:

```bash
cd /opt/scadaprofit
sudo git pull --ff-only origin main
sudo docker compose config --quiet
sudo docker compose build app
sudo docker compose up -d --no-deps app
```

Проверьте `version: 4.3.2`; затем выполните жёсткое обновление браузера (`Cmd + Shift + R`). Не запускайте `docker compose down -v`.
