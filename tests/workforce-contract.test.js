import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('login screen requires credentials and does not offer role/account selection', async () => {
  const html = await read('public/login.html');
  const js = await read('public/login.js');
  assert.match(html, /name="username"[^>]*required/);
  assert.match(html, /name="password"[^>]*type="password"[^>]*required/);
  assert.doesNotMatch(html, /<select[^>]*(?:role|account|user)/i);
  assert.match(js, /username/);
  assert.match(js, /password/);
  assert.match(js, /\/api\/auth\/login/);
});

test('fitter workflow is manual-button tracking and accepts only a hand sketch', async () => {
  const html = await read('public/workforce.html');
  const js = await read('public/workforce.js');
  const backend = await read('workforce-system.js');
  assert.match(html, /Трекер состоит только из кнопок этапов работы/);
  assert.match(js, /Начать обход дома/);
  assert.match(js, /Отметить: прошёл этот дом/);
  assert.match(js, /Отметить: пришёл в офис/);
  assert.match(js, /name="sketch"/);
  assert.doesNotMatch(js, /navigator\.geolocation|\/api\/workforce\/location/);
  assert.doesNotMatch(backend, /routes\.post\('\/api\/workforce\/location/);
  assert.match(backend, /upload\.fields\(\[\{ name: 'sketch', maxCount: 1 \}\]\)/);
  assert.match(backend, /Фотографии объекта не принимаются/);
});

test('supervisors can create fitter and receiver accounts with generated credentials', async () => {
  const html = await read('public/workforce.html');
  const js = await read('public/workforce.js');
  const backend = await read('workforce-system.js');
  assert.match(html, /Создать аккаунт и выдать данные/);
  assert.match(js, /autoGenerate: true/);
  assert.match(js, /createdCredentials/);
  assert.match(backend, /routes\.post\('\/api\/workforce\/users'/);
  assert.match(backend, /\['fitter', 'receiver'\]\.includes\(role\)/);
  assert.match(backend, /credentials: \{ username, password, generated: autoGenerate \}/);
});

test('receiver can view generated CAD preview and transfer it into the conclusion section', async () => {
  const js = await read('public/workforce.js');
  const conclusion = await read('public/conclusion-workforce.js');
  const html = await read('public/conclusion.html');
  const backend = await read('workforce-system.js');
  const cadHtml = await read('public/manual-cad.html');
  const cadJs = await read('public/manual-cad.js');
  const server = await read('server.js');
  assert.match(cadHtml, /id="addToConclusionBtn"/);
  assert.ok(cadJs.includes('/api/workforce/reports/${encodeURIComponent(reportId)}/conclusion'));
  assert.match(server, /project\.sourceReportId = workforceReportId/);
  assert.match(cadJs, /К уведомлению приёмщика/);
  assert.match(backend, /manualCadProjectId/);
  assert.match(backend, /manualCadBase \? `\$\{manualCadBase\}\/preview\.svg`/);
  assert.match(js, /Результат автоматического преобразования в CAD/);
  assert.match(js, /addToConclusionBtn/);
  assert.match(js, /\/api\/workforce\/reports\/\$\{encodeURIComponent\(report\.id\)\}\/conclusion/);
  assert.match(conclusion, /\/api\/workforce\/conclusion/);
  assert.match(conclusion, /schemeSvgUrl/);
  assert.match(backend, /clean\.svg/);
  assert.match(html, /workforceConclusionSection/);
  assert.match(backend, /routes\.post\('\/api\/workforce\/reports\/:id\/conclusion'/);
  assert.match(backend, /routes\.get\('\/api\/workforce\/conclusion'/);
});

test('supervisors have an employee credential directory with names and one-time password reset', async () => {
  const html = await read('public/workforce.html');
  const js = await read('public/workforce.js');
  const backend = await read('workforce-system.js');
  assert.match(html, /id="credentialsSection"/);
  assert.match(html, /База логинов и паролей/);
  assert.match(html, /credentialDatabase/);
  assert.match(js, /data-reset-user/);
  assert.match(js, /data-copy-user/);
  assert.match(js, /firstName/);
  assert.match(js, /lastName/);
  assert.match(backend, /routes\.post\('\/api\/workforce\/users\/:id\/reset-password'/);
  assert.match(backend, /\['fitter', 'receiver'\]\.includes\(user\.role\)/);
  assert.match(backend, /sessions = sessions\.filter\(session => session\.userId !== user\.id\)/);
  assert.match(backend, /credentials: \{ username: user\.username, password, reset: true \}/);
  const publicUserBody = backend.slice(backend.indexOf('function publicUser'), backend.indexOf('function tokenHash'));
  assert.doesNotMatch(publicUserBody, /passwordHash/);
});

test('receiver keeps access to the editable CAD editor and save API', async () => {
  const backend = await read('workforce-system.js');
  const server = await read('server.js');
  const authMiddleware = backend.slice(backend.indexOf('async function authMiddleware'), backend.indexOf("const routes ="));
  const cadSaveRoute = server.slice(server.indexOf("app.put('/api/manual-cad/projects/:id'"), server.indexOf("app.post('/api/manual-cad/projects/:id/source'"));
  assert.match(authMiddleware, /req\.user\.role === 'fitter'/);
  assert.doesNotMatch(authMiddleware, /req\.user\.role === 'receiver'/);
  assert.match(server, /\['receiver', 'supervisor', 'developer'\]\.includes\(req\.user\?\.role\)/);
  assert.match(cadSaveRoute, /normalizeManualCadProject/);
  assert.match(cadSaveRoute, /manualEditRevision/);
  assert.doesNotMatch(cadSaveRoute, /requireRoles|role !== 'developer'/);
});

test('manual conclusion form remains available and generated schemes have an explicit insert button', async () => {
  const html = await read('public/conclusion.html');
  const js = await read('public/workforce.js');
  const index = await read('public/index.html');
  assert.match(index, /href="\/conclusion\.html"[^>]*>[\s\S]*?<span>Заключение<\/span>/);
  assert.match(html, /iframe class="conclusion-frame" src="\/vdgo\/legacy"/);
  assert.match(html, /href="\/conclusion\.html"/);
  assert.match(js, /Добавить схему в заключение/);
  assert.match(js, /id="addToConclusionBtn"/);
  assert.match(js, /report\.schemeStatus === 'completed' \|\| partialCadReady/);
  assert.ok(js.indexOf('const partialCadReady') < js.indexOf('const cadAction'));
});

test('team workspace uses the familiar left PROFIT sidebar with role-specific section links', async () => {
  const html = await read('public/workforce.html');
  const css = await read('public/workforce.css');
  const js = await read('public/workforce.js');
  assert.match(html, /class="profit-rail wf-rail"/);
  assert.match(html, /class="profit-links wf-global-links"/);
  assert.match(html, /id="workspaceNav"/);
  assert.doesNotMatch(html, /<nav class="wf-nav" id="workspaceNav"/);
  assert.match(css, /\.wf-page\{padding-left:var\(--profit-rail-width,176px\);/);
  assert.match(css, /\.wf-nav\{display:grid/);
  assert.match(css, /@media\(max-width:900px\)/);
  assert.match(js, /data-global-role/);
  assert.match(js, /roleCanManage\(\)/);
});
