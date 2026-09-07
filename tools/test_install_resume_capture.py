import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("install_capture", Path(__file__).with_name("install-resume-capture.py"))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallCaptureTests(unittest.TestCase):
    def test_preserves_existing_hooks_and_keeps_exact_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "settings.json"
            original = b'{"model":"existing", "hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"existing-hook"}]}]}}'
            path.write_bytes(original)
            self.assertEqual(installer.install(path, "claude", Path("C:/TermX/termx-host.exe")), "updated")
            updated = json.loads(path.read_text())
            self.assertEqual(updated["model"], "existing")
            self.assertEqual(updated["hooks"]["SessionStart"][0]["hooks"][0]["command"], "existing-hook")
            self.assertEqual(next(path.parent.glob("*.termx-backup-*")).read_bytes(), original)
            self.assertEqual(installer.install(path, "claude", Path("C:/TermX/termx-host.exe")), "unchanged")

    def test_dry_run_and_corrupt_settings_never_replace_original(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "hooks.json"
            self.assertEqual(installer.install(path, "codex", Path("host.exe"), True), "would update")
            self.assertFalse(path.exists())
            path.write_text("not-json")
            with self.assertRaises(ValueError):
                installer.install(path, "codex", Path("host.exe"))
            self.assertEqual(path.read_text(), "not-json")


if __name__ == "__main__":
    unittest.main()
