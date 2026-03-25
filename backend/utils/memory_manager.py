"""Read and write the agent memory markdown file."""

from __future__ import annotations

import re
from datetime import date
from pathlib import Path
from typing import Optional

from backend.models import PillarBalance


def read_memory(memory_path: Path) -> dict:
    """Parse memory file into structured sections."""
    if not memory_path.exists():
        return {"pillars": [], "pillar_balance": [], "patterns": [], "goals": [], "weekly_log": ""}

    content = memory_path.read_text(encoding="utf-8")
    return {
        "pillars": _parse_list_section(content, "My Pillars"),
        "pillar_balance": _parse_pillar_balance(content),
        "patterns": _parse_list_section(content, "My Patterns and Traps"),
        "goals": _parse_list_section(content, "Long Term Goals"),
        "weekly_log": _parse_section_raw(content, "Weekly Log"),
        "raw": content,
    }


def _parse_list_section(content: str, heading: str) -> list[str]:
    """Extract bullet items from a named section."""
    section = _parse_section_raw(content, heading)
    items = []
    for line in section.split("\n"):
        line = line.strip()
        if line.startswith("- "):
            items.append(line[2:].strip())
    return items


def _parse_pillar_balance(content: str) -> list[PillarBalance]:
    """Parse pillar balance section with numeric scores."""
    section = _parse_section_raw(content, "Pillar Balance")
    balances = []
    for line in section.split("\n"):
        line = line.strip()
        match = re.match(r"^-\s+(.+?):\s*(\d+)", line)
        if match:
            balances.append(PillarBalance(name=match.group(1).strip(), score=int(match.group(2))))
    return balances


def _parse_section_raw(content: str, heading: str) -> str:
    """Extract raw content between a heading and the next same-level heading."""
    pattern = rf"^##\s+{re.escape(heading)}\s*$"
    match = re.search(pattern, content, re.MULTILINE)
    if not match:
        return ""
    start = match.end()
    # Find next ## heading
    next_heading = re.search(r"^## ", content[start:], re.MULTILINE)
    end = start + next_heading.start() if next_heading else len(content)
    return content[start:end].strip()


def append_weekly_log(memory_path: Path, entry: str, entry_date: Optional[date] = None, replace: bool = False) -> None:
    """Append to (or replace) a weekly log entry for the given date.

    If replace=True, overwrites the existing entry for that date.
    Otherwise, appends to it.
    """
    if entry_date is None:
        entry_date = date.today()

    content = memory_path.read_text(encoding="utf-8")
    date_str = entry_date.strftime("%Y-%m-%d")
    heading = f"### {date_str}"

    if heading in content:
        if replace:
            pattern = rf"(### {re.escape(date_str)}\n)(.*?)(?=\n### |\Z)"
            replacement = rf"\g<1>{entry}"
            content = re.sub(pattern, replacement, content, flags=re.DOTALL)
        else:
            # Append to existing entry
            pattern = rf"(### {re.escape(date_str)}\n)(.*?)(?=\n### |\Z)"
            match = re.search(pattern, content, flags=re.DOTALL)
            if match:
                existing = match.group(2).rstrip()
                new_content = f"{existing}\n{entry}"
                replacement = rf"\g<1>{new_content}"
                content = re.sub(pattern, replacement, content, count=1, flags=re.DOTALL)
    else:
        content = content.rstrip() + f"\n\n{heading}\n{entry}\n"

    memory_path.write_text(content, encoding="utf-8")


def update_pillar_balance(memory_path: Path, balances: list[PillarBalance]) -> None:
    """Update pillar balance scores in the memory file."""
    content = memory_path.read_text(encoding="utf-8")

    new_section = "## Pillar Balance\n"
    for b in balances:
        new_section += f"- {b.name}: {b.score}\n"

    pattern = r"## Pillar Balance\n(?:.*?\n)*?(?=\n## |\Z)"
    if re.search(pattern, content):
        content = re.sub(pattern, new_section.rstrip() + "\n", content)
    else:
        # Insert after My Pillars section
        insert_point = content.find("## My Patterns")
        if insert_point > 0:
            content = content[:insert_point] + new_section + "\n" + content[insert_point:]

    memory_path.write_text(content, encoding="utf-8")
