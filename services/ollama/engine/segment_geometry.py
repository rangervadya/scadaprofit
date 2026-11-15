"""Segment extraction and cluster geometry (P2-1).

Moved from processor.py verbatim: pure geometry over binary ink masks. No OCR,
no network, no module state.
"""

from __future__ import annotations

import math
from typing import Any

import cv2
import numpy as np


def angle_deg(seg: tuple[float,float,float,float]) -> float:
    x1,y1,x2,y2 = seg
    return math.degrees(math.atan2(y2-y1, x2-x1)) % 180


def seg_length(seg: tuple[float,float,float,float]) -> float:
    return math.hypot(seg[2]-seg[0], seg[3]-seg[1])



def _sample_line_support(ink_dilated: np.ndarray, x1: float, y1: float, x2: float, y2: float) -> float:
    h, w = ink_dilated.shape[:2]
    length = math.hypot(x2 - x1, y2 - y1)
    n = max(3, int(length / 2.0))
    xs = np.clip(np.rint(np.linspace(x1, x2, n)).astype(int), 0, w - 1)
    ys = np.clip(np.rint(np.linspace(y1, y2, n)).astype(int), 0, h - 1)
    return float(np.mean(ink_dilated[ys, xs] > 0))


def _same_ink_band(a: dict[str, Any], b: dict[str, Any], ink: np.ndarray,
                   origin: tuple[float, float], direction: tuple[float, float],
                   normal: tuple[float, float], overlap_interval: tuple[float, float]) -> bool:
    """True when both detections lie inside one continuous thick pen stroke."""
    ax, ay = origin
    ux, uy = direction
    nx, ny = normal
    lo, hi = overlap_interval
    if hi - lo < 8:
        return False
    # Perpendicular coordinate of B varies slightly when LSD/Hough disagree on angle.
    bx0 = (b['x1'] - ax) * nx + (b['y1'] - ay) * ny
    bx1 = (b['x2'] - ax) * nx + (b['y2'] - ay) * ny
    bp0 = (b['x1'] - ax) * ux + (b['y1'] - ay) * uy
    bp1 = (b['x2'] - ax) * ux + (b['y2'] - ay) * uy
    if abs(bp1 - bp0) < 1e-6:
        return False
    h, w = ink.shape[:2]
    samples = np.linspace(lo + 1, hi - 1, max(7, min(31, int((hi - lo) / 8))))
    valid_sections = 0
    for along in samples:
        fraction = max(0.0, min(1.0, (along - bp0) / (bp1 - bp0)))
        b_perp = bx0 + (bx1 - bx0) * fraction
        cross = np.linspace(0.0, b_perp, max(2, int(abs(b_perp)) + 1))
        xs = np.clip(np.rint(ax + ux * along + nx * cross).astype(int), 0, w - 1)
        ys = np.clip(np.rint(ay + uy * along + ny * cross).astype(int), 0, h - 1)
        occupied = ink[ys, xs] > 0
        # Detectors may sit one pixel outside either edge of the same thick
        # stroke. Ignore only those outer blanks; any blank *between* ink runs
        # is a real separation and protects two nearby parallel lines.
        hits = np.flatnonzero(occupied)
        if hits.size:
            first, last = int(hits[0]), int(hits[-1])
            if not np.any(~occupied[first:last + 1]):
                valid_sections += 1
    return valid_sections / max(1, len(samples)) >= 0.78


