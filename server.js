import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const PYTHON = process.env.MASK_PYTHON || '/opt/venv/bin/python';
const DATA = process.env.DATA_DIR || path.join(os.tmpdir(), 'cad-reconstruction-jobs');
const UPLOAD_DIR = path.join(os.tmpdir(), 'cad-reconstruction-uploads');
const configuredPythonTimeout = Number(process.env.PYTHON_JOB_TIMEOUT_MS || 2_700_000);
const PYTHON_TIMEOUT_MS = Number.isFinite(configuredPythonTimeout) ? Math.max(60_000, configuredPythonTimeout) : 2_700_000;
const PYTHON_MAX_BUFFER = 16 * 1024 * 1024;
await mkdir(DATA, { recursive: true });
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
      if (!progressFileFailed && !progressFile.destroyed && progressFile.writable) progressFile.write(`${entry}\n`);
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
          Object.assign(error, { code: 'ETIMEDOUT', killed: true, signal: signal || 'SIGTERM', stderr: stderrTail, stdout });
          fail(error);
        } else if (outputOverflow) {
          const error = new Error(`Python stdout exceeded the ${maxBuffer} byte output limit.`);
          Object.assign(error, { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true, signal: signal || 'SIGTERM', stderr: stderrTail, stdout });
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

    logLine(`[JOB] Python process started; timeout=${Math.round(timeout / 60_000)}m`);
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

const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 18 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const extOk = /\.(jpe?g|png|webp|tiff?)$/i.test(file.originalname || '');
    const mimeOk = /^image\/(jpeg|png|webp|tiff|x-tiff)$/.test(file.mimetype || '');
    cb(null, extOk || mimeOk);
  }
});

app.get('/api/health', async (_req, res) => {
  const qwenModel = process.env.QWEN_MODEL || 'qwen3-vl:4b';
  const tagsUrl = process.env.OLLAMA_TAGS_URL || (process.env.OLLAMA_CHAT_URL || 'http://127.0.0.1:11434/api/chat').replace(/\/api\/chat\/?$/, '/api/tags');
  let ollama = { reachable: false, modelInstalled: false, model: qwenModel, error: null, hint: null };
  try {
    const response = await fetch(tagsUrl, { cache: 'no-store', signal: AbortSignal.timeout(3500) });
    if (!response.ok) throw new Error(`Ollama API вернула HTTP ${response.status}`);
    const data = await response.json();
    const models = Array.isArray(data.models) ? data.models : [];
    const names = models.map(item => String(item.name || item.model || '')).filter(Boolean);
    ollama.reachable = true;
    ollama.models = names;
    ollama.modelInstalled = names.some(name => name === qwenModel || name === `${qwenModel}:latest` || name.replace(/:latest$/, '') === qwenModel.replace(/:latest$/, ''));
    if (!ollama.modelInstalled) {
      ollama.error = `Модель ${qwenModel} не найдена. Установлены: ${names.join(', ') || 'нет моделей'}.`;
      ollama.hint = `Выполните: docker compose exec ollama ollama pull ${qwenModel}`;
    }
  } catch (error) {
    ollama.error = String(error?.message || error).slice(0, 240);
    ollama.hint = 'Проверьте, что Ollama запущена и доступна по OLLAMA_TAGS_URL из контейнера app.';
  }
  res.json({ ok: true, version: '4.3.4', pythonJobTimeoutMs: PYTHON_TIMEOUT_MS, mode: 'cad-reconstruction-engine',
    geometry: 'Confidence-filtered OCR mask plus OpenCV topology paths and source-ink-validated Qwen traces form PIPE_MAIN; rejected traces stay in QWEN_REVIEW; uncertain text stays in TEXT_REVIEW',
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
      ocrUpscale: Number(process.env.QWEN_OCR_UPSCALE || 2)
    },
    ollamaConfigured: Boolean(process.env.OLLAMA_CHAT_URL), ollamaRequiredForCleanCad: false, ollamaRequired: false, ollama });
});

