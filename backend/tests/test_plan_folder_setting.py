"""R1: where the Plan Week files live is a vault setting.

The acceptance that matters is the first test: with no setting present,
every path resolves exactly where it always did. Everything after that is
about the move being possible, and safe when two instances share a vault.
"""

import pytest

from backend.config import config, DEFAULT_ARCHIVE_FOLDER, DEFAULT_PLAN_FOLDER, SETTINGS_FILE_NAME
from backend.routers.plan import _archive_path, _vault_root


def _settings(vault, block: str, folder: str = DEFAULT_PLAN_FOLDER):
    p = vault / folder / SETTINGS_FILE_NAME
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(f"# Plan Week Configuration\n\n```yaml\n{block}```\n", encoding="utf-8")
    config._vault_cfg_cache = None
    config._vault_cfg_mtime = None
    return p


# ── the no-op acceptance ──────────────────────────────────────────────

def test_defaults_resolve_exactly_where_they_always_did(vault, monkeypatch):
    monkeypatch.setattr(config, "_plan_folder_override", None)
    monkeypatch.setattr(config, "_legacy_plan_folder", DEFAULT_PLAN_FOLDER)
    assert config.plan_folder == "0-Inbox"
    assert config.archive_folder == "4-Archive/a0-Inbox"
    assert config.vault_path == vault / "0-Inbox"
    assert _archive_path() == vault / "4-Archive" / "a0-Inbox"
    assert _vault_root() == vault


def test_an_empty_setting_block_changes_nothing(vault, monkeypatch):
    monkeypatch.setattr(config, "_plan_folder_override", None)
    monkeypatch.setattr(config, "_legacy_plan_folder", DEFAULT_PLAN_FOLDER)
    _settings(vault, "contexts:\n  work:\n    - arratech\n")
    assert config.vault_path == vault / "0-Inbox"
    assert _archive_path() == vault / "4-Archive" / "a0-Inbox"


# ── the move ──────────────────────────────────────────────────────────

def test_the_vault_decides_the_plan_folder(vault, monkeypatch):
    monkeypatch.setattr(config, "_plan_folder_override", None)
    _settings(vault, "plan:\n  folder: 5-Meta/Nowspace\n  archive_folder: 5-Meta/Nowspace/Archive\n")
    assert config.vault_path == vault / "5-Meta" / "Nowspace"
    assert _archive_path() == vault / "5-Meta" / "Nowspace" / "Archive"
    # the vault root is untouched by a plan-folder move — this is what broke
    # when the root was re-derived from the folder's name
    assert _vault_root() == vault


def test_a_leading_or_trailing_slash_is_tolerated(vault, monkeypatch):
    monkeypatch.setattr(config, "_plan_folder_override", None)
    _settings(vault, "plan:\n  folder: /5-Meta/Nowspace/\n")
    assert config.vault_path == vault / "5-Meta" / "Nowspace"


def test_the_setting_is_vault_relative_so_two_instances_agree(vault, monkeypatch):
    """The same vault mounted at a different absolute path resolves the same
    folder — which is the whole reason this is not a device setting."""
    monkeypatch.setattr(config, "_plan_folder_override", None)
    _settings(vault, "plan:\n  folder: 5-Meta/Nowspace\n")
    first = config.vault_path.relative_to(config.vault_root)

    elsewhere = vault.parent / "mounted-somewhere-else"
    (elsewhere / DEFAULT_PLAN_FOLDER).mkdir(parents=True)
    (elsewhere / DEFAULT_PLAN_FOLDER / SETTINGS_FILE_NAME).write_text(
        (vault / DEFAULT_PLAN_FOLDER / SETTINGS_FILE_NAME).read_text(encoding="utf-8"),
        encoding="utf-8")
    monkeypatch.setattr(config, "vault_root", elsewhere)
    config._vault_cfg_cache = None
    config._vault_cfg_mtime = None
    assert config.vault_path.relative_to(config.vault_root) == first


# ── finding the settings file at all ──────────────────────────────────

def test_settings_are_found_where_every_vault_has_them(vault, monkeypatch):
    monkeypatch.setattr(config, "plan_week_config_file", "")
    _settings(vault, "app:\n  mode: advanced\n")
    assert config._vault_settings_path == vault / "0-Inbox" / SETTINGS_FILE_NAME
    assert config._vault_settings()["app"]["mode"] == "advanced"


def test_settings_are_found_in_the_new_home_first(vault, monkeypatch):
    """So the settings file can move out of the inbox with everything else."""
    monkeypatch.setattr(config, "plan_week_config_file", "")
    _settings(vault, "app:\n  mode: basic\n", folder="0-Inbox")
    _settings(vault, "app:\n  mode: advanced\n", folder="5-Meta/Nowspace")
    assert config._vault_settings_path == vault / "5-Meta" / "Nowspace" / SETTINGS_FILE_NAME
    assert config._vault_settings()["app"]["mode"] == "advanced"


def test_a_fresh_vault_gets_the_file_where_it_has_always_been(vault, monkeypatch):
    monkeypatch.setattr(config, "plan_week_config_file", "")
    assert config._vault_settings_path == vault / "0-Inbox" / SETTINGS_FILE_NAME


# ── the guard that makes the move safe ────────────────────────────────

def test_week_writes_refuse_a_vault_a_newer_instance_upgraded(client, vault, monkeypatch):
    """Without this, an installation too old to read plan.folder keeps
    writing the folder it knows: two live week files, both synced."""
    from backend.models import BUCKET_SCHEMA_VERSION
    monkeypatch.setattr(config, "_plan_folder_override", None)
    _settings(vault, f"bucket_schema: {BUCKET_SCHEMA_VERSION + 1}\n")
    (vault / "0-Inbox" / "Plan Week.md").write_text("##### Monday\n", encoding="utf-8")

    r = client.post("/plan/save-week", json={"days": [{"day": "monday", "tasks": []}], "offset": 0})
    assert r.status_code == 422
    assert "only speaks" in r.json()["detail"]


def test_week_writes_are_fine_on_a_matching_vault(client, vault, monkeypatch):
    from backend.models import BUCKET_SCHEMA_VERSION
    monkeypatch.setattr(config, "_plan_folder_override", None)
    _settings(vault, f"bucket_schema: {BUCKET_SCHEMA_VERSION}\n")
    (vault / "0-Inbox" / "Plan Week.md").write_text("##### Monday\n", encoding="utf-8")
    r = client.post("/plan/save-week", json={"days": [{"day": "monday", "tasks": []}], "offset": 0})
    assert r.status_code == 200, r.text
