# Infrastructure

- `docker/app.Dockerfile` — build definition for the main app (build context remains the repository root).
- `nginx/nginx-unified.conf` — gateway routes and role-protected VDGO proxy.
- `compose/` — optional Compose overrides.
- `scripts/` — host setup and Ollama maintenance helpers.

Run Docker Compose commands from the repository root.
