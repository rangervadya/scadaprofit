# ScadaProfit 4.3.39

This release switches the normal recognition pipeline back to local Qwen-VL through Ollama, with Tesseract (`rus+eng`) as a supplemental OCR channel. MOSS and OpenRouter are disabled in the normal processing path, including retries of stored schemes. Existing cloud keys/flags do not enable them.

The CAD workbench adds editable pipe vertices, connected-junction movement, whole-branch translation, orthogonal drawing, zoom controls, duplication, symbol/label properties and numbered callouts. The drawing-sheet template includes the engineering title/address block, legend and riser columns used to compose a clean schematic resembling the supplied reference. Operator review is still required for uncertain geometry and OCR.

The embedded VDGO application is preserved. The `vdgo/` source tree, `compose.yaml`, gateway configuration, PostgreSQL service and persistent volumes are not changed by this release. Update only the ScadaProfit application service; do not remove shared volumes or recreate VDGO services for this update.

Run automated offline checks with `npm run check`. A live inference run against the user's Ollama server is not part of this package validation; confirm model availability and compare every inferred pipe junction and label against the source scan after deployment.

See [README-4.3.39-RU.txt](README-4.3.39-RU.txt) and [CHANGELOG-4.3.39-RU.md](CHANGELOG-4.3.39-RU.md) for deployment and change details.


## 4.3.39 — source-faithful vector copy and independent tracing

- Every conversion now writes `reference-trace.svg` and `reference-trace.dxf`: editable contours traced directly from the source ink mask. This preserves the visual sheet, symbols, dimensions and labels without claiming that contours are verified pipe centerlines.
- The structured CAD draft remains separate as `cad-draft.svg` / `cad-draft.dxf` (with `clean.svg` / `drawing.dxf` retained for compatibility).
- Qwen PIPE tracing runs independently of OCR completeness. A handwriting OCR timeout no longer suppresses the separate geometry task.
- Qwen defaults are tuned for shared 6 GB GPU servers: context 4096, two-by-two tiles, bounded image edge/output size, one request at a time, short model residency. Tesseract remains an independent OCR channel.
- Diagnostics treat topology and model-tile completeness as review conditions, not as reasons to hide the source-faithful exports. `graph.json` is written before artifact diagnostics so it is not falsely reported as absent.

The source-faithful vector trace is an editable contour facsimile, not a semantic CAD network. Pipe connectivity, dimensions and equipment types still require engineering verification.
