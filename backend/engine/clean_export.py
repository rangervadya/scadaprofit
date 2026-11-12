"""Professional, editable SVG/DXF sheet export from the clean CAD layout."""
from __future__ import annotations

import re
from typing import Any
from xml.sax.saxutils import escape


def _page(layout: dict[str, Any]) -> tuple[int, int, float, float]:
    page = layout.get("page") or {}
    width = max(1, int(page.get("width", 850)))
    height = max(1, int(page.get("height", 1200)))
    width_mm = max(1.0, float(page.get("widthMm", 210)))
    height_mm = max(1.0, float(page.get("heightMm", 297)))
    return width, height, width_mm, height_mm


def _template_texts(layout: dict[str, Any]) -> list[tuple[str, float, float, str, float, bool]]:
    template = layout.get("template") or {}
    fields = template.get("fields") or {}
    width, height, _, _ = _page(layout)
    center = width / 2.0
    right = width - 30.0
    landscape = height < width
    if landscape:
        title_y = (28.0, 52.0, 79.0, 99.0, 119.0)
    else:
        title_y = (36.0, 59.0, 91.0, 113.0, 137.0)
    document_y, appendix_y, title_y_value, subtitle_y, address_y = title_y
    values: list[tuple[str, float, float, str, float, bool]] = []
    if fields.get("documentTitle"):
        values.append((str(fields["documentTitle"]), center, document_y, "middle", 8.8 if landscape else 9.2, True))
    if fields.get("appendix"):
        values.append((str(fields["appendix"]), right, appendix_y, "end", 10.0 if landscape else 11.0, True))
    if fields.get("title"):
        values.append((str(fields["title"]), center, title_y_value, "middle", 14.0, True))
    if fields.get("subtitle"):
        values.append((str(fields["subtitle"]), center, subtitle_y, "middle", 9.5, False))
    if fields.get("address"):
        values.append((f"по адресу: {fields['address']}", center, address_y, "middle", 8.2, False))
    if fields.get("documentNumber"):
        values.append((f"Обозначение: {fields['documentNumber']}", 32.0, address_y, "start", 7.2, False))
    scale_label = str((layout.get("scaleCalibration") or {}).get("scaleLabel") or "").strip()
    if scale_label:
        values.append((scale_label, 32.0, 145.0 if landscape else 165.0, "start", 7.2, True))

    legend = template.get("legend") or []
    if landscape:
        zones = template.get("zones") or {}
        legend_zone = zones.get("legend") or {"x": 50, "y": 690, "w": 720, "h": 122}
        signature_zone = zones.get("signatures") or {"x": 790, "y": 690, "w": 358, "h": 122}
        values.append(("УСЛОВНЫЕ ОБОЗНАЧЕНИЯ", float(legend_zone["x"]) + 8, float(legend_zone["y"]) + 15, "start", 6.8, True))
        for index, item in enumerate(legend):
            column = 0 if index < 3 else 1
            row = index if column == 0 else index - 3
            x = 48.0 if column == 0 else 410.0
            y = height - 90.0 + row * 25.0
            code = str(item.get("code") or "—")
            label = str(item.get("label") or "").strip()
            if code:
                values.append((code, x, y, "start", 7.2, True))
            if label:
                values.append((label, x + 33.0, y, "start", 6.8, False))
        signature_x = float(signature_zone["x"]) + 12.0
        signature_y = float(signature_zone["y"]) + 69.0
        values.append(("ПОДПИСИ", signature_x - 4.0, float(signature_zone["y"]) + 15.0, "start", 6.8, True))
        values.append((f"Схему составил: {fields['preparedBy']}" if fields.get("preparedBy") else "Схему составил", signature_x, signature_y - 35.0, "start", 7.5, False))
        values.append((f"Схему начертил: {fields['drawnBy']}" if fields.get("drawnBy") else "Схему начертил", signature_x, signature_y - 13.0, "start", 7.5, False))
        if fields.get("checkedBy"):
            values.append((f"Проверил: {fields['checkedBy']}", signature_x, signature_y + 9.0, "start", 7.5, False))
    else:
        zones = template.get("zones") or {}
        legend_zone = zones.get("legend") or {"x": 505, "y": height - 254, "w": 310, "h": 130}
        signature_zone = zones.get("signatures") or {"x": 505, "y": height - 116, "w": 310, "h": 82}
        values.append(("УСЛОВНЫЕ ОБОЗНАЧЕНИЯ", float(legend_zone["x"]) + 8, float(legend_zone["y"]) + 16, "start", 6.8, True))
        legend_x = float(legend_zone["x"]) + 12.0
        legend_y = float(legend_zone["y"]) + 36.0
        for index, item in enumerate(legend):
            y = legend_y + index * 18.0
            code = str(item.get("code") or "—")
            label = str(item.get("label") or "").strip()
            if code:
                values.append((code, legend_x, y, "start", 7.5, True))
            if label:
                values.append((label, legend_x + 32.0, y, "start", 7.0, False))
        signature_x = float(signature_zone["x"]) + 12.0
        values.append(("ПОДПИСИ", signature_x - 4.0, float(signature_zone["y"]) + 15.0, "start", 6.8, True))
        values.append((f"Схему составил: {fields['preparedBy']}" if fields.get("preparedBy") else "Схему составил", signature_x, float(signature_zone["y"]) + 42.0, "start", 7.5, False))
        values.append((f"Схему начертил: {fields['drawnBy']}" if fields.get("drawnBy") else "Схему начертил", signature_x, float(signature_zone["y"]) + 62.0, "start", 7.5, False))
        if fields.get("checkedBy"):
            values.append((f"Проверил: {fields['checkedBy']}", signature_x, float(signature_zone["y"]) + 80.0, "start", 7.5, False))
    return values


