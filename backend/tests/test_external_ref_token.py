"""Seam 5: the ~x<6 hex> reference token on a week line.

An item a week source put into the plan carries a reference back to wherever
it came from. The baseline never reads it — it strips it for display and
re-emits it on save — so it has to survive every place a week line is
rewritten: a save, a carry-forward into the next week, and the archive at
transition. Including on an instance where the extension isn't installed,
which is the whole point.
"""

from backend.agents.obsidian_reader import parse_week_plan
from backend.routers.plan import (
    _format_tasks_grouped, _strip_bucket_meta, EXTERNAL_REF_RE, BUCKET_META_RE,
)

REF = "1a2b3c"
LINE = f"review the external draft ~x{REF}"

WEEK = f"""## Goals
-

Week 2026-wk32

##### Mon 3
- [ ] B1: {LINE}
- [ ] C1: an ordinary task
##### Tue 4
##### Wed 5
##### Thu 6
##### Fri 7
##### Sat 8
##### Sun 9

#### Notes
"""


class _T:
    """The shape _format_tasks_grouped reads (it takes attributes)."""
    def __init__(self, text, done=False, priority="B"):
        self.text, self.done, self.priority = text, done, priority
        self.subtasks, self.focused, self.waiting = [], False, False


# ── the token itself ──────────────────────────────────────────────────

def test_the_token_is_colon_free():
    """A colon on a week line is read as a "Group:" prefix — the reason ~es
    and ~i… are spelled the way they are."""
    assert ":" not in f"~x{REF}"
    assert EXTERNAL_REF_RE.search(LINE).group(1) == REF


def test_the_token_is_stripped_for_display():
    assert _strip_bucket_meta(LINE) == "review the external draft"
    assert BUCKET_META_RE.search(f"~x{REF}")


def test_a_non_token_is_not_mistaken_for_one():
    assert EXTERNAL_REF_RE.search("~xyz not a ref") is None
    assert EXTERNAL_REF_RE.search("~x12345") is None      # five hex, not six
    assert _strip_bucket_meta("plain task") == "plain task"


# ── parse → serialize ─────────────────────────────────────────────────

def test_the_token_survives_parse_and_serialize():
    parsed = parse_week_plan(WEEK, "Plan Week.md")
    monday = parsed["days"][0].tasks if hasattr(parsed["days"][0], "tasks") else parsed["days"][0]["tasks"]
    carried = [t for t in monday if EXTERNAL_REF_RE.search(t.text)]
    assert len(carried) == 1, [t.text for t in monday]

    lines = _format_tasks_grouped([_T(t.text, t.done, t.priority or "B") for t in monday])
    assert any(f"~x{REF}" in ln for ln in lines), lines
    # …and it is still the only one, i.e. not duplicated by the round trip
    assert sum(ln.count(f"~x{REF}") for ln in lines) == 1


def test_a_group_prefixed_line_keeps_the_token():
    text = f"Arratech: review the draft ~x{REF}"
    lines = _format_tasks_grouped([_T(text)])
    assert lines[0] == "* Arratech:"
    assert f"~x{REF}" in lines[1]


# ── carry-forward, and the archive ────────────────────────────────────

def _write_week(vault, content=WEEK):
    p = vault / "0-Inbox" / "Plan Week.md"
    p.write_text(content, encoding="utf-8")
    return p


def test_the_token_survives_a_save(client, vault):
    plan = _write_week(vault)
    parsed = parse_week_plan(plan.read_text(encoding="utf-8"), plan.name)
    days = [{"day": d.day, "heading": d.heading,
             "tasks": [{"text": t.text, "done": t.done, "priority": t.priority or "B"} for t in d.tasks]}
            for d in parsed["days"]]
    r = client.post("/plan/save-week", json={"days": days, "offset": 0})
    assert r.status_code == 200, r.text
    assert f"~x{REF}" in plan.read_text(encoding="utf-8")


def test_the_token_survives_a_carry_forward(client, vault):
    _write_week(vault)
    # next week's file, as create-next-week would leave it
    r = client.post("/plan/create-next-week")
    assert r.status_code == 200, r.text

    r = client.post("/plan/carry-forward", json={
        "tasks": [{"text": LINE, "day": "monday", "subtasks": [],
                   "focused": False, "waiting": False, "priority": "B"}],
        "offset": 1,
    })
    assert r.status_code == 200, r.text

    nxt = [p for p in (vault / "0-Inbox").glob("Plan Week - *.md")]
    assert nxt, list((vault / "0-Inbox").iterdir())
    assert f"~x{REF}" in nxt[0].read_text(encoding="utf-8")


def test_the_token_survives_the_week_archive(client, vault):
    """transition_week moves the file into 4-Archive/a0-Inbox."""
    _write_week(vault)
    r = client.post("/plan/transition-week")
    assert r.status_code == 200, r.text

    archived = list((vault / "4-Archive" / "a0-Inbox").glob("Plan Week - *.md"))
    assert archived, list((vault / "4-Archive" / "a0-Inbox").iterdir())
    assert f"~x{REF}" in archived[0].read_text(encoding="utf-8")
