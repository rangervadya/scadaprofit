"""Document image preprocessing (P2-1): deskew, dewarp, rotation, ink layers.

Moved from processor.py verbatim; depends only on OpenCV/NumPy/Pillow and the
module logger.
"""

from __future__ import annotations

import math
import os
import re
from typing import Any

import cv2
import numpy as np
from logging_setup import get_logger
from PIL import Image, ImageOps

log = get_logger('processor.preprocess')

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


def _detect_text_rotation(bgr: np.ndarray) -> tuple[int, float, float]:
    """Use Tesseract OSD only when both orientation and script evidence are strong.

    Technical drawings contain sparse labels, symbols and dimension lines. OSD can
    misclassify such pages (for example, report Arabic with very low script
    confidence) and a weak 180-degree guess must not rotate the source image.
    Thresholds are configurable for deployments with a validated document set.
    """
    min_orientation = max(0.0, float(os.getenv('OSD_MIN_ORIENTATION_CONFIDENCE', '8.0')))
    min_script = max(0.0, float(os.getenv('OSD_MIN_SCRIPT_CONFIDENCE', '2.0')))
    try:
        import pytesseract
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        result = pytesseract.image_to_osd(Image.fromarray(rgb), config='--psm 0')
        rotate_match = re.search(r'Rotate:\s*(0|90|180|270)', result)
        confidence_match = re.search(r'Orientation confidence:\s*([0-9.]+)', result)
        script_confidence_match = re.search(r'Script confidence:\s*([0-9.]+)', result)
        rotation = int(rotate_match.group(1)) if rotate_match else 0
        confidence = float(confidence_match.group(1)) if confidence_match else 0.0
        script_confidence = float(script_confidence_match.group(1)) if script_confidence_match else 0.0
        trusted = confidence >= min_orientation and script_confidence >= min_script
        return (rotation if trusted else 0, confidence, script_confidence)
    except Exception:
        log.debug('Orientation detection failed; falling back to 0 degrees', exc_info=True)
        return 0, 0.0, 0.0


