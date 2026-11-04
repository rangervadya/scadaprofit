# Docker deployment · CAD Reconstruction Engine 4.3.6

The app image includes Node.js, Python, OpenCV, Pillow and Tesseract with English/Russian language data. Job uploads, graphs, progress logs and user-confirmed joins are stored in the persistent `cad_jobs` named volume at `/data/cad-reconstruction-jobs`; Ollama model files remain in the separate `ollama_data` volume. The Compose stack also provides a local Ollama service for Qwen3-VL handwriting OCR and semantic pipe centre-line tracing. Selected and connected OpenCV graph paths form the primary PIPE_MAIN geometry. Qwen semantic routes are additional review suggestions on QWEN_REVIEW; unselected OpenCV fragments remain on DETAIL_REVIEW. Ollama is used for OCR and semantic suggestions, but it is not required to build the primary OpenCV geometry.

On first setup, download the model into the persistent Ollama volume:

```bash
docker compose exec ollama ollama pull qwen3-vl:4b
```

The app now waits for the Ollama service to become healthy. The model itself must still be pulled once. Check `http://SERVER:3001/api/health`; `ollama.reachable` and `ollama.modelInstalled` must both be `true`.

Then build and recreate the app:

```bash
docker compose build --no-cache app
docker compose up -d --force-recreate app
```

For Ollama running directly on the host, include `compose.host-ollama.yaml`. If Ollama is unavailable, OpenCV candidate extraction continues, but the application clearly labels the vector sheet as a geometric draft rather than a completed pipe CAD reconstruction.

Never use `docker compose down -v` for an in-place upgrade: it may delete both `ollama_data` (models) and `cad_jobs` (source images, graphs and confirmed connections).
