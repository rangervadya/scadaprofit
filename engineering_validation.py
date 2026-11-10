"""Engineering consistency checks for the editable reconstruction model."""
from __future__ import annotations

from copy import deepcopy
import math
import re
from typing import Any


def _interior_segment_intersection(a: list[float], b: list[float],
                                  c: list[float], d: list[float],
                                  epsilon: float = 0.035) -> tuple[float, float] | None:
    """Return a proper interior intersection; endpoint contacts are topology nodes."""
    ax, ay, bx, by = float(a[0]), float(a[1]), float(b[0]), float(b[1])
    cx, cy, dx, dy = float(c[0]), float(c[1]), float(d[0]), float(d[1])
    rx, ry, sx, sy = bx - ax, by - ay, dx - cx, dy - cy
    denominator = rx * sy - ry * sx
    if abs(denominator) < 1e-8:
        return None
    qpx, qpy = cx - ax, cy - ay
    t = (qpx * sy - qpy * sx) / denominator
    u = (qpx * ry - qpy * rx) / denominator
    if epsilon < t < 1.0 - epsilon and epsilon < u < 1.0 - epsilon:
        return ax + t * rx, ay + t * ry
    return None


def _polyline_bbox(geometry: list[list[float]]) -> tuple[float, float, float, float] | None:
    try:
        xs = [float(point[0]) for point in geometry]
        ys = [float(point[1]) for point in geometry]
    except (TypeError, ValueError, IndexError):
        return None
    return (min(xs), min(ys), max(xs), max(ys)) if xs and ys else None


