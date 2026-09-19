"""Habits: gentle recurring practices tracked via ordinary Habit: tasks.

Definitions live in a user-editable vault file (Habits.md) next to the week
plan. Completions are plain checked tasks in the day ("- [x] Habit: weights"),
so history is durable for free via the weekly archive. This router only
parses definitions and computes progress — it never writes into week files.
"""

import re
from datetime import date, timedelta
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
# Pauses: "paused 2026-09-19" is open (paused since then); a finished one is
# "paused 2026-09-01..2026-09-14" — paused on the 1st, started again on the
# 14th. A bare "paused" is open with no known date. Colon- and comma-free.
PAUSE_RE = re.compile(
    r"^paused(?:\s+(\d{4}-\d{2}-\d{2})(?:\s*\.\.\s*(\d{4}-\d{2}-\d{2}))?)?$", re.IGNORECASE
)


def _iso_date(value: str) -> Optional[date]:
    """A real calendar date in YYYY-MM-DD, or None."""
    try:
        return date.fromisoformat(value) if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value) else None
    except ValueError:
        return None

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
HISTORY_WEEKS = 12  # a quarter: long enough for the row's graph to show a trend


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
        habit = _parse_line(line, domain)
        if habit:
            habits.append(habit)
    return habits


def _parse_line(line: str, domain: str = "") -> Optional[dict]:
    """One "- name (variants): target, tokens" line → a definition, or None."""
    stripped = line.strip()
    if not stripped.startswith("-"):
        return None
    body = stripped.lstrip("-").strip()
    # Name may contain colons ("sleep before 23:00") — split at the LAST colon
    if ":" not in body:
        return None
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
        return None
    morning = False
    # Paused: kept with its history, but off the strip and out of the
    # week's count. Old backends ignore the token on read.
    paused = False
    paused_since = ""  # ISO date the open pause began; "" = not paused or unknown
    pauses: list[dict] = []  # finished pauses: {"start", "end"}, end = day it started again
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
        elif PAUSE_RE.match(token):
            pm = PAUSE_RE.match(token)
            start = pm.group(1) and _iso_date(pm.group(1))
            if pm.group(2):
                end = _iso_date(pm.group(2))
                if start and end and start <= end:
                    pauses.append({"start": start.isoformat(), "end": end.isoformat()})
            else:
                paused, paused_since = True, start.isoformat() if start else ""
        elif FREQ_RE.match(token):
            target, period = int(FREQ_RE.match(token).group(1)), "week"
        elif DUR_RE.match(token):
            dm = DUR_RE.match(token)
            duration = (int(dm.group(1)) * 60 + int(dm.group(2) or 0)) if dm.group(1) else int(dm.group(3))
    if target is None:
        return None  # unparseable target — skip rather than guess
    return {
        "name": name.lower(), "domain": domain or "body",
        "variants": variants, "target": target, "period": period,
        "morning": morning, "duration": duration, "note": note,
        "paused": paused, "paused_since": paused_since,
        "pauses": sorted(pauses, key=lambda x: x["start"]),
    }


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


def _paused_during(habit: dict, monday: date) -> bool:
    """Whether any pause overlapped the Monday–Sunday week from `monday`."""
    sunday = monday + timedelta(days=6)
    for p in habit["pauses"]:
        # The end is the day it started again: paused through the day before
        if date.fromisoformat(p["start"]) <= sunday and date.fromisoformat(p["end"]) > monday:
            return True
    since = habit["paused_since"]
    return bool(habit["paused"] and since and date.fromisoformat(since) <= sunday)


def _is_established(met: list[bool], paused: list[bool]) -> bool:
    """The last ESTABLISHED_WEEKS weeks you were doing it were all met.

    Paused weeks are skipped, not failed — a pause is a choice of focus, so
    resuming picks up where the habit left off.
    """
    active = [m for m, p in zip(met, paused) if not p][-ESTABLISHED_WEEKS:]
    return len(active) == ESTABLISHED_WEEKS and all(active)


