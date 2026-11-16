"""Topology-preserving, content-fitted layout for clean engineering sheets.

The source-image coordinate system remains authoritative for the CAD model.
This module applies one uniform affine transform to the selected objects; it
never changes pipe connectivity, bends, intersections or branch topology.
"""
from __future__ import annotations

from copy import deepcopy
import math
import re
from typing import Any

from cad_symbols import symbol_port_positions, symbol_primitives
from drawing_template import apply_page_orientation


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
            if margin < 0.12:
                continue
            best[edge_id] = (scores[0][1], scores[0][0], margin)
        for edge_id, (other_id, _score, _margin) in best.items():
            other = best.get(other_id)
            if other and other[0] == edge_id:
                pairs[(node_id, edge_id)] = other_id
    return pairs


def _merge_pipe_network(pipes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Join fragments through a single, unambiguous continuation only."""
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
                visited.add(current_index)
                break
            # Reject inconsistent shared-node coordinates before consuming the
            # next edge. It must remain available as an independent route.
            if geometry and math.dist(geometry[-1], ordered[0]) > 1e-6:
                break
            visited.add(current_index)
            if not geometry:
                geometry.extend(ordered)
            else:
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
        result["fromNode"] = start_node
        result["toNode"] = end_node_id
        result["geometry"] = [[round(point[0], 2), round(point[1], 2)] for point in geometry]
        result["sourceEdgeIds"] = list(dict.fromkeys(source_ids))
        if confidence_values:
            result["confidence"] = round(min(confidence_values), 3)
        if len(segments) > 1:
            result["mergedSegmentCount"] = len(segments)
            result["attributes"] = {**(result.get("attributes") or {}), "mergedSourceEdgeIds": result["sourceEdgeIds"]}
        return result

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
    return [item for item in merged if len(item.get("geometry") or []) >= 2]


def _source_content_bounds(model: dict[str, Any], source_width: float, source_height: float,
                           padding_ratio: float = 0.055) -> dict[str, float]:
    xs: list[float] = []
    ys: list[float] = []

    def add_point(point: Any) -> None:
        if isinstance(point, (list, tuple)) and len(point) >= 2:
            try:
                x, y = float(point[0]), float(point[1])
                if math.isfinite(x) and math.isfinite(y):
                    xs.append(x)
                    ys.append(y)
            except (TypeError, ValueError):
                return

    for pipe in model.get("pipes", []):
        if pipe.get("state") != "primary":
            continue
        for point in pipe.get("geometry") or []:
            add_point(point)
    for symbol in model.get("symbols", []):
        if symbol.get("state") != "primary":
            continue
        box = symbol.get("bbox") or {}
        try:
            x, y, w, h = (float(box[key]) for key in ("x", "y", "w", "h"))
            xs.extend([x, x + w]); ys.extend([y, y + h])
        except (KeyError, TypeError, ValueError):
            pass
    for collection in ("dimensions", "labels"):
        for item in model.get(collection, []):
            if item.get("state") != "primary":
                continue
            box = item.get("bbox") or {}
            try:
                x, y, w, h = (float(box[key]) for key in ("x", "y", "w", "h"))
                xs.extend([x, x + w]); ys.extend([y, y + h])
            except (KeyError, TypeError, ValueError):
                pass

    if not xs or not ys:
        return {"x": 0.0, "y": 0.0, "w": max(1.0, source_width), "h": max(1.0, source_height)}

    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    content_w, content_h = max(1.0, max_x - min_x), max(1.0, max_y - min_y)
    padding = max(8.0, max(content_w, content_h) * max(0.0, min(0.20, padding_ratio)))
    min_x -= padding; max_x += padding
    min_y -= padding; max_y += padding
    if source_width > 1:
        min_x = max(0.0, min_x); max_x = min(source_width, max_x)
    if source_height > 1:
        min_y = max(0.0, min_y); max_y = min(source_height, max_y)
    if max_x - min_x < 2.0:
        min_x -= 1.0; max_x += 1.0
    if max_y - min_y < 2.0:
        min_y -= 1.0; max_y += 1.0
    return {"x": round(min_x, 2), "y": round(min_y, 2),
            "w": round(max(1.0, max_x - min_x), 2), "h": round(max(1.0, max_y - min_y), 2)}


def _rect_intersects(left: dict[str, float], right: dict[str, float], gap: float = 0.0) -> bool:
    return not (left["x"] + left["w"] + gap <= right["x"] or
                right["x"] + right["w"] + gap <= left["x"] or
                left["y"] + left["h"] + gap <= right["y"] or
                right["y"] + right["h"] + gap <= left["y"])


def _route_midpoint(pipe: dict[str, Any]) -> tuple[list[float], tuple[float, float], float] | None:
    geometry = pipe.get("geometry") or []
    segments = []
    for a, b in zip(geometry, geometry[1:]):
        dx, dy = float(b[0]) - float(a[0]), float(b[1]) - float(a[1])
        length = math.hypot(dx, dy)
        if length > 0.1:
            segments.append((length, a, b, dx / length, dy / length))
    if not segments:
        return None
    length, a, b, ux, uy = max(segments, key=lambda item: item[0])
    midpoint = [(float(a[0]) + float(b[0])) / 2.0, (float(a[1]) + float(b[1])) / 2.0]
    return midpoint, (ux, uy), length



def _point_to_route_distance(point: list[float], pipe: dict[str, Any]) -> float:
    """Minimum Euclidean distance from a point to any segment in a route."""
    best = float("inf")
    geometry = pipe.get("geometry") or []
    px, py = float(point[0]), float(point[1])
    for a, b in zip(geometry, geometry[1:]):
        ax, ay = float(a[0]), float(a[1])
        bx, by = float(b[0]), float(b[1])
        dx, dy = bx - ax, by - ay
        denominator = dx * dx + dy * dy
        t = 0.0 if denominator <= 1e-9 else max(0.0, min(1.0, ((px-ax)*dx + (py-ay)*dy) / denominator))
        qx, qy = ax + t * dx, ay + t * dy
        best = min(best, math.hypot(px - qx, py - qy))
    return best

def _text_box(position: list[float], text: str, height: float = 10.0) -> dict[str, float]:
    width = max(12.0, len(str(text)) * height * 0.58 + 6.0)
    return {"x": float(position[0]) - width / 2.0, "y": float(position[1]) - height,
            "w": width, "h": height + 3.0}


def _choose_annotation_position(pipe: dict[str, Any] | None, fallback: list[float], text: str,
                                occupied: list[dict[str, float]], drawing_area: dict[str, float],
                                preferred_distance: float = 14.0) -> tuple[list[float], dict[str, float]]:
    route = _route_midpoint(pipe) if pipe else None
    candidates: list[list[float]] = []
    if route:
        midpoint, (ux, uy), _length = route
        nx, ny = -uy, ux
        d = preferred_distance
        candidates = [
            [midpoint[0] + nx * d, midpoint[1] + ny * d],
            [midpoint[0] - nx * d, midpoint[1] - ny * d],
            [midpoint[0] + ux * d, midpoint[1] + uy * d + d * 0.55],
            [midpoint[0] - ux * d, midpoint[1] - uy * d + d * 0.55],
            [midpoint[0] + nx * d * 1.7, midpoint[1] + ny * d * 1.7],
            [midpoint[0] - nx * d * 1.7, midpoint[1] - ny * d * 1.7],
        ]
    candidates.append([float(fallback[0]), float(fallback[1])])
    best = None
    best_score = float("inf")
    for candidate in candidates:
        box = _text_box(candidate, text)
        overflow = max(0.0, drawing_area["x"] - box["x"]) + max(0.0, box["x"] + box["w"] - drawing_area["x"] - drawing_area["w"])
        overflow += max(0.0, drawing_area["y"] - box["y"]) + max(0.0, box["y"] + box["h"] - drawing_area["y"] - drawing_area["h"])
        collisions = sum(1 for other in occupied if _rect_intersects(box, other, gap=3.0))
        score = collisions * 1000.0 + overflow * 10.0
        if score < best_score:
            best, best_score = (candidate, box), score
        if score <= 0:
            break
    assert best is not None
    return [round(best[0][0], 2), round(best[0][1], 2)], best[1]


def _dimension_graphic(dimension: dict[str, Any], target_pipe: dict[str, Any] | None,
                       offset: float = 9.0) -> dict[str, Any] | None:
    route = _route_midpoint(target_pipe) if target_pipe else None
    if not route:
        return None
    midpoint, (ux, uy), length = route
    geometry = target_pipe.get("geometry") or []
    segments = []
    for a, b in zip(geometry, geometry[1:]):
        dx, dy = float(b[0]) - float(a[0]), float(b[1]) - float(a[1])
        segment_length = math.hypot(dx, dy)
        if segment_length > 0.1:
            segments.append((segment_length, [float(a[0]), float(a[1])], [float(b[0]), float(b[1])]))
    if not segments:
        return None
    segment_length, a, b = max(segments, key=lambda item: item[0])
    ux, uy = (b[0] - a[0]) / segment_length, (b[1] - a[1]) / segment_length
    nx, ny = -uy, ux
    d = max(7.0, min(float(offset), segment_length * 0.22))
    a_dim = [a[0] + nx * d, a[1] + ny * d]
    b_dim = [b[0] + nx * d, b[1] + ny * d]
    arrow = max(2.0, min(4.0, segment_length * 0.12))

    def arrow_lines(tip: list[float], direction: float) -> list[list[list[float]]]:
        base_x = tip[0] + direction * ux * arrow
        base_y = tip[1] + direction * uy * arrow
        side = arrow * 0.45
        return [
            [tip, [base_x + nx * side, base_y + ny * side]],
            [tip, [base_x - nx * side, base_y - ny * side]],
        ]

    return {
        "kind": str(dimension.get("kind") or "length"),
        "extensionLines": [[a, a_dim], [b, b_dim]],
        "dimensionLine": [a_dim, b_dim],
        "arrowLines": arrow_lines(a_dim, 1.0) + arrow_lines(b_dim, -1.0),
        "textPosition": [round((a_dim[0] + b_dim[0]) / 2.0 + nx * 4.0, 2),
                         round((a_dim[1] + b_dim[1]) / 2.0 + ny * 4.0, 2)],
        "sourcePipeId": str(target_pipe.get("id") or ""),
        "segmentLengthPx": round(segment_length, 2),
        "notToScale": True,
    }


def _scale_calibration(model: dict[str, Any], page_scale: float, page_width_mm: float, page_width_units: float) -> dict[str, Any]:
    """Estimate a page scale only from dimensions explicitly confirmed by a user."""
    raw_pipes = {str(item.get("id")): item for item in model.get("pipes", []) if item.get("id")}
    samples = []
    for dimension in model.get("dimensions", []):
        if dimension.get("state") != "primary" or dimension.get("kind") != "length" or not dimension.get("targetId"):
            continue
        try:
            value_mm = float(dimension.get("value"))
        except (TypeError, ValueError):
            continue
        pipe = raw_pipes.get(str(dimension.get("targetId")))
        if pipe is None:
            continue
        geometry = pipe.get("geometry") or []
        source_length = sum(math.dist(a[:2], b[:2]) for a, b in zip(geometry, geometry[1:]))
        if source_length <= 1.0 or value_mm <= 0 or not math.isfinite(value_mm):
            continue
        samples.append({
            "dimensionId": str(dimension.get("id") or ""),
            "targetId": str(dimension.get("targetId") or ""),
            "valueMm": round(value_mm, 3),
            "sourceLengthPx": round(source_length, 3),
            "mmPerSourcePixel": value_mm / source_length,
        })
    if not samples:
        return {"status": "not_calibrated", "scaleLabel": "Масштаб не установлен",
                "samples": [], "requiresConfirmation": True}
    ratios = [item["mmPerSourcePixel"] for item in samples]
    low, high = min(ratios), max(ratios)
    consistency = high / max(low, 1e-9)
    if len(samples) > 1 and consistency > 1.12:
        return {"status": "conflicting_dimensions", "scaleLabel": "Масштаб проверить",
                "samples": samples, "consistencyRatio": round(consistency, 4),
                "requiresConfirmation": True,
                "message": "Подтверждённые размеры дают несовместимые масштабы; единый масштаб не применён."}
    mm_per_source_pixel = sum(ratios) / len(ratios)
    paper_mm_per_source_pixel = page_scale * page_width_mm / max(1.0, page_width_units)
    print_ratio = paper_mm_per_source_pixel / max(mm_per_source_pixel, 1e-9)
    if print_ratio <= 0 or not math.isfinite(print_ratio):
        label = "Масштаб проверить"
    elif print_ratio >= 1:
        label = f"Масштаб {print_ratio:.2f}:1"
    else:
        denominator = 1.0 / print_ratio
        label = f"Масштаб 1:{denominator:.0f}"
    return {
        "status": "single_dimension_reference" if len(samples) == 1 else "consistent_multiple_dimensions",
        "scaleLabel": label, "samples": samples,
        "mmPerSourcePixel": round(mm_per_source_pixel, 8),
        "paperMmPerSourcePixel": round(paper_mm_per_source_pixel, 8),
        "printScaleRatio": round(print_ratio, 8),
        "consistencyRatio": round(consistency, 4),
        "requiresConfirmation": True,
        "message": "Масштаб рассчитан по подтверждённым размерам и должен быть проверен перед выпуском.",
    }


def build_clean_layout(
    model: dict[str, Any],
    page_width: int | None = None,
    page_height: int | None = None,
    template: dict[str, Any] | None = None,
    review_only: bool = False,
) -> tuple[dict[str, Any], dict[str, Any]]:
    template = deepcopy(template) if template else None
    template = template or {}
    page_profile = template.get("page") or {}
    source = model.get("sourceImage") or {}
    try:
        source_width = max(1.0, float(source.get("width", 0)))
        source_height = max(1.0, float(source.get("height", 0)))
    except (TypeError, ValueError):
        source_width = source_height = 1.0

    layout_options = template.get("layout") or {}
    content_bounds = _source_content_bounds(
        model, source_width, source_height,
        padding_ratio=float(layout_options.get("contentPaddingRatio", 0.055) or 0.055),
    ) if layout_options.get("fitToContent", True) else {
        "x": 0.0, "y": 0.0, "w": source_width, "h": source_height,
    }

    explicit_page_size = page_width is not None and page_height is not None
    if not explicit_page_size and page_profile.get("autoOrientation") and not page_profile.get("orientationLocked"):
        content_ratio = content_bounds["w"] / max(1.0, content_bounds["h"])
        template = apply_page_orientation(template, landscape=content_ratio > 1.12)
        page_profile = template.get("page") or {}
    page_width = int(page_width or page_profile.get("width") or 850)
    page_height = int(page_height or page_profile.get("height") or 1200)

    zones = template.get("zones") or {}
    content = zones.get("pageContent") or {"x": 32, "y": 160, "w": page_width - 64, "h": page_height - 280}
    area = {
        "x": float(content.get("x", 32.0)),
        "y": float(content.get("y", 160.0)),
        "w": max(1.0, float(content.get("w", page_width - 64.0))),
        "h": max(1.0, float(content.get("h", page_height - 280.0))),
    }
    scale = min(area["w"] / max(1.0, content_bounds["w"]), area["h"] / max(1.0, content_bounds["h"]))
    offset_x = area["x"] + (area["w"] - content_bounds["w"] * scale) / 2.0 - content_bounds["x"] * scale
    offset_y = area["y"] + (area["h"] - content_bounds["h"] * scale) / 2.0 - content_bounds["y"] * scale

    def transform(point: list[float] | tuple[float, float]) -> list[float]:
        return [round(offset_x + float(point[0]) * scale, 2), round(offset_y + float(point[1]) * scale, 2)]

    def map_box(box: dict[str, Any]) -> dict[str, float]:
        top_left = transform([float(box.get("x", 0)), float(box.get("y", 0))])
        return {"x": top_left[0], "y": top_left[1],
                "w": round(max(2.0, float(box.get("w", 0)) * scale), 2),
                "h": round(max(2.0, float(box.get("h", 0)) * scale), 2)}

    nodes = [item for item in model.get("nodes", []) if isinstance(item.get("position"), list)]
    primary_pipes = [item for item in model.get("pipes", []) if item.get("state") == "primary"]
    review_pipes = [item for item in model.get("pipes", []) if item.get("state") != "primary"]
    layout_nodes = [{**deepcopy(node), "position": transform(node["position"])} for node in nodes]
    layout_node_by_id = {str(item["id"]): item for item in layout_nodes}

    layout_pipes = []
    for pipe in _merge_pipe_network(primary_pipes):
        geometry = [transform(point) for point in pipe.get("geometry", [])]
        start = layout_node_by_id.get(str(pipe.get("fromNode")))
        end = layout_node_by_id.get(str(pipe.get("toNode")))
        if geometry and start:
            geometry[0] = list(start["position"])
        if geometry and end:
            geometry[-1] = list(end["position"])
        if len(geometry) >= 2:
            layout_pipes.append({**deepcopy(pipe), "geometry": geometry})

    layout_review_pipes = []
    for pipe in review_pipes:
        geometry = [transform(point) for point in pipe.get("geometry", [])]
        if len(geometry) >= 2:
            layout_review_pipes.append({**deepcopy(pipe), "geometry": geometry})

    layout_symbols = []
    occupied: list[dict[str, float]] = []
    for item in model.get("symbols", []):
        if item.get("state") != "primary":
            continue
        layout_symbol = {**deepcopy(item), "bbox": map_box(item.get("bbox") or {})}
        layout_symbol["primitives"] = symbol_primitives(layout_symbol)
        layout_symbol["portsPage"] = [dict(port, position=transform(port.get("position") or [0, 0]))
                                       for port in symbol_port_positions(item)]
        layout_symbols.append(layout_symbol)
        occupied.append(dict(layout_symbol["bbox"]))

    pipe_by_id = {str(item.get("id")): item for item in layout_pipes}
    for item in layout_pipes:
        for source_edge_id in item.get("sourceEdgeIds", []):
            pipe_by_id.setdefault(str(source_edge_id), item)
    symbol_by_id = {str(item.get("id")): item for item in layout_symbols}

    def midpoint(target_id: str) -> list[float] | None:
        pipe = pipe_by_id.get(target_id)
        if pipe:
            route = _route_midpoint(pipe)
            return list(route[0]) if route else None
        symbol = symbol_by_id.get(target_id)
        if symbol:
            box = symbol["bbox"]
            return [box["x"] + box["w"] / 2, box["y"] + box["h"] / 2]
        return None

    layout_labels = []
    explicit_number_targets: set[str] = set()
    explicit_number_positions: list[list[float]] = []
    source_labels = [item for item in model.get("labels", [])
                     if item.get("state") == "primary" and item.get("role") != "dimension_value"
                     and _numeric_text(item.get("text"))]
    for label in source_labels:
        text = str(label.get("text") or "").strip()
        box = label.get("bbox") or {}
        source_anchor = [float(box.get("x", 0)) + float(box.get("w", 0)) / 2,
                         float(box.get("y", 0)) + float(box.get("h", 0))]
        target_id = str(label.get("targetId") or "")
        target_pipe = pipe_by_id.get(target_id)
        position, label_box = _choose_annotation_position(
            target_pipe, transform(source_anchor), text, occupied, area,
            preferred_distance=max(11.0, 14.0 * min(1.4, max(0.7, scale))),
        ) if layout_options.get("autoPlaceAnnotations", True) else (transform(source_anchor), _text_box(transform(source_anchor), text))
        occupied.append(label_box)
        layout_labels.append({**deepcopy(label), "position": position, "layoutBBox": label_box,
                              "sourceBBox": deepcopy(box), "autoPlaced": bool(target_pipe)})
        if target_id:
            explicit_number_targets.add(target_id)
        explicit_number_positions.append(position)

    layout_dimensions = []
    for dimension in model.get("dimensions", []):
        if dimension.get("state") != "primary" or not _numeric_text(dimension.get("value", dimension.get("rawText", ""))):
            continue
        box = dimension.get("bbox") or {}
        if all(key in box for key in ("x", "y", "w", "h")):
            source_anchor = [float(box["x"]) + float(box["w"]) / 2,
                             float(box["y"]) + float(box["h"])]
            fallback = transform(source_anchor)
        else:
            anchor = midpoint(str(dimension.get("targetId") or ""))
            fallback = [round(anchor[0], 2), round(anchor[1] - 10.0, 2)] if anchor else [area["x"] + area["w"] / 2, area["y"] + 10]
        target_id = str(dimension.get("targetId") or "")
        target_pipe = pipe_by_id.get(target_id)
        display_text = str(dimension.get("rawText") or "").strip()
        if not display_text:
            if dimension.get("kind") == "diameter":
                display_text = f"Ø{dimension.get('value')} мм"
            else:
                display_text = f"{dimension.get('value')} мм"
        position, dimension_box = _choose_annotation_position(
            target_pipe, fallback, display_text, occupied, area, preferred_distance=22.0,
        ) if target_pipe else (fallback, _text_box(fallback, display_text, 11.0))
        graphic = _dimension_graphic(dimension, target_pipe, float(layout_options.get("dimensionLineOffset", 9.0)))
        if graphic:
            graphic["textPosition"] = position
        layout_dimensions.append({**deepcopy(dimension), "position": position,
                                  "displayText": display_text, "layoutBBox": dimension_box,
                                  "graphic": graphic, "notToScale": True})
        occupied.append(dimension_box)

    # Provisional section numbers are generated only for unnumbered primary
    # routes. They are explicitly marked as suggestions and never written back
    # into the engineering/source model.
    section_tags = []
    if layout_options.get("autoNumberSections", False) and layout_options.get("showGeneratedSectionNumbers", True):
        ordered_pipes = sorted(layout_pipes, key=lambda pipe: (
            sum(float(point[1]) for point in pipe.get("geometry", [])) / max(1, len(pipe.get("geometry", []))),
            sum(float(point[0]) for point in pipe.get("geometry", [])) / max(1, len(pipe.get("geometry", []))),
            str(pipe.get("id") or ""),
        ))
        number = 1
        for pipe in ordered_pipes:
            route_ids = {str(pipe.get("id") or ""), *(str(value) for value in pipe.get("sourceEdgeIds", []))}
            if route_ids & explicit_number_targets:
                continue
            # OCR labels can be numerically correct but not topologically linked.
            # If a verified numeric label is already close to this route, do not
            # add a second provisional tag on top of it.
            if any(_point_to_route_distance(position, pipe) <= 30.0 for position in explicit_number_positions):
                continue
            route = _route_midpoint(pipe)
            if not route:
                continue
            middle, (ux, uy), _length = route
            nx, ny = -uy, ux
            tag_text = f"{number:02d}"
            candidates = [
                [middle[0] + nx * 12.0, middle[1] + ny * 12.0],
                [middle[0] - nx * 12.0, middle[1] - ny * 12.0],
                [middle[0] + 14.0, middle[1] - 14.0],
                [middle[0] - 14.0, middle[1] + 14.0],
            ]
            best = None
            best_score = float("inf")
            for candidate in candidates:
                box = {"x": candidate[0] - 8.0, "y": candidate[1] - 7.0, "w": 16.0, "h": 13.0}
                overflow = max(0.0, area["x"] - box["x"]) + max(0.0, box["x"] + box["w"] - area["x"] - area["w"])
                overflow += max(0.0, area["y"] - box["y"]) + max(0.0, box["y"] + box["h"] - area["y"] - area["h"])
                collisions = sum(1 for other in occupied if _rect_intersects(box, other, gap=2.0))
                score = collisions * 1000 + overflow * 10
                if score < best_score:
                    best, best_score = (candidate, box), score
                if score <= 0:
                    break
            if best is None or best_score > 0:
                # Never cover existing annotations or leave the drawing area
                # just to propose a number for a fragmented detector route.
                continue
            section_tags.append({
                "id": f"AUTO-{number:03d}", "number": tag_text,
                "position": [round(best[0][0], 2), round(best[0][1], 2)],
                "bbox": {key: round(value, 2) for key, value in best[1].items()},
                "targetId": str(pipe.get("id") or ""),
                "sourceEdgeIds": list(pipe.get("sourceEdgeIds") or []),
                "source": "generated_provisional", "requiresConfirmation": True,
            })
            occupied.append(best[1])
            number += 1

    scale_calibration = _scale_calibration(
        model, scale, float(page_profile.get("widthMm", 210)), float(page_width)
    )
    layout = {
        "schema": "cad-clean-layout/1.2",
        "scaleCalibration": scale_calibration,
        "page": {
            "width": page_width, "height": page_height,
            "widthMm": float(page_profile.get("widthMm", 210)),
            "heightMm": float(page_profile.get("heightMm", 297)),
            "format": str(page_profile.get("format", "A4")),
            "orientation": str(page_profile.get("orientation", "portrait")),
        },
        "template": template,
        "sourceImage": {"width": source_width, "height": source_height},
        "sourceContentBounds": content_bounds,
        "coordinateTransform": {
            "scale": round(scale, 8), "offset": [round(offset_x, 2), round(offset_y, 2)],
            "sourceCrop": content_bounds, "fitToContent": bool(layout_options.get("fitToContent", True)),
            "preservesSourcePageCoordinates": True, "topologyPreserved": True,
        },
        "reviewOnly": bool(review_only), "drawingArea": area,
        "frame": {"margin": 18.0, "headerBottom": 150.0 if page_height > 1000 else 132.0,
                  "footerTop": 936.0 if page_height > 1000 else 680.0},
        "nodes": layout_nodes, "pipes": layout_pipes, "reviewPipes": layout_review_pipes,
        "symbols": layout_symbols, "dimensions": layout_dimensions, "labels": layout_labels,
        "sectionTags": section_tags,
    }
    return layout, {
        "scale": round(scale, 5), "snappedHorizontalPipes": 0, "snappedVerticalPipes": 0,
        "placedLabels": len(layout_labels), "placedDimensions": len(layout_dimensions),
        "reviewPipes": len(layout_review_pipes), "primarySourceSegments": len(primary_pipes),
        "primaryRoutesAfterMerging": len(layout_pipes),
        "mergedPrimarySegments": max(0, len(primary_pipes) - len(layout_pipes)),
        "sourceCoordinatesPreserved": True, "topologyPreserved": True,
        "contentFitEnabled": bool(layout_options.get("fitToContent", True)),
        "sourceContentBounds": content_bounds,
        "sourcePageAreaUtilization": round((content_bounds["w"] * content_bounds["h"]) / max(1.0, source_width * source_height), 4),
        "provisionalSectionNumbers": len(section_tags),
        "pageOrientation": layout["page"]["orientation"],
        "pageZonesDoNotOverlap": True,
        "scaleCalibration": scale_calibration,
    }
