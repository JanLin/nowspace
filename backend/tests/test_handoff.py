"""Handoff acceptance tests (stages A–D of the handoff brief).

Stage A: an embed resolving outside its area cannot be dispatched; a symlink
out of the area is detected; captured items have no dispatch route; rehearse
items cannot be dispatched.
Stage B: opening a fourth in-flight dispatch is impossible.
Stage C: agent output only ever enters as captured; never edits an item.
Stage D: the canary harness — a stray cross-area token is a test failure.
"""

import os

import pytest

from backend import handoff, vault_index
from backend.routers.plan import _parse_bucket_file


BUCKET = "Plan Week Bucket.md"


@pytest.fixture
def areas_vault(vault, monkeypatch):
    """Two customer areas with agent bindings, group mappings, and a bucket."""
    from backend.config import config

    for name in ("Customer-A", "Customer-B"):
        root = vault / "2-Areas" / name
        (root / "_agent" / "proposals").mkdir(parents=True)
        (root / "_agent" / "transcripts").mkdir(parents=True)
        (root / f"{name} notes.md").write_text(f"# {name}\n\nInternal notes for {name}.\n")

    config._save_vault_settings({
        "areas": [
            {"name": "customer-a", "root": "2-Areas/Customer-A",
             "agent_binding": "agent-a",
             "proposals_path": "2-Areas/Customer-A/_agent/proposals",
             "transcripts_path": "2-Areas/Customer-A/_agent/transcripts"},
            {"name": "customer-b", "root": "2-Areas/Customer-B",
             "agent_binding": "agent-b",
             "proposals_path": "2-Areas/Customer-B/_agent/proposals",
             "transcripts_path": "2-Areas/Customer-B/_agent/transcripts"},
        ],
        "reference_links": {"custa": "2-Areas/Customer-A", "custb": "2-Areas/Customer-B"},
    })

    (vault / "0-Inbox" / BUCKET).write_text(
        "# Planning Bucket\n\n"
        "- CustA: fix the reporting export ~s:ready ~e:m\n"
        "\t- reproduce the broken export\n"
        "- CustA: unscoped idea\n"
        "- CustA: practice the API auth flow ~s:binding ~rh\n"
        "\t- ? Which header carries the token?\n"
        "- CustB: review their contract ~s:ready ~e:s\n"
        "\t- read section 4\n"
    )
    vault_index.refresh_index()
    return vault


def _dispatch(client, source, area="customer-a", notes=None, artifact="diagnosis"):
    return client.post("/api/handoff/dispatches", json={
        "source_text": source, "area": area,
        "attached_notes": notes or [], "expected_artifact": artifact,
    })


# ── Stage A ─────────────────────────────────────────────────────

def test_happy_path_dispatch(client, areas_vault):
    r = _dispatch(client, "CustA: fix the reporting export",
                  notes=["2-Areas/Customer-A/Customer-A notes.md"])
    assert r.status_code == 200, r.text
    rec = r.json()
    assert rec["state"] == "drafting"
    assert rec["conformance"] == "pass"
    # The record lives inside the area
    assert (areas_vault / "2-Areas/Customer-A/_dispatch" / f"{rec['id']}.md").exists()


def test_captured_item_has_no_dispatch_route(client, areas_vault):
    r = _dispatch(client, "CustA: unscoped idea")
    assert r.status_code == 400
    assert "Captured" in r.json()["detail"]


def test_rehearse_item_cannot_be_dispatched(client, areas_vault):
    r = _dispatch(client, "CustA: practice the API auth flow")
    assert r.status_code == 400
    assert "Rehearse" in r.json()["detail"]


def test_cross_area_dispatch_refused(client, areas_vault):
    """The area is derived from the item, not chosen on the surface."""
    r = _dispatch(client, "CustB: review their contract", area="customer-a")
    assert r.status_code == 400


def test_attached_note_outside_area_fails(client, areas_vault):
    r = _dispatch(client, "CustA: fix the reporting export",
                  notes=["2-Areas/Customer-B/Customer-B notes.md"])
    assert r.status_code == 422
    assert "outside the area root" in r.json()["detail"]


def test_embed_chain_leaving_area_fails(client, areas_vault):
    """An embed inlines content — a chain out of the area exports it."""
    (areas_vault / "2-Areas/Customer-A/inner.md").write_text(
        "Details here.\n\n![[Customer-B notes]]\n"
    )
    (areas_vault / "2-Areas/Customer-A/outer.md").write_text("![[inner]]\n")
    vault_index.refresh_index()
    r = _dispatch(client, "CustA: fix the reporting export",
                  notes=["2-Areas/Customer-A/outer.md"])
    assert r.status_code == 422
    assert "outside the area" in r.json()["detail"]


