#!/usr/bin/env python3
"""纯函数特征测试（ENGINEERING.md §4.4 第 2 层）。

与 `test_regressions.py` 的分工：

  回归测试   —— 每个用例对应一次真实事故，证明「旧缺陷没回来」
  **特征测试** —— 把当前行为**原样钉住**，证明「移植后行为没变」

§4.1 点名这批函数「完全无测试」：`est_tokens` 具体数值、`parse_frontmatter`
的续行 / 引号 / 值含冒号、`plugin_identity` 三种路径形态、`lookup_usage`
裸名回退、`diff_against` 整个函数。移植会均匀地打击所有地方，而回归测试
只覆盖出过事的地方——中间这段空白就是这个文件。

**这里的每个期望值都是 Rust 侧 `#[cfg(test)]` 要对齐的目标。**
断言的是具体数值而非范围：`est_tokens("hello") == 1`，不是 `> 0`。
范围断言在移植时毫无用处。

跑法：
    python3 -m unittest tests.test_characterization -v
"""

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

_spec = importlib.util.spec_from_file_location("scan", ROOT / "scripts" / "scan.py")
scan = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(scan)

sys.path.insert(0, str(ROOT / "packages" / "agent-vitals-python"))
from agent_vitals.util import split_lines  # noqa: E402
from agent_vitals.util import fork_boundary, post_fork  # noqa: E402
from agent_vitals.usage import (  # noqa: E402
    context_composition, dsh_usage_observations, hour_buckets, request_metrics,
    token_by_date_model, token_by_model, usage_signal_status, usage_shaped_tokens,
)
from agent_vitals.compaction import compaction_events  # noqa: E402
from agent_vitals.waste import detect_duplicate_tool_results, detect_failure_run_waste, detect_structural_waste  # noqa: E402
from agent_vitals.util import est_tokens, signal_coverage  # noqa: E402
from agent_vitals.behavior import (  # noqa: E402
    match_behavior, match_behavior_gated, trajectory_rule_outcomes, array_signal_status,
    waste_coverage,
)
from agent_vitals.trajectory import match_trajectory  # noqa: E402
from agent_vitals.skill import skill_invocations  # noqa: E402
from agent_vitals.duration import (  # noqa: E402
    tool_call_durations, turn_durations, step_durations, approval_latencies, hook_executions,
    duration_coverage,
)
from agent_vitals.codex_evidence import codex_evidence_json, derive_coverage  # noqa: E402
from agent_vitals.codex_usage import (  # noqa: E402
    CODEX_TOKEN_FIELDS, codex_aggregate_hours, codex_by_model_from_hours,
    codex_day_tokens, unaccounted_tokens_seen,
    codex_fold_file, codex_merge_folds, codex_token_facts,
)
from agent_vitals.codex_cost import (  # noqa: E402
    codex_cost_report, load_codex_pricing, render_codex_cost,
    _reset_beijing_text_at,
)
from agent_vitals.adapters.codex_session import (  # noqa: E402
    codex_rollout_files, codex_session_roots_report, parse_codex_session_log,
    parse_session_index, read_codex_session_log, read_session_index,
)


class TestEstTokens(unittest.TestCase):
    """int(cjk * 0.6 + other * 0.3)。CJK 判据是 U+4E00..U+9FFF。

    比例是 DeepSeek 官方换算（中文 0.6 token/字符、其余 0.3 token/字符）——
    2026-08-21 从旧比例（cjk/1.5 + other/4，来源不可考）换过来的：拿真实会话
    550 段 assistant 输出比对 provider 实际 outputTokens，旧比例系统性低估
    22.2%，官方比例低估 8.8%，明显更准（但仍是估算，DeepSeek 自己的文档也写
    "以接口返回为准"）。这里的期望值是按新比例重新算的，不是从旧数字改的——
    比例变了，"看起来差不多"式的手改容易把截断边界改错。

    移植清单第 5 条：`"一" <= ch <= "鿿"` 语义简单但边界易写错。
    下面的边界用例就是为了让写错的版本立刻红。
    """

    def test_empty_is_zero(self):
        self.assertEqual(scan.est_tokens(""), 0)
        self.assertEqual(scan.est_tokens(None or ""), 0)

    def test_other_chars_times_zero_point_three_and_truncates(self):
        self.assertEqual(scan.est_tokens("hello"), 1)        # 5*0.3 = 1.5 → 1
        self.assertEqual(scan.est_tokens("x" * 4), 1)        # 4*0.3 = 1.2 → 1
        self.assertEqual(scan.est_tokens("x" * 3), 0)        # 3*0.3 = 0.9 → 0，向下取整不是四舍五入
        self.assertEqual(scan.est_tokens("x" * 400), 120)    # 400*0.3 = 120

    def test_cjk_chars_times_zero_point_six(self):
        self.assertEqual(scan.est_tokens("中文"), 1)          # 2*0.6 = 1.2 → 1
        self.assertEqual(scan.est_tokens("中" * 3), 1)        # 3*0.6 = 1.8 → 1
        self.assertEqual(scan.est_tokens("中" * 150), 90)     # 150*0.6 = 90

    def test_mixed(self):
        # 中,文 = CJK；「，」是 U+FF0C，**不在** U+4E00..U+9FFF 内，算 other
        # 2*0.6 + 8*0.3 = 1.2 + 2.4 = 3.6 → 3
        self.assertEqual(scan.est_tokens("中文，English"), 3)

    def test_cjk_range_boundaries(self):
        """区间端点与两侧各一个字符。写成 < 而非 <= 会在这里露馅。"""
        self.assertEqual(scan.est_tokens("一" * 3), 1)   # 下界，含；3*0.6=1.8→1
        self.assertEqual(scan.est_tokens("鿿" * 3), 1)   # 上界，含
        self.assertEqual(scan.est_tokens("䷿" * 3), 0)   # 下界前一个 → other，3*0.3=0.9→0
        self.assertEqual(scan.est_tokens("ꀀ" * 3), 0)   # 上界后一个 → other
        self.assertEqual(scan.est_tokens("㐀" * 3), 0)   # 扩展 A 区不算 CJK
        self.assertEqual(scan.est_tokens("\U00020000" * 3), 0)  # 扩展 B 区不算

    def test_never_negative_and_no_panic_on_unicode(self):
        """属性测试第 2 条的用例版：任意 Unicode 不炸、非负。"""
        for s in ("\U0001f600" * 10, "\x00\x01\x02", "á̂",
                  "\ud83d", "🇨🇳🇺🇸", "\n\r\t"):
            self.assertGreaterEqual(scan.est_tokens(s), 0)


class TestSafeStrHandlesSurrogates(unittest.TestCase):
    """非 UTF-8 的**文件名**经 os.fsdecode 会变成孤立代理字符。

    这类字符 json.dumps 能产出，写文件时却抛 UnicodeEncodeError ——
    **整次扫描中断**。CI 的 Linux job 抓到过一次真崩溃；macOS 的 APFS
    拒绝非 UTF-8 文件名，本地永远撞不出。

    这里直接喂代理字符，不依赖文件系统，因此在任何平台都能跑。
    """

    def test_lone_surrogate_becomes_replacement_char(self):
        self.assertEqual(scan.safe_str("a\udcffb"), "a\ufffdb")

    def test_result_is_always_utf8_encodable(self):
        """这是它存在的唯一理由：结果必须能写进 UTF-8 文件。"""
        for s in ("\udcff", "x\udc80\udcfey", "\udcff" * 10, "正常中文"):
            scan.safe_str(s).encode("utf-8")  # 不抛异常即通过

    def test_plain_text_is_untouched(self):
        for s in ("hello", "中文混排 English", "", "emoji 😀"):
            self.assertEqual(scan.safe_str(s), s)

    def test_matches_rust_from_utf8_lossy(self):
        """两个实现必须给出同一个 U+FFFD 数量，否则 path 字段会分叉。

        Rust 的 from_utf8_lossy 按「极大子序列」replace，Python 这里
        先按 surrogateescape 还原字节再 replace 解码 —— 等价。
        """
        raw = b"bad-\xff\xfe-name"
        py = scan.safe_str(raw.decode("utf-8", "surrogateescape"))
        self.assertEqual(py, raw.decode("utf-8", "replace"))


class TestSplitLines(unittest.TestCase):
    """`agent_vitals.util.split_lines` 是给 Rust `util::split_lines`（其自身
    测试就叫 `split_lines_matches_python`）对齐的 Python 侧目标——两边都只认
    `\\n` / `\\r\\n` / `\\r` 三种真正的换行，不认 `str.splitlines()` 额外识别
    的那批 Unicode 段落/换行符。"""

    def test_matches_rust_ascii_cases(self):
        """与 src/util.rs 的 split_lines_matches_python 逐字节同源。"""
        self.assertEqual(split_lines("a\nb"), ["a", "b"])
        self.assertEqual(split_lines("a\nb\n"), ["a", "b"])
        self.assertEqual(split_lines("a\r\nb\r"), ["a", "b"])
        self.assertEqual(split_lines(""), [])

    def test_keeps_unicode_line_separators_inside_the_line(self):
        """真实回归的核心断言：U+2028/U+0085 等字符合法出现在 JSON 字符串值
        里，不是记录分隔符——split_lines 必须把它们留在原来的行里，
        str.splitlines() 会把它们切成新的一行（这正是缺陷所在）。"""
        for ch in (" ", " ", "\x85", "\x0b", "\x0c", "\x1c", "\x1d", "\x1e"):
            s = "a" + ch + "b\nc"
            self.assertEqual(split_lines(s), ["a" + ch + "b", "c"],
                             "char %r should stay inside its line" % ch)
            # 对照：str.splitlines() 恰恰会在这些字符处断行——这就是被替换掉的行为。
            self.assertEqual(s.splitlines(), ["a", "b", "c"])

    def test_loses_nothing_but_terminators(self):
        """与 Rust 的 split_lines_loses_nothing_but_terminators 属性测试同一条
        不变式：拼回去只丢 \\n / \\r，其余字符原样保留。"""
        s = "line1\r\nline2\rline3\nline4 still-line4"
        self.assertEqual("".join(split_lines(s)),
                         s.replace("\n", "").replace("\r", ""))


class TestParseFrontmatter(unittest.TestCase):
    """不依赖 yaml 库的手写解析器，边界全在这里。"""

    def test_no_frontmatter_returns_whole_text_as_body(self):
        fm, raw, body = scan.parse_frontmatter("just a body\n")
        self.assertEqual(fm, {})
        self.assertEqual(raw, "")
        self.assertEqual(body, "just a body\n")

    def test_basic_and_blank_line_after_frontmatter_is_consumed(self):
        """闭合 `---` 之后的 `\\s*\\n?` 会把紧跟的空行一起吃掉。

        body 从 "body" 开始，不是从 "\\n" 开始。这不是笔误而是真实行为，
        且**有后果**：`body_lines` 与 `tier2_core_tokens` 都由 body 算出，
        移植时把这段正则写松或写紧，两个数都会跟着偏。
        """
        fm, raw, body = scan.parse_frontmatter(
            "---\nname: a\ndescription: d\n---\n\nbody\n")
        self.assertEqual(fm, {"name": "a", "description": "d"})
        self.assertEqual(raw, "name: a\ndescription: d")
        self.assertEqual(body, "body\n")

    def test_many_blank_lines_after_frontmatter_all_consumed(self):
        _, _, body = scan.parse_frontmatter("---\nname: a\n---\n\n\n\nbody\n")
        self.assertEqual(body, "body\n")

    def test_quotes_are_stripped_both_kinds(self):
        fm, _, _ = scan.parse_frontmatter(
            "---\nname: 'a'\ndescription: \"d\"\n---\n")
        self.assertEqual(fm["name"], "a")
        self.assertEqual(fm["description"], "d")

    def test_value_containing_colons_keeps_everything_after_first(self):
        """partition(':') 只切第一个冒号，右边整段原样保留。"""
        fm, _, _ = scan.parse_frontmatter("---\nk: value: with: colons\n---\n")
        self.assertEqual(fm["k"], "value: with: colons")

    def test_quoted_value_with_inner_colon(self):
        fm, _, _ = scan.parse_frontmatter(
            "---\ndescription: 'Quoted: with a colon inside'\n---\n")
        self.assertEqual(fm["description"], "Quoted: with a colon inside")

    def test_continuation_line_joins_with_single_space(self):
        """缩进行并入上一个 key，用一个空格连接（不是换行）。"""
        fm, _, _ = scan.parse_frontmatter(
            "---\ndescription: first\n  second line\n    third\n---\n")
        self.assertEqual(fm["description"], "first second line third")

    def test_continuation_without_preceding_key_is_dropped(self):
        fm, _, _ = scan.parse_frontmatter("---\n  orphan\nname: a\n---\n")
        self.assertEqual(fm, {"name": "a"})

    def test_line_without_colon_is_ignored(self):
        fm, _, _ = scan.parse_frontmatter("---\nname: a\nbare-line\n---\n")
        self.assertEqual(fm, {"name": "a"})

    def test_crlf(self):
        """`^---\\s*\\n` 里的 \\s* 吃掉 \\r，所以 CRLF 能解析。"""
        fm, _, body = scan.parse_frontmatter(
            "---\r\nname: a\r\ndescription: d\r\n---\r\n\r\nbody\r\n")
        self.assertEqual(fm["name"], "a")
        self.assertEqual(fm["description"], "d")
        self.assertEqual(body, "body\r\n", "\\r 也被 \\s* 吃掉")

    def test_unclosed_frontmatter_is_all_body(self):
        """截断的 frontmatter 不算 frontmatter，整篇算正文。"""
        fm, raw, body = scan.parse_frontmatter("---\nname: a\n\nbody\n")
        self.assertEqual(fm, {})
        self.assertEqual(raw, "")
        self.assertTrue(body.startswith("---"))

    def test_duplicate_key_last_wins(self):
        fm, _, _ = scan.parse_frontmatter("---\nname: a\nname: b\n---\n")
        self.assertEqual(fm["name"], "b")


class TestPluginIdentity(unittest.TestCase):
    """三种真实存在的插件路径形态。返回 (插件名, marketplace)。"""

    def test_cache_form(self):
        self.assertEqual(
            scan.plugin_identity("/h/.claude/plugins/cache/mkt/plug/unknown/skills/s"),
            ("plug", "mkt"))

    def test_marketplaces_plugins_form(self):
        self.assertEqual(
            scan.plugin_identity("/h/.claude/plugins/marketplaces/mkt/plugins/plug/skills/s"),
            ("plug", "mkt"))

    def test_marketplaces_external_plugins_form(self):
        self.assertEqual(
            scan.plugin_identity(
                "/h/.claude/plugins/marketplaces/mkt/external_plugins/plug/skills/s"),
            ("plug", "mkt"))

    def test_non_plugin_path(self):
        self.assertEqual(scan.plugin_identity("/h/.claude/skills/s"), (None, None))

    def test_wrapper_dirs_are_stripped_and_last_segment_wins(self):
        """plugins / external_plugins / unknown / skills 是包装层，不是插件名。"""
        self.assertEqual(
            scan.plugin_identity("/h/plugins/cache/mkt/a/b/unknown/skills/s"),
            ("b", "mkt"))

    def test_falls_back_to_marketplace_when_middle_is_all_wrappers(self):
        self.assertEqual(
            scan.plugin_identity("/h/plugins/cache/mkt/unknown/skills/s"),
            ("mkt", "mkt"))

    def test_trailing_slash_is_appended_internally(self):
        """PLUGIN_PATH_RE 要求 /skills/，所以以 skills 结尾的路径也要能匹配。"""
        self.assertEqual(
            scan.plugin_identity("/h/plugins/cache/mkt/plug/unknown/skills"),
            ("plug", "mkt"))

    def test_version_directory_is_not_the_plugin_name(self):
        """WorkBuddy 的缓存把版本号放在 Claude Code 放 `unknown` 的那一格。

        原来取末段，于是命名空间成了 `1.0.0`：两个**不同的包**只要版本号
        相同就落进同一个命名空间，各自的同名 skill 会被判成冲突 —— 凭空
        报一个不存在的问题，而这正是本工具最不该犯的错。
        """
        for version in ("1.0.0", "2.0.0", "v20260727", "0.1.1784877812", "7"):
            with self.subTest(version=version):
                self.assertEqual(
                    scan.plugin_identity(
                        "/h/.workbuddy/plugins/cache/wb/pkg/%s/skills/s" % version),
                    ("pkg", "wb"))

    def test_version_like_plugin_name_survives(self):
        """整段都像版本号时**留一个**：宁可要个怪名字，也不要空命名空间。"""
        self.assertEqual(
            scan.plugin_identity("/h/plugins/cache/mkt/1.0.0/skills/s"),
            ("1.0.0", "mkt"))

    def test_non_version_suffix_is_kept(self):
        """只丢像版本号的末段。`plug/beta` 里的 beta 不是版本号，照旧取末段。"""
        self.assertEqual(
            scan.plugin_identity("/h/plugins/cache/mkt/plug/beta/skills/s"),
            ("beta", "mkt"))


class TestLookupUsage(unittest.TestCase):
    """skillUsage 的键可能是裸名，也可能是 `<plugin>:<skill>`。"""

    def test_namespaced_key_preferred_over_bare(self):
        usage = {"tool": {"usageCount": 1}, "plug:tool": {"usageCount": 9}}
        self.assertEqual(scan.lookup_usage(usage, "tool", "plug"),
                         (9, None, "plug:tool"))

    def test_bare_fallback_when_namespaced_missing(self):
        """已知的精度上限：裸名回退可能撞上同名的其他 skill。"""
        usage = {"tool": {"usageCount": 4}}
        self.assertEqual(scan.lookup_usage(usage, "tool", "plug"),
                         (4, None, "tool"))

    def test_plain_integer_form(self):
        self.assertEqual(scan.lookup_usage({"tool": 7}, "tool", None),
                         (7, None, "tool"))

    def test_last_used_at_passed_through(self):
        usage = {"tool": {"usageCount": 2, "lastUsedAt": 1700000000000}}
        self.assertEqual(scan.lookup_usage(usage, "tool", None),
                         (2, 1700000000000, "tool"))

    def test_missing_returns_zero_and_none_key(self):
        """没记录时匹配键必须是 None —— 不得伪造成匹配上了。"""
        self.assertEqual(scan.lookup_usage({}, "tool", None), (0, None, None))

    def test_usage_count_absent_or_null_becomes_zero(self):
        self.assertEqual(scan.lookup_usage({"t": {}}, "t", None)[0], 0)
        self.assertEqual(scan.lookup_usage({"t": {"usageCount": None}}, "t", None)[0], 0)

    def test_unexpected_value_type_is_skipped(self):
        """字符串等意外类型既不算命中也不能崩。"""
        self.assertEqual(scan.lookup_usage({"t": "nope"}, "t", None),
                         (0, None, None))


class TestIsCited(unittest.TestCase):
    """启发式：命中点看起来是否在引用/举例语境里。只排序，不裁决。"""

    def test_not_found_in_line(self):
        self.assertFalse(scan.is_cited("unrelated line", "payload"))

    def test_unbalanced_double_quote_before_match(self):
        self.assertTrue(scan.is_cited('say "hello payload', "payload"))

    def test_balanced_quotes_do_not_trigger(self):
        self.assertFalse(scan.is_cited('say "hi" then payload', "payload"))

    def test_cjk_open_quote(self):
        for q in ("“", "「", "『"):
            self.assertTrue(scan.is_cited("%s payload" % q, "payload"))

    def test_citation_hint_anywhere_in_line(self):
        self.assertTrue(scan.is_cited("For example, payload", "payload"))

    def test_backtick_counts_as_quote(self):
        self.assertTrue(scan.is_cited("run `payload", "payload"))


class TestDaysSince(unittest.TestCase):
    def test_none_and_zero_return_none(self):
        """0 也返回 None —— `if not ms` 把 0 当成缺失。移植时容易写成只判 null。"""
        self.assertIsNone(scan.days_since(None))
        self.assertIsNone(scan.days_since(0))

    def test_rounds_to_one_decimal(self):
        import time
        v = scan.days_since((time.time() - 86400 * 3) * 1000)
        self.assertAlmostEqual(v, 3.0, places=1)


class TestLevelRank(unittest.TestCase):
    """A6：`level_rank` 从标量改成 `(layer, rank)` 二维键，前五执行环境必须原样。

    DSH 是二维覆盖（先 scope 层、后层内 rank），所以 rank 键要带一层；但前
    五个执行环境只有一个隐式层，`layer` 必须恒 0、`rank` 必须是原标量 —— 这是
    golden 12/12 逐字节一致的前提。这里直接钉住返回值，而不只钉下游排序。
    """

    def test_five_harnesses_layer_is_always_zero(self):
        for family in ("claude-code", "codex", "openclaw", "hermes",
                       "workbuddy", "unknown"):
            for level in ("enterprise", "personal", "project", "plugin",
                          "workspace", "managed", "other-harness", "unknown", ""):
                with self.subTest(family=family, level=level):
                    out = scan.level_rank({"harness_family": family, "level": level})
                    self.assertEqual(out[0], 0)
                    self.assertIsInstance(out[1], int)

    def test_claude_code_scalar_unchanged(self):
        self.assertEqual(
            scan.level_rank({"harness_family": "claude-code", "level": "enterprise"}),
            (0, 0))
        self.assertEqual(
            scan.level_rank({"harness_family": "claude-code", "level": "personal"}),
            (0, 1))
        self.assertEqual(
            scan.level_rank({"harness_family": "claude-code", "level": "project"}),
            (0, 2))
        self.assertEqual(
            scan.level_rank({"harness_family": "claude-code", "level": "plugin"}),
            (0, 3))
        self.assertEqual(
            scan.level_rank({"harness_family": "claude-code", "level": "other-harness"}),
            (0, 8))
        self.assertEqual(
            scan.level_rank({"harness_family": "claude-code", "level": "unknown"}),
            (0, 9))

    def test_openclaw_scalar_unchanged(self):
        self.assertEqual(
            scan.level_rank({"harness_family": "openclaw", "level": "workspace"}),
            (0, 0))
        self.assertEqual(
            scan.level_rank({"harness_family": "openclaw", "level": "project"}),
            (0, 1))
        self.assertEqual(
            scan.level_rank({"harness_family": "openclaw", "level": "personal"}),
            (0, 2))
        self.assertEqual(
            scan.level_rank({"harness_family": "openclaw", "level": "managed"}),
            (0, 3))

    def test_harness_fallback_via_legacy_harness_field(self):
        # level_rank 也能从旧字段 harness 取 family（compat 公开面不变）。
        self.assertEqual(
            scan.level_rank({"harness": "claude-code", "level": "project"}), (0, 2))

    def test_dsh_is_two_dimensional(self):
        """DSH 分支返回二维键，层序与层内 rank 各占一位，不再退化成标量。"""
        out = scan.level_rank({
            "harness_family": "dsh", "level": "project-dsh",
            "conflict_domain": "dsh:/home/u/.dsh:agent-main",
        })
        self.assertEqual(len(out), 2)
        self.assertIsInstance(out[0], int)
        self.assertEqual(out[1], 100)


class TestRedactPureBehaviour(unittest.TestCase):
    """脱敏的字符串替换规则。移植清单第 1 条：`regex` crate 不支持 lookbehind。

    这些用例定义了那个正则**必须保持**的行为，替换实现（捕获组或
    fancy-regex）拿它们验收。
    """

    def setUp(self):
        self._home, self._cwd = scan.HOME_N, scan.CWD_N
        scan.HOME_N, scan.CWD_N = "/home/alice", "/work/proj"

    def tearDown(self):
        scan.HOME_N, scan.CWD_N = self._home, self._cwd

    def test_home_and_cwd_replaced(self):
        out = scan.redact({"path": "/home/alice/.claude/skills/x"})
        self.assertEqual(out["path"], "~/.claude/skills/x")
        self.assertEqual(scan.redact({"p": "/work/proj/a"})["p"], "./a")

    def test_username_only_replaced_as_a_whole_path_segment(self):
        """lookbehind/lookahead 的全部意义：alice 是路径段才换，是子串不换。"""
        out = scan.redact({"a": "/data/alice/x", "b": "/data/alicexyz/x",
                           "c": "/data/xyzalice/x", "d": "/data/alice"})
        self.assertEqual(out["a"], "/data/<user>/x")
        self.assertEqual(out["b"], "/data/alicexyz/x", "前缀匹配不得替换")
        self.assertEqual(out["c"], "/data/xyzalice/x", "后缀匹配不得替换")
        self.assertEqual(out["d"], "/data/<user>", "行尾的路径段要替换")

    def test_username_match_is_case_insensitive(self):
        self.assertEqual(scan.redact({"p": "/data/ALICE/x"})["p"], "/data/<user>/x")

    def test_backslash_separators_also_handled(self):
        self.assertEqual(scan.redact({"p": r"\data\alice\x"})["p"], r"\data\<user>\x")

    def test_names_replaced_longest_first(self):
        """短名先替换会把长名切碎：`api` 先换掉，`api-client` 就成了 skill-001-client。"""
        obj = {"skills": [{"name": "api"}, {"name": "api-client"}],
               "note": "api-client uses api"}
        out = scan.redact(obj, names=True, name_map={})
        self.assertNotIn("api-client", json.dumps(out))
        aliases = {s["name"] for s in out["skills"]}
        self.assertEqual(len(aliases), 2, "两个名字必须映射到两个不同别名")

    def test_description_dropped_wholesale_not_pattern_cleaned(self):
        out = scan.redact({"description": "any free text"}, names=True, name_map={})
        self.assertEqual(out["description"], "<redacted: 13 chars>")

    def test_description_kept_when_names_not_redacted(self):
        out = scan.redact({"description": "any free text"})
        self.assertEqual(out["description"], "any free text")

    def test_numbers_and_bools_pass_through(self):
        out = scan.redact({"n": 5, "b": True, "z": None})
        self.assertEqual(out, {"n": 5, "b": True, "z": None})


