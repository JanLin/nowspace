"""Notes endpoints: read/write/append vault markdown files."""

import re
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.config import config
from backend import vault_io
from backend.vault_index import refresh_index

router = APIRouter(prefix="/api/notes", tags=["notes"])


class WriteRequest(BaseModel):
    path: str  # relative path from vault root
    content: str


class AppendRequest(BaseModel):
    path: str  # relative path from vault root
    content: str


class LogRequest(BaseModel):
    path: str  # relative path from vault root
    text: str  # what was written in the day's scratchpad
    stamp: str  # the dated heading this entry gets, e.g. "2026-11-11 14:05"


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

    # No default: a note that cannot be read must not open as an empty editor
    # the user then saves back over it. vault_io retries first — on a synced
    # vault an unreadable file is usually one mid-copy.
    content = vault_io.read_text(full)

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

    vault_io.write_text_guarded(full, req.content)

    modified = datetime.fromtimestamp(full.stat().st_mtime).isoformat()
    return {"success": True, "modified": modified, "path": req.path}


@router.post("/append")
async def append_note(req: AppendRequest):
    """Append content to an existing vault file. Creates file if it doesn't exist."""
    full = _resolve_path(req.path)

    full.parent.mkdir(parents=True, exist_ok=True)

    existing = vault_io.read_text(full, default="")

    # Ensure newline separation
    separator = "\n" if existing and not existing.endswith("\n") else ""
    new_content = existing + separator + req.content

    vault_io.write_text_guarded(full, new_content)

    modified = datetime.fromtimestamp(full.stat().st_mtime).isoformat()
    return {"success": True, "modified": modified, "path": req.path}


#: A dated entry heading, ours or one written by hand: "## 2026-11-11",
#: "#### 2026-11-11 14:05". Finding the first one is how an entry knows
#: where the log starts — and at which heading level it is kept.
DATED_HEADING_RE = re.compile(r"^(#{1,6})\s+\d{4}-\d{2}-\d{2}\b")


def _body_start(lines: list[str]) -> int:
    """The first line that belongs to the note rather than to its masthead.

    Frontmatter and the H1 title are the note saying what it is, and an
    entry never goes above them. The title especially: a call note is
    often *called* a date — "# 2026-07-29 call" — and reading that as the
    log's first entry is how an entry ended up stacked on top of the
    title, outside the note it was filed into.
    """
    i = 0
    if lines and lines[0].strip() == "---":
        for j in range(1, len(lines)):
            if lines[j].strip() == "---":
                i = j + 1
                break
    while i < len(lines) and not lines[i].strip():
        i += 1
    if i < len(lines) and re.match(r"^#\s+\S", lines[i]):
        i += 1
    return i


def _insert_log_entry(existing: str, text: str, stamp: str) -> str:
    """Put a new dated entry at the top of the note's log.

    Newest first, which is what a customer note wants: the call you just
    had is the one you read. The top of the log means directly under the
    note's title — and when the note already keeps dated entries, directly
    above the newest of them, at whatever heading level they use. A note
    that opens with an action point list and then its entries therefore
    keeps that list where it is.
    """
    lines = existing.split("\n")
    at = _body_start(lines)
    level = "##"
    for j in range(at, len(lines)):
        m = DATED_HEADING_RE.match(lines[j].strip())
        if m:
            at, level = j, m.group(1)
            break

    entry = f"{level} {stamp}\n\n{text.strip()}"
    head = "\n".join(lines[:at]).rstrip("\n")
    tail = "\n".join(lines[at:]).strip("\n")
    out = (head + "\n\n" if head else "") + entry
    return out + ("\n\n" + tail + "\n" if tail else "\n")


@router.post("/log")
async def log_to_note(req: LogRequest):
    """File a piece of the day's scratchpad into a vault note as a dated entry.

    The text came out of a notepad mid-call, so it is written back verbatim
    under its own heading — nothing reformatted, nothing dropped.
    """
    full = _resolve_path(req.path)
    full.parent.mkdir(parents=True, exist_ok=True)

    existing = vault_io.read_text(full, default="")
    before = full.stat().st_mtime if full.exists() else None

    vault_io.write_text_guarded(
        full, _insert_log_entry(existing, req.text, req.stamp), before, what="Note"
    )

    refresh_index()
    return {
        "success": True,
        "path": req.path,
        "stamp": req.stamp,
        "modified": datetime.fromtimestamp(full.stat().st_mtime).isoformat(),
    }


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

    vault_io.write_text_guarded(file_path, content)

    # Keep the vault index current so the new note resolves immediately when its
    # [[link]] is clicked (Obsidian keeps its index live; we were only rebuilding
    # lazily, so freshly created notes weren't findable).
    refresh_index()

    modified = datetime.fromtimestamp(file_path.stat().st_mtime).isoformat()
    return {"success": True, "modified": modified, "path": rel_path}
