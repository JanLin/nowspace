"""Which extension modules this build includes, and mounting them.

`ADDON_MODULES` is a **build input, not a runtime scan**. One list, read by
three things that must agree:

  * `main.py`, to mount the routers
  * `build-backend.sh`, for PyInstaller's hidden imports — a frozen sidecar
    has no import machinery to discover anything at run time
  * the Dockerfile, for the install step

Nothing is discovered by scanning a directory, and nothing is imported from a
path the user can write to. The desktop app is a frozen bundle and the browser
app runs under a `script-src 'self'` CSP; both would have to be relaxed to
support that, which is a large hole for a packaging convenience.

**Empty by default**, and empty is the shipped state: an extension enters this
list only when it is being installed deliberately, on one deployment.
"""

from __future__ import annotations

import logging
import os

log = logging.getLogger("nowspace.addons")

# e.g. ["nowspace_relay"]. Also settable per-deployment with
# NOWSPACE_ADDONS="nowspace_relay,nowspace_other" — the mini installs a
# prototype that way without a rebuild.
ADDON_MODULES: list[str] = []


def addon_modules() -> list[str]:
    """The list, plus anything the environment adds. Deduplicated, in order."""
    names = list(ADDON_MODULES)
    for extra in (os.environ.get("NOWSPACE_ADDONS") or "").split(","):
        extra = extra.strip()
        if extra and extra not in names:
            names.append(extra)
    return names


def mount_addons(app) -> list[str]:
    """Import each listed module and mount what it returns. Never raises.

    A broken extension is one log line and a missing tab, not a server that
    won't start — the failure mode that matters is a subscriber's Docker
    image refusing to boot because of something optional.

    Returns the ids that mounted, for `/health`.
    """
    mounted: list[str] = []
    for name in addon_modules():
        try:
            module = __import__(name, fromlist=["router"])
            router = module.router() if callable(getattr(module, "router", None)) else None
            if router is None:
                log.warning("addon %s exposes no router() — skipped", name)
                continue
            app.include_router(router)
            mounted.append(name)
            log.info("addon %s mounted", name)
        except Exception as e:  # noqa: BLE001 — an addon may fail in any way
            log.warning("addon %s failed to load (%s: %s) — continuing without it",
                        name, type(e).__name__, e)
    return mounted
