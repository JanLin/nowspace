"""R2: moving the plan folder, and refusing to when it isn't safe.

The ordering is the safety argument: files first, setting last. Every test
here is really asking "what does the vault look like if this step fails?"
"""

from backend.config import (config, DEFAULT_PLAN_FOLDER, LEGACY_SETTINGS_FILE_NAME,
                            SETTINGS_FILE_NAME)
from backend.models import BUCKET_SCHEMA_VERSION
from backend.routers.plan import MOVE_DESTINATION

NOWSPACE_FILES = [
    "Plan Week.md", "Plan Week Bucket.md", "Plan Week Habits.md",
    "Plan Week Recurring.md", "Plan Week Funnel Log.md",
    "Plan Week - 2026-wk34.md", "Time Log - 2026-08.md",
]


def _populate(vault, settings_block="app:\n  mode: advanced\n"):
    inbox = vault / DEFAULT_PLAN_FOLDER
    for name in NOWSPACE_FILES:
        (inbox / name).write_text(f"# {name}\n", encoding="utf-8")
    (inbox / LEGACY_SETTINGS_FILE_NAME).write_text(
        f"# Nowspace Configuration\n\n```yaml\n{settings_block}```\n", encoding="utf-8")
    # the user's own things, which must not move
    (inbox / "Private-comms.md").write_text("mine\n", encoding="utf-8")
    (inbox / "Business cards").mkdir(exist_ok=True)
    config._vault_cfg_cache = None
    config._vault_cfg_mtime = None
    return inbox


def _fresh(monkeypatch):
    monkeypatch.setattr(config, "_plan_folder_override", None)
    monkeypatch.setattr(config, "_legacy_plan_folder", DEFAULT_PLAN_FOLDER)
    monkeypatch.setattr(config, "plan_week_config_file", "")


# ── the move ──────────────────────────────────────────────────────────

def test_it_moves_the_plan_files_and_records_where(client, vault, monkeypatch):
    _fresh(monkeypatch)
    inbox = _populate(vault)

    r = client.post("/plan/move-plan-folder", json={"folder": "0-Plan"})
    assert r.status_code == 200, r.text
    assert r.json()["folder"] == "0-Plan"

    dest = vault / "0-Plan"
    for name in NOWSPACE_FILES:
        assert (dest / name).exists(), f"{name} did not move"
        assert not (inbox / name).exists(), f"{name} left behind"

    config._vault_cfg_cache = None
    config._vault_cfg_mtime = None
    assert config.plan_folder == "0-Plan"
    assert config.vault_path == dest


def test_the_settings_file_goes_to_the_tool_folder_not_the_plan_folder(client, vault, monkeypatch):
    """The reason the destination can be anything: this file never follows the
    plan files. It lives where discovery looks, so it is always findable, so
    it can record where the rest went."""
    _fresh(monkeypatch)
    inbox = _populate(vault)
    r = client.post("/plan/move-plan-folder", json={"folder": "0-Plan"})
    assert r.status_code == 200, r.text

    settings_home = vault / "5-Meta" / "Nowspace" / SETTINGS_FILE_NAME
    assert settings_home.exists(), "settings should sit with the tool files"
    assert not (vault / "0-Plan" / SETTINGS_FILE_NAME).exists(), "it must not follow the plan"
    assert not (inbox / LEGACY_SETTINGS_FILE_NAME).exists(), "the inbox copy should be gone"
    assert r.json()["settings_renamed"] is True

    config._vault_cfg_cache = None
    config._vault_cfg_mtime = None
    assert config._vault_settings_path == settings_home
    assert config.plan_folder == "0-Plan"      # …and it still resolves


