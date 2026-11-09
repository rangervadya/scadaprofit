ScadaProfit 4.3.37 — MOSS Vision single-point retry

Замените файлы из архива в корне проекта cad-sketch-converter-docker-2.2:
- moss_ai.py
- package.json
- tests/test_moss_ai.py

Добавьте документацию из архива:
- CHANGELOG-4.3.37-RU.md
- UPDATE-MANIFEST-4.3.37.txt
- README-4.3.37-RU.txt

Проверка на Mac из полного проекта:
  npm run check
  git diff --check
  git status --short

После успешной проверки добавляйте в Git только перечисленные изменённые/новые файлы. Не добавляйте api.txt.

Публикация:
  git add moss_ai.py package.json tests/test_moss_ai.py CHANGELOG-4.3.37-RU.md UPDATE-MANIFEST-4.3.37.txt README-4.3.37-RU.txt
  git commit -m "Retry MOSS pipe routes after single-point response 4.3.37"
  git push origin main

Сервер (только после успешного push):
  cd /opt/scadaprofit
  git pull --ff-only origin main
  sudo docker compose config --quiet
  sudo docker compose build app

Только при успешной сборке:
  sudo docker compose up -d --no-deps app
  sudo docker compose ps

Не изменяются vdgo/, VDGO Frontend/Backend, PostgreSQL, Docker volumes,
compose.yaml, Nginx или другие сервисы. Перезапускается только app.
