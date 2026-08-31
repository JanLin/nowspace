"""Editing a finished week — possible, never accidental.

The archive is the owner's own notes, and taking something out of a past
week or adding a link into it is ordinary work. What it must not be is
something a client can do while believing it is somewhere else: save-week
replaces every day section of the file it is handed, so the intent to write
a past week travels with the request.

An older client cannot set the flag, which is the point — the refusal is
what a stale instance gets.
"""

from datetime import date, timedelta

import pytest

from backend.config import config, DEFAULT_PLAN_FOLDER, SETTINGS_FILE_NAME, SETTINGS_SEARCH_FOLDERS


@pytest.fixture
def moved_plan(vault, monkeypatch):
    p = vault / SETTINGS_SEARCH_FOLDERS[0] / SETTINGS_FILE_NAME
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(
        "# Nowspace Configuration\n\n```yaml\n"
        "plan:\n  folder: 0-Plan\n  archive_folder: 4-Archive/a0-Plan\n```\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(config, "_plan_folder_override", None)
    monkeypatch.setattr(config, "_legacy_plan_folder", DEFAULT_PLAN_FOLDER)
    (vault / "0-Plan").mkdir(exist_ok=True)
    return vault


def _archived_last_week(vault) -> tuple[int, int]:
    iso = (date.today() - timedelta(weeks=1)).isocalendar()
    year, week = iso[0], iso[1]
    arch = vault / "4-Archive/a0-Plan"
    arch.mkdir(parents=True, exist_ok=True)
    (arch / f"Plan Week - {year}-wk{week:02d}.md").write_text(
        f"## Goals\n- \n\nWeek {year}-wk{week:02d}\n\n"
        "##### Mon 1\n* [ ] something from back then\n\n#### Notes\n",
        encoding="utf-8",
    )
    return year, week


DAYS = [{"day": d, "tasks": [{"text": "kept", "done": False, "priority": ""}] if d == "monday" else []}
        for d in ("monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday")]


def test_a_past_week_still_refuses_a_save_that_does_not_ask(moved_plan, client):
    """The default is unchanged: no flag, no write. This is what an older
    client sends, and what a client that merely lost track of which week it
    is on sends."""
    _archived_last_week(moved_plan)

    r = client.post("/plan/save-week", json={"days": DAYS, "offset": -1})

    assert r.status_code == 400
    assert "override" in r.json()["detail"]


def test_a_past_week_accepts_a_save_that_asks(moved_plan, client):
    year, week = _archived_last_week(moved_plan)

    r = client.post("/plan/save-week", json={"days": DAYS, "offset": -1, "allow_archive": True})

    assert r.status_code == 200, r.json()
    written = (moved_plan / "4-Archive/a0-Plan" / f"Plan Week - {year}-wk{week:02d}.md").read_text()
    assert "kept" in written
    assert f"{year}-wk{week:02d}" in written, "the week label must survive the rewrite"


def test_the_override_cannot_conjure_a_week_that_was_never_archived(moved_plan, client):
    r = client.post("/plan/save-week", json={"days": DAYS, "offset": -3, "allow_archive": True})
    assert r.status_code == 404
    assert "4-Archive/a0-Plan" in r.json()["detail"]


def test_day_notes_follow_the_same_rule(moved_plan, client):
    _archived_last_week(moved_plan)

    refused = client.put("/plan/notes", json={"day": "monday", "content": "a link", "offset": -1})
    assert refused.status_code == 400
    assert "override" in refused.json()["detail"]

    allowed = client.put(
        "/plan/notes",
        json={"day": "monday", "content": "see [[Some Note]]", "offset": -1, "allow_archive": True},
    )
    assert allowed.status_code == 200, allowed.json()

    read = client.get("/plan/notes?offset=-1&day=monday")
    assert "[[Some Note]]" in read.json()["content"]


def test_the_current_week_is_untouched_by_any_of_this(moved_plan, client):
    """The flag is meaningless anywhere but the past, and its absence must
    not change the ordinary save."""
    (moved_plan / "0-Plan" / "Plan Week.md").write_text(
        f"## Goals\n- \n\nWeek {date.today().isocalendar()[0]}-wk{date.today().isocalendar()[1]:02d}\n\n"
        "##### Mon 1\n\n#### Notes\n",
        encoding="utf-8",
    )
    r = client.post("/plan/save-week", json={"days": DAYS, "offset": 0})
    assert r.status_code == 200, r.json()
    assert "kept" in (moved_plan / "0-Plan" / "Plan Week.md").read_text()
