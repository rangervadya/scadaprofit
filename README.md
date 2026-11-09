# ScadaProfit 4.3.38

This release switches the normal recognition pipeline back to local Qwen-VL through Ollama, with Tesseract (`rus+eng`) as a supplemental OCR channel. MOSS and OpenRouter are disabled in the normal processing path, including retries of stored schemes. Existing cloud keys/flags do not enable them.

The CAD workbench adds editable pipe vertices, connected-junction movement, whole-branch translation, orthogonal drawing, zoom controls, duplication, symbol/label properties and numbered callouts. The drawing-sheet template includes the engineering title/address block, legend and riser columns used to compose a clean schematic resembling the supplied reference. Operator review is still required for uncertain geometry and OCR.

The embedded VDGO application is preserved. The `vdgo/` source tree, `compose.yaml`, gateway configuration, PostgreSQL service and persistent volumes are not changed by this release. Update only the ScadaProfit application service; do not remove shared volumes or recreate VDGO services for this update.

Run automated offline checks with `npm run check`. A live inference run against the user's Ollama server is not part of this package validation; confirm model availability and compare every inferred pipe junction and label against the source scan after deployment.

See [README-4.3.38-RU.txt](README-4.3.38-RU.txt) and [CHANGELOG-4.3.38-RU.md](CHANGELOG-4.3.38-RU.md) for deployment and change details.
