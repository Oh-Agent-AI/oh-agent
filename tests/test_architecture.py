"""Incremental architecture gates for the modular Python CLI.

The refactor is deliberately staged.  These tests validate modules that exist
today without requiring the final module inventory or the final 40-line
compatibility wrapper before the corresponding migration phase lands.
"""

import ast
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
PACKAGE = SCRIPTS / "agent_vitals"


def _module_names():
    if not PACKAGE.is_dir():
        return []
    names = []
    for path in sorted(PACKAGE.rglob("*.py")):
        relative = path.relative_to(SCRIPTS).with_suffix("")
        parts = list(relative.parts)
        if parts[-1] == "__init__":
            parts.pop()
        if parts:
            names.append(".".join(parts))
    return sorted(set(names))


class ImportArchitectureTests(unittest.TestCase):
    def test_existing_package_modules_import_without_process_side_effects(self):
        modules = _module_names()
        if not modules:
            self.skipTest("The staged agent_vitals package has not been extracted yet")

        probe = r'''
import importlib
import json
import os
from pathlib import Path
import sys

blocked = {"os.system", "os.posix_spawn", "subprocess.Popen"}

def audit(event, args):
    if event in blocked:
        raise RuntimeError("import attempted external process: " + event)

sys.addaudithook(audit)
before = sorted(str(path.relative_to(Path.cwd())) for path in Path.cwd().rglob("*"))
for name in json.loads(sys.argv[1]):
    importlib.import_module(name)
after = sorted(str(path.relative_to(Path.cwd())) for path in Path.cwd().rglob("*"))
if after != before:
    raise RuntimeError("import mutated the isolated working directory")
print("IMPORT_OK")
'''
        with tempfile.TemporaryDirectory() as temp:
            env = os.environ.copy()
            env.update({
                "HOME": temp,
                "USERPROFILE": temp,
                "PYTHONPATH": str(SCRIPTS),
                "PYTHONDONTWRITEBYTECODE": "1",
            })
            result = subprocess.run(
                [sys.executable, "-c", probe, json.dumps(modules)],
                cwd=temp,
                env=env,
                text=True,
                capture_output=True,
                timeout=20,
            )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "IMPORT_OK\n")
        self.assertEqual(result.stderr, "")

    def test_existing_adapters_do_not_depend_on_reports_or_cli(self):
        adapters = PACKAGE / "adapters"
        if not adapters.is_dir():
            self.skipTest("Harness adapters have not been extracted yet")

        forbidden = {
            "agent_vitals.cli",
            "agent_vitals.report",
            "agent_vitals.lifecycle",
            "agent_vitals.doctor",
            "agent_vitals.explain",
            "agent_vitals.overlap",
            "agent_vitals.snapshots",
            "agent_vitals.diff",
            "agent_vitals.redact",
        }
        violations = []
        for path in sorted(adapters.glob("*.py")):
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for node in ast.walk(tree):
                imported = []
                if isinstance(node, ast.Import):
                    imported = [alias.name for alias in node.names]
                elif isinstance(node, ast.ImportFrom) and node.module:
                    imported = [node.module]
                for name in imported:
                    if any(name == item or name.startswith(item + ".") for item in forbidden):
                        violations.append("%s imports %s" % (path.name, name))
        self.assertEqual(violations, [])

    def test_small_wrapper_is_only_a_compatibility_entrypoint(self):
        """Activate the final wrapper gate only once extraction reaches it."""
        wrapper = SCRIPTS / "scan.py"
        lines = wrapper.read_text(encoding="utf-8").splitlines()
        if len(lines) > 40:
            self.skipTest("The staged migration has not reduced scan.py yet")
        source = "\n".join(lines)
        self.assertIn("agent_vitals", source)
        self.assertIn("__main__", source)
        self.assertNotIn("argparse.ArgumentParser", source)


if __name__ == "__main__":
    unittest.main()
