"""`adapters/dsh.py::_is_usage_event` —— 哪些事件保留进 `usage_events`。

真实回归：`compaction/summary` 带真实 usage（实测
`{inputTokens:462, outputTokens:3520, cacheReadTokens:245760}`），但曾经
在这一层（adapter，比折叠层更早生效）就被挡在外面——折叠层 `usage.py`
的残差哨兵因此永远看不到它，报出"0 处漏算"这个假阴性。全量扫描 38 个
真实会话文件，靠人工翻原始日志才发现这个类型漏了。

这里只测 `_is_usage_event` 本身（宽进/严出的"哪些事件留下来"这一层），
不重复测 `usage.py` 里逐个消费者的折叠逻辑——那些在
`test_characterization.py::TestCompactionUsage` 里。Rust 平行实现
`src/dsh.rs::is_usage_event` 没有独立的 Python 单元测试镜像（它不是纯函数
意义上的差分对象，是 `read_session_log` 内部的私有谓词），差分靠
`test_cli_matrix.py` 的真实文件端到端对齐。
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "packages" / "agent-vitals-python"))

from agent_vitals.adapters.dsh import _is_usage_event  # noqa: E402


class TestIsUsageEvent(unittest.TestCase):
    def test_compaction_summary_with_usage_is_kept(self):
        event = {"type": "compaction/summary", "data": {
            "compactionId": "c1", "model": "deepseek-v4-flash",
            "provider": "deepseek-official",
            "usage": {"inputTokens": 462, "outputTokens": 3520, "cacheReadTokens": 245760},
        }}
        self.assertTrue(_is_usage_event(event, "compaction/summary"))

    def test_compaction_start_without_usage_is_dropped(self):
        """`compaction/start`/`compaction/end` 没有 usage 字段——不该被
        结构兜底误留（它们的 payload 里根本没有认得的 token 字段名）。"""
        event = {"type": "compaction/start", "data": {"compactionId": "c1", "turn": None}}
        self.assertFalse(_is_usage_event(event, "compaction/start"))

    def test_compaction_summary_with_non_dict_usage_is_dropped(self):
        event = {"type": "compaction/summary", "data": {"compactionId": "c1", "usage": "oops"}}
        self.assertFalse(_is_usage_event(event, "compaction/summary"))

    def test_unknown_type_with_usage_shaped_payload_is_kept_by_fallback(self):
        """结构兜底：类型完全不认识，但 payload 里有认得的 token 字段——
        留给折叠层的残差哨兵去报警，不在这一层悄悄丢掉。这正是这次
        `compaction/summary` 漏算 bug 的教训：宁可多留、让哨兵去判断，
        不能在 adapter 层就把决定权收走。"""
        event = {"type": "some/future-event-type", "data": {
            "inputTokens": 100, "outputTokens": 10,
        }}
        self.assertTrue(_is_usage_event(event, "some/future-event-type"))

    def test_unknown_type_without_usage_shaped_payload_is_dropped(self):
        event = {"type": "some/future-event-type", "data": {"note": "nothing usage-shaped here"}}
        self.assertFalse(_is_usage_event(event, "some/future-event-type"))

    def test_non_usage_assistant_chunk_falls_through_to_structural_check(self):
        """已知类型但形状不对（文本流 chunk）——精确判据不接住，兜底也接不住
        （文本块没有 token 字段），最终应该被丢弃，而不是因为类型"认识"就
        被放过精确判据检查。"""
        event = {"type": "assistant/chunk", "data": {"chunk": {"type": "text", "text": "hi"}}}
        self.assertFalse(_is_usage_event(event, "assistant/chunk"))

    def test_assistant_chunk_usage_type_is_kept(self):
        event = {"type": "assistant/chunk", "data": {
            "turn": 1, "step": 1,
            "chunk": {"type": "usage", "usage": {"inputTokens": 10, "outputTokens": 1}},
        }}
        self.assertTrue(_is_usage_event(event, "assistant/chunk"))

    def test_assistant_message_with_usage_is_kept(self):
        event = {"type": "assistant/message", "data": {
            "turn": 1, "step": 1, "usage": {"inputTokens": 10, "outputTokens": 1},
        }}
        self.assertTrue(_is_usage_event(event, "assistant/message"))

    def test_skill_catalog_source_is_always_kept(self):
        event = {"type": "user/message", "data": {"source": {"kind": "skill-catalog"}}}
        self.assertTrue(_is_usage_event(event, "user/message"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
