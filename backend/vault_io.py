"""Every read and write of a vault file goes through here.

The vault is a folder of markdown shared by Syncthing between a laptop, a
mini, phones and any number of Docker instances, and edited in Obsidian at
the same time. Four rules came out of that, each from a real corruption:

  * **Atomic writes.** A truncating `open(...,"w")` leaves a zero-length file
    for as long as it takes to write the new one. Syncthing propagating that
    window is a note emptied on every other device. Write a temp file beside
    the target and `os.replace` it in — the reader sees the old file or the
    new one, never a half.
  * **The `expected_mtime` guard.** Whoever saves last wins is the wrong
    answer when the other writer was Obsidian, or another device's sync. If
    the file moved since the client read it, refuse with **409** and let the
    client reload.
  * **`.sync-conflict-*` files are neither read nor written.** Syncthing
    parks a conflicted copy beside the original. Reading one shows stale
    content as if it were current; writing one buries the real file.
  * **A read tolerates a file mid-sync.** A partially written file reads as
    truncated bytes or invalid UTF-8; a moment later it is whole. Retry, then
    fall back to the caller's default rather than raising into a route.

This module is part of the extension contract (`docs/EXTENSIONS.md`): an
extension writing anywhere in the vault imports `read_text`,
`write_text_guarded` and `is_conflict_copy` from here, and nothing else.
"""

from __future__ import annotations

import os
import time
import uuid
from pathlib import Path
from typing import Optional, Union

from fastapi import HTTPException

PathLike = Union[str, Path]

# Filesystems report mtime with varying resolution, and a save that lands in
# the same tick as the read it came from must not read as a conflict.
MTIME_SLACK = 0.01

CONFLICT_MARKER = ".sync-conflict-"


def is_conflict_copy(path: PathLike) -> bool:
    """True for a Syncthing conflict copy — `note.sync-conflict-2026….md`."""
    return CONFLICT_MARKER in Path(path).name


_NO_DEFAULT = object()


def read_text(path: PathLike, default=_NO_DEFAULT, *, retries: int = 2, delay: float = 0.05) -> str:
    """Read a vault file, tolerating one that is mid-sync.

    Pass `default` for a file that is allowed to be absent or unreadable — an
    empty bucket, a week with no notes yet. **Without** a default, a missing
    file raises 404 and one still unreadable after the retries raises 500,
    which is what a read-then-rewrite route needs: quietly reading a
    half-synced file as `""` and saving that back is how a week file gets
    emptied.

    A conflict copy is refused either way, because returning its contents is
    how a stale copy gets saved over the live file.
    """
    p = Path(path)
    if is_conflict_copy(p):
        raise HTTPException(
            status_code=409,
            detail=f"{p.name} is a sync conflict copy — resolve it in the vault, it is not editable here",
        )
    for attempt in range(retries + 1):
        try:
            return p.read_text(encoding="utf-8")
        except FileNotFoundError:
            if default is _NO_DEFAULT:
                raise HTTPException(status_code=404, detail=f"File not found: {p.name}")
            return default
        except (OSError, UnicodeDecodeError) as e:
            # Mid-sync: the bytes on disk are a partial copy. Give the writer
            # a moment rather than reporting the file as broken.
            if attempt == retries:
                if default is _NO_DEFAULT:
                    raise HTTPException(status_code=500, detail=f"Error reading {p.name}: {e}")
                return default
            time.sleep(delay)
    return default  # unreachable; keeps the type checker honest


def write_guard(path: PathLike, expected_mtime: Optional[float], *, what: str = "File") -> None:
    """Raise 409 now if the file has moved since the client read it.

    `write_text_guarded` checks this itself; this is for routes that do real
    work — parsing, funnel validation — before they have anything to write,
    and would rather refuse first than refuse afterwards.
    """
    if expected_mtime is None:
        return
    p = Path(path)
    if not p.exists():
        return
    try:
        on_disk = p.stat().st_mtime
    except OSError:
        return
    if on_disk > expected_mtime + MTIME_SLACK:
        raise HTTPException(
            status_code=409,
            detail=f"{what} changed on disk since it was loaded — reload before saving",
        )


def write_text_guarded(
    path: PathLike,
    content: str,
    expected_mtime: Optional[float] = None,
    *,
    what: str = "File",
) -> float:
    """Write a vault file atomically, refusing to overwrite a newer one.

    `expected_mtime` is the mtime the client last read. If the file on disk
    has moved on — Obsidian, another device, a sync landing — this raises
    **409** and writes nothing. `what` names the file in that message, since
    it is shown to the user.

    Returns the new mtime, which the caller hands back so the client's next
    save carries a current guard.
    """
    p = Path(path)
    if is_conflict_copy(p):
        raise HTTPException(
            status_code=409,
            detail=f"{p.name} is a sync conflict copy — resolve it in the vault, it is not writable here",
        )
    write_guard(p, expected_mtime, what=what)
    p.parent.mkdir(parents=True, exist_ok=True)
    # Same directory as the target: os.replace is only atomic within one
    # filesystem, and a vault can sit on an external disk. Dot-prefixed so a
    # scan that catches it mid-write doesn't take it for a note.
    tmp = p.with_name(f".{p.name}.{os.getpid()}-{uuid.uuid4().hex[:8]}.tmp")
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(content)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, p)
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Error writing {p.name}: {e}")
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass  # the replace consumed it, which is the normal path
    return p.stat().st_mtime