def _detect_text_rotation_fallback(bgr: np.ndarray) -> dict[str, Any] | None:
    """Score four page orientations with OCR when Tesseract OSD is inconclusive.

    This deliberately requires a clear score margin: on sparse engineering
    drawings a weak OCR guess must not override the user's source image.
    Returns diagnostics even when no orientation is accepted.
    """
    try:
        import pytesseract
        from pytesseract import Output

        max_edge = max(300, min(1800, int(os.getenv('OSD_FALLBACK_MAX_EDGE', '900'))))
        timeout = max(1.0, min(15.0, float(os.getenv('OSD_FALLBACK_TIMEOUT_SECONDS', '4.0'))))
        min_score = max(0.0, float(os.getenv('OSD_FALLBACK_MIN_SCORE', '18.0')))
        min_gap = max(0.0, float(os.getenv('OSD_FALLBACK_MIN_GAP', '3.0')))
        min_margin = max(0.0, min(1.0, float(os.getenv('OSD_FALLBACK_MIN_MARGIN', '0.12'))))
        lang = os.getenv('OSD_FALLBACK_LANG', 'rus+eng').strip() or 'eng'

        h, w = bgr.shape[:2]
        scale = min(1.0, max_edge / max(h, w))
        sample = cv2.resize(bgr, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA) if scale < 1 else bgr.copy()
        scores: dict[str, float] = {}
        diagnostics: dict[str, Any] = {}
        rotations = {
            0: sample,
            90: cv2.rotate(sample, cv2.ROTATE_90_CLOCKWISE),
            180: cv2.rotate(sample, cv2.ROTATE_180),
            270: cv2.rotate(sample, cv2.ROTATE_90_COUNTERCLOCKWISE),
        }
        for angle, candidate in rotations.items():
            gray = cv2.cvtColor(candidate, cv2.COLOR_BGR2GRAY)
            try:
                data = pytesseract.image_to_data(
                    Image.fromarray(gray), lang=lang, config='--oem 1 --psm 11',
                    output_type=Output.DICT, timeout=timeout
                )
                score = 0.0
                accepted_tokens = 0
                for raw_text, raw_conf in zip(data.get('text', []), data.get('conf', [])):
                    token = str(raw_text or '').strip()
                    try:
                        confidence = float(raw_conf)
                    except (TypeError, ValueError):
                        continue
                    if confidence < 25 or not any(char.isalnum() for char in token):
                        continue
                    score += (confidence / 100.0) ** 1.5 * min(len(token), 8)
                    accepted_tokens += 1
                scores[str(angle)] = round(score, 2)
                diagnostics[str(angle)] = {'tokens': accepted_tokens, 'status': 'ok'}
            except Exception as error:
                scores[str(angle)] = 0.0
                diagnostics[str(angle)] = {'tokens': 0, 'status': type(error).__name__}

        ranked = sorted(((score, int(angle)) for angle, score in scores.items()), reverse=True)
        if not ranked:
            return {'accepted': False, 'rotation_degrees': None, 'scores': scores, 'candidates': diagnostics, 'reason': 'no_candidates'}
        best_score, best_angle = ranked[0]
        second_score = ranked[1][0] if len(ranked) > 1 else 0.0
        required_gap = max(min_gap, best_score * min_margin)
        accepted = best_score >= min_score and (best_score - second_score) >= required_gap
        # OCR token counts can be misleading on engineering drawings: dimensions,
        # callout numbers and mirrored-looking glyphs often make an upside-down
        # (180-degree) pass score slightly higher than the already upright page.
        # Require stronger relative evidence before flipping a page by 180 degrees.
        relative_margin = (best_score - second_score) / max(best_score, 1.0)
        min_180_margin = max(0.0, min(0.95, float(os.getenv('OSD_FALLBACK_180_MIN_MARGIN', '0.35'))))
        if accepted and best_angle == 180 and relative_margin < min_180_margin:
            accepted = False
            reason = 'ambiguous_180_requires_stronger_ocr_margin'
        else:
            reason = 'clear_ocr_margin' if accepted else 'ambiguous_ocr_scores'
        return {
            'accepted': bool(accepted),
            'rotation_degrees': best_angle if accepted else None,
            'scores': scores, 'candidates': diagnostics,
            'winner_score': round(best_score, 2), 'runner_up_score': round(second_score, 2),
            'required_margin': round(required_gap, 2),
            'relative_margin': round(relative_margin, 4),
            'minimum_180_relative_margin': min_180_margin, 'reason': reason,
        }
    except Exception as error:
        return {
            'accepted': False, 'rotation_degrees': None, 'scores': {},
            'candidates': {}, 'reason': f'fallback_unavailable:{type(error).__name__}',
        }


