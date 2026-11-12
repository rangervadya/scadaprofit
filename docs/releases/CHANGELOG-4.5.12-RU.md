# ScadaProfit 4.5.12 — реорганизация репозитория

## Что изменилось

- Основной интерфейс вынесен в `frontend/public/`.
- Node.js API и workforce-модуль вынесены в `backend/api/`; Python-движок и связанные алгоритмы — в `backend/engine/`.
- VDGO оставлен отдельным сервисом в `services/vdgo/{frontend,backend}/`.
- Dockerfile основного приложения, Nginx и скрипты обслуживания вынесены в `infra/`.
- Тесты сгруппированы по среде выполнения в `tests/node/`, `tests/python/` и `tests/vdgo/`.
- Руководства, диагностика и история релизов перемещены в `docs/`.
- В корне оставлены только README, Compose-файл, переменные окружения, Git/Docker ignore, Makefile и версия.

## Поведение приложения

Это структурный релиз: функции распознавания, CAD, кабинеты слесаря/приёмщика/руководителя, адресные папки уведомлений и перенос всей папки в заключение не менялись.

## Основные команды

```bash
docker compose config --quiet
docker compose up -d --build
npm --prefix backend run check
PYTHONPATH=backend python -m unittest discover -s tests/vdgo -p 'test_*.py' -v
```

