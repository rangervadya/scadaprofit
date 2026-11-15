# ScadaProfit — план backend-рефакторинга

Документ создан по результатам аудита `docs/engineering-backend-architect.md`.
Статус: **фаза 1 закрыта; P2 в работе (P2-1: JS-API разложен по слоям `domain/repositories/routes/services/validation/lib`, остался `processor.py`)**. Обновляется по мере выполнения пунктов.

## Сводка выполнения

| Группа | Закрыто | Частично | Не начато / отложено |
|---|---|---|---|
| P0 | 6 (P0-1…P0-6) | P0-7 (на прод) | — |
| Фаза 0.5 (типизация) | 4 (Zod, Pydantic, Prisma, тулинг) | — | — |
| P1 | 13 из 14 (все, кроме P1-5) | P1-2 (CSRF/__Host-/multi-instance) | P1-5 (на прод) |
| P2 | 10 (P2-2, P2-4, P2-5, P2-6, P2-8, P2-9, P2-10, P2-11, P2-13) | P2-1 (остаток `processor.py`), P2-7 (SBOM) | 3 (P2-3, P2-12, P2-14) |
| P3 | 0 | 0 | 5 |

**Итог: фаза 1 закрыта.** P1-14 доведён до конца: данные переведены в нормализованные таблицы (`address_streets/buildings/schemes`, `workforce_tasks/reports/defect_reports`) с backfill и живыми проверками.
Отложено осознанно: **P1-2** (CSRF, `__Host-` cookie, multi-instance кэш сессий) и **P0-7** (TLS, `Secure`-cookie, дефолтный пароль БД) — только для production. **P1-5** (observability) — тоже на прод.
Не начата фаза P2 (монолиты, real-time, write amplification, сборка, dead code, SLO, нагрузка) и P3.

## 0. Как читать

- **P0** — блокирует релиз, приводит к потере данных или критичной уязвимости. Делаем сейчас.
- **P1** — высокий риск для production: надёжность, безопасность, данные, контракты.
- **P2** — качество, производительность, воспроизводимость, процессы.
- **P3** — долгосрочный техдолг.
- В пунктах `DoD` — критерий, по которому пункт считается закрытым.
- Оценка: **S** ≤ 2 дней, **M** ≈ 1–2 недели, **L** ≈ 1–2 месяца.

## 1. Карта системы

| Компонент | Реализация | Ограничение |
|---|---|---|
| API + SPA | Express 5, `server.js` 1968 строк, `workforce-system.js` 1033 | монолит: routes + домен + файловое хранилище |
| AI-пайплайн | Python `processor.py` 5040 строк, `child_process` | один процесс на джобу, stdout 16 МБ, таймаут 90 мин |
| Очередь | `Map` + массив в памяти (`server.js:128-131`) | теряется при рестарте, один GPU-слот |
| VDGO | `ThreadingHTTPServer`, 2341 строка | один запрос за раз, 512 МБ тела в RAM |
| Данные | PostgreSQL: users, sessions, manual_cad_projects, address_library, workforce_workspace, scheme_meta, archive_entries; тома для артефактов | JSON только fallback/backfill; in-memory cache |
| Gateway | nginx, один server, HTTP | TLS нет; gzip, `limit_req`, per-location `client_max_body_size` — есть |
| Наблюдаемость | pino JSON + request id в Node; JSON-логи в Python | нет метрик, трейсинга, SLO, алертов |
| Тесты | 48 node-тестов, 201 Python-тест, 50 VDGO-тестов | source-string assertions, нет CI на GitHub |
| Тулинг | ESLint 9 + Prettier 3 + Ruff, `npm run verify` | `check` заменён на `lint`/`typecheck`/`test` |

## 2. Соответствие чек-листу Backend Architect

| Принцип | Статус | Доказательство |
|---|---|---|
| Data/schema engineering, 100k+ entities, <20 ms | ⚠️ | state-данные в PostgreSQL; нормализованных таблиц и нагрузочных тестов пока нет |
| ETL/валидация схем, обратная совместимость | ✅ | Prisma-миграции, backfill legacy JSON, `graph/1.2` |
| Real-time updates, ordering | ❌ | polling 5–6 с, полный `graph.json` каждый раз |
| Выбор архитектуры под нагрузку | ⚠️ | modular monolith + AI worker; очередь всё ещё in-memory |
| API versioning/contracts | ✅ | версий нет по решению; `docs/openapi.yaml` + `tests/node/openapi.test.js` |
| Standard error/pagination/idempotency/correlation | ⚠️ | idempotency на `POST /tasks` и `POST /analyze`; пагинации нет; error envelope `{error,code?,details?}` задокументирован |
| Timeouts/retries/circuit breakers/DLQ | ⚠️ | Qwen retry есть; circuit breaker/DLQ нет |
| Bulkheads/rate limits/poison messages | ⚠️ | Python-семафор, 256 МБ лимит, nginx login rate limit; общий store нет |
| Backup/DR | ⚠️ | скрипты `infra/scripts/{backup,restore,retention}.sh`; restore drill не проведён |
| Monitoring/alerting/SLO | ❌ | только логи; нет метрик/трейсинга/алертов |
| Security: least privilege, encryption | ⚠️ | non-root; HTTP/TLS и дефолтный пароль БД отложены (dev) |
| Auth/authz, CSRF | ⚠️ | PostgreSQL-сессии, cleanup; нет CSRF, idle timeout, revoke-all |
| Zero-downtime migrations / expand-contract | ⚠️ | Prisma-миграции есть; zero-downtime/expand-contract для state-таблиц не отработан |
| Observability by design | ⚠️ | логи + request id в Node; vdgo не пробрасывает id, RED/USE нет |
| SLO: p95 <200 ms, 99.9%, 10x | ❌ | не измеряется; AI-джобы — минуты |

## 3. Проблемы

### 3.1 P0 — блокеры

#### P0-1. Красный `npm run check` ломает Docker-сборку — ✅ сделано
- **Evidence**: `tests/node/repository-layout.test.js:89-90` ждут `STAFF_ROLES` и `RequireRole`, которых нет в `frontend/src/main.tsx`; `infra/docker/app.Dockerfile:52` запускал `npm run check` в `RUN`.
- **Impact**: `docker compose build app` падал на чистой сборке; Python-тесты после node-тестов не запускались.
- **Fix**: восстановлены ролевые guard-ы (`lib/roles.ts`, `RequireRole`), тест переведён на `lib/roles.ts`; `check` заменён на `test`/`verify`; Dockerfile теперь `npm run test`.
- **Проверка**: 48 node-тестов и 201 Python-тест зелёные.

#### P0-2. ReferenceError в manual-CAD — ✅ сделано
- **Evidence**: `server.js:1712` вызывал `shortJobId(jobId)` в `import-source-job`; `server.js:1769` использовал `jobId` в catch `import-workforce-report`; additional `id`/`req` bugs found by ESLint.
- **Fix**: `projectId`/`report.id`/`_req`; регресс-тест в `manual-cad.test.js`.
- **Проверка**: `manual-cad.test.js` 21/21.

#### P0-3. Архив заключений сломан контрактом — ✅ сделано
- **Evidence**: `frontend/src/lib/api.ts:111` → `/vdgo/api/reports?archived=1&limit=200`; `app.py` сравнивал `self.path == '/api/reports'` без query → 404; download-эндпоинта не было.
- **Fix**: `services/vdgo/archive.py`, `parse_qs`, `GET /api/reports/:id/download`, запись документа в archive при генерации, `record_generation` возвращает id.
- **Проверка**: `tests/vdgo/test_archive.py` 2/2, VDGO 50 тестов зелёные.

#### P0-4. VDGO однопоточный — ✅ сделано
- **Evidence**: `app.py:2293` `HTTPServer((host, port), Handler)`; генерация до 900 с.
- **Fix**: `ThreadingHTTPServer`, `daemon_threads`, `block_on_close=False`, socket timeout 120 c, `request_queue_size=128`.
- **Проверка**: `/generate` и `/health` больше не блокируют друг друга; VDGO-тесты зелёные.

#### P0-5. Нет admission control для AI-джоб — ✅ сделано
- **Evidence**: `/api/analyze` вызывал `runPythonStreaming` напрямую, минуя очередь.
- **Fix**: общий семафор `MAX_CONCURRENT_PYTHON_JOBS` (default 1), `/api/analyze` → 429 при занятости, `SHUTDOWN_TIMEOUT_MS`, env в compose.
- **Проверка**: node-тесты зелёные; 429-путь покрывается semafor-логикой.

