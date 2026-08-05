"""What the baseline promises an extension — the version of the seams.

`HOST_API` is the version of the five seams in `docs/EXTENSIONS.md`:
`vault_io`, the settings passthrough, the surface registry, the router
mount, the week-source point. An extension reads it from `/health` and
refuses to run against a host it doesn't know.

**Bump it only for a breaking change to those seams, and only on a minor
release.** Adding a seam, a field or an optional argument is additive and
does not bump it. This is deliberately independent of
`BUCKET_SCHEMA_VERSION`: that one is the vault's wire format, shared by
every instance through Syncthing, and the two move for different reasons.
"""

from pathlib import Path
from typing import Protocol, runtime_checkable

HOST_API = 1


def vault_root() -> Path:
    """The vault's root directory.

    For resolving a configured path — "2-Areas/Customer-A" against the vault
    the server is actually pointed at, which an extension cannot otherwise
    know. **Read-only for extensions**: every write still goes through
    `vault_io`, which is where the atomic write, the mtime guard and the
    conflict-copy rule live. A path from here plus a direct `open(..., "w")`
    bypasses all three.
    """
    from backend.config import config
    return config.vault_root


def addon_settings(addon_id: str) -> dict:
    """An extension's own top-level block from the vault settings file.

    The server-side mirror of the `addons` block clients already get from
    `GET /api/settings` — a router needs its own configuration too, and the
    client's copy is no use to it.

    Returns `{}` when the key is absent, so a fresh vault needs no seeding.
    The block is returned as stored, including keys this baseline has never
    heard of: it is the extension's namespace, and the baseline does not
    interpret it.

    There is deliberately no setter. An extension changing baseline settings
    is not something this contract should allow, and the one case that will
    want to write — a settings panel — is a seam of its own, not a hole in
    this one.
    """
    from backend.config import config
    block = config.addon_settings.get(addon_id)
    return dict(block) if isinstance(block, dict) else {}


@runtime_checkable
class AddonRouter(Protocol):
    """What `mount_addons` expects back from an extension module.

    A module named in the extension list exposes:

        def router() -> fastapi.APIRouter: ...

    routed under `/api/<addon-id>/*`. Nothing else is called on it, and it
    is imported once at startup — there is no runtime discovery and no
    reload.
    """

    def router(self): ...
