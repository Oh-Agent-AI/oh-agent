#!/usr/bin/env python3
"""可续折叠的 §10.2 契约测试（resumable fold，差分测试的 watch 第一步）。

契约原文（RUNTIME_EVIDENCE_CONTRACT.md §10.2）：

    `fold(events[0..n]) == fold_resume(checkpoint@k, events[k..n])`
    对任何 **turn 边界** k 成立。

「checkpoint 是一个值，不是进程」——`UsageFoldState` 只捕获跨 turn 延续的
状态（by_model/providers/active/sequence/seen/samples/unaccounted），
`last` 同 step 去重槽**不在里面**：turn 边界之后第一条 usage 必是新 turn，
不可能命中前缀最后的 (turn, step)。这套测试证明这一取舍——所有 turn 边界切分
下 resume 都逐字节等于全量重折，而 checkpoint 本身可以反复复用。

Rust 侧镜像（`usage.rs` 的 `#[cfg(test)]`）：同款不变量 + 两处逐字节
characterization（`usage_fold_resume` / `usage_fold_checkpoint_json`），本文件
断言的值与它们硬编码的期望串同源（都在 Python 侧生成）。
"""

import copy
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "packages" / "agent-vitals-python"))
from agent_vitals import usage as U  # noqa: E402
from agent_vitals.util import fork_boundary  # noqa: E402

FIXTURE = ROOT / "fixtures" / "dsh" / "resume.jsonl"


def _load_fixture():
    with open(FIXTURE) as f:
        return [json.loads(line) for line in f if line.strip()]


class ResumableFoldTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.events = _load_fixture()
        # fixture 必须真的是 3 个 turn——测试的语义建立在 3 段 turn 上
        # （pro → flash → 回 pro + compaction + 同 step 替换 + 哨兵）。
        cls.turn_starts = [
            i for i, e in enumerate(cls.events)
            if e.get("type") == "turn/start"
        ]
        assert len(cls.turn_starts) == 3, "fixture 必须是 3 个 turn"

    def turn_boundaries(self):
        """k=0 与每个 turn/start 下标与末尾——§10.2 契约保证的切分点。"""
        return [0] + self.turn_starts + [len(self.events)]

    def test_resume_equals_full_fold_at_all_turn_boundaries(self):
        """`fold(0..n) == fold_resume(checkpoint@k, k..n)` 对每个 turn 边界成立。"""
        full = U.token_by_model(self.events)
        for k in self.turn_boundaries():
            cp = U.usage_fold_checkpoint(self.events[:k])
            resumed = U.usage_fold_resume(cp, self.events[k:])
            self.assertEqual(resumed, full, f"resume at k={k} 必须等于全量重折")

    def test_resume_equals_full_fold_including_sentinel_and_compaction(self):
        """resume 的最终输出连残差哨兵 / compaction 模型覆盖都钉住——不是
        「形状对」，是「每个字段逐字节对」。
        """
        k = self.turn_starts[1]  # turn 2 起点
        cp = U.usage_fold_checkpoint(self.events[:k])
        resumed = U.usage_fold_resume(cp, self.events[k:])
        # 数值：pro = 1200(turn1 净) + 3100(turn3 替换后) = 4300；
        # flash = 2000/500/100；compaction 自带 flash 模型 462/3520/245760。
        pro = resumed["by_model"]["deepseek/deepseek-v4-pro-0813"]
        self.assertEqual(pro["uncached_input_tokens"], 4300)
        self.assertEqual(pro["output_tokens"], 250)
        self.assertEqual(pro["cache_read_tokens"], 1300)
        self.assertEqual(resumed["by_model"]["deepseek/deepseek-v4-flash"]
                         ["uncached_input_tokens"], 2000)
        self.assertEqual(resumed["by_model"]["deepseek-v4-flash"]
                         ["uncached_input_tokens"], 462)
        # peak_* 全 0：fixture 全在非高峰（2025-06-15 周日 23 点后）。
        self.assertEqual(pro["peak_uncached_input_tokens"], 0)
        # 哨兵：缺 turn/step 的 assistant/message 被接住（77+9=86）。
        self.assertEqual(resumed["unaccounted_usage"],
                         [{"type": "assistant/message", "count": 1, "tokens_seen": 86}])
        self.assertEqual(resumed["unreported_fields"], ["cacheWriteTokens"])

    def test_resume_does_not_mutate_the_input_checkpoint(self):
        """checkpoint 是可复用值——resume 不得改它（Rust 侧 clone 的镜像）。

        如果 resume 在调用方状态上原地折，第二次 resume 同一 checkpoint 就会
        翻倍——这正是「checkpoint 是值不是进程」要防的静默双计。
        """
        k = self.turn_starts[1]
        cp = U.usage_fold_checkpoint(self.events[:k])
        snapshot = copy.deepcopy(cp)
        U.usage_fold_resume(cp, self.events[k:])
        U.usage_fold_resume(cp, self.events[k:])
        self.assertEqual(cp, snapshot,
                         "resume 后 checkpoint 必须原样——可复用两次不翻倍")

    def test_checkpoint_json_round_trips(self):
        """to_json → from_json → 同一 render 输出，active 不丢。"""
        cp = U.usage_fold_checkpoint(self.events)
        restored = U.usage_fold_resume_from_json(U.usage_fold_checkpoint_json(cp))
        self.assertEqual(U.usage_fold_render(restored), U.usage_fold_render(cp))
        self.assertEqual(restored["active"], cp["active"])
        self.assertEqual(restored["samples"], cp["samples"])
        self.assertEqual(restored["unaccounted"], cp["unaccounted"])

    def test_checkpoint_json_serialization_is_pinned(self):
        """checkpoint_json 的序列化形状钉死（Rust 侧 byte-for-byte 同源）。
        `seen` 是 _SAMPLE_FIELDS 顺序的 4 个 bool；`unaccounted` 每条是
        `[count, tokens_seen]` 列表；by_model 保插入序。
        """
        cp = U.usage_fold_checkpoint(self.events)
        out = U.usage_fold_checkpoint_json(cp)
        self.assertEqual(
            json.dumps(out, ensure_ascii=False, separators=(",", ":")),
            '{"by_model":{"deepseek/deepseek-v4-pro-0813":{"uncached_input_tokens":4300,"output_tokens":250,"cache_read_tokens":1300,"cache_write_tokens":0,"peak_uncached_input_tokens":0,"peak_output_tokens":0,"peak_cache_read_tokens":0,"peak_cache_write_tokens":0},"deepseek/deepseek-v4-flash":{"uncached_input_tokens":2000,"output_tokens":500,"cache_read_tokens":100,"cache_write_tokens":0,"peak_uncached_input_tokens":0,"peak_output_tokens":0,"peak_cache_read_tokens":0,"peak_cache_write_tokens":0},"deepseek-v4-flash":{"uncached_input_tokens":462,"output_tokens":3520,"cache_read_tokens":245760,"cache_write_tokens":0,"peak_uncached_input_tokens":0,"peak_output_tokens":0,"peak_cache_read_tokens":0,"peak_cache_write_tokens":0}},"providers":{"deepseek/deepseek-v4-pro-0813":"shengsuanyun","deepseek/deepseek-v4-flash":"deepseek-official","deepseek-v4-flash":"deepseek-official"},"active":"deepseek/deepseek-v4-pro-0813","sequence":["deepseek/deepseek-v4-pro-0813","deepseek/deepseek-v4-flash","deepseek/deepseek-v4-pro-0813"],"seen":[true,true,true,false],"samples":6,"unaccounted":{"assistant/message":[1,86]}}'
        )

    def test_fixture_has_no_fork_boundary(self):
        """fixture 的 session 头没有 `seedLength` → 没有分叉边界。

        这是 resume 设计的前提：checkpoint 折的是**分叉之后**的流；resume 的
        后缀里没有 session 头，重算 `fork_boundary` 得到 None（= 不过滤），
        与「前缀已滤、后缀无分叉事件」一致。若 fixture 意外带 seedLength，
        这个测试会红——说明测试建立在错误的前提上。
        """
        self.assertIsNone(fork_boundary(self.events), "resume fixture 不应有分叉边界")


if __name__ == "__main__":
    unittest.main()
