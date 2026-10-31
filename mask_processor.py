#!/usr/bin/env python3
"""Configurable two-mask segmentation: OCR text mask and remaining pen-line mask."""
from __future__ import annotations

import base64
import json
import sys
import html
from io import BytesIO
from typing import Any

import cv2
import numpy as np
from PIL import Image, ImageOps

MAX_DIMENSION = 2200


def clamp(value: Any, default: float, low: float, high: float, cast=float):
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = float(default)
    number = max(low, min(high, number))
    return cast(round(number) if cast is int else number)


def decode_image(raw: bytes) -> np.ndarray:
    if not raw:
        raise ValueError("Пустой файл изображения.")
    try:
        pil = Image.open(BytesIO(raw))
        pil = ImageOps.exif_transpose(pil).convert("RGB")
        if max(pil.size) > MAX_DIMENSION:
            scale = MAX_DIMENSION / max(pil.size)
            pil = pil.resize((max(1, round(pil.width * scale)), max(1, round(pil.height * scale))), Image.Resampling.LANCZOS)
        return cv2.cvtColor(np.asarray(pil), cv2.COLOR_RGB2BGR)
    except Exception as exc:
        raise ValueError(f"Не удалось прочитать изображение: {exc}") from exc


def estimate_dominant_hue(hsv: np.ndarray) -> int | None:
    h, s, v = cv2.split(hsv)
    eligible = (s >= 24) & (v >= 25) & (v <= 250)
    values = h[eligible]
    values = values[(values >= 5) & (values <= 175)]
    if values.size < 40:
        return None
    hist = np.bincount(values, minlength=180)
    smooth = np.convolve(hist.astype(np.float32), np.array([1, 2, 3, 2, 1], np.float32), mode="same")
    peak = int(np.argmax(smooth))
    if hist[peak] < max(8, int(values.size * 0.002)):
        return None
    return peak


def build_ink_mask(
    image: np.ndarray,
    mode: str = "auto",
    hue_min: int = 90,
    hue_max: int = 145,
    hue_tolerance: int = 24,
    saturation_min: int = 18,
    min_brightness: int = 20,
    max_brightness: int = 252,
    dark_threshold: int = 132,
    min_component_area: int = 2,
) -> tuple[np.ndarray, dict[str, Any]]:
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    h, s, v = cv2.split(hsv)
    dominant = estimate_dominant_hue(hsv)
    selected_mode = mode
    low_h, high_h = int(hue_min), int(hue_max)

    if mode == "auto":
        if dominant is None:
            selected_mode = "dark"
        else:
            selected_mode = "color"
            low_h = max(0, dominant - int(hue_tolerance))
            high_h = min(179, dominant + int(hue_tolerance))
    elif mode == "purple":
        low_h, high_h = 112, 175
    elif mode == "blue":
        low_h, high_h = int(hue_min), int(hue_max)
    elif mode == "anycolor":
        selected_mode = "anycolor"

    if selected_mode in ("blue", "color"):
        color_mask = cv2.inRange(
            hsv,
            np.array([low_h, int(saturation_min), int(min_brightness)]),
            np.array([high_h, 255, int(max_brightness)]),
        )
        mask = color_mask
        hue_range: list[int] | None = [low_h, high_h]
    elif selected_mode == "purple":
        mask = cv2.inRange(
            hsv,
            np.array([low_h, int(saturation_min), int(min_brightness)]),
            np.array([high_h, 255, int(max_brightness)]),
        )
        hue_range = [low_h, high_h]
    elif selected_mode == "anycolor":
        colored = (s >= int(saturation_min)) & (v >= int(min_brightness)) & (v <= int(max_brightness))
        neutral_dark = (gray <= int(dark_threshold)) & (s <= 55)
        mask = np.where(colored | neutral_dark, 255, 0).astype(np.uint8)
        hue_range = [0, 179]
    else:
        mask = cv2.inRange(gray, 0, int(dark_threshold))
        hue_range = None

    # Configurable removal of isolated speckles; 1 preserves every detected pixel.
    min_area = max(1, int(min_component_area))
    if min_area > 1:
        n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
        cleaned = np.zeros_like(mask)
        for label in range(1, n):
            if int(stats[label, cv2.CC_STAT_AREA]) >= min_area:
                cleaned[labels == label] = 255
        mask = cleaned

    info = {
        "modeRequested": mode,
        "modeUsed": selected_mode,
        "dominantHue": dominant,
        "hueRange": hue_range,
        "saturationMin": int(saturation_min),
        "brightnessRange": [int(min_brightness), int(max_brightness)],
        "darkThreshold": int(dark_threshold),
        "minComponentArea": min_area,
    }
    return mask, info


