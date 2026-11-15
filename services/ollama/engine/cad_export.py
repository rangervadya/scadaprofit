"""CAD export (SVG/DXF) extracted from processor.py (P2-1).

Pure geometry/serialisation helpers: they depend only on the graph, annotations
and semantic routes, never on the OCR/Qwen pipeline.
"""

from __future__ import annotations

import math
import re
from typing import Any


def _sheet_layout(width: int, height: int) -> tuple[float, float, float]:
    pagew, pageh = 1200.0, 850.0
    draw_x, draw_y, draw_w, draw_h = 36.0, 88.0, 1128.0, 652.0
    scale = min(draw_w / max(width, 1), draw_h / max(height, 1))
    tx = draw_x + (draw_w - width * scale) / 2.0
    ty = draw_y + (draw_h - height * scale) / 2.0
    return scale, tx, ty


def _semantic_route_chains(semantic_routes: list[dict[str, Any]] | None) -> list[list[list[float]]]:
    """Validate semantic centre-lines before they are used as primary CAD geometry."""
    result: list[list[list[float]]] = []
    for route in semantic_routes or []:
        if not isinstance(route, dict) or not route.get('include', True):
            continue
        try:
            confidence = float(route.get('confidence', 0))
        except (TypeError, ValueError):
            continue
        if confidence < 35:
            continue
        raw_points = route.get('points')
        if not isinstance(raw_points, list) or len(raw_points) < 2:
            continue
        points: list[list[float]] = []
        for raw in raw_points[:160]:
            if not isinstance(raw, (list, tuple)) or len(raw) < 2:
                continue
            try:
                point = [float(raw[0]), float(raw[1])]
            except (TypeError, ValueError):
                continue
            if not all(math.isfinite(value) for value in point):
                continue
            if not points or math.dist(points[-1], point) >= 2.0:
                points.append(point)
        if len(points) >= 2 and sum(math.dist(points[i], points[i + 1]) for i in range(len(points) - 1)) >= 12:
            result.append(_clean_cad_points(points))
    return result



def _annotation_export_kind(annotation: dict[str, Any]) -> str | None:
    """Return VERIFIED_TEXT or TEXT_REVIEW for visible OCR content."""
    text = re.sub(r'\s+', ' ', str(annotation.get('text') or '')).strip()
    box = annotation.get('bbox') or {}
    if not text or not all(key in box for key in ('x', 'y', 'w', 'h')):
        return None
    if annotation.get('verified') and annotation.get('include', True):
        return 'VERIFIED_TEXT'
    try:
        confidence = float(annotation.get('confidence', 0) or 0)
    except (TypeError, ValueError):
        confidence = 0.0
    source = str(annotation.get('source') or '')
    if source == 'qwen3-vl-block' or (confidence >= 38 and text != '?'):
        return 'TEXT_REVIEW'
    return None


def _primary_semantic_chains(primary_routes: list[dict[str, Any]] | None) -> list[list[list[float]]]:
    return [route['points'] for route in (primary_routes or [])
            if isinstance(route, dict) and route.get('include', True)
            and isinstance(route.get('points'), list) and len(route['points']) >= 2]

