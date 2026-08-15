"""Funnel stage 1–2 acceptance tests.

Stage 1: an item with no next action or no estimate cannot appear in Timing,
by any route including direct API call.
Stage 2: adding a fifth Binding item is impossible without resolving an
existing one; `question` cannot be empty and must end in '?'.
"""

from datetime import date

from backend.models import BUCKET_SCHEMA_VERSION
from backend.routers.plan import (
    _extract_funnel_meta,
    _format_bucket_tasks,
    _parse_bucket_file,
    _strip_bucket_meta,
)
from backend.models import BucketTask, Subtask


BUCKET = "Plan Week Bucket.md"
WEEK = "Plan Week.md"


def _week_file(vault, monday_task=""):
    iso = date.today().isocalendar()
    label = f"Week {iso[0]}-wk{iso[1]:02d}"
    blocks = []
    for d in ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"):
        block = f"##### {d} 01.01"
        if d == "Monday" and monday_task:
            block += f"\n- [ ] C1: {monday_task}"
        blocks.append(block)
    days = "\n\n".join(blocks)
    (vault / "0-Inbox" / WEEK).write_text(f"## Goals\n\n{label}\n\n{days}\n\n#### Notes\n")


def _write_bucket(vault, content):
    (vault / "0-Inbox" / BUCKET).write_text(content)


def _ready_task(text="Group: bounded thing", **over):
    base = dict(
        text=text, priority="B", stage="ready", estimate="s",
        subtasks=[Subtask(text="do the first step")],
    )
    base.update(over)
    return BucketTask(**base)


# ── Token layer ─────────────────────────────────────────────────

def test_funnel_tokens_round_trip():
    t = BucketTask(
        text="Rotary: fundraiser", priority="A", stage="binding",
        question="What would make the fundraiser worth running?",
        mode="rehearse", estimate="m", slip_count=2,
        ready_since="2026-07-01", wake_date="2026-09-01",
        discard_reason="", stage_entered_at="2026-07-20",
    )
    md = _format_bucket_tasks([t], [])
    parsed, _ = _parse_bucket_file(md)
    assert len(parsed) == 1
    p = parsed[0]
    assert p.stage == "binding"
    assert p.question == "What would make the fundraiser worth running?"
    assert p.mode == "rehearse"
    assert p.estimate == "m"
    assert p.slip_count == 2
    assert p.ready_since == "2026-07-01"
    assert p.wake_date == "2026-09-01"
    assert p.stage_entered_at == "2026-07-20"
    assert "~" not in p.text  # tokens never leak into the label
    assert p.text == "Rotary: fundraiser"


def test_extract_strips_all_tokens():
    clean, fields = _extract_funnel_meta(
        "call the bank ~s:dormant ~wake:2026-08-01 ~sl:3"
    )
    assert clean == "call the bank"
    assert fields == {"stage": "dormant", "wake_date": "2026-08-01", "slip_count": 3}
    assert _strip_bucket_meta("x ~s:ready ~e:s ~w2628 ~m") == "x"


def test_migration_defaults():
    """Pre-funnel items: prioritised/horizoned → ready, others → captured."""
    md = (
        "# Planning Bucket\n\n"
        "- Rotary:\n"
        "\t- nA: fundraiser ~w2624\n"
        "\t- plan next meeting ~w2628\n"
        "- C: renew domains\n"
        "- someday woodworking\n"
    )
    tasks, _ = _parse_bucket_file(md)
    by_label = {_strip_bucket_meta(t.text): t.stage for t in tasks}
    assert by_label["Rotary: fundraiser"] == "ready"
    assert by_label["Rotary: plan next meeting"] == "captured"
    assert by_label["renew domains"] == "ready"
    assert by_label["someday woodworking"] == "captured"


def test_question_persists_as_subtask_line():
    t = BucketTask(text="topic", stage="binding", question="Is this mine to solve?")
    md = _format_bucket_tasks([t], [])
    assert "- ? Is this mine to solve?" in md
    parsed, _ = _parse_bucket_file(md)
    assert parsed[0].question == "Is this mine to solve?"
    assert parsed[0].subtasks == []


