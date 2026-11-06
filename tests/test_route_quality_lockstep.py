# -*- coding: utf-8 -*-
"""route_quality 双语对拍：Python 实现断言 fixtures/route_quality/vectors.json，
Rust 侧（domain::route_quality 的 vectors_fixture_lockstep 测试）断言同一份
向量——两侧期望一致才允许词表变更过评审（与 enrichment 对拍同款纪律）。"""

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "packages" / "agent-vitals-python"))

from agent_vitals.agent.route_quality import (  # noqa: E402
    MODEL_FAMILIES,
    model_family,
    quality_flag,
)

VECTORS = ROOT / "fixtures" / "route_quality" / "vectors.json"


def load_vectors() -> list:
    with VECTORS.open("r", encoding="utf-8") as handle:
        return json.load(handle)["cases"]


class RouteQualityLockstepTest(unittest.TestCase):
    def test_vectors_lockstep(self):
        cases = load_vectors()
        self.assertGreater(len(cases), 20, "向量集意外过小——fixture 丢了？")
        for case in cases:
            with self.subTest(case=case["id"]):
                self.assertEqual(
                    model_family(case["input"]),
                    case["expected_family"],
                    f"family({case['input']!r})",
                )
                self.assertEqual(
                    quality_flag(case["harness"], case["input"]),
                    case["expected_flag"],
                    f"flag({case['harness']!r}, {case['input']!r})",
                )

    def test_families_form_closed_set(self):
        for case in load_vectors():
            self.assertIn(model_family(case["input"]), MODEL_FAMILIES)


if __name__ == "__main__":
    unittest.main()
