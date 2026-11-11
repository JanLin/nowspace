"""Filing a piece of the day's notepad into the note it belongs to.

Newest first, because the call you just had is the one you read when you
open a customer's note. The rule worth testing is where "first" is: under
the note's title, and above the entries it already keeps — never above
the title itself, which in a call note is often a date too.
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


def test_a_title_that_is_itself_a_date_is_still_a_title(note, client, vault):
    """A call note is often *called* a date. Reading "# 2026-07-29 call" as
    the log's first entry is how an entry ended up stacked on top of the
    title, outside the note it was filed into."""
    path = note("# 2026-07-29 call\n\n**When:** \n**With:** \n\n## Notes\n\n\n## Action points\n\n- [ ] \n")

    assert _log(client, path, "rang about the renewal").status_code == 200

    written = (vault / path).read_text()
    assert written.startswith("# 2026-07-29 call")
    assert written.index("2026-11-11 14:05") < written.index("**When:**")


def test_the_entry_goes_under_the_title(note, client, vault):
    path = note("# Customer X\n\nsome standing context\n")

    _log(client, path, "rang about the renewal")

    written = (vault / path).read_text()
    assert written.index("# Customer X") < written.index("rang about the renewal") < written.index("standing context")


def test_later_entries_stack_above_the_earlier_ones(note, client, vault):
    """Newest first is the whole point."""
    path = note("# Customer X\n")
    _log(client, path, "first call", "2026-11-11 14:05")
    _log(client, path, "second call", "2026-11-12 09:00")

    written = (vault / path).read_text()
    assert written.index("# Customer X") < written.index("second call") < written.index("first call")


def test_a_block_kept_above_the_entries_stays_there(note, client, vault):
    """An action point list or a running tally that already sits above the
    log must not be pushed down one call at a time."""
    path = note(
        "# Customer X\n\n## Open APs\n- chase the invoice\n\n"
        "#### 2026-10-28 11:15\n\nearlier call\n"
    )

    _log(client, path, "new call")

    written = (vault / path).read_text()
    assert written.index("Open APs") < written.index("new call") < written.index("earlier call")


def test_the_entry_is_written_at_the_level_the_note_already_uses(note, client, vault):
    """These notes were kept by hand before anything did it for them, and
    the heading depth is part of how they read."""
    path = note("# Customer X\n\n#### 2026-10-28 11:15\n\nearlier call\n")

    _log(client, path, "new call", "2026-11-11 14:05")

    assert "#### 2026-11-11 14:05" in (vault / path).read_text()


def test_frontmatter_is_not_something_to_write_above(note, client, vault):
    path = note("---\ntags: [customer]\n---\n\n# Customer X\n")

    _log(client, path, "rang about the renewal")

    written = (vault / path).read_text()
    assert written.startswith("---\ntags: [customer]\n---")
    assert written.index("# Customer X") < written.index("rang about the renewal")


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