def preprocess_for_ocr(image: np.ndarray, ink_mask: np.ndarray, method: str) -> np.ndarray:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    if method == "ink":
        # Tesseract sees only detected pen pixels on a clean white background.
        return cv2.bitwise_not(ink_mask)
    if method == "clahe":
        clahe = cv2.createCLAHE(clipLimit=2.2, tileGridSize=(8, 8))
        return clahe.apply(gray)
    if method == "otsu":
        blur = cv2.GaussianBlur(gray, (3, 3), 0)
        _threshold, binary = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
        return cv2.bitwise_not(binary)
    if method == "adaptive":
        block = max(15, (min(gray.shape[:2]) // 18) | 1)
        binary = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, block, 11)
        return binary
    return gray


def detect_text_boxes(
    image: np.ndarray,
    ink_mask: np.ndarray,
    min_confidence: float = 35.0,
    scale: float = 2.0,
    psm: int = 11,
    language: str = "eng+rus",
    preprocess: str = "original",
    min_box_width: int = 4,
    min_box_height: int = 3,
) -> tuple[list[dict[str, Any]], list[str], dict[str, Any]]:
    warnings: list[str] = []
    try:
        import pytesseract
        from pytesseract import Output
    except Exception as exc:
        return [], [f"Python-модуль Tesseract недоступен: {exc}"], {"available": False}

    allowed_psm = {3, 4, 6, 7, 8, 11, 12, 13}
    psm = int(psm) if int(psm) in allowed_psm else 11
    preprocess_name = preprocess if preprocess in {"original", "ink", "clahe", "otsu", "adaptive"} else "ink"
    lang = language if language in {"eng+rus", "eng", "rus"} else "eng+rus"
    scale = max(1.0, min(3.0, float(scale)))
    ocr_image = preprocess_for_ocr(image, ink_mask, preprocess_name)
    if scale != 1:
        ocr_image = cv2.resize(
            ocr_image, None, fx=scale, fy=scale,
            interpolation=cv2.INTER_CUBIC if scale > 1 else cv2.INTER_AREA,
        )

    config = f"--oem 1 --psm {psm} -c preserve_interword_spaces=1"
    try:
        data = pytesseract.image_to_data(
            ocr_image, lang=lang, config=config,
            output_type=Output.DICT, timeout=55,
        )
    except Exception as exc:
        warnings.append(f"OCR {lang}, PSM {psm} завершился с ошибкой: {exc}")
        return [], warnings, {"available": False, "language": lang, "psm": psm, "preprocess": preprocess_name, "scale": scale}

    height, width = image.shape[:2]
    boxes: list[dict[str, Any]] = []
    raw_words = 0
    for i, raw_text in enumerate(data.get("text", [])):
        text = str(raw_text or "").strip()
        try:
            confidence = float(data["conf"][i])
        except (TypeError, ValueError):
            continue
        if not text:
            continue
        raw_words += 1
        if confidence < min_confidence:
            continue
        x = max(0, int(round(int(data["left"][i]) / scale)))
        y = max(0, int(round(int(data["top"][i]) / scale)))
        w = max(0, int(round(int(data["width"][i]) / scale)))
        h = max(0, int(round(int(data["height"][i]) / scale)))
        if w < min_box_width or h < min_box_height or x >= width or y >= height:
            continue
        boxes.append({
            "text": text[:80], "confidence": round(confidence, 1),
            "x": x, "y": y, "width": min(w, width - x), "height": min(h, height - y),
        })

    info = {
        "available": True, "language": lang, "psm": psm,
        "preprocess": preprocess_name, "scale": scale,
        "rawWords": raw_words, "keptBoxes": len(boxes),
        "minConfidence": float(min_confidence),
        "minBoxWidth": int(min_box_width), "minBoxHeight": int(min_box_height),
    }
    return boxes, warnings, info


def build_two_masks(
    ink_mask: np.ndarray,
    boxes: list[dict[str, Any]],
    padding: int = 1,
    padding_ratio: float = 0.0,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    height, width = ink_mask.shape[:2]
    text_regions = np.zeros_like(ink_mask)
    pad_px = max(0, min(24, int(padding)))
    ratio = max(0.0, min(1.0, float(padding_ratio) / 100.0))

    for box in boxes:
        if box.get("mask", True) is False:
            continue
        x, y = int(box["x"]), int(box["y"])
        w, h = int(box["width"]), int(box["height"])
        extra = pad_px + round(min(w, h) * ratio)
        x1, y1 = max(0, x - extra), max(0, y - extra)
        x2, y2 = min(width - 1, x + w + extra), min(height - 1, y + h + extra)
        cv2.rectangle(text_regions, (x1, y1), (x2, y2), 255, thickness=-1)

    text_mask = cv2.bitwise_and(ink_mask, text_regions)
    line_mask = cv2.bitwise_and(ink_mask, cv2.bitwise_not(text_regions))
    return text_mask, line_mask, text_regions


def encode_png(mask: np.ndarray) -> str:
    ok, encoded = cv2.imencode(".png", mask, [cv2.IMWRITE_PNG_COMPRESSION, 6])
    if not ok:
        raise RuntimeError("Не удалось закодировать PNG-маску.")
    return base64.b64encode(encoded.tobytes()).decode("ascii")


def make_overlay(image: np.ndarray, text_mask: np.ndarray, line_mask: np.ndarray) -> np.ndarray:
    base = cv2.cvtColor(image, cv2.COLOR_BGR2BGRA)
    overlay = np.zeros_like(base)
    overlay[text_mask > 0] = (40, 80, 255, 150)
    overlay[line_mask > 0] = (255, 170, 35, 170)
    alpha = overlay[:, :, 3:4].astype(np.float32) / 255.0
    mixed = base[:, :, :3].astype(np.float32) * (1 - alpha) + overlay[:, :, :3].astype(np.float32) * alpha
    return np.clip(mixed, 0, 255).astype(np.uint8)



def antialiased_preview(mask: np.ndarray, scale: int = 3) -> np.ndarray:
    """Create a presentation-only supersampled mask with antialiased edges.

    The source binary mask is never modified; this preview is for display only.
    """
    scale = max(2, min(4, int(scale)))
    height, width = mask.shape[:2]
    enlarged = cv2.resize(
        mask,
        (width * scale, height * scale),
        interpolation=cv2.INTER_LANCZOS4,
    )
    return np.clip(enlarged, 0, 255).astype(np.uint8)


def zhang_suen_skeleton(mask: np.ndarray, max_iterations: int = 120) -> np.ndarray:
    """Thin a binary mask to a one-pixel skeleton without adding dependencies."""
    image = np.pad((mask > 0).astype(np.uint8), 1, mode="constant")
    for _ in range(max_iterations):
        changed = False
        for phase in (0, 1):
            p2 = image[:-2, 1:-1]
            p3 = image[:-2, 2:]
            p4 = image[1:-1, 2:]
            p5 = image[2:, 2:]
            p6 = image[2:, 1:-1]
            p7 = image[2:, :-2]
            p8 = image[1:-1, :-2]
            p9 = image[:-2, :-2]
            center = image[1:-1, 1:-1]
            neighbours = (p2, p3, p4, p5, p6, p7, p8, p9)
            count = sum(neighbours)
            transitions = sum(
                ((neighbours[i] == 0) & (neighbours[(i + 1) % 8] == 1)).astype(np.uint8)
                for i in range(8)
            )
            base = (center == 1) & (count >= 2) & (count <= 6) & (transitions == 1)
            if phase == 0:
                remove = base & ((p2 * p4 * p6) == 0) & ((p4 * p6 * p8) == 0)
            else:
                remove = base & ((p2 * p4 * p8) == 0) & ((p2 * p6 * p8) == 0)
            if np.any(remove):
                center[remove] = 0
                changed = True
        if not changed:
            break
    return (image[1:-1, 1:-1] * 255).astype(np.uint8)


def _pixel_adjacency(skeleton: np.ndarray) -> tuple[list[tuple[int, int]], list[list[int]]]:
    coords = [tuple(map(int, point)) for point in np.argwhere(skeleton > 0)]
    index = {point: i for i, point in enumerate(coords)}
    adjacency: list[list[int]] = [[] for _ in coords]
    directions = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
    for i, (y, x) in enumerate(coords):
        for dy, dx in directions:
            neighbour = (y + dy, x + dx)
            j = index.get(neighbour)
            if j is None:
                continue
            # Do not add a diagonal shortcut when an orthogonal connection exists.
            # This avoids artificial triangles around right-angle stair steps.
            if dy != 0 and dx != 0:
                if (y, x + dx) in index or (y + dy, x) in index:
                    continue
            adjacency[i].append(j)
    return coords, adjacency


def trace_skeleton_paths(skeleton: np.ndarray) -> tuple[list[list[tuple[float, float]]], int]:
    """Convert a one-pixel skeleton into independent endpoint/junction paths.

    Junction pixel clusters are represented by a shared centroid. Edges are not
    inferred between spatially close but disconnected strokes.
    """
    coords, adjacency = _pixel_adjacency(skeleton)
    if not coords:
        return [], 0

    degrees = [len(items) for items in adjacency]
    special = {i for i, degree in enumerate(degrees) if degree != 2}
    special_owner: dict[int, int] = {}
    node_centers: dict[int, tuple[float, float]] = {}
    clusters: list[list[int]] = []

    # Collapse neighbouring endpoints/branch pixels into a single graph node.
    unseen = set(special)
    while unseen:
        seed = unseen.pop()
        cluster = [seed]
        stack = [seed]
        while stack:
            current = stack.pop()
            for neighbour in adjacency[current]:
                if neighbour in unseen:
                    unseen.remove(neighbour)
                    cluster.append(neighbour)
                    stack.append(neighbour)
        cluster_id = len(clusters)
        clusters.append(cluster)
        for item in cluster:
            special_owner[item] = cluster_id
        xs = [coords[item][1] for item in cluster]
        ys = [coords[item][0] for item in cluster]
        node_centers[cluster_id] = (float(sum(xs) / len(xs)), float(sum(ys) / len(ys)))

    visited_edges: set[tuple[int, int]] = set()
    paths: list[list[tuple[float, float]]] = []

    def edge_key(a: int, b: int) -> tuple[int, int]:
        return (a, b) if a < b else (b, a)

    def to_xy(index_value: int) -> tuple[float, float]:
        y, x = coords[index_value]
        return float(x), float(y)

    # Trace every chain leaving a node cluster until the next node cluster.
    for cluster_id, cluster in enumerate(clusters):
        for start_pixel in cluster:
            for neighbour in adjacency[start_pixel]:
                if neighbour in special_owner:
                    continue
                first_edge = edge_key(start_pixel, neighbour)
                if first_edge in visited_edges:
                    continue
                chain = [start_pixel, neighbour]
                visited_edges.add(first_edge)
                previous, current = start_pixel, neighbour
                guard = 0
                while current not in special_owner and guard <= len(coords):
                    guard += 1
                    next_candidates = [item for item in adjacency[current] if item != previous]
                    if not next_candidates:
                        break
                    # Degree-two pixels have one forward neighbour. If a malformed
                    # skeleton yields several, follow the first unvisited edge.
                    next_pixel = next((item for item in next_candidates if edge_key(current, item) not in visited_edges), None)
                    if next_pixel is None:
                        break
                    visited_edges.add(edge_key(current, next_pixel))
                    chain.append(next_pixel)
                    previous, current = current, next_pixel

                end_node = special_owner.get(current)
                start_xy = node_centers[cluster_id]
                path = [start_xy]
                path.extend(to_xy(item) for item in chain)
                if end_node is not None:
                    path.append(node_centers[end_node])
                # Remove duplicate consecutive coordinates.
                compact: list[tuple[float, float]] = []
                for point in path:
                    if not compact or abs(point[0] - compact[-1][0]) + abs(point[1] - compact[-1][1]) > 1e-6:
                        compact.append(point)
                if len(compact) >= 2:
                    paths.append(compact)

    # Components consisting entirely of degree-two pixels are closed loops.
    remaining = set(range(len(coords)))
    component_seen: set[int] = set()
    while remaining:
        seed = remaining.pop()
        comp = [seed]
        stack = [seed]
        while stack:
            current = stack.pop()
            for neighbour in adjacency[current]:
                if neighbour in remaining:
                    remaining.remove(neighbour)
                    comp.append(neighbour)
                    stack.append(neighbour)
        if not comp or any(degrees[item] != 2 for item in comp):
            continue
        start = comp[0]
        candidates = adjacency[start]
        if not candidates:
            continue
        loop = [start]
        previous, current = start, candidates[0]
        visited_edges.add(edge_key(start, current))
        guard = 0
        while current != start and guard <= len(comp) + 2:
            guard += 1
            loop.append(current)
            next_candidates = [item for item in adjacency[current] if item != previous]
            if not next_candidates:
                break
            next_pixel = next_candidates[0]
            if edge_key(current, next_pixel) in visited_edges and next_pixel != start:
                break
            visited_edges.add(edge_key(current, next_pixel))
            previous, current = current, next_pixel
        if len(loop) >= 3:
            paths.append([to_xy(item) for item in loop] + [to_xy(loop[0])])

    # Keep singleton pixels visible as tiny vector dots in addition to path count.
    isolated = sum(1 for degree in degrees if degree == 0)
    return paths, isolated


def simplify_polyline(points: list[tuple[float, float]], epsilon: float) -> list[tuple[float, float]]:
    """Ramer-Douglas-Peucker simplification while retaining path endpoints."""
    if len(points) <= 2 or epsilon <= 0:
        return points
    arr = np.asarray(points, dtype=np.float32)
    start, end = arr[0], arr[-1]
    segment = end - start
    norm = float(np.linalg.norm(segment))
    if norm <= 1e-8:
        distances = np.linalg.norm(arr[1:-1] - start, axis=1)
    else:
        offsets = arr[1:-1] - start
        distances = np.abs(segment[0] * offsets[:, 1] - segment[1] * offsets[:, 0]) / norm
    if distances.size == 0 or float(distances.max()) <= epsilon:
        return [points[0], points[-1]]
    split = int(np.argmax(distances)) + 1
    left = simplify_polyline(points[:split + 1], epsilon)
    right = simplify_polyline(points[split:], epsilon)
    return left[:-1] + right


def _svg_path(points: list[tuple[float, float]], smoothing: float, protected_angle: float) -> str:
    if len(points) < 2:
        return ""
    pts = points
    commands = [f"M {pts[0][0]:.2f} {pts[0][1]:.2f}"]
    amount = max(0.0, min(1.0, float(smoothing) / 100.0))
    angle_limit = max(10.0, min(80.0, float(protected_angle)))
    for index in range(1, len(pts) - 1):
        prev = np.asarray(pts[index - 1], dtype=np.float32)
        current = np.asarray(pts[index], dtype=np.float32)
        nxt = np.asarray(pts[index + 1], dtype=np.float32)
        incoming = current - prev
        outgoing = nxt - current
        len_in = float(np.linalg.norm(incoming))
        len_out = float(np.linalg.norm(outgoing))
        if len_in < 1e-6 or len_out < 1e-6:
            commands.append(f"L {current[0]:.2f} {current[1]:.2f}")
            continue
        cosine = float(np.clip(np.dot(incoming, outgoing) / (len_in * len_out), -1, 1))
        turn = float(np.degrees(np.arccos(cosine)))
        if amount > 0 and turn <= angle_limit:
            radius = min(2.5, len_in * 0.32, len_out * 0.32) * amount
            before = current - incoming / len_in * radius
            after = current + outgoing / len_out * radius
            commands.append(f"L {before[0]:.2f} {before[1]:.2f} Q {current[0]:.2f} {current[1]:.2f} {after[0]:.2f} {after[1]:.2f}")
        else:
            commands.append(f"L {current[0]:.2f} {current[1]:.2f}")
    commands.append(f"L {pts[-1][0]:.2f} {pts[-1][1]:.2f}")
    return " ".join(commands)


def create_line_svg(
    line_mask: np.ndarray,
    simplify_tolerance: float = 0.8,
    smoothing: float = 30,
    corner_protection: float = 90,
    stroke_width: float = 2.0,
    min_path_length: float = 1.5,
) -> tuple[str, dict[str, Any]]:
    """Vector preview of line-mask centerlines. It does not alter either mask."""
    skeleton = zhang_suen_skeleton(line_mask)
    traced, isolated = trace_skeleton_paths(skeleton)
    height, width = line_mask.shape[:2]
    epsilon = max(0.0, min(3.0, float(simplify_tolerance)))
    smooth = max(0.0, min(100.0, float(smoothing)))
    # Higher protection means only very shallow kinks are rounded.
    angle_limit = 75.0 - (max(0.0, min(100.0, float(corner_protection))) / 100.0) * 55.0
    min_length = max(0.0, min(30.0, float(min_path_length)))
    svg_paths = []
    kept = 0
    total_length = 0.0
    junction_candidates = 0
    for raw_points in traced:
        points = simplify_polyline(raw_points, epsilon)
        length = sum(float(np.linalg.norm(np.asarray(points[i + 1]) - np.asarray(points[i]))) for i in range(len(points) - 1))
        if len(points) < 2 or length < min_length:
            continue
        d = _svg_path(points, smooth, angle_limit)
        if d:
            svg_paths.append(f'<path d="{d}"/>')
            kept += 1
            total_length += length
    # Transparent SVG with dark strokes is suitable for a white CAD canvas.
    # The preview panel supplies its own background; no raster rectangle is exported.
    width_px = max(0.6, min(5.0, float(stroke_width)))
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">'
        f'<g fill="none" stroke="#171814" stroke-width="{width_px:.2f}" '
        f'stroke-linecap="round" stroke-linejoin="round">{"".join(svg_paths)}</g></svg>'
    )
    stats = {
        "skeletonPixels": int(cv2.countNonZero(skeleton)),
        "tracedPaths": len(traced), "vectorPaths": kept,
        "isolatedPixels": int(isolated), "vectorLengthPx": round(total_length, 1),
        "simplifyTolerancePx": epsilon, "smoothingPercent": smooth,
        "cornerAngleLimitDeg": round(angle_limit, 1), "strokeWidthPx": width_px,
    }
    return svg, stats

def sanitize_override_boxes(items: Any, width: int, height: int) -> list[dict[str, Any]]:
    """Validate manually edited OCR labels before reusing them without another OCR pass."""
    if not isinstance(items, list):
        return []
    result: list[dict[str, Any]] = []
    for index, item in enumerate(items[:300]):
        if not isinstance(item, dict):
            continue
        try:
            x = max(0, min(width - 1, int(float(item.get("x", 0)))))
            y = max(0, min(height - 1, int(float(item.get("y", 0)))))
            w = max(1, min(width - x, int(float(item.get("width", 1)))))
            h = max(1, min(height - y, int(float(item.get("height", 1)))))
            confidence = max(0.0, min(100.0, float(item.get("confidence", 0))))
            rotation = max(-180.0, min(180.0, float(item.get("rotation", 0))))
            font_scale = max(0.45, min(2.0, float(item.get("fontScale", 0.9))))
        except (TypeError, ValueError):
            continue
        label = str(item.get("text", ""))[:100]
        mask_enabled = bool(item.get("mask", item.get("active", True)))
        render_enabled = bool(item.get("render", False))
        if render_enabled:
            mask_enabled = True
        result.append({
            "text": label, "confidence": round(confidence, 1),
            "x": x, "y": y, "width": w, "height": h,
            "rotation": rotation, "fontScale": font_scale,
            "mask": mask_enabled, "render": render_enabled, "manual": bool(item.get("manual", False)),
        })
    return result


def create_clean_drawing_svg(
    line_svg: str,
    boxes: list[dict[str, Any]],
    width: int,
    height: int,
    font_family: str = "Arial, sans-serif",
    label_min_confidence: float = 0.0,
) -> tuple[str, dict[str, Any]]:
    """Compose line centerlines with clean, editable typeset OCR labels.

    Handwriting itself is not vectorized as typography. Labels are clean SVG text;
    low-confidence labels can be excluded and corrected in the browser editor.
    """
    import re
    inner = line_svg
    match = re.search(r"<svg[^>]*>(.*)</svg>\s*$", line_svg, flags=re.S)
    if match:
        inner = match.group(1)
    text_nodes: list[str] = []
    rendered = 0
    skipped = 0
    safe_family = html.escape(font_family, quote=True)
    for box in boxes:
        text = str(box.get("text", "")).strip()
        confidence = float(box.get("confidence", 0))
        if not box.get("render", False) or not text or confidence < float(label_min_confidence):
            skipped += 1
            continue
        x, y = float(box["x"]), float(box["y"])
        w, h = float(box["width"]), float(box["height"])
        cx, cy = x + w / 2, y + h / 2
        font_size = max(7.0, min(24.0, h * float(box.get("fontScale", 0.9))))
        rotation = float(box.get("rotation", 0))
        safe_text = html.escape(text, quote=False)
        # Use a separate white label plate so residual handwriting inside an OCR box
        # is covered. The original raster masks remain available unchanged.
        pad_x = max(1.5, font_size * 0.12)
        pad_y = max(1.0, font_size * 0.08)
        text_nodes.append(
            f'<g transform="rotate({rotation:.2f} {cx:.2f} {cy:.2f})">'
            f'<rect x="{x-pad_x:.2f}" y="{y-pad_y:.2f}" width="{w+2*pad_x:.2f}" height="{h+2*pad_y:.2f}" fill="#ffffff" fill-opacity="0.94"/>'
            f'<text x="{cx:.2f}" y="{cy:.2f}" dominant-baseline="central" text-anchor="middle" '
            f'font-family="{safe_family}" font-size="{font_size:.2f}" fill="#171814" '
            f'textLength="{max(5.0,w):.2f}" lengthAdjust="spacingAndGlyphs">{safe_text}</text></g>'
        )
        rendered += 1
    svg = (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}">'
        f'<rect width="100%" height="100%" fill="#ffffff"/>'
        f'{inner}{"".join(text_nodes)}</svg>'
    )
    return svg, {"renderedLabels": rendered, "skippedLabels": skipped, "fontFamily": font_family}


