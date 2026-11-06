#!/usr/bin/env python3
"""文件系统层面的敌意输入（ENGINEERING §4.5）。

    扫描路径上不得出现 unwrap() / expect() / 可能越界的索引。
    单个 skill 的任何失败降级为该 skill 的一条诊断，不影响其余。

`test_degradation.py` 测的是**文件内容**畸形（截断 frontmatter、非 UTF-8
字节、空文件）。这里测的是**文件系统本身**畸形：目录成环、路径名不是合法
UTF-8、规模极大。后者是 Rust 比 Python 更容易出事的地方 —— Python 在这些
路径上到处是隐式的宽容，Rust 必须显式买回来。

对两个实现同样有效（SCAN_CMD），因此也是差分测试。
"""

import json
import os
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from tests.env_helpers import isolated_home_env

ROOT = Path(__file__).resolve().parent.parent
SCAN = ROOT / "scripts" / "scan.py"
_BIN = os.environ.get("AGENT_VITALS_BIN")
# 与 golden_runner.py / test_cli_matrix.py 同款：解析成绝对路径。差分用例以
# tmp/workdir 为 cwd 跑子进程，相对路径在这里会 FileNotFoundError（CI 传绝对
# 路径所以没暴露；本机按 CLAUDE.md 的 `AGENT_VITALS_BIN=target/release/...`
# 跑就炸）。
if _BIN:
    _BIN = str(Path(_BIN).resolve())
SCAN_CMD = [_BIN] if _BIN else [sys.executable, str(SCAN)]

# 敌意输入的用例必须有超时：**挂死比报错糟糕得多**。
# 扫描器卡住时用户看不到任何输出，也不知道该不该等下去。
TIMEOUT = 60


def write_skill(base: Path, name: str, body="body\n"):
    d = base / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(
        "---\nname: %s\ndescription: d\n---\n\n%s" % (name, body), encoding="utf-8")
    return d


class HostileCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.skills = self.tmp / ".claude" / "skills"
        self.skills.mkdir(parents=True, exist_ok=True)
        (self.tmp / "workdir").mkdir(parents=True, exist_ok=True)
        (self.tmp / ".claude.json").write_text(
            '{"enabledPlugins":{},"skillUsage":{}}', encoding="utf-8")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def scan(self, *extra):
        out = self.tmp / "out.json"
        env = isolated_home_env(self.tmp)
        for k in ("CODEX_RUNTIME", "OPENCLAW_RUNTIME", "WORKBUDDY_BUILTINS"):
            env["AGENT_VITALS_DISABLE_" + k] = "1"
        started = time.time()
        try:
            r = subprocess.run(SCAN_CMD + ["--harness", "claude-code", "--json", str(out)]
                               + list(extra),
                               cwd=str(self.tmp / "workdir"), env=env,
                               capture_output=True, text=True, timeout=TIMEOUT)
        except subprocess.TimeoutExpired:
            self.fail("扫描挂死超过 %ds —— 挂死比报错糟糕得多" % TIMEOUT)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(out.read_text(encoding="utf-8")), time.time() - started


class TestSymlinkLoopDoesNotHang(HostileCase):
    """目录符号链接成环时不得无限递归。

    两个实现免疫的理由是**同一个**：Python 的 `rglob` 用 `**` 语义，明确
    不跟随目录符号链接；`walkdir` 默认同样不跟随。这条测试的价值在于把
    那个「碰巧一致」钉成「必须一致」—— 任何一侧改成跟随，这里立刻会挂。
    """

    def setUp(self):
        super().setUp()
        probe_target = self.tmp / "symlink-target"
        probe_link = self.tmp / "symlink-probe"
        probe_target.mkdir()
        try:
            os.symlink(probe_target, probe_link)
            probe_link.unlink()
        except OSError as exc:
            self.skipTest("symlinks unavailable in this environment (%s)" % exc)

    def test_self_referencing_symlink(self):
        write_skill(self.skills, "ok")
        looper = write_skill(self.skills, "looper")
        os.symlink("../../skills", looper / "back")  # 指回 skills/ 自身
        data, _ = self.scan()
        names = {s["name"] for s in data["skills"]}
        self.assertEqual(names, {"ok", "looper"})

    def test_mutual_symlink_loop(self):
        a = write_skill(self.skills, "a")
        b = write_skill(self.skills, "b")
        os.symlink(b, a / "to-b")
        os.symlink(a, b / "to-a")
        data, _ = self.scan()
        self.assertEqual(len({s["name"] for s in data["skills"]}), 2)

    def test_symlink_to_parent_chain(self):
        deep = self.skills / "deep" / "x" / "y"
        deep.mkdir(parents=True, exist_ok=True)
        write_skill(self.skills, "deep")
        os.symlink(self.skills, deep / "up")
        data, _ = self.scan()
        self.assertIn("deep", {s["name"] for s in data["skills"]})


