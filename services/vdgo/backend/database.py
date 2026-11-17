"""Small PostgreSQL repository for application health and generated-report history.

Exported files are stored in the persistent output volume. This module records
their metadata and keeps the generation history.
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


def record_generation(report_number: str, report_date: str, output_format: str, page_count: int, filename: str) -> int | None:
    if not _dsn():
        return
    with _connect() as conn:
        row = conn.execute(
            """
            INSERT INTO report_runs (report_number, report_date, output_format, page_count, output_filename)
            VALUES (%s, %s, %s, %s, %s) RETURNING id
            """,
            (report_number or "", report_date or "", output_format, int(page_count), filename or ""),
        ).fetchone()
    return row[0]


def recent_reports(limit: int = 12, *, include_previews: bool = True, before_id: int | None = None) -> list[dict[str, Any]]:
    if not _dsn():
        return []
    safe_limit = min(max(int(limit), 1), 50)
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT id, created_at, report_number, report_date, output_format, page_count, output_filename
            FROM report_runs
            WHERE (%s OR output_format <> 'preview') AND id < %s
            ORDER BY id DESC LIMIT %s
            """,
            (include_previews, before_id if before_id is not None else 2**63 - 1, safe_limit),
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

def report_file(report_id: int) -> dict[str, str] | None:
    if not _dsn():
        return None
    with _connect() as conn:
        row = conn.execute(
            """SELECT report_number, report_date, output_filename
               FROM report_runs WHERE id = %s AND output_format = 'pdf'""",
            (report_id,),
        ).fetchone()
    if row is None:
        return None
    return dict(zip(("report_number", "report_date", "output_filename"), row))
