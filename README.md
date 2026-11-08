# ScadaProfit 4.3.28

This update replaces the retired Yandex AI integration with an optional OpenRouter multimodal provider using `nvidia/nemotron-3.5-super-vl:free`. The model is used for whole-image handwriting OCR and pipe-route suggestions. Every suggested route remains subject to local source-ink and topology validation; uncertain labels and joins remain review items.

Local Ollama Qwen3-VL and Tesseract are retained as fallbacks/supplementary OCR. OpenRouter is disabled until its API key is explicitly saved and enabled in ScadaProfit. The API key is stored in the existing private ScadaProfit data volume and is never returned to the browser or committed to Git.

The free OpenRouter model has provider/platform rate limits (currently 50 requests/day and 20/minute for free models). Two cloud calls are used by a full test/analysis (OCR and route tracing). Failed requests may count against the daily quota. The free NVIDIA endpoint may log prompts and images for service improvement; do not send confidential drawings or images containing personal information. Use an anonymized copy for testing.

This patch changes only the primary ScadaProfit app and its tests/docs. It does not modify `vdgo/`, `compose.yaml`, Nginx, PostgreSQL or Docker volumes. Apply using `UPGRADE-GIT-4.3.28-RU.md`. A real OpenRouter request and Docker deployment must be tested after installation using the user's key.