class TestDiffAgainst(unittest.TestCase):
    """整个函数此前无测试。它是 `diff` 命令（PRODUCT §5.5）的全部实现。"""

    def _base(self, skills, budget=None, zombie_age=14):
        return {"skills": skills,
                "description_budget": budget or {"used_chars": 100, "pct_used": 1.0},
                "trigger_data": {"zombie_min_age_days": zombie_age},
                "security": {"flagged": []}}

    def _run(self, prev, now):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False,
                                         encoding="utf-8") as f:
            json.dump(prev, f)
            p = f.name
        try:
            return scan.diff_against(p, now)
        finally:
            Path(p).unlink()

    def test_unreadable_baseline_returns_error_not_crash(self):
        r = scan.diff_against("/nonexistent/nope.json", self._base([]))
        self.assertIn("error", r)

    def test_malformed_baseline_returns_error(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            f.write("{not json")
            p = f.name
        try:
            self.assertIn("error", scan.diff_against(p, self._base([])))
        finally:
            Path(p).unlink()

    def test_only_loaded_skills_are_compared(self):
        """磁盘≠上下文在 diff 里同样成立：未加载的不进对比。"""
        prev = self._base([{"name": "a", "loaded": True, "usage_count": 0}])
        now = self._base([{"name": "a", "loaded": True, "usage_count": 0},
                          {"name": "ghost", "loaded": False, "usage_count": 0}])
        r = self._run(prev, now)
        self.assertEqual(r["added_skills"], [])
        self.assertEqual(r["loaded_then_now"], [1, 1])

    def test_added_and_removed(self):
        """条目是**有名字段的 dict**，不是裸的复合键数组。

        方向一直是对的：同名 skill 在两个执行环境里不是同一个，比对必须带执行环境。
        错的是序列化形状 —— 曾经是 `[["claude-code", null, "", "b"]]`，而脱敏
        对列表元素继承父键，于是**执行环境名被当成 skill 名收录并全文替换**，
        report 里 harness_selection / harness_family / conflict_domain 全变成
        `skill-003`，而 harness_summaries 的键不受影响，同一份报告自相矛盾。

        改成 dict 之后每个字段各归各的键，`name` 仍然被脱敏（下面的
        TestRedaction 与 test_regressions 都依赖这一点）。
        """
        prev = self._base([{"name": "a", "loaded": True, "usage_count": 0}])
        now = self._base([{"name": "b", "loaded": True, "usage_count": 0}])
        r = self._run(prev, now)
        self.assertEqual(len(r["added_skills"]), 1)
        self.assertEqual(r["added_skills"][0]["name"], "b")
        self.assertEqual(set(r["added_skills"][0]),
                         {"harness", "instance_id", "namespace", "name"})
        self.assertEqual(len(r["removed_skills"]), 1)
        self.assertEqual(r["removed_skills"][0]["name"], "a")

    def test_usage_delta_sorted_descending_and_zero_delta_omitted(self):
        prev = self._base([{"name": "a", "loaded": True, "usage_count": 1},
                           {"name": "b", "loaded": True, "usage_count": 5},
                           {"name": "c", "loaded": True, "usage_count": 2}])
        now = self._base([{"name": "a", "loaded": True, "usage_count": 4},
                          {"name": "b", "loaded": True, "usage_count": 5},
                          {"name": "c", "loaded": True, "usage_count": 12}])
        r = self._run(prev, now)
        self.assertEqual([x["name"] for x in r["usage_delta"]], ["c", "a"])
        top = r["usage_delta"][0]
        # 只断言语义字段；harness / instance_id / namespace 是多执行环境定位用的
        self.assertEqual({k: top[k] for k in ("name", "delta", "now")},
                         {"name": "c", "delta": 10, "now": 12})

    def test_negative_delta_is_reported(self):
        """计数理论上只增，但执行环境重置过就会减。不能默默吞掉。"""
        prev = self._base([{"name": "a", "loaded": True, "usage_count": 9}])
        now = self._base([{"name": "a", "loaded": True, "usage_count": 2}])
        self.assertEqual(self._run(prev, now)["usage_delta"][0]["delta"], -7)

    def test_newly_judgeable_crosses_the_age_gate(self):
        """上次太新不能判、这次够岁数了 —— 这批才是新的僵尸判定对象。"""
        prev = self._base([{"name": "a", "loaded": True, "usage_count": 0,
                            "installed_days_ago": 3}])
        now = self._base([{"name": "a", "loaded": True, "usage_count": 0,
                           "installed_days_ago": 20}])
        r = self._run(prev, now)
        self.assertEqual(len(r["newly_judgeable"]), 1)
        self.assertEqual(r["newly_judgeable"][0]["verdict"], "zombie")

    def test_newly_judgeable_alive_when_used(self):
        prev = self._base([{"name": "a", "loaded": True, "usage_count": 0,
                            "installed_days_ago": 3}])
        now = self._base([{"name": "a", "loaded": True, "usage_count": 6,
                           "installed_days_ago": 20}])
        self.assertEqual(self._run(prev, now)["newly_judgeable"][0]["verdict"], "alive")

    def test_already_old_skill_is_not_newly_judgeable(self):
        prev = self._base([{"name": "a", "loaded": True, "usage_count": 0,
                            "installed_days_ago": 30}])
        now = self._base([{"name": "a", "loaded": True, "usage_count": 0,
                           "installed_days_ago": 44}])
        self.assertEqual(self._run(prev, now)["newly_judgeable"], [])

    def test_budget_delta(self):
        prev = self._base([], budget={"used_chars": 100, "pct_used": 1.0})
        now = self._base([], budget={"used_chars": 250, "pct_used": 2.5})
        r = self._run(prev, now)
        self.assertEqual(r["budget_delta_chars"], 150)
        self.assertEqual(r["budget_pct_then_now"], [1.0, 2.5])

    def test_new_security_findings_keyed_by_skill_rule_where_line(self):
        prev = self._base([])
        now = self._base([])
        now["security"]["flagged"] = [
            {"name": "s", "findings": [{"rule": "r1", "where": "SKILL.md", "line": 3},
                                       {"rule": "r2", "where": "SKILL.md", "line": 9}]}]
        prev["security"]["flagged"] = [
            {"name": "s", "findings": [{"rule": "r1", "where": "SKILL.md", "line": 3}]}]
        r = self._run(prev, now)
        self.assertEqual(r["new_security_findings"],
                         [{"skill": "s", "rule": "r2", "where": "SKILL.md", "line": 9}])

    def test_same_rule_at_new_line_counts_as_new(self):
        """行号进键：同一规则挪了位置算新发现。这是有意的保守取向。"""
        prev = self._base([])
        now = self._base([])
        prev["security"]["flagged"] = [
            {"name": "s", "findings": [{"rule": "r", "where": "SKILL.md", "line": 3}]}]
        now["security"]["flagged"] = [
            {"name": "s", "findings": [{"rule": "r", "where": "SKILL.md", "line": 4}]}]
        self.assertEqual(len(self._run(prev, now)["new_security_findings"]), 1)


class TestFindingCoords(unittest.TestCase):
    """finding 的 turn/step/call_id 三态。Rust 侧 `coords_own_then_carried_then_null` 对齐。

    三种情形在真实日志里都真实存在（session-e4b0be69 实测覆盖率）：

        tool/call         turn 786/786  step 786/786  callId 786/786  → 自带
        approval/asked    turn   0/2    step   0/2    callId   2/2    → turn/step 靠顺延
        sandbox/mode(seq=1)  三者全无，且在首个 turn 之前           → 全 null

    顺延不是猜：事件流按 seq 有序，turn/start 是权威边界。实测两对 approval
    事件都落在 turn 9 内，与顺延结果一致。
    """

    def _events(self):
        def ev(t, seq, data):
            return {"type": t, "seq": seq, "time": 1000 + seq, "data": data}
        return [
            ev("sandbox/mode", 1, {"mode": "danger-full-access"}),
            ev("turn/start", 2, {"turn": 9}),
            ev("step/start", 3, {"turn": 9, "step": 2}),
            ev("tool/call", 4, {"turn": 7, "step": 1, "callId": "call_own",
                                "name": "bash", "arguments": '{"command":"rm -rf /x"}'}),
            ev("approval/asked", 5, {"id": "a1", "toolName": "bash",
                                     "callId": "call_ask", "reason": "escalate"}),
            ev("turn/end", 6, {"turn": 9}),
            ev("tool/result", 7, {"message": "x",
                                  "error": {"name": "E", "code": "FS_SANDBOX_DENIED"}}),
        ]

    def _by_seq(self, seq):
        out = match_behavior(self._events())
        return next(f for f in out if f["seq"] == seq)

    def test_own_coords_win_over_carried(self):
        """事件自带的 turn 优先于顺延值（turn 7，不是当时活跃的 9）。"""
        f = self._by_seq(4)
        self.assertEqual((f["turn"], f["step"], f["call_id"]), (7, 1, "call_own"))

    def test_missing_coords_carried_from_boundary(self):
        """approval/asked 没有 turn/step，从 turn/start · step/start 顺延。"""
        f = self._by_seq(5)
        self.assertEqual((f["turn"], f["step"], f["call_id"]), (9, 2, "call_ask"))

    def test_before_first_turn_is_null(self):
        """首个 turn 之前的事件三者全 None——不臆造一个 turn。"""
        f = self._by_seq(1)
        self.assertEqual((f["turn"], f["step"], f["call_id"]), (None, None, None))

    def test_after_turn_end_is_cleared(self):
        """turn/end 之后清空，不把事件硬塞进刚结束的那个 turn。"""
        f = self._by_seq(7)
        self.assertEqual((f["turn"], f["step"]), (None, None))

    def test_trajectory_findings_share_the_same_key_order(self):
        """轨迹 finding 与单事件 finding 必须同构（11 键、键序一致）。

        两类 finding 追加进同一个数组，键序一旦分叉，diff/排序/渲染都会出问题。
        trajectory 侧用「先 None 占位、再按 seq 回填」正是为了保住键序——如果改成
        事后 insert，新键会排到末尾，这条就红。
        """
        def ev(t, seq, data):
            return {"type": t, "seq": seq, "time": 1000 + seq, "data": data}
        traj = match_trajectory([
            ev("tool/call", 1, {"name": "bash", "arguments": '{"command":"ls"}'}),
            ev("tool/call", 2, {"name": "bash", "arguments": '{"command":"ls"}'}),
            ev("tool/call", 3, {"name": "bash", "arguments": '{"command":"ls"}'}),
        ])
        self.assertTrue(traj, "fixture 应至少产出一条 SV611")
        behav = match_behavior(self._events())
        self.assertEqual(list(traj[0].keys()), list(behav[0].keys()))


class TestRuleOutcomes(unittest.TestCase):
    """P3 group①（docs/RUNTIME_EVIDENCE_CONTRACT.md §10）：14 条规则的三态结果。
    family ①（SV601–610）走前置门控 `match_behavior_gated`，family ④（SV611–
    614）走后置标注 `trajectory_rule_outcomes`。Rust 侧 `behavior.rs::
    match_behavior_canonical` / `trajectory_rule_outcomes` 的测试对齐——同一批
    断言。"""

    def _ev(self, etype, seq, data):
        return {"type": etype, "seq": seq, "time": 1000 + seq, "data": data}

    def test_each_rule_is_unavailable_when_its_required_signal_has_zero_coverage(self):
        _, family1 = match_behavior_gated([], None)
        trajectory = trajectory_rule_outcomes([], [])
        expected_missing = {
            "SV601": "ToolCalls", "SV602": "ToolCalls", "SV603": "ToolCalls",
            "SV604": "ToolCalls", "SV605": "ToolCalls", "SV606": "ToolCalls",
            "SV607": "ToolResults", "SV608": "ToolResults",
            "SV609": "ApprovalDecisions", "SV610": "SandboxModes",
            "SV611": "ToolCalls", "SV612": "TurnBoundaries",
        }
        for code, signal in expected_missing.items():
            outcomes = family1 if code in family1 else trajectory
            self.assertEqual(outcomes[code]["status"], "unavailable")
            self.assertIn(signal, outcomes[code]["missing"])
        # SV613/614 是"至少一个"语义——两个信号都全零覆盖时才 unavailable。
        for code in ("SV613", "SV614"):
            self.assertEqual(trajectory[code]["status"], "unavailable")

    def test_measured_zero_is_distinct_from_unavailable_for_the_same_rule(self):
        events = [self._ev("tool/call", 1, {"name": "bash", "arguments": "echo hi"})]
        _, family1 = match_behavior_gated(events, None)
        self.assertEqual(family1["SV601"], {"status": "measured_zero"})

    def test_findings_outcome_carries_the_count_for_that_rule_only(self):
        # family ① 的三态从门控后的真实 findings 数——rm -rf 命中 SV601 不命中
        # SV602，各归各的（不再手工喂 findings 数组，跟 Rust 侧同一批断言）。
        events = [self._ev("tool/call", 1, {"name": "bash", "arguments": "rm -rf /x"})]
        _, family1 = match_behavior_gated(events, None)
        self.assertEqual(family1["SV601"], {"status": "findings", "count": 1})
        # SV601 的 finding 不该被算进 SV602 的 outcome。
        self.assertEqual(family1["SV602"], {"status": "measured_zero"})

    def test_sv610_treats_approval_decisions_as_enhances_not_requires(self):
        # 用非触发 mode 让检测器跑完、零命中 → measured_zero，正好证明"能测、
        # 测了是零"而不是"缺 ApprovalDecisions 证据测不了"。danger-full-access
        # 会真出一条 SV610 finding（Findings 分支），不是本测试要问的问题。
        events = [self._ev("sandbox/mode", 1, {"mode": "normal"})]
        _, family1 = match_behavior_gated(events, None)
        self.assertEqual(family1["SV610"], {"status": "measured_zero"},
                         "SandboxModes 有覆盖时 SV610 不该因为 ApprovalDecisions 缺覆盖变成 unavailable")

    def test_approval_asked_alone_counts_toward_approval_decisions(self):
        """回归测试：只问过(approval/asked)、没等到 approval/decided——
        与 Rust dsh_evidence.rs 这次一起修的同一个 bug 对齐。ApprovalDecisions
        的证据包含 approval/asked，SV609 因此 available；SV609 对每次 asked
        都产出一条 finding，所以是 findings 而不是 unavailable。"""
        events = [self._ev("approval/asked", 1, {"id": "a1", "toolName": "bash"})]
        _, family1 = match_behavior_gated(events, None)
        self.assertEqual(family1["SV609"]["status"], "findings",
                         "approval/asked 覆盖了 ApprovalDecisions，SV609 不该 unavailable")
        self.assertEqual(family1["SV609"]["count"], 1)

    def test_sv610_unavailable_rule_never_leaks_a_finding(self):
        """分叉路径回归（phase B 的**唯一**有意行为修正）：有 approval/decided
        {allowed-once}、无 sandbox/mode——SV610 的 requires 只有 SandboxModes，
        前置门控下检测器不跑，findings 必须不含 SV610。旧实现后置标注会漏出
        这条 allowed-once，与 unavailable 自相矛盾。golden 语料里 SV610 恒
        available，此分叉不在 goldens，必须用回归钉住新语义。"""
        events = [
            self._ev("turn/start", 1, {"turn": 1}),
            self._ev("approval/decided", 2, {"id": "a1", "outcome": "allowed-once"}),
            self._ev("turn/end", 3, {"turn": 1}),
        ]
        findings, family1 = match_behavior_gated(events, None)
        self.assertNotIn("SV610", [f["rule"] for f in findings],
                         "unavailable 的规则绝不报出 finding")
        self.assertEqual(family1["SV610"]["status"], "unavailable")
        self.assertIn("SandboxModes", family1["SV610"]["missing"])

    def test_sv612_treats_toolcalls_as_enhances_not_requires(self):
        events = [self._ev("turn/start", 1, {"turn": 1})]
        outcomes = trajectory_rule_outcomes([], events)
        self.assertEqual(outcomes["SV612"], {"status": "measured_zero"},
                         "TurnBoundaries 有覆盖时 SV612 不该因为 ToolCalls 缺覆盖变成 unavailable")

    def test_sv613_is_available_when_only_one_of_its_two_signals_has_coverage(self):
        events = [self._ev("tool/result", 1, {})]
        outcomes = trajectory_rule_outcomes([], events)
        self.assertEqual(outcomes["SV613"], {"status": "measured_zero"},
                         "ToolResults 有覆盖时 SV613 不该因为 TurnBoundaries 缺覆盖变成 unavailable")

    def test_sv614_is_available_when_only_one_of_its_two_signals_has_coverage(self):
        events = [self._ev("sandbox/mode", 1, {"mode": "normal"})]
        outcomes = trajectory_rule_outcomes([], events)
        self.assertEqual(outcomes["SV614"], {"status": "measured_zero"},
                         "SandboxModes 有覆盖时 SV614 不该因为 ApprovalDecisions 缺覆盖变成 unavailable")

    def test_sv611_through_sv614_findings_are_picked_up(self):
        events = [self._ev("tool/call", 1, {"name": "bash", "arguments": "ls"})]
        findings = [{"rule": "SV611", "severity": "warning"}]
        outcomes = trajectory_rule_outcomes(findings, events)
        self.assertEqual(outcomes["SV611"], {"status": "findings", "count": 1})

    def test_match_behavior_still_returns_flat_findings(self):
        """`match_behavior` 的薄封装契约不变：返回 findings 列表（门控后），
        不自带三态。调用方要三态用 `match_behavior_gated`。"""
        findings = match_behavior([self._ev("tool/call", 1, {"name": "bash", "arguments": "ls"})])
        self.assertIsInstance(findings, list)
        self.assertTrue(all(f["rule"].startswith("SV6") for f in findings))


class TestGroup5Coverage(unittest.TestCase):
    """P3 group⑤：skill/subagent/compaction/waste 各自的信号覆盖。Rust 侧
    `behavior.rs::array_signal_status`/`waste_coverage` 的测试对齐。"""

    def _ev(self, etype, seq, data):
        return {"type": etype, "seq": seq, "time": 1000 + seq, "data": data}

    def test_array_signal_status_unavailable_when_zero_coverage(self):
        status = array_signal_status(0, "SkillInvocations", {})
        self.assertEqual(status["status"], "unavailable")
        self.assertEqual(status["missing"], ["SkillInvocations"])

    def test_array_signal_status_distinguishes_measured_zero_from_measured(self):
        cov = {"SubagentSpawns": 2}
        self.assertEqual(array_signal_status(0, "SubagentSpawns", cov), {"status": "measured_zero"})
        self.assertEqual(array_signal_status(1, "SubagentSpawns", cov),
                         {"status": "measured", "count": 1})

    def test_waste_coverage_unavailable_only_when_both_signals_missing(self):
        self.assertEqual(waste_coverage([], {})["status"], "unavailable")
        cov = {"ToolResults": 1}
        self.assertEqual(waste_coverage([], cov), {"status": "measured_zero"})
        self.assertEqual(waste_coverage([{"a": 1}], cov), {"status": "measured", "count": 1})

    def test_subagent_spawns_counted_precisely_not_by_session_header_proxy(self):
        """回归测试：之前用"有没有 session 头"判 SubagentSpawns 覆盖率——
        任何真实会话都有头，等于永远"有覆盖"。现在直接数
        tool/call name=="subagent"。"""
        no_subagent = [self._ev("session", 0, {}), self._ev("tool/call", 1, {"name": "bash"})]
        self.assertEqual(signal_coverage(no_subagent)["SubagentSpawns"], 0)

        with_subagent = [self._ev("session", 0, {}), self._ev("tool/call", 1, {"name": "subagent"})]
        self.assertEqual(signal_coverage(with_subagent)["SubagentSpawns"], 1)

    def test_skill_invocations_counts_user_message_and_tool_call_name_skill(self):
        events = [
            self._ev("session", 0, {}),
            self._ev("user/message", 1, {"source": {"kind": "skill-invocation", "name": "b"}}),
            self._ev("tool/call", 2, {"name": "skill"}),
            self._ev("tool/call", 3, {"name": "bash"}),
        ]
        self.assertEqual(signal_coverage(events)["SkillInvocations"], 2)


class TestUsageSignalStatus(unittest.TestCase):
    """P3 group②：cost fold 家族共用的 Usage 信号可用性。Rust
    `usage.rs::usage_signal_status` 的测试对齐——同一批断言。"""

    def test_unavailable_when_zero_usage_events(self):
        self.assertEqual(usage_signal_status([]),
                         {"status": "unavailable", "missing": ["Usage"],
                          "reason": "no evidence for required signal(s) in this session"})

    def test_measured_when_usage_events_present(self):
        self.assertEqual(usage_signal_status([{"a": 1}, {"a": 2}, {"a": 3}]),
                         {"status": "measured", "sample_count": 3})


class TestContextComposition(unittest.TestCase):
    """常驻上下文构成（FR-04a）。Rust 侧 `context_composition_*` 对齐。

    真实会话（session-e4b0be69）实测：system 1,511 · tools 6,371 · catalog 2,773
    （29 个技能）= 常驻 10,655；而首次请求 provider 报的上下文是 13,959。
    **两个数来自不同估算器，差的那部分是首条用户消息与消息封套开销**——所以
    本函数只给常驻分类，不声称与 provider 计数相等。
    """

    EVENTS = [
        {"type": "request/header", "seq": 1, "data": {"header": {
            "config": {"model": "m"},
            "system": "You are an AI agent.",
            "tools": [{"name": "bash", "description": "Run a shell command"}]}}},
        {"type": "user/message", "seq": 2, "data": {"source": {
            "kind": "skill-catalog", "form": "catalog",
            "entries": [{"name": "a", "description": "skill a does things"},
                        {"name": "b", "description": "skill b"}]}}},
    ]

    EXPECTED = ('{"system_tokens":6,"tools_tokens":15,"catalog_tokens":8,'
                '"catalog_entries":2,"catalog_names":[{"name":"a","tokens":6},'
                '{"name":"b","tokens":2}],"resident_total":29,"estimator":"est_tokens"}')

    def test_byte_for_byte_matches_rust(self):
        """tools_tokens 最容易分叉：它估的是**序列化后的 JSON 文本**。

        Python 必须用 `separators=(",", ":")`（紧凑）才能与 Rust 的
        `serde_json::to_string` 一致；默认 json.dumps 会在 `, ` / `: ` 多出空格，
        字符数变多、估算随之偏大。真实日志上这个差异是 6,371 vs 6,546。
        """
        got = json.dumps(context_composition(self.EVENTS), ensure_ascii=False,
                         separators=(",", ":"))
        self.assertEqual(got, self.EXPECTED)

    def test_absent_source_is_null_not_zero(self):
        """源事件从未出现 → None，不是 0。

        「日志里没有 skill-catalog 事件」与「发布了一个空目录」是两回事；
        混成同一个 0，UI 就会写「0 个技能」——一个伪造的测量值。
        """
        out = context_composition([])
        for key in ("system_tokens", "tools_tokens", "catalog_tokens",
                    "catalog_entries", "catalog_names", "resident_total"):
            self.assertIsNone(out[key], key)

    def test_catalog_last_publication_wins(self):
        """目录中途重发时取最后一次，不累加（累加会把同一批技能算两遍）。"""
        out = context_composition([
            {"type": "user/message", "seq": 1, "data": {"source": {
                "kind": "skill-catalog", "entries": [
                    {"name": "a", "description": "x"},
                    {"name": "b", "description": "y"},
                    {"name": "c", "description": "z"}]}}},
            {"type": "agent/inbox/spliced", "seq": 2, "data": {"source": {
                "kind": "skill-catalog", "entries": [{"name": "a", "description": "x"}]}}},
        ])
        self.assertEqual(out["catalog_entries"], 1)
        self.assertEqual(out["catalog_tokens"], est_tokens("ax"))
        self.assertEqual(out["catalog_names"], [{"name": "a", "tokens": est_tokens("ax")}])

    def test_partial_sources_still_give_a_total(self):
        """只有 header 没有 catalog：catalog 仍为 None，但合计按已知项给出。"""
        out = context_composition([
            {"type": "request/header", "seq": 1,
             "data": {"header": {"system": "abc", "tools": []}}}])
        self.assertIsNone(out["catalog_tokens"])
        self.assertIsNotNone(out["resident_total"])

    def test_catalog_names_excludes_description_text(self):
        """T1 隐私决策：catalog_names 只出 {name, tokens}，description 原文绝不
        出现在输出的任何字段里——一旦进投影就会跟着走通用导出路径，FR-SK-09
        要求导出不含未脱敏内容。"""
        out = context_composition([
            {"type": "user/message", "seq": 1, "data": {"source": {
                "kind": "skill-catalog", "entries": [
                    {"name": "a", "description": "contains SECRET_TOKEN_ABC123 in the text"}]}}}])
        serialized = json.dumps(out, ensure_ascii=False)
        self.assertNotIn("SECRET_TOKEN_ABC123", serialized)
        self.assertEqual(out["catalog_names"], [
            {"name": "a", "tokens": est_tokens("acontains SECRET_TOKEN_ABC123 in the text")}])


class TestCompactionEvents(unittest.TestCase):
    """上下文压缩事件。Rust 侧 `compaction::tests::*` 对齐。

    真实会话（session-e4b0be69）实测形态：10 次 prune **全部**顺延到 turn 85
    （同一次爆发，合计 33,099 token），恰好是上下文峰值所在的那个 turn
    （799,841/1,000,000 = 80.0%）；完整压缩发生在两个 turn 之后的 turn 87。
    这条因果链是时间线要讲的故事，所以 turn 必须给准——prune 自身不带 turn，
    全靠 Coords 从 turn/start·turn/end 顺延。
    """

    EVENTS = [
        {"type": "turn/start", "seq": 1, "time": 1001, "data": {"turn": 85}},
        {"type": "compaction/prune", "seq": 2, "time": 1002, "data": {
            "shadowedRange": {"start": 10, "end": 10}, "shadowedSeqs": [10],
            "shadowedTokenCount": 3367}},
        {"type": "compaction/prune", "seq": 3, "time": 1003, "data": {
            "shadowedRange": {"start": 20, "end": 21}, "shadowedSeqs": [20, 21],
            "shadowedTokenCount": 2469}},
        {"type": "turn/end", "seq": 4, "time": 1004, "data": {"turn": 85}},
        {"type": "turn/start", "seq": 5, "time": 1005, "data": {"turn": 87}},
        {"type": "compaction/start", "seq": 6, "time": 1006,
         "data": {"compactionId": "c1", "turn": 87}},
        {"type": "compaction/summary", "seq": 7, "time": 1007,
         "data": {"compactionId": "c1", "summary": []}},
        {"type": "compaction/end", "seq": 8, "time": 1008,
         "data": {"compactionId": "c1", "turn": 87}},
    ]

    EXPECTED = (
        '{"compactions":[{"compaction_id":"c1","start_seq":6,"start_time":1006,'
        '"turn":87,"end_seq":8,"has_summary":true}],'
        '"prunes":[{"seq":2,"time":1002,"turn":85,"shadowed_token_count":3367,'
        '"shadowed_seq_count":1},{"seq":3,"time":1003,"turn":85,'
        '"shadowed_token_count":2469,"shadowed_seq_count":2}],'
        '"pruned_tokens_total":5836,"prunes_without_token_count":0}'
    )

    def test_byte_for_byte_matches_rust(self):
        got = json.dumps(compaction_events(self.EVENTS), ensure_ascii=False,
                         separators=(",", ":"))
        self.assertEqual(got, self.EXPECTED)

    def test_prune_turn_is_carried_forward_not_own(self):
        """prune 自身不带 turn，从 turn/start·turn/end 顺延——这是这个模块存在
        的理由：只喂 compaction/* 不喂 turn 边界的话，每条 prune 的 turn 都会
        落成 None（真实日志上验证过这个坑）。"""
        out = compaction_events(self.EVENTS)
        self.assertEqual({p["turn"] for p in out["prunes"]}, {85})
        self.assertEqual(out["compactions"][0]["turn"], 87,
                         "compaction/start 自带 turn，不需要顺延")

    def test_start_summary_end_merge_into_one_record(self):
        """三个事件按 compactionId 归并成一条，不是三条。"""
        out = compaction_events(self.EVENTS)
        self.assertEqual(len(out["compactions"]), 1)
        self.assertTrue(out["compactions"][0]["has_summary"])
        self.assertEqual(out["compactions"][0]["end_seq"], 8)

    def test_missing_token_count_surfaced_not_summed(self):
        """缺 shadowedTokenCount 的 prune：不计入合计，单独暴露计数。

        两种错误做法都要避免：当 0 累加（把「没上报」伪造成「剪掉了 0」）；或让
        整个合计变 None（一条畸形事件毁掉其余的有用信息，从「部分已知」退化成
        「完全未知」，反而更差）。
        """
        out = compaction_events([
            {"type": "compaction/prune", "seq": 1, "data": {"shadowedTokenCount": 100}},
            {"type": "compaction/prune", "seq": 2, "data": {"shadowedSeqs": [5]}},
        ])
        self.assertEqual(out["pruned_tokens_total"], 100, "只累加上报了的")
        self.assertEqual(out["prunes_without_token_count"], 1)
        self.assertIsNone(out["prunes"][1]["shadowed_token_count"])

    def test_orphan_end_does_not_fabricate_a_record(self):
        """只有 end 没有 start（日志被截断）：不硬造一条 compaction。"""
        out = compaction_events([
            {"type": "compaction/end", "seq": 1, "data": {"compactionId": "ghost", "turn": 9}},
        ])
        self.assertEqual(out["compactions"], [], "没有 start 就没有这次压缩，宁缺勿造")

    def test_absent_gives_empty_not_error(self):
        """无压缩事件：空列表 + 合计 0（「读全了，确实没发生压缩」）。"""
        out = compaction_events([{"type": "tool/call", "seq": 1, "data": {}}])
        self.assertEqual(out["compactions"], [])
        self.assertEqual(out["prunes"], [])
        self.assertEqual(out["pruned_tokens_total"], 0)


class TestStructuralWaste(unittest.TestCase):
    """FR-04b 结构性浪费。Rust 侧 `waste::tests::*` 对齐。

    两个检测器覆盖 PRD 点名的两种模式：重复工具结果、失败重试的上下文增量。
    明确排除的候选是 `compaction_events` 的 prune——查过真实日志（session-
    e4b0be69）的 10 次 prune 具体剪了什么，全部是 turn 3 到 turn 60 互不相同
    的一次性内容，不是重复读取，是正常的上下文老化清理，不该标成"浪费"。
    """

    CONTENT = [{"type": "text", "text": "key: value\nother: 1"}]

    def _tool_call(self, name, args, turn, step, call_id, seq):
        return {"type": "tool/call", "seq": seq, "time": 1000 + seq,
               "data": {"turn": turn, "step": step, "callId": call_id,
                        "name": name, "arguments": args}}

    def _tool_result(self, call_id, turn, step, content, seq):
        return {"type": "tool/result", "seq": seq, "time": 1000 + seq,
               "data": {"turn": turn, "step": step,
                        "message": {"source": {"kind": "tool", "callId": call_id},
                                   "content": content}}}

    def _tool_result_err(self, call_id, turn, step, code, seq):
        return {"type": "tool/result", "seq": seq, "time": 1000 + seq,
               "data": {"turn": turn, "step": step,
                        "message": {"source": {"kind": "tool", "callId": call_id},
                                   "content": []},
                        "error": {"name": "E", "code": code}}}

    def test_byte_for_byte_matches_rust(self):
        events = [
            self._tool_call("read", '{"path":"config.yaml"}', 1, 1, "c1", 1),
            self._tool_result("c1", 1, 1, self.CONTENT, 2),
            self._tool_call("read", '{"path":"config.yaml"}', 2, 1, "c2", 3),
            self._tool_result("c2", 2, 1, self.CONTENT, 4),
            self._tool_call("read", '{"path":"config.yaml"}', 3, 1, "c3", 5),
            self._tool_result("c3", 3, 1, self.CONTENT, 6),
            self._tool_result_err("c4", 70, 2, "FS_NOT_OBSERVED", 440338),
            self._tool_result_err("c5", 70, 2, "FS_NOT_OBSERVED", 440340),
            self._tool_result_err("c6", 70, 2, "FS_NOT_OBSERVED", 440342),
        ]
        requests = [
            {"request_seq": 1, "turn": 70, "step": 1, "context_tokens": 681584},
            {"request_seq": 2, "turn": 70, "step": 2, "context_tokens": 681893},
            {"request_seq": 3, "turn": 70, "step": 3, "context_tokens": 683985},
        ]
        got = json.dumps(detect_structural_waste(events, requests),
                         ensure_ascii=False, separators=(",", ":"))
        expected = (
            '[{"rule":"SV-COST-01","severity":"info","category":"cost","tool_name":"read",'
            '"evidence":"read 结果在 T1–T3 内容相同（重复 3 次）","seq":2,"time":1002,'
            '"turn":1,"step":1,"call_id":"c1","evidence_recency":"log","waste_tokens":28,'
            '"suggestion":"确认是否需要在每个 turn 重新调用「read」处理「config.yaml」；'
            '如果内容不会变化，可以只调用一次并复用结果。"},'
            '{"rule":"SV-COST-02","severity":"info","category":"cost","tool_name":null,'
            '"evidence":"连续 3 次工具失败（首个 FS_NOT_OBSERVED），T70 期间上下文增长 2092 token",'
            '"seq":440338,"time":441338,"turn":70,"step":2,"call_id":null,'
            '"evidence_recency":"log","waste_tokens":2092,'
            '"suggestion":"检查失败原因（工具参数、权限或环境问题）；'
            '重试前先确认根因，避免同一错误被反复携带进后续上下文。"}]'
        )
        self.assertEqual(got, expected)

    def test_duplicate_waste_is_n_minus_one_copies(self):
        """第一次是必要工作，后续每次是纯浪费——3 次出现，浪费 = 2 份多余拷贝。"""
        events = [
            self._tool_call("read", '{"path":"config.yaml"}', 1, 1, "c1", 1),
            self._tool_result("c1", 1, 1, self.CONTENT, 2),
            self._tool_call("read", '{"path":"config.yaml"}', 2, 1, "c2", 3),
            self._tool_result("c2", 2, 1, self.CONTENT, 4),
            self._tool_call("read", '{"path":"config.yaml"}', 3, 1, "c3", 5),
            self._tool_result("c3", 3, 1, self.CONTENT, 6),
        ]
        out = detect_duplicate_tool_results(events)
        self.assertEqual(len(out), 1)
        one_copy = est_tokens(json.dumps(self.CONTENT, ensure_ascii=False, separators=(",", ":")))
        self.assertEqual(out[0]["waste_tokens"], one_copy * 2)
        self.assertIn("config.yaml", out[0]["suggestion"],
                      "建议文案要点名具体目标，不是空泛的\"建议优化上下文\"")

    def test_same_turn_repeat_does_not_count(self):
        """同一 turn 内调用两次不算"重复"——更像同一工作单元里的正常校验。"""
        events = [
            self._tool_call("read", '{"path":"a"}', 1, 1, "c1", 1),
            self._tool_result("c1", 1, 1, self.CONTENT, 2),
            self._tool_call("read", '{"path":"a"}', 1, 2, "c2", 3),
            self._tool_result("c2", 1, 2, self.CONTENT, 4),
        ]
        self.assertEqual(detect_duplicate_tool_results(events), [])

    def test_same_content_different_args_does_not_count(self):
        """参数不同、结果碰巧一样（比如两次都读到空文件）不算重复。"""
        empty = [{"type": "text", "text": ""}]
        events = [
            self._tool_call("read", '{"path":"a.txt"}', 1, 1, "c1", 1),
            self._tool_result("c1", 1, 1, empty, 2),
            self._tool_call("read", '{"path":"b.txt"}', 2, 1, "c2", 3),
            self._tool_result("c2", 2, 1, empty, 4),
        ]
        self.assertEqual(detect_duplicate_tool_results(events), [])

    def test_no_false_positives_on_all_distinct_calls(self):
        """真实场景的负向测试：不同 (工具,参数) 各自只出现一次——真实日志
        796 组、0 重复，这是同一条纪律的单测版。"""
        events = [
            self._tool_call("read", '{"path":"a"}', 1, 1, "c1", 1),
            self._tool_result("c1", 1, 1, [{"type": "text", "text": "1"}], 2),
            self._tool_call("read", '{"path":"b"}', 2, 1, "c2", 3),
            self._tool_result("c2", 2, 1, [{"type": "text", "text": "2"}], 4),
        ]
        self.assertEqual(detect_duplicate_tool_results(events), [])

    def test_failure_run_waste_measures_context_growth(self):
        """增量是真正付出的代价，不是失败次数本身。"""
        events = [
            self._tool_result_err("c1", 5, 2, "FS_NOT_OBSERVED", 10),
            self._tool_result_err("c2", 5, 2, "FS_NOT_OBSERVED", 11),
            self._tool_result_err("c3", 5, 2, "FS_NOT_OBSERVED", 12),
        ]
        requests = [
            {"request_seq": 1, "turn": 5, "step": 1, "context_tokens": 1000},
            {"request_seq": 2, "turn": 5, "step": 2, "context_tokens": 1200},
            {"request_seq": 3, "turn": 5, "step": 3, "context_tokens": 1900},
        ]
        out = detect_failure_run_waste(events, requests)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["waste_tokens"], 700, "1900-1200，不是失败次数")
        self.assertEqual(out[0]["turn"], 5)
        self.assertEqual(out[0]["step"], 2, "锚点是失败区间的起点")

    def test_failure_run_below_threshold_is_not_reported(self):
        events = [
            self._tool_result_err("c1", 1, 1, "X", 1),
            self._tool_result_err("c2", 1, 1, "X", 2),
        ]
        requests = [
            {"request_seq": 1, "turn": 1, "step": 1, "context_tokens": 100},
            {"request_seq": 2, "turn": 1, "step": 2, "context_tokens": 900},
        ]
        self.assertEqual(detect_failure_run_waste(events, requests), [])

    def test_failure_run_without_matching_request_row_is_skipped(self):
        """找不到匹配的请求行就跳过——不拿其他 turn 的数字硬凑一个假的增量。
        AC-08"缺一不得展示"，数据层同一条纪律。"""
        events = [
            self._tool_result_err("c1", 99, 1, "X", 1),
            self._tool_result_err("c2", 99, 1, "X", 2),
            self._tool_result_err("c3", 99, 1, "X", 3),
        ]
        requests = [{"request_seq": 1, "turn": 1, "step": 1, "context_tokens": 100}]
        self.assertEqual(detect_failure_run_waste(events, requests), [])

    def test_failure_run_with_no_context_growth_is_skipped(self):
        """上下文没有净增长（比如恰好发生了压缩）就不算浪费，不倒扣负数。"""
        events = [
            self._tool_result_err("c1", 1, 1, "X", 1),
            self._tool_result_err("c2", 1, 1, "X", 2),
            self._tool_result_err("c3", 1, 1, "X", 3),
        ]
        requests = [
            {"request_seq": 1, "turn": 1, "step": 1, "context_tokens": 5000},
            {"request_seq": 2, "turn": 1, "step": 2, "context_tokens": 1000},
        ]
        self.assertEqual(detect_failure_run_waste(events, requests), [])

    def test_failure_run_matches_real_session_regression(self):
        """真实数据回归：session-e4b0be69 的失败串在 turn 70 step 2。

        context_tokens 是 uncachedInputTokens + cacheReadTokens——不是只有
        uncached，这个坑我自己手算时踩过一次（只用 inputTokens 算出 2092，
        漏了 cacheReadTokens；跑真实管线才发现完整值是 1964）。这里用完整口径
        的真实数字回归。
        """
        events = [
            self._tool_result_err("c1", 70, 2, "FS_NOT_OBSERVED", 440338),
            self._tool_result_err("c2", 70, 2, "FS_NOT_OBSERVED", 440340),
            self._tool_result_err("c3", 70, 2, "FS_NOT_OBSERVED", 440342),
            self._tool_result_err("c4", 70, 2, "FS_NOT_OBSERVED", 440344),
            self._tool_result_err("c5", 70, 2, "FS_NOT_OBSERVED", 440346),
        ]
        # 681893+1664=683557，683985+1536=685521
        requests = [
            {"request_seq": 1, "turn": 70, "step": 1, "context_tokens": 681742},
            {"request_seq": 2, "turn": 70, "step": 2, "context_tokens": 683557},
            {"request_seq": 3, "turn": 70, "step": 3, "context_tokens": 685521},
        ]
        out = detect_failure_run_waste(events, requests)
        self.assertEqual(out[0]["waste_tokens"], 1964)

    def test_empty_input_gives_empty_output(self):
        self.assertEqual(detect_structural_waste([], []), [])


