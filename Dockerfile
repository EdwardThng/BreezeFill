# Stage 1: build the React app. Its output is served by the Python app in
# stage 2, so the whole product is one container behind one URL.
FROM node:20-slim AS frontend

WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build


# Stage 2: the API, plus the built frontend as static files.
FROM python:3.12-slim

WORKDIR /app

COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY backend/ backend/
COPY forms/ forms/
# The site's download button zips this directory on request, so the extension
# has to be in the image. It is not imported or executed by the server — it is
# payload, served as a file.
COPY extension/ extension/
COPY --from=frontend /build/dist frontend/dist

EXPOSE 8080
CMD ["python", "-m", "uvicorn", "main:app", "--app-dir", "backend", "--host", "0.0.0.0", "--port", "8080"]