def _cad_edge_chains(edges: list[dict[str, Any]]) -> list[list[list[float]]]:
    """Join degree-two graph edges into clean editable CAD polylines."""
    selected = []
    for index, source in enumerate(edges):
        if not source.get('cad_include', source.get('component_role') == 'line_structure') or len(source.get('geometry') or []) < 2:
            continue
        edge = dict(source)
        edge.setdefault('id', f'__edge_{index}')
        edge.setdefault('from', f'__node_{index}_a')
        edge.setdefault('to', f'__node_{index}_b')
        selected.append(edge)
    adjacency: dict[str, list[dict[str, Any]]] = {}
    for edge in selected:
        adjacency.setdefault(edge['from'], []).append(edge)
        adjacency.setdefault(edge['to'], []).append(edge)
    visited: set[str] = set()
    chains: list[list[list[float]]] = []

    def trace(start_node: str, first_edge: dict[str, Any]) -> None:
        node = start_node
        edge = first_edge
        points: list[list[float]] = []
        while edge and edge['id'] not in visited:
            visited.add(edge['id'])
            geometry = edge['geometry']
            oriented = geometry if edge['from'] == node else list(reversed(geometry))
            if not points:
                points.extend([[float(point[0]), float(point[1])] for point in oriented])
            else:
                points.extend([[float(point[0]), float(point[1])] for point in oriented[1:]])
            next_node = edge['to'] if edge['from'] == node else edge['from']
            candidates = [item for item in adjacency.get(next_node, []) if item['id'] not in visited]
            if len(adjacency.get(next_node, [])) != 2 or not candidates:
                break
            node, edge = next_node, candidates[0]
        cleaned = _clean_cad_points(points)
        if len(cleaned) >= 2:
            chains.append(cleaned)

    for node, incident in adjacency.items():
        if len(incident) == 2:
            continue
        for edge in incident:
            if edge['id'] not in visited:
                trace(node, edge)
    for edge in selected:
        if edge['id'] not in visited:
            trace(edge['from'], edge)
    return chains



def _clean_cad_points(points: list[list[float]]) -> list[list[float]]:
    """Remove detector jitter and square only corners already close to orthogonal."""
    unique: list[list[float]] = []
    for point in points:
        item = [float(point[0]), float(point[1])]
        if not unique or math.dist(unique[-1], item) > 0.8:
            unique.append(item)
    if len(unique) < 3:
        return [[round(x, 1), round(y, 1)] for x, y in unique]

    def axis_kind(a: list[float], b: list[float]) -> str:
        dx, dy = b[0] - a[0], b[1] - a[1]
        length = math.hypot(dx, dy)
        if length < 8:
            return ''
        tolerance = max(1.0, length * 0.035)
        if abs(dy) <= tolerance:
            return 'H'
        if abs(dx) <= tolerance:
            return 'V'
        return ''

    for _ in range(2):
        for index in range(1, len(unique) - 1):
            incoming = axis_kind(unique[index - 1], unique[index])
            outgoing = axis_kind(unique[index], unique[index + 1])
            if incoming == 'H' and outgoing == 'V':
                unique[index] = [unique[index + 1][0], unique[index - 1][1]]
            elif incoming == 'V' and outgoing == 'H':
                unique[index] = [unique[index - 1][0], unique[index + 1][1]]
            elif incoming == 'H' and outgoing == 'H':
                unique[index][1] = (unique[index - 1][1] + unique[index + 1][1]) / 2.0
            elif incoming == 'V' and outgoing == 'V':
                unique[index][0] = (unique[index - 1][0] + unique[index + 1][0]) / 2.0

    simplified = [unique[0]]
    for index in range(1, len(unique) - 1):
        a, b, c = simplified[-1], unique[index], unique[index + 1]
        ab = (b[0] - a[0], b[1] - a[1])
        bc = (c[0] - b[0], c[1] - b[1])
        la, lb = math.hypot(*ab), math.hypot(*bc)
        cross = abs(ab[0] * bc[1] - ab[1] * bc[0])
        dot = ab[0] * bc[0] + ab[1] * bc[1]
        if not (la > 1 and lb > 1 and dot > 0 and cross / (la * lb) < 0.035):
            simplified.append(b)
    simplified.append(unique[-1])

    # Ramer-Douglas-Peucker: remove small hand-drawn / detector zig-zags while
    # preserving actual corners and branches. Tolerance is in source pixels.
    tolerance = max(2.4, min(1200.0, 850.0) * 0.006)

    def distance_to_segment(point, start, end):
        dx, dy = end[0] - start[0], end[1] - start[1]
        length_sq = dx * dx + dy * dy
        if length_sq < 1e-9:
            return math.dist(point, start)
        t = max(0.0, min(1.0, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / length_sq))
        projection = (start[0] + t * dx, start[1] + t * dy)
        return math.dist(point, projection)

    def rdp(values):
        if len(values) <= 2:
            return values
        max_distance, split = 0.0, 0
        for index in range(1, len(values) - 1):
            distance = distance_to_segment(values[index], values[0], values[-1])
            if distance > max_distance:
                max_distance, split = distance, index
        if max_distance <= tolerance:
            return [values[0], values[-1]]
        return rdp(values[:split + 1])[:-1] + rdp(values[split:])

    return [[round(x, 1), round(y, 1)] for x, y in rdp(simplified)]





