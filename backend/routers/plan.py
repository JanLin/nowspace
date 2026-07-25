"""Plan endpoints: generate and approve daily plan."""

import re
import shutil
from datetime import date, timedelta
from typing import Optional
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.agents.obsidian_reader import scan_vault, scan_vault_with_carryover, scan_goals, get_day_type, parse_week_plan
from backend.agents.prioritiser import prioritise_tasks
from backend.config import config
from backend.models import (
    ApproveRequest, PlanResponse, Task, WeekPlanResponse, SaveWeekRequest,
    BucketResponse, BucketSaveRequest, BucketMoveRequest, BucketTask,
)
from backend.session import create_session, get_session
from backend.utils.memory_manager import read_memory, append_weekly_log


def _current_week_info() -> tuple[int, int]:
    """Return (iso_year, iso_week) for today."""
    today = date.today()
    iso = today.isocalendar()
    return iso[0], iso[1]


def _week_info_for_offset(offset: int) -> tuple[int, int]:
    """Return (iso_year, iso_week) for a week offset from current."""
    today = date.today()
    target = today + timedelta(weeks=offset)
    iso = target.isocalendar()
    return iso[0], iso[1]


def _vault_root() -> Path:
    """Return vault root (parent of 0-Inbox if vault_path points to inbox)."""
    vp = config.vault_path
    if vp.name == "0-Inbox":
        return vp.parent
    return vp


def _archive_path() -> Path:
    """Return the archive folder path: vaultRoot/4-Archive/a0-Inbox."""
    return _vault_root() / "4-Archive" / "a0-Inbox"


# Inline group teaching: "wallet@w: task" assigns group wallet → the context
# behind tag w, persists the mapping to config.yaml, and the tag is cleaned
# from the text. Any single letter works; unknown letters auto-create a new
# context named after the letter (rename it in Settings).
GROUP_CTX_TAG_RE = re.compile(r"^([^:@\[\]]{2,29}?)@([a-z])(\s*:)", re.IGNORECASE)
# Trailing per-task tags: "task text @f" — learned (auto-created) but never cleaned
TASK_CTX_TAG_RE = re.compile(r"\s@([a-z])\b(?!\w)", re.IGNORECASE)


# Bucket metadata tokens (tilde family, hidden from UI labels):
#   ~w2628 = entered the bucket in ISO week 28 of 2026 (YYWW) — age hint
#   ~m     = "this month" GTD horizon on the bucket board
BUCKET_META_RE = re.compile(r"\s*~(w\d{4}|m)\b", re.IGNORECASE)


def _strip_bucket_meta(text: str) -> str:
    return BUCKET_META_RE.sub("", text or "").strip()


def _stamp_bucket_week(text: str) -> str:
    """Append the entered-week stamp if the task doesn't have one yet."""
    if re.search(r"~w\d{4}\b", text or "", re.IGNORECASE):
        return text
    iso = date.today().isocalendar()
    return f"{(text or '').rstrip()} ~w{iso[0] % 100:02d}{iso[1]:02d}"


def _context_for_tag(tag: str) -> str:
    """Resolve a tag letter to its context name, auto-creating unknown tags."""
    tag = tag.lower()
    config.ensure_context_tag(tag)
    return config.context_tags.get(tag, tag)


def _learn_and_clean_group_tag(text: str) -> str:
    """Learn context mappings from a task line.

    - Leading group tag ("wallet@w: task"): assign the group, clean the tag.
    - Trailing task tags ("task @f"): auto-create unknown tags, keep the tag.
    """
    for tm in TASK_CTX_TAG_RE.finditer(text or ""):
        config.ensure_context_tag(tm.group(1))
    m = GROUP_CTX_TAG_RE.match(text or "")
    if not m:
        return text
    group, tag, colon = m.group(1), m.group(2).lower(), m.group(3)
    config.assign_group_context(group, _context_for_tag(tag))
    return f"{group}{colon}{text[m.end():]}"


def _learn_and_clean_parsed_days(result: dict) -> None:
    """Apply inline-group-tag learning/cleaning to a parsed week result in place."""
    for day_data in result.get("days", []):
        tasks = day_data.tasks if hasattr(day_data, "tasks") else day_data["tasks"]
        for task in tasks:
            if hasattr(task, "text"):
                cleaned = _learn_and_clean_group_tag(task.text)
                if cleaned != task.text:
                    task.text = cleaned
                    if hasattr(task, "clean_text") and task.clean_text:
                        task.clean_text = _learn_and_clean_group_tag(task.clean_text)
            else:
                cleaned = _learn_and_clean_group_tag(task.get("text", ""))
                if cleaned != task.get("text"):
                    task["text"] = cleaned
                    if task.get("clean_text"):
                        task["clean_text"] = _learn_and_clean_group_tag(task["clean_text"])


def _list_archived_week_files() -> list[tuple[int, int, Path]]:
    """List all archived week files as (year, week, path), sorted newest first."""
    archive = _archive_path()
    if not archive.exists():
        return []
    base = re.escape(config.plan_week_file.replace(".md", ""))
    pattern = re.compile(rf"^{base} - (\d{{4}})-wk(\d{{1,2}})\.md$")
    found: list[tuple[int, int, Path]] = []
    for p in archive.iterdir():
        if not p.is_file():
            continue
        m = pattern.match(p.name)
        if m:
            found.append((int(m.group(1)), int(m.group(2)), p))
    found.sort(key=lambda t: (t[0], t[1]), reverse=True)
    return found


def _find_archived_week(year: int, week: int) -> Optional[Path]:
    """Find an archived week file, handling both zero-padded and non-padded names."""
    archive = _archive_path()
    # Try zero-padded first (wk08), then non-padded (wk8)
    base = config.plan_week_file.replace(".md", "")
    for fmt in [f"{base} - {year}-wk{week:02d}.md", f"{base} - {year}-wk{week}.md"]:
        p = archive / fmt
        if p.exists():
            return p
    return None


def _next_week_file(year: int, week: int) -> Path:
    """Return path for a future week file in same folder as Plan Week.md."""
    base = config.plan_week_file.replace(".md", "")
    return config.vault_path / f"{base} - {year}-wk{week:02d}.md"


def _create_week_template(year: int, week: int) -> str:
    """Generate a blank Plan Week.md template for a given week."""
    # Find Monday of that ISO week
    jan4 = date(year, 1, 4)  # Jan 4 is always in ISO week 1
    monday = jan4 + timedelta(weeks=week - 1, days=-jan4.weekday())
    days_of_week = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    lines = [
        "## Goals",
        "- ",
        "",
        f"Week {year}-wk{week:02d}",
        "",
    ]
    for i, day_name in enumerate(days_of_week):
        d = monday + timedelta(days=i)
        lines.append(f"##### {day_name} {d.day}")
        lines.append("")
    lines.append("#### Notes")
    lines.append("")
    return "\n".join(lines)

def _file_week_info(plan_file: Path) -> Optional[tuple[int, int]]:
    """Extract (year, week) from the week label inside a plan file."""
    if not plan_file.exists():
        return None
    content = plan_file.read_text(encoding="utf-8")
    m = re.search(r"(\d{4})-wk(\d{1,2})", content)
    if m:
        return int(m.group(1)), int(m.group(2))
    return None


