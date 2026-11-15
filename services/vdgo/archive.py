"""Small file-backed archive for generated conclusions.

PostgreSQL stores the audit row; the document itself lives in the persistent
``output`` volume. The index is intentionally simple: one JSON file plus files
under ``output/archive``. It is guarded by a process lock because the VDGO
server is threaded, and every write is atomic (tmp + ``os.replace``).
"""
from __future__ import annotations

import json
import logging
import os
import re
import threading
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import database

log = logging.getLogger('vdgo.archive')

BASE = Path(__file__).resolve().parent
OUTPUT = BASE / "output"
ARCHIVE_DIR = OUTPUT / "archive"
ARCHIVE_INDEX = OUTPUT / "archive_index.json"

_LOCK = threading.Lock()


def _load_unlocked() -> list[dict[str, Any]]:
    try:
        payload = json.loads(ARCHIVE_INDEX.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, ValueError):
        return []
    if not isinstance(payload, list):
        return []
    return [entry for entry in payload if isinstance(entry, dict)]


def _save_unlocked(entries: list[dict[str, Any]]) -> None:
    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    temporary = ARCHIVE_INDEX.with_name(f"archive_index.json.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, ARCHIVE_INDEX)


def _safe_filename_part(value: object, fallback: str, limit: int = 48) -> str:
    raw = re.sub(r"[^0-9A-Za-zА-Яа-яЁё._-]+", "_", str(value or "").strip()).strip("._-")
    return raw[:limit] or fallback


def _entry_for_client(entry: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": entry.get("id"),
        "created_at": entry.get("created_at"),
        "report_number": entry.get("report_number") or "",
        "report_date": entry.get("report_date") or "",
        "output_format": entry.get("output_format") or "",
        "page_count": int(entry.get("page_count") or 0),
        "output_filename": entry.get("output_filename") or "",
        "archived": True,
        "archived_at": entry.get("archived_at"),
        "original_filename": entry.get("original_filename") or entry.get("output_filename") or "",
        "content_type": entry.get("content_type") or "application/octet-stream",
        "file_size": int(entry.get("file_size") or 0),
    }


def archive_document(
    source: Path,
    *,
    report_id: int | None,
    report_number: str,
    report_date: str,
    output_format: str,
    page_count: int,
    content_type: str,
    original_filename: str,
) -> dict[str, Any] | None:
    """Copy a generated document into the archive and return its index entry."""
    source = Path(source)
    if not source.is_file():
        return None
    data = source.read_bytes()
    stamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    safe_number = _safe_filename_part(report_number, "bez_nomera")
    extension = source.suffix.lower() or ".bin"
    filename = f"{stamp}-{uuid.uuid4().hex[:8]}_{safe_number}{extension}"
    destination = ARCHIVE_DIR / filename

    with _LOCK:
        ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
        entry = {
            "id": report_id,
            "created_at": datetime.now(UTC).isoformat(),
            "report_number": report_number or "",
            "report_date": report_date or "",
            "output_format": output_format,
            "page_count": int(page_count or 0),
            "output_filename": filename,
            "archived": True,
            "archived_at": datetime.now(UTC).isoformat(),
            # Relative to the archive directory: the container path differs from
            # a developer checkout, so an absolute path here is never portable.
            "storage_path": filename,
            "original_filename": original_filename or filename,
            "content_type": content_type or "application/octet-stream",
            "file_size": len(data),
        }
        if database.archive_enabled() and report_id is not None:
            try:
                database.insert_archive_entry(entry)
                return _entry_for_client(entry)
            except Exception as exc:
                log.warning('Archive DB insert failed; using JSON fallback', extra={'err': str(exc)})
        entries = _load_unlocked()
        entries.insert(0, entry)
        _save_unlocked(entries)
    return _entry_for_client(entry)


def list_archived(limit: int = 200) -> list[dict[str, Any]]:
    safe_limit = min(max(int(limit or 1), 1), 500)
    if database.archive_enabled():
        try:
            return [_entry_for_client(entry) for entry in database.list_archive_entries(safe_limit)]
        except Exception as exc:
            log.warning('Archive DB list failed; using JSON fallback', extra={'err': str(exc)})
    with _LOCK:
        entries = _load_unlocked()
    return [_entry_for_client(entry) for entry in entries[:safe_limit]]


def find_archived(report_id: object) -> dict[str, Any] | None:
    if report_id is None or str(report_id).strip() == "":
        return None
    if database.archive_enabled():
        try:
            entry = database.get_archive_entry(report_id)
            if entry:
                return entry
        except Exception as exc:
            log.warning('Archive DB lookup failed; using JSON fallback', extra={'err': str(exc), 'reportId': report_id})
    with _LOCK:
        entries = _load_unlocked()
    for entry in entries:
        if str(entry.get("id") or "") == str(report_id):
            return entry
    return None


def backfill_from_json() -> int:
    if not database.archive_enabled():
        return 0
    entries = _load_unlocked()
    imported = 0
    for entry in entries:
        if entry.get("id") is None:
            continue
        try:
            database.insert_archive_entry(entry)
            imported += 1
        except Exception as exc:
            log.warning('Cannot backfill archive entry', extra={'err': str(exc), 'id': entry.get('id')})
    if imported:
        log.info('Imported archive index into PostgreSQL', extra={'count': imported})
    return imported


def archived_path(report_id: object) -> Path | None:
    entry = find_archived(report_id)
    if not entry:
        return None
    archive_root = ARCHIVE_DIR.resolve()
    # `storage_path` is stored relative to the archive directory; older rows may
    # still hold an absolute path, which is accepted only when it resolves inside
    # the archive directory.
    stored = Path(str(entry.get("storage_path") or ""))
    candidates = [
        (ARCHIVE_DIR / stored) if not stored.is_absolute() else stored,
        ARCHIVE_DIR / Path(str(entry.get("output_filename") or "")).name,
    ]
    for candidate in candidates:
        try:
            resolved = candidate.resolve()
        except OSError:
            continue
        if archive_root not in resolved.parents or not resolved.is_file():
            continue
        return resolved
    return None