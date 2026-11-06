"""Claude 回合判据的 Python 镜像（`claude_evidence.turn_signal`）逐例对齐 Rust
`harnesses::claude_code::sessions::turns::turn_signal` 的单测。

回归背景（SESSION_TRACE_DIAGNOSTICS_SPEC r6 P0）：evidence 曾用「字符串或不含
tool_result 的数组」开 turn，把 skill 正文注入、`<task-notification>`、中断标记都
算成新 turn；workflow 却只认会话首条文本——同一会话在调用树与消耗诊断里回合数
对不上。现两侧共用一个判据，本文件钉 Python 侧。"""
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "packages", "agent-vitals-python"))

from agent_vitals.agent.claude_evidence import turn_signal  # noqa: E402


def user(content, **flags):
    record = {"type": "user", "message": {"content": content}}
    record.update(flags)
    return record


class ClaudeTurnSignalTests(unittest.TestCase):
    def test_first_turn_uses_the_historical_predicate(self):
        self.assertEqual(turn_signal(user("<command-name>/model</command-name>"), False), "request")
        self.assertEqual(turn_signal(user(""), False), "other")
        self.assertEqual(turn_signal(user([{"type": "tool_result", "tool_use_id": "x"}]), False), "other")
        self.assertEqual(turn_signal(user("hi", isSidechain=True), False), "other")

    def test_later_turns_exclude_echoes_meta_and_settings_commands(self):
        others = [
            user("<task-notification>\n<task-id>x</task-id>"),
            user("<local-command-stdout>ok</local-command-stdout>"),
            user("<command-name>/model</command-name>"),
            user("<bash-input>ls</bash-input>"),
            user("Base directory for this skill", isMeta=True),
            user("This session is being continued", isCompactSummary=True),
            user("subagent prompt", isSidechain=True),
            user([{"type": "tool_result", "tool_use_id": "x", "content": "ok"}]),
        ]
        for record in others:
            self.assertEqual(turn_signal(record, True), "other", record)
        self.assertEqual(turn_signal(user("fix the bug"), True), "request")
        self.assertEqual(turn_signal(user([{"type": "text", "text": "分析这张图 [Image #1]"}, {"type": "image", "source": {}}]), True),
                         "request", "贴图的请求也开回合")
        self.assertEqual(turn_signal(user([{"type": "image", "source": {}}]), True), "other")
        self.assertEqual(turn_signal("not a dict", True), "other")
        self.assertEqual(turn_signal(user("<command-name>/goal</command-name>"), True), "request")
        self.assertEqual(
            turn_signal(user([{"type": "text", "text": "[Request interrupted by user]"}]), True), "interrupt")

    def test_non_boolean_flags_do_not_count(self):
        # Rust `as_bool` 只认 JSON 布尔：`"isMeta": 1` 不是 meta。
        self.assertEqual(turn_signal(user("real request", isMeta=1), True), "request")


if __name__ == "__main__":
    unittest.main()
