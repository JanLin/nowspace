"""Filing a piece of the day's notepad into the note it belongs to.

The notepad is where things get written down mid-call; it is not where
they live. Moving a piece of it into a customer's note has one rule worth
testing: a note may open with something that belongs above every entry —
an action-point list, a running tally — and newest-first must not mean
burying it one call at a time.
"""

import pytest


@pytest.fixture
def note(vault):
    def _write(text: str) -> str:
        p = vault / "1-Projects" / "Customer X.md"
        p.write_text(text, encoding="utf-8")
        return "1-Projects/Customer X.md"
    return _write


def _log(client, path, text, stamp="2026-11-11 14:05"):
    return client.post("/api/notes/log", json={"path": path, "text": text, "stamp": stamp})


def test_the_first_entry_goes_below_what_the_note_already_says(note, client, vault):
    """Nothing in the note is dated yet, so there is no log to be at the top
    of — and the opening block is the one thing we know must not move."""
    path = note("# Customer X\n\n## Open APs\n- chase the invoice\n")

    assert _log(client, path, "rang about the renewal").status_code == 200

    written = (vault / path).read_text()
    assert written.index("Open APs") < written.index("#### 2026-11-11 14:05")
    assert "rang about the renewal" in written


def test_later_entries_stack_above_the_earlier_ones(note, client, vault):
    """Newest first is the whole point: the call you just had is the one
    you read when you open the note."""
    path = note("# Customer X\n\n## Open APs\n- chase the invoice\n")
    _log(client, path, "first call", "2026-11-11 14:05")
    _log(client, path, "second call", "2026-11-12 09:00")

    written = (vault / path).read_text()
    assert written.index("Open APs") < written.index("second call") < written.index("first call")


def test_a_hand_written_dated_heading_counts_as_the_log(note, client, vault):
    """These notes were kept by hand before anything did it for them, and
    an entry written as "## 2026-10-02" is the same kind of thing."""
    path = note("# Customer X\n\nsome standing context\n\n## 2026-10-02\n\nold call\n")

    _log(client, path, "new call")

    written = (vault / path).read_text()
    assert written.index("standing context") < written.index("new call") < written.index("old call")


def test_the_text_arrives_as_it_was_written(note, client, vault):
    """It came out of a notepad mid-call. Reformatting it is how the thing
    you meant to keep stops being what you wrote."""
    path = note("# Customer X\n")
    raw = "- they want the Q1 date moved\n- Ana is the new contact\n\nthey will send the SOW"

    _log(client, path, raw)

    assert raw in (vault / path).read_text()


def test_a_note_that_does_not_exist_yet_is_created(vault, client):
    r = _log(client, "1-Projects/Brand New.md", "first ever")
    assert r.status_code == 200
    assert "first ever" in (vault / "1-Projects/Brand New.md").read_text()


def test_the_entry_is_findable_by_the_link_left_behind(note, client, vault):
    """The day's notes keep "[[Customer X#2026-11-11 14:05]]" where the text
    used to be, so the heading has to be exactly that."""
    path = note("# Customer X\n")
    _log(client, path, "rang about the renewal", "2026-11-11 14:05")
    assert "#### 2026-11-11 14:05" in (vault / path).read_text()
