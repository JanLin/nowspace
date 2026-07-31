# Contributing to Nowspace

Nowspace is a personal project shared in the open. Issues and pull requests are
genuinely welcome, and it's worth being straight about what that does and
doesn't imply: they are read when time allows, and there is no undertaking to
respond, to fix, or to merge. This is not anyone's day job. A pull request
sitting open for a while means exactly that and nothing more.

The software carries no warranty and no support commitment — that's the AGPL's
terms, not fine print added on top. Support, hosting and service levels exist
only under separate commercial agreement with Linaltec AB.

## Before you build something large

Open an issue first. Nowspace has a written philosophy and a set of binding
non-goals — no notifications or nudges, capture is never gated, limits refuse
rather than warn, and the system is measured while the person is not. A
well-built feature that crosses one of those is still a feature that won't be
merged, and finding that out after the work is done is nobody's idea of a good
time. `docs/philosophy.md` is the short version; `CLAUDE.md` lists the
constraints that most often surprise people.

The one that catches everyone: **any change to the on-disk task format needs a
`BUCKET_SCHEMA_VERSION` bump in a minor release**, never a patch. Installations
sync a shared vault over Syncthing and run mixed versions, so a format change
without the bump silently corrupts other people's data.

## Before you open a pull request

```bash
python3 -m pytest backend/tests -q
cd frontend && npx tsc --noEmit
```

Both must pass. If `backend/tests/test_handoff.py` fails, an area boundary has
leaked — that test is a canary and weakening it to get a change through defeats
its entire purpose.

Develop against the staging vault, never a real one. See the "Process" section
of `CLAUDE.md` for bring-up.

## Licensing of contributions

Nowspace is licensed under the **GNU Affero General Public License v3.0** (see
`LICENSE`). By opening a pull request you agree that your contribution is
offered under the same licence.

The AGPL is a deliberate choice, not a default. It means anyone is free to
use, study, modify and share Nowspace — and that anyone who runs a modified
version as a network service has to make their source available too. The point
is that improvements come back rather than disappearing into someone's closed
product.

If the AGPL doesn't work for your situation, a commercial licence is available
— open an issue or get in touch.
