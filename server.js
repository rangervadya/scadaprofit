import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import multer from 'multer';
import { rateLimit } from 'express-rate-limit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_FILE_SIZE = 15 * 1024 * 1024;
const OLLAMA_TAGS_URL = process.env.OLLAMA_TAGS_URL || 'http://127.0.0.1:11434/api/tags';
const QWEN_MODEL = process.env.QWEN_MODEL || 'qwen3-vl:4b-instruct';
const venvPython = path.join(__dirname, '.venv', 'bin', 'python');
const pythonCandidates = [
  process.env.PYTHON_BIN && existsSync(process.env.PYTHON_BIN) ? process.env.PYTHON_BIN : null,
  existsSync(venvPython) ? venvPython : null,
  'python3',
].filter(Boolean);

app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      fontSrc: ["'self'", 'data:'],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      objectSrc: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      connectSrc: ["'self'"],
      upgradeInsecureRequests: null,
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '5m',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: 1, fields: 4, fieldSize: 5000 },
  fileFilter: (_req, file, callback) => {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype)) {
      return callback(new Error('Поддерживаются только PNG, JPG/JPEG и WEBP.'));
    }
    callback(null, true);
  },
});

const convertLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Слишком много запросов. Подождите 15 минут и попробуйте снова.' },
});

function hasValidImageSignature(buffer, mimeType) {
  if (!buffer || buffer.length < 12) return false;
  if (mimeType === 'image/png') {
    return buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (mimeType === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mimeType === 'image/webp') {
    return buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  }
  return false;
}

function fetchWithTimeout(url, options = {}, timeoutMs = 1800) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

async function getOptionalOllamaStatus() {
  try {
    const response = await fetchWithTimeout(OLLAMA_TAGS_URL);
    if (!response.ok) return { reachable: false, modelAvailable: false };
    const payload = await response.json();
    const models = Array.isArray(payload.models) ? payload.models : [];
    return {
      reachable: true,
      modelAvailable: models.some((entry) => entry.name === QWEN_MODEL),
    };
  } catch {
    return { reachable: false, modelAvailable: false };
  }
}

function runPython(scriptName, args, timeoutMs, label) {
  const scriptPath = path.join(__dirname, scriptName);
  const tryCandidate = (index) => new Promise((resolve, reject) => {
    const python = pythonCandidates[index];
    if (!python) return reject(new Error('Python 3 не найден. Проверьте установку Python/OpenCV.'));
    const child = spawn(python, [scriptPath, ...args], {
      cwd: __dirname,
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 200000) stdout = stdout.slice(-200000);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 500000) stderr = stderr.slice(-500000);
    });
    child.once('error', (error) => {
      if (error.code === 'ENOENT' && index + 1 < pythonCandidates.length) {
        resolve(tryCandidate(index + 1));
      } else {
        reject(error);
      }
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) return resolve({ stdout, stderr });
      if (code === null && signal === 'SIGKILL') {
        return reject(new Error(`${label} превысил лимит времени. Попробуйте изображение меньшего размера.`));
      }
      if (code === 127 && index + 1 < pythonCandidates.length) return resolve(tryCandidate(index + 1));
      const details = stderr.trim().split('\n').slice(-10).join('\n');
      reject(new Error(details || `${label} завершился с кодом ${code}`));
    });
  });
  return tryCandidate(0);
}

async function runProcessor(inputPath, outputDir, preserveDetails) {
  return runPython('processor.py', [inputPath, outputDir, preserveDetails ? '1' : '0'], 180000, 'Трассировка изображения');
}

async function runCadRenderer(vectorsPath, outputDir) {
  return runPython('cad_renderer.py', [vectorsPath, outputDir], 90000, 'Построение SVG/DXF');
}

function formatOcrText(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return 'Надписи не распознаны с достаточной уверенностью. Сверьте вручную.';
  }
  return items.slice(0, 100).map((item) => {
    const box = Array.isArray(item.bbox) ? ` [x:${item.bbox[0]}, y:${item.bbox[1]}]` : '';
    return `${item.text} (${item.confidence}%)${box}`;
  }).join('\n');
}

app.get('/api/health', async (_req, res) => {
  const ollama = await getOptionalOllamaStatus();
  res.json({
    ok: true,
    mode: 'offline-local',
    processorReady: true,
    processor: 'OpenCV pen extraction + skeleton graph + Tesseract OCR + SVG/DXF',
    geometryEngine: 'opencv-skeleton-graph',
    ollamaReachable: ollama.reachable,
    qwenAvailable: ollama.modelAvailable,
    qwenOptional: true,
    status: 'Локальная векторизация готова; Ollama для геометрии не требуется',
  });
});