def _merge_aligned_duplicate(a: dict[str, Any], b: dict[str, Any], ink: np.ndarray,
                             ink_dilated: np.ndarray, continuity_gap: float,
                             offset_tolerance: float = 2.8) -> dict[str, Any] | None:
    """Merge repeated LSD/Hough detections without collapsing separate parallel lines."""
    angle_delta = abs(((a['angle'] - b['angle'] + 90) % 180) - 90)
    length_a = float(a.get('length') or math.hypot(a['x2'] - a['x1'], a['y2'] - a['y1']))
    length_b = float(b.get('length') or math.hypot(b['x2'] - b['x1'], b['y2'] - b['y1']))
    if length_a < 1 or length_b < 1:
        return None
    # Differentiate ordinary duplicate vectors from a short, noisy detector
    # fragment which follows the same continuous, thicker ink stroke.
    short_fragment = min(length_a, length_b) / max(length_a, length_b) < 0.35
    # Allow ordinary detector pairs a wider preliminary angle window.
    # A mismatch above 3 degrees is still rejected below unless the source
    # pixels prove that both paths belong to one continuous ink band.
    if angle_delta > (15.0 if short_fragment else 20.0):
        return None

    ax, ay = a['x1'], a['y1']
    dx, dy = a['x2'] - ax, a['y2'] - ay
    ux, uy = dx / length_a, dy / length_a
    nx, ny = -uy, ux
    amid_x, amid_y = (a['x1'] + a['x2']) / 2, (a['y1'] + a['y2']) / 2
    bmid_x, bmid_y = (b['x1'] + b['x2']) / 2, (b['y1'] + b['y2']) / 2
    offset = (bmid_x - amid_x) * nx + (bmid_y - amid_y) * ny

    def project(x: float, y: float) -> float:
        return (x - ax) * ux + (y - ay) * uy

    ai = sorted((project(a['x1'], a['y1']), project(a['x2'], a['y2'])))
    bi = sorted((project(b['x1'], b['y1']), project(b['x2'], b['y2'])))
    overlap_lo, overlap_hi = max(ai[0], bi[0]), min(ai[1], bi[1])
    overlap = max(0.0, overlap_hi - overlap_lo)
    short_length = min(length_a, length_b)
    overlap_ratio = overlap / max(short_length, 1.0)
    gap = max(0.0, max(ai[0], bi[0]) - min(ai[1], bi[1]))

    band_match = False
    if overlap >= max(8.0, short_length * 0.18):
        band_match = _same_ink_band(a, b, ink, (ax, ay), (ux, uy), (nx, ny), (overlap_lo, overlap_hi))
    # A small geometric offset alone is not enough: verify that the two
    # detector paths sit inside one uninterrupted pen stroke. This protects
    # close parallel lines separated by even a narrow white gap.
    if abs(offset) > min(1.2, offset_tolerance) and not band_match:
        return None
    if angle_delta > 3.0 and not band_match:
        return None

    connected = overlap_ratio >= 0.18
    if not connected and 0 < gap <= continuity_gap and abs(offset) <= offset_tolerance:
        left_end = ai[1] if ai[1] < bi[0] else bi[1]
        right_start = bi[0] if ai[1] < bi[0] else ai[0]
        mid_perp = offset * min(length_a, length_b) / max(min(length_a, length_b), 1.0)
        gx1, gy1 = ax + ux * left_end + nx * mid_perp, ay + uy * left_end + ny * mid_perp
        gx2, gy2 = ax + ux * right_start + nx * mid_perp, ay + uy * right_start + ny * mid_perp
        connected = _sample_line_support(ink_dilated, gx1, gy1, gx2, gy2) >= 0.42
    if not connected:
        return None

    lo, hi = min(ai[0], bi[0]), max(ai[1], bi[1])
    centre_offset = (offset * length_b) / (length_a + length_b)
    x1, y1 = ax + ux * lo + nx * centre_offset, ay + uy * lo + ny * centre_offset
    x2, y2 = ax + ux * hi + nx * centre_offset, ay + uy * hi + ny * centre_offset
    preferred = max((a, b), key=lambda item: (item.get('support', 0), item.get('source') == 'LSD'))
    merged = dict(preferred)
    merged.update({
        'x1': float(x1), 'y1': float(y1), 'x2': float(x2), 'y2': float(y2),
        'length': float(math.hypot(x2 - x1, y2 - y1)),
        'support': max(float(a.get('support', 0)), float(b.get('support', 0))),
        'angle': angle_deg((x1, y1, x2, y2)),
        'source': preferred.get('source', 'LSD'),
        'detectors': sorted(set((a.get('detectors') or [a.get('source')]) + (b.get('detectors') or [b.get('source')]))),
        'ocr_overlap': max(float(a.get('ocr_overlap', 0)), float(b.get('ocr_overlap', 0))),
        'suggested_role': 'text_or_dimension' if max(float(a.get('ocr_overlap', 0)), float(b.get('ocr_overlap', 0))) >= 0.16 and not (a.get('text_crossing') or b.get('text_crossing')) else 'line_candidate',
        'text_crossing': bool(a.get('text_crossing') or b.get('text_crossing')),
    })
    return merged


def _expanded_text_box(box: dict[str, Any]) -> tuple[float, float, float, float]:
    """Expand OCR boxes enough to cover handwriting ascenders, descenders and tails."""
    x, y, bw, bh = (float(box.get(key, 0)) for key in ('x', 'y', 'w', 'h'))
    pad_x = max(3.0, min(22.0, bw * 0.20))
    pad_y = max(3.0, min(18.0, bh * 0.50))
    return x - pad_x, y - pad_y, x + bw + pad_x, y + bh + pad_y


def _segment_text_box_metrics(seg: tuple[float, float, float, float], box: dict[str, Any],
                              ink_dilated: np.ndarray) -> tuple[float, bool]:
    """Measure segment overlap with a padded text box and detect a real through-line.

    A route crossing a label is preserved only when the source ink continues
    collinearly on both sides. A glyph/letter stroke that merely protrudes from
    an OCR box normally has support on one side only and is rejected.
    """
    x, y, bw, bh = (float(box.get(key, 0)) for key in ('x', 'y', 'w', 'h'))
    if bw <= 0 or bh <= 0:
        return 0.0, False
    left, top, right, bottom = _expanded_text_box(box)
    x1, y1, x2, y2 = map(float, seg)
    length = math.hypot(x2 - x1, y2 - y1)
    if length < 1:
        return 0.0, False

    count = max(11, min(121, int(length / 1.5) + 1))
    ts = np.linspace(0.0, 1.0, count)
    xs = x1 + (x2 - x1) * ts
    ys = y1 + (y2 - y1) * ts
    inside = (xs >= left) & (xs <= right) & (ys >= top) & (ys <= bottom)
    coverage = float(np.mean(inside))
    if coverage < 0.10:
        return coverage, False

    ux, uy = (x2 - x1) / length, (y2 - y1) / length
    corners = [(left, top), (right, top), (right, bottom), (left, bottom)]
    projections = [(cx - x1) * ux + (cy - y1) * uy for cx, cy in corners]
    lo, hi = min(projections), max(projections)
    h, w = ink_dilated.shape[:2]
    distances = np.linspace(2.0, max(7.0, min(20.0, math.hypot(bw, bh) * 0.32)), 9)

    def side_support(sign: float) -> float:
        hits = 0
        for distance in distances:
            along = (lo - distance) if sign < 0 else (hi + distance)
            px, py = x1 + ux * along, y1 + uy * along
            ix, iy = int(round(px)), int(round(py))
            supported = False
            # A compact 3x3 neighbourhood tolerates pen width without picking
            # up unrelated neighbouring handwriting strokes.
            for oy in range(-1, 2):
                for ox in range(-1, 2):
                    qx, qy = ix + ox, iy + oy
                    if 0 <= qx < w and 0 <= qy < h and ink_dilated[qy, qx] > 0:
                        supported = True
                        break
                if supported:
                    break
            hits += int(supported)
        return hits / len(distances)

    left_support = side_support(-1.0)
    right_support = side_support(1.0)
    through = (
        length >= max(42.0, math.hypot(bw, bh) * 1.45)
        and coverage >= 0.16
        and left_support >= 0.66
        and right_support >= 0.66
    )
    return coverage, through


