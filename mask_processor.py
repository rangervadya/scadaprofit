#!/usr/bin/env python3
"""Configurable two-mask segmentation: OCR text mask and remaining pen-line mask."""
from __future__ import annotations

import base64
import json
import sys
from io import BytesIO
from typing import Any

import cv2
import numpy as np
from PIL import Image, ImageOps

MAX_DIMENSION = 2200


def clamp(value: Any, default: float, low: float, high: float, cast=float):
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = float(default)
    number = max(low, min(high, number))
    return cast(round(number) if cast is int else number)


def decode_image(raw: bytes) -> np.ndarray:
    if not raw:
        raise ValueError("Пустой файл изображения.")
    try:
        pil = Image.open(BytesIO(raw))
        pil = ImageOps.exif_transpose(pil).convert("RGB")
        if max(pil.size) > MAX_DIMENSION:
            scale = MAX_DIMENSION / max(pil.size)
            pil = pil.resize((max(1, round(pil.width * scale)), max(1, round(pil.height * scale))), Image.Resampling.LANCZOS)
        return cv2.cvtColor(np.asarray(pil), cv2.COLOR_RGB2BGR)
    except Exception as exc:
        raise ValueError(f"Не удалось прочитать изображение: {exc}") from exc


def estimate_dominant_hue(hsv: np.ndarray) -> int | None:
    h, s, v = cv2.split(hsv)
    eligible = (s >= 24) & (v >= 25) & (v <= 250)
    values = h[eligible]
    values = values[(values >= 5) & (values <= 175)]
    if values.size < 40:
        return None
    hist = np.bincount(values, minlength=180)
    smooth = np.convolve(hist.astype(np.float32), np.array([1, 2, 3, 2, 1], np.float32), mode="same")
    peak = int(np.argmax(smooth))
    if hist[peak] < max(8, int(values.size * 0.002)):
        return None
    return peak


def build_ink_mask(
    image: np.ndarray,
    mode: str = "auto",
    hue_min: int = 90,
    hue_max: int = 145,
    hue_tolerance: int = 24,
    saturation_min: int = 18,
    min_brightness: int = 20,
    max_brightness: int = 252,
    dark_threshold: int = 132,
    min_component_area: int = 2,
) -> tuple[np.ndarray, dict[str, Any]]:
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    h, s, v = cv2.split(hsv)
    dominant = estimate_dominant_hue(hsv)
    selected_mode = mode
    low_h, high_h = int(hue_min), int(hue_max)

    if mode == "auto":
        if dominant is None:
            selected_mode = "dark"
        else:
            selected_mode = "color"
            low_h = max(0, dominant - int(hue_tolerance))
            high_h = min(179, dominant + int(hue_tolerance))
    elif mode == "purple":
        low_h, high_h = 112, 175
    elif mode == "blue":
        low_h, high_h = int(hue_min), int(hue_max)
    elif mode == "anycolor":
        selected_mode = "anycolor"

    if selected_mode in ("blue", "color"):
        color_mask = cv2.inRange(
            hsv,
            np.array([low_h, int(saturation_min), int(min_brightness)]),
            np.array([high_h, 255, int(max_brightness)]),
        )
        mask = color_mask
        hue_range: list[int] | None = [low_h, high_h]
    elif selected_mode == "purple":
        mask = cv2.inRange(
            hsv,
            np.array([low_h, int(saturation_min), int(min_brightness)]),
            np.array([high_h, 255, int(max_brightness)]),
        )
        hue_range = [low_h, high_h]
    elif selected_mode == "anycolor":
        colored = (s >= int(saturation_min)) & (v >= int(min_brightness)) & (v <= int(max_brightness))
        neutral_dark = (gray <= int(dark_threshold)) & (s <= 55)
        mask = np.where(colored | neutral_dark, 255, 0).astype(np.uint8)
        hue_range = [0, 179]
    else:
        mask = cv2.inRange(gray, 0, int(dark_threshold))
        hue_range = None

    # Configurable removal of isolated speckles; 1 preserves every detected pixel.
    min_area = max(1, int(min_component_area))
    if min_area > 1:
        n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
        cleaned = np.zeros_like(mask)
        for label in range(1, n):
            if int(stats[label, cv2.CC_STAT_AREA]) >= min_area:
                cleaned[labels == label] = 255
        mask = cleaned

    info = {
        "modeRequested": mode,
        "modeUsed": selected_mode,
        "dominantHue": dominant,
        "hueRange": hue_range,
        "saturationMin": int(saturation_min),
        "brightnessRange": [int(min_brightness), int(max_brightness)],
        "darkThreshold": int(dark_threshold),
        "minComponentArea": min_area,
    }
    return mask, info


