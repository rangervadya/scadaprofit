# ScadaProfit 4.3.28 — OpenRouter вместо Yandex

## Что меняется

- Убирается интерфейс и код Yandex AI. При старте приложение удаляет только старый приватный файл `.private/yandex-ai-settings.json`.
- Добавляется OpenRouter с моделью `nvidia/nemotron-3.5-super-vl:free` для мультимодального OCR и предложений маршрутов труб.
- Локальные Qwen3-VL и Tesseract остаются резервными движками.
- API-ключ хранится в закрытой папке данных ScadaProfit с правами `0600`, не возвращается браузеру и не попадает в Git.
- Существующие CAD-проекты, фото, адресный справочник, шаблоны и ручные CAD-проекты сохраняются.
- `vdgo/`, Compose, Nginx, PostgreSQL и Docker volumes не изменяются.

## Установка на Mac

**Рекомендуется Git PATCH:** он также удаляет старые файлы провайдера Yandex.

1. Скачай `scadaprofit-4.3.28-openrouter.patch` в Downloads.
2. В Terminal VS Code открой корень `cad-sketch-converter-docker-2.2` и проверь локальные изменения:

```bash
git status --short
```

Если есть собственные незакоммиченные изменения, сначала сохрани их. Затем:

```bash
git apply --check ~/Downloads/scadaprofit-4.3.28-openrouter.patch
git apply ~/Downloads/scadaprofit-4.3.28-openrouter.patch
npm run check
git status --short
```

3. Убедись, что список содержит только файлы основного ScadaProfit и удаления старого Yandex-модуля. Там не должно быть `vdgo/`, `compose.yaml`, Nginx или файлов PostgreSQL.
4. Отправь только перечисленные изменения:

```bash
git add CHANGELOG-RU.md README.md README-RU.md UPGRADE-GIT-4.3.28-RU.md UPDATE-MANIFEST-4.3.28.txt package.json server.js processor.py openrouter_ai.py public/app.js public/index.html public/styles.css tests/test_openrouter_ai.py tests/test_openrouter_priority.py
git add -u -- yandex_ai.py tests/test_yandex_ai.py tests/test_yandex_priority.py UPGRADE-GIT-4.3.27-RU.md UPDATE-MANIFEST-4.3.27.txt
git commit -m "Replace Yandex with OpenRouter free multimodal AI"
git push origin main
```

**Альтернатива — ZIP:** скачай `scadaprofit-4.3.28-openrouter-overlay.zip`, распакуй поверх корня проекта, затем выполни удаление старых файлов:

```bash
rm -f yandex_ai.py tests/test_yandex_ai.py tests/test_yandex_priority.py UPGRADE-GIT-4.3.27-RU.md UPDATE-MANIFEST-4.3.27.txt
npm run check
git status --short
```

Для ZIP затем используй те же команды `git add` / `git commit` / `git push` выше.

## Обновление сервера

После push на GitHub выполни на сервере:

```bash
cd /opt/scadaprofit
git pull --ff-only origin main
sudo docker compose config --quiet
sudo docker compose build app
sudo docker compose up -d --no-deps app
sudo docker compose ps
curl -sS http://127.0.0.1:3001/api/health
```

Пересоздаётся только сервис `app`. Не запускай `docker compose down`, не меняй Compose, Nginx, VDGO или PostgreSQL.

## Подключение OpenRouter

1. Открой ScadaProfit → «Облачный AI · OpenRouter».
2. Вставь API-ключ в поле `API-ключ OpenRouter`.
3. Оставь зафиксированную бесплатную модель `nvidia/nemotron-3.5-super-vl:free` (выбор платных моделей намеренно заблокирован).
4. Включи OpenRouter для новых схем и отметь OCR/трассировку труб.
5. Нажми «Сохранить настройки».
6. Открой во «Входящих» тестовую обезличенную фотографию и нажми «Проверить на открытой схеме».

Сам ключ не отправляй в чат и не коммить. Приложение сохраняет его в `.private/openrouter-ai-settings.json` в существующем приватном каталоге данных. Проверочный тест делает два отдельных обращения: OCR и извлечение маршрутов. Тест не меняет чертёж.

## Ограничения бесплатной модели и конфиденциальность

У бесплатных моделей OpenRouter действуют общие лимиты (на момент выпуска: 50 запросов/сутки и 20/минуту); неуспешные вызовы тоже могут считаться. Один тест/задание использует два запроса. У бесплатного endpoint NVIDIA есть предупреждение о записи запросов/изображений для улучшения сервиса. Не отправляй фотографии с адресами домов, ФИО, телефонами, данными клиентов или иной конфиденциальной информацией. Используй обезличенные тестовые копии.

## Проверка

`npm run check` выполняет Node/Python-проверки. Они не подтверждают доступ из российского сервера к OpenRouter. Реальный API-тест выполняется только после ввода твоего ключа в интерфейсе. Если OpenRouter недоступен/исчерпал лимит/вернул ошибку, приложение переходит на локальный Qwen и Tesseract; результат с неполными этапами помечается как черновой.
