"""Shared analysis deadline (P2-1).

`analyze()` sets a hard deadline so the process can emit a partial graph before
the Node worker SIGTERMs it. The Qwen budget check reads the same value, so it
lives in a tiny module both sides import.
"""

from __future__ import annotations

# None means "no hard deadline configured" (budget checks always pass).
ANALYSIS_HARD_DEADLINE: float | None = None


def set_analysis_hard_deadline(deadline: float | None) -> None:
    global ANALYSIS_HARD_DEADLINE
    ANALYSIS_HARD_DEADLINE = deadline


def get_analysis_hard_deadline() -> float | None:
    return ANALYSIS_HARD_DEADLINE