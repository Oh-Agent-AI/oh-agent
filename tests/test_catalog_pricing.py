#!/usr/bin/env python3
"""catalog_2026_09（Claude Code 语料计价）纯函数钉测。

与 `crates/agent-vitals-domain/src/domain/cost/mod.rs` 里同夹具同数的 inline 测试互守——
同一组数字在两侧各钉一遍（与 tests/test_cost_priced_day.py 同款交叉引用模式），
命令级差分等 claude-sync 落地后由 test_claude_cost.py 的 `both()` 补。

口径（2026-09-02 审阅裁决后的实施态）：
- 新面 = 独立的第二计价面，输出全量标 pricing_basis="catalog"，不碰
  cost_report/priced_day 等 DSH 路径（那些在既有测试里，字节不变）。
- 计价输入统一 claude 4 型 snake 键名；`claude_session_cost` 只做 cost-state
  camel → snake 键名转换，不重算。
- 未知模型 `<synthetic>` 等 → 四型全进 unpriced（含 output——与 cost_report
  的 unpriced 词表不同是有意的，见 cost.py::_price_claude_map 注释）。
- 缓存写（cache_creation）走 1h 档（harness_costusd_note：Claude Code 自报
  costUSD 按 1h 计），无 1h 档的卡各取各的（M2.7 cache_write / deepseek 0）。
- MiniMax-M3 tiers 一律取首档（≤512K）并把档位标签透出。
"""

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# 与 test_cost_priced_day.py 同款：agent_vitals 包按 scripts/ 相对导入
# （agent/__init__ 链上有绝对导入，不插 scripts/ 会 ModuleNotFoundError）。
sys.path.insert(0, str(ROOT / "packages" / "agent-vitals-python"))

from agent_vitals.agent.cost import (  # noqa: E402
    claude_day_cost,
    claude_session_cost,
    claude_subscription_uncovered_estimate,
    load_pricing,
    cache_counterfactual_cost,
)


class CatalogResolveCase(unittest.TestCase):
    def setUp(self):
        self.pricing = load_pricing()

    def test_resolve_hits_and_misses(self):
        from agent_vitals.agent.cost import _resolve_card_catalog

        self.assertEqual(_resolve_card_catalog("claude-opus-5", self.pricing),
                         ("anthropic", "claude-opus-5", "USD"))
        self.assertEqual(_resolve_card_catalog("deepseek-v4-pro[1M]", self.pricing),
                         ("deepseek-official", "deepseek-v4-pro", "CNY"))
        self.assertEqual(_resolve_card_catalog("deepseek/deepseek-v4-pro-0813",
                                               self.pricing)[:3:2],
                         ("deepseek-official", "CNY"))
        provider, _, currency = _resolve_card_catalog("moonshot/kimi-k3",
                                                      self.pricing)
        self.assertEqual((provider, currency), ("moonshot", "USD"))
        self.assertIsNone(_resolve_card_catalog("<synthetic>", self.pricing))
        self.assertIsNone(_resolve_card_catalog("some/unknown-model", self.pricing))

    def test_missing_quote_currency_is_not_guessed_from_provider(self):
        from agent_vitals.agent.cost import _resolve_card_catalog

        pricing = {"providers": {"legacy": {"models": {"legacy-model": {
            "input_uncached": 1, "input_cached": 0, "output": 1,
        }}}}}
        self.assertIsNone(_resolve_card_catalog("legacy-model", pricing))


