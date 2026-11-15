# Backup, Restore и Retention

Скрипты для резервного копирования и восстановления состояния ScadaProfit.
Все скрипты работают поверх `docker compose` и рассчитаны на локальную/production-машину с установленным Docker.

## Что копируется

| Источник | Тип | Скрипт |
|---|---|---|
| PostgreSQL (`vdgo-db`) | `pg_dump` → `db.sql.gz` | `backup.sh` / `restore.sh` |
| Том `cad_jobs` (`/data/cad-reconstruction-jobs`) | `tar.gz` | `backup.sh` / `restore.sh` |
| Том `vdgo_output` (`/app/output`) | `tar.gz` | `backup.sh` / `restore.sh` |
| Том `vdgo_uploads` (`/app/uploads`) | `tar.gz` | `backup.sh` / `restore.sh` |

Схемы Prisma и миграции восстанавливаются автоматически при старте приложения (`prisma migrate deploy`), поэтому в бэкап не входят.

## Backup

```bash
# По умолчанию: ./backups/<UTC-таймстамп>/, хранит 7 последних снимков
infra/scripts/backup.sh

# Свой каталог и глубина retention
BACKUP_DIR=/var/backups/scadaprofit BACKUP_KEEP=14 infra/scripts/backup.sh
```

Скрипт:
1. Делает `pg_dump` БД `vdgo-db`.
2. Архивирует тома `cad_jobs`, `vdgo_output`, `vdgo_uploads` через одноразовый `alpine` контейнер.
3. Удаляет снимки старше `BACKUP_KEEP` (по имени-таймстампу).

## Restore

```bash
infra/scripts/restore.sh ./backups/20261114T180000Z
```

Скрипт:
1. Восстанавливает БД из `db.sql.gz` (требует, чтобы дамп был с `--clean`; иначе сначала очистите схему).
2. Распаковывает тома.
3. После восстановления: `docker compose up -d` и проверка `curl -fsS localhost:${WEB_PORT:-3001}/api/readyz`.

## Retention

```bash
# Удалить задания старше 30 дней из тома cad_jobs
infra/scripts/retention.sh

# Свой срок
RETENTION_DAYS=60 infra/scripts/retention.sh
```

Сессии в PostgreSQL чистятся автоматически (hourly cleanup в `workforce-system.js`, TTL 7 дней).

## Проверка бэкапа (restore drill)

Перед production-деплоем выполните учебное восстановление на чистой машине:

```bash
# 1. Чистая БД-сервис (пример локально)
docker run -d --rm --name drill-pg \
  -e POSTGRES_DB=vdgo -e POSTGRES_USER=vdgo_app -e POSTGRES_PASSWORD=drill \
  -p 55434:5432 postgres:17.7-alpine

# 2. Бэкап из рабочей БД (без томов)
PGURL=postgresql://vdgo:vdgo@localhost:55432/vdgo WITH_VOLUMES=0 \
  infra/scripts/backup.sh /tmp/drill-backups

# 3. Восстановление в чистую БД
PGURL=postgresql://vdgo_app:drill@localhost:55434/vdgo WITH_VOLUMES=0 \
  infra/scripts/restore.sh /tmp/drill-backups/<timestamp>

# 4. Сверка и запуск приложения на восстановленной БД
PGPASSWORD=drill psql postgresql://vdgo_app@localhost:55434/vdgo -c \
  "select 'users='||count(*) from users;"
PORT=3993 AUTH_BACKEND=postgres \
  DATABASE_URL=postgresql://vdgo_app:drill@localhost:55434/vdgo node services/ollama/api/server.js
curl -fsS localhost:3993/api/health
```

### Результат последнего drill (2026-11-15)

| Проверка | Результат |
|---|---|
| `pg_dump` из рабочей БД | OK, `db.sql.gz` 8 КБ |
| `psql` restore в чистый контейнер | OK, без ошибок |
| Сверка `users/sessions/projects/archive/idempotency/ratelimit` | совпадает (5/0/2/2/1/0) |
| Запуск приложения на восстановленной БД | `health=200`, `auth/status=200` |
| Cleanup | контейнер удалён, бэкапы удалены |

**DoD P1-4 выполнен:** бэкап создаётся одной командой, восстановление проверено на чистой машине,
приложение поднимается на восстановленных данных.