# ScadaProfit 4.5.16 — исправление сборки frontend

- Исправлена TypeScript-ошибка в `frontend/src/pages/LoginPage.tsx`: при недоступности `/api/auth/status` используется безопасный режим обычного входа вместо обращения к несуществующему `setSetupRequired`.
- Первичная настройка разработчика по-прежнему включается, когда сервер явно возвращает `setupRequired: true`.
- Корневой файл `VERSION` стал единым источником версии основного backend; в образ копируется `VERSION`, чтобы лог приложения показывал 4.5.16. Версия отдельного VDGO backend image остаётся 5.3.9.
- Добавлена инструкция: не выполнять `docker compose up` после неуспешной сборки; сначала необходимо добиться успешного `docker compose build app`.

## Обновление

```bash
git pull --ff-only
docker compose build --no-cache app
docker compose up -d --no-deps --force-recreate app
docker compose restart gateway
docker compose ps
docker compose logs --tail=100 app
```

Успешный запуск основного backend должен показывать `ScadaProfit 4.5.16`. Если сборка завершилась с ошибкой, не выполняйте `up`: он может оставить запущенным старый image.
