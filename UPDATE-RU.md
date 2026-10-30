# Обновление JSON Brain до 2.9.0

## Передача архива с Mac

```bash
scp ~/Downloads/cad-sketch-converter-json-brain-2.9.zip \
  tech@192.168.1.99:/home/tech/
```

## Установка на Ubuntu

```bash
cd /opt/scadaprofit
tar -czf /root/scadaprofit-backup-$(date +%F-%H%M).tar.gz .
rm -rf /tmp/cad-json-2.9
mkdir -p /tmp/cad-json-2.9
unzip -oq /home/tech/cad-sketch-converter-json-brain-2.9.zip -d /tmp/cad-json-2.9
cp -a /tmp/cad-json-2.9/cad-sketch-converter-docker-2.9/. /opt/scadaprofit/
cd /opt/scadaprofit
docker compose config --quiet
docker compose build --no-cache app
docker compose up -d --force-recreate app
```

Не запускайте `docker compose down -v`: модель и том Ollama сохраняются. Файл `.env` не входит в архив и остаётся на месте. Существующий `QWEN_MODEL=qwen3-vl:4b-instruct` не меняйте.

## Проверка

```bash
docker compose exec app node -p "require('./package.json').version"
docker compose exec app printenv QWEN_MODEL
curl -s http://127.0.0.1:3001/api/health | python3 -m json.tool
```

Ожидается `2.9.0`, модель `qwen3-vl:4b-instruct`, режим `json-lab-only`.