class TestSkillInvocations(unittest.TestCase):
    """Skill 执行审计（backlog T3）。Rust 侧 `skill::tests::*` 对齐。

    两种触发方式落库形态完全不同（`fixtures/dsh/README.md` 实测验证过）：
    explicit（`user/message`，`data.source.kind=="skill-invocation"`）没有
    二段式 call/result，`load_status` 恒为 "loaded"；model_selected
    （`tool/call name="skill"` 配 `tool/result`）照 `subagent.py` 的 callId
    配对写，结果没到就是 "incomplete"，不是"这次调用没发生"。
    """

    def _invocation(self, seq, time, name):
        return {"type": "user/message", "seq": seq, "time": time,
                "data": {"source": {"kind": "skill-invocation", "name": name}}}

    def _call(self, seq, time, turn, step, cid, name):
        return {"type": "tool/call", "seq": seq, "time": time,
                "data": {"turn": turn, "step": step, "callId": cid, "name": "skill",
                         "arguments": '{"name":"%s"}' % name}}

    def _result_ok(self, seq, time, cid):
        return {"type": "tool/result", "seq": seq, "time": time,
                "data": {"message": {"source": {"kind": "tool", "callId": cid},
                                      "content": [{"type": "tool-result", "isError": False}]}}}

    def _result_infra_error(self, seq, time, cid):
        return {"type": "tool/result", "seq": seq, "time": time,
                "data": {"message": {"source": {"kind": "tool", "callId": cid}, "content": []},
                         "error": {"name": "TimeoutError", "code": "TOOL_TIMEOUT"}}}

    def _result_semantic_error(self, seq, time, cid):
        return {"type": "tool/result", "seq": seq, "time": time,
                "data": {"message": {"source": {"kind": "tool", "callId": cid},
                                      "content": [{"type": "tool-result", "isError": True}]}}}

    def test_byte_for_byte_matches_rust(self):
        """与 Rust `skill::tests::python_rust_byte_for_byte_parity` 钉同一个串。"""
        events = [
            {"type": "turn/start", "seq": 10, "data": {"turn": 3}},
            self._invocation(13, 1750000014000, "release-notes"),
            {"type": "turn/end", "seq": 16, "data": {"turn": 3}},
            self._call(19, 1750000020000, 4, 1, "c1", "commit-summarizer"),
            self._result_ok(20, 1750000020018, "c1"),
        ]
        requests = [
            {"request_seq": 1, "turn": 3, "step": 1},
            {"request_seq": 2, "turn": 4, "step": 1},
        ]
        got = json.dumps(skill_invocations(events, requests), ensure_ascii=False,
                         separators=(",", ":"))
        expected = (
            '[{"name":"release-notes","trigger_mode":"explicit","load_status":"loaded",'
            '"duration_ms":null,"seq":13,"time":1750000014000,"turn":3,"step":null,'
            '"call_id":null,"request_seq":null,"missing_fields":["step","request_seq"]},'
            '{"name":"commit-summarizer","trigger_mode":"model_selected","load_status":"loaded",'
            '"duration_ms":18,"seq":19,"time":1750000020000,"turn":4,"step":1,"call_id":"c1",'
            '"request_seq":2,"missing_fields":[]}]'
        )
        self.assertEqual(got, expected)

    def test_explicit_invocation_is_always_loaded_with_no_duration_concept(self):
        events = [
            {"type": "turn/start", "seq": 10, "data": {"turn": 3}},
            self._invocation(13, 1750000014000, "release-notes"),
            {"type": "turn/end", "seq": 16, "data": {"turn": 3}},
        ]
        out = skill_invocations(events, [])
        self.assertEqual(len(out), 1)
        r = out[0]
        self.assertEqual(r["trigger_mode"], "explicit")
        self.assertEqual(r["load_status"], "loaded")
        self.assertIsNone(r["duration_ms"])
        self.assertEqual(r["turn"], 3)
        self.assertIsNone(r["call_id"])
        self.assertNotIn("duration_ms", r["missing_fields"],
                         "explicit 没有二段式 call/result，耗时是不适用而不是缺失")

    def test_model_selected_loaded_computes_real_world_duration(self):
        """真实量级回归——唯一实测样本 turn:5 step:3，Δt = 18ms。"""
        events = [self._call(19, 1000, 5, 3, "c1", "commit-summarizer"),
                  self._result_ok(20, 1018, "c1")]
        out = skill_invocations(events, [])
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["load_status"], "loaded")
        self.assertEqual(out[0]["duration_ms"], 18)
        self.assertEqual(out[0]["turn"], 5)
        self.assertEqual(out[0]["step"], 3)

    def test_model_selected_infra_error_is_failed(self):
        events = [self._call(1, 1000, 1, 1, "c1", "x"), self._result_infra_error(2, 1005, "c1")]
        self.assertEqual(skill_invocations(events, [])[0]["load_status"], "failed")

    def test_model_selected_semantic_error_is_failed(self):
        events = [self._call(1, 1000, 1, 1, "c1", "x"), self._result_semantic_error(2, 1005, "c1")]
        self.assertEqual(skill_invocations(events, [])[0]["load_status"], "failed")

    def test_model_selected_without_result_is_kept_as_incomplete(self):
        """结果没到 ≠ 这次调用没发生——行照留，`duration_ms` 是真的缺失，进 missing_fields。"""
        out = skill_invocations([self._call(1, 1000, 7, 2, "c1", "still-loading")], [])
        self.assertEqual(len(out), 1, "没有回执也要保留这一行")
        self.assertEqual(out[0]["load_status"], "incomplete")
        self.assertIsNone(out[0]["duration_ms"])
        self.assertIn("duration_ms", out[0]["missing_fields"])

    def test_model_selected_unparsable_name_keeps_row_with_missing_field(self):
        """`arguments` 解不出技能名：行照留（call_id 是这条路径的身份锚点），
        name 进 missing_fields。"""
        bad_call = {"type": "tool/call", "seq": 1, "time": 1000,
                    "data": {"turn": 1, "step": 1, "callId": "c1", "name": "skill",
                             "arguments": "not-json"}}
        out = skill_invocations([bad_call], [])
        self.assertEqual(len(out), 1)
        self.assertIsNone(out[0]["name"])
        self.assertEqual(out[0]["call_id"], "c1")
        self.assertIn("name", out[0]["missing_fields"])

    def test_request_seq_resolves_by_exact_turn_step_match(self):
        events = [self._call(19, 1000, 4, 1, "c1", "x"), self._result_ok(20, 1010, "c1")]
        requests = [{"request_seq": 1, "turn": 3, "step": 1},
                    {"request_seq": 2, "turn": 4, "step": 1}]
        out = skill_invocations(events, requests)
        self.assertEqual(out[0]["request_seq"], 2)

    def test_calls_before_fork_belong_to_upstream(self):
        events = [
            self._call(1, 1000, 1, 1, "old", "upstream-skill"),
            self._result_ok(2, 1010, "old"),
            {"type": "session", "seq": None, "data": {"seedLength": 3}},
            self._call(4, 1000, 9, 1, "mine", "own-skill"),
            self._result_ok(5, 1005, "mine"),
        ]
        out = skill_invocations(events, [])
        self.assertEqual(len(out), 1, "分叉前那次是上游触发的，不该算进本会话")
        self.assertEqual(out[0]["name"], "own-skill")

    def test_ignores_other_tools_and_sorts_by_seq(self):
        events = [
            self._call(5, 1000, 2, 1, "c2", "second"),
            self._result_ok(6, 1010, "c2"),
            {"type": "tool/call", "seq": 3, "data": {"callId": "b", "name": "bash",
                                                       "arguments": '{"command":"ls"}'}},
            self._invocation(1, 100, "first"),
        ]
        out = skill_invocations(events, [])
        self.assertEqual(len(out), 2, "bash 调用不是 skill，不进列表")
        self.assertEqual([r["seq"] for r in out], [1, 5], "按 seq 升序，跨两种触发方式")


class TestToolCallDurations(unittest.TestCase):
    """执行时长审计（D1）。Rust 侧 `duration::tests::*` 对齐。

    与 `TestSkillInvocations` 的两点不同：不按工具名过滤（所有带 callId 的
    tool/call 都进来），也不解析 arguments（tool_name 直接来自 data.name）。
    没有 callId 的调用整条跳过——结构上就配不了对，不是"耗时未知"。
    """

    def _call(self, seq, time, turn, step, cid, name):
        return {"type": "tool/call", "seq": seq, "time": time,
                "data": {"turn": turn, "step": step, "callId": cid, "name": name,
                         "arguments": "{}"}}

    def _call_no_name(self, seq, time, cid):
        return {"type": "tool/call", "seq": seq, "time": time, "data": {"callId": cid}}

    def _result_ok(self, seq, time, cid):
        return {"type": "tool/result", "seq": seq, "time": time,
                "data": {"message": {"source": {"kind": "tool", "callId": cid},
                                      "content": [{"type": "tool-result", "isError": False}]}}}

    def _result_infra_error(self, seq, time, cid):
        return {"type": "tool/result", "seq": seq, "time": time,
                "data": {"message": {"source": {"kind": "tool", "callId": cid}, "content": []},
                         "error": {"name": "TimeoutError", "code": "TOOL_TIMEOUT"}}}

    def _result_semantic_error(self, seq, time, cid):
        return {"type": "tool/result", "seq": seq, "time": time,
                "data": {"message": {"source": {"kind": "tool", "callId": cid},
                                      "content": [{"type": "tool-result", "isError": True}]}}}

    def test_byte_for_byte_matches_rust(self):
        """与 Rust `duration::tests::python_rust_byte_for_byte_parity` 钉同一个串。"""
        events = [
            # 没有 callId 就没法配对，也没有 turn/step——incomplete + 三项缺失。
            {"type": "tool/call", "seq": 5, "time": 1000, "data": {"callId": "c2"}},
            self._call(19, 1750000020000, 4, 1, "c1", "bash"),
            self._result_ok(20, 1750000020018, "c1"),
        ]
        got = json.dumps(tool_call_durations(events), ensure_ascii=False, separators=(",", ":"))
        expected = (
            '[{"call_id":"c2","tool_name":null,"load_status":"incomplete","duration_ms":null,'
            '"seq":5,"turn":null,"step":null,'
            '"missing_fields":["tool_name","turn","step","duration_ms"]},'
            '{"call_id":"c1","tool_name":"bash","load_status":"loaded","duration_ms":18,'
            '"seq":19,"turn":4,"step":1,"missing_fields":[]}]'
        )
        self.assertEqual(got, expected)

    def test_computes_duration_for_any_tool_not_just_skill(self):
        events = [self._call(19, 1000, 4, 1, "c1", "bash"), self._result_ok(20, 1018, "c1")]
        out = tool_call_durations(events)
        self.assertEqual(len(out), 1)
        r = out[0]
        self.assertEqual(r["tool_name"], "bash")
        self.assertEqual(r["load_status"], "loaded")
        self.assertEqual(r["duration_ms"], 18)
        self.assertEqual(r["turn"], 4)
        self.assertEqual(r["step"], 1)
        self.assertEqual(r["call_id"], "c1")
        self.assertEqual(r["missing_fields"], [])

    def test_infra_error_is_failed(self):
        events = [self._call(1, 1000, 1, 1, "c1", "bash"), self._result_infra_error(2, 1005, "c1")]
        self.assertEqual(tool_call_durations(events)[0]["load_status"], "failed")

    def test_semantic_error_is_failed(self):
        events = [self._call(1, 1000, 1, 1, "c1", "bash"), self._result_semantic_error(2, 1005, "c1")]
        self.assertEqual(tool_call_durations(events)[0]["load_status"], "failed")

    def test_without_result_is_kept_as_incomplete(self):
        out = tool_call_durations([self._call(1, 1000, 7, 2, "c1", "bash")])
        self.assertEqual(len(out), 1, "没有回执也要保留这一行")
        self.assertEqual(out[0]["load_status"], "incomplete")
        self.assertIsNone(out[0]["duration_ms"])
        self.assertIn("duration_ms", out[0]["missing_fields"])

    def test_call_without_call_id_is_skipped_entirely(self):
        events = [{"type": "tool/call", "seq": 1, "time": 1000, "data": {"name": "bash"}}]
        self.assertEqual(tool_call_durations(events), [])

    def test_missing_tool_name_keeps_row_with_missing_field(self):
        out = tool_call_durations([self._call_no_name(1, 1000, "c1")])
        self.assertEqual(len(out), 1)
        self.assertIsNone(out[0]["tool_name"])
        self.assertEqual(out[0]["call_id"], "c1")
        self.assertIn("tool_name", out[0]["missing_fields"])

    def test_calls_before_fork_belong_to_upstream(self):
        events = [
            self._call(1, 1000, 1, 1, "old", "bash"),
            self._result_ok(2, 1010, "old"),
            {"type": "session", "seq": None, "data": {"seedLength": 3}},
            self._call(4, 1000, 9, 1, "mine", "bash"),
            self._result_ok(5, 1005, "mine"),
        ]
        out = tool_call_durations(events)
        self.assertEqual(len(out), 1, "分叉前那次是上游触发的，不该算进本会话")
        self.assertEqual(out[0]["call_id"], "mine")

    def test_mixed_tools_sort_by_seq(self):
        events = [
            self._call(19, 1000, 4, 1, "c2", "subagent"),
            self._result_ok(20, 1010, "c2"),
            self._call(5, 1000, 1, 1, "c1", "bash"),
            self._result_ok(6, 1010, "c1"),
        ]
        out = tool_call_durations(events)
        self.assertEqual(len(out), 2)
        self.assertEqual([r["seq"] for r in out], [5, 19])
        self.assertEqual(out[0]["tool_name"], "bash")
        self.assertEqual(out[1]["tool_name"], "subagent")

    def test_empty_input_gives_empty_output(self):
        self.assertEqual(tool_call_durations([]), [])


