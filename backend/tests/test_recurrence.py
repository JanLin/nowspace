"""Recurring templates: one live copy at a time, misses on the template.

The acceptance criteria of recurrence-brief stages 2–4 live here: the
no-stacking rule, derived instance identity (sync idempotence), the
creation gate, and the born-ready invariant.
"""

from datetime import date, timedelta

from backend import recurrence as rec
from backend.models import BUCKET_SCHEMA_VERSION
from backend.recurrence import (
    RecurrenceTemplate,
    credit_completions,
    format_recurring_file,
    instance_identity,
    lapsed,
    occurrences_between,
    parse_recurring_file,
    parse_repeat,
    run_recurrence_pass,
)

TODAY = date.today()


def _iso(d: date) -> str:
    return d.isoformat()


def _weekday_name(d: date) -> str:
    return ("mon", "tue", "wed", "thu", "fri", "sat", "sun")[d.weekday()]


def _write_templates(vault, templates):
    (vault / "0-Inbox" / "Plan Week Recurring.md").write_text(
        format_recurring_file(templates), encoding="utf-8"
    )


def _bucket_file(vault):
    return vault / "0-Inbox" / "Plan Week Bucket.md"


def _weekly_template(**overrides) -> RecurrenceTemplate:
    fields = dict(
        id="abc123", title="water plants", repeat=f"weekly on {_weekday_name(TODAY)}",
        size="s", group="Home", state="active", created=_iso(TODAY - timedelta(days=60)),
    )
    fields.update(overrides)
    return RecurrenceTemplate(**fields)


# ── Repeat vocabulary ─────────────────────────────────────────

def test_parse_repeat_vocabulary():
    assert parse_repeat("monthly on 25") == {"kind": "monthly", "day": 25}
    assert parse_repeat("Weekly on Mon Thu") == {"kind": "weekly", "weekdays": [0, 3]}
    assert parse_repeat("every 6w") == {"kind": "interval", "days": 42}
    assert parse_repeat("every 45d") == {"kind": "interval", "days": 45}
    for bad in ("", "monthly on 0", "monthly on 32", "weekly on xyz", "every 0w", "sometimes"):
        assert parse_repeat(bad) is None, bad


def test_monthly_occurrences_clamp_to_short_months():
    occs = occurrences_between(
        {"kind": "monthly", "day": 31}, date(2026, 1, 15), date(2026, 3, 15)
    )
    assert occs == [date(2026, 1, 31), date(2026, 2, 28)]


def test_weekly_occurrences_ordered_oldest_first():
    # A Monday-and-Thursday template over two full weeks
    monday = date(2026, 7, 6)
    occs = occurrences_between({"kind": "weekly", "weekdays": [0, 3]}, monday, monday + timedelta(days=14))
    assert occs == [
        date(2026, 7, 9), date(2026, 7, 13), date(2026, 7, 16), date(2026, 7, 20),
    ]


# ── File round trip ───────────────────────────────────────────

def test_template_file_round_trips_and_preserves_unknown_lines():
    t = _weekly_template(next_action="fill the can: 2 litres", note="Plant care",
                         missed=2, last_done="2026-07-01")
    text = format_recurring_file([t])
    # A newer instance's field this backend doesn't know must survive
    text = text.replace("- state: active", "- state: active\n- future-key: kept")
    back = parse_recurring_file(text)
    assert len(back) == 1
    b = back[0]
    assert b.title == "water plants"
    assert b.next_action == "fill the can: 2 litres"  # colon in value survives
    assert b.note == "Plant care"
    assert b.missed == 2
    assert "- future-key: kept" in format_recurring_file(back)


def test_instance_identity_is_derived_not_random():
    a = instance_identity("abc123", "2026-08-25")
    assert a == instance_identity("abc123", "2026-08-25")
    assert a != instance_identity("abc123", "2026-09-25")


# ── Calendar spawning ─────────────────────────────────────────