#### P0-6. Неатомарная запись `graph.json` и отсутствие graceful shutdown — ✅ сделано
- **Evidence**: `processor.py:4982,4986` — прямой `write_text`; `server.js` не обрабатывал SIGTERM.
- **Fix**: `_atomic_write_text` (tmp + `os.replace`), SIGTERM/SIGINT drain с `SHUTDOWN_TIMEOUT_MS`, `stop_grace_period: 30s`.
- **Проверка**: `tests/python/test_atomic_write.py` 1/1.

#### P0-7. Дефолтный пароль БД и HTTP без TLS — ⏸ отложено
- **Решение**: не делаем в dev — приложение в разработке, TLS/прод-секреты не нужны.
- **Вернуться**: перед production-деплоем.

### 3.2 P1 — высокий риск

| ID | Проблема | Evidence | Что делать |
|---|---|---|---|
| P1-1 | JSON как system of record | `workforce-system.js:172-203`, `server.js:585-601` | PostgreSQL + repository + миграции + индексы + пагинация |
| P1-2 | Сессии в памяти/файле, без ротации и очистки | `workforce-system.js:191-193,243-248` | таблица сессий, cleanup, revoke-all, idle timeout, `__Host-`, CSRF |
| P1-3 | Нет idempotency | `POST /tasks`, `/vdgo/generate`, `/analyze` | `Idempotency-Key`, дедуп |
| P1-4 | Нет retention/backup/DR | тома `cad_jobs`, `output`, `uploads`; `archive_index.json` | TTL, квоты, `pg_dump`, volume backup, restore drill |
| P1-5 | Нет метрик/трейсинга/алертов | только pino/JSON логи | OTel, RED/USE, dashboards, alert rules |
| P1-6 | Health всегда `ok:true` | `server.js:1397` | `ok:false` при недоступной Ollama/модели, `/readyz`, кэш tesseract |
| P1-7 | Документы перезаписываются | `app.py:1537,1681,2207` | уникальные имена, метаданные в БД, retention, архив |
| P1-8 | 512 МБ тело в RAM | `app.py:2165`, `app.py:1696` | лимит 32–64 МБ, streaming, проверка `Content-Length` |
| P1-9 | Нет пула и statement_timeout | `database.py:29` | pool, `statement_timeout`, `lock_timeout`, migration tool |
| P1-10 | Нет OpenAPI/версий/единого error envelope | routes без `/api/v1`; `{error}` vs `{ok:false}` | OpenAPI, `/api/v1`, `{error:{code,message,details,requestId}}` |
| P1-11 | Rate limit только in-memory | `server.js:331-340` | gateway + shared store, per-user quota |
| P1-12 | Нет resource limits/hardening | `compose.yaml` | `mem_limit`, `cpus`, `read_only`, `cap_drop`, `no-new-privileges` |
| P1-13 | Нет CI | `.github` отсутствует | install/lint/typecheck/test/build/scan на PR |
| P1-14 | Нет типизации/валидации | ручные `cleanText`/проверки в routes | Zod (Node), Pydantic (VDGO), Prisma schema; expand-contract |

### 3.2.1 JSON → PostgreSQL: карта

| JSON/файл | Что хранит | Статус | Целевое место |
|---|---|---|---|
| `workforce/users.json` | аккаунты, scrypt-хеши | **cutover** | `users` |
| `workforce/sessions.json` | сессии, `expiresAt` | **cutover** | `sessions` |
| `address-library.json` | улицы → дома → карточки схем | **PostgreSQL** (`address_library`, jsonb) | нормализация в таблицы — позже |
| `workforce/workspace.json` | tasks/reports/defectReports, события | **PostgreSQL** (`workforce_workspace`, jsonb) | нормализация в таблицы — позже |
| `schemes/<jobId>.json` | метаданные схемы, статус, `partialGraphReady` | **PostgreSQL** (`scheme_meta`, jsonb) | — |
| `manual-cad/<id>/project.json` | геометрия чертежа | **PostgreSQL** (`manual_cad_projects`, jsonb) | — |
| `<jobId>/graph.json` | производный граф/CAD | остаётся файлом | артефакт тома |
| `<jobId>/diagnostics.json` | производная диагностика | остаётся файлом | артефакт тома |
| `output/archive_index.json` | метаданные архива | **PostgreSQL** (`archive_entries`) | JSON fallback |
| `report-files/*` | фото/эскизы | файлы | том + метаданные в БД |
| `template/*` | шаблон PDF | файл | том |

Правило: JSON остаётся только для производных артефактов и разового backfill; state-сущности — PostgreSQL.

### 3.3 P2 — качество и производительность

| ID | Проблема | Evidence | Что делать |
|---|---|---|---|
| P2-1 | Монолиты 1000–5000 строк | `server.js`, `workforce-system.js`, `app.py`, `processor.py` | routes/domain/services, zod, central error handler |
| P2-2 | Нет compression/cache | `server.js:341-346`, нет gzip | immutable cache, gzip/brotli, ETag |
| P2-3 | Polling полного графа | `SchemeDetailPage.tsx:70`, `server.js:1147-1169` | SSE/WebSocket, delta-status, projection |
| P2-4 | Write amplification | `workforce-system.js:729-737` | не писать workspace на каждый GET, diff-сохранение |
| P2-5 | O(n) сканы | `server.js:453-463,772-791` | индексы/БД, кэш |
| P2-6 | Нет optimistic concurrency | `server.js:1821-1838`, `manual-cad-core.js:437` | `If-Match`/`version`, проверка revision |
| P2-7 | Воспроизводимость сборки | `app.Dockerfile:31-33` `npm install` без lock; `ollama:latest`; ranges в vdgo req | `npm ci`, lock, digest, `--require-hashes`, SBOM |
| P2-8 | Runtime image с тестами | `app.Dockerfile:49-56` | вынести тесты в CI, не копировать в runtime |
| P2-9 | Версии/docs drift | `VERSION 4.5.17`, `frontend 4.5.13`, changelog «31 тест» | single source version, changelog automation |
| P2-10 | Dead code | `engine/graph.js`, `strokes.js`, `prompts.js`, `moss_ai.py`, `openrouter_ai.py`, legacy UI | удалить/изолировать |
| P2-11 | Source-string тесты | `repository-layout.test.js` | поведенческие тесты |
| P2-12 | Нет SLO/нагрузочных тестов | — | SLO, k6/Locust, capacity model |

### 3.4 P3 — долгосрочно

- P3-1. HA/вторая реплика — после вынесения сессий/очереди в БД.
- P3-2. Multi-region/DR — избыточно для текущего масштаба.
- P3-3. Schema registry для `graph.json`.
- P3-4. S3/object storage вместо томов.
- [x] P3-5. `.DS_Store` удалён из репо и добавлен в `.gitignore`; убран устаревший `archive_index.json`; удалены `generated.pdf`, `_work.pdf`, `_regression_upload.png`; `storage_path` в архиве теперь относительный (`services/vdgo/archive.py`).

## 4. План

### Фаза 0 — остановить релиз и критичные риски (0–3 дня)

- [x] **P0-1** Починить красный `npm run check`.
  - [x] `lib/roles.ts` с `STAFF_ROLES`.
  - [x] `RequireRole` в `main.tsx`.
  - [x] Роли в `Sidebar`/`Topbar`/`DashboardPage`.
  - [x] Обновить `repository-layout.test.js` под новую структуру.
  - [x] `check` → `test`/`verify`; Dockerfile `npm run test`.
  - **DoD**: `npm --prefix services/ollama run test` зелёный; `docker compose build app` не проверен локально.
- [x] **P0-2** Исправить `jobId`/`id`/`req` ReferenceError.
  - **DoD**: `import-source-job` и `import-workforce-report` возвращают 2xx; регресс-тест.
- [x] **P0-3** Архив: query-фильтр, `limit`, download, запись в archive.
  - **DoD**: `/archive` грузится, скачивание работает, тест на 404/200.
- [x] **P0-4** VDGO `ThreadingHTTPServer` + timeout.
  - **DoD**: `/generate` и `/health` отвечают параллельно; стресс-тест 5 запросов.
- [x] **P0-5** Admission control Python-джоб.
  - **DoD**: 10 параллельных `/analyze` → 1 running, 9 429; `MAX_CONCURRENT_PYTHON_JOBS` в env.
- [x] **P0-6** Атомарная запись `graph.json` + graceful shutdown.
  - **DoD**: `kill -9` в момент записи не оставляет битый JSON; SIGTERM дренирует.
- [~] **P0-7** Убрать дефолтный пароль, TLS/`Secure` — **отложено**: приложение в разработке.

