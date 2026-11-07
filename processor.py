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
import time
import base64
import hashlib
import socket
import urllib.request
import urllib.error
from io import BytesIO
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from PIL import Image, ImageOps

from structured_model import build_document_model
from recognition_channels import split_recognition_channels
from cad_symbols import catalog_manifest
from topology_reconstruction import attach_pipes_to_symbols
from annotation_linking import link_annotations
from engineering_validation import validate_engineering_model
from clean_layout import build_clean_layout
from clean_export import build_layout_svg, build_layout_dxf
from drawing_template import build_drawing_template
from pipeline_diagnostics import build_pipeline_diagnostics


def _progress(stage: str, message: str) -> None:
    """Emit a concise, immediately flushed progress line for the parent process."""
    safe_stage = re.sub(r'[^A-Z0-9_-]', '', str(stage).upper())[:16] or 'JOB'
    safe_message = re.sub(r'[\r\n]+', ' ', str(message)).strip()[:500]
    sys.stderr.write(f'[{safe_stage}] {safe_message}\n')
    sys.stderr.flush()


def load_image(path: str) -> np.ndarray:
    pil = ImageOps.exif_transpose(Image.open(path)).convert('RGB')
    return cv2.cvtColor(np.array(pil), cv2.COLOR_RGB2BGR)


def _order_quad(points: np.ndarray) -> np.ndarray:
    points = np.asarray(points, dtype=np.float32).reshape(4, 2)
    ordered = np.zeros((4, 2), dtype=np.float32)
    sums, diffs = points.sum(axis=1), np.diff(points, axis=1).reshape(-1)
    ordered[0], ordered[2] = points[np.argmin(sums)], points[np.argmax(sums)]
    ordered[1], ordered[3] = points[np.argmin(diffs)], points[np.argmax(diffs)]
    return ordered


def _detect_page_quad(bgr: np.ndarray) -> np.ndarray | None:
    """Find a large four-corner paper boundary; return None when uncertain."""
    h, w = bgr.shape[:2]
    scale = min(1.0, 1400.0 / max(h, w))
    small = cv2.resize(bgr, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA) if scale < 1 else bgr
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(blurred, 35, 110)
    edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8), iterations=2)
    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    image_area = float(small.shape[0] * small.shape[1])
    for contour in sorted(contours, key=cv2.contourArea, reverse=True)[:12]:
        if cv2.contourArea(contour) < image_area * 0.42:
            break
        perimeter = cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, 0.018 * perimeter, True)
        if len(approx) == 4 and cv2.isContourConvex(approx):
            quad = _order_quad(approx.reshape(4, 2) / scale)
            side_lengths = [np.linalg.norm(quad[(i + 1) % 4] - quad[i]) for i in range(4)]
            if min(side_lengths) >= min(h, w) * 0.35:
                return quad
    return None


def _warp_page(bgr: np.ndarray, quad: np.ndarray) -> np.ndarray:
    tl, tr, br, bl = _order_quad(quad)
    width = max(np.linalg.norm(tr - tl), np.linalg.norm(br - bl))
    height = max(np.linalg.norm(bl - tl), np.linalg.norm(br - tr))
    target_w, target_h = max(2, int(round(width))), max(2, int(round(height)))
    destination = np.array([[0, 0], [target_w - 1, 0], [target_w - 1, target_h - 1], [0, target_h - 1]], dtype=np.float32)
    transform = cv2.getPerspectiveTransform(np.array([tl, tr, br, bl], dtype=np.float32), destination)
    return cv2.warpPerspective(bgr, transform, (target_w, target_h), borderValue=(255, 255, 255))


def _detect_text_rotation(bgr: np.ndarray) -> tuple[int, float]:
    """Use Tesseract OSD when it is confident; otherwise preserve orientation."""
    try:
        import pytesseract
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        result = pytesseract.image_to_osd(Image.fromarray(rgb), config='--psm 0')
        rotate_match = re.search(r'Rotate:\s*(0|90|180|270)', result)
        confidence_match = re.search(r'Orientation confidence:\s*([0-9.]+)', result)
        rotation = int(rotate_match.group(1)) if rotate_match else 0
        confidence = float(confidence_match.group(1)) if confidence_match else 0.0
        return (rotation, confidence) if confidence >= 3.0 else (0, confidence)
    except Exception:
        return 0, 0.0


def prepare_document_image(bgr: np.ndarray, rotation_degrees: int | None = None) -> tuple[np.ndarray, dict[str, Any]]:
    """Rectify a photographed page and rotate confidently detected text upright."""
    original_h, original_w = bgr.shape[:2]
    quad = _detect_page_quad(bgr)
    prepared = _warp_page(bgr, quad) if quad is not None else bgr.copy()
    if rotation_degrees is None:
        rotation_degrees, orientation_confidence = _detect_text_rotation(prepared)
    else:
        orientation_confidence = 100.0
    rotation_degrees = int(rotation_degrees or 0) % 360
    rotate_codes = {90: cv2.ROTATE_90_CLOCKWISE, 180: cv2.ROTATE_180, 270: cv2.ROTATE_90_COUNTERCLOCKWISE}
    if rotation_degrees in rotate_codes:
        prepared = cv2.rotate(prepared, rotate_codes[rotation_degrees])
    return prepared, {
        "original_width": original_w, "original_height": original_h,
        "page_quad_detected": quad is not None,
        "perspective_corrected": quad is not None,
        "rotation_degrees": rotation_degrees,
        "orientation_confidence": round(float(orientation_confidence), 2),
        "prepared_width": int(prepared.shape[1]), "prepared_height": int(prepared.shape[0]),
    }


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


def make_ink_layers(bgr: np.ndarray, norm_gray: np.ndarray) -> dict[str, np.ndarray]:
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    h, s, v = cv2.split(hsv)
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
    return {"blue": cv2.bitwise_and(blue, out), "dark": cv2.bitwise_and(dark, out), "combined": out}


def make_ink_mask(bgr: np.ndarray, norm_gray: np.ndarray) -> np.ndarray:
    return make_ink_layers(bgr, norm_gray)["combined"]


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


OCR_RESPONSE_SCHEMA: dict[str, Any] = {
    'type': 'object',
    'properties': {
        'annotations': {
            'type': 'array', 'maxItems': 64,
            'items': {
                'type': 'object',
                'properties': {
                    'text': {'type': 'string'},
                    # Compact [x1, y1, x2, y2] form cuts response tokens;
                    # the OCR parser maps it back to the same source-pixel box.
                    'bbox': {
                        'type': 'array', 'minItems': 4, 'maxItems': 4,
                        'items': {'type': 'number'},
                    },
                    'confidence': {'type': 'number'},
                },
                'required': ['text', 'bbox'],
            },
        },
    },
    'required': ['annotations'],
}


OCR_BLOCK_RESPONSE_SCHEMA: dict[str, Any] = {
    'type': 'object',
    'properties': {
        'annotations': {
            'type': 'array', 'maxItems': 32,
            'items': {
                'type': 'object',
                'properties': {
                    'text': {'type': 'string'},
                    # Compact [x1, y1, x2, y2] form cuts response tokens;
                    # the OCR parser maps it back to the same source-pixel box.
                    'bbox': {
                        'type': 'array', 'minItems': 4, 'maxItems': 4,
                        'items': {'type': 'number'},
                    },
                    'confidence': {'type': 'number'},
                },
                'required': ['text', 'bbox'],
            },
        },
    },
    'required': ['annotations'],
}


OCR_ROW_RESPONSE_SCHEMA: dict[str, Any] = {
    'type': 'object',
    'properties': {
        'text': {'type': 'string'},
        'confidence': {'type': 'number'},
        'cells': {
            'type': 'array', 'maxItems': 16,
            'items': {
                'type': 'object',
                'properties': {
                    'text': {'type': 'string'},
                    'bbox': {'type': 'array', 'minItems': 4, 'maxItems': 4,
                             'items': {'type': 'number'}},
                    'confidence': {'type': 'number'},
                },
                'required': ['text', 'bbox'],
            },
        },
    },
    'required': ['text', 'confidence'],
}

OCR_ROWS_RESPONSE_SCHEMA: dict[str, Any] = {
    'type': 'object',
    'properties': {
        'rows': {
            'type': 'array', 'minItems': 2, 'maxItems': 2,
            'items': {
                'type': 'object',
                'properties': {
                    'text': {'type': 'string'},
                    'confidence': {'type': 'number'},
                    # Optional cell boxes are used for compact handwritten
                    # tables. Coordinates refer to the exact image sent for
                    # the paired-row request, not to the original page.
                    'cells': {
                        'type': 'array', 'maxItems': 16,
                        'items': {
                            'type': 'object',
                            'properties': {
                                'text': {'type': 'string'},
                                'bbox': {
                                    'type': 'array', 'minItems': 4, 'maxItems': 4,
                                    'items': {'type': 'number'},
                                },
                                'confidence': {'type': 'number'},
                            },
                            'required': ['text', 'bbox'],
                        },
                    },
                },
                'required': ['text', 'confidence'],
            },
        },
    },
    'required': ['rows'],
}


def _detect_handwritten_row_bands(image: Image.Image, block: dict[str, Any]) -> list[dict[str, int]]:
    """Locate individual handwritten rows using the numbered left margin.

    A vertical ink projection in the narrow left column finds the circled item
    markers without requiring a separate OCR result. We use non-maximum
    suppression to estimate how many rows exist, then fit a regular row pitch
    to those ink peaks. This is more stable than asking a 4B model to read a
    dense ten-row note as one image.
    """
    try:
        x, y = int(block['x']), int(block['y'])
        width, height = int(block['w']), int(block['h'])
        if width < 90 or height < 65:
            return []
        crop = image.crop((max(0, x), max(0, y), min(image.width, x + width), min(image.height, y + height))).convert('RGB')
        rgb = np.asarray(crop)
        gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
        hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
        hue, sat, val = cv2.split(hsv)
        ink = (((hue >= 82) & (hue <= 155) & (sat >= 18) & (val <= 252)) | (gray < 145)).astype(np.uint8)
        strip_width = max(18, min(42, int(round(width * 0.12))))
        projection = ink[:, :strip_width].sum(axis=1).astype(np.float32)
        smooth_width = max(5, int(round(height * 0.045)) | 1)
        smooth = np.convolve(projection, np.ones(smooth_width, dtype=np.float32) / smooth_width, mode='same')
        if float(smooth.max(initial=0.0)) < 1.8:
            return []

        # Find distinct ink bands in the number column, suppressing multiple
        # peaks from one hand-drawn circle. Keep 5..18 rows; other note layouts
        # use the whole-block OCR fallback.
        local_peaks: list[tuple[float, int]] = []
        for yy in range(1, height - 1):
            if smooth[yy] >= smooth[yy - 1] and smooth[yy] >= smooth[yy + 1] and smooth[yy] >= 2.0:
                local_peaks.append((float(smooth[yy]), yy))
        min_spacing = max(9, int(round(height * 0.055)))
        selected_peaks: list[tuple[float, int]] = []
        for score, yy in sorted(local_peaks, reverse=True):
            if all(abs(yy - old_y) >= min_spacing for _old_score, old_y in selected_peaks):
                selected_peaks.append((score, yy))
        selected_peaks.sort(key=lambda item: item[1])
        if not 3 <= len(selected_peaks) <= 18:
            return []

        # The source-ink block detector estimates the number of actual text
        # rows after joining glyphs. Trust that count when available: a ruled
        # table can create extra local peaks that are not text rows.
        row_hint = int(block.get('row_peaks', 0) or 0)
        row_count = row_hint if 3 <= row_hint <= 18 else len(selected_peaks)
        if row_count > len(selected_peaks):
            row_count = len(selected_peaks)
        hinted_rows = 3 <= row_hint <= 18
        target_pitch = (height * 0.90 / float(max(1, row_count - 1))) if hinted_rows else height / float(row_count + 1)
        best = None
        min_pitch = max(8.5, target_pitch * 0.76)
        max_pitch = min(64.0, target_pitch * 1.24)
        for pitch in np.linspace(min_pitch, max_pitch, 85):
            if hinted_rows:
                start_min = max(1.0, pitch * 0.04)
                start_max = min(pitch * 0.50, height - pitch * (row_count - 1))
            else:
                start_min = max(1.0, pitch * 0.32)
                start_max = min(pitch * 1.55, height / max(1, row_count))
            if start_max < start_min:
                continue
            for row_start in np.linspace(start_min, start_max, 55):
                centers = [row_start + i * pitch for i in range(row_count)]
                if centers[-1] >= height - 1.0:
                    continue
                score = 0.0
                for center in centers:
                    cy = int(round(center))
                    lo, hi = max(0, cy - 2), min(height, cy + 3)
                    score += float(np.max(smooth[lo:hi])) if hi > lo else 0.0
                score -= abs(float(pitch) - target_pitch) * row_count * 0.10
                if best is None or score > best[0]:
                    best = (score, float(pitch), float(row_start), centers)
        if best is None:
            return []
        _score, pitch, _start, centers = best
        peak_floor = max(1.6, float(np.percentile(smooth, 72)) * 0.26)
        if sum(float(np.max(smooth[max(0, int(c)-2):min(height, int(c)+3)])) >= peak_floor for c in centers) < max(2, int(math.ceil(row_count * 0.60))):
            return []

        rows = []
        pad = max(1, int(round(pitch * 0.06)))
        for index, center in enumerate(centers):
            band_top = max(0.0, center - pitch / 2.0) if index == 0 else (centers[index - 1] + center) / 2.0
            band_bottom = min(float(height), center + pitch / 2.0) if index == row_count - 1 else (center + centers[index + 1]) / 2.0
            top = max(0, int(math.floor(band_top - pad)))
            bottom = min(height, int(math.ceil(band_bottom + pad)))
            if bottom - top < 9:
                continue
            rows.append({'x': x, 'y': y + top, 'w': width, 'h': bottom - top,
                         'row': index + 1, 'center_y': round(y + center, 1),
                         'pitch': round(pitch, 1), 'ink_peak': round(float(np.max(smooth[max(0, int(center)-2):min(height, int(center)+3)])), 2)})
        return rows if len(rows) >= 3 else []
    except Exception:
        return []


