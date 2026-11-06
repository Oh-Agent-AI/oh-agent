//! Skill 冲突/覆盖优先级排序——v0.8 Phase E7.2 从二进制 `main.rs` 迁来（原
//! `pub(crate) fn level_rank`/`level_rank_for`/`severity_rank`/`conflict_rank`
//! 与 `CODEX_FALLBACK_DESC_BUDGET`）。只移动不改写：这批函数只读已经采集好的
//! `serde_json::Value` 记录字段（`harness_family`/`level`/`conflict_domain`/…），
//! 不碰文件系统、不认识任何执行环境的 wire 格式，本该从一开始就在 domain 里，
//! 由 `apps/cli/src/main.rs` 的 `pub(crate) use` 保 call site 零改动
//! （同 D 阶段 `split_lines`/`pyround` 的搬法）。golden 15+15 是行为不变的
//! 唯一裁判——这批函数本身没有专门的单测，一直靠 `analysis`/`overlap`/
//! `doctor` 端到端覆盖。

use serde_json::Value;

/// 覆盖优先级**按执行环境而异**，不能只用一张表。
///
/// Python 侧曾经是一张全局表，装的是 OpenClaw 的顺序却套用到每个执行环境，
/// 于是 Claude Code 的 personal 与 project 被判反 —— 正是「与多数人直觉相反」
/// 的那一对。判反的后果不是少一条信息，是把诊断方向整个指错。
///
/// DSH 是第一个二维覆盖执行环境（HARNESS_ADAPTER_CONTRACT §DSH）：先比 scope 层
/// （近层同名直接赢），层内才用 rank 裁决。前五个执行环境只有一个隐式层，所以
/// `level_rank_for` 返回 `(layer, rank)`：它们的 layer 恒为 0、rank 即原标量，
/// 排序结果逐字节不变。
pub fn level_rank_for(harness_family: &str, level: &str, layer: &str) -> (u16, u16) {
    if harness_family == "dsh" {
        return (dsh_layer_ordinal(layer), dsh_rank(level));
    }
    (0, scalar_rank(harness_family, level))
}

/// 前五个执行环境 / 未知执行环境的层内 rank（原标量；u8 拓宽为 u16 以统一二维键）。
fn scalar_rank(harness_family: &str, level: &str) -> u16 {
    match harness_family {
        // OpenClaw：workspace > project > personal > managed
        "openclaw" => match level {
            "workspace" | "enterprise" => 0,
            "project" => 1,
            "personal" => 2,
            "managed" | "plugin" => 3,
            "other-harness" => 8,
            _ => 9,
        },
        // 其余（含未知执行环境）按 Claude Code：enterprise > personal > project > plugin
        _ => match level {
            "enterprise" => 0,
            "personal" => 1,
            "project" => 2,
            "plugin" => 3,
            "other-harness" => 8,
            _ => 9,
        },
    }
}

/// DSH 的 discovery roots（**层内** rank，越小越优先）。词表出自契约根表。
fn dsh_rank(level: &str) -> u16 {
    match level {
        "project-dsh" => 100,
        "project-agents" => 200,
        "custom" => 300,
        "user-dsh" => 400,
        "user-agents" => 500,
        "bundled" => 600,
        _ => 999,
    }
}

/// DSH 的 scope 层序，**近层在前**。具体 scope 链名由 DSH 适配器接入时对齐；
/// 未列出的层算最远，保证已知的近层总是赢。
const DSH_LAYER_ORDER: &[&str] = &[];
const DSH_LAYER_FAR: u16 = 99;

fn dsh_layer_ordinal(layer: &str) -> u16 {
    DSH_LAYER_ORDER
        .iter()
        .position(|x| *x == layer)
        .map(|i| i as u16)
        .unwrap_or(DSH_LAYER_FAR)
}

/// 从记录里取覆盖层名。前五个执行环境只有一个隐式层（返回 ""）。
/// DSH 的层写在 conflict_domain 第三段（A5：`dsh:<DSH_HOME>:<layer>`）。
pub fn layer_of(v: &Value) -> &str {
    let family = v
        .get("harness_family")
        .and_then(|x| x.as_str())
        .or_else(|| v.get("harness").and_then(|x| x.as_str()))
        .unwrap_or("");
    if family != "dsh" {
        return "";
    }
    let domain = v.get("conflict_domain").and_then(|x| x.as_str()).unwrap_or("");
    // 取最后一个 ":" 之后的段作层名，容忍 DSH_HOME 里出现冒号（如 Windows 盘符）。
    domain
        .strip_prefix("dsh:")
        .and_then(|rest| rest.rsplit(':').next())
        .unwrap_or("")
}

pub fn level_rank(v: &Value) -> (u16, u16) {
    let family = v
        .get("harness_family")
        .and_then(|x| x.as_str())
        .or_else(|| v.get("harness").and_then(|x| x.as_str()))
        .unwrap_or("");
    let level = v.get("level").and_then(|x| x.as_str()).unwrap_or("");
    let layer = layer_of(v);
    level_rank_for(family, level, layer)
}

/// Codex 没有可配置的预算旋钮，用实测得到的回退值。
pub const CODEX_FALLBACK_DESC_BUDGET: i64 = 8000;

pub fn severity_rank(s: &str) -> u8 {
    match s {
        "critical" => 0,
        "high" => 1,
        "medium" => 2,
        _ => 3,
    }
}

pub fn conflict_rank(s: &str) -> u8 {
    match s {
        "high" => 0,
        "medium" => 1,
        _ => 2,
    }
}