def preprocess_for_ocr(image: np.ndarray, ink_mask: np.ndarray, method: str) -> np.ndarray:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    if method == "ink":
        # Tesseract sees only detected pen pixels on a clean white background.
        return cv2.bitwise_not(ink_mask)
    if method == "clahe":
        clahe = cv2.createCLAHE(clipLimit=2.2, tileGridSize=(8, 8))
        return clahe.apply(gray)
    if method == "otsu":
        blur = cv2.GaussianBlur(gray, (3, 3), 0)
        _threshold, binary = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
        return cv2.bitwise_not(binary)
    if method == "adaptive":
        block = max(15, (min(gray.shape[:2]) // 18) | 1)
        binary = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, block, 11)
        return binary
    return gray


def detect_text_boxes(
    image: np.ndarray,
    ink_mask: np.ndarray,
    min_confidence: float = 35.0,
    scale: float = 2.0,
    psm: int = 11,
    language: str = "eng+rus",
    preprocess: str = "original",
    min_box_width: int = 4,
    min_box_height: int = 3,
) -> tuple[list[dict[str, Any]], list[str], dict[str, Any]]:
    warnings: list[str] = []
    try:
        import pytesseract
        from pytesseract import Output
    except Exception as exc:
        return [], [f"Python-модуль Tesseract недоступен: {exc}"], {"available": False}

    allowed_psm = {3, 4, 6, 7, 8, 11, 12, 13}
    psm = int(psm) if int(psm) in allowed_psm else 11
    preprocess_name = preprocess if preprocess in {"original", "ink", "clahe", "otsu", "adaptive"} else "ink"
    lang = language if language in {"eng+rus", "eng", "rus"} else "eng+rus"
    scale = max(1.0, min(3.0, float(scale)))
    ocr_image = preprocess_for_ocr(image, ink_mask, preprocess_name)
    if scale != 1:
        ocr_image = cv2.resize(
            ocr_image, None, fx=scale, fy=scale,
            interpolation=cv2.INTER_CUBIC if scale > 1 else cv2.INTER_AREA,
        )

    config = f"--oem 1 --psm {psm} -c preserve_interword_spaces=1"
    try:
        data = pytesseract.image_to_data(
            ocr_image, lang=lang, config=config,
            output_type=Output.DICT, timeout=55,
        )
    except Exception as exc:
        warnings.append(f"OCR {lang}, PSM {psm} завершился с ошибкой: {exc}")
        return [], warnings, {"available": False, "language": lang, "psm": psm, "preprocess": preprocess_name, "scale": scale}

    height, width = image.shape[:2]
    boxes: list[dict[str, Any]] = []
    raw_words = 0
    for i, raw_text in enumerate(data.get("text", [])):
        text = str(raw_text or "").strip()
        try:
            confidence = float(data["conf"][i])
        except (TypeError, ValueError):
            continue
        if not text:
            continue
        raw_words += 1
        if confidence < min_confidence:
            continue
        x = max(0, int(round(int(data["left"][i]) / scale)))
        y = max(0, int(round(int(data["top"][i]) / scale)))
        w = max(0, int(round(int(data["width"][i]) / scale)))
        h = max(0, int(round(int(data["height"][i]) / scale)))
        if w < min_box_width or h < min_box_height or x >= width or y >= height:
            continue
        boxes.append({
            "text": text[:80], "confidence": round(confidence, 1),
            "x": x, "y": y, "width": min(w, width - x), "height": min(h, height - y),
        })

    info = {
        "available": True, "language": lang, "psm": psm,
        "preprocess": preprocess_name, "scale": scale,
        "rawWords": raw_words, "keptBoxes": len(boxes),
        "minConfidence": float(min_confidence),
        "minBoxWidth": int(min_box_width), "minBoxHeight": int(min_box_height),
    }
    return boxes, warnings, info


def build_two_masks(
    ink_mask: np.ndarray,
    boxes: list[dict[str, Any]],
    padding: int = 1,
    padding_ratio: float = 0.0,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    height, width = ink_mask.shape[:2]
    text_regions = np.zeros_like(ink_mask)
    pad_px = max(0, min(24, int(padding)))
    ratio = max(0.0, min(1.0, float(padding_ratio) / 100.0))

    for box in boxes:
        x, y = int(box["x"]), int(box["y"])
        w, h = int(box["width"]), int(box["height"])
        extra = pad_px + round(min(w, h) * ratio)
        x1, y1 = max(0, x - extra), max(0, y - extra)
        x2, y2 = min(width - 1, x + w + extra), min(height - 1, y + h + extra)
        cv2.rectangle(text_regions, (x1, y1), (x2, y2), 255, thickness=-1)

    text_mask = cv2.bitwise_and(ink_mask, text_regions)
    line_mask = cv2.bitwise_and(ink_mask, cv2.bitwise_not(text_regions))
    return text_mask, line_mask, text_regions


def encode_png(mask: np.ndarray) -> str:
    ok, encoded = cv2.imencode(".png", mask, [cv2.IMWRITE_PNG_COMPRESSION, 6])
    if not ok:
        raise RuntimeError("Не удалось закодировать PNG-маску.")
    return base64.b64encode(encoded.tobytes()).decode("ascii")


def make_overlay(image: np.ndarray, text_mask: np.ndarray, line_mask: np.ndarray) -> np.ndarray:
    base = cv2.cvtColor(image, cv2.COLOR_BGR2BGRA)
    overlay = np.zeros_like(base)
    overlay[text_mask > 0] = (40, 80, 255, 150)
    overlay[line_mask > 0] = (255, 170, 35, 170)
    alpha = overlay[:, :, 3:4].astype(np.float32) / 255.0
    mixed = base[:, :, :3].astype(np.float32) * (1 - alpha) + overlay[:, :, :3].astype(np.float32) * alpha
    return np.clip(mixed, 0, 255).astype(np.uint8)


def process(raw: bytes, config: dict[str, Any] | None = None) -> dict[str, Any]:
    config = config or {}
    image = decode_image(raw)
    settings = {
        "mode": str(config.get("mode", "blue")),
        "minConfidence": clamp(config.get("minConfidence"), 35, 0, 95),
        "padding": clamp(config.get("padding"), 1, 0, 24, int),
        "paddingRatio": clamp(config.get("paddingRatio"), 0, 0, 100),
        "ocrScale": clamp(config.get("ocrScale"), 2, 1, 3),
        "psm": clamp(config.get("psm"), 11, 3, 13, int),
        "language": str(config.get("language", "eng+rus")),
        "preprocess": str(config.get("preprocess", "original")),
        "minBoxWidth": clamp(config.get("minBoxWidth"), 4, 1, 40, int),
        "minBoxHeight": clamp(config.get("minBoxHeight"), 3, 1, 40, int),
        "hueMin": clamp(config.get("hueMin"), 90, 0, 179, int),
        "hueMax": clamp(config.get("hueMax"), 145, 0, 179, int),
        "hueTolerance": clamp(config.get("hueTolerance"), 24, 5, 60, int),
        "saturationMin": clamp(config.get("saturationMin"), 18, 0, 200, int),
        "minBrightness": clamp(config.get("minBrightness"), 20, 0, 150, int),
        "maxBrightness": clamp(config.get("maxBrightness"), 252, 100, 255, int),
        "darkThreshold": clamp(config.get("darkThreshold"), 132, 30, 230, int),
        "minComponentArea": clamp(config.get("minComponentArea"), 2, 1, 50, int),
    }
    if settings["hueMin"] > settings["hueMax"]:
        settings["hueMin"], settings["hueMax"] = settings["hueMax"], settings["hueMin"]

    ink, mode_info = build_ink_mask(
        image, settings["mode"], settings["hueMin"], settings["hueMax"],
        settings["hueTolerance"], settings["saturationMin"], settings["minBrightness"],
        settings["maxBrightness"], settings["darkThreshold"], settings["minComponentArea"],
    )
    boxes, warnings, ocr_info = detect_text_boxes(
        image, ink, settings["minConfidence"], settings["ocrScale"], settings["psm"],
        settings["language"], settings["preprocess"], settings["minBoxWidth"], settings["minBoxHeight"],
    )
    text_mask, line_mask, text_regions = build_two_masks(ink, boxes, settings["padding"], settings["paddingRatio"])
    overlay = make_overlay(image, text_mask, line_mask)

    ink_pixels = int(cv2.countNonZero(ink))
    text_pixels = int(cv2.countNonZero(text_mask))
    line_pixels = int(cv2.countNonZero(line_mask))
    if ink_pixels == 0:
        warnings.append("Цветовой фильтр не нашёл чернильных штрихов. Попробуй изменить режим, оттенок или насыщенность.")
    if not boxes:
        warnings.append("OCR не нашёл областей выше выбранного порога. Маска текста пустая; все найденные чернила остаются в маске линий.")
    if text_pixels + line_pixels != ink_pixels:
        warnings.append("Маски не образуют точного разделения чернил. Смотри исходную маску чернил.")

    return {
        "ok": True, "width": int(image.shape[1]), "height": int(image.shape[0]),
        "mode": mode_info, "settings": settings, "ocr": ocr_info,
        "stats": {
            "inkPixels": ink_pixels, "textPixels": text_pixels, "linePixels": line_pixels,
            "ocrBoxes": len(boxes), "ocrRawWords": ocr_info.get("rawWords", 0),
            "recognizedTextSamples": [box["text"] for box in boxes[:50]],
            "textCoveragePercent": round((text_pixels / ink_pixels * 100), 1) if ink_pixels else 0,
            "lineCoveragePercent": round((line_pixels / ink_pixels * 100), 1) if ink_pixels else 0,
        },
        "warnings": warnings, "boxes": boxes,
        "masks": {
            "inkPngBase64": encode_png(ink), "textPngBase64": encode_png(text_mask),
            "linesPngBase64": encode_png(line_mask), "overlayPngBase64": encode_png(overlay),
        },
    }


def main() -> int:
    try:
        config = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
        raw = sys.stdin.buffer.read()
        result = process(raw, config)
        sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 0
    except Exception as exc:
        sys.stderr.write(f"mask_processor error: {type(exc).__name__}: {exc}\n")
        sys.stdout.write(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