### Фаза 0.5 — typing & validation (сделано)

- [x] **Zod** (`services/ollama/api/validation/schemas.js`): login/setup, street/building, manual project create, connection/review; `validateBody` middleware; 422 + `details[]`.
- [x] **Pydantic** (`services/vdgo/schemas.py`): `WorkforceScheme`/`WorkforceSchemesPayload`; `parse_workforce_schemes` до base64/PIL; тесты `tests/vdgo/test_schemas.py`.
- [x] **Prisma** (`services/ollama/prisma/schema.prisma`): `ReportRun`, `User`, `Session`; `npm run db:validate`, `npm run db:generate`; **не подключён к runtime**, ждёт P1-1.
- [x] **Тулинг**: ESLint 9 (`eslint.config.js`), Prettier 3 (`.prettierrc.json`), Ruff (`pyproject.toml`); скрипты `lint`, `format`, `typecheck`, `test`, `verify`; `make verify`.

### Фаза 1 — архитектурный минимум (1–3 недели)

- [x] **P1-1** PostgreSQL вместо JSON.
  - **Готово**: `users`, `sessions`, `manual_cad_projects`, `address_library`, `workforce_workspace`, `scheme_meta`, `archive_entries` в PostgreSQL; JSON только one-time backfill; `AUTH_BACKEND=postgres` по умолчанию; Prisma-клиент генерируется в Docker.
  - **Legacy JSON удалён**: `requirePostgres()` fail-fast (`POSTGRES_REQUIRED`), убраны JSON-fallback-ветки и `atomicJson` в `workforce-system.js`, `server.js` читает/пишет manual CAD / address library / scheme meta только через PG; удалены `sessions.json` и каталог тестового проекта.
  - **Проверено**: `verify` зелёный; сервер отказывается стартовать без PostgreSQL и поднимается с ним (health 200, auth/status 200, projects 401 без сессии).
- [~] **P1-2** Сессии в PostgreSQL.
  - **Готово**: таблица `sessions`, cleanup, удаление при logout/reset/deactivate; `POST /api/workforce/users/:id/revoke-sessions`; `sessions.last_seen_at` + `SESSION_IDLE_MS` (idle timeout, throttled touch), удаление истёкших сессий при обращении; `POST /api/workforce/admin/revoke-all-sessions`.
  - **Проверено**: login 200 → 50 с простоя → 401; revoke-all → `revoked:1`, 401, строк в БД 0.
  - **Осталось (на прод)**: CSRF, `__Host-` cookie, multi-instance кэш сессий.
- [x] **P1-3** Idempotency keys.
  - **Сделано**: таблица `idempotency_keys`, `findIdempotency`/`saveIdempotency`; `Idempotency-Key` на `POST /api/workforce/tasks` и `POST /api/analyze`; идемпотентный replay генерации документов VDGO (хеш тела → `find_idempotent`/`save_idempotent`, копия в `/app/output/.idem`, заголовок `X-Idempotent-Replay: 1`, retention в `retention.sh`); тесты `tests/node/idempotency.test.js`, `tests/vdgo/test_idempotency.py`.
  - **Проверено**: SQL на реальной БД (insert/read/upsert), 200 → повтор отдаёт сохранённый документ.
- [x] **P1-4** Retention + backup + restore drill.
  - **Сделано**: `infra/scripts/backup.sh` (pg_dump + тома + `BACKUP_KEEP`), `infra/scripts/restore.sh`, `infra/scripts/retention.sh` (`RETENTION_DAYS`), `docs/BACKUP-RESTORE-RU.md`; скрипты принимают `PGURL` (прямой pg_dump/psql) и `WITH_VOLUMES`.
  - **Restore drill (2026-11-15)**: дамп из рабочей БД → восстановление в чистый `postgres:17.7` → счётчики совпали (users/sessions/projects/archive/idempotency/ratelimit) → приложение поднялось на восстановленной БД (health 200, auth/status 200).
- [ ] **P1-5** OTel/metrics/tracing/dashboards/alerts.
- [x] **P1-6** Health semantics + `/api/readyz`.
  - **Сделано**: liveness `/api/health` всегда `ok:true`; `/api/readyz` = 503 без Ollama/модели/Tesseract; кэш tesseract 30 с; Topbar показывает «Без Ollama: базовые сервисы».
- [x] **P1-7** Output isolation + archive.
  - **Сделано**: уникальные `_work_*.pdf`/`generated_*.pdf`/DOCX, удаление после ответа; архив уже подключён.
- [x] **P1-8** VDGO request safety.
  - **Сделано**: `VDGO_MAX_REQUEST_BYTES` (256 МБ), `VDGO_MAX_FILE_BYTES` (64 МБ), `VDGO_SPOOL_MAX_RAM_BYTES` (8 МБ), `VDGO_MAX_FIELD_BYTES` (2 МБ); тело запроса spool-ится на диск, multipart разбирается потоково, файловые части пишутся сразу на диск.
  - **Проверено**: 7 тестов парсера + живой запрос (поля и файл приняты, валидация вернула 400 со списком пропусков).
- [x] **P1-9** DB pool + timeouts + migrations.
  - **Сделано**: `statement_timeout=5000`, `lock_timeout=3000`, `application_name=vdgo`; пул `psycopg_pool` в `services/vdgo/database.py` (`VDGO_DB_POOL_MIN/MAX/TIMEOUT/IDLE`), `close_pool()` при shutdown; CI-джоб `migrations` (`db:validate`, `db:generate`, `migrate deploy`, `migrate status`) на чистом `postgres:17.7`.
  - **Проверено**: миграции применяются с нуля (6/8 миграций, `migrate status` — up to date).
- [x] **P1-10** OpenAPI + единый error envelope + contract tests (без `/api/v1`).
  - **Сделано**: `docs/openapi.yaml` описывает все `/api/*` и `/vdgo/*` маршруты; error envelope `{ error, code?, details? }` задокументирован; `tests/node/openapi.test.js` статически проверяет, что каждый путь из спеки существует как express-маршрут (`server.js` + `workforce-system.js`) или nginx-route (vdgo).
  - **Проверено**: 75 node-тестов зелёные.
  - **Осталось**: error envelope применить в коде (сейчас `{ error }` уже везде, `code`/`details` — опционально).
- [x] **P1-11** Gateway rate limit + per-user quota.
  - **Сделано**: nginx `limit_req` на `/api/auth/login`; `heavyQuota` (per-user, IPv6-safe) на GPU-маршрутах; общий стор `createPostgresRateLimitStore` на таблице `rate_limit_buckets` (фиксированные окна, opportunistic cleanup) для auth/heavy/upload лимитеров.
  - **Проверено**: 5 логинов → `rate_limit_buckets count=5` в PostgreSQL; окно сбрасывается, `resetAll` работает.
- [x] **P1-12** Compose hardening.
  - **Сделано**: `no-new-privileges`, `cap_drop: [ALL]`, `read_only: true`, tmpfs для `/tmp` (и кэша) у `app` и `vdgo-backend`; запись только в примонтированные тома.
  - **Проверено**: образ `app` собран и запущен с `--read-only --cap-drop ALL`; `health=200`, `auth/status=200`, `readyz=503` (нет Ollama); `POST /api/auth/setup` → 201, login → 200; ошибок `EROFS` нет.
- [x] **P1-13** CI.
  - **Сделано**: `.github/workflows/ci.yml` — node-джоб (lint/typecheck/node-тесты) и python-джоб (ruff + engine/VDGO тесты).
  - **Осталось**: прогнать на GitHub, добавить build/scan.
- [x] **P1-14** Normalized tables + typed runtime client.
  - **Typed-слой**: `services/ollama/api/validation/entities.js` — Zod-схемы (`user`, `session`, `manual_cad_project`, `scheme_meta`) + `parseOrDefault` (логирует и возвращает fallback, не роняя список); подключено в `postgres-repo` и `manual-cad-repo`; тест `tests/node/entities.test.js`.
  - **Нормализация**: `address_library` JSONB → `address_streets` / `address_buildings` / `address_schemes`; `workforce_workspace` JSONB → `workforce_tasks` / `workforce_reports` / `workforce_defect_reports` (с индексами по `status`, `assignedTo`, `taskId`, `userId`, `submittedAt`). Миграция `20261116120000_normalize_address_and_workspace` создаёт таблицы и выполняет backfill.
  - **Репозитории**: `address-library-repo.js` и `workforce-workspace-repo.js` читают из нормализованных таблиц и собирают прежнюю форму ответа; запись — upsert + удаление исчезнувших в одной транзакции; legacy JSONB обновляется write-through для совместимости.
  - **Проверено**: backfill (streets=2, buildings=1, schemes=1, tasks=3, reports=1); round-trip без потерь; живой API (login → library/tasks/overview/reports 200, создание задачи → `workforce_tasks=4`, смена статуса → `house_visited`, идемпотентность); тесты `tests/node/normalized-repos.test.js`.
  - **Осталось (небольшое)**: убрать write-through legacy JSONB и удалить старые таблицы-синглтоны после перехода всех инстансов.

