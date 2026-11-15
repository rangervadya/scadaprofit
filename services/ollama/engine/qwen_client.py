"""Qwen VL client, checkpointing and retry budget (P2-1).

Moved from processor.py verbatim. Depends on the shared analysis deadline
(analysis_state) instead of a module-level global, so the budget check still
works after the move.
"""

from __future__ import annotations

import base64
import hashlib
import json
import math
import os
import re
import socket
import time
import urllib.error
import urllib.request
from io import BytesIO
from pathlib import Path
from typing import Any

from analysis_state import get_analysis_hard_deadline
from logging_setup import get_logger
from PIL import Image

log = get_logger('processor.qwen')

CHECKPOINT_VERSION = 1


# Reserve time before the Node worker's hard timeout so a partial graph can be
# built/exported instead of the Python process being SIGTERM-killed mid-request.
def _qwen_attempt_worst_case_seconds(timeout: float, retry_budget: int) -> float:
    factor = max(1.0, min(2.0, float(os.getenv('QWEN_RETRY_TIMEOUT_FACTOR', '1.6'))))
    max_timeout = max(timeout, min(600.0, float(os.getenv('QWEN_RETRY_TIMEOUT_MAX', '360'))))
    attempts = max(0, min(3, int(retry_budget))) + 1
    return sum(min(max_timeout, timeout * (factor**index)) for index in range(attempts))


def _analysis_has_qwen_budget(timeout: float, retry_budget: int, reserve_seconds: float) -> bool:
    deadline = get_analysis_hard_deadline()
    if deadline is None:
        return True
    required = _qwen_attempt_worst_case_seconds(timeout, retry_budget) + max(0.0, reserve_seconds)
    return time.monotonic() + required <= deadline


def _sha256_file(path: str | Path) -> str:
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


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


def _tile_checkpoint_signature(image_sha256: str, stage: str, tile_index: int, settings: dict[str, Any]) -> str:
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


def _load_tile_checkpoint(checkpoint_dir: str | Path | None, stage: str, tile_index: int, signature: str) -> dict[str, Any] | None:
    path = _tile_checkpoint_path(checkpoint_dir, stage, tile_index)
    if path is None or not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding='utf-8'))
        if (
            payload.get('version') != CHECKPOINT_VERSION
            or payload.get('signature') != signature
            or payload.get('stage') != stage
            or int(payload.get('tile', 0)) != int(tile_index)
            or payload.get('status') not in {'completed', 'completed_empty'}
        ):
            return None
        if not isinstance(payload.get('items'), list) or not isinstance(payload.get('diagnostics'), dict):
            return None
        return payload
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None


def _save_tile_checkpoint(
    checkpoint_dir: str | Path | None, stage: str, tile_index: int, signature: str, items: list[dict[str, Any]], diagnostics: dict[str, Any]
) -> None:
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


def _qwen_call_with_retry(
    rgb: Image.Image,
    prompt: str,
    *,
    url: str,
    model: str,
    timeout: float,
    max_edge: int,
    num_predict: int,
    diagnostics: dict[str, Any],
    format_schema: dict[str, Any] | None,
    retry_state: dict[str, int],
    stage: str,
    tile_index: int,
) -> tuple[dict[str, Any], float, tuple[int, int]]:
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
                rgb,
                prompt,
                url=url,
                model=model,
                timeout=attempt_timeout,
                max_edge=max_edge,
                num_predict=num_predict,
                diagnostics=attempt_diag,
                format_schema=format_schema,
            )
            elapsed_ms = round((time.perf_counter() - attempt_started) * 1000.0, 1)
            history.append(
                {
                    'attempt': attempt,
                    'timeout_seconds': round(attempt_timeout, 1),
                    'status': 'completed',
                    'elapsed_ms': elapsed_ms,
                    'ollama_total_ms': attempt_diag.get('ollama_total_ms'),
                    'eval_count': attempt_diag.get('eval_count'),
                }
            )
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
            history.append(
                {
                    'attempt': attempt,
                    'timeout_seconds': round(attempt_timeout, 1),
                    'status': 'failed',
                    'elapsed_ms': elapsed_ms,
                    'error': message,
                    'ollama_total_ms': attempt_diag.get('ollama_total_ms'),
                    'eval_count': attempt_diag.get('eval_count'),
                }
            )
            diagnostics.update(attempt_diag)
            if retry_state.get('remaining', 0) > 0 and _is_retryable_qwen_error(error):
                retry_state['remaining'] -= 1
                next_timeout = min(max_timeout, attempt_timeout * factor)
                log.info(
                    f'Tile {tile_index}: transient error on attempt {attempt}; '
                    f'retrying attempt {attempt + 1} with timeout={next_timeout:.0f}s; '
                    f'retries_left={retry_state["remaining"]}'
                )
                if backoff:
                    time.sleep(backoff)
                continue
            diagnostics['attempts'] = attempt
            diagnostics['retry_count'] = max(0, attempt - 1)
            diagnostics['retry_budget_at_start'] = retry_budget_at_start
            diagnostics['attempt_history'] = history
            diagnostics['attempt_errors'] = errors[-3:]
            raise


