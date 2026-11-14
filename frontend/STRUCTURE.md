# Структура SPA

```
frontend/
  index.html
  vite.config.ts
  public/
    robots.txt
    vdgo/                       — артефакты сборки (не коммитить)
  src/
    main.tsx                    — роутер, AuthProvider, ToastProvider, lazy-страницы
    styles/
      index.css                 — подключение стилей
      tokens.css                — переменные темы
      layout.css                — app shell, sidebar (collapse), topbar
      components.css            — кнопки, карточки, формы, таблицы, модалки
      pages.css                 — стили страниц
    lib/
      api.ts                    — типизированный клиент API и загрузка файлов
      auth.tsx                  — контекст сессии (login/logout/refresh)
      health.ts                 — состояние сервисов
      format.ts                 — даты, байты, статусы, множественные числа
      types.ts                  — доменные типы
    components/
      layout/
        AppLayout.tsx           — shell + Outlet
        Sidebar.tsx             — навигация, сворачивание, аккаунт
        Topbar.tsx              — поиск, статус сервисов, настройки
      ui/
        Icon.tsx                — SVG-иконки, BrandMark
        index.tsx               — Button, Card, Badge, Field, Modal, Toast, Empty
      GraphView.tsx             — SVG-оверлей схемы (рёбра, узлы, пересечения)
    pages/
      LoginPage.tsx
      DashboardPage.tsx
      ConclusionPage.tsx
      conclusion/
        schema.ts               — разделы и поля формы
        useConclusionForm.ts    — состояние, черновик, FormData
        ConclusionSections.tsx  — рендер секций (поля, УЗТ, дефекты, арматура, фото, материалы)
      SchemesPage.tsx
      SchemeDetailPage.tsx
      ArchivePage.tsx
      TeamPage.tsx
      CadPage.tsx
      CadEditorPage.tsx
      SettingsPage.tsx
```

## Поток данных

1. `main.tsx` создаёт `BrowserRouter` с `basename` из `import.meta.env.BASE_URL`
   (`/vdgo/`).
2. `AuthProvider` проверяет `/api/auth/me`; `RequireAuth` пускает только с
   сессией.
3. Страницы ходят в API через `lib/api.ts`; для пользовательских путей
   используются `react-router-dom` (`NavLink`, `useNavigate`, `useSearchParams`).
4. Форма заключения собирает `FormData` и отправляет его напрямую в
   `/vdgo/generate`, `/vdgo/generate_docx`, `/vdgo/preview`.

## Сборка

- `base: '/vdgo/'`, `outDir: public/vdgo`.
- Страницы загружаются через `React.lazy`; `Suspense` показывает индикатор.
- `manualChunks` делит React, React Router и vendor.
- CSS разбит по слоям: токены → layout → компоненты → страницы.

Старые многостраничные HTML/JS/CSS лежат в `legacy/` и используются только как
источник поведения и для регрессионных тестов. В рантайме они не раздаются.