# Структура SPA

```
frontend/
  index.html
  vite.config.ts
  src/
    main.tsx                     — роутер и провайдеры
    styles/
      index.css                  — подключение стилей
      tokens.css                 — переменные темы
      layout.css                 — shell, sidebar, topbar
      components.css             — кнопки, карточки, формы, таблицы
      pages.css                  — стили страниц
    lib/
      api.ts                     — типизированный клиент API
      auth.tsx                   — контекст сессии
      health.ts                  — состояние сервисов
      format.ts                  — форматирование дат и статусов
      types.ts                   — доменные типы
    components/
      layout/                    — AppLayout, Sidebar, Topbar
      ui/                        — Icon, Button, Card, Modal, Toast и др.
      GraphView.tsx              — SVG-оверлей схемы
    pages/
      LoginPage.tsx
      DashboardPage.tsx
      ConclusionPage.tsx
      conclusion/                — схема полей и секции формы
      SchemesPage.tsx
      SchemeDetailPage.tsx
      ArchivePage.tsx
      TeamPage.tsx
      CadPage.tsx
      CadEditorPage.tsx
      SettingsPage.tsx
```

Старые многостраничные HTML/JS/CSS лежат в `legacy/` и используются только как
источник поведения иRegression-тестами. В рантайме они не раздаются.