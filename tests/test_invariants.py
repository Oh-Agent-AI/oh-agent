#!/usr/bin/env python3
"""12 条不变量的验收门（ENGINEERING.md §2、§4.1）。

§4.1 定的验收标准不是覆盖率百分比，而是：

    12 条不变量，每一条都必须有一个「违反即失败」的测试。

本文件就是那道门。它**只读 golden 快照**，不直接跑扫描器，因此：

  - 对 Python 实现和 Rust 实现同样有效 —— 换实现只需重跑 golden_runner
  - 断言的是**判别性数值**而不是全文比对。golden 比对回答「有没有变」，
    这里回答「变的是不是要紧的那个数」。移植时前者会因为无关差异狂响，
    后者告诉你哪条不变量真的破了。

先跑 `python3 tests/golden_runner.py --update` 生成快照。

跑法：
    python3 tests/test_invariants.py
    python3 -m unittest tests.test_invariants -v
"""

import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GOLDEN = ROOT / "golden"


def load(name):
    p = GOLDEN / ("%s.json" % name)
    if not p.is_file():
        raise unittest.SkipTest("缺 %s，先跑 tests/golden_runner.py --update" % p)
    return json.loads(p.read_text(encoding="utf-8"))


class InvariantTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.default = load("default")
        cls.all = load("all")
        # 预算与触发数据是 Claude Code 专有的，默认多执行环境模式下不给。
        # 验这两块必须用单执行环境快照，否则测到的是「正确地拒绝回答」。
        cls.cc = load("claude-code")
        cls.cc_all = load("claude-code-all")
        cls.zombie0 = load("zombie-age-0")
        cls.redacted = load("redacted")
        cls.nocfg = load("no-harness-config")
        cls.cwd_home = load("cwd-is-home")
        cls.wb = load("harness-workbuddy")
        cls.oc = load("harness-openclaw")
        cls.by = {s["name"]: s for s in cls.default["skills"]}

    # ── 1 ────────────────────────────────────────────────
    def test_01_disk_is_not_context(self):
        """预算/冲突/僵尸只按 loaded 算。混算会产生「预算超支」假警报。"""
        self.assertGreater(self.default["total_skills_on_disk"],
                           self.default["loaded_skills"],
                           "语料必须包含在磁盘上但不进上下文的 skill")
        d, a = self.cc, self.cc_all
        self.assertTrue(d["description_budget"]["available"])
        self.assertEqual(d["description_budget"]["scope"], "loaded-only")
        self.assertEqual(a["description_budget"]["scope"], "all-on-disk")
        self.assertLess(d["description_budget"]["used_chars"],
                        a["description_budget"]["used_chars"],
                        "默认口径必须比 --all 小，否则说明未启用的副本被算进了预算")

    def test_01b_multi_harness_refuses_to_total_the_budget(self):
        """跨执行环境不给预算总数 —— 加总多个互不共享的上下文没有意义。

        这不是缺功能，是拒绝给一个会被误读的数字（见 cross_harness_note）。
        """
        self.assertFalse(self.default["description_budget"]["available"])
        self.assertEqual(self.default["description_budget"]["scope"], "not-available")
        self.assertIn("cross_harness_note", self.default)

    def test_01c_same_directory_reached_twice_is_scanned_once(self):
        """两种写法指向同一个目录时，只能扫一遍。

        从 home 跑时 `./.claude/skills` 与 `~/.claude/skills` 是同一处。
        不按 resolve 后的路径去重的话，同一批 skill 被扫两遍，进而被当成
        「内容相同的两份副本」而**凭空报出一个不存在的冲突** ——
        清点不准只是不准，编造一个问题是另一回事。

        这是真机上踩出来的：从 workdir 跑永远不显形，只有 cwd 等于 home
        时两个根才会撞上。移植时漏掉去重，Rust 侧报出了 33/2/1 条冲突，
        而 Python 是 32/1/0。
        """
        d = self.cwd_home
        paths = [r["path"] for r in d["scanned_roots"]]
        self.assertEqual(len(paths), len(set(paths)), "扫描根不得重复：%r" % paths)
        # 语料里只有两组**真实**副本；多出来的一定是同一目录被扫了两遍
        names = sorted(c["name"] for c in d["conflicts"])
        self.assertEqual(names, ["dup-identical", "dup-tool"],
                         "出现了语料里不存在的冲突：%r" % names)
        seen = set()
        for s_ in d["skills"]:
            key = (s_["harness"], s_["path"])
            self.assertNotIn(key, seen, "同一个 skill 被收录两次：%r" % (key,))
            seen.add(key)

    def test_01d_no_runtime_evidence_means_null_not_zero(self):
        """拿不到运行时证据的执行环境，计数必须是 null 而不是 0。

        `0` 读起来是「问到了，是零个」，而真相是「问不到」。Claude Code /
        Hermes / WorkBuddy 压根没有逐 skill 的运行时接口；Codex 与 OpenClaw
        有但可能探测失败 —— 三种情况在报告里是同一件事：**没有证据**。

        曾经这里是 0，于是 claude-code 那行显示 verified_loaded=0 而
        discoverable=31，读者会以为「31 个一个都没被证实」。同一份报告里
        openclaw_instances[].runtime_catalog_skills 探测不到时是 null，
        两处不一致。

        运行时**可用**时必须给出真实计数 —— 否则就是把一个坏值换成了永远的
        null，那同样没用。正向覆盖在 tests/test_harness_stubs.py（假执行环境让探测
        成功），那里断言 codex 1/1、openclaw 1/2。
        """
        for case in (self.default, self.cc, self.nocfg):
            for harness, summary in case["harness_summaries"].items():
                self.assertIsNone(summary["runtime_verified_loaded_skills"],
                                  "%s 无运行时证据时不得给出数字" % harness)
                self.assertIsNone(summary["runtime_verified_unique_skills"],
                                  "%s 无运行时证据时不得给出数字" % harness)
        # 反向：可发现数不受影响，仍是实打实的计数
        self.assertGreater(self.cc["harness_summaries"]["claude-code"]["discoverable_skills"], 0)

    def test_01e_workbuddy_builtin_plugin_skills_are_counted(self):
        """WorkBuddy 的 builtin-plugin 包也带 skill，必须计入。

        曾经只取 marketplace.json 里 category="skill" 的包，把 builtin-plugin
        整包排除，于是运行时真正在调用的 18 个 skill（腾讯文档/PPTX/Docx、
        微信支付、表格代理）一个都没进报告 —— 报 31/25，运行时实际 43。

        规则不是猜的：拿运行时的 available skills 名单与磁盘逐条对照推出来，
        推完再独立复现，正好得到同一个 43。

        **正向白名单**，只有两处算顶层 skill：
          <包>/<版本>/SKILL.md          包自身
          <包>/<版本>/skills/*/SKILL.md  它带的 skill
        """
        by = {s_["name"]: s_ for s_ in self.wb["skills"]}
        self.assertIn("wb-plain", by, "category=skill 的包（原有行为）")
        self.assertIn("wb-bundle", by, "builtin-plugin 包自身也是一个 skill")
        self.assertIn("bundled-a", by, "builtin-plugin 带的 skill 必须计入")
        self.assertIn("bundled-b", by)
        self.assertEqual(by["wb-bundle"]["root_kind"], "builtin-plugin-package")
        self.assertEqual(by["bundled-a"]["root_kind"], "builtin-plugin-skill")

    def test_01f_workbuddy_package_internals_are_not_skills(self):
        """两条否定断言 —— 它们才是这次修复的核心。

        1. `experts/` 下的是包内部的角色定义，不是顶层 skill。运行时也不把
           它们列进 available skills。**用正向白名单而不是排除 experts/**：
           只有一个包有 experts 目录，据此立全局规则是从单一样本推规则。
        2. cache 里会同时留着旧版本（实测 weixinpay 1.5.111 与 1.6.107 并存）。
           必须按 manifest 的版本钉住，否则同一个 skill 被数两遍。
        """
        names = [s_["name"] for s_ in self.wb["skills"]]
        self.assertNotIn("inner-expert", names,
                         "experts/ 下的是包内部角色定义，不是顶层 skill")
        self.assertEqual(names.count("bundled-a"), 1,
                         "旧版本残留不得让同一个 skill 被数两遍：%r" % names)

    def test_01g_schema_version_is_declared_first(self):
        """`schema_version` 必须存在且在最前。

        ARCHITECTURE §2 提了 5 次，而输出里一次都没有 —— 此前所有 schema
        变更（新增 unreadable_skills、runtime_verified_* 由 0 改为 null、
        WorkBuddy 口径）对下游**不可区分**。**没有版本号的 schema 等于
        没有契约。**

        放在最前是刻意的：解析方应当先读到它，再决定怎么读其余字段。
        """
        for case in (self.default, self.cc, self.nocfg, self.wb):
            self.assertEqual(next(iter(case)), "schema_version",
                             "版本号必须是第一个键")
            self.assertRegex(case["schema_version"], r"^\d+\.\d+$")

    def test_01h_orphan_marker_is_evidence_not_a_verdict(self):
        """`.orphaned_at` 报出来，但**不影响加载判定**。

        契约明确它不等于「已禁用」—— builtin 种子包常年带着这个标记。
        曾经这个值被算出来后直接丢掉，等于没采集。
        """
        w = self.wb["workbuddy_discovery"]
        self.assertIn("wb-bundle", w["orphaned_packages"], "带标记的包必须报出来")
        by = {s_["name"]: s_ for s_ in self.wb["skills"]}
        self.assertIn("wb-bundle", by, "带标记的包仍要照常计入")
        self.assertTrue(by["wb-bundle"]["loaded"], "标记不得当成「已禁用」")

    def test_01i_duplicate_manifest_package_is_taken_once(self):
        """清单把同一个包声明两次时只取第一条。

        清单本身没有表达「哪一份才算数」的机制，凭顺序取是唯一可解释的
        做法。不去重则同一个 skill 会按不同版本被收录多次。
        """
        w = self.wb["workbuddy_discovery"]
        self.assertEqual(w["top_level_manifest_packages"], 2,
                         "语料里声明了 3 条但只有 2 个不同的包")
        names = [s_["name"] for s_ in self.wb["skills"]]
        self.assertEqual(names.count("wb-bundle"), 1, "重复声明不得重复收录")

    def test_01j_loaded_state_distinguishes_no_from_unknown(self):
        """`loaded_state` 只在**明确不在**时是 false，其余是 null。

        它与 `enabled_state` 不是同一件事：后者说「配置里开没开」，前者说
        「这一轮到底在不在上下文里」。

        曾经 Rust 侧把它硬编码成 null，于是「配置里明确关掉」也被报成
        「不知道」。语料里当时没有 enabled:false 的条目，golden 撞不到 ——
        是真机差分抓出来的（15364 行里的一行）。
        """
        by = {s_["name"]: s_ for s_ in self.oc["skills"]}
        self.assertEqual(by["oc-off"]["loaded_state"], False,
                         "配置里明确关掉 = 明确不在，不是「不知道」")
        self.assertEqual(by["oc-off"]["enabled_state"], False)
        self.assertIsNone(by["oc-on"]["loaded_state"],
                          "配置里开着但未经运行时证实 = 不知道")
        self.assertEqual(by["oc-on"]["enabled_state"], True)
        self.assertIsNone(by["oc-plain"]["loaded_state"])
        self.assertIsNone(by["oc-plain"]["enabled_state"],
                          "只发现于磁盘，配置里没提 = 两者都不知道")

    # ── 2 ────────────────────────────────────────────────
    def test_02_plugin_skills_are_namespaced(self):
        """两个插件各带一个 access 不是冲突。去重键是 (namespace, name)。"""
        acc = [s for s in self.default["skills"] if s["name"] == "access"]
        self.assertEqual(len(acc), 2, "语料应有两个同名 access")
        self.assertEqual(len({s["namespace"] for s in acc}), 2, "命名空间必须不同")
        self.assertNotIn("access", [c["name"] for c in self.default["conflicts"]],
                         "不同插件的同名 skill 不得报成冲突")

    # ── 3 ────────────────────────────────────────────────
    def test_03_cache_and_marketplaces_are_one_plugin(self):
        """同一插件在 cache/ 与 marketplaces/ 下各一份，应识别为同一个插件。"""
        dup = [s for s in self.default["skills"] if s["name"] == "dup-tool"]
        self.assertEqual(len(dup), 2)
        self.assertEqual(len({s["namespace"] for s in dup}), 1,
                         "两个副本必须解析出同一个插件名")
        self.assertEqual(len({s["plugin_key"] for s in dup}), 1)
        conf = [c for c in self.default["conflicts"] if c["name"] == "dup-tool"]
        self.assertTrue(conf, "同插件的两份副本应作为 redundant 出现")
        self.assertEqual(conf[0]["kind"], "redundant")
        self.assertEqual(conf[0]["severity"], "low",
                         "同一插件的两份拷贝是低危提示，不是需要处理的冲突")

    # ── 4 ────────────────────────────────────────────────
    def test_04_cited_sorts_but_never_acquits(self):
        """加 'For example,' 或一个不闭合引号，都不得让 critical 静默。"""
        for n in ("ev-plain", "ev-example", "ev-quote"):
            self.assertEqual(self.by[n]["security"]["max_severity"], "critical",
                             "%s 的权威严重度不得被引用启发式降级" % n)
        for n in ("ev-example", "ev-quote"):
            self.assertEqual(self.by[n]["security"]["max_severity_uncited"], "none",
                             "%s 应被标为疑似引用语境（只影响排序）" % n)
        flagged = {f["name"] for f in self.default["security"]["flagged"]}
        for n in ("ev-plain", "ev-example", "ev-quote"):
            self.assertIn(n, flagged, "%s 必须出现在 flagged 列表里" % n)

    # ── 5 ────────────────────────────────────────────────
    def test_05_self_exclusion_field_exists(self):
        """扫描器自身排除安全扫描。

        **语料无法覆盖这条** —— fixture 里的 skill 按定义不是扫描器自身。
        真正的覆盖在 test_regressions.TestScannerExcludesItself，那条依赖
        本仓库被装在扫描根下。这里只钉住字段契约：其余 skill 一律不带该标记，
        以免移植时把 self_excluded 默认成 True 而静默关掉全部安全扫描。
        """
        for s in self.default["skills"]:
            self.assertNotEqual(s["security"].get("self_excluded"), True,
                                "%s 不是扫描器自身，不得被排除" % s["name"])

    # ── 6 ────────────────────────────────────────────────
    def test_06_split_criterion_is_tokens_not_lines(self):
        """按行数判会把结论给反：901 行的比 201 行的便宜 44 倍。"""
        sparse, dense = self.by["sparse-long"], self.by["dense-core"]
        self.assertGreater(sparse["body_lines"], dense["body_lines"],
                           "语料前提：稀疏文件行数更多")
        self.assertLess(sparse["tier2_core_tokens"], dense["tier2_core_tokens"],
                        "语料前提：稀疏文件 token 更少")
        over = [o["name"] for o in self.default["structure"]["oversized"]]
        self.assertIn("dense-core", over)
        self.assertNotIn("sparse-long", over, "行多但 token 少，不该建议拆分")
        self.assertIn("tier2_core_tokens", self.default["structure"]["criterion"])

    # ── 7 ────────────────────────────────────────────────
    def test_07_repo_metadata_not_counted(self):
        """README / LICENSE / CHANGELOG 是给人看的，不是触发时载入的成本。"""
        s = self.by["with-readme"]
        self.assertEqual(s["tier2_refs_tokens"], 0,
                         "20k 字符的 README 不得计入 tier2")
        self.assertGreater(s["bundled_bytes"], 20000, "但字节数仍要如实统计")

    # ── 8 ────────────────────────────────────────────────
    def test_08_subdir_markdown_is_data_corpus(self):
        """子目录 .md 只记字节。否则带文章库的 skill 报出天文数字 token。"""
        corpus = self.by["with-corpus"]
        self.assertEqual(corpus["tier2_refs_tokens"], 0,
                         "articles/ 下的 .md 不得计入 tier2")
        self.assertGreater(corpus["data_corpus_bytes"], 1_000_000)
        self.assertEqual(corpus["data_corpus_files"], 3)
        refs = self.by["with-refs"]
        self.assertGreater(refs["tier2_refs_tokens"], 0,
                           "references/ 与 docs/ 下的 .md 必须计入")
        self.assertEqual(refs["tier2_refs_files"], 3,
                         "references/ + docs/ + 与 SKILL.md 同级，三处都要算")

    # ── 9 ────────────────────────────────────────────────
    def test_09_zero_triggers_needs_age_gate(self):
        """零触发只有在装够天数后才说明问题。否则用户会删掉昨天刚装的。"""
        d, z = self.cc["trigger_data"], self.zombie0["trigger_data"]
        self.assertEqual(len(d["zombie_candidates"]), 0,
                         "新建语料一律未达年龄闸，不得进僵尸表")
        self.assertGreater(len(d["too_new_to_judge"]), 0)
        self.assertGreater(len(z["zombie_candidates"]), 0,
                           "--zombie-age 0 时才允许进僵尸表")
        self.assertEqual(len(z["too_new_to_judge"]), 0)
        self.assertEqual(d["zombie_min_age_days"], 14)

    # ── 10 ───────────────────────────────────────────────
    def test_10_override_precedence(self):
        """enterprise > personal > project > plugin。personal 盖 project 反直觉。"""
        by = {c["name"]: c for c in self.default["conflicts"]}
        self.assertEqual(by["dup-shadowed"]["kind"], "shadowed_newer")
        self.assertEqual(by["dup-shadowed"]["severity"], "high",
                         "更新的版本被旧版本静默盖掉，是高危")
        self.assertEqual(by["dup-override"]["kind"], "intentional_override")
        self.assertEqual(by["dup-override"]["severity"], "medium")
        self.assertEqual(by["dup-identical"]["kind"], "redundant")
        self.assertEqual(by["dup-identical"]["severity"], "low")
        for n in ("dup-shadowed", "dup-override"):
            self.assertEqual(by[n]["effective"]["level"], "personal",
                             "personal 必须盖过 project")
        self.assertEqual(by["dup-identical"]["effective"]["level"], "enterprise",
                         "enterprise 必须盖过 personal")

    # ── 11 ───────────────────────────────────────────────
    def test_11_redaction_reaches_paths_and_free_text(self):
        """三次真实泄露：名字残留在 path、description 清不干净、插件名整片漏。"""
        raw = json.dumps(self.redacted, ensure_ascii=False)
        for n in ("alpha", "dense-core", "dup-shadowed", "with-corpus",
                  "p1-tool", "access", "codex-only"):
            self.assertNotIn(n, raw, "真名 %s 不得出现在任何字段（含 path）" % n)
        for s in self.redacted["skills"]:
            self.assertTrue(s["description"].startswith("<redacted:"),
                            "description 必须整体丢弃而非模式清洗")
        self.assertTrue(self.redacted["redacted"]["names"])

    def test_11c_plugin_and_marketplace_names_are_redacted(self):
        """第三次泄露：插件名与 marketplace 名从来不在收集白名单里。

        它们出现在 namespace / plugin_key / enabled_plugins / usage_key_matched，
        而 `collect()` 只认 name / dir_name / skill。内部 marketplace 往往就叫
        公司名或团队名，泄露程度不亚于 skill 名。
        """
        raw = json.dumps(self.redacted, ensure_ascii=False)
        for n in ("plug-one", "plug-two", "plug-three", "plug-dup", "plug-off",
                  "mkt-a", "mkt-b"):
            self.assertNotIn(n, raw, "插件/marketplace 名 %s 泄露了" % n)
        for s in self.redacted["skills"]:
            if s.get("namespace"):
                self.assertRegex(s["namespace"], r"^plugin-\d+$")
            if s.get("plugin_key"):
                self.assertRegex(s["plugin_key"], r"^plugin-\d+@market-\d+$")
        for k in self.redacted["plugin_state"]["enabled_plugins"]:
            self.assertRegex(k, r"^plugin-\d+@market-\d+$")

    def test_11d_unreadable_entries_are_redacted_too(self):
        """`unreadable_skills` 的名字来自目录名，且不在 skills[] 里。

        与 `removed_skills` 同一个失效模式：只从 skills[] 收集就会漏掉。
        语料里没有不可读项（会因 root 与否而变），这里只钉字段存在性与形状。
        """
        self.assertIn("unreadable_skills", self.default,
                      "读不了的 skill 必须显式出现，不得静默丢弃")
        self.assertIsInstance(self.default["unreadable_skills"], list)
        for e in self.redacted["unreadable_skills"]:
            self.assertRegex(e["name"], r"^skill-\d+$")

    def test_11b_statistics_survive_redaction(self):
        """脱敏不得让报告失去可用性 —— 所有统计量必须逐一相同。"""
        d, r = self.default, self.redacted
        for k in ("total_skills_on_disk", "loaded_skills", "unique_skills",
                  "tier1_total_tokens"):
            self.assertEqual(d[k], r[k], "%s 在脱敏后改变了" % k)
        self.assertEqual(d["description_budget"]["used_chars"],
                         r["description_budget"]["used_chars"])
        self.assertEqual(len(d["conflicts"]), len(r["conflicts"]))
        self.assertEqual(d["security"]["flagged_count"],
                         r["security"]["flagged_count"])

    # ── 12 ───────────────────────────────────────────────
    def test_12_missing_harness_data_reports_unavailable(self):
        """拿不到就报 unavailable，绝不用装机时间或 mtime 代替触发数。"""
        n = self.nocfg
        self.assertFalse(n["plugin_state"]["harness_config_read"])
        self.assertFalse(n["trigger_data"]["available"])
        self.assertEqual(n["plugin_state"]["enabled_plugins"], [],
                         "读不到配置时不得凭空给出启用列表")
        self.assertGreater(n["total_skills_on_disk"], 0,
                           "缺配置不得让整次扫描失败 —— 曾经会 TypeError 崩掉")
        plugins = [s for s in n["skills"] if s["level"] == "plugin"]
        self.assertTrue(plugins)
        for s in plugins:
            self.assertFalse(s["loaded"])
            self.assertEqual(s["loaded_reason"], "plugin-state-unknown",
                             "理由必须是「判定不了」，不能写成「没启用」")
        for s in n["skills"]:
            self.assertEqual(s["usage_count"], 0)
            self.assertIsNone(s["usage_key_matched"],
                              "没有触发数据时不得伪造匹配键")

    def test_12b_available_flag_is_true_when_data_exists(self):
        """反向：有数据时必须报 available，否则降级逻辑写反了也测不出来。"""
        self.assertTrue(self.cc["trigger_data"]["available"])
        self.assertTrue(self.cc["plugin_state"]["harness_config_read"])
        used = [s for s in self.cc["skills"] if s["usage_count"] > 0]
        self.assertTrue(used, "语料里应有带触发数的 skill")


if __name__ == "__main__":
    unittest.main(verbosity=2)
