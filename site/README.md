# nowspace.org

The public website. Plain HTML and one stylesheet — no build tool, no npm, no
framework. The only build step generates the philosophy page from the markdown
so the two cannot drift.

## Run it locally

From the **repository root**:

```bash
python3 site/build.py && cd site && python3 -m http.server 4173
```

Then open <http://localhost:4173> and stop it with Ctrl-C.

To just look at it without a server, `python3 site/build.py` and then open
`site/index.html` in a browser — every link is relative, so navigation works
over `file://` too.

> **If the Philosophy link 404s, you skipped `build.py`.** `philosophy.html` is
> generated and gitignored, so it does not exist in a fresh checkout. This is
> the one gotcha; everything else is a static file.

## What's here

```
site/
  index.html              home
  getting-started.html    vault layout, first launch, macOS quarantine, Docker
  developers.html         the agent-management angle
  download.html           per-platform release links
  privacy.html            what the site and app collect
  philosophy.html         GENERATED — do not edit, do not commit
  templates/
    philosophy.html       the shell philosophy.html is rendered into
  assets/                 style.css, screenshots, compass SVGs
  build.py                docs/philosophy.md -> philosophy.html
  CNAME                   nowspace.org
```

## Editing rules

**Never edit `site/philosophy.html`.** It is overwritten by every build and is
not tracked. The source is `docs/philosophy.md`, which CLAUDE.md already
requires to move in step with `HelpGuide.tsx` and `Philosophy.tsx` — the
website is not a fourth copy. To change the page's frame (nav, footer, page
head) edit `templates/philosophy.html`; to change the words edit the markdown.

`build.py` understands the subset of markdown that file actually uses:
headings, paragraphs, bullet lists, `**bold**` and `*italic*`. If you reach for
something richer in the markdown, teach the script first — it will not fail
loudly, it will just pass the syntax through as text.

**The header and footer are duplicated across pages.** There is no include
mechanism, so a nav or footer change means editing all five hand-written pages
*and* `templates/philosophy.html` — six files. Deliberate: the alternative was
a templating step for a six-page static site.

## Before you push

```bash
python3 site/build.py
cd site && for f in *.html; do
  grep -oE '(href|src)="[^"#:]+\.(html|css|svg|png)"' "$f" | sed -E 's/.*="([^"]+)"/\1/' | sort -u |
    while read -r t; do [ -f "$t" ] || echo "MISSING in $f -> $t"; done
done
```

Silence means every internal link and asset resolves. Also worth a look at
375px and around 800px — the nav switches to a hamburger at 820px, and wide
`<pre>` blocks inside a `.split` grid are the thing most likely to push the
page sideways.

## How it publishes

`.github/workflows/pages.yml` runs on pushes to `main` that touch `site/**` or
`docs/philosophy.md`. It runs `build.py`, drops `templates/` and `build.py`
from the artifact (so raw `{{TITLE}}` placeholders never get served), and
deploys to GitHub Pages at the domain in `CNAME`.

Website-only commits do **not** rebuild the app: `deploy/update-nowspace.sh`
skips its rebuild when the changed paths are confined to `site/`, so a typo fix
here won't restart the mini's server or rebuild every subscriber's container.

## Still to wire up

- **Umami** — `data-website-id="REPLACE_WITH_NOWSPACE_ORG_WEBSITE_ID"` in all
  six pages is a placeholder. Add the site in the Umami dashboard and paste the
  real id. Until then the script loads and records nothing.
- **Pages** — not yet enabled on the repo. The workflow fails at
  `configure-pages` until it is (Settings → Pages → source: GitHub Actions).
- **The domain** — `nowspace.org` is unregistered. Apex needs the four GitHub
  A records plus the AAAA set; `www` is a CNAME to `janlin.github.io`.

## Download links

They point at `releases/latest/download/<stable-name>` — the release workflow
uploads stable-named copies of every installer alongside the versioned ones, so
these never need updating when a release ships. Don't "fix" them to versioned
filenames; that is what made the original draft's links 404.
