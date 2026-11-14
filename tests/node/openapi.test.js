// Контрактный тест: пути из docs/openapi.yaml должны присутствовать в коде.
// Не требует запущенного сервера — проверяет статически по исходникам.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');
const OPENAPI = join(ROOT, 'docs/openapi.yaml');

// Грубый парсер путей из openapi.yaml без внешних зависимостей:
// строки вида "  /api/...:" на верхнем уровне paths.
function extractPaths(text) {
  const paths = [];
  let inPaths = false;
  for (const raw of text.split('\n')) {
    if (/^paths:\s*$/.test(raw)) {
      inPaths = true;
      continue;
    }
    if (inPaths && /^components:\s*$/.test(raw)) {
      inPaths = false;
      continue;
    }
    if (!inPaths) continue;
    const m = /^ {2}(\/[\w/{}.-]+):\s*$/.exec(raw);
    if (m) paths.push(m[1]);
  }
  return paths;
}

function collectRoutesFrom(src, prefix = '') {
  // Сопоставляем маршруты вида routes.post('/api/auth/setup', ...) и
  // app.get('/api/...') — оба варианта.
  const routes = new Set();
  for (const m of src.matchAll(/(?:app|routes|router)\.(get|post|put|delete|patch)\(\s*[`'"]([^`'"]+)[`'"]/g)) {
    const method = m[1].toUpperCase();
    const full = m[2].startsWith('/') ? m[2] : prefix + m[2];
    routes.add(`${method} ${full}`);
  }
  return routes;
}

function collectServerRoutes(src) {
  return collectRoutesFrom(src);
}

test('openapi: файл существует и содержит пути', () => {
  assert.ok(existsSync(OPENAPI), 'docs/openapi.yaml отсутствует');
  const text = readFileSync(OPENAPI, 'utf8');
  const paths = extractPaths(text);
  assert.ok(paths.length > 0, 'не найдено ни одного пути в openapi');
  // Проверяем наличие ключевых путей
  for (const must of ['/api/health', '/api/readyz', '/api/auth/login', '/api/analyze', '/vdgo/generate']) {
    assert.ok(paths.includes(must), `в openapi отсутствует путь ${must}`);
  }
});

test('openapi: /api/* пути присутствуют в server.js', () => {
  const serverSrc = readFileSync(join(ROOT, 'services/ollama/api/server.js'), 'utf8');
  const workforceSrc = readFileSync(join(ROOT, 'services/ollama/api/workforce-system.js'), 'utf8');
  const routes = new Set([...collectServerRoutes(serverSrc), ...collectRoutesFrom(workforceSrc)]);
  const openapi = readFileSync(OPENAPI, 'utf8');
  const paths = extractPaths(openapi).filter((p) => p.startsWith('/api/'));

  for (const p of paths) {
    // /api/analyze — проксируется в vdgo-backend, не обрабатывается server.js напрямую
    if (p === '/api/analyze') continue;
    const expressPath = p.replace(/\{([^}]+)\}/g, (_, name) => `:${name}`);
    const found = [...routes].some((r) => r.endsWith(` ${expressPath}`));
    assert.ok(found, `путь ${p} из openapi не найден как маршрут (ожидалось ${expressPath})`);
  }
});

test('openapi: /vdgo/* пути присутствуют в nginx-конфиге', () => {
  const nginxSrc = readFileSync(join(ROOT, 'infra/nginx/nginx-unified.conf'), 'utf8');
  const openapi = readFileSync(OPENAPI, 'utf8');
  const paths = extractPaths(openapi).filter((p) => p.startsWith('/vdgo/'));

  // nginx использует regex location ~ ^/vdgo/(generate|generate_docx|preview)$
  // Проверяем, что каждый путь либо встречается буквально, либо покрыт regex-ом.
  const regexBlocks = [...nginxSrc.matchAll(/location ~ \^?([^\s{]+)\{?/g)].map((m) => m[1]);

  for (const p of paths) {
    const literal = nginxSrc.includes(p) || nginxSrc.includes(p + '$');
    const regexMatch = regexBlocks.some((pattern) => {
      try {
        return new RegExp(pattern).test(p);
      } catch {
        return false;
      }
    });
    assert.ok(literal || regexMatch, `путь ${p} из openapi не найден в nginx-конфиге`);
  }
});
