#!/usr/bin/env python3
"""Render traced centerlines to an A3-style SVG, PNG and editable DXF.

All coordinates are image-relative. The A3 page is only a presentation sheet;
it does not establish real pipe lengths, diameters, scale or connectivity semantics.
"""
from __future__ import annotations

import json
import math
import sys
import traceback
from pathlib import Path

import cairosvg
import ezdxf
from ezdxf import units

SVG_W, SVG_H = 1400.0, 990.0
SHEET_W, SHEET_H = 420.0, 297.0
VIEW = (42.0, 112.0, 1316.0, 690.0)  # x, y, width, height in SVG units


def esc(value, max_len=500):
    text = ' '.join(str(value or '').replace('\x00', '').split())[:max_len]
    return (text.replace('&', '&amp;').replace('<', '&lt;')
            .replace('>', '&gt;').replace('"', '&quot;').replace("'", '&apos;'))


def add_text(msp, text, x_mm, y_mm, height_mm, layer='NOTES', rotation=0):
    text = esc(text, 240)
    if not text:
        return
    entity = msp.add_text(text, dxfattribs={
        'height': height_mm,
        'rotation': rotation,
        'layer': layer,
        'style': 'Standard',
    })
    entity.set_placement((x_mm, y_mm), align=ezdxf.enums.TextEntityAlignment.LEFT)


def to_sheet(point, source_width, source_height):
    x, y = float(point[0]), float(point[1])
    vx, vy, vw, vh = VIEW
    scale = min(vw / max(1, source_width), vh / max(1, source_height))
    drawn_w, drawn_h = source_width * scale, source_height * scale
    ox = vx + (vw - drawn_w) / 2.0
    oy = vy + (vh - drawn_h) / 2.0
    return ox + x / 1000.0 * source_width * scale, oy + y / 1000.0 * source_height * scale


def svg_to_mm(point):
    x, y = point
    return x * SHEET_W / SVG_W, (SVG_H - y) * SHEET_H / SVG_H


def path_points(record, source_width, source_height):
    points = record.get('points') if isinstance(record, dict) else None
    if not isinstance(points, list) or len(points) < 2:
        return []
    result = []
    for point in points:
        if not isinstance(point, (list, tuple)) or len(point) < 2:
            continue
        try:
            x = max(0.0, min(1000.0, float(point[0])))
            y = max(0.0, min(1000.0, float(point[1])))
        except (TypeError, ValueError):
            continue
        mapped = to_sheet((x, y), source_width, source_height)
        if not result or math.hypot(mapped[0] - result[-1][0], mapped[1] - result[-1][1]) > 0.45:
            result.append(mapped)
    return result if len(result) >= 2 else []


