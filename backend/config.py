import os
import sys
from pathlib import Path
from typing import Dict
import yaml


def _project_root() -> Path:
    """Find the project root directory.

    In normal mode: parent of backend/ directory.
    In PyInstaller mode: directory where the executable lives,
    falling back to the user's home ~/.nowspace/ for config.
    """
    if getattr(sys, '_MEIPASS', None):
        # PyInstaller bundle — look for config next to executable first,
        # then in ~/.nowspace/
        exe_dir = Path(sys.executable).resolve().parent
        if (exe_dir / "config.yaml").exists():
            return exe_dir
        home_config = Path.home() / ".nowspace"
        if (home_config / "config.yaml").exists():
            return home_config
        # Create default config in ~/.nowspace/
        home_config.mkdir(parents=True, exist_ok=True)
        _create_default_config(home_config / "config.yaml")
        return home_config
    # Normal mode: backend/ is a subdirectory of project root
    return Path(__file__).resolve().parent.parent


def _create_default_config(path: Path) -> None:
    """Create a default config.yaml for first-run desktop app."""
    default = {
        "vault_path": str(Path.home() / "Obsidian" / "Home" / "0-Inbox"),
        "vault_root": str(Path.home() / "Obsidian" / "Home"),
        "memory_path": str(path.parent / "agent_memory.md"),
        "system_prompt_path": str(Path(__file__).resolve().parent.parent / "system_prompt.md"),
        "vault_sections": {
            "inbox": "0-Inbox",
            "projects": "1-Projects",
            "areas": "2-Areas",
            "resources": "3-Resources",
            "archive": "4-Archive",
        },
        "plan": {
            "week_file": "Plan Week.md",
            "bucket_file": "Plan Week Bucket.md",
        },
        "reference_links": {},
        "api": {"model": "claude-sonnet-4-6", "max_tokens": 4096},
        "server": {
            "host": "127.0.0.1",
            "port": 8000,
            "cors_origins": [
                "http://localhost:5173",
                "http://localhost:1420",
                "http://localhost:8000",
                "tauri://localhost",
                "https://tauri.localhost",
            ],
        },
    }
    with open(path, "w") as f:
        yaml.dump(default, f, default_flow_style=False, sort_keys=False, allow_unicode=True)


