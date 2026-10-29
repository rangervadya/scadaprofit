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

// Ollama structured outputs constrain the response shape. This improves parsing reliability,
// but does not guarantee that the model's interpretation of the drawing is correct.
const CAD_JSON_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    nodes: {
      type: 'array',
      // For a nonblank drawing tile, prevent the model from satisfying the schema
      // with an empty geometry graph. The normalization/validation code still rejects
      // invalid node positions or dangling connections.
      minItems: 2,
      maxItems: 180,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' }, type: { type: 'string' }, x: { type: 'number', minimum: 0, maximum: 1000 }, y: { type: 'number', minimum: 0, maximum: 1000 },
          label: { type: 'string' }, confidence: { type: 'number', minimum: 0, maximum: 1 }
        },
        required: ['id', 'type', 'x', 'y', 'label', 'confidence']
      }
    },
    connections: {
      type: 'array',
      minItems: 1,
      maxItems: 240,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' }, from_node: { type: 'string' }, to_node: { type: 'string' },
          points: {
            type: 'array',
            items: { type: 'object', properties: { x: { type: 'number', minimum: 0, maximum: 1000 }, y: { type: 'number', minimum: 0, maximum: 1000 } }, required: ['x', 'y'] }
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
          text: { type: 'string' }, x: { type: 'number', minimum: 0, maximum: 1000 }, y: { type: 'number', minimum: 0, maximum: 1000 },
          angle: { type: 'number', minimum: -90, maximum: 90 }, kind: { type: 'string' }, size: { type: 'number', minimum: 6, maximum: 18 }, confidence: { type: 'number', minimum: 0, maximum: 1 }
        },
        required: ['text', 'x', 'y', 'angle', 'kind', 'size', 'confidence']
      }
    },
    dimensions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          x1: { type: 'number', minimum: 0, maximum: 1000 }, y1: { type: 'number', minimum: 0, maximum: 1000 }, x2: { type: 'number', minimum: 0, maximum: 1000 }, y2: { type: 'number', minimum: 0, maximum: 1000 },
          text: { type: 'string' }, confidence: { type: 'number', minimum: 0, maximum: 1 }
        },
        required: ['x1', 'y1', 'x2', 'y2', 'text', 'confidence']
      }
    },
    legend: { type: 'array', items: { type: 'string' } },
    uncertainties: { type: 'array', items: { type: 'string' } }
  },
  required: ['title', 'summary', 'nodes', 'connections', 'labels', 'dimensions', 'legend', 'uncertainties']
};

