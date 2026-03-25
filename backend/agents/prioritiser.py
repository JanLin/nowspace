"""Component 2: Task prioritiser using Claude API."""

from __future__ import annotations

import json
from datetime import date

import anthropic

from backend.config import config
from backend.models import Task, PillarBalance


PRIORITISE_PROMPT = """You are helping prioritise Jan's tasks for today.

## Context
- Today is {date} ({day_name})
- Day type: {day_type}

## Pillar Balance (1-5 scale, lower = needs attention)
{pillar_balance}

## Known Patterns
{patterns}

## Long Term Goals
{goals}

## Raw Tasks
{tasks}

## Instructions
Assign each task a priority:
- A = Must do today, high impact or time-sensitive
- B = Should do today, meaningful progress
- C = Could do today, nice to have

Consider:
1. Day type — weekends should favour recovery and play unless explicitly productive
2. Pillar balance — tasks that serve under-scored pillars get a boost
3. Energy patterns — front-load demanding tasks for weekdays
4. Deadline proximity from any tags or context

Also tag each task with the pillar(s) it serves. Use short pillar keys:
- social = Social connection
- recovery = Recovery (without guilt)
- play = Purposeful play / tinkering
- progress = Structured progress
- longterm = Long term goals

A task can serve zero, one, or multiple pillars.

Return ONLY a JSON array of objects with "text", "priority", and "pillars" fields, ordered A first, then B, then C.
Example: [{{"text": "task description", "priority": "A", "pillars": ["social", "recovery"]}}, ...]
"""


async def prioritise_tasks(tasks: list[Task], memory: dict) -> list[Task]:
    """Use Claude to assign A/B/C priorities to tasks."""
    if not tasks:
        return []

    today = date.today()
    day_type = "weekend" if today.weekday() >= 5 else "weekday"

    pillar_balance = memory.get("pillar_balance", [])
    balance_str = "\n".join(
        f"- {b.name if isinstance(b, PillarBalance) else b['name']}: "
        f"{b.score if isinstance(b, PillarBalance) else b['score']}"
        for b in pillar_balance
    ) or "No balance data yet"

    patterns_str = "\n".join(f"- {p}" for p in memory.get("patterns", []))
    goals_str = "\n".join(f"- {g}" for g in memory.get("goals", []))

    task_lines = []
    for t in tasks:
        line = f"- {'[x]' if t.done else '[ ]'} {t.text}"
        if t.context:
            line += f" (context: {t.context})"
        if t.tags:
            line += f" [tags: {', '.join(t.tags)}]"
        task_lines.append(line)

    prompt = PRIORITISE_PROMPT.format(
        date=today.isoformat(),
        day_name=today.strftime("%A"),
        day_type=day_type,
        pillar_balance=balance_str,
        patterns=patterns_str or "None recorded",
        goals=goals_str or "None recorded",
        tasks="\n".join(task_lines),
    )

    import logging
    logger = logging.getLogger(__name__)

    import asyncio
    client = anthropic.Anthropic()
    response = None
    for attempt in range(3):
        try:
            response = client.messages.create(
                model=config.model,
                max_tokens=config.max_tokens,
                system=config.system_prompt,
                messages=[{"role": "user", "content": prompt}],
            )
            break
        except anthropic.APIStatusError as e:
            if e.status_code == 529 and attempt < 2:
                logger.warning(f"API overloaded, retrying in {2 ** attempt}s...")
                await asyncio.sleep(2 ** attempt)
                continue
            logger.error(f"Prioritiser API call failed: {e}")
            return tasks
        except Exception as e:
            logger.error(f"Prioritiser API call failed: {e}")
            return tasks

    if response is None:
        return tasks

    # Parse Claude's response
    response_text = response.content[0].text
    try:
        # Extract JSON from response (handle markdown code blocks)
        json_text = response_text
        if "```" in json_text:
            json_text = json_text.split("```")[1]
            if json_text.startswith("json"):
                json_text = json_text[4:]
            json_text = json_text.strip()

        prioritised = json.loads(json_text)
    except (json.JSONDecodeError, IndexError) as e:
        logger.error(f"Failed to parse prioritiser response: {e}")
        logger.error(f"Response text (first 500 chars): {response_text[:500]}")
        # Fallback: return tasks with no priority
        return tasks

    # Map priorities and pillars back to task objects
    priority_map = {item["text"].lower().strip(): item for item in prioritised}

    result = []
    for task in tasks:
        task_copy = task.model_copy()
        match = priority_map.get(task.text.lower().strip(), {})
        # Preserve pre-set priority from vault (e.g. [A] tag); otherwise use Claude's
        if not task.priority:
            task_copy.priority = match.get("priority", "C")
        task_copy.pillars = match.get("pillars", [])
        result.append(task_copy)

    # Sort by priority
    priority_order = {"A": 0, "B": 1, "C": 2}
    result.sort(key=lambda t: priority_order.get(t.priority, 3))

    return result