def _run_numbered_row_ocr(image: Image.Image, block: dict[str, Any], rows: list[dict[str, int]], *,
                          url: str, model: str, timeout: float, max_edge: int,
                          max_tokens: int) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """OCR numbered rows in pairs, retrying incomplete/uncertain rows individually.

    A pair crop keeps the same horizontal context and, after Ollama's max-edge
    resize, approximately the same pixel height per row as a single-row crop.
    Rows that are absent, malformed, or below the normal confidence threshold
    are re-read individually. Thus batching removes repeated prompt prefill for
    clear rows without silently accepting weaker readings.
    """
    results: list[dict[str, Any]] = []
    row_diags: list[dict[str, Any]] = []
    batch_diags: list[dict[str, Any]] = []
    batch_size = max(1, min(2, int(os.getenv('QWEN_OCR_ROW_BATCH_SIZE', '2'))))
    batches = [rows[index:index + batch_size] for index in range(0, len(rows), batch_size)]
    _progress('OCR', f'Handwritten rows: {len(rows)} detected; batches={len(batches)}')

    def row_box(row: dict[str, Any]) -> tuple[int, int, int, int]:
        left = max(0, int(row['x']) - 2)
        top = max(0, int(row['y']))
        right = min(image.width, int(row['x'] + row['w']) + 4)
        bottom = min(image.height, int(row['y'] + row['h']))
        return left, top, right, bottom

    def normalize(value: Any) -> tuple[str, float, bool]:
        text = re.sub(r'\s+', ' ', str(value.get('text', '') if isinstance(value, dict) else '')).strip() or '?'
        try:
            confidence = float(value.get('confidence', 0) or 0) if isinstance(value, dict) else 0.0
        except (TypeError, ValueError):
            confidence = 0.0
        if 0 <= confidence <= 1:
            confidence *= 100.0
        confidence = max(0.0, min(100.0, confidence))
        alnum = bool(re.search(r'[A-Za-zА-Яа-я0-9ØøΦφДдУу]', text))
        return text, confidence, bool(confidence >= 58 and alnum and text != '?')

    def make_result(row: dict[str, Any], box: tuple[int, int, int, int],
                    parsed_row: Any, *, diag: dict[str, Any], fallback: bool = False) -> dict[str, Any]:
        left, top, right, bottom = box
        text, confidence, verified = normalize(parsed_row)
        diag.update({'text_preview': text[:100], 'confidence': round(confidence, 1),
                     'accepted': bool(text != '?' and bool(re.search(r'[A-Za-zА-Яа-я0-9ØøΦφДдУу]', text))),
                     'verified': verified, 'fallback_single_row': fallback})
        return {
            'id': f'QBR{row["row"]}', 'text': text,
            'confidence': round(confidence, 1),
            'bbox': {'x': left, 'y': top, 'w': right-left, 'h': bottom-top},
            'verified': verified, 'include': verified,
            'geometry_exclude': True, 'source': 'qwen3-vl-block',
            'block_line': True, 'row_index': row['row'],
        }

    def make_cell_results(row: dict[str, Any], cells: Any, *,
                          crop_origin: tuple[int, int], coordinate_scale: float,
                          sent_size: tuple[int, int], row_source_box: tuple[int, int, int, int],
                          row_confidence: float) -> list[dict[str, Any]]:
        if not isinstance(cells, list) or len(cells) < 2 or coordinate_scale <= 0:
            return []
        crop_left, crop_top = crop_origin
        sent_width, sent_height = sent_size
        row_left, row_top, row_right, row_bottom = row_source_box
        output: list[dict[str, Any]] = []
        for cell_index, cell in enumerate(cells[:16], 1):
            if not isinstance(cell, dict):
                continue
            text = re.sub(r'\s+', ' ', str(cell.get('text') or '')).strip()
            raw_box = cell.get('bbox') or cell.get('box')
            if not text or not isinstance(raw_box, (list, tuple)) or len(raw_box) != 4:
                continue
            try:
                x1, y1, x2, y2 = (float(value) for value in raw_box)
                confidence = float(cell.get('confidence', row_confidence) or 0)
            except (TypeError, ValueError):
                continue
            if 0 <= confidence <= 1:
                confidence *= 100.0
            if not all(math.isfinite(value) for value in (x1, y1, x2, y2, confidence)):
                continue
            # Reject malformed boxes instead of allowing them to drift to a
            # different part of the sheet during crop/resize coordinate mapping.
            if (x2 <= x1 or y2 <= y1 or x1 < -2 or y1 < -2
                    or x2 > sent_width + 2 or y2 > sent_height + 2):
                continue
            gx1 = crop_left + max(0.0, x1) / coordinate_scale
            gy1 = crop_top + max(0.0, y1) / coordinate_scale
            gx2 = crop_left + min(float(sent_width), x2) / coordinate_scale
            gy2 = crop_top + min(float(sent_height), y2) / coordinate_scale
            # A cell must belong to this row. This catches tile-relative or
            # normalized boxes that were accidentally reported in another space.
            if gy2 < row_top - 8 or gy1 > row_bottom + 8:
                continue
            gx1 = max(float(row_left), gx1)
            gy1 = max(float(row_top), gy1)
            gx2 = min(float(row_right), gx2)
            gy2 = min(float(row_bottom), gy2)
            bw, bh = gx2 - gx1, gy2 - gy1
            if bw < 2 or bh < 3:
                continue
            has_alnum = bool(re.search(r'[A-Za-zА-Яа-я0-9ØøΦφДдУу]', text))
            if not has_alnum:
                continue
            verified = confidence >= 58 and text != '?'
            output.append({
                'id': f'QBR{row["row"]}C{cell_index}', 'text': text,
                'confidence': round(max(0.0, min(100.0, confidence)), 1),
                'bbox': {'x': round(gx1, 2), 'y': round(gy1, 2),
                         'w': round(bw, 2), 'h': round(bh, 2)},
                'verified': verified, 'include': verified,
                'geometry_exclude': True, 'source': 'qwen3-vl-block',
                'block_line': True, 'row_index': row['row'],
                'table_cell': True,
                'bbox_coordinate_space': 'original-image-pixels',
                'bbox_source': 'paired-row-crop-cell',
                'source_crop_xyxy': [int(crop_left), int(crop_top),
                                     int(crop_left + round(sent_width / coordinate_scale)),
                                     int(crop_top + round(sent_height / coordinate_scale))],
                'source_row_bbox': {'x': int(row_left), 'y': int(row_top),
                                    'w': int(row_right - row_left), 'h': int(row_bottom - row_top)},
            })
        return output

    def single_row_read(row: dict[str, Any], *, batch_index: int, reason: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        box = row_box(row)
        left, top, right, bottom = box
        crop = image.crop((left, top, right, bottom)).convert('RGB')
        scale = min(4.0, max(2.5, 84.0 / max(1.0, crop.height)))
        crop = crop.resize((max(1, int(round(crop.width * scale))),
                            max(1, int(round(crop.height * scale)))), Image.Resampling.LANCZOS)
        diag: dict[str, Any] = {'row': row['row'], 'center_y': row['center_y'],
                                'bbox': {'x': left, 'y': top, 'w': right-left, 'h': bottom-top},
                                'input_size': list(crop.size), 'batch_index': batch_index,
                                'request_mode': 'single_fallback', 'fallback_reason': reason}
        _progress('OCR', f'Handwritten row {row["row"]} individual retry started ({reason})')
        prompt = (
            'Это ОДНА строка рукописного нумерованного списка на инженерной схеме. '
            'Выполни точное OCR только этой строки. Прочитай слева направо. '
            'Сохрани номер слева, все кириллические и латинские буквы, цифры, знаки +, '
            'скобки и код в конце без исправления и перевода. Не описывай графику. '
            'Не добавляй невидимые слова. При частичной нечитаемости используй [?] только '
            'вместо нечитабельного фрагмента; если строка совсем не читается, text="?". '
            'Если строка — компактная таблица с раздельными колонками, добавь cells: '
            'каждый элемент отдельно с tight bbox [x1,y1,x2,y2] в пикселях именно этого '
            'отправленного изображения; не используй нормированные координаты 0..1000. '
            'Для обычной текстовой строки cells не добавляй. '
            'Верни строго JSON: {"text":"1) буквальный текст (0405)","confidence":65,"cells":[{"text":"1)","bbox":[5,5,20,25]}]}. '
            'confidence — число 0..100, не завышай уверенность.'
        )
        try:
            row_timeout = max(8.0, min(25.0, float(timeout) / max(1, len(rows))))
            parsed, resize_scale, sent_size = _qwen_call(
                crop, prompt, url=url, model=model, timeout=row_timeout,
                max_edge=max_edge, num_predict=max(128, min(320, int(max_tokens))),
                diagnostics=diag, format_schema=OCR_ROW_RESPONSE_SCHEMA
            )
            diag['sent_size'] = list(sent_size)
            _row_text, row_confidence, row_verified = normalize(parsed)
            cell_results = make_cell_results(
                row, parsed.get('cells') if isinstance(parsed, dict) else None,
                crop_origin=(left, top), coordinate_scale=scale * resize_scale,
                sent_size=sent_size, row_source_box=box, row_confidence=row_confidence
            ) if row_verified and row_confidence >= 70.0 else []
            if len(cell_results) >= 2:
                diag.update({'table_cells': len(cell_results), 'cell_boxes_used': True,
                             'bbox_coordinate_space': 'original-image-pixels',
                             'crop_origin': [left, top],
                             'crop_coordinate_scale': round(float(scale * resize_scale), 6),
                             'sent_size': list(sent_size)})
                result = cell_results
            else:
                result = [make_result(row, box, parsed, diag=diag, fallback=True)]
        except Exception as error:
            diag['error'] = (str(error).strip() or error.__class__.__name__)[:180]
            diag['confidence'] = 0.0
            diag['accepted'] = False
            diag['verified'] = False
            diag['fallback_single_row'] = True
            result = [{
                'id': f'QBR{row["row"]}', 'text': '?', 'confidence': 0.0,
                'bbox': {'x': left, 'y': top, 'w': right-left, 'h': bottom-top},
                'verified': False, 'include': False, 'geometry_exclude': True,
                'source': 'qwen3-vl-block', 'block_line': True, 'row_index': row['row'],
            }]
        accepted = bool(result) and all(item.get('verified') for item in result)
        state = 'accepted' if accepted else ('failed' if diag.get('error') else 'review')
        _progress('OCR', f'Handwritten row {row["row"]} individual retry completed ({state})')
        return result, diag

    for batch_index, batch in enumerate(batches, 1):
        first_box, last_box = row_box(batch[0]), row_box(batch[-1])
        left = min(item[0] for item in (first_box, last_box))
        top = first_box[1]
        right = max(item[2] for item in (first_box, last_box))
        bottom = last_box[3]
        batch_diag: dict[str, Any] = {
            'batch': batch_index, 'rows': [int(row['row']) for row in batch],
            'bbox': {'x': left, 'y': top, 'w': right-left, 'h': bottom-top},
        }
        batch_diags.append(batch_diag)
        _progress('OCR', f'Handwritten batch {batch_index}/{len(batches)} started; rows {batch[0]["row"]}-{batch[-1]["row"]}')

        parsed_rows: list[Any] | None = None
        if len(batch) == 2:
            crop = image.crop((left, top, right, bottom)).convert('RGB')
            # Scale by the number of rows, preserving roughly the same target
            # height for each row as the former one-request-per-row approach.
            target_height = 84.0 * len(batch)
            scale = min(4.0, max(2.5, target_height / max(1.0, crop.height)))
            crop = crop.resize((max(1, int(round(crop.width * scale))),
                                max(1, int(round(crop.height * scale)))), Image.Resampling.LANCZOS)
            prompt = (
                'На изображении ровно ДВЕ соседние строки одного рукописного нумерованного '
                'списка инженерной схемы. Прочитай ОБЕ строки полностью, отдельно, сверху вниз. '
                'Для каждой сохрани номер слева, кириллические и латинские буквы, цифры, знаки +, '
                'скобки и коды в конце буквально, без исправлений и перевода. Не описывай графику, '
                'не пропускай короткие цифры и не объединяй строки. Если фрагмент неразборчив, '
                'поставь [?] только на его месте; не додумывай текст. Если строка является '
                'короткой таблицей с раздельными колонками (например, номер строки и несколько чисел), '
                'добавь для неё cells: каждый номер/элемент отдельным объектом с tight bbox именно '
                'в отправленном изображении пары строк: [x1,y1,x2,y2], начало координат слева сверху. '
                'Не добавляй cells для обычного предложения или списка без колонок. Поле text всей строки '
                'всё равно обязательно оставь как резервную расшифровку. Верни ровно два объекта '
                'в массиве rows в том же порядке сверху вниз: '
                '{"rows":[{"text":"1) 1 2 3 4","confidence":75,"cells":['
                '{"text":"1)","bbox":[12,8,26,28],"confidence":80},'
                '{"text":"1","bbox":[48,8,58,28],"confidence":80}]},'
                '{"text":"2) 5 6 7 8","confidence":75}]}. '
                'confidence — число 0..100, не завышай уверенность. Только JSON.'
            )
            batch_diag.update({'input_size': list(crop.size), 'request_mode': 'paired_rows', 'crop_upscale': round(float(scale), 6)})
            try:
                batch_timeout = max(12.0, min(35.0, float(timeout) / max(1, len(batches))))
                parsed, batch_resize_scale, sent_size = _qwen_call(
                    crop, prompt, url=url, model=model, timeout=batch_timeout,
                    max_edge=max_edge, num_predict=max(256, min(440, int(max_tokens))),
                    diagnostics=batch_diag, format_schema=OCR_ROWS_RESPONSE_SCHEMA
                )
                batch_diag['sent_size'] = list(sent_size)
                batch_coordinate_scale = scale * batch_resize_scale
                value = parsed.get('rows') if isinstance(parsed, dict) else None
                if isinstance(value, list) and len(value) == len(batch) and all(isinstance(item, dict) for item in value):
                    parsed_rows = value
                else:
                    batch_diag['fallback_reason'] = 'paired_response_incomplete'
            except Exception as error:
                batch_diag['error'] = (str(error).strip() or error.__class__.__name__)[:180]
                batch_diag['fallback_reason'] = 'paired_request_failed'
        else:
            batch_diag['request_mode'] = 'single_row'
            batch_diag['fallback_reason'] = 'odd_final_row'

        for index, row in enumerate(batch):
            box = row_box(row)
            if parsed_rows is not None:
                row_diag = {
                    'row': row['row'], 'center_y': row['center_y'],
                    'bbox': {'x': box[0], 'y': box[1], 'w': box[2]-box[0], 'h': box[3]-box[1]},
                    'batch_index': batch_index, 'batch_size': len(batch),
                    'request_mode': 'paired_rows', 'batch_ollama_total_ms': batch_diag.get('ollama_total_ms'),
                    'batch_eval_count': batch_diag.get('eval_count'),
                }
                parsed_row = parsed_rows[index]
                _text, _confidence, verified = normalize(parsed_row)
                # A compact table needs cell-level positions. Keep these as
                # separate OCR entities so 1/2/3/4 remain over their source
                # columns instead of being printed as one centred sentence.
                if verified and _confidence >= 70.0 and isinstance(parsed_row, dict) and parsed_row.get('cells'):
                    cell_results = make_cell_results(
                        row, parsed_row.get('cells'), crop_origin=(left, top),
                        coordinate_scale=batch_coordinate_scale, sent_size=sent_size,
                        row_source_box=box, row_confidence=_confidence
                    )
                    if len(cell_results) >= 2:
                        results.extend(cell_results)
                        row_diag.update({'table_cells': len(cell_results), 'cell_boxes_used': True,
                                         'bbox_coordinate_space': 'original-image-pixels',
                                         'crop_origin': [left, top],
                                         'crop_coordinate_scale': round(float(batch_coordinate_scale), 6),
                                         'sent_size': list(sent_size)})
                        row_diags.append(row_diag)
                        _progress('OCR', f'Handwritten row {row["row"]} completed (batched, {len(cell_results)} cells)')
                        continue
                # Batched reads are accepted only at a stronger confidence. Any
                # borderline row gets the original single-row image/read path.
                if verified and _confidence >= 70.0:
                    result = make_result(row, box, parsed_row, diag=row_diag)
                    results.append(result)
                    row_diags.append(row_diag)
                    _progress('OCR', f'Handwritten row {row["row"]} completed (batched, accepted)')
                    continue
                reason = 'paired_low_confidence_or_unreadable'
            else:
                reason = str(batch_diag.get('fallback_reason') or 'paired_response_unavailable')
            row_results, row_diag = single_row_read(row, batch_index=batch_index, reason=reason)
            results.extend(row_results)
            row_diags.append(row_diag)
        _progress('OCR', f'Handwritten batch {batch_index}/{len(batches)} completed')

    return results, {
        'rows_detected': len(rows), 'rows_returned': len(results),
        'row_diagnostics': row_diags, 'row_batch_diagnostics': batch_diags,
        'row_batches': len(batches), 'row_batch_size': batch_size,
        'single_row_fallbacks': sum(1 for item in row_diags if item.get('request_mode') == 'single_fallback'),
    }


def _candidate_handwritten_text_blocks(items: list[dict[str, Any]], width: int, height: int,
                                       max_blocks: int = 2,
                                       image: Image.Image | None = None) -> list[dict[str, Any]]:
    """Find dense handwritten note blocks from OCR boxes *and source ink*.

    OCR boxes alone are not a reliable locator: a model can miss every row of a
    handwritten list. The ink-based pass removes long page/pipe rules, joins
    nearby glyphs on the same row, and looks for compact components containing
    several horizontal text rows. It is deliberately limited to a few compact
    blocks so full pipe networks are not sent back to OCR as one giant crop.
    """
    boxes: list[tuple[float, float, float, float]] = []
    for item in items:
        box = item.get('bbox') or {}
        try:
            x, y, w, h = (float(box[k]) for k in ('x', 'y', 'w', 'h'))
        except (KeyError, TypeError, ValueError):
            continue
        if w >= 2 and h >= 2:
            boxes.append((x, y, w, h))

    candidates: list[tuple[float, dict[str, Any]]] = []

    # First: OCR detections can group words and rows even when the original
    # pixels are faint. Keep these as candidate blocks, not as proof of text.
    if len(boxes) >= 5:
        parent = list(range(len(boxes)))

        def find(i: int) -> int:
            while parent[i] != i:
                parent[i] = parent[parent[i]]
                i = parent[i]
            return i

        def union(a: int, b: int) -> None:
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[rb] = ra

        max_x_gap = max(24.0, min(width, height) * 0.035)
        max_y_gap = max(20.0, min(width, height) * 0.030)
        for i, (ax, ay, aw, ah) in enumerate(boxes):
            for j in range(i + 1, len(boxes)):
                bx, by, bw, bh = boxes[j]
                ix = max(0.0, min(ax + aw, bx + bw) - max(ax, bx))
                iy = max(0.0, min(ay + ah, by + bh) - max(ay, by))
                x_overlap = ix / max(1.0, min(aw, bw))
                y_overlap = iy / max(1.0, min(ah, bh))
                x_gap = max(0.0, max(ax - (bx + bw), bx - (ax + aw)))
                y_gap = max(0.0, max(ay - (by + bh), by - (ay + ah)))
                same_row = y_overlap >= 0.22 and x_gap <= max_x_gap
                stacked_rows = x_overlap >= 0.18 and y_gap <= max_y_gap
                close_diagonal = math.hypot(x_gap, y_gap) <= 14.0
                if same_row or stacked_rows or close_diagonal:
                    union(i, j)

        groups: dict[int, list[tuple[float, float, float, float]]] = {}
        for i, box in enumerate(boxes):
            groups.setdefault(find(i), []).append(box)
        image_area = float(width * height)
        for group in groups.values():
            if len(group) < 5:
                continue
            left = min(box[0] for box in group)
            top = min(box[1] for box in group)
            right = max(box[0] + box[2] for box in group)
            bottom = max(box[1] + box[3] for box in group)
            bw, bh = right - left, bottom - top
            area = bw * bh
            aspect = bw / max(1.0, bh)
            if bw < 65 or bh < 48 or area > image_area * 0.28:
                continue
            if not 0.24 <= aspect <= 6.2:
                continue
            score = len(group) * 2.0 + min(12.0, bh / 18.0) - area / max(1.0, image_area) * 10.0
            candidates.append((score, {
                'x': max(0, int(math.floor(left))),
                'y': max(0, int(math.floor(top))),
                'w': min(width, int(math.ceil(right))) - max(0, int(math.floor(left))),
                'h': min(height, int(math.ceil(bottom))) - max(0, int(math.floor(top))),
                'source_boxes': len(group),
                'detection_source': 'ocr-box-cluster',
                'row_peaks': 0,
            }))

    # Second: detect a dense handwritten list even when OCR found few/no boxes.
    # Long dimension rules and pipe strokes are removed before connected
    # components are built; the surviving compact components must contain
    # multiple separated horizontal ink bands (not just one long line).
    if image is not None and width >= 160 and height >= 120:
        try:
            rgb = np.asarray(image.convert('RGB') if isinstance(image, Image.Image) else image)
            if rgb.ndim == 3 and rgb.shape[2] >= 3:
                rgb = rgb[:, :, :3].copy()
                if rgb.shape[1] != width or rgb.shape[0] != height:
                    rgb = cv2.resize(rgb, (width, height), interpolation=cv2.INTER_AREA)
                gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
                hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
                # Dark pencil/ink and saturated blue/red pen on light paper.
                ink = ((gray < 205) | ((hsv[:, :, 1] > 30) & (hsv[:, :, 2] < 250))).astype(np.uint8) * 255
                # Remove only very long page rules; shorter handwritten rows
                # must remain intact for the multi-line detector.
                h_kernel = max(60, int(width * 0.42))
                v_kernel = max(60, int(height * 0.55))
                long_h = cv2.morphologyEx(ink, cv2.MORPH_OPEN, np.ones((1, h_kernel), np.uint8))
                long_v = cv2.morphologyEx(ink, cv2.MORPH_OPEN, np.ones((v_kernel, 1), np.uint8))
                text_ink = cv2.subtract(ink, cv2.bitwise_or(long_h, long_v))
                join_w = max(20, min(48, int(min(width, height) * 0.17)))
                row_joined = cv2.morphologyEx(text_ink, cv2.MORPH_CLOSE, np.ones((1, join_w), np.uint8))
                # Join vertically separated text rows into one candidate block.
                # This affects OCR-region detection only, never the pipe geometry mask.
                vertical_join = max(10, min(40, int(height * 0.20)))
                row_block = cv2.morphologyEx(row_joined, cv2.MORPH_CLOSE, np.ones((vertical_join, 1), np.uint8))
                connected = cv2.dilate(row_block, np.ones((3, 3), np.uint8), iterations=1)
                count, _labels, stats, _centroids = cv2.connectedComponentsWithStats(connected, 8)
                image_area = float(width * height)
                for comp_index in range(1, count):
                    x, y, bw, bh, pixel_area = map(int, stats[comp_index])
                    if bw < max(70, int(width * 0.055)) or bh < max(45, int(height * 0.05)):
                        continue
                    if bw > width * 0.78 or bh > height * 0.72 or pixel_area > image_area * 0.22:
                        continue
                    aspect = bw / max(1.0, bh)
                    if not 0.35 <= aspect <= 5.0:
                        continue
                    roi = row_joined[y:y + bh, x:x + bw]
                    profile = (roi > 0).sum(axis=1).astype(np.float32)
                    smooth = cv2.blur(profile.reshape(-1, 1), (1, 5)).reshape(-1)
                    threshold = max(3.0, bw * 0.018)
                    peaks: list[int] = []
                    for row in range(2, max(2, len(smooth) - 2)):
                        if smooth[row] < threshold or smooth[row] < smooth[row - 1] or smooth[row] < smooth[row + 1]:
                            continue
                        if not peaks or row - peaks[-1] >= 7:
                            peaks.append(row)
                        elif smooth[row] > smooth[peaks[-1]]:
                            peaks[-1] = row
                    if len(peaks) < 3:
                        continue
                    # Extend to include OCR boxes in/near the pixel-derived block;
                    # this gives the line OCR pass a complete text region even if
                    # the first pass detected only a few characters.
                    left, top, right, bottom = x, y, x + bw, y + bh
                    seed_count = 0
                    for bx, by, bww, bhh in boxes:
                        cx, cy = bx + bww / 2.0, by + bhh / 2.0
                        if left - 14 <= cx <= right + 14 and top - 14 <= cy <= bottom + 14:
                            left = min(left, int(math.floor(bx)))
                            top = min(top, int(math.floor(by)))
                            right = max(right, int(math.ceil(bx + bww)))
                            bottom = max(bottom, int(math.ceil(by + bhh)))
                            seed_count += 1
                    left, top = max(0, left), max(0, top)
                    right, bottom = min(width, right), min(height, bottom)
                    area_ratio = ((right - left) * (bottom - top)) / max(1.0, image_area)
                    score = 18.0 + len(peaks) * 3.5 + min(20.0, seed_count * 1.5) - area_ratio * 40.0
                    candidates.append((score, {
                        'x': left, 'y': top, 'w': right - left, 'h': bottom - top,
                        'source_boxes': seed_count,
                        'detection_source': 'source-ink-multiline-block',
                        'row_peaks': len(peaks),
                    }))
        except Exception:
            # OCR box clustering remains available when the image heuristic
            # cannot process an unusual image encoding.
            pass

    candidates.sort(key=lambda item: item[0], reverse=True)
    selected: list[dict[str, Any]] = []
    for _score, box in candidates:
        if any(_boxes_overlap(box, existing) > 0.48 for existing in selected):
            continue
        # Skip large clusters that merely encompass most of a drawing.
        if box['w'] * box['h'] > width * height * 0.30:
            continue
        selected.append(box)
        if len(selected) >= max_blocks:
            break
    return selected


def _run_handwritten_block_ocr(original: Image.Image, seed_items: list[dict[str, Any]], *,
                               url: str, model: str, timeout: float, max_edge: int,
                               max_tokens: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Second OCR pass: transcribe compact handwritten notes line-by-line."""
    blocks = _candidate_handwritten_text_blocks(seed_items, *original.size, max_blocks=2, image=original)
    _progress('OCR', f'Handwritten note blocks detected: {len(blocks)}')
    results: list[dict[str, Any]] = []
    diagnostics: list[dict[str, Any]] = []
    for block_index, block in enumerate(blocks, 1):
        _progress('OCR', f'Handwritten block {block_index}/{len(blocks)} started')
        results_before_block = len(results)
        pad_x = max(8, int(block['w'] * 0.06))
        pad_y = max(8, int(block['h'] * 0.08))
        left = max(0, block['x'] - pad_x)
        top = max(0, block['y'] - pad_y)
        right = min(original.width, block['x'] + block['w'] + pad_x)
        bottom = min(original.height, block['y'] + block['h'] + pad_y)
        crop = original.crop((left, top, right, bottom))
        diag: dict[str, Any] = {'block': block_index, 'bbox': {'x': left, 'y': top, 'w': right-left, 'h': bottom-top},
                                'seed_boxes': block['source_boxes'], 'detection_source': block.get('detection_source'), 'row_peaks': block.get('row_peaks', 0)}
        row_bands = _detect_handwritten_row_bands(original, block)
        if len(row_bands) >= 3:
            row_results, row_summary = _run_numbered_row_ocr(
                original, block, row_bands, url=url, model=model, timeout=timeout,
                max_edge=max_edge, max_tokens=max_tokens
            )
            results.extend(row_results)
            diag.update(row_summary)
            diag['strategy'] = 'numbered-left-margin-row-crops'
            diag['accepted_lines'] = len(row_results)
            diag['verified_lines'] = sum(1 for item in row_results if item.get('verified'))
            diagnostics.append(diag)
            _progress('OCR', f'Handwritten block {block_index}/{len(blocks)} completed ({len(row_results)} rows)')
            continue
        prompt = (
            'Это крупный фрагмент рукописной технической схемы с плотной текстовой заметкой или нумерованным списком. '
            'Выполни OCR ИМЕННО текста, не геометрии. Прочитай каждую строку целиком слева направо и сверху вниз. '
            'Сохраняй номера пунктов, кириллические и латинские буквы, цифры, скобки, плюсы, дроби и коды в скобках. '
            'НЕ дроби слово на отдельные буквы и не объединяй соседние строки. Одна строка списка — один объект annotations. '
            'Если строка частично читается, передай читаемую часть буквально; не додумывай. '
            'Если строку совсем нельзя прочитать, верни text="?" с рамкой всей строки. '
            'bbox должен охватывать полную строку, включая номер пункта слева и код/значение справа. '
            'bbox — массив [x1,y1,x2,y2] в пикселях фрагмента: левый верхний и правый нижний углы. '
            'Верни только JSON вида {"annotations":[{"text":"1) пример (0405)",'
            '"bbox":[10,12,230,32],"confidence":60}]}. '
            'Максимум 32 строки. Никаких пояснений.'
        )
        try:
            parsed, resize_scale, sent_size = _qwen_call(
                crop, prompt, url=url, model=model, timeout=timeout,
                max_edge=max_edge, num_predict=max_tokens, diagnostics=diag,
                format_schema=OCR_BLOCK_RESPONSE_SCHEMA
            )
            raw_items, key = _annotation_items_from_response(parsed)
            diag['json_key'] = key
            diag['raw_lines'] = len(raw_items)
            for raw in raw_items:
                if not isinstance(raw, dict):
                    continue
                text_value = raw.get('text', raw.get('value', raw.get('label', '')))
                text = re.sub(r'\s+', ' ', str(text_value)).strip()
                bbox = raw.get('bbox') or raw.get('box')
                if isinstance(bbox, (list, tuple)) and len(bbox) == 4:
                    x1, y1, x2, y2 = map(float, bbox)
                    raw_box = {'x': x1, 'y': y1, 'w': x2-x1, 'h': y2-y1}
                elif isinstance(bbox, dict):
                    try:
                        raw_box = {key: float(bbox[key]) for key in ('x','y','w','h')}
                    except (KeyError, TypeError, ValueError):
                        continue
                else:
                    continue
                confidence = float(raw.get('confidence', raw.get('score', 0)) or 0)
                if 0 <= confidence <= 1:
                    confidence *= 100
                x = int(round(left + raw_box['x'] / max(resize_scale, 1e-9)))
                y = int(round(top + raw_box['y'] / max(resize_scale, 1e-9)))
                bw = int(round(raw_box['w'] / max(resize_scale, 1e-9)))
                bh = int(round(raw_box['h'] / max(resize_scale, 1e-9)))
                x = max(0, min(original.width - 1, x))
                y = max(0, min(original.height - 1, y))
                bw = max(0, min(original.width - x, bw))
                bh = max(0, min(original.height - y, bh))
                if not text or bw < 4 or bh < 5:
                    continue
                alnum = bool(re.search(r'[A-Za-zА-Яа-я0-9ØøΦφДдУу]', text))
                verified = confidence >= 58 and alnum and text != '?'
                results.append({
                    'id': f'QB{len(results)+1}', 'text': text,
                    'confidence': round(max(0.0, min(100.0, confidence)), 1),
                    'bbox': {'x': x, 'y': y, 'w': bw, 'h': bh},
                    'verified': verified, 'include': verified,
                    'geometry_exclude': True, 'source': 'qwen3-vl-block',
                    'block_line': True,
                })
            diag['accepted_lines'] = len(results) - results_before_block
            diag['strategy'] = 'whole-block-fallback'
        except Exception as error:
            diag['error'] = str(error).strip()[:180]
        diagnostics.append(diag)
        if diag.get('error'):
            _progress('OCR', f'Handwritten block {block_index}/{len(blocks)} failed: {diag.get("error", "unknown error")}')
        else:
            _progress('OCR', f'Handwritten block {block_index}/{len(blocks)} completed ({diag.get("accepted_lines", 0)} lines)')
    return results, diagnostics

PIPE_RESPONSE_SCHEMA: dict[str, Any] = {
    'type': 'object',
    'properties': {
        'routes': {
            'type': 'array', 'maxItems': 64,
            'items': {
                'type': 'object',
                'properties': {
                    'id': {'type': 'string'},
                    'points': {
                        'type': 'array', 'minItems': 2, 'maxItems': 64,
                        'items': {
                            'type': 'array', 'minItems': 2, 'maxItems': 2,
                            'items': {'type': 'number'},
                        },
                    },
                    'confidence': {'type': 'number'},
                },
                'required': ['points'],
            },
        },
    },
    'required': ['routes'],
}


# Reserve time before the Node worker's hard timeout so a partial graph can be
# built/exported instead of the Python process being SIGTERM-killed mid-request.
_ANALYSIS_HARD_DEADLINE: float | None = None

def _qwen_attempt_worst_case_seconds(timeout: float, retry_budget: int) -> float:
    factor = max(1.0, min(2.0, float(os.getenv('QWEN_RETRY_TIMEOUT_FACTOR', '1.6'))))
    max_timeout = max(timeout, min(600.0, float(os.getenv('QWEN_RETRY_TIMEOUT_MAX', '360'))))
    attempts = max(0, min(3, int(retry_budget))) + 1
    return sum(min(max_timeout, timeout * (factor ** index)) for index in range(attempts))

def _analysis_has_qwen_budget(timeout: float, retry_budget: int, reserve_seconds: float) -> bool:
    deadline = _ANALYSIS_HARD_DEADLINE
    if deadline is None:
        return True
    required = _qwen_attempt_worst_case_seconds(timeout, retry_budget) + max(0.0, reserve_seconds)
    return time.monotonic() + required <= deadline


CHECKPOINT_VERSION = 1


def _sha256_file(path: str | Path) -> str:
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def _tile_checkpoint_signature(image_sha256: str, stage: str, tile_index: int,
                               settings: dict[str, Any]) -> str:
    identity = {
        'version': CHECKPOINT_VERSION,
        'image_sha256': image_sha256,
        'stage': stage,
        'tile': int(tile_index),
        'settings': settings,
    }
    encoded = json.dumps(identity, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')
    return hashlib.sha256(encoded).hexdigest()


def _tile_checkpoint_path(checkpoint_dir: str | Path | None, stage: str, tile_index: int) -> Path | None:
    if not checkpoint_dir:
        return None
    return Path(checkpoint_dir) / f'{stage}-tile-{int(tile_index):02d}.json'


def _load_tile_checkpoint(checkpoint_dir: str | Path | None, stage: str, tile_index: int,
                          signature: str) -> dict[str, Any] | None:
    path = _tile_checkpoint_path(checkpoint_dir, stage, tile_index)
    if path is None or not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding='utf-8'))
        if (payload.get('version') != CHECKPOINT_VERSION
                or payload.get('signature') != signature
                or payload.get('stage') != stage
                or int(payload.get('tile', 0)) != int(tile_index)
                or payload.get('status') not in {'completed', 'completed_empty'}):
            return None
        if not isinstance(payload.get('items'), list) or not isinstance(payload.get('diagnostics'), dict):
            return None
        return payload
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None


def _save_tile_checkpoint(checkpoint_dir: str | Path | None, stage: str, tile_index: int,
                          signature: str, items: list[dict[str, Any]],
                          diagnostics: dict[str, Any]) -> None:
    path = _tile_checkpoint_path(checkpoint_dir, stage, tile_index)
    if path is None:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        'version': CHECKPOINT_VERSION,
        'signature': signature,
        'stage': stage,
        'tile': int(tile_index),
        'status': 'completed' if items else 'completed_empty',
        'saved_at': time.time(),
        'items': items,
        'diagnostics': diagnostics,
    }
    temporary = path.with_name(path.name + f'.{os.getpid()}.tmp')
    try:
        temporary.write_text(json.dumps(payload, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def _is_retryable_qwen_error(error: Exception) -> bool:
    if isinstance(error, (TimeoutError, socket.timeout, ConnectionResetError, BrokenPipeError)):
        return True
    if isinstance(error, urllib.error.HTTPError):
        return error.code in {408, 425, 429, 500, 502, 503, 504}
    if isinstance(error, urllib.error.URLError):
        reason = getattr(error, 'reason', None)
        return isinstance(reason, (TimeoutError, socket.timeout, ConnectionResetError, OSError))
    message = str(error).lower()
    return bool(re.search(r'ollama http (?:408|425|429|500|502|503|504)\b', message)) or 'timed out' in message or 'timeout' in message


def _qwen_call_with_retry(rgb: Image.Image, prompt: str, *, url: str, model: str, timeout: float,
                          max_edge: int, num_predict: int, diagnostics: dict[str, Any],
                          format_schema: dict[str, Any] | None, retry_state: dict[str, int],
                          stage: str, tile_index: int) -> tuple[dict[str, Any], float, tuple[int, int]]:
    """Retry transient model failures with a bounded per-tile budget and audit trail."""
    attempt = 0
    errors: list[str] = []
    history: list[dict[str, Any]] = []
    factor = max(1.0, min(2.0, float(os.getenv('QWEN_RETRY_TIMEOUT_FACTOR', '1.6'))))
    max_timeout = max(timeout, min(600.0, float(os.getenv('QWEN_RETRY_TIMEOUT_MAX', '360'))))
    backoff = max(0.0, min(5.0, float(os.getenv('QWEN_RETRY_BACKOFF_SECONDS', '1'))))
    retry_budget_at_start = max(0, int(retry_state.get('remaining', 0) or 0))
    while True:
        attempt += 1
        attempt_diag: dict[str, Any] = {}
        attempt_timeout = min(max_timeout, timeout * (factor ** (attempt - 1)))
        attempt_started = time.perf_counter()
        try:
            parsed, resize_scale, sent_size = _qwen_call(
                rgb, prompt, url=url, model=model, timeout=attempt_timeout,
                max_edge=max_edge, num_predict=num_predict,
                diagnostics=attempt_diag, format_schema=format_schema
            )
            elapsed_ms = round((time.perf_counter() - attempt_started) * 1000.0, 1)
            history.append({
                'attempt': attempt, 'timeout_seconds': round(attempt_timeout, 1),
                'status': 'completed', 'elapsed_ms': elapsed_ms,
                'ollama_total_ms': attempt_diag.get('ollama_total_ms'),
                'eval_count': attempt_diag.get('eval_count'),
            })
            diagnostics.update(attempt_diag)
            diagnostics['attempts'] = attempt
            diagnostics['retry_count'] = max(0, attempt - 1)
            diagnostics['retry_budget_at_start'] = retry_budget_at_start
            diagnostics['attempt_history'] = history
            if errors:
                diagnostics['previous_attempt_errors'] = errors[-2:]
            return parsed, resize_scale, sent_size
        except Exception as error:
            elapsed_ms = round((time.perf_counter() - attempt_started) * 1000.0, 1)
            message = (str(error).strip() or error.__class__.__name__)[:220]
            errors.append(message)
            history.append({
                'attempt': attempt, 'timeout_seconds': round(attempt_timeout, 1),
                'status': 'failed', 'elapsed_ms': elapsed_ms,
                'error': message,
                'ollama_total_ms': attempt_diag.get('ollama_total_ms'),
                'eval_count': attempt_diag.get('eval_count'),
            })
            diagnostics.update(attempt_diag)
            if retry_state.get('remaining', 0) > 0 and _is_retryable_qwen_error(error):
                retry_state['remaining'] -= 1
                next_timeout = min(max_timeout, attempt_timeout * factor)
                _progress(stage, f'Tile {tile_index}: transient error on attempt {attempt}; retrying attempt {attempt + 1} with timeout={next_timeout:.0f}s; retries_left={retry_state["remaining"]}')
                if backoff:
                    time.sleep(backoff)
                continue
            diagnostics['attempts'] = attempt
            diagnostics['retry_count'] = max(0, attempt - 1)
            diagnostics['retry_budget_at_start'] = retry_budget_at_start
            diagnostics['attempt_history'] = history
            diagnostics['attempt_errors'] = errors[-3:]
            raise


def _qwen_call(rgb: Image.Image, prompt: str, *, url: str, model: str, timeout: float,
               max_edge: int, num_predict: int = 1536, diagnostics: dict[str, Any] | None = None,
               format_schema: dict[str, Any] | None = None) -> tuple[dict[str, Any], float, tuple[int, int]]:
    """Run one bounded local Ollama vision request and return its resize transform."""
    src_w, src_h = rgb.size
    resize_scale = min(1.0, max_edge / max(src_w, src_h))
    if resize_scale < 1.0:
        rgb = rgb.resize((max(1, round(src_w * resize_scale)), max(1, round(src_h * resize_scale))), Image.Resampling.LANCZOS)
    total_started = time.perf_counter()
    encode_started = time.perf_counter()
    image_buffer = BytesIO()
    # Huffman-table optimization adds CPU work but does not improve decoded
    # image pixels. Keep quality=93 and skip only this lossless file-size pass.
    rgb.save(image_buffer, format='JPEG', quality=93, optimize=False)
    encoded = base64.b64encode(image_buffer.getvalue()).decode('ascii')
    encode_ms = (time.perf_counter() - encode_started) * 1000.0
    payload = {
        'model': model,
        # Retain the model between nearby jobs to avoid an unnecessary cold load.
        # This changes residency only, never model sampling or image quality.
        'keep_alive': (os.getenv('QWEN_KEEP_ALIVE', '10m').strip() or '10m'),
        'messages': [{'role': 'user', 'content': prompt, 'images': [encoded]}],
        'stream': False,
        'format': format_schema or 'json',
        'options': {'temperature': 0, 'num_ctx': 8192, 'num_predict': max(128, min(4096, int(num_predict)))},
    }
    request = urllib.request.Request(
        url, data=json.dumps(payload, ensure_ascii=False).encode('utf-8'),
        headers={'Content-Type': 'application/json'}, method='POST'
    )
    request_started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = json.loads(response.read().decode('utf-8'))
    except urllib.error.HTTPError as error:
        try:
            detail = error.read().decode('utf-8', errors='replace')[:500]
        except Exception:
            detail = ''
        raise RuntimeError(f'Ollama HTTP {error.code}: {detail or error.reason}') from error
    request_ms = (time.perf_counter() - request_started) * 1000.0
    if body.get('error'):
        raise RuntimeError(str(body['error']))
    parse_started = time.perf_counter()
    content = (body.get('message') or {}).get('content', '')
    if not content:
        raise ValueError('Ollama вернула пустое message.content; проверьте совместимость модели и /api/chat.')
    parsed = _parse_json_object(content)
    if diagnostics is not None:
        diagnostics.update({
            'done': body.get('done'),
            'done_reason': body.get('done_reason'),
            'truncated': body.get('done_reason') == 'length',
            'eval_count': body.get('eval_count'),
            'prompt_eval_count': body.get('prompt_eval_count'),
            'response_chars': len(content),
            'json_keys': sorted(str(key) for key in parsed.keys()),
            'annotations_key_count': next((len(parsed[key]) for key in ('annotations', 'texts', 'text_regions', 'labels', 'objects', 'items') if isinstance(parsed.get(key), list)), None),
            'routes_key_count': next((len(parsed[key]) for key in ('routes', 'pipes', 'pipe_routes', 'polylines', 'paths', 'traces') if isinstance(parsed.get(key), list)), None),
            'jpeg_base64_encode_ms': round(encode_ms, 1),
            'ollama_http_ms': round(request_ms, 1),
            'json_parse_ms': round((time.perf_counter() - parse_started) * 1000.0, 1),
            'request_total_ms': round((time.perf_counter() - total_started) * 1000.0, 1),
            'ollama_load_ms': round(float(body['load_duration']) / 1_000_000.0, 1) if isinstance(body.get('load_duration'), (int, float)) else None,
            'ollama_total_ms': round(float(body['total_duration']) / 1_000_000.0, 1) if isinstance(body.get('total_duration'), (int, float)) else None,
            'ollama_prompt_eval_ms': round(float(body['prompt_eval_duration']) / 1_000_000.0, 1) if isinstance(body.get('prompt_eval_duration'), (int, float)) else None,
            'ollama_eval_ms': round(float(body['eval_duration']) / 1_000_000.0, 1) if isinstance(body.get('eval_duration'), (int, float)) else None,
        })
    return parsed, resize_scale, rgb.size



def _annotation_items_from_response(parsed: dict[str, Any]) -> tuple[list[Any], str | None]:
    """Accept common OCR JSON key variants while keeping the parser deterministic."""
    for key in ('annotations', 'texts', 'text_regions', 'labels', 'objects', 'items'):
        value = parsed.get(key)
        if isinstance(value, list):
            return value, key
    if isinstance(parsed.get('text'), str) and any(key in parsed for key in ('bbox', 'box', 'bbox_2d')):
        return [parsed], 'single_object'
    return [], None


def _clip_segment_to_rect(a: list[float], b: list[float], rect: tuple[float, float, float, float]) -> tuple[list[float], list[float]] | None:
    """Liang-Barsky clipping; rect is (left, top, right, bottom)."""
    x0, y0, x1, y1 = map(float, (a[0], a[1], b[0], b[1]))
    left, top, right, bottom = rect
    dx, dy = x1 - x0, y1 - y0
    u0, u1 = 0.0, 1.0
    for p, q in ((-dx, x0 - left), (dx, right - x0), (-dy, y0 - top), (dy, bottom - y0)):
        if abs(p) < 1e-12:
            if q < 0:
                return None
            continue
        r = q / p
        if p < 0:
            u0 = max(u0, r)
        else:
            u1 = min(u1, r)
        if u0 > u1:
            return None
    return ([round(x0 + u0 * dx, 1), round(y0 + u0 * dy, 1)],
            [round(x0 + u1 * dx, 1), round(y0 + u1 * dy, 1)])


def _clip_polyline_to_rect(points: list[list[float]], rect: tuple[float, float, float, float]) -> list[list[list[float]]]:
    """Clip a polyline into visible fragments inside one non-overlap tile core."""
    fragments: list[list[list[float]]] = []
    current: list[list[float]] = []
    for index in range(len(points) - 1):
        clipped = _clip_segment_to_rect(points[index], points[index + 1], rect)
        if clipped is None:
            if len(current) >= 2:
                fragments.append(current)
            current = []
            continue
        first, last = clipped
        if current and math.dist(current[-1], first) <= 1.5:
            if math.dist(current[-1], last) > 0.5:
                current.append(last)
        else:
            if len(current) >= 2:
                fragments.append(current)
            current = [first, last]
    if len(current) >= 2:
        fragments.append(current)
    return fragments


def _qwen_annotations(image_path: str, original_width: int, original_height: int, checkpoint_dir: str | Path | None = None) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """OCR handwriting in overlapping enlarged tiles; keep low-confidence boxes as geometry masks."""
    url = os.getenv('OLLAMA_CHAT_URL', 'http://127.0.0.1:11434/api/chat').strip()
    model = os.getenv('QWEN_MODEL', 'qwen3-vl:4b').strip()
    calls_ok = 0
    errors: list[str] = []
    try:
        max_edge = max(1024, int(os.getenv('QWEN_MAX_IMAGE_EDGE', '1536')))
        timeout = max(10.0, float(os.getenv('QWEN_OCR_TIMEOUT', '180')))
        max_output_tokens = max(512, min(3072, int(os.getenv('QWEN_OCR_MAX_TOKENS', '2048'))))
        retry_budget_per_tile = max(0, min(2, int(os.getenv('QWEN_TILE_RETRY_BUDGET', '1'))))
        image_sha256 = _sha256_file(image_path)
        upscale = max(1.0, min(3.0, float(os.getenv('QWEN_OCR_UPSCALE', '2.0'))))
        with Image.open(image_path) as source:
            original = ImageOps.exif_transpose(source).convert('RGB')
        prompt_template = (
            'Ты читаешь рукописную инженерную схему. Это задача OCR, не трассировки линий. '
            'Внимательно перечисли все читаемые надписи в ЭТОМ фрагменте, включая отдельные цифры, '
            'числа, DN, Ду, Ø, диаметры, размеры, буквенные коды и единицы. Не пропускай короткие метки. '
            'Не переписывай трубы, стрелки и графические символы. Отмечай ВСЕ видимые рукописные текстовые области, '
            'даже если слово или цифры невозможно прочитать: в таком случае верни text="?" и bbox всей надписи. '
            'Не пропускай неразборчивые рукописные пометки. Один bbox — одна надпись или одна группа цифр, '
            'которая написана слитно. Не объединяй разнесённые подписи. Если чтение сомнительно, укажи '
            'наиболее вероятный буквальный текст и низкую confidence; не придумывай символы. '
            'Границы bbox должны охватывать все штрихи надписи, включая длинные связные рукописные штрихи. '
            'bbox — массив [x1,y1,x2,y2] в пикселях отправленного изображения: левый верхний и правый нижний углы. '
            'Верни объект annotations как массив, даже если найден только один текст. '
            'Не возвращай один объект text/bbox вместо массива. Если видишь таблицу или несколько колонок, '
            'верни каждую ячейку отдельно: номер строки и каждое значение — отдельные annotations с тесным bbox. '
            'Никогда не объединяй всю строку, таблицу или несколько разнесённых чисел в один bbox. '
            'Координаты строго в пикселях именно этого отправленного фрагмента, от его левого верхнего угла; '
            'не используй нормализацию 0..1000 и не пересчитывай координаты на весь лист. '
            'Пример формы: {"annotations":[{"text":"1500","bbox":[10,20,45,34],"confidence":72}]}. '
            'Максимум 64 текстовые области на фрагмент. Размер изображения: {width}x{height} px.'
        )
        # Two-by-two crops enlarge handwritten numbers without losing the page context
        # entirely. A 12% overlap prevents labels on tile borders from being clipped.
        grid = max(1, min(3, int(os.getenv('QWEN_OCR_TILE_GRID', '3'))))
        if original_width < 720 or original_height < 520:
            grid = 1
        tile_w = max(1, int(round(original_width / grid)))
        tile_h = max(1, int(round(original_height / grid)))
        overlap = 0.12
        xs = sorted(set([0] + [max(0, original_width - tile_w)] if grid == 2 else [round(i * (original_width - tile_w) / max(1, grid - 1)) for i in range(grid)]))
        ys = sorted(set([0] + [max(0, original_height - tile_h)] if grid == 2 else [round(i * (original_height - tile_h) / max(1, grid - 1)) for i in range(grid)]))
        # Expand adjacent crops slightly around their seam; clamp at image edges.
        pad_x, pad_y = int(tile_w * overlap / 2), int(tile_h * overlap / 2)
        regions = []
        for y0 in ys:
            for x0 in xs:
                left = max(0, x0 - (pad_x if x0 else 0))
                top = max(0, y0 - (pad_y if y0 else 0))
                right = min(original_width, x0 + tile_w + (pad_x if x0 + tile_w < original_width else 0))
                bottom = min(original_height, y0 + tile_h + (pad_y if y0 + tile_h < original_height else 0))
                region = (left, top, right, bottom)
                if region not in regions:
                    regions.append(region)

        items: list[dict[str, Any]] = []
        tile_errors = []
        tile_diagnostics: list[dict[str, Any]] = []
        _progress('OCR', f'Image OCR started: {len(regions)} tiles ({grid}x{grid}); retry_budget_per_tile={retry_budget_per_tile}')
        for tile_index, (left, top, right, bottom) in enumerate(regions, 1):
            _progress('OCR', f'Tile {tile_index}/{len(regions)} started')
            crop = original.crop((left, top, right, bottom))
            # Actually magnify each crop so small handwritten figures reach the
            # vision model at a readable pixel height; respect the VRAM edge cap.
            requested_crop_scale = min(upscale, max_edge / max(crop.size))
            crop_scale = requested_crop_scale if requested_crop_scale > 1.001 else 1.0
            if crop_scale > 1.001:
                crop = crop.resize((max(1, round(crop.width * crop_scale)), max(1, round(crop.height * crop_scale))), Image.Resampling.LANCZOS)
            sent_scale = min(1.0, max_edge / max(crop.size))
            prompt_width = max(1, round(crop.width * sent_scale))
            prompt_height = max(1, round(crop.height * sent_scale))
            prompt = prompt_template.replace('{width}', str(prompt_width)).replace('{height}', str(prompt_height))
            call_diagnostics: dict[str, Any] = {'tile': tile_index, 'crop_size': list(crop.size)}
            checkpoint_settings = {
                'prompt_version': 3, 'model': model, 'grid': grid,
                'region': [int(left), int(top), int(right), int(bottom)],
                'crop_scale': round(float(crop_scale), 6), 'max_edge': max_edge,
                'max_output_tokens': max_output_tokens, 'upscale': upscale,
            }
            checkpoint_signature = _tile_checkpoint_signature(image_sha256, 'ocr', tile_index, checkpoint_settings)
            cached = _load_tile_checkpoint(checkpoint_dir, 'ocr', tile_index, checkpoint_signature)
            if cached is not None:
                cached_items = cached['items']
                items.extend(cached_items)
                calls_ok += 1
                cached_diag = dict(cached['diagnostics'])
                cached_diag.update({'tile': tile_index, 'tile_status': cached.get('status'), 'resumed_from_checkpoint': True})
                cached_diag['accepted_annotations'] = len(cached_items)
                tile_diagnostics.append(cached_diag)
                _progress('OCR', f'Tile {tile_index}/{len(regions)} restored from checkpoint; annotations={len(cached_items)}')
                continue
            reserve_seconds = max(480.0, min(900.0, float(os.getenv('QWEN_OCR_EXPORT_RESERVE_SECONDS', '720'))))
            if not _analysis_has_qwen_budget(timeout, retry_budget_per_tile, reserve_seconds):
                call_diagnostics.update({
                    'tile_status': 'deferred',
                    'error': 'Отложено: оставлено время для рукописного OCR, Tesseract и экспорта частичного результата.',
                    'attempts': 0,
                    'deferred_for_job_deadline': True,
                })
                tile_diagnostics.append(call_diagnostics)
                tile_errors.append(f'плитка {tile_index} отложена до следующего запуска')
                _progress('OCR', f'Tile {tile_index}/{len(regions)} deferred to preserve time for OCR post-processing and graph export')
                continue
            tile_retry_state = {'remaining': retry_budget_per_tile}
            tile_item_start = len(items)
            try:
                parsed, resize_scale, sent_size = _qwen_call_with_retry(
                    crop, prompt, url=url, model=model, timeout=timeout,
                    max_edge=max_edge, num_predict=max_output_tokens, diagnostics=call_diagnostics,
                    format_schema=OCR_RESPONSE_SCHEMA, retry_state=tile_retry_state,
                    stage='OCR', tile_index=tile_index
                )
                coordinate_scale = crop_scale * resize_scale
                sent_width, sent_height = sent_size
                call_diagnostics.update({
                    'source_crop_xyxy': [int(left), int(top), int(right), int(bottom)],
                    'crop_upscale': round(float(crop_scale), 6),
                    'request_resize_scale': round(float(resize_scale), 6),
                    'sent_size': [int(sent_width), int(sent_height)],
                    'bbox_coordinate_space': 'sent_tile_pixels_mapped_to_source_image_pixels',
                })
                raw_items, annotation_key = _annotation_items_from_response(parsed)
                if annotation_key is None:
                    raise ValueError('Qwen OCR ответ не содержит массива annotations.')
                call_diagnostics['annotation_key'] = annotation_key
                call_diagnostics['raw_annotations'] = len(raw_items)
                call_diagnostics['possibly_capped_at_schema_limit'] = len(raw_items) >= 64
                accepted_before = len(items)
                for raw in raw_items:
                    if not isinstance(raw, dict):
                        continue
                    text_value = raw.get('text', raw.get('value', raw.get('label', raw.get('content', ''))))
                    text = re.sub(r'\s+', ' ', str(text_value)).strip()
                    bbox = raw.get('bbox') or raw.get('box') or raw.get('bbox_2d') or raw.get('box_2d')
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
                    # Reject model boxes that are clearly outside the crop it saw.
                    # Small excursions are clipped below; grossly invalid boxes
                    # are not allowed to migrate into the centre of the source page.
                    raw_left, raw_top = float(box['x']), float(box['y'])
                    raw_right = raw_left + float(box['w'])
                    raw_bottom = raw_top + float(box['h'])
                    if (raw_right <= 0 or raw_bottom <= 0 or raw_left >= sent_width * 1.08
                            or raw_top >= sent_height * 1.08
                            or raw_left < -sent_width * 0.08 or raw_top < -sent_height * 0.08):
                        call_diagnostics['rejected_out_of_crop_boxes'] = int(call_diagnostics.get('rejected_out_of_crop_boxes', 0)) + 1
                        continue
                    box['x'] = max(0.0, min(float(sent_width), raw_left))
                    box['y'] = max(0.0, min(float(sent_height), raw_top))
                    box['w'] = max(0.0, min(float(sent_width) - box['x'], raw_right - box['x']))
                    box['h'] = max(0.0, min(float(sent_height) - box['y'], raw_bottom - box['y']))
                    try:
                        confidence = float(raw.get('confidence', raw.get('score', 0)))
                    except (TypeError, ValueError):
                        confidence = 0.0
                    if 0 <= confidence <= 1:
                        confidence *= 100
                    x = int(round(left + box['x'] / coordinate_scale))
                    y = int(round(top + box['y'] / coordinate_scale))
                    bw = int(round(box['w'] / coordinate_scale))
                    bh = int(round(box['h'] / coordinate_scale))
                    x = max(0, min(original_width - 1, x))
                    y = max(0, min(original_height - 1, y))
                    bw = max(0, min(original_width - x, bw))
                    bh = max(0, min(original_height - y, bh))
                    if not text or bw < 2 or bh < 2:
                        continue
                    has_alnum = bool(re.search(r'[A-Za-zА-Яа-я0-9ØøΦφДдУу]', text))
                    if not has_alnum and text != '?':
                        continue
                    accepted = confidence >= 65 and has_alnum
                    # Even a not-yet-approved reading marks a text-shaped region so
                    # its strokes cannot silently become pipe geometry.
                    geometry_exclude = confidence >= 25 and (has_alnum or text in {'?', '??', 'неразборчиво'})
                    items.append({
                        'id': f'Q{len(items) + 1}', 'text': text,
                        'confidence': round(max(0.0, min(100.0, confidence)), 1),
                        'bbox': {'x': x, 'y': y, 'w': bw, 'h': bh},
                        'verified': accepted, 'include': accepted,
                        'geometry_exclude': geometry_exclude,
                        'source': 'qwen3-vl', 'tile': tile_index,
                        'coordinate_space': 'source_image_px',
                        'source_tile_xyxy': [int(left), int(top), int(right), int(bottom)],
                    })
                calls_ok += 1
                tile_items = items[tile_item_start:]
                call_diagnostics['accepted_annotations'] = len(tile_items)
                call_diagnostics['tile_status'] = 'completed' if tile_items else 'completed_empty'
                _save_tile_checkpoint(checkpoint_dir, 'ocr', tile_index, checkpoint_signature, tile_items, call_diagnostics)
                tile_diagnostics.append(call_diagnostics)
                _progress('OCR', f'Tile {tile_index}/{len(regions)} completed; annotations={call_diagnostics["accepted_annotations"]}')
            except Exception as error:
                del items[tile_item_start:]
                message = str(error).strip()[:180] or error.__class__.__name__
                tile_errors.append(message)
                call_diagnostics['error'] = message
                call_diagnostics['tile_status'] = 'failed'
                call_diagnostics['attempts'] = int(call_diagnostics.get('attempts', 1) or 1)
                tile_diagnostics.append(call_diagnostics)
                _progress('OCR', f'Tile {tile_index}/{len(regions)} failed after {call_diagnostics["attempts"]} attempt(s): {message}')

        # A second, line-oriented OCR pass reads dense handwritten note blocks
        # as whole rows instead of independent glyph boxes. This is especially
        # useful for the numbered handwritten list at the right of the drawing.
        block_tokens = max(768, min(2048, int(os.getenv('QWEN_OCR_BLOCK_MAX_TOKENS', '1536'))))
        _progress('OCR', 'Handwritten note OCR pass started')
        block_items, block_diagnostics = _run_handwritten_block_ocr(
            original, items, url=url, model=model, timeout=timeout,
            max_edge=max_edge, max_tokens=block_tokens
        ) if calls_ok > 0 else ([], [])
        _progress('OCR', f'Handwritten note OCR pass completed; blocks={len(block_diagnostics)} rows={sum(int(item.get("rows_returned", 0) or 0) for item in block_diagnostics)}')
        # Prefer a full-row transcription over tiny OCR fragments inside it.
        for block_item in block_items:
            bb = block_item['bbox']
            kept_items = []
            for old_item in items:
                ob = old_item.get('bbox') or {}
                try:
                    old_area = float(ob['w']) * float(ob['h'])
                    block_area = float(bb['w']) * float(bb['h'])
                except Exception:
                    kept_items.append(old_item)
                    continue
                inside = (
                    float(ob.get('x', 0)) >= bb['x'] - 3 and
                    float(ob.get('y', 0)) >= bb['y'] - 3 and
                    float(ob.get('x', 0)) + float(ob.get('w', 0)) <= bb['x'] + bb['w'] + 3 and
                    float(ob.get('y', 0)) + float(ob.get('h', 0)) <= bb['y'] + bb['h'] + 3
                )
                if inside and old_area < block_area * 0.62:
                    continue
                kept_items.append(old_item)
            items = kept_items
            items.append(block_item)

        # Deduplicate boxes repeated in the overlapping tile seams.
        items.sort(key=lambda item: item['confidence'], reverse=True)
        deduped: list[dict[str, Any]] = []
        for item in items:
            box = item['bbox']
            duplicate_index = None
            for index, existing in enumerate(deduped):
                other = existing['bbox']
                ix = max(0, min(box['x'] + box['w'], other['x'] + other['w']) - max(box['x'], other['x']))
                iy = max(0, min(box['y'] + box['h'], other['y'] + other['h']) - max(box['y'], other['y']))
                inter = ix * iy
                smaller = min(box['w'] * box['h'], other['w'] * other['h'])
                if smaller > 0 and inter / smaller >= 0.42:
                    duplicate_index = index
                    break
            if duplicate_index is None:
                deduped.append(item)
            else:
                # Keep the higher-confidence spelling and union the text-region box.
                old = deduped[duplicate_index]
                ob = old['bbox']
                left2, top2 = min(ob['x'], box['x']), min(ob['y'], box['y'])
                right2 = max(ob['x'] + ob['w'], box['x'] + box['w'])
                bottom2 = max(ob['y'] + ob['h'], box['y'] + box['h'])
                old['bbox'] = {'x': left2, 'y': top2, 'w': right2 - left2, 'h': bottom2 - top2}
                old['geometry_exclude'] = old.get('geometry_exclude') or item.get('geometry_exclude')
        for index, item in enumerate(deduped, 1):
            item['id'] = f'Q{index}'
            item.pop('tile', None)
        failed_tiles = [int(item.get('tile', 0)) for item in tile_diagnostics if item.get('tile_status') not in {'completed', 'completed_empty'}]
        complete = calls_ok == len(regions)
        return deduped, {
            'available': calls_ok > 0, 'complete': complete, 'model': model, 'annotations': len(deduped),
            'tiles': len(regions), 'successful_tiles': calls_ok, 'failed_tiles': failed_tiles,
            'tiles_with_annotations': sum(1 for item in tile_diagnostics if item.get('accepted_annotations', 0) > 0),
            'truncated_tiles': sum(1 for item in tile_diagnostics if item.get('truncated')),
            'tile_diagnostics': tile_diagnostics,
            'block_passes': len(block_diagnostics), 'block_diagnostics': block_diagnostics,
            'block_annotations': sum(1 for item in deduped if item.get('source') == 'qwen3-vl-block'),
            'recognized_anything': bool(deduped),
            'empty_result': calls_ok > 0 and not deduped,
            'error': ('; '.join(tile_errors[:2])[:220] if tile_errors else (('OCR-ответы достигли лимита токенов.' if any(item.get('truncated') for item in tile_diagnostics) else 'Все плитки обработаны, но Qwen не вернула распознанных надписей.') if calls_ok > 0 and not deduped else None)),
            'incomplete_reason': (f'Не обработаны OCR-плитки: {failed_tiles}' if failed_tiles else None),
        }
    except Exception as error:
        reason = str(error).strip() or error.__class__.__name__
        return [], {'available': False, 'complete': False, 'model': model, 'annotations': 0,
                    'tiles': len(tile_diagnostics) if 'tile_diagnostics' in locals() else 0,
                    'successful_tiles': calls_ok, 'tile_diagnostics': tile_diagnostics if 'tile_diagnostics' in locals() else [],
                    'error': reason[:220]}


def _semantic_error_hint(error: Exception, model: str) -> tuple[str, str]:
    """Return a user-facing diagnosis and a concrete corrective action."""
    message = str(error).strip() or error.__class__.__name__
    lower = message.lower()
    if 'urlopen error' in lower or 'connection refused' in lower or 'name or service not known' in lower or 'temporary failure in name resolution' in lower:
        return (
            f"Не удаётся подключиться к Ollama: {message[:180]}",
            "Проверьте, что контейнер Ollama запущен и адрес OLLAMA_CHAT_URL доступен из контейнера приложения."
        )
    if '404' in lower or 'not found' in lower or 'model' in lower and ('pull' in lower or 'missing' in lower):
        return (
            f"Модель {model} не найдена в Ollama: {message[:180]}",
            f"Выполните: docker compose exec ollama ollama pull {model} — затем перезапустите app."
        )
    if 'timed out' in lower or 'timeout' in lower or 'time-out' in lower:
        return (
            f"Qwen не успел обработать изображение: {message[:180]}",
            "Успешные плитки сохраняются в .checkpoints. Повторите обработку того же задания: будут запрошены только неготовые плитки. Если тайм-ауты повторяются, проверьте журнал Ollama и фактическую загрузку GPU."
        )
    if 'json' in lower or 'routes' in lower or 'полилини' in lower:
        return (
            f"Ollama ответила, но формат ответа Qwen не удалось разобрать: {message[:180]}",
            "Проверьте версию Ollama и тег QWEN_MODEL; в диагностике graph.json сохранена причина ответа."
        )
    return (f"Ошибка Qwen/Ollama: {message[:200]}", "Проверьте Ollama, доступность модели и журнал контейнера ollama.")


def _qwen_semantic_routes(image_path: str, original_width: int, original_height: int, checkpoint_dir: str | Path | None = None) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Trace pipe centre-lines tile-by-tile so a small model does not need to parse a full sheet at once."""
    url = os.getenv('OLLAMA_CHAT_URL', 'http://127.0.0.1:11434/api/chat').strip()
    model = os.getenv('QWEN_MODEL', 'qwen3-vl:4b').strip()
    raw_count = rejected_low_confidence = rejected_invalid = 0
    tile_diagnostics: list[dict[str, Any]] = []
    try:
        max_edge = max(1024, int(os.getenv('QWEN_PIPE_MAX_IMAGE_EDGE', '1536')))
        timeout = max(20.0, float(os.getenv('QWEN_PIPE_TRACE_TIMEOUT', '240')))
        max_output_tokens = max(768, min(3072, int(os.getenv('QWEN_PIPE_MAX_TOKENS', '2048'))))
        retry_budget_per_tile = max(0, min(2, int(os.getenv('QWEN_TILE_RETRY_BUDGET', '1'))))
        image_sha256 = _sha256_file(image_path)
        grid = max(1, min(3, int(os.getenv('QWEN_PIPE_TILE_GRID', '3'))))
        upscale = max(1.0, min(2.5, float(os.getenv('QWEN_PIPE_UPSCALE', '1.0'))))
        overlap = max(0.05, min(0.25, float(os.getenv('QWEN_PIPE_TILE_OVERLAP', '0.14'))))
        with Image.open(image_path) as source:
            original = ImageOps.exif_transpose(source).convert('RGB')
        original_width, original_height = original.size
        if original_width < 640 or original_height < 480:
            grid = 1
        min_confidence = float(os.getenv('QWEN_PIPE_MIN_CONFIDENCE', '35'))
        result: list[dict[str, Any]] = []
        total_tiles = grid * grid
        _progress('PIPE', f'Pipe tracing started: {total_tiles} tiles ({grid}x{grid}); retry_budget_per_tile={retry_budget_per_tile}')
        for row in range(grid):
            core_top = round(row * original_height / grid)
            core_bottom = round((row + 1) * original_height / grid)
            for col in range(grid):
                core_left = round(col * original_width / grid)
                core_right = round((col + 1) * original_width / grid)
                core_w, core_h = core_right - core_left, core_bottom - core_top
                pad_x, pad_y = round(core_w * overlap / 2), round(core_h * overlap / 2)
                left, top = max(0, core_left - pad_x), max(0, core_top - pad_y)
                right, bottom = min(original_width, core_right + pad_x), min(original_height, core_bottom + pad_y)
                crop = original.crop((left, top, right, bottom))
                requested_scale = min(upscale, max_edge / max(crop.size))
                crop_scale = requested_scale if requested_scale > 1.001 else 1.0
                if crop_scale > 1.001:
                    crop = crop.resize((max(1, round(crop.width * crop_scale)), max(1, round(crop.height * crop_scale))), Image.Resampling.LANCZOS)
                sent_scale = min(1.0, max_edge / max(crop.size))
                sent_width, sent_height = max(1, round(crop.width * sent_scale)), max(1, round(crop.height * sent_scale))
                tile_index = row * grid + col + 1
                prompt = (
                    'Это фрагмент РУКОПИСНОЙ инженерной схемы трубопроводов. Найди на изображении сами линии труб. '
                    'НЕ пытайся распознать всю систему целиком и НЕ описывай её словами. Выполни простую задачу: '
                    'перечисли все видимые непрерывные пути труб как полилинии с точками поворота. '
                    'Труба обычно выглядит как длинный непрерывный штрих или как две близкие параллельные границы. '
                    'Учитывай горизонтальные, вертикальные и диагональные участки. Для одной '
                    'непрерывной трубы объединяй последовательные прямые участки в ОДНУ полилинию: '
                    'на каждом видимом повороте добавь вершину points, не создавая отдельный объект '
                    'для каждого маленького сегмента. Это только компактная запись уже видимого штриха, '
                    'а не разрешение достраивать геометрию. На Т-ответвлении разделяй ветви в точке '
                    'развилки; сохраняй части до и после клапана/фитинга, сам короткий символ клапана '
                    'не рисуй. Разрывы, подписи, пересечения с неясной принадлежностью и неоднозначные '
                    'стыки НЕ соединяй. Не путай трубы с цифрами, буквами, размерными рисками, стрелками, '
                    'наконечниками выносок и рамкой листа. Но НЕ удаляй длинную линию только потому, что '
                    'рядом есть подпись или символ. Не придумывай скрытые участки. Если не уверен, верни '
                    'видимую линию с confidence 40–60, а не пустой массив. Пустой массив допустим только '
                    'если в этом фрагменте действительно нет длинного линейного участка трубы. '
                    f'Координаты — пиксели изображения {sent_width}x{sent_height}; начало (0,0) слева сверху. '
                    'Каждый routes[i].points — упорядоченный список из 2..64 видимых точек одной '
                    'непрерывной полилинии [[x1,y1],[x2,y2],...]. Максимум 64 полилинии. '
                    'Пример: {"routes":[{"id":"S1","points":[[20,80],[180,80],[180,240]],"confidence":70}]}. '
                    'Верни только JSON без текста и без объяснений.'
                )
                diag: dict[str, Any] = {
                    'tile': tile_index, 'row': row + 1, 'column': col + 1,
                    'core': {'x': core_left, 'y': core_top, 'w': core_w, 'h': core_h},
                    'crop': {'x': left, 'y': top, 'w': right - left, 'h': bottom - top},
                }
                checkpoint_settings = {
                    'prompt_version': 3, 'model': model, 'grid': grid,
                    'core': [core_left, core_top, core_right, core_bottom],
                    'crop': [left, top, right, bottom], 'upscale': upscale,
                    'overlap': overlap, 'max_edge': max_edge,
                    'max_output_tokens': max_output_tokens, 'min_confidence': min_confidence,
                }
                checkpoint_signature = _tile_checkpoint_signature(image_sha256, 'pipe', tile_index, checkpoint_settings)
                cached = _load_tile_checkpoint(checkpoint_dir, 'pipe', tile_index, checkpoint_signature)
                if cached is not None:
                    cached_routes = cached['items']
                    result.extend(cached_routes)
                    diag = dict(cached['diagnostics'])
                    diag.update({'tile': tile_index, 'tile_status': 'ok', 'resumed_from_checkpoint': True})
                    diag['accepted_routes'] = len(cached_routes)
                    tile_diagnostics.append(diag)
                    raw_count += int(diag.get('raw_routes', 0) or 0)
                    _progress('PIPE', f'Tile {tile_index}/{total_tiles} restored from checkpoint; routes={len(cached_routes)}')
                    continue
                reserve_seconds = max(120.0, min(240.0, float(os.getenv('QWEN_PIPE_EXPORT_RESERVE_SECONDS', '180'))))
                if not _analysis_has_qwen_budget(timeout, retry_budget_per_tile, reserve_seconds):
                    diag.update({
                        'tile_status': 'deferred',
                        'error': 'Отложено: оставлено время для построения графа и экспорта частичного результата.',
                        'attempts': 0,
                        'deferred_for_job_deadline': True,
                    })
                    tile_diagnostics.append(diag)
                    _progress('PIPE', f'Tile {tile_index}/{total_tiles} deferred to preserve time for graph export')
                    continue
                tile_retry_state = {'remaining': retry_budget_per_tile}
                route_item_start = len(result)
                tile_raw_before = raw_count
                tile_low_before = rejected_low_confidence
                tile_invalid_before = rejected_invalid
                _progress('PIPE', f'Tile {tile_index}/{total_tiles} started')
                try:
                    parsed, resize_scale, sent_size = _qwen_call_with_retry(
                        crop, prompt, url=url, model=model, timeout=timeout,
                        max_edge=max_edge, num_predict=max_output_tokens, diagnostics=diag,
                        format_schema=PIPE_RESPONSE_SCHEMA, retry_state=tile_retry_state,
                        stage='PIPE', tile_index=tile_index
                    )
                    raw_routes = parsed.get('routes', parsed.get('pipes', parsed.get('pipe_routes', parsed.get('polylines', parsed.get('paths', parsed.get('traces', []))))))
                    if not isinstance(raw_routes, list):
                        if isinstance(raw_routes, dict):
                            raw_routes = list(raw_routes.values())
                        else:
                            raise ValueError('Qwen вернул JSON, но поле routes имеет неверный тип.')
                    if raw_routes and all((isinstance(pt, (list, tuple)) and len(pt) >= 2 and all(isinstance(v, (int, float)) for v in pt[:2])) or (isinstance(pt, dict) and 'x' in pt and 'y' in pt) for pt in raw_routes):
                        raw_routes = [{'id': 'P1', 'points': raw_routes}]
                    raw_count += len(raw_routes)
                    diag['raw_routes'] = len(raw_routes)
                    diag['possibly_capped_at_schema_limit'] = len(raw_routes) >= 64
                    accepted_before = len(result)
                    coordinate_scale = crop_scale * resize_scale
                    core_rect = (float(core_left), float(core_top), float(core_right), float(core_bottom))
                    for raw_index, raw in enumerate(raw_routes[:64], 1):
                        if isinstance(raw, list):
                            raw = {'points': raw}
                        if not isinstance(raw, dict):
                            rejected_invalid += 1
                            continue
                        points_raw = raw.get('points') or raw.get('vertices') or raw.get('polyline') or raw.get('coordinates')
                        if not isinstance(points_raw, list) or len(points_raw) < 2:
                            rejected_invalid += 1
                            continue
                        confidence_supplied = 'confidence' in raw or 'score' in raw
                        try:
                            confidence = float(raw.get('confidence', raw.get('score', 60 if not confidence_supplied else 0)))
                        except (TypeError, ValueError):
                            confidence = 60.0 if not confidence_supplied else 0.0
                        if 0 <= confidence <= 1:
                            confidence *= 100
                        mapped: list[list[float]] = []
                        for pt in points_raw[:64]:
                            try:
                                if isinstance(pt, dict):
                                    px, py = float(pt.get('x')), float(pt.get('y'))
                                elif isinstance(pt, (list, tuple)) and len(pt) >= 2:
                                    px, py = float(pt[0]), float(pt[1])
                                else:
                                    continue
                            except (TypeError, ValueError):
                                continue
                            if not math.isfinite(px) or not math.isfinite(py):
                                continue
                            gx, gy = left + px / coordinate_scale, top + py / coordinate_scale
                            gx = max(0.0, min(float(original_width - 1), gx))
                            gy = max(0.0, min(float(original_height - 1), gy))
                            if not mapped or math.dist(mapped[-1], [gx, gy]) >= 2.0:
                                mapped.append([gx, gy])
                        if len(mapped) < 2:
                            rejected_invalid += 1
                            continue
                        # The model sees overlap for context; export only this tile's non-overlap core.
                        fragments = _clip_polyline_to_rect(mapped, core_rect)
                        if not fragments:
                            rejected_invalid += 1
                            continue
                        if confidence < min_confidence:
                            rejected_low_confidence += 1
                            continue
                        for fragment_no, points in enumerate(fragments, 1):
                            length = sum(math.dist(points[i], points[i + 1]) for i in range(len(points) - 1))
                            if len(points) < 2 or length < max(12.0, min(original_width, original_height) * 0.01):
                                rejected_invalid += 1
                                continue
                            result.append({
                                'id': f'T{tile_index}-{str(raw.get("id") or raw_index)[:16]}-{fragment_no}',
                                'points': [[round(p[0], 1), round(p[1], 1)] for p in points],
                                'confidence': round(max(0.0, min(100.0, confidence)), 1),
                                'confidence_assumed': not confidence_supplied,
                                'needs_review': confidence < 60,
                                'source': 'qwen3-vl-semantic-tiled', 'tile': tile_index, 'include': True,
                            })
                    tile_routes = result[route_item_start:]
                    diag['accepted_routes'] = len(tile_routes)
                    diag['tile_status'] = 'ok'
                    _save_tile_checkpoint(checkpoint_dir, 'pipe', tile_index, checkpoint_signature, tile_routes, diag)
                except Exception as error:
                    del result[route_item_start:]
                    raw_count = tile_raw_before
                    rejected_low_confidence = tile_low_before
                    rejected_invalid = tile_invalid_before
                    diag['tile_status'] = 'error'
                    diag['error'] = (str(error).strip() or error.__class__.__name__)[:180]
                    diag['attempts'] = int(diag.get('attempts', 1) or 1)
                tile_diagnostics.append(diag)
                if diag.get('tile_status') == 'ok':
                    _progress('PIPE', f'Tile {tile_index}/{total_tiles} completed; routes={diag.get("accepted_routes", 0)}')
                else:
                    _progress('PIPE', f'Tile {tile_index}/{total_tiles} failed: {diag.get("error", "unknown error")}')

        successful_tiles = sum(1 for item in tile_diagnostics if item.get('tile_status') == 'ok')
        failed_tiles = [int(item.get('tile', 0)) for item in tile_diagnostics if item.get('tile_status') != 'ok']
        complete = successful_tiles == total_tiles
        status = {
            'available': successful_tiles > 0, 'complete': complete, 'model': model,
            'routes': len(result), 'raw_routes': raw_count,
            'rejected_low_confidence': rejected_low_confidence, 'rejected_invalid': rejected_invalid,
            'tiles': total_tiles, 'successful_tiles': successful_tiles, 'failed_tiles': failed_tiles,
            'truncated_tiles': sum(1 for item in tile_diagnostics if item.get('truncated')),
            'tile_diagnostics': tile_diagnostics,
            'error': None, 'hint': None,
            'image_size': {'width': original_width, 'height': original_height},
            'strategy': 'overlapping semantic tiles clipped to non-overlapping cores',
            'incomplete_reason': (f'Не обработаны PIPE-плитки: {failed_tiles}' if failed_tiles else None),
        }
        if not result:
            if successful_tiles == 0 and tile_diagnostics:
                first_error = next((item.get('error') for item in tile_diagnostics if item.get('error')), 'Не удалось получить ответ от Ollama.')
                message, hint = _semantic_error_hint(RuntimeError(first_error), model)
                status['error'] = message[:260]
                status['hint'] = hint[:260]
            elif raw_count == 0 and successful_tiles:
                status['error'] = f'Qwen успешно обработала {successful_tiles}/{len(tile_diagnostics)} фрагментов, но вернула пустой список маршрутов.'
                status['hint'] = 'Промпт теперь запрашивает отдельные прямые отрезки, а не сложные полилинии. Если routes снова пусты, Qwen не распознаёт геометрию даже на уровне сегментов: нужно менять модель/визуальную предобработку, а не порог confidence.'
            elif rejected_low_confidence:
                status['error'] = f'Qwen вернул маршруты, но все ниже порога уверенности {min_confidence:g}%.'
                status['hint'] = 'Проверьте координаты и confidence каждого фрагмента.'
            else:
                status['error'] = f'Qwen вернул {raw_count} элементов, но они не прошли проверку координат, границ фрагмента или длины.'
                status['hint'] = 'Откройте semanticTrace.tile_diagnostics и проверьте координаты каждого фрагмента.'
        return result, status
    except Exception as error:
        message, hint = _semantic_error_hint(error, model)
        return [], {
            'available': False, 'complete': False, 'model': model, 'routes': 0, 'raw_routes': raw_count,
            'rejected_low_confidence': rejected_low_confidence, 'rejected_invalid': rejected_invalid,
            'tiles': len(tile_diagnostics), 'successful_tiles': sum(1 for item in tile_diagnostics if item.get('tile_status') == 'ok'),
            'tile_diagnostics': tile_diagnostics,
            'error': message[:260], 'hint': hint[:260],
        }

def _boxes_overlap(a: dict[str, Any], b: dict[str, Any]) -> float:
    ax, ay, aw, ah = (float(a.get(k, 0)) for k in ('x', 'y', 'w', 'h'))
    bx, by, bw, bh = (float(b.get(k, 0)) for k in ('x', 'y', 'w', 'h'))
    ix = max(0.0, min(ax + aw, bx + bw) - max(ax, bx))
    iy = max(0.0, min(ay + ah, by + bh) - max(ay, by))
    intersection = ix * iy
    union = aw * ah + bw * bh - intersection
    return intersection / union if union > 0 else 0.0


def ocr_annotations(image_path: str, gray: np.ndarray, checkpoint_dir: str | Path | None = None) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Run Qwen first, then use Tesseract as a fallback/supplement."""
    h, w = gray.shape[:2]
    qwen_items, qwen_status = _qwen_annotations(image_path, w, h, checkpoint_dir=checkpoint_dir)
    tesseract_items: list[dict[str, Any]] = []
    tesseract_error = None
    _progress('OCR', 'Tesseract OCR started')
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
            has_alnum = bool(re.search(r'[A-Za-zА-Яа-я0-9ØøΦφДдУу]', text))
            accepted = confidence >= 68 and has_alnum
            tesseract_items.append({
                'id': f'T{len(tesseract_items) + 1}', 'text': text,
                'confidence': round(confidence, 1), 'bbox': box,
                'verified': accepted, 'include': accepted,
                'geometry_exclude': confidence >= 20 and has_alnum, 'source': 'tesseract'
            })
    except Exception as error:
        tesseract_error = str(error)[:180]
        _progress('OCR', f'Tesseract OCR unavailable: {tesseract_error}')

    _progress('OCR', f'Tesseract OCR completed: annotations={len(tesseract_items)}')
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

def select_primary_cad_edges(nodes: list[dict[str, Any]], edges: list[dict[str, Any]],
                             min_dimension: int) -> dict[str, int]:
    """Select coherent route paths for the clean CAD sheet.

    The detector graph deliberately keeps every reviewable segment.  The clean
    export, however, must not turn every valve mark, arrow, letter stroke or
    dimension tick into a pipe.  We therefore classify maximal paths between
    graph junctions/terminals, rather than promoting an entire connected
    component because one edge in it is long.

    A short path is retained when it is a near-collinear continuation through a
    junction.  Short terminal stubs at junctions and isolated marks are left on
    the review layer.  No endpoints are moved and no junctions are auto-joined.
    """
    adjacency: dict[str, list[int]] = {}
    node_by_id = {str(node.get('id')): node for node in nodes}
    for index, edge in enumerate(edges):
        a, b = str(edge.get('from', '')), str(edge.get('to', ''))
        if not a or not b or a == b:
            edge['cad_include'] = False
            edge['cad_reason'] = 'invalid-edge'
            continue
        adjacency.setdefault(a, []).append(index)
        adjacency.setdefault(b, []).append(index)

    component_sizes: dict[str, int] = {}
    for edge in edges:
        cid = str(edge.get('component_id') or '')
        component_sizes[cid] = component_sizes.get(cid, 0) + 1

    min_path = max(14.0, float(min_dimension) * 0.016)
    junction_stub = max(min_path, float(min_dimension) * 0.032)
    cycle_min = max(34.0, float(min_dimension) * 0.042)
    visited: set[int] = set()
    paths: list[dict[str, Any]] = []

    def other_node(edge_index: int, node_id: str) -> str:
        edge = edges[edge_index]
        return str(edge.get('to') if str(edge.get('from')) == node_id else edge.get('from'))

    def edge_length(edge: dict[str, Any]) -> float:
        geometry = edge.get('geometry') or []
        if len(geometry) < 2:
            return 0.0
        return sum(math.dist(geometry[i], geometry[i + 1]) for i in range(len(geometry) - 1))

    def trace(start_node: str, first_index: int) -> dict[str, Any]:
        current = start_node
        edge_index = first_index
        path_edges: list[int] = []
        total = 0.0
        closed = False
        terminal = start_node
        while edge_index not in visited:
            visited.add(edge_index)
            edge = edges[edge_index]
            path_edges.append(edge_index)
            total += edge_length(edge)
            nxt = other_node(edge_index, current)
            terminal = nxt
            if nxt == start_node:
                closed = True
                break
            incident = adjacency.get(nxt, [])
            if len(incident) != 2:
                break
            next_options = [idx for idx in incident if idx not in visited]
            if not next_options:
                break
            current, edge_index = nxt, next_options[0]
        return {
            'edges': path_edges, 'start': start_node, 'end': terminal,
            'length': total, 'closed': closed,
        }

    # Begin at terminals and junctions.  Degree-two nodes are transparent and
    # therefore do not break a route into detector-sized fragments.
    for node_id, incident in adjacency.items():
        if len(incident) == 2:
            continue
        for edge_index in incident:
            if edge_index not in visited:
                paths.append(trace(node_id, edge_index))

    # Remaining all-degree-two components are closed loops.
    for edge_index, edge in enumerate(edges):
        if edge_index not in visited:
            paths.append(trace(str(edge.get('from')), edge_index))

    def outward_vector(node_id: str, edge_index: int) -> tuple[float, float] | None:
        edge = edges[edge_index]
        geometry = edge.get('geometry') or []
        if len(geometry) < 2:
            return None
        if str(edge.get('from')) == node_id:
            a, b = geometry[0], geometry[1]
        else:
            a, b = geometry[-1], geometry[-2]
        vector = (float(b[0]) - float(a[0]), float(b[1]) - float(a[1]))
        length = math.hypot(*vector)
        return (vector[0] / length, vector[1] / length) if length > 1e-6 else None

    def has_opposite_continuation(path: dict[str, Any], node_id: str, path_edge: int) -> bool:
        """Does a short path continue nearly straight through this junction?"""
        current = outward_vector(node_id, path_edge)
        if current is None:
            return False
        for candidate_index in adjacency.get(node_id, []):
            if candidate_index == path_edge:
                continue
            candidate = outward_vector(node_id, candidate_index)
            if candidate is None:
                continue
            # Vectors both point out from the junction; opposite means a
            # straight-through route (within about 27 degrees).
            if current[0] * candidate[0] + current[1] * candidate[1] <= -0.89:
                return True
        return False

    for path in paths:
        path_edges = path['edges']
        if not path_edges:
            continue
        start, end = path['start'], path['end']
        start_degree = len(adjacency.get(start, []))
        end_degree = len(adjacency.get(end, []))
        total = float(path['length'])
        is_cycle = bool(path['closed'] or start == end)
        component_ids = {str(edges[index].get('component_id') or '') for index in path_edges}
        component_size = max((component_sizes.get(cid, 0) for cid in component_ids), default=len(path_edges))
        single_edge_isolated = len(path_edges) == 1 and component_size == 1 and start_degree == 1 and end_degree == 1
        path_roles = {str(edges[index].get('component_role') or 'line_structure') for index in path_edges}
        has_text_role = 'text_or_annotation' in path_roles
        has_ambiguous_role = 'ambiguous' in path_roles

        continuation = False
        if start_degree >= 3:
            continuation = continuation or has_opposite_continuation(path, start, path_edges[0])
        if end_degree >= 3:
            continuation = continuation or has_opposite_continuation(path, end, path_edges[-1])

        if has_text_role:
            keep = False
            reason = 'text-or-annotation'
        elif has_ambiguous_role and not single_edge_isolated:
            # A component may be ambiguous only because a hand-drawn pipe was
            # fragmented by LSD/Hough. Promote it when the individual path is
            # still a connected multi-edge route with adequate ink support and
            # little OCR overlap. Dense text/symbol clusters remain review-only.
            path_edges_data = [edges[index] for index in path_edges]
            path_points = [point for edge in path_edges_data for point in (edge.get('geometry') or [])]
            path_x = [point[0] for point in path_points]
            path_y = [point[1] for point in path_points]
            path_extent = max(max(path_x) - min(path_x), max(path_y) - min(path_y)) if path_points else 0.0
            path_support = float(np.mean([edge.get('ink_support', 0.0) for edge in path_edges_data])) if path_edges_data else 0.0
            path_overlap = max((float(edge.get('ocr_overlap', 0.0)) for edge in path_edges_data), default=0.0)
            path_turns = 0
            for left_edge, right_edge in zip(path_edges_data, path_edges_data[1:]):
                ga, gb = left_edge.get('geometry') or [], right_edge.get('geometry') or []
                if len(ga) >= 2 and len(gb) >= 2:
                    va = np.array(ga[-1], dtype=float) - np.array(ga[0], dtype=float)
                    vb = np.array(gb[-1], dtype=float) - np.array(gb[0], dtype=float)
                    na, nb = np.linalg.norm(va), np.linalg.norm(vb)
                    if na > 0 and nb > 0 and abs(float(np.dot(va/na, vb/nb))) < 0.90:
                        path_turns += 1
            ambiguous_route_candidate = (
                len(path_edges) >= 2 and total >= max(24.0, float(min_dimension) * 0.027)
                and path_extent >= max(18.0, float(min_dimension) * 0.020)
                and path_support >= 0.27 and path_overlap < 0.16
                and path_turns <= 7 and max(start_degree, end_degree) <= 5
            )
            keep = ambiguous_route_candidate
            reason = 'ambiguous-but-connected-route' if keep else 'ambiguous-component'

        elif is_cycle:
            keep = total >= cycle_min
            reason = 'closed-route' if keep else 'short-closed-mark'
        elif single_edge_isolated:
            # A solitary long stroke is indistinguishable from a dimension line,
            # arrow shaft or handwritten flourish without topology evidence.
            # Preserve it for review rather than manufacturing a pipe.
            keep = False
            reason = 'isolated-stroke-review'
        elif (start_degree >= 3 and end_degree == 1) or (end_degree >= 3 and start_degree == 1):
            # Short real branches often terminate at a fitting or continue as
            # a faint hand-drawn line. Admit them only when attached to a
            # multi-edge component already classified as pipe-like and their
            # own source ink is strong; isolated valve/arrow ticks remain review.
            edge_support = min((float(edges[index].get('ink_support', 0.0)) for index in path_edges), default=0.0)
            edge_overlap = max((float(edges[index].get('ocr_overlap', 0.0)) for index in path_edges), default=1.0)
            has_text_crossing = any(edges[index].get('text_crossing') for index in path_edges)
            supported_branch = (
                total >= max(14.0, float(min_dimension) * 0.016)
                and component_size >= 3
                and path_roles == {'line_structure'}
                and edge_support >= 0.30
                and edge_overlap < 0.10
                and not has_text_crossing
            )
            keep = total >= junction_stub or (continuation and total >= min_path) or supported_branch
            reason = ('supported-short-branch' if supported_branch and total < junction_stub
                      else ('branch-route' if keep else 'short-symbol-stub'))
        else:
            keep = total >= min_path
            reason = 'coherent-route' if keep else 'short-fragment'

        if continuation and total >= min_path and not has_text_role:
            keep = True
            reason = 'collinear-continuation'

        # The earlier endpoint heuristic can explicitly identify a short
        # detached, coaxial continuation across a small scan gap. Preserve it.
        if any(edges[index].get('continuation_candidate') for index in path_edges) and total >= 8.0 and not has_text_role:
            keep = True
            reason = 'collinear-continuation'

        for index in path_edges:
            edges[index]['cad_include'] = bool(keep)
            edges[index]['cad_reason'] = reason

    # Defensive default for malformed/disconnected records.
    for edge in edges:
        edge.setdefault('cad_include', False)
        edge.setdefault('cad_reason', 'unclassified')

    selected = sum(1 for edge in edges if edge.get('cad_include'))
    reason_counts: dict[str, int] = {}
    for edge in edges:
        reason = str(edge.get('cad_reason', 'unclassified'))
        reason_counts[reason] = reason_counts.get(reason, 0) + 1
    return {
        'cad_primary_edges': selected,
        'cad_review_edges': len(edges) - selected,
        'cad_primary_paths': sum(1 for path in paths if path['edges'] and all(edges[i].get('cad_include') for i in path['edges'])),
        'cad_selection_reasons': reason_counts,
        'cad_min_path_px': int(round(min_path)),
        'cad_min_junction_branch_px': int(round(junction_stub)),
    }


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
        if not source.get('cad_include', source.get('component_role') == 'line_structure') or len(source.get('geometry') or []) < 2:
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

    # Ramer-Douglas-Peucker: remove small hand-drawn / detector zig-zags while
    # preserving actual corners and branches. Tolerance is in source pixels.
    tolerance = max(2.4, min(1200.0, 850.0) * 0.006)

    def distance_to_segment(point, start, end):
        dx, dy = end[0] - start[0], end[1] - start[1]
        length_sq = dx * dx + dy * dy
        if length_sq < 1e-9:
            return math.dist(point, start)
        t = max(0.0, min(1.0, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / length_sq))
        projection = (start[0] + t * dx, start[1] + t * dy)
        return math.dist(point, projection)

    def rdp(values):
        if len(values) <= 2:
            return values
        max_distance, split = 0.0, 0
        for index in range(1, len(values) - 1):
            distance = distance_to_segment(values[index], values[0], values[-1])
            if distance > max_distance:
                max_distance, split = distance, index
        if max_distance <= tolerance:
            return [values[0], values[-1]]
        return rdp(values[:split + 1])[:-1] + rdp(values[split:])

    return [[round(x, 1), round(y, 1)] for x, y in rdp(simplified)]


def _sheet_layout(width: int, height: int) -> tuple[float, float, float]:
    pagew, pageh = 1200.0, 850.0
    draw_x, draw_y, draw_w, draw_h = 36.0, 88.0, 1128.0, 652.0
    scale = min(draw_w / max(width, 1), draw_h / max(height, 1))
    tx = draw_x + (draw_w - width * scale) / 2.0
    ty = draw_y + (draw_h - height * scale) / 2.0
    return scale, tx, ty


def _semantic_route_chains(semantic_routes: list[dict[str, Any]] | None) -> list[list[list[float]]]:
    """Validate semantic centre-lines before they are used as primary CAD geometry."""
    result: list[list[list[float]]] = []
    for route in semantic_routes or []:
        if not isinstance(route, dict) or not route.get('include', True):
            continue
        try:
            confidence = float(route.get('confidence', 0))
        except (TypeError, ValueError):
            continue
        if confidence < 35:
            continue
        raw_points = route.get('points')
        if not isinstance(raw_points, list) or len(raw_points) < 2:
            continue
        points: list[list[float]] = []
        for raw in raw_points[:160]:
            if not isinstance(raw, (list, tuple)) or len(raw) < 2:
                continue
            try:
                point = [float(raw[0]), float(raw[1])]
            except (TypeError, ValueError):
                continue
            if not all(math.isfinite(value) for value in point):
                continue
            if not points or math.dist(points[-1], point) >= 2.0:
                points.append(point)
        if len(points) >= 2 and sum(math.dist(points[i], points[i + 1]) for i in range(len(points) - 1)) >= 12:
            result.append(_clean_cad_points(points))
    return result



def _point_to_segment_distance(point: tuple[float, float], a: list[float], b: list[float]) -> float:
    px, py = point
    dx, dy = float(b[0]) - float(a[0]), float(b[1]) - float(a[1])
    length_sq = dx * dx + dy * dy
    if length_sq <= 1e-9:
        return math.hypot(px - float(a[0]), py - float(a[1]))
    t = max(0.0, min(1.0, ((px - float(a[0])) * dx + (py - float(a[1])) * dy) / length_sq))
    return math.hypot(px - (float(a[0]) + t * dx), py - (float(a[1]) + t * dy))


def validate_primary_semantic_routes(semantic_routes: list[dict[str, Any]] | None,
                                     ink: np.ndarray, text_mask: np.ndarray,
                                     primary_edges: list[dict[str, Any]],
                                     min_dimension: int) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Validate Qwen route segments independently against source ink and OCR masks.

    Earlier builds rejected an entire polyline when one of its segments touched
    an OCR box, and required 30% sampled-pixel coverage with a 7x7 halo. That
    discarded good pipe routes near faint pencil strokes and labels. This
    version validates each segment separately, uses a moderate 9x9 support halo,
    and drops only the text-crossing segment; other verified portions survive.
    """
    h, w = ink.shape[:2]
    ink_dilated = cv2.dilate(ink, np.ones((9, 9), np.uint8), iterations=1)
    graph_segments = []
    for edge in primary_edges:
        edge_points = edge.get('geometry') or []
        for a, b in zip(edge_points, edge_points[1:]):
            graph_segments.append((a, b))
    accepted: list[dict[str, Any]] = []
    reasons: dict[str, int] = {}
    route_diagnostics: list[dict[str, Any]] = []
    min_length = max(16.0, float(min_dimension) * 0.010)
    min_piece_length = max(9.0, float(min_dimension) * 0.006)

    def bump(reason: str) -> None:
        reasons[reason] = reasons.get(reason, 0) + 1

    def duplicate_ratio_for(points: list[list[float]]) -> float:
        samples: list[tuple[float, float]] = []
        for a, b in zip(points, points[1:]):
            length = math.dist(a, b)
            count = max(2, int(length / 4.0) + 1)
            samples.extend((a[0] + (b[0]-a[0])*t, a[1] + (b[1]-a[1])*t)
                           for t in np.linspace(0.0, 1.0, count))
        if not graph_segments or not samples:
            return 0.0
        hits = sum(1 for point in samples if any(
            _point_to_segment_distance(point, a, b) <= 5.5 for a, b in graph_segments
        ))
        return hits / len(samples)

    for index, route in enumerate(semantic_routes or []):
        diag: dict[str, Any] = {'id': str(route.get('id') or f'Q{index+1}') if isinstance(route, dict) else f'Q{index+1}'}
        if not isinstance(route, dict) or route.get('include') is False:
            bump('not-included')
            diag.update({'decision': 'reject', 'reason': 'not-included'})
            route_diagnostics.append(diag)
            continue
        try:
            confidence = float(route.get('confidence', 60))
        except (TypeError, ValueError):
            confidence = 0.0
        if confidence < 35:
            bump('low-confidence')
            diag.update({'decision': 'reject', 'reason': 'low-confidence'})
            route_diagnostics.append(diag)
            continue
        raw_points = route.get('points')
        if not isinstance(raw_points, list) or len(raw_points) < 2:
            bump('invalid-points')
            diag.update({'decision': 'reject', 'reason': 'invalid-points'})
            route_diagnostics.append(diag)
            continue
        points: list[list[float]] = []
        valid_bounds = True
        for raw in raw_points[:64]:
            try:
                x, y = float(raw[0]), float(raw[1])
            except (TypeError, ValueError, IndexError):
                valid_bounds = False
                break
            if not math.isfinite(x) or not math.isfinite(y) or x < -2 or y < -2 or x > w + 2 or y > h + 2:
                valid_bounds = False
                break
            point = [max(0.0, min(w - 1.0, x)), max(0.0, min(h - 1.0, y))]
            if not points or math.dist(points[-1], point) >= 2.0:
                points.append(point)
        if not valid_bounds or len(points) < 2:
            bump('invalid-bounds')
            diag.update({'decision': 'reject', 'reason': 'invalid-bounds'})
            route_diagnostics.append(diag)
            continue

        kept_fragments: list[list[list[float]]] = []
        current: list[list[float]] = []
        support_by_fragment: list[list[float]] = []
        text_by_fragment: list[list[float]] = []
        rejected_segment_reasons: list[str] = []
        for a, b in zip(points, points[1:]):
            length = math.dist(a, b)
            if length < min_piece_length:
                if len(current) >= 2:
                    kept_fragments.append(current); current = []
                rejected_segment_reasons.append('short-segment')
                continue
            overlap, through = _segment_text_mask_metrics((a[0], a[1], b[0], b[1]), text_mask, ink_dilated)
            support = _sample_line_support(ink_dilated, a[0], a[1], b[0], b[1])
            # Segments mostly inside an OCR region are text strokes unless a
            # strong two-sided continuation demonstrates an actual pipe.
            if overlap >= 0.08 and not through:
                if len(current) >= 2:
                    kept_fragments.append(current); current = []
                rejected_segment_reasons.append('text-overlap')
                continue
            support_floor = 0.13 if confidence >= 60 else 0.18
            if support < support_floor:
                if len(current) >= 2:
                    kept_fragments.append(current); current = []
                rejected_segment_reasons.append('weak-source-ink')
                continue
            if current and math.dist(current[-1], a) <= 2.5:
                current.append(b)
            else:
                if len(current) >= 2:
                    kept_fragments.append(current)
                current = [a, b]
            support_by_fragment.append([support * length, length])
            text_by_fragment.append([overlap * length, length])
        if len(current) >= 2:
            kept_fragments.append(current)

        promoted_for_route = 0
        fragment_diagnostics = []
        for frag_index, fragment in enumerate(kept_fragments, 1):
            length = sum(math.dist(a, b) for a, b in zip(fragment, fragment[1:]))
            if length < min_length:
                bump('short-after-filter')
                continue
            fragment_support_sum = 0.0
            fragment_text_sum = 0.0
            for fa, fb in zip(fragment, fragment[1:]):
                flen = math.dist(fa, fb)
                fsupport = _sample_line_support(ink_dilated, fa[0], fa[1], fb[0], fb[1])
                foverlap, _fthrough = _segment_text_mask_metrics((fa[0], fa[1], fb[0], fb[1]), text_mask, ink_dilated)
                fragment_support_sum += fsupport * flen
                fragment_text_sum += foverlap * flen
            support = fragment_support_sum / max(length, 1.0)
            text_ratio = fragment_text_sum / max(length, 1.0)
            duplicate = duplicate_ratio_for(fragment)
            # Only remove near-exact duplicates. Qwen often supplies a longer
            # or more continuous centreline than the detector graph.
            if duplicate >= 0.90:
                bump('opencv-duplicate')
                fragment_diagnostics.append({'length': round(length, 1), 'support': round(support, 3),
                                             'duplicate': round(duplicate, 3), 'decision': 'duplicate'})
                continue
            accepted.append({
                'id': str(route.get('id') or f'QPRIMARY{index+1}') + (f'_{frag_index}' if len(kept_fragments) > 1 else ''),
                'points': fragment, 'confidence': confidence,
                'ink_support': round(support, 3),
                'text_overlap': round(text_ratio, 3),
                'opencv_duplicate_ratio': round(duplicate, 3),
                'include': True, 'source': 'qwen3-vl-validated',
                'split_from_text_or_weak_segment': bool(rejected_segment_reasons),
            })
            promoted_for_route += 1
            fragment_diagnostics.append({'length': round(length, 1), 'support': round(support, 3),
                                         'text_overlap': round(text_ratio, 3),
                                         'duplicate': round(duplicate, 3), 'decision': 'accept'})
        if promoted_for_route:
            bump('accepted')
            decision, reason = 'accept', 'ink-supported-fragment'
        else:
            for reason_item in rejected_segment_reasons:
                bump(reason_item)
            decision = 'reject'
            reason = rejected_segment_reasons[0] if rejected_segment_reasons else 'no-valid-fragment'
        diag.update({'decision': decision, 'reason': reason,
                     'rejected_segments': rejected_segment_reasons,
                     'accepted_fragments': promoted_for_route,
                     'fragments': fragment_diagnostics})
        route_diagnostics.append(diag)

    return accepted, {
        'candidate_routes': len(semantic_routes or []),
        'accepted_routes': len(accepted),
        'accepted_source_routes': reasons.get('accepted', 0),
        'reasons': reasons,
        'min_length_px': round(min_length, 1),
        'minimum_ink_support': 0.13,
        'ink_support_kernel': '9x9',
        'route_diagnostics': route_diagnostics,
    }


def _annotation_export_kind(annotation: dict[str, Any]) -> str | None:
    """Return VERIFIED_TEXT or TEXT_REVIEW for visible OCR content."""
    text = re.sub(r'\s+', ' ', str(annotation.get('text') or '')).strip()
    box = annotation.get('bbox') or {}
    if not text or not all(key in box for key in ('x', 'y', 'w', 'h')):
        return None
    if annotation.get('verified') and annotation.get('include', True):
        return 'VERIFIED_TEXT'
    try:
        confidence = float(annotation.get('confidence', 0) or 0)
    except (TypeError, ValueError):
        confidence = 0.0
    source = str(annotation.get('source') or '')
    if source == 'qwen3-vl-block' or (confidence >= 38 and text != '?'):
        return 'TEXT_REVIEW'
    return None


def _primary_semantic_chains(primary_routes: list[dict[str, Any]] | None) -> list[list[list[float]]]:
    return [route['points'] for route in (primary_routes or [])
            if isinstance(route, dict) and route.get('include', True)
            and isinstance(route.get('points'), list) and len(route['points']) >= 2]

def build_clean_svg(width:int,height:int,edges:list[dict],annotations:list[dict],title='Трубопроводная схема', semantic_routes: list[dict[str, Any]] | None = None, semantic_status: dict[str, Any] | None = None, primary_semantic_routes: list[dict[str, Any]] | None = None) -> str:
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
    # The primary drawing must not depend on a vision model's incomplete or
    # geometrically degenerate route list. Use the detector graph after its
    # topology/length/symbol-stub selection. Every usable Qwen trajectory also
    # remains visible in the frozen QWEN_REVIEW layer, never silently promoted.
    clean_chains = _cad_edge_chains(edges)
    semantic_primary_chains = _primary_semantic_chains(primary_semantic_routes)
    for chain in clean_chains + semantic_primary_chains:
        pts=' '.join(f'{float(point[0]):.2f},{float(point[1]):.2f}' for point in chain)
        out.append(f'<polyline points="{pts}"/>')
    out.append('</g>')
    # Preserve every non-primary detector fragment on an explicit dashed layer.
    # This does not claim that review fragments are connected pipe geometry.
    review_chains = _cad_edge_chains([
        {**edge, 'cad_include': True}
        for edge in edges
        if not edge.get('cad_include', edge.get('component_role') == 'line_structure')
        and edge.get('cad_reason') != 'text-or-annotation'
        and edge.get('component_role') != 'text_or_annotation'
        and edge.get('suggested_role') != 'text_or_dimension'
    ])
    if review_chains:
        out.append(f'<g data-layer="DETAIL_REVIEW" fill="none" stroke="#85919a" stroke-width="{max(0.14, line_width * 0.78):.4f}" stroke-dasharray="5 4" stroke-linecap="round" stroke-linejoin="round" transform="translate({tx:.3f} {ty:.3f}) scale({scale:.7f})">')
        for chain in review_chains:
            pts=' '.join(f'{float(point[0]):.2f},{float(point[1]):.2f}' for point in chain)
            out.append(f'<polyline points="{pts}"/>')
        out.append('</g>')
    primary_route_ids = {str(route.get('id')) for route in (primary_semantic_routes or [])}
    qwen_review_chains: list[list[list[float]]] = []
    for route in (semantic_routes or []):
        if not isinstance(route, dict) or str(route.get('id')) in primary_route_ids:
            continue
        # Even routes that Qwen itself marked uncertain/not-included are shown
        # on a review-only layer. This increases visual recall without silently
        # adding them to the main network or changing their validation status.
        try:
            confidence = float(route.get('confidence', 0) or 0)
        except (TypeError, ValueError):
            confidence = 0.0
        if confidence < 20:
            continue
        raw_points = route.get('points')
        if not isinstance(raw_points, list) or len(raw_points) < 2:
            continue
        # Keep only traces located on the source page. Invalid coordinate
        # spaces must not be exported around the centre of the CAD sheet.
        valid_points = []
        for point in raw_points[:160]:
            if not isinstance(point, (list, tuple)) or len(point) < 2:
                continue
            try:
                px, py = float(point[0]), float(point[1])
            except (TypeError, ValueError):
                continue
            if math.isfinite(px) and math.isfinite(py) and 0 <= px <= width and 0 <= py <= height:
                valid_points.append([px, py])
        if len(valid_points) < 2:
            continue
        display_route = {**route, 'points': valid_points, 'include': True, 'confidence': max(35.0, confidence)}
        qwen_review_chains.extend(_semantic_route_chains([display_route]))
    if qwen_review_chains:
        out.append(f'<g data-layer="QWEN_REVIEW" fill="none" stroke="#9a7caf" stroke-width="{max(0.13, line_width * 0.72):.4f}" stroke-dasharray="7 5" stroke-linecap="round" stroke-linejoin="round" transform="translate({tx:.3f} {ty:.3f}) scale({scale:.7f})">')
        for chain in qwen_review_chains:
            pts=' '.join(f'{float(point[0]):.2f},{float(point[1]):.2f}' for point in chain)
            out.append(f'<polyline points="{pts}"/>')
        out.append('</g>')
    if not clean_chains and not semantic_primary_chains:
        out.append('<text x="600" y="404" text-anchor="middle" font-family="Arial,sans-serif" font-size="13" font-weight="bold" fill="#a45f2a">НЕ НАЙДЕНЫ ОСНОВНЫЕ ГЕОМЕТРИЧЕСКИЕ ЛИНИИ</text>')
        detail = (semantic_status or {}).get('error') or 'Проверьте исходное изображение и параметры выделения геометрии.'
        hint = (semantic_status or {}).get('hint') or 'Результаты Qwen сохранены отдельно для проверки.'
        out.append(f'<text x="600" y="426" text-anchor="middle" font-family="Arial,sans-serif" font-size="7.5" fill="#6b747a">{xml_escape(str(detail)[:150])}</text>')
        out.append(f'<text x="600" y="442" text-anchor="middle" font-family="Arial,sans-serif" font-size="7.5" fill="#6b747a">{xml_escape(str(hint)[:150])}</text>')

    # OCR output is rendered as editable typography without a rectangular
    # backplate; a thin white text stroke preserves legibility over linework.
    for annotation in annotations:
        export_kind = _annotation_export_kind(annotation)
        if not export_kind:
            continue
        box=annotation.get('bbox') or {}
        # Row-level OCR annotations (e.g. a numbered table row) carry a bbox
        # for the whole row. Centre anchoring shifts every value toward the
        # middle of the row; keep the transcript anchored at its true left edge.
        x=tx+float(box.get('x',0))*scale
        y=ty+(float(box.get('y',0))+float(box.get('h',0)))*scale
        label=str(annotation['text'])
        label_width=max(24.0, min(220.0, len(label)*4.8+8.0))
        text_color = '#15191d' if export_kind == 'VERIFIED_TEXT' else '#8b6334'
        font_size = 8 if export_kind == 'VERIFIED_TEXT' else 7
        font_weight = '600' if export_kind == 'VERIFIED_TEXT' else '400'
        out.append(f'<text data-layer="{export_kind}" x="{x:.2f}" y="{y+1.0:.2f}" font-family="Arial,sans-serif" font-size="{font_size}" font-weight="{font_weight}" text-anchor="start" fill="{text_color}" style="paint-order:stroke;stroke:#fff;stroke-width:2px;stroke-linejoin:round">{xml_escape(label)}</text>')

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


def build_dxf(width:int,height:int,edges:list[dict],annotations:list[dict], semantic_routes: list[dict[str, Any]] | None = None, primary_semantic_routes: list[dict[str, Any]] | None = None) -> str:
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
       '0','TABLE','2','LAYER','5','2','330','0','100','AcDbSymbolTable','70','7']
    for handle, (name, colour, lineweight, flags) in enumerate([
        ('SHEET',7,13,0),('PIPE_MAIN',7,13,0),('DETAIL_REVIEW',8,9,1),('QWEN_REVIEW',30,9,1),('VERIFIED_TEXT',7,13,0),('TEXT_REVIEW',30,9,1),('NOTES',8,9,0)
    ], start=32):
        d += ['0','LAYER','5',format(handle,'X'),'330','2','100','AcDbSymbolTableRecord',
              '100','AcDbLayerTableRecord','2',name,'70',str(flags),'62',str(colour),'6','CONTINUOUS','370',str(lineweight)]
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

    # Primary CAD geometry comes from the selected OpenCV topology graph. This
    # selection already suppresses short symbol strokes and retains coherent
    # line paths; Qwen is deliberately not allowed to replace it wholesale.
    clean_chains = _cad_edge_chains(edges)
    semantic_primary_chains = _primary_semantic_chains(primary_semantic_routes)
    for chain in clean_chains + semantic_primary_chains:
        page_points=[(tx+float(point[0])*scale,ty+float(point[1])*scale) for point in chain]
        d += dxf_polyline('PIPE_MAIN',page_points,False,13)

    # Keep rejected/ambiguous detector fragments on a frozen layer.
    for edge in edges:
        if edge.get('cad_include', edge.get('component_role') == 'line_structure'):
            continue
        geometry = edge.get('geometry') or []
        if len(geometry) >= 2:
            page_points=[(tx+float(point[0])*scale,ty+float(point[1])*scale) for point in geometry]
            d += dxf_polyline('DETAIL_REVIEW',page_points,False,9)

    # Semantic traces from Qwen are useful diagnostics, but are not trusted as
    # primary geometry until their coordinates and coverage are validated.
    # They are therefore preserved on a separate frozen layer.
    primary_ids = {str(route.get('id')) for route in (primary_semantic_routes or [])}
    for route in (semantic_routes or []):
        if not isinstance(route, dict) or str(route.get('id')) in primary_ids:
            continue
        try:
            confidence = float(route.get('confidence', 0) or 0)
        except (TypeError, ValueError):
            confidence = 0.0
        if confidence < 20:
            continue
        raw_points = route.get('points')
        if not isinstance(raw_points, list) or len(raw_points) < 2:
            continue
        valid_points = []
        for point in raw_points[:160]:
            if not isinstance(point, (list, tuple)) or len(point) < 2:
                continue
            try:
                px, py = float(point[0]), float(point[1])
            except (TypeError, ValueError):
                continue
            if math.isfinite(px) and math.isfinite(py) and 0 <= px <= width and 0 <= py <= height:
                valid_points.append([px, py])
        if len(valid_points) < 2:
            continue
        # Preserve uncertain Qwen trajectories as frozen review entities.
        # They are deliberately not promoted to PIPE_MAIN here.
        display_route = {**route, 'points': valid_points, 'include': True, 'confidence': max(35.0, confidence)}
        chain = _semantic_route_chains([display_route])
        if not chain:
            continue
        page_points=[(tx+float(point[0])*scale,ty+float(point[1])*scale) for point in chain[0]]
        d += dxf_polyline('QWEN_REVIEW',page_points,False,9)

    for annotation in annotations:
        export_kind = _annotation_export_kind(annotation)
        if not export_kind:
            continue
        box=annotation.get('bbox') or {}
        # DXF TEXT defaults to left/baseline alignment. Keep the insertion
        # point at the source bbox left edge; subtracting an estimated string
        # width was moving left-column digits toward the centre of the sheet.
        px=tx+float(box.get('x',0))*scale
        py=ty+(float(box.get('y',0))+float(box.get('h',0)))*scale
        x,y=page_to_mm((px,py))
        text=str(annotation['text'])
        d += dxf_text(export_kind,text,x,y,3.0 if export_kind == 'VERIFIED_TEXT' else 2.7)

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

def _build_join_candidates(nodes: list[dict[str, Any]], edges: list[dict[str, Any]],
                           min_gap: float = 4.5, max_gap: float = 45.0,
                           image_size: tuple[int, int] | None = None) -> list[dict[str, Any]]:
    """Return review-only endpoint continuation proposals.

    Unlike the former implementation, this diagnostic considers both
    ``line_structure`` and ``ambiguous`` components and does not discard a
    short detector fragment solely because its length is below 25 px. A
    proposal is never auto-joined: the UI requires an explicit user action.
    Text/annotation components are excluded, competing matches are flagged,
    and candidates near the image border or OCR regions remain review-only.
    """
    node_by_id = {str(node.get('id')): node for node in nodes}
    edge_at: dict[str, dict[str, Any]] = {}
    allowed_roles = {'line_structure', 'ambiguous'}
    for edge in edges:
        role = str(edge.get('component_role') or 'ambiguous')
        reason = str(edge.get('cad_reason') or '')
        if role not in allowed_roles or reason == 'text-or-annotation':
            continue
        for node_id in (str(edge.get('from', '')), str(edge.get('to', ''))):
            if node_id and node_id not in edge_at:
                edge_at[node_id] = edge

    def polyline_length(geometry: list[list[float]]) -> float:
        return sum(math.dist(a, b) for a, b in zip(geometry, geometry[1:]))

    def endpoint_geometry(node_id: str, edge: dict[str, Any]):
        geometry = edge.get('geometry') or []
        if len(geometry) < 2:
            return None
        if str(edge.get('from')) == node_id:
            endpoint = geometry[0]
            inner_points = geometry[1:]
        elif str(edge.get('to')) == node_id:
            endpoint = geometry[-1]
            inner_points = list(reversed(geometry[:-1]))
        else:
            return None
        endpoint_array = np.array(endpoint, dtype=float)
        inner = None
        for candidate in inner_points:
            candidate_array = np.array(candidate, dtype=float)
            if float(np.linalg.norm(candidate_array - endpoint_array)) >= 2.0:
                inner = candidate_array
                break
        if inner is None:
            return None
        vector = inner - endpoint_array
        norm = float(np.linalg.norm(vector))
        if norm < 1.0:
            return None
        return endpoint_array, vector / norm, geometry, polyline_length(geometry)

    def endpoint_hits_polyline(point: np.ndarray, geometry: list[list[float]],
                               tolerance: float = 4.0) -> bool:
        for a_raw, b_raw in zip(geometry, geometry[1:]):
            a = np.array(a_raw, dtype=float)
            b = np.array(b_raw, dtype=float)
            delta = b - a
            length_sq = float(np.dot(delta, delta))
            if length_sq < 1e-8:
                continue
            t = float(np.dot(point - a, delta) / length_sq)
            if not 0.04 < t < 0.96:
                continue
            projection = a + t * delta
            if float(np.linalg.norm(point - projection)) <= tolerance:
                return True
        return False

    open_nodes = [node for node in nodes
                  if int(node.get('degree', 0)) == 1 and str(node.get('id')) in edge_at]
    endpoints = []
    for node in open_nodes:
        node_id = str(node['id'])
        edge = edge_at[node_id]
        geometry = endpoint_geometry(node_id, edge)
        if geometry is None:
            continue
        point, inward, edge_geometry, edge_length = geometry
        # Suppress tiny OCR ticks and detector noise; short pipe fragments
        # (e.g. 14-24 px) remain eligible for review.
        if edge_length < 8.0:
            continue
        endpoints.append({
            'node_id': node_id,
            'edge': edge,
            'point': point,
            'inward': inward,
            'geometry': edge_geometry,
            'length': edge_length,
            'role': str(edge.get('component_role') or 'ambiguous'),
            'reason': str(edge.get('cad_reason') or ''),
            'ink_support': float(edge.get('ink_support', 0.0) or 0.0),
            'ocr_overlap': float(edge.get('ocr_overlap', 0.0) or 0.0),
            'text_crossing': bool(edge.get('text_crossing')),
        })

    raw_candidates: list[dict[str, Any]] = []
    width = int(image_size[0]) if image_size else None
    height = int(image_size[1]) if image_size else None
    for index, a in enumerate(endpoints):
        edge_a = a['edge']
        for b in endpoints[index + 1:]:
            edge_b = b['edge']
            if str(edge_a.get('id')) == str(edge_b.get('id')):
                continue
            component_a = str(edge_a.get('component_id') or '')
            component_b = str(edge_b.get('component_id') or '')
            if component_a and component_a == component_b:
                continue

            gap = b['point'] - a['point']
            distance = float(np.linalg.norm(gap))
            if distance < min_gap or distance > max_gap or distance < 1e-6:
                continue
            gap_unit = gap / distance
            inward_a = a['inward']
            inward_b = b['inward']

            # Do not suggest endpoint-to-interior joins, including bent
            # polylines whose intermediate segment passes through the gap.
            if endpoint_hits_polyline(b['point'], a['geometry']) or endpoint_hits_polyline(a['point'], b['geometry']):
                continue

            dot_a = float(np.dot(inward_a, gap_unit))
            dot_b = float(np.dot(inward_b, -gap_unit))
            lateral_a = abs(float(inward_a[0] * gap_unit[1] - inward_a[1] * gap_unit[0])) * distance
            lateral_b = abs(float(inward_b[0] * gap_unit[1] - inward_b[1] * gap_unit[0])) * distance
            tangent_dot = float(np.dot(inward_a, inward_b))
            lateral = max(lateral_a, lateral_b)
            alignment = min(-dot_a, -dot_b)
            if dot_a > -0.82 or dot_b > -0.82 or tangent_dot > -0.85:
                continue
            if lateral > 8.0:
                continue

            near_border = bool(width and height and any(
                min(point[0], point[1], width - point[0], height - point[1]) < 5.0
                for point in (a['point'], b['point'])
            ))
            min_ink = min(a['ink_support'], b['ink_support'])
            max_ocr = max(a['ocr_overlap'], b['ocr_overlap'])
            flags = []
            if a['role'] == 'ambiguous' or b['role'] == 'ambiguous':
                flags.append('ambiguous_component')
            if min(a['length'], b['length']) < 25.0:
                flags.append('short_fragment')
            if distance > 28.0:
                flags.append('gap_over_28px')
            if lateral > 4.5:
                flags.append('lateral_offset')
            if max_ocr >= 0.15:
                flags.append('ocr_overlap')
            if a['text_crossing'] or b['text_crossing']:
                flags.append('text_crossing')
            if near_border:
                flags.append('near_image_border')

            # This is a ranking aid, not a probability. Geometry, source ink,
            # and OCR proximity are kept visible for human review.
            ink_score = min(1.0, min_ink / 0.65)
            score = 100.0 * (
                0.38 * max(0.0, min(1.0, alignment)) +
                0.24 * max(0.0, min(1.0, -tangent_dot)) +
                0.18 * max(0.0, 1.0 - lateral / 8.0) +
                0.20 * ink_score
            )
            high_priority = (
                a['role'] == 'line_structure' and b['role'] == 'line_structure' and
                min_ink >= 0.50 and max_ocr < 0.15 and
                not a['text_crossing'] and not b['text_crossing'] and
                not near_border and distance <= 20.0 and lateral <= 4.5 and
                alignment >= 0.92 and tangent_dot <= -0.94
            )
            raw_candidates.append({
                'from': a['node_id'], 'to': b['node_id'],
                'from_edge': str(edge_a.get('id')), 'to_edge': str(edge_b.get('id')),
                'from_component': component_a, 'to_component': component_b,
                'from_role': a['role'], 'to_role': b['role'],
                'from_reason': a['reason'], 'to_reason': b['reason'],
                'distance': round(distance, 1),
                'lateral_offset_px': round(lateral, 1),
                'alignment': round(alignment, 3),
                'tangent_alignment': round(-tangent_dot, 3),
                'from_edge_length': round(a['length'], 1),
                'to_edge_length': round(b['length'], 1),
                'from_ink_support': round(a['ink_support'], 3),
                'to_ink_support': round(b['ink_support'], 3),
                'from_ocr_overlap': round(a['ocr_overlap'], 3),
                'to_ocr_overlap': round(b['ocr_overlap'], 3),
                'review_flags': flags,
                'near_image_border': near_border,
                'score': round(score, 1),
                'priority': 'high' if high_priority else 'review',
                'status': 'needs_review',
                'message': ('Геометрически сильный кандидат; перед добавлением проверь исходный чертёж.'
                            if high_priority else
                            'Неоднозначный кандидат; требуется визуальная проверка перед соединением.'),
            })

    # One terminal may have several plausible partners. Keep the alternatives
    # but mark every affected candidate so the UI cannot imply a unique answer.
    alternatives: dict[str, int] = {}
    for candidate in raw_candidates:
        alternatives[candidate['from']] = alternatives.get(candidate['from'], 0) + 1
        alternatives[candidate['to']] = alternatives.get(candidate['to'], 0) + 1
    for candidate in raw_candidates:
        conflicts = [node_id for node_id in (candidate['from'], candidate['to'])
                     if alternatives.get(node_id, 0) > 1]
        candidate['conflicting_nodes'] = conflicts
        candidate['has_alternatives'] = bool(conflicts)
        if conflicts:
            candidate['priority'] = 'review'
            candidate['review_flags'].append('competing_candidate')
            candidate['message'] = 'У одного из концов есть альтернативные пары; выбери только после визуальной проверки.'

    raw_candidates.sort(key=lambda item: (
        item['priority'] != 'high', -item['score'], item['distance']
    ))
    candidates = raw_candidates[:200]
    for index, candidate in enumerate(candidates, 1):
        candidate['id'] = f'J{index}'
    return candidates

def _qwen_stage_is_complete(status: dict[str, Any] | None) -> bool:
    status = status or {}
    if 'complete' in status:
        return bool(status.get('complete'))
    try:
        tiles = int(status.get('tiles', 0) or 0)
        successful = int(status.get('successful_tiles', 0) or 0)
    except (TypeError, ValueError):
        return False
    if tiles > 0:
        return successful == tiles
    # Compatibility for injected/test providers that expose availability only.
    return bool(status.get('available'))


def analyze(input_path:str,out_dir:str) -> dict[str,Any]:
    global _ANALYSIS_HARD_DEADLINE
    job_started = time.perf_counter()
    configured_job_ms = max(60_000.0, float(os.getenv('PYTHON_JOB_TIMEOUT_MS', '2700000')))
    _ANALYSIS_HARD_DEADLINE = time.monotonic() + configured_job_ms / 1000.0
    timings_ms: dict[str, float] = {}
    Path(out_dir).mkdir(parents=True,exist_ok=True)
    _progress('JOB', 'Image preprocessing started')
    stage_started = time.perf_counter()
    source_bgr = load_image(input_path)
    bgr, preparation = prepare_document_image(source_bgr)
    h,w=bgr.shape[:2]
    prepared_input_path = str(Path(out_dir) / 'prepared-input.png')
    cv2.imwrite(prepared_input_path, bgr)
    gray,prep=normalize_document(bgr)
    prep.update(preparation)
    ink_layers = make_ink_layers(bgr, gray)
    ink = ink_layers['combined']
    timings_ms['preprocessing'] = round((time.perf_counter() - stage_started) * 1000.0, 1)
    _progress('JOB', f'Image preprocessing completed: {w}x{h}; {timings_ms["preprocessing"]:.1f} ms')
    _progress('OCR', 'OCR pipeline started')
    stage_started = time.perf_counter()
    checkpoint_dir = Path(out_dir) / '.checkpoints'
    checkpoint_dir.mkdir(parents=True, exist_ok=True)
    annotations, ocr_status = ocr_annotations(prepared_input_path, gray, checkpoint_dir=checkpoint_dir)
    timings_ms['ocr'] = round((time.perf_counter() - stage_started) * 1000.0, 1)
    _progress('OCR', f'OCR pipeline completed: annotations={len(annotations)}; Qwen tiles={ocr_status.get("qwen", {}).get("successful_tiles", 0)}/{ocr_status.get("qwen", {}).get("tiles", 0)}; {timings_ms["ocr"]:.1f} ms')
    ocr_complete = _qwen_stage_is_complete(ocr_status.get('qwen'))
    stage_started = time.perf_counter()
    if not ocr_complete:
        # OCR supplies the text mask used by geometric validation. Defer the
        # expensive Qwen pipe pass until OCR coverage is complete; export a
        # clearly-marked review-only graph now and resume from OCR checkpoints.
        pipe_grid = max(1, min(3, int(os.getenv('QWEN_PIPE_TILE_GRID', '3'))))
        if w < 640 or h < 480:
            pipe_grid = 1
        pipe_total = pipe_grid * pipe_grid
        semantic_routes = []
        route_status = {
            'available': False, 'complete': False, 'model': os.getenv('QWEN_MODEL', 'qwen3-vl:4b-instruct'),
            'routes': 0, 'raw_routes': 0, 'tiles': pipe_total, 'successful_tiles': 0,
            'failed_tiles': list(range(1, pipe_total + 1)), 'tile_diagnostics': [],
            'deferred_due_to_ocr_incomplete': True,
            'error': 'Трассировка Qwen отложена: OCR обработал не все плитки.',
            'hint': 'Повторите обработку этой же схемы. Успешные OCR-плитки восстановятся из .checkpoints; после полного OCR запустится трассировка труб.',
            'incomplete_reason': 'PIPE отложен до завершения OCR, чтобы не тратить время и не строить трубные маски по неполной карте текста.',
        }
        _progress('PIPE', f'CAD pipe-route trace deferred: OCR completed {ocr_status.get("qwen", {}).get("successful_tiles", 0)}/{ocr_status.get("qwen", {}).get("tiles", 0)} tiles; exporting review-only graph')
    else:
        _progress('PIPE', 'CAD pipe-route trace started')
        semantic_routes, route_status = _qwen_semantic_routes(prepared_input_path, w, h, checkpoint_dir=checkpoint_dir)
        _progress('PIPE', f'CAD pipe-route trace completed: routes={len(semantic_routes)}; tiles={route_status.get("successful_tiles", 0)}/{route_status.get("tiles", 0)}')
    timings_ms['qwen_pipe_trace'] = round((time.perf_counter() - stage_started) * 1000.0, 1)
    pipe_complete = _qwen_stage_is_complete(route_status)
    processing_complete = ocr_complete and pipe_complete
    incomplete_reasons = []
    if not ocr_complete:
        qwen_ocr_status = ocr_status.get('qwen', {})
        incomplete_reasons.append(qwen_ocr_status.get('incomplete_reason') or qwen_ocr_status.get('error') or 'OCR Qwen обработала не все плитки.')
    if not pipe_complete:
        incomplete_reasons.append(route_status.get('incomplete_reason') or route_status.get('error') or 'Трассировка труб Qwen обработала не все плитки.')
    if processing_complete:
        _progress('JOB', 'All Qwen OCR and PIPE tiles completed; full analysis can be marked complete')
    else:
        _progress('JOB', f'Analysis incomplete; OCR={ocr_status.get("qwen", {}).get("successful_tiles", 0)}/{ocr_status.get("qwen", {}).get("tiles", 0)}; PIPE={route_status.get("successful_tiles", 0)}/{route_status.get("tiles", 0)}; per-tile checkpoints saved for retry')
    _progress('CAD', 'Graph construction started')
    stage_started = time.perf_counter()
    # OpenCV detector graph is selected into coherent primary CAD paths. Qwen
    # traces are retained as independent review suggestions and cannot erase
    # detector geometry when the vision model returns a sparse/degenerate list.
    segments=extract_segments(gray,ink,annotations)
    text_mask = _text_region_mask(gray.shape[:2], annotations)
    nodes,edges,components=endpoint_clusters(segments, ink=ink, text_mask=text_mask)
    cad_selection = select_primary_cad_edges(nodes, edges, min(w, h))
    primary_opencv_edges = [edge for edge in edges if edge.get('cad_include')]
    primary_semantic_routes, semantic_validation = validate_primary_semantic_routes(
        semantic_routes, ink, text_mask, primary_opencv_edges, min(w, h)
    )
    _progress('CAD', f'Graph construction in progress: segments={len(segments)} nodes={len(nodes)} edges={len(edges)}')
    primary_semantic_ids = {str(route.get('id')) for route in primary_semantic_routes}
    for route in semantic_routes:
        route['primary_validated'] = str(route.get('id')) in primary_semantic_ids
    for route in primary_semantic_routes:
        route['primary_validated'] = True
    # OCR overlap is now a real exclusion signal, not merely a note. Confirmed
    # continuous routes crossing a text box are retained by the two-sided ink test.
    for edge in edges:
        edge['visible'] = True
    crossings=detect_crossings(segments)
    ink_in_text_regions = cv2.bitwise_and(ink, text_mask)
    geometry_ink = cv2.bitwise_and(ink, cv2.bitwise_not(text_mask))
    timings_ms['opencv_geometry_and_topology'] = round((time.perf_counter() - stage_started) * 1000.0, 1)
    _progress('CAD', f'Graph construction completed: segments={len(segments)} nodes={len(nodes)} edges={len(edges)} crossings={len(crossings)}; {timings_ms["opencv_geometry_and_topology"]:.1f} ms')
    stage_started = time.perf_counter()

    # The candidate overlay remains available for audit; the primary overlay
    # makes it immediately visible what will actually enter PIPE_MAIN.
    overlay=bgr.copy()
    primary_overlay=bgr.copy()
    for segment in segments:
        col=(155,155,155) if segment.get('ocr_overlap', 0) >= 0.16 else ((30,130,240) if segment['source']=='LSD' else (40,180,80))
        cv2.line(overlay,(int(segment['x1']),int(segment['y1'])),(int(segment['x2']),int(segment['y2'])),col,2,cv2.LINE_AA)
    edge_by_index = {int(edge.get('source_segment_index', -1)): edge for edge in edges}
    for segment_index, segment in enumerate(segments):
        edge = edge_by_index.get(segment_index)
        if edge and edge.get('cad_include'):
            color=(40,190,95)
            thickness=3
        else:
            color=(150,150,150)
            thickness=1
        cv2.line(primary_overlay,(int(segment['x1']),int(segment['y1'])),(int(segment['x2']),int(segment['y2'])),color,thickness,cv2.LINE_AA)
    for route in primary_semantic_routes:
        pts = np.array([[int(round(p[0])), int(round(p[1]))] for p in route['points']], dtype=np.int32)
        if len(pts) >= 2:
            cv2.polylines(primary_overlay, [pts], False, (255, 170, 20), 3, cv2.LINE_AA)
    for node in nodes:
        if node['degree'] >= 3:
            cv2.circle(overlay,(int(node['x']),int(node['y'])),4,(0,0,255),-1,cv2.LINE_AA)
    overlay_path=str(Path(out_dir)/'overlay.png'); cv2.imwrite(overlay_path,overlay)
    cv2.imwrite(str(Path(out_dir)/'primary-overlay.png'), primary_overlay)
    cv2.imwrite(str(Path(out_dir)/'text-region-mask.png'), text_mask)
    cv2.imwrite(str(Path(out_dir)/'ink-without-text-boxes.png'), geometry_ink)
    cv2.imwrite(str(Path(out_dir)/'ink-inside-text-boxes.png'), ink_in_text_regions)
    # Visual audit of the independent dense-note detector and its row-OCR pass.
    note_overlay = bgr.copy()
    for block_index, diag in enumerate(ocr_status.get('qwen', {}).get('block_diagnostics', []), 1):
        box = diag.get('bbox') or {}
        try:
            x1, y1 = int(box['x']), int(box['y'])
            x2, y2 = x1 + int(box['w']), y1 + int(box['h'])
        except (KeyError, TypeError, ValueError):
            continue
        cv2.rectangle(note_overlay, (x1, y1), (x2, y2), (200, 40, 210), 2, cv2.LINE_AA)
        label = f"NOTE {block_index}: {diag.get('accepted_lines', 0)} rows"
        cv2.putText(note_overlay, label, (x1, max(18, y1 - 6)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.48, (200, 40, 210), 1, cv2.LINE_AA)
        for row_diag in diag.get('row_diagnostics', []):
            row_box = row_diag.get('bbox') or {}
            try:
                rx, ry = int(row_box['x']), int(row_box['y'])
                rw, rh = int(row_box['w']), int(row_box['h'])
            except (KeyError, TypeError, ValueError):
                continue
            cv2.rectangle(note_overlay, (rx, ry), (rx + rw, ry + rh), (255, 145, 20), 1, cv2.LINE_AA)
            cv2.putText(note_overlay, str(row_diag.get('row', '?')), (rx, max(12, ry - 2)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.34, (255, 145, 20), 1, cv2.LINE_AA)
    cv2.imwrite(str(Path(out_dir)/'handwritten-text-blocks.png'), note_overlay)
    ink_path=str(Path(out_dir)/'ink-mask.png'); cv2.imwrite(ink_path,ink)
    cv2.imwrite(str(Path(out_dir)/'blue-ink-mask.png'), ink_layers['blue'])
    cv2.imwrite(str(Path(out_dir)/'dark-ink-mask.png'), ink_layers['dark'])
    _progress('EXPORT', 'SVG and DXF export started')
    svg=build_clean_svg(w,h,edges,annotations, semantic_routes=semantic_routes, semantic_status=route_status, primary_semantic_routes=primary_semantic_routes)
    Path(out_dir,'clean.svg').write_text(svg,encoding='utf-8')
    Path(out_dir,'drawing.dxf').write_text(build_dxf(w,h,edges,annotations, semantic_routes=semantic_routes, primary_semantic_routes=primary_semantic_routes),encoding='utf-8')
    _progress('EXPORT', 'SVG and DXF written')
    # Candidate joins are diagnostic only. The graph's ink-supported endpoint
    # clustering performs conservative auto-joins; this list must not invent
    # same-edge, endpoint-to-interior, or laterally displaced connections.
    joins = _build_join_candidates(nodes, edges, image_size=(w, h))
    _progress('CAD', f'Endpoint continuation candidates: total={len(joins)} high={sum(1 for item in joins if item.get("priority")=="high")} review={sum(1 for item in joins if item.get("priority")!="high")}')
    timings_ms['drawing_export_and_candidates'] = round((time.perf_counter() - stage_started) * 1000.0, 1)
    timings_ms['total_before_graph_json_write'] = round((time.perf_counter() - job_started) * 1000.0, 1)
    recognition_channels = split_recognition_channels(w, h, components, edges, annotations)
    document_model = build_document_model(
        w, h, nodes, edges, annotations, crossings, joins, recognition_channels
    )
    document_model, topology_diagnostics = attach_pipes_to_symbols(document_model)
    document_model, annotation_linking_diagnostics = link_annotations(document_model)
    document_model, engineering_validation = validate_engineering_model(document_model)
    drawing_template = build_drawing_template()
    clean_layout, clean_layout_diagnostics = build_clean_layout(document_model, template=drawing_template)
    Path(out_dir,'clean.svg').write_text(build_layout_svg(clean_layout), encoding='utf-8')
    Path(out_dir,'drawing.dxf').write_text(build_layout_dxf(clean_layout), encoding='utf-8')
    graph={"schema":"cad-reconstruction-graph/1.2","status":"needs_review","analysisStatus":"complete" if processing_complete else "incomplete","complete":processing_complete,"incompleteReasons":incomplete_reasons,
           "checkpointing":{"enabled":True,"directory":".checkpoints","resumeBehavior":"successful OCR/PIPE tiles are restored; failed tiles are retried on the next analysis run"},
           "image":{"width":w,"height":h},
           "documentModel":document_model,
           "recognitionChannels":recognition_channels,
           "symbolCatalog":catalog_manifest(),
           "topologyDiagnostics":topology_diagnostics,
           "annotationLinkingDiagnostics":annotation_linking_diagnostics,
           "engineeringValidation":engineering_validation,
           "cleanLayout":clean_layout,"cleanLayoutDiagnostics":clean_layout_diagnostics,
           "drawingTemplate":drawing_template,
           "nodes":nodes,"edges":edges,"components":components,"crossings":crossings,"joinCandidates":joins,"annotations":annotations,"ocr":ocr_status,"semanticRoutes":semantic_routes,"primarySemanticRoutes":primary_semantic_routes,"semanticValidation":semantic_validation,"semanticTrace":route_status,
           "timings_ms":timings_ms,
           "rules":{"ocr_boxes_mask_geometry_even_when_text_unverified":True,"text_overlap_affects_component_classification":True,"continuous_lines_through_text_are_preserved_only_with_two_sided_ink_support":True,"crossings_auto_joined":False,"endpoint_cluster_radius_px":4.5,"collinear_gap_join_max_px":28,
                    "ambiguous_and_text_like_components_are_review_only":True,"clean_export_uses_selected_opencv_paths":True,"qwen_routes_are_ink_validated_before_primary_export":True,"unselected_pixel_candidates_are_review_only":True,"short_symbol_stubs_go_to_review_layer":True,
                    "join_candidates_include_ambiguous_components_for_manual_review":True,"join_candidates_allow_short_fragments_for_manual_review":True,"join_candidate_gap_px":[4.5,45.0],"join_candidate_lateral_tolerance_px":8.0,"join_candidate_min_edge_length_px":8.0,"join_candidate_min_endpoint_facing":0.82,"join_candidate_min_tangent_alignment":0.85,"join_candidates_auto_applied":False,"topology_network_candidate_min_edges":8,"topology_network_candidate_min_length_px":135,"topology_network_candidate_max_degree":8,"topology_network_candidate_max_edge_density":5.6,"topology_network_candidate_max_turn_density":1.35},
           "summary":{"analysis_complete":processing_complete,"ocr_tiles_complete":ocr_complete,"pipe_tiles_complete":pipe_complete,
                      "ocr_tiles_successful":ocr_status.get("qwen", {}).get("successful_tiles", 0),"ocr_tiles_total":ocr_status.get("qwen", {}).get("tiles", 0),
                      "pipe_tiles_successful":route_status.get("successful_tiles", 0),"pipe_tiles_total":route_status.get("tiles", 0),
                      "segment_candidates":len(segments),"nodes":len(nodes),"edges":len(edges),"crossings_to_review":len(crossings),
                      "ocr_annotations":len(annotations),
                      "semantic_routes":len(semantic_routes),
                      "qwen_review_routes":len(_semantic_route_chains(semantic_routes)),
                      "cad_primary_chains":len(_cad_edge_chains(edges)),
                      "cad_primary_qwen_routes":len(primary_semantic_routes),
                      "cad_primary_total_paths":len(_cad_edge_chains(edges)) + len(primary_semantic_routes),
                      "semantic_validation":semantic_validation,
                      "primary_geometry_source":"opencv-selected-graph+ink-validated-qwen",
                      "qwen_annotations":len([a for a in annotations if a.get('source')=='qwen3-vl']),
                      "geometry_excluded_text_regions":len(_confirmed_text_boxes(annotations)),
                      "tesseract_annotations":len([a for a in annotations if a.get('source')=='tesseract']),
                      "verified_annotations":len([a for a in annotations if a.get('verified') and a.get('text')]),
                      "text_review_annotations":len([a for a in annotations if _annotation_export_kind(a) == 'TEXT_REVIEW']),
                      "text_block_annotations":len([a for a in annotations if a.get('source') == 'qwen3-vl-block']),
                      "text_block_rows_detected":sum(int(item.get('rows_detected', 0) or 0) for item in ocr_status.get('qwen', {}).get('block_diagnostics', [])),
                      "text_block_rows_returned":sum(int(item.get('rows_returned', 0) or 0) for item in ocr_status.get('qwen', {}).get('block_diagnostics', [])),
                      "text_block_rows_verified":sum(sum(1 for row in item.get('row_diagnostics', []) if row.get('accepted') and float(row.get('confidence', 0) or 0) >= 58) for item in ocr_status.get('qwen', {}).get('block_diagnostics', [])),
                      "qwen_verified_annotations":len([a for a in annotations if a.get('source')=='qwen3-vl' and a.get('verified')]),
                      "tesseract_verified_annotations":len([a for a in annotations if a.get('source')=='tesseract' and a.get('verified')]),
                      "review_annotations":len([a for a in annotations if not a.get('verified') and a.get('text')]),
                      "text_overlap_edges":sum(1 for e in edges if e.get('suggested_role')=='text_or_dimension'),
                      "text_regions_used_for_geometry_mask":len(_confirmed_text_boxes(annotations)),
                      "ink_pixels_inside_text_regions":int(np.count_nonzero(ink_in_text_regions)),
                      "auto_joined_collinear_gaps":len({(edge['from'], edge['to']) for edge in edges if edge.get('auto_joined_gap')}),
                      "text_or_annotation_components":sum(1 for c in components if c['role']=='text_or_annotation'),
                      "review_only_ambiguous_components":sum(1 for c in components if c['role']=='ambiguous'),
                      "topology_network_candidate_components":sum(1 for c in components if c.get('topology_network_candidate')),
                      "topology_network_primary_edges":sum(1 for e in edges if e.get('topology_network_candidate') and e.get('cad_include')),
                      "structured_route_components":sum(1 for c in components if c.get('connected_line_candidate') or c.get('elbow_route_candidate') or c.get('topology_network_candidate')),
                      "dense_route_exempted_components":sum(1 for c in components if c.get('dense_route_exemption')),
                      "primary_edge_count_by_detector":{
                          name:sum(1 for e in edges if e.get('cad_include') and e.get('detector')==name)
                          for name in ('LSD','HOUGH')
                      },
                      "isolated_strokes_kept_for_review":sum(1 for e in edges if e.get('cad_reason')=='isolated-stroke-review'),
                      "geometry_candidates_preserved":len(segments),
                      "open_end_join_candidates":len(joins),
                      "join_candidates_high_priority":sum(1 for item in joins if item.get('priority')=='high'),
                      "join_candidates_needing_review":sum(1 for item in joins if item.get('priority')!='high'),
                      "join_candidates_with_alternatives":sum(1 for item in joins if item.get('has_alternatives')),
                      "open_terminal_nodes":sum(1 for node in nodes if int(node.get('degree', 0))==1),
                      "components":len(components),
                      **cad_selection,
                      "line_components":sum(1 for c in components if c['role']=='line_structure'),
                      "annotation_components":sum(1 for c in components if c['role']=='text_or_annotation'),
                      "ambiguous_components":sum(1 for c in components if c['role']=='ambiguous'),
                      "ink_pixels":int(np.count_nonzero(ink)),"preprocessing":prep},
           "warnings":["PIPE_MAIN использует только связные многосегментные маршруты с геометрическими признаками труб. Одиночные длинные штрихи, размерные линии и неоднозначные группы остаются в DETAIL_REVIEW.",
                       "В 4.3.9 сложные многоветвевые компоненты дополнительно проверяются по топологии, длине, плотности, поворотам, чернилам и OCR; сильные чернила сами по себе не являются основанием для включения.",
                       "Qwen-маршруты проходят проверку по исходным пикселям и добавляются в PIPE_MAIN только при подтверждении чернилами; остальные остаются в QWEN_REVIEW.",
                       "Неотобранные LSD/Hough-отрезки сохранены на замороженном DETAIL_REVIEW.",
                       "Пересечения не объединяются автоматически; автоматически стыкуются только короткие почти соосные окончания с сильным геометрическим подтверждением.",
                       "OCR-рамки участвуют в маске геометрии даже при низкой уверенности текста; непрерывная труба через рамку сохраняется при подтверждении с обеих сторон.",
                       "Подтверждённые подписи экспортируются как VERIFIED_TEXT; сомнительные OCR-чтения выводятся отдельно на замороженный TEXT_REVIEW.",
                       "Плотные рукописные заметки повторно читаются построчно отдельным OCR-проходом.",
                       "Проверьте трассы, повороты, размеры и подписи по оригиналу до использования чертежа."]}
    if not processing_complete:
        graph['warnings'].append('РЕЗУЛЬТАТ НЕПОЛНЫЙ: не все плитки Qwen обработаны. Не используйте этот SVG/DXF как окончательный чертёж. Успешные плитки сохранены в .checkpoints; повторный запуск того же задания продолжит только необработанные плитки.')
        graph['warnings'].extend(str(reason) for reason in incomplete_reasons if reason)
    if not ocr_status.get('qwen', {}).get('available'):
        graph['warnings'].append('Qwen OCR недоступен; использован Tesseract, если он установлен. Проверьте Ollama и модель Qwen3-VL.')
    if not route_status.get('available') or not semantic_routes:
        graph['warnings'].append('Qwen не предоставила семантические маршруты для дополнительной проверки. Основной PIPE_MAIN при этом строится независимо из выбранных геометрических путей OpenCV. Причина: ' + str(route_status.get('error') or 'маршруты отсутствуют') + ' Действие: ' + str(route_status.get('hint') or 'проверьте Ollama и модель.'))
    if not _cad_edge_chains(edges):
        graph['warnings'].append('В графе OpenCV не осталось выбранных основных CAD-путей. Проверьте исходное изображение и слой DETAIL_REVIEW.')
    if len(segments) >= 80 and (cad_selection.get('cad_primary_edges', 0) + len(primary_semantic_routes)) < max(12, int(len(segments) * 0.12)):
        graph['warnings'].append('Основная геометрия получилась разреженной: большинство штрихов оставлено на проверку. Не считайте чертёж полным; проверьте primary-overlay.png и text-region-mask.png.')
    diagnostics = build_pipeline_diagnostics(input_path, out_dir, graph)
    graph['diagnostics'] = diagnostics
    Path(out_dir,'diagnostics.json').write_text(json.dumps(diagnostics,ensure_ascii=False,indent=2),encoding='utf-8')
    Path(out_dir,'graph.json').write_text(json.dumps(graph,ensure_ascii=False,indent=2),encoding='utf-8')
    _progress('EXPORT', 'graph.json written; intermediate checkpoints retained')
    if processing_complete:
        _progress('JOB', 'Analysis completed successfully; all Qwen tiles completed')
    else:
        _progress('JOB', 'Analysis INCOMPLETE; partial exports are review-only. Re-run this job to resume failed tiles from checkpoints.')
    return graph


def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--input',required=True); ap.add_argument('--out',required=True)
    args=ap.parse_args(); result=analyze(args.input,args.out); print(json.dumps(result,ensure_ascii=False))

if __name__=='__main__': main()