# ── Stage 1: the ready gate on Timing ───────────────────────────

def test_move_refuses_non_ready(client, vault):
    _week_file(vault)
    _write_bucket(vault, "# Planning Bucket\n\n- unbounded topic\n")
    r = client.post("/plan/bucket/move", json={
        "task_index": 0, "direction": "from_bucket", "day_idx": 0, "schema_version": BUCKET_SCHEMA_VERSION,
    })
    assert r.status_code == 400
    assert "Ready" in r.json()["detail"]


def test_move_allows_ready_and_preserves_binding_artifacts(client, vault):
    _week_file(vault)
    _write_bucket(
        vault,
        "# Planning Bucket\n\n"
        "- B: bounded thing ~s:ready ~e:s ~rs:2026-07-01\n"
        "\t- do the first step\n",
    )
    r = client.post("/plan/bucket/move", json={
        "task_index": 0, "direction": "from_bucket", "day_idx": 0, "schema_version": BUCKET_SCHEMA_VERSION,
    })
    assert r.status_code == 200, r.text
    week = (vault / "0-Inbox" / WEEK).read_text()
    assert "bounded thing" in week
    assert "~es" in week             # estimate survives the round trip
    assert "do the first step" in week  # next action survives the move
    assert "~s:" not in week         # stage tokens do not leak into the week


def test_week_task_returns_ready_when_still_bound(client, vault):
    _week_file(vault)
    _write_bucket(
        vault,
        "# Planning Bucket\n\n"
        "- B: bounded thing ~s:ready ~e:s\n"
        "\t- do the first step\n",
    )
    client.post("/plan/bucket/move", json={
        "task_index": 0, "direction": "from_bucket", "day_idx": 0, "schema_version": BUCKET_SCHEMA_VERSION,
    })
    # it is Monday's only task — send it back
    r = client.post("/plan/bucket/move", json={
        "task_index": 0, "direction": "to_bucket", "day_idx": 0, "schema_version": BUCKET_SCHEMA_VERSION,
    })
    assert r.status_code == 200, r.text
    tasks, _ = _parse_bucket_file((vault / "0-Inbox" / BUCKET).read_text())
    back = [t for t in tasks if "bounded thing" in t.text][0]
    assert back.stage == "ready"
    assert back.estimate == "s"
    assert [s.text for s in back.subtasks] == ["do the first step"]


def test_unbound_week_task_returns_captured(client, vault):
    _week_file(vault, monday_task="loose idea from the week")
    _write_bucket(vault, "# Planning Bucket\n")
    r = client.post("/plan/bucket/move", json={
        "task_index": 0, "direction": "to_bucket", "day_idx": 0, "schema_version": BUCKET_SCHEMA_VERSION,
    })
    assert r.status_code == 200, r.text
    tasks, _ = _parse_bucket_file((vault / "0-Inbox" / BUCKET).read_text())
    assert tasks[0].stage == "captured"


# ── Stage 1/2: save-side transition gates ───────────────────────

def _save(client, tasks):
    return client.post("/plan/bucket/save", json={
        "tasks": [t.model_dump() for t in tasks], "pinned_groups": [],
        "schema_version": BUCKET_SCHEMA_VERSION,
    })


def test_ready_transition_requires_estimate_only(client, vault):
    """Ready = bounded = sized. A GTD-style task is its own next action, so
    steps are never required — decomposition belongs to Binding exits."""
    _write_bucket(vault, "# Planning Bucket\n\n- topic\n")
    # no estimate → refused
    r = _save(client, [BucketTask(text="topic", stage="ready")])
    assert r.status_code == 422
    assert "estimate" in r.json()["detail"]
    # estimate alone, no steps → Ready (the task IS the action)
    r = _save(client, [BucketTask(text="topic", stage="ready", estimate="s")])
    assert r.status_code == 200, r.text
    tasks, _ = _parse_bucket_file((vault / "0-Inbox" / BUCKET).read_text())
    assert tasks[0].stage == "ready" and tasks[0].subtasks == []
    # steps still welcome when the item needs breaking down
    r = _save(client, [BucketTask(
        text="topic", stage="ready", estimate="l", subtasks=[Subtask(text="step")],
    )])
    assert r.status_code == 200, r.text
    tasks, _ = _parse_bucket_file((vault / "0-Inbox" / BUCKET).read_text())
    assert tasks[0].stage == "ready"
    assert tasks[0].ready_since == date.today().isoformat()
    assert tasks[0].stage_entered_at == date.today().isoformat()


