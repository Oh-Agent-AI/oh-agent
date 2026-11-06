#!/usr/bin/env python3
"""`agent/plan.py::build_plan` 的交叉锁定测试 —— 与 Rust `plan.rs::build_plan` 对守。

`build_plan` 把 scan 报告派生为省钱方案。Python 侧钉到**具体数值**，与
`crates/agent-vitals-domain/src/domain/plan.rs` 里 `#[cfg(test)]` 单测的期望值逐一对应：
**同一份 fixture、同一组数字，两边各自断言**，docstring 互相指认。命令面差分
（同一 fixture 跑两边 CLI 逐字节比）另由 `tests/test_cli_matrix.py` 的
`both("plan", ...)` 看守。

诚实性规则（与 plan.rs docstring 逐字对齐）：
1. `savings_per_event` 永远是测量值（token），不是估算。
2. `events_per_month` 只在 `--startup-rate` 提供时填；`usage_count` 是终身累计，
   **绝不**冒充每月数，单独暴露为 `measured_lifetime_triggers`。
3. `diagnosis_refs` 只引用 doctor 真实会发的 SV 码；量不到给 `[]`。
4. 方案是提案：risk 排序只是建议阅读顺序。

跑法：
    python3 -m unittest tests.test_plan_lockstep -v
"""

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "packages" / "agent-vitals-python"))

from agent_vitals.plan import build_plan  # noqa: E402


# 与 Rust `plan.rs::tests::full_report()` **逐字同一份 fixture**。改数字 = 两边
# 一起改，任何一边单独漂移都会让另一侧的测试失去参照。
def full_report():
    return {
        "schema_version": "1.0",
        "harness_selection": "claude-code",
        "description_budget": {"available": True, "over_by_chars": 0, "pct_used": 90},
        "trigger_data": {"available": True, "zombie_min_age_days": 14,
                         "zombie_candidates": [{"name": "z1", "tier1_tokens": 100}]},
        "structure": {"split_threshold_tokens": 6000,
                      "oversized": [{"name": "b1", "tier2_core_tokens": 9000}]},
        "conflicts": [{"name": "c1", "kind": "shadowed_newer", "severity": "high"}],
        "skills": [
            {"name": "z1", "loaded": True, "usage_count": 0, "tier1_tokens": 100,
             "description_chars": 40},
            {"name": "b1", "loaded": True, "usage_count": 12, "tier1_tokens": 50,
             "description_chars": 60},
            {"name": "n1", "loaded": True, "usage_count": 5, "tier1_tokens": 30,
             "description_chars": 30},
            {"name": "n2", "loaded": True, "usage_count": 2, "tier1_tokens": 40,
             "description_chars": 30},
        ],
    }


