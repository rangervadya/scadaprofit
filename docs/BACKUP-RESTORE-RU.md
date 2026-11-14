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
1. Поднимите пустой `docker compose up -d vdgo-db`.
2. `infra/scripts/restore.sh <backup_dir>`.
3. Проверьте, что auth/manual-CAD/workspace читаются из восстановленной БД.
4. Сверьте `pg_dump` и снимок томов с эталонными размерами.

DoD для P1-4: бэкап создаётся одной командой, восстановление проверено на чистой машине, retention не удаляет свежие данные.