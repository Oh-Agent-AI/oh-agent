"""静态扫描器模块（skills/）与会话/成本模块（agent/）的分类守卫。

repo 里有两个都叫「skill」的东西，按名字猜会互相进错门：

- **skill 体检**（静态扫描器）：读 SKILL.md / 目录 / 触发数据，判定体检指标。
  这是 Agent Vitals 最早的形态，落在 `skills/` 子树（Python 与 Rust 双侧）。
- **skill 执行**（会话审计）：审计**一次会话里 skill 被调用的好坏**——`skill.py` /
  core 的 `skill.rs` 读 DSH/会话事件，判定 SV6xx 会话规则。它不是扫描器，
  属 agent 家族，落在 `agent/` 子树（或 core crate，根本不在 `src/` 下）。

第 2 刀（深重构）按这个边界把扁平模块拆进了两个子树。本测试用**显式清单**
钉死「哪个模块进哪个子树」——不靠 import 图（图会随重构漂移，人看不出错），
就靠这份人和机器一起看的名单。谁把 `skill.py` 挪进 `skills/`，或把
`behavior.py` 挪出 `agent/`，这里立刻红。

清单按当前布局逐字写。新增模块时把它加进对应家族的 set；跨家族移动模块
必须先改这份名单再动文件，让移动本身变成显式决策。
"""

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PY_PACKAGE = ROOT / "packages" / "agent-vitals-python" / "agent_vitals"
RS_SRC = ROOT / "apps" / "cli" / "src"  # v0.8 Phase E3：二进制从根 src/ 迁进 apps/cli/src/

# 静态 SKILL.md 体检（skills/ 子树）——两实现的名单略有出入：
# Python 有 lifecycle/snapshots，Rust 没有（这些函数在 core 或别处）；
# Rust 有 harness/render/codex/openclaw/workbuddy，Python 在 adapters/ 或 core。
# v0.8 Phase E7（收口 D4/D5 当初该做但漏做的 Skill Surface 执行环境归位）：
# E7.1 frontmatter、E7.2 analysis/overlap（连同它们依赖的 ranking 排序簇 +
# s/i/f/b/chars 取值助手）、E7.3 security（拆出纯规则引擎 security_rules，
# I/O 部分留 apps/cli 当薄壳，security 本身不搬）迁进 agent-vitals-domain/
# src/domain/skills/；E7.4 snapshot（本机快照读写，I/O 天然属于 runtime，
# 不需要像 security 那样拆）迁进 agent-vitals-runtime/src/skills/；E7.6 harness
# （Claude Code 执行环境配置解释，拆出纯部分到 agent-vitals-harnesses::harnesses::
# claude_code::skills，I/O 部分到 …::sources::skills）+ workbuddy（marketplace
# 解析 + welcomeMode 取证，路径穿越防护与 I/O 交织较深，整体不拆，迁进
# …::harnesses::workbuddy::sources::skills；`SourceMeta` 跨执行环境共享类型先迁进
# agent-vitals-harnesses::skill_discovery 解除循环依赖）+ openclaw（首个
# Skill-Surface-only 执行环境，无 sessions/，整体不拆，迁进
# …::harnesses::openclaw::sources::skills）+ codex（协议报文构造/响应解析/运行时
# 元数据合并拆到 …::harnesses::codex::skills，子进程 I/O 到
# …::sources::skills——该文件自己的模块头早就说清了这条纯/I/O 边界，本次只是
# 落进 crate 边界）；E7.5 discovery（936 行，本仓库最复杂的单一函数集：目录
# 遍历+按执行环境分类+逐 skill 记录组装）+ inventory（跨执行环境编排，依赖 E7.6 四个
# 执行环境适配器都已是库 crate 模块）+ security（I/O 薄壳，与 discovery 互相
# 调用，必须一起迁）——三者一起迁进 agent-vitals-runtime::skills::
# {scanner,inventory,security}（整体搬，不做"harness 归属"式再拆分，同 D 阶段
# 教训：先给一个正确的家，深层重构留后续）——都不再在 apps/cli/src/skills/，
# 从 RS_SKILLS_FAMILY 里删掉；Python 侧对应模块暂未跟进搬迁，PY_SKILLS_FAMILY
# 不变。apps/cli/src/skills/ 现在只剩 CLI 展示层（diff/doctor/explain/
# redact/render/report，读已扫描记录渲染成文字/JSON，没有自己的扫描/编排
# 逻辑）。
PY_SKILLS_FAMILY = {
    "analysis", "diff", "discovery", "doctor", "explain", "frontmatter",
    "inventory", "lifecycle", "overlap", "redact", "report", "security",
    "snapshots",
}
RS_SKILLS_FAMILY = {
    "diff", "doctor", "explain",
    "redact",
    "render", "report",
}

