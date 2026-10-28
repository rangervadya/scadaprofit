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
const QWEN_MODEL = process.env.QWEN_MODEL || 'qwen2.5vl:3b';
const OLLAMA_CHAT_URL = process.env.OLLAMA_CHAT_URL || 'http://127.0.0.1:11434/api/chat';
const OLLAMA_TAGS_URL = process.env.OLLAMA_TAGS_URL || 'http://127.0.0.1:11434/api/tags';
const venvPython = path.join(__dirname, '.venv', 'bin', 'python');
const pythonCandidates = [
  process.env.PYTHON_BIN && existsSync(process.env.PYTHON_BIN) ? process.env.PYTHON_BIN : null,
  existsSync(venvPython) ? venvPython : null,
  'python3'
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
      upgradeInsecureRequests: null
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '5m',
  setHeaders(res, filePath) { if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) res.setHeader('Cache-Control', 'no-cache'); }
}));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: 1, fields: 4, fieldSize: 5000 },
  fileFilter: (_req, file, callback) => {
    const supported = ['image/png', 'image/jpeg', 'image/webp'];
    if (!supported.includes(file.mimetype)) return callback(new Error('Поддерживаются только PNG, JPG/JPEG и WEBP.'));
    callback(null, true);
  }
});

const convertLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Слишком много запросов. Подождите 15 минут и попробуйте снова.' }
});

function hasValidImageSignature(buffer, mimeType) {
  if (!buffer || buffer.length < 12) return false;
  if (mimeType === 'image/png') return buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mimeType === 'image/webp') return buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  return false;
}

function fetchWithTimeout(url, options = {}, timeoutMs = 3000) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

async function getOllamaStatus() {
  try {
    const response = await fetchWithTimeout(OLLAMA_TAGS_URL, {}, 1800);
    if (!response.ok) return { reachable: false, modelAvailable: false };
    const data = await response.json();
    const models = Array.isArray(data.models) ? data.models : [];
    const match = models.some((entry) => entry.name === QWEN_MODEL || entry.name?.startsWith(`${QWEN_MODEL.split(':')[0]}:`));
    return { reachable: true, modelAvailable: match, model: QWEN_MODEL };
  } catch {
    return { reachable: false, modelAvailable: false, model: QWEN_MODEL };
  }
}

function runProcessor(inputPath, outputDir) {
  const scriptPath = path.join(__dirname, 'processor.py');
  const tryCandidate = (index) => new Promise((resolve, reject) => {
    const python = pythonCandidates[index];
    if (!python) return reject(new Error('Python 3 не найден. Запустите ./setup-ubuntu.sh.'));
    const child = spawn(python, [scriptPath, inputPath, outputDir], { cwd: __dirname, env: { ...process.env, PYTHONUNBUFFERED: '1' } });
    let stderr = '';
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); if (stdout.length > 200000) stdout = stdout.slice(-200000); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); if (stderr.length > 500000) stderr = stderr.slice(-500000); });
    child.on('error', (error) => {
      if (error.code === 'ENOENT' && index + 1 < pythonCandidates.length) return resolve(tryCandidate(index + 1));
      reject(error);
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) return resolve({ stdout, stderr });
      if (code === null && signal === 'SIGKILL') return reject(new Error('Обработка изображения превысила 2 минуты. Попробуйте фотографию меньшего размера.'));
      if (code === 127 && index + 1 < pythonCandidates.length) return resolve(tryCandidate(index + 1));
      reject(new Error((stderr.trim().split('\n').slice(-8).join('\n')) || `processor.py завершился с кодом ${code}`));
    });
  });
  return tryCandidate(0);
}

function extractJsonObject(rawText) {
  let text = String(rawText || '').trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Qwen не вернул JSON для CAD-реконструкции.');
  return JSON.parse(text.slice(start, end + 1));
}

