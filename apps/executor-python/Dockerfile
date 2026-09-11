# Build stage — install deps
FROM python:3.12-slim AS builder
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# Runtime stage — lean image
FROM python:3.12-slim
WORKDIR /app

# Copy pre-installed packages from builder (including the pinned uv binary).
COPY --from=builder /install /usr/local

COPY . .

# Q-08: run as non-root user to reduce container attack surface. uv is installed
# by pip under /usr/local/bin (not root's home), which is on PATH for appuser.
RUN addgroup --system appgroup && adduser --system --ingroup appgroup --no-create-home appuser \
    && mkdir -p /data/tasks /tmp/appuser-home \
    && chown -R appuser:appgroup /data/tasks /app /tmp/appuser-home \
    && command -v uv \
    && uv --version | grep -Fx 'uv 0.8.17'
USER appuser

# Keep the runtime lookup explicit and independent of root's home directory.
# appuser intentionally has no root-owned home; give uv a writable cache home.
ENV PATH="/usr/local/bin:${PATH}" \
    HOME="/tmp/appuser-home" \
    UV_CACHE_DIR="/tmp/appuser-home/.cache/uv"

# Build-time regression: execute the pinned binary as the actual runtime user
# and exercise the exact flag used by routers/execute.py.
RUN uv --version | grep -Fx 'uv 0.8.17' \
    && uv venv --no-project /tmp/uv-build-check \
    && test -x /tmp/uv-build-check/bin/python \
    && rm -rf /tmp/uv-build-check

EXPOSE 8001

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001"]
