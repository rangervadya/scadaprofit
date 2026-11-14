#!/usr/bin/env bash
# Backup ScadaProfit state: PostgreSQL dump + named Docker volumes.
# Usage: infra/scripts/backup.sh [backup_dir]
# Env:   BACKUP_KEEP (default 7) — number of recent backups to retain.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

BACKUP_DIR="${1:-${BACKUP_DIR:-$ROOT/backups}}"
BACKUP_KEEP="${BACKUP_KEEP:-7}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET="$BACKUP_DIR/$STAMP"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker не найден" >&2
  exit 1
fi

mkdir -p "$TARGET"

echo "[1/3] pg_dump vdgo-db → $TARGET/db.sql.gz"
docker compose exec -T vdgo-db \
  sh -c "pg_dump -U \"\${POSTGRES_USER:-vdgo_app}\" -d \"\${POSTGRES_DB:-vdgo}\" --no-owner --no-privileges" \
  | gzip -9 > "$TARGET/db.sql.gz"

echo "[2/3] Архивирую тома (cad_jobs, vdgo_output, vdgo_uploads)"
for vol in cad_jobs vdgo_output vdgo_uploads; do
  echo "  → $vol.tar.gz"
  docker run --rm \
    -v "${vol}:/volume:ro" \
    -v "$TARGET:/backup" \
    alpine:3.20 \
    tar czf "/backup/${vol}.tar.gz" -C /volume . 2>/dev/null || echo "  ! том $vol пропущен"
done

echo "[3/3] Retention: храню последние $BACKUP_KEEP снимков в $BACKUP_DIR"
# Оставляем BACKUP_KEEP самых свежих каталогов (по имени-таймстампу).
ls -1d "$BACKUP_DIR"/*/ 2>/dev/null \
  | sort -r \
  | tail -n "+$((BACKUP_KEEP + 1))" \
  | xargs -r rm -rf

echo "Готово: $TARGET"
du -sh "$TARGET" 2>/dev/null || true