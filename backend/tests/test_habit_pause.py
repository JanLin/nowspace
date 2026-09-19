"""Habits can be paused, and a week can go past its target.

Paused: the definition and its history stay, but the habit leaves the strip
and the week's count until started again. Each pause is dated — "paused
2026-09-19" while open, "paused 2026-09-01..2026-09-14" once started again —
so the history can show paused weeks as paused rather than missed.

Past target: 6 of a 5x/week habit is 6 — never clamped, and the week is met.
"""

from datetime import date

from backend.config import config
from backend.routers.habits import (
    HabitDef,
    _apply_pause,
    _format_habits_file,
    _habit_counts,
    _is_established,
    _parse_habits_file,
    _paused_during,
    _week_met,
)

TODAY = date.today().isoformat()


def _habits_file(vault):
    return vault / "0-Inbox" / "Plan Week Habits.md"


HAND_EDITED = """# Habits

My own words above the list, kept by hand.

## Body
- exercise (kayak | bike | run): 5x/week, morning, [[Training Plan]]
- back & hip routine: 2x/week, 30min, someFutureToken

## Sleep
- sleep before 23:00: daily
"""


# ── The token ───────────────────────────────────────────────

def test_pause_tokens_parse_open_finished_and_undated():
    habits = _parse_habits_file(
        "## Body\n"
        "- exercise: 5x/week, paused 2026-08-01..2026-08-15, Paused 2026-09-19\n"
        "- stretch: daily, paused\n"
        "- walk: daily\n"
    )
    exercise, stretch, walk = habits
    assert exercise["paused"] is True and exercise["paused_since"] == "2026-09-19"
    assert exercise["pauses"] == [{"start": "2026-08-01", "end": "2026-08-15"}]
    assert exercise["target"] == 5
    assert stretch["paused"] is True and stretch["paused_since"] == ""
    assert walk["paused"] is False and walk["pauses"] == []


def test_a_malformed_pause_date_is_not_trusted():
    habits = _parse_habits_file(
        "## Body\n- exercise: 5x/week, paused 2026-13-45, paused 2026-09-10..2026-09-01\n"
    )
    assert habits[0]["paused"] is True and habits[0]["paused_since"] == ""
    assert habits[0]["pauses"] == []  # ends before it starts — ignored


def test_pauses_round_trip_through_the_serializer_as_the_last_tokens():
    line = "- tai chi: 2x/week, morning, [[Tai Chi form]], paused 2026-08-01..2026-08-15, paused 2026-09-19"
    habits = _parse_habits_file(f"## Body\n{line}\n")
    text = _format_habits_file([HabitDef(**h) for h in habits])
    assert line in text
    assert _parse_habits_file(text)[0]["pauses"] == habits[0]["pauses"]


# ── Moving the dates ────────────────────────────────────────

def test_pausing_dates_the_pause_and_keeps_an_existing_date():
    assert _apply_pause(["5x/week"], True, "2026-09-19") == ["5x/week", "paused 2026-09-19"]
    already = ["5x/week", "paused 2026-09-01"]
    assert _apply_pause(already, True, "2026-09-19") == already


def test_starting_again_closes_the_pause_into_a_period():
    tokens = ["5x/week", "paused 2026-08-01..2026-08-15", "paused 2026-09-01", "morning"]
    assert _apply_pause(tokens, False, "2026-09-19") == [
        "5x/week", "paused 2026-08-01..2026-08-15", "morning", "paused 2026-09-01..2026-09-19",
    ]


def test_a_same_day_pause_or_an_undated_one_leaves_no_period():
    assert _apply_pause(["5x/week", "paused 2026-09-19"], False, "2026-09-19") == ["5x/week"]
    assert _apply_pause(["5x/week", "paused"], False, "2026-09-19") == ["5x/week"]


# ── The endpoint edits only its own line ────────────────────

def test_pause_edits_only_that_line(client, vault):
    _habits_file(vault).write_text(HAND_EDITED, encoding="utf-8")
    resp = client.post("/plan/habits/pause", json={"name": "Exercise", "paused": True})
    assert resp.status_code == 200
    expected = HAND_EDITED.replace(
        "5x/week, morning, [[Training Plan]]", f"5x/week, morning, [[Training Plan]], paused {TODAY}"
    )
    # Byte-for-byte: prose, a newer instance's token and other lines survive
    assert _habits_file(vault).read_text(encoding="utf-8") == expected


def test_start_again_through_the_endpoint_records_the_period(client, vault):
    _habits_file(vault).write_text("## Body\n- exercise: 5x/week, paused 2026-01-05\n", encoding="utf-8")
    client.post("/plan/habits/pause", json={"name": "exercise", "paused": False})
    assert _habits_file(vault).read_text(encoding="utf-8") == (
        f"## Body\n- exercise: 5x/week, paused 2026-01-05..{TODAY}\n"
    )


