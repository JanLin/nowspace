# Stage 1: Build frontend
FROM node:20-slim AS frontend-build
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: Python runtime
FROM python:3.11-slim
WORKDIR /app

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy backend and config files
COPY backend/ ./backend/
COPY config.yaml system_prompt.md ./

# Copy built frontend
COPY --from=frontend-build /build/dist ./frontend/dist/

# Create memory directory
RUN mkdir -p memory

# Default memory file (will be overridden by volume mount if exists)
COPY memory/agent_memory.md ./memory/agent_memory.md

EXPOSE 8000

CMD ["python", "-m", "uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
