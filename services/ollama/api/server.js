import express from 'express';
import helmet from 'helmet';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import multer from 'multer';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, readdir, copyFile, rm, chmod } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import {
  createManualCadProject,
  createManualCadProjectFromGraph,
  normalizeManualCadProject,
  renderManualCadSvg,
  renderManualCadDxf,
  isManualCadId,
} from './domain/manual-cad-core.js';
import { createWorkforceSystem } from './services/workforce-system.js';
import {
  validateBody,
  streetSchema,
  buildingSchema,
  manualProjectCreateSchema,
  connectionSchema,
  reviewSchema,
} from './validation/schemas.js';
import {
  logger,
  jobLogger,
  shortJobId,
  parseProgressLine,
  renderProgressLine,
  requestLogger,
  requestIdHeader,
  logRequestError,
} from './lib/logger.js';
import { requirePostgres } from './repositories/db.js';
import { sendJsonConditional } from './lib/etag.js';
import { createPostgresRateLimitStore } from './repositories/rate-limit-store.js';
import {
  fetchManualProject,
  fetchManualProjects,
  saveManualProject,
  saveManualProjectIfRevision,
  findManualProjectBySourceJob,
  findManualProjectBySourceReport,
} from './repositories/manual-cad-repo.js';
import {
  fetchAddressLibrary as fetchAddressLibraryPg,
  saveAddressLibrary as saveAddressLibraryPg,
} from './repositories/address-library-repo.js';
import {
  fetchSchemeMeta as fetchSchemeMetaPg,
  saveSchemeMeta as saveSchemeMetaPg,
} from './repositories/scheme-meta-repo.js';
import { findIdempotency, saveIdempotency } from './repositories/postgres-repo.js';
import { appVersion } from './lib/version.js';
import { createTemplateStore } from './services/template-store.js';
import { cleanLabel } from './domain/text.js';
import { createTemplateRouter } from './routes/template-routes.js';
import { createSettingsRouter } from './routes/settings-routes.js';
import { createHealthChecks } from './services/health.js';
import { createLibraryRouter } from './routes/library-routes.js';
import { createSchemeRouter } from './routes/scheme-routes.js';
import { createJobsRouter } from './routes/job-routes.js';
import { createManualCadRouter } from './routes/manual-cad-routes.js';
import { createSpaRouter } from './routes/spa-routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Fingerprint the actual loaded sources, not a manually maintained release label.
const BUILD_INFO = {
  version: appVersion(),
  pipelineSha256: createHash('sha256')
    .update(
      Buffer.concat(
        await Promise.all(
          [
            '../engine/processor.py',
            '../engine/model/clean_layout.py',
            '../engine/model/drawing_template.py',
            'domain/manual-cad-core.js',
            'services/workforce-system.js',
            'server.js',
          ].map((name) => readFile(path.join(__dirname, name))),
        ),
      ),
    )
    .digest('hex'),
};
const app = express();
if (process.env.TRUST_GATEWAY_PROXY === '1') app.set('trust proxy', 1);
const PORT = Number(process.env.PORT || 3000);
const PYTHON = process.env.MASK_PYTHON || '/opt/venv/bin/python';
// The engine is a package (engine.processor); run it as a module so its
// intra-package absolute imports resolve. cwd is services/ollama.
const ENGINE_ROOT = path.join(__dirname, '..');
const ENGINE_MODULE = ['-m', 'engine.processor'];
const DATA = process.env.DATA_DIR || path.join(os.tmpdir(), 'cad-reconstruction-jobs');
const UPLOAD_DIR = path.join(os.tmpdir(), 'cad-reconstruction-uploads');
// Hidden metadata directory is inside the named cad_jobs volume, but is not
// exposed by the /jobs static file route.
const LIBRARY_DIR = path.join(DATA, '.private');
const LIBRARY_PATH = path.join(LIBRARY_DIR, 'address-library.json');
const SCHEME_META_DIR = path.join(LIBRARY_DIR, 'schemes');
// The global drawing-style reference is stored in the same named Docker volume
// as the address library, not in /tmp and never inside an individual house job.
// Persistence lives in template-store.js (P2-1).
// Manual CAD projects are isolated from automatic analysis jobs and from the VDGO app.
const MANUAL_CAD_DIR = path.join(LIBRARY_DIR, 'manual-cad');
const LEGACY_YANDEX_CONFIG_PATH = path.join(LIBRARY_DIR, 'yandex-ai-settings.json');

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

// Last-resort handlers. Without them a crash or a rejected promise leaves no
// structured record, and `docker compose ps` only shows "exited with code 1".
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason instanceof Error ? reason : new Error(String(reason)) }, 'Unhandled promise rejection');
});
process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'Uncaught exception; shutting down');
  process.exit(1);
});

await mkdir(DATA, { recursive: true });
await mkdir(LIBRARY_DIR, { recursive: true, mode: 0o700 });
await chmod(LIBRARY_DIR, 0o700).catch(() => {});
// Yandex integration was retired at the user's request. Remove only its private
// settings file; address data, CAD projects, templates and other app data remain.
await rm(LEGACY_YANDEX_CONFIG_PATH, { force: true }).catch(() => {});
// Fail fast before binding a port if the database is not configured.
requirePostgres();
await mkdir(SCHEME_META_DIR, { recursive: true });

await mkdir(MANUAL_CAD_DIR, { recursive: true });
await mkdir(UPLOAD_DIR, { recursive: true });
const templateStore = createTemplateStore({ libraryDir: LIBRARY_DIR, cleanLabel });
await templateStore.ensureDir();
const workforceSystem = await createWorkforceSystem({
  dataDir: LIBRARY_DIR,
  uploadDir: UPLOAD_DIR,
  secureCookies: process.env.COOKIE_SECURE === '1',
  onSketchSubmitted: createWorkforceSchemeJob,
  getSketchStatus: getWorkforceSchemeStatus,
});

function localRecognitionPythonEnvironment() {
  return {
    MOSS_API_KEY: '',
    MOSS_OCR_ENABLED: '0',
    MOSS_PIPE_ENABLED: '0',
    OPENROUTER_API_KEY: '',
    OPENROUTER_OCR_ENABLED: '0',
    OPENROUTER_PIPE_ENABLED: '0',
    RECOGNITION_MODE: 'local-qwen-tesseract',
  };
}

// Analyses are intentionally queued one at a time: the target GTX 1060 has
// limited VRAM, and concurrent Qwen requests would compete for the same GPU.
const activeAnalyses = new Map();
const analysisQueue = [];
const queuedAnalysisIds = new Set();
let analysisQueueRunning = false;

