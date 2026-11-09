SCADAPROFIT 4.3.35 — УСТАНОВКА

1. Распакуйте архив в корень локального проекта cad-sketch-converter-docker-2.2.
2. Замените moss_ai.py, package.json и tests/test_moss_ai.py. Остальные файлы архива добавьте.
3. Не удаляйте и не добавляйте api.txt.
4. На Mac выполните:

   npm run check
   git diff --check
   git status --short

5. Если проверки прошли, отправьте только указанные файлы:

   git add moss_ai.py package.json tests/test_moss_ai.py CHANGELOG-4.3.35-RU.md UPDATE-MANIFEST-4.3.35.txt README-4.3.35-RU.txt
   git commit -m "Reduce MOSS Vision timeout risk 4.3.35"
   git push origin main

6. На сервере после успешного push:

   cd /opt/scadaprofit
   git pull --ff-only origin main
   sudo docker compose config --quiet
   sudo docker compose build app

Только если сборка прошла успешно:

   sudo docker compose up -d --no-deps app
   sudo docker compose ps

ОГРАНИЧЕНИЯ:
- Не менять/не удалять api.txt и секретные ключи.
- Не изменять server.js, moss-env-boot.js, compose.yaml, Nginx, VDGO, PostgreSQL и Docker volumes.
- На сервере перезапускать только сервис app.

ПРИМЕЧАНИЕ: HTTP 524 означает, что внешний API-шлюз не дождался синхронного ответа MOSS.
В этой версии уменьшен объём Vision-ответа и сокращён prompt; если сам MOSS API
перегружен или недоступен, HTTP 524 всё ещё может повториться.
