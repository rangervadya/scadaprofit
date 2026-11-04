# Как опубликовать 4.3.5 через Git

Архив 4.3.5 — полный исходный проект без `.git` и `.env`. Его нужно перенести в рабочую копию репозитория на компьютере, с которого публикуются изменения.

```bash
# Перейди в свою локальную рабочую копию проекта
cd /path/to/scadaprofit

# Распакуй содержимое архива 4.3.5 поверх рабочей копии,
# сохранив .git и серверный .env (в архиве их нет).

# Проверь список файлов и тесты
npm run check

git status
git add -A
git commit -m "Release CAD Reconstruction Engine 4.3.5"
git push origin main
```

После успешной отправки коммита на сервере:

```bash
cd /opt/scadaprofit
sudo git status
sudo git pull --ff-only origin main
sudo docker compose config --quiet
sudo docker compose build app
sudo docker compose up -d --no-deps app
curl -sS http://127.0.0.1:3001/api/health
```

Проверь `version: 4.3.5`, затем выполни жёсткое обновление страницы в браузере. Не запускай `docker compose down -v`; не заменяй `.env` и `.git`.
