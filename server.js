import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, rename, copyFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { createManualCadProject, normalizeManualCadProject, renderManualCadSvg, renderManualCadDxf, isManualCadId } from './manual-cad-core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const PYTHON = process.env.MASK_PYTHON || '/opt/venv/bin/python';
const DATA = process.env.DATA_DIR || path.join(os.tmpdir(), 'cad-reconstruction-jobs');
const UPLOAD_DIR = path.join(os.tmpdir(), 'cad-reconstruction-uploads');
// Hidden metadata directory is inside the named cad_jobs volume, but is not
// exposed by the /jobs static file route.
const LIBRARY_DIR = path.join(DATA, '.private');
const LIBRARY_PATH = path.join(LIBRARY_DIR, 'address-library.json');
const SCHEME_META_DIR = path.join(LIBRARY_DIR, 'schemes');
// The global drawing-style reference is stored in the same named Docker volume
// as the address library, not in /tmp and never inside an individual house job.
const TEMPLATE_DIR = path.join(LIBRARY_DIR, 'template');
const TEMPLATE_META_PATH = path.join(TEMPLATE_DIR, 'template.json');
// Manual CAD projects are isolated from automatic analysis jobs and from the VDGO app.
const MANUAL_CAD_DIR = path.join(LIBRARY_DIR, 'manual-cad');

// ВАЖНО: PYTHON_JOB_TIMEOUT_MS задаётся в миллисекундах.
// 5 400 000 мс = 90 минут: OCR и Qwen-трассировка проходят двумя
// последовательными сетками 3x3; успешные плитки сохраняются в checkpoint.
const configuredPythonTimeout = Number(process.env.PYTHON_JOB_TIMEOUT_MS || 5_400_000);
const PYTHON_TIMEOUT_MS = Number.isFinite(configuredPythonTimeout)
  ? Math.max(60_000, configuredPythonTimeout)
  : 5_400_000;

const PYTHON_MAX_BUFFER = 16 * 1024 * 1024;
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_PATTERN = JOB_ID_PATTERN;

await mkdir(DATA, { recursive: true });
await mkdir(LIBRARY_DIR, { recursive: true });
await mkdir(SCHEME_META_DIR, { recursive: true });
await mkdir(TEMPLATE_DIR, { recursive: true });
await mkdir(MANUAL_CAD_DIR, { recursive: true });
await mkdir(UPLOAD_DIR, { recursive: true });

// Analyses are intentionally queued one at a time: the target GTX 1060 has
// limited VRAM, and concurrent Qwen requests would compete for the same GPU.
const activeAnalyses = new Map();

function runPythonStreaming(args, { jobId, progressPath, timeout = PYTHON_TIMEOUT_MS, maxBuffer = PYTHON_MAX_BUFFER }) {
  return new Promise((resolve, reject) => {
    const shortId = String(jobId).slice(0, 8);
    const child = spawn(PYTHON, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const progressFile = createWriteStream(progressPath, { flags: 'a' });
    let stdout = '';
    let stdoutBytes = 0;
    let stderrTail = '';
    let stderrPending = '';
    let timedOut = false;
    let outputOverflow = false;
    let settled = false;
    let spawnError = null;
    let progressFileFailed = false;
    let timeoutHandle;
    let forceKillHandle;

    progressFile.on('error', (error) => {
      progressFileFailed = true;
      console.error(`[JOB ${shortId}] Cannot persist progress.log: ${error.message}`);
    });

    const logLine = (line) => {
      const message = String(line || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 2000);
      if (!message) return;
      const entry = `${new Date().toISOString()} ${message}`;
      console.log(`[JOB ${shortId}] ${message}`);
      if (!progressFileFailed && !progressFile.destroyed && progressFile.writable) {
        progressFile.write(`${entry}\n`);
      }
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const complete = (code, signal) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (forceKillHandle) clearTimeout(forceKillHandle);
      if (stderrPending.trim()) logLine(stderrPending);

      const finish = () => {
        if (spawnError) {
          fail(Object.assign(spawnError, { stderr: stderrTail, stdout }));
        } else if (timedOut) {
          const error = new Error(`Python job exceeded ${Math.round(timeout / 60_000)} minute timeout and was terminated.`);
          Object.assign(error, {
            code: 'ETIMEDOUT',
            killed: true,
            signal: signal || 'SIGTERM',
            stderr: stderrTail,
            stdout
          });
          fail(error);
        } else if (outputOverflow) {
          const error = new Error(`Python stdout exceeded the ${maxBuffer} byte output limit.`);
          Object.assign(error, {
            code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
            killed: true,
            signal: signal || 'SIGTERM',
            stderr: stderrTail,
            stdout
          });
          fail(error);
        } else if (code !== 0) {
          const error = new Error(`Python process exited with code ${code}${signal ? ` (signal ${signal})` : ''}.`);
          Object.assign(error, { code, signal, killed: Boolean(signal), stderr: stderrTail, stdout });
          fail(error);
        } else {
          settled = true;
          resolve({ stdout, stderr: stderrTail });
        }
      };

      if (progressFileFailed || progressFile.destroyed) finish();
      else progressFile.end(finish);
    };

    logLine(`[JOB] Python process started; timeout=${Math.round(timeout / 60_000)}m (${timeout} ms)`);

    timeoutHandle = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      timedOut = true;
      logLine(`[JOB] Python timeout reached (${Math.round(timeout / 60_000)}m); sending SIGTERM`);
      child.kill('SIGTERM');
      forceKillHandle = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        logLine('[JOB] Python did not exit after SIGTERM; sending SIGKILL');
        child.kill('SIGKILL');
      }, 5000);
    }, timeout);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk) => {
      stdoutBytes += Buffer.byteLength(chunk, 'utf8');
      if (stdoutBytes > maxBuffer) {
        if (!outputOverflow) {
          outputOverflow = true;
          logLine(`[JOB] Python output exceeded ${maxBuffer} bytes; terminating process`);
          child.kill('SIGTERM');
          forceKillHandle = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          }, 5000);
        }
        return;
      }
      stdout += chunk;
    });

    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-64 * 1024);
      stderrPending += chunk;
      const lines = stderrPending.split(/\r?\n/);
      stderrPending = lines.pop() || '';
      for (const line of lines) logLine(line);
      if (stderrPending.length > 4000) {
        logLine(stderrPending.slice(0, 4000));
        stderrPending = stderrPending.slice(4000);
      }
    });

    child.on('error', (error) => {
      spawnError = error;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (forceKillHandle) clearTimeout(forceKillHandle);
      logLine(`[JOB] Unable to start Python: ${error.message}`);
    });

    child.on('close', complete);
  });
}

app.disable('x-powered-by');

// This app is commonly opened over plain HTTP on a private LAN (e.g. http://192.168.x.x:3001).
// Helmet's default CSP includes upgrade-insecure-requests, which makes browsers rewrite
// the relative CSS/JS URLs to HTTPS. There is no TLS listener in this container, so assets
// then fail with ERR_SSL_PROTOCOL_ERROR and the page appears as unstyled HTML.
// Use an explicit CSP without upgrade-insecure-requests for this offline/LAN deployment.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      fontSrc: ["'self'", 'data:'],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false,
  originAgentCluster: false,
  hsts: false
}));

app.use(express.json({ limit: '15mb' }));
app.use(rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false }));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: 0,
  setHeaders(res, filePath) {
    if (/\.(html|css|js)$/.test(filePath)) res.setHeader('Cache-Control', 'no-store, max-age=0');
  }
}));
app.use('/jobs', express.static(DATA, { maxAge: '1h', dotfiles: 'deny', index: false }));

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 18 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const extOk = /\.(jpe?g|png|webp|tiff?)$/i.test(file.originalname || '');
    const mimeOk = /^image\/(jpeg|png|webp|tiff|x-tiff)$/.test(file.mimetype || '');
    cb(null, extOk || mimeOk);
  }
});

