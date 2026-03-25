"""In-memory session state management."""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from backend.models import Task


@dataclass
class Session:
    session_id: str
    tasks: list[Task] = field(default_factory=list)
    approved: bool = False
    coach_messages: list[dict] = field(default_factory=list)
    complete: bool = False


_sessions: dict[str, Session] = {}


def create_session(tasks: list[Task]) -> Session:
    sid = str(uuid.uuid4())
    session = Session(session_id=sid, tasks=tasks)
    _sessions[sid] = session
    return session


def get_session(session_id: str) -> Optional[Session]:
    return _sessions.get(session_id)


def clear_session(session_id: str) -> None:
    _sessions.pop(session_id, None)
