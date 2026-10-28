# ЧЕРТЁЖ — CAD Sketch Converter Offline 2.2 (Docker)

Офлайн-веб-приложение для приблизительной реконструкции рукописных технических схем. Полноценный Docker Compose стек включает веб-приложение, OpenCV, Tesseract, построение PNG/SVG/DXF и Ollama с Qwen2.5-VL-3B. После установки пакетов и загрузки модели обработка не обращается к облачному API.

> **Осторожно:** Qwen2.5-VL-3B — небольшая vision-language модель, а не CAD-решатель. Для предотвращения заведомо плохого результата версия 2.2 требует несколько отдельных трасс на сложных изображениях, проверяет количество маршрутов/вершин, повторяет запрос один раз и отказывает вместо того, чтобы показать одну линию вместо схемы. Даже при успешной проверке могут быть неверные ветви, подписи и размеры. Всегда сверяйте чертёж с исходником перед инженерным применением.

## Быстрый запуск в Docker (Ubuntu + NVIDIA)

Порт 3001 используется по умолчанию, чтобы не конфликтовать с уже занятым портом 3000.

1. Убедитесь, что Docker Compose и NVIDIA Container Toolkit готовы:

   ```bash
   docker --version
   docker compose version
   docker run --rm --gpus all ubuntu nvidia-smi
   ```

   Последняя команда должна видеть GTX 1060. Если Docker не умеет передавать GPU, см. [официальную инструкцию Ollama для Docker](https://github.com/ollama/ollama/blob/main/docs/docker.mdx). Перезапуск Docker может ненадолго остановить остальные контейнеры, например n8n.

2. Остановите host Ollama, чтобы его модель не занимала VRAM параллельно с контейнерной копией:

   ```bash
   sudo systemctl stop ollama
   ```

   Это не удаляет модель и не отключает службу навсегда.

3. Соберите и запустите два контейнера (выполняйте из папки приложения):

   ```bash
   docker compose -f compose.yaml up -d --build
   docker compose -f compose.yaml exec ollama ollama pull qwen2.5vl:3b
   docker compose -f compose.yaml restart app
   ```

   Полный Docker-режим хранит модель в отдельном volume `ollama_data`, поэтому один раз скачает её повторно (примерно 3,2 ГБ), хотя она уже есть в host Ollama. Это не тарифицируется за запрос; требуется свободное место на диске.

4. Проверьте:

   ```bash
   docker compose -f compose.yaml ps
   docker compose -f compose.yaml exec ollama ollama ps
   curl -s http://127.0.0.1:3001/api/health | python3 -m json.tool
   curl -I http://127.0.0.1:3001/
   ```

   Откройте `http://IP_СЕРВЕРА:3001` в браузере компьютера в той же сети. IP узнайте через `hostname -I`. Не открывайте сайт в публичный интернет без аутентификации и защиты.

### Альтернатива: использовать уже скачанную host-модель без повторной загрузки

Если не хотите дублировать 3,2 ГБ и предпочитаете пока оставить Ollama на Ubuntu host, используйте только контейнер приложения (Ollama в таком варианте остаётся вне Docker):

```bash
docker compose -f compose.host-ollama.yaml up -d --build
curl -s http://127.0.0.1:3001/api/health | python3 -m json.tool
```

Этот вариант использует Linux `network_mode: host` и порт 3001. Не запускайте два compose-варианта одновременно на одном порту.

## Управление Docker

```bash
# логи приложения
docker compose -f compose.yaml logs -f app
# логи Ollama
docker compose -f compose.yaml logs -f ollama
# остановить контейнеры, сохранив модель
docker compose -f compose.yaml down
# запустить снова
docker compose -f compose.yaml up -d
```

**Не запускайте `docker compose down -v`, если не хотите удалить сохранённую модель.** Не запускайте Qwen2.5-VL в контейнере одновременно с Qwen2.5-VL на host — две копии могут не поместиться в 6 ГБ VRAM.

## Что улучшено в версии 2.2

- CAD prompt теперь требует отдельную трассу для каждой ветви/участка между узлами; отрицает одну длинную ломаную/кривую вместо всей сети.
- Для сложных входов выполняется валидация числа маршрутов, вершин и уникальных координат, затем один corrective retry. Если результат по-прежнему схлопнут, сервер возвращает ошибку, а не показывает обманчивый чёрно-белый fallback.
- `sourceAspect` прокидывается в renderer, чтобы не растягивать все схемы в один и тот же широкий viewport.
- Повышено качество JPEG превью для Qwen и разрешение OCR-прохода без изменения исходных пикселей для очистки/векторизации.
- Python/Node приложение и Ollama запускаются в Docker Compose; том с моделью сохраняется между перезапусками.

## Требования и архитектура

- Ubuntu Linux x86-64.
- Docker Engine + Docker Compose v2.
- NVIDIA Driver и NVIDIA Container Toolkit для GPU-передачи в контейнер.
- Qwen2.5-VL-3B в Ollama.
- В контейнере приложения: Node.js, OpenCV, Tesseract RU/EN, CairoSVG, ezdxf.

Поток обработки: фото → очистка/вспомогательный OCR → Qwen формирует JSON-описание маршрутов/подписей → renderer строит PNG/SVG/DXF. Резервный режим `clean` по-прежнему просто очищает/трассирует исходное изображение; это не семантическая реконструкция труб.

## Диагностика

- Если `qwenAvailable` — `false`: `docker compose -f compose.yaml logs -f ollama` и проверьте `ollama list` внутри контейнера.
- Если GPU не виден: `docker compose -f compose.yaml exec ollama nvidia-smi` (если утилита включена в образ) либо временно проверить GPU через `docker run --rm --gpus all ubuntu nvidia-smi`.
- Если CAD-режим не проходит проверку: фото должно быть без сильной перспективы, схема целиком в кадре и подписи по возможности читаемы. Попробуйте отдельные крупные фрагменты, не повышая выдуманную детализацию.
- Проверка Node/Python синтаксиса при сборке: `npm run check`.

## Ручная установка без Docker (legacy)

Можно установить приложение непосредственно в Ubuntu; это оставляет Ollama на host:

```bash
chmod +x setup-ubuntu.sh
./setup-ubuntu.sh
PORT=3001 npm start
```

Для подробностей исходной установки см. `INSTALL-MODEL.md` и `setup-ubuntu.sh`.
