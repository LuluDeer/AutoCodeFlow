# Build stage — install deps
FROM python:3.12-slim@sha256:aa943ce411423c7582288f18707ff66eddcbaeb510502d747a72aeb34f30d159 AS builder
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# Runtime stage — lean image
FROM python:3.12-slim@sha256:aa943ce411423c7582288f18707ff66eddcbaeb510502d747a72aeb34f30d159
WORKDIR /app

# Copy pre-installed packages from builder (including the pinned uv binary).
COPY --from=builder /install /usr/local

COPY . .

# SEC-07 / D2-P1-1: bubblewrap is opt-in (docker-compose.secure.yml), but the
# binary must exist in the image for that overlay to work. Installing it here
# does not enable the sandbox: TASK_SANDBOX stays empty by default.
RUN apt-get update \
    && apt-get install -y --no-install-recommends bubblewrap \
    && rm -rf /var/lib/apt/lists/*

# Q-08: run as non-root user to reduce container attack surface. uv is installed
# by pip under /usr/local/bin (not root's home), which is on PATH for appuser.
#
# ESM-2/UV-1: 期望版本从 requirements.txt 现场解析，不再硬编码。此前字面量
# 'uv 0.11.15' 与 requirements.txt 的 uv==0.12.18 漂移（依赖审计升级只改了
# requirements.txt），导致两条断言在任何输入下都必然失败、镜像构建全红。
RUN UV_EXPECTED="$(sed -nE 's/^uv==([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' requirements.txt | head -n1)" \
    && test -n "$UV_EXPECTED" \
    && addgroup --system appgroup && adduser --system --ingroup appgroup --no-create-home appuser \
    && mkdir -p /data/tasks /tmp/appuser-home \
    && chown -R appuser:appgroup /data/tasks /app /tmp/appuser-home \
    && command -v uv \
    && test "$(uv --version | grep -oE 'uv [0-9]+\.[0-9]+\.[0-9]+' | head -n1)" = "uv $UV_EXPECTED"
USER appuser

# Keep the runtime lookup explicit and independent of root's home directory.
# appuser intentionally has no root-owned home; give uv a writable cache home.
ENV PATH="/usr/local/bin:${PATH}" \
    HOME="/tmp/appuser-home" \
    UV_CACHE_DIR="/tmp/appuser-home/.cache/uv"

# Build-time regression: execute the pinned binary as the actual runtime user
# and exercise the exact flag used by routers/execute.py.
RUN UV_EXPECTED="$(sed -nE 's/^uv==([0-9]+\.[0-9]+\.[0-9]+).*/\1/p' requirements.txt | head -n1)" \
    && test "$(uv --version | grep -oE 'uv [0-9]+\.[0-9]+\.[0-9]+' | head -n1)" = "uv $UV_EXPECTED" \
    && uv venv --no-project /tmp/uv-build-check \
    && test -x /tmp/uv-build-check/bin/python \
    && rm -rf /tmp/uv-build-check

EXPOSE 8001

# O-1: 内置健康探针（独立 docker run / K8s 形态可用；compose 定义优先）
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8001/health')"

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001"]
