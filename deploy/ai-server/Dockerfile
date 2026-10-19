# Doory reference AI server (background removal), behind Doory's contract (backend/apps/ai/contract/openapi.yaml).
# Models with open licences only (Apache-2.0, MIT). linux/amd64 and linux/arm64.
FROM python:3.12-slim@sha256:a6e34c598f2467ed0e9a8d349809fcd8b5c603269512df273a0bb1784edc11b1

# The models baked into the image. They are downloaded here, at build time, from rembg's GitHub release
# (github.com/danielgatis/rembg/releases/tag/v0.0.0), and rembg checks each file against the checksum it ships
# with, so the running container needs no network. Keep it the same as AVAILABLE_MODELS.
ARG MODELS="isnet-general-use,u2netp"

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    U2NET_HOME=/models \
    NUMBA_CACHE_DIR=/tmp/numba \
    OMP_NUM_THREADS=4 \
    PORT=7000 \
    AVAILABLE_MODELS=${MODELS}

RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 10001 app && useradd -u 10001 -g app -M -s /usr/sbin/nologin app

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

RUN mkdir -p /models && python -c "import os; from rembg import new_session; [new_session(m.strip()) for m in os.environ['AVAILABLE_MODELS'].split(',') if m.strip()]" \
    && chmod -R a+rX /models

COPY app.py .

USER app
EXPOSE 7000

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD python -c "import os, urllib.request; urllib.request.urlopen(f\"http://127.0.0.1:{os.environ['PORT']}/health\")"

CMD ["sh", "-c", "exec uvicorn app:app --host 0.0.0.0 --port \"$PORT\" --workers 1 --no-server-header --timeout-graceful-shutdown 20"]
