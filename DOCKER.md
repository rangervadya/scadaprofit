# Docker deployment · CAD Reconstruction Engine 4.3.20

The application container uses the named volume `cad_jobs` mounted at `/data/cad-reconstruction-jobs`. Do not run `docker compose down -v` during an upgrade: it removes named volumes. Keep your `.env` file and existing Git repository.

Build and restart only the app service after pushing the release to GitHub:

```bash
git pull --ff-only origin main
sudo docker compose config --quiet
sudo docker compose build app
sudo docker compose up -d --no-deps app
curl -sS http://127.0.0.1:3001/api/health
```

Verify that the health response reports `version: 4.3.20`.
