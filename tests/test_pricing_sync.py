"""scripts/pricing_sync.py 的规则单测（合成三源数据，不联网）。

每条规则都对应一个真实踩过或实测到的坑：OpenRouter 漏新模型、DeepSeek 三源互相
矛盾、本地手工卡按过期公告写错 Sonnet 5、gpt-5.2 照抄了 5.1 的价——见脚本 docstring。
"""
import importlib.util
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("pricing_sync", ROOT / "scripts" / "pricing_sync.py")
ps = importlib.util.module_from_spec(_spec)
sys.modules["pricing_sync"] = ps
_spec.loader.exec_module(ps)

M = 1e-6  # 每百万 → 每 token


def md_model(inp, cr, out, cw=None):
    cost = {"input": inp, "output": out}
    if cr is not None:
        cost["cache_read"] = cr
    if cw is not None:
        cost["cache_write"] = cw
    return {"cost": cost}


def ll_entry(provider, inp, cr, out):
    e = {"litellm_provider": provider, "input_cost_per_token": inp * M, "output_cost_per_token": out * M}
    if cr is not None:
        e["cache_read_input_token_cost"] = cr * M
    return e


def or_model(oid, inp, cr, out):
    p = {"prompt": str(inp * M), "completion": str(out * M)}
    if cr is not None:
        p["input_cache_read"] = str(cr * M)
    return {"id": oid, "pricing": p}


BASE_PRICING = {
    "catalog_2026_09": {"providers": {
        "anthropic": {"currency": "USD", "models": {
            "claude-sonnet-5": {"input_uncached": 3.0, "input_cached": 0.3, "output": 15.0,
                                "cache_write_5min": 3.75, "cache_write_1hr": 6.0},
            "claude-opus-5": {"input_uncached": 5.0, "input_cached": 0.5, "output": 25.0,
                              "cache_write_5min": 6.25, "cache_write_1hr": 10.0},
        }},
        "zai": {"currency": "CNY", "models": {}},
    }},
}
BASE_CODEX = {"entries": [
    {"modelPrefix": "gpt-5.2", "speed": "standard", "uncachedInputUsdPerMTok": "1.25",
     "cacheReadUsdPerMTok": "0.125", "outputUsdPerMTok": "10", "longContextThresholdTokens": 272000},
]}


def sources(md=None, ll=None, orr=None):
    return {"models.dev": md or {}, "litellm": ll or {}, "openrouter": {"data": orr or []}}


def build(src, base_pricing=BASE_PRICING, base_codex=BASE_CODEX):
    return ps.build_overlay(src, base_pricing, base_codex)


class ConsensusTests(unittest.TestCase):
    def test_new_model_needs_two_agreeing_sources_and_gets_anthropic_cache_writes(self):
        src = sources(
            md={"anthropic": {"models": {"claude-opus-5-5": md_model(4, 0.2, 20)}}},
            ll={"claude-opus-5-5": ll_entry("anthropic", 4, 0.2, 20)},
        )
        card = build(src)["catalog"]["anthropic"]["models"]["claude-opus-5-5"]
        self.assertEqual((card["input_uncached"], card["input_cached"], card["output"]), (4.0, 0.2, 20.0))
        # 源里没有缓存写入价 → 按官方 1.25× / 2× 推算，不能留空（留空计价按 0）
        self.assertEqual((card["cache_write_5min"], card["cache_write_1hr"]), (5.0, 8.0))
        self.assertEqual(card["_sync"], {"kind": "new", "agreed_by": ["litellm", "models.dev"]})

    def test_single_source_is_not_enough(self):
        """OpenRouter 单源（或任一单源）报出的价不能发布——一家出错就会改动所有用户的金额。"""
        src = sources(orr=[or_model("anthropic/claude-opus-5-5", 4, 0.2, 20)])
        self.assertNotIn("anthropic", build(src)["catalog"])

    def test_disagreeing_sources_are_rejected_not_averaged(self):
        """DeepSeek 实测三源三个价：不取平均、不取多数外的任何一个，列进 rejected。"""
        src = sources(
            md={"anthropic": {"models": {"claude-x-1": md_model(1, 0.1, 5)}}},
            ll={"claude-x-1": ll_entry("anthropic", 2, 0.2, 9)},
            orr=[or_model("anthropic/claude-x-1", 3, 0.3, 11)],
        )
        overlay = build(src)
        self.assertNotIn("anthropic", overlay["catalog"])
        self.assertEqual(overlay["rejected"][0]["model"], "claude-x-1")

    def test_all_sources_missing_cache_read_uses_input_price(self):
        src = sources(
            md={"openai": {"models": {"gpt-5-pro": md_model(15, None, 120)}}},
            ll={"gpt-5-pro": ll_entry("openai", 15, None, 120)},
        )
        entry = build(src)["codex_entries"][0]
        self.assertEqual(entry["cacheReadUsdPerMTok"], "15")

    def test_conflicting_cache_read_is_rejected(self):
        src = sources(
            md={"openai": {"models": {"gpt-5-x": md_model(1, 0.1, 5)}}},
            ll={"gpt-5-x": ll_entry("openai", 1, 0.5, 5)},
        )
        overlay = build(src)
        self.assertEqual(overlay["codex_entries"], [])
        self.assertIn("cache_read", overlay["rejected"][0]["reason"])