def test_link_out_of_area_fails_at_depth_one(client, areas_vault):
    """Link text alone leaks a title — depth-1 links are checked too."""
    (areas_vault / "2-Areas/Customer-A/linky.md").write_text(
        "See [[Customer-B notes]] for comparison.\n"
    )
    vault_index.refresh_index()
    r = _dispatch(client, "CustA: fix the reporting export",
                  notes=["2-Areas/Customer-A/linky.md"])
    assert r.status_code == 422


def test_symlink_out_of_area_detected(client, areas_vault):
    """String-prefix comparison would miss this; canonical paths don't."""
    target = areas_vault / "2-Areas/Customer-B/Customer-B notes.md"
    link = areas_vault / "2-Areas/Customer-A/sneaky.md"
    os.symlink(target, link)
    r = _dispatch(client, "CustA: fix the reporting export",
                  notes=["2-Areas/Customer-A/sneaky.md"])
    assert r.status_code == 422
    assert "outside the area root" in r.json()["detail"]


def test_sibling_prefix_folder_is_outside(client, areas_vault):
    """/vault/Customer-A-old must not match root /vault/Customer-A."""
    old = areas_vault / "2-Areas/Customer-A-old"
    old.mkdir()
    (old / "legacy.md").write_text("old stuff\n")
    r = _dispatch(client, "CustA: fix the reporting export",
                  notes=["2-Areas/Customer-A-old/legacy.md"])
    assert r.status_code == 422


def test_dataview_query_fails_outright(client, areas_vault):
    (areas_vault / "2-Areas/Customer-A/query.md").write_text(
        "```dataview\nlist from \"2-Areas\"\n```\n"
    )
    r = _dispatch(client, "CustA: fix the reporting export",
                  notes=["2-Areas/Customer-A/query.md"])
    assert r.status_code == 422
    assert "Dataview" in r.json()["detail"]


def test_all_failures_reported_not_just_first(client, areas_vault):
    r = client.post("/api/handoff/check", json={
        "source_text": "CustA: fix the reporting export",
        "area": "customer-a",
        "attached_notes": [
            "2-Areas/Customer-B/Customer-B notes.md",
            "2-Areas/Customer-A/does-not-exist.md",
        ],
        "expected_artifact": "diagnosis",
    })
    body = r.json()
    assert body["conformance"] == "fail"
    assert len(body["failures"]) == 2


# ── Stage B: the in-flight WIP limit ────────────────────────────

def test_fourth_in_flight_dispatch_refused(client, areas_vault):
    ids = []
    for i in range(4):
        r = _dispatch(client, "CustA: fix the reporting export")
        assert r.status_code == 200
        ids.append(r.json()["id"])
    for i in range(3):
        r = client.patch(f"/api/handoff/dispatches/customer-a/{ids[i]}", json={"state": "in_flight"})
        assert r.status_code == 200, r.text
    r = client.patch(f"/api/handoff/dispatches/customer-a/{ids[3]}", json={"state": "in_flight"})
    assert r.status_code == 422
    assert "in flight" in r.json()["detail"]


def test_conformance_reruns_before_dispatch(client, areas_vault):
    """Files change: a drafting dispatch whose note grew an external link
    must fail when moved to in_flight."""
    note = areas_vault / "2-Areas/Customer-A/brief-note.md"
    note.write_text("all internal\n")
    vault_index.refresh_index()
    r = _dispatch(client, "CustA: fix the reporting export",
                  notes=["2-Areas/Customer-A/brief-note.md"])
    assert r.status_code == 200
    did = r.json()["id"]
    note.write_text("now links [[Customer-B notes]]\n")
    r = client.patch(f"/api/handoff/dispatches/customer-a/{did}", json={"state": "in_flight"})
    assert r.status_code == 422


# ── Stage C: the return path ────────────────────────────────────

