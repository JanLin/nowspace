"""Habits: gentle recurring practices tracked via ordinary Habit: tasks.

Definitions live in a user-editable vault file (Habits.md) next to the week
plan. Completions are plain checked tasks in the day ("- [x] Habit: weights"),
so history is durable for free via the weekly archive. This router only
parses definitions and computes progress — it never writes into week files.
"""

import re
from datetime import date
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend import vault_index
from backend.agents.obsidian_reader import parse_week_plan
from backend.config import config
from backend.routers.plan import _list_archived_week_files

router = APIRouter(prefix="/plan/habits", tags=["habits"])

# Target segment: comma-separated tokens after the last colon —
# "3x/week", "daily", "morning", an optional duration "30min" / "2h" / "1h30",
# and an optional bare wikilink "[[Note name]]" pointing at the note that
# explains how (reference material only — never a work item).
FREQ_RE = re.compile(r"^(\d+)\s*x\s*/\s*week$", re.IGNORECASE)
DUR_RE = re.compile(r"^(?:(\d+)\s*h(?:ours?)?\s*(\d+)?|(\d+)\s*m(?:in(?:utes)?)?)$", re.IGNORECASE)
NOTE_RE = re.compile(r"^\[\[([^\]]+)\]\]$")

# App-managed file families a habit note must never point at: linking a work
# item would hand the habit completion semantics through the back door.
_WORK_ITEM_STEM_RE = re.compile(r"^(plan week|time log)\b", re.IGNORECASE)


def note_name(note: str) -> str:
    """Display/resolution name of a note link: strip |alias and #heading."""
    return note.split("|")[0].split("#")[0].strip()


def note_error(note: str) -> Optional[str]:
    """Why this note value can't be stored, or None if it's fine."""
    if "," in note or ":" in note:
        # A comma splits the target segment; a colon trips the last-colon
        # name/target split. Both would corrupt the line on re-read.
        return f'note "{note}" can\'t contain "," or ":"'
    name = note_name(note)
    if not name:
        return "note link is empty"
    if _WORK_ITEM_STEM_RE.match(name):
        return f'"{name}" is a work-item file — habit notes link reference notes only'
    resolved = vault_index.resolve_name(name)
    if resolved and _WORK_ITEM_STEM_RE.match(Path(resolved).stem):
        return f'"{name}" resolves to a work-item file — habit notes link reference notes only'
    return None

# A daily habit counts as a met week at 5+ days — gentle, not perfectionist
DAILY_WEEK_MET = 5
ESTABLISHED_WEEKS = 4
HISTORY_WEEKS = 8


def _habits_path() -> Path:
    """Habits live in the Plan Week file family (Plan Week Habits.md).

    Migrates a pre-rename Habits.md transparently the first time it's seen.
    """
    path = config.vault_path / config.plan_week_habits_file
    legacy = config.vault_path / "Habits.md"
    if not path.exists() and legacy.exists():
        legacy.rename(path)
    return path

