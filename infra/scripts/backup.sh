#!/usr/bin/env bash
# Backup ScadaProfit state: PostgreSQL dump + named Docker volumes.
#
# Usage: infra/scripts/backup.sh [backup_dir]
# Env:
#   BACKUP_KEEP   number of recent backups to retain (default 7)
#   PGURL         postgres connection URL; when set, pg_dump runs locally
#                 instead of `docker compose exec vdgo-db`
#   COMPOSE_DB    compose service name for the database (default vdgo-db)
#   WITH_VOLUMES  set to 0 to skip docker volume archives (default 1)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

BACKUP_DIR="${1:-${BACKUP_DIR:-$ROOT/backups}}"
BACKUP_KEEP="${BACKUP_KEEP:-7}"
WITH_VOLUMES="${WITH_VOLUMES:-1}"
COMPOSE_DB="${COMPOSE_DB:-vdgo-db}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET="$BACKUP_DIR/$STAMP"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker не найден" >&2
  exit 1
fi

mkdir -p "$TARGET"

echo "[1/3] pg_dump → $TARGET/db.sql.gz"
if [ -n "${PGURL:-}" ]; then
  pg_dump "$PGURL" --no-owner --no-privileges | gzip -9 > "$TARGET/db.sql.gz"
else
  docker compose exec -T "$COMPOSE_DB" \
    sh -c "pg_dump -U \"\${POSTGRES_USER:-vdgo_app}\" -d \"\${POSTGRES_DB:-vdgo}\" --no-owner --no-privileges" \
    | gzip -9 > "$TARGET/db.sql.gz"
fi

if [ "$WITH_VOLUMES" = "1" ]; then
  echo "[2/3] Архивирую тома (cad_jobs, vdgo_output, vdgo_uploads)"
  for vol in cad_jobs vdgo_output vdgo_uploads; do
    local_tar="$TARGET/${vol}.tar.gz"
    if docker volume inspect "$vol" >/dev/null 2>&1; then
      echo "  → $vol"
      docker run --rm \
        -v "${vol}:/volume:ro" \
        -v "$TARGET:/backup" \
        alpine:3.20 \
        tar czf "/backup/${vol}.tar.gz" -C /volume . 2>/dev/null || echo "  ! том $vol пропущен"
    else
      echo "  - том $vol отсутствует — пропуск"
    fi
  done
else
  echo "[2/3] Пропускаю тома (WITH_VOLUMES=0)"
fi

echo "[3/3] Retention: храню последние $BACKUP_KEEP снимков в $BACKUP_DIR"
ls -1d "$BACKUP_DIR"/*/ 2>/dev/null \
  | sort -r \
  | tail -n "+$((BACKUP_KEEP + 1))" \
  | xargs -r rm -rf

echo "Готово: $TARGET"
du -sh "$TARGET" 2>/dev/null || true