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
  const text = String(rawText || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Ollama не вернул JSON-объект.');
  return JSON.parse(text.slice(start, end + 1));
}

// Ollama structured outputs constrain the response shape. The model is used as a
// symbol/annotation recogniser AND as a rough line detector. It does NOT attempt to
// infer topology: routes are reported as-is, without cross-tile junction merging.
const SYMBOL_JSON_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    symbols: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' }, type: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' },
          label: { type: 'string' }, confidence: { type: 'number' }
        },
        required: ['id', 'type', 'x', 'y', 'label', 'confidence']
      }
    },
    routes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' }, from_node: { type: 'string' }, to_node: { type: 'string' },
          points: {
            type: 'array',
            items: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] }
          },
          kind: { type: 'string' }, label: { type: 'string' }, confidence: { type: 'number' }
        },
        required: ['id', 'from_node', 'to_node', 'points', 'kind', 'label', 'confidence']
      }
    },
    labels: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' },
          angle: { type: 'number' }, kind: { type: 'string' }, size: { type: 'number' }, confidence: { type: 'number' }
        },
        required: ['text', 'x', 'y', 'angle', 'kind', 'size', 'confidence']
      }
    },
    dimensions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' },
          text: { type: 'string' }, confidence: { type: 'number' }
        },
        required: ['x1', 'y1', 'x2', 'y2', 'text', 'confidence']
      }
    },
    legend: { type: 'array', items: { type: 'string' } },
    uncertainties: { type: 'array', items: { type: 'string' } }
  },
  required: ['title', 'summary', 'symbols', 'routes', 'labels', 'dimensions', 'legend', 'uncertainties']
};

