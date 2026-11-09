"""MOSS-VL multimodal OCR and pipe-route extraction for ScadaProfit.

Uses the official MOSS Files + Responses API. Images are uploaded as private
assets and deleted after inference. Credentials are read from the process
environment and are never included in diagnostics or returned status objects.
"""
from __future__ import annotations

import io
import json
import math
import mimetypes
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps

API_BASE = "https://api.mosi.cn/v1"
FILES_URL = f"{API_BASE}/files"
RESPONSES_URL = f"{API_BASE}/responses"
DEFAULT_MODEL = "moss-vl-1.0"
MAX_IMAGE_BYTES = 8_000_000
MAX_IMAGE_EDGE = 2304


class MossAIError(RuntimeError):
    """Sanitized provider error; credentials are never included."""


def _progress(message: str) -> None:
    """Write safe, non-content diagnostics to the Python process stderr."""
    safe = re.sub(r"[\r\n]+", " ", str(message or "")).strip()[:420]
    if safe:
        sys.stderr.write(f"[MOSS PIPE] {safe}\n")
        sys.stderr.flush()


def _redact(text: str, api_key: str = "") -> str:
    value = str(text or "")
    if api_key:
        value = value.replace(api_key, "[секрет скрыт]")
    value = re.sub(r"(?i)(Bearer\s+\S+|api[-_ ]?key\s*[:=]\s*\S+)", "[секрет скрыт]", value)
    return value[:420]


def _request_json(
    api_key: str,
    url: str,
    *,
    method: str = "POST",
    body: bytes | None = None,
    content_type: str = "application/json",
    timeout: float = 180.0,
) -> dict[str, Any]:
    if not api_key:
        raise MossAIError("Не задан API-ключ MOSS.")
    headers = {"Authorization": f"Bearer {api_key}", "Accept": "application/json"}
    if body is not None and content_type:
        headers["Content-Type"] = content_type
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read(12 * 1024 * 1024)
    except urllib.error.HTTPError as error:
        try:
            raw_detail = error.read(4096).decode("utf-8", "replace")
            parsed = json.loads(raw_detail)
            err = parsed.get("error") if isinstance(parsed.get("error"), dict) else {}
            detail = err.get("message") or parsed.get("message") or raw_detail
        except Exception:
            detail = "ошибка запроса"
        detail = _redact(str(detail), api_key)
        hints = {
            400: "Проверь формат изображения и параметры MOSS-VL.",
            401: "Проверь API-ключ MOSS.",
            403: "MOSS запретил доступ к endpoint или модели для этого ключа.",
            404: "Endpoint или модель MOSS не найдены.",
            413: "Изображение слишком большое для загрузки.",
            429: "Достигнут лимит запросов MOSS; попробуй позже.",
        }
        raise MossAIError(
            f"MOSS HTTP {error.code}: {detail}. "
            f"{hints.get(error.code, 'Проверь доступность MOSS API.')}"
        ) from None
    except urllib.error.URLError as error:
        reason = _redact(str(getattr(error, "reason", "сетевой сбой")), api_key)
        raise MossAIError(f"Не удалось подключиться к MOSS: {reason}") from None
    except TimeoutError:
        raise MossAIError("Истекло время ожидания ответа MOSS.") from None
    try:
        data = json.loads(raw.decode("utf-8")) if raw else {}
    except Exception:
        raise MossAIError("MOSS вернул некорректный JSON.") from None
    if not isinstance(data, dict):
        raise MossAIError("MOSS вернул ответ неожиданного формата.")
    if data.get("error"):
        err = data.get("error")
        detail = err.get("message") if isinstance(err, dict) else str(err)
        raise MossAIError(_redact(detail or "неизвестная ошибка MOSS", api_key))
    return data


