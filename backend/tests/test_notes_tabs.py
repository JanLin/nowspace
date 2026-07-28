"""Notes tab strip: vault-shared, and skew-safe in the settings file."""


def test_defaults_when_nothing_saved(client):
    notes = client.get("/api/settings").json()["notes"]
    assert notes["max_open"] == 5
    assert notes["tabs"] == []


def test_tabs_round_trip_in_order_with_pins(client):
    tabs = [
        {"path": "1-Projects/a.md", "name": "a", "pinned": True},
        {"path": "3-Resources/b.md", "name": "b", "pinned": False},
    ]
    client.post("/api/settings/notes", json={"tabs": tabs, "max_open": 3})
    notes = client.get("/api/settings").json()["notes"]
    assert [t["path"] for t in notes["tabs"]] == [t["path"] for t in tabs]
    assert [t["pinned"] for t in notes["tabs"]] == [True, False]
    assert notes["max_open"] == 3


def test_max_open_is_clamped(client):
    client.post("/api/settings/notes", json={"max_open": 99})
    assert client.get("/api/settings").json()["notes"]["max_open"] == 20
    client.post("/api/settings/notes", json={"max_open": 0})
    assert client.get("/api/settings").json()["notes"]["max_open"] == 1


def test_duplicate_paths_collapse(client):
    client.post("/api/settings/notes", json={"tabs": [
        {"path": "1-Projects/a.md", "name": "a", "pinned": True},
        {"path": "1-Projects/a.md", "name": "a again", "pinned": False},
    ]})
    tabs = client.get("/api/settings").json()["notes"]["tabs"]
    assert len(tabs) == 1 and tabs[0]["pinned"] is True


def test_clear_all_writes_an_empty_strip(client):
    client.post("/api/settings/notes", json={"tabs": [
        {"path": "1-Projects/a.md", "name": "a", "pinned": True},
    ]})
    client.post("/api/settings/notes", json={"tabs": []})
    assert client.get("/api/settings").json()["notes"]["tabs"] == []


def test_other_settings_writes_preserve_the_strip(client):
    """An older backend knows nothing of `notes` — but every settings write
    merges the yaml block it read, so unknown keys survive. Saving funnel
    settings must not drop the tab strip."""
    client.post("/api/settings/notes", json={"tabs": [
        {"path": "1-Projects/a.md", "name": "a", "pinned": False},
    ]})
    client.post("/api/settings/funnel", json={"binding_limit": 2})
    body = client.get("/api/settings").json()
    assert body["funnel"]["binding_limit"] == 2
    assert [t["path"] for t in body["notes"]["tabs"]] == ["1-Projects/a.md"]


def test_malformed_entries_are_dropped_not_fatal(client, vault):
    """A hand-edited settings file shouldn't take the Notes tab down."""
    from backend.config import config

    config._save_vault_settings({"notes": {"max_open": "many", "tabs": [
        "not-a-dict", {"name": "no path"}, {"path": "  "},
        {"path": "1-Projects/ok.md"},
    ]}})
    notes = client.get("/api/settings").json()["notes"]
    assert notes["max_open"] == 5
    assert [t["path"] for t in notes["tabs"]] == ["1-Projects/ok.md"]
    assert notes["tabs"][0]["name"] == "ok.md"
