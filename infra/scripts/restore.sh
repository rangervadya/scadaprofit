#!/usr/bin/env bash
# Restore ScadaProfit state from a backup directory produced by backup.sh.
#
# Usage: infra/scripts/restore.sh <backup_dir>
# Env:
#   PGURL        postgres connection URL; when set, psql runs locally instead of
#                `docker compose exec vdgo-db`
#   COMPOSE_DB   compose service name for the database (default vdgo-db)
#   WITH_VOLUMES set to 0 to skip volume restore (default 1)
#
# WARNING: overwrites the current database and named volumes.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

BACKUP_DIR="${1:-}"
WITH_VOLUMES="${WITH_VOLUMES:-1}"
COMPOSE_DB="${COMPOSE_DB:-vdgo-db}"

if [[ -z "$BACKUP_DIR" || ! -d "$BACKUP_DIR" ]]; then
  echo "Использование: $0 <backup_dir>" >&2
  exit 1
fi
if [[ ! -f "$BACKUP_DIR/db.sql.gz" ]]; then
  echo "В $BACKUP_DIR нет db.sql.gz — это не похоже на бэкап." >&2
  exit 1
fi

echo "[1/3] Восстанавливаю PostgreSQL из $BACKUP_DIR/db.sql.gz"
if [ -n "${PGURL:-}" ]; then
  gunzip -c "$BACKUP_DIR/db.sql.gz" | psql "$PGURL" -v ON_ERROR_STOP=1 -q
else
  gunzip -c "$BACKUP_DIR/db.sql.gz" \
    | docker compose exec -T "$COMPOSE_DB" \
        sh -c "psql -U \"\${POSTGRES_USER:-vdgo_app}\" -d \"\${POSTGRES_DB:-vdgo}\" -v ON_ERROR_STOP=1 -q" \
    || {
      echo "Ошибка восстановления БД. Если дамп без --clean, сначала очистите схему." >&2
      exit 1
    }
fi

if [ "$WITH_VOLUMES" = "1" ]; then
  echo "[2/3] Восстанавливаю тома"
  for vol in cad_jobs vdgo_output vdgo_uploads; do
    local_tar="$BACKUP_DIR/${vol}.tar.gz"
    if [[ -f "$local_tar" ]]; then
      echo "  → $vol"
      docker volume create "$vol" >/dev/null
      docker run --rm \
        -v "${vol}:/volume" \
        -v "$BACKUP_DIR:/backup:ro" \
        alpine:3.20 \
        sh -c "rm -rf /volume/* /volume/..?* /volume/.[!.]* 2>/dev/null; tar xzf /backup/${vol}.tar.gz -C /volume"
    else
      echo "  - $vol.tar.gz отсутствует — пропуск"
    fi
  done
else
  echo "[2/3] Пропускаю тома (WITH_VOLUMES=0)"
fi

echo "[3/3] Готово. Перезапустите сервисы: docker compose up -d"
echo "Проверьте: curl -fsS localhost:\${WEB_PORT:-3001}/api/readyz"