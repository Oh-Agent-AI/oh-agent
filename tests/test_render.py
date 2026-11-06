#!/usr/bin/env python3
"""呈现层的差分与行为测试（PRODUCT §5.2、§6）。

## 为什么不用 golden

`list` 的输出含 `LAST USED`（几天前）与由 `installed_days_ago` 推出的
STATUS —— 都由 `time.time()` 参与计算，提交进仓库的快照第二天就过期。

改为**同一时刻跑两个实现再比对**：时间派生值在两次运行之间相同，差异
只可能来自实现。这比 golden 更适合呈现层，代价是没有「行为变了」的历史
记录 —— 后者由下面的行为断言补上。

## 为什么必须测

呈现层此前完全在覆盖之外：golden 只比 JSON，而**用户看到的是这张表**。
LOAD/STATUS 分列、未加载不谈生命周期、阈值必须显示 —— 这些都是产品规格，
不是实现细节。

跑法：
    python3 -m unittest tests.test_render -v
    需要 AGENT_VITALS_BIN 才做双实现比对，否则只跑行为断言。
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from tests.env_helpers import isolated_home_env

ROOT = Path(__file__).resolve().parent.parent
SCAN = ROOT / "scripts" / "scan.py"
PY_CMD = [sys.executable, str(SCAN)]
_BIN = os.environ.get("AGENT_VITALS_BIN")
RS_CMD = [str(Path(_BIN).resolve())] if _BIN else None
SCAN_CMD = RS_CMD or PY_CMD


def write_skill(base: Path, name: str, body="body\n"):
    d = base / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(
        "---\nname: %s\ndescription: d\n---\n\n%s" % (name, body), encoding="utf-8")
    return d


class RenderCase(unittest.TestCase):
    """一份可控语料：既有已加载的，也有未启用的插件与被遮蔽的副本。"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        sk = self.tmp / ".claude" / "skills"
        proj = self.tmp / "workdir" / ".claude" / "skills"
        (self.tmp / "workdir").mkdir(parents=True, exist_ok=True)

        write_skill(sk, "used-a", "x" * 4000 + "\n")
        write_skill(sk, "used-b")
        write_skill(sk, "never-used")
        # 同名副本：personal 生效、project 被遮蔽
        write_skill(sk, "dup", "personal wins\n")
        write_skill(proj, "dup", "project shadowed\n")
        # 未启用的插件
        write_skill(self.tmp / ".claude" / "plugins" / "cache" / "mkt" / "p" /
                    "unknown" / "skills", "plug-off")

        (self.tmp / ".claude.json").write_text(json.dumps({
            "enabledPlugins": {},
            "skillUsage": {
                "used-a": {"usageCount": 12, "lastUsedAt": _ms_days_ago(2)},
                "used-b": {"usageCount": 3, "lastUsedAt": _ms_days_ago(45)},
                "dup": {"usageCount": 5, "lastUsedAt": _ms_days_ago(1)},
            },
        }), encoding="utf-8")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_list(self, *extra, cmd=None):
        env = isolated_home_env(self.tmp)
        r = subprocess.run((cmd or SCAN_CMD) + ["list", "--harness", "claude-code"]
                           + list(extra),
                           cwd=str(self.tmp / "workdir"), env=env,
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout


def _ms_days_ago(days):
    import time
    return int((time.time() - days * 86400) * 1000)


class TestListMatchesSpec(RenderCase):
    def test_load_and_status_are_separate_columns(self):
        """PRODUCT §5.2：两者正交，挤成一列会隐藏 shadowed 的使用数据。"""
        out = self.run_list()
        self.assertIn("LOAD", out)
        self.assertIn("STATUS", out)
        # 同名的两份都要出现：生效的那份 + 被遮蔽的那份。
        # **两份都显示才看得出「你改的那份没生效」**，这正是这张表的用处。
        dups = [l for l in out.splitlines() if l.startswith("dup ")]
        self.assertEqual(len(dups), 2, "生效与被遮蔽的两份都该列出：%r" % dups)
        loads = sorted(l.split()[1] for l in dups)
        self.assertEqual(loads, ["loaded", "shadowed"])
        # 关键：shadowed 那行仍要显示使用数据，而不是被状态词吃掉
        sh = [l for l in dups if "shadowed" in l][0]
        self.assertIn("active", sh, "既 shadowed 又 active 是最该被看见的情况")
        self.assertIn("5", sh)

    def test_unloaded_skills_do_not_get_a_lifecycle_word(self):
        """未加载的 skill 不谈使用生命周期 —— 规格里那行是 `disabled — — —`。"""
        out = self.run_list()
        row = [l for l in out.splitlines() if l.startswith("plug-off")][0]
        self.assertIn("disabled", row)
        for word in ("zombie", "too-new", "active", "dormant", "occasional"):
            self.assertNotIn(word, row,
                             "未加载却给了生命周期词：%r" % row)

    def test_lifecycle_words_follow_the_thresholds(self):
        out = self.run_list()
        by = {l.split()[0]: l for l in out.splitlines() if l and not l.startswith(("NAME", "─"))}
        self.assertIn("active", by["used-a"], "2 天前用过 → active")
        self.assertIn("dormant", by["used-b"], "45 天前用过 → dormant")
        self.assertIn("too-new", by["never-used"], "零触发且刚装 → too-new")

    def test_thresholds_are_printed(self):
        """§6.1：没有阈值的状态词无法解释也无法复现。"""
        out = self.run_list()
        self.assertIn("dormant=30d", out)
        self.assertIn("zombie=14d", out)

    def test_stale_flag_moves_the_boundary(self):
        out = self.run_list("--stale", "60")
        self.assertIn("dormant=60d", out)
        by = {l.split()[0]: l for l in out.splitlines() if l.startswith("used-b")}
        self.assertIn("occasional", by["used-b"], "阈值放宽到 60 天后不再是 dormant")

    def test_loaded_rows_come_first(self):
        """真正进了上下文的必须在最前 —— 否则未启用的大块头会把它顶出屏幕。"""
        out = self.run_list()
        names = [l.split()[0] for l in out.splitlines()
                 if l and not l.startswith(("NAME", "─")) and "·" not in l]
        self.assertEqual(names[0:1], ["used-a"], "按 cost 排时最大的已加载项在首位")
        self.assertEqual(names[-1], "plug-off", "未启用的排在最后")

    def test_filters(self):
        self.assertNotIn("used-a", self.run_list("--shadowed"))
        self.assertIn("dup", self.run_list("--shadowed"))
        unused = self.run_list("--unused")
        self.assertIn("used-b", unused, "dormant 计入 --unused")
        self.assertNotIn("used-a", unused, "active 不计入")

    def test_json_output_shares_the_same_rows(self):
        out_path = self.tmp / "rows.json"
        msg = self.run_list("--json", str(out_path))
        self.assertIn("Wrote", msg)
        rows = json.loads(out_path.read_text(encoding="utf-8"))
        self.assertTrue(any(r["name"] == "dup" and r["load"] == "shadowed" for r in rows))
        # 未加载的行在 JSON 里同样不带生命周期词
        off = [r for r in rows if r["name"] == "plug-off"][0]
        self.assertIsNone(off["status"])


def write_desc(base: Path, name: str, desc: str):
    d = base / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(
        "---\nname: %s\ndescription: %s\n---\n\nbody\n" % (name, desc), encoding="utf-8")
    return d


class OverlapCase(unittest.TestCase):
    """两对该被看见的、一个不该被算进来的。"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        sk = self.tmp / ".claude" / "skills"
        (self.tmp / "workdir").mkdir(parents=True, exist_ok=True)

        write_desc(sk, "github", "review pull request and issue in a repository")
        write_desc(sk, "github-tools", "manage repository issue and pull request labels")
        write_desc(sk, "docs-a", "在线文档的创建与编辑，管理知识库空间")
        write_desc(sk, "docs-b", "在线文档的编辑与导出，管理知识库空间")
        write_desc(sk, "unrelated", "convert audio waveform sampling rates")
        # 接得出、但对面没说过的一串：用来钉住「不许凭空造词」。
        # 共享二元组 {云文, 文档, 同步} 能在 a 侧接出「云文档」，
        # 而 b 侧从头到尾没有这三个字连在一起。
        write_desc(sk, "fake-a", "云文档管理与同步")
        write_desc(sk, "fake-b", "上传文档到云文件夹并同步")
        # 未启用的插件副本：装在磁盘上，但不在选择器里，不该参与比较。
        # **必须放两个**：插件与 personal 的 conflict_domain 本来就不同，
        # 只放一个的话，就算去掉 loaded 闸门它也配不出对 —— 那样测的是
        # 域隔离，不是这里声称的那条。两个同域副本才逼得出真结论。
        plug = self.tmp / ".claude" / "plugins" / "cache" / "mkt" / "p" / "unknown" / "skills"
        write_desc(plug, "plug-github", "review pull request and issue in a repository")
        write_desc(plug, "plug-github-tools",
                   "manage repository issue and pull request labels")

        (self.tmp / ".claude.json").write_text(
            '{"enabledPlugins":{},"skillUsage":{}}', encoding="utf-8")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_overlap(self, *extra, cmd=None):
        env = isolated_home_env(self.tmp)
        for k in ("CODEX_RUNTIME", "OPENCLAW_RUNTIME", "WORKBUDDY_BUILTINS"):
            env["AGENT_VITALS_DISABLE_" + k] = "1"
        r = subprocess.run((cmd or SCAN_CMD) + ["overlap", "--harness", "claude-code"]
                           + list(extra),
                           cwd=str(self.tmp / "workdir"), env=env,
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout


class TestOverlapMatchesSpec(OverlapCase):
    def test_similar_pairs_are_reported(self):
        out = self.run_overlap("--min", "0.2")
        self.assertIn("github  ↔  github-tools", out)
        self.assertIn("docs-a  ↔  docs-b", out)

    def test_unrelated_skill_is_not_paired(self):
        self.assertNotIn("unrelated", self.run_overlap("--min", "0.2"))

    def test_unloaded_copies_never_participate(self):
        """磁盘 ≠ 上下文。未启用的副本不在选择器里，报它等于报一个
        用户既无法验证、也无需处理的「重叠」。"""
        out = self.run_overlap("--min", "0.05")
        self.assertIn("github  ↔  github-tools", out, "同样的一对在已加载侧要配得出来")
        self.assertNotIn("plug-github", out)

    def test_chinese_bigrams_are_joined_back_into_words(self):
        """二元组直接打印是「云文 · 件夹」这样的半个词，读者无从判断。"""
        out = self.run_overlap("--min", "0.2")
        line = [l for l in out.splitlines() if "Shared terms" in l and "在线" in l]
        self.assertTrue(line, "中文共享说法没有被接回成词：\n%s" % out)
        shown = line[0].split("Shared terms")[1]
        for phrase in [p.strip() for p in shown.split("·")]:
            phrase = phrase.split("(")[0].strip()
            if not phrase or phrase.isascii():
                continue
            self.assertIn(phrase, "在线文档的创建与编辑，管理知识库空间",
                          "打印了一个原文里没有的说法：%r" % phrase)

    def test_joined_phrase_must_exist_on_both_sides(self):
        """接回长串**不许凭空造词**。

        `云文` 与 `文档` 都是共享二元组，接起来就是 `云文档` —— 而
        fake-b 说的是「云文件夹」，从没说过「云文档」。把它当作两者的
        共享说法打出来，是在给一个不存在的证据。
        """
        out = self.run_overlap("--min", "0.1")
        self.assertIn("fake-a  ↔  fake-b", out, "这一对本身要被列出来，断言才有意义")
        self.assertNotIn("云文档", out, "打印了一个 fake-b 从未写过的说法")

    def test_caveat_is_always_printed(self):
        """§5.4：这是筛选器不是判决。零结果时更要说 —— 「没查到」最容易
        被读成「没问题」。"""
        for flags in (("--min", "0.2"), ("--min", "0.99")):
            with self.subTest(flags=flags):
                out = self.run_overlap(*flags)
                self.assertIn("Lexical", out)
                self.assertIn("not a verdict" if flags[1] == "0.2" else "no semantic competition",
                              out)
                self.assertIn("/agent-vitals", out, "必须给出拿到真判断的下一步")

    def test_judge_is_not_advertised_as_available(self):
        """`--judge` 是 P1.5。把没实现的东西写成可用的选项，用户敲下去
        只会得到一个报错 —— 缺一列有价值，编一列没有。"""
        out = self.run_overlap("--min", "0.2")
        self.assertIn("not implemented", out)

    def test_json_rows(self):
        p = self.tmp / "ov.json"
        self.run_overlap("--min", "0.2", "--json", str(p))
        rows = json.loads(p.read_text(encoding="utf-8"))
        pair = [r for r in rows if {r["a"], r["b"]} == {"github", "github-tools"}]
        self.assertEqual(len(pair), 1)
        self.assertGreater(pair[0]["jaccard"], 0.2)
        self.assertIn("repository", pair[0]["shared"])

    def test_top_limits_rows(self):
        p = self.tmp / "ov1.json"
        self.run_overlap("--min", "0.05", "--top", "1", "--json", str(p))
        self.assertEqual(len(json.loads(p.read_text(encoding="utf-8"))), 1)


@unittest.skipUnless(RS_CMD, "未设 AGENT_VITALS_BIN，跳过双实现比对")
class TestOverlapIsIdenticalAcrossImplementations(OverlapCase):
    def test_identical(self):
        for c in [("--min", "0.2"), ("--min", "0.05"), ("--min", "0.05", "--top", "2")]:
            with self.subTest(flags=c):
                self.assertEqual(self.run_overlap(*c, cmd=PY_CMD),
                                 self.run_overlap(*c, cmd=RS_CMD))


@unittest.skipUnless(RS_CMD, "未设 AGENT_VITALS_BIN，跳过双实现比对")
class TestBothImplementationsRenderIdentically(RenderCase):
    """呈现层的差分测试。

    同一时刻跑两个实现：时间派生值相同，差异只可能来自实现。
    """

    def test_identical_across_flag_combinations(self):
        combos = [
            (),
            ("--top", "3"),
            ("--sort", "name"),
            ("--sort", "usage"),
            ("--unused",),
            ("--shadowed",),
            ("--stale", "60"),
            ("--sort", "usage", "--top", "2"),
        ]
        for c in combos:
            with self.subTest(flags=c):
                a = self.run_list(*c, cmd=PY_CMD)
                b = self.run_list(*c, cmd=RS_CMD)
                self.assertEqual(a, b, "两个实现渲染不一致：%r" % (c,))


if __name__ == "__main__":
    unittest.main(verbosity=2)
