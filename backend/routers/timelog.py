"""Time tracking: one running entry, month-scoped markdown logs.

Entries live in "Time Log - YYYY-MM.md" next to the Plan Week family:

    # Time Log 2026-07

    ## 2026-07-08
    - 09:12–10:05 Arratech: standup notes
    - 13:00– wallet/expert: letter draft      ← no end time = running

The company prefix is the task group; an optional /subproject refines it.
Sums, filters and invoicing are computed client-side from this log —
the backend only guarantees the single-running-entry invariant.
"""

import re
from datetime import date, datetime
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.config import config

router = APIRouter(prefix="/time", tags=["time"])

DAY_RE = re.compile(r"^##\s*(\d{4}-\d{2}-\d{2})\s*$")
ENTRY_RE = re.compile(r"^-\s*(\d{1,2}:\d{2})\s*[–-]\s*(\d{1,2}:\d{2})?\s*(.*)$")


def _norm_time(raw: str) -> str:
    """Normalize flexible time input to HH:MM — colon optional.

    Accepts "19:45", "9:45", "1945", "945". Raises on anything else so a
    typo becomes a visible error instead of a silently corrupted log line.
    """
    s = (raw or "").strip().replace(".", ":")
    m = re.match(r"^(\d{1,2}):(\d{2})$", s) or re.match(r"^(\d{1,2})(\d{2})$", s)
    if not m:
        raise HTTPException(status_code=400, detail=f"Time must be HH:MM or HHMM, got '{raw}'")
    h, mnt = int(m.group(1)), int(m.group(2))
    if h > 23 or mnt > 59:
        raise HTTPException(status_code=400, detail=f"Invalid time '{raw}'")
    return f"{h:02d}:{mnt:02d}"


def _month_path(month: str) -> Path:
    return config.vault_path / f"Time Log - {month}.md"


def _current_month() -> str:
    return date.today().strftime("%Y-%m")


def _parse_log(content: str) -> list[dict]:
    entries: list[dict] = []
    day = ""
    for line in content.split("\n"):
        dm = DAY_RE.match(line.strip())
        if dm:
            day = dm.group(1)
            continue
        em = ENTRY_RE.match(line.strip())
        if em and day and em.group(3).strip():
            entries.append({
                "date": day,
                "start": em.group(1).zfill(5),
                "end": em.group(2).zfill(5) if em.group(2) else None,
                "text": em.group(3).strip(),
            })
    return entries


def _minutes(start: str, end: str) -> int:
    sh, sm = map(int, start.split(":"))
    eh, em = map(int, end.split(":"))
    return max(0, (eh * 60 + em) - (sh * 60 + sm))


def _with_minutes(e: dict) -> dict:
    end = e["end"] or datetime.now().strftime("%H:%M")
    return {**e, "minutes": _minutes(e["start"], end)}


def _format_log(month: str, entries: list[dict]) -> str:
    lines = [f"# Time Log {month}", ""]
    by_day: dict[str, list[dict]] = {}
    for e in entries:
        by_day.setdefault(e["date"], []).append(e)
    for day in sorted(by_day):
        lines.append(f"## {day}")
        for e in sorted(by_day[day], key=lambda x: x["start"]):
            end = e["end"] or ""
            lines.append(f"- {e['start']}–{end} {e['text']}".rstrip())
        lines.append("")
    return "\n".join(lines)


def _load(month: str) -> list[dict]:
    p = _month_path(month)
    return _parse_log(p.read_text(encoding="utf-8")) if p.exists() else []


def _save(month: str, entries: list[dict]) -> None:
    _month_path(month).write_text(_format_log(month, entries), encoding="utf-8")


def _find_running(entries: list[dict]) -> Optional[dict]:
    for e in entries:
        if e["end"] is None:
            return e
    return None


def _close_running(entries: list[dict], at: Optional[str] = None) -> bool:
    at = at or datetime.now().strftime("%H:%M")
    running = _find_running(entries)
    if not running:
        return False
    # An entry left running from a previous day closes at its start (zero
    # duration is honest — we don't know when it really ended).
    today = date.today().isoformat()
    running["end"] = at if running["date"] == today else running["start"]
    return True


class StartRequest(BaseModel):
    text: str


class AdjustRequest(BaseModel):
    start: Optional[str] = None  # HH:MM
    text: Optional[str] = None   # new description for the running entry


class EntryRequest(BaseModel):
    date: str      # YYYY-MM-DD
    start: str
    end: Optional[str] = None
    text: str


class UpdateRequest(BaseModel):
    date: str
    index: int     # index within that date's entries (sorted by start)
    start: str
    end: Optional[str] = None
    text: str
    delete: bool = False


@router.get("/log")
async def get_log(month: Optional[str] = None):
    month = month or _current_month()
    entries = [_with_minutes(e) for e in _load(month)]
    running = _find_running(entries) if month == _current_month() else None
    return {"month": month, "entries": entries, "running": running}


@router.post("/start")
async def start(req: StartRequest):
    """Start tracking; any running entry is closed first (single timer)."""
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Entry text required")
    month = _current_month()
    entries = _load(month)
    _close_running(entries)
    entries.append({
        "date": date.today().isoformat(),
        "start": datetime.now().strftime("%H:%M"),
        "end": None,
        "text": text,
    })
    _save(month, entries)
    return {"status": "started", "running": _with_minutes(entries[-1])}


@router.post("/stop")
async def stop():
    month = _current_month()
    entries = _load(month)
    if not _close_running(entries):
        return {"status": "idle"}
    _save(month, entries)
    return {"status": "stopped"}


@router.post("/adjust")
async def adjust(req: AdjustRequest):
    """Fix the running entry's start time and/or description."""
    new_text = (req.text or "").strip()
    if not req.start and not new_text:
        raise HTTPException(status_code=400, detail="Nothing to adjust")
    month = _current_month()
    entries = _load(month)
    running = _find_running(entries)
    if not running:
        raise HTTPException(status_code=404, detail="No running entry")
    if req.start:
        running["start"] = _norm_time(req.start)
    if new_text:
        running["text"] = new_text
    _save(month, entries)
    return {"status": "adjusted", "running": _with_minutes(running)}


@router.post("/add")
async def add(req: EntryRequest):
    """Manually add a completed entry (fully missed session)."""
    month = req.date[:7]
    entries = _load(month)
    entries.append({"date": req.date, "start": _norm_time(req.start),
                    "end": _norm_time(req.end) if req.end else None, "text": req.text.strip()})
    _save(month, entries)
    return {"status": "added"}


@router.post("/update")
async def update(req: UpdateRequest):
    """Edit or delete an entry, addressed by (date, index within day)."""
    month = req.date[:7]
    entries = _load(month)
    day_entries = sorted([e for e in entries if e["date"] == req.date], key=lambda x: x["start"])
    if req.index < 0 or req.index >= len(day_entries):
        raise HTTPException(status_code=404, detail="Entry not found")
    target = day_entries[req.index]
    entries.remove(target)
    if not req.delete:
        entries.append({"date": req.date, "start": _norm_time(req.start),
                        "end": _norm_time(req.end) if req.end else None, "text": req.text.strip()})
    _save(month, entries)
    return {"status": "deleted" if req.delete else "updated"}
