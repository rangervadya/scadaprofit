import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const file = relative => path.join(root, relative);

const read = relative => readFile(file(relative), 'utf8');

test('one React frontend is the active UI; backend and document services stay separate', async () => {
  const required = [
    'compose.yaml',
    'backend/package.json',
    'backend/api/server.js',
    'backend/api/workforce-system.js',
    'backend/engine/processor.py',
    'frontend/package.json',
    'frontend/package-lock.json',
    'frontend/index.html',
    'frontend/vite.config.ts',
    'frontend/src/main.tsx',
    'frontend/src/pages/TeamPage.tsx',
    'frontend/src/pages/ConclusionPage.tsx',
    'frontend/public/robots.txt',
    'tests/fixtures/legacy-frontend/public/manual-cad.js',
    'services/vdgo/backend/app.py',
    'services/vdgo/backend/templates/index.html',
    'infra/docker/app.Dockerfile',
    'infra/nginx/nginx-unified.conf',
  ];
  for (const relative of required) await access(file(relative));

  const server = await read('backend/api/server.js');
  assert.match(server, /frontend\/public/);
  assert.match(server, /frontend\/public\/vdgo/);
  assert.match(server, /redirect\(308, '\/vdgo\/'\)/);

  const auth = await read('backend/api/workforce-system.js');
  assert.match(auth, /pathname\.startsWith\('\/vdgo\/'\)/);
  assert.match(auth, /redirect\('\/vdgo\/login'\)/);

  const compose = await read('compose.yaml');
  assert.match(compose, /dockerfile: infra\/docker\/app\.Dockerfile/);
  assert.match(compose, /context: \.\/services\/vdgo\/backend/);
  assert.doesNotMatch(compose, /vdgo-frontend|services\/vdgo\/frontend/);

  const frontendPackage = JSON.parse(await read('frontend/package.json'));
  assert.equal(frontendPackage.name, 'scadaprofit-unified-frontend');
  assert.match(frontendPackage.scripts.build, /vite build/);

  const vite = await read('frontend/vite.config.ts');
  assert.match(vite, /base: '\/vdgo\/'/);
  assert.match(vite, /outDir: path\.join\(appRoot, 'public\/vdgo'\)/);
  assert.match(vite, /VDGO_BACKEND_URL/);

  const appSource = await read('frontend/src/main.tsx');
  assert.match(appSource, /BrowserRouter basename=\{import\.meta\.env\.BASE_URL\}/);
  assert.match(appSource, /RequireRole/);

  const nginx = await read('infra/nginx/nginx-unified.conf');
  assert.match(nginx, /location \/vdgo\/api\//);
  assert.match(nginx, /proxy_pass http:\/\/app:3000/);
  assert.doesNotMatch(nginx, /vdgo-frontend:4173/);
  const staticVdgoBlock = nginx.match(/location \/vdgo\/ \{([\s\S]*?)\n    \}/)?.[1] || '';
  assert.ok(staticVdgoBlock, 'static SPA location exists');
  assert.doesNotMatch(staticVdgoBlock, /auth_request/);
  assert.match(nginx, /location \/vdgo\/api\/ \{\n        auth_request/);

  const dockerfile = await read('infra/docker/app.Dockerfile');
  assert.match(dockerfile, /COPY frontend\/ \.\//);
  assert.doesNotMatch(dockerfile, /COPY frontend\/vdgo/);
  assert.match(dockerfile, /npm run build/);
  assert.match(dockerfile, /COPY --from=frontend-build \/frontend\/public\/vdgo\//);
});

test('the replacement frontend exposes the project workflows and address-folder transfer', async () => {
  const source = await read('frontend/src/main.tsx');
  const team = await read('frontend/src/pages/TeamPage.tsx');
  const conclusion = await read('frontend/src/pages/ConclusionPage.tsx');
  const api = await read('frontend/src/lib/api.ts');
  const sidebar = await read('frontend/src/components/layout/Sidebar.tsx');
  const topbar = await read('frontend/src/components/layout/Topbar.tsx');
  const dashboard = await read('frontend/src/pages/DashboardPage.tsx');
  const login = await read('frontend/src/pages/LoginPage.tsx');
  assert.match(source, /DashboardPage/);
  assert.match(source, /ConclusionPage/);
  assert.match(source, /CadEditorPage/);
  assert.match(source, /const STAFF_ROLES: SessionUser\['role'\]\[\] = \['receiver', 'supervisor', 'developer'\]/);
  assert.match(sidebar, /roles: STAFF_ROLES/);
  assert.match(topbar, /const isFitter = user\?\.role === 'fitter'/);
  assert.match(topbar, /!isFitter \?/);
  assert.match(sidebar, /to: '\/team'.*label: 'Команда'/);
  assert.match(dashboard, /if \(!isFitter\) \{[\s\S]*healthApi\.reports\(\)/);
  assert.doesNotMatch(login, /Выбрать аккаунт|Выберите роль|Первичная настройка системы/);
  assert.match(team, /Добавить папку в заключение|Папка добавлена в заключение/);
  assert.match(team, /reviewReport/);
  assert.match(team, /reviewDefect/);
  assert.match(api, /\/workforce\/tasks\/\$\{encodeURIComponent\(taskId\)\}\/conclusion/);
  assert.match(conclusion, /buildWorkforceSchemes/);
  assert.match(conclusion, /buildDefectPhotos/);
});
