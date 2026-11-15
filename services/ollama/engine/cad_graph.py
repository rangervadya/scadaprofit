"""CAD graph construction (P2-1).

Moved from processor.py verbatim: primary edge selection, crossing detection,
semantic route validation and join candidates. Pure functions over graph data.
"""

from __future__ import annotations

import math
from typing import Any

import cv2
import numpy as np
from segment_geometry import _sample_line_support, _segment_text_mask_metrics


def select_primary_cad_edges(nodes: list[dict[str, Any]], edges: list[dict[str, Any]],
                             min_dimension: int, image_size: tuple[int, int] | None = None) -> dict[str, int]:
    """Select coherent route paths for the clean CAD sheet.

    The detector graph deliberately keeps every reviewable segment.  The clean
    export, however, must not turn every valve mark, arrow, letter stroke or
    dimension tick into a pipe.  We therefore classify maximal paths between
    graph junctions/terminals, rather than promoting an entire connected
    component because one edge in it is long.

    A short path is retained when it is a near-collinear continuation through a
    junction.  Short terminal stubs at junctions and isolated marks are left on
    the review layer.  No endpoints are moved and no junctions are auto-joined.
    """
    adjacency: dict[str, list[int]] = {}
    node_by_id = {str(node.get('id')): node for node in nodes}
    for index, edge in enumerate(edges):
        a, b = str(edge.get('from', '')), str(edge.get('to', ''))
        if not a or not b or a == b:
            edge['cad_include'] = False
            edge['cad_reason'] = 'invalid-edge'
            continue
        adjacency.setdefault(a, []).append(index)
        adjacency.setdefault(b, []).append(index)

    component_sizes: dict[str, int] = {}
    for edge in edges:
        cid = str(edge.get('component_id') or '')
        component_sizes[cid] = component_sizes.get(cid, 0) + 1

    min_path = max(14.0, float(min_dimension) * 0.016)
    junction_stub = max(min_path, float(min_dimension) * 0.032)
    cycle_min = max(34.0, float(min_dimension) * 0.042)
    visited: set[int] = set()
    paths: list[dict[str, Any]] = []

    def other_node(edge_index: int, node_id: str) -> str:
        edge = edges[edge_index]
        return str(edge.get('to') if str(edge.get('from')) == node_id else edge.get('from'))

    def edge_length(edge: dict[str, Any]) -> float:
        geometry = edge.get('geometry') or []
        if len(geometry) < 2:
            return 0.0
        return sum(math.dist(geometry[i], geometry[i + 1]) for i in range(len(geometry) - 1))

    def trace(start_node: str, first_index: int) -> dict[str, Any]:
        current = start_node
        edge_index = first_index
        path_edges: list[int] = []
        total = 0.0
        closed = False
        terminal = start_node
        while edge_index not in visited:
            visited.add(edge_index)
            edge = edges[edge_index]
            path_edges.append(edge_index)
            total += edge_length(edge)
            nxt = other_node(edge_index, current)
            terminal = nxt
            if nxt == start_node:
                closed = True
                break
            incident = adjacency.get(nxt, [])
            if len(incident) != 2:
                break
            next_options = [idx for idx in incident if idx not in visited]
            if not next_options:
                break
            current, edge_index = nxt, next_options[0]
        return {
            'edges': path_edges, 'start': start_node, 'end': terminal,
            'length': total, 'closed': closed,
        }

    # Begin at terminals and junctions.  Degree-two nodes are transparent and
    # therefore do not break a route into detector-sized fragments.
    for node_id, incident in adjacency.items():
        if len(incident) == 2:
            continue
        for edge_index in incident:
            if edge_index not in visited:
                paths.append(trace(node_id, edge_index))

    # Remaining all-degree-two components are closed loops.
    for edge_index, edge in enumerate(edges):
        if edge_index not in visited:
            paths.append(trace(str(edge.get('from')), edge_index))

    def outward_vector(node_id: str, edge_index: int) -> tuple[float, float] | None:
        edge = edges[edge_index]
        geometry = edge.get('geometry') or []
        if len(geometry) < 2:
            return None
        if str(edge.get('from')) == node_id:
            a, b = geometry[0], geometry[1]
        else:
            a, b = geometry[-1], geometry[-2]
        vector = (float(b[0]) - float(a[0]), float(b[1]) - float(a[1]))
        length = math.hypot(*vector)
        return (vector[0] / length, vector[1] / length) if length > 1e-6 else None

    def has_opposite_continuation(path: dict[str, Any], node_id: str, path_edge: int) -> bool:
        """Does a short path continue nearly straight through this junction?"""
        current = outward_vector(node_id, path_edge)
        if current is None:
            return False
        for candidate_index in adjacency.get(node_id, []):
            if candidate_index == path_edge:
                continue
            candidate = outward_vector(node_id, candidate_index)
            if candidate is None:
                continue
            # Vectors both point out from the junction; opposite means a
            # straight-through route (within about 27 degrees).
            if current[0] * candidate[0] + current[1] * candidate[1] <= -0.89:
                return True
        return False

    for path in paths:
        path_edges = path['edges']
        if not path_edges:
            continue
        start, end = path['start'], path['end']
        start_degree = len(adjacency.get(start, []))
        end_degree = len(adjacency.get(end, []))
        total = float(path['length'])
        is_cycle = bool(path['closed'] or start == end)
        component_ids = {str(edges[index].get('component_id') or '') for index in path_edges}
        component_size = max((component_sizes.get(cid, 0) for cid in component_ids), default=len(path_edges))
        single_edge_isolated = len(path_edges) == 1 and component_size == 1 and start_degree == 1 and end_degree == 1
        path_roles = {str(edges[index].get('component_role') or 'line_structure') for index in path_edges}
        has_text_role = 'text_or_annotation' in path_roles
        has_ambiguous_role = 'ambiguous' in path_roles

        continuation = False
        if start_degree >= 3:
            continuation = continuation or has_opposite_continuation(path, start, path_edges[0])
        if end_degree >= 3:
            continuation = continuation or has_opposite_continuation(path, end, path_edges[-1])

        if has_text_role:
            keep = False
            reason = 'text-or-annotation'
        elif has_ambiguous_role and not single_edge_isolated:
            # A component may be ambiguous only because a hand-drawn pipe was
            # fragmented by LSD/Hough. Promote it when the individual path is
            # still a connected multi-edge route with adequate ink support and
            # little OCR overlap. Dense text/symbol clusters remain review-only.
            path_edges_data = [edges[index] for index in path_edges]
            path_points = [point for edge in path_edges_data for point in (edge.get('geometry') or [])]
            path_x = [point[0] for point in path_points]
            path_y = [point[1] for point in path_points]
            path_extent = max(max(path_x) - min(path_x), max(path_y) - min(path_y)) if path_points else 0.0
            path_support = float(np.mean([edge.get('ink_support', 0.0) for edge in path_edges_data])) if path_edges_data else 0.0
            path_overlap = max((float(edge.get('ocr_overlap', 0.0)) for edge in path_edges_data), default=0.0)
            path_turns = 0
            for left_edge, right_edge in zip(path_edges_data, path_edges_data[1:]):
                ga, gb = left_edge.get('geometry') or [], right_edge.get('geometry') or []
                if len(ga) >= 2 and len(gb) >= 2:
                    va = np.array(ga[-1], dtype=float) - np.array(ga[0], dtype=float)
                    vb = np.array(gb[-1], dtype=float) - np.array(gb[0], dtype=float)
                    na, nb = np.linalg.norm(va), np.linalg.norm(vb)
                    if na > 0 and nb > 0 and abs(float(np.dot(va/na, vb/nb))) < 0.90:
                        path_turns += 1
            ambiguous_route_candidate = (
                len(path_edges) >= 2 and total >= max(24.0, float(min_dimension) * 0.027)
                and path_extent >= max(18.0, float(min_dimension) * 0.020)
                and path_support >= 0.27 and path_overlap < 0.16
                and path_turns <= 7 and max(start_degree, end_degree) <= 5
            )
            keep = ambiguous_route_candidate
            reason = 'ambiguous-but-connected-route' if keep else 'ambiguous-component'

        elif is_cycle:
            keep = total >= cycle_min
            reason = 'closed-route' if keep else 'short-closed-mark'
        elif single_edge_isolated:
            # A solitary long stroke is indistinguishable from a dimension line,
            # arrow shaft or handwritten flourish without topology evidence.
            # Preserve it for review rather than manufacturing a pipe.
            keep = False
            reason = 'isolated-stroke-review'
        elif (start_degree >= 3 and end_degree == 1) or (end_degree >= 3 and start_degree == 1):
            # Short real branches often terminate at a fitting or continue as
            # a faint hand-drawn line. Admit them only when attached to a
            # multi-edge component already classified as pipe-like and their
            # own source ink is strong; isolated valve/arrow ticks remain review.
            edge_support = min((float(edges[index].get('ink_support', 0.0)) for index in path_edges), default=0.0)
            edge_overlap = max((float(edges[index].get('ocr_overlap', 0.0)) for index in path_edges), default=1.0)
            has_text_crossing = any(edges[index].get('text_crossing') for index in path_edges)
            supported_branch = (
                total >= max(14.0, float(min_dimension) * 0.016)
                and component_size >= 3
                and path_roles == {'line_structure'}
                and edge_support >= 0.30
                and edge_overlap < 0.10
                and not has_text_crossing
            )
            keep = total >= junction_stub or (continuation and total >= min_path) or supported_branch
            reason = ('supported-short-branch' if supported_branch and total < junction_stub
                      else ('branch-route' if keep else 'short-symbol-stub'))
        else:
            keep = total >= min_path
            reason = 'coherent-route' if keep else 'short-fragment'

        if continuation and total >= min_path and not has_text_role:
            keep = True
            reason = 'collinear-continuation'

        # The earlier endpoint heuristic can explicitly identify a short
        # detached, coaxial continuation across a small scan gap. Preserve it.
        if any(edges[index].get('continuation_candidate') for index in path_edges) and total >= 8.0 and not has_text_role:
            keep = True
            reason = 'collinear-continuation'

        for index in path_edges:
            edges[index]['cad_include'] = bool(keep)
            edges[index]['cad_reason'] = reason

    # A long isolated detection can be a real trunk split at fittings/OCR
    # masks. Recover only ink-backed strokes with nearby primary geometry at
    # BOTH ends and a straight continuation at at least one end. This changes
    # selection only: gaps and node identities remain untouched for review.
    selected_edges = [edge for edge in edges if edge.get('cad_include')]
    gap_limit = max(4.0, min(12.0, float(min_dimension) * 0.014))
    for edge in edges:
        if edge.get('cad_reason') != 'isolated-stroke-review':
            continue
        geometry = edge.get('geometry') or []
        if len(geometry) < 2 or float(edge.get('ink_support', 0)) < 0.90:
            continue
        if float(edge.get('ocr_overlap', 0)) >= 0.20:
            continue
        first, last = geometry[0], geometry[-1]
        length = math.dist(first, last)
        if length < max(80.0, float(min_dimension) * 0.12):
            continue
        supported_ends = 0
        aligned = False
        for point, inside in ((first, geometry[1]), (last, geometry[-2])):
            dx, dy = inside[0] - point[0], inside[1] - point[1]
            norm = math.hypot(dx, dy)
            neighbors = []
            for candidate in selected_edges:
                route = candidate.get('geometry') or []
                if len(route) < 2:
                    continue
                for tip, next_point in ((route[0], route[1]), (route[-1], route[-2])):
                    if math.dist(point, tip) > gap_limit:
                        continue
                    neighbors.append(candidate)
                    vx, vy = next_point[0] - tip[0], next_point[1] - tip[1]
                    other_norm = math.hypot(vx, vy)
                    if norm > 0 and other_norm > 0 and (dx * vx + dy * vy) / (norm * other_norm) <= -0.94:
                        aligned = True
            supported_ends += bool(neighbors)
        if supported_ends == 2 and aligned:
            edge['cad_include'] = True
            edge['cad_reason'] = 'supported-trunk-fragment'

    # Scanner/photo borders are not gas pipes. Keep them reviewable, but do
    # not let even a connected long border become primary network geometry.
    if image_size is not None:
        image_width, image_height = image_size
        margin = max(2.0, min(image_width, image_height) * 0.004)
        for edge in edges:
            points = edge.get('geometry') or []
            if len(points) < 2:
                continue
            xs = [float(point[0]) for point in points]
            ys = [float(point[1]) for point in points]
            along_vertical_border = (
                (max(xs) <= margin or min(xs) >= image_width - 1 - margin)
                and max(ys) - min(ys) >= max(20.0, image_height * 0.03)
            )
            along_horizontal_border = (
                (max(ys) <= margin or min(ys) >= image_height - 1 - margin)
                and max(xs) - min(xs) >= max(20.0, image_width * 0.03)
            )
            if along_vertical_border or along_horizontal_border:
                edge['cad_include'] = False
                edge['cad_reason'] = 'image-border-review'

    # Defensive default for malformed/disconnected records.
    for edge in edges:
        edge.setdefault('cad_include', False)
        edge.setdefault('cad_reason', 'unclassified')

    selected = sum(1 for edge in edges if edge.get('cad_include'))
    reason_counts: dict[str, int] = {}
    for edge in edges:
        reason = str(edge.get('cad_reason', 'unclassified'))
        reason_counts[reason] = reason_counts.get(reason, 0) + 1
    return {
        'cad_primary_edges': selected,
        'cad_review_edges': len(edges) - selected,
        'cad_primary_paths': sum(1 for path in paths if path['edges'] and all(edges[i].get('cad_include') for i in path['edges'])),
        'cad_selection_reasons': reason_counts,
        'cad_min_path_px': int(round(min_path)),
        'cad_min_junction_branch_px': int(round(junction_stub)),
    }


