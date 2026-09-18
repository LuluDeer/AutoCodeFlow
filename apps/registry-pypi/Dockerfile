# O-7: 多阶段构建——构建依赖（gcc 等）不留在最终镜像，与 executor-python 的
# --prefix=/install 模式对齐（镜像体积/攻击面双降）
FROM python:3.12-slim AS builder
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

FROM python:3.12-slim
WORKDIR /app
COPY --from=builder /install /usr/local
COPY main.py .
# E-10（DEEP_REVIEW 0ef3bbe）：非 root 用户运行——此前镜像以 root 启动。
RUN useradd -r -u 1001 appuser && chown -R appuser:appuser /app
USER appuser
VOLUME ["/data/packages"]
EXPOSE 8003

# O-1: 内置健康探针（独立 docker run / K8s 形态可用；compose 定义优先）
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8003/health')"

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8003"]