class TestNonUtf8PathName(HostileCase):
    """路径名本身不是合法 UTF-8。

    注意与 `test_degradation.py` 的区别：那里测的是**文件内容**的非 UTF-8
    字节，这里测的是**文件名**。前者靠 errors="replace" / from_utf8_lossy
    处理，后者走的是完全不同的一条路（OsStr → String 的转换）。

    macOS 的 APFS **拒绝**非 UTF-8 文件名（Errno 92），所以这条只能在
    Linux（ext4 允许任意字节）上真正跑起来 —— CI 覆盖，本地自动跳过。
    """

    def test_scan_survives_non_utf8_directory_name(self):
        raw = b"bad-\xff\xfe-name"
        target = os.path.join(os.fsencode(str(self.skills)), raw)
        try:
            os.makedirs(target, exist_ok=True)
            with open(os.path.join(target, b"SKILL.md"), "wb") as f:
                f.write(b"---\nname: badname\ndescription: d\n---\n\nbody\n")
        except (OSError, UnicodeError) as e:
            self.skipTest("本文件系统拒绝非 UTF-8 文件名（%s）" % e)

        write_skill(self.skills, "healthy")
        data, _ = self.scan()
        names = {s["name"] for s in data["skills"]}
        self.assertIn("healthy", names, "非 UTF-8 邻居不得带走正常的 skill")
        self.assertGreaterEqual(len(names), 2, "非 UTF-8 目录本身也应被扫到")


class TestScalesToLargeLibraries(HostileCase):
    """规模。ENGINEERING §1.5 把「500+ skill 的 P95 > 3 秒」定为重新考虑
    实现语言的触发条件之一，所以这个数必须可复现地测出来，而不是凭感觉。

    实测（600 个 skill，本机）：Python 中位 1.19s / 最慢 1.93s，
    Rust 中位 0.10s。**Python 未越线** —— 这与 §1.3 的说法一致：
    选 Rust 的理由不是性能。
    """

    N = 300  # 常驻测试用 300；600 的完整基准见 ENGINEERING §1.3

    def test_large_library_completes_and_is_internally_consistent(self):
        for i in range(self.N):
            write_skill(self.skills, "s%03d" % i,
                        body=("段落 %d，中文与 English 混排。\n" % i) * 20)
        data, elapsed = self.scan()

        self.assertEqual(data["total_skills_on_disk"], self.N)
        self.assertEqual(len(data["skills"]), self.N)
        # 汇总与明细必须对得上 —— 规模上去之后最容易在这里出现静默丢项
        self.assertEqual(data["loaded_skills"],
                         sum(1 for s in data["skills"] if s["loaded"]))
        self.assertEqual(data["description_budget"]["counted_skills"],
                         len({(s["namespace"] or "", s["name"])
                              for s in data["skills"] if s["loaded"]}))
        # 只做一个非常宽松的上界：这不是性能基准，是「没有指数级退化」的哨兵
        self.assertLess(elapsed, TIMEOUT / 2,
                        "%d 个 skill 用了 %.1fs，疑似复杂度退化" % (self.N, elapsed))


