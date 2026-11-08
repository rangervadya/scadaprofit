# ScadaProfit + VDGO — combined Docker stack

ScadaProfit 4.3.22 adds an LPGCad R1-style engineering sheet profile to Manual CAD. Automatic recognition drafts can be opened in Manual CAD; source geometry is preserved and uncertain elements remain subject to operator review. Explicit riser group labels and apartment numbers can be entered and rendered into an editable SVG/DXF lower-sheet block.

The supplied stack remains a two-application deployment: ScadaProfit at `/`, VDGO at `/vdgo/`. This update does not alter `vdgo/`, `compose.yaml`, Nginx routing, PostgreSQL or Docker volumes.

The Qwen default tag is `qwen3-vl:4b-instruct`; verify the model is actually installed in Ollama on the target server before running the pipeline.

See `README-RU.md`, `MANUAL-CAD-USER-GUIDE-RU.md` and `UPGRADE-GIT-4.3.22-RU.md`.