def _week_goal(habit: dict) -> int:
    """The number a week has to reach to be met — the graph's goal line."""
    return DAILY_WEEK_MET if habit["period"] == "day" else habit["target"]


def _week_value(counts_per_day: list[int], habit: dict) -> int:
    """What a week's bar measures: days done for a daily habit, completions
    for a weekly one — never clamped, so 6 of a 5x/week shows as 6."""
    if habit["period"] == "day":
        return len([c for c in counts_per_day if c > 0])
    return sum(counts_per_day)


def _week_met(counts_per_day: list[int], habit: dict) -> bool:
    return _week_value(counts_per_day, habit) >= _week_goal(habit)


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
    history_paused: dict[str, list[bool]] = {h["name"]: [] for h in habits}
    history_counts: dict[str, list[int]] = {h["name"]: [] for h in habits}
    history_labels: list[str] = []
    for year, week, p in archived:
        history_labels.append(f"{year}-wk{week:02d}")
        counts = _habit_counts(_done_texts_by_day(p.read_text(encoding="utf-8"), p.name), habits)
        try:
            monday = date.fromisocalendar(year, week, 1)
        except ValueError:
            monday = None  # a misnamed archive file: no week to pause
        for h in habits:
            met = _week_met(counts[h["name"]], h)
            history_met[h["name"]].append(met)
            history_counts[h["name"]].append(_week_value(counts[h["name"]], h))
            # A week met anyway is met — celebrate it, pause or not
            history_paused[h["name"]].append(bool(monday) and not met and _paused_during(h, monday))
    # newest-first → oldest-first for display
    for name in history_met:
        history_met[name] = list(reversed(history_met[name]))
        history_paused[name] = list(reversed(history_paused[name]))
        history_counts[name] = list(reversed(history_counts[name]))
    history_labels.reverse()

    out = []
    for h in habits:
        per_day = week_counts[h["name"]]
        hist = history_met[h["name"]]
        hist_paused = history_paused[h["name"]]
        established = _is_established(hist, hist_paused)
        out.append({
            **h,
            "week_count": sum(per_day),
            "days_done": len([c for c in per_day if c > 0]),
            "today_count": per_day[today_idx] if 0 <= today_idx < len(per_day) else 0,
            "history": hist,
            "history_paused": hist_paused,
            "history_counts": history_counts[h["name"]],
            "history_labels": history_labels,  # "2026-wk37" per history entry
            "week_goal": _week_goal(h),
            "established": established,
        })
    return {"found": True, "habits": out}


