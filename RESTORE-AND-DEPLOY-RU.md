# Восстановление ScadaProfit 4.5.21

## Что находится в этой сборке

Это полная исходная структура проекта из релиза 4.5.20 с выбранным frontend из `frontend.tar.xz` и совместимыми функциональными исправлениями. Основной Node.js API, CAD-движок Python, сервис ВДГО, шаблоны, Compose и тесты сохранены.

В корне используется только `compose.yaml`. Отдельный `docker-compose.yml` не нужен.

## GitHub

1. Сделайте резервную копию текущей рабочей копии и `.env`.
2. Замените рабочие файлы содержимым этого архива, сохранив `.git` и свой `.env`.
3. Проверьте наличие `backend/api/server.js`, `backend/api/workforce-system.js`, `backend/engine/processor.py`, `frontend/src/main.tsx` и `compose.yaml`.
4. Убедитесь, что нет конкурирующего `docker-compose.yml`.
5. Выполните `git add -A`, `git commit -m "Restore complete ScadaProfit 4.5.21 project"`, `git push`.

## Сервер

Из каталога проекта:

```bash
git pull --ff-only
docker compose config -q
docker compose build --no-cache app vdgo-backend
```

Только если обе сборки завершились успешно:

```bash
docker compose up -d --remove-orphans --no-deps --force-recreate app vdgo-backend
docker compose restart gateway
docker compose ps
curl -fsS http://localhost:3001/api/health
```

Ожидаемая версия API: `4.5.21`.

**Не удаляйте постоянные Docker-тома** `cad_jobs`, `vdgo_postgres_data`, `vdgo_output`, `vdgo_uploads` и `ollama_data`. Не используйте `docker compose down -v`.
