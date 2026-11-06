#!/usr/bin/env python3
"""v0.7 Stage 3 commit 2：DSH UsageFact emitter 的 §6 验收钉测（acceptance #1-#9）。

`docs/VITALS_CORE_V0_7_STAGE_3_DSH_ADAPTER.md`（v4 spec）§6 的 9 条验收，这里按
acceptance # 逐条落测。emitter（`agent_vitals.agent.dsh_usage_fact`）不是第四套
wire-shape 解释——它复用 `adapters/dsh.py` 读/解码 + `parse_session_log` reshape +
`r2a.dsh_header`/`dsh_source_profile` 身份 + Commit 1 的共享 observer
（`usage.dsh_usage_observations`，**开槽即固化** source_event_id/identity_basis/
first_sample_seq）+ `usage_fold_checkpoint` 残差 + `usage_fact.build_usage_fact`
契约，一行新解释都不写。所以本文件**不重测 observer**（那是 Commit 1 的
`tests/test_characterization.py` observer 表征 + Rust `usage.rs` cfg(test) 的职责），
只测「emitter 对共享 observer 判别出口的正确响应」：逐相邻槽一 fact、身份固化字段
原样透出、strict 硬错误（§4.1）在文件层、duplicate 守卫在出账前、coverage 诚实。

验收 #10（Commit 1 零漂移门）在 commit 1 内验证过，本文件不重复。fixture 复用
`fixtures/dsh/`（behavior.jsonl / resume.jsonl / session.jsonl.zstd）；append-shadow、
provider-switch、无 cwd / 无 id、clean-empty、无 id compaction 等靠本文件的小构造
helper 在 temp 会话里现搭，**不改动任何已提交 fixture 产物**。

结构镜像 `tests/test_codex_usage_fact.py`：`DshUsageFactEmitterCase`（Python 直调，
不依赖 Rust 二进制，覆盖 #1-#8 全 + #9 的纯函数半侧）；`DshUsageFactsBothTests`
（`--json -` 双实现 stdout 逐字节相等 + exit-2 错误族，覆盖 #9 的 CLI 半侧）。
多帧 zstd 的 Python 侧解码需要可选的 `zstandard` 包——缺它时 Python 侧诚实报
unsupported-compression、无法与 Rust 对账，故 zstd 相关用例整体 skip（镜像
`tests/test_r2a.py` 的 `_HAVE_ZSTD` 惯例）。

跑法：
    python3 -m unittest tests.test_dsh_usage_fact -v
    AGENT_VITALS_BIN=$PWD/target/release/agent-vitals python3 -m unittest \
        tests.test_dsh_usage_fact.DshUsageFactsBothTests -v
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

from agent_vitals.adapters.dsh import parse_session_log  # noqa: E402
from agent_vitals.agent.dsh_usage_fact import (  # noqa: E402
    DshUsageFactError,
    dsh_session_to_usage_facts,
)
from agent_vitals.adapters.dsh_source_profile import dsh_source_profile  # noqa: E402  (PR #4.5: 抽离自 agent/r2a.py)
from agent_vitals.agent.usage import request_metrics, token_by_model  # noqa: E402
from agent_vitals.source_identity import canonical_json, fnv1a64_hex  # noqa: E402

# 多帧 zstd 解码需要可选的 zstandard（repo 本身零第三方；装了它才跑 zstd 用例）。
try:
    import zstandard  # noqa: F401
    _HAVE_ZSTD = True
except ImportError:  # pragma: no cover - 环境相关
    _HAVE_ZSTD = False

DSH = ROOT / "fixtures" / "dsh"
BEHAVIOR = DSH / "behavior.jsonl"      # slot (9,1)=chunk130+message131、(10,1)、(11,1)
RESUME = DSH / "resume.jsonl"          # slot (1,1)=(2,1)、compaction cmp-1、(3,1) 双 chunk、seq15 残差
ZSTD = DSH / "session.jsonl.zstd"      # 3 帧，解码 == behavior.jsonl 内容

NS = "ns-parity"


# ────────────────────────────────────────────────────────────────────────
# 小构造 helpers（§6 #2/#5b/#5c/#6b/#6c/#8 的 temp 会话；不动 committed fixture）
# ────────────────────────────────────────────────────────────────────────

def _write(tmpd, name, rows):
    p = Path(tmpd) / name
    p.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
    return p


def _hdr(id_="sess-temp-0001", cwd="/tmp/x"):
    return {"type": "session", "version": 0, "id": id_,
            "createdAt": 1750000000000, "cwd": cwd}


def _comp(seq, time_ms, data):
    return {"type": "compaction/summary", "seq": seq, "time": time_ms, "data": data}


def _chunk(seq, time_ms, turn, step, usage):
    return {"type": "assistant/chunk", "seq": seq, "time": time_ms,
            "data": {"turn": turn, "step": step,
                     "chunk": {"type": "usage", "usage": usage}}}


# 时间锚（epoch ms → RFC3339-ms-Z；resume/behavior 同族，2025-06-15）
T0 = 1750000000000  # 2025-06-15T15:06:40.000Z


# 复算 helper（§6 #5 / #9 的身份 canonical-hash battery——与 observer 共用
# `source_identity` 共享层，验证「身份输入可从字段重组、非复算不可知」）。
def _derived_request_id(turn, step, seq=None):
    """普通槽 source_event_id = `request:derived:` + fnv1a64(canonical
    {turn, step, seq?})；seq=None 时整体省略 seq 键（两语言同一省略规则）。"""
    ident = {"turn": turn, "step": step}
    if seq is not None:
        ident["seq"] = seq
    return "request:derived:" + fnv1a64_hex(canonical_json(ident))


_BASE_KEYS = ("uncached_input_tokens", "cache_read_tokens",
              "cache_write_tokens", "output_tokens")


def _facts_bucket_sums(facts):
    """成功 fact 四桶求和（None 当 0——逐槽缺项在求和语义下是 0）。"""
    sums = {k: 0 for k in _BASE_KEYS}
    for f in facts:
        for k in _BASE_KEYS:
            sums[k] += f[k] or 0
    return sums


def _by_model_bucket_sums(doc):
    """`token_by_model` 的 by_model 聚合四桶求和（同一求和语义）。"""
    sums = {k: 0 for k in _BASE_KEYS}
    for buckets in doc["by_model"].values():
        for k in _BASE_KEYS:
            sums[k] += buckets[k]
    return sums


def _assert_reconciles(tc, facts, doc, label):
    """不变量：逐槽四桶之和 == by_model 四桶之和（spec §2.1 reconcile）。"""
    tc.assertEqual(_facts_bucket_sums(facts), _by_model_bucket_sums(doc),
                   "%s: 逐槽四桶之和 != token_by_model 四桶之和" % label)


def _zstd_blob(rows, spans):
    """把 rows（list[dict]）按 1-based 行跨度压成多帧 zstd blob——镜像
    build_zstd_fixture.py 的「每次 flush 追加一个新 zstd 帧」形态。调用方负责
    `_HAVE_ZSTD` 守卫。"""
    lines = "".join(json.dumps(r) + "\n" for r in rows)
    blob = b""
    for start, end in spans:
        chunk = "".join(lines.splitlines(keepends=True)[start - 1:end])
        blob += zstandard.ZstdCompressor().compress(chunk.encode("utf-8"))
    return blob


# ────────────────────────────────────────────────────────────────────────
# Python 直调：acceptance #1-#8 + #9 纯函数半侧
# ────────────────────────────────────────────────────────────────────────

class DshUsageFactEmitterCase(unittest.TestCase):
    """Python 端 emitter 直调——不依赖 Rust 二进制。"""

    def _emit(self, path, profile=None, ns=NS):
        return dsh_session_to_usage_facts(path, machine_namespace=ns,
                                          source_profile=profile)

    def _assert_invariant(self, res, label):
        """成功 emit 恒有 observation_rows == fact_rows、source_event_id 全唯一。"""
        cov = res.coverage
        self.assertEqual(cov["observation_rows"], cov["fact_rows"],
                         "%s: observation_rows == fact_rows 不成立" % label)
        ids = [f["source_event_id"] for f in res.facts]
        self.assertEqual(len(ids), len(set(ids)),
                         "%s: source_event_id 必须全唯一" % label)

    # ── #1 单文件 emit（对账 fold）─────────────────────────────
    def test_behavior_single_file_emit_reconciles_fold(self):
        """acceptance #1：`behavior.jsonl` 逐相邻槽一 fact（slot (9,1)/(10,1)/
        (11,1) 共 3），6 身份字段正确；四桶求和 == token_by_model；同槽
        chunk+message 只出一 fact（无双计）；model_raw 各槽 header 激活模型
        （(9,1)→pro、(10,1)→flash、(11,1)→pro）；header 无 provider →
        provider_raw=None（老日志态）；fact 行带 turn/step。"""
        res = self._emit(BEHAVIOR)
        self.assertEqual(res.coverage,
                         {"observation_rows": 3, "fact_rows": 3,
                          "unaccounted_events": 0, "unaccounted_tokens": 0})
        self._assert_invariant(res, "behavior")
        f9, f10, f11 = res.facts
        # 6 身份字段
        for f in (f9, f10, f11):
            self.assertEqual(f["harness"], "dsh")
            self.assertEqual(f["machine_namespace"], NS)
            self.assertEqual(f["source_profile"], "---Users-alice-projects-demo--")
            self.assertEqual(f["native_session_id"], "sess-behavior-0001")
            self.assertEqual(f["observation_kind"], "assistant-usage")
            self.assertEqual(f["identity_basis"], "derived-hash")
        # 同槽 chunk130+message131 → 单 fact，值取 message（支配样本）最终值，
        # 无双计（不是 chunk 的 1.0M + message 的 1.2M）
        self.assertEqual((f9["turn"], f9["step"]), (9, 1))
        self.assertEqual(f9["uncached_input_tokens"], 1200000)
        self.assertEqual(f9["output_tokens"], 2500)
        self.assertEqual(f9["cache_read_tokens"], 3000)
        self.assertIsNone(f9["cache_write_tokens"])
        self.assertEqual(f9["event_ts_utc"], "2025-06-15T15:10:32.000Z")
        self.assertEqual(f9["source_event_id"], _derived_request_id(9, 1, 130))
        self.assertEqual(f9["model_raw"], "deepseek/deepseek-v4-pro-0813")
        self.assertIsNone(f9["provider_raw"], "老日志态 header 无 provider")
        self.assertEqual((f10["turn"], f10["step"]), (10, 1))
        self.assertEqual(f10["uncached_input_tokens"], 200000)
        self.assertEqual(f10["output_tokens"], 500)
        self.assertIsNone(f10["cache_read_tokens"])
        self.assertEqual(f10["model_raw"], "deepseek/deepseek-v4-flash")
        self.assertEqual((f11["turn"], f11["step"]), (11, 1))
        self.assertEqual(f11["uncached_input_tokens"], 300000)
        self.assertIsNone(f11["output_tokens"])
        self.assertEqual(f11["cache_read_tokens"], 1000)
        self.assertEqual(f11["model_raw"], "deepseek/deepseek-v4-pro-0813")
        # 对账 fold
        text = BEHAVIOR.read_text(encoding="utf-8")
        doc = token_by_model(parse_session_log(text)["usage_events"])
        _assert_reconciles(self, res.facts, doc, "behavior #1")
        self.assertEqual(len(set(f["fact_id"] for f in res.facts)), 3)

    # ── #2 append 不改写旧 fact_id ─────────────────────────────
    def test_append_does_not_rewrite_old_fact_id(self):
        """acceptance #2：只含 chunk seq=130 的前缀 vs 全量（+message seq=131）。
        重扫 slot(9,1) fact_id/source_event_id 不变（身份开槽即固化、首样本锚
        seq=130），token 字段更新为 message 最终值（input 1.0M→1.2M）。"""
        rows = [json.loads(l) for l in BEHAVIOR.read_text(encoding="utf-8").splitlines()]
        prefix = [r for r in rows if r.get("seq", -1) <= 130]
        with tempfile.TemporaryDirectory() as tmp:
            pp = _write(tmp, "prefix.jsonl", prefix)
            pf = _write(tmp, "full.jsonl", rows)
            r_pref = self._emit(pp)
            r_full = self._emit(pf)
        self.assertEqual(r_pref.coverage["fact_rows"], 1)
        self.assertEqual(r_full.coverage["fact_rows"], 3)
        a, b = r_pref.facts[0], r_full.facts[0]
        self.assertEqual((a["turn"], a["step"]), (9, 1))
        self.assertEqual(a["source_event_id"], b["source_event_id"],
                         "append shadow 不改写 source_event_id")
        self.assertEqual(a["fact_id"], b["fact_id"],
                         "append shadow 不改写 fact_id（身份输入冻结在首样本）")
        # chunk-only 前缀：值 = chunk130（input 1.0M）；全量 = message131（1.2M）
        self.assertEqual(a["uncached_input_tokens"], 1000000)
        self.assertEqual(a["output_tokens"], 2000)
        self.assertEqual(b["uncached_input_tokens"], 1200000)
        self.assertEqual(b["output_tokens"], 2500)

    # ── #3 多帧增量 emit（zstd）────────────────────────────────
    @unittest.skipUnless(_HAVE_ZSTD, "多帧 zstd 解码需要可选的 zstandard 包")
    def test_multi_frame_zstd_equals_plaintext(self):
        """acceptance #3：`session.jsonl.zstd`（3 帧）emit == 同内容明文
        `behavior.jsonl` emit 逐字节相同（帧边界不可见；无 path.stem 的身份保证两态
        一致）；追加全新请求的新帧 → 重扫得新 fact、旧 fact 逐字节不变。"""
        res_z = self._emit(ZSTD)
        res_p = self._emit(BEHAVIOR)
        self.assertEqual(res_z.facts, res_p.facts, "zstd 与明文 emit 逐字段全等")
        self.assertEqual(res_z.coverage, res_p.coverage)
        self._assert_invariant(res_z, "zstd")
        # 追加全新请求的新帧 → 旧 fact 逐字节不变、新 fact 增加
        base = [json.loads(l) for l in BEHAVIOR.read_text(encoding="utf-8").splitlines()]
        extra = [
            {"type": "turn/start", "seq": 200, "time": T0 + 159000,
             "data": {"turn": 20}},
            {"type": "request/header", "seq": 201, "time": T0 + 160000,
             "data": {"header": {"config": {"model": "deepseek/deepseek-v4-flash",
                                            "provider": "deepseek-official"}}}},
            _chunk(202, T0 + 161000, 20, 1, {"inputTokens": 42, "outputTokens": 7}),
            {"type": "turn/end", "seq": 203, "time": T0 + 162000, "data": {"turn": 20}},
        ]
        app = base + extra
        with tempfile.TemporaryDirectory() as tmp:
            # 明文追加 + 追加部分独立成第 4 帧
            p_plain = _write(tmp, "appended.jsonl", app)
            p_z = Path(tmp) / "appended.jsonl.zstd"
            p_z.write_bytes(_zstd_blob(app, [(1, 50), (51, 100), (101, len(base)),
                                             (len(base) + 1, None)]))
            r_plain = self._emit(p_plain)
            r_zapp = self._emit(p_z)
        self.assertEqual(r_zapp.facts, r_plain.facts, "追加 zstd 与追加明文全等")
        self.assertEqual(r_zapp.coverage["fact_rows"], 4)
        # 旧 3 fact 与未追加的全量逐字节不变（fact_id 全等即身份+值都稳定）
        self.assertEqual([f["fact_id"] for f in r_plain.facts[:3]],
                         [f["fact_id"] for f in res_p.facts])
        newf = r_plain.facts[3]
        self.assertEqual((newf["turn"], newf["step"]), (20, 1))
        self.assertEqual(newf["uncached_input_tokens"], 42)
        self.assertEqual(newf["output_tokens"], 7)
        self.assertEqual(newf["model_raw"], "deepseek/deepseek-v4-flash")

    # ── #4 compaction native basis ──────────────────────────────
    def test_compaction_emit_native_basis(self):
        """acceptance #4：`resume.jsonl` compaction 槽一 fact，turn/step=None，
        model_raw=自带 deepseek-v4-flash、provider_raw=自带 deepseek-official，
        source_event_id=`compaction:cmp-1`、identity_basis=native，四桶=compaction
        usage 四桶。"""
        res = self._emit(RESUME)
        self.assertEqual(res.coverage["fact_rows"], 4)
        facts = {f["source_event_id"]: f for f in res.facts}
        f = facts["compaction:cmp-1"]
        self.assertEqual(f["identity_basis"], "native",
                         "compactionId 是执行环境原生标识 → native（非 hash fallback）")
        self.assertIsNone(f["turn"])
        self.assertIsNone(f["step"])
        self.assertEqual(f["model_raw"], "deepseek-v4-flash")
        self.assertEqual(f["provider_raw"], "deepseek-official")
        self.assertEqual(f["uncached_input_tokens"], 462)
        self.assertEqual(f["output_tokens"], 3520)
        self.assertEqual(f["cache_read_tokens"], 245760)
        self.assertIsNone(f["cache_write_tokens"])
        self.assertEqual(f["event_ts_utc"], "2025-06-15T15:06:49.000Z")
        self._assert_invariant(res, "resume-compaction")

    # ── #5 同槽双 chunk 首样本稳定 ──────────────────────────────
    def test_dual_chunk_first_sample_anchors_identity(self):
        """acceptance #5：`resume.jsonl` slot(3,1)=chunk13→chunk14 → 单 fact，
        source_event_id = 共享 helper 复算的 fnv1a64({turn,step,seq:13})
        （first_sample_seq=13 不因 chunk14 覆盖改变），四桶取 chunk14 最终值。"""
        res = self._emit(RESUME)
        facts = {f["source_event_id"]: f for f in res.facts}
        f = facts[_derived_request_id(3, 1, 13)]
        self.assertEqual(f["identity_basis"], "derived-hash")
        self.assertEqual((f["turn"], f["step"]), (3, 1))
        self.assertEqual(f["uncached_input_tokens"], 3100, "取 chunk14 支配值")
        self.assertIsNone(f["output_tokens"], "chunk14 无 outputTokens → None 保真")
        self.assertEqual(f["cache_read_tokens"], 1000)
        self.assertEqual(f["model_raw"], "deepseek/deepseek-v4-pro-0813")
        self.assertEqual(f["provider_raw"], "shengsuanyun")
        self.assertEqual(len([x for x in res.facts
                              if (x["turn"], x["step"]) == (3, 1)]), 1,
                         "双 chunk 同槽只出一 fact")

    # ── #5b 无 compactionId + append shadow → fact_id 不变 ───────
    def test_no_compaction_id_append_shadow_fact_id_stable(self):
        """acceptance #5b：两个相邻的无 id compaction（_compaction_identity 缺 id
        → 固定负号槽，相邻即同槽）。前缀只含第一个、全量含两个 → 重扫 fact_id
        不变（first_sample_identity_hash 开槽固化），token/model/provider 取支配
        （第二个）样本；fold 侧也只有一个负号槽被计入（reconcile 一致）。"""
        opening = _comp(1, T0 + 1000, {"model": "deepseek-v4-pro",
                                       "provider": "shengsuanyun",
                                       "usage": {"inputTokens": 111, "outputTokens": 1}})
        shadow = _comp(2, T0 + 2000, {"model": "deepseek-v4-flash",
                                      "provider": "deepseek-official",
                                      "usage": {"inputTokens": 222, "outputTokens": 5}})
        with tempfile.TemporaryDirectory() as tmp:
            r_pref = self._emit(_write(tmp, "pref.jsonl", [_hdr(), opening]))
            r_full = self._emit(_write(tmp, "full.jsonl", [_hdr(), opening, shadow]))
        self.assertEqual(r_pref.coverage,
                         {"observation_rows": 1, "fact_rows": 1,
                          "unaccounted_events": 0, "unaccounted_tokens": 0})
        self.assertEqual(r_full.coverage,
                         {"observation_rows": 1, "fact_rows": 1,
                          "unaccounted_events": 0, "unaccounted_tokens": 0},
                         "相邻同槽 compaction 折叠成 1 槽")
        a, b = r_pref.facts[0], r_full.facts[0]
        self.assertEqual(a["source_event_id"], b["source_event_id"],
                         "无 id compaction 身份 hash 冻结在开槽样本")
        self.assertEqual(a["fact_id"], b["fact_id"],
                         "append shadow 不改写无 id compaction 的 fact_id")
        self.assertEqual(b["identity_basis"], "derived-hash")
        self.assertTrue(b["source_event_id"].startswith("compaction:derived:"))
        # 前缀值 = 开槽样本；全量值 = 支配（第二个）样本
        self.assertEqual(a["uncached_input_tokens"], 111)
        self.assertEqual(a["model_raw"], "deepseek-v4-pro")
        self.assertEqual(b["uncached_input_tokens"], 222)
        self.assertEqual(b["output_tokens"], 5)
        self.assertEqual(b["model_raw"], "deepseek-v4-flash")
        self.assertEqual(b["provider_raw"], "deepseek-official")
        # fold 侧只有一个负号槽被计入（reconcile 一致）
        with tempfile.TemporaryDirectory() as tmp:
            txt = _write(tmp, "s.jsonl", [_hdr(), opening, shadow]).read_text()
        doc = token_by_model(parse_session_log(txt)["usage_events"])
        _assert_reconciles(self, r_full.facts, doc, "5b fold")

    # ── #5c 同 compactionId 非相邻重现 → duplicate 硬错误 ────────
    def test_non_adjacent_same_compaction_id_duplicate_guard(self):
        """acceptance #5c：`[compaction c1, 普通请求, compaction c1]` → fold 折进
        三个槽（request_metrics 出三行、by_model 把两个 c1 都计入）→ emitter
        **raise duplicate-source-event-id**（不静默去重、不出部分 fact）。测试同时
        断言 request_metrics 三行、reconcile 在 request_metrics 层成立——佐证
        「守卫在出账前、不是误伤」。"""
        rows = [
            _hdr(),
            _comp(1, T0 + 1000, {"compactionId": "c1",
                                 "usage": {"inputTokens": 50}}),
            {"type": "turn/start", "seq": 2, "time": T0 + 2000, "data": {"turn": 1}},
            {"type": "request/header", "seq": 3, "time": T0 + 3000,
             "data": {"header": {"config": {"model": "m", "provider": "p"}}}},
            _chunk(4, T0 + 4000, 1, 1, {"inputTokens": 5, "outputTokens": 5}),
            {"type": "turn/end", "seq": 5, "time": T0 + 5000, "data": {"turn": 1}},
            _comp(6, T0 + 6000, {"compactionId": "c1",
                                 "usage": {"inputTokens": 60}}),
        ]
        with tempfile.TemporaryDirectory() as tmp:
            p = _write(tmp, "dup.jsonl", rows)
            with self.assertRaises(DshUsageFactError) as cm:
                self._emit(p)
        code, msg = cm.exception.args[0]
        self.assertEqual(code, "duplicate-source-event-id")
        self.assertIn("compaction:c1", msg)
        # fold/observer 侧真折进三个槽（守卫不是误伤）：request_metrics 三行
        with tempfile.TemporaryDirectory() as tmp:
            txt = _write(tmp, "s.jsonl", rows).read_text()
        events = parse_session_log(txt)["usage_events"]
        rm = request_metrics(events)
        self.assertEqual(len(rm), 3, "两个 c1 + 一个普通请求 = 3 行")
        doc = token_by_model(events)
        self.assertEqual(doc["by_model"]["m"]["uncached_input_tokens"], 65,
                         "by_model 把两个 c1 都计入（60 进 m）")
        # reconcile 在 request_metrics 层成立：3 行的四桶 == by_model 四桶
        # （比桶只比四基础桶，peak_* 是聚合层派生桶，两侧都读基础桶值）
        sums = {k: 0 for k in _BASE_KEYS}
        for row in rm:
            for k in _BASE_KEYS:
                sums[k] += row[k] or 0
        self.assertEqual(sums, _by_model_bucket_sums(doc), "5c request_metrics 对账")

    # ── #6 provider_raw 原始性 + 聚合层才 ambiguous ─────────────
    def test_provider_raw_is_original_evidence(self):
        """acceptance #6a：`resume.jsonl` slot(1,1)/(3,1)（pro）→ provider_raw=
        shengsuanyun；slot(2,1)（flash）→ deepseek-official。fact 里只有原始单串，
        无 `__ambiguous__`（那是聚合层派生状态，不进 fact）。"""
        res = self._emit(RESUME)
        facts = {(f["turn"], f["step"]): f for f in res.facts
                 if f["turn"] is not None}
        self.assertEqual(facts[(1, 1)]["model_raw"], "deepseek/deepseek-v4-pro-0813")
        self.assertEqual(facts[(1, 1)]["provider_raw"], "shengsuanyun")
        self.assertEqual(facts[(3, 1)]["provider_raw"], "shengsuanyun")
        self.assertEqual(facts[(2, 1)]["model_raw"], "deepseek/deepseek-v4-flash")
        self.assertEqual(facts[(2, 1)]["provider_raw"], "deepseek-official")
        for f in res.facts:
            self.assertNotEqual(f.get("provider_raw"), "__ambiguous__",
                                "ambiguous 是聚合层派生状态，绝不出现在 fact")
            self.assertIn(f["provider_raw"], (None, "shengsuanyun",
                                              "deepseek-official"))

    def test_provider_switch_same_model_keeps_raw_per_request(self):
        """acceptance #6b：同一会话内同模型 X 由 provider A→B 服务 → 两条 fact 的
        provider_raw 分别为 A/B（各自保留），而 token_by_model 聚合的
        providers[X] == __ambiguous__——「原始证据在 fact、派生结论在聚合层」的
        分层被钉死。"""
        rows = [
            _hdr(),
            {"type": "turn/start", "seq": 1, "time": T0 + 1000, "data": {"turn": 1}},
            {"type": "request/header", "seq": 2, "time": T0 + 2000,
             "data": {"header": {"config": {"model": "X", "provider": "A"}}}},
            _chunk(3, T0 + 3000, 1, 1, {"inputTokens": 100, "outputTokens": 1}),
            {"type": "turn/end", "seq": 4, "time": T0 + 4000, "data": {"turn": 1}},
            {"type": "turn/start", "seq": 5, "time": T0 + 5000, "data": {"turn": 2}},
            {"type": "request/header", "seq": 6, "time": T0 + 6000,
             "data": {"header": {"config": {"model": "X", "provider": "B"}}}},
            _chunk(7, T0 + 7000, 2, 1, {"inputTokens": 200, "outputTokens": 2}),
            {"type": "turn/end", "seq": 8, "time": T0 + 8000, "data": {"turn": 2}},
        ]
        with tempfile.TemporaryDirectory() as tmp:
            res = self._emit(_write(tmp, "switch.jsonl", rows))
            txt = _write(tmp, "s.jsonl", rows).read_text()
        self.assertEqual(res.coverage["fact_rows"], 2)
        f1, f2 = res.facts
        self.assertEqual((f1["turn"], f1["step"]), (1, 1))
        self.assertEqual(f1["provider_raw"], "A")
        self.assertEqual((f2["turn"], f2["step"]), (2, 1))
        self.assertEqual(f2["provider_raw"], "B")
        self.assertEqual(f1["model_raw"], f2["model_raw"])
        # 聚合层：同模型名 X 被两家服务 → ambiguous（派生结论）
        providers = token_by_model(parse_session_log(txt)["usage_events"])["providers"]
        self.assertEqual(providers.get("X"), "__ambiguous__")
        _assert_reconciles(self, res.facts,
                           token_by_model(parse_session_log(txt)["usage_events"]),
                           "6b")

    def test_no_header_model_evidence_is_none_not_unknown(self):
        """acceptance #6c：无 header model 证据的槽 → model_raw=None（非 "unknown"
        渲染哨兵）；provider_raw 同 None。"""
        rows = [_hdr(), _chunk(1, T0 + 1000, 1, 1,
                               {"inputTokens": 100, "outputTokens": 1})]
        with tempfile.TemporaryDirectory() as tmp:
            res = self._emit(_write(tmp, "nohdr.jsonl", rows))
        f = res.facts[0]
        self.assertEqual(res.coverage["fact_rows"], 1)
        self.assertIsNone(f["model_raw"], '"unknown" 是展示层哨兵，不是模型名')
        self.assertIsNone(f["provider_raw"])
        self.assertEqual(f["identity_basis"], "derived-hash")

    # ── #7 R2a SessionKey 对得上 ────────────────────────────────
    def test_identity_matches_r2a_session_key(self):
        """acceptance #7：fact 的 (harness, machine_namespace, source_profile,
        native_session_id) == R2a 四元 SessionKey 分量（SessionKey::new("dsh",
        header.id, dsh_source_profile(cwd), ns)）。对 resume 与 behavior 各验——
        身份字段与 R2a 同源，append/profile 派生都对得上。"""
        for path, exp_id in ((RESUME, "sess-resume-0001"),
                             (BEHAVIOR, "sess-behavior-0001")):
            text = path.read_text(encoding="utf-8")
            res = self._emit(path)
            header_id = json.loads(text.splitlines()[0])["id"]
            cwd = json.loads(text.splitlines()[0]).get("cwd")
            self.assertEqual(header_id, exp_id)
            expect_profile = dsh_source_profile(cwd)
            for f in res.facts:
                self.assertEqual((f["harness"], f["machine_namespace"],
                                  f["source_profile"], f["native_session_id"]),
                                 ("dsh", NS, expect_profile, header_id),
                                 "fact 身份四元 != R2a SessionKey 分量")

    # ── #8 unaccounted 诚实面 + strict 归属 ─────────────────────
    def test_resume_unaccounted_is_honest(self):
        """acceptance #8：`resume.jsonl` seq=15 turn=None message（fold 拒收但有
        token 形状）→ 不出 fact、coverage unaccounted_events=1 /
        unaccounted_tokens=86（77+9）；observation_rows == fact_rows（等式不靠兜底
        计数、靠无 fake-empty 路径）。"""
        res = self._emit(RESUME)
        self.assertEqual(res.coverage["unaccounted_events"], 1)
        self.assertEqual(res.coverage["unaccounted_tokens"], 86)
        self.assertEqual(res.coverage["observation_rows"], 4)
        self.assertEqual(res.coverage["fact_rows"], 4)
        self._assert_invariant(res, "resume-unaccounted")
        # 四桶求和（fact，4 槽）仍 == by_model（residual 不进 by_model）
        text = RESUME.read_text(encoding="utf-8")
        doc = token_by_model(parse_session_log(text)["usage_events"])
        _assert_reconciles(self, res.facts, doc, "resume #8")

    def test_missing_cwd_unattributed_and_recovers_with_profile(self):
        """acceptance #8：cwd 缺失头行 + 无显式 profile → library raise
        unattributed（不给 facts=[] 空成功）；显式 --source-profile 则恢复 emit。"""
        hdr_nocwd = {"type": "session", "version": 0, "id": "sess-nocwd",
                     "createdAt": 1750000000000}
        rows = [hdr_nocwd, _chunk(1, T0 + 1000, 1, 1,
                                  {"inputTokens": 100, "outputTokens": 1})]
        with tempfile.TemporaryDirectory() as tmp:
            p = _write(tmp, "nocwd.jsonl", rows)
            with self.assertRaises(DshUsageFactError) as cm:
                self._emit(p)
            code, msg = cm.exception.args[0]
            self.assertEqual(code, "unattributed")
            self.assertIn("--source-profile", msg)
            res = self._emit(p, profile="explicit-profile")
        self.assertEqual(res.coverage["fact_rows"], 1)
        self.assertEqual(res.facts[0]["source_profile"], "explicit-profile")

    def test_missing_session_id_is_hard_error(self):
        """acceptance #8：header 缺 session id → library raise missing-session-id
        （不是 DSH 会话 / 无法定身份）。空串 id 同缺失。"""
        for hdr in ({"type": "session", "version": 0, "createdAt": 1750000000000,
                     "cwd": "/tmp/x"},
                    {"type": "session", "version": 0, "id": "",
                     "createdAt": 1750000000000, "cwd": "/tmp/x"}):
            rows = [hdr, _chunk(1, T0 + 1000, 1, 1,
                                {"inputTokens": 100, "outputTokens": 1})]
            with tempfile.TemporaryDirectory() as tmp:
                with self.assertRaises(DshUsageFactError) as cm:
                    self._emit(_write(tmp, "noid.jsonl", rows))
            code, msg = cm.exception.args[0]
            self.assertEqual(code, "missing-session-id")
            self.assertIn("session header is missing id", msg)

    def test_clean_empty_exits_zero_empty_facts(self):
        """acceptance #8：clean 空（干净解析 + post-fork 零样本）→ 不是错误——
        facts=[] + 全 0 coverage（与 exit-2 硬错误形状可区分，§4.3）。"""
        rows = [_hdr(),
                {"type": "turn/start", "seq": 1, "time": T0 + 1000, "data": {"turn": 1}},
                {"type": "turn/end", "seq": 2, "time": T0 + 2000, "data": {"turn": 1}}]
        with tempfile.TemporaryDirectory() as tmp:
            res = self._emit(_write(tmp, "empty.jsonl", rows))
        self.assertEqual(res.facts, [])
        self.assertEqual(res.coverage,
                         {"observation_rows": 0, "fact_rows": 0,
                          "unaccounted_events": 0, "unaccounted_tokens": 0})

    def test_read_and_decode_errors_are_hard(self):
        """acceptance #8 的 I/O 半边：不可读文件 → file-missing；假 zstd 帧 →
        zstd-decode-error（都上抛，CLI exit 2）。"""
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(DshUsageFactError) as cm:
                self._emit(Path(tmp) / "no-such.jsonl")
            self.assertEqual(cm.exception.args[0][0], "file-missing")
            bad = Path(tmp) / "bad.jsonl.zstd"
            bad.write_bytes(b"not a real zstd frame")
            with self.assertRaises(DshUsageFactError) as cm:
                self._emit(bad)
            self.assertEqual(cm.exception.args[0][0], "zstd-decode-error")

    # ── #9 纯函数半侧：RFC3339 + canonical-hash 两语言字节契约 ──
    def test_rfc3339_ms_z_pure_battery(self):
        """acceptance #9（纯函数半侧）：epoch 0、真实 ms、整数边界 → 字面串。
        Rust 侧 cfg(test) 断言同一字面量（`src/agent/dsh_usage_fact.rs`），跨语言
        字节一致由 CLI fact 里的 event_ts_utc byte-parity（BothTests）钉住。"""
        from agent_vitals.agent.dsh_usage_fact import _rfc3339_ms_z  # noqa: PLC0415
        cases = {
            0: "1970-01-01T00:00:00.000Z",
            1: "1970-01-01T00:00:00.001Z",
            999: "1970-01-01T00:00:00.999Z",
            1000: "1970-01-01T00:00:01.000Z",
            86399999: "1970-01-01T23:59:59.999Z",
            86400000: "1970-01-02T00:00:00.000Z",
            1750000001000: "2025-06-15T15:06:41.000Z",
            1750000015999: "2025-06-15T15:06:55.999Z",
        }
        for ms, expected in cases.items():
            self.assertEqual(_rfc3339_ms_z(ms), expected, "ms=%d" % ms)

    def test_canonical_identity_hash_recompute_battery(self):
        """acceptance #9（纯函数半侧）：source_event_id 可从共享 helper 复算——
        seq 整数（含在 identity 元组里）与 seq=None（整体省略该键，Python 不产
        "None"）两分支都落在同一 canonical+FNV 规则上。普通槽 + 无 id compaction
        的身份行都验。"""
        # seq 整数：resume 三普通槽的 source_event_id 直接复算相等
        res = self._emit(RESUME)
        facts = {f["source_event_id"]: f for f in res.facts}
        for turn, step, seq in ((1, 1, 3), (2, 1, 8), (3, 1, 13)):
            self.assertIn(_derived_request_id(turn, step, seq), facts)
        # seq=None → 省略 seq 键（不是 "None"/"null"）
        self.assertEqual(_derived_request_id(5, 1, None),
                         "request:derived:" + fnv1a64_hex(canonical_json(
                             {"step": 1, "turn": 5})))
        self.assertNotIn("None", _derived_request_id(5, 1, None))
        self.assertNotIn("null", _derived_request_id(5, 1, None))
        # 无 id compaction 首样本行 hash：seq 整数与 None 两分支
        data = {"model": "m", "provider": "p",
                "usage": {"inputTokens": 9, "outputTokens": 1}}
        row_int = {"type": "compaction/summary", "time": T0 + 2000, "data": data,
                   "seq": 1}
        row_none = {"type": "compaction/summary", "time": T0 + 2000, "data": data}
        for row in (row_int, row_none):
            ident = {k: v for k, v in row.items()}
            # 模拟 observer：seq 整数才在 canonical 行里（hash 对象永不带 null 键）
            h = fnv1a64_hex(canonical_json(ident))
            self.assertTrue(h.isalnum() and len(h) == 16)
            self.assertNotIn("None", canonical_json(ident))
            self.assertNotIn("null", canonical_json(ident))


# ────────────────────────────────────────────────────────────────────────
# byte-parity + exit-2 错误族（双实现 CLI）
# ────────────────────────────────────────────────────────────────────────

@unittest.skipUnless(_BIN, "未设 AGENT_VITALS_BIN，跳过双实现比对")
class DshUsageFactsBothTests(unittest.TestCase):
    """acceptance #9 的 CLI 半侧：`dsh-usage-facts --json -` 的 Python `scan.py` ↔
    Rust 二进制 stdout **逐字节相等**（含 RFC3339 event_ts_utc、provider_raw、
    derived/native source_event_id、identity_basis、coverage）。语料扫进决策锁的
    每个分支：明文老日志（无 provider）/ 明文新日志（native compaction + 残差）/
    多帧 zstd / append 新请求 / provider-switch / 无 id compaction adjacent
    shadow / seq=None 省略分支。错误族：缺 --machine-namespace exit 2 且不写
    state、不存在文件 exit 2、无 cwd 无 profile exit 2、缺 id exit 2、duplicate
    exit 2 消息同码。

    Run: AGENT_VITALS_BIN=$PWD/target/release/agent-vitals python3 -m unittest
    tests.test_dsh_usage_fact.DshUsageFactsBothTests -v
    """

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.home = self.tmp / "home"
        self.home.mkdir()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _run(self, cmd, args, *, home_isolation=False):
        """Run a CLI command.

        Args:
            home_isolation: if True, override HOME to self.home so Python cannot find
                $HOME/Library/Python (zstandard etc.) — use only for tests that need
                to verify state-file isolation; other tests must NOT set this, otherwise
                optional-dependency features like zstd decode silently disappear.
        """
        env = dict(os.environ)
        if home_isolation:
            env["HOME"] = str(self.home)
            env["USERPROFILE"] = str(self.home)
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        env.pop("AGENT_VITALS_BIN", None)
        return subprocess.run(
            cmd + ["dsh-usage-facts"] + args,
            env=env, capture_output=True, text=True, cwd=str(self.home))

    def _assert_byte_equal(self, args):
        py = self._run(PY_CMD, args)
        rs = self._run([_BIN], args)
        self.assertEqual(py.returncode, 0,
                         "py exit %d: %s" % (py.returncode, py.stderr))
        self.assertEqual(rs.returncode, 0,
                         "rs exit %d: %s" % (rs.returncode, rs.stderr))
        self.assertEqual(
            py.stdout, rs.stdout,
            "dsh-usage-facts --json stdout 不一致：\npy:\n%s\nrs:\n%s"
            % (py.stdout, rs.stdout))
        return json.loads(py.stdout)

    def _temp_file(self, name, rows):
        p = self.tmp / name
        p.write_text("".join(json.dumps(r) + "\n" for r in rows),
                     encoding="utf-8")
        return p

    def test_byte_equal_six_corpora(self):
        """acceptance #9：同一语料两侧 --json stdout 逐字节相等。六份语料循环扫
        （zstd 两份缺 zstandard 则跳过）。"""
        # 构造语料
        rows_behavior = [json.loads(l)
                         for l in BEHAVIOR.read_text(encoding="utf-8").splitlines()]
        rows_resume = [json.loads(l)
                       for l in RESUME.read_text(encoding="utf-8").splitlines()]
        extra = [
            {"type": "turn/start", "seq": 200, "time": T0 + 159000,
             "data": {"turn": 20}},
            {"type": "request/header", "seq": 201, "time": T0 + 160000,
             "data": {"header": {"config": {"model": "deepseek/deepseek-v4-flash",
                                            "provider": "deepseek-official"}}}},
            _chunk(202, T0 + 161000, 20, 1, {"inputTokens": 42, "outputTokens": 7}),
            {"type": "turn/end", "seq": 203, "time": T0 + 162000, "data": {"turn": 20}},
        ]
        rows_app = rows_behavior + extra
        # 6b provider-switch
        rows_switch = [
            _hdr(id_="sess-switch"),
            {"type": "turn/start", "seq": 1, "time": T0 + 1000, "data": {"turn": 1}},
            {"type": "request/header", "seq": 2, "time": T0 + 2000,
             "data": {"header": {"config": {"model": "X", "provider": "A"}}}},
            _chunk(3, T0 + 3000, 1, 1, {"inputTokens": 100, "outputTokens": 1}),
            {"type": "turn/end", "seq": 4, "time": T0 + 4000, "data": {"turn": 1}},
            {"type": "turn/start", "seq": 5, "time": T0 + 5000, "data": {"turn": 2}},
            {"type": "request/header", "seq": 6, "time": T0 + 6000,
             "data": {"header": {"config": {"model": "X", "provider": "B"}}}},
            _chunk(7, T0 + 7000, 2, 1, {"inputTokens": 200, "outputTokens": 2}),
            {"type": "turn/end", "seq": 8, "time": T0 + 8000, "data": {"turn": 2}},
        ]
        # 5b-full：两个相邻无 id compaction
        rows_noid_comp = [_hdr(id_="sess-noidcomp"),
                          _comp(1, T0 + 1000, {"model": "deepseek-v4-pro",
                                               "provider": "shengsuanyun",
                                               "usage": {"inputTokens": 111,
                                                         "outputTokens": 1}}),
                          _comp(2, T0 + 2000, {"model": "deepseek-v4-flash",
                                               "provider": "deepseek-official",
                                               "usage": {"inputTokens": 222,
                                                         "outputTokens": 5}})]

        corpora = [
            ("behavior", BEHAVIOR, None,
             {"observation_rows": 3, "fact_rows": 3,
              "unaccounted_events": 0, "unaccounted_tokens": 0},
             {"source_event_ids": 3, "derived-hash": 3, "native": 0}),
            ("resume", RESUME, None,
             {"observation_rows": 4, "fact_rows": 4,
              "unaccounted_events": 1, "unaccounted_tokens": 86},
             {"source_event_ids": 4, "derived-hash": 3, "native": 1}),
            ("appended-plaintext", self._temp_file("appended.jsonl", rows_app),
             None,
             {"observation_rows": 4, "fact_rows": 4,
              "unaccounted_events": 0, "unaccounted_tokens": 0},
             {"source_event_ids": 4, "derived-hash": 4, "native": 0}),
            ("provider-switch", self._temp_file("switch.jsonl", rows_switch),
             None,
             {"observation_rows": 2, "fact_rows": 2,
              "unaccounted_events": 0, "unaccounted_tokens": 0},
             {"source_event_ids": 2, "derived-hash": 2, "native": 0}),
            ("noid-comp-shadow", self._temp_file("noidcomp.jsonl", rows_noid_comp),
             None,
             {"observation_rows": 1, "fact_rows": 1,
              "unaccounted_events": 0, "unaccounted_tokens": 0},
             {"source_event_ids": 1, "derived-hash": 1, "native": 0}),
        ]
        # 多帧 zstd 只在本机装有 zstandard 时入列（Python 侧解码需要它；缺时 Rust
        # 能解而 Python 不能，无法对账，整体 skip——镜像 test_r2a 的 `_HAVE_ZSTD`
        # 惯例）。committed 的 `session.jsonl.zstd` 与构造的 4 帧副本内容同 behavior，
        # 但两侧都不能假设 zstandard 在场，故 byte-parity 只用构造副本。
        if _HAVE_ZSTD:
            zpath = self.tmp / "zstd-copy.jsonl.zstd"
            zpath.write_bytes(_zstd_blob(rows_behavior, [(1, 50), (51, 100),
                                                         (101, None)]))
            corpora.append(
                ("zstd-3frame", zpath, None,
                 {"observation_rows": 3, "fact_rows": 3,
                  "unaccounted_events": 0, "unaccounted_tokens": 0},
                 {"source_event_ids": 3, "derived-hash": 3, "native": 0}))

        for label, path, profile, cov, ids in corpora:
            args = ["--path", str(path), "--machine-namespace", NS, "--json", "-"]
            doc = self._assert_byte_equal(args)
            self.assertEqual(doc["coverage"], cov, label)
            self.assertEqual(list(doc["coverage"].keys()),
                             ["observation_rows", "fact_rows",
                              "unaccounted_events", "unaccounted_tokens"],
                             "%s: coverage 键序固定" % label)
            self.assertEqual(len(doc["facts"]), cov["fact_rows"], label)
            bases = {"derived-hash": 0, "native": 0}
            for f in doc["facts"]:
                self.assertIn(f["identity_basis"], bases, label)
                bases[f["identity_basis"]] += 1
                self.assertEqual(f["harness"], "dsh", label)
                self.assertEqual(f["observation_kind"], "assistant-usage", label)
            self.assertEqual(bases["derived-hash"], ids["derived-hash"], label)
            self.assertEqual(bases["native"], ids["native"], label)
            self.assertEqual(len(set(f["fact_id"] for f in doc["facts"])),
                             ids["source_event_ids"],
                             "%s: fact_id 全唯一" % label)

    def test_seq_none_omission_branch_byte_equal(self):
        """acceptance #9：seq=None 的普通槽 / 无 id compaction 走「省略 seq 键」
        分支——两语言同一省略规则（Python 不产 "None"、Rust 不产 "null"），
        source_event_id 逐字节一致且与共享 helper 复算相等。"""
        rows_normal = [
            _hdr(id_="sess-noseq-normal"),
            _chunk(None, T0 + 1000, 1, 1, {"inputTokens": 9, "outputTokens": 1}),
        ]
        rows_comp = [
            _hdr(id_="sess-noseq-comp"),
            _comp(None, T0 + 1000, {"model": "m", "provider": "p",
                                    "usage": {"inputTokens": 9, "outputTokens": 1}}),
        ]
        for name, rows in (("noseq-normal.jsonl", rows_normal),
                           ("noseq-comp.jsonl", rows_comp)):
            p = self._temp_file(name, rows)
            doc = self._assert_byte_equal(["--path", str(p),
                                           "--machine-namespace", NS,
                                           "--json", "-"])
            f = doc["facts"][0]
            self.assertEqual(doc["coverage"]["fact_rows"], 1)
            if "normal" in name:
                self.assertEqual(f["source_event_id"], _derived_request_id(1, 1, None),
                                 name)
            else:
                self.assertTrue(f["source_event_id"].startswith(
                    "compaction:derived:"), name)
            self.assertNotIn("None", f["source_event_id"])
            self.assertNotIn("null", f["source_event_id"])

    def test_append_fact_id_stable_byte_equal(self):
        """acceptance #2+#9 的 CLI 半侧：同一构造会话，前缀只含 chunk seq=130、
        全量含 message seq=131——两侧分别逐字节相等，且全量 slot(9,1) 的 fact_id
        == 前缀的 fact_id（append 不改写）。"""
        rows = [json.loads(l)
                for l in BEHAVIOR.read_text(encoding="utf-8").splitlines()]
        prefix = [r for r in rows if r.get("seq", -1) <= 130]
        p_pref = self._temp_file("behavior-prefix.jsonl", prefix)
        p_full = self._temp_file("behavior-full.jsonl", rows)
        doc_pref = self._assert_byte_equal(["--path", str(p_pref),
                                            "--machine-namespace", NS, "--json", "-"])
        doc_full = self._assert_byte_equal(["--path", str(p_full),
                                            "--machine-namespace", NS, "--json", "-"])
        self.assertEqual(doc_pref["coverage"]["fact_rows"], 1)
        self.assertEqual(doc_full["coverage"]["fact_rows"], 3)
        self.assertEqual(doc_pref["facts"][0]["fact_id"],
                         doc_full["facts"][0]["fact_id"],
                         "CLI 层 append shadow 不改写 fact_id")
        self.assertEqual(doc_pref["facts"][0]["uncached_input_tokens"], 1000000)
        self.assertEqual(doc_full["facts"][0]["uncached_input_tokens"], 1200000)

    def test_missing_or_empty_machine_namespace_exits_2_and_writes_no_state(self):
        """v0.7 收口：namespace 缺失或空串均无效；两套 CLI 在参数边界给出
        同一错误，且绝不让 takeover 身份补齐或写入 state。"""
        snapshot = sorted(str(p.relative_to(self.home))
                          for p in self.home.rglob("*") if p.is_file())
        for suffix in ([], ["--machine-namespace", ""]):
            args = ["--path", str(BEHAVIOR), "--json", "-"] + suffix
            py = self._run(PY_CMD, args, home_isolation=True)
            rs = self._run([_BIN], args, home_isolation=True)
            self.assertEqual(py.returncode, 2, py.stderr)
            self.assertEqual(rs.returncode, 2, rs.stderr)
            self.assertEqual(py.stderr, rs.stderr)
            self.assertIn("--machine-namespace is required", py.stderr)
        after = sorted(str(p.relative_to(self.home))
                       for p in self.home.rglob("*") if p.is_file())
        self.assertEqual(after, snapshot,
                         "namespace 缺失或为空时不得写任何 state 文件")

    def test_strict_errors_exit_2_both_implementations(self):
        """acceptance #8+#9 CLI 半侧：I/O 缺失 / 无 cwd 无 profile / 缺 id /
        duplicate 全 exit 2，两语言同码。无 cwd 会话配显式 --source-profile 恢复
        emit（exit 0 逐字节相等）。"""
        hdr_nocwd = {"type": "session", "version": 0, "id": "sess-nocwd",
                     "createdAt": 1750000000000}
        rows_nocwd = [hdr_nocwd, _chunk(1, T0 + 1000, 1, 1,
                                        {"inputTokens": 100, "outputTokens": 1})]
        rows_noid = [{"type": "session", "version": 0, "createdAt": 1750000000000,
                      "cwd": "/tmp/x"},
                     _chunk(1, T0 + 1000, 1, 1,
                            {"inputTokens": 100, "outputTokens": 1})]
        rows_dup = [_hdr(),
                    _comp(1, T0 + 1000, {"compactionId": "c1",
                                         "usage": {"inputTokens": 50}}),
                    {"type": "turn/start", "seq": 2, "time": T0 + 2000,
                     "data": {"turn": 1}},
                    {"type": "request/header", "seq": 3, "time": T0 + 3000,
                     "data": {"header": {"config": {"model": "m"}}}},
                    _chunk(4, T0 + 4000, 1, 1, {"inputTokens": 5, "outputTokens": 5}),
                    {"type": "turn/end", "seq": 5, "time": T0 + 5000,
                     "data": {"turn": 1}},
                    _comp(6, T0 + 6000, {"compactionId": "c1",
                                         "usage": {"inputTokens": 60}})]
        p_nocwd = self._temp_file("nocwd.jsonl", rows_nocwd)
        p_noid = self._temp_file("noid.jsonl", rows_noid)
        p_dup = self._temp_file("dup.jsonl", rows_dup)
        p_clean = self._temp_file("clean.jsonl", [_hdr(),
                                                  {"type": "turn/start", "seq": 1,
                                                   "time": T0 + 1000,
                                                   "data": {"turn": 1}},
                                                  {"type": "turn/end", "seq": 2,
                                                   "time": T0 + 2000,
                                                   "data": {"turn": 1}}])

        # (label, args-extra, expected code-token in stderr)
        error_cases = [
            ("no-file", ["--path", str(self.tmp / "no-such.jsonl")],
             "file-missing"),
            ("no-cwd", ["--path", str(p_nocwd)], "unattributed"),
            ("no-id", ["--path", str(p_noid)], "missing-session-id"),
            ("duplicate", ["--path", str(p_dup)], "duplicate-source-event-id"),
        ]
        for label, extra, code in error_cases:
            args = extra + ["--machine-namespace", NS, "--json", "-"]
            py = self._run(PY_CMD, args)
            rs = self._run([_BIN], args)
            self.assertEqual(py.returncode, 2, "%s py exit: %s" % (label, py.stderr))
            self.assertEqual(rs.returncode, 2, "%s rs exit: %s" % (label, rs.stderr))
            self.assertIn(code, py.stderr, label)
            self.assertIn(code, rs.stderr, label)
            self.assertEqual(py.stdout, rs.stdout,
                             "%s: 失败路径两语言 stdout 应都为空且一致" % label)

        # clean 空：exit 0 + facts=[] + 全 0 coverage（与 exit-2 形状可区分）
        doc = self._assert_byte_equal(["--path", str(p_clean),
                                       "--machine-namespace", NS, "--json", "-"])
        self.assertEqual(doc["facts"], [])
        self.assertEqual(doc["coverage"],
                         {"observation_rows": 0, "fact_rows": 0,
                          "unaccounted_events": 0, "unaccounted_tokens": 0})

        # 无 cwd + 显式 --source-profile → 恢复 emit（exit 0，两侧逐字节相等）
        doc = self._assert_byte_equal(["--path", str(p_nocwd),
                                       "--machine-namespace", NS,
                                       "--source-profile", "explicit-profile",
                                       "--json", "-"])
        self.assertEqual(doc["coverage"]["fact_rows"], 1)
        self.assertEqual(doc["facts"][0]["source_profile"], "explicit-profile")


if __name__ == "__main__":
    unittest.main(verbosity=2)