def _estimate_document_skew(bgr: np.ndarray) -> dict[str, Any]:
    """Estimate small page rotation only when horizontal AND vertical evidence agrees."""
    h, w = bgr.shape[:2]
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(cv2.GaussianBlur(gray, (3, 3), 0), 45, 130)
    min_dimension = min(h, w)
    min_length = max(36, int(min_dimension * 0.035))
    threshold = max(24, int(min_dimension * 0.018))
    lines = cv2.HoughLinesP(edges, 1, np.pi / 1800.0, threshold=threshold,
                            minLineLength=min_length, maxLineGap=max(10, int(min_dimension * 0.012)))
    horizontal: list[tuple[float, float]] = []
    vertical: list[tuple[float, float]] = []
    if lines is not None:
        for raw in np.asarray(lines).reshape(-1, 4):
            x1, y1, x2, y2 = map(float, raw)
            dx, dy = x2 - x1, y2 - y1
            length = math.hypot(dx, dy)
            if length < min_length:
                continue
            angle = math.degrees(math.atan2(dy, dx))
            # Express both horizontal and vertical families as a small signed tilt.
            horizontal_offset = ((angle + 45.0) % 90.0) - 45.0
            if abs(horizontal_offset) <= 7.0:
                if abs(angle) <= 35.0 or abs(angle) >= 145.0:
                    horizontal.append((horizontal_offset, length))
                else:
                    vertical.append((horizontal_offset, length))
    def weighted_median(values: list[tuple[float, float]]) -> float:
        ranked = sorted(values, key=lambda item: item[0])
        half = sum(weight for _, weight in ranked) / 2.0
        accumulated = 0.0
        for value, weight in ranked:
            accumulated += weight
            if accumulated >= half:
                return value
        return ranked[-1][0]
    min_total_length = max(150.0, math.hypot(w, h) * 0.10)
    if len(horizontal) < 2 or len(vertical) < 2:
        return {"accepted": False, "angle_degrees": 0.0, "horizontal_lines": len(horizontal),
                "vertical_lines": len(vertical), "reason": "insufficient_two_axis_evidence"}
    h_angle = weighted_median(horizontal)
    v_angle = weighted_median(vertical)
    combined = weighted_median(horizontal + vertical)
    deviations = [abs(value - combined) for value, _ in horizontal + vertical]
    total_length = sum(length for _, length in horizontal + vertical)
    max_angle = max(0.25, min(4.0, float(os.getenv('DESKEW_MAX_ANGLE_DEG', '2.5'))))
    consistent = (abs(h_angle - v_angle) <= 0.85 and
                  float(np.median(deviations)) <= 0.55 and
                  max(deviations, default=0.0) <= 1.35)
    accepted = (consistent and total_length >= min_total_length and
                0.30 <= abs(combined) <= max_angle)
    return {"accepted": bool(accepted), "angle_degrees": round(combined, 3) if accepted else 0.0,
            "horizontal_lines": len(horizontal), "vertical_lines": len(vertical),
            "horizontal_angle": round(h_angle, 3), "vertical_angle": round(v_angle, 3),
            "median_deviation": round(float(np.median(deviations)), 3) if deviations else 0.0,
            "evidence_length_px": round(total_length, 1), "minimum_evidence_length_px": round(min_total_length, 1),
            "reason": "consistent_two_axis_evidence" if accepted else "weak_or_inconsistent_skew_evidence"}


def _rotate_expand(bgr: np.ndarray, angle_degrees: float) -> np.ndarray:
    """Rotate an image without clipping page content; expose a white canvas."""
    h, w = bgr.shape[:2]
    centre = (w / 2.0, h / 2.0)
    matrix = cv2.getRotationMatrix2D(centre, float(angle_degrees), 1.0)
    radians = math.radians(abs(float(angle_degrees)))
    new_w = int(math.ceil(w * math.cos(radians) + h * math.sin(radians)))
    new_h = int(math.ceil(h * math.cos(radians) + w * math.sin(radians)))
    matrix[0, 2] += new_w / 2.0 - centre[0]
    matrix[1, 2] += new_h / 2.0 - centre[1]
    return cv2.warpAffine(bgr, matrix, (new_w, new_h), flags=cv2.INTER_CUBIC,
                          borderMode=cv2.BORDER_CONSTANT, borderValue=(255, 255, 255))


