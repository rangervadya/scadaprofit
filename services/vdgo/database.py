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
    return psycopg.connect(
        dsn,
        connect_timeout=4,
        application_name='vdgo',
        options='-c statement_timeout=5000 -c lock_timeout=3000',
    )


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
                conn.execute(
                    """
                    CREATE TABLE IF NOT EXISTS archive_entries (
                        id BIGINT PRIMARY KEY,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        report_number VARCHAR(120) NOT NULL DEFAULT '',
                        report_date VARCHAR(32) NOT NULL DEFAULT '',
                        output_format VARCHAR(16) NOT NULL,
                        page_count INTEGER NOT NULL DEFAULT 0,
                        output_filename VARCHAR(255) NOT NULL,
                        original_filename VARCHAR(255) NOT NULL DEFAULT '',
                        content_type VARCHAR(120) NOT NULL DEFAULT '',
                        file_size BIGINT NOT NULL DEFAULT 0,
                        archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        storage_path TEXT NOT NULL
                    )
                    """
                )
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS archive_entries_created_at_idx ON archive_entries(created_at DESC)"
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


def record_generation(report_number: str, report_date: str, output_format: str, page_count: int, filename: str) -> int | None:
    if not _dsn():
        return None
    try:
        with _connect() as conn:
            row = conn.execute(
                """
                INSERT INTO report_runs (report_number, report_date, output_format, page_count, output_filename)
                VALUES (%s, %s, %s, %s, %s)
                RETURNING id
                """,
                (report_number or "", report_date or "", output_format, int(page_count), filename or ""),
            ).fetchone()
            return int(row[0]) if row and row[0] is not None else None
    except Exception as exc:
        # Callers treat a missing audit row as non-fatal; log it with the report
        # number so the document can still be matched to its row later.
        log.error('Cannot record generated document', extra={'err': str(exc), 'reportNumber': report_number, 'format': output_format})
        raise


def archive_enabled() -> bool:
    return bool(_dsn())


def insert_archive_entry(entry: dict[str, Any]) -> None:
    if not _dsn():
        return
    with _connect() as conn:
        conn.execute(
            """
            INSERT INTO archive_entries (
                id, created_at, report_number, report_date, output_format, page_count,
                output_filename, original_filename, content_type, file_size, archived_at, storage_path
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (id) DO UPDATE SET
                created_at = EXCLUDED.created_at,
                report_number = EXCLUDED.report_number,
                report_date = EXCLUDED.report_date,
                output_format = EXCLUDED.output_format,
                page_count = EXCLUDED.page_count,
                output_filename = EXCLUDED.output_filename,
                original_filename = EXCLUDED.original_filename,
                content_type = EXCLUDED.content_type,
                file_size = EXCLUDED.file_size,
                archived_at = EXCLUDED.archived_at,
                storage_path = EXCLUDED.storage_path
            """,
            (
                int(entry['id']),
                entry.get('created_at'),
                entry.get('report_number') or '',
                entry.get('report_date') or '',
                entry.get('output_format') or '',
                int(entry.get('page_count') or 0),
                entry.get('output_filename') or '',
                entry.get('original_filename') or '',
                entry.get('content_type') or '',
                int(entry.get('file_size') or 0),
                entry.get('archived_at'),
                entry.get('storage_path') or '',
            ),
        )


def list_archive_entries(limit: int = 200) -> list[dict[str, Any]]:
    if not _dsn():
        return []
    safe_limit = min(max(int(limit or 1), 1), 500)
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT id, created_at, report_number, report_date, output_format, page_count,
                   output_filename, original_filename, content_type, file_size, archived_at, storage_path
            FROM archive_entries
            ORDER BY created_at DESC
            LIMIT %s
            """,
            (safe_limit,),
        ).fetchall()
    return [_archive_row(row) for row in rows]


def get_archive_entry(report_id: object) -> dict[str, Any] | None:
    if not _dsn() or report_id is None or str(report_id).strip() == '':
        return None
    with _connect() as conn:
        row = conn.execute(
            """
            SELECT id, created_at, report_number, report_date, output_format, page_count,
                   output_filename, original_filename, content_type, file_size, archived_at, storage_path
            FROM archive_entries
            WHERE id = %s
            """,
            (int(report_id),),
        ).fetchone()
    return _archive_row(row) if row else None


def _archive_row(row: Any) -> dict[str, Any]:
    return {
        'id': int(row[0]),
        'created_at': row[1].isoformat() if hasattr(row[1], 'isoformat') else row[1],
        'report_number': row[2] or '',
        'report_date': row[3] or '',
        'output_format': row[4] or '',
        'page_count': int(row[5] or 0),
        'output_filename': row[6] or '',
        'original_filename': row[7] or '',
        'content_type': row[8] or '',
        'file_size': int(row[9] or 0),
        'archived_at': row[10].isoformat() if hasattr(row[10], 'isoformat') else row[10],
        'storage_path': row[11] or '',
    }


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
