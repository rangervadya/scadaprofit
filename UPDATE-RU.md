# Обновление ScadaProfit до 4.3.22

Добавлен чистовой профиль LPGCad R1, A4/A3, адресный блок, легенда, подписи и отдельный блок нижних групп стояков, задаваемых оператором. SVG/DXF остаются редактируемыми. Единый комплект из двух приложений сохранён: ScadaProfit `/` и VDGO `/vdgo/`.

См. `UPGRADE-GIT-4.3.22-RU.md`. Не удаляйте `vdgo/`, `compose.yaml`, `nginx-unified.conf`, `.env`, PostgreSQL и Docker volumes. Не выполняйте `docker compose down -v`.
