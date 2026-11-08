# ScadaProfit 4.3.25

The 4.3.25 update is cumulative from the supplied 4.3.23 project. It retains the 4.3.24 house-scheme queue, topology-aware cleanup, review-only candidates, and editable Manual CAD, and adds an optional Yandex Cloud AI provider for handwritten OCR and multimodal pipeline-route proposals.

Local Qwen3-VL and Tesseract remain installed and active. Yandex is opt-in and disabled until configured. Cloud routes are still checked against original image ink and OpenCV geometry; unverified text and uncertain topology remain review items. The Yandex API key is stored in the existing private ScadaProfit data volume, not in the browser, Compose, or Git.

This package changes only the primary ScadaProfit files listed in `UPDATE-MANIFEST-4.3.25.txt`. `vdgo/`, Compose, Nginx, PostgreSQL, and their volumes are not modified. Follow `UPGRADE-GIT-4.3.25-RU.md`. Real Yandex API calls and server-side Docker validation require testing after installation with the user's Yandex Cloud credentials.
