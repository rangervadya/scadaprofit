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
COPY backend/requirements.txt /tmp/requirements.txt
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/python -m pip install --no-cache-dir --upgrade pip \
    && /opt/venv/bin/python -m pip install --no-cache-dir -r /tmp/requirements.txt

ENV PATH="/opt/venv/bin:${PATH}"

COPY backend/package.json ./backend/package.json
WORKDIR /app/backend
RUN npm install --omit=dev --no-audit --no-fund
COPY backend/ ./
COPY frontend/package.json /app/frontend/package.json
COPY frontend/package-lock.json /app/frontend/package-lock.json
COPY frontend/public/ /app/frontend/public/
COPY --from=frontend-build /frontend/public/vdgo/ /app/frontend/public/vdgo/
COPY services/vdgo/backend/app.py /app/services/vdgo/backend/app.py
COPY services/vdgo/backend/templates/index.html /app/services/vdgo/backend/templates/index.html
COPY tests/ /app/tests/
COPY compose.yaml /app/compose.yaml
COPY infra/docker/app.Dockerfile /app/infra/docker/app.Dockerfile
COPY infra/nginx/nginx-unified.conf /app/infra/nginx/nginx-unified.conf
RUN test -s /app/frontend/public/vdgo/index.html \
    && npm run check \
    && chown -R node:node /app \
    && mkdir -p /data/cad-reconstruction-jobs \
    && chown -R node:node /data

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "start"]
