"""Standalone entry point for running the FastAPI server (used by PyInstaller)."""

import sys
import os
from pathlib import Path


def main():
    is_bundled = getattr(sys, '_MEIPASS', None)

    if is_bundled:
        # In PyInstaller mode, look for .env in ~/.nowspace/ or next to executable
        exe_dir = Path(sys.executable).resolve().parent
        home_config = Path.home() / ".nowspace"

        # Try loading .env from home config dir first, then exe dir
        for env_dir in [home_config, exe_dir]:
            env_file = env_dir / ".env"
            if env_file.exists():
                os.environ.setdefault("DOTENV_PATH", str(env_file))
                break

    import uvicorn
    from backend.main import app

    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="info")


if __name__ == "__main__":
    main()
