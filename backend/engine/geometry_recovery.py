"""Conservative cleanup and recovery using the original raster evidence."""
from collections import defaultdict
import math

import numpy as np


def filter_paper_rules(edges, ink):
    """Keep exceptionally wide horizontal ruling on the review layer."""
    width = ink.shape[1]
    ruling = np.count_nonzero(ink, axis=1) >= width * 0.85
    if not ruling.any():
        return ink
    rows = np.flatnonzero(ruling)
    for edge in edges:
        points = edge.get('geometry', ())
        if len(points) < 2:
            continue
        xs, ys = zip(*points)
        if max(xs) - min(xs) < max(30, width * 0.04) or max(ys) - min(ys) > 3:
            continue
        if np.any((rows >= max(ys) - 2) & (rows <= min(ys) + 2)):
            edge['cad_include'] = False
            edge['cad_reason'] = 'paper-rule-review'
    result = ink.copy()
    result[rows] = 0
    return result


def recover_vertical_connections(nodes, edges, ink, text_mask=None):
    """Connect separate primary routes across a nearly continuous ink stroke."""
    height, width = ink.shape
    coordinates = {node['id']: (node['x'], node['y']) for node in nodes}
    primary = defaultdict(set)
    anchors = set()
    existing = set()
    for edge in edges:
        a, b = edge['from'], edge['to']
        existing.add(frozenset((a, b)))
        if edge.get('cad_include') and a in coordinates and b in coordinates:
            primary[a].add(b)
            primary[b].add(a)
            if math.dist(coordinates[a], coordinates[b]) >= 35:
                anchors.update((a, b))

    components = {}
    for start in primary:
        if start in components:
            continue
        pending = [start]
        while pending:
            node = pending.pop()
            if node not in components:
                components[node] = start
                pending.extend(primary[node])

    candidates = defaultdict(list)
    anchors = sorted(anchors, key=lambda node: coordinates[node][1])
    max_length = min(120, height * 0.15)
    for index, a in enumerate(anchors):
        ax, ay = coordinates[a]
        for b in anchors[index + 1:]:
            bx, by = coordinates[b]
            dy = by - ay
            if dy > max_length:
                break
            if (dy < 35 or abs(bx - ax) > min(9, dy * 0.10)
                    or components[a] == components[b] or frozenset((a, b)) in existing):
                continue
            # A sustained dark column must be visible between the endpoints.
            # Ignore only a short margin at the existing junctions.
            t = np.linspace(0.06, 0.94, max(12, round(dy)))
            xs = np.clip(np.rint(ax + (bx - ax) * t).astype(int), 0, width - 1)
            ys = np.clip(np.rint(ay + dy * t).astype(int), 0, height - 1)
            corridor = np.clip(xs[:, None] + np.arange(-2, 3), 0, width - 1)
            hits = np.any(ink[ys[:, None], corridor] != 0, axis=1)
            support = float(hits.mean())
            gaps = np.diff(np.flatnonzero(np.r_[True, hits, True])) - 1
            if support < 0.96 or gaps.max() > 4:
                continue
            if text_mask is not None and np.count_nonzero(text_mask[ys, xs]) > len(xs) * 0.12:
                continue
            candidates[a].append((b, support))
            candidates[b].append((a, support))

    added = 0
    node_by_id = {node['id']: node for node in nodes}
    for a in anchors:
        if len(candidates[a]) != 1:
            continue
        b, support = candidates[a][0]
        if coordinates[a][1] >= coordinates[b][1] or len(candidates[b]) != 1:
            continue
        if components[a] == components[b]:
            continue
        old_component = components[b]
        for node, component in components.items():
            if component == old_component:
                components[node] = components[a]
        added += 1
        edges.append({
            'id': f'IR{added}', 'from': a, 'to': b,
            'geometry': [list(coordinates[a]), list(coordinates[b])],
            'cad_include': True, 'cad_reason': 'ink-supported-vertical-connection',
            'detector': 'INK', 'source': 'ink-recovery', 'ink_support': round(support, 3),
            'confidence': round(support * 0.85, 3), 'suggested_role': 'pipe',
        })
        for node_id in (a, b):
            node = node_by_id[node_id]
            node['degree'] += 1
            node['review'] = False
    return added