function normalizeCadSpec(input) {
  const clamp = (value, low, high, fallback = 0) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(low, Math.min(high, n)) : fallback;
  };
  const txt = (value, max = 160) => String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  const routes = (Array.isArray(input.routes) ? input.routes : []).slice(0, 32).map((r, i) => ({
    id: txt(r?.id ?? '', 24), label: txt(r?.label ?? '', 40), kind: txt(r?.kind ?? 'main', 20),
    points: (Array.isArray(r?.points) ? r.points : []).slice(0, 30)
      .filter((p) => Array.isArray(p) && p.length >= 2)
      .map((p) => [clamp(p[0], 0, 1000), clamp(p[1], 0, 600)])
  })).filter((r) => r.points.length >= 2);
  if (routes.length === 0) throw new Error('Qwen не описал линии схемы для чистового чертежа.');
  const symbols = (Array.isArray(input.symbols) ? input.symbols : []).slice(0, 120).map((s) => ({
    type: txt(s?.type ?? 'junction', 20), x: clamp(s?.x, 0, 1000), y: clamp(s?.y, 0, 600), label: txt(s?.label ?? s?.id ?? '', 32)
  }));
  const labels = (Array.isArray(input.labels) ? input.labels : []).slice(0, 160).map((l) => ({
    x: clamp(l?.x, 0, 1000), y: clamp(l?.y, 0, 600), text: txt(l?.text ?? '', 160),
    angle: clamp(l?.angle, -90, 90), size: clamp(l?.size, 6, 18, 10), kind: txt(l?.kind ?? 'note', 20)
  })).filter((l) => l.text);
  const dimensions = (Array.isArray(input.dimensions) ? input.dimensions : []).slice(0, 120).map((d) => ({
    x1: clamp(d?.x1, 0, 1000), y1: clamp(d?.y1, 0, 600), x2: clamp(d?.x2, 0, 1000), y2: clamp(d?.y2, 0, 600), text: txt(d?.text ?? '', 40)
  })).filter((d) => d.text);
  const legend = (Array.isArray(input.legend) ? input.legend : []).slice(0, 8).map((item) => txt(typeof item === 'object' ? item.text : item, 150)).filter(Boolean);
  return {
    title: txt(input.title || 'СХЕМА ТРУБОПРОВОДА', 100),
    subtitle: txt(input.subtitle || 'Перерисовано по исходному эскизу', 180),
    summary: txt(input.summary || 'Схема приблизительно восстановлена по изображению.', 900),
    routes, symbols, labels, dimensions, legend
  };
}

function cadQualityIssue(spec, sourceStats = {}) {
  const contours = Number(sourceStats.contours || 0);
  const sourceWidth = Number(sourceStats.width || 0);
  const sourceHeight = Number(sourceStats.height || 0);
  // Photos with many contours are normally full engineering drawings, not a single pipe.
  const complex = contours >= 80 || (sourceWidth * sourceHeight >= 500000 && contours >= 35);
  const routeCount = spec.routes.length;
  const pointCount = spec.routes.reduce((sum, route) => sum + route.points.length, 0);
  const uniquePoints = new Set(spec.routes.flatMap(route => route.points.map(point => `${Math.round(point[0])},${Math.round(point[1])}`)));
  const minRoutes = complex ? 4 : 1;
  const minPoints = complex ? 14 : 4;

  if (routeCount < minRoutes) {
    return `слишком мало отдельных трасс: ${routeCount}; для сложности исходника требуется не менее ${minRoutes}`;
  }
  if (pointCount < minPoints) {
    return `слишком мало вершин: ${pointCount}; требуется не менее ${minPoints}`;
  }
  if (complex && uniquePoints.size < 8) {
    return `геометрия схлопнулась: только ${uniquePoints.size} уникальных координат для сложной схемы`;
  }
  return null;
}

