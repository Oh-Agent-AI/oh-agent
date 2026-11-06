#!/usr/bin/env python3
"""Stage 1：共享 extractor `parse_claude_usage_row` 的钉测（commit 1 + commit 2b + Stage 1c）。

R1 架构审核（commit d0ec2f2）要求 fold 与 UsageFact emitter 共用同一个 row
parser。本测试验证 extractor 自身的字段映射与 sentinel 触发条件 + emit 端到端
（facts/attempts/coverage）——不验证 fold 字节一致性（那是
`tests/test_claude_cost.py` 的 `test_python_rust_state_and_stdout_byte_equal`
+ `golden_runner.py` 的职责）。

Stage 1c（外部代码审核后的修复提交）：补 R1 §3.2/§3.4/§9 的验收契约——
事件身份链 message.id → 顶层 uuid → offset+canonical-hash fallback、重复
source_event_id 去重 + duplicate attempt、provider/model 不再硬编码 DeepSeek
（claude-native model 原样走 model_raw）、CLI 无 state 写（缺
--machine-namespace exit 2）。这些分支都进 `ClaudeUsageFactsBothTests` 的
混合语料做 Python↔Rust byte-parity。

跑法：python3 -m unittest tests.test_claude_usage_fact -v
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "packages" / "agent-vitals-python"))

_BIN = os.environ.get("AGENT_VITALS_BIN")
_BIN = str(Path(_BIN).resolve()) if _BIN else None
PY_CMD = [sys.executable, str(ROOT / "scripts" / "scan.py")]

from agent_vitals.agent.claude_usage_fact import (  # noqa: E402
    ClaudeUsageObservation,
    SKIP,
    UNATTRIBUTED,
    UNREADABLE,
    Skip,
    parse_claude_usage_row,
)


VALID_ASSISTANT = {
    "type": "assistant",
    "timestamp": "2026-09-02T03:00:00.000Z",
    "message": {
        "id": "msg_abc123",
        "model": "deepseek-v4-flash",
        "usage": {
            "input_tokens": 100,
            "cache_read_input_tokens": 50,
            "cache_creation_input_tokens": 10,
            "output_tokens": 5,
        },
    },
}


def _stage1c_corpus():
    """Stage 1c 混合语料（9 行）——Python-only emit 钉测与 Both byte-parity
    共用同一份，行注释标注期望分支。两个无 id 行内容不同 → canonical hash
    不同 → 两条 derived fact（offset+hash 跨语言一致就靠它俩验）。"""
    return [
        # (1) cost-state → skip
        {"type": "cost-state",
         "timestamp": "2026-09-01T18:00:00.000Z",
         "startTime": 1_788_192_000_000,
         "modelUsage": {"deepseek-v4-flash": {
             "inputTokens": 0, "outputTokens": 0,
             "cacheReadInputTokens": 38_700_000,
             "cacheCreationInputTokens": 0,
             "webSearchRequests": 0, "costUSD": 0.0}},
         "hasUnknownModelCost": False},
        # (2) message.id native + Claude 原生模型 → fact
        {"type": "assistant", "timestamp": "2026-09-02T03:00:00.000Z",
         "message": {"id": "msg_full_1", "model": "claude-sonnet-5",
                     "usage": {"input_tokens": 100, "cache_read_input_tokens": 1_500_000,
                               "cache_creation_input_tokens": 0, "output_tokens": 5}}},
        # (3) 同 message.id 重复 → duplicate attempt、只留一个 fact
        {"type": "assistant", "timestamp": "2026-09-02T04:00:00.000Z",
         "message": {"id": "msg_full_1", "model": "claude-sonnet-5",
                     "usage": {"input_tokens": 100, "cache_read_input_tokens": 1_500_000,
                               "cache_creation_input_tokens": 0, "output_tokens": 5}}},
        # (4) 顶层 uuid 原生（无 message.id）→ fact
        {"type": "assistant", "timestamp": "2026-09-02T06:00:00.000Z",
         "uuid": "uuid_only_1",
         "message": {"model": "claude-sonnet-5",
                     "usage": {"input_tokens": 50, "cache_read_input_tokens": 0,
                               "cache_creation_input_tokens": 0, "output_tokens": 1}}},
        # (5) 无 message.id / uuid → derived offset+hash fact #1
        {"type": "assistant", "timestamp": "2026-09-02T07:00:00.000Z",
         "message": {"model": "deepseek-v4-flash",
                     "usage": {"input_tokens": 200, "cache_read_input_tokens": 0,
                               "cache_creation_input_tokens": 0, "output_tokens": 7}}},
        # (6) 无 message.id / uuid → derived offset+hash fact #2（内容不同）
        {"type": "assistant", "timestamp": "2026-09-02T08:00:00.000Z",
         "message": {"model": "deepseek-v4-flash",
                     "usage": {"input_tokens": 1, "cache_read_input_tokens": 0,
                               "cache_creation_input_tokens": 0, "output_tokens": 0}}},
        # (7) 有 usage 无 model → unreadable
        {"type": "assistant", "timestamp": "2026-09-02T09:00:00.000Z",
         "message": {"usage": {"input_tokens": 1, "cache_read_input_tokens": 0,
                               "cache_creation_input_tokens": 0, "output_tokens": 0}}},
        # (8) 坏 ts → unattributed
        {"type": "assistant", "timestamp": "bogus",
         "message": {"model": "deepseek-v4-flash",
                     "usage": {"input_tokens": 1, "cache_read_input_tokens": 0,
                               "cache_creation_input_tokens": 0, "output_tokens": 0}}},
        # (9) 短键 native（全形/短键两态都认）→ fact
        {"type": "assistant", "timestamp": "2026-09-02T10:00:00.000Z",
         "message": {"id": "msg_short_1", "model": "deepseek-v4-flash",
                     "usage": {"input": 10, "cache_read": 20,
                               "cache_creation": 30, "output": 40}}},
    ]


class ParseClaudeUsageRowCase(unittest.TestCase):
    """`parse_claude_usage_row` 的纯函数钉测——不依赖 fold/emit，
    只看字段映射与 sentinel 触发条件。"""

    def test_valid_assistant_returns_observation(self):
        obs = parse_claude_usage_row(
            VALID_ASSISTANT,
            native_session_id="sess-1",
            machine_namespace="ns-1",
            source_profile="default",
        )
        self.assertIsInstance(obs, ClaudeUsageObservation)
        self.assertEqual(obs.native_session_id, "sess-1")
        self.assertEqual(obs.machine_namespace, "ns-1")
        self.assertEqual(obs.source_profile, "default")
        self.assertEqual(obs.observation_kind, "assistant-usage")
        self.assertEqual(obs.source_event_id, "msg_abc123")
        # identity_basis="native"：message.id 取到 → native（不是 derived-hash）。
        self.assertEqual(obs.identity_basis, "native")
        self.assertEqual(obs.ts_iso, "2026-09-02T03:00:00.000Z")
        self.assertEqual(obs.day, "2026-09-02")
        self.assertIsNotNone(obs.ms, "合法 ts 必须解出 epoch ms")
        self.assertEqual(obs.model, "deepseek-v4-flash")
        self.assertEqual(obs.input_tokens, 100)
        self.assertEqual(obs.cache_read_tokens, 50)
        self.assertEqual(obs.cache_write_tokens, 10)
        self.assertEqual(obs.output_tokens, 5)

    def test_non_dict_returns_skip(self):
        """非 dict rec（坏行 / 空行）→ Skip(SKIP)，不增 sentinel。"""
        for bad in [None, "string", 42, [], {"no_type": 1}]:
            result = parse_claude_usage_row(
                bad,
                native_session_id="s",
                machine_namespace="ns",
                source_profile="default",
            )
            self.assertIsInstance(result, Skip)
            self.assertEqual(result.reason, SKIP)

    def test_cost_state_returns_skip(self):
        """cost-state 是累计 baseline，不是 usage observation → Skip(SKIP)。"""
        result = parse_claude_usage_row(
            {"type": "cost-state",
             "modelUsage": {"claude-opus-5": {"inputTokens": 100}}},
            native_session_id="s",
            machine_namespace="ns",
            source_profile="default",
        )
        self.assertIsInstance(result, Skip)
        self.assertEqual(result.reason, SKIP)

    def test_message_not_dict_returns_skip(self):
        """assistant 但 message 不是 dict → Skip(SKIP)，不增 sentinel。
        与旧 `_apply_record` 行为一致。"""
        result = parse_claude_usage_row(
            {"type": "assistant", "timestamp": "2026-09-02T03:00:00.000Z",
             "message": "not a dict"},
            native_session_id="s",
            machine_namespace="ns",
            source_profile="default",
        )
        self.assertIsInstance(result, Skip)
        self.assertEqual(result.reason, SKIP)

    def test_no_usage_returns_skip(self):
        """assistant 但 usage 空 → Skip(SKIP)，不增 sentinel。"""
        result = parse_claude_usage_row(
            {"type": "assistant", "timestamp": "2026-09-02T03:00:00.000Z",
             "message": {"model": "m", "usage": {}}},
            native_session_id="s",
            machine_namespace="ns",
            source_profile="default",
        )
        self.assertIsInstance(result, Skip)
        self.assertEqual(result.reason, SKIP)

    def test_no_model_returns_unreadable(self):
        """有 usage 但缺 model → Skip(UNREADABLE)。旧版 sentinel 同款。"""
        result = parse_claude_usage_row(
            {"type": "assistant", "timestamp": "2026-09-02T03:00:00.000Z",
             "message": {"usage": {"input_tokens": 1, "cache_read_input_tokens": 0,
                                   "cache_creation_input_tokens": 0, "output_tokens": 0}}},
            native_session_id="s",
            machine_namespace="ns",
            source_profile="default",
        )
        self.assertIsInstance(result, Skip)
        self.assertEqual(result.reason, UNREADABLE)

    def test_bad_usage_shape_returns_unreadable(self):
        """usage 两态皆无（真机 P0 哨兵）→ Skip(UNREADABLE)。"""
        result = parse_claude_usage_row(
            {"type": "assistant", "timestamp": "2026-09-02T03:00:00.000Z",
             "message": {"model": "m", "usage": {"prompt_tokens": 1}}},
            native_session_id="s",
            machine_namespace="ns",
            source_profile="default",
        )
        self.assertIsInstance(result, Skip)
        self.assertEqual(result.reason, UNREADABLE)

    def test_unparseable_ts_returns_unattributed(self):
        """ts 不可解析 → Skip(UNATTRIBUTED)。旧版 sentinel 同款。
        4 型 token 都齐：先过 _row_tokens，再到 ts 解析，sentinel 是
        UNATTRIBUTED（不是 UNREADABLE）。"""
        result = parse_claude_usage_row(
            {"type": "assistant", "timestamp": "bogus",
             "message": {"model": "m",
                         "usage": {"input_tokens": 1, "cache_read_input_tokens": 0,
                                   "cache_creation_input_tokens": 0, "output_tokens": 0}}},
            native_session_id="s",
            machine_namespace="ns",
            source_profile="default",
        )
        self.assertIsInstance(result, Skip)
        self.assertEqual(result.reason, UNATTRIBUTED)

    def test_no_message_id_marks_derived_hash(self):
        """message.id 与顶层 uuid 都缺 → source_event_id=None +
        identity_basis=derived-hash（parse 是纯 record→result 映射；offset+hash
        fallback 由文件级迭代器补，Stage 1c 后 emitter 见到的身份恒非空）。"""
        obs = parse_claude_usage_row(
            {"type": "assistant", "timestamp": "2026-09-02T03:00:00.000Z",
             "message": {"model": "m",
                         "usage": {"input_tokens": 1, "cache_read_input_tokens": 0,
                                   "cache_creation_input_tokens": 0, "output_tokens": 0}}},
            native_session_id="s",
            machine_namespace="ns",
            source_profile="default",
        )
        self.assertIsInstance(obs, ClaudeUsageObservation)
        self.assertIsNone(obs.source_event_id,
                          "parse 层只解析原生 id 可达的部分——offset+hash 由迭代器补")
        self.assertEqual(obs.identity_basis, "derived-hash")

    def test_top_level_uuid_is_native_fallback(self):
        """缺 message.id 但有**顶层** uuid（真机 assistant 行 uuid 位于顶层，
        Stage 1c 补全）→ 原生身份，identity_basis=native——不再被错降级成
        derived-hash。"""
        obs = parse_claude_usage_row(
            {"type": "assistant", "timestamp": "2026-09-02T03:00:00.000Z",
             "uuid": "uuid-2026-xyz",
             "message": {"model": "m",
                         "usage": {"input_tokens": 1, "cache_read_input_tokens": 0,
                                   "cache_creation_input_tokens": 0, "output_tokens": 0}}},
            native_session_id="s",
            machine_namespace="ns",
            source_profile="default",
        )
        self.assertIsInstance(obs, ClaudeUsageObservation)
        self.assertEqual(obs.source_event_id, "uuid-2026-xyz")
        self.assertEqual(obs.identity_basis, "native")

    def test_message_id_precedes_uuid(self):
        """两者都在时 message.id 优先（§3.1 顺序：message.id → uuid →
        fallback）——不是取后写者。"""
        obs = parse_claude_usage_row(
            {"type": "assistant", "timestamp": "2026-09-02T03:00:00.000Z",
             "uuid": "uuid-shadowed",
             "message": {"id": "msg_prio", "model": "m",
                         "usage": {"input_tokens": 1, "cache_read_input_tokens": 0,
                                   "cache_creation_input_tokens": 0, "output_tokens": 0}}},
            native_session_id="s",
            machine_namespace="ns",
            source_profile="default",
        )
        self.assertEqual(obs.source_event_id, "msg_prio")
        self.assertEqual(obs.identity_basis, "native")

    def test_short_keys_shape_also_accepted(self):
        """`_row_tokens` 嗅两态——短键（真机 0 命中但仍认）也走 Observation。"""
        obs = parse_claude_usage_row(
            {"type": "assistant", "timestamp": "2026-09-02T03:00:00.000Z",
             "message": {"model": "m",
                         "usage": {"input": 1, "cache_read": 2,
                                   "cache_creation": 3, "output": 4}}},
            native_session_id="s",
            machine_namespace="ns",
            source_profile="default",
        )
        self.assertIsInstance(obs, ClaudeUsageObservation)
        self.assertEqual(obs.input_tokens, 1)
        self.assertEqual(obs.cache_read_tokens, 2)
        self.assertEqual(obs.cache_write_tokens, 3)
        self.assertEqual(obs.output_tokens, 4)

    def test_native_session_id_threads_through(self):
        """native_session_id 从 caller 注入，不从 rec 读——R2a SessionKey
        第二层（harness_kind/native_id/source_profile/machine_namespace）的
        第 2 段，与 locate 阶段稳定派生对齐。"""
        obs = parse_claude_usage_row(
            VALID_ASSISTANT,
            native_session_id="specific-sid",
            machine_namespace="ns",
            source_profile="default",
        )
        self.assertEqual(obs.native_session_id, "specific-sid",
                         "native_session_id 必须从 caller 注入，extractor 不读 rec")


class EmitEndToEndCase(unittest.TestCase):
    """Stage 1 commit 2：`claude_jsonl_to_usage_facts` 端到端钉测。

    复用 `tests/test_claude_cost.py::ClaudeSyncBothTests` 的真机 fixture
    数据（2279b7b0 / 753e080a / b695a35f 三会话）——见 commit 6421f2a。
    本测试只验 Python 端 emit；Rust 镜像 parity 在 commit 2b 钉测。
    """

    def _write_session(self, d, name, rows):
        d.mkdir(parents=True, exist_ok=True)
        (d / name).write_text(
            "".join(__import__("json").dumps(r) + "\n" for r in rows),
            encoding="utf-8",
        )

    def _real_world_rows(self):
        """复用 commit 6421f2a 真机数字：2279b7b0 / 753e080a / b695a35f。
        ms 约定与 RealWorldMisattributionCase 同款。
        """
        start_0901_bj = 1_788_192_000_000
        start_0901_bj_mid = 1_788_235_200_000
        start_0831_bj_eve = 1_788_170_400_000
        rows_2279 = [
            {"type": "cost-state",
             "timestamp": "2026-09-01T18:00:00.000Z",
             "startTime": start_0901_bj,
             "modelUsage": {"deepseek-v4-flash": {
                 "inputTokens": 0, "outputTokens": 0,
                 "cacheReadInputTokens": 38_700_000,
                 "cacheCreationInputTokens": 0,
                 "webSearchRequests": 0, "costUSD": 0.0}},
             "hasUnknownModelCost": False},
            {"type": "assistant", "timestamp": "2026-09-02T03:00:00.000Z",
             "message": {"id": "msg_2279_1", "model": "deepseek-v4-flash",
                         "usage": {"input_tokens": 0, "cache_read_input_tokens": 1_500_000,
                                   "cache_creation_input_tokens": 0, "output_tokens": 0}}},
            {"type": "assistant", "timestamp": "2026-09-02T05:00:00.000Z",
             "message": {"id": "msg_2279_2", "model": "deepseek-v4-flash",
                         "usage": {"input_tokens": 0, "cache_read_input_tokens": 1_500_000,
                                   "cache_creation_input_tokens": 0, "output_tokens": 0}}},
            {"type": "assistant", "timestamp": "2026-09-02T07:00:00.000Z",
             "message": {"id": "msg_2279_3", "model": "deepseek-v4-flash",
                         "usage": {"input_tokens": 0, "cache_read_input_tokens": 1_500_000,
                                   "cache_creation_input_tokens": 0, "output_tokens": 0}}},
            {"type": "assistant", "timestamp": "2026-09-02T09:00:00.000Z",
             "message": {"id": "msg_2279_4", "model": "deepseek-v4-flash",
                         "usage": {"input_tokens": 0, "cache_read_input_tokens": 1_200_000,
                                   "cache_creation_input_tokens": 0, "output_tokens": 0}}},
        ]
        rows_753e = [
            {"type": "cost-state",
             "timestamp": "2026-09-01T18:00:00.000Z",
             "startTime": start_0901_bj_mid,
             "modelUsage": {"deepseek-v4-flash": {
                 "inputTokens": 0, "outputTokens": 0,
                 "cacheReadInputTokens": 137_100_000,
                 "cacheCreationInputTokens": 0,
                 "webSearchRequests": 0, "costUSD": 0.0}},
             "hasUnknownModelCost": False},
            *[{"type": "assistant",
               "timestamp": "2026-09-02T%02d:00:00.000Z" % h,
               "message": {"id": "msg_753e_%d" % (h // 2), "model": "deepseek-v4-flash",
                           "usage": {"input_tokens": 0, "cache_read_input_tokens": 11_225_000,
                                     "cache_creation_input_tokens": 0, "output_tokens": 0}}}
              for h in (3, 5, 7, 9)],
        ]
        rows_b695 = [
            {"type": "cost-state",
             "timestamp": "2026-09-01T18:00:00.000Z",
             "startTime": start_0831_bj_eve,
             "modelUsage": {"deepseek-v4-flash": {
                 "inputTokens": 0, "outputTokens": 0,
                 "cacheReadInputTokens": 88_300_000,
                 "cacheCreationInputTokens": 0,
                 "webSearchRequests": 0, "costUSD": 0.0}},
             "hasUnknownModelCost": False},
            *[{"type": "assistant",
               "timestamp": "2026-09-02T%02d:00:00.000Z" % h,
               "message": {"id": "msg_b695_%d" % (h // 2), "model": "deepseek-v4-flash",
                           "usage": {"input_tokens": 0, "cache_read_input_tokens": 4_000_000,
                                     "cache_creation_input_tokens": 0, "output_tokens": 0}}}
              for h in (3, 5, 7, 9)],
        ]
        return {"2279b7b0": rows_2279, "753e080a": rows_753e, "b695a35f": rows_b695}

    def test_real_world_197_5M_emit_totals(self):
        """复用 commit 6421f2a 的 2279b7b0 / 753e080a / b695a35f 真机语料：
        - 3 个 cost-state（baseline 对账锚）→ Skip("skip")
        - 4 + 4 + 4 = 12 条 assistant usage row → emit 12 个 UsageFact
        - 总 token cache_read = 66_600_000（5.7 + 44.9 + 16.0 = 66.6M）
        - attempts["skip"] == 3、coverage.fact_rows == 12
        """
        import json
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            tmpd = Path(tmp)
            for name, rows in self._real_world_rows().items():
                self._write_session(tmpd, name + ".jsonl", rows)
            # 三份文件分别 emit，合并 attempts/coverage/facts
            from agent_vitals.agent.claude_usage_fact import claude_jsonl_to_usage_facts
            all_facts = []
            all_attempts = {"skip": 0, "unreadable": 0, "unattributed": 0}
            total_rows = 0
            total_facts = 0
            for name in ("2279b7b0", "753e080a", "b695a35f"):
                result = claude_jsonl_to_usage_facts(
                    tmpd / (name + ".jsonl"),
                    machine_namespace="ns-test",
                    source_profile="default",
                    native_session_id=name,
                )
                all_facts.extend(result.facts)
                for k, v in result.attempts.items():
                    all_attempts[k] = all_attempts.get(k, 0) + v
                total_rows += result.coverage["total_rows"]
                total_facts += result.coverage["fact_rows"]
            self.assertEqual(total_rows, 15, "3 份 × (1 cost-state + 4 assistant) = 15")
            self.assertEqual(total_facts, 12, "12 条 assistant → 12 个 fact")
            self.assertEqual(all_attempts["skip"], 3, "3 个 cost-state → 3 skip")
            # 合计 cache_read tokens = 66.6M（spec §5 后段点名数字）
            cr_total = sum(f["cache_read_tokens"] for f in all_facts)
            self.assertEqual(cr_total, 66_600_000)
            # 每条 fact 的 identity_basis="native"（message.id 取到）
            self.assertTrue(all(f["identity_basis"] == "native" for f in all_facts))
            # fact_id 跨三会话唯一（per-session sid 区别）
            fact_ids = [f["fact_id"] for f in all_facts]
            self.assertEqual(len(fact_ids), 12)
            self.assertEqual(len(set(fact_ids)), 12, "12 条 fact_id 应全唯一")

    def test_two_calls_produce_byte_equal_output(self):
        """`claude_jsonl_to_usage_facts` 必须字节决定（FNV-1a + 固定算法）——
        同输入两次调用输出逐字节相等。这是与 Rust 镜像 byte-parity 钉测的
        Python 端前置条件。"""
        import json
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            tmpd = Path(tmp)
            self._write_session(tmpd, "sid.jsonl", [
                {"type": "assistant",
                 "timestamp": "2026-09-02T03:00:00.000Z",
                 "message": {"id": "msg_byte", "model": "deepseek-v4-flash",
                             "usage": {"input_tokens": 100, "cache_read_input_tokens": 0,
                                       "cache_creation_input_tokens": 0, "output_tokens": 10}}},
            ])
            from agent_vitals.agent.claude_usage_fact import claude_jsonl_to_usage_facts
            r1 = claude_jsonl_to_usage_facts(
                tmpd / "sid.jsonl",
                machine_namespace="ns-byte", source_profile="default",
                native_session_id="sid")
            r2 = claude_jsonl_to_usage_facts(
                tmpd / "sid.jsonl",
                machine_namespace="ns-byte", source_profile="default",
                native_session_id="sid")
            self.assertEqual(
                json.dumps(r1.facts, sort_keys=True),
                json.dumps(r2.facts, sort_keys=True),
                "两次 emit 必须字节相等——FNV-1a hash 与字段映射决定性")
            self.assertEqual(r1.attempts, r2.attempts)
            self.assertEqual(r1.coverage, r2.coverage)

    def test_stage1c_derived_duplicate_claude_native_semantics(self):
        """Stage 1c Python-only 语义钉测（不需要 Rust 二进制）——覆盖
        `_stage1c_corpus` 的 9 个分支：fallback 后无 bad_id、重复 id 只留一个
        fact、uuid 原生、derived×2 唯一、Claude 原生模型不硬编码 provider、
        time_basis 与 identity_basis 解耦。Rust 镜像 byte-parity 由
        `ClaudeUsageFactsBothTests` 承担。"""
        import json
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            tmpd = Path(tmp)
            self._write_session(tmpd, "sid-1975m.jsonl", _stage1c_corpus())
            from agent_vitals.agent.claude_usage_fact import claude_jsonl_to_usage_facts
            result = claude_jsonl_to_usage_facts(
                tmpd / "sid-1975m.jsonl",
                machine_namespace="ns-test", source_profile="default",
                native_session_id="sid-1975m")
            self.assertEqual(result.coverage,
                             {"total_rows": 9, "fact_rows": 5, "skip_rows": 4})
            self.assertEqual(result.attempts,
                             {"skip": 1, "unreadable": 1, "unattributed": 1,
                              "duplicate": 1},
                             "bad_id 必须缺席：derived fallback 已覆盖无 id 行")
            facts = result.facts
            self.assertEqual(len(facts), 5)
            self.assertEqual(len(set(f["fact_id"] for f in facts)), 5)
            bases = [f["identity_basis"] for f in facts]
            self.assertEqual(bases.count("native"), 3)
            self.assertEqual(bases.count("derived-hash"), 2)
            for f in facts:
                if f["identity_basis"] == "derived-hash":
                    parts = f["source_event_id"].split(":")
                    self.assertEqual(len(parts), 3, "derived id = <sid>:<offset>:<hash>")
                    self.assertEqual(parts[0], "sid-1975m")
                    self.assertEqual(len(parts[2]), 16, "row hash = 16 hex")
            # Claude 原生模型（msg_full_1 / uuid_only_1）原样走 model_raw，不许
            # 硬编码 provider_id/model_id；time_basis 独立于 identity_basis。
            for f in facts:
                if f["model_raw"] == "claude-sonnet-5":
                    self.assertIsNone(f.get("provider_id"))
                    self.assertIsNone(f.get("model_id"))
                    self.assertEqual(f.get("time_basis"), "native")
                self.assertEqual(f.get("time_basis"), "native",
                                 "每行都有原生 ts → time_basis 恒 native（derived 也是）")
            cr = sum(f["cache_read_tokens"] for f in facts)
            self.assertEqual(cr, 1_500_000 + 20)


@unittest.skipUnless(_BIN, "未设 AGENT_VITALS_BIN，跳过双实现比对")
class ClaudeUsageFactsBothTests(unittest.TestCase):
    """Stage 1 commit 2b + Stage 1c：`claude-usage-facts` 双实现 byte-parity。

    Python `scan.py claude-usage-facts --json -` ↔ Rust 同子命令：同一份混合
    语料，stdout 逐字节相等。Stage 1c 后语料把 R1 验收契约的每个分支都扫进去：
    cost-state→skip / message.id 全形 native（**Claude 原生模型**）/ 同 id 重复
    →duplicate attempt / 顶层 uuid 原生 / 两个无 id→derived offset+hash（canonical
    row hash 跨语言一致是这条的目的）/ 无 model→unreadable / 坏 ts→unattributed /
    短键 native。`bad_id` 在 fallback 修好后必须缺席（合法 usage 行不再被当坏 id
    丢）。`attempts` 的 dict 插入序、`fact_id`（FNV-1a + `\x1f` 拼接）跨语言一致。

    Run: AGENT_VITALS_BIN=$PWD/target/release/agent-vitals python3 -m unittest
    tests.test_claude_usage_fact.ClaudeUsageFactsBothTests -v
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.fixture = self.tmp / "fixture"
        self.fixture.mkdir()
        self.session = self.fixture / "sid-1975m.jsonl"
        # Stage 1c 混合语料（9 行）——见模块级 `_stage1c_corpus` 的行注释。
        self.session.write_text(
            "".join(json.dumps(r) + "\n" for r in _stage1c_corpus()),
            encoding="utf-8")

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _run(self, cmd):
        env = dict(os.environ)
        env["HOME"] = str(self.fixture)
        env["USERPROFILE"] = str(self.fixture)
        env["PYTHONDONTWRITEBYTECODE"] = "1"  # 别让 CPython 在 fake HOME 写 .pyc 缓存
        env.pop("AGENT_VITALS_BIN", None)
        return subprocess.run(
            cmd, env=env, capture_output=True, text=True, cwd=str(self.fixture))

    def test_python_rust_json_stdout_byte_equal(self):
        """同一份混合语料：两侧 `--json -` stdout 逐字节相等 + 语义抽查。"""
        args = ["claude-usage-facts", str(self.session),
                "--machine-namespace", "ns-parity",
                "--source-profile", "default", "--json", "-"]
        py = self._run(PY_CMD + args)
        rs = self._run([_BIN] + args)
        self.assertEqual(py.returncode, 0, py.stderr)
        self.assertEqual(rs.returncode, 0, rs.stderr)
        self.assertEqual(
            py.stdout, rs.stdout,
            "claude-usage-facts --json stdout 不一致：\npy:\n%s\nrs:\n%s"
            % (py.stdout, rs.stdout))
        doc = json.loads(py.stdout)
        # 9 行：5 fact（行 2/4/5/6/9）+ 4 skip（cost-state/duplicate/unreadable/unattributed）
        self.assertEqual(doc["coverage"]["total_rows"], 9)
        self.assertEqual(doc["coverage"]["fact_rows"], 5)
        self.assertEqual(doc["coverage"]["skip_rows"], 4)
        self.assertEqual(doc["attempts"],
                         {"skip": 1, "unreadable": 1, "unattributed": 1, "duplicate": 1},
                         "bad_id 必须缺席：derived fallback 已覆盖无 id 行")
        facts = doc["facts"]
        self.assertEqual(len(facts), 5)
        ids = [f["fact_id"] for f in facts]
        self.assertEqual(len(set(ids)), 5, "5 条 fact_id 必须唯一")
        # identity 分层：native × 3（行2 message.id / 行4 uuid / 行9 message.id）
        # + derived-hash × 2（行5/6）——offset+hash fallback 不再走 bad_id。
        bases = [f["identity_basis"] for f in facts]
        self.assertEqual(bases.count("native"), 3)
        self.assertEqual(bases.count("derived-hash"), 2)
        # derived 行：source_event_id 带 byte offset + 16 hex canonical row hash
        # 前缀是本文件 stem 的 native sid。
        for f in facts:
            if f["identity_basis"] == "derived-hash":
                self.assertTrue(
                    f["source_event_id"].startswith("sid-1975m:"),
                    "derived source_event_id 应以 native sid 开头: %s"
                    % f["source_event_id"])
                self.assertEqual(
                    len(f["source_event_id"].split(":")), 3,
                    "derived id = <sid>:<byte_offset>:<16hex>")
        # Claude 原生模型（行2/4）：model_raw 原样、model_id/provider_id 不许硬编码。
        for f in facts:
            if f["model_raw"] == "claude-sonnet-5":
                self.assertIsNone(f.get("provider_id"),
                                  "claude 模型不得被硬编码成 deepseek-official")
                self.assertIsNone(f.get("model_id"))
                self.assertEqual(f.get("time_basis"), "native",
                                 "time_basis 独立于 identity_basis")
        # cache_read 合计 = 行2(1500K) + 行4(0) + 行5(0) + 行6(0) + 行9(20)。
        cr = sum(f["cache_read_tokens"] for f in facts)
        self.assertEqual(cr, 1_500_000 + 20)

    def test_missing_or_empty_machine_namespace_exits_2_and_writes_no_state(self):
        """R1 §9「调用方必传且非空」+ 只读诊断绝不隐式写 state。

        不带或传空 --machine-namespace 跑（Python 与 Rust 两侧）：exit 2，且 fixture
        目录里**不新增任何文件**——旧实现会读 takeover.machine_namespace()（可能
        bootstrap machine.json，一次 state 写），这是 Stage 1c 撤掉的隐式副作用。
        """
        snapshot = sorted(str(p.relative_to(self.fixture))
                          for p in self.fixture.rglob("*") if p.is_file())
        base = ["claude-usage-facts", str(self.session), "--json", "-"]
        for suffix in ([], ["--machine-namespace", ""]):
            py = self._run(PY_CMD + base + suffix)
            rs = self._run([_BIN] + base + suffix)
            self.assertEqual(py.returncode, 2, py.stderr)
            self.assertEqual(rs.returncode, 2, rs.stderr)
            self.assertEqual(py.stderr, rs.stderr)
            self.assertIn("--machine-namespace is required", py.stderr)
        after = sorted(str(p.relative_to(self.fixture))
                       for p in self.fixture.rglob("*") if p.is_file())
        self.assertEqual(after, snapshot,
                         "namespace 缺失或为空时不得写任何 state 文件（machine.json 等）")


if __name__ == "__main__":
    unittest.main(verbosity=2)
