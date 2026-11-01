#!/usr/bin/env python3
"""Install the local command and the Codex skill from this checkout."""
import argparse
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys


def install_files(root, bin_dir, codex_home):
    python = root / ".venv/bin/python"
    if not python.is_file():
        raise RuntimeError("The project virtual environment is absent. Install the dependencies first.")
    bin_dir.mkdir(parents=True, exist_ok=True)
    command = bin_dir / "dsh-handoff"
    command.write_text("#!/bin/sh\nexec " + shlex.quote(str(python)) + " "
                       + shlex.quote(str(root / "handoff.py")) + ' "$@"\n')
    command.chmod(0o755)
    skill_dir = codex_home / "skills/dsh-handoff"
    skill_dir.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(root / "skill/SKILL.md", skill_dir / "SKILL.md")
    return command, skill_dir


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bin-dir", type=Path, default=Path.home() / ".local/bin")
    parser.add_argument("--codex-home", type=Path,
                        default=Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))))
    parser.add_argument("--skip-deps", action="store_true", help="Use the existing project virtual environment.")
    args = parser.parse_args()
    if sys.version_info < (3, 10) or os.name != "posix":
        raise SystemExit("Use Python 3.10 or later on Linux or WSL.")
    root = Path(__file__).resolve().parent
    python = root / ".venv/bin/python"
    if not args.skip_deps:
        uv = shutil.which("uv")
        if not python.exists():
            subprocess.run([uv, "venv", str(root / ".venv")] if uv else
                           [sys.executable, "-m", "venv", str(root / ".venv")], check=True)
        if uv:
            subprocess.run([uv, "pip", "install", "--python", str(python), "-r", str(root / "requirements.txt")], check=True)
        else:
            subprocess.run([str(python), "-m", "ensurepip"], check=True)
            subprocess.run([str(python), "-m", "pip", "install", "-r", str(root / "requirements.txt")], check=True)
    subprocess.run([str(python), "-c", "import yaml; from websockets.sync.client import unix_connect"], check=True)
    command, skill_dir = install_files(root, args.bin_dir.expanduser().resolve(), args.codex_home.expanduser().resolve())
    print(f"Command: {command}\nSkill: {skill_dir}\nKeep this checkout at its current path.")


if __name__ == "__main__":
    main()
