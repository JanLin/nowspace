"""Vault endpoints: file index, search, linked document discovery."""

from typing import Optional

from fastapi import APIRouter, HTTPException

from backend.config import config
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


@router.get("/linked-docs")
async def vault_linked_docs(group: str, week_offset: int = 0):
    """Resolve a group name to its project folder and discover linked documents.

    Resolution order:
    1. Week header references (e.g., "igrant: [[iGrant calls]]")
    2. Plan Week Configuration.md reference_links
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
