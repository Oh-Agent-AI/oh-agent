#!/usr/bin/env python3
"""per-source 拆账（吸收项 #2）的交叉锁定测试。

2026-08「日历 ¥2386 vs 按 session 重算 ¥1733」的根因之一（a）是**同一批会话
被喂了多次**——oneline/calendar 重跑、DSH 增量与补扫、Codex 导入，全在给同一
个 month.json 累加，却没有任何一个字段能区分「这个量是哪条路径喂进来的」。于是
总量翻倍时只能看到翻倍的总数，看不出哪两条路径撞了。

per-source 拆账给 `token_by_date_model` / `cost_report` 加一个 `source` 维：
每次调用显式标注来源，折叠层把每一笔同时记进「日期→模型」与「日期→来源→模型」
两个轴。诊断时 `state by-source` 一查，同一个量被喂两次就显示两个来源行、各带
一份完整计数——而不是只见一个翻倍值。

与 Rust 侧对守：
- `usage.rs::token_by_date_model`（`by_source` 轴 + 去重语义）
- `usage.rs::state::merge_month_body`（当前月折入 + 历史月回填携带 by_source）
- `cost.rs::cost_report`（`by_source_cost` 计价）
- `state.rs::rollup_by_source`（逐日折平）

跑法：
    python3 -m unittest tests.test_per_source_breakdown -v
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "scan.py"

sys.path.insert(0, str(ROOT / "packages" / "agent-vitals-python"))
from agent_vitals.agent.cost import load_pricing  # noqa: E402
from agent_vitals.agent import state as state_module  # noqa: E402
from agent_vitals.agent.usage import (  # noqa: E402
    SOURCE_CLI, SOURCE_CODEX, SOURCE_DSH_LIVE, SOURCE_UNSPECIFIED,
    token_by_date_model,
)

PRICING = load_pricing()

# 与 Rust `reconcile_fixture()` **逐字同一份夹具**：跨午夜 + 同 (turn,step)
# 替换（8/25 的贡献被 8/26 的同 step 扣光）+ 换模型。改数字 = 两边一起改。
RECONCILE_FIXTURE = [
    {"type": "request/header", "seq": 1, "time": 1787673000000,
     "data": {"header": {"config": {"model": "pro"}}}},
    # 8/25 23:50
    {"type": "assistant/chunk", "seq": 2, "time": 1787673000000,
     "data": {"turn": 1, "step": 1, "chunk": {"type": "usage",
              "usage": {"inputTokens": 1000, "outputTokens": 100,
                        "cacheReadTokens": 50, "cacheWriteTokens": 0}}}},
    # 同 (1,1) 但落到 8/26 00:10 —— 必须把 8/25 的贡献扣掉再记到 8/26
    {"type": "assistant/message", "seq": 3, "time": 1787674200000,
     "data": {"turn": 1, "step": 1,
              "usage": {"inputTokens": 1200, "outputTokens": 120,
                        "cacheReadTokens": 60, "cacheWriteTokens": 0}}},
    # 换模型，仍在 8/26
    {"type": "request/header", "seq": 4, "time": 1787674200000,
     "data": {"header": {"config": {"model": "flash"}}}},
    {"type": "assistant/chunk", "seq": 5, "time": 1787674200000,
     "data": {"turn": 2, "step": 1, "chunk": {"type": "usage",
              "usage": {"inputTokens": 500, "outputTokens": 50}}}},
]


def _run(args, env=None):
    full_env = os.environ.copy()
    if env:
        full_env.update(env)
    return subprocess.run(
        [sys.executable, str(SCRIPT)] + list(args),
        capture_output=True, text=True, env=full_env, timeout=60,
    )


# 跟随当前月：merge_month 只把当月留在 month.json，写死的 2026-09 在跨月后会被当作「已滚出当月」归档，
# 测试就从「按来源合并」变成了「测归档」（2026-10-01 实际踩到）。
MONTH = datetime.now().strftime("%Y-%m")

class _TmpHome:
    """每次测试一个临时 AGENT_VITALS_HOME + HOME —— 不污染真机。"""

    def __enter__(self):
        self.tmp = tempfile.mkdtemp(prefix="sv-per-source-")
        self.env = {"AGENT_VITALS_HOME": self.tmp,
                    "HOME": self.tmp,
                    "USERPROFILE": self.tmp}
        return self

    def __exit__(self, *args):
        shutil.rmtree(self.tmp, ignore_errors=True)


class TestBySourceAxis(unittest.TestCase):
    """折叠层：`token_by_date_model` 的 by_source 轴本身。"""

    def test_same_batch_fed_twice_has_two_source_rows(self):
        """**演示断言**：同一批会话被喂两次（两个来源），by_source 必须区分
        两次来源/计数，而不是仅仅总量翻倍。每次调用只喂一个来源；「喂两次」
        在折叠层表现为两个来源键、各带一份完整计数。"""
        first = token_by_date_model(RECONCILE_FIXTURE, source=SOURCE_DSH_LIVE)
        second = token_by_date_model(RECONCILE_FIXTURE, source=SOURCE_CLI)

        self.assertEqual(
            first["by_source"]["2026-08-26"]["dsh-live"]["pro"]["uncached_input_tokens"],
            1200,
            "dsh-live 来源行应带完整计数，不是翻倍值的一部分")
        self.assertEqual(
            second["by_source"]["2026-08-26"]["cli"]["pro"]["uncached_input_tokens"],
            1200,
            "cli 来源行同样各带一份完整计数")
        self.assertNotIn("cli", first["by_source"]["2026-08-26"])
        self.assertNotIn("dsh-live", second["by_source"]["2026-08-26"])
        # 主输出总量不变：每个来源各自折，主账不会被来源维翻倍。
        self.assertEqual(
            second["2026-08-26"]["pro"]["uncached_input_tokens"], 1200)

    def test_by_source_subtotals_equal_main_total(self):
        """by_source 各来源之和 == 主输出总量——按来源拆的账和按日期拆的账是
        同一份用量，不是各算各的（Rust 侧同一条不变量）。"""
        out = token_by_date_model(RECONCILE_FIXTURE, source=SOURCE_CODEX)
        main = out["2026-08-26"]["pro"]["uncached_input_tokens"]
        src = out["by_source"]["2026-08-26"]["codex"]["pro"]["uncached_input_tokens"]
        self.assertEqual(main, src)

    def test_source_lost_degrades_to_unspecified_not_fabricated(self):
        """调用方没给来源标签时的**诚实降级**：fold 收 `"unspecified"`——是明确
        标注「未知来源」，不是编造一个看起来真实的来源名。绝不能把缺标签的样本
        凭空安到 `cli`/`dsh-live` 头上，否则「重复喂」诊断就会被一个假的来源键
        污染。"""
        out = token_by_date_model(RECONCILE_FIXTURE)  # 不传 source
        day_sources = out["by_source"]["2026-08-26"]
        self.assertIn("unspecified", day_sources)
        self.assertNotIn("cli", day_sources)
        self.assertNotIn("dsh-live", day_sources)

    def test_by_source_empty_when_no_dated_samples(self):
        """无带日期样本时输出仍是 `{}`——by_source 键整个不出现，不摆一个空的
        source 结构出来冒充「测到了什么」。"""
        events = [
            {"type": "request/header", "seq": 1, "time": 1001,
             "data": {"header": {"config": {"model": "pro"}}}},
            {"type": "assistant/chunk", "seq": 2,
             "data": {"turn": 1, "step": 1, "chunk": {"type": "usage",
                      "usage": {"inputTokens": 500, "outputTokens": 50}}}},
        ]
        self.assertEqual(token_by_date_model(events, source=SOURCE_CLI), {})


class TestBySourceMerge(unittest.TestCase):
    """state 层：`merge_month` 把 by_source 折进月账（当前月折入 + 历史月回填）。"""

    def _day_bucket(self, uncached=100):
        return {
            "uncached_input_tokens": uncached, "output_tokens": 0,
            "cache_read_tokens": 0, "cache_write_tokens": 0,
            "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
            "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0,
        }

    def _model_day(self, uncached=100):
        """by_source 里每个来源的值是 `{model: 八桶}`（与 Rust
        `merge_source_into_day` 的入参同形）——`_merge_model_buckets` 按模型名
        累加，裸八桶会被当成「8 个模型」逐个踩，值是非 dict 直接崩。"""
        return {"deepseek-v4-flash": self._day_bucket(uncached)}

    def test_merge_month_keeps_two_source_rows_per_day(self):
        """同一批喂两次（dsh-live + cli）折进 month.json：`days[date].by_source`
        两个来源键并存、各带各自计数——这是 `state by-source` 能诊断重复喂的根基。
        主桶是两来源之和（翻倍），但 by_source 各来源行各一份。"""
        with _TmpHome() as h:
            day = self._day_bucket()
            hb = {"buckets": [dict(day, date=MONTH + "-01")]}
            bdm = {
                MONTH + "-01": self._model_day(),
                "by_source": {
                    MONTH + "-01": {"dsh-live": self._model_day()},
                },
            }
            bdm2 = {
                MONTH + "-01": self._model_day(),
                "by_source": {
                    MONTH + "-01": {"cli": self._model_day()},
                },
            }
            with mock.patch.dict(os.environ, h.env, clear=False):
                state_module.merge_month(hb, by_date_model=bdm)
                state_module.merge_month(hb, by_date_model=bdm2)

            month = json.loads((Path(h.tmp) / "state" / "month.json").read_text())
            day_out = month["days"][MONTH + "-01"]
            bs = day_out["by_source"]
            self.assertEqual(sorted(bs.keys()), ["cli", "dsh-live"],
                             "两个来源键并存——诊断「同一批被喂几次」就靠这个")
            self.assertEqual(
                bs["dsh-live"]["deepseek-v4-flash"]["uncached_input_tokens"], 100)
            self.assertEqual(
                bs["cli"]["deepseek-v4-flash"]["uncached_input_tokens"], 100)
            # 主桶是两来源之和：同一天喂了两次，总量翻倍，但 by_source 看得见原因。
            self.assertEqual(day_out["uncached_input_tokens"], 200)

    def test_merge_month_skips_by_source_key_as_a_date(self):
        """by_source 是顶层并列键、不是日期：跳过它才能避免被当成某一天把
        `{date: {source: {model}}}` 整段塞进 by_model。"""
        with _TmpHome() as h:
            bdm = {
                "by_source": {MONTH + "-01": {"cli": self._model_day()}},
            }
            with mock.patch.dict(os.environ, h.env, clear=False):
                state_module.merge_month({"buckets": []}, by_date_model=bdm)
            month = json.loads((Path(h.tmp) / "state" / "month.json").read_text())
            self.assertIn(MONTH + "-01", month["days"])
            self.assertEqual(month["days"][MONTH + "-01"]["uncached_input_tokens"], 0)
            self.assertEqual(
                month["days"][MONTH + "-01"]["by_source"]["cli"]
                ["deepseek-v4-flash"]["uncached_input_tokens"],
                100)

    def test_merge_month_backfill_carries_by_source_into_archive(self):
        """历史月回填：by_source 与 by_model 一起累加进归档里已有的那一天——
        同一旧日期被回填两次，两个来源各留各的键，不互相覆盖。"""
        with _TmpHome() as h:
            day = self._day_bucket()
            hb = {"buckets": [dict(day, date="2026-08-30")]}
            bdm = {
                "2026-08-30": self._model_day(),
                "by_source": {"2026-08-30": {"dsh-backfill": self._model_day()}},
            }
            bdm2 = {
                "2026-08-30": self._model_day(),
                "by_source": {"2026-08-30": {"cli": self._model_day()}},
            }
            with mock.patch.dict(os.environ, h.env, clear=False):
                state_module.merge_month(hb, by_date_model=bdm)
                state_module.merge_month(hb, by_date_model=bdm2)

            archive = json.loads(
                (Path(h.tmp) / "state" / "month-archive.json").read_text())
            day_out = archive["months"]["2026-08"]["days"]["2026-08-30"]
            bs = day_out["by_source"]
            self.assertEqual(sorted(bs.keys()), ["cli", "dsh-backfill"])
            self.assertEqual(
                bs["dsh-backfill"]["deepseek-v4-flash"]["uncached_input_tokens"], 100)
            self.assertEqual(
                bs["cli"]["deepseek-v4-flash"]["uncached_input_tokens"], 100)
            # month.json 里 8 月日子不该出现（回填只进归档）
            month = json.loads((Path(h.tmp) / "state" / "month.json").read_text())
            self.assertNotIn("2026-08-30", month.get("days", {}))
            # 主桶累加为两来源之和
            self.assertEqual(day_out["uncached_input_tokens"], 200)

    def test_rollup_by_source_flattens_per_day_rows(self):
        """逐日 by_source 折平成 {source: {model}}——`state by-source` 读
        month.json 全靠它，跨天同一来源必须累加。"""
        month = {
            "days": {
                MONTH + "-01": {"by_source": {"cli": self._model_day(100)}},
                MONTH + "-02": {"by_source": {"cli": self._model_day(50)}},
            },
        }
        out = state_module.rollup_by_source(month)
        self.assertEqual(
            out["cli"]["deepseek-v4-flash"]["uncached_input_tokens"], 150)


class TestBySourceCost(unittest.TestCase):
    """cost 层：`cost_report` 的 by_source_cost —— 与 Rust `cost.rs` 三条单测
    对守（同一份夹具、同一组数：100 万 uncached 全空闲 × flash 1.5 元/百万
    = 1.5 元）。"""

    FLASH_1M = {
        "uncached_input_tokens": 1000000, "output_tokens": 0,
        "cache_read_tokens": 0, "cache_write_tokens": 0,
        "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
        "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0,
    }

    def _source_day(self, uncached=1000000):
        """by_source 里每个来源的值是 `{model: 八桶}`（`_build_by_source_cost`
        把它当 by_model 送进主计价循环）——裸八桶会被当成「8 个模型」。"""
        return {"deepseek-v4-flash": {
            **self.FLASH_1M, "uncached_input_tokens": uncached}}

    def test_by_source_prices_each_source_separately(self):
        """同一批 100 万 uncached 喂两次（dsh-live + cli）：by_source_cost 各
        来源一行、各 1.5 元，而不是把总量翻倍后塞进一个来源。"""
        from agent_vitals.agent.cost import cost_report
        usage = {
            "by_model": {"deepseek-v4-flash": {
                **self.FLASH_1M, "uncached_input_tokens": 2000000}},
            "by_source": {"dsh-live": self._source_day(),
                          "cli": self._source_day()},
        }
        report = cost_report(usage, PRICING)
        self.assertIsNotNone(report)
        self.assertAlmostEqual(report["total"], 3.0, places=9,
                               msg="主账单 = 两来源之和")
        bsc = report["by_source_cost"]
        self.assertEqual(set(bsc.keys()), {"dsh-live", "cli"})
        self.assertAlmostEqual(bsc["dsh-live"]["total"], 1.5, places=9)
        self.assertAlmostEqual(bsc["cli"]["total"], 1.5, places=9)
        self.assertEqual(bsc["dsh-live"]["unpriced_tokens"], 0)

    def test_by_source_omitted_when_source_absent(self):
        """by_source 缺场时 by_source_cost 键整个不出现——输出与没有该功能的
        版本逐字节一致（键序不变，by_source_cost 只允许插在最后）。"""
        from agent_vitals.agent.cost import cost_report
        usage = {"by_model": {"deepseek-v4-flash": self.FLASH_1M}}
        report = cost_report(usage, PRICING)
        self.assertIsNotNone(report)
        self.assertNotIn("by_source_cost", report)
        self.assertEqual(list(report.keys()), [
            "currency", "estimate_disclaimer", "total",
            "peak_total", "per_model", "unpriced_tokens",
        ])

    def test_by_source_only_still_prices_sources(self):
        """只有 by_source、没有 by_model（`state by-source` 的 usage 形状）→
        主账单为 0、by_source_cost 照常给——不能因为主账单空就整体返回 None。"""
        from agent_vitals.agent.cost import cost_report
        usage = {"by_source": {"codex": self._source_day()}}
        report = cost_report(usage, PRICING)
        self.assertIsNotNone(report)
        self.assertEqual(report["total"], 0.0)
        self.assertAlmostEqual(
            report["by_source_cost"]["codex"]["total"], 1.5, places=9)


class TestBySourceCli(unittest.TestCase):
    """端到端：`state by-source` 子命令 —— 喂两次后能查到两个来源行。"""

    def _day_bucket(self, uncached=100):
        return {
            "uncached_input_tokens": uncached, "output_tokens": 0,
            "cache_read_tokens": 0, "cache_write_tokens": 0,
            "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
            "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0,
        }

    def _model_day(self, uncached=100):
        return {"deepseek-v4-flash": self._day_bucket(uncached)}

    def test_state_by_source_reports_two_sources_after_two_feeds(self):
        with _TmpHome() as h:
            day = self._day_bucket()
            hb = {"buckets": [dict(day, date=MONTH + "-01")]}
            bdm = {
                MONTH + "-01": self._model_day(),
                "by_source": {MONTH + "-01": {"dsh-live": self._model_day()}},
            }
            bdm2 = {
                MONTH + "-01": self._model_day(),
                "by_source": {MONTH + "-01": {"cli": self._model_day()}},
            }
            with mock.patch.dict(os.environ, h.env, clear=False):
                state_module.merge_month(hb, by_date_model=bdm)
                state_module.merge_month(hb, by_date_model=bdm2)

            r = _run(["state", "by-source"], env=h.env)
            self.assertEqual(r.returncode, 0, r.stderr)
            out = json.loads(r.stdout)
            self.assertEqual(sorted(out["by_source"].keys()), ["cli", "dsh-live"])
            # 顶层的 by_source_cost 是整份 cost_report（带 currency/total/per_model），
            # per-source 行在它的嵌套 by_source_cost 里——与 Rust by_source_report
            # 同一形状（两者都直接打印 cost_report 的返回值）。
            rows = out["by_source_cost"]["by_source_cost"]
            self.assertEqual(sorted(rows.keys()), ["cli", "dsh-live"])
            self.assertEqual(rows["dsh-live"]["total"],
                             rows["cli"]["total"],
                             "两个来源各一份完整计数/计价")

    def test_state_by_source_empty_month_is_honest_empty(self):
        """老 month.json（没有 by_source）→ 两个键都空，不摆全零结构。"""
        with _TmpHome() as h:
            r = _run(["state", "by-source"], env=h.env)
            self.assertEqual(r.returncode, 0, r.stderr)
            out = json.loads(r.stdout)
            self.assertEqual(out["by_source"], {})
            self.assertIsNone(out["by_source_cost"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
