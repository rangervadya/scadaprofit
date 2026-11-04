# Установка CAD Reconstruction Engine 4.3.4

1. Обновите репозиторий полным содержимым архива 4.3.4, сохранив структуру каталогов.
2. Не заменяйте `.env`, `.git` и резервные копии на сервере. Сохраните весь каталог `public/`, включая `styles.css`.
3. Создайте Commit в `main`, затем на сервере выполните:

```bash
cd /opt/scadaprofit
sudo git pull --ff-only origin main
sudo docker compose config --quiet
sudo docker compose build app
sudo docker compose up -d --no-deps app
curl -sS http://127.0.0.1:3001/api/health
```

Проверьте `version: 4.3.4`, `pipeTileGrid: 3` и `ocrTileGrid: 3`. В JSON `/api/health` общее ограничение Python по умолчанию равно 2700000 мс (45 минут); лимиты Ollama OCR/PIPE остаются 180/240 секунд. Обновите браузер через `Cmd + Shift + R`. Не запускайте `docker compose down -v`.

## Наблюдение за обработкой

В отдельном терминале смотрите потоковый журнал контейнера:

```bash
sudo docker compose logs -f --tail=100 app
```

В логе появятся строки `[JOB]`, `[OCR]`, `[PIPE]`, `[CAD]` и `[EXPORT]`. Например: `Tile 4/9 started`, `Tile 4/9 completed`, `Handwritten row 4/12 started`. Если задание оборвалось, найдите его UUID в журнале приложения: подробный журнал находится в `/tmp/cad-reconstruction-jobs/<UUID>/progress.log` внутри контейнера app. Успешный ответ API содержит `progressUrl`; при ошибке путь также включён в `details`.

Если перед приложением установлен reverse proxy, проверьте, что его тайм-аут ожидания HTTP-ответа также не меньше 45 минут. Увеличение лимита Python не меняет ограничения прокси, браузера или Ollama.
