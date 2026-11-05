import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';

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

// ВАЖНО: PYTHON_JOB_TIMEOUT_MS задаётся в миллисекундах.
// 2 700 000 мс = 45 минут, а не 2 700 000 секунд.
const configuredPythonTimeout = Number(process.env.PYTHON_JOB_TIMEOUT_MS || 2_700_000);
const PYTHON_TIMEOUT_MS = Number.isFinite(configuredPythonTimeout)
  ? Math.max(60_000, configuredPythonTimeout)
  : 2_700_000;

const PYTHON_MAX_BUFFER = 16 * 1024 * 1024;
const JOB_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_PATTERN = JOB_ID_PATTERN;

await mkdir(DATA, { recursive: true });
await mkdir(LIBRARY_DIR, { recursive: true });
await mkdir(UPLOAD_DIR, { recursive: true });

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
  graph.confirmedConnections = Array.isArray(graph.confirmedConnections) ? graph.confirmedConnections : [];
  graph.joinCandidates = Array.isArray(graph.joinCandidates) ? graph.joinCandidates : [];
  return graph;
}

function cleanLabel(value, maxLength = 100) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
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
            sourceName: cleanLabel(item.sourceName || '', 180)
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

function nextManualEdgeId(edges) {
  const maxId = (Array.isArray(edges) ? edges : []).reduce((max, edge) => {
    const match = /^E(\d+)$/i.exec(String(edge?.id || ''));
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `E${maxId + 1}`;
}

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
    version: '4.3.10',
    pythonJobTimeoutMs: PYTHON_TIMEOUT_MS,
    mode: 'cad-reconstruction-engine',
    geometry: 'PIPE_MAIN uses OCR-aware OpenCV routes, source-ink-validated Qwen traces, and topology-scored multi-branch networks; isolated strokes and uncertain joins remain review-only; text stays in TEXT_REVIEW',
    ocr: 'Qwen3-VL 3x3 tiled handwriting OCR + Tesseract confidence filtering + separate per-row OCR for dense numbered notes; failed rows remain TEXT_REVIEW masks',
    qwenModel,
    qwenLimits: {
      ocrTimeoutSeconds: Number(process.env.QWEN_OCR_TIMEOUT || 180),
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
    await runPythonStreaming(
      [path.join(__dirname, 'processor.py'), '--input', sourcePath, '--out', jobDir],
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

app.get(/^(?!\/api(?:\/|$)).*/, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'), {
    headers: { 'Cache-Control': 'no-store, max-age=0' }
  });
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'API-маршрут не найден.' }));

app.use((err, _req, res, _next) => {
  console.error(err);
  const status = err?.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
  const message = err?.code === 'LIMIT_FILE_SIZE'
    ? 'Файл больше 18 МБ.'
    : err?.code === 'LIMIT_UNEXPECTED_FILE'
      ? 'Можно загрузить только один файл за раз.'
      : 'Ошибка запроса.';
  res.status(status).json({ error: message, details: err.message });
});

app.listen(PORT, process.env.HOST || '0.0.0.0', () => {
  console.log(`CAD Reconstruction Engine 4.3.10: http://${process.env.HOST || '0.0.0.0'}:${PORT}`);
  console.log('Geometry: OCR-masked OpenCV routes, supported short branches and ink-validated Qwen routes for PIPE_MAIN; review geometry remains separate.');
  console.log(`Python timeout: ${PYTHON_TIMEOUT_MS} ms (${Math.round(PYTHON_TIMEOUT_MS / 60_000)} minutes)`);
});
