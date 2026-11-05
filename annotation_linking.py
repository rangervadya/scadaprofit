"""Conservative association of OCR labels and dimensions with CAD objects."""
from __future__ import annotations

from copy import deepcopy
import math
from typing import Any


def _box_center(box: dict[str, Any]) -> tuple[float, float] | None:
    try:
        return float(box['x']) + float(box['w']) / 2.0, float(box['y']) + float(box['h']) / 2.0
    except (KeyError, TypeError, ValueError):
        return None


def _point_segment_distance(point: tuple[float, float], start: list[float], end: list[float]) -> float:
    px, py = point
    ax, ay, bx, by = float(start[0]), float(start[1]), float(end[0]), float(end[1])
    dx, dy = bx - ax, by - ay
    length_sq = dx * dx + dy * dy
    if length_sq <= 1e-9:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / length_sq))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def _distance_to_pipe(point: tuple[float, float], pipe: dict[str, Any]) -> float:
    geometry = pipe.get('geometry') or []
    distances = [_point_segment_distance(point, a, b) for a, b in zip(geometry, geometry[1:])]
    return min(distances, default=float('inf'))


def _distance_to_box(point: tuple[float, float], box: dict[str, Any]) -> float:
    try:
        x1, y1 = float(box['x']), float(box['y'])
        x2, y2 = x1 + float(box['w']), y1 + float(box['h'])
    except (KeyError, TypeError, ValueError):
        return float('inf')
    px, py = point
    dx, dy = max(x1 - px, 0.0, px - x2), max(y1 - py, 0.0, py - y2)
    return math.hypot(dx, dy)


def link_annotations(model: dict[str, Any]) -> tuple[dict[str, Any], dict[str, int]]:
    """Attach only unambiguous nearby annotations; retain alternatives otherwise."""
    updated = deepcopy(model)
    image = updated.get('sourceImage') or {}
    min_dimension = max(1.0, min(float(image.get('width', 1)), float(image.get('height', 1))))
    dimension_limit = max(24.0, min(72.0, min_dimension * 0.055))
    label_limit = max(20.0, min(58.0, min_dimension * 0.042))
    pipes = [pipe for pipe in updated.get('pipes', []) if pipe.get('state') == 'primary']
    symbols = [symbol for symbol in updated.get('symbols', []) if symbol.get('state') == 'primary']
    labels_by_id = {str(label.get('id')): label for label in updated.get('labels', [])}
    tasks = updated.get('reviewTasks', [])
    linked_dimensions = ambiguous_dimensions = linked_labels = 0

    for dimension in updated.get('dimensions', []):
        center = _box_center(dimension.get('bbox') or {})
        if center is None:
            continue
        ranked = sorted((_distance_to_pipe(center, pipe), str(pipe.get('id'))) for pipe in pipes)
        nearby = [(distance, target_id) for distance, target_id in ranked if distance <= dimension_limit]
        dimension['candidateTargetIds'] = [target_id for _, target_id in nearby[:3]]
        unambiguous = len(nearby) == 1 or (len(nearby) >= 2 and nearby[1][0] - nearby[0][0] >= max(7.0, nearby[0][0] * 0.35))
        if nearby and unambiguous:
            dimension['targetId'] = nearby[0][1]
            dimension['assignmentDistancePx'] = round(nearby[0][0], 2)
            dimension['state'] = 'primary'
            linked_dimensions += 1
            for task in tasks:
                if task.get('kind') == 'assign_dimension' and dimension.get('id') in (task.get('targetIds') or []):
                    task['status'] = 'resolved'
        elif len(nearby) >= 2:
            ambiguous_dimensions += 1

    dimension_label_ids = {str(item.get('sourceAnnotationId')) for item in updated.get('dimensions', [])}
    for label in updated.get('labels', []):
        if str(label.get('id')) in dimension_label_ids or label.get('targetId'):
            continue
        text = str(label.get('text') or '').strip()
        center = _box_center(label.get('bbox') or {})
        if center is None or not text or len(text) > 36:
            continue
        ranked: list[tuple[float, str, str]] = []
        ranked.extend((_distance_to_box(center, symbol.get('bbox') or {}), str(symbol.get('id')), 'symbol') for symbol in symbols)
        ranked.extend((_distance_to_pipe(center, pipe), str(pipe.get('id')), 'pipe') for pipe in pipes)
        ranked.sort()
        nearby = [item for item in ranked if item[0] <= label_limit]
        if not nearby:
            continue
        if len(nearby) >= 2 and nearby[1][0] - nearby[0][0] < max(6.0, nearby[0][0] * 0.30):
            label['candidateTargetIds'] = [item[1] for item in nearby[:3]]
            continue
        distance, target_id, target_kind = nearby[0]
        label['targetId'] = target_id
        label['role'] = 'symbol_label' if target_kind == 'symbol' else 'pipe_label'
        label['assignmentDistancePx'] = round(distance, 2)
        linked_labels += 1

    open_tasks = any(task.get('status') == 'open' for task in tasks)
    unresolved_dimensions = any(item.get('state') != 'primary' for item in updated.get('dimensions', []))
    updated['status'] = 'needs_review' if open_tasks or unresolved_dimensions else 'confirmed'
    return updated, {
        'linkedDimensions': linked_dimensions,
        'ambiguousDimensions': ambiguous_dimensions,
        'linkedLabels': linked_labels,
    }
