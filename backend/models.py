from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel, ConfigDict

# Bucket wire-format version. Bump whenever BucketTask gains fields whose
# absence in a write would lose data (an old client omits them and the
# defaults would overwrite real state — the funnel fields, for instance).
# Writes carry the sender's version; the backend refuses older senders, and
# the frontend refuses to edit against an older backend. Both directions of
# version skew then fail loudly instead of silently flattening the vault.
#   1 = pre-funnel · 2 = funnel (stage/question/mode/estimate/…)
#   3 = recurrence (recurrence_id/due_date)
#
# VERSIONING POLICY: this constant moves only with a MINOR app release
# (0.4 → 0.5), never in a patch. Patch releases (0.x.y) must keep the
# format unchanged, so mixed patch levels interoperate freely and
# upgrading is optional; a schema bump is what makes an upgrade mandatory
# across every instance. Bump the two together, or not at all.
# 4: the plan folder is a vault setting (plan.folder), so where these files
#    live is decided by the vault rather than by each installation. The wire
#    format is unchanged — the bump exists so an installation too old to read
#    that setting refuses to write rather than carrying on in the folder it
#    knows, leaving two live week files for Syncthing to keep.
BUCKET_SCHEMA_VERSION = 4


class Subtask(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str
    done: bool = False


class TaskLink(BaseModel):
    """A wiki link extracted from a task line."""
    name: str  # Note name from [[Note Name]]
    display_text: Optional[str] = None  # From [[Note Name|Display Text]]
    resolved_path: Optional[str] = None  # Resolved file path (None if unresolved)


class Task(BaseModel):
    text: str
    done: bool = False
    source_file: str = ""
    context: str = ""  # "day", "weekend", or ""
    tags: List[str] = []
    priority: str = ""  # "A", "B", "C" — set by prioritiser
    pillars: List[str] = []  # pillar names this task serves
    subtasks: List[Subtask] = []
    focused: bool = False  # True when task text is bold in Obsidian
    waiting: bool = False  # True when task is blocked/waiting on someone
    links: List[TaskLink] = []  # Wiki links extracted from task text
    clean_text: str = ""  # Task text with [[...]] stripped out


class PlanResponse(BaseModel):
    session_id: str
    date: str
    day_type: str  # "weekday" or "weekend"
    tasks: List[Task]
    completed: List[Task] = []
    carryover: List[Task] = []  # uncompleted tasks from previous days
    summary: str = ""


class ApproveRequest(BaseModel):
    session_id: str
    tasks: Optional[List[Task]] = None  # optional edits


class CoachRequest(BaseModel):
    session_id: str


class CoachRespondRequest(BaseModel):
    session_id: str
    message: str


class CoachResponse(BaseModel):
    session_id: str
    message: str
    session_complete: bool = False


class MemoryUpdateRequest(BaseModel):
    session_id: str
    summary: str = ""


class PillarBalance(BaseModel):
    name: str
    score: int


class DayTasks(BaseModel):
    day: str  # "monday", "tuesday", etc.
    heading: str = ""  # original heading, e.g. "##### Monday"
    tasks: List[Task] = []


class WeekPlanResponse(BaseModel):
    week_label: str  # "Week 2026-wk12"
    goals: List[str] = []
    days: List[DayTasks] = []  # 7 items, Mon-Sun
    is_future: bool = False  # True if week hasn't started yet
    offset: int = 0  # 0=current, -1=prev, 1=next
    is_archive: bool = False  # True for past weeks (read-only)


class SaveWeekRequest(BaseModel):
    days: List[DayTasks]
    offset: int = 0  # which week file to save to
    # Sync guard: file mtime the client last saw. If the file on disk is
    # newer (edited in Obsidian or synced in from another device), the save
    # is refused with 409 instead of clobbering. None = no check.
    expected_mtime: Optional[float] = None


class BucketTask(BaseModel):
    # extra="forbid": a save carrying fields this backend doesn't know means
    # the client is NEWER — accepting it would silently strip those fields
    # from every task and sync the loss to all devices (a stale Mac Mini
    # backend erased all horizon prefixes this way on 2026-07-17). Refusing
    # with 422 turns data loss into a visible "backend outdated" error.
    model_config = ConfigDict(extra="forbid")

    text: str  # full text including "Group: description"
    priority: str = ""  # A, B, C, D — empty = unassigned ("-" in the UI)
    horizon: str = ""   # "" (stays) | "n" this week | "nw" next week | "m" next month
    focused: bool = False
    waiting: bool = False
    subtasks: List[Subtask] = []
    # ── Funnel (bucket stages) ──────────────────────────────────
    # Persisted as tilde tokens on the line (see FUNNEL_META in plan.py);
    # "active"/"done" are never stored here — scheduled items live in the
    # week files, which is what those stages mean.
    stage: str = "captured"  # captured | binding | ready | dormant | discarded
    question: str = ""       # binding only; must end with "?"
    mode: str = "solve"      # solve | rehearse (meaningful on binding)
    estimate: str = ""       # "" | s | m | l — required to become ready
    slip_count: int = 0      # weeks committed (horizon n) but not completed
    ready_since: str = ""    # ISO date set on entry to ready
    wake_date: str = ""      # ISO date, required on dormant
    discard_reason: str = "" # no_agency | already_decided | not_mine
    stage_entered_at: str = ""  # ISO date, updated on every stage change
    # ── Recurrence (spawned instances of a template) ────────────
    # Presence of recurrence_id IS the designation: it routes week-close
    # misses to the template instead of slip_count, and bars the item from
    # captured/binding (binding happened once, at template creation).
    # Tokens ~r… / ~du… are colon-free because, unlike the rest of the
    # tilde family, they ride week lines too (see plan.py FUNNEL_META).
    recurrence_id: str = ""  # 6-hex template id; "" = not recurring
    due_date: str = ""       # ISO date, calendar instances only — a quiet
                             # fact, never an overdue signal


class BucketResponse(BaseModel):
    tasks: List[BucketTask] = []
    pinned_groups: List[str] = []
    mtime: Optional[float] = None  # file mtime, for the save conflict guard


class BucketSaveRequest(BaseModel):
    tasks: List[BucketTask] = []
    pinned_groups: List[str] = []
    expected_mtime: Optional[float] = None  # sync guard, same as SaveWeekRequest
    # Clients predating the funnel don't send this (default 1) and are
    # refused: their task objects lack the funnel fields, so accepting the
    # save would reset every stage/question to defaults.
    schema_version: int = 1


class BucketMoveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")  # same skew guard as BucketTask

    task_index: int  # index in source list
    direction: str  # "to_bucket" or "from_bucket"
    day_idx: int = 0  # which day in week plan (0=Mon .. 6=Sun)
    week_offset: int = 0  # which week file
    horizon: str = ""  # to_bucket only: park at "n" | "nw" | "m" (empty = plain bucket)
    schema_version: int = 1  # see BucketSaveRequest


class DayNotes(BaseModel):
    """Notes for a single day, from #### Notes section in Plan Week.md."""
    day: str  # "monday", "tuesday", etc.
    content: str = ""  # Raw markdown content for this day's notes
    groups: dict = {}  # Notes by group: {"iGrant": ["10:32 — ...", ...]}
    ungrouped: List[str] = []  # Notes not tied to a group
    wiki_links: List[str] = []  # All unique [[wiki links]] found


class WeekNotes(BaseModel):
    """All notes for the week, parsed from #### Notes block."""
    days: dict = {}  # Keyed by day name → DayNotes
    general: str = ""  # Legacy freeform notes not tied to a day


class VaultFile(BaseModel):
    """A file in the Obsidian vault index."""
    name: str
    path: str  # Relative to vault root
    folder: str
    section: str  # PARA section folder name
    modified: str = ""  # ISO timestamp
