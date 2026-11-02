# Обновление до CAD Reconstruction Engine 4.0.0

Проект устанавливается в `/opt/scadaprofit`, порт по умолчанию — `3001`.

## 1. На Mac

Скачайте ZIP-архив и отправьте его на сервер:

```bash
scp ~/Downloads/cad-reconstruction-engine-4.0.zip \
  tech@192.168.1.99:/home/tech/
```

## 2. На Ubuntu (root)

Сначала создаётся резервная копия всего проекта. Затем содержимое архива копируется поверх него. Существующий `.env` не входит в архив и не заменяется.

```bash
cd /opt/scadaprofit

tar -czf /root/scadaprofit-backup-$(date +%F-%H%M).tar.gz .

rm -rf /tmp/cad-reconstruction-4.0
mkdir -p /tmp/cad-reconstruction-4.0
unzip -oq /home/tech/cad-reconstruction-engine-4.0.zip \
  -d /tmp/cad-reconstruction-4.0

cp -a /tmp/cad-reconstruction-4.0/cad-reconstruction-engine-4.0/. \
  /opt/scadaprofit/

cd /opt/scadaprofit
docker compose config --quiet
docker compose build --no-cache app
docker compose up -d --force-recreate app
```

**Не выполняйте `docker compose down -v`.** Ollama service и том `ollama_data` оставлены в Compose с тем же именем; обновление пересоздаёт только `app`. Если до обновления у вас был другой Compose project name, проверьте фактическое имя тома через `docker volume ls` до любых операций с томами.

## 3. Проверка

```bash
docker compose exec app node -p "require('./package.json').version"
curl -s http://127.0.0.1:3001/api/health | python3 -m json.tool
docker compose logs --tail=80 app
```

Ожидаемая версия — `4.0.0`, режим — `cad-reconstruction-engine`.

## 4. Первый запуск

1. Откройте `http://192.168.1.99:3001`.
2. Загрузите исходное фото.
3. Нажмите «Найти линии и построить граф».
4. Сначала смотрите режим «Основные». Если какой-то кусок трассы пропал, нажмите «Показать все» — короткие и пересекающиеся с OCR-кандидаты не удалены.
5. Включите «Показать все узлы для редактирования», переместите узел или включите «Соединить два выбранных узла».
6. Короткие соосные разрывы можно подтвердить в списке предложений. Пересечения отмечены вопросительными маркерами и не соединяются автоматически.
7. Исправьте OCR-подписи и отметьте их «Проверено», если хотите включить печатный текст в лист.
8. Экспортируйте SVG, DXF, JSON или используйте «PDF / печать» и выберите «Сохранить как PDF».

## Важно

Первичная геометрия — список кандидатов OpenCV, не готовые трубопроводы. До инженерного применения обязательно проверьте связность, все узлы, пересечения и размеры по фотографии/проектным данным.