def _svg_line(a: list[float], b: list[float], layer: str, stroke: str = "#111", width: float = 0.8) -> str:
    return (f'<line data-layer="{escape(layer)}" x1="{float(a[0]):.2f}" y1="{float(a[1]):.2f}" '
            f'x2="{float(b[0]):.2f}" y2="{float(b[1]):.2f}" stroke="{stroke}" stroke-width="{width:.2f}"/>')


def _draw_dimension_svg(dimension: dict[str, Any]) -> list[str]:
    graphic = dimension.get("graphic") or {}
    out: list[str] = []
    for a, b in graphic.get("extensionLines", []):
        out.append(_svg_line(a, b, "DIMENSION_LINES", "#303840", 0.65))
    line = graphic.get("dimensionLine")
    if isinstance(line, list) and len(line) == 2:
        out.append(_svg_line(line[0], line[1], "DIMENSION_LINES", "#303840", 0.75))
    for arrow in graphic.get("arrowLines", []):
        if len(arrow) == 2:
            out.append(_svg_line(arrow[0], arrow[1], "DIMENSION_LINES", "#303840", 0.75))
    text = escape(str(dimension.get("displayText") or dimension.get("rawText") or dimension.get("value") or ""))
    position = dimension.get("position") or graphic.get("textPosition") or [0, 0]
    if text:
        out.append(
            f'<text data-layer="DIMENSIONS" x="{float(position[0]):.2f}" y="{float(position[1]):.2f}" '
            'text-anchor="middle" font-family="Arial,sans-serif" font-size="8.0" '
            'paint-order="stroke" stroke="#fff" stroke-width="3.0" stroke-linejoin="round" '
            f'fill="#15191d">{text}</text>'
        )
    return out


