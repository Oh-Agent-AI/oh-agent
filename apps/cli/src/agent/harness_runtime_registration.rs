//! v0.6 harness-contract spec §5.1bis/§8 G9：能力**声明**（core
//! `harness_capability::HARNESSES` 行）与**实现存在性**分居两侧——core 不依赖任何
//! 文件系统实现；二进制才知道自己真正接了哪些构造器/命令入口。本文件是
//! `agent-vitals` CLI 这一侧的 `HarnessRuntimeRegistration`：harness_id → 该执行环境
//! 在**这个二进制里**的能力实现是否存在。
//!
//! 守卫断言 `required_capabilities(surface) ⊆ registrations(surface)`——不
//! 要求每个二进制实现全部能力，一个二进制不消费某项能力时不要求注册
//! （R2 修订 3：避免把 CLI 与 Tauri 强制做成同构产品）。本轮登记
//! `cli.sessions` 一个 surface 的两个维度：
//!
//! - `session_store`：原义「`r2a_store.rs::SessionStore::<harness>` 构造器是否存在」。
//!   W8（2026-09-24）r2a_store 已删，sessions list/read 走 SQL 权威库；本字段仍是
//!   core `HARNESSES` 跨语言契约（`harnesses --json` 逐字节对账）的一部分，语义待重定义
//!   为「sessions 面是否覆盖该执行环境」——改它要连 Python 与 golden 一起动，另做。
//! - `fold`：`sessions_navigation`（同文件）是否为该执行环境折了当日 token——
//!   dsh 读 `state.json`、codex 折全量 rollout、claude-code 读 ledger，三条
//!   路径各不相同（**不是**统一的函数入口，§2.2 明文不建 trait），本表只
//!   答"这个二进制里，这个执行环境的折叠路径接了没有"，不试图把三条路径统一
//!   成一个可遍历的循环——那会为了凑一个共享接口而发明一层假抽象，`fold`
//!   字段的粒度就停在"接了/没接"，与 core `HARNESSES` 行的 `fold:
//!   Option<FoldOutput>` 语义对齐（`Some` ↔ true，`None` ↔ false）。
//!
//! `tauri.sessions`/`tauri.menubar-cost` 两个 surface **不需要在本表里另开
//! 一行**——核实过 `apps/desktop/src-tauri/src/store.rs` 后确认它们是**纯 IPC 透传**：
//! `sessions_list`/`sessions_read`/`sessions_findings` 三个 `#[tauri::command]`
//! 只把参数拼成 argv、spawn `agent-vitals` 二进制、原样透传 stdout/stderr
//! （`store.rs::list_args` 单测已经用任意字符串 `"x"` 当 `harness_kind` 验证了
//! 这条路径不做任何按执行环境分支的逻辑，`sessions_navigation` 的输出（G7 的
//! `overview::harness_rows_from_navigation`）同样只做字段映射，不重新决定"这个
//! 执行环境该不该出现"）。Tauri 自己不持有第二份 `SessionStore`/折叠实现，它的
//! 执行环境覆盖面**恒等于**本表登记的 `cli.sessions`——没有独立能力可声明，也就
//! 没有独立注册的必要；给它另起一行只会制造一张"两边手工同步"的假活，
//! 违反本文件开头引的 R2 修订 3。
//!
//! **暂无 CLI 表面**（`#[allow(dead_code)]`，仅本文件的单测消费）：这张表是
//! 二进制内部的声明，不进 `harnesses --json`——那份 JSON 是 G1 跨语言
//! byte-parity 的对象（人读格式同样被 `test_harnesses_human_format_byte_parity`
//! 差分锁死），塞进任何 Rust-only 的东西都会当场撞红。等专门给
//! `HarnessRuntimeRegistration` 开一个诊断表面时再摘掉这个 allow。

#![allow(dead_code)]

/// 一个执行环境在**本二进制**里实际接线的运行时能力。只声明存在性，不声明
/// 实现细节（构造器/折叠函数本身仍是各自模块的普通 pub 函数，这里不做函数
/// 指针表——core 行已经说明"哪些执行环境该有 session_store/fold"，本表只答
/// "这个二进制是否真接了"）。
pub struct HarnessRuntimeRegistration {
    pub harness_id: &'static str,
    /// 原义：`r2a_store.rs::SessionStore::<harness>` 构造器是否存在（W8 后待重定义，见文件头）。
    pub session_store: bool,
    /// `sessions_navigation` 是否为该执行环境折了当日 token（对应 core
    /// `HarnessProfile.fold: Option<FoldOutput>` 的存在性，不区分具体
    /// `FoldOutput` 变体——这个二进制目前只产 `TokenBuckets`，`HarnessBillTotals`
    /// 是 workbuddy M4 才会出现的形态）。
    pub fold: bool,
}