def _prepare_image(image_path: str | Path, max_edge: int = MAX_IMAGE_EDGE) -> tuple[bytes, int, int, float, float]:
    try:
        with Image.open(image_path) as source:
            image = ImageOps.exif_transpose(source).convert("RGB")
    except Exception as error:
        raise MossAIError(f"Не удалось открыть исходное изображение: {error}") from error
    original_width, original_height = image.size
    if original_width < 1 or original_height < 1:
        raise MossAIError("Исходное изображение имеет некорректный размер.")
    scale = min(1.0, max_edge / max(original_width, original_height))
    if scale < 0.999:
        image = image.resize(
            (max(1, round(original_width * scale)), max(1, round(original_height * scale))),
            Image.Resampling.LANCZOS,
        )
    quality = 90
    encoded = b""
    while quality >= 60:
        buffer = io.BytesIO()
        image.save(buffer, format="JPEG", quality=quality, optimize=True)
        encoded = buffer.getvalue()
        if len(encoded) <= MAX_IMAGE_BYTES:
            break
        quality -= 6
    if len(encoded) > MAX_IMAGE_BYTES:
        raise MossAIError("Не удалось уменьшить изображение до безопасного лимита 8 МБ.")
    return encoded, image.width, image.height, original_width / image.width, original_height / image.height


def _upload_image(api_key: str, image_bytes: bytes, *, timeout: float) -> str:
    boundary = f"----ScadaProfitMoss{uuid.uuid4().hex}"
    chunks = [
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"purpose\"\r\n\r\nimage\r\n".encode("ascii"),
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"scadaprofit-source.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n".encode("ascii"),
        image_bytes,
        f"\r\n--{boundary}--\r\n".encode("ascii"),
    ]
    result = _request_json(
        api_key, FILES_URL, method="POST", body=b"".join(chunks),
        content_type=f"multipart/form-data; boundary={boundary}", timeout=timeout,
    )
    file_id = str(result.get("id") or "").strip()
    if not file_id or len(file_id) > 200:
        raise MossAIError("MOSS не вернул file_id после загрузки изображения.")
    return file_id


def _delete_image(api_key: str, file_id: str, *, timeout: float) -> None:
    if not file_id:
        return
    try:
        _request_json(
            api_key, f"{FILES_URL}/{urllib.parse.quote(file_id, safe='')}",
            method="DELETE", timeout=timeout,
        )
    except Exception:
        # Cleanup failure must not discard a successful result.
        pass


def _parse_json(content: Any) -> dict[str, Any]:
    text = str(content or "").strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.I)
    try:
        value = json.loads(text)
        if isinstance(value, dict):
            return value
    except Exception:
        pass
    decoder = json.JSONDecoder()
    for index, char in enumerate(text):
        if char == "{":
            try:
                value, _ = decoder.raw_decode(text[index:])
                if isinstance(value, dict):
                    return value
            except Exception:
                continue
    raise MossAIError("MOSS-VL не вернул корректный JSON. Повтори тест позже.")


