# Методичка по путям и структуре `frontend/`

Этот файл описывает, как organised исходный код React-приложения в `frontend/`,
чтобы другой разработчик мог быстро ориентироваться и правильно импортировать модули.

## Структура каталогов

```
frontend/
├── package.json            # зависимостями и скриптами (dev/build/preview)
├── vite.config.ts          # конфиг Vite: root = frontend/, base = '/vdgo/', proxy на /vdgo/api и т.д.
├── tsconfig.json           # компиляция TypeScript (ссылки на app + node)
├── tsconfig.app.json       # строгая проверка src/
├── tsconfig.node.json      # проверка vite.config.ts
├── index.html              # точка входа Vite (<script src="/src/main.tsx">)
├── src/
│   ├── main.tsx            # React.createRoot + <App />
│   ├── App.tsx             # только композиция: состояние, хуки, сборка JSX
│   ├── styles.css          # глобальные CSS-переменные и reset (один файл, без модулей)
│   ├── types.ts            # общие типы: ServiceState, HealthResponse, ReportRun, ReportSection, reportSections
│   ├── utils.ts            # чистыеhelpers: matchesHistory(), formatDate()
│   ├── services/
│   │   └── api.ts          # fetch-хелперы: fetchHealth(), fetchReports() (базовый путь /vdgo)
│   ├── hooks/
│   │   └── useHealthStatus.ts   # опрос статуса сервисов каждые 15с
│   ├── components/
│   │   ├── shell/
│   │   │   ├── Sidebar.tsx      # боковое навигационное меню
│   │   │   └── Topbar.tsx       # поиск, статус сервисов, аватар
│   │   ├── report/
│   │   │   ├── DrawingCanvas.tsx   # SVG-чертеж (был Drawing внутри App.tsx)
│   │   │   ├── ReportTabs.tsx      # вкладки разделов заключения
│   │   │   ├── ToolPanel.tsx       # панель инструментов справа
│   │   │   └── HistoryTable.tsx    # таблица последних отчётов
│   │   └── form/
│   │       └── FileUpload.tsx      # загрузка/удаление эскиза (drag & drop + input)
│   └── ErrorBoundary.tsx          # ловит ошибки рендеринга (чтобы не был белый экран без бэкенда)
├── build/                # компилированный вывод Vite (gitignored, перегенерируется npm run build)
├── public/
│   └── legacy/           #legacy HTML/JS/CSS бэкенда (conclusion.html, dashboard.html, login.html, manual-cad.html, workforce.html и др.)
├── node_modules/
├── package-lock.json
└── README.md
```

## Как импортировать

Все импорты — **относительные**. Path aliases (`@/...`) не настроены, добавлять не нужно.

Примеры из `src/App.tsx`:
```tsx
import { useHealthStatus } from './hooks/useHealthStatus';
import { formatDate } from './utils';
import { Sidebar } from './components/shell/Sidebar';
import { Topbar } from './components/shell/Topbar';
import { DrawingCanvas } from './components/report/DrawingCanvas';
import { ReportTabs } from './components/report/ReportTabs';
import { ToolPanel } from './components/report/ToolPanel';
import { HistoryTable } from './components/report/HistoryTable';
import { FileUpload } from './components/form/FileUpload';
import { reportSections } from './types';
```

Из `src/components/shell/Topbar.tsx` (на уровень вверх, затем вниз):
```tsx
import type { HealthResponse, ReportRun, ServiceState } from '../../types';
import { matchesHistory } from '../../utils';
```

## Где что править

| Задача | Файл | Комментарий |
|--------|------|-------------|
| Типы данных (HealthResponse, ReportRun, ServiceState, reportSections) | `src/types.ts` | Единственный источник типов |
| Чистые функции (formatDate, matchesHistory) | `src/utils.ts` | Без зависимостей от React |
| API-запросы (fetchHealth, fetchReports) | `src/services/api.ts` | Базовый путь `/vdgo` |
| Опрос статуса сервисов (каждые 15 сек) | `src/hooks/useHealthStatus.ts` | Возвращает health, healthState, dbState, reports, refreshStatus |
| Боковое меню | `src/components/shell/Sidebar.tsx` | Принимает `historyActive` |
| Верхняя панель (поиск, статус) | `src/components/shell/Topbar.tsx` | Много пропсов от App |
| SVG-чертеж | `src/components/report/DrawingCanvas.tsx` | Была функция `Drawing` внутри App.tsx |
| Вкладки разделов | `src/components/report/ReportTabs.tsx` | Принимает `sections`, `activeSection`, `progress` |
| Панель инструментов | `src/components/report/ToolPanel.tsx` | Кнопки сравнения, загрузки, масштаб |
| История отчётов | `src/components/report/HistoryTable.tsx` | Таблица последних 3 отчётов |
| Загрузка файла | `src/components/form/FileUpload.tsx` | input + drag&drop |
| Главная композиция | `src/App.tsx` | Состояние, iframe, connectForm, runFormAction, JSX |
| Точка входа | `src/main.tsx` | `React.createRoot(document.getElementById('root')!).render(<App />)` |
| Глобальные стили | `src/styles.css` | CSS-переменные + reset, один файл |
| Vite конфиг (proxy, port, base) | `vite.config.ts` | `base: '/vdgo/'`, проксирует `/vdgo/api*` на бэкенд |
| TypeScript конфиг | `tsconfig.app.json`, `tsconfig.node.json` | strict, noUnusedLocals, verbatimModuleSyntax |

## Скрипты

```bash
# запуск dev-сервера на http://127.0.0.1:5173/vdgo/
npm --prefix frontend run dev

# продакшн-сборка в frontend/build/
npm --prefix frontend run build

# предварительный просмотр сборки
npm --prefix frontend run preview
```

## Важные моменты

1. **Порт 5173** зафиксирован в `vite.config.ts` (`strictPort: true`). Если занят — запустите на другом порту: `npx vite --port 5174`.
2. **Прокси бэкенда** — все запросы `/vdgo/api/*`, `/vdgo/legacy`, `/vdgo/health`, `/vdgo/generate*` проксируются на `http://127.0.0.1:8765` (или `VDGO_BACKEND_URL`). Без запущенного бэкенда эти endpoints будут возвращать 500/ошибку соединения.
3. **`<iframe src="/vdgo/legacy">`** — форма заключения загружается из бэкенда. Если бэкенда нет, iframe пустой, и `App.tsx` работает в режиме без доступа к `contentDocument` (есть null-guards).
4. **Стили** пока в одном глобальном `src/styles.css`. CSS-модули не используются — при добавлении новых стилей именуйте классы уникально (BEM-подобно), чтобы не было конфликтов.
5. **`build/`** — это build-выход Vite, его править вручную не нужно. После `npm run build` файлы появляются автоматически.
6. **ErrorBoundary** — секция с iframe обёрнута в `ErrorBoundary`. Если бэкенд недоступен и форма вызывает ошибку, отображается сообщение вместо белого экрана.

## Как добавить новый компонент

1. Создайте файл в подходящей папке под `src/components/` (например, `src/components/report/NewFeature.tsx`).
2. Экспортируйте命名ованный экспорт: `export function NewFeature() { ... }`.
3. Импортируйте в `src/App.tsx` (или в родительский компонент) с относительным путём.
4. Передайте данные через пропсы, не храните глобальное состояние в компоненте — состояние живет в `App.tsx` или хуках.
