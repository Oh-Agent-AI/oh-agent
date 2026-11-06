#!/usr/bin/env python3
"""v0.9 Stage 0.5 验收门：`agent-vitals data coverage` / `data daily` 只读
CLI 面（`docs/AGENT_VITALS_V0_9_STAGE0_RESEARCH.md` §9「下一步」）。

只测 Rust 二进制（Rust-only 命令，无 Python 镜像可差分——同 test_r2a 的
二进制用例约定，未设 `AGENT_VITALS_BIN` 时整体 skip）：

  · 空环境（隔离 HOME + 隔离 AGENT_VITALS_HOME）→ 四执行环境全部
    `unavailable`、`excluded_harnesses == []`（WorkBuddy 自 E4b 起接线，见
    docs/WORKBUDDY_ONBOARDING_SPEC.md §9E.5）、coverage 4/4、
    `total_summable` 是**正零**（-0.0 是 Stage 0.5 落地时实测修掉的形状，
    domain `summable_total` 的 fold 注释）——spec §0.1「不得渲染为 ¥0」的
    JSON/文本两半都钉。
    · 三执行环境全数据端到端：facts JSONL（deepseek-v4-flash ×2 + gpt-5.6-sol）
      经 `data-migrate` 种进隔离权威库 → `metered_actual` 且计入
      total_summable（DSH）；`metered_estimate` 且**不**计入 total_summable
      （claude）；缺少 provider/官方订阅路由 scope 证据的 Codex 保持
      unresolved 且不产生金额桶，不冒充 `api_equivalent`。种子走
    公开迁移入口是 Phase 3.5 Tier A 切读源后的形态——`data coverage` 读
    `SqlSummaryRepository`，state 投影文件喂不到它。三执行环境 basis 各就各位
    是 0.4a/0.4b/0.4c 三次接线决策（§8.4）经 CLI 的最终对账。
  · 历史月份/缺席日 → unavailable，不是 0。

  运行：AGENT_VITALS_BIN=target/release/agent-vitals \\
        python3 -m unittest tests.test_data_summary_cli
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

_BIN = os.environ.get("AGENT_VITALS_BIN")
if _BIN:
    _BIN = str(Path(_BIN).resolve())


def _beijing_today() -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(time.time() + 8 * 3600))


def _beijing_month() -> str:
    return _beijing_today()[:7]


@unittest.skipUnless(_BIN, "未设 AGENT_VITALS_BIN，跳过 Rust 二进制用例")
class DataSummaryCliTests(unittest.TestCase):
    def run_cli(self, home, *argv):
        env = isolated_home_env(home)
        env["AGENT_VITALS_HOME"] = str(Path(home) / "data")
        proc = subprocess.run(
            [_BIN, *argv], env=env, cwd=str(ROOT),
            capture_output=True, text=True,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return proc.stdout

    def coverage_json(self, home, month):
        return json.loads(self.run_cli(home, "data", "coverage", "--month", month, "--json"))

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.home = Path(self._tmp.name)

    def test_empty_month_reports_unavailable_not_zero(self):
        d = self.coverage_json(self.home, "2020-01")
        self.assertEqual(sorted(d["by_harness"].keys()),
                         ["claude-code", "codex", "dsh", "workbuddy"])
        for harness, row in d["by_harness"].items():
            self.assertEqual(row["freshness"]["state"], "unavailable", harness)
            self.assertIsNone(row["freshness"]["last_observed_at"], harness)
            self.assertEqual(row["amounts_by_basis"], {}, harness)
        # E4b：四执行环境全接线，excluded 是空集（WorkBuddy 只有 token、没有金额，
        # 但那是 by_harness 行内的 has_unresolved，不是 excluded）。
        self.assertEqual(d["excluded_harnesses"], [])
        self.assertEqual(d["coverage"], {"measured_fields": 4, "total_fields": 4,
                                         "denominator_version": 1})
        # 修过的 -0.0：JSON 里必须是正零（serde_json 会把 -0.0 原样序列化）。
        self.assertEqual(d["total_summable"], 0.0)
        self.assertNotIn("-0.0", json.dumps(d))

    def test_empty_month_text_never_renders_zero_for_missing(self):
        out = self.run_cli(self.home, "data", "coverage", "--month", "2020-01")
        self.assertIn("no data (unavailable)", out)
        self.assertIn("excluded harnesses: (none)", out)
        self.assertIn("coverage 4/4", out)

    def test_three_harnesses_report_their_own_basis(self):
        month = _beijing_month()
        today = _beijing_today()
        # Tier A（Phase 3.5）：CLI 读 SQL 权威库——种子经 facts JSONL +
        # `data-migrate`（spec 6.2.1 公开迁移入口）入库。旧的 state 投影
        # fixture（month.json 8 桶 / claude-ledger.json 4 型 snake / codex
        # rollout）只喂 JsonSummaryRepository，切读源后喂不到这条消费链。
        seed_authority_facts(_BIN, self.home, today)

        d = self.coverage_json(self.home, month)
        dsh = d["by_harness"]["dsh"]
        claude = d["by_harness"]["claude-code"]
        codex = d["by_harness"]["codex"]
        # DSH 实测账单档；claude 估算档；Codex 缺官方订阅 scope 证据时为
        # 保守估算档（§8.4 与 billing fallback 纪律）。
        self.assertGreater(dsh["amounts_by_basis"]["metered_actual"], 0.0)
        self.assertGreater(claude["amounts_by_basis"]["metered_estimate"], 0.0)
        self.assertEqual(codex["amounts_by_basis"], {})
        self.assertTrue(codex["has_unresolved"])
        self.assertEqual(dsh["freshness"]["state"], "fresh")
        # 三执行环境都种在今天 → fresh（codex 只钉"不是 unavailable"，不给
        # freshness 阈值钉死，跨日界运行时不因阈值语义翻红）。
        self.assertEqual(claude["freshness"]["state"], "fresh")
        self.assertNotEqual(codex["freshness"]["state"], "unavailable")
        # 汇总口径：总额只收 DSH 实测（估算/诊断价不冒充账单——spec §4）。
        self.assertAlmostEqual(d["total_summable"],
                               dsh["amounts_by_basis"]["metered_actual"])
        # 全部执行环境在 by_harness，无临时排除；workbuddy 没种数据 → unavailable，不是 0。
        self.assertEqual(d["excluded_harnesses"], [])
        self.assertEqual(d["by_harness"]["workbuddy"]["freshness"]["state"], "unavailable")

    def test_absent_day_is_unavailable_not_zero(self):
        d = json.loads(self.run_cli(self.home, "data", "daily",
                                    "--date", "2020-01-01", "--json"))
        for harness, row in d["by_harness"].items():
            self.assertEqual(row["freshness"]["state"], "unavailable", harness)
            self.assertEqual(row["amounts_by_basis"], {}, harness)


if __name__ == "__main__":
    unittest.main()
