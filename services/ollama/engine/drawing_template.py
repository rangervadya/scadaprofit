"""Sheet profiles for clean LPG/VDGO engineering drawings.

The page layout deliberately separates the header, drawing field, legend and
signatures. A raster reference, when provided, determines the paper orientation
only; it is never embedded into the final vector sheet.
"""
from __future__ import annotations

from copy import deepcopy
from pathlib import Path
from typing import Any

from logging_setup import get_logger

log = get_logger('drawing_template')


def _portrait_zones() -> dict[str, dict[str, float]]:
    return {
        "pageContent": {"x": 52, "y": 176, "w": 746, "h": 748},
        "header": {"x": 34, "y": 26, "w": 782, "h": 132},
        "mainNetwork": {"x": 52, "y": 176, "w": 746, "h": 748},
        "risers": {"x": 52, "y": 176, "w": 746, "h": 748},
        "legend": {"x": 505, "y": 946, "w": 310, "h": 130},
        "signatures": {"x": 505, "y": 1084, "w": 310, "h": 82},
        "footer": {"x": 34, "y": 936, "w": 782, "h": 225},
    }


def _landscape_zones() -> dict[str, dict[str, float]]:
    return {
        "pageContent": {"x": 52, "y": 150, "w": 1096, "h": 510},
        "header": {"x": 34, "y": 24, "w": 1132, "h": 116},
        "mainNetwork": {"x": 52, "y": 150, "w": 1096, "h": 510},
        "risers": {"x": 52, "y": 150, "w": 1096, "h": 510},
        "legend": {"x": 50, "y": 690, "w": 720, "h": 122},
        "signatures": {"x": 790, "y": 690, "w": 358, "h": 122},
        "footer": {"x": 34, "y": 680, "w": 1132, "h": 145},
    }


REFERENCE_GAS_TEMPLATE: dict[str, Any] = {
    "schema": "cad-drawing-template/1.2",
    "id": "lpgcad-r1-professional-a4",
    "page": {
        "width": 850,
        "height": 1200,
        "widthMm": 210,
        "heightMm": 297,
        "format": "A4",
        "orientation": "portrait",
        "autoOrientation": True,
        "orientationLocked": False,
    },
    "zones": _portrait_zones(),
    "layout": {
        "fitToContent": True,
        "contentPaddingRatio": 0.055,
        "autoNumberSections": False,
        "autoPlaceAnnotations": True,
        "showGeneratedSectionNumbers": True,
        "preserveSourceTopology": True,
        "dimensionLineOffset": 9.0,
        "minimumTextGap": 4.0,
    },
    "fields": {
        "documentTitle": "Заключение по результатам технического диагностирования внутридомового газового оборудования.",
        "appendix": "Продолжение Приложения",
        "title": "Схема",
        "subtitle": "неразрушающего контроля внутридомового газового оборудования",
        "address": "",
        "preparedBy": "",
        "drawnBy": "",
        "checkedBy": "",
        "documentNumber": "",
    },
    "legend": [
        {"code": "━", "label": "расположение контролируемого участка", "kind": "pipe"},
        {"code": "01", "label": "номер участка по исходным данным", "kind": "section"},
        {"code": "◯", "label": "условное обозначение оборудования", "kind": "symbol"},
        {"code": "↔", "label": "размер участка; значение требует проверки", "kind": "dimension"},
        {"code": "- -", "label": "неподтверждённая геометрия — только проверка", "kind": "review"},
    ],
}


def _reference_page_profile(reference_path: str | Path | None) -> dict[str, Any] | None:
    """Read raster dimensions only; the reference image is never used as a backdrop."""
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
    except Exception as exc:
        # A reference file we cannot read only means the sheet keeps the
        # default portrait profile; it must not abort the whole export.
        log.warning('Reference sheet profile unreadable; using default portrait', extra={'err': str(exc), 'file': path.name[:180]})
        return None


def apply_page_orientation(template: dict[str, Any], landscape: bool) -> dict[str, Any]:
    """Update A4 page dimensions and non-overlapping zones for an orientation."""
    updated = deepcopy(template)
    page = updated.setdefault("page", {})
    if landscape:
        page.update({"width": 1200, "height": 850, "widthMm": 297, "heightMm": 210,
                     "format": "A4", "orientation": "landscape"})
        updated["zones"] = _landscape_zones()
    else:
        page.update({"width": 850, "height": 1200, "widthMm": 210, "heightMm": 297,
                     "format": "A4", "orientation": "portrait"})
        updated["zones"] = _portrait_zones()
    return updated


def build_drawing_template(
    overrides: dict[str, Any] | None = None,
    reference_path: str | Path | None = None,
) -> dict[str, Any]:
    template = deepcopy(REFERENCE_GAS_TEMPLATE)
    overrides = overrides or {}
    for key in template["fields"]:
        if key in overrides:
            template["fields"][key] = str(overrides[key] or "").strip()[:240]
    for key in template["layout"]:
        if key in overrides:
            template["layout"][key] = overrides[key]

    reference = _reference_page_profile(reference_path)
    if reference:
        landscape = float(reference["aspectRatio"]) > 1.0
        template = apply_page_orientation(template, landscape)
        template["page"]["autoOrientation"] = False
        template["page"]["orientationLocked"] = True
        template["reference"] = reference
    return template
