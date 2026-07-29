"""Creating folders from the vault browser."""


def test_creates_a_folder(client, vault):
    r = client.post("/api/vault/folder", json={"path": "1-Projects/Client X"})
    assert r.status_code == 200 and r.json()["created"] is True
    assert (vault / "1-Projects" / "Client X").is_dir()


def test_creates_nested_parents(client, vault):
    client.post("/api/vault/folder", json={"path": "2-Areas/Customer-C/_agent/proposals"})
    assert (vault / "2-Areas" / "Customer-C" / "_agent" / "proposals").is_dir()


def test_existing_folder_is_not_an_error(client, vault):
    client.post("/api/vault/folder", json={"path": "1-Projects/Twice"})
    r = client.post("/api/vault/folder", json={"path": "1-Projects/Twice"})
    assert r.status_code == 200 and r.json()["created"] is False


def test_refuses_a_path_that_is_a_file(client, vault):
    (vault / "1-Projects" / "note.md").write_text("# note\n")
    r = client.post("/api/vault/folder", json={"path": "1-Projects/note.md"})
    assert r.status_code == 409


def test_refuses_empty_path(client):
    assert client.post("/api/vault/folder", json={"path": "  "}).status_code == 400


def test_refuses_traversal_outside_the_vault(client, vault):
    r = client.post("/api/vault/folder", json={"path": "../escaped"})
    assert r.status_code == 400
    assert not (vault.parent / "escaped").exists()
