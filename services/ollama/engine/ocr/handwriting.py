"""Handwritten note OCR: detect note blocks and transcribe their rows.

This is a *recognition* stage, not geometry. It locates dense handwritten
blocks from OCR boxes plus source ink, splits a numbered list into individual
rows via the left margin, and reads rows in pairs (falling back to single-row
reads) through the local Qwen3-VL client.

The geometry channel never subtracts these boxes from the drawing: OCR boxes
are advisory and ambiguous joins stay review items.
"""

from __future__ import annotations

import math
import os
import re
from typing import Any

import cv2
import numpy as np
from PIL import Image

import engine.ocr.qwen_client as qwen_client
from engine.core.logging_setup import get_logger
from engine.ocr.qwen_client import _annotation_items_from_response
from engine.ocr.schemas import OCR_BLOCK_RESPONSE_SCHEMA, OCR_ROW_RESPONSE_SCHEMA, OCR_ROWS_RESPONSE_SCHEMA

log = get_logger('processor')


def _progress(stage: str, message: str) -> None:
    """Emit one progress event for the parent process and for progress.log."""
    from engine.core.runtime import progress

    progress(stage, message)


def _boxes_overlap(a: dict[str, Any], b: dict[str, Any]) -> float:
    """Intersection-over-union of two `[x, y, w, h]`-style boxes."""
    ax, ay, aw, ah = (float(a.get(key, 0) or 0) for key in ('x', 'y', 'w', 'h'))
    bx, by, bw, bh = (float(b.get(key, 0) or 0) for key in ('x', 'y', 'w', 'h'))
    left, top = max(ax, bx), max(ay, by)
    right, bottom = min(ax + aw, bx + bw), min(ay + ah, by + bh)
    if right <= left or bottom <= top:
        return 0.0
    intersection = (right - left) * (bottom - top)
    union = aw * ah + bw * bh - intersection
    return float(intersection / union) if union > 0 else 0.0


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
