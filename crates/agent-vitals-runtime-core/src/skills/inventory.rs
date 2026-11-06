//! 采集：把「本机上装了什么」问出来，交给 report 去变换。
//!
//! # Harness Adapter 契约
//!
//! 每个执行环境适配器按**固定顺序**回答四个问题。顺序是契约的一部分：
//! 求证必须发生在磁盘遍历之后（要拿磁盘上的实例根去问），修正必须发生在
//! 求证之后（没有证据就什么都不改）。
//!
//! | 阶段 | 问题 | 谁实现了 |
//! |---|---|---|
//! | 1. roots | 这个执行环境会去哪些目录找 skill | 全部 |
//! | 2. probe | 能不能向执行环境本体求证「你到底看见了什么」 | codex、openclaw |
//! | 3. reconcile | 求到的证据怎么改写磁盘推断 | codex、openclaw |
//! | 4. facts | 报告里那一块自有字段的原料 | workbuddy、codex、openclaw |
//!
//! ## 为什么不是一个 trait
//!
//! 四个适配器的差异**不在于同一个阶段怎么做，而在于哪些阶段存在**：
//! Claude Code 和 Hermes 压根没有可问的运行时接口，WorkBuddy 的 roots 来自
//! 一份清单文件而不是遍历。写成 trait 会给它们凭空造出两个空实现，
//! 然后把唯一真正要讲清楚的差异 —— 下面那条 additive / exclusive —— 藏进
//! 各自的 `reconcile` 里。这里改用一段固定流程加显式命名的字段：
//! 新增执行环境时照着四个阶段填，缺哪个阶段就是缺哪个能力，一眼可见。
//!
//! ## reconcile 的两种语义，不能混
//!
//! - **Codex：additive。**运行时目录里可能有磁盘遍历没覆盖到的 skill
//!   （它按自己的 scope 规则找），所以证据能**新增**条目。
//! - **OpenClaw：exclusive。**运行时清单就是全集，不在清单里的即未加载，
//!   所以证据能**否定**磁盘推断。
//!
//! 把 additive 写成 exclusive 会凭空判定一批 skill 未加载；反过来则永远
//! 报不出「装了但没生效」。
//!
//! ## 探测不到 ≠ 探测到没有
//!
//! 每个 probe 在被禁用、执行环境未选中、可执行文件不存在时，一律返回
//! `available: false` 外加一条说明为什么，**绝不返回一个空清单冒充结果**。
//! 下游据此把相关计数报成 `null` 而非 `0`（ARCHITECTURE §3.1）。

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;

use agent_vitals_harnesses::skill_discovery::SourceMeta;
use super::scanner::{collect, Ctx, DEFAULT_ROOTS};
use super::scanner as discovery;
use agent_vitals_harnesses::harnesses::claude_code::skills::HarnessConfig;
use agent_vitals_domain::util::norm;
use agent_vitals_harnesses::dsh_sources as dsh;
// v0.8 Phase E7.6：codex.rs/workbuddy.rs/openclaw.rs 迁进 agent-vitals-harnesses
// （库 crate），E7.5 起本文件也迁进库 crate（agent-vitals-runtime）——同一批
// import 路径继续有效，只是不再是"二进制 use 库"，是"库 use 库"。
// codex 的 sources::skills 已经 re-export 了 harnesses::codex::skills 的纯部分
// （CodexRuntime/apply_codex_runtime/…），一个别名两边都拿到。
use agent_vitals_harnesses::harnesses::codex::sources::skills as codex;
use agent_vitals_harnesses::harnesses::workbuddy::sources::skills as workbuddy;
use agent_vitals_harnesses::harnesses::openclaw::sources::skills as openclaw;

/// 本次要看哪个执行环境、额外看哪些目录。
pub struct Selection<'a> {
    pub harness: &'a str,
    pub extra_paths: &'a [String],
    /// DSH 注册表快照（probe 证据，A11）。None = 未给 --runtime-json。
    pub runtime_json: Option<&'a Path>,
}

/// WorkBuddy 的自有事实。它没有运行时接口，能说的全在这份清单里。
#[derive(Default)]
pub struct WorkBuddyFacts {
    pub welcome_mode: Option<String>,
    /// 证据而非判决：带标记的包照常计入，只是把标记如实报出来。
    pub orphaned_packages: Vec<String>,
    pub package_count: usize,
    pub root_count: usize,
}

