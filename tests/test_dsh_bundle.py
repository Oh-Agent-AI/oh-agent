"""DSH-1 bundle gates: the dsh/ profile bundle must stay thin and honest.

These tests pin the three hard constraints from ENGINEERING §6.6.1 (npm-prebuilt
only, no scanner copy, no build step) plus the sync rules the bundle would
otherwise drift on silently: the DSH-facing SKILL.md must keep the root skill's
name and description, and both bodies must list dsh as a supported harness.
"""

import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
DSH = ROOT / "integrations" / "dsh"

FRONTMATTER_RE = re.compile(r"^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$")


def _frontmatter(path):
    text = (ROOT / path).read_text(encoding="utf-8")
    match = FRONTMATTER_RE.match(text)
    assert match, "%s must start with YAML frontmatter" % path
    fields = {}
    for line in match.group(1).splitlines():
        colon = line.find(":")
        if colon > 0:
            fields[line[:colon].strip()] = line[colon + 1:].strip()
    return fields, match.group(2)


class DshBundleTests(unittest.TestCase):
    def test_package_declares_bundle_patch_without_build_or_deps(self):
        manifest = json.loads((DSH / "package.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["name"], "dsh-agent-vitals")
        self.assertEqual(manifest["dsh"]["bundle"]["patch"], "./cordis.patch.yml")
        self.assertEqual(manifest["type"], "module")
        # 三条硬约束的第一条：只发预构建。没有任何 scripts（含 prepare），
        # 也没有任何依赖 —— 安装期不执行任何代码，用户零授权。
        self.assertNotIn("scripts", manifest)
        self.assertNotIn("prepare", manifest)
        self.assertNotIn("dependencies", manifest)
        self.assertNotIn("devDependencies", manifest)
        self.assertNotIn("peerDependencies", manifest)
        # 第三条：不做构建步骤，纯 JS 直接发布。
        self.assertEqual(manifest["main"], "index.js")
        # files 精确列出运行时产物，绝不把扫描器或仓库其它文件带进去。
        self.assertEqual(
            sorted(manifest["files"]),
            sorted(["index.js", "cordis.patch.yml", "SKILL.md", "README.md"]),
        )

    def test_patch_is_exactly_one_insert_row_mounting_the_glue_plugin(self):
        patch = (DSH / "cordis.patch.yml").read_text(encoding="utf-8")
        # 一个 insert、一个 row：bundle 的价值就是挂载 index.js，别无其它。
        self.assertEqual(patch.count("- insert:"), 1)
        self.assertEqual(patch.count("- id:"), 1)
        self.assertIn("id: agent-vitals", patch)
        self.assertIn("name: dsh-agent-vitals", patch)

    def test_glue_plugin_registers_a_provider_and_ships_no_scanner(self):
        source = (DSH / "index.js").read_text(encoding="utf-8")
        self.assertIn("registerProvider", source)
        self.assertIn("resourceBase", source)
        self.assertIn("export function apply", source)
        # 三条硬约束的第二条：不得有扫描器副本。这里是静态否决 —— 任何
        # 把扫描器代码粘进来的写法都会命中这些标记。
        for marker in ("scan_skill_dir", "agent_vitals.cli", "def collect", "argparse"):
            self.assertNotIn(marker, source)

    def test_dsh_skill_md_keeps_root_name_and_description(self):
        root_fm, _ = _frontmatter("SKILL.md")
        dsh_fm, _ = _frontmatter("integrations/dsh/SKILL.md")
        # 名字与描述是路由表面。两份 SKILL.md 一旦漂移，DSH 的目录就会与前
        # 五个执行环境给出不同的路由语义，而且只在装上去之后才被发现。
        self.assertEqual(dsh_fm["name"], root_fm["name"])
        self.assertEqual(dsh_fm["description"], root_fm["description"])

    def test_both_bodies_list_dsh_as_a_supported_harness(self):
        # DSH-2 落地后 dsh 是可体检执行环境。两份 SKILL.md 都必须把 dsh 列为受支持
        # 执行环境（而非「暂不支持」），否则 agent 会在该扫描 DSH 的时候漏掉它。
        for path in ("SKILL.md", "integrations/dsh/SKILL.md"):
            _, body = _frontmatter(path)
            self.assertIn("`dsh`", body, path)
            self.assertNotIn("not yet a health-checked harness", body, path)

    def test_package_version_tracks_the_python_cli(self):
        manifest = json.loads((DSH / "package.json").read_text(encoding="utf-8"))
        init = (ROOT / "packages" / "agent-vitals-python" / "agent_vitals" / "__init__.py").read_text(encoding="utf-8")
        match = re.search(r'^__version__ = "([^"]+)"', init, re.M)
        self.assertIsNotNone(match, "__init__.py 必须定义 __version__")
        self.assertEqual(manifest["version"], match.group(1))

    def test_npm_pack_contains_only_bundle_files(self):
        npm = shutil.which("npm")
        if npm is None:
            self.skipTest("npm is not available on this machine")
        with tempfile.TemporaryDirectory() as temp:
            # 隔离 npm 的 cache 与日志目录，避免在受限环境往 home 写。
            env = os.environ.copy()
            env["npm_config_cache"] = str(Path(temp) / "cache")
            env["npm_config_logs_dir"] = str(Path(temp) / "logs")
            result = subprocess.run(
                [npm, "pack", "--dry-run", "--json"],
                cwd=DSH,
                env=env,
                text=True,
                capture_output=True,
                timeout=60,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            packed = json.loads(result.stdout)
            files = {entry["path"] for entry in packed[0]["files"]}
            # 第二条硬约束的落点：发布出去的 tarball 只有这五个文件，
            # 绝不含扫描器副本、node_modules 或仓库其它内容。
            self.assertEqual(
                files,
                {"README.md", "SKILL.md", "cordis.patch.yml", "index.js", "package.json"},
            )

    def test_glue_plugin_loads_as_an_esm_module(self):
        node = shutil.which("node")
        if node is None:
            self.skipTest("node is not available on this machine")
        # 只 import、不 apply —— 验证模块可加载且导出 Cordis 插件契约
        # （name / inject / apply），无需真的拉起整个 DSH。
        probe = (
            "const m = await import(" + json.dumps((DSH / "index.js").as_uri()) + ");"
            "if (m.name !== 'agent-vitals') throw new Error('bad name: ' + m.name);"
            "if (m.inject[0] !== 'skills') throw new Error('bad inject');"
            "if (typeof m.apply !== 'function') throw new Error('apply not a function');"
            "console.log('DSH_BUNDLE_OK');"
        )
        result = subprocess.run(
            [node, "--input-type=module", "-e", probe],
            cwd=ROOT,
            text=True,
            capture_output=True,
            timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "DSH_BUNDLE_OK")


if __name__ == "__main__":
    unittest.main()
