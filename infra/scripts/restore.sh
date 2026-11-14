#!/usr/bin/env bash
# Restore ScadaProfit state from a backup directory produced by backup.sh.
# Usage: infra/scripts/restore.sh <backup_dir>
# WARNING: overwrites the current database and named volumes.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

BACKUP_DIR="${1:-}"
if [[ -z "$BACKUP_DIR" || ! -d "$BACKUP_DIR" ]]; then
  echo "Использование: $0 <backup_dir>" >&2
  exit 1
fi
if [[ ! -f "$BACKUP_DIR/db.sql.gz" ]]; then
  echo "В $BACKUP_DIR нет db.sql.gz — это не похоже на бэкап." >&2
  exit 1
fi

echo "[1/3] Восстанавливаю PostgreSQL из $BACKUP_DIR/db.sql.gz"
# Дамп сделан --clean-совместимым способом: сначала drop, потом restore.
gunzip -c "$BACKUP_DIR/db.sql.gz" \
  | docker compose exec -T vdgo-db \
      sh -c "psql -U \"\${POSTGRES_USER:-vdgo_app}\" -d \"\${POSTGRES_DB:-vdgo}\" -v ON_ERROR_STOP=1" \
  || {
    echo "Ошибка восстановления БД. Если дамп без --clean, сначала очистите схему." >&2
    exit 1
  }

echo "[2/3] Восстанавливаю тома"
for vol in cad_jobs vdgo_output vdgo_uploads; do
  local_tar="$BACKUP_DIR/${vol}.tar.gz"
  if [[ -f "$local_tar" ]]; then
    echo "  → $vol"
    docker run --rm \
      -v "${vol}:/volume" \
      -v "$BACKUP_DIR:/backup:ro" \
      alpine:3.20 \
      sh -c "rm -rf /volume/* /volume/..?* /volume/.[!.]* 2>/dev/null; tar xzf /backup/${vol}.tar.gz -C /volume"
  else
    echo "  ! $vol.tar.gz отсутствует — пропуск"
  fi
done

echo "[3/3] Готово. Перезапустите сервисы: docker compose up -d"
echo "Проверьте: curl -fsS localhost:\${WEB_PORT:-3001}/api/readyz"