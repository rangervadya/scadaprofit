# Docker deployment for CAD Sketch Converter Offline 2.2

## What runs in Docker

- `app`: Node.js + Python/OpenCV + Tesseract + SVG/DXF renderer.
- `ollama`: local Ollama API with the Qwen2.5-VL-3B model stored in the persistent `ollama_data` volume.
- The web app is published on host port `3001` by default to avoid colliding with the existing service on port `3000`.

The first build/pull requires internet. After the image, packages and model are present, conversion runs locally. `docker compose down` preserves model data. **Do not run `docker compose down -v` unless you intentionally want to delete the model volume.**

## 1. Check prerequisites on Ubuntu

```bash
docker --version
docker compose version
docker run --rm --gpus all ubuntu nvidia-smi
```

The third command must show the GTX 1060. If Docker says that GPU support/runtime is unavailable, install/configure NVIDIA Container Toolkit as described in the official Ollama Docker guide:
https://github.com/ollama/ollama/blob/main/docs/docker.mdx

For example, if the toolkit is already installed but not configured:

```bash
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

Warning: restarting Docker may briefly interrupt other containers (e.g. n8n). Do this only when you can tolerate that interruption.

## 2. Start the fully containerized stack

Run these commands from this directory:

```bash
docker compose -f compose.yaml up -d --build
docker compose -f compose.yaml exec ollama ollama pull qwen2.5vl:3b
docker compose -f compose.yaml restart app
```

The model is downloaded into Docker's persistent `ollama_data` volume. Since the host already has the model, this default all-in-Docker mode downloads a separate copy once (about 3.2 GB). It is not a per-request fee.

Check status/logs:

```bash
docker compose -f compose.yaml ps
docker compose -f compose.yaml logs -f app
docker compose -f compose.yaml exec ollama ollama ps
curl -s http://127.0.0.1:3001/api/health | python3 -m json.tool
curl -I http://127.0.0.1:3001/
```

Open `http://SERVER_IP:3001` from another device on the LAN. Use `hostname -I` to find `SERVER_IP`. Keep the service on a trusted LAN; it has no login screen and should not be exposed directly to the public internet.

## 3. Keep the host model and avoid downloading it again (optional)

If you prefer to reuse the Ollama service/model already installed directly on the Ubuntu host, use `compose.host-ollama.yaml` instead of the full two-container setup:

```bash
docker compose -f compose.host-ollama.yaml up -d --build
curl -s http://127.0.0.1:3001/api/health | python3 -m json.tool
```

This option containerizes the web app and its image-processing tools, but Ollama remains a host service (so it is not the fully containerized mode). It uses Linux host networking and listens on port 3001. Do not run both Compose variants simultaneously on port 3001.

## GPU memory note

The server has a 6 GB GTX 1060 and 16 GB RAM. Keep Ollama inference serial (`OLLAMA_NUM_PARALLEL=1`) and do not run Qwen Image and Qwen2.5-VL simultaneously on the GPU. If the old host Ollama service has a model loaded in VRAM while using the fully containerized stack, stop the host service first:

```bash
sudo systemctl stop ollama
```

This does not delete the host model or disable the service permanently. The fully containerized stack has its own model volume.

## Geometry quality changes in 2.2

- The image-to-CAD prompt explicitly requires multiple distinct branches and straight-segment routes, not a single curve or decorative line.
- The server validates route count/vertex count on complex scans, retries once with corrective instructions, and rejects an invalid reconstruction instead of quietly substituting a monochrome scan.
- Input aspect ratio is carried into the renderer; output geometry is not squeezed into a fixed wide rectangle.
- Vision preview JPEG quality and OCR working resolution were raised modestly to preserve annotation detail.

Qwen2.5-VL-3B is a small vision-language model, not a CAD solver. These safeguards stop obvious collapsed outputs, but cannot guarantee that it understands every line or dimension correctly. Review geometry and labels against the source before engineering use.
