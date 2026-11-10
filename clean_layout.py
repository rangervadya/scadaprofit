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


def _edge_outward_vector(pipe: dict[str, Any], node_id: str) -> tuple[float, float] | None:
    geometry = pipe.get("geometry") or []
    if len(geometry) < 2:
        return None
    if str(pipe.get("fromNode")) == node_id:
        first, second = geometry[0], geometry[1]
    elif str(pipe.get("toNode")) == node_id:
        first, second = geometry[-1], geometry[-2]
    else:
        return None
    dx, dy = float(second[0]) - float(first[0]), float(second[1]) - float(first[1])
    length = math.hypot(dx, dy)
    if length <= 1e-6:
        return None
    return dx / length, dy / length


def _continuation_pairs(pipes: list[dict[str, Any]]) -> dict[tuple[str, int], int]:
    """Return only mutually unique, near-opposite edge pairs at shared nodes."""
    incident: dict[str, list[int]] = {}
    for index, pipe in enumerate(pipes):
        for key in ("fromNode", "toNode"):
            node_id = str(pipe.get(key) or "")
            if node_id:
                incident.setdefault(node_id, []).append(index)

    pairs: dict[tuple[str, int], int] = {}
    for node_id, edge_ids in incident.items():
        unique_edges = list(dict.fromkeys(edge_ids))
        if len(unique_edges) < 2:
            continue
        vectors = {edge_id: _edge_outward_vector(pipes[edge_id], node_id) for edge_id in unique_edges}
        vectors = {edge_id: vector for edge_id, vector in vectors.items() if vector is not None}
        # At a genuine degree-2 node there is no competing branch: preserve the
        # corner and combine both fragments into one polyline regardless of bend.
        if len(vectors) == 2:
            first, second = sorted(vectors)
            pairs[(node_id, first)] = second
            pairs[(node_id, second)] = first
            continue
        best: dict[int, tuple[int, float, float]] = {}
        for edge_id, vector in vectors.items():
            scores = []
            for other_id, other_vector in vectors.items():
                if other_id == edge_id:
                    continue
                dot = vector[0] * other_vector[0] + vector[1] * other_vector[1]
                scores.append((dot, other_id))
            scores.sort()
            if not scores or scores[0][0] > -0.90:
                continue
            margin = scores[1][0] - scores[0][0] if len(scores) > 1 else 2.0
            # If a branch has two almost equally plausible continuations, leave it
            # split for review rather than inventing a route through the junction.
            if margin < 0.12:
                continue
            best[edge_id] = (scores[0][1], scores[0][0], margin)
        for edge_id, (other_id, _score, _margin) in best.items():
            other = best.get(other_id)
            if other and other[0] == edge_id:
                pairs[(node_id, edge_id)] = other_id
    return pairs


def _merge_pipe_network(pipes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Join line fragments only across an unambiguous near-collinear continuation.

    Branches remain independent routes; the source edge IDs are retained for
    annotation references and traceability. Coordinates are never snapped.
    """
    if len(pipes) < 2:
        return [dict(pipe, sourceEdgeIds=list(pipe.get("sourceEdgeIds") or [str(pipe.get("id", ""))])) for pipe in pipes]
    continuation = _continuation_pairs(pipes)
    visited: set[int] = set()
    merged: list[dict[str, Any]] = []

    def trace(first_index: int, start_node: str) -> dict[str, Any]:
        current_index = first_index
        current_node = start_node
        geometry: list[list[float]] = []
        source_ids: list[str] = []
        confidence_values: list[float] = []
        segments: list[dict[str, Any]] = []
        start_pipe = pipes[first_index]
        start_node_id = start_node
        end_node_id = start_node
        while current_index not in visited:
            pipe = pipes[current_index]
            raw_geometry = pipe.get("geometry") or []
            if len(raw_geometry) < 2:
                visited.add(current_index)
                break
            from_node, to_node = str(pipe.get("fromNode") or ""), str(pipe.get("toNode") or "")
            if current_node == from_node:
                ordered = [[float(point[0]), float(point[1])] for point in raw_geometry]
                next_node = to_node
            elif current_node == to_node:
                ordered = [[float(point[0]), float(point[1])] for point in reversed(raw_geometry)]
                next_node = from_node
            else:
                # A malformed endpoint reference is not safe to traverse.
                visited.add(current_index)
                break
            visited.add(current_index)
            if not geometry:
                geometry.extend(ordered)
            else:
                gap = math.dist(geometry[-1], ordered[0])
                if gap > 5.0:
                    # The graph node agrees but the detector endpoints do not;
                    # keep this as a separate route rather than making a visual bridge.
                    break
                if gap > 1e-6:
                    geometry.append([(geometry[-1][0] + ordered[0][0]) / 2.0,
                                     (geometry[-1][1] + ordered[0][1]) / 2.0])
                geometry.extend(ordered[1:])
            source_ids.extend(str(item) for item in (pipe.get("sourceEdgeIds") or [pipe.get("id", "")]) if item)
            confidence_values.append(float(pipe.get("confidence", 0.0) or 0.0))
            segments.append(pipe)
            end_node_id = next_node
            next_index = continuation.get((next_node, current_index))
            if next_index is None or next_index in visited:
                break
            current_index = next_index
            current_node = next_node

        result = dict(start_pipe)
        result["fromNode"] = start_node_id
        result["toNode"] = end_node_id
        result["geometry"] = [[round(point[0], 2), round(point[1], 2)] for point in geometry]
        result["sourceEdgeIds"] = list(dict.fromkeys(source_ids))
        if confidence_values:
            result["confidence"] = round(min(confidence_values), 3)
        if len(segments) > 1:
            result["mergedSegmentCount"] = len(segments)
            result["attributes"] = {**(result.get("attributes") or {}),
                                    "mergedSourceEdgeIds": result["sourceEdgeIds"]}
        return result

    # Start traces at endpoints which have no continuation; then handle any
    # closed cycles by selecting the first remaining edge deterministically.
    starts: list[tuple[int, str]] = []
    for index, pipe in enumerate(pipes):
        for node_id in (str(pipe.get("fromNode") or ""), str(pipe.get("toNode") or "")):
            if node_id and (node_id, index) not in continuation:
                starts.append((index, node_id))
    for index, node_id in starts:
        if index not in visited:
            merged.append(trace(index, node_id))
    for index, pipe in enumerate(pipes):
        if index not in visited:
            start_node = str(pipe.get("fromNode") or pipe.get("toNode") or "")
            merged.append(trace(index, start_node))

    # Keep malformed or degenerate entries visible as their original segments.
    return [item for item in merged if len(item.get("geometry") or []) >= 2]


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

    merged_primary_pipes = _merge_pipe_network(pipes)
    layout_pipes = []
    for pipe in merged_primary_pipes:
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
    for item in layout_pipes:
        for source_edge_id in item.get("sourceEdgeIds", []):
            pipe_by_id.setdefault(str(source_edge_id), item)
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
        "primarySourceSegments": len(pipes),
        "primaryRoutesAfterMerging": len(layout_pipes),
        "mergedPrimarySegments": max(0, len(pipes) - len(layout_pipes)),
        "sourceCoordinatesPreserved": True,
        "numericVerifiedLabelsOnly": True,
        "pageOrientation": layout["page"]["orientation"],
    }