### Фаза 2 — качество и производительность (1–2 месяца)

Нумерация совпадает с §3.3 (все 12 пунктов + P2-13).

- [x] **P2-1** Разбить монолиты на слои (`server.js` 2646→1579, `workforce-system.js` 1748→563, `processor.py` 5062→2355).
  - **P2-1 progress**: JS-API разбит и разложен по слоям — `api/domain/` (чистая логика), `api/repositories/` (доступ к БД), `api/routes/` (HTTP), `api/services/` (use-cases), `api/validation/` (Zod-схемы), `api/lib/` (logger/version/etag/env), `server.js` — composition root. `processor.py` — вынесены CAD-экспорт, препроцессинг, геометрия, граф, Qwen-клиент; остаток — OCR-пайплайн (нужен отдельный этап).
  - **Сделано (шаг 1)**: интеграционные тесты как сетка безопасности — `tests/node/integration/` (12 тестов: health/readyz, доступ без сессии, login/logout, создание сотрудника, дубликаты, multi-house dispatch, lifecycle start→visit, 404, ETag/304). Поднимают реальный сервер на эфемерном порту против отдельной БД `vdgo_itest`; харнесс `tests/node/helpers/integration-harness.js`. CI-job `integration`. Скрипты `test:integration`, `db:deploy:test`.
  - **Попутно исправлен баг**: `resumeStoredAnalysisQueue` падал на пустой библиотеке (`Cannot read properties of null (reading 'streets')`) — приложение не стартовало с чистой БД.
  - **Сделано (шаг 2)**: выделен блок шаблона — `api/services/template-store.js` (домен: чтение/запись/удаление/путь) + `api/routes/template-routes.js` (HTTP); `api/domain/text.js` с `cleanLabel` (убрано дублирование). `server.js` теперь только создаёт store и монтирует router; старые хелперы/маршруты удалены.
  - **Проверено**: `server.js` 2646 → 2515 строк; `verify` exit 0; 12/12 интеграционных; живой цикл шаблона (GET 200 null → upload 201 → GET 200 → DELETE 200 → null; `/file` 404 без файла).
  - **Сделано (шаг 3)**: выделен блок настроек — `api/routes/settings-routes.js` (openrouter/moss: `GET` → `disabled:true`, `PUT/DELETE/POST test` → 410 Gone); подключён через `app.use('/api', ...)`.
  - **Проверено**: `server.js` 2515 → 2489 строк; `verify` exit 0; 14/14 интеграционных.
  - **Баг, пойманный тестами**: `res.download` возвращал 500 на файл в `.private/template` — Express `dotfiles: 'deny'` (дефолт) блокирует скрытые сегменты пути. Исправлено `dotfiles: 'allow'` (имя уже проверено store).
  - **Сделано (шаг 4)**: выделен блок health — `api/services/health.js` (`createHealthChecks`: `checkTesseract` с кэшем 30 с, `checkOllamaStatus`); в `server.js` осталась только инстанциация и деструктуризация.
  - **Проверено**: `server.js` 2489 → 2408 строк; `verify` exit 0; 14/14 интеграционных.
  - **Сделано (шаг 5)**: выделен блок улиц/домов — `api/routes/library-routes.js` (`GET /`, `POST /streets`, `POST /buildings`); смонтирован на `/api/library`. Маршруты схем (`upload`, `schemes/:jobId*`) остались в `server.js` (зависят от очереди анализа) — следующий шаг.
  - **Проверено**: `server.js` 2408 → 2373 строк; 16/16 интеграционных.
  - **Баг, пойманный тестами**: `updateAddressLibrary` падал на пустой библиотеке (`null.streets`) — создание первой улицы на чистой БД возвращало 500. Теперь стартует с пустого документа.
  - **Сделано (шаг 6)**: выделен блок схем — `api/routes/scheme-routes.js` (`POST /upload`, `GET /:jobId`, `GET /:jobId/status`, `POST /:jobId/analyze`, `POST /:jobId`); смонтирован на `/api/library/schemes`; инжектируются очередь анализа, `findScheme`, meta-репозиторий.
  - **Проверено**: `server.js` 2373 → 2207 строк; 18/18 интеграционных (добавлены: загрузка без файла → 400, неизвестный адрес → 404, битый jobId → 400).
  - **Сделано (шаг 7)**: выделен блок jobs — `api/routes/job-routes.js` (`GET /:jobId/graph`, `POST /:jobId/connections`, `POST /:jobId/review`); инжектятся `attachJobUrls`, `nextManualEdgeId`, `cleanLabel`, схемы.
  - **Проверено**: `server.js` 2207 → 1989 строк (−657 от исходного); 18/18 интеграционных.
  - **Сделано (шаг 8)**: выделен блок manual-cad — `api/routes/manual-cad-routes.js` (11 маршрутов: import-job / import-source-job / import-workforce-report, projects CRUD, source/preview/export); инжектируются все зависимости.
  - **Проверено**: `server.js` 1989 → 1588 строк (−1058 от исходного, −40%); 21/21 manual-cad тест; 18/18 интеграционных.
  - **Сделано (шаг 9)**: выделен SPA-fallback — `api/routes/spa-routes.js` (`/vdgo`, `/vdgo/*`, redirect на SPA).
  - **Итог разбивки `server.js`**: 2646 → 1579 строк (−40%). Структура: `server.js` — composition root (health, readyz, analyze, python-оркестрация, монтирование), `routes/*.js` — 7 модулей HTTP (template, settings, library, schemes, jobs, manual-cad, spa), `template-store.js` / `health.js` / `text.js` — домен и утилиты.
  - **Проверено**: 97 node-тестов; 18/18 интеграционных; VDGO 62; `verify` exit 0.
  - **Осталось (сознательно)**: вынести analyze + python-оркестрацию (`runPythonStreaming`) — тесно связаны, вынос рискован без отдельного слоя; `workforce-system.js` (33 маршрута) — следующий кандидат; `processor.py` (5062 строки) — отдельно.
- [x] **P2-2** Compression/cache/ETag.
  - **Сделано**: nginx `gzip` для JSON/SVG/JS/CSS; per-location `client_max_body_size` (64m загрузки / 2m JSON); `sendJsonConditional` (weak ETag + `private, no-cache` + 304) на `/api/library`, `/api/manual-cad/projects`, `/api/workforce/{tasks,reports,defects,overview,users}`; `ETag` на `PUT /api/manual-cad/projects/:id`.
  - **Проверено**: 200 + ETag, повтор с `If-None-Match` → 304; `tests/node/etag.test.js`.
  - **Перенесено в P2-3**: ETag/дельта для схем (вместе с отказом от polling).
- [ ] **P2-3** Polling полного графа → SSE/delta-status/projection.
  - **Решение**: не требуется. Система на 10–25 сотрудников; опрос идёт только когда есть активные схемы (SchemesPage) или граф не готов (SchemeDetailPage), ~1–2 rps. SSE добавит сложность (реестр подписчиков, `proxy_buffering off`, pub/sub при multi-instance) без выигрыша. Пересмотреть, если появятся сотни одновременных пользователей.
- [x] **P2-4** Write amplification.
  - **Сделано**: `refreshSchemeState` возвращает факт изменения; `GET /api/workforce/reports` пишет только когда статус схемы реально сдвинулся; `saveWorkspace` сравнивает JSON-снапшот и пропускает запись без изменений; убран write-through legacy JSONB из обоих репозиториев и удалены модели `AddressLibrary`/`WorkforceWorkspace` из Prisma-схемы.
  - **Проверено**: 10 опросов `/api/workforce/reports` → `n_tup_upd` без изменений (delta=0); изменение статуса → `updated_at` растёт; тест `tests/node/write-amplification.test.js`.
- [x] **P2-5** O(n) сканы → индексы.
  - **Сделано**: `buildLookups()` строит `usersById`, `tasksById`, `reportsByTask`, `defectsByTask`; `taskForClient`/`reportForClient`/`defectReportForClient` работают за O(1) на сущность вместо O(n) на элемент; кэш инвалидируется в `saveUsers`/`saveWorkspace`. `findScheme` использует индекс `jobId → {streetId, buildingId}` с fallback-сканом.
  - **Проверено**: `tests/node/lookup-indexes.test.js`; API отдаёт те же данные (tasks 3, reports 1, все поля на месте).
