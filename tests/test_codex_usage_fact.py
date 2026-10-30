#!/usr/bin/env python3
"""Stage 2：codex UsageFact emitter 的 §6 验收钉测（commit 2a 的 fixture + 测试层）。

`docs/VITALS_CORE_V0_7_STAGE_2_CODEX_ADAPTER.md` §6 的 11 条验收，这里按
acceptance # 逐条落测。emitter（`agent_vitals.agent.codex_usage_fact`）不是
第四套 wire-shape 解释——它驱动 codex fold 的共享观察者 `CodexFoldState`
（Stage 2 commit 1），只补 fold 不管的两件事：byte_offset（derived
source_event_id 的命名空间段）与 native_session_id 解析。所以本文件**不重测
fold**（那是 Rust cfg(test) + `test_cli_matrix.py both("codex-cost")` 的职责），
只测「emitter 对 fold 判别出口的正确响应」。

语料 = `fixtures/codex/usage-fact/`（builder self-check 已钉覆盖/attempts；本文件
是同一断言的 Python 直调 + byte-parity 侧）。2026-09-03 决策锁：event id 一律
`rollout_source_id(:path.stem) + byte_offset + fnv1a64(canonical_row)`——**stem
命名空间、不是逻辑 session**——byte_offset 只在单物理文件内唯一，按 session 命名
会把同逻辑 session 的两份续接 rollout（同 offset 同形）误并、少算一笔
（acceptance #8 就是这份回归的钉测）。

Python 直调测 `CodexUsageFactEmitterCase`；双实现 byte-parity 走 CLI
`CodexUsageFactsBothTests`（`--json -` 逐字节，含 fact_id / identity_basis /
attempts / coverage）。缺 `--machine-namespace` exit 2 且不写 state 镜像
claude-usage-facts 的 R1 §9 契约。

跑法：python3 -m unittest tests.test_codex_usage_fact -v
"""

import json
import os
import shutil
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

from agent_vitals.agent.codex_usage_fact import (  # noqa: E402
    codex_rollouts_to_usage_facts,
)

UF = ROOT / "fixtures" / "codex" / "usage-fact"
UF_LEGACY = UF / "legacy.jsonl"                 # 7 行，history_mode=legacy
UF_PAGINATED = UF / "paginated.jsonl"           # 7 行（含双影子 exec），paginated
CROSS_A = UF / "rollout-1a.jsonl"               # §6.8 异 stem 半族
CROSS_B = UF / "rollout-1b.jsonl"
LIVE = UF / "rollout-live.jsonl"                # §6.9 同 stem live/archive 半族
LIVE_ARCH = UF / "archive" / "rollout-live.jsonl"
COST_SOL = ROOT / "fixtures" / "codex" / "cost" / "rollout-sol.jsonl"  # 无 session_meta


def _single_consume(input_tokens, output_tokens, cached, cache_write, reasoning=0):
    """一段「session_meta + turn_context + 1 次 Consumed token_count」的最小语料
    ——acceptance #1/#2 的隔离件，不依赖 committed fixture 的行布局。"""
    total = {"input_tokens": input_tokens, "output_tokens": output_tokens,
             "cached_input_tokens": cached, "cache_write_input_tokens": cache_write,
             "reasoning_output_tokens": reasoning,
             "total_tokens": input_tokens + output_tokens + cached + cache_write}
    info = {"total_token_usage": total, "last_token_usage": total}
    return [
        {"timestamp": "2026-09-02T00:00:00.000Z", "type": "session_meta",
         "payload": {"session_id": "codex-usage-map-0901", "id": "codex-usage-map-0901",
                     "history_mode": "legacy", "cli_version": "0.146.0-alpha.3.1",
                     "cwd": "/Users/alice/repo"}},
        {"timestamp": "2026-09-02T00:00:01.000Z", "type": "turn_context",
         "payload": {"turn_id": "t1", "cwd": "/Users/alice/repo",
                     "workspace_roots": ["/Users/alice/repo"], "model": "gpt-5.6-sol",
                     "approval_policy": "on-request",
                     "sandbox_policy": "workspace-write"}},
        {"timestamp": "2026-09-02T00:00:02.000Z", "type": "event_msg",
         "payload": {"type": "token_count", "info": info}},
    ]


def _write(tmpd, name, rows):
    p = Path(tmpd) / name
    p.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
    return p


