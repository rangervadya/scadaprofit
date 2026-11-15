# JSON → PostgreSQL: план миграции

Документ-чеклист, чтобы не потеряться при поэтапном отказе от JSON.
Статус: **в работе**. Обновляется после каждого этапа.

## 0. Принцип

- **PostgreSQL — единственное рабочее хранилище state-сущностей.**
- JSON остаётся только для:
  - разового backfill;
  - производных артефактов (`graph.json`, `diagnostics.json`);
  - legacy-файлов, которые ещё не вычищены.
- Файлы (изображения, PDF, DOCX, SVG, DXF) остаются на томе; в БД — метаданные.

## 1. Текущий статус

| Данные | Файл | Статус | Таблица |
|---|---|---|---|
| Пользователи | `workforce/users.json` | **PostgreSQL** | `users` |
| Сессии | `workforce/sessions.json` | **PostgreSQL** | `sessions` |
| Идемпотентность | — | **PostgreSQL** | `idempotency_keys` |
| Manual CAD | `manual-cad/<id>/project.json` | **PostgreSQL** | `manual_cad_projects` (`jsonb`) |
| Адресная библиотека | `address-library.json` | **PostgreSQL (нормализованные таблицы)** | `address_streets`, `address_buildings`, `address_schemes` |
| Задания/отчёты/дефекты | `workforce/workspace.json` | **PostgreSQL (нормализованные таблицы)** | `workforce_tasks`, `workforce_reports`, `workforce_defect_reports` |
| Метаданные схемы | `schemes/<jobId>.json` | **PostgreSQL** | `scheme_meta` (`jsonb`) |
| Архив | `output/archive_index.json` | **PostgreSQL** | `archive_entries` |
| Граф/диагностика | `<jobId>/graph.json`, `diagnostics.json` | файлы | артефакт тома |
| Фото/эскизы | `report-files/*` | файлы | том + метаданные в БД |
| Шаблон | `template/*` | файл | том |

## 2. Этапы

### Этап 1 — auth (готово)

- [x] Prisma `User`, `Session`.
- [x] `users`/`sessions` читаются и пишутся в PostgreSQL.
- [x] JSON только one-time backfill.
- [x] `AUTH_BACKEND=postgres` по умолчанию.
- [x] Проверка: backfill, login/logout/create user, Playwright.
- [x] Коммит `1405103`.

### Этап 2 — manual CAD (готово)

- [x] Prisma `ManualCadProject` (`data jsonb`).
- [x] Миграция `manual_cad_projects` + индексы по `sourceJobId`/`sourceReportId`.
- [x] `manual-cad-repo.js`: read/list/save/find.
- [x] Backfill существующих `project.json`.
- [x] Заменить файловые операции в `server.js`.
- [x] Проверка: создать/открыть/сохранить проект, новый `project.json` не создаётся.
- [x] Playwright: CAD-список и редактор.
- [x] Коммит будет добавлен после этого этапа.

### Этап 3 — address library (готово, jsonb)

- [x] `address_library` singleton (`id=1`, `data jsonb`, `schema_version`) — заменён нормализованными таблицами (P1-14).
- [x] `address-library-repo.js`: read/save.
- [x] Backfill существующего `address-library.json`.
- [x] `readAddressLibrary`/`saveAddressLibrary` работают через PG.
- [x] Проверка: `/api/library` отдаёт улицы из PG; добавление улицы пишет только в PG, mtime JSON не меняется; Playwright `/schemes` показывает папки.
- [ ] Нормализация в `address_streets/buildings/schemes` — отдельный этап, если понадобится реляционная отчётность.

### Этап 4 — workforce workspace (готово, jsonb)

- [x] `workforce_workspace` singleton (`data jsonb`).
- [x] **P1-14**: `workforce_workspace` → `workforce_tasks` / `workforce_reports` / `workforce_defect_reports`;
  `address_library` → `address_streets` / `address_buildings` / `address_schemes`
  (миграция `20261116120000_normalize_address_and_workspace`, backfill, индексы).
  Репозитории читают из таблиц; legacy JSONB обновляется write-through до снятия.
- [x] `workforce-workspace-repo.js`: read/save.
- [x] Backfill существующего `workspace.json`.
- [x] `saveWorkspace` пишет в PG; файл не обновляется.
- [x] Проверка: 2 задачи/1 отчёт из JSON, создание задачи → 3 в PG, mtime JSON unchanged; Playwright `/team`.
- [ ] Нормализация в `workforce_tasks/reports/defect_reports` — отдельный этап.

### Этап 4.1 — scheme meta (готово)

- [x] `scheme_meta` (`job_id`, `status`, `data jsonb`).
- [x] `scheme-meta-repo.js`: read/save.
- [x] Backfill `.private/schemes/*.json`.
- [x] `readSchemeMeta`/`writeSchemeMeta` работают через PG.
- [x] Проверка: backfill 1 схемы, `POST .../analyze` → status `processing` в PG, mtime JSON unchanged.

### Этап 5 — archive / cleanup (archive готов)

- [x] `archive_entries` в PostgreSQL (`database.py`).
- [x] `archive.py`: DB-first read/write, JSON fallback.
- [x] Backfill существующего `archive_index.json`.
- [x] Проверка: 1 запись из JSON, `archive_document` пишет в PG, download 200, mtime JSON unchanged.
- [ ] Удалить legacy JSON-код и файлы после резервной копии.
- [ ] Retention/backup.

## 3. Backfill

```bash
# При старте приложение само импортирует legacy JSON, если в БД нет записи.
# Принудительный запуск — перезапустить сервис с AUTH_BACKEND=postgres.
AUTH_BACKEND=postgres DATABASE_URL=... npm --prefix services/ollama start
```

Проверка после backfill:

```sql
select count(*) from users;
select count(*) from sessions;
select count(*) from manual_cad_projects;
```

## 4. Откат

- `AUTH_BACKEND=json` больше не поддерживается: legacy JSON-хранилища удалены
  после бэкапа, приложение fail-fast без PostgreSQL (`POSTGRES_REQUIRED`).
- Для manual CAD откат — восстановить предыдущий коммит и БД из бэкапа
  (`infra/scripts/restore.sh`).
- Перед удалением JSON делать копию тома (`infra/scripts/backup.sh`).

## 5. Правила

- Не писать новые state-данные в JSON.
- Не читать state из JSON после успешного backfill.
- Файлы артефактов не переносить в БД.
- Любая таблица — с миграцией и индексом.
- После каждого этапа: `npm run verify`, Playwright, коммит.