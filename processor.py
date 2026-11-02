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
            f'Размер переданного изображения: {rgb.width}x{rgb.height} пикселей. '
            'bbox должен содержать x, y, w, h в пикселях этого изображения, начало координат слева сверху. '
            'Рамка должна охватывать только сам текст, не соседние трубы. '
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
            accepted = confidence >= 68
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
            tesseract_items.append({
                'id': f'T{len(tesseract_items) + 1}', 'text': text,
                'confidence': round(confidence, 1), 'bbox': box,
                'verified': False, 'include': False, 'source': 'tesseract'
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
    candidates: list[dict[str, Any]] = []
    for x1, y1, x2, y2, source, length in raw:
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


def build_clean_svg(width:int,height:int,edges:list[dict],annotations:list[dict],title='Трубопроводная схема') -> str:
    # Technical sheet with uniform line widths. Coordinates remain in image space
    # in the graph JSON; SVG uses a viewBox and fit-to-page transform.
    margin=70; pagew=1200; pageh=850
    scale=min((pagew-2*margin)/max(width,1),(pageh-2*margin-100)/max(height,1))
    tx=(pagew-width*scale)/2; ty=65+(pageh-130-height*scale)/2
    out=[f'<svg xmlns="http://www.w3.org/2000/svg" width="{pagew}mm" height="{pageh}mm" viewBox="0 0 {pagew} {pageh}">',
         '<rect width="1200" height="850" fill="white"/>','<rect x="24" y="24" width="1152" height="802" fill="none" stroke="#111" stroke-width="1.2"/>',
         '<g transform="translate(%.3f %.3f) scale(%.6f)" fill="none" stroke="#111" stroke-width="%.3f" stroke-linecap="round" stroke-linejoin="round">'%(tx,ty,scale,max(0.7/scale,0.25))]
    for e in edges:
        geo=e.get('geometry') or []
        if e.get('component_role') != 'line_structure' or len(geo)<2:
            continue
        pts=' '.join(f'{float(p[0]):.2f},{float(p[1]):.2f}' for p in geo)
        out.append(f'<polyline points="{pts}"/>')
    out.append('</g>')
    # OCR annotations are separate and editable: only print when verified.
    for a in annotations:
        if not (a.get('include', a.get('verified', False)) and a.get('verified', False)) or not a.get('text'): continue
        b=a.get('bbox',{}); x=tx+(b.get('x',0)+b.get('w',0)/2)*scale; y=ty+(b.get('y',0)+b.get('h',0)/2)*scale
        out.append(f'<text x="{x:.2f}" y="{y:.2f}" font-family="Arial,sans-serif" font-size="8" text-anchor="middle" fill="#111">{xml_escape(a["text"])}</text>')
    out += [f'<text x="38" y="48" font-family="Arial,sans-serif" font-size="14" font-weight="bold">{xml_escape(title)}</text>',
            '<path d="M 24 760 H 1176 M 830 760 V 826" fill="none" stroke="#111" stroke-width="0.8"/>',
            '<text x="40" y="783" font-family="Arial,sans-serif" font-size="8">СХЕМА ВЕКТОРИЗОВАНА ИЗ РУКОПИСНОГО ЭСКИЗА — ТРЕБУЕТ ПРОВЕРКИ ТОПОЛОГИИ И РАЗМЕРОВ</text>',
            '<text x="845" y="783" font-family="Arial,sans-serif" font-size="8">CAD RECONSTRUCTION ENGINE</text>', '</svg>']
    return '\n'.join(out)


def xml_escape(s:str)->str:
    return str(s).replace('&','&amp;').replace('<','&lt;').replace('>','&gt;').replace('"','&quot;')


def build_dxf(width:int,height:int,edges:list[dict],annotations:list[dict]) -> str:
    d=['0','SECTION','2','HEADER','9','$ACADVER','1','AC1015','0','ENDSEC','0','SECTION','2','ENTITIES']
    for e in edges:
        geo=e.get('geometry') or []
        if e.get('component_role') != 'line_structure' or len(geo)<2: continue
        d += ['0','LWPOLYLINE','8','PIPE_CANDIDATES','370','13','90',str(len(geo)),'70','0']
        for x,y in geo: d += ['10',f'{x:.3f}','20',f'{height-y:.3f}']
    for a in annotations:
        if not (a.get('include', a.get('verified', False)) and a.get('verified', False)) or not a.get('text'): continue
        b=a.get('bbox',{}); x=b.get('x',0); y=height-(b.get('y',0)+b.get('h',0))
        d += ['0','TEXT','8','VERIFIED_TEXT','10',str(x),'20',str(y),'40','8','1',str(a['text'])]
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
    # OCR-overlap and component role are metadata only. No candidate is removed.
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
           "rules":{"ocr_does_not_erase_geometry":True,"crossings_auto_joined":False,"endpoint_cluster_radius_px":4.5},
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
                       "OCR не исключает геометрию: линии под текстовыми рамками остаются кандидатами.",
                       "Проверьте размеры и подписи перед использованием чертежа."]}
    if not ocr_status.get('qwen', {}).get('available'):
        graph['warnings'].append('Qwen OCR недоступен; использован Tesseract, если он установлен. Проверьте Ollama и модель Qwen3-VL.')
    Path(out_dir,'graph.json').write_text(json.dumps(graph,ensure_ascii=False,indent=2),encoding='utf-8')
    return graph


def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--input',required=True); ap.add_argument('--out',required=True)
    args=ap.parse_args(); result=analyze(args.input,args.out); print(json.dumps(result,ensure_ascii=False))

if __name__=='__main__': main()