class Config:
    def __init__(self, config_path: str = "config.yaml"):
        root = _project_root()
        with open(root / config_path) as f:
            raw = yaml.safe_load(f)

        self._config_file = root / config_path

        # VAULT_PATH env var takes precedence over config.yaml
        vault_env = os.environ.get("VAULT_PATH")
        if vault_env:
            self.vault_path = Path(vault_env)
        else:
            self.vault_path = Path(raw["vault_path"]).expanduser()

        # Vault root — full vault directory (parent of PARA folders)
        vault_root_raw = raw.get("vault_root")
        if vault_root_raw:
            self.vault_root = Path(vault_root_raw).expanduser()
        elif self.vault_path.name == "0-Inbox":
            self.vault_root = self.vault_path.parent
        else:
            self.vault_root = self.vault_path

        # Vault sections — PARA folder names relative to vault_root
        self.vault_sections: Dict[str, str] = raw.get("vault_sections", {
            "inbox": "0-Inbox",
            "projects": "1-Projects",
            "areas": "2-Areas",
            "resources": "3-Resources",
            "archive": "4-Archive",
        })

        self.memory_path = Path(raw["memory_path"])
        if not self.memory_path.is_absolute():
            self.memory_path = root / raw["memory_path"]

        self.system_prompt_path = Path(raw["system_prompt_path"])
        if not self.system_prompt_path.is_absolute():
            self.system_prompt_path = root / raw["system_prompt_path"]

        # Plan Week file names (configurable)
        plan = raw.get("plan", {})
        self.plan_week_file = plan.get("week_file", "Plan Week.md")
        self.plan_week_bucket_file = plan.get("bucket_file", "Plan Week Bucket.md")
        self.plan_week_habits_file = plan.get("habits_file", "Plan Week Habits.md")
        self.plan_week_config_file = plan.get("config_file", "0-Inbox/Plan Week Configuration.md")

        # Reference links (group → vault folder path)
        self.reference_links: Dict[str, str] = raw.get("reference_links", {})

        # Contexts: map of context name → list of group prefixes (lowercase).
        # e.g. {"work": ["arratech", "wallet"], "volunteer": ["rotary"]}
        # Groups not listed anywhere default to "personal". Empty dict = feature off.
        raw_contexts = raw.get("contexts", {}) or {}
        self.contexts: Dict[str, list] = {
            str(name).lower(): [str(g).lower() for g in (groups or [])]
            for name, groups in raw_contexts.items()
        }

        # Context tags: single-letter abbreviation → context name, used in
        # task markup (@w, @f, …). Unknown letters seen in tasks are
        # auto-created (name defaults to the letter; rename in Settings).
        raw_tags = raw.get("context_tags", {}) or {}
        self.context_tags: Dict[str, str] = {
            str(k).lower(): str(v).lower() for k, v in raw_tags.items()
            if len(str(k)) == 1 and str(k).isalpha()
        }
        for abbrev, name in {"w": "work", "v": "volunteer", "p": "personal"}.items():
            self.context_tags.setdefault(abbrev, name)

        api = raw.get("api", {})
        self.model = api.get("model", "claude-sonnet-4-6")
        self.max_tokens = api.get("max_tokens", 1024)

        server = raw.get("server", {})
        self.host = server.get("host", "0.0.0.0")
        self.port = server.get("port", 8000)
        self.cors_origins = server.get("cors_origins", ["http://localhost:5173"])

        # Always include Tauri origins
        tauri_origins = ["tauri://localhost", "https://tauri.localhost"]
        for origin in tauri_origins:
            if origin not in self.cors_origins:
                self.cors_origins.append(origin)

    @property
    def system_prompt(self) -> str:
        return self.system_prompt_path.read_text()

    def save_reference_links(self, links: Dict[str, str]) -> None:
        """Persist reference_links into config.yaml."""
        self.reference_links = links
        with open(self._config_file) as f:
            raw = yaml.safe_load(f) or {}
        raw["reference_links"] = links
        with open(self._config_file, "w") as f:
            yaml.dump(raw, f, default_flow_style=False, sort_keys=False, allow_unicode=True)

    def assign_group_context(self, group: str, context: str) -> bool:
        """Assign a task group to a context (inline teaching: "wallet@w: task").

        Latest teaching wins: the group is removed from every other context list.
        Assigning to "personal" (the default) just removes explicit mappings.
        Returns True if the config changed and was persisted.
        """
        group = group.strip().lower()
        context = context.strip().lower()
        if not group:
            return False
        changed = False
        for ctx in list(self.contexts.keys()):
            if ctx != context and group in self.contexts[ctx]:
                self.contexts[ctx].remove(group)
                changed = True
        if context != "personal" and group not in self.contexts.get(context, []):
            self.contexts.setdefault(context, []).append(group)
            changed = True
        if changed:
            self._persist_contexts()
        return changed

    def ensure_context_tag(self, abbrev: str) -> bool:
        """Auto-create a context tag for an unknown single-letter abbreviation.

        The context name defaults to the letter itself; the user can rename
        it (and reassign the abbreviation) in Settings. Returns True if a new
        tag was created and persisted.
        """
        abbrev = abbrev.strip().lower()
        if len(abbrev) != 1 or not abbrev.isalpha() or abbrev in self.context_tags:
            return False
        self.context_tags[abbrev] = abbrev
        self.contexts.setdefault(abbrev, [])
        self._persist_contexts()
        return True

    def save_context_settings(self, contexts: Dict[str, list], context_tags: Dict[str, str]) -> None:
        """Replace the context configuration from the Settings tab."""
        self.contexts = {
            str(name).lower(): [str(g).lower() for g in (groups or [])]
            for name, groups in (contexts or {}).items()
        }
        self.context_tags = {
            str(k).lower(): str(v).lower() for k, v in (context_tags or {}).items()
            if len(str(k)) == 1 and str(k).isalpha()
        }
        for abbrev, name in {"w": "work", "v": "volunteer", "p": "personal"}.items():
            self.context_tags.setdefault(abbrev, name)
        self._persist_contexts()

    def _persist_contexts(self) -> None:
        with open(self._config_file) as f:
            raw = yaml.safe_load(f) or {}
        raw["contexts"] = {k: v for k, v in self.contexts.items() if v}
        raw["context_tags"] = self.context_tags
        with open(self._config_file, "w") as f:
            yaml.dump(raw, f, default_flow_style=False, sort_keys=False, allow_unicode=True)


config = Config()
