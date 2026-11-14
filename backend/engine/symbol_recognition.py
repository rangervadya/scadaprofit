"""Conservative shape-template suggestions for compact engineering marks.

The matcher ranks catalog candidates for human review. It never assigns a CAD
symbol type automatically: symbol meaning must be confirmed by an engineer.
"""
from __future__ import annotations

import math
from typing import Any

import cv2
import numpy as np


_TEMPLATE_SIZE = 64


def _draw_templates(size: int = _TEMPLATE_SIZE) -> dict[str, np.ndarray]:
    scale = size / 64.0
    templates: dict[str, np.ndarray] = {}

    def make(name: str, draw) -> None:
        canvas = np.zeros((size, size), dtype=np.uint8)
        draw(canvas, scale)
        templates[name] = canvas

    def line(canvas, a, b, s):
        cv2.line(canvas, tuple(int(round(v * s)) for v in a),
                 tuple(int(round(v * s)) for v in b), 255, max(1, int(round(2 * s))), cv2.LINE_AA)

    def poly(canvas, points, s):
        pts = np.asarray([[int(round(x * s)), int(round(y * s))] for x, y in points], dtype=np.int32)
        cv2.polylines(canvas, [pts], True, 255, max(1, int(round(2 * s))), cv2.LINE_AA)

    def circle(canvas, c, r, s):
        cv2.circle(canvas, tuple(int(round(v * s)) for v in c),
                   max(2, int(round(r * s))), 255, max(1, int(round(2 * s))), cv2.LINE_AA)

    make("shutoff_valve", lambda c, s: (
        poly(c, [(9, 13), (31, 32), (9, 51)], s),
        poly(c, [(55, 13), (33, 32), (55, 51)], s),
    ))
    make("coupling", lambda c, s: (
        line(c, (4, 32), (24, 32), s), line(c, (24, 13), (24, 51), s),
        line(c, (40, 13), (40, 51), s), line(c, (40, 32), (60, 32), s),
    ))
    make("control_point", lambda c, s: circle(c, (32, 32), 18, s))
    make("terminal_cap", lambda c, s: (
        line(c, (4, 32), (32, 32), s), line(c, (32, 12), (32, 52), s),
    ))
    make("meter", lambda c, s: (
        line(c, (3, 32), (15, 32), s), circle(c, (32, 32), 16, s),
        line(c, (49, 32), (61, 32), s),
    ))
    return templates


_TEMPLATES = _draw_templates()


def _normalise_patch(mask: np.ndarray, size: int = _TEMPLATE_SIZE) -> np.ndarray:
    binary = (np.asarray(mask) > 0).astype(np.uint8) * 255
    if binary.ndim != 2 or binary.size == 0:
        return np.zeros((size, size), dtype=np.uint8)
    ys, xs = np.nonzero(binary)
    if len(xs) < 5:
        return np.zeros((size, size), dtype=np.uint8)
    x1, x2 = int(xs.min()), int(xs.max()) + 1
    y1, y2 = int(ys.min()), int(ys.max()) + 1
    crop = binary[y1:y2, x1:x2]
    h, w = crop.shape
    inner = size - 12
    scale = min(inner / max(w, 1), inner / max(h, 1))
    nw, nh = max(1, int(round(w * scale))), max(1, int(round(h * scale)))
    resized = cv2.resize(crop, (nw, nh), interpolation=cv2.INTER_NEAREST)
    canvas = np.zeros((size, size), dtype=np.uint8)
    ox, oy = (size - nw) // 2, (size - nh) // 2
    canvas[oy:oy + nh, ox:ox + nw] = resized
    # A small, controlled dilation compensates for antialiasing and pen width.
    return cv2.dilate(canvas, np.ones((2, 2), np.uint8), iterations=1)


def _chamfer_score(candidate: np.ndarray, template: np.ndarray) -> float:
    candidate_pixels = candidate > 0
    template_pixels = template > 0
    if int(candidate_pixels.sum()) < 5 or int(template_pixels.sum()) < 5:
        return 0.0
    to_template = cv2.distanceTransform(255 - template, cv2.DIST_L2, 3)
    to_candidate = cv2.distanceTransform(255 - candidate, cv2.DIST_L2, 3)
    forward = float(np.mean(to_template[candidate_pixels]))
    backward = float(np.mean(to_candidate[template_pixels]))
    # Symmetric chamfer is less sensitive to line width than binary IoU.
    distance = 0.5 * (forward + backward)
    occupancy_ratio = max(float(candidate_pixels.sum()) / float(template_pixels.sum()),
                          float(template_pixels.sum()) / float(candidate_pixels.sum()))
    penalty = min(1.0, abs(math.log(max(occupancy_ratio, 1e-6))) * 0.035)
    return max(0.0, min(1.0, math.exp(-distance / 7.0) * (1.0 - penalty)))


def suggest_symbol_types(ink_mask: np.ndarray, bbox: dict[str, Any],
                         max_suggestions: int = 3) -> list[dict[str, Any]]:
    """Rank catalog matches for review; never returns an auto-approved type."""
    if ink_mask is None or not isinstance(bbox, dict):
        return []
    try:
        x, y = int(round(float(bbox["x"]))), int(round(float(bbox["y"])))
        w, h = int(round(float(bbox["w"]))), int(round(float(bbox["h"])))
    except (KeyError, TypeError, ValueError):
        return []
    height, width = ink_mask.shape[:2]
    if w < 4 or h < 4 or x < 0 or y < 0 or x + w > width or y + h > height:
        return []
    patch = _normalise_patch(ink_mask[y:y + h, x:x + w])
    if int(np.count_nonzero(patch)) < 8:
        return []

    ranked: list[tuple[float, str]] = []
    centre = (_TEMPLATE_SIZE / 2.0, _TEMPLATE_SIZE / 2.0)
    for symbol_type, template in _TEMPLATES.items():
        best = 0.0
        for angle in range(0, 180, 15):
            matrix = cv2.getRotationMatrix2D(centre, float(angle), 1.0)
            rotated = cv2.warpAffine(template, matrix, (_TEMPLATE_SIZE, _TEMPLATE_SIZE),
                                     flags=cv2.INTER_NEAREST, borderValue=0)
            best = max(best, _chamfer_score(patch, rotated))
        ranked.append((best, symbol_type))
    ranked.sort(key=lambda item: (-item[0], item[1]))
    result = []
    for score, symbol_type in ranked[:max(1, min(5, int(max_suggestions)))]:
        result.append({"type": symbol_type, "score": round(score, 3), "requiresConfirmation": True})
    return result
