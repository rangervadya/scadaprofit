FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHON_BIN=/opt/venv/bin/python \
    NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-pip python3-opencv \
      tesseract-ocr tesseract-ocr-rus tesseract-ocr-eng \
      libcairo2 curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv --system-site-packages /opt/venv \
    && /opt/venv/bin/python -m pip install --no-cache-dir --upgrade pip \
    && /opt/venv/bin/python -m pip install --no-cache-dir pytesseract ezdxf cairosvg

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --chown=node:node . .
RUN npm run check && find /app -type d -name __pycache__ -prune -exec rm -rf {} + && chown -R node:node /app

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "start"]
