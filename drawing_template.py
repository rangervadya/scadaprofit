"""Structured drawing-sheet templates; no values are inferred from handwriting."""
from __future__ import annotations

from copy import deepcopy
from typing import Any


REFERENCE_GAS_TEMPLATE: dict[str, Any] = {
    "schema": "cad-drawing-template/1.0",
    "id": "gas-inspection-reference-a3",
    "page": {"width": 1200, "height": 850, "format": "A3", "orientation": "landscape"},
    "fields": {
        "appendix": "Приложение",
        "title": "Схема неразрушающего контроля",
        "subtitle": "внутридомового газового оборудования",
        "address": "",
        "preparedBy": "",
        "checkedBy": "",
    },
    "zones": {
        "header": {"x": 40, "y": 28, "w": 1120, "h": 58},
        "mainNetwork": {"x": 60, "y": 100, "w": 1080, "h": 400},
        "risers": {"x": 60, "y": 520, "w": 720, "h": 245},
        "legend": {"x": 810, "y": 535, "w": 330, "h": 185},
        "signatures": {"x": 810, "y": 730, "w": 330, "h": 70},
    },
    "legend": [
        {"code": "○", "label": "расположение контролируемого участка"},
        {"code": "№", "label": "номер контролируемого участка"},
        {"code": "L", "label": "протяжённость контролируемого участка"},
        {"code": "Ø", "label": "наружный диаметр"},
        {"code": "?", "label": "элемент требует подтверждения"},
    ],
}


def build_drawing_template(overrides: dict[str, Any] | None = None) -> dict[str, Any]:
    template = deepcopy(REFERENCE_GAS_TEMPLATE)
    overrides = overrides or {}
    allowed_fields = template["fields"].keys()
    for key in allowed_fields:
        if key in overrides:
            template["fields"][key] = str(overrides[key] or "").strip()[:240]
    return template