def _segment_text_mask_metrics(seg: tuple[float, float, float, float], text_mask: np.ndarray,
                               ink_dilated: np.ndarray) -> tuple[float, bool]:
    """Measure overlap with the union of all OCR regions and detect a true through-line.

    This catches a handwritten word split into several OCR boxes. A candidate
    crossing the masked union is retained only when source ink is visible on
    both sides of the complete masked span; a glyph stroke normally has no such
    bilateral continuation.
    """
    x1, y1, x2, y2 = map(float, seg)
    length = math.hypot(x2 - x1, y2 - y1)
    if length < 1 or text_mask.size == 0:
        return 0.0, False
    count = max(11, min(401, int(length / 1.25) + 1))
    ts = np.linspace(0.0, 1.0, count)
    xs = np.clip(np.rint(x1 + (x2 - x1) * ts).astype(int), 0, text_mask.shape[1] - 1)
    ys = np.clip(np.rint(y1 + (y2 - y1) * ts).astype(int), 0, text_mask.shape[0] - 1)
    inside = text_mask[ys, xs] > 0
    coverage = float(np.mean(inside))
    if coverage < 0.08:
        return coverage, False
    indices = np.flatnonzero(inside)
    if not len(indices):
        return coverage, False
    first_s = float(ts[indices[0]] * length)
    last_s = float(ts[indices[-1]] * length)
    masked_span = max(0.0, last_s - first_s)
    if first_s < 3.0 or (length - last_s) < 3.0 or length < max(36.0, masked_span + 12.0):
        return coverage, False

    ux, uy = (x2 - x1) / length, (y2 - y1) / length
    h, w = ink_dilated.shape[:2]
    distances = np.linspace(1.0, min(8.0, max(3.0, masked_span * 0.12)), 7)

    def support_at_boundary(boundary_s: float, sign: float) -> float:
        hits = 0
        for distance in distances:
            along = boundary_s + sign * distance
            px, py = x1 + ux * along, y1 + uy * along
            ix, iy = int(round(px)), int(round(py))
            supported = False
            for oy in range(-1, 2):
                for ox in range(-1, 2):
                    qx, qy = ix + ox, iy + oy
                    if 0 <= qx < w and 0 <= qy < h and ink_dilated[qy, qx] > 0:
                        supported = True
                        break
                if supported:
                    break
            hits += int(supported)
        return hits / len(distances)

    left_support = support_at_boundary(first_s, -1.0)
    right_support = support_at_boundary(last_s, 1.0)
    through = left_support >= 0.67 and right_support >= 0.67
    return coverage, through


def _segment_inside_text_box(seg: tuple[float, float, float, float], box: dict[str, Any],
                             ink_dilated: np.ndarray) -> bool:
    """True for a text stroke; false for a pipe demonstrably continuing through text."""
    coverage, through = _segment_text_box_metrics(seg, box, ink_dilated)
    return coverage >= 0.16 and not through


