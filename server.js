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
const OLLAMA_CHAT_URL = process.env.OLLAMA_CHAT_URL || 'http://127.0.0.1:11434/api/chat';
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
app.use(express.json({ limit: '256kb' }));
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
  limits: { fileSize: MAX_FILE_SIZE, files: 1, fields: 6, fieldSize: 20000 },
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

const VISION_GRAPH_PROMPT = `Ты — модуль точного извлечения геометрии из рукописной схемы трубопровода.
Задача — НЕ красиво перерисовать схему и НЕ угадывать её смысл. Нужно перечислить видимые штрихи трубопровода в виде графа точек и направленных отрезков.

СИСТЕМА КООРДИНАТ:
- Виртуальный холст имеет размер 1000 × 650.
- x растёт слева направо, y растёт сверху вниз.
- Переведи положение точки на всём изображении пропорционально в эти координаты.
- Координаты должны быть конечными числами в диапазонах x=0..1000 и y=0..650.
- Не используй координаты отдельных фрагментов. Смотри на всю картинку целиком.

КАК СТАВИТЬ ТОЧКИ:
- Создавай точку на каждом видимом конце трассы, на каждом повороте/изломе и в каждом очевидном месте ответвления.
- Не ставь дополнительные точки на прямом участке без необходимости.
- Для длинной ломаной A-B-C обязательно создай B в месте поворота. Не заменяй её A-C.
- У каждой точки уникальный id: P1, P2, P3... Не объединяй точки только из-за близости.
- Если две линии пересекаются, но соединение неясно, сохрани их отдельными линиями и добавь предупреждение.

КАК СОЗДАВАТЬ ЛИНИИ:
- Каждая линия — только один прямой сегмент между соседними точками.
- Для ломаной из трёх точек A-B-C создай две линии: A→B и B→C.
- Направление выбирай последовательно вдоль видимого штриха. Если направление с изображения не определяется, выбери направление от верхнего/левого конца к нижнему/правому и добавь warning ` + '`направление условное`' + `.
- Не создавай связи из-за одной лишь близости точек.
- Не считай пересечение соединением без явного узла.
- Не выдумывай отсутствующие куски, трубы, ветви, размеры или символы.
- Игнорируй рамку листа, таблицу, основную надпись, текстовые списки и размерные выноски, насколько возможно. Извлекай именно линии схемы трубопровода.
- Если штрих неразборчив, не включай его как уверенную линию; добавь warning с областью.

ОТВЕТ: верни только один JSON-объект без Markdown и пояснений. Структура:
{
  "points": [{"id":"P1","x":100,"y":100}],
  "lines": [{"from":"P1","to":"P2"}],
  "warnings": ["..."],
  "image_summary": "кратко: что было выделено"
}

ОБЯЗАТЕЛЬНО:
- Включай в points только реально видимые концы, повороты и узлы.
- Включай в lines только сегменты, чьи обе точки уже есть в points.
- Не возвращай пустые массивы, если на изображении явно есть штрихи трубопровода. Если не можешь их выделить, верни пустые массивы и объясни это в warnings.
- Не придумывай координаты на основе типовой схемы. Все точки должны соответствовать пикселям исходного фото.
- При сомнении оставляй разрыв и пиши warning, не соединяй автоматически.`;