def build_layout_svg(layout: dict[str, Any]) -> str:
    width, height, width_mm, height_mm = _page(layout)
    landscape = height < width
    frame_margin = float((layout.get("frame") or {}).get("margin", 18.0))
    header_bottom = float((layout.get("frame") or {}).get("headerBottom", 132.0 if landscape else 150.0))
    footer_top = float((layout.get("frame") or {}).get("footerTop", 680.0 if landscape else 936.0))
    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width_mm:g}mm" height="{height_mm:g}mm" viewBox="0 0 {width} {height}">',
        '<rect width="100%" height="100%" fill="#fff"/>',
        f'<rect data-layer="SHEET" x="{frame_margin}" y="{frame_margin}" width="{width - 2 * frame_margin}" height="{height - 2 * frame_margin}" fill="none" stroke="#1c2329" stroke-width="1.1"/>',
        f'<line data-layer="SHEET" x1="{frame_margin}" y1="{header_bottom}" x2="{width - frame_margin}" y2="{header_bottom}" stroke="#1c2329" stroke-width="0.75"/>',
        f'<line data-layer="SHEET" x1="{frame_margin}" y1="{footer_top}" x2="{width - frame_margin}" y2="{footer_top}" stroke="#68727b" stroke-width="0.55"/>',
    ]
    zones = (layout.get("template") or {}).get("zones") or {}
    for zone_name, caption in (("legend", "УСЛОВНЫЕ ОБОЗНАЧЕНИЯ"), ("signatures", "ПОДПИСИ")):
        zone = zones.get(zone_name) or {}
        if all(key in zone for key in ("x", "y", "w", "h")):
            x, y, w, h = (float(zone[key]) for key in ("x", "y", "w", "h"))
            out.append(f'<rect data-layer="SHEET_BLOCKS" data-zone="{zone_name}" x="{x:.2f}" y="{y:.2f}" width="{w:.2f}" height="{h:.2f}" fill="none" stroke="#68727b" stroke-width="0.5"/>')

    for value, x, y, anchor, size, bold in _template_texts(layout):
        weight = ' font-weight="bold"' if bold else ""
        out.append(
            f'<text data-layer="SHEET" x="{x:.2f}" y="{y:.2f}" text-anchor="{anchor}" '
            f'font-family="Arial,sans-serif" font-size="{size:.2f}"{weight} fill="#15191d">{escape(value)}</text>'
        )

    # Pipe geometry remains a single uniform transform from the source graph.
    out.append('<g data-layer="PIPE_MAIN" fill="none" stroke="#15191d" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round">')
    for pipe in layout.get("pipes", []):
        points = " ".join(f"{float(p[0]):.2f},{float(p[1]):.2f}" for p in pipe.get("geometry", []))
        if points:
            out.append(f'<polyline data-id="{escape(str(pipe.get("id") or ""))}" points="{points}"/>')
    out.append('</g>')

    out.append('<g data-layer="DETAIL_REVIEW" fill="none" stroke="#929ba3" stroke-width=".75" stroke-dasharray="4 3" stroke-linecap="round" stroke-linejoin="round">')
    for pipe in layout.get("reviewPipes", []):
        points = " ".join(f"{float(p[0]):.2f},{float(p[1]):.2f}" for p in pipe.get("geometry", []))
        if points:
            out.append(f'<polyline data-id="{escape(str(pipe.get("id") or ""))}" points="{points}"/>')
    out.append('</g>')

    out.append('<g data-layer="SYMBOLS" fill="none" stroke="#111" stroke-width="1.0" stroke-linejoin="round">')
    for symbol in layout.get("symbols", []):
        for primitive in symbol.get("primitives", []):
            if primitive.get("kind") == "line":
                a, b = primitive["from"], primitive["to"]
                out.append(_svg_line(a, b, "SYMBOLS", "#111", 1.0))
            elif primitive.get("kind") == "polyline":
                points = " ".join(f"{float(p[0]):.2f},{float(p[1]):.2f}" for p in primitive["points"])
                out.append(f'<polyline points="{points}"/>')
            elif primitive.get("kind") == "circle":
                center = primitive["center"]
                out.append(f'<circle cx="{center[0]}" cy="{center[1]}" r="{primitive["radius"]}"/>')
    out.append('</g>')

    for dimension in layout.get("dimensions", []):
        out.extend(_draw_dimension_svg(dimension))

    for label in layout.get("labels", []):
        position = label.get("position") or [0, 0]
        value = escape(str(label.get("text") or ""))
        if value:
            out.append(
                f'<text data-layer="LABELS" x="{float(position[0]):.2f}" y="{float(position[1]):.2f}" '
                'text-anchor="middle" font-family="Arial,sans-serif" font-size="8.2" '
                'paint-order="stroke" stroke="#fff" stroke-width="2.8" stroke-linejoin="round" '
                f'fill="#20262b">{value}</text>'
            )

    for tag in layout.get("sectionTags", []):
        box = tag.get("bbox") or {}
        position = tag.get("position") or [0, 0]
        out.append(
            f'<rect data-layer="SECTION_TAGS" data-provisional="true" data-target="{escape(str(tag.get("targetId") or ""))}" '
            f'x="{float(box.get("x", position[0] - 8)):.2f}" y="{float(box.get("y", position[1] - 7)):.2f}" '
            f'width="{float(box.get("w", 16)):.2f}" height="{float(box.get("h", 13)):.2f}" '
            'fill="#fff" stroke="#1d252c" stroke-width="0.75"/>'
        )
        out.append(
            f'<text data-layer="SECTION_TAGS" data-provisional="true" x="{float(position[0]):.2f}" y="{float(position[1]) + 2.6:.2f}" '
            'text-anchor="middle" font-family="Arial,sans-serif" font-size="7.3" font-weight="bold" fill="#15191d">'
            f'{escape(str(tag.get("number") or ""))}</text>'
        )

    if layout.get("reviewOnly"):
        out.append(
            f'<text data-layer="REVIEW_ONLY" x="{width / 2:.2f}" y="{height - 25:.2f}" '
            'text-anchor="middle" font-family="Arial,sans-serif" font-size="10" '
            'font-weight="bold" fill="#a3342b">НЕПОЛНЫЙ РЕЗУЛЬТАТ — ТОЛЬКО ПРОВЕРКА</text>'
        )
    if layout.get("sectionTags"):
        warning_x = 28.0
        warning_y = height - 28.0 if not landscape else height - 28.0
        out.append(
            f'<text data-layer="NOTES" x="{warning_x:.2f}" y="{warning_y:.2f}" '
            'font-family="Arial,sans-serif" font-size="6.2" fill="#6b737a">Нумерация участков предложена автоматически — подтвердить перед выпуском.</text>'
        )
    out.append('</svg>')
    return "\n".join(out)