def test_grandfathered_state_saves_without_gates(client, vault):
    """Unchanged stages pass through — pre-funnel files stay saveable."""
    _write_bucket(vault, "# Planning Bucket\n\n- nA: old thing ~w2624\n")
    tasks, _ = _parse_bucket_file((vault / "0-Inbox" / BUCKET).read_text())
    assert tasks[0].stage == "ready"  # grandfathered, no estimate/subtask
    r = _save(client, tasks)
    assert r.status_code == 200, r.text


def test_binding_requires_question(client, vault):
    _write_bucket(vault, "# Planning Bucket\n\n- topic\n")
    r = _save(client, [BucketTask(text="topic", stage="binding")])
    assert r.status_code == 422
    r = _save(client, [BucketTask(text="topic", stage="binding", question="no mark")])
    assert r.status_code == 422
    r = _save(client, [BucketTask(
        text="topic", stage="binding", question="What is the real blocker?",
    )])
    assert r.status_code == 200, r.text


def test_dormant_requires_wake_date_discard_requires_reason(client, vault):
    _write_bucket(vault, "# Planning Bucket\n\n- a\n- b\n")
    r = _save(client, [BucketTask(text="a", stage="dormant")])
    assert r.status_code == 422
    r = _save(client, [
        BucketTask(text="a", stage="dormant", wake_date="2026-09-01"),
        BucketTask(text="b", stage="discarded"),
    ])
    assert r.status_code == 422
    r = _save(client, [
        BucketTask(text="a", stage="dormant", wake_date="2026-09-01"),
        BucketTask(text="b", stage="discarded", discard_reason="not_mine"),
    ])
    assert r.status_code == 200, r.text


def test_server_stamps_survive_a_second_save(client, vault):
    """The client never sees server-side stamps between saves — an unchanged
    item must keep stageEnteredAt/readySince/slipCount from disk."""
    _write_bucket(vault, "# Planning Bucket\n\n- topic\n")
    r = _save(client, [BucketTask(
        text="topic", stage="ready", estimate="s", subtasks=[Subtask(text="step")],
    )])
    assert r.status_code == 200
    # Second save: client's copy has no stamps (it never refetched)
    r = _save(client, [BucketTask(
        text="topic", stage="ready", estimate="s", subtasks=[Subtask(text="step")],
    )])
    assert r.status_code == 200
    tasks, _ = _parse_bucket_file((vault / "0-Inbox" / BUCKET).read_text())
    assert tasks[0].ready_since == date.today().isoformat()
    assert tasks[0].stage_entered_at == date.today().isoformat()


# ── Stage 2: the WIP limit ──────────────────────────────────────

def _binding(text):
    return BucketTask(text=text, stage="binding", question=f"{text}?")


def test_fifth_binding_item_refused(client, vault):
    existing = "\n".join(
        f"- topic {i} ~s:binding\n\t- ? topic {i}?" for i in range(4)
    )
    _write_bucket(vault, f"# Planning Bucket\n\n{existing}\n- new topic\n")
    tasks, _ = _parse_bucket_file((vault / "0-Inbox" / BUCKET).read_text())
    tasks[-1] = _binding("new topic")
    r = _save(client, tasks)
    assert r.status_code == 422
    assert "at most 4" in r.json()["detail"]


def test_binding_swap_allowed_at_limit(client, vault):
    """Evicting one and admitting another in the same save is fine."""
    existing = "\n".join(
        f"- topic {i} ~s:binding\n\t- ? topic {i}?" for i in range(4)
    )
    _write_bucket(vault, f"# Planning Bucket\n\n{existing}\n- new topic\n")
    tasks, _ = _parse_bucket_file((vault / "0-Inbox" / BUCKET).read_text())
    tasks[0].stage = "dormant"
    tasks[0].wake_date = "2026-10-01"
    tasks[-1] = _binding("new topic")
    r = _save(client, tasks)
    assert r.status_code == 200, r.text


