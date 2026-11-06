# -*- coding: utf-8 -*-
"""模型家族与「执行环境原生模型」判定 ——「测试」tab v2（被动路线质量分析）词表。

与 Rust 侧 ``crates/agent-vitals-domain/src/domain/route_quality.rs`` 双语对拍：
两侧断言同一份 ``fixtures/route_quality/vectors.json``。改词表 = 双语言一起过评审。
2026-09-20 转向决定的背景见 Rust 侧模块 doc（主动探针隔离在 cc-switch 型机器
上不成立，默认面改为分析已记录的 usage_facts.model_id 硬证据）。
"""

from __future__ import annotations

from typing import Optional, Tuple

MODEL_FAMILIES = (
    "anthropic",
    "openai",
    "deepseek",
    "glm",
    "minimax",
    "gemini",
    "qwen",
    "synthetic",
    "unknown",
)

_HARNESS_NATIVE: Tuple[Tuple[str, Tuple[str, ...]], ...] = (
    ("claude-code", ("anthropic",)),
    ("codex", ("openai",)),
    # DeepSeek Harness 官方渠道即 deepseek 系；经中转也可能换模型，基准仍成立。
    ("dsh", ("deepseek",)),
)


def _normalize(model_id: str) -> str:
    lowered = model_id.strip().lower()
    if "/" in lowered:
        base = lowered.rsplit("/", 1)[1]
        if base:
            return base
    return lowered


def model_family(model_id: str) -> str:
    base = _normalize(model_id)
    if not base:
        return "unknown"
    if base == "<synthetic>":
        return "synthetic"
    head = base.split("-", 1)[0]
    if head in ("o1", "o3", "o4"):
        return "openai"
    # (前缀, 家族) 顺序即优先级——与 Rust 侧同序，测试向量钉住。
    prefixes = (
        ("claude", "anthropic"),
        ("chatgpt", "openai"),
        ("gpt", "openai"),
        ("deepseek", "deepseek"),
        ("glm", "glm"),
        ("minimax", "minimax"),
        ("gemini", "gemini"),
        ("qwen", "qwen"),
    )
    for prefix, family in prefixes:
        if base.startswith(prefix):
            return family
    return "unknown"


def harness_native_families(harness: str) -> Optional[Tuple[str, ...]]:
    for known, families in _HARNESS_NATIVE:
        if harness == known:
            return families
    return None


def quality_flag(harness: str, model_id: str) -> str:
    return family_flag(harness, model_family(model_id))


def family_flag(harness: str, family: str) -> str:
    """家族级标记（聚合层用——族名不是模型串，与 Rust 侧同一定义点）。"""
    if family == "synthetic":
        return "api_error"
    native = harness_native_families(harness)
    if native is None:
        return "no_baseline"
    return "native" if family in native else "non_native"