// Every Python analysis is CPU/RAM heavy and talks to the same single-GPU
// Ollama. A single global slot protects the container from unbounded forks;
// stored schemes wait their turn, while the legacy synchronous /api/analyze
// endpoint rejects with 429 instead of queueing an HTTP request for 90 minutes.
const MAX_CONCURRENT_PYTHON_JOBS = Math.max(1, Number(process.env.MAX_CONCURRENT_PYTHON_JOBS || 1));
const activePythonChildren = new Set();
let runningPythonJobs = 0;
const pythonJobWaiters = [];

function pythonSlotAvailable() {
  return runningPythonJobs < MAX_CONCURRENT_PYTHON_JOBS;
}

function tryAcquirePythonSlot() {
  if (!pythonSlotAvailable()) return false;
  runningPythonJobs += 1;
  return true;
}

function acquirePythonSlot() {
  if (tryAcquirePythonSlot()) return Promise.resolve();
  return new Promise((resolve) => pythonJobWaiters.push(resolve));
}

function releasePythonSlot() {
  const next = pythonJobWaiters.shift();
  if (next) {
    next();
    return;
  }
  runningPythonJobs = Math.max(0, runningPythonJobs - 1);
}

function runPythonStreaming(
  args,
  { jobId, progressPath, timeout = PYTHON_TIMEOUT_MS, maxBuffer = PYTHON_MAX_BUFFER, env = null },
) {
  return new Promise((resolve, reject) => {
    const shortId = String(jobId).slice(0, 8);
    const child = spawn(PYTHON, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // Required for `python -m engine.processor`: the package lives here.
      cwd: ENGINE_ROOT,
      env: env ? { ...process.env, ...env } : process.env,
    });
    activePythonChildren.add(child);
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
    // eslint-disable-next-line prefer-const -- assigned after handlers are registered
    let timeoutHandle; // assigned below; complete() may run before that assignment
    let forceKillHandle;

    const jobLog = jobLogger(shortId, { source: 'python' });
    const LOG_METHODS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

    progressFile.on('error', (error) => {
      progressFileFailed = true;
      jobLog.error({ err: error, progressPath }, 'Cannot persist progress.log');
    });

    // Python writes either a structured event or a plain text line. Only events
    // carrying a `stage` are progress messages: those are rendered into the
    // historical `[STAGE] message` text of progress.log. Everything else
    // (engine diagnostics, third-party library records) is logged as JSON on
    // stdout only, so progress.log stays a clean, user-facing journal.
    const logLine = (line) => {
      const parsed = parseProgressLine(line);
      if (parsed.structured) {
        const record = parsed.record;
        const { msg, stage, level, ...fields } = record;
        const method = LOG_METHODS.has(level) ? level : 'info';
        jobLog[method]({ stage: stage || null, ...fields }, msg);
        if (typeof stage === 'string' && stage) {
          const text = renderProgressLine(record);
          if (!text) return;
          if (!progressFileFailed && !progressFile.destroyed && progressFile.writable) {
            progressFile.write(`${new Date().toISOString()} ${text}\n`);
          }
        }
        return;
      }
      const message = parsed.message;
      if (!message) return;
      jobLog.info({ stage: 'PYTHON' }, message);
      if (!progressFileFailed && !progressFile.destroyed && progressFile.writable) {
        progressFile.write(`${new Date().toISOString()} ${message}\n`);
      }
    };

    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const complete = (code, signal) => {
      activePythonChildren.delete(child);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (forceKillHandle) clearTimeout(forceKillHandle);
      if (stderrPending.trim()) logLine(stderrPending);

      const finish = () => {
        if (spawnError) {
          fail(Object.assign(spawnError, { stderr: stderrTail, stdout }));
        } else if (timedOut) {
          const error = new Error(
            `Python job exceeded ${Math.round(timeout / 60_000)} minute timeout and was terminated.`,
          );
          Object.assign(error, {
            code: 'ETIMEDOUT',
            killed: true,
            signal: signal || 'SIGTERM',
            stderr: stderrTail,
            stdout,
          });
          fail(error);
        } else if (outputOverflow) {
          const error = new Error(`Python stdout exceeded the ${maxBuffer} byte output limit.`);
          Object.assign(error, {
            code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
            killed: true,
            signal: signal || 'SIGTERM',
            stderr: stderrTail,
            stdout,
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

// Correlation ids and access logging run before every other middleware so each
// request has a stable id that is also echoed back as X-Request-Id.
app.use(requestLogger);
app.use(requestIdHeader);

// This app is commonly opened over plain HTTP on a private LAN (e.g. http://192.168.x.x:3001).
// Helmet's default CSP includes upgrade-insecure-requests, which makes browsers rewrite
// the relative CSS/JS URLs to HTTPS. There is no TLS listener in this container, so assets
// then fail with ERR_SSL_PROTOCOL_ERROR and the page appears as unstyled HTML.
// Use an explicit CSP without upgrade-insecure-requests for this offline/LAN deployment.
app.use(
  helmet({
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
        connectSrc: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: false,
    originAgentCluster: false,
    hsts: false,
  }),
);

app.use(express.json({ limit: '15mb' }));
// Session and role checks run before static pages, uploaded job files and API routes.
app.use(workforceSystem.authMiddleware);
// Shared counters so several API instances enforce one quota (P1-11).
const authStore = createPostgresRateLimitStore({ bucket: 'auth', windowMs: 15 * 60_000, prefix: 'ip:' });
const heavyStore = createPostgresRateLimitStore({
  bucket: 'heavy',
  windowMs: Number(process.env.HEAVY_QUOTA_WINDOW_MS || 60_000),
});
const uploadStore = createPostgresRateLimitStore({ bucket: 'upload', windowMs: 60_000 });
const authRateLimit = rateLimit({
  windowMs: 15 * 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  store: authStore,
  message: { error: 'Слишком много попыток входа. Повторите позже.' },
});
app.use('/api/auth/login', authRateLimit);
app.use('/api/auth/setup', authRateLimit);
const limitHeavyRequests = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  store: uploadStore,
  message: { error: 'Слишком много запросов на загрузку или обработку. Повторите попытку через минуту.' },
});
// Per-user quota: authenticated users are limited by account id rather than IP so
// one busy office cannot starve another behind the same NAT/gateway. Falls back
// to IP for anonymous requests (normalized for IPv6 via ipKeyGenerator).
const heavyQuota = rateLimit({
  windowMs: Number(process.env.HEAVY_QUOTA_WINDOW_MS || 60_000),
  limit: Number(process.env.HEAVY_QUOTA_LIMIT || 30),
  standardHeaders: true,
  legacyHeaders: false,
  store: heavyStore,
  keyGenerator: (req) => {
    if (req.user?.id) return `user:${req.user.id}`;
    // express-rate-limit v8 requires this helper for correct IPv6 handling.
    return `ip:${ipKeyGenerator(req.ip)}`;
  },
  message: { error: 'Превышена квота на тяжёлые операции. Повторите попытку позже.' },
});
// Opportunistic prune of stale rate-limit windows (P1-11).
const rateLimitCleanup = setInterval(
  () => {
    void authStore.cleanup();
    void heavyStore.cleanup();
    void uploadStore.cleanup();
  },
  60 * 60 * 1000,
);
rateLimitCleanup.unref();

app.use(
  express.static(path.join(__dirname, '../../../frontend/public'), {
    maxAge: 0,
    setHeaders(res, filePath) {
      if (/\.(html|css|js)$/.test(filePath)) res.setHeader('Cache-Control', 'no-store, max-age=0');
    },
  }),
);
app.use('/jobs', express.static(DATA, { maxAge: '1h', dotfiles: 'deny', index: false }));

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 18 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const extOk = /\.(jpe?g|png|webp|tiff?)$/i.test(file.originalname || '');
    const mimeOk = /^image\/(jpeg|png|webp|tiff|x-tiff)$/.test(file.mimetype || '');
    cb(null, extOk || mimeOk);
  },
});

const manualSourceUpload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 18 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const extOk = /\.(jpe?g|png|webp|tiff?)$/i.test(file.originalname || '');
    const mimeOk = /^image\/(jpeg|png|webp|tiff|x-tiff)$/.test(file.mimetype || '');
    cb(null, extOk || mimeOk);
  },
});

