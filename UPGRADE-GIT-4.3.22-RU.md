# ScadaProfit 4.3.22 — локальное обновление и Git main

## Что входит в обновление

- Профиль чистового листа LPGCad R1 в Manual CAD: заголовок заключения, «Схема», подзаголовок, адрес/подъезд, A4/A3, легенда, примечания и подписи.
- Нижние схемы групп стояков, которые оператор задаёт строками `Ст-5: 67, 63, 59`. SVG/DXF экспортируют их в виде редактируемой векторной геометрии; DXF-слой — `RISER_GROUPS`.
- Отдельные типы трубной линии `pipe`, `branch`, `riser` и соответствующие DXF-слои.
- Перенос автоматического черновика в Manual CAD из предыдущего этапа 4.3.21, сохранение консервативного OCR fallback и коррекции ориентации.
- Единый tag Qwen по умолчанию `qwen3-vl:4b-instruct` в приложении, примерах конфигурации и инструкциях.

## Важно: два приложения остаются вместе

В комплекте остаются **ScadaProfit** по `/` и **VDGO** по `/vdgo/`, обслуживаемые существующим gateway. Не удаляй, не перемещай и не переименовывай `vdgo/`. Не изменяй `compose.yaml`, `nginx-unified.conf`, VDGO frontend/backend, PostgreSQL, `.env` и Docker volumes. ZIP содержит только приложение ScadaProfit и относящиеся к нему инструкции; VDGO не исключается из установленного комплекта.

## 1. Обнови локальный проект в VS Code

Распакуй ZIP `ScadaProfit-4.3.22-update.zip` в корень **существующего** репозитория ScadaProfit, с заменой файлов приложения. Не заменяй весь каталог проекта и не удаляй существующие файлы. Сохрани `.git`, `.env`, `vdgo/`, `compose.yaml`, `nginx-unified.conf` и пользовательские данные.

Из корня проекта выполни:

```bash
npm run check
git status --short
```

Проверь изменения в VS Code и убедись, что в изменениях нет файлов `vdgo/`, `compose.yaml` или `nginx-unified.conf`.

Затем зафиксируй изменения и отправь их в `main`:

```bash
git add README.md README-RU.md README.txt CHANGELOG-RU.md UPDATE-RU.md UPGRADE-GIT-4.3.22-RU.md MANUAL-CAD-USER-GUIDE-RU.md DIAGNOSE-QWEN-RU.md INSTALL-MODEL.md DOCKER.md package.json .env.example install-qwen-model.sh server.js processor.py manual-cad-core.js public/index.html public/app.js public/manual-cad.html public/manual-cad.js public/manual-cad.css tests/manual-cad.test.js
git commit -m "ScadaProfit 4.3.22: add LPGCad R1 drawing profile"
git push origin main
```

## 2. Обнови на сервере только ScadaProfit app

После проверки коммита в GitHub `main` выполни на сервере:

```bash
cd /opt/scadaprofit
git pull --ff-only origin main
sudo docker compose config --quiet
sudo docker compose build app
sudo docker compose up -d --no-deps app
sudo docker compose ps
curl -sS http://127.0.0.1:3001/api/health
```

Команда `up` ограничена сервисом `app`. Не запускай `docker compose down`, `docker compose down -v` и не пересоздавай сервисы VDGO, gateway, Ollama или PostgreSQL. Проверить, что VDGO по-прежнему открывается на `/vdgo/`, а ScadaProfit — на `/`.

В ответе `/api/health` ожидается `version: 4.3.22`. Посмотри `ollama.reachable`, `ollama.modelInstalled` и `ollama.models`. Наличие модели в настройках не доказывает, что тег загружен в Ollama. Если `modelInstalled` равно `false`, сначала сверь фактический тег установленной модели и значение `QWEN_MODEL` в существующем `.env`; не запускай загрузку другой модели без проверки места на диске и доступного GPU/RAM.

## 3. Что проверить в браузере

1. ScadaProfit доступен на `/`, а переход в VDGO открывает `/vdgo/`; из VDGO можно вернуться в ScadaProfit.
2. Раздел «Улицы и дома» открывает существующий адресный архив и схемы домов.
3. После обработки схемы нажми `CAD → Доработать`: подложка, основные линии, явные соединения и распознанные подписи должны открыться в Manual CAD.
4. В блоке «Чистовой лист LPGCad R1» заполни адрес, подъезд, исполнителей и проверь A4/A3.
5. В поле нижних групп введи две строки, например `Ст-5: 67, 63, 59` и `Ст-6: 68, 64, 60`, сохрани и экспортируй SVG/DXF. В DXF должны присутствовать слои `PIPE_MAIN`, `BRANCH`, `RISERS` и `RISER_GROUPS`.
6. Проверь, что введённые номера стояков совпадают с исходником. Равномерное расположение номеров по вертикали — только схема, а не измерение межэтажных расстояний.

## Границы и честные ограничения

- Обновление сохраняет оба приложения в одном комплекте. Оно не меняет исходники VDGO, конфигурацию маршрутизации, базу PostgreSQL или её тома.
- Генератор не выводит отсутствующие трубы, ветви, символы, диаметры, номера квартир и фактические высоты этажей. Основная геометрия должна прийти из изображения/графа либо быть дорисована и подтверждена оператором.
- Нижние группы стояков формируются из явно введённого текста. Автоматическое извлечение всех связей «стояк — квартира» из произвольной рукописной фотографии ещё не реализовано.
- Qwen/Tesseract pipeline может вернуть неполный черновик. `review`-объекты не становятся подтверждённой инженерной геометрией; перед выпуском нужен просмотр специалистом.
- Локально пройдены 9 Node-тестов Manual CAD и 124 Python-теста. SVG прошло XML-проверку; DXF дополнительно открыт библиотекой ezdxf (53 векторные сущности, включая слой RISER_GROUPS). Создано и просмотрено SVG-превью тестового листа. Docker CLI отсутствует, поэтому `docker compose config --quiet` здесь выполнить не удалось. Реальный запуск Qwen/Ollama на сервере и Docker build на машине заказчика в этой среде не выполнялись.
