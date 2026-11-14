# Логирование и диагностика

Дата: 14 ноября 2026 г.
Область: `services/ollama` (Node API + Python engine), `services/vdgo`, `compose.yaml`

## 1. Что изменилось

| Область | Было | Стало |
| --- | --- | --- |
| Node API | `console.log` / `console.error` с ad-hoc префиксами `[JOB …]`, `[QUEUE]`, `[TEMPLATE]` | `pino` + `pino-http`, один JSON-объект на строку в stdout |
| Python engine | `_progress()` писал `[STAGE] текст` в stderr, у каждого модуля свой формат | общий `engine/logging_setup.py`: JSON в stderr, единый `emit_progress()` |
| VDGO | `log_message` отключён, ошибки 500 никуда не писались | JSON в stdout, access-лог на каждый запрос, `log.exception` на 500 |
| Docker | json-file без ограничений | `max-size=20m`, `max-file=5` у всех пяти сервисов |

Единый JSON-формат означает, что `docker compose logs`, journald и любой
шиппер индексируют записи без парсера под каждый сервис.

## 2. Уровни

Node: `LOG_LEVEL` = `trace|debug|info|warn|error|fatal|silent`, по умолчанию `info`
(`debug` только при `NODE_ENV=development`).

Python: `LOG_LEVEL` / `VDGO_LOG_LEVEL` = `DEBUG|INFO|WARNING|ERROR|CRITICAL`,
по умолчанию `INFO`. Невалидное значение никогда не выключает логирование
целиком — оно приводится к безопасному `info`.

Уровень задаётся в `.env` (см. `.env.example`) и попадает в контейнеры через
`compose.yaml`.

## 3. Структура записи

```json
{"level":"info","time":"2026-11-14T09:15:22.471Z","service":"scadaprofit-app","version":"4.5.17",
 "req":{"method":"GET","url":"/api/template","remoteAddress":"10.0.0.5","requestId":"…"}},
 "res":{"statusCode":401},"responseTime":1,"role":null,"msg":"GET /api/template"}
```

* `service` — `scadaprofit-app` или имя Python-логгера (`processor`, `moss_ai`, `vdgo`).
* `jobId` — первые 8 символов UUID задания; есть на всех строках одного анализа.
* `requestId` — идентификатор HTTP-запроса, он же возвращается клиенту в заголовке
  `X-Request-Id`, поэтому строку сервера можно сопоставить со строкой nginx.
* `elapsed_ms` — в Python-записях время с момента старта процесса.
* `err` — сериализованное исключение (`type`, `message`, `stack`).

## 4. Два канала: stdout и progress.log

Это разные вещи, и путать их не нужно.

* **stdout** — структурированный журнал для оператора и шиппера.
* **`/jobs/:jobId/progress.log`** — человекочитаемый журнал этапов, который
  видит пользователь в интерфейсе. Формат сохранён исторически: `2026-…Z [STAGE] текст`.

Правило разделения одно: в `progress.log` попадают только события, у которых
есть поле `stage`. Диагностика движка и записи сторонних библиотек остаются в
stdout и не засоряют пользовательский журнал.

`services/ollama/api/server.js:runPythonStreaming` разбирает stderr Python:
строка с JSON и непустым `stage` → `progress.log` + JSON-лог; JSON без `stage` →
только JSON-лог; не-JSON → как раньше, дословно в `progress.log`.

## 5. Что логируется

**Node (`scadaprofit-app`)**

* `ScadaProfit API started` — версия, sha256 пайплайна, порт, таймаут Python, каталог CAD.
* каждый HTTP-запрос — метод, путь, статус, длительность, роль (`/api/health` не логируется, его опрашивает Docker каждые 30 с).
* `Analysis metrics collected` — вместо пяти строк `[ENGINE …]` одна запись с полями
  `segments`, `edges`, `cadPrimaryEdges`, `ocrQwenTilesOk/Total`, `pipeQwenRoutes`,
  `timings` и т. д. Значение `MISSING` означает, что поле не записал `processor.py`.
* `Analyze failed`, `Stored scheme analysis failed`, `Cannot save connection`,
  `Cannot save review action`, `Cannot read address library`, ошибки шаблона.
* Воркспейс: `Rejected login`, `User signed in`, `Account created`,
  `Password reset issued and sessions revoked`, `Field sketch report submitted`,
  `Defect photo report submitted`, `Sketch report reviewed`, `Defect photo report reviewed`,
  `Address folder transferred into conclusion`.

**Python engine**

* этапы `JOB`, `OCR`, `PIPE`, `CAD`, `EXPORT`, `REFERENCE`, `CENTERLINE`, `MOSS`
  — те же сообщения, что раньше, но с уровнем и полями.