const DEFAULT_ROUTE_PROMPT = `ТЫ — СПЕЦИАЛИЗИРОВАННЫЙ МОДУЛЬ ПРОВЕРКИ МАРШРУТА И ПОСТРОЕНИЯ ЛИНИЙ ПО JSON.

ГЛАВНАЯ ЦЕЛЬ
По входному JSON определить последовательность точек и направленных отрезков. Не перерисовывай геометрию, а проверь и используй ровно заданные координаты и связи. Важно понять, правильно ли модель передала JSON и правильно ли последующий построитель показывает линию.

ОСНОВНЫЕ ПРАВИЛА
1. Входной JSON — источник точных id, координат и связей.
2. Не изменяй id. Не объединяй разные точки, даже если они близко.
3. Сохраняй координаты без смещения, округления и нормализации.
4. Каждая связь направлена: from — начало, to — конец.
5. Не создавай переход только потому, что точки рядом.
6. Пересечение не является соединением, если для него нет отдельного узла и явных рёбер.
7. Не пропускай поворотные и промежуточные точки.
8. Не заменяй A→B→C прямой A→C.
9. Не сглаживай, не выпрямляй и не меняй форму.
10. Не добавляй ветви, петли, переходы или точки без основания во входных данных.
11. Не дублируй одинаковые направленные связи.
12. Не допускай самосвязей.
13. Не разворачивай A→B в B→A.
14. При недостатке данных верни needs_review, не угадывай.
15. Если заданный конечный узел недостижим из начального по направленным рёбрам — impossible.

ПРОВЕРКА ВХОДА
- points и lines должны быть массивами.
- id точки — непустая уникальная строка.
- x и y — конечные числа; виртуальный холст 1000 × 650, x=0..1000, y=0..650.
- from и to каждой линии должны ссылаться на существующие точки.
- самосвязи и дубликаты недопустимы.
- Если задан START_ID и END_ID, ищи путь только по направленным рёбрам между ними.
- Если старт/финиш не заданы, используй путь только если он однозначен. При ветвлении, нескольких возможных путях или нескольких компонентах верни needs_review и перечисли неоднозначность.
- Не исправляй повреждённый вход молча.

ПОСТРОЕНИЕ
- Сегмент соединяет только две соседние точки, указанные линией.
- path — последовательность id от старта к финишу.
- Каждая соседняя пара в path должна соответствовать отдельной линии from→to.
- Длина каждого сегмента: sqrt((x2-x1)^2 + (y2-y1)^2).
- total_length — сумма длин всех соседних сегментов маршрута. Не измеряй напрямую между несоседними точками.
- Координаты в ответе копируй из входа без изменений.

СТАТУСЫ
- ok: вход корректен и найден один однозначный маршрут.
- needs_review: повреждённый JSON, неверные id/координаты/ссылки, дубли, самосвязи, неоднозначный путь или данных не хватает. Не возвращай неподтверждённые линии как точный путь.
- impossible: вход корректен, но END_ID недостижим из START_ID по направленным связям.

СТРОГИЙ ФОРМАТ ВЫХОДА — ТОЛЬКО JSON:
{
  "status": "ok",
  "points": [{"id":"A","x":100,"y":100},{"id":"B","x":300,"y":250}],
  "lines": [{"from":"A","to":"B"}],
  "path": ["A","B"],
  "total_length": 320.1562118716424,
  "warnings": []
}

ОГРАНИЧЕНИЯ
- Только ключи status, points, lines, path, total_length, warnings.
- status только ok, needs_review, impossible.
- В points включай только точки выбранного пути.
- В lines включай сегменты этого пути в порядке прохождения.
- Если needs_review — points, lines и path должны быть пустыми, total_length=0, причины укажи в warnings.
- Если impossible — points, lines и path пустые, total_length=0.
- Не добавляй Markdown, комментарии, trailing comma или пояснения вне JSON.
- Не выдавай предположения за факты.

ФИНАЛЬНАЯ ПРОВЕРКА ПЕРЕД ОТВЕТОМ
Все id уникальны; координаты конечны и в границах; связи ссылаются на существующие точки; нет дубликатов и самосвязей; направление сохранено; путь начинается и заканчивается в запрошенных точках; ни один промежуточный узел не пропущен; каждая соседняя пара path существует как from→to; длина равна сумме сегментов; JSON разбирается стандартным парсером.

ГЛАВНОЕ: НЕ ДОГАДЫВАЙСЯ. ТОЧНОСТЬ ТОПОЛОГИИ И КООРДИНАТ ВАЖНЕЕ КРАСОТЫ.`;

function parseModelJson(raw) {
  const text = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first < 0 || last <= first) throw new Error('Ответ модели не содержит JSON-объект.');
  return JSON.parse(text.slice(first, last + 1));
}

function validateInputGraph(data) {
  const warnings = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { valid: false, warnings: ['Корень входного JSON должен быть объектом.'] };
  if (!Array.isArray(data.points)) warnings.push('Вход: points должен быть массивом.');
  if (!Array.isArray(data.lines)) warnings.push('Вход: lines должен быть массивом.');
  const points = Array.isArray(data.points) ? data.points : [];
  const lines = Array.isArray(data.lines) ? data.lines : [];
  const ids = new Set();
  for (const point of points) {
    if (!point || typeof point.id !== 'string' || !point.id.trim()) { warnings.push('Вход: точка с пустым/нестроковым id.'); continue; }
    if (ids.has(point.id)) warnings.push(`Вход: повторяется id ${point.id}.`);
    ids.add(point.id);
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) warnings.push(`Вход: ${point.id} имеет некорректные координаты.`);
    else if (point.x < 0 || point.x > 1000 || point.y < 0 || point.y > 650) warnings.push(`Вход: ${point.id} вне холста 1000×650.`);
  }
  const edges = new Set();
  for (const line of lines) {
    if (!line || typeof line.from !== 'string' || typeof line.to !== 'string') { warnings.push('Вход: связь должна иметь строковые from и to.'); continue; }
    if (!ids.has(line.from) || !ids.has(line.to)) warnings.push(`Вход: ${line.from}→${line.to} ссылается на неизвестную точку.`);
    if (line.from === line.to) warnings.push(`Вход: самосвязь ${line.from} запрещена.`);
    const key = `${line.from}\u0000${line.to}`;
    if (edges.has(key)) warnings.push(`Вход: связь ${line.from}→${line.to} повторяется.`);
    edges.add(key);
  }
  return { valid: warnings.length === 0, warnings, pointCount: points.length, lineCount: lines.length };
}

