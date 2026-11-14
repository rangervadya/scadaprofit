"""OpenRouter multimodal OCR and pipeline geometry extraction.

Uses the OpenAI-compatible OpenRouter chat-completions API. The API key is read
only from the process environment and is never placed in diagnostics or logs.
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

API_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_MODEL = "nvidia/nemotron-3.5-super-vl:free"
MAX_IMAGE_BYTES = 8_000_000
MAX_IMAGE_EDGE = 2304


class OpenRouterAIError(RuntimeError):
    """Sanitized OpenRouter error; authorization headers are never exposed."""


def _post_json(api_key: str, payload: dict[str, Any], timeout: float) -> dict[str, Any]:
    if not api_key:
        raise OpenRouterAIError("Не задан API-ключ OpenRouter.")
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        API_URL,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
            "HTTP-Referer": "https://scadaprofit.local",
            "X-Title": "ScadaProfit",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read(12 * 1024 * 1024)
    except urllib.error.HTTPError as error:
        try:
            detail_raw = error.read(4096).decode("utf-8", "replace")
            parsed = json.loads(detail_raw)
            error_obj = parsed.get("error") if isinstance(parsed.get("error"), dict) else {}
            detail = str(error_obj.get("message") or parsed.get("message") or detail_raw)
        except Exception:
            detail = "ошибка запроса"
        detail = re.sub(r"(?i)(sk-or-v1-[A-Za-z0-9_-]+|Bearer\s+\S+|api[-_ ]?key\s*[:=]\s*\S+)", "[секрет скрыт]", detail)
        hints = {
            401: "Проверь API-ключ OpenRouter.",
            402: "Для выбранного endpoint нет доступного бесплатного лимита или провайдер запросил оплату.",
            403: "OpenRouter или провайдер отклонил доступ к модели.",
            404: "Модель временно недоступна или её идентификатор изменился.",
            429: "Достигнут лимит бесплатных запросов OpenRouter; попробуй позже.",
        }
        hint = hints.get(error.code, "Проверь доступность OpenRouter и настройки модели.")
        raise OpenRouterAIError(f"OpenRouter HTTP {error.code}: {detail[:240]}. {hint}") from None
    except urllib.error.URLError as error:
        reason = str(getattr(error, "reason", "сетевой сбой"))[:180]
        raise OpenRouterAIError(f"Не удалось подключиться к OpenRouter: {reason}") from None
    except TimeoutError:
        raise OpenRouterAIError("Истекло время ожидания ответа OpenRouter.") from None
    try:
        data = json.loads(raw.decode("utf-8"))
    except Exception:
        raise OpenRouterAIError("OpenRouter вернул некорректный JSON.") from None
    if not isinstance(data, dict):
        raise OpenRouterAIError("OpenRouter вернул ответ неожиданного формата.")
    return data


def _prepare_image(image_path: str | Path, max_edge: int = MAX_IMAGE_EDGE) -> tuple[str, int, int, float, float]:
    try:
        with Image.open(image_path) as source:
            image = ImageOps.exif_transpose(source).convert("RGB")
    except Exception as error:
        raise OpenRouterAIError(f"Не удалось открыть исходное изображение: {error}") from error

    original_width, original_height = image.size
    if original_width < 1 or original_height < 1:
        raise OpenRouterAIError("Исходное изображение имеет некорректный размер.")
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
        raise OpenRouterAIError("Не удалось уменьшить изображение до безопасного лимита 8 МБ.")
    sent_width, sent_height = image.size
    data_url = "data:image/jpeg;base64," + base64.b64encode(encoded).decode("ascii")
    return data_url, sent_width, sent_height, original_width / sent_width, original_height / sent_height


def _parse_json(content: Any) -> dict[str, Any]:
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
    raise OpenRouterAIError("Модель не вернула корректный JSON. Повтори тест позже.")


def _chat(api_key: str, model: str, image_data: str, prompt: str, max_tokens: int, timeout: float) -> tuple[dict[str, Any], dict[str, Any]]:
    model = str(model or DEFAULT_MODEL).strip()
    if not re.fullmatch(r"[A-Za-z0-9._:/-]{3,180}", model):
        raise OpenRouterAIError("Недопустимое название модели OpenRouter.")
    payload = {
        "model": model,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": image_data}},
            ],
        }],
        "temperature": 0.1,
        "max_tokens": max_tokens,
        "stream": False,
        "response_format": {"type": "json_object"},
    }
    response = _post_json(api_key, payload, timeout)
    choices = response.get("choices") if isinstance(response.get("choices"), list) else []
    if not choices or not isinstance(choices[0], dict):
        raise OpenRouterAIError("OpenRouter не вернул вариант ответа модели.")
    message = choices[0].get("message") if isinstance(choices[0].get("message"), dict) else {}
    parsed = _parse_json(message.get("content"))
    usage = response.get("usage") if isinstance(response.get("usage"), dict) else {}
    return parsed, usage


def openrouter_ocr_annotations(
    image_path: str | Path, api_key: str, model: str = DEFAULT_MODEL, *, timeout: float = 180.0
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Extract visible handwritten labels and pixel boxes from the whole image."""
    image_data, width, height, scale_x, scale_y = _prepare_image(image_path)
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
    parsed, usage = _chat(api_key, model, image_data, prompt, 5000, timeout)
    raw_items = parsed.get("annotations")
    if not isinstance(raw_items, list):
        raise OpenRouterAIError("Ответ OCR не содержит массива annotations.")
    original_width = round(width * scale_x)
    original_height = round(height * scale_y)
    items: list[dict[str, Any]] = []
    rejected = 0
    for index, raw in enumerate(raw_items[:100], 1):
        if not isinstance(raw, dict):
            rejected += 1
            continue
        text = re.sub(r"\s+", " ", str(raw.get("text") or "")).strip()[:180]
        box = raw.get("bbox")
        try:
            if isinstance(box, dict) and all(key in box for key in ("x", "y", "w", "h")):
                x1, y1 = float(box.get("x")), float(box.get("y"))
                x2, y2 = x1 + float(box.get("w")), y1 + float(box.get("h"))
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
        if not text or not all(math.isfinite(v) for v in (x1, y1, x2, y2, confidence)):
            rejected += 1
            continue
        if 0 <= confidence <= 1:
            confidence *= 100
        if confidence < 0 or confidence > 100 or x2 <= x1 or y2 <= y1:
            rejected += 1
            continue
        # Reject implausible boxes; clamp small edge overflows caused by model rounding.
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
        has_alnum = bool(re.search(r"[A-Za-zА-Яа-яЁё0-9ØøΦφДдУу]", text))
        items.append({
            "id": f"OR{index}", "text": text,
            "confidence": round(confidence, 1),
            "confidence_assumed": "confidence" not in raw, "bbox": bbox,
            "verified": False, "include": False, "needs_review": True,
            "geometry_exclude": has_alnum,
            "source": "openrouter-vision-ocr", "provider": "openrouter",
        })
    return items, {
        "available": True, "complete": True, "model": model,
        "provider": "openrouter", "annotations": len(items),
        "tiles": 1, "successful_tiles": 1, "failed_tiles": [],
        "rejected_annotations": rejected,
        "image_size_sent": {"width": width, "height": height},
        "source_coordinate_scale": {"x": round(scale_x, 6), "y": round(scale_y, 6)},
        "usage": usage, "error": None,
    }


