"""Component 1: Obsidian vault scanner and flexible task parser.

Tuned for Jan's Obsidian format:
- "Plan Week.md" with day headings (##### Monday, ##### Tues, etc.)
- "Weekend.md" with plain-text lines
- Strikethrough (~~text~~) = done
- Bold (**text**) = priority emphasis
- Sections: "Next week", "Queue", "Wait" = deferred (skipped)
- Section: "TIME PERMITTING" = low priority
"""

from __future__ import annotations

import re
from datetime import date
from pathlib import Path

from backend.models import Subtask, Task


# Patterns
CHECKBOX_RE = re.compile(r"^[\s]*[-*]\s*\[([ xX])\]\s*(.*)")
BULLET_RE = re.compile(r"^[\s]*[-*]\s+(.*)")
TAG_RE = re.compile(r"#(\w[\w/-]*)")
STRIKETHROUGH_FULL_RE = re.compile(r"^~~(.+?)~~$")
PRIORITY_RE = re.compile(r"^\[([ABCD])\d*\]\s*(.*)", re.IGNORECASE)
BOLD_RE = re.compile(r"\*\*(.+?)\*\*")

# Day detection keywords (including abbreviations used in the files)
DAY_KEYWORDS = {
    "today", "daily", "weekday",
    "monday", "mon",
    "tuesday", "tues", "tue",
    "wednesday", "wed",
    "thursday", "thur", "thu",
    "friday", "fri",
}
WEEKEND_KEYWORDS = {"weekend", "saturday", "sat", "sunday", "sun"}

# Section markers that signal deferred items (skip these)
DEFERRED_SECTIONS = {"next week", "queue", "wait", "read"}
# Sections that mean "stop reading this file entirely"
STOP_SECTIONS = {"notes"}
LOW_PRIORITY_SECTIONS = {"time permitting"}

# Labels that are section headers, not tasks
SECTION_LABELS = {"goals", "ai agent"}

# Files that should be treated as task sources (plain lines = tasks)
PLAN_FILES = {"plan week", "weekend"}

# Week label pattern — skip as task
WEEK_LABEL_LINE_RE = re.compile(r"^Week\s+\S+", re.IGNORECASE)


def _is_plan_file(file_stem: str) -> bool:
    """Check if a file stem matches a known plan file (exact match, not substring)."""
    lower = file_stem.lower().strip()
    return lower in PLAN_FILES


def scan_goals(vault_path: Path) -> list[str]:
    """Extract weekly goals from plan files."""
    goals: list[str] = []
    if not vault_path.exists():
        return goals

    for md_file in vault_path.rglob("*.md"):
        file_stem = md_file.stem.lower()
        if not _is_plan_file(file_stem):
            continue
        try:
            content = md_file.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        goals.extend(_parse_goals(content))
    return goals


def _parse_goals(content: str) -> list[str]:
    """Parse goals from the Goals section of a plan file."""
    lines = content.split("\n")
    in_goals = False
    goals: list[str] = []

    for line in lines:
        stripped = line.strip()
        if not stripped or stripped == "---":
            continue

        # Detect "Goals" section (plain text or heading)
        if stripped.lower().rstrip(":") == "goals":
            in_goals = True
            continue

        # Any heading or non-indented section label ends the goals section
        if stripped.startswith("#"):
            if in_goals:
                break
            continue

        if not in_goals:
            continue

        # Extract goal text from bullets
        bullet_match = BULLET_RE.match(line)
        if bullet_match:
            text = bullet_match.group(1).strip()
        else:
            text = stripped

        # Clean strikethrough
        if text.startswith("~~") and text.endswith("~~"):
            continue  # skip completed goals
        text = text.replace("~~", "").strip()

        if text and len(text) >= 3:
            goals.append(text)

    return goals