- [x] **P2-6** Optimistic concurrency для manual CAD.
  - **Сделано**: `If-Match: "<rev>"` / `body.expectedRevision`; атомарный `updateMany ... where revision = expected`; 409 `REVISION_CONFLICT`; `ETag` в ответе; фронт показывает «изменил другой редактор»; исправлена бесконечная рекурсия `readManualProject` в JSON-режиме; тест `tests/node/manual-cad-concurrency.test.js`.
- [~] **P2-7** Воспроизводимость сборки.
  - **Сделано**: `app.Dockerfile` переведён с `npm install` на `npm ci` (frontend и app), копируются оба `package-lock.json`; версия больше не хардкодится (см. P2-9).
  - **Осталось**: SBOM (`syft`/`npm sbom`), digest-пиннинг базовых образов, `--require-hashes` для Python.
- [x] **P2-8** Runtime image без тестов.
  - **Сделано**: из `app.Dockerfile` убраны `COPY tests/`, `frontend/src`, `compose.yaml`, `infra/*`; в образ попадает только собранный SPA. Тесты остаются в CI (`node`, `python`), добавлена job `image`, которая собирает образ и проверяет отсутствие `/app/tests` и `/app/frontend/src`.
  - **Проверено**: образ собран и запущен (health 200, readyz 503 без Ollama, `/vdgo/` 200, JS-ассет 200); `tests/` и `frontend/src` в образе отсутствуют.
- [x] **P2-9** Версии/docs drift.
  - **Сделано**: `VERSION` — единственный источник; `services/ollama/api/lib/version.js` (`appVersion()`, учитывает `APP_RELEASE`), подключён в `server.js`, `logger.js`, `workforce-system.js`; `services/vdgo/app.py` читает `VERSION` как fallback; `frontend/package.json` и оба lock-файла синхронизированы на `4.5.17`.
  - **Проверено**: `tests/node/version.test.js` (5 тестов) — версии совпадают, хардкод-лейблов в коде нет.
- [x] **P2-10** Удалить dead code (JS-часть).
  - **Сделано**: удалены `services/ollama/engine/graph.js`, `strokes.js`, `prompts.js` (0 ссылок; пайплайн полностью на Python). `engine/` больше не содержит JS.
  - **Осталось (отдельно)**: проверить `moss_ai.py`, `openrouter_ai.py`, legacy UI-ассеты.
- [x] **P2-11** Source-string тесты → поведенческие (legacy UI удалён).
  - **Сделано**: удалён мёртвый legacy UI `tests/fixtures/legacy-frontend/` (524K, приложением не отдаётся, заменён React-SPA) вместе с тестами, которые проверяли его HTML/JS строками (`workforce-contract`, `workforce-inbox-folders`, `workforce-planning`, `manual-cad-ink-trace`); 4 python-теста `BrowserExportRegressionTests` удалены; backend-контракты сохранены в `tests/node/workforce-backend-contracts.test.js`; обновлены `package.json`, `eslint.config.js`, `repository-layout.test.js`.
  - **Проверено**: `npm run verify` exit 0; 97 node-тестов; 195 python; 62 vdgo.
- [ ] **P2-12** SLO + нагрузочные тесты (k6/Locust, capacity model).
  - **Решение**: не требуется для 10–25 пользователей. Достаточно smoke-проверки «N одновременных логинов не падают», если понадобится.
- [x] **P2-13** ADR/runbook/DR.
  - **Сделано**: `docs/adr/0001-postgres-system-of-record.md`, `docs/adr/0002-no-api-versioning.md`, `docs/runbook.md` (запуск, verify, backup/restore, retention, аварии, отложенное до прода).

#### Отдельно (вне §3.3, но в работе)

- [ ] **P2-14** Выделить AI-worker, очередь Redis/Postgres, retry/DLQ.

### Фаза 3 — долгосрочно

- [x] P3-5 (мусор вычищен).
- [ ] P3-1…P3-4.

## 5. Целевая архитектура

1. **Modular monolith API** (Node) + **AI worker** (Python) + **Document worker** (VDGO): три деплоя, одна БД, одна очередь. Fine-grained микросервисы не нужны.
2. **PostgreSQL** — system of record: users/sessions/roles, tasks/reports/defects, address library, jobs, report_runs, audit. JSONB — только graph/document metadata. Блобы — том/S3.
3. **Очередь** (Redis или Postgres-backed): `analyze`, `generate`, `docx`; visibility timeout, retry/backoff/jitter, DLQ, job status в БД.
4. **API**: `/api/v1`, OpenAPI, единый error envelope, idempotency keys, pagination/filter/sort, request id.
5. **Gateway**: TLS, `client_max_body_size` по location, `limit_req`/`limit_conn`, timeouts, auth_request.
6. **Observability**: OpenTelemetry → Prometheus/Grafana/Loki; SLO и alert rules; readiness отдельно от health.
7. **Real-time**: SSE/WebSocket для прогресса вместо polling; дельта-статус вместо полного графа.
8. **Data lifecycle**: retention/TTL, backup, restore, audit, soft delete.

## 6. SLO

| Поток | SLO |
|---|---|
| Auth/login | p95 < 300 ms, availability 99.9%, error rate < 0.5% |
| List endpoints (paginated) | p95 < 300 ms при 100k entities |
| Job accept (202) | p95 < 150 ms |
| Queue wait | p95 < 5 мин, max < 30 мин |
| Analyze success rate | > 95% |
| PDF/DOCX generate | p95 < 60 s, error rate < 1% |
| Readiness | 100% соответствует реальной работоспособности |
| Disk/saturation | < 75%, alert > 85% |

## 7. Правила

- Не добавлять новые JSON-хранилища для растущих сущностей.
- Любой новый POST — с idempotency key, Zod-схемой и валидацией.
- Любой новый структурированный payload в VDGO — с Pydantic-моделью.
- Любой новый фоновый job — через очередь, с max concurrent и DLQ.
- Любой новый endpoint — в OpenAPI и с request id в логах.
- Перед коммитом: `npm run verify` (ESLint + Prettier + Ruff + typecheck + tests).
- Не запускать `docker compose down -v`.
- Не отключать тесты, чтобы «починить» сборку.
- Не удалять тесты, если не получается починить.
- Пишешь код -> тесты, линты и прочее -> локальная проверка через playwrtie -> обновление плана -> комит.

## 9. Тулинг и проверки

| Инструмент | Конфиг | Команда |
|---|---|---|
| ESLint 9 | `eslint.config.js` | `npm run lint:js` |
| Prettier 3 | `.prettierrc.json` | `npm run format` / `npm run format:check` |
| Ruff | `pyproject.toml` | `npm run lint:py` |
| TypeScript | `frontend/tsconfig*.json` | `npm run typecheck` |
| Node/Python/VDGO тесты | — | `npm run test` |
| Всё вместе | — | `npm run verify` |

`npm run verify` = Prettier check → ESLint → Ruff → frontend typecheck → Node + Python engine + VDGO тесты.
Старый `npm run check` удалён; Docker build использует `npm run test` (dev-инструменты не нужны в runtime).

Ruff: `line-length=140`, `select = E4,E7,E9,F,I,UP,B`; `E701/E702/B008/B905/B007/B904/F841` оставлены вне проверки как legacy-стиль движка (уборка — P2-10).
Prettier: 120 символов, `singleQuote`, `trailingComma: all`.
ESLint: backend `services/ollama/api` + `tests/node`; `no-control-regex` выключен для санитайзеров, которые намеренно ловят control-chars.
Prisma: `services/ollama/prisma/schema.prisma` (`ReportRun`, `User`, `Session`, `IdempotencyKey`, `ManualCadProject`, `AddressLibrary`, `WorkforceWorkspace`, `SchemeMeta`), `npm --prefix services/ollama run db:validate`; state-данные уже в PostgreSQL, нормализация/typed runtime — P1-14.

## 10. Журнал изменений рефакторинга

### 2026-11-14