function rasterDimensions(buffer) {
  try {
    if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = buffer[offset + 1];
        offset += 2;
        if (marker === 0xd9 || marker === 0xda) break;
        if (offset + 2 > buffer.length) break;
        const length = buffer.readUInt16BE(offset);
        if (
          [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) &&
          offset + 7 < buffer.length
        ) {
          return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) };
        }
        if (length < 2) break;
        offset += length;
      }
    }
    if (
      buffer.length >= 30 &&
      buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WEBP'
    ) {
      const type = buffer.toString('ascii', 12, 16);
      if (type === 'VP8X') return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
      if (type === 'VP8 ') return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
      if (type === 'VP8L' && buffer[20] === 0x2f) {
        const bits = buffer.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
    }
    if (buffer.length >= 16 && ['II', 'MM'].includes(buffer.toString('ascii', 0, 2))) {
      const little = buffer.toString('ascii', 0, 2) === 'II';
      const read16 = (off) => (little ? buffer.readUInt16LE(off) : buffer.readUInt16BE(off));
      const read32 = (off) => (little ? buffer.readUInt32LE(off) : buffer.readUInt32BE(off));
      if (read16(2) === 42) {
        const ifd = read32(4);
        const count = Math.min(512, read16(ifd));
        let width = 0,
          height = 0;
        for (let i = 0; i < count; i += 1) {
          const entry = ifd + 2 + i * 12;
          if (entry + 12 > buffer.length) break;
          const tag = read16(entry),
            type = read16(entry + 2),
            items = read32(entry + 4);
          if (![256, 257].includes(tag) || items < 1) continue;
          let value = 0;
          if (type === 3) value = read16(entry + 8);
          else if (type === 4) value = read32(entry + 8);
          if (tag === 256) width = value;
          if (tag === 257) height = value;
        }
        if (width > 0 && height > 0) return { width, height };
      }
    }
  } catch {
    /* malformed image: use a neutral canvas size */
  }
  return { width: 1600, height: 1000 };
}

function manualProjectPath(id) {
  return path.join(MANUAL_CAD_DIR, id, 'project.json');
}

async function readManualProject(id) {
  const project = await fetchManualProject(id);
  if (!project) {
    const error = new Error('Не удалось открыть ручной чертёж.');
    error.code = 'ENOENT';
    throw error;
  }
  return project;
}

async function writeManualProject(project) {
  await saveManualProject(project);
}

/**
 * Optimistic-concurrency write: Postgres updateMany is atomic, so a stale
 * revision is rejected. Returns 'ok' | 'conflict' | 'missing'.
 */
async function writeManualProjectIfRevision(project, expectedRevision) {
  const expected = Math.max(0, Number(expectedRevision || 0));
  return saveManualProjectIfRevision(project, expected);
}

async function listManualProjects() {
  return fetchManualProjects();
}

async function findManualCadProjectForJob(jobId) {
  return findManualProjectBySourceJob(jobId);
}

async function findManualCadProjectForReport(reportId) {
  return findManualProjectBySourceReport(reportId);
}

async function backfillManualCadProjects() {
  const entries = await readdir(MANUAL_CAD_DIR, { withFileTypes: true }).catch((error) => {
    logger.warn({ err: error, dir: MANUAL_CAD_DIR }, 'Cannot scan legacy manual CAD directory');
    return [];
  });
  logger.info({ count: entries.length, dir: MANUAL_CAD_DIR }, 'Manual CAD backfill scan');
  let imported = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !isManualCadId(entry.name)) continue;
    try {
      const project = JSON.parse(await readFile(manualProjectPath(entry.name), 'utf8'));
      await saveManualProject(project);
      imported += 1;
    } catch (error) {
      logger.warn({ err: error, id: entry.name }, 'Cannot import legacy manual CAD project');
    }
  }
  if (imported) logger.info({ count: imported }, 'Imported legacy manual CAD projects into PostgreSQL');
}

function manualProjectResponse(project) {
  return {
    ...project,
    sourceUrl: project.source?.fileName ? `/api/manual-cad/projects/${project.id}/source` : null,
    previewUrl: `/api/manual-cad/projects/${project.id}/preview.svg`,
    editUrl: `/manual-cad.html?project=${encodeURIComponent(project.id)}`,
    returnUrl: project.sourceReportId
      ? `/workforce.html?report=${encodeURIComponent(project.sourceReportId)}`
      : project.sourceJobId
        ? `/?job=${encodeURIComponent(project.sourceJobId)}`
        : '/',
  };
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
  // Attach release-specific export URLs only to jobs that actually contain
  // the new artifacts. Historical jobs keep their legacy clean.svg/drawing.dxf
  // links instead of receiving dead links to files that were never generated.
  if (graph.referenceTrace?.available) {
    graph.referenceTraceSvgUrl = `/jobs/${jobId}/reference-trace.svg`;
    graph.referenceTraceDxfUrl = `/jobs/${jobId}/reference-trace.dxf`;
  }
  if (graph.centerlineTrace?.available) {
    graph.centerlineTraceSvgUrl = `/jobs/${jobId}/centerline-trace.svg`;
    graph.centerlineTraceDxfUrl = `/jobs/${jobId}/centerline-trace.dxf`;
  }
  if (graph.referenceTrace?.available || graph.centerlineTrace?.available) {
    graph.cadDraftSvgUrl = `/jobs/${jobId}/cad-draft.svg`;
    graph.cadDraftDxfUrl = `/jobs/${jobId}/cad-draft.dxf`;
  }
  if (graph.cadAlignmentOverlay?.available) graph.cadAlignmentOverlayUrl = `/jobs/${jobId}/cad-alignment-overlay.png`;
  graph.diagnosticsUrl = `/jobs/${jobId}/diagnostics.json`;
  graph.confirmedConnections = Array.isArray(graph.confirmedConnections) ? graph.confirmedConnections : [];
  graph.joinCandidates = Array.isArray(graph.joinCandidates) ? graph.joinCandidates : [];
  return graph;
}

