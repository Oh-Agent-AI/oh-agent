#!/usr/bin/env python3
"""cc-trace 差分 oracle 的语义测试。

#54（cc-trace A）的交付物是 `scripts/cc_trace_oracle.py`。本文件钉的是
oracle 自己最容易被改坏的两个语义：

1. **守恒律是闸门，归属差异不是。** 实测真实语料 totals 5/5 + 逐日 25/25 全平，
   per-model 三模型分桶差但每桶各模型差值合计恰为 0（纯重归属——归错模型但一个
   token 都没丢/多）。oracle 的退出码必须只被守恒律驱动：per-model 差异是
   已知、已分类的重归属（cc-trace 把 `thread_settings_applied.model` 读进请求
   归属；我们按 `turn_context.model`），不能因为它翻红。docstring 写过
   「report missing column」原则——这里同一个道理：归属差异是报告项，不是 FAIL。
2. **逐日总 token 按六列互斥消费加，不能按桶加。** cached_input ⊇ cache_write，
   按五个桶加会双计 cache_write。真实语料 cache_write 恒 0 所以没炸过；fixture
   里有 cache_write 时这行逻辑必须仍然正确（2026-08 曾有月总量 201× 事故，
   「总和必须按列/互斥集合加」是本仓库的既有教训）。

`classify_attribution` 钉的是重放方向形态：真实语料是 85+17 个「本轮 A + settings
已翻 B」对 2 个反向（且反向带 0 token）——测试用合成日志复现这个单向形态。
"""

from __future__ import annotations

import contextlib
import io
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import cc_trace_oracle as o

CC_COLS = ["uncached_input_tokens", "output_tokens",
           "cache_read_input_tokens", "cache_write_5m_input_tokens",
           "cache_write_1h_input_tokens", "reasoning_output_tokens"]


def make_usage_db(dir: Path, rows: list[dict]) -> Path:
    """写一个 cc-trace 形状的 usage_entries 到 dir 下的临时 SQLite，返回路径。

    调用方必须让 dir 存活到 cc_trace_sums 之后——连接是 `mode=ro`，文件随
    dir 删除就打不开了。
    """
    db = dir / "usage.db"
    con = sqlite3.connect(db)
    cur = con.cursor()
    cols = ", ".join(CC_COLS)
    cur.execute(
        f"CREATE TABLE usage_entries (source TEXT, day_local TEXT, model TEXT, "
        f"speed TEXT, dedup_key TEXT, {cols})"
    )
    for r in rows:
        vals = tuple(r.get(c, 0) for c in CC_COLS)
        cur.execute(
            f"INSERT INTO usage_entries (source, day_local, model, speed, dedup_key, {cols}) "
            f"VALUES (?, ?, ?, ?, ?, {', '.join('?' * len(CC_COLS))})",
            (r["source"], r["day"], r["model"], r.get("speed", "standard"),
             r.get("dedup", "k"), *vals),
        )
    con.commit()
    con.close()
    return db


def ours_from(total, per_model, days, cost=1.0) -> dict:
    return {
        "total_tokens": total,
        "per_model": {m: {"tokens": pm} for m, pm in per_model.items()},
        "days": [{"date": d, "tokens": t} for d, t in days.items()],
        "total_cost_usd": cost,
    }


