# ScadaProfit 4.3.28

This update adds MOSS-VL (`moss-vl-1.0`) as the primary cloud multimodal provider for handwritten OCR and pipe-route suggestions. The server uploads a temporary image file to MOSS (`POST /v1/files`), references its `file_id` in `POST /v1/responses`, and deletes the uploaded file after each request. Suggested routes remain subject to local source-ink and topology validation; uncertain labels and joins remain review items.

Local Ollama Qwen3-VL and Tesseract are retained as fallbacks/supplementary OCR. MOSS is disabled until its API key is explicitly saved and enabled in ScadaProfit. The API key is stored in the existing private ScadaProfit data volume and is never returned to the browser or committed to Git. OpenRouter remains as a dormant optional provider but is bypassed while MOSS is enabled.

The MOSS-VL model page currently marks the model as temporarily free (0 credits); this may change. Each OCR/pipe test sends the source image to MOSS for inference. Use an anonymized copy for testing; do not send confidential drawings or images containing personal information.

This patch changes only the primary ScadaProfit app and its tests/docs. It does not modify `vdgo/`, `compose.yaml`, Nginx, PostgreSQL or Docker volumes. Apply using `UPGRADE-GIT-4.3.28-RU.md`. A real OpenRouter request and Docker deployment must be tested after installation using the user's key.
