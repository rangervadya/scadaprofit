# Установка CAD Reconstruction Engine 4.3.6

## Важно перед обновлением

1. Сделайте резервную копию проекта и `.env`.
2. До пересоздания контейнера сохраните существующие задания из старого временного каталога. В 4.3.5 данные были в `/tmp` внутри контейнера, поэтому без этой операции текущие задания не перейдут в постоянный том:

```bash
cd /opt/scadaprofit
mkdir -p local-backups/jobs-4.3.5
APP_CID=$(sudo docker compose ps -q app)
sudo docker cp "$APP_CID":/tmp/cad-reconstruction-jobs/. ./local-backups/jobs-4.3.5/
```

Если Docker ответит, что каталог не найден или пуст, проверьте список заданий до продолжения.

3. Опубликуйте полный коммит 4.3.6 в ветку `main` из рабочей копии Git. Не заменяйте `.git` и `.env` архивом.
4. На сервере выполните:

```bash
cd /opt/scadaprofit
git status
git pull --ff-only origin main
sudo docker compose config --quiet
sudo docker compose build app
sudo docker compose up -d --no-deps app
```

5. После пересоздания контейнера перенесите старые задания в новый постоянный том:

```bash
APP_CID=$(sudo docker compose ps -q app)
sudo docker cp ./local-backups/jobs-4.3.5/. "$APP_CID":/data/cad-reconstruction-jobs/
sudo docker compose exec -T -u root app chown -R node:node /data/cad-reconstruction-jobs
```

## Проверка

```bash
curl -sS http://127.0.0.1:3001/api/health
sudo docker compose ps
sudo docker compose logs -f --tail=100 app
```

Ожидаемые значения: `version` — `4.3.6`; `pythonJobTimeoutMs` — `2700000`.

## Как работает сохранение соединений

После анализа адрес страницы получает `?job=<uuid>`. Подтверждённый кандидат сохраняется сервером в `graph.json`; соединение также добавляется в текущий граф для SVG/DXF/JSON экспорта. При обновлении страницы с этим URL граф восстанавливается через `/api/jobs/<uuid>/graph`.

В 4.3.6 задания хранятся в `/data/cad-reconstruction-jobs`, подключённом к отдельному Docker-томy `cad_jobs`. Это сохраняет исходные изображения, графы и подтверждённые соединения при пересоздании контейнера приложения. Для уже существующих заданий 4.3.5 используйте однократный перенос из `/tmp`, приведённый выше.

Подтверждение требует отдельного клика и подтверждения диалога. Конкурирующие варианты не объединяются автоматически. Оценка кандидата — эвристический рейтинг, не вероятность правильного соединения.

Не выполняйте `docker compose down -v`; не удаляйте тома Ollama и не заменяйте `.env`.
