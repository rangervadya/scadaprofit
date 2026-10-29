#!/usr/bin/env python3
"""Offline image cleanup, OCR, and contour-based SVG/DXF tracing for CAD Sketch Converter."""
from __future__ import annotations
import json
import math
import os
import sys
import traceback
import time
from pathlib import Path

import cv2
import numpy as np
cv2.setNumThreads(2)


def fit_to_sheet(width: int, height: int):
    if width >= height:
        sheet_w, sheet_h = 297.0, 210.0
    else:
        sheet_w, sheet_h = 210.0, 297.0
    margin = 8.0
    scale = min((sheet_w - margin * 2) / max(width, 1), (sheet_h - margin * 2) / max(height, 1))
    drawn_w, drawn_h = width * scale, height * scale
    offset_x = (sheet_w - drawn_w) / 2.0
    offset_y = (sheet_h - drawn_h) / 2.0
    return sheet_w, sheet_h, scale, offset_x, offset_y


def get_ocr(gray, binary):
    """Run one bounded OCR pass; drawings with dense tiny annotations can be expensive."""
    try:
        import pytesseract
        from pytesseract import Output
        # OCR at a moderate resolution to avoid spending minutes on dense dimension lines.
        h, w = gray.shape[:2]
        factor = min(1.0, 1500 / max(w, h))
        ocr_img = gray if factor >= 1.0 else cv2.resize(gray, (round(w * factor), round(h * factor)), interpolation=cv2.INTER_AREA)
        try:
            data = pytesseract.image_to_data(ocr_img, lang='rus+eng', config='--oem 1 --psm 11', output_type=Output.DICT, timeout=18)
        except RuntimeError as exc:
            return [], f'OCR прерван по тайм-ауту: {exc}'
        candidates = []
        for i, raw in enumerate(data.get('text', [])):
            text = ' '.join(str(raw).split()).strip()
            try:
                conf = float(data['conf'][i])
            except (ValueError, TypeError, KeyError):
                conf = -1
            if text and conf >= 25:
                candidates.append((conf, text))
        best = {}
        for conf, text in candidates:
            key = text.casefold()
            if key not in best or conf > best[key]:
                best[key] = conf
        ordered = sorted(best.items(), key=lambda item: (-item[1], item[0]))
        return [text for text, _ in ordered[:120]], None
    except Exception as exc:
        return [], str(exc)


