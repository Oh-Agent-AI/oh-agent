#!/usr/bin/env python3
"""v0.9 Stage 0.7 验收门：四执行环境最小接入契约语料
（`fixtures/v09/README.md` 的 §3.3 表 → 可执行断言）。

两层：

  · 语料形状（无需二进制）：每个 fixture 的字段词表与执行环境自己的桶词汇一致
    ——DSH 是 8 桶（4 桶 + peak_*），Claude Code 是 4 型 snake，Codex 是
    `last_token_usage` 6 字段。词表漂移（历史上真实发生过：DSH fixture 误用
    Claude 字段名导致 priced_day 静默算 0）在这一层直接红掉，不用等二进制。
  · 二进制对账（AGENT_VITALS_BIN 约定，同 test_r2a/test_data_summary_cli）：
    语料装进隔离 AGENT_VITALS_HOME / HOME → `data coverage --json` 逐执行环境
    断言 basis、summarable 归属、coverage、excluded_harnesses；`harnesses --json -`
    断言 WorkBuddy「声明且接线、只有 token 没有钱」（注册表有行 + by_harness 有行
    + amounts 空；E4b 之前是「声明但排除」）。

  运行：AGENT_VITALS_BIN=target/release/agent-vitals \\
        python3 -m unittest tests.test_v09_onboarding_fixtures
"""

import json
import os
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

from tests.env_helpers import isolated_home_env, seed_authority_facts

ROOT = Path(__file__).resolve().parent.parent
V09 = ROOT / "fixtures" / "v09"

_BIN = os.environ.get("AGENT_VITALS_BIN")
if _BIN:
    _BIN = str(Path(_BIN).resolve())

# 各执行环境自己的 token 桶词表（真相源：domain/harnesses 的 fold 代码；这里钉的是
# fixture 语料必须与之一致，词表本身漂移由 Rust/Python 侧各自的单测守）。
DSH_BUCKETS = {
    "uncached_input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens",
    "peak_uncached_input_tokens", "peak_output_tokens", "peak_cache_read_tokens",
    "peak_cache_write_tokens",
}
CLAUDE_SNAKE = {
    "input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens",
}


def _load(name):
    return json.loads((V09 / name).read_text())


class FixtureShapeTests(unittest.TestCase):
    """语料词表守卫：fixture 与执行环境桶词汇的一致性，不需要二进制。"""

    def test_dsh_fixture_uses_the_dsh_bucket_vocabulary(self):
        day = _load("dsh/month-day.json")["days"]["1970-01-01"]["by_model"]["deepseek-v4-flash"]
        self.assertEqual(set(day), DSH_BUCKETS)

    def test_claude_fixture_uses_the_claude_snake_vocabulary(self):
        day = _load("claude-code/ledger-day.json")["days"]["1970-01-01"]
        self.assertEqual(set(day["deepseek-v4-flash"]), CLAUDE_SNAKE)
        # <synthetic> 是 cost-state 的 unknown 占位：必须全零（非零就说明语料
        # 把真实消费混进了 unknown 桶，计价断言的前提就塌了）。
        self.assertEqual(set(day["<synthetic>"]), CLAUDE_SNAKE)
        self.assertEqual(sum(day["<synthetic>"].values()), 0)

    def test_codex_fixture_carries_last_token_usage(self):
        lines = [json.loads(l) for l in
                 (V09 / "codex" / "rollout-minimal.jsonl").read_text().splitlines() if l.strip()]
        kinds = [l["type"] for l in lines]
        self.assertEqual(kinds, ["session_meta", "turn_context", "event_msg"])
        token_counts = [l for l in lines if l.get("payload", {}).get("type") == "token_count"]
        self.assertEqual(len(token_counts), 1)
        last = token_counts[0]["payload"]["info"]["last_token_usage"]
        # 6 字段齐全 + 派生桶合法（uncached = input - cached - write ≥ 0）。
        for f in ("input_tokens", "output_tokens", "cached_input_tokens",
                  "cache_write_input_tokens", "reasoning_output_tokens", "total_tokens"):
            self.assertIn(f, last)
        self.assertGreaterEqual(
            last["input_tokens"] - last["cached_input_tokens"] - last["cache_write_input_tokens"], 0)
        # 占位日期：语料不携带时钟（README 的纪律），日期由测试写入时替换。
        self.assertTrue(lines[0]["timestamp"].startswith("1970-01-01"))


