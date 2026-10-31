# Обновление до Two Mask Lab 3.4.0

На Mac:
```bash
scp ~/Downloads/cad-sketch-converter-two-mask-3.4.zip tech@192.168.1.99:/home/tech/
```

На Ubuntu:
```bash
cd /opt/scadaprofit
tar -czf /root/scadaprofit-backup-$(date +%F-%H%M).tar.gz .
rm -rf /tmp/cad-two-mask-3.4 && mkdir -p /tmp/cad-two-mask-3.4
unzip -oq /home/tech/cad-sketch-converter-two-mask-3.4.zip -d /tmp/cad-two-mask-3.4
cp -a /tmp/cad-two-mask-3.4/cad-sketch-converter-two-mask-3.4/. /opt/scadaprofit/
cd /opt/scadaprofit
docker compose config --quiet
docker compose build --no-cache app
docker compose up -d --force-recreate app
```

Проверка:
```bash
docker compose exec app node -p "require('./package.json').version"
curl -s http://127.0.0.1:3001/api/health
```

Ожидается `3.4.0`. Не используй `docker compose down -v`: Ollama volume не трогаем. Файл `.env` в архиве отсутствует, он сохраняется.

## Как чистить текст
1. Сначала построй две маски.
2. Нажми `Обвести текст лассо`.
3. Обведи рукописную надпись или блок по внешнему контуру. Не включай в обводку трубу, которую нужно сохранить.
4. Повтори для следующих надписей. На исходнике появятся постоянные контуры выбранных областей.
5. В редакторе можно снять галочку маскирования, удалить ошибочную область, исправить текст и включить печать.
6. Нажми `Применить подписи и пересобрать чистый чертёж`.

Рукописная область по умолчанию удаляется из clean SVG. Печатная версия не появляется, пока не введёшь проверенный текст и не включишь `Печатать`.