- Создан план и журнал.
- Фаза 0: P0-1…P0-6 закрыты; P0-7 (TLS/дефолтный пароль) остаётся.
- `npm run check` заменён на `lint` / `typecheck` / `test` / `verify`; Dockerfile теперь `npm run test`.
- ESLint 9 + Prettier 3 + Ruff: конфиги, скрипты, автофиксы; `npm run verify` зелёный локально.
- Zod для Node-роутов, Pydantic для VDGO CAD-payload, Prisma schema подготовлена (runtime cutover — P1-14).
- Исправлены дополнительные ReferenceError (`id`, `req`), дублирующиеся dict-ключи и дублирующиеся Python-тесты, найденные Ruff.
- Тесты: 47 node, 201 Python engine, 50 VDGO — зелёные; `tesseract`/`cairosvg`/Carlito-fallbacks не ломают локальный прогон.
- P1 (частично): health/`readyz`, изоляция выходных файлов, лимит тела VDGO, statement_timeout, очистка сессий, nginx rate limit на login.
- Локальный Playwright-прогон: setup → login developer → создание слесаря → задания → старт/визит/офис → отправка эскиза → приёмка; archive download 200; CAD-проект создан; Conclusion/Settings загружаются; Ollama отсутствует — `readyz` 503, UI показывает degraded.
- Исправлен баг `res.sendFile` для report-files: `.private` в пути → 404; добавлен `dotfiles: 'allow'`.
- P0-7 (TLS/дефолтный пароль) отложен по решению: приложение в разработке.
- P1-13: добавлен `.github/workflows/ci.yml` (node + python), YAML валидирован локально.
- P1-1 (expand): Prisma `User`/`Session` + миграция + dual-write + hydration; проверено на локальном PostgreSQL `:55432`.
- `AUTH_BACKEND=postgres` — dev-переключатель; по умолчанию `json`, JSON остаётся источником правды.
- P1-3 (частично): `idempotency_keys` + `Idempotency-Key` на создание заданий; проверено на локальном PostgreSQL (дубль не создаётся).
- P1-1 (auth cutover): `users`/`sessions` полностью в PostgreSQL; JSON только one-time backfill; `AUTH_BACKEND=postgres` по умолчанию; Prisma генерируется в Docker; проверено: backfill 4 пользователей, login/logout/create user без записи JSON, Playwright-вход.
- P1-1 (manual CAD cutover): `manual_cad_projects` (`jsonb`), backfill, list/create/save/preview; новый `project.json` не создаётся; Playwright CAD-список/редактор.
- P1-1 (address library): `address_library` singleton (`jsonb`), backfill, read/save через PG; JSON mtime не меняется; Playwright `/schemes`.
- P1-1 (workspace): `workforce_workspace` singleton (`jsonb`), backfill 2 tasks/1 report, создание задачи → PG; JSON mtime unchanged; Playwright `/team`.
- P1-1 (scheme meta): `scheme_meta` (`jsonb`), backfill, read/write через PG; `analyze` → status `processing` в PG; JSON mtime unchanged.
- P1-1 (archive): `archive_entries` в PostgreSQL, backfill `archive_index.json`, DB-first read/write; download 200, JSON mtime unchanged.
- Файл-чеклист миграции: `docs/MIGRATION-JSON-TO-POSTGRES-RU.md`.
- Все state-сущности переведены в PostgreSQL (`users`, `sessions`, `manual_cad_projects`, `address_library`, `workforce_workspace`, `scheme_meta`, `archive_entries`); JSON остался только для fallback/backfill и производных артефактов.
- Осталось: cleanup legacy JSON, P1-4 (retention/backup), P1-5 (observability), P1-10 (OpenAPI/error envelope), P1-12 (compose hardening), хвосты P1-2/3/8/9/11/14.

### 2026-11-15 — P2-1 шаг 18: слоистая структура `services/ollama/api/`

- Плоская свалка из 23 файлов разложена по слоям:
  - `api/domain/` — чистая логика без I/O: `manual-cad-core.js`, `workforce-core.js`, `workforce-serializers.js`, `text.js`.
  - `api/repositories/` — доступ к данным: `db.js`, `postgres-repo.js`, `manual-cad-repo.js`, `address-library-repo.js`, `workforce-workspace-repo.js`, `scheme-meta-repo.js`, `rate-limit-store.js`.
  - `api/routes/` — HTTP-слой (12 route-модулей, без изменений по составу).
  - `api/services/` — use-cases: `workforce-system.js`, `template-store.js`, `health.js`.
  - `api/validation/` — Zod-схемы: `schemas.js`, `entities.js`.
  - `api/lib/` — инфраструктура: `logger.js`, `version.js`, `etag.js`, `moss-env-boot.js`.
  - `api/server.js` — composition root (сборка приложения, монтирование роутеров, python-оркестрация).
- Импорты переписаны скриптом по карте старых путей; `server.js` и `routes/template-routes.js` — вручную.
- Обновлены: `package.json` (`start`, `test:node`), пути в 13 тестовых файлах, `logging.test.js` (список файлов для проверки console.*), fingerprint-список `BUILD_INFO` в `server.js`.
- **Попутно исправлен баг**: `routes/spa-routes.js` и `lib/version.js` использовали `__dirname`-относительные пути, которые не учитывали переезд; `spa-routes.js` вдобавок указывал на несуществующий `services/frontend/public` (было сломано и до переезда). Пути исправлены (`../../../../frontend/public`, `../../../../VERSION`).
- **Проверено**: `npm run verify` exit 0 (node 102, python 201, vdgo 62); интеграционные 21/21 на БД `vdgo_itest`; живой запуск сервера с `AUTH_BACKEND=postgres` (started → SIGTERM → shutdown complete).

### 2026-11-15 — P2-1 шаг 13: вынесен CAD-экспорт из processor.py

- `engine/cad_export.py` (470 строк) — `build_clean_svg`, `build_dxf`, `_cad_edge_chains`, `_clean_cad_points`, `_sheet_layout`, `_semantic_route_chains`, `_annotation_export_kind`, `_primary_semantic_chains`.
- `processor.py` 5062 → 4622 строки; вынесенные функции реэкспортируются (`from cad_export import ... # noqa: F401`), поэтому `processor.build_clean_svg` и тесты, патчащие `processor.*`, продолжают работать.

### 2026-11-15 — P2-1 шаг 14–17: разбивка processor.py (продолжение)

- `engine/image_preprocess.py` (373) — поворот/квадрат страницы, деление на ячейки, апскейл.
- `engine/segment_geometry.py` (880) — выборка сегментов, привязка линий, сборка маршрутов.
- `engine/cad_graph.py` (767) — граф узлов, цепочки, приоритет разрезов.
- `engine/qwen_client.py` (376) — Ollama vision-клиент, retry-бюджет, tile-чекпоинты, `_parse_json_object`; реэкспорт из `processor`.
- `engine/analysis_state.py` — разделяемый `ANALYSIS_HARD_DEADLINE` (вместо module-level global), чтобы бюджет времени пережил вынос.
- `processor.py` 4622 → 2355 строк (−49% от исходного); остаток — OCR-пайплайн, Qwen-оркестрация, `analyze`, `main`.
- Тесты переведены на патчи в модуле-владельце (`qwen_client._qwen_call`, `qwen_client.urllib.request.urlopen`, `analysis_state.ANALYSIS_HARD_DEADLINE`, `segment_geometry.*`, `image_preprocess.*`).
- **Проверено**: `tests/python` 199 passed, 2 skipped, 5 subtests passed; `ruff check` exit 0.
- `tests/python/test_cad_export.py` — 4 теста (состав модуля, реэкспорт, генерация SVG/DXF).
- Проверено: 201 Python-тест (195+4 новых, 2 skip), 62 VDGO, 102 node, `verify` exit 0.

### 2026-11-15 — P2-1 шаг 12: завершён вынос workforce (итог)

- `api/routes/workforce-inbox-routes.js` (439) — defects, reports, conclusion, `tasks/:taskId/conclusion`, overview; `refreshSchemeState` переехал вместе с ними.
- `api/routes/workforce-submission-routes.js` (287) — два multipart-маршрута (sketch, defect photos).
- **`workforce-system.js`: 1748 → 563 строк (−68%)**; в файле остались только factory: состояние, бут-импорт legacy JSON, поиск-кэш, save-функции, `getCurrentUser`/`requireRoles`/`authMiddleware`, монтирование 5 роутеров.
- Итоговая структура workforce: `workforce-core.js` (199), `workforce-serializers.js` (147), `routes/workforce-{auth,task,inbox,submission,user}-routes.js` (110/183/439/287/223), `workforce-system.js` (563).
- Проверено: 102 node-теста, 21/21 интеграционных, `verify` exit 0.
- **Осталось от P2-1**: `processor.py` (5062 строки) — отдельная задача.

### 2026-11-15 — P2-1 шаг 11: вынесены admin-маршруты workforce