class ClaudeSessionCostCase(unittest.TestCase):
    """夹具与 cost.rs::tests 的同名测试同数（互守，见文件头）。"""

    def setUp(self):
        self.pricing = load_pricing()

    def test_deepseek_variant_at_official_cny_card(self):
        # deepseek-v4-pro 是时变卡（{off_peak, peak}）——`claude_session_cost`
        # 用的是 cost-state 累计口径，没有逐行 ts、给不了峰谷分辨率，v0.6.x
        # 前置热修后这里如实报 "partial"（全按 off_peak 4.5 算，不再假装是
        # 账单级精确的 "catalog"）；数值本身不变，改的只是诚实性标注。
        out = claude_session_cost({
            "deepseek-v4-pro[1M]": {"inputTokens": 1000000, "outputTokens": 0,
                                    "cacheReadInputTokens": 0,
                                    "cacheCreationInputTokens": 0},
        }, self.pricing)
        self.assertIsNotNone(out)
        self.assertAlmostEqual(out["currency_totals"]["CNY"], 4.5)
        self.assertEqual(out["currency_totals"]["USD"], 0.0)
        pm = out["per_model"]["deepseek-v4-pro[1M]"]
        self.assertEqual(pm["pricing_basis"], "partial")
        self.assertEqual(out["pricing_basis"], "partial")
        self.assertEqual(pm["priced_with"], "deepseek-official")
        self.assertEqual(pm["currency"], "CNY")
        self.assertNotIn("tier", pm)

    def test_anthropic_all_four_token_types(self):
        out = claude_session_cost({
            "claude-opus-5": {"inputTokens": 1000000, "outputTokens": 500000,
                              "cacheReadInputTokens": 1000000,
                              "cacheCreationInputTokens": 1000000},
        }, self.pricing)
        self.assertAlmostEqual(out["currency_totals"]["USD"], 28.0)
        self.assertEqual(out["unpriced_tokens"], 0)
        self.assertEqual(out["currency_totals"]["CNY"], 0.0)

    def test_m3_first_tier_and_label(self):
        out = claude_session_cost({
            "MiniMax-M3": {"inputTokens": 1000000, "outputTokens": 100000,
                           "cacheReadInputTokens": 0,
                           "cacheCreationInputTokens": 0},
        }, self.pricing)
        pm = out["per_model"]["MiniMax-M3"]
        self.assertEqual(pm["tier"], "≤512K input")
        self.assertAlmostEqual(out["currency_totals"]["CNY"], 2.94)

    def test_m27_cache_write_rate(self):
        out = claude_session_cost({
            "MiniMax-M2.7": {"inputTokens": 0, "outputTokens": 0,
                             "cacheReadInputTokens": 0,
                             "cacheCreationInputTokens": 1000000},
        }, self.pricing)
        self.assertAlmostEqual(out["currency_totals"]["CNY"], 2.625)

    def test_splits_two_currencies(self):
        out = claude_session_cost({
            "claude-sonnet-5": {"inputTokens": 2000000, "outputTokens": 0,
                                "cacheReadInputTokens": 0,
                                "cacheCreationInputTokens": 0},
            "deepseek-v4-flash": {"inputTokens": 2000000, "outputTokens": 0,
                                  "cacheReadInputTokens": 0,
                                  "cacheCreationInputTokens": 0},
        }, self.pricing)
        self.assertAlmostEqual(out["currency_totals"]["CNY"], 3.0)
        self.assertAlmostEqual(out["currency_totals"]["USD"], 6.0)
        self.assertEqual(list(out["per_model"]),
                         ["claude-sonnet-5", "deepseek-v4-flash"])

    def test_unknown_model_unpriced_all_four_types(self):
        out = claude_session_cost({
            "<synthetic>": {"inputTokens": 1000, "outputTokens": 40,
                            "cacheReadInputTokens": 10,
                            "cacheCreationInputTokens": 5},
        }, self.pricing)
        self.assertEqual(len(out["per_model"]), 0)
        self.assertEqual(out["unpriced_tokens"], 1055)
        self.assertEqual(out["currency_totals"]["CNY"], 0.0)
        self.assertEqual(out["currency_totals"]["USD"], 0.0)

    def test_none_when_no_usage(self):
        self.assertIsNone(claude_session_cost({}, self.pricing))
        self.assertIsNone(claude_session_cost(None, self.pricing))

    def test_day_and_session_costs_agree(self):
        """日面与 cost-state 面对同一批 token 必须报同一个数（同一个
        _price_claude_map，只差键名转换）。日面再验证 by_model 包一层与 flat
        直图（claude_cost.py rebuild_days 真机形状）两种形状同 tokens 同价。"""
        wrapped = {"by_model": {"claude-sonnet-5": {
            "input_tokens": 2000000, "cache_read_input_tokens": 1000000,
            "cache_creation_input_tokens": 0, "output_tokens": 100000}}}
        flat = {"claude-sonnet-5": {
            "input_tokens": 2000000, "cache_read_input_tokens": 1000000,
            "cache_creation_input_tokens": 0, "output_tokens": 100000}}
        sess = {"claude-sonnet-5": {
            "inputTokens": 2000000, "cacheReadInputTokens": 1000000,
            "cacheCreationInputTokens": 0, "outputTokens": 100000}}
        report = claude_session_cost(sess, self.pricing)
        self.assertIsNotNone(report)
        self.assertEqual(claude_day_cost(wrapped, self.pricing), report,
                         "by_model 包一层日面与 cost-state 面必须同数")
        self.assertEqual(claude_day_cost(flat, self.pricing), report,
                         "flat 直图日面（rebuild_days 真实形状）必须同数")

    def test_day_cost_none_without_models(self):
        """没有任何模型可计价的日子 → None。两种空形状（flat {} / by_model 空
        壳）与非对象一律 None——flat 空对象不该因为「变成 flat 了」就报全零账。"""
        self.assertIsNone(claude_day_cost({}, self.pricing))
        self.assertIsNone(claude_day_cost({"by_model": {}}, self.pricing))
        self.assertIsNone(claude_day_cost(None, self.pricing))


