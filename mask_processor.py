#!/usr/bin/env python3
"""Two-mask image segmentation: OCR text mask and remaining pen-line mask."""
from __future__ import annotations

import base64
import json
import sys
from typing import Any

import cv2
import numpy as np
from PIL import Image, ImageOps
from io import BytesIO

MAX_DIMENSION = 1800


def decode_image(raw: bytes) -> np.ndarray:
    if not raw:
        raise ValueError("Пустой файл изображения.")
    try:
        pil = Image.open(BytesIO(raw))
        pil = ImageOps.exif_transpose(pil).convert("RGB")
        if max(pil.size) > MAX_DIMENSION:
            scale = MAX_DIMENSION / max(pil.size)
            pil = pil.resize((max(1, round(pil.width * scale)), max(1, round(pil.height * scale))), Image.Resampling.LANCZOS)
        rgb = np.asarray(pil)
        return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    except Exception as exc:
        raise ValueError(f"Не удалось прочитать изображение: {exc}") from exc


def estimate_dominant_hue(hsv: np.ndarray) -> int | None:
    h, s, v = cv2.split(hsv)
    eligible = (s >= 28) & (v >= 25) & (v <= 250)
    values = h[eligible]
    if values.size < 40:
        return None
    # Ignore near-red hue edges because compression artifacts there are common.
    values = values[(values >= 5) & (values <= 175)]
    if values.size < 40:
        return None
    hist = np.bincount(values, minlength=180)
    # Smooth adjacent hue bins so slight color variation does not split the peak.
    smooth = np.convolve(hist.astype(np.float32), np.array([1, 2, 3, 2, 1], np.float32), mode="same")
    peak = int(np.argmax(smooth))
    if hist[peak] < max(8, int(values.size * 0.002)):
        return None
    return peak


def build_ink_mask(image: np.ndarray, mode: str = "auto") -> tuple[np.ndarray, dict[str, Any]]:
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    h, s, v = cv2.split(hsv)

    dominant = estimate_dominant_hue(hsv)
    selected_mode = mode
    if mode == "auto":
        selected_mode = "color" if dominant is not None else "dark"

    if selected_mode == "blue":
        lower_h, upper_h = 90, 145
        color_mask = cv2.inRange(hsv, np.array([lower_h, 18, 20]), np.array([upper_h, 255, 252]))
        mask = color_mask
        hue_range: list[int] | None = [lower_h, upper_h]
    elif selected_mode == "color" and dominant is not None:
        low = max(0, dominant - 19)
        high = min(179, dominant + 19)
        color_mask = cv2.inRange(hsv, np.array([low, 18, 20]), np.array([high, 255, 252]))
        # A restrained neutral dark-ink component also keeps pencil/black annotations.
        neutral = cv2.bitwise_and(cv2.inRange(gray, 0, 112), cv2.inRange(s, 0, 48))
        mask = cv2.bitwise_or(color_mask, neutral)
        hue_range = [low, high]
    else:
        # Monochrome fallback for black pencil/pen on paper. The threshold is deliberately
        # conservative to avoid treating paper shadows as ink.
        mask = cv2.inRange(gray, 0, 132)
        hue_range = None

    # Remove isolated single-pixel compression noise, but preserve tiny handwritten marks.
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    cleaned = np.zeros_like(mask)
    for label in range(1, n):
        area = int(stats[label, cv2.CC_STAT_AREA])
        if area >= 2:
            cleaned[labels == label] = 255

    info = {
        "modeRequested": mode,
        "modeUsed": selected_mode,
        "dominantHue": dominant,
        "hueRange": hue_range,
    }
    return cleaned, info


def detect_text_boxes(image: np.ndarray, min_confidence: float = 15.0) -> tuple[list[dict[str, Any]], list[str]]:
    warnings: list[str] = []
    try:
        import pytesseract
        from pytesseract import Output
    except Exception as exc:
        return [], [f"Python-модуль Tesseract недоступен: {exc}"]

    boxes: list[dict[str, Any]] = []
    langs = "eng+rus"
    try:
        data = pytesseract.image_to_data(image, lang=langs, config="--oem 1 --psm 11", output_type=Output.DICT, timeout=40)
    except Exception as exc:
        warnings.append(f"OCR eng+rus завершился с ошибкой: {exc}")
        try:
            langs = "eng"
            data = pytesseract.image_to_data(image, lang=langs, config="--oem 1 --psm 11", output_type=Output.DICT, timeout=40)
            warnings.append("Использован резервный OCR-язык eng.")
        except Exception as fallback_exc:
            return [], warnings + [f"OCR не смог обработать изображение: {fallback_exc}"]

    height, width = image.shape[:2]
    count = len(data.get("text", []))
    for i in range(count):
        text = str(data["text"][i] or "").strip()
        try:
            confidence = float(data["conf"][i])
        except (TypeError, ValueError):
            continue
        if not text or confidence < min_confidence:
            continue
        x = max(0, int(data["left"][i]))
        y = max(0, int(data["top"][i]))
        w = max(0, int(data["width"][i]))
        h = max(0, int(data["height"][i]))
        if w < 2 or h < 3 or x >= width or y >= height:
            continue
        boxes.append({
            "text": text[:80],
            "confidence": round(confidence, 1),
            "x": x,
            "y": y,
            "width": min(w, width - x),
            "height": min(h, height - y),
        })
    return boxes, warnings


