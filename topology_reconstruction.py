"""Conservative topology attachment through confirmed CAD symbols."""
from __future__ import annotations

from copy import deepcopy
import math
from typing import Any

from cad_symbols import symbol_port_positions


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
