import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('Team link is permanently visible in the left navigation on every core module', async () => {
  for (const path of ['frontend/public/index.html', 'frontend/public/dashboard.html', 'frontend/public/manual-cad.html', 'frontend/public/conclusion.html']) {
    const html = await read(path);
    const team = html.indexOf('class="profit-team-link" href="/workforce.html"');
    const settings = html.indexOf('href="/settings"');
    assert.notEqual(team, -1, `${path} must contain the Team link`);
    assert.ok(settings === -1 || team < settings, `${path} must show Team before Settings`);
    const link = html.slice(team, html.indexOf('</a>', team));
    assert.doesNotMatch(link, /\shidden(?:\s|=|>)|data-global-role/);
    assert.match(link, /<span>Команда<\/span>/);
  }
});

test('login screen requires credentials and does not offer role/account selection', async () => {
  const html = await read('frontend/public/login.html');
  const js = await read('frontend/public/login.js');
  assert.match(html, /name="username"[^>]*required/);
  assert.match(html, /name="password"[^>]*type="password"[^>]*required/);
  assert.doesNotMatch(html, /<select[^>]*(?:role|account|user)/i);
  assert.match(js, /username/);
  assert.match(js, /password/);
  assert.match(js, /\/api\/auth\/login/);
});

test('fitter workflow keeps button-only tracking and sends sketches separately from defect photos', async () => {
  const html = await read('frontend/public/workforce.html');
  const js = await read('frontend/public/workforce.js');
  const backend = await read('backend/api/workforce-system.js');
  assert.match(html, /Трекер состоит только из кнопок этапов работы/);
  assert.match(js, /Начать обход дома/);
  assert.match(js, /Отметить: прошёл этот дом/);
  assert.match(js, /Отметить: пришёл в офис/);
  assert.match(js, /name="sketch"/);
  assert.match(js, /name="defectPhotos"/);
  assert.match(js, /Отправить фотографии дефектов приёмщику/);
  assert.doesNotMatch(js, /navigator\.geolocation|\/api\/workforce\/location/);
  assert.doesNotMatch(backend, /routes\.post\('\/api\/workforce\/location/);
  assert.match(backend, /upload\.fields\(\[\{ name: 'sketch', maxCount: 1 \}\]\)/);
  assert.match(backend, /defectUpload\.array\('defectPhotos', 10\)/);
  assert.match(backend, /workspace\.defectReports\.unshift\(report\)/);
  assert.match(backend, /onSketchSubmitted\(\{ report, sourcePath:/);
  const defectRoute = backend.slice(backend.indexOf("routes.post('/api/workforce/tasks/:id/defects'"), backend.indexOf("routes.get('/api/workforce/defects'"));
  assert.doesNotMatch(defectRoute, /onSketchSubmitted|schemeJobId/);
  assert.match(defectRoute, /persistUploadedFile/);
  assert.match(backend, /routes\.post\('\/api\/workforce\/defects\/:id\/review'/);
  assert.match(backend, /routes\.get\('\/api\/workforce\/defects\/:reportId\/files\/:fileId'/);
});

test('receiver sees schemes and defect photos in one inbox and confirms photos with an approval checkbox', async () => {
  const html = await read('frontend/public/workforce.html');
  const js = await read('frontend/public/workforce.js');
  const backend = await read('backend/api/workforce-system.js');
  assert.match(html, /id="inboxStreetFilter"/);
  assert.match(html, /Папки по адресам/);
  assert.match(html, /id="reportList"/);
  assert.match(html, /id="reportDetail"/);
  assert.doesNotMatch(html, /showDefectInboxBtn|defectInboxPanel|schemeInboxPanel/);
  assert.match(js, /loadDefectReports\(\)/);
  assert.match(js, /function renderUnifiedInbox\(\)/);
  assert.match(js, /data-inbox-folder=/);
  assert.match(js, /data-accept-defect=/);
  assert.match(js, /Да, фотографии подходят/);
  assert.match(js, /\/api\/workforce\/defects\/\$\{encodeURIComponent\(event\.currentTarget\.dataset\.acceptDefect\)\}\/review/);
  assert.match(backend, /routes\.get\('\/api\/workforce\/defects'/);
  assert.match(backend, /routes\.post\('\/api\/workforce\/defects\/:id\/seen'/);
  assert.match(backend, /!\['accepted', 'revision_requested'\]\.includes\(status\)/);
  assert.match(backend, /report\.status = status/);
  assert.match(js, /addFolderToConclusionBtn/);
  assert.match(js, /function buildInboxFolders\(\)/);
  assert.match(js, /data-inbox-folder=/);
  assert.match(backend, /routes\.post\('\/api\/workforce\/tasks\/:taskId\/conclusion'/);
});

test('supervisors can create fitter and receiver accounts with generated credentials', async () => {
  const html = await read('frontend/public/workforce.html');
  const js = await read('frontend/public/workforce.js');
  const backend = await read('backend/api/workforce-system.js');
  assert.match(html, /Создать аккаунт и выдать данные/);
  assert.match(js, /autoGenerate: true/);
  assert.match(js, /createdCredentials/);
  assert.match(backend, /routes\.post\('\/api\/workforce\/users'/);
  assert.match(backend, /\['fitter', 'receiver'\]\.includes\(role\)/);
  assert.match(backend, /credentials: \{ username, password, generated: autoGenerate \}/);
});

test('receiver can view generated CAD preview and transfer it into the conclusion section', async () => {
  const js = await read('frontend/public/workforce.js');
  const conclusion = await read('frontend/public/conclusion-workforce.js');
  const html = await read('frontend/public/conclusion.html');
  const backend = await read('backend/api/workforce-system.js');
  const cadHtml = await read('frontend/public/manual-cad.html');
  const cadJs = await read('frontend/public/manual-cad.js');
  const server = await read('backend/api/server.js');
  assert.match(cadHtml, /id="returnToAddressFolderBtn"/);
  assert.ok(cadJs.includes('window.location.href = `/workforce.html?report=${encodeURIComponent(reportId)}`'));
  assert.doesNotMatch(cadJs, /api\/workforce\/reports.*conclusion/);
  assert.match(server, /project\.sourceReportId = workforceReportId/);
  assert.match(cadJs, /К папке адреса в уведомлениях/);
  assert.match(backend, /manualCadProjectId/);
  assert.match(backend, /manualCadBase \? `\$\{manualCadBase\}\/preview\.svg`/);
  assert.match(js, /Автоматически построенная CAD-схема/);
  assert.match(js, /data-open-folder-cad/);
  assert.match(cadHtml, /Сохранить и вернуться в папку/);
  assert.match(cadJs, /\/workforce\.html\?report=/);
  assert.match(conclusion, /\/api\/workforce\/conclusion/);
  assert.match(conclusion, /schemeSvgUrl/);
  assert.match(conclusion, /for \(const key of \['task', 'report', 'defectReport'\]\)/);
  assert.match(conclusion, /workforce_schemes_json/);
  assert.match(conclusion, /photo-grid/);
  assert.match(conclusion, /Приложении 3/);
  assert.match(backend, /clean\.svg/);
  assert.doesNotMatch(html, /workforceConclusionSection|workforceConclusionList/);
  assert.match(html, /href="\/workforce\.html"[^>]*>[\s\S]*?<span>Команда<\/span>/);
  assert.match(html, /href="\/manual-cad\.html"/);
  assert.match(backend, /routes\.post\('\/api\/workforce\/tasks\/:taskId\/conclusion'/);
  assert.match(backend, /routes\.get\('\/api\/workforce\/conclusion'/);
});

test('PDF and Word generation wait until both selected CAD schemes and defect photos are attached', async () => {
  const conclusionJs = await read('frontend/public/conclusion-workforce.js');
  assert.match(conclusionJs, /const hasSelectedMaterials = Boolean\(\(conclusionContext\?\.reports \|\| \[\]\)\.length \|\| \(conclusionContext\?\.defectReports \|\| \[\]\)\.length\)/);
  assert.match(conclusionJs, /Promise\.all\(materialJobs\)/);
  assert.match(conclusionJs, /button\.disabled = !ready/);
  assert.match(conclusionJs, /Формирование заблокировано, чтобы не выпустить документ без вложений/);
});

test('all accepted materials transfer together from one address folder into the task-scoped conclusion and Appendix 3', async () => {
  const backend = await read('backend/api/workforce-system.js');
  const conclusionJs = await read('frontend/public/conclusion-workforce.js');
  const template = await read('services/vdgo/backend/templates/index.html');
  const pdfBackend = await read('services/vdgo/backend/app.py');
  const schemeRoute = backend.slice(backend.indexOf("routes.post('/api/workforce/reports/:id/conclusion'"), backend.indexOf("routes.post('/api/workforce/defects/:id/conclusion'"));
  const defectRoute = backend.slice(backend.indexOf("routes.post('/api/workforce/defects/:id/conclusion'"), backend.indexOf("routes.post('/api/workforce/tasks/:taskId/conclusion'"));
  const folderRoute = backend.slice(backend.indexOf("routes.post('/api/workforce/tasks/:taskId/conclusion'"), backend.indexOf("routes.get('/api/workforce/conclusion'"));
  const scopedGet = backend.slice(backend.indexOf("routes.get('/api/workforce/conclusion'"), backend.indexOf("routes.post('/api/workforce/reports/:id/review'"));
  assert.match(schemeRoute, /status\(409\)/);
  assert.match(schemeRoute, /только целой папкой адреса/);
  assert.match(defectRoute, /status\(409\)/);
  assert.match(defectRoute, /только вместе со всей папкой адреса/);
  assert.match(folderRoute, /evaluateAddressFolder/);
  assert.match(folderRoute, /folderState\.allAccepted/);
  assert.match(folderRoute, /folderState\.schemesReady/);
  assert.match(folderRoute, /folderState\.photosReady/);
  assert.match(folderRoute, /report\.conclusionFolderId = task\.id/);
  assert.ok(folderRoute.includes('conclusionUrl: `/conclusion.html?task='));
  assert.match(scopedGet, /report\.taskId === taskId/);
  assert.match(scopedGet, /Boolean\(report\.conclusionAddedAt\)/);
  assert.match(scopedGet, /defectReports/);
  assert.match(conclusionJs, /photo_content_confirm/);
  assert.match(conclusionJs, /input\.files = transfer\.files/);
  assert.match(conclusionJs, /workforce_schemes_json/);
  assert.match(template, /id="photos"/);
  assert.match(template, /Приложении 3 «Фото дефектного участка»/);
  assert.match(pdfBackend, /PHOTO_SLOTS/);
  assert.match(pdfBackend, /defectReport|Фото дефектного участка/);
});

test('supervisors have an employee credential directory with names and one-time password reset', async () => {
  const html = await read('frontend/public/workforce.html');
  const js = await read('frontend/public/workforce.js');
  const backend = await read('backend/api/workforce-system.js');
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
  const backend = await read('backend/api/workforce-system.js');
  const server = await read('backend/api/server.js');
  const authMiddleware = backend.slice(backend.indexOf('async function authMiddleware'), backend.indexOf("const routes ="));
  const cadSaveRoute = server.slice(server.indexOf("app.put('/api/manual-cad/projects/:id'"), server.indexOf("app.post('/api/manual-cad/projects/:id/source'"));
  assert.match(authMiddleware, /req\.user\.role === 'fitter'/);
  assert.doesNotMatch(authMiddleware, /req\.user\.role === 'receiver'/);
  assert.match(server, /\['receiver', 'supervisor', 'developer'\]\.includes\(req\.user\?\.role\)/);
  assert.match(cadSaveRoute, /normalizeManualCadProject/);
  assert.match(cadSaveRoute, /manualEditRevision/);
  assert.doesNotMatch(cadSaveRoute, /requireRoles|role !== 'developer'/);
});

test('manual conclusion form remains available and address folders have a single transfer button', async () => {
  const html = await read('frontend/public/conclusion.html');
  const js = await read('frontend/public/workforce.js');
  const index = await read('frontend/public/index.html');
  assert.match(index, /href="\/conclusion\.html"[^>]*>[\s\S]*?<span>Заключение<\/span>/);
  assert.match(html, /iframe class="conclusion-frame" src="\/vdgo\/legacy"/);
  assert.match(html, /href="\/conclusion\.html"/);
  assert.match(js, /Добавить всю папку в заключение/);
  assert.match(await read('frontend/public/manual-cad.html'), /Сохранить и вернуться в папку/);
  assert.doesNotMatch(js, /Добавить схему в заключение/);
});

test('team workspace uses the familiar left PROFIT sidebar with role-specific section links', async () => {
  const html = await read('frontend/public/workforce.html');
  const css = await read('frontend/public/workforce.css');
  const js = await read('frontend/public/workforce.js');
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

test('defect photo intake is limited, private, rollback-safe, and separate from conclusion documents', async () => {
  const backend = await read('backend/api/workforce-system.js');
  const html = await read('frontend/public/workforce.html');
  const js = await read('frontend/public/workforce.js');
  const uploadConfig = backend.slice(backend.indexOf('const defectUpload = multer('), backend.indexOf('function getCurrentUser'));
  const defectRoute = backend.slice(backend.indexOf("routes.post('/api/workforce/tasks/:id/defects'"), backend.indexOf("routes.get('/api/workforce/defects'"));
  const fileRoute = backend.slice(backend.indexOf("routes.get('/api/workforce/defects/:reportId/files/:fileId'"), backend.indexOf('async function refreshSchemeState'));
  assert.match(uploadConfig, /fileSize:\s*16\s*\*\s*1024\s*\*\s*1024/);
  assert.match(uploadConfig, /files:\s*10/);
  assert.match(js, /name="defectPhotos"[^>]*multiple required/);
  assert.match(js, /image\/tiff/);
  assert.match(defectRoute, /if \(!task\.visitedAt \|\| !task\.officeAt\)/);
  assert.match(defectRoute, /createdReport/);
  assert.match(defectRoute, /workspace\.defectReports = workspace\.defectReports\.filter/);
  assert.doesNotMatch(defectRoute, /onSketchSubmitted|schemeJobId|conclusionAddedAt|workforceConclusion/);
  assert.match(fileRoute, /\['fitter', 'receiver', 'supervisor', 'developer'\]\.includes\(req\.user\.role\)/);
  assert.match(fileRoute, /report\.userId !== req\.user\.id/);
  assert.match(js, /browserPreview/);
  assert.match(js, /Да, фотографии подходят/);
});
