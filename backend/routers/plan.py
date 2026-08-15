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
from backend.config import config, SETTINGS_FILE_NAME
from backend import vault_io as _vault_io, plan_readme
from backend.plan_readme import README_NAME
from backend.vault_io import is_conflict_copy
from backend.models import (
    ApproveRequest, PlanResponse, Task, WeekPlanResponse, SaveWeekRequest,
    BucketResponse, BucketSaveRequest, BucketMoveRequest, BucketTask,
    BUCKET_SCHEMA_VERSION,
)


def _require_current_schema(sent: int) -> None:
    """Refuse bucket writes from instances that predate the current wire
    format. An out-of-date PWA or desktop app omits the newer fields, and
    accepting its write would silently flatten them for every device."""
    if sent < BUCKET_SCHEMA_VERSION:
        raise HTTPException(
            status_code=422,
            detail=(
                f"This Nowspace instance is out of date (data version {sent}, "
                f"server speaks {BUCKET_SCHEMA_VERSION}) — update or reload it "
                "before editing. Refusing the write protects the vault from "
                "silent field loss."
            ),
        )
    _require_vault_not_newer()


def _require_vault_not_newer() -> None:
    """Refuse writes to a vault a NEWER installation has already upgraded.

    The marker syncs in with the files, so a matched pair like the desktop
    app can only find this out here, from the data, not from any API skew.

    This runs on week writes as well as bucket writes. Where the plan files
    live is a vault setting now, and an installation too old to read it would
    otherwise carry on writing the folder it knows — two live week files in
    two folders, with Syncthing faithfully keeping both.
    """
    marker = config.bucket_schema_marker
    if marker > BUCKET_SCHEMA_VERSION:
        raise HTTPException(
            status_code=422,
            detail=(
                f"This vault's data is format {marker}, but this Nowspace "
                f"installation only speaks {BUCKET_SCHEMA_VERSION} — update "
                "this installation before editing (another device already "
                "upgraded the vault)."
            ),
        )


def _stamp_vault_schema() -> None:
    """After a successful v-current bucket write, record the format in the
    vault-shared settings so older installations can detect it."""
    try:
        config.stamp_bucket_schema(BUCKET_SCHEMA_VERSION)
    except OSError:
        pass  # marker upkeep never blocks a save
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
    """Return the vault root.

    config resolves this once, from config.yaml, and it is the only path that
    cannot live in the vault. Re-deriving it here by matching a folder NAME
    was the thing that made the plan folder unmovable.
    """
    return config.vault_root


def _archive_path() -> Path:
    """Where finished weeks go — a vault setting (plan.archive_folder),
    defaulting to the 4-Archive/a0-Inbox every vault has used so far."""
    return config.archive_path


# Inline group teaching: "wallet@w: task" assigns group wallet → the context
# behind tag w, persists the mapping to config.yaml, and the tag is cleaned
# from the text. Any single letter works; unknown letters auto-create a new
# context named after the letter (rename it in Settings).
GROUP_CTX_TAG_RE = re.compile(r"^([^:@\[\]]{2,29}?)@([a-z])(\s*:)", re.IGNORECASE)
# Trailing per-task tags: "task text @f" — learned (auto-created) but never cleaned
TASK_CTX_TAG_RE = re.compile(r"\s@([a-z])\b(?!\w)", re.IGNORECASE)


# Bucket metadata tokens (tilde family, hidden from UI labels):
#   ~w2628     = entered the bucket in ISO week 28 of 2026 (YYWW) — age hint
#   ~m         = "this month" GTD horizon on the bucket board
#   ~ia1b2c3   = stable item identity, stamped on first save. The funnel's
#     transition detector matches items across a save by this id, so
#     renaming/regrouping/linking an item is never mistaken for a brand-new
#     item entering its stage (which would wrongly re-apply entry gates —
#     the bug that reverted text edits on grandfathered ready items).
#     Colon-free on purpose: a colon inside the text trips the "Group:"
#     splitter on short lines (same reason week files use ~es not ~e:).
#     The regexes also accept a short-lived legacy ~id:xxxxxx form.
# ~x<6 hex> is an external reference carried on a WEEK line: an item a
# registered week source (docs/EXTENSIONS.md, seam 5) put there, tying the
# line back to whatever it came from. Colon-free like ~es and ~i…, because a
# colon on a week line is read as a "Group:" prefix. The baseline never
# interprets it — it strips it for display and re-emits it on save, so it
# survives a carry-forward and the week archive whether or not the extension
# that wrote it is installed. No BucketTask field: an external item is not a
# bucket item, and no schema bump: the bucket wire format is untouched.
BUCKET_META_RE = re.compile(r"\s*~(w\d{4}|m|i(?:d:)?[0-9a-f]{6}|x[0-9a-f]{6,40})\b", re.IGNORECASE)
EXTERNAL_REF_RE = re.compile(r"~x([0-9a-f]{6,40})\b", re.IGNORECASE)
BUCKET_ID_RE = re.compile(r"~i(?:d:)?([0-9a-f]{6})\b", re.IGNORECASE)