@unittest.skipUnless(_BIN, "未设 AGENT_VITALS_BIN，跳过 Rust 二进制用例")
class OnboardingContractBinaryTests(unittest.TestCase):
    """语料 → 真实二进制 `data coverage` / `harnesses --json` 的逐执行环境对账。"""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.home = Path(self._tmp.name)

    def run_cli(self, *argv):
        env = isolated_home_env(self.home)
        env["AGENT_VITALS_HOME"] = str(self.home / "data")
        proc = subprocess.run([_BIN, *argv], env=env, cwd=str(ROOT),
                              capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return proc.stdout

    def _plant_all_three_harnesses(self, month):
        """三执行环境各一条实时事实种进隔离权威库（Tier A：CLI 读
        `SqlSummaryRepository`——种子走 facts JSONL + `data-migrate`，state
        投影文件喂不到新读源）。账日取查询月 15 号（固定，避免与 freshness
        的今天/昨天判定互相依赖）。返回数据日。"""
        day = month + "-15"
        seed_authority_facts(_BIN, self.home, day)
        return day

    def test_three_harnesses_land_on_their_contract_basis(self):
        month = time.strftime("%Y-%m", time.gmtime(time.time() + 8 * 3600))
        day = self._plant_all_three_harnesses(month)
        d = json.loads(self.run_cli("data", "coverage", "--month", month, "--json"))

        dsh = d["by_harness"]["dsh"]
        self.assertIn("metered_actual", dsh["amounts_by_basis"])
        self.assertGreater(dsh["amounts_by_basis"]["metered_actual"], 0.0)
        self.assertEqual(dsh["freshness"]["last_observed_at"], day + "T00:00:00Z")

        claude = d["by_harness"]["claude-code"]
        # fixture 只放 CNY 卡模型 → 恰好 MeteredEstimate 一档（<synthetic> 全零
        # 桶不得产 second basis、也不得产 unpriced）。
        self.assertEqual(set(claude["amounts_by_basis"]), {"metered_estimate"})
        self.assertGreater(claude["amounts_by_basis"]["metered_estimate"], 0.0)
        self.assertFalse(claude["has_unresolved"])

        codex = d["by_harness"]["codex"]
        # The seed intentionally has no provider route evidence at all; the
        # harness aggregate therefore exposes no money bucket, only uncertainty.
        self.assertEqual(codex["amounts_by_basis"], {})
        self.assertTrue(codex["has_unresolved"])

        # spec §4 汇总纪律：只有 DSH 实测进总额，估算/诊断价不得混入。
        self.assertAlmostEqual(d["total_summable"],
                               dsh["amounts_by_basis"]["metered_actual"])
        self.assertEqual(d["coverage"],
                         {"measured_fields": 4, "total_fields": 4, "denominator_version": 1})
        self.assertEqual(d["excluded_harnesses"], [])

    def test_workbuddy_is_declared_and_wired_without_money(self):
        """E4b（docs/WORKBUDDY_ONBOARDING_SPEC.md §9E.5）之前这条叫「声明但排除」：
        capability 注册表认识它、summary 不从它取数。现在两半都变了一半：注册表
        仍认识它（声明面不动——`fold` 仍 None，它没有金钱折叠），summary **从它
        取 token**（by_harness 有行、不在 excluded）但**永不取钱**（amounts 空）。
        本用例没种 workbuddy 事实 → 行是 unavailable，不是 0。"""
        month = time.strftime("%Y-%m", time.gmtime(time.time() + 8 * 3600))
        self._plant_all_three_harnesses(month)
        d = json.loads(self.run_cli("data", "coverage", "--month", month, "--json"))
        self.assertEqual(d["excluded_harnesses"], [])
        self.assertIn("workbuddy", d["by_harness"])
        wb = d["by_harness"]["workbuddy"]
        self.assertEqual(wb["amounts_by_basis"], {})
        self.assertEqual(wb["freshness"]["state"], "unavailable")
        self.assertEqual(d["tokens_by_harness"]["workbuddy"]["total"], 0)

        harnesses = json.loads(self.run_cli("harnesses", "--json", "-"))
        rows = harnesses["harnesses"] if isinstance(harnesses, dict) else harnesses
        wb = [h for h in rows if h.get("id") == "workbuddy"]
        self.assertEqual(len(wb), 1, "capability 注册表必须仍有 workbuddy 行（声明面）")
        self.assertFalse(wb[0]["session_store"])
        self.assertIsNone(wb[0]["fold"])
        self.assertTrue(wb[0]["unmeasured_signals"], "声明面必须保留 unmeasured_signals")


if __name__ == "__main__":
    unittest.main()
