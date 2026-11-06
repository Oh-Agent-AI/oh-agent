#!/usr/bin/env python3
"""`agent/enrichment.py` 的锁步测试 —— 与 Rust `domain/enrichment.rs` 对守。

两侧断言**同一份共享向量** `fixtures/enrichment/vectors.json`（Rust 侧
`include_str!` 进 `#[cfg(test)]`，本文件按路径读）：改向量 = 双语言一起过评审，
任何一侧单独漂移都会在自己的测试上炸。库内行为细则（词表闭集、WS 25 字符集、
档位 200/120/120/120、scrubbed 优先于 truncated）两侧各有镜像断言，docstring
互相指认。

诚实性规则见 `agent_vitals/agent/enrichment.py` 模块 docstring（与 Rust 侧逐条
对齐）。命令面差分（usage-facts 双实现逐字节比）暂不适用——本模块还没有 CLI 面，
纯函数锁步就是当前最强的对拍形态。

跑法：
    python3 -m unittest tests.test_enrichment_lockstep -v
"""

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "packages" / "agent-vitals-python"))

from agent_vitals.enrichment import (  # noqa: E402
    ERROR_CLASS_VALUES,
    PROVENANCE_VALUES,
    ROLE_CHAR_LIMITS,
    SCRUB_MARKER,
    WS_CHARS,
    classify_error_code,
    error_class_from_wire,
    make_excerpt,
    scrub_text,
)

VECTORS = ROOT / "fixtures" / "enrichment" / "vectors.json"

# Unicode White_Space 全集的独立构造（不经被测模块——25 字符这一事实本身要被钉住）。
_EXPECTED_WS = "".join(
    chr(c)
    for c in (0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0x85, 0xA0, 0x1680,
              *range(0x2000, 0x200B), 0x2028, 0x2029, 0x202F, 0x205F, 0x3000)
)


class VocabularyTests(unittest.TestCase):
    def test_error_class_closed_set(self):
        """十值闭集逐个过 from_wire，闭集外拒绝（对应 Rust variant_count=10 往返测试）。"""
        self.assertEqual(len(ERROR_CLASS_VALUES), 10)
        for wire in ERROR_CLASS_VALUES:
            self.assertEqual(error_class_from_wire(wire), wire)
        self.assertIsNone(error_class_from_wire("credits"))

    def test_role_limits_match_spec_defaults(self):
        """spec §15 默认档位 200/120/120/120；改档位 = spec+双语言+vectors 三处一起改。"""
        self.assertEqual(
            ROLE_CHAR_LIMITS,
            {"user_first": 200, "user_turn": 120, "assistant_final": 120, "subagent_task": 120},
        )
        self.assertEqual(PROVENANCE_VALUES, ("verbatim", "truncated", "scrubbed"))

    def test_ws_chars_is_the_full_unicode_whitespace_set(self):
        """WS 必须恰为 25 字符的 Unicode White_Space 全集——内建 strip 多裁
        \\x1c-\\x1f 的缝隙就靠这份共享字面量封死（Python 曾实测漏掉 U+2028/2029）。"""
        self.assertEqual(WS_CHARS, _EXPECTED_WS)
        self.assertEqual(len(WS_CHARS), 25)
        self.assertNotIn("\x1c", WS_CHARS)


class ScrubTests(unittest.TestCase):
    def test_marker_is_fixed_glyph(self):
        """spec §15：替换标记字形固定，改字形 = 双语言同改 + golden 评审。"""
        self.assertEqual(SCRUB_MARKER, "[…]")

    def test_scrub_idempotent_and_multi_hit(self):
        outcome = scrub_text("a sk-abcdefghij0123456789 b sk-zyxwvutsrqponmlkjihg c")
        self.assertEqual(outcome.text, "a […] b […] c")
        self.assertTrue(outcome.scrubbed)
        again = scrub_text(outcome.text)
        self.assertEqual(again.text, outcome.text)
        self.assertFalse(again.scrubbed, "已替换输出再跑不应再命中")


