# Docker deployment · ScadaProfit 4.3.22 + VDGO

The existing Docker Compose stack contains two applications behind one gateway: ScadaProfit at `/` and VDGO at `/vdgo/`. Keep this stack and its existing `.env`, named volumes and Nginx routing. Do **not** run `docker compose down -v`; do not remove or replace `vdgo/`, PostgreSQL data or any VDGO service.

After merging the update to `main`, rebuild only the ScadaProfit `app` service:

```bash
git pull --ff-only origin main
sudo docker compose config --quiet
sudo docker compose build app
sudo docker compose up -d --no-deps app
sudo docker compose ps
curl -sS http://127.0.0.1:3001/api/health
```

The app restart is intentionally limited to `app`. Do not restart or recreate `vdgo-frontend`, `vdgo-backend`, `vdgo-db`, `gateway` or the Ollama container as part of this ScadaProfit-only update. Verify the health response reports `version: 4.3.22`. Check `ollama.modelInstalled` before relying on Qwen.