def test_pause_finds_a_name_that_contains_a_colon(client, vault):
    _habits_file(vault).write_text(HAND_EDITED, encoding="utf-8")
    resp = client.post("/plan/habits/pause", json={"name": "sleep before 23:00", "paused": True})
    assert resp.status_code == 200
    assert f"- sleep before 23:00: daily, paused {TODAY}" in _habits_file(vault).read_text(encoding="utf-8")


def test_pause_of_an_unknown_habit_is_refused(client, vault):
    _habits_file(vault).write_text(HAND_EDITED, encoding="utf-8")
    resp = client.post("/plan/habits/pause", json={"name": "juggling", "paused": True})
    assert resp.status_code == 404
    assert _habits_file(vault).read_text(encoding="utf-8") == HAND_EDITED


# ── The editor's save dates it the same way ─────────────────

def test_save_dates_a_new_pause(client, vault):
    resp = client.post("/plan/habits/save", json={"habits": [{"name": "exercise", "target": 5, "paused": True}]})
    assert resp.status_code == 200
    assert f"- exercise: 5x/week, paused {TODAY}" in _habits_file(vault).read_text(encoding="utf-8")


def test_save_closes_a_pause_that_was_unticked(client, vault):
    resp = client.post("/plan/habits/save", json={"habits": [{
        "name": "exercise", "target": 5, "paused": False, "paused_since": "2026-01-05",
        "pauses": [{"start": "2025-11-03", "end": "2025-11-17"}],
    }]})
    assert resp.status_code == 200
    assert (
        f"- exercise: 5x/week, paused 2025-11-03..2025-11-17, paused 2026-01-05..{TODAY}"
        in _habits_file(vault).read_text(encoding="utf-8")
    )


def test_save_refuses_dates_that_would_corrupt_the_line(client, vault):
    for bad in (
        {"paused": True, "paused_since": "19/09, 2026"},
        {"pauses": [{"start": "2026-09-10", "end": "2026-09-01"}]},
        {"pauses": [{"start": "2026-09-01", "end": "soon"}]},
    ):
        resp = client.post("/plan/habits/save", json={"habits": [{"name": "exercise", "target": 5, **bad}]})
        assert resp.status_code == 422, bad


# ── History ─────────────────────────────────────────────────

def _habit(**kw):
    return {"paused": False, "paused_since": "", "pauses": [], **kw}


def test_a_week_is_paused_when_any_pause_overlaps_it():
    monday = date(2026, 9, 7)
    # Finished pause ending the Monday it started again: that week is active
    assert not _paused_during(_habit(pauses=[{"start": "2026-08-24", "end": "2026-09-07"}]), monday)
    assert _paused_during(_habit(pauses=[{"start": "2026-08-24", "end": "2026-09-08"}]), monday)
    assert _paused_during(_habit(pauses=[{"start": "2026-09-13", "end": "2026-09-20"}]), monday)
    assert not _paused_during(_habit(pauses=[{"start": "2026-09-14", "end": "2026-09-20"}]), monday)
    # Open pause: every week from its Monday on
    assert _paused_during(_habit(paused=True, paused_since="2026-09-10"), monday)
    assert not _paused_during(_habit(paused=True, paused_since="2026-09-14"), monday)
    assert not _paused_during(_habit(paused=True, paused_since=""), monday)  # undated


def test_paused_weeks_are_skipped_not_failed_for_established():
    met = [True, True, False, False, True, True]
    paused = [False, False, True, True, False, False]
    assert _is_established(met, paused) is True
    assert _is_established(met, [False] * 6) is False
    assert _is_established([True, True, True], [False] * 3) is False  # too few weeks yet


def test_history_marks_paused_weeks(client, vault):
    archive = config.archive_path
    archive.mkdir(parents=True, exist_ok=True)
    for wk in (30, 31, 32):
        (archive / f"Plan Week - 2026-wk{wk:02d}.md").write_text(f"Week 2026-wk{wk}\n", encoding="utf-8")
    # 2026-wk31 runs Mon 27 Jul – Sun 2 Aug
    _habits_file(vault).write_text(
        "## Body\n- exercise: 5x/week, paused 2026-07-29..2026-08-03\n", encoding="utf-8"
    )
    h = client.get("/plan/habits").json()["habits"][0]
    assert h["history"] == [False, False, False]
    assert h["history_paused"] == [False, True, False]


def test_get_habits_reports_the_pause(client, vault):
    _habits_file(vault).write_text("## Body\n- exercise: 5x/week, paused 2026-09-19\n", encoding="utf-8")
    h = client.get("/plan/habits").json()["habits"][0]
    assert h["paused"] is True and h["paused_since"] == "2026-09-19"


# ── Past target ─────────────────────────────────────────────

def test_a_week_past_its_target_counts_every_completion():
    habit = _parse_habits_file("## Body\n- exercise (run | bike): 5x/week\n")[0]
    days = [["Habit: run"], ["Habit: bike"], ["Habit: run", "Habit: run"], [], ["Habit: exercise"], ["Habit: bike"], []]
    counts = _habit_counts(days, [habit])["exercise"]
    assert sum(counts) == 6
    assert _week_met(counts, habit) is True
