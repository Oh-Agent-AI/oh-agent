"""timeline entry ordinal 唯一性契约的 Python 镜像测试。

Rust 侧回归（`claude_code_evidence.rs` / `workbuddy_evidence.rs` 的
`ordinals_are_unique...` 与 `chain_note_*` 四态）在这里逐条镜像——ordinal 是
`evt-{ordinal}` 事件 id 的原料（`compatibility/canonical_session.rs`），撞号
就是 bridge 后事件 id 重复、按 ordinal 排序错乱。Claude 曾犯两种错：
`flush_turn` 硬编码 0、一条 message 多块共用记录序；WorkBuddy 的
sandbox-executed 一条记录产两条 entry（tool_calls + sandbox）曾共用记录序。
三处都必须按 entry 递增，`seq` 保持记录序不变。
"""

import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

sys.path.insert(0, str(ROOT / "packages" / "agent-vitals-python"))
from agent_vitals.claude_evidence import build_claude_evidence  # noqa: E402
from agent_vitals.workbuddy_evidence import (  # noqa: E402
    _chain_note,
    _populate_workbuddy_timelines,
)


def claude_records():
    """两条纯文本 turn 根 + 一条双 tool_use 块 assistant + 一条双 tool_result
    块 user——必须把「多块共用记录序」和「turn flush 穿插」两条都踩到。"""
    return [
        {"type": "user",
         "message": {"id": "m1", "content": "第一轮"},
         "timestamp": "2026-08-20T14:27:00Z"},
        {"type": "assistant",
         "message": {"id": "m2", "content": [
             {"type": "tool_use", "id": "tu1", "name": "Bash",
              "input": {"command": "ls"}},
             {"type": "tool_use", "id": "tu2", "name": "Write",
              "input": {"file_path": "/a"}},
         ]},
         "timestamp": "2026-08-20T14:27:05Z"},
        {"type": "user",
         "message": {"id": "m3", "content": [
             {"type": "tool_result", "tool_use_id": "tu1", "content": "ok",
              "is_error": True},
             {"type": "tool_result", "tool_use_id": "tu2", "content": "ok"},
         ]},
         "timestamp": "2026-08-20T14:27:08Z"},
        {"type": "user",
         "message": {"id": "m4", "content": "第二轮"},
         "timestamp": "2026-08-20T14:27:12Z"},
        {"type": "assistant",
         "message": {"id": "m5", "content": [
             {"type": "tool_use", "id": "tu3", "name": "Bash",
              "input": {"command": "git status"}},
         ]},
         "timestamp": "2026-08-20T14:27:15Z"},
    ]


class ClaudeTimelineOrdinalTests(unittest.TestCase):
    def test_ordinals_unique_across_three_timelines_and_seq_stays_record_index(self):
        canonical = build_claude_evidence(claude_records(), "s1")["canonical"]
        tc = canonical["tool_calls"]["entries"]
        tr = canonical["tool_results"]["entries"]
        turns = canonical["turns"]["entries"]
        self.assertEqual(len(tc), 3)
        self.assertEqual(len(tr), 2)
        self.assertEqual(len(turns), 2)

        # seq = 记录序：同记录多块共享（旧代码用记录序当 ordinal 的根源）。
        self.assertEqual([e["seq"] for e in tc], [1, 1, 4])
        self.assertEqual([e["seq"] for e in tr], [2, 2])

        # ordinal 跨三条 timeline 两两不同、push 序单调递增。
        ordinals = [e["ordinal"] for e in tc + tr + turns]
        self.assertEqual(sorted(ordinals), list(range(7)),
                         "ordinals 必须两两不同且覆盖 0..6: %r" % ordinals)
        self.assertEqual(len(set(ordinals)), 7)


class WorkbuddyTimelineOrdinalTests(unittest.TestCase):
    def _meta(self):
        return {"permission_mode": "fullAccess", "use_sandbox_cli": 1}

    def test_sandbox_executed_dual_entries_have_distinct_ordinals(self):
        # 真机词表：命令类 eventType 是 category 全限定名（纸面裸名零命中——
        # 2026-09-02 schema-drift 事故，见 workbuddy_evidence.KNOWN_EVENT_TYPES）。
        records = [
            {"sequence": 1, "category": "command-safety",
             "eventType": "command-safety.sandbox-executed", "toolCallId": "c1",
             "commandPreview": "ls", "timestamp": "2026-08-31T10:00:00Z"},
            {"sequence": 2, "category": "network", "eventType": "WebFetch",
             "toolCallId": "c2",
             "messageParams": {"target": "https://example.com"},
             "timestamp": "2026-08-31T10:00:01Z"},
            {"sequence": 3, "category": "command-safety",
             "eventType": "command-safety.sandbox-executed", "toolCallId": "c3",
             "commandPreview": "pwd", "timestamp": "2026-08-31T10:00:02Z"},
        ]
        timelines, unknown = _populate_workbuddy_timelines(records, self._meta(), [])
        self.assertEqual(unknown, [])
        self.assertEqual(len(timelines["tool_calls"]), 3)
        self.assertEqual(len(timelines["sandbox_modes"]), 2)
        ords = ([e["ordinal"] for e in timelines["tool_calls"]]
                + [e["ordinal"] for e in timelines["sandbox_modes"]])
        # 旧代码（记录序）：[0, 1, 2, 0, 2] 撞号；新代码按 entry 递增唯一。
        self.assertEqual(ords, [0, 2, 3, 1, 4],
                         "tool_calls 与 sandbox 的 ordinal 交错唯一")
        self.assertEqual([e["seq"] for e in timelines["tool_calls"]], [0, 1, 2])
        self.assertEqual([e["seq"] for e in timelines["sandbox_modes"]], [0, 2])


class ChainNoteTests(unittest.TestCase):
    """`_chain_note` 四态（Rust `chain_note_*` 镜像）：单条/连续/断链/轮转头。
    文案逐字节钉死——差分测试（`both()`）靠两份实现给出同串。"""

    def test_single_record_has_no_links_to_verify(self):
        self.assertEqual(
            _chain_note([{"sequence": 7, "hash": "h7", "prevHash": ""}]),
            "audit-log hash chain: 1 record, no links to verify (verified from seq=7)")

    def test_continuous_chain_reports_count(self):
        records = [
            {"sequence": 1, "hash": "h1", "prevHash": ""},
            {"sequence": 2, "hash": "h2", "prevHash": "h1"},
            {"sequence": 3, "hash": "h3", "prevHash": "h2"},
        ]
        self.assertEqual(
            _chain_note(records),
            "audit-log hash chain continuous: 3 records (verified from seq=1)")

    def test_broken_link_names_both_seqs(self):
        records = [
            {"sequence": 1, "hash": "h1", "prevHash": ""},
            {"sequence": 2, "hash": "h2", "prevHash": "wrong"},
        ]
        self.assertEqual(
            _chain_note(records),
            "audit-log hash chain broken at seq=2 (prevHash does not match hash of seq=1)")

    def test_rotated_head_is_honest_about_verification_start(self):
        records = [
            {"sequence": 5, "hash": "h5", "prevHash": "h4"},
            {"sequence": 6, "hash": "h6", "prevHash": "h5"},
        ]
        self.assertEqual(
            _chain_note(records),
            "audit-log hash chain verified from seq=5: oldest records may be "
            "rotated (first prevHash has no predecessor)")


if __name__ == "__main__":
    unittest.main()
