"""Settings API — vault path and reference links configuration."""

import os
from pathlib import Path
from typing import Dict, List, Optional

import yaml
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.config import config

router = APIRouter(prefix="/api/settings", tags=["settings"])


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

PARA_SECTIONS = ["0-Inbox", "1-Projects", "2-Areas", "3-Resources", "4-Archive"]


class VaultStatus(BaseModel):
    exists: bool
    has_para: bool
    para_folders: List[str]  # which PARA folders exist
    has_config: bool  # reference_links configured
    file_count: int


class ApiKeyStatus(BaseModel):
    configured: bool
    masked: str
    source: str


class SettingsResponse(BaseModel):
    vault_path: str
    vault_root: str
    reference_links: Dict[str, str]
    vault_status: VaultStatus
    api_key_status: ApiKeyStatus
    contexts: Dict[str, list] = {}
    context_tags: Dict[str, str] = {}
    coach_enabled: bool = True


class ContextSettingsUpdate(BaseModel):
    contexts: Dict[str, list]
    context_tags: Dict[str, str]


class VaultPathUpdate(BaseModel):
    vault_path: str
    create_structure: bool = False  # if True, create PARA folders


class ReferenceLinksUpdate(BaseModel):
    reference_links: Dict[str, str]


class ReferenceLink(BaseModel):
    name: str
    path: str


class VaultValidation(BaseModel):
    vault_path: str


class ApiKeyUpdate(BaseModel):
    api_key: str


# ---------------------------------------------------------------------------
# Helpers — .env file (API key)
# ---------------------------------------------------------------------------

def _env_file() -> Path:
    """Find the .env file: ~/.nowspace/.env or project root .env."""
    home_env = Path.home() / ".nowspace" / ".env"
    if home_env.exists():
        return home_env
    project_env = _config_file().parent / ".env"
    if project_env.exists():
        return project_env
    # Default to ~/.nowspace/.env for new installs
    return home_env


def _get_api_key_status() -> dict:
    """Check if API key is configured. Never returns the actual key."""
    # Check env var first (may be set by .env or system)
    key = os.environ.get("ANTHROPIC_API_KEY", "")
    if key:
        # Mask: show first 10 chars + ****
        masked = key[:10] + "****" if len(key) > 10 else "****"
        return {"configured": True, "masked": masked, "source": "environment"}

    # Check .env file
    env_path = _env_file()
    if env_path.exists():
        try:
            text = env_path.read_text(encoding="utf-8")
            for line in text.splitlines():
                line = line.strip()
                if line.startswith("ANTHROPIC_API_KEY=") and not line.startswith("#"):
                    val = line.split("=", 1)[1].strip().strip('"').strip("'")
                    if val:
                        masked = val[:10] + "****" if len(val) > 10 else "****"
                        return {"configured": True, "masked": masked, "source": str(env_path)}
        except Exception:
            pass

    return {"configured": False, "masked": "", "source": ""}


def _save_api_key(api_key: str) -> Path:
    """Save API key to ~/.nowspace/.env. Returns the file path."""
    env_path = Path.home() / ".nowspace" / ".env"
    env_path.parent.mkdir(parents=True, exist_ok=True)

    # Read existing .env content (preserve other vars)
    existing_lines: list[str] = []
    if env_path.exists():
        try:
            existing_lines = env_path.read_text(encoding="utf-8").splitlines()
        except Exception:
            pass

    # Replace or add ANTHROPIC_API_KEY
    found = False
    new_lines = []
    for line in existing_lines:
        if line.strip().startswith("ANTHROPIC_API_KEY="):
            new_lines.append(f"ANTHROPIC_API_KEY={api_key}")
            found = True
        else:
            new_lines.append(line)
    if not found:
        new_lines.append(f"ANTHROPIC_API_KEY={api_key}")

    env_path.write_text("\n".join(new_lines) + "\n", encoding="utf-8")

    # Also set in current process so it takes effect immediately
    os.environ["ANTHROPIC_API_KEY"] = api_key

    return env_path


# ---------------------------------------------------------------------------
# Helpers — config.yaml read/write
# ---------------------------------------------------------------------------