# 会话行为/成本审计（agent/ 子树）。**注意 skill.py 在这里**：会话 skill 执行
# 审计读的是运行证据，不是 SKILL.md 文本——名字像扫描器，家族是 agent。
PY_AGENT_FAMILY = {
    "behavior", "budget", "canonical_audit", "claude_cost", "claude_evidence",
    "attribution", "claude_session_audit", "claude_usage_fact", "codex_cost", "codex_evidence",
    "codex_session_audit", "codex_usage", "codex_usage_fact", "compaction",
    "cost", "dsh_evidence", "dsh_usage_fact", "duration", "enrichment", "harness_capability", "mcp", "plan",
    "route_quality", "sessions_sql", "skill", "state", "subagent", "takeover", "trajectory", "usage",
    "usage_fact", "waste", "workbuddy_evidence", "workbuddy_session_audit",
    "workbuddy_usage_fact",  # spec §9E.5 E4a
    # HARNESS_MANIFEST_DSL_SPEC §8.1：generic 插件执行环境 twin（validate 只读面）。
    "generic_manifest", "generic_plugin", "generic_recipe", "catalog_index", "extension_objects",
}
RS_AGENT_FAMILY = {
    "claude_cost",
    "cost",
    "harness_runtime_registration",
    "oneline", "plan",
    # v0.8 Phase D4/D5：执行环境会话读取器（dsh/claude/codex/workbuddy _session）迁进
    # agent-vitals-harnesses/harnesses/<h>/sources.rs（feature = "sources"）。
    # Phase D6：state / budget / takeover / session_sources 迁进 agent-vitals-runtime。
    # ——都不再在 src/agent/。
    # v0.9 Stage 0.3（docs/AGENT_VITALS_V0_9_STAGE0_RESEARCH.md §6）：
    # r2a_store 的 6 文件依赖闭包全部迁完——codex_cost、behavior、discovery
    # （DSH 专用的这一个，非已迁移的 skills::discovery）、codex_session_audit、
    # r2a_store 本体都搬进了 agent_vitals_runtime::sessions（claude_cost 只
    # 搬走了其中一段 ledger 读取函数，模块本身仍留在这里，不从清单删）。
    # v0.9 Stage A（R4 §5.2 scope gap 收口）：UsageFact 发射器
    # {claude,codex,dsh}_usage_fact 归位 agent-vitals-harnesses/harnesses/<h>/sources/
    # usage_fact.rs——wire→fact 生产者由执行环境 crate 拥有；行级原语下沉
    # harnesses/claude_code/sessions/usage.rs；CLI 只 re-export。
}


def _module_stems(subdir: Path, *, python: bool) -> set:
    """子包里除 `__init__.py` / `mod.rs` 之外的模块名。"""
    pattern = "*.py" if python else "*.rs"
    skip = "__init__" if python else "mod"
    return {
        path.stem for path in subdir.glob(pattern)
        if path.stem != skip
    }