class BaseComparisonTests(unittest.TestCase):
    def test_price_change_overrides_base(self):
        """Sonnet 5：底表按过期公告写了 $3/$15，三源一致为 $2/$10 → 叠加层改价。"""
        src = sources(
            md={"anthropic": {"models": {"claude-sonnet-5": md_model(2, 0.2, 10)}}},
            ll={"claude-sonnet-5": ll_entry("anthropic", 2, 0.2, 10)},
        )
        card = build(src)["catalog"]["anthropic"]["models"]["claude-sonnet-5"]
        self.assertEqual(card["_sync"]["kind"], "update")
        self.assertEqual(card["output"], 10.0)

    def test_matching_base_produces_no_overlay_entry(self):
        src = sources(
            md={"anthropic": {"models": {"claude-opus-5": md_model(5, 0.5, 25)}}},
            ll={"claude-opus-5": ll_entry("anthropic", 5, 0.5, 25)},
        )
        self.assertEqual(build(src)["catalog"], {})

    def test_change_beyond_5x_is_rejected(self):
        src = sources(
            md={"anthropic": {"models": {"claude-opus-5": md_model(50, 5, 250)}}},
            ll={"claude-opus-5": ll_entry("anthropic", 50, 5, 250)},
        )
        overlay = build(src)
        self.assertEqual(overlay["catalog"], {})
        self.assertIn("5 倍", overlay["rejected"][0]["reason"])

    def test_zero_price_is_rejected(self):
        src = sources(
            md={"anthropic": {"models": {"claude-free": md_model(0, 0, 0)}}},
            ll={"claude-free": ll_entry("anthropic", 0, 0, 0)},
        )
        self.assertIn("为 0", build(src)["rejected"][0]["reason"])

    def test_codex_update_keeps_base_fields_sources_cannot_give(self):
        """gpt-5.2 底表照抄了 5.1 的价；改价时长上下文阈值这类三源给不出的字段要保留。"""
        src = sources(
            md={"openai": {"models": {"gpt-5.2": md_model(1.75, 0.175, 14)}}},
            ll={"gpt-5.2": ll_entry("openai", 1.75, 0.175, 14)},
        )
        entry = build(src)["codex_entries"][0]
        self.assertEqual((entry["uncachedInputUsdPerMTok"], entry["outputUsdPerMTok"]), ("1.75", "14"))
        self.assertEqual(entry["longContextThresholdTokens"], 272000)
        self.assertEqual(entry["_sync"]["kind"], "update")

    def test_non_usd_base_provider_is_left_alone(self):
        """底表是人民币卡的服务商不叠加美元价：同一服务商混币会直接算错钱。"""
        src = sources(
            md={"zai": {"models": {"glm-5.3": md_model(1.4, 0.26, 4.4)}}},
            ll={"zai/glm-5.3": ll_entry("zai", 1.4, 0.26, 4.4)},
        )
        self.assertEqual(build(src)["catalog"], {})


class SourceFilteringTests(unittest.TestCase):
    def test_litellm_route_prices_are_ignored(self):
        """Azure / Bedrock 是路由价，不是原厂价：按 litellm_provider 过滤。"""
        src = sources(
            md={"openai": {"models": {"gpt-6-luna": md_model(0.1, 0.01, 0.5)}}},
            ll={"azure/gpt-6-luna": ll_entry("azure", 0.1, 0.01, 0.5)},
        )
        self.assertEqual(build(src)["codex_entries"], [])

    def test_openrouter_dotted_anthropic_ids_map_to_dashes(self):
        src = sources(
            md={"anthropic": {"models": {"claude-sonnet-5-5": md_model(2, 0.2, 10)}}},
            orr=[or_model("anthropic/claude-sonnet-5.5", 2, 0.2, 10)],
        )
        card = build(src)["catalog"]["anthropic"]["models"]["claude-sonnet-5-5"]
        self.assertEqual(card["_sync"]["agreed_by"], ["models.dev", "openrouter"])

    def test_variant_ids_are_skipped(self):
        src = sources(
            md={"openai": {"models": {"gpt-6-luna-2026-09-22": md_model(0.1, 0.01, 0.5)}}},
            ll={"gpt-6-luna-2026-09-22": ll_entry("openai", 0.1, 0.01, 0.5)},
            orr=[or_model("openai/gpt-6-luna:batch", 0.1, 0.01, 0.5)],
        )
        self.assertEqual(build(src)["codex_entries"], [])


class FinalizeTests(unittest.TestCase):
    def test_unchanged_content_keeps_date_and_reports_no_change(self):
        """内容不变不能每天改 updated_at，否则 CI 每天都会产生一个空提交。"""
        overlay = build(sources())
        first, changed = ps.finalize(overlay, None, "2026-09-29")
        self.assertTrue(changed)
        second, changed = ps.finalize(overlay, first, "2026-09-30")
        self.assertFalse(changed)
        self.assertEqual(second["updated_at"], "2026-09-29")


if __name__ == "__main__":
    unittest.main()
