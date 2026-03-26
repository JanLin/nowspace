"""Plan endpoints: generate and approve daily plan."""

import re
from datetime import date
from typing import Optional
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.agents.obsidian_reader import scan_vault, scan_vault_with_carryover, scan_goals, get_day_type, parse_week_plan
from backend.agents.prioritiser import prioritise_tasks
from backend.config import config
from backend.models import ApproveRequest, PlanResponse, Task, WeekPlanResponse, SaveWeekRequest
from backend.session import create_session, get_session
from backend.utils.memory_manager import read_memory, append_weekly_log

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


@router.get("/goals")
async def get_goals():
    """Return weekly goals from plan files."""
    goals = scan_goals(config.vault_path)
    return {"goals": goals}


@router.get("/week", response_model=WeekPlanResponse)
async def get_week_plan():
    """Return all days' tasks from Plan Week.md."""
    plan_file = config.vault_path / "Plan Week.md"
    if not plan_file.exists():
        raise HTTPException(status_code=404, detail="Plan Week.md not found in vault")

    content = plan_file.read_text(encoding="utf-8")
    result = parse_week_plan(content, "Plan Week.md")
    return WeekPlanResponse(**result)


@router.post("/save-week")
async def save_week_plan(req: SaveWeekRequest):
    """Write all days back to Plan Week.md, replacing the day sections."""
    plan_file = config.vault_path / "Plan Week.md"
    if not plan_file.exists():
        raise HTTPException(status_code=404, detail="Plan Week.md not found in vault")

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
            heading_words = set(heading_text.split())
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
        day_lines.extend(_format_tasks_grouped(day_data.tasks))
        # No blank line between days — matches original format

    # Reconstruct file
    new_lines = lines[:first_day_idx] + day_lines + [""] + lines[end_idx:]
    plan_file.write_text("\n".join(new_lines), encoding="utf-8")

    return {"status": "saved", "days": len(req.days)}


class SaveVaultRequest(BaseModel):
    content: str  # formatted task text to write
    grouped: bool = False


@router.post("/save-vault")
async def save_to_vault(req: SaveVaultRequest):
    """Replace today's section in Plan Week.md with the provided content."""
    plan_file = config.vault_path / "Plan Week.md"
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
    if 0 < idx < 30:
        group = text[:idx].strip()
        label = text[idx + 1:].strip()
        # Don't treat URLs or markdown links as group prefixes
        if group and label and "[" not in group and not group.endswith("http") and not group.endswith("https"):
            return group, label
    return "", text


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
            lines.append(f"\t- [{check}] [{p}{seq}] {display_label}")
            # Subtasks under grouped tasks: double indent
            for sub in getattr(task, "subtasks", []) or []:
                sub_check = "x" if sub.done else " "
                lines.append(f"\t\t- [{sub_check}] {sub.text}")
        else:
            # Ungrouped — flat line
            lines.append(f"- [{check}] [{p}{seq}] {display_label}")
            # Subtasks under flat tasks: single indent
            for sub in getattr(task, "subtasks", []) or []:
                sub_check = "x" if sub.done else " "
                lines.append(f"\t- [{sub_check}] {sub.text}")

        current_group = group

    return lines


def _indent(text: str, prefix: str = "  ") -> str:
    return "\n".join(f"{prefix}{line}" for line in text.split("\n"))
