#!/usr/bin/env python3
"""CAD Reconstruction Engine: non-destructive candidate geometry extraction.

Geometry and OCR are parallel channels. OCR boxes are NEVER subtracted from the
geometry image, because doing so can sever a pipe under a handwritten label.
Detected segments are candidates; ambiguous joins remain review items.
"""
from __future__ import annotations
import argparse
import json
import math
import os
import re
import sys
import base64
import urllib.request
from io import BytesIO
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from PIL import Image, ImageOps


def load_image(path: str) -> np.ndarray:
    pil = ImageOps.exif_transpose(Image.open(path)).convert('RGB')
    return cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)


def normalize_document(bgr: np.ndarray) -> tuple[np.ndarray, dict[str, Any]]:
    """Flatten uneven paper lighting; do not crop or warp content."""
    h, w = bgr.shape[:2]
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    # Background estimate larger than text/pipe widths.
    k = max(31, (min(h, w) // 12) | 1)
    bg = cv2.medianBlur(gray, k)
    norm = cv2.divide(gray, np.maximum(bg, 1), scale=245)
    norm = np.clip(norm, 0, 255).astype(np.uint8)
    # Mild contrast stretch, not hard binarization.
    p1, p99 = np.percentile(norm, [1, 99])
    if p99 > p1 + 10:
        norm = np.clip((norm.astype(np.float32) - p1) * (255.0 / (p99 - p1)), 0, 255).astype(np.uint8)
    return norm, {"background_kernel": int(k), "contrast_p01": float(p1), "contrast_p99": float(p99)}


def make_ink_mask(bgr: np.ndarray, norm_gray: np.ndarray) -> np.ndarray:
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    h, s, v = cv2.split(hsv)
    # Blue / violet pen plus dark pencil / black ink. Keep separate categories only
    # as a union; do not classify OCR regions as non-geometry.
    blue = ((h >= 82) & (h <= 155) & (s >= 22) & (v <= 252)).astype(np.uint8) * 255
    dark = (norm_gray < 158).astype(np.uint8) * 255
    combined = cv2.bitwise_or(blue, dark)
    # Remove isolated sensor speckles while retaining thin strokes.
    n, labels, stats, _ = cv2.connectedComponentsWithStats(combined, 8)
    out = np.zeros_like(combined)
    min_area = 2 if combined.size < 2_000_000 else 3
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] >= min_area:
            out[labels == i] = 255
    return out


def _parse_json_object(content: str) -> dict[str, Any]:
    """Parse a JSON object even when a vision model surrounds it with prose."""
    text = re.sub(r'<think>.*?</think>', '', str(content or ''), flags=re.S).strip()
    try:
        value = json.loads(text)
        if isinstance(value, dict):
            return value
    except Exception:
        pass
    decoder = json.JSONDecoder()
    for index, char in enumerate(text):
        if char != '{':
            continue
        try:
            value, _ = decoder.raw_decode(text[index:])
            if isinstance(value, dict):
                return value
        except Exception:
            continue
    raise ValueError('Модель не вернула JSON-объект с annotations.')


def _qwen_annotations(image_path: str, original_width: int, original_height: int) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Read handwritten labels with a local Ollama vision model; never alter geometry."""
    url = os.getenv('OLLAMA_CHAT_URL', 'http://127.0.0.1:11434/api/chat').strip()
    model = os.getenv('QWEN_MODEL', 'qwen3-vl:4b').strip()
    try:
        max_edge = max(1024, int(os.getenv('QWEN_MAX_IMAGE_EDGE', '2304')))
        timeout = max(10.0, float(os.getenv('QWEN_OCR_TIMEOUT', '85')))
        with Image.open(image_path) as source:
            rgb = ImageOps.exif_transpose(source).convert('RGB')
        src_w, src_h = rgb.size
        resize_scale = min(1.0, max_edge / max(src_w, src_h))
        if resize_scale < 1.0:
            rgb = rgb.resize((max(1, round(src_w * resize_scale)), max(1, round(src_h * resize_scale))), Image.Resampling.LANCZOS)
        image_buffer = BytesIO()
        rgb.save(image_buffer, format='JPEG', quality=91, optimize=True)
        encoded = base64.b64encode(image_buffer.getvalue()).decode('ascii')
        prompt = (
            'Ты модуль OCR для рукописного инженерного чертежа трубопровода. '
            'Распознавай ТОЛЬКО текстовые подписи, рукописные буквы и цифры, '
            'обозначения диаметров (Ø, DN, Ду), маркировки, числовые размеры и единицы измерения. '
            'Не описывай линии, не придумывай текст и не восстанавливай нечитаемые символы по догадке. '
            'Для каждого уверенно читаемого отдельного фрагмента верни text, bbox и confidence от 0 до 100. '
            'Это именно OCR: верни буквенно-цифровую надпись как текстовую строку, не описывай и не обводи её штрихи. '
            'Не включай в bbox трубы, линии-выноски, стрелки, рамки и соседние графические элементы. '
            f'Размер переданного изображения: {rgb.width}x{rgb.height} пикселей. '
            'bbox должен содержать x, y, w, h в пикселях этого изображения, начало координат слева сверху. '
            'Рамка должна плотно охватывать только чернила символов, с небольшим запасом не более 2 пикселей. '
            'Сквозная линия трубы, проходящая рядом с текстом или под ним, не является частью текста. '
            'Если текст нельзя прочитать уверенно, не включай его. '
            'Ответь только JSON вида {"annotations":[{"text":"DN 50",'
            '"bbox":{"x":10,"y":20,"w":50,"h":18},"confidence":90}]}.'
        )
        payload = {
            'model': model,
            'messages': [{'role': 'user', 'content': prompt, 'images': [encoded]}],
            'stream': False,
            'format': 'json',
            'options': {'temperature': 0, 'num_ctx': 8192},
        }
        request = urllib.request.Request(
            url, data=json.dumps(payload, ensure_ascii=False).encode('utf-8'),
            headers={'Content-Type': 'application/json'}, method='POST'
        )
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = json.loads(response.read().decode('utf-8'))
        content = (body.get('message') or {}).get('content', '')
        parsed = _parse_json_object(content)
        raw_items = parsed.get('annotations', [])
        if not isinstance(raw_items, list):
            raise ValueError('Поле annotations от Qwen должно быть массивом.')

        result: list[dict[str, Any]] = []
        for raw in raw_items:
            if not isinstance(raw, dict):
                continue
            text = re.sub(r'\s+', ' ', str(raw.get('text', ''))).strip()
            bbox = raw.get('bbox') or raw.get('box') or raw.get('bbox_2d')
            if isinstance(bbox, (list, tuple)) and len(bbox) == 4:
                x1, y1, x2, y2 = map(float, bbox)
                box = {'x': x1, 'y': y1, 'w': x2 - x1, 'h': y2 - y1}
            elif isinstance(bbox, dict):
                try:
                    box = {key: float(bbox[key]) for key in ('x', 'y', 'w', 'h')}
                except (KeyError, TypeError, ValueError):
                    continue
            else:
                continue
            try:
                confidence = float(raw.get('confidence', raw.get('score', 0)))
            except (TypeError, ValueError):
                confidence = 0.0
            # Qwen's coordinates refer to the resized image supplied to Ollama.
            x = int(round(box['x'] / resize_scale))
            y = int(round(box['y'] / resize_scale))
            bw = int(round(box['w'] / resize_scale))
            bh = int(round(box['h'] / resize_scale))
            x = max(0, min(original_width - 1, x))
            y = max(0, min(original_height - 1, y))
            bw = max(0, min(original_width - x, bw))
            bh = max(0, min(original_height - y, bh))
            if not text or bw < 2 or bh < 2:
                continue
            # A high-confidence model reading is preselected for CAD export;
            # the user can still edit it or uncheck it in the annotation panel.
            accepted = confidence >= 65 and bool(re.search(r'[A-Za-zА-Яа-я0-9ØøΦφ]', text))
            result.append({
                'id': f'Q{len(result) + 1}', 'text': text,
                'confidence': round(max(0.0, min(100.0, confidence)), 1),
                'bbox': {'x': x, 'y': y, 'w': bw, 'h': bh},
                'verified': accepted, 'include': accepted, 'source': 'qwen3-vl'
            })
        return result, {'available': True, 'model': model, 'annotations': len(result), 'error': None}
    except Exception as error:
        reason = str(error).strip() or error.__class__.__name__
        return [], {'available': False, 'model': model, 'annotations': 0, 'error': reason[:220]}


def _boxes_overlap(a: dict[str, Any], b: dict[str, Any]) -> float:
    ax, ay, aw, ah = (float(a.get(k, 0)) for k in ('x', 'y', 'w', 'h'))
    bx, by, bw, bh = (float(b.get(k, 0)) for k in ('x', 'y', 'w', 'h'))
    ix = max(0.0, min(ax + aw, bx + bw) - max(ax, bx))
    iy = max(0.0, min(ay + ah, by + bh) - max(ay, by))
    intersection = ix * iy
    union = aw * ah + bw * bh - intersection
    return intersection / union if union > 0 else 0.0


def ocr_annotations(image_path: str, gray: np.ndarray) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Run Qwen first, then use Tesseract as a fallback/supplement."""
    h, w = gray.shape[:2]
    qwen_items, qwen_status = _qwen_annotations(image_path, w, h)
    tesseract_items: list[dict[str, Any]] = []
    tesseract_error = None
    try:
        import pytesseract
        from pytesseract import Output
        data = pytesseract.image_to_data(
            Image.fromarray(gray), lang='rus+eng', config='--oem 1 --psm 11', output_type=Output.DICT
        )
        for i, raw in enumerate(data.get('text', [])):
            text = re.sub(r'\s+', ' ', str(raw)).strip()
            try:
                confidence = float(data['conf'][i])
            except Exception:
                confidence = -1
            if not text or confidence < 20:
                continue
            x, y = int(data['left'][i]), int(data['top'][i])
            bw, bh = int(data['width'][i]), int(data['height'][i])
            if bw < 2 or bh < 2:
                continue
            box = {'x': x, 'y': y, 'w': bw, 'h': bh}
            # Prefer the vision model when two OCR engines refer to the same mark.
            if any(_boxes_overlap(box, item['bbox']) >= 0.22 for item in qwen_items):
                continue
            accepted = confidence >= 68 and bool(re.search(r'[A-Za-zА-Яа-я0-9ØøΦφ]', text))
            tesseract_items.append({
                'id': f'T{len(tesseract_items) + 1}', 'text': text,
                'confidence': round(confidence, 1), 'bbox': box,
                'verified': accepted, 'include': accepted, 'source': 'tesseract'
            })
    except Exception as error:
        tesseract_error = str(error)[:180]

    # Stable, unique IDs across both OCR engines.
    items = qwen_items + tesseract_items
    for index, item in enumerate(items, 1):
        item['id'] = f'A{index}'
    status = {
        'qwen': qwen_status,
        'tesseract': {'available': tesseract_error is None, 'annotations': len(tesseract_items), 'error': tesseract_error}
    }
    return items, status


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
        # Allow one antialiasing/threshold pixel at a detected stroke edge, but
        # a white gap between two distinct parallel marks breaks the match.
        longest_blank = 0
        current_blank = 0
        for hit in occupied:
            if hit:
                current_blank = 0
            else:
                current_blank += 1
                longest_blank = max(longest_blank, current_blank)
        if longest_blank == 0:
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
    if angle_delta > (15.0 if short_fragment else 3.0):
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
        'suggested_role': 'text_or_dimension' if max(float(a.get('ocr_overlap', 0)), float(b.get('ocr_overlap', 0))) >= 0.30 else 'line_candidate',
    })
    return merged


