FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    VDGO_HOST=0.0.0.0 \
    VDGO_PORT=8765 \
    DB_REQUIRED=1 \
    LOG_LEVEL=INFO
WORKDIR /app

COPY requirements.txt ./requirements.txt
RUN apt-get update \
    && apt-get install -y --no-install-recommends fonts-crosextra-carlito \
    && rm -rf /var/lib/apt/lists/* \
    && pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r requirements.txt

COPY app.py pdf_to_docx.py pdf_to_docx_editable.py database.py logging_setup.py ./
COPY templates ./templates
COPY template ./template
COPY assets ./assets
RUN mkdir -p /app/output /app/uploads \
    && useradd --create-home --uid 10001 vdgo \
    && chown -R vdgo:vdgo /app
USER vdgo
EXPOSE 8765
CMD ["python", "app.py"]
