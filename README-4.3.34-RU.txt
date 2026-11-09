ScadaProfit 4.3.34 — исправление лимита MOSS Vision

КАК УСТАНОВИТЬ НА MAC
1. Распакуйте архив в корень проекта cad-sketch-converter-docker-2.2.
2. Согласитесь заменить moss_ai.py, package.json и tests/test_moss_ai.py.
3. Не удаляйте и не добавляйте api.txt в Git.
4. В терминале проекта выполните:

   npm run check
   git diff --check
   git status --short

5. Если проверки прошли, отправьте только эти файлы:

   git add moss_ai.py package.json tests/test_moss_ai.py CHANGELOG-4.3.34-RU.md UPDATE-MANIFEST-4.3.34.txt
   git commit -m "Fix MOSS Vision output token limit 4.3.34"
   git push origin main

ОБНОВЛЕНИЕ СЕРВЕРА ПОСЛЕ УСПЕШНОГО PUSH

   cd /opt/scadaprofit
   git pull --ff-only origin main
   sudo docker compose config --quiet
   sudo docker compose build app

Только если сборка успешна:

   sudo docker compose up -d --no-deps app
   sudo docker compose ps

ПРОВЕРКА
После обновления повторите отдельный MOSS Vision test. HTTP 400 с текстом
"max_output_tokens must be between 1 and 8192" больше не должен возникать.

ВАЖНО
- В MOSS Vision установлен max_output_tokens=8192, что соответствует максимуму API.
- Это исправление устраняет ошибку параметра запроса, но само по себе не гарантирует,
  что модель распознает трубные маршруты. Количество найденных и принятых маршрутов
  нужно проверить на исходной схеме.
- Не заменять server.js, moss-env-boot.js, compose.yaml или конфигурацию Nginx.
- Не менять VDGO, PostgreSQL, Docker volumes и остальные сервисы.
- На сервере перезапускается только app.