class PricingJsonShapeCase(unittest.TestCase):
    """价表形状是引擎的输入契约——结构漂移要在钉测里炸，不能在真机上静默
    算出 0（2026-09-02 P4.5 RolloutItem schema-drift sentinel 同款纪律）。"""

    def setUp(self):
        with (ROOT / "assets" / "pricing.json").open(encoding="utf-8") as f:
            self.pricing = json.load(f)

    def test_catalog_cards_flat_or_tiered(self):
        cat = self.pricing["catalog_2026_09"]["providers"]
        for provider, pv in cat.items():
            self.assertIn("currency", pv, provider)
            for model, card in pv["models"].items():
                if "tiers" in card:
                    for tier in card["tiers"]:
                        for k in ("input_uncached", "input_cached", "output"):
                            self.assertIsInstance(tier[k], (int, float),
                                                  f"{provider}/{model} tier")
                else:
                    for k in ("input_uncached", "input_cached", "output"):
                        self.assertIsInstance(card[k], (int, float),
                                              f"{provider}/{model}")

    def test_public_catalog_contains_no_user_financial_declarations(self):
        cat = self.pricing["catalog_2026_09"]
        self.assertNotIn("subscriptions", cat)
        serialized = json.dumps(cat, ensure_ascii=False).lower()
        for private_marker in ("user-reported", "apple_subscription",
                               "billing_period_start", "reported_at"):
            self.assertNotIn(private_marker, serialized)
        modes = cat.get("billing_modes", {})
        self.assertTrue(all(v.get("mode") == "metered"
                            for k, v in modes.items() if not k.startswith("_")))


class ClaudeSubscriptionUncoveredEstimateCase(unittest.TestCase):
    """v0.7 spec §3 交付矩阵第二行——夹具与 cost.rs::tests 的同名测试同数。"""

    def setUp(self):
        self.pricing = load_pricing()

    def test_flags_unsubscribed_provider(self):
        """deepseek-official 没有 catalog_2026_09 订阅登记 → 全部落进本视图。"""
        models = {"deepseek-v4-flash": {
            "input_tokens": 1_000_000, "output_tokens": 0,
            "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}}
        out = claude_subscription_uncovered_estimate(models, self.pricing)
        self.assertIsNotNone(out)
        self.assertEqual(out["pricing_basis"], "estimated-subscription-exclusion")
        self.assertEqual(
            out["per_model"]["deepseek-v4-flash"]["pricing_basis"],
            "estimated-subscription-exclusion")
        self.assertAlmostEqual(out["currency_totals"]["CNY"], 1.5)

    def test_public_catalog_does_not_assume_anthropic_subscription(self):
        """干净安装没有用户套餐声明，Anthropic 仍进入按量参考估算。"""
        models = {"claude-opus-5": {
            "input_tokens": 1_000_000, "output_tokens": 0,
            "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}}
        out = claude_subscription_uncovered_estimate(models, self.pricing)
        self.assertIsNotNone(out)
        self.assertAlmostEqual(out["currency_totals"]["USD"], 5.0)

    def test_none_without_models(self):
        self.assertIsNone(claude_subscription_uncovered_estimate({}, self.pricing))
        self.assertIsNone(claude_subscription_uncovered_estimate(None, self.pricing))


class NominalVsActualCostCase(unittest.TestCase):
    """v0.7 spec §3 交付矩阵第三行——夹具与 cost.rs::tests 的同名测试同数。"""

    def setUp(self):
        self.pricing = load_pricing()

    def _usage(self, uncached=0, cache_read=0):
        return {"by_model": {"deepseek-v4-flash": {
            "uncached_input_tokens": uncached, "output_tokens": 0,
            "cache_read_tokens": cache_read, "cache_write_tokens": 0,
            "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
            "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0,
        }}}

    def test_ratio_is_one_without_cache_hits(self):
        """无缓存命中的语料下 ratio 恒为 1.00（2026-09-02 实测值，spec 原文
        引用）——不是本函数的 bug。"""
        out = cache_counterfactual_cost(self._usage(uncached=1_000_000), self.pricing)
        self.assertIsNotNone(out)
        self.assertAlmostEqual(out["ratio"], 1.0)
        self.assertAlmostEqual(out["actual"], out["no_cache_counterfactual"])

    def test_ratio_reflects_cache_savings(self):
        """全部落在缓存命中：实测缓存节约 1/30（cached 0.05 vs uncached
        1.5）——spec §3 原文引用的具体信号，ratio 必须显著偏离 1。"""
        out = cache_counterfactual_cost(self._usage(cache_read=1_000_000), self.pricing)
        self.assertIsNotNone(out)
        self.assertAlmostEqual(out["ratio"], 1 / 30)

    def test_none_when_no_usage(self):
        self.assertIsNone(cache_counterfactual_cost({}, self.pricing))
        self.assertIsNone(cache_counterfactual_cost(None, self.pricing))


if __name__ == "__main__":
    unittest.main()
