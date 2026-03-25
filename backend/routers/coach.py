"""Coaching endpoints: start and continue coaching conversation."""

import json
import logging

from fastapi import APIRouter, HTTPException

from backend.agents.coach import start_coaching, continue_coaching
from backend.config import config
from backend.models import CoachRequest, CoachRespondRequest, CoachResponse, PillarBalance
from backend.session import get_session
from backend.utils.memory_manager import read_memory, append_weekly_log, update_pillar_balance

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/coach", tags=["coach"])


@router.post("", response_model=CoachResponse)
async def start_coach(req: CoachRequest):
    """Start coaching session with approved plan."""
    session = get_session(req.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")
    if not session.approved:
        raise HTTPException(status_code=400, detail="Plan must be approved first")

    memory = read_memory(config.memory_path)
    message, history = await start_coaching(session.tasks, memory)
    session.coach_messages = history

    return CoachResponse(
        session_id=req.session_id,
        message=message,
        session_complete=False,
    )


@router.post("/respond", response_model=CoachResponse)
async def respond_coach(req: CoachRespondRequest):
    """Continue coaching conversation."""
    session = get_session(req.session_id)
    if not session:
        raise HTTPException(status_code=404, detail="Session not found")

    message, history, is_complete, summary_json = await continue_coaching(
        req.message, session.coach_messages
    )
    session.coach_messages = history

    if is_complete:
        session.complete = True
        _save_coaching_summary(summary_json)

    return CoachResponse(
        session_id=req.session_id,
        message=message,
        session_complete=is_complete,
    )


def _save_coaching_summary(summary_text: str) -> None:
    """Parse structured coaching summary and save to memory."""
    try:
        # Strip markdown code blocks if present
        text = summary_text.strip()
        if text.startswith("```"):
            text = text.split("```")[1]
            if text.startswith("json"):
                text = text[4:]
            text = text.strip()

        data = json.loads(text)
    except (json.JSONDecodeError, IndexError):
        # Fallback: save raw text
        logger.warning("Could not parse coaching summary as JSON, saving raw")
        append_weekly_log(config.memory_path, f"- Coaching notes: {summary_text[:500]}")
        return

    # Build structured log entry
    lines = []

    completed = data.get("completed", [])
    if completed:
        lines.append("- Completed:")
        for item in completed:
            lines.append(f"  - {item}")

    notes = data.get("notes", [])
    if notes:
        lines.append("- Notes:")
        for note in notes:
            lines.append(f"  - {note}")

    coaching_q = data.get("coaching_q", "")
    if coaching_q:
        lines.append(f"- Coaching Q: {coaching_q}")

    response_summary = data.get("response_summary", "")
    if response_summary:
        lines.append(f"- Response: {response_summary}")

    if lines:
        append_weekly_log(config.memory_path, "\n".join(lines))

    # Update pillar scores if provided
    pillar_updates = data.get("pillar_updates", {})
    if pillar_updates:
        memory = read_memory(config.memory_path)
        current_balances = memory.get("pillar_balance", [])
        balance_map = {
            (b.name if isinstance(b, PillarBalance) else b["name"]): b
            for b in current_balances
        }

        updated = []
        for b in current_balances:
            name = b.name if isinstance(b, PillarBalance) else b["name"]
            score = b.score if isinstance(b, PillarBalance) else b["score"]
            if name in pillar_updates:
                score = int(pillar_updates[name])
            updated.append(PillarBalance(name=name, score=score))

        update_pillar_balance(config.memory_path, updated)