def prepare_document_image(bgr: np.ndarray, rotation_degrees: int | None = None) -> tuple[np.ndarray, dict[str, Any]]:
    """Rectify a photographed page and rotate confidently detected text upright."""
    original_h, original_w = bgr.shape[:2]
    quad = _detect_page_quad(bgr)
    prepared = _warp_page(bgr, quad) if quad is not None else bgr.copy()
    rotation_diagnostics = None
    if rotation_degrees is None:
        rotation_degrees, orientation_confidence, script_confidence = _detect_text_rotation(prepared)
        min_orientation = max(0.0, float(os.getenv('OSD_MIN_ORIENTATION_CONFIDENCE', '8.0')))
        min_script = max(0.0, float(os.getenv('OSD_MIN_SCRIPT_CONFIDENCE', '2.0')))
        osd_trusted = orientation_confidence >= min_orientation and script_confidence >= min_script
        if rotation_degrees:
            orientation_decision = 'auto_applied'
        elif not osd_trusted:
            rotation_diagnostics = _detect_text_rotation_fallback(prepared)
            if rotation_diagnostics and rotation_diagnostics.get('accepted'):
                rotation_degrees = int(rotation_diagnostics.get('rotation_degrees') or 0)
                orientation_decision = 'fallback_ocr_applied' if rotation_degrees else 'fallback_ocr_preserved_upright'
            else:
                orientation_decision = 'preserved_low_confidence'
        else:
            orientation_decision = 'preserved_no_rotation'
    else:
        orientation_confidence = 100.0
        script_confidence = 100.0
        orientation_decision = 'explicit_rotation'
    rotation_degrees = int(rotation_degrees or 0) % 360
    rotate_codes = {90: cv2.ROTATE_90_CLOCKWISE, 180: cv2.ROTATE_180, 270: cv2.ROTATE_90_COUNTERCLOCKWISE}
    if rotation_degrees in rotate_codes:
        prepared = cv2.rotate(prepared, rotate_codes[rotation_degrees])
    skew_diagnostics = _estimate_document_skew(prepared)
    deskew_applied = False
    if skew_diagnostics.get("accepted"):
        prepared = _rotate_expand(prepared, float(skew_diagnostics["angle_degrees"]))
        deskew_applied = True
    return prepared, {
        "original_width": original_w, "original_height": original_h,
        "page_quad_detected": quad is not None,
        "perspective_corrected": quad is not None,
        "rotation_degrees": rotation_degrees,
        "orientation_confidence": round(float(orientation_confidence), 2),
        "script_confidence": round(float(script_confidence), 2),
        "orientation_min_confidence": max(0.0, float(os.getenv('OSD_MIN_ORIENTATION_CONFIDENCE', '8.0'))),
        "script_min_confidence": max(0.0, float(os.getenv('OSD_MIN_SCRIPT_CONFIDENCE', '2.0'))),
        "orientation_decision": orientation_decision,
        "orientation_fallback": rotation_diagnostics,
        "deskew": {**skew_diagnostics, "applied": deskew_applied},
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


def make_ink_layers(bgr: np.ndarray, norm_gray: np.ndarray) -> dict[str, Any]:
    """Separate blue, dark and locally-contrasted faint ink without binarizing the source.

    The adaptive layer recovers pale pencil and weak pen marks under uneven
    illumination. A luminance ceiling prevents bright paper texture from being
    promoted solely because it is darker than its local neighbourhood.
    """
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    h, saturation, value = cv2.split(hsv)
    blue = ((h >= 82) & (h <= 155) & (saturation >= 22) & (value <= 252)).astype(np.uint8) * 255
    dark = (norm_gray < 158).astype(np.uint8) * 255

    min_side = min(norm_gray.shape[:2])
    max_odd = min(61, min_side if min_side % 2 else min_side - 1)
    block_size = max(3, min(max_odd, max(15, (min_side // 30) | 1)))
    if block_size % 2 == 0:
        block_size -= 1
    if block_size >= 3:
        adaptive = cv2.adaptiveThreshold(
            norm_gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY_INV, block_size,
            max(4, min(12, int(os.getenv("ADAPTIVE_INK_C", "8"))))
        )
        faint = cv2.bitwise_and(adaptive, (norm_gray < 226).astype(np.uint8) * 255)
        faint = cv2.bitwise_and(faint, cv2.bitwise_not(dark))
        faint = cv2.bitwise_and(faint, cv2.bitwise_not(blue))
    else:
        faint = np.zeros_like(norm_gray)

    combined = cv2.bitwise_or(cv2.bitwise_or(blue, dark), faint)
    # Remove isolated sensor speckles while retaining one- and two-pixel strokes.
    count, labels, stats, _ = cv2.connectedComponentsWithStats(combined, 8)
    filtered = np.zeros_like(combined)
    min_area = 2 if combined.size < 2_000_000 else 3
    for component in range(1, count):
        if stats[component, cv2.CC_STAT_AREA] >= min_area:
            filtered[labels == component] = 255
    return {
        "blue": cv2.bitwise_and(blue, filtered),
        "dark": cv2.bitwise_and(dark, filtered),
        "faint": cv2.bitwise_and(faint, filtered),
        "combined": filtered,
        "adaptive_block_size": block_size,
    }


def make_ink_mask(bgr: np.ndarray, norm_gray: np.ndarray) -> np.ndarray:
    return make_ink_layers(bgr, norm_gray)["combined"]


