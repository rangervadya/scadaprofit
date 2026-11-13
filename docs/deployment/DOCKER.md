# Docker deployment · ScadaProfit 4.5.15

The unified Compose stack includes the ScadaProfit application (which serves the single React SPA from one frontend workspace), Ollama, the separate VDGO PDF/Word backend, PostgreSQL and the Nginx gateway.

## First deployment

```bash
cp .env.example .env
# Edit .env and set a strong unique POSTGRES_PASSWORD.
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

## Update

Run from the project root (where the root `compose.yaml` is located):

```bash
git pull --ff-only
docker compose config --quiet
docker compose build --no-cache app vdgo-backend
docker compose up -d --remove-orphans --no-deps --force-recreate app vdgo-backend
docker compose restart gateway
docker compose ps
docker compose exec vdgo-backend python -c "import app; print(app.APP_RELEASE, app.BACKEND_IMAGE_VERSION)"
```

The VDGO API/document generator remains a separate backend service (release `5.3.9`). All user-facing pages are now in the single React SPA, built into the `app` image and served from `/vdgo/`; there is no second frontend or separate frontend container. The main ScadaProfit service version is `4.5.15`.

## Persistent data — do not delete

Keep the named volumes `cad_jobs`, `ollama_data`, `vdgo_output`, `vdgo_uploads`, and `vdgo_postgres_data`. They contain uploaded source images, CAD jobs, user accounts, field reports, defect photos, generated documents, Ollama models and PostgreSQL data.

Do not run `docker compose down -v` during an application update.

## Environment

- `WEB_PORT` — public HTTP port (default `3001`).
- `POSTGRES_PASSWORD` — set a unique value in `.env` before deployment.
- `COOKIE_SECURE` — set to `1` when HTTPS is terminated at the gateway or upstream proxy.
- `QWEN_MODEL` — local Ollama model tag, default `qwen3-vl:4b-instruct`.

The VDGO image installs the Carlito font package from the Debian repository at build time; font binaries are not committed to this repository.

Docker runtime status must be checked on the target host after deployment. Local tests do not verify the remote Docker daemon, volumes, GPU runtime or reverse-proxy configuration.

## Optional host Ollama

If Ollama runs directly on the host instead of in Compose, include the override from the project root:

```bash
docker compose -f compose.yaml -f infra/compose/compose.host-ollama.yaml up -d --build
```
