import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const PYTHON = process.env.MASK_PYTHON || '/opt/venv/bin/python';
const DATA = process.env.DATA_DIR || path.join(os.tmpdir(), 'cad-reconstruction-jobs');
const UPLOAD_DIR = path.join(os.tmpdir(), 'cad-reconstruction-uploads');
await mkdir(DATA, { recursive: true });
await mkdir(UPLOAD_DIR, { recursive: true });

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

app.get('/api/health', (_req, res) => res.json({ ok: true, version: '4.2.2', mode: 'cad-reconstruction-engine',
  geometry: 'OpenCV LSD + Hough candidate graph', ocr: 'Qwen3-VL/Tesseract editable text; confirmed glyph strokes filtered, continuous pipe lines preserved',
  qwenModel: process.env.QWEN_MODEL || 'qwen3-vl:4b', ollamaConfigured: Boolean(process.env.OLLAMA_CHAT_URL), ollamaRequired: false }));

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
    const { stdout, stderr } = await execFileAsync(PYTHON, [path.join(__dirname, 'processor.py'), '--input', sourcePath, '--out', jobDir],
      { timeout: 120_000, maxBuffer: 12 * 1024 * 1024 });
    if (stderr?.trim()) console.log(`[ENGINE ${id.slice(0,8)}] ${stderr.trim().slice(-1200)}`);
    const graph = JSON.parse(await readFile(path.join(jobDir, 'graph.json'), 'utf8'));
    graph.jobId = id;
    graph.sourceUrl = `/jobs/${id}/${path.basename(sourcePath)}`;
    graph.overlayUrl = `/jobs/${id}/overlay.png`;
    graph.inkUrl = `/jobs/${id}/ink-mask.png`;
    graph.svgUrl = `/jobs/${id}/clean.svg`;
    graph.dxfUrl = `/jobs/${id}/drawing.dxf`;
    console.log(`[ENGINE ${id.slice(0,8)}] segments=${graph.summary.segment_candidates} nodes=${graph.summary.nodes} edges=${graph.summary.edges} crossings=${graph.summary.crossings_to_review}`);
    res.json(graph);
  } catch (error) {
    console.error('Analyze failed:', error?.stderr || error);
    res.status(500).json({ error: 'Не удалось проанализировать изображение.', details: String(error?.stderr || error?.message || error).slice(-1600) });
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
  console.log(`CAD Reconstruction Engine 4.2.2: http://${process.env.HOST || '0.0.0.0'}:${PORT}`);
  console.log('Geometry: OpenCV line candidates; OCR is a separate annotation channel.');
});
