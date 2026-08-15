import os
import re
import sys
from pathlib import Path
from typing import Dict, Optional
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


# The folder the Plan Week files have always lived in, and the archive that
# has always received finished weeks. Defaults only: both are vault settings
# now (plan.folder / plan.archive_folder in Plan Week Configuration.md), so a
# vault can move them once and every instance sharing it follows.
DEFAULT_PLAN_FOLDER = "0-Inbox"
DEFAULT_ARCHIVE_FOLDER = "4-Archive/a0-Inbox"

# Where the settings file itself is looked for, in order, relative to the
# vault root. This is deliberately NOT a setting — a file cannot record its
# own location — but it is not per-device either: the list is the same in
# every installation, so two instances on one vault find the same file. New
# locations go FIRST; the last entry is where every existing vault has it.
SETTINGS_FILE_NAME = "Plan Week Configuration.md"
SETTINGS_SEARCH_FOLDERS = ["5-Meta/Nowspace", DEFAULT_PLAN_FOLDER]


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
            configured_path = Path(vault_env)
        else:
            configured_path = Path(raw["vault_path"]).expanduser()

        # Vault root — full vault directory (parent of PARA folders). This is
        # the one path that cannot be a vault setting: it is where the vault
        # IS, and it differs per installation (~/Obsidian/Home on a Mac,
        # /vault in a container). Everything inside the vault is settable in
        # the vault, so two instances sharing one vault agree by construction.
        vault_root_raw = raw.get("vault_root")
        if vault_root_raw:
            self.vault_root = Path(vault_root_raw).expanduser()
        elif configured_path.name == DEFAULT_PLAN_FOLDER:
            self.vault_root = configured_path.parent
        else:
            self.vault_root = configured_path

        # Where the Plan Week files live, as a folder RELATIVE to the vault
        # root — see the plan_folder property. The configured absolute path is
        # kept only as the legacy fallback: a config.yaml that predates the
        # setting still resolves to exactly the folder it always did.
        try:
            self._legacy_plan_folder = str(configured_path.relative_to(self.vault_root))
        except ValueError:
            self._legacy_plan_folder = DEFAULT_PLAN_FOLDER
        self._plan_folder_override: Optional[Path] = None

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
        self.plan_week_recurring_file = plan.get("recurring_file", "Plan Week Recurring.md")
        # An explicit config.yaml value still wins; otherwise the file is
        # discovered (see _vault_settings_path).
        self.plan_week_config_file = plan.get("config_file") or ""

        # Reference links (group → vault folder path). Shared settings like
        # this live in Plan Week Configuration.md inside the vault (synced to
        # every installation); the config.yaml value is a legacy fallback for
        # vaults that don't have the file/key yet.
        self._fallback_reference_links: Dict[str, str] = raw.get("reference_links", {})

        # Contexts: map of context name → list of group prefixes (lowercase).
        # e.g. {"work": ["arratech", "wallet"], "volunteer": ["rotary"]}
        # Groups not listed anywhere default to "personal". Empty dict = feature off.
        raw_contexts = raw.get("contexts", {}) or {}
        # Feature switch: hide the Coach tab and skip the Anthropic API key
        # requirement entirely (e.g. a self-hosted instance without a key).
        self.coach_enabled: bool = bool(raw.get("coach_enabled", True))

        # Where the desktop app asks what version the deployed server runs
        # (e.g. https://<mini>.ts.net/version.json). Empty = check disabled.
        self.update_check_url: str = str(raw.get("update_check_url") or "").strip()

        # Diary folder fallback (shared value lives in the vault settings file)
        self._fallback_diary_folder: str = str(raw.get("diary_folder") or "").strip()

        self._fallback_contexts: Dict[str, list] = {
            str(name).lower(): [str(g).lower() for g in (groups or [])]
            for name, groups in raw_contexts.items()
        }

        # Context tags: single-letter abbreviation → context name, used in
        # task markup (@w, @f, …). Unknown letters seen in tasks are
        # auto-created (name defaults to the letter; rename in Settings).
        raw_tags = raw.get("context_tags", {}) or {}
        self._fallback_context_tags: Dict[str, str] = {
            str(k).lower(): str(v).lower() for k, v in raw_tags.items()
            if len(str(k)) == 1 and str(k).isalpha()
        }

        # Cache for the parsed vault settings file (invalidated by mtime)
        self._vault_cfg_cache = None
        self._vault_cfg_mtime = None

        api = raw.get("api", {})
        self.model = api.get("model", "claude-sonnet-4-6")
        self.max_tokens = api.get("max_tokens", 1024)

        server = raw.get("server", {})
        # Binding all interfaces is the deliberate default: the container and
        # the mini both need to be reachable from off-box (Docker port map,
        # tailnet). Deployments that shouldn't be reachable set host in
        # config.yaml. Bandit flags this as B104; the choice is deliberate.
        self.host = server.get("host", "0.0.0.0")  # nosec
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

    # ------------------------------------------------------------------
    # Shared settings — stored in Plan Week Configuration.md in the vault
    # (a ```yaml block), so Syncthing carries them to every installation.
    # config.yaml values act as a read fallback for keys the file lacks;
    # every save writes the effective values to the vault file, migrating
    # legacy config.yaml state on first write.
    # ------------------------------------------------------------------

    _YAML_BLOCK_RE = re.compile(r"```ya?ml\s*\n(.*?)```", re.DOTALL)

    @property
    def _vault_settings_path(self) -> Path:
        """Where the vault's settings file is.

        An explicit config.yaml `plan.config_file` wins. Otherwise the search
        order decides: the first folder that already has the file, falling
        back to the last candidate so a fresh vault gets it where every vault
        has always had it.
        """
        if self.plan_week_config_file:
            return self.vault_root / self.plan_week_config_file
        for folder in SETTINGS_SEARCH_FOLDERS:
            candidate = self.vault_root / folder / SETTINGS_FILE_NAME
            if candidate.exists():
                return candidate
        return self.vault_root / SETTINGS_SEARCH_FOLDERS[-1] / SETTINGS_FILE_NAME

    # ------------------------------------------------------------------
    # Where the Plan Week files live. Vault settings, not device settings:
    # two instances on one vault must agree, and only the vault root can
    # differ between them.
    # ------------------------------------------------------------------

    def _plan_setting(self, key: str, default: str) -> str:
        raw = self._vault_settings().get("plan")
        if isinstance(raw, dict):
            val = raw.get(key)
            if isinstance(val, str) and val.strip():
                return val.strip().strip("/")
        return default

    @property
    def plan_folder(self) -> str:
        """Vault-relative folder holding Plan Week.md and its siblings."""
        return self._plan_setting("folder", self._legacy_plan_folder)

    @property
    def archive_folder(self) -> str:
        """Vault-relative folder that finished weeks are moved into."""
        return self._plan_setting("archive_folder", DEFAULT_ARCHIVE_FOLDER)

    @property
    def vault_path(self) -> Path:
        """Absolute path of the plan folder — vault_root + plan_folder.

        Still assignable: the tests point the whole config at a throwaway
        vault by setting this, and a caller that sets it means the folder
        itself, not a setting to be re-resolved.
        """
        if self._plan_folder_override is not None:
            return self._plan_folder_override
        return self.vault_root / self.plan_folder

    @vault_path.setter
    def vault_path(self, value) -> None:
        self._plan_folder_override = Path(value) if value is not None else None

    @property
    def archive_path(self) -> Path:
        """Absolute path of the archive folder."""
        return self.vault_root / self.archive_folder

    def _vault_settings(self) -> dict:
        """Parse the yaml block from the vault settings file (mtime-cached)."""
        path = self._vault_settings_path
        try:
            mtime = path.stat().st_mtime
        except OSError:
            return {}
        if self._vault_cfg_cache is not None and self._vault_cfg_mtime == mtime:
            return self._vault_cfg_cache
        parsed: dict = {}
        try:
            m = self._YAML_BLOCK_RE.search(path.read_text(encoding="utf-8"))
            if m:
                loaded = yaml.safe_load(m.group(1))
                if isinstance(loaded, dict):
                    parsed = loaded
        except Exception:
            return {}
        self._vault_cfg_cache = parsed
        self._vault_cfg_mtime = mtime
        return parsed

    def _save_vault_settings(self, updates: dict) -> None:
        """Merge updates into the yaml block, preserving surrounding markdown."""
        path = self._vault_settings_path
        merged = dict(self._vault_settings())
        merged.update(updates)
        block = "```yaml\n" + yaml.dump(
            merged, default_flow_style=False, sort_keys=False, allow_unicode=True
        ) + "```"
        try:
            content = path.read_text(encoding="utf-8") if path.exists() else ""
        except OSError:
            content = ""
        if self._YAML_BLOCK_RE.search(content):
            content = self._YAML_BLOCK_RE.sub(lambda _m: block, content, count=1)
        elif content:
            content = content.rstrip("\n") + "\n\n" + block + "\n"
        else:
            content = (
                "# Plan Week Configuration\n\n"
                "Shared Nowspace settings. This file syncs with the vault, so every\n"
                "installation (Mac, mini, phone) reads the same mappings.\n\n"
                + block + "\n"
            )
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        self._vault_cfg_cache = None
        self._vault_cfg_mtime = None

    @property
    def reference_links(self) -> Dict[str, str]:
        links = self._vault_settings().get("reference_links")
        if isinstance(links, dict):
            return {str(k): str(v) for k, v in links.items()}
        return dict(self._fallback_reference_links)

    @property
    def contexts(self) -> Dict[str, list]:
        raw_ctx = self._vault_settings().get("contexts")
        if isinstance(raw_ctx, dict):
            return {
                str(name).lower(): [str(g).lower() for g in (groups or [])]
                for name, groups in raw_ctx.items()
            }
        return {k: list(v) for k, v in self._fallback_contexts.items()}

    @property
    def context_tags(self) -> Dict[str, str]:
        raw_tags = self._vault_settings().get("context_tags")
        if isinstance(raw_tags, dict):
            tags = {
                str(k).lower(): str(v).lower() for k, v in raw_tags.items()
                if len(str(k)) == 1 and str(k).isalpha()
            }
        else:
            tags = dict(self._fallback_context_tags)
        for abbrev, name in {"w": "work", "v": "volunteer", "p": "personal"}.items():
            tags.setdefault(abbrev, name)
        return tags

    # ── Funnel settings (vault-shared, like the rest) ───────────
    _FUNNEL_DEFAULTS = {
        "binding_limit": 4,     # WIP limit on the Binding stage
        "evening_cutoff": "21:00",  # slate: solve items hidden after this
        "dispatch_limit": 3,    # handoff: max in-flight dispatches
        "last_review": "",      # ISO date the weekly review last completed
        "last_review_secs": 0,  # how long that review took (instrumented)
        "week_focus": "",       # the week's one-line focus, set in the review
    }

    @property
    def funnel(self) -> dict:
        merged = dict(self._FUNNEL_DEFAULTS)
        raw = self._vault_settings().get("funnel")
        if isinstance(raw, dict):
            merged.update({k: raw[k] for k in self._FUNNEL_DEFAULTS if k in raw})
        return merged

    @property
    def binding_limit(self) -> int:
        try:
            return max(1, int(self.funnel["binding_limit"]))
        except (TypeError, ValueError):
            return int(self._FUNNEL_DEFAULTS["binding_limit"])

    @property
    def dispatch_limit(self) -> int:
        try:
            return max(1, int(self.funnel["dispatch_limit"]))
        except (TypeError, ValueError):
            return int(self._FUNNEL_DEFAULTS["dispatch_limit"])

    def save_funnel(self, updates: dict) -> None:
        merged = dict(self.funnel)
        merged.update({k: v for k, v in (updates or {}).items()
                       if k in self._FUNNEL_DEFAULTS})
        self._save_vault_settings({"funnel": merged})

    # ── How much of Nowspace is switched on ──────────────────────
    # Basic is plain GTD: groups, priorities, horizons, weekdays. Advanced
    # adds the funnel — stages, shaping, sizes, the review and the Slate.
    # Vault-shared on purpose: it describes how you work, not which screen
    # you are on, and the backend needs it to know whether the ready gate
    # applies. Default advanced, so nobody already using the funnel loses
    # it on upgrade.
    _APP_DEFAULTS = {
        "mode": "advanced",     # "basic" | "advanced"
        "funnel": None,         # None = on, for anyone already using it
        "handoff": None,        # None = decide from whether areas are set up
    }

    @property
    def app_mode(self) -> str:
        raw = self._vault_settings().get("app")
        mode = (raw or {}).get("mode") if isinstance(raw, dict) else None
        return "basic" if str(mode).lower() == "basic" else "advanced"

    @property
    def funnel_enabled(self) -> bool:
        """Stages, sizes, shaping, review, Slate — the whole funnel.

        An option inside Advanced rather than what Advanced means: someone
        can want the extra switches without wanting the funnel. Basic hides
        it either way. Unset counts as on, so nobody already using the
        funnel loses it on upgrade.
        """
        if self.app_mode != "advanced":
            return False
        raw = self._vault_settings().get("app")
        val = (raw or {}).get("funnel") if isinstance(raw, dict) else None
        return True if val is None else bool(val)

    @property
    def handoff_enabled(self) -> bool:
        if self.app_mode != "advanced":
            return False
        raw = self._vault_settings().get("app")
        val = (raw or {}).get("handoff") if isinstance(raw, dict) else None
        if val is None:
            # Never chosen: on only if agent areas already exist, so an
            # existing setup keeps working and a new one stays quiet
            areas = self._vault_settings().get("areas")
            return bool(areas) if isinstance(areas, list) else False
        return bool(val)

    # Every top-level key the baseline itself owns. Anything else in the
    # settings file belongs to an extension, and is passed through to clients
    # untouched so a surface can read its own `<addon-id>.enabled` switch.
    _BASELINE_SETTINGS_KEYS = {
        "app", "areas", "bucket_schema", "context_tags", "contexts",
        "diary_folder", "funnel", "notes", "reference_links",
    }

    @property
    def addon_settings(self) -> dict:
        """The extension namespaces, as stored. Read-only from the baseline's
        side: it never interprets what is in them, and never writes them —
        an extension owns its own key through its own route."""
        return {
            k: v for k, v in self._vault_settings().items()
            if k not in self._BASELINE_SETTINGS_KEYS
        }

    @property
    def app_settings(self) -> dict:
        """The `app:` map as clients should see it: the three resolved
        switches, plus any boolean key a newer instance has stored. One shape
        for the GET and the POST reply, so a switch this backend doesn't know
        still comes back to the client that set it."""
        raw = self._vault_settings().get("app")
        stored = raw if isinstance(raw, dict) else {}
        out = {
            "mode": self.app_mode,
            "funnel": self.funnel_enabled,
            "handoff": self.handoff_enabled,
        }
        for k, v in stored.items():
            if k not in out and isinstance(v, bool):
                out[k] = v
        return out

    def save_app_settings(self, updates: dict) -> None:
        """Merge into the `app:` map, keeping keys this backend doesn't know.

        The filter used to drop anything outside _APP_DEFAULTS, which means an
        instance one release behind silently deleted a newer instance's switch
        and synced the deletion to every device — the same class of loss that
        `extra="forbid"` guards against on bucket writes.

        Unknown keys are accepted only as booleans: a switch is all anything
        outside this module should be storing here, and it keeps a mistyped
        key from parking arbitrary structure in a shared file. An extension's
        own settings do not belong here at all — they go under a top-level
        key of their own (`docs/EXTENSIONS.md`).
        """
        raw = self._vault_settings().get("app")
        merged = dict(raw) if isinstance(raw, dict) else {}
        for k, v in (updates or {}).items():
            if k in self._APP_DEFAULTS:
                merged[k] = v
            elif isinstance(v, bool):
                merged[k] = v
        self._save_vault_settings({"app": merged})

    # ── Notes tabs (vault-shared: the open set follows you between
    # installations, like every other setting here) ──────────────
    _NOTES_DEFAULTS = {
        "max_open": 5,   # tabs kept before the oldest unpinned one is closed
        "tabs": [],      # [{path, name, pinned}] in strip order
    }

    @property
    def notes(self) -> dict:
        merged = dict(self._NOTES_DEFAULTS)
        raw = self._vault_settings().get("notes")
        if isinstance(raw, dict):
            merged.update({k: raw[k] for k in self._NOTES_DEFAULTS if k in raw})
        # Never hand back a malformed strip: one bad entry shouldn't cost the
        # whole set, and a stale hand-edit of the settings file is fair game
        tabs = []
        for entry in merged.get("tabs") or []:
            if not isinstance(entry, dict):
                continue
            path = str(entry.get("path") or "").strip()
            if not path:
                continue
            tabs.append({
                "path": path,
                "name": str(entry.get("name") or "").strip() or path.rsplit("/", 1)[-1],
                "pinned": bool(entry.get("pinned")),
            })
        merged["tabs"] = tabs
        try:
            merged["max_open"] = max(1, min(20, int(merged["max_open"])))
        except (TypeError, ValueError):
            merged["max_open"] = int(self._NOTES_DEFAULTS["max_open"])
        return merged

    def save_notes(self, updates: dict) -> None:
        merged = dict(self.notes)
        merged.update({k: v for k, v in (updates or {}).items()
                       if k in self._NOTES_DEFAULTS})
        self._save_vault_settings({"notes": merged})

    # ── Bucket format marker (travels WITH the vault via Syncthing) ──
    # The API-level schema guard can't reach an isolated matched pair like
    # the desktop app (its UI and bundled backend always agree with each
    # other). This marker rides the synced settings file, so any instance —
    # however isolated — can see from the data itself that the vault is
    # written in a newer format than it understands, and refuse to edit.

    @property
    def bucket_schema_marker(self) -> int:
        val = self._vault_settings().get("bucket_schema")
        try:
            return int(val)
        except (TypeError, ValueError):
            return 0  # pre-marker vault

    def stamp_bucket_schema(self, version: int) -> None:
        if self.bucket_schema_marker != version:
            self._save_vault_settings({"bucket_schema": int(version)})

    @property
    def diary_folder(self) -> str:
        """Vault folder for daily diary files (<date> diary.md). Empty = off."""
        val = self._vault_settings().get("diary_folder")
        if isinstance(val, str):
            return val.strip()
        return self._fallback_diary_folder

    def save_diary_folder(self, folder: str) -> None:
        self._save_vault_settings({"diary_folder": folder.strip()})

    def save_reference_links(self, links: Dict[str, str]) -> None:
        """Persist reference_links into the vault settings file."""
        self._save_vault_settings({"reference_links": links})

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
        contexts = {k: list(v) for k, v in self.contexts.items()}
        changed = False
        for ctx in list(contexts.keys()):
            if ctx != context and group in contexts[ctx]:
                contexts[ctx].remove(group)
                changed = True
        if context != "personal" and group not in contexts.get(context, []):
            contexts.setdefault(context, []).append(group)
            changed = True
        if changed:
            self._persist_contexts(contexts, self.context_tags)
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
        tags = dict(self.context_tags)
        tags[abbrev] = abbrev
        contexts = {k: list(v) for k, v in self.contexts.items()}
        contexts.setdefault(abbrev, [])
        self._persist_contexts(contexts, tags)
        return True

    def save_context_settings(self, contexts: Dict[str, list], context_tags: Dict[str, str]) -> None:
        """Replace the context configuration from the Settings tab."""
        contexts_norm = {
            str(name).lower(): [str(g).lower() for g in (groups or [])]
            for name, groups in (contexts or {}).items()
        }
        tags = {
            str(k).lower(): str(v).lower() for k, v in (context_tags or {}).items()
            if len(str(k)) == 1 and str(k).isalpha()
        }
        for abbrev, name in {"w": "work", "v": "volunteer", "p": "personal"}.items():
            tags.setdefault(abbrev, name)
        self._persist_contexts(contexts_norm, tags)

    def _persist_contexts(self, contexts: Dict[str, list], tags: Dict[str, str]) -> None:
        self._save_vault_settings({
            "contexts": {k: v for k, v in contexts.items() if v},
            "context_tags": tags,
        })


config = Config()
