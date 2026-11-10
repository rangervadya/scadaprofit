"""Vector PDF export for the existing manual CAD SVG sheet."""
from __future__ import annotations

import cairosvg


def svg_to_pdf(svg: str | bytes) -> bytes:
    """Convert a clean CAD SVG sheet to a vector PDF document."""
    source = svg.encode("utf-8") if isinstance(svg, str) else bytes(svg)
    if not source.lstrip().startswith(b"<svg"):
        raise ValueError("SVG document is missing or invalid.")
    result = cairosvg.svg2pdf(bytestring=source)
    if not result or not result.startswith(b"%PDF-"):
        raise RuntimeError("PDF renderer returned an invalid document.")
    return result