def _config_file() -> Path:
    return config._config_file


def _read_config_yaml() -> dict:
    with open(_config_file()) as f:
        return yaml.safe_load(f)


def _write_config_yaml(raw: dict) -> None:
    with open(_config_file(), "w") as f:
        yaml.dump(raw, f, default_flow_style=False, sort_keys=False, allow_unicode=True)


# ---------------------------------------------------------------------------
# Helpers — vault status
# ---------------------------------------------------------------------------

def _vault_status(vault_root: Path) -> VaultStatus:
    """Check vault directory status."""
    if not vault_root.is_dir():
        return VaultStatus(exists=False, has_para=False, para_folders=[], has_config=False, file_count=0)

    existing_para = [s for s in PARA_SECTIONS if (vault_root / s).is_dir()]
    has_config = len(config.reference_links) > 0

    # Quick file count (top-level md files across PARA folders)
    file_count = 0
    for section in existing_para:
        section_path = vault_root / section
        try:
            file_count += sum(1 for f in section_path.rglob("*.md") if f.is_file())
        except OSError:
            pass

    return VaultStatus(
        exists=True,
        has_para=len(existing_para) >= 3,
        para_folders=existing_para,
        has_config=has_config,
        file_count=file_count,
    )


def _create_para_structure(vault_root: Path) -> List[str]:
    """Create PARA folder structure. Returns list of created folders."""
    created = []
    for section in PARA_SECTIONS:
        section_path = vault_root / section
        if not section_path.exists():
            section_path.mkdir(parents=True, exist_ok=True)
            created.append(section)
    return created


# ---------------------------------------------------------------------------
# Helpers — reference_links (stored in Plan Week Configuration.md in the vault)
# ---------------------------------------------------------------------------


def _read_reference_links() -> Dict[str, str]:
    """Read reference_links (vault settings file, config.yaml fallback)."""
    return dict(config.reference_links)


def _write_reference_links(links: Dict[str, str]) -> None:
    """Write reference_links to the vault settings file."""
    config.save_reference_links(links)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("", response_model=SettingsResponse)
async def get_settings():
    """Return current settings with vault status."""
    key_status = _get_api_key_status()
    return SettingsResponse(
        vault_path=str(config.vault_path),
        vault_root=str(config.vault_root),
        reference_links=_read_reference_links(),
        vault_status=_vault_status(config.vault_root),
        api_key_status=ApiKeyStatus(**key_status),
        contexts=config.contexts,
        context_tags=config.context_tags,
        coach_enabled=config.coach_enabled,
    )


@router.post("/contexts")
async def save_context_settings(body: ContextSettingsUpdate):
    """Persist the context configuration edited in the Settings tab."""
    config.save_context_settings(body.contexts, body.context_tags)
    return {"status": "saved", "contexts": config.contexts, "context_tags": config.context_tags}


@router.post("/validate-vault")
async def validate_vault(body: VaultValidation):
    """Validate a vault path without saving. Returns status info."""
    raw_path = Path(body.vault_path).expanduser()

    # Smart path resolution (same logic as update_vault_path)
    if raw_path.name == "0-Inbox":
        vault_root = raw_path.parent
    elif raw_path.name != "0-Inbox" and (raw_path / "0-Inbox").is_dir():
        vault_root = raw_path
        raw_path = raw_path / "0-Inbox"
    else:
        vault_root = raw_path

    status = _vault_status(vault_root)

    return {
        "vault_path": str(raw_path),
        "vault_root": str(vault_root),
        "vault_status": status.model_dump(),
        "reference_links": _read_reference_links(),
    }