def validate_engineering_model(model: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    updated = deepcopy(model)
    findings: list[dict[str, Any]] = []

    def add(code: str, severity: str, targets: list[str], message: str) -> None:
        findings.append({"id": f"F{len(findings) + 1}", "code": code, "severity": severity,
                         "targetIds": [item for item in targets if item], "message": message,
                         "status": "open"})

    nodes = {str(item.get('id')): item for item in updated.get('nodes', []) if item.get('id')}
    pipes = [item for item in updated.get('pipes', []) if item.get('state') == 'primary']
    source_image = updated.get('sourceImage') or {}
    image_width = float(source_image.get('width', 0) or 0)
    image_height = float(source_image.get('height', 0) or 0)
    incidence = {node_id: 0 for node_id in nodes}
    adjacency = {node_id: set() for node_id in nodes}
    geometry_keys: dict[tuple[tuple[float, float], ...], str] = {}
    pipe_boxes: dict[str, tuple[float, float, float, float]] = {}
    for pipe in pipes:
        pipe_id = str(pipe.get('id') or '')
        start, end = str(pipe.get('fromNode') or ''), str(pipe.get('toNode') or '')
        geometry = pipe.get('geometry') or []
        length = sum(math.dist(a[:2], b[:2]) for a, b in zip(geometry, geometry[1:]))
        bbox = _polyline_bbox(geometry)
        if bbox:
            pipe_boxes[pipe_id] = bbox
            if image_width and image_height and (bbox[0] < -5 or bbox[1] < -5 or bbox[2] > image_width + 5 or bbox[3] > image_height + 5):
                add('pipe_outside_source_image', 'review', [pipe_id], 'Часть геометрии выходит за границы исходного изображения.')
        try:
            key = tuple((round(float(point[0]), 1), round(float(point[1]), 1)) for point in geometry)
            reverse_key = tuple(reversed(key))
            canonical = min(key, reverse_key)
            if canonical in geometry_keys:
                add('duplicate_pipe_geometry', 'warning', [pipe_id, geometry_keys[canonical]], 'Обнаружены две геометрически совпадающие трассы.')
            else:
                geometry_keys[canonical] = pipe_id
        except (TypeError, ValueError, IndexError):
            pass
        if start == end or length < 1.0:
            add('invalid_pipe_geometry', 'error', [pipe_id], 'Участок имеет нулевую длину или замкнут на один узел.')
        # A graph endpoint may be shared conservatively by the detector, but
        # its stored polyline must still physically reach that node. Flag large
        # disagreements for review; never move or snap the geometry here.
        if len(geometry) >= 2:
            for node_id, endpoint, side in ((start, geometry[0], 'начало'), (end, geometry[-1], 'конец')):
                node = nodes.get(node_id)
                position = node.get('position') if node else None
                if isinstance(position, (list, tuple)) and len(position) >= 2:
                    try:
                        gap = math.dist([float(endpoint[0]), float(endpoint[1])],
                                        [float(position[0]), float(position[1])])
                    except (TypeError, ValueError, IndexError):
                        continue
                    if gap > 8.0:
                        add('pipe_endpoint_mismatch', 'review', [pipe_id, node_id],
                            f'Геометрия трубы не доходит до узла ({side}); расхождение {gap:.1f} px. Проверьте соединение.')
        if start in incidence:
            incidence[start] += 1
        if end in incidence:
            incidence[end] += 1
        if start in adjacency and end in adjacency and start != end:
            adjacency[start].add(end)
            adjacency[end].add(start)

    # Proper interior intersections are not silently promoted to junctions.
    # They become explicit review findings when the graph has no shared node.
    crossing_pairs: set[tuple[str, str]] = set()
    for left_index, left in enumerate(pipes):
        left_id = str(left.get('id') or '')
        left_box = pipe_boxes.get(left_id)
        left_geometry = left.get('geometry') or []
        if not left_box or len(left_geometry) < 2:
            continue
        for right in pipes[left_index + 1:]:
            right_id = str(right.get('id') or '')
            right_box = pipe_boxes.get(right_id)
            right_geometry = right.get('geometry') or []
            if not right_box or len(right_geometry) < 2:
                continue
            if (left_box[2] < right_box[0] or right_box[2] < left_box[0] or
                    left_box[3] < right_box[1] or right_box[3] < left_box[1]):
                continue
            found = False
            for a, b in zip(left_geometry, left_geometry[1:]):
                for c, d in zip(right_geometry, right_geometry[1:]):
                    if _interior_segment_intersection(a, b, c, d) is not None:
                        found = True
                        break
                if found:
                    break
            if found:
                pair = tuple(sorted((left_id, right_id)))
                if pair not in crossing_pairs:
                    crossing_pairs.add(pair)
                    add('unmodeled_pipe_crossing', 'review', [left_id, right_id],
                        'Две трассы пересекаются внутри сегментов, но не имеют общего узла. Проверьте: соединение это или переход без соединения.')

    for node_id, count in incidence.items():
        node = nodes[node_id]
        if count == 0:
            add('orphan_node', 'warning', [node_id], 'Узел не подключён ни к одному основному участку.')
        if count >= 6:
            add('high_degree_node', 'review', [node_id], f'Узел имеет {count} подключений; проверьте распознавание ветвления.')
        position = node.get('position')
        if image_width and image_height and isinstance(position, (list, tuple)) and len(position) >= 2:
            try:
                px, py = float(position[0]), float(position[1])
                if px < -5 or py < -5 or px > image_width + 5 or py > image_height + 5:
                    add('node_outside_source_image', 'review', [node_id], 'Узел находится за границами исходного изображения.')
            except (TypeError, ValueError):
                pass

    for link in updated.get('topologyLinks', []):
        start, end = str(link.get('fromNode') or ''), str(link.get('toNode') or '')
        if start in adjacency and end in adjacency:
            adjacency[start].add(end)
            adjacency[end].add(start)

    for node_id, count in incidence.items():
        node = nodes[node_id]
        if count == 1 and not node.get('symbolId'):
            add('open_endpoint', 'review', [node_id], 'Проверьте открытое окончание трубопровода.')

    active_nodes = {node_id for node_id, count in incidence.items() if count > 0}
    seen: set[str] = set()
    components: list[list[str]] = []
    for seed in sorted(active_nodes):
        if seed in seen:
            continue
        stack, group = [seed], []
        while stack:
            current = stack.pop()
            if current in seen:
                continue
            seen.add(current)
            group.append(current)
            stack.extend(neighbor for neighbor in adjacency.get(current, set()) if neighbor not in seen)
        components.append(group)
    if len(components) > 1:
        add('disconnected_network', 'warning', [], f'Основная сеть состоит из {len(components)} несвязанных частей.')

    for symbol in updated.get('symbols', []):
        if symbol.get('state') != 'primary':
            continue
        missing = [item.get('portId') for item in symbol.get('connections', []) if not item.get('nodeId')]
        if missing or not symbol.get('connections'):
            add('unconnected_symbol', 'warning', [str(symbol.get('id') or '')],
                'Условное обозначение имеет неподключённые точки.')

    pipe_ids = {str(pipe.get('id')) for pipe in pipes}
    for dimension in updated.get('dimensions', []):
        target = str(dimension.get('targetId') or '')
        raw_dimension_value = dimension.get('value')
        if raw_dimension_value not in (None, ''):
            try:
                dimension_value = float(raw_dimension_value)
            except (TypeError, ValueError):
                dimension_value = 0.0
            if not math.isfinite(dimension_value) or dimension_value <= 0:
                add('invalid_dimension_value', 'error', [str(dimension.get('id') or '')], 'Размер должен иметь положительное числовое значение.')
        if not target:
            add('unassigned_dimension', 'warning', [str(dimension.get('id') or '')],
                'Размер не назначен участку трубопровода.')
        elif target not in pipe_ids:
            add('invalid_dimension_target', 'error', [str(dimension.get('id') or ''), target],
                'Размер ссылается на отсутствующий или неподтверждённый участок.')

    number_labels: dict[str, list[str]] = {}
    for label in updated.get('labels', []):
        text = str(label.get('text') or '').strip()
        role = str(label.get('role') or '')
        if role in {'section_number', 'control_point_number'} or (role == 'unassigned' and re.fullmatch(r'\d', text)):
            number_labels.setdefault(text, []).append(str(label.get('id') or ''))
    for value, label_ids in number_labels.items():
        if len(label_ids) > 1:
            add('duplicate_number', 'warning', label_ids, f'Номер {value} встречается несколько раз.')

    counts = {severity: sum(1 for item in findings if item['severity'] == severity)
              for severity in ('error', 'warning', 'review')}
    updated['validationFindings'] = findings
    updated['status'] = 'needs_review' if findings or any(
        task.get('status') == 'open' for task in updated.get('reviewTasks', [])
    ) else 'confirmed'
    return updated, {
        'status': 'failed' if counts['error'] else ('needs_review' if findings else 'passed'),
        'counts': counts, 'networkComponents': len(components), 'unmodeledCrossings': len(crossing_pairs), 'findings': findings,
    }