class ClassificationGuardTests(unittest.TestCase):
    def test_python_static_scanner_family_in_skills(self):
        """静态体检模块必须全部在 skills/，一个不多一个不少。"""
        self.assertEqual(
            _module_stems(PY_PACKAGE / "skills", python=True),
            PY_SKILLS_FAMILY,
            "skills/ 子树与静态扫描器清单不一致",
        )

    def test_python_session_agent_family_in_agent(self):
        """会话行为/成本模块必须全部在 agent/——尤其 skill.py 在这里。"""
        self.assertEqual(
            _module_stems(PY_PACKAGE / "agent", python=True),
            PY_AGENT_FAMILY,
            "agent/ 子树与会话/成本清单不一致",
        )

    def test_python_skill_execution_is_not_a_scanner(self):
        """命名陷阱：会话 skill 执行审计（agent/skill.py）不能住进 skills/。

        skills/ 是「对 SKILL.md 做体检」的世界，那里根本没有「skill 执行」
        这个概念；把它挪过去等于把运行时审计假装成静态扫描。
        """
        self.assertTrue(
            (PY_PACKAGE / "agent" / "skill.py").is_file(),
            "agent/skill.py 是会话 skill 执行审计，必须留在 agent/",
        )
        self.assertFalse(
            (PY_PACKAGE / "skills" / "skill.py").exists(),
            "skills/ 下不应有 skill.py——静态扫描器不含 skill 执行逻辑",
        )

    def test_rust_static_scanner_family_in_skills(self):
        """Rust 侧同样：静态体检模块全部在 src/skills/。"""
        self.assertEqual(
            _module_stems(RS_SRC / "skills", python=False),
            RS_SKILLS_FAMILY,
            "src/skills/ 子树与静态扫描器清单不一致",
        )

    def test_rust_session_agent_family_in_agent(self):
        """Rust 侧会话/成本模块全部在 src/agent/。"""
        self.assertEqual(
            _module_stems(RS_SRC / "agent", python=False),
            RS_AGENT_FAMILY,
            "src/agent/ 子树与会话/成本清单不一致",
        )

    def test_rust_skill_rs_lives_only_in_the_core_crate(self):
        """skill.rs（会话 skill 执行审计）只住在 core crate，src/ 下不该有。

        Rust binary 的 skill 会话规则走 `crate::agent::behavior` 透传 core；
        若谁在 src/skills/ 或 src/agent/ 又立了个 skill.rs，就是给
        「skill 执行」在 binary 里造第二份拷贝，与「core 是唯一真相源」相悖。
        """
        for sub in (RS_SRC / "skills", RS_SRC / "agent"):
            self.assertFalse(
                (sub / "skill.rs").exists(),
                "%s/skill.rs 不应存在——skill 会话规则只在 core crate"
                % sub.relative_to(ROOT),
            )
        self.assertTrue(
            (ROOT / "crates" / "agent-vitals-domain" / "src" / "domain" / "skill.rs").is_file(),
            "domain crate 应持有 skill.rs（会话 skill 执行审计的唯一真相源）",
        )

    def test_skill_inventory_does_not_read_session_files(self):
        """Skill surface 只能消费注入证据，不能自行打开 Session 日志。

        v0.8 Phase E7.5：inventory.rs 从 apps/cli/src/skills/ 迁进
        agent-vitals-runtime/src/skills/（跨执行环境编排，依赖 E7.6 的四个执行环境
        适配器都已是库 crate 模块）。W3（2026-09-24）随地基层整体拆进
        agent-vitals-runtime-core/src/skills/。
        """
        inventory = (
            ROOT / "crates" / "agent-vitals-runtime-core" / "src" / "skills" / "inventory.rs"
        ).read_text(encoding="utf-8")
        self.assertNotIn("read_session_evidence", inventory)
        self.assertIn("SessionEvidenceInput", inventory)

    def test_r2a_legacy_session_store_is_gone(self):
        """W8（2026-09-24）：r2a（legacy SessionStore）整体删除，不许悄悄长回来。

        它曾是行为 findings 写进 issue 表的唯一生产者，却只在旧 DOM 的「重载」
        按钮上触发——React 切换后 Findings 停在 09-20 无人察觉。生产者已改为
        同步后的 `ingest/findings_eval.rs`；这里钉住旧入口的每一处残留都不在：
        Rust 模块、domain 契约、feature gate、CLI 的 feature 启用、Python 镜像。
        """
        gone = [
            ROOT / "crates" / "agent-vitals-runtime" / "src" / "sessions" / "r2a_store.rs",
            ROOT / "crates" / "agent-vitals-query" / "src" / "sessions" / "r2a_store.rs",
            ROOT / "crates" / "agent-vitals-domain" / "src" / "contracts" / "r2a.rs",
            ROOT / "packages" / "agent-vitals-python" / "agent_vitals" / "agent" / "r2a.py",
        ]
        for path in gone:
            self.assertFalse(path.exists(), f"{path.relative_to(ROOT)} 已随 W8 删除，不得恢复")
        for toml in (
            ROOT / "crates" / "agent-vitals-runtime" / "Cargo.toml",
            ROOT / "apps" / "cli" / "Cargo.toml",
        ):
            self.assertNotIn("legacy-r2a", toml.read_text(encoding="utf-8"),
                             f"{toml.relative_to(ROOT)} 不得再声明/启用 legacy-r2a")
        self.assertTrue(
            (ROOT / "crates" / "agent-vitals-ingest" / "src" / "ingest" / "findings_eval.rs").exists(),
            "findings 的生产者必须在同步路径上（agent-vitals-ingest 的 ingest/findings_eval.rs）",
        )


if __name__ == "__main__":
    unittest.main()
