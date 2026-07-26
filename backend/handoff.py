"""Handoff (agent dispatch) — areas, dispatch records, the conformance check.

Nowspace does not implement access control: isolation is enforced outside the
app (one agent process per area, one read-only mount). What lives here is the
*handoff*: assembling what an agent is asked to do, checking that everything
named stays inside one area, and tracking what is in flight.

Two invariants shape this module (see the handoff brief):
- Nowspace never reads note content on an agent's behalf and never passes
  content to an agent — dispatch records carry *paths*. The conformance
  check reads bodies server-side only to resolve links/embeds; nothing it
  reads is ever returned to a record or an agent.
- A conformance failure makes dispatch unavailable. No override.
"""

from __future__ import annotations

import re
import secrets
from datetime import date, datetime
from pathlib import Path
from typing import Optional

import yaml

from backend.config import config
from backend import vault_index

WIKI_LINK_RE = re.compile(r"(?<!\!)\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]")
EMBED_RE = re.compile(r"!\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]")
MD_LINK_RE = re.compile(r"(?<!\!)\[[^\]]*\]\(([^)]+)\)")
# Dataview and inline queries cannot be statically resolved → fail outright
DATAVIEW_RE = re.compile(r"```dataview|`\$=|\bdv\.", re.IGNORECASE)
FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---", re.DOTALL)

EXPECTED_ARTIFACTS = ("diagnosis", "patch", "options", "critique", "draft")
DISPATCH_STATES = ("drafting", "in_flight", "returned", "closed")

DISPATCH_DIR = "_dispatch"


# ── Areas ───────────────────────────────────────────────────────

def configured_areas() -> list[dict]:
    """Areas from the vault settings file. `root` is required; the paths the
    agent writes to must sit under it (they inherit its boundary)."""
    raw = config._vault_settings().get("areas")
    areas: list[dict] = []
    if not isinstance(raw, list):
        return areas
    for a in raw:
        if not isinstance(a, dict) or not a.get("root") or not a.get("name"):
            continue
        root = str(a["root"]).strip("/")
        entry = {
            "name": str(a["name"]).strip().lower(),
            "root": root,
            "agent_binding": str(a.get("agent_binding") or "").strip(),
            "proposals_path": str(a.get("proposals_path") or f"{root}/_agent/proposals").strip("/"),
            "transcripts_path": str(a.get("transcripts_path") or f"{root}/_agent/transcripts").strip("/"),
        }
        # proposals/transcripts must be under root — silently fixing them
        # would hide a misconfiguration, so mark the area invalid instead
        entry["valid"] = (
            _is_within(config.vault_root / entry["proposals_path"], config.vault_root / root)
            and _is_within(config.vault_root / entry["transcripts_path"], config.vault_root / root)
        )
        areas.append(entry)
    return areas


def save_areas(areas: list[dict]) -> None:
    cleaned = []
    for a in areas or []:
        if not a.get("name") or not a.get("root"):
            continue
        cleaned.append({
            "name": str(a["name"]).strip().lower(),
            "root": str(a["root"]).strip("/"),
            "agent_binding": str(a.get("agent_binding") or "").strip(),
            "proposals_path": str(a.get("proposals_path") or "").strip("/"),
            "transcripts_path": str(a.get("transcripts_path") or "").strip("/"),
        })
    config._save_vault_settings({"areas": cleaned})


def area_by_name(name: str) -> Optional[dict]:
    for a in configured_areas():
        if a["name"] == (name or "").strip().lower():
            return a
    return None


def area_for_group(group: str) -> Optional[dict]:
    """Derive an item's area from its group → folder mapping. The area is
    the configured area whose root contains the group's folder."""
    if not group:
        return None
    folder = vault_index.resolve_group_to_folder(group)
    if not folder:
        return None
    folder_path = (config.vault_root / folder).resolve()
    for a in configured_areas():
        root = (config.vault_root / a["root"]).resolve()
        if _is_within(folder_path, root):
            return a
    return None