class CodexUsageFactEmitterCase(unittest.TestCase):
    """Python 端 emitter 直调——不依赖 Rust 二进制，覆盖 §6 acceptance #1-#9。"""

    def test_zstd_rollout_is_decompressed_before_emission(self):
        from unittest.mock import patch

        with tempfile.TemporaryDirectory() as tmp:
            rows = _single_consume(1000, 150, cached=400, cache_write=100, reasoning=30)
            text = "".join(json.dumps(row) + "\n" for row in rows)
            plain = Path(tmp) / "rollout-zstd.jsonl"
            compressed = Path(tmp) / "rollout-zstd.jsonl.zst"
            plain.write_bytes(text.encode("utf-8"))
            compressed.write_bytes(b"compressed fixture")

            with patch("agent_vitals.adapters.dsh._zstd", return_value=object()), \
                    patch("agent_vitals.adapters.dsh.decode_zstd_multi_frame",
                          return_value=text.encode("utf-8")):
                result = codex_rollouts_to_usage_facts(
                    [plain, compressed], machine_namespace="ns-zstd", source_profile="default")

            self.assertEqual(result.malformed, 0)
            self.assertEqual(result.coverage["fact_rows"], 1)
            self.assertEqual(result.attempts.get("duplicate"), 1)
            self.assertTrue(result.facts[0]["source_event_id"].startswith("rollout-zstd:"))

    def test_bucket_mapping_and_reasoning_merge(self):
        """acceptance #1 + #2a：5→4 桶映射 + reasoning ⊆ output 不叠加。

        `_consumed_to_usage_fact` 吃 fold 的 5 桶
        `(uncached, output, cached, cache_write, reasoning)`：uncached → input、
        cached → cache_read、cache_write → cache_write、output → output。fact.
        output = codex output（reasoning **不**再叠加——output 已含 reasoning，
        叠加即双计，决策 A）。input 1000 / cached 400 / cache_write 100 / output
        150 / reasoning 30 → uncached 必须是 1000−400−100 = **500**（derived，
        不是读到的 input 原值），output 必须是 **150**（不是 150+30=180）。"""
        with tempfile.TemporaryDirectory() as tmp:
            p = _write(tmp, "map.jsonl", _single_consume(
                1000, 150, cached=400, cache_write=100, reasoning=30))
            r = codex_rollouts_to_usage_facts([p], machine_namespace="ns-map",
                                              source_profile="default")
            self.assertEqual(r.coverage,
                             {"total_token_count_events": 1, "fact_rows": 1,
                              "skip_rows": 0})
            self.assertEqual(r.attempts,
                             {"skip": 0, "unreadable": 0, "unattributed": 0})
            f = r.facts[0]
            self.assertEqual(f["uncached_input_tokens"], 500,
                             "uncached = input − cached − cache_write（derived）")
            self.assertEqual(f["cache_read_tokens"], 400)
            self.assertEqual(f["cache_write_tokens"], 100)
            self.assertEqual(f["output_tokens"], 150,
                             "reasoning ⊆ output，绝不叠加 facts[4]")
            self.assertNotIn("reasoning", f)
            self.assertEqual(f["source_usage_semantics"], "delta",
                             "发的是 last_token_usage per-request 增量")
            self.assertEqual(f["harness"], "codex")
            self.assertEqual(f["observation_kind"], "assistant-usage")
            self.assertEqual(f["identity_basis"], "derived-hash",
                             "token_count 无原生 id → 恒 derived-hash（§3.3）")
            self.assertEqual(f["time_basis"], "native", "有原生 ts")
            self.assertEqual(f["event_ts_utc"], "2026-09-02T00:00:02.000Z")
            self.assertEqual(f["native_session_id"], "codex-usage-map-0901")
            self.assertEqual(f["model_raw"], "gpt-5.6-sol")
            self.assertTrue(f["source_event_id"].startswith("map:"),
                            f["source_event_id"])
            self.assertTrue(f["fact_id"].startswith("uf1-"), f["fact_id"])

    def test_session_route_evidence_overrides_current_hint(self):
        """Explicit session route wins over any diagnostic current-route hint."""
        with tempfile.TemporaryDirectory() as tmp:
            rows = _single_consume(1000, 150, cached=400, cache_write=100, reasoning=30)
            rows[0]["payload"]["model_provider"] = "custom"
            rows[0]["payload"]["route"] = {
                "provider_id": "cogfoundry.ai",
                "endpoint_host": "router.cogfoundry.ai",
            }
            p = _write(tmp, "route.jsonl", rows)
            r = codex_rollouts_to_usage_facts(
                [p], machine_namespace="ns-route", source_profile="default",
                route_endpoint_host="router.other.example",
                route_evidence_basis="config-current",
            )
            self.assertEqual(r.facts[0]["provider_id"], "cogfoundry.ai")
            self.assertEqual(r.facts[0]["evidence_basis"], "session-native")

    def test_route_changed_reassigns_later_token_facts(self):
        with tempfile.TemporaryDirectory() as tmp:
            rows = _single_consume(100, 10, cached=0, cache_write=0)
            rows[0]["payload"].update({
                "model_provider": "custom",
                "route": {"provider_id": "cogfoundry.ai",
                          "endpoint_host": "router.cogfoundry.ai"},
            })
            rows.append({"type": "event_msg", "payload": {
                "type": "route_changed", "provider_raw": "custom",
                "provider_id": "openai", "endpoint_host": "api.openai.com"}})
            rows.append({"type": "event_msg", "payload": {
                "type": "token_count", "timestamp": "2026-09-02T00:01:00.000Z",
                "info": {"total_token_usage": {"total_tokens": 220},
                         "last_token_usage": {"input_tokens": 100, "output_tokens": 10}}}})
            p = _write(tmp, "route-switch.jsonl", rows)
            r = codex_rollouts_to_usage_facts([p], machine_namespace="ns-switch",
                                              source_profile="default")
            self.assertEqual(len(r.facts), 2)
            self.assertEqual(r.facts[0]["provider_id"], "cogfoundry.ai")
            self.assertEqual(r.facts[1]["provider_id"], "openai")
            self.assertNotEqual(r.facts[0]["route_evidence_id"],
                                r.facts[1]["route_evidence_id"])

    def test_conflicting_session_route_is_marked_conflict(self):
        with tempfile.TemporaryDirectory() as tmp:
            rows = _single_consume(100, 10, cached=0, cache_write=0)
            rows[0]["payload"].update({
                "model_provider": "openai",
                "route": {"provider_id": "openai",
                          "endpoint_host": "router.cogfoundry.ai"},
            })
            p = _write(tmp, "route-conflict.jsonl", rows)
            r = codex_rollouts_to_usage_facts([p], machine_namespace="ns-conflict",
                                              source_profile="default")
            self.assertEqual(r.facts[0]["evidence_basis"], "conflict")
            self.assertEqual(r.facts[0]["billing_mode"], "metered")
            self.assertEqual(r.facts[0]["pricing_basis"], "metered_estimate")

    def test_similar_cogfoundry_domain_is_not_normalized(self):
        with tempfile.TemporaryDirectory() as tmp:
            rows = _single_consume(100, 10, cached=0, cache_write=0)
            rows[0]["payload"].update({
                "model_provider": "custom",
                "route": {"provider_id": "custom",
                          "endpoint_host": "cogfoundry.ai.example.com"},
            })
            p = _write(tmp, "similar-domain.jsonl", rows)
            r = codex_rollouts_to_usage_facts([p], machine_namespace="ns-domain",
                                              source_profile="default")
            self.assertEqual(r.facts[0]["provider_id"], "custom")
            self.assertNotEqual(r.facts[0]["provider_id"], "cogfoundry.ai")
            self.assertEqual(r.facts[0]["pricing_basis"], "metered_estimate")
            self.assertEqual(r.facts[0]["evidence_basis"], "session-native")

    def test_unknown_provider_without_route_is_metered_estimate(self):
        with tempfile.TemporaryDirectory() as tmp:
            rows = _single_consume(100, 10, cached=0, cache_write=0)
            rows[0]["payload"]["model_provider"] = "anthropic"
            p = _write(tmp, "unknown-provider.jsonl", rows)
            r = codex_rollouts_to_usage_facts([p], machine_namespace="ns-unknown",
                                              source_profile="default")
            self.assertEqual(r.facts[0]["provider_id"], "anthropic")
            self.assertEqual(r.facts[0]["pricing_basis"], "metered_estimate")
            self.assertEqual(r.facts[0]["evidence_basis"], "missing")

    def test_provider_only_openai_route_is_not_subscription(self):
        with tempfile.TemporaryDirectory() as tmp:
            rows = _single_consume(100, 10, cached=0, cache_write=0)
            rows[0]["payload"].update({
                "model_provider": "openai",
                "route": {"provider_id": "openai"},
            })
            p = _write(tmp, "provider-only.jsonl", rows)
            r = codex_rollouts_to_usage_facts([p], machine_namespace="ns-provider-only",
                                              source_profile="default")
            self.assertEqual(r.facts[0]["billing_mode"], "metered")
            self.assertEqual(r.facts[0]["pricing_basis"], "metered_estimate")

    def test_known_provider_with_unknown_endpoint_is_conflict(self):
        with tempfile.TemporaryDirectory() as tmp:
            rows = _single_consume(100, 10, cached=0, cache_write=0)
            rows[0]["payload"].update({
                "model_provider": "openai",
                "route": {"provider_id": "openai",
                          "endpoint_host": "evil.example.com"},
            })
            p = _write(tmp, "unknown-endpoint.jsonl", rows)
            r = codex_rollouts_to_usage_facts([p], machine_namespace="ns-evil",
                                              source_profile="default")
            self.assertEqual(r.facts[0]["evidence_basis"], "conflict")
            self.assertEqual(r.facts[0]["billing_mode"], "metered")
            self.assertEqual(r.facts[0]["pricing_basis"], "metered_estimate")

    def test_official_endpoint_trailing_dot_remains_session_native(self):
        with tempfile.TemporaryDirectory() as tmp:
            rows = _single_consume(100, 10, cached=0, cache_write=0)
            rows[0]["payload"].update({
                "model_provider": "openai",
                "route": {"provider_id": "openai",
                          "endpoint_host": "api.openai.com."},
            })
            p = _write(tmp, "openai-dot.jsonl", rows)
            r = codex_rollouts_to_usage_facts([p], machine_namespace="ns-dot",
                                              source_profile="default")
            self.assertEqual(r.facts[0]["evidence_basis"], "session-native")
            self.assertEqual(r.facts[0]["pricing_basis"], "session-provider")

    def test_reasoning_gt_output_is_unreadable(self):
        """acceptance #2b：reasoning > output 是自相矛盾的事件 → unreadable，不
        emit（镜像 codex fold 的 `token_count_invalid_last_usage` 哨兵）。"""
        with tempfile.TemporaryDirectory() as tmp:
            p = _write(tmp, "bad.jsonl", _single_consume(
                1000, 10, cached=0, cache_write=0, reasoning=30))
            r = codex_rollouts_to_usage_facts([p], machine_namespace="ns-map",
                                              source_profile="default")
            self.assertEqual(r.coverage,
                             {"total_token_count_events": 1, "fact_rows": 0,
                              "skip_rows": 1})
            self.assertEqual(r.attempts,
                             {"skip": 0, "unreadable": 1, "unattributed": 0})
            self.assertEqual(r.facts, [])

    def test_legacy_fixture_emits(self):
        """acceptance #3：Legacy 输入 emit。committed `usage-fact/legacy.jsonl`
        7 行 = session_meta + Unattributed + turn_context + Consumed#1 + Repeat +
        Consumed#2 + Unreadable → 2 fact + unreadable:1 + unattributed:1
        （builder self-check 的同一组数，这里钉 emitter 端到端 + 桶值）。
        复读（Repeat）不 emit 也不计 total_token_count_events——跨文件语义验证
        acceptance #3 前先确认每次非-Repeat token_count 才算 total。"""
        r = codex_rollouts_to_usage_facts([UF_LEGACY], machine_namespace="ns-parity",
                                          source_profile="default")
        self.assertEqual(r.coverage,
                         {"total_token_count_events": 4, "fact_rows": 2,
                          "skip_rows": 2})
        self.assertEqual(r.attempts,
                         {"skip": 0, "unreadable": 1, "unattributed": 1})
        self.assertEqual(r.malformed, 0)
        self.assertEqual(len(r.facts), 2)
        f1, f2 = r.facts
        # Consumed#1：input1000/cached400/cw100/output150/reasoning30
        self.assertEqual(f1["uncached_input_tokens"], 500)
        self.assertEqual(f1["cache_read_tokens"], 400)
        self.assertEqual(f1["cache_write_tokens"], 100)
        self.assertEqual(f1["output_tokens"], 150)
        self.assertEqual(f1["model_raw"], "gpt-5.6-sol")
        self.assertEqual(f1["native_session_id"], "codex-usage-legacy-0001")
        self.assertEqual(f1["event_ts_utc"], "2026-09-02T00:00:02.000Z")
        # Consumed#2：input2500/cached900/cw100/output400/reasoning50
        self.assertEqual(f2["uncached_input_tokens"], 1500)
        self.assertEqual(f2["cache_read_tokens"], 900)
        self.assertEqual(f2["cache_write_tokens"], 100)
        self.assertEqual(f2["output_tokens"], 400)
        self.assertEqual(f2["event_ts_utc"], "2026-09-02T00:00:04.000Z")
        # 两条都是 derived id：<stem>:<byte_offset>:<16hex>，stem 前缀正确。
        for f in (f1, f2):
            parts = f["source_event_id"].split(":")
            self.assertEqual(len(parts), 3)
            self.assertEqual(parts[0], "legacy", "stem 命名空间 = path.stem")
            self.assertEqual(len(parts[2]), 16, "row hash = FNV-1a 64 hex")
            self.assertTrue(parts[1].isdigit())
            self.assertEqual(len(set(x["fact_id"] for x in r.facts)), 2)

    def test_paginated_fixture_emits(self):
        """acceptance #4：Paginated 输入 emit。与 legacy 是**同一份规则**在
        paginated 词表上的输出——emitter 绝不按 history_mode 分支（§5）。"""
        r = codex_rollouts_to_usage_facts([UF_PAGINATED], machine_namespace="ns-parity",
                                          source_profile="default")
        self.assertEqual(r.coverage,
                         {"total_token_count_events": 2, "fact_rows": 1,
                          "skip_rows": 1})
        self.assertEqual(r.attempts,
                         {"skip": 0, "unreadable": 1, "unattributed": 0})
        self.assertEqual(len(r.facts), 1)
        f = r.facts[0]
        self.assertEqual(f["uncached_input_tokens"], 1200)  # 2000−600−200
        self.assertEqual(f["cache_read_tokens"], 600)
        self.assertEqual(f["cache_write_tokens"], 200)
        self.assertEqual(f["output_tokens"], 200)
        self.assertEqual(f["model_raw"], "gpt-5.6-pro")
        self.assertEqual(f["native_session_id"], "codex-usage-paginated-0002")
        self.assertTrue(f["source_event_id"].startswith("paginated:"))

    def test_shadow_execs_zero_facts(self):
        """acceptance #5：双影子 exec（CommandExecution + custom_tool_call）产 0
        fact——fact 集**只**由 token_count 驱动（行为层 SV611 影子跳过的 token
        层镜像）。fixture 里嵌了那对影子；断言文件确实含它们，且它们既不进
        fact_rows 也不进 total_token_count_events。"""
        raw = UF_PAGINATED.read_text(encoding="utf-8").splitlines()
        kinds = [json.loads(line)["payload"].get("item", {}).get("type")
                 for line in raw if '"item_completed"' in line]
        self.assertIn("CommandExecution", kinds, "fixture 必须真含 CommandExecution 影子")
        self.assertTrue(any("custom_tool_call" in line for line in raw),
                        "fixture 必须真含 custom_tool_call 影子（§6.5 的 fixture 前提）")
        r = codex_rollouts_to_usage_facts([UF_PAGINATED], machine_namespace="ns-parity",
                                          source_profile="default")
        self.assertEqual(r.coverage["total_token_count_events"], 2,
                         "total 只数 token_count（影子 exec 零参与）")
        self.assertEqual(r.coverage["fact_rows"], 1,
                         "影子 exec 不得产出任何 fact——fact 集只由 token_count 驱动")
        self.assertEqual(len(r.facts), 1)

    def test_same_stem_live_archive_one_fact_plus_duplicate(self):
        """acceptance #6 + #9：同一物理 rollout（同 stem = `rollout-live`）以 live
        与 archived 两路 byte-identical 复本进入同一次发射 → 同 `source_event_id`
        → duplicate attempt、保留一条 fact；单文件发射的 fact 与 pair 保留的 fact
        **逐字段全等**（fact_id 一致）。异 stem 语义见下一条。"""
        single_live = codex_rollouts_to_usage_facts(
            [LIVE], machine_namespace="ns-parity", source_profile="default")
        single_arch = codex_rollouts_to_usage_facts(
            [LIVE_ARCH], machine_namespace="ns-parity", source_profile="default")
        pair = codex_rollouts_to_usage_facts(
            [LIVE, LIVE_ARCH], machine_namespace="ns-parity", source_profile="default")
        self.assertEqual(single_live.coverage["fact_rows"], 1)
        self.assertEqual(single_arch.coverage["fact_rows"], 1)
        # 单文件发射各自 1 fact，fact_id 一致（byte-identical → 同 canonical）。
        self.assertEqual(single_live.facts[0]["fact_id"], single_arch.facts[0]["fact_id"])
        # pair：同 emission 内第二次见到同 source_event_id → duplicate。
        self.assertEqual(pair.coverage,
                         {"total_token_count_events": 2, "fact_rows": 1,
                          "skip_rows": 1})
        self.assertEqual(pair.attempts,
                         {"skip": 0, "unreadable": 0, "unattributed": 0,
                          "duplicate": 1})
        self.assertEqual(pair.facts, single_live.facts,
                         "pair 保留的 fact 必须与单文件发射全等（fact_id 稳定）")
        f = pair.facts[0]
        self.assertEqual(f["native_session_id"], "codex-usage-live-0005")
        self.assertTrue(f["source_event_id"].startswith("rollout-live:"))

    def test_cross_stem_same_content_two_facts(self):
        """acceptance #8（2026-09-03 用户验收 #1）：同逻辑 session、**异 rollout
        stem**、同 offset、整行 byte-identical → 两条 fact、绝不误并。

        `rollout-1a`/`rollout-1b` 的 session_meta 同 session_id、token_count 同
        offset 489 同 canonical —— 若 event id 按逻辑 session 命名会撞成 duplicate、
        少算一笔；决策锁把命名空间换成 path.stem 后两条 `source_event_id` 只差
        stem 前缀。这条就是那次修订的钉测。"""
        r = codex_rollouts_to_usage_facts([CROSS_A, CROSS_B], machine_namespace="ns-parity",
                                          source_profile="default")
        self.assertEqual(r.coverage,
                         {"total_token_count_events": 2, "fact_rows": 2,
                          "skip_rows": 0})
        self.assertEqual(r.attempts,
                         {"skip": 0, "unreadable": 0, "unattributed": 0},
                         "异 stem 永不 duplicate")
        self.assertEqual(len(r.facts), 2)
        fa, fb = r.facts
        self.assertEqual(fa["native_session_id"], "codex-usage-cross-0004")
        self.assertEqual(fb["native_session_id"], "codex-usage-cross-0004",
                         "逻辑 session 相同——差异只在 stem")
        # 除 stem 前缀外两 id 全等（同 offset、同 canonical row hash）。
        ea, eb = fa["source_event_id"], fb["source_event_id"]
        self.assertEqual(ea.split(":")[1:], eb.split(":")[1:],
                         "同 offset 同 JSON → hash 段相同")
        self.assertNotEqual(ea.split(":")[0], eb.split(":")[0])
        self.assertEqual(ea.split(":")[0], "rollout-1a")
        self.assertEqual(eb.split(":")[0], "rollout-1b")
        # 桶值两边全等（byte-identical 内容）：uncached550/cr200/cw50/out80。
        for f in (fa, fb):
            self.assertEqual(f["uncached_input_tokens"], 550)  # 800−200−50
            self.assertEqual(f["cache_read_tokens"], 200)
            self.assertEqual(f["cache_write_tokens"], 50)
            self.assertEqual(f["output_tokens"], 80)
        self.assertEqual(len(set(f["fact_id"] for f in r.facts)), 2,
                         "两条 fact_id 必须唯一")

    def test_fact_ids_stable_across_rescans(self):
        """acceptance #7：同一物理 rollout 文件**重扫两遍** → 同一批 fact_id
        （source_event_id 确定性派生；writer 侧据此精确去重）。FNV-1a + canonical
        row 都必须决定，跨次发射不能漂。"""
        a = codex_rollouts_to_usage_facts([UF_LEGACY], machine_namespace="ns-parity",
                                          source_profile="default")
        b = codex_rollouts_to_usage_facts([UF_LEGACY], machine_namespace="ns-parity",
                                          source_profile="default")
        self.assertEqual([f["fact_id"] for f in a.facts],
                         [f["fact_id"] for f in b.facts])
        self.assertEqual([f["source_event_id"] for f in a.facts],
                         [f["source_event_id"] for f in b.facts])
        # 跨不同 machine_namespace 也必须稳定同一 physical source（fact_id 的
        # identity 段在 machine_namespace 之上——命名空间只该改前缀不改 source）。
        c = codex_rollouts_to_usage_facts([UF_LEGACY], machine_namespace="ns-other",
                                          source_profile="default")
        self.assertEqual([f["source_event_id"] for f in a.facts],
                         [f["source_event_id"] for f in c.facts],
                         "source_event_id 是物理行身份，不得随 machine_namespace 变")

    def test_no_session_meta_stem_fallback(self):
        """纯 fold cost fixture（无 session_meta）→ `native_session_id` = path.stem
        （§3.4 兜底，§8「纯 fold cost fixture 无需加字段即可 emit」）。`rollout-sol`
        自成一会话——诚实「不假装知道逻辑归属」。首行 token_count 在首 turn_context
        前 → Unattributed（fold 残差如实上浮）。"""
        r = codex_rollouts_to_usage_facts([COST_SOL], machine_namespace="ns-parity",
                                          source_profile="default")
        self.assertEqual(r.malformed, 0)
        self.assertEqual(r.coverage["fact_rows"], 2)
        self.assertEqual(r.coverage["total_token_count_events"], 5)
        self.assertEqual(r.attempts["unattributed"], 1, "行1 在 turn_context 前 → 如实报")
        for f in r.facts:
            self.assertEqual(f["native_session_id"], "rollout-sol", "stem 兜底")
            self.assertTrue(f["source_event_id"].startswith("rollout-sol:"))
            self.assertEqual(f["time_basis"], "native")

    def test_multi_path_mixed_stems_no_cross_merge(self):
        """acceptance #11（Python 端前置）：`paths` 接受 3 个 rollout——跨 stem 的
        fact 集直接并进一个结果，异 stem 各自保留、绝不因跨文件同 offset 相撞。
        1a/1b（各 1 fact）+ legacy（2 fact）= 4 fact；attempts 是各文件之和
        （legacy 的 unreadable:1 + unattributed:1）。"""
        r = codex_rollouts_to_usage_facts(
            [CROSS_A, CROSS_B, UF_LEGACY], machine_namespace="ns-parity",
            source_profile="default")
        self.assertEqual(r.coverage["fact_rows"], 4)
        self.assertEqual(r.coverage["total_token_count_events"], 1 + 1 + 4)
        self.assertEqual(r.attempts,
                         {"skip": 0, "unreadable": 1, "unattributed": 1},
                         "无 duplicate：1a/1b/legacy 三 stem 互不相撞")
        self.assertEqual(len(set(f["fact_id"] for f in r.facts)), 4)


