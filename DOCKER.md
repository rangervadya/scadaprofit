# Docker deployment · CAD Reconstruction Engine 4.2.0

The app image includes Node.js, Python, OpenCV, Pillow and Tesseract with English/Russian language data. The Compose stack also provides a local Ollama service for Qwen3-VL handwriting OCR.

On first setup, download the model into the persistent Ollama volume:

```bash
docker compose exec ollama ollama pull qwen3-vl:4b
```

Then build and recreate the app:

```bash
docker compose build --no-cache app
docker compose up -d --force-recreate app
```

For Ollama running directly on the host, include `compose.host-ollama.yaml`. If Ollama is unavailable, line extraction continues and Tesseract remains the OCR fallback.

Never use `docker compose down -v` for an in-place upgrade: it may delete the named `ollama_data` model volume.