class ReconcileConservationGateTests(unittest.TestCase):
    """守恒律（totals + 逐日）驱动退出码；归属差异只报告不 gate。"""

    def _reconcile(self, ours: dict, theirs: dict) -> int:
        """静音 reconcile——它打印整张对账表，测试只看退出码。"""
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            return o.reconcile(ours, theirs, logs_dir=None)

    def test_attribution_difference_alone_does_not_flip_exit(self):
        """per-model 分桶不平但每桶差值合计为 0（纯重归属）→ reconcile 返回 0。"""
        theirs = {
            "totals": {"uncached_input_tokens": 100, "output_tokens": 50,
                       "cached_input_tokens": 30, "cache_write_input_tokens": 10,
                       "reasoning_output_tokens": 5},
            "per_model": {
                "uncached_input_tokens": {"sol": 40, "terra": 60},
                "output_tokens": {"sol": 20, "terra": 30},
                "cached_input_tokens": {"sol": 10, "terra": 20},
                "cache_write_input_tokens": {"sol": 0, "terra": 10},
                "reasoning_output_tokens": {"sol": 2, "terra": 3},
            },
            "per_day": {"2026-08-01": 185},  # 100+50+30+5 (write inside cached, not added)
        }
        # ours：把 sol 的 15 uncached + 10 cached 移到 terra —— 总桶不变，分桶变
        ours = ours_from(
            total=dict(theirs["totals"]),
            per_model={
                "sol": {"uncached_input_tokens": 25, "output_tokens": 20,
                        "cached_input_tokens": 0, "cache_write_input_tokens": 0,
                        "reasoning_output_tokens": 2},
                "terra": {"uncached_input_tokens": 75, "output_tokens": 30,
                          "cached_input_tokens": 30, "cache_write_input_tokens": 10,
                          "reasoning_output_tokens": 3},
            },
            days={"2026-08-01": 185},
        )
        self.assertEqual(self._reconcile(ours, theirs), 0)

    def test_totals_mismatch_is_a_gate(self):
        """任一 totals 桶不平 → reconcile 返回 1（这是守恒破坏，必须翻红）。"""
        theirs = {
            "totals": {"uncached_input_tokens": 100, "output_tokens": 0,
                       "cached_input_tokens": 0, "cache_write_input_tokens": 0,
                       "reasoning_output_tokens": 0},
            "per_model": {"uncached_input_tokens": {"sol": 100},
                          "output_tokens": {}, "cached_input_tokens": {},
                          "cache_write_input_tokens": {}, "reasoning_output_tokens": {}},
            "per_day": {"2026-08-01": 100},
        }
        ours = ours_from(
            total={"uncached_input_tokens": 99, "output_tokens": 0,
                   "cached_input_tokens": 0, "cache_write_input_tokens": 0,
                   "reasoning_output_tokens": 0},
            per_model={"sol": {"uncached_input_tokens": 99, "output_tokens": 0,
                               "cached_input_tokens": 0, "cache_write_input_tokens": 0,
                               "reasoning_output_tokens": 0}},
            days={"2026-08-01": 100},  # totals 已破坏；逐日也顺带对不上
        )
        self.assertEqual(self._reconcile(ours, theirs), 1)


class PerDayNoDoubleCountTests(unittest.TestCase):
    """逐日总 token 按六列互斥消费加，cached_input ⊇ cache_write 不得双计。"""

    def test_per_day_sums_distinct_columns_not_buckets(self):
        """同一天既有 cache_read 又有 cache_write_5m → per_day 是六列和，不是桶和。"""
        with tempfile.TemporaryDirectory() as d:
            db = make_usage_db(Path(d), [
                # 全部在同一天；cache_write 必须只算一次
                {"source": "codex", "day": "2026-08-01", "model": "sol",
                 "uncached_input_tokens": 10, "output_tokens": 2,
                 "cache_read_input_tokens": 20, "cache_write_5m_input_tokens": 5,
                 "cache_write_1h_input_tokens": 0, "reasoning_output_tokens": 1},
                {"source": "codex", "day": "2026-08-01", "model": "terra",
                 "uncached_input_tokens": 30, "output_tokens": 4,
                 "cache_read_input_tokens": 0, "cache_write_5m_input_tokens": 0,
                 "cache_write_1h_input_tokens": 7, "reasoning_output_tokens": 0},
                {"source": "claude", "day": "2026-08-01", "model": "opus",
                 "uncached_input_tokens": 999, "output_tokens": 999,
                 "cache_read_input_tokens": 0, "cache_write_5m_input_tokens": 0,
                 "cache_write_1h_input_tokens": 0, "reasoning_output_tokens": 0},
            ])
            s = o.cc_trace_sums(db)
        # 六列和 = 10+2+20+5+0+1 + 30+4+0+0+7+0 = 79；claude 行被 source 过滤
        self.assertEqual(s["per_day"]["2026-08-01"], 79)
        # 桶值仍各自正确（cached_input 含 write）
        self.assertEqual(s["totals"]["cached_input_tokens"], 20 + 5 + 0 + 7)
        self.assertEqual(s["totals"]["cache_write_input_tokens"], 5 + 7)
        self.assertEqual(s["totals"]["uncached_input_tokens"], 40)

    def test_per_model_groups_by_model(self):
        with tempfile.TemporaryDirectory() as d:
            db = make_usage_db(Path(d), [
                {"source": "codex", "day": "2026-08-01", "model": "sol",
                 "uncached_input_tokens": 10, "output_tokens": 0,
                 "cache_read_input_tokens": 0, "cache_write_5m_input_tokens": 0,
                 "cache_write_1h_input_tokens": 0, "reasoning_output_tokens": 0},
                {"source": "codex", "day": "2026-08-01", "model": "sol",
                 "uncached_input_tokens": 5, "output_tokens": 0,
                 "cache_read_input_tokens": 0, "cache_write_5m_input_tokens": 0,
                 "cache_write_1h_input_tokens": 0, "reasoning_output_tokens": 0},
            ])
            s = o.cc_trace_sums(db)
        self.assertEqual(s["per_model"]["uncached_input_tokens"], {"sol": 15})


