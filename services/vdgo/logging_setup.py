"""Structured logging for the VDGO document service.

Records are written to stdout as one JSON object per line so `docker compose
logs` and any shipper can index them without a VDGO-specific parser.
`LOG_LEVEL` (DEBUG|INFO|WARNING|ERROR|CRITICAL) controls verbosity and defaults
to INFO.

Unlike the recognition engine, nothing parses this service's output, so the
records stay JSON everywhere instead of being mirrored into a human channel.
"""
from __future__ import annotations

import json
import logging
import os
import sys
import time
from typing import Any

_CONFIGURED = False
_STARTED_AT = time.perf_counter()

_LEVELS = {
    'DEBUG': logging.DEBUG,
    'INFO': logging.INFO,
    'WARN': logging.WARNING,
    'WARNING': logging.WARNING,
    'ERROR': logging.ERROR,
    'CRITICAL': logging.CRITICAL,
}

_RESERVED = frozenset({
    'name', 'msg', 'args', 'levelname', 'levelno', 'pathname', 'filename',
    'module', 'exc_info', 'exc_text', 'stack_info', 'lineno', 'funcName',
    'created', 'msecs', 'relativeCreated', 'thread', 'threadName',
    'processName', 'process', 'taskName', 'message', 'asctime',
})


def resolve_level(level: str | None = None) -> int:
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
            # Keep the last exception line: the full traceback belongs in the
            # log file, but one line keeps a 500 response searchable.
            payload['exc'] = self.formatException(record.exc_info).strip().splitlines()[-1]
        for key, value in record.__dict__.items():
            if key in _RESERVED or key.startswith('_') or key in payload:
                continue
            payload[key] = value
        return json.dumps(payload, ensure_ascii=False, default=str)


def configure_logging(level: str | None = None) -> None:
    """Install the JSON stdout handler once, unless a host configured logging."""
    global _CONFIGURED
    if _CONFIGURED:
        return
    root = logging.getLogger()
    if not root.handlers:
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(JsonFormatter())
        root.addHandler(handler)
        root.setLevel(resolve_level(level))
    _CONFIGURED = True


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)


def format_query_path(path: str) -> str:
    """Log only the route, never the query string (it can carry report ids)."""
    return str(path or '').split('?', 1)[0]