def test_over_limit_hand_edit_can_still_be_reduced(client, vault):
    """A hand-edited file with 6 binding items must remain saveable
    as long as the save doesn't grow the count."""
    existing = "\n".join(
        f"- topic {i} ~s:binding\n\t- ? topic {i}?" for i in range(6)
    )
    _write_bucket(vault, f"# Planning Bucket\n\n{existing}\n")
    tasks, _ = _parse_bucket_file((vault / "0-Inbox" / BUCKET).read_text())
    assert sum(1 for t in tasks if t.stage == "binding") == 6
    r = _save(client, tasks)  # unchanged: allowed
    assert r.status_code == 200, r.text
    tasks[0].stage = "dormant"
    tasks[0].wake_date = "2026-10-01"
    r = _save(client, tasks)  # reducing: allowed
    assert r.status_code == 200, r.text


# ── Version-skew guard: every instance must speak the same schema ─

def test_health_advertises_schema_version(client, vault):
    from backend.models import BUCKET_SCHEMA_VERSION
    r = client.get("/health")
    assert r.json()["schema_version"] == BUCKET_SCHEMA_VERSION


def test_old_client_save_refused(client, vault):
    """A pre-funnel client omits schema_version (and the funnel fields);
    accepting its save would reset every stage to captured."""
    _write_bucket(vault, "# Planning Bucket\n\n- B: thing ~s:ready ~e:s\n\t- step\n")
    r = client.post("/plan/bucket/save", json={
        "tasks": [{"text": "thing", "priority": "B", "focused": False,
                   "waiting": False, "subtasks": []}],
        "pinned_groups": [],
        # no schema_version → defaults to 1 → refused
    })
    assert r.status_code == 422
    assert "out of date" in r.json()["detail"]
    # and the file is untouched
    tasks, _ = _parse_bucket_file((vault / "0-Inbox" / BUCKET).read_text())
    assert tasks[0].stage == "ready"


def test_old_client_move_refused(client, vault):
    _week_file(vault)
    _write_bucket(vault, "# Planning Bucket\n\n- B: thing ~s:ready ~e:s\n\t- step\n")
    r = client.post("/plan/bucket/move", json={
        "task_index": 0, "direction": "from_bucket", "day_idx": 0,
    })
    assert r.status_code == 422
    assert "out of date" in r.json()["detail"]


def test_vault_marker_written_and_advertised(client, vault):
    """A successful save stamps the vault-shared marker so other (isolated)
    installations can see the format from the synced files."""
    from backend.models import BUCKET_SCHEMA_VERSION
    from backend.config import config, SETTINGS_FILE_NAME
    _write_bucket(vault, "# Planning Bucket\n\n- topic\n")
    r = _save(client, [BucketTask(text="topic")])
    assert r.status_code == 200
    assert config.bucket_schema_marker == BUCKET_SCHEMA_VERSION
    assert "bucket_schema" in (vault / "0-Inbox" / SETTINGS_FILE_NAME).read_text()
    assert client.get("/health").json()["vault_schema"] == BUCKET_SCHEMA_VERSION


def test_vault_from_the_future_refuses_edits(client, vault):
    """A matched pair (desktop app) never sees API skew — the synced marker
    is how it learns the vault is written in a newer format than it speaks."""
    from backend.config import config
    config._save_vault_settings({"bucket_schema": 99})
    _write_bucket(vault, "# Planning Bucket\n\n- B: thing ~s:ready ~e:s\n\t- step\n")
    before = (vault / "0-Inbox" / BUCKET).read_text()
    r = _save(client, [BucketTask(text="thing", priority="B", stage="ready",
                                  estimate="s", subtasks=[Subtask(text="step")])])
    assert r.status_code == 422
    assert "another device" in r.json()["detail"].lower() or "format 99" in r.json()["detail"]
    assert (vault / "0-Inbox" / BUCKET).read_text() == before
    r = client.post("/plan/bucket/move", json={
        "task_index": 0, "direction": "from_bucket", "day_idx": 0, "schema_version": BUCKET_SCHEMA_VERSION,
    })
    assert r.status_code == 422