def build_layout_dxf(layout: dict[str, Any]) -> str:
    page_width, page_height, width_mm, height_mm = _page(layout)
    landscape = page_height < page_width
    frame_margin = float((layout.get("frame") or {}).get("margin", 18.0))
    header_bottom = float((layout.get("frame") or {}).get("headerBottom", 132.0 if landscape else 150.0))
    footer_top = float((layout.get("frame") or {}).get("footerTop", 680.0 if landscape else 936.0))

    def mm(point: list[float]) -> tuple[float, float]:
        return float(point[0]) * width_mm / page_width, (page_height - float(point[1])) * height_mm / page_height

    def line(layer: str, a: list[float], b: list[float]) -> list[str]:
        x1, y1 = mm(a); x2, y2 = mm(b)
        return ["0", "LINE", "100", "AcDbEntity", "8", layer, "100", "AcDbLine",
                "10", f"{x1:.3f}", "20", f"{y1:.3f}", "30", "0",
                "11", f"{x2:.3f}", "21", f"{y2:.3f}", "31", "0"]

    def polyline(layer: str, points: list[list[float]], closed: bool = False) -> list[str]:
        if len(points) < 2:
            return []
        data = ["0", "LWPOLYLINE", "100", "AcDbEntity", "8", layer, "100", "AcDbPolyline", "90", str(len(points)), "70", "1" if closed else "0"]
        for point in points:
            x, y = mm(point)
            data += ["10", f"{x:.3f}", "20", f"{y:.3f}"]
        return data

    def text(layer: str, value: Any, point: list[float], size: float, align: str = "left") -> list[str]:
        clean = re.sub(r"[\r\n\x00]+", " ", str(value or "")).strip()[:240]
        if not clean:
            return []
        x, y = mm(point)
        result = ["0", "TEXT", "100", "AcDbEntity", "8", layer, "100", "AcDbText",
                  "10", f"{x:.3f}", "20", f"{y:.3f}", "30", "0",
                  "40", f"{size * width_mm / page_width:.3f}", "1", clean]
        if align == "middle":
            result += ["72", "1", "73", "2", "11", f"{x:.3f}", "21", f"{y:.3f}", "31", "0"]
        elif align == "right":
            result += ["72", "2", "73", "2", "11", f"{x:.3f}", "21", f"{y:.3f}", "31", "0"]
        return result

    layer_specs = [
        ("SHEET", 7), ("SHEET_BLOCKS", 8), ("PIPE_MAIN", 7), ("DETAIL_REVIEW", 8), ("SYMBOLS", 3),
        ("DIMENSION_LINES", 5), ("DIMENSIONS", 5), ("LABELS", 7),
        ("SECTION_TAGS", 2), ("NOTES", 8),
    ]
    data = [
        "0", "SECTION", "2", "HEADER", "9", "$ACADVER", "1", "AC1021",
        "9", "$INSUNITS", "70", "4", "0", "ENDSEC",
        "0", "SECTION", "2", "TABLES", "0", "TABLE", "2", "LAYER", "70", str(len(layer_specs)),
    ]
    for name, color in layer_specs:
        data += ["0", "LAYER", "100", "AcDbSymbolTableRecord", "100", "AcDbLayerTableRecord",
                 "2", name, "70", "0", "62", str(color), "6", "CONTINUOUS"]
    data += ["0", "ENDTAB", "0", "ENDSEC", "0", "SECTION", "2", "ENTITIES"]

    frame_points = [[frame_margin, frame_margin], [page_width - frame_margin, frame_margin],
                    [page_width - frame_margin, page_height - frame_margin], [frame_margin, page_height - frame_margin]]
    data += polyline("SHEET", frame_points, closed=True)
    data += line("SHEET", [frame_margin, header_bottom], [page_width - frame_margin, header_bottom])
    data += line("SHEET", [frame_margin, footer_top], [page_width - frame_margin, footer_top])
    zones = (layout.get("template") or {}).get("zones") or {}
    for zone_name in ("legend", "signatures"):
        zone = zones.get(zone_name) or {}
        if all(key in zone for key in ("x", "y", "w", "h")):
            x, y, w, h = (float(zone[key]) for key in ("x", "y", "w", "h"))
            zone_points = [[x, y], [x+w, y], [x+w, y+h], [x, y+h]]
            data += polyline("SHEET_BLOCKS", zone_points, closed=True)
    for value, x, y, anchor, size, _bold in _template_texts(layout):
        data += text("SHEET", value, [x, y], size, "middle" if anchor == "middle" else ("right" if anchor == "end" else "left"))

    for pipe in layout.get("pipes", []):
        data += polyline("PIPE_MAIN", pipe.get("geometry") or [])
    for pipe in layout.get("reviewPipes", []):
        data += polyline("DETAIL_REVIEW", pipe.get("geometry") or [])
    for symbol in layout.get("symbols", []):
        for primitive in symbol.get("primitives", []):
            if primitive.get("kind") == "line":
                data += line("SYMBOLS", primitive["from"], primitive["to"])
            elif primitive.get("kind") == "polyline":
                data += polyline("SYMBOLS", primitive["points"])
            elif primitive.get("kind") == "circle":
                x, y = mm(primitive["center"])
                radius = float(primitive["radius"]) * width_mm / page_width
                data += ["0", "CIRCLE", "100", "AcDbEntity", "8", "SYMBOLS", "100", "AcDbCircle",
                         "10", f"{x:.3f}", "20", f"{y:.3f}", "30", "0", "40", f"{radius:.3f}"]
    for dimension in layout.get("dimensions", []):
        graphic = dimension.get("graphic") or {}
        for a, b in graphic.get("extensionLines", []):
            data += line("DIMENSION_LINES", a, b)
        dimension_line = graphic.get("dimensionLine")
        if isinstance(dimension_line, list) and len(dimension_line) == 2:
            data += line("DIMENSION_LINES", dimension_line[0], dimension_line[1])
        for arrow in graphic.get("arrowLines", []):
            if len(arrow) == 2:
                data += line("DIMENSION_LINES", arrow[0], arrow[1])
        data += text("DIMENSIONS", dimension.get("displayText") or dimension.get("rawText") or dimension.get("value"),
                     dimension.get("position") or graphic.get("textPosition") or [0, 0], 8.0, "middle")
    for label in layout.get("labels", []):
        data += text("LABELS", label.get("text"), label.get("position") or [0, 0], 8.2, "middle")
    for tag in layout.get("sectionTags", []):
        box = tag.get("bbox") or {}
        position = tag.get("position") or [0, 0]
        tag_points = [[float(box.get("x", position[0] - 8)), float(box.get("y", position[1] - 7))],
                      [float(box.get("x", position[0] - 8)) + float(box.get("w", 16)), float(box.get("y", position[1] - 7))],
                      [float(box.get("x", position[0] - 8)) + float(box.get("w", 16)), float(box.get("y", position[1] - 7)) + float(box.get("h", 13))],
                      [float(box.get("x", position[0] - 8)), float(box.get("y", position[1] - 7)) + float(box.get("h", 13))]]
        data += polyline("SECTION_TAGS", tag_points, closed=True)
        data += text("SECTION_TAGS", tag.get("number"), position, 7.3, "middle")

    if layout.get("reviewOnly"):
        data += text("NOTES", "НЕПОЛНЫЙ РЕЗУЛЬТАТ - ТОЛЬКО ПРОВЕРКА", [page_width / 2, page_height - 25], 10.0, "middle")
    if layout.get("sectionTags"):
        data += text("NOTES", "Нумерация участков предложена автоматически - подтвердить перед выпуском.", [28, page_height - 28], 6.2)
    data += ["0", "ENDSEC", "0", "EOF"]
    return "\n".join(data) + "\n"