def _segment_inside_text_box(seg: tuple[float, float, float, float], box: dict[str, Any],
                             ink_dilated: np.ndarray) -> bool:
    """Identify glyph strokes inside a confirmed OCR box, but keep a pipe crossing it."""
    x, y, bw, bh = (float(box.get(key, 0)) for key in ('x', 'y', 'w', 'h'))
    if bw <= 0 or bh <= 0:
        return False
    pad = max(2.0, min(8.0, min(bw, bh) * 0.10))
    left, top, right, bottom = x - pad, y - pad, x + bw + pad, y + bh + pad
    x1, y1, x2, y2 = map(float, seg)
    length = math.hypot(x2 - x1, y2 - y1)
    if length < 1:
        return False

    samples = np.linspace(0.0, 1.0, max(9, min(51, int(length / 2.0) + 1)))
    inside = []
    for t in samples:
        px, py = x1 + (x2 - x1) * t, y1 + (y2 - y1) * t
        inside.append(left <= px <= right and top <= py <= bottom)
    coverage = float(np.mean(inside))
    endpoints_inside = (
        left <= x1 <= right and top <= y1 <= bottom and
        left <= x2 <= right and top <= y2 <= bottom
    )
    if not endpoints_inside and coverage < 0.88:
        return False

    # A real pipe running underneath a text label normally continues on both
    # sides of its tight OCR box. Check for that continuation in the original
    # ink, instead of blindly deleting every stroke inside the rectangle.
    ux, uy = (x2 - x1) / length, (y2 - y1) / length
    corners = [(left, top), (right, top), (right, bottom), (left, bottom)]
    projections = [(cx - x1) * ux + (cy - y1) * uy for cx, cy in corners]
    lo, hi = min(projections), max(projections)
    h, w = ink_dilated.shape[:2]

    def side_support(sign: float) -> float:
        distances = np.linspace(2.0, max(7.0, min(18.0, math.hypot(bw, bh) * 0.35)), 7)
        hits = 0
        for distance in distances:
            along = (lo - distance) if sign < 0 else (hi + distance)
            px, py = x1 + ux * along, y1 + uy * along
            ix, iy = int(round(px)), int(round(py))
            if 0 <= ix < w and 0 <= iy < h and ink_dilated[iy, ix] > 0:
                hits += 1
        return hits / len(distances)

    if side_support(-1.0) >= 0.43 and side_support(1.0) >= 0.43:
        return False
    return coverage >= 0.72


