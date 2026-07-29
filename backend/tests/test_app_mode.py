"""Basic vs Advanced: what the funnel switch does to the vault and the gate."""

import pytest


@pytest.fixture
def bucket(vault):
    """A bucket with one plain item and one carrying full funnel state."""
    (vault / "0-Inbox").mkdir(exist_ok=True)
    (vault / "0-Inbox" / "Plan Week Bucket.md").write_text(
        "## Bucket\n"
        "- plain gtd task ~w2630 ~iaaa111\n"
        "- shaped task ~w2630 ~ibbb222 ~s:binding ~e:m ~se:2026-07-20\n"
        "\t- ? what would make this worth doing?\n",
        encoding="utf-8",
    )
    return vault


def test_defaults_to_advanced(client):
    """Anyone already using the funnel keeps it on upgrade."""
    app = client.get("/api/settings").json()["app"]
    assert app["mode"] == "advanced" and app["funnel"] is True


def test_mode_round_trips(client):
    client.post("/api/settings/app", json={"mode": "basic"})
    assert client.get("/api/settings").json()["app"] == {
        "mode": "basic", "funnel": False, "handoff": False,
    }
    client.post("/api/settings/app", json={"mode": "advanced"})
    assert client.get("/api/settings").json()["app"]["funnel"] is True


def test_funnel_is_an_option_inside_advanced(client):
    """Advanced reveals the switches; it doesn't turn them on for you."""
    client.post("/api/settings/app", json={"mode": "advanced", "funnel": False})
    app = client.get("/api/settings").json()["app"]
    assert app["mode"] == "advanced" and app["funnel"] is False
    # and Basic overrides it whatever the flag says
    client.post("/api/settings/app", json={"mode": "basic", "funnel": True})
    assert client.get("/api/settings").json()["app"]["funnel"] is False


def test_ready_gate_follows_the_funnel_flag_not_the_mode(client, bucket):
    """Advanced with the funnel off schedules like Basic — the gate exists to
    serve the funnel, so it goes quiet with it."""
    (bucket / "0-Inbox" / "Plan Week.md").write_text(
        "Week 2026-wk30\n\n##### Monday 20.07\n\n#### Notes\n", encoding="utf-8")
    client.post("/api/settings/app", json={"mode": "advanced", "funnel": False})
    r = client.post("/plan/bucket/move", json={
        "task_index": 0, "direction": "from_bucket", "day_idx": 0,
        "week_offset": 0, "schema_version": 2,
    })
    assert r.status_code == 200, r.text


def test_rejects_an_unknown_mode(client):
    assert client.post("/api/settings/app", json={"mode": "expert"}).status_code == 400


def test_handoff_follows_configured_areas_until_chosen(client, vault):
    from backend.config import config

    assert client.get("/api/settings").json()["app"]["handoff"] is False
    config._save_vault_settings({"areas": [{"name": "a", "root": "2-Areas/A"}]})
    assert client.get("/api/settings").json()["app"]["handoff"] is True
    client.post("/api/settings/app", json={"handoff": False})  # an explicit no sticks
    assert client.get("/api/settings").json()["app"]["handoff"] is False


def test_basic_reads_past_funnel_tokens_without_erasing_them(client, bucket):
    """The whole point: Basic ignores stage data, it never destroys it.

    Another installation (or your earlier self) wrote ~s:/~e: tokens. Basic
    must round-trip them untouched, or switching back — or a second instance
    still in Advanced — would find its funnel state gone.
    """
    client.post("/api/settings/app", json={"mode": "basic"})
    body = client.get("/plan/bucket").json()
    # save the bucket back exactly as Basic would see it
    r = client.post("/plan/bucket/save", json={
        "tasks": body["tasks"], "pinned_groups": body.get("pinned_groups", []),
        "schema_version": 2,
    })
    assert r.status_code == 200, r.text
    text = (bucket / "0-Inbox" / "Plan Week Bucket.md").read_text(encoding="utf-8")
    assert "~s:binding" in text
    assert "~e:m" in text
    assert "? what would make this worth doing?" in text


def test_ready_gate_applies_in_advanced(client, bucket):
    (bucket / "0-Inbox" / "Plan Week.md").write_text(
        "Week 2026-wk30\n\n##### Monday 20.07\n\n#### Notes\n", encoding="utf-8")
    r = client.post("/plan/bucket/move", json={
        "task_index": 0, "direction": "from_bucket", "day_idx": 0,
        "week_offset": 0, "schema_version": 2,
    })
    assert r.status_code == 400 and "Ready" in r.json()["detail"]


def test_basic_can_schedule_without_a_stage(client, bucket):
    """With no stages in the UI or the file, a gate on stage would strand
    every task in the bucket."""
    (bucket / "0-Inbox" / "Plan Week.md").write_text(
        "Week 2026-wk30\n\n##### Monday 20.07\n\n#### Notes\n", encoding="utf-8")
    client.post("/api/settings/app", json={"mode": "basic"})
    r = client.post("/plan/bucket/move", json={
        "task_index": 0, "direction": "from_bucket", "day_idx": 0,
        "week_offset": 0, "schema_version": 2,
    })
    assert r.status_code == 200, r.text
    week = (bucket / "0-Inbox" / "Plan Week.md").read_text(encoding="utf-8")
    assert "plain gtd task" in week
