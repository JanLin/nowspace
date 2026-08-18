# Extensions

Nowspace is one repository. An extension is another — developed, versioned
and installed on its own, attached through five places in the baseline and
nothing else.

This file is the contract. If an extension needs something that isn't here,
that is a pull request against the baseline, not a reach through it.

## What an extension may import

The whole of it:

```
frontend   (nothing)            The host is passed to your register(host) —
                                see seam 3. You import nothing from the
                                baseline, not even React, which the host
                                provides: a second bundled copy gives you
                                two Reacts and hooks that throw.

backend    backend.vault_io     read_text, write_text_guarded,
                                write_guard, is_conflict_copy
           backend.host         HOST_API, AddonRouter,
                                vault_root, addon_settings,
                                plan_paths
```

`vault_root()` is for **resolving** a configured path against the vault this
server is pointed at. Every write still goes through `vault_io` — a path from
here plus a direct `open(..., "w")` bypasses the atomic write, the mtime
guard and the conflict-copy rule in one line.

`plan_paths()` returns where the plan files live, vault-relative and
resolved by the baseline's own settings parse — `{"folder", "week_file",
"bucket_file"}`. It exists because the first extension needed exactly this
and had to re-read the configuration file with a second parser; when the
owner moved the plan folder, the two parsers disagreed and the extension's
scheduled-state display silently emptied. Read-only like everything here.

`addon_settings("<id>")` returns your own top-level block from the vault
settings file, or `{}`. It is the server-side mirror of the `addons` block
clients get from `GET /api/settings`; a router needs its own configuration
too, and the client's copy is no use to it. There is no setter, deliberately:
a settings panel is a seam of its own rather than a hole in this one.

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

An extension exports `register(host)`. The host is **handed in**, not
imported — the baseline is not a published package, and an alias would need a
matching `tsconfig` path in every extension plus an `external` entry in its
bundler, and would still behave differently in dev and in a build.

```ts
// Declared locally — this type is the whole of the frontend contract.
// (Copy it; a types-only package can come later.)
type NowspaceHost = {
  HOST_UI_API: number;
  registerSurface: (s: Surface) => void;
  registerWeekSource: (s: WeekSource) => void;
  surfaceEnabled: (s: Surface, settings: unknown) => boolean;
  externalRef: (text: string) => string | null;
};

export function register(host: NowspaceHost) {
  if (host.HOST_UI_API !== 1) return;   // a host you don't know: stay away

  host.registerSurface({
    id: "relay",            // also the route prefix and the settings key
    icon: "🛰",
    name: "Relay",
    order: 25,              // 10 Plan · 20 Bucket · 30 Notes · 40 Habits · 50 Time · 90 Settings
    enabledBy: "relay.enabled",
    component: RelayPanel,  // props: { onOpenNote(path, name) }
  });
}
```

`register(host)` is called at import time from
`frontend/src/addons.generated.ts`, before the first render. Each surface
renders inside an error boundary: one that throws costs its own tab and logs
once, and the rest of the app keeps working.

`HOST_UI_API` is the UI half of the version, moving under the same rule as
`HOST_API`: additive changes don't bump it.

### Styling a surface

**Tailwind classes in a prebuilt extension bundle produce no CSS.** Tailwind
v4 generates from the sources it scans, and it does not scan built packages
under `node_modules` — so a class name that arrives as a string in your bundle
was never seen, and no rule exists for it. This costs a day to discover.

Use inline styles with the baseline's CSS variables, which is what keeps an
extension in step with the theme:

```tsx
<div style={{ background: "var(--bg-secondary)", color: "var(--text)",
              border: "1px solid var(--border)" }}>
```

`--bg`, `--bg-secondary`, `--bg-tertiary`, `--text`, `--text-secondary`,
`--text-tertiary`, `--border`, `--border-strong`, `--card`, `--card-border`,
`--accent`, `--accent-bg` — all defined for both themes in `index.css`, and
they follow the theme toggle without an extension doing anything.

Or ship your own CSS file and import it from your entry. Neither needs a
baseline change.

### Packaging a surface

**Ship a built bundle, with `react` external.** The host compiles nothing on
your behalf: raw JSX resolved from outside the app's `node_modules` cannot
find `react/jsx-runtime` and the build fails outright. Build your extension
with `react` and `react-dom` as peer dependencies marked external, so the
single copy the host already loaded is the one your components use — two
copies of React give you hooks that throw.

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

## Installing one on a deployment

**An extension is installed by a deployment, never by a commit here.** The
baseline ships with an empty list — the `baseline` CI job fails if that stops
being true — so one release serves every instance, whether or not it is
carrying a prototype. Removing an extension is removing a variable, not
reverting a release.

Two halves, because they are constrained differently:

| | how | when it takes effect |
| --- | --- | --- |
| backend | `pip install nowspace-relay`, then `NOWSPACE_ADDONS=nowspace_relay` | server start |
| frontend | `npm install @nowspace/relay`, then `NOWSPACE_ADDONS_UI=@nowspace/relay` | **build** |

The frontend cannot be a runtime switch: a Tauri build runs under
`script-src 'self'`, so `register()` has to be inside the bundle.
`npm run build` runs `scripts/generate-addons.mjs`, which writes
`src/addons.generated.ts` from `NOWSPACE_ADDONS_UI`. Unset, it writes the
empty stub byte for byte — a baseline build leaves the tree clean, which CI
checks.

`NOWSPACE_ADDONS_UI` holds import specifiers, verbatim: `@nowspace/relay` for
a published package, or a path like `/opt/nowspace-relay` for a checkout you
are still writing. A specifier that isn't installed **fails the build** — the
opposite of the backend, where a missing module is one log line and a running
server. A build has time to be fixed; a server has users waiting.

### On the mini

```bash
# once
.venv/bin/pip install -e /opt/nowspace-relay
# in com.nowspace.server.plist, alongside the existing keys:
#   <key>EnvironmentVariables</key>
#   <dict><key>NOWSPACE_ADDONS</key><string>nowspace_relay</string></dict>

# every update: deploy/update-nowspace.sh reads this and reinstalls before
# building, because npm ci wipes node_modules and the clone is reset --hard
export NOWSPACE_ADDONS_UI=/opt/nowspace-relay
```

### In a Docker image

Add the two installs to that image's build (`pip install` next to the
requirements step, `npm install` before `npm run build`) and set both
variables. The baseline image, which is the one subscribers get, sets
neither.

## Development

An extension can be built against a checkout with `npm link` and
`pip install -e`, wired into nothing.

Do not edit `addons.generated.ts` — every build rewrites it. If you build
locally with `NOWSPACE_ADDONS_UI` set, the file will show as modified;
`git update-index --skip-worktree frontend/src/addons.generated.ts` quietens
that on a machine where an extension is installed.
