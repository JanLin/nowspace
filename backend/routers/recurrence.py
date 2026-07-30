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
from datetime import date, timedelta
from typing import List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict

from backend import recurrence as rec
from backend.config import config
from backend.routers.habits import (
    HabitDef,
    _format_habits_file,
    _habits_path,
    _parse_habits_file,
    note_error,
)

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
        # A lapsed template with a live accepted instance already has its
        # copy in flight — the review has nothing to ask about it.
        "lapsed_ids": [
            t.id for t in templates
            if rec.lapsed(t, today) and not rec.has_live_instance(t.id)
        ],
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


class TemplateActionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    domain: str = "body"  # demote only: habit domain to file it under


def _load_or_404(template_id: str):
    templates = rec.load_templates()
    for t in templates:
        if t.id == template_id:
            return templates, t
    raise HTTPException(status_code=404, detail="No such template")


@router.post("/accept")
async def accept_lapsed(req: TemplateActionRequest):
    """Weekly review accepted a lapsed interval template: create one ready
    instance whose first action is the template's coordination step.
    Idempotent — an existing live copy means nothing to do."""
    templates, t = _load_or_404(req.id)
    if not rec.is_interval(t):
        raise HTTPException(status_code=400, detail="Only interval templates go through accept — calendar templates spawn on their date")
    if t.state != "active":
        raise HTTPException(status_code=400, detail=f"Template is {t.state}")
    if rec.has_live_instance(t.id):
        return {"status": "exists"}
    from backend.routers.plan import _bucket_path, _format_bucket_tasks, _parse_bucket_file
    bucket = _bucket_path()
    tasks, pinned = ([], [])
    if bucket.exists():
        tasks, pinned = _parse_bucket_file(bucket.read_text(encoding="utf-8"))
    tasks.append(rec.build_instance_task(t, date.today().isoformat(), with_due=False))
    bucket.parent.mkdir(parents=True, exist_ok=True)
    bucket.write_text(_format_bucket_tasks(tasks, pinned), encoding="utf-8")
    if t.deferred:
        t.deferred = ""
        rec.save_templates(templates)
    return {"status": "created"}


@router.post("/defer")
async def defer_lapsed(req: TemplateActionRequest):
    """Declined in the review: wait for the next one. The miss lands on the
    template — where it accuses the schedule, never the person."""
    templates, t = _load_or_404(req.id)
    today = date.today()
    t.missed += 1
    t.deferred = (today + timedelta(days=(7 - today.weekday()) % 7 or 7)).isoformat()
    rec.save_templates(templates)
    return {"status": "deferred", "until": t.deferred}


@router.post("/demote")
async def demote_to_habit(req: TemplateActionRequest):
    """The template question's honest exit: not a task at all. A migration —
    retire the template, create a habit carrying the note link and a weekly
    target — never a live link between a task and a habit."""
    templates, t = _load_or_404(req.id)
    parsed = rec.parse_repeat(t.repeat)
    # Day steering doesn't exist on habits (weekly flexible targets are the
    # point there), so the schedule maps to a weekly count.
    target = len(parsed["weekdays"]) if parsed and parsed["kind"] == "weekly" else 1
    domain = req.domain.strip().lower() or "body"
    path = _habits_path()
    habits = [HabitDef(**h) for h in _parse_habits_file(path.read_text(encoding="utf-8"))] if path.exists() else []
    name = t.title.strip().lower()
    if not any(h.name == name for h in habits):
        habits.append(HabitDef(name=name, domain=domain, target=target, note=t.note.strip()))
        path.write_text(_format_habits_file(habits), encoding="utf-8")
    t.state = "retired"
    rec.save_templates(templates)
    return {"status": "demoted", "habit": name, "target": target}