def scan_vault(vault_path: Path) -> list[Task]:
    """Recursively scan vault for markdown files and extract tasks."""
    tasks: list[Task] = []
    if not vault_path.exists():
        return tasks

    for md_file in vault_path.rglob("*.md"):
        if any(part.startswith(".") for part in md_file.parts):
            continue
        if "template" in md_file.name.lower():
            continue

        # Only scan known plan files for tasks
        file_stem = md_file.stem.lower()
        if not _is_plan_file(file_stem):
            continue

        try:
            content = md_file.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue

        file_tasks = parse_tasks(content, str(md_file.relative_to(vault_path)))
        tasks.extend(file_tasks)

    return tasks


def scan_vault_with_carryover(vault_path: Path, target_date: date | None = None) -> tuple[list[Task], list[Task]]:
    """Scan vault and return (today_tasks, carryover_tasks).

    Carryover tasks are uncompleted items from previous days.
    """
    today_tasks: list[Task] = []
    carryover_tasks: list[Task] = []
    if not vault_path.exists():
        return today_tasks, carryover_tasks

    for md_file in vault_path.rglob("*.md"):
        if any(part.startswith(".") for part in md_file.parts):
            continue
        if "template" in md_file.name.lower():
            continue

        file_stem = md_file.stem.lower()
        if not _is_plan_file(file_stem):
            continue

        try:
            content = md_file.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue

        rel_path = str(md_file.relative_to(vault_path))
        today, carryover = parse_tasks_with_carryover(content, rel_path, target_date)
        today_tasks.extend(today)
        carryover_tasks.extend(carryover)

    return today_tasks, carryover_tasks


def _is_category_label(line: str, lines: list[str], idx: int) -> bool:
    """Check if a line is a category label (short text followed by indented items)."""
    stripped = line.strip()
    # Must be non-indented, short, and not contain actionable verbs
    if len(line) > 0 and line[0] in (" ", "\t"):
        return False
    # Category labels are typically short (1-2 words) ending with optional colon
    clean = stripped.rstrip(":")
    if len(clean.split()) > 3:
        return False
    # Check if next non-empty line is indented
    for j in range(idx + 1, min(idx + 3, len(lines))):
        next_line = lines[j]
        if next_line.strip():
            return next_line.startswith("\t") or next_line.startswith("  ")
    return False


def _indent_level(line: str) -> int:
    """Count the indent level of a line (tabs count as 1, 2+ leading spaces count as 1)."""
    level = 0
    i = 0
    while i < len(line):
        if line[i] == "\t":
            level += 1
            i += 1
        elif line[i] == " " and i + 1 < len(line) and line[i + 1] == " ":
            level += 1
            i += 2
        else:
            break
    return level


def _collect_subtasks(lines: list[str], start_idx: int, parent_indent: int = 0) -> tuple[list[Subtask], set[int]]:
    """Lookahead from start_idx to collect checkbox lines indented deeper than parent.

    Returns (subtasks, consumed_indices) where consumed_indices are the line
    indices that should be skipped by the main loop.
    """
    subtasks: list[Subtask] = []
    consumed: set[int] = set()
    j = start_idx
    while j < len(lines):
        next_line = lines[j]
        if not next_line.strip():
            break
        next_indent = _indent_level(next_line)
        if next_indent <= parent_indent:
            break
        sub_match = CHECKBOX_RE.match(next_line)
        if sub_match:
            sub_done = sub_match.group(1).lower() == "x"
            sub_text = sub_match.group(2).strip()
            # Strip inline priority like [A1] from subtask text
            sub_pri = PRIORITY_RE.match(sub_text)
            if sub_pri:
                sub_text = sub_pri.group(2).strip()
            # Clean strikethrough
            if sub_text.startswith("~~") and sub_text.endswith("~~"):
                sub_done = True
                sub_text = sub_text[2:-2].strip()
            if sub_text and len(sub_text) >= 2:
                subtasks.append(Subtask(text=sub_text, done=sub_done))
            consumed.add(j)
        else:
            break
        j += 1
    return subtasks, consumed


