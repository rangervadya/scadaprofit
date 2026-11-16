"""Small PostgreSQL repository for application health and generated-report history.

The report binary and form contents are not stored in the database. Only a minimal
technical audit entry is saved after a successful generation.
"""
from __future__ import annotations

import os
import time
from typing import Any


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
    while time.monotonic() < deadline:
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
            return
        except Exception as exc:  # database may still be starting up
            last_error = exc
            time.sleep(1)
    raise RuntimeError(f"PostgreSQL was not ready within {wait_seconds}s: {last_error}")


def database_status() -> dict[str, Any]:
    if not _dsn():
        return {"status": "not-configured", "configured": False, "message": "PostgreSQL не настроен для локального запуска"}
    try:
        with _connect() as conn:
            conn.execute("SELECT 1")
        return {"status": "ok", "configured": True, "message": "PostgreSQL доступен"}
    except Exception as exc:
        return {"status": "error", "configured": True, "message": f"База данных недоступна: {exc}"}


def record_generation(report_number: str, report_date: str, output_format: str, page_count: int, filename: str) -> None:
    if not _dsn():
        return
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO report_runs (report_number, report_date, output_format, page_count, output_filename)
            VALUES (%s, %s, %s, %s, %s)
            """,
            (report_number or "", report_date or "", output_format, int(page_count), filename or ""),
        )


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
