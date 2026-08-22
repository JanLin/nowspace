"""A failed read of the vault settings file is not an empty settings file.

The settings file syncs. It is absent for the instant of a Syncthing rename,
it can be read while half-written, and a vault that has been through the
`0-Inbox` → `5-Meta/Nowspace` move keeps a leftover sitting below the real
one. Every one of those used to resolve to `{}` or to the leftover — and
`{}` is not "nothing configured", it is every setting at its default: the
plan folder back to `0-Inbox`, an extension's tab gone, and a save landing
in that instant writing to the wrong folder.

What each test asserts is the same thing: **known settings survive a moment
where the file cannot be read, and a real edit still lands.**
"""

import os

import pytest

from backend.config import (
    config,
    DEFAULT_PLAN_FOLDER,
    LEGACY_SETTINGS_FILE_NAME,
    SETTINGS_FILE_NAME,
    SETTINGS_SEARCH_FOLDERS,
)

BLOCK = "plan:\n  folder: 0-Plan\nrelay:\n  enabled: true\n"


@pytest.fixture(autouse=True)
def _no_overrides(monkeypatch):
    """config.yaml must not answer for the vault in these tests."""
    monkeypatch.setattr(config, "_plan_folder_override", None)
    monkeypatch.setattr(config, "_legacy_plan_folder", DEFAULT_PLAN_FOLDER)
    monkeypatch.setattr(config, "plan_week_config_file", "", raising=False)


def _write(vault, folder, name, block):
    p = vault / folder / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(f"# Nowspace Configuration\n\n```yaml\n{block}```\n", encoding="utf-8")
    # Distinct mtimes, so a rewrite is never mistaken for the cached read.
    os.utime(p, (1_700_000_000, 1_700_000_000 + _write.tick))
    _write.tick += 10
    return p


_write.tick = 0


def _settings(vault, block=BLOCK):
    return _write(vault, SETTINGS_SEARCH_FOLDERS[0], SETTINGS_FILE_NAME, block)


# ── the file blinks out ───────────────────────────────────────────────

def test_a_settings_file_gone_for_an_instant_keeps_every_setting(vault):
    p = _settings(vault)
    assert config.plan_folder == "0-Plan"
    assert config.addon_settings.get("relay") == {"enabled": True}

    p.unlink()  # the instant of a Syncthing rename

    assert config.plan_folder == "0-Plan"
    assert config.addon_settings.get("relay") == {"enabled": True}


def test_the_tab_that_went_missing_survives_the_blink(vault):
    """The reported symptom, at its source: an extension's switch is read
    from here, and a surface whose switch is absent is not rendered."""
    p = _settings(vault)
    assert config.addon_settings["relay"]["enabled"] is True
    p.unlink()
    assert config.addon_settings["relay"]["enabled"] is True


# ── the file is there but unreadable ──────────────────────────────────

def test_a_half_written_file_keeps_every_setting(vault):
    p = _settings(vault)
    assert config.plan_folder == "0-Plan"

    # A write caught mid-flight: the opening fence, no closing one.
    p.write_text("# Nowspace Configuration\n\n```yaml\nplan:\n  fol", encoding="utf-8")
    os.utime(p, (1_700_000_000, 1_700_009_999))

    assert config.plan_folder == "0-Plan"
    assert config.addon_settings.get("relay") == {"enabled": True}


def test_an_unparseable_block_keeps_every_setting(vault):
    p = _settings(vault)
    assert config.plan_folder == "0-Plan"

    p.write_text(
        "# Nowspace Configuration\n\n```yaml\nplan:\n  folder: [unclosed\n```\n",
        encoding="utf-8",
    )
    os.utime(p, (1_700_000_000, 1_700_008_888))

    assert config.plan_folder == "0-Plan"


def test_an_empty_block_keeps_every_setting(vault):
    """An emptied block reads exactly like a truncated write."""
    p = _settings(vault)
    assert config.plan_folder == "0-Plan"

    p.write_text("# Nowspace Configuration\n\n```yaml\n```\n", encoding="utf-8")
    os.utime(p, (1_700_000_000, 1_700_007_777))

    assert config.plan_folder == "0-Plan"


# ── and a real edit still lands ───────────────────────────────────────

def test_a_real_edit_still_wins(vault):
    """The point is not to freeze the settings — only to refuse to read a
    failure as an answer."""
    _settings(vault)
    assert config.plan_folder == "0-Plan"

    _settings(vault, "plan:\n  folder: 2-Areas/Work\n")

    assert config.plan_folder == "2-Areas/Work"
    # The relay key really is gone, rather than held over from before.
    assert "relay" not in config.addon_settings


def test_a_vault_with_no_settings_file_still_reads_as_defaults(vault):
    assert config.plan_folder == DEFAULT_PLAN_FOLDER
    assert config.addon_settings == {}
    assert config.app_settings["mode"] == "advanced"


# ── the search never demotes ──────────────────────────────────────────

def test_a_leftover_below_the_real_file_never_wins(vault):
    """A vault that has been through the move keeps the old file. When the
    real one blinks out, the leftover parses fine — and is wrong."""
    real = _settings(vault, "plan:\n  folder: 0-Plan\n")
    _write(vault, DEFAULT_PLAN_FOLDER, LEGACY_SETTINGS_FILE_NAME, "plan:\n  folder: 0-Inbox\n")
    assert config.plan_folder == "0-Plan"

    real.unlink()

    assert config.plan_folder == "0-Plan"


def test_the_move_arriving_from_another_instance_still_wins(vault):
    """Promotion is the move landing over Syncthing, and must still work."""
    _write(vault, DEFAULT_PLAN_FOLDER, LEGACY_SETTINGS_FILE_NAME, "plan:\n  folder: 0-Inbox\n")
    assert config.plan_folder == "0-Inbox"

    _write(vault, SETTINGS_SEARCH_FOLDERS[0], SETTINGS_FILE_NAME, "plan:\n  folder: 0-Plan\n")

    assert config.plan_folder == "0-Plan"
