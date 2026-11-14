# Runbook — эксплуатация ScadaProfit

Краткая инструкция для локального запуска, проверки и восстановления.
Полный план — `docs/REFACTOR-BACKEND-PLAN-RU.md`.

## Локальный запуск

```bash
cp .env.example .env          # при первом запуске
docker compose up -d          # ollama, vdgo-db, vdgo-backend, app, gateway
docker compose ps             # все сервисы healthy
curl -fsS localhost:${WEB_PORT:-3001}/api/health
curl -fsS localhost:${WEB_PORT:-3001}/api/readyz   # 503 без Ollama — норма
```

Порты: gateway `3001`, app `3000` (внутри), vdgo `8765` (внутри), PostgreSQL `55432`/`5432`.

## Проверка контракта и качества

```bash
npm run verify    # format:check + lint + typecheck + node/vdgo тесты
```

Отдельно:

```bash
npm run lint        # eslint + ruff
npm run typecheck   # tsc
npm run test        # node + vdgo
```

## Backups

```bash
infra/scripts/backup.sh                     # ./backups/<UTC>/
BACKUP_KEEP=14 infra/scripts/backup.sh      # хранить 14 снимков
```

Состав: `db.sql.gz` (pg_dump) + `cad_jobs.tar.gz`, `vdgo_output.tar.gz`,
`vdgo_uploads.tar.gz`. Подробности — `docs/BACKUP-RESTORE-RU.md`.

## Restore

```bash
infra/scripts/restore.sh ./backups/20261114T180000Z
docker compose up -d
curl -fsS localhost:${WEB_PORT:-3001}/api/readyz
```

Перед production — учебное восстановление на чистой машине (restore drill).

## Retention

```bash
infra/scripts/retention.sh          # задания старше 30 дней
RETENTION_DAYS=60 infra/scripts/retention.sh
```

Сессии чистятся автоматически (hourly, TTL 7 дней).

## Типовые проверки

| Что | Как |
|---|---|
| Сервис жив | `curl -fsS /api/health` |
| Зависимости | `curl -fsS /api/readyz` → `checks.ollama/model/tesseract` |
| Логи | `docker compose logs -f app` (JSON, есть `req.id`) |
| Долгий запрос | `docker compose logs app \| grep '"requestId"'` |
| Миграции | `npm --prefix services/ollama run db:validate` |

## Аварийные ситуации

| Симптом | Действие |
|---|---|
| 503 на `/api/readyz` | Проверить `checks`; при отсутствии Ollama — базовые сервисы работают |
| 429 на `/api/analyze` | Сервис занят (`MAX_CONCURRENT_PYTHON_JOBS`) или превышена квота `HEAVY_QUOTA_LIMIT` |
| 409 `REVISION_CONFLICT` | Чертёж изменил другой редактор — обновить страницу |
| 502/504 от gateway | Проверить `vdgo-backend` и `app` (`docker compose ps`, логи) |
| Нет места | `infra/scripts/retention.sh`, затем `docker system prune` |

## Что отложено до production

- TLS/`Secure` cookie, дефолтный пароль БД (P0-7).
- CSRF, idle timeout, global revoke-all (P1-2).
- Shared store для rate-limit/сессий (multi-instance, P1-2/P1-11).
- OTel/metrics/tracing/dashboards/alerts (P1-5).
- Compose hardening: read-only FS, cap-drop (P1-12).