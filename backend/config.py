import os
from pathlib import Path
import yaml


class Config:
    def __init__(self, config_path: str = "config.yaml"):
        root = Path(__file__).resolve().parent.parent
        with open(root / config_path) as f:
            raw = yaml.safe_load(f)

        # VAULT_PATH env var takes precedence over config.yaml
        vault_env = os.environ.get("VAULT_PATH")
        if vault_env:
            self.vault_path = Path(vault_env)
        else:
            self.vault_path = Path(raw["vault_path"]).expanduser()

        self.memory_path = root / raw["memory_path"]
        self.system_prompt_path = root / raw["system_prompt_path"]

        api = raw.get("api", {})
        self.model = api.get("model", "claude-sonnet-4-6")
        self.max_tokens = api.get("max_tokens", 1024)

        server = raw.get("server", {})
        self.host = server.get("host", "0.0.0.0")
        self.port = server.get("port", 8000)
        self.cors_origins = server.get("cors_origins", ["http://localhost:5173"])

    @property
    def system_prompt(self) -> str:
        return self.system_prompt_path.read_text()


config = Config()