class ClassifyAttributionTests(unittest.TestCase):
    """重放方向形态：大量「本轮 A + settings 已翻 B」+ 少量 token-free 反向。"""

    def _write_log(self, logs_dir: Path, events: list[dict]) -> Path:
        logs_dir.mkdir(parents=True, exist_ok=True)
        p = logs_dir / "rollout-x.jsonl"
        with open(p, "w", encoding="utf-8") as f:
            for ev in events:
                f.write(json.dumps(ev) + "\n")
        return p

    def test_counts_forward_and_reverse_directions(self):
        with tempfile.TemporaryDirectory() as d:
            logs = Path(d)
            self._write_log(logs, [
                {"type": "session_meta", "payload": {"model": "sol"}},
                {"type": "turn_context", "payload": {"model": "sol"}},
                {"type": "event_msg", "payload": {"type": "token_count",
                     "info": {"last_token_usage": {"input_tokens": 100, "output_tokens": 5}}}},
                # settings 翻 terra（本轮仍 sol）→ 下一个 token_count 归 (sol, terra)
                {"type": "event_msg", "payload": {"type": "thread_settings_applied",
                     "thread_settings": {"model": "terra"}}},
                {"type": "event_msg", "payload": {"type": "token_count",
                     "info": {"last_token_usage": {"input_tokens": 200, "output_tokens": 7}}}},
                {"type": "event_msg", "payload": {"type": "token_count",
                     "info": {"last_token_usage": {"input_tokens": 300, "output_tokens": 9}}}},
                # 新一轮确认 terra → 恢复一致
                {"type": "turn_context", "payload": {"model": "terra"}},
                {"type": "event_msg", "payload": {"type": "token_count",
                     "info": {"last_token_usage": {"input_tokens": 400, "output_tokens": 1}}}},
                # settings 翻回 sol（本轮仍 terra，token-free）→ 反向 (terra, sol)
                {"type": "event_msg", "payload": {"type": "thread_settings_applied",
                     "thread_settings": {"model": "sol"}}},
                {"type": "event_msg", "payload": {"type": "token_count",
                     "info": {"last_token_usage": {"input_tokens": 0, "output_tokens": 0}}}},
            ])
            counts, tokens = o.classify_attribution(logs)
        self.assertEqual(counts[("sol", "terra")], 2)
        self.assertEqual(counts[("terra", "sol")], 1)
        self.assertEqual(sum(counts.values()), 3)
        self.assertEqual(tokens[("sol", "terra")], [500, 16])   # 200+300 input, 7+9 output
        self.assertEqual(tokens[("terra", "sol")], [0, 0])

    def test_empty_logs_dir_yields_no_divergence(self):
        with tempfile.TemporaryDirectory() as d:
            counts, tokens = o.classify_attribution(Path(d))
        self.assertEqual(counts, {})
        self.assertEqual(tokens, {})


if __name__ == "__main__":
    unittest.main()