# ── Item identity (~id): edits must never fake a stage transition ─

def test_rename_of_grandfathered_ready_item_saves(client, vault):
    """The live bug: renaming a migration-grandfathered ready item (no
    estimate, no steps) made the validator treat it as a NEW item entering
    ready — gate refused, the client reverted the edit. With ~id identity
    the rename matches its disk twin and saves cleanly."""
    _write_bucket(vault, "# Planning Bucket\n\n- C: hang pics bedroom ~w2629\n")
    tasks, _ = _parse_bucket_file((vault / "0-Inbox" / BUCKET).read_text())
    assert tasks[0].stage == "ready"  # grandfathered
    # First save stamps the id
    r = _save(client, tasks)
    assert r.status_code == 200, r.text
    tasks, _ = _parse_bucket_file((vault / "0-Inbox" / BUCKET).read_text())
    assert "~i" in tasks[0].text
    # Rename (client keeps tilde tokens, per editTask) and save again
    tasks[0].text = tasks[0].text.replace("hang pics bedroom", "hang pictures in the bedroom")
    r = _save(client, tasks)
    assert r.status_code == 200, r.text
    after, _ = _parse_bucket_file((vault / "0-Inbox" / BUCKET).read_text())
    assert "hang pictures in the bedroom" in after[0].text
    assert after[0].stage == "ready"  # unchanged, no gate applied


def test_regroup_keeps_identity(client, vault):
    _write_bucket(vault, "# Planning Bucket\n\n- Home: fix the door ~w2629 ~s:binding ~id:abc123\n\t- ? What hinge fits?\n")
    tasks, _ = _parse_bucket_file((vault / "0-Inbox" / BUCKET).read_text())
    tasks[0].text = tasks[0].text.replace("Home: ", "House: ")
    r = _save(client, tasks)
    assert r.status_code == 200, r.text
    after, _ = _parse_bucket_file((vault / "0-Inbox" / BUCKET).read_text())
    assert after[0].stage == "binding"
    assert after[0].question == "What hinge fits?"
    assert "~id:abc123" in after[0].text


def test_ready_demoted_to_captured_then_bindable(client, vault):
    """The escape hatch for misclassified-ready items: back to captured
    (no gate), then bind normally."""
    _write_bucket(vault, "# Planning Bucket\n\n- C: swedish words ~w2629 ~id:0deadb\n")
    tasks, _ = _parse_bucket_file((vault / "0-Inbox" / BUCKET).read_text())
    assert tasks[0].stage == "ready"
    tasks[0].stage = "captured"
    tasks[0].horizon = ""
    r = _save(client, tasks)
    assert r.status_code == 200, r.text
    tasks, _ = _parse_bucket_file((vault / "0-Inbox" / BUCKET).read_text())
    assert tasks[0].stage == "captured"
    tasks[0].stage = "binding"
    tasks[0].question = "Which 20 words unlock the most conversations?"
    r = _save(client, tasks)
    assert r.status_code == 200, r.text
    tasks, _ = _parse_bucket_file((vault / "0-Inbox" / BUCKET).read_text())
    assert tasks[0].stage == "binding"


def test_get_bucket_bootstraps_ids(client, vault):
    """Legacy files get identities on first read, so even a client that
    renames before ever saving is protected."""
    _write_bucket(vault, "# Planning Bucket\n\n- C: old item ~w2629\n- newer thing\n")
    r = client.get("/plan/bucket")
    assert r.status_code == 200
    assert all("~i" in t["text"] for t in r.json()["tasks"])
    on_disk = (vault / "0-Inbox" / BUCKET).read_text()
    assert on_disk.count("~i") == 2
    # idempotent: second read doesn't rewrite
    mtime1 = (vault / "0-Inbox" / BUCKET).stat().st_mtime
    client.get("/plan/bucket")
    assert (vault / "0-Inbox" / BUCKET).stat().st_mtime == mtime1
