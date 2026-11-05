"""SVG and editable DXF export from cad-clean-layout/1.0."""
from __future__ import annotations

import re
from typing import Any
from xml.sax.saxutils import escape


def build_layout_svg(layout: dict[str, Any]) -> str:
    page = layout.get('page') or {'width': 1200, 'height': 850}
    width, height = int(page.get('width', 1200)), int(page.get('height', 850))
    template = layout.get('template') or {}
    fields = template.get('fields') or {}
    zones = template.get('zones') or {}
    title = escape(str(fields.get('title') or 'ТРУБОПРОВОДНАЯ СХЕМА'))
    subtitle = escape(str(fields.get('subtitle') or 'ЧИСТОВАЯ КОМПОНОВКА'))
    address = escape(str(fields.get('address') or 'Адрес: требуется заполнить'))
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="420mm" height="297mm" viewBox="0 0 {width} {height}">',
           f'<rect width="{width}" height="{height}" fill="#fff"/>',
           '<g fill="none" stroke="#15191d" stroke-width="1"><rect x="24" y="24" width="1152" height="802"/><path d="M36 78H1164 M36 88H1164 M36 740H1164 M24 760H1176 M830 760V826"/><rect x="36" y="88" width="1128" height="652" stroke="#aeb5bb" stroke-width=".55"/></g>',
           f'<text x="600" y="45" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" font-weight="bold">{title}</text>',
           f'<text x="600" y="62" text-anchor="middle" font-family="Arial,sans-serif" font-size="9">{subtitle}</text>',
           f'<text x="600" y="77" text-anchor="middle" font-family="Arial,sans-serif" font-size="7.5" fill="#555e66">{address}</text>',
           '<g data-layer="PIPE_MAIN" fill="none" stroke="#17212b" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round">']
    for pipe in layout.get('pipes', []):
        points = ' '.join(f'{float(p[0]):.2f},{float(p[1]):.2f}' for p in pipe.get('geometry', []))
        if points:
            out.append(f'<polyline data-id="{escape(str(pipe.get("id") or ""))}" points="{points}"/>')
    out.append('</g><g data-layer="SYMBOLS" fill="none" stroke="#111" stroke-width="1.25" stroke-linejoin="round">')
    for symbol in layout.get('symbols', []):
        for primitive in symbol.get('primitives', []):
            if primitive.get('kind') == 'line':
                a, b = primitive['from'], primitive['to']
                out.append(f'<line x1="{a[0]}" y1="{a[1]}" x2="{b[0]}" y2="{b[1]}"/>')
            elif primitive.get('kind') == 'polyline':
                points = ' '.join(f'{p[0]},{p[1]}' for p in primitive['points'])
                out.append(f'<polyline points="{points}"/>')
            elif primitive.get('kind') == 'circle':
                center = primitive['center']
                out.append(f'<circle cx="{center[0]}" cy="{center[1]}" r="{primitive["radius"]}"/>')
    out.append('</g>')
    for dimension in layout.get('dimensions', []):
        position = dimension.get('position') or [0, 0]
        value = escape(str(dimension.get('rawText') or dimension.get('value') or ''))
        out.append(f'<text data-layer="DIMENSIONS" x="{position[0]}" y="{position[1]}" text-anchor="middle" font-family="Arial,sans-serif" font-size="9" fill="#111" style="paint-order:stroke;stroke:#fff;stroke-width:2px">{value}</text>')
    for label in layout.get('labels', []):
        position = label.get('position') or [0, 0]
        out.append(f'<text data-layer="LABELS" x="{position[0]}" y="{position[1]}" font-family="Arial,sans-serif" font-size="8" fill="#20262b" style="paint-order:stroke;stroke:#fff;stroke-width:2px">{escape(str(label.get("text") or ""))}</text>')
    legend_zone = zones.get('legend') or {'x': 810, 'y': 535, 'w': 330, 'h': 185}
    lx, ly = float(legend_zone.get('x', 810)), float(legend_zone.get('y', 535))
    out.append(f'<g data-layer="LEGEND"><rect x="{lx}" y="{ly}" width="{legend_zone.get("w",330)}" height="{legend_zone.get("h",185)}" fill="none" stroke="#777" stroke-width=".7"/><text x="{lx+10}" y="{ly+18}" font-family="Arial,sans-serif" font-size="8" font-weight="bold">УСЛОВНЫЕ ОБОЗНАЧЕНИЯ</text>')
    for index, item in enumerate(template.get('legend') or []):
        row_y = ly + 38 + index * 22
        out.append(f'<text x="{lx+12}" y="{row_y}" font-family="Arial,sans-serif" font-size="9">{escape(str(item.get("code") or ""))}</text><text x="{lx+38}" y="{row_y}" font-family="Arial,sans-serif" font-size="7">{escape(str(item.get("label") or ""))}</text>')
    out.append('</g>')
    out.extend([f'<text x="820" y="758" font-family="Arial,sans-serif" font-size="7">Схему составил: {escape(str(fields.get("preparedBy") or "____________"))}</text>',
                f'<text x="820" y="780" font-family="Arial,sans-serif" font-size="7">Схему проверил: {escape(str(fields.get("checkedBy") or "____________"))}</text>', '</svg>'])
    return '\n'.join(out)


