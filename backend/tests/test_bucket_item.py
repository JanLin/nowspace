"""The bucket door: POST /plan/bucket-item — seam 5's "not yet" half.

The week door places an item on a day; this one parks it with a GTD
horizon. Same dedupe across both files: one obligation, one place.
"""

from backend.tests.test_schedule_item import WEEK, _week_file

BUCKET = """# Planning Bucket

- Home:
\t- C: fix the shed door ~w2630 ~iaaaaaa
- Rotary:
\t- B: prepare the routine ~w2631 ~ibbbbbb
"""

REF = "ba538553b6e9"


def _bucket_file(vault):
    p = vault / "0-Inbox" / "Plan Week Bucket.md"
    p.write_text(BUCKET, encoding="utf-8")
    return p


def test_the_item_parks_under_its_group_with_horizon_and_tokens(client, vault):
    _week_file(vault)
    p = _bucket_file(vault)
    r = client.post("/plan/bucket-item", json={
        "group": "Linaltec", "text": "GDC stage invite — decide later",
        "ref": REF, "horizon": "nw", "priority": "B",
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["horizon"] == "nw"
    assert body["line"].startswith("- nwB: GDC stage invite — decide later ~w")
    assert body["line"].endswith(f"~x{REF}")
    text = p.read_text(encoding="utf-8")
    assert "- Linaltec:" in text  # new group created
    assert f"\t- nwB: GDC stage invite — decide later ~w" in text


def test_an_existing_group_gains_the_line_at_its_end(client, vault):
    _week_file(vault)
    p = _bucket_file(vault)
    r = client.post("/plan/bucket-item", json={
        "group": "Home", "text": "another chore", "ref": "a1b2c3", "horizon": "n",
    })
    assert r.status_code == 200, r.text
    lines = p.read_text(encoding="utf-8").split("\n")
    home = lines.index("- Home:")
    rotary = lines.index("- Rotary:")
    added = next(i for i, l in enumerate(lines) if "another chore" in l)
    assert home < added < rotary
    assert lines.count("- Home:") == 1


def test_dedupe_spans_both_files_in_both_directions(client, vault):
    _week_file(vault)
    _bucket_file(vault)
    # Park in the bucket, then try to schedule the same ref into the week.
    assert client.post("/plan/bucket-item", json={
        "group": "X", "text": "t", "ref": REF,
    }).status_code == 200
    r = client.post("/plan/schedule-item", json={"day": "Mon", "text": "t", "ref": REF})
    assert r.status_code == 409 and "bucket" in r.json()["detail"]
    # Schedule another into the week, then try to park it.
    assert client.post("/plan/schedule-item", json={
        "day": "Mon", "text": "u", "ref": "c" * 6,
    }).status_code == 200
    r2 = client.post("/plan/bucket-item", json={"group": "X", "text": "u", "ref": "c" * 6})
    assert r2.status_code == 409 and "week line" in r2.json()["detail"]


def test_bad_horizon_group_and_ref_are_400(client, vault):
    _week_file(vault)
    _bucket_file(vault)
    assert client.post("/plan/bucket-item", json={
        "group": "X", "text": "t", "ref": REF, "horizon": "someday",
    }).status_code == 400
    assert client.post("/plan/bucket-item", json={
        "group": "A: B", "text": "t", "ref": REF,
    }).status_code == 400
    assert client.post("/plan/bucket-item", json={
        "group": "X", "text": "t", "ref": "zz",
    }).status_code == 400
