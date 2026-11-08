# ScadaProfit 4.3.27

The 4.3.27 update is cumulative from the supplied 4.3.23 project. It retains the 4.3.24 house-scheme queue, topology-aware cleanup, review-only candidates, and editable Manual CAD, and adds an optional Yandex Cloud AI provider for handwritten OCR and multimodal pipeline-route proposals.

When enabled, Yandex Vision OCR now runs first on the full image. Local Qwen3-VL remains the fallback when Yandex is disabled, fails, or returns no annotations; Tesseract remains a supplemental OCR source. This avoids waiting for nine sequential local OCR tiles before the configured cloud OCR is attempted. Yandex is opt-in and disabled until configured. Cloud routes are still checked against original image ink and OpenCV geometry; unverified text and uncertain topology remain review items. The Yandex API key is stored in the existing private ScadaProfit data volume, not in the browser, Compose, or Git.

This package changes only the primary ScadaProfit files listed in `UPDATE-MANIFEST-4.3.27.txt`. `vdgo/`, Compose, Nginx, PostgreSQL, and their volumes are not modified. Follow `UPGRADE-GIT-4.3.27-RU.md`. Real Yandex API calls and server-side Docker validation require testing after installation with the user's Yandex Cloud credentials.
