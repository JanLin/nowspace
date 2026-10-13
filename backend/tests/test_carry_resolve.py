"""Resolving a carry-forward item in place.

Reported 2026-10-13: ticking a carried task gave "Internal error". The route
called a `_find_archived_week_or_earlier` that was never written, so every
tick and every delete raised NameError — the feature had not worked since it
shipped on 2026-07-09, in any week, for any task.

The tests exercise the route, not the helper, because a missing name is
exactly what a unit test of the helper would have failed to notice.
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


def _archive_last_week(vault):
    iso = (date.today() - timedelta(weeks=1)).isocalendar()
    year, week = iso[0], iso[1]
    arch = vault / "4-Archive/a0-Plan"
    arch.mkdir(parents=True, exist_ok=True)
    f = arch / f"Plan Week - {year}-wk{week:02d}.md"
    f.write_text(
        f"## Goals\n- \n\nWeek {year}-wk{week:02d}\n\n"
        "##### Mon 1\n- [ ] B1: upload Kinomap\n- [ ] C1: something else\n\n"
        "#### Notes\n",
        encoding="utf-8",
    )
    return f


def test_ticking_a_carried_task_marks_it_in_the_source_week(moved_plan, client):
    f = _archive_last_week(moved_plan)

    r = client.post("/plan/carry-forward/resolve",
                    json={"text": "upload Kinomap", "source_offset": -1, "action": "done"})

    assert r.status_code == 200, r.text
    assert r.json()["status"] == "done"
    written = f.read_text()
    assert "[x]" in written and "upload Kinomap" in written
    assert "something else" in written, "the other task must be left alone"


def test_deleting_a_carried_task_drops_the_line(moved_plan, client):
    f = _archive_last_week(moved_plan)

    r = client.post("/plan/carry-forward/resolve",
                    json={"text": "upload Kinomap", "source_offset": -1, "action": "delete"})

    assert r.status_code == 200, r.text
    written = f.read_text()
    assert "upload Kinomap" not in written
    assert "something else" in written


def test_the_list_and_the_resolve_agree_on_the_file(moved_plan, client):
    """Whatever the panel offers must be resolvable — that pairing is the
    whole contract, and it was broken by the two using different lookups."""
    _archive_last_week(moved_plan)

    listed = client.get("/plan/carry-forward?offset=-1").json()
    assert listed["found"] is True
    for item in listed["tasks"]:
        r = client.post("/plan/carry-forward/resolve",
                        json={"text": item["text"], "source_offset": -1, "action": "done"})
        assert r.status_code == 200, f"{item['text']!r} was listed but not resolvable: {r.text}"


def test_a_task_that_is_not_there_is_a_plain_404(moved_plan, client):
    _archive_last_week(moved_plan)
    r = client.post("/plan/carry-forward/resolve",
                    json={"text": "never existed", "source_offset": -1, "action": "done"})
    assert r.status_code == 404


def test_no_archived_week_is_a_plain_404(moved_plan, client):
    r = client.post("/plan/carry-forward/resolve",
                    json={"text": "upload Kinomap", "source_offset": -1, "action": "done"})
    assert r.status_code == 404


def test_a_bad_action_is_refused_before_anything_is_read(moved_plan, client):
    _archive_last_week(moved_plan)
    r = client.post("/plan/carry-forward/resolve",
                    json={"text": "upload Kinomap", "source_offset": -1, "action": "maybe"})
    assert r.status_code == 400
