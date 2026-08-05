"""Recurring task templates: one live copy at a time, misses on the template.

A template is a standing, already-bound definition of a repeating obligation
(the credit bill, the home chore, the customer visit). It materialises as an
ordinary `ready` bucket item carrying a `recurrence_id` back-link — never as
captured or binding, because the binding decision was made once, at template
creation, behind the same gate as binding → ready.

Storage is `Plan Week Recurring.md`: one `## title` block per template with
`- key: value` lines, split at the FIRST colon on a known-key whitelist so
values (a next action, a note name) may contain colons and commas — the
reason the Habits one-liner grammar is not reused. Unknown lines inside a
block are preserved verbatim on rewrite, so a newer instance's fields
round-trip through this backend unharmed (Syncthing version skew).

Spawning is a lazy pass on read, same shape as the week auto-transition:
idempotence comes from on-disk state, never a "last ran" timestamp. Each
template records the last *handled* occurrence (`spawned`); walking the
occurrences between that and today either spawns (no live instance) or, by
the no-stacking rule, records a miss on the template and moves the live
instance's due date forward. Instance identity is derived from
(template id, occurrence date), so two devices reaching the same date
offline write byte-identical lines and Syncthing's pick can't fork state.

Misses accrue on the template, never on the person: `missed` exists to
trigger one question in the weekly review and to reset. No streaks, no
badges, no notifications — the review is the only surface that ever
mentions a miss.
"""

import hashlib
import re
from datetime import date, timedelta
from pathlib import Path
from typing import List, Optional

from pydantic import BaseModel, ConfigDict

from backend.config import config

TEMPLATE_STATES = ("active", "paused", "retired")

# Three consecutive misses trigger the template question in the review —
# two can be circumstance, three is a pattern. Same constant, same
# reasoning, as the funnel's slip threshold (also hardcoded).
MISS_THRESHOLD = 3

_WEEKDAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")

# An optional "N-" prefix sets the cadence: "2-weekly on thu" = Thursday
# every second week, "3-monthly on 25" = the 25th every third month. Which
# weeks/months are "on" is anchored by the spawned ledger (parity from the
# last handled occurrence), so editing the schedule re-anchors cleanly.
REPEAT_MONTHLY_RE = re.compile(r"^(?:(\d{1,2})-)?monthly\s+on\s+(\d{1,2})$", re.IGNORECASE)
# Bare "weekly" = comes up that week with no preferred day (no due date)
REPEAT_WEEKLY_RE = re.compile(r"^(?:(\d{1,2})-)?weekly(?:\s+on\s+((?:\w{3}\s*)+))?$", re.IGNORECASE)
REPEAT_INTERVAL_RE = re.compile(r"^every\s+(\d{1,3})\s*([wd])$", re.IGNORECASE)
_ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# Block keys written by this backend. Anything else round-trips via `extra`.
_KNOWN_KEYS = (
    "id", "repeat", "size", "group", "next", "note", "state",
    "created", "spawned", "last-done", "missed", "deferred",
)

FILE_HEADER = """# Recurring

One block per repeating obligation. If missing it creates debt someone can
collect, it's a recurring task and belongs here; if missing it only breaks
a pattern, it's a habit and belongs in Plan Week Habits.md.

Repeat vocabulary: "monthly on 25", "weekly on mon" (or "mon thu"),
plain "weekly" (comes up that week, no set day), an "N-" cadence prefix
("2-weekly on thu", "3-monthly on 25"), and "every 6w" / "every 45d"
(measured from the last completion).
"""


class RecurrenceTemplate(BaseModel):
    model_config = ConfigDict(extra="forbid")  # same skew guard as BucketTask

    id: str = ""            # 6 hex, stable
    title: str = ""
    repeat: str = ""        # raw vocabulary, see FILE_HEADER
    size: str = ""          # s | m | l — required (this IS the ready gate)
    group: str = ""         # bucket group instances spawn into ("" = ungrouped)
    next_action: str = ""   # first concrete action; required for interval
    note: str = ""          # wikilink target of the how-to note
    state: str = "active"   # active | paused | retired
    created: str = ""       # ISO date, stamped at creation
    spawned: str = ""       # last HANDLED occurrence date (calendar ledger)
    last_done: str = ""     # ISO date an instance last completed
    missed: int = 0         # consecutive misses; resets on completion
    deferred: str = ""      # interval: hidden from the review until this date
    extra: List[str] = []   # unknown block lines, preserved verbatim


