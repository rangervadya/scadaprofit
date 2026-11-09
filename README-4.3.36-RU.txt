SCADAPROFIT 4.3.36 — MOSS Vision route parsing and diagnostics

Назначение:
Последний журнал показал MOSS Vision raw=13, accepted=0, invalid=13. Эта версия
расширяет поддержку форматов координат и добавляет безопасный вывод структуры
отклонённых объектов (ключи и типы, без координат и текста схемы).

Файлы для замены в корне проекта:
- moss_ai.py
- package.json
- tests/test_moss_ai.py

Новые документы:
- CHANGELOG-4.3.36-RU.md
- UPDATE-MANIFEST-4.3.36.txt
- README-4.3.36-RU.txt

Установка на Mac:
1. Распакуйте архив в корень cad-sketch-converter-docker-2.2.
2. Подтвердите замену трёх указанных файлов.
3. Выполните npm run check.
4. Выполните git diff --check и git status --short.
5. Не удаляйте и не добавляйте api.txt.
6. Добавляйте в Git только файлы из UPDATE-MANIFEST-4.3.36.txt.

После успешного push обновление сервера:
cd /opt/scadaprofit
git pull --ff-only origin main
sudo docker compose config --quiet
sudo docker compose build app
# Только если сборка завершилась успешно:
sudo docker compose up -d --no-deps app
sudo docker compose ps

Изменения касаются MOSS-парсера, его Python-тестов и версии пакета.
Не изменяются server.js, moss-env-boot.js, processor.py, VDGO, PostgreSQL,
Docker volumes, compose.yaml, Nginx и другие сервисы.

Важно:
Невозможно гарантировать, что новый парсер уже понимает фактический формат всех
13 объектов предыдущего ответа MOSS: сам ответ модели в журнале не сохранялся.
Если после обновления часть маршрутов останется invalid, журнал теперь покажет
сводку ключей и типов полей отклонённых объектов, не раскрывая координаты или
содержимое чертежа. По ней можно будет сделать точечную адаптацию формата.
