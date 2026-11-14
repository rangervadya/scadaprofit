# VDGO conclusion service

This directory contains the separate VDGO API, PDF/Word generator, templates and PostgreSQL integration. The React browser interface is the unified ScadaProfit SPA in the root `frontend/src/` workspace; it is built into `frontend/public/vdgo/` and served by the main ScadaProfit app. No separate VDGO frontend source or container is used.

- `app.py` — Python HTTP API, PDF/Word generation and PostgreSQL integration.
- `database.py` — PostgreSQL helpers.
- `templates/` — HTML shell served by the API.
- `template/` — source PDF templates.

PDF template files under `template/` are source assets and must remain in the repository. Generated documents and uploads are stored in Docker volumes, not in Git.