function countDirectedPaths(graph, startId, endId, limit = 2) {
  if (!graph || !Array.isArray(graph.points) || !Array.isArray(graph.lines) || !startId || !endId) return null;
  const ids = new Set(graph.points.map(point => point?.id).filter(id => typeof id === 'string'));
  if (!ids.has(startId) || !ids.has(endId)) return 0;
  const adjacency = new Map();
  for (const id of ids) adjacency.set(id, []);
  for (const line of graph.lines) {
    if (line && ids.has(line.from) && ids.has(line.to) && line.from !== line.to) adjacency.get(line.from).push(line.to);
  }
  let count = 0;
  const visited = new Set([startId]);
  function walk(current) {
    if (count >= limit) return;
    if (current === endId) { count++; return; }
    for (const next of adjacency.get(current) || []) {
      if (visited.has(next)) continue;
      visited.add(next);
      walk(next);
      visited.delete(next);
      if (count >= limit) return;
    }
  }
  walk(startId);
  return count;
}

function validateRouteJson(data, requestedStart = "", requestedEnd = "", inputGraph = null) {
  const warnings = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { valid: false, warnings: ['Корень JSON должен быть объектом.'] };
  const allowedKeys = new Set(['status', 'points', 'lines', 'path', 'total_length', 'warnings']);
  for (const key of Object.keys(data)) if (!allowedKeys.has(key)) warnings.push(`Лишний ключ ${key} не разрешён форматом.`);
  if (!['ok', 'needs_review', 'impossible'].includes(data.status)) warnings.push('status должен быть ok, needs_review или impossible.');
  if (!Array.isArray(data.points)) warnings.push('points должен быть массивом.');
  if (!Array.isArray(data.lines)) warnings.push('lines должен быть массивом.');
  if (!Array.isArray(data.path)) warnings.push('path должен быть массивом.');
  if (!Array.isArray(data.warnings)) warnings.push('warnings должен быть массивом.');
  if (!Number.isFinite(data.total_length)) warnings.push('total_length должен быть конечным числом.');
  const points = Array.isArray(data.points) ? data.points : [];
  const lines = Array.isArray(data.lines) ? data.lines : [];
  const byId = new Map();
  for (const p of points) {
    if (!p || typeof p.id !== 'string' || !p.id.trim()) { warnings.push('Найдено пустое или некорректное поле id.'); continue; }
    if (byId.has(p.id)) warnings.push(`Повторяется id точки ${p.id}.`);
    byId.set(p.id, p);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) warnings.push(`Точка ${p.id}: координаты должны быть конечными числами.`);
    else if (p.x < 0 || p.x > 1000 || p.y < 0 || p.y > 650) warnings.push(`Точка ${p.id}: координаты за пределами холста 1000×650.`);
  }
  const sourcePoints = new Map((Array.isArray(inputGraph?.points) ? inputGraph.points : []).map(point => [point?.id, point]));
  const sourceEdges = new Set((Array.isArray(inputGraph?.lines) ? inputGraph.lines : []).map(line => `${line?.from}\u0000${line?.to}`));
  if (inputGraph) {
    for (const point of points) {
      const source = sourcePoints.get(point?.id);
      if (!source) warnings.push(`Точка ${point?.id}: отсутствует во входном графе.`);
      else if (point.x !== source.x || point.y !== source.y) warnings.push(`Точка ${point.id}: координаты отличаются от входного JSON.`);
    }
  }
  const seen = new Set();
  for (const line of lines) {
    if (!line || typeof line.from !== 'string' || typeof line.to !== 'string') { warnings.push('Линия должна содержать строковые from и to.'); continue; }
    if (!byId.has(line.from) || !byId.has(line.to)) warnings.push(`Связь ${line.from}→${line.to}: неизвестная точка.`);
    if (inputGraph && !sourceEdges.has(`${line.from}\u0000${line.to}`)) warnings.push(`Связь ${line.from}→${line.to}: такой направленной связи нет во входном JSON.`);
    if (line.from === line.to) warnings.push(`Самосвязь ${line.from}→${line.to} запрещена.`);
    const key = `${line.from}\u0000${line.to}`;
    if (seen.has(key)) warnings.push(`Повторяется связь ${line.from}→${line.to}.`);
    seen.add(key);
  }
  if (data.status === 'ok') {
    if (!Array.isArray(data.path) || data.path.length < 2) warnings.push('Статус ok требует path минимум из двух точек.');
    if (Array.isArray(data.path) && points.length !== data.path.length) warnings.push('Количество точек в результате должно совпадать с количеством id в path.');
    if (requestedStart && data.path?.[0] !== requestedStart) warnings.push(`Путь должен начинаться в ${requestedStart}.`);
    if (requestedEnd && data.path?.at(-1) !== requestedEnd) warnings.push(`Путь должен заканчиваться в ${requestedEnd}.`);
    if (Array.isArray(data.path) && data.path.some(id => !byId.has(id))) warnings.push('path содержит id, отсутствующий в points.');
    if (Array.isArray(data.path) && new Set(data.path).size !== data.path.length) warnings.push('path содержит повторяющиеся id; петли не разрешены.');
    if (Array.isArray(data.path) && points.length === data.path.length && points.some((point, index) => point?.id !== data.path[index])) warnings.push('Порядок points не совпадает с порядком id в path.');
  }
  if (data.status === 'needs_review' || data.status === 'impossible') {
    if (points.length || lines.length || (Array.isArray(data.path) && data.path.length)) warnings.push(`При status=${data.status} массивы points, lines и path должны быть пустыми.`);
    if (data.total_length !== 0) warnings.push(`При status=${data.status} total_length должен быть 0.`);
  }
  if (Array.isArray(data.path) && data.path.length > 1) {
    const edgeSet = new Set(lines.map((l) => `${l?.from}\u0000${l?.to}`));
    for (let i = 0; i < data.path.length - 1; i++) {
      if (!edgeSet.has(`${data.path[i]}\u0000${data.path[i + 1]}`)) warnings.push(`Путь разорван: нет ребра ${data.path[i]}→${data.path[i + 1]}.`);
    }
    if (lines.length !== data.path.length - 1) warnings.push('Количество линий не совпадает с количеством шагов пути.');
    for (let i = 0; i < Math.min(lines.length, data.path.length - 1); i++) {
      if (lines[i]?.from !== data.path[i] || lines[i]?.to !== data.path[i + 1]) warnings.push(`Порядок lines не совпадает с path на шаге ${i + 1}.`);
    }
  }
  let computedLength = 0;
  if (Array.isArray(data.path) && data.path.length > 1) {
    for (let i = 0; i < data.path.length - 1; i++) {
      const a = byId.get(data.path[i]);
      const b = byId.get(data.path[i + 1]);
      if (a && b && Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(b.x) && Number.isFinite(b.y)) {
        computedLength += Math.hypot(b.x - a.x, b.y - a.y);
      }
    }
  }
  if (Number.isFinite(data.total_length) && Math.abs(data.total_length - computedLength) > 0.02) {
    warnings.push(`Длина модели ${data.total_length}; пересчитанная длина ${computedLength}.`);
  }
  const sourcePathCount = countDirectedPaths(inputGraph, requestedStart, requestedEnd);
  if (data.status === 'ok' && sourcePathCount !== null && sourcePathCount !== 1) {
    warnings.push(sourcePathCount === 0 ? 'Во входном графе нет направленного пути между START_ID и END_ID.' : 'Во входном графе больше одного возможного пути; автоматический выбор неоднозначен.');
  }
  if (data.status === 'impossible' && sourcePathCount !== null && sourcePathCount > 0) {
    warnings.push('Модель вернула impossible, хотя во входном графе путь существует.');
  }
  return { valid: warnings.length === 0, warnings, computedLength, sourcePathCount };
}