def build_clean_svg(width:int,height:int,edges:list[dict],annotations:list[dict],title='Трубопроводная схема', semantic_routes: list[dict[str, Any]] | None = None, semantic_status: dict[str, Any] | None = None, primary_semantic_routes: list[dict[str, Any]] | None = None) -> str:
    """Create a clean A3 CAD sheet: uniform linework and editable OCR text."""
    pagew, pageh = 1200, 850
    scale, tx, ty = _sheet_layout(width, height)
    line_width = max(0.18, 0.62 / max(scale, 0.001))
    out=[
        f'<svg xmlns="http://www.w3.org/2000/svg" width="420mm" height="297mm" viewBox="0 0 {pagew} {pageh}">',
        '<rect width="1200" height="850" fill="#fff"/>',
        '<g fill="none" stroke="#15191d" stroke-width="1.0">',
        '<rect x="24" y="24" width="1152" height="802"/>',
        '<path d="M 36 78 H 1164 M 36 88 H 1164 M 36 740 H 1164 M 24 760 H 1176 M 830 760 V 826"/>',
        '<rect x="36" y="88" width="1128" height="652" stroke="#aeb5bb" stroke-width="0.55"/>',
        '<rect x="1010" y="32" width="154" height="34" stroke-width="0.65"/>',
        '<path d="M 1010 49 H 1164" stroke-width="0.55"/>',
        '</g>',
        f'<text x="40" y="52" font-family="Arial,sans-serif" font-size="16" font-weight="bold" fill="#15191d">{xml_escape(title.upper())}</text>',
        '<text x="40" y="68" font-family="Arial,sans-serif" font-size="7.5" fill="#555e66">АВТОМАТИЧЕСКАЯ ВЕКТОРНАЯ РЕКОНСТРУКЦИЯ · ИСХОДНЫЙ МАСШТАБ НЕ КАЛИБРОВАН</text>',
        '<text x="1022" y="44" font-family="Arial,sans-serif" font-size="7" fill="#5b646b">ФОРМАТ</text>',
        '<text x="1022" y="61" font-family="Arial,sans-serif" font-size="10" font-weight="bold" fill="#15191d">A3 · ЛИСТ 1/1</text>',
        f'<g transform="translate({tx:.3f} {ty:.3f}) scale({scale:.7f})" fill="none" stroke="#15191d" stroke-width="{line_width:.4f}" stroke-linecap="round" stroke-linejoin="round">'
    ]
    # The primary drawing must not depend on a vision model's incomplete or
    # geometrically degenerate route list. Use the detector graph after its
    # topology/length/symbol-stub selection. Every usable Qwen trajectory also
    # remains visible in the frozen QWEN_REVIEW layer, never silently promoted.
    clean_chains = _cad_edge_chains(edges)
    semantic_primary_chains = _primary_semantic_chains(primary_semantic_routes)
    for chain in clean_chains + semantic_primary_chains:
        pts=' '.join(f'{float(point[0]):.2f},{float(point[1]):.2f}' for point in chain)
        out.append(f'<polyline points="{pts}"/>')
    out.append('</g>')
    # Preserve every non-primary detector fragment on an explicit dashed layer.
    # This does not claim that review fragments are connected pipe geometry.
    review_chains = _cad_edge_chains([
        {**edge, 'cad_include': True}
        for edge in edges
        if not edge.get('cad_include', edge.get('component_role') == 'line_structure')
        and edge.get('cad_reason') != 'text-or-annotation'
        and edge.get('component_role') != 'text_or_annotation'
        and edge.get('suggested_role') != 'text_or_dimension'
    ])
    if review_chains:
        out.append(f'<g data-layer="DETAIL_REVIEW" fill="none" stroke="#85919a" stroke-width="{max(0.14, line_width * 0.78):.4f}" stroke-dasharray="5 4" stroke-linecap="round" stroke-linejoin="round" transform="translate({tx:.3f} {ty:.3f}) scale({scale:.7f})">')
        for chain in review_chains:
            pts=' '.join(f'{float(point[0]):.2f},{float(point[1]):.2f}' for point in chain)
            out.append(f'<polyline points="{pts}"/>')
        out.append('</g>')
    primary_route_ids = {str(route.get('id')) for route in (primary_semantic_routes or [])}
    qwen_review_chains: list[list[list[float]]] = []
    for route in (semantic_routes or []):
        if not isinstance(route, dict) or str(route.get('id')) in primary_route_ids:
            continue
        # Even routes that Qwen itself marked uncertain/not-included are shown
        # on a review-only layer. This increases visual recall without silently
        # adding them to the main network or changing their validation status.
        try:
            confidence = float(route.get('confidence', 0) or 0)
        except (TypeError, ValueError):
            confidence = 0.0
        if confidence < 20:
            continue
        raw_points = route.get('points')
        if not isinstance(raw_points, list) or len(raw_points) < 2:
            continue
        # Keep only traces located on the source page. Invalid coordinate
        # spaces must not be exported around the centre of the CAD sheet.
        valid_points = []
        for point in raw_points[:160]:
            if not isinstance(point, (list, tuple)) or len(point) < 2:
                continue
            try:
                px, py = float(point[0]), float(point[1])
            except (TypeError, ValueError):
                continue
            if math.isfinite(px) and math.isfinite(py) and 0 <= px <= width and 0 <= py <= height:
                valid_points.append([px, py])
        if len(valid_points) < 2:
            continue
        display_route = {**route, 'points': valid_points, 'include': True, 'confidence': max(35.0, confidence)}
        qwen_review_chains.extend(_semantic_route_chains([display_route]))
    if qwen_review_chains:
        out.append(f'<g data-layer="QWEN_REVIEW" fill="none" stroke="#9a7caf" stroke-width="{max(0.13, line_width * 0.72):.4f}" stroke-dasharray="7 5" stroke-linecap="round" stroke-linejoin="round" transform="translate({tx:.3f} {ty:.3f}) scale({scale:.7f})">')
        for chain in qwen_review_chains:
            pts=' '.join(f'{float(point[0]):.2f},{float(point[1]):.2f}' for point in chain)
            out.append(f'<polyline points="{pts}"/>')
        out.append('</g>')
    if not clean_chains and not semantic_primary_chains:
        out.append('<text x="600" y="404" text-anchor="middle" font-family="Arial,sans-serif" font-size="13" font-weight="bold" fill="#a45f2a">НЕ НАЙДЕНЫ ОСНОВНЫЕ ГЕОМЕТРИЧЕСКИЕ ЛИНИИ</text>')
        detail = (semantic_status or {}).get('error') or 'Проверьте исходное изображение и параметры выделения геометрии.'
        hint = (semantic_status or {}).get('hint') or 'Результаты Qwen сохранены отдельно для проверки.'
        out.append(f'<text x="600" y="426" text-anchor="middle" font-family="Arial,sans-serif" font-size="7.5" fill="#6b747a">{xml_escape(str(detail)[:150])}</text>')
        out.append(f'<text x="600" y="442" text-anchor="middle" font-family="Arial,sans-serif" font-size="7.5" fill="#6b747a">{xml_escape(str(hint)[:150])}</text>')

    # OCR output is rendered as editable typography without a rectangular
    # backplate; a thin white text stroke preserves legibility over linework.
    for annotation in annotations:
        export_kind = _annotation_export_kind(annotation)
        if not export_kind:
            continue
        box=annotation.get('bbox') or {}
        # Row-level OCR annotations (e.g. a numbered table row) carry a bbox
        # for the whole row. Centre anchoring shifts every value toward the
        # middle of the row; keep the transcript anchored at its true left edge.
        x=tx+float(box.get('x',0))*scale
        y=ty+(float(box.get('y',0))+float(box.get('h',0)))*scale
        label=str(annotation['text'])
        label_width=max(24.0, min(220.0, len(label)*4.8+8.0))
        text_color = '#15191d' if export_kind == 'VERIFIED_TEXT' else '#8b6334'
        font_size = 8 if export_kind == 'VERIFIED_TEXT' else 7
        font_weight = '600' if export_kind == 'VERIFIED_TEXT' else '400'
        out.append(f'<text data-layer="{export_kind}" x="{x:.2f}" y="{y+1.0:.2f}" font-family="Arial,sans-serif" font-size="{font_size}" font-weight="{font_weight}" text-anchor="start" fill="{text_color}" style="paint-order:stroke;stroke:#fff;stroke-width:2px;stroke-linejoin:round">{xml_escape(label)}</text>')

    out += [
        '<text x="40" y="783" font-family="Arial,sans-serif" font-size="8" font-weight="bold" fill="#15191d">ОБОЗНАЧЕНИЯ И ПРИМЕЧАНИЯ</text>',
        '<text x="40" y="801" font-family="Arial,sans-serif" font-size="7" fill="#505960">Надписи OCR преобразованы в редактируемый текст. Геометрия показана отдельными CAD-полилиниями.</text>',
        '<text x="40" y="816" font-family="Arial,sans-serif" font-size="7" fill="#505960">Проверьте узлы, пересечения и размеры по оригиналу перед изготовлением или монтажом.</text>',
        '<text x="850" y="783" font-family="Arial,sans-serif" font-size="7" fill="#5b646b">ТИП ДОКУМЕНТА</text>',
        '<text x="850" y="801" font-family="Arial,sans-serif" font-size="9" font-weight="bold" fill="#15191d">СХЕМА ТРУБОПРОВОДА</text>',
        '<text x="850" y="816" font-family="Arial,sans-serif" font-size="7" fill="#505960">МАСШТАБ: НЕ ОПРЕДЕЛЁН · СТАТУС: ПРОВЕРИТЬ</text>',
        '</svg>'
    ]
    return '\n'.join(out)

