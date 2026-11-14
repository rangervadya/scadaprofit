"""Conservative topology attachment through confirmed CAD symbols."""
from __future__ import annotations

from copy import deepcopy
import math
from typing import Any

from cad_symbols import symbol_port_positions
from logging_setup import get_logger

log = get_logger('topology')


def attach_pipes_to_symbols(model: dict[str, Any], tolerance_px: float | None = None) -> tuple[dict[str, Any], dict[str, Any]]:
    """Attach endpoint nodes to confirmed symbol ports and create through-links."""
    updated = deepcopy(model)
    nodes = {str(item.get("id")): item for item in updated.get("nodes", []) if item.get("id")}
    pipes = updated.get("pipes", [])
    endpoint_nodes = {
        node_id: node for node_id, node in nodes.items()
        if node.get("kind") == "endpoint" and isinstance(node.get("position"), list)
    }
    links = []
    attached = unresolved = 0

    # A node may connect to only one symbol port in an automatic pass.
    claimed_nodes: set[str] = set()
    for symbol in updated.get("symbols", []):
        ports = symbol_port_positions(symbol)
        if symbol.get("state") != "primary" or not ports:
            continue
        box = symbol.get("bbox") or {}
        symbol_size = max(float(box.get("w", 0) or 0), float(box.get("h", 0) or 0), 8.0)
        tolerance = float(tolerance_px) if tolerance_px is not None else max(8.0, min(28.0, symbol_size * 0.85))
        connections = []
        for port in ports:
            px, py = port["position"]
            candidates = []
            for node_id, node in endpoint_nodes.items():
                if node_id in claimed_nodes:
                    continue
                try:
                    nx, ny = float(node["position"][0]), float(node["position"][1])
                except (TypeError, ValueError, IndexError):
                    continue
                distance = math.hypot(nx - px, ny - py)
                if distance <= tolerance:
                    candidates.append((distance, node_id))
            candidates.sort()
            if not candidates:
                unresolved += 1
                connections.append({"portId": port["id"], "nodeId": None, "state": "review"})
                continue
            distance, node_id = candidates[0]
            claimed_nodes.add(node_id)
            node = nodes[node_id]
            old_position = list(node["position"])
            node["position"] = list(port["position"])
            node["symbolId"] = symbol["id"]
            node["symbolPortId"] = port["id"]
            node["state"] = "primary"
            # Keep pipe geometry incident to the node aligned with the CAD port.
            for pipe in pipes:
                if pipe.get("fromNode") == node_id and pipe.get("geometry"):
                    pipe["geometry"][0] = list(port["position"])
                if pipe.get("toNode") == node_id and pipe.get("geometry"):
                    pipe["geometry"][-1] = list(port["position"])
            connections.append({"portId": port["id"], "nodeId": node_id,
                                "distance": round(distance, 2), "previousPosition": old_position,
                                "state": "connected"})
            attached += 1
        symbol["connections"] = connections
        connected_nodes = [item["nodeId"] for item in connections if item.get("nodeId")]
        if len(connected_nodes) >= 2:
            links.append({"id": f"TL{len(links) + 1}", "kind": "through_symbol",
                          "symbolId": symbol["id"], "fromNode": connected_nodes[0],
                          "toNode": connected_nodes[1], "state": "primary"})

    updated["topologyLinks"] = links
    existing_tasks = updated.setdefault("reviewTasks", [])
    existing_keys = {(task.get("kind"), tuple(task.get("targetIds") or [])) for task in existing_tasks}
    for symbol in updated.get("symbols", []):
        if symbol.get("state") != "primary":
            continue
        missing = [item for item in symbol.get("connections", []) if not item.get("nodeId")]
        key = ("connect_symbol_port", (str(symbol.get("id")),))
        if missing and key not in existing_keys:
            existing_tasks.append({
                "id": f"R{len(existing_tasks) + 1}", "kind": "connect_symbol_port",
                "targetIds": [str(symbol.get("id"))], "status": "open", "confidence": 0.0,
                "message": "Укажите трубу для неподключённой точки условного обозначения.",
            })
    updated["status"] = "needs_review" if any(task.get("status") == "open" for task in existing_tasks) else "confirmed"
    return updated, {"attachedPorts": attached, "unresolvedPorts": unresolved, "throughLinks": len(links)}


