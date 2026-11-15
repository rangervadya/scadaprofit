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
import time
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import qwen_client

# CAD export moved to cad_export.py (P2-1); re-exported so existing imports of
# `processor.build_clean_svg` and the tests that patch `processor.*` keep working.
from analysis_state import set_analysis_hard_deadline
from annotation_linking import link_annotations
from cad_export import (  # noqa: F401
    _annotation_export_kind,
    _cad_edge_chains,
    _clean_cad_points,
    _primary_semantic_chains,
    _semantic_route_chains,
    _sheet_layout,
    build_clean_svg,
    build_dxf,
)
from cad_graph import (  # noqa: F401
    _build_join_candidates,
    _point_to_segment_distance,
    detect_crossings,
    select_primary_cad_edges,
    validate_primary_semantic_routes,
)
from cad_overlay import render_cad_alignment_overlay
from cad_symbols import catalog_manifest
from centerline_vectorization import build_centerline_trace
from clean_export import build_layout_dxf, build_layout_svg
from clean_layout import build_clean_layout
from drawing_quality import validate_clean_layout
from drawing_template import build_drawing_template
from engineering_validation import validate_engineering_model
from image_preprocess import (  # noqa: F401
    _detect_page_quad,
    _detect_text_rotation,
    _detect_text_rotation_fallback,
    _estimate_document_skew,
    _order_quad,
    _rotate_expand,
    _warp_page,
    load_image,
    make_ink_layers,
    make_ink_mask,
    normalize_document,
    prepare_document_image,
)
from logging_setup import configure_logging, emit_progress, get_logger
from moss_ai import (
    DEFAULT_MODEL as DEFAULT_MOSS_MODEL,
)
from moss_ai import (
    moss_ocr_annotations,  # noqa: F401 - tests patch processor.moss_ocr_annotations
    test_moss_ai,
)
from openrouter_ai import (
    DEFAULT_MODEL as DEFAULT_OPENROUTER_MODEL,
)
from openrouter_ai import (
    openrouter_ocr_annotations,  # noqa: F401 - tests patch processor.openrouter_ocr_annotations
    test_openrouter_ai,
)
from PIL import Image, ImageOps
from pipeline_diagnostics import build_pipeline_diagnostics
from qwen_client import (  # noqa: F401
    CHECKPOINT_VERSION,
    _analysis_has_qwen_budget,
    _annotation_items_from_response,
    _clip_polyline_to_rect,
    _clip_segment_to_rect,
    _is_retryable_qwen_error,
    _load_tile_checkpoint,
    _parse_json_object,
    _qwen_attempt_worst_case_seconds,
    _qwen_call,
    _qwen_call_with_retry,
    _save_tile_checkpoint,
    _sha256_file,
    _tile_checkpoint_path,
    _tile_checkpoint_signature,
)
from recognition_channels import split_recognition_channels
from reference_vectorization import build_reference_trace
from segment_geometry import (  # noqa: F401
    _confirmed_text_boxes,
    _expanded_text_box,
    _merge_aligned_duplicate,
    _same_ink_band,
    _sample_line_support,
    _segment_inside_text_box,
    _segment_text_box_metrics,
    _segment_text_mask_metrics,
    _text_region_mask,
    endpoint_clusters,
    extract_segments,
)
from structured_model import build_document_model
from topology_reconstruction import attach_pipes_to_symbols, split_segments_at_endpoint_junctions

configure_logging()
log = get_logger('processor')


def _progress(stage: str, message: str) -> None:
    """Emit one progress event for the parent process and for progress.log.

    The stage is sanitised and the message flattened to a single short line, so
    the Node parent can render it as `[STAGE] message` exactly as before.
    """
    emit_progress(stage, message, logger=log)


def _atomic_write_text(path: str | Path, text: str) -> None:
    """Persist a text artifact without exposing a truncated file on SIGKILL.

    `write_text` truncates first, so a container kill during a multi-megabyte
    graph leaves invalid JSON. Write beside the target and `os.replace` it.
    """
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f'{target.name}.{os.getpid()}.tmp')
    try:
        temporary.write_text(text, encoding='utf-8')
        os.replace(temporary, target)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def _annotate_edge_ink_color(edges: list[dict[str, Any]], blue_mask: np.ndarray, dark_mask: np.ndarray) -> dict[str, int]:
    """Attach measured pen-colour evidence without changing line inclusion.

    Blue and dark ink are evidence only: colour is not used to decide whether
    a stroke is an original pipe or a later correction.
    """
    if blue_mask.shape != dark_mask.shape:
        return {'classifiedBlue': 0, 'classifiedDark': 0, 'classifiedMixed': 0, 'unknown': len(edges)}
    blue = cv2.dilate(blue_mask, np.ones((3, 3), np.uint8), iterations=1) > 0
    dark_only_mask = cv2.bitwise_and(dark_mask, cv2.bitwise_not(blue_mask))
    dark = cv2.dilate(dark_only_mask, np.ones((3, 3), np.uint8), iterations=1) > 0
    height, width = blue.shape[:2]
    counts = {'classifiedBlue': 0, 'classifiedDark': 0, 'classifiedMixed': 0, 'unknown': 0}
    for edge in edges:
        samples: list[tuple[int, int]] = []
        geometry = edge.get('geometry') or []
        for start, end in zip(geometry, geometry[1:]):
            try:
                ax, ay, bx, by = float(start[0]), float(start[1]), float(end[0]), float(end[1])
            except (TypeError, ValueError, IndexError):
                continue
            length = math.hypot(bx - ax, by - ay)
            n = max(2, int(length / 3.0) + 1)
            for t in np.linspace(0.0, 1.0, n):
                x = min(width - 1, max(0, int(round(ax + (bx - ax) * t))))
                y = min(height - 1, max(0, int(round(ay + (by - ay) * t))))
                samples.append((x, y))
        if not samples:
            edge['inkColor'] = 'unknown'
            edge['inkColorConfidence'] = 0.0
            edge['inkColorEvidence'] = {'blueCoverage': 0.0, 'darkCoverage': 0.0, 'samples': 0}
            counts['unknown'] += 1
            continue
        blue_coverage = sum(bool(blue[y, x]) for x, y in samples) / len(samples)
        dark_coverage = sum(bool(dark[y, x]) for x, y in samples) / len(samples)
        if blue_coverage >= 0.40 and blue_coverage >= dark_coverage * 1.25:
            color = 'blue'
        elif dark_coverage >= 0.40 and dark_coverage >= blue_coverage * 1.25:
            color = 'dark'
        elif min(blue_coverage, dark_coverage) >= 0.20:
            color = 'mixed'
        else:
            color = 'unknown'
        confidence = abs(blue_coverage - dark_coverage) / max(blue_coverage, dark_coverage, 0.01)
        edge['inkColor'] = color
        edge['inkColorConfidence'] = round(confidence if color in {'blue', 'dark'} else 0.0, 3)
        edge['inkColorEvidence'] = {
            'blueCoverage': round(blue_coverage, 3),
            'darkCoverage': round(dark_coverage, 3),
            'samples': len(samples),
        }
        counts[{'blue': 'classifiedBlue', 'dark': 'classifiedDark', 'mixed': 'classifiedMixed'}.get(color, 'unknown')] += 1
    return counts


