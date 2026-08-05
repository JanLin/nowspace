"""The write discipline for a synced vault — seam 1 of the extension contract.

These are the rules an extension inherits by importing vault_io, so they are
pinned here rather than left to the routes that happen to use them.
"""

import os

import pytest
from fastapi import HTTPException

from backend import vault_io


# ── atomic write ──────────────────────────────────────────────────────

def test_write_is_atomic_never_truncates(tmp_path):
    """No moment where the file exists and is empty.

    A truncating open is the failure that empties a note on every synced
    device; the temp-file-and-replace is what this module exists for.
    """
    target = tmp_path / "note.md"
    vault_io.write_text_guarded(target, "first version, quite long\n")

    seen = []
    real_replace = os.replace

    def watch(src, dst):
        # Whatever a reader would see the instant before the swap
        seen.append(target.read_text(encoding="utf-8"))
        return real_replace(src, dst)

    import backend.vault_io as m
    orig = m.os.replace
    m.os.replace = watch
    try:
        vault_io.write_text_guarded(target, "second version\n")
    finally:
        m.os.replace = orig

    assert seen == ["first version, quite long\n"]
    assert target.read_text(encoding="utf-8") == "second version\n"


def test_write_leaves_no_temp_files_behind(tmp_path):
    vault_io.write_text_guarded(tmp_path / "note.md", "body\n")
    assert [p.name for p in tmp_path.iterdir()] == ["note.md"]


def test_write_creates_parent_directories(tmp_path):
    target = tmp_path / "2-Areas" / "Customer" / "note.md"
    vault_io.write_text_guarded(target, "body\n")
    assert target.read_text(encoding="utf-8") == "body\n"


# ── the expected_mtime guard, and its 409 ─────────────────────────────

def test_guard_refuses_a_file_that_moved(tmp_path):
    target = tmp_path / "Plan Week.md"
    vault_io.write_text_guarded(target, "one\n")
    stale = target.stat().st_mtime - 5  # as if the client read it 5s ago

    os.utime(target, (stale + 4, stale + 4))  # …and Obsidian saved since
    with pytest.raises(HTTPException) as e:
        vault_io.write_text_guarded(target, "two\n", stale, what="Week file")
    assert e.value.status_code == 409
    assert "Week file changed on disk" in e.value.detail
    assert target.read_text(encoding="utf-8") == "one\n"  # nothing written


def test_guard_allows_a_file_that_did_not_move(tmp_path):
    target = tmp_path / "Plan Week.md"
    vault_io.write_text_guarded(target, "one\n")
    mtime = target.stat().st_mtime
    vault_io.write_text_guarded(target, "two\n", mtime)
    assert target.read_text(encoding="utf-8") == "two\n"


def test_guard_is_a_no_op_for_a_file_that_does_not_exist_yet(tmp_path):
    target = tmp_path / "new.md"
    vault_io.write_text_guarded(target, "one\n", expected_mtime=123.0)
    assert target.exists()


def test_write_guard_can_be_checked_before_the_work(tmp_path):
    """Routes that parse and validate first refuse first."""
    target = tmp_path / "Bucket.md"
    vault_io.write_text_guarded(target, "one\n")
    stale = target.stat().st_mtime - 5
    with pytest.raises(HTTPException) as e:
        vault_io.write_guard(target, stale, what="Bucket file")
    assert e.value.status_code == 409


# ── sync conflict copies ──────────────────────────────────────────────

CONFLICT = "Plan Week.sync-conflict-20260804-120000-ABCDEFG.md"


def test_is_conflict_copy():
    assert vault_io.is_conflict_copy(CONFLICT)
    assert vault_io.is_conflict_copy("/vault/0-Inbox/" + CONFLICT)
    assert not vault_io.is_conflict_copy("Plan Week.md")
    assert not vault_io.is_conflict_copy("/vault/0-Inbox/Plan Week.md")


def test_conflict_copy_is_never_read(tmp_path):
    p = tmp_path / CONFLICT
    p.write_text("stale copy\n", encoding="utf-8")
    with pytest.raises(HTTPException) as e:
        vault_io.read_text(p)
    assert e.value.status_code == 409


def test_conflict_copy_is_never_written(tmp_path):
    p = tmp_path / CONFLICT
    p.write_text("stale copy\n", encoding="utf-8")
    with pytest.raises(HTTPException) as e:
        vault_io.write_text_guarded(p, "anything\n")
    assert e.value.status_code == 409
    assert p.read_text(encoding="utf-8") == "stale copy\n"


# ── reads: mid-sync tolerance, and where it must NOT apply ────────────

def test_read_missing_file_returns_the_default(tmp_path):
    assert vault_io.read_text(tmp_path / "nope.md", default="") == ""


def test_read_missing_file_without_a_default_is_404(tmp_path):
    with pytest.raises(HTTPException) as e:
        vault_io.read_text(tmp_path / "nope.md")
    assert e.value.status_code == 404


def test_read_retries_a_file_that_is_mid_sync(tmp_path, monkeypatch):
    """Invalid UTF-8 now, whole a moment later — the sync landed."""
    target = tmp_path / "note.md"
    target.write_bytes(b"\xff\xfe partial")
    calls = {"n": 0}
    real = type(target).read_text

    def flaky(self, *a, **kw):
        calls["n"] += 1
        if calls["n"] == 1:
            raise UnicodeDecodeError("utf-8", b"\xff", 0, 1, "invalid start byte")
        return "whole file\n"

    monkeypatch.setattr(type(target), "read_text", flaky)
    try:
        assert vault_io.read_text(target, delay=0) == "whole file\n"
        assert calls["n"] == 2
    finally:
        monkeypatch.setattr(type(target), "read_text", real)


def test_read_without_a_default_raises_rather_than_reporting_empty(tmp_path, monkeypatch):
    """The read-then-rewrite case: a half-synced file must not read as "".

    Returning "" here is how a week file gets rewritten from nothing.
    """
    target = tmp_path / "Plan Week.md"
    target.write_text("real content\n", encoding="utf-8")

    def always_broken(self, *a, **kw):
        raise OSError("input/output error")

    monkeypatch.setattr(type(target), "read_text", always_broken)
    with pytest.raises(HTTPException) as e:
        vault_io.read_text(target, retries=0)
    assert e.value.status_code == 500