def _response_text(response: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    status = str(response.get("status") or "")
    if status and status != "completed":
        details = response.get("incomplete_details")
        reason = details.get("reason") if isinstance(details, dict) else status
        raise MossAIError(f"MOSS-VL завершил ответ не полностью: {str(reason or status)[:160]}.")
    output = response.get("output") if isinstance(response.get("output"), list) else []
    parts: list[str] = []
    for item in output:
        if not isinstance(item, dict):
            continue
        content = item.get("content") if isinstance(item.get("content"), list) else []
        for part in content:
            if isinstance(part, dict) and part.get("type") == "output_text":
                parts.append(str(part.get("text") or ""))
    text = "\n".join(part for part in parts if part.strip())
    if not text:
        raise MossAIError("MOSS-VL вернул пустой текстовый ответ.")
    usage = response.get("usage") if isinstance(response.get("usage"), dict) else {}
    return text, usage


def _vision_json(
    image_path: str | Path, api_key: str, model: str, prompt: str, max_tokens: int, *, timeout: float,
) -> tuple[dict[str, Any], dict[str, Any]]:
    image_bytes, width, height, scale_x, scale_y = _prepare_image(image_path)
    file_id = _upload_image(api_key, image_bytes, timeout=timeout)
    try:
        payload = {
            "model": model,
            "input": [{"role": "user", "content": [
                {"type": "input_text", "text": prompt},
                {"type": "input_image", "file_id": file_id},
            ]}],
            "max_output_tokens": max_tokens,
        }
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        response = _request_json(
            api_key, RESPONSES_URL, method="POST", body=body,
            content_type="application/json", timeout=timeout,
        )
        text, usage = _response_text(response)
        parsed = _parse_json(text)
        return parsed, {
            "usage": usage,
            "image_size_sent": {"width": width, "height": height},
            "source_coordinate_scale": {"x": round(scale_x, 6), "y": round(scale_y, 6)},
            "response_id": str(response.get("id") or "")[:100],
        }
    finally:
        _delete_image(api_key, file_id, timeout=min(timeout, 20.0))


_OCR_ARRAY_KEYS = (
    "annotations", "text_annotations", "textAnnotations", "texts", "recognized_texts",
    "recognizedTexts", "text_regions", "textRegions", "ocr_results", "ocrResults",
    "detections", "items", "results", "words", "lines", "blocks", "regions",
)
_OCR_CONTAINER_KEYS = ("result", "data", "ocr", "document", "response", "output")
_OCR_TEXT_KEYS = (
    "text", "recognized_text", "recognizedText", "value", "label", "word", "transcription", "content",
)
_OCR_BOX_KEYS = (
    "bbox", "box", "bounding_box", "boundingBox", "rect", "rectangle", "box_2d", "position", "polygon", "points",
)


def _norm_key(value: Any) -> str:
    return str(value).lower().replace("-", "_")


def _extract_ocr_records(parsed: dict[str, Any]) -> tuple[list[Any] | None, str | None]:
    queue: list[tuple[dict[str, Any], str, int]] = [(parsed, "$", 0)]
    seen: set[int] = set()
    while queue:
        node, path, depth = queue.pop(0)
        if id(node) in seen:
            continue
        seen.add(id(node))
        key_map = {_norm_key(key): key for key in node.keys()}
        for alias in _OCR_ARRAY_KEYS:
            actual = key_map.get(_norm_key(alias))
            if actual is not None and isinstance(node.get(actual), list):
                return node[actual], f"{path}.{actual}"
        has_text = any(
            isinstance(node.get(key_map.get(_norm_key(alias))), (str, int, float))
            and str(node.get(key_map.get(_norm_key(alias)))).strip()
            for alias in _OCR_TEXT_KEYS if key_map.get(_norm_key(alias)) is not None
        )
        has_geometry = any(key_map.get(_norm_key(alias)) is not None for alias in _OCR_BOX_KEYS)
        has_geometry = has_geometry or all(key in key_map for key in ("x1", "y1", "x2", "y2"))
        has_geometry = has_geometry or (
            all(key in key_map for key in ("x", "y"))
            and ("w" in key_map or "width" in key_map)
            and ("h" in key_map or "height" in key_map)
        )
        if has_text and has_geometry:
            return [node], f"{path} (single text region)"
        if depth < 3:
            for container_key in _OCR_CONTAINER_KEYS:
                actual = key_map.get(container_key)
                child = node.get(actual) if actual is not None else None
                if isinstance(child, dict):
                    queue.append((child, f"{path}.{actual}", depth + 1))
    return None, None


def _ocr_text_value(raw: dict[str, Any]) -> str:
    key_map = {_norm_key(key): key for key in raw.keys()}
    for alias in _OCR_TEXT_KEYS:
        actual = key_map.get(_norm_key(alias))
        value = raw.get(actual) if actual is not None else None
        if isinstance(value, (str, int, float)) and str(value).strip():
            return re.sub(r"\s+", " ", str(value)).strip()[:180]
    return ""


def _ocr_box_values(raw: dict[str, Any]) -> tuple[float, float, float, float]:
    key_map = {_norm_key(key): key for key in raw.keys()}
    box_key = next((key_map.get(_norm_key(key)) for key in _OCR_BOX_KEYS
                    if key_map.get(_norm_key(key)) is not None
                    and raw.get(key_map[_norm_key(key)]) is not None), None)
    box = raw.get(box_key) if box_key is not None else None
    if isinstance(box, dict):
        normalized = {_norm_key(k): v for k, v in box.items()}
        if all(key in normalized for key in ("x", "y")) and ("w" in normalized or "width" in normalized) and ("h" in normalized or "height" in normalized):
            x1, y1 = float(normalized["x"]), float(normalized["y"])
            return x1, y1, x1 + float(normalized.get("w", normalized.get("width"))), y1 + float(normalized.get("h", normalized.get("height")))
        for keys in (("left", "top", "right", "bottom"), ("x1", "y1", "x2", "y2")):
            if all(key in normalized for key in keys):
                return tuple(float(normalized[key]) for key in keys)  # type: ignore[return-value]
        raise ValueError("bbox object format")
    if isinstance(box, (list, tuple)):
        if len(box) == 4 and not any(isinstance(item, (list, tuple, dict)) for item in box):
            return tuple(map(float, box))  # type: ignore[return-value]
        if len(box) >= 3 and all(isinstance(item, (list, tuple)) and len(item) >= 2 for item in box):
            xs, ys = [float(item[0]) for item in box], [float(item[1]) for item in box]
            return min(xs), min(ys), max(xs), max(ys)
        if len(box) == 8 and all(not isinstance(item, (list, tuple, dict)) for item in box):
            values = list(map(float, box))
            xs, ys = values[0::2], values[1::2]
            return min(xs), min(ys), max(xs), max(ys)
    keys = {_norm_key(k): v for k, v in raw.items()}
    if all(key in keys for key in ("x1", "y1", "x2", "y2")):
        return tuple(float(keys[key]) for key in ("x1", "y1", "x2", "y2"))  # type: ignore[return-value]
    if all(key in keys for key in ("x", "y")) and ("w" in keys or "width" in keys) and ("h" in keys or "height" in keys):
        x1, y1 = float(keys["x"]), float(keys["y"])
        return x1, y1, x1 + float(keys.get("w", keys.get("width"))), y1 + float(keys.get("h", keys.get("height")))
    raise ValueError("bbox missing")


def moss_ocr_annotations(
    image_path: str | Path, api_key: str, model: str = DEFAULT_MODEL, *, timeout: float = 180.0,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Extract handwritten labels and source-image pixel boxes."""
    model = str(model or DEFAULT_MODEL).strip()
    image_bytes, width, height, scale_x, scale_y = _prepare_image(image_path)
    file_id = _upload_image(api_key, image_bytes, timeout=timeout)
    try:
        prompt = (
            "Ты выполняешь OCR рукописной инженерной схемы газопровода. Найди ВСЕ видимые надписи: "
            "цифры, диаметры DN/Ду/Ø, размеры, номера, буквенные обозначения и пояснения. "
            "Не распознавай трубы как текст и не выдумывай нечитаемые символы. Для каждой отдельной "
            "надписи верни тесный прямоугольник вокруг её штрихов. Координаты bbox — пиксели "
            f"этого изображения {width}x{height}, формат [x1,y1,x2,y2], начало в левом верхнем углу. "
            "Верни только JSON: {\"annotations\":[{\"text\":\"Ду 25\",\"bbox\":[10,20,80,42],\"confidence\":65}]}. "
            "confidence от 0 до 100 — только ориентировочная оценка модели, не подтверждение правильности. "
            "СТРОГО: верхний уровень JSON обязан содержать ключ annotations, значение — массив объектов. "
            "У каждого объекта обязательны ключи text и bbox; bbox — ровно четыре числа [x1,y1,x2,y2]. "
            "Не используй ключи texts, results, items или иные обёртки; не возвращай пояснение или Markdown. "
            "Не объединяй несколько разнесённых надписей. Максимум 100 annotations. Если текст не найден, "
            "верни ровно {\"annotations\": []}."
        )
        payload = {"model": model, "input": [{"role": "user", "content": [
            {"type": "input_text", "text": prompt}, {"type": "input_image", "file_id": file_id}
        ]}], "max_output_tokens": 5000}
        response = _request_json(api_key, RESPONSES_URL, method="POST",
                                 body=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                                 content_type="application/json", timeout=timeout)
        text, usage = _response_text(response)
        parsed = _parse_json(text)
    finally:
        _delete_image(api_key, file_id, timeout=min(timeout, 20.0))
    raw_items, annotation_path = _extract_ocr_records(parsed)
    if raw_items is None:
        field_names = ", ".join(sorted(str(key)[:32] for key in parsed.keys())[:12]) or "нет"
        raise MossAIError(
            "Ответ MOSS OCR не содержит массива текстовых областей с координатами. "
            f"Поля JSON: {field_names}. Локальный Qwen/Tesseract должен выполнить резервный OCR."
        )
    items: list[dict[str, Any]] = []
    rejected = 0
    for index, raw in enumerate(raw_items[:100], 1):
        if not isinstance(raw, dict):
            rejected += 1
            continue
        text_value = _ocr_text_value(raw)
        try:
            x1, y1, x2, y2 = _ocr_box_values(raw)
            confidence = float(raw.get("confidence", raw.get("score", 55)))
        except (TypeError, ValueError):
            rejected += 1
            continue
        if not text_value or not all(math.isfinite(v) for v in (x1, y1, x2, y2, confidence)):
            rejected += 1
            continue
        if 0 <= confidence <= 1:
            confidence *= 100
        if confidence < 0 or confidence > 100 or x2 <= x1 or y2 <= y1:
            rejected += 1
            continue
        if x1 < -8 or y1 < -8 or x2 > width + 8 or y2 > height + 8:
            rejected += 1
            continue
        x1, y1 = max(0.0, x1), max(0.0, y1)
        x2, y2 = min(float(width), x2), min(float(height), y2)
        bbox = {
            "x": round(x1 * scale_x), "y": round(y1 * scale_y),
            "w": max(2, round((x2 - x1) * scale_x)),
            "h": max(2, round((y2 - y1) * scale_y)),
        }
        has_alnum = bool(re.search(r"[A-Za-zА-Яа-яЁё0-9ØøΦφДдУу]", text_value))
        items.append({
            "id": f"MS{index}", "text": text_value,
            "confidence": round(confidence, 1),
            "confidence_assumed": "confidence" not in raw, "bbox": bbox,
            "verified": False, "include": False, "needs_review": True,
            "geometry_exclude": has_alnum,
            "source": "moss-vl-ocr", "provider": "moss",
        })
    return items, {
        "available": True, "complete": True, "model": model, "provider": "moss",
        "annotations": len(items), "tiles": 1, "successful_tiles": 1, "failed_tiles": [],
        "rejected_annotations": rejected, "annotations_field": annotation_path,
        "image_size_sent": {"width": width, "height": height},
        "source_coordinate_scale": {"x": round(scale_x, 6), "y": round(scale_y, 6)},
        "usage": usage, "error": None,
    }


_ROUTE_ARRAY_KEYS = (
    "routes", "pipes", "pipe_routes", "pipeRoutes", "polylines", "paths", "traces",
    "segments", "line_segments", "lineSegments", "pipe_segments", "pipeSegments", "lines",
)
_ROUTE_CONTAINER_KEYS = ("result", "data", "vision", "geometry", "drawing", "response", "output")
_POINT_ARRAY_KEYS = ("points", "vertices", "polyline", "coordinates", "path", "centerline", "center_line")


def _extract_route_records(parsed: dict[str, Any]) -> tuple[list[Any] | None, str | None]:
    """Find a route/segment array in common JSON envelopes without inventing geometry."""
    queue: list[tuple[dict[str, Any], str, int]] = [(parsed, "$", 0)]
    seen: set[int] = set()
    while queue:
        node, path, depth = queue.pop(0)
        if id(node) in seen:
            continue
        seen.add(id(node))
        key_map = {_norm_key(key): key for key in node.keys()}
        for alias in _ROUTE_ARRAY_KEYS:
            actual = key_map.get(_norm_key(alias))
            value = node.get(actual) if actual is not None else None
            if isinstance(value, list):
                return value, f"{path}.{actual}"
            if isinstance(value, dict):
                return list(value.values()), f"{path}.{actual} (object values)"
        if depth < 4:
            for alias in _ROUTE_CONTAINER_KEYS:
                actual = key_map.get(alias)
                child = node.get(actual) if actual is not None else None
                if isinstance(child, dict):
                    queue.append((child, f"{path}.{actual}", depth + 1))
                elif isinstance(child, list):
                    for index, item in enumerate(child[:8]):
                        if isinstance(item, dict):
                            queue.append((item, f"{path}.{actual}[{index}]", depth + 1))
    return None, None


def _is_point(value: Any) -> bool:
    if isinstance(value, dict):
        keys = {_norm_key(k) for k in value}
        return "x" in keys and "y" in keys
    return isinstance(value, (list, tuple)) and len(value) >= 2 and not isinstance(value[0], (list, tuple, dict)) and not isinstance(value[1], (list, tuple, dict))


def _point_xy(value: Any) -> tuple[float, float]:
    if isinstance(value, dict):
        keys = {_norm_key(k): v for k, v in value.items()}
        return float(keys["x"]), float(keys["y"])
    if isinstance(value, (list, tuple)) and len(value) >= 2:
        return float(value[0]), float(value[1])
    raise ValueError("point format")


def _route_point_list(raw: Any) -> list[Any] | None:
    if isinstance(raw, list):
        return raw
    if not isinstance(raw, dict):
        return None
    key_map = {_norm_key(key): key for key in raw.keys()}
    for alias in _POINT_ARRAY_KEYS:
        actual = key_map.get(_norm_key(alias))
        value = raw.get(actual) if actual is not None else None
        if isinstance(value, list):
            return value
    # Straight segment format with explicit endpoints.
    keys = {_norm_key(k): v for k, v in raw.items()}
    if all(key in keys for key in ("x1", "y1", "x2", "y2")):
        return [[keys["x1"], keys["y1"]], [keys["x2"], keys["y2"]]]
    for start_key, end_key in (("start", "end"), ("from", "to")):
        if start_key in keys and end_key in keys:
            return [keys[start_key], keys[end_key]]
    return None


def _coordinate_mode(parsed: dict[str, Any], raw: Any) -> str:
    values = []
    for source in (raw, parsed):
        if isinstance(source, dict):
            for key in ("coordinate_space", "coordinateSpace", "coordinate_system", "coordinateSystem"):
                value = source.get(key)
                if value is not None:
                    values.append(str(value).strip().lower().replace("-", "_").replace(" ", "_"))
    joined = " ".join(values)
    if any(token in joined for token in ("0_1", "normalized", "normalised", "relative", "unit_square")):
        return "unit"
    if any(token in joined for token in ("0_1000", "1000x1000", "scale_1000")):
        return "1000"
    return "pixels"


def moss_semantic_routes(
    image_path: str | Path, api_key: str, model: str = DEFAULT_MODEL, *, timeout: float = 300.0,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Propose high-recall visible pipe centre-lines; caller validates them against source ink."""
    model = str(model or DEFAULT_MODEL).strip()
    image_bytes, width, height, scale_x, scale_y = _prepare_image(image_path)
    file_id = _upload_image(api_key, image_bytes, timeout=timeout)
    try:
        prompt = (
            "Ты выполняешь трассировку рукописной инженерной схемы газопровода по изображению. "
            "Найди видимые линии, которые изображают трубы, и верни их как редактируемые полилинии. "
            "Работай с ПОВЫШЕННЫМ ПОЛНОТОЙ ПОИСКА: не требуй идеальной уверенности, чтобы сообщить "
            "о видимом кандидате. Неопределённость отражай числом confidence, а не удалением кандидата. "
            "Ищи длинные горизонтальные, вертикальные и наклонные штрихи, соединённые участки, "
            "повороты и ответвления; учитывай синие, чёрные и серые рукописные линии разной толщины. "
            "Для прямого видимого участка достаточно двух точек — начала и конца. Для поворота добавь "
            "точку каждого видимого угла. Не нужно распознавать всю сеть целиком: возвращай каждый "
            "достоверно видимый непрерывный участок отдельным маршрутом. Если линия прерывается надписью "
            "или разрывом, не соединяй скрытый участок; верни видимые части отдельно. "
            "На Т-ответвлении разделяй ветви; общий конец допускается только там, где линии явно встречаются. "
            "Пересечения без явного соединения оставляй раздельными. Не включай текст, цифры, размеры, "
            "выноски, стрелки, рамку и контуры условных символов. Если труба подходит к символу, закончи "
            "линию у видимого входа в символ. Не выдумывай невидимые продолжения и не рисуй линии по памяти. "
            "Каждая точка должна лежать на видимом штрихе трубы или в пределах его толщины. "
            f"Координаты — абсолютные пиксели ЭТОГО отправленного изображения {width}x{height}; "
            "начало (0,0) слева сверху, x растёт вправо, y вниз. Не используй координаты исходника, "
            "если отправленное изображение было уменьшено. "
            "Верни только JSON-объект с верхним ключом routes: массив объектов "
            "{id, points, confidence}. points — массив [x,y], от 2 до 64 точек. "
            "confidence — число 0..100: 80-100 ясно видимая труба; 50-79 вероятный участок; "
            "35-49 слабый, но визуально поддержанный кандидат. Не возвращай кандидаты ниже 35. "
            "Система отдельно проверит каждый маршрут по исходным пикселям и топологии. "
            "Не возвращай пустой routes только из-за общей неопределённости: если видна хотя бы одна "
            "похожая на трубу линия, верни её как кандидат с честной confidence. "
            "Максимум 120 маршрутов, 64 точки на маршрут. Формат: "
            "{\"routes\":[{\"id\":\"R1\",\"points\":[[20,80],[180,80]],\"confidence\":65}],\"review_note\":\"\"}. "
            "Если на изображении действительно нет видимых трубных линий, верни {\"routes\":[]}."
        )
        payload = {"model": model, "input": [{"role": "user", "content": [
            {"type": "input_text", "text": prompt}, {"type": "input_image", "file_id": file_id}
        ]}], "max_output_tokens": 8192}
        response = _request_json(
            api_key, RESPONSES_URL, method="POST",
            body=json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"),
            content_type="application/json", timeout=timeout,
        )
        text, usage = _response_text(response)
        parsed = _parse_json(text)
    finally:
        _delete_image(api_key, file_id, timeout=min(timeout, 20.0))

    raw_routes, route_field = _extract_route_records(parsed)
    if raw_routes is None:
        field_names = ",".join(sorted(str(key)[:24] for key in parsed.keys())[:12]) or "none"
        raise MossAIError(f"Ответ MOSS Vision не содержит массива маршрутов. JSON fields: {field_names}")

    # Models sometimes return the points of one line directly in the route array.
    if raw_routes and all(_is_point(item) for item in raw_routes):
        raw_routes = [{"id": "R1", "points": raw_routes}]
    raw_count = len(raw_routes)
    min_confidence = max(0.0, min(100.0, float(os.getenv("MOSS_PIPE_MIN_CONFIDENCE", "35"))))
    routes: list[dict[str, Any]] = []
    rejected_invalid = 0
    rejected_low_confidence = 0
    rejected_out_of_bounds = 0
    rejected_too_short = 0
    route_diagnostics: list[dict[str, Any]] = []
    for index, raw in enumerate(raw_routes[:120], 1):
        if isinstance(raw, list):
            raw = {"points": raw}
        if not isinstance(raw, dict):
            rejected_invalid += 1
            continue
        raw_points = _route_point_list(raw)
        if not isinstance(raw_points, list) or not 2 <= len(raw_points) <= 64:
            rejected_invalid += 1
            if len(route_diagnostics) < 30:
                route_diagnostics.append({"index": index, "decision": "reject", "reason": "invalid-points"})
            continue
        confidence_supplied = "confidence" in raw or "score" in raw
        try:
            confidence = float(raw.get("confidence", raw.get("score", 50)))
        except (TypeError, ValueError):
            confidence = 50.0 if not confidence_supplied else float("nan")
        if 0 <= confidence <= 1:
            confidence *= 100
        if not math.isfinite(confidence) or confidence < 0 or confidence > 100:
            rejected_invalid += 1
            continue
        if confidence < min_confidence:
            rejected_low_confidence += 1
            if len(route_diagnostics) < 30:
                route_diagnostics.append({"index": index, "decision": "reject", "reason": "low-confidence", "confidence": round(confidence, 1)})
            continue
        mode = _coordinate_mode(parsed, raw)
        points: list[list[float]] = []
        valid = True
        bad_bounds = False
        for point in raw_points:
            try:
                x, y = _point_xy(point)
            except (TypeError, ValueError, KeyError):
                valid = False
                break
            if not math.isfinite(x) or not math.isfinite(y):
                valid = False
                break
            if mode == "unit":
                x, y = x * width, y * height
            elif mode == "1000":
                x, y = x * width / 1000.0, y * height / 1000.0
            if x < -2 or y < -2 or x > width + 2 or y > height + 2:
                bad_bounds = True
                valid = False
                break
            mapped = [
                round(max(0.0, min(width * scale_x - 1.0, x * scale_x)), 1),
                round(max(0.0, min(height * scale_y - 1.0, y * scale_y)), 1),
            ]
            if not points or math.dist(points[-1], mapped) >= 1.5:
                points.append(mapped)
        if not valid or len(points) < 2:
            if bad_bounds:
                rejected_out_of_bounds += 1
                reason = "out-of-bounds"
            else:
                rejected_invalid += 1
                reason = "invalid-point"
            if len(route_diagnostics) < 30:
                route_diagnostics.append({"index": index, "decision": "reject", "reason": reason})
            continue
        length = sum(math.dist(a, b) for a, b in zip(points, points[1:]))
        if length < 8.0:
            rejected_too_short += 1
            if len(route_diagnostics) < 30:
                route_diagnostics.append({"index": index, "decision": "reject", "reason": "too-short", "length": round(length, 1)})
            continue
        route_id = str(raw.get("id") or index)[:20]
        routes.append({
            "id": f"MS{route_id}", "points": points,
            "confidence": round(confidence, 1), "confidence_assumed": not confidence_supplied,
            "needs_review": confidence < 65, "source": f"moss-{model}", "include": True,
        })
        if len(route_diagnostics) < 30:
            route_diagnostics.append({"index": index, "decision": "accept", "confidence": round(confidence, 1), "length": round(length, 1), "points": len(points)})

    review_note = str(parsed.get("review_note") or parsed.get("notes") or "")[:240]
    status = {
        "available": True, "complete": True, "model": model, "provider": "moss",
        "routes": len(routes), "raw_routes": raw_count, "route_field": route_field,
        "rejected_low_confidence": rejected_low_confidence,
        "rejected_invalid": rejected_invalid,
        "rejected_out_of_bounds": rejected_out_of_bounds,
        "rejected_too_short": rejected_too_short,
        "route_diagnostics": route_diagnostics,
        "tiles": 1, "successful_tiles": 1, "failed_tiles": [],
        "image_size_sent": {"width": width, "height": height},
        "source_coordinate_scale": {"x": round(scale_x, 6), "y": round(scale_y, 6)},
        "usage": usage, "review_note": review_note, "error": None,
    }
    if routes:
        status["result_state"] = "routes_parsed"
    elif raw_count == 0:
        status["result_state"] = "model_returned_empty_routes"
        status["error"] = "MOSS успешно ответил, но вернул пустой список трубных маршрутов. Проверьте визуальную различимость линий на изображении."
    elif rejected_low_confidence == raw_count:
        status["result_state"] = "all_routes_below_confidence"
        status["error"] = f"MOSS вернул {raw_count} кандидатов, но все ниже порога confidence={min_confidence:g}."
    else:
        status["result_state"] = "all_routes_rejected_by_parser"
        status["error"] = (
            f"MOSS вернул {raw_count} кандидатов; отклонено: некорректные={rejected_invalid}, "
            f"вне изображения={rejected_out_of_bounds}, короткие={rejected_too_short}, "
            f"низкая уверенность={rejected_low_confidence}."
        )
    _progress(
        f"routes field={route_field}; raw={raw_count}; accepted={len(routes)}; "
        f"invalid={rejected_invalid}; out_of_bounds={rejected_out_of_bounds}; "
        f"too_short={rejected_too_short}; low_confidence={rejected_low_confidence}; "
        f"output_tokens={usage.get('output_tokens', 'n/a')}"
    )
    return routes, status


def test_moss_ai(image_path: str | Path, api_key: str, model: str = DEFAULT_MODEL) -> dict[str, Any]:
    result: dict[str, Any] = {"ok": False, "provider": "moss", "model": model}
    try:
        annotations, status = moss_ocr_annotations(image_path, api_key, model)
        result["ocr"] = {"ok": True, "annotations": len(annotations), "status": status}
    except Exception as error:
        result["ocr"] = {"ok": False, "error": str(error)[:320]}
    try:
        routes, status = moss_semantic_routes(image_path, api_key, model)
        result["vision"] = {
            "ok": True, "recognized": bool(routes), "routes": len(routes), "status": status,
        }
    except Exception as error:
        result["vision"] = {"ok": False, "recognized": False, "routes": 0, "error": str(error)[:320]}
    # A successful HTTP response with zero routes is connectivity success, not
    # successful pipe recognition. Keep both states explicit for the UI/test.
    result["ok"] = bool(result.get("ocr", {}).get("ok") and result.get("vision", {}).get("ok") and result.get("vision", {}).get("recognized"))
    return result
