"""模型名 → 价卡键匹配（`cost.py::_norm_model_in`）。

`CASES` 与 Rust `cost/mod.rs::norm_model_in_prefers_exact_then_longest_same_model_prefix`
逐行相同。2026-09-29 真机缺陷：旧写法「第一个前缀命中即返回」让 claude-opus-5-5
吃到了 claude-opus-5 的卡（按 $5/$25 计，官方 $4/$20，缓存读取贵 2.5 倍），而且
因为「有卡」，缺价信号永远不会出现。
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "packages" / "agent-vitals-python"))
from agent_vitals.agent.cost import _norm_model_in  # noqa: E402

CASES = [
    ("claude-opus-5-5", ["claude-opus-5"], None),
    ("claude-opus-5-5", ["claude-opus-5", "claude-opus-5-5"], "claude-opus-5-5"),
    ("claude-opus-5-20260401", ["claude-opus-5"], "claude-opus-5"),
    ("deepseek-v4-flash-0731", ["deepseek-v4-flash"], "deepseek-v4-flash"),
    ("deepseek-v4-pro-ga-260813", ["deepseek-v4-pro"], "deepseek-v4-pro"),
    ("deepseek/deepseek-v4-pro-0813", ["deepseek-v4-pro"], "deepseek-v4-pro"),
    ("gpt-5.1", ["gpt-5"], None),
    ("gpt-6-luna-pro", ["gpt-6-luna"], None),
    ("glm-5v-turbo", ["glm-5"], None),
    ("claude-sonnet-5[1m]", ["claude-sonnet-5"], "claude-sonnet-5"),
    ("MiniMax-M3", ["MiniMax-M", "MiniMax-M3"], "MiniMax-M3"),
    ("deepseek-v4-flash-0731", ["deepseek-v4", "deepseek-v4-flash"], "deepseek-v4-flash"),
]


class ModelMatchTests(unittest.TestCase):
    def test_cases_match_rust_table(self):
        for model, keys, want in CASES:
            with self.subTest(model=model, keys=keys):
                cards = {k: {"output": 1} for k in keys}
                self.assertEqual(_norm_model_in(model, cards), want)


if __name__ == "__main__":
    unittest.main()