async function reconstructWithQwen(imagePath, notes, strictMode, sourceStats = {}) {
  const img = await fs.readFile(imagePath);
  const isComplex = Number(sourceStats.contours || 0) >= 80 ||
    (Number(sourceStats.width || 0) * Number(sourceStats.height || 0) >= 500000 && Number(sourceStats.contours || 0) >= 35);
  const minRoutes = isComplex ? 5 : 1;
  const minPoints = isComplex ? 16 : 4;
  const aspect = Number(sourceStats.height) > 0 ? Number(sourceStats.width) / Number(sourceStats.height) : 1.42;
  const ocrHints = Array.isArray(sourceStats.ocr) ? sourceStats.ocr.slice(0, 35).map(String).filter(Boolean) : [];
  let lastProblem = '';

  // One corrective retry prevents a one-line/one-curve answer from being presented as a CAD drawing.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const correction = attempt === 1 ? '' : [
      'ПРЕДЫДУЩИЙ ОТВЕТ БЫЛ ОТКЛОНЁН ПРОВЕРКОЙ КАЧЕСТВА: ' + lastProblem + '.',
      'Это не рисунок одной трубки. Повторно внимательно изучи всё изображение и восстанови основную трассу И КАЖДОЕ видимое ответвление отдельными маршрутами.',
      `Обязательно верни минимум ${minRoutes} разных объектов в routes и минимум ${minPoints} точек суммарно. Не дублируй один маршрут и не заменяй сеть одной длинной ломаной.`,
      'Координаты соседних трасс должны совпадать в местах реальных соединений. Геометрию строят прямые отрезки между точками; кривые/сплайны не использовать.'
    ].join('\n');

    const prompt = [
      'Ты — инженер-чертёжник, который преобразует фото рукописной трубопроводной/технической схемы в структурированный 2D-чертёж для последующего рендеринга. Это НЕ задача фильтрации фото и НЕ задача рисования одной декоративной линии.',
      'Верни только один валидный JSON-объект без Markdown, без текста до/после JSON.',
      `Исходное изображение имеет размер ${sourceStats.width || '?'}×${sourceStats.height || '?'} px, отношение сторон ${aspect.toFixed(3)}. Поле координат: x от 0 до 1000 слева направо, y от 0 до 600 сверху вниз. Эти оси соответствуют всей ширине и всей высоте исходного изображения; не обрезай и не сплющивай расположение схемы. Рендерер сохранит исходное отношение сторон.`,
      'ГЛАВНОЕ: восстанови СЕТЬ, а не контур всей картинки. Каждую отдельную магистраль/ветвь между узлами или концами укажи отдельным объектом routes. В местах разветвления разделяй пути на разные routes и повторяй одни и те же координаты точки соединения у соседних ветвей. Не объединяй всё в один route. Не возвращай одну кривую или одну диагональ вместо схемы.',
      'Каждый route — ломаная из прямых отрезков. Никаких кривых, сплайнов, декоративных линий, волн, случайных изгибов или сглаживания. Используй отдельные вершины при каждом повороте линии и каждом узле. Сохраняй относительное положение, порядок и направления ветвей как на фото.',
      isComplex
        ? `На исходнике много элементов. Нужны минимум ${minRoutes} отдельных routes и минимум ${minPoints} координатных точек суммарно. Обычно сложная схема содержит 5–20 трасс; опиши каждую видимую ветвь. Не создавай несуществующую геометрию: если область нечитаема, сохрани только уверенно видимое.`
        : `Минимум ${minRoutes} route и ${minPoints} точек суммарно. Если схема содержит несколько ветвей, каждая ветвь должна стать отдельным route.`,
      'Подписи и размеры переноси только если они читаются. Не исправляй числа «по смыслу» и не придумывай их. Для непонятных значений лучше не создавать label, а отметить неопределённость в summary. Узлы размещай только на видимых соединениях. Символы клапанов/арматуры указывай лишь если они действительно различимы.',
      'JSON-формат: {"title":"название","subtitle":"подзаголовок","summary":"что восстановлено и что требует проверки","routes":[{"id":"R1","label":"","kind":"main|branch","points":[[100,100],[180,100],[180,150]]}],"symbols":[{"type":"junction|valve|pump|end|tank|node","x":180,"y":100,"label":"1"}],"labels":[{"x":200,"y":90,"text":"видимый текст","angle":0,"kind":"note|dimension|node","size":10}],"dimensions":[{"x1":100,"y1":100,"x2":180,"y2":100,"text":"прочитанный размер"}],"legend":["примечание"]}.',
      `Ограничения вывода: routes — ${minRoutes}–24 объекта, в каждом 2–18 points; symbols до 40; labels до 50; dimensions до 24; legend до 6 пунктов. Координаты числовые, x в диапазоне 0..1000, y в 0..600. Маршруты должны заметно различаться по расположению и/или направлению. Не дублируй трассы.`,
      'Оформление будет добавлено программой. От тебя требуется правильная геометрическая структура и достоверные данные, а не придумывание рамки/дизайна. Вывод предназначен для последующей проверки человеком; точность важнее украшательства.',
      strictMode ? 'Строгий режим: не угадывай числа и соединения. Если сомневаешься — пропусти ненадёжную подпись и перечисли сомнение в summary.' : '',
      ocrHints.length ? `Возможные OCR-подсказки с этого же фото (могут содержать ошибки; сверяй с изображением и не считай автоматически правильными): ${ocrHints.join(' | ')}` : '',
      notes ? `Пожелания пользователя: ${notes}` : '',
      correction
    ].filter(Boolean).join('\n');

    try {
      const response = await fetchWithTimeout(OLLAMA_CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: QWEN_MODEL,
          messages: [{ role: 'user', content: prompt, images: [img.toString('base64')] }],
          stream: false,
          format: 'json',
          options: { num_ctx: 6144, num_predict: 2600, temperature: 0.0, top_p: 0.85 }
        })
      }, 300000);
      if (!response.ok) throw new Error(`Ollama ответил HTTP ${response.status}`);
      const body = await response.json();
      const parsed = extractJsonObject(body?.message?.content || '');
      const spec = normalizeCadSpec(parsed);
      spec.sourceAspect = Math.max(0.4, Math.min(2.5, aspect));
      const issue = cadQualityIssue(spec, sourceStats);
      if (issue) {
        lastProblem = issue;
        console.warn(`Qwen CAD attempt ${attempt} rejected by geometry validation: ${issue}`);
        continue;
      }
      return spec;
    } catch (error) {
      lastProblem = String(error?.message || error).slice(0, 400);
      console.warn(`Qwen CAD attempt ${attempt} failed: ${lastProblem}`);
    }
  }
  throw new Error(`Qwen не восстановил достаточно подробную геометрию после двух попыток (${lastProblem}). Некорректный чертёж не выдан. Попробуйте загрузить более чёткое фото или отдельные крупные фрагменты схемы.`);
}

