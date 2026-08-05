# Extensions

Nowspace is one repository. An extension is another — developed, versioned
and installed on its own, attached through five places in the baseline and
nothing else.

This file is the contract. If an extension needs something that isn't here,
that is a pull request against the baseline, not a reach through it.

## What an extension may import

The whole of it:

```
frontend   src/surfaces.ts      registerSurface, registerWeekSource, types
                                React comes from the host — never bundle a
                                second copy, or you get two Reacts and hooks
                                that throw

backend    backend.vault_io     read_text, write_text_guarded, is_conflict_copy
           backend.host         HOST_API, AddonRouter
```

Explicitly not importable, now or later:

- `backend.routers.plan` internals — `_parse_bucket_file`,
  `_format_bucket_tasks`, `_extract_funnel_meta` and their neighbours. They
  are underscore-prefixed because they carry the vault's format and must stay
  free to change.
- `backend.models.BucketTask`. External items are not bucket items.
- `backend.config` privates.

Where an extension needs their behaviour — parsing a bucket-format file, for
instance — the baseline does the work behind a seam and hands back the result.

## The five seams

### 1. `backend/vault_io.py` — writing to the vault

```python
read_text(path, default=..., *, retries=2, delay=0.05) -> str
write_text_guarded(path, content, expected_mtime=None, *, what="File") -> float
write_guard(path, expected_mtime, *, what="File") -> None
is_conflict_copy(path) -> bool
```

Every write to a vault file goes through this, including an extension's own
files. It gives you an atomic write, the `expected_mtime` guard and its 409,
refusal to touch a `.sync-conflict-*` copy, and a read that tolerates a file
caught mid-sync. `read_text` without a `default` raises 404/500 rather than
returning `""` — a read-then-rewrite path that reads a half-synced file as
empty is how a file gets rewritten from nothing.

**An extension may never write a bucket file or a week file directly.** Every
write to baseline-owned data goes through a baseline API, so `extra="forbid"`,
the client-version guard and the mtime guard keep working. Writing those files
yourself bypasses all three and corrupts other instances through Syncthing.

### 2. Settings

An extension's settings live under **its own top-level key** in the vault
settings file (`Plan Week Configuration.md`), and its switch is
`<addon-id>.enabled`:

```yaml
relay:
  enabled: true
  endpoint: https://…
```

Guaranteed: a settings save merges, so a key the baseline doesn't know
survives (`test_host_seam.py`). Those keys come back to clients in the
`addons` block of `GET /api/settings`, untouched — that is how a surface
reads its own switch.

Not inside `app:`. That map is the baseline's, and an instance older than
your extension would strip an unknown *non-boolean* key there and sync the
deletion to every device.

### 3. `frontend/src/surfaces.ts` — a tab

```ts
registerSurface({
  id: "relay",            // also the route prefix and the settings key
  icon: "🛰",
  name: "Relay",
  order: 25,              // 10 Plan · 20 Bucket · 30 Notes · 40 Habits · 50 Time · 90 Settings
  enabledBy: "relay.enabled",
  component: RelayPanel,  // props: { onOpenNote(path, name) }
});
```

Registered at import time from `frontend/src/addons.generated.ts`, before the
first render. Each surface renders inside an error boundary: one that throws
costs its own tab and logs once, and the rest of the app keeps working.

### 4. `backend/addons.py` — routes

```python
ADDON_MODULES: list[str] = []          # e.g. ["nowspace_relay"]
```

A module named here is imported once at startup and must expose
`router() -> APIRouter`, mounted at `/api/<id>/*`. Failure — not installed,
raises on import, no router — is one log line and a server that still starts.
`/health` reports what actually mounted.

The list is a **build input**, read by three things that have to agree: the
app, `build-backend.sh` (PyInstaller hidden imports — a frozen sidecar
discovers nothing at run time) and the Dockerfile. `NOWSPACE_ADDONS` adds to
it per deployment. There is no runtime discovery and no dynamic script
loading: the desktop app is frozen and the browser app runs under
`script-src 'self'`, and both would have to be relaxed for it.

### 5. Week sources, and the `~x` token

```ts
registerWeekSource({
  id: "relay",
  list: () => Promise<WeekItem[]>,          // read-only: what could be scheduled
  schedule: (item, day) => Promise<void>,   // the user put one in a day
  complete: (ref) => Promise<void>,         // the user ticked it off
});
```

An item scheduled from a source carries `~x<6 hex>` on its week line — a
reference back to where it came from. Colon-free, like `~es` and `~i…`,
because a colon on a week line is read as a `Group:` prefix.

The baseline never interprets it. It strips it for display and re-emits it on
save, so it survives a save, a carry-forward into next week and the archive at
transition — including on an instance where the extension isn't installed.
There is no `BucketTask` field for it and no schema bump: it rides week lines,
not bucket lines.

## `HOST_API`

`backend/host.py` carries `HOST_API`, reported by `/health`. It versions the
five seams above and nothing else.

- **Bump it only for a breaking change to a seam, and only on a minor
  release.** Adding a seam, a field, or an optional argument is additive and
  does not bump it.
- It is deliberately independent of `BUCKET_SCHEMA_VERSION`, which is the
  vault's wire format shared through Syncthing. The two move for different
  reasons and must not be tied together.

An extension reads `host_api` at startup and refuses to run against a host it
doesn't know.

## Naming

| | |
| --- | --- |
| baseline | `nowspace` |
| extension repository | `nowspace-<id>` |
| npm package | `@nowspace/<id>` |
| Python package | `nowspace-<id>` (module `nowspace_<id>`) |
| routes | `/api/<id>/*` |
| settings key | `<id>` , switch `<id>.enabled` |
| surface id | `<id>` |

## Development

An extension can be built against a checkout with `npm link` and
`pip install -e`, wired into nothing. Add its module name to `ADDON_MODULES`
(or `NOWSPACE_ADDONS`) and its `register()` call to `addons.generated.ts`
locally; neither belongs in a baseline commit.

`addons.generated.ts` is committed empty, and the `baseline` CI job fails if
it isn't. A tracked file cannot be ignored, so a local regeneration shows up
in `git status`; `git update-index --skip-worktree
frontend/src/addons.generated.ts` quietens that on a machine where an
extension is installed.
