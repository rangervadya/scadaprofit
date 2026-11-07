"""Reference sheet profile for portrait A4 piping inspection drawings."""
from __future__ import annotations

from copy import deepcopy
from pathlib import Path
from typing import Any


REFERENCE_GAS_TEMPLATE: dict[str, Any] = {
    "schema": "cad-drawing-template/1.1",
    "id": "gas-inspection-reference-a4-portrait",
    "page": {
        "width": 850,
        "height": 1200,
        "widthMm": 210,
        "heightMm": 297,
        "format": "A4",
        "orientation": "portrait",
    },
    "zones": {
        # Geometry is mapped from the complete source page into this area.
        # Its aspect ratio matches a portrait A4 scan, so line positions and
        # the relative placement of the upper network/lower risers are kept.
        "pageContent": {"x": 32, "y": 43, "w": 786, "h": 1113},
        "header": {"x": 32, "y": 20, "w": 786, "h": 155},
        "mainNetwork": {"x": 65, "y": 175, "w": 750, "h": 590},
        "risers": {"x": 65, "y": 765, "w": 465, "h": 360},
        "legend": {"x": 515, "y": 965, "w": 300, "h": 165},
        "signatures": {"x": 515, "y": 1128, "w": 300, "h": 55},
    },
    "fields": {
        "documentTitle": "Заключение по результатам технического диагностирования внутридомового газового оборудования.",
        "appendix": "Продолжение Приложения",
        "title": "Схема",
        "subtitle": "неразрушающего контроля внутридомового газового оборудования",
        "address": "",
        "preparedBy": "",
        "drawnBy": "",
    },
    "legend": [
        {"code": "—", "label": "расположение контролируемого участка"},
        {"code": "—", "label": "номер контролируемого участка"},
        {"code": "—", "label": "ультразвуковой контроль"},
        {"code": "—", "label": "толщинометрия"},
        {"code": "—", "label": "определение объемной влажности"},
        {"code": "—", "label": "участок вскрыт для осмотра"},
        {"code": "—", "label": "определение наличия эл. контакта «труба–футляр»"},
    ],
}


def _reference_page_profile(reference_path: str | Path | None) -> dict[str, Any] | None:
    """Read raster dimensions only; a filled scan is never embedded as a backdrop."""
    if not reference_path:
        return None
    path = Path(reference_path)
    if not path.is_file():
        return None
    try:
        from PIL import Image, ImageOps

        with Image.open(path) as source:
            image = ImageOps.exif_transpose(source)
            width, height = map(int, image.size)
            image_format = str(image.format or path.suffix.lstrip(".")).upper()
        if width <= 0 or height <= 0:
            return None
        return {
            "fileName": path.name[:180],
            "imageWidth": width,
            "imageHeight": height,
            "imageFormat": image_format,
            "aspectRatio": round(width / height, 6),
            "appliedAs": "page-profile-only",
            "rasterUnderlay": False,
        }
    except Exception:
        return None


def build_drawing_template(
    overrides: dict[str, Any] | None = None,
    reference_path: str | Path | None = None,
) -> dict[str, Any]:
    template = deepcopy(REFERENCE_GAS_TEMPLATE)
    overrides = overrides or {}
    for key in template["fields"]:
        if key in overrides:
            template["fields"][key] = str(overrides[key] or "").strip()[:240]

    reference = _reference_page_profile(reference_path)
    if reference:
        ratio = float(reference["aspectRatio"])
        if ratio > 1.0:
            template["page"].update({
                "width": 1200, "height": 850,
                "widthMm": 297, "heightMm": 210,
                "format": "A4", "orientation": "landscape",
            })
            template["zones"]["pageContent"] = {"x": 43, "y": 32, "w": 1113, "h": 786}
        template["reference"] = reference
    return template
