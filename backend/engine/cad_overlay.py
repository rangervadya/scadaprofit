"""Source-photo overlay for auditing the CAD model against original ink."""
from __future__ import annotations

from pathlib import Path
from typing import Any

import cv2
import numpy as np


def render_cad_alignment_overlay(source_bgr: np.ndarray, model: dict[str, Any], output_path: str | Path,
                                 maximum_dimension: int = 2200) -> dict[str, Any]:
    if not isinstance(source_bgr, np.ndarray) or source_bgr.ndim != 3 or source_bgr.shape[2] < 3:
        raise ValueError("source_bgr must be a BGR image")
    image = source_bgr[:, :, :3].copy()
    height, width = image.shape[:2]
    scale = min(1.0, maximum_dimension / max(width, height))
    if scale < 1.0:
        image = cv2.resize(image, (int(round(width * scale)), int(round(height * scale))), interpolation=cv2.INTER_AREA)
    output_h, output_w = image.shape[:2]

    def pt(point: Any) -> tuple[int, int] | None:
        try:
            x, y = float(point[0]) * scale, float(point[1]) * scale
            if not np.isfinite(x) or not np.isfinite(y):
                return None
            return int(round(x)), int(round(y))
        except (TypeError, ValueError, IndexError):
            return None

    alpha = image.copy()
    counts = {"primaryPipes": 0, "reviewPipes": 0, "nodes": 0, "symbols": 0}
    for pipe in model.get("pipes", []):
        points = [pt(value) for value in pipe.get("geometry") or []]
        points = [value for value in points if value is not None]
        if len(points) < 2:
            continue
        color = (35, 175, 75) if pipe.get("state") == "primary" else (0, 145, 245)
        thickness = 3 if pipe.get("state") == "primary" else 2
        cv2.polylines(alpha, [np.asarray(points, dtype=np.int32)], False, color, thickness, cv2.LINE_AA)
        if pipe.get("state") == "primary":
            counts["primaryPipes"] += 1
        else:
            counts["reviewPipes"] += 1

    for node in model.get("nodes", []):
        if node.get("state") != "primary":
            continue
        position = pt(node.get("position"))
        if position is None:
            continue
        cv2.circle(alpha, position, max(3, int(round(3.5 * scale))), (20, 30, 230), -1, cv2.LINE_AA)
        counts["nodes"] += 1

    for symbol in model.get("symbols", []):
        box = symbol.get("bbox") or {}
        try:
            x1, y1 = pt([box["x"], box["y"]])
            x2, y2 = pt([float(box["x"]) + float(box["w"]), float(box["y"]) + float(box["h"])])
        except (TypeError, ValueError, KeyError):
            continue
        if x1 is None or x2 is None:
            continue
        color = (210, 90, 30) if symbol.get("state") == "primary" else (0, 145, 245)
        cv2.rectangle(alpha, (x1, y1), (x2, y2), color, max(1, int(round(1.5 * scale))), cv2.LINE_AA)
        counts["symbols"] += 1

    blended = cv2.addWeighted(alpha, 0.88, image, 0.12, 0)
    panel_h = max(56, int(58 * scale))
    cv2.rectangle(blended, (0, 0), (output_w, panel_h), (250, 250, 250), -1)
    font_scale = max(0.42, min(0.72, 0.55 * scale + 0.20))
    y = max(20, int(22 * scale))
    cv2.putText(blended, "CAD / PHOTO CHECK  |  GREEN: PRIMARY  ORANGE: REVIEW  RED: NODES  BLUE: SYMBOLS",
                (12, y), cv2.FONT_HERSHEY_SIMPLEX, font_scale, (35, 45, 55), 1, cv2.LINE_AA)
    summary = (f"Primary routes: {counts['primaryPipes']}   Review: {counts['reviewPipes']}   "
               f"Nodes: {counts['nodes']}   Symbols: {counts['symbols']}")
    cv2.putText(blended, summary, (12, min(panel_h - 7, y + 23)), cv2.FONT_HERSHEY_SIMPLEX,
                font_scale, (65, 75, 85), 1, cv2.LINE_AA)
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if not cv2.imwrite(str(path), blended, [cv2.IMWRITE_PNG_COMPRESSION, 6]):
        raise OSError(f"Cannot write CAD overlay: {path}")
    return {"available": True, "file": path.name, "width": output_w, "height": output_h,
            "resized": scale < 1.0, "scale": round(scale, 4), **counts,
            "description": "Диагностическое наложение CAD-модели на исходное фото; не является чистовым чертежом."}