def parse_repeat(repeat: str) -> Optional[dict]:
    """Parse the repeat vocabulary. None = unparseable."""
    r = (repeat or "").strip()
    m = REPEAT_MONTHLY_RE.match(r)
    if m:
        every = int(m.group(1)) if m.group(1) else 1
        day = int(m.group(2))
        if 1 <= day <= 31 and 1 <= every <= 12:
            return {"kind": "monthly", "day": day, "every": every}
        return None
    m = REPEAT_WEEKLY_RE.match(r)
    if m:
        every = int(m.group(1)) if m.group(1) else 1
        if not 1 <= every <= 52:
            return None
        if not m.group(2):
            return {"kind": "weekly", "weekdays": [], "every": every}
        days = []
        for w in m.group(2).split():
            wl = w.lower()[:3]
            if wl not in _WEEKDAYS:
                return None
            idx = _WEEKDAYS.index(wl)
            if idx not in days:
                days.append(idx)
        return {"kind": "weekly", "weekdays": sorted(days), "every": every} if days else None
    m = REPEAT_INTERVAL_RE.match(r)
    if m:
        n = int(m.group(1))
        if n < 1:
            return None
        return {"kind": "interval", "days": n * 7 if m.group(2).lower() == "w" else n}
    return None


def is_interval(t: RecurrenceTemplate) -> bool:
    parsed = parse_repeat(t.repeat)
    return bool(parsed and parsed["kind"] == "interval")


# ── File store ─────────────────────────────────────────────────

def recurring_path() -> Path:
    return config.vault_path / config.plan_week_recurring_file


_KV_RE = re.compile(r"^-\s+([a-z-]+):\s*(.*)$")


def parse_recurring_file(content: str) -> List[RecurrenceTemplate]:
    """Parse Plan Week Recurring.md. Tolerant: junk lines are preserved in
    the owning block's `extra`; a block without an id gets none stamped here
    (the save route stamps ids — a hand-added block gains one on next save)."""
    templates: List[RecurrenceTemplate] = []
    current: Optional[RecurrenceTemplate] = None
    for line in content.split("\n"):
        stripped = line.strip()
        if stripped.startswith("## "):
            current = RecurrenceTemplate(title=stripped[3:].strip())
            templates.append(current)
            continue
        if current is None:
            continue  # file header prose
        if not stripped:
            continue
        m = _KV_RE.match(stripped)
        key = m.group(1).lower() if m else None
        if m and key in _KNOWN_KEYS:
            val = m.group(2).strip()
            if key == "id":
                current.id = val.lower()
            elif key == "repeat":
                current.repeat = val
            elif key == "size":
                current.size = val.lower()
            elif key == "group":
                current.group = val
            elif key == "next":
                current.next_action = val
            elif key == "note":
                current.note = val.strip().removeprefix("[[").removesuffix("]]").strip()
            elif key == "state":
                current.state = val.lower() if val.lower() in TEMPLATE_STATES else "active"
            elif key == "created":
                current.created = val if _ISO_RE.match(val) else ""
            elif key == "spawned":
                current.spawned = val if _ISO_RE.match(val) else ""
            elif key == "last-done":
                current.last_done = val if _ISO_RE.match(val) else ""
            elif key == "missed":
                current.missed = int(val) if val.isdigit() else 0
            elif key == "deferred":
                current.deferred = val if _ISO_RE.match(val) else ""
        else:
            current.extra.append(stripped)
    return templates


def format_recurring_file(templates: List[RecurrenceTemplate]) -> str:
    lines = [FILE_HEADER]
    for t in templates:
        lines.append(f"## {t.title.strip()}")
        if t.id:
            lines.append(f"- id: {t.id}")
        lines.append(f"- repeat: {t.repeat.strip()}")
        if t.size:
            lines.append(f"- size: {t.size}")
        if t.group.strip():
            lines.append(f"- group: {t.group.strip()}")
        if t.next_action.strip():
            lines.append(f"- next: {t.next_action.strip()}")
        if t.note.strip():
            lines.append(f"- note: [[{t.note.strip()}]]")
        lines.append(f"- state: {t.state}")
        if t.created:
            lines.append(f"- created: {t.created}")
        if t.spawned:
            lines.append(f"- spawned: {t.spawned}")
        if t.last_done:
            lines.append(f"- last-done: {t.last_done}")
        if t.missed:
            lines.append(f"- missed: {t.missed}")
        if t.deferred:
            lines.append(f"- deferred: {t.deferred}")
        for x in t.extra:
            lines.append(x)
        lines.append("")
    return "\n".join(lines)


