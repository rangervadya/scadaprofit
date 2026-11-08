"""Optional Yandex AI Studio OCR and multimodal pipe tracing.

The module deliberately uses only the Python standard library + Pillow already
installed by this app. API keys are read from the process environment and are
never written to job diagnostics or logs.
"""
from __future__ import annotations

import base64
import io
import json
import math
import os
import re
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps

OCR_URL = "https://ai.api.cloud.yandex.net/ocr/v1/recognizeText"
CHAT_URL = "https://ai.api.cloud.yandex.net/v1/chat/completions"
DEFAULT_VISION_MODEL = "qwen3.6-35b-a3b"
MAX_OCR_BYTES = 9_800_000  # leave a little headroom below the documented 10 MB limit
MAX_IMAGE_PIXELS = 20_000_000


class YandexAIError(RuntimeError):
    """Sanitized provider error; never includes request authorization headers."""


def _post_json(url: str, headers: dict[str, str], payload: dict[str, Any], timeout: float) -> dict[str, Any]:
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read(12 * 1024 * 1024)
            if response.status < 200 or response.status >= 300:
                raise YandexAIError(f"Yandex AI вернул HTTP {response.status}.")
    except urllib.error.HTTPError as error:
        try:
            detail = error.read(2048).decode("utf-8", "replace")
            parsed = json.loads(detail)
            detail = str(parsed.get("message") or parsed.get("error", {}).get("message") or detail)
        except Exception:
            detail = ""
        detail = re.sub(r"(?i)(api[-_ ]?key|authorization)\s*[:=]\s*[^,\s]+", r"\1=[скрыто]", detail)
        raise YandexAIError(f"Yandex AI HTTP {error.code}: {detail[:260] or 'ошибка запроса'}") from None
    except urllib.error.URLError as error:
        reason = str(getattr(error, "reason", "сетевой сбой"))[:180]
        raise YandexAIError(f"Не удалось подключиться к Yandex AI: {reason}") from None
    except TimeoutError:
        raise YandexAIError("Истекло время ожидания ответа Yandex AI.") from None
    try:
        data = json.loads(raw.decode("utf-8"))
    except Exception as error:
        raise YandexAIError("Yandex AI вернул некорректный JSON.") from error
    if not isinstance(data, dict):
        raise YandexAIError("Yandex AI вернул ответ неожиданного формата.")
    return data


def _prepare_image(image_path: str | Path, *, max_edge: int = 2048, max_bytes: int = MAX_OCR_BYTES) -> tuple[bytes, int, int, float, float]:
    """Normalize EXIF orientation and return a JPEG within API pixel/byte limits."""
    try:
        with Image.open(image_path) as source:
            image = ImageOps.exif_transpose(source).convert("RGB")
    except Exception as error:
        raise YandexAIError(f"Не удалось подготовить изображение для Yandex AI: {error}") from error

    original_width, original_height = image.size
    if original_width < 1 or original_height < 1:
        raise YandexAIError("Исходное изображение имеет некорректный размер.")

    pixel_scale = min(1.0, math.sqrt(MAX_IMAGE_PIXELS / float(original_width * original_height)))
    edge_scale = min(1.0, max_edge / float(max(original_width, original_height)))
    scale = min(pixel_scale, edge_scale)
    if scale < 0.999:
        image = image.resize((max(1, round(original_width * scale)), max(1, round(original_height * scale))), Image.Resampling.LANCZOS)

    quality = 92
    encoded = b""
    while quality >= 60:
        buffer = io.BytesIO()
        image.save(buffer, format="JPEG", quality=quality, optimize=True, progressive=False)
        encoded = buffer.getvalue()
        if len(encoded) <= max_bytes:
            break
        quality -= 6
    if len(encoded) > max_bytes:
        raise YandexAIError("Изображение не удалось уменьшить до лимита Yandex Vision OCR (10 МБ).")

    sent_width, sent_height = image.size
    scale_x = original_width / sent_width
    scale_y = original_height / sent_height
    return encoded, sent_width, sent_height, scale_x, scale_y


