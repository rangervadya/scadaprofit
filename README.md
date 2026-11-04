# CAD Reconstruction Engine 4.3.6

Version 4.3.6 groups competing endpoint candidates, previews them on the source drawing, and persists explicit user-confirmed connections to the job graph. Jobs can be restored from their `?job=<uuid>` URL. Candidate scores are ranking aids, not probabilities; no uncertain join is made automatically. Jobs and confirmed connections live in a dedicated Docker named volume and survive app-container recreation.

Retains the 45-minute Python timeout, streaming progress logs, and short/ambiguous endpoint diagnostics. Verify all geometry against the original engineering drawing before use. See `README-RU.md` and `INSTALL-4.3.6-RU.md`.