def test_the_old_name_is_still_read(vault, monkeypatch):
    """A vault that never takes the rename keeps working, forever."""
    _fresh(monkeypatch)
    inbox = vault / DEFAULT_PLAN_FOLDER
    (inbox / LEGACY_SETTINGS_FILE_NAME).write_text(
        "```yaml\ncontexts:\n  work:\n    - arratech\n```\n", encoding="utf-8")
    config._vault_cfg_cache = None
    config._vault_cfg_mtime = None
    assert config._vault_settings_path == inbox / LEGACY_SETTINGS_FILE_NAME
    assert config.contexts == {"work": ["arratech"]}


def test_the_new_name_wins_when_both_exist(vault, monkeypatch):
    _fresh(monkeypatch)
    inbox = vault / DEFAULT_PLAN_FOLDER
    (inbox / LEGACY_SETTINGS_FILE_NAME).write_text("```yaml\napp:\n  mode: basic\n```\n", encoding="utf-8")
    (inbox / SETTINGS_FILE_NAME).write_text("```yaml\napp:\n  mode: advanced\n```\n", encoding="utf-8")
    config._vault_cfg_cache = None
    config._vault_cfg_mtime = None
    assert config._vault_settings_path.name == SETTINGS_FILE_NAME


def test_any_vault_relative_folder_works(client, vault, monkeypatch):
    _fresh(monkeypatch)
    _populate(vault)
    r = client.post("/plan/move-plan-folder", json={"folder": "2-Areas/Planning/"})
    assert r.status_code == 200, r.text
    assert (vault / "2-Areas" / "Planning" / "Plan Week.md").exists()
    config._vault_cfg_cache = None
    config._vault_cfg_mtime = None
    assert config.plan_folder == "2-Areas/Planning"


def test_a_folder_outside_the_vault_is_refused(client, vault, monkeypatch):
    _fresh(monkeypatch)
    inbox = _populate(vault)
    for bad in ("/etc", "../elsewhere", "0-Plan/../../escape"):
        r = client.post("/plan/move-plan-folder", json={"folder": bad})
        assert r.status_code == 400, f"{bad} should be refused"
    assert (inbox / "Plan Week.md").exists()


def test_it_leaves_your_own_files_alone(client, vault, monkeypatch):
    _fresh(monkeypatch)
    inbox = _populate(vault)
    assert client.post("/plan/move-plan-folder").status_code == 200
    assert (inbox / "Private-comms.md").exists()
    assert (inbox / "Business cards").is_dir()


def test_the_archive_follows_the_plan_folder(client, vault, monkeypatch):
    """a0-Inbox means "the archive of 0-Inbox" — it stops being true the
    moment the plan leaves the inbox, so the weeks move with it."""
    _fresh(monkeypatch)
    _populate(vault)
    old_archive = vault / "4-Archive" / "a0-Inbox"
    old_archive.mkdir(parents=True, exist_ok=True)
    for wk in (31, 32, 33):
        (old_archive / f"Plan Week - 2026-wk{wk}.md").write_text(f"Week 2026-wk{wk}\n", encoding="utf-8")

    r = client.post("/plan/move-plan-folder", json={"folder": "0-Plan"})
    assert r.status_code == 200, r.text
    assert r.json()["archive_folder"] == "4-Archive/a0-Plan"
    assert r.json()["archive_moved"] is True

    new_archive = vault / "4-Archive" / "a0-Plan"
    assert sorted(p.name for p in new_archive.iterdir()) == [
        "Plan Week - 2026-wk31.md", "Plan Week - 2026-wk32.md", "Plan Week - 2026-wk33.md"]
    assert not old_archive.exists()

    config._vault_cfg_cache = None
    config._vault_cfg_mtime = None
    assert config.archive_folder == "4-Archive/a0-Plan"
    assert config.plan_folder == "0-Plan"


