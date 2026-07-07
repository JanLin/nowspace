"""Habits: gentle recurring practices tracked via ordinary Habit: tasks.

Definitions live in a user-editable vault file (Habits.md) next to the week
plan. Completions are plain checked tasks in the day ("- [x] Habit: weights"),
so history is durable for free via the weekly archive. This router only
parses definitions and computes progress — it never writes into week files.
"""

import re
from datetime import date
from pathlib import Path

from fastapi import APIRouter

from backend.agents.obsidian_reader import parse_week_plan
from backend.config import config
from backend.routers.plan import _list_archived_week_files

router = APIRouter(prefix="/plan/habits", tags=["habits"])

HABITS_FILE = "Habits.md"

# "- name (variant | variant): 3x/week, morning"  /  "- name: daily"
TARGET_RE = re.compile(r"^\s*(\d+)\s*x\s*/\s*week\s*(,\s*morning)?\s*$", re.IGNORECASE)

# A daily habit counts as a met week at 5+ days — gentle, not perfectionist
DAILY_WEEK_MET = 5
ESTABLISHED_WEEKS = 4
HISTORY_WEEKS = 8


def _habits_path() -> Path:
    return config.vault_path / HABITS_FILE

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
        target_part = target_part.strip().lower()
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
        if target_part == "daily":
            target, period = 7, "day"
        else:
            tm = TARGET_RE.match(target_part)
            if not tm:
                continue  # unparseable target — skip rather than guess
            target, period = int(tm.group(1)), "week"
            morning = bool(tm.group(2))
        habits.append({
            "name": name.lower(), "domain": domain or "body",
            "variants": variants, "target": target, "period": period,
            "morning": morning,
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


@router.post("/init")
async def init_habits():
    """Create a starter Habits.md (no-op if it already exists)."""
    path = _habits_path()
    if path.exists():
        return {"status": "exists"}
    path.write_text(STARTER_TEMPLATE, encoding="utf-8")
    return {"status": "created"}
