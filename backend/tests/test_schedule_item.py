"""Seam 5's write half: POST /plan/schedule-item.

An extension surface cannot write a week file — this route is the door. It
appends one referenced line to a day's section through the guarded write,
and refuses everything that would make the week lie: an unknown day, a
malformed ref, a ref already on a line, a ref smuggled inline in the text.
"""

from backend.routers.plan import EXTERNAL_REF_RE

WEEK = """## Goals
-

Week 2026-wk33

##### Mon 10
- [ ] B1: an ordinary task
- [ ] C1: another one
##### Tue 11
##### Wed 12
##### Thu 13
##### Fri 14
##### Sat 15
##### Sun 16

#### Notes
"""

REF = "ba538553b6e9"  # 12 hex — a content-hash ref from a source without ids


def _week_file(vault):
    p = vault / "0-Inbox" / "Plan Week.md"
    p.write_text(WEEK, encoding="utf-8")
    return p


def test_the_line_lands_in_the_day_section_with_its_ref(client, vault):
    p = _week_file(vault)
    r = client.post("/plan/schedule-item", json={
        "day": "Mon", "text": "WG20 virtual-meeting poll — answer", "ref": REF,
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["day"] == "monday"
    assert body["line"] == f"- [ ] B2: WG20 virtual-meeting poll — answer ~x{REF}"

    after = p.read_text(encoding="utf-8").split("\n")
    mon = after.index("##### Mon 10")
    tue = after.index("##### Tue 11")
    assert after[tue - 1] == body["line"]  # end of Monday's tasks, not Tuesday's
    # …and everything else round-tripped byte-identically.
    before = WEEK.split("\n")
    assert [l for l in after if l != body["line"]] == before


def test_sequence_counts_within_the_day_and_priority(client, vault):
    _week_file(vault)
    r1 = client.post("/plan/schedule-item", json={
        "day": "tuesday", "text": "first", "ref": "a" * 6, "priority": "A",
    })
    r2 = client.post("/plan/schedule-item", json={
        "day": "tuesday", "text": "second", "ref": "b" * 6, "priority": "A",
    })
    assert r1.json()["line"].startswith("- [ ] A1:")
    assert r2.json()["line"].startswith("- [ ] A2:")


def test_a_ref_already_on_a_week_line_is_refused_409(client, vault):
    _week_file(vault)
    body = {"day": "Wed", "text": "the obligation", "ref": REF}
    assert client.post("/plan/schedule-item", json=body).status_code == 200
    r = client.post("/plan/schedule-item", json={**body, "day": "Fri"})
    assert r.status_code == 409
    assert "one obligation" in r.json()["detail"]


def test_a_ref_inline_in_the_text_cannot_dodge_the_dedupe(client, vault):
    _week_file(vault)
    r = client.post("/plan/schedule-item", json={
        "day": "Mon", "text": f"sneaky ~x{REF}", "ref": "c" * 6,
    })
    assert r.status_code == 400
    assert "ref" in r.json()["detail"]


def test_unknown_day_and_bad_ref_are_400(client, vault):
    _week_file(vault)
    assert client.post("/plan/schedule-item", json={
        "day": "Someday", "text": "t", "ref": REF,
    }).status_code == 400
    assert client.post("/plan/schedule-item", json={
        "day": "Mon", "text": "t", "ref": "xyz",
    }).status_code == 400


def test_a_stale_read_is_refused_by_the_guard(client, vault):
    p = _week_file(vault)
    r = client.post("/plan/schedule-item", json={
        "day": "Mon", "text": "t", "ref": "d" * 6,
        "expected_mtime": p.stat().st_mtime - 100,
    })
    assert r.status_code == 409


def test_the_scheduled_ref_reads_back_through_the_shared_regex(client, vault):
    p = _week_file(vault)
    client.post("/plan/schedule-item", json={"day": "Sun", "text": "t", "ref": REF})
    found = [m.group(1).lower() for m in EXTERNAL_REF_RE.finditer(p.read_text(encoding="utf-8"))]
    assert found == [REF]  # a 12-hex ref survives the widened pattern