def _today_day_keywords(target_date: date | None = None) -> set[str]:
    """Return the set of day keywords that match the target date (default: today)."""
    d = target_date or date.today()
    day_name = d.strftime("%A").lower()  # e.g. "saturday"
    # Map full day name to all its abbreviations
    day_abbrevs = {
        "monday": {"monday", "mon"},
        "tuesday": {"tuesday", "tues", "tue"},
        "wednesday": {"wednesday", "wed"},
        "thursday": {"thursday", "thur", "thu"},
        "friday": {"friday", "fri"},
        "saturday": {"saturday", "sat"},
        "sunday": {"sunday", "sun"},
    }
    return day_abbrevs.get(day_name, {day_name})


def parse_tasks(content: str, source_file: str = "") -> list[Task]:
    """Parse tasks from markdown content using flexible patterns."""
    tasks: list[Task] = []
    lines = content.split("\n")
    current_context = detect_context_from_filename(source_file)
    current_heading = ""
    is_plan_file = any(kw in source_file.lower().replace(".md", "") for kw in PLAN_FILES)
    in_deferred_section = False
    in_low_priority_section = False
    in_other_day_section = False  # True when under a day heading that isn't today
    in_goals_section = False  # Goals are extracted separately, skip in tasks
    current_category = ""  # tracks parent label for sub-items (e.g. "Rotary")
    today_keywords = _today_day_keywords()
    all_day_keywords = DAY_KEYWORDS | WEEKEND_KEYWORDS
    consumed_indices: set[int] = set()  # lines consumed as subtasks

    for idx, line in enumerate(lines):
        if idx in consumed_indices:
            continue
        stripped = line.strip()

        # Skip empty lines, separators, frontmatter delimiters
        if not stripped or stripped == "* * *" or stripped == "---":
            # Empty line ends goals section
            if not stripped and in_goals_section:
                in_goals_section = False
            continue

        # Skip bare URLs
        if stripped.startswith("http") or stripped.startswith("<http"):
            continue

        # Skip week label lines like "Week 2026-wk12"
        if WEEK_LABEL_LINE_RE.match(stripped):
            continue

        # Track headings for context and section type
        if stripped.startswith("#"):
            current_heading = stripped.lstrip("#").strip().lower()

            heading_context = detect_context(current_heading)
            if heading_context:
                current_context = heading_context

            # "Notes" and similar = stop reading this file entirely
            if any(kw == current_heading or kw in current_heading for kw in STOP_SECTIONS):
                break

            in_deferred_section = any(kw == current_heading or kw in current_heading for kw in DEFERRED_SECTIONS)
            in_low_priority_section = any(kw in current_heading for kw in LOW_PRIORITY_SECTIONS)
            in_goals_section = False

            # Check if heading is a day name — only include if it's today
            heading_words = set(current_heading.split())
            matched_day = heading_words & all_day_keywords
            if matched_day:
                in_other_day_section = not bool(matched_day & today_keywords)
            else:
                in_other_day_section = False

            continue

        # Detect section markers without heading syntax (e.g. plain "Next week", "Queue", "Wait")
        if stripped.lower().rstrip(":") in STOP_SECTIONS:
            break
        if stripped.lower().rstrip(":") in DEFERRED_SECTIONS:
            in_deferred_section = True
            continue
        if stripped.lower() in LOW_PRIORITY_SECTIONS:
            in_low_priority_section = True
            continue

        # Also detect "Weekend" as a section label inside Plan Week
        if stripped.lower() == "weekend" and "plan week" in source_file.lower():
            current_context = "weekend"
            continue

        # Skip known section labels
        if stripped.lower().rstrip(":") in SECTION_LABELS:
            current_category = ""
            in_goals_section = stripped.lower().rstrip(":") == "goals"
            continue

        # Skip items in deferred sections, other days, or goals
        if in_deferred_section or in_other_day_section or in_goals_section:
            continue

        # --- Track category labels for sub-item prefixing ---
        is_indented = line.startswith("\t") or line.startswith("  ")
        if not is_indented:
            # Non-indented line: check if it's a category label
            if _is_category_label(line, lines, idx):
                label = stripped.rstrip(":").strip()
                # Clean bullet prefix from category
                label = re.sub(r"^[-*]\s+", "", label)
                # Don't prefix with known section labels
                current_category = "" if label.lower() in SECTION_LABELS else label
                continue
            else:
                current_category = ""

        # --- Extract task from line ---
        done = False
        text = stripped

        # 1. Checkbox: - [ ] or - [x]
        checkbox_match = CHECKBOX_RE.match(line)
        if checkbox_match:
            done = checkbox_match.group(1).lower() == "x"
            text = checkbox_match.group(2).strip()
        else:
            # 2. Bullet: - item or * item
            bullet_match = BULLET_RE.match(line)
            if bullet_match:
                text = bullet_match.group(1).strip()
            elif is_plan_file:
                # 3. In plan files, plain lines are also tasks
                text = stripped
            else:
                continue

        # Detect strikethrough = done
        strike_match = STRIKETHROUGH_FULL_RE.match(text)
        if strike_match:
            done = True
            text = strike_match.group(1).strip()
        elif text.startswith("~~") and text.endswith("~~"):
            done = True
            text = text[2:-2].strip()

        # Detect inline priority tag: [A], [B], [C]
        inline_priority = ""
        priority_match = PRIORITY_RE.match(text)
        if priority_match:
            inline_priority = priority_match.group(1).upper()
            text = priority_match.group(2).strip()

        # Extract tags
        tags = TAG_RE.findall(text)
        clean_text = TAG_RE.sub("", text).strip()

        # Detect and clean bold markers (bold = priority emphasis)
        has_bold = bool(BOLD_RE.search(clean_text))
        clean_text = BOLD_RE.sub(r"\1", clean_text)

        # Clean remaining markdown artifacts
        clean_text = clean_text.replace("~~", "").strip()
        # Remove leading bullet/star artifacts left after processing
        clean_text = clean_text.lstrip("*-").strip()

        if not clean_text or len(clean_text) < 3:
            continue

        # Prefix with category label if this is a sub-item
        if current_category and is_indented:
            clean_text = f"{current_category}: {clean_text}"

        # Add priority hint tags
        if has_bold:
            tags.append("priority")
        if in_low_priority_section:
            tags.append("low-priority")

        # Collect subtasks: indented checkboxes following a non-indented checkbox
        subtasks: list[Subtask] = []
        if checkbox_match:
            parent_indent = _indent_level(line)
            subtasks, sub_consumed = _collect_subtasks(lines, idx + 1, parent_indent)
            consumed_indices.update(sub_consumed)

        tasks.append(Task(
            text=clean_text,
            done=done,
            source_file=source_file,
            context=current_context,
            tags=tags,
            priority=inline_priority,
            subtasks=subtasks,
        ))

    return tasks


