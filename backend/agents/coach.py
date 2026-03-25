"""Component 3: Coaching agent using Claude API."""

from __future__ import annotations

import anthropic

from backend.config import config
from backend.models import Task


COACH_INITIAL_PROMPT = """Here is Jan's approved plan for today:

{plan}

## Memory Context
Patterns and traps:
{patterns}

Pillar balance (1-5, lower = needs attention):
{pillar_balance}

Long term goals:
{goals}

Recent weekly log:
{weekly_log}

---

Based on this plan and what you know about Jan's patterns, ask exactly ONE focused coaching question. Make it specific to today's plan and his known traps — not generic. Be direct and warm."""


COACH_SUMMARY_PROMPT = """Based on this coaching conversation, write a structured summary as JSON.

Return ONLY valid JSON with these fields:
{
  "completed": ["task or activity completed today", ...],
  "notes": ["key insight or commitment from coaching", "pacing decision or pattern observed", ...],
  "pillar_updates": {"pillar_name": score, ...},
  "coaching_q": "the question you asked",
  "response_summary": "brief summary of Jan's answer"
}

Rules:
- "completed" — list what Jan accomplished or worked on today
- "notes" — capture pacing decisions, commitments, observations about energy/motivation
- "pillar_updates" — ONLY include pillars whose score should change (1-5 scale). Use the full pillar names: "Social connection", "Recovery (without guilt)", "Purposeful play / tinkering", "Structured progress", "Long term goals"
- Keep each note concise (one line)
- Return ONLY the JSON, no markdown code blocks"""


def build_plan_text(tasks: list[Task]) -> str:
    """Format approved tasks into readable plan text."""
    lines = []
    for t in tasks:
        prefix = f"[{t.priority}]" if t.priority else "[-]"
        done = "x" if t.done else " "
        lines.append(f"{prefix} [{done}] {t.text}")
    return "\n".join(lines)


async def start_coaching(tasks: list[Task], memory: dict) -> tuple[str, list[dict]]:
    """Start a coaching session. Returns the first message and conversation history."""
    plan_text = build_plan_text(tasks)

    pillar_balance = memory.get("pillar_balance", [])
    balance_str = "\n".join(
        f"- {b['name'] if isinstance(b, dict) else b.name}: "
        f"{b['score'] if isinstance(b, dict) else b.score}"
        for b in pillar_balance
    ) or "No data"

    prompt = COACH_INITIAL_PROMPT.format(
        plan=plan_text,
        patterns="\n".join(f"- {p}" for p in memory.get("patterns", [])),
        pillar_balance=balance_str,
        goals="\n".join(f"- {g}" for g in memory.get("goals", [])),
        weekly_log=memory.get("weekly_log", "No entries yet")[-500:],  # Last 500 chars
    )

    client = anthropic.Anthropic()
    response = client.messages.create(
        model=config.model,
        max_tokens=config.max_tokens,
        system=config.system_prompt,
        messages=[{"role": "user", "content": prompt}],
    )

    assistant_msg = response.content[0].text
    messages = [
        {"role": "user", "content": prompt},
        {"role": "assistant", "content": assistant_msg},
    ]

    return assistant_msg, messages


async def continue_coaching(user_message: str, history: list[dict]) -> tuple[str, list[dict], bool, str]:
    """Continue the coaching conversation.

    Returns (user_message, updated_history, is_complete, summary_json).
    summary_json is non-empty only when session is complete.
    """
    history.append({"role": "user", "content": user_message})

    # Check if user wants to end the session
    user_end_signals = {"done", "thanks", "end", "bye", "that's it", "finish", "wrap up"}
    is_user_ending = any(signal in user_message.lower() for signal in user_end_signals)

    client = anthropic.Anthropic()

    if is_user_ending:
        return await _close_session(client, history)

    # Normal response — then check if the coach decided to wrap up
    response = client.messages.create(
        model=config.model,
        max_tokens=config.max_tokens,
        system=config.system_prompt,
        messages=history,
    )
    assistant_msg = response.content[0].text
    history.append({"role": "assistant", "content": assistant_msg})

    # Detect coach-initiated wrap-up
    if _coach_is_closing(assistant_msg):
        summary_json = await _generate_summary(client, history)
        return assistant_msg, history, True, summary_json

    return assistant_msg, history, False, ""


def _coach_is_closing(msg: str) -> bool:
    """Detect if the coach's response signals a session wrap-up."""
    lower = msg.lower()
    closing_phrases = [
        "end of session",
        "session summary",
        "wrapping up",
        "let's wrap",
        "go tick off",
        "go get started",
        "go tackle",
        "have a great day",
        "have a good day",
        "good luck today",
        "you've got this",
        "that's our session",
        "i'll log this",
        "logging this",
        "weekly notes",
        "weekly log",
    ]
    return any(phrase in lower for phrase in closing_phrases)


async def _generate_summary(client: anthropic.Anthropic, history: list[dict]) -> str:
    """Generate structured JSON summary from conversation history."""
    summary_history = history + [
        {"role": "user", "content": COACH_SUMMARY_PROMPT},
    ]
    summary_response = client.messages.create(
        model=config.model,
        max_tokens=config.max_tokens,
        system=config.system_prompt,
        messages=summary_history,
    )
    return summary_response.content[0].text


async def _close_session(client: anthropic.Anthropic, history: list[dict]) -> tuple[str, list[dict], bool, str]:
    """Generate closing message and summary for user-initiated end."""
    # First: warm closing message
    closing_history = history + [
        {"role": "user", "content": "Wrap up the session with a brief, warm closing message. Mention what was discussed and any commitments made. Keep it to 2-3 sentences."},
    ]
    closing_response = client.messages.create(
        model=config.model,
        max_tokens=config.max_tokens,
        system=config.system_prompt,
        messages=closing_history,
    )
    user_facing_msg = closing_response.content[0].text

    # Second: structured JSON summary
    summary_json = await _generate_summary(client, history)

    history.append({"role": "assistant", "content": user_facing_msg})
    return user_facing_msg, history, True, summary_json