def openrouter_semantic_routes(
    image_path: str | Path, api_key: str, model: str = DEFAULT_MODEL, *, timeout: float = 240.0
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Propose visible pipe centre-line polylines; caller validates every route against source ink."""
    image_data, width, height, scale_x, scale_y = _prepare_image(image_path)
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
    parsed, usage = _chat(api_key, model, image_data, prompt, 7000, timeout)
    raw_routes = parsed.get("routes")
    if not isinstance(raw_routes, list):
        raise OpenRouterAIError("Ответ vision не содержит массива routes.")
    original_width = round(width * scale_x)
    original_height = round(height * scale_y)
    min_confidence = float(os.getenv("OPENROUTER_PIPE_MIN_CONFIDENCE", "35"))
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
        routes.append({
            "id": f"OR{str(raw.get('id') or index)[:20]}",
            "points": points, "confidence": round(confidence, 1),
            "confidence_assumed": "confidence" not in raw,
            "needs_review": confidence < 65,
            "source": f"openrouter-{model}", "include": True,
        })
    return routes, {
        "available": True, "complete": True, "model": model,
        "provider": "openrouter", "routes": len(routes), "raw_routes": len(raw_routes),
        "rejected_low_confidence": rejected_low_confidence, "rejected_invalid": rejected_invalid,
        "tiles": 1, "successful_tiles": 1, "failed_tiles": [],
        "image_size_sent": {"width": width, "height": height},
        "source_coordinate_scale": {"x": round(scale_x, 6), "y": round(scale_y, 6)},
        "usage": usage, "review_note": str(parsed.get("review_note") or "")[:240], "error": None,
    }


def test_openrouter_ai(image_path: str | Path, api_key: str, model: str = DEFAULT_MODEL) -> dict[str, Any]:
    result: dict[str, Any] = {"ok": False, "provider": "openrouter", "model": model}
    try:
        annotations, status = openrouter_ocr_annotations(image_path, api_key, model)
        result["ocr"] = {"ok": True, "annotations": len(annotations), "status": status}
    except Exception as error:
        result["ocr"] = {"ok": False, "error": str(error)[:320]}
    try:
        routes, status = openrouter_semantic_routes(image_path, api_key, model)
        result["vision"] = {"ok": True, "routes": len(routes), "status": status}
    except Exception as error:
        result["vision"] = {"ok": False, "error": str(error)[:320]}
    result["ok"] = bool(result.get("ocr", {}).get("ok") and result.get("vision", {}).get("ok"))
    return result