def parse_tasks_with_carryover(
    content: str, source_file: str = "", target_date: date | None = None
) -> tuple[list[Task], list[Task]]:
    """Parse tasks and also collect uncompleted tasks from other days as carryover."""
    today_tasks: list[Task] = []
    carryover_tasks: list[Task] = []
    lines = content.split("\n")
    current_context = detect_context_from_filename(source_file)
    current_heading = ""
    is_plan_file = any(kw in source_file.lower().replace(".md", "") for kw in PLAN_FILES)
    in_deferred_section = False
    in_low_priority_section = False
    in_other_day_section = False
    in_goals_section = False
    current_category = ""
    today_keywords = _today_day_keywords(target_date)
    all_day_keywords = DAY_KEYWORDS | WEEKEND_KEYWORDS
    consumed_indices: set[int] = set()

    for idx, line in enumerate(lines):
        if idx in consumed_indices:
            continue
        stripped = line.strip()

        if not stripped or stripped == "* * *" or stripped == "---":
            if not stripped and in_goals_section:
                in_goals_section = False
            continue

        if stripped.startswith("http") or stripped.startswith("<http"):
            continue

        # Skip week label lines like "Week 2026-wk12"
        if WEEK_LABEL_LINE_RE.match(stripped):
            continue

        if stripped.startswith("#"):
            current_heading = stripped.lstrip("#").strip().lower()
            heading_context = detect_context(current_heading)
            if heading_context:
                current_context = heading_context
            if any(kw == current_heading or kw in current_heading for kw in STOP_SECTIONS):
                break
            in_deferred_section = any(kw == current_heading or kw in current_heading for kw in DEFERRED_SECTIONS)
            in_low_priority_section = any(kw in current_heading for kw in LOW_PRIORITY_SECTIONS)
            in_goals_section = False
            heading_words = set(current_heading.split())
            matched_day = heading_words & all_day_keywords
            if matched_day:
                in_other_day_section = not bool(matched_day & today_keywords)
            else:
                in_other_day_section = False
            continue

        if stripped.lower().rstrip(":") in STOP_SECTIONS:
            break
        if stripped.lower().rstrip(":") in DEFERRED_SECTIONS:
            in_deferred_section = True
            continue
        if stripped.lower() in LOW_PRIORITY_SECTIONS:
            in_low_priority_section = True
            continue
        if stripped.lower() == "weekend" and "plan week" in source_file.lower():
            current_context = "weekend"
            continue
        if stripped.lower().rstrip(":") in SECTION_LABELS:
            current_category = ""
            in_goals_section = stripped.lower().rstrip(":") == "goals"
            continue

        if in_deferred_section or in_goals_section:
            continue

        # --- Track category labels ---
        is_indented = line.startswith("\t") or line.startswith("  ")
        if not is_indented:
            if _is_category_label(line, lines, idx):
                label = stripped.rstrip(":").strip()
                label = re.sub(r"^[-*]\s+", "", label)
                current_category = "" if label.lower() in SECTION_LABELS else label
                continue
            else:
                current_category = ""

        # --- Extract task ---
        done = False
        text = stripped

        checkbox_match = CHECKBOX_RE.match(line)
        if checkbox_match:
            done = checkbox_match.group(1).lower() == "x"
            text = checkbox_match.group(2).strip()
        else:
            bullet_match = BULLET_RE.match(line)
            if bullet_match:
                text = bullet_match.group(1).strip()
            elif is_plan_file:
                text = stripped
            else:
                continue

        strike_match = STRIKETHROUGH_FULL_RE.match(text)
        if strike_match:
            done = True
            text = strike_match.group(1).strip()
        elif text.startswith("~~") and text.endswith("~~"):
            done = True
            text = text[2:-2].strip()

        # Detect inline priority tag: [A], [B], [C]
        inline_priority = ""
        priority_match = PRIORITY_RE.match(text)
        if priority_match:
            inline_priority = priority_match.group(1).upper()
            text = priority_match.group(2).strip()

        tags = TAG_RE.findall(text)
        clean_text = TAG_RE.sub("", text).strip()
        has_bold = bool(BOLD_RE.search(clean_text))
        clean_text = BOLD_RE.sub(r"\1", clean_text)
        clean_text = clean_text.replace("~~", "").strip()
        clean_text = clean_text.lstrip("*-").strip()

        if not clean_text or len(clean_text) < 3:
            continue

        if current_category and is_indented:
            clean_text = f"{current_category}: {clean_text}"

        if has_bold:
            tags.append("priority")
        if in_low_priority_section:
            tags.append("low-priority")

        # Collect subtasks
        subtasks: list[Subtask] = []
        if checkbox_match:
            parent_indent = _indent_level(line)
            subtasks, sub_consumed = _collect_subtasks(lines, idx + 1, parent_indent)
            consumed_indices.update(sub_consumed)

        task = Task(
            text=clean_text,
            done=done,
            source_file=source_file,
            context=current_context,
            tags=tags,
            priority=inline_priority,
            subtasks=subtasks,
        )

        if in_other_day_section:
            # Only collect uncompleted tasks from other days
            if not done:
                carryover_tasks.append(task)
        else:
            today_tasks.append(task)

    return today_tasks, carryover_tasks


