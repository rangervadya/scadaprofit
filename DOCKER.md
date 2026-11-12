# Docker deployment · ScadaProfit 4.5.10 + VDGO backend 5.3.9

The unified Docker Compose stack contains ScadaProfit at `/` and the VDGO conclusion service at `/vdgo/`, routed through the gateway. Keep the existing `.env`, named volumes, PostgreSQL data and Nginx routing. Do **not** run `docker compose down -v` and do not remove `cad_jobs`, `vdgo_postgres_data`, `vdgo_output` or `vdgo_uploads`.

Run updates from the project root (the directory containing the root `compose.yaml`). Version 4.5.10 changes both the main workforce application and the VDGO PDF/Word generator/template. Rebuild both services:

```bash
sudo docker compose config --quiet
sudo docker compose build --no-cache app vdgo-backend
sudo docker compose up -d --no-deps --force-recreate app vdgo-backend
sudo docker compose restart gateway
sudo docker compose ps
sudo docker compose exec vdgo-backend python -c "import app; print(app.APP_RELEASE, app.BACKEND_IMAGE_VERSION)"
```

The last command should print `4.5.10 5.3.9`. If it prints another version, the older backend is still running or a different Compose file was used. Preserve all named volumes when updating.
