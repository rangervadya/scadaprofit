"""High-fidelity, editable vector trace of the source drawing.

The source-trace export is deliberately separate from semantic CAD reconstruction:
contours preserve every visible source mark, while PIPE_MAIN remains a reviewed
engineering interpretation.  This avoids losing symbols, dimensions or labels
when a vision model times out or topology selection is conservative.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import cv2
import numpy as np


@dataclass(frozen=True)
class TraceResult:
    svg: str
    dxf: str
    components: int
    contours: int
    vertices: int
    page_width_mm: float
    page_height_mm: float


def _trace_components(mask: np.ndarray, epsilon_px: float, min_perimeter_px: float) -> list[list[np.ndarray]]:
    binary = np.asarray(mask)
    if binary.ndim != 2:
        raise ValueError("Reference trace expects a single-channel ink mask")
    if binary.size == 0:
        raise ValueError("Reference trace mask is empty")
    binary = np.where(binary > 0, 255, 0).astype(np.uint8)
    contours, hierarchy = cv2.findContours(binary, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
    if hierarchy is None or not contours:
        return []
    hierarchy = hierarchy[0]

    children_by_parent: dict[int, list[int]] = {}
    roots: list[int] = []
    for index, item in enumerate(hierarchy):
        parent = int(item[3])
        if parent < 0:
            roots.append(index)
        else:
            children_by_parent.setdefault(parent, []).append(index)

    groups: list[list[np.ndarray]] = []
    for root in roots:
        stack = [root]
        group: list[np.ndarray] = []
        while stack:
            index = stack.pop()
            contour = contours[index]
            perimeter = float(cv2.arcLength(contour, True))
            if perimeter >= min_perimeter_px:
                simplified = cv2.approxPolyDP(contour, epsilon_px, True).reshape(-1, 2)
                if len(simplified) >= 3:
                    group.append(simplified.astype(np.int32))
            stack.extend(children_by_parent.get(index, []))
        if group:
            groups.append(group)
    return groups


def _svg_path(group: list[np.ndarray]) -> tuple[str, int]:
    chunks: list[str] = []
    vertices = 0
    for contour in group:
        if len(contour) < 3:
            continue
        points = contour.tolist()
        chunks.append(f"M {int(points[0][0])} {int(points[0][1])}")
        chunks.extend(f"L {int(point[0])} {int(point[1])}" for point in points[1:])
        chunks.append("Z")
        vertices += len(points)
    return " ".join(chunks), vertices


def _dxf_polyline(layer: str, points: list[tuple[float, float]]) -> list[str]:
    if len(points) < 3:
        return []
    data = ["0", "LWPOLYLINE", "100", "AcDbEntity", "8", layer,
            "100", "AcDbPolyline", "90", str(len(points)), "70", "1"]
    for x, y in points:
        data.extend(["10", f"{x:.4f}", "20", f"{y:.4f}"])
    return data


def build_reference_trace(mask: np.ndarray, *, source_name: str = "source",
                           page_width_mm: float | None = None,
                           page_height_mm: float | None = None,
                           epsilon_px: float = 0.42,
                           min_perimeter_px: float = 2.0) -> TraceResult:
    """Trace thresholded ink into editable SVG paths and DXF closed polylines.

    SVG groups are one connected ink component each (with even-odd subpaths for
    holes). DXF contains individual contour polylines on REFERENCE_TRACE.  Both
    retain source coordinates and the source page's aspect ratio.
    """
    binary = np.where(np.asarray(mask) > 0, 255, 0).astype(np.uint8)
    if binary.ndim != 2:
        raise ValueError("Reference trace expects a single-channel ink mask")
    height, width = binary.shape
    if width < 2 or height < 2 or not np.count_nonzero(binary):
        raise ValueError("Reference trace has no usable foreground pixels")

    if page_width_mm is None or page_height_mm is None:
        if width >= height:
            page_width_mm, page_height_mm = 297.0, 210.0
        else:
            page_width_mm, page_height_mm = 210.0, 297.0
    page_width_mm = float(page_width_mm)
    page_height_mm = float(page_height_mm)
    scale = min(page_width_mm / width, page_height_mm / height)
    offset_x = (page_width_mm - width * scale) / 2.0
    offset_y = (page_height_mm - height * scale) / 2.0

    groups = _trace_components(binary, max(0.0, float(epsilon_px)), max(0.0, float(min_perimeter_px)))
    if not groups:
        raise ValueError("No closed contours were found in the source mask")

    svg_paths: list[str] = []
    dxf_entities: list[str] = []
    contour_count = 0
    vertex_count = 0
    for component_index, group in enumerate(groups, 1):
        path_data, vertices = _svg_path(group)
        if not path_data:
            continue
        svg_paths.append(
            f'<path id="ink-component-{component_index:05d}" data-contours="{len(group)}" '
            f'd="{path_data}" fill="#111" fill-rule="evenodd"/>'
        )
        vertex_count += vertices
        contour_count += len(group)
        for contour in group:
            points = [
                (offset_x + float(point[0]) * scale,
                 page_height_mm - (offset_y + float(point[1]) * scale))
                for point in contour.tolist()
            ]
            dxf_entities.extend(_dxf_polyline("REFERENCE_TRACE", points))

    safe_name = str(source_name or "source").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")[:180]
    svg = "\n".join([
        '<?xml version="1.0" encoding="UTF-8"?>',
        f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:ink="urn:scadaprofit:reference-trace" '
        f'width="{page_width_mm:g}mm" height="{page_height_mm:g}mm" viewBox="0 0 {width} {height}" '
        'preserveAspectRatio="xMidYMid meet">',
        f'<title>Векторная копия исходной схемы: {safe_name}</title>',
        f'<metadata>Source size {width}x{height}px; {len(groups)} editable connected ink components; '
        'source geometry preserved without semantic reconnection.</metadata>',
        f'<rect width="{width}" height="{height}" fill="#fff"/>',
        '<g id="REFERENCE_TRACE" stroke="none" shape-rendering="geometricPrecision">',
        *svg_paths,
        '</g>',
        '</svg>',
    ])

    layer_specs = [("REFERENCE_TRACE", 7, 13), ("SHEET", 8, 9)]
    dxf = [
        "0", "SECTION", "2", "HEADER", "9", "$ACADVER", "1", "AC1021",
        "9", "$INSUNITS", "70", "4", "0", "ENDSEC",
        "0", "SECTION", "2", "TABLES", "0", "TABLE", "2", "LAYER", "70", str(len(layer_specs)),
    ]
    for layer, color, lineweight in layer_specs:
        dxf.extend(["0", "LAYER", "100", "AcDbSymbolTableRecord", "100", "AcDbLayerTableRecord",
                    "2", layer, "70", "0", "62", str(color), "6", "CONTINUOUS", "370", str(lineweight)])
    dxf.extend(["0", "ENDTAB", "0", "ENDSEC", "0", "SECTION", "2", "ENTITIES"])
    dxf.extend(dxf_entities)
    dxf.extend(["0", "ENDSEC", "0", "EOF"])

    return TraceResult(
        svg=svg, dxf="\n".join(dxf) + "\n",
        components=len(groups), contours=contour_count, vertices=vertex_count,
        page_width_mm=page_width_mm, page_height_mm=page_height_mm,
    )
