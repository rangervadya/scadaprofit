# ScadaProfit 4.5.13

Docker-based system for processing hand-drawn building-service sketches, editing CAD drawings, managing fitter assignments and preparing technical conclusions.

## Repository layout

```text
backend/api/             Node.js API and workforce module
backend/engine/          Python drawing-recognition and CAD engine
frontend/public/         Main ScadaProfit static web interface
frontend/vdgo/           React UI for technical conclusions in the same frontend workspace
services/vdgo/backend/   VDGO API, PDF/Word generator and database integration
infra/                   Dockerfiles, Nginx and deployment scripts
tests/                   Node.js, Python and VDGO regression tests
docs/                    Guides, architecture notes and release history
compose.yaml              Unified Docker Compose entry point
.env.example              Environment variable template
```

## Start

1. Copy `.env.example` to `.env` and set a unique PostgreSQL password. Set `COOKIE_SECURE=1` when serving through HTTPS.
2. Run from the repository root:

   ```bash
   docker compose config --quiet
   docker compose up -d --build
   ```

3. Open `http://SERVER:3001` (or the port configured by `WEB_PORT`). On first login, create the developer account, then create supervisors, receivers and fitters.

## Update

```bash
git pull --ff-only
docker compose build --no-cache app vdgo-backend
docker compose up -d --remove-orphans --no-deps --force-recreate app vdgo-backend
docker compose restart gateway
docker compose ps
```

Do not run `docker compose down -v` and do not remove named volumes. They store uploaded jobs, user work, documents and PostgreSQL records.

Both browser interfaces share one `frontend/` directory and one delivery path: the legacy ScadaProfit pages are in `frontend/public/`, while the VDGO React sources are in `frontend/vdgo/`. Docker builds the React assets into `frontend/public/vdgo/`; the main app serves them at `/vdgo/`. The VDGO API, document generator and PostgreSQL integration remain a separate backend service.

## Tests

```bash
npm --prefix backend run check
PYTHONPATH=backend python -m unittest discover -s tests/vdgo -p 'test_*.py' -v
```

## Documentation

- [Руководство на русском](docs/user-guides/README-RU.md)
- [Развёртывание Docker](docs/deployment/DOCKER.md)
- [Рабочие роли и выезды](docs/user-guides/WORKFORCE-QUICKSTART-RU.md)
- [Руководство CAD](docs/user-guides/MANUAL-CAD-USER-GUIDE-RU.md)
- [История изменений](docs/releases/CHANGELOG-RU.md)
