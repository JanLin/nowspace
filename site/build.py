#!/usr/bin/env python3
"""Generate site/philosophy.html from docs/philosophy.md.

The philosophy text already lives in three places that CLAUDE.md requires to
move together (HelpGuide.tsx, Philosophy.tsx, docs/philosophy.md). The website
does not become a fourth: this renders the page from the markdown at build
time, so it cannot drift. The generated file is gitignored.

Handles the subset of markdown docs/philosophy.md actually uses -- setext-free
headings, paragraphs, bullet lists, **bold** and *italic*. Anything richer
belongs in the markdown only if this grows to understand it.

Run from the repo root:  python3 site/build.py
"""

import html
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "docs" / "philosophy.md"
TEMPLATE = ROOT / "site" / "templates" / "philosophy.html"
OUTPUT = ROOT / "site" / "philosophy.html"

INDENT = " " * 6


def inline(text):
    """Escape HTML, then apply bold/italic. Bold first -- ** would match *."""
    out = html.escape(text, quote=False)
    out = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", out)
    out = re.sub(r"(?<!\*)\*([^*]+?)\*(?!\*)", r"<em>\1</em>", out)
    return out


def blocks(lines):
    """Group the markdown into (kind, lines) blocks, unwrapping hard breaks."""
    grouped = []
    for line in lines:
        stripped = line.strip()
        if not stripped:
            grouped.append(("blank", ""))
        elif stripped.startswith("## "):
            grouped.append(("h2", stripped[3:]))
        elif stripped.startswith("# "):
            grouped.append(("h1", stripped[2:]))
        elif stripped.startswith("- "):
            grouped.append(("li", stripped[2:]))
        elif grouped and grouped[-1][0] in ("li", "p"):
            # continuation of a wrapped list item or paragraph
            kind, existing = grouped[-1]
            grouped[-1] = (kind, f"{existing} {stripped}")
        else:
            grouped.append(("p", stripped))
    return [b for b in grouped if b[0] != "blank"]


def render(grouped):
    """Turn blocks into the prose HTML, wrapping runs of list items in <ul>."""
    out = []
    in_list = False
    for kind, text in grouped:
        if kind != "li" and in_list:
            out.append(f"{INDENT}</ul>")
            in_list = False
        if kind == "li":
            if not in_list:
                out.append(f"{INDENT}<ul>")
                in_list = True
            out.append(f"{INDENT}  <li>{inline(text)}</li>")
        elif kind == "h2":
            out.append("")
            out.append(f"{INDENT}<h2>{inline(text)}</h2>")
        elif kind == "p":
            out.append(f"{INDENT}<p>{inline(text)}</p>")
    if in_list:
        out.append(f"{INDENT}</ul>")
    # drop the blank line the first heading introduces
    while out and not out[0]:
        out.pop(0)
    return "\n".join(out)


def main():
    grouped = blocks(SOURCE.read_text().splitlines())

    if not grouped or grouped[0][0] != "h1":
        sys.exit(f"{SOURCE} must start with a level-1 heading")
    title = grouped[0][1]

    # The first paragraph doubles as the page-head standfirst, so it is not
    # repeated in the body below.
    if len(grouped) < 2 or grouped[1][0] != "p":
        sys.exit(f"{SOURCE} must open with a paragraph under the title")
    intro = grouped[1][1]

    page = TEMPLATE.read_text()
    page = page.replace("{{TITLE}}", inline(title))
    page = page.replace("{{INTRO}}", inline(intro))
    page = page.replace("{{BODY}}", render(grouped[2:]))

    OUTPUT.write_text(page)
    print(f"wrote {OUTPUT.relative_to(ROOT)} from {SOURCE.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
