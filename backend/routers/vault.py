"""Vault endpoints: file index, search, linked document discovery."""

import shutil
from pathlib import Path
from typing import Optional, List

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.config import config


class MoveRequest(BaseModel):
    source: str
    destination: str


class PinnedNotesRequest(BaseModel):
    pinned: List[str]


class CreateFolderRequest(BaseModel):
    path: str
from backend.vault_index import (
    refresh_index,
    get_index,
    search,
    resolve_group_to_folder,
    discover_linked_docs,
    resolve_name,
    read_vault_reference_links,
)

router = APIRouter(prefix="/api/vault", tags=["vault"])


@router.get("/index")
async def vault_index():
    """Return the full vault file index. Refreshes on each call."""
    count = refresh_index()
    files = get_index()
    return {"files": files, "count": count}


@router.get("/search")
async def vault_search(q: str, max_results: int = 20):
    """Fuzzy search for files matching query. Used for wiki link autocomplete."""
    if not q or len(q) < 1:
        return {"results": []}
    results = search(q, max_results=max_results)
    return {"results": results}


@router.get("/resolve")
async def vault_resolve(name: str):
    """Resolve a wiki-link name to a file path by unique basename (Obsidian-style).

    Used for click-to-open on [[links]]. Unlike fuzzy /search this matches the
    note's basename exactly. Refreshes the index on a miss so a just-created note
    resolves without waiting for the next full re-index.
    """
    if not name or not name.strip():
        return {"path": None, "name": name}
    # Obsidian uses the target before any #heading or |alias
    base = name.split("|")[0].split("#")[0].strip()
    path = resolve_name(base)
    if not path:
        refresh_index()
        path = resolve_name(base)
    if not path:
        return {"path": None, "name": base}
    return {"path": path, "name": Path(path).stem}


@router.get("/linked-docs")
async def vault_linked_docs(group: str, week_offset: int = 0):
    """Resolve a group name to its project folder and discover linked documents.

    Resolution order:
    1. config.yaml reference_links (explicit setup wins)
    2. Week header references (e.g., "igrant: [[iGrant calls]]")
    3. Vault index search

    Returns call logs, project files, subfolders, and wiki refs.
    """
    if not group:
        raise HTTPException(status_code=400, detail="group parameter is required")

    # Parse week header references from current Plan Week.md
    week_refs = _parse_week_header_refs(week_offset)

    folder_path = resolve_group_to_folder(group, week_refs=week_refs)
    if not folder_path:
        return {
            "folder_path": None,
            "call_logs": [],
            "project_files": [],
            "subfolders": [],
            "wiki_refs": [],
        }

    docs = discover_linked_docs(folder_path)

    # Add wiki refs from week header
    wiki_refs = []
    group_lower = group.lower()
    if week_refs:
        for key, wiki_link in week_refs.items():
            if key.lower() == group_lower:
                resolved = resolve_name(wiki_link)
                wiki_refs.append({
                    "name": wiki_link,
                    "path": resolved or "",
                })

    docs["wiki_refs"] = wiki_refs
    return docs


@router.get("/reference-links")
async def vault_reference_links():
    """Return reference_links from Plan Week Configuration.md."""
    links = read_vault_reference_links()
    return {"links": links}


@router.get("/folder")
async def vault_folder(path: str = "1-Projects"):
    """List markdown files in a vault folder (non-recursive)."""
    from datetime import datetime

    folder = config.vault_root / path
    if not folder.exists() or not folder.is_dir():
        return {"path": path, "files": []}
    files = []
    for f in sorted(folder.iterdir(), key=lambda x: x.name.lower()):
        if f.is_file() and f.suffix == ".md":
            try:
                mtime = datetime.fromtimestamp(f.stat().st_mtime).isoformat()
            except OSError:
                mtime = ""
            files.append({"name": f.stem, "path": str(f.relative_to(config.vault_root)), "type": "file", "modified": mtime})
        elif f.is_dir() and not f.name.startswith("."):
            files.append({"name": f.name, "path": str(f.relative_to(config.vault_root)), "type": "folder", "modified": ""})
    return {"path": path, "files": files}