def split_segments_at_endpoint_junctions(
    segments: list[dict[str, Any]],
    ink: Any,
    text_mask: Any | None = None,
    *,
    max_distance_px: float = 3.5,
    minimum_branch_length_px: float = 14.0,
    minimum_host_length_px: float = 28.0,
    minimum_crossing_angle_deg: float = 20.0,
) -> tuple[list[dict[str, Any]], dict[str, int]]:
    """Split host strokes where a supported branch endpoint clearly touches.

    Only endpoint-to-interior T-junctions are considered. X crossings (two
    strokes continuing through the intersection) are never auto-connected.
    Both strokes must have source-ink support and low OCR overlap. Ambiguous
    candidates are left untouched for the existing crossing/review workflow.
    """
    import math
    import numpy as np

    if not segments or ink is None:
        return [dict(item) for item in segments], {"tJunctionsAdded": 0, "segmentsCreated": 0, "ambiguousCandidates": 0}
    try:
        ink_array = np.asarray(ink)
        if ink_array.ndim != 2 or ink_array.size == 0:
            raise ValueError
        text_array = np.asarray(text_mask) if text_mask is not None else None
        if text_array is not None and text_array.shape != ink_array.shape:
            text_array = None
    except Exception as exc:
        # Without a usable ink mask junction reconstruction cannot run; the
        # graph keeps its raw segments and the review workflow still applies.
        log.warning('Junction reconstruction skipped: unusable ink mask', extra={'err': str(exc)})
        return [dict(item) for item in segments], {"tJunctionsAdded": 0, "segmentsCreated": 0, "ambiguousCandidates": 0}

    h, w = ink_array.shape[:2]
    candidates_by_endpoint: dict[tuple[int, int], list[tuple[float, int, float, tuple[float, float]]]] = {}
    ambiguous = 0

    def line_support(ax: float, ay: float, bx: float, by: float) -> float:
        length = math.hypot(bx - ax, by - ay)
        count = max(3, int(length / 2.0) + 1)
        supported = 0
        for t in np.linspace(0.0, 1.0, count):
            px = min(w - 1, max(0, int(round(ax + (bx - ax) * t))))
            py = min(h - 1, max(0, int(round(ay + (by - ay) * t))))
            if ink_array[py, px] > 0:
                supported += 1
        return supported / count

    def text_near(px: float, py: float) -> bool:
        if text_array is None:
            return False
        cx, cy = int(round(px)), int(round(py))
        x1, x2 = max(0, cx - 3), min(w, cx + 4)
        y1, y2 = max(0, cy - 3), min(h, cy + 4)
        return bool(np.count_nonzero(text_array[y1:y2, x1:x2]) >= 5)

    for branch_index, branch in enumerate(segments):
        try:
            bx1, by1, bx2, by2 = (float(branch[key]) for key in ("x1", "y1", "x2", "y2"))
        except (KeyError, TypeError, ValueError):
            continue
        branch_length = math.hypot(bx2 - bx1, by2 - by1)
        if branch_length < minimum_branch_length_px:
            continue
        if branch.get("text_crossing") or float(branch.get("ocr_overlap", 0.0) or 0.0) >= 0.12:
            continue
        branch_support = float(branch.get("support", 0.0) or 0.0)
        if branch_support < 0.20 and line_support(bx1, by1, bx2, by2) < 0.35:
            continue
        branch_vector = np.array([bx2 - bx1, by2 - by1], dtype=float) / max(branch_length, 1e-9)

        for side, (px, py) in enumerate(((bx1, by1), (bx2, by2))):
            options = []
            for host_index, host in enumerate(segments):
                if host_index == branch_index:
                    continue
                if host.get("text_crossing") or float(host.get("ocr_overlap", 0.0) or 0.0) >= 0.12:
                    continue
                try:
                    hx1, hy1, hx2, hy2 = (float(host[key]) for key in ("x1", "y1", "x2", "y2"))
                except (KeyError, TypeError, ValueError):
                    continue
                hdx, hdy = hx2 - hx1, hy2 - hy1
                host_length = math.hypot(hdx, hdy)
                if host_length < minimum_host_length_px:
                    continue
                host_vector = np.array([hdx, hdy], dtype=float) / host_length
                # A branch must approach the host at a real angle, not run beside it.
                parallel = abs(float(np.dot(branch_vector, host_vector)))
                min_cross = math.sin(math.radians(minimum_crossing_angle_deg))
                if math.sqrt(max(0.0, 1.0 - parallel * parallel)) < min_cross:
                    continue
                projection = ((px - hx1) * hdx + (py - hy1) * hdy) / (host_length * host_length)
                if not 0.10 <= projection <= 0.90:
                    continue
                qx, qy = hx1 + projection * hdx, hy1 + projection * hdy
                distance = math.hypot(px - qx, py - qy)
                if distance > max_distance_px:
                    continue
                if text_near(qx, qy):
                    continue
                host_support = line_support(qx - host_vector[0] * 9.0, qy - host_vector[1] * 9.0,
                                            qx + host_vector[0] * 9.0, qy + host_vector[1] * 9.0)
                if host_support < 0.55:
                    continue
                options.append((distance, host_index, projection, (qx, qy)))
            options.sort(key=lambda item: (item[0], item[1]))
            if not options:
                continue
            # If two different host directions are equally plausible, do not guess.
            if len(options) > 1 and options[1][0] - options[0][0] < 0.8:
                first_host = segments[options[0][1]]
                second_host = segments[options[1][1]]
                first_vec = np.array([float(first_host["x2"]) - float(first_host["x1"]),
                                      float(first_host["y2"]) - float(first_host["y1"])], dtype=float)
                second_vec = np.array([float(second_host["x2"]) - float(second_host["x1"]),
                                       float(second_host["y2"]) - float(second_host["y1"])], dtype=float)
                denom = max(float(np.linalg.norm(first_vec) * np.linalg.norm(second_vec)), 1e-9)
                if abs(float(np.dot(first_vec, second_vec) / denom)) < 0.94:
                    ambiguous += 1
                    continue
            candidates_by_endpoint[(branch_index, side)] = [options[0]]

    split_points: dict[int, list[tuple[float, tuple[float, float]]]] = {}
    endpoint_snap: dict[tuple[int, int], tuple[float, float]] = {}
    for endpoint_key, option_list in candidates_by_endpoint.items():
        distance, host_index, projection, point = option_list[0]
        split_points.setdefault(host_index, []).append((projection, point))
        endpoint_snap[endpoint_key] = point

    rebuilt: list[dict[str, Any]] = []
    original_split_pieces = 0
    for index, source in enumerate(segments):
        try:
            x1, y1, x2, y2 = (float(source[key]) for key in ("x1", "y1", "x2", "y2"))
        except (KeyError, TypeError, ValueError):
            rebuilt.append(dict(source))
            continue
        points = [(0.0, (x1, y1)), *split_points.get(index, []), (1.0, (x2, y2))]
        points.sort(key=lambda item: item[0])
        compact: list[tuple[float, tuple[float, float]]] = []
        for item in points:
            if compact and math.dist(compact[-1][1], item[1]) < 2.0:
                continue
            compact.append(item)
        if len(compact) == 2:
            clone = dict(source)
            clone["_topology_source_index"] = index
            rebuilt.append(clone)
            continue
        for piece_index, (left, right) in enumerate(zip(compact, compact[1:])):
            a, b = left[1], right[1]
            if math.dist(a, b) < 3.0:
                continue
            clone = dict(source)
            clone.update({"x1": round(a[0], 2), "y1": round(a[1], 2),
                          "x2": round(b[0], 2), "y2": round(b[1], 2),
                          "length": round(math.dist(a, b), 2),
                          "_topology_source_index": index,
                          "_topology_split_piece": piece_index + 1,
                          "_topology_piece_count": len(compact) - 1,
                          "topology_t_junction_split": True})
            rebuilt.append(clone)
            original_split_pieces += 1

    # Snap only branch endpoints after a host candidate has been confirmed.
    for index, source in enumerate(segments):
        start = endpoint_snap.get((index, 0))
        end = endpoint_snap.get((index, 1))
        if not start and not end:
            continue
        for rebuilt_segment in rebuilt:
            if rebuilt_segment.get("_topology_source_index") != index:
                continue
            # A segment may itself have been split; only the first/last piece
            # inherits its source endpoint. Do not move internal split points.
            if start and rebuilt_segment.get("_topology_split_piece") in (None, 1):
                rebuilt_segment["x1"], rebuilt_segment["y1"] = round(start[0], 2), round(start[1], 2)
            if end and (rebuilt_segment.get("_topology_split_piece") is None or
                        rebuilt_segment.get("_topology_split_piece") == rebuilt_segment.get("_topology_piece_count")):
                rebuilt_segment["x2"], rebuilt_segment["y2"] = round(end[0], 2), round(end[1], 2)

    return rebuilt, {
        "tJunctionsAdded": len(endpoint_snap),
        "segmentsCreated": original_split_pieces,
        "ambiguousCandidates": ambiguous,
    }
