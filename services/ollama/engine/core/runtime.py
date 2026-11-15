"""Process-level runtime helpers shared by the engine pipeline.

`progress` emits one progress event per stage so the Node parent can render it
as `[STAGE] message` in progress.log; `atomic_write_text` persists text
artifacts without ever exposing a truncated file if the process is killed.
"""

from __future__ import annotations

import os
from pathlib import Path

from engine.core.logging_setup import emit_progress, get_logger

log = get_logger('processor')


def progress(stage: str, message: str) -> None:
    """Emit one progress event for the parent process and for progress.log."""
    emit_progress(stage, message, logger=log)


def atomic_write_text(path: str | Path, text: str) -> None:
    """Persist a text artifact without exposing a truncated file on SIGKILL.

    `write_text` truncates first, so a container kill during a multi-megabyte
    graph leaves invalid JSON. Write beside the target and `os.replace` it.
    """
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f'{target.name}.{os.getpid()}.tmp')
    try:
        temporary.write_text(text, encoding='utf-8')
        os.replace(temporary, target)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


# Backwards-compatible aliases: the pipeline and its tests call the underscored
# names, and `processor` re-exports them from here.
_progress = progress
_atomic_write_text = atomic_write_text
