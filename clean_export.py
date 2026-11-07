"""SVG and editable DXF export from the reference-aligned clean layout."""
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
    right = width - 32.0
    values: list[tuple[str, float, float, str, float, bool]] = []

    if fields.get("documentTitle"):
        values.append((str(fields["documentTitle"]), center, 24.0, "middle", 9.2, True))
    if fields.get("appendix"):
        values.append((str(fields["appendix"]), right, 53.0, "end", 12.0, True))
    if fields.get("title"):
        values.append((str(fields["title"]), center, 115.0, "middle", 15.0, False))
    if fields.get("subtitle"):
        values.append((str(fields["subtitle"]), center, 137.0, "middle", 11.0, False))
    if fields.get("address"):
        values.append((f"по адресу: {fields['address']}", center, 159.0, "middle", 9.0, False))

    # The sheet is intentionally free of auto-generated labels and generic notes.
    legend = template.get("legend") or []
    for index, item in enumerate(legend):
        y = height - 222.0 + index * 18.0
        code = str(item.get("code") or "—")
        label = str(item.get("label") or "").strip()
        if code:
            values.append((code, width - 322.0, y, "start", 8.0, False))
        if label:
            values.append((label, width - 292.0, y, "start", 7.4, False))

    signature_y = height - 75.0
    if fields.get("preparedBy"):
        values.append((f"Схему составил: {fields['preparedBy']}", width - 322.0, signature_y, "start", 8.0, False))
    else:
        values.append(("Схему составил", width - 322.0, signature_y, "start", 8.0, False))
    if fields.get("drawnBy"):
        values.append((f"Схему начертил: {fields['drawnBy']}", width - 322.0, height - 36.0, "start", 8.0, False))
    else:
        values.append(("Схему начертил", width - 322.0, height - 36.0, "start", 8.0, False))
    return values


def build_layout_svg(layout: dict[str, Any]) -> str:
    width, height, width_mm, height_mm = _page(layout)
    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width_mm:g}mm" height="{height_mm:g}mm" viewBox="0 0 {width} {height}">',
        f'<rect width="{width}" height="{height}" fill="#fff"/>',
    ]

    for value, x, y, anchor, size, bold in _template_texts(layout):
        weight = ' font-weight="bold"' if bold else ""
        out.append(
            f'<text data-layer="SHEET" x="{x:.2f}" y="{y:.2f}" text-anchor="{anchor}" '
            f'font-family="Arial,sans-serif" font-size="{size:.2f}"{weight} fill="#15191d">{escape(value)}</text>'
        )

    out.append('<g data-layer="PIPE_MAIN" fill="none" stroke="#15191d" stroke-width="1.05" stroke-linecap="round" stroke-linejoin="round">')
    for pipe in layout.get("pipes", []):
        points = " ".join(f"{float(p[0]):.2f},{float(p[1]):.2f}" for p in pipe.get("geometry", []))
        if points:
            out.append(f'<polyline data-id="{escape(str(pipe.get("id") or ""))}" points="{points}"/>')
    out.append('</g><g data-layer="DETAIL_REVIEW" fill="none" stroke="#9ba3aa" stroke-width=".75" stroke-dasharray="5 4" stroke-linecap="round" stroke-linejoin="round">')
    for pipe in layout.get("reviewPipes", []):
        points = " ".join(f"{float(p[0]):.2f},{float(p[1]):.2f}" for p in pipe.get("geometry", []))
        if points:
            out.append(f'<polyline data-id="{escape(str(pipe.get("id") or ""))}" points="{points}"/>')
    out.append('</g><g data-layer="SYMBOLS" fill="none" stroke="#111" stroke-width="1.0" stroke-linejoin="round">')
    for symbol in layout.get("symbols", []):
        for primitive in symbol.get("primitives", []):
            if primitive.get("kind") == "line":
                a, b = primitive["from"], primitive["to"]
                out.append(f'<line x1="{a[0]}" y1="{a[1]}" x2="{b[0]}" y2="{b[1]}"/>')
            elif primitive.get("kind") == "polyline":
                points = " ".join(f"{p[0]},{p[1]}" for p in primitive["points"])
                out.append(f'<polyline points="{points}"/>')
            elif primitive.get("kind") == "circle":
                center = primitive["center"]
                out.append(f'<circle cx="{center[0]}" cy="{center[1]}" r="{primitive["radius"]}"/>')
    out.append('</g>')

    for dimension in layout.get("dimensions", []):
        position = dimension.get("position") or [0, 0]
        value = escape(str(dimension.get("rawText") or dimension.get("value") or ""))
        if value:
            out.append(
                f'<text data-layer="DIMENSIONS" x="{position[0]}" y="{position[1]}" '
                f'font-family="Arial,sans-serif" font-size="8.5" fill="#111">{value}</text>'
            )
    for label in layout.get("labels", []):
        position = label.get("position") or [0, 0]
        value = escape(str(label.get("text") or ""))
        if value:
            out.append(
                f'<text data-layer="LABELS" x="{position[0]}" y="{position[1]}" '
                f'font-family="Arial,sans-serif" font-size="8.5" fill="#20262b">{value}</text>'
            )

    if layout.get("reviewOnly"):
        out.append(
            f'<text data-layer="REVIEW_ONLY" x="{width / 2:.2f}" y="{height - 12:.2f}" '
            'text-anchor="middle" font-family="Arial,sans-serif" font-size="11" '
            'font-weight="bold" fill="#a3342b" opacity=".9">НЕПОЛНЫЙ РЕЗУЛЬТАТ — ТОЛЬКО ПРОВЕРКА</text>'
        )
    out.append('</svg>')
    return "\n".join(out)


