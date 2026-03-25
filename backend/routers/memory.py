"""Memory endpoints: read and update memory file."""

from fastapi import APIRouter

from backend.config import config
from backend.models import MemoryUpdateRequest
from backend.utils.memory_manager import read_memory, append_weekly_log

router = APIRouter(prefix="/memory", tags=["memory"])


@router.get("")
async def get_memory():
    """Return current memory file content."""
    memory = read_memory(config.memory_path)
    return {
        "pillars": memory["pillars"],
        "pillar_balance": [b.model_dump() for b in memory["pillar_balance"]],
        "patterns": memory["patterns"],
        "goals": memory["goals"],
        "weekly_log": memory["weekly_log"],
    }


@router.post("/update")
async def update_memory(req: MemoryUpdateRequest):
    """Write session summary to weekly log."""
    if req.summary:
        append_weekly_log(config.memory_path, f"- Notes: {req.summary}")
    return {"status": "updated"}
