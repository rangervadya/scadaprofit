"""Versioned editable domain model for reconstructed piping schemes."""
from __future__ import annotations

import math
import re
from typing import Any

MODEL_SCHEMA = "cad-document-model/1.0"
MODEL_STATUSES = {"needs_review", "confirmed"}
ITEM_STATES = {"primary", "review", "rejected"}


def _confidence(value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    return round(max(0.0, min(1.0, number)), 3) if math.isfinite(number) else 0.0


def _point(value: Any) -> list[float] | None:
    if not isinstance(value, (list, tuple)) or len(value) < 2:
        return None
    try:
        x, y = float(value[0]), float(value[1])
    except (TypeError, ValueError):
        return None
    return [round(x, 2), round(y, 2)] if math.isfinite(x) and math.isfinite(y) else None


def _text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def build_document_model(width: int, height: int, nodes: list[dict[str, Any]],
                         edges: list[dict[str, Any]], annotations: list[dict[str, Any]],
                         crossings: list[dict[str, Any]] | None = None,
                         join_candidates: list[dict[str, Any]] | None = None,
                         recognition_channels: dict[str, Any] | None = None) -> dict[str, Any]:
    """Convert detector-specific results into a stable editable contract."""
    model_nodes = []
    for node in nodes:
        node_id = str(node.get("id") or "")
        if not node_id:
            continue
        model_nodes.append({
            "id": node_id,
            "position": [round(float(node.get("x", 0)), 2), round(float(node.get("y", 0)), 2)],
            "kind": "junction" if int(node.get("degree", 0) or 0) >= 3 else "endpoint",
            "state": "review" if node.get("review") else "primary",
            "source": "opencv",
            "confidence": 0.5 if node.get("review") else 1.0,
        })

    pipes = []
    for edge in edges:
        geometry = [point for raw in (edge.get("geometry") or []) if (point := _point(raw))]
        if len(geometry) < 2:
            continue
        pipes.append({
            "id": str(edge.get("id") or f"P{len(pipes) + 1}"),
            "fromNode": str(edge.get("from") or ""),
            "toNode": str(edge.get("to") or ""),
            "geometry": geometry,
            "state": "primary" if edge.get("cad_include") else "review",
            "source": str(edge.get("detector") or edge.get("source") or "opencv"),
            "confidence": _confidence(edge.get("confidence")),
            "attributes": {},
        })

    channels = recognition_channels or {}
    dimension_sources = {
        str(item.get("sourceAnnotationId") or ""): str(item.get("id") or "")
        for item in channels.get("dimensionCandidates", []) if isinstance(item, dict)
    }
    labels = []
    for annotation in annotations:
        content, box = _text(annotation.get("text")), annotation.get("bbox") or {}
        if not content or not all(key in box for key in ("x", "y", "w", "h")):
            continue
        try:
            bbox = {key: round(float(box[key]), 2) for key in ("x", "y", "w", "h")}
        except (TypeError, ValueError):
            continue
        verified = bool(annotation.get("verified") and annotation.get("include", True))
        source_id = str(annotation.get("id") or f"L{len(labels) + 1}")
        dimension_id = dimension_sources.get(source_id)
        labels.append({
            "id": source_id,
            "text": content, "bbox": bbox, "role": "dimension_value" if dimension_id else "unassigned",
            "targetId": dimension_id,
            "state": "primary" if verified else "review",
            "source": str(annotation.get("source") or "ocr"),
            "confidence": _confidence(float(annotation.get("confidence", 0) or 0) / 100.0),
        })

    symbols = [dict(item) for item in channels.get("symbolCandidates", []) if isinstance(item, dict)]
    dimensions = [dict(item) for item in channels.get("dimensionCandidates", []) if isinstance(item, dict)]
    review_tasks: list[dict[str, Any]] = []

    def add_task(kind: str, targets: list[str], message: str, confidence: float) -> None:
        review_tasks.append({"id": f"R{len(review_tasks) + 1}", "kind": kind,
                             "targetIds": [item for item in targets if item], "message": message,
                             "status": "open", "confidence": _confidence(confidence)})

    for pipe in pipes:
        if pipe["state"] == "review":
            add_task("confirm_pipe", [pipe["id"]], "Подтвердите, является ли штрих участком трубопровода.", pipe["confidence"])
    for label in labels:
        if label["state"] == "review" and label["role"] != "dimension_value":
            add_task("verify_text", [label["id"]], "Проверьте распознанный текст.", label["confidence"])
    for symbol in symbols:
        add_task("classify_symbol", [symbol["id"]], "Выберите тип условного обозначения.", symbol.get("confidence", 0))
    for dimension in dimensions:
        targets = [dimension["id"]]
        if dimension.get("sourceAnnotationId"):
            targets.append(str(dimension["sourceAnnotationId"]))
        add_task("assign_dimension", targets, "Проверьте значение и назначьте размер участку.", dimension.get("confidence", 0))
    for crossing in crossings or []:
        targets = [str(value) for value in crossing.get("edge_ids", crossing.get("edges", [])) if value]
        add_task("resolve_crossing", targets, "Укажите, является ли пересечение соединением.", 0.5)
    for candidate in join_candidates or []:
        targets = [str(value) for value in candidate.get("edge_ids", []) if value]
        if not targets:
            targets = [str(candidate.get(key)) for key in ("edgeA", "edgeB") if candidate.get(key)]
        add_task("confirm_join", targets, "Подтвердите предложенное соединение окончаний.", float(candidate.get("score", 0.5) or 0.5))

    model = {
        "schema": MODEL_SCHEMA, "status": "needs_review" if review_tasks else "confirmed",
        "sourceImage": {"width": int(width), "height": int(height), "coordinateSpace": "source-image-pixels"},
        "nodes": model_nodes, "pipes": pipes, "symbols": symbols, "dimensions": dimensions,
        "labels": labels, "notes": [], "reviewTasks": review_tasks,
    }
    errors = validate_document_model(model)
    if errors:
        raise ValueError("Некорректная внутренняя модель: " + "; ".join(errors[:8]))
    return model


def validate_document_model(model: Any) -> list[str]:
    """Return deterministic validation errors; an empty list means valid."""
    errors: list[str] = []
    if not isinstance(model, dict):
        return ["model must be an object"]
    if model.get("schema") != MODEL_SCHEMA:
        errors.append(f"schema must be {MODEL_SCHEMA}")
    if model.get("status") not in MODEL_STATUSES:
        errors.append("status is invalid")
    image = model.get("sourceImage")
    if not isinstance(image, dict) or not isinstance(image.get("width"), int) or image.get("width", 0) <= 0 or not isinstance(image.get("height"), int) or image.get("height", 0) <= 0:
        errors.append("sourceImage dimensions must be positive integers")

    collections = ("nodes", "pipes", "symbols", "dimensions", "labels", "notes", "reviewTasks")
    all_ids: set[str] = set()
    ids_by_collection: dict[str, set[str]] = {}
    for name in collections:
        items = model.get(name)
        if not isinstance(items, list):
            errors.append(f"{name} must be an array")
            items = []
        ids: set[str] = set()
        for index, item in enumerate(items):
            if not isinstance(item, dict):
                errors.append(f"{name}[{index}] must be an object")
                continue
            item_id = item.get("id")
            if not isinstance(item_id, str) or not item_id:
                errors.append(f"{name}[{index}].id is required")
                continue
            if item_id in all_ids:
                errors.append(f"duplicate id: {item_id}")
            all_ids.add(item_id)
            ids.add(item_id)
        ids_by_collection[name] = ids

    node_ids = ids_by_collection.get("nodes", set())
    for index, pipe in enumerate(model.get("pipes") or []):
        if not isinstance(pipe, dict):
            continue
        if pipe.get("fromNode") not in node_ids or pipe.get("toNode") not in node_ids:
            errors.append(f"pipes[{index}] references unknown node")
        geometry = pipe.get("geometry")
        if not isinstance(geometry, list) or len(geometry) < 2 or any(_point(point) is None for point in geometry):
            errors.append(f"pipes[{index}].geometry is invalid")
        if pipe.get("state") not in ITEM_STATES:
            errors.append(f"pipes[{index}].state is invalid")

    for index, label in enumerate(model.get("labels") or []):
        if not isinstance(label, dict):
            continue
        if not _text(label.get("text")):
            errors.append(f"labels[{index}].text is required")
        if label.get("state") not in ITEM_STATES:
            errors.append(f"labels[{index}].state is invalid")
        if label.get("targetId") is not None and label.get("targetId") not in all_ids:
            errors.append(f"labels[{index}] references unknown target")

    for index, task in enumerate(model.get("reviewTasks") or []):
        if not isinstance(task, dict):
            continue
        if task.get("status") not in {"open", "resolved", "dismissed"}:
            errors.append(f"reviewTasks[{index}].status is invalid")
        for target_id in task.get("targetIds") or []:
            if target_id not in all_ids:
                errors.append(f"reviewTasks[{index}] references unknown target: {target_id}")
    return errors