def build_two_masks(
    ink_mask: np.ndarray,
    boxes: list[dict[str, Any]],
    padding: int = 3,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    height, width = ink_mask.shape[:2]
    text_regions = np.zeros_like(ink_mask)
    pad = max(0, min(24, int(padding)))

    for box in boxes:
        x = int(box["x"])
        y = int(box["y"])
        w = int(box["width"])
        h = int(box["height"])
        # Proportional padding handles both small digits and larger handwritten words.
        extra = max(pad, min(10, round(min(w, h) * 0.10)))
        x1 = max(0, x - extra)
        y1 = max(0, y - extra)
        x2 = min(width - 1, x + w + extra)
        y2 = min(height - 1, y + h + extra)
        cv2.rectangle(text_regions, (x1, y1), (x2, y2), 255, thickness=-1)

    # Text mask shows only actual ink pixels inside OCR's text regions, not solid OCR boxes.
    text_mask = cv2.bitwise_and(ink_mask, text_regions)
    # Line mask is the remaining detected pen ink outside text regions.
    non_text_regions = cv2.bitwise_not(text_regions)
    line_mask = cv2.bitwise_and(ink_mask, non_text_regions)

    # Masks are a strict partition of detected ink: no geometry is smoothed,
    # connected, deleted, or synthesized at this stage.
    return text_mask, line_mask, text_regions


def encode_png(mask: np.ndarray) -> str:
    ok, encoded = cv2.imencode(".png", mask, [cv2.IMWRITE_PNG_COMPRESSION, 6])
    if not ok:
        raise RuntimeError("Не удалось закодировать PNG-маску.")
    return base64.b64encode(encoded.tobytes()).decode("ascii")


def make_overlay(image: np.ndarray, text_mask: np.ndarray, line_mask: np.ndarray) -> np.ndarray:
    base = cv2.cvtColor(image, cv2.COLOR_BGR2BGRA)
    overlay = np.zeros_like(base)
    overlay[text_mask > 0] = (40, 80, 255, 150)   # Red/orange: OCR text pixels
    overlay[line_mask > 0] = (255, 170, 35, 170) # Cyan/blue: remaining line pixels
    alpha = overlay[:, :, 3:4].astype(np.float32) / 255.0
    mixed = base[:, :, :3].astype(np.float32) * (1 - alpha) + overlay[:, :, :3].astype(np.float32) * alpha
    return np.clip(mixed, 0, 255).astype(np.uint8)


def process(raw: bytes, mode: str = "auto", min_confidence: float = 15.0, padding: int = 3) -> dict[str, Any]:
    image = decode_image(raw)
    ink, mode_info = build_ink_mask(image, mode)
    boxes, warnings = detect_text_boxes(image, min_confidence)
    text_mask, line_mask, text_regions = build_two_masks(ink, boxes, padding)
    overlay = make_overlay(image, text_mask, line_mask)

    ink_pixels = int(cv2.countNonZero(ink))
    text_pixels = int(cv2.countNonZero(text_mask))
    line_pixels = int(cv2.countNonZero(line_mask))
    if ink_pixels == 0:
        warnings.append("Цветовой фильтр не нашёл чернильных штрихов. Попробуй режим «Синий» или «Чёрный/карандаш».")
    if not boxes:
        warnings.append("Tesseract не нашёл текстовых областей с выбранной уверенностью. Маска текста будет пустой, маска линий сохранит все найденные штрихи.")
    if text_pixels + line_pixels != ink_pixels:
        warnings.append("Маски не образуют точного разделения чернил. Смотри исходную маску чернил.")

    return {
        "ok": True,
        "width": int(image.shape[1]),
        "height": int(image.shape[0]),
        "mode": mode_info,
        "stats": {
            "inkPixels": ink_pixels,
            "textPixels": text_pixels,
            "linePixels": line_pixels,
            "ocrBoxes": len(boxes),
            "recognizedTextSamples": [box["text"] for box in boxes[:35]],
            "textCoveragePercent": round((text_pixels / ink_pixels * 100), 1) if ink_pixels else 0,
            "lineCoveragePercent": round((line_pixels / ink_pixels * 100), 1) if ink_pixels else 0,
        },
        "warnings": warnings,
        "boxes": boxes,
        "masks": {
            "inkPngBase64": encode_png(ink),
            "textPngBase64": encode_png(text_mask),
            "linesPngBase64": encode_png(line_mask),
            "overlayPngBase64": encode_png(overlay),
        },
    }


def main() -> int:
    try:
        config = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
        raw = sys.stdin.buffer.read()
        result = process(
            raw,
            mode=str(config.get("mode", "auto")),
            min_confidence=float(config.get("minConfidence", 15)),
            padding=int(config.get("padding", 3)),
        )
        sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
        return 0
    except Exception as exc:
        sys.stderr.write(f"mask_processor error: {type(exc).__name__}: {exc}\n")
        sys.stdout.write(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
