- [4.5.20 — исправление импорта JSON и переноса принятых материалов в существующие поля заключения](CHANGELOG-4.5.20-RU.md)

# ScadaProfit 4.5.17

- Исправлена Docker-сборка единого frontend: финальный build-stage теперь включает исходники frontend, которые читает `repository-layout.test.js`.
- Сохранены все 31 Node.js regression-проверки в обязательном `npm run check`; тесты не отключались и не обходились.
- Версия backend package и корневой `VERSION` синхронизированы: 4.5.17.
- В runtime-слой Docker копируются `frontend/src`, `frontend/index.html` и `frontend/vite.config.ts`, необходимые для обязательных проверок структуры; статический UI по-прежнему обслуживается только из `frontend/public`.
- Исправлены две ошибки Docker `npm run check`: тесты больше не получают `ENOENT` для `/app/frontend/index.html` и `/app/frontend/src/main.tsx`.

# ScadaProfit 4.5.16

См. [изменения 4.5.16](CHANGELOG-4.5.16-RU.md).

# История изменений ScadaProfit

- [4.5.17 — исправление Docker-проверок frontend](CHANGELOG-4.5.17-RU.md)

- [4.5.16 — исправление сборки React frontend](CHANGELOG-4.5.16-RU.md)

- [4.5.16 — замена единого frontend новой React-оболочкой](CHANGELOG-4.5.16-RU.md)
- [4.5.13 — первое объединение frontend](CHANGELOG-4.5.13-RU.md)

- [4.5.12 — реорганизация GitHub-репозитория](CHANGELOG-4.5.12-RU.md)
- [4.5.11 — адресные папки уведомлений и единый перенос в заключение](CHANGELOG-4.5.11-RU.md)