class TestTurnStepDurations(unittest.TestCase):
    """执行时长审计 D2（turn/step 时长）。Rust 侧 `duration::tests::turn_*`/
    `step_*` 对齐。"""

    def _turn_start(self, seq, time, turn):
        return {"type": "turn/start", "seq": seq, "time": time, "data": {"turn": turn}}

    def _turn_end(self, seq, time, turn, kind):
        return {"type": "turn/end", "seq": seq, "time": time,
                "data": {"turn": turn, "reason": {"kind": kind}}}

    def _step_start(self, seq, time, turn, step):
        return {"type": "step/start", "seq": seq, "time": time, "data": {"turn": turn, "step": step}}

    def _step_end(self, seq, time, turn, step):
        return {"type": "step/end", "seq": seq, "time": time, "data": {"turn": turn, "step": step}}

    def test_turn_duration_computes_from_start_end_pair(self):
        events = [self._turn_start(10, 1000, 3), self._turn_end(16, 1500, 3, "completed")]
        out = turn_durations(events)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["duration_ms"], 500)
        self.assertEqual(out[0]["ended_reason"], "completed")
        self.assertEqual(out[0]["load_status"], "loaded")

    def test_turn_without_end_is_kept_as_incomplete(self):
        out = turn_durations([self._turn_start(20, 2000, 4)])
        self.assertEqual(len(out), 1, "没有 turn/end 也要保留这一行")
        self.assertEqual(out[0]["load_status"], "incomplete")
        self.assertIsNone(out[0]["duration_ms"])
        self.assertIn("duration_ms", out[0]["missing_fields"])
        self.assertIn("ended_reason", out[0]["missing_fields"])

    def test_turn_durations_sort_by_turn_number(self):
        events = [
            self._turn_start(20, 2000, 4), self._turn_end(23, 2300, 4, "completed"),
            self._turn_start(10, 1000, 3), self._turn_end(16, 1500, 3, "completed"),
        ]
        out = turn_durations(events)
        self.assertEqual([r["turn"] for r in out], [3, 4])

    def test_turn_durations_byte_for_byte_matches_rust(self):
        events = [
            self._turn_start(10, 1000, 3),
            self._turn_end(16, 1500, 3, "completed"),
            self._turn_start(20, 2000, 4),
        ]
        got = json.dumps(turn_durations(events), ensure_ascii=False, separators=(",", ":"))
        expected = (
            '[{"turn":3,"duration_ms":500,"seq_start":10,"seq_end":16,"ended_reason":"completed",'
            '"load_status":"loaded","missing_fields":[]},'
            '{"turn":4,"duration_ms":null,"seq_start":20,"seq_end":null,"ended_reason":null,'
            '"load_status":"incomplete","missing_fields":["duration_ms","ended_reason"]}]'
        )
        self.assertEqual(got, expected)

    def test_step_duration_computes_from_start_end_pair(self):
        events = [self._step_start(11, 1100, 3, 1), self._step_end(15, 1400, 3, 1)]
        out = step_durations(events)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["duration_ms"], 300)
        self.assertEqual(out[0]["load_status"], "loaded")

    def test_step_without_end_is_kept_as_incomplete(self):
        out = step_durations([self._step_start(21, 2100, 4, 1)])
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["load_status"], "incomplete")
        self.assertIn("duration_ms", out[0]["missing_fields"])

    def test_step_number_resets_per_turn_and_does_not_collide(self):
        events = [
            self._step_start(2, 1002, 1, 1), self._step_end(4, 1004, 1, 1),
            self._step_start(7, 1007, 2, 1), self._step_end(9, 1009, 2, 1),
        ]
        out = step_durations(events)
        self.assertEqual(len(out), 2, "(turn=1,step=1) 与 (turn=2,step=1) 是两个不同的 key")

    def test_step_durations_byte_for_byte_matches_rust(self):
        events = [
            self._step_start(11, 1100, 3, 1),
            self._step_end(15, 1400, 3, 1),
            self._step_start(21, 2100, 4, 1),
        ]
        got = json.dumps(step_durations(events), ensure_ascii=False, separators=(",", ":"))
        expected = (
            '[{"turn":3,"step":1,"duration_ms":300,"seq_start":11,"seq_end":15,'
            '"load_status":"loaded","missing_fields":[]},'
            '{"turn":4,"step":1,"duration_ms":null,"seq_start":21,"seq_end":null,'
            '"load_status":"incomplete","missing_fields":["duration_ms"]}]'
        )
        self.assertEqual(got, expected)


class TestApprovalLatencies(unittest.TestCase):
    """执行时长审计 D3（审批等待延迟）。Rust 侧 `duration::tests::*` 对齐。"""

    def _turn_start(self, seq, time, turn):
        return {"type": "turn/start", "seq": seq, "time": time, "data": {"turn": turn}}

    def _asked(self, seq, time, aid, tool_name):
        return {"type": "approval/asked", "seq": seq, "time": time,
                "data": {"id": aid, "toolName": tool_name, "reason": "escalation"}}

    def _decided(self, seq, time, aid, outcome):
        return {"type": "approval/decided", "seq": seq, "time": time,
                "data": {"id": aid, "outcome": outcome}}

    def test_approval_latency_computes_wait_ms_from_id_pairing(self):
        events = [self._turn_start(10, 1000, 3), self._asked(12, 1200, "a1", "bash"),
                  self._decided(13, 1210, "a1", "allowed-once")]
        out = approval_latencies(events)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["wait_ms"], 10)
        self.assertEqual(out[0]["outcome"], "allowed-once")
        self.assertEqual(out[0]["status"], "decided")
        self.assertEqual(out[0]["turn"], 3)

    def test_pairs_by_id_not_callid(self):
        """关联键是 id，不是 callId——asked 事件即便完全没有 callId 字段也要
        能正常配对（fixtures/dsh/README.md 明确点过这个坑）。"""
        asked_no_callid = {"type": "approval/asked", "seq": 1, "time": 1000,
                            "data": {"id": "a1", "toolName": "bash", "reason": "x"}}
        events = [asked_no_callid, self._decided(2, 1010, "a1", "rejected")]
        out = approval_latencies(events)
        self.assertEqual(out[0]["wait_ms"], 10)
        self.assertEqual(out[0]["outcome"], "rejected")

    def test_asked_without_decided_is_pending_not_incomplete(self):
        out = approval_latencies([self._asked(20, 2000, "a2", "write_file")])
        self.assertEqual(len(out), 1, "没有决定也要保留这一行")
        self.assertEqual(out[0]["status"], "pending")
        self.assertIsNone(out[0]["wait_ms"])
        self.assertIsNone(out[0]["outcome"])
        self.assertNotIn("outcome", out[0]["missing_fields"],
                          "还没决定，不该显示成'outcome 缺失'——那是配对失败才有的语义")

    def test_approval_latencies_sort_by_seq(self):
        events = [self._asked(20, 2000, "a2", "x"), self._asked(12, 1200, "a1", "y")]
        out = approval_latencies(events)
        self.assertEqual([r["seq"] for r in out], [12, 20])

    def test_approval_latencies_byte_for_byte_matches_rust(self):
        events = [
            self._turn_start(10, 1000, 3),
            self._asked(12, 1200, "a1", "bash"),
            self._decided(13, 1210, "a1", "allowed-once"),
            self._asked(20, 2000, "a2", "write_file"),
        ]
        got = json.dumps(approval_latencies(events), ensure_ascii=False, separators=(",", ":"))
        expected = (
            '[{"id":"a1","tool_name":"bash","wait_ms":10,"outcome":"allowed-once","status":"decided",'
            '"turn":3,"step":null,"seq":12,"missing_fields":["step"]},'
            '{"id":"a2","tool_name":"write_file","wait_ms":null,"outcome":null,"status":"pending",'
            '"turn":3,"step":null,"seq":20,"missing_fields":["step","wait_ms"]}]'
        )
        self.assertEqual(got, expected)


class TestHookExecutions(unittest.TestCase):
    """执行时长审计 D4（hook 消费）。Rust 侧 `duration::tests::*_hook_*`/
    `hook_executions_*` 对齐。

    ⚠️ 执行环境前提尚未验证（DURATION_AUDIT_BACKLOG.md D4）：这层只证明 CLI 侧
    的抽取逻辑正确，不代表 dsh-client 执行环境投影已经接了 hook/* 事件——D6 故意
    没把 hook/* 加进 RELEVANT_TYPES。
    """

    def _turn_start(self, seq, time, turn):
        return {"type": "turn/start", "seq": seq, "time": time, "data": {"turn": turn}}

    def _hook_result(self, seq, time, handler_id, point=None, decision=None, duration_ms=None):
        data = {"handlerId": handler_id}
        if point is not None:
            data["point"] = point
        if decision is not None:
            data["decision"] = decision
        if duration_ms is not None:
            data["durationMs"] = duration_ms
        return {"type": "hook/result", "seq": seq, "time": time, "data": data}

    def test_extracts_duration_directly_from_result_no_pairing_needed(self):
        events = [self._turn_start(1, 1000, 1),
                  self._hook_result(9, 1009, "h1", "PreToolUse", "pass", 12)]
        out = hook_executions(events)
        rows = out["executions"]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["handler_id"], "h1")
        self.assertEqual(rows[0]["point"], "PreToolUse")
        self.assertEqual(rows[0]["decision"], "pass")
        self.assertEqual(rows[0]["duration_ms"], 12)
        self.assertEqual(rows[0]["turn"], 1)
        self.assertEqual(rows[0]["missing_fields"], [])

    def test_missing_handler_id_is_skipped_entirely(self):
        bad = {"type": "hook/result", "seq": 1, "time": 1000, "data": {"point": "PreToolUse"}}
        self.assertEqual(hook_executions([bad])["executions"], [])

    def test_missing_point_decision_duration_go_to_missing_fields(self):
        out = hook_executions([self._hook_result(1, 1000, "h1")])
        row = out["executions"][0]
        self.assertIsNone(row["point"])
        self.assertIsNone(row["decision"])
        self.assertIsNone(row["duration_ms"])
        for f in ["point", "decision", "duration_ms"]:
            self.assertIn(f, row["missing_fields"])

    def test_decision_counts_tally_by_actual_string_value(self):
        events = [
            self._hook_result(1, 1000, "h1", decision="pass", duration_ms=1),
            self._hook_result(2, 1000, "h2", decision="pass", duration_ms=1),
            self._hook_result(3, 1000, "h3", decision="deny", duration_ms=1),
        ]
        counts = hook_executions(events)["decision_counts"]
        self.assertEqual(counts["pass"], 2)
        self.assertEqual(counts["deny"], 1)

    def test_turn_falls_back_to_coord_map_when_not_carried(self):
        events = [self._turn_start(1, 1000, 5), self._hook_result(9, 1009, "h1")]
        self.assertEqual(hook_executions(events)["executions"][0]["turn"], 5)

    def test_hook_executions_byte_for_byte_matches_rust(self):
        events = [
            self._turn_start(1, 1000, 1),
            self._hook_result(9, 1009, "h1", "PreToolUse", "pass", 12),
            self._hook_result(15, 1015, "h2", decision="deny"),
        ]
        got = json.dumps(hook_executions(events), ensure_ascii=False, separators=(",", ":"))
        expected = (
            '{"executions":[{"handler_id":"h1","point":"PreToolUse","decision":"pass",'
            '"duration_ms":12,"turn":1,"seq":9,"missing_fields":[]},'
            '{"handler_id":"h2","point":null,"decision":"deny","duration_ms":null,"turn":1,'
            '"seq":15,"missing_fields":["point","duration_ms"]}],'
            '"decision_counts":{"deny":1,"pass":1}}'
        )
        self.assertEqual(got, expected)

    def test_empty_input_gives_empty_output(self):
        out = hook_executions([])
        self.assertEqual(out["executions"], [])
        self.assertEqual(out["decision_counts"], {})


class TestDurationCoverage(unittest.TestCase):
    """P3 group③：五路执行时长审计各自的信号覆盖。Rust 侧
    `duration.rs::duration_coverage` 的测试对齐——同一批断言。"""

    def _empty_duration(self):
        return {"tool_calls": [], "turns": [], "steps": [], "approvals": [],
                "hooks": {"executions": [], "decision_counts": {}}}

    def test_unavailable_for_every_signal_on_empty_session(self):
        out = duration_coverage(self._empty_duration(), [])
        for key in ("tool_calls", "turns", "steps", "approvals", "hooks"):
            self.assertEqual(out[key]["status"], "unavailable", "%s 零覆盖应该 unavailable" % key)

    def test_distinguishes_measured_zero_from_unavailable(self):
        # ToolCalls 有覆盖(有 tool/call 事件)但 tool_call_durations 折出空
        # 数组(没有 callId)→ measured_zero，不是 unavailable。
        events = [{"type": "tool/call", "seq": 1, "time": 1000, "data": {"name": "bash"}}]
        out = duration_coverage(self._empty_duration(), events)
        self.assertEqual(out["tool_calls"]["status"], "measured_zero")
        self.assertEqual(out["turns"]["status"], "unavailable")

    def test_measured_with_count_for_populated_arrays_and_nested_hooks(self):
        duration = {
            "tool_calls": [{"a": 1}, {"a": 2}], "turns": [], "steps": [], "approvals": [],
            "hooks": {"executions": [{"a": 1}], "decision_counts": {"pass": 1}},
        }
        events = [
            {"type": "tool/call", "seq": 1, "time": 1000, "data": {"name": "bash"}},
            {"type": "hook/result", "seq": 2, "time": 1001, "data": {"handlerId": "h1"}},
        ]
        out = duration_coverage(duration, events)
        self.assertEqual(out["tool_calls"], {"status": "measured", "count": 2})
        self.assertEqual(out["hooks"], {"status": "measured", "count": 1})


class TestRequestMetrics(unittest.TestCase):
    """`request_metrics` 的逐字节输出——Rust 侧 `usage.rs` 同名测试要对齐的目标。

    为什么两侧都要钉同一个串：Rust 的
    `request_metrics_python_rust_byte_for_byte_parity` 只是把这个串**硬编码**
    进去，它并不真的跑 Python。所以只有 Rust 那一处的话，Python 单方面改了输出
    仍然全绿——差分是假的。两侧各钉一次，任何一侧动了都会红，才是真差分。

    （`token_by_model` 的活差分另有 `test_cli_matrix.py` 的双二进制逐字节比较；
    `request_metrics` 目前还没接进 CLI，所以这里是它唯一的 Python 侧护栏。）
    """

    EVENTS = [
        {"type": "request/context", "seq": 1, "time": 1001,
         "data": {"provider": "p", "model": "m", "contextWindow": 1000000}},
        {"type": "request/header", "seq": 2, "time": 1002,
         "data": {"header": {"config": {"model": "m"}}}},
        {"type": "assistant/chunk", "seq": 3, "time": 1003,
         "data": {"turn": 1, "step": 1, "chunk": {"type": "usage",
                  "usage": {"inputTokens": 1000, "outputTokens": 200, "cacheReadTokens": 300}}}},
        # 故意缺 cacheReadTokens：验证它与 context_tokens 双双落 null 而不是 0
        {"type": "assistant/chunk", "seq": 4, "time": 1004,
         "data": {"turn": 2, "step": 1, "chunk": {"type": "usage",
                  "usage": {"inputTokens": 2000, "outputTokens": 50}}}},
    ]

    EXPECTED = (
        '[{"request_seq":1,"seq":3,"time":1003,"turn":1,"step":1,"model":"m",'
        '"context_window":1000000,"context_tokens":1300,"uncached_input_tokens":1000,'
        '"output_tokens":200,"cache_read_tokens":300,"cache_write_tokens":null,'
        # is_peak：这笔请求是否落在北京高峰时段。规则留在 core、价格留给调用方，
        # 展示层画逐请求费用曲线时才不必重算一遍（第四份拷贝）。
        '"is_peak":false},'
        '{"request_seq":2,"seq":4,"time":1004,"turn":2,"step":1,"model":"m",'
        '"context_window":1000000,"context_tokens":null,"uncached_input_tokens":2000,'
        '"output_tokens":50,"cache_read_tokens":null,"cache_write_tokens":null,'
        '"is_peak":false}]'
    )

    def test_byte_for_byte_matches_rust(self):
        got = json.dumps(request_metrics(self.EVENTS), ensure_ascii=False,
                         separators=(",", ":"))
        self.assertEqual(got, self.EXPECTED, "键序 / null 位置 / 值必须与 Rust 侧一致")

    def test_missing_field_is_null_not_zero(self):
        """缺字段落 null。落 0 就是把「执行环境没报」伪造成「测到 0」。

        实测依据：真实会话 687 个请求点里 13 个缺 cacheReadTokens、687 个全部
        缺 cacheWriteTokens。给这些点补 0，曲线会在缺字段处莫名塌陷。
        """
        row = request_metrics(self.EVENTS)[1]
        self.assertIsNone(row["cache_read_tokens"])
        self.assertIsNone(row["cache_write_tokens"])
        self.assertIsNone(row["context_tokens"], "缺一个加数就整行留空，不拿部分和硬凑")
        self.assertEqual(row["uncached_input_tokens"], 2000, "在场的字段照常给值")

    def test_omits_per_request_compacted_field(self):
        """不输出逐请求的 `compacted` 布尔列——压缩事件类型已确认（见
        `TestCompactionEvents`），但它是**独立于请求**的一类事件（同一 turn 内
        没有对应哪个具体 request），不该硬塞成每行一个 True/False。真正的压缩
        视图是 `compaction_events()` 单独的输出，不是这里的一列。
        """
        self.assertNotIn("compacted", request_metrics(self.EVENTS)[0])

    def test_reconciles_with_token_by_model(self):
        """同源不变量：逐请求四桶之和 == token_by_model 四桶之和。

        证明两者共用同一套 (turn, step) 去重语义。任一侧改了去重都会红。
        真实会话 session-e4b0be69 上也对过：1398 样本去重成 687 请求点，
        四桶之和 226,424,711 / 685,754 / 50,073,856 / 0 两侧完全一致。
        """
        events = [
            {"type": "request/header", "seq": 1,
             "data": {"header": {"config": {"model": "pro"}}}},
            # 同 (1,1)：chunk 先到、message 后到 —— 只算后者
            {"type": "assistant/chunk", "seq": 2,
             "data": {"turn": 1, "step": 1, "chunk": {"type": "usage",
                      "usage": {"inputTokens": 1000, "outputTokens": 200,
                                "cacheReadTokens": 300, "cacheWriteTokens": 0}}}},
            {"type": "assistant/message", "seq": 3,
             "data": {"turn": 1, "step": 1,
                      "usage": {"inputTokens": 1200, "outputTokens": 250,
                                "cacheReadTokens": 300, "cacheWriteTokens": 0}}},
            {"type": "request/header", "seq": 4,
             "data": {"header": {"config": {"model": "flash"}}}},
            {"type": "assistant/chunk", "seq": 5,
             "data": {"turn": 2, "step": 1, "chunk": {"type": "usage",
                      "usage": {"inputTokens": 500, "outputTokens": 50,
                                "cacheReadTokens": 0, "cacheWriteTokens": 0}}}},
        ]
        rows = request_metrics(events)
        self.assertEqual(len(rows), 2, "3 个样本去重成 2 个请求点")
        agg = token_by_model(events)
        for key in ("uncached_input_tokens", "output_tokens",
                    "cache_read_tokens", "cache_write_tokens"):
            self.assertEqual(
                sum(r[key] or 0 for r in rows),
                sum(m[key] for m in agg["by_model"].values()),
                f"{key}: 逐请求之和必须等于按模型之和")
        self.assertEqual(rows[0]["uncached_input_tokens"], 1200, "替换后的值，不是 1000")

    def test_context_window_absent_is_null(self):
        """没有 request/context 就没有分母——不拿任何默认窗口顶替。"""
        rows = request_metrics([
            {"type": "request/header", "seq": 1,
             "data": {"header": {"config": {"model": "m"}}}},
            {"type": "assistant/chunk", "seq": 2,
             "data": {"turn": 1, "step": 1, "chunk": {"type": "usage",
                      "usage": {"inputTokens": 10, "cacheReadTokens": 5}}}},
        ])
        self.assertIsNone(rows[0]["context_window"], "不臆造 128K 之类的默认值")
        self.assertEqual(rows[0]["context_tokens"], 15, "分子照常可算")


