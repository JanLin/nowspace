"""Looking back across a week that has not been archived yet.

Reported 2026-08-24: "Archived week 2026-wk34 not found in
4-Archive/a0-Inbox", from a vault whose archive is `4-Archive/a0-Plan`.
Two faults in one sentence.

The message named a folder the app had not searched — it was hardcoded, and
since 0.7.0 the archive follows the plan folder. And the week really was
missing, for the honest reason that Plan Week.md was still holding it: an app
left open across the rollover never re-read the current week, and nothing but
that read moves a finished week into the archive.
"""

from datetime import date, timedelta

import pytest

from backend.config import config, DEFAULT_PLAN_FOLDER, SETTINGS_FILE_NAME, SETTINGS_SEARCH_FOLDERS


@pytest.fixture
def moved_plan(vault, monkeypatch):
    """A vault shaped like the owner's: plan in 0-Plan, archive in a0-Plan."""
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


def _last_week() -> tuple[int, int]:
    iso = (date.today() - timedelta(weeks=1)).isocalendar()
    return iso[0], iso[1]


def _write_week(folder, year, week, name="Plan Week.md"):
    f = folder / name
    f.write_text(
        f"## Goals\n- \n\nWeek {year}-wk{week:02d}\n\n##### Mon 1\n\n#### Notes\n",
        encoding="utf-8",
    )
    return f


def test_the_message_names_the_folder_it_actually_searched(moved_plan, client):
    """The owner was sent to 4-Archive/a0-Inbox, which their vault does not
    even have."""
    # A week nothing could have archived: two weeks back, no plan file at all.
    r = client.get("/plan/week?offset=-2")
    assert r.status_code == 404
    assert "4-Archive/a0-Plan" in r.json()["detail"]
    assert "a0-Inbox" not in r.json()["detail"]


def test_looking_back_archives_the_week_still_sitting_in_plan_week(moved_plan, client):
    """The reported symptom: last week is 'missing' because it is still the
    live file. A look back heals it instead of reporting it."""
    year, week = _last_week()
    _write_week(moved_plan / "0-Plan", year, week)

    r = client.get(f"/plan/week?offset=-1")

    assert r.status_code == 200, r.json()
    assert r.json()["is_archive"] is True
    archived = moved_plan / "4-Archive/a0-Plan" / f"Plan Week - {year}-wk{week:02d}.md"
    assert archived.exists(), "the finished week should now be in the archive"
    assert not (moved_plan / "0-Plan" / "Plan Week.md").exists() or \
        f"wk{week:02d}" not in (moved_plan / "0-Plan" / "Plan Week.md").read_text()


def test_a_week_genuinely_absent_still_reports_absent(moved_plan, client):
    """Healing the rollover must not invent a week that was never there."""
    r = client.get("/plan/week?offset=-3")
    assert r.status_code == 404
    assert "not found in 4-Archive/a0-Plan" in r.json()["detail"]


def test_an_already_archived_week_is_still_found(moved_plan, client):
    year, week = _last_week()
    arch = moved_plan / "4-Archive/a0-Plan"
    arch.mkdir(parents=True, exist_ok=True)
    _write_week(arch, year, week, name=f"Plan Week - {year}-wk{week:02d}.md")

    r = client.get("/plan/week?offset=-1")

    assert r.status_code == 200
    assert r.json()["is_archive"] is True