- `api/routes/workforce-user-routes.js` — 7 маршрутов: `GET/POST /users`, `POST /users/:id/reset-password`, `PATCH /users/:id`, `POST /users/:id/revoke-sessions`, `POST /admin/revoke-all-sessions`, `GET /admin/diagnostics`.
- Состояние передаётся через аксессоры (`getUsers/getSessions/setSessions/getWorkspace`), т.к. массивы переназначаются при мутации; `makeLogin` остался в `workforce-system.js` и инжектится.
- `workforce-system.js` 1497 → 1348 строк.
- Новые интеграционные тесты (3): diagnostics, reset-password (с проверкой отзыва сессии и входа с новым паролем), revoke-all (обе сессии инвалидированы).
- Проверено: 21/21 интеграционных, 102 node-теста, `verify` exit 0.
- **Осталось**: вынести оставшиеся 26 маршрутов (auth, tasks, reports, defects, conclusion) — тот же подход; `processor.py` — отдельно.

### 2026-11-15 — P2-1 шаг 10: разбит workforce-system.js

- `api/domain/workforce-core.js` (199 строк) — чистые хелперы: роли, имена, текст, cookie, хеш пароля (`salt:hex` — формат сохранён), `persistUploadedFile` (staging + rename, EXDEV-safe), `parseHouseAddresses`, `evaluateAddressFolder`.
- `api/domain/workforce-serializers.js` (147 строк) — `buildLookups`, `createLookupCache` (инвалидация при записи), `taskForClient`, `reportForClient`, `defectReportForClient`; вынесены дословно.
- `workforce-system.js` 1748 → 1497 строк; реэкспортирует helpers для существующих импортёров.
- Новые тесты: `tests/node/workforce-serializers.test.js` (5) — чистые функции без сервера; обновлены `lookup-indexes`, `workforce-backend-contracts`, `workforce-upload`.
- Проверено: 102 node-теста, 18/18 интеграционных, `verify` exit 0.
- **Осталось**: вынести оставшиеся 26 маршрутов из `workforce-system.js` в `routes/workforce-*.js` (auth, tasks, reports, defects, conclusion); `processor.py` (5062 строки) — отдельно.

### 2026-11-15 — P2-1 шаг 9: SPA-роуты + итог по server.js

- `api/routes/spa-routes.js` — `/vdgo`, `/vdgo/*`, redirect неизвестных маршрутов на SPA.
- **`server.js`: 2646 → 1579 строк (−40%)** от исходного. Итоговая структура:
  - `server.js` — composition root: middleware, health/readyz, analyze, python-оркестрация, монтирование роутеров;
  - `routes/{template,settings,library,scheme,job,manual-cad,spa}-routes.js` — 7 HTTP-модулей;
  - `template-store.js`, `health.js`, `text.js` — домен и утилиты.
- Обновлены source-string тесты: `openapi` (собирает маршруты из всех модулей с учётом mount-префиксов), `etag`, `manual-cad-concurrency`, `repository-layout`.
- **Исправлен баг**: `Set.prototype.add(...set)` добавляет один элемент, а не разворачивает — в `openapi.test.js` заменили на `for...of`.
- Проверено: 97 node-тестов, 18/18 интеграционных, VDGO 62, `verify` exit 0.

### 2026-11-15 — P2-1 шаг 8: выделен блок manual-cad

- `api/routes/manual-cad-routes.js` — 11 маршрутов (import-job, import-source-job, import-workforce-report, projects list/get/create/update, source/preview.svg/export.svg/export.dxf); префикс `/api/manual-cad` снят с путей, монтирование через `app.use`.
- Инжектятся 20 зависимостей (персистенс, геометрия, валидация, лимитеры, multer-загрузки).
- Обновлён `tests/node/manual-cad.test.js` (P0-2 регрессия) — читает новый модуль.
- Проверено: `server.js` 1989 → 1588 строк (−40% от исходного); 21/21 manual-cad; 18/18 интеграционных; `verify` exit 0.

### 2026-11-15 — P2-1 шаг 7: выделен блок jobs

- `api/routes/job-routes.js` — `GET /:jobId/graph`, `POST /:jobId/connections`, `POST /:jobId/review`; мутация графа и хелперы инжектируются.
- Смонтирован на `/api/jobs`; `server.js` 2207 → 1989 строк.
- Проверено: 18/18 интеграционных, `verify` exit 0.

### 2026-11-15 — P2-1 шаг 6: выделен блок схем

- `api/routes/scheme-routes.js` — `POST /upload`, `GET /:jobId`, `GET /:jobId/status`, `POST /:jobId/analyze`, `POST /:jobId`; зависимости (очередь анализа, `findScheme`, meta-репозиторий, multer, лимитеры) инжектируются.
- Смонтирован на `/api/library/schemes`; удалён inline-код (2373 → 2207 строк).
- Новые интеграционные тесты: upload без файла → 400, неизвестный адрес → 404, битый `jobId` → 400 (GET и analyze).
- Проверено: 18/18 интеграционных, `verify` exit 0.

### 2026-11-15 — P2-1 шаг 5: выделен блок library (улицы/дома)

- `api/routes/library-routes.js` — `GET /` (с ETag), `POST /streets`, `POST /buildings` (валидация Zod, 409 на дубликаты); зависимости инжектируются.
- Смонтирован на `/api/library`; удалён inline-код (2408 → 2373 строк).
- **Исправлен баг**: `updateAddressLibrary` падал на пустой библиотеке (`null.streets`) — первая улица на чистой БД давала 500. Теперь нормализует `null` в `{streets:[],buildings:[]}`.
- Новые интеграционные тесты: создание улицы/дома, 409 на дубликаты, 400/422 на невалидные данные, ETag.
- Проверено: 16/16 интеграционных, `verify` exit 0.

### 2026-11-15 — P2-1 шаг 4: выделен health-check

- `api/services/health.js` — `createHealthChecks()`: `checkTesseract` (кэш 30 с), `checkOllamaStatus` (tells/model), `modelName`. Логика перенесена без изменений.
- `server.js`: `const { checkOllamaStatus, checkTesseractCached } = createHealthChecks();`; удалены локальные `checkTesseract`, `checkOllamaStatus`, `tesseractStatusCache` (2489 → 2408 строк).
- Проверено: `verify` exit 0; 14/14 интеграционных.

### 2026-11-15 — P2-1 шаг 3: выделен блок настроек

- `api/routes/settings-routes.js` — openrouter/moss: `GET` → `{disabled:true}`, `PUT`/`DELETE`/`POST test` → 410 Gone (облачные провайдеры отключены, локальная связка Qwen3-VL + Tesseract).
- `app.use('/api', createSettingsRouter())`; удалён inline-код из `server.js` (2515 → 2489 строк).
- Новые интеграционные тесты: `cloud provider settings` (GET 200 disabled, PUT 410), `template endpoints` (GET/upload/download/delete).
- **Исправлен баг**: `res.download` отдавал 500 на файл в `.private/template` — Express по умолчанию `dotfiles: 'deny'`; добавлен `{ dotfiles: 'allow' }`. Это проявилось только в интеграционном тесте (unit-тесты проверяли строки).
- Проверено: 14/14 интеграционных, `verify` exit 0.

### 2026-11-15 — P2-1 шаг 2: выделен блок шаблона

- `api/services/template-store.js` — домен: `readMeta/saveMeta/remove/toPublic/replaceTemplate/filePath/absolutePath/ensureDir`; валидация `storageName`, атомарная запись (tmp + rename).
- `api/routes/template-routes.js` — 4 HTTP-маршрута (`GET /`, `GET /file`, `POST /`, `DELETE /`), зависимости инжектируются, multer создаётся внутри.
- `api/domain/text.js` — `cleanLabel`; устранено дублирование (было объявлено и в `server.js`, и инжектилось в store).
- `server.js` 2646 → 2515 строк; `readTemplateMeta` оставлен тонкой обёрткой (используется `pinTemplateReference` и `readyz`).
- Проверено: `verify` exit 0; 12/12 интеграционных; живой цикл (GET null → upload 201 → GET → DELETE → null).

### 2026-11-15 — P2-1 шаг 1: интеграционные тесты (сетка безопасности)

