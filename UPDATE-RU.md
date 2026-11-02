# Обновление до CAD Reconstruction Engine 4.1.0

Проект рассчитан на обновление существующей установки в `/opt/scadaprofit` на Ubuntu. Команды не удаляют именованный том Ollama и не перезаписывают `.env`.

## 1. Передача архива с Mac

Скачай `cad-reconstruction-engine-4.1.zip` в `~/Downloads`, затем выполни на Mac:

```bash
scp ~/Downloads/cad-reconstruction-engine-4.1.zip \
  tech@192.168.1.99:/home/tech/
```

## 2. Резервная копия и обновление на Ubuntu

Выполни на сервере:

```bash
cd /opt/scadaprofit

# Сохранить текущий проект перед заменой
tar -czf /root/scadaprofit-backup-$(date +%F-%H%M).tar.gz .

# Распаковать в отдельный временный каталог
rm -rf /tmp/cad-reconstruction-4.1
mkdir -p /tmp/cad-reconstruction-4.1
unzip -oq /home/tech/cad-reconstruction-engine-4.1.zip \
  -d /tmp/cad-reconstruction-4.1

# Скопировать файлы новой версии в действующий проект
cp -a /tmp/cad-reconstruction-4.1/cad-reconstruction-engine-4.1/. \
  /opt/scadaprofit/

cd /opt/scadaprofit

docker compose config --quiet
docker compose build --no-cache app
docker compose up -d --force-recreate app
```

**Не выполняй `docker compose down -v`.** Это может удалить именованный том с локальными моделями Ollama. Контейнер Ollama перезапускать не требуется.

## 3. Проверка

```bash
docker compose exec app node -p "require('./package.json').version"
curl -s http://127.0.0.1:3001/api/health | python3 -m json.tool
curl -sI http://127.0.0.1:3001/styles.css
curl -sI http://127.0.0.1:3001/app.js
```

Ожидаемая версия — `4.1.0`; статические файлы должны отвечать `200 OK` и иметь `Cache-Control: no-store`.

Затем открой `http://192.168.1.99:3001` и обнови страницу сочетанием `Ctrl+Shift+R`.

## 4. Первый запуск

1. Перетащи фотографию на область загрузки или выбери файл.
2. Проверь миниатюру и имя файла.
3. Нажми «Найти линии и построить граф».
4. Посмотри наложение кандидатов на оригинал и сводку.
5. Включи «Узлы» и «Пересечения», проверь сомнительные места.
6. Удали шумные кандидаты или подтверди соединения в левой панели.
7. Экспортируй SVG, DXF или JSON. Для PDF используй печать браузера.

## Если анализ не запускается

```bash
docker compose logs --since=5m app
curl -s http://127.0.0.1:3001/api/health
```

Ошибки загрузки и анализа также показываются в интерфейсе под кнопкой запуска.
