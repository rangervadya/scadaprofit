"""Topology-preserving clean-sheet layout for confirmed reconstruction data."""
from __future__ import annotations

from copy import deepcopy
import math
from typing import Any

from cad_symbols import symbol_primitives


def build_clean_layout(model: dict[str, Any], page_width: int = 1200, page_height: int = 850,
                       template: dict[str, Any] | None = None) -> tuple[dict[str, Any], dict[str, Any]]:
    nodes = [item for item in model.get('nodes', []) if isinstance(item.get('position'), list)]
    pipes = [item for item in model.get('pipes', []) if item.get('state') == 'primary']
    node_by_id = {str(item.get('id')): item for item in nodes}

    parent_x = {node_id: node_id for node_id in node_by_id}
    parent_y = dict(parent_x)

    def find(parent: dict[str, str], value: str) -> str:
        while parent[value] != value:
            parent[value] = parent[parent[value]]
            value = parent[value]
        return value

    def union(parent: dict[str, str], left: str, right: str) -> None:
        a, b = find(parent, left), find(parent, right)
        if a != b:
            parent[b] = a

    snapped_horizontal = snapped_vertical = 0
    for pipe in pipes:
        start_id, end_id = str(pipe.get('fromNode') or ''), str(pipe.get('toNode') or '')
        if start_id not in node_by_id or end_id not in node_by_id:
            continue
        a, b = node_by_id[start_id]['position'], node_by_id[end_id]['position']
        dx, dy = float(b[0]) - float(a[0]), float(b[1]) - float(a[1])
        angle = abs(math.degrees(math.atan2(dy, dx))) % 180
        if min(angle, 180 - angle) <= 12:
            union(parent_y, start_id, end_id)
            snapped_horizontal += 1
        elif abs(angle - 90) <= 12:
            union(parent_x, start_id, end_id)
            snapped_vertical += 1

    adjusted = {node_id: [float(node['position'][0]), float(node['position'][1])] for node_id, node in node_by_id.items()}
    for axis, parent in ((0, parent_x), (1, parent_y)):
        groups: dict[str, list[str]] = {}
        for node_id in node_by_id:
            groups.setdefault(find(parent, node_id), []).append(node_id)
        for members in groups.values():
            average = sum(adjusted[node_id][axis] for node_id in members) / len(members)
            for node_id in members:
                adjusted[node_id][axis] = average

    source_points = list(adjusted.values())
    for pipe in pipes:
        source_points.extend([[float(p[0]), float(p[1])] for p in pipe.get('geometry', [])[1:-1]])
    if not source_points:
        source_points = [[0.0, 0.0], [1.0, 1.0]]
    min_x, max_x = min(p[0] for p in source_points), max(p[0] for p in source_points)
    min_y, max_y = min(p[1] for p in source_points), max(p[1] for p in source_points)
    main_zone = (template or {}).get('zones', {}).get('mainNetwork') or {}
    drawing = {'x': float(main_zone.get('x', 70.0)), 'y': float(main_zone.get('y', 115.0)),
               'w': float(main_zone.get('w', page_width - 140.0)), 'h': float(main_zone.get('h', page_height - 205.0))}
    scale = min(drawing['w'] / max(1.0, max_x - min_x), drawing['h'] / max(1.0, max_y - min_y))
    offset_x = drawing['x'] + (drawing['w'] - (max_x - min_x) * scale) / 2.0
    offset_y = drawing['y'] + (drawing['h'] - (max_y - min_y) * scale) / 2.0

    def transform(point: list[float]) -> list[float]:
        return [round(offset_x + (float(point[0]) - min_x) * scale, 2),
                round(offset_y + (float(point[1]) - min_y) * scale, 2)]

    layout_nodes = [{**deepcopy(node), 'position': transform(adjusted[str(node['id'])])} for node in nodes]
    layout_node_by_id = {str(item['id']): item for item in layout_nodes}
    layout_pipes = []
    for pipe in pipes:
        geometry = [transform(point) for point in pipe.get('geometry', [])]
        start, end = layout_node_by_id.get(str(pipe.get('fromNode'))), layout_node_by_id.get(str(pipe.get('toNode')))
        if geometry and start:
            geometry[0] = list(start['position'])
        if geometry and end:
            geometry[-1] = list(end['position'])
        layout_pipes.append({**deepcopy(pipe), 'geometry': geometry})

    def map_box(box: dict[str, Any]) -> dict[str, float]:
        top_left = transform([float(box.get('x', 0)), float(box.get('y', 0))])
        return {'x': top_left[0], 'y': top_left[1],
                'w': round(max(8.0, float(box.get('w', 0)) * scale), 2),
                'h': round(max(8.0, float(box.get('h', 0)) * scale), 2)}

    layout_symbols = []
    for item in model.get('symbols', []):
        if item.get('state') != 'primary':
            continue
        layout_symbol = {**deepcopy(item), 'bbox': map_box(item.get('bbox') or {})}
        layout_symbol['primitives'] = symbol_primitives(layout_symbol)
        layout_symbols.append(layout_symbol)
    pipe_by_id = {str(item.get('id')): item for item in layout_pipes}
    symbol_by_id = {str(item.get('id')): item for item in layout_symbols}

    def midpoint(target_id: str) -> list[float] | None:
        pipe = pipe_by_id.get(target_id)
        if pipe and pipe.get('geometry'):
            geometry = pipe['geometry']
            return list(geometry[len(geometry) // 2])
        symbol = symbol_by_id.get(target_id)
        if symbol:
            box = symbol['bbox']
            return [box['x'] + box['w'] / 2, box['y'] + box['h'] / 2]
        return None

    occupied: list[tuple[float, float, float, float]] = []
    offsets = [(8, -20), (8, 12), (-55, -20), (18, 0), (-65, 8)]
    layout_labels = []
    for label in model.get('labels', []):
        if label.get('role') == 'dimension_value' or label.get('state') == 'rejected':
            continue
        anchor = midpoint(str(label.get('targetId') or ''))
        if anchor is None:
            box = label.get('bbox') or {}
            center = [float(box.get('x', 0)) + float(box.get('w', 0)) / 2,
                      float(box.get('y', 0)) + float(box.get('h', 0)) / 2]
            anchor = transform(center)
        width = max(34.0, min(180.0, len(str(label.get('text') or '')) * 6.2))
        height = 15.0
        chosen = None
        for dx, dy in offsets:
            candidate = (anchor[0] + dx, anchor[1] + dy, width, height)
            if not any(candidate[0] < x + w and candidate[0] + width > x and candidate[1] < y + h and candidate[1] + height > y for x, y, w, h in occupied):
                chosen = candidate
                break
        chosen = chosen or (anchor[0] + 8, anchor[1] - 20, width, height)
        occupied.append(chosen)
        layout_labels.append({**deepcopy(label), 'position': [round(chosen[0], 2), round(chosen[1] + 12, 2)]})

    layout_dimensions = []
    for dimension in model.get('dimensions', []):
        anchor = midpoint(str(dimension.get('targetId') or ''))
        if dimension.get('state') != 'primary' or anchor is None:
            continue
        layout_dimensions.append({**deepcopy(dimension), 'position': [round(anchor[0], 2), round(anchor[1] - 18, 2)]})

    layout = {'schema': 'cad-clean-layout/1.0', 'page': {'width': page_width, 'height': page_height},
              'template': deepcopy(template) if template else None,
              'drawingArea': drawing, 'nodes': layout_nodes, 'pipes': layout_pipes,
              'symbols': layout_symbols, 'dimensions': layout_dimensions, 'labels': layout_labels}
    return layout, {'scale': round(scale, 5), 'snappedHorizontalPipes': snapped_horizontal,
                    'snappedVerticalPipes': snapped_vertical, 'placedLabels': len(layout_labels),
                    'placedDimensions': len(layout_dimensions)}