STARTER_TEMPLATE = """# Habits

Targets are weekly and flexible — any variant counts, any day counts.
Edit freely: "- name (variant | variant): 3x/week[, morning]" or "- name: daily".
Link the note that explains how with ", [[Note name]]".
Pausing adds ", paused <date>"; starting again makes it ", paused <from>..<to>", so the history knows.

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


class PausePeriod(BaseModel):
    start: str  # ISO date paused
    end: str  # ISO date started again


class HabitDef(BaseModel):
    name: str
    domain: str = "body"
    variants: list[str] = []
    target: int = 1
    period: str = "week"  # "week" | "day"
    morning: bool = False
    duration: int = 0  # minutes per occurrence; 0 = untimed
    note: str = ""  # wikilink target of the how-to note ("" = none)
    paused: bool = False  # off the strip and out of the count, history kept
    paused_since: str = ""  # ISO date the open pause began ("" = set on save)
    pauses: list[PausePeriod] = []  # finished pauses, oldest first


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
        'Pausing adds ", paused <date>"; starting again makes it ", paused <from>..<to>", so the history knows.',
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
            for pp in h.pauses:
                target += f", paused {pp.start}..{pp.end}"
            if h.paused:
                target += f", paused {h.paused_since}" if h.paused_since else ", paused"
            lines.append(f"- {name}{variants}: {target}")
    lines.append("")
    return "\n".join(lines)


def _pause_error(h: HabitDef) -> Optional[str]:
    """Why this habit's pause dates can't be stored, or None."""
    if h.paused_since and not _iso_date(h.paused_since):
        return f'pause date "{h.paused_since}" isn\'t a YYYY-MM-DD date'
    for pp in h.pauses:
        start, end = _iso_date(pp.start), _iso_date(pp.end)
        if not start or not end:
            return f'pause "{pp.start}..{pp.end}" needs two YYYY-MM-DD dates'
        if start > end:
            return f'pause "{pp.start}..{pp.end}" ends before it starts'
    return None


def _settle_pause(h: HabitDef, today: str) -> None:
    """Date a pause or a start-again from the editor, like the toggle does."""
    if h.paused and not h.paused_since:
        h.paused_since = today
    elif not h.paused and h.paused_since:
        if h.paused_since < today:  # same-day pause and start leaves no trace
            h.pauses.append(PausePeriod(start=h.paused_since, end=today))
        h.paused_since = ""


def _apply_pause(tokens: list[str], paused: bool, today: str) -> list[str]:
    """A habit line's tokens after pausing or starting again on `today`.

    Pausing an already-paused habit keeps its original date. Starting again
    closes the open pause into "paused <from>..<today>"; finished pauses and
    every other token pass through untouched.
    """
    since: Optional[str] = None  # None = no open pause; "" = open, undated
    rest: list[str] = []
    for t in tokens:
        pm = PAUSE_RE.match(t)
        if pm and not pm.group(2):
            start = pm.group(1) and _iso_date(pm.group(1))
            since = start.isoformat() if start else ""
        else:
            rest.append(t)
    if paused:
        return rest + [f"paused {since or today}"]
    if since and since < today:
        rest.append(f"paused {since}..{today}")
    return rest


@router.post("/save")
async def save_habits(req: SaveHabitsRequest):
    """Persist habit definitions edited in the Habits tab."""
    errors = []
    for h in req.habits:
        if h.note.strip():
            err = note_error(h.note.strip())
            if err:
                errors.append(f"{h.name}: {err}")
        err = _pause_error(h)
        if err:
            errors.append(f"{h.name}: {err}")
    if errors:
        raise HTTPException(status_code=422, detail="; ".join(errors))
    today = date.today().isoformat()
    for h in req.habits:
        _settle_pause(h, today)
    _habits_path().write_text(_format_habits_file(req.habits), encoding="utf-8")
    return {"status": "saved", "count": len(req.habits)}


class PauseHabitRequest(BaseModel):
    name: str
    paused: bool


@router.post("/pause")
async def pause_habit(req: PauseHabitRequest):
    """Pause or resume one habit by editing only its own line.

    A one-tap toggle must not regenerate the file the way the editor's save
    does: comments, ordering and any token a newer instance wrote survive,
    and only the open pause token on the matching line changes (see
    _apply_pause for how the dates move).
    """
    path = _habits_path()
    if not path.exists():
        raise HTTPException(status_code=404, detail="No habits file")
    wanted = req.name.strip().lower()
    today = date.today().isoformat()
    lines = path.read_text(encoding="utf-8").split("\n")
    hit = False
    for i, line in enumerate(lines):
        parsed = _parse_line(line)
        if not parsed or parsed["name"] != wanted:
            continue
        head, tail = line.rsplit(":", 1)
        tokens = [t.strip() for t in tail.split(",") if t.strip()]
        lines[i] = f"{head}: {', '.join(_apply_pause(tokens, req.paused, today))}"
        hit = True
    if not hit:
        raise HTTPException(status_code=404, detail=f'No habit named "{req.name}"')
    path.write_text("\n".join(lines), encoding="utf-8")
    return {"status": "paused" if req.paused else "resumed"}


@router.post("/init")
async def init_habits():
    """Create a starter Habits.md (no-op if it already exists)."""
    path = _habits_path()
    if path.exists():
        return {"status": "exists"}
    path.write_text(STARTER_TEMPLATE, encoding="utf-8")
    return {"status": "created"}