# ── Path containment (the security-relevant primitives) ─────────

def _is_within(path: Path, root: Path) -> bool:
    """Segment-safe containment on canonical real paths (symlinks followed).
    /vault/Customer-A-old must not match root /vault/Customer-A — hence
    relative_to on resolved paths, never a string prefix."""
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


# ── The conformance check ───────────────────────────────────────

def check_conformance(area: dict, source_text: str, attached_notes: list[str]) -> tuple[bool, list[str]]:
    """Pass, or fail with every offending path and reason (never just the
    first — the user needs the full extent before deciding to split a note).

    - every path is canonicalised (symlinks followed) and must sit inside
      the area root, by path-segment comparison;
    - embeds (![[...]]) are resolved transitively — an embed chain that
      leaves the area exports content out of it;
    - links ([[...]], markdown links, frontmatter note references) are
      resolved at depth 1 — link text alone leaks a title;
    - Dataview-style queries cannot be statically resolved → outright fail.
    """
    failures: list[str] = []
    root = (config.vault_root / area["root"]).resolve()

    to_scan: list[tuple[Path, str]] = []  # (path, why it's included)

    def _resolve_name(name: str, why: str) -> Optional[Path]:
        rel = vault_index.resolve_name(name.strip())
        if rel is None:
            failures.append(f"{why}: link “{name.strip()}” cannot be resolved — unresolvable references fail the check")
            return None
        return config.vault_root / rel

    # Wiki links typed on the source item itself count as attachments
    for m in WIKI_LINK_RE.finditer(source_text or ""):
        p = _resolve_name(m.group(1), "source item")
        if p is not None:
            to_scan.append((p, "source item link"))

    for rel in attached_notes or []:
        to_scan.append((config.vault_root / rel, "attached note"))

    seen: set[Path] = set()

    def _check_path(p: Path, why: str) -> Optional[Path]:
        """Containment check; returns the canonical path if it may be read."""
        canonical = p.resolve()
        if not canonical.exists():
            failures.append(f"{why}: {p} does not exist")
            return None
        if not _is_within(canonical, root):
            failures.append(f"{why}: {_display(p)} resolves outside the area root ({area['root']})")
            return None
        return canonical

    def _scan_body(canonical: Path) -> None:
        """Scan a note body for references. Embeds recurse (they inline
        content); links are checked for containment but not recursed."""
        try:
            body = canonical.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            failures.append(f"{_display(canonical)}: unreadable — cannot verify")
            return
        if DATAVIEW_RE.search(body):
            failures.append(
                f"{_display(canonical)}: contains a Dataview-style query — query results "
                "cannot be statically resolved, so the note fails the check"
            )
        # Frontmatter references (fields naming notes)
        fm = FRONTMATTER_RE.match(body)
        if fm:
            for m in re.finditer(r"\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]", fm.group(1)):
                p = _resolve_name(m.group(1), f"{_display(canonical)} frontmatter")
                if p is not None:
                    _check_path(p, f"{_display(canonical)} frontmatter reference")
        # Embeds — transitive
        for m in EMBED_RE.finditer(body):
            p = _resolve_name(m.group(1), _display(canonical))
            if p is None:
                continue
            c = _check_path(p, f"{_display(canonical)} embeds")
            if c is not None and c not in seen:
                seen.add(c)
                _scan_body(c)  # embeds keep recursing
        # Links — depth 1 (checked, not recursed)
        for m in WIKI_LINK_RE.finditer(body):
            p = _resolve_name(m.group(1), _display(canonical))
            if p is not None:
                _check_path(p, f"{_display(canonical)} links to")
        for m in MD_LINK_RE.finditer(body):
            target = m.group(1).strip()
            if target.startswith(("http://", "https://", "mailto:")):
                continue  # external URLs leave no vault content; egress is the agent sandbox's job
            _check_path((canonical.parent / target), f"{_display(canonical)} links to")

    for p, why in to_scan:
        canonical = _check_path(p, why)
        if canonical is not None and canonical not in seen:
            seen.add(canonical)
            _scan_body(canonical)

    return (len(failures) == 0, failures)


