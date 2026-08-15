"""The README that sits beside the plan files, in the vault."""

from backend.config import config, DEFAULT_PLAN_FOLDER, SETTINGS_FILE_NAME
from backend.plan_readme import README_NAME, ensure, render


def test_it_names_every_file_in_the_folder(vault, monkeypatch):
    monkeypatch.setattr(config, "_plan_folder_override", None)
    monkeypatch.setattr(config, "_legacy_plan_folder", DEFAULT_PLAN_FOLDER)
    text = render()
    for name in (config.plan_week_file, config.plan_week_bucket_file,
                 config.plan_week_habits_file, config.plan_week_recurring_file,
                 SETTINGS_FILE_NAME, "Plan Week Funnel Log.md",
                 "Time Log - YYYY-MM.md", README_NAME):
        assert f"`{name}`" in text, f"{name} missing from the README"


def test_it_states_where_the_folders_actually_are(vault, monkeypatch):
    """Generated from the resolved config, so a move can't leave it lying."""
    monkeypatch.setattr(config, "_plan_folder_override", None)
    (vault / DEFAULT_PLAN_FOLDER / SETTINGS_FILE_NAME).write_text(
        "```yaml\nplan:\n  folder: 5-Meta/Nowspace\n  archive_folder: 5-Meta/Nowspace/Archive\n```\n",
        encoding="utf-8")
    config._vault_cfg_cache = None
    config._vault_cfg_mtime = None
    text = render()
    assert "`5-Meta/Nowspace/`" in text
    assert "`5-Meta/Nowspace/Archive/`" in text
    # The only thing still in the inbox here is the settings file, and the
    # README says so rather than pretending otherwise.
    assert "Lives in `0-Inbox/`." in text


def test_it_says_where_the_settings_file_is_when_it_is_elsewhere(vault, monkeypatch):
    monkeypatch.setattr(config, "_plan_folder_override", None)
    monkeypatch.setattr(config, "plan_week_config_file", "")
    p = vault / "5-Meta" / "Nowspace" / SETTINGS_FILE_NAME
    p.parent.mkdir(parents=True)
    p.write_text("```yaml\napp:\n  mode: advanced\n```\n", encoding="utf-8")
    config._vault_cfg_cache = None
    config._vault_cfg_mtime = None
    assert "Lives in `5-Meta/Nowspace/`." in render()


def test_it_is_written_once_and_not_rewritten(vault, monkeypatch):
    """A file rewritten every start is a file Syncthing ships every start."""
    monkeypatch.setattr(config, "_plan_folder_override", None)
    target = config.vault_path / README_NAME
    assert ensure() is True
    assert target.exists()
    first = target.stat().st_mtime_ns
    assert ensure() is False          # unchanged: no write
    assert target.stat().st_mtime_ns == first


def test_it_is_rewritten_when_the_folder_moves(vault, monkeypatch):
    monkeypatch.setattr(config, "_plan_folder_override", None)
    assert ensure() is True
    (vault / DEFAULT_PLAN_FOLDER / SETTINGS_FILE_NAME).write_text(
        "```yaml\nplan:\n  archive_folder: 5-Meta/Nowspace/Archive\n```\n", encoding="utf-8")
    config._vault_cfg_cache = None
    config._vault_cfg_mtime = None
    assert ensure() is True
    assert "5-Meta/Nowspace/Archive" in (config.vault_path / README_NAME).read_text(encoding="utf-8")


def test_a_broken_vault_never_fails_a_startup(vault, monkeypatch):
    monkeypatch.setattr(config, "_plan_folder_override", vault / "nope" / "nowhere")
    monkeypatch.setattr("backend.plan_readme.write_text_guarded",
                        lambda *a, **k: (_ for _ in ()).throw(OSError("read-only vault")))
    assert ensure() is False          # returns, does not raise