/// `agent-vitals` CLI 二进制的注册集，顺序同 `harness_capability::HARNESSES`。
pub static CLI_REGISTRATIONS: &[HarnessRuntimeRegistration] = &[
    HarnessRuntimeRegistration { harness_id: "dsh", session_store: true, fold: true },
    HarnessRuntimeRegistration { harness_id: "codex", session_store: true, fold: true },
    HarnessRuntimeRegistration { harness_id: "claude-code", session_store: true, fold: true },
    // WorkBuddy：`SessionStore::all`/`sessions_list` 对未知执行环境返回
    // `StoreError`（envelope 未知执行环境，v0.6 spec §4）——没有 `SessionStore::
    // workbuddy` 构造器；`sessions_navigation` 也没有它的折叠分支（M4 才会
    // 补，那时这两个字段都要翻 true）。如实登记 false，不是遗漏。
    HarnessRuntimeRegistration { harness_id: "workbuddy", session_store: false, fold: false },
];

/// `cli.sessions` surface 需要的 `session_store` 能力——从 core `HARNESSES` 行的
/// `session_store` 字段派生（哪些执行环境"应该"有 store，是声明层的事）。
pub fn required_for_cli_sessions() -> Vec<&'static str> {
    agent_vitals_domain::harness_capability::HARNESSES
        .iter()
        .filter(|h| h.session_store)
        .map(|h| h.id)
        .collect()
}

/// `cli.sessions` surface 实际注册了 `session_store` 的执行环境（这个二进制
/// "真的接了"，是实现层的事）。
pub fn registered_for_cli_sessions() -> Vec<&'static str> {
    CLI_REGISTRATIONS
        .iter()
        .filter(|r| r.session_store)
        .map(|r| r.harness_id)
        .collect()
}

/// `cli.sessions` surface 需要的 `fold` 能力——从 core `HARNESSES` 行的
/// `fold.is_some()` 派生。
pub fn required_for_cli_sessions_fold() -> Vec<&'static str> {
    agent_vitals_domain::harness_capability::HARNESSES
        .iter()
        .filter(|h| h.fold.is_some())
        .map(|h| h.id)
        .collect()
}

/// `cli.sessions` surface 实际注册了 `fold`（`sessions_navigation` 里真的有
/// 对应分支）的执行环境。
pub fn registered_for_cli_sessions_fold() -> Vec<&'static str> {
    CLI_REGISTRATIONS.iter().filter(|r| r.fold).map(|r| r.harness_id).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn required_capabilities_for_cli_sessions_is_a_subset_of_registrations() {
        let required: BTreeSet<&str> = required_for_cli_sessions().into_iter().collect();
        let registered: BTreeSet<&str> = registered_for_cli_sessions().into_iter().collect();
        assert!(
            required.is_subset(&registered),
            "cli.sessions 的 session_store 维度需要 {required:?}，但只注册了 \
             {registered:?}——有执行环境声明了 session_store 却没有对应的 \
             SessionStore 构造器"
        );
    }

    #[test]
    fn required_fold_capabilities_for_cli_sessions_is_a_subset_of_registrations() {
        let required: BTreeSet<&str> = required_for_cli_sessions_fold().into_iter().collect();
        let registered: BTreeSet<&str> = registered_for_cli_sessions_fold().into_iter().collect();
        assert!(
            required.is_subset(&registered),
            "cli.sessions 的 fold 维度需要 {required:?}，但只注册了 \
             {registered:?}——`sessions_navigation` 少了某个已声明 fold 的执行环境的\
             折叠分支（或者反过来，行忘了声明；M4 给 workbuddy 补 fold 后，\
             这条测试会先转红，提醒同步改这张表）"
        );
    }

    #[test]
    fn registration_ids_are_exactly_the_four_runtime_harnesses() {
        let mut ids: Vec<&str> = CLI_REGISTRATIONS.iter().map(|r| r.harness_id).collect();
        ids.sort_unstable();
        assert_eq!(ids, vec!["claude-code", "codex", "dsh", "workbuddy"]);
    }

    #[test]
    fn workbuddy_has_neither_session_store_nor_fold_registration() {
        let wb = CLI_REGISTRATIONS.iter().find(|r| r.harness_id == "workbuddy").unwrap();
        assert!(!wb.session_store, "WorkBuddy 无 SessionStore（envelope 未知执行环境 → StoreError）");
        assert!(!wb.fold, "WorkBuddy 无日/月折叠（sessions_navigation 没有它的分支）");
    }
}
