# Docker deployment · ScadaProfit 4.5.6 + VDGO

The existing Docker Compose stack contains two applications behind one gateway: ScadaProfit at `/` and VDGO at `/vdgo/`. Keep this stack and its existing `.env`, named volumes and Nginx routing. Do **not** run `docker compose down -v`; do not remove or replace `vdgo/`, PostgreSQL data or any VDGO service.

For the 4.5.6 release, run the update from the project root (the directory containing the unified `compose.yaml`). The conclusion form and its 500-character validation live in `vdgo-backend`, so rebuilding only `app` is not sufficient:

```bash
git pull --ff-only origin main
sudo docker compose config --quiet
sudo docker compose build --no-cache vdgo-backend app vdgo-frontend
sudo docker compose up -d --no-deps --force-recreate vdgo-backend app vdgo-frontend
sudo docker compose restart gateway
sudo docker compose ps
sudo docker compose exec vdgo-backend python -c "import app; print(app.APP_RELEASE, app.BACKEND_IMAGE_VERSION)"
```

The last command must print `4.5.6 5.3.8`. If it prints another version, the old backend is still running or a different Compose file was used. Never run `docker compose down -v` and never remove the named volumes `cad_jobs` or `vdgo_postgres_data`.
