#!/usr/bin/env bash
# Retention: удаляет старые артефакты заданий из тома cad_jobs.
# Usage: infra/scripts/retention.sh [days]
# Env:   RETENTION_DAYS (default 30)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

DAYS="${1:-${RETENTION_DAYS:-30}}"
if ! [[ "$DAYS" =~ ^[0-9]+$ ]]; then
  echo "Использование: $0 <days>" >&2
  exit 1
fi

echo "Retention: удаляю задания старше $DAYS дней из тома cad_jobs"

# Том смонтирован в контейнере app как /data/cad-reconstruction-jobs.
# find -mtime +N — каталоги/файлы, не изменявшиеся N*24 часа.
docker compose exec -T app \
  sh -c "find /data/cad-reconstruction-jobs -mindepth 1 -maxdepth 1 -type d -mtime +$DAYS -print -exec rm -rf {} + 2>/dev/null" \
  || echo "Не удалось выполнить retention (app не запущен?)"

# Idempotent-replay copies live in the VDGO output volume; drop the stale ones.
if [ "${WITH_VDGO_IDEM:-1}" = "1" ]; then
  echo "Retention: чищу идемпотентные копии старше $DAYS дней в vdgo-backend"
  docker compose exec -T vdgo-backend \
    sh -c "find /app/output/.idem -type f -mtime +$DAYS -print -delete 2>/dev/null" \
    || echo "  ! vdgo-backend не запущен — пропуск"
fi

echo "Готово. Проверьте: docker compose exec app du -sh /data/cad-reconstruction-jobs"