class TestDshUsageObservations(unittest.TestCase):
    """`dsh_usage_observations` 的语义——Rust 侧 `usage.rs` 同名测试要对齐。

    字段分两组：槽身份/身份固化字段（identity_basis/source_event_id/
    first_sample_seq/first_sample_identity_hash/compaction_id，开槽即固化、
    shadow 永不覆盖）与支配样本 value（shadow 可覆盖，含 §3.4 model_raw/
    provider_raw）。observer 直接携带最终 `source_event_id`（Commit 2 emitter
    只消费、不复算）——所以这里是对 Commit 2 身份输入的语义护栏。source_event_id
    的 canonical hash 用与 Rust 测试**同一个字面量**钉住：任一侧的身份行构造漂移
    （seq 键该省没省、time/data 键该带没带、模型解析谓词不一致）当场红。
    """

    def test_first_sample_seq_is_opening_sample_not_governing(self):
        """开槽样本锚定 first_sample_seq 与 source_event_id——同 (turn, step) 的
        shadow（chunk 后到 message）只更新支配样本 value，身份不随支配样本走
        （spec §3.3「append shadow 不改写身份输入」在 seq 元组与 fact_id 上的
        镜像）。
        """
        obs = dsh_usage_observations([
            {"type": "assistant/chunk", "seq": 10, "time": 1001,
             "data": {"turn": 1, "step": 1, "chunk": {"type": "usage",
                      "usage": {"inputTokens": 1000, "outputTokens": 200,
                                "cacheReadTokens": 300}}}},
            {"type": "assistant/message", "seq": 11, "time": 1002,
             "data": {"turn": 1, "step": 1,
                      "usage": {"inputTokens": 1200, "outputTokens": 250,
                                "cacheReadTokens": 300}}},
        ])
        self.assertEqual(len(obs), 1, "两份同槽样本 = 一个请求点")
        self.assertEqual(obs[0].first_sample_seq, 10, "锚定开槽样本 seq，不是支配样本 11")
        self.assertEqual(obs[0].seq, 11, "value 侧仍指向支配样本")
        self.assertEqual(obs[0].uncached_input_tokens, 1200, "value 用后到者")
        self.assertEqual(obs[0].output_tokens, 250)
        self.assertEqual(obs[0].identity_basis, "derived-hash")
        self.assertEqual(
            obs[0].source_event_id, "request:derived:2e4298cf1c7ad82a",
            "普通槽身份 = fnv1a64(canonical{{turn,step,seq:开槽 seq 10}})，observer 直接携带")
        self.assertFalse(obs[0].is_compaction)
        self.assertEqual((obs[0].turn, obs[0].step), (1, 1))
        self.assertIsNone(obs[0].model_raw, "无 header 则无 active 证据")
        self.assertIsNone(obs[0].first_sample_identity_hash, "仅无 id compaction 有 hash")

    def test_non_adjacent_same_turn_step_is_two_slots(self):
        """相邻槽去重是相邻 run（fold 同款 last-key）：同 (turn, step) 非相邻
        重现（中间隔着别的槽）是两个独立槽，各锚自己的开槽样本——若当同一槽，
        append 的 shadow 会跨越大段时间改写首份样本的身份。
        """
        obs = dsh_usage_observations([
            {"type": "assistant/chunk", "seq": 2, "time": 1,
             "data": {"turn": 1, "step": 1, "chunk": {"type": "usage",
                      "usage": {"inputTokens": 1000}}}},
            {"type": "assistant/chunk", "seq": 3, "time": 2,
             "data": {"turn": 2, "step": 1, "chunk": {"type": "usage",
                      "usage": {"inputTokens": 500}}}},
            {"type": "assistant/chunk", "seq": 4, "time": 3,
             "data": {"turn": 1, "step": 1, "chunk": {"type": "usage",
                      "usage": {"inputTokens": 800}}}},
        ])
        self.assertEqual(len(obs), 3)
        self.assertEqual([o.first_sample_seq for o in obs], [2, 3, 4])
        self.assertEqual(obs[2].uncached_input_tokens, 800)
        self.assertNotEqual(obs[0].source_event_id, obs[2].source_event_id,
                            "同 (1,1) 非相邻两槽各自 derived-hash 身份（first_sample_seq 不同）")

    def test_compaction_with_id_is_native_with_self_evidence(self):
        """compaction 槽折进负号身份槽，turn/step 诚实置 None（内部去重哈希不
        泄漏成真实 turn 号）；有原生 compactionId → native 身份 + 无 hash；自带
        model/provider（str 非空）优先 → model_raw/provider_raw 取 self、不取
        active（§3.4 compaction 分支），source_event_id 是 `compaction:<id>`。
        """
        obs = dsh_usage_observations([
            {"type": "request/header", "seq": 1, "time": 1,
             "data": {"header": {"config": {"model": "deepseek-v4-pro",
                                            "provider": "shengsuanyun"}}}},
            {"type": "compaction/summary", "seq": 2, "time": 1787813784275,
             "data": {"compactionId": "c1", "sourceCommandId": "cmd-1",
                      "model": "deepseek-v4-flash", "provider": "deepseek-official",
                      "usage": {"inputTokens": 462, "outputTokens": 3520,
                                "cacheReadTokens": 245760}}},
        ])
        self.assertEqual(len(obs), 1)
        self.assertTrue(obs[0].is_compaction)
        self.assertIsNone(obs[0].turn)
        self.assertIsNone(obs[0].step)
        self.assertEqual(obs[0].compaction_id, "c1")
        self.assertEqual(obs[0].identity_basis, "native", "compactionId 是执行环境原生标识")
        self.assertEqual(obs[0].source_event_id, "compaction:c1")
        self.assertIsNone(obs[0].first_sample_identity_hash, "有 id 无 hash")
        self.assertEqual(obs[0].model_raw, "deepseek-v4-flash",
                         "§3.4：自带 model（非空）优先于 active 的 deepseek-v4-pro")
        self.assertEqual(obs[0].provider_raw, "deepseek-official")
        self.assertEqual(obs[0].first_sample_seq, 2)

    def test_no_id_compaction_fixed_slot_shadow_freezes_first_sample(self):
        """§3.3 的冻结场景：无 compactionId 的 compaction 折进固定负号槽 (-1, 0)
        ——任何相邻第二份无 id compaction 都落进同一槽替换支配样本。观察者在开槽
        样本算好并冻结 first_sample_identity_hash（canonical 行 hash，本测试用
        字面量钉住——Rust 侧断言同值，身份行构造漂移当场红），shadow 只更新
        value。prefix-only（只有开槽样本）与 full（+shadow）身份逐字相同 =
        append 稳定。
        """
        opening = {"type": "compaction/summary", "seq": 5, "time": 1001,
                   "data": {"sourceCommandId": "cmd-1", "model": "m1",
                            "provider": "p1",
                            "usage": {"inputTokens": 100, "outputTokens": 10,
                                      "cacheReadTokens": 5}}}
        shadow = {"type": "compaction/summary", "seq": 6, "time": 1002,
                  "data": {"sourceCommandId": "cmd-1", "model": "m1",
                           "provider": "p1",
                           "usage": {"inputTokens": 200, "outputTokens": 20,
                                     "cacheReadTokens": 5}}}
        obs = dsh_usage_observations([opening, shadow])
        self.assertEqual(len(obs), 1, "两份同 (-1,0) 相邻样本 = 一个槽")
        self.assertEqual(obs[0].first_sample_seq, 5, "身份锚在开槽样本 seq 5")
        self.assertEqual(
            obs[0].first_sample_identity_hash, "c71a9fe6db364b69",
            "无 id compaction hash = 开槽样本重塑事件（{type,time,data}+seq5）canonical 行的 fnv1a64 hex")
        self.assertEqual(obs[0].source_event_id, "compaction:derived:c71a9fe6db364b69")
        self.assertEqual(obs[0].seq, 6, "value 侧指向支配样本 seq 6")
        self.assertEqual(obs[0].uncached_input_tokens, 200, "value 用后到者")
        self.assertIsNone(obs[0].compaction_id)
        self.assertEqual(obs[0].identity_basis, "derived-hash")
        self.assertIsNone(obs[0].turn)
        self.assertIsNone(obs[0].step)
        # prefix-only 与 full 身份逐字相同——append shadow 不改写旧 fact_id。
        prefix = dsh_usage_observations([opening])
        self.assertEqual(prefix[0].source_event_id, obs[0].source_event_id)
        self.assertEqual(prefix[0].first_sample_identity_hash,
                         obs[0].first_sample_identity_hash)
        self.assertEqual(prefix[0].first_sample_seq, obs[0].first_sample_seq)

    def test_governing_sample_rejudges_active_cursor(self):
        """每份支配样本都按那一刻的 active 游标重判 model_raw/provider_raw，不
        缓存成槽建立时的值——header 若在 chunk/message 之间切换，governing 落在
        新模型上（§3.4 + fold「后到重判」一致），而身份仍锚开槽样本、逐字不变。
        """
        obs = dsh_usage_observations([
            {"type": "request/header", "seq": 1, "time": 1,
             "data": {"header": {"config": {"model": "pro", "provider": "p1"}}}},
            {"type": "assistant/chunk", "seq": 2, "time": 2,
             "data": {"turn": 1, "step": 1, "chunk": {"type": "usage",
                      "usage": {"inputTokens": 1000}}}},
            {"type": "request/header", "seq": 3, "time": 3,
             "data": {"header": {"config": {"model": "flash", "provider": "p2"}}}},
            {"type": "assistant/message", "seq": 4, "time": 4,
             "data": {"turn": 1, "step": 1,
                      "usage": {"inputTokens": 1200}}},
        ])
        self.assertEqual(len(obs), 1)
        self.assertEqual(obs[0].first_sample_seq, 2, "身份仍锚开槽样本 seq 2")
        self.assertEqual(obs[0].source_event_id, "request:derived:d000f644afcc1839")
        self.assertEqual(obs[0].model_raw, "flash", "governing 那一刻的 active 游标")
        self.assertEqual(obs[0].provider_raw, "p2")
        self.assertEqual(obs[0].uncached_input_tokens, 1200)
        # 只有开槽样本的 prefix：value 落在当时 pro/p1，但身份逐字不变。
        prefix = dsh_usage_observations([
            {"type": "request/header", "seq": 1, "time": 1,
             "data": {"header": {"config": {"model": "pro", "provider": "p1"}}}},
            {"type": "assistant/chunk", "seq": 2, "time": 2,
             "data": {"turn": 1, "step": 1, "chunk": {"type": "usage",
                      "usage": {"inputTokens": 1000}}}},
        ])
        self.assertEqual(prefix[0].source_event_id, obs[0].source_event_id)
        self.assertEqual(prefix[0].model_raw, "pro")
        self.assertEqual(obs[0].model_raw, "flash", "shadow 只更新 value，身份字段原样")

    def test_seq_none_omits_seq_key(self):
        """§3.3 seq=None 确定性降级：真实样本恒带整型 seq，这条纯属防御。
        first_sample_seq 为 None 时 canonical 身份 dict 整体省略 seq 键（只 hash
        {turn, step}）——Python 序列化成 "None" / Rust 序列化成 "null" 都会字节
        分叉或 id 不稳定。普通请求与无 id compaction 共用同一条「整数才追加 seq」
        分支，两分支都在此钉字面量。
        """
        # 普通请求：message 无顶层 seq → 身份 hash 只含 {turn:1, step:1}。
        obs = dsh_usage_observations([
            {"type": "assistant/message", "time": 1,
             "data": {"turn": 1, "step": 1,
                      "usage": {"inputTokens": 1200}}},
        ])
        self.assertIsNone(obs[0].first_sample_seq)
        self.assertEqual(obs[0].source_event_id, "request:derived:5c5b05e3d3ff0a96",
                         "hash 对象是 {step:1,turn:1}（无 seq 键），不是含 null 的 seq")
        # 无 id compaction 同款：首样本无 seq → identity_row 不带 seq 键。
        obs2 = dsh_usage_observations([
            {"type": "compaction/summary", "time": 1001,
             "data": {"sourceCommandId": "cmd-1", "model": "m1", "provider": "p1",
                      "usage": {"inputTokens": 100, "outputTokens": 10,
                                "cacheReadTokens": 5}}},
        ])
        self.assertIsNone(obs2[0].first_sample_seq)
        self.assertEqual(obs2[0].first_sample_identity_hash, "f54d0f50212df43d")
        self.assertEqual(obs2[0].source_event_id, "compaction:derived:f54d0f50212df43d")

    def test_empty_self_model_falls_back_to_active(self):
        """§3.4 model_raw/provider_raw 解析：compaction 自带 data.model 为空串
        （退化值，不是 str 缺失）时回落当时 active 游标，不把 "" 当模型名——
        Python 真值渲染与 Rust `Some(m) => m` 的历史分歧（Rust 过去把空串当
        模型名）在此收敛为同一谓词。
        """
        obs = dsh_usage_observations([
            {"type": "request/header", "seq": 1, "time": 1,
             "data": {"header": {"config": {"model": "pro", "provider": "p1"}}}},
            {"type": "compaction/summary", "seq": 2, "time": 1001,
             "data": {"sourceCommandId": "cmd-1", "model": "", "provider": "",
                      "usage": {"inputTokens": 100}}},
        ])
        self.assertEqual(len(obs), 1)
        self.assertEqual(obs[0].identity_basis, "derived-hash", "空 compactionId = derived")
        self.assertEqual(obs[0].model_raw, "pro", "空串回落 active，不把 '' 当模型名")
        self.assertEqual(obs[0].provider_raw, "p1")

    def test_reconciles_four_buckets_with_token_by_model(self):
        """observer 与聚合 fold 两条已 reconcile 路径：逐观察四桶之和 ==
        token_by_model 四桶之和（request_metrics 级已钉过，这里在观察级再钉一次
        ——请求点数可经渲染变化，观察字段是源头）。"""
        events = [
            {"type": "request/header", "seq": 1,
             "data": {"header": {"config": {"model": "pro"}}}},
            # 同 (1,1)：chunk 先到、message 后到——只算后者
            {"type": "assistant/chunk", "seq": 2,
             "data": {"turn": 1, "step": 1, "chunk": {"type": "usage",
                      "usage": {"inputTokens": 1000, "outputTokens": 200,
                                "cacheReadTokens": 300, "cacheWriteTokens": 0}}}},
            {"type": "assistant/message", "seq": 3,
             "data": {"turn": 1, "step": 1,
                      "usage": {"inputTokens": 1200, "outputTokens": 250,
                                "cacheReadTokens": 300, "cacheWriteTokens": 0}}},
            {"type": "request/header", "seq": 4,
             "data": {"header": {"config": {"model": "flash"}}}},
            {"type": "assistant/chunk", "seq": 5,
             "data": {"turn": 2, "step": 1, "chunk": {"type": "usage",
                      "usage": {"inputTokens": 500, "outputTokens": 50,
                                "cacheReadTokens": 0, "cacheWriteTokens": 0}}}},
        ]
        obs = dsh_usage_observations(events)
        self.assertEqual(len(obs), 2, "3 个样本去重成 2 个槽")
        agg = token_by_model(events)
        for key in ("uncached_input_tokens", "output_tokens",
                    "cache_read_tokens", "cache_write_tokens"):
            self.assertEqual(
                sum(getattr(o, key) or 0 for o in obs),
                sum(m[key] for m in agg["by_model"].values()),
                f"{key}: 逐观察之和必须等于按模型之和")
        self.assertEqual(obs[0].uncached_input_tokens, 1200, "替换后的值，不是 1000")
        self.assertEqual([o.identity_basis for o in obs], ["derived-hash"] * 2)


class TestHourBuckets(unittest.TestCase):
    """`hour_buckets` 的 Python 侧锚点 —— Rust `usage.rs::hour_buckets`
    平行实现要对齐的目标。

    与 `TestRequestMetricsByteForByteRust` 同一种锁步策略：双方各钉一份
    输出（不是一边钉一边跟着跑），任一侧动了都会红。
    """

    # 北京时间戳对照表（全部 2026 年；周二 = 工作日分支）：
    #   06:30 = 早空闲，9-12/14-18 之外；周末判定走 _beijing_weekday 分支
    #   09:30 = 早高峰，14:30 = 下午高峰
    #   23:50 → 00:10 = 跨午夜（落到不同日期）
    #   14:30 周六 = 工作日 14 点是高峰，周六全天空闲——专门验这一条规则
    TUE_PEAK_1430 = 1787639400000      # 周二 14:30 北京（下午高峰）
    TUE_PEAK_0930 = 1787621400000      # 周二 09:30 北京（早高峰）
    TUE_OFFPEAK_0630 = 1787610600000   # 周二 06:30 北京（早空闲）
    TUE_LATE_NIGHT_2350 = 1787673000000  # 周二 23:50 北京
    WED_JUST_AFTER_0010 = 1787674200000  # 周三 00:10 北京（跨午夜）
    SAT_1430 = 1787985000000           # 周六 14:30 北京（高峰小时但周末空闲）

    def test_empty_input_returns_empty_buckets(self):
        """没有事件就不臆造 bucket——与 CLAUDE.md「缺列不编列」同条纪律。"""
        out = hour_buckets([])
        self.assertEqual(out["buckets"], [])
        self.assertEqual(out["schema_version"], 1)
        self.assertEqual(out["tz_name"], "Asia/Shanghai (UTC+8 fixed, no DST)")
        self.assertEqual(out["tz_offset_hours"], 8)
        self.assertEqual(out["unreported_fields"], [])

    def test_single_peak_sample_populates_both_base_and_peak(self):
        """一笔高峰请求：4 基础桶 + 4 peak_* 子桶都该有值，is_peak=true。"""
        events = [
            {"type": "request/header", "seq": 1, "time": self.TUE_PEAK_1430,
             "data": {"header": {"config": {"model": "pro"}}}},
            {"type": "assistant/chunk", "seq": 2, "time": self.TUE_PEAK_1430,
             "data": {"turn": 1, "step": 1, "chunk": {"type": "usage",
                      "usage": {"inputTokens": 1000, "outputTokens": 200,
                                "cacheReadTokens": 300, "cacheWriteTokens": 50}}}},
        ]
        out = hour_buckets(events)
        self.assertEqual(len(out["buckets"]), 1)
        b = out["buckets"][0]
        self.assertEqual(b["date"], "2026-08-25")
        self.assertEqual(b["hour"], 14)
        self.assertTrue(b["is_peak"])
        self.assertEqual(b["uncached_input_tokens"], 1000)
        self.assertEqual(b["output_tokens"], 200)
        self.assertEqual(b["cache_read_tokens"], 300)
        self.assertEqual(b["cache_write_tokens"], 50)
        # peak_* 子桶等于基础桶（这笔请求本身就是高峰）
        self.assertEqual(b["peak_uncached_input_tokens"], 1000)
        self.assertEqual(b["peak_output_tokens"], 200)
        self.assertEqual(b["peak_cache_read_tokens"], 300)
        self.assertEqual(b["peak_cache_write_tokens"], 50)
        self.assertEqual(out["unreported_fields"], [])

    def test_off_peak_sample_does_not_populate_peak_subbuckets(self):
        """一笔空闲请求：基础桶有数、peak_* 全 0、is_peak=false。"""
        events = [
            {"type": "request/header", "seq": 1, "time": self.TUE_OFFPEAK_0630,
             "data": {"header": {"config": {"model": "pro"}}}},
            {"type": "assistant/chunk", "seq": 2, "time": self.TUE_OFFPEAK_0630,
             "data": {"turn": 1, "step": 1, "chunk": {"type": "usage",
                      "usage": {"inputTokens": 500, "outputTokens": 100}}}},
        ]
        out = hour_buckets(events)
        b = out["buckets"][0]
        self.assertEqual(b["hour"], 6)
        self.assertFalse(b["is_peak"])
        self.assertEqual(b["uncached_input_tokens"], 500)
        self.assertEqual(b["output_tokens"], 100)
        # 空闲时段 → peak_* 子桶全 0
        self.assertEqual(b["peak_uncached_input_tokens"], 0)
        self.assertEqual(b["peak_output_tokens"], 0)
        self.assertEqual(b["peak_cache_read_tokens"], 0)
        self.assertEqual(b["peak_cache_write_tokens"], 0)

    def test_weekend_peak_hour_is_off_peak(self):
        """**周六下午 14 点也是空闲**——漏过这条规则按真实账单对照会精确
        ×2（见 usage.py::_is_peak_slot 的注释，2026-08-23 周日 14:45 那次
        会话被错算了 ¥1.0308372 应收 ¥0.5154186）。"""
        events = [
            {"type": "request/header", "seq": 1, "time": self.SAT_1430,
             "data": {"header": {"config": {"model": "pro"}}}},
            {"type": "assistant/chunk", "seq": 2, "time": self.SAT_1430,
             "data": {"turn": 1, "step": 1, "chunk": {"type": "usage",
                      "usage": {"inputTokens": 1000, "outputTokens": 200}}}},
        ]
        out = hour_buckets(events)
        b = out["buckets"][0]
        self.assertEqual(b["date"], "2026-08-29")
        self.assertEqual(b["hour"], 14)
        self.assertFalse(b["is_peak"], "周六全天 = 空闲")
        self.assertEqual(b["peak_uncached_input_tokens"], 0)
        self.assertEqual(b["peak_output_tokens"], 0)

    def test_cross_midnight_events_keep_their_own_date(self):
        """跨午夜的事件按各自 event.time 归属，不归到 session 开始的日期。

        真实日志里一个会话从 23:50 跑到 00:10，00:10 的样本必须属于「第二天」
        而不是「session 那天」——日历渲染时 23 点和 0 点属于两个不同单元格。
        """
        # 北京 23:30 (UTC 15:30) + 0:30 (UTC 16:30 同日) → 同一 UTC 日但
        # 跨午夜；为更明确改用相差日期：23:50 北京 → 次日 00:10 北京。
        # 2026-08-25 23:50 北京 = 2026-08-25 15:50 UTC = 1787641800 秒
        # 2026-08-26 00:10 北京 = 2026-08-25 16:10 UTC = 1787643000 秒
        ts_late_night = self.TUE_LATE_NIGHT_2350  # 8/25 23:50 北京
        ts_just_after = self.WED_JUST_AFTER_0010  # 8/26 00:10 北京
        events = [
            {"type": "request/header", "seq": 1, "time": ts_late_night,
             "data": {"header": {"config": {"model": "pro"}}}},
            {"type": "assistant/chunk", "seq": 2, "time": ts_late_night,
             "data": {"turn": 1, "step": 1, "chunk": {"type": "usage",
                      "usage": {"inputTokens": 100, "outputTokens": 10}}}},
            {"type": "assistant/chunk", "seq": 3, "time": ts_just_after,
             "data": {"turn": 2, "step": 1, "chunk": {"type": "usage",
                      "usage": {"inputTokens": 200, "outputTokens": 20}}}},
        ]
        out = hour_buckets(events)
        self.assertEqual(len(out["buckets"]), 2)
        # 按 (date, hour) 排序
        self.assertEqual(out["buckets"][0]["date"], "2026-08-25")
        self.assertEqual(out["buckets"][0]["hour"], 23)
        self.assertEqual(out["buckets"][0]["uncached_input_tokens"], 100)
        self.assertEqual(out["buckets"][1]["date"], "2026-08-26")
        self.assertEqual(out["buckets"][1]["hour"], 0)
        self.assertEqual(out["buckets"][1]["uncached_input_tokens"], 200)

    def test_same_step_dedup_replaces_previous_contribution(self):
        """同 (turn, step) 后到者覆盖前到者——与 token_by_model 的替换语义一致。

        0 折 / 跨小时替换两种情形都验：折叠必须反映最终归属，而不是简单累加。
        """
        # 周二 14 点发 chunk，**15 点**发 message 覆盖（同一 step、跨小时）
        ts_14 = self.TUE_PEAK_1430
        ts_15 = self.TUE_PEAK_1430 + 3600 * 1000  # +1h
        events = [
            {"type": "request/header", "seq": 1, "time": ts_14,
             "data": {"header": {"config": {"model": "pro"}}}},
            # chunk 先到（14 点）→ 14 点桶 +1000
            {"type": "assistant/chunk", "seq": 2, "time": ts_14,
             "data": {"turn": 1, "step": 1, "chunk": {"type": "usage",
                      "usage": {"inputTokens": 1000, "outputTokens": 100}}}},
            # message 后到（15 点）→ 15 点桶 +1200，14 点桶 -1000
            {"type": "assistant/message", "seq": 3, "time": ts_15,
             "data": {"turn": 1, "step": 1,
                      "usage": {"inputTokens": 1200, "outputTokens": 120}}},
        ]
        out = hour_buckets(events)
        self.assertEqual(len(out["buckets"]), 2)
        # 14 点桶 = 0（chunk 的贡献被 message 替换走了）
        b14 = next(b for b in out["buckets"] if b["hour"] == 14)
        self.assertEqual(b14["uncached_input_tokens"], 0)
        self.assertEqual(b14["output_tokens"], 0)
        # 15 点桶 = message 的值（1200 / 120）
        b15 = next(b for b in out["buckets"] if b["hour"] == 15)
        self.assertEqual(b15["uncached_input_tokens"], 1200)
        self.assertEqual(b15["output_tokens"], 120)

    def test_missing_time_bucketed_as_unknown(self):
        """time 缺失的样本落 ("unknown", None) 桶，**不**进任何 (date, hour) 桶。

        否则下游做「过去 7 天合计」会把这些样本算成 1970-01-01 那一桶——
        真实数据可能因此凭空多出几万 token / 几百块钱。
        """
        events = [
            {"type": "request/header", "seq": 1, "time": 1001,
             "data": {"header": {"config": {"model": "pro"}}}},
            # time 缺失
            {"type": "assistant/chunk", "seq": 2,
             "data": {"turn": 1, "step": 1, "chunk": {"type": "usage",
                      "usage": {"inputTokens": 500, "outputTokens": 50}}}},
        ]
        out = hour_buckets(events)
        self.assertEqual(len(out["buckets"]), 1)
        b = out["buckets"][0]
        self.assertIsNone(b["date"])
        self.assertIsNone(b["hour"])
        self.assertIsNone(b["is_peak"])
        self.assertEqual(b["uncached_input_tokens"], 500)
        # 「unknown」桶沉底：calendar 渲染时直接过滤掉它，不参与每日合计

    def test_no_active_model_still_buckets(self):
        """无 request/header 的样本也能正常折叠——与 token_by_model 的
        'unknown' 模型桶是同一种降级：日志里没有归属信息就让它归「时间未知」，
        而不是拒绝整段 fold。"""
        events = [
            {"type": "assistant/chunk", "seq": 1, "time": self.TUE_PEAK_1430,
             "data": {"turn": 1, "step": 1, "chunk": {"type": "usage",
                      "usage": {"inputTokens": 700, "outputTokens": 70}}}},
        ]
        out = hour_buckets(events)
        self.assertEqual(len(out["buckets"]), 1)
        self.assertEqual(out["buckets"][0]["uncached_input_tokens"], 700)

    def test_reconciles_with_token_by_model(self):
        """同源不变量：所有 bucket 的 4 基础桶之和 == token_by_model 的 4 桶之和。

        证明 hour_buckets 与 token_by_model 共用同一套去重 / 折叠逻辑——
        任何一处改了同 (turn, step) 处理而另两处没改，对账立刻红。
        """
        events = [
            {"type": "request/header", "seq": 1, "time": self.TUE_PEAK_1430,
             "data": {"header": {"config": {"model": "pro"}}}},
            # 同 (1,1) → 只算后到
            {"type": "assistant/chunk", "seq": 2, "time": self.TUE_PEAK_1430,
             "data": {"turn": 1, "step": 1, "chunk": {"type": "usage",
                      "usage": {"inputTokens": 1000, "outputTokens": 200,
                                "cacheReadTokens": 300, "cacheWriteTokens": 0}}}},
            {"type": "assistant/message", "seq": 3, "time": self.TUE_PEAK_1430 + 1,
             "data": {"turn": 1, "step": 1,
                      "usage": {"inputTokens": 1200, "outputTokens": 250,
                                "cacheReadTokens": 300, "cacheWriteTokens": 0}}},
            # 切到空闲时段
            {"type": "assistant/chunk", "seq": 4, "time": self.TUE_OFFPEAK_0630,
             "data": {"turn": 2, "step": 1, "chunk": {"type": "usage",
                      "usage": {"inputTokens": 500, "outputTokens": 50}}}},
        ]
        hb = hour_buckets(events)
        tm = token_by_model(events)
        for key in ("uncached_input_tokens", "output_tokens",
                    "cache_read_tokens", "cache_write_tokens"):
            hour_total = sum(b[key] for b in hb["buckets"])
            model_total = sum(m[key] for m in tm["by_model"].values())
            self.assertEqual(
                hour_total, model_total,
                f"{key}: hour_buckets 之和 ({hour_total}) 必须等于 "
                f"token_by_model 按模型聚合 ({model_total})")

    def test_unreported_fields_only_when_samples_present(self):
        """0 个样本时不输出「未上报字段」——与 token_by_model 同条纪律
        （一个样本都没有就不下任何关于 harness 能力的断言）。"""
        # 只有 request/header，没有任何 usage 样本
        out = hour_buckets([
            {"type": "request/header", "seq": 1, "time": 1000,
             "data": {"header": {"config": {"model": "pro"}}}},
        ])
        self.assertEqual(out["buckets"], [])
        self.assertEqual(out["unreported_fields"], [])

    def test_missing_field_is_null_not_zero(self):
        """缺字段落 None / 0 桶里没值——与 _buckets_from 同条纪律
        （harness 没报 ≠ 测到 0；calendar 渲染时缺字段的格子不画假数据）。"""
        events = [
            {"type": "request/header", "seq": 1, "time": self.TUE_PEAK_1430,
             "data": {"header": {"config": {"model": "pro"}}}},
            # 缺 cacheReadTokens / cacheWriteTokens
            {"type": "assistant/chunk", "seq": 2, "time": self.TUE_PEAK_1430,
             "data": {"turn": 1, "step": 1, "chunk": {"type": "usage",
                      "usage": {"inputTokens": 100, "outputTokens": 10}}}},
        ]
        out = hour_buckets(events)
        b = out["buckets"][0]
        self.assertEqual(b["uncached_input_tokens"], 100)
        # unreported_fields 标记执行环境真的没报这两个字段——calendar 渲染时
        # 据此决定要不要画「缓存读 / 写 0」这种会误导的数字
        self.assertIn("cacheReadTokens", out["unreported_fields"])
        self.assertIn("cacheWriteTokens", out["unreported_fields"])