@router.put("/vault-path")
async def update_vault_path(body: VaultPathUpdate):
    """Update the vault path. Optionally creates PARA structure."""
    new_path = Path(body.vault_path).expanduser()

    # Smart path resolution:
    # If user selected the vault root (has 0-Inbox subfolder), auto-point to 0-Inbox
    if new_path.name != "0-Inbox" and (new_path / "0-Inbox").is_dir():
        vault_root = new_path
        new_path = new_path / "0-Inbox"
    elif new_path.name == "0-Inbox":
        vault_root = new_path.parent
    else:
        vault_root = new_path

    # Create PARA structure if requested
    created_folders = []
    if body.create_structure:
        vault_root.mkdir(parents=True, exist_ok=True)
        created_folders = _create_para_structure(vault_root)
        # Ensure inbox path exists
        new_path.mkdir(parents=True, exist_ok=True)
    elif not new_path.is_dir():
        raise HTTPException(status_code=400, detail=f"Directory not found: {body.vault_path}")

    # Update config.yaml
    raw = _read_config_yaml()
    raw["vault_path"] = body.vault_path
    raw["vault_root"] = str(vault_root)
    _write_config_yaml(raw)

    # Update live config
    config.vault_path = new_path
    config.vault_root = vault_root

    # Read reference links from the new vault
    ref_links = _read_reference_links()
    status = _vault_status(vault_root)

    return {
        "status": "ok",
        "vault_path": str(new_path),
        "vault_root": str(vault_root),
        "created_folders": created_folders,
        "reference_links": ref_links,
        "vault_status": status.model_dump(),
    }


@router.put("/reference-links")
async def update_reference_links(body: ReferenceLinksUpdate):
    """Update all reference links at once."""
    _write_reference_links(body.reference_links)
    return {"status": "ok", "reference_links": body.reference_links}


@router.post("/reference-links")
async def add_reference_link(body: ReferenceLink):
    """Add or update a single reference link."""
    links = _read_reference_links()
    links[body.name.lower()] = body.path
    _write_reference_links(links)
    return {"status": "ok", "reference_links": links}


@router.delete("/reference-links/{name}")
async def delete_reference_link(name: str):
    """Delete a reference link by name."""
    links = _read_reference_links()
    key = name.lower()
    if key not in links:
        raise HTTPException(status_code=404, detail=f"Reference link '{name}' not found")
    del links[key]
    _write_reference_links(links)
    return {"status": "ok", "reference_links": links}


@router.get("/vault-folders")
async def list_vault_folders(path: str = ""):
    """List subfolders in the vault (for folder picker UI)."""
    base = config.vault_root / path if path else config.vault_root
    if not base.is_dir():
        raise HTTPException(status_code=404, detail="Directory not found")

    folders = []
    for item in sorted(base.iterdir()):
        if item.is_dir() and not item.name.startswith("."):
            rel = str(item.relative_to(config.vault_root))
            folders.append({"name": item.name, "path": rel})

    return {"folders": folders, "current": path}


@router.get("/browse-folders")
async def browse_folders(path: str = ""):
    """Browse any directory on the filesystem (for vault path picker).

    If path is empty, starts at the user's home directory.
    Returns absolute paths.
    """
    if not path:
        base = Path.home()
    else:
        base = Path(path).expanduser()

    if not base.is_dir():
        raise HTTPException(status_code=404, detail="Directory not found")

    folders = []
    try:
        for item in sorted(base.iterdir()):
            if item.is_dir() and not item.name.startswith("."):
                folders.append({"name": item.name, "path": str(item)})
    except PermissionError:
        pass

    # Include parent navigation unless at filesystem root
    parent = str(base.parent)
    if parent != str(base):
        has_parent = True
    else:
        has_parent = False

    return {
        "folders": folders,
        "current": str(base),
        "parent": parent if has_parent else None,
    }


@router.get("/api-key")
async def get_api_key_status():
    """Check if API key is configured. Never returns the actual key."""
    return _get_api_key_status()


@router.put("/api-key")
async def set_api_key(body: ApiKeyUpdate):
    """Save API key to ~/.nowspace/.env. Key is validated for format only."""
    key = body.api_key.strip()
    if not key:
        raise HTTPException(status_code=400, detail="API key cannot be empty")
    if not key.startswith("sk-ant-"):
        raise HTTPException(status_code=400, detail="Invalid key format. Anthropic API keys start with sk-ant-")

    env_path = _save_api_key(key)
    status = _get_api_key_status()

    return {
        "status": "ok",
        "saved_to": str(env_path),
        "api_key_status": status,
    }
