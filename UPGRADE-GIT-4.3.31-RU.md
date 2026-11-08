# ScadaProfit 4.3.31 — исправление одиночного OCR-объекта MOSS-VL

Обновление рассчитано на ScadaProfit 4.3.30.

## Что исправлено

MOSS иногда возвращает одну область текста не массивом `annotations`, а объектом вида `{"text":"Ду 25","bbox":[x1,y1,x2,y2]}`. ScadaProfit 4.3.31 принимает такой объект как одну аннотацию, в том числе внутри `result`, но только если присутствуют явный текст и явная геометрия. Координаты не придумываются. Невалидные/внешние рамки отклоняются; Qwen/Tesseract остаются резервом.

## Установка на Mac

В корне проекта проверь Git:

```bash
git status --short
```

Если рабочая папка чистая, скачай `scadaprofit-4.3.31-moss-single-ocr.patch` в `~/Downloads` и выполни:

```bash
git apply --check ~/Downloads/scadaprofit-4.3.31-moss-single-ocr.patch
git apply ~/Downloads/scadaprofit-4.3.31-moss-single-ocr.patch
npm run check
git status --short
```

Если тесты проходят и в изменениях нет `vdgo/`, `compose.yaml` и Nginx:

```bash
git add -A
git commit -m "Fix single-object MOSS OCR response 4.3.31"
git push origin main
```

## Обновление сервера

```bash
cd /opt/scadaprofit
git pull --ff-only origin main
sudo docker compose config --quiet
sudo docker compose build app
```

Только после успешной сборки:

```bash
sudo docker compose up -d --no-deps app
sudo docker compose ps
curl -sS http://127.0.0.1:3001/api/health
```

Обновляй только сервис `app`. Не запускай `docker compose down` и не трогай VDGO, PostgreSQL, gateway/Nginx, `compose.yaml` или Docker volumes.

## Повторная проверка

Открой ту же обезличенную тестовую схему и выполни один тест MOSS. Проверь число распознанных подписей и качество маршрутов; число маршрутов само по себе не подтверждает правильность сети.
