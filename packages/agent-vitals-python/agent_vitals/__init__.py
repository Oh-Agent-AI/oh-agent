"""Importable implementation package for the Agent Vitals Python CLI."""

# 工具版本，也是**发布版本的唯一来源**。
#
# 曾经它和 ClawHub 上的版本各走各的：ClawHub 的版本号取自 git tag，这里长期停在
# 0.1.0，于是装了 1.0.6 的用户跑 `--version` 看到的是 0.1.0 —— 报 bug 时引用的
# 版本号全是错的，没法对应到任何一次发布。
#
# 曾由 package-clawhub.yml 在发布前校验 tag 与这里一致；2026-10 起 skill 体检不再
# 从本仓库 CI 发布（后续迁出），该工作流已删，这一行仍是 `--version` 的来源。
#
# 与 SCHEMA_VERSION（在 cli.py）无关：工具可以升版而 JSON schema 不变。
# rust 分支上 Cargo.toml 的 version 必须跟这里一致，否则两个实现无法用同一条
# `--version` 区分；tests/test_regressions.py 在有 Cargo.toml 时会断言。
__version__ = "1.4.0"

# 两个子包：skills/（静态 SKILL.md 体检）+ agent/（会话行为/成本审计）。
#
# **不 import compat / cli** —— 两者用绝对路径引用下面的模块名（如 compat.py 的
# `from agent_vitals.analysis import …`）。若在这里提前 import 它们，会撞上
# 「包初始化到一半、模块名还没绑好」的循环导入。它们作为子模块被 scan.py /
# cli 在包完整初始化后再加载，`import agent_vitals.compat` 不需要包属性。
#
# 顺序有讲究：先 import 两个子包，**再把子包的模块名抬到包级**，之后任何
# `from agent_vitals import doctor` / `from agent_vitals.behavior import Coords`
# 的既有扁平导入（tests/、cli.py、compat.py 大量这么写）都能解析到模块对象。
# `from package import module` 拿到的就是模块对象，两个路径指向同一份代码。
from . import agent, skills  # noqa: E402

from .agent import (  # noqa: E402
    behavior,
    budget,
    canonical_audit,
    claude_cost,
    claude_evidence,
    claude_session_audit,
    codex_cost,
    codex_evidence,
    codex_session_audit,
    codex_usage,
    compaction,
    cost,
    dsh_evidence,
    duration,
    enrichment,
    harness_capability,
    plan,
    skill,
    state,
    subagent,
    takeover,
    trajectory,
    usage,
    waste,
    workbuddy_evidence,
    workbuddy_session_audit,
)
from .skills import (  # noqa: E402
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

# 点路径解析（`from agent_vitals.doctor import X` / compat.py 的
# `from agent_vitals.analysis import …`）在**模块查找层**发生，属性层只在
# `from agent_vitals import doctor` 时够用。把子包模块同时注册成扁平模块名
# （sys.modules），带点的既有绝对导入才能命中同一份模块对象。
import sys as _sys  # noqa: E402

_FLAT_MODULE_NAMES = (
    "analysis", "diff", "discovery", "doctor", "explain", "frontmatter",
    "inventory", "lifecycle", "overlap", "redact", "report", "security",
    "snapshots",
    "behavior", "budget", "canonical_audit", "claude_cost", "claude_evidence",
    "claude_session_audit", "codex_cost", "codex_evidence", "codex_usage",
    "compaction", "cost", "dsh_evidence", "duration", "enrichment", "harness_capability", "plan", "skill",
    "state", "subagent",
    "takeover", "trajectory", "usage", "waste",
    "workbuddy_evidence", "workbuddy_session_audit",
)
for _name in _FLAT_MODULE_NAMES:
    _sys.modules[__name__ + "." + _name] = globals()[_name]
del _name

# 函数级 re-export 保持原样（测试与外部调用方直接 import 这些名字）。
from .frontmatter import parse_frontmatter  # noqa: E402
from .security import SECURITY_PATTERNS, is_cited, security_scan  # noqa: E402
from .util import est_tokens, norm, safe_str  # noqa: E402

__all__ = [
    "SECURITY_PATTERNS",
    "__version__",
    "analysis",
    "behavior",
    "budget",
    "canonical_audit",
    "claude_cost",
    "claude_evidence",
    "claude_session_audit",
    "codex_cost",
    "codex_evidence",
    "codex_usage",
    "compaction",
    "cost",
    "diff",
    "discovery",
    "doctor",
    "dsh_evidence",
    "duration",
    "enrichment",
    "explain",
    "est_tokens",
    "frontmatter",
    "harness_capability",
    "inventory",
    "is_cited",
    "lifecycle",
    "norm",
    "overlap",
    "parse_frontmatter",
    "plan",
    "redact",
    "report",
    "safe_str",
    "security",
    "security_scan",
    "skill",
    "snapshots",
    "state",
    "subagent",
    "takeover",
    "trajectory",
    "usage",
    "waste",
    "workbuddy_evidence",
    "workbuddy_session_audit",
]
