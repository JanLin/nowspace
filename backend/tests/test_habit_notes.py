"""Habit note links: a habit can point at the note that explains how.

Reference material only — the link targets a note, never a work item, and a
habit gains no completion semantics from it.
"""

from backend import vault_index
from backend.routers.habits import (
    HabitDef,
    _format_habits_file,
    _parse_habits_file,
    note_error,
    note_name,
)


def _write_habits(vault, content):
    (vault / "0-Inbox" / "Plan Week Habits.md").write_text(content, encoding="utf-8")


HABITS_WITH_NOTE = """# Habits

## Body
- tai chi: 2x/week, morning, [[Tai Chi form]]
- back & hip routine: 2x/week
"""


def test_note_token_parses_with_casing_preserved():
    habits = _parse_habits_file(HABITS_WITH_NOTE)
    tai_chi = next(h for h in habits if h["name"] == "tai chi")
    assert tai_chi["note"] == "Tai Chi form"
    assert tai_chi["morning"] is True
    assert tai_chi["target"] == 2
    plain = next(h for h in habits if h["name"] == "back & hip routine")
    assert plain["note"] == ""


def test_note_round_trips_through_the_serializer():
    habits = _parse_habits_file(HABITS_WITH_NOTE)
    text = _format_habits_file([HabitDef(**h) for h in habits])
    assert "- tai chi: 2x/week, morning, [[Tai Chi form]]" in text
    reparsed = _parse_habits_file(text)
    assert next(h for h in reparsed if h["name"] == "tai chi")["note"] == "Tai Chi form"


def test_a_habit_line_without_a_note_is_unchanged():
    """An older backend's lines (no note token) parse exactly as before."""
    habits = _parse_habits_file("## Body\n- exercise (kayak | bike): 3x/week, morning\n")
    assert habits[0]["note"] == ""
    assert habits[0]["variants"] == ["kayak", "bike"]


def test_keyword_tokens_still_match_case_insensitively():
    """Removing the whole-segment lowercase must not break Daily/Morning."""
    habits = _parse_habits_file("## Body\n- stretch: Daily, Morning\n")
    assert habits[0]["period"] == "day"
    assert habits[0]["morning"] is True


def test_note_name_strips_alias_and_heading():
    assert note_name("Tai Chi form|the form") == "Tai Chi form"
    assert note_name("Tai Chi form#Steps") == "Tai Chi form"


def test_get_habits_returns_the_note(client, vault):
    _write_habits(vault, HABITS_WITH_NOTE)
    data = client.get("/plan/habits").json()
    tai_chi = next(h for h in data["habits"] if h["name"] == "tai chi")
    assert tai_chi["note"] == "Tai Chi form"


def test_save_persists_the_note(client, vault):
    vault_index.refresh_index()
    resp = client.post(
        "/plan/habits/save",
        json={"habits": [{"name": "tai chi", "target": 2, "note": "Tai Chi form"}]},
    )
    assert resp.status_code == 200
    on_disk = (vault / "0-Inbox" / "Plan Week Habits.md").read_text(encoding="utf-8")
    assert "- tai chi: 2x/week, [[Tai Chi form]]" in on_disk


def test_a_habit_cannot_link_a_work_item(client, vault):
    """The note field points at notes, never work items — by name or by resolution."""
    vault_index.refresh_index()
    for bad in ("Plan Week Bucket", "Time Log - 2026-07", "Plan Week"):
        resp = client.post(
            "/plan/habits/save",
            json={"habits": [{"name": "tai chi", "target": 2, "note": bad}]},
        )
        assert resp.status_code == 422, bad
        assert "work-item" in resp.json()["detail"]


def test_a_note_value_that_would_corrupt_the_line_is_refused(client, vault):
    for bad in ("a, b", "Notes: Tai Chi"):
        resp = client.post(
            "/plan/habits/save",
            json={"habits": [{"name": "tai chi", "target": 2, "note": bad}]},
        )
        assert resp.status_code == 422, bad


def test_unresolvable_note_is_allowed():
    """Obsidian-style: linking a note that doesn't exist yet is fine."""
    vault_index._file_index = {}
    assert note_error("Some future note") is None