def test_spawn_creates_one_ready_instance(client, vault):
    _write_templates(vault, [_weekly_template(
        spawned=_iso(TODAY - timedelta(days=7)), next_action="check the soil first",
    )])
    r = client.get("/plan/bucket")
    assert r.status_code == 200
    tasks = r.json()["tasks"]
    inst = [t for t in tasks if t["recurrence_id"] == "abc123"]
    assert len(inst) == 1
    assert inst[0]["stage"] == "ready"
    assert inst[0]["estimate"] == "s"
    assert inst[0]["due_date"] == _iso(TODAY)
    assert inst[0]["text"].startswith("Home: water plants")
    assert inst[0]["subtasks"][0]["text"] == "check the soil first"
    on_disk = _bucket_file(vault).read_text(encoding="utf-8")
    assert f"~rabc123" in on_disk
    assert f"~du{_iso(TODAY)}" in on_disk
    assert f"~i{instance_identity('abc123', _iso(TODAY))}" in on_disk
    # Ledger advanced — idempotent on the next read
    stored = parse_recurring_file((vault / "0-Inbox" / "Plan Week Recurring.md").read_text(encoding="utf-8"))
    assert stored[0].spawned == _iso(TODAY)


def test_spawn_is_idempotent_across_reads(client, vault):
    _write_templates(vault, [_weekly_template(spawned=_iso(TODAY - timedelta(days=7)))])
    client.get("/plan/bucket")
    first = _bucket_file(vault).read_text(encoding="utf-8")
    client.get("/plan/bucket")
    assert _bucket_file(vault).read_text(encoding="utf-8") == first


def test_no_stacking_two_missed_occurrences_yield_one_instance(client, vault):
    """Acceptance: two consecutive occurrence dates with an incomplete
    instance yield exactly one live instance, the later due date, missed=1."""
    _write_templates(vault, [_weekly_template(spawned=_iso(TODAY - timedelta(days=14)))])
    r = client.get("/plan/bucket")
    inst = [t for t in r.json()["tasks"] if t["recurrence_id"] == "abc123"]
    assert len(inst) == 1
    assert inst[0]["due_date"] == _iso(TODAY)  # moved forward, not duplicated
    stored = parse_recurring_file((vault / "0-Inbox" / "Plan Week Recurring.md").read_text(encoding="utf-8"))
    assert stored[0].missed == 1
    assert stored[0].spawned == _iso(TODAY)


def test_two_synced_devices_yield_one_instance(client, vault):
    """Acceptance: spawning the same occurrence on two devices converges.
    Device B's bucket (spawned independently) merges with device A's via
    sync; the identical derived line dedupes, a stray duplicate is repaired."""
    _write_templates(vault, [_weekly_template(spawned=_iso(TODAY - timedelta(days=7)))])
    client.get("/plan/bucket")
    content = _bucket_file(vault).read_text(encoding="utf-8")
    # Simulate a sync merge that duplicated the instance line
    lines = content.split("\n")
    inst_line = next(l for l in lines if "~rabc123" in l)
    lines.insert(lines.index(inst_line) + 1, inst_line)
    _bucket_file(vault).write_text("\n".join(lines), encoding="utf-8")
    r = client.get("/plan/bucket")
    inst = [t for t in r.json()["tasks"] if t["recurrence_id"] == "abc123"]
    assert len(inst) == 1
    assert _bucket_file(vault).read_text(encoding="utf-8").count("~rabc123") == 1


def test_paused_templates_spawn_nothing(client, vault):
    _write_templates(vault, [_weekly_template(
        state="paused", spawned=_iso(TODAY - timedelta(days=7)))])
    r = client.get("/plan/bucket")
    assert [t for t in r.json()["tasks"] if t["recurrence_id"]] == []


def test_interval_templates_never_auto_spawn(client, vault):
    _write_templates(vault, [_weekly_template(
        repeat="every 2w", next_action="propose a date",
        last_done=_iso(TODAY - timedelta(days=60)))])
    r = client.get("/plan/bucket")
    assert [t for t in r.json()["tasks"] if t["recurrence_id"]] == []


def test_completion_credits_the_template(client, vault):
    _write_templates(vault, [_weekly_template(
        spawned=_iso(TODAY), missed=2, last_done=_iso(TODAY - timedelta(days=7)))])
    week = vault / "0-Inbox" / "Plan Week.md"
    year, wk, _ = TODAY.isocalendar()
    week.write_text(
        f"Week {year}-wk{wk:02d}\n\n##### Mon 1\n- [x] C1: water plants ~es ~rabc123\n",
        encoding="utf-8",
    )
    client.get("/plan/bucket")
    stored = parse_recurring_file((vault / "0-Inbox" / "Plan Week Recurring.md").read_text(encoding="utf-8"))
    assert stored[0].last_done == _iso(TODAY)
    assert stored[0].missed == 0