function clampNumber(value, low, high, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(low, Math.min(high, n)) : fallback;
}
function cleanText(value, max = 160) {
  return String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function validLocalPoint(point) {
  const x = Number(point?.x);
  const y = Number(point?.y);
  return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 1000 && y >= 0 && y <= 1000;
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
  const parsed = raw && typeof raw === 'object' ? raw : {};
  const localNodes = new Map();
  const symbols = [];
  for (const [i, node] of (Array.isArray(parsed.nodes) ? parsed.nodes : []).slice(0, 180).entries()) {
    const id = cleanText(node?.id || `N${i + 1}`, 32);
    if (!id || !validLocalPoint(node)) continue;
    const [x, y] = transformLocalPoint({ x: node?.x, y: node?.y }, tile);
    const n = { id, x, y, type: cleanText(node?.type || 'unknown', 24).toLowerCase(), label: cleanText(node?.label || '', 40), confidence: clampNumber(node?.confidence, 0, 1, 0.5) };
    localNodes.set(id, n);
    if ((n.type && n.type !== 'unknown') && (n.type !== 'junction' || n.label)) {
      symbols.push({ type: n.type, x: n.x, y: n.y, label: n.label, confidence: n.confidence, sourceNodeId: id, tileIndex: Number(tile.index || 1) });
    }
  }

  const routes = [];
  for (const [i, connection] of (Array.isArray(parsed.connections) ? parsed.connections : []).slice(0, 240).entries()) {
    const from = localNodes.get(cleanText(connection?.from_node || '', 32));
    const to = localNodes.get(cleanText(connection?.to_node || '', 32));
    if (!from || !to) continue;
    const rawMid = (Array.isArray(connection?.points) ? connection.points : []).slice(0, 20);
    if (!rawMid.every(validLocalPoint)) continue;
    const mid = rawMid.map((p) => transformLocalPoint(p, tile));
    const points = [[from.x, from.y], ...mid, [to.x, to.y]];
    const unique = [];
    for (const point of points) {
      const prev = unique[unique.length - 1];
      if (!prev || Math.hypot(prev[0] - point[0], prev[1] - point[1]) > 1.5) unique.push(point);
    }
    if (unique.length < 2 || Math.hypot(unique[0][0] - unique[unique.length - 1][0], unique[0][1] - unique[unique.length - 1][1]) < 3) continue;
    routes.push({
      id: `T${tile.index || 1}-${cleanText(connection?.id || `S${i + 1}`, 24)}`,
      label: cleanText(connection?.label || '', 40), kind: cleanText(connection?.kind || 'branch', 20),
      points: unique, confidence: clampNumber(connection?.confidence, 0, 1, 0.5),
      fromNode: from.id, toNode: to.id, tileIndex: Number(tile.index || 1)
    });
  }

  const labels = (Array.isArray(parsed.labels) ? parsed.labels : []).slice(0, 80).filter(validLocalPoint).map((label) => {
    const [x, y] = transformLocalPoint({ x: label?.x, y: label?.y }, tile);
    return { x, y, text: cleanText(label?.text, 160), angle: clampNumber(label?.angle, -90, 90), size: clampNumber(label?.size, 6, 18, 10), kind: cleanText(label?.kind || 'note', 20), confidence: clampNumber(label?.confidence, 0, 1, 0.5), tileIndex: Number(tile.index || 1) };
  }).filter((label) => label.text);

  const dimensions = (Array.isArray(parsed.dimensions) ? parsed.dimensions : []).slice(0, 50).filter((dim) => validLocalPoint({ x: dim?.x1, y: dim?.y1 }) && validLocalPoint({ x: dim?.x2, y: dim?.y2 })).map((dim) => {
    const [x1, y1] = transformLocalPoint({ x: dim?.x1, y: dim?.y1 }, tile);
    const [x2, y2] = transformLocalPoint({ x: dim?.x2, y: dim?.y2 }, tile);
    return { x1, y1, x2, y2, text: cleanText(dim?.text, 40), confidence: clampNumber(dim?.confidence, 0, 1, 0.5), tileIndex: Number(tile.index || 1) };
  }).filter((dim) => dim.text);

  return {
    title: cleanText(parsed.title || '', 100), summary: cleanText(parsed.summary || '', 700),
    routes, symbols,
    labels, dimensions,
    legend: (Array.isArray(parsed.legend) ? parsed.legend : []).slice(0, 8).map((s) => cleanText(s, 150)).filter(Boolean),
    uncertainties: (Array.isArray(parsed.uncertainties) ? parsed.uncertainties : []).slice(0, 20).map((s) => cleanText(s, 180)).filter(Boolean),
    nodeCount: localNodes.size,
    connectionCount: routes.length
  };
}

function routeSignature(route) {
  const forward = route.points.map(([x, y]) => `${Math.round(x / 7)},${Math.round(y / 7)}`).join('|');
  const reverse = route.points.slice().reverse().map(([x, y]) => `${Math.round(x / 7)},${Math.round(y / 7)}`).join('|');
  return forward < reverse ? forward : reverse;
}

function mergeCloseRouteEndpoints(routes, tolerance = 8) {
  const endpoints = [];
  routes.forEach((route, routeIndex) => {
    if (route.points.length < 2) return;
    endpoints.push({ routeIndex, pointIndex: 0, point: route.points[0] });
    endpoints.push({ routeIndex, pointIndex: route.points.length - 1, point: route.points[route.points.length - 1] });
  });
  const parent = endpoints.map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
  for (let i = 0; i < endpoints.length; i++) {
    for (let j = i + 1; j < endpoints.length; j++) {
      if (endpoints[i].routeIndex === endpoints[j].routeIndex) continue;
      if (routes[endpoints[i].routeIndex].tileIndex === routes[endpoints[j].routeIndex].tileIndex) continue;
      if (Math.hypot(endpoints[i].point[0] - endpoints[j].point[0], endpoints[i].point[1] - endpoints[j].point[1]) <= tolerance) union(i, j);
    }
  }
  const groups = new Map();
  endpoints.forEach((entry, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(entry.point);
  });
  const centers = new Map();
  for (const [root, points] of groups) {
    centers.set(root, [points.reduce((sum, p) => sum + p[0], 0) / points.length, points.reduce((sum, p) => sum + p[1], 0) / points.length]);
  }
  endpoints.forEach((entry, i) => { routes[entry.routeIndex].points[entry.pointIndex] = centers.get(find(i)); });
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

function cadQualityIssue(spec, sourceStats = {}) {
  const contours = Number(sourceStats.contours || 0);
  const sourceWidth = Number(sourceStats.width || 0);
  const sourceHeight = Number(sourceStats.height || 0);
  const complex = contours >= 80 || (sourceWidth * sourceHeight >= 500000 && contours >= 35);
  const routeCount = spec.routes.length;
  const pointCount = spec.routes.reduce((sum, route) => sum + route.points.length, 0);
  const uniquePoints = new Set(spec.routes.flatMap(route => route.points.map(point => `${Math.round(point[0] / 4)},${Math.round(point[1] / 4)}`)));
  const xs = spec.routes.flatMap((r) => r.points.map((p) => p[0]));
  const ys = spec.routes.flatMap((r) => r.points.map((p) => p[1]));
  const spanX = xs.length ? Math.max(...xs) - Math.min(...xs) : 0;
  const spanY = ys.length ? Math.max(...ys) - Math.min(...ys) : 0;
  const minRoutes = complex ? 5 : 2;
  const minPoints = complex ? 12 : 4;
  if (routeCount < minRoutes) return `слишком мало отдельных соединений: ${routeCount}; требуется не менее ${minRoutes}`;
  if (pointCount < minPoints) return `слишком мало точек геометрии: ${pointCount}; требуется не менее ${minPoints}`;
  if (complex && uniquePoints.size < 8) return `геометрия схлопнулась: только ${uniquePoints.size} уникальных точек`;
  if (complex && Math.max(spanX, spanY) < 250) return `геометрия занимает слишком маленькую область (${Math.round(spanX)}×${Math.round(spanY)})`;
  const directionBins = new Set(spec.routes.map((route) => {
    const first = route.points[0], last = route.points[route.points.length - 1];
    let angle = Math.atan2(last[1] - first[1], last[0] - first[0]) * 180 / Math.PI;
    angle = (angle + 180) % 180;
    return Math.round(angle / 15);
  }));
  if (complex && directionBins.size < 2) return 'все сегменты имеют практически одно направление; ответ похож на одну линию, а не на сеть';
  return null;
}

function makeTilePrompt(tile, sourceStats, notes, strictMode, correction = '') {
  const aspect = Number(tile.width || 1) / Math.max(1, Number(tile.height || 1));
  return [
    'Ты — парсер инженерных схем трубопроводов. НЕ рисуй картинку. Верни только JSON по заданной схеме.',
    'Координаты относятся только к текущему фрагменту: x=0 слева, x=1000 справа; y=0 сверху, y=1000 снизу. Все координаты должны лежать в диапазоне 0..1000. Не используй проценты 0..100.',
    'СНАЧАЛА узлы (nodes): для каждого видимого участка трубы обязательно укажи реальные концы/стыки; если тип конца неясен, поставь type=unknown, а не пропускай видимую линию. Узел добавляй в конце линии, в подтверждённом соединении/ответвлении или центре видимого символа. Не создавай узел на каждом пикселе и на каждом плавном изгибе; обычные повороты передавай через points.',
    'Каждый узел имеет уникальный id внутри ЭТОГО фрагмента, тип junction/end/valve/pump/tank/filter/unknown, точные приблизительные x,y, label (пустая строка, если нет подписи), confidence 0..1.',
    'ЗАТЕМ соединения (connections). Каждое соединение — непрерывный видимый участок трубы от одного узла до другого. from_node и to_node ОБЯЗАНЫ ссылаться на id из nodes. Используй один и тот же node id для всех линий, которые действительно приходят в одно физическое соединение. Не создавай отдельные одинаково расположенные узлы вместо одного общего.',
    'Поле points содержит ТОЛЬКО промежуточные точки-повороты между узлами, в порядке прохождения трубы. Концы уже задаются координатами узлов. Для прямого участка points=[]; для ломаного укажи каждую реальную вершину. Не используй произвольные кривые и не добавляй декоративные диагонали.',
    'Важно для топологии: пересечение двух линий не означает соединение автоматически. Соединяй их только при видимом подтверждении — точка соединения, ответвление, соединительный символ. Если непонятно, оставь раздельные узлы/линии и запиши неопределённость. Не соединяй близкие линии только потому, что они рядом.',
    'Не выдумывай участок трубы, который закрыт текстом/не виден или уходит за край фрагмента. Не восстанавливай части за пределами изображения. Сохраняй форму маршрута и количество ветвей; не заменяй сетку/ветви одной диагональю или одной длинной линией.',
    'labels: перечисли только читаемый текст, числовые размеры и позиционные обозначения с координатами центра. Точно переписывай знаки и цифры; не угадывай. dimensions: укажи концы видимой размерной линии и текст только если он действительно читается.',
    'uncertainties: явно перечисли неясные узлы, линии, надписи или перекрёстки вместо догадки. legend: коротко перечисли видимую легенду, если она присутствует.',
    'ОБЯЗАТЕЛЬНО: если на фрагменте видны линии-трубы, не возвращай пустые nodes и connections. Проследи каждый видимый участок: для простой прямой трубы достаточно двух узлов и одного connection; неизвестный тип отмечай unknown. Не создавай невидимые трубы и не угадывай соединения, но не отбрасывай реальную видимую линию только из-за неуверенности в её назначении.',
    'Перед ответом проверь: все from_node/to_node существуют, у connection два разных узла, общий узел повторно используется ветвями, points не содержат координаты концов, а количество соединений соответствует видимым участкам.',
    `Фрагмент ${tile.index || 1}; размер ${tile.width}×${tile.height} px; отношение сторон ${aspect.toFixed(3)}. Анализируй только этот фрагмент.`,
    strictMode ? 'Строгий режим: лучше пропустить сомнительную геометрию и объяснить сомнение, чем выдумывать.' : '',
    notes ? `Пожелания пользователя: ${notes}` : '',
    correction,
    'Верни title, summary, nodes, connections, labels, dimensions, legend, uncertainties в соответствии с JSON Schema. Только JSON, без Markdown и пояснений вне JSON.'
  ].filter(Boolean).join('\n');
}
async function callOllamaForTile(tilePath, tile, sourceStats, notes, strictMode, correction = '') {
  const img = await fs.readFile(tilePath);
  const isQwen3VLModel = /^qwen3-vl(?::|$)/i.test(QWEN_MODEL);
  const tilePrompt = makeTilePrompt(tile, sourceStats, notes, strictMode, correction);
  // Some Qwen3-VL Ollama templates ignore the API think=false flag. Put /no_think
  // at the very beginning of the user message as an additional model-level switch.
  const userContent = isQwen3VLModel ? `/no_think\n${tilePrompt}` : tilePrompt;
  const response = await fetchWithTimeout(OLLAMA_CHAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: QWEN_MODEL,
      messages: [{ role: 'user', content: userContent, images: [img.toString('base64')] }],
      ...(isQwen3VLModel ? { think: false } : {}),
      stream: false,
      format: CAD_JSON_SCHEMA,
      options: { num_ctx: 8192, num_predict: 3000, temperature: 0, top_p: 0.8, repeat_penalty: 1.05 }
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
  const content = typeof data?.message?.content === 'string' ? data.message.content.trim() : '';
  if (!content) {
    const thinking = data?.message?.thinking
      || data?.message?.reasoning
      || data?.message?.reasoning_content
      || '';
    throw new Error(
      `Ollama не вернул итоговый ответ для фрагмента: thinking_chars=${String(thinking).length}, ` +
      `done_reason=${data?.done_reason || 'unknown'}, eval_count=${data?.eval_count ?? 'unknown'}. ` +
      'Проверьте режим /no_think и лимит генерации.'
    );
  }
  let parsed;
  try {
    parsed = extractJsonObject(content);
  } catch (error) {
    console.warn('[CAD-QWEN-RAW]', JSON.stringify({
      tile: Number(tile.index || 1),
      model: QWEN_MODEL,
      doneReason: data?.done_reason || 'unknown',
      evalCount: data?.eval_count ?? null,
      contentChars: content.length,
      contentPreview: content.slice(0, 1000),
      parseError: String(error?.message || error)
    }));
    throw error;
  }

  const nodes = Array.isArray(parsed?.nodes) ? parsed.nodes : [];
  const connections = Array.isArray(parsed?.connections) ? parsed.connections : [];
  console.log('[CAD-QWEN-RAW]', JSON.stringify({
    tile: Number(tile.index || 1),
    model: QWEN_MODEL,
    doneReason: data?.done_reason || 'unknown',
    evalCount: data?.eval_count ?? null,
    contentChars: content.length,
    keys: Object.keys(parsed || {}),
    title: cleanText(parsed?.title || '', 80),
    summary: cleanText(parsed?.summary || '', 180),
    nodesCount: nodes.length,
    connectionsCount: connections.length,
    nodesSample: nodes.slice(0, 3),
    connectionsSample: connections.slice(0, 3),
    labelsCount: Array.isArray(parsed?.labels) ? parsed.labels.length : 0,
    uncertaintiesSample: Array.isArray(parsed?.uncertainties) ? parsed.uncertainties.slice(0, 3) : []
  }));
  return parsed;
}

async function reconstructWithQwen(tileDescriptors, tempDir, notes, strictMode, sourceStats = {}) {
  const visionSize = sourceStats.visionSize || { width: sourceStats.width || 1, height: sourceStats.height || 1 };
  let allRoutes = [];
  let allSymbols = [];
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
    // Empty/very faint areas often correctly contain no lines. Retry only if a non-empty tile returns no connections.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        parsed = await callOllamaForTile(tilePath, localTile, sourceStats, notes, strictMode,
          attempt === 1 ? '' : 'ПОВТОРНАЯ ПРОВЕРКА: предыдущий ответ содержит слишком мало достоверной геометрии. Не упрощай схему. Перечисли каждый видимый участок между двумя реальными узлами, используй общие node id в местах подтверждённых ответвлений; добавь все настоящие промежуточные вершины в points. Не добавляй декоративных линий и не угадывай соединения.');
        local = normalizeTileGraph(parsed, localTile);
        console.log('[CAD-QWEN-NORMALIZED]', JSON.stringify({
          tile: Number(tile.index || 1),
          rawNodes: Array.isArray(parsed?.nodes) ? parsed.nodes.length : 0,
          rawConnections: Array.isArray(parsed?.connections) ? parsed.connections.length : 0,
          validNodeCount: local.nodeCount,
          normalizedRouteCount: local.routes.length,
          normalizedRoutesSample: local.routes.slice(0, 3).map((route) => ({
            id: route.id, fromNode: route.fromNode, toNode: route.toNode,
            pointsCount: route.points.length, points: route.points.slice(0, 4)
          }))
        }));
        if (local.routes.length > 0 || Number(tile.inkRatio || 0) < 0.004) break;
        tileError = new Error('Для фрагмента не извлечены соединения.');
      } catch (error) {
        tileError = error;
        if (/Ollama HTTP 404/.test(String(error?.message || error))) throw error;
      }
    }
    if (!local) {
      tileErrors.push(`Фрагмент ${tile.index}: ${String(tileError?.message || tileError).slice(0, 120)}`);
      continue;
    }
    if (!local.routes.length && Number(tile.inkRatio || 0) >= 0.004) {
      tileErrors.push(`Фрагмент ${tile.index}: модель не извлекла линии`);
      continue;
    }
    tileSuccess++;
    allRoutes.push(...local.routes);
    allSymbols.push(...local.symbols);
    allLabels.push(...local.labels);
    allDimensions.push(...local.dimensions);
    if (local.summary) summaries.push(local.summary);
    if (local.title) titles.push(local.title);
    uncertainties.push(...local.uncertainties);
  }

  // Deduplicate routes from overlapping crops. Then snap near-identical endpoints so the same junction
  // detected in two neighboring tiles is rendered as a common point.
  let uniqueRoutes = [];
  const signatures = new Set();
  for (const route of allRoutes) {
    if (!route.points || route.points.length < 2) continue;
    const sig = routeSignature(route);
    if (signatures.has(sig)) continue;
    signatures.add(sig);
    uniqueRoutes.push(route);
  }
  mergeCloseRouteEndpoints(uniqueRoutes, 7);
  uniqueRoutes = uniqueRoutes.filter((r) => r.points.length >= 2 && Math.hypot(r.points[0][0] - r.points[r.points.length - 1][0], r.points[0][1] - r.points[r.points.length - 1][1]) >= 3);
  if (!uniqueRoutes.length) {
    const details = tileErrors.length ? ` Причины: ${tileErrors.join('; ')}` : '';
    throw new Error(`Qwen не извлёк ни одного достоверного соединения из ${workTiles.length} фрагментов.${details}`);
  }

  allSymbols = dedupeObjectsNear(allSymbols, (s) => [s.x, s.y], 10, (s) => s.type);
  allLabels = dedupeObjectsNear(allLabels, (l) => [l.x, l.y], 16, (l) => l.text.toLowerCase());
  allDimensions = dedupeObjectsNear(allDimensions, (d) => [(d.x1 + d.x2) / 2, (d.y1 + d.y2) / 2], 14, (d) => d.text.toLowerCase());

  const spec = {
    title: (titles.find((title) => title && !/^(?:техническая схема|схема|чертёж)$/i.test(title)) || 'СХЕМА ТРУБОПРОВОДА').slice(0, 100),
    subtitle: 'Реконструкция структуры по фрагментам изображения · требуется проверка',
    summary: [...new Set(summaries)].join(' | ').slice(0, 1200) || 'Геометрия извлечена из отдельных фрагментов. Соединения необходимо проверить.',
    routes: uniqueRoutes.slice(0, 400),
    symbols: allSymbols.slice(0, 160),
    labels: allLabels.slice(0, 160),
    dimensions: allDimensions.slice(0, 100),
    legend: [
      `Проанализировано фрагментов: ${tileSuccess}/${workTiles.length}.`,
      ...[...new Set(uncertainties)].slice(0, 3),
      ...(tileErrors.length ? [`Не полностью обработано: ${tileErrors.join('; ').slice(0, 180)}`] : []),
      'Автоматическая реконструкция приблизительна; проверьте все размеры и соединения.'
    ].slice(0, 6),
    sourceAspect: Number(sourceStats.width) / Math.max(1, Number(sourceStats.height)),
    diagnostics: { tilesProcessed: tileSuccess, tilesTotal: workTiles.length, rejectedTiles: tileErrors, rawConnections: allRoutes.length }
  };
  const issue = cadQualityIssue(spec, sourceStats);
  if (issue) throw new Error(`Геометрия после объединения фрагментов не прошла проверку: ${issue}. ${tileErrors.join('; ')}`.trim());
  return spec;
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

  const isQwen3VLModel = /^qwen3-vl(?::|$)/i.test(QWEN_MODEL);
  const analysisPrompt = isQwen3VLModel ? `/no_think\n${prompt}` : prompt;
  const response = await fetchWithTimeout(OLLAMA_CHAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: QWEN_MODEL,
      messages: [{ role: 'user', content: analysisPrompt, images: [img.toString('base64')] }],
      ...(isQwen3VLModel ? { think: false } : {}),
      stream: false,
      options: { num_ctx: isQwen3VLModel ? 8192 : 4096, num_predict: 1000, temperature: 0.1 }
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
        const spec = await reconstructWithQwen(processed.vision_tiles || [], tempDir, notes, strictMode, {
          contours: processed.trace?.contours || 0,
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
        stats = { ...renderStats, width: 1960, height: 1400, sheet: 'A3 · приблизительная CAD-реконструкция', tilesProcessed: spec.diagnostics?.tilesProcessed || 0, tilesTotal: spec.diagnostics?.tilesTotal || 0 };
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
        analysisNotice = `Векторизация и OCR выполнены. Qwen-анализ сейчас недоступен: проверьте, что Ollama запущен и модель ${QWEN_MODEL} скачана.`;
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