class PlanLockstep(unittest.TestCase):
    """镜像 Rust `plan.rs` 单测：同 fixture、同数字、同诚实性断言。"""

    def test_full_report(self):
        """完整报告 + startup_rate=30：loaded tier1 [100,50,30,40] → 排序 [30,40,50,100]，
        下中位数 idx1=40。期望顺序（risk 升序 → savings 降序 → 名升序）：
        disable-zombie:0 z1(100) → trim:0 z1(60) → trim:1 b1(10) → split:0 b1(3000)
        → resolve-shadow:0 c1(null)。pct_used=90 且 over_by=0 → budget 状态 SV001。"""
        p = build_plan(full_report(), startup_rate=30)
        self.assertEqual(p["schema_version"], "plan/1.0")
        self.assertEqual(p["harness_selection"], "claude-code")
        self.assertEqual(p["startup_rate_per_month"], 30)

        items = p["items"]
        self.assertEqual(len(items), 5)
        self.assertEqual([it["kind"] for it in items],
                         ["disable-zombie", "trim-description", "trim-description",
                          "split-oversized", "resolve-shadow"])
        self.assertEqual(items[0]["id"], "disable-zombie:0")
        self.assertEqual(items[0]["skill"], "z1")
        self.assertEqual(items[0]["risk"], "low")
        self.assertEqual(items[0]["savings_per_event"]["tokens"], 100)
        self.assertEqual(items[0]["events_per_month"], 30)
        self.assertEqual(items[0]["measured_lifetime_triggers"], 0)
        self.assertEqual(items[0]["diagnosis_refs"], ["SV201"])

        # trim-description:0 z1 省 100-40=60；diagnosis_refs 由 budget 状态定：
        # pct_used=90 → SV001（over_by=0 不发 SV002）。
        self.assertEqual(items[1]["savings_per_event"]["tokens"], 60)
        self.assertEqual(items[1]["diagnosis_refs"], ["SV001"])
        self.assertEqual(items[2]["savings_per_event"]["tokens"], 10)

        # split-oversized:0 省 9000-6000=3000，events_per_month 恒 null（终身数不冒充
        # 月数），终身触发数 12 单独暴露。
        self.assertEqual(items[3]["savings_per_event"]["tokens"], 3000)
        self.assertIsNone(items[3]["events_per_month"])
        self.assertEqual(items[3]["measured_lifetime_triggers"], 12)
        self.assertEqual(items[3]["diagnosis_refs"], ["SV301"])

        # resolve-shadow:0 无 savings 声称。
        self.assertIsNone(items[4]["savings_per_event"])
        self.assertEqual(items[4]["diagnosis_refs"], ["SV101"])

        self.assertEqual(p["summary"]["item_count"], 5)
        self.assertEqual(p["summary"]["savings_items"], 4)
        self.assertEqual(p["summary"]["top_3_moves"],
                         ["disable-zombie:0", "trim-description:0", "trim-description:1"])
        self.assertEqual(p["diagnosis_refs"], ["SV001", "SV101", "SV201", "SV301"])

    def test_no_trigger_never_fabricates_zombies(self):
        """trigger 证据不可用 → 绝不生成 disable-zombie（报不了 0 次就不报）。"""
        r = full_report()
        r["trigger_data"] = {"available": False, "zombie_candidates": []}
        p = build_plan(r)
        self.assertTrue(all(it["kind"] != "disable-zombie" for it in p["items"]))

    def test_no_loaded_skills_no_trim(self):
        """无 loaded skill → 中位数无定义 → 无 trim-description。"""
        r = full_report()
        for sk in r["skills"]:
            sk["loaded"] = False
        p = build_plan(r)
        self.assertTrue(all(it["kind"] != "trim-description" for it in p["items"]))

    def test_oversized_zero_usage_measured(self):
        """oversized 的 usage_count 测到 0 → lifetime 是 0（不是 null）；events 仍 null。"""
        r = full_report()
        r["skills"][1]["usage_count"] = 0
        p = build_plan(r)
        sp = next(it for it in p["items"] if it["kind"] == "split-oversized")
        self.assertEqual(sp["measured_lifetime_triggers"], 0)
        self.assertIsNone(sp["events_per_month"])

    def test_oversized_name_missing_events_null(self):
        """oversized name 在 skills[] 查不到 → lifetime 是 null（没测到不假装 0）。"""
        r = full_report()
        r["structure"]["oversized"] = [{"name": "ghost", "tier2_core_tokens": 9000}]
        p = build_plan(r)
        sp = next(it for it in p["items"] if it["kind"] == "split-oversized")
        self.assertIsNone(sp["measured_lifetime_triggers"])

    def test_startup_rate_null_when_not_given(self):
        """不传 startup_rate → per-startup 项 events_per_month 恒 null，顶层也是 null。"""
        p = build_plan(full_report())
        self.assertIsNone(p["startup_rate_per_month"])
        for it in p["items"]:
            if it["kind"] in ("disable-zombie", "trim-description"):
                self.assertIsNone(it["events_per_month"])

    def test_trim_refs_empty_when_budget_unavailable(self):
        """budget unavailable → trim 项 diagnosis_refs 空（不编码）。"""
        r = full_report()
        r["description_budget"] = {"available": False}
        p = build_plan(r)
        trims = [it for it in p["items"] if it["kind"] == "trim-description"]
        self.assertTrue(trims)
        for it in trims:
            self.assertEqual(it["diagnosis_refs"], [])

    def test_deterministic(self):
        """确定性：同输入跑两次，输出逐字节相同。"""
        a = json.dumps(build_plan(full_report(), startup_rate=30), sort_keys=True)
        b = json.dumps(build_plan(full_report(), startup_rate=30), sort_keys=True)
        self.assertEqual(a, b)


if __name__ == "__main__":
    unittest.main()