function runCadRenderer(specPath, outputDir) {
  return new Promise((resolve, reject) => {
    const python = pythonCandidates[0] || 'python3';
    const scriptPath = path.join(__dirname, 'cad_renderer.py');
    const child = spawn(python, [scriptPath, specPath, outputDir], {
      cwd: __dirname,
      env: { ...process.env, PYTHONUNBUFFERED: '1' }
    });
    let stderr = '';
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); if (stdout.length > 100000) stdout = stdout.slice(-100000); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); if (stderr.length > 300000) stderr = stderr.slice(-300000); });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 60000);
    child.on('error', (error) => { clearTimeout(timeout); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) {
        try { resolve(JSON.parse(stdout.trim().split('\n').slice(-1)[0])); }
        catch { resolve({ ok: true }); }
      } else {
        reject(new Error(stderr.trim().split('\n').slice(-8).join('\n') || `cad_renderer.py завершился с кодом ${code ?? signal}`));
      }
    });
  });
}

async function analyzeWithQwen(imagePath, notes, strictMode) {
  const img = await fs.readFile(imagePath);
  const prompt = [
    'Ты — помощник по анализу технических схем для последующей ручной проверки инженером.',
    'Изучи приложенное фото рукописной инженерной/трубопроводной схемы. Не перерисовывай и не фантазируй. Верни короткий ответ по-русски с разделами:',
    '1) Тип схемы (если можно определить).',
    '2) Видимые элементы: линии/ветви, узлы, клапаны/условные символы, таблицы и легенды.',
    '3) Надписи и числа, которые действительно читаются. Цитируй их как на фото; не исправляй и не нормализуй.',
    '4) Что не удалось прочитать или в чём есть неоднозначность.',
    '5) Что инженер должен проверить перед использованием.',
    'Не выдавай предположения за факты. Если текст нечитаем, напиши «неразборчиво». Не придумывай размеры, параметры, соединения или отсутствующие компоненты.',
    strictMode ? 'Особенно строго сохраняй достоверность обозначений и чисел: не угадывай.' : '',
    notes ? `Пожелания пользователя: ${notes}` : ''
  ].filter(Boolean).join('\n');

  const response = await fetchWithTimeout(OLLAMA_CHAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: QWEN_MODEL,
      messages: [{ role: 'user', content: prompt, images: [img.toString('base64')] }],
      stream: false,
      options: { num_ctx: 4096, num_predict: 650, temperature: 0.1 }
    })
  }, 240000);
  if (!response.ok) throw new Error(`Ollama ответил HTTP ${response.status}`);
  const body = await response.json();
  const content = body?.message?.content?.trim();
  if (!content) throw new Error('Qwen не вернул анализ схемы.');
  return content;
}

