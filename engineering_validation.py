"""Engineering consistency checks for the editable reconstruction model."""
from __future__ import annotations

from copy import deepcopy
import math
import re
from typing import Any


def validate_engineering_model(model: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    updated = deepcopy(model)
    findings: list[dict[str, Any]] = []

    def add(code: str, severity: str, targets: list[str], message: str) -> None:
        findings.append({"id": f"F{len(findings) + 1}", "code": code, "severity": severity,
                         "targetIds": [item for item in targets if item], "message": message,
                         "status": "open"})

    nodes = {str(item.get('id')): item for item in updated.get('nodes', []) if item.get('id')}
    pipes = [item for item in updated.get('pipes', []) if item.get('state') == 'primary']
    incidence = {node_id: 0 for node_id in nodes}
    adjacency = {node_id: set() for node_id in nodes}
    for pipe in pipes:
        pipe_id = str(pipe.get('id') or '')
        start, end = str(pipe.get('fromNode') or ''), str(pipe.get('toNode') or '')
        geometry = pipe.get('geometry') or []
        length = sum(math.dist(a[:2], b[:2]) for a, b in zip(geometry, geometry[1:]))
        if start == end or length < 1.0:
            add('invalid_pipe_geometry', 'error', [pipe_id], 'Участок имеет нулевую длину или замкнут на один узел.')
        if start in incidence:
            incidence[start] += 1
        if end in incidence:
            incidence[end] += 1
        if start in adjacency and end in adjacency and start != end:
            adjacency[start].add(end)
            adjacency[end].add(start)

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
        'counts': counts, 'networkComponents': len(components), 'findings': findings,
    }
