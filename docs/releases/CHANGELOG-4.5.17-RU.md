# ScadaProfit 4.5.17 — исправление Docker-проверок frontend

- Исправлен Dockerfile: после сборки SPA в runtime-stage копируются исходники frontend, `index.html` и `vite.config.ts`, которые проверяет `repository-layout.test.js`.
- Два ранее падавших теста теперь проходят; проверки не отключались и не заменялись заглушками.
- Синхронизированы `VERSION` и версия backend package: `4.5.17`.
- Все 31 Node.js-теста обязательного `npm run check` прошли локально; также прошли CAD regression-тесты и 200 Python-тестов.

## Обновление

```bash
git pull --ff-only
docker compose build --no-cache app
# Выполнять только после успешной сборки:
docker compose up -d --no-deps --force-recreate app
docker compose restart gateway
docker compose ps
curl -fsS http://localhost:3001/api/health
```

В ответе `/api/health` ожидается `"version":"4.5.17"`. Если `docker compose build` завершился с ошибкой, не выполняйте `up`: это оставит старый образ в работе. Не удаляйте постоянные Docker-тома.
