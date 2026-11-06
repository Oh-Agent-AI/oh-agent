"""Codex canonical 与 Rust `CanonicalSession` 的形状对账（反遗漏网）。

Python 的 canonical 是个 dict，没有 schema——漏一个 key 静默，正是这次修的
「5 个 timeline key 整个缺掉」事故（`build_codex_evidence` 曾有 meta/signals/
coverage/attempts/notes，独缺 §11.5 的五个 timeline）。这里把
`build_codex_evidence` 产出的 canonical key 集与 Rust `evidence.rs` 的
`CanonicalSession` struct 字段逐字段对账：Rust 加字段 / Python 漏 key，任何
一边漂移测试都红。仿 `test_classification.py` 的显式清单风格，但清单不是
终点——`_rust_canonical_session_fields` 解析真实 struct，清单只是给人读的锚。
"""

import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

sys.path.insert(0, str(ROOT / "packages" / "agent-vitals-python"))
from agent_vitals.codex_evidence import build_codex_evidence  # noqa: E402

# `CanonicalSession` 的字段集——对账目标。`_rust_canonical_session_fields` 的
# 解析结果必须与这份清单一致，否则就是 struct 排版变了或字段动了，而解析
# 悄悄拿到了错的集合还绿着。
EXPECTED_CANONICAL_FIELDS = frozenset({
    "meta", "signals", "coverage", "attempts", "notes",
    "tool_calls", "tool_results", "approvals", "sandbox_modes", "turns",
})


def _rust_canonical_session_fields():
    """解析 `evidence.rs` 里 `CanonicalSession` struct 的字段名。

    解析而不是只信硬编码清单：Rust struct 是字段集的真相源，字段增删了这里
    跟着对不上——这才是「对账」，不是「钉死一份静态清单」。struct 排版若变成
    字段跨行（`pub x:` 后换行写类型），这个正则拿不到字段名，测试会红，需要
    同步更新解析——这比静默漂移好。
    """
    source = (ROOT / "crates" / "agent-vitals-domain" / "src" / "contracts" /
              "evidence.rs").read_text(
        encoding="utf-8")
    start = source.index("pub struct CanonicalSession {")
    body = source[start:]
    # struct 的闭合花括号（独立一行、顶格）——字段全是单行 `pub x: T,`，类型
    # 里没有裸括号，碰不到更早的 `\n}\n`。
    end = body.index("\n}\n")
    struct = body[:end]
    return frozenset(re.findall(r"^\s+pub ([a-z_]+):", struct, re.M))


