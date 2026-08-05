"""Seam 2: settings passthrough and the host version.

The extension namespace is a top-level key in the vault settings file, and
it only works because a save merges rather than replaces. That was an
accident of the implementation; these tests make it a promise.
"""

from backend.config import config
from backend.host import HOST_API
from backend.models import BUCKET_SCHEMA_VERSION

SETTINGS_WITH_ADDON = """# Plan Week Configuration

```yaml
contexts:
  work:
    - arratech
app:
  mode: advanced
relay:
  enabled: true
  endpoint: https://example.invalid/relay
```
"""


def _settings_file(vault):
    p = vault / "0-Inbox" / "Plan Week Configuration.md"
    p.write_text(SETTINGS_WITH_ADDON, encoding="utf-8")
    config._vault_cfg_cache = None
    config._vault_cfg_mtime = None
    return p


# ── the top-level passthrough ─────────────────────────────────────────

def test_an_addon_block_survives_a_settings_save(client, vault):
    p = _settings_file(vault)
    r = client.post("/api/settings/app", json={"mode": "basic"})
    assert r.status_code == 200, r.text

    after = p.read_text(encoding="utf-8")
    assert "relay:" in after
    assert "enabled: true" in after
    assert "https://example.invalid/relay" in after
    # …and the save it came with still took effect
    assert config.app_mode == "basic"


def test_an_addon_block_survives_a_contexts_save(client, vault):
    p = _settings_file(vault)
    r = client.post("/api/settings/contexts", json={
        "contexts": {"work": ["arratech", "wallet"]},
        "context_tags": {"w": "work"},
    })
    assert r.status_code == 200, r.text
    assert "relay:" in p.read_text(encoding="utf-8")


# ── the app map keeps keys it doesn't know ────────────────────────────

def test_unknown_boolean_app_keys_round_trip(client, vault):
    """An instance a release behind must not delete a newer one's switch.

    The filter used to drop anything outside _APP_DEFAULTS — and the deletion
    synced to every device, which is the same loss extra="forbid" prevents on
    bucket writes.
    """
    _settings_file(vault)
    r = client.post("/api/settings/app", json={"mode": "advanced", "some_new_switch": True})
    assert r.status_code == 200, r.text
    assert r.json()["app"]["some_new_switch"] is True

    # still there after an unrelated save
    r = client.post("/api/settings/app", json={"handoff": False})
    assert r.json()["app"]["some_new_switch"] is True
    assert client.get("/api/settings").json()["app"]["some_new_switch"] is True


def test_unknown_non_boolean_app_keys_are_not_stored(client, vault):
    """A switch is all this map is for; structure belongs in its own key."""
    _settings_file(vault)
    r = client.post("/api/settings/app", json={"mode": "advanced", "junk": {"a": 1}})
    assert r.status_code == 200, r.text
    assert "junk" not in r.json()["app"]


def test_the_three_known_switches_still_work(client, vault):
    _settings_file(vault)
    r = client.post("/api/settings/app", json={"mode": "advanced", "funnel": False, "handoff": True})
    app = r.json()["app"]
    assert app["mode"] == "advanced"
    assert app["funnel"] is False
    assert app["handoff"] is True

    # Basic resolves both to off whatever is stored — unchanged behaviour,
    # pinned here because app_settings is now the single source for the shape
    r = client.post("/api/settings/app", json={"mode": "basic"})
    app = r.json()["app"]
    assert app["funnel"] is False and app["handoff"] is False


def test_an_invalid_mode_is_still_refused(client, vault):
    _settings_file(vault)
    assert client.post("/api/settings/app", json={"mode": "sideways"}).status_code == 400


# ── the host version ──────────────────────────────────────────────────

def test_health_reports_host_api(client):
    body = client.get("/health").json()
    assert body["host_api"] == HOST_API
    # …alongside, and independent of, the vault format version
    assert body["schema_version"] == BUCKET_SCHEMA_VERSION
    assert "vault_schema" in body


def test_host_api_is_an_integer_starting_at_one():
    assert isinstance(HOST_API, int) and HOST_API >= 1


# ── what a router is given (0.6.1) ────────────────────────────────────

def test_addon_settings_returns_the_block_verbatim(vault):
    """Including keys the baseline has never heard of — it is their namespace."""
    from backend import host
    _settings_file(vault)
    block = host.addon_settings("relay")
    assert block == {"enabled": True, "endpoint": "https://example.invalid/relay"}


def test_addon_settings_is_empty_for_an_absent_key(vault):
    """A fresh vault needs no seeding."""
    from backend import host
    _settings_file(vault)
    assert host.addon_settings("not-installed") == {}


def test_addon_settings_is_empty_when_there_is_no_settings_file(vault):
    from backend import host
    config._vault_cfg_cache = None
    config._vault_cfg_mtime = None
    assert host.addon_settings("relay") == {}


def test_addon_settings_hands_back_a_copy(vault):
    """A router mutating what it got must not edit the cached settings."""
    from backend import host
    _settings_file(vault)
    got = host.addon_settings("relay")
    got["enabled"] = False
    assert host.addon_settings("relay")["enabled"] is True


def test_addon_settings_never_returns_a_baseline_key(vault):
    """`app`, `contexts` and friends are the baseline's, not a namespace."""
    from backend import host
    _settings_file(vault)
    assert host.addon_settings("app") == {}
    assert host.addon_settings("contexts") == {}


def test_vault_root_matches_config(vault):
    from backend import host
    assert host.vault_root() == config.vault_root


def test_the_host_module_exposes_no_setter():
    """The contract is read-only; a settings panel is a seam of its own."""
    from backend import host
    assert not [n for n in dir(host) if n.startswith(("save_", "set_", "write_"))]
