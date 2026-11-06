//! Skill Surface（静态 SKILL.md 体检）的纯计算——**不是** `domain::skill`（单数，
//! Session Surface 的 skill 执行审计，两者刻意分开，见 `docs/
//! AGENT_VITALS_V0_8_PHASE_E7_RESEARCH.md`）。
//!
//! v0.8 Phase E7（收口 D4/D5 遗漏的 Skill Surface 执行环境归位）：把
//! `apps/cli/src/skills/` 里零 I/O、零执行环境专有逻辑的纯函数迁进来。
//! E7.1 迁 `frontmatter`；E7.2 迁 `analysis`/`overlap`/`ranking`（冲突/覆盖
//! 优先级排序，原 main.rs 顶层的 `level_rank`/`severity_rank`/…）；E7.3 迁
//! `security_rules`——**这一步是拆，不是搬**：原 `security.rs` 把目录遍历/
//! 文件读取/权限位读取（真实 I/O）焊在正则规则判断里，只有正则规则引擎
//! （`Rule`/`rules`/`is_cited`/`check`/`evaluate`）进这里，I/O 部分留在
//! `apps/cli/src/skills/security.rs` 当薄壳。

pub mod analysis;
pub mod frontmatter;
pub mod overlap;
pub mod ranking;
pub mod security_rules;