def _qwen_call(
    rgb: Image.Image,
    prompt: str,
    *,
    url: str,
    model: str,
    timeout: float,
    max_edge: int,
    num_predict: int = 1536,
    diagnostics: dict[str, Any] | None = None,
    format_schema: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], float, tuple[int, int]]:
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
        'options': {
            'temperature': 0,
            'num_ctx': max(2048, min(8192, int(os.getenv('QWEN_NUM_CTX', '4096')))),
            'num_batch': max(32, min(512, int(os.getenv('QWEN_NUM_BATCH', '96')))),
            'num_thread': max(1, min(8, int(os.getenv('QWEN_NUM_THREADS', '2')))),
            'num_predict': max(128, min(2048, int(num_predict))),
        },
    }
    request = urllib.request.Request(
        url, data=json.dumps(payload, ensure_ascii=False).encode('utf-8'), headers={'Content-Type': 'application/json'}, method='POST'
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
    if diagnostics is not None:
        # Capture a bounded raw response before parsing. This preserves the
        # evidence when a model emits malformed/truncated JSON and parsing fails.
        diagnostics.update(
            {
                'done': body.get('done'),
                'done_reason': body.get('done_reason'),
                'truncated': body.get('done_reason') == 'length',
                'eval_count': body.get('eval_count'),
                'prompt_eval_count': body.get('prompt_eval_count'),
                'response_chars': len(content),
                'response_sha256': hashlib.sha256(content.encode('utf-8', errors='replace')).hexdigest(),
                'response_preview': content[:2000],
                'response_preview_truncated': len(content) > 2000,
                'jpeg_base64_encode_ms': round(encode_ms, 1),
                'ollama_http_ms': round(request_ms, 1),
                'ollama_load_ms': round(float(body['load_duration']) / 1_000_000.0, 1)
                if isinstance(body.get('load_duration'), (int, float))
                else None,
                'ollama_total_ms': round(float(body['total_duration']) / 1_000_000.0, 1)
                if isinstance(body.get('total_duration'), (int, float))
                else None,
                'ollama_prompt_eval_ms': round(float(body['prompt_eval_duration']) / 1_000_000.0, 1)
                if isinstance(body.get('prompt_eval_duration'), (int, float))
                else None,
                'ollama_eval_ms': round(float(body['eval_duration']) / 1_000_000.0, 1)
                if isinstance(body.get('eval_duration'), (int, float))
                else None,
            }
        )
    try:
        parsed = _parse_json_object(content)
    except Exception as error:
        if diagnostics is not None:
            diagnostics['json_parse_error'] = (str(error).strip() or error.__class__.__name__)[:240]
            diagnostics['json_parse_ms'] = round((time.perf_counter() - parse_started) * 1000.0, 1)
            diagnostics['request_total_ms'] = round((time.perf_counter() - total_started) * 1000.0, 1)
        raise
    if diagnostics is not None:
        diagnostics.update(
            {
                'json_keys': sorted(str(key) for key in parsed.keys()),
                'annotations_key_count': next(
                    (
                        len(parsed[key])
                        for key in ('annotations', 'texts', 'text_regions', 'labels', 'objects', 'items')
                        if isinstance(parsed.get(key), list)
                    ),
                    None,
                ),
                'routes_key_count': next(
                    (
                        len(parsed[key])
                        for key in ('routes', 'pipes', 'pipe_routes', 'polylines', 'paths', 'traces')
                        if isinstance(parsed.get(key), list)
                    ),
                    None,
                ),
                'json_parse_ms': round((time.perf_counter() - parse_started) * 1000.0, 1),
                'request_total_ms': round((time.perf_counter() - total_started) * 1000.0, 1),
            }
        )
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


def _clip_segment_to_rect(
    a: list[float], b: list[float], rect: tuple[float, float, float, float]
) -> tuple[list[float], list[float]] | None:
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
    return ([round(x0 + u0 * dx, 1), round(y0 + u0 * dy, 1)], [round(x0 + u1 * dx, 1), round(y0 + u1 * dy, 1)])


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
