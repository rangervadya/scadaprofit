import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import multer from 'multer';
import { rateLimit } from 'express-rate-limit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QWEN_DEFAULT_ROUTE_PROMPT, QWEN_VISION_PROMPT } from './prompts.js';
import { validateInputGraph, validateRouteOutput } from './graph.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_FILE_SIZE = 15 * 1024 * 1024;
const QWEN_MODEL = process.env.QWEN_MODEL || 'qwen3-vl:4b-instruct';

const VISION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    points: { type: 'array', maxItems: 60, items: {
      type: 'object', additionalProperties: false,
      properties: { id: { type: 'string', minLength: 1, maxLength: 16 }, x: { type: 'integer', minimum: 0, maximum: 1000 }, y: { type: 'integer', minimum: 0, maximum: 650 } },
      required: ['id', 'x', 'y']
    } },
    lines: { type: 'array', maxItems: 100, items: {
      type: 'object', additionalProperties: false,
      properties: { from: { type: 'string', minLength: 1, maxLength: 16 }, to: { type: 'string', minLength: 1, maxLength: 16 } },
      required: ['from', 'to']
    } },
    warnings: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 220 } },
    image_summary: { type: 'string', maxLength: 240 }
  },
  required: ['points', 'lines', 'warnings', 'image_summary']
};
const OLLAMA_CHAT_URL = process.env.OLLAMA_CHAT_URL || 'http://127.0.0.1:11434/api/chat';
const OLLAMA_TAGS_URL = process.env.OLLAMA_TAGS_URL || 'http://127.0.0.1:11434/api/tags';

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
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '5m',
  setHeaders(res, filePath) {
    if (/\.(html|js|css)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  },
}));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: 1, fields: 2, fieldSize: 20000 },
  fileFilter: (_req, file, callback) => {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype)) {
      return callback(new Error('Поддерживаются только PNG, JPG/JPEG и WEBP.'));
    }
    callback(null, true);
  },
});

const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Слишком много запросов. Подождите 15 минут и попробуйте снова.' },
});

function hasValidImageSignature(buffer, mimeType) {
  if (!buffer || buffer.length < 12) return false;
  if (mimeType === 'image/png') return buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mimeType === 'image/webp') return buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  return false;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 360000) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}

async function getOllamaStatus() {
  try {
    const response = await fetchWithTimeout(OLLAMA_TAGS_URL, {}, 2500);
    if (!response.ok) return { reachable: false, modelAvailable: false, model: QWEN_MODEL };
    const payload = await response.json();
    const models = Array.isArray(payload.models) ? payload.models : [];
    return {
      reachable: true,
      modelAvailable: models.some(entry => entry.name === QWEN_MODEL),
      model: QWEN_MODEL,
      installedModels: models.map(entry => entry.name),
    };
  } catch (error) {
    return { reachable: false, modelAvailable: false, model: QWEN_MODEL, error: String(error.message || error) };
  }
}

function parseModelJson(raw, doneReason = 'unknown') {
  const text = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (!text) throw new Error('Модель вернула пустой текстовый ответ.');
  if (first < 0) throw new Error('Ответ не содержит открывающую фигурную скобку JSON.');
  if (last < first) {
    if (doneReason === 'length') throw new Error('JSON начался, но не завершился: генерация оборвана по лимиту токенов (нет закрывающей скобки).');
    throw new Error('JSON начался, но в ответе нет закрывающей фигурной скобки.');
  }
  try { return JSON.parse(text.slice(first, last + 1)); }
  catch (error) { throw new Error(`JSON-объект найден, но синтаксис повреждён: ${error.message}`); }
}

async function callOllama({ messages, numPredict = 4096, timeoutMs = 360000, format = 'json' }) {
  const response = await fetchWithTimeout(OLLAMA_CHAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: QWEN_MODEL,
      messages,
      stream: false,
      format,
      think: false,
      options: { num_ctx: 8192, num_predict: numPredict, temperature: 0, top_p: 0.8, repeat_penalty: 1.0 },
    }),
  }, timeoutMs);
  const bodyText = await response.text();
  if (!response.ok) throw new Error(`Ollama HTTP ${response.status}: ${bodyText.slice(0, 700)}`);
  let payload;
  try { payload = JSON.parse(bodyText); }
  catch { throw new Error(`Ollama вернула некорректный HTTP JSON: ${bodyText.slice(0, 500)}`); }
  return {
    rawContent: String(payload?.message?.content || ''),
    thinking: String(payload?.message?.thinking || payload?.message?.reasoning || ''),
    doneReason: payload?.done_reason || 'unknown',
    evalCount: payload?.eval_count ?? null,
    promptEvalCount: payload?.prompt_eval_count ?? null,
    totalDurationNs: payload?.total_duration ?? null,
    model: payload?.model || QWEN_MODEL,
  };
}