const templateExtensions = new Set(['.pdf', '.svg', '.dxf', '.png', '.jpg', '.jpeg', '.webp', '.tif', '.tiff']);
const templateMimeTypes = {
  '.pdf': 'application/pdf', '.svg': 'image/svg+xml', '.dxf': 'application/dxf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.tif': 'image/tiff', '.tiff': 'image/tiff'
};
const templateUpload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 30 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(String(file.originalname || '')).toLowerCase();
    cb(null, templateExtensions.has(ext));
  }
});

const manualSourceUpload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 18 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const extOk = /\.(jpe?g|png|webp|tiff?)$/i.test(file.originalname || '');
    const mimeOk = /^image\/(jpeg|png|webp|tiff|x-tiff)$/.test(file.mimetype || '');
    cb(null, extOk || mimeOk);
  }
});

function manualProjectPath(id) {
  return path.join(MANUAL_CAD_DIR, id, 'project.json');
}
function manualProjectResponse(project) {
  return { ...project, sourceUrl: project.source?.fileName ? `/api/manual-cad/projects/${project.id}/source` : null };
}

function attachJobUrls(jobId, graph, sourceName = null) {
  graph.jobId = jobId;
  graph.progressUrl = `/jobs/${jobId}/progress.log`;
  if (sourceName) graph.sourceUrl = `/jobs/${jobId}/${sourceName}`;
  graph.overlayUrl = `/jobs/${jobId}/overlay.png`;
  graph.primaryOverlayUrl = `/jobs/${jobId}/primary-overlay.png`;
  graph.textMaskUrl = `/jobs/${jobId}/text-region-mask.png`;
  graph.geometryInkUrl = `/jobs/${jobId}/ink-without-text-boxes.png`;
  graph.handwrittenTextBlocksUrl = `/jobs/${jobId}/handwritten-text-blocks.png`;
  graph.inkUrl = `/jobs/${jobId}/ink-mask.png`;
  graph.svgUrl = `/jobs/${jobId}/clean.svg`;
  graph.dxfUrl = `/jobs/${jobId}/drawing.dxf`;
  graph.diagnosticsUrl = `/jobs/${jobId}/diagnostics.json`;
  graph.confirmedConnections = Array.isArray(graph.confirmedConnections) ? graph.confirmedConnections : [];
  graph.joinCandidates = Array.isArray(graph.joinCandidates) ? graph.joinCandidates : [];
  return graph;
}

function cleanLabel(value, maxLength = 100) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

