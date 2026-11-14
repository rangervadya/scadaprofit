"""Small PostgreSQL repository for application health and generated-report history.

The report binary and form contents are not stored in the database. Only a minimal
technical audit entry is saved after a successful generation. When DATABASE_URL is
not configured (the normal local/dev setup), a JSON index next to the generated
documents provides the same archive metadata without requiring PostgreSQL.
"""
from __future__ import annotations

import json
import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_LOCAL_INDEX = Path(__file__).resolve().parent / "output" / "archive_index.json"
_LOCAL_ARCHIVE = _LOCAL_INDEX.parent / "archive"
_LOCAL_LOCK = threading.Lock()


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


def _read_local_reports() -> list[dict[str, Any]]:
    if not _LOCAL_INDEX.is_file():
        return []
    try:
        payload = json.loads(_LOCAL_INDEX.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    return payload if isinstance(payload, list) else []


def _write_local_reports(reports: list[dict[str, Any]]) -> None:
    _LOCAL_INDEX.parent.mkdir(parents=True, exist_ok=True)
    temporary = _LOCAL_INDEX.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(reports, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(_LOCAL_INDEX)


def _local_report_id(reports: list[dict[str, Any]]) -> int:
    return max((int(item.get("id") or 0) for item in reports), default=0) + 1


def _sync_local_archive() -> None:
    """Index archived files that were written before the local JSON index existed."""
    if not _LOCAL_ARCHIVE.is_dir():
        return
    with _LOCAL_LOCK:
        reports = _read_local_reports()
        changed = False

        # Older backfilled rows used the storage key as the visible filename.
        for item in reports:
            storage_value = str(item.get("storage_path") or "")
            if not storage_value:
                continue
            storage_path = Path(storage_value)
            if not item.get("original_filename") or item.get("original_filename") == storage_path.name:
                created_at = str(item.get("created_at") or "")
                try:
                    report_date = datetime.fromisoformat(created_at).strftime("%d.%m.%Y")
                except ValueError:
                    report_date = ""
                parts = storage_path.stem.split("_", 1)
                report_number = parts[1] if len(parts) == 2 else storage_path.stem
                extension = storage_path.suffix.lstrip(".") or "pdf"
                item["report_number"] = report_number
                item["original_filename"] = f"Заключение_{report_number}_{report_date}.{extension}"
                item["report_date"] = item.get("report_date") or report_date
                changed = True

        known = {str(item.get("storage_path") or "") for item in reports}
        for path in sorted(_LOCAL_ARCHIVE.iterdir()):
            if not path.is_file() or str(path.resolve()) in known:
                continue
            extension = path.suffix.lower()
            content_type = {
                ".pdf": "application/pdf",
                ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            }.get(extension, "application/octet-stream")
            output_format = "docx-editable" if extension == ".docx" else (extension.lstrip(".") or "file")
            created_at = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat()
            report_date = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).strftime("%d.%m.%Y")
            parts = path.stem.split("_", 1)
            report_number = parts[1] if len(parts) == 2 else path.stem
            reports.append(
                {
                    "id": _local_report_id(reports),
                    "created_at": created_at,
                    "report_number": report_number,
                    "report_date": report_date,
                    "output_format": output_format,
                    "page_count": 0,
                    "output_filename": path.name,
                    "archived": True,
                    "archived_at": created_at,
                    "storage_path": str(path.resolve()),
                    "original_filename": f"Заключение_{report_number}_{report_date}.{extension.lstrip('.')}",
                    "content_type": content_type,
                    "file_size": path.stat().st_size,
                }
            )
            known.add(str(path.resolve()))
            changed = True
        if changed:
            _write_local_reports(reports)


def init_database(wait_seconds: int = 45) -> None:
    """Wait for PostgreSQL and create the report-generation audit table."""
    if not _dsn():
        _LOCAL_INDEX.parent.mkdir(parents=True, exist_ok=True)
        _sync_local_archive()
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
                        output_filename VARCHAR(255) NOT NULL DEFAULT '',
                        archived BOOLEAN NOT NULL DEFAULT FALSE,
                        archived_at TIMESTAMPTZ,
                        storage_path TEXT NOT NULL DEFAULT '',
                        original_filename VARCHAR(255) NOT NULL DEFAULT '',
                        content_type VARCHAR(160) NOT NULL DEFAULT '',
                        file_size BIGINT NOT NULL DEFAULT 0
                    )
                    """
                )
                # Older databases were created before archive metadata existed.
                for column, definition in (
                    ("archived", "BOOLEAN NOT NULL DEFAULT FALSE"),
                    ("archived_at", "TIMESTAMPTZ"),
                    ("storage_path", "TEXT NOT NULL DEFAULT ''"),
                    ("original_filename", "VARCHAR(255) NOT NULL DEFAULT ''"),
                    ("content_type", "VARCHAR(160) NOT NULL DEFAULT ''"),
                    ("file_size", "BIGINT NOT NULL DEFAULT 0"),
                ):
                    conn.execute(
                        f"ALTER TABLE report_runs ADD COLUMN IF NOT EXISTS {column} {definition}"
                    )
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS report_runs_created_at_idx ON report_runs(created_at DESC)"
                )
                conn.execute(
                    "CREATE INDEX IF NOT EXISTS report_runs_archived_idx ON report_runs(archived, created_at DESC)"
                )
            return
        except Exception as exc:  # database may still be starting up
            last_error = exc
            time.sleep(1)
    raise RuntimeError(f"PostgreSQL was not ready within {wait_seconds}s: {last_error}")


def database_status() -> dict[str, Any]:
    if not _dsn():
        return {
            "status": "local-json",
            "configured": False,
            "message": "PostgreSQL не настроен; архив ведётся в локальном JSON-индексе",
        }
    try:
        with _connect() as conn:
            conn.execute("SELECT 1")
        return {"status": "ok", "configured": True, "message": "PostgreSQL доступен"}
    except Exception as exc:
        return {"status": "error", "configured": True, "message": f"База данных недоступна: {exc}"}


def record_generation(
    report_number: str,
    report_date: str,
    output_format: str,
    page_count: int,
    filename: str,
    *,
    archived: bool = False,
    storage_path: str = "",
    original_filename: str = "",
    content_type: str = "",
    file_size: int = 0,
) -> int | None:
    """Persist one generated document and return its archive identifier."""
    if not _dsn():
        with _LOCAL_LOCK:
            reports = _read_local_reports()
            report_id = _local_report_id(reports)
            reports.append(
                {
                    "id": report_id,
                    "created_at": datetime.now(timezone.utc).isoformat(),
                    "report_number": report_number or "",
                    "report_date": report_date or "",
                    "output_format": output_format,
                    "page_count": int(page_count),
                    "output_filename": filename or "",
                    "archived": bool(archived),
                    "archived_at": datetime.now(timezone.utc).isoformat() if archived else None,
                    "storage_path": storage_path or "",
                    "original_filename": original_filename or "",
                    "content_type": content_type or "",
                    "file_size": max(0, int(file_size or 0)),
                }
            )
            _write_local_reports(reports)
            return report_id
    with _connect() as conn:
        row = conn.execute(
            """
            INSERT INTO report_runs (
                report_number, report_date, output_format, page_count, output_filename,
                archived, archived_at, storage_path, original_filename, content_type, file_size
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id
            """,
            (
                report_number or "",
                report_date or "",
                output_format,
                int(page_count),
                filename or "",
                bool(archived),
                datetime.now(timezone.utc) if archived else None,
                storage_path or "",
                original_filename or "",
                content_type or "",
                max(0, int(file_size or 0)),
            ),
        ).fetchone()
    return int(row[0]) if row else None


def recent_reports(limit: int = 12, archived_only: bool = False) -> list[dict[str, Any]]:
    safe_limit = min(max(int(limit), 1), 200)
    if not _dsn():
        with _LOCAL_LOCK:
            reports = _read_local_reports()
        if archived_only:
            reports = [item for item in reports if item.get("archived")]
        reports.sort(key=lambda item: str(item.get("created_at") or ""), reverse=True)
        return reports[:safe_limit]
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT id, created_at, report_number, report_date, output_format, page_count,
                   output_filename, archived, original_filename, content_type, file_size
            FROM report_runs
            WHERE (%s = FALSE OR archived = TRUE)
            ORDER BY created_at DESC LIMIT %s
            """,
            (bool(archived_only), safe_limit),
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
            "archived": bool(row[7]),
            "original_filename": row[8],
            "content_type": row[9],
            "file_size": int(row[10] or 0),
        }
        for row in rows
    ]


def get_report(report_id: int) -> dict[str, Any] | None:
    if not _dsn():
        with _LOCAL_LOCK:
            reports = _read_local_reports()
        return next((item for item in reports if int(item.get("id") or 0) == int(report_id)), None)
    with _connect() as conn:
        row = conn.execute(
            """
            SELECT id, report_number, report_date, output_format, archived,
                   original_filename, content_type, storage_path, file_size
            FROM report_runs WHERE id = %s
            """,
            (int(report_id),),
        ).fetchone()
    if not row:
        return None
    return {
        "id": row[0],
        "report_number": row[1],
        "report_date": row[2],
        "output_format": row[3],
        "archived": bool(row[4]),
        "original_filename": row[5],
        "content_type": row[6],
        "storage_path": row[7],
        "file_size": int(row[8] or 0),
    }
