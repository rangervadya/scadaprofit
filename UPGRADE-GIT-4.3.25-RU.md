# Установка ScadaProfit 4.3.25 и тест Yandex Cloud AI

Обновление включает изменения ScadaProfit 4.3.24 и дополнительный, отключаемый облачный провайдер Yandex Cloud AI. Локальные Qwen3-VL и Tesseract сохранены. `vdgo/`, `compose.yaml`, Nginx, PostgreSQL и Docker volumes не изменяются.

## 1. Установить файлы на Mac

Скачай `scadaprofit-4.3.25-yandex-ai-overlay.zip` в папку «Загрузки». Открой Terminal в корне локального проекта `cad-sketch-converter-docker-2.2` и сначала проверь состояние Git:

```bash
git status --short
```

Если есть твои незакоммиченные изменения, не распаковывай архив поверх них — сначала сохрани их отдельным коммитом или сделай резервную копию.

Распакуй обновление в корень проекта:

```bash
unzip -o ~/Downloads/scadaprofit-4.3.25-yandex-ai-overlay.zip -d .
```

Проверь синтаксис и тесты:

```bash
npm run check
```

Проверь список изменений:

```bash
git status --short
```

В списке не должно быть `vdgo/`, `compose.yaml`, `nginx-unified.conf` или изменений базы/инфраструктуры. Если такие пути появились, остановись и ничего не коммить.

## 2. Отправить изменения в GitHub

Добавляй только перечисленные файлы основного ScadaProfit. Не используй `git add .` или `git add -A`, чтобы случайно не включить чужие изменения:

```bash
git add CHANGELOG-RU.md README.md README-RU.md UPGRADE-GIT-4.3.25-RU.md UPDATE-MANIFEST-4.3.25.txt package.json server.js processor.py yandex_ai.py manual-cad-core.js public/app.js public/index.html public/styles.css public/manual-cad.html public/manual-cad.js public/manual-cad.css tests/manual-cad.test.js tests/test_engine.py tests/test_yandex_ai.py

git status --short
git commit -m "Add optional Yandex Cloud AI provider"
git push origin main
```

Перед коммитом ещё раз убедись, что среди staged-файлов нет `vdgo/`, Compose или Nginx.

## 3. Обновить только ScadaProfit на сервере

После успешного push выполни на сервере:

```bash
cd /opt/scadaprofit
git pull --ff-only origin main
sudo docker compose config --quiet
sudo docker compose build app
sudo docker compose up -d --no-deps app
sudo docker compose ps
curl -sS http://127.0.0.1:3001/api/health
```

Ожидаемая версия `/api/health`: `4.3.25`. Пересобирается только `app`; не запускай `docker compose down`, `down -v`, не пересоздавай БД, Ollama, VDGO или gateway.

## 4. Подготовить Yandex Cloud AI

Нужен Yandex Cloud folder и service account. Выдай service account роли:

- `ai.vision.user` — для распознавания текста Yandex Vision OCR;
- `ai.languageModels.user` — для мультимодальной модели в Yandex AI Studio.

Создай API-ключ service account с областью действия `yc.ai.foundationModels.execute`. Скопируй API-ключ и Folder ID. Не присылай ключ в чат, не добавляй его в `.env`, Git или файлы проекта.

Официальные инструкции:

- Vision OCR, рукописный режим: https://aistudio.yandex.ru/ru/docs/vision/operations/ocr/text-detection-handwritten
- Мультимодальные запросы: https://aistudio.yandex.ru/ru/docs/ai-studio/operations/generation/multimodels-request-responses
- Структурированные ответы: https://aistudio.yandex.ru/ru/docs/ai-studio/operations/generation/structured-output

## 5. Провести тест

1. Открой ScadaProfit и выбери существующий дом с загруженной схемой.
2. Открой схему, чтобы она стала активной.
3. Раскрой карточку «Облачный AI · Yandex».
4. Вставь API-ключ, Folder ID и оставь модель `qwen3.6-35b-a3b`.
5. Сохрани настройки. Переключатель «Включить Yandex AI для новых схем» пока можно оставить выключенным.
6. Нажми «Проверить на открытой схеме».

Тест делает два реальных платных API-запроса к выбранной фотографии: handwritten OCR и мультимодальная Qwen3.6. Он показывает количество распознанных строк и предложенных маршрутов, но **не меняет существующий CAD-чертёж и не сохраняет предложения как готовую геометрию**.

Только после успешного теста включи «Включить Yandex AI для новых схем», если хочешь испытать его в полноценном конвейере. На новых обработках:

- локальный Qwen3-VL продолжает запускаться и не удаляется;
- Tesseract продолжает работать как дополнительный OCR;
- Yandex Vision OCR добавляет кандидаты подписей, помеченные как непроверенные;
- мультимодальная Qwen3.6 предлагает трубные маршруты;
- маршруты проверяются по пикселям исходного изображения и геометрии OpenCV;
- если облачные маршруты не проходят проверку, запускается локальный Qwen fallback;
- сомнительные подписи, линии и соединения остаются на ручной проверке.

Модель не должна придумывать скрытые трубы или выдавать неподтверждённые соединения за достоверные. Все размеры, диаметры, ответвления и оборудование нужно сверять с фотографией и утверждать квалифицированным специалистом.

## 6. Отключить или удалить Yandex

Чтобы временно отключить облачную обработку, сними переключатель «Включить Yandex AI для новых схем» и сохрани настройки. Qwen и Tesseract продолжат работать.

Кнопка «Удалить только настройки Yandex» удаляет сохранённый API-ключ и Folder ID из приватного файла настроек. Она не удаляет Qwen, Tesseract, схемы, CAD-проекты или VDGO. Сам интеграционный код можно убрать отдельным обновлением, если ты решишь отказаться от провайдера.

## 7. Хранение ключа и границы обновления

API-ключ хранится на сервере в скрытом файле `.private/yandex-ai-settings.json` внутри уже используемого тома данных ScadaProfit; права файла устанавливаются `0600`. Ключ не отправляется обратно в браузер и не включён в архив.

Пакет меняет только файлы из `UPDATE-MANIFEST-4.3.25.txt`. В нём нет `vdgo/`, `compose.yaml`, Nginx, файлов PostgreSQL или конфигурации Docker volumes. Docker-сборка и реальные запросы Yandex должны быть проверены после установки на сервере; локальные unit-тесты не подтверждают действительность API-ключа, IAM-ролей, квот или доступности модели в конкретном каталоге Yandex Cloud.