def detect_context_from_filename(filename: str) -> str:
    """Detect day/weekend context from filename."""
    lower = filename.lower()
    if any(kw in lower for kw in WEEKEND_KEYWORDS):
        return "weekend"
    if any(kw in lower for kw in DAY_KEYWORDS):
        return "day"
    today = date.today()
    if today.strftime("%Y-%m-%d") in lower:
        return "weekend" if today.weekday() >= 5 else "day"
    return ""


def detect_context(text: str) -> str:
    """Detect day/weekend context from heading or text."""
    lower = text.lower()
    if any(kw in lower for kw in WEEKEND_KEYWORDS):
        return "weekend"
    if any(kw in lower for kw in DAY_KEYWORDS):
        return "day"
    return ""


def get_day_type(target_date: date | None = None) -> str:
    """Return whether the target date is a weekday or weekend."""
    d = target_date or date.today()
    return "weekend" if d.weekday() >= 5 else "weekday"


# --- Week plan parsing ---

# Canonical day order
WEEK_DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]

# Map any abbreviation to canonical day name
_DAY_NORMALIZE: dict[str, str] = {}
for _full, _abbrevs in {
    "monday": {"monday", "mon"},
    "tuesday": {"tuesday", "tues", "tue"},
    "wednesday": {"wednesday", "wed"},
    "thursday": {"thursday", "thur", "thu"},
    "friday": {"friday", "fri"},
    "saturday": {"saturday", "sat"},
    "sunday": {"sunday", "sun"},
}.items():
    for _a in _abbrevs:
        _DAY_NORMALIZE[_a] = _full

