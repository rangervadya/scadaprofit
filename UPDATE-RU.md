# Обновление до Two Mask Lab 3.5.0

На Mac:

```bash
scp ~/Downloads/cad-sketch-converter-two-mask-3.5.zip tech@192.168.1.99:/home/tech/
```

На Ubuntu:

```bash
cd /opt/scadaprofit
tar -czf /root/scadaprofit-backup-$(date +%F-%H%M).tar.gz .
rm -rf /tmp/cad-two-mask-3.5 && mkdir -p /tmp/cad-two-mask-3.5
unzip -oq /home/tech/cad-sketch-converter-two-mask-3.5.zip -d /tmp/cad-two-mask-3.5
cp -a /tmp/cad-two-mask-3.5/cad-sketch-converter-two-mask-3.5/. /opt/scadaprofit/
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

Ожидается `3.5.0`. Не используй `docker compose down -v`: Ollama volume не трогаем. `.env` остаётся на месте.

## Стартовый профиль для синей рукописной схемы

- OCR confidence: 5
- OCR scale: 2×; PSM 11; исходное серое изображение
- Отступ: 2 px + 5%
- Минимум OCR-бокса: 2×2 px
- RDP: 1,6 px; скругление: 0%; защита углов: 95%
- Минимальная длина SVG-фрагмента: 5 px
- Разрыв: до 20 px; угловой допуск: 18°

Автомостики длиннее 4 px создаются только в месте, которое покрыто маской удалённого текста/лассо не менее чем на 65%, при хорошем совпадении направления. Проверь их число и отчёт JSON. Если видишь ложные соединения, уменьши максимальный разрыв до 4 px или 0.

## Ровные цифры

Нельзя сделать рукописные цифры печатными одним сглаживанием. Обведи цифру/группу цифр лассо, оставь включённым «Убрать рукопись», введи правильное значение и включи «Печатать». Так SVG будет содержать ровные текстовые символы. Непроверенный OCR не печатается автоматически.
