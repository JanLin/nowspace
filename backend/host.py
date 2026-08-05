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

from typing import Protocol, runtime_checkable

HOST_API = 1


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