app.get('/api/health', async (_req, res) => {
  const ollama = await getOllamaStatus();
  res.json({
    ok: true,
    mode: 'offline-local',
    processor: 'Qwen CAD reconstruction + OpenCV + Tesseract + SVG/DXF',
    model: QWEN_MODEL,
    ollamaReachable: ollama.reachable,
    qwenAvailable: ollama.modelAvailable,
    status: ollama.modelAvailable ? 'Локальная модель готова' : ollama.reachable ? 'Ollama работает, модель нужно скачать' : 'Локальная обработка доступна; Qwen пока не подключён'
  });
});

app.post('/api/convert', convertLimiter, (req, res, next) => {
  upload.single('image')(req, res, (error) => {
    if (error) {
      if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Файл слишком большой. Максимальный размер — 15 МБ.' });
      return res.status(400).json({ error: error.message || 'Не удалось принять файл.' });
    }
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Сначала выберите фотографию или скан схемы.' });
  if (!hasValidImageSignature(req.file.buffer, req.file.mimetype)) return res.status(400).json({ error: 'Содержимое файла не похоже на выбранный формат изображения.' });

  const notes = typeof req.body.notes === 'string' ? req.body.notes.trim().slice(0, 1200) : '';
  const strictMode = req.body.strictMode === 'true';
  const mode = req.body.mode === 'clean' ? 'clean' : 'cad';
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cad-sketch-'));
  const inputPath = path.join(tempDir, `source${path.extname(req.file.originalname || '') || '.img'}`);
  try {
    await fs.writeFile(inputPath, req.file.buffer);
    await runProcessor(inputPath, tempDir);
    const processed = JSON.parse(await fs.readFile(path.join(tempDir, 'result.json'), 'utf8'));
    let image = await fs.readFile(path.join(tempDir, 'clean.png'));
    let svg = await fs.readFile(path.join(tempDir, 'trace.svg'));
    let dxf = await fs.readFile(path.join(tempDir, 'trace.dxf'));
    let analysis = '';
    let qwenAvailable = false;
    let analysisNotice = '';
    let stats = processed.trace;
    let note = processed.note;
    let filenamePrefix = 'cad-clean';
    let cadReconstructed = false;
    if (mode === 'cad') {
      try {
        const spec = await reconstructWithQwen(path.join(tempDir, 'vision.jpg'), notes, strictMode, {
          contours: processed.trace?.contours || 0,
          width: processed.source_size?.width || 0,
          height: processed.source_size?.height || 0,
          ocr: processed.ocr || []
        });
        const specPath = path.join(tempDir, 'cad-spec.json');
        await fs.writeFile(specPath, JSON.stringify(spec, null, 2), 'utf8');
        const renderStats = await runCadRenderer(specPath, tempDir);
        image = await fs.readFile(path.join(tempDir, 'cad-redraw.png'));
        svg = await fs.readFile(path.join(tempDir, 'cad-redraw.svg'));
        dxf = await fs.readFile(path.join(tempDir, 'cad-redraw.dxf'));
        analysis = spec.summary || 'Схема восстановлена по визуальной оценке Qwen.';
        qwenAvailable = true;
        stats = { ...renderStats, width: 1960, height: 1400, sheet: 'A3 · приблизительная CAD-реконструкция' };
        note = 'Внимание: линии, символы и подписи реконструированы моделью приблизительно. Сверьте все числа, размеры и соединения с оригиналом перед использованием.';
        filenamePrefix = 'cad-redraw';
        cadReconstructed = true;
      } catch (error) {
        console.warn('CAD reconstruction rejected:', error?.stack || error);
        return res.status(422).json({
          error: String(error?.message || error).slice(0, 900),
          hint: 'Система намеренно не выдала одну случайную линию вместо схемы. Для сложного чертежа попробуйте снимок прямо сверху, без перспективы, и при необходимости загрузите крупные фрагменты по отдельности.'
        });
      }
    } else {
      try {
        analysis = await analyzeWithQwen(path.join(tempDir, 'vision.jpg'), notes, strictMode);
        qwenAvailable = true;
      } catch (error) {
        analysisNotice = 'Векторизация и OCR выполнены. Qwen-анализ сейчас недоступен: проверьте, что Ollama запущен и модель qwen2.5vl:3b скачана.';
        console.warn('Local Qwen analysis skipped:', error?.message || error);
      }
    }

    const ocrText = Array.isArray(processed.ocr) && processed.ocr.length ? processed.ocr.join(' · ') : 'Tesseract не распознал уверенно текст. Сверьте подписи вручную.';
    const date = new Date().toISOString().slice(0, 10);
    res.json({
      image: `data:image/png;base64,${image.toString('base64')}`,
      svg: `data:image/svg+xml;base64,${svg.toString('base64')}`,
      dxf: `data:application/dxf;base64,${dxf.toString('base64')}`,
      filenames: { png: `${filenamePrefix}-${date}.png`, svg: `${filenamePrefix}-${date}.svg`, dxf: `${filenamePrefix}-${date}.dxf` },
      analysis,
      ocrText,
      qwenAvailable,
      analysisNotice,
      stats,
      note,
      mode,
      cadReconstructed
    });
  } catch (error) {
    console.error('Offline conversion error:', error?.stack || error);
    const message = error?.message || 'Не удалось выполнить локальную обработку.';
    const dependencyHint = /No module named|ImportError|TesseractNotFoundError|processor.py/.test(message)
      ? ' Проверьте зависимости командой ./setup-ubuntu.sh.' : '';
    res.status(500).json({ error: `Ошибка локальной обработки: ${message}${dependencyHint}` });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

app.use((error, _req, res, _next) => {
  console.error('Unhandled server error:', error);
  res.status(500).json({ error: 'Внутренняя ошибка сервера.' });
});

app.listen(PORT, HOST, () => {
  console.log(`CAD Sketch Converter Offline запущен: http://localhost:${PORT} (host ${HOST})`);
  console.log(`Режим: локальная обработка, Qwen через ${OLLAMA_CHAT_URL}`);
});
