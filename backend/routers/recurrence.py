"""Recurring template routes: list, save (with the creation gate), accept.

The gate mirrors binding → ready because a template IS a standing binding
decision: size (s/m/l) is required on every template — that is the ready
gate — and a next action is required on interval templates only, where the
coordination step ("propose a date to X") is the instance's real content
(calendar templates are their own next action; Jan's GTD call, 2026-07-27).
A template that can't meet the gate is an unbound topic and goes through
the funnel, not around it.
"""

import secrets
from datetime import date
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict

from backend import recurrence as rec
from backend.config import config
from backend.routers.habits import note_error

router = APIRouter(prefix="/plan/recurrence", tags=["recurrence"])


class RecurrenceSaveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    templates: List[rec.RecurrenceTemplate] = []
    expected_mtime: Optional[float] = None  # sync guard, same as bucket saves


def _template_errors(t: rec.RecurrenceTemplate) -> List[str]:
    errors: List[str] = []
    label = t.title.strip() or "(untitled)"
    if not t.title.strip():
        errors.append("a template needs a title")
    parsed = rec.parse_repeat(t.repeat)
    if parsed is None:
        errors.append(
            f"“{label}”: repeat must be “monthly on 25”, “weekly on mon” or “every 6w”"
        )
    if t.size not in ("s", "m", "l"):
        errors.append(f"“{label}”: a template needs a size (s/m/l) — that is the ready gate")
    if parsed and parsed["kind"] == "interval" and not t.next_action.strip():
        errors.append(
            f"“{label}”: an interval template needs its coordination step "
            "(e.g. “propose a date to X”) — that is what each instance is born with"
        )
    if t.state not in rec.TEMPLATE_STATES:
        errors.append(f"“{label}”: unknown state '{t.state}'")
    if t.note.strip():
        err = note_error(t.note.strip())
        if err:
            errors.append(f"“{label}”: {err}")
    return errors


@router.get("")
async def get_recurrence():
    """Templates + derived review state (lapsed / over the miss threshold)."""
    path = rec.recurring_path()
    templates = rec.load_templates()
    today = date.today()
    return {
        "found": path.exists(),
        "templates": [t.model_dump() for t in templates],
        "lapsed_ids": [t.id for t in templates if rec.lapsed(t, today)],
        "threshold_ids": [
            t.id for t in templates
            if t.state == "active" and t.missed >= rec.MISS_THRESHOLD
        ],
        "mtime": path.stat().st_mtime if path.exists() else None,
    }


@router.post("/save")
async def save_recurrence(req: RecurrenceSaveRequest):
    """Persist the full template list. The creation gate refuses — never
    warns — and reports every failure, not the first."""
    path = rec.recurring_path()
    if req.expected_mtime is not None and path.exists():
        if path.stat().st_mtime > req.expected_mtime + 0.01:
            raise HTTPException(
                status_code=409,
                detail="Recurring file changed on disk since it was loaded — reload before saving",
            )
    errors: List[str] = []
    seen_ids: set = set()
    for t in req.templates:
        errors.extend(_template_errors(t))
        if t.id and t.id in seen_ids:
            errors.append(f"“{t.title.strip() or t.id}”: duplicate template id")
        if t.id:
            seen_ids.add(t.id)
    if errors:
        raise HTTPException(status_code=422, detail="; ".join(errors))
    today_iso = date.today().isoformat()
    for t in req.templates:
        if not t.id:
            t.id = secrets.token_hex(3)
        if not t.created:
            t.created = today_iso
    rec.save_templates(req.templates)
    return {
        "status": "saved",
        "count": len(req.templates),
        "mtime": path.stat().st_mtime,
    }
