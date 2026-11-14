/**
 * Structured logging for the Node.js API.
 *
 * Every record is written to stdout as one JSON object per line, which is the
 * format Docker, journald and any log shipper can index without a per-service
 * parser. `LOG_LEVEL` (trace|debug|info|warn|error|fatal|silent) controls
 * verbosity; production defaults to `info`.
 *
 * The per-job channel that operators read through
 * `/jobs/:jobId/progress.log` is not a second log stream: `parseProgressLine()`
 * and `renderProgressLine()` render the same events into the compact
 * `[STAGE] message` text that the page and `progress.log` have always shown.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { pinoHttp } from 'pino-http';

const LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']);
const DEFAULT_LEVEL = 'info';

/** Longest progress message kept in progress.log; matches the previous behaviour. */
export const MAX_PROGRESS_MESSAGE = 2000;

/** Longest stage token kept in progress.log. */
export const MAX_PROGRESS_STAGE = 16;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readAppVersion() {
  try {
    return readFileSync(path.join(__dirname, '../../../VERSION'), 'utf8').trim();
  } catch {
    return 'dev';
  }
}

/**
 * Resolve the level from LOG_LEVEL, falling back to a production-safe default.
 * An invalid value must never silence the service completely, and anything that
 * is not an explicit development run keeps the quieter `info` level.
 */
export function resolveLogLevel(env = process.env) {
  const raw = String(env.LOG_LEVEL || '').trim().toLowerCase();
  if (LEVELS.has(raw)) return raw;
  return env.NODE_ENV === 'development' ? 'debug' : DEFAULT_LEVEL;
}

/**
 * Fields that must never reach a log file: session cookies, password hashes and
 * provider API keys are the ones this service actually handles.
 */
export const REDACT_PATHS = [
  'password',
  'newPassword',
  'passwordHash',
  'token',
  'tokenHash',
  'apiKey',
  'secret',
  'authorization',
  'cookie',
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  '*.password',
  '*.newPassword',
  '*.passwordHash',
  '*.token',
  '*.tokenHash',
  '*.apiKey',
  '*.secret',
];

export const logger = pino({
  level: resolveLogLevel(),
  base: {
    service: process.env.SERVICE_NAME || 'scadaprofit-app',
    version: readAppVersion(),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  messageKey: 'msg',
  errorKey: 'err',
  redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  formatters: { level: label => ({ level: label }) },
});

/** Short, stable job identifier used in every log line and in progress.log. */
export function shortJobId(jobId) {
  return String(jobId || '').slice(0, 8);
}

/** Child logger for a background job; keeps jobId on every line automatically. */
export function jobLogger(jobId, extra = {}) {
  return logger.child({ jobId: shortJobId(jobId), ...extra });
}

export function childLogger(bindings = {}) {
  return logger.child(bindings);
}

/**
 * Split one raw stderr line coming from a Python child process.
 *
 * A JSON object with a string `msg` is a structured event; anything else is
 * plain text that the engine has always written (library warnings, tracebacks).
 */
export function parseProgressLine(line) {
  const text = String(line ?? '');
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const record = JSON.parse(trimmed);
      if (record && typeof record === 'object' && !Array.isArray(record) && typeof record.msg === 'string') {
        return { structured: true, record };
      }
    } catch {
      /* Not JSON: fall through and keep the raw line readable. */
    }
  }
  const message = text.replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_PROGRESS_MESSAGE);
  return { structured: false, message };
}

/** Render a structured event as the compact `[STAGE] message` progress line. */
export function renderProgressLine(record) {
  const stage = String(record?.stage || 'JOB')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, MAX_PROGRESS_STAGE)
    .toUpperCase() || 'JOB';
  const message = String(record?.msg || '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, MAX_PROGRESS_MESSAGE);
  return `[${stage}] ${message}`;
}

/** True when the line looks like a structured event and should be logged as JSON. */
export function isStructuredProgress(record) {
  return Boolean(record && typeof record === 'object' && typeof record.msg === 'string');
}

/**
 * HTTP request logging.
 *
 * Each request gets an id (honouring an upstream X-Request-Id so gateway and
 * app lines correlate), exposed back to the client as X-Request-Id. Health
 * probes are ignored because Docker polls them every 30 seconds.
 */
export const requestLogger = pinoHttp({
  logger,
  genReqId: req => String(req.headers['x-request-id'] || randomUUID()),
  autoLogging: {
    ignore: req => req.url === '/api/health' || req.url === '/favicon.ico',
  },
  customLogLevel: (req, res, error) => {
    if (error || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  customSuccessMessage: req => `${req.method} ${req.url}`,
  customErrorMessage: req => `${req.method} ${req.url}`,
  customProps: req => ({ role: req.user?.role || null }),
  serializers: {
    req: req => ({ method: req.method, url: req.url, remoteAddress: req.remoteAddress, requestId: req.id }),
    res: res => ({ statusCode: res.statusCode }),
  },
});

/** Echo the correlation id so browser, gateway and server lines can be joined. */
export function requestIdHeader(req, res, next) {
  if (req.id) res.setHeader('X-Request-Id', String(req.id));
  next();
}

/** Express error handler logger: keeps the stack, drops the noisy headers. */
export function logRequestError(req, error, message = 'Unhandled request error') {
  const log = req?.log || logger;
  log.error({ err: error, requestId: req?.id, method: req?.method, url: req?.url }, message);
}