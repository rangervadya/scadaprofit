"""OCR pipeline: run Qwen3-VL tile OCR, fall back to Tesseract, merge results.

The OCR channel is independent of the geometry channel: a missing tile never
suppresses the OpenCV pass, and every box produced here is advisory. Text that
is not confirmed stays a review annotation rather than an engineering fact.
"""

from __future__ import annotations

import math
import os
import re
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image, ImageOps

from engine.core.logging_setup import get_logger
from engine.core.runtime import _progress
from engine.ocr.handwriting import _run_handwritten_block_ocr
from engine.ocr.qwen_client import (
    _analysis_has_qwen_budget,
    _annotation_items_from_response,
    _load_tile_checkpoint,
    _qwen_call_with_retry,
    _save_tile_checkpoint,
    _sha256_file,
    _tile_checkpoint_signature,
)
from engine.ocr.schemas import OCR_RESPONSE_SCHEMA

log = get_logger('processor')


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