# ── Funnel metadata tokens (same tilde family) ─────────────────
# Parsed into first-class BucketTask fields and stripped from text; the
# serializer re-emits them, so old backends that don't know them simply
# round-trip them as opaque text (no data loss on version skew).
#   ~s:binding        stage (captured = no token; active/done live in week files)
#   ~e:s              size estimate s|m|l
#   ~sl:3             slip count
#   ~rs:2026-07-26    readySince (ISO date)
#   ~se:2026-07-26    stageEnteredAt (ISO date)
#   ~wake:2026-09-01  dormant wake date
#   ~dr:no_agency     discard reason
#   ~rh               mode = rehearse (absent = solve)
#   ~ra1b2c3          recurrence template id (schema v3) — marks a spawned
#     instance of a recurring template; colon-free because it rides week
#     lines too (the id must survive scheduling so completion credits the
#     template and week-close misses route to it, not to slip_count)
#   ~du2026-08-25     due date (schema v3), calendar instances only —
#     colon-free for the same reason; a quiet fact, never an overdue signal
# The binding question is NOT a token — it persists as a leading "? " subtask
# line, which old backends already round-trip as an ordinary subtask.
FUNNEL_STAGES = ("captured", "binding", "ready", "dormant", "discarded")
DISCARD_REASONS = ("no_agency", "already_decided", "not_mine")
_ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
FUNNEL_META_RE = re.compile(
    r"\s*~(?:"
    r"s:(?P<stage>captured|binding|ready|dormant|discarded)"
    # ~e:s in the bucket; colon-free ~es in week files (a colon there would
    # be read as a "Group:" prefix by the week parser)
    r"|e:?(?P<estimate>[sml])"
    r"|sl:(?P<slips>\d+)"
    r"|rs:(?P<ready_since>\d{4}-\d{2}-\d{2})"
    r"|se:(?P<entered>\d{4}-\d{2}-\d{2})"
    r"|wake:(?P<wake>\d{4}-\d{2}-\d{2})"
    r"|dr:(?P<reason>no_agency|already_decided|not_mine)"
    r"|(?P<rehearse>rh)"
    # ~r must trail ~rs:/~rh in the alternation; the 6-hex body can't start
    # with "s:" or be "h…", so the shorter forms never shadow each other
    r"|r(?P<recur>[0-9a-f]{6})"
    r"|du(?P<due>\d{4}-\d{2}-\d{2})"
    r")\b",
    re.IGNORECASE,
)


def _extract_funnel_meta(text: str) -> tuple[str, dict]:
    """Pull funnel tokens out of a task line → (clean text, field dict)."""
    fields: dict = {}
    def _grab(m: re.Match) -> str:
        if m.group("stage"):
            fields["stage"] = m.group("stage").lower()
        elif m.group("estimate"):
            fields["estimate"] = m.group("estimate").lower()
        elif m.group("slips"):
            fields["slip_count"] = int(m.group("slips"))
        elif m.group("ready_since"):
            fields["ready_since"] = m.group("ready_since")
        elif m.group("entered"):
            fields["stage_entered_at"] = m.group("entered")
        elif m.group("wake"):
            fields["wake_date"] = m.group("wake")
        elif m.group("reason"):
            fields["discard_reason"] = m.group("reason").lower()
        elif m.group("rehearse"):
            fields["mode"] = "rehearse"
        elif m.group("recur"):
            fields["recurrence_id"] = m.group("recur").lower()
        elif m.group("due"):
            fields["due_date"] = m.group("due")
        return ""
    clean = FUNNEL_META_RE.sub(_grab, text or "").strip()
    return clean, fields


def _funnel_tokens(task) -> str:
    """Serialize a task's funnel fields back into tilde tokens."""
    parts: list[str] = []
    stage = getattr(task, "stage", "captured") or "captured"
    # The parser infers a stage for token-less (pre-funnel) lines: ready when
    # prioritised/horizoned, else captured. Emit the token whenever the real
    # stage differs from that inference — which makes "captured despite a
    # priority" explicit while keeping untouched legacy lines byte-stable.
    inferred = "ready" if (getattr(task, "priority", "") or getattr(task, "horizon", "")) else "captured"
    if stage != inferred:
        parts.append(f"~s:{stage}")
    if getattr(task, "estimate", ""):
        parts.append(f"~e:{task.estimate}")
    if getattr(task, "slip_count", 0):
        parts.append(f"~sl:{task.slip_count}")
    if getattr(task, "ready_since", ""):
        parts.append(f"~rs:{task.ready_since}")
    if getattr(task, "stage_entered_at", ""):
        parts.append(f"~se:{task.stage_entered_at}")
    if getattr(task, "wake_date", ""):
        parts.append(f"~wake:{task.wake_date}")
    if getattr(task, "discard_reason", ""):
        parts.append(f"~dr:{task.discard_reason}")
    if getattr(task, "mode", "solve") == "rehearse":
        parts.append("~rh")
    if getattr(task, "recurrence_id", ""):
        parts.append(f"~r{task.recurrence_id}")
    if getattr(task, "due_date", ""):
        parts.append(f"~du{task.due_date}")
    return (" " + " ".join(parts)) if parts else ""


def _funnel_key(text: str) -> str:
    """Identity key for matching a task across a save (transition detection).

    The ~id: token wins when present — it survives renames, regrouping and
    link edits. Normalized text is only the fallback for items that have
    never been saved (no id yet)."""
    m = BUCKET_ID_RE.search(text or "")
    if m:
        return f"id:{m.group(1).lower()}"
    clean, _ = _extract_funnel_meta(text or "")
    clean = BUCKET_META_RE.sub("", clean)
    return " ".join(clean.lower().split())


def _strip_bucket_meta(text: str) -> str:
    text = FUNNEL_META_RE.sub("", text or "")
    return BUCKET_META_RE.sub("", text).strip()


def _stamp_bucket_week(text: str) -> str:
    """Append the entered-week stamp if the task doesn't have one yet."""
    if re.search(r"~w\d{4}\b", text or "", re.IGNORECASE):
        return text
    iso = date.today().isocalendar()
    return f"{(text or '').rstrip()} ~w{iso[0] % 100:02d}{iso[1]:02d}"


def _stamp_bucket_id(text: str) -> str:
    """Give the item its stable identity if it doesn't carry one yet."""
    if BUCKET_ID_RE.search(text or ""):
        return text
    import secrets
    return f"{(text or '').rstrip()} ~i{secrets.token_hex(3)}"


