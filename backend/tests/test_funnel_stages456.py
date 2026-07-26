"""Funnel stages 4–6: slippage at week close, the slate cutoff, diagnostics."""

from datetime import date

from backend.routers import plan as plan_mod
from backend.routers.plan import _parse_bucket_file


BUCKET = "Plan Week Bucket.md"


def _write_bucket(vault, content):
    (vault / "0-Inbox" / BUCKET).write_text(content)


# ── Stage 4: slips increment when a week closes ─────────────────

def test_week_close_increments_slips(client, vault):
    _write_bucket(
        vault,
        "# Planning Bucket\n\n"
        "- nA: committed thing ~s:ready ~e:s\n"
        "\t- step one\n"
        "- nwB: next week thing ~s:ready ~e:s\n"
        "\t- step\n"
        "- loose thought\n",
    )
    # A stale week file (last week) triggers the auto-transition on GET
    iso = date.today().isocalendar()
    stale_week = iso[1] - 1 if iso[1] > 1 else 52
    stale_year = iso[0] if iso[1] > 1 else iso[0] - 1
    (vault / "0-Inbox" / "Plan Week.md").write_text(
        f"## Goals\n\nWeek {stale_year}-wk{stale_week:02d}\n\n"
        "##### Monday 01.01\n\n#### Notes\n"
    )
    r = client.get("/plan/week?offset=0")
    assert r.status_code == 200
    tasks, _ = _parse_bucket_file((vault / "0-Inbox" / BUCKET).read_text())
    by_label = {plan_mod._strip_bucket_meta(t.text): t for t in tasks}
    # horizon n + ready = committed to the closed week → slipped
    assert by_label["committed thing"].slip_count == 1
    # nw and captured items did not slip
    assert by_label["next week thing"].slip_count == 0
    assert by_label["loose thought"].slip_count == 0


# ── Stage 5: the slate cutoff is server-side ────────────────────

SLATE_BUCKET = (
    "# Planning Bucket\n\n"
    "- open problem ~s:binding\n"
    "\t- ? What should the roadmap optimise for?\n"
    "- practice item ~s:binding ~rh\n"
    "\t- ? Which form takes a genitive?\n"
)


def test_slate_daytime_shows_solve_only(client, vault, monkeypatch):
    _write_bucket(vault, SLATE_BUCKET)
    monkeypatch.setattr(plan_mod, "_is_evening", lambda: False)
    r = client.get("/plan/slate")
    assert r.status_code == 200
    items = r.json()["items"]
    assert [i["mode"] for i in items] == ["solve"]
    assert "roadmap" in items[0]["question"]


def test_slate_evening_hides_solve_entirely(client, vault, monkeypatch):
    """Acceptance: after the cutoff, no solve item is reachable from the slate."""
    _write_bucket(vault, SLATE_BUCKET)
    monkeypatch.setattr(plan_mod, "_is_evening", lambda: True)
    r = client.get("/plan/slate")
    body = r.json()
    assert body["evening"] is True
    assert [i["mode"] for i in body["items"]] == ["rehearse"]
    assert all("roadmap" not in (i["question"] + i["label"]) for i in body["items"])


def test_slate_capture_lands_as_captured(client, vault):
    _write_bucket(vault, "# Planning Bucket\n")
    r = client.post("/plan/slate/capture", json={"text": "thought before sleep"})
    assert r.status_code == 200
    tasks, _ = _parse_bucket_file((vault / "0-Inbox" / BUCKET).read_text())
    assert len(tasks) == 1
    assert tasks[0].stage == "captured"


# ── Stage 6: diagnostics are system metrics ─────────────────────

def test_funnel_stats_shape(client, vault):
    _write_bucket(
        vault,
        "# Planning Bucket\n\n"
        "- Grp: slipped one ~s:ready ~e:s ~sl:2 ~rs:2026-07-01 ~se:2026-07-01\n"
        "\t- step\n"
        "- Grp: fresh one ~s:ready ~e:m ~rs:2026-07-20 ~se:2026-07-20\n"
        "\t- step\n"
        "- idea ~w2620\n",
    )
    r = client.get("/plan/funnel/stats")
    assert r.status_code == 200
    body = r.json()
    assert body["stages"]["ready"]["count"] == 2
    assert body["stages"]["captured"]["count"] == 1
    grp = body["slip_by_group"]["Grp"]
    assert grp == {"ready_items": 2, "slipped_items": 1, "total_slips": 2}
    # slip count and age-in-ready are separate figures — both present, never combined
    assert "ready_age_days" in body
    assert body["ready_age_days"]["avg"] is not None


def test_transitions_are_logged(client, vault):
    _write_bucket(vault, "# Planning Bucket\n\n- topic ~s:binding\n\t- ? topic?\n")
    tasks, _ = _parse_bucket_file((vault / "0-Inbox" / BUCKET).read_text())
    tasks[0].stage = "dormant"
    tasks[0].wake_date = "2026-10-01"
    r = client.post("/plan/bucket/save", json={
        "tasks": [t.model_dump() for t in tasks], "pinned_groups": [],
        "schema_version": 2,
    })
    assert r.status_code == 200
    log = (vault / "0-Inbox" / "Plan Week Funnel Log.md").read_text()
    assert "binding->dormant: topic" in log
    stats = client.get("/plan/funnel/stats").json()
    assert stats["binding_exits"]["dormant"] == 1