* `Processor started` / `Processor finished` — входы, выходы, число сегментов и рёбер, `timings_ms`.
* `moss_ai` — `Vision request started`, `Vision response received`, `routes field=…`, `Route rejection schema`.
* `logging_setup.emit_progress(stage, message, level=…, **fields)` — точка расширения:
  любой модуль может добавить событие, не изобретая свой формат.

**VDGO (`vdgo`, `vdgo.database`)**

* `Request` — access-лог: `remote`, `path`, `method`, `status`.
* `Document generated` — формат, число страниц, размер, число схем, длительность.
* `Document generation failed` — 500 с `exc_info`; раньше клиент получал 500 и в логах не было ничего.
* `Document generation rejected` — 400 от валидации.
* `Generated document was not recorded in PostgreSQL` — документ уже собран, аудит-запись не создана.
* `PostgreSQL audit table ready` / `PostgreSQL did not become ready` / `PostgreSQL health check failed`.

## 6. Ротация логов Docker

```yaml
x-logging: &default-logging
  driver: json-file
  options:
    max-size: "20m"
    max-file: "5"
```

Применяется к `ollama`, `app`, `vdgo-backend`, `vdgo-db`, `gateway`. Это 100 МБ
на сервис максимум; при 90-минутном таймауте задания и записи прогресса на каждую
плитку Qwen без лимита диск забивался.

Посмотреть логи:

```bash
docker compose logs -f --tail=150 app
docker compose logs --since 30m vdgo-backend
```

## 6a. Сквозная корреляция через gateway

`infra/nginx/nginx-unified.conf` генерирует `$request_id` и передаёт его в
`X-Request-Id` на каждый проксируемый запрос. `logger.js` подхватывает
входящий `X-Request-Id` вместо создания своего, поэтому один и тот же id
присутствует:

1. в access-логе gateway (`/var/log/nginx/scadaprofit.log`, поле `req=`);
2. в JSON-записи Node (`requestId`) и в ответе клиенту (заголовок `X-Request-Id`);
3. в тексте ошибки, которую видит пользователь (`· запрос 3f2a1b9c`).

Отдельный файл, а не `access.log`, выбран потому, что `access_log` внутри
`http`-контекста не заменяет унаследованную директиву из образа, а добавляет
вторую — иначе каждая строка писалась бы дважды.

```bash
docker compose exec gateway tail -f /var/log/nginx/scadaprofit.log
```

Таймаут чтения для генерации заключений поднят с 300 с до 900 с
(`location ~ ^/vdgo/(generate|generate_docx|preview)$`): синхронный ответ с
фотографиями и DOCX-конвертацией не укладывался в общие 300 с и отдавал 504.

## 7. Секреты

`logger.js` и `logging_setup.py` не логируют:

* пароли и хеши (`password`, `passwordHash`, `newPassword`),
* токены и ключи (`token`, `apiKey`, `secret`, `authorization`),
* cookie и заголовок `Authorization` запроса,
* значения переменных `MOSS_API_KEY`, `OPENROUTER_API_KEY` — они вообще не попадают
  в объект записи, а `localRecognitionPythonEnvironment()` вычищает их перед запуском Python.

`moss-env-boot.js` при старте пишет только флаги `enabled` / `OCR` / `PIPE`, без ключа.

## 8. Типовые сценарии диагностики

| Симптом | Что смотреть |
| --- | --- |
| Задание висит на `queued` | `docker compose logs app \| grep 'Resumed interrupted'` и `analysisQueue` вhealth |
| Задание упало на OCR | `progress.log` задания: стадия `OCR`, сообщения `Tile N/M failed …` |
| 500 при генерации заключения | `docker compose logs vdgo-backend \| grep 'Document generation failed'` — там же `exc` |
| Заключение собрано, но нет записи в БД | `grep 'not recorded in PostgreSQL' vdgo-backend` |
| Не совпадают версии | `/health` VDGO отдаёт `release` из `APP_RELEASE` в compose |

## 9. Проверки

```bash
npm --prefix services/ollama run check          # node --test + py_compile + tests/python
PYTHONPATH=services/ollama/engine python -m unittest discover -s tests/python -p 'test_*.py'
PYTHONPATH=services/vdgo python -m unittest discover -s tests/vdgo -p 'test_*.py'
```

`tests/node/logging.test.js` проверяет: уровни, round-trip прогресса, отсутствие
`console.*` в `server.js`, `workforce-system.js`, `moss-env-boot.js`, и что
значения `REDACT_PATHS` действительно редактируются.