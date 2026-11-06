"""harness-capability degradation 表的单一事实来源（Python 镜像）。

与 Rust `crates/agent-vitals-domain/src/contracts/harness_capability.rs` 逐字节对齐：reason
文案、规则集合、missing 信号都在同一张表里，两边的 `degrade_rule_outcomes`
对同一份 dict/切片做同一件事，差分测试靠它。

两条执行环境路径（Claude Code 的 SV607/608、WorkBuddy 的 SV604/605）把
MeasuredZero 覆盖成 Unavailable 的理由与规则集合，原本埋在各自的 dispatcher
层（`claude_session_audit.py` / `workbuddy_session_audit.py`），core 的共享
求值器无守卫——未来任何直接消费 canonical 的 surface 都会拿到「结构上读不到
维度却报零命中」的假测量。表在这里下沉：dispatcher 与未来消费者共用同一个
`harness_id → (规则集, 缺失信号, reason)` 映射。

**只覆盖 MeasuredZero**：门控已因 timeline 空给 Unavailable（缺失信号、无需
override）或给了 Findings（真命中）时保持原样——override 永不吞真命中。
未知执行环境 → no-op（DSH/Codex 没有这种 degrade，它们的 golden 字节零改动）。
"""

CLAUDE_SV607_608_REASON = (
    "claude-code harness capability: tool results carry no reason codes "
    "(error_code structurally absent); SV607/608 are reason-level detectors "
    "and cannot discriminate"
)

# harness_id → (规则集, missing 信号, reason)。Rust `degrade_rule_outcomes` 的 match
# 就是这张表——两边各写一份，靠差分测试对齐。
_DEGRADES = {
    "claude-code": (("SV607", "SV608"), ["ToolResults"], CLAUDE_SV607_608_REASON),
}


def degrade_rule_outcomes(harness_id, outcomes):
    """就地改写 `rule_outcomes`（`{"SV601": {...}, ...}` 形状）：把 harness 结构性
    读不到的规则从 `measured_zero` 覆盖成 `unavailable`，理由写进 `reason`。
    未知执行环境 no-op。调用方负责重算 `summary.rules_unavailable`。"""
    entry = _DEGRADES.get(harness_id)
    if entry is None:
        return
    codes, missing, reason = entry
    for code in codes:
        outcome = outcomes.get(code)
        if outcome is not None and outcome.get("status") == "measured_zero":
            outcomes[code] = {
                "status": "unavailable",
                "missing": missing,
                "reason": reason,
            }


# ────────────────────────── M0：HARNESSES 行骨架（v0.6 spec §5.1/§11） ──────────
#
# 与 Rust `crates/agent-vitals-domain/src/contracts/harness_capability.rs::HARNESSES` 是**双实现
# 契约**——每种语言内部唯一声明源，跨语言由 `harnesses --json` 的 G1 byte-parity
# 保持一致（v0.6 spec §5.1bis），不是共享数据文件。四行顺序 = 展示顺序
# （dsh→codex→claude-code→workbuddy），不是 UI 契约。
#
# `unmeasured_signals` 取自各证据适配器现有的 `_UNAVAILABLE_SIGNALS`
# （`claude_evidence.py`/`codex_evidence.py`/`workbuddy_evidence.py`）——dsh 的
# Python 侧目前无 canonical 适配器（`behavior.py` 走自家门控，M1 才建
# `dsh_evidence.py`），这里手工镜像 Rust `dsh_evidence.rs` 内联声明的 5 个
# 信号。M0 是**声明**收拢，行为零变化；M2 才让适配器改从这里 derive。
HARNESSES = (
    {
        "id": "dsh",
        "display": "DeepSeek Harness",
        "unmeasured_signals": [
            "QuotaConsumption",
            "SandboxPolicy",
            "NetworkAccess",
            "UserPrompts",
            "UserCorrections",
        ],
        "degraded_rules": [],
        "session_store": True,
        "fold": "token_buckets",
        "attribution": {"provider_reported_implies_official": False, "credits_only": False},
    },
    {
        "id": "codex",
        "display": "Codex",
        "unmeasured_signals": [
            "StepBoundaries",
            "SandboxPolicy",
            "NetworkAccess",
            "UserCorrections",
        ],
        "degraded_rules": [],
        "session_store": True,
        "fold": "token_buckets",
        "attribution": {"provider_reported_implies_official": True, "credits_only": False},
    },
    {
        "id": "claude-code",
        "display": "Claude Code",
        "unmeasured_signals": [
            "ContextWindow",
            "QuotaConsumption",
            "ApprovalDecisions",
            "SandboxModes",
            "SandboxPolicy",
            "NetworkAccess",
            "UserCorrections",
        ],
        "degraded_rules": [
            {"code": "SV607", "missing": ["ToolResults"], "reason": CLAUDE_SV607_608_REASON},
            {"code": "SV608", "missing": ["ToolResults"], "reason": CLAUDE_SV607_608_REASON},
        ],
        "session_store": True,
        "fold": "token_buckets",
        "attribution": {"provider_reported_implies_official": False, "credits_only": False},
    },
    {
        "id": "workbuddy",
        "display": "WorkBuddy",
        "unmeasured_signals": [
            "StepBoundaries",
            "Usage",
            "ContextWindow",
            "SandboxPolicy",
            "Compaction",
            "SkillInvocations",
            "Hooks",
            "UserPrompts",
            "UserCorrections",
        ],
        # SV604/605 的降级行**已移除**（spec §9E.5 E2）：前提「write/edit 只存在于会话
        # 匿名的 traces」是 09-02 的分析错误——Edit/Write span 解码后带 file_path，已折进
        # tool_calls。SV604/605 照跑，零命中就是诚实 MeasuredZero。
        "degraded_rules": [],
        # 无 SessionStore（envelope 未知执行环境 → StoreError，v0.6 spec §4）。
        "session_store": False,
        # 无日/月折叠机制（会话审计的成本块是执行环境已计费 credit 求和，不重计价）；
        # M4（可选演练）会把这行改成 "harness_bill_totals"。
        "fold": None,
        "attribution": {"provider_reported_implies_official": False, "credits_only": True},
    },
)


def harness_profile(harness_id):
    """按 id 查找一行。未知 id 返回 `None`——查询路径 fail-open（现状保持），
    注册路径 fail-closed（不在 `HARNESSES` 里的 id 任何消费方都查不到）。"""
    for h in HARNESSES:
        if h["id"] == harness_id:
            return h
    return None


def harnesses_json():
    """`agent-vitals harnesses --json` 的负载——`HARNESSES` 行的忠实序列化，与 Rust
    `harness_capability.rs::harnesses_json` 逐字节比对（v0.6 spec §8 G1）。"""
    return {"harnesses": [dict(h) for h in HARNESSES]}