def test_no_stacking_moves_due_date_on_a_scheduled_instance(client, vault):
    """A live instance sitting in the week file gets its ~du moved in place."""
    _write_templates(vault, [_weekly_template(spawned=_iso(TODAY - timedelta(days=7)))])
    week = vault / "0-Inbox" / "Plan Week.md"
    year, wk, _ = TODAY.isocalendar()
    old_due = _iso(TODAY - timedelta(days=7))
    week.write_text(
        f"Week {year}-wk{wk:02d}\n\n##### Mon 1\n- [ ] C1: water plants ~es ~rabc123 ~du{old_due}\n",
        encoding="utf-8",
    )
    client.get("/plan/bucket")
    content = week.read_text(encoding="utf-8")
    assert f"~du{_iso(TODAY)}" in content
    assert f"~du{old_due}" not in content
    # And no second copy was spawned into the bucket
    r = client.get("/plan/bucket")
    assert [t for t in r.json()["tasks"] if t["recurrence_id"]] == []
    stored = parse_recurring_file((vault / "0-Inbox" / "Plan Week Recurring.md").read_text(encoding="utf-8"))
    assert stored[0].missed == 1


# ── Creation gate ─────────────────────────────────────────────

def test_template_without_size_is_refused(client, vault):
    r = client.post("/plan/recurrence/save", json={"templates": [
        {"title": "pay bill", "repeat": "monthly on 25"},
    ]})
    assert r.status_code == 422
    assert "size" in r.json()["detail"]


def test_interval_template_without_next_action_is_refused(client, vault):
    r = client.post("/plan/recurrence/save", json={"templates": [
        {"title": "visit customer", "repeat": "every 6w", "size": "m"},
    ]})
    assert r.status_code == 422
    assert "coordination step" in r.json()["detail"]


def test_calendar_template_needs_no_next_action(client, vault):
    """A calendar template is its own next action (Jan's GTD call)."""
    r = client.post("/plan/recurrence/save", json={"templates": [
        {"title": "pay bill", "repeat": "monthly on 25", "size": "s"},
    ]})
    assert r.status_code == 200
    stored = parse_recurring_file((vault / "0-Inbox" / "Plan Week Recurring.md").read_text(encoding="utf-8"))
    assert stored[0].id  # stamped
    assert stored[0].created  # stamped


def test_template_note_cannot_be_a_work_item(client, vault):
    r = client.post("/plan/recurrence/save", json={"templates": [
        {"title": "pay bill", "repeat": "monthly on 25", "size": "s", "note": "Plan Week Bucket"},
    ]})
    assert r.status_code == 422
    assert "work-item" in r.json()["detail"]


def test_gate_reports_every_failure_not_the_first(client, vault):
    r = client.post("/plan/recurrence/save", json={"templates": [
        {"title": "a", "repeat": "nonsense"},
        {"title": "b", "repeat": "every 2w"},
    ]})
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert "repeat" in detail and "size" in detail and "coordination step" in detail


# ── Born-ready invariant on the bucket save gate ──────────────

def _instance_payload(stage: str, rid: str = "abc123", text: str = "water plants ~i111111"):
    return {
        "text": text, "stage": stage, "estimate": "s",
        "recurrence_id": rid, "due_date": _iso(TODAY),
    }


def test_an_instance_cannot_be_captured_or_binding(client, vault):
    for stage in ("captured", "binding"):
        r = client.post("/plan/bucket/save", json={
            "tasks": [_instance_payload(stage)],
            "schema_version": BUCKET_SCHEMA_VERSION,
        })
        assert r.status_code == 422, stage
        assert "template" in r.json()["detail"]


def test_a_save_with_two_live_copies_is_refused(client, vault):
    r = client.post("/plan/bucket/save", json={
        "tasks": [
            _instance_payload("ready"),
            _instance_payload("ready", text="water plants again ~i222222"),
        ],
        "schema_version": BUCKET_SCHEMA_VERSION,
    })
    assert r.status_code == 422
    assert "one live copy" in r.json()["detail"]


# ── Interval lapse ────────────────────────────────────────────

def test_lapse_measured_from_last_completion():
    t = _weekly_template(repeat="every 6w", next_action="propose a date")
    t.last_done = _iso(TODAY - timedelta(days=41))
    assert not lapsed(t, TODAY)
    t.last_done = _iso(TODAY - timedelta(days=42))
    assert lapsed(t, TODAY)


def test_never_completed_template_lapses_after_creation():
    t = _weekly_template(repeat="every 6w", next_action="propose a date",
                         created=_iso(TODAY - timedelta(days=42)), last_done="")
    assert lapsed(t, TODAY)