def _auto_transition_if_needed() -> list[str]:
    """Check if Plan Week.md is stale and transition forward as needed.

    Compares the week label inside Plan Week.md with today's ISO week.
    If the file is from a past week, archives it and promotes/creates
    successive weeks until Plan Week.md matches the current calendar week.

    Returns list of transition messages (empty if no transition needed).
    """
    import logging
    log = logging.getLogger("plan.auto_transition")

    current_file = config.vault_path / config.plan_week_file
    if not current_file.exists():
        return []

    cal_year, cal_week = _current_week_info()
    transitions: list[str] = []

    # Loop in case multiple weeks need to be skipped
    for _ in range(10):  # safety cap
        file_info = _file_week_info(current_file)
        if file_info is None:
            break  # can't determine week — leave as-is

        file_year, file_week = file_info
        if (file_year, file_week) >= (cal_year, cal_week):
            break  # file is current or future — no transition needed

        log.info(f"Auto-transitioning: Plan Week.md is wk{file_week:02d}, calendar is wk{cal_week:02d}")

        # Archive the stale file
        archive_dir = _archive_path()
        archive_dir.mkdir(parents=True, exist_ok=True)
        archive_file = archive_dir / f"{config.plan_week_file.replace('.md', '')} - {file_year}-wk{file_week:02d}.md"
        if archive_file.exists():
            # Already archived (manual copy?), just remove the stale Plan Week.md
            current_file.unlink()
        else:
            shutil.move(str(current_file), str(archive_file))
        transitions.append(f"Archived wk{file_week:02d}")

        # Determine next week after the file's week (not today+1)
        next_date = date.fromisocalendar(file_year, file_week, 1) + timedelta(weeks=1)
        next_iso = next_date.isocalendar()
        next_year, next_week = next_iso[0], next_iso[1]

        # Try to promote the next week's file
        next_file = _next_week_file(next_year, next_week)
        if next_file.exists():
            shutil.move(str(next_file), str(current_file))
            transitions.append(f"Promoted wk{next_week:02d}")
        else:
            # Create fresh template for the next week
            template = _create_week_template(next_year, next_week)
            current_file.write_text(template, encoding="utf-8")
            transitions.append(f"Created wk{next_week:02d}")

    if transitions:
        log.info(f"Auto-transition complete: {transitions}")
    return transitions


router = APIRouter(prefix="/plan", tags=["plan"])


@router.get("/debug")
async def debug_plan():
    """Debug endpoint to check vault scanning."""
    import os
    from pathlib import Path
    vault = config.vault_path
    md_files = list(vault.rglob("*.md")) if vault.exists() else []
    raw_tasks = scan_vault(vault)
    pending = [t for t in raw_tasks if not t.done]
    return {
        "vault_path": str(vault),
        "vault_exists": vault.exists(),
        "md_files_found": len(md_files),
        "md_file_names": [str(f.relative_to(vault)) for f in md_files[:10]],
        "os_listdir": os.listdir(str(vault))[:10] if vault.exists() else [],
        "total_tasks": len(raw_tasks),
        "pending_tasks": len(pending),
        "api_key_set": bool(os.environ.get("ANTHROPIC_API_KEY")),
        "sample": [{"text": t.text, "context": t.context} for t in pending[:5]],
    }


@router.get("", response_model=PlanResponse)
async def get_plan(target_date: Optional[str] = None):
    """Scan Obsidian vault, prioritise tasks, return plan for approval.

    Optional query param `target_date` (YYYY-MM-DD) to load a specific day.
    Defaults to today.
    """
    if target_date:
        try:
            selected = date.fromisoformat(target_date)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid date format: {target_date}")
    else:
        selected = date.today()

    # Read vault (with carryover from previous days)
    raw_tasks, carryover_tasks = scan_vault_with_carryover(config.vault_path, selected)

    # Split into pending and completed
    pending_tasks = [t for t in raw_tasks if not t.done]
    completed_tasks = [t for t in raw_tasks if t.done]

    # Read memory for context
    memory = read_memory(config.memory_path)

    # Prioritise pending only
    prioritised = await prioritise_tasks(pending_tasks, memory)

    # Create session
    session = create_session(prioritised)

    return PlanResponse(
        session_id=session.session_id,
        date=selected.isoformat(),
        day_type=get_day_type(selected),
        tasks=prioritised,
        completed=completed_tasks,
        carryover=carryover_tasks,
        summary=f"{len(prioritised)} tasks prioritised for {selected.strftime('%A')}",
    )


