"""Notes endpoints: read/write/append vault markdown files."""

from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.config import config
from backend.vault_index import refresh_index

router = APIRouter(prefix="/api/notes", tags=["notes"])


class WriteRequest(BaseModel):
    path: str  # relative path from vault root
    content: str


class AppendRequest(BaseModel):
    path: str  # relative path from vault root
    content: str


class CreateRequest(BaseModel):
    folder: str  # relative folder path from vault root
    name: str  # filename (without .md)
    template: str = ""  # optional template content


def _resolve_path(rel_path: str) -> Path:
    """Resolve a relative vault path to absolute, with safety checks."""
    # Prevent path traversal
    if ".." in rel_path:
        raise HTTPException(status_code=400, detail="Path traversal not allowed")

    full = config.vault_root / rel_path
    # Ensure it's within vault root
    try:
        full.resolve().relative_to(config.vault_root.resolve())
    except ValueError:
        raise HTTPException(status_code=400, detail="Path is outside vault root")

    return full


@router.get("/read")
async def read_note(path: str):
    """Read a markdown file from the vault.

    path: relative path from vault root (e.g., "2-Areas/aProfessional/c iGrant/iGrant calls.md")
    """
    full = _resolve_path(path)
    if not full.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {path}")

    try:
        content = full.read_text(encoding="utf-8")
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Error reading file: {e}")

    try:
        modified = datetime.fromtimestamp(full.stat().st_mtime).isoformat()
    except OSError:
        modified = ""

    return {
        "content": content,
        "modified": modified,
        "path": path,
    }


@router.post("/write")
async def write_note(req: WriteRequest):
    """Write markdown content to a vault file (overwrite)."""
    full = _resolve_path(req.path)

    # Ensure parent directory exists
    full.parent.mkdir(parents=True, exist_ok=True)

    try:
        full.write_text(req.content, encoding="utf-8")
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Error writing file: {e}")

    modified = datetime.fromtimestamp(full.stat().st_mtime).isoformat()
    return {"success": True, "modified": modified, "path": req.path}


@router.post("/append")
async def append_note(req: AppendRequest):
    """Append content to an existing vault file. Creates file if it doesn't exist."""
    full = _resolve_path(req.path)

    full.parent.mkdir(parents=True, exist_ok=True)

    try:
        existing = full.read_text(encoding="utf-8") if full.exists() else ""
    except OSError:
        existing = ""

    # Ensure newline separation
    separator = "\n" if existing and not existing.endswith("\n") else ""
    new_content = existing + separator + req.content

    try:
        full.write_text(new_content, encoding="utf-8")
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Error appending to file: {e}")

    modified = datetime.fromtimestamp(full.stat().st_mtime).isoformat()
    return {"success": True, "modified": modified, "path": req.path}


@router.post("/create")
async def create_note(req: CreateRequest):
    """Create a new markdown file in the specified folder."""
    folder_path = _resolve_path(req.folder)
    if not folder_path.exists():
        folder_path.mkdir(parents=True, exist_ok=True)

    filename = req.name if req.name.endswith(".md") else f"{req.name}.md"
    file_path = folder_path / filename
    rel_path = str(file_path.relative_to(config.vault_root))

    if file_path.exists():
        raise HTTPException(status_code=409, detail=f"File already exists: {rel_path}")

    content = req.template or f"# {req.name}\n\n"

    try:
        file_path.write_text(content, encoding="utf-8")
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Error creating file: {e}")

    # Keep the vault index current so the new note resolves immediately when its
    # [[link]] is clicked (Obsidian keeps its index live; we were only rebuilding
    # lazily, so freshly created notes weren't findable).
    refresh_index()

    modified = datetime.fromtimestamp(file_path.stat().st_mtime).isoformat()
    return {"success": True, "modified": modified, "path": rel_path}