def _stamp_bucket_tokens(text: str) -> str:
    return _stamp_bucket_id(_stamp_bucket_week(text))


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


def _increment_bucket_slips() -> int:
    """Week closed: ready items committed to it (horizon n) that are still in
    the bucket slipped. Increment their slipCount (funnel stage 4). Slips and
    age-in-ready stay separate figures — never summed anywhere.

    Recurring instances are excluded: a recurring copy that keeps slipping is
    evidence the *template* is mis-specified, not the item or the person, so
    the miss routes to the template's counter — where it triggers one
    question in the review — and never to slip_count or the 3-slip dialog.

    Called once per archived week. Returns how many items slipped.
    """
    bucket = _bucket_path()
    if not bucket.exists():
        return 0
    try:
        tasks, pinned = _parse_bucket_file(bucket.read_text(encoding="utf-8"))
    except Exception:
        return 0
    slipped = 0
    missed_template_ids: list[str] = []
    for t in tasks:
        if t.stage == "ready" and t.horizon == "n":
            if t.recurrence_id:
                missed_template_ids.append(t.recurrence_id)
                continue
            t.slip_count += 1
            slipped += 1
    if slipped:
        _vault_io.write_text_guarded(bucket, _format_bucket_tasks(tasks, pinned))
    if missed_template_ids:
        _route_misses_to_templates(missed_template_ids)
    return slipped


def _route_misses_to_templates(template_ids: list[str]) -> None:
    """Instance slips at week close accrue on their templates (missedStreak).
    Best-effort, same posture as the funnel log — never blocks the close."""
    try:
        from backend import recurrence as rec
        templates = rec.load_templates()
        changed = False
        by_id = {t.id: t for t in templates if t.id}
        for tid in template_ids:
            t = by_id.get(tid)
            if t is not None:
                t.missed += 1
                changed = True
        if changed:
            rec.save_templates(templates)
    except Exception:
        import logging
        logging.getLogger("plan.recurrence").exception("miss routing failed")


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

        # Credit recurring completions in the closing week before it leaves —
        # a copy checked off late (or synced in unread) must not look like a
        # miss when the next occurrence arrives. Best-effort, never blocks.
        try:
            from backend import recurrence as rec_mod
            rec_templates = rec_mod.load_templates()
            if rec_templates and rec_mod.credit_completions(
                current_file.read_text(encoding="utf-8"), rec_templates
            ):
                rec_mod.save_templates(rec_templates)
        except Exception:
            log.exception("recurrence credit at week close failed")

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

        # Funnel: this-week commitments that never completed have slipped
        slipped = _increment_bucket_slips()
        if slipped:
            transitions.append(f"{slipped} bucket item(s) slipped")

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
            _vault_io.write_text_guarded(current_file, template)
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

    _vault_io.write_text_guarded(plan_file, "\n".join(lines))
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
        # Recurrence bookkeeping rides the same lazy seam (idempotent)
        from backend.recurrence import run_recurrence_pass
        run_recurrence_pass()
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
    _require_vault_not_newer()
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

    # Sync guard and the write itself both live in vault_io — see the module
    # docstring for why a truncating write on a synced vault is a data loss.
    # The guard is checked again inside write_text_guarded, against the mtime
    # at the moment of writing rather than the moment of parsing.
    if req.expected_mtime is not None:
        _vault_io.write_guard(plan_file, req.expected_mtime, what="Week file")

    original = _vault_io.read_text(plan_file)
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
    mtime = _vault_io.write_text_guarded(
        plan_file, "\n".join(new_lines), req.expected_mtime, what="Week file"
    )

    return {"status": "saved", "days": len(req.days), "mtime": mtime}


class ScheduleItemRequest(BaseModel):
    day: str
    text: str
    ref: str
    priority: str = "B"
    expected_mtime: Optional[float] = None


class BucketItemRequest(BaseModel):
    group: str
    text: str
    ref: str
    horizon: str = ""  # "" stays in the bucket · n this week · nw next · m month
    priority: str = "B"
    expected_mtime: Optional[float] = None


def _ref_already_placed(ref: str) -> Optional[str]:
    """The file already holding this ref — week or bucket — or None.

    One obligation must not become two lines, wherever they live: a row
    scheduled into the week cannot also be parked in the bucket, and one
    parked in the bucket cannot be scheduled again until it moves.
    """
    ref = ref.lower()
    for label, path in (
        ("a week line", config.vault_path / config.plan_week_file),
        ("the bucket", config.vault_path / config.plan_week_bucket_file),
    ):
        try:
            text = _vault_io.read_text(path, default="")
        except HTTPException:
            continue
        if any(m.group(1).lower() == ref for m in EXTERNAL_REF_RE.finditer(text)):
            return label
    return None


_REF_SHAPE_RE = re.compile(r"^[0-9a-f]{6,40}$", re.IGNORECASE)

_DAY_SYNONYMS = {
    "monday": {"monday", "mon"},
    "tuesday": {"tuesday", "tues", "tue"},
    "wednesday": {"wednesday", "wed"},
    "thursday": {"thursday", "thur", "thu"},
    "friday": {"friday", "fri"},
    "saturday": {"saturday", "sat"},
    "sunday": {"sunday", "sun"},
}