class TestTokenByDateModel(unittest.TestCase):
    """`token_by_date_model` —— `token_by_model` 的模型维 × `hour_buckets`
    的日期维。Rust 侧 `usage.rs::token_by_date_model` 是单一真相源，那边的
    `token_by_date_model_python_rust_byte_for_byte_parity` 逐字节看守两份
    实现。时间戳常量直接照抄 `TestHourBuckets`（不继承它——继承会让
    unittest 把父类那批 hour_buckets 专属测试在这个类名下重跑一遍），两者
    共享同一条时区/高峰规则，用同一批固定时间戳能直接对照。"""

    TUE_PEAK_1430 = TestHourBuckets.TUE_PEAK_1430
    TUE_OFFPEAK_0630 = TestHourBuckets.TUE_OFFPEAK_0630
    TUE_LATE_NIGHT_2350 = TestHourBuckets.TUE_LATE_NIGHT_2350
    WED_JUST_AFTER_0010 = TestHourBuckets.WED_JUST_AFTER_0010

    def test_python_rust_byte_for_byte_parity(self):
        """与 Rust `usage.rs` 里同名测试硬编码的**同一个**期望串对照。

        两侧各自钉一份、不是一边跟着另一边跑——任一实现改了折叠语义或
        输出顺序（日期升序 / 模型首现顺序），两边有一边会红。
        """
        events = [
            {"type": "request/header", "seq": 1, "time": self.TUE_LATE_NIGHT_2350,
             "data": {"header": {"config": {"model": "pro"}}}},
            {"type": "assistant/chunk", "seq": 2, "time": self.TUE_LATE_NIGHT_2350,
             "data": {"turn": 1, "step": 1, "chunk": {"type": "usage",
                      "usage": {"inputTokens": 1000, "outputTokens": 100,
                                "cacheReadTokens": 50, "cacheWriteTokens": 0}}}},
            {"type": "assistant/message", "seq": 3, "time": self.WED_JUST_AFTER_0010,
             "data": {"turn": 1, "step": 1,
                      "usage": {"inputTokens": 1200, "outputTokens": 120,
                                "cacheReadTokens": 60, "cacheWriteTokens": 0}}},
            {"type": "request/header", "seq": 4, "time": self.WED_JUST_AFTER_0010,
             "data": {"header": {"config": {"model": "flash"}}}},
            {"type": "assistant/chunk", "seq": 5, "time": self.WED_JUST_AFTER_0010,
             "data": {"turn": 2, "step": 1, "chunk": {"type": "usage",
                      "usage": {"inputTokens": 500, "outputTokens": 50}}}},
        ]
        self.assertEqual(
            json.dumps(token_by_date_model(events), ensure_ascii=False,
                       separators=(",", ":")),
            '{"2026-08-25":{"pro":{"uncached_input_tokens":0,"output_tokens":0,'
            '"cache_read_tokens":0,"cache_write_tokens":0,'
            '"peak_uncached_input_tokens":0,"peak_output_tokens":0,'
            '"peak_cache_read_tokens":0,"peak_cache_write_tokens":0}},'
            '"2026-08-26":{"pro":{"uncached_input_tokens":1200,"output_tokens":120,'
            '"cache_read_tokens":60,"cache_write_tokens":0,'
            '"peak_uncached_input_tokens":0,"peak_output_tokens":0,'
            '"peak_cache_read_tokens":0,"peak_cache_write_tokens":0},'
            '"flash":{"uncached_input_tokens":500,"output_tokens":50,'
            '"cache_read_tokens":0,"cache_write_tokens":0,'
            '"peak_uncached_input_tokens":0,"peak_output_tokens":0,'
            '"peak_cache_read_tokens":0,"peak_cache_write_tokens":0}},'
            '"by_source":{"2026-08-25":{"unspecified":{"pro":{"uncached_input_tokens":0,'
            '"output_tokens":0,"cache_read_tokens":0,"cache_write_tokens":0,'
            '"peak_uncached_input_tokens":0,"peak_output_tokens":0,'
            '"peak_cache_read_tokens":0,"peak_cache_write_tokens":0}}},'
            '"2026-08-26":{"unspecified":{"pro":{"uncached_input_tokens":1200,'
            '"output_tokens":120,"cache_read_tokens":60,"cache_write_tokens":0,'
            '"peak_uncached_input_tokens":0,"peak_output_tokens":0,'
            '"peak_cache_read_tokens":0,"peak_cache_write_tokens":0},'
            '"flash":{"uncached_input_tokens":500,"output_tokens":50,'
            '"cache_read_tokens":0,"cache_write_tokens":0,'
            '"peak_uncached_input_tokens":0,"peak_output_tokens":0,'
            '"peak_cache_read_tokens":0,"peak_cache_write_tokens":0}}}}}')

    def test_reconciles_with_hour_buckets_and_token_by_model(self):
        """同源不变量：按 (date, model) 折的四桶之和，必须同时等于
        `hour_buckets` 的四桶之和与 `token_by_model` 的四桶之和——三者是
        同一份 usage 事件的三种切法，任何一种切法漏计/多计都会在这里露出来。
        """
        events = [
            {"type": "request/header", "seq": 1, "time": self.TUE_PEAK_1430,
             "data": {"header": {"config": {"model": "pro"}}}},
            {"type": "assistant/chunk", "seq": 2, "time": self.TUE_PEAK_1430,
             "data": {"turn": 1, "step": 1, "chunk": {"type": "usage",
                      "usage": {"inputTokens": 1000, "outputTokens": 200,
                                "cacheReadTokens": 300, "cacheWriteTokens": 50}}}},
            {"type": "request/header", "seq": 3, "time": self.TUE_OFFPEAK_0630,
             "data": {"header": {"config": {"model": "flash"}}}},
            {"type": "assistant/chunk", "seq": 4, "time": self.TUE_OFFPEAK_0630,
             "data": {"turn": 2, "step": 1, "chunk": {"type": "usage",
                      "usage": {"inputTokens": 500, "outputTokens": 100}}}},
        ]

        def total4(bucket):
            return (bucket["uncached_input_tokens"] + bucket["output_tokens"]
                    + bucket["cache_read_tokens"] + bucket["cache_write_tokens"])

        hb_total = sum(total4(b) for b in hour_buckets(events)["buckets"])
        tbm_total = sum(total4(b) for b in token_by_model(events)["by_model"].values())
        # by_source 是顶层并列键、形状是 {source: {model}} 不是 {model: 桶}，
        # 不能当日子折 total——跳过它，主输出的总量不变。
        bdm_total = sum(total4(b) for date, day in token_by_date_model(events).items()
                        if date != "by_source" for b in day.values())
        self.assertEqual(hb_total, tbm_total)
        self.assertEqual(bdm_total, tbm_total)

    def test_splits_by_model_within_the_same_date(self):
        """同一天两个模型各自归桶,不混成一个'unknown'或互相覆盖。"""
        events = [
            {"type": "request/header", "seq": 1, "time": self.TUE_PEAK_1430,
             "data": {"header": {"config": {"model": "deepseek-v4-pro"}}}},
            {"type": "assistant/chunk", "seq": 2, "time": self.TUE_PEAK_1430,
             "data": {"turn": 1, "step": 1, "chunk": {"type": "usage",
                      "usage": {"inputTokens": 1000, "outputTokens": 100}}}},
            {"type": "request/header", "seq": 3, "time": self.TUE_OFFPEAK_0630,
             "data": {"header": {"config": {"model": "deepseek-v4-flash"}}}},
            {"type": "assistant/chunk", "seq": 4, "time": self.TUE_OFFPEAK_0630,
             "data": {"turn": 2, "step": 1, "chunk": {"type": "usage",
                      "usage": {"inputTokens": 500, "outputTokens": 50}}}},
        ]
        out = token_by_date_model(events)
        # by_source 是顶层并列键，不是日期——日期键仍只有一个。
        self.assertEqual([k for k in out if k != "by_source"], ["2026-08-25"])
        day = out["2026-08-25"]
        self.assertEqual(day["deepseek-v4-pro"]["uncached_input_tokens"], 1000)
        self.assertEqual(day["deepseek-v4-flash"]["uncached_input_tokens"], 500)

    def test_cross_midnight_session_splits_by_model_into_two_dates(self):
        """跨零点的会话：同一个模型在两天各自归桶——这正是 state.merge_month
        文档注释里 `session-e4b0be69` 那类真实回归的最小复现:整段 by_model
        绝不能被压扁成一天。"""
        events = [
            {"type": "request/header", "seq": 1, "time": self.TUE_LATE_NIGHT_2350,
             "data": {"header": {"config": {"model": "pro"}}}},
            {"type": "assistant/chunk", "seq": 2, "time": self.TUE_LATE_NIGHT_2350,
             "data": {"turn": 1, "step": 1, "chunk": {"type": "usage",
                      "usage": {"inputTokens": 100, "outputTokens": 10}}}},
            {"type": "assistant/chunk", "seq": 3, "time": self.WED_JUST_AFTER_0010,
             "data": {"turn": 2, "step": 1, "chunk": {"type": "usage",
                      "usage": {"inputTokens": 200, "outputTokens": 20}}}},
        ]
        out = token_by_date_model(events)
        self.assertEqual(sorted(k for k in out if k != "by_source"),
                         ["2026-08-25", "2026-08-26"])
        self.assertEqual(out["2026-08-25"]["pro"]["uncached_input_tokens"], 100)
        self.assertEqual(out["2026-08-26"]["pro"]["uncached_input_tokens"], 200)

    def test_same_step_dedup_replaces_previous_date_contribution(self):
        """同 (turn, step) 后到者覆盖前到者，即使覆盖跨了日期边界——与
        `hour_buckets`/`token_by_model` 的替换语义一致（同一笔请求不能
        既算进旧日期又算进新日期）。"""
        events = [
            {"type": "request/header", "seq": 1, "time": self.TUE_LATE_NIGHT_2350,
             "data": {"header": {"config": {"model": "pro"}}}},
            {"type": "assistant/chunk", "seq": 2, "time": self.TUE_LATE_NIGHT_2350,
             "data": {"turn": 1, "step": 1, "chunk": {"type": "usage",
                      "usage": {"inputTokens": 1000, "outputTokens": 100}}}},
            # message 后到，落到第二天，同 (turn, step) → 应扣掉前一天的贡献
            {"type": "assistant/message", "seq": 3, "time": self.WED_JUST_AFTER_0010,
             "data": {"turn": 1, "step": 1,
                      "usage": {"inputTokens": 1200, "outputTokens": 120}}},
        ]
        out = token_by_date_model(events)
        # 与 hour_buckets/token_by_model 同一条约定：被替换扣光的桶留在
        # 结果里但归零，不是把 key 整个删掉（hour_buckets 自己的
        # test_same_step_dedup_replaces_previous_contribution 断言的也是
        # 「桶里的值是 0」，不是「桶不存在」）。
        self.assertEqual(out["2026-08-25"]["pro"]["uncached_input_tokens"], 0,
                          "旧日期的贡献应该被替换扣光")
        self.assertEqual(out["2026-08-26"]["pro"]["uncached_input_tokens"], 1200)

    def test_missing_time_produces_no_date_bucket(self):
        """time 缺失的样本不进任何日期桶——与 hour_buckets 同一条纪律，
        否则历史回填会把这些样本记进 `_today_key()` 或 1970-01-01。"""
        events = [
            {"type": "request/header", "seq": 1, "time": 1001,
             "data": {"header": {"config": {"model": "pro"}}}},
            {"type": "assistant/chunk", "seq": 2,
             "data": {"turn": 1, "step": 1, "chunk": {"type": "usage",
                      "usage": {"inputTokens": 500, "outputTokens": 50}}}},
        ]
        self.assertEqual(token_by_date_model(events), {})

    def test_empty_input_returns_empty_dict(self):
        self.assertEqual(token_by_date_model([]), {})


class TestUsageShapedTokens(unittest.TestCase):
    """`usage_shaped_tokens` —— 残差哨兵的判据。只认 `_SAMPLE_FIELDS` 四个
    名字，故意不做宽泛匹配（否则会在 `maxTokens`/`shadowedTokenCount` 这类
    配置字段上误报）。Rust 侧 `usage.rs::usage_shaped_tokens` 是平行实现，
    差分由 `TestCompactionUsage` 里的 `token_by_model`/`_is_usage_event`
    集成测试间接看守（哨兵本身不进任何 `--json` 输出，没有独立的
    byte-for-byte 串可钉）。
    """

    def test_finds_nested_usage_fields(self):
        node = {"data": {"usage": {"inputTokens": 100, "outputTokens": 20}}}
        self.assertEqual(usage_shaped_tokens(node), 120)

    def test_returns_none_when_no_known_field_present(self):
        # `maxTokens`/`shadowedTokenCount` 不在 _SAMPLE_FIELDS 里——不能把
        # 配置/统计字段误当成用量，否则哨兵会在每条 compaction/start 上
        # 假报警。
        node = {"maxTokens": 8192, "shadowedTokenCount": 12345}
        self.assertIsNone(usage_shaped_tokens(node))

    def test_sums_multiple_occurrences_across_the_tree(self):
        node = {"a": {"inputTokens": 10}, "b": [{"outputTokens": 5}, {"cacheReadTokens": 3}]}
        self.assertEqual(usage_shaped_tokens(node), 18)

    def test_ignores_non_integer_values(self):
        # 畸形/字符串值不参与求和，也不让整个扫描崩溃。
        node = {"inputTokens": "not-a-number", "outputTokens": 7}
        self.assertEqual(usage_shaped_tokens(node), 7)

    def test_bare_scalar_returns_none(self):
        self.assertIsNone(usage_shaped_tokens("just a string"))
        self.assertIsNone(usage_shaped_tokens(42))
        self.assertIsNone(usage_shaped_tokens(None))


class TestCompactionUsage(unittest.TestCase):
    """`compaction/summary` 的 usage 提取——真实回归：DSH 的
    `compaction/summary` 带 `data.usage`（实测
    `{inputTokens:462, outputTokens:3520, cacheReadTokens:245760}`）且自带
    `model`/`provider`，但因为 ① 不在 `_usage_sample` 的类型白名单里、
    ② 没有 `turn`/`step`（compaction 由 `sourceCommandId` 触发，不属于任何
    turn），被静默丢弃——用户在菜单栏上肉眼发现"今天有消耗但日历是 0"
    才暴露。全量扫描 38 个真实会话文件，唯一的漏算就是这个类型
    （2 条,853,309 token，已按 post_fork 去重上游副本）。
    """

    def _compaction_event(self, compaction_id, input_tokens=462, output_tokens=3520,
                          cache_read=245760, model="deepseek-v4-flash",
                          provider="deepseek-official", time_ms=1787813784275):
        return {
            "type": "compaction/summary", "seq": 1, "time": time_ms,
            "data": {
                "compactionId": compaction_id,
                "sourceCommandId": "cmd-1",
                "model": model, "provider": provider,
                "usage": {"inputTokens": input_tokens, "outputTokens": output_tokens,
                          "cacheReadTokens": cache_read},
            },
        }

    def test_token_by_model_counts_compaction_usage(self):
        events = [self._compaction_event("c1")]
        out = token_by_model(events)
        self.assertEqual(out["unaccounted_usage"], [],
                         "compaction/summary 现在应该被 _usage_sample 直接接住")
        self.assertIn("deepseek-v4-flash", out["by_model"])
        b = out["by_model"]["deepseek-v4-flash"]
        self.assertEqual(b["uncached_input_tokens"], 462)
        self.assertEqual(b["output_tokens"], 3520)
        self.assertEqual(b["cache_read_tokens"], 245760)

    def test_compaction_model_overrides_currently_active_model(self):
        """compaction 自带 model/provider，不能沿用 request/header 追踪的
        "当前激活模型"——真实实测：会话主体用 pro，compaction 走的是
        flash/deepseek-official，两者是不同的供应商价目表。"""
        events = [
            {"type": "request/header", "seq": 0, "time": 1,
             "data": {"header": {"config": {"model": "deepseek-v4-pro",
                                             "provider": "shengsuanyun"}}}},
            self._compaction_event("c1", model="deepseek-v4-flash",
                                   provider="deepseek-official"),
        ]
        out = token_by_model(events)
        self.assertEqual(set(out["by_model"].keys()), {"deepseek-v4-flash"},
                         "compaction 不该被记进'当前激活'的 pro,必须用它自己的 flash")
        self.assertEqual(out["providers"]["deepseek-v4-flash"], "deepseek-official")
        self.assertEqual(out["providers"]["deepseek-v4-pro"], "shengsuanyun")

    def test_same_compaction_id_deduped_across_fork_copies(self):
        """同一个 compactionId 出现两次（真实撞见过：一次 compaction 被 fork
        复制进 4 个会话文件）——`token_by_model` 的"同 (turn,step) 值相同则
        跳过"分支应该只算一次，不是两次。"""
        ev = self._compaction_event("same-id")
        out = token_by_model([ev, dict(ev, seq=2)])
        self.assertEqual(out["by_model"]["deepseek-v4-flash"]["uncached_input_tokens"], 462,
                         "同一个 compactionId 重复出现，token 不能翻倍")

    def test_different_compaction_ids_do_not_collide(self):
        """不同 compactionId 必须落进独立的去重槽——不能因为都映射到同一个
        身份而互相覆盖，导致只剩最后一次的量。"""
        events = [
            self._compaction_event("id-1", input_tokens=100),
            self._compaction_event("id-2", input_tokens=200),
        ]
        out = token_by_model(events)
        self.assertEqual(out["by_model"]["deepseek-v4-flash"]["uncached_input_tokens"], 300,
                         "两次不同的 compaction 都应该被计入，不能互相覆盖")

    def test_missing_compaction_id_does_not_crash(self):
        """缺 compactionId 时退化但不崩——极端情况，真实语料没出现过。"""
        events = [self._compaction_event(None)]
        out = token_by_model(events)
        self.assertIn("deepseek-v4-flash", out["by_model"])

    def test_request_metrics_reports_turn_and_step_as_none_for_compaction(self):
        """compaction 的 (turn, step) 是内部去重用的哈希身份，不是真实存在的
        turn 号——报给调用方的行必须诚实写 None，不能把去重实现细节泄漏成
        一个看起来像真实 turn 的负数。"""
        rows = request_metrics([self._compaction_event("c1")])
        self.assertEqual(len(rows), 1)
        self.assertIsNone(rows[0]["turn"])
        self.assertIsNone(rows[0]["step"])
        self.assertEqual(rows[0]["model"], "deepseek-v4-flash")

    def test_token_by_date_model_attributes_compaction_to_its_own_date_and_model(self):
        out = token_by_date_model([self._compaction_event("c1", time_ms=1787813784275)])
        # 1787813784275 ms → 2026-08-27（北京时间），与真实那次 compact 一致。
        self.assertIn("2026-08-27", out)
        self.assertEqual(
            out["2026-08-27"]["deepseek-v4-flash"]["uncached_input_tokens"], 462)

    def test_missing_usage_field_is_not_accounted_but_is_sentinelled(self):
        """`compaction/start`/`compaction/end` 没有 usage 字段——不该被
        `_usage_sample` 接住,也不该触发哨兵(它们的 payload 里根本没有
        `_SAMPLE_FIELDS` 那四个名字)。"""
        events = [
            {"type": "compaction/start", "seq": 1, "time": 1,
             "data": {"compactionId": "c1", "sourceCommandId": "cmd-1"}},
            {"type": "compaction/end", "seq": 2, "time": 2,
             "data": {"compactionId": "c1", "sourceCommandId": "cmd-1"}},
        ]
        out = token_by_model(events)
        self.assertEqual(out["by_model"], {})
        self.assertEqual(out["unaccounted_usage"], [])


if __name__ == "__main__":
    unittest.main(verbosity=2)


class TestForkBoundary(unittest.TestCase):
    """会话分叉边界 —— Rust 侧 `util.rs::fork_tests` 要对齐的目标。

    钉的是一个**真实的重复计费缺陷**：DSH 里从已有会话「branch into new
    conversation」派生的新会话，日志前半段是上游历史的原样拷贝（含上游当时的
    usage 记录）。实测 session-e4b0be69 显示 ¥1113.66，其中 ¥680.36（61%）是
    上游那本账里已经算过一次的钱。
    """

    @staticmethod
    def _ev(t, seq):
        return {"type": t, "seq": seq, "data": {}}

    @staticmethod
    def _header(seed=None):
        return {"type": "session", "seq": None,
                "data": {"seedLength": seed} if seed is not None else {}}

    def test_boundary_comes_from_header_seed_length(self):
        evs = [self._header(3), self._ev("tool/call", 1),
               self._ev("tool/call", 2), self._ev("tool/call", 4)]
        self.assertEqual(fork_boundary(evs), 3)
        self.assertEqual([e["seq"] for e in post_fork(evs) if e["seq"] is not None], [4],
                         "分叉前的 seq 1/2 必须滤掉")

    def test_end_seed_event_is_not_a_boundary(self):
        """**`session/end-seed` 不是分叉边界。**

        初版就是那么判的，还在一个已分叉的会话上验证通过——那是巧合。这个标记
        的是「一段续种结束」，会话每次被唤醒都会触发：真实日志 session-6b47acc7
        完全没分叉（header 无 seedLength），唯一的 end-seed 落在**最后一个事件**
        上。按事件判会把整个会话丢光，UI 上费用/上下文/常驻前缀/子代理全变
        「不可用」——这个回归是用户在真机上发现的。
        """
        # **没有 header 标记事件**——适配器只在 seedLength > 0 时才合成一个，
        # 未分叉的会话流里压根没有它。夹具必须是这个形状，否则 header 分支会
        # 先 return，测试永远走不到 end-seed，红-绿验证也会假绿。
        evs = [self._ev("tool/call", 1), self._ev("tool/call", 2),
               self._ev("session/end-seed", 3)]
        self.assertIsNone(fork_boundary(evs), "没有 seedLength 就是没分叉")
        self.assertEqual(len(post_fork(evs)), 3, "未分叉的会话一个事件都不能滤")

    def test_missing_header_or_field_means_no_fork(self):
        """没有日志头（或头里没这个字段）时同样不滤——子代理会话就是这样。"""
        no_header = [self._ev("tool/call", 0), self._ev("tool/call", 1)]
        self.assertIsNone(fork_boundary(no_header))
        self.assertEqual(len(post_fork(no_header)), 2)
        no_field = [self._header(), self._ev("tool/call", 1)]
        self.assertIsNone(fork_boundary(no_field))
        self.assertEqual(len(post_fork(no_field)), 2)

    def test_zero_seed_length_is_not_a_boundary(self):
        """0 或负数不是有效边界——那是「没有续种」，不是「续种了 0 个事件」。"""
        self.assertIsNone(fork_boundary([self._header(0)]))
        self.assertIsNone(fork_boundary([self._header(-1)]))

    def test_missing_seq_survives(self):
        """缺 seq 是「没上报」，不是「在分叉之前」——不得静默丢掉。"""
        evs = [self._header(5), {"type": "tool/call", "data": {}}, self._ev("tool/call", 6)]
        self.assertEqual(len(post_fork(evs)), 3)


