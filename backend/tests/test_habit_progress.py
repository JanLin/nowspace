"""The Habits tab's per-row graph: one bar per archived week.

A bar is the week's value — completions for a weekly habit, days done for a
daily one — never clamped. The goal line sits where a week counts as met.
"""

from backend.config import config


def _archive_week(wk, days):
    """days: {"Mon 20": [done habit labels]} → an archived week file."""
    archive = config.archive_path
    archive.mkdir(parents=True, exist_ok=True)
    body = f"Week 2026-wk{wk}\n\n" + "".join(
        f"##### {day}\n" + "".join(f"- [x] Habit: {label}\n" for label in labels)
        for day, labels in days.items()
    )
    (archive / f"Plan Week - 2026-wk{wk:02d}.md").write_text(body, encoding="utf-8")


def test_history_counts_are_oldest_first_and_unclamped(client, vault):
    (vault / "0-Inbox" / "Plan Week Habits.md").write_text(
        "## Body\n- exercise (run | bike): 2x/week\n- stretch: daily\n", encoding="utf-8"
    )
    _archive_week(30, {"Mon 20": ["run"], "Tue 21": ["stretch"]})
    _archive_week(31, {"Mon 27": ["run", "bike"], "Wed 29": ["exercise"], "Thu 30": ["stretch", "stretch"]})
    habits = {h["name"]: h for h in client.get("/plan/habits").json()["habits"]}

    exercise = habits["exercise"]
    assert exercise["history_labels"] == ["2026-wk30", "2026-wk31"]
    assert exercise["history_counts"] == [1, 3]  # 3 of a 2x/week — not clamped
    assert exercise["history"] == [False, True]
    assert exercise["week_goal"] == 2

    stretch = habits["stretch"]
    assert stretch["history_counts"] == [1, 1]  # days done, not completions
    assert stretch["week_goal"] == 5  # a daily habit's week is met at 5 days


def test_history_reaches_back_twelve_weeks(client, vault):
    (vault / "0-Inbox" / "Plan Week Habits.md").write_text("## Body\n- walk: 1x/week\n", encoding="utf-8")
    for wk in range(20, 35):
        _archive_week(wk, {"Mon": ["walk"]})
    h = client.get("/plan/habits").json()["habits"][0]
    assert h["history_labels"][0] == "2026-wk23" and h["history_labels"][-1] == "2026-wk34"
    assert len(h["history_counts"]) == len(h["history"]) == len(h["history_paused"]) == 12