def _safe_vault_path(rel_path: str) -> Path:
    """Resolve a relative path within vault root, rejecting traversal attacks."""
    resolved = (config.vault_root / rel_path).resolve()
    if not str(resolved).startswith(str(config.vault_root.resolve())):
        raise HTTPException(status_code=400, detail="Path outside vault")
    return resolved


@router.post("/folder")
async def create_vault_folder(body: CreateFolderRequest):
    """Create a folder in the vault, parents included.

    Notes could already land in a missing folder (create_note mkdirs its
    parents), but there was no way to make the structure first — so a folder
    you wanted to file into had to be conjured by writing a note into it.
    """
    rel = (body.path or "").strip().strip("/")
    if not rel:
        raise HTTPException(status_code=400, detail="path is required")
    target = _safe_vault_path(rel)
    if target.is_dir():
        return {"success": True, "created": False, "path": rel}
    if target.exists():
        raise HTTPException(status_code=409, detail=f"A file already exists at {rel}")
    try:
        target.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Error creating folder: {e}")
    return {"success": True, "created": True, "path": rel}


@router.post("/move")
async def vault_move(body: MoveRequest):
    """Move a file or folder within the vault."""
    src = _safe_vault_path(body.source)
    dst_folder = _safe_vault_path(body.destination)

    if not src.exists():
        raise HTTPException(status_code=404, detail=f"Source not found: {body.source}")
    if not dst_folder.is_dir():
        raise HTTPException(status_code=400, detail=f"Destination is not a folder: {body.destination}")

    new_path = dst_folder / src.name
    if new_path.exists():
        raise HTTPException(status_code=409, detail=f"Already exists: {new_path.name}")

    shutil.move(str(src), str(new_path))
    return {"success": True, "new_path": str(new_path.relative_to(config.vault_root))}


@router.delete("/file")
async def vault_delete(path: str):
    """Delete a file from the vault (moves to trash if available)."""
    target = _safe_vault_path(path)

    if not target.exists():
        raise HTTPException(status_code=404, detail=f"Not found: {path}")
    if not target.is_file():
        raise HTTPException(status_code=400, detail="Can only delete files, not folders")

    try:
        from send2trash import send2trash
        send2trash(str(target))
    except ImportError:
        target.unlink()

    return {"success": True, "path": path}


@router.get("/pinned-notes")
async def get_pinned_notes():
    """Return pinned notes list."""
    return {"pinned": config.pinned_notes}


@router.put("/pinned-notes")
async def save_pinned_notes(body: PinnedNotesRequest):
    """Save pinned notes list."""
    config.save_pinned_notes(body.pinned)
    return {"pinned": config.pinned_notes}


def _parse_week_header_refs(offset: int = 0) -> dict:
    """Parse group→wiki link references from the week header in Plan Week.md.

    Format: "igrant: [[iGrant calls]]"
    """
    import re
    from backend.routers.plan import _find_archived_week, _next_week_file, _week_info_for_offset

    if offset == 0:
        plan_file = config.vault_path / config.plan_week_file
    elif offset > 0:
        year, week = _week_info_for_offset(offset)
        plan_file = _next_week_file(year, week)
    else:
        year, week = _week_info_for_offset(offset)
        found = _find_archived_week(year, week)
        plan_file = found if found else None

    if not plan_file or not plan_file.exists():
        return {}

    refs = {}
    wiki_re = re.compile(r"^(\w+):\s*\[\[(.+?)\]\]")

    try:
        content = plan_file.read_text(encoding="utf-8")
    except OSError:
        return {}

    for line in content.split("\n"):
        stripped = line.strip()
        # Stop at first day heading
        if stripped.startswith("#") and any(
            d in stripped.lower()
            for d in ["monday", "mon", "tuesday", "tue", "wednesday", "wed",
                      "thursday", "thu", "friday", "fri", "saturday", "sat", "sunday", "sun"]
        ):
            break
        m = wiki_re.match(stripped)
        if m:
            refs[m.group(1)] = m.group(2)

    return refs