// Template persistence lives in template-store.js; these thin wrappers keep the
// existing call sites (pinTemplateReference, readyz) working unchanged.
async function readTemplateMeta() {
  return templateStore.readMeta();
}

// Pin the selected reference sheet into each job folder so a later retry uses
// the same page profile even if the global template is replaced in settings.
async function pinTemplateReference(jobDir) {
  // Keep the original reference used by a job even after a global replacement.
  const existing = (await readdir(jobDir)).find((name) => /^\.drawing-template-reference\.[a-z0-9]+$/i.test(name));
  if (existing) return path.join(jobDir, existing);
  const meta = await readTemplateMeta();
  if (!meta) return null;
  const extension = path.extname(meta.storageName).toLowerCase() || '.bin';
  const snapshotName = `.drawing-template-reference${extension}`;
  const snapshotPath = path.join(jobDir, snapshotName);
  const sourcePath = templateStore.absolutePath(meta.storageName);
  await copyFile(sourcePath, snapshotPath);
  return snapshotPath;
}

async function readAddressLibraryFile() {
  try {
    const parsed = JSON.parse(await readFile(LIBRARY_PATH, 'utf8'));
    return {
      schemaVersion: 1,
      streets: Array.isArray(parsed.streets)
        ? parsed.streets.map((street) => ({
            id: String(street.id || ''),
            name: cleanLabel(street.name),
            createdAt: street.createdAt || null,
            buildings: Array.isArray(street.buildings)
              ? street.buildings.map((building) => ({
                  id: String(building.id || ''),
                  name: cleanLabel(building.name),
                  createdAt: building.createdAt || null,
                  schemes: Array.isArray(building.schemes)
                    ? building.schemes
                        .filter((item) => item && JOB_ID_PATTERN.test(String(item.jobId || '')))
                        .map((item) => ({
                          jobId: String(item.jobId),
                          title: cleanLabel(item.title || 'Схема', 140),
                          createdAt: item.createdAt || null,
                          uploadedBy: cleanLabel(item.uploadedBy || '', 80),
                          sourceName: cleanLabel(item.sourceName || '', 180),
                          status: ['pending', 'queued', 'processing', 'completed', 'failed'].includes(item.status)
                            ? item.status
                            : 'completed',
                          originalName: cleanLabel(item.originalName || item.title || 'Эскиз', 180),
                          error: cleanLabel(item.error || '', 240),
                          updatedAt: item.updatedAt || item.createdAt || null,
                          completedAt: item.completedAt || null,
                        }))
                    : [],
                }))
              : [],
          }))
        : [],
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { schemaVersion: 1, streets: [] };
    throw error;
  }
}

async function readAddressLibrary() {
  return fetchAddressLibraryPg();
}

async function saveAddressLibrary(library) {
  await saveAddressLibraryPg(library);
}

/**
 * In-memory index of `jobId -> { streetId, buildingId }` for one library
 * snapshot (P2-5). `findScheme` used to walk every street/building/scheme on
 * each of its six call sites; the index answers a lookup in O(1) and is rebuilt
 * only when the library object changes.
 */
let schemeIndexSource = null;
let schemeIndex = new Map();

function buildSchemeIndex(library) {
  const index = new Map();
  for (const street of library.streets || []) {
    for (const building of street.buildings || []) {
      for (const scheme of building.schemes || []) {
        if (scheme?.jobId) index.set(scheme.jobId, { streetId: street.id, buildingId: building.id });
      }
    }
  }
  return index;
}

function getSchemeIndex(library) {
  if (schemeIndexSource !== library) {
    schemeIndexSource = library;
    schemeIndex = buildSchemeIndex(library);
  }
  return schemeIndex;
}

async function backfillAddressLibrary() {
  const stored = await fetchAddressLibraryPg();
  if (stored) return;
  const legacy = await readAddressLibraryFile();
  if (Array.isArray(legacy.streets) && legacy.streets.length) {
    await saveAddressLibraryPg(legacy);
    logger.info({ streets: legacy.streets.length }, 'Imported legacy address-library.json into PostgreSQL');
  }
}

let addressLibraryWriteQueue = Promise.resolve();
function updateAddressLibrary(mutator) {
  const task = addressLibraryWriteQueue.then(async () => {
    // A fresh instance has no library yet; start from an empty document instead
    // of crashing on `null.streets`.
    const stored = await readAddressLibrary();
    const library = stored && typeof stored === 'object' ? stored : { schemaVersion: 1, streets: [], buildings: [] };
    if (!Array.isArray(library.streets)) library.streets = [];
    if (!Array.isArray(library.buildings)) library.buildings = [];
    const result = await mutator(library);
    await saveAddressLibrary(library);
    return result;
  });
  addressLibraryWriteQueue = task.catch(() => {});
  return task;
}

function findBuilding(library, streetId, buildingId) {
  const street = library.streets.find((item) => item.id === streetId);
  const building = street?.buildings.find((item) => item.id === buildingId);
  return street && building ? { street, building } : null;
}

function addSchemeToBuilding(library, street, building, scheme) {
  // A job belongs to one address at a time. Moving it removes stale links
  // from any previous building before the new reference is written.
  for (const item of library.streets) {
    for (const house of item.buildings) {
      house.schemes = house.schemes.filter((existing) => existing.jobId !== scheme.jobId);
    }
  }
  building.schemes.unshift(scheme);
  building.schemes.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

function findScheme(library, jobId) {
  const hit = getSchemeIndex(library).get(jobId);
  if (hit) {
    const street = library.streets.find((item) => item.id === hit.streetId);
    const building = street?.buildings.find((item) => item.id === hit.buildingId);
    const scheme = building?.schemes.find((item) => item.jobId === jobId);
    if (scheme) return { street, building, scheme };
  }
  // Fallback for a stale index (e.g. the library was mutated in place).
  for (const street of library.streets) {
    for (const building of street.buildings) {
      const scheme = building.schemes.find((item) => item.jobId === jobId);
      if (scheme) return { street, building, scheme };
    }
  }
  return null;
}

async function readSchemeMeta(jobId) {
  return fetchSchemeMetaPg(jobId);
}

async function writeSchemeMeta(jobId, meta) {
  await saveSchemeMetaPg(jobId, meta);
}

async function backfillSchemeMeta() {
  const entries = await readdir(SCHEME_META_DIR, { withFileTypes: true }).catch(() => []);
  let imported = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const jobId = entry.name.slice(0, -5);
    if (!JOB_ID_PATTERN.test(jobId)) continue;
    try {
      const meta = JSON.parse(await readFile(path.join(SCHEME_META_DIR, entry.name), 'utf8'));
      await saveSchemeMetaPg(jobId, meta);
      imported += 1;
    } catch {
      /* ignore incomplete legacy scheme meta */
    }
  }
  if (imported) logger.info({ count: imported }, 'Imported legacy scheme meta into PostgreSQL');
}

async function updateSchemeStatus(jobId, status, extra = {}) {
  const existing = (await readSchemeMeta(jobId)) || { jobId };
  const updated = { ...existing, ...extra, status, updatedAt: new Date().toISOString() };
  await writeSchemeMeta(jobId, updated);
  await updateAddressLibrary((library) => {
    const found = findScheme(library, jobId);
    if (found)
      Object.assign(found.scheme, {
        status,
        error: cleanLabel(updated.error || '', 240),
        updatedAt: updated.updatedAt,
        completedAt: updated.completedAt || null,
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
  const processorArgs = [...ENGINE_MODULE, '--input', sourcePath, '--out', jobDir];
  if (templatePath) processorArgs.push('--template', templatePath);
  if (meta.rotationDegrees != null && [0, 90, 180, 270].includes(Number(meta.rotationDegrees)))
    processorArgs.push('--rotation', String(Number(meta.rotationDegrees)));
  await acquirePythonSlot();
  try {
    await runPythonStreaming(processorArgs, {
      jobId,
      progressPath,
      timeout: PYTHON_TIMEOUT_MS,
      maxBuffer: PYTHON_MAX_BUFFER,
      env: localRecognitionPythonEnvironment(),
    });
  } finally {
    releasePythonSlot();
  }
  const graph = JSON.parse(await readFile(path.join(jobDir, 'graph.json'), 'utf8'));
  if (!graph || !graph.image || !Array.isArray(graph.edges)) {
    throw new Error('Python обработчик создал неполный graph.json.');
  }
  if (graph.complete === false || graph.analysisStatus === 'incomplete') {
    const reasons = Array.isArray(graph.incompleteReasons) ? graph.incompleteReasons : [];
    const message = [
      'Обработка завершилась частично: не все этапы OCR или трассировки труб были завершены.',
      ...reasons.map((value) => String(value)).filter(Boolean),
      'Успешные локальные Qwen-плитки сохранены. Нажми «Повторить преобразование», чтобы повторить незавершённые этапы.',
    ].join(' ');
    await updateSchemeStatus(jobId, 'failed', {
      error: message.slice(0, 900),
      graphSummary: graph.summary || null,
      partialGraphReady: true,
      completedAt: null,
    });
    return graph;
  }
  await updateSchemeStatus(jobId, 'completed', {
    completedAt: new Date().toISOString(),
    error: '',
    graphSummary: graph.summary || null,
    partialGraphReady: false,
  });
  return graph;
}

async function markStoredAnalysisFailed(jobId, error) {
  jobLogger(jobId).error({ err: error, stderr: error?.stderr || null }, 'Stored scheme analysis failed');
  await updateSchemeStatus(jobId, 'failed', {
    error:
      `${String(error?.stderr || error?.message || error).slice(-650)} Если в .checkpoints уже есть успешные плитки, повторный запуск использует их и запросит только недостающие.`.slice(
        -900,
      ),
    partialGraphReady: await readFile(path.join(DATA, jobId, 'graph.json'))
      .then(() => true)
      .catch(() => false),
    completedAt: null,
  }).catch((statusError) =>
    logger.error({ err: statusError, jobId: shortJobId(jobId) }, 'Failed to save analysis error'),
  );
}

async function drainAnalysisQueue() {
  if (analysisQueueRunning) return;
  analysisQueueRunning = true;
  try {
    while (analysisQueue.length) {
      const jobId = analysisQueue.shift();
      queuedAnalysisIds.delete(jobId);
      // Reserve the GPU slot before awaiting metadata writes. Only one Qwen job
      // can run at a time on the target GTX 1060.
      activeAnalyses.set(jobId, Promise.resolve());
      try {
        await updateSchemeStatus(jobId, 'processing', {
          error: '',
          startedAt: new Date().toISOString(),
          completedAt: null,
          partialGraphReady: false,
          queuePosition: null,
        });
        const task = Promise.resolve()
          .then(() => runStoredSchemeAnalysis(jobId))
          .catch((error) => markStoredAnalysisFailed(jobId, error));
        activeAnalyses.set(jobId, task);
        await task;
      } catch (error) {
        await markStoredAnalysisFailed(jobId, error);
      } finally {
        activeAnalyses.delete(jobId);
      }
    }
  } finally {
    analysisQueueRunning = false;
    // A request can enqueue a new item while the final status write is pending.
    if (analysisQueue.length) void drainAnalysisQueue();
  }
}

async function enqueueStoredSchemeAnalysis(jobId) {
  if (activeAnalyses.has(jobId)) return 'processing';
  if (queuedAnalysisIds.has(jobId)) return 'queued';
  const willStartNow = !analysisQueueRunning && activeAnalyses.size === 0 && analysisQueue.length === 0;
  analysisQueue.push(jobId);
  queuedAnalysisIds.add(jobId);
  if (willStartNow) {
    void drainAnalysisQueue();
    return 'processing';
  }
  const queuePosition = analysisQueue.length;
  await updateSchemeStatus(jobId, 'queued', {
    error: '',
    queuePosition,
    queuedAt: new Date().toISOString(),
    completedAt: null,
  });
  return 'queued';
}

async function resumeStoredAnalysisQueue() {
  try {
    const library = await readAddressLibrary();
    const interrupted = [];
    // A fresh instance has no library yet (empty database); nothing to resume.
    for (const street of library?.streets || []) {
      for (const building of street.buildings || []) {
        for (const scheme of building.schemes || []) {
          if (!['queued', 'processing'].includes(String(scheme.status || ''))) continue;
          if (!JOB_ID_PATTERN.test(String(scheme.jobId || ''))) continue;
          const meta = await readSchemeMeta(scheme.jobId);
          if (meta?.sourceName) interrupted.push(scheme.jobId);
        }
      }
    }
    for (const jobId of interrupted) await enqueueStoredSchemeAnalysis(jobId);
    if (interrupted.length)
      logger.info(
        { count: interrupted.length, jobIds: interrupted.map(shortJobId) },
        'Resumed interrupted house-scheme jobs',
      );
  } catch (error) {
    logger.error({ err: error }, 'Could not restore interrupted house-scheme jobs');
  }
}

// Workforce hand sketches enter the same queued reconstruction pipeline as schemes
// uploaded through the house library. The report remains the source-of-truth for
// the notification/inbox workflow; this job provides the clean SVG, DXF and graph.
async function createWorkforceSchemeJob({ report, sourcePath }) {
  if (!report?.id || !sourcePath) throw new Error('Не хватает данных отчёта для создания CAD-задания.');
  const ext = path.extname(String(report.sketch?.originalName || sourcePath)).toLowerCase();
  if (!/^\.(?:jpe?g|png|webp|tiff?)$/.test(ext))
    throw new Error('Для автоматического преобразования нужен JPG, PNG, WEBP или TIFF.');

  const jobId = randomUUID();
  const jobDir = path.join(DATA, jobId);
  const sourceName = `source${ext}`;
  const streetName = cleanLabel(report.street || 'Улица не указана', 100);
  const buildingName = cleanLabel(report.address || 'Без номера', 80);
  let addressIds = null;
  try {
    await mkdir(jobDir, { recursive: true });
    await copyFile(sourcePath, path.join(jobDir, sourceName));
    addressIds = await updateAddressLibrary((library) => {
      let street = library.streets.find(
        (item) => String(item.name || '').toLocaleLowerCase('ru') === streetName.toLocaleLowerCase('ru'),
      );
      if (!street) {
        street = { id: randomUUID(), name: streetName, createdAt: new Date().toISOString(), buildings: [] };
        library.streets.push(street);
      }
      street.buildings = Array.isArray(street.buildings) ? street.buildings : [];
      let building = street.buildings.find(
        (item) => String(item.name || '').toLocaleLowerCase('ru') === buildingName.toLocaleLowerCase('ru'),
      );
      if (!building) {
        building = { id: randomUUID(), name: buildingName, createdAt: new Date().toISOString(), schemes: [] };
        street.buildings.push(building);
      }
      building.schemes = Array.isArray(building.schemes) ? building.schemes : [];
      const meta = {
        jobId,
        title: cleanLabel(`${streetName}, дом ${buildingName} — ручная схема`, 140),
        originalName: cleanLabel(report.sketch?.originalName || 'Эскиз слесаря', 180),
        sourceName,
        uploadedBy: cleanLabel(report.userName || 'Слесарь', 80),
        rotationDegrees: null,
        streetId: street.id,
        streetName: street.name,
        buildingId: building.id,
        buildingName: building.name,
        workforceReportId: report.id,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: 'pending',
        error: '',
      };
      addSchemeToBuilding(library, street, building, {
        jobId,
        title: meta.title,
        originalName: meta.originalName,
        createdAt: meta.createdAt,
        uploadedBy: meta.uploadedBy,
        sourceName,
        status: 'pending',
        error: '',
        workforceReportId: report.id,
      });
      return {
        streetId: street.id,
        streetName: street.name,
        buildingId: building.id,
        buildingName: building.name,
        meta,
      };
    });
    await writeSchemeMeta(jobId, addressIds.meta);
    const status = await enqueueStoredSchemeAnalysis(jobId);
    return { jobId, status, streetId: addressIds.streetId, buildingId: addressIds.buildingId };
  } catch (error) {
    await rm(jobDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function getWorkforceSchemeStatus(jobId) {
  if (!JOB_ID_PATTERN.test(String(jobId || ''))) return { status: 'failed', error: 'Некорректный ID CAD-задания.' };
  const meta = await readSchemeMeta(jobId);
  if (!meta) return { status: 'failed', error: 'Задание автоматической обработки не найдено.' };
  return {
    status: meta.status || 'queued',
    error: meta.error || '',
    completedAt: meta.completedAt || null,
    partialGraphReady: Boolean(meta.partialGraphReady),
  };
}

function nextManualEdgeId(edges) {
  const maxId = (Array.isArray(edges) ? edges : []).reduce((max, edge) => {
    const match = /^E(\d+)$/i.exec(String(edge?.id || ''));
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `E${maxId + 1}`;
}

app.use('/api/template', createTemplateRouter({ store: templateStore, uploadDir: UPLOAD_DIR, limitHeavyRequests }));

// Address library routes (routes/library-routes.js): streets and buildings.
app.use(
  '/api/library',
  createLibraryRouter({
    readAddressLibrary,
    updateAddressLibrary,
    validateBody,
    streetSchema,
    buildingSchema,
    cleanLabel,
    sendJsonConditional,
    UUID_PATTERN,
  }),
);

// Upload stores the original in the selected house and automatically queues
// its reconstruction. The GPU queue serializes Qwen jobs to protect VRAM.
// Scheme routes (routes/scheme-routes.js): upload, read, status, analyze, save.
app.use(
  '/api/library/schemes',
  createSchemeRouter({
    dataDir: DATA,
    readAddressLibrary,
    updateAddressLibrary,
    findBuilding,
    addSchemeToBuilding,
    findScheme,
    readSchemeMeta,
    writeSchemeMeta,
    enqueueStoredSchemeAnalysis,
    cleanLabel,
    limitHeavyRequests,
    heavyQuota,
    upload,
    shortJobId,
    JOB_ID_PATTERN,
    UUID_PATTERN,
  }),
);

// Job routes (routes/job-routes.js): graph, connections, review.
app.use(
  '/api/jobs',
  createJobsRouter({
    dataDir: DATA,
    attachJobUrls,
    nextManualEdgeId,
    validateBody,
    connectionSchema,
    reviewSchema,
    cleanLabel,
    shortJobId,
    JOB_ID_PATTERN,
  }),
);

// Cloud provider settings routes (routes/settings-routes.js): intentionally disabled.
app.use('/api', createSettingsRouter());
const healthChecks = createHealthChecks();
const { checkOllamaStatus, checkTesseractCached } = healthChecks;

app.get('/api/health', async (_req, res) => {
  const qwenModel = process.env.QWEN_MODEL || 'qwen3-vl:4b-instruct';
  const ollama = await checkOllamaStatus();
  const tesseract = await checkTesseractCached();
  const ready = Boolean(ollama.reachable && ollama.modelInstalled && tesseract.russianEnglishReady);
  res.json({
    ok: true,
    ready,
    version: BUILD_INFO.version,
    build: BUILD_INFO,
    drawingTemplateConfigured: Boolean(await readTemplateMeta().catch(() => null)),
    pythonJobTimeoutMs: PYTHON_TIMEOUT_MS,
    mode: 'cad-reconstruction-engine',
    recognitionMode: 'local-qwen-tesseract',
    geometry:
      'PIPE_MAIN uses OCR-aware OpenCV routes, source-ink-validated local Qwen traces, and topology-scored multi-branch networks; isolated strokes and uncertain joins remain review-only; text stays in TEXT_REVIEW',
    ocr: 'Local Ollama Qwen3-VL is the primary OCR and route-tracing model; local Tesseract rus+eng supplements text recognition. Cloud providers are disabled in the production pipeline.',
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
      modelKeepAlive: process.env.QWEN_KEEP_ALIVE || '10m',
    },
    localRecognition: { mode: 'Qwen3-VL + Tesseract', cloudDisabled: true, qwen: ollama, tesseract },
    ollamaConfigured: Boolean(process.env.OLLAMA_CHAT_URL),
    cloudProvidersDisabled: true,
    ollamaRequiredForCleanCad: false,
    ollamaRequired: false,
    ollama,
  });
});

app.get('/api/readyz', async (_req, res) => {
  const ollama = await checkOllamaStatus();
  const tesseract = await checkTesseractCached();
  const ready = Boolean(ollama.reachable && ollama.modelInstalled && tesseract.russianEnglishReady);
  res.status(ready ? 200 : 503).json({
    ok: ready,
    checks: {
      ollama: { reachable: ollama.reachable, modelInstalled: ollama.modelInstalled, model: ollama.model },
      tesseract: { available: tesseract.available, russianEnglishReady: tesseract.russianEnglishReady },
    },
    ollama,
  });
});

app.post('/api/analyze', limitHeavyRequests, heavyQuota, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Загрузите JPG, PNG, WEBP или TIFF.' });

  const streetId = String(req.body?.streetId || '');
  const buildingId = String(req.body?.buildingId || '');

  // Idempotency: a retry with the same image + address must not re-run the GPU
  // pipeline. The key is derived from the uploaded file bytes, so it is stable
  // across requests. Only successful 200 responses are cached.
  const idempotencyKey = req.get('Idempotency-Key') || '';
  const analyzeEndpoint = 'POST /api/analyze';
  if (idempotencyKey) {
    const cached = await findIdempotency(analyzeEndpoint, idempotencyKey);
    if (cached) {
      const fs = await import('node:fs/promises');
      await fs.rm(req.file.path, { force: true }).catch(() => {});
      req.log.info({ jobId: shortJobId(idempotencyKey) }, 'Analyze replay from idempotency key');
      return res.status(cached.status).json(cached.response);
    }
  }
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
      req.log.error({ err: error, bytes: req.file.size }, 'Cannot resolve the selected house folder');
      return res.status(500).json({ error: 'Не удалось проверить папку выбранного дома.' });
    }
  }

  const id = randomUUID();
  const jobDir = path.join(DATA, id);
  await mkdir(jobDir, { recursive: true });

  const ext = path.extname(req.file.originalname || '').toLowerCase() || '.img';
  const sourcePath = path.join(jobDir, `source${ext}`);
  let pythonSlotAcquired = false;

  try {
    // Move uploaded temp file into isolated job folder.
    const fs = await import('node:fs/promises');
    await fs.copyFile(req.file.path, sourcePath);
    await fs.rm(req.file.path, { force: true });

    if (!tryAcquirePythonSlot()) {
      await rm(jobDir, { recursive: true, force: true }).catch(() => {});
      req.log.warn(
        { jobId: shortJobId(id), running: runningPythonJobs, max: MAX_CONCURRENT_PYTHON_JOBS },
        'Rejected analyze: Python slot busy',
      );
      return res.status(429).json({
        error: 'Сервис распознавания занят другим заданием. Повторите попытку позже.',
        retryAfterSeconds: 60,
      });
    }
    pythonSlotAcquired = true;

    const progressPath = path.join(jobDir, 'progress.log');
    const templatePath = await pinTemplateReference(jobDir);
    const processorArgs = [...ENGINE_MODULE, '--input', sourcePath, '--out', jobDir];
    if (templatePath) processorArgs.push('--template', templatePath);
    const requestedRotation = String(req.body?.rotationDegrees ?? 'auto');
    if (['0', '90', '180', '270'].includes(requestedRotation)) processorArgs.push('--rotation', requestedRotation);
    await runPythonStreaming(processorArgs, {
      jobId: id,
      progressPath,
      timeout: PYTHON_TIMEOUT_MS,
      maxBuffer: PYTHON_MAX_BUFFER,
      env: localRecognitionPythonEnvironment(),
    });

    const graph = JSON.parse(await readFile(path.join(jobDir, 'graph.json'), 'utf8'));
    attachJobUrls(id, graph, path.basename(sourcePath));
    graph.confirmedConnections = Array.isArray(graph.confirmedConnections) ? graph.confirmedConnections : [];
    if (selectedAddress) {
      const title =
        cleanLabel(req.body?.schemeTitle || path.basename(req.file.originalname || 'Схема', ext), 140) || 'Схема';
      try {
        await updateAddressLibrary((library) => {
          const context = findBuilding(library, streetId, buildingId);
          if (!context) {
            const error = new Error('Выбранный дом удалён во время обработки.');
            error.status = 404;
            throw error;
          }
          addSchemeToBuilding(library, context.street, context.building, {
            jobId: id,
            title,
            createdAt: new Date().toISOString(),
            uploadedBy: cleanLabel(req.body?.uploadedBy, 80),
            sourceName: path.basename(sourcePath),
          });
        });
        graph.librarySaved = true;
        graph.libraryLocation = {
          streetId,
          streetName: selectedAddress.street.name,
          buildingId,
          buildingName: selectedAddress.building.name,
        };
      } catch (libraryError) {
        graph.librarySaved = false;
        graph.libraryError = String(libraryError?.message || libraryError).slice(0, 180);
        req.log.error(
          { err: libraryError, jobId: shortJobId(id), streetId, buildingId },
          'Processed but failed to add to address library',
        );
      }
    }

    // Все показатели берутся из graph.summary, который формирует processor.py.
    // Значение MISSING означает, что поле не было записано Python-процессором.
    // Одна структурированная запись вместо пяти строк: те же числа остаются
    // доступны для поиска по полям, а не только для чтения глазами.
    const summary = graph.summary && typeof graph.summary === 'object' ? graph.summary : {};
    const metric = (key) => summary[key] ?? 'MISSING';

    const oq = graph.ocr?.qwen || {};
    const ot = graph.ocr?.tesseract || {};
    const st = graph.semanticTrace || {};
    const maskBoxes =
      metric('text_regions_used_for_geometry_mask') !== 'MISSING'
        ? metric('text_regions_used_for_geometry_mask')
        : metric('geometry_excluded_text_regions');

    jobLogger(id, { source: 'engine' }).info(
      {
        segments: metric('segment_candidates'),
        nodes: metric('nodes'),
        edges: metric('edges'),
        crossings: metric('crossings_to_review'),
        ocrQwenAnnotations: oq.annotations || 0,
        ocrQwenTilesOk: oq.successful_tiles || 0,
        ocrQwenTilesTotal: oq.tiles || 0,
        ocrQwenNoteBlocks: oq.block_annotations || 0,
        ocrQwenNoteBlockPasses: oq.block_passes || 0,
        ocrTesseractAnnotations: ot.annotations || 0,
        verifiedText: metric('verified_annotations'),
        textReview: metric('text_review_annotations'),
        pipeQwenRoutes: st.routes || 0,
        pipeRawRoutes: st.raw_routes || 0,
        pipeTilesOk: st.successful_tiles || 0,
        pipeTilesTotal: st.tiles || 0,
        pipeRejectedInvalid: st.rejected_invalid || 0,
        pipeRejectedLowConfidence: st.rejected_low_confidence || 0,
        cadPrimaryEdges: metric('cad_primary_edges'),
        cadReviewEdges: metric('cad_review_edges'),
        topologyNetworkCandidateComponents: metric('topology_network_candidate_components'),
        topologyNetworkPrimaryEdges: metric('topology_network_primary_edges'),
        cadPrimaryQwenRoutes: metric('cad_primary_qwen_routes'),
        cadPrimaryTotalPaths: metric('cad_primary_total_paths'),
        isolatedReview: metric('isolated_strokes_kept_for_review'),
        textRegionMaskBoxes: maskBoxes,
        inkPixelsMasked: metric('ink_pixels_inside_text_regions'),
        textComponents: metric('text_or_annotation_components'),
        ambiguousComponents: metric('review_only_ambiguous_components'),
        timings: graph.timings_ms || {},
      },
      'Analysis metrics collected',
    );

    // Возвращаем граф целиком: все показатели также доступны в response.summary.
    if (idempotencyKey) {
      await saveIdempotency({
        endpoint: analyzeEndpoint,
        key: idempotencyKey,
        userId: req.user?.id || null,
        status: 200,
        response: graph,
      });
    }
    return res.json(graph);
  } catch (error) {
    req.log.error({ err: error, jobId: shortJobId(id), progressUrl: `/jobs/${id}/progress.log` }, 'Analyze failed');
    const progressUrl = `/jobs/${id}/progress.log`;
    const details = [String(error?.stderr || '').slice(-900), String(error?.message || error).slice(-350)]
      .filter(Boolean)
      .join('\n');

    return res.status(500).json({
      error: 'Не удалось проанализировать изображение.',
      details: `${details}\nЖурнал этапов: ${progressUrl}`,
      jobId: id,
      progressUrl,
    });
  } finally {
    if (pythonSlotAcquired) releasePythonSlot();
    if (req.file?.path) {
      const fs = await import('node:fs/promises');
      await fs.rm(req.file.path, { force: true }).catch(() => {});
    }
  }
});

// Manual CAD editor API. This module only reads/writes DATA/.private/manual-cad;
// it does not call, proxy, or modify any VDGO route, service, database, or file.
// Manual CAD routes (routes/manual-cad-routes.js).
app.use(
  '/api/manual-cad',
  createManualCadRouter({
    dataDir: DATA,
    manualCadDir: MANUAL_CAD_DIR,
    readSchemeMeta,
    workforceSystem,
    manualSourceUpload,
    rasterDimensions,
    readManualProject,
    writeManualProject,
    writeManualProjectIfRevision,
    listManualProjects,
    findManualCadProjectForJob,
    findManualCadProjectForReport,
    findScheme,
    readAddressLibrary,
    createManualCadProject,
    createManualCadProjectFromGraph,
    normalizeManualCadProject,
    renderManualCadSvg,
    renderManualCadDxf,
    isManualCadId,
    manualProjectPath,
    manualProjectResponse,
    cleanLabel,
    sendJsonConditional,
    validateBody,
    manualProjectCreateSchema,
    limitHeavyRequests,
    heavyQuota,
    shortJobId,
    JOB_ID_PATTERN,
  }),
);

// SPA fallback (routes/spa-routes.js).
app.use(createSpaRouter());

app.use(workforceSystem.router);

app.use('/api', (_req, res) => res.status(404).json({ error: 'API-маршрут не найден.' }));

app.use((err, req, res, _next) => {
  logRequestError(req, err, 'Unhandled request error');
  const isTemplateUpload = req.path === '/api/template';
  const isWorkforceReport = req.path.startsWith('/api/workforce/tasks/') && req.path.endsWith('/report');
  const status =
    err?.code === 'LIMIT_FILE_SIZE'
      ? 413
      : Number.isInteger(err?.status) && err.status >= 400 && err.status < 600
        ? err.status
        : 400;
  const message =
    err?.code === 'LIMIT_FILE_SIZE'
      ? isTemplateUpload
        ? 'Файл шаблона больше 30 МБ.'
        : isWorkforceReport
          ? 'Одно вложение отчёта больше 24 МБ.'
          : 'Файл больше 18 МБ.'
      : err?.code === 'LIMIT_UNEXPECTED_FILE'
        ? isWorkforceReport
          ? 'Прикладывай до 8 фотографий и один файл ручной схемы.'
          : 'Можно загрузить только один файл за раз.'
        : err?.status === 422
          ? err.message
          : 'Ошибка запроса.';
  const details = Array.isArray(err?.details) ? err.details : err?.message;
  res.status(status).json({ error: message, details });
});

await backfillManualCadProjects();
await backfillAddressLibrary();
await backfillSchemeMeta();
const server = app.listen(PORT, process.env.HOST || '0.0.0.0', () => {
  logger.info(
    {
      pipelineSha256: BUILD_INFO.pipelineSha256,
      host: process.env.HOST || '0.0.0.0',
      port: PORT,
      pythonTimeoutMs: PYTHON_TIMEOUT_MS,
      maxConcurrentPythonJobs: MAX_CONCURRENT_PYTHON_JOBS,
      manualCadDir: MANUAL_CAD_DIR,
      configuredLevel: logger.level,
    },
    'ScadaProfit API started',
  );
  logger.info(
    'Geometry: selected OpenCV graph edges are merged into continuous CAD routes; crossings remain disconnected unless the graph confirms a shared junction.',
  );
  logger.info(
    'Workforce: password-authenticated accounts, manual visit/office check-ins, sketch-only reports and automatic CAD processing enabled; GPS tracking disabled.',
  );
  void resumeStoredAnalysisQueue();
});

// Docker sends SIGTERM, waits stop_grace_period, then SIGKILL. Close the HTTP
// listener first, then give active Python jobs a bounded window to finish so a
// restart does not truncate graph.json or leave an orphan on the GPU.
let shuttingDown = false;
const SHUTDOWN_TIMEOUT_MS = Math.max(1_000, Number(process.env.SHUTDOWN_TIMEOUT_MS || 20_000));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal, activePythonJobs: activePythonChildren.size }, 'Shutdown requested');
  server.close(() => logger.info('HTTP server closed'));
  if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();

  const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
  while (Date.now() < deadline && activePythonChildren.size > 0) {
    for (const child of activePythonChildren) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }
    await sleep(250);
  }
  for (const child of activePythonChildren) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  logger.info({ activePythonJobs: activePythonChildren.size }, 'Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