OCR_RESPONSE_SCHEMA: dict[str, Any] = {
    'type': 'object',
    'properties': {
        'annotations': {
            'type': 'array',
            'maxItems': 64,
            'items': {
                'type': 'object',
                'properties': {
                    'text': {'type': 'string'},
                    # Compact [x1, y1, x2, y2] form cuts response tokens;
                    # the OCR parser maps it back to the same source-pixel box.
                    'bbox': {
                        'type': 'array',
                        'minItems': 4,
                        'maxItems': 4,
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
            'type': 'array',
            'maxItems': 32,
            'items': {
                'type': 'object',
                'properties': {
                    'text': {'type': 'string'},
                    # Compact [x1, y1, x2, y2] form cuts response tokens;
                    # the OCR parser maps it back to the same source-pixel box.
                    'bbox': {
                        'type': 'array',
                        'minItems': 4,
                        'maxItems': 4,
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
            'type': 'array',
            'maxItems': 16,
            'items': {
                'type': 'object',
                'properties': {
                    'text': {'type': 'string'},
                    'bbox': {'type': 'array', 'minItems': 4, 'maxItems': 4, 'items': {'type': 'number'}},
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
            'type': 'array',
            'minItems': 2,
            'maxItems': 2,
            'items': {
                'type': 'object',
                'properties': {
                    'text': {'type': 'string'},
                    'confidence': {'type': 'number'},
                    # Optional cell boxes are used for compact handwritten
                    # tables. Coordinates refer to the exact image sent for
                    # the paired-row request, not to the original page.
                    'cells': {
                        'type': 'array',
                        'maxItems': 16,
                        'items': {
                            'type': 'object',
                            'properties': {
                                'text': {'type': 'string'},
                                'bbox': {
                                    'type': 'array',
                                    'minItems': 4,
                                    'maxItems': 4,
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
        if sum(float(np.max(smooth[max(0, int(c) - 2) : min(height, int(c) + 3)])) >= peak_floor for c in centers) < max(
            2, int(math.ceil(row_count * 0.60))
        ):
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
            rows.append(
                {
                    'x': x,
                    'y': y + top,
                    'w': width,
                    'h': bottom - top,
                    'row': index + 1,
                    'center_y': round(y + center, 1),
                    'pitch': round(pitch, 1),
                    'ink_peak': round(float(np.max(smooth[max(0, int(center) - 2) : min(height, int(center) + 3)])), 2),
                }
            )
        return rows if len(rows) >= 3 else []
    except Exception:
        log.debug('Handwritten row detection failed; skipping this pass', exc_info=True)
        return []


def _run_numbered_row_ocr(
    image: Image.Image,
    block: dict[str, Any],
    rows: list[dict[str, int]],
    *,
    url: str,
    model: str,
    timeout: float,
    max_edge: int,
    max_tokens: int,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
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
    batches = [rows[index : index + batch_size] for index in range(0, len(rows), batch_size)]
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

    def make_result(
        row: dict[str, Any], box: tuple[int, int, int, int], parsed_row: Any, *, diag: dict[str, Any], fallback: bool = False
    ) -> dict[str, Any]:
        left, top, right, bottom = box
        text, confidence, verified = normalize(parsed_row)
        diag.update(
            {
                'text_preview': text[:100],
                'confidence': round(confidence, 1),
                'accepted': bool(text != '?' and bool(re.search(r'[A-Za-zА-Яа-я0-9ØøΦφДдУу]', text))),
                'verified': verified,
                'fallback_single_row': fallback,
            }
        )
        return {
            'id': f'QBR{row["row"]}',
            'text': text,
            'confidence': round(confidence, 1),
            'bbox': {'x': left, 'y': top, 'w': right - left, 'h': bottom - top},
            'verified': verified,
            'include': verified,
            'geometry_exclude': True,
            'source': 'qwen3-vl-block',
            'block_line': True,
            'row_index': row['row'],
        }

    def make_cell_results(
        row: dict[str, Any],
        cells: Any,
        *,
        crop_origin: tuple[int, int],
        coordinate_scale: float,
        sent_size: tuple[int, int],
        row_source_box: tuple[int, int, int, int],
        row_confidence: float,
    ) -> list[dict[str, Any]]:
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
            if x2 <= x1 or y2 <= y1 or x1 < -2 or y1 < -2 or x2 > sent_width + 2 or y2 > sent_height + 2:
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
            output.append(
                {
                    'id': f'QBR{row["row"]}C{cell_index}',
                    'text': text,
                    'confidence': round(max(0.0, min(100.0, confidence)), 1),
                    'bbox': {'x': round(gx1, 2), 'y': round(gy1, 2), 'w': round(bw, 2), 'h': round(bh, 2)},
                    'verified': verified,
                    'include': verified,
                    'geometry_exclude': True,
                    'source': 'qwen3-vl-block',
                    'block_line': True,
                    'row_index': row['row'],
                    'table_cell': True,
                    'bbox_coordinate_space': 'original-image-pixels',
                    'bbox_source': 'paired-row-crop-cell',
                    'source_crop_xyxy': [
                        int(crop_left),
                        int(crop_top),
                        int(crop_left + round(sent_width / coordinate_scale)),
                        int(crop_top + round(sent_height / coordinate_scale)),
                    ],
                    'source_row_bbox': {
                        'x': int(row_left),
                        'y': int(row_top),
                        'w': int(row_right - row_left),
                        'h': int(row_bottom - row_top),
                    },
                }
            )
        return output

    def single_row_read(row: dict[str, Any], *, batch_index: int, reason: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        box = row_box(row)
        left, top, right, bottom = box
        crop = image.crop((left, top, right, bottom)).convert('RGB')
        scale = min(4.0, max(2.5, 84.0 / max(1.0, crop.height)))
        crop = crop.resize((max(1, int(round(crop.width * scale))), max(1, int(round(crop.height * scale)))), Image.Resampling.LANCZOS)
        diag: dict[str, Any] = {
            'row': row['row'],
            'center_y': row['center_y'],
            'bbox': {'x': left, 'y': top, 'w': right - left, 'h': bottom - top},
            'input_size': list(crop.size),
            'batch_index': batch_index,
            'request_mode': 'single_fallback',
            'fallback_reason': reason,
        }
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
            parsed, resize_scale, sent_size = qwen_client._qwen_call(
                crop,
                prompt,
                url=url,
                model=model,
                timeout=row_timeout,
                max_edge=max_edge,
                num_predict=max(128, min(320, int(max_tokens))),
                diagnostics=diag,
                format_schema=OCR_ROW_RESPONSE_SCHEMA,
            )
            diag['sent_size'] = list(sent_size)
            _row_text, row_confidence, row_verified = normalize(parsed)
            cell_results = (
                make_cell_results(
                    row,
                    parsed.get('cells') if isinstance(parsed, dict) else None,
                    crop_origin=(left, top),
                    coordinate_scale=scale * resize_scale,
                    sent_size=sent_size,
                    row_source_box=box,
                    row_confidence=row_confidence,
                )
                if row_verified and row_confidence >= 70.0
                else []
            )
            if len(cell_results) >= 2:
                diag.update(
                    {
                        'table_cells': len(cell_results),
                        'cell_boxes_used': True,
                        'bbox_coordinate_space': 'original-image-pixels',
                        'crop_origin': [left, top],
                        'crop_coordinate_scale': round(float(scale * resize_scale), 6),
                        'sent_size': list(sent_size),
                    }
                )
                result = cell_results
            else:
                result = [make_result(row, box, parsed, diag=diag, fallback=True)]
        except Exception as error:
            diag['error'] = (str(error).strip() or error.__class__.__name__)[:180]
            diag['confidence'] = 0.0
            diag['accepted'] = False
            diag['verified'] = False
            diag['fallback_single_row'] = True
            result = [
                {
                    'id': f'QBR{row["row"]}',
                    'text': '?',
                    'confidence': 0.0,
                    'bbox': {'x': left, 'y': top, 'w': right - left, 'h': bottom - top},
                    'verified': False,
                    'include': False,
                    'geometry_exclude': True,
                    'source': 'qwen3-vl-block',
                    'block_line': True,
                    'row_index': row['row'],
                }
            ]
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
            'batch': batch_index,
            'rows': [int(row['row']) for row in batch],
            'bbox': {'x': left, 'y': top, 'w': right - left, 'h': bottom - top},
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
            crop = crop.resize((max(1, int(round(crop.width * scale))), max(1, int(round(crop.height * scale)))), Image.Resampling.LANCZOS)
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
                parsed, batch_resize_scale, sent_size = qwen_client._qwen_call(
                    crop,
                    prompt,
                    url=url,
                    model=model,
                    timeout=batch_timeout,
                    max_edge=max_edge,
                    num_predict=max(256, min(440, int(max_tokens))),
                    diagnostics=batch_diag,
                    format_schema=OCR_ROWS_RESPONSE_SCHEMA,
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
                    'row': row['row'],
                    'center_y': row['center_y'],
                    'bbox': {'x': box[0], 'y': box[1], 'w': box[2] - box[0], 'h': box[3] - box[1]},
                    'batch_index': batch_index,
                    'batch_size': len(batch),
                    'request_mode': 'paired_rows',
                    'batch_ollama_total_ms': batch_diag.get('ollama_total_ms'),
                    'batch_eval_count': batch_diag.get('eval_count'),
                }
                parsed_row = parsed_rows[index]
                _text, _confidence, verified = normalize(parsed_row)
                # A compact table needs cell-level positions. Keep these as
                # separate OCR entities so 1/2/3/4 remain over their source
                # columns instead of being printed as one centred sentence.
                if verified and _confidence >= 70.0 and isinstance(parsed_row, dict) and parsed_row.get('cells'):
                    cell_results = make_cell_results(
                        row,
                        parsed_row.get('cells'),
                        crop_origin=(left, top),
                        coordinate_scale=batch_coordinate_scale,
                        sent_size=sent_size,
                        row_source_box=box,
                        row_confidence=_confidence,
                    )
                    if len(cell_results) >= 2:
                        results.extend(cell_results)
                        row_diag.update(
                            {
                                'table_cells': len(cell_results),
                                'cell_boxes_used': True,
                                'bbox_coordinate_space': 'original-image-pixels',
                                'crop_origin': [left, top],
                                'crop_coordinate_scale': round(float(batch_coordinate_scale), 6),
                                'sent_size': list(sent_size),
                            }
                        )
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
        'rows_detected': len(rows),
        'rows_returned': len(results),
        'row_diagnostics': row_diags,
        'row_batch_diagnostics': batch_diags,
        'row_batches': len(batches),
        'row_batch_size': batch_size,
        'single_row_fallbacks': sum(1 for item in row_diags if item.get('request_mode') == 'single_fallback'),
    }


def _candidate_handwritten_text_blocks(
    items: list[dict[str, Any]], width: int, height: int, max_blocks: int = 2, image: Image.Image | None = None
) -> list[dict[str, Any]]:
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
            candidates.append(
                (
                    score,
                    {
                        'x': max(0, int(math.floor(left))),
                        'y': max(0, int(math.floor(top))),
                        'w': min(width, int(math.ceil(right))) - max(0, int(math.floor(left))),
                        'h': min(height, int(math.ceil(bottom))) - max(0, int(math.floor(top))),
                        'source_boxes': len(group),
                        'detection_source': 'ocr-box-cluster',
                        'row_peaks': 0,
                    },
                )
            )

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
                    roi = row_joined[y : y + bh, x : x + bw]
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
                    candidates.append(
                        (
                            score,
                            {
                                'x': left,
                                'y': top,
                                'w': right - left,
                                'h': bottom - top,
                                'source_boxes': seed_count,
                                'detection_source': 'source-ink-multiline-block',
                                'row_peaks': len(peaks),
                            },
                        )
                    )
        except Exception:
            # OCR box clustering remains available when the image heuristic
            # cannot process an unusual image encoding.
            log.debug('Handwritten block heuristic failed; keeping box clustering', exc_info=True)

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


def _run_handwritten_block_ocr(
    original: Image.Image, seed_items: list[dict[str, Any]], *, url: str, model: str, timeout: float, max_edge: int, max_tokens: int
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
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
        diag: dict[str, Any] = {
            'block': block_index,
            'bbox': {'x': left, 'y': top, 'w': right - left, 'h': bottom - top},
            'seed_boxes': block['source_boxes'],
            'detection_source': block.get('detection_source'),
            'row_peaks': block.get('row_peaks', 0),
        }
        row_bands = _detect_handwritten_row_bands(original, block)
        if len(row_bands) >= 3:
            row_results, row_summary = _run_numbered_row_ocr(
                original, block, row_bands, url=url, model=model, timeout=timeout, max_edge=max_edge, max_tokens=max_tokens
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
            parsed, resize_scale, sent_size = qwen_client._qwen_call(
                crop,
                prompt,
                url=url,
                model=model,
                timeout=timeout,
                max_edge=max_edge,
                num_predict=max_tokens,
                diagnostics=diag,
                format_schema=OCR_BLOCK_RESPONSE_SCHEMA,
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
                    raw_box = {'x': x1, 'y': y1, 'w': x2 - x1, 'h': y2 - y1}
                elif isinstance(bbox, dict):
                    try:
                        raw_box = {key: float(bbox[key]) for key in ('x', 'y', 'w', 'h')}
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
                results.append(
                    {
                        'id': f'QB{len(results) + 1}',
                        'text': text,
                        'confidence': round(max(0.0, min(100.0, confidence)), 1),
                        'bbox': {'x': x, 'y': y, 'w': bw, 'h': bh},
                        'verified': verified,
                        'include': verified,
                        'geometry_exclude': True,
                        'source': 'qwen3-vl-block',
                        'block_line': True,
                    }
                )
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
            'type': 'array',
            'maxItems': 64,
            'items': {
                'type': 'object',
                'properties': {
                    'id': {'type': 'string'},
                    'points': {
                        'type': 'array',
                        'minItems': 2,
                        'maxItems': 64,
                        'items': {
                            'type': 'array',
                            'minItems': 2,
                            'maxItems': 2,
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


def _tesseract_failed_ocr_tiles(
    original: Image.Image, tile_diagnostics: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Recover review-only text candidates from Qwen OCR tiles that failed.

    This supplement never counts as a successful Qwen tile: the job remains
    incomplete until the configured vision-model coverage is complete. OCR
    boxes from this pass are review annotations, not engineering assertions.
    """
    failed = [item for item in tile_diagnostics if item.get('tile_status') == 'failed']
    try:
        max_tiles = max(0, min(9, int(os.getenv('QWEN_TESSERACT_FALLBACK_MAX_TILES', '9'))))
    except (TypeError, ValueError):
        max_tiles = 9
    if not failed or max_tiles <= 0:
        return [], []
    try:
        timeout = max(1.0, min(8.0, float(os.getenv('QWEN_TESSERACT_FALLBACK_TIMEOUT_SECONDS', '3.0'))))
    except (TypeError, ValueError):
        timeout = 3.0
    try:
        max_edge = max(600, min(2400, int(os.getenv('QWEN_TESSERACT_FALLBACK_MAX_EDGE', '1600'))))
    except (TypeError, ValueError):
        max_edge = 1600
    lang = os.getenv('QWEN_TESSERACT_FALLBACK_LANG', 'rus+eng').strip() or 'eng'
    try:
        import pytesseract
        from pytesseract import Output
    except Exception as error:
        unavailable = [{'tile': item.get('tile'), 'status': 'unavailable', 'error': type(error).__name__} for item in failed[:max_tiles]]
        return [], unavailable

    recovered: list[dict[str, Any]] = []
    diagnostics: list[dict[str, Any]] = []
    for tile_diag in failed[:max_tiles]:
        tile_index = int(tile_diag.get('tile', 0) or 0)
        coords = tile_diag.get('source_crop_xyxy')
        diag: dict[str, Any] = {'tile': tile_index, 'status': 'started'}
        try:
            if not isinstance(coords, (list, tuple)) or len(coords) != 4:
                raise ValueError('missing_source_crop_coordinates')
            left, top, right, bottom = (int(value) for value in coords)
            left, top = max(0, left), max(0, top)
            right, bottom = min(original.width, right), min(original.height, bottom)
            if right - left < 12 or bottom - top < 12:
                raise ValueError('failed_tile_crop_is_too_small')
            crop = original.crop((left, top, right, bottom)).convert('RGB')
            requested_scale = min(2.0, max_edge / max(crop.size))
            scale = requested_scale if abs(requested_scale - 1.0) > 0.001 else 1.0
            if scale != 1.0:
                crop = crop.resize((max(1, round(crop.width * scale)), max(1, round(crop.height * scale))), Image.Resampling.LANCZOS)
            data = pytesseract.image_to_data(crop, lang=lang, config='--oem 1 --psm 11', output_type=Output.DICT, timeout=timeout)
            accepted = 0
            for raw_text, raw_conf, raw_x, raw_y, raw_w, raw_h in zip(
                data.get('text', []),
                data.get('conf', []),
                data.get('left', []),
                data.get('top', []),
                data.get('width', []),
                data.get('height', []),
            ):
                text_value = re.sub(r'\s+', ' ', str(raw_text or '')).strip()
                try:
                    confidence = float(raw_conf)
                    x, y, bw, bh = (int(round(float(value) / scale)) for value in (raw_x, raw_y, raw_w, raw_h))
                except (TypeError, ValueError, OverflowError):
                    continue
                has_alnum = bool(re.search(r'[A-Za-zА-Яа-я0-9ØøΦφДдУу]', text_value))
                if not text_value or len(text_value) > 180 or confidence < 20 or not has_alnum:
                    continue
                if bw < 2 or bh < 2 or x < -2 or y < -2:
                    continue
                x = max(0, min(original.width - left - 1, x))
                y = max(0, min(original.height - top - 1, y))
                bw = max(0, min(right - left - x, bw))
                bh = max(0, min(bottom - top - y, bh))
                if bw < 2 or bh < 2:
                    continue
                recovered.append(
                    {
                        'id': f'TF{tile_index}_{len(recovered) + 1}',
                        'text': text_value,
                        'confidence': round(max(0.0, min(100.0, confidence)), 1),
                        'bbox': {'x': left + x, 'y': top + y, 'w': bw, 'h': bh},
                        # Tesseract confidence is useful for sorting, not proof of a
                        # correct engineering transcription. Always require operator review.
                        'verified': False,
                        'include': False,
                        'verification_required': True,
                        'geometry_exclude': confidence >= 25,
                        'source': 'tesseract-tile',
                        'tile': tile_index,
                        'coordinate_space': 'source_image_px',
                    }
                )
                accepted += 1
            diag.update(
                {'status': 'completed', 'annotations': accepted, 'crop_xyxy': [left, top, right, bottom], 'scale': round(float(scale), 4)}
            )
        except Exception as error:
            diag.update({'status': 'failed', 'annotations': 0, 'error': (str(error).strip() or type(error).__name__)[:180]})
        diagnostics.append(diag)
        _progress(
            'OCR', f'Tesseract fallback for failed Qwen tile {tile_index}: {diag.get("status")}; annotations={diag.get("annotations", 0)}'
        )
    return recovered, diagnostics


def _qwen_annotations(
    image_path: str, original_width: int, original_height: int, checkpoint_dir: str | Path | None = None
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """OCR handwriting in overlapping enlarged tiles; keep low-confidence boxes as geometry masks."""
    url = os.getenv('OLLAMA_CHAT_URL', 'http://127.0.0.1:11434/api/chat').strip()
    model = os.getenv('QWEN_MODEL', 'qwen3-vl:4b-instruct').strip()
    calls_ok = 0
    errors: list[str] = []
    try:
        max_edge = max(1024, int(os.getenv('QWEN_MAX_IMAGE_EDGE', '1280')))
        timeout = max(20.0, min(180.0, float(os.getenv('QWEN_OCR_TIMEOUT', '105'))))
        max_output_tokens = max(384, min(2048, int(os.getenv('QWEN_OCR_MAX_TOKENS', '1024'))))
        retry_budget_per_tile = max(0, min(2, int(os.getenv('QWEN_TILE_RETRY_BUDGET', '0'))))
        image_sha256 = _sha256_file(image_path)
        upscale = max(1.0, min(2.5, float(os.getenv('QWEN_OCR_UPSCALE', '1.25'))))
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
        grid = max(1, min(2, int(os.getenv('QWEN_OCR_TILE_GRID', '2'))))
        if original_width < 720 or original_height < 520:
            grid = 1
        tile_w = max(1, int(round(original_width / grid)))
        tile_h = max(1, int(round(original_height / grid)))
        overlap = 0.12
        xs = sorted(
            set(
                [0] + [max(0, original_width - tile_w)]
                if grid == 2
                else [round(i * (original_width - tile_w) / max(1, grid - 1)) for i in range(grid)]
            )
        )
        ys = sorted(
            set(
                [0] + [max(0, original_height - tile_h)]
                if grid == 2
                else [round(i * (original_height - tile_h) / max(1, grid - 1)) for i in range(grid)]
            )
        )
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
                crop = crop.resize(
                    (max(1, round(crop.width * crop_scale)), max(1, round(crop.height * crop_scale))), Image.Resampling.LANCZOS
                )
            sent_scale = min(1.0, max_edge / max(crop.size))
            prompt_width = max(1, round(crop.width * sent_scale))
            prompt_height = max(1, round(crop.height * sent_scale))
            prompt = prompt_template.replace('{width}', str(prompt_width)).replace('{height}', str(prompt_height))
            call_diagnostics: dict[str, Any] = {
                'tile': tile_index,
                'crop_size': list(crop.size),
                'source_crop_xyxy': [int(left), int(top), int(right), int(bottom)],
            }
            checkpoint_settings = {
                'prompt_version': 3,
                'model': model,
                'grid': grid,
                'region': [int(left), int(top), int(right), int(bottom)],
                'crop_scale': round(float(crop_scale), 6),
                'max_edge': max_edge,
                'max_output_tokens': max_output_tokens,
                'upscale': upscale,
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
                call_diagnostics.update(
                    {
                        'tile_status': 'deferred',
                        'error': 'Отложено: оставлено время для рукописного OCR, Tesseract и экспорта частичного результата.',
                        'attempts': 0,
                        'deferred_for_job_deadline': True,
                    }
                )
                tile_diagnostics.append(call_diagnostics)
                tile_errors.append(f'плитка {tile_index} отложена до следующего запуска')
                _progress('OCR', f'Tile {tile_index}/{len(regions)} deferred to preserve time for OCR post-processing and graph export')
                continue
            tile_retry_state = {'remaining': retry_budget_per_tile}
            tile_item_start = len(items)
            try:
                parsed, resize_scale, sent_size = _qwen_call_with_retry(
                    crop,
                    prompt,
                    url=url,
                    model=model,
                    timeout=timeout,
                    max_edge=max_edge,
                    num_predict=max_output_tokens,
                    diagnostics=call_diagnostics,
                    format_schema=OCR_RESPONSE_SCHEMA,
                    retry_state=tile_retry_state,
                    stage='OCR',
                    tile_index=tile_index,
                )
                coordinate_scale = crop_scale * resize_scale
                sent_width, sent_height = sent_size
                call_diagnostics.update(
                    {
                        'source_crop_xyxy': [int(left), int(top), int(right), int(bottom)],
                        'crop_upscale': round(float(crop_scale), 6),
                        'request_resize_scale': round(float(resize_scale), 6),
                        'sent_size': [int(sent_width), int(sent_height)],
                        'bbox_coordinate_space': 'sent_tile_pixels_mapped_to_source_image_pixels',
                    }
                )
                raw_items, annotation_key = _annotation_items_from_response(parsed)
                if annotation_key is None:
                    raise ValueError('Qwen OCR ответ не содержит массива annotations.')
                call_diagnostics['annotation_key'] = annotation_key
                call_diagnostics['raw_annotations'] = len(raw_items)
                call_diagnostics['possibly_capped_at_schema_limit'] = len(raw_items) >= 64
                call_diagnostics['raw_annotation_samples'] = []
                call_diagnostics['rejected_out_of_crop_samples'] = []
                call_diagnostics['rejected_invalid_bbox'] = 0
                call_diagnostics['missing_confidence'] = 0
                accepted_before = len(items)
                for raw in raw_items:
                    if not isinstance(raw, dict):
                        continue
                    text_value = raw.get('text', raw.get('value', raw.get('label', raw.get('content', ''))))
                    text = re.sub(r'\s+', ' ', str(text_value)).strip()
                    bbox = raw.get('bbox') or raw.get('box') or raw.get('bbox_2d') or raw.get('box_2d')
                    try:
                        if isinstance(bbox, (list, tuple)) and len(bbox) == 4:
                            x1, y1, x2, y2 = map(float, bbox)
                            box = {'x': x1, 'y': y1, 'w': x2 - x1, 'h': y2 - y1}
                        elif isinstance(bbox, dict):
                            box = {key: float(bbox[key]) for key in ('x', 'y', 'w', 'h')}
                        else:
                            raise ValueError('missing_or_malformed_bbox')
                    except (KeyError, TypeError, ValueError, OverflowError):
                        call_diagnostics['rejected_invalid_bbox'] = int(call_diagnostics.get('rejected_invalid_bbox', 0)) + 1
                        continue
                    if len(call_diagnostics['raw_annotation_samples']) < 8:
                        call_diagnostics['raw_annotation_samples'].append(
                            {
                                'text': text[:120],
                                'bbox': bbox,
                                'confidence': raw.get('confidence', raw.get('score')),
                            }
                        )
                    # Reject model boxes that are clearly outside the crop it saw.
                    # Small excursions are clipped below; grossly invalid boxes
                    # are not allowed to migrate into the centre of the source page.
                    raw_left, raw_top = float(box['x']), float(box['y'])
                    raw_right = raw_left + float(box['w'])
                    raw_bottom = raw_top + float(box['h'])
                    if (
                        not all(math.isfinite(value) for value in (raw_left, raw_top, raw_right, raw_bottom))
                        or raw_right <= raw_left
                        or raw_bottom <= raw_top
                        or raw_right <= 0
                        or raw_bottom <= 0
                        or raw_left >= sent_width * 1.08
                        or raw_top >= sent_height * 1.08
                        or raw_left < -sent_width * 0.08
                        or raw_top < -sent_height * 0.08
                    ):
                        call_diagnostics['rejected_out_of_crop_boxes'] = int(call_diagnostics.get('rejected_out_of_crop_boxes', 0)) + 1
                        if len(call_diagnostics['rejected_out_of_crop_samples']) < 8:
                            call_diagnostics['rejected_out_of_crop_samples'].append(
                                {
                                    'text': text[:120],
                                    'bbox': bbox,
                                    'sent_size': [int(sent_width), int(sent_height)],
                                }
                            )
                        continue
                    box['x'] = max(0.0, min(float(sent_width), raw_left))
                    box['y'] = max(0.0, min(float(sent_height), raw_top))
                    box['w'] = max(0.0, min(float(sent_width) - box['x'], raw_right - box['x']))
                    box['h'] = max(0.0, min(float(sent_height) - box['y'], raw_bottom - box['y']))
                    confidence_value = raw.get('confidence', raw.get('score'))
                    if confidence_value is None:
                        call_diagnostics['missing_confidence'] = int(call_diagnostics.get('missing_confidence', 0)) + 1
                    try:
                        confidence = float(confidence_value) if confidence_value is not None else 0.0
                    except (TypeError, ValueError, OverflowError):
                        confidence = 0.0
                    if not math.isfinite(confidence):
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
                    items.append(
                        {
                            'id': f'Q{len(items) + 1}',
                            'text': text,
                            'confidence': round(max(0.0, min(100.0, confidence)), 1),
                            'bbox': {'x': x, 'y': y, 'w': bw, 'h': bh},
                            'verified': accepted,
                            'include': accepted,
                            'geometry_exclude': geometry_exclude,
                            'source': 'qwen3-vl',
                            'tile': tile_index,
                            'coordinate_space': 'source_image_px',
                            'source_tile_xyxy': [int(left), int(top), int(right), int(bottom)],
                        }
                    )
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

        tile_fallback_items, tile_fallback_diagnostics = _tesseract_failed_ocr_tiles(original, tile_diagnostics)
        if tile_fallback_items:
            items.extend(tile_fallback_items)
        for tile_diag in tile_diagnostics:
            matching = next((item for item in tile_fallback_diagnostics if item.get('tile') == tile_diag.get('tile')), None)
            if matching is not None:
                tile_diag['tesseract_fallback'] = matching
        _progress(
            'OCR',
            f'Tesseract recovered {len(tile_fallback_items)} review annotations from {len(tile_fallback_diagnostics)} failed Qwen tiles; Qwen completeness is unchanged',
        )

        # A second, line-oriented OCR pass reads dense handwritten note blocks
        # as whole rows instead of independent glyph boxes. This is especially
        # useful for the numbered handwritten list at the right of the drawing.
        block_tokens = max(768, min(2048, int(os.getenv('QWEN_OCR_BLOCK_MAX_TOKENS', '1536'))))
        block_pass_deferred = calls_ok != len(regions)
        if not block_pass_deferred and calls_ok > 0:
            _progress('OCR', 'Handwritten note OCR pass started after full tile coverage')
            block_items, block_diagnostics = _run_handwritten_block_ocr(
                original, items, url=url, model=model, timeout=timeout, max_edge=max_edge, max_tokens=block_tokens
            )
            _progress(
                'OCR',
                f'Handwritten note OCR pass completed; blocks={len(block_diagnostics)} rows={sum(int(item.get("rows_returned", 0) or 0) for item in block_diagnostics)}',
            )
        else:
            block_items, block_diagnostics = [], []
            _progress('OCR', 'Handwritten note OCR pass deferred until all OCR tiles are complete')
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
                    float(ob.get('x', 0)) >= bb['x'] - 3
                    and float(ob.get('y', 0)) >= bb['y'] - 3
                    and float(ob.get('x', 0)) + float(ob.get('w', 0)) <= bb['x'] + bb['w'] + 3
                    and float(ob.get('y', 0)) + float(ob.get('h', 0)) <= bb['y'] + bb['h'] + 3
                )
                if inside and old_area < block_area * 0.62:
                    continue
                kept_items.append(old_item)
            items = kept_items
            items.append(block_item)

        # Deduplicate boxes repeated in overlapping seams. Preserve native Qwen
        # wording over supplemental Tesseract text when boxes substantially overlap.
        items.sort(
            key=lambda item: (
                0 if item.get('source') in {'qwen3-vl', 'qwen3-vl-block'} else 1,
                -float(item.get('confidence', 0) or 0),
            )
        )
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
        failed_tiles = [
            int(item.get('tile', 0)) for item in tile_diagnostics if item.get('tile_status') not in {'completed', 'completed_empty'}
        ]
        complete = calls_ok == len(regions)
        return deduped, {
            'available': calls_ok > 0,
            'complete': complete,
            'model': model,
            'annotations': len(deduped),
            'tiles': len(regions),
            'successful_tiles': calls_ok,
            'failed_tiles': failed_tiles,
            'tiles_with_annotations': sum(1 for item in tile_diagnostics if item.get('accepted_annotations', 0) > 0),
            'truncated_tiles': sum(1 for item in tile_diagnostics if item.get('truncated')),
            'tile_diagnostics': tile_diagnostics,
            'block_passes': len(block_diagnostics),
            'block_diagnostics': block_diagnostics,
            'block_pass_deferred': bool(block_pass_deferred),
            'block_annotations': sum(1 for item in deduped if item.get('source') == 'qwen3-vl-block'),
            'native_qwen_annotations': sum(1 for item in deduped if item.get('source') in {'qwen3-vl', 'qwen3-vl-block'}),
            'tesseract_tile_fallback_annotations': sum(1 for item in deduped if item.get('source') == 'tesseract-tile'),
            'tesseract_tile_fallback_diagnostics': tile_fallback_diagnostics,
            'recognized_anything': bool(deduped),
            'empty_result': calls_ok > 0 and not deduped,
            'error': (
                '; '.join(tile_errors[:2])[:220]
                if tile_errors
                else (
                    (
                        'OCR-ответы достигли лимита токенов.'
                        if any(item.get('truncated') for item in tile_diagnostics)
                        else 'Все плитки обработаны, но Qwen не вернула распознанных надписей.'
                    )
                    if calls_ok > 0 and not deduped
                    else None
                )
            ),
            'incomplete_reason': (f'Не обработаны OCR-плитки: {failed_tiles}' if failed_tiles else None),
        }
    except Exception as error:
        reason = str(error).strip() or error.__class__.__name__
        return [], {
            'available': False,
            'complete': False,
            'model': model,
            'annotations': 0,
            'tiles': len(tile_diagnostics) if 'tile_diagnostics' in locals() else 0,
            'successful_tiles': calls_ok,
            'tile_diagnostics': tile_diagnostics if 'tile_diagnostics' in locals() else [],
            'error': reason[:220],
        }


def _semantic_error_hint(error: Exception, model: str) -> tuple[str, str]:
    """Return a user-facing diagnosis and a concrete corrective action."""
    message = str(error).strip() or error.__class__.__name__
    lower = message.lower()
    if (
        'urlopen error' in lower
        or 'connection refused' in lower
        or 'name or service not known' in lower
        or 'temporary failure in name resolution' in lower
    ):
        return (
            f'Не удаётся подключиться к Ollama: {message[:180]}',
            'Проверьте, что контейнер Ollama запущен и адрес OLLAMA_CHAT_URL доступен из контейнера приложения.',
        )
    if '404' in lower or 'not found' in lower or 'model' in lower and ('pull' in lower or 'missing' in lower):
        return (
            f'Модель {model} не найдена в Ollama: {message[:180]}',
            f'Выполните: docker compose exec ollama ollama pull {model} — затем перезапустите app.',
        )
    if 'timed out' in lower or 'timeout' in lower or 'time-out' in lower:
        return (
            f'Qwen не успел обработать изображение: {message[:180]}',
            'Успешные плитки сохраняются в .checkpoints. Повторите обработку того же задания: будут запрошены только неготовые плитки. Если тайм-ауты повторяются, проверьте журнал Ollama и фактическую загрузку GPU.',
        )
    if 'json' in lower or 'routes' in lower or 'полилини' in lower:
        return (
            f'Ollama ответила, но формат ответа Qwen не удалось разобрать: {message[:180]}',
            'Проверьте версию Ollama и тег QWEN_MODEL; в диагностике graph.json сохранена причина ответа.',
        )
    return (f'Ошибка Qwen/Ollama: {message[:200]}', 'Проверьте Ollama, доступность модели и журнал контейнера ollama.')


def _qwen_semantic_routes(
    image_path: str, original_width: int, original_height: int, checkpoint_dir: str | Path | None = None
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Trace pipe centre-lines tile-by-tile so a small model does not need to parse a full sheet at once."""
    url = os.getenv('OLLAMA_CHAT_URL', 'http://127.0.0.1:11434/api/chat').strip()
    model = os.getenv('QWEN_MODEL', 'qwen3-vl:4b-instruct').strip()
    raw_count = rejected_low_confidence = rejected_invalid = 0
    rejected_out_of_bounds_routes = 0
    tile_diagnostics: list[dict[str, Any]] = []
    try:
        max_edge = max(1024, int(os.getenv('QWEN_PIPE_MAX_IMAGE_EDGE', '1280')))
        timeout = max(20.0, min(180.0, float(os.getenv('QWEN_PIPE_TRACE_TIMEOUT', '105'))))
        max_output_tokens = max(384, min(2048, int(os.getenv('QWEN_PIPE_MAX_TOKENS', '1024'))))
        retry_budget_per_tile = max(0, min(2, int(os.getenv('QWEN_TILE_RETRY_BUDGET', '0'))))
        image_sha256 = _sha256_file(image_path)
        grid = max(1, min(2, int(os.getenv('QWEN_PIPE_TILE_GRID', '2'))))
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
                    crop = crop.resize(
                        (max(1, round(crop.width * crop_scale)), max(1, round(crop.height * crop_scale))), Image.Resampling.LANCZOS
                    )
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
                    f'ВАЖНО: каждая координата ОБЯЗАНА находиться внутри изображения: 0<=x<{sent_width}, 0<=y<{sent_height}. '
                    'Не используй координаты исходного листа, миллиметры, проценты или координаты больше размера фрагмента. '
                    'Если путь нельзя уверенно описать координатами внутри этих границ, не возвращай его. '
                    'Пример: {"routes":[{"id":"S1","points":[[20,80],[180,80],[180,240]],"confidence":70}]}. '
                    'Верни только JSON без текста и без объяснений.'
                )
                diag: dict[str, Any] = {
                    'tile': tile_index,
                    'row': row + 1,
                    'column': col + 1,
                    'core': {'x': core_left, 'y': core_top, 'w': core_w, 'h': core_h},
                    'crop': {'x': left, 'y': top, 'w': right - left, 'h': bottom - top},
                    'sent_image': {'w': sent_width, 'h': sent_height},
                    'coordinate_contract': 'pixel coordinates strictly inside sent_image; out-of-bounds route is rejected',
                }
                checkpoint_settings = {
                    'prompt_version': 4,
                    'coordinate_contract': 'strict-sent-image-bounds-v1',
                    'model': model,
                    'grid': grid,
                    'core': [core_left, core_top, core_right, core_bottom],
                    'crop': [left, top, right, bottom],
                    'upscale': upscale,
                    'overlap': overlap,
                    'max_edge': max_edge,
                    'max_output_tokens': max_output_tokens,
                    'min_confidence': min_confidence,
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
                    diag.update(
                        {
                            'tile_status': 'deferred',
                            'error': 'Отложено: оставлено время для построения графа и экспорта частичного результата.',
                            'attempts': 0,
                            'deferred_for_job_deadline': True,
                        }
                    )
                    tile_diagnostics.append(diag)
                    _progress('PIPE', f'Tile {tile_index}/{total_tiles} deferred to preserve time for graph export')
                    continue
                tile_retry_state = {'remaining': retry_budget_per_tile}
                route_item_start = len(result)
                tile_raw_before = raw_count
                tile_low_before = rejected_low_confidence
                tile_invalid_before = rejected_invalid
                tile_oob_before = rejected_out_of_bounds_routes
                tile_oob_examples: list[dict[str, Any]] = []
                tile_oob_count = 0
                _progress('PIPE', f'Tile {tile_index}/{total_tiles} started')
                try:
                    parsed, resize_scale, sent_size = _qwen_call_with_retry(
                        crop,
                        prompt,
                        url=url,
                        model=model,
                        timeout=timeout,
                        max_edge=max_edge,
                        num_predict=max_output_tokens,
                        diagnostics=diag,
                        format_schema=PIPE_RESPONSE_SCHEMA,
                        retry_state=tile_retry_state,
                        stage='PIPE',
                        tile_index=tile_index,
                    )
                    sent_width, sent_height = int(sent_size[0]), int(sent_size[1])
                    diag['sent_image'] = {'w': sent_width, 'h': sent_height}
                    raw_routes = parsed.get(
                        'routes',
                        parsed.get(
                            'pipes', parsed.get('pipe_routes', parsed.get('polylines', parsed.get('paths', parsed.get('traces', []))))
                        ),
                    )
                    if not isinstance(raw_routes, list):
                        if isinstance(raw_routes, dict):
                            raw_routes = list(raw_routes.values())
                        else:
                            raise ValueError('Qwen вернул JSON, но поле routes имеет неверный тип.')
                    if raw_routes and all(
                        (isinstance(pt, (list, tuple)) and len(pt) >= 2 and all(isinstance(v, (int, float)) for v in pt[:2]))
                        or (isinstance(pt, dict) and 'x' in pt and 'y' in pt)
                        for pt in raw_routes
                    ):
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
                        # Qwen is explicitly asked for coordinates in the exact image
                        # dimensions sent to Ollama. Never clamp wildly invalid model
                        # coordinates to the page edge: doing so turns hallucinated
                        # points such as y=4800 on a 480px tile into fake border pipes.
                        local_points: list[list[float]] = []
                        route_coordinate_error: str | None = None
                        route_min_x = route_min_y = float('inf')
                        route_max_x = route_max_y = float('-inf')
                        for point_index, pt in enumerate(points_raw[:64], 1):
                            try:
                                if isinstance(pt, dict):
                                    px, py = float(pt.get('x')), float(pt.get('y'))
                                elif isinstance(pt, (list, tuple)) and len(pt) >= 2:
                                    px, py = float(pt[0]), float(pt[1])
                                else:
                                    route_coordinate_error = 'invalid-point-shape'
                                    break
                            except (TypeError, ValueError):
                                route_coordinate_error = 'non-numeric-point'
                                break
                            if not math.isfinite(px) or not math.isfinite(py):
                                route_coordinate_error = 'non-finite-coordinate'
                                break
                            route_min_x, route_max_x = min(route_min_x, px), max(route_max_x, px)
                            route_min_y, route_max_y = min(route_min_y, py), max(route_max_y, py)
                            # Allow only tiny rounding noise (2px). Meaningful
                            # out-of-frame coordinates invalidate the entire route.
                            if px < -2.0 or py < -2.0 or px > sent_width + 2.0 or py > sent_height + 2.0:
                                route_coordinate_error = 'coordinate-out-of-sent-image-bounds'
                                break
                            px = max(0.0, min(float(sent_width - 1), px))
                            py = max(0.0, min(float(sent_height - 1), py))
                            if not local_points or math.dist(local_points[-1], [px, py]) >= 2.0:
                                local_points.append([px, py])
                        if route_coordinate_error:
                            rejected_invalid += 1
                            if route_coordinate_error == 'coordinate-out-of-sent-image-bounds':
                                rejected_out_of_bounds_routes += 1
                                tile_oob_count += 1
                                if len(tile_oob_examples) < 5:
                                    tile_oob_examples.append(
                                        {
                                            'route': str(raw.get('id') or raw_index)[:32],
                                            'point_index': point_index,
                                            'x_range': [round(route_min_x, 1), round(route_max_x, 1)]
                                            if math.isfinite(route_min_x)
                                            else None,
                                            'y_range': [round(route_min_y, 1), round(route_max_y, 1)]
                                            if math.isfinite(route_min_y)
                                            else None,
                                            'expected_bounds': {'x': [0, sent_width - 1], 'y': [0, sent_height - 1]},
                                        }
                                    )
                            continue
                        if len(local_points) < 2:
                            rejected_invalid += 1
                            continue
                        mapped: list[list[float]] = []
                        for px, py in local_points:
                            gx, gy = left + px / coordinate_scale, top + py / coordinate_scale
                            # The local bounds check above should guarantee page
                            # bounds too. Keep a defensive check; only tolerate
                            # one-pixel arithmetic noise instead of edge-clamping.
                            if gx < -1.0 or gy < -1.0 or gx > original_width or gy > original_height:
                                route_coordinate_error = 'mapped-coordinate-out-of-page-bounds'
                                break
                            gx = max(0.0, min(float(original_width - 1), gx))
                            gy = max(0.0, min(float(original_height - 1), gy))
                            if not mapped or math.dist(mapped[-1], [gx, gy]) >= 2.0:
                                mapped.append([gx, gy])
                        if route_coordinate_error or len(mapped) < 2:
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
                            result.append(
                                {
                                    'id': f'T{tile_index}-{str(raw.get("id") or raw_index)[:16]}-{fragment_no}',
                                    'points': [[round(p[0], 1), round(p[1], 1)] for p in points],
                                    'confidence': round(max(0.0, min(100.0, confidence)), 1),
                                    'confidence_assumed': not confidence_supplied,
                                    'needs_review': confidence < 60,
                                    'source': 'qwen3-vl-semantic-tiled',
                                    'tile': tile_index,
                                    'include': True,
                                }
                            )
                    tile_routes = result[route_item_start:]
                    diag['accepted_routes'] = len(tile_routes)
                    diag['rejected_out_of_bounds_routes'] = tile_oob_count
                    if tile_oob_examples:
                        diag['out_of_bounds_route_examples'] = tile_oob_examples
                    diag['tile_status'] = 'ok'
                    _save_tile_checkpoint(checkpoint_dir, 'pipe', tile_index, checkpoint_signature, tile_routes, diag)
                except Exception as error:
                    del result[route_item_start:]
                    raw_count = tile_raw_before
                    rejected_low_confidence = tile_low_before
                    rejected_invalid = tile_invalid_before
                    rejected_out_of_bounds_routes = tile_oob_before
                    diag['tile_status'] = 'error'
                    diag['error'] = (str(error).strip() or error.__class__.__name__)[:180]
                    diag['attempts'] = int(diag.get('attempts', 1) or 1)
                tile_diagnostics.append(diag)
                if diag.get('tile_status') == 'ok':
                    _progress('PIPE', f'Tile {tile_index}/{total_tiles} completed; routes={diag.get("accepted_routes", 0)}')
                    if tile_oob_count:
                        _progress(
                            'PIPE',
                            f'Tile {tile_index}: rejected {tile_oob_count} route(s) with coordinates outside sent image {sent_width}x{sent_height}',
                        )
                else:
                    _progress('PIPE', f'Tile {tile_index}/{total_tiles} failed: {diag.get("error", "unknown error")}')

        successful_tiles = sum(1 for item in tile_diagnostics if item.get('tile_status') == 'ok')
        failed_tiles = [int(item.get('tile', 0)) for item in tile_diagnostics if item.get('tile_status') != 'ok']
        complete = successful_tiles == total_tiles
        status = {
            'available': successful_tiles > 0,
            'complete': complete,
            'model': model,
            'routes': len(result),
            'raw_routes': raw_count,
            'rejected_low_confidence': rejected_low_confidence,
            'rejected_invalid': rejected_invalid,
            'rejected_out_of_bounds_routes': rejected_out_of_bounds_routes,
            'tiles': total_tiles,
            'successful_tiles': successful_tiles,
            'failed_tiles': failed_tiles,
            'truncated_tiles': sum(1 for item in tile_diagnostics if item.get('truncated')),
            'tile_diagnostics': tile_diagnostics,
            'error': None,
            'hint': None,
            'image_size': {'width': original_width, 'height': original_height},
            'strategy': 'strictly bounded overlapping semantic tiles clipped to non-overlapping cores',
            'coordinate_contract': 'all Qwen points must be inside each tile sent to Ollama; invalid routes are rejected, never clamped to page borders',
            'incomplete_reason': (f'Не обработаны PIPE-плитки: {failed_tiles}' if failed_tiles else None),
        }
        if not result:
            if successful_tiles == 0 and tile_diagnostics:
                first_error = next(
                    (item.get('error') for item in tile_diagnostics if item.get('error')), 'Не удалось получить ответ от Ollama.'
                )
                message, hint = _semantic_error_hint(RuntimeError(first_error), model)
                status['error'] = message[:260]
                status['hint'] = hint[:260]
            elif raw_count == 0 and successful_tiles:
                status['error'] = (
                    f'Qwen успешно обработала {successful_tiles}/{len(tile_diagnostics)} фрагментов, но вернула пустой список маршрутов.'
                )
                status['hint'] = (
                    'Промпт теперь запрашивает отдельные прямые отрезки, а не сложные полилинии. Если routes снова пусты, Qwen не распознаёт геометрию даже на уровне сегментов: нужно менять модель/визуальную предобработку, а не порог confidence.'
                )
            elif rejected_out_of_bounds_routes:
                status['error'] = (
                    f'Qwen вернул {raw_count} маршрутов; {rejected_out_of_bounds_routes} отброшены из-за координат за пределами изображений фрагментов.'
                )
                status['hint'] = (
                    'Это предотвращает превращение невозможных координат (например, y=4800 на фрагменте высотой 480 px) в линии по краям страницы. Проверьте out_of_bounds_route_examples в semanticTrace.tile_diagnostics.'
                )
            elif rejected_low_confidence:
                status['error'] = f'Qwen вернул маршруты, но все ниже порога уверенности {min_confidence:g}%. '
                status['hint'] = 'Проверьте координаты и confidence каждого фрагмента.'
            else:
                status['error'] = f'Qwen вернул {raw_count} элементов, но они не прошли проверку координат, границ фрагмента или длины.'
                status['hint'] = 'Откройте semanticTrace.tile_diagnostics и проверьте координаты каждого фрагмента.'
        return result, status
    except Exception as error:
        message, hint = _semantic_error_hint(error, model)
        return [], {
            'available': False,
            'complete': False,
            'model': model,
            'routes': 0,
            'raw_routes': raw_count,
            'rejected_low_confidence': rejected_low_confidence,
            'rejected_invalid': rejected_invalid,
            'tiles': len(tile_diagnostics),
            'successful_tiles': sum(1 for item in tile_diagnostics if item.get('tile_status') == 'ok'),
            'tile_diagnostics': tile_diagnostics,
            'error': message[:260],
            'hint': hint[:260],
        }


def _boxes_overlap(a: dict[str, Any], b: dict[str, Any]) -> float:
    ax, ay, aw, ah = (float(a.get(k, 0)) for k in ('x', 'y', 'w', 'h'))
    bx, by, bw, bh = (float(b.get(k, 0)) for k in ('x', 'y', 'w', 'h'))
    ix = max(0.0, min(ax + aw, bx + bw) - max(ax, bx))
    iy = max(0.0, min(ay + ah, by + bh) - max(ay, by))
    intersection = ix * iy
    union = aw * ah + bw * bh - intersection
    return intersection / union if union > 0 else 0.0


def ocr_annotations(
    image_path: str, gray: np.ndarray, checkpoint_dir: str | Path | None = None
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Run local Qwen OCR first and Tesseract as a complementary local OCR channel.

    Cloud providers are deliberately not part of the normal reconstruction path.
    This keeps drawings on the customer's server and makes OCR behaviour repeatable.
    """
    h, w = gray.shape[:2]
    qwen_items: list[dict[str, Any]] = []
    qwen_status: dict[str, Any] = {
        'available': False,
        'complete': False,
        'skipped': False,
        'model': os.getenv('QWEN_MODEL', 'qwen3-vl:4b-instruct'),
        'provider': 'ollama-qwen',
        'annotations': 0,
        'tiles': 0,
        'successful_tiles': 0,
        'failed_tiles': [],
    }

    _progress('OCR', f'Local Qwen3-VL OCR started: {qwen_status["model"]}')
    try:
        qwen_items, qwen_status = _qwen_annotations(image_path, w, h, checkpoint_dir=checkpoint_dir)
        qwen_status.setdefault('provider', 'ollama-qwen')
        _progress('OCR', f'Local Qwen3-VL OCR completed: annotations={len(qwen_items)}')
    except Exception as error:
        qwen_status.update(
            {
                'available': False,
                'complete': False,
                'error': str(error)[:260],
                'tiles': max(1, int(qwen_status.get('tiles') or 1)),
                'successful_tiles': 0,
            }
        )
        _progress('OCR', f'Local Qwen3-VL OCR failed; Tesseract will still run: {str(error)[:220]}')

    tesseract_items: list[dict[str, Any]] = []
    tesseract_error = None
    tesseract_languages: list[str] = []
    _progress('OCR', 'Local Tesseract OCR started (rus+eng)')
    try:
        import pytesseract
        from pytesseract import Output

        tesseract_languages = list(pytesseract.get_languages(config=''))
        if not {'rus', 'eng'}.issubset(set(tesseract_languages)):
            raise RuntimeError('Не установлены языки Tesseract rus и eng.')
        data = pytesseract.image_to_data(Image.fromarray(gray), lang='rus+eng', config='--oem 1 --psm 11', output_type=Output.DICT)
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
            if any(_boxes_overlap(box, item.get('bbox') or {}) >= 0.22 for item in qwen_items):
                continue
            has_alnum = bool(re.search(r'[A-Za-zА-Яа-я0-9ØøΦφДдУу]', text))
            accepted = confidence >= 68 and has_alnum
            tesseract_items.append(
                {
                    'id': f'T{len(tesseract_items) + 1}',
                    'text': text,
                    'confidence': round(confidence, 1),
                    'bbox': box,
                    'verified': accepted,
                    'include': accepted,
                    'geometry_exclude': confidence >= 20 and has_alnum,
                    'source': 'tesseract',
                }
            )
    except Exception as error:
        tesseract_error = str(error)[:180]
        _progress('OCR', f'Tesseract OCR unavailable: {tesseract_error}')

    _progress('OCR', f'Tesseract OCR completed: annotations={len(tesseract_items)}')
    items = qwen_items + tesseract_items
    for index, item in enumerate(items, 1):
        item['id'] = f'A{index}'
    status = {
        'provider': 'local-qwen+tesseract',
        'qwen': qwen_status,
        'moss': {
            'available': False,
            'complete': False,
            'disabled': True,
            'provider': 'moss',
            'annotations': 0,
            'tiles': 0,
            'skip_reason': 'Cloud OCR отключён: используется локальный режим Qwen + Tesseract.',
        },
        'openrouter': {
            'available': False,
            'complete': False,
            'disabled': True,
            'provider': 'openrouter',
            'annotations': 0,
            'tiles': 0,
            'skip_reason': 'Cloud OCR отключён: используется локальный режим Qwen + Tesseract.',
        },
        'tesseract': {
            'available': tesseract_error is None,
            'complete': tesseract_error is None,
            'annotations': len(tesseract_items),
            'languages': tesseract_languages,
            'error': tesseract_error,
        },
    }
    return items, status


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


def analyze(input_path: str, out_dir: str, template_path: str | None = None, rotation_degrees: int | None = None) -> dict[str, Any]:
    job_started = time.perf_counter()
    configured_job_ms = max(60_000.0, float(os.getenv('PYTHON_JOB_TIMEOUT_MS', '5400000')))
    set_analysis_hard_deadline(time.monotonic() + configured_job_ms / 1000.0)
    timings_ms: dict[str, float] = {}
    Path(out_dir).mkdir(parents=True, exist_ok=True)
    _progress('JOB', 'Image preprocessing started')
    stage_started = time.perf_counter()
    source_bgr = load_image(input_path)
    bgr, preparation = prepare_document_image(source_bgr, rotation_degrees=rotation_degrees)
    h, w = bgr.shape[:2]
    prepared_input_path = str(Path(out_dir) / 'prepared-input.png')
    cv2.imwrite(prepared_input_path, bgr)
    gray, prep = normalize_document(bgr)
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
    _progress(
        'OCR',
        f'OCR pipeline completed: annotations={len(annotations)}; local Qwen={ocr_status.get("qwen", {}).get("successful_tiles", 0)}/{ocr_status.get("qwen", {}).get("tiles", 0)}; Tesseract={ocr_status.get("tesseract", {}).get("annotations", 0)}; {timings_ms["ocr"]:.1f} ms',
    )
    qwen_ocr_complete = _qwen_stage_is_complete(ocr_status.get('qwen'))
    # OCR and pipe tracing are independent vision tasks. A missing OCR tile
    # must never suppress the geometry pass: Tesseract and OpenCV remain useful
    # even when the local VL model times out on handwriting.
    tesseract_available = bool(ocr_status.get('tesseract', {}).get('available'))
    ocr_complete = qwen_ocr_complete or tesseract_available
    moss_pipe_status: dict[str, Any] | None = None
    openrouter_pipe_enabled = False
    openrouter_pipe_status: dict[str, Any] | None = None
    stage_started = time.perf_counter()
    _progress('PIPE', 'Local Ollama Qwen pipe-route trace started independently of OCR completeness')
    semantic_routes, route_status = _qwen_semantic_routes(prepared_input_path, w, h, checkpoint_dir=checkpoint_dir)
    route_status['provider'] = 'ollama-qwen'
    route_status['cloud_providers_disabled'] = True
    _progress(
        'PIPE',
        f'Local Qwen pipe-route trace completed: routes={len(semantic_routes)}; tiles={route_status.get("successful_tiles", 0)}/{route_status.get("tiles", 0)}',
    )
    timings_ms['semantic_pipe_trace'] = round((time.perf_counter() - stage_started) * 1000.0, 1)
    timings_ms['qwen_pipe_trace'] = timings_ms['semantic_pipe_trace']
    pipe_complete = _qwen_stage_is_complete(route_status) and bool(semantic_routes)
    processing_complete = qwen_ocr_complete and pipe_complete
    incomplete_reasons = []
    if not qwen_ocr_complete:
        provider_status = ocr_status.get('qwen', {})
        if provider_status.get('error') or provider_status.get('incomplete_reason'):
            incomplete_reasons.append(
                'локальный Qwen OCR: ' + str(provider_status.get('incomplete_reason') or provider_status.get('error'))[:240]
            )
        if not incomplete_reasons:
            incomplete_reasons.append('Локальный Qwen OCR не завершил полный проход.')
    if not pipe_complete:
        incomplete_reasons.append(
            route_status.get('incomplete_reason') or route_status.get('error') or 'Трассировка труб не обработала все необходимые участки.'
        )
    if processing_complete:
        _progress(
            'JOB', f'Analysis completed; OCR provider=local Qwen + Tesseract; PIPE provider={route_status.get("provider", "local Qwen")}'
        )
    else:
        active_ocr_status = ocr_status.get('qwen', {})
        _progress(
            'JOB',
            f'Analysis incomplete; OCR provider={active_ocr_status.get("provider", "local Qwen")}; OCR={active_ocr_status.get("successful_tiles", 0)}/{active_ocr_status.get("tiles", 0)}; PIPE={route_status.get("successful_tiles", 0)}/{route_status.get("tiles", 0)}; checkpoints saved for retry',
        )
    _progress('CAD', 'Graph construction started')
    stage_started = time.perf_counter()
    # The selected OpenCV graph remains the detector backbone. Only Qwen routes
    # that pass source-ink and OCR-mask validation are added as complementary
    # primary CAD geometry; sparse or invalid model output cannot erase OpenCV.
    segments = extract_segments(gray, ink, annotations)
    text_mask = _text_region_mask(gray.shape[:2], annotations)
    segments, t_junction_diagnostics = split_segments_at_endpoint_junctions(
        segments,
        ink,
        text_mask,
        max_distance_px=float(os.getenv('T_JUNCTION_MAX_GAP_PX', '3.5')),
        minimum_branch_length_px=float(os.getenv('T_JUNCTION_MIN_BRANCH_PX', '14')),
    )
    nodes, edges, components = endpoint_clusters(segments, ink=ink, text_mask=text_mask)
    ink_color_diagnostics = _annotate_edge_ink_color(edges, ink_layers['blue'], ink_layers['dark'])
    cad_selection = select_primary_cad_edges(nodes, edges, min(w, h), image_size=(w, h))
    primary_opencv_edges = [edge for edge in edges if edge.get('cad_include')]
    primary_semantic_routes, semantic_validation = validate_primary_semantic_routes(
        semantic_routes, ink, text_mask, primary_opencv_edges, min(w, h)
    )
    # Legacy cloud fallback stays guarded off in local-only mode. Qwen proposals
    # are already the only semantic route source in the production path.
    if (
        not primary_semantic_routes
        and semantic_routes
        and (
            (route_status.get('provider') == 'moss' and moss_pipe_status and moss_pipe_status.get('available'))
            or (
                route_status.get('provider') == 'openrouter'
                and openrouter_pipe_enabled
                and openrouter_pipe_status
                and openrouter_pipe_status.get('available')
            )
        )
    ):
        rejected_provider = str(route_status.get('provider'))
        _progress('PIPE', f'{rejected_provider} routes did not pass source-ink validation; trying preserved local Qwen fallback')
        local_routes, local_status = _qwen_semantic_routes(prepared_input_path, w, h, checkpoint_dir=checkpoint_dir)
        if local_routes:
            semantic_routes = semantic_routes + local_routes
            local_status[f'{rejected_provider}_attempt'] = moss_pipe_status if rejected_provider == 'moss' else openrouter_pipe_status
            local_status['fallback_used'] = True
            local_status[f'{rejected_provider}_routes_rejected_by_ink_validation'] = len(semantic_routes) - len(local_routes)
            route_status = local_status
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
    crossings = detect_crossings(segments)
    ink_in_text_regions = cv2.bitwise_and(ink, text_mask)
    geometry_ink = cv2.bitwise_and(ink, cv2.bitwise_not(text_mask))
    timings_ms['opencv_geometry_and_topology'] = round((time.perf_counter() - stage_started) * 1000.0, 1)
    _progress(
        'CAD',
        f'Graph construction completed: segments={len(segments)} nodes={len(nodes)} edges={len(edges)} crossings={len(crossings)}; {timings_ms["opencv_geometry_and_topology"]:.1f} ms',
    )
    stage_started = time.perf_counter()

    # The candidate overlay remains available for audit; the primary overlay
    # makes it immediately visible what will actually enter PIPE_MAIN.
    overlay = bgr.copy()
    primary_overlay = bgr.copy()
    for segment in segments:
        col = (
            (155, 155, 155) if segment.get('ocr_overlap', 0) >= 0.16 else ((30, 130, 240) if segment['source'] == 'LSD' else (40, 180, 80))
        )
        cv2.line(overlay, (int(segment['x1']), int(segment['y1'])), (int(segment['x2']), int(segment['y2'])), col, 2, cv2.LINE_AA)
    edge_by_index = {int(edge.get('source_segment_index', -1)): edge for edge in edges}
    for segment_index, segment in enumerate(segments):
        edge = edge_by_index.get(segment_index)
        if edge and edge.get('cad_include'):
            color = (40, 190, 95)
            thickness = 3
        else:
            color = (150, 150, 150)
            thickness = 1
        cv2.line(
            primary_overlay,
            (int(segment['x1']), int(segment['y1'])),
            (int(segment['x2']), int(segment['y2'])),
            color,
            thickness,
            cv2.LINE_AA,
        )
    for route in primary_semantic_routes:
        pts = np.array([[int(round(p[0])), int(round(p[1]))] for p in route['points']], dtype=np.int32)
        if len(pts) >= 2:
            cv2.polylines(primary_overlay, [pts], False, (255, 170, 20), 3, cv2.LINE_AA)
    for node in nodes:
        if node['degree'] >= 3:
            cv2.circle(overlay, (int(node['x']), int(node['y'])), 4, (0, 0, 255), -1, cv2.LINE_AA)
    overlay_path = str(Path(out_dir) / 'overlay.png')
    cv2.imwrite(overlay_path, overlay)
    cv2.imwrite(str(Path(out_dir) / 'primary-overlay.png'), primary_overlay)
    cv2.imwrite(str(Path(out_dir) / 'text-region-mask.png'), text_mask)
    cv2.imwrite(str(Path(out_dir) / 'ink-without-text-boxes.png'), geometry_ink)
    cv2.imwrite(str(Path(out_dir) / 'ink-inside-text-boxes.png'), ink_in_text_regions)
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
        label = f'NOTE {block_index}: {diag.get("accepted_lines", 0)} rows'
        cv2.putText(note_overlay, label, (x1, max(18, y1 - 6)), cv2.FONT_HERSHEY_SIMPLEX, 0.48, (200, 40, 210), 1, cv2.LINE_AA)
        for row_diag in diag.get('row_diagnostics', []):
            row_box = row_diag.get('bbox') or {}
            try:
                rx, ry = int(row_box['x']), int(row_box['y'])
                rw, rh = int(row_box['w']), int(row_box['h'])
            except (KeyError, TypeError, ValueError):
                continue
            cv2.rectangle(note_overlay, (rx, ry), (rx + rw, ry + rh), (255, 145, 20), 1, cv2.LINE_AA)
            cv2.putText(
                note_overlay,
                str(row_diag.get('row', '?')),
                (rx, max(12, ry - 2)),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.34,
                (255, 145, 20),
                1,
                cv2.LINE_AA,
            )
    cv2.imwrite(str(Path(out_dir) / 'handwritten-text-blocks.png'), note_overlay)
    ink_path = str(Path(out_dir) / 'ink-mask.png')
    cv2.imwrite(ink_path, ink)
    cv2.imwrite(str(Path(out_dir) / 'blue-ink-mask.png'), ink_layers['blue'])
    cv2.imwrite(str(Path(out_dir) / 'dark-ink-mask.png'), ink_layers['dark'])
    cv2.imwrite(str(Path(out_dir) / 'faint-ink-mask.png'), ink_layers['faint'])
    # Preserve the original contour facsimile for exact ink-shape editing, but
    # also export a true one-pixel centreline version as open CAD polylines.
    # This avoids the thousands of closed contour loops that look like dots in
    # CAD viewers when a thin engineering drawing is imported.
    try:
        reference_trace = build_reference_trace(ink, source_name=Path(input_path).name)
        Path(out_dir, 'reference-trace.svg').write_text(reference_trace.svg, encoding='utf-8')
        Path(out_dir, 'reference-trace.dxf').write_text(reference_trace.dxf, encoding='utf-8')
        reference_trace_meta = {
            'available': True,
            'svg': 'reference-trace.svg',
            'dxf': 'reference-trace.dxf',
            'components': reference_trace.components,
            'contours': reference_trace.contours,
            'vertices': reference_trace.vertices,
            'pageWidthMm': reference_trace.page_width_mm,
            'pageHeightMm': reference_trace.page_height_mm,
            'semantic': False,
            'description': 'Source-faithful closed ink contours; not a verified pipe centre-line graph.',
        }
        _progress(
            'REFERENCE',
            f'Source contour trace exported: components={reference_trace.components}; contours={reference_trace.contours}; vertices={reference_trace.vertices}',
        )
    except Exception as trace_error:
        reference_trace_meta = {'available': False, 'error': str(trace_error)[:300], 'semantic': False}
        _progress('REFERENCE', f'Source contour trace failed: {str(trace_error)[:220]}')

    try:
        centerline_trace = build_centerline_trace(ink, source_name=Path(input_path).name)
        Path(out_dir, 'centerline-trace.svg').write_text(centerline_trace.svg, encoding='utf-8')
        Path(out_dir, 'centerline-trace.dxf').write_text(centerline_trace.dxf, encoding='utf-8')
        centerline_trace_meta = {
            'available': True,
            'svg': 'centerline-trace.svg',
            'dxf': 'centerline-trace.dxf',
            'components': centerline_trace.components,
            'paths': centerline_trace.paths,
            'vertices': centerline_trace.vertices,
            'skeletonPixels': centerline_trace.skeleton_pixels,
            'lengthPx': round(centerline_trace.length_px, 2),
            'pageWidthMm': centerline_trace.page_width_mm,
            'pageHeightMm': centerline_trace.page_height_mm,
            'semantic': False,
            'description': 'Open source-ink centerline polylines; faithful linework, not verified semantic pipe topology.',
        }
        _progress(
            'CENTERLINE',
            f'Open polylines exported: components={centerline_trace.components}; paths={centerline_trace.paths}; vertices={centerline_trace.vertices}; skeleton_pixels={centerline_trace.skeleton_pixels}',
        )
    except Exception as trace_error:
        centerline_trace_meta = {'available': False, 'error': str(trace_error)[:300], 'semantic': False}
        _progress('CENTERLINE', f'Open polyline tracing failed: {str(trace_error)[:220]}')
    _progress('EXPORT', 'SVG and DXF export started')
    svg = build_clean_svg(
        w,
        h,
        edges,
        annotations,
        semantic_routes=semantic_routes,
        semantic_status=route_status,
        primary_semantic_routes=primary_semantic_routes,
    )
    Path(out_dir, 'clean.svg').write_text(svg, encoding='utf-8')
    Path(out_dir, 'drawing.dxf').write_text(
        build_dxf(w, h, edges, annotations, semantic_routes=semantic_routes, primary_semantic_routes=primary_semantic_routes),
        encoding='utf-8',
    )
    _progress('EXPORT', 'SVG and DXF written')
    # Candidate joins are diagnostic only. The graph's ink-supported endpoint
    # clustering performs conservative auto-joins; this list must not invent
    # same-edge, endpoint-to-interior, or laterally displaced connections.
    joins = _build_join_candidates(nodes, edges, image_size=(w, h))
    _progress(
        'CAD',
        f'Endpoint continuation candidates: total={len(joins)} high={sum(1 for item in joins if item.get("priority") == "high")} review={sum(1 for item in joins if item.get("priority") != "high")}',
    )
    timings_ms['drawing_export_and_candidates'] = round((time.perf_counter() - stage_started) * 1000.0, 1)
    timings_ms['total_before_graph_json_write'] = round((time.perf_counter() - job_started) * 1000.0, 1)
    recognition_channels = split_recognition_channels(w, h, components, edges, annotations, ink_mask=ink)
    document_model = build_document_model(
        w, h, nodes, edges, annotations, crossings, joins, recognition_channels, semantic_routes=primary_semantic_routes
    )
    document_model, topology_diagnostics = attach_pipes_to_symbols(document_model)
    document_model, annotation_linking_diagnostics = link_annotations(document_model)
    document_model, engineering_validation = validate_engineering_model(document_model)
    drawing_template = build_drawing_template(reference_path=template_path)
    clean_layout, clean_layout_diagnostics = build_clean_layout(
        document_model, template=drawing_template, review_only=not processing_complete
    )
    drawing_quality = validate_clean_layout(clean_layout, engineering_validation)
    clean_layout_diagnostics['drawingQuality'] = drawing_quality
    cad_alignment_overlay = {'available': False, 'error': 'not-generated'}
    try:
        cad_alignment_overlay = render_cad_alignment_overlay(bgr, document_model, Path(out_dir, 'cad-alignment-overlay.png'))
        _progress('CAD', 'Source-photo / CAD alignment overlay written')
    except Exception as overlay_error:
        cad_alignment_overlay = {'available': False, 'error': str(overlay_error)[:220]}
        _progress('CAD', f'Source-photo / CAD overlay failed: {str(overlay_error)[:180]}')
    cad_draft_svg = build_layout_svg(clean_layout)
    cad_draft_dxf = build_layout_dxf(clean_layout)
    Path(out_dir, 'clean.svg').write_text(cad_draft_svg, encoding='utf-8')
    Path(out_dir, 'drawing.dxf').write_text(cad_draft_dxf, encoding='utf-8')
    Path(out_dir, 'cad-draft.svg').write_text(cad_draft_svg, encoding='utf-8')
    Path(out_dir, 'cad-draft.dxf').write_text(cad_draft_dxf, encoding='utf-8')
    graph = {
        'schema': 'cad-reconstruction-graph/1.2',
        'status': 'needs_review',
        'analysisStatus': 'complete' if processing_complete else 'incomplete',
        'complete': processing_complete,
        'incompleteReasons': incomplete_reasons,
        'checkpointing': {
            'enabled': True,
            'directory': '.checkpoints',
            'resumeBehavior': 'successful OCR/PIPE tiles are restored; failed tiles are retried on the next analysis run',
        },
        'exportPolicy': {
            'processingComplete': bool(processing_complete),
            'partialExports': 'review-only-watermarked',
            'referenceTrace': 'editable-source-contours-not-semantic-pipes',
            'centerlineTrace': 'editable-open-source-ink-polylines-not-semantic-pipes',
            'cadDraft': 'structured-review-draft-until-engineering-validation',
            'engineeringApprovalRequired': True,
        },
        'image': {'width': w, 'height': h},
        'documentModel': document_model,
        'recognitionChannels': recognition_channels,
        'symbolCatalog': catalog_manifest(),
        'topologyDiagnostics': {**topology_diagnostics, 'tJunctions': t_junction_diagnostics},
        'annotationLinkingDiagnostics': annotation_linking_diagnostics,
        'engineeringValidation': engineering_validation,
        'drawingQuality': drawing_quality,
        'cadAlignmentOverlay': cad_alignment_overlay,
        'cleanLayout': clean_layout,
        'cleanLayoutDiagnostics': clean_layout_diagnostics,
        'referenceTrace': reference_trace_meta,
        'centerlineTrace': centerline_trace_meta,
        'drawingTemplate': drawing_template,
        'nodes': nodes,
        'edges': edges,
        'components': components,
        'crossings': crossings,
        'joinCandidates': joins,
        'annotations': annotations,
        'ocr': ocr_status,
        'semanticRoutes': semantic_routes,
        'primarySemanticRoutes': primary_semantic_routes,
        'semanticValidation': semantic_validation,
        'semanticTrace': route_status,
        'timings_ms': timings_ms,
        'rules': {
            'ocr_boxes_mask_geometry_even_when_text_unverified': True,
            'text_overlap_affects_component_classification': True,
            'continuous_lines_through_text_are_preserved_only_with_two_sided_ink_support': True,
            'crossings_auto_joined': False,
            'endpoint_cluster_radius_px': 4.5,
            'collinear_gap_join_max_px': 28,
            'ambiguous_and_text_like_components_are_review_only': True,
            'clean_export_uses_selected_opencv_and_validated_qwen_routes': True,
            'qwen_routes_are_ink_validated_before_primary_export': True,
            'unselected_pixel_candidates_are_review_only': True,
            'short_symbol_stubs_go_to_review_layer': True,
            'ink_colour_is_advisory_only': True,
            'unknown_symbols_require_confirmation': True,
            'polyline_merge_preserves_source_geometry': True,
            'ambiguous_junctions_are_not_merged': True,
            't_junctions_only_join_supported_endpoint_to_interior_contacts': True,
            'symbol_template_matches_require_engineer_confirmation': True,
            'adaptive_faint_ink_is_reviewed_with_source_support': True,
            'join_candidates_include_ambiguous_components_for_manual_review': True,
            'join_candidates_allow_short_fragments_for_manual_review': True,
            'join_candidate_gap_px': [4.5, 45.0],
            'join_candidate_lateral_tolerance_px': 8.0,
            'join_candidate_min_edge_length_px': 8.0,
            'join_candidate_min_endpoint_facing': 0.82,
            'join_candidate_min_tangent_alignment': 0.85,
            'join_candidates_auto_applied': False,
            'topology_network_candidate_min_edges': 8,
            'topology_network_candidate_min_length_px': 135,
            'topology_network_candidate_max_degree': 8,
            'topology_network_candidate_max_edge_density': 5.6,
            'topology_network_candidate_max_turn_density': 1.35,
        },
        'summary': {
            'analysis_complete': processing_complete,
            'ocr_tiles_complete': qwen_ocr_complete,
            'ocr_text_available': ocr_complete,
            'pipe_tiles_complete': pipe_complete,
            'ocr_tiles_successful': ocr_status.get('qwen', {}).get('successful_tiles', 0),
            'ocr_tiles_total': ocr_status.get('qwen', {}).get('tiles', 0),
            'pipe_tiles_successful': route_status.get('successful_tiles', 0),
            'pipe_tiles_total': route_status.get('tiles', 0),
            'segment_candidates': len(segments),
            'nodes': len(nodes),
            'edges': len(edges),
            'crossings_to_review': len(crossings),
            'ocr_annotations': len(annotations),
            'reference_trace_components': reference_trace_meta.get('components', 0),
            'reference_trace_contours': reference_trace_meta.get('contours', 0),
            'reference_trace_vertices': reference_trace_meta.get('vertices', 0),
            'centerline_trace_paths': centerline_trace_meta.get('paths', 0),
            'centerline_trace_vertices': centerline_trace_meta.get('vertices', 0),
            'centerline_trace_skeleton_pixels': centerline_trace_meta.get('skeletonPixels', 0),
            'semantic_routes': len(semantic_routes),
            'qwen_review_routes': len(_semantic_route_chains(semantic_routes)),
            'cad_primary_chains': len(_cad_edge_chains(edges)),
            'cad_primary_qwen_routes': len(primary_semantic_routes),
            'document_model_qwen_routes': sum(1 for pipe in document_model.get('pipes', []) if pipe.get('source') == 'qwen3-vl-validated'),
            'ink_color_classification': ink_color_diagnostics,
            't_junctions_added': t_junction_diagnostics.get('tJunctionsAdded', 0),
            't_junction_segments_created': t_junction_diagnostics.get('segmentsCreated', 0),
            'cad_primary_total_paths': len(_cad_edge_chains(edges)) + len(primary_semantic_routes),
            'semantic_validation': semantic_validation,
            'primary_geometry_source': 'opencv-selected-graph+ink-validated-local-qwen',
            'qwen_annotations': len([a for a in annotations if a.get('source') == 'qwen3-vl']),
            'moss_ocr_annotations': len([a for a in annotations if a.get('source') == 'moss-vl-ocr']),
            'openrouter_ocr_annotations': len([a for a in annotations if a.get('source') == 'openrouter-vision-ocr']),
            'geometry_excluded_text_regions': len(_confirmed_text_boxes(annotations)),
            'tesseract_annotations': len([a for a in annotations if a.get('source') == 'tesseract']),
            'verified_annotations': len([a for a in annotations if a.get('verified') and a.get('text')]),
            'text_review_annotations': len([a for a in annotations if _annotation_export_kind(a) == 'TEXT_REVIEW']),
            'text_block_annotations': len([a for a in annotations if a.get('source') == 'qwen3-vl-block']),
            'text_block_rows_detected': sum(
                int(item.get('rows_detected', 0) or 0) for item in ocr_status.get('qwen', {}).get('block_diagnostics', [])
            ),
            'text_block_rows_returned': sum(
                int(item.get('rows_returned', 0) or 0) for item in ocr_status.get('qwen', {}).get('block_diagnostics', [])
            ),
            'text_block_rows_verified': sum(
                sum(1 for row in item.get('row_diagnostics', []) if row.get('accepted') and float(row.get('confidence', 0) or 0) >= 58)
                for item in ocr_status.get('qwen', {}).get('block_diagnostics', [])
            ),
            'qwen_verified_annotations': len([a for a in annotations if a.get('source') == 'qwen3-vl' and a.get('verified')]),
            'tesseract_verified_annotations': len([a for a in annotations if a.get('source') == 'tesseract' and a.get('verified')]),
            'review_annotations': len([a for a in annotations if not a.get('verified') and a.get('text')]),
            'text_overlap_edges': sum(1 for e in edges if e.get('suggested_role') == 'text_or_dimension'),
            'text_regions_used_for_geometry_mask': len(_confirmed_text_boxes(annotations)),
            'ink_pixels_inside_text_regions': int(np.count_nonzero(ink_in_text_regions)),
            'auto_joined_collinear_gaps': len({(edge['from'], edge['to']) for edge in edges if edge.get('auto_joined_gap')}),
            'text_or_annotation_components': sum(1 for c in components if c['role'] == 'text_or_annotation'),
            'review_only_ambiguous_components': sum(1 for c in components if c['role'] == 'ambiguous'),
            'topology_network_candidate_components': sum(1 for c in components if c.get('topology_network_candidate')),
            'topology_network_primary_edges': sum(1 for e in edges if e.get('topology_network_candidate') and e.get('cad_include')),
            'structured_route_components': sum(
                1
                for c in components
                if c.get('connected_line_candidate') or c.get('elbow_route_candidate') or c.get('topology_network_candidate')
            ),
            'dense_route_exempted_components': sum(1 for c in components if c.get('dense_route_exemption')),
            'primary_edge_count_by_detector': {
                name: sum(1 for e in edges if e.get('cad_include') and e.get('detector') == name) for name in ('LSD', 'HOUGH')
            },
            'isolated_strokes_kept_for_review': sum(1 for e in edges if e.get('cad_reason') == 'isolated-stroke-review'),
            'geometry_candidates_preserved': len(segments),
            'open_end_join_candidates': len(joins),
            'join_candidates_high_priority': sum(1 for item in joins if item.get('priority') == 'high'),
            'join_candidates_needing_review': sum(1 for item in joins if item.get('priority') != 'high'),
            'join_candidates_with_alternatives': sum(1 for item in joins if item.get('has_alternatives')),
            'open_terminal_nodes': sum(1 for node in nodes if int(node.get('degree', 0)) == 1),
            'components': len(components),
            **cad_selection,
            'line_components': sum(1 for c in components if c['role'] == 'line_structure'),
            'annotation_components': sum(1 for c in components if c['role'] == 'text_or_annotation'),
            'ambiguous_components': sum(1 for c in components if c['role'] == 'ambiguous'),
            'ink_pixels': int(np.count_nonzero(ink)),
            'faint_ink_pixels': int(np.count_nonzero(ink_layers['faint'])),
            'preprocessing': prep,
        },
        'warnings': [
            'PIPE_MAIN использует только связные многосегментные маршруты с геометрическими признаками труб. Одиночные длинные штрихи, размерные линии и неоднозначные группы остаются в DETAIL_REVIEW.',
            'В 4.3.9 сложные многоветвевые компоненты дополнительно проверяются по топологии, длине, плотности, поворотам, чернилам и OCR; сильные чернила сами по себе не являются основанием для включения.',
            'Qwen-маршруты проходят проверку по исходным пикселям и добавляются в PIPE_MAIN только при подтверждении чернилами; остальные остаются в QWEN_REVIEW.',
            'Неотобранные LSD/Hough-отрезки сохранены на замороженном DETAIL_REVIEW.',
            'X-пересечения не объединяются автоматически; Т-подключения распознаются только при подтверждённом контакте окончания с внутренней частью штриха и достаточной поддержке исходными чернилами.',
            'OCR-рамки участвуют в маске геометрии даже при низкой уверенности текста; непрерывная труба через рамку сохраняется при подтверждении с обеих сторон.',
            'Подтверждённые подписи экспортируются как VERIFIED_TEXT; сомнительные OCR-чтения выводятся отдельно на замороженный TEXT_REVIEW.',
            'Плотные рукописные заметки повторно читаются построчно отдельным OCR-проходом.',
            'Проверьте трассы, повороты, размеры и подписи по оригиналу до использования чертежа.',
        ],
    }
    if not processing_complete:
        graph['warnings'].append(
            'CAD-РЕКОНСТРУКЦИЯ НЕПОЛНАЯ: не завершён полный проход Qwen OCR и/или трассировки труб. Файлы cad-draft.svg/dxf являются проверочным черновиком, а не готовым техническим документом. Файлы centerline-trace.svg/dxf сохраняют открытые осевые линии видимых исходных штрихов, а reference-trace.svg/dxf — их замкнутые контуры; ни один из этих вариантов не подтверждает инженерные соединения или типы оборудования. Успешные Qwen-плитки сохранены в .checkpoints; повторный запуск задания повторит незавершённые этапы.'
        )
        graph['warnings'].extend(str(reason) for reason in incomplete_reasons if reason)
    if not ocr_status.get('qwen', {}).get('available'):
        graph['warnings'].append(
            'Локальный Qwen OCR недоступен. Tesseract может дополнить чтение текста, но не заменяет Qwen для структурного распознавания и трассировки труб. Проверьте Ollama и модель Qwen3-VL.'
        )
    if not route_status.get('available') or not semantic_routes:
        graph['warnings'].append(
            'Локальный Qwen не предоставил пригодные маршруты. Основной PIPE_MAIN строится из подтверждённых геометрических путей OpenCV; сомнительные фрагменты остаются на проверке. Причина: '
            + str(route_status.get('error') or 'маршруты отсутствуют')
            + ' Действие: '
            + str(route_status.get('hint') or 'проверьте доступность Ollama и установленную модель Qwen3-VL.')
        )
    if not _cad_edge_chains(edges):
        graph['warnings'].append(
            'В графе OpenCV не осталось выбранных основных CAD-путей. Проверьте исходное изображение и слой DETAIL_REVIEW.'
        )
    if len(segments) >= 80 and (cad_selection.get('cad_primary_edges', 0) + len(primary_semantic_routes)) < max(
        12, int(len(segments) * 0.12)
    ):
        graph['warnings'].append(
            'Основная геометрия получилась разреженной: большинство штрихов оставлено на проверку. Не считайте чертёж полным; проверьте primary-overlay.png и text-region-mask.png.'
        )
    # Write the graph once before collecting artifact diagnostics so graph.json
    # is not incorrectly reported as missing, then persist diagnostics in both files.
    _atomic_write_text(Path(out_dir, 'graph.json'), json.dumps(graph, ensure_ascii=False, indent=2))
    diagnostics = build_pipeline_diagnostics(input_path, out_dir, graph)
    graph['diagnostics'] = diagnostics
    _atomic_write_text(Path(out_dir, 'diagnostics.json'), json.dumps(diagnostics, ensure_ascii=False, indent=2))
    _atomic_write_text(Path(out_dir, 'graph.json'), json.dumps(graph, ensure_ascii=False, indent=2))
    _progress('EXPORT', 'graph.json written; intermediate checkpoints retained')
    if processing_complete:
        _progress('JOB', 'Analysis completed successfully; selected OCR and pipe-tracing providers completed')
    else:
        _progress(
            'JOB', 'Analysis INCOMPLETE; partial exports are review-only. Re-run this job to retry incomplete local Qwen checkpoints.'
        )
    return graph


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--template', default=None, help='Optional reference sheet file; raster is used for page profile only')
    ap.add_argument(
        '--rotation',
        type=int,
        choices=[0, 90, 180, 270],
        default=None,
        help='Explicit clockwise page rotation in degrees; overrides unreliable handwriting orientation detection',
    )
    ap.add_argument(
        '--test-openrouter', action='store_true', help='Run an explicit OpenRouter OCR + multimodal vision smoke test on the source image'
    )
    ap.add_argument('--test-moss', action='store_true', help='Run an explicit MOSS OCR + multimodal vision smoke test on the source image')
    args = ap.parse_args()
    log.info(
        'Processor started',
        extra={
            'input': os.path.basename(args.input),
            'out': os.path.basename(args.out.rstrip('/')),
            'hasTemplate': bool(args.template),
            'rotation': args.rotation,
            'logLevel': os.getenv('LOG_LEVEL', 'INFO'),
        },
    )
    if args.test_moss:
        result = test_moss_ai(args.input, os.getenv('MOSS_API_KEY', '').strip(), os.getenv('MOSS_MODEL', DEFAULT_MOSS_MODEL))
        print(json.dumps(result, ensure_ascii=False))
        return
    if args.test_openrouter:
        result = test_openrouter_ai(
            args.input,
            os.getenv('OPENROUTER_API_KEY', '').strip(),
            os.getenv('OPENROUTER_MODEL', DEFAULT_OPENROUTER_MODEL),
        )
        print(json.dumps(result, ensure_ascii=False))
        return
    result = analyze(args.input, args.out, template_path=args.template, rotation_degrees=args.rotation)
    summary = result.get('summary') if isinstance(result, dict) else None
    log.info(
        'Processor finished',
        extra={
            'segments': (summary or {}).get('segment_candidates'),
            'edges': (summary or {}).get('cad_primary_edges'),
            'reviewEdges': (summary or {}).get('cad_review_edges'),
            'complete': (result or {}).get('complete') if isinstance(result, dict) else None,
            'timings': (result or {}).get('timings_ms') if isinstance(result, dict) else None,
        },
    )
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