app.post('/api/analyze', upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Загрузите JPG, PNG, WEBP или TIFF.' });
  const id = randomUUID();
  const jobDir = path.join(DATA, id);
  await mkdir(jobDir, { recursive: true });
  const ext = path.extname(req.file.originalname || '').toLowerCase() || '.img';
  const sourcePath = path.join(jobDir, `source${ext}`);
  try {
    // move uploaded temp file into isolated job folder
    const fs = await import('node:fs/promises');
    await fs.copyFile(req.file.path, sourcePath);
    await fs.rm(req.file.path, { force: true });
    const progressPath = path.join(jobDir, 'progress.log');
    const { stdout } = await runPythonStreaming(
      [path.join(__dirname, 'processor.py'), '--input', sourcePath, '--out', jobDir],
      { jobId: id, progressPath, timeout: PYTHON_TIMEOUT_MS, maxBuffer: PYTHON_MAX_BUFFER }
    );
    const graph = JSON.parse(await readFile(path.join(jobDir, 'graph.json'), 'utf8'));
    graph.jobId = id;
    graph.progressUrl = `/jobs/${id}/progress.log`;
    graph.sourceUrl = `/jobs/${id}/${path.basename(sourcePath)}`;
    graph.overlayUrl = `/jobs/${id}/overlay.png`;
    graph.primaryOverlayUrl = `/jobs/${id}/primary-overlay.png`;
    graph.textMaskUrl = `/jobs/${id}/text-region-mask.png`;
    graph.geometryInkUrl = `/jobs/${id}/ink-without-text-boxes.png`;
    graph.handwrittenTextBlocksUrl = `/jobs/${id}/handwritten-text-blocks.png`;
    graph.inkUrl = `/jobs/${id}/ink-mask.png`;
    graph.svgUrl = `/jobs/${id}/clean.svg`;
    graph.dxfUrl = `/jobs/${id}/drawing.dxf`;
    console.log(`[ENGINE ${id.slice(0,8)}] segments=${graph.summary.segment_candidates} nodes=${graph.summary.nodes} edges=${graph.summary.edges} crossings=${graph.summary.crossings_to_review}`);
    const oq = graph.ocr?.qwen || {};
    const ot = graph.ocr?.tesseract || {};
    const st = graph.semanticTrace || {};
    console.log(`[ENGINE ${id.slice(0,8)}] OCR Qwen=${oq.annotations || 0} tiles=${oq.successful_tiles || 0}/${oq.tiles || 0}; noteBlocks=${oq.block_annotations || 0} (${oq.block_passes || 0} passes); Tesseract=${ot.annotations || 0}; verifiedText=${graph.summary.verified_annotations || 0}; textReview=${graph.summary.text_review_annotations || 0}`);
    console.log(`[ENGINE ${id.slice(0,8)}] PIPE Qwen routes=${st.routes || 0} raw=${st.raw_routes || 0} tiles=${st.successful_tiles || 0}/${st.tiles || 0}; rejected=${st.rejected_invalid || 0}+${st.rejected_low_confidence || 0}`);
    console.log(`[ENGINE ${id.slice(0,8)}] CAD PIPE_MAIN OpenCV_edges=${graph.summary.cad_primary_edges || 0} Qwen_routes=${graph.summary.cad_primary_qwen_routes || 0} total_paths=${graph.summary.cad_primary_total_paths || 0}; DETAIL_REVIEW=${graph.summary.cad_review_edges || 0}; isolatedReview=${graph.summary.isolated_strokes_kept_for_review || 0}`);
    console.log(`[ENGINE ${id.slice(0,8)}] OCR-MASK boxes=${graph.summary.text_regions_used_for_geometry_mask || graph.summary.geometry_excluded_text_regions || 0}; inkPixelsMasked=${graph.summary.ink_pixels_inside_text_regions || 0}; textComponents=${graph.summary.text_or_annotation_components || 0}; ambiguous=${graph.summary.review_only_ambiguous_components || 0}`);
    res.json(graph);
  } catch (error) {
    console.error(`[JOB ${id.slice(0,8)}] Analyze failed:`, error?.stderr || error);
    const progressUrl = `/jobs/${id}/progress.log`;
    const details = [String(error?.stderr || '').slice(-900), String(error?.message || error).slice(-350)].filter(Boolean).join('\n');
    res.status(500).json({ error: 'Не удалось проанализировать изображение.', details: `${details}\nЖурнал этапов: ${progressUrl}`, jobId: id, progressUrl });
  } finally {
    if (req.file?.path) { const fs = await import('node:fs/promises'); await fs.rm(req.file.path, { force: true }).catch(()=>{}); }
  }
});

app.get(/^(?!\/api(?:\/|$)).*/, (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html'), { headers: { 'Cache-Control': 'no-store, max-age=0' } }));
app.use('/api', (_req, res) => res.status(404).json({ error: 'API-маршрут не найден.' }));
app.use((err, _req, res, _next) => {
  console.error(err);
  const status = err?.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
  const message = err?.code === 'LIMIT_FILE_SIZE' ? 'Файл больше 18 МБ.' : err?.code === 'LIMIT_UNEXPECTED_FILE' ? 'Можно загрузить только один файл за раз.' : 'Ошибка запроса.';
  res.status(status).json({ error: message, details: err.message });
});
app.listen(PORT, process.env.HOST || '0.0.0.0', () => {
  console.log(`CAD Reconstruction Engine 4.3.4: http://${process.env.HOST || '0.0.0.0'}:${PORT}`);
  console.log('Geometry: OCR-masked OpenCV routes, supported short branches and ink-validated Qwen routes for PIPE_MAIN; review geometry remains separate.');
});
