# Hosting subscriber demo instances (Mac mini)

Each subscriber gets their own isolated Nowspace running on this machine,
reachable **only from their own Tailscale network** — no host ports are
published, so not even localhost on the mini can open their app.

## How it works

- One folder per subscriber under `instances/<name>/` holding their vault,
  Tailscale state, and a generated `docker-compose.yml`.
- The `tailscale` sidecar joins the **subscriber's** tailnet via a one-time
  login link — you forward the link, they sign in with their own account
  (Google/Apple/Microsoft). No keys or passwords change hands.
- The app seeds a starter vault on first run — an instance is usable with
  zero configuration and no account inside Nowspace itself.
- `--obsidian` adds Obsidian streamed to the browser (same vault), warm in
  the background at `https://<name>-nowspace.<their-tailnet>.ts.net:8443`.
  If they sign into their own Obsidian Sync there, they get an off-machine
  copy of their vault — that is their backup and their data portability.

## Provisioning

```bash
./new-subscriber.sh alice              # app only
./new-subscriber.sh alice --obsidian   # app + Obsidian in the browser
# → forward the printed login link to alice
./subscriber-status.sh alice           # → their URLs, once she signed in
```

Removal (vault is archived, never deleted): `./remove-subscriber.sh alice`

Updates for all instances (hook into the hourly job if desired):
`./update-subscribers.sh`

## Honest boundaries

- Network/app access is subscriber-only. But the vault files live on this
  machine's disk: say "I can't open your Nowspace", not "I can't see your
  data".
- Resource footprint per instance: ~200 MB (app + sidecar), ~1 GB with
  Obsidian. A 64 GB mini hosts many.
- Requires: Docker running on the mini, and the public image
  `ghcr.io/janlin/nowspace` (published by the `docker-image.yml` workflow
  on version tags; flip the package to Public in GitHub once after the
  first publish).
