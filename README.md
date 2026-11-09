# ScadaProfit 4.3.40 — open centreline vectorization

This release adds source-ink skeletonization and exports open SVG paths and DXF `LWPOLYLINE` entities rather than thousands of closed contour loops. The result viewer now defaults to **Source lines**, with separate **Source contours** and **CAD reconstruction** modes. The centreline vectorizer is implemented with NumPy only; no scikit-image, OpenCV-contrib, GPU memory, or other-application process is required.

The open polylines preserve visible source strokes and join incident branches to shared vector nodes. They do not classify each stroke as a pipe, dimension line, symbol, or text. Semantic pipe connectivity still requires Qwen/OpenCV analysis and engineering review.

Local Qwen-VL through Ollama and Tesseract (`rus+eng`) remain the recognition stack. A partial OCR result does not suppress the independent PIPE pass. Qwen request resource limits are applied by ScadaProfit; no Ollama restart or modification to other application processes is required.

VDGO, `vdgo/`, Compose configuration, gateway/Nginx, PostgreSQL, persistent volumes, and the user's `.env` are not changed in this release. Deploy by rebuilding only the application service:

```bash
docker compose build app
docker compose up -d --no-deps app
```

Run offline checks with `npm run check`. The tests cover junction polyline generation, isolated-dot rejection, L-route preservation, and connected one-pixel thinning. A live inference run against the user's Ollama server is not part of package validation.
