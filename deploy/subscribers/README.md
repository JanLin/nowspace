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
  Tell them to use a **personal** account: a work domain is treated as
  commercial use and lands them on a 14-day trial instead of the free
  Personal plan, and their instance looks broken when it lapses.
- **They can only run one VPN at a time.** Phones allow a single active VPN
  tunnel, so a corporate VPN or WireGuard switched on alongside disconnects
  Tailscale and their instance stops loading. Profiles set to connect on
  demand do this by themselves, so it presents as intermittent. This is the
  first thing to ask about when a subscriber reports the app is down.
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

Updates are automatic: the mini's hourly update job runs
`update-subscribers.sh` whenever main moves (guarded so a Docker failure
never blocks the mini's own update — check ~/Library/Logs/nowspace-update.log).
Run `./update-subscribers.sh` manually for an immediate update.

## Honest boundaries

- Network/app access is subscriber-only. But the vault files live on this
  machine's disk: say "I can't open your Nowspace", not "I can't see your
  data".
- Resource footprint per instance: ~200 MB (app + sidecar), ~1 GB with
  Obsidian. A 64 GB mini hosts many.
- Requires: Docker running on the mini and this repo's clone (already
  present for the hourly deploy). The image is built locally with
  `build-image.sh` — no registry, nothing public; updates flow exactly
  like the mini's own: pull the repo, run `update-subscribers.sh`.