class TestPeakSlotWeekday(unittest.TestCase):
    """高峰/空闲时段判定 —— 真实账单打出来的回归 + 通用性证明。

    起因：2026-08-23（周日）14:45 那次会话，29 次请求的 token 数与 DeepSeek
    账单逐位吻合，金额却正好 ×2.0000。原来的判定只看小时不看星期，把周日下午
    当成了高峰，而每一档 peak 恰好是 off_peak 的两倍。

    更值得记的是**它为什么一直没被发现**：在这之前唯一对过账的会话跑在 21–22
    点，全程走空闲分支——高峰这条路径从来没被任何真实账单验证过。
    """

    def test_weekend_is_always_off_peak(self):
        """周末全天空闲，即使落在 9–12 / 14–18 的钟点内。"""
        from agent_vitals.usage import _is_peak_slot
        # 北京时间的确定性时间戳
        self.assertTrue(_is_peak_slot(1787277600000), "周五 10:00 是高峰")
        self.assertTrue(_is_peak_slot(1787554800000), "周一 15:00 是高峰")
        self.assertFalse(_is_peak_slot(1787364000000), "周六 10:00 —— 周末全天空闲")
        self.assertFalse(_is_peak_slot(1787464800000), "周日 14:00 —— 打出这个 bug 的那一刻")
        self.assertFalse(_is_peak_slot(1787572800000), "周一 20:00 在窗口外")

    def test_weekday_formula_matches_stdlib_across_130_years(self):
        """星期换算是**纯算术**，不是查表，也没有写死任何一个周末。

        这条是对「能不能一直准」的正面回答：拿标准库当参照，逐日核对
        1970→2100 的每一天（各取 00:00 / 12:00 / 23:59 三个时刻）。闰年、
        世纪边界、跨年全都覆盖——因为算法根本不做日历运算，只在绝对秒数上
        做整除，这些情况对它不存在。
        """
        import datetime
        from agent_vitals.usage import _beijing_weekday
        BJ = 8 * 3600
        epoch = datetime.datetime(1970, 1, 1)
        d, end = epoch, datetime.datetime(2100, 1, 1)
        checked = 0
        while d < end:
            base = int((d - epoch).total_seconds()) * 1000 - BJ * 1000
            for off in (0, 12 * 3600 * 1000, 86399 * 1000):
                ms = base + off
                ref = datetime.datetime.utcfromtimestamp(ms / 1000 + BJ).weekday()
                self.assertEqual(_beijing_weekday(ms), ref,
                                 "北京时间 %s 星期算错" % datetime.datetime.utcfromtimestamp(ms / 1000 + BJ))
                checked += 1
            d += datetime.timedelta(days=1)
        self.assertGreater(checked, 140000, "覆盖面不应缩水")

    def test_negative_timestamps_before_1970(self):
        """1970 之前的负时间戳也要对——Python 的 // 和 % 本身就是向下取整/
        取正余数，Rust 侧用 div_euclid/rem_euclid 取得同样语义。"""
        import datetime
        from agent_vitals.usage import _beijing_weekday
        BJ = 8 * 3600
        for year in (1969, 1960, 1900):
            dt = datetime.datetime(year, 3, 1)
            ms = int((dt - datetime.datetime(1970, 1, 1)).total_seconds()) * 1000 - BJ * 1000
            ref = (datetime.datetime(1970, 1, 1) + datetime.timedelta(
                milliseconds=ms + BJ * 1000
            )).weekday()
            self.assertEqual(_beijing_weekday(ms), ref, "%d 年算错" % year)


# ──────────────────────────── P4 Codex ────────────────────────────
# 这些期望值对应 Rust 侧 `codex_session.rs` / `codex_evidence.rs` 的
# `#[cfg(test)]`，两边的数字必须一致（差分门 both() 兜底的是子命令输出，
# 这里是纯函数层的逐个数字钉死）。

def _cx_meta(mode="legacy", cli="0.146.0", sid="s1"):
    return {"type": "session_meta", "timestamp": "2026-07-25T11:19:35Z",
            "payload": {"session_id": sid, "id": sid, "history_mode": mode,
                        "cli_version": cli}}


def _cx_turn(model="gpt-5.6-sol", roots=("/repo",)):
    return {"type": "turn_context", "timestamp": "2026-07-25T11:19:36Z",
            "payload": {"model": model, "workspace_roots": list(roots),
                        "approval_policy": "on-request"}}


def _cx_event(event_type, extra=None):
    payload = {"type": event_type, "turn_id": "t1"}
    if extra:
        payload.update(extra)
    return {"type": "event_msg", "timestamp": 0, "payload": payload}


def _cx_item(item):
    return {"type": "event_msg", "timestamp": 0,
            "payload": {"type": "item_completed", "turn_id": "t1", "item": item}}


def _cx_response(response_type):
    return {"type": "response_item", "timestamp": 0, "payload": {"type": response_type}}


def _cx_user_message():
    # 真实线格式（session 01a029cb 实测 15 条）：payload.type="message" +
    # role="user"，正文在 content[].text（数组）——计数只看 role 存在性。
    return {"type": "response_item", "timestamp": 0,
            "payload": {"type": "message", "role": "user",
                        "content": [{"type": "input_text", "text": "你好"}]}}


class TestCodexSessionParse(unittest.TestCase):
    """`parse_codex_session_log` 的 provenance 抽取——字段路径来自真实语料
    （session_meta 的 model 恒 null，model 只从 turn_context 取）。"""

    def test_provenance_from_meta_and_turn(self):
        text = "\n".join(json.dumps(x) for x in [
            _cx_meta("legacy", "0.146.0-alpha.3.1", "s1"),
            _cx_turn("gpt-5.6-sol", ("/repo",)),
            _cx_event("task_started"),
            {"type": "future_record", "timestamp": 0, "payload": {}},
        ]) + "\n"
        parsed = parse_codex_session_log(text)
        self.assertEqual(parsed["session_id"], "s1")
        self.assertEqual(parsed["history_mode"], "legacy")
        self.assertEqual(parsed["cli_version"], "0.146.0-alpha.3.1")
        self.assertEqual(parsed["model"], "gpt-5.6-sol")
        self.assertEqual(parsed["workspace_roots"], ["/repo"])
        self.assertFalse(parsed["degraded"])
        # 未知记录类型原样保留，解析器不判损坏（derive_coverage 才认）。
        self.assertEqual(len(parsed["items"]), 4)
        self.assertEqual(parsed["items"][3]["type"], "future_record")

    def test_model_and_roots_take_latest_turn_context(self):
        text = "\n".join(json.dumps(x) for x in [
            _cx_meta("paginated", "0.149.0-alpha.4", "s1"),
            _cx_turn("gpt-5.6-sol", ("/old",)),
            _cx_turn("gpt-5.6-pro", ("/repo", "/data")),
        ]) + "\n"
        parsed = parse_codex_session_log(text)
        self.assertEqual(parsed["model"], "gpt-5.6-pro")
        self.assertEqual(parsed["workspace_roots"], ["/repo", "/data"])
        self.assertEqual(parsed["history_mode"], "paginated")

    def test_empty_is_missing_header(self):
        parsed = parse_codex_session_log("")
        self.assertEqual(parsed["degraded"], "missing-header")
        self.assertIsNone(parsed["items"], "降级时 items 必须保持 None，不是空列表")

    def test_non_json_mid_file_degrades_not_zero(self):
        # 必须逐行拼——`"garbage line"` 经 json.dumps 会变成合法 JSON 字符串，
        # 只有裸行 `garbage line` 才会让 json.loads 抛错触发降级。
        text = (json.dumps(_cx_meta()) + "\n" + json.dumps(_cx_event("task_started"))
                + "\n" + "garbage line\n")
        parsed = parse_codex_session_log(text)
        self.assertEqual(parsed["degraded"], "non-json")
        self.assertIsNone(parsed["items"])

    def test_no_session_meta_is_not_corruption(self):
        # §14.4：只靠存在性探测降级。有行、可解析、但没有 session_meta 不算
        # 损坏——provenance 如实给 None，items 照常收。
        parsed = parse_codex_session_log(json.dumps(_cx_event("task_started")) + "\n")
        self.assertFalse(parsed["degraded"])
        self.assertIsNone(parsed["session_id"])
        self.assertEqual(len(parsed["items"]), 1)

    def test_session_id_backfills_from_id_when_session_id_missing(self):
        meta = _cx_meta()
        del meta["payload"]["session_id"]
        parsed = parse_codex_session_log(json.dumps(meta) + "\n")
        self.assertEqual(parsed["session_id"], "s1")

    def test_session_meta_wholesale_overwrites_on_repeat(self):
        # Rust 是整体替换：后一条 session_meta 缺 history_mode 会把前一条的
        # 值重置成 None——Python 的 `payload.get(...) or ...` 惯用写法会漏掉
        # 这个语义，必须显式判 isinstance。
        meta2 = _cx_meta()
        del meta2["payload"]["history_mode"]
        text = "\n".join(json.dumps(x) for x in [_cx_meta("legacy"), meta2]) + "\n"
        parsed = parse_codex_session_log(text)
        self.assertIsNone(parsed["history_mode"])


class TestCodexCoverage(unittest.TestCase):
    """`derive_coverage` 的映射表——逐条对应 §13 的 Codex 两列。每个期望值
    都是数字，不是范围（Rust `codex_evidence.rs` 的 `#[cfg(test)]` 钉同一批）。"""

    def _signals(self, items):
        signals, coverage, _unknown = derive_coverage(items)
        return signals, coverage

    def test_legacy_vocabulary_counts(self):
        items = [
            _cx_event("task_started"),
            _cx_event("mcp_tool_call_end"),
            _cx_event("web_search_end"),
            _cx_response("custom_tool_call"),
            _cx_response("custom_tool_call_output"),
            _cx_event("patch_apply_end"),
            _cx_event("context_compacted"),
            _cx_event("sub_agent_activity"),
            _cx_event("thread_settings_applied", {"thread_settings": {"approval_policy": "Never"}}),
            _cx_event("token_count", {"info": {"model_context_window": 128000}}),
            _cx_event("task_complete"),
            _cx_turn(),  # turn_context 顶层也带 approval_policy
        ]
        signals, cov = self._signals(items)
        self.assertEqual(cov["ToolCalls"]["measured"], 3)
        self.assertEqual(cov["ToolResults"]["measured"], 1)
        self.assertEqual(cov["TurnBoundaries"]["measured"], 2)
        self.assertEqual(cov["FileMutations"]["lossy"], 1)
        self.assertEqual(cov["FileMutations"]["measured"], 0, "patch_apply_end 只进 lossy 桶")
        self.assertEqual(cov["Compaction"]["measured"], 1)
        self.assertEqual(cov["SubagentSpawns"]["measured"], 1)
        self.assertEqual(cov["ApprovalPolicy"]["measured"], 2, "thread_settings + turn_context")
        self.assertEqual(cov["Usage"]["measured"], 1)
        self.assertEqual(cov["ContextWindow"]["measured"], 1)
        self.assertEqual(cov["UsageAggregate"]["derived"], 1)
        self.assertEqual(cov["SkillInvocations"]["derived"], 1)
        # Paginated-only 的信号全零、不进 signals：
        self.assertEqual(cov["Hooks"], {"measured": 0, "derived": 0, "lossy": 0, "unmetered": 0})
        self.assertNotIn("Hooks", signals)
        self.assertEqual(cov["ApprovalDecisions"]["measured"], 0)

    def test_paginated_vocabulary_counts(self):
        items = [
            _cx_item({"type": "CommandExecution", "duration": 1234, "stdout": "hi"}),
            _cx_item({"type": "McpToolCall"}),
            _cx_item({"type": "DynamicToolCall"}),
            _cx_item({"type": "FileChange", "auto_approved": True}),
            _cx_item({"type": "SubAgentActivity", "agent_thread_id": "a"}),
            _cx_item({"type": "ContextCompaction"}),
            _cx_item({"type": "HookPrompt"}),
            _cx_response("function_call"),
            _cx_response("function_call_output"),
            _cx_turn("gpt-5.6-pro", ("/repo", "/data")),
        ]
        signals, cov = self._signals(items)
        self.assertEqual(cov["ToolCalls"]["measured"], 4, "CommandExecution + Mcp + Dynamic + function_call")
        self.assertEqual(cov["ToolResults"]["measured"], 2, "CommandExecution + function_call_output")
        self.assertEqual(cov["FileMutations"]["measured"], 1, "FileChange 进 measured 桶，不是 lossy")
        self.assertEqual(cov["ApprovalDecisions"]["measured"], 1, "FileChange.auto_approved")
        self.assertEqual(cov["Hooks"]["measured"], 1)
        self.assertEqual(cov["Compaction"]["measured"], 1)
        self.assertEqual(cov["SubagentSpawns"]["measured"], 1)
        self.assertIn("Hooks", signals)
        self.assertIn("ApprovalDecisions", signals)

    def test_file_change_without_auto_approved_is_not_approval_evidence(self):
        # 真实语料里 FileChange 全都不带 auto_approved（n=60）——不能因此把
        # ApprovalDecisions 误判成有覆盖。
        items = [_cx_item({"type": "FileChange", "status": "applied"})]
        signals, cov = self._signals(items)
        self.assertEqual(cov["ApprovalDecisions"]["measured"], 0)
        self.assertNotIn("ApprovalDecisions", signals)
        self.assertEqual(cov["FileMutations"]["measured"], 1)

    def test_unavailable_signals_are_zero_and_not_in_signal_set(self):
        # 结构缺口（StepBoundaries/SandboxPolicy/NetworkAccess/UserCorrections）
        # 任何输入都全零、不进 signals；SandboxModes 已 available，但这份输入
        # 没有 sandbox_policy 证据 → 同样全零不进（无证据 ≠ 有覆盖）。
        # UserPrompts 已 available 且有自己的正测（下面那条），不再混在这里。
        items = [_cx_event("token_count", {"info": {"model_context_window": 128000}})]
        signals, cov = self._signals(items)
        for name in ("StepBoundaries", "SandboxModes", "SandboxPolicy",
                     "NetworkAccess", "UserCorrections"):
            self.assertEqual(cov[name], {"measured": 0, "derived": 0, "lossy": 0, "unmetered": 0},
                             "%s 应全零、不进 signals（结构缺口或无对应证据）" % name)
            self.assertNotIn(name, signals)

    def test_user_message_response_item_counts_user_prompts(self):
        # UserPrompts 2026-08 从 unavailable 翻 measured：response_item.message
        # + role="user" 计 1。role="assistant" 的 message 是模型回复、reasoning
        # 是思考块——都不算用户提示。
        items = [
            _cx_user_message(),
            {"type": "response_item", "timestamp": 0,
             "payload": {"type": "message", "role": "user",
                         "content": [{"type": "input_text", "text": "<environment_context>harness data</environment_context>"}]}},
            {"type": "response_item", "timestamp": 0,
             "payload": {"type": "message", "role": "user", "content": []}},
            {"type": "response_item", "timestamp": 0,
             "payload": {"type": "message", "role": "assistant",
                         "content": [{"type": "output_text", "text": "你好"}]}},
            _cx_response("reasoning"),
        ]
        signals, cov = self._signals(items)
        self.assertEqual(cov["UserPrompts"], {"measured": 1, "derived": 0, "lossy": 1, "unmetered": 0})
        self.assertIn("UserPrompts", signals)

    def test_unknown_types_are_reported_sorted_and_deduped(self):
        items = [
            _cx_event("brand_new_event"),
            _cx_event("brand_new_event"),  # 去重
            _cx_item({"type": "BrandNewItem"}),
            _cx_response("brand_new_response"),
            {"type": "totally_new_top_level", "timestamp": 0, "payload": {}},
        ]
        _signals, _cov, unknown = derive_coverage(items)
        self.assertEqual(len(unknown), 4)
        self.assertEqual(unknown, sorted(unknown), "报错按字典序排序，跨语言字节一致")
        self.assertTrue(any("brand_new_event" in u for u in unknown))
        self.assertTrue(any("BrandNewItem" in u for u in unknown))

    def test_known_non_signal_items_are_not_unknown(self):
        # agent_reasoning / user_message / world_state 是"认识但恰好不喂信号"的
        # 高频条目——绝不能进 attempts。
        items = [
            _cx_event("agent_reasoning", {"content": "thinking"}),
            _cx_event("user_message", {"content": "hi"}),
            _cx_response("reasoning"),
            {"type": "world_state", "timestamp": 0, "payload": {}},
        ]
        _signals, _cov, unknown = derive_coverage(items)
        self.assertEqual(unknown, [])

    def test_no_usage_evidence_leaves_usage_and_derived_markers_zero(self):
        _signals, cov, _unknown = derive_coverage([_cx_event("task_started")])
        self.assertEqual(cov["Usage"]["measured"], 0)
        self.assertEqual(cov["UsageAggregate"]["derived"], 0)
        self.assertEqual(cov["ContextWindow"]["measured"], 0)
        self.assertEqual(cov["SkillInvocations"]["derived"], 0)


class TestCodexEvidenceJson(unittest.TestCase):
    """`codex_evidence_json` 的输出形状——20 个信号键全量、signals 按
    ALL_SIGNALS 序、attempts/notes 序列化。与 Rust `codex_evidence_json`
    同一个形状（差分门 both() 在子命令层再兜底一次字节相等）。"""

    def _build(self, items, title=None):
        from agent_vitals.codex_evidence import build_codex_evidence
        evidence = build_codex_evidence(items, "s1", title, "legacy", "0.146.0",
                                        ["/repo"], "gpt-5.6-sol")
        return codex_evidence_json(evidence)

    def test_all_20_signals_appear_in_coverage(self):
        out = self._build([_cx_event("mcp_tool_call_end")])
        self.assertEqual(out["harness"], "codex")
        self.assertEqual(out["session_id"], "s1")
        self.assertIsNone(out["title"], "无索引态 → title 是 null，绝不编造")
        self.assertEqual(out["history_mode"], "legacy")
        self.assertEqual(len(out["coverage"]), 20)
        self.assertEqual(out["coverage"]["ToolCalls"],
                         {"measured": 1, "derived": 0, "lossy": 0, "unmetered": 0, "available": True})
        # available 标记（2026-08 起）：结构缺口 false、可数信号 true——KPI 分母
        # 和模板「结构缺口 vs 会话缺口」的折叠都靠这个键。
        self.assertIs(out["coverage"]["StepBoundaries"]["available"], False)
        self.assertIs(out["coverage"]["UserPrompts"]["available"], True,
                      "UserPrompts 已翻 measured，不再是结构缺口")

    def test_title_from_index_is_surfaced(self):
        out = self._build([], title="评估项目添加UI")
        self.assertEqual(out["title"], "评估项目添加UI")

    def test_derived_markers_serialize_with_presence_note(self):
        out = self._build([_cx_item({"type": "CommandExecution", "duration": 1})])
        self.assertIn("SkillInvocations", out["signals"])
        self.assertEqual(out["coverage"]["SkillInvocations"]["derived"], 1)
        self.assertEqual(len(out["notes"]), 1)
        self.assertIn("detect_implicit_skill_invocation_for_command", out["notes"][0])

    def test_unknown_types_serialize_as_attempts_not_notes(self):
        out = self._build([_cx_event("brand_new_event")])
        self.assertEqual(len(out["attempts"]), 1)
        self.assertEqual(out["attempts"][0]["available"], False)
        self.assertEqual(out["attempts"][0]["source_id"], "codex.rollout.jsonl")
        self.assertIn("brand_new_event", out["attempts"][0]["error"])
        self.assertEqual(out["notes"], [], "未知类型记 attempts，不记 notes")