def detect_crossings(segments: list[dict[str,Any]], max_crossings=250):
    crossings=[]
    def cross(a,b):
        x1,y1,x2,y2=a['x1'],a['y1'],a['x2'],a['y2']; x3,y3,x4,y4=b['x1'],b['y1'],b['x2'],b['y2']
        den=(x1-x2)*(y3-y4)-(y1-y2)*(x3-x4)
        if abs(den)<1e-6:return None
        t=((x1-x3)*(y3-y4)-(y1-y3)*(x3-x4))/den
        u=-((x1-x2)*(y1-y3)-(y1-y2)*(x1-x3))/den
        if 0.03<t<0.97 and 0.03<u<0.97:
            return (x1+t*(x2-x1), y1+t*(y2-y1))
        return None
    # spatially broad but bounded pair list
    for i,a in enumerate(segments):
        if len(crossings)>=max_crossings: break
        for j in range(i+1,min(len(segments),i+100)):
            b=segments[j]
            if abs(((a['angle']-b['angle']+90)%180)-90)<18: continue
            p=cross(a,b)
            if p: crossings.append({"id":f"X{len(crossings)+1}","x":round(p[0],1),"y":round(p[1],1),
                                    "segments":[i+1,j+1],"status":"needs_review",
                                    "message":"Пересечение не считается соединением автоматически"})
    return crossings


