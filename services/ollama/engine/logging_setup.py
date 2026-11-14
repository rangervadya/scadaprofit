"""Structured logging shared by the Python engine and the VDGO backend.

Both processes run under Docker, so every record goes to stderr as a single
JSON object per line: `docker compose logs` and any log shipper can index it
without a per-service parser.

The Node API reads the engine's stderr line by line. A JSON object carrying a
string `msg` is treated as a structured event (and rendered back into the
compact `[STAGE] message` text that progress.log has always shown); any other
line is forwarded verbatim, so third-party warnings and tracebacks keep working.
"""
from __future__ import annotations

import json
import logging
import os
import re
import sys
import time
from typing import Any

_CONFIGURED = False
_STARTED_AT = time.perf_counter()

_LEVELS = {
    'TRACE': 5,
    'DEBUG': logging.DEBUG,
    'INFO': logging.INFO,
    'WARN': logging.WARNING,
    'WARNING': logging.WARNING,
    'ERROR': logging.ERROR,
    'CRITICAL': logging.CRITICAL,
    'SILENT': logging.CRITICAL + 10,
}

# Attributes every LogRecord already carries; anything else passed through
# `extra=` is a user field and belongs in the JSON payload.
_RESERVED = frozenset({
    'name', 'msg', 'args', 'levelname', 'levelno', 'pathname', 'filename',
    'module', 'exc_info', 'exc_text', 'stack_info', 'lineno', 'funcName',
    'created', 'msecs', 'relativeCreated', 'thread', 'threadName',
    'processName', 'process', 'taskName', 'message', 'asctime',
})

_STAGE_RE = re.compile(r'[^A-Za-z0-9_-]')
_WHITESPACE_RE = re.compile(r'[\r\n]+')


def resolve_level(level: str | None = None) -> int:
    """Map LOG_LEVEL (or an explicit value) to a logging level, defaulting to INFO."""
    raw = str(level or os.getenv('LOG_LEVEL') or 'INFO').strip().upper()
    return _LEVELS.get(raw, logging.INFO)


class JsonFormatter(logging.Formatter):
    """Render one record as a single JSON line, including `extra` fields."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            'ts': time.strftime('%Y-%m-%dT%H:%M:%S', time.gmtime(record.created))
            + f'.{int(record.msecs):03d}Z',
            'level': record.levelname.lower(),
            'logger': record.name,
            'msg': record.getMessage(),
            'elapsed_ms': round((time.perf_counter() - _STARTED_AT) * 1000.0, 1),
        }
        if record.exc_info:
            payload['exc'] = self.formatException(record.exc_info).strip().splitlines()[-1]
        for key, value in record.__dict__.items():
            if key in _RESERVED or key.startswith('_') or key in payload:
                continue
            payload[key] = value
        return json.dumps(payload, ensure_ascii=False, default=str)


def configure_logging(level: str | None = None) -> None:
    """Install the JSON stderr handler once.

    If a host application (test runner, WSGI container) already configured
    logging, its handlers are left untouched and only the marker is set.
    """
    global _CONFIGURED
    if _CONFIGURED:
        return
    root = logging.getLogger()
    if not root.handlers:
        handler = logging.StreamHandler(sys.stderr)
        handler.setFormatter(JsonFormatter())
        root.addHandler(handler)
        root.setLevel(resolve_level(level))
    _CONFIGURED = True


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)


def emit_progress(
    stage: str,
    message: str,
    level: int = logging.INFO,
    logger: logging.Logger | None = None,
    **fields: Any,
) -> None:
    """Emit one progress event with a sanitised stage and a single-line message."""
    configure_logging()
    safe_stage = _STAGE_RE.sub('', str(stage).upper())[:16] or 'JOB'
    safe_message = _WHITESPACE_RE.sub(' ', str(message)).strip()[:500]
    target = logger or logging.getLogger('progress')
    extra: dict[str, Any] = {'stage': safe_stage}
    for key, value in fields.items():
        if value is None or key in _RESERVED or key in extra or key.startswith('_'):
            continue
        extra[key] = value
    target.log(level, safe_message, extra=extra)