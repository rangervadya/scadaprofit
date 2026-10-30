import express from 'express';
import helmet from 'helmet';
import multer from 'multer';
import { rateLimit } from 'express-rate-limit';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_FILE_SIZE = 15 * 1024 * 1024;
const MASK_PYTHON = process.env.MASK_PYTHON || '/opt/venv/bin/python';
const MASK_TIMEOUT_MS = 90000;
const MAX_PROCESSOR_OUTPUT = 40 * 1024 * 1024;

app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"], baseUri: ["'self'"], fontSrc: ["'self'", 'data:'],
      formAction: ["'self'"], frameAncestors: ["'none'"], imgSrc: ["'self'", 'data:', 'blob:'],
      objectSrc: ["'none'"], scriptSrc: ["'self'"], styleSrc: ["'self'"],
      connectSrc: ["'self'"], upgradeInsecureRequests: null,
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '5m',
  setHeaders(res, filePath) {
    if (/\.(html|js|css)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  },
}));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: 1, fields: 4, fieldSize: 12000 },
  fileFilter: (_req, file, callback) => {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype)) {
      return callback(new Error('Поддерживаются только PNG, JPG/JPEG и WEBP.'));
    }
    callback(null, true);
  },
});

const maskLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 40,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Слишком много обработок. Подожди 15 минут и попробуй снова.' },
});

function hasValidImageSignature(buffer, mimeType) {
  if (!buffer || buffer.length < 12) return false;
  if (mimeType === 'image/png') return buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mimeType === 'image/webp') return buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  return false;
}

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function runMaskProcessor(imageBuffer, config) {
  return new Promise((resolve, reject) => {
    const child = spawn(MASK_PYTHON, [path.join(__dirname, 'mask_processor.py'), JSON.stringify(config)], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, OMP_THREAD_LIMIT: '2', OPENBLAS_NUM_THREADS: '1' },
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('Обработка изображения превысила 90 секунд. Уменьши разрешение или попробуй другой файл.'));
    }, MASK_TIMEOUT_MS);

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    }

    child.stdout.on('data', chunk => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_PROCESSOR_OUTPUT) {
        child.kill('SIGKILL');
        finish(new Error('Ответ обработчика слишком большой. Изображение имеет чрезмерное разрешение.'));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', chunk => {
      if (Buffer.concat(stderr).length < 12000) stderr.push(chunk);
    });
    child.on('error', error => finish(new Error(`Не удалось запустить локальный обработчик масок: ${error.message}`)));
    child.on('close', code => {
      if (settled) return;
      const output = Buffer.concat(stdout).toString('utf8');
      let parsed;
      try { parsed = JSON.parse(output); }
      catch {
        const detail = Buffer.concat(stderr).toString('utf8').slice(0, 1000);
        finish(new Error(`Обработчик масок вернул некорректный ответ (code=${code}). ${detail}`));
        return;
      }
      if (code !== 0 || !parsed.ok) {
        finish(new Error(parsed.error || Buffer.concat(stderr).toString('utf8').slice(0, 1200) || `Обработчик завершился с кодом ${code}.`));
        return;
      }
      finish(null, parsed);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(imageBuffer);
  });
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    appVersion: '3.0.0',
    mode: 'two-mask-lab',
    processor: 'OpenCV ink segmentation + Tesseract OCR boxes',
    qwenUsed: false,
    masks: ['text', 'lines'],
    note: 'Text mask = pen pixels inside OCR word boxes; line mask = remaining pen pixels. No geometry is generated.',
  });
});

app.post('/api/masks', maskLimiter, (req, res, next) => {
  upload.single('image')(req, res, error => {
    if (error) return res.status(400).json({ error: error.message || 'Не удалось принять изображение.' });
    next();
  });
}, async (req, res) => {
  if (!req.file || !hasValidImageSignature(req.file.buffer, req.file.mimetype)) {
    return res.status(400).json({ error: 'Загрузите исходное изображение PNG, JPG или WEBP.' });
  }
  const modeValue = String(req.body?.mode || 'auto');
  const mode = ['auto', 'blue', 'dark'].includes(modeValue) ? modeValue : 'auto';
  const minConfidence = boundedNumber(req.body?.minConfidence, 15, 0, 90);
  const padding = Math.round(boundedNumber(req.body?.padding, 3, 0, 24));
  const started = Date.now();
  try {
    const result = await runMaskProcessor(req.file.buffer, { mode, minConfidence, padding });
    const elapsedMs = Date.now() - started;
    console.log('[TWO-MASK]', JSON.stringify({
      filename: req.file.originalname,
      bytes: req.file.size,
      width: result.width,
      height: result.height,
      mode: result.mode?.modeUsed,
      dominantHue: result.mode?.dominantHue,
      inkPixels: result.stats?.inkPixels,
      textPixels: result.stats?.textPixels,
      linePixels: result.stats?.linePixels,
      ocrBoxes: result.stats?.ocrBoxes,
      elapsedMs,
      warnings: result.warnings,
    }));
    res.json({ ...result, elapsedMs });
  } catch (error) {
    console.error('[TWO-MASK-ERROR]', error?.stack || error);
    res.status(502).json({ error: String(error.message || error).slice(0, 1400) });
  }
});

app.use((error, _req, res, _next) => {
  console.error('Unhandled server error:', error?.stack || error);
  res.status(500).json({ error: 'Внутренняя ошибка сервера.' });
});

app.listen(PORT, HOST, () => {
  console.log(`TWO MASK LAB 3.0.0 запущена: http://${HOST}:${PORT}`);
  console.log(`Локальная обработка: OpenCV + Tesseract. Ollama/Qwen не вызываются.`);
});