def _point_to_segment_distance(point: tuple[float, float], a: list[float], b: list[float]) -> float:
    px, py = point
    dx, dy = float(b[0]) - float(a[0]), float(b[1]) - float(a[1])
    length_sq = dx * dx + dy * dy
    if length_sq <= 1e-9:
        return math.hypot(px - float(a[0]), py - float(a[1]))
    t = max(0.0, min(1.0, ((px - float(a[0])) * dx + (py - float(a[1])) * dy) / length_sq))
    return math.hypot(px - (float(a[0]) + t * dx), py - (float(a[1]) + t * dy))


def validate_primary_semantic_routes(semantic_routes: list[dict[str, Any]] | None,
                                     ink: np.ndarray, text_mask: np.ndarray,
                                     primary_edges: list[dict[str, Any]],
                                     min_dimension: int) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Validate Qwen route segments independently against source ink and OCR masks.

    Earlier builds rejected an entire polyline when one of its segments touched
    an OCR box, and required 30% sampled-pixel coverage with a 7x7 halo. That
    discarded good pipe routes near faint pencil strokes and labels. This
    version validates each segment separately, uses a moderate 9x9 support halo,
    and drops only the text-crossing segment; other verified portions survive.
    """
    h, w = ink.shape[:2]
    ink_dilated = cv2.dilate(ink, np.ones((9, 9), np.uint8), iterations=1)
    graph_segments = []
    for edge in primary_edges:
        edge_points = edge.get('geometry') or []
        for a, b in zip(edge_points, edge_points[1:]):
            graph_segments.append((a, b))
    accepted: list[dict[str, Any]] = []
    reasons: dict[str, int] = {}
    route_diagnostics: list[dict[str, Any]] = []
    min_length = max(16.0, float(min_dimension) * 0.010)
    min_piece_length = max(9.0, float(min_dimension) * 0.006)

    def bump(reason: str) -> None:
        reasons[reason] = reasons.get(reason, 0) + 1

    def duplicate_ratio_for(points: list[list[float]]) -> float:
        samples: list[tuple[float, float]] = []
        for a, b in zip(points, points[1:]):
            length = math.dist(a, b)
            count = max(2, int(length / 4.0) + 1)
            samples.extend((a[0] + (b[0]-a[0])*t, a[1] + (b[1]-a[1])*t)
                           for t in np.linspace(0.0, 1.0, count))
        if not graph_segments or not samples:
            return 0.0
        hits = sum(1 for point in samples if any(
            _point_to_segment_distance(point, a, b) <= 5.5 for a, b in graph_segments
        ))
        return hits / len(samples)

    for index, route in enumerate(semantic_routes or []):
        diag: dict[str, Any] = {'id': str(route.get('id') or f'Q{index+1}') if isinstance(route, dict) else f'Q{index+1}'}
        if not isinstance(route, dict) or route.get('include') is False:
            bump('not-included')
            diag.update({'decision': 'reject', 'reason': 'not-included'})
            route_diagnostics.append(diag)
            continue
        try:
            confidence = float(route.get('confidence', 60))
        except (TypeError, ValueError):
            confidence = 0.0
        if confidence < 35:
            bump('low-confidence')
            diag.update({'decision': 'reject', 'reason': 'low-confidence'})
            route_diagnostics.append(diag)
            continue
        raw_points = route.get('points')
        if not isinstance(raw_points, list) or len(raw_points) < 2:
            bump('invalid-points')
            diag.update({'decision': 'reject', 'reason': 'invalid-points'})
            route_diagnostics.append(diag)
            continue
        points: list[list[float]] = []
        valid_bounds = True
        for raw in raw_points[:64]:
            try:
                x, y = float(raw[0]), float(raw[1])
            except (TypeError, ValueError, IndexError):
                valid_bounds = False
                break
            if not math.isfinite(x) or not math.isfinite(y) or x < -2 or y < -2 or x > w + 2 or y > h + 2:
                valid_bounds = False
                break
            point = [max(0.0, min(w - 1.0, x)), max(0.0, min(h - 1.0, y))]
            if not points or math.dist(points[-1], point) >= 2.0:
                points.append(point)
        if not valid_bounds or len(points) < 2:
            bump('invalid-bounds')
            diag.update({'decision': 'reject', 'reason': 'invalid-bounds'})
            route_diagnostics.append(diag)
            continue

        kept_fragments: list[list[list[float]]] = []
        current: list[list[float]] = []
        support_by_fragment: list[list[float]] = []
        text_by_fragment: list[list[float]] = []
        rejected_segment_reasons: list[str] = []
        for a, b in zip(points, points[1:]):
            length = math.dist(a, b)
            if length < min_piece_length:
                if len(current) >= 2:
                    kept_fragments.append(current); current = []
                rejected_segment_reasons.append('short-segment')
                continue
            overlap, through = _segment_text_mask_metrics((a[0], a[1], b[0], b[1]), text_mask, ink_dilated)
            support = _sample_line_support(ink_dilated, a[0], a[1], b[0], b[1])
            # Segments mostly inside an OCR region are text strokes unless a
            # strong two-sided continuation demonstrates an actual pipe.
            if overlap >= 0.08 and not through:
                if len(current) >= 2:
                    kept_fragments.append(current); current = []
                rejected_segment_reasons.append('text-overlap')
                continue
            # Model confidence cannot substitute for visible ink along the route.
            support_floor = 0.70
            if support < support_floor:
                if len(current) >= 2:
                    kept_fragments.append(current); current = []
                rejected_segment_reasons.append('weak-source-ink')
                continue
            if current and math.dist(current[-1], a) <= 2.5:
                current.append(b)
            else:
                if len(current) >= 2:
                    kept_fragments.append(current)
                current = [a, b]
            support_by_fragment.append([support * length, length])
            text_by_fragment.append([overlap * length, length])
        if len(current) >= 2:
            kept_fragments.append(current)

        promoted_for_route = 0
        fragment_diagnostics = []
        for frag_index, fragment in enumerate(kept_fragments, 1):
            length = sum(math.dist(a, b) for a, b in zip(fragment, fragment[1:]))
            if length < min_length:
                bump('short-after-filter')
                continue
            fragment_support_sum = 0.0
            fragment_text_sum = 0.0
            for fa, fb in zip(fragment, fragment[1:]):
                flen = math.dist(fa, fb)
                fsupport = _sample_line_support(ink_dilated, fa[0], fa[1], fb[0], fb[1])
                foverlap, _fthrough = _segment_text_mask_metrics((fa[0], fa[1], fb[0], fb[1]), text_mask, ink_dilated)
                fragment_support_sum += fsupport * flen
                fragment_text_sum += foverlap * flen
            support = fragment_support_sum / max(length, 1.0)
            text_ratio = fragment_text_sum / max(length, 1.0)
            duplicate = duplicate_ratio_for(fragment)
            # Only remove near-exact duplicates. Qwen often supplies a longer
            # or more continuous centreline than the detector graph.
            if duplicate >= 0.90:
                bump('opencv-duplicate')
                fragment_diagnostics.append({'length': round(length, 1), 'support': round(support, 3),
                                             'duplicate': round(duplicate, 3), 'decision': 'duplicate'})
                continue
            accepted.append({
                'id': str(route.get('id') or f'QPRIMARY{index+1}') + (f'_{frag_index}' if len(kept_fragments) > 1 else ''),
                'points': fragment, 'confidence': confidence,
                'ink_support': round(support, 3),
                'text_overlap': round(text_ratio, 3),
                'opencv_duplicate_ratio': round(duplicate, 3),
                'include': True, 'source': 'qwen3-vl-validated',
                'split_from_text_or_weak_segment': bool(rejected_segment_reasons),
            })
            promoted_for_route += 1
            fragment_diagnostics.append({'length': round(length, 1), 'support': round(support, 3),
                                         'text_overlap': round(text_ratio, 3),
                                         'duplicate': round(duplicate, 3), 'decision': 'accept'})
        if promoted_for_route:
            bump('accepted')
            decision, reason = 'accept', 'ink-supported-fragment'
        else:
            for reason_item in rejected_segment_reasons:
                bump(reason_item)
            decision = 'reject'
            reason = rejected_segment_reasons[0] if rejected_segment_reasons else 'no-valid-fragment'
        diag.update({'decision': decision, 'reason': reason,
                     'rejected_segments': rejected_segment_reasons,
                     'accepted_fragments': promoted_for_route,
                     'fragments': fragment_diagnostics})
        route_diagnostics.append(diag)

    return accepted, {
        'candidate_routes': len(semantic_routes or []),
        'accepted_routes': len(accepted),
        'accepted_source_routes': reasons.get('accepted', 0),
        'reasons': reasons,
        'min_length_px': round(min_length, 1),
        'minimum_ink_support': 0.70,
        'ink_support_kernel': '9x9',
        'route_diagnostics': route_diagnostics,
    }


def _build_join_candidates(nodes: list[dict[str, Any]], edges: list[dict[str, Any]],
                           min_gap: float = 4.5, max_gap: float = 45.0,
                           image_size: tuple[int, int] | None = None) -> list[dict[str, Any]]:
    """Return review-only endpoint continuation proposals.

    Unlike the former implementation, this diagnostic considers both
    ``line_structure`` and ``ambiguous`` components and does not discard a
    short detector fragment solely because its length is below 25 px. A
    proposal is never auto-joined: the UI requires an explicit user action.
    Text/annotation components are excluded, competing matches are flagged,
    and candidates near the image border or OCR regions remain review-only.
    """
    node_by_id = {str(node.get('id')): node for node in nodes}
    edge_at: dict[str, dict[str, Any]] = {}
    allowed_roles = {'line_structure', 'ambiguous'}
    for edge in edges:
        role = str(edge.get('component_role') or 'ambiguous')
        reason = str(edge.get('cad_reason') or '')
        if role not in allowed_roles or reason == 'text-or-annotation':
            continue
        for node_id in (str(edge.get('from', '')), str(edge.get('to', ''))):
            if node_id and node_id not in edge_at:
                edge_at[node_id] = edge

    def polyline_length(geometry: list[list[float]]) -> float:
        return sum(math.dist(a, b) for a, b in zip(geometry, geometry[1:]))

    def endpoint_geometry(node_id: str, edge: dict[str, Any]):
        geometry = edge.get('geometry') or []
        if len(geometry) < 2:
            return None
        if str(edge.get('from')) == node_id:
            endpoint = geometry[0]
            inner_points = geometry[1:]
        elif str(edge.get('to')) == node_id:
            endpoint = geometry[-1]
            inner_points = list(reversed(geometry[:-1]))
        else:
            return None
        endpoint_array = np.array(endpoint, dtype=float)
        inner = None
        for candidate in inner_points:
            candidate_array = np.array(candidate, dtype=float)
            if float(np.linalg.norm(candidate_array - endpoint_array)) >= 2.0:
                inner = candidate_array
                break
        if inner is None:
            return None
        vector = inner - endpoint_array
        norm = float(np.linalg.norm(vector))
        if norm < 1.0:
            return None
        return endpoint_array, vector / norm, geometry, polyline_length(geometry)

    def endpoint_hits_polyline(point: np.ndarray, geometry: list[list[float]],
                               tolerance: float = 4.0) -> bool:
        for a_raw, b_raw in zip(geometry, geometry[1:]):
            a = np.array(a_raw, dtype=float)
            b = np.array(b_raw, dtype=float)
            delta = b - a
            length_sq = float(np.dot(delta, delta))
            if length_sq < 1e-8:
                continue
            t = float(np.dot(point - a, delta) / length_sq)
            if not 0.04 < t < 0.96:
                continue
            projection = a + t * delta
            if float(np.linalg.norm(point - projection)) <= tolerance:
                return True
        return False

    open_nodes = [node for node in nodes
                  if int(node.get('degree', 0)) == 1 and str(node.get('id')) in edge_at]
    endpoints = []
    for node in open_nodes:
        node_id = str(node['id'])
        edge = edge_at[node_id]
        geometry = endpoint_geometry(node_id, edge)
        if geometry is None:
            continue
        point, inward, edge_geometry, edge_length = geometry
        # Suppress tiny OCR ticks and detector noise; short pipe fragments
        # (e.g. 14-24 px) remain eligible for review.
        if edge_length < 8.0:
            continue
        endpoints.append({
            'node_id': node_id,
            'edge': edge,
            'point': point,
            'inward': inward,
            'geometry': edge_geometry,
            'length': edge_length,
            'role': str(edge.get('component_role') or 'ambiguous'),
            'reason': str(edge.get('cad_reason') or ''),
            'ink_support': float(edge.get('ink_support', 0.0) or 0.0),
            'ocr_overlap': float(edge.get('ocr_overlap', 0.0) or 0.0),
            'text_crossing': bool(edge.get('text_crossing')),
        })

    raw_candidates: list[dict[str, Any]] = []
    width = int(image_size[0]) if image_size else None
    height = int(image_size[1]) if image_size else None
    for index, a in enumerate(endpoints):
        edge_a = a['edge']
        for b in endpoints[index + 1:]:
            edge_b = b['edge']
            if str(edge_a.get('id')) == str(edge_b.get('id')):
                continue
            component_a = str(edge_a.get('component_id') or '')
            component_b = str(edge_b.get('component_id') or '')
            if component_a and component_a == component_b:
                continue

            gap = b['point'] - a['point']
            distance = float(np.linalg.norm(gap))
            if distance < min_gap or distance > max_gap or distance < 1e-6:
                continue
            gap_unit = gap / distance
            inward_a = a['inward']
            inward_b = b['inward']

            # Do not suggest endpoint-to-interior joins, including bent
            # polylines whose intermediate segment passes through the gap.
            if endpoint_hits_polyline(b['point'], a['geometry']) or endpoint_hits_polyline(a['point'], b['geometry']):
                continue

            dot_a = float(np.dot(inward_a, gap_unit))
            dot_b = float(np.dot(inward_b, -gap_unit))
            lateral_a = abs(float(inward_a[0] * gap_unit[1] - inward_a[1] * gap_unit[0])) * distance
            lateral_b = abs(float(inward_b[0] * gap_unit[1] - inward_b[1] * gap_unit[0])) * distance
            tangent_dot = float(np.dot(inward_a, inward_b))
            lateral = max(lateral_a, lateral_b)
            alignment = min(-dot_a, -dot_b)
            if dot_a > -0.82 or dot_b > -0.82 or tangent_dot > -0.85:
                continue
            if lateral > 8.0:
                continue

            near_border = bool(width and height and any(
                min(point[0], point[1], width - point[0], height - point[1]) < 5.0
                for point in (a['point'], b['point'])
            ))
            min_ink = min(a['ink_support'], b['ink_support'])
            max_ocr = max(a['ocr_overlap'], b['ocr_overlap'])
            flags = []
            if a['role'] == 'ambiguous' or b['role'] == 'ambiguous':
                flags.append('ambiguous_component')
            if min(a['length'], b['length']) < 25.0:
                flags.append('short_fragment')
            if distance > 28.0:
                flags.append('gap_over_28px')
            if lateral > 4.5:
                flags.append('lateral_offset')
            if max_ocr >= 0.15:
                flags.append('ocr_overlap')
            if a['text_crossing'] or b['text_crossing']:
                flags.append('text_crossing')
            if near_border:
                flags.append('near_image_border')

            # This is a ranking aid, not a probability. Geometry, source ink,
            # and OCR proximity are kept visible for human review.
            ink_score = min(1.0, min_ink / 0.65)
            score = 100.0 * (
                0.38 * max(0.0, min(1.0, alignment)) +
                0.24 * max(0.0, min(1.0, -tangent_dot)) +
                0.18 * max(0.0, 1.0 - lateral / 8.0) +
                0.20 * ink_score
            )
            high_priority = (
                a['role'] == 'line_structure' and b['role'] == 'line_structure' and
                min_ink >= 0.50 and max_ocr < 0.15 and
                not a['text_crossing'] and not b['text_crossing'] and
                not near_border and distance <= 20.0 and lateral <= 4.5 and
                alignment >= 0.92 and tangent_dot <= -0.94
            )
            raw_candidates.append({
                'from': a['node_id'], 'to': b['node_id'],
                'from_edge': str(edge_a.get('id')), 'to_edge': str(edge_b.get('id')),
                'from_component': component_a, 'to_component': component_b,
                'from_role': a['role'], 'to_role': b['role'],
                'from_reason': a['reason'], 'to_reason': b['reason'],
                'distance': round(distance, 1),
                'lateral_offset_px': round(lateral, 1),
                'alignment': round(alignment, 3),
                'tangent_alignment': round(-tangent_dot, 3),
                'from_edge_length': round(a['length'], 1),
                'to_edge_length': round(b['length'], 1),
                'from_ink_support': round(a['ink_support'], 3),
                'to_ink_support': round(b['ink_support'], 3),
                'from_ocr_overlap': round(a['ocr_overlap'], 3),
                'to_ocr_overlap': round(b['ocr_overlap'], 3),
                'review_flags': flags,
                'near_image_border': near_border,
                'score': round(score, 1),
                'priority': 'high' if high_priority else 'review',
                'status': 'needs_review',
                'message': ('Геометрически сильный кандидат; перед добавлением проверь исходный чертёж.'
                            if high_priority else
                            'Неоднозначный кандидат; требуется визуальная проверка перед соединением.'),
            })

    # One terminal may have several plausible partners. Keep the alternatives
    # but mark every affected candidate so the UI cannot imply a unique answer.
    alternatives: dict[str, int] = {}
    for candidate in raw_candidates:
        alternatives[candidate['from']] = alternatives.get(candidate['from'], 0) + 1
        alternatives[candidate['to']] = alternatives.get(candidate['to'], 0) + 1
    for candidate in raw_candidates:
        conflicts = [node_id for node_id in (candidate['from'], candidate['to'])
                     if alternatives.get(node_id, 0) > 1]
        candidate['conflicting_nodes'] = conflicts
        candidate['has_alternatives'] = bool(conflicts)
        if conflicts:
            candidate['priority'] = 'review'
            candidate['review_flags'].append('competing_candidate')
            candidate['message'] = 'У одного из концов есть альтернативные пары; выбери только после визуальной проверки.'

    raw_candidates.sort(key=lambda item: (
        item['priority'] != 'high', -item['score'], item['distance']
    ))
    candidates = raw_candidates[:200]
    for index, candidate in enumerate(candidates, 1):
        candidate['id'] = f'J{index}'
    return candidates

