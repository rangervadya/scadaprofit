# ScadaProfit 4.5.6 — окончательное устранение 500-символьной проверки

## Что изменено

- Поле `workforce_schemes_json` распознаётся по нормализованному имени: без учёта регистра и крайних пробелов; поддерживаются распространённые суффикс `[]` и wrapper `form[...]`.
- Multipart-парсер приводит это поле к каноническому имени до валидации и подготовки схем.
- Содержимое JSON по-прежнему проходит самостоятельную строгую проверку размера, JSON-структуры, base64 и PNG; прочие поля сохраняют обычные лимиты длины.
- Backend получил release fingerprint `4.5.6 / 5.3.8` и новый Docker image tag.
- Исправлена первая инструкция обновления: она пересобирает и принудительно пересоздаёт `vdgo-backend`, `app` и `vdgo-frontend`, а не только основной `app`.

## Обновление

Выполнять из корневой папки проекта (рядом с `compose.yaml`):

```bash
docker compose build --no-cache vdgo-backend app vdgo-frontend
docker compose up -d --no-deps --force-recreate vdgo-backend app vdgo-frontend
docker compose restart gateway
docker compose exec vdgo-backend python -c "import app; print(app.APP_RELEASE, app.BACKEND_IMAGE_VERSION)"
```

Последняя команда должна вывести `4.5.6 5.3.8`. Постоянные тома `cad_jobs` и `vdgo_postgres_data` не удалять.