@router.post("/schedule-item")
async def schedule_item(req: ScheduleItemRequest):
    """Put one external item on a day of the current week — seam 5's write.

    An extension surface cannot write a week file, and must not: this route
    is the door instead. The line lands in the day's section through the
    same guarded write every other save uses, carrying the item's `~x`
    reference — scheduling is by reference, never a copy, so the source's
    staleness scan keeps seeing the row and the two never drift.

    A ref already on some week line is refused with 409: one obligation must
    not become two tasks. The ref travels in `ref`, never inline in `text`,
    so the dedupe check cannot be dodged by formatting.
    """
    day_word = (req.day or "").strip().lower()
    canonical = next((d for d, names in _DAY_SYNONYMS.items() if day_word in names), None)
    if canonical is None:
        raise HTTPException(status_code=400, detail=f"Unknown day: {req.day!r}")
    if not _REF_SHAPE_RE.match(req.ref or ""):
        raise HTTPException(status_code=400, detail="ref must be 6-40 hex characters")
    prio = (req.priority or "B").strip().upper()
    if prio not in {"A", "B", "C", "D"}:
        raise HTTPException(status_code=400, detail=f"Unknown priority: {req.priority!r}")
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is empty")
    if EXTERNAL_REF_RE.search(text):
        raise HTTPException(status_code=400, detail="carry the reference in `ref`, not in the text")

    plan_file = config.vault_path / config.plan_week_file
    if not plan_file.exists():
        raise HTTPException(status_code=404, detail="Plan Week.md not found in vault")

    placed = _ref_already_placed(req.ref)
    if placed:
        raise HTTPException(
            status_code=409,
            detail=f"that item is already on {placed} — one obligation, one task",
        )
    original = _vault_io.read_text(plan_file)
    ref = req.ref.lower()

    lines = original.split("\n")
    heading_re_local = re.compile(r"^#{3,6}\s+(.+)")

    day_idx = None
    for i, line in enumerate(lines):
        m = heading_re_local.match(line.strip())
        if not m:
            continue
        words = {w.strip("*_").lower() for w in m.group(1).split()}
        if words & _DAY_SYNONYMS[canonical]:
            day_idx = i
            break
    if day_idx is None:
        raise HTTPException(status_code=404, detail=f"No heading for {canonical} in Plan Week.md")

    # The section runs to the next heading of any kind or the notes rule.
    end = len(lines)
    for i in range(day_idx + 1, len(lines)):
        stripped = lines[i].strip()
        m = heading_re_local.match(stripped)
        if m or stripped == "* * *":
            end = i
            break

    # Land after the last task, not after the section's trailing blanks.
    insert_at = end
    while insert_at > day_idx + 1 and not lines[insert_at - 1].strip():
        insert_at -= 1

    # Sequence within the day's priority, same as a saved plan would carry.
    seq_re = re.compile(rf"^- \[.\] {prio}(\d*):")
    seq = sum(1 for l in lines[day_idx + 1 : insert_at] if seq_re.match(l.strip())) + 1

    new_line = f"- [ ] {prio}{seq}: {text} ~x{ref}"
    lines.insert(insert_at, new_line)
    mtime = _vault_io.write_text_guarded(
        plan_file, "\n".join(lines), req.expected_mtime, what="Week file"
    )
    return {"status": "scheduled", "day": canonical, "line": new_line, "mtime": mtime}


