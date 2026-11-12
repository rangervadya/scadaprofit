# Unified frontend

This is the single frontend workspace for all ScadaProfit browser interfaces.

- `public/` — the main ScadaProfit interface, served by `backend/api/server.js`.
- `vdgo/` — the React/TypeScript technical-conclusion module. It is built into `public/vdgo/` and is served by the same application server at `/vdgo/`.
- `package.json` — the shared frontend workspace and Vite/TypeScript toolchain.

Build the VDGO UI from the repository root with `npm --prefix frontend ci` and `npm --prefix frontend run build`. Docker performs this build automatically as part of the `app` image; there is no separate `vdgo-frontend` container anymore.

The VDGO API, document generator and PostgreSQL integration remain separate under `services/vdgo/backend/`.
