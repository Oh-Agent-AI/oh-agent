#!/usr/bin/env python3
"""Python 状态 merge 链（`agent_vitals.agent.state`）的字符化锁步测试（R1c）。

`StateMergeCharacterization` —— 把 Python 侧 `merge_today` / `merge_month` 的
输出钉到**具体数值**，与 `crates/agent-vitals-domain/src/domain/state.rs` 里
单测的期望值逐一对应（test_cost_priced_day 同款交叉锁定模式）：Python 与 Rust
各自断言同一组数字，docstring 互相指认。纯合并规则仍是 single source of truth，
只是 v0.9.1 Stage 5b 起不再被运行时 tick 写盘（业务账由 SQL 权威库管理）。

历史备注：曾有一层 `StateWriteChainDiff` 做 Python `state.py` 与
Rust `agent-vitals state merge-today/merge-month/write-alert/snooze` 子命令的
逐字节差分。v0.9.1 Stage 5b（commit 4c0fba9）退役了那些 Rust 子命令——DSH
tick 只产导航快照，today/month/alert/budget 的账统一由 SQL 权威库产生和读取——
差分对端不复存在，该层随之删除。Python 兼容 CLI（ClawHub）仍写这些历史文件，
覆盖在 `test_state.py` / `test_state_history_rotate.py` / `test_budget.py`。

跑法：
    python3 -m unittest tests.test_state_write_chain -v
"""

import contextlib
import os
import shutil
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "packages" / "agent-vitals-python"))

from agent_vitals.agent import state as state_mod  # noqa: E402

_BJ = timezone(timedelta(hours=8))

# 8 桶字段 —— 与 core/state.rs 的 BUCKET_FIELDS 同清单。
BUCKET_FIELDS = (
    "uncached_input_tokens", "output_tokens",
    "cache_read_tokens", "cache_write_tokens",
    "peak_uncached_input_tokens", "peak_output_tokens",
    "peak_cache_read_tokens", "peak_cache_write_tokens",
)


def _zero_bucket():
    return {f: 0 for f in BUCKET_FIELDS}


def bj_now():
    return datetime.now(_BJ)


def today_str():
    return bj_now().strftime("%Y-%m-%d")


class StateMergeCharacterization(unittest.TestCase):
    """Python 侧 merge 的具体数值 —— 与 core/state.rs 的单测期望值对守。

    同一份夹具、同一组数字，Python 这里断言、Rust `#[cfg(test)]` 断言，docstring
    互相指认。改数字 = 两边一起改，任何一边单独漂移都会让另一侧失去参照。
    """

    @contextlib.contextmanager
    def _py_home(self):
        home = Path(tempfile.mkdtemp())
        prev = os.environ.get("AGENT_VITALS_HOME")
        os.environ["AGENT_VITALS_HOME"] = str(home)
        try:
            yield
        finally:
            shutil.rmtree(home, ignore_errors=True)
            if prev is None:
                os.environ.pop("AGENT_VITALS_HOME", None)
            else:
                os.environ["AGENT_VITALS_HOME"] = prev

    def test_merge_today_accumulates_same_hour(self):
        today = today_str()
        hb = {"buckets": [
            {"date": today, "hour": 9, "uncached_input_tokens": 100},
            {"date": today, "hour": 9, "uncached_input_tokens": 50},
        ]}
        model = "deepseek-v4-flash"
        bm = {model: dict(_zero_bucket(), uncached_input_tokens=150)}
        with self._py_home():
            state_mod.merge_today(hb, by_model=bm)
            f = state_mod._read(state_mod.state_dir() / "today.json")
            self.assertEqual(f["buckets"]["9"]["uncached_input_tokens"], 150)
            self.assertEqual(f["by_model"][model]["uncached_input_tokens"], 150)
            self.assertEqual(f["date"], today)

    def test_merge_month_accumulates_fields(self):
        """`merge_buckets` 逐字段相加：现有值 + 新值，不是覆盖。"""
        today = today_str()
        hb = {"buckets": [{"date": today, "hour": 9, "uncached_input_tokens": 7}]}
        bdm = {today: {"deepseek-v4-flash": dict(_zero_bucket(),
                                                 uncached_input_tokens=7)}}
        with self._py_home():
            state_mod.merge_month(hb, by_date_model=bdm)
            f = state_mod._read(state_mod.state_dir() / "month.json")
            day = f["days"][today]
            self.assertEqual(day["uncached_input_tokens"], 7)
            self.assertEqual(day["output_tokens"], 0)
            self.assertEqual(day["by_model"]["deepseek-v4-flash"]["uncached_input_tokens"], 7)

    def test_merge_month_second_run_accumulates_not_overwrites(self):
        today = today_str()
        bdm = {today: {"deepseek-v4-flash": dict(_zero_bucket(),
                                                 uncached_input_tokens=7)}}
        with self._py_home():
            state_mod.merge_month(
                {"buckets": [{"date": today, "hour": 9, "uncached_input_tokens": 7}]},
                by_date_model=bdm)
            state_mod.merge_month(
                {"buckets": [{"date": today, "hour": 9, "uncached_input_tokens": 3}]},
                by_date_model=bdm)
            f = state_mod._read(state_mod.state_dir() / "month.json")
            self.assertEqual(f["days"][today]["uncached_input_tokens"], 10)
            self.assertEqual(f["days"][today]["by_model"]["deepseek-v4-flash"]["uncached_input_tokens"], 14)


if __name__ == "__main__":
    unittest.main()