def build_layout_dxf(layout: dict[str, Any]) -> str:
    page_width, page_height = 1200.0, 850.0
    def mm(point: list[float]) -> tuple[float, float]:
        return float(point[0]) * 420.0 / page_width, (page_height - float(point[1])) * 297.0 / page_height
    def polyline(layer: str, points: list[list[float]], closed: bool = False) -> list[str]:
        if len(points) < 2: return []
        data = ['0','LWPOLYLINE','100','AcDbEntity','8',layer,'100','AcDbPolyline','90',str(len(points)),'70','1' if closed else '0']
        for point in points:
            x, y = mm(point); data += ['10',f'{x:.3f}','20',f'{y:.3f}']
        return data
    def text(layer: str, value: Any, point: list[float], size: float) -> list[str]:
        clean = re.sub(r'[\r\n\x00]+', ' ', str(value or '')).strip()[:240]
        if not clean: return []
        x, y = mm(point)
        return ['0','TEXT','100','AcDbEntity','8',layer,'100','AcDbText','10',f'{x:.3f}','20',f'{y:.3f}','30','0','40',f'{size:.3f}','1',clean]
    layers = [
        ('SHEET', 7, 0), ('PIPE_MAIN', 7, 0),
        ('DETAIL_REVIEW', 8, 1), ('QWEN_REVIEW', 30, 1),
        ('SYMBOLS', 3, 0), ('DIMENSIONS', 5, 0),
        ('LABELS', 7, 0), ('NOTES', 8, 0),
    ]
    data = ['0','SECTION','2','HEADER','9','$ACADVER','1','AC1021','9','$INSUNITS','70','4','0','ENDSEC','0','SECTION','2','TABLES','0','TABLE','2','LAYER','70',str(len(layers))]
    for name, color, flags in layers:
        data += ['0','LAYER','100','AcDbSymbolTableRecord','100','AcDbLayerTableRecord','2',name,'70',str(flags),'62',str(color),'6','CONTINUOUS']
    data += ['0','ENDTAB','0','ENDSEC','0','SECTION','2','ENTITIES']
    data += polyline('SHEET', [[24,24],[1176,24],[1176,826],[24,826]], True)
    for pipe in layout.get('pipes', []): data += polyline('PIPE_MAIN', pipe.get('geometry') or [])
    for symbol in layout.get('symbols', []):
        for primitive in symbol.get('primitives', []):
            if primitive.get('kind') == 'line': data += polyline('SYMBOLS', [primitive['from'], primitive['to']])
            elif primitive.get('kind') == 'polyline': data += polyline('SYMBOLS', primitive['points'])
            elif primitive.get('kind') == 'circle':
                x, y = mm(primitive['center']); radius = float(primitive['radius']) * 420.0 / page_width
                data += ['0','CIRCLE','100','AcDbEntity','8','SYMBOLS','100','AcDbCircle','10',f'{x:.3f}','20',f'{y:.3f}','30','0','40',f'{radius:.3f}']
    for dimension in layout.get('dimensions', []): data += text('DIMENSIONS', dimension.get('rawText') or dimension.get('value'), dimension.get('position') or [0,0], 3.0)
    for label in layout.get('labels', []): data += text('LABELS', label.get('text'), label.get('position') or [0,0], 2.7)
    data += text('NOTES', 'PIPELINE SCHEME - CLEAN LAYOUT', [40,52], 5.0)
    data += ['0','ENDSEC','0','EOF']
    return '\n'.join(data) + '\n'