class TestWorkBuddyManifestIsUntrustedInput(HostileCase):
    """`marketplace.json` 是**数据**，不是权威路径来源。

    我们一直对 `source` 做 marketplace 根目录边界检查，注释里还写着
    「清单是数据，不该决定扫描器去哪儿看」—— 但同一个函数里 `package` 与
    `version` 直接参与路径拼接。实测 `"name": "../../../../secret"` 能让
    扫描器读到 marketplace 之外的任意目录。

    **一个审计供应链风险的工具，不该信任一份数据文件里的路径片段。**
    """

    def _manifest(self, plugins):
        mk = self.tmp / ".workbuddy" / "plugins" / "marketplaces" / "workbuddy-builtin"
        (mk / ".codebuddy-plugin").mkdir(parents=True, exist_ok=True)
        (mk / "skills" / "legit").mkdir(parents=True, exist_ok=True)
        (mk / "skills" / "legit" / "SKILL.md").write_text(
            "---\nname: legit\ndescription: d\n---\n\nbody\n", encoding="utf-8")
        # 缓存根必须存在，否则一律走 marketplace fallback，测不到拼接
        (self.tmp / ".workbuddy" / "plugins" / "cache" / "workbuddy-builtin").mkdir(
            parents=True, exist_ok=True)
        (mk / ".codebuddy-plugin" / "marketplace.json").write_text(
            json.dumps({"plugins": plugins}), encoding="utf-8")
        # 越界目标：marketplace 之外的一个可读 skill
        out = self.tmp / "secret" / "skills" / "leaked"
        out.mkdir(parents=True, exist_ok=True)
        (out / "SKILL.md").write_text(
            "---\nname: LEAKED\ndescription: d\n---\n\nbody\n", encoding="utf-8")

    def _scan_wb(self):
        out = self.tmp / "wb.json"
        env = isolated_home_env(self.tmp)
        env["AGENT_VITALS_DISABLE_WORKBUDDY_BUILTINS"] = "0"
        r = subprocess.run(SCAN_CMD + ["--harness", "workbuddy", "--json", str(out)],
                           cwd=str(self.tmp / "workdir"), env=env,
                           capture_output=True, text=True, timeout=TIMEOUT)
        self.assertEqual(r.returncode, 0, r.stderr)
        return [s["name"] for s in json.loads(out.read_text(encoding="utf-8"))["skills"]]

    def test_package_with_dotdot_cannot_escape_the_cache_root(self):
        self._manifest([{"name": "../../../../secret", "version": ".",
                         "category": "builtin-plugin", "source": "./skills/legit"}])
        self.assertNotIn("LEAKED", self._scan_wb(), "package 里的 .. 越界了")

    def test_absolute_version_cannot_replace_the_path(self):
        """`Path::join` 遇到绝对路径会**整段替换**，这是最容易被忽略的一种。"""
        self._manifest([{"name": "p", "version": str(self.tmp / "secret"),
                         "category": "builtin-plugin", "source": "./skills/legit"}])
        self.assertNotIn("LEAKED", self._scan_wb(), "绝对 version 越界了")

    def test_empty_package_or_version_is_rejected(self):
        self._manifest([{"name": "", "version": "", "category": "builtin-plugin",
                         "source": "./skills/legit"}])
        self._scan_wb()  # 不崩即可

    def test_empty_cache_dir_falls_back_to_marketplace_source(self):
        """缓存目录存在但内容不完整时必须回退，否则扫出来的是一个空壳。

        category=skill 那条一直要求 cached/SKILL.md 存在才用缓存；
        builtin-plugin 曾经只判目录存在，两处口径不一致。
        """
        self._manifest([{"name": "p", "version": "1.0.0", "category": "builtin-plugin",
                         "source": "./skills/legit"}])
        (self.tmp / ".workbuddy" / "plugins" / "cache" / "workbuddy-builtin"
         / "p" / "1.0.0").mkdir(parents=True, exist_ok=True)  # 空目录
        self.assertIn("legit", self._scan_wb(), "空缓存目录必须回退到 marketplace source")


if __name__ == "__main__":
    unittest.main(verbosity=2)