@unittest.skipUnless(_BIN, "未设 AGENT_VITALS_BIN，跳过双实现比对")
class CodexUsageFactsBothTests(unittest.TestCase):
    """acceptance #10 + #11 的 byte-parity 侧：`codex-usage-facts --json -` 的
    Python `scan.py` ↔ Rust 二进制 stdout **逐字节相等**（含 fact_id /
    identity_basis=derived-hash / attempts / coverage / malformed 键）。

    五份语料扫进决策锁的每个分支：Legacy emit / Paginated emit（含双影子）/
    跨 stem 同形双路径（§6.8）/ 同 stem live+archive 双路径（§6.9，duplicate）/
    无 session_meta 的 stem 兜底。多 rollout 路径在同一调用里传（§6.11）——
    单文件入口覆盖不到的跨文件语义只有多路径 byte-parity 能钉。

    Run: AGENT_VITALS_BIN=$PWD/target/release/agent-vitals python3 -m unittest
    tests.test_codex_usage_fact.CodexUsageFactsBothTests -v
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.home = self.tmp / "home"
        self.home.mkdir()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _run(self, cmd, args):
        env = dict(os.environ)
        env["HOME"] = str(self.home)
        env["USERPROFILE"] = str(self.home)
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        env.pop("AGENT_VITALS_BIN", None)
        return subprocess.run(
            cmd + ["codex-usage-facts"] + args,
            env=env, capture_output=True, text=True, cwd=str(self.home))

    def _assert_byte_equal(self, args):
        py = self._run(PY_CMD, args)
        rs = self._run([_BIN], args)
        self.assertEqual(py.returncode, 0, py.stderr)
        self.assertEqual(rs.returncode, 0, rs.stderr)
        self.assertEqual(
            py.stdout, rs.stdout,
            "codex-usage-facts --json stdout 不一致：\npy:\n%s\nrs:\n%s"
            % (py.stdout, rs.stdout))
        return json.loads(py.stdout)

    def test_python_rust_json_stdout_byte_equal_five_corpora(self):
        """acceptance #10：同一语料两侧 --json stdout 逐字节相等。五份语料循环
        扫（多路径的两份同时覆盖 acceptance #11 的多 rollout 接受）。"""
        corpora = [
            ("legacy", [str(UF_LEGACY)],
             {"total_token_count_events": 4, "fact_rows": 2, "skip_rows": 2},
             {"skip": 0, "unreadable": 1, "unattributed": 1}),
            ("paginated", [str(UF_PAGINATED)],
             {"total_token_count_events": 2, "fact_rows": 1, "skip_rows": 1},
             {"skip": 0, "unreadable": 1, "unattributed": 0}),
            ("cross", [str(CROSS_A), str(CROSS_B)],
             {"total_token_count_events": 2, "fact_rows": 2, "skip_rows": 0},
             {"skip": 0, "unreadable": 0, "unattributed": 0}),
            ("live-archive", [str(LIVE), str(LIVE_ARCH)],
             {"total_token_count_events": 2, "fact_rows": 1, "skip_rows": 1},
             {"skip": 0, "unreadable": 0, "unattributed": 0, "duplicate": 1}),
            ("stem-fallback", [str(COST_SOL)],
             {"total_token_count_events": 5, "fact_rows": 2, "skip_rows": 3},
             {"skip": 1, "unreadable": 1, "unattributed": 1}),
        ]
        for label, args, cov, att in corpora:
            doc = self._assert_byte_equal(args + ["--machine-namespace", "ns-parity",
                                                  "--source-profile", "default",
                                                  "--json", "-"])
            self.assertEqual(doc["coverage"], cov, label)
            self.assertEqual(doc["attempts"], att, label)
            self.assertEqual(doc["malformed"], 0, label)
            self.assertEqual(len(doc["facts"]), cov["fact_rows"], label)
            # identity_basis 恒 derived-hash（决策锁；不存在 codex native 态）。
            for f in doc["facts"]:
                self.assertEqual(f["identity_basis"], "derived-hash", label)
                self.assertEqual(f["observation_kind"], "assistant-usage", label)
                parts = f["source_event_id"].split(":")
                self.assertEqual(len(parts), 3, label)
                self.assertEqual(len(parts[2]), 16, label)
            ids = [f["fact_id"] for f in doc["facts"]]
            self.assertEqual(len(set(ids)), len(ids),
                             "%s: fact_id 必须全唯一" % label)
            # cross/stem-fallback 断言逻辑 sid / stem 兜底各就各位。
            if label == "cross":
                sids = {f["native_session_id"] for f in doc["facts"]}
                self.assertEqual(sids, {"codex-usage-cross-0004"})
                stems = {f["source_event_id"].split(":")[0] for f in doc["facts"]}
                self.assertEqual(stems, {"rollout-1a", "rollout-1b"})
            if label == "stem-fallback":
                for f in doc["facts"]:
                    self.assertEqual(f["native_session_id"], "rollout-sol")
                    self.assertEqual(f["model_raw"], "gpt-5.6-sol")

    def test_multi_rollout_three_paths_byte_equal(self):
        """acceptance #11：三个 rollout 路径一次调用（1a/1b/legacy = 3 stem），
        两侧 stdout 逐字节一致；跨 stem fact 直接并入一个结果、异 stem 无
        duplicate。多路径语义是 acceptance #8/#9 能在 CLI 层成立的前提。"""
        doc = self._assert_byte_equal([str(CROSS_A), str(CROSS_B), str(UF_LEGACY),
                                       "--machine-namespace", "ns-parity",
                                       "--source-profile", "default", "--json", "-"])
        self.assertEqual(doc["coverage"]["fact_rows"], 4)
        self.assertEqual(doc["coverage"]["total_token_count_events"], 1 + 1 + 4)
        self.assertEqual(doc["attempts"],
                         {"skip": 0, "unreadable": 1, "unattributed": 1})
        self.assertEqual(len(set(f["fact_id"] for f in doc["facts"])), 4)

    def test_missing_or_empty_machine_namespace_exits_2_and_writes_no_state(self):
        """R1 §9「调用方必传且非空」+ 只读诊断绝不隐式写 state——镜像
        claude-usage-facts 的同一契约。codex-usage-facts 也绝不让 CLI 读
        takeover 身份补齐（那是一次隐式 machine.json state 写）。"""
        snapshot = sorted(str(p.relative_to(self.home))
                          for p in self.home.rglob("*") if p.is_file())
        env = dict(os.environ)
        env["HOME"] = str(self.home)
        env["USERPROFILE"] = str(self.home)
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        env.pop("AGENT_VITALS_BIN", None)
        base = ["codex-usage-facts", str(UF_LEGACY), "--json", "-"]
        for suffix in ([], ["--machine-namespace", ""]):
            py = subprocess.run(PY_CMD + base + suffix, env=env, capture_output=True,
                                text=True, cwd=str(self.home))
            rs = subprocess.run([_BIN] + base + suffix, env=env, capture_output=True,
                                text=True, cwd=str(self.home))
            self.assertEqual(py.returncode, 2, py.stderr)
            self.assertEqual(rs.returncode, 2, rs.stderr)
            self.assertEqual(py.stderr, rs.stderr)
            self.assertIn("--machine-namespace is required", py.stderr)
        after = sorted(str(p.relative_to(self.home))
                       for p in self.home.rglob("*") if p.is_file())
        self.assertEqual(after, snapshot,
                         "namespace 缺失或为空时不得写任何 state 文件")

    def test_nonexistent_rollout_exits_2(self):
        """I/O 错误（不可读 rollout）向上抛 → CLI exit 2（镜像 claude-usage-facts
        的 OSError 路径；degraded 内容不 abort、I/O 缺失要 abort）。"""
        for cmd in (PY_CMD, [_BIN]):
            p = self._run(cmd, [str(self.home / "no-such.jsonl"),
                                "--machine-namespace", "ns-parity",
                                "--source-profile", "default", "--json", "-"])
            self.assertEqual(p.returncode, 2, cmd)


if __name__ == "__main__":
    unittest.main(verbosity=2)
