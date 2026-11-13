import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const file = relative => path.join(root, relative);

test('repository layout keeps the SPA runtime and legacy sources in sync', async () => {
  const required = [
    'compose.yaml',
    'backend/package.json',
    'backend/api/server.js',
    'backend/api/workforce-system.js',
    'backend/api/manual-cad-core.js',
    'backend/engine/processor.py',
    'backend/engine/clean_layout.py',
    'frontend/package.json',
    'frontend/package-lock.json',
    'frontend/index.html',
    'frontend/src/main.tsx',
    'frontend/vite.config.ts',
    'frontend/src/pages/ConclusionPage.tsx',
    'frontend/src/pages/SchemesPage.tsx',
    'frontend/src/pages/TeamPage.tsx',
    'frontend/src/pages/CadEditorPage.tsx',
    'legacy/index.html',
    'legacy/workforce.html',
    'legacy/conclusion.html',
    'services/vdgo/backend/app.py',
    'services/vdgo/backend/templates/index.html',
    'infra/docker/app.Dockerfile',
    'infra/nginx/nginx-unified.conf',
  ];
  for (const relative of required) await access(file(relative));

  const server = await readFile(file('backend/api/server.js'), 'utf8');
  assert.match(server, /\.\.\/\.\.\/frontend\/public/);
  assert.match(server, /\.\.\/engine\/processor\.py/);
  assert.match(server, /frontend\/public\/vdgo/);
  assert.ok(server.includes("app.get(/^\\/vdgo"));
  assert.ok(server.includes("frontend/public/vdgo"));

  const compose = await readFile(file('compose.yaml'), 'utf8');
  assert.match(compose, /dockerfile: infra\/docker\/app\.Dockerfile/);
  assert.match(compose, /context: \.\/services\/vdgo\/backend/);
  assert.doesNotMatch(compose, /vdgo-frontend|services\/vdgo\/frontend/);

  const frontendPackage = JSON.parse(await readFile(file('frontend/package.json'), 'utf8'));
  assert.equal(frontendPackage.name, 'scadaprofit-unified-frontend');
  assert.match(frontendPackage.scripts.build, /tsc -p tsconfig\.app\.json/);
  assert.match(frontendPackage.dependencies['react-router-dom'], /\^?\d+\./);

  const vite = await readFile(file('frontend/vite.config.ts'), 'utf8');
  assert.match(vite, /outDir: path\.join\(appRoot, 'public\/vdgo'\)/);
  assert.match(vite, /base: '\/vdgo\/'/);
  assert.match(vite, /'\/api': \{ target: mainBackend/);

  const nginx = await readFile(file('infra/nginx/nginx-unified.conf'), 'utf8');
  assert.match(nginx, /location \/vdgo\//);
  assert.match(nginx, /proxy_pass http:\/\/app:3000;/);
  assert.doesNotMatch(nginx, /vdgo-frontend:4173/);

  const dockerfile = await readFile(file('infra/docker/app.Dockerfile'), 'utf8');
  assert.match(dockerfile, /FROM node:22-bookworm-slim AS frontend-build/);
  assert.match(dockerfile, /COPY frontend\/ \.\//);
  assert.match(dockerfile, /COPY --from=frontend-build \/frontend\/public\/vdgo\//);
});