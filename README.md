# CAD Reconstruction Engine 4.3.0

Local-first prototype for turning photographed, handwritten piping sketches into editable SVG/DXF geometry. OCR boxes are used to suppress handwriting strokes from the line detector. The OpenCV graph promotes only connected multi-segment routes with topology evidence to `PIPE_MAIN`; isolated and ambiguous strokes remain in `DETAIL_REVIEW`. Qwen pipe traces are review suggestions on `QWEN_REVIEW`, not the sole source of the main drawing.

See [`README-RU.md`](README-RU.md), [`INSTALL-4.3.0-RU.md`](INSTALL-4.3.0-RU.md), and [`CHANGELOG-RU.md`](CHANGELOG-RU.md) for details. All output remains preliminary and must be checked against the original sketch.
