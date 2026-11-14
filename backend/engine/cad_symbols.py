"""Configurable CAD symbol library shared by SVG and DXF exporters."""
from __future__ import annotations

from copy import deepcopy
from typing import Any


SYMBOL_CATALOG: dict[str, dict[str, Any]] = {
    "shutoff_valve": {
        "label": "Запорный элемент",
        "ports": [{"id": "in", "x": -1.0, "y": 0.0}, {"id": "out", "x": 1.0, "y": 0.0}],
        "primitives": [
            {"kind": "polyline", "points": [[-1, -0.65], [0, 0], [-1, 0.65], [-1, -0.65]]},
            {"kind": "polyline", "points": [[1, -0.65], [0, 0], [1, 0.65], [1, -0.65]]},
        ],
    },
    "coupling": {
        "label": "Соединительный элемент",
        "ports": [{"id": "in", "x": -1.0, "y": 0.0}, {"id": "out", "x": 1.0, "y": 0.0}],
        "primitives": [
            {"kind": "line", "from": [-1, 0], "to": [-0.3, 0]},
            {"kind": "line", "from": [-0.3, -0.7], "to": [-0.3, 0.7]},
            {"kind": "line", "from": [0.3, -0.7], "to": [0.3, 0.7]},
            {"kind": "line", "from": [0.3, 0], "to": [1, 0]},
        ],
    },
    "control_point": {
        "label": "Контрольная точка",
        "ports": [{"id": "pipe", "x": 0.0, "y": 1.0}],
        "primitives": [{"kind": "circle", "center": [0, 0], "radius": 0.72}],
    },
    "terminal_cap": {
        "label": "Концевой элемент",
        "ports": [{"id": "pipe", "x": -1.0, "y": 0.0}],
        "primitives": [
            {"kind": "line", "from": [-1, 0], "to": [0, 0]},
            {"kind": "line", "from": [0, -0.72], "to": [0, 0.72]},
        ],
    },
    "meter": {
        "label": "Измерительный прибор",
        "ports": [{"id": "in", "x": -1.0, "y": 0.0}, {"id": "out", "x": 1.0, "y": 0.0}],
        "primitives": [
            {"kind": "line", "from": [-1, 0], "to": [-0.72, 0]},
            {"kind": "circle", "center": [0, 0], "radius": 0.72},
            {"kind": "line", "from": [0.72, 0], "to": [1, 0]},
        ],
    },
    "regulator": {
        "label": "Регулятор давления",
        "ports": [{"id": "in", "x": -1.0, "y": 0.0}, {"id": "out", "x": 1.0, "y": 0.0}],
        "primitives": [
            {"kind": "line", "from": [-1, 0], "to": [-0.55, 0]},
            {"kind": "polyline", "points": [[-0.55, -0.58], [0.48, -0.58], [0.48, 0.58], [-0.55, 0.58], [-0.55, -0.58]]},
            {"kind": "line", "from": [0.48, 0], "to": [1, 0]},
            {"kind": "line", "from": [0, -0.58], "to": [0, -0.92]},
        ],
    },
    "filter": {
        "label": "Фильтр газовый",
        "ports": [{"id": "in", "x": -1.0, "y": 0.0}, {"id": "out", "x": 1.0, "y": 0.0}],
        "primitives": [
            {"kind": "line", "from": [-1, 0], "to": [-0.58, 0]},
            {"kind": "polyline", "points": [[-0.58, -0.58], [0.58, -0.58], [0.58, 0.58], [-0.58, 0.58], [-0.58, -0.58]]},
            {"kind": "line", "from": [-0.45, 0.42], "to": [0.45, -0.42]},
            {"kind": "line", "from": [0.58, 0], "to": [1, 0]},
        ],
    },
    "tee": {
        "label": "Тройник",
        "ports": [{"id": "left", "x": -1.0, "y": 0.0}, {"id": "right", "x": 1.0, "y": 0.0}, {"id": "branch", "x": 0.0, "y": -1.0}],
        "primitives": [
            {"kind": "line", "from": [-1, 0], "to": [1, 0]},
            {"kind": "line", "from": [0, 0], "to": [0, -1]},
            {"kind": "circle", "center": [0, 0], "radius": 0.12},
        ],
    },
    "reducer": {
        "label": "Переход диаметра",
        "ports": [{"id": "large", "x": -1.0, "y": 0.0}, {"id": "small", "x": 1.0, "y": 0.0}],
        "primitives": [
            {"kind": "line", "from": [-1, -0.62], "to": [-0.35, -0.28]},
            {"kind": "line", "from": [-1, 0.62], "to": [-0.35, 0.28]},
            {"kind": "line", "from": [-0.35, -0.28], "to": [1, -0.28]},
            {"kind": "line", "from": [-0.35, 0.28], "to": [1, 0.28]},
        ],
    },
    "pressure_gauge": {
        "label": "Манометр",
        "ports": [{"id": "pipe", "x": 0.0, "y": 1.0}],
        "primitives": [
            {"kind": "circle", "center": [0, 0], "radius": 0.72},
            {"kind": "line", "from": [0, 0], "to": [0.35, -0.35]},
            {"kind": "line", "from": [0, 0.72], "to": [0, 1]},
        ],
    },
    "riser_marker": {
        "label": "Маркер стояка",
        "ports": [{"id": "bottom", "x": 0.0, "y": 1.0}, {"id": "top", "x": 0.0, "y": -1.0}],
        "primitives": [
            {"kind": "line", "from": [0, -1], "to": [0, 1]},
            {"kind": "circle", "center": [0, 0], "radius": 0.48},
        ],
    },
    "gas_consumer": {
        "label": "Газоиспользующее оборудование",
        "ports": [{"id": "in", "x": -1.0, "y": 0.0}],
        "primitives": [
            {"kind": "line", "from": [-1, 0], "to": [-0.55, 0]},
            {"kind": "polyline", "points": [[-0.55, -0.62], [0.62, 0], [-0.55, 0.62], [-0.55, -0.62]]},
        ],
    },
}


