"""FastAPI application entry point."""

import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

# Load .env from project root
load_dotenv(Path(__file__).resolve().parent.parent / ".env", override=True)

from backend.config import config
from backend.routers import plan, coach, memory, vault, notes, settings, habits, timelog

app = FastAPI(title="Personal Coaching Agent", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=config.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(plan.router)
app.include_router(coach.router)
app.include_router(memory.router)
app.include_router(vault.router)
app.include_router(notes.router)
app.include_router(settings.router)
app.include_router(habits.router)
app.include_router(timelog.router)


@app.get("/health")
async def health():
    return {"status": "ok"}


# Serve frontend static files in production (when frontend/dist exists)
_frontend_dist = Path(__file__).resolve().parent.parent / "frontend" / "dist"
if _frontend_dist.is_dir():
    app.mount("/assets", StaticFiles(directory=str(_frontend_dist / "assets")), name="assets")

    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        """Serve the React SPA for any non-API route."""
        file_path = _frontend_dist / full_path
        if file_path.is_file():
            return FileResponse(str(file_path))
        return FileResponse(str(_frontend_dist / "index.html"))
