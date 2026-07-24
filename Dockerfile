FROM python:3.12-slim

WORKDIR /app

COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY backend/ backend/
COPY forms/ forms/

EXPOSE 8080
CMD ["python", "-m", "uvicorn", "main:app", "--app-dir", "backend", "--host", "0.0.0.0", "--port", "8080"]
