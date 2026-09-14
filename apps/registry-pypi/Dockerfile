FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY main.py .
# E-10（DEEP_REVIEW 0ef3bbe）：非 root 用户运行——此前镜像以 root 启动。
RUN useradd -r -u 1001 appuser && chown -R appuser:appuser /app
USER appuser
VOLUME ["/data/packages"]
EXPOSE 8003
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8003"]
