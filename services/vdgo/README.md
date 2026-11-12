# VDGO conclusion backend

This directory contains the separate VDGO API, PDF/Word generator, templates and PostgreSQL integration. The React browser interface is part of the unified `frontend/` workspace under `frontend/vdgo/`; it is built into `frontend/public/vdgo/` and served by the main ScadaProfit app.

- `backend/` — Python API, PDF/Word generation, templates and PostgreSQL integration.

PDF template files under `backend/template/` are source assets and must remain in the repository. Generated documents and uploads are stored in Docker volumes, not in Git.
