"""Skill Vitals 静态体检子面：SKILL.md 扫描器 + 安装时执行环境适配器。

对应 Rust `src/skills/`。与 `agent/` 的边界见 package 顶层 docstring——
**「skill 体检」是静态资产审计（本子包），「skill 执行」是会话内审计
（agent/behavior.py，吃 core 的轨迹规则）**，两者都叫 skill，永远不该混在同一
子树里（tests/test_classification.py 钉住这条边界）。

re-export 本子包的模块名，让 `from agent_vitals.skills import doctor` 可用；
顶层 `agent_vitals/__init__.py` 再把这些名字抬到包级，兼容既有扁平导入。
"""

from . import (
    analysis,
    diff,
    discovery,
    doctor,
    explain,
    frontmatter,
    inventory,
    lifecycle,
    overlap,
    redact,
    report,
    security,
    snapshots,
)

__all__ = [
    "analysis",
    "diff",
    "discovery",
    "doctor",
    "explain",
    "frontmatter",
    "inventory",
    "lifecycle",
    "overlap",
    "redact",
    "report",
    "security",
    "snapshots",
]
