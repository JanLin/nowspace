"""Vault file indexer — scans Obsidian vault and builds name→path index.

Stores the index in memory (no database). Supports refresh on demand.
Handles duplicate names by preferring files in active areas (folders prefixed 'c').
"""

from __future__ import annotations

import os
import re
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from backend.config import config


# In-memory index: note_name (lowercase) → list of (relative_path, priority_score)
_file_index: Dict[str, List[Tuple[str, int]]] = {}
_last_refresh: Optional[datetime] = None


def _priority_score(rel_path: str) -> int:
    """Score a file path for duplicate resolution.

    Lower = preferred. Active areas (folders starting with 'c ') get priority.
    Files closer to vault root are preferred.
    """
    parts = Path(rel_path).parts
    depth = len(parts)
    score = depth * 10

    # Prefer active areas (c prefix like "c Arratech", "c iGrant")
    for part in parts:
        if part.startswith("c "):
            score -= 50
            break

    # Prefer non-archive files
    if any(part.startswith("4-") for part in parts):
        score += 100

    # Prefer areas and projects over resources
    if any(part.startswith("2-") or part.startswith("1-") for part in parts):
        score -= 20

    return score


def refresh_index() -> int:
    """Scan all .md files in the vault and rebuild the index.

    Returns the number of files indexed.
    """
    global _file_index, _last_refresh
    _file_index = {}

    vault_root = config.vault_root
    if not vault_root.exists():
        return 0

    count = 0
    for md_file in vault_root.rglob("*.md"):
        # Skip hidden folders and attachments
        rel = md_file.relative_to(vault_root)
        parts = rel.parts
        if any(p.startswith(".") or p == "_attachments" for p in parts):
            continue

        rel_str = str(rel)
        name = md_file.stem.lower()
        score = _priority_score(rel_str)

        if name not in _file_index:
            _file_index[name] = []
        _file_index[name].append((rel_str, score))
        count += 1

    # Sort each entry by priority (lower score = preferred)
    for name in _file_index:
        _file_index[name].sort(key=lambda x: x[1])

    _last_refresh = datetime.now()
    return count


def get_index() -> List[dict]:
    """Return the full index as a list of file entries."""
    if not _file_index:
        refresh_index()

    vault_root = config.vault_root
    files = []
    seen = set()

    for name, entries in _file_index.items():
        for rel_path, _ in entries:
            if rel_path in seen:
                continue
            seen.add(rel_path)

            full_path = vault_root / rel_path
            folder = str(Path(rel_path).parent)

            # Determine PARA section
            parts = Path(rel_path).parts
            section = parts[0] if parts else ""

            try:
                modified = datetime.fromtimestamp(full_path.stat().st_mtime).isoformat()
            except OSError:
                modified = ""

            files.append({
                "name": Path(rel_path).stem,
                "path": rel_path,
                "folder": folder,
                "section": section,
                "modified": modified,
            })

    return files


def resolve_name(note_name: str) -> Optional[str]:
    """Resolve a note name to its best file path (relative to vault root).

    Returns None if not found.
    """
    if not _file_index:
        refresh_index()

    key = note_name.lower().strip()
    entries = _file_index.get(key, [])
    if entries:
        return entries[0][0]  # Best match (lowest priority score)
    return None


def search(query: str, max_results: int = 20) -> List[dict]:
    """Fuzzy search for files matching query. Used for wiki link autocomplete.

    Returns list of {name, path, folder, section}.
    """
    if not _file_index:
        refresh_index()

    query_lower = query.lower().strip()
    if not query_lower:
        return []

    results: List[Tuple[int, str, str]] = []  # (match_score, name, path)
    vault_root = config.vault_root

    for name, entries in _file_index.items():
        if not entries:
            continue

        best_path = entries[0][0]

        # Exact match
        if name == query_lower:
            results.append((0, name, best_path))
        # Starts with
        elif name.startswith(query_lower):
            results.append((1, name, best_path))
        # Contains
        elif query_lower in name:
            results.append((2, name, best_path))
        # Path contains
        elif query_lower in best_path.lower():
            results.append((3, name, best_path))

    results.sort(key=lambda x: (x[0], x[1]))

    out = []
    for _, name, rel_path in results[:max_results]:
        parts = Path(rel_path).parts
        section = parts[0] if parts else ""
        out.append({
            "name": Path(rel_path).stem,
            "path": rel_path,
            "folder": str(Path(rel_path).parent),
            "section": section,
        })

    return out


def _read_vault_reference_links() -> Dict[str, str]:
    """Read reference_links from config.yaml."""
    return {k.lower(): v for k, v in config.reference_links.items()}


# Public alias for API access
read_vault_reference_links = _read_vault_reference_links


def resolve_group_to_folder(group_name: str, week_refs: Optional[Dict[str, str]] = None) -> Optional[str]:
    """Resolve a group name (e.g., 'iGrant') to a project folder path.

    Resolution order:
    1. Week header references (e.g., "igrant: [[iGrant calls]]")
    2. config.yaml reference_links
    3. Vault index search

    Returns relative path from vault root, or None.
    """
    group_lower = group_name.lower().strip()

    # 1. Week header references — resolve the wiki link to find the folder
    if week_refs:
        for key, wiki_link in week_refs.items():
            if key.lower() == group_lower:
                resolved = resolve_name(wiki_link)
                if resolved:
                    # Return the parent folder of the resolved file
                    return str(Path(resolved).parent)

    # 2. Vault configuration file reference_links
    ref_links = _read_vault_reference_links()
    ref = ref_links.get(group_lower)
    if ref:
        full_path = config.vault_root / ref
        if full_path.exists():
            return ref

    # 3. Vault index search — look for folders or PROJ files matching the name
    if not _file_index:
        refresh_index()

    # Search for "Proj - <group>" files
    for pattern in [f"proj - {group_lower}", f"proj-{group_lower}", group_lower]:
        entries = _file_index.get(pattern, [])
        if entries:
            return str(Path(entries[0][0]).parent)

    return None


def discover_linked_docs(folder_path: str) -> dict:
    """Scan a project folder for key files and subfolders.

    Returns: {
        folder_path, call_logs, project_files, subfolders
    }
    """
    vault_root = config.vault_root
    full_path = vault_root / folder_path

    if not full_path.exists() or not full_path.is_dir():
        return {
            "folder_path": folder_path,
            "call_logs": [],
            "project_files": [],
            "subfolders": [],
        }

    call_logs = []
    project_files = []
    subfolders = []

    call_re = re.compile(r"(call|log|meeting)", re.IGNORECASE)
    proj_re = re.compile(r"^(PROJ|Proj)\s*[-–]\s*", re.IGNORECASE)

    for entry in sorted(full_path.iterdir()):
        if entry.name.startswith(".") or entry.name == "_attachments":
            continue

        rel = str(entry.relative_to(vault_root))

        if entry.is_dir():
            subfolders.append({"name": entry.name, "path": rel})
        elif entry.suffix == ".md":
            name = entry.stem
            try:
                modified = datetime.fromtimestamp(entry.stat().st_mtime).isoformat()
            except OSError:
                modified = ""

            file_info = {
                "name": name,
                "path": rel,
                "folder": str(Path(rel).parent),
                "section": Path(rel).parts[0] if Path(rel).parts else "",
                "modified": modified,
            }

            if call_re.search(name):
                call_logs.append(file_info)
            elif proj_re.match(name):
                project_files.append(file_info)

    return {
        "folder_path": folder_path,
        "call_logs": call_logs,
        "project_files": project_files,
        "subfolders": subfolders,
    }
