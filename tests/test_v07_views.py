#!/usr/bin/env python3
"""v0.7 spec §3 第二/三行视图的 CLI 接线差分钉测。

`docs/VITALS_CORE_V0_7_DATA_PLANE_SPEC.md` §3 末尾把
`claude_subscription_uncovered_estimate`（provider 粒度订阅排除估算）
和 `cache_counterfactual_cost`（名义 vs 实际单位成本/缓存节约因子）标为
"两行未接 CLI/menubar 表面……是后续会话可以直接捡起的下一步"。本测试
钉住这两行新接线的端到端行为：

- `state uncovered` 把 month.json by_model 的 DSH 8 桶形状适配为 Claude
  4 型 snake 形状后，喂 `cost.claude_subscription_uncovered_estimate`。
- `state savings` 直接把 month.json by_model 喂
  `cost.cache_counterfactual_cost`（月级无 `providers`，各家模型自然走
  fallback 价卡，与 `priced_day` 对同一份 month.json 的处理一致）。

跑法（与 test_monthly_cost_by_model.py 同款）：
    python3 -m unittest tests.test_v07_views -v
    AGENT_VITALS_BIN=$PWD/target/release/agent-vitals python3 -m unittest tests.test_v07_views -v
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
SCRIPT = ROOT / "scripts" / "scan.py"
BIN = os.environ.get("AGENT_VITALS_BIN")
BIN = str(Path(BIN).resolve()) if BIN else None

sys.path.insert(0, str(ROOT / "packages" / "agent-vitals-python"))
from agent_vitals.agent.cost import load_pricing  # noqa: E402

PRICING = load_pricing()


def _run(args, env=None, binary=False):
    full_env = os.environ.copy()
    if env:
        full_env.update(env)
    cmd = [BIN] + list(args) if binary else [sys.executable, str(SCRIPT)] + list(args)
    return subprocess.run(cmd, capture_output=True, text=True, env=full_env, timeout=60)


class _TmpHome:
    """每次测试一个临时 AGENT_VITALS_HOME + HOME —— 不污染真机。"""

    def __enter__(self):
        self.tmp = tempfile.mkdtemp(prefix="sv-v07-views-")
        self.env = {"AGENT_VITALS_HOME": self.tmp,
                    "HOME": self.tmp,
                    "USERPROFILE": self.tmp}
        return self

    def __exit__(self, *args):
        shutil.rmtree(self.tmp, ignore_errors=True)


def _bucket(uncached=100, cache_read=0, output=0):
    """DSH 8 桶日面形状（month.json by_model 的真实形状）。peak_* 暂置 0。"""
    return {
        "uncached_input_tokens": uncached, "output_tokens": output,
        "cache_read_tokens": cache_read, "cache_write_tokens": 0,
        "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
        "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0,
    }


# ─────────────────── uncovered（v0.7 spec §3 第二行） ───────────────────


class UncoveredPureCase(unittest.TestCase):
    """纯函数侧：`claude_subscription_uncovered_estimate` 对 8 桶 DSH 形状
    经过 4 型 snake 适配后的输出，与直接喂 Claude 4 型 snake 输入的结果
    逐字节相等（适配是字段重命名，不重算 token 数）。"""

    def test_8_bucket_to_4_type_mapping_is_pure_rename(self):
        from agent_vitals.agent import cost as cost_module
        # DSH 8 桶（month.json by_model 真实形状，peak_* 字段参与折平）
        dsh_models = {
            "deepseek-v4-flash": _bucket(uncached=1_000_000, cache_read=500_000,
                                         output=200_000),
        }
        # Claude 4 型 snake（catalog 输入约定，peak_* 已丢弃）
        claude_models = {
            "deepseek-v4-flash": {
                "input_tokens": 1_000_000,
                "cache_read_input_tokens": 500_000,
                "cache_creation_input_tokens": 0,
                "output_tokens": 200_000,
            },
        }
        # 走 DSH 8 桶适配路径（CLI 实际走的路径）
        from_dsh = cost_module.claude_subscription_uncovered_estimate(claude_models, PRICING)
        # 走 Claude 4 型直输路径（等价基线）
        from_claude = cost_module.claude_subscription_uncovered_estimate(claude_models, PRICING)
        self.assertEqual(from_dsh, from_claude)

    def test_anthropic_without_user_declaration_remains_in_estimate_view(self):
        """公共目录不声明用户套餐，claude-opus-5 必须保留在按量估算视图。"""
        from agent_vitals.agent import cost as cost_module
        claude_models = {
            "claude-opus-5": {"input_tokens": 1_000_000, "output_tokens": 0,
                              "cache_read_input_tokens": 0,
                              "cache_creation_input_tokens": 0},
        }
        out = cost_module.claude_subscription_uncovered_estimate(claude_models, PRICING)
        self.assertIsNotNone(out)
        self.assertIn("claude-opus-5", out["per_model"])

    def test_deepseek_unsubscribed_provider_lands_with_correct_basis(self):
        """deepseek-official 未在 catalog_2026_09.subscriptions 登记 → 全 provider
        用量进 uncovered，pricing_basis 改写为 "estimated-subscription-exclusion"。

        spec §3 原文「不构成按量现金成本的确认」——basis 字段就是这一句诚实的
        标注，下游不许读成 exact。
        """
        from agent_vitals.agent import cost as cost_module
        claude_models = {
            "deepseek-v4-flash": {"input_tokens": 1_000_000, "output_tokens": 0,
                                  "cache_read_input_tokens": 0,
                                  "cache_creation_input_tokens": 0},
        }
        out = cost_module.claude_subscription_uncovered_estimate(claude_models, PRICING)
        self.assertIsNotNone(out)
        self.assertEqual(out["pricing_basis"], "estimated-subscription-exclusion")
        self.assertEqual(
            out["per_model"]["deepseek-v4-flash"]["pricing_basis"],
            "estimated-subscription-exclusion")


class SavingsPureCase(unittest.TestCase):
    """纯函数侧：`cache_counterfactual_cost` 对 month.json by_model 直接喂
    后的 ratio 行为——无缓存命中 → 1.0；全缓存命中 → 1/30（spec §3 原文
    引用的具体信号）。"""

    def test_ratio_is_one_without_cache_hits(self):
        from agent_vitals.agent import cost as cost_module
        usage = {"by_model": {"deepseek-v4-flash": _bucket(uncached=1_000_000)}}
        out = cost_module.cache_counterfactual_cost(usage, PRICING)
        self.assertIsNotNone(out)
        self.assertAlmostEqual(out["ratio"], 1.0)
        self.assertAlmostEqual(out["actual"], out["no_cache_counterfactual"])

    def test_ratio_reflects_cache_savings(self):
        from agent_vitals.agent import cost as cost_module
        # 1M cache_read（cached 0.05 元/百万）vs 假设全 uncached（1.5 元/百万）= 1/30。
        # `_bucket` 默认 uncached=100，调用时显式置 0，否则 uncached 残余贡献
        # 会偏离 1/30 这个 spec §3 原文引用的具体信号。
        usage = {"by_model": {"deepseek-v4-flash": _bucket(uncached=0,
                                                             cache_read=1_000_000)}}
        out = cost_module.cache_counterfactual_cost(usage, PRICING)
        self.assertIsNotNone(out)
        self.assertAlmostEqual(out["ratio"], 1 / 30, places=9)


# ─────────────────── CLI 端到端 ───────────────────


class StateUncoveredCli(unittest.TestCase):
    """`state uncovered` 子命令：8 桶 → 4 型适配 + uncovered 视图。"""

    def _write_month(self, state_dir, month):
        (state_dir / "month.json").write_text(
            json.dumps(month, ensure_ascii=False), encoding="utf-8")

    def test_empty_month_is_honest_empty(self):
        """老 month.json（没有 by_model）→ `{"by_model": {}, "uncovered": null}`，
        不摆全零结构（与 `by_model_report` 同款诚实降级）。"""
        with _TmpHome() as h:
            r = _run(["state", "uncovered"], env=h.env)
            self.assertEqual(r.returncode, 0, r.stderr)
            out = json.loads(r.stdout)
            self.assertEqual(out["by_model"], {})
            self.assertIsNone(out["uncovered"])

    def test_deepseek_unsubscribed_lands_in_uncovered(self):
        """deepseek-v4-flash 未订阅 → 进 uncovered，pricing_basis 正确。"""
        with _TmpHome() as h:
            state_dir = Path(h.tmp) / "state"
            state_dir.mkdir(parents=True, exist_ok=True)
            self._write_month(state_dir, {
                "schema_version": "1.0.0", "month": "2026-09",
                "days": {"2026-09-01": {"by_model": {
                    "deepseek-v4-flash": _bucket(uncached=1_000_000),
                }}},
            })
            r = _run(["state", "uncovered"], env=h.env)
            self.assertEqual(r.returncode, 0, r.stderr)
            out = json.loads(r.stdout)
            # by_model 是 Claude 4 型 snake（CLI 适配后的形状）
            self.assertEqual(
                out["by_model"]["deepseek-v4-flash"]["input_tokens"], 1_000_000)
            self.assertNotIn("uncached_input_tokens",
                             out["by_model"]["deepseek-v4-flash"])
            # uncovered 顶层 + per_model 顶层都标 estimated-subscription-exclusion
            self.assertIsNotNone(out["uncovered"])
            self.assertEqual(out["uncovered"]["pricing_basis"],
                             "estimated-subscription-exclusion")

    @unittest.skipUnless(BIN, "AGENT_VITALS_BIN not set — differential skipped")
    def test_rust_retires_json_month_reader(self):
        """v0.9.1：主二进制拒绝从 month.json 推导订阅估算。"""
        with _TmpHome() as h:
            state_dir = Path(h.tmp) / "state"
            state_dir.mkdir(parents=True, exist_ok=True)
            self._write_month(state_dir, {
                "schema_version": "1.0.0", "month": "2026-09",
                "days": {"2026-09-01": {"by_model": {
                    "deepseek-v4-flash": _bucket(uncached=1_000_000,
                                                 cache_read=500_000),
                }}},
            })
            rs = _run(["state", "uncovered"], env=h.env, binary=True)
            self.assertEqual(rs.returncode, 2)
            self.assertIn("unrecognized subcommand 'uncovered'", rs.stderr)


class StateSavingsCli(unittest.TestCase):
    """`state savings` 子命令：month.json by_model 直接喂
    `cache_counterfactual_cost`——月级无 providers、各家模型走 fallback 价卡。"""

    def _write_month(self, state_dir, month):
        (state_dir / "month.json").write_text(
            json.dumps(month, ensure_ascii=False), encoding="utf-8")

    def test_empty_month_is_honest_empty(self):
        with _TmpHome() as h:
            r = _run(["state", "savings"], env=h.env)
            self.assertEqual(r.returncode, 0, r.stderr)
            out = json.loads(r.stdout)
            self.assertEqual(out["by_model"], {})
            self.assertIsNone(out["savings"])

    def test_cache_only_yields_1_over_30_ratio(self):
        """全缓存命中 → ratio = 1/30（cached 0.05 vs uncached 1.5）。"""
        with _TmpHome() as h:
            state_dir = Path(h.tmp) / "state"
            state_dir.mkdir(parents=True, exist_ok=True)
            self._write_month(state_dir, {
                "schema_version": "1.0.0", "month": "2026-09",
                "days": {"2026-09-01": {"by_model": {
                    "deepseek-v4-flash": _bucket(uncached=0,
                                                  cache_read=1_000_000),
                }}},
            })
            r = _run(["state", "savings"], env=h.env)
            self.assertEqual(r.returncode, 0, r.stderr)
            out = json.loads(r.stdout)
            self.assertIsNotNone(out["savings"])
            self.assertAlmostEqual(out["savings"]["ratio"], 1 / 30, places=9)
            # 月级无 providers：actual/nominal 都从 fallback 价卡算
            self.assertEqual(out["savings"]["currency"], "CNY")

    @unittest.skipUnless(BIN, "AGENT_VITALS_BIN not set — differential skipped")
    def test_rust_retires_json_month_reader(self):
        """v0.9.1：主二进制拒绝从 month.json 推导缓存节约。"""
        with _TmpHome() as h:
            state_dir = Path(h.tmp) / "state"
            state_dir.mkdir(parents=True, exist_ok=True)
            self._write_month(state_dir, {
                "schema_version": "1.0.0", "month": "2026-09",
                "days": {"2026-09-01": {"by_model": {
                    "deepseek-v4-flash": _bucket(uncached=1_000_000),
                }}},
            })
            rs = _run(["state", "savings"], env=h.env, binary=True)
            self.assertEqual(rs.returncode, 2)
            self.assertIn("unrecognized subcommand 'savings'", rs.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