def _parse_habits_file(content: str) -> list[dict]:
    """Parse Habits.md → habit definitions."""
    habits: list[dict] = []
    domain = ""
    for line in content.split("\n"):
        stripped = line.strip()
        if stripped.startswith("##"):
            domain = stripped.lstrip("#").strip().lower()
            continue
        if not stripped.startswith("-"):
            continue
        body = stripped.lstrip("-").strip()
        # Name may contain colons ("sleep before 23:00") — split at the LAST colon
        if ":" not in body:
            continue
        name_part, target_part = body.rsplit(":", 1)
        target_part = target_part.strip()
        # Variants in parentheses: "exercise (kayak | bike | run | weights)"
        variants: list[str] = []
        vm = re.search(r"\((.*?)\)\s*$", name_part)
        if vm:
            variants = [v.strip().lower() for v in vm.group(1).split("|") if v.strip()]
            name_part = name_part[: vm.start()].strip()
        name = name_part.strip()
        if not name:
            continue
        morning = False
        duration = 0  # minutes per occurrence; 0 = untimed
        note = ""  # wikilink target of the how-to note, original casing
        target, period = None, "week"
        # Keyword tokens match case-insensitively; the note link keeps its casing.
        for raw_token in (t.strip() for t in target_part.split(",")):
            if not raw_token:
                continue
            token = raw_token.lower()
            nm = NOTE_RE.match(raw_token)
            if nm:
                note = nm.group(1).strip()
            elif token == "daily":
                target, period = 7, "day"
            elif token == "morning":
                morning = True
            elif FREQ_RE.match(token):
                target, period = int(FREQ_RE.match(token).group(1)), "week"
            elif DUR_RE.match(token):
                dm = DUR_RE.match(token)
                duration = (int(dm.group(1)) * 60 + int(dm.group(2) or 0)) if dm.group(1) else int(dm.group(3))
        if target is None:
            continue  # unparseable target — skip rather than guess
        habits.append({
            "name": name.lower(), "domain": domain or "body",
            "variants": variants, "target": target, "period": period,
            "morning": morning, "duration": duration, "note": note,
        })
    return habits


def _habit_counts(week_tasks_by_day: list[list[str]], habits: list[dict]) -> dict:
    """Count Habit: completions per habit for one parsed week.

    week_tasks_by_day: for each day, the DONE task texts.
    Returns {habit_name: [count_per_day...]}.
    """
    counts = {h["name"]: [0] * len(week_tasks_by_day) for h in habits}
    for di, texts in enumerate(week_tasks_by_day):
        for text in texts:
            m = re.match(r"^\s*habits?\s*:\s*(.+)$", text.strip(), re.IGNORECASE)
            if not m:
                continue
            label = m.group(1).strip().lower()
            for h in habits:
                if label == h["name"] or label in h["variants"]:
                    counts[h["name"]][di] += 1
                    break
    return counts


def _done_texts_by_day(plan_content: str, filename: str) -> list[list[str]]:
    result = parse_week_plan(plan_content, filename)
    out: list[list[str]] = []
    for day_data in result.get("days", []):
        tasks = day_data.tasks if hasattr(day_data, "tasks") else day_data["tasks"]
        texts = []
        for t in tasks:
            done = t.done if hasattr(t, "done") else t.get("done", False)
            text = t.text if hasattr(t, "text") else t.get("text", "")
            if done:
                texts.append(text)
        out.append(texts)
    return out


def _week_met(counts_per_day: list[int], habit: dict) -> bool:
    total = sum(counts_per_day)
    if habit["period"] == "day":
        return len([c for c in counts_per_day if c > 0]) >= DAILY_WEEK_MET
    return total >= habit["target"]


@router.get("")
async def get_habits():
    """Habit definitions + progress (this week, today, 8-week history)."""
    path = _habits_path()
    if not path.exists():
        return {"found": False, "habits": []}
    habits = _parse_habits_file(path.read_text(encoding="utf-8"))
    if not habits:
        return {"found": True, "habits": []}

    # Current week counts
    plan_file = config.vault_path / config.plan_week_file
    week_counts = {h["name"]: [0] * 7 for h in habits}
    if plan_file.exists():
        week_counts = _habit_counts(
            _done_texts_by_day(plan_file.read_text(encoding="utf-8"), plan_file.name), habits
        )

    today_idx = date.today().isocalendar()[2] - 1  # Mon=0

    # History from the archive, newest first → take last HISTORY_WEEKS
    archived = _list_archived_week_files()[:HISTORY_WEEKS]
    history_met: dict[str, list[bool]] = {h["name"]: [] for h in habits}
    for _, _, p in archived:
        counts = _habit_counts(_done_texts_by_day(p.read_text(encoding="utf-8"), p.name), habits)
        for h in habits:
            history_met[h["name"]].append(_week_met(counts[h["name"]], h))
    # newest-first → oldest-first for display
    for name in history_met:
        history_met[name] = list(reversed(history_met[name]))

    out = []
    for h in habits:
        per_day = week_counts[h["name"]]
        hist = history_met[h["name"]]
        recent = hist[-ESTABLISHED_WEEKS:]
        established = len(recent) == ESTABLISHED_WEEKS and all(recent)
        out.append({
            **h,
            "week_count": sum(per_day),
            "days_done": len([c for c in per_day if c > 0]),
            "today_count": per_day[today_idx] if 0 <= today_idx < len(per_day) else 0,
            "history": hist,
            "established": established,
        })
    return {"found": True, "habits": out}


