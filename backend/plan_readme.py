"""The README that sits beside the Plan Week files, in the vault.

Nowspace keeps no database: the plan is a handful of markdown files in a
folder you can open in Obsidian. Which means someone — you in a year, or
anyone you share a vault with — will eventually look at that folder and
wonder what each file is, and whether it is safe to touch.

The table is generated from the paths this installation actually resolved,
not from a fixed list, so it stays true when the folder moves (plan.folder in
the vault settings). It is rewritten only when the content differs: a file
rewritten on every start is a file Syncthing ships on every start.
"""

from pathlib import Path
from typing import Optional

from backend.config import config, SETTINGS_FILE_NAME
from backend.vault_io import write_text_guarded

README_NAME = "Plan Week README.md"

_INTRO = """\
# Plan Week — what these files are

Everything Nowspace knows lives in this folder as plain markdown. There is no
database: what the app shows you is what these files say, and editing them in
Obsidian is a supported way to work. Nowspace re-reads a file it did not
write, and refuses to overwrite one that changed under it.

This file is generated. Edits to it are replaced; the files it describes are
yours.
"""

_OUTRO = """\
## How they fit together

**The bucket is where things wait; a week is what you committed to.** A task
enters the bucket, and moving it into a day is the decision. The week file
holds the days; the bucket holds everything not in a day yet.

**Finished weeks move to the archive** at the turn of the week — the current
week file is renamed into the archive folder and a fresh one takes its place.
Nothing is deleted, and last week is still readable in Obsidian.

**Configuration is shared, not per-device.** `Plan Week Configuration.md`
syncs with the vault, so every installation reading this vault — desktop,
phone, server — agrees about contexts, groups and where these files live. The
one thing each installation knows for itself is where the vault is.

## Editing these by hand

Safe, with two habits. Close Nowspace's view of the day first, or reload it
after — it holds the file's timestamp and will refuse to save over an edit it
did not see. And leave the `~` tokens alone: they carry a task's identity and
its funnel state, and a task that loses its `~i` token becomes a new task.

## If you move this folder

Settings → *Nowspace's files* moves them and records where they went, so every
installation reading this vault follows. `plan.folder` and
`plan.archive_folder` in the configuration file are what it writes, as paths
relative to the vault root.

The configuration file itself does not move with them. It lives with the tool
files, in one of two places the app knows to look, and that is exactly what
lets the rest go anywhere: a file cannot record its own location, so this one
stays findable and records everything else.

Update every installation before you move — an older one keeps writing the
folder it knows.
"""


def _settings_note() -> str:
    """Say where the settings file is when it is not in this folder."""
    try:
        rel = config._vault_settings_path.parent.relative_to(config.vault_root)
    except ValueError:
        return ""
    return "" if str(rel) == config.plan_folder else f" Lives in `{rel}/`."


def _rows() -> list[tuple[str, str, str]]:
    """(file, what it is, lifecycle) — from the resolved configuration."""
    plan = config.plan_week_file
    stem = plan.replace(".md", "")
    return [
        (plan,
         "This week's plan: a heading per day, tasks beneath it.",
         "Rewritten as you plan; archived whole at the turn of the week."),
        (f"{stem} - YYYY-wkNN.md",
         "Next week, when you start planning ahead of the turn.",
         "Becomes this week's file at the turn."),
        (config.plan_week_bucket_file,
         "The bucket: everything you intend to do but haven't committed to a day.",
         "Permanent. Items leave by being scheduled, parked or dropped."),
        (config._vault_settings_path.name,
         "Settings shared by every installation reading this vault — contexts, "
         "groups, reference folders, and where these files live."
         + _settings_note(),
         "Permanent. Safe to read; edit through Settings where you can."),
        (config.plan_week_habits_file,
         "Habit definitions: what you're trying to do weekly, and how often.",
         "Permanent. Completions are recorded in the week file, not here."),
        (config.plan_week_recurring_file,
         "Repeat schedules — one template per repeating task.",
         "Permanent. The live copy of a repeat lives in the week or bucket."),
        ("Plan Week Funnel Log.md",
         "A line per stage change: what was captured, shaped, made ready, "
         "scheduled, dropped.",
         "Append-only history. Nothing reads it back; delete it if you like."),
        ("Time Log - YYYY-MM.md",
         "Tracked time, one file per month.",
         "One new file a month, kept indefinitely."),
        (README_NAME,
         "This file.",
         "Regenerated when the folder or file names change."),
    ]


def render() -> str:
    lines = [_INTRO, "", "## The files", "",
             "| File | What it is | Lifecycle |",
             "| --- | --- | --- |"]
    for name, what, life in _rows():
        lines.append(f"| `{name}` | {what} | {life} |")
    lines += [
        "",
        f"All of the above live in **`{config.plan_folder}/`**, and finished "
        f"weeks are archived to **`{config.archive_folder}/`** — both relative "
        "to the vault root.",
        "",
        _OUTRO,
    ]
    return "\n".join(lines)


def ensure(path: Optional[Path] = None) -> bool:
    """Write the README if it is missing or out of date. True if written."""
    target = path or (config.vault_path / README_NAME)
    wanted = render()
    try:
        if target.exists() and target.read_text(encoding="utf-8") == wanted:
            return False
    except OSError:
        pass
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        write_text_guarded(target, wanted, what="Plan Week README")
        return True
    except Exception:
        # A README is never worth failing a startup for.
        return False