function clampNumber(value, low, high, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(low, Math.min(high, n)) : fallback;
}
function cleanText(value, max = 160) {
  return String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function transformLocalPoint(point, tile) {
  const x = clampNumber(point?.x, 0, 1000);
  const y = clampNumber(point?.y, 0, 1000);
  const fullWidth = Math.max(1, Number(tile.fullWidth || tile.width || 1));
  const fullHeight = Math.max(1, Number(tile.fullHeight || tile.height || 1));
  return [
    clampNumber(((Number(tile.x || 0) + (x / 1000) * Number(tile.width || fullWidth)) / fullWidth) * 1000, 0, 1000),
    clampNumber(((Number(tile.y || 0) + (y / 1000) * Number(tile.height || fullHeight)) / fullHeight) * 1000, 0, 1000)
  ];
}

function normalizeTileGraph(raw, tile) {
  // The model reports symbols, labels and routes. Routes are passed through as-is:
  // cross-tile junction merging is intentionally NOT applied, because the model's
  // per-tile node IDs do not correspond across tiles and merging them produces
  // disconnected fragments rather than a coherent network.
  const parsed = raw && typeof raw === 'object' ? raw : {};
  const symbols = [];
  for (const [i, sym] of (Array.isArray(parsed.symbols) ? parsed.symbols : []).slice(0, 120).entries()) {
    const id = cleanText(sym?.id || `S${i + 1}`, 32);
    if (!id) continue;
    const [x, y] = transformLocalPoint({ x: sym?.x, y: sym?.y }, tile);
    symbols.push({
      id, x, y,
      type: cleanText(sym?.type || 'unknown', 24).toLowerCase(),
      label: cleanText(sym?.label || '', 40),
      confidence: clampNumber(sym?.confidence, 0, 1, 0.5),
      tileIndex: Number(tile.index || 1)
    });
  }

  const routes = [];
  for (const [i, connection] of (Array.isArray(parsed.routes) ? parsed.routes : []).slice(0, 240).entries()) {
    const mid = (Array.isArray(connection?.points) ? connection.points : []).slice(0, 20)
      .map((p) => transformLocalPoint(p, tile));
    const points = [];
    for (const point of mid) {
      const prev = points[points.length - 1];
      if (!prev || Math.hypot(prev[0] - point[0], prev[1] - point[1]) > 1.5) points.push(point);
    }
    if (points.length < 2) continue;
    routes.push({
      id: `T${tile.index || 1}-${cleanText(connection?.id || `S${i + 1}`, 24)}`,
      label: cleanText(connection?.label || '', 40), kind: cleanText(connection?.kind || 'branch', 20),
      points, confidence: clampNumber(connection?.confidence, 0, 1, 0.5),
      fromNode: cleanText(connection?.from_node || '', 32), toNode: cleanText(connection?.to_node || '', 32),
      tileIndex: Number(tile.index || 1)
    });
  }

  const labels = (Array.isArray(parsed.labels) ? parsed.labels : []).slice(0, 80).map((label) => {
    const [x, y] = transformLocalPoint({ x: label?.x, y: label?.y }, tile);
    return { x, y, text: cleanText(label?.text, 160), angle: clampNumber(label?.angle, -90, 90), size: clampNumber(label?.size, 6, 18, 10), kind: cleanText(label?.kind || 'note', 20), confidence: clampNumber(label?.confidence, 0, 1, 0.5), tileIndex: Number(tile.index || 1) };
  }).filter((label) => label.text);

  const dimensions = (Array.isArray(parsed.dimensions) ? parsed.dimensions : []).slice(0, 50).map((dim) => {
    const [x1, y1] = transformLocalPoint({ x: dim?.x1, y: dim?.y1 }, tile);
    const [x2, y2] = transformLocalPoint({ x: dim?.x2, y: dim?.y2 }, tile);
    return { x1, y1, x2, y2, text: cleanText(dim?.text, 40), confidence: clampNumber(dim?.confidence, 0, 1, 0.5), tileIndex: Number(tile.index || 1) };
  }).filter((dim) => dim.text);

  return {
    title: cleanText(parsed.title || '', 100), summary: cleanText(parsed.summary || '', 700),
    symbols, routes, labels, dimensions,
    legend: (Array.isArray(parsed.legend) ? parsed.legend : []).slice(0, 8).map((s) => cleanText(s, 150)).filter(Boolean),
    uncertainties: (Array.isArray(parsed.uncertainties) ? parsed.uncertainties : []).slice(0, 20).map((s) => cleanText(s, 180)).filter(Boolean),
    symbolCount: symbols.length,
    routeCount: routes.length
  };
}

function dedupeObjectsNear(items, getPos, threshold, getKey = (item) => '') {
  const result = [];
  for (const item of items) {
    const pos = getPos(item);
    const key = getKey(item);
    const match = result.find((candidate) => {
      if (item.tileIndex !== undefined && candidate.tileIndex !== undefined && item.tileIndex === candidate.tileIndex) return false;
      if (key && getKey(candidate) && key !== getKey(candidate)) return false;
      const other = getPos(candidate);
      return Math.hypot(pos[0] - other[0], pos[1] - other[1]) <= threshold;
    });
    if (!match) result.push(item);
    else if ((item.confidence || 0) > (match.confidence || 0)) Object.assign(match, item);
  }
  return result;
}

function makeTilePrompt(tile, sourceStats, notes, strictMode, correction = '') {
  const aspect = Number(tile.width || 1) / Math.max(1, Number(tile.height || 1));
  return [
    'Ты — помощник по распознаванию инженерной схемы трубопровода. Ты НЕ определяешь топологию и НЕ соединяешь линии в узлы. Ты только отчётливо перечисляешь, что ты видишь на изображении.',
    'Используй прикреплённое изображение текущего фрагмента. Возвращай координаты ОТНОСИТЕЛЬНО ТОЛЬКО ЭТОГО ФРАГМЕНТА: x и y от 0 до 1000, начало в левом верхнем углу. Пропорции изображения должны сохраняться.',
    'SYMBOLS — перечисли каждый условный символ, который ты видишь: клапаны/задвижки, насосы, резервуары/баки, клеммы/коробки, манометры, фильтры, арматура. Для каждого укажи id, тип (valve, pump, tank, junction, end, unknown), приблизительные координаты x,y центра символа, подпись/метку если она есть и confidence 0..1. Если тип неясен — unknown. Не придумывай символы, которых нет на изображении.',
    'ROUTES — перечисли каждую видимую линию как отдельный route. Для каждой линии укажи id, from_node и to_node (любые строковые id, не обязательно связанные с other routes), kind (main, branch, unknown), координаты концов и промежуточных точек в points, подпись если есть, confidence 0..1. Важно: описывай только реальные линии, которые видишь. Не соединяй разные линии в одну, не выдумывай ветви, не соединяй перекрещивающиеся линии, если нет признака соединения. Если линия имеет изгибы/повороты, добавь промежуточные точки. Если на фрагменте нет линий, оставь массив пустым.',
    'LABELS — перечисли каждый читаемый текст: позиционные обозначения (например К1, К2, П1), номиналы, названия узлов, подписи к стрелкам. Для каждого: текст, координаты x,y, угол наклона текста в градусах (-90..90), kind (node, dimension, note, title), размер шрифта, confidence 0..1. Неразборчивые подписи не включай; взамен добавь текст в uncertainties.',
    'DIMENSIONS — размерные линии с конечными точками (x1,y1,x2,y2) и точно прочитанным текстом размера. Не угадывай цифры: если не читается, не включай в dimensions, а укажи в uncertainties.',
    'UNCERTAINTIES — перечисли, в чём неопределённость: неразборчивый текст, неясный символ, перекрещивающиеся линии, где непонятно соединение или нет. Будь честен: лучше перечислить сомнение, чем придумать.',
    'LEGEND — если на фрагменте есть легенда/таблица с условными обозначениями, перечисли её пункты.',
    `Фрагмент ${tile.index || 1}; локальный размер ${tile.width}×${tile.height} px; отношение сторон ${aspect.toFixed(3)}. Это один фрагмент большого эскиза, не пытайся восстанавливать отсутствующие за его границами области.`,
    strictMode ? 'Строгий режим: если элемент не подтверждается изображением, пропусти и перечисли неопределённость.' : '',
    notes ? `Примечания пользователя: ${notes}` : '',
    correction,
    'Ответ формируется по строгой JSON Schema. Заполни title, summary, symbols, routes, labels, dimensions, legend, uncertainties. Не добавляй объяснения вне JSON.'
  ].filter(Boolean).join('\n');
}

async function callOllamaForTile(tilePath, tile, sourceStats, notes, strictMode, correction = '') {
  const img = await fs.readFile(tilePath);
  const response = await fetchWithTimeout(OLLAMA_CHAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: QWEN_MODEL,
      messages: [{ role: 'user', content: makeTilePrompt(tile, sourceStats, notes, strictMode, correction), images: [img.toString('base64')] }],
      stream: false,
      format: SYMBOL_JSON_SCHEMA,
      options: { num_ctx: 4096, num_predict: 2200, temperature: 0, top_p: 0.8, repeat_penalty: 1.05 }
    })
  }, 300000);
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    if (response.status === 404) {
      throw new Error(`Ollama HTTP 404: модель '${QWEN_MODEL}' не найдена в Docker-хранилище. Выполните: docker compose exec ollama ollama pull ${QWEN_MODEL}. Ответ Ollama: ${body.slice(0, 240)}`);
    }
    throw new Error(`Ollama HTTP ${response.status}: ${body.slice(0, 240)}`);
  }
  const data = await response.json();
  const content = data?.message?.content;
  if (!content) throw new Error('Ollama вернул пустой ответ для фрагмента.');
  return extractJsonObject(content);
}