def test_agent_output_enters_as_captured_only(client, areas_vault, monkeypatch):
    import backend.handoff as h
    monkeypatch.setattr(h, "list_returns", h.list_returns)  # no-op, keep real
    prop = areas_vault / "2-Areas/Customer-A/_agent/proposals/idea.md"
    prop.write_text("# Proposal\n\nTry splitting the export by month.\n")
    os.utime(prop, (prop.stat().st_atime, prop.stat().st_mtime - 10))

    r = client.get("/api/handoff/returns?area=customer-a")
    assert any(x["name"] == "idea.md" for x in r.json()["returns"])

    before, _ = _parse_bucket_file((areas_vault / "0-Inbox" / BUCKET).read_text())
    r = client.post("/api/handoff/returns/resolve", json={
        "area": "customer-a", "path": "2-Areas/Customer-A/_agent/proposals/idea.md",
        "action": "capture", "capture_texts": ["CustA: try splitting the export by month"],
    })
    assert r.status_code == 200, r.text
    after, _ = _parse_bucket_file((areas_vault / "0-Inbox" / BUCKET).read_text())
    # exactly one new item, captured, linked to the proposal; nothing edited
    assert len(after) == len(before) + 1
    new = [t for t in after if "[[idea]]" in t.text]
    assert len(new) == 1
    assert new[0].stage == "captured"
    # every pre-existing item survives unchanged (the serializer may regroup,
    # so compare as sets of (text, stage))
    before_set = {(t.text, t.stage) for t in before}
    after_set = {(t.text, t.stage) for t in after if "[[idea]]" not in t.text}
    assert before_set == after_set
    # the Returned lane is emptyable — the file moved to _processed
    assert not prop.exists()
    assert (areas_vault / "2-Areas/Customer-A/_agent/proposals/_processed/idea.md").exists()
    r = client.get("/api/handoff/returns?area=customer-a")
    assert r.json()["returns"] == []


def test_discard_clears_without_touching_bucket(client, areas_vault):
    prop = areas_vault / "2-Areas/Customer-A/_agent/proposals/noise.md"
    prop.write_text("nothing useful\n")
    os.utime(prop, (prop.stat().st_atime, prop.stat().st_mtime - 10))
    before = (areas_vault / "0-Inbox" / BUCKET).read_text()
    r = client.post("/api/handoff/returns/resolve", json={
        "area": "customer-a", "path": "2-Areas/Customer-A/_agent/proposals/noise.md",
        "action": "discard",
    })
    assert r.status_code == 200
    assert (areas_vault / "0-Inbox" / BUCKET).read_text() == before


def test_sync_conflict_files_ignored(client, areas_vault):
    prop = areas_vault / "2-Areas/Customer-A/_agent/proposals/x.sync-conflict-20260726.md"
    prop.write_text("syncthing artifact\n")
    os.utime(prop, (prop.stat().st_atime, prop.stat().st_mtime - 10))
    r = client.get("/api/handoff/returns?area=customer-a")
    assert r.json()["returns"] == []


# ── Stage D: the canary harness ─────────────────────────────────

def test_canary_no_cross_area_tokens(client, areas_vault):
    """Plant a unique token in each area; after a full dispatch/return cycle,
    no file in area A may contain area B's token (and vice versa).

    This is the only thing that tells you whether any of the rest works.
    """
    token_a = "CANARY-AREA-A-7f3e9c"
    token_b = "CANARY-AREA-B-2b8d41"
    (areas_vault / "2-Areas/Customer-A/canary.md").write_text(f"{token_a}\n")
    (areas_vault / "2-Areas/Customer-B/canary.md").write_text(f"{token_b}\n")
    vault_index.refresh_index()

    # A full cycle in area A: dispatch → in_flight → proposal → capture
    r = _dispatch(client, "CustA: fix the reporting export",
                  notes=["2-Areas/Customer-A/canary.md"])
    assert r.status_code == 200
    did = r.json()["id"]
    assert client.patch(f"/api/handoff/dispatches/customer-a/{did}",
                        json={"state": "in_flight"}).status_code == 200
    prop = areas_vault / "2-Areas/Customer-A/_agent/proposals" / f"{did} answer.md"
    prop.write_text(f"proposal referencing {token_a}\n")
    os.utime(prop, (prop.stat().st_atime, prop.stat().st_mtime - 10))
    assert client.post("/api/handoff/returns/resolve", json={
        "area": "customer-a", "path": f"2-Areas/Customer-A/_agent/proposals/{did} answer.md",
        "action": "capture", "capture_texts": ["CustA: follow up on the canary answer"],
    }).status_code == 200

    # Sweep: every file under each area root must be free of the OTHER token
    def sweep(root, forbidden):
        hits = []
        for p in (areas_vault / root).rglob("*"):
            if p.is_file():
                try:
                    if forbidden in p.read_text(encoding="utf-8", errors="ignore"):
                        hits.append(str(p))
                except OSError:
                    pass
        return hits

    assert sweep("2-Areas/Customer-A", token_b) == []
    assert sweep("2-Areas/Customer-B", token_a) == []
    # The bucket (shared inbox) may reference either area's work but must
    # never carry raw content tokens — capture stores text + a link, not
    # note content
    inbox = (areas_vault / "0-Inbox" / BUCKET).read_text()
    assert token_a not in inbox and token_b not in inbox
