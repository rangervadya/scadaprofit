# Docker Compose 2.4

## Services
- `app`: Express, OpenCV, Tesseract, JSON-schema parser, SVG/DXF/PNG renderer.
- `ollama`: local model API.
- `model-init`: one-shot setup that uses Ollama API to check/pull `QWEN_MODEL` into the persistent volume before the app starts.

## Start

```bash
docker compose up -d --build
docker compose ps
docker compose exec ollama ollama list
curl -s http://127.0.0.1:3001/api/health | python3 -m json.tool
```

For the first run, model-init downloads the model if missing. To pull explicitly:

```bash
docker compose exec ollama ollama pull qwen2.5vl:3b
docker compose restart app
```

Do not run `docker compose down -v` unless you want to delete the persistent model volume.

## Reuse host Ollama instead

The alternative `compose.host-ollama.yaml` places only the app in Docker and points it to Ollama already installed on the host:

```bash
docker compose -f compose.host-ollama.yaml up -d --build
```

Do not run both variants on the same port simultaneously.

## GTX 1060 note

Use only one model/query at a time; avoid other GPU-heavy applications. A 6 GB GTX 1060 is a tight configuration. Ollama can offload some work to RAM, but this lowers speed. If GPU passthrough is unavailable, verify NVIDIA Container Toolkit and run `docker run --rm --gpus all ubuntu nvidia-smi`. Restarting Docker may briefly interrupt other containers.

## Quality note

The model receives JSON Schema output constraints and analyzes overlapping crops. This guarantees JSON structure, not correct topology. The app rejects obvious one-line/collapsed responses. All line connections and labels still require human verification before engineering use.