class CodexCanonicalShapeTests(unittest.TestCase):
    def test_hardcoded_field_set_matches_rust_struct(self):
        self.assertEqual(_rust_canonical_session_fields(), EXPECTED_CANONICAL_FIELDS)

    def test_python_canonical_keys_equal_rust_fields(self):
        canonical = build_codex_evidence(
            [], "s1", "title", "legacy", "0.1.0", [], None)["canonical"]
        self.assertEqual(
            frozenset(canonical), _rust_canonical_session_fields(),
            "Python codex canonical 的 key 集必须与 Rust CanonicalSession 字段"
            "逐一对应——缺一个就是这次修的「整个缺 timeline key」事故复发")

    def test_timelines_are_present_and_empty(self):
        """**空输入** → 五个 timeline key 在、值为空——反编造的底线不变：不管
        populate 怎么改都不能把空会话填出东西来。

        （2026-08 修正 docstring：这不是「Codex timeline 恒为空」——那已被真实
        rollout 推翻。有输入时 Codex 原生填满 4 条，见 `test_populated_timelines...`。）"""
        canonical = build_codex_evidence(
            [], "s1", "title", "legacy", "0.1.0", [], None)["canonical"]
        for key in ("tool_calls", "tool_results", "approvals", "sandbox_modes", "turns"):
            self.assertEqual(canonical[key], {"entries": []},
                             "%s 应存在且为空时间线" % key)

    def test_populated_timelines_are_native_and_structured(self):
        """有输入时 Codex 线格式原生填 4 条 timeline（approvals 除外）——「Codex
        timeline 恒为空」是上一轮的假结论，被真实 rollout 纠正。形状与 Rust
        `populate_codex_timelines` 的 `populate_fills_four_timelines_natively`
        单测逐条对齐：exec→bash 翻译、shell 前缀剥除、exit_code→exit_code:N、
        turn 合成序数 + sig 归属、approvals 诚实为空。entry 带七字段坐标。"""
        items = [
            {"type": "turn_context", "timestamp": 0, "payload": {
                "sandbox_policy": {"type": "danger-full-access"}, "approval_policy": "never",
                "turn_id": "t1"}},
            {"type": "event_msg", "timestamp": 0, "payload": {
                "type": "task_started", "turn_id": "t1", "started_at": 100}},
            {"type": "event_msg", "timestamp": 0, "payload": {
                "type": "item_completed", "turn_id": "t1", "item": {
                    "type": "CommandExecution", "id": "exec-1",
                    "command": ["/bin/zsh", "-lc", "rm -rf /tmp/x"], "exit_code": 0}}},
            {"type": "response_item", "timestamp": 0, "payload": {
                "type": "function_call", "name": "send_message",
                "arguments": '{"target":"/root"}', "call_id": "call-1"}},
            {"type": "event_msg", "timestamp": 0, "payload": {
                "type": "task_complete", "turn_id": "t1", "started_at": 100, "error": None}},
            {"type": "turn_context", "timestamp": 0, "payload": {
                "sandbox_policy": {"type": "danger-full-access"}}},
            {"type": "event_msg", "timestamp": 0, "payload": {
                "type": "task_started", "turn_id": "t2", "started_at": 200}},
            {"type": "event_msg", "timestamp": 0, "payload": {
                "type": "item_completed", "turn_id": "t2", "item": {
                    "type": "CommandExecution", "id": "exec-2",
                    "command": ["echo", "boom"], "exit_code": 1}}},
            {"type": "event_msg", "timestamp": 0, "payload": {
                "type": "item_completed", "turn_id": "t2", "item": {
                    "type": "CommandExecution", "id": "exec-3",
                    "command": ["echo", "boom"], "exit_code": 1}}},
            {"type": "event_msg", "timestamp": 0, "payload": {
                "type": "item_completed", "turn_id": "t2", "item": {
                    "type": "CommandExecution", "id": "exec-4",
                    "command": ["echo", "boom"], "exit_code": 1}}},
            {"type": "response_item", "timestamp": 0, "payload": {
                "type": "function_call_output", "call_id": "call-1", "error": None}},
            {"type": "event_msg", "timestamp": 0, "payload": {
                "type": "task_complete", "turn_id": "t2", "started_at": 200, "error": None}},
        ]
        canonical = build_codex_evidence(
            items, "s1", "title", "paginated", "0.1.0", [], None)["canonical"]

        sandbox = canonical["sandbox_modes"]["entries"]
        self.assertEqual([e["observation"]["mode"] for e in sandbox],
                         ["danger-full-access", "danger-full-access"])
        self.assertEqual(len(sandbox), 2)

        calls = canonical["tool_calls"]["entries"]
        self.assertEqual([e["observation"]["name"] for e in calls],
                         ["bash", "send_message", "bash", "bash", "bash"],
                         "CommandExecution→bash 翻译 + function_call 原生名")
        self.assertEqual(calls[0]["observation"]["args_text"], "rm -rf /tmp/x",
                         "shell 前缀 /bin/zsh -lc 被剥掉")
        self.assertEqual(calls[2]["observation"]["args_text"], "echo boom")
        self.assertEqual(calls[0]["call_id"], "exec-1",
                         "call_id 用 item.id（Codex 无 call_id，CommandExecution 自带 id）")

        results = canonical["tool_results"]["entries"]
        self.assertEqual([e["observation"]["error_code"] for e in results],
                         [None, "exit_code:1", "exit_code:1", "exit_code:1", None],
                         "exit_code≠0 → 合成码；0 / output.error null → None")

        turns = canonical["turns"]["entries"]
        self.assertEqual(len(turns), 2)
        self.assertEqual(turns[0]["observation"]["turn"], 0)
        self.assertEqual(turns[0]["observation"]["sig"],
                         [("bash", "rm -rf /tmp/x")])
        self.assertEqual(turns[0]["observation"]["end_seq"], 4)
        self.assertEqual(turns[1]["observation"]["turn"], 1)
        self.assertEqual(len(turns[1]["observation"]["sig"]), 3)
        self.assertEqual(turns[1]["observation"]["end_seq"], 11)
        self.assertEqual(turns[1]["observation"]["end_time"], 200)

        self.assertEqual(canonical["approvals"]["entries"], [],
                         "Codex 无 asked/decided 生命周期，诚实保持空")

        # entry 坐标七字段（Rust TimelineEntry 同形）：
        self.assertEqual(
            set(calls[0]), {"observation", "seq", "time", "turn", "step",
                            "call_id", "ordinal"})

        # coverage lockstep：SandboxModes 计数与 timeline 条数一致且进 signals。
        self.assertEqual(canonical["coverage"]["SandboxModes"]["measured"], 2)
        self.assertIn("SandboxModes", canonical["signals"])

    def test_legacy_fallback_extracts_real_shell_cmds_only(self):
        """Legacy 线格式（真实 7/25：0 item_completed/CommandExecution，工具执行全
        是 custom_tool_call）→ 回退挖 `exec_command({cmd})` 真 shell 命令填 tool_calls。
        与 Rust `populate_legacy_fallback_extracts_real_shell_cmds_only` 逐条对齐：
        quote-aware 提取（双引号值内嵌单引号不截断）、apply_patch / JS 动态拼 cmd
        不翻 bash（SV601-603 只在 bash 上跑，不误报）、tool_results 恒空（无
        exit/error 源）、不进 turn sig（无 turn_id）。"""
        items = [
            {"type": "response_item", "timestamp": 0, "payload": {
                "type": "custom_tool_call", "name": "exec", "call_id": "call-1",
                "input": "const r = await tools.exec_command({\"cmd\":\"sed -n '1,240p' 'x'\"})"}},
            {"type": "response_item", "timestamp": 0, "payload": {
                "type": "custom_tool_call", "name": "exec", "call_id": "call-2",
                "input": "const r = await tools.apply_patch({patch: '...'})"}},
            {"type": "response_item", "timestamp": 0, "payload": {
                "type": "custom_tool_call", "name": "exec", "call_id": "call-3",
                "input": "const cmd = 'git log'; await tools.exec_command({cmd})"}},
            {"type": "response_item", "timestamp": 0, "payload": {
                "type": "custom_tool_call", "name": "exec", "call_id": "call-4",
                "input": "await tools.exec_command({'cmd':'ls -la'})"}},
        ]
        canonical = build_codex_evidence(
            items, "s1", "title", "legacy", "0.146.0", [], None)["canonical"]

        calls = canonical["tool_calls"]["entries"]
        self.assertEqual(len(calls), 2, "只挖得出真 shell 命令的才进 tool_calls")
        self.assertEqual(calls[0]["observation"]["name"], "bash")
        self.assertEqual(calls[0]["observation"]["args_text"], "sed -n '1,240p' 'x'",
                         "双引号值内嵌单引号必须完整保留，不许截成 sed -n 残片")
        self.assertEqual(calls[0]["call_id"], "call-1")
        self.assertEqual(calls[1]["observation"]["name"], "bash")
        self.assertEqual(calls[1]["observation"]["args_text"], "ls -la",
                         "单引号 cmd 值同样提取")
        self.assertEqual(canonical["tool_results"]["entries"], [],
                         "Legacy 工具结果无 exit/error 源 → 保持空（诚实 Unavailable）")
        self.assertEqual(canonical["turns"]["entries"], [],
                         "Legacy custom_tool_call 无 turn_id → 不进 turn sig")
        # coverage 侧 custom_tool_call 本来就计 ToolCalls measured——回退把 timeline
        # 补到与覆盖一致（4 条事件里 2 条挖得出 cmd），不是凭空造信号。
        self.assertEqual(canonical["coverage"]["ToolCalls"]["measured"], 4)


if __name__ == "__main__":
    unittest.main()