def contour_trace(binary, out_dir: Path):
    height, width = binary.shape[:2]
    ink = cv2.bitwise_not(binary)
    contours, hierarchy = cv2.findContours(ink, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
    sheet_w, sheet_h, scale, ox, oy = fit_to_sheet(width, height)

    # Fit the source onto an A4-like sheet in millimetres, preserving its aspect ratio.
    svg_paths = []
    dxf_points = []
    retained = 0
    max_contours = 60000
    hierarchy_arr = hierarchy[0] if hierarchy is not None else []
    for idx, contour in enumerate(contours[:max_contours]):
        if len(contour) < 3:
            continue
        area = abs(float(cv2.contourArea(contour)))
        perimeter = float(cv2.arcLength(contour, True))
        if area < 1.2 and perimeter < 8:
            continue
        epsilon = max(0.65, 0.001 * perimeter)
        approx = cv2.approxPolyDP(contour, epsilon, True).reshape(-1, 2)
        if len(approx) < 3:
            continue
        # Keep the line art as black vector filled contours in SVG. evenodd keeps holes white.
        pts_svg = []
        pts_dxf = []
        for px, py in approx:
            x = ox + float(px) * scale
            y = oy + float(py) * scale
            pts_svg.append((x, y))
            pts_dxf.append((x, sheet_h - y))
        path_commands = [f'M {pts_svg[0][0]:.3f} {pts_svg[0][1]:.3f}']
        path_commands.extend(f'L {x:.3f} {y:.3f}' for x, y in pts_svg[1:])
        path_commands.append('Z')
        svg_paths.append(' '.join(path_commands))
        dxf_points.append(pts_dxf)
        retained += 1

    svg_header = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{sheet_w:.0f}mm" height="{sheet_h:.0f}mm" '
        f'viewBox="0 0 {sheet_w:.3f} {sheet_h:.3f}">\n'
        '<title>CAD Sketch Converter — monochrome contour trace</title>\n'
        '<rect width="100%" height="100%" fill="white"/>\n'
        '<path fill="none" stroke="#000000" stroke-width="0.18" stroke-linejoin="round" stroke-linecap="round" d="'
    )
    svg_text = svg_header + ' '.join(svg_paths) + '"/>\n</svg>\n'
    (out_dir / 'trace.svg').write_text(svg_text, encoding='utf-8')

    import ezdxf
    from ezdxf import units
    doc = ezdxf.new('R2010')
    doc.units = units.MM
    doc.header['$INSUNITS'] = 4
    doc.header['$MEASUREMENT'] = 1
    doc.header['$LIMMIN'] = (0, 0)
    doc.header['$LIMMAX'] = (sheet_w, sheet_h)
    doc.layers.new(name='TRACED_CONTOURS', dxfattribs={'color': 7, 'lineweight': 13})
    doc.layers.new(name='SHEET', dxfattribs={'color': 7})
    msp = doc.modelspace()
    # Contours represent traced pixel boundaries; they are vector geometry, not semantic CAD pipes/text.
    for points in dxf_points:
        if len(points) >= 3:
            msp.add_lwpolyline(points, close=True, dxfattribs={'layer': 'TRACED_CONTOURS', 'color': 7})
    doc.saveas(out_dir / 'trace.dxf')
    return {'contours': retained, 'width': width, 'height': height, 'sheet': f'{sheet_w:.0f} x {sheet_h:.0f} mm'}