def test_an_archived_week_is_still_readable_afterwards(client, vault, monkeypatch):
    """The point of moving it rather than leaving it: history stays reachable."""
    _fresh(monkeypatch)
    _populate(vault)
    old_archive = vault / "4-Archive" / "a0-Inbox"
    old_archive.mkdir(parents=True, exist_ok=True)
    (old_archive / "Plan Week - 2026-wk33.md").write_text(
        "Week 2026-wk33\n\n##### Mon 10\n- [ ] C1: last week's task\n", encoding="utf-8")

    assert client.post("/plan/move-plan-folder", json={"folder": "0-Plan"}).status_code == 200
    config._vault_cfg_cache = None
    config._vault_cfg_mtime = None

    from backend.routers.plan import _list_archived_week_files
    assert [(y, w) for y, w, _ in _list_archived_week_files()] == [(2026, 33)]


def test_a_vault_that_moved_earlier_can_finish_the_archive(client, vault, monkeypatch):
    """Your vault: plan already in 0-Plan, weeks still in a0-Inbox."""
    _fresh(monkeypatch)
    plan = vault / "0-Plan"
    plan.mkdir()
    (plan / "Plan Week.md").write_text("Week 2026-wk33\n", encoding="utf-8")
    (vault / DEFAULT_PLAN_FOLDER / SETTINGS_FILE_NAME).write_text(
        "```yaml\nplan:\n  folder: 0-Plan\n```\n", encoding="utf-8")
    old_archive = vault / "4-Archive" / "a0-Inbox"
    old_archive.mkdir(parents=True, exist_ok=True)
    (old_archive / "Plan Week - 2026-wk32.md").write_text("Week 2026-wk32\n", encoding="utf-8")
    config._vault_cfg_cache = None
    config._vault_cfg_mtime = None

    r = client.post("/plan/move-plan-folder", json={"folder": "0-Plan"})
    assert r.status_code == 200, r.text
    assert r.json()["moved"] == []            # nothing to move: already there
    assert r.json()["archive_moved"] is True  # …but the archive still needed it
    assert (vault / "4-Archive" / "a0-Plan" / "Plan Week - 2026-wk32.md").exists()


def test_it_refuses_when_the_archive_target_exists(client, vault, monkeypatch):
    _fresh(monkeypatch)
    _populate(vault)
    (vault / "4-Archive" / "a0-Inbox").mkdir(parents=True, exist_ok=True)
    (vault / "4-Archive" / "a0-Plan").mkdir(parents=True)

    r = client.post("/plan/move-plan-folder", json={"folder": "0-Plan"})
    assert r.status_code == 409
    assert "a0-Plan" in r.json()["detail"]
    assert (vault / DEFAULT_PLAN_FOLDER / "Plan Week.md").exists()   # nothing moved


def test_a_failed_write_puts_the_archive_back_too(client, vault, monkeypatch):
    _fresh(monkeypatch)
    _populate(vault)
    old_archive = vault / "4-Archive" / "a0-Inbox"
    old_archive.mkdir(parents=True, exist_ok=True)
    (old_archive / "Plan Week - 2026-wk32.md").write_text("x\n", encoding="utf-8")
    monkeypatch.setattr(config, "save_plan_folder",
                        lambda *_a, **_k: (_ for _ in ()).throw(OSError("read-only")))

    assert client.post("/plan/move-plan-folder", json={"folder": "0-Plan"}).status_code == 500
    assert (old_archive / "Plan Week - 2026-wk32.md").exists(), "the archive was not put back"
    assert not (vault / "4-Archive" / "a0-Plan").exists()


def test_moving_twice_is_a_no_op(client, vault, monkeypatch):
    _fresh(monkeypatch)
    _populate(vault)
    assert client.post("/plan/move-plan-folder", json={"folder": "0-Plan"}).status_code == 200
    config._vault_cfg_cache = None
    config._vault_cfg_mtime = None
    r = client.post("/plan/move-plan-folder", json={"folder": "0-Plan"})
    assert r.status_code == 200
    assert r.json()["status"] == "already-there"


# ── the refusals ──────────────────────────────────────────────────────