WEEK_LABEL_RE = re.compile(r"^Week\s+(\S+)", re.IGNORECASE)


def parse_week_plan(content: str, source_file: str = "") -> dict:
    """Parse Plan Week.md and return all days' tasks grouped by day.

    Returns dict with: week_label, goals, days (list of {day, heading, tasks}).
    """
    from backend.models import DayTasks

    lines = content.split("\n")
    is_plan_file = True

    # Result structures
    week_label = ""
    goals: list[str] = []
    day_map: dict[str, list[Task]] = {d: [] for d in WEEK_DAYS}
    heading_map: dict[str, str] = {}

    # State
    current_day: str | None = None
    in_deferred_section = False
    in_goals_section = False
    in_low_priority_section = False
    current_category = ""
    all_day_keywords = DAY_KEYWORDS | WEEKEND_KEYWORDS
    consumed_indices: set[int] = set()

    for idx, line in enumerate(lines):
        if idx in consumed_indices:
            continue
        stripped = line.strip()

        # Extract week label
        wk_match = WEEK_LABEL_RE.match(stripped)
        if wk_match:
            week_label = stripped
            continue

        # Skip empty, separators, frontmatter
        if not stripped or stripped == "---":
            if not stripped and in_goals_section:
                in_goals_section = False
            continue

        if stripped == "* * *":
            break  # End of weekly plan section

        # Skip URLs
        if stripped.startswith("http") or stripped.startswith("<http"):
            continue

        # Headings
        if stripped.startswith("#"):
            heading_text = stripped.lstrip("#").strip()
            heading_lower = heading_text.lower()

            # Stop at Notes
            if any(kw == heading_lower or kw in heading_lower for kw in STOP_SECTIONS):
                break

            # Deferred sections
            in_deferred_section = any(kw == heading_lower or kw in heading_lower for kw in DEFERRED_SECTIONS)
            in_low_priority_section = any(kw in heading_lower for kw in LOW_PRIORITY_SECTIONS)
            in_goals_section = False
            current_category = ""

            # Check if heading is a day name
            heading_words = set(heading_lower.split())
            matched_day_words = heading_words & set(_DAY_NORMALIZE.keys())
            if matched_day_words:
                day_word = next(iter(matched_day_words))
                current_day = _DAY_NORMALIZE[day_word]
                heading_map[current_day] = stripped
                in_deferred_section = False
            else:
                current_day = None

            continue

        # Section markers without heading syntax
        if stripped.lower().rstrip(":") in STOP_SECTIONS:
            break
        if stripped.lower().rstrip(":") in DEFERRED_SECTIONS:
            in_deferred_section = True
            current_day = None
            continue
        if stripped.lower() in LOW_PRIORITY_SECTIONS:
            in_low_priority_section = True
            continue

        # Weekend label inside Plan Week
        if stripped.lower() == "weekend" and "plan week" in source_file.lower():
            continue

        # Goals section
        if stripped.lower().rstrip(":") == "goals":
            in_goals_section = True
            continue
        if in_goals_section:
            bullet_match = BULLET_RE.match(line)
            if bullet_match:
                goals.append(bullet_match.group(1).strip())
            continue

        # Skip section labels and deferred
        if stripped.lower().rstrip(":") in SECTION_LABELS:
            current_category = ""
            continue
        if in_deferred_section or current_day is None:
            continue

        # --- Category labels ---
        is_indented = line.startswith("\t") or line.startswith("  ")
        if not is_indented:
            if _is_category_label(line, lines, idx):
                label = stripped.rstrip(":").strip()
                label = re.sub(r"^[-*]\s+", "", label)
                current_category = "" if label.lower() in SECTION_LABELS else label
                continue
            else:
                current_category = ""

        # --- Extract task (same logic as parse_tasks) ---
        done = False
        text = stripped

        checkbox_match = CHECKBOX_RE.match(line)
        if checkbox_match:
            done = checkbox_match.group(1).lower() == "x"
            text = checkbox_match.group(2).strip()
        else:
            bullet_match = BULLET_RE.match(line)
            if bullet_match:
                text = bullet_match.group(1).strip()
            elif is_plan_file:
                text = stripped
            else:
                continue

        strike_match = STRIKETHROUGH_FULL_RE.match(text)
        if strike_match:
            done = True
            text = strike_match.group(1).strip()
        elif text.startswith("~~") and text.endswith("~~"):
            done = True
            text = text[2:-2].strip()

        inline_priority = ""
        priority_match = PRIORITY_RE.match(text)
        if priority_match:
            inline_priority = priority_match.group(1).upper()
            text = priority_match.group(2).strip()

        tags = TAG_RE.findall(text)
        clean_text = TAG_RE.sub("", text).strip()
        has_bold = bool(BOLD_RE.search(clean_text))
        clean_text = BOLD_RE.sub(r"\1", clean_text)
        clean_text = clean_text.replace("~~", "").strip()
        clean_text = clean_text.lstrip("*-").strip()

        if not clean_text or len(clean_text) < 3:
            continue

        if current_category and is_indented:
            clean_text = f"{current_category}: {clean_text}"

        if has_bold:
            tags.append("priority")
        if in_low_priority_section:
            tags.append("low-priority")

        # Collect subtasks
        subtasks: list[Subtask] = []
        if checkbox_match:
            parent_indent = _indent_level(line)
            subtasks, sub_consumed = _collect_subtasks(lines, idx + 1, parent_indent)
            consumed_indices.update(sub_consumed)

        task = Task(
            text=clean_text,
            done=done,
            source_file=source_file,
            context="weekend" if current_day in ("saturday", "sunday") else "day",
            tags=tags,
            priority=inline_priority,
            subtasks=subtasks,
        )
        day_map[current_day].append(task)

    # Build response
    days = []
    for d in WEEK_DAYS:
        days.append(DayTasks(
            day=d,
            heading=heading_map.get(d, f"##### {d.capitalize()}"),
            tasks=day_map[d],
        ))

    # Determine if future week
    is_future = False
    if week_label:
        wk_match2 = re.search(r"wk(\d+)", week_label, re.IGNORECASE)
        year_match = re.search(r"(\d{4})", week_label)
        if wk_match2:
            plan_week = int(wk_match2.group(1))
            plan_year = int(year_match.group(1)) if year_match else date.today().year
            current_week = date.today().isocalendar()[1]
            current_year = date.today().year
            is_future = (plan_year > current_year) or (plan_year == current_year and plan_week > current_week)

    return {
        "week_label": week_label,
        "goals": goals,
        "days": days,
        "is_future": is_future,
    }