def main():
    if len(sys.argv) != 3:
        print('Usage: processor.py INPUT_IMAGE OUTPUT_DIR', file=sys.stderr)
        return 2
    source = Path(sys.argv[1])
    out_dir = Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)
    t0 = time.perf_counter()
    raw = np.fromfile(str(source), dtype=np.uint8)
    image = cv2.imdecode(raw, cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError('Не удалось прочитать файл как изображение.')
    original_h, original_w = image.shape[:2]
    if original_w < 32 or original_h < 32:
        raise RuntimeError('Изображение слишком маленькое для обработки.')

    # Limit working resolution to avoid unbounded memory use on the 16 GB server.
    max_dim = 2200
    factor = min(1.0, max_dim / max(original_w, original_h))
    if factor < 1.0:
        image = cv2.resize(image, (max(1, round(original_w * factor)), max(1, round(original_h * factor))), interpolation=cv2.INTER_AREA)
    height, width = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    # Light denoising plus local thresholding removes uneven paper illumination while preserving strokes.
    denoised = cv2.medianBlur(gray, 3)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(denoised)
    block_size = 41 if min(width, height) > 100 else 21
    if block_size >= min(width, height):
        block_size = max(3, min(width, height) // 2 * 2 - 1)
    binary = cv2.adaptiveThreshold(enhanced, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, block_size, 11)
    # Remove isolated 1px noise without heavy morphology that would erase tiny dimensions.
    ink = cv2.bitwise_not(binary)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(ink, connectivity=8)
    keep_component = (stats[:, cv2.CC_STAT_AREA] >= 2) | (stats[:, cv2.CC_STAT_WIDTH] >= 3) | (stats[:, cv2.CC_STAT_HEIGHT] >= 3)
    keep_component[0] = False  # always discard the background component
    cleaned_ink = (keep_component[labels].astype(np.uint8) * 255)
    clean = cv2.bitwise_not(cleaned_ink)
    cv2.imwrite(str(out_dir / 'clean.png'), clean)
    print(f'Preprocess finished in {time.perf_counter()-t0:.1f}s', file=sys.stderr, flush=True)

    # Smaller preview for the vision model, retaining source colour/handwriting.
    analysis_image = image.copy()
    max_analysis = 1600
    if max(width, height) > max_analysis:
        ratio = max_analysis / max(width, height)
        analysis_image = cv2.resize(analysis_image, (round(width * ratio), round(height * ratio)), interpolation=cv2.INTER_AREA)
    cv2.imwrite(str(out_dir / 'vision.jpg'), analysis_image, [int(cv2.IMWRITE_JPEG_QUALITY), 96])

    # Use overlapping tiles for dense/high-resolution drawings. This gives the vision model
    # larger local details while retaining enough overlap to merge shared junctions.
    analysis_h, analysis_w = analysis_image.shape[:2]
    vision_tiles = []
    should_tile = max(analysis_w, analysis_h) >= 1200 and min(analysis_w, analysis_h) >= 520
    if should_tile:
        tile_w = max(1, int(round(analysis_w * 0.62)))
        tile_h = max(1, int(round(analysis_h * 0.62)))
        x_starts = sorted(set([0, max(0, analysis_w - tile_w)]))
        y_starts = sorted(set([0, max(0, analysis_h - tile_h)]))
        tile_index = 0
        for y0 in y_starts:
            for x0 in x_starts:
                crop = analysis_image[y0:y0 + tile_h, x0:x0 + tile_w]
                if crop.size == 0:
                    continue
                tile_index += 1
                filename = f'vision-tile-{tile_index}.jpg'
                cv2.imwrite(str(out_dir / filename), crop, [int(cv2.IMWRITE_JPEG_QUALITY), 96])
                crop_gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
                background_level = float(np.median(crop_gray))
                ink_ratio = float(np.mean(crop_gray < max(0.0, background_level - 25.0)))
                vision_tiles.append({
                    'file': filename, 'index': tile_index, 'x': x0, 'y': y0,
                    'width': int(crop.shape[1]), 'height': int(crop.shape[0]),
                    'fullWidth': analysis_w, 'fullHeight': analysis_h,
                    'inkRatio': round(ink_ratio, 5)
                })
    if not vision_tiles:
        crop_gray = cv2.cvtColor(analysis_image, cv2.COLOR_BGR2GRAY)
        vision_tiles = [{
            'file': 'vision.jpg', 'index': 1, 'x': 0, 'y': 0,
            'width': analysis_w, 'height': analysis_h,
            'fullWidth': analysis_w, 'fullHeight': analysis_h,
            'inkRatio': round(float(np.mean(crop_gray < max(0.0, float(np.median(crop_gray)) - 25.0))), 5)
        }]
    print(f'Vision tiles prepared: {len(vision_tiles)} ({analysis_w}x{analysis_h})', file=sys.stderr, flush=True)

    print('OCR: processing image (bounded timeout)', file=sys.stderr, flush=True)
    t_ocr = time.perf_counter()
    ocr_items, ocr_error = get_ocr(enhanced, clean)
    print(f'OCR finished in {time.perf_counter()-t_ocr:.1f}s', file=sys.stderr, flush=True)
    t_trace = time.perf_counter()
    print('Vectorizing contours', file=sys.stderr, flush=True)
    trace = contour_trace(clean, out_dir)
    print(f'Vectorization finished in {time.perf_counter()-t_trace:.1f}s', file=sys.stderr, flush=True)
    payload = {
        'ok': True,
        'source_size': {'width': original_w, 'height': original_h},
        'processed_size': {'width': width, 'height': height},
        'vision_size': {'width': analysis_w, 'height': analysis_h},
        'vision_tiles': vision_tiles,
        'ocr': ocr_items,
        'ocr_error': ocr_error,
        'trace': trace,
        'note': 'SVG/DXF — контурная векторизация пикселей, а не распознанная инженерная топология. Размеры и соединения нужно проверить вручную.'
    }
    (out_dir / 'result.json').write_text(json.dumps(payload, ensure_ascii=False), encoding='utf-8')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as exc:
        print(f'Ошибка обработки: {exc}', file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)