def xml_escape(s:str)->str:
    return str(s).replace('&','&amp;').replace('<','&lt;').replace('>','&gt;').replace('"','&quot;')


def build_dxf(width:int,height:int,edges:list[dict],annotations:list[dict], semantic_routes: list[dict[str, Any]] | None = None, primary_semantic_routes: list[dict[str, Any]] | None = None) -> str:
    """Export the same A3 sheet layout to AutoCAD-compatible millimetre units."""
    pagew, pageh = 1200.0, 850.0
    scale, tx, ty = _sheet_layout(width, height)

    def page_to_mm(point):
        x, y = point
        return (x * 420.0 / pagew, (pageh - y) * 297.0 / pageh)

    def dxf_text(layer, text, x, y, height_mm):
        value = re.sub(r'[\r\n\x00]+', ' ', str(text or '')).strip()[:240]
        if not value:
            return []
        return ['0','TEXT','100','AcDbEntity','8',layer,'100','AcDbText',
                '10',f'{x:.3f}','20',f'{y:.3f}','30','0',
                '40',f'{height_mm:.3f}','1',value]

    def dxf_polyline(layer, points, closed=False, lineweight=13):
        if len(points) < 2:
            return []
        out=['0','LWPOLYLINE','100','AcDbEntity','8',layer,'100','AcDbPolyline',
             '370',str(lineweight),'90',str(len(points)),'70','1' if closed else '0']
        for point in points:
            x,y=page_to_mm(point)
            out += ['10',f'{x:.3f}','20',f'{y:.3f}']
        return out

    d=['0','SECTION','2','HEADER','9','$ACADVER','1','AC1021',
       '9','$INSUNITS','70','4','0','ENDSEC',
       '0','SECTION','2','TABLES',
       '0','TABLE','2','LTYPE','5','5','330','0','100','AcDbSymbolTable','70','1',
       '0','LTYPE','5','14','330','5','100','AcDbSymbolTableRecord','100','AcDbLinetypeTableRecord',
       '2','CONTINUOUS','70','0','3','Solid line','72','65','73','0','40','0.0',
       '0','ENDTAB',
       '0','TABLE','2','LAYER','5','2','330','0','100','AcDbSymbolTable','70','7']
    for handle, (name, colour, lineweight, flags) in enumerate([
        ('SHEET',7,13,0),('PIPE_MAIN',7,13,0),('DETAIL_REVIEW',8,9,1),('QWEN_REVIEW',30,9,1),('VERIFIED_TEXT',7,13,0),('TEXT_REVIEW',30,9,1),('NOTES',8,9,0)
    ], start=32):
        d += ['0','LAYER','5',format(handle,'X'),'330','2','100','AcDbSymbolTableRecord',
              '100','AcDbLayerTableRecord','2',name,'70',str(flags),'62',str(colour),'6','CONTINUOUS','370',str(lineweight)]
    d += ['0','ENDTAB','0','ENDSEC','0','SECTION','2','ENTITIES']

    # A3 frame, title rules and simple technical title block.
    d += dxf_polyline('SHEET',[(24,24),(1176,24),(1176,826),(24,826)],True)
    d += dxf_polyline('SHEET',[(36,78),(1164,78)])
    d += dxf_polyline('SHEET',[(36,88),(1164,88)])
    d += dxf_polyline('SHEET',[(36,740),(1164,740)])
    d += dxf_polyline('SHEET',[(24,760),(1176,760)])
    d += dxf_polyline('SHEET',[(830,760),(830,826)])
    d += dxf_polyline('SHEET',[(36,88),(1164,88),(1164,740),(36,740)],True,9)
    d += dxf_polyline('SHEET',[(1010,32),(1164,32),(1164,66),(1010,66)],True,9)
    d += dxf_polyline('SHEET',[(1010,49),(1164,49)],False,9)

    # Primary CAD geometry comes from the selected OpenCV topology graph. This
    # selection already suppresses short symbol strokes and retains coherent
    # line paths; Qwen is deliberately not allowed to replace it wholesale.
    clean_chains = _cad_edge_chains(edges)
    semantic_primary_chains = _primary_semantic_chains(primary_semantic_routes)
    for chain in clean_chains + semantic_primary_chains:
        page_points=[(tx+float(point[0])*scale,ty+float(point[1])*scale) for point in chain]
        d += dxf_polyline('PIPE_MAIN',page_points,False,13)

    # Keep rejected/ambiguous detector fragments on a frozen layer.
    for edge in edges:
        if edge.get('cad_include', edge.get('component_role') == 'line_structure'):
            continue
        geometry = edge.get('geometry') or []
        if len(geometry) >= 2:
            page_points=[(tx+float(point[0])*scale,ty+float(point[1])*scale) for point in geometry]
            d += dxf_polyline('DETAIL_REVIEW',page_points,False,9)

    # Semantic traces from Qwen are useful diagnostics, but are not trusted as
    # primary geometry until their coordinates and coverage are validated.
    # They are therefore preserved on a separate frozen layer.
    primary_ids = {str(route.get('id')) for route in (primary_semantic_routes or [])}
    for route in (semantic_routes or []):
        if not isinstance(route, dict) or str(route.get('id')) in primary_ids:
            continue
        try:
            confidence = float(route.get('confidence', 0) or 0)
        except (TypeError, ValueError):
            confidence = 0.0
        if confidence < 20:
            continue
        raw_points = route.get('points')
        if not isinstance(raw_points, list) or len(raw_points) < 2:
            continue
        valid_points = []
        for point in raw_points[:160]:
            if not isinstance(point, (list, tuple)) or len(point) < 2:
                continue
            try:
                px, py = float(point[0]), float(point[1])
            except (TypeError, ValueError):
                continue
            if math.isfinite(px) and math.isfinite(py) and 0 <= px <= width and 0 <= py <= height:
                valid_points.append([px, py])
        if len(valid_points) < 2:
            continue
        # Preserve uncertain Qwen trajectories as frozen review entities.
        # They are deliberately not promoted to PIPE_MAIN here.
        display_route = {**route, 'points': valid_points, 'include': True, 'confidence': max(35.0, confidence)}
        chain = _semantic_route_chains([display_route])
        if not chain:
            continue
        page_points=[(tx+float(point[0])*scale,ty+float(point[1])*scale) for point in chain[0]]
        d += dxf_polyline('QWEN_REVIEW',page_points,False,9)

    for annotation in annotations:
        export_kind = _annotation_export_kind(annotation)
        if not export_kind:
            continue
        box=annotation.get('bbox') or {}
        # DXF TEXT defaults to left/baseline alignment. Keep the insertion
        # point at the source bbox left edge; subtracting an estimated string
        # width was moving left-column digits toward the centre of the sheet.
        px=tx+float(box.get('x',0))*scale
        py=ty+(float(box.get('y',0))+float(box.get('h',0)))*scale
        x,y=page_to_mm((px,py))
        text=str(annotation['text'])
        d += dxf_text(export_kind,text,x,y,3.0 if export_kind == 'VERIFIED_TEXT' else 2.7)

    d += dxf_text('NOTES','ТРУБОПРОВОДНАЯ СХЕМА',page_to_mm((40,52))[0],page_to_mm((40,52))[1],5.6)
    d += dxf_text('NOTES','АВТОМАТИЧЕСКАЯ ВЕКТОРНАЯ РЕКОНСТРУКЦИЯ - МАСШТАБ НЕ КАЛИБРОВАН',page_to_mm((40,68))[0],page_to_mm((40,68))[1],2.6)
    d += dxf_text('NOTES','ФОРМАТ',page_to_mm((1022,44))[0],page_to_mm((1022,44))[1],2.4)
    d += dxf_text('NOTES','A3 - ЛИСТ 1/1',page_to_mm((1022,61))[0],page_to_mm((1022,61))[1],3.3)
    d += dxf_text('NOTES','ОБОЗНАЧЕНИЯ И ПРИМЕЧАНИЯ',page_to_mm((40,783))[0],page_to_mm((40,783))[1],2.8)
    d += dxf_text('NOTES','OCR LABELS EXPORTED AS EDITABLE CAD TEXT; PIPE GEOMETRY IS ON A SEPARATE LAYER.',page_to_mm((40,801))[0],page_to_mm((40,801))[1],2.2)
    d += dxf_text('NOTES','VERIFY CONNECTIONS AND DIMENSIONS AGAINST THE ORIGINAL BEFORE CONSTRUCTION.',page_to_mm((40,816))[0],page_to_mm((40,816))[1],2.2)
    d += dxf_text('NOTES','ТИП ДОКУМЕНТА',page_to_mm((850,783))[0],page_to_mm((850,783))[1],2.3)
    d += dxf_text('NOTES','СХЕМА ТРУБОПРОВОДА',page_to_mm((850,801))[0],page_to_mm((850,801))[1],3.0)
    d += dxf_text('NOTES','МАСШТАБ: НЕ ОПРЕДЕЛЁН - СТАТУС: ПРОВЕРИТЬ',page_to_mm((850,816))[0],page_to_mm((850,816))[1],2.1)
    d += ['0','ENDSEC','0','EOF']
    return '\n'.join(d)+'\n'

