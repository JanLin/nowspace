from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel


class Subtask(BaseModel):
    text: str
    done: bool = False


class Task(BaseModel):
    text: str
    done: bool = False
    source_file: str = ""
    context: str = ""  # "day", "weekend", or ""
    tags: List[str] = []
    priority: str = ""  # "A", "B", "C" — set by prioritiser
    pillars: List[str] = []  # pillar names this task serves
    subtasks: List[Subtask] = []


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


class SaveWeekRequest(BaseModel):
    days: List[DayTasks]