def build_layout_dxf(layout: dict[str, Any]) -> str:
    page_width, page_height, width_mm, height_mm = _page(layout)

    def mm(point: list[float]) -> tuple[float, float]:
        return float(point[0]) * width_mm / page_width, (page_height - float(point[1])) * height_mm / page_height

    def polyline(layer: str, points: list[list[float]], closed: bool = False) -> list[str]:
        if len(points) < 2:
            return []
        data = ["0", "LWPOLYLINE", "100", "AcDbEntity", "8", layer, "100", "AcDbPolyline", "90", str(len(points)), "70", "1" if closed else "0"]
        for point in points:
            x, y = mm(point)
            data += ["10", f"{x:.3f}", "20", f"{y:.3f}"]
        return data

    def text(layer: str, value: Any, point: list[float], size: float) -> list[str]:
        clean = re.sub(r"[\r\n\x00]+", " ", str(value or "")).strip()[:240]
        if not clean:
            return []
        x, y = mm(point)
        return ["0", "TEXT", "100", "AcDbEntity", "8", layer, "100", "AcDbText", "10", f"{x:.3f}", "20", f"{y:.3f}", "30", "0", "40", f"{size:.3f}", "1", clean]

    layer_specs = [
        ("SHEET", 7, 0), ("PIPE_MAIN", 7, 0), ("DETAIL_REVIEW", 8, 0),
        ("SYMBOLS", 3, 0), ("DIMENSIONS", 5, 0), ("LABELS", 7, 0), ("NOTES", 8, 0),
    ]
    data = [
        "0", "SECTION", "2", "HEADER", "9", "$ACADVER", "1", "AC1021",
        "9", "$INSUNITS", "70", "4", "0", "ENDSEC",
        "0", "SECTION", "2", "TABLES", "0", "TABLE", "2", "LAYER", "70", str(len(layer_specs)),
    ]
    for name, color, flags in layer_specs:
        data += ["0", "LAYER", "100", "AcDbSymbolTableRecord", "100", "AcDbLayerTableRecord", "2", name, "70", str(flags), "62", str(color), "6", "CONTINUOUS"]
    data += ["0", "ENDTAB", "0", "ENDSEC", "0", "SECTION", "2", "ENTITIES"]

    for value, x, y, _anchor, size, _bold in _template_texts(layout):
        data += text("SHEET", value, [x, y], size * width_mm / page_width)

    for pipe in layout.get("pipes", []):
        data += polyline("PIPE_MAIN", pipe.get("geometry") or [])
    for pipe in layout.get("reviewPipes", []):
        data += polyline("DETAIL_REVIEW", pipe.get("geometry") or [])
    for symbol in layout.get("symbols", []):
        for primitive in symbol.get("primitives", []):
            if primitive.get("kind") == "line":
                data += polyline("SYMBOLS", [primitive["from"], primitive["to"]])
            elif primitive.get("kind") == "polyline":
                data += polyline("SYMBOLS", primitive["points"])
            elif primitive.get("kind") == "circle":
                x, y = mm(primitive["center"])
                radius = float(primitive["radius"]) * width_mm / page_width
                data += ["0", "CIRCLE", "100", "AcDbEntity", "8", "SYMBOLS", "100", "AcDbCircle", "10", f"{x:.3f}", "20", f"{y:.3f}", "30", "0", "40", f"{radius:.3f}"]
    for dimension in layout.get("dimensions", []):
        data += text("DIMENSIONS", dimension.get("rawText") or dimension.get("value"), dimension.get("position") or [0, 0], 2.6)
    for label in layout.get("labels", []):
        data += text("LABELS", label.get("text"), label.get("position") or [0, 0], 2.6)
    if layout.get("reviewOnly"):
        data += text("NOTES", "НЕПОЛНЫЙ РЕЗУЛЬТАТ - ТОЛЬКО ПРОВЕРКА", [page_width / 2, page_height - 12], 3.0)
    data += ["0", "ENDSEC", "0", "EOF"]
    return "\n".join(data) + "\n"
