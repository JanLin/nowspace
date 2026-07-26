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
from backend.routers import plan, coach, memory, vault, notes, settings, habits, timelog, handoff

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
app.include_router(handoff.router)


@app.get("/health")
async def health():
    from backend.models import BUCKET_SCHEMA_VERSION
    # schema_version lets clients detect skew at boot: a client that speaks
    # a NEWER version than this backend must not edit (its saves would be
    # refused by extra=forbid anyway, but the banner explains why), and a
    # client OLDER than this backend gets told to update/reload.
    return {"status": "ok", "schema_version": BUCKET_SCHEMA_VERSION}


@app.get("/update-check")
def update_check():
    """Report the version running at the configured deployment (the always-on
    server tracks main, so it is effectively "latest"). The desktop app is a
    frozen bundle that only changes via a rebuild — this lets it notice one
    is worth doing. Null when unconfigured or unreachable."""
    if not config.update_check_url:
        return {"version": None}
    try:
        import httpx
        r = httpx.get(config.update_check_url, timeout=4)
        r.raise_for_status()
        return {"version": r.json().get("version")}
    except Exception:
        return {"version": None}


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