def _display(p: Path) -> str:
    try:
        return str(p.resolve().relative_to(config.vault_root.resolve()))
    except ValueError:
        return str(p)


# ── Dispatch records (files inside the area) ────────────────────

def _dispatch_dir(area: dict) -> Path:
    return config.vault_root / area["root"] / DISPATCH_DIR


def new_dispatch_id() -> str:
    return f"d{date.today().strftime('%y%m%d')}-{secrets.token_hex(3)}"


def dispatch_path(area: dict, dispatch_id: str) -> Path:
    return _dispatch_dir(area) / f"{dispatch_id}.md"


def write_dispatch(area: dict, record: dict) -> None:
    """A dispatch record is a markdown file with frontmatter, stored inside
    the area so it inherits the same boundary as everything else."""
    path = dispatch_path(area, record["id"])
    path.parent.mkdir(parents=True, exist_ok=True)
    fm = yaml.dump(record, default_flow_style=False, sort_keys=False, allow_unicode=True)
    body = (
        f"---\n{fm}---\n\n"
        f"# Dispatch {record['id']}\n\n"
        f"Source: {record.get('source_label', '')}\n"
        f"Expecting: {record.get('expected_artifact', '')}\n"
    )
    path.write_text(body, encoding="utf-8")


def read_dispatch(path: Path) -> Optional[dict]:
    try:
        m = FRONTMATTER_RE.match(path.read_text(encoding="utf-8"))
        if not m:
            return None
        rec = yaml.safe_load(m.group(1))
        return rec if isinstance(rec, dict) else None
    except (OSError, yaml.YAMLError, UnicodeDecodeError):
        return None


def list_dispatches(area: dict) -> list[dict]:
    d = _dispatch_dir(area)
    if not d.is_dir():
        return []
    records = []
    for p in sorted(d.glob("*.md")):
        if ".sync-conflict-" in p.name:
            continue
        rec = read_dispatch(p)
        if rec and rec.get("id"):
            rec["area"] = area["name"]
            records.append(rec)
    return records


# ── Return path (proposals folder) ──────────────────────────────

PROCESSED_DIR = "_processed"


def list_returns(area: dict) -> list[dict]:
    """New files in proposalsPath surface in the Returned lane. Tolerates a
    synced vault: skips conflict files and very fresh files (partial writes)."""
    folder = config.vault_root / area["proposals_path"]
    if not folder.is_dir():
        return []
    out = []
    now = datetime.now().timestamp()
    for p in sorted(folder.iterdir()):
        if not p.is_file() or p.name.startswith("."):
            continue
        if ".sync-conflict-" in p.name:
            continue
        try:
            st = p.stat()
        except OSError:
            continue
        if now - st.st_mtime < 2:
            continue  # possibly mid-write (Syncthing)
        out.append({
            "name": p.name,
            "path": str(p.relative_to(config.vault_root)),
            "modified": datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds"),
            "dispatch_id": _dispatch_id_from_name(p.name),
        })
    return out


def _dispatch_id_from_name(name: str) -> str:
    m = re.search(r"\bd\d{6}-[0-9a-f]{6}\b", name)
    return m.group(0) if m else ""


def archive_return(area: dict, rel_path: str) -> None:
    """Clearing a return moves the file into _processed (never deletes)."""
    src = (config.vault_root / rel_path).resolve()
    proposals = (config.vault_root / area["proposals_path"]).resolve()
    if not _is_within(src, proposals):
        raise ValueError("Return file is not inside the area's proposals folder")
    dest_dir = proposals / PROCESSED_DIR
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / src.name
    i = 1
    while dest.exists():
        dest = dest_dir / f"{src.stem}-{i}{src.suffix}"
        i += 1
    src.rename(dest)
