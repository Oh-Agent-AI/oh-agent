//! Skill Surface 跨执行环境共享类型——v0.8 Phase E7.6 从 `apps/cli/src/skills/
//! discovery.rs` 拆出。这些类型本身零 I/O，但携带具体执行环境专有字段
//! （`workbuddy_package`、`instance_id` 等），不是 `agent-vitals-domain` 意义上
//! 完全"对执行环境不知情"的纯规则——它们是**证据的搬运结构**，被
//! `harnesses::{openclaw,workbuddy}` 的执行环境适配器共同使用，放在本 crate 根（同
//! `canonical_usage.rs` 的先例：跨执行环境但不属于任何单一 `harnesses/<h>/`）。
//!
//! `discovery.rs` 本体（`collect`/`scan_skill_dir`/`classify` 等，963 行的
//! 主编排逻辑）尚未迁移——它是 E7.5 的范围，比这几个数据结构复杂得多。

use serde_json::{json, Map, Value};

/// 根目录附带的证据。OpenClaw 是多实例的，同一个 skill 名在两个实例里
/// 不是同一个东西，所以实例身份必须一路带到每条记录上。
#[derive(Clone, Default)]
pub struct SourceMeta {
    pub instance_id: Option<String>,
    pub instance_root: Option<String>,
    pub config_path: Option<String>,
    pub root_kind: Option<String>,
    /// `openclaw.json` 里 skills.entries：唯一能判定「被显式关掉」的本机证据。
    pub skill_entries: Map<String, Value>,
    /// `openclaw.json` 的 skills.limits.maxSkillsPromptChars。
    /// OpenClaw 的描述预算**是用户可配的**，所以不能套 Claude Code 的默认值。
    /// 顶层 openclaw_instances 块尚未移植，届时由它消费。
    #[allow(dead_code)]
    pub skills_prompt_budget_chars: Option<i64>,
    /// WorkBuddy：清单选出的顶层包名。有它才说明这个根来自 builtin marketplace。
    pub workbuddy_package: Option<String>,
    /// 清单里的目录名。`ardot-` 前缀的包只在 design 模式下注入。
    pub workbuddy_legacy_name: Option<String>,
    /// 从日志取证得到的 welcomeMode。**None 表示未知，不是某个默认模式。**
    pub workbuddy_welcome_mode: Option<String>,
    /// 只看这一层的 SKILL.md，不向下递归。builtin-plugin 的包根用它 ——
    /// 那个目录里同时躺着 experts/ 与 skills/，递归会把包内部的角色定义
    /// 也当成顶层 skill。
    pub workbuddy_only_direct: bool,
}

impl SourceMeta {
    pub fn opt(v: &Option<String>) -> Value {
        v.as_ref().map(|x| json!(x)).unwrap_or(Value::Null)
    }
}
