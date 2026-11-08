# ScadaProfit 4.3.24 — обновление локального проекта и сервера

## Что меняется

Версия 4.3.24 дорабатывает уже существующий поток «Схемы домов → преобразование → LPGCad R1 → ручной CAD»:

- Новый ручной чертёж сразу использует LPGCad R1; надпись справа в шапке редактируется.
- Легенда, примечания и подписи разведены по отдельным зонам чистового листа A4/A3 в SVG и DXF.
- Пересечение со статусом `needs_review` больше не получает автоматически маркер подтверждённого соединения.
- Для типичных фотографий/сканов (длинная сторона до 1600 px, короткая до 1200 px) Qwen обрабатывает четыре перекрывающихся фрагмента вместо девяти. Крупные страницы сохраняют настроенную сетку.
- Стандартные старые тайм-ауты Compose повышаются для OCR до 240 секунд и для трассировки до 300 секунд; временные сбои Ollama получают одну повторную попытку. Контрольные точки остаются включены.

Это не означает, что модель гарантированно распознаёт все рукописные линии или что схема автоматически становится пригодной для монтажа. Неполные и сомнительные части остаются на проверку. Размеры, символы, диаметры, номера квартир и расположение стояков не выдумываются.

## Локальный Mac / VS Code

1. Сделай резервную копию локального проекта.
2. Скачай `scadaprofit-4.3.24.patch` в `~/Downloads` (патч прикладывается отдельной ссылкой в сообщении).
3. В терминале VS Code перейди в корень репозитория `cad-sketch-converter-docker-2.2` и выполни:

```bash
git status --short
git apply --check ~/Downloads/scadaprofit-4.3.24.patch
```

4. Только если команда проверки завершилась без ошибки, примени патч:

```bash
git apply ~/Downloads/scadaprofit-4.3.24.patch
git status --short
```

В VS Code должны появиться изменённые и новые файлы основного ScadaProfit. Если `git apply --check` сообщает об ошибке, не используй `--3way`, `--force`, `git reset --hard` или `git clean`; остановись и сохрани текст ошибки.

5. Проверь код:

```bash
npm run check
```

Ожидаемый результат: 12 Node-тестов Manual CAD и 122 Python-теста проходят.

6. Добавь только перечисленные ниже файлы. Не используй общий `git add .`, чтобы не захватить `.DS_Store`, данные пользователя или что-то из VDGO:

```bash
git add .env.example CHANGELOG-RU.md INSTALL-MODEL.md MANUAL-CAD-USER-GUIDE-RU.md README-RU.md UPGRADE-GIT-4.3.24-RU.md UPDATE-MANIFEST-4.3.24.txt package.json server.js processor.py manual-cad-core.js public/index.html public/manual-cad.html public/manual-cad.js tests/manual-cad.test.js tests/test_engine.py
git status --short
git commit -m "Improve LPGCad R1 layout and Qwen tracing"
git push origin main
```

Перед commit проверь, что в списке нет `vdgo/`, `compose.yaml`, Nginx, `.env`, фото заказчиков, архивов, базы данных или томов.

## Сервер — только приложение ScadaProfit

После успешного push зайди на сервер и выполни:

```bash
cd /opt/scadaprofit
git status --short --branch
git pull --ff-only origin main
sudo docker compose config --quiet
sudo docker compose build app
sudo docker compose up -d --no-deps --force-recreate app
sudo docker compose ps
curl -sS http://127.0.0.1:3001/api/health
```

В `/api/health` ожидается версия `4.3.24`; в `qwenLimits` будут видны исходные и эффективные параметры. Обновление пересобирает и пересоздаёт только `app`.

**Не выполняй** `docker compose down`, общий `docker compose up -d`, `docker compose build` без имени сервиса, удаление томов, `git reset --hard` или `git clean -fd`. Не изменяй и не пересоздавай VDGO, PostgreSQL, Ollama или gateway. Файлы обновления не включают `vdgo/`, `compose.yaml`, Nginx, `.env` и данные хранилищ.

## Что здесь реально проверено

`npm run check` прошёл локально: 12 Node-тестов и 122 Python-теста. Синтаксис JavaScript и компиляция Python проверены. Docker-сборка и реальная обработка твоего скана на серверной GTX 1060/Ollama должны быть подтверждены уже на сервере; я не выдаю локальные тесты за такой прогон.
