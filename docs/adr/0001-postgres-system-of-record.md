# ADR 0001 — PostgreSQL как system of record

- **Статус**: принято
- **Дата**: 2026-11-14
- **Контекст**: см. `docs/REFACTOR-BACKEND-PLAN-RU.md`, P1-1/P1-14

## Контекст

Изначально ScadaProfit хранил всё состояние в JSON-файлах (`users.json`,
`sessions.json`, `workspace.json`, `address-library.json`, `manual-cad/*/project.json`,
`schemes/*/meta.json`, `archive_index.json`). Это приводило к гонкам при записи,
потере данных при сбое в момент `write`, невозможности масштабирования на
несколько инстансов и отсутствию транзакций.

## Решение

PostgreSQL — единственный system of record для изменяемого состояния:

| Таблица | Назначение |
|---|---|
| `users`, `sessions` | аутентификация, сессии |
| `idempotency_keys` | идемпотентность `POST /tasks`, `POST /analyze` |
| `manual_cad_projects` | проекты ручного CAD (`revision` для оптимистичной блокировки) |
| `address_library` (jsonb) | справочник улиц/домов/схем |
| `workforce_workspace` (jsonb) | задания, отчёты, дефекты |
| `scheme_meta` | метаданные схем |
| `archive_entries` | архив отчётов |

JSON-файлы остаются только для:
1. one-time backfill при пустой БД;
2. `AUTH_BACKEND=json` как legacy fallback;
3. производных артефактов (`graph.json`, `diagnostics.json`) — они не source of truth.

## Последствия

- **Плюсы**: атомарные записи через Prisma/транзакции, конкурентный доступ, бэкап
  через `pg_dump` (`infra/scripts/backup.sh`), метрики БД.
- **Минусы**: `address_library` и `workforce_workspace` — JSONB-синглтоны, без
  реляционных запросов по вложенным полям (P1-14).
- **Открыто**: in-memory кэш `users`/`sessions`/`workspace` мешает multi-instance
  (нужен shared store, P1-2).
- **Отложено до прода**: удаление legacy JSON-кода и файлов после restore drill.

## Ссылки

- `docs/MIGRATION-JSON-TO-POSTGRES-RU.md`
- `services/ollama/prisma/schema.prisma`
- `infra/scripts/backup.sh`, `infra/scripts/restore.sh`