app.post('/api/convert', convertLimiter, (req, res, next) => {
  upload.single('image')(req, res, (error) => {
    if (error) {
      if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'Файл слишком большой. Максимальный размер — 15 МБ.' });
      }
      return res.status(400).json({ error: error.message || 'Не удалось принять файл.' });
    }
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Сначала выберите фотографию или скан схемы.' });
  if (!hasValidImageSignature(req.file.buffer, req.file.mimetype)) {
    return res.status(400).json({ error: 'Содержимое файла не похоже на выбранный формат изображения.' });
  }

  const preserveDetails = req.body.preserveDetails !== 'false' && req.body.strictMode !== 'false';
  const userNote = typeof req.body.notes === 'string' ? req.body.notes.trim().slice(0, 180) : '';
  const mode = req.body.mode === 'clean' ? 'clean' : 'cad';
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cad-sketch-'));
  const ext = path.extname(req.file.originalname || '').toLowerCase();
  const safeExt = ['.png', '.jpg', '.jpeg', '.webp'].includes(ext) ? ext : '.img';
  const inputPath = path.join(tempDir, `source${safeExt}`);

  try {
    await fs.writeFile(inputPath, req.file.buffer);
    await runProcessor(inputPath, tempDir, preserveDetails);

    const vectorsPath = path.join(tempDir, 'vectors.json');
    const resultPath = path.join(tempDir, 'result.json');
    const vectors = JSON.parse(await fs.readFile(vectorsPath, 'utf8'));
    vectors.userNote = userNote;
    await fs.writeFile(vectorsPath, JSON.stringify(vectors, null, 2), 'utf8');
    const processed = JSON.parse(await fs.readFile(resultPath, 'utf8'));
    const rendererRun = await runCadRenderer(vectorsPath, tempDir);
    const renderStats = JSON.parse(rendererRun.stdout.trim().split('\n').filter(Boolean).at(-1) || '{}');

    const previewPath = mode === 'clean'
      ? path.join(tempDir, 'clean.png')
      : path.join(tempDir, 'cad-redraw.png');
    const image = await fs.readFile(previewPath);
    const svg = await fs.readFile(path.join(tempDir, 'cad-redraw.svg'));
    const dxf = await fs.readFile(path.join(tempDir, 'cad-redraw.dxf'));
    const stats = {
      ...processed.trace,
      ...renderStats,
      routes: renderStats.primaryPaths || 0,
      width: processed.trace.width,
      height: processed.trace.height,
      sheet: processed.trace.sheet,
      preserveDetails,
      thresholdMethod: processed.trace.thresholdMethod,
    };

    const analysis = [
      'Геометрия не создаётся языковой моделью: координаты получены из пикселей исходного изображения.',
      `Метод выделения: ${processed.trace.thresholdMethod}.`,
      `Основных векторных путей: ${stats.primaryPaths}; дополнительных штрихов: ${stats.detailPaths}.`,
      `Пикселей скелета: ${stats.skeletonPixels}; OCR-кандидатов: ${stats.ocrCount}.`,
      'SVG/DXF сохраняют координаты в пределах листа A3; реальный масштаб и размеры труб не калибровались.',
    ].join('\n');
    const note = (mode === 'clean'
      ? 'Показано очищенное чёрно-белое изображение; SVG/DXF содержат векторные центральные линии штрихов.'
      : 'Показана векторная трассировка центральных линий штрихов. Это не готовая инженерная CAD-модель. Сверьте все соединения, повороты, пропуски и размеры с оригиналом.')
      + (userNote ? ` Примечание: ${userNote}` : '');

    res.json({
      image: `data:image/png;base64,${image.toString('base64')}`,
      svg: `data:image/svg+xml;base64,${svg.toString('base64')}`,
      dxf: `data:application/dxf;base64,${dxf.toString('base64')}`,
      filenames: {
        png: mode === 'clean' ? 'cad-cleaned-source.png' : 'cad-vector-preview.png',
        svg: 'cad-centerline-trace.svg',
        dxf: 'cad-centerline-trace.dxf',
      },
      analysis,
      ocrText: formatOcrText(processed.ocr),
      qwenAvailable: false,
      processorReady: true,
      stats,
      note,
      mode,
      cadReconstructed: false,
      vectorized: true,
      needsReview: true,
      warnings: vectors.warnings || [],
    });
  } catch (error) {
    console.error('Offline vectorization failed:', error?.stack || error);
    const message = String(error?.message || error).slice(0, 1400);
    const hint = /No module named|ImportError|tesseract|ezdxf|cairosvg|processor\.py|cad_renderer\.py/i.test(message)
      ? ' Проверьте зависимости Docker-образа и выполните docker compose build --no-cache app.'
      : '';
    res.status(422).json({ error: `${message}${hint}` });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

app.use((error, _req, res, _next) => {
  console.error('Unhandled server error:', error);
  res.status(500).json({ error: 'Внутренняя ошибка сервера.' });
});

app.listen(PORT, HOST, () => {
  console.log(`CAD Sketch Converter 2.5.0 запущен: http://${HOST}:${PORT}`);
  console.log('Геометрия: OpenCV centerline graph; Ollama не участвует в рисовании труб.');
});