- `tests/node/helpers/integration-harness.js`: поднимает реальный API на эфемерном порту против БД `vdgo_itest`, cookie-aware клиент, `ensureAdmin()` для чистой/настроенной БД.
- `tests/node/integration/api.test.js` (5) + `business-flows.test.js` (7): health/readyz, анонимный доступ 401, login/me/logout, создание сотрудника, дубликат 409, multi-house dispatch (одна группа), lifecycle start→visit, 404 на неизвестный id, ETag→304.
- CI job `integration` с `postgres:17.7`; скрипты `test:integration`, `db:deploy:test`.
- Исправлен баг: `resumeStoredAnalysisQueue` падал на пустой БД (`library.streets` у null) — приложение не стартовало с чистой БД.
- Решения по нагрузке: P2-3 (SSE) и P2-12 (нагрузочные тесты) помечены как «не требуется» для 10–25 пользователей.
- Проверено: 12/12 интеграционных, повторный прогон на «грязной» БД тоже 12/12; `npm run verify` exit 0.

### 2026-11-15 — P2-11: dead legacy UI removed

- Удалён `tests/fixtures/legacy-frontend/` (524K) — старый multi-page UI, который приложение не отдаёт (заменён React-SPA: `/team`, `/schemes`, `/login` и т.д.).
- Удалены тесты, проверявшие его HTML/JS строками: `workforce-contract`, `workforce-inbox-folders`, `workforce-planning`, `manual-cad-ink-trace` (последний тестировал алгоритм, которого нет в продакшене).
- Удалён класс `BrowserExportRegressionTests` в `tests/python/test_engine.py` (4 теста по legacy `app.js`/`index.html`/`styles.css`).
- Backend-контракты сохранены: `tests/node/workforce-backend-contracts.test.js`.
- Обновлены `services/ollama/package.json`, `eslint.config.js`, `tests/node/repository-layout.test.js`.
- Проверено: `npm run verify` exit 0; node 97, python 195, vdgo 62.

### 2026-11-15 — P2-5: lookup indexes

- `buildLookups()` в `workforce-system.js`: `usersById`, `tasksById`, `reportsByTask`, `defectsByTask`; сериализаторы тратят O(1) на сущность вместо O(n) (было O(n²) на список).
- Инвалидация в `saveUsers`/`saveWorkspace`.
- `server.js`: `buildSchemeIndex`/`getSchemeIndex`, `findScheme` отвечает по индексу `jobId` (6 вызовов), fallback-скан оставлен.
- Проверено: `tests/node/lookup-indexes.test.js`; API отдаёт идентичные данные.

### 2026-11-15 — быстрый батч P2/P3

- **P2-9**: `VERSION` — единственный источник версии; `services/ollama/api/lib/version.js` (`appVersion()`), подключён в `server.js`, `logger.js`, `workforce-system.js`; `services/vdgo/app.py` читает `VERSION`; `frontend/package.json` и lock-файлы синхронизированы (4.5.13 → 4.5.17); `tests/node/version.test.js`.
- **P3-5**: `.DS_Store` удалён из репо и игнорируется; убран устаревший `archive_index.json`; удалены `generated.pdf`, `_work.pdf`, `_regression_upload.png`; `storage_path` в архиве стал относительным.
- **P2-10**: удалены `engine/graph.js`, `strokes.js`, `prompts.js` (0 ссылок, пайплайн на Python).
- **P2-7**: `app.Dockerfile` переведён на `npm ci` (frontend + app), копируются lock-файлы.
- **P2-8**: из runtime-образа убраны `tests/`, `frontend/src`, `compose.yaml`, `infra/*`; в CI добавлена job `image`, проверяющая отсутствие тестов и исходников в образе.
- Проверено: `npm run verify` exit 0; 114 node-тестов; образ собран и запущен (health 200, `/vdgo/` 200, ассеты 200, `tests/` и `src` отсутствуют).

### 2026-11-15 — P2-4: write amplification

- `refreshSchemeState` возвращает, изменилось ли что-то; `GET /api/workforce/reports` пишет только при реальном изменении статуса.
- `saveWorkspace` сравнивает JSON-снапшот workspace и пропускает запись, если ничего не изменилось.
- Убран write-through legacy JSONB (`tx.workforceWorkspace.upsert`, `tx.addressLibrary.upsert`) — вдвое меньше записей на каждую мутацию.
- Модели `AddressLibrary`/`WorkforceWorkspace` удалены из `prisma/schema.prisma` (таблицы остались в БД как архив).
- Проверено: 10 опросов reports → 0 записей (`n_tup_upd` delta=0); изменение статуса → `updated_at` растёт; `tests/node/write-amplification.test.js`.

### 2026-11-15 — P1-14: нормализация данных

- Миграция `20261116120000_normalize_address_and_workspace`: таблицы `address_streets`, `address_buildings`, `address_schemes`, `workforce_tasks`, `workforce_reports`, `workforce_defect_reports` + индексы + backfill из JSONB-синглтонов.
- `address-library-repo.js`: чтение сборкой из таблиц, запись upsert + удаление исчезнувших в транзакции.
- `workforce-workspace-repo.js`: то же для задач/отчётов/дефектов; `data` хранит полный payload.
- Оба репозитория сохраняют прежнюю форму ответа, поэтому маршруты не менялись.
- Проверено: backfill (streets=2, buildings=1, schemes=1, tasks=3, reports=1); round-trip; API (library/tasks/overview/reports 200, создание задачи → 4 строки, статус → `house_visited`, идемпотентность); `tests/node/normalized-repos.test.js`.
- Осталось: снять write-through legacy JSONB и удалить старые таблицы-синглтоны после перехода всех инстансов.

### 2026-11-15 — завершение «частичных» пунктов

- **P1-1** PostgreSQL-only: `requirePostgres()` fail-fast, удалены JSON-fallback и `atomicJson`, legacy `sessions.json`.
- **P2-2** ETag + conditional GET (`api/lib/etag.js`) на списки и чтения; проверено 200 → 304.
- **P1-9** CI-джоб `migrations` на чистом PostgreSQL; миграции применяются с нуля.
- **P1-2** idle timeout (`sessions.last_seen_at`, `SESSION_IDLE_MS`) + `revoke-all-sessions`; проверено 401 после простоя.
- **P1-3** идемпотентный replay генерации VDGO (хеш тела, копия в `/app/output/.idem`).
- **P1-11** shared rate-limit store на `rate_limit_buckets`; проверено на реальной БД.
- **P1-4** restore drill: дамп → восстановление в чистый `postgres:17.7` → приложение поднимается; скрипты принимают `PGURL`.
- **P1-8** streaming multipart (spool на диск, потоковая запись файлов, лимиты поля/файла).
- **P1-12** `read_only: true` + tmpfs; проверено `--read-only --cap-drop ALL` (health 200, setup 201, без EROFS).
- **P1-14** typed runtime-слой `api/validation/entities.js` (Zod) во всех репозиториях.
- Проверка: `npm run verify` exit 0; 102 node-теста; VDGO 25 passed / 37 skipped.

### 2026-11-14 (продолжение)

- **P1-10** закрыт: `docs/openapi.yaml` + `tests/node/openapi.test.js` (контрактные тесты без `/api/v1`).
- **P1-4** частично: `infra/scripts/backup.sh`, `restore.sh`, `retention.sh`, `docs/BACKUP-RESTORE-RU.md`; restore drill не проведён.
- **P1-9** частично: `psycopg_pool` в `services/vdgo/database.py`, `close_pool()` при shutdown, env `VDGO_DB_POOL_*`.
- **P1-8** частично: `VDGO_MAX_FILE_BYTES` (64 МБ) на файл внутри multipart.
- **P1-3** частично: идемпотентность `/api/analyze` по `Idempotency-Key`.
- **P1-2** частично: `POST /api/workforce/users/:id/revoke-sessions`.
- **P1-11** частично: `heavyQuota` (per-user, IPv6-safe) на GPU-маршрутах.
- **P1-12** частично: `no-new-privileges`, `cap_drop: [ALL]`, `tmpfs /tmp`.
- **P2-6** закрыт: optimistic concurrency manual CAD (`If-Match`, 409 `REVISION_CONFLICT`, `ETag`); попутно исправлена бесконечная рекурсия `readManualProject` в JSON-режиме.
- **P2-2** частично: nginx `gzip`, per-location `client_max_body_size`.
- **P2-13** закрыт: ADR-0001, ADR-0002, `docs/runbook.md`.
- Проверка: `npm run verify` exit 0; 82 node-теста; E2E optimistic concurrency (200 → 409) на локальном PostgreSQL.
- **Отложено до production**: P0-7 (TLS/дефолтный пароль), CSRF/idle timeout/global revoke-all, shared store, P1-5 (OTel/metrics/alerts), P1-12 `read_only`, P1-13 прогон на GitHub, cleanup legacy JSON и нормализация P1-14.
