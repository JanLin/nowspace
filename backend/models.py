from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel, ConfigDict


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


class BucketResponse(BaseModel):
    tasks: List[BucketTask] = []
    pinned_groups: List[str] = []
    mtime: Optional[float] = None  # file mtime, for the save conflict guard


class BucketSaveRequest(BaseModel):
    tasks: List[BucketTask] = []
    pinned_groups: List[str] = []
    expected_mtime: Optional[float] = None  # sync guard, same as SaveWeekRequest


class BucketMoveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")  # same skew guard as BucketTask

    task_index: int  # index in source list
    direction: str  # "to_bucket" or "from_bucket"
    day_idx: int = 0  # which day in week plan (0=Mon .. 6=Sun)
    week_offset: int = 0  # which week file
    horizon: str = ""  # to_bucket only: park at "n" | "nw" | "m" (empty = plain bucket)


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