async function ollamaChat({ messages, format = 'json', numPredict = 4096, timeoutMs = 300000 }) {
  const response = await fetchWithTimeout(OLLAMA_CHAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: QWEN_MODEL,
      messages,
      stream: false,
      format,
      think: false,
      options: { num_ctx: 8192, num_predict: numPredict, temperature: 0, top_p: 0.8 }
    })
  }, timeoutMs);
  const rawBody = await response.text();
  if (!response.ok) throw new Error(`Ollama HTTP ${response.status}: ${rawBody.slice(0, 500)}`);
  const data = JSON.parse(rawBody);
  return {
    rawContent: String(data?.message?.content || ''),
    thinking: String(data?.message?.thinking || data?.message?.reasoning || ''),
    doneReason: data?.done_reason || 'unknown',
    evalCount: data?.eval_count ?? null,
    promptEvalCount: data?.prompt_eval_count ?? null,
    model: data?.model || QWEN_MODEL,
  };
}

app.get('/api/prompts', (_req, res) => {
  res.json({ model: QWEN_MODEL, visionPrompt: VISION_GRAPH_PROMPT, routePrompt: DEFAULT_ROUTE_PROMPT });
});

app.post('/api/qwen-extract', convertLimiter, (req, res, next) => {
  upload.single('image')(req, res, (error) => {
    if (error) return res.status(400).json({ error: error.message || 'Не удалось принять изображение.' });
    next();
  });
}, async (req, res) => {
  if (!req.file || !hasValidImageSignature(req.file.buffer, req.file.mimetype)) {
    return res.status(400).json({ error: 'Загрузите исходное изображение PNG, JPG или WEBP.' });
  }
  try {
    const prompt = String(req.body.prompt || VISION_GRAPH_PROMPT).slice(0, 18000);
    const result = await ollamaChat({
      messages: [{ role: 'user', content: prompt, images: [req.file.buffer.toString('base64')] }],
      numPredict: 4096,
      timeoutMs: 360000,
    });
    let parsed = null;
    let parseError = '';
    try { parsed = parseModelJson(result.rawContent); }
    catch (error) { parseError = String(error.message || error); }
    console.log('[QWEN-EXTRACT]', JSON.stringify({ model: result.model, rawChars: result.rawContent.length, points: parsed?.points?.length ?? null, lines: parsed?.lines?.length ?? null, doneReason: result.doneReason, evalCount: result.evalCount }));
    res.json({ ok: true, stage: 'image-to-graph', ...result, parsed, parseError, promptUsed: prompt });
  } catch (error) {
    console.error('Qwen image graph extraction failed:', error?.stack || error);
    res.status(502).json({ error: String(error.message || error).slice(0, 1200), model: QWEN_MODEL });
  }
});

