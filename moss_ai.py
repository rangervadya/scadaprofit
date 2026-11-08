"""MOSS-VL multimodal OCR and pipe-route extraction for ScadaProfit.

Uses the official MOSS Files + Responses API. Local source files are uploaded as
private API assets, referenced by file_id, and deleted after each inference.
API keys are read only from process environment and never returned in status.
"""
from __future__ import annotations

import io
import json
import math
import mimetypes
import os
import re
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
        raise MossAIError(f"MOSS HTTP {error.code}: {detail}. {hints.get(error.code, 'Проверь доступность MOSS API.')}" ) from None
    except urllib.error.URLError as error:
        reason = _redact(str(getattr(error, "reason", "сетевой сбой")), api_key)
        raise MossAIError(f"Не удалось подключиться к MOSS: {reason}") from None
    except TimeoutError:
        raise MossAIError("Истекло время ожидания ответа MOSS.") from None
    try:
        data = json.loads(raw.decode("utf-8"))
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
        _request_json(api_key, f"{FILES_URL}/{urllib.parse.quote(file_id, safe='')}", method="DELETE", timeout=timeout)
    except Exception:
        # The file is private to the user's MOSS account; cleanup failure must
        # not discard a successful recognition result or leak credentials.
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
    image_path: str | Path,
    api_key: str,
    model: str,
    prompt: str,
    max_tokens: int,
    *,
    timeout: float,
) -> tuple[dict[str, Any], dict[str, Any]]:
    image_bytes, width, height, scale_x, scale_y = _prepare_image(image_path)
    file_id = _upload_image(api_key, image_bytes, timeout=timeout)
    try:
        payload = {
            "model": model,
            "input": [{
                "role": "user",
                "content": [
                    {"type": "input_text", "text": prompt},
                    {"type": "input_image", "file_id": file_id},
                ],
            }],
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


def moss_ocr_annotations(
    image_path: str | Path, api_key: str, model: str = DEFAULT_MODEL, *, timeout: float = 180.0
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
            "Не объединяй несколько разнесённых надписей. Максимум 100 annotations. Если текст не найден, "
            "верни пустой массив."
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

    raw_items = parsed.get("annotations")
    if not isinstance(raw_items, list):
        raise MossAIError("Ответ MOSS OCR не содержит массива annotations.")
    items: list[dict[str, Any]] = []
    rejected = 0
    for index, raw in enumerate(raw_items[:100], 1):
        if not isinstance(raw, dict):
            rejected += 1
            continue
        text_value = re.sub(r"\s+", " ", str(raw.get("text") or "")).strip()[:180]
        box = raw.get("bbox")
        try:
            if isinstance(box, dict) and all(key in box for key in ("x", "y", "w", "h")):
                x1, y1 = float(box["x"]), float(box["y"])
                x2, y2 = x1 + float(box["w"]), y1 + float(box["h"])
            elif isinstance(box, dict):
                x1, y1 = float(box.get("x1")), float(box.get("y1"))
                x2, y2 = float(box.get("x2")), float(box.get("y2"))
            elif isinstance(box, (list, tuple)) and len(box) == 4:
                x1, y1, x2, y2 = map(float, box)
            else:
                raise ValueError("bbox format")
            confidence = float(raw.get("confidence", 55))
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
        "rejected_annotations": rejected,
        "image_size_sent": {"width": width, "height": height},
        "source_coordinate_scale": {"x": round(scale_x, 6), "y": round(scale_y, 6)},
        "usage": usage, "error": None,
    }


def moss_semantic_routes(
    image_path: str | Path, api_key: str, model: str = DEFAULT_MODEL, *, timeout: float = 240.0
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Propose visible pipe centre-lines; caller validates all geometry against source ink."""
    model = str(model or DEFAULT_MODEL).strip()
    image_bytes, width, height, scale_x, scale_y = _prepare_image(image_path)
    file_id = _upload_image(api_key, image_bytes, timeout=timeout)
    try:
        prompt = (
            "Проанализируй фотографию рукописной инженерной схемы газопровода. Извлеки ТОЛЬКО "
            "видимые осевые линии труб как редактируемые полилинии. Не создавай новое изображение "
            "и не описывай схему словами. Для каждой непрерывной видимой трубы верни один маршрут "
            "с упорядоченными точками поворотов. На Т-ответвлении разделяй ветви, используя общую "
            "координату только в точке явно видимого соединения. Пересечения без доказанного соединения "
            "оставляй раздельными. Не соединяй разрывы, не достраивай скрытые участки и не угадывай "
            "геометрию. Не включай надписи, цифры, размеры, рамку, выноски, стрелки и условные символы. "
            "Каждая точка должна лежать на видимом штрихе трубы. Координаты — абсолютные пиксели "
            f"этого изображения {width}x{height}, начало (0,0) слева сверху. Верни JSON вида "
            "{\"routes\":[{\"id\":\"R1\",\"points\":[[20,80],[180,80]],\"confidence\":70}]}. "
            "confidence от 0 до 100 ориентировочная, не доказательство. Максимум 100 маршрутов, "
            "64 точки на маршрут. Если линии нельзя уверенно отличить от пометок, верни пустой routes "
            "и короткий review_note."
        )
        payload = {"model": model, "input": [{"role": "user", "content": [
            {"type": "input_text", "text": prompt}, {"type": "input_image", "file_id": file_id}
        ]}], "max_output_tokens": 7000}
        response = _request_json(api_key, RESPONSES_URL, method="POST",
                                 body=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                                 content_type="application/json", timeout=timeout)
        text, usage = _response_text(response)
        parsed = _parse_json(text)
    finally:
        _delete_image(api_key, file_id, timeout=min(timeout, 20.0))

    raw_routes = parsed.get("routes")
    if not isinstance(raw_routes, list):
        raise MossAIError("Ответ MOSS Vision не содержит массива routes.")
    min_confidence = float(os.getenv("MOSS_PIPE_MIN_CONFIDENCE", "35"))
    routes: list[dict[str, Any]] = []
    rejected_invalid = rejected_low_confidence = 0
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
            rejected_invalid += 1
            continue
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
            mapped = [round(min(width * scale_x - 1, x * scale_x), 1), round(min(height * scale_y - 1, y * scale_y), 1)]
            if not points or math.dist(points[-1], mapped) >= 2.0:
                points.append(mapped)
        if not valid or len(points) < 2:
            rejected_invalid += 1
            continue
        length = sum(math.dist(a, b) for a, b in zip(points, points[1:]))
        if length < max(12.0, min(width * scale_x, height * scale_y) * 0.01):
            rejected_invalid += 1
            continue
        routes.append({
            "id": f"MS{str(raw.get('id') or index)[:20]}", "points": points,
            "confidence": round(confidence, 1), "confidence_assumed": "confidence" not in raw,
            "needs_review": confidence < 65, "source": f"moss-{model}", "include": True,
        })
    return routes, {
        "available": True, "complete": True, "model": model, "provider": "moss",
        "routes": len(routes), "raw_routes": len(raw_routes),
        "rejected_low_confidence": rejected_low_confidence, "rejected_invalid": rejected_invalid,
        "tiles": 1, "successful_tiles": 1, "failed_tiles": [],
        "image_size_sent": {"width": width, "height": height},
        "source_coordinate_scale": {"x": round(scale_x, 6), "y": round(scale_y, 6)},
        "usage": usage, "review_note": str(parsed.get("review_note") or "")[:240], "error": None,
    }


def test_moss_ai(image_path: str | Path, api_key: str, model: str = DEFAULT_MODEL) -> dict[str, Any]:
    result: dict[str, Any] = {"ok": False, "provider": "moss", "model": model}
    try:
        annotations, status = moss_ocr_annotations(image_path, api_key, model)
        result["ocr"] = {"ok": True, "annotations": len(annotations), "status": status}
    except Exception as error:
        result["ocr"] = {"ok": False, "error": str(error)[:320]}
    try:
        routes, status = moss_semantic_routes(image_path, api_key, model)
        result["vision"] = {"ok": True, "routes": len(routes), "status": status}
    except Exception as error:
        result["vision"] = {"ok": False, "error": str(error)[:320]}
    result["ok"] = bool(result.get("ocr", {}).get("ok") and result.get("vision", {}).get("ok"))
    return result