def main(vectors_path: Path, out_dir: Path):
    data = json.loads(vectors_path.read_text(encoding='utf-8'))
    out_dir.mkdir(parents=True, exist_ok=True)
    source_size = data.get('sourceSize') or {}
    source_width = max(1, int(source_size.get('width') or 1))
    source_height = max(1, int(source_size.get('height') or 1))
    primary = data.get('primaryPaths') if isinstance(data.get('primaryPaths'), list) else []
    details = data.get('detailPaths') if isinstance(data.get('detailPaths'), list) else []
    annotations = data.get('annotationPaths') if isinstance(data.get('annotationPaths'), list) else []
    ocr = data.get('ocr') if isinstance(data.get('ocr'), list) else []
    diag = data.get('diagnostics') if isinstance(data.get('diagnostics'), dict) else {}
    user_note = esc(data.get('userNote') or '', 140)
    title = 'СХЕМА · ВЕКТОРНАЯ ТРАССИРОВКА'
    subtitle = f"Штрихи: OpenCV · {source_width}×{source_height} px · масштаб не калиброван"

    svg = [f'''<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="420mm" height="297mm" viewBox="0 0 {SVG_W:.0f} {SVG_H:.0f}">
<rect width="100%" height="100%" fill="#ffffff"/>
<rect x="15" y="15" width="1370" height="960" fill="none" stroke="#111" stroke-width="1.5"/>
<g font-family="Arial, DejaVu Sans, sans-serif" fill="#111" stroke="#111">
  <text x="42" y="48" font-size="18" font-weight="bold">{esc(title)}</text>
  <text x="42" y="73" font-size="11" fill="#555" stroke="none">{esc(subtitle)}</text>
  <line x1="30" y1="88" x2="1370" y2="88" stroke-width="1.2"/>
  <rect x="1050" y="25" width="320" height="48" fill="none" stroke-width="0.9"/>
  <text x="1062" y="45" font-size="10">CAD SKETCH CONVERTER · OFFLINE</text>
  <text x="1062" y="61" font-size="9" stroke="none" fill="#555">Геометрия получена трассировкой пикселей</text>
</g>
<rect x="32" y="100" width="1336" height="716" fill="none" stroke="#b9b9b9" stroke-width="0.7"/>
''']

    dxf = ezdxf.new('R2010')
    dxf.units = units.MM
    dxf.header['$INSUNITS'] = 4
    dxf.header['$MEASUREMENT'] = 1
    for name, colour, lineweight in [
        ('SHEET', 7, 13), ('CENTERLINE_PRIMARY', 7, 25),
        ('DETAIL_TRACE', 8, 9), ('ANNOTATION_TRACE', 9, 5), ('NOTES', 7, 13),
    ]:
        if name not in dxf.layers:
            dxf.layers.new(name, dxfattribs={'color': colour, 'lineweight': lineweight})
    msp = dxf.modelspace()

    # Border and header in the DXF page coordinate system.
    border = [(15, 15), (1385, 15), (1385, 975), (15, 975)]
    msp.add_lwpolyline([svg_to_mm(p) for p in border], close=True, dxfattribs={'layer': 'SHEET'})
    msp.add_line(svg_to_mm((30, 88)), svg_to_mm((1370, 88)), dxfattribs={'layer': 'SHEET'})
    msp.add_lwpolyline([svg_to_mm(p) for p in [(1050,25),(1370,25),(1370,73),(1050,73)]], close=True, dxfattribs={'layer': 'SHEET'})
    add_text(msp, title, 12.6, 282.6, 5.4)
    add_text(msp, subtitle, 12.6, 275.2, 3.3)
    add_text(msp, 'CAD SKETCH CONVERTER - OFFLINE', 318, 283.5, 3.0)
    add_text(msp, 'Pixel-derived vectors; scale not calibrated', 318, 278.8, 2.5)

    primary_count = 0
    detail_count = 0
    annotation_count = 0
    for record in primary:
        points = path_points(record, source_width, source_height)
        if len(points) < 2:
            continue
        svg_points = ' '.join(f'{x:.2f},{y:.2f}' for x, y in points)
        svg.append(f'<polyline points="{svg_points}" fill="none" stroke="#111111" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>')
        msp.add_lwpolyline([svg_to_mm(p) for p in points], dxfattribs={'layer': 'CENTERLINE_PRIMARY'})
        primary_count += 1

    # Fine strokes are retained as a quieter secondary layer. They can be switched
    # off in CAD to simplify the drawing; they are not silently discarded.
    for record in details:
        points = path_points(record, source_width, source_height)
        if len(points) < 2:
            continue
        svg_points = ' '.join(f'{x:.2f},{y:.2f}' for x, y in points)
        svg.append(f'<polyline points="{svg_points}" fill="none" stroke="#555555" stroke-opacity="0.42" stroke-width="0.55" stroke-linecap="round" stroke-linejoin="round"/>')
        msp.add_lwpolyline([svg_to_mm(p) for p in points], dxfattribs={'layer': 'DETAIL_TRACE'})
        detail_count += 1


    # OCR-overlapping strokes are retained in a separate, very light layer. They
    # are often handwritten dimensions/notes; OCR overlap is only a hint, never
    # a reason to discard them from the editable DXF.
    for record in annotations:
        points = path_points(record, source_width, source_height)
        if len(points) < 2:
            continue
        svg_points = ' '.join(f'{x:.2f},{y:.2f}' for x, y in points)
        svg.append(f'<polyline points="{svg_points}" fill="none" stroke="#999999" stroke-opacity="0.22" stroke-width="0.42" stroke-linecap="round" stroke-linejoin="round"/>')
        msp.add_lwpolyline([svg_to_mm(p) for p in points], dxfattribs={'layer': 'ANNOTATION_TRACE'})
        annotation_count += 1

    # Notes and a conservative title block; no invented pipe sizes or dimensions.
    svg.extend([
        '<rect x="35" y="835" width="900" height="116" fill="none" stroke="#111" stroke-width="0.8"/>',
        '<line x1="35" y1="860" x2="935" y2="860" stroke="#111" stroke-width="0.8"/>',
        '<text x="48" y="852" font-size="11" font-family="Arial, DejaVu Sans, sans-serif" fill="#111" stroke="none" font-weight="bold">ПРИМЕЧАНИЯ И ПРОВЕРКИ</text>',
        '<text x="50" y="882" font-size="10" font-family="Arial, DejaVu Sans, sans-serif" fill="#333" stroke="none">1. Показаны центральные линии выделенных штрихов, а не автоматически распознанные трубы.</text>',
        '<text x="50" y="901" font-size="10" font-family="Arial, DejaVu Sans, sans-serif" fill="#333" stroke="none">2. Сверьте повороты, разветвления, пересечения и пропущенные участки с оригиналом.</text>',
        '<text x="50" y="920" font-size="10" font-family="Arial, DejaVu Sans, sans-serif" fill="#333" stroke="none">3. Реальный масштаб, диаметры и числовые размеры не определялись.</text>',
        '<rect x="960" y="835" width="405" height="116" fill="none" stroke="#111" stroke-width="0.8"/>',
        '<text x="978" y="858" font-size="11" font-family="Arial, DejaVu Sans, sans-serif" fill="#111" stroke="none" font-weight="bold">СТАТИСТИКА ТРАССИРОВКИ</text>',
        f'<text x="978" y="883" font-size="10" font-family="Arial, DejaVu Sans, sans-serif" fill="#333" stroke="none">Основные штрихи: {primary_count}</text>',
        f'<text x="978" y="902" font-size="10" font-family="Arial, DejaVu Sans, sans-serif" fill="#333" stroke="none">Детальные штрихи: {detail_count}</text>',
        f'<text x="978" y="921" font-size="10" font-family="Arial, DejaVu Sans, sans-serif" fill="#333" stroke="none">OCR-кандидаты: {len(ocr)} · подписи: {annotation_count}</text>',
        '<text x="978" y="940" font-size="9" font-family="Arial, DejaVu Sans, sans-serif" fill="#777" stroke="none">ПРЕДПРОСМОТР · ТРЕБУЕТ ПРОВЕРКИ</text>',
        (f'<text x="50" y="939" font-size="9" font-family="Arial, DejaVu Sans, sans-serif" fill="#666" stroke="none">Примечание: {user_note}</text>' if user_note else ''),
    ])
    add_text(msp, 'ПРИМЕЧАНИЯ И ПРОВЕРКИ', 14.4, 40.5, 3.3)
    add_text(msp, '1. Central lines of extracted strokes; not semantic pipe recognition.', 15.0, 34.0, 2.8)
    add_text(msp, '2. Check bends, branches, crossings and missing segments against the source.', 15.0, 28.3, 2.8)
    add_text(msp, '3. Real-world scale, diameters and numeric dimensions are not calibrated.', 15.0, 22.6, 2.8)
    add_text(msp, f'Primary strokes: {primary_count}', 293, 34.0, 2.8)
    add_text(msp, f'Detail strokes: {detail_count}', 293, 28.3, 2.8)
    add_text(msp, f'OCR / annotation strokes: {len(ocr)} / {annotation_count}', 293, 22.6, 2.8)

    svg.append('</svg>')
    svg_text = '\n'.join(svg)
    svg_path = out_dir / 'cad-redraw.svg'
    png_path = out_dir / 'cad-redraw.png'
    dxf_path = out_dir / 'cad-redraw.dxf'
    svg_path.write_text(svg_text, encoding='utf-8')
    cairosvg.svg2png(
        bytestring=svg_text.encode('utf-8'), write_to=str(png_path),
        output_width=1960, output_height=1386
    )
    dxf.saveas(dxf_path)
    return {
        'primaryPaths': primary_count,
        'detailPaths': detail_count,
        'annotationPaths': annotation_count,
        'ocrCount': len(ocr),
        'sheet': 'A3 · масштаб не калиброван',
        'width': 1960,
        'height': 1386,
    }


if __name__ == '__main__':
    try:
        if len(sys.argv) != 3:
            print('Usage: cad_renderer.py VECTORS_JSON OUTPUT_DIR', file=sys.stderr)
            sys.exit(2)
        result = main(Path(sys.argv[1]), Path(sys.argv[2]))
        print(json.dumps({'ok': True, **result}, ensure_ascii=False))
    except Exception as exc:
        print(f'CAD renderer error: {exc}', file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)
