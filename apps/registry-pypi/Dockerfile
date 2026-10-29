# O-7: 多阶段构建——构建依赖（gcc 等）不留在最终镜像，与 executor-python 的
# --prefix=/install 模式对齐（镜像体积/攻击面双降）
FROM python:3.12-slim@sha256:aa943ce411423c7582288f18707ff66eddcbaeb510502d747a72aeb34f30d159 AS builder
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

FROM python:3.12-slim@sha256:aa943ce411423c7582288f18707ff66eddcbaeb510502d747a72aeb34f30d159
WORKDIR /app
COPY --from=builder /install /usr/local
COPY main.py .
# E-10（DEEP_REVIEW 0ef3bbe）：非 root 用户运行——此前镜像以 root 启动。
RUN useradd -r -u 1001 appuser && chown -R appuser:appuser /app
# P1-2（UIAUDIT4）：/data/packages 必须在镜像内就存在且属 appuser——
# 命名卷首次挂载时 Docker 按镜像内该路径的内容与属主初始化卷；路径在
# 镜像里缺失时挂载点由 Docker 以 root 创建（实测 demo 栈 /data/packages
# root:root，appuser 写路径全 500 PermissionError）。仅 chown /app 不覆盖本卷。
RUN mkdir -p /data/packages && chown -R appuser:appuser /data
USER appuser
VOLUME ["/data/packages"]
EXPOSE 8003

# O-1: 内置健康探针（独立 docker run / K8s 形态可用；compose 定义优先）
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8003/health')"

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8003"]
