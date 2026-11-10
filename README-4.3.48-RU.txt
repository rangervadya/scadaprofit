ScadaProfit 4.3.48

В обновлении улучшена логика генерации CAD-эскизов и сохранены исправления скачивания PDF/DOCX в VDGO.

Обновление через GitHub:
1. На рабочем компьютере добавьте изменения в основной репозиторий и отправьте их:
   git add -A
   git commit -m "ScadaProfit 4.3.48: improve CAD sketch reconstruction"
   git push

2. На сервере из основной папки проекта:
   git pull --ff-only
   docker compose config --services
   docker compose build app vdgo-backend
   docker compose up -d --no-deps app vdgo-backend

3. Проверка:
   docker compose ps
   docker compose logs --tail=100 app vdgo-backend

Если у вас основная ветка называется не текущей настроенной upstream-веткой, используйте обычный git pull с именем вашей ветки.

Не выполняйте docker compose down и не удаляйте volumes базы данных для этого обновления.

Подробности изменений: CHANGELOG-4.3.48-RU.md