def test_deferred_template_stays_out_of_the_review():
    t = _weekly_template(repeat="every 6w", next_action="propose a date",
                         last_done=_iso(TODAY - timedelta(days=100)))
    assert lapsed(t, TODAY)
    t.deferred = _iso(TODAY + timedelta(days=3))
    assert not lapsed(t, TODAY)


def test_get_recurrence_reports_lapsed_and_threshold(client, vault):
    _write_templates(vault, [
        _weekly_template(id="aaaaaa", title="visit x", repeat="every 2w",
                         next_action="propose a date",
                         last_done=_iso(TODAY - timedelta(days=30))),
        _weekly_template(id="bbbbbb", title="chore", missed=3, spawned=_iso(TODAY)),
    ])
    data = client.get("/plan/recurrence").json()
    assert data["lapsed_ids"] == ["aaaaaa"]
    assert data["threshold_ids"] == ["bbbbbb"]


# ── Review actions: accept / defer / demote ───────────────────

def _interval_template(**overrides):
    fields = dict(
        id="abc123", title="visit customer x", repeat="every 6w", size="m",
        group="Work", next_action="propose a date to X", state="active",
        created=_iso(TODAY - timedelta(days=100)),
        last_done=_iso(TODAY - timedelta(days=50)),
    )
    fields.update(overrides)
    return RecurrenceTemplate(**fields)


def test_accept_creates_one_ready_instance_without_due_date(client, vault):
    _write_templates(vault, [_interval_template()])
    r = client.post("/plan/recurrence/accept", json={"id": "abc123"})
    assert r.json()["status"] == "created"
    tasks = client.get("/plan/bucket").json()["tasks"]
    inst = [t for t in tasks if t["recurrence_id"] == "abc123"]
    assert len(inst) == 1
    assert inst[0]["stage"] == "ready"
    assert inst[0]["due_date"] == ""  # the actual date needs agreeing with a human
    assert inst[0]["subtasks"][0]["text"] == "propose a date to X"
    # Idempotent: a second accept (other device, double tap) creates nothing
    r2 = client.post("/plan/recurrence/accept", json={"id": "abc123"})
    assert r2.json()["status"] == "exists"
    tasks2 = client.get("/plan/bucket").json()["tasks"]
    assert len([t for t in tasks2 if t["recurrence_id"] == "abc123"]) == 1


def test_accept_refuses_calendar_templates(client, vault):
    _write_templates(vault, [_weekly_template()])
    r = client.post("/plan/recurrence/accept", json={"id": "abc123"})
    assert r.status_code == 400


def test_accepted_template_leaves_the_lapsed_list(client, vault):
    _write_templates(vault, [_interval_template()])
    assert client.get("/plan/recurrence").json()["lapsed_ids"] == ["abc123"]
    client.post("/plan/recurrence/accept", json={"id": "abc123"})
    assert client.get("/plan/recurrence").json()["lapsed_ids"] == []


def test_defer_increments_missed_and_waits_for_next_review(client, vault):
    _write_templates(vault, [_interval_template()])
    r = client.post("/plan/recurrence/defer", json={"id": "abc123"})
    assert r.status_code == 200
    until = r.json()["until"]
    assert until > _iso(TODAY)
    stored = parse_recurring_file((vault / "0-Inbox" / "Plan Week Recurring.md").read_text(encoding="utf-8"))
    assert stored[0].missed == 1
    assert stored[0].deferred == until
    assert client.get("/plan/recurrence").json()["lapsed_ids"] == []


def test_demote_retires_the_template_and_creates_a_habit(client, vault):
    """The conversion path is a migration — retire plus create, carrying the
    note link and a weekly target (day steering doesn't exist on habits)."""
    _write_templates(vault, [_weekly_template(
        repeat="weekly on mon thu", note="Plant care", missed=3)])
    r = client.post("/plan/recurrence/demote", json={"id": "abc123", "domain": "soul"})
    assert r.status_code == 200
    assert r.json()["habit"] == "water plants"
    stored = parse_recurring_file((vault / "0-Inbox" / "Plan Week Recurring.md").read_text(encoding="utf-8"))
    assert stored[0].state == "retired"
    habits_text = (vault / "0-Inbox" / "Plan Week Habits.md").read_text(encoding="utf-8")
    assert "- water plants: 2x/week, [[Plant care]]" in habits_text
    assert "## Soul" in habits_text


