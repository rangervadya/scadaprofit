"""Separate detector output into pipe, symbol, text and dimension channels."""
from __future__ import annotations

import math
import re
from typing import Any

from symbol_recognition import suggest_symbol_types


_DIAMETER_RE = re.compile(
    r"^(?:(?:DN|DU|ДН|ДУ)\s*[-:]?\s*|[Ø⌀ФфDДd]\s*=?\s*|диаметр\s*[:=]?\s*)(\d+(?:[.,]\d+)?)\s*(?:мм|mm)?$",
    re.IGNORECASE,
)
_LENGTH_RE = re.compile(
    r"^(?:(?:L|ДЛИНА)\s*[:=]?\s*)?(\d+(?:[.,]\d+)?)\s*(мм|mm|см|cm|м|m)?$",
    re.IGNORECASE,
)
_NUMBER_RE = re.compile(r"^\d{2,6}(?:[.,]\d{1,3})?$")


def _dimension_value(text: str) -> tuple[str, float] | None:
    """Parse common Russian/metric dimension notations into millimetres."""
    compact = re.sub(r"\s+", " ", str(text or "").strip())
    compact = compact.replace("−", "-").replace("–", "-")
    diameter = _DIAMETER_RE.fullmatch(compact)
    if diameter:
        return "diameter", float(diameter.group(1).replace(',', '.'))
    length = _LENGTH_RE.fullmatch(compact)
    if not length:
        return None
    raw_number, raw_unit = length.groups()
    if not raw_unit and not _NUMBER_RE.fullmatch(compact):
        return None
    value = float(raw_number.replace(',', '.'))
    unit = (raw_unit or "мм").lower()
    if unit in {"м", "m"}:
        value *= 1000.0
    elif unit in {"см", "cm"}:
        value *= 10.0
    return ("length", value) if value > 0 else None


def split_recognition_channels(width: int, height: int, components: list[dict[str, Any]],
                               edges: list[dict[str, Any]],
                               annotations: list[dict[str, Any]],
                               ink_mask: Any | None = None) -> dict[str, Any]:
    """Produce conservative candidates without assigning engineering semantics."""
    edges_by_component: dict[str, list[str]] = {}
    for edge in edges:
        edges_by_component.setdefault(str(edge.get('component_id') or ''), []).append(str(edge.get('id') or ''))

    symbols = []
    min_side = max(1.0, float(min(width, height)))
    for component in components:
        if component.get('role') != 'ambiguous':
            continue
        box = component.get('bbox') or {}
        try:
            bw, bh = float(box.get('w', 0)), float(box.get('h', 0))
            edge_count = int(component.get('edge_count', 0) or 0)
            overlap = float(component.get('ocr_overlap_ratio', 0) or 0)
            density = float(component.get('edge_density', 0) or 0)
        except (TypeError, ValueError):
            continue
        extent = max(bw, bh)
        compact = 3 <= edge_count <= 24 and 6.0 <= extent <= max(90.0, min_side * 0.12)
        text_clear = overlap < 0.14 and not component.get('text_crossing_suspect')
        structured = density >= 1.25 or int(component.get('max_node_degree', 0) or 0) >= 3
        if not (compact and text_clear and structured):
            continue
        confidence = min(0.78, 0.34 + min(edge_count, 10) * 0.025 + min(density, 3.0) * 0.06)
        bbox = {key: round(float(box.get(key, 0)), 2) for key in ('x', 'y', 'w', 'h')}
        suggestions = suggest_symbol_types(ink_mask, bbox) if ink_mask is not None else []
        best_score = float(suggestions[0]['score']) if suggestions else 0.0
        second_score = float(suggestions[1]['score']) if len(suggestions) > 1 else 0.0
        symbols.append({
            'id': f'S{len(symbols) + 1}',
            'visualClass': 'template_match_candidate' if best_score >= 0.48 else 'unknown_compact_mark',
            'suggestedTypes': suggestions,
            'suggestionConfidence': round(best_score, 3),
            'suggestionMargin': round(best_score - second_score, 3),
            'autoClassified': False,
            'bbox': bbox,
            'sourceComponentId': str(component.get('id') or ''),
            'sourceEdgeIds': [item for item in edges_by_component.get(str(component.get('id') or ''), []) if item],
            'confidence': round(confidence, 3),
            'state': 'review',
        })

    dimensions = []
    text_items = []
    for annotation in annotations:
        text = re.sub(r"\s+", " ", str(annotation.get('text') or '')).strip()
        if not text:
            continue
        parsed = _dimension_value(text)
        if not parsed:
            text_items.append(str(annotation.get('id') or ''))
            continue
        kind, value = parsed
        confidence = float(annotation.get('confidence', 0) or 0)
        if 0 <= confidence <= 1:
            confidence *= 100
        dimensions.append({
            'id': f'D{len(dimensions) + 1}', 'kind': kind, 'value': value,
            'rawText': text, 'unit': 'mm', 'dimensionUnit': 'mm',
            'sourceAnnotationId': str(annotation.get('id') or ''),
            'bbox': dict(annotation.get('bbox') or {}), 'targetId': None,
            'confidence': round(max(0.0, min(1.0, confidence / 100.0)), 3),
            'state': 'review',
        })

    return {
        'pipes': [str(edge.get('id')) for edge in edges if edge.get('cad_include')],
        'symbolCandidates': symbols,
        'dimensionCandidates': dimensions,
        'textAnnotationIds': [item for item in text_items if item],
        'summary': {
            'primaryPipes': sum(1 for edge in edges if edge.get('cad_include')),
            'symbolCandidates': len(symbols), 'dimensionCandidates': len(dimensions),
            'textAnnotations': len(text_items),
        },
    }
