# VDGO frontend module

The VDGO React/TypeScript application is part of the unified `frontend/` workspace. Its production assets are emitted to `frontend/public/vdgo/`, then served by the main ScadaProfit Node.js application at `/vdgo/`.

The document API remains a separate service at `services/vdgo/backend/`; Nginx routes `/vdgo/api/`, `/vdgo/legacy`, `/vdgo/generate`, `/vdgo/generate_docx` and `/vdgo/preview` to that backend after the shared workforce authentication check.