app.get('/api/health', async (_req, res) => {
  const ollama = await getOllamaStatus();
  res.json({
    ok: true,
    appVersion: '2.8.0',
    mode: 'json-lab-only',
    model: QWEN_MODEL,
    ollamaReachable: ollama.reachable,
    qwenAvailable: ollama.modelAvailable,
    pipeline: 'photo → raw Qwen JSON → editable graph → Qwen route JSON → independent validator → SVG preview',
    legacyCadPipeline: false,
  });
});

app.get('/api/prompts', (_req, res) => {
  res.json({ model: QWEN_MODEL, visionPrompt: QWEN_VISION_PROMPT, routePrompt: QWEN_DEFAULT_ROUTE_PROMPT });
});

app.post('/api/qwen-extract', aiLimiter, (req, res, next) => {
  upload.single('image')(req, res, error => {
    if (error) return res.status(400).json({ error: error.message || 'Не удалось принять изображение.' });
    next();
  });
}, async (req, res) => {
  if (!req.file || !hasValidImageSignature(req.file.buffer, req.file.mimetype)) {
    return res.status(400).json({ error: 'Загрузите исходное изображение PNG, JPG или WEBP.' });
  }
  try {
    const prompt = String(req.body.prompt || QWEN_VISION_PROMPT).slice(0, 24000);
    const result = await callOllama({
      messages: [{ role: 'user', content: prompt, images: [req.file.buffer.toString('base64')] }],
      numPredict: 3600,
      format: VISION_JSON_SCHEMA,
    });
    let parsed = null;
    let parseError = '';
    try { parsed = parseModelJson(result.rawContent, result.doneReason); }
    catch (error) { parseError = String(error.message || error); }
    const extractionWarnings = [];
    if (!result.rawContent) extractionWarnings.push('Ollama вернула пустой message.content.');
    if (result.doneReason === 'length') extractionWarnings.push('Ответ оборван по лимиту генерации. Уменьши детализацию или проверь лимит токенов.');
    if (parseError) extractionWarnings.push(`JSON не разобран: ${parseError}`);
    if (parsed && (!Array.isArray(parsed.points) || !Array.isArray(parsed.lines))) {
      extractionWarnings.push('В JSON отсутствуют массивы points и/или lines.');
    }
    if (parsed && Array.isArray(parsed.points) && Array.isArray(parsed.lines) && (!parsed.points.length || !parsed.lines.length)) {
      extractionWarnings.push('Модель вернула пустой граф. Проверьте raw JSON и промпт; линия на фото не считается распознанной.');
    }
    console.log('[QWEN-EXTRACT]', JSON.stringify({
      model: result.model,
      rawChars: result.rawContent.length,
      points: parsed?.points?.length ?? null,
      lines: parsed?.lines?.length ?? null,
      parseError,
      doneReason: result.doneReason,
      evalCount: result.evalCount,
      rawPreview: result.rawContent.slice(0, 1800),
      warnings: extractionWarnings,
    }));
    res.json({ ok: true, stage: 'image-to-graph', ...result, parsed, parseError, extractionWarnings, promptUsed: prompt });
  } catch (error) {
    console.error('Qwen image graph extraction failed:', error?.stack || error);
    res.status(502).json({ error: String(error.message || error).slice(0, 1200), model: QWEN_MODEL });
  }
});

