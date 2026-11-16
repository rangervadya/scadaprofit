# Tests

- `node/` — workforce, authorization, inbox and CAD JavaScript tests.
- `python/` — recognition engine tests.
- `vdgo/` — PDF/Word generation and conclusion-service regressions.

Run all main-app tests with `npm --prefix backend run check`. Run the VDGO regression suite from the root with `PYTHONPATH=backend/engine python -m unittest discover -s tests/vdgo -p 'test_*.py' -v`.
