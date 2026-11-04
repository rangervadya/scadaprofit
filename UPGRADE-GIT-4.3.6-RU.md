# Публикация 4.3.6 через Git

Архив содержит проект без `.git` и `.env`. Скопируйте файлы поверх рабочей копии репозитория, предварительно сохранив локальные изменения и конфигурацию.

```bash
git status
# скопируйте файлы проекта 4.3.6 в рабочую копию

git add -A
git commit -m "Release CAD Reconstruction Engine 4.3.6"
git push origin main
```

Затем на сервере (сначала сохрани старые задания 4.3.5, пока старый контейнер ещё работает):

```bash
cd /opt/scadaprofit
mkdir -p local-backups/jobs-4.3.5
APP_CID=$(sudo docker compose ps -q app)
sudo docker cp "$APP_CID":/tmp/cad-reconstruction-jobs/. ./local-backups/jobs-4.3.5/

git pull --ff-only origin main
sudo docker compose config --quiet
sudo docker compose build app
sudo docker compose up -d --no-deps app

APP_CID=$(sudo docker compose ps -q app)
sudo docker cp ./local-backups/jobs-4.3.5/. "$APP_CID":/data/cad-reconstruction-jobs/
sudo docker compose exec -T -u root app chown -R node:node /data/cad-reconstruction-jobs
curl -sS http://127.0.0.1:3001/api/health
```

Начиная с 4.3.6 задания сохраняются в постоянном named volume `cad_jobs`, поэтому переживают пересоздание контейнера. Если старые задания не нужны, шаги `docker cp` можно пропустить.

Убедитесь, что сервер показывает `version: 4.3.6`. Не выполняйте `docker compose down -v`.