app.post('/api/qwen-route', aiLimiter, async (req, res) => {
  try {
    const rawInput = typeof req.body?.inputJson === 'string'
      ? req.body.inputJson
      : JSON.stringify(req.body?.inputJson ?? {});
    if (rawInput.length > 100000) return res.status(413).json({ error: 'Входной JSON слишком большой (максимум 100 КБ).' });
    let input;
    try { input = JSON.parse(rawInput); }
    catch (error) { return res.status(400).json({ error: `Входной JSON повреждён: ${error.message}` }); }

    const inputValidation = validateInputGraph(input);
    if (inputValidation.valid && (input.points.length < 2 || input.lines.length < 1)) {
      inputValidation.valid = false;
      inputValidation.warnings.push('Для построения пути нужен непустой граф: минимум две точки и одна связь.');
    }
    if (!inputValidation.valid) {
      return res.status(400).json({
        error: 'Входной граф не прошёл проверку. Сначала исправь JSON.',
        inputValidation,
      });
    }

    const startId = String(req.body?.startId || '').trim().slice(0, 64);
    const endId = String(req.body?.endId || '').trim().slice(0, 64);
    if (Boolean(startId) !== Boolean(endId)) {
      return res.status(400).json({ error: 'Укажи обе точки: START_ID и END_ID, либо очисти оба поля.' });
    }
    if (startId && endId) {
      const knownIds = new Set(input.points.map(point => point.id));
      if (!knownIds.has(startId) || !knownIds.has(endId)) {
        return res.status(400).json({ error: 'START_ID и END_ID должны существовать во входном points.', inputValidation, requested: { startId, endId } });
      }
      if (startId === endId) return res.status(400).json({ error: 'START_ID и END_ID должны быть разными точками.' });
    }
    const prompt = String(req.body?.prompt || QWEN_DEFAULT_ROUTE_PROMPT).slice(0, 24000);
    const task = [
      prompt,
      '',
      'ПАРАМЕТРЫ ЭТОГО ЗАПРОСА:',
      `START_ID: ${startId || '(не задан)'}`,
      `END_ID: ${endId || '(не задан)'}`,
      'ВХОДНОЙ JSON (ИСТОЧНИК ИСТИНЫ; НЕ ИЗМЕНЯЙ ЕГО):',
      JSON.stringify(input),
      'Ещё раз: не придумывай новых точек или связей. Верни только JSON заданной структуры.',
    ].join('\n');

    const result = await callOllama({
      messages: [{ role: 'user', content: task }],
      numPredict: 3000,
      timeoutMs: 240000,
    });
    let parsed = null;
    let parseError = '';
    let localValidation = null;
    try {
      parsed = parseModelJson(result.rawContent, result.doneReason);
      localValidation = validateRouteOutput(parsed, input, startId, endId);
    } catch (error) {
      parseError = String(error.message || error);
    }
    if (result.doneReason === 'length') {
      localValidation ||= { valid: false, warnings: [] };
      localValidation.valid = false;
      localValidation.warnings.push('Ответ модели завершился по лимиту длины (done_reason=length).');
    }
    console.log('[QWEN-ROUTE]', JSON.stringify({
      model: result.model,
      rawChars: result.rawContent.length,
      status: parsed?.status || 'unparsed',
      parseError,
      points: parsed?.points?.length ?? null,
      lines: parsed?.lines?.length ?? null,
      path: parsed?.path || null,
      modelLength: parsed?.total_length ?? null,
      computedLength: localValidation?.computedLength ?? null,
      doneReason: result.doneReason,
      evalCount: result.evalCount,
      localValid: localValidation?.valid ?? false,
      validationWarnings: localValidation?.warnings || [],
      rawPreview: result.rawContent.slice(0, 1200),
    }));
    res.json({
      ok: true,
      stage: 'graph-to-route',
      ...result,
      parsed,
      parseError,
      inputValidation,
      localValidation,
      input,
      promptUsed: task,
    });
  } catch (error) {
    console.error('Qwen route validation failed:', error?.stack || error);
    res.status(502).json({ error: String(error.message || error).slice(0, 1200), model: QWEN_MODEL });
  }
});

app.use((error, _req, res, _next) => {
  console.error('Unhandled server error:', error?.stack || error);
  res.status(500).json({ error: 'Внутренняя ошибка сервера.' });
});

app.listen(PORT, HOST, () => {
  console.log(`CAD Sketch JSON Brain 2.8.0 запущен: http://${HOST}:${PORT}`);
  console.log(`Только JSON-конвейер; Qwen model=${QWEN_MODEL}; старый OpenCV/CAD-способ отключён.`);
});
