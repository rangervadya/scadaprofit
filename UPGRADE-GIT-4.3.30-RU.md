# ScadaProfit 4.3.30 — исправление разбора OCR MOSS-VL

Обновление рассчитано на проект ScadaProfit 4.3.29. Оно исправляет разбор ответа OCR от MOSS-VL, который в предыдущей версии завершался сообщением «Ответ MOSS OCR не содержит массива annotations».

## Что изменено

- Поддерживаются массивы `annotations`, `texts`, `text_regions`, `recognized_texts`, `results`, `words`, `lines` и другие известные названия.
- Поддерживаются вложенные поля `result`, `data`, `ocr`, `document` и `response`.
- Рамки нормализуются из `bbox`/`box`/`bounding_box`, прямоугольников xyxy/xywh и полигонов.
- Объекты без текста, координат или с координатами за пределами изображения не принимаются. Выдуманные рамки и координаты по всей странице не создаются.
- Если формат ответа не поддерживается, диагностическое сообщение показывает только имена JSON-полей, без распознанного текста. Локальный Qwen/Tesseract остаётся резервом.

## Установка на Mac

В корне локального проекта `cad-sketch-converter-docker-2.2` проверь состояние Git:

```bash
git status --short
```

Если нет незакоммиченных изменений, скачай `scadaprofit-4.3.30-moss-ocr-fix.patch` в `~/Downloads` и проверь его:

```bash
git apply --check ~/Downloads/scadaprofit-4.3.30-moss-ocr-fix.patch
```

Если проверка прошла, примени его:

```bash
git apply ~/Downloads/scadaprofit-4.3.30-moss-ocr-fix.patch
npm run check
git status --short
```

Ожидается версия 4.3.30, 13 CAD-тестов и 146 Python-тестов. Проверь, что в списке нет `vdgo/`, `compose.yaml` или `nginx-unified.conf`. После проверки отправь изменения в `main`:

```bash
git add -A
git commit -m "Fix MOSS OCR response parsing 4.3.30"
git push origin main
```

## Обновление сервера

Сначала получи обновление и собери только основной сервис `app`:

```bash
cd /opt/scadaprofit
git pull --ff-only origin main
sudo docker compose config --quiet
sudo docker compose build app
```

Только при успешной сборке:

```bash
sudo docker compose up -d --no-deps app
sudo docker compose ps
curl -sS http://127.0.0.1:3001/api/health
```

Не используй `docker compose down` и не пересоздавай другие сервисы. VDGO, PostgreSQL, gateway/Nginx, `compose.yaml` и Docker volumes не меняются.

## Повторная проверка MOSS

После установки обнови страницу ScadaProfit, открой фотографию тестовой схемы и нажми «Проверить открытую схему». Проверь OCR и Vision. Не повторяй много раз, чтобы не тратить временно бесплатный лимит MOSS.

Важно: 8 маршрутов, полученных в предыдущем тесте, — это кандидаты модели, а не подтверждённая геометрия. Перед экспортом надо проверить, что локальная проверка по исходным пикселям и топологии завершилась успешно, и вручную проверить соединения и размеры.