@router.post("/approve")
async def approve_plan(req: ApproveRequest):
    """Approve the plan (optionally with edits) and log to memory."""
    session = get_session(req.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    # Apply edits if provided
    if req.tasks is not None:
        session.tasks = req.tasks

    session.approved = True

    # Build plan summary for log
    plan_lines = []
    for t in session.tasks:
        plan_lines.append(f"[{t.priority}] {t.text}")
    plan_summary = "\n".join(plan_lines)

    log_entry = f"- Plan output:\n{_indent(plan_summary)}\n- Completed:\n- Notes:"
    append_weekly_log(config.memory_path, log_entry, replace=True)

    return {"status": "approved", "session_id": req.session_id}


@router.post("/start-session")
async def start_session():
    """Create an approved coaching session from today's tasks in the vault."""
    today_tasks, _carryover = scan_vault_with_carryover(config.vault_path)
    if not today_tasks:
        raise HTTPException(status_code=400, detail="No tasks found for today")
    session = create_session(today_tasks)
    session.approved = True
    return {"session_id": session.session_id, "task_count": len(today_tasks)}


@router.get("/goals")
async def get_goals():
    """Return weekly goals from plan files."""
    goals = scan_goals(config.vault_path)
    return {"goals": goals}


class SaveGoalsRequest(BaseModel):
    goals: list[str]
    offset: int = 0


@router.put("/goals")
async def save_goals(req: SaveGoalsRequest):
    """Save goals to the week plan file, rewriting the Goals section."""
    if req.offset < 0:
        raise HTTPException(status_code=400, detail="Cannot save goals to archived weeks")
    if req.offset == 0:
        plan_file = config.vault_path / config.plan_week_file
    else:
        year, week = _week_info_for_offset(req.offset)
        plan_file = _next_week_file(year, week)
    if not plan_file.exists():
        raise HTTPException(status_code=404, detail="Plan file not found")

    original = plan_file.read_text(encoding="utf-8")
    lines = original.split("\n")

    # Find Goals section boundaries
    goals_start = None
    goals_end = None
    bullet_re = re.compile(r"^\s*[-*]\s+")
    for i, line in enumerate(lines):
        if goals_start is None:
            if line.strip().lower().rstrip(":") == "goals":
                goals_start = i
        else:
            # We're inside goals section — find where it ends
            stripped = line.strip()
            if stripped == "" or (not bullet_re.match(line) and stripped != "-"):
                goals_end = i
                break
    if goals_start is None:
        # No Goals section found — insert one at top (after frontmatter)
        insert_at = 0
        for i, line in enumerate(lines):
            if line.strip() == "---" and i > 0:
                insert_at = i + 1
                break
        goal_lines = ["## Goals"] + [f"* {g}" for g in req.goals if g.strip()] + [""]
        lines = lines[:insert_at] + goal_lines + lines[insert_at:]
    else:
        if goals_end is None:
            goals_end = len(lines)
        # Preserve the header line, replace bullet content
        goal_bullets = [f"* {g}" for g in req.goals if g.strip()]
        if not goal_bullets:
            goal_bullets = ["-"]  # empty placeholder
        lines = lines[:goals_start + 1] + goal_bullets + lines[goals_end:]

    plan_file.write_text("\n".join(lines), encoding="utf-8")
    return {"status": "ok", "count": len([g for g in req.goals if g.strip()])}


@router.get("/week-modified")
async def get_week_modified(offset: int = 0):
    """Return the last-modified timestamp of the week plan file (lightweight check)."""
    import os
    if offset == 0:
        plan_file = config.vault_path / config.plan_week_file
    elif offset > 0:
        year, week = _week_info_for_offset(offset)
        plan_file = _next_week_file(year, week)
    else:
        year, week = _week_info_for_offset(offset)
        found = _find_archived_week(year, week)
        plan_file = found if found else config.vault_path / config.plan_week_file
    if not plan_file.exists():
        return {"mtime": None}
    mtime = os.path.getmtime(plan_file)
    return {"mtime": mtime}


@router.get("/week", response_model=WeekPlanResponse)
async def get_week_plan(offset: int = 0):
    """Return all days' tasks from a week plan.

    offset=0  → current week (Plan Week.md)
    offset=-1 → previous week (from 4-Archive/a0-Inbox)
    offset=1  → next week (from 0-Inbox, max 1 week forward)
    """
    if offset > 1:
        raise HTTPException(status_code=400, detail="Cannot look more than 1 week ahead")

    if offset == 0:
        # Auto-transition if Plan Week.md is from a past week
        _auto_transition_if_needed()
        # Current week — Plan Week.md in vault_path (0-Inbox)
        plan_file = config.vault_path / config.plan_week_file
        if not plan_file.exists():
            raise HTTPException(status_code=404, detail="Plan Week.md not found in vault")
    elif offset > 0:
        # Future week — look in 0-Inbox
        year, week = _week_info_for_offset(offset)
        plan_file = _next_week_file(year, week)
        if not plan_file.exists():
            raise HTTPException(status_code=404, detail=f"Next week file not found. Use create-next-week first.")
    else:
        # Past week — look in archive (handles both wk08 and wk8 naming)
        year, week = _week_info_for_offset(offset)
        found = _find_archived_week(year, week)
        if not found:
            raise HTTPException(status_code=404, detail=f"Archived week {year}-wk{week:02d} not found in 4-Archive/a0-Inbox")
        plan_file = found

    content = plan_file.read_text(encoding="utf-8")
    result = parse_week_plan(content, plan_file.name)
    # Learn inline group tags (also covers tags typed directly in Obsidian);
    # the cleaned text reaches the file on the next save.
    _learn_and_clean_parsed_days(result)
    resp = WeekPlanResponse(**result)
    # Add offset and read-only info
    resp.offset = offset
    resp.is_archive = offset < 0
    return resp


@router.post("/save-week")
async def save_week_plan(req: SaveWeekRequest):
    """Write all days back to the week file, replacing the day sections."""
    offset = getattr(req, "offset", 0) or 0
    if offset < 0:
        raise HTTPException(status_code=400, detail="Cannot save to archived weeks")
    if offset == 0:
        plan_file = config.vault_path / config.plan_week_file
    else:
        year, week = _week_info_for_offset(offset)
        plan_file = _next_week_file(year, week)
    if not plan_file.exists():
        raise HTTPException(status_code=404, detail="Plan Week.md not found in vault")

    # Sync guard: refuse to overwrite a file that changed since the client
    # last read it (Obsidian edit, or a sync from another device landing).
    if req.expected_mtime is not None:
        if plan_file.stat().st_mtime > req.expected_mtime + 0.01:
            raise HTTPException(
                status_code=409,
                detail="Week file changed on disk since it was loaded — reload before saving",
            )

    original = plan_file.read_text(encoding="utf-8")
    lines = original.split("\n")

    # Find the first day heading and the end boundary (Notes / * * *)
    heading_re_local = re.compile(r"^#{3,6}\s+(.+)")
    all_day_words = {
        "monday", "mon", "tuesday", "tues", "tue", "wednesday", "wed",
        "thursday", "thur", "thu", "friday", "fri", "saturday", "sat", "sunday", "sun",
    }
    first_day_idx = None
    end_idx = None

    for i, line in enumerate(lines):
        m = heading_re_local.match(line.strip())
        if m:
            heading_text = m.group(1).strip().lower()
            # strip emphasis so "**fri**" still reads as a day word
            heading_words = {w.strip("*_") for w in heading_text.split()}
            if heading_words & all_day_words:
                if first_day_idx is None:
                    first_day_idx = i
            elif first_day_idx is not None and end_idx is None:
                # Non-day heading after days started — this is the boundary
                if heading_text in {"notes"} or heading_text.rstrip(":") in {"notes"}:
                    end_idx = i
                    break
        if line.strip() == "* * *" and first_day_idx is not None:
            end_idx = i
            break

    if first_day_idx is None:
        raise HTTPException(status_code=404, detail="No day headings found in Plan Week.md")
    if end_idx is None:
        end_idx = len(lines)

    # Build new day sections (grouped by prefix like "Rotary: task" → "* Rotary:" + indented)
    day_lines: list[str] = []
    for day_data in req.days:
        day_lines.append(day_data.heading or f"##### {day_data.day.capitalize()}")
        # Inline group teaching: learn "wallet@w:"-style tags and clean them
        for task in day_data.tasks:
            task.text = _learn_and_clean_group_tag(task.text)
        day_lines.extend(_format_tasks_grouped(day_data.tasks))
        # No blank line between days — matches original format

    # Reconstruct file
    new_lines = lines[:first_day_idx] + day_lines + [""] + lines[end_idx:]
    plan_file.write_text("\n".join(new_lines), encoding="utf-8")

    return {"status": "saved", "days": len(req.days), "mtime": plan_file.stat().st_mtime}


@router.post("/create-next-week")
async def create_next_week():
    """Create a blank Plan Week file for next week in 0-Inbox.

    Returns the week label and confirms creation.
    """
    year, week = _week_info_for_offset(1)
    next_file = _next_week_file(year, week)

    if next_file.exists():
        return {"status": "exists", "week_label": f"Week {year}-wk{week:02d}", "file": str(next_file)}

    # Ensure 0-Inbox directory exists
    next_file.parent.mkdir(parents=True, exist_ok=True)
    content = _create_week_template(year, week)
    next_file.write_text(content, encoding="utf-8")

    return {"status": "created", "week_label": f"Week {year}-wk{week:02d}", "file": str(next_file)}


@router.post("/transition-week")
async def transition_week():
    """Archive current Plan Week.md and promote next week's file.

    1. Move Plan Week.md → 4-Archive/a0-Inbox/Plan Week - {year}-wk{week}.md
    2. If next week file exists in 0-Inbox, rename to Plan Week.md
    """
    current_file = config.vault_path / config.plan_week_file
    if not current_file.exists():
        raise HTTPException(status_code=404, detail="Plan Week.md not found")

    # Determine current week number from file content
    content = current_file.read_text(encoding="utf-8")
    week_match = re.search(r"(\d{4})-wk(\d{1,2})", content)
    if week_match:
        arch_year = int(week_match.group(1))
        arch_week = int(week_match.group(2))
    else:
        # Fallback to current calendar week
        arch_year, arch_week = _current_week_info()

    # 1. Archive current week
    archive_dir = _archive_path()
    archive_dir.mkdir(parents=True, exist_ok=True)
    archive_file = _archive_path() / f"{config.plan_week_file.replace('.md', '')} - {arch_year}-wk{arch_week:02d}.md"
    shutil.move(str(current_file), str(archive_file))

    # 2. Promote next week file if it exists
    # Use file's week + 1, not today + 1, to handle multi-week gaps correctly
    next_date = date.fromisocalendar(arch_year, arch_week, 1) + timedelta(weeks=1)
    next_iso = next_date.isocalendar()
    next_year, next_week = next_iso[0], next_iso[1]
    next_file = _next_week_file(next_year, next_week)
    promoted = False
    if next_file.exists():
        shutil.move(str(next_file), str(current_file))
        promoted = True
    else:
        # Create a fresh Plan Week.md for the new current week
        template = _create_week_template(next_year, next_week)
        current_file.write_text(template, encoding="utf-8")

    return {
        "status": "transitioned",
        "archived": f"{config.plan_week_file.replace('.md', '')} - {arch_year}-wk{arch_week:02d}.md",
        "promoted": promoted,
        "new_week": f"{next_year}-wk{next_week:02d}",
    }


class CarryForwardItem(BaseModel):
    text: str
    day: str  # e.g. "monday"
    group: str = ""
    subtasks: list = []
    focused: bool = False
    waiting: bool = False
    priority: str = ""  # empty = unassigned (shown as "-" in the UI)


class CarryForwardRequest(BaseModel):
    tasks: list[CarryForwardItem]
    offset: int = 0  # target week offset (0 = current)
    source_offset: Optional[int] = None  # source week offset to remove tasks from


@router.get("/carry-forward")
async def get_carry_forward_tasks(offset: int = -1):
    """Get uncompleted tasks from a week for carry-forward.

    offset=0  → current week (Plan Week.md)
    offset=-1 → previous week (from archive)
    """
    year, week = _week_info_for_offset(offset)

    if offset == 0:
        # Read from current Plan Week.md
        plan_file = config.vault_path / config.plan_week_file
        if not plan_file.exists():
            return {"tasks": [], "week_label": f"{year}-wk{week:02d}", "found": False}
        source_file = plan_file
    else:
        found = _find_archived_week(year, week)
        if not found:
            return {"tasks": [], "week_label": f"{year}-wk{week:02d}", "found": False}
        source_file = found

    content = source_file.read_text(encoding="utf-8")
    result = parse_week_plan(content, source_file.name)

    uncompleted = []
    for day_data in result["days"]:
        day_name = day_data.day if hasattr(day_data, "day") else day_data["day"]
        tasks = day_data.tasks if hasattr(day_data, "tasks") else day_data["tasks"]
        for task in tasks:
            t_done = task.done if hasattr(task, "done") else task.get("done", False)
            t_text = task.text if hasattr(task, "text") else task.get("text", "")
            if not t_done:
                subtasks_raw = task.subtasks if hasattr(task, "subtasks") else task.get("subtasks", [])
                subtasks_list = []
                for st in subtasks_raw:
                    st_text = st.text if hasattr(st, "text") else st.get("text", "")
                    st_done = st.done if hasattr(st, "done") else st.get("done", False)
                    if not st_done:
                        subtasks_list.append({"text": st_text, "done": False})
                focused = task.focused if hasattr(task, "focused") else task.get("focused", False)
                waiting = task.waiting if hasattr(task, "waiting") else task.get("waiting", False)
                priority = task.priority if hasattr(task, "priority") else task.get("priority", "C")
                uncompleted.append({
                    "text": t_text,
                    "from_day": day_name,
                    "subtasks": subtasks_list,
                    "focused": focused,
                    "waiting": waiting,
                    "priority": priority or "C",
                })

    return {"tasks": uncompleted, "week_label": f"{year}-wk{week:02d}", "found": True}


@router.post("/carry-forward")
async def carry_forward_tasks(req: CarryForwardRequest):
    """Add carried-forward tasks to the target week's plan file."""
    offset = req.offset
    if offset == 0:
        plan_file = config.vault_path / config.plan_week_file
    elif offset > 0:
        year, week = _week_info_for_offset(offset)
        plan_file = _next_week_file(year, week)
    else:
        raise HTTPException(status_code=400, detail="Cannot carry forward to archived weeks")

    if not plan_file.exists():
        raise HTTPException(status_code=404, detail="Target plan file not found")

    original = plan_file.read_text(encoding="utf-8")
    result = parse_week_plan(original, plan_file.name)

    # Group carried tasks by target day
    day_map = {"monday": 0, "tuesday": 1, "wednesday": 2, "thursday": 3,
               "friday": 4, "saturday": 5, "sunday": 6}

    for item in req.tasks:
        di = day_map.get(item.day.lower(), 0)
        day_data = result["days"][di]
        tasks = day_data.tasks if hasattr(day_data, "tasks") else day_data["tasks"]

        # Format task line
        task_text = item.text
        new_task = {
            "text": task_text,
            "done": False,
            "source_file": plan_file.name,
            "context": "day",
            "tags": [],
            "priority": item.priority or "C",
            "pillars": [],
            "subtasks": item.subtasks,
            "focused": item.focused,
            "waiting": item.waiting,
        }
        tasks.append(type(tasks[0])(**new_task) if tasks else new_task)

    # Now rewrite the file with the added tasks
    _rewrite_week_file(plan_file, original, result)

    # Remove carried tasks from the source week
    if req.source_offset is not None:
        _remove_carried_tasks_from_source(req.source_offset, req.tasks)

    return {"status": "ok", "count": len(req.tasks)}


class ResolveCarryRequest(BaseModel):
    text: str
    source_offset: int = -1
    action: str  # "done" (was completed, forgot to tick) | "delete" (dropped)


def _source_week_file(source_offset: int) -> Optional[Path]:
    if source_offset == 0:
        f = config.vault_path / config.plan_week_file
        return f if f.exists() else None
    year, week = _week_info_for_offset(source_offset)
    if source_offset > 0:
        f = _next_week_file(year, week)
        return f if f.exists() else None
    return _find_archived_week_or_earlier(year, week)


@router.post("/carry-forward/resolve")
async def resolve_carry_task(req: ResolveCarryRequest):
    """Resolve a carry-forward item without carrying it.

    "done": the task actually happened that week — mark it completed in the
    source file so history stays honest. "delete": it's no longer relevant.
    """
    if req.action not in ("done", "delete"):
        raise HTTPException(status_code=400, detail="action must be 'done' or 'delete'")
    source_file = _source_week_file(req.source_offset)
    if not source_file:
        raise HTTPException(status_code=404, detail="Source week file not found")

    original = source_file.read_text(encoding="utf-8")
    result = parse_week_plan(original, source_file.name)
    wanted = req.text.strip().lower()
    resolved = False
    for day_data in result["days"]:
        tasks = day_data.tasks if hasattr(day_data, "tasks") else day_data["tasks"]
        kept = []
        for task in tasks:
            t_text = task.text if hasattr(task, "text") else task.get("text", "")
            t_done = task.done if hasattr(task, "done") else task.get("done", False)
            if not resolved and not t_done and t_text.strip().lower() == wanted:
                resolved = True
                if req.action == "delete":
                    continue  # drop the line
                if hasattr(task, "done"):
                    task.done = True
                else:
                    task["done"] = True
            kept.append(task)
        if hasattr(day_data, "tasks"):
            day_data.tasks = kept
        else:
            day_data["tasks"] = kept
    if not resolved:
        raise HTTPException(status_code=404, detail="Task not found in source week")
    _rewrite_week_file(source_file, original, result)
    return {"status": req.action}


def _remove_carried_tasks_from_source(source_offset: int, carried_tasks: list[CarryForwardItem]):
    """Remove carried-forward tasks from the source week file."""
    if source_offset == 0:
        source_file = config.vault_path / config.plan_week_file
    else:
        year, week = _week_info_for_offset(source_offset)
        if source_offset > 0:
            source_file = _next_week_file(year, week)
        else:
            found = _find_archived_week(year, week)
            if not found:
                return
            source_file = found

    if not source_file.exists():
        return

    original = source_file.read_text(encoding="utf-8")
    result = parse_week_plan(original, source_file.name)

    # Build a set of task texts to remove (normalised for matching)
    to_remove = {t.text.strip().lower() for t in carried_tasks}

    for day_data in result["days"]:
        tasks = day_data.tasks if hasattr(day_data, "tasks") else day_data["tasks"]
        # Filter out uncompleted tasks whose text matches carried items
        kept = []
        for task in tasks:
            t_text = task.text if hasattr(task, "text") else task.get("text", "")
            t_done = task.done if hasattr(task, "done") else task.get("done", False)
            normalised = t_text.strip().lower()
            if not t_done and normalised in to_remove:
                to_remove.discard(normalised)  # remove only one match
                continue
            kept.append(task)
        if hasattr(day_data, "tasks"):
            day_data.tasks = kept
        else:
            day_data["tasks"] = kept

    _rewrite_week_file(source_file, original, result)


def _rewrite_week_file(plan_file: Path, original: str, result: dict):
    """Rewrite a week plan file from parsed result data."""
    lines = original.split("\n")

    heading_re_local = re.compile(r"^#{3,6}\s+(.+)")
    all_day_words = {
        "monday", "mon", "tuesday", "tues", "tue", "wednesday", "wed",
        "thursday", "thur", "thu", "friday", "fri", "saturday", "sat", "sunday", "sun",
    }

    first_day_idx = None
    end_boundary = len(lines)
    for i, line in enumerate(lines):
        m = heading_re_local.match(line.strip())
        if m:
            heading_text = m.group(1).strip()
            # Tolerate markdown emphasis around any word: "Fri 17",
            # "Fri **17**" and "**Fri** 17" are all day headings. A strict
            # match here once misread a bolded date as the end boundary —
            # every carry rewrite then duplicated all days after it.
            heading_words = {w.strip("*_").lower() for w in heading_text.split()}
            if heading_words & all_day_words:
                if first_day_idx is None:
                    first_day_idx = i
            elif first_day_idx is not None:
                end_boundary = i
                break
        elif first_day_idx is not None and line.strip() in ("* * *", "---", "___"):
            end_boundary = i
            break

    if first_day_idx is None:
        return

    # Strip trailing blank lines from header to prevent growth on each save
    header_lines = lines[:first_day_idx]
    while header_lines and header_lines[-1].strip() == "":
        header_lines.pop()
    footer_lines = lines[end_boundary:]

    day_lines = []
    for day_data in result["days"]:
        heading = day_data.heading if hasattr(day_data, "heading") else day_data["heading"]
        tasks = day_data.tasks if hasattr(day_data, "tasks") else day_data["tasks"]
        day_lines.append(heading)
        # Normalise tasks to objects so _format_tasks_grouped can use attribute access
        normalised = []
        for task in tasks:
            if isinstance(task, dict):
                normalised.append(_DictAsObj(task))
            else:
                normalised.append(task)
        day_lines.extend(_format_tasks_grouped(normalised))
        # No blank line between days — matches original format

    new_content = "\n".join(header_lines + [""] + day_lines + footer_lines)
    plan_file.write_text(new_content, encoding="utf-8")


class SaveVaultRequest(BaseModel):
    content: str  # formatted task text to write
    grouped: bool = False


@router.post("/save-vault")
async def save_to_vault(req: SaveVaultRequest):
    """Replace today's section in Plan Week.md with the provided content."""
    plan_file = config.vault_path / config.plan_week_file
    if not plan_file.exists():
        raise HTTPException(status_code=404, detail="Plan Week.md not found in vault")

    original = plan_file.read_text(encoding="utf-8")
    lines = original.split("\n")

    # Find today's day heading and the next heading after it
    today = date.today()
    day_name = today.strftime("%A").lower()
    day_abbrevs = {
        "monday": {"monday", "mon"},
        "tuesday": {"tuesday", "tues", "tue"},
        "wednesday": {"wednesday", "wed"},
        "thursday": {"thursday", "thur", "thu"},
        "friday": {"friday", "fri"},
        "saturday": {"saturday", "sat"},
        "sunday": {"sunday", "sun"},
    }
    today_keywords = day_abbrevs.get(day_name, {day_name})

    heading_re = re.compile(r"^#{3,6}\s+(.+)")
    start_idx = None
    end_idx = None

    for i, line in enumerate(lines):
        m = heading_re.match(line.strip())
        if m:
            heading_text = m.group(1).strip().lower()
            heading_words = set(heading_text.split())
            if heading_words & today_keywords:
                start_idx = i
            elif start_idx is not None and end_idx is None:
                # Next heading after today's section
                end_idx = i

    if start_idx is None:
        raise HTTPException(status_code=404, detail=f"No heading found for {day_name} in Plan Week.md")

    if end_idx is None:
        # Today's section goes to end of file — find next section marker
        # Look for known separators like "#### Notes", "* * *", or blank lines before non-task content
        for i in range(start_idx + 1, len(lines)):
            stripped = lines[i].strip()
            if stripped.startswith("####") or stripped == "* * *":
                end_idx = i
                break
        if end_idx is None:
            end_idx = len(lines)

    # Build the new file: keep heading, replace content, keep rest
    heading_line = lines[start_idx]
    new_lines = (
        lines[:start_idx]
        + [heading_line, req.content, ""]
        + lines[end_idx:]
    )

    plan_file.write_text("\n".join(new_lines), encoding="utf-8")
    return {"status": "saved", "day": day_name, "file": str(plan_file)}


def _parse_group(text: str) -> tuple[str, str]:
    """Split 'Rotary: do X' into ('Rotary', 'do X'). Returns ('', text) if no prefix."""
    idx = text.find(":")
    if 1 < idx < 30:
        group = text[:idx].strip()
        label = text[idx + 1:].strip()
        # Don't treat priority prefixes (A:, B1:, C2:) or URLs/links as group prefixes
        if (group and label and len(group) > 1
            and not re.match(r"^(?:nw|n|m)?[A-Da-d]\d*$", group)
            and "[" not in group
            and not group.endswith("http") and not group.endswith("https")):
            return group, label
    return "", text


class _DictAsObj:
    """Thin wrapper so dict tasks can be accessed with attribute syntax."""
    def __init__(self, d: dict):
        self._d = d
    def __getattr__(self, name):
        try:
            return self._d[name]
        except KeyError:
            return None


def _format_tasks_grouped(tasks: list) -> list[str]:
    """Format tasks into grouped lines for Obsidian.

    Tasks with a prefix like 'Rotary: do X' are grouped under '* Rotary:' with
    indented sub-items. Ungrouped tasks are written as flat lines.
    Writes tasks in their actual order, creating contiguous group sections so
    the saved file matches the displayed order in the Coach UI.
    Priority sequence numbers (A1, A2, B1, etc.) are computed and saved.
    """
    # Compute per-priority sequence numbers (A1, A2, B1, C1, C2...)
    counters: dict[str, int] = {}
    seq_map: dict[int, int] = {}
    for i, task in enumerate(tasks):
        p = task.priority or "C"
        counters[p] = counters.get(p, 0) + 1
        seq_map[i] = counters[p]

    # Write tasks in order, creating contiguous group sections
    lines: list[str] = []
    current_group: str | None = None

    for i, task in enumerate(tasks):
        group, label = _parse_group(task.text)
        check = "x" if task.done else " "
        p = task.priority or "C"
        seq = seq_map.get(i, "")
        focused = getattr(task, "focused", False)
        waiting = getattr(task, "waiting", False)
        # Wrap label in bold if focused, prefix WAIT if waiting
        display_label = f"**{label}**" if focused else label
        if waiting:
            display_label = f"WAIT: {display_label}"

        if group:
            # Start a new group header if entering a different group
            if group != current_group:
                lines.append(f"* {group}:")
            lines.append(f"\t- [{check}] {p}{seq}: {display_label}")
            # Subtasks under grouped tasks: double indent
            for sub in getattr(task, "subtasks", []) or []:
                sub_check = "x" if sub.done else " "
                lines.append(f"\t\t- [{sub_check}] {sub.text}")
        else:
            # Ungrouped — flat line
            lines.append(f"- [{check}] {p}{seq}: {display_label}")
            # Subtasks under flat tasks: single indent
            for sub in getattr(task, "subtasks", []) or []:
                sub_check = "x" if sub.done else " "
                lines.append(f"\t- [{sub_check}] {sub.text}")

        current_group = group

    return lines


def _indent(text: str, prefix: str = "  ") -> str:
    return "\n".join(f"{prefix}{line}" for line in text.split("\n"))


# ── Bucket helpers ──────────────────────────────────────────────

# Priority with optional horizon prefix: nA = this week, nwA = next week,
# mA = next month; bare letter = no horizon (stays in the bucket)
_BUCKET_PRIORITY_RE = re.compile(r"^(?:\[([A-Da-d])\]|((?:nw|n|m)?)([A-Da-d]):)\s*(.*)", re.IGNORECASE)


def _bucket_path() -> Path:
    return config.vault_path / config.plan_week_bucket_file


def _parse_bucket_file(content: str) -> tuple[list[BucketTask], list[str]]:
    """Parse Bucket.md → (tasks, pinned_groups).

    Format:  - [A] task text  OR  grouped under  * GroupName:
    No checkboxes — just priority letter in brackets.
    """
    tasks: list[BucketTask] = []
    pinned: list[str] = []
    current_group: str = ""
    in_pinned_section = False
    in_subtask = False
    lines = content.split("\n")

    for line_idx, line in enumerate(lines):
        stripped = line.strip()

        # Pinned groups section
        if stripped.lower().startswith("## pinned"):
            in_pinned_section = True
            continue
        if in_pinned_section:
            if stripped.startswith("#") or (stripped.startswith("-") and not stripped.startswith("---")):
                in_pinned_section = False
            elif stripped:
                pinned = [g.strip() for g in stripped.split(",") if g.strip()]
                continue
            else:
                continue

        # Skip headings
        if stripped.startswith("#"):
            continue

        # Group header: "- GroupName:" or "* GroupName:" or "* GroupName" (no colon)
        # A top-level bullet with a single word/phrase that acts as a category
        group_m = re.match(r"^[-*]\s+(.+?):?\s*$", stripped)
        if group_m and not line.startswith("\t") and not line.startswith("    "):
            candidate = group_m.group(1).strip()
            # It's a group header if:
            # 1. Ends with colon (explicit group), OR
            # 2. Short name (≤30 chars) with no links/URLs and next line is indented
            if (stripped.endswith(":") and len(candidate) > 1 and not re.match(r"^[A-Da-d]\d*$", candidate)) or (
                len(candidate) <= 30 and len(candidate) > 1 and
                not re.match(r"^[A-Da-d]\d*$", candidate) and
                "http" not in candidate and
                "[" not in candidate and
                " - " not in candidate
            ):
                # Peek ahead: only treat as group if next non-blank line is indented
                is_group = stripped.endswith(":")
                if not is_group:
                    for peek_line in lines[line_idx + 1:]:
                        peek_stripped = peek_line.strip()
                        if not peek_stripped:
                            continue
                        if peek_line.startswith("\t") or peek_line.startswith("    "):
                            is_group = True
                        break
                if is_group:
                    current_group = candidate.rstrip(":")
                    continue

        # Indented lines under a group or task = subtasks (plain bullets, no checkboxes)
        is_indented = line.startswith("\t") or line.startswith("    ")
        if is_indented and tasks:
            sub_m = re.match(r"^\s*[-*]\s+(.*)", stripped)
            if sub_m:
                sub_text = sub_m.group(1).strip()
                # Check if this is a deeply indented subtask (double indent)
                is_deep = line.startswith("\t\t") or line.startswith("        ")
                if is_deep:
                    # Subtask of the last task
                    from backend.models import Subtask
                    tasks[-1].subtasks.append(Subtask(text=sub_text, done=False))
                    continue
                elif current_group:
                    # Indented item under a group = task in that group
                    pass  # fall through to task parsing below
                else:
                    # Single-indent subtask under ungrouped task
                    from backend.models import Subtask
                    tasks[-1].subtasks.append(Subtask(text=sub_text, done=False))
                    continue

        # Task line: - text  or  * text  or indented variants
        bullet_m = re.match(r"^[\s\t]*[-*]\s+(.*)", stripped)
        if not bullet_m:
            if not stripped:
                current_group = ""
            continue

        # Non-indented bullet = top-level task, reset group
        if not is_indented:
            current_group = ""

        text = bullet_m.group(1).strip()
        priority = ""  # no prefix = unassigned ("-" in the UI)

        # Legacy support: extract [A] priority if present (from old format)
        horizon = ""
        prio_m = _BUCKET_PRIORITY_RE.match(text)
        if prio_m:
            priority = (prio_m.group(1) or prio_m.group(3)).upper()
            horizon = (prio_m.group(2) or "").lower()
            text = prio_m.group(4).strip()

        # Detect bold (focused)
        focused = False
        bold_m = re.match(r"^\*\*(.+?)\*\*$", text)
        if bold_m:
            focused = True
            text = bold_m.group(1)

        # Detect WAIT prefix
        waiting = False
        if text.upper().startswith("WAIT:"):
            waiting = True
            text = text[5:].strip()

        # Prepend group name to text
        full_text = f"{current_group}: {text}" if current_group else text

        tasks.append(BucketTask(
            text=full_text,
            priority=priority,
            horizon=horizon,
            focused=focused,
            waiting=waiting,
        ))

    return tasks, pinned


def _format_bucket_tasks(tasks: list, pinned_groups: list[str]) -> str:
    """Format bucket tasks back to Bucket.md markdown.

    Priority saved as prefix (A:, B:, C:) — letter only, no sequence number.
    Groups use '- GroupName:' with indented sub-items.

    Tasks are consolidated so each group appears exactly once, in order of
    first appearance, with the first-seen casing ("Rotary" absorbs a later
    "rotary"). Repeated same-name sections and case-variant twins otherwise
    accumulate as tasks are added over time.
    """
    lines = ["# Planning Bucket", ""]

    if pinned_groups:
        lines.append("## Pinned Groups")
        lines.append(", ".join(pinned_groups))
        lines.append("")

    order: list[str] = []  # lowercase group keys, first-appearance order ("" = ungrouped)
    display: dict[str, str] = {}
    by_group: dict[str, list] = {}
    for task in tasks:
        group, label = _parse_group(task.text)
        key = group.lower()
        if key not in by_group:
            order.append(key)
            by_group[key] = []
            display[key] = group
        by_group[key].append((task, label))

    for key in order:
        group = display[key]
        if group:
            lines.append(f"- {group}:")
        for task, label in by_group[key]:
            p = getattr(task, "priority", "") or ""
            hz = (getattr(task, "horizon", "") or "") if p else ""
            item = label
            if getattr(task, "focused", False):
                item = f"**{item}**"
            if getattr(task, "waiting", False):
                item = f"WAIT: {item}"
            indent = "\t" if group else ""
            lines.append(f"{indent}- {hz}{p}: {item}" if p else f"{indent}- {item}")
            for sub in getattr(task, "subtasks", []) or []:
                lines.append(f"{indent}\t- {sub.text}")

    lines.append("")
    return "\n".join(lines)


# ── Bucket endpoints ────────────────────────────────────────────

@router.get("/bucket-modified")
async def get_bucket_modified():
    """Return the last-modified timestamp of the bucket file (lightweight check)."""
    import os
    bucket = _bucket_path()
    if not bucket.exists():
        return {"mtime": None}
    return {"mtime": os.path.getmtime(bucket)}


@router.get("/bucket", response_model=BucketResponse)
async def get_bucket():
    """Read and parse Bucket.md."""
    bucket = _bucket_path()
    if not bucket.exists():
        return BucketResponse(tasks=[], pinned_groups=[], mtime=None)

    content = bucket.read_text(encoding="utf-8")
    tasks, pinned = _parse_bucket_file(content)
    # Learn inline group tags typed directly into the bucket file
    for task in tasks:
        task.text = _learn_and_clean_group_tag(task.text)
    return BucketResponse(tasks=tasks, pinned_groups=pinned, mtime=bucket.stat().st_mtime)


@router.post("/bucket/save")
async def save_bucket(req: BucketSaveRequest):
    """Write bucket tasks back to Bucket.md."""
    bucket = _bucket_path()
    # Sync guard — see save_week_plan
    if req.expected_mtime is not None and bucket.exists():
        if bucket.stat().st_mtime > req.expected_mtime + 0.01:
            raise HTTPException(
                status_code=409,
                detail="Bucket file changed on disk since it was loaded — reload before saving",
            )
    # Inline group teaching: learn "wallet@w:"-style tags and clean them.
    # Stamp entered-week metadata on tasks that don't carry it yet (age hint).
    for task in req.tasks:
        task.text = _stamp_bucket_week(_learn_and_clean_group_tag(task.text))
    md = _format_bucket_tasks(req.tasks, req.pinned_groups)
    bucket.write_text(md, encoding="utf-8")
    return {"status": "saved", "task_count": len(req.tasks), "mtime": bucket.stat().st_mtime}


@router.post("/bucket/move")
async def move_bucket_task(req: BucketMoveRequest):
    """Atomically move a task between bucket and week plan."""
    bucket = _bucket_path()
    if req.week_offset == 0:
        plan_file = config.vault_path / config.plan_week_file
    else:
        year, week = _week_info_for_offset(req.week_offset)
        plan_file = _next_week_file(year, week)

    if not plan_file.exists():
        raise HTTPException(status_code=404, detail="Week plan file not found")

    # Read both files
    plan_content = plan_file.read_text(encoding="utf-8")
    plan_result = parse_week_plan(plan_content, plan_file.name)
    plan_days = plan_result["days"]

    bucket_tasks: list[BucketTask] = []
    pinned: list[str] = []
    if bucket.exists():
        bucket_content = bucket.read_text(encoding="utf-8")
        bucket_tasks, pinned = _parse_bucket_file(bucket_content)

    if req.direction == "to_bucket":
        # Move from week plan → bucket
        if req.day_idx < 0 or req.day_idx >= len(plan_days):
            raise HTTPException(status_code=400, detail="Invalid day index")
        day = plan_days[req.day_idx]
        if req.task_index < 0 or req.task_index >= len(day.tasks):
            raise HTTPException(status_code=400, detail="Invalid task index")

        task = day.tasks.pop(req.task_index)
        new_bucket_task = BucketTask(
            text=_stamp_bucket_week(task.text),
            priority=task.priority or "C",
            horizon=req.horizon if req.horizon in ("n", "nw", "m") else "",
            focused=task.focused,
            waiting=task.waiting,
        )
        # Insert into existing group if one matches, otherwise append
        task_group, _ = _parse_group(task.text)
        insert_idx = len(bucket_tasks)  # default: end
        if task_group:
            # Find last task in the same group and insert after it
            for i in range(len(bucket_tasks) - 1, -1, -1):
                g, _ = _parse_group(bucket_tasks[i].text)
                if g == task_group:
                    insert_idx = i + 1
                    break
        bucket_tasks.insert(insert_idx, new_bucket_task)

    elif req.direction == "from_bucket":
        # Move from bucket → week plan
        if req.task_index < 0 or req.task_index >= len(bucket_tasks):
            raise HTTPException(status_code=400, detail="Invalid bucket task index")
        if req.day_idx < 0 or req.day_idx >= len(plan_days):
            raise HTTPException(status_code=400, detail="Invalid day index")

        btask = bucket_tasks.pop(req.task_index)
        new_task = Task(
            text=_strip_bucket_meta(btask.text),
            # Unassigned bucket tasks default to C when they become plan tasks
            priority=btask.priority or "C",
            focused=btask.focused,
            waiting=btask.waiting,
            done=False,
            source_file=config.plan_week_bucket_file,
        )
        plan_days[req.day_idx].tasks.append(new_task)
    else:
        raise HTTPException(status_code=400, detail="direction must be 'to_bucket' or 'from_bucket'")

    # Save both files
    bucket.parent.mkdir(parents=True, exist_ok=True)
    bucket.write_text(_format_bucket_tasks(bucket_tasks, pinned), encoding="utf-8")

    # Save week plan — reuse save endpoint
    from backend.models import SaveWeekRequest
    await save_week_plan(SaveWeekRequest(days=plan_days, offset=req.week_offset))

    return {"status": "moved", "direction": req.direction, "bucket_count": len(bucket_tasks)}


# ── Plan Notes endpoints ──────────────────────────────────────


class AppendNoteRequest(BaseModel):
    day: str  # "monday", "tuesday", etc.
    entry: str  # note text to add
    group: str = ""  # optional group name (e.g., "iGrant")
    timestamp: bool = True  # auto-add timestamp?
    offset: int = 0  # week offset


class PutNotesRequest(BaseModel):
    day: str  # "monday", "tuesday", etc.
    content: str  # full notes content for this day
    offset: int = 0  # week offset


def _get_plan_file(offset: int) -> Path:
    """Get the plan file path for a given week offset."""
    if offset == 0:
        return config.vault_path / config.plan_week_file
    elif offset > 0:
        year, week = _week_info_for_offset(offset)
        return _next_week_file(year, week)
    else:
        year, week = _week_info_for_offset(offset)
        found = _find_archived_week(year, week)
        if not found:
            raise HTTPException(status_code=404, detail=f"Archived week not found")
        return found


@router.get("/notes")
async def get_plan_notes(day: Optional[str] = None, offset: int = 0):
    """Get notes from the #### Notes section of Plan Week.md.

    If day is specified, returns notes for that day only.
    Otherwise returns all notes for the week.
    """
    plan_file = _get_plan_file(offset)
    if not plan_file.exists():
        raise HTTPException(status_code=404, detail="Plan file not found")

    content = plan_file.read_text(encoding="utf-8")
    result = parse_week_plan(content, plan_file.name)
    notes = result.get("notes")

    if notes is None:
        return {"days": {}, "general": ""}

    if day:
        day_lower = day.lower()
        day_notes = notes["days"].get(day_lower)
        if day_notes:
            return day_notes
        return {"day": day_lower, "content": "", "groups": {}, "ungrouped": [], "wiki_links": []}

    return notes


@router.post("/notes/append")
async def append_plan_note(req: AppendNoteRequest):
    """Append a note entry to a specific day's notes section in Plan Week.md.

    Creates the #### Notes and ##### <Day> headings if they don't exist.
    Auto-timestamps the entry if requested.
    """
    if req.offset < 0:
        raise HTTPException(status_code=400, detail="Cannot append notes to archived weeks")

    plan_file = _get_plan_file(req.offset)
    if not plan_file.exists():
        raise HTTPException(status_code=404, detail="Plan file not found")

    content = plan_file.read_text(encoding="utf-8")
    lines = content.split("\n")

    # Format the entry
    entry = req.entry
    if req.timestamp:
        from datetime import datetime
        ts = datetime.now().strftime("%H:%M")
        entry = f"{ts} — {entry}"

    if req.group:
        formatted_entry = f"**{req.group}:**\n{entry}"
    else:
        formatted_entry = entry

    # Find or create #### Notes section
    notes_idx = None
    for i, line in enumerate(lines):
        if line.strip().lower().startswith("#### notes") or line.strip().lower() == "notes":
            notes_idx = i
            break

    if notes_idx is None:
        # Add #### Notes at the end
        lines.append("")
        lines.append("#### Notes")
        notes_idx = len(lines) - 1

    # Normalize day name
    day_heading_map = {
        "monday": "Monday", "tuesday": "Tuesday", "wednesday": "Wednesday",
        "thursday": "Thursday", "friday": "Friday", "saturday": "Saturday", "sunday": "Sunday",
    }
    day_lower = req.day.lower()
    day_title = day_heading_map.get(day_lower, req.day.capitalize())

    # Find or create ##### <Day> heading under #### Notes
    day_idx = None
    day_end_idx = None
    all_day_words = set()
    for d in day_heading_map:
        all_day_words.add(d)
        all_day_words.update(_DAY_NORMALIZE_REVERSE.get(d, set()))

    for i in range(notes_idx + 1, len(lines)):
        stripped = lines[i].strip()
        if stripped.startswith("#####"):
            heading_text = stripped.lstrip("#").strip().lower()
            heading_words = set(heading_text.split())
            from backend.agents.obsidian_reader import _DAY_NORMALIZE
            matched = heading_words & set(_DAY_NORMALIZE.keys())
            if matched:
                match_word = next(iter(matched))
                if _DAY_NORMALIZE[match_word] == day_lower:
                    day_idx = i
                elif day_idx is not None and day_end_idx is None:
                    day_end_idx = i
        elif stripped.startswith("####") and not stripped.startswith("#####"):
            # Another h4 heading — stop
            if day_idx is not None and day_end_idx is None:
                day_end_idx = i
            break

    if day_idx is None:
        # Create the day heading at the end of notes section
        # Find end of notes section
        end_of_notes = len(lines)
        for i in range(notes_idx + 1, len(lines)):
            stripped = lines[i].strip()
            if stripped.startswith("####") and not stripped.startswith("#####"):
                end_of_notes = i
                break

        insert_lines = [f"##### {day_title}", formatted_entry, ""]
        lines = lines[:end_of_notes] + insert_lines + lines[end_of_notes:]
    else:
        # Insert at end of day section
        if day_end_idx is None:
            day_end_idx = len(lines)
        # Find last non-empty line in day section
        insert_at = day_end_idx
        lines = lines[:insert_at] + [formatted_entry, ""] + lines[insert_at:]

    plan_file.write_text("\n".join(lines), encoding="utf-8")
    return {"status": "appended", "day": day_lower}


@router.put("/notes")
async def put_plan_notes(req: PutNotesRequest):
    """Replace the full notes content for a specific day in Plan Week.md."""
    if req.offset < 0:
        raise HTTPException(status_code=400, detail="Cannot modify notes in archived weeks")

    plan_file = _get_plan_file(req.offset)
    if not plan_file.exists():
        raise HTTPException(status_code=404, detail="Plan file not found")

    content = plan_file.read_text(encoding="utf-8")
    lines = content.split("\n")

    # Find #### Notes section
    notes_idx = None
    for i, line in enumerate(lines):
        if line.strip().lower().startswith("#### notes") or line.strip().lower() == "notes":
            notes_idx = i
            break

    if notes_idx is None:
        lines.append("")
        lines.append("#### Notes")
        notes_idx = len(lines) - 1

    day_heading_map = {
        "monday": "Monday", "tuesday": "Tuesday", "wednesday": "Wednesday",
        "thursday": "Thursday", "friday": "Friday", "saturday": "Saturday", "sunday": "Sunday",
    }
    day_lower = req.day.lower()
    day_title = day_heading_map.get(day_lower, req.day.capitalize())

    # Collect ALL blocks for this day. Duplicate day headings (from an old
    # replace-only-the-last bug, or multi-device conflicts) previously became
    # immortal: a save replaced one block and re-merged the rest on read,
    # splicing stale text into new. A save now removes every block for the
    # day and writes exactly one fresh one — the file self-heals.
    from backend.agents.obsidian_reader import _DAY_NORMALIZE
    day_ranges: list[tuple[int, int]] = []  # [start, end) line ranges
    block_start: int | None = None
    section_end = len(lines)

    i = notes_idx + 1
    while i <= len(lines):
        stripped = lines[i].strip() if i < len(lines) else ""
        at_end = i == len(lines)
        is_other_section = (not at_end) and stripped.startswith("####") and not stripped.startswith("#####")
        this_day = None
        if (not at_end) and stripped.startswith("#####"):
            heading_words = set(stripped.lstrip("#").strip().lower().split())
            matched = heading_words & set(_DAY_NORMALIZE.keys())
            if matched:
                this_day = _DAY_NORMALIZE[next(iter(matched))]
        boundary = at_end or is_other_section or this_day is not None
        if block_start is not None and boundary:
            day_ranges.append((block_start, i))
            block_start = None
        if this_day == day_lower:
            block_start = i
        if at_end or is_other_section:
            section_end = i
            break
        i += 1

    new_day_lines = [f"##### {day_title}", req.content, ""]

    if day_ranges:
        insert_at = day_ranges[0][0]
        for start, end in reversed(day_ranges):
            del lines[start:end]
        lines[insert_at:insert_at] = new_day_lines
    else:
        lines = lines[:section_end] + new_day_lines + lines[section_end:]

    plan_file.write_text("\n".join(lines), encoding="utf-8")
    return {"status": "saved", "day": day_lower}


# Helper for day normalization reverse lookup
_DAY_NORMALIZE_REVERSE: dict[str, set[str]] = {}
for _abbr, _full in {
    "monday": {"monday", "mon"},
    "tuesday": {"tuesday", "tues", "tue"},
    "wednesday": {"wednesday", "wed"},
    "thursday": {"thursday", "thur", "thu"},
    "friday": {"friday", "fri"},
    "saturday": {"saturday", "sat"},
    "sunday": {"sunday", "sun"},
}.items():
    _DAY_NORMALIZE_REVERSE[_abbr] = _full
