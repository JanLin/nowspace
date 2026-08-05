"""Seam 4: the router mount.

The failure that matters is a subscriber's Docker image refusing to start
because something optional is broken. A listed extension that explodes must
cost one log line and its own routes — never the server.
"""

import sys

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend import addons


@pytest.fixture
def clean_env(monkeypatch):
    monkeypatch.setattr(addons, "ADDON_MODULES", [])
    monkeypatch.delenv("NOWSPACE_ADDONS", raising=False)


@pytest.fixture
def fake_addon(tmp_path, monkeypatch):
    """Write a real module and put it on sys.path.

    Not a types.ModuleType parked in sys.modules: such a module has no
    __spec__, and Python 3.12's import system does not treat it the way 3.9
    does — which is how this file passed locally and failed on CI. An
    extension is a real installed package, so the test uses one.
    """
    monkeypatch.syspath_prepend(str(tmp_path))

    def write(name: str, body: str) -> str:
        (tmp_path / f"{name}.py").write_text(body, encoding="utf-8")
        sys.modules.pop(name, None)
        monkeypatch.delitem(sys.modules, name, raising=False)
        return name

    return write


# ── the empty state, which is the shipped one ─────────────────────────

def test_no_addons_by_default(clean_env):
    assert addons.addon_modules() == []
    app = FastAPI()
    before = len(app.routes)
    assert addons.mount_addons(app) == []
    assert len(app.routes) == before


def test_the_baseline_ships_an_empty_list():
    """Guards against an extension being committed into the default build."""
    assert addons.ADDON_MODULES == []


# ── a working extension ───────────────────────────────────────────────

def test_a_listed_module_is_mounted(clean_env, monkeypatch, fake_addon):
    name = fake_addon("fake_addon_ok", """
from fastapi import APIRouter

def router():
    r = APIRouter(prefix="/api/fake", tags=["fake"])

    @r.get("/ping")
    def ping():
        return {"pong": True}

    return r
""")
    monkeypatch.setattr(addons, "ADDON_MODULES", [name])

    app = FastAPI()
    assert addons.mount_addons(app) == [name]
    # Reachable, not merely present in app.routes — the route being callable
    # at /api/<id>/* is the actual contract (docs/EXTENSIONS.md)
    assert TestClient(app).get("/api/fake/ping").json() == {"pong": True}


# ── a broken one ──────────────────────────────────────────────────────

def test_a_module_that_raises_on_import_leaves_a_running_server(clean_env, monkeypatch, caplog):
    monkeypatch.setattr(addons, "ADDON_MODULES", ["definitely_not_installed_addon"])
    app = FastAPI()
    before = len(app.routes)
    with caplog.at_level("WARNING", logger="nowspace.addons"):
        assert addons.mount_addons(app) == []      # no crash
    assert len(app.routes) == before               # nothing half-mounted
    # One line, naming the module — not a stack trace on every request
    lines = [r for r in caplog.records if r.name == "nowspace.addons"]
    assert len(lines) == 1
    assert "definitely_not_installed_addon" in lines[0].getMessage()


def test_a_module_whose_router_raises_is_skipped(clean_env, monkeypatch, fake_addon):
    name = fake_addon("fake_addon_boom", """
def router():
    raise RuntimeError("bad wiring")
""")
    monkeypatch.setattr(addons, "ADDON_MODULES", [name])
    assert addons.mount_addons(FastAPI()) == []


def test_a_module_without_a_router_is_skipped(clean_env, monkeypatch, fake_addon):
    name = fake_addon("fake_addon_bare", "VALUE = 1\n")
    monkeypatch.setattr(addons, "ADDON_MODULES", [name])
    assert addons.mount_addons(FastAPI()) == []


def test_one_broken_addon_does_not_stop_the_next(clean_env, monkeypatch, fake_addon):
    name = fake_addon("fake_addon_second", """
from fastapi import APIRouter

def router():
    return APIRouter(prefix="/api/second")
""")
    monkeypatch.setattr(addons, "ADDON_MODULES", ["not_installed_at_all", name])
    assert addons.mount_addons(FastAPI()) == [name]


# ── the list is a build input ─────────────────────────────────────────

def test_the_environment_can_add_to_the_list(clean_env, monkeypatch):
    """How the mini installs a prototype without rebuilding the image."""
    monkeypatch.setenv("NOWSPACE_ADDONS", "one, two ,one")
    assert addons.addon_modules() == ["one", "two"]


def test_health_reports_what_actually_mounted(client):
    body = client.get("/health").json()
    assert body["addons"] == []
