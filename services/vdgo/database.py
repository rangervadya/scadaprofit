"""Small PostgreSQL repository for application health and generated-report history.

The report binary and form contents are not stored in the database. Only a minimal
technical audit entry is saved after a successful generation.
"""
from __future__ import annotations

import os
import time
from typing import Any

from logging_setup import get_logger

log = get_logger('vdgo.database')


def _dsn() -> str:
    return os.environ.get("DATABASE_URL", "").strip()


def _connect():
    dsn = _dsn()
    if not dsn:
        raise RuntimeError("DATABASE_URL is not configured")
    try:
        import psycopg
    except ImportError as exc:  # pragma: no cover - environment-specific
        raise RuntimeError("The psycopg database driver is not installed") from exc
    return psycopg.connect(dsn, connect_timeout=4)


def init_database(wait_seconds: int = 45) -> None:
    """Wait for PostgreSQL and create the report-generation audit table."""
    if not _dsn():
        return
    deadline = time.monotonic() + max(1, wait_seconds)
    last_error: Exception | None = None
    attempts = 0
    while time.monotonic() < deadline:
        attempts += 1
        try:
            with _connect() as conn:
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS report_runs (
                        id BIGSERIAL PRIMARY KEY,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        report_number VARCHAR(120) NOT NULL DEFAULT '',
                        report_date VARCHAR(32) NOT NULL DEFAULT '',
                        output_format VARCHAR(16) NOT NULL,
                        page_count INTEGER NOT NULL CHECK (page_count >= 0),
                        output_filename VARCHAR(255) NOT NULL DEFAULT ''
                    )
                    """
                )
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS report_runs_created_at_idx ON report_runs(created_at DESC)"
                )
            log.info('PostgreSQL audit table ready', extra={'attempts': attempts})
            return
        except Exception as exc:  # database may still be starting up
            last_error = exc
            log.debug('PostgreSQL not ready yet', extra={'attempt': attempts, 'err': str(exc)})
            time.sleep(1)
    log.error('PostgreSQL did not become ready', extra={'waitSeconds': wait_seconds, 'attempts': attempts, 'err': str(last_error)})
    raise RuntimeError(f"PostgreSQL was not ready within {wait_seconds}s: {last_error}")


def database_status() -> dict[str, Any]:
    if not _dsn():
        return {"status": "not-configured", "configured": False, "message": "PostgreSQL не настроен для локального запуска"}
    try:
        with _connect() as conn:
            conn.execute("SELECT 1")
        return {"status": "ok", "configured": True, "message": "PostgreSQL доступен"}
    except Exception as exc:
        log.warning('PostgreSQL health check failed', extra={'err': str(exc)})
        return {"status": "error", "configured": True, "message": f"База данных недоступна: {exc}"}


def record_generation(report_number: str, report_date: str, output_format: str, page_count: int, filename: str) -> None:
    if not _dsn():
        return
    try:
        with _connect() as conn:
            conn.execute(
                """
                INSERT INTO report_runs (report_number, report_date, output_format, page_count, output_filename)
                VALUES (%s, %s, %s, %s, %s)
                """,
                (report_number or "", report_date or "", output_format, int(page_count), filename or ""),
            )
    except Exception as exc:
        # Callers treat a missing audit row as non-fatal; log it with the report
        # number so the document can still be matched to its row later.
        log.error('Cannot record generated document', extra={'err': str(exc), 'reportNumber': report_number, 'format': output_format})
        raise


def recent_reports(limit: int = 12) -> list[dict[str, Any]]:
    if not _dsn():
        return []
    safe_limit = min(max(int(limit), 1), 50)
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT id, created_at, report_number, report_date, output_format, page_count, output_filename
            FROM report_runs ORDER BY created_at DESC LIMIT %s
            """,
            (safe_limit,),
        ).fetchall()
    return [
        {
            "id": row[0],
            "created_at": row[1].isoformat() if row[1] else None,
            "report_number": row[2],
            "report_date": row[3],
            "output_format": row[4],
            "page_count": row[5],
            "output_filename": row[6],
        }
        for row in rows
    ]
