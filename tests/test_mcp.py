#!/usr/bin/env python3
"""MCP Surface 第一刀（F1a）的 Python↔Rust 字符对字符钉测。

单一真相源是 `crates/agent-vitals-domain/src/domain/mcp.rs`；这里的每个用例都是
它 `#[cfg(test)]` 里同名断言的逐字节镜像——**没有 CLI 命令可比对**（F1a 只是
纯解析函数，报告面留给 F2），所以不能走 `tests/test_cli_matrix.py` 的 `both()`
差分，只能靠两侧手写同一组输入/期望值的方式钉住（与 `tests/test_characterization.py`
钉纯函数的做法同款：这些数字是 Rust `#[cfg(test)]` 必须复现的那批）。

背景与调研发现见 `docs/AGENT_VITALS_V0_8_PHASE_F_RESEARCH.md` §2。
"""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "packages" / "agent-vitals-python"))

from agent_vitals.agent.mcp import count_mcp_tool_calls, parse_mcp_tool_name  # noqa: E402


class ParseMcpToolNameCase(unittest.TestCase):
    def test_parses_the_three_segment_convention(self):
        self.assertEqual(
            parse_mcp_tool_name("mcp__github__search_issues"),
            ("github", "search_issues"),
        )

    def test_server_and_tool_may_contain_underscores_and_hyphens(self):
        # 实测本环境真实工具名：server 含连字符，tool 含单下划线，但两者都不含
        # 第二处 "__"，所以恰好一处分隔点、无歧义。
        self.assertEqual(
            parse_mcp_tool_name("mcp__claude-in-chrome__read_console_messages"),
            ("claude-in-chrome", "read_console_messages"),
        )

    def test_ambiguous_four_segment_form_is_rejected(self):
        # 回归测试：曾经的实现用 rsplit("__", 1) 只找最后一处 "__"，会把
        # "server__part" 悄悄当成 server 名返回，而不是诚实报告"边界歧义、不
        # 认识"。真实 MCP 服务器/工具名是否会出现第二处 "__" 没有约定可查，
        # 宁可拒绝也不猜。
        self.assertIsNone(parse_mcp_tool_name("mcp__server__part__tool"))

    def test_missing_prefix_is_not_mcp(self):
        self.assertIsNone(parse_mcp_tool_name("Bash"))
        self.assertIsNone(parse_mcp_tool_name("Read"))

    def test_two_segment_form_is_not_recognized(self):
        # Codex fixture 里合成的 "mcp__github"（无第三段）——本模块只服务 Claude
        # Code，不为 Codex 背书，诚实报不认识而不是猜一个空 server。
        self.assertIsNone(parse_mcp_tool_name("mcp__github"))

    def test_empty_server_or_tool_segment_is_rejected(self):
        self.assertIsNone(parse_mcp_tool_name("mcp____tool"))
        self.assertIsNone(parse_mcp_tool_name("mcp__server__"))

    def test_bare_mcp_prefix_is_not_recognized(self):
        self.assertIsNone(parse_mcp_tool_name("mcp__"))
        self.assertIsNone(parse_mcp_tool_name("mcp"))


class CountMcpToolCallsCase(unittest.TestCase):
    def test_aggregates_per_server_per_tool_and_skips_non_mcp_names(self):
        names = [
            "mcp__github__search_issues",
            "mcp__github__search_issues",
            "mcp__github__list_prs",
            "mcp__figma__get_metadata",
            "Bash",
            "Read",
        ]
        counts = count_mcp_tool_calls(names)
        self.assertEqual(len(counts), 2, "两个 MCP 服务器，内置工具不计入")
        self.assertEqual(counts["github"]["search_issues"], 2)
        self.assertEqual(counts["github"]["list_prs"], 1)
        self.assertEqual(counts["figma"]["get_metadata"], 1)

    def test_empty_input_yields_empty_map_not_a_default_server(self):
        self.assertEqual(count_mcp_tool_calls([]), {})


if __name__ == "__main__":
    unittest.main()