app.post('/api/qwen-route', convertLimiter, async (req, res) => {
  try {
    const rawInput = typeof req.body?.inputJson === 'string' ? req.body.inputJson : JSON.stringify(req.body?.inputJson ?? {});
    if (rawInput.length > 100000) return res.status(413).json({ error: 'Входной JSON слишком большой (максимум 100 КБ).' });
    let input;
    try { input = JSON.parse(rawInput); }
    catch (error) { return res.status(400).json({ error: `Входной JSON повреждён: ${error.message}` }); }
    const startId = String(req.body?.startId || '').trim().slice(0, 64);
    const endId = String(req.body?.endId || '').trim().slice(0, 64);
    const prompt = String(req.body?.prompt || DEFAULT_ROUTE_PROMPT).slice(0, 18000);
    const task = [
      prompt,
      '',
      'ТЕКУЩЕЕ ЗАДАНИЕ:',
      `START_ID: ${startId || '(не задан; определить только если путь однозначен)'}`,
      `END_ID: ${endId || '(не задан; определить только если путь однозначен)'}`,
      'ВХОДНОЙ JSON:',
      JSON.stringify(input),
      'Верни только JSON указанной структуры.'
    ].join('\n');
    const result = await ollamaChat({
      messages: [{ role: 'user', content: task }],
      numPredict: 3000,
      timeoutMs: 240000,
    });
    let parsed = null;
    let parseError = '';
    let localValidation = null;
    const inputValidation = validateInputGraph(input);
    try { parsed = parseModelJson(result.rawContent); localValidation = validateRouteJson(parsed, startId, endId, input); }
    catch (error) { parseError = String(error.message || error); }
    console.log('[QWEN-ROUTE]', JSON.stringify({ model: result.model, rawChars: result.rawContent.length, status: parsed?.status || 'unparsed', points: parsed?.points?.length ?? null, lines: parsed?.lines?.length ?? null, doneReason: result.doneReason, evalCount: result.evalCount, localValid: localValidation?.valid ?? false }));
    res.json({ ok: true, stage: 'graph-to-route', ...result, parsed, parseError, inputValidation, localValidation, input, promptUsed: task });
  } catch (error) {
    console.error('Qwen route validation failed:', error?.stack || error);
    res.status(502).json({ error: String(error.message || error).slice(0, 1200), model: QWEN_MODEL });
  }
});

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
  console.log(`CAD Sketch Converter 2.6.0 запущен: http://${HOST}:${PORT}`);
  console.log('Геометрия: OpenCV centerline graph; Qwen JSON lab доступен на /api/qwen-extract и /api/qwen-route.');
});