STARTER_TEMPLATE = """# Habits

Targets are weekly and flexible — any variant counts, any day counts.
Edit freely: "- name (variant | variant): 3x/week[, morning]" or "- name: daily".
Link the note that explains how with ", [[Note name]]".

## Body
- exercise (kayak | bike | run | weights): 3x/week, morning
- back & hip routine: 2x/week

## Mind
- course study: 2x/week

## Soul
- soul time (nature walk | music): 1x/week

## Sleep
- sleep before 23: daily
"""


class HabitDef(BaseModel):
    name: str
    domain: str = "body"
    variants: list[str] = []
    target: int = 1
    period: str = "week"  # "week" | "day"
    morning: bool = False
    duration: int = 0  # minutes per occurrence; 0 = untimed
    note: str = ""  # wikilink target of the how-to note ("" = none)


class SaveHabitsRequest(BaseModel):
    habits: list[HabitDef]


def _format_habits_file(habits: list[HabitDef]) -> str:
    """Serialize definitions to Plan Week Habits.md (edit-friendly format)."""
    lines = [
        "# Habits",
        "",
        "Targets are weekly and flexible — any variant counts, any day counts.",
        'Edit freely: "- name (variant | variant): 3x/week[, morning]" or "- name: daily".',
        'Link the note that explains how with ", [[Note name]]".',
    ]
    by_domain: dict[str, list[HabitDef]] = {}
    for h in habits:
        by_domain.setdefault(h.domain.strip().lower() or "body", []).append(h)
    order = ["body", "mind", "soul", "sleep"]
    domains = [d for d in order if d in by_domain] + sorted(d for d in by_domain if d not in order)
    for d in domains:
        lines += ["", f"## {d.capitalize()}"]
        for h in by_domain[d]:
            name = h.name.strip().lower()
            if not name:
                continue
            variants = f" ({' | '.join(v.strip().lower() for v in h.variants if v.strip())})" if any(v.strip() for v in h.variants) else ""
            target = "daily" if h.period == "day" else f"{max(1, h.target)}x/week"
            if h.morning:
                target += ", morning"
            if h.duration > 0:
                target += f", {h.duration // 60}h{h.duration % 60 or ''}" if h.duration >= 60 else f", {h.duration}min"
            if h.note.strip():
                target += f", [[{h.note.strip()}]]"
            lines.append(f"- {name}{variants}: {target}")
    lines.append("")
    return "\n".join(lines)


@router.post("/save")
async def save_habits(req: SaveHabitsRequest):
    """Persist habit definitions edited in the Habits tab."""
    errors = []
    for h in req.habits:
        if h.note.strip():
            err = note_error(h.note.strip())
            if err:
                errors.append(f"{h.name}: {err}")
    if errors:
        raise HTTPException(status_code=422, detail="; ".join(errors))
    _habits_path().write_text(_format_habits_file(req.habits), encoding="utf-8")
    return {"status": "saved", "count": len(req.habits)}


@router.post("/init")
async def init_habits():
    """Create a starter Habits.md (no-op if it already exists)."""
    path = _habits_path()
    if path.exists():
        return {"status": "exists"}
    path.write_text(STARTER_TEMPLATE, encoding="utf-8")
    return {"status": "created"}
