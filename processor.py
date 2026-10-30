#!/usr/bin/env python3
"""Offline pen-stroke extraction and topology-preserving skeleton tracing.

This module does not ask a vision model to invent pipe coordinates. It extracts
ink pixels, thins them to centerlines, follows the pixel graph and writes a
machine-readable vector graph for cad_renderer.py.

The output is a pixel-derived trace, not a dimensionally calibrated engineering
model. Handwritten text and dimension marks can still be included as detail.
"""
from __future__ import annotations

import json
import math
import sys
import time
import traceback
from collections import Counter
from pathlib import Path

import cv2
import numpy as np

cv2.setNumThreads(2)
MAX_DIM = 2400


def read_image(path: Path) -> np.ndarray:
    raw = np.fromfile(str(path), dtype=np.uint8)
    image = cv2.imdecode(raw, cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError('Не удалось прочитать изображение.')
    h, w = image.shape[:2]
    if w < 80 or h < 80:
        raise RuntimeError('Изображение слишком маленькое для надёжной трассировки (минимум 80×80 px).')
    if max(w, h) > MAX_DIM:
        ratio = MAX_DIM / max(w, h)
        image = cv2.resize(image, (round(w * ratio), round(h * ratio)), interpolation=cv2.INTER_AREA)
    return image


def extract_ink(image: np.ndarray) -> tuple[np.ndarray, str, dict]:
    """Prefer saturated pen-colour pixels; fall back to adaptive grayscale ink."""
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    hue, sat, val = cv2.split(hsv)
    # Blue/purple ballpoint ink, the common case in plumbing sketches.
    blue = ((hue >= 82) & (hue <= 162) & (sat >= 27) & (val >= 30) & (val <= 250))
    # Other saturated pen colours, useful for red/green markup while avoiding grey paper.
    other_colour = (sat >= 72) & (val >= 35) & (val <= 245) & ~blue
    colour_mask = blue | other_colour
    colour_ratio = float(colour_mask.mean())

    if 0.00035 <= colour_ratio <= 0.16:
        ink = (colour_mask.astype(np.uint8) * 255)
        method = 'colour-pen-mask'
    else:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        denoised = cv2.medianBlur(gray, 3)
        # CLAHE and adaptive threshold tolerate uneven paper illumination.
        enhanced = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(denoised)
        short = min(gray.shape)
        block = min(51, max(21, (short // 22) | 1))
        if block % 2 == 0:
            block += 1
        block = min(block, short - 1 if (short - 1) % 2 else short - 2)
        block = max(15, block)
        ink = cv2.adaptiveThreshold(
            enhanced, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY_INV, block, 9
        )
        method = 'adaptive-grayscale'

    # Bridge tiny breaks in pen strokes without aggressively fusing neighbouring routes.
    ink = cv2.morphologyEx(
        ink, cv2.MORPH_CLOSE,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)), iterations=1
    )
    # Discard isolated single-pixel noise, retain tiny legitimate junction marks.
    count, labels, stats, _ = cv2.connectedComponentsWithStats(ink, connectivity=8)
    keep = np.zeros(count, dtype=np.uint8)
    for idx in range(1, count):
        area = int(stats[idx, cv2.CC_STAT_AREA])
        width = int(stats[idx, cv2.CC_STAT_WIDTH])
        height = int(stats[idx, cv2.CC_STAT_HEIGHT])
        if area >= 2 or width >= 3 or height >= 3:
            keep[idx] = 1
    ink = (keep[labels] * 255).astype(np.uint8)
    details = {
        'colourInkRatio': round(colour_ratio, 6),
        'inkRatio': round(float(np.mean(ink > 0)), 6),
        'components': max(0, count - 1),
    }
    return ink, method, details


def zhang_suen_thinning(binary: np.ndarray, max_iterations: int = 100) -> tuple[np.ndarray, int]:
    """Vectorised Zhang-Suen thinning, avoiding extra heavy Python packages."""
    img = (binary > 0).astype(np.uint8)
    padded = np.pad(img, 1)
    iterations = 0
    for iteration in range(max_iterations):
        removed_total = 0
        for phase in (0, 1):
            p2 = padded[:-2, 1:-1]
            p3 = padded[:-2, 2:]
            p4 = padded[1:-1, 2:]
            p5 = padded[2:, 2:]
            p6 = padded[2:, 1:-1]
            p7 = padded[2:, :-2]
            p8 = padded[1:-1, :-2]
            p9 = padded[:-2, :-2]
            center = padded[1:-1, 1:-1]
            neighbours = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9
            ring = (p2, p3, p4, p5, p6, p7, p8, p9, p2)
            transitions = np.zeros_like(center)
            for k in range(8):
                transitions += ((ring[k] == 0) & (ring[k + 1] == 1)).astype(np.uint8)
            remove = (center == 1) & (neighbours >= 2) & (neighbours <= 6) & (transitions == 1)
            if phase == 0:
                remove &= (p2 * p4 * p6 == 0) & (p4 * p6 * p8 == 0)
            else:
                remove &= (p2 * p4 * p8 == 0) & (p2 * p6 * p8 == 0)
            n_removed = int(np.count_nonzero(remove))
            if n_removed:
                view = padded[1:-1, 1:-1]
                view[remove] = 0
                removed_total += n_removed
        iterations = iteration + 1
        if removed_total == 0:
            break
    return (padded[1:-1, 1:-1] * 255).astype(np.uint8), iterations


def build_pixel_graph(skeleton: np.ndarray):
    ys, xs = np.where(skeleton > 0)
    pixels = set(zip(xs.tolist(), ys.tolist()))
    offsets = ((-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1))
    adjacency: dict[tuple[int, int], list[tuple[int, int]]] = {}
    for x, y in pixels:
        neighbours = []
        for dx, dy in offsets:
            q = (x + dx, y + dy)
            if q not in pixels:
                continue
            # Suppress a diagonal shortcut when an orthogonal neighbour is present.
            # This avoids false triangles around 90-degree corners and junctions.
            if dx and dy and ((x + dx, y) in pixels or (x, y + dy) in pixels):
                continue
            neighbours.append(q)
        adjacency[(x, y)] = neighbours
    return pixels, adjacency


def pair_continuations(adjacency: dict[tuple[int, int], list[tuple[int, int]]]):
    """At multi-pixel crossings, continue along the straightest pair of strokes.

    A T-junction keeps its third leg as a branch. An X crossing is represented as
    two crossing traces; no semantic pipe connection is invented.
    """
    pairs: dict[tuple[tuple[int, int], tuple[int, int]], tuple[int, int]] = {}
    for point, neighbours in adjacency.items():
        n = len(neighbours)
        candidate_pairs = []
        if n == 2:
            candidate_pairs = [(0.0, neighbours[0], neighbours[1])]
        elif n > 2:
            for i in range(n):
                for j in range(i + 1, n):
                    a, b = neighbours[i], neighbours[j]
                    va = (a[0] - point[0], a[1] - point[1])
                    vb = (b[0] - point[0], b[1] - point[1])
                    dot = (va[0] * vb[0] + va[1] * vb[1]) / (math.hypot(*va) * math.hypot(*vb))
                    candidate_pairs.append((dot, a, b))
            candidate_pairs.sort(key=lambda item: item[0])
        used = set()
        for dot, a, b in candidate_pairs:
            if n > 2 and dot > -0.25:
                break
            if a in used or b in used:
                continue
            pairs[(point, a)] = b
            pairs[(point, b)] = a
            used.add(a)
            used.add(b)
    return pairs


def edge_key(a, b):
    return (a, b) if a <= b else (b, a)


def extract_graph_paths(adjacency, continuation_pairs):
    visited = set()
    paths = []

    def walk(start, first):
        path = [start, first]
        visited.add(edge_key(start, first))
        previous, current = start, first
        for _ in range(500000):
            nxt = continuation_pairs.get((current, previous))
            if nxt is None:
                break
            key = edge_key(current, nxt)
            if key in visited:
                break
            visited.add(key)
            path.append(nxt)
            previous, current = current, nxt
        return path

    # Start at unpaired half-edges: endpoints and unpaired legs of junctions.
    for point, neighbours in adjacency.items():
        for neighbour in neighbours:
            if edge_key(point, neighbour) in visited:
                continue
            if continuation_pairs.get((point, neighbour)) is None:
                paths.append(walk(point, neighbour))

    # Any remaining edges belong to closed loops or fully paired crossings.
    for point, neighbours in adjacency.items():
        for neighbour in neighbours:
            if edge_key(point, neighbour) not in visited:
                paths.append(walk(point, neighbour))

    return paths


def path_metrics(points):
    length = 0.0
    for a, b in zip(points, points[1:]):
        length += math.hypot(b[0] - a[0], b[1] - a[1])
    chord = math.hypot(points[-1][0] - points[0][0], points[-1][1] - points[0][1]) if len(points) > 1 else 0.0
    straightness = chord / max(length, 1e-6)
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return length, straightness, max(xs) - min(xs), max(ys) - min(ys)


def simplify_path(points, epsilon=1.25):
    if len(points) <= 2:
        return points
    contour = np.asarray(points, dtype=np.float32).reshape(-1, 1, 2)
    simplified = cv2.approxPolyDP(contour, epsilon, False).reshape(-1, 2)
    out = [(float(x), float(y)) for x, y in simplified]
    return out if len(out) >= 2 else [points[0], points[-1]]


def text_overlap_ratio(path, ocr_items, width, height):
    """Return fraction of path points lying inside OCR boxes (annotation hint only)."""
    boxes = []
    for item in ocr_items:
        if float(item.get('confidence', 0)) < 28 or len(str(item.get('text', ''))) < 2:
            continue
        box = item.get('bbox') or []
        if len(box) != 4:
            continue
        x, y, w, h = [int(v) for v in box]
        pad = 3
        boxes.append((x - pad, y - pad, x + w + pad, y + h + pad))
    if not boxes:
        return 0.0
    hits = 0
    for x, y in path:
        if any(x0 <= x <= x1 and y0 <= y <= y1 for x0, y0, x1, y1 in boxes):
            hits += 1
    return hits / max(1, len(path))


def trace_paths(skeleton: np.ndarray, preserve_details: bool, ocr_items=None):
    height, width = skeleton.shape
    pixels, adjacency = build_pixel_graph(skeleton)
    pairs = pair_continuations(adjacency)
    raw_paths = extract_graph_paths(adjacency, pairs)
    diagonal_scale = math.sqrt(width * height)
    min_primary_length = max(11.0, diagonal_scale * (0.011 if preserve_details else 0.016))
    min_primary_span = max(9.0, diagonal_scale * 0.008)
    min_straightness = 0.42 if preserve_details else 0.52
    primary, detail, annotations = [], [], []
    ocr_items = ocr_items or []

    for path in raw_paths:
        if len(path) < 2:
            continue
        length, straightness, span_x, span_y = path_metrics(path)
        if length < 3.0:
            continue
        overlap = text_overlap_ratio(path, ocr_items, width, height)
        simplified = simplify_path(path)
        record = {
            'points': [[round(x / max(1, width - 1) * 1000, 2), round(y / max(1, height - 1) * 1000, 2)] for x, y in simplified],
            'lengthPx': round(length, 2),
            'straightness': round(straightness, 3),
            'spanPx': round(max(span_x, span_y), 2),
            'ocrOverlap': round(overlap, 3),
        }
        if overlap >= 0.68 and length >= 5.0:
            annotations.append(record)
            continue
        is_primary = (
            length >= min_primary_length
            and max(span_x, span_y) >= min_primary_span
            and (straightness >= min_straightness or length >= min_primary_length * 2.2)
        )
        if is_primary:
            primary.append(record)
        elif length >= 5.0:
            detail.append(record)

    # Longest paths first for deterministic drawing and concise diagnostics.
    primary.sort(key=lambda r: r['lengthPx'], reverse=True)
    detail.sort(key=lambda r: r['lengthPx'], reverse=True)
    annotations.sort(key=lambda r: r['lengthPx'], reverse=True)
    return primary[:1200], detail[:3000], annotations[:3000], {
        'skeletonPixels': len(pixels),
        'rawPathCount': len(raw_paths),
        'primaryPathCount': len(primary),
        'detailPathCount': len(detail),
        'annotationPathCount': len(annotations),
        'minPrimaryLengthPx': round(min_primary_length, 2),
        'minStraightness': min_straightness,
    }


def run_ocr(image: np.ndarray, ink: np.ndarray):
    try:
        import pytesseract
        from pytesseract import Output
        # White paper and black strokes are more OCR-friendly than the blue source image.
        ocr_img = 255 - ink
        scale = min(1.8, 1800 / max(ocr_img.shape))
        if scale > 1.05:
            ocr_img = cv2.resize(ocr_img, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
        data = pytesseract.image_to_data(
            ocr_img, lang='rus+eng', config='--oem 1 --psm 11',
            output_type=Output.DICT, timeout=18
        )
        inv_scale = 1.0 / scale
        items = []
        for i, raw in enumerate(data.get('text', [])):
            text = ' '.join(str(raw).split()).strip()
            try:
                confidence = float(data['conf'][i])
            except (ValueError, TypeError, KeyError):
                confidence = -1
            if not text or confidence < 22:
                continue
            x = int(round(int(data['left'][i]) * inv_scale))
            y = int(round(int(data['top'][i]) * inv_scale))
            w = int(round(int(data['width'][i]) * inv_scale))
            h = int(round(int(data['height'][i]) * inv_scale))
            items.append({'text': text[:100], 'confidence': round(confidence, 1), 'bbox': [x, y, w, h]})
        # De-duplicate repeated token boxes without pretending OCR is authoritative.
        seen = set()
        unique = []
        for item in sorted(items, key=lambda q: (-q['confidence'], q['bbox'][1], q['bbox'][0])):
            key = item['text'].casefold()
            if key in seen:
                continue
            seen.add(key)
            unique.append(item)
        unique.sort(key=lambda q: (q['bbox'][1], q['bbox'][0]))
        return unique[:120], None
    except Exception as exc:
        return [], str(exc)[:300]


def main():
    if len(sys.argv) not in (3, 4):
        print('Usage: processor.py INPUT_IMAGE OUTPUT_DIR [preserve-details:0|1]', file=sys.stderr)
        return 2
    source = Path(sys.argv[1])
    out_dir = Path(sys.argv[2])
    preserve_details = len(sys.argv) == 4 and sys.argv[3] == '1'
    out_dir.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()

    image = read_image(source)
    height, width = image.shape[:2]
    ink, method, ink_stats = extract_ink(image)
    skeleton, thinning_iterations = zhang_suen_thinning(ink)
    ocr_items, ocr_error = run_ocr(image, ink)
    primary, detail, annotations, graph_stats = trace_paths(skeleton, preserve_details, ocr_items)

    if not primary:
        raise RuntimeError(
            'Не удалось выделить длинные штрихи. Попробуйте фото с более контрастной ручкой, '
            'без бликов и строго сверху. Автоматическая подмена схемы не выполнялась.'
        )

    cv2.imwrite(str(out_dir / 'clean.png'), 255 - ink)
    cv2.imwrite(str(out_dir / 'centerline.png'), skeleton)

    vectors = {
        'schemaVersion': 1,
        'title': 'Векторная трассировка эскиза',
        'sourceSize': {'width': width, 'height': height},
        'preserveDetails': preserve_details,
        'primaryPaths': primary,
        'detailPaths': detail,
        'annotationPaths': annotations,
        'ocr': ocr_items,
        'diagnostics': {
            'thresholdMethod': method,
            'thinningIterations': thinning_iterations,
            **ink_stats,
            **graph_stats,
            'processingSeconds': round(time.perf_counter() - started, 2),
            'ocrError': ocr_error,
        },
        'warnings': [
            'Координаты получены трассировкой пикселей, а не семантическим распознаванием труб.',
            'Реальный масштаб и размеры по фотографии не калиброваны.',
            'Подписи, размерные засечки и пересечения требуют проверки по оригиналу.',
        ],
    }
    (out_dir / 'vectors.json').write_text(json.dumps(vectors, ensure_ascii=False), encoding='utf-8')

    result = {
        'ok': True,
        'source_size': {'width': width, 'height': height},
        'processed_size': {'width': width, 'height': height},
        'trace': {
            'width': width,
            'height': height,
            'sheet': 'A3 · масштаб не калиброван',
            'primaryPaths': graph_stats['primaryPathCount'],
            'detailPaths': graph_stats['detailPathCount'],
            'annotationPaths': graph_stats['annotationPathCount'],
            'skeletonPixels': graph_stats['skeletonPixels'],
            'inkRatio': ink_stats['inkRatio'],
            'thresholdMethod': method,
        },
        'ocr': ocr_items,
        'ocr_error': ocr_error,
        'note': 'Получена векторная трассировка центральных линий штрихов. Это не готовая инженерная CAD-модель: геометрию, соединения и размеры нужно сверить с исходным фото.',
    }
    (out_dir / 'result.json').write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')
    print(json.dumps({'ok': True, **result['trace']}, ensure_ascii=False))
    print(f"Preprocess + skeleton complete in {time.perf_counter() - started:.2f}s", file=sys.stderr, flush=True)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as exc:
        print(f'Ошибка обработки: {exc}', file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)
