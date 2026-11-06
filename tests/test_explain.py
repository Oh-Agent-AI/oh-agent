#!/usr/bin/env python3
"""`explain` —— 漏斗的 UI（PRODUCT §5.3、ARCHITECTURE §1）。

`explain` 与 `doctor` 的区别在于它必须回答**「为什么」和「所以呢」**。
一条只说「这个 skill 没生效」的输出没有价值 —— 用户已经知道了，他来问的是
哪一级断的、断在哪个文件、以及现在该动哪一下。

所以这里的测试几乎都在钉「不许编」：

- 上游断了，**下游必须是「不适用」**，不能给一个凭空的 true/false。
  给了的话，用户会去修一个在当前状态下根本不存在的问题。
- `Discoverable` **永远不取 false**（§1.2）。「超预算后从调用最少的开始
  丢弃」是传闻不是实测，我们没有资格断言某一条真的被丢了。
- 读不到执行环境配置时 `Enabled` 是 **unknown 不是 false**。渲染成 false，
  用户会去开一个本来就开着的开关，然后以为自己修好了。
- 同名多份必须**全部列出并标出你问的是哪一份**，否则这条命令讲不清
  shadowing —— 而那是它最主要的用途。

跑法：
    python3 -m unittest tests.test_explain -v
    需要 AGENT_VITALS_BIN 才做双实现比对，否则只跑行为断言。
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from tests.env_helpers import isolated_home_env

ROOT = Path(__file__).resolve().parent.parent
SCAN = ROOT / "scripts" / "scan.py"
PY_CMD = [sys.executable, str(SCAN)]
_BIN = os.environ.get("AGENT_VITALS_BIN")
RS_CMD = [str(Path(_BIN).resolve())] if _BIN else None
SCAN_CMD = RS_CMD or PY_CMD


def _ms_days_ago(days):
    return int((time.time() - days * 86400) * 1000)


def write_skill(base: Path, name: str, body="body\n", desc="d", fm=True):
    d = base / name
    d.mkdir(parents=True, exist_ok=True)
    head = "---\nname: %s\ndescription: %s\n---\n\n" % (name, desc) if fm else ""
    (d / "SKILL.md").write_text(head + body, encoding="utf-8")
    return d


class ExplainCase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.sk = self.tmp / ".claude" / "skills"
        self.proj = self.tmp / "workdir" / ".claude" / "skills"
        (self.tmp / "workdir").mkdir(parents=True, exist_ok=True)

        write_skill(self.sk, "healthy", desc="render charts from a csv file")
        # 与 healthy 刻意造出词面重叠，供 TestOneThresholdOneAnswer 用；
        # 不重叠的话那条测试两边都是 0，断言恒真。
        write_skill(self.sk, "unused",
                    desc="render charts and tables from a csv export")
        write_skill(self.sk, "no-desc", fm=False)
        # **已加载的 skill 必须多于 5 个。**风险区间那条测试要能分辨「读扫描器
        # 给的名单」和「自己从 longest_descriptions 重算」—— 而后者被截断到前
        # 5 条。语料只有 4 个的话两种算法结果相同，测试就抓不到重算的退化。
        for i, what in enumerate(("resize and crop images in bulk",
                                  "translate subtitles between languages",
                                  "schedule recurring backups to s3",
                                  "lint terraform modules before apply")):
            write_skill(self.sk, "filler-%d" % i, desc=what)
        # 同名两份：personal 生效，project 被遮蔽且更新
        write_skill(self.sk, "dup", "personal\n")
        newer = write_skill(self.proj, "dup", "project\n")
        past = time.time() - 3600
        os.utime(self.sk / "dup" / "SKILL.md", (past, past))
        # 插件里的一份（默认未启用）
        write_skill(self.tmp / ".claude" / "plugins" / "cache" / "mkt" / "pg" /
                    "unknown" / "skills", "gh", desc="review pull requests")
        self.newer = newer

        self.claude_json = self.tmp / ".claude.json"
        self.write_harness({"enabledPlugins": {},
                         "skillUsage": {"healthy": {"usageCount": 9,
                                                    "lastUsedAt": _ms_days_ago(1)}}})

    def write_harness(self, cfg):
        self.claude_json.write_text(json.dumps(cfg), encoding="utf-8")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_explain(self, name, *extra, cmd=None, expect=0):
        env = isolated_home_env(self.tmp)
        r = subprocess.run((cmd or SCAN_CMD) + ["explain", name, "--harness", "claude-code"]
                           + list(extra),
                           cwd=str(self.tmp / "workdir"), env=env,
                           capture_output=True, text=True)
        self.assertEqual(r.returncode, expect, r.stderr or r.stdout)
        return r.stdout + r.stderr

    def records(self, name, *extra):
        out = self.tmp / "ex.json"
        self.run_explain(name, "--json", str(out), *extra)
        return json.loads(out.read_text(encoding="utf-8"))

    def stages(self, name, *extra):
        return [{r["stage"]: (r["state"], r["reason"]) for r in rec["funnel"]}
                for rec in self.records(name, *extra)]


class TestBrokenUpstreamStopsTheFunnel(ExplainCase):
    """上游断了，下游必须是「不适用」而不是一个编出来的判断。"""

    def test_disabled_plugin_has_no_downstream_verdicts(self):
        st = self.stages("gh")[0]
        self.assertEqual(st["Enabled"][0], "false")
        for stage in ("Loaded", "Discoverable", "Selected", "Triggered"):
            self.assertEqual(st[stage][0], "n/a",
                             "Enabled 已经是 false，%s 却给了判断" % stage)

    def test_shadowed_copy_has_no_downstream_verdicts(self):
        recs = self.records("dup")
        shadowed = [r for r in recs if r["is_shadowed"]]
        self.assertTrue(shadowed, "语料没造出被遮蔽的副本")
        st = {r["stage"]: r["state"] for r in shadowed[0]["funnel"]}
        self.assertEqual(st["Loaded"], "false")
        for stage in ("Discoverable", "Selected", "Triggered"):
            self.assertEqual(st[stage], "n/a")

    def test_healthy_skill_does_reach_the_bottom(self):
        """对照组：没有这一半，上面两条可以靠「漏斗根本没实现」通过。"""
        st = self.stages("healthy")[0]
        self.assertEqual(st["Installed"][0], "true")
        self.assertEqual(st["Enabled"][0], "true")
        self.assertEqual(st["Loaded"][0], "true")
        self.assertEqual(st["Discoverable"][0], "true")
        self.assertEqual(st["Triggered"][0], "true")
        self.assertNotIn("n/a", [v[0] for v in st.values()])


class TestDiscoverableIsNeverFalse(ExplainCase):
    """ARCHITECTURE §1.2：「超预算后丢弃最少用的」是传闻不是实测。

    断言 `false` 等于宣称我们知道执行环境真的丢了它 —— 我们不知道。
    """

    def test_no_state_is_false_across_every_reachable_case(self):
        for name, extra in (("healthy", ()), ("no-desc", ()),
                            ("healthy", ("--budget", "1"))):
            with self.subTest(name=name, extra=extra):
                for st in self.stages(name, *extra):
                    self.assertNotEqual(st["Discoverable"][0], "false", st)

    def test_over_budget_becomes_at_risk_not_false(self):
        st = self.stages("healthy", "--budget", "1")[0]
        self.assertEqual(st["Discoverable"][0], "at_risk")
        self.assertIn("budget", st["Discoverable"][1])

    def test_missing_frontmatter_is_at_risk_and_names_the_field(self):
        st = self.stages("no-desc")[0]
        self.assertEqual(st["Discoverable"][0], "at_risk")
        self.assertIn("description", st["Discoverable"][1])

    def test_at_risk_band_matches_the_budget_report(self):
        """风险区间必须与 description_budget 同源。

        `explain` 曾经自己重算这个区间，而它手上只有被截断到前 5 条的
        `longest_descriptions` —— 算出来 2 条，报告里写着 4 条。同一份输出
        自相矛盾，读者无从判断该信哪个。现在扫描器直接给名单。
        """
        env = isolated_home_env(self.tmp)
        raw = self.tmp / "raw.json"
        subprocess.run(SCAN_CMD + ["--harness", "claude-code", "--budget", "1",
                                   "--json", str(raw)],
                       cwd=str(self.tmp / "workdir"), env=env,
                       capture_output=True, text=True, check=True)
        b = json.loads(raw.read_text(encoding="utf-8"))["description_budget"]
        self.assertGreater(b["skills_possibly_dropped"], 0, "语料没造出溢出")
        self.assertEqual(len(b["at_risk_skills"]), b["skills_possibly_dropped"],
                         "名单与条数不是同一次累加算出来的")
        for name in b["at_risk_skills"]:
            with self.subTest(name=name):
                live = [st for st in self.stages(name, "--budget", "1")
                        if st["Discoverable"][0] != "n/a"]
                self.assertTrue(live, "%s 在风险名单里却没有生效副本" % name)
                self.assertEqual(live[0]["Discoverable"][0], "at_risk",
                                 "%s 在预算风险名单里，explain 却说它没事" % name)

    def test_no_overflow_means_an_empty_band(self):
        """对照组：没超预算时名单必须是空的，不能顺手塞几个进去。"""
        env = isolated_home_env(self.tmp)
        raw = self.tmp / "ok.json"
        subprocess.run(SCAN_CMD + ["--harness", "claude-code", "--json", str(raw)],
                       cwd=str(self.tmp / "workdir"), env=env,
                       capture_output=True, text=True, check=True)
        b = json.loads(raw.read_text(encoding="utf-8"))["description_budget"]
        self.assertEqual(b["over_by_chars"], 0)
        self.assertEqual(b["at_risk_skills"], [])


class TestUnknownIsNotFalse(ExplainCase):
    """读不到执行环境配置 → Enabled 是 unknown。

    渲染成 false，用户会去开一个本来就开着的开关，然后以为自己修好了。
    """

    def test_unreadable_harness_config_yields_unknown(self):
        self.claude_json.unlink()
        st = self.stages("gh")[0]
        self.assertEqual(st["Enabled"][0], "unknown", st["Enabled"])
        self.assertIn("unreadable", st["Enabled"][1])

    def test_and_it_is_false_when_the_config_really_says_so(self):
        """对照组：配置读得到、插件确实没启用时才是 false。"""
        st = self.stages("gh")[0]
        self.assertEqual(st["Enabled"][0], "false")

    def test_selected_is_always_unknown(self):
        """Selected 没有任何直接数据源，给 true/false 都是编的。"""
        for st in self.stages("healthy"):
            self.assertEqual(st["Selected"][0], "unknown")


class TestShadowingIsExplainedNotJustReported(ExplainCase):
    def test_both_copies_are_shown(self):
        recs = self.records("dup")
        self.assertEqual(len(recs), 2, "同名两份只讲了一份，shadowing 就讲不清")
        self.assertEqual(sum(1 for r in recs if r["is_shadowed"]), 1)

    def test_output_marks_which_copy_you_asked_about(self):
        out = self.run_explain("dup")
        self.assertIn("← requested copy", out,
                      "两份路径长得很像，不标出来读者得逐字符比对")
        self.assertIn("active", out)
        self.assertIn("shadowed", out)

    def test_precedence_is_stated_because_it_is_counterintuitive(self):
        out = self.run_explain("dup")
        self.assertIn("enterprise > personal > project > plugin",
                      " ".join(out.split()))

    def test_fix_is_actionable_and_ordered(self):
        out = self.run_explain("dup")
        self.assertIn("1. Rename", out)
        self.assertIn("2. Symlink", out)
        self.assertIn("3. Layer", out)

    def test_it_does_not_claim_the_wrong_copy_is_newer(self):
        """语料里 project 那份确实更新 —— 说反了整段「为什么」就不可信了。"""
        out = self.run_explain("dup")
        self.assertIn("The copy you edited is newer but is not effective", out)


class TestLookupRules(ExplainCase):
    def test_namespaced_name_wins_over_bare_name(self):
        recs = self.records("pg:gh")
        self.assertEqual(len(recs), 1)
        self.assertEqual(recs[0]["namespace"], "pg")

    def test_missing_name_exits_nonzero(self):
        """打印一行「没找到」然后返回 0，会被脚本调用方当成「查过了，没问题」。"""
        out = self.run_explain("definitely-not-here", expect=1)
        self.assertIn("No skill named", out)

    def test_near_miss_suggests_candidates(self):
        out = self.run_explain("heal", expect=1)
        self.assertIn("healthy", out)


class TestCostBucketsAreNotMerged(ExplainCase):
    """四个桶各答各的问题，合并会把「每次触发的成本」说成「全读的成本」。"""

    def test_all_four_numbers_are_reported(self):
        rec = self.records("healthy")[0]
        for k in ("tier1_tokens", "tier2_core_tokens", "tier2_refs_tokens",
                  "tier2_max_tokens"):
            self.assertIn(k, rec["cost"])
        out = self.run_explain("healthy")
        for label in ("tier1", "tier2 core", "tier2 refs", "tier2 max"):
            self.assertIn(label, out)


class TestSecurityWordingHoldsHere(ExplainCase):
    def test_never_says_safe(self):
        out = self.run_explain("healthy")
        for phrase in ("是安全的", "没有风险", "safe to use"):
            self.assertNotIn(phrase, out)
        self.assertIn("does not prove safety", out)


class TestOneThresholdOneAnswer(ExplainCase):
    """邻居判定与 `overlap` 必须同阈值，否则两条命令互相否证。"""

    def test_neighbours_match_overlap(self):
        env = isolated_home_env(self.tmp)
        pairs = self.tmp / "pairs.json"
        subprocess.run(SCAN_CMD + ["overlap", "--harness", "claude-code",
                                   "--min", "0.1", "--json", str(pairs)],
                       cwd=str(self.tmp / "workdir"), env=env,
                       capture_output=True, text=True, check=True)
        allp = json.loads(pairs.read_text(encoding="utf-8"))
        self.assertTrue(allp, "语料没造出任何重叠对，这条测试是空转的")
        name = allp[0]["a"]
        rec = [r for r in self.records(name, "--min", "0.1")
               if not r["is_shadowed"]][0]
        expected = [p for p in allp if name in (p["a"], p["b"])]
        self.assertEqual(len(rec["overlap_candidates"]), len(expected))


class TestTerminalOutputHasNoMarkdown(ExplainCase):
    """终端报告里不得出现 markdown 的 `**`。

    这条不是洁癖，是**折行会把它劈开**：一句
    `确认不需要再停用。**本工具永远不自动删除任何东西。**`
    折出来是

        ... 确认不需要再停用。**本工具
            永远不自动删除任何东西。**

    终端不渲染 markdown，星号原样打出来，还被拆到两行行首。强调要用「」——
    它是单个字符，且已经在 `_NO_LINE_START` 的禁则表里，不会落到行首。

    **断言的是「整份输出里没有 `**`」，不是「那一句改对了」。**同一个坑已经踩
    过三次（doctor 一批、explain 一句、rust 分支合回来时又撞上），每次都是新写
    的一句话带着 `**` 溜进终端 —— 用例只能覆盖你想到的那句，所以这里覆盖全部。
    """

    def _all_output(self):
        env = isolated_home_env(self.tmp)
        texts = []
        # **零结果的分支也要走到。**第一版漏了 `overlap` 的「一对都没有」分支，
        # 它里面正好也藏着一处 `**` —— 语料总有重叠对，所以那条路径从没被跑过。
        # 一条永远走不到的分支，守门测试等于没写。
        for argv in (["doctor"], ["explain", "healthy"], ["explain", "dup"],
                     ["explain", "gh"], ["explain", "no-desc"], ["list"],
                     ["overlap"], ["overlap", "--min", "0.99"],
                     ["list", "--unused"]):
            r = subprocess.run(SCAN_CMD + argv + ["--harness", "claude-code"],
                               cwd=str(self.tmp / "workdir"), env=env,
                               capture_output=True, text=True)
            texts.append((argv, r.stdout))
        return texts

    def test_no_double_asterisk_anywhere(self):
        for argv, out in self._all_output():
            with self.subTest(cmd=" ".join(argv)):
                bad = [l for l in out.splitlines() if "**" in l]
                self.assertEqual(bad, [], "终端输出里有 markdown 强调：%r" % bad)

    def test_the_fixture_actually_reaches_that_line(self):
        """确认语料真的走到了带那句话的分支，否则上面是空转的。

        断言前要**把折行拆掉再拼回去** —— 那句话本身就会被折成两行，直接
        assertIn 找不到，会让这条守门测试看起来是「没走到」而不是「没问题」。
        """
        joined = "".join(o for _, o in self._all_output())
        flat = re.sub(r"\n\s*", "", joined)
        self.assertIn("This tool never deletes anythingautomatically", flat)


@unittest.skipUnless(RS_CMD, "未设 AGENT_VITALS_BIN，跳过双实现比对")
class TestBothImplementationsRenderIdentically(ExplainCase):
    def test_identical(self):
        for name, extra in (("healthy", ()), ("dup", ()), ("gh", ()),
                            ("healthy", ("--budget", "1"))):
            with self.subTest(name=name, extra=extra):
                self.assertEqual(self.run_explain(name, *extra, cmd=PY_CMD),
                                 self.run_explain(name, *extra, cmd=RS_CMD))


if __name__ == "__main__":
    unittest.main()