def _confirmed_text_boxes(annotations: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    """Build a conservative geometry mask from source-aware OCR evidence.

    The previous policy masked every Tesseract candidate, including low-score
    noise. On the user's saved job that removed 64.1% of all source ink and cut
    the primary graph from 531 edges (verified-only comparison) to 172. Keep
    dense note-row boxes because they were found by a dedicated block detector;
    keep Qwen tile boxes from confidence 25 upward; use Tesseract only from 55
    upward. Low-confidence OCR remains available in TEXT_REVIEW but cannot erase
    linework merely because Tesseract proposed a rectangle.
    """
    boxes: list[dict[str, Any]] = []
    for item in annotations or []:
        box = item.get('bbox')
        if not isinstance(box, dict) or not all(key in box for key in ('x', 'y', 'w', 'h')):
            continue
        try:
            width = float(box.get('w', 0) or 0)
            height = float(box.get('h', 0) or 0)
            confidence = float(item.get('confidence', 0) or 0)
        except (TypeError, ValueError):
            continue
        if width < 2 or height < 2:
            continue
        source = str(item.get('source') or '')
        if source == 'qwen3-vl-block':
            eligible = True  # Dedicated numbered-note row: preserve its ink as text.
        elif source == 'qwen3-vl':
            eligible = bool(item.get('verified')) or confidence >= 25.0
        elif source == 'tesseract':
            eligible = bool(item.get('verified')) or confidence >= 55.0
        elif source in {'openrouter-vision-ocr', 'moss-vl-ocr'}:
            eligible = bool(item.get('verified')) or confidence >= 40.0
        else:
            # Backward compatibility for explicitly supplied/manual masks.
            eligible = bool(item.get('geometry_exclude') or item.get('verified') or confidence >= 55.0)
        if eligible:
            boxes.append(box)
    return boxes


def _text_region_mask(shape: tuple[int, int], annotations: list[dict[str, Any]] | None) -> np.ndarray:
    """Raster mask of expanded OCR regions; retained as an inspectable diagnostic."""
    height, width = shape
    mask = np.zeros((height, width), dtype=np.uint8)
    for box in _confirmed_text_boxes(annotations):
        left, top, right, bottom = _expanded_text_box(box)
        x1 = max(0, int(math.floor(left)))
        y1 = max(0, int(math.floor(top)))
        x2 = min(width - 1, int(math.ceil(right)))
        y2 = min(height - 1, int(math.ceil(bottom)))
        if x2 >= x1 and y2 >= y1:
            cv2.rectangle(mask, (x1, y1), (x2, y2), 255, -1)
    return mask

def extract_segments(gray: np.ndarray, ink: np.ndarray, annotations: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    h, w = gray.shape[:2]
    min_dim = min(w, h)
    # A slightly higher minimum prevents tiny letter fragments and dimension
    # ticks from dominating the line graph; long pipe continuations remain.
    min_lsd_len = max(13.0, min_dim * 0.014)
    min_hough_len = max(14, int(min_dim * 0.015))
    continuity_gap = max(4.0, min_dim * 0.004)

    lsd_img = cv2.GaussianBlur(gray, (3, 3), 0.65)
    detector = cv2.createLineSegmentDetector(cv2.LSD_REFINE_STD)
    lines = detector.detect(lsd_img)[0]
    raw: list[tuple[float, float, float, float, str, float]] = []
    if lines is not None:
        for row in lines.reshape(-1, 4):
            x1, y1, x2, y2 = map(float, row)
            length = seg_length((x1, y1, x2, y2))
            if length >= min_lsd_len:
                raw.append((x1, y1, x2, y2, 'LSD', length))

    hp = cv2.HoughLinesP(
        ink, 1, np.pi / 180,
        threshold=max(16, int(min_dim * 0.020)),
        minLineLength=min_hough_len,
        maxLineGap=max(4, int(min_dim * 0.007)),
    )
    if hp is not None:
        for row in hp.reshape(-1, 4):
            x1, y1, x2, y2 = map(float, row)
            length = seg_length((x1, y1, x2, y2))
            if length >= min_hough_len:
                raw.append((x1, y1, x2, y2, 'HOUGH', length))

    # A 5x5 halo tolerates centreline offsets and faint pen strokes. Text
    # regions are still protected by the expanded OCR mask and bilateral test.
    ink_dilated = cv2.dilate(ink, np.ones((5, 5), np.uint8), iterations=1)
    text_mask = _text_region_mask((h, w), annotations)
    candidates: list[dict[str, Any]] = []
    for x1, y1, x2, y2, source, length in raw:
        seg = (x1, y1, x2, y2)
        overlap, through_text = _segment_text_mask_metrics(seg, text_mask, ink_dilated)
        # The union mask catches words split across several OCR boxes while
        # avoiding repeated per-box raster scans for every detected segment.
        # Text/dimension strokes that intersect OCR regions are review-only.
        # Preserve only a line with clear source-ink continuation on both sides.
        if overlap >= 0.08 and not through_text:
            continue

        support = _sample_line_support(ink_dilated, x1, y1, x2, y2)
        if support < 0.15:
            continue
        candidates.append({
            'x1': x1, 'y1': y1, 'x2': x2, 'y2': y2, 'source': source,
            'length': length, 'support': support, 'angle': angle_deg(seg),
            'ocr_overlap': round(overlap, 3),
            'text_crossing': bool(through_text),
            'suggested_role': 'text_or_dimension' if overlap >= 0.16 and not through_text else 'line_candidate',
        })

    # Merge duplicate detections from LSD/Hough, but do not merge parallel
    # neighbour strokes that can represent separate pipe borders.
    candidates.sort(key=lambda item: (item['support'], item['length'], item['source'] == 'LSD'), reverse=True)
    kept: list[dict[str, Any]] = []
    for candidate in candidates:
        merged = False
        for index, existing in enumerate(kept):
            combined = _merge_aligned_duplicate(existing, candidate, ink, ink_dilated, continuity_gap)
            if combined is not None:
                kept[index] = combined
                merged = True
                break
        if not merged:
            kept.append(candidate)
    kept.sort(key=lambda item: item['length'], reverse=True)
    return kept[:2400]

def endpoint_clusters(segments: list[dict[str, Any]], radius: float = 4.5,
                      ink: np.ndarray | None = None, text_mask: np.ndarray | None = None):
    """Build a route graph, snap close ends and bridge only strict collinear gaps.

    Intersections in the middle of strokes are never unioned. A small gap is
    joined only when both endpoints are open, their tangents oppose each other,
    the offset is tiny, and neither stroke is OCR/text-like.
    """
    endpoints = []
    for index, segment in enumerate(segments):
        endpoints.append((index, 0, float(segment['x1']), float(segment['y1'])))
        endpoints.append((index, 1, float(segment['x2']), float(segment['y2'])))

    parent = list(range(len(endpoints)))
    rank = [0] * len(endpoints)

    def find(value):
        while parent[value] != value:
            parent[value] = parent[parent[value]]
            value = parent[value]
        return value

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra == rb:
            return False
        if rank[ra] < rank[rb]:
            ra, rb = rb, ra
        parent[rb] = ra
        if rank[ra] == rank[rb]:
            rank[ra] += 1
        return True

    # First join genuinely touching/near-touching endpoints (legacy tolerance).
    cell = max(1, int(radius))
    buckets: dict[tuple[int, int], list[int]] = {}
    for index, (_seg_index, _side, x, y) in enumerate(endpoints):
        key = (int(x // cell), int(y // cell))
        for bx in range(key[0] - 1, key[0] + 2):
            for by in range(key[1] - 1, key[1] + 2):
                for other in buckets.get((bx, by), []):
                    _si, _ss, ox, oy = endpoints[other]
                    if math.hypot(x - ox, y - oy) <= radius:
                        union(index, other)
        buckets.setdefault(key, []).append(index)

    # Then join tiny broken line ends only if there is strong collinear evidence.
    # With source pixels available, allow a slightly larger detector gap, but
    # only the same strict tangent + undilated-ink continuity checks can join it.
    # Without source pixels keep the old, shorter geometry-only limit.
    gap_radius = (
        max(radius + 1.0, min(48.0, radius * 10.5))
        if ink is not None else
        max(radius + 1.0, min(12.0, radius * 2.5))
    )
    ink_for_gap = cv2.dilate(ink, np.ones((5, 5), np.uint8), iterations=1) if ink is not None else None
    gap_cell = max(1, int(math.ceil(gap_radius)))
    gap_buckets: dict[tuple[int, int], list[int]] = {}
    auto_gap_pairs: list[tuple[int, int]] = []
    # Each endpoint's tangent and ink support are invariant during this pass.
    # Cache both valid vectors and rejected endpoints to avoid repeated sampling
    # when several nearby endpoints are considered as possible partners.
    inward_vector_cache: dict[int, np.ndarray | None] = {}

    def inward_vector(endpoint_index: int) -> np.ndarray | None:
        if endpoint_index in inward_vector_cache:
            return inward_vector_cache[endpoint_index]
        seg_index, side, _x, _y = endpoints[endpoint_index]
        seg = segments[seg_index]
        if seg.get('text_crossing') and ink_for_gap is None:
            inward_vector_cache[endpoint_index] = None
            return None
        if float(seg.get('ocr_overlap', 0.0)) >= 0.35:
            inward_vector_cache[endpoint_index] = None
            return None
        if ink_for_gap is not None:
            support = _sample_line_support(ink_for_gap, float(seg['x1']), float(seg['y1']),
                                           float(seg['x2']), float(seg['y2']))
            if support < 0.20:
                inward_vector_cache[endpoint_index] = None
                return None
        a = np.array([float(seg['x1']), float(seg['y1'])], dtype=float)
        b = np.array([float(seg['x2']), float(seg['y2'])], dtype=float)
        vector = (b - a) if side == 0 else (a - b)
        norm = float(np.linalg.norm(vector))
        if norm < 8.0:
            inward_vector_cache[endpoint_index] = None
            return None
        unit_vector = vector / norm
        inward_vector_cache[endpoint_index] = unit_vector
        return unit_vector

    for index, (_seg_index, _side, x, y) in enumerate(endpoints):
        key = (int(x // gap_cell), int(y // gap_cell))
        va = inward_vector(index)
        if va is not None:
            for bx in range(key[0] - 1, key[0] + 2):
                for by in range(key[1] - 1, key[1] + 2):
                    for other in gap_buckets.get((bx, by), []):
                        other_seg, _other_side, ox, oy = endpoints[other]
                        seg_index = endpoints[index][0]
                        if other_seg == seg_index or find(index) == find(other):
                            continue
                        distance = math.hypot(x - ox, y - oy)
                        if distance <= radius or distance > gap_radius:
                            continue
                        vb = inward_vector(other)
                        if vb is None:
                            continue
                        dot = float(np.dot(va, vb))
                        gap = np.array([ox - x, oy - y], dtype=float)
                        gap_norm = float(np.linalg.norm(gap))
                        if gap_norm < 1e-6:
                            continue
                        gap_unit = gap / gap_norm
                        # Reject incompatible tangent pairs before sampling the
                        # source image. This is only a short-circuit: all original
                        # geometric thresholds remain unchanged.
                        cross_a = abs(float(va[0] * gap_unit[1] - va[1] * gap_unit[0]))
                        if dot > -0.965 or float(np.dot(va, gap_unit)) > -0.92 or cross_a > 0.22:
                            continue
                        if ink_for_gap is not None:
                            # Test the actual undilated pen pixels inside the gap. Using the
                            # dilated mask here lets the two segment endpoints
                            # overlap and falsely looks like continuous ink.
                            gap_distance = gap_norm
                            gap_margin = min(3.0, gap_distance * 0.22)
                            gap_dx = (ox - x) / max(gap_distance, 1e-6)
                            gap_dy = (oy - y) / max(gap_distance, 1e-6)
                            # Sample only the inner gap; endpoint caps alone
                            # must never prove a missing pipe connection.
                            gap_support = _sample_line_support(
                                ink,
                                x + gap_dx * gap_margin,
                                y + gap_dy * gap_margin,
                                ox - gap_dx * gap_margin,
                                oy - gap_dy * gap_margin,
                            )
                            if gap_support < 0.24:
                                continue
                            if text_mask is not None:
                                gap_overlap, gap_through = _segment_text_mask_metrics((x, y, ox, oy), text_mask, ink_for_gap)
                                if gap_overlap >= 0.08 and not gap_through:
                                    continue
                        if union(index, other):
                            auto_gap_pairs.append((index, other))
        gap_buckets.setdefault(key, []).append(index)

    auto_joined_endpoint_ids = {value for pair in auto_gap_pairs for value in pair}
    groups: dict[int, list[tuple[int, int, float, float]]] = {}
    for index, endpoint in enumerate(endpoints):
        groups.setdefault(find(index), []).append(endpoint)

    nodes = []
    endpoint_to_node = {}
    root_auto = {find(value) for value in auto_joined_endpoint_ids}
    for group_index, (root, items) in enumerate(groups.items()):
        x = float(np.mean([item[2] for item in items]))
        y = float(np.mean([item[3] for item in items]))
        node_id = f'N{group_index + 1}'
        nodes.append({
            'id': node_id, 'x': round(x, 2), 'y': round(y, 2),
            'degree': len(items), 'review': len(items) == 1,
            'auto_joined_collinear': root in root_auto,
        })
        for item in items:
            endpoint_to_node[(item[0], item[1])] = node_id

    edges = []
    node_by_id = {node['id']: node for node in nodes}
    for index, segment in enumerate(segments):
        node_a = endpoint_to_node[(index, 0)]
        node_b = endpoint_to_node[(index, 1)]
        if node_a == node_b:
            continue
        snapped = [
            [node_by_id[node_a]['x'], node_by_id[node_a]['y']],
            [node_by_id[node_b]['x'], node_by_id[node_b]['y']],
        ]
        raw_geometry = [
            [round(float(segment['x1']), 2), round(float(segment['y1']), 2)],
            [round(float(segment['x2']), 2), round(float(segment['y2']), 2)],
        ]
        auto_join = bool(node_by_id[node_a]['auto_joined_collinear'] or node_by_id[node_b]['auto_joined_collinear'])
        edges.append({
            'id': f'E{len(edges) + 1}', 'from': node_a, 'to': node_b,
            'source': 'candidate',
            'confidence': round(min(0.99, 0.45 + 0.45 * float(segment.get('support', 0.0)) + min(float(segment.get('length', 0.0)) / 800, 0.12)), 2),
            'ink_support': round(float(segment.get('support', 0.0)), 3),
            'geometry': snapped, 'raw_geometry': raw_geometry,
            'review': True, 'detector': segment.get('source', 'LSD'),
            'source_segment_index': index,
            'ocr_overlap': float(segment.get('ocr_overlap', 0.0)),
            'text_crossing': bool(segment.get('text_crossing', False)),
            'suggested_role': segment.get('suggested_role', 'line_candidate'),
            'auto_joined_gap': auto_join,
            'continuation_candidate': auto_join,
        })

    adjacency: dict[str, list[int]] = {}
    for index, edge in enumerate(edges):
        adjacency.setdefault(edge['from'], []).append(index)
        adjacency.setdefault(edge['to'], []).append(index)

    seen: set[int] = set()
    component_summaries = []
    for seed in range(len(edges)):
        if seed in seen:
            continue
        stack = [seed]
        indices = []
        node_ids = set()
        while stack:
            edge_index = stack.pop()
            if edge_index in seen:
                continue
            seen.add(edge_index)
            indices.append(edge_index)
            edge = edges[edge_index]
            for node_id in (edge['from'], edge['to']):
                node_ids.add(node_id)
                stack.extend(item for item in adjacency.get(node_id, []) if item not in seen)

        comp_edges = [edges[index] for index in indices]
        points = [point for edge in comp_edges for point in edge['geometry']]
        xs = [point[0] for point in points]
        ys = [point[1] for point in points]
        dx = max(xs) - min(xs) if xs else 0.0
        dy = max(ys) - min(ys) if ys else 0.0
        extent = max(dx, dy)
        total = sum(math.dist(*edge['geometry']) for edge in comp_edges)
        edge_lengths = [math.dist(*edge['geometry']) for edge in comp_edges]
        longest = max(edge_lengths, default=0.0)
        average_length = float(np.mean(edge_lengths)) if edge_lengths else 0.0
        elongation = max(dx, dy) / max(1.0, min(dx, dy))
        edge_density = total / max(extent, 1.0)
        max_degree = max((len(adjacency.get(node_id, [])) for node_id in node_ids), default=0)
        branch_nodes = sum(1 for node_id in node_ids if len(adjacency.get(node_id, [])) >= 3)
        sharp_turns = 0
        for node_id in node_ids:
            incident = adjacency.get(node_id, [])
            if len(incident) != 2:
                continue
            vectors = []
            node = node_by_id[node_id]
            for edge_index in incident:
                geometry = edges[edge_index]['geometry']
                other = geometry[1] if edges[edge_index]['from'] == node_id else geometry[0]
                vector = np.array([other[0] - node['x'], other[1] - node['y']], dtype=float)
                norm = float(np.linalg.norm(vector))
                if norm > 1e-6:
                    vectors.append(vector / norm)
            if len(vectors) == 2:
                dot = max(-1.0, min(1.0, float(np.dot(vectors[0], vectors[1]))))
                # A straight continuation has opposite outward vectors (dot~-1).
                if dot > -0.82:
                    sharp_turns += 1
        turn_density = sharp_turns * 100.0 / max(total, 1.0)
        short_edge_ratio = sum(1 for length in edge_lengths if length < 18.0) / max(len(edge_lengths), 1)
        # A proven straight-through segment is not treated as OCR clutter. Any
        # unexplained overlap remains a text/annotation warning.
        overlap_weight = sum(
            edge_lengths[index] * float(edge.get('ocr_overlap', 0.0))
            for index, edge in enumerate(comp_edges) if not edge.get('text_crossing')
        )
        unexplained_ocr_overlap = overlap_weight / max(total, 1.0)
        text_crossing_length = sum(
            edge_lengths[index] for index, edge in enumerate(comp_edges) if edge.get('text_crossing')
        )
        text_crossing_ratio = text_crossing_length / max(total, 1.0)
        mean_ink_support = float(np.mean([
            float(edge.get('ink_support', 0.0) or 0.0) for edge in comp_edges
        ])) if comp_edges else 0.0
        max_edge_ocr_overlap = max(
            (float(edge.get('ocr_overlap', 0.0) or 0.0) for edge in comp_edges),
            default=0.0,
        )

        # Text can sometimes form long, connected strokes. Use graph shape and
        # text-box overlap together; bounding-box elongation alone is not proof
        # that a component is a pipe.
        text_crossing_suspect = (
            text_crossing_ratio >= 0.42
            and (turn_density >= 1.2 or edge_density >= 1.65 or max_degree >= 3)
        )
        coherent_route = (
            len(comp_edges) >= 2 and extent >= 48.0 and total >= 54.0
            and average_length >= 12.0 and max_degree <= 5
            and edge_density <= 4.10 and turn_density <= 4.6
            and unexplained_ocr_overlap < 0.17
            and not text_crossing_suspect
        )
        branch_route = (
            len(comp_edges) >= 3 and branch_nodes >= 1 and total >= 68.0
            and average_length >= 10.0 and max_degree <= 5
            and edge_density <= 4.35 and turn_density <= 5.0
            and unexplained_ocr_overlap < 0.16
            and not text_crossing_suspect
        )
        # Many hand-drawn pipe routes are broken into several short detector
        # edges. Accept a modestly connected route when its geometry is
        # elongated, moderately sparse, and not inside OCR regions.
        connected_line_candidate = (
            len(comp_edges) >= 2 and extent >= 34.0 and total >= 38.0
            and average_length >= 7.0 and max_degree <= 5
            and edge_density <= 5.2 and turn_density <= 7.0
            and unexplained_ocr_overlap < 0.14
            and text_crossing_ratio < 0.28
        )
        elbow_route_candidate = (
            len(comp_edges) >= 3 and extent >= 26.0 and total >= 42.0
            and average_length >= 7.0 and max_degree <= 5
            and branch_nodes <= 4 and edge_density <= 5.4
            and turn_density <= 7.2
            and unexplained_ocr_overlap < 0.12
            and text_crossing_ratio < 0.24
        )
        # A real pipe network can contain several T-junctions or a manifold,
        # so a strict max-degree<=5 rule rejects some otherwise coherent routes.
        # Admit only substantial, multi-edge, source-ink-supported networks with
        # low OCR overlap and restrained turn density. This is not based on ink
        # support alone: isolated dimensions and page borders cannot satisfy the
        # topology/branch-count requirements.
        topology_network_candidate = (
            len(comp_edges) >= 8 and extent >= 28.0 and total >= 135.0
            and average_length >= 12.0 and 2 <= branch_nodes <= 7
            and max_degree <= 8 and edge_density <= 5.6
            and turn_density <= 1.35 and mean_ink_support >= 0.40
            and unexplained_ocr_overlap < 0.10
            and max_edge_ocr_overlap < 0.18
            and text_crossing_ratio < 0.12
            and not text_crossing_suspect
        )
        text_like = (
            unexplained_ocr_overlap >= 0.16
            or (text_crossing_suspect and not branch_route)
            or (
                len(comp_edges) >= 3 and average_length < 15.0
                and short_edge_ratio >= 0.55 and turn_density >= 1.5
            )
        )
        # A dense symbol veto is relaxed only for a connected/elbow route that
        # also has multiple branches, enough total geometry, low turning and
        # very low OCR overlap. This avoids promoting compact text/glyph clusters
        # merely because they happened to pass a loose connected-route test.
        dense_route_exemption = (
            (connected_line_candidate or elbow_route_candidate)
            and len(comp_edges) >= 6 and total >= 90.0
            and branch_nodes >= 1 and average_length >= 12.0
            and turn_density <= 1.25 and max_edge_ocr_overlap < 0.08
            and text_crossing_ratio < 0.12
        )
        dense_symbol_cluster = (
            len(comp_edges) >= 4 and average_length < 20.0
            and edge_density >= 1.85
            and (max_degree >= 4 or turn_density >= 2.0)
            and not (dense_route_exemption or topology_network_candidate)
        )

        if text_like:
            role = 'text_or_annotation'
        elif dense_symbol_cluster:
            # Keep dense handwritten/symbol groups out of the clean pipe layer.
            role = 'ambiguous'
        elif (coherent_route or branch_route or connected_line_candidate
              or elbow_route_candidate or topology_network_candidate):
            role = 'line_structure'
        else:
            role = 'ambiguous'

        component_id = f'C{len(component_summaries) + 1}'
        for edge in comp_edges:
            edge['component_id'] = component_id
            edge['component_role'] = role
            edge['topology_network_candidate'] = bool(topology_network_candidate)
            edge['dense_route_exemption'] = bool(dense_route_exemption)
        component_summaries.append({
            'id': component_id, 'role': role, 'edge_count': len(comp_edges),
            'total_length': round(total, 1),
            'bbox': {'x': round(min(xs), 1) if xs else 0, 'y': round(min(ys), 1) if ys else 0,
                     'w': round(dx, 1), 'h': round(dy, 1)},
            'ocr_overlap_ratio': round(unexplained_ocr_overlap, 3),
            'text_crossing_ratio': round(text_crossing_ratio, 3),
            'average_edge_length': round(average_length, 1),
            'max_node_degree': max_degree, 'branch_nodes': branch_nodes,
            'edge_density': round(edge_density, 2), 'turn_density': round(turn_density, 2),
            'elongation': round(elongation, 2),
            'mean_ink_support': round(mean_ink_support, 3),
            'max_edge_ocr_overlap': round(max_edge_ocr_overlap, 3),
            'short_edge_ratio': round(short_edge_ratio, 3),
            'coherent_route': coherent_route, 'branch_route': branch_route,
            'connected_line_candidate': connected_line_candidate,
            'elbow_route_candidate': elbow_route_candidate,
            'topology_network_candidate': topology_network_candidate,
            'dense_route_exemption': dense_route_exemption,
            'text_crossing_suspect': text_crossing_suspect,
        })

    # Promote only small, non-text, coaxial fragments that point into a robust
    # primary component. This is deliberately stricter than the old 28 px rule.
    line_open_ends = []
    for edge in edges:
        if edge.get('component_role') != 'line_structure':
            continue
        geometry = edge.get('geometry') or []
        if len(geometry) < 2:
            continue
        for node_id, endpoint, inner in (
            (edge['from'], geometry[0], geometry[-1]),
            (edge['to'], geometry[-1], geometry[0]),
        ):
            node = node_by_id.get(node_id)
            if not node or node.get('degree') != 1:
                continue
            vector = np.array([inner[0] - endpoint[0], inner[1] - endpoint[1]], dtype=float)
            norm = float(np.linalg.norm(vector))
            if norm > 1:
                line_open_ends.append((np.array(endpoint, dtype=float), vector / norm))

    edges_by_component: dict[str, list[dict[str, Any]]] = {}
    for edge in edges:
        edges_by_component.setdefault(edge.get('component_id', ''), []).append(edge)
    summary_by_id = {item['id']: item for item in component_summaries}
    for component_id, comp_edges in edges_by_component.items():
        summary = summary_by_id.get(component_id)
        if not summary or summary.get('role') != 'ambiguous' or len(comp_edges) > 2:
            continue
        if any(float(edge.get('ocr_overlap', 0.0)) >= 0.12 or edge.get('text_crossing') for edge in comp_edges):
            continue
        promoted = False
        for edge in comp_edges:
            geometry = edge.get('geometry') or []
            if len(geometry) < 2 or not 8 <= math.dist(*geometry) <= 36:
                continue
            for endpoint, inner in ((geometry[0], geometry[-1]), (geometry[-1], geometry[0])):
                node_id = edge['from'] if endpoint == geometry[0] else edge['to']
                node = node_by_id.get(node_id)
                if not node or node.get('degree') != 1:
                    continue
                vector = np.array([inner[0] - endpoint[0], inner[1] - endpoint[1]], dtype=float)
                norm = float(np.linalg.norm(vector))
                if norm < 1:
                    continue
                vector /= norm
                for line_endpoint, line_vector in line_open_ends:
                    distance = float(np.linalg.norm(np.array(endpoint, dtype=float) - line_endpoint))
                    if distance <= 12.0 and float(np.dot(vector, line_vector)) <= -0.965:
                        promoted = True
                        break
                if promoted:
                    break
            if promoted:
                break
        if promoted:
            for edge in comp_edges:
                edge['component_role'] = 'line_structure'
                edge['continuation_candidate'] = True
            summary['role'] = 'line_structure'
            summary['continuation_candidate'] = True

    return nodes, edges, component_summaries
