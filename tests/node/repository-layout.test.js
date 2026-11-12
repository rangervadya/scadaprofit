import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const file = relative => path.join(root, relative);

test('repository layout keeps the main runtime and unified frontend paths in sync', async () => {
  const required = [
    'compose.yaml',
    'backend/package.json',
    'backend/api/server.js',
    'backend/api/workforce-system.js',
    'backend/engine/processor.py',
    'backend/engine/clean_layout.py',
    'frontend/package.json',
    'frontend/package-lock.json',
    'frontend/public/index.html',
    'frontend/vdgo/index.html',
    'frontend/vdgo/src/main.tsx',
    'frontend/vdgo/vite.config.ts',
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

  const compose = await readFile(file('compose.yaml'), 'utf8');
  assert.match(compose, /dockerfile: infra\/docker\/app\.Dockerfile/);
  assert.match(compose, /context: \.\/services\/vdgo\/backend/);
  assert.doesNotMatch(compose, /vdgo-frontend|services\/vdgo\/frontend/);

  const frontendPackage = JSON.parse(await readFile(file('frontend/package.json'), 'utf8'));
  assert.equal(frontendPackage.name, 'scadaprofit-unified-frontend');
  assert.match(frontendPackage.scripts.build, /tsc -p vdgo\/tsconfig\.app\.json/);

  const vite = await readFile(file('frontend/vdgo/vite.config.ts'), 'utf8');
  assert.match(vite, /outDir: path\.join\(workspaceRoot, 'public', 'vdgo'\)/);
  assert.match(vite, /base: '\/vdgo\/'/);

  const nginx = await readFile(file('infra/nginx/nginx-unified.conf'), 'utf8');
  assert.match(nginx, /location \/vdgo\//);
  assert.match(nginx, /proxy_pass http:\/\/app:3000;/);
  assert.doesNotMatch(nginx, /vdgo-frontend:4173/);

  const dockerfile = await readFile(file('infra/docker/app.Dockerfile'), 'utf8');
  assert.match(dockerfile, /FROM node:22-bookworm-slim AS frontend-build/);
  assert.match(dockerfile, /COPY --from=frontend-build \/frontend\/public\/vdgo\//);
});