def test_retiring_never_touches_completed_instances(client, vault):
    """Done items stay done, in place — retire only flips the template."""
    _write_templates(vault, [_weekly_template(spawned=_iso(TODAY))])
    week = vault / "0-Inbox" / "Plan Week.md"
    year, wk, _ = TODAY.isocalendar()
    done_line = "- [x] C1: water plants ~es ~rabc123"
    week.write_text(f"Week {year}-wk{wk:02d}\n\n##### Mon 1\n{done_line}\n", encoding="utf-8")
    client.post("/plan/recurrence/demote", json={"id": "abc123", "domain": "body"})
    assert done_line in week.read_text(encoding="utf-8")


# ── Week close: misses route to the template, never slip_count ─

def _stale_week_label():
    iso = TODAY.isocalendar()
    wk = iso[1] - 1 if iso[1] > 1 else 52
    yr = iso[0] if iso[1] > 1 else iso[0] - 1
    return f"{yr}-wk{wk:02d}"


def test_week_close_routes_instance_slips_to_the_template(client, vault):
    """Acceptance (stage 4): a recurring instance committed to a closing week
    leaves slip_count untouched and increments its template's missedStreak."""
    _write_templates(vault, [_weekly_template(spawned=_iso(TODAY))])
    (vault / "0-Inbox" / "Plan Week Bucket.md").write_text(
        "# Planning Bucket\n\n"
        "- nA: ordinary thing ~s:ready ~e:s ~i111111\n"
        "- nB: water plants ~s:ready ~e:s ~rabc123 ~i222222\n",
        encoding="utf-8",
    )
    (vault / "0-Inbox" / "Plan Week.md").write_text(
        f"## Goals\n\nWeek {_stale_week_label()}\n\n##### Monday 01.01\n\n#### Notes\n",
        encoding="utf-8",
    )
    r = client.get("/plan/week?offset=0")
    assert r.status_code == 200
    from backend.routers.plan import _parse_bucket_file, _strip_bucket_meta
    tasks, _ = _parse_bucket_file((vault / "0-Inbox" / "Plan Week Bucket.md").read_text(encoding="utf-8"))
    by_label = {_strip_bucket_meta(t.text): t for t in tasks}
    assert by_label["ordinary thing"].slip_count == 1
    assert by_label["water plants"].slip_count == 0
    stored = parse_recurring_file((vault / "0-Inbox" / "Plan Week Recurring.md").read_text(encoding="utf-8"))
    assert stored[0].missed == 1


def test_week_close_credits_a_done_instance_before_archiving(client, vault):
    """A copy checked off in the closing week (perhaps synced in unread)
    credits the template before the file leaves for the archive."""
    _write_templates(vault, [_weekly_template(
        spawned=_iso(TODAY), missed=2, last_done=_iso(TODAY - timedelta(days=30)))])
    (vault / "0-Inbox" / "Plan Week.md").write_text(
        f"## Goals\n\nWeek {_stale_week_label()}\n\n"
        "##### Monday 01.01\n- [x] C1: water plants ~es ~rabc123\n\n#### Notes\n",
        encoding="utf-8",
    )
    r = client.get("/plan/week?offset=0")
    assert r.status_code == 200
    stored = parse_recurring_file((vault / "0-Inbox" / "Plan Week Recurring.md").read_text(encoding="utf-8"))
    assert stored[0].last_done == _iso(TODAY)
    assert stored[0].missed == 0


# ── Basic mode ────────────────────────────────────────────────

def test_pass_is_a_noop_in_basic_mode(client, vault, monkeypatch):
    from backend.config import config as cfg
    monkeypatch.setattr(type(cfg), "funnel_enabled", property(lambda self: False))
    _write_templates(vault, [_weekly_template(spawned=_iso(TODAY - timedelta(days=7)))])
    run_recurrence_pass()
    assert not _bucket_file(vault).exists() or "~rabc123" not in _bucket_file(vault).read_text(encoding="utf-8")


# ── Token round trip ──────────────────────────────────────────

def test_recurrence_tokens_round_trip_the_bucket_file():
    from backend.routers.plan import _format_bucket_tasks, _parse_bucket_file
    from backend.models import BucketTask
    t = BucketTask(text="Home: water plants ~i111111", stage="ready", estimate="s",
                   recurrence_id="abc123", due_date="2026-08-25")
    text = _format_bucket_tasks([t], [])
    assert "~rabc123" in text and "~du2026-08-25" in text
    back, _ = _parse_bucket_file(text)
    assert back[0].recurrence_id == "abc123"
    assert back[0].due_date == "2026-08-25"
    assert "~r" not in back[0].text and "~du" not in back[0].text
