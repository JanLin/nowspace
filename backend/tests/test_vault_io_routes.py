"""The routes go through vault_io — the guard and the conflict rule, end to end.

Seam 1 is only worth having if the baseline itself uses it: a helper no route
touches is a helper nobody has tested, and this is the module whose bugs
corrupt a synced vault.
"""

import os

from backend.models import BUCKET_SCHEMA_VERSION

WEEK = """## Goals
-

Week 2026-wk32

##### Mon 3
- [ ] B1: first task
##### Tue 4
##### Wed 5
##### Thu 6
##### Fri 7
##### Sat 8
##### Sun 9

#### Notes
"""

CONFLICT_NAME = "Plan Week.sync-conflict-20260804-120000-ABCDEFG.md"


def _week_file(vault):
    p = vault / "0-Inbox" / "Plan Week.md"
    p.write_text(WEEK, encoding="utf-8")
    return p


def test_save_week_refuses_a_file_that_moved(client, vault):
    plan = _week_file(vault)
    stale = plan.stat().st_mtime - 5
    os.utime(plan, (stale + 4, stale + 4))

    r = client.post("/plan/save-week", json={
        "days": [{"day": "monday", "heading": "##### Mon 3", "tasks": []}],
        "offset": 0,
        "expected_mtime": stale,
    })
    assert r.status_code == 409
    assert "reload before saving" in r.json()["detail"]
    # and the day's task is still there — nothing was written
    assert "first task" in plan.read_text(encoding="utf-8")


def test_save_week_accepts_a_current_mtime_and_reports_the_new_one(client, vault):
    plan = _week_file(vault)
    r = client.post("/plan/save-week", json={
        "days": [{"day": "monday", "heading": "##### Mon 3",
                  "tasks": [{"text": "second task", "done": False, "priority": "B"}]}],
        "offset": 0,
        "expected_mtime": plan.stat().st_mtime,
    })
    assert r.status_code == 200, r.text
    assert "second task" in plan.read_text(encoding="utf-8")
    # the returned mtime is the file's, so the client's next save guards on it
    assert abs(r.json()["mtime"] - plan.stat().st_mtime) < 0.001


def test_save_bucket_refuses_a_file_that_moved(client, vault):
    bucket = vault / "0-Inbox" / "Plan Week Bucket.md"
    bucket.write_text("# Bucket\n\n- [ ] C: an idea\n", encoding="utf-8")
    stale = bucket.stat().st_mtime - 5
    os.utime(bucket, (stale + 4, stale + 4))

    r = client.post("/plan/bucket/save", json={
        "tasks": [], "pinned_groups": [],
        "expected_mtime": stale,
        "schema_version": BUCKET_SCHEMA_VERSION,
    })
    assert r.status_code == 409
    assert "an idea" in bucket.read_text(encoding="utf-8")


def test_notes_route_refuses_to_read_a_conflict_copy(client, vault):
    p = vault / "0-Inbox" / CONFLICT_NAME
    p.write_text("the stale copy\n", encoding="utf-8")
    r = client.get("/api/notes/read", params={"path": f"0-Inbox/{CONFLICT_NAME}"})
    assert r.status_code == 409
    assert "conflict" in r.json()["detail"].lower()


def test_notes_route_refuses_to_write_a_conflict_copy(client, vault):
    p = vault / "0-Inbox" / CONFLICT_NAME
    p.write_text("the stale copy\n", encoding="utf-8")
    r = client.post("/api/notes/write", json={
        "path": f"0-Inbox/{CONFLICT_NAME}", "content": "overwritten\n",
    })
    assert r.status_code == 409
    assert p.read_text(encoding="utf-8") == "the stale copy\n"


def test_conflict_copies_are_not_offered_by_the_vault_routes(client, vault):
    """Not listed, not searchable, not resolvable — so nothing opens one."""
    (vault / "0-Inbox" / CONFLICT_NAME).write_text("stale\n", encoding="utf-8")
    (vault / "0-Inbox" / "Plan Week.md").write_text(WEEK, encoding="utf-8")

    listing = client.get("/api/vault/folder", params={"path": "0-Inbox"}).json()
    names = [f["path"] for f in listing["files"]]
    assert not any("sync-conflict" in n for n in names), names

    client.post("/api/vault/index")  # rebuild against this vault
    hits = client.get("/api/vault/search", params={"q": "Plan Week"}).json()["results"]
    assert not any("sync-conflict" in h["path"] for h in hits), hits


def test_a_note_is_written_atomically(client, vault):
    """No temp file left in the vault after a write."""
    r = client.post("/api/notes/write", json={
        "path": "0-Inbox/fresh.md", "content": "# Fresh\n",
    })
    assert r.status_code == 200
    names = sorted(p.name for p in (vault / "0-Inbox").iterdir())
    assert names == ["fresh.md"], names