class TestCodexSessionRoots(unittest.TestCase):
    """`codex_session_roots_report` 的形状与键序——Python ↔ Rust 差分的基础。
    根集合是「Codex 会话在哪」的唯一事实来源，live + archived 必须一起报告
    （cc-trace 研究 §B：只扫 live 就是漏读归档会话 = 漏成本）。"""

    def test_both_roots_report_shape_and_key_order(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            live = home / ".codex" / "sessions" / "2026" / "08"
            arch = home / ".codex" / "archived_sessions"
            live.mkdir(parents=True)
            arch.mkdir(parents=True)
            (live / "rollout-a.jsonl").write_bytes(b"{}\n")
            (live / "rollout-b.jsonl").write_bytes(b"{}\n")
            (arch / "rollout-c.jsonl").write_text("abc", encoding="utf-8")

            report = codex_session_roots_report(home=home)
            # 外层键序：harness → roots（字节一致的一部分）。
            self.assertEqual(list(report.keys()), ["harness", "roots"])
            self.assertEqual(report["harness"], "codex")
            self.assertEqual([r["kind"] for r in report["roots"]],
                             ["live", "archived"])
            # 根对象键序：kind → path → exists → file_count → total_bytes。
            self.assertEqual(list(report["roots"][0].keys()),
                             ["kind", "path", "exists", "file_count", "total_bytes"])
            live_root = report["roots"][0]
            self.assertEqual(live_root["exists"], True)
            self.assertEqual(live_root["file_count"], 2)
            self.assertEqual(live_root["total_bytes"], 6)  # "{}\n" × 2
            arch_root = report["roots"][1]
            self.assertEqual(arch_root["exists"], True)
            self.assertEqual(arch_root["file_count"], 1)
            self.assertEqual(arch_root["total_bytes"], 3)  # "abc"

    def test_absent_archive_zero_fills(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            live = home / ".codex" / "sessions"
            live.mkdir(parents=True)
            (live / "rollout-a.jsonl").write_bytes(b"{}\n")

            report = codex_session_roots_report(home=home)
            self.assertEqual(report["roots"][0]["exists"], True)
            self.assertEqual(report["roots"][0]["file_count"], 1)
            # 存在性探测：archived 缺席绝不报错、不猜路径、也不当 0 条真数据。
            self.assertEqual(report["roots"][1]["exists"], False)
            self.assertEqual(report["roots"][1]["file_count"], 0)
            self.assertEqual(report["roots"][1]["total_bytes"], 0)

    def test_compressed_rollouts_are_counted_and_discovered(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            root = home / ".codex" / "sessions" / "2026" / "10"
            root.mkdir(parents=True)
            compressed = root / "rollout-a.jsonl.zst"
            compressed.write_bytes(b"zstd-placeholder")
            (root / "not-a-rollout.jsonl.zst").write_bytes(b"ignored")
            (root / "rollout-b.jsonl").write_bytes(b"{}\n")

            self.assertEqual(codex_rollout_files(home), [compressed, root / "rollout-b.jsonl"])
            report = codex_session_roots_report(home=home)
            self.assertEqual(report["roots"][0]["file_count"], 3)
            self.assertEqual(
                report["roots"][0]["total_bytes"],
                len(b"zstd-placeholder") + len(b"ignored") + len(b"{}\n"),
            )

    def test_compressed_rollout_reader_degrades_without_optional_zstandard(self):
        from unittest.mock import patch

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "rollout-a.jsonl.zst"
            path.write_bytes(b"opaque compressed data")
            with patch("agent_vitals.adapters.dsh._zstd", return_value=None):
                result = read_codex_session_log(path)
            self.assertEqual(result["degraded"], "unsupported-compression")
            self.assertIsNone(result["items"])

    def test_compressed_rollout_reader_uses_zstd_decoder(self):
        from unittest.mock import patch

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "rollout-a.jsonl.zst"
            text = '{"type":"session_meta","payload":{"session_id":"compressed"}}\n'
            path.write_bytes(b"compressed fixture")
            with patch("agent_vitals.adapters.dsh._zstd", return_value=object()), \
                    patch("agent_vitals.adapters.dsh.decode_zstd_multi_frame",
                          return_value=text.encode("utf-8")):
                result = read_codex_session_log(path)
            self.assertEqual(result["degraded"], False)
            self.assertEqual(result["session_id"], "compressed")

    def test_default_home_respects_home_env(self):
        # 默认走 Path.home()，即 $HOME——测试用 isolated_home_env 注入。
        with tempfile.TemporaryDirectory() as tmp:
            env_home = Path(tmp)
            import os as _os
            old = _os.environ.get("HOME")
            _os.environ["HOME"] = str(env_home)
            try:
                report = codex_session_roots_report()
            finally:
                if old is None:
                    _os.environ.pop("HOME", None)
                else:
                    _os.environ["HOME"] = old
            self.assertEqual(report["roots"][0]["path"],
                             str(env_home / ".codex" / "sessions"))
            self.assertEqual(report["roots"][0]["exists"], False)


class TestCodexSessionIndex(unittest.TestCase):
    """`parse_session_index` / `read_session_index` 的精确值钉死——标题是 Codex
    专属 provenance（`~/.codex/session_index.jsonl` 的 `thread_name`），join 键是
    **逻辑 `payload.session_id`**（实测：session_id 命中索引 47/51，rollout
    文件名 UUID `payload.id` 只命中 21/51）。与 Rust `codex_session.rs` 的
    `#[cfg(test)]` 数字一致。"""

    def test_maps_id_to_trimmed_title(self):
        text = (
            '{"id":"a","thread_name":"  修复登录 模块  "}\n'
            '{"id":"b","thread_name":"分析项目"}\n'
        )
        index = parse_session_index(text)
        self.assertEqual(index, {"a": "修复登录 模块", "b": "分析项目"})

    def test_last_write_wins_for_duplicate_id(self):
        # 同一 id 可有多条（rename 后带 `(2)` 后缀）；append-only，后写=更新。
        text = (
            '{"id":"a","thread_name":"旧标题"}\n'
            '{"id":"a","thread_name":"新标题 (2)"}\n'
        )
        index = parse_session_index(text)
        self.assertEqual(index, {"a": "新标题 (2)"})

    def test_skips_bad_lines_never_aborts(self):
        # 单行失败跳过、升级失败不报错（cc-trace title_index 同款）：malformed /
        # 非 dict / 缺 id / 非 string / trim 后为空的标题行不能 abort 整个索引。
        text = (
            "not json\n"
            '"just a string"\n'
            '{"thread_name":"没有 id"}\n'
            '{"id":42,"thread_name":"id 非 string"}\n'
            '{"id":"c","thread_name":42}\n'
            '{"id":"d","thread_name":"   "}\n'
            '{"id":"e","thread_name":"有效"}\n'
        )
        index = parse_session_index(text)
        self.assertEqual(index, {"e": "有效"})

    def test_read_session_index_respects_home_and_missing_is_empty(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            # 索引缺失是常态（本机曾不存在）——存在性探测，绝不报错。
            self.assertEqual(read_session_index(home=home), {})
            (home / ".codex").mkdir(parents=True)
            (home / ".codex" / "session_index.jsonl").write_text(
                '{"id":"x","thread_name":"标题"}\n', encoding="utf-8")
            self.assertEqual(read_session_index(home=home), {"x": "标题"})

    def test_read_session_index_defaults_to_home_env(self):
        import os as _os
        with tempfile.TemporaryDirectory() as tmp:
            env_home = Path(tmp)
            old = _os.environ.get("HOME")
            _os.environ["HOME"] = str(env_home)
            try:
                self.assertEqual(read_session_index(), {})
                (env_home / ".codex").mkdir(parents=True)
                (env_home / ".codex" / "session_index.jsonl").write_text(
                    '{"id":"y","thread_name":"评估项目添加UI"}\n', encoding="utf-8")
                self.assertEqual(read_session_index(), {"y": "评估项目添加UI"})
            finally:
                if old is None:
                    _os.environ.pop("HOME", None)
                else:
                    _os.environ["HOME"] = old


class CodexCostCharacterization(unittest.TestCase):
    """`codex-cost` 折叠/计价纯函数的精确值钉死。

    这些数字对应 Rust 侧 `crates/agent-vitals-harnesses/src/harnesses/codex/sessions/usage.rs` 与
    `src/codex_cost.rs` 的 `#[cfg(test)]` 钉同一批。夹具与手算期望见
    `fixtures/codex/cost/README.md`。**一个值变 = 折叠/计价行为变**，不是
    四舍五入——`cost_usd` 是 f64 原值（JSON 序列化两侧同最短表示，逐字节一致
    靠的就是不在这里动它）。
    """

    FIXTURES = ROOT / "fixtures" / "codex" / "cost"

    def _fold(self, name):
        from agent_vitals.adapters.codex_session import parse_codex_session_log
        text = (self.FIXTURES / name).read_text(encoding="utf-8")
        return codex_fold_file(parse_codex_session_log(text)["items"])

    def test_token_facts_derives_uncached_and_validates(self):
        last = {
            "input_tokens": 100, "output_tokens": 10,
            "cached_input_tokens": 30, "cache_write_input_tokens": 5,
            "reasoning_output_tokens": 3, "total_tokens": 110,
        }
        # 返回不可变元组（Rust `[i64; 5]` 的 Python 类比），断言类型也跟着对齐
        self.assertEqual(codex_token_facts(last), (65, 10, 30, 5, 3))
        # reasoning > output → None（无效，交给残差哨兵）
        bad = {"input_tokens": 100, "output_tokens": 10, "reasoning_output_tokens": 12}
        self.assertIsNone(codex_token_facts(bad))
        # cached + cache_write > input → uncached 为负 → None
        bad2 = {"input_tokens": 100, "output_tokens": 10, "cached_input_tokens": 200}
        self.assertIsNone(codex_token_facts(bad2))
        # 缺必填 input/output → None
        self.assertIsNone(codex_token_facts({"output_tokens": 1}))
        # 缺可选桶 → 缺省 0
        self.assertEqual(codex_token_facts({"input_tokens": 100, "output_tokens": 10}),
                         (100, 10, 0, 0, 0))

    def test_codex_day_tokens_sums_the_day_bucket(self):
        """`sessions navigation` 的今日 token（spec §5.2 basis=events）。钉
        Rust `codex_day_tokens` 的同一组数：2026-08-31 全模型全速度求和 = 2160、
        他日互不影响、当日无桶 → None（测不出，不是 0）。"""
        by_date = {
            "2026-08-31": {
                "deepseek-v4-flash": {
                    "standard": {
                        "uncached_input_tokens": 1000, "output_tokens": 200,
                        "cached_input_tokens": 300, "cache_write_input_tokens": 40,
                        "reasoning_output_tokens": 10,
                    },
                    "high": {
                        "uncached_input_tokens": 500, "output_tokens": 100,
                        "cached_input_tokens": 0, "cache_write_input_tokens": 0,
                        "reasoning_output_tokens": 0,
                    },
                },
                "deepseek-v4-pro": {
                    "standard": {
                        "uncached_input_tokens": 7, "output_tokens": 3,
                        "cached_input_tokens": 0, "cache_write_input_tokens": 0,
                        "reasoning_output_tokens": 0,
                    },
                },
            },
            "2026-08-30": {
                "deepseek-v4-flash": {
                    "standard": {
                        "uncached_input_tokens": 99999, "output_tokens": 0,
                        "cached_input_tokens": 0, "cache_write_input_tokens": 0,
                        "reasoning_output_tokens": 0,
                    },
                },
            },
        }
        self.assertEqual(codex_day_tokens(by_date, "2026-08-31"), 2160)
        self.assertEqual(codex_day_tokens(by_date, "2026-08-30"), 99999)
        self.assertIsNone(codex_day_tokens(by_date, "2026-09-01"))
        self.assertIsNone(codex_day_tokens({"2026-08-31": "x"}, "2026-08-31"))
        self.assertIsNone(codex_day_tokens([], "2026-08-31"))

    def test_unaccounted_tokens_seen_sums_sentinel_entries(self):
        """残差哨兵 tokens_seen 总和（>0 → coverage=partial）。与 Rust
        `unaccounted_tokens_seen` 同值：1500 / 缺 tokens_seen 条目按 0 计。"""
        self.assertEqual(unaccounted_tokens_seen([]), 0)
        self.assertEqual(unaccounted_tokens_seen({"a": 1}), 0)
        self.assertEqual(unaccounted_tokens_seen([
            {"type": "token_count_invalid_last_usage", "count": 2, "tokens_seen": 1200},
            {"type": "token_count_before_turn_context", "count": 1, "tokens_seen": 300},
        ]), 1500)
        self.assertEqual(unaccounted_tokens_seen([
            {"type": "x", "count": 1, "tokens_seen": 100},
            {"type": "y", "count": 1},
        ]), 100)

    def test_fold_sol_dedup_unaccounted_and_lc(self):
        """sol 夹具：去重两形态都跳过、两条 unaccounted、cache_write 进 5m 档、
        含可用于验证基础费率计算的大桶。"""
        f = self._fold("rollout-sol.jsonl")
        bm = f["by_model"]["gpt-5.6-sol"]["standard"]
        # uncached 派生：08-01 (50000) + 08-02 (120000)
        self.assertEqual(bm["uncached_input_tokens"], 170000)
        self.assertEqual(bm["output_tokens"], 70000)
        self.assertEqual(bm["cached_input_tokens"], 190000)
        self.assertEqual(bm["cache_write_input_tokens"], 40000)
        self.assertEqual(bm["reasoning_output_tokens"], 8000)
        # 去重 + `info: null` 跳过 → 只有 2 个真桶（08-01、08-02 各一小时）。夹具里
        # 那条 `info: null` 的 token_count（真实语料 08-19 形态）如果被误收进桶或误报
        # unaccounted，这里的小时集合断言会当场红。时间轴是小时桶（统一多桶折叠契约）。
        # 时间轴是小时桶（统一多桶折叠契约），且小时键是**北京时间**（+8）——
        # 夹具 UTC 08-01T00/08-02T00 → 北京 08-01T08/08-02T08（2026-08-29 修）。
        self.assertEqual(set(f["by_hour_model"].keys()), {"2026-08-01T08", "2026-08-02T08"})
        # 两条 unaccounted，type 升序（null-info 不增加第三条）
        ua = f["unaccounted"]
        self.assertEqual([u["type"] for u in ua],
                         ["token_count_before_turn_context", "token_count_invalid_last_usage"])
        self.assertEqual(ua[0], {"type": "token_count_before_turn_context", "count": 1, "tokens_seen": 1100})
        self.assertEqual(ua[1], {"type": "token_count_invalid_last_usage", "count": 1, "tokens_seen": 670})

    def test_fold_terra_switches_model_mid_file(self):
        """terra 夹具：model 游标中途切换 → 同一小时两个模型分桶。"""
        f = self._fold("rollout-terra.jsonl")
        # 夹具 UTC 07-15T09 → 北京 07-15T17（+8）。
        self.assertEqual(set(f["by_hour_model"].keys()), {"2026-07-15T17"})
        hour = f["by_hour_model"]["2026-07-15T17"]
        self.assertEqual(set(hour.keys()), {"gpt-5.6-terra", "gpt-5.6-luna"})
        terra = hour["gpt-5.6-terra"]["standard"]
        self.assertEqual([terra[k] for k in CODEX_TOKEN_FIELDS], [65000, 20000, 30000, 5000, 2000])
        luna = hour["gpt-5.6-luna"]["standard"]
        self.assertEqual([luna[k] for k in CODEX_TOKEN_FIELDS], [130000, 50000, 60000, 10000, 5000])

    def test_by_model_from_hours_reconciles_and_filters(self):
        """`--month` 过滤小时轴后 by_model 重算（真实 defect：旧实现拿
        codex_merge_folds 折回，merge 只读 fold 的 by_model 字段 → 空模型轴 →
        整份月报告静默全零）。重算必须满足守恒：全部样本带时间时
        `codex_by_model_from_hours(by_hour_model) == by_model`（同一折叠的两投影），
        月份过滤后等于对应小时桶之和，且无时间样本被按设计丢弃。"""
        folds = [self._fold("rollout-sol.jsonl"),
                 self._fold("rollout-terra.jsonl"),
                 self._fold("rollout-unpriced.jsonl")]
        merged = codex_merge_folds(folds)
        # 无 untimed（三份夹具的 token_count 全带时间）→ 两投影逐字节相等
        self.assertEqual(codex_by_model_from_hours(merged["by_hour_model"]),
                         merged["by_model"])
        # --month 2026-08：terra/luna（07-15）出局，模型轴只剩 sol + auto-review
        aug = {h: bm for h, bm in merged["by_hour_model"].items()
               if h.startswith("2026-08")}
        recomputed = codex_by_model_from_hours(aug)
        self.assertEqual(set(recomputed.keys()), {"gpt-5.6-sol", "codex-auto-review"})
        self.assertEqual(recomputed["gpt-5.6-sol"]["standard"]["uncached_input_tokens"],
                         50000 + 120000)
        self.assertEqual(recomputed["codex-auto-review"]["standard"]["output_tokens"], 1000)
        # 守恒：重算后的模型轴 == 过滤后小时桶之和（逐桶）
        total = [0] * 5
        for bm in aug.values():
            for speeds in bm.values():
                for bucket in speeds.values():
                    for i, f in enumerate(CODEX_TOKEN_FIELDS):
                        total[i] += bucket.get(f, 0)
        self.assertEqual(
            [recomputed["gpt-5.6-sol"]["standard"].get(f, 0) for f in CODEX_TOKEN_FIELDS],
            [total[i] - recomputed["codex-auto-review"]["standard"].get(f, 0)
             for i, f in enumerate(CODEX_TOKEN_FIELDS)])

    def test_pricing_table_pins_sol_terra_luna(self):
        """`codex_pricing.json` 三条主价的精确值（characterization 代替
        test_pricing_lockstep——Codex 价目表无派生副本，钉源头就够了）。"""
        entries = load_codex_pricing()["entries"]
        by_prefix = {}
        for e in entries:
            if e.get("speed") == "standard":
                by_prefix[e["modelPrefix"]] = e
        sol = by_prefix["gpt-5.6-sol"]
        self.assertEqual([sol[k] for k in ("uncachedInputUsdPerMTok", "cacheReadUsdPerMTok",
                                           "cacheWrite5mUsdPerMTok", "cacheWrite1hUsdPerMTok",
                                           "outputUsdPerMTok")],
                         ["4", "0.4", "5", "8", "20"])
        terra = by_prefix["gpt-5.6-terra"]
        self.assertEqual([terra[k] for k in ("uncachedInputUsdPerMTok", "cacheReadUsdPerMTok",
                                             "cacheWrite5mUsdPerMTok", "cacheWrite1hUsdPerMTok",
                                             "outputUsdPerMTok")],
                         ["2", "0.2", "2.5", "4", "12"])
        luna = by_prefix["gpt-5.6-luna"]
        self.assertEqual([luna[k] for k in ("uncachedInputUsdPerMTok", "cacheReadUsdPerMTok",
                                            "cacheWrite5mUsdPerMTok", "cacheWrite1hUsdPerMTok",
                                            "outputUsdPerMTok")],
                         ["0.2", "0.02", "0.25", "0.4", "1.2"])
        self.assertEqual(load_codex_pricing()["currency"], "USD")

    def _merged_report(self, want_hours=False):
        folds = [self._fold("rollout-sol.jsonl"),
                 self._fold("rollout-terra.jsonl"),
                 self._fold("rollout-unpriced.jsonl")]
        merged = codex_merge_folds(folds)
        return codex_cost_report(merged["by_hour_model"], merged["by_model"],
                                 merged["unaccounted"], merged["plan"],
                                 load_codex_pricing(), want_hours=want_hours)

    def test_cost_report_exact_usd_and_reconciles(self):
        """合并三份夹具 → 精确 USD 价 + 守恒：sum(days.cost) == total_cost_usd。"""
        report = self._merged_report()
        self.assertAlmostEqual(report["total_cost_usd"], 2.8342, places=9)
        tt = report["total_tokens"]
        # 合并三份夹具按桶求和：sol(170000,70000,190000,40000,8000) +
        # terra(65000,20000,30000,5000,2000) + luna(130000,50000,60000,10000,5000) +
        # auto-review(5000,1000,0,0,0) → (370000,141000,280000,55000,15000)。
        self.assertEqual([tt[k] for k in CODEX_TOKEN_FIELDS], [370000, 141000, 280000, 55000, 15000])
        # per_model 首现序：sol → terra → luna → codex-auto-review
        self.assertEqual(list(report["per_model"].keys()),
                         ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "codex-auto-review"])
        sol = report["per_model"]["gpt-5.6-sol"]
        self.assertTrue(sol["priced"])
        self.assertEqual(sol["speed"], "standard")
        self.assertAlmostEqual(sol["cost_usd"], 2.356, places=9)
        self.assertAlmostEqual(report["per_model"]["gpt-5.6-terra"]["cost_usd"], 0.3885, places=9)
        self.assertAlmostEqual(report["per_model"]["gpt-5.6-luna"]["cost_usd"], 0.0897, places=9)
        # unpriced 模型诚实上报
        review = report["per_model"]["codex-auto-review"]
        self.assertFalse(review["priced"])
        self.assertEqual(review["cost_usd"], 0.0)
        self.assertEqual(report["unpriced_tokens"], 6000)
        # 日期轴升序 + 守恒
        days = report["days"]
        self.assertEqual([d["date"] for d in days],
                         ["2026-07-15", "2026-08-01", "2026-08-02", "2026-08-03"])
        day_sum = sum(d["cost_usd"] for d in days)
        self.assertAlmostEqual(day_sum, report["total_cost_usd"], places=9)
        self.assertEqual(days[0]["tokens"], 370000)
        self.assertEqual(days[2]["tokens"], 360000)

    def test_cost_report_hours_reconciles_with_days(self):
        """want_hours=True → 输出 `hours`（小时升序、键 `YYYY-MM-DDTHH`），且
        `sum(hours.cost) == sum(days.cost) == total_cost_usd` 精确对账。每个
        日期的小时价之和 == 该日价；08-02 聚合桶虽超过长上下文阈值，但没有请求级
        证据，仍只按基础费率计价（= $1.89）。want_hours=False 时
        无 `hours` 键——`--json --month` 的契约不包含它（月视图热力图用 days）。"""
        report = self._merged_report(want_hours=True)
        hours = report["hours"]
        # 小时键是北京时间（+8）：夹具 UTC 07-15T09/08-01T00/08-02T00/08-03T12 →
        # 北京同日 T17/T08/T08/T20。日期轴不变（都是同日 +8）。
        self.assertEqual([h["hour"] for h in hours],
                         ["2026-07-15T17", "2026-08-01T08", "2026-08-02T08",
                          "2026-08-03T20"])
        hour_sum_by_date = {}
        for h in hours:
            d = h["hour"][:10]
            hour_sum_by_date[d] = hour_sum_by_date.get(d, 0.0) + h["cost_usd"]
        day_cost = {d["date"]: d["cost_usd"] for d in report["days"]}
        self.assertEqual(set(hour_sum_by_date), set(day_cost))
        for d, c in day_cost.items():
            self.assertAlmostEqual(hour_sum_by_date.get(d, 0.0), c, places=9)
        self.assertAlmostEqual(sum(h["cost_usd"] for h in hours),
                               report["total_cost_usd"], places=9)
        # 08-02 无请求级证据 → 不从聚合桶推断附加费。
        self.assertAlmostEqual(hour_sum_by_date["2026-08-02"], 1.89, places=9)
        # want_hours=False（月契约）→ 无 hours 键
        self.assertNotIn("hours", self._merged_report())

    def test_cost_report_long_context_sample_exact(self):
        """聚合 input_total 超阈值但无请求级证据 → 仍为基础费率。"""
        f = self._fold("rollout-sol.jsonl")
        report = codex_cost_report(
            f["by_hour_model"], f["by_model"], f["unaccounted"], f["plan"],
            load_codex_pricing())
        d2 = next(d for d in report["days"] if d["date"] == "2026-08-02")
        self.assertAlmostEqual(d2["cost_usd"], 1.89, places=9)
        self.assertEqual(d2["tokens"], 360000)

    def test_cost_report_none_when_nothing_to_price(self):
        self.assertIsNone(codex_cost_report({}, {}, [], None, load_codex_pricing()))

    def test_cost_report_plan_passes_through(self):
        """plan 原样透传（报告不解释它，展示层自己判「订阅 → 重标价」）；合并
        取 observed_at 最新的快照（unpriced 08-03 的 77%，而不是 sol 08-02 的
        67%）。unpriced 12:05 的降级快照（primary/secondary 全 null）让 observed_at
        前进到 12:05，但 **limits 保留 77%/9%**——降级快照不抹掉配额条（真实
        defect 回归：直接覆盖会让用户看配额的功能静默消失）。"""
        report = self._merged_report()
        plan = report["plan"]
        self.assertEqual(plan["plan_type"], "plus")
        self.assertIs(plan["has_credits"], False)
        # used_percent 保类型（真实语料是 float；整数也合法，别强转成 float）。
        self.assertIsInstance(plan["limits"]["primary"]["used_percent"], float)
        self.assertEqual(plan["limits"]["primary"]["used_percent"], 77.0)
        self.assertEqual(plan["limits"]["primary"]["window_minutes"], 300)
        self.assertEqual(plan["limits"]["primary"]["resets_at"], 1787900000)
        self.assertEqual(plan["limits"]["secondary"]["used_percent"], 9.0)
        self.assertEqual(plan["limits"]["secondary"]["window_minutes"], 10080)
        self.assertEqual(plan["observed_at"], "2026-08-03T12:05:00Z")
        # 无 plan 的折叠 → null（不是缺键）。
        f = self._fold("rollout-terra.jsonl")
        r2 = codex_cost_report(f["by_hour_model"], f["by_model"], f["unaccounted"],
                               f["plan"], load_codex_pricing())
        self.assertIsNone(r2["plan"])

    def test_fold_null_limits_snapshot_keeps_last_known_limits(self):
        """单文件折叠的 limits 保留语义（真实 defect 回归）：带限额的快照之后来
        一个 primary/secondary 全 null 的降级快照（只有 plan_type + limit_id），
        observed_at 前进但 **limits 保留上一次的**——「最后看见」直接覆盖会把配额
        条抹掉。跨文件 merge 同一语义：B 的降级快照 observed_at 更晚时，limits
        取 A 的。与 Rust 侧 `null_limits_snapshot_keeps_last_known_limits` /
        `merge_keeps_limits_from_an_older_fold_when_latest_is_degraded` 钉同一批。"""
        def tc(ts):
            return {"timestamp": ts, "type": "turn_context",
                    "payload": {"model": "gpt-5.6-sol", "service_tier": None}}

        with_limits = {"timestamp": "2026-08-27T14:22:51Z", "type": "event_msg",
                       "payload": {"type": "token_count", "info": None,
                                   "rate_limits": {
                                       "plan_type": "plus",
                                       "primary": {"used_percent": 2.0, "window_minutes": 300,
                                                   "resets_at": 1787858552},
                                       "secondary": {"used_percent": 1.0, "window_minutes": 10080,
                                                     "resets_at": 1788351817}}}}
        degraded = {"timestamp": "2026-08-27T18:18:02.963Z", "type": "event_msg",
                    "payload": {"type": "token_count", "info": None,
                                "rate_limits": {"limit_id": "premium", "plan_type": "plus",
                                                "primary": None, "secondary": None}}}
        out = codex_fold_file([tc("2026-08-27T14:00:00Z"), with_limits, degraded])
        plan = out["plan"]
        self.assertEqual(plan["observed_at"], "2026-08-27T18:18:02.963Z")  # observed_at 前进
        self.assertEqual(plan["plan_type"], "plus")                        # plan_type 保持最新
        self.assertEqual(plan["limits"]["primary"]["used_percent"], 2.0)   # limits 保留
        self.assertEqual(plan["limits"]["primary"]["window_minutes"], 300)
        self.assertEqual(plan["limits"]["secondary"]["used_percent"], 1.0)

        # 跨文件：A 带限额（16:00）、B 降级（18:00，无 limits）→ plan_type/observed_at
        # 取 B 的、limits 取 A 的。
        fold_a = codex_fold_file([tc("2026-08-01T00:00:00Z"),
                                  {"timestamp": "2026-08-01T16:00:00Z", "type": "event_msg",
                                   "payload": {"type": "token_count", "info": None,
                                               "rate_limits": {"plan_type": "plus",
                                                               "primary": {"used_percent": 33.0,
                                                                           "window_minutes": 300,
                                                                           "resets_at": 3}}}}])
        fold_b = codex_fold_file([tc("2026-08-01T00:00:00Z"),
                                  {"timestamp": "2026-08-01T18:00:00Z", "type": "event_msg",
                                   "payload": {"type": "token_count", "info": None,
                                               "rate_limits": {"limit_id": "premium",
                                                               "plan_type": "pro",
                                                               "primary": None,
                                                               "secondary": None}}}])
        merged = codex_merge_folds([fold_a, fold_b])
        self.assertEqual(merged["plan"]["observed_at"], "2026-08-01T18:00:00Z")
        self.assertEqual(merged["plan"]["plan_type"], "pro")  # 最新的 plan_type
        self.assertEqual(merged["plan"]["limits"]["primary"]["used_percent"], 33.0)  # A 的限额

    def test_render_codex_cost_text(self):
        """人读文本（CLI 无 --json/--html 时的输出）：与 Rust `render_codex_cost`
        同 spec。数字来自 report，这里只钉格式。夹具带配额（plus 订阅）→ 标价
        重标 + plan 行。"""
        report = self._merged_report()
        out = {"harness": "codex", "currency": "USD", "month": None}
        out.update(report)
        text = render_codex_cost(out)
        self.assertIn("harness: codex\n", text)
        self.assertIn("currency: USD\n", text)
        # 「剩余」= 100 − used；重置时间今天分支由 _reset_beijing_text_at 单测钉住
        #（夹具 resets_at 落在 08-28/09-02，套件在 09-02 跑时 secondary 恰是「今天」，
        # 硬编码日期文本会随运行日期漂），这里钉格式+数字+快照时间戳。
        self.assertIn("plan: plus（订阅套餐） · 5小时 剩余23%（重置", text)
        self.assertIn("每周 剩余91%（重置", text)
        self.assertIn("快照@2026-08-03T12:05:00Z\n", text)
        # 订阅套餐 → per-token 美元是标价不是账单
        self.assertIn("total cost (按量标价): $2.83 · total tokens: 846K\n", text)
        self.assertIn("  gpt-5.6-sol  $2.36  (standard)\n", text)
        self.assertIn("  codex-auto-review  unpriced  (standard)\n", text)
        self.assertIn("另有 6K tokens 模型未计价\n", text)
        self.assertIn("未接住 1 × token_count_before_turn_context（看见 1.1K tokens）\n", text)
        self.assertIn("未接住 1 × token_count_invalid_last_usage（看见 670 tokens）\n", text)

    def test_reset_beijing_text_at_branches(self):
        """重置时间「今天 → HH:MM / 否则 → M月D日 HH:MM」两个分支,`today` 参数化,
        与运行当天无关。Rust `reset_beijing_text_at` 同 spec。"""
        # 1787900000 → 2026-08-28 14:53 UTC+8；1788351817 → 2026-09-02 20:23 UTC+8
        self.assertEqual(_reset_beijing_text_at(1787900000, "2026-08-28"), "14:53")
        self.assertEqual(_reset_beijing_text_at(1787900000, "2026-08-29"), "8月28日 14:53")
        self.assertEqual(_reset_beijing_text_at(1788351817, "2026-09-02"), "20:23")
        self.assertEqual(_reset_beijing_text_at(1788351817, "2026-09-03"), "9月2日 20:23")

    def test_render_codex_cost_text_no_plan_keeps_old_label(self):
        """无 plan（非订阅）→ 旧标签，不出现「按量标价」。terra 文件无
        rate_limits → 折叠出的 plan 是 None，报告原样透传 None。"""
        f = self._fold("rollout-terra.jsonl")
        report = codex_cost_report(f["by_hour_model"], f["by_model"], f["unaccounted"],
                                   f["plan"], load_codex_pricing())
        out = {"harness": "codex", "currency": "USD", "month": None}
        out.update(report)
        text = render_codex_cost(out)
        self.assertIn("total cost: $0.48 · total tokens: 370K\n", text)
        self.assertNotIn("按量标价", text)
        self.assertNotIn("plan:", text)

    def test_render_codex_cost_with_month_line(self):
        report = self._merged_report()
        out = {"harness": "codex", "currency": "USD", "month": "2026-08"}
        out.update(report)
        text = render_codex_cost(out)
        self.assertIn("month: 2026-08\n", text)
