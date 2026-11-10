# Установка ScadaProfit 4.3.52

1. Распакуйте архив во временную папку.
2. Скопируйте содержимое в основную папку проекта, заменяя файлы приложения.
3. Не удаляйте свой `.git`, `.env`, Docker volumes и постоянные каталоги данных. В архиве они намеренно не поставляются.
4. Проверьте изменения и отправьте их на GitHub:

```bash
git status
git add -A
git commit -m "ScadaProfit 4.3.52: professional CAD sheet layout"
git push
```

5. На сервере:

```bash
cd /путь/к/проекту
git pull --ff-only
docker compose config --services
docker compose build app vdgo-backend
docker compose up -d --no-deps app vdgo-backend
docker compose ps
docker compose logs --tail=100 app vdgo-backend
```

Если `git status` на сервере показывает локальные изменения, сначала сохраните их; не используйте `git reset --hard`.