async function readTemplateMeta() {
  try {
    const meta = JSON.parse(await readFile(TEMPLATE_META_PATH, 'utf8'));
    const storageName = path.basename(String(meta.storageName || ''));
    if (!storageName || !/^template-[a-f0-9-]+\.[a-z0-9]+$/i.test(storageName)) return null;
    return {
      originalName: cleanLabel(meta.originalName || 'Эталонный шаблон', 180),
      storageName,
      mimeType: templateMimeTypes[path.extname(storageName).toLowerCase()] || 'application/octet-stream',
      size: Math.max(0, Number(meta.size) || 0),
      uploadedAt: meta.uploadedAt || null
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

// Pin the selected reference sheet into each job folder so a later retry uses
// the same page profile even if the global template is replaced in settings.
async function pinTemplateReference(jobDir) {
  // Keep the original reference used by a job even after a global replacement.
  const existing = (await readdir(jobDir)).find(name => /^\.drawing-template-reference\.[a-z0-9]+$/i.test(name));
  if (existing) return path.join(jobDir, existing);
  const meta = await readTemplateMeta();
  if (!meta) return null;
  const extension = path.extname(meta.storageName).toLowerCase() || '.bin';
  const snapshotName = `.drawing-template-reference${extension}`;
  const snapshotPath = path.join(jobDir, snapshotName);
  const sourcePath = path.join(TEMPLATE_DIR, meta.storageName);
  await copyFile(sourcePath, snapshotPath);
  return snapshotPath;
}

async function saveTemplateMeta(meta) {
  const temporary = `${TEMPLATE_META_PATH}.tmp-${randomUUID()}`;
  await writeFile(temporary, JSON.stringify(meta, null, 2), 'utf8');
  await rename(temporary, TEMPLATE_META_PATH);
}

function publicTemplate(meta) {
  if (!meta) return null;
  return {
    originalName: meta.originalName,
    mimeType: meta.mimeType,
    size: meta.size,
    uploadedAt: meta.uploadedAt,
    downloadUrl: '/api/template/file'
  };
}

async function readAddressLibrary() {
  try {
    const parsed = JSON.parse(await readFile(LIBRARY_PATH, 'utf8'));
    return {
      schemaVersion: 1,
      streets: Array.isArray(parsed.streets) ? parsed.streets.map(street => ({
        id: String(street.id || ''), name: cleanLabel(street.name),
        createdAt: street.createdAt || null,
        buildings: Array.isArray(street.buildings) ? street.buildings.map(building => ({
          id: String(building.id || ''), name: cleanLabel(building.name),
          createdAt: building.createdAt || null,
          schemes: Array.isArray(building.schemes) ? building.schemes.filter(item => item && JOB_ID_PATTERN.test(String(item.jobId || ''))).map(item => ({
            jobId: String(item.jobId), title: cleanLabel(item.title || 'Схема', 140),
            createdAt: item.createdAt || null, uploadedBy: cleanLabel(item.uploadedBy || '', 80),
            sourceName: cleanLabel(item.sourceName || '', 180),
            status: ['pending', 'processing', 'completed', 'failed'].includes(item.status)
              ? item.status : 'completed',
            originalName: cleanLabel(item.originalName || item.title || 'Эскиз', 180),
            error: cleanLabel(item.error || '', 240),
            updatedAt: item.updatedAt || item.createdAt || null,
            completedAt: item.completedAt || null
          })) : []
        })) : []
      })) : []
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { schemaVersion: 1, streets: [] };
    throw error;
  }
}

async function saveAddressLibrary(library) {
  const tempPath = `${LIBRARY_PATH}.tmp-${randomUUID()}`;
  await writeFile(tempPath, JSON.stringify(library, null, 2), 'utf8');
  await rename(tempPath, LIBRARY_PATH);
}

let addressLibraryWriteQueue = Promise.resolve();
function updateAddressLibrary(mutator) {
  const task = addressLibraryWriteQueue.then(async () => {
    const library = await readAddressLibrary();
    const result = await mutator(library);
    await saveAddressLibrary(library);
    return result;
  });
  addressLibraryWriteQueue = task.catch(() => {});
  return task;
}

function findBuilding(library, streetId, buildingId) {
  const street = library.streets.find(item => item.id === streetId);
  const building = street?.buildings.find(item => item.id === buildingId);
  return street && building ? { street, building } : null;
}

function addSchemeToBuilding(library, street, building, scheme) {
  // A job belongs to one address at a time. Moving it removes stale links
  // from any previous building before the new reference is written.
  for (const item of library.streets) {
    for (const house of item.buildings) {
      house.schemes = house.schemes.filter(existing => existing.jobId !== scheme.jobId);
    }
  }
  building.schemes.unshift(scheme);
  building.schemes.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

function findScheme(library, jobId) {
  for (const street of library.streets) {
    for (const building of street.buildings) {
      const scheme = building.schemes.find(item => item.jobId === jobId);
      if (scheme) return { street, building, scheme };
    }
  }
  return null;
}

function schemeMetaPath(jobId) {
  return path.join(SCHEME_META_DIR, `${jobId}.json`);
}

async function writeSchemeMeta(jobId, meta) {
  const target = schemeMetaPath(jobId);
  const temporary = `${target}.tmp-${randomUUID()}`;
  await writeFile(temporary, JSON.stringify(meta, null, 2), 'utf8');
  await rename(temporary, target);
}

async function readSchemeMeta(jobId) {
  try {
    return JSON.parse(await readFile(schemeMetaPath(jobId), 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const library = await readAddressLibrary();
    const found = findScheme(library, jobId);
    return found ? {
      jobId, title: found.scheme.title, createdAt: found.scheme.createdAt,
      uploadedBy: found.scheme.uploadedBy, sourceName: found.scheme.sourceName,
      status: found.scheme.status || 'completed', originalName: found.scheme.originalName || found.scheme.title,
      streetName: found.street.name, buildingName: found.building.name,
      error: found.scheme.error || ''
    } : null;
  }
}

async function updateSchemeStatus(jobId, status, extra = {}) {
  const existing = await readSchemeMeta(jobId) || { jobId };
  const updated = { ...existing, ...extra, status, updatedAt: new Date().toISOString() };
  await writeSchemeMeta(jobId, updated);
  await updateAddressLibrary(library => {
    const found = findScheme(library, jobId);
    if (found) Object.assign(found.scheme, {
      status, error: cleanLabel(updated.error || '', 240),
      updatedAt: updated.updatedAt, completedAt: updated.completedAt || null
    });
  });
  return updated;
}

async function runStoredSchemeAnalysis(jobId) {
  const jobDir = path.join(DATA, jobId);
  const meta = await readSchemeMeta(jobId);
  if (!meta?.sourceName) throw new Error('Исходный эскиз не найден в папке дома.');
  const sourcePath = path.join(jobDir, path.basename(meta.sourceName));
  const progressPath = path.join(jobDir, 'progress.log');
  const templatePath = await pinTemplateReference(jobDir);
  const processorArgs = [path.join(__dirname, 'processor.py'), '--input', sourcePath, '--out', jobDir];
  if (templatePath) processorArgs.push('--template', templatePath);
  await runPythonStreaming(
    processorArgs,
    { jobId, progressPath, timeout: PYTHON_TIMEOUT_MS, maxBuffer: PYTHON_MAX_BUFFER }
  );
  const graph = JSON.parse(await readFile(path.join(jobDir, 'graph.json'), 'utf8'));
  if (!graph || !graph.image || !Array.isArray(graph.edges)) {
    throw new Error('Python обработчик создал неполный graph.json.');
  }
  if (graph.complete === false || graph.analysisStatus === 'incomplete') {
    const reasons = Array.isArray(graph.incompleteReasons) ? graph.incompleteReasons : [];
    const message = [
      'Обработка завершилась частично: не все плитки Qwen были обработаны.',
      ...reasons.map(value => String(value)).filter(Boolean),
      'Успешные плитки сохранены. Нажми «Повторить преобразование»: будут обработаны только отсутствующие плитки.'
    ].join(' ');
    await updateSchemeStatus(jobId, 'failed', {
      error: message.slice(0, 900),
      graphSummary: graph.summary || null,
      partialGraphReady: true,
      completedAt: null
    });
    return graph;
  }
  await updateSchemeStatus(jobId, 'completed', {
    completedAt: new Date().toISOString(), error: '',
    graphSummary: graph.summary || null,
    partialGraphReady: false
  });
  return graph;
}

function nextManualEdgeId(edges) {
  const maxId = (Array.isArray(edges) ? edges : []).reduce((max, edge) => {
    const match = /^E(\d+)$/i.exec(String(edge?.id || ''));
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `E${maxId + 1}`;
}

// A single global style reference, separate from house uploads and analysis jobs.
// Files live under DATA/.private/template inside the persistent cad_jobs volume.
app.get('/api/template', async (_req, res) => {
  try {
    const meta = await readTemplateMeta();
    return res.json({ ok: true, template: publicTemplate(meta) });
  } catch (error) {
    if (error?.code === 'ENOENT') return res.json({ ok: true, template: null });
    console.error('[TEMPLATE] Cannot read template metadata:', error);
    return res.status(500).json({ error: 'Не удалось прочитать эталонный шаблон.' });
  }
});

app.get('/api/template/file', async (_req, res) => {
  try {
    const meta = await readTemplateMeta();
    if (!meta) return res.status(404).json({ error: 'Эталонный шаблон ещё не загружен.' });
    const filePath = path.join(TEMPLATE_DIR, meta.storageName);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Always download reference files, including SVG, rather than rendering user content inline.
    res.setHeader('Content-Type', 'application/octet-stream');
    return res.download(filePath, meta.originalName, error => {
      if (error && !res.headersSent) res.status(error.code === 'ENOENT' ? 404 : 500).json({ error: 'Файл шаблона не найден.' });
    });
  } catch (error) {
    console.error('[TEMPLATE] Cannot download template:', error);
    return res.status(500).json({ error: 'Не удалось скачать эталонный шаблон.' });
  }
});

app.post('/api/template', templateUpload.single('template'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Выберите PDF, SVG, DXF, PNG, JPG, WEBP или TIFF.' });
  const ext = path.extname(String(req.file.originalname || '')).toLowerCase();
  if (!templateExtensions.has(ext)) {
    await rm(req.file.path, { force: true }).catch(() => {});
    return res.status(400).json({ error: 'Формат файла шаблона не поддерживается.' });
  }
  const originalName = cleanLabel(path.basename(String(req.file.originalname || '').replace(/\\/g, '/')), 180) || `template${ext}`;
  const storageName = `template-${randomUUID()}${ext}`;
  const destination = path.join(TEMPLATE_DIR, storageName);
  const previous = await readTemplateMeta().catch(() => null);
  try {
    // /tmp and the named Docker volume can be different filesystems: copy, then remove.
    await copyFile(req.file.path, destination);
    const meta = {
      originalName, storageName,
      mimeType: templateMimeTypes[ext] || 'application/octet-stream',
      size: Number(req.file.size) || 0,
      uploadedAt: new Date().toISOString()
    };
    await saveTemplateMeta(meta);
    if (previous?.storageName && previous.storageName !== storageName) {
      await rm(path.join(TEMPLATE_DIR, previous.storageName), { force: true }).catch(() => {});
    }
    return res.status(201).json({ ok: true, template: publicTemplate(meta) });
  } catch (error) {
    await rm(destination, { force: true }).catch(() => {});
    console.error('[TEMPLATE] Cannot save uploaded template:', error);
    return res.status(500).json({ error: 'Не удалось сохранить эталонный шаблон.' });
  } finally {
    await rm(req.file.path, { force: true }).catch(() => {});
  }
});

app.delete('/api/template', async (_req, res) => {
  try {
    const meta = await readTemplateMeta();
    if (meta?.storageName) await rm(path.join(TEMPLATE_DIR, meta.storageName), { force: true });
    await rm(TEMPLATE_META_PATH, { force: true });
    return res.json({ ok: true, template: null });
  } catch (error) {
    console.error('[TEMPLATE] Cannot delete template:', error);
    return res.status(500).json({ error: 'Не удалось удалить эталонный шаблон.' });
  }
});

app.get('/api/library', async (_req, res) => {
  try {
    const library = await readAddressLibrary();
    return res.json({ ok: true, library });
  } catch (error) {
    console.error('[LIBRARY] Cannot read address library:', error);
    return res.status(500).json({ error: 'Не удалось прочитать папки объектов.' });
  }
});

app.post('/api/library/streets', async (req, res) => {
  const name = cleanLabel(req.body?.name, 100);
  if (!name) return res.status(400).json({ error: 'Укажи название улицы.' });
  try {
    const street = await updateAddressLibrary(library => {
      if (library.streets.some(item => item.name.toLocaleLowerCase('ru') === name.toLocaleLowerCase('ru'))) {
        const error = new Error('Такая улица уже есть в папках.'); error.status = 409; throw error;
      }
      const created = { id: randomUUID(), name, createdAt: new Date().toISOString(), buildings: [] };
      library.streets.push(created);
      return created;
    });
    return res.status(201).json({ ok: true, street });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || 'Не удалось создать улицу.' });
  }
});

app.post('/api/library/buildings', async (req, res) => {
  const streetId = String(req.body?.streetId || '');
  const name = cleanLabel(req.body?.name, 80);
  if (!UUID_PATTERN.test(streetId) || !name) return res.status(400).json({ error: 'Выбери улицу и укажи номер дома.' });
  try {
    const building = await updateAddressLibrary(library => {
      const street = library.streets.find(item => item.id === streetId);
      if (!street) { const error = new Error('Улица не найдена. Обнови список папок.'); error.status = 404; throw error; }
      if (street.buildings.some(item => item.name.toLocaleLowerCase('ru') === name.toLocaleLowerCase('ru'))) {
        const error = new Error('Такой дом уже есть в этой улице.'); error.status = 409; throw error;
      }
      const created = { id: randomUUID(), name, createdAt: new Date().toISOString(), schemes: [] };
      street.buildings.push(created);
      return created;
    });
    return res.status(201).json({ ok: true, building });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message || 'Не удалось создать дом.' });
  }
});

// The fitter's workflow ends here: store the photo in the selected address
// inbox. Do not start OCR/Qwen until a specialist explicitly opens the sketch.
app.post('/api/library/schemes/upload', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Загрузите JPG, PNG, WEBP или TIFF.' });
  const streetId = String(req.body?.streetId || '');
  const buildingId = String(req.body?.buildingId || '');
  const uploadedBy = cleanLabel(req.body?.uploadedBy, 80);
  const ext = path.extname(req.file.originalname || '').toLowerCase() || '.jpg';
  const originalName = cleanLabel(path.basename(req.file.originalname || 'Эскиз'), 180) || 'Эскиз';
  const title = cleanLabel(req.body?.title || path.basename(originalName, ext), 140) || 'Новый эскиз';

  if (!UUID_PATTERN.test(streetId) || !UUID_PATTERN.test(buildingId)) {
    await rm(req.file.path, { force: true }).catch(() => {});
    return res.status(400).json({ error: 'Сначала найди улицу и выбери номер дома.' });
  }

  const jobId = randomUUID();
  const jobDir = path.join(DATA, jobId);
  const sourceName = `source${ext}`;
  try {
    const library = await readAddressLibrary();
    const address = findBuilding(library, streetId, buildingId);
    if (!address) {
      await rm(req.file.path, { force: true }).catch(() => {});
      return res.status(404).json({ error: 'Адрес не найден. Обнови поиск улиц и домов.' });
    }
    await mkdir(jobDir, { recursive: true });
    await copyFile(req.file.path, path.join(jobDir, sourceName));
    await rm(req.file.path, { force: true });

    const meta = {
      jobId, title, originalName, sourceName, uploadedBy,
      streetId, streetName: address.street.name,
      buildingId, buildingName: address.building.name,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      status: 'pending', error: ''
    };
    await writeSchemeMeta(jobId, meta);
    await updateAddressLibrary(current => {
      const target = findBuilding(current, streetId, buildingId);
      if (!target) { const error = new Error('Адрес удалён во время отправки.'); error.status = 404; throw error; }
      addSchemeToBuilding(current, target.street, target.building, {
        jobId, title, originalName, createdAt: meta.createdAt,
        updatedAt: meta.updatedAt, uploadedBy, sourceName, status: 'pending', error: ''
      });
    });
    return res.status(201).json({
      ok: true, scheme: { ...meta, sourceUrl: `/jobs/${jobId}/${sourceName}` },
      library: await readAddressLibrary()
    });
  } catch (error) {
    await rm(jobDir, { recursive: true, force: true }).catch(() => {});
    return res.status(error.status || 500).json({ error: error.message || 'Не удалось отправить эскиз в папку дома.' });
  } finally {
    if (req.file?.path) await rm(req.file.path, { force: true }).catch(() => {});
  }
});

app.get('/api/library/schemes/:jobId', async (req, res) => {
  const { jobId } = req.params;
  if (!JOB_ID_PATTERN.test(jobId)) return res.status(400).json({ error: 'Некорректный ID схемы.' });
  try {
    const library = await readAddressLibrary();
    const found = findScheme(library, jobId);
    if (!found) return res.status(404).json({ error: 'Схема не найдена в библиотеке адресов.' });
    const meta = await readSchemeMeta(jobId);
    if (!meta?.sourceName) return res.status(404).json({ error: 'Исходная фотография не найдена.' });
    const scheme = {
      ...found.scheme,
      streetName: found.street.name,
      buildingName: found.building.name,
      sourceUrl: `/jobs/${jobId}/${path.basename(meta.sourceName)}`,
      progressUrl: `/jobs/${jobId}/progress.log`
    };
    return res.json({ ok: true, scheme });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Не удалось открыть схему.' });
  }
});

app.get('/api/library/schemes/:jobId/status', async (req, res) => {
  const { jobId } = req.params;
  if (!JOB_ID_PATTERN.test(jobId)) return res.status(400).json({ error: 'Некорректный ID схемы.' });
  try {
    const library = await readAddressLibrary();
    const found = findScheme(library, jobId);
    if (!found) return res.status(404).json({ error: 'Схема не найдена.' });
    const meta = await readSchemeMeta(jobId);
    let progress = '';
    try {
      const raw = await readFile(path.join(DATA, jobId, 'progress.log'), 'utf8');
      progress = raw.trim().split(/\r?\n/).slice(-1)[0] || '';
    } catch { /* pending upload has no processing log yet */ }
    return res.json({
      ok: true, jobId, status: meta?.status || found.scheme.status || 'completed',
      progress, error: meta?.error || found.scheme.error || '',
      graphReady: await readFile(path.join(DATA, jobId, 'graph.json')).then(() => true).catch(() => false)
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Не удалось проверить состояние схемы.' });
  }
});

app.post('/api/library/schemes/:jobId/analyze', async (req, res) => {
  const { jobId } = req.params;
  if (!JOB_ID_PATTERN.test(jobId)) return res.status(400).json({ error: 'Некорректный ID схемы.' });
  try {
    const library = await readAddressLibrary();
    const found = findScheme(library, jobId);
    if (!found) return res.status(404).json({ error: 'Сначала отправь эскиз в папку нужного дома.' });
    const meta = await readSchemeMeta(jobId);
    if (!meta?.sourceName) return res.status(404).json({ error: 'Исходная фотография не найдена.' });
    if (meta.status === 'completed') return res.json({ ok: true, status: 'completed', jobId });
    if (activeAnalyses.has(jobId)) return res.status(202).json({ ok: true, status: 'processing', jobId });
    if (activeAnalyses.size > 0) {
      const activeJobId = activeAnalyses.keys().next().value;
      return res.status(409).json({
        error: 'Сейчас уже обрабатывается другой чертёж. Дождись его завершения, чтобы не перегружать GTX 1060.',
        status: 'busy', activeJobId
      });
    }

    // Reserve the single Qwen slot synchronously before the first await so
    // two simultaneous POSTs cannot both start expensive GPU jobs.
    activeAnalyses.set(jobId, Promise.resolve());
    try {
      await updateSchemeStatus(jobId, 'processing', {
        error: '', startedAt: new Date().toISOString(), completedAt: null,
        partialGraphReady: false
      });
    } catch (statusError) {
      activeAnalyses.delete(jobId);
      throw statusError;
    }
    const task = Promise.resolve().then(() => runStoredSchemeAnalysis(jobId)).catch(async error => {
      console.error(`[JOB ${jobId.slice(0, 8)}] Stored scheme analysis failed:`, error?.stderr || error);
      await updateSchemeStatus(jobId, 'failed', {
        error: `${String(error?.stderr || error?.message || error).slice(-650)} Если в .checkpoints уже есть успешные плитки, повторный запуск использует их и запросит только недостающие.`.slice(-900),
        partialGraphReady: false,
        completedAt: null
      }).catch(statusError => console.error('[LIBRARY] Failed to save analysis error:', statusError));
    }).finally(() => activeAnalyses.delete(jobId));
    activeAnalyses.set(jobId, task);
    return res.status(202).json({ ok: true, status: 'processing', jobId });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Не удалось запустить преобразование схемы.' });
  }
});

app.post('/api/library/schemes/:jobId', async (req, res) => {
  const { jobId } = req.params;
  const streetId = String(req.body?.streetId || '');
  const buildingId = String(req.body?.buildingId || '');
  const title = cleanLabel(req.body?.title || 'Схема', 140) || 'Схема';
  if (!JOB_ID_PATTERN.test(jobId)) return res.status(400).json({ error: 'Некорректный ID схемы.' });
  if (!UUID_PATTERN.test(streetId) || !UUID_PATTERN.test(buildingId)) return res.status(400).json({ error: 'Выбери улицу и дом.' });
  try {
    const jobDir = path.join(DATA, jobId);
    const [graphRaw, entries] = await Promise.all([
      readFile(path.join(jobDir, 'graph.json'), 'utf8'), readdir(jobDir)
    ]);
    const graph = JSON.parse(graphRaw);
    const sourceName = entries.find(name => /^source\.(?:jpe?g|png|webp|tiff?)$/i.test(name));
    if (!sourceName) return res.status(404).json({ error: 'Исходное изображение этой схемы не найдено.' });
    await updateAddressLibrary(library => {
      const context = findBuilding(library, streetId, buildingId);
      if (!context) { const error = new Error('Указанная улица или дом не найдены.'); error.status = 404; throw error; }
      addSchemeToBuilding(library, context.street, context.building, {
        jobId, title, createdAt: graph.createdAt || graph.timestamp || new Date().toISOString(),
        uploadedBy: cleanLabel(req.body?.uploadedBy, 80), sourceName
      });
    });
    return res.json({ ok: true, library: await readAddressLibrary() });
  } catch (error) {
    const status = error.status || (error?.code === 'ENOENT' ? 404 : 500);
    return res.status(status).json({ error: error.message || 'Не удалось добавить схему в папку дома.' });
  }
});

app.get('/api/jobs/:jobId/graph', async (req, res) => {
  const { jobId } = req.params;
  if (!JOB_ID_PATTERN.test(jobId)) return res.status(400).json({ error: 'Некорректный ID задания.' });

  const jobDir = path.join(DATA, jobId);
  try {
    const [raw, entries] = await Promise.all([
      readFile(path.join(jobDir, 'graph.json'), 'utf8'),
      readdir(jobDir)
    ]);
    const graph = JSON.parse(raw);
    const sourceName = entries.find(name => /^source\.(?:jpe?g|png|webp|tiff?)$/i.test(name)) || null;
    if (!sourceName) return res.status(404).json({ error: 'Исходное изображение задания не найдено.' });
    return res.json(attachJobUrls(jobId, graph, sourceName));
  } catch (error) {
    const status = error?.code === 'ENOENT' ? 404 : 500;
    return res.status(status).json({
      error: status === 404
        ? 'Сохранённое задание не найдено или уже удалено.'
        : 'Не удалось прочитать граф задания.'
    });
  }
});

app.post('/api/jobs/:jobId/connections', async (req, res) => {
  const { jobId } = req.params;
  if (!JOB_ID_PATTERN.test(jobId)) return res.status(400).json({ error: 'Некорректный ID задания.' });

  const from = String(req.body?.from || '').trim();
  const to = String(req.body?.to || '').trim();
  const candidateId = req.body?.candidateId == null ? null : String(req.body.candidateId).trim();
  const confirmAlternative = req.body?.confirmAlternative === true;

  if (!from || !to || from === to || from.length > 64 || to.length > 64) {
    return res.status(400).json({ error: 'Укажите два разных узла графа.' });
  }

  const jobDir = path.join(DATA, jobId);
  const graphPath = path.join(jobDir, 'graph.json');

  try {
    const graph = JSON.parse(await readFile(graphPath, 'utf8'));
    graph.nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
    graph.edges = Array.isArray(graph.edges) ? graph.edges : [];
    graph.joinCandidates = Array.isArray(graph.joinCandidates) ? graph.joinCandidates : [];
    graph.confirmedConnections = Array.isArray(graph.confirmedConnections) ? graph.confirmedConnections : [];

    const nodeById = new Map(graph.nodes.map(node => [String(node.id), node]));
    const a = nodeById.get(from);
    const b = nodeById.get(to);
    if (!a || !b) {
      return res.status(404).json({ error: 'Один из узлов больше не существует в сохранённом графе.' });
    }

    let candidate = null;
    if (candidateId) {
      candidate = graph.joinCandidates.find(item => {
        const samePair = (String(item.from) === from && String(item.to) === to) ||
          (String(item.from) === to && String(item.to) === from);
        return String(item.id) === candidateId && samePair;
      });

      if (!candidate) {
        return res.status(409).json({ error: 'Кандидат устарел или уже был использован. Обновите сохранённое задание.' });
      }
      if (candidate.has_alternatives && !confirmAlternative) {
        return res.status(409).json({ error: 'У узла есть конкурирующие варианты. Требуется явное подтверждение выбранной пары.' });
      }
      if (Number(a.degree) !== 1 || Number(b.degree) !== 1) {
        return res.status(409).json({ error: 'Один из концов уже соединён. Обновите список кандидатов.' });
      }
    }

    const duplicate = graph.edges.some(edge =>
      (String(edge.from) === from && String(edge.to) === to) ||
      (String(edge.from) === to && String(edge.to) === from)
    );
    if (duplicate) return res.status(409).json({ error: 'Такое соединение уже существует.' });

    const edgeId = nextManualEdgeId(graph.edges);
    const confirmedAt = new Date().toISOString();

    graph.edges.push({
      id: edgeId,
      from,
      to,
      source: 'manual',
      confidence: 1,
      geometry: [[Number(a.x), Number(a.y)], [Number(b.x), Number(b.y)]],
      visible: true,
      review: false,
      detector: 'MANUAL',
      component_role: 'line_structure',
      component_id: 'MANUAL',
      manual_reason: candidate ? 'user-confirmed-join-candidate' : 'user-created-connection',
      candidate_id: candidate?.id || null,
      candidate_score: candidate?.score ?? null,
      confirmed_at: confirmedAt
    });

    a.degree = Number(a.degree || 0) + 1;
    b.degree = Number(b.degree || 0) + 1;
    a.review = false;
    b.review = false;

    const record = {
      id: `MC${graph.confirmedConnections.length + 1}`,
      edgeId,
      candidateId: candidate?.id || null,
      from,
      to,
      score: candidate?.score ?? null,
      confirmedAt,
      confirmation: 'explicit-user-action'
    };
    graph.confirmedConnections.push(record);
    const consumed = new Set([from, to]);
    graph.joinCandidates = graph.joinCandidates.filter(item =>
      !consumed.has(String(item.from)) && !consumed.has(String(item.to))
    );

    graph.summary = graph.summary && typeof graph.summary === 'object' ? graph.summary : {};
    graph.summary.edges = graph.edges.length;
    graph.summary.confirmed_connections = graph.confirmedConnections.length;

    const tempPath = `${graphPath}.tmp-${randomUUID()}`;
    await writeFile(tempPath, JSON.stringify(graph, null, 2), 'utf8');
    await rename(tempPath, graphPath);

    const entries = await readdir(jobDir);
    const sourceName = entries.find(name => /^source\.(?:jpe?g|png|webp|tiff?)$/i.test(name)) || null;
    console.log(`[JOB ${jobId.slice(0, 8)}] Confirmed connection ${record.id}: ${from} <-> ${to}; edge=${edgeId}; candidate=${candidate?.id || 'manual'}`);
    return res.json({ ok: true, connection: record, graph: attachJobUrls(jobId, graph, sourceName) });
  } catch (error) {
    const status = error?.code === 'ENOENT' ? 404 : 500;
    console.error(`[JOB ${jobId.slice(0, 8)}] Cannot save connection:`, error);
    return res.status(status).json({ error: status === 404 ? 'Задание не найдено.' : 'Не удалось сохранить соединение.' });
  }
});

app.post('/api/jobs/:jobId/review', async (req, res) => {
  const { jobId } = req.params;
  if (!JOB_ID_PATTERN.test(jobId)) return res.status(400).json({ error: 'Некорректный ID задания.' });
  const action = String(req.body?.action || '').trim();
  const targetId = String(req.body?.targetId || '').trim();
  if (!action || !targetId || targetId.length > 64) return res.status(400).json({ error: 'Не указано действие или объект проверки.' });
  const jobDir = path.join(DATA, jobId);
  const graphPath = path.join(jobDir, 'graph.json');
  try {
    const graph = JSON.parse(await readFile(graphPath, 'utf8'));
    const model = graph.documentModel;
    if (!model || typeof model !== 'object') return res.status(409).json({ error: 'В задании нет редактируемой модели.' });
    model.reviewTasks = Array.isArray(model.reviewTasks) ? model.reviewTasks : [];
    model.validationFindings = Array.isArray(model.validationFindings) ? model.validationFindings : [];
    const resolveTasks = kind => model.reviewTasks.forEach(task => {
      if ((!kind || task.kind === kind) && (task.targetIds || []).map(String).includes(targetId)) task.status = 'resolved';
    });
    if (action === 'classify_symbol') {
      const symbol = (model.symbols || []).find(item => String(item.id) === targetId);
      const symbolType = String(req.body?.symbolType || '').trim();
      const catalog = (graph.symbolCatalog || []).find(item => String(item.type) === symbolType);
      if (!symbol) return res.status(404).json({ error: 'Кандидат символа не найден.' });
      if (!catalog) return res.status(400).json({ error: 'Неизвестный тип CAD-символа.' });
      Object.assign(symbol, { type: symbolType, catalogLabel: cleanLabel(catalog.label, 100),
        rotation: Math.max(0, Math.min(359.99, Number(req.body?.rotation) || 0)),
        ports: Array.isArray(catalog.ports) ? catalog.ports : [], state: 'primary' });
      resolveTasks('classify_symbol');
    } else if (action === 'assign_dimension') {
      const dimension = (model.dimensions || []).find(item => String(item.id) === targetId);
      const pipeId = String(req.body?.pipeId || '').trim();
      const pipe = (model.pipes || []).find(item => String(item.id) === pipeId && item.state === 'primary');
      if (!dimension) return res.status(404).json({ error: 'Размер не найден.' });
      if (!pipe) return res.status(400).json({ error: 'Выберите подтверждённый участок трубопровода.' });
      const numericValue = Number(req.body?.value);
      if (Number.isFinite(numericValue) && numericValue >= 0) dimension.value = numericValue;
      Object.assign(dimension, { targetId: pipeId, state: 'primary' });
      resolveTasks('assign_dimension');
    } else if (action === 'verify_text') {
      const label = (model.labels || []).find(item => String(item.id) === targetId);
      const text = cleanLabel(req.body?.text, 240);
      if (!label) return res.status(404).json({ error: 'Подпись не найдена.' });
      if (!text) return res.status(400).json({ error: 'Введите подтверждённый текст.' });
      Object.assign(label, { text, state: 'primary' });
      resolveTasks('verify_text');
    } else if (action === 'resolve_finding') {
      const finding = model.validationFindings.find(item => String(item.id) === targetId);
      if (!finding) return res.status(404).json({ error: 'Замечание не найдено.' });
      Object.assign(finding, { status: 'resolved', resolution: cleanLabel(req.body?.resolution || 'Проверено оператором', 180) });
    } else if (action === 'dismiss_task') {
      const task = model.reviewTasks.find(item => String(item.id) === targetId);
      if (!task) return res.status(404).json({ error: 'Задание проверки не найдено.' });
      task.status = 'dismissed';
    } else return res.status(400).json({ error: 'Неподдерживаемое действие проверки.' });

    model.status = model.reviewTasks.some(item => item.status === 'open') || model.validationFindings.some(item => item.status === 'open') ? 'needs_review' : 'confirmed';
    graph.status = model.status;
    const tempPath = `${graphPath}.tmp-${randomUUID()}`;
    await writeFile(tempPath, JSON.stringify(graph, null, 2), 'utf8');
    await rename(tempPath, graphPath);
    const entries = await readdir(jobDir);
    const sourceName = entries.find(name => /^source\.(?:jpe?g|png|webp|tiff?)$/i.test(name)) || null;
    return res.json({ ok: true, graph: attachJobUrls(jobId, graph, sourceName) });
  } catch (error) {
    const status = error?.code === 'ENOENT' ? 404 : 500;
    console.error(`[JOB ${jobId.slice(0, 8)}] Cannot save review action:`, error);
    return res.status(status).json({ error: status === 404 ? 'Задание не найдено.' : 'Не удалось сохранить решение проверки.' });
  }
});

app.get('/api/health', async (_req, res) => {
  const qwenModel = process.env.QWEN_MODEL || 'qwen3-vl:4b';
  const tagsUrl = process.env.OLLAMA_TAGS_URL ||
    (process.env.OLLAMA_CHAT_URL || 'http://127.0.0.1:11434/api/chat').replace(/\/api\/chat\/?$/, '/api/tags');

  let ollama = { reachable: false, modelInstalled: false, model: qwenModel, error: null, hint: null };

  try {
    const response = await fetch(tagsUrl, { cache: 'no-store', signal: AbortSignal.timeout(3500) });
    if (!response.ok) throw new Error(`Ollama API вернула HTTP ${response.status}`);
    const data = await response.json();
    const models = Array.isArray(data.models) ? data.models : [];
    const names = models.map(item => String(item.name || item.model || '')).filter(Boolean);

    ollama.reachable = true;
    ollama.models = names;
    ollama.modelInstalled = names.some(name =>
      name === qwenModel ||
      name === `${qwenModel}:latest` ||
      name.replace(/:latest$/, '') === qwenModel.replace(/:latest$/, '')
    );

    if (!ollama.modelInstalled) {
      ollama.error = `Модель ${qwenModel} не найдена. Установлены: ${names.join(', ') || 'нет моделей'}.`;
      ollama.hint = `Выполните: docker compose exec ollama ollama pull ${qwenModel}`;
    }
  } catch (error) {
    ollama.error = String(error?.message || error).slice(0, 240);
    ollama.hint = 'Проверьте, что Ollama запущена и доступна по OLLAMA_TAGS_URL из контейнера app.';
  }

  res.json({
    ok: true,
    version: '4.3.20',
    drawingTemplateConfigured: Boolean(await readTemplateMeta().catch(() => null)),
    pythonJobTimeoutMs: PYTHON_TIMEOUT_MS,
    mode: 'cad-reconstruction-engine',
    geometry: 'PIPE_MAIN uses OCR-aware OpenCV routes, source-ink-validated Qwen traces, and topology-scored multi-branch networks; isolated strokes and uncertain joins remain review-only; text stays in TEXT_REVIEW',
    ocr: 'Qwen3-VL 3x3 tiled handwriting OCR + Tesseract confidence filtering + separate per-row OCR for dense numbered notes; failed rows remain TEXT_REVIEW masks',
    qwenModel,
    qwenLimits: {
      ocrTimeoutSeconds: Number(process.env.QWEN_OCR_TIMEOUT || 180),
      tileRetryBudget: Number(process.env.QWEN_TILE_RETRY_BUDGET || 0),
      ocrMaxTokens: Number(process.env.QWEN_OCR_MAX_TOKENS || 2048),
      ocrBlockMaxTokens: Number(process.env.QWEN_OCR_BLOCK_MAX_TOKENS || 1536),
      ocrRowMaxTokens: 220,
      pipeTraceTimeoutSeconds: Number(process.env.QWEN_PIPE_TRACE_TIMEOUT || 240),
      pipeMaxTokens: Number(process.env.QWEN_PIPE_MAX_TOKENS || 2048),
      pipeTileGrid: Number(process.env.QWEN_PIPE_TILE_GRID || 3),
      pipeUpscale: Number(process.env.QWEN_PIPE_UPSCALE || 1.8),
      pipeTileOverlap: Number(process.env.QWEN_PIPE_TILE_OVERLAP || 0.14),
      ocrTileGrid: Number(process.env.QWEN_OCR_TILE_GRID || 3),
      ocrUpscale: Number(process.env.QWEN_OCR_UPSCALE || 2),
      modelKeepAlive: process.env.QWEN_KEEP_ALIVE || '10m'
    },
    ollamaConfigured: Boolean(process.env.OLLAMA_CHAT_URL),
    ollamaRequiredForCleanCad: false,
    ollamaRequired: false,
    ollama
  });
});

app.post('/api/analyze', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Загрузите JPG, PNG, WEBP или TIFF.' });

  const streetId = String(req.body?.streetId || '');
  const buildingId = String(req.body?.buildingId || '');
  let selectedAddress = null;
  if (streetId || buildingId) {
    try {
      const library = await readAddressLibrary();
      selectedAddress = findBuilding(library, streetId, buildingId);
      if (!selectedAddress) {
        const fs = await import('node:fs/promises');
        await fs.rm(req.file.path, { force: true }).catch(() => {});
        return res.status(400).json({ error: 'Выбранная улица или дом больше не существуют. Обнови папки объектов.' });
      }
    } catch (error) {
      const fs = await import('node:fs/promises');
      await fs.rm(req.file.path, { force: true }).catch(() => {});
      return res.status(500).json({ error: 'Не удалось проверить папку выбранного дома.' });
    }
  }

  const id = randomUUID();
  const jobDir = path.join(DATA, id);
  await mkdir(jobDir, { recursive: true });

  const ext = path.extname(req.file.originalname || '').toLowerCase() || '.img';
  const sourcePath = path.join(jobDir, `source${ext}`);

  try {
    // Move uploaded temp file into isolated job folder.
    const fs = await import('node:fs/promises');
    await fs.copyFile(req.file.path, sourcePath);
    await fs.rm(req.file.path, { force: true });

    const progressPath = path.join(jobDir, 'progress.log');
    const templatePath = await pinTemplateReference(jobDir);
    const processorArgs = [path.join(__dirname, 'processor.py'), '--input', sourcePath, '--out', jobDir];
    if (templatePath) processorArgs.push('--template', templatePath);
    await runPythonStreaming(
      processorArgs,
      { jobId: id, progressPath, timeout: PYTHON_TIMEOUT_MS, maxBuffer: PYTHON_MAX_BUFFER }
    );

    const graph = JSON.parse(await readFile(path.join(jobDir, 'graph.json'), 'utf8'));
    attachJobUrls(id, graph, path.basename(sourcePath));
    graph.confirmedConnections = Array.isArray(graph.confirmedConnections) ? graph.confirmedConnections : [];
    if (selectedAddress) {
      const title = cleanLabel(req.body?.schemeTitle || path.basename(req.file.originalname || 'Схема', ext), 140) || 'Схема';
      try {
        await updateAddressLibrary(library => {
          const context = findBuilding(library, streetId, buildingId);
          if (!context) { const error = new Error('Выбранный дом удалён во время обработки.'); error.status = 404; throw error; }
          addSchemeToBuilding(library, context.street, context.building, {
            jobId: id, title, createdAt: new Date().toISOString(),
            uploadedBy: cleanLabel(req.body?.uploadedBy, 80), sourceName: path.basename(sourcePath)
          });
        });
        graph.librarySaved = true;
        graph.libraryLocation = { streetId, streetName: selectedAddress.street.name, buildingId, buildingName: selectedAddress.building.name };
      } catch (libraryError) {
        graph.librarySaved = false;
        graph.libraryError = String(libraryError?.message || libraryError).slice(0, 180);
        console.error(`[JOB ${id.slice(0, 8)}] Processed but failed to add to address library:`, libraryError);
      }
    }

    // Все показатели берутся из graph.summary, который формирует processor.py.
    // Значение MISSING означает, что поле не было записано Python-процессором.
    const summary = graph.summary && typeof graph.summary === 'object' ? graph.summary : {};
    const metric = (key) => summary[key] ?? 'MISSING';

    console.log(
      `[ENGINE ${id.slice(0, 8)}] segments=${metric('segment_candidates')} ` +
      `nodes=${metric('nodes')} edges=${metric('edges')} ` +
      `crossings=${metric('crossings_to_review')}`
    );

    const oq = graph.ocr?.qwen || {};
    const ot = graph.ocr?.tesseract || {};
    const st = graph.semanticTrace || {};
    console.log(
      `[ENGINE ${id.slice(0, 8)}] OCR Qwen=${oq.annotations || 0} ` +
      `tiles=${oq.successful_tiles || 0}/${oq.tiles || 0}; ` +
      `noteBlocks=${oq.block_annotations || 0} (${oq.block_passes || 0} passes); ` +
      `Tesseract=${ot.annotations || 0}; ` +
      `verifiedText=${metric('verified_annotations')}; ` +
      `textReview=${metric('text_review_annotations')}`
    );

    console.log(
      `[ENGINE ${id.slice(0, 8)}] PIPE Qwen routes=${st.routes || 0} ` +
      `raw=${st.raw_routes || 0} tiles=${st.successful_tiles || 0}/${st.tiles || 0}; ` +
      `rejected=${st.rejected_invalid || 0}+${st.rejected_low_confidence || 0}`
    );

    // Основные четыре показателя, которые нужно проверять после нового анализа.
    console.log(
      `[ENGINE ${id.slice(0, 8)}] CAD ` +
      `cad_primary_edges=${metric('cad_primary_edges')}; ` +
      `cad_review_edges=${metric('cad_review_edges')}; ` +
      `topology_network_candidate_components=${metric('topology_network_candidate_components')}; ` +
      `topology_network_primary_edges=${metric('topology_network_primary_edges')}; ` +
      `cad_primary_qwen_routes=${metric('cad_primary_qwen_routes')}; ` +
      `cad_primary_total_paths=${metric('cad_primary_total_paths')}; ` +
      `isolatedReview=${metric('isolated_strokes_kept_for_review')}`
    );

    console.log(
      `[ENGINE ${id.slice(0, 8)}] OCR-MASK ` +
      `boxes=${metric('text_regions_used_for_geometry_mask') !== 'MISSING'
        ? metric('text_regions_used_for_geometry_mask')
        : metric('geometry_excluded_text_regions')}; ` +
      `inkPixelsMasked=${metric('ink_pixels_inside_text_regions')}; ` +
      `textComponents=${metric('text_or_annotation_components')}; ` +
      `ambiguous=${metric('review_only_ambiguous_components')}`
    );

    // Возвращаем граф целиком: все четыре показателя также доступны в response.summary.
    return res.json(graph);
  } catch (error) {
    console.error(`[JOB ${id.slice(0, 8)}] Analyze failed:`, error?.stderr || error);
    const progressUrl = `/jobs/${id}/progress.log`;
    const details = [
      String(error?.stderr || '').slice(-900),
      String(error?.message || error).slice(-350)
    ].filter(Boolean).join('\n');

    return res.status(500).json({
      error: 'Не удалось проанализировать изображение.',
      details: `${details}\nЖурнал этапов: ${progressUrl}`,
      jobId: id,
      progressUrl
    });
  } finally {
    if (req.file?.path) {
      const fs = await import('node:fs/promises');
      await fs.rm(req.file.path, { force: true }).catch(() => {});
    }
  }
});

// Manual CAD editor API. This module only reads/writes DATA/.private/manual-cad;
// it does not call, proxy, or modify any VDGO route, service, database, or file.
app.get('/api/manual-cad/projects', async (_req, res) => {
  try {
    const entries = await readdir(MANUAL_CAD_DIR, { withFileTypes: true });
    const projects = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !isManualCadId(entry.name)) continue;
      try {
        const project = JSON.parse(await readFile(manualProjectPath(entry.name), 'utf8'));
        projects.push({ id: project.id, title: project.title, updatedAt: project.updatedAt,
          createdAt: project.createdAt, source: project.source || null,
          pipeCount: Array.isArray(project.pipes) ? project.pipes.length : 0 });
      } catch { /* ignore an incomplete project folder */ }
    }
    projects.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    return res.json({ ok: true, projects });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Не удалось получить список ручных чертежей.' });
  }
});

app.post('/api/manual-cad/projects', async (req, res) => {
  const id = randomUUID();
  const projectDir = path.join(MANUAL_CAD_DIR, id);
  try {
    await mkdir(projectDir, { recursive: true });
    const project = createManualCadProject({ id, title: cleanLabel(req.body?.title || 'Новая схема', 140) });
    await writeFile(manualProjectPath(id), JSON.stringify(project, null, 2), 'utf8');
    return res.status(201).json({ ok: true, project: manualProjectResponse(project) });
  } catch (error) {
    await rm(projectDir, { recursive: true, force: true }).catch(() => {});
    return res.status(500).json({ error: error.message || 'Не удалось создать ручной чертёж.' });
  }
});

app.get('/api/manual-cad/projects/:id', async (req, res) => {
  const { id } = req.params;
  if (!isManualCadId(id)) return res.status(400).json({ error: 'Некорректный ID проекта.' });
  try {
    const project = JSON.parse(await readFile(manualProjectPath(id), 'utf8'));
    return res.json({ ok: true, project: manualProjectResponse(project) });
  } catch (error) {
    return res.status(error?.code === 'ENOENT' ? 404 : 500).json({ error: 'Не удалось открыть ручной чертёж.' });
  }
});

app.put('/api/manual-cad/projects/:id', async (req, res) => {
  const { id } = req.params;
  if (!isManualCadId(id)) return res.status(400).json({ error: 'Некорректный ID проекта.' });
  try {
    const current = JSON.parse(await readFile(manualProjectPath(id), 'utf8'));
    const input = req.body?.project && typeof req.body.project === 'object' ? req.body.project : req.body;
    const project = normalizeManualCadProject(input, current);
    project.source = current.source || null;
    const target = manualProjectPath(id);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(project, null, 2), 'utf8');
    await rename(temporary, target);
    return res.json({ ok: true, project: manualProjectResponse(project) });
  } catch (error) {
    const status = error?.code === 'ENOENT' ? 404 : 400;
    return res.status(status).json({ error: error.message || 'Не удалось сохранить ручной чертёж.' });
  }
});

app.post('/api/manual-cad/projects/:id/source', manualSourceUpload.single('source'), async (req, res) => {
  const { id } = req.params;
  if (!isManualCadId(id)) {
    if (req.file?.path) await rm(req.file.path, { force: true }).catch(() => {});
    return res.status(400).json({ error: 'Некорректный ID проекта.' });
  }
  if (!req.file) return res.status(400).json({ error: 'Выбери JPG, PNG, WEBP или TIFF.' });
  try {
    const project = JSON.parse(await readFile(manualProjectPath(id), 'utf8'));
    const ext = path.extname(String(req.file.originalname || '')).toLowerCase();
    const allowed = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff']);
    if (!allowed.has(ext)) throw new Error('Неподдерживаемый формат изображения.');
    const fileName = `source${ext}`;
    const projectDir = path.dirname(manualProjectPath(id));
    await rename(req.file.path, path.join(projectDir, fileName));
    const width = Math.round(Math.max(100, Math.min(30000, Number(req.body?.width) || project.width || 1600)));
    const height = Math.round(Math.max(100, Math.min(30000, Number(req.body?.height) || project.height || 1000)));
    project.source = { fileName, originalName: cleanLabel(req.file.originalname, 180), size: req.file.size,
      uploadedAt: new Date().toISOString() };
    project.width = width;
    project.height = height;
    project.updatedAt = new Date().toISOString();
    await writeFile(manualProjectPath(id), JSON.stringify(project, null, 2), 'utf8');
    return res.json({ ok: true, project: manualProjectResponse(project) });
  } catch (error) {
    if (req.file?.path) await rm(req.file.path, { force: true }).catch(() => {});
    const status = error?.code === 'ENOENT' ? 404 : 400;
    return res.status(status).json({ error: error.message || 'Не удалось загрузить исходный эскиз.' });
  }
});

app.get('/api/manual-cad/projects/:id/source', async (req, res) => {
  const { id } = req.params;
  if (!isManualCadId(id)) return res.status(400).end();
  try {
    const project = JSON.parse(await readFile(manualProjectPath(id), 'utf8'));
    const fileName = path.basename(String(project.source?.fileName || ''));
    if (!fileName || !/^source\.(jpe?g|png|webp|tiff?)$/i.test(fileName)) return res.status(404).json({ error: 'Подложка не загружена.' });
    return res.sendFile(path.join(path.dirname(manualProjectPath(id)), fileName));
  } catch (error) {
    return res.status(error?.code === 'ENOENT' ? 404 : 500).json({ error: 'Не удалось открыть подложку.' });
  }
});

app.get('/api/manual-cad/projects/:id/export.svg', async (req, res) => {
  const { id } = req.params;
  if (!isManualCadId(id)) return res.status(400).end();
  try {
    const project = JSON.parse(await readFile(manualProjectPath(id), 'utf8'));
    const svg = renderManualCadSvg(project);
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="manual-cad-${id.slice(0, 8)}.svg"`);
    return res.send(svg);
  } catch (error) {
    return res.status(error?.code === 'ENOENT' ? 404 : 500).json({ error: 'Не удалось сформировать SVG.' });
  }
});

app.get('/api/manual-cad/projects/:id/export.dxf', async (req, res) => {
  const { id } = req.params;
  if (!isManualCadId(id)) return res.status(400).end();
  try {
    const project = JSON.parse(await readFile(manualProjectPath(id), 'utf8'));
    const dxf = renderManualCadDxf(project);
    res.setHeader('Content-Type', 'application/dxf; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="manual-cad-${id.slice(0, 8)}.dxf"`);
    return res.send(dxf);
  } catch (error) {
    return res.status(error?.code === 'ENOENT' ? 404 : 500).json({ error: 'Не удалось сформировать DXF.' });
  }
});

app.get(/^(?!\/api(?:\/|$)).*/, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'), {
    headers: { 'Cache-Control': 'no-store, max-age=0' }
  });
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'API-маршрут не найден.' }));

app.use((err, req, res, _next) => {
  console.error(err);
  const isTemplateUpload = req.path === '/api/template';
  const status = err?.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
  const message = err?.code === 'LIMIT_FILE_SIZE'
    ? (isTemplateUpload ? 'Файл шаблона больше 30 МБ.' : 'Файл больше 18 МБ.')
    : err?.code === 'LIMIT_UNEXPECTED_FILE'
      ? 'Можно загрузить только один файл за раз.'
      : 'Ошибка запроса.';
  res.status(status).json({ error: message, details: err.message });
});

app.listen(PORT, process.env.HOST || '0.0.0.0', () => {
  console.log(`CAD Reconstruction Engine 4.3.20: http://${process.env.HOST || '0.0.0.0'}:${PORT}`);
  console.log('Geometry: OCR-masked OpenCV routes, supported short branches and ink-validated Qwen routes for PIPE_MAIN; review geometry remains separate.');
  console.log(`Python timeout: ${PYTHON_TIMEOUT_MS} ms (${Math.round(PYTHON_TIMEOUT_MS / 60_000)} minutes)`);
  console.log(`Manual CAD projects: ${MANUAL_CAD_DIR} (isolated from VDGO)`);
});