async function recognizeWithQwen(tileDescriptors, tempDir, notes, strictMode, sourceStats = {}) {
  // The model reports symbols, labels, dimensions and routes. Routes are passed through
  // as-is: cross-tile junction merging is intentionally NOT applied, because the model's
  // per-tile node IDs do not correspond across tiles and merging them produces
  // disconnected fragments rather than a coherent network.
  const visionSize = sourceStats.visionSize || { width: sourceStats.width || 1, height: sourceStats.height || 1 };
  let allSymbols = [];
  let allRoutes = [];
  let allLabels = [];
  let allDimensions = [];
  let summaries = [];
  let titles = [];
  let uncertainties = [];
  let tileSuccess = 0;
  let tileErrors = [];
  const tiles = (Array.isArray(tileDescriptors) && tileDescriptors.length ? tileDescriptors : [{ file: 'vision.jpg', index: 1, x: 0, y: 0, width: visionSize.width, height: visionSize.height, fullWidth: visionSize.width, fullHeight: visionSize.height, inkRatio: 1 }]);
  const nonBlankTiles = tiles.filter((tile) => Number(tile.inkRatio ?? 1) >= 0.0006);
  const workTiles = nonBlankTiles.length ? nonBlankTiles : [tiles[0]];

  for (const tile of workTiles) {
    const tilePath = path.join(tempDir, path.basename(tile.file || 'vision.jpg'));
    const localTile = { ...tile, fullWidth: Number(tile.fullWidth || visionSize.width), fullHeight: Number(tile.fullHeight || visionSize.height) };
    let parsed = null;
    let local = null;
    let tileError = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        parsed = await callOllamaForTile(tilePath, localTile, sourceStats, notes, strictMode,
          attempt === 1 ? '' : 'ПРЕДЫДУЩИЙ ОТВЕТ НЕ СОДЕРЖАЛ ДОСТАТОЧНО СИМВОЛОВ ИЛИ ЛИНИЙ. Повторно исследуй этот фрагмент. Перечисли каждый видимый условный символ, каждую видимую линию и читаемый текст с координатами. Не придумывай элементы; если фрагмент пуст, оставь массивы пустыми.');
        local = normalizeTileGraph(parsed, localTile);
        if ((local.symbolCount > 0 || local.routeCount > 0) || Number(tile.inkRatio || 0) < 0.004) break;
        tileError = new Error('Для фрагмента не извлечены символы.');
      } catch (error) {
        tileError = error;
        if (/Ollama HTTP 404/.test(String(error?.message || error))) throw error;
      }
    }
    if (!local) {
      tileErrors.push(`Фрагмент ${tile.index}: ${String(tileError?.message || tileError).slice(0, 120)}`);
      continue;
    }
    if (!local.symbolCount && !local.routeCount && Number(tile.inkRatio || 0) >= 0.004) {
      tileErrors.push(`Фрагмент ${tile.index}: модель не нашла символов`);
      continue;
    }
    tileSuccess++;
    allSymbols.push(...local.symbols);
    allRoutes.push(...local.routes);
    allLabels.push(...local.labels);
    allDimensions.push(...local.dimensions);
    if (local.summary) summaries.push(local.summary);
    if (local.title) titles.push(local.title);
    uncertainties.push(...local.uncertainties);
  }

  allSymbols = dedupeObjectsNear(allSymbols, (s) => [s.x, s.y], 10, (s) => s.type);
  allLabels = dedupeObjectsNear(allLabels, (l) => [l.x, l.y], 16, (l) => l.text.toLowerCase());
  allDimensions = dedupeObjectsNear(allDimensions, (d) => [(d.x1 + d.x2) / 2, (d.y1 + d.y2) / 2], 14, (d) => d.text.toLowerCase());

  return {
    title: (titles.find((title) => title && !/^(?:техническая схема|схема|чертёж)$/i.test(title)) || 'СХЕМА ТРУБОПРОВОДА').slice(0, 100),
    subtitle: 'Распознавание символов и линий по фрагментам изображения · топология не реконструируется',
    summary: [...new Set(summaries)].join(' | ').slice(0, 1200) || 'Символы, линии и текст распознаны по отдельным фрагментам. Топологию и соединения определяйте вручную.',
    routes: allRoutes.slice(0, 180),
    symbols: allSymbols.slice(0, 160),
    labels: allLabels.slice(0, 160),
    dimensions: allDimensions.slice(0, 100),
    legend: [
      `Проанализировано фрагментов: ${tileSuccess}/${workTiles.length}.`,
      ...[...new Set(uncertainties)].slice(0, 3),
      ...(tileErrors.length ? [`Не полностью обработано: ${tileErrors.join('; ').slice(0, 180)}`] : []),
      'Топология схемы не реконструируется автоматически — соединения определяются вручную.'
    ].slice(0, 6),
    sourceAspect: Number(sourceStats.width) / Math.max(1, Number(sourceStats.height)),
    diagnostics: { tilesProcessed: tileSuccess, tilesTotal: workTiles.length, rejectedTiles: tileErrors, rawRoutes: allRoutes.length }
  };
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
  if (!response.ok) { const detail = await response.text().catch(() => ''); if (response.status === 404) throw new Error(`Ollama HTTP 404: модель '${QWEN_MODEL}' не найдена в выбранном Ollama. Проверьте docker compose exec ollama ollama list; при необходимости выполните docker compose exec ollama ollama pull ${QWEN_MODEL}. ${detail.slice(0, 180)}`); throw new Error(`Ollama ответил HTTP ${response.status}: ${detail.slice(0, 180)}`); }
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
        const spec = await recognizeWithQwen(processed.vision_tiles || [], tempDir, notes, strictMode, {
          width: processed.source_size?.width || 0,
          height: processed.source_size?.height || 0,
          visionSize: processed.vision_size || processed.source_size,
          ocr: processed.ocr || []
        });
        const specPath = path.join(tempDir, 'cad-spec.json');
        await fs.writeFile(specPath, JSON.stringify(spec, null, 2), 'utf8');
        const renderStats = await runCadRenderer(specPath, tempDir);
        image = await fs.readFile(path.join(tempDir, 'cad-redraw.png'));
        svg = await fs.readFile(path.join(tempDir, 'cad-redraw.svg'));
        dxf = await fs.readFile(path.join(tempDir, 'cad-redraw.dxf'));
        analysis = [spec.summary, ...(spec.legend || [])].filter(Boolean).join('\n');
        qwenAvailable = true;
        stats = { ...renderStats, width: 1960, height: 1400, sheet: 'A3 · распознавание символов', routes: renderStats.routes || 0, symbols: renderStats.symbols || 0, labels: renderStats.labels || 0, tilesProcessed: spec.diagnostics?.tilesProcessed || 0, tilesTotal: spec.diagnostics?.tilesTotal || 0 };
        note = 'Модель распознала символы и линии. Топология и соединения не реконструируются автоматически — определяйте вручную по исходному изображению.';
        filenamePrefix = 'cad-redraw';
        cadReconstructed = true;
      } catch (error) {
        console.warn('Symbol recognition rejected:', error?.stack || error);
        return res.status(422).json({
          error: String(error?.message || error).slice(0, 900),
          hint: 'Модель не смогла распознать символы. Попробуйте снимок прямо сверху, без перспективы, высокого разрешения.'
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