class ExcerptTests(unittest.TestCase):
    def test_none_on_empty_or_whitespace_only(self):
        self.assertIsNone(make_excerpt("  \t\r\n ", "user_turn"))
        self.assertIsNone(make_excerpt("", "user_first"))

    def test_trims_only_shared_ws_set(self):
        """\\x1c 不在共享集：必须保留（与 Rust 侧同一条断言，两侧同语义的证据位）。"""
        self.assertEqual(make_excerpt("\x1c内容\x1c", "user_turn").text, "\x1c内容\x1c")
        self.assertEqual(make_excerpt("　帮我修登录页 ", "user_first").text, "帮我修登录页")

    def test_truncates_by_code_point(self):
        out = make_excerpt("锚" * 201, "user_first")
        self.assertEqual(out.text, "锚" * 200)
        self.assertEqual(out.provenance, "truncated")
        out = make_excerpt("😀" * 121, "user_turn")
        self.assertEqual(out.text, "😀" * 120)
        self.assertEqual(out.provenance, "truncated")

    def test_scrubbed_provenance_wins_over_truncated(self):
        out = make_excerpt("key sk-abcdefghij0123456789 then " + "尾部" * 120, "user_first")
        self.assertEqual(out.provenance, "scrubbed")
        self.assertIn("[…]", out.text)
        self.assertNotIn("sk-abcdefghij", out.text)

    def test_deterministic(self):
        text = "  修复 SQLite 迁移的 fencepost，凭据 sk-abcdefghij0123456789 别提交 "
        self.assertEqual(make_excerpt(text, "user_turn"), make_excerpt(text, "user_turn"))


class SharedVectorTests(unittest.TestCase):
    """共享向量锁步——Rust `shared_vectors_fixture_all_cases_pass` 断言同一份文件。"""

    def test_all_vector_cases_pass(self):
        doc = json.loads(VECTORS.read_text(encoding="utf-8"))
        cases = doc["cases"]
        self.assertGreaterEqual(len(cases), 30, f"向量覆盖不足：{len(cases)}")
        seen = set()
        for case in cases:
            cid = case["id"]
            self.assertNotIn(cid, seen, f"向量 id 重复：{cid}")
            seen.add(cid)
            kind = case["kind"]
            if kind == "classify":
                expected = case.get("expected_class")
                self.assertEqual(classify_error_code(case["input"]), expected, f"向量 {cid}")
            elif kind == "scrub":
                outcome = scrub_text(case["input"])
                self.assertEqual(outcome.text, case["expected_text"], f"向量 {cid}")
                self.assertIs(outcome.scrubbed, case["expected_scrubbed"], f"向量 {cid}")
            elif kind == "excerpt":
                outcome = make_excerpt(case["input"], case["role"])
                if case.get("expected", False) is None:
                    self.assertIsNone(outcome, f"向量 {cid} 应为 None")
                else:
                    self.assertIsNotNone(outcome, f"向量 {cid} 不应为 None")
                    self.assertEqual(outcome.text, case["expected_text"], f"向量 {cid}")
                    self.assertEqual(outcome.provenance, case["expected_provenance"], f"向量 {cid}")
            else:
                self.fail(f"向量 {cid} 的 kind 非法：{kind}")

    def test_vectors_cover_every_scrub_pattern_by_positive_case(self):
        """每条 scrub 正则必须在向量里保留一个 'scrub-<name>-' 前缀且
        expected_scrubbed 为 True 的**正例**——负例同前缀不计数（否则删掉正例
        守卫照样绿）。Rust 侧同名测试对守。"""
        doc = json.loads(VECTORS.read_text(encoding="utf-8"))
        positive_ids = [
            c["id"] for c in doc["cases"]
            if c["kind"] == "scrub" and c["expected_scrubbed"] is True
        ]
        for prefix in (
            "scrub-openai-", "scrub-github-", "scrub-github-fine-", "scrub-aws-",
            "scrub-slack-", "scrub-bearer-", "scrub-jwt-", "scrub-pem-",
        ):
            self.assertTrue(any(i.startswith(prefix) for i in positive_ids),
                            f"vectors.json 缺少前缀 {prefix} 的正例")

    def test_classify_rejects_non_ascii_digit_details(self):
        """整数边界：int() 比 Rust 解析宽（Unicode 数字/下划线/空白/正号）——
        双侧显式收窄为 ASCII 纯数字，这些输入必须两侧同拒。"""
        for code in ("http:+401", "http: 401", "http:٤٠١", "http:4_01"):
            self.assertIsNone(classify_error_code(code), code)
        self.assertIsNone(classify_error_code("jsonrpc:-32770"), "保留带之外")
        self.assertEqual(classify_error_code("jsonrpc:-32768"), "transport", "保留带下界")

    def test_truncation_never_splits_the_scrub_marker(self):
        out = make_excerpt("y" * 198 + " sk-abcdefghij0123456789", "user_first")
        self.assertEqual(out.text, "y" * 198 + " ")
        self.assertEqual(out.provenance, "scrubbed")
        out = make_excerpt("y" * 197 + " sk-abcdefghij0123456789", "user_first")
        self.assertEqual(out.text, "y" * 197 + " ")
        out = make_excerpt("y" * 196 + " sk-abcdefghij0123456789", "user_first")
        self.assertEqual(out.text, "y" * 196 + " […]", "恰好 200 含完整标记：不截断")


if __name__ == "__main__":
    unittest.main()