def _bbox_from_polygon(polygon: dict[str, Any] | None, scale_x: float = 1.0, scale_y: float = 1.0) -> dict[str, int] | None:
    if not isinstance(polygon, dict):
        return None
    vertices = polygon.get("vertices")
    if not isinstance(vertices, list) or len(vertices) < 2:
        return None
    points: list[tuple[float, float]] = []
    for vertex in vertices:
        if not isinstance(vertex, dict):
            continue
        try:
            x, y = float(vertex.get("x")), float(vertex.get("y"))
        except (TypeError, ValueError):
            continue
        if math.isfinite(x) and math.isfinite(y):
            points.append((x * scale_x, y * scale_y))
    if len(points) < 2:
        return None
    x1, y1 = min(p[0] for p in points), min(p[1] for p in points)
    x2, y2 = max(p[0] for p in points), max(p[1] for p in points)
    if x2 <= x1 or y2 <= y1:
        return None
    return {"x": round(x1), "y": round(y1), "w": round(x2 - x1), "h": round(y2 - y1)}


def yandex_ocr_annotations(image_path: str | Path, api_key: str, folder_id: str, *, timeout: float = 90.0) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Recognize mixed handwritten/printed RU+EN text and map boxes to source pixels."""
    if not api_key or not folder_id:
        raise YandexAIError("Не заданы YANDEX_API_KEY и YANDEX_FOLDER_ID.")
    image_bytes, sent_width, sent_height, scale_x, scale_y = _prepare_image(image_path, max_edge=4096)
    payload = {
        "mimeType": "JPEG",
        "languageCodes": ["ru", "en"],
        "model": "handwritten",
        "content": base64.b64encode(image_bytes).decode("ascii"),
    }
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Api-Key {api_key}",
        "x-folder-id": folder_id,
        "x-data-logging-enabled": "false",
    }
    response = _post_json(OCR_URL, headers, payload, timeout)
    result = response.get("result") if isinstance(response.get("result"), dict) else response
    annotation = result.get("textAnnotation") if isinstance(result, dict) else None
    if not isinstance(annotation, dict):
        raise YandexAIError("В ответе Yandex Vision OCR нет textAnnotation.")

    items: list[dict[str, Any]] = []
    for block_index, block in enumerate(annotation.get("blocks", []) if isinstance(annotation.get("blocks"), list) else [], 1):
        if not isinstance(block, dict):
            continue
        lines = block.get("lines") if isinstance(block.get("lines"), list) else []
        for line_index, line in enumerate(lines, 1):
            if not isinstance(line, dict):
                continue
            text = re.sub(r"\s+", " ", str(line.get("text") or "")).strip()
            if not text:
                words = line.get("words") if isinstance(line.get("words"), list) else []
                text = " ".join(re.sub(r"\s+", " ", str(word.get("text") or "")).strip() for word in words if isinstance(word, dict)).strip()
            bbox = _bbox_from_polygon(line.get("boundingBox"), scale_x, scale_y)
            if not bbox:
                word_boxes = [
                    _bbox_from_polygon(word.get("boundingBox"), scale_x, scale_y)
                    for word in (line.get("words") or []) if isinstance(word, dict)
                ]
                word_boxes = [box for box in word_boxes if box]
                if word_boxes:
                    x1 = min(box["x"] for box in word_boxes)
                    y1 = min(box["y"] for box in word_boxes)
                    x2 = max(box["x"] + box["w"] for box in word_boxes)
                    y2 = max(box["y"] + box["h"] for box in word_boxes)
                    bbox = {"x": x1, "y": y1, "w": x2 - x1, "h": y2 - y1}
            if not text or not bbox or bbox["w"] < 2 or bbox["h"] < 2:
                continue
            has_alnum = bool(re.search(r"[A-Za-zА-Яа-яЁё0-9ØøΦφДдУу]", text))
            items.append({
                "id": f"Y{len(items) + 1}",
                "text": text[:180],
                # OCR API currently returns word geometry but no calibrated confidence.
                "confidence": 60.0,
                "confidence_assumed": True,
                "bbox": bbox,
                "verified": False,
                "include": False,
                "needs_review": True,
                "geometry_exclude": has_alnum,
                "source": "yandex-vision-ocr",
                "provider": "yandex-cloud",
                "block_index": block_index,
                "line_index": line_index,
            })
    return items, {
        "available": True,
        "complete": True,
        "model": "vision-ocr-handwritten",
        "annotations": len(items),
        "tiles": 1,
        "successful_tiles": 1,
        "failed_tiles": [],
        "image_size_sent": {"width": sent_width, "height": sent_height},
        "source_coordinate_scale": {"x": round(scale_x, 6), "y": round(scale_y, 6)},
        "full_text_available": bool(annotation.get("fullText")),
        "error": None,
    }


ROUTE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "routes": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "points": {
                        "type": "array",
                        "items": {
                            "type": "array",
                            "items": {"type": "number"},
                        },
                    },
                    "confidence": {"type": "number"},
                },
                "required": ["points"],
            },
        },
    },
    "required": ["routes"],
}


def _parse_model_json(content: Any) -> dict[str, Any]:
    if isinstance(content, list):
        content = "".join(str(item.get("text") or "") for item in content if isinstance(item, dict))
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
    raise YandexAIError("Мультимодальная модель не вернула валидный JSON с маршрутами.")


def yandex_semantic_routes(image_path: str | Path, api_key: str, folder_id: str, model: str = DEFAULT_VISION_MODEL, *, timeout: float = 240.0) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Ask a Yandex multimodal model for visible pipe polylines; caller validates ink/topology."""
    if not api_key or not folder_id:
        raise YandexAIError("Не заданы YANDEX_API_KEY и YANDEX_FOLDER_ID.")
    model = re.sub(r"[^a-zA-Z0-9._-]", "", str(model or DEFAULT_VISION_MODEL))[:100] or DEFAULT_VISION_MODEL
    image_bytes, width, height, scale_x, scale_y = _prepare_image(image_path, max_edge=2048, max_bytes=MAX_OCR_BYTES)
    image_data = f"data:image/jpeg;base64,{base64.b64encode(image_bytes).decode('ascii')}"
    prompt = (
        "Проанализируй фотографию рукописной инженерной схемы газопровода. "
        "Нужно извлечь ТОЛЬКО геометрию видимых труб как редактируемые полилинии. "
        "Не создавай новое изображение и не описывай схему словами. "
        "Для каждой непрерывной видимой осевой линии трубы верни один route с упорядоченными точками поворотов. "
        "На ответвлении разделяй трубы на отдельные ветви, но используй одну и ту же координату только там, "
        "где на оригинале действительно виден Т-узел или соединение. Пересекающиеся линии без доказанного "
        "соединения остаются отдельными маршрутами. Не соединяй визуальные разрывы, не достраивай скрытые "
        "участки и не угадывай геометрию. Не включай надписи, цифры, размерные линии, рамку, выноски, "
        "стрелки и условные символы в трубы. Учитывай горизонтальные, вертикальные и диагональные трассы. "
        "Каждая точка должна лежать на видимом штрихе трубы. Координаты — абсолютные пиксели отправленного "
        f"изображения {width}x{height}, начало (0,0) слева сверху. "
        "Верни только JSON вида {\"routes\":[{\"id\":\"R1\",\"points\":[[x1,y1],[x2,y2]],\"confidence\":70}]}. "
        "confidence — оценка 0..100; если сомневаешься, ставь 40..60. Не выдумывай объекты. "
        "Если линии трубы нельзя уверенно отличить от пометок, верни пустой routes и добавь короткое "
        "пояснение в поле review_note. Максимум 100 маршрутов и 64 точки на маршрут."
    )
    payload = {
        "model": f"gpt://{folder_id}/{model}",
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": image_data}},
            ],
        }],
        "temperature": 0.1,
        "max_tokens": 7000,
        "stream": False,
        "response_format": {
            "type": "json_schema",
            "json_schema": {
                "name": "pipeline_routes",
                "strict": False,
                "schema": ROUTE_SCHEMA,
            },
        },
    }
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Api-Key {api_key}",
        "OpenAI-Project": folder_id,
        "x-folder-id": folder_id,
    }
    response = _post_json(CHAT_URL, headers, payload, timeout)
    choices = response.get("choices") if isinstance(response.get("choices"), list) else []
    if not choices or not isinstance(choices[0], dict):
        raise YandexAIError("Yandex Qwen3.6 не вернула вариант ответа.")
    message = choices[0].get("message") if isinstance(choices[0].get("message"), dict) else {}
    parsed = _parse_model_json(message.get("content"))
    raw_routes = parsed.get("routes")
    if not isinstance(raw_routes, list):
        raise YandexAIError("Yandex Qwen3.6 вернула JSON без массива routes.")

    original_width = round(width * scale_x)
    original_height = round(height * scale_y)
    routes: list[dict[str, Any]] = []
    rejected_invalid = 0
    rejected_low_confidence = 0
    raw_count = len(raw_routes)
    min_confidence = float(os.getenv("YANDEX_PIPE_MIN_CONFIDENCE", "35"))
    for index, raw in enumerate(raw_routes[:100], 1):
        if not isinstance(raw, dict):
            rejected_invalid += 1
            continue
        raw_points = raw.get("points")
        if not isinstance(raw_points, list) or not 2 <= len(raw_points) <= 64:
            rejected_invalid += 1
            continue
        try:
            confidence = float(raw.get("confidence", 55))
        except (TypeError, ValueError):
            confidence = 55.0
        if 0 <= confidence <= 1:
            confidence *= 100
        if not math.isfinite(confidence) or confidence < 0 or confidence > 100:
            rejected_invalid += 1
            continue
        if confidence < min_confidence:
            rejected_low_confidence += 1
            continue
        points: list[list[float]] = []
        valid = True
        for point in raw_points:
            if not isinstance(point, (list, tuple)) or len(point) < 2:
                valid = False
                break
            try:
                x, y = float(point[0]), float(point[1])
            except (TypeError, ValueError):
                valid = False
                break
            if not math.isfinite(x) or not math.isfinite(y) or x < 0 or y < 0 or x > width + 2 or y > height + 2:
                valid = False
                break
            mapped = [round(min(original_width - 1, x * scale_x), 1), round(min(original_height - 1, y * scale_y), 1)]
            if not points or math.dist(points[-1], mapped) >= 2.0:
                points.append(mapped)
        if not valid or len(points) < 2:
            rejected_invalid += 1
            continue
        length = sum(math.dist(a, b) for a, b in zip(points, points[1:]))
        if length < max(12.0, min(original_width, original_height) * 0.01):
            rejected_invalid += 1
            continue
        confidence_supplied = "confidence" in raw
        routes.append({
            "id": f"Y{str(raw.get('id') or index)[:20]}",
            "points": points,
            "confidence": round(confidence, 1),
            "confidence_assumed": not confidence_supplied,
            "needs_review": confidence < 65,
            "source": f"yandex-cloud-{model}",
            "include": True,
        })

    return routes, {
        "available": True,
        "complete": True,
        "model": model,
        "provider": "yandex-cloud",
        "routes": len(routes),
        "raw_routes": raw_count,
        "rejected_low_confidence": rejected_low_confidence,
        "rejected_invalid": rejected_invalid,
        "tiles": 1,
        "successful_tiles": 1,
        "failed_tiles": [],
        "image_size_sent": {"width": width, "height": height},
        "source_coordinate_scale": {"x": round(scale_x, 6), "y": round(scale_y, 6)},
        "usage": response.get("usage") if isinstance(response.get("usage"), dict) else None,
        "review_note": str(parsed.get("review_note") or "")[:240],
        "error": None,
        "hint": None,
    }


def test_yandex_ai(image_path: str | Path, api_key: str, folder_id: str, model: str = DEFAULT_VISION_MODEL) -> dict[str, Any]:
    """Run an explicit one-image smoke test of both configured Yandex endpoints."""
    result: dict[str, Any] = {"ok": False, "provider": "yandex-cloud", "model": model}
    try:
        annotations, ocr_status = yandex_ocr_annotations(image_path, api_key, folder_id)
        result["ocr"] = {"ok": True, "annotations": len(annotations), "status": ocr_status}
    except Exception as error:
        result["ocr"] = {"ok": False, "error": str(error)[:300]}
    try:
        routes, route_status = yandex_semantic_routes(image_path, api_key, folder_id, model)
        result["vision"] = {"ok": True, "routes": len(routes), "status": route_status}
    except Exception as error:
        result["vision"] = {"ok": False, "error": str(error)[:300]}
    result["ok"] = bool(result.get("ocr", {}).get("ok") or result.get("vision", {}).get("ok"))
    return result
