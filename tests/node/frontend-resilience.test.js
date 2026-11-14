import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (relativePath) => readFile(new URL(`../../${relativePath}`, import.meta.url), 'utf8');

test('render failures fall back to a usable screen instead of a blank page', async () => {
  const boundary = await read('frontend/src/components/ErrorBoundary.tsx');
  assert.match(boundary, /getDerivedStateFromError/);
  assert.match(boundary, /componentDidCatch/);
  assert.match(boundary, /role="alert"/);
  assert.match(boundary, /window\.location\.reload/);

  const main = await read('frontend/src/main.tsx');
  assert.match(main, /import \{ ErrorBoundary \} from '\.\/components\/ErrorBoundary'/);
  assert.match(main, /<ErrorBoundary>\s*<App \/>\s*<\/ErrorBoundary>/);
});

test('transport failures become a readable message, not a raw TypeError', async () => {
  const api = await read('frontend/src/lib/api.ts');
  assert.match(api, /NETWORK_ERROR = 'Нет связи с сервером/);
  // Every fetch call site must be wrapped, otherwise the browser surfaces
  // "Failed to fetch" instead of the localized hint.
  const fetchCalls = api.match(/await fetch\(/g) || [];
  const guardedCalls = api.match(/try \{\s*\n\s*response = await fetch\(/g) || [];
  assert.ok(fetchCalls.length >= 4, `expected the client to fetch in several places, found ${fetchCalls.length}`);
  assert.equal(
    guardedCalls.length,
    fetchCalls.length,
    'every awaited fetch must be wrapped in try/catch so transport errors stay localized',
  );
});

test('server errors carry the request id the backend logs', async () => {
  const api = await read('frontend/src/lib/api.ts');
  assert.match(api, /requestId: string \| null/);
  assert.match(api, /response\.headers\.get\('x-request-id'\)/);
  assert.match(api, /· запрос \$\{requestId\.slice\(0, 8\)\}/);
  // The id is only useful if it is attached to the thrown error.
  assert.match(api, /throw toApiError\(payload, response, 0\)/);
  assert.match(api, /response\.status, requestId\)/);
});

test('toasts are dismissible, capped and announced with the right role', async () => {
  const ui = await read('frontend/src/components/ui/index.tsx');
  assert.match(ui, /const MAX_TOASTS = 4/);
  assert.match(ui, /next\.slice\(-MAX_TOASTS\)/);
  assert.match(ui, /role=\{toast\.tone === 'error' \? 'alert' : 'status'\}/);
  assert.match(ui, /aria-label="Закрыть уведомление"/);
  assert.match(ui, /tone === 'error' \? 9000 : 5200/);
  // Timers must be released, otherwise a dismissed toast still fires setState.
  assert.match(ui, /window\.clearTimeout\(timer\)/);
});

test('toast close control has styles and stays keyboard reachable', async () => {
  const css = await read('frontend/src/styles/components.css');
  assert.match(css, /\.toast__close \{/);
  assert.match(css, /\.toast__close:focus-visible/);
  assert.match(css, /\.toast__text \{/);
  assert.match(css, /\.error-screen \{/);
});