def test_it_refuses_when_the_destination_already_has_one(client, vault, monkeypatch):
    _fresh(monkeypatch)
    _populate(vault)
    dest = vault / "0-Plan"
    dest.mkdir(parents=True)
    (dest / "Plan Week.md").write_text("someone else's\n", encoding="utf-8")

    r = client.post("/plan/move-plan-folder", json={"folder": "0-Plan"})
    assert r.status_code == 409
    assert "already has" in r.json()["detail"]
    # nothing moved
    assert (vault / DEFAULT_PLAN_FOLDER / "Plan Week Bucket.md").exists()
    assert (dest / "Plan Week.md").read_text(encoding="utf-8") == "someone else's\n"


def test_it_refuses_while_a_sync_conflict_is_unresolved(client, vault, monkeypatch):
    _fresh(monkeypatch)
    inbox = _populate(vault)
    (inbox / "Plan Week.sync-conflict-20260815-120000-ABCDEFG.md").write_text("x\n", encoding="utf-8")

    r = client.post("/plan/move-plan-folder")
    assert r.status_code == 409
    assert "conflict" in r.json()["detail"].lower()
    assert (inbox / "Plan Week.md").exists()


def test_it_refuses_on_a_vault_a_newer_installation_upgraded(client, vault, monkeypatch):
    _fresh(monkeypatch)
    _populate(vault, f"bucket_schema: {BUCKET_SCHEMA_VERSION + 1}\n")
    r = client.post("/plan/move-plan-folder")
    assert r.status_code == 422
    assert (vault / DEFAULT_PLAN_FOLDER / "Plan Week.md").exists()


def test_an_empty_folder_is_not_a_move(client, vault, monkeypatch):
    _fresh(monkeypatch)
    r = client.post("/plan/move-plan-folder")
    assert r.status_code == 404


# ── failure leaves the vault working ──────────────────────────────────

def test_a_failed_setting_write_puts_everything_back(client, vault, monkeypatch):
    """The one ordering that matters: if the last step fails, the files come
    home. A vault pointing at files that aren't there is the bad outcome."""
    _fresh(monkeypatch)
    inbox = _populate(vault)
    monkeypatch.setattr(config, "save_plan_folder",
                        lambda *_a, **_k: (_ for _ in ()).throw(OSError("read-only")))

    r = client.post("/plan/move-plan-folder")
    assert r.status_code == 500
    assert "undone" in r.json()["detail"]
    for name in NOWSPACE_FILES:
        assert (inbox / name).exists(), f"{name} was not put back"
    # the settings file never took part, and was not renamed either: the tidy
    # step only runs after a move that succeeded
    assert (inbox / LEGACY_SETTINGS_FILE_NAME).exists()
    config._vault_cfg_cache = None
    config._vault_cfg_mtime = None
    assert config.plan_folder == DEFAULT_PLAN_FOLDER


# ── which files count as week files at all ────────────────────────────

def test_a_hand_made_backup_is_not_read_as_a_live_week(vault, monkeypatch):
    """A copy parked beside the week file used to be scanned as one. Every
    ~r line in it then counted as a live instance, and the repeat it belonged
    to silently stopped spawning."""
    from backend.recurrence import _week_files
    monkeypatch.setattr(config, "_plan_folder_override", None)
    inbox = vault / DEFAULT_PLAN_FOLDER
    (inbox / "Plan Week.md").write_text("Week 2026-wk33\n", encoding="utf-8")
    (inbox / "Plan Week - 2026-wk34.md").write_text("Week 2026-wk34\n", encoding="utf-8")
    (inbox / "Plan Week - pre-dedupe backup.md").write_text("- [ ] C1: old ~rab12cd\n", encoding="utf-8")

    names = [p.name for p in _week_files()]
    assert "Plan Week.md" in names
    assert "Plan Week - 2026-wk34.md" in names
    assert "Plan Week - pre-dedupe backup.md" not in names