def catalog_manifest() -> list[dict[str, Any]]:
    return [{"type": key, "label": value["label"], "ports": deepcopy(value["ports"])}
            for key, value in SYMBOL_CATALOG.items()]


def assign_symbol_type(model: dict[str, Any], symbol_id: str, symbol_type: str,
                       rotation: float = 0.0) -> dict[str, Any]:
    """Return an updated model; never mutate the caller's saved reconstruction."""
    if symbol_type not in SYMBOL_CATALOG:
        raise ValueError(f"Неизвестный тип CAD-символа: {symbol_type}")
    updated = deepcopy(model)
    symbol = next((item for item in updated.get("symbols", []) if item.get("id") == symbol_id), None)
    if symbol is None:
        raise ValueError(f"Символ не найден: {symbol_id}")
    symbol["type"] = symbol_type
    symbol["catalogLabel"] = SYMBOL_CATALOG[symbol_type]["label"]
    symbol["rotation"] = round(float(rotation) % 360.0, 2)
    symbol["ports"] = deepcopy(SYMBOL_CATALOG[symbol_type]["ports"])
    symbol["state"] = "primary"
    for task in updated.get("reviewTasks", []):
        if task.get("kind") == "classify_symbol" and symbol_id in (task.get("targetIds") or []):
            task["status"] = "resolved"
    if not any(task.get("status") == "open" for task in updated.get("reviewTasks", [])):
        updated["status"] = "confirmed"
    return updated


def symbol_primitives(symbol: dict[str, Any]) -> list[dict[str, Any]]:
    """Map normalized catalog geometry into the candidate bounding box."""
    definition = SYMBOL_CATALOG.get(str(symbol.get("type") or ""))
    box = symbol.get("bbox") or {}
    if not definition:
        return []
    try:
        x, y, w, h = (float(box[key]) for key in ("x", "y", "w", "h"))
    except (KeyError, TypeError, ValueError):
        return []
    cx, cy = x + w / 2.0, y + h / 2.0
    size = max(4.0, min(max(w, 1.0), max(h, 1.0)) / 2.0)
    rotation = float(symbol.get("rotation", 0) or 0)
    import math
    radians = math.radians(rotation)
    cosine, sine = math.cos(radians), math.sin(radians)

    def point(raw: list[float]) -> list[float]:
        px, py = float(raw[0]) * size, float(raw[1]) * size
        return [round(cx + px * cosine - py * sine, 2), round(cy + px * sine + py * cosine, 2)]

    result = []
    for primitive in definition["primitives"]:
        item = {"kind": primitive["kind"]}
        if primitive["kind"] == "line":
            item.update({"from": point(primitive["from"]), "to": point(primitive["to"])})
        elif primitive["kind"] == "polyline":
            item["points"] = [point(value) for value in primitive["points"]]
        elif primitive["kind"] == "circle":
            item.update({"center": point(primitive["center"]), "radius": round(float(primitive["radius"]) * size, 2)})
        result.append(item)
    return result


def symbol_port_positions(symbol: dict[str, Any]) -> list[dict[str, Any]]:
    """Return catalog connection ports transformed to source-image coordinates."""
    definition = SYMBOL_CATALOG.get(str(symbol.get("type") or ""))
    box = symbol.get("bbox") or {}
    if not definition:
        return []
    try:
        x, y, w, h = (float(box[key]) for key in ("x", "y", "w", "h"))
    except (KeyError, TypeError, ValueError):
        return []
    import math
    cx, cy = x + w / 2.0, y + h / 2.0
    size = max(4.0, min(max(w, 1.0), max(h, 1.0)) / 2.0)
    radians = math.radians(float(symbol.get("rotation", 0) or 0))
    cosine, sine = math.cos(radians), math.sin(radians)
    result = []
    for port in definition["ports"]:
        px, py = float(port["x"]) * size, float(port["y"]) * size
        result.append({
            "id": str(port["id"]),
            "position": [round(cx + px * cosine - py * sine, 2), round(cy + px * sine + py * cosine, 2)],
        })
    return result
