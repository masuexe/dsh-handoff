import importlib.util
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("handoff_install", Path(__file__).resolve().parents[1] / "install.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallTests(unittest.TestCase):
    def test_command_works_with_spaces_and_literal_shell_characters(self):
        with tempfile.TemporaryDirectory(prefix="handoff install ") as temp:
            root = Path(temp) / "checkout ' $(no-command)"
            (root / ".venv/bin").mkdir(parents=True)
            python = root / ".venv/bin/python"
            python.write_text("#!/bin/sh\nexec " + shlex.quote(sys.executable) + ' "$@"\n')
            python.chmod(0o755)
            (root / "handoff.py").write_text("import json,sys; print(json.dumps(sys.argv[1:]))")
            (root / "skill").mkdir()
            (root / "skill/SKILL.md").write_text("Skill fixture")
            command, skill = installer.install_files(root, Path(temp) / "bin", Path(temp) / "codex")
            result = subprocess.run([str(command), "message with spaces", "$(literal)"],
                                    text=True, capture_output=True, check=True)
            self.assertEqual(result.stdout.strip(), '["message with spaces", "$(literal)"]')
            self.assertEqual((skill / "SKILL.md").read_text(), "Skill fixture")

    def test_missing_environment_does_not_install_a_broken_command(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with self.assertRaisesRegex(RuntimeError, "virtual environment"):
                installer.install_files(root, root / "bin", root / "codex")
            self.assertFalse((root / "bin/dsh-handoff").exists())