@router.post("/bucket-item")
async def bucket_item(req: BucketItemRequest):
    """Park one external item in the bucket with a GTD horizon — the other
    half of seam 5's write.

    The week door is for "this day"; this one is for "not yet": `n` this
    week, `nw` next week, `m` next month, or bare for the bucket's floor.
    The line lands under its group in the bucket's own grammar
    (`\t- nwB: text ~w<entered> ~x<ref>`), the group is created at the end
    when new, and the `~i` identity is left for the next bucket save to
    stamp, as it does for every line. Same dedupe as the week door, across
    both files: one obligation, one place.
    """
    horizon = (req.horizon or "").strip().lower()
    if horizon not in {"", "n", "nw", "m"}:
        raise HTTPException(status_code=400, detail=f"Unknown horizon: {req.horizon!r}")
    if not _REF_SHAPE_RE.match(req.ref or ""):
        raise HTTPException(status_code=400, detail="ref must be 6-40 hex characters")
    prio = (req.priority or "B").strip().upper()
    if prio not in {"A", "B", "C", "D"}:
        raise HTTPException(status_code=400, detail=f"Unknown priority: {req.priority!r}")
    group = (req.group or "").strip().rstrip(":")
    if not group or ":" in group:
        raise HTTPException(status_code=400, detail="group must be a plain, colon-free name")
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is empty")
    if EXTERNAL_REF_RE.search(text):
        raise HTTPException(status_code=400, detail="carry the reference in `ref`, not in the text")

    placed = _ref_already_placed(req.ref)
    if placed:
        raise HTTPException(
            status_code=409,
            detail=f"that item is already on {placed} — one obligation, one place",
        )

    bucket_file = config.vault_path / config.plan_week_bucket_file
    if not bucket_file.exists():
        raise HTTPException(status_code=404, detail="Bucket file not found in vault")
    original = _vault_io.read_text(bucket_file)

    iso = date.today().isocalendar()
    week_token = f"~w{iso[0] % 100:02d}{iso[1]:02d}"
    new_line = f"\t- {horizon}{prio}: {text} {week_token} ~x{req.ref.lower()}"

    lines = original.split("\n")
    group_line = f"- {group}:"
    start = next((i for i, l in enumerate(lines) if l.strip() == group_line), None)
    if start is None:
        while lines and not lines[-1].strip():
            lines.pop()
        lines.extend([group_line, new_line, ""])
    else:
        end = len(lines)
        for i in range(start + 1, len(lines)):
            s = lines[i]
            if s.strip() and not s.startswith(("\t", "  ")):
                end = i
                break
        insert_at = end
        while insert_at > start + 1 and not lines[insert_at - 1].strip():
            insert_at -= 1
        lines.insert(insert_at, new_line)

    mtime = _vault_io.write_text_guarded(
        bucket_file, "\n".join(lines), req.expected_mtime, what="Bucket file"
    )
    return {"status": "parked", "group": group, "horizon": horizon, "line": new_line.strip(), "mtime": mtime}


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
    _vault_io.write_text_guarded(next_file, content)

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

    # Funnel: this-week commitments that never completed have slipped
    _increment_bucket_slips()

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
        _vault_io.write_text_guarded(current_file, template)

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
    _vault_io.write_text_guarded(plan_file, new_content)


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

    _vault_io.write_text_guarded(plan_file, "\n".join(new_lines))
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
                " - " not in candidate and
                # tilde tokens (~w…, ~s:…) only ever appear on task lines —
                # a short ungrouped task with subtasks is not a group header
                "~" not in candidate
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
                    # Subtask of the last task ("? …" = the binding question)
                    if sub_text.startswith("? ") and not tasks[-1].question:
                        tasks[-1].question = sub_text[2:].strip()
                        continue
                    from backend.models import Subtask
                    tasks[-1].subtasks.append(Subtask(text=sub_text, done=False))
                    continue
                elif current_group:
                    # Indented item under a group = task in that group
                    pass  # fall through to task parsing below
                else:
                    # Single-indent subtask under ungrouped task
                    if sub_text.startswith("? ") and not tasks[-1].question:
                        tasks[-1].question = sub_text[2:].strip()
                        continue
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

        # Funnel tokens → fields (stripped from the stored text)
        text, funnel = _extract_funnel_meta(text)

        # Prepend group name to text
        full_text = f"{current_group}: {text}" if current_group else text

        # Migration default for items predating the funnel (no ~s: token):
        # anything the user had prioritised or given a horizon was de facto
        # schedulable → grandfather to ready; the rest is captured.
        if "stage" not in funnel:
            funnel["stage"] = "ready" if (priority or horizon) else "captured"

        tasks.append(BucketTask(
            text=full_text,
            priority=priority,
            horizon=horizon,
            focused=focused,
            waiting=waiting,
            **funnel,
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
            item = f"{item}{_funnel_tokens(task)}"
            indent = "\t" if group else ""
            lines.append(f"{indent}- {hz}{p}: {item}" if p else f"{indent}- {item}")
            question = (getattr(task, "question", "") or "").strip()
            if question:
                lines.append(f"{indent}\t- ? {question}")
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
    from backend.recurrence import run_recurrence_pass
    run_recurrence_pass()  # lazy, idempotent — same seam as week auto-transition
    bucket = _bucket_path()
    if not bucket.exists():
        return BucketResponse(tasks=[], pinned_groups=[], mtime=None)

    content = bucket.read_text(encoding="utf-8")
    tasks, pinned = _parse_bucket_file(content)
    # Learn inline group tags typed directly into the bucket file
    for task in tasks:
        task.text = _learn_and_clean_group_tag(task.text)
    # One-time id bootstrap: stamp identities on read so edits made from
    # this snapshot can never be mistaken for brand-new items by the save
    # gate (renaming an un-id'd item before its first save would otherwise
    # still trip a false stage transition).
    if any(not BUCKET_ID_RE.search(t.text) for t in tasks):
        for t in tasks:
            t.text = _stamp_bucket_id(t.text)
        try:
            _vault_io.write_text_guarded(bucket, _format_bucket_tasks(tasks, pinned))
        except OSError:
            pass  # read-only vault: ids still returned, just not persisted
    return BucketResponse(tasks=tasks, pinned_groups=pinned, mtime=bucket.stat().st_mtime)


def _funnel_log_path() -> Path:
    return config.vault_path / "Plan Week Funnel Log.md"


def _log_funnel_transitions(entries: list[tuple[str, str, str]]) -> None:
    """Append stage transitions to the funnel log (stage 6 diagnostics).

    Each entry: (from_stage, to_stage, label). System metrics only — the log
    records what the *system* did, never a score for the user.
    """
    if not entries:
        return
    path = _funnel_log_path()
    today = date.today().isoformat()
    lines = [f"- {today} {frm}->{to}: {label}" for frm, to, label in entries]
    try:
        if not path.exists():
            _vault_io.write_text_guarded(
                path,
                "# Funnel Log\n\nStage transitions, for the diagnostics view. "
                "Append-only; safe to prune old lines.\n\n" + "\n".join(lines) + "\n",
            )
        else:
            with open(path, "a", encoding="utf-8") as f:
                f.write("\n".join(lines) + "\n")
    except OSError:
        pass  # diagnostics never block a save


def _validate_funnel_save(incoming: list[BucketTask], on_disk: list[BucketTask]) -> list[tuple[str, str, str]]:
    """Enforce funnel invariants on a bucket save. Raises 422 on violation.
    Returns the list of detected transitions for the funnel log.

    Gates apply to *transitions*: an item whose stage differs from its on-disk
    twin (matched by normalized text) must satisfy the target stage's entry
    requirements. Items whose stage is unchanged pass through — that is what
    grandfathers pre-funnel items and hand-edited files instead of bricking
    every save. The WIP limit refuses any save that *grows* Shaping past the
    limit, so an over-limit state can always be reduced, never extended.
    Transition timestamps (stageEnteredAt, readySince) are stamped here.
    """
    today = date.today().isoformat()
    disk_by_key: dict[str, BucketTask] = {}
    for t in on_disk:
        disk_by_key.setdefault(_funnel_key(t.text), t)

    errors: list[str] = []
    transitions: list[tuple[str, str, str]] = []
    live_recurring: dict[str, int] = {}
    for t in incoming:
        label = _strip_bucket_meta(t.text) or "(untitled)"
        if t.stage not in FUNNEL_STAGES:
            errors.append(f"“{label}”: unknown stage '{t.stage}'")
            continue
        if t.mode not in ("solve", "rehearse"):
            errors.append(f"“{label}”: unknown mode '{t.mode}'")
        if t.recurrence_id:
            # A recurring copy never enters Shaping: the copy respawns, so
            # shaping it answers nothing — that thinking belongs on the
            # template (the review's template question). Captured is fine:
            # unsized templates spawn Captured copies that take the one-tap
            # size like any capture (Jan's call, 2026-07-30).
            if t.stage == "binding":
                errors.append(
                    f"“{label}”: a recurring copy can't enter Shaping — "
                    "edit its template instead"
                )
            if t.stage not in ("discarded",):
                live_recurring[t.recurrence_id] = live_recurring.get(t.recurrence_id, 0) + 1
                if live_recurring[t.recurrence_id] == 2:
                    errors.append(
                        f"“{label}”: only one live copy of a recurring task "
                        "can exist — the overdue pile is unrepresentable"
                    )
        prev = disk_by_key.get(_funnel_key(t.text))
        if prev is not None and prev.stage == t.stage:
            # No transition — no gate. Server-side stamps (stageEnteredAt,
            # readySince, slipCount) aren't echoed back to the client between
            # saves, so an unchanged item must not lose them to the client's
            # staler copy.
            if not t.stage_entered_at:
                t.stage_entered_at = prev.stage_entered_at
            if t.stage == "ready" and not t.ready_since:
                t.ready_since = prev.ready_since
            if not t.slip_count:
                t.slip_count = prev.slip_count
            continue
        # Entering a stage: stamp the transition date
        t.stage_entered_at = today
        transitions.append((prev.stage if prev else "(new)", t.stage, label))
        if t.stage == "binding":
            q = (t.question or "").strip()
            if len(q) < 2 or not q.endswith("?"):
                errors.append(
                    f"“{label}”: a Shaping item needs its question — "
                    "phrase what you're carrying, ending in '?'"
                )
        elif t.stage == "ready":
            # Ready = bounded = sized. A GTD-style task is its own next
            # action, so steps are optional (they matter on Binding exits,
            # where decomposition is the point) — Jan's call, 2026-07-27.
            if t.estimate not in ("s", "m", "l"):
                errors.append(f"“{label}”: Ready needs a size estimate (s/m/l)")
            if not t.ready_since:
                t.ready_since = today
        elif t.stage == "dormant":
            if not _ISO_DATE_RE.match(t.wake_date or ""):
                errors.append(f"“{label}”: Dormant needs a wake date")
        elif t.stage == "discarded":
            if t.discard_reason not in DISCARD_REASONS:
                errors.append(
                    f"“{label}”: Discarded needs a reason "
                    "(no_agency / already_decided / not_mine)"
                )
        if t.stage != "ready":
            t.ready_since = ""

    limit = config.binding_limit
    n_incoming = sum(1 for t in incoming if t.stage == "binding")
    n_disk = sum(1 for t in on_disk if t.stage == "binding")
    if n_incoming > limit and n_incoming > n_disk:
        errors.append(
            f"Shaping holds at most {limit} items — resolve one first "
            "(Ready, Dormant or Discarded)"
        )

    if errors:
        raise HTTPException(status_code=422, detail="; ".join(errors))
    return transitions


@router.post("/bucket/save")
async def save_bucket(req: BucketSaveRequest):
    """Write bucket tasks back to Bucket.md."""
    _require_current_schema(req.schema_version)
    bucket = _bucket_path()
    # Sync guard — see save_week_plan
    if req.expected_mtime is not None:
        _vault_io.write_guard(bucket, req.expected_mtime, what="Bucket file")
    # Funnel gates: compare against current disk state to detect transitions
    on_disk: list[BucketTask] = []
    if bucket.exists():
        on_disk, _ = _parse_bucket_file(_vault_io.read_text(bucket))
    transitions = _validate_funnel_save(req.tasks, on_disk)
    # Inline group teaching: learn "wallet@w:"-style tags and clean them.
    # Stamp entered-week metadata on tasks that don't carry it yet (age hint).
    for task in req.tasks:
        task.text = _stamp_bucket_tokens(_learn_and_clean_group_tag(task.text))
    md = _format_bucket_tasks(req.tasks, req.pinned_groups)
    mtime = _vault_io.write_text_guarded(bucket, md, req.expected_mtime, what="Bucket file")
    _log_funnel_transitions(transitions)
    _stamp_vault_schema()
    return {"status": "saved", "task_count": len(req.tasks), "mtime": mtime}


@router.post("/bucket/move")
async def move_bucket_task(req: BucketMoveRequest):
    """Atomically move a task between bucket and week plan."""
    _require_current_schema(req.schema_version)
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
        # Funnel: a task coming back from the week keeps its bound state if
        # it still has one (estimate token survives the week round-trip via
        # ~e: in the text, next actions are its subtasks); otherwise it is
        # unbounded and re-enters as captured. Horizon only means something
        # on a schedulable item.
        week_text, funnel = _extract_funnel_meta(task.text)
        estimate = funnel.get("estimate", "")
        # Bounded = sized (the task itself counts as its next action)
        is_bound = estimate in ("s", "m", "l")
        stage = "ready" if is_bound else "captured"
        today_iso = date.today().isoformat()
        new_bucket_task = BucketTask(
            text=_stamp_bucket_tokens(week_text),
            priority=task.priority or "C",
            horizon=req.horizon if (stage == "ready" and req.horizon in ("n", "nw", "m")) else "",
            focused=task.focused,
            waiting=task.waiting,
            subtasks=list(task.subtasks or []),
            stage=stage,
            estimate=estimate,
            ready_since=today_iso if stage == "ready" else "",
            stage_entered_at=today_iso,
            # A recurring instance keeps its designation and due date across
            # the round trip — losing ~r would orphan it from its template.
            recurrence_id=funnel.get("recurrence_id", ""),
            due_date=funnel.get("due_date", ""),
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

        btask = bucket_tasks[req.task_index]
        # The ready gate. This is the entire contract between Bucket and
        # Timing: only ready items are schedulable, by any route — while the
        # funnel is on. In Basic mode there are no stages at all (nothing is
        # written to the vault, nothing is shown), so a gate on a stage
        # nobody can set would just make the bucket unusable. The gate is
        # not softened when the funnel IS on: it still refuses, never warns.
        if config.funnel_enabled and btask.stage != "ready":
            raise HTTPException(
                status_code=400,
                detail="Only Ready items can be scheduled — give it a next "
                       "action and a size first",
            )
        bucket_tasks.pop(req.task_index)
        # Keep the estimate in the week line (~e: token) so it survives a
        # round-trip back to the bucket; subtasks are the next actions and
        # must survive the move too.
        week_text = _strip_bucket_meta(btask.text)
        if btask.estimate in ("s", "m", "l"):
            week_text = f"{week_text} ~e{btask.estimate}"
        # Recurrence designation rides the week line (colon-free tokens):
        # completion must credit the template, and the item must come back
        # from the week still recognisable as recurring.
        if btask.recurrence_id:
            week_text = f"{week_text} ~r{btask.recurrence_id}"
            if btask.due_date:
                week_text = f"{week_text} ~du{btask.due_date}"
        new_task = Task(
            text=week_text,
            # Unassigned bucket tasks default to C when they become plan tasks
            priority=btask.priority or "C",
            focused=btask.focused,
            waiting=btask.waiting,
            done=False,
            source_file=config.plan_week_bucket_file,
            subtasks=list(btask.subtasks or []),
        )
        plan_days[req.day_idx].tasks.append(new_task)
    else:
        raise HTTPException(status_code=400, detail="direction must be 'to_bucket' or 'from_bucket'")

    # Save both files
    bucket.parent.mkdir(parents=True, exist_ok=True)
    _vault_io.write_text_guarded(bucket, _format_bucket_tasks(bucket_tasks, pinned))

    # Save week plan — reuse save endpoint
    from backend.models import SaveWeekRequest
    await save_week_plan(SaveWeekRequest(days=plan_days, offset=req.week_offset))

    _stamp_vault_schema()
    return {"status": "moved", "direction": req.direction, "bucket_count": len(bucket_tasks)}


# ── Funnel: ambient slate + diagnostics ───────────────────────


class SlateCaptureRequest(BaseModel):
    text: str


def _is_evening() -> bool:
    """After the configurable evening cutoff (or before 05:00 — the pre-sleep
    window runs past midnight)."""
    from datetime import datetime
    now = datetime.now()
    cutoff = str(config.funnel.get("evening_cutoff") or "21:00")
    try:
        ch, cm = (int(x) for x in cutoff.split(":"))
    except ValueError:
        ch, cm = 21, 0
    mins = now.hour * 60 + now.minute
    return mins >= ch * 60 + cm or mins < 5 * 60


@router.get("/slate")
async def get_slate():
    """The ambient slate (funnel stage 5): the questions being carried,
    read-only, filtered by time of day. The filter is server-side on purpose —
    after the cutoff no `solve` item is reachable from this surface by any
    route, which is the acceptance criterion.
    """
    evening = _is_evening()
    items: list[dict] = []
    bucket = _bucket_path()
    if bucket.exists():
        tasks, _ = _parse_bucket_file(bucket.read_text(encoding="utf-8"))
        for t in tasks:
            if t.stage != "binding":
                continue
            if evening != (t.mode == "rehearse"):
                continue  # evening → rehearse only; daytime → solve only
            items.append({
                "question": t.question,
                "label": _strip_bucket_meta(t.text),
                "mode": t.mode,
            })
    return {
        "evening": evening,
        "cutoff": str(config.funnel.get("evening_cutoff") or "21:00"),
        "items": items,
    }


@router.post("/slate/capture")
async def slate_capture(req: SlateCaptureRequest):
    """Zero-friction capture from the slate — the one write it allows."""
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Nothing to capture")
    bucket = _bucket_path()
    tasks: list[BucketTask] = []
    pinned: list[str] = []
    if bucket.exists():
        tasks, pinned = _parse_bucket_file(bucket.read_text(encoding="utf-8"))
    tasks.append(BucketTask(
        text=_stamp_bucket_tokens(_learn_and_clean_group_tag(text)),
        stage="captured",
    ))
    bucket.parent.mkdir(parents=True, exist_ok=True)
    _vault_io.write_text_guarded(bucket, _format_bucket_tasks(tasks, pinned))
    return {"status": "captured"}


@router.get("/funnel/stats")
async def funnel_stats():
    """Funnel diagnostics (stage 6). System metrics only: time-in-stage, exit
    distribution from Binding, slip rate per group. Nothing here scores the
    user — slips and age-in-ready are reported separately and never summed.
    """
    tasks: list[BucketTask] = []
    bucket = _bucket_path()
    if bucket.exists():
        tasks, _ = _parse_bucket_file(bucket.read_text(encoding="utf-8"))
    today = date.today()

    def _days_since(iso: str) -> Optional[int]:
        try:
            return (today - date.fromisoformat(iso)).days
        except ValueError:
            return None

    stages: dict[str, dict] = {}
    for st in FUNNEL_STAGES:
        in_stage = [t for t in tasks if t.stage == st]
        ages = [d for t in in_stage if t.stage_entered_at
                for d in [_days_since(t.stage_entered_at)] if d is not None]
        stages[st] = {
            "count": len(in_stage),
            "avg_days_in_stage": round(sum(ages) / len(ages), 1) if ages else None,
        }

    ready_ages = [d for t in tasks if t.stage == "ready" and t.ready_since
                  for d in [_days_since(t.ready_since)] if d is not None]

    slip_by_group: dict[str, dict] = {}
    for t in tasks:
        if t.stage != "ready":
            continue
        # Recurring instances never carry slips (misses live on the template),
        # so counting them here would only deflate every group's slip rate.
        if t.recurrence_id:
            continue
        group, _ = _parse_group(t.text)
        g = group or "(ungrouped)"
        row = slip_by_group.setdefault(g, {"ready_items": 0, "slipped_items": 0, "total_slips": 0})
        row["ready_items"] += 1
        if t.slip_count:
            row["slipped_items"] += 1
            row["total_slips"] += t.slip_count

    binding_exits = {"ready": 0, "dormant": 0, "discarded": 0}
    log_path = _funnel_log_path()
    if log_path.exists():
        try:
            for m in re.finditer(r"binding->(ready|dormant|discarded)", log_path.read_text(encoding="utf-8")):
                binding_exits[m.group(1)] += 1
        except OSError:
            pass

    return {
        "stages": stages,
        "ready_age_days": {
            "avg": round(sum(ready_ages) / len(ready_ages), 1) if ready_ages else None,
            "max": max(ready_ages) if ready_ages else None,
        },
        "binding_exits": binding_exits,
        "slip_by_group": slip_by_group,
        "last_review": config.funnel.get("last_review") or "",
        "last_review_secs": int(config.funnel.get("last_review_secs") or 0),
    }


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

    _vault_io.write_text_guarded(plan_file, "\n".join(lines))
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

    _vault_io.write_text_guarded(plan_file, "\n".join(lines))
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


# ── Moving the plan folder ────────────────────────────────────────────
#
# One destination, deliberately. The settings file can only live where
# discovery looks for it (config.SETTINGS_SEARCH_FOLDERS) — a file cannot
# record its own location — so an arbitrary destination would strand it.
# 5-Meta is a container for tools rather than a PARA category, which is why
# the plan belongs there and the archive of finished weeks does not.

MOVE_DESTINATION = "5-Meta/Nowspace"


def _plan_folder_files(folder: Path) -> list[Path]:
    """Nowspace's own files in a folder, and nothing else.

    Everything here is a name Nowspace writes. Whatever else lives in the
    folder is the user's, and a move that took their notes with it would be
    unforgivable — so the list is by name, never "everything in the folder".
    """
    stem = config.plan_week_file.replace(".md", "")
    exact = {
        config.plan_week_file,
        config.plan_week_bucket_file,
        config.plan_week_habits_file,
        config.plan_week_recurring_file,
        SETTINGS_FILE_NAME,
        "Plan Week Funnel Log.md",
        README_NAME,
    }
    found: list[Path] = []
    if not folder.is_dir():
        return found
    for p in sorted(folder.iterdir()):
        if not p.is_file():
            continue
        if is_conflict_copy(p):
            continue
        if p.name in exact or _WEEK_COPY_RE.match(p.name) or _TIME_LOG_RE.match(p.name):
            found.append(p)
    return found


_TIME_LOG_RE = re.compile(r"^Time Log - \d{4}-\d{2}\.md$")
# Any "Plan Week - …" copy: next week's file, and the pre-dedupe style backup
# someone parks beside it. Both are Nowspace's to move.
_WEEK_COPY_RE = re.compile(re.escape(config.plan_week_file.replace('.md', '')) + r" - .+\.md$")


@router.post("/move-plan-folder")
async def move_plan_folder():
    """Move Nowspace's files to 5-Meta/Nowspace and record it in the vault.

    Order matters and is the whole safety argument: the files move first and
    the setting is written last, so a failure at any point leaves the vault
    exactly as it was — pointing at files that are still there. If the
    setting write fails after the files moved, they are moved back.
    """
    _require_vault_not_newer()

    src = config.vault_path
    dst = config.vault_root / MOVE_DESTINATION
    if src.resolve() == dst.resolve():
        return {"status": "already-there", "folder": MOVE_DESTINATION, "moved": []}

    files = _plan_folder_files(src)
    if not files:
        raise HTTPException(status_code=404, detail=f"No Nowspace files found in {src}")

    # A conflict copy anywhere in either folder means a sync is unresolved.
    # Moving now is how the resolution gets lost.
    for folder in (src, dst):
        if folder.is_dir():
            unresolved = [p.name for p in folder.iterdir() if is_conflict_copy(p)]
            if unresolved:
                raise HTTPException(
                    status_code=409,
                    detail=("Unresolved sync conflicts here — resolve them before moving: "
                            + ", ".join(sorted(unresolved)[:5])),
                )

    collisions = [f.name for f in files if (dst / f.name).exists()]
    if collisions:
        raise HTTPException(
            status_code=409,
            detail=f"{MOVE_DESTINATION} already has: " + ", ".join(sorted(collisions)),
        )

    moved: list[tuple[Path, Path]] = []
    try:
        dst.mkdir(parents=True, exist_ok=True)
        for f in files:
            target = dst / f.name
            shutil.move(str(f), str(target))
            moved.append((f, target))
        # The settings file has moved with the rest; discovery finds it in its
        # new home, so this writes the setting where it now lives.
        config._vault_cfg_cache = None
        config._vault_cfg_mtime = None
        config.save_plan_folder(MOVE_DESTINATION)
    except Exception as exc:
        for original, now in reversed(moved):
            try:
                shutil.move(str(now), str(original))
            except OSError:
                pass
        config._vault_cfg_cache = None
        config._vault_cfg_mtime = None
        raise HTTPException(status_code=500, detail=f"Move failed and was undone: {exc}")

    plan_readme.ensure()
    return {
        "status": "moved",
        "folder": MOVE_DESTINATION,
        "from": str(src.relative_to(config.vault_root)),
        "moved": [f.name for _, f in moved],
    }
