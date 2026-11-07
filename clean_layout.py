"""Source-coordinate-preserving layout for confirmed reconstruction data."""
from __future__ import annotations

from copy import deepcopy
import math
import re
from typing import Any

from cad_symbols import symbol_primitives


_NUMERIC_LABEL = re.compile(r"^(?:№|#)?\s*(?:(?:Ø|ø|DN|Ду)\s*)?\d[\d\s.,:/+()–—-]*$", re.IGNORECASE)


def _numeric_text(value: Any) -> bool:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return bool(text and _NUMERIC_LABEL.fullmatch(text))


def build_clean_layout(
    model: dict[str, Any],
    page_width: int | None = None,
    page_height: int | None = None,
    template: dict[str, Any] | None = None,
    review_only: bool = False,
) -> tuple[dict[str, Any], dict[str, Any]]:
    template = deepcopy(template) if template else None
    page_profile = (template or {}).get("page") or {}
    page_width = int(page_width or page_profile.get("width") or 850)
    page_height = int(page_height or page_profile.get("height") or 1200)

    nodes = [item for item in model.get("nodes", []) if isinstance(item.get("position"), list)]
    pipes = [item for item in model.get("pipes", []) if item.get("state") == "primary"]
    review_pipes = [item for item in model.get("pipes", []) if item.get("state") != "primary"]
    node_by_id = {str(item.get("id")): item for item in nodes}

    source = model.get("sourceImage") or {}
    try:
        source_width = max(1.0, float(source.get("width", 0)))
        source_height = max(1.0, float(source.get("height", 0)))
    except (TypeError, ValueError):
        source_width = source_height = 1.0

    zones = (template or {}).get("zones") or {}
    content = zones.get("pageContent") or {
        "x": 32.0, "y": 32.0,
        "w": page_width - 64.0, "h": page_height - 64.0,
    }
    area = {
        "x": float(content.get("x", 32.0)),
        "y": float(content.get("y", 32.0)),
        "w": max(1.0, float(content.get("w", page_width - 64.0))),
        "h": max(1.0, float(content.get("h", page_height - 64.0))),
    }
    scale = min(area["w"] / source_width, area["h"] / source_height)
    offset_x = area["x"] + (area["w"] - source_width * scale) / 2.0
    offset_y = area["y"] + (area["h"] - source_height * scale) / 2.0

    def transform(point: list[float] | tuple[float, float]) -> list[float]:
        return [
            round(offset_x + float(point[0]) * scale, 2),
            round(offset_y + float(point[1]) * scale, 2),
        ]

    # Do not snap, straighten, reconnect or reflow source geometry here.
    # Those operations change the detected shape and must be explicit review edits.
    layout_nodes = [
        {**deepcopy(node), "position": transform(node["position"])}
        for node in nodes
    ]
    layout_node_by_id = {str(item["id"]): item for item in layout_nodes}

    layout_pipes = []
    for pipe in pipes:
        geometry = [transform(point) for point in pipe.get("geometry", [])]
        start = layout_node_by_id.get(str(pipe.get("fromNode")))
        end = layout_node_by_id.get(str(pipe.get("toNode")))
        if geometry and start:
            geometry[0] = list(start["position"])
        if geometry and end:
            geometry[-1] = list(end["position"])
        if len(geometry) >= 2:
            layout_pipes.append({**deepcopy(pipe), "geometry": geometry})

    def map_box(box: dict[str, Any]) -> dict[str, float]:
        top_left = transform([float(box.get("x", 0)), float(box.get("y", 0))])
        return {
            "x": top_left[0], "y": top_left[1],
            "w": round(max(2.0, float(box.get("w", 0)) * scale), 2),
            "h": round(max(2.0, float(box.get("h", 0)) * scale), 2),
        }

    layout_review_pipes = []
    for pipe in review_pipes:
        geometry = [transform(point) for point in pipe.get("geometry", [])]
        if len(geometry) >= 2:
            layout_review_pipes.append({**deepcopy(pipe), "geometry": geometry})

    layout_symbols = []
    for item in model.get("symbols", []):
        if item.get("state") != "primary":
            continue
        layout_symbol = {**deepcopy(item), "bbox": map_box(item.get("bbox") or {})}
        layout_symbol["primitives"] = symbol_primitives(layout_symbol)
        layout_symbols.append(layout_symbol)

    pipe_by_id = {str(item.get("id")): item for item in layout_pipes}
    symbol_by_id = {str(item.get("id")): item for item in layout_symbols}

    def midpoint(target_id: str) -> list[float] | None:
        pipe = pipe_by_id.get(target_id)
        if pipe and pipe.get("geometry"):
            geometry = pipe["geometry"]
            return list(geometry[len(geometry) // 2])
        symbol = symbol_by_id.get(target_id)
        if symbol:
            box = symbol["bbox"]
            return [box["x"] + box["w"] / 2, box["y"] + box["h"] / 2]
        return None

    layout_labels = []
    for label in model.get("labels", []):
        text = str(label.get("text") or "").strip()
        # Only verified numeric annotations are promoted to the clean drawing.
        # Unverified OCR and incidental words remain in graph.json for review.
        if label.get("state") != "primary" or label.get("role") == "dimension_value" or not _numeric_text(text):
            continue
        box = label.get("bbox") or {}
        source_anchor = [
            float(box.get("x", 0)),
            float(box.get("y", 0)) + float(box.get("h", 0)),
        ]
        layout_labels.append({
            **deepcopy(label),
            "position": transform(source_anchor),
            "sourceBBox": deepcopy(box),
        })

    layout_dimensions = []
    for dimension in model.get("dimensions", []):
        if dimension.get("state") != "primary" or not _numeric_text(dimension.get("value", dimension.get("rawText", ""))):
            continue
        box = dimension.get("bbox") or {}
        if all(key in box for key in ("x", "y", "w", "h")):
            source_anchor = [float(box["x"]), float(box["y"]) + float(box["h"])]
        else:
            anchor = midpoint(str(dimension.get("targetId") or ""))
            if anchor is None:
                continue
            # Already in page coordinates when sourced from a target midpoint.
            position = [round(anchor[0], 2), round(anchor[1] - 10.0, 2)]
            layout_dimensions.append({**deepcopy(dimension), "position": position})
            continue
        layout_dimensions.append({**deepcopy(dimension), "position": transform(source_anchor)})

    layout = {
        "schema": "cad-clean-layout/1.1",
        "page": {
            "width": page_width,
            "height": page_height,
            "widthMm": float(page_profile.get("widthMm", 210)),
            "heightMm": float(page_profile.get("heightMm", 297)),
            "format": str(page_profile.get("format", "A4")),
            "orientation": str(page_profile.get("orientation", "portrait")),
        },
        "template": template,
        "sourceImage": {"width": source_width, "height": source_height},
        "coordinateTransform": {
            "scale": round(scale, 8),
            "offset": [round(offset_x, 2), round(offset_y, 2)],
            "preservesSourcePageCoordinates": True,
        },
        "reviewOnly": bool(review_only),
        "drawingArea": area,
        "nodes": layout_nodes,
        "pipes": layout_pipes,
        "reviewPipes": layout_review_pipes,
        "symbols": layout_symbols,
        "dimensions": layout_dimensions,
        "labels": layout_labels,
    }
    return layout, {
        "scale": round(scale, 5),
        "snappedHorizontalPipes": 0,
        "snappedVerticalPipes": 0,
        "placedLabels": len(layout_labels),
        "placedDimensions": len(layout_dimensions),
        "reviewPipes": len(layout_review_pipes),
        "sourceCoordinatesPreserved": True,
        "numericVerifiedLabelsOnly": True,
        "pageOrientation": layout["page"]["orientation"],
    }