def load_templates() -> List[RecurrenceTemplate]:
    path = recurring_path()
    if not path.exists():
        return []
    try:
        return parse_recurring_file(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError):
        return []


def save_templates(templates: List[RecurrenceTemplate]) -> None:
    recurring_path().write_text(format_recurring_file(templates), encoding="utf-8")


# ── Occurrences ────────────────────────────────────────────────

def _month_occurrence(year: int, month: int, day: int) -> date:
    """Day-of-month clamped to the month's end (31st → Feb 28)."""
    if month == 12:
        last = 31
    else:
        last = (date(year, month + 1, 1) - timedelta(days=1)).day
    return date(year, month, min(day, last))


def occurrences_between(parsed: dict, after: date, until: date) -> List[date]:
    """Calendar occurrence dates d with after < d <= until, oldest first.

    `after` doubles as the cadence anchor for every-N schedules: the weeks
    (Monday-aligned) or months that are "on" are those a multiple of N from
    it. The ledger walk hands each handled occurrence back in as the next
    anchor, so parity is stable across runs and devices."""
    if until <= after:
        return []
    every = parsed.get("every", 1)
    out: List[date] = []
    if parsed["kind"] == "monthly":
        anchor_mi = after.year * 12 + (after.month - 1)
        y, m = after.year, after.month
        for _ in range(0, (until.year - after.year) * 12 + (until.month - after.month) + 1):
            if ((y * 12 + (m - 1)) - anchor_mi) % every == 0:
                occ = _month_occurrence(y, m, parsed["day"])
                if after < occ <= until:
                    out.append(occ)
            m += 1
            if m > 12:
                y, m = y + 1, 1
    elif parsed["kind"] == "weekly":
        # No preferred day = the week itself is the occurrence; anchor on
        # Monday so every device derives the same occurrence key.
        weekdays = parsed["weekdays"] or [0]
        anchor_monday = after - timedelta(days=after.weekday())
        d = after + timedelta(days=1)
        while d <= until:
            if d.weekday() in weekdays:
                monday = d - timedelta(days=d.weekday())
                if ((monday - anchor_monday).days // 7) % every == 0:
                    out.append(d)
            d += timedelta(days=1)
    return out


def is_day_specific(parsed: Optional[dict]) -> bool:
    """Does this schedule name an actual date (→ instances carry ~du)?
    Plain "weekly" only promises the week, so its copies get no date."""
    if not parsed or parsed["kind"] == "interval":
        return False
    return parsed["kind"] == "monthly" or bool(parsed.get("weekdays"))


def instance_identity(template_id: str, occurrence: str) -> str:
    """Derived, not random: two devices spawning the same occurrence write
    byte-identical lines, so sync conflict resolution can't fork state.

    usedforsecurity=False says what this is: a short stable name, not a
    security digest. It does not change the bytes SHA-1 produces, so existing
    ~i tokens in every synced vault stay valid — that must remain true.
    """
    return hashlib.sha1(
        f"{template_id}|{occurrence}".encode(), usedforsecurity=False
    ).hexdigest()[:6]


def lapsed(t: RecurrenceTemplate, today: date) -> bool:
    """Interval template whose time has come round (weekly-review surface)."""
    parsed = parse_repeat(t.repeat)
    if not parsed or parsed["kind"] != "interval" or t.state != "active":
        return False
    if t.deferred and t.deferred > today.isoformat():
        return False
    anchor = t.last_done or t.created
    if not anchor:
        return False
    return (today - date.fromisoformat(anchor)).days >= parsed["days"]


# ── The lazy pass ──────────────────────────────────────────────
# Called from bucket/week reads (same seam as the week auto-transition).
# Everything below is idempotent: re-running against unchanged files is a
# no-op, and the pass never writes a file it didn't change.

def _week_files() -> List[Path]:
    """Current + future week files (where a live instance can be scheduled)."""
    files = []
    current = config.vault_path / config.plan_week_file
    if current.exists():
        files.append(current)
    base = config.plan_week_file.replace(".md", "")
    for p in sorted(config.vault_path.glob(f"{base} - *.md")):
        if ".sync-conflict-" not in p.name:
            files.append(p)
    return files


_CHECKED_RE = re.compile(r"^\s*[-*]\s+\[[xX]\]")


def _live_in_week_line(line: str, template_id: str) -> bool:
    return f"~r{template_id}" in line and not _CHECKED_RE.match(line)


def _find_live_instances(bucket_tasks: list, week_paths: List[Path]) -> dict:
    """template_id → list of ("bucket", task) / ("week", path) live holders."""
    live: dict = {}
    for t in bucket_tasks:
        rid = getattr(t, "recurrence_id", "")
        if rid and t.stage not in ("discarded",):
            live.setdefault(rid, []).append(("bucket", t))
    rid_re = re.compile(r"~r([0-9a-f]{6})\b")
    for p in week_paths:
        try:
            for line in p.read_text(encoding="utf-8").split("\n"):
                m = rid_re.search(line)
                if m and not _CHECKED_RE.match(line):
                    live.setdefault(m.group(1).lower(), []).append(("week", p))
        except (OSError, UnicodeDecodeError):
            continue
    return live


def _move_week_due_date(path: Path, template_id: str, new_due: str) -> None:
    """Rewrite ~du on the live instance's week line in place (raw line edit —
    a full parse/serialize would reformat a file the user also hand-edits)."""
    try:
        content = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return
    out = []
    for line in content.split("\n"):
        if _live_in_week_line(line, template_id):
            if re.search(r"~du\d{4}-\d{2}-\d{2}", line):
                line = re.sub(r"~du\d{4}-\d{2}-\d{2}", f"~du{new_due}", line)
            else:
                line = f"{line.rstrip()} ~du{new_due}"
        out.append(line)
    new_content = "\n".join(out)
    if new_content != content:
        path.write_text(new_content, encoding="utf-8")


def credit_completions(content: str, templates: List[RecurrenceTemplate],
                       today: Optional[date] = None) -> bool:
    """Checked week lines carrying ~r credit their template: last-done set,
    missed reset. Idempotent — a template already credited today is left
    alone. Returns True if any template changed."""
    today = today or date.today()
    today_iso = today.isoformat()
    by_id = {t.id: t for t in templates if t.id}
    changed = False
    rid_re = re.compile(r"~r([0-9a-f]{6})\b")
    for line in content.split("\n"):
        if not _CHECKED_RE.match(line):
            continue
        m = rid_re.search(line)
        if not m:
            continue
        t = by_id.get(m.group(1).lower())
        if t and (t.last_done < today_iso or t.missed or t.deferred):
            t.last_done = today_iso
            t.missed = 0
            t.deferred = ""
            changed = True
    return changed


def build_instance_task(t: RecurrenceTemplate, occurrence_iso: str, with_due: bool):
    """An ordinary BucketTask carrying the recurrence designation.
    Identity is derived from (template, occurrence) — see instance_identity.

    Sized templates spawn Ready with horizon n (the copy is for this week /
    this date) — the sanctioned bypass, safe because the size WAS the ready
    gate. An unsized template's copies arrive as plain Captured and take the
    one-tap size like any capture: size stays a funnel matter, and only
    Ready is schedulable, so an unsized copy can't carry a horizon (Jan's
    call, 2026-07-30)."""
    from backend.models import BucketTask, Subtask
    from backend.routers.plan import _stamp_bucket_week

    label = f"{t.group.strip()}: {t.title.strip()}" if t.group.strip() else t.title.strip()
    if t.note.strip():
        label = f"{label} [[{t.note.strip()}]]"
    sized = t.size in ("s", "m", "l")
    return BucketTask(
        text=_stamp_bucket_week(f"{label} ~i{instance_identity(t.id, occurrence_iso)}"),
        stage="ready" if sized else "captured",
        estimate=t.size if sized else "",
        priority="C" if sized else "",
        horizon="n" if sized else "",
        recurrence_id=t.id,
        due_date=occurrence_iso if with_due else "",
        ready_since=occurrence_iso if sized else "",
        stage_entered_at=occurrence_iso,
        subtasks=[Subtask(text=t.next_action.strip())] if t.next_action.strip() else [],
    )


def has_live_instance(template_id: str) -> bool:
    """Any live copy in the bucket or a current/future week file?"""
    from backend.routers.plan import _bucket_path, _parse_bucket_file

    bucket = _bucket_path()
    tasks: list = []
    if bucket.exists():
        try:
            tasks, _ = _parse_bucket_file(bucket.read_text(encoding="utf-8"))
        except Exception:
            return True  # unreadable bucket: assume live, never double-spawn
    return template_id in _find_live_instances(tasks, _week_files())


def run_recurrence_pass() -> None:
    """Spawn due calendar occurrences, apply the no-stacking rule, credit
    completions, repair one-live-instance violations that arrived over sync.

    Best-effort: recurrence bookkeeping must never break a bucket/week read,
    so callers get exceptions swallowed (same posture as the funnel log).
    """
    if not config.funnel_enabled:
        return  # Basic mode has no stages for instances to be born into
    try:
        _run_recurrence_pass()
    except Exception:  # noqa: BLE001 — a read must never 500 on bookkeeping
        import logging
        logging.getLogger("plan.recurrence").exception("recurrence pass failed")


def _run_recurrence_pass() -> None:
    # Local import: plan.py imports nothing from here at module level, this
    # module owns the dependency direction (recurrence → plan helpers).
    from backend.routers.plan import (
        _bucket_path, _format_bucket_tasks, _parse_bucket_file,
    )

    templates = load_templates()
    if not templates:
        return
    today = date.today()
    templates_changed = False

    bucket = _bucket_path()
    bucket_tasks: list = []
    pinned: list = []
    bucket_exists = bucket.exists()
    if bucket_exists:
        try:
            bucket_tasks, pinned = _parse_bucket_file(bucket.read_text(encoding="utf-8"))
        except Exception:
            return  # unreadable bucket: touch nothing
    bucket_changed = False

    week_paths = _week_files()

    # 1. Credit completions from the current week file
    current_week = config.vault_path / config.plan_week_file
    if current_week.exists():
        try:
            if credit_completions(current_week.read_text(encoding="utf-8"), templates, today):
                templates_changed = True
        except (OSError, UnicodeDecodeError):
            pass

    # 2. Repair: at most one live instance per template, by any route
    # including sync conflict resolution. Prefer a scheduled (week) copy over
    # a bucket copy; among bucket copies keep the first.
    live = _find_live_instances(bucket_tasks, week_paths)
    for rid, holders in live.items():
        if len(holders) <= 1:
            continue
        week_held = any(kind == "week" for kind, _ in holders)
        keep_used = week_held  # a week copy wins; else keep the first bucket copy
        for kind, ref in holders:
            if kind != "bucket":
                continue
            if not keep_used:
                keep_used = True
                continue
            bucket_tasks.remove(ref)
            bucket_changed = True
    if bucket_changed:
        live = _find_live_instances(bucket_tasks, week_paths)

    # 3. Walk unhandled occurrences per active calendar template
    for t in templates:
        if t.state != "active" or not t.id:
            continue
        parsed = parse_repeat(t.repeat)
        if not parsed or parsed["kind"] == "interval":
            continue  # interval templates materialise only through the review
        ledger = t.spawned or (today - timedelta(days=1)).isoformat()
        for occ in occurrences_between(parsed, date.fromisoformat(ledger), today):
            occ_iso = occ.isoformat()
            holders = live.get(t.id, [])
            if holders:
                # No stacking: the open copy keeps the obligation, its date
                # moves forward, and the miss lands on the template —
                # invisible outside the weekly review.
                t.missed += 1
                for kind, ref in holders:
                    if kind == "bucket":
                        ref.due_date = occ_iso
                        bucket_changed = True
                    else:
                        _move_week_due_date(ref, t.id, occ_iso)
            else:
                new_task = build_instance_task(t, occ_iso, with_due=is_day_specific(parsed))
                bucket_tasks.append(new_task)
                bucket_changed = True
                live.setdefault(t.id, []).append(("bucket", new_task))
            t.spawned = occ_iso
            templates_changed = True

    if bucket_changed:
        bucket.parent.mkdir(parents=True, exist_ok=True)
        bucket.write_text(_format_bucket_tasks(bucket_tasks, pinned), encoding="utf-8")
    if templates_changed:
        save_templates(templates)
