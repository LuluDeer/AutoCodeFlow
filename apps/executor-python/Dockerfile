FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Q-08: run as non-root user to reduce container attack surface
RUN addgroup --system appgroup && adduser --system --ingroup appgroup --no-create-home appuser \
    && mkdir -p /data/tasks && chown -R appuser:appgroup /data/tasks /app
USER appuser

EXPOSE 8001

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001"]
