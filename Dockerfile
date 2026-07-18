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
COPY config.yaml.example ./config.yaml
COPY system_prompt.md ./

# Copy built frontend
COPY --from=frontend-build /build/dist ./frontend/dist/

# Memory directory — usually volume-mounted; the backend handles a
# missing agent_memory.md (memory/ is gitignored, so it cannot be COPYed:
# clean clones don't have it)
RUN mkdir -p memory

# Starter vault — copied into the mounted vault on first run when empty
COPY ["docs/demo/Plan Week.md", "./starter-vault/Plan Week.md"]
COPY ["docs/demo/Plan Week Configuration.md", "./starter-vault/Plan Week Configuration.md"]

COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8000

ENTRYPOINT ["/entrypoint.sh"]
