# Исправление порядка Yandex OCR — ScadaProfit 4.3.27

В версии 4.3.25 при включённом Yandex OCR сначала выполнялись до девяти медленных локальных Qwen OCR-запросов, и только после них запускался Yandex Vision. Версия 4.3.27 меняет порядок: Yandex Vision OCR вызывается первым. Если он возвращает распознанные строки, локальный Qwen OCR для этой задачи пропускается. Если Yandex отключён, возвращает ошибку или не находит ни одной строки, запускается сохранённый локальный Qwen fallback. Tesseract всегда остаётся дополнительным OCR-источником. Мультимодальная трассировка труб Yandex и локальный Qwen fallback сохранены.

## 1. Обновить локальную папку на Mac

Скачай `scadaprofit-4.3.27-yandex-auth-fix-overlay.zip` в «Загрузки». В Terminal VS Code открой корень `cad-sketch-converter-docker-2.2`:

```bash
git status --short
```

Продолжай только если список пустой или все показанные изменения уже сохранены отдельно. Распакуй архив:

```bash
unzip -o ~/Downloads/scadaprofit-4.3.27-yandex-auth-fix-overlay.zip -d .
npm run check
git status --short
```

В списке не должно быть `vdgo/`, `compose.yaml`, Nginx или инфраструктурных файлов.

## 2. Отправить только разрешённые файлы в GitHub

```bash
git add CHANGELOG-RU.md README.md README-RU.md UPGRADE-GIT-4.3.27-RU.md UPDATE-MANIFEST-4.3.27.txt package.json server.js processor.py yandex_ai.py manual-cad-core.js public/app.js public/index.html public/styles.css public/manual-cad.html public/manual-cad.js public/manual-cad.css tests/manual-cad.test.js tests/test_engine.py tests/test_yandex_ai.py tests/test_yandex_priority.py
git status --short
git commit -m "Prioritize Yandex Vision OCR"
git push origin main
```

Перед commit проверь, что среди staged-файлов нет `vdgo/`, `compose.yaml` и Nginx.

## 3. Обновить только app на сервере

**Не обновляй приложение, пока текущая задача обработки ещё выполняется:** пересоздание контейнера `app` прервёт её. Сначала дождись финального статуса текущей схемы или убедись в журнале, что задача завершилась.

После успешного push и завершения текущей задачи на сервере:

```bash
cd /opt/scadaprofit
git pull --ff-only origin main
sudo docker compose config --quiet
sudo docker compose build app
sudo docker compose up -d --no-deps app
sudo docker compose ps
curl -sS http://127.0.0.1:3001/api/health
```

Обновляется только сервис `app`. Не выполняй `docker compose down`, `down -v`, не пересоздавай `gateway`, `ollama`, `vdgo-backend`, `vdgo-frontend` или `vdgo-db`. Текущий API-ключ и Folder ID хранятся в приватном файле существующего тома данных и сохраняются при пересборке только `app`.

## 4. Проверить версию и флаги Yandex без раскрытия ключа

```bash
curl -sS http://127.0.0.1:3001/api/health | python3 -c 'import json,sys; d=json.load(sys.stdin); y=d.get("yandexAI",{}); print("version:",d.get("version")); print("Yandex configured:",y.get("configured")); print("Yandex enabled:",y.get("enabled")); print("Yandex OCR enabled:",y.get("ocrEnabled")); print("Yandex pipe enabled:",y.get("pipeEnabled")); print("Qwen model:",d.get("qwenModel")); print("Qwen OCR grid:",d.get("qwenLimits",{}).get("ocrTileGrid"))'
```

В выводе не должно быть API-ключа; команда его не печатает.

## 5. Новый тест

Только после того, как `/api/health` показывает версию `4.3.27`, `Yandex enabled: True` и `Yandex OCR enabled: True`, загрузи отдельную тестовую копию фотографии. В журнале ожидаем последовательность:

```text
Yandex Vision OCR started (cloud-first; local Qwen remains fallback)
Yandex Vision OCR completed: annotations=...
Local Qwen OCR skipped: Yandex Vision OCR succeeded; local Qwen remains available as fallback
Tesseract OCR started
```

Если Yandex не доступен или не вернул ни одной аннотации, журнал должен указать причину и начать локальный Qwen fallback. Не отправляй API-ключ в чат и не публикуй его в Git.

## Защита VDGO

Пакет включает только пути из `UPDATE-MANIFEST-4.3.27.txt`. Он не содержит `vdgo/`, Compose, Nginx, PostgreSQL, Docker volumes или конфигурацию Ollama. Yandex credentials остаются в приватном томе `cad_jobs`; никаких секретов в ZIP нет.

Локальные unit-тесты проверяют очередность и fallback, но реальный доступ к Yandex API будет подтверждён только тестом на сервере с твоим ключом и квотами.


### Исправление Yandex 4.3.27

Для API-ключа сервисного аккаунта Yandex Vision OCR сам определяет каталог по сервисному аккаунту. Поэтому запрос Vision больше не отправляет заголовок `x-folder-id`. Для мультимодальной модели используется `OpenAI-Project` с Folder ID, как описано в документации Yandex. Если после этого API всё ещё возвращает HTTP 403, необходимо отдельно проверить эффективные роли сервисного аккаунта на каталоге, облаке и организации, а также активные политики доступа.
