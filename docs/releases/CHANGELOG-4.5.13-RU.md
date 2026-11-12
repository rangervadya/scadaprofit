# ScadaProfit 4.5.13 — единый frontend

- Объединены два пользовательских интерфейса в одном workspace `frontend/`: основной интерфейс в `public/` и React/TypeScript-модуль заключений в `vdgo/`.
- VDGO React-сборка создаётся в `frontend/public/vdgo/` и обслуживается тем же Node.js приложением на `/vdgo/`.
- Удалён отдельный контейнер `vdgo-frontend`; API/генератор VDGO и PostgreSQL остаются отдельным backend-сервисом.
- Nginx продолжает применять общую проверку workforce-сессии к `/vdgo/`, а `/vdgo/api/`, `/vdgo/legacy`, `/vdgo/generate`, `/vdgo/generate_docx` и `/vdgo/preview` направляет в VDGO backend.
- Упрощены обновление, Compose и Docker-сборка: теперь нужно пересобирать `app` и `vdgo-backend`. Постоянные Docker-тома не меняются.
