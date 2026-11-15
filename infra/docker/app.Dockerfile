# Build the unified ScadaProfit frontend (all role screens, including VDGO)
# as one SPA bundle served by the main app at /vdgo/.
FROM node:22-bookworm-slim AS frontend-build
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM node:22-bookworm-slim AS app

ENV NODE_ENV=production \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PYTHONUNBUFFERED=1 \
    OMP_THREAD_LIMIT=2 \
    OPENBLAS_NUM_THREADS=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv libcairo2 tesseract-ocr tesseract-ocr-eng tesseract-ocr-rus tesseract-ocr-osd \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY services/ollama/requirements.txt /tmp/requirements.txt
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/python -m pip install --no-cache-dir --upgrade pip \
    && /opt/venv/bin/python -m pip install --no-cache-dir -r /tmp/requirements.txt

ENV PATH="/opt/venv/bin:${PATH}"

COPY services/ollama/package.json services/ollama/package-lock.json ./services/ollama/
WORKDIR /app/services/ollama
RUN npm ci --omit=dev --no-audit --no-fund
COPY services/ollama/ ./
RUN DATABASE_URL='postgresql://build:build@localhost:5432/build' npx prisma generate --schema prisma/schema.prisma
COPY VERSION /app/VERSION
# Only the built SPA is shipped: sources, tests and dev configs are CI concerns
# (P2-8) and must not ship in the runtime image.
COPY --from=frontend-build /frontend/public/ /app/frontend/public/
COPY --from=frontend-build /frontend/public/vdgo/ /app/frontend/public/vdgo/
COPY services/vdgo/app.py /app/services/vdgo/app.py
COPY services/vdgo/templates/index.html /app/services/vdgo/templates/index.html
RUN test -s /app/frontend/public/vdgo/index.html \
    && test -s /app/frontend/public/vdgo/assets/ \
    && chown -R node:node /app \
    && mkdir -p /data/cad-reconstruction-jobs \
    && chown -R node:node /data

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "start"]
