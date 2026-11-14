# Структура единого frontend

```text
frontend/
  index.html                  HTML entry point для Vite
  vite.config.ts              base /vdgo/, outDir public/vdgo
  package.json                Единственный manifest зависимостей frontend
  package-lock.json           Зафиксированные версии npm-зависимостей
  public/                     Статические публичные файлы (robots.txt)
  src/
    main.tsx                  BrowserRouter, auth и проверка ролей
    components/
      layout/                 AppLayout, Sidebar, Topbar
      ui/                     Общие UI-компоненты и иконки
      GraphView.tsx           SVG-предпросмотр схем
    lib/                      API-клиент, auth, health, форматирование и типы
    pages/                    Все пользовательские разделы
    styles/                   Токены, layout, компоненты и страницы
```

## Поток запросов

1. Браузер загружает один SPA по `/vdgo/`; `/` перенаправляет на этот адрес.
2. `AuthProvider` проверяет сессию через основной API `/api/auth/me`.
3. `RequireAuth`, `RequireRole` и `Sidebar` управляют доступностью экранов; авторизация и права API дополнительно enforced на сервере.
4. Рабочие процессы и задания используют основной Node.js backend (`/api/workforce/*`).
5. Технические заключения используют отдельный VDGO backend через `/vdgo/api/*` и `/vdgo/generate*`; Nginx проверяет сессию/роль перед проксированием.

## Сборка

- `base: '/vdgo/'`.
- `outDir: public/vdgo`.
- React Router использует `import.meta.env.BASE_URL` как `basename`.
- Страницы загружаются через `React.lazy`; Vite делит vendor/router и страницы на чанки.
- Сгенерированная папка `public/vdgo/` не хранится в Git: Docker собирает её на этапе создания образа.

Старые многостраничные файлы оставлены только как fixture для регрессионных тестов в `tests/fixtures/legacy-frontend/`. Они не раздаются и не участвуют в рабочем интерфейсе.