def process(raw: bytes, config: dict[str, Any] | None = None) -> dict[str, Any]:
    config = config or {}
    image = decode_image(raw)
    settings = {
        "mode": str(config.get("mode", "blue")),
        "minConfidence": clamp(config.get("minConfidence"), 35, 0, 95),
        "padding": clamp(config.get("padding"), 1, 0, 24, int),
        "paddingRatio": clamp(config.get("paddingRatio"), 0, 0, 100),
        "ocrScale": clamp(config.get("ocrScale"), 2, 1, 3),
        "psm": clamp(config.get("psm"), 11, 3, 13, int),
        "language": str(config.get("language", "eng+rus")),
        "preprocess": str(config.get("preprocess", "original")),
        "minBoxWidth": clamp(config.get("minBoxWidth"), 4, 1, 40, int),
        "minBoxHeight": clamp(config.get("minBoxHeight"), 3, 1, 40, int),
        "hueMin": clamp(config.get("hueMin"), 90, 0, 179, int),
        "hueMax": clamp(config.get("hueMax"), 145, 0, 179, int),
        "hueTolerance": clamp(config.get("hueTolerance"), 24, 5, 60, int),
        "saturationMin": clamp(config.get("saturationMin"), 18, 0, 200, int),
        "minBrightness": clamp(config.get("minBrightness"), 20, 0, 150, int),
        "maxBrightness": clamp(config.get("maxBrightness"), 252, 100, 255, int),
        "darkThreshold": clamp(config.get("darkThreshold"), 132, 30, 230, int),
        "minComponentArea": clamp(config.get("minComponentArea"), 2, 1, 50, int),
        "previewScale": clamp(config.get("previewScale"), 3, 2, 4, int),
        "vectorTolerance": clamp(config.get("vectorTolerance"), 0.8, 0, 3),
        "vectorSmoothing": clamp(config.get("vectorSmoothing"), 30, 0, 100),
        "cornerProtection": clamp(config.get("cornerProtection"), 90, 0, 100),
        "vectorStrokeWidth": clamp(config.get("vectorStrokeWidth"), 2.0, 0.6, 5),
        "minVectorLength": clamp(config.get("minVectorLength"), 1.5, 0, 30),
        "labelMinConfidence": clamp(config.get("labelMinConfidence"), 0, 0, 95),
    }
    if settings["hueMin"] > settings["hueMax"]:
        settings["hueMin"], settings["hueMax"] = settings["hueMax"], settings["hueMin"]

    ink, mode_info = build_ink_mask(
        image, settings["mode"], settings["hueMin"], settings["hueMax"],
        settings["hueTolerance"], settings["saturationMin"], settings["minBrightness"],
        settings["maxBrightness"], settings["darkThreshold"], settings["minComponentArea"],
    )
    override_boxes = config.get("overrideBoxes")
    if isinstance(override_boxes, list):
        boxes = sanitize_override_boxes(override_boxes, image.shape[1], image.shape[0])
        warnings = []
        ocr_info = {"available": True, "source": "manual-edits", "keptBoxes": len(boxes), "rawWords": len(boxes)}
    else:
        boxes, warnings, ocr_info = detect_text_boxes(
            image, ink, settings["minConfidence"], settings["ocrScale"], settings["psm"],
            settings["language"], settings["preprocess"], settings["minBoxWidth"], settings["minBoxHeight"],
        )
        for box in boxes:
            box["mask"] = True
            box["render"] = False
            box["rotation"] = 0
            box["fontScale"] = 0.9
    text_mask, line_mask, text_regions = build_two_masks(ink, boxes, settings["padding"], settings["paddingRatio"])
    overlay = make_overlay(image, text_mask, line_mask)
    text_preview = antialiased_preview(text_mask, settings["previewScale"])
    line_preview = antialiased_preview(line_mask, settings["previewScale"])
    line_svg, vector_info = create_line_svg(
        line_mask,
        settings["vectorTolerance"],
        settings["vectorSmoothing"],
        settings["cornerProtection"],
        settings["vectorStrokeWidth"],
        settings["minVectorLength"],
    )
    clean_svg, clean_text_info = create_clean_drawing_svg(
        line_svg, boxes, image.shape[1], image.shape[0],
        label_min_confidence=settings["labelMinConfidence"],
    )

    ink_pixels = int(cv2.countNonZero(ink))
    text_pixels = int(cv2.countNonZero(text_mask))
    line_pixels = int(cv2.countNonZero(line_mask))
    if ink_pixels == 0:
        warnings.append("Цветовой фильтр не нашёл чернильных штрихов. Попробуй изменить режим, оттенок или насыщенность.")
    if not boxes:
        warnings.append("OCR не нашёл областей выше выбранного порога. Маска текста пустая; все найденные чернила остаются в маске линий.")
    if text_pixels + line_pixels != ink_pixels:
        warnings.append("Маски не образуют точного разделения чернил. Смотри исходную маску чернил.")

    return {
        "ok": True, "width": int(image.shape[1]), "height": int(image.shape[0]),
        "mode": mode_info, "settings": settings, "ocr": ocr_info,
        "stats": {
            "inkPixels": ink_pixels, "textPixels": text_pixels, "linePixels": line_pixels,
            "ocrBoxes": len(boxes), "ocrRawWords": ocr_info.get("rawWords", 0),
            "recognizedTextSamples": [box["text"] for box in boxes[:50]],
            "textCoveragePercent": round((text_pixels / ink_pixels * 100), 1) if ink_pixels else 0,
            "lineCoveragePercent": round((line_pixels / ink_pixels * 100), 1) if ink_pixels else 0,
        },
        "warnings": warnings, "boxes": boxes, "vectorization": vector_info,
        "cleanText": clean_text_info,
        "masks": {
            # Binary PNGs are authoritative downloads; antialiased images are for display only.
            "inkPngBase64": encode_png(ink), "textPngBase64": encode_png(text_mask),
            "linesPngBase64": encode_png(line_mask), "overlayPngBase64": encode_png(overlay),
            "textPreviewPngBase64": encode_png(text_preview),
            "linesPreviewPngBase64": encode_png(line_preview),
            "lineSvgBase64": base64.b64encode(line_svg.encode("utf-8")).decode("ascii"),
            "cleanSvgBase64": base64.b64encode(clean_svg.encode("utf-8")).decode("ascii"),
        },
    }


def main() -> int:
    try:
        config = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
        raw = sys.stdin.buffer.read()
        result = process(raw, config)
        sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 0
    except Exception as exc:
        sys.stderr.write(f"mask_processor error: {type(exc).__name__}: {exc}\n")
        sys.stdout.write(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