pub struct Inventory {
    pub skills: Vec<Value>,
    pub scanned_roots: Vec<Value>,
    pub unreadable: Vec<Value>,
    pub codex: codex::CodexRuntime,
    pub openclaw: Vec<openclaw::OpenClawRuntime>,
    pub workbuddy: WorkBuddyFacts,
    /// DSH 会话日志证据（读一次后下传给 A4/A9）。None = 未设环境变量。
    pub dsh_evidence: Option<Value>,
    /// 环境变量 `AGENT_VITALS_DSH_SESSION_LOG` 原始值，进报告里的 source 串。
    pub dsh_evidence_path: Option<String>,
    /// DSH 注册表快照（probe 证据，A11）。None = 未给 --runtime-json。
    /// A12 未完成前报告层暂不消费，故 allow dead_code —— 快照已在 discovery 的
    /// loaded 判定里生效（快照优先于日志）。
    #[allow(dead_code)]
    pub dsh_snapshot: Option<Value>,
}

/// 由运行时编排层提供的会话证据。
///
/// 静态 Skill inventory 只消费这份已读取的输入，不自行定位或打开 Session 日志。
/// 这样 Skill surface 与 Session surface 可以独立演进，同时仍保留 A4/A9 的关联能力。
#[derive(Default)]
pub struct SessionEvidenceInput {
    pub dsh_path: Option<String>,
    pub dsh: Option<Value>,
}

fn disabled(var: &str) -> bool {
    std::env::var(var).as_deref() == Ok("1")
}

/// probe 没跑时的占位。`reason` 会原样进 `codex_runtime.errors`——
/// 「为什么没有数据」和「数据是多少」一样是结果的一部分。
fn codex_not_probed(reason: &str) -> codex::CodexRuntime {
    codex::CodexRuntime {
        available: false,
        cwd: String::new(),
        skills: Vec::new(),
        errors: vec![reason.to_string()],
        executable: None,
    }
}

