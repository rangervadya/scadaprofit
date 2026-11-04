# CAD Reconstruction Engine 4.3.2

Local Docker-based reconstruction of photographed piping sketches into editable SVG/DXF. Qwen3-VL OCR and tiled pipe-trace suggestions run through local Ollama; OpenCV extracts and connects candidate line geometry. Dense numbered note blocks are detected from source ink and OCRed one row per request. Failed rows remain geometry-exclusion review boxes. Collinear endpoint gaps are joined only if actual source ink bridges the interior gap. Short branches may enter the primary layer only when attached to a pipe-like component and supported by source ink.

See [README-RU.md](README-RU.md), [INSTALL-4.3.2-RU.md](INSTALL-4.3.2-RU.md), and [DIAGNOSE-QWEN-RU.md](DIAGNOSE-QWEN-RU.md). Keep `.env`, `.git`, server backups, and `public/styles.css`.
