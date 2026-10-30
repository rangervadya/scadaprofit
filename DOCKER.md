# Docker: Two Mask Lab 3.0.0

The app image contains Node.js, Python venv, OpenCV headless, Pillow, pytesseract, and the Tesseract CLI with English/Russian trained data.

Build/recreate only the app service:

```bash
docker compose build --no-cache app
docker compose up -d --force-recreate app
```

The `ollama` service definition and `ollama_data` named volume remain present for an existing installation, but `app` has no dependency on Ollama and does not issue model requests.

Never use `docker compose down -v` for an in-place upgrade.