pub fn take(
    sel: &Selection,
    home_n: &str,
    cfg: &HarnessConfig,
    ctx: &Ctx,
    session_evidence: SessionEvidenceInput,
) -> Inventory {
    // ── 阶段 1：roots ────────────────────────────────────
    let mut roots: Vec<(String, String, SourceMeta)> = DEFAULT_ROOTS
        .iter()
        .map(|(h, r)| (h.to_string(), r.to_string(), SourceMeta::default()))
        .collect();
    // OpenClaw 是多实例的：每个 ~/.open* 下带 openclaw.json 的目录都是独立运行时。
    for (path, meta) in openclaw::read_openclaw_roots(home_n) {
        roots.push(("openclaw".to_string(), path, meta));
    }
    // WorkBuddy 的 builtin 包由 marketplace.json 选出，不是扫目录扫出来的。
    let wb_off = disabled("AGENT_VITALS_DISABLE_WORKBUDDY_BUILTINS");
    let wb_mode = if wb_off { None } else { workbuddy::read_welcome_mode(home_n) };
    let wb_disc = if wb_off {
        workbuddy::BuiltinDiscovery { roots: Vec::new(), orphaned_packages: Vec::new() }
    } else {
        workbuddy::discover_builtin(home_n)
    };
    let mut wb_orphaned = wb_disc.orphaned_packages;
    wb_orphaned.sort();
    let wb_roots = wb_disc.roots;
    // 数**包**，不是数 root：一个 builtin-plugin 包会展开成多个 root
    // （包自身 + skills/ 下每一个），字段名说的是 packages。
    let mut wb_packages: Vec<String> = wb_roots
        .iter()
        .filter_map(|(_, m)| m.workbuddy_package.clone())
        .collect();
    wb_packages.sort();
    wb_packages.dedup();
    let workbuddy = WorkBuddyFacts {
        welcome_mode: wb_mode.clone(),
        orphaned_packages: wb_orphaned,
        package_count: wb_packages.len(),
        root_count: wb_roots.len(),
    };
    for (path, meta) in wb_roots {
        roots.push(("workbuddy".to_string(), path, SourceMeta {
            workbuddy_welcome_mode: wb_mode.clone(),
            ..meta
        }));
    }
    for path in openclaw::read_hermes_external_dirs(home_n) {
        roots.push(("hermes".to_string(), norm(&path), SourceMeta::default()));
    }
    // 执行环境过滤发生在加 --path 之前：显式给的路径归到所选执行环境名下。
    if sel.harness != "all" {
        roots.retain(|(h, _, _)| {
            h == sel.harness || (sel.harness == "claude-code" && h == "claude-code-plugins")
        });
    }
    let custom_harness = if sel.harness == "all" { "custom" } else { sel.harness };
    for p in sel.extra_paths {
        roots.push((custom_harness.to_string(), p.clone(), SourceMeta::default()));
    }

    // 会话日志由 runtime/session source 读一次后注入。inventory 不定位、不打开
    // Session 文件，只把证据下传给 scan_skill_dir（A4）与 build_trigger（A9）。
    let SessionEvidenceInput {
        dsh_path: dsh_evidence_path,
        dsh: dsh_evidence,
    } = session_evidence;
    // 注册表快照（probe 证据，A11）同样读一次。它与日志证据是两个独立的证据源：
    // probe 回答「此刻这个 scope 解析出什么」，log 回答「当时向模型发布了什么」。
    // 快照存在且未降级时优先于日志（probe 更新鲜）。
    let dsh_snapshot = sel.runtime_json.map(dsh::read_snapshot);
    let found = collect(&roots, cfg.enabled.as_ref(), &cfg.usage, cfg.present, ctx,
                        dsh_evidence.as_ref(), dsh_snapshot.as_ref());
    let mut skills = found.skills;

    // ── 阶段 2：probe ───────────────────────────────────
    // Codex 的官方目录。只有它能回答「执行环境真的看见了什么」，
    // 所以它的结论覆盖磁盘推断（runtime_verified）。
    let codex_runtime = if disabled("AGENT_VITALS_DISABLE_CODEX_RUNTIME") {
        codex_not_probed("disabled by AGENT_VITALS_DISABLE_CODEX_RUNTIME")
    } else if sel.harness == "all" || sel.harness == "codex" {
        codex::read_codex_runtime(
            &std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            Duration::from_secs(20),
        )
    } else {
        codex_not_probed("harness not selected")
    };
    // OpenClaw 的权威清单：逐实例问一次。
    let mut openclaw_runtimes: Vec<openclaw::OpenClawRuntime> = Vec::new();
    let openclaw_on = !disabled("AGENT_VITALS_DISABLE_OPENCLAW_RUNTIME")
        && (sel.harness == "all" || sel.harness == "openclaw");
    if openclaw_on {
        // 按实例根去重后排序：探测顺序会影响 openclaw_runtime 的输出次序
        let mut instance_roots: Vec<String> = roots
            .iter()
            .filter(|(h, _, _)| h == "openclaw")
            .filter_map(|(_, _, m)| m.instance_root.clone())
            .collect();
        instance_roots.sort();
        instance_roots.dedup();
        for root in instance_roots {
            openclaw_runtimes.push(openclaw::read_openclaw_runtime(
                Path::new(&root),
                Duration::from_secs(30),
            ));
        }
    }

    // ── 阶段 3：reconcile ───────────────────────────────
    // 顺序与语义见模块头：OpenClaw 是 exclusive（清单即全集），
    // Codex 是 additive（清单可能带来磁盘上没遍历到的条目）。
    if openclaw_on {
        openclaw::apply_openclaw_runtime(&mut skills, &openclaw_runtimes);
    }
    if codex_runtime.available {
        let usage_ref = &cfg.usage;
        codex::apply_codex_runtime(&mut skills, &codex_runtime, |dir| {
            discovery::scan_skill_dir(dir, "codex", None, usage_ref, false, ctx,
                                      &SourceMeta::default(), None, None)
        });
    }

    Inventory {
        skills,
        scanned_roots: found.scanned_roots,
        unreadable: found.unreadable,
        codex: codex_runtime,
        openclaw: openclaw_runtimes,
        workbuddy,
        dsh_evidence,
        dsh_evidence_path,
        dsh_snapshot,
    }
}
