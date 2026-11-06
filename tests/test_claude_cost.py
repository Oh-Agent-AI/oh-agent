#!/usr/bin/env python3
"""Claude 会话账 fold（claude-sync）的锁步 + 语义钉测。

与 `src/agent/claude_cost.rs` 里同名 inline 测试互守——同一组 fixture 数字在
两侧各钉一遍（day 日线 / 基线替换 / 两态形状嗅探 / 哨兵 / 分月滚动），
docstring 互相指认；命令级差分由本文件的 `both()` 看守。

覆盖四件事：
  1. 纯函数：day_from_iso_ts / day_from_ms / _row_tokens / _camel_entry_tokens /
     _apply_record / _rebuild_days——与 Rust inline 测试同 fixture 同期望值。
  2. 差分：同一批真实格式会话文件（全形 + 5 键子集 + 短键三态 usage、cost-state
     基线、跨月归档日）→ Python 与 Rust（`--shadow`）各折进独立 HOME，state
     文件逐字节相等（archived_at 掩码），stdout 逐字节相等。
  3. 幂等 + 尾读续折：同批文件重跑 → 零变化；append 行后重跑 → resumed 且只
     折增量，两边各自逐字节相等。
  4. fencing：owner=rust 时 Python 拒绝（exit 2）、owner=python 时 Rust 拒绝
     （exit 2，`--shadow` 放行）——与 oneline 同款写者纪律。

运行方式（AGENT_VITALS_BIN 必须是**绝对路径**——CI 契约 verify.yml）：
  AGENT_VITALS_BIN=$PWD/target/release/agent-vitals python3 -m unittest tests.test_claude_cost
没设 AGENT_VITALS_BIN 时差分类整个跳过（只有一个实现，无从比对），纯函数钉测
照跑（它们不依赖 Rust）。
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "packages" / "agent-vitals-python"))
from agent_vitals.agent import claude_cost as cc  # noqa: E402

_BJ = timezone(timedelta(hours=8))


def _today_bj():
    return datetime.now(_BJ).strftime("%Y-%m-%d")


def _prev_month():
    now = datetime.now(_BJ)
    y, m = (now.year - 1, 12) if now.month == 1 else (now.year, now.month - 1)
    return "%04d-%02d" % (y, m)


def _bj_ms(y, mo, d, hh=4):
    return int(datetime(y, mo, d, hh, 0, 0, tzinfo=_BJ).timestamp() * 1000)


_BIN = os.environ.get("AGENT_VITALS_BIN")
_BIN = str(Path(_BIN).resolve()) if _BIN else None
PY_CMD = [sys.executable, str(ROOT / "scripts" / "scan.py")]


# ────────────────────────── 纯函数钉测（与 Rust inline 互守） ─────────────────


class DayFromIsoTsCase(unittest.TestCase):
    """Rust `day_from_iso_ts_*` 三测同 fixture 同期望。"""

    def test_beijing_dayline(self):
        self.assertEqual(cc.day_from_iso_ts("2026-08-30T10:16:26.965Z"), "2026-08-30")
        self.assertEqual(cc.day_from_iso_ts("2026-08-30T20:16:26.965Z"), "2026-08-31")
        self.assertEqual(cc.day_from_iso_ts("2026-08-30T16:00:00Z"), "2026-08-31")
        self.assertEqual(cc.day_from_iso_ts("2026-08-30T15:59:59Z"), "2026-08-30")
        self.assertEqual(cc.day_from_iso_ts("2026-08-30T20:16:00Z"), "2026-08-31")

    def test_calendar_edges(self):
        self.assertEqual(cc.day_from_iso_ts("2026-08-31T18:00:00Z"), "2026-09-01")
        self.assertEqual(cc.day_from_iso_ts("2026-12-31T17:00:00Z"), "2027-01-01")
        self.assertEqual(cc.day_from_iso_ts("2026-12-31T15:00:00Z"), "2026-12-31")
        # 闰日 2028-02-29 / 平年 2026-02-28
        self.assertEqual(cc.day_from_iso_ts("2028-02-29T17:00:00Z"), "2028-03-01")
        self.assertEqual(cc.day_from_iso_ts("2026-02-28T17:00:00Z"), "2026-03-01")
        self.assertEqual(cc.day_from_iso_ts("2026-02-28T15:00:00Z"), "2026-02-28")

    def test_rejects_non_z_and_garbage(self):
        self.assertIsNone(cc.day_from_iso_ts("2026-08-30T10:16:26.965+00:00"))
        self.assertIsNone(cc.day_from_iso_ts("2026-13-01T10:00:00Z"))
        self.assertIsNone(cc.day_from_iso_ts("2026-08-32T10:00:00Z"))
        self.assertIsNone(cc.day_from_iso_ts("2026-08-30T24:00:00Z"))
        self.assertIsNone(cc.day_from_iso_ts("2026-08-30T10:00:00"))
        self.assertIsNone(cc.day_from_iso_ts("not-a-timestamp"))
        self.assertIsNone(cc.day_from_iso_ts(""))


class DayFromMsCase(unittest.TestCase):
    """Rust `day_from_ms_beijing` 同 fixture 同期望（真值，别手算 epoch）。"""

    def test_beijing(self):
        self.assertEqual(cc.day_from_ms(1_788_084_986_000), "2026-08-30")
        self.assertEqual(cc.day_from_ms(1_788_112_800_000), "2026-08-31")
        self.assertEqual(cc.day_from_ms(0), "1970-01-01")


class ShapeSniffCase(unittest.TestCase):
    """Rust `row_tokens_accepts_both_shapes_and_sentinels` 同 fixture（P0）。"""

    def test_full_api_shape_first(self):
        full = {"input_tokens": 100, "cache_read_input_tokens": 200,
                "cache_creation_input_tokens": 300, "output_tokens": 400,
                "inference_geo": "xx", "iterations": 1}
        self.assertEqual(cc._row_tokens(full), [100, 200, 300, 400])

    def test_subset_and_short_key_shapes(self):
        subset = {"input_tokens": 5, "cache_read_input_tokens": 6,
                  "cache_creation_input_tokens": 7, "output_tokens": 8,
                  "service_tier": "low"}
        self.assertEqual(cc._row_tokens(subset), [5, 6, 7, 8])
        short = {"input": 10, "cache_read": 20, "cache_creation": 30,
                 "output": 40}
        self.assertEqual(cc._row_tokens(short), [10, 20, 30, 40])

    def test_unknown_shape_sentinel(self):
        self.assertIsNone(cc._row_tokens({"prompt_tokens": 1}))
        self.assertIsNone(cc._row_tokens(
            {"input_tokens": 1, "cache_read_input_tokens": 2,
             "cache_creation_input_tokens": 3, "output_tokens": "oops"}))
        self.assertIsNone(cc._row_tokens({}))

    def test_camel_entry_converts_cost_state(self):
        entry = {"inputTokens": 12646741, "outputTokens": 6111069,
                 "cacheReadInputTokens": 731886848,
                 "cacheCreationInputTokens": 0,
                 "webSearchRequests": 3, "costUSD": 581.98}
        self.assertEqual(cc._camel_entry_tokens(entry),
                         [12646741, 731886848, 0, 6111069])
        self.assertIsNone(cc._camel_entry_tokens({"inputTokens": 1}))


class FoldSemanticsCase(unittest.TestCase):
    """Rust `baseline_is_reconciliation_anchor_not_a_day_dump` /
    `cost_state_mid_file…` / `no_cost_state…` / `unparseable…` /
    `rebuild_partitions…` 同 fixture。

    v0.6.x 前置热修（归日转正 + 残差哨兵，2026-09-03）：这些用例此前钉的是
    "cost-state 一来就清 tail_days、把累计塞进 baseline_day 一天"的旧算法
    ——那正是真机对账揪出的日归因 bug 的根源（跨午夜会话的当日消费被整段
    错记到起始日）。新算法下 `tail_days` 只增不清、`baseline_day` 不存在，
    `baseline` 只做对账锚，差值进 `_rebuild_days` 返回的 `unaccounted`。"""

    def _cs(self, day_ms):
        return {"type": "cost-state",
                "timestamp": "2026-08-30T18:00:00.000Z",
                "startTime": day_ms,
                "modelUsage": {
                    "deepseek-v4-flash": {
                        "inputTokens": 1000, "outputTokens": 100,
                        "cacheReadInputTokens": 0,
                        "cacheCreationInputTokens": 0,
                        "webSearchRequests": 0, "costUSD": 0.1}},
                "hasUnknownModelCost": True}

    def _row(self, ts="2026-08-30T19:00:00.000Z", n=10):
        return {"type": "assistant", "timestamp": ts,
                "message": {"model": "deepseek-v4-flash", "usage": {
                    "input_tokens": n, "cache_read_input_tokens": 0,
                    "cache_creation_input_tokens": 0, "output_tokens": 1}}}

    def test_baseline_is_reconciliation_anchor_not_a_day_dump(self):
        # 新算法钉测（取代旧的"do_not_double_count"）：cost-state 只更新
        # baseline，不再清 tail_days、不再造 baseline_day——中间那条行在两次
        # 基线之间原样留在 tail_days 里，日期是它自己 ts 算出来的（08-31，
        # 19Z≥16 进位），不是被吞掉也不是被摊给某一天。
        sess = {}
        for rec in (self._cs(1_788_084_986_000), self._row(), self._cs(1_788_084_986_000)):
            cc._apply_record(sess, rec,
                     native_session_id="test",
                     machine_namespace="test-ns",
                     source_profile="default")
        self.assertEqual(
            sess["baseline"]["deepseek-v4-flash"]["input_tokens"], 1000)
        self.assertNotIn("baseline_day", sess)
        self.assertEqual(
            sess["tail_days"]["2026-08-31"]["deepseek-v4-flash"]["input_tokens"], 10)
        self.assertNotIn("unattributed_rows", sess)
        self.assertNotIn("unreadable_usage_rows", sess)
        # 对账：基线 1000 > 行和 10 → 差值 990 是残差，不体现在 tail_days 里
        # （这里只钉会话状态；残差计算在 _rebuild_days，下面单独测）。
        ledger, archive, unaccounted = cc._rebuild_days({"s1": sess}, "2026-08")
        self.assertEqual(
            ledger["2026-08-31"]["deepseek-v4-flash"]["input_tokens"], 10)
        self.assertEqual(
            unaccounted["deepseek-v4-flash"]["input_tokens"], 990)

    def test_baseline_start_time_and_tail_rows_by_day(self):
        # Rust `cost_state_mid_file_then_tail_rows_by_day` 同 fixture：
        # 三条行的 UTC ts 各自跨日：08-30T19Z→08-31、08-31T12Z→08-31（累 30）、
        # 08-31T20Z→09-01。基线本身不再落在任何一天——它只是对账锚。
        cs = {"type": "cost-state", "timestamp": "2026-08-30T11:00:00.000Z",
              # 1788084986000 ms = 2026-08-30T10:16:26Z → 北京 08-30
              "startTime": 1_788_084_986_000,
              "modelUsage": {"claude-opus-5": {
                  "inputTokens": 500, "outputTokens": 0,
                  "cacheReadInputTokens": 0, "cacheCreationInputTokens": 0,
                  "webSearchRequests": 0, "costUSD": 0.0}},
              "hasUnknownModelCost": False}
        sess = {}
        for rec in (cs, self._row("2026-08-30T19:00:00.000Z", 10),
                    self._row("2026-08-31T12:00:00.000Z", 20),
                    self._row("2026-08-31T20:00:00.000Z", 30)):
            cc._apply_record(sess, rec,
                     native_session_id="test",
                     machine_namespace="test-ns",
                     source_profile="default")
        self.assertNotIn("baseline_day", sess)
        self.assertEqual(sess["baseline"]["claude-opus-5"]["input_tokens"], 500)
        tail = sess["tail_days"]
        self.assertEqual(tail["2026-08-31"]["deepseek-v4-flash"]["input_tokens"], 30)
        self.assertEqual(tail["2026-09-01"]["deepseek-v4-flash"]["input_tokens"], 30)
        self.assertNotIn("2026-08-30", tail)
        self.assertEqual(len(tail), 2)
        # claude-opus-5 的基线在 tail_days 里零覆盖（所有行都是 deepseek-v4-flash）
        # → 500 全部是残差，不落在任何一天。
        ledger, archive, unaccounted = cc._rebuild_days({"s1": sess}, "2026-08")
        self.assertEqual(unaccounted["claude-opus-5"]["input_tokens"], 500)
        self.assertNotIn("claude-opus-5", ledger.get("2026-08-31", {}))

    def test_no_cost_state_session_is_row_sum(self):
        sess = {}
        cc._apply_record(sess, self._row("2026-08-31T10:00:00.000Z", 7),
                         native_session_id="test",
                         machine_namespace="test-ns",
                         source_profile="default")
        self.assertNotIn("baseline", sess)
        self.assertEqual(
            sess["tail_days"]["2026-08-31"]["deepseek-v4-flash"]
            ["cache_read_input_tokens"], 0)
        self.assertEqual(
            sess["tail_days"]["2026-08-31"]["deepseek-v4-flash"]["input_tokens"], 7)

    def test_sentinels_not_faked(self):
        sess = {}
        cc._apply_record(sess,
            {"type": "assistant",
             "timestamp": "bogus",
             "message": {"model": "deepseek-v4-flash",
                         "usage": {"input_tokens": 1,
                                   "cache_read_input_tokens": 0,
                                   "cache_creation_input_tokens": 0,
                                   "output_tokens": 0}}},
            native_session_id="test",
            machine_namespace="test-ns",
            source_profile="default")
        cc._apply_record(sess,
            {"type": "assistant",
             "timestamp": "2026-08-31T10:00:00.000Z",
             "message": {"model": "deepseek-v4-flash",
                         "usage": {"prompt_tokens": 5}}},
            native_session_id="test",
            machine_namespace="test-ns",
            source_profile="default")
        cc._apply_record(sess,
            {"type": "assistant",
             "timestamp": "2026-08-31T10:00:00.000Z",
             "message": {"usage": {"input_tokens": 1,
                                   "cache_read_input_tokens": 0,
                                   "cache_creation_input_tokens": 0,
                                   "output_tokens": 0}}},
            native_session_id="test",
            machine_namespace="test-ns",
            source_profile="default")
        self.assertEqual(sess["unattributed_rows"], 1)
        self.assertEqual(sess["unreadable_usage_rows"], 2)
        self.assertEqual(sess["tail_days"], {})

    def test_rebuild_partitions_current_month_and_merges_sessions(self):
        # Rust `rebuild_partitions…` 同 fixture：当前月=2026-09 → 08-31 滚归档。
        # s1 只有 baseline（无 tail_days 覆盖）→ 100 全部是残差，不进任何一天；
        # s2 的行 50 单独落 08-31（不再被 s1 的基线加成 150）；09-01 留 ledger。
        sessions = {
            "s1": {"size": 1, "mtime_ns": 1,
                   "baseline": {"deepseek-v4-flash": {
                       "input_tokens": 100, "cache_read_input_tokens": 0,
                       "cache_creation_input_tokens": 0, "output_tokens": 0}},
                   "tail_days": {}},
            "s2": {"size": 1, "mtime_ns": 1,
                   "tail_days": {"2026-08-31": {"deepseek-v4-flash": {
                       "input_tokens": 50, "cache_read_input_tokens": 0,
                       "cache_creation_input_tokens": 0, "output_tokens": 0}}}},
            "s3": {"size": 1, "mtime_ns": 1,
                   "tail_days": {"2026-09-01": {"claude-sonnet-5": {
                       "input_tokens": 20, "cache_read_input_tokens": 0,
                       "cache_creation_input_tokens": 0, "output_tokens": 0}}}},
        }
        ledger, archive, unaccounted = cc._rebuild_days(sessions, "2026-09")
        self.assertEqual(list(ledger), ["2026-09-01"])
        self.assertEqual(
            ledger["2026-09-01"]["claude-sonnet-5"]["input_tokens"], 20)
        self.assertEqual(list(archive), ["2026-08-31"])
        self.assertEqual(
            archive["2026-08-31"]["deepseek-v4-flash"]["input_tokens"], 50)
        self.assertEqual(unaccounted["deepseek-v4-flash"]["input_tokens"], 100)


class RealWorldMisattributionCase(unittest.TestCase):
    """v0.6.x 热修验收 fixture（spec §5 后段）：钉住 197.5M 归日 + 残差哨兵。

    真机对账（`docs/CLAUDE_COST_DAY_ATTRIBUTION_ANALYSIS.md` §5、§7）的
    2279b7b0 / 753e080a / b695a35f 三段实测，2026-09-02 北京日的 flash
    cache_read 总量。**真实回归**：旧算法下 197.5M flash cache_read 被错记
    到 cost-state 的 startTime 日（09-01 / 08-31），新算法下 rows 按真实 ts
    归日、baseline > 行和 的差额进 unaccounted。这条 fixture 把"197.5M"这个
    具体数字钉进回归套件，下次同类 bug 自动报警。

    同夹具同期望值在 `src/agent/claude_cost.rs::tests::real_world_*` 镜像
    （Rust inline 锁步，字节互守）。

    ms 约定：北京 09-01T00:00:00+08:00 = UTC 2026-08-31T16:00:00Z
    = epoch ms 1_788_192_000_000（北京 09-01 起点）；
    北京 09-01T12:00:00+08:00 = UTC 2026-09-01T04:00:00Z = 1_788_235_200_000
    （北京 09-01 中点）；北京 08-31T18:00:00+08:00 = UTC 2026-08-31T10:00:00Z
    = 1_788_170_400_000（北京 08-31 傍晚）。
    """

    @staticmethod
    def _cs(start_ms, cr_total):
        """cost-state 累计 baseline：flash cache_read_input_tokens = cr_total。

        其他 3 型 token 故意置 0，让 unaccounted 只来自 cache_read（与真机
        197.5M = flash cr 单一桶对齐）——其它型有残差也按同样规则进 unaccounted
        ，不在 fixture 里掺干扰信号。
        """
        return {"type": "cost-state",
                "timestamp": "2026-09-01T18:00:00.000Z",
                "startTime": start_ms,
                "modelUsage": {"deepseek-v4-flash": {
                    "inputTokens": 0, "outputTokens": 0,
                    "cacheReadInputTokens": cr_total,
                    "cacheCreationInputTokens": 0,
                    "webSearchRequests": 0, "costUSD": 0.0}},
                "hasUnknownModelCost": False}

    @staticmethod
    def _row(ts_z, cr):
        """assistant 行（09-02 ts 的 flash cache_read）。"""
        return {"type": "assistant", "timestamp": ts_z,
                "message": {"model": "deepseek-v4-flash", "usage": {
                    "input_tokens": 0, "cache_read_input_tokens": cr,
                    "cache_creation_input_tokens": 0, "output_tokens": 0}}}

    @staticmethod
    def _build_session(start_ms, cr_total, row_pairs):
        sess = {}
        recs = (RealWorldMisattributionCase._cs(start_ms, cr_total),) + \
               tuple(RealWorldMisattributionCase._row(t, c) for t, c in row_pairs)
        for rec in recs:
            cc._apply_record(sess, rec,
                     native_session_id="test",
                     machine_namespace="test-ns",
                     source_profile="default")
        return sess

    def test_2279b7b0_baseline_minus_tail_lands_in_unaccounted(self):
        # 2279b7b0: startTime 北京 09-01、baseline 38.7M、rows 5.7M（4 行 09-02）
        # 旧算法把 baseline 整段塞进 09-01：ledger["2026-09-01"][flash cr] = 33M（错）。
        # 新算法：rows 按真实 ts 归 09-02 = 5.7M；baseline - 行和 = 33M 进 unaccounted。
        start_0901_bj = 1_788_192_000_000
        rows = [
            ("2026-09-02T03:00:00.000Z", 1_500_000),
            ("2026-09-02T05:00:00.000Z", 1_500_000),
            ("2026-09-02T07:00:00.000Z", 1_500_000),
            ("2026-09-02T09:00:00.000Z", 1_200_000),
        ]
        sess = self._build_session(start_0901_bj, 38_700_000, rows)
        # baseline 不再进 baseline_day（v0.6.x 热修撤掉的那条旧路径）
        self.assertNotIn("baseline_day", sess)
        # tail_days["2026-09-02"] = 5.7M（按真实行 ts 归日，不是被吞掉也不是摊给某一天）
        self.assertEqual(
            sess["tail_days"]["2026-09-02"]["deepseek-v4-flash"]
            ["cache_read_input_tokens"], 5_700_000)
        # 残差 = baseline - 行和 = 38.7M - 5.7M = 33M（不在任何一天）
        ledger, archive, unaccounted = cc._rebuild_days({"s1": sess}, "2026-09")
        self.assertEqual(
            ledger["2026-09-02"]["deepseek-v4-flash"]
            ["cache_read_input_tokens"], 5_700_000)
        self.assertEqual(
            unaccounted["deepseek-v4-flash"]
            ["cache_read_input_tokens"], 33_000_000)
        # 旧算法的反向断言：09-01 / 08-31 都不该出现这条 session 的账
        self.assertNotIn("2026-09-01", ledger)
        self.assertNotIn("2026-08-31", ledger)
        self.assertEqual(archive, {})

    def test_753e080a_same_pattern_larger_volume(self):
        # 753e080a: startTime 北京 09-01、baseline 137.1M、rows 44.9M（8 行 09-02）
        # 同款归日 + 残差规律：tail_days[09-02] = 44.9M、unaccounted = 92.2M。
        start_0901_bj_mid = 1_788_235_200_000
        # 8 行均分 44.9M → 5_612_500 × 8 = 44_900_000。
        row_cr = 5_612_500
        rows = [("2026-09-02T%02d:00:00.000Z" % h, row_cr)
                for h in (3, 5, 7, 9, 11, 13, 14, 15)]
        sess = self._build_session(start_0901_bj_mid, 137_100_000, rows)
        self.assertEqual(
            sess["tail_days"]["2026-09-02"]["deepseek-v4-flash"]
            ["cache_read_input_tokens"], 44_900_000)
        ledger, _archive, unaccounted = cc._rebuild_days({"s1": sess}, "2026-09")
        self.assertEqual(
            ledger["2026-09-02"]["deepseek-v4-flash"]
            ["cache_read_input_tokens"], 44_900_000)
        self.assertEqual(
            unaccounted["deepseek-v4-flash"]
            ["cache_read_input_tokens"], 92_200_000)

    def test_b695a35f_baseline_startTime_08_31_no_day_bucket(self):
        # b695a35f: startTime 北京 08-31、baseline 88.3M、rows 16.0M（4 行 09-02）
        # 旧算法把 baseline 整段塞进 08-31：ledger["2026-08-31"][flash cr] = 72.3M（错）。
        # 新算法：rows 全部 09-02；baseline - 行和 = 72.3M 进 unaccounted；08-31 不出现。
        start_0831_bj_eve = 1_788_170_400_000
        rows = [
            ("2026-09-02T03:00:00.000Z", 4_000_000),
            ("2026-09-02T05:00:00.000Z", 4_000_000),
            ("2026-09-02T07:00:00.000Z", 4_000_000),
            ("2026-09-02T09:00:00.000Z", 4_000_000),
        ]
        sess = self._build_session(start_0831_bj_eve, 88_300_000, rows)
        ledger, _archive, unaccounted = cc._rebuild_days({"s1": sess}, "2026-09")
        self.assertEqual(
            ledger["2026-09-02"]["deepseek-v4-flash"]
            ["cache_read_input_tokens"], 16_000_000)
        self.assertEqual(
            unaccounted["deepseek-v4-flash"]
            ["cache_read_input_tokens"], 72_300_000)
        # 旧算法 bug 的反向断言：08-31 不应再有这条 session 的任何桶
        self.assertNotIn("2026-08-31", ledger)

    def test_three_sessions_combined_unaccounted_is_197_5M(self):
        # 三段实测合并：tail_days[09-02] = 5.7 + 44.9 + 16.0 = 66.6M cache_read
        # unaccounted = 33 + 92.2 + 72.3 = 197.5M cache_read ——spec §5 后段点名的
        # 真机验收数字，单测一旦回归立刻红。
        sessions = {
            "2279b7b0": self._build_session(1_788_192_000_000, 38_700_000, [
                ("2026-09-02T03:00:00.000Z", 1_500_000),
                ("2026-09-02T05:00:00.000Z", 1_500_000),
                ("2026-09-02T07:00:00.000Z", 1_500_000),
                ("2026-09-02T09:00:00.000Z", 1_200_000),
            ]),
            "753e080a": self._build_session(1_788_235_200_000, 137_100_000, [
                ("2026-09-02T03:00:00.000Z", 11_225_000),
                ("2026-09-02T05:00:00.000Z", 11_225_000),
                ("2026-09-02T07:00:00.000Z", 11_225_000),
                ("2026-09-02T09:00:00.000Z", 11_225_000),
            ]),
            "b695a35f": self._build_session(1_788_170_400_000, 88_300_000, [
                ("2026-09-02T03:00:00.000Z", 4_000_000),
                ("2026-09-02T05:00:00.000Z", 4_000_000),
                ("2026-09-02T07:00:00.000Z", 4_000_000),
                ("2026-09-02T09:00:00.000Z", 4_000_000),
            ]),
        }
        ledger, archive, unaccounted = cc._rebuild_days(sessions, "2026-09")
        # 合并后的 09-02 cache_read：5.7M + 44.9M + 16.0M = 66.6M
        self.assertEqual(
            ledger["2026-09-02"]["deepseek-v4-flash"]
            ["cache_read_input_tokens"], 66_600_000)
        # 合并残差：33M + 92.2M + 72.3M = 197.5M
        self.assertEqual(
            unaccounted["deepseek-v4-flash"]
            ["cache_read_input_tokens"], 197_500_000)
        # 旧算法 bug 反向断言：09-01 / 08-31 都不应出现这三个 session 的账
        self.assertNotIn("2026-09-01", ledger)
        self.assertNotIn("2026-08-31", ledger)
        self.assertEqual(archive, {})


# ────────────────────────── 差分：Python ↔ Rust（--shadow） ─────────────────

_TS_MASK = re.compile(r'"archived_at": "[^"]+"')


def _scrub_json_files_under(root: Path):
    """state 树逐文件读出来比较：archived_at ISO 掩码（两侧各用各的 now）。"""
    out = {}
    for p in sorted(root.rglob("*.json")):
        out[str(p.relative_to(root))] = _TS_MASK.sub(
            '"archived_at": "<TS>"', p.read_text(encoding="utf-8"))
    return out


def _write_session(d: Path, name: str, rows):
    d.mkdir(parents=True, exist_ok=True)
    (d / name).write_text("".join(json.dumps(r) + "\n" for r in rows),
                          encoding="utf-8")


def _env_for(fixture_home: Path, side_home: Path):
    env = dict(os.environ)
    env["HOME"] = str(fixture_home)
    env["USERPROFILE"] = str(fixture_home)
    env["AGENT_VITALS_HOME"] = str(side_home)
    env.pop("AGENT_VITALS_BIN", None)
    for adapter in ("CODEX_RUNTIME", "OPENCLAW_RUNTIME", "WORKBUDDY_BUILTINS"):
        env["AGENT_VITALS_DISABLE_" + adapter] = "1"
    env["AGENT_VITALS_DISABLE_OPENCLAW_BUNDLED"] = "1"
    return env


def _run(cmd, fixture_home, side_home):
    return subprocess.run(
        cmd, env=_env_for(fixture_home, side_home),
        capture_output=True, text=True, cwd=str(fixture_home))


@unittest.skipUnless(_BIN, "未设 AGENT_VITALS_BIN，跳过双实现比对")
class ClaudeSyncBothTests(unittest.TestCase):
    """claude-sync 生产者：Python mirror ↔ Rust 实现，同一批会话文件。"""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.fixture = self.tmp / "fixture"
        self.fixture.mkdir()
        self.sessions_dir = self.fixture / ".claude" / "projects" / "-proj-a"
        self._side_n = 0
        self._build_fixtures()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _build_fixtures(self):
        """三态 usage fixture + 基线 + 跨月归档 + 哨兵行（P0 两态都进语料）。

        月份安排：today 走「今天」（当前月 → ledger）；会话 1 有一条真实
        prev-month 时间戳的 assistant 行（必然跨月 → 归档，走 `tail_days`
        真实分辨率，不是靠 cost-state 基线摊到某一天——v0.6.x 前置热修后
        baseline 只是对账锚点，从不直接产生日面），行尾差一走在今天；
        cost-state 的 baseline（1000/100）与 tail_days 覆盖的行和（35/4）
        对不上，差额进 `unaccounted`（dateless 残差池），不是悄悄多算/漏算。
        会话 2 无 cost-state（纯行和）：短键旧形状 + 无 ts 行（unattributed）
        + 有 usage 无 model（unreadable）。
        """
        today = _today_bj()
        prev = _prev_month()
        y_m1, m_m1 = int(prev[:4]), int(prev[5:7])
        today_y, today_m, today_d = (int(today[:4]), int(today[5:7]),
                                     int(today[8:10]))
        # 会话 1：cost-state（对账锚点，1000/100，超过 tail_days 行和 → 差额
        # 进 unaccounted）→ 一条真实上月行（真正的归档来源）→ 两条今天行。
        rows1 = [
            {"type": "cost-state",
             "timestamp": "%s-15T00:00:00.000Z" % prev,
             "startTime": _bj_ms(y_m1, m_m1, 15),
             "modelUsage": {"deepseek-v4-flash": {
                 "inputTokens": 1000, "outputTokens": 100,
                 "cacheReadInputTokens": 0, "cacheCreationInputTokens": 0,
                 "webSearchRequests": 0, "costUSD": 0.0}},
             "hasUnknownModelCost": False},
            {"type": "assistant", "timestamp": "%s-20T03:00:00.000Z" % prev,
             "message": {"model": "deepseek-v4-flash", "usage": {
                 "input_tokens": 5, "cache_read_input_tokens": 0,
                 "cache_creation_input_tokens": 0, "output_tokens": 1}}},
            {"type": "assistant", "timestamp": "%sT02:00:00.000Z" % today,
             "message": {"model": "deepseek-v4-flash", "usage": {
                 "input_tokens": 10, "cache_read_input_tokens": 0,
                 "cache_creation_input_tokens": 0, "output_tokens": 1}}},
            # 5 键子集（753e080a 真机形态：装饰键缺席、计数键齐全）。
            {"type": "assistant", "timestamp": "%sT05:00:00.000Z" % today,
             "message": {"model": "deepseek-v4-flash", "usage": {
                 "input_tokens": 20, "cache_read_input_tokens": 0,
                 "cache_creation_input_tokens": 0, "output_tokens": 2,
                 "service_tier": "low"}}},
        ]
        _write_session(self.sessions_dir, "sess1.jsonl", rows1)
        # 会话 2：无 cost-state → 纯行和。短键旧形状行（真机 0 命中仍认）、
        # 无 ts 行、有 usage 无 model 行、两态皆无行。
        rows2 = [
            {"type": "assistant", "timestamp": "%sT01:00:00.000Z" % today,
             "message": {"model": "claude-sonnet-5",
                         "usage": {"input": 5, "cache_read": 6,
                                   "cache_creation": 7, "output": 8}}},
            {"type": "assistant", "timestamp": "bogus",
             "message": {"model": "deepseek-v4-flash", "usage": {
                 "input_tokens": 9, "cache_read_input_tokens": 0,
                 "cache_creation_input_tokens": 0, "output_tokens": 0}}},
            {"type": "assistant", "timestamp": "%sT03:00:00.000Z" % today,
             "message": {"usage": {"input_tokens": 1,
                                   "cache_read_input_tokens": 0,
                                   "cache_creation_input_tokens": 0,
                                   "output_tokens": 0}}},
            {"type": "assistant", "timestamp": "%sT04:00:00.000Z" % today,
             "message": {"model": "deepseek-v4-flash",
                         "usage": {"prompt_tokens": 3}}},
        ]
        _write_session(self.sessions_dir, "sess2.jsonl", rows2)
        # 会话 3：纯 ts 行 + 未知模型（claude-opus-5 卡外模型也照记 token，
        # 计价面在读取时才判 unpriced——fold 层从不丢桶）。
        _write_session(self.sessions_dir, "sess3.jsonl", [
            {"type": "assistant", "timestamp": "%sT06:00:00.000Z" % today,
             "message": {"model": "anthropic/claude-opus-5", "usage": {
                 "input_tokens": 30, "cache_read_input_tokens": 0,
                 "cache_creation_input_tokens": 0, "output_tokens": 3}}},
            # 2026-09-06 真机对账挖出的去重回归（message.id 重复行）：同一条
            # 已完成消息（同一 message.id）在真机 session 文件里出现 4 次、
            # usage 字段逐字节相同——旧算法无条件累加，claude-ledger.json 因此
            # 高估约 2 倍。这里钉一个最小复现：msg_dedup_a 出现 3 次（只应计
            # 一次）+ msg_dedup_b 出现 1 次（不同消息，必须单独计入）。
            {"type": "assistant", "timestamp": "%sT07:00:00.000Z" % today,
             "message": {"id": "msg_dedup_a", "model": "claude-haiku-test",
                         "usage": {
                             "input_tokens": 100, "cache_read_input_tokens": 0,
                             "cache_creation_input_tokens": 0, "output_tokens": 10}}},
            {"type": "assistant", "timestamp": "%sT07:00:01.000Z" % today,
             "message": {"id": "msg_dedup_a", "model": "claude-haiku-test",
                         "usage": {
                             "input_tokens": 100, "cache_read_input_tokens": 0,
                             "cache_creation_input_tokens": 0, "output_tokens": 10}}},
            {"type": "assistant", "timestamp": "%sT07:00:02.000Z" % today,
             "message": {"id": "msg_dedup_a", "model": "claude-haiku-test",
                         "usage": {
                             "input_tokens": 100, "cache_read_input_tokens": 0,
                             "cache_creation_input_tokens": 0, "output_tokens": 10}}},
            {"type": "assistant", "timestamp": "%sT07:00:03.000Z" % today,
             "message": {"id": "msg_dedup_b", "model": "claude-haiku-test",
                         "usage": {
                             "input_tokens": 100, "cache_read_input_tokens": 0,
                             "cache_creation_input_tokens": 0, "output_tokens": 10}}},
        ])

    def _fresh_side(self, tag):
        # 同 tag 多次调用（幂等重跑）不能撞目录——每次唯一。
        side = self.tmp / ("side-%s-%d" % (tag, self._side_n))
        self._side_n += 1
        side.mkdir()
        return side

    def _sync(self, tag, extra=()):
        side = self._fresh_side(tag)
        return self._sync_into(side, tag, extra)

    def _sync_into(self, side, tag, extra=()):
        """重跑进**同一个** state 目录（幂等 / 尾读续折都要跨调用状态）。"""
        if tag == "py":
            cmd = PY_CMD + ["claude-sync"] + list(extra)
        else:
            cmd = [_BIN, "claude-sync"] + list(extra)
        r = _run(cmd, self.fixture, side)
        return side, r

    def test_python_rust_state_and_stdout_byte_equal(self):
        """同一批会话文件：两侧折进独立 HOME，state 文件逐字节相等（archived_at
        掩码）、stdout 逐字节相等。"""
        py_side, py_r = self._sync("py")
        rs_side, rs_r = self._sync("rs", ["--shadow"])
        self.assertEqual(py_r.returncode, 0, py_r.stderr)
        self.assertEqual(rs_r.returncode, 0, rs_r.stderr)
        self.assertEqual(py_r.stdout, rs_r.stdout,
                         "claude-sync stdout 不一致：\npy:\n%s\nrs:\n%s"
                         % (py_r.stdout, rs_r.stdout))
        got_py = _scrub_json_files_under(py_side)
        got_rs = _scrub_json_files_under(rs_side)
        self.assertEqual(set(got_py), set(got_rs))
        for rel, text in got_rs.items():
            self.assertEqual(got_py[rel], text, "state %s 逐字节不一致" % rel)
        # 语义抽查：真实上月行落归档，今天行落 ledger，baseline 超出 tail_days
        # 行和的差额落 unaccounted（v0.6.x 前置热修：baseline 不再摊到某一天）。
        ledger = json.loads(got_rs["state/claude-ledger.json"])
        self.assertIn(_today_bj(), ledger["days"])
        archive = json.loads(got_rs["state/claude-ledger-archive.json"])
        self.assertIn(_prev_month(), archive["months"])
        self.assertEqual(
            ledger["unaccounted"]["deepseek-v4-flash"]["input_tokens"], 965,
            "baseline 1000 − tail_days 行和 35（上月 5 + 今天 10+20）")
        self.assertEqual(
            ledger["unaccounted"]["deepseek-v4-flash"]["output_tokens"], 96,
            "baseline 100 − tail_days 行和 4（上月 1 + 今天 1+2）")
        # message.id 去重（2026-09-06 真机 bug）：sess3 里 msg_dedup_a 出现
        # 3 次（只计一次）+ msg_dedup_b 出现 1 次（不同消息，单独计入）——
        # 期望 input_tokens = 100*2 = 200，不是 100*4 = 400。两个 sentinel
        # 计数都要对：duplicate_usage_rows = 2（msg_dedup_a 的第 2、3 次）。
        haiku = ledger["days"][_today_bj()]["claude-haiku-test"]
        self.assertEqual(haiku["input_tokens"], 200,
                         "重复 message.id 不能被无条件累加；got %r" % haiku)
        self.assertEqual(haiku["output_tokens"], 20)
        self.assertIn("duplicate usage rows: 2", py_r.stdout)
        self.assertIn("duplicate usage rows: 2", rs_r.stdout)
        fold_rs = json.loads(got_rs["state/claude-fold.json"])
        self.assertEqual(
            fold_rs["sessions"]["sess3"]["duplicate_usage_rows"], 2)
        self.assertEqual(
            sorted(fold_rs["sessions"]["sess3"]["seen_event_ids"]),
            ["msg_dedup_a", "msg_dedup_b"])

    def test_idempotent_rerun_and_tail_resume(self):
        """重跑零变化（exactly-once）；append 一行后重跑 → resumed 且只折增量，
        两侧结果仍逐字节相等。"""
        py_side, py_r = self._sync("py")
        rs_side, rs_r = self._sync("rs", ["--shadow"])
        py_state1 = _scrub_json_files_under(py_side)
        rs_state1 = _scrub_json_files_under(rs_side)
        # 归档首写的 archived_at 原样留着（下面断言重跑不改它——得是原始字节）。
        py_archive1 = (py_side / "state" / "claude-ledger-archive.json").read_bytes()
        rs_archive1 = (rs_side / "state" / "claude-ledger-archive.json").read_bytes()
        # 幂等：同批文件折进同一个 state 目录再跑 → 摘要 folded 0 / skipped 3
        # （不是再 new 一遍——exactly-once），状态逐字节不变。
        _, py_r2 = self._sync_into(py_side, "py")
        self.assertIn("skipped 3", py_r2.stdout)
        self.assertIn("folded 0 (new 0, resumed 0)", py_r2.stdout)
        self.assertEqual(_scrub_json_files_under(py_side), py_state1,
                         "python 幂等重跑后状态变了")
        _, rs_r2 = self._sync_into(rs_side, "rs", ["--shadow"])
        self.assertIn("skipped 3", rs_r2.stdout)
        self.assertIn("folded 0 (new 0, resumed 0)", rs_r2.stdout)
        self.assertEqual(_scrub_json_files_under(rs_side), rs_state1,
                         "rust 幂等重跑后状态变了")
        # 归档零变化重跑**不重写**（不打码逐字节比较）：archived_at 保留首写
        # 时刻。真机冻结语料复跑抓到旧实现每轮给当月盖新 now → 文件每轮都变。
        self.assertEqual(
            (py_side / "state" / "claude-ledger-archive.json").read_bytes(),
            py_archive1, "python 归档在零变化重跑后被重写了")
        self.assertEqual(
            (rs_side / "state" / "claude-ledger-archive.json").read_bytes(),
            rs_archive1, "rust 归档在零变化重跑后被重写了")
        # 尾读续折：sess1 append 一行（size 变、mtime 变）→ 同目录再跑 resumed。
        p = self.sessions_dir / "sess1.jsonl"
        with p.open("a", encoding="utf-8") as f:
            f.write(json.dumps({
                "type": "assistant",
                "timestamp": "%sT07:00:00.000Z" % _today_bj(),
                "message": {"model": "deepseek-v4-flash", "usage": {
                    "input_tokens": 40, "cache_read_input_tokens": 0,
                    "cache_creation_input_tokens": 0, "output_tokens": 4}}}) + "\n")
        _, py_r3 = self._sync_into(py_side, "py")
        _, rs_r3 = self._sync_into(rs_side, "rs", ["--shadow"])
        self.assertIn("resumed 1", py_r3.stdout)
        self.assertEqual(py_r3.stdout, rs_r3.stdout)
        # 增量只落 tail_days[sid][today]，基线不动。
        fold_py = json.loads(
            (py_side / "state" / "claude-fold.json").read_text(encoding="utf-8"))
        self.assertEqual(
            fold_py["sessions"]["sess1"]["tail_days"][_today_bj()]
            ["deepseek-v4-flash"]["input_tokens"], 70)  # 10 + 20 + 40
        self.assertEqual(fold_py["sessions"]["sess1"]["baseline"]
                         ["deepseek-v4-flash"]["input_tokens"], 1000)
        # 两侧最终态逐字节相等（含 fold.json 的 mtime_ns——同一批文件）。
        self.assertEqual(_scrub_json_files_under(py_side),
                         _scrub_json_files_under(rs_side))

    def test_fencing_both_sides(self):
        """owner=python 时 Rust 拒绝（exit 2、--shadow 放行）；owner=rust 时
        Python 拒绝（exit 2、--shadow 放行）。写者纪律与 oneline 同款。"""
        # 默认（无 machine.json）owner=python → Rust 不带 --shadow 拒。
        rs_side = self._fresh_side("rs")
        r = _run([_BIN, "claude-sync"], self.fixture, rs_side)
        self.assertEqual(r.returncode, 2)
        self.assertIn("writer fencing", r.stderr)
        # 手动 cutover 成 rust → Python 不带 --shadow 拒。owner 住在
        # state/writer-manifest.json（machine.json 只管 machine_namespace——
        # 根目录那个文件写 owner 是记错层，Rust/Python 都不读它做 fencing）。
        py_side = self._fresh_side("py")
        (py_side / "state" / "writer-manifest.json").parent.mkdir(parents=True)
        (py_side / "state" / "writer-manifest.json").write_text(json.dumps({
            "schema_version": "1.0.0", "owner": "rust", "epoch": 1}),
            encoding="utf-8")
        r = _run(PY_CMD + ["claude-sync"], self.fixture, py_side)
        self.assertEqual(r.returncode, 2)
        self.assertIn("writer fencing", r.stderr)
        # --shadow 演练都放行且字节一致。
        rs_side2, rs_ok = self._sync("rs", ["--shadow"])
        py_side2, py_ok = self._sync("py", ["--shadow"])
        self.assertEqual(py_ok.returncode, 0, py_ok.stderr)
        self.assertEqual(rs_ok.returncode, 0, rs_ok.stderr)
        self.assertEqual(_scrub_json_files_under(py_side2),
                         _scrub_json_files_under(rs_side2))

    def test_real_world_197_5M_misattribution_byte_equal(self):
        """v0.6.x 热修验收 fixture 端到端（spec §5 后段）：2279b7b0/753e080a/
        b695a35f 三段实测真机数字 → Python 与 Rust 各自独立跑 claude-sync →
        state 文件字节相等、66.6M / 197.5M 在 ledger.days / unaccounted 各
        自正确归位。

        fixture 与 RealWorldMisattributionCase 同源（2279/753e/b695 + 38.7M
        /5.7M/33M 等真机数字），但本测试走完整 I/O 路径（写 JSONL → claude-sync
        → 读 ledger.json），把 inline 测试证过的算法放进真实流水线再守一遍。
        """
        # 把 3 个会话写在同一个 fixture dir（setUp 已建 .claude/projects/-proj-a）
        # —— startTime 与 RealWorldMisattributionCase 一致（ms 约定见该 docstring）。
        start_0901_bj = 1_788_192_000_000
        start_0901_bj_mid = 1_788_235_200_000
        start_0831_bj_eve = 1_788_170_400_000
        # 2279b7b0：baseline 38.7M、4 行 09-02 各 1.5/1.5/1.5/1.2M = 5.7M
        sess_2279 = [
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
             "message": {"model": "deepseek-v4-flash", "usage": {
                 "input_tokens": 0, "cache_read_input_tokens": 1_500_000,
                 "cache_creation_input_tokens": 0, "output_tokens": 0}}},
            {"type": "assistant", "timestamp": "2026-09-02T05:00:00.000Z",
             "message": {"model": "deepseek-v4-flash", "usage": {
                 "input_tokens": 0, "cache_read_input_tokens": 1_500_000,
                 "cache_creation_input_tokens": 0, "output_tokens": 0}}},
            {"type": "assistant", "timestamp": "2026-09-02T07:00:00.000Z",
             "message": {"model": "deepseek-v4-flash", "usage": {
                 "input_tokens": 0, "cache_read_input_tokens": 1_500_000,
                 "cache_creation_input_tokens": 0, "output_tokens": 0}}},
            {"type": "assistant", "timestamp": "2026-09-02T09:00:00.000Z",
             "message": {"model": "deepseek-v4-flash", "usage": {
                 "input_tokens": 0, "cache_read_input_tokens": 1_200_000,
                 "cache_creation_input_tokens": 0, "output_tokens": 0}}},
        ]
        _write_session(self.sessions_dir, "sess-2279b7b0.jsonl", sess_2279)
        # 753e080a：baseline 137.1M、4 行 09-02 各 11.225M = 44.9M
        sess_753e = [
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
               "message": {"model": "deepseek-v4-flash", "usage": {
                   "input_tokens": 0, "cache_read_input_tokens": 11_225_000,
                   "cache_creation_input_tokens": 0, "output_tokens": 0}}}
              for h in (3, 5, 7, 9)],
        ]
        _write_session(self.sessions_dir, "sess-753e080a.jsonl", sess_753e)
        # b695a35f：baseline 88.3M、4 行 09-02 各 4.0M = 16.0M
        sess_b695 = [
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
               "message": {"model": "deepseek-v4-flash", "usage": {
                   "input_tokens": 0, "cache_read_input_tokens": 4_000_000,
                   "cache_creation_input_tokens": 0, "output_tokens": 0}}}
              for h in (3, 5, 7, 9)],
        ]
        _write_session(self.sessions_dir, "sess-b695a35f.jsonl", sess_b695)

        # 两侧独立 sync 到各自 side：Python 走真作者、Rust 走 --shadow（fencing 放行）。
        py_side, py_r = self._sync("py")
        rs_side, rs_r = self._sync("rs", ["--shadow"])
        self.assertEqual(py_r.returncode, 0, py_r.stderr)
        self.assertEqual(rs_r.returncode, 0, rs_r.stderr)
        # state 文件逐字节相等（archived_at 掩码）。
        got_py = _scrub_json_files_under(py_side)
        got_rs = _scrub_json_files_under(rs_side)
        self.assertEqual(set(got_py), set(got_rs))
        for rel, text in got_rs.items():
            self.assertEqual(got_py[rel], text, "state %s 逐字节不一致" % rel)
        # 固定九月 fixture 会随真实月份推进进入归档；不能把“已归档”误判为丢失。
        # 关键数字：66.6M 落 2026-09-02 日桶、197.5M 落 unaccounted。
        ledger = json.loads(got_rs["state/claude-ledger.json"])
        observed_days = dict(ledger["days"])
        archive = json.loads(got_rs.get("state/claude-ledger-archive.json", "{}"))
        for month in archive.get("months", {}).values():
            observed_days.update(month.get("days", {}))
        self.assertEqual(
            observed_days["2026-09-02"]["deepseek-v4-flash"]
            ["cache_read_input_tokens"], 66_600_000,
            "5.7 + 44.9 + 16.0 = 66.6M cache_read 正确归 09-02")
        self.assertEqual(
            ledger["unaccounted"]["deepseek-v4-flash"]
            ["cache_read_input_tokens"], 197_500_000,
            "33 + 92.2 + 72.3 = 197.5M cache_read 残差池（spec §5 后段点名数字）")
        # 旧算法 bug 反向断言：09-01 / 08-31 都不应出现这三个 session 的任何桶。
        self.assertNotIn("2026-09-01", observed_days)
        self.assertNotIn("2026-08-31", observed_days)


if __name__ == "__main__":
    unittest.main()


class OverrideCardCacheWriteDimension(unittest.TestCase):
    """用户补的中转卡可带第四维 `cache_write {off_peak, peak}`（2026-09-17：胜算云把所有
    非命中输入记作"写入"，gpt-5.6-sol 的写入占那笔钱的 43%）。带 → 与其他三维同一峰谷
    读法；不带 → catalog 平费率（覆盖卡没有 → 0）。与 Rust
    `override_card_cache_write_dimension_prices_cache_creation_tokens` 同数字。"""

    def test_cache_write_dimension_prices_cache_creation_tokens(self):
        from agent_vitals.agent.cost import claude_day_cost, load_pricing
        pricing = load_pricing()
        day = {"openai/gpt-5.6-sol": {
            "input_tokens": 0, "cache_read_input_tokens": 1_000_000,
            "cache_creation_input_tokens": 1_000_000, "output_tokens": 100_000}}
        card = {
            "input_uncached": {"off_peak": 29.310, "peak": 29.310},
            "input_cached": {"off_peak": 2.343, "peak": 2.343},
            "output": {"off_peak": 140.885, "peak": 140.885},
        }
        pricing["providers"]["shengsuanyun"]["models"]["gpt-5.6-sol"] = dict(card)
        without = claude_day_cost(day, pricing)["per_model"]["openai/gpt-5.6-sol"]["total"]
        self.assertAlmostEqual(without, 2.343 + 14.0885, places=9)
        card["cache_write"] = {"off_peak": 29.310, "peak": 29.310}
        pricing["providers"]["shengsuanyun"]["models"]["gpt-5.6-sol"] = card
        with_ = claude_day_cost(day, pricing)["per_model"]["openai/gpt-5.6-sol"]
        self.assertAlmostEqual(with_["total"], 2.343 + 29.310 + 14.0885, places=9)
        self.assertEqual(with_["currency"], "CNY")
