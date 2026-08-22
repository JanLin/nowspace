import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def vault(tmp_path, monkeypatch):
    """Point the config singleton at a throwaway vault for one test."""
    from backend.config import config

    inbox = tmp_path / "0-Inbox"
    inbox.mkdir()
    for sub in ("1-Projects", "2-Areas", "3-Resources", "4-Archive/a0-Inbox"):
        (tmp_path / sub).mkdir(parents=True)
    monkeypatch.setattr(config, "vault_path", inbox)
    monkeypatch.setattr(config, "vault_root", tmp_path)
    monkeypatch.setattr(config, "_vault_cfg_cache", None)
    monkeypatch.setattr(config, "_vault_cfg_mtime", None)
    monkeypatch.setattr(config, "_vault_cfg_path", None, raising=False)
    return tmp_path


@pytest.fixture
def client(vault):
    from backend.main import app

    return TestClient(app)