def _confirmed_text_boxes(annotations: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    boxes = []
    for item in annotations or []:
        if not (item.get('verified') or item.get('include')):
            continue
        box = item.get('bbox')
        if isinstance(box, dict) and all(key in box for key in ('x', 'y', 'w', 'h')):
            boxes.append(box)
    return boxes


def extract_segments(gray: np.ndarray, ink: np.ndarray, annotations: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    h, w = gray.shape[:2]
    min_dim = min(w, h)
    # Keep shorter continuations as candidates; the former 18-24 px cutoff
    # discarded visible pipe fragments at corners and beside handwritten labels.
    min_lsd_len = max(10.0, min_dim * 0.010)
    min_hough_len = max(12, int(min_dim * 0.012))
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
        threshold=max(14, int(min_dim * 0.018)),
        minLineLength=min_hough_len,
        maxLineGap=max(4, int(min_dim * 0.008)),
    )
    if hp is not None:
        for row in hp.reshape(-1, 4):
            x1, y1, x2, y2 = map(float, row)
            length = seg_length((x1, y1, x2, y2))
            if length >= min_hough_len:
                raw.append((x1, y1, x2, y2, 'HOUGH', length))

    # A one-pixel dilation makes support sampling tolerant of sub-pixel LSD
    # placement without erasing a genuine narrow gap between separate strokes.
    ink_dilated = cv2.dilate(ink, np.ones((3, 3), np.uint8), iterations=1)
    boxes = [a.get('bbox') for a in (annotations or []) if a.get('bbox')]
    text_boxes = _confirmed_text_boxes(annotations)
    candidates: list[dict[str, Any]] = []
    for x1, y1, x2, y2, source, length in raw:
        # Confidently recognized characters become editable CAD TEXT entities,
        # not duplicate polylines. Long lines continuing through the OCR box
        # remain geometry and are not deleted.
        if any(_segment_inside_text_box((x1, y1, x2, y2), box, ink_dilated) for box in text_boxes):
            continue
        support = _sample_line_support(ink_dilated, x1, y1, x2, y2)
        if support < 0.20:
            continue
        overlap = 0.0
        for t in np.linspace(0.1, 0.9, 9):
            px = x1 + (x2 - x1) * t
            py = y1 + (y2 - y1) * t
            if any(b['x'] <= px <= b['x'] + b['w'] and b['y'] <= py <= b['y'] + b['h'] for b in boxes):
                overlap += 1 / 9
        candidates.append({
            'x1': x1, 'y1': y1, 'x2': x2, 'y2': y2, 'source': source,
            'length': length, 'support': support, 'angle': angle_deg((x1, y1, x2, y2)),
            'ocr_overlap': round(overlap, 2),
            'suggested_role': 'text_or_dimension' if overlap >= 0.30 else 'line_candidate',
        })

    # Merge true LSD/Hough repeats by angle, centre-line offset, overlap and
    # continuity. Separate nearby parallel strokes are retained as independent lines.
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


def endpoint_clusters(segments: list[dict[str,Any]], radius: float = 4.5):
    endpoints=[]
    for i,s in enumerate(segments):
        endpoints.append((i,0,s['x1'],s['y1']))
        endpoints.append((i,1,s['x2'],s['y2']))
    parent=list(range(len(endpoints)))
    def find(a):
        while parent[a]!=a:
            parent[a]=parent[parent[a]]; a=parent[a]
        return a
    def union(a,b):
        ra,rb=find(a),find(b)
        if ra!=rb: parent[rb]=ra
    # Spatial buckets avoid O(n^2) across a noisy page.
    cell=max(1,int(radius))
    buckets={}
    for idx,(_,_,x,y) in enumerate(endpoints):
        key=(int(x//cell),int(y//cell))
        for bx in range(key[0]-1,key[0]+2):
          for by in range(key[1]-1,key[1]+2):
            for j in buckets.get((bx,by),[]):
              _,_,xx,yy=endpoints[j]
              if math.hypot(x-xx,y-yy)<=radius: union(idx,j)
        buckets.setdefault(key,[]).append(idx)
    groups={}
    for i,ep in enumerate(endpoints): groups.setdefault(find(i),[]).append(ep)
    nodes=[]; ep_to_node={}
    for gi,items in enumerate(groups.values()):
        x=float(np.mean([e[2] for e in items])); y=float(np.mean([e[3] for e in items]))
        nid=f"N{gi+1}"
        nodes.append({"id":nid,"x":round(x,2),"y":round(y,2),"degree":len(items),"review":len(items)==1})
        for ep in items:
            ep_to_node[(ep[0],ep[1])]=nid
    edges=[]
    node_by_id = {n['id']: n for n in nodes}
    for i,s in enumerate(segments):
        a=ep_to_node[(i,0)]; b=ep_to_node[(i,1)]
        if a==b: continue
        snapped = [[node_by_id[a]['x'], node_by_id[a]['y']], [node_by_id[b]['x'], node_by_id[b]['y']]]
        raw_geometry = [[round(s['x1'],2),round(s['y1'],2)],[round(s['x2'],2),round(s['y2'],2)]]
        edges.append({"id":f"E{len(edges)+1}","from":a,"to":b,
                      "source":"candidate","confidence":round(min(0.99,0.45+0.45*s['support']+min(s['length']/800,0.12)),2),
                      "geometry":snapped,"raw_geometry":raw_geometry,
                      "review":True,"detector":s['source'],"source_segment_index":i,
                      "ocr_overlap":s.get('ocr_overlap',0.0),
                      "suggested_role":s.get('suggested_role','line_candidate')})
    # Group connected candidate segments. Long, dense components dominated by OCR
    # boxes are marked as annotation clusters, not silently deleted.
    adjacency = {}
    for idx,e in enumerate(edges):
        adjacency.setdefault(e['from'],[]).append(idx)
        adjacency.setdefault(e['to'],[]).append(idx)
    seen=set(); component_summaries=[]
    for seed in range(len(edges)):
        if seed in seen: continue
        stack=[seed]; indices=[]; node_ids=set()
        while stack:
            idx=stack.pop()
            if idx in seen: continue
            seen.add(idx); indices.append(idx)
            e=edges[idx]
            for nid in (e['from'],e['to']):
                node_ids.add(nid)
                stack.extend(j for j in adjacency.get(nid,[]) if j not in seen)
        comp_edges=[edges[i] for i in indices]
        pts=[p for e in comp_edges for p in e['geometry']]
        xs=[p[0] for p in pts]; ys=[p[1] for p in pts]
        dx=max(xs)-min(xs) if xs else 0; dy=max(ys)-min(ys) if ys else 0
        extent=max(dx,dy); total=sum(math.dist(*e['geometry']) for e in comp_edges)
        overlap_len=sum(math.dist(*e['geometry'])*float(e.get('ocr_overlap',0)) for e in comp_edges)
        overlap_ratio=overlap_len/max(total,1)
        edge_lengths = [math.dist(*edge['geometry']) for edge in comp_edges]
        longest = max(edge_lengths, default=0.0)
        elongation = max(dx, dy) / max(1.0, min(dx, dy))
        # OCR overlap is descriptive only. A long, connected geometric component
        # remains a line candidate even when Tesseract/Qwen put a text box over it.
        if extent >= 42 and total >= 42 and (longest >= 28 or elongation >= 2.2):
            role='line_structure'
        elif len(comp_edges)>=3 and extent>=45 and overlap_ratio>=0.28 and total>=55:
            role='text_or_annotation'
        else:
            role='ambiguous'
        cid=f"C{len(component_summaries)+1}"
        for e in comp_edges: e['component_id']=cid; e['component_role']=role
        component_summaries.append({"id":cid,"role":role,"edge_count":len(comp_edges),
                                    "total_length":round(total,1),"bbox":{"x":round(min(xs),1) if xs else 0,"y":round(min(ys),1) if ys else 0,"w":round(dx,1),"h":round(dy,1)},
                                    "ocr_overlap_ratio":round(overlap_ratio,2)})

    # Keep short, detached pipe continuations when they point directly toward an
    # open end of an already coherent line component. They remain separate edges;
    # this does not auto-connect or move either endpoint.
    line_open_ends = []
    for edge in edges:
        if edge.get('component_role') != 'line_structure':
            continue
        geo = edge.get('geometry') or []
        if len(geo) < 2:
            continue
        for node_id, endpoint, inner in ((edge['from'], geo[0], geo[-1]), (edge['to'], geo[-1], geo[0])):
            node = node_by_id.get(node_id)
            if not node or node.get('degree') != 1:
                continue
            vector = np.array([inner[0] - endpoint[0], inner[1] - endpoint[1]], dtype=float)
            norm = np.linalg.norm(vector)
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
        promoted = False
        for edge in comp_edges:
            geo = edge.get('geometry') or []
            if len(geo) < 2 or not 8 <= math.dist(*geo) <= 42 or edge.get('ocr_overlap', 0) >= 0.30:
                continue
            for endpoint, inner in ((geo[0], geo[-1]), (geo[-1], geo[0])):
                node_id = edge['from'] if endpoint == geo[0] else edge['to']
                node = node_by_id.get(node_id)
                if not node or node.get('degree') != 1:
                    continue
                vector = np.array([inner[0] - endpoint[0], inner[1] - endpoint[1]], dtype=float)
                norm = np.linalg.norm(vector)
                if norm < 1:
                    continue
                vector /= norm
                for line_endpoint, line_vector in line_open_ends:
                    distance = float(np.linalg.norm(np.array(endpoint, dtype=float) - line_endpoint))
                    if distance <= 10.0 and float(np.dot(vector, line_vector)) <= -0.90:
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

    return nodes,edges,component_summaries


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


def _cad_edge_chains(edges: list[dict[str, Any]]) -> list[list[list[float]]]:
    """Join degree-two graph edges into clean editable CAD polylines."""
    selected = []
    for index, source in enumerate(edges):
        if source.get('component_role') != 'line_structure' or len(source.get('geometry') or []) < 2:
            continue
        edge = dict(source)
        edge.setdefault('id', f'__edge_{index}')
        edge.setdefault('from', f'__node_{index}_a')
        edge.setdefault('to', f'__node_{index}_b')
        selected.append(edge)
    adjacency: dict[str, list[dict[str, Any]]] = {}
    for edge in selected:
        adjacency.setdefault(edge['from'], []).append(edge)
        adjacency.setdefault(edge['to'], []).append(edge)
    visited: set[str] = set()
    chains: list[list[list[float]]] = []

    def trace(start_node: str, first_edge: dict[str, Any]) -> None:
        node = start_node
        edge = first_edge
        points: list[list[float]] = []
        while edge and edge['id'] not in visited:
            visited.add(edge['id'])
            geometry = edge['geometry']
            oriented = geometry if edge['from'] == node else list(reversed(geometry))
            if not points:
                points.extend([[float(point[0]), float(point[1])] for point in oriented])
            else:
                points.extend([[float(point[0]), float(point[1])] for point in oriented[1:]])
            next_node = edge['to'] if edge['from'] == node else edge['from']
            candidates = [item for item in adjacency.get(next_node, []) if item['id'] not in visited]
            if len(adjacency.get(next_node, [])) != 2 or not candidates:
                break
            node, edge = next_node, candidates[0]
        cleaned = _clean_cad_points(points)
        if len(cleaned) >= 2:
            chains.append(cleaned)

    for node, incident in adjacency.items():
        if len(incident) == 2:
            continue
        for edge in incident:
            if edge['id'] not in visited:
                trace(node, edge)
    for edge in selected:
        if edge['id'] not in visited:
            trace(edge['from'], edge)
    return chains


def _clean_cad_points(points: list[list[float]]) -> list[list[float]]:
    """Remove detector jitter and square only corners already close to orthogonal."""
    unique: list[list[float]] = []
    for point in points:
        item = [float(point[0]), float(point[1])]
        if not unique or math.dist(unique[-1], item) > 0.8:
            unique.append(item)
    if len(unique) < 3:
        return [[round(x, 1), round(y, 1)] for x, y in unique]

    def axis_kind(a: list[float], b: list[float]) -> str:
        dx, dy = b[0] - a[0], b[1] - a[1]
        length = math.hypot(dx, dy)
        if length < 8:
            return ''
        tolerance = max(1.0, length * 0.035)
        if abs(dy) <= tolerance:
            return 'H'
        if abs(dx) <= tolerance:
            return 'V'
        return ''

    for _ in range(2):
        for index in range(1, len(unique) - 1):
            incoming = axis_kind(unique[index - 1], unique[index])
            outgoing = axis_kind(unique[index], unique[index + 1])
            if incoming == 'H' and outgoing == 'V':
                unique[index] = [unique[index + 1][0], unique[index - 1][1]]
            elif incoming == 'V' and outgoing == 'H':
                unique[index] = [unique[index - 1][0], unique[index + 1][1]]
            elif incoming == 'H' and outgoing == 'H':
                unique[index][1] = (unique[index - 1][1] + unique[index + 1][1]) / 2.0
            elif incoming == 'V' and outgoing == 'V':
                unique[index][0] = (unique[index - 1][0] + unique[index + 1][0]) / 2.0

    simplified = [unique[0]]
    for index in range(1, len(unique) - 1):
        a, b, c = simplified[-1], unique[index], unique[index + 1]
        ab = (b[0] - a[0], b[1] - a[1])
        bc = (c[0] - b[0], c[1] - b[1])
        la, lb = math.hypot(*ab), math.hypot(*bc)
        cross = abs(ab[0] * bc[1] - ab[1] * bc[0])
        dot = ab[0] * bc[0] + ab[1] * bc[1]
        if not (la > 1 and lb > 1 and dot > 0 and cross / (la * lb) < 0.035):
            simplified.append(b)
    simplified.append(unique[-1])
    return [[round(x, 1), round(y, 1)] for x, y in simplified]


def _sheet_layout(width: int, height: int) -> tuple[float, float, float]:
    pagew, pageh = 1200.0, 850.0
    draw_x, draw_y, draw_w, draw_h = 36.0, 88.0, 1128.0, 652.0
    scale = min(draw_w / max(width, 1), draw_h / max(height, 1))
    tx = draw_x + (draw_w - width * scale) / 2.0
    ty = draw_y + (draw_h - height * scale) / 2.0
    return scale, tx, ty


def build_clean_svg(width:int,height:int,edges:list[dict],annotations:list[dict],title='Трубопроводная схема') -> str:
    """Create a clean A3 CAD sheet: uniform linework and editable OCR text."""
    pagew, pageh = 1200, 850
    scale, tx, ty = _sheet_layout(width, height)
    line_width = max(0.18, 0.62 / max(scale, 0.001))
    out=[
        f'<svg xmlns="http://www.w3.org/2000/svg" width="420mm" height="297mm" viewBox="0 0 {pagew} {pageh}">',
        '<rect width="1200" height="850" fill="#fff"/>',
        '<g fill="none" stroke="#15191d" stroke-width="1.0">',
        '<rect x="24" y="24" width="1152" height="802"/>',
        '<path d="M 36 78 H 1164 M 36 88 H 1164 M 36 740 H 1164 M 24 760 H 1176 M 830 760 V 826"/>',
        '<rect x="36" y="88" width="1128" height="652" stroke="#aeb5bb" stroke-width="0.55"/>',
        '<rect x="1010" y="32" width="154" height="34" stroke-width="0.65"/>',
        '<path d="M 1010 49 H 1164" stroke-width="0.55"/>',
        '</g>',
        f'<text x="40" y="52" font-family="Arial,sans-serif" font-size="16" font-weight="bold" fill="#15191d">{xml_escape(title.upper())}</text>',
        '<text x="40" y="68" font-family="Arial,sans-serif" font-size="7.5" fill="#555e66">АВТОМАТИЧЕСКАЯ ВЕКТОРНАЯ РЕКОНСТРУКЦИЯ · ИСХОДНЫЙ МАСШТАБ НЕ КАЛИБРОВАН</text>',
        '<text x="1022" y="44" font-family="Arial,sans-serif" font-size="7" fill="#5b646b">ФОРМАТ</text>',
        '<text x="1022" y="61" font-family="Arial,sans-serif" font-size="10" font-weight="bold" fill="#15191d">A3 · ЛИСТ 1/1</text>',
        f'<g transform="translate({tx:.3f} {ty:.3f}) scale({scale:.7f})" fill="none" stroke="#15191d" stroke-width="{line_width:.4f}" stroke-linecap="round" stroke-linejoin="round">'
    ]
    for chain in _cad_edge_chains(edges):
        pts=' '.join(f'{float(point[0]):.2f},{float(point[1]):.2f}' for point in chain)
        out.append(f'<polyline points="{pts}"/>')
    out.append('</g>')

    # OCR output is rendered as typography with an opaque paper-colour mask;
    # the handwritten glyph traces have already been filtered from geometry.
    for annotation in annotations:
        if not (annotation.get('include', annotation.get('verified', False)) and annotation.get('verified', False)) or not annotation.get('text'):
            continue
        box=annotation.get('bbox') or {}
        x=tx+(float(box.get('x',0))+float(box.get('w',0))/2.0)*scale
        y=ty+(float(box.get('y',0))+float(box.get('h',0))/2.0)*scale
        label=str(annotation['text'])
        label_width=max(24.0, min(190.0, len(label)*4.8+8.0))
        out.append(f'<rect x="{x-label_width/2:.2f}" y="{y-8.4:.2f}" width="{label_width:.2f}" height="13.2" fill="#fff" stroke="none"/>')
        out.append(f'<text x="{x:.2f}" y="{y+1.0:.2f}" font-family="Arial,sans-serif" font-size="8" text-anchor="middle" fill="#15191d">{xml_escape(label)}</text>')

    out += [
        '<text x="40" y="783" font-family="Arial,sans-serif" font-size="8" font-weight="bold" fill="#15191d">ОБОЗНАЧЕНИЯ И ПРИМЕЧАНИЯ</text>',
        '<text x="40" y="801" font-family="Arial,sans-serif" font-size="7" fill="#505960">Надписи OCR преобразованы в редактируемый текст. Геометрия показана отдельными CAD-полилиниями.</text>',
        '<text x="40" y="816" font-family="Arial,sans-serif" font-size="7" fill="#505960">Проверьте узлы, пересечения и размеры по оригиналу перед изготовлением или монтажом.</text>',
        '<text x="850" y="783" font-family="Arial,sans-serif" font-size="7" fill="#5b646b">ТИП ДОКУМЕНТА</text>',
        '<text x="850" y="801" font-family="Arial,sans-serif" font-size="9" font-weight="bold" fill="#15191d">СХЕМА ТРУБОПРОВОДА</text>',
        '<text x="850" y="816" font-family="Arial,sans-serif" font-size="7" fill="#505960">МАСШТАБ: НЕ ОПРЕДЕЛЁН · СТАТУС: ПРОВЕРИТЬ</text>',
        '</svg>'
    ]
    return '\n'.join(out)

def xml_escape(s:str)->str:
    return str(s).replace('&','&amp;').replace('<','&lt;').replace('>','&gt;').replace('"','&quot;')


def build_dxf(width:int,height:int,edges:list[dict],annotations:list[dict]) -> str:
    """Export the same A3 sheet layout to AutoCAD-compatible millimetre units."""
    pagew, pageh = 1200.0, 850.0
    scale, tx, ty = _sheet_layout(width, height)

    def page_to_mm(point):
        x, y = point
        return (x * 420.0 / pagew, (pageh - y) * 297.0 / pageh)

    def dxf_text(layer, text, x, y, height_mm):
        value = re.sub(r'[\r\n\x00]+', ' ', str(text or '')).strip()[:240]
        if not value:
            return []
        return ['0','TEXT','100','AcDbEntity','8',layer,'100','AcDbText',
                '10',f'{x:.3f}','20',f'{y:.3f}','30','0',
                '40',f'{height_mm:.3f}','1',value]

    def dxf_polyline(layer, points, closed=False, lineweight=13):
        if len(points) < 2:
            return []
        out=['0','LWPOLYLINE','100','AcDbEntity','8',layer,'100','AcDbPolyline',
             '370',str(lineweight),'90',str(len(points)),'70','1' if closed else '0']
        for point in points:
            x,y=page_to_mm(point)
            out += ['10',f'{x:.3f}','20',f'{y:.3f}']
        return out

    d=['0','SECTION','2','HEADER','9','$ACADVER','1','AC1021',
       '9','$INSUNITS','70','4','0','ENDSEC',
       '0','SECTION','2','TABLES',
       '0','TABLE','2','LTYPE','5','5','330','0','100','AcDbSymbolTable','70','1',
       '0','LTYPE','5','14','330','5','100','AcDbSymbolTableRecord','100','AcDbLinetypeTableRecord',
       '2','CONTINUOUS','70','0','3','Solid line','72','65','73','0','40','0.0',
       '0','ENDTAB',
       '0','TABLE','2','LAYER','5','2','330','0','100','AcDbSymbolTable','70','4']
    for handle, (name, colour, lineweight) in enumerate([
        ('SHEET',7,13),('PIPE_CANDIDATES',7,13),('VERIFIED_TEXT',7,13),('NOTES',8,9)
    ], start=16):
        d += ['0','LAYER','5',format(handle,'X'),'330','2','100','AcDbSymbolTableRecord',
              '100','AcDbLayerTableRecord','2',name,'70','0','62',str(colour),'6','CONTINUOUS','370',str(lineweight)]
    d += ['0','ENDTAB','0','ENDSEC','0','SECTION','2','ENTITIES']

    # A3 frame, title rules and simple technical title block.
    d += dxf_polyline('SHEET',[(24,24),(1176,24),(1176,826),(24,826)],True)
    d += dxf_polyline('SHEET',[(36,78),(1164,78)])
    d += dxf_polyline('SHEET',[(36,88),(1164,88)])
    d += dxf_polyline('SHEET',[(36,740),(1164,740)])
    d += dxf_polyline('SHEET',[(24,760),(1176,760)])
    d += dxf_polyline('SHEET',[(830,760),(830,826)])
    d += dxf_polyline('SHEET',[(36,88),(1164,88),(1164,740),(36,740)],True,9)
    d += dxf_polyline('SHEET',[(1010,32),(1164,32),(1164,66),(1010,66)],True,9)
    d += dxf_polyline('SHEET',[(1010,49),(1164,49)],False,9)

    for chain in _cad_edge_chains(edges):
        page_points=[(tx+float(point[0])*scale,ty+float(point[1])*scale) for point in chain]
        d += dxf_polyline('PIPE_CANDIDATES',page_points,False,13)

    for annotation in annotations:
        if not (annotation.get('include', annotation.get('verified', False)) and annotation.get('verified', False)) or not annotation.get('text'):
            continue
        box=annotation.get('bbox') or {}
        px=tx+(float(box.get('x',0))+float(box.get('w',0))/2.0)*scale
        py=ty+(float(box.get('y',0))+float(box.get('h',0))/2.0)*scale
        x,y=page_to_mm((px,py))
        text=str(annotation['text'])
        # TEXT is centre-aligned in the sheet; standard 3 mm drafting height.
        x -= min(70.0, len(text)*1.65)
        d += dxf_text('VERIFIED_TEXT',text,x,y,3.0)

    d += dxf_text('NOTES','ТРУБОПРОВОДНАЯ СХЕМА',page_to_mm((40,52))[0],page_to_mm((40,52))[1],5.6)
    d += dxf_text('NOTES','АВТОМАТИЧЕСКАЯ ВЕКТОРНАЯ РЕКОНСТРУКЦИЯ - МАСШТАБ НЕ КАЛИБРОВАН',page_to_mm((40,68))[0],page_to_mm((40,68))[1],2.6)
    d += dxf_text('NOTES','ФОРМАТ',page_to_mm((1022,44))[0],page_to_mm((1022,44))[1],2.4)
    d += dxf_text('NOTES','A3 - ЛИСТ 1/1',page_to_mm((1022,61))[0],page_to_mm((1022,61))[1],3.3)
    d += dxf_text('NOTES','ОБОЗНАЧЕНИЯ И ПРИМЕЧАНИЯ',page_to_mm((40,783))[0],page_to_mm((40,783))[1],2.8)
    d += dxf_text('NOTES','OCR LABELS EXPORTED AS EDITABLE CAD TEXT; PIPE GEOMETRY IS ON A SEPARATE LAYER.',page_to_mm((40,801))[0],page_to_mm((40,801))[1],2.2)
    d += dxf_text('NOTES','VERIFY CONNECTIONS AND DIMENSIONS AGAINST THE ORIGINAL BEFORE CONSTRUCTION.',page_to_mm((40,816))[0],page_to_mm((40,816))[1],2.2)
    d += dxf_text('NOTES','ТИП ДОКУМЕНТА',page_to_mm((850,783))[0],page_to_mm((850,783))[1],2.3)
    d += dxf_text('NOTES','СХЕМА ТРУБОПРОВОДА',page_to_mm((850,801))[0],page_to_mm((850,801))[1],3.0)
    d += dxf_text('NOTES','МАСШТАБ: НЕ ОПРЕДЕЛЁН - СТАТУС: ПРОВЕРИТЬ',page_to_mm((850,816))[0],page_to_mm((850,816))[1],2.1)
    d += ['0','ENDSEC','0','EOF']
    return '\n'.join(d)+'\n'

def analyze(input_path:str,out_dir:str) -> dict[str,Any]:
    Path(out_dir).mkdir(parents=True,exist_ok=True)
    bgr=load_image(input_path); h,w=bgr.shape[:2]
    gray,prep=normalize_document(bgr)
    ink=make_ink_mask(bgr,gray)
    annotations, ocr_status = ocr_annotations(input_path, gray)
    segments=extract_segments(gray,ink,annotations)
    nodes,edges,components=endpoint_clusters(segments)
    # OCR overlap remains metadata for graph classification. Confirmed glyph
    # strokes were already filtered in extract_segments; continuous pipe lines survive.
    for edge in edges:
        edge['visible'] = True
    crossings=detect_crossings(segments)
    # A white canvas preview with candidate line segments in red/amber.
    overlay=bgr.copy()
    for i,s in enumerate(segments):
        if s.get('ocr_overlap', 0) >= 0.45:
            col=(155,155,155)
        else:
            col=(30,130,240) if s['source']=='LSD' else (40,180,80)
        cv2.line(overlay,(int(s['x1']),int(s['y1'])),(int(s['x2']),int(s['y2'])),col,2,cv2.LINE_AA)
    for n in nodes:
        if n['degree'] >= 3:
            cv2.circle(overlay,(int(n['x']),int(n['y'])),4,(0,0,255),-1,cv2.LINE_AA)
    overlay_path=str(Path(out_dir)/'overlay.png'); cv2.imwrite(overlay_path,overlay)
    ink_path=str(Path(out_dir)/'ink-mask.png'); cv2.imwrite(ink_path,ink)
    svg=build_clean_svg(w,h,edges,annotations)
    Path(out_dir,'clean.svg').write_text(svg,encoding='utf-8')
    Path(out_dir,'drawing.dxf').write_text(build_dxf(w,h,edges,annotations),encoding='utf-8')
    # Open-end gap candidates are suggestions only; no geometry is connected automatically.
    node_map = {n['id']: n for n in nodes}
    edge_at = {}
    for e in edges:
        for nid in (e['from'], e['to']): edge_at.setdefault(nid, e)
    open_nodes = [n for n in nodes if n['degree'] == 1 and n['id'] in edge_at]
    joins=[]
    for i, a in enumerate(open_nodes):
        ea=edge_at[a['id']]
        if ea.get('component_role') != 'line_structure' or math.dist(*ea['geometry']) < 25: continue
        ga=ea['geometry']; other_a=ga[-1] if ea['from']==a['id'] else ga[0]
        va=np.array([other_a[0]-a['x'], other_a[1]-a['y']], dtype=float); na=np.linalg.norm(va)
        if na<1: continue
        va/=na
        for b in open_nodes[i+1:]:
            eb=edge_at[b['id']]
            if eb.get('component_role') != 'line_structure' or math.dist(*eb['geometry']) < 25: continue
            dist=math.hypot(a['x']-b['x'],a['y']-b['y'])
            if dist<7 or dist>28: continue
            gb=eb['geometry']; other_b=gb[-1] if eb['from']==b['id'] else gb[0]
            vb=np.array([other_b[0]-b['x'], other_b[1]-b['y']], dtype=float); nb=np.linalg.norm(vb)
            if nb<1: continue
            vb/=nb
            if float(np.dot(va,vb)) < -0.91:
                joins.append({"id":f"J{len(joins)+1}","from":a['id'],"to":b['id'],"distance":round(dist,1),"status":"needs_review","message":"Почти соосные окончания — подтвердить вручную"})
                if len(joins)>=200: break
        if len(joins)>=200: break
    graph={"schema":"cad-reconstruction-graph/1.1","status":"needs_review","image":{"width":w,"height":h},
           "nodes":nodes,"edges":edges,"components":components,"crossings":crossings,"joinCandidates":joins,"annotations":annotations,"ocr":ocr_status,
           "rules":{"confirmed_ocr_strokes_become_text":True,"continuous_lines_through_text_are_preserved":True,"crossings_auto_joined":False,"endpoint_cluster_radius_px":4.5},
           "summary":{"segment_candidates":len(segments),"nodes":len(nodes),"edges":len(edges),"crossings_to_review":len(crossings),
                      "ocr_annotations":len(annotations),
                      "qwen_annotations":len([a for a in annotations if a.get('source')=='qwen3-vl']),
                      "tesseract_annotations":len([a for a in annotations if a.get('source')=='tesseract']),
                      "text_overlap_edges":sum(1 for e in edges if e.get('suggested_role')=='text_or_dimension'),
                      "geometry_candidates_preserved":len(segments),
                      "open_end_join_candidates":len(joins),
                      "components":len(components),
                      "line_components":sum(1 for c in components if c['role']=='line_structure'),
                      "annotation_components":sum(1 for c in components if c['role']=='text_or_annotation'),
                      "ambiguous_components":sum(1 for c in components if c['role']=='ambiguous'),
                      "ink_pixels":int(np.count_nonzero(ink)),"preprocessing":prep},
           "warnings":["Линии являются кандидатами детектора, а не подтверждёнными трубами.",
                       "Пересечения не объединяются автоматически.",
                       "Уверенно распознанные символы экспортируются как CAD TEXT, а не как линии; сквозные трассы сохраняются.",
                       "Проверьте размеры и подписи перед использованием чертежа."]}
    if not ocr_status.get('qwen', {}).get('available'):
        graph['warnings'].append('Qwen OCR недоступен; использован Tesseract, если он установлен. Проверьте Ollama и модель Qwen3-VL.')
    Path(out_dir,'graph.json').write_text(json.dumps(graph,ensure_ascii=False,indent=2),encoding='utf-8')
    return graph


def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--input',required=True); ap.add_argument('--out',required=True)
    args=ap.parse_args(); result=analyze(args.input,args.out); print(json.dumps(result,ensure_ascii=False))

if __name__=='__main__': main()
