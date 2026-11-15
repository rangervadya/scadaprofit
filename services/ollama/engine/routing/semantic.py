"""Semantic pipe-route tracing via the local Qwen3-VL model.

The sheet is traced tile-by-tile so a small vision model never has to parse a
full page at once. Each tile returns polylines that are clipped back to the
original image and validated against the source ink by the caller.

This module only produces *candidate* routes; it does not decide what becomes
primary CAD geometry.
"""

from __future__ import annotations

import math
import os
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps

from engine.core.runtime import _progress
from engine.ocr.qwen_client import (
    _analysis_has_qwen_budget,
    _clip_polyline_to_rect,
    _load_tile_checkpoint,
    _qwen_call_with_retry,
    _save_tile_checkpoint,
    _sha256_file,
    _tile_checkpoint_signature,
)

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
