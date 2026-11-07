# ScadaProfit CAD Reconstruction Engine 4.3.20

4.3.20 adds a separate Manual CAD workspace for tracing handwritten piping sketches into editable vector geometry. It stores manual projects in the existing CAD data volume under `.private/manual-cad`, offers explicit pipe/branch, symbol, label and dimension tools, and exports clean A4 SVG and DXF. The automatic OCR/reconstruction workspace remains available.

The update does not modify the `vdgo/` application, VDGO backend/frontend, VDGO database, VDGO compose services or their volumes. See `MANUAL-CAD-USER-GUIDE-RU.md` and `UPGRADE-GIT-4.3.20-RU.md`.
