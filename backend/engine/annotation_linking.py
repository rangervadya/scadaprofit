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


def _segments_intersect(a: tuple[float, float], b: tuple[float, float],
                       c: tuple[float, float], d: tuple[float, float]) -> bool:
    def orient(p, q, r):
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    def on_segment(p, q, r):
        return (min(p[0], r[0]) - 1e-8 <= q[0] <= max(p[0], r[0]) + 1e-8 and
                min(p[1], r[1]) - 1e-8 <= q[1] <= max(p[1], r[1]) + 1e-8)
    o1, o2, o3, o4 = orient(a, b, c), orient(a, b, d), orient(c, d, a), orient(c, d, b)
    if ((o1 > 0 > o2 or o2 > 0 > o1) and (o3 > 0 > o4 or o4 > 0 > o3)):
        return True
    return ((abs(o1) <= 1e-8 and on_segment(a, c, b)) or
            (abs(o2) <= 1e-8 and on_segment(a, d, b)) or
            (abs(o3) <= 1e-8 and on_segment(c, a, d)) or
            (abs(o4) <= 1e-8 and on_segment(c, b, d)))


def _distance_box_to_pipe(box: dict[str, Any], pipe: dict[str, Any]) -> float:
    """Measure the gap from the annotation rectangle to the whole pipe polyline.

    Using the rectangle (rather than only its center) avoids losing long
    dimension labels whose text box touches a pipe near one edge.
    """
    try:
        x1, y1 = float(box['x']), float(box['y'])
        x2, y2 = x1 + max(0.0, float(box['w'])), y1 + max(0.0, float(box['h']))
    except (KeyError, TypeError, ValueError):
        center = _box_center(box)
        return _distance_to_pipe(center, pipe) if center else float('inf')
    corners = [(x1, y1), (x2, y1), (x2, y2), (x1, y2)]
    rectangle_edges = list(zip(corners, corners[1:] + corners[:1]))
    geometry = pipe.get('geometry') or []
    best = float('inf')
    for raw_a, raw_b in zip(geometry, geometry[1:]):
        a = (float(raw_a[0]), float(raw_a[1]))
        b = (float(raw_b[0]), float(raw_b[1]))
        if (x1 <= a[0] <= x2 and y1 <= a[1] <= y2) or (x1 <= b[0] <= x2 and y1 <= b[1] <= y2):
            return 0.0
        if any(_segments_intersect(a, b, c, d) for c, d in rectangle_edges):
            return 0.0
        for point in (a, b):
            dx, dy = max(x1 - point[0], 0.0, point[0] - x2), max(y1 - point[1], 0.0, point[1] - y2)
            best = min(best, math.hypot(dx, dy))
        best = min(best, *(_point_segment_distance(corner, [a[0], a[1]], [b[0], b[1]]) for corner in corners))
    return best

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
        box = dimension.get('bbox') or {}
        if _box_center(box) is None:
            continue
        ranked = sorted((_distance_box_to_pipe(box, pipe), str(pipe.get('id'))) for pipe in pipes)
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
        ranked.extend((_distance_box_to_pipe(label.get('bbox') or {}, pipe), str(pipe.get('id')), 'pipe') for pipe in pipes)
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
