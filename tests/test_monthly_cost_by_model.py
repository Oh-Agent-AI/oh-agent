#!/usr/bin/env python3
"""按 provider/model 月成本（v0.7 spec §3 交付矩阵首行，2026-09-03 落地）。

`docs/VITALS_CORE_V0_7_DATA_PLANE_SPEC.md` §3 把这一行标为「零新数据、零新
持久化、纯新增视图」——month.json 的逐日 `by_model`、模型价目卡（pricing.json）、
计价函数（`cost.cost_report`）全部现成，缺的只是把「逐日」折平成「逐月」的
输出面。实现直接照抄已有的 `state by-source`/`rollup_by_source` 模式（同一套
读法，把 source 那层键换成模型名），是这条 v0.7 交付线里风险最小的一格。

与 Rust 侧对守：
- `state.rs::rollup_by_model`（逐日折平）
- `state.rs::by_model_report`（`state by-model` CLI 入口）

跑法：
    python3 -m unittest tests.test_monthly_cost_by_model -v
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

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "scan.py"
BIN = os.environ.get("AGENT_VITALS_BIN")

sys.path.insert(0, str(ROOT / "packages" / "agent-vitals-python"))
from agent_vitals.agent.cost import load_pricing, cost_report  # noqa: E402
from agent_vitals.agent import state as state_module  # noqa: E402

PRICING = load_pricing()


def _run(args, env=None, binary=False):
    full_env = os.environ.copy()
    if env:
        full_env.update(env)
    cmd = [BIN] + list(args) if binary else [sys.executable, str(SCRIPT)] + list(args)
    return subprocess.run(cmd, capture_output=True, text=True, env=full_env, timeout=60)


# 跟随当前月：merge_month 只把当月留在 month.json，写死的 2026-09 在跨月后会被当作「已滚出当月」归档，
# 测试就从「按来源合并」变成了「测归档」（2026-10-01 实际踩到）。
MONTH = datetime.now().strftime("%Y-%m")

class _TmpHome:
    """每次测试一个临时 AGENT_VITALS_HOME + HOME —— 不污染真机。"""

    def __enter__(self):
        self.tmp = tempfile.mkdtemp(prefix="sv-by-model-")
        self.env = {"AGENT_VITALS_HOME": self.tmp,
                    "HOME": self.tmp,
                    "USERPROFILE": self.tmp}
        return self

    def __exit__(self, *args):
        shutil.rmtree(self.tmp, ignore_errors=True)


FLASH_1M = {
    "uncached_input_tokens": 1000000, "output_tokens": 0,
    "cache_read_tokens": 0, "cache_write_tokens": 0,
    "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
    "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0,
}


def _bucket(uncached=100):
    return {
        "uncached_input_tokens": uncached, "output_tokens": 0,
        "cache_read_tokens": 0, "cache_write_tokens": 0,
        "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
        "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0,
    }


class RollupByModelCase(unittest.TestCase):
    """纯函数：`state.rollup_by_model` 的逐日折平——与 Rust
    `state.rs::rollup_by_model_flattens_per_day_rows` 同一份夹具同一期望值。"""

    def test_flattens_per_day_rows(self):
        month = {
            "days": {
                MONTH + "-01": {"by_model": {"pro": _bucket(100)}},
                MONTH + "-02": {"by_model": {"pro": _bucket(50)}},
            },
        }
        out = state_module.rollup_by_model(month)
        self.assertEqual(out["pro"]["uncached_input_tokens"], 150)

    def test_two_models_stay_separate(self):
        month = {
            "days": {
                MONTH + "-01": {"by_model": {
                    "deepseek-v4-flash": _bucket(100),
                    "deepseek/deepseek-v4-pro-0813": _bucket(200),
                }},
            },
        }
        out = state_module.rollup_by_model(month)
        self.assertEqual(sorted(out), ["deepseek-v4-flash", "deepseek/deepseek-v4-pro-0813"])
        self.assertEqual(out["deepseek-v4-flash"]["uncached_input_tokens"], 100)
        self.assertEqual(out["deepseek/deepseek-v4-pro-0813"]["uncached_input_tokens"], 200)

    def test_empty_days_is_empty_dict(self):
        """没有 by_model 的老月份 → 空 dict，不摆全零结构（与
        `by_model_report`/`state by-model` 的「两个键都空」诚实降级一致）。"""
        self.assertEqual(state_module.rollup_by_model({"days": {}}), {})
        self.assertEqual(state_module.rollup_by_model({}), {})


class ByModelCostCase(unittest.TestCase):
    """把 rollup 出来的月度 by_model 喂给既有 `cost_report`——零新计价规则，
    与 `state by-model` 打印的形状完全一致。"""

    def test_two_models_priced_separately_not_summed(self):
        rolled = {
            "deepseek-v4-flash": FLASH_1M,
            "deepseek/deepseek-v4-pro-0813": FLASH_1M,
        }
        report = cost_report({"by_model": rolled}, PRICING)
        self.assertIsNotNone(report)
        pm = report["per_model"]
        self.assertEqual(sorted(pm), ["deepseek-v4-flash", "deepseek/deepseek-v4-pro-0813"])
        # flash 1.5/M vs pro 4.5/M（fallback 卡）——两行金额不同，不是被平均了。
        self.assertAlmostEqual(pm["deepseek-v4-flash"]["total"], 1.5, places=9)
        self.assertAlmostEqual(pm["deepseek/deepseek-v4-pro-0813"]["total"], 4.5, places=9)
        self.assertAlmostEqual(report["total"], 6.0, places=9)


class StateByModelCli(unittest.TestCase):
    """端到端：`state by-model` 子命令——跨天累加、两模型分列、老数据空态。"""

    def _model_day(self, model, uncached=100):
        return {model: _bucket(uncached)}

    def test_reports_two_models_after_two_day_feeds(self):
        with _TmpHome() as h:
            hb = {"buckets": [dict(_bucket(), date=MONTH + "-01")]}
            bdm1 = {MONTH + "-01": self._model_day("deepseek-v4-flash", 100)}
            hb2 = {"buckets": [dict(_bucket(50), date=MONTH + "-02")]}
            bdm2 = {MONTH + "-02": self._model_day("deepseek-v4-flash", 50)}
            from unittest import mock
            with mock.patch.dict(os.environ, h.env, clear=False):
                state_module.merge_month(hb, by_date_model=bdm1)
                state_module.merge_month(hb2, by_date_model=bdm2)

            r = _run(["state", "by-model"], env=h.env)
            self.assertEqual(r.returncode, 0, r.stderr)
            out = json.loads(r.stdout)
            self.assertEqual(list(out["by_model"]), ["deepseek-v4-flash"])
            # 跨天同一模型累加：100 + 50 = 150。
            self.assertEqual(
                out["by_model"]["deepseek-v4-flash"]["uncached_input_tokens"], 150)
            self.assertIn("by_model_cost", out)
            self.assertIsNotNone(out["by_model_cost"])

    def test_empty_month_is_honest_empty(self):
        """老 month.json（没有 by_model）→ 两个键都空，不摆全零结构。"""
        with _TmpHome() as h:
            r = _run(["state", "by-model"], env=h.env)
            self.assertEqual(r.returncode, 0, r.stderr)
            out = json.loads(r.stdout)
            self.assertEqual(out["by_model"], {})
            self.assertIsNone(out["by_model_cost"])

    @unittest.skipUnless(BIN, "AGENT_VITALS_BIN not set — differential skipped")
    def test_rust_retires_json_month_reader(self):
        """v0.9.1：主二进制不再提供从 month.json 读取业务数据的入口。"""
        with _TmpHome() as h:
            state_dir = Path(h.tmp) / "state"
            state_dir.mkdir(parents=True, exist_ok=True)
            month = {
                "schema_version": "1.0.0",
                "month": MONTH,
                "days": {
                    MONTH + "-01": dict(_bucket(1000000), by_model={
                        "deepseek-v4-flash": FLASH_1M,
                        "deepseek/deepseek-v4-pro-0813": FLASH_1M,
                    }),
                },
            }
            (state_dir / "month.json").write_text(
                json.dumps(month, ensure_ascii=False), encoding="utf-8")
            rs = _run(["state", "by-model"], env=h.env, binary=True)
            self.assertEqual(rs.returncode, 2)
            self.assertIn("unrecognized subcommand 'by-model'", rs.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
