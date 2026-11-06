//! 菜单栏后端数据组装：从 SQL 权威库取「今日/本月 DSH 桶 + Claude 逐日账」
//! （`runtime::summary::overview_bundle`，Phase 4 §5.2：不再直读
//! `state/{today,month,claude-ledger}.json`）+ 根下 config.toml 预算，喂给 core
//! 的 cost 折叠，产出一个纯展示 JSON。
//!
//! **计算本体在 core**（`agent_vitals_domain::cost::{priced_day, month_cost,
//! today_cost, bucket_cost}`），这里只有组装——CLAUDE.md 教训：同一份
//! month 数据在日历/budget/菜单栏各写一份「有没有 by_model 就……」的判断，报出
//! ¥4.50 vs ¥18.00 两个价。菜单栏不重写任何定价，只调 core 的单一覆盖率校验入口。
//!
//! data_home 解析与北京日期键是**管道不是规则**：Python 侧 `paths.py`/`state.py`
//! 与二进制 `snapshot.rs`/`codex_cost.rs` 各有镜像，这里是菜单栏一份（独立
//! workspace，import 不到二进制模块）。规格与那两份逐字段一致，单测钉住。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use agent_vitals_domain::cost::{
    bucket_cost, claude_day_cost, claude_day_total_tokens, claude_subscription_uncovered_estimate,
    load_pricing, month_cost, cache_counterfactual_cost, priced_day, today_cost,
};
use agent_vitals_domain::state::rollup_by_model;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

#[derive(Serialize)]
pub struct DayRow {
    pub date: String,
    pub total: f64,
    pub peak_total: f64,
    /// "exact" | "partial"，无 by_model 的日子为 None（按 fallback 近似）。
    pub basis: Option<String>,
    pub coverage: Option<f64>,
}

/// alert.json 的预算权威字段（`budget.evaluate()` 落盘）。菜单栏**只读不重算**：
/// level/ratio/日预算/snooze 全部以这里为准——这是迁移要修的 D2 缺口
/// （Tauri 自算 remaining% 与 budget.py 规则无关）。缺场时 `source = "missing"`，
/// UI 走降级文案，不臆造百分比。
#[derive(Serialize, Default)]
pub struct BudgetAlert {
    pub level: Option<String>,
    /// 今日占比（alert.json `ratio`，今日无数据时为 null）。
    pub ratio: Option<f64>,
    /// 本月占比（alert.json `month_ratio`）。
    pub month_ratio: Option<f64>,
    pub effective_daily_budget: Option<f64>,
    pub snoozed_until: Option<String>,
    pub reasons: Option<Vec<String>>,
    pub today_cost: Option<f64>,
    pub month_cost: Option<f64>,
    pub monthly_cny: Option<f64>,
    pub peak_over: Option<bool>,
    pub adaptive_floor_applied: Option<bool>,
    /// 新鲜度源：`budget.evaluate()` 的落盘时刻。
    pub generated_at: Option<String>,
    pub schema_version: Option<String>,
    /// "alert" | "missing" —— 权威来源标记，UI 据此决定展示还是降级。
    pub source: String,
}

/// 菜单栏自身同步回路的状态：每轮 tick（发现未折会话 → oneline 折账）都会落盘
/// 一条，托盘/面板只读展示。这是「同步失败可见、可行动」的数据源——tick 的每一类
/// 结局（二进制缺失/discover 失败/oneline 失败/无未折会话/成功）都必须写成一条
/// 可展示的记录，而不是只进 stderr。`read_overview` 把它放进 Overview，UI 据此
/// 决定主入口要不要示警、给不给「立即同步」入口。
#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct SyncStatus {
    /// 本轮同步是否成功结束（无未折会话也是成功——「没活干」不是故障）。
    pub ok: bool,
    /// 卡在哪一步："never" | "resolve" | "discover" | "fold"。前端用 "never"
    /// 区分「从未同步」与「同步失败」，措辞不同。
    pub stage: String,
    /// 人话原因：失败时是错误原因，成功时是「已折入 <session_id>」这类摘要。
    pub message: String,
    /// 本轮尝试的北京时间（`YYYY-MM-DD HH:MM:SS`）。无 chrono 依赖，用 `beijing_timestamp`。
    pub at: Option<String>,
    /// Local-only receipts for active dynamic harness manifests. Error text and paths
    /// are intentionally omitted; this file is not an MCP/plugin data source.
    pub dynamic_harnesses: Vec<DynamicHarnessSyncReceipt>,
}

pub(crate) fn local_timestamp_now() -> String {
    beijing_timestamp(now_unix_secs())
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct DynamicHarnessSyncReceipt {
    pub harness: String,
    /// `ok`, `empty`, or `failed`.
    pub state: String,
    /// Closed error vocabulary; never raw parser/OS error text.
    pub error_code: Option<String>,
    pub observed_at: String,
    pub appended: usize,
    pub duplicate: usize,
}

impl Default for SyncStatus {
    fn default() -> Self {
        Self { ok: false, stage: "never".into(), message: "尚未同步".into(), at: None, dynamic_harnesses: Vec::new() }
    }
}

impl SyncStatus {
    pub fn ok(stage: &str, message: String) -> Self {
        Self { ok: true, stage: stage.into(), message, at: Some(beijing_timestamp(now_unix_secs())), dynamic_harnesses: Vec::new() }
    }

    pub fn fail(stage: &str, message: String) -> Self {
        Self { ok: false, stage: stage.into(), message, at: Some(beijing_timestamp(now_unix_secs())), dynamic_harnesses: Vec::new() }
    }
}

fn now_unix_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 北京时间 `YYYY-MM-DD HH:MM:SS`（UTC+8 无夏令时）。复用 `civil_from_unix_secs`，
/// 不引日期库——与 data_home 解析同款「管道不是规则」的镜像位置。
fn beijing_timestamp(secs: i64) -> String {
    agent_vitals_runtime::clock::local_timestamp_text(secs)
}

/// tick 每轮结束把同步状态落盘到 `state/last-sync.json`（与 alert.json 同目录——
/// 数据根只有一份，菜单栏和 CLI 读的都是它）。
pub fn save_sync_status(status: &SyncStatus) {
    save_sync_status_at(&data_home(), status);
}

/// 参数化版——数据根由调用方指定，单测往临时目录写就能端到端验证。
pub fn save_sync_status_at(dh: &Path, status: &SyncStatus) {
    let dir = dh.join("state");
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(text) = serde_json::to_string_pretty(status) {
        let _ = std::fs::write(dir.join("last-sync.json"), text);
    }
}

/// 用户显式暂停自动扫描的本地控制位。它和同步回执分开：暂停不是失败，也不
/// 应被下一次“无记录”回执覆盖。控制文件损坏时返回错误并由调用方停扫，宁可
/// 要求用户恢复，也不在用户已选择暂停后静默继续读取日志。
pub fn sync_is_paused() -> Result<bool, String> {
    sync_is_paused_at(&data_home())
}

fn sync_is_paused_at(dh: &Path) -> Result<bool, String> {
    agent_vitals_runtime::sync_control::is_paused(dh)
}

pub fn save_sync_paused(paused: bool) -> Result<(), String> {
    save_sync_paused_at(&data_home(), paused)
}

fn save_sync_paused_at(dh: &Path, paused: bool) -> Result<(), String> {
    agent_vitals_runtime::sync_control::set_paused(dh, paused)
}

/// 读回上一轮同步状态；文件缺场 → 默认（"never"）。解析失败也走默认——一条坏掉
/// 的 last-sync.json 不该让面板整块红，回退成「尚未同步」即可。
pub(crate) fn load_sync_status(dh: &Path) -> SyncStatus {
    read_json(&dh.join("state").join("last-sync.json"))
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}



/// 多执行环境导航行（spec §5.3）：`sessions navigation` 的执行环境快照在托盘侧的落盘
/// 形状。tick 每次查询完写 `state/harnesses.json`，`read_overview` 附带返回——托盘
/// 启动时 warm-start 直接渲染上一轮结果，不阻塞在冷查询上（与 today.json/
/// month.json 的持久化同款）。
///
/// **全部字段来自快照，托盘不做任何排序/求和/日界换算**（spec §5.3）——排序、
/// 日界折叠、覆盖率在数据层（`sessions navigation`）完成，这里只是落盘 + 渲染。
/// 诚实降级（spec §8）：`status == "unavailable"` → L1 全 None（「—」）、L2 禁用
/// 「会话数据暂不可用」；**不拿缺失字段当 0**——「今天没跑」是 None，「今天花了
/// 0」才是 0，两者在托盘上是两种文案。
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct HarnessRow {
    pub harness_kind: String,
    /// 快照 status 原样落盘（"ready" | "partial" | "unavailable"）——L2 渲染
    /// 靠它区分「读不了」（禁用「会话数据暂不可用」）与「真零会话」（禁用
    /// 「尚无会话」），两种状态必须可区分。
    pub status: String,
    pub today_tokens: Option<i64>,
    /// `today_tokens.coverage == "partial"`（折叠 unaccounted > 0）→ L1 token
    /// 加 `≈` 前缀（spec §8）。快照的 coverage 是保守下界标注，托盘渲染时保留，
    /// 不能丢成精确值。
    pub today_partial: bool,
    pub today_sessions: Option<u64>,
    pub recent: Vec<RecentSessionRow>,
}

/// 最近会话行的落盘形状（spec §5.3）。`session_key` 存 `Value`：core `SessionKey`
/// 不 derive Serialize（`r2a.rs` 用 `to_json`/`from_json` 显式往返），这里原样
/// 存 `SessionKey::to_json()` 的四元组 JSON，深链透传给工作台（`sessions read`
/// 期待同形状）——一旦在 `HarnessRow` 里拆开重排，字节契约就断了。
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct RecentSessionRow {
    pub session_key: Value,
    pub title: Option<String>,
    /// `date_span.last` 完整日期（`YYYY-MM-DD`）；展示侧再折成 `MM-DD`/带年。
    pub date: Option<String>,
    pub model: Option<String>,
    pub tokens: Option<i64>,
}

impl HarnessRow {
    /// 查询失败兜底行：L1 字段全 None（托盘显示「—」）、L2 渲染禁用文案。
    /// 不臆造「0 会话 / 0 token」——失败与零是两种诚实。
    pub fn unavailable(kind: &str) -> Self {
        HarnessRow {
            harness_kind: kind.to_string(),
            status: "unavailable".to_string(),
            today_tokens: None,
            today_partial: false,
            today_sessions: None,
            recent: Vec::new(),
        }
    }
}

/// harnesses.json 落盘信封（spec §5.1 快照形状的落盘投影）：`generated_at` 是
/// `sessions navigation` 快照的生成时刻（RFC3339 UTC），托盘据此**渲染时**判
/// stale（`now - generated_at > 2 × tick`，spec §6 决策 5）——所以 stale 是派生
/// 值、不入盘（刷新失败不覆盖 harnesses.json，旧的 generated_at 自然变旧 → 变 stale，
/// 这正是「保留末次成功快照」的意义）；display_name 同理是托盘侧映射（spec §4），
/// 也不入盘。
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct HarnessesSnapshot {
    pub generated_at: Option<String>,
    pub harnesses: Vec<HarnessRow>,
}

impl HarnessesSnapshot {
    /// 缺场/解析失败兜底：generated_at None（无缓存 → 无 stale footer）、行集
    /// 从 core `harness_capability::HARNESSES` 派生（v0.6 harness-contract spec §6/
    /// §11-M3，G7）——遍历 `fold != None` 的执行环境，键序即 `HARNESSES` 行序
    /// （dsh→codex→claude-code→workbuddy），今天恰好等于旧硬编码三行（workbuddy
    /// 尚 `fold: None`，M4 补 `HarnessBillTotals` 后自动出现第四行，不用再改这个
    /// 函数）。托盘永远渲染注册集里有折叠能力的执行环境，数据缺失才显示「—」，
    /// spec §8。一条坏掉的 harnesses.json 不该让菜单整块消失（同 last-sync.json 的
    /// 「解析失败走默认」哲学）。旧版只落两行的 harnesses.json 按字面读出两行
    /// （宽容：不整盘丢弃），下一轮 tick 的新快照覆盖它。
    pub fn unavailable() -> Self {
        HarnessesSnapshot {
            generated_at: None,
            harnesses: agent_vitals_domain::harness_capability::HARNESSES
                .iter()
                .filter(|h| h.fold.is_some())
                .map(|h| HarnessRow::unavailable(h.id))
                .collect(),
        }
    }
}

/// tick 每轮把执行环境快照落盘到 `state/harnesses.json`（与 last-sync.json 同目录）。
/// 镜像 `save_sync_status_at`：数据根只有一份，托盘/面板读的都是它。
pub fn save_harnesses_at(dh: &Path, snap: &HarnessesSnapshot) {
    let dir = dh.join("state");
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(text) = serde_json::to_string_pretty(snap) {
        let _ = std::fs::write(dir.join("harnesses.json"), text);
    }
}

/// 读回上一轮 tick 的执行环境快照。缺场/解析失败 → `HarnessesSnapshot::unavailable()`
/// （dsh→codex→claude-code 固定三行——托盘永远渲染固定三行，数据缺失才显示
/// 「—」，spec §8）。
pub fn read_harnesses_at(dh: &Path) -> HarnessesSnapshot {
    read_json(&dh.join("state").join("harnesses.json"))
        .and_then(|v| serde_json::from_value::<HarnessesSnapshot>(v).ok())
        .unwrap_or_else(HarnessesSnapshot::unavailable)
}

/// `sessions navigation` 快照 JSON → 落盘形状的最后一小段投影（spec §5.2 →
/// §5.3）。**宽容解析**：单字段坏 → None，不整盘丢弃——一条字段报错不该让两个
/// 执行环境一起消失。`today_tokens` 整个对象可能是 null（Codex 无计量时），
/// `get("value")` 在 null 上是 None，恰好走诚实降级。执行环境顺序原样保留——快照的
/// dsh→codex 序是数据层的字节契约（r2a_store.rs），托盘不重排（§5.3「不做任何
/// 排序」）。harnesses 数组缺失/不是数组 → 空 vec（落盘后 read 侧 unavailable 兜底，
/// 与「真零」「失败」都无关，是形状违约的防御）。
pub fn harness_rows_from_navigation(snap: &Value) -> Vec<HarnessRow> {
    let Some(harnesses) = snap.get("harnesses").and_then(Value::as_array) else {
        return Vec::new();
    };
    harnesses
        .iter()
        .map(|h| HarnessRow {
            harness_kind: h["harness_kind"].as_str().unwrap_or_default().to_string(),
            // status 缺场 → unavailable（未知状态按「读不了」渲染，不冒充零）。
            status: h["status"].as_str().unwrap_or("unavailable").to_string(),
            today_tokens: h
                .get("today_tokens")
                .and_then(|t| t.get("value"))
                .and_then(Value::as_i64),
            today_partial: h
                .get("today_tokens")
                .and_then(|t| t.get("coverage"))
                .and_then(Value::as_str)
                == Some("partial"),
            today_sessions: h["today_sessions"].as_u64(),
            recent: h
                .get("recent")
                .and_then(Value::as_array)
                .map(|rs| {
                    rs.iter()
                        .map(|r| RecentSessionRow {
                            // 原样透传 SessionKey::to_json 的 4 字段对象——深链时
                            // `sessions read` 期待同形状（字节契约）。
                            session_key: r
                                .get("session_key")
                                .cloned()
                                .unwrap_or(Value::Null),
                            title: r["title"].as_str().map(String::from),
                            date: r["date_last"].as_str().map(String::from),
                            model: r["model"].as_str().map(String::from),
                            tokens: r["tokens_total"].as_i64(),
                        })
                        .collect()
                })
                .unwrap_or_default(),
        })
        .collect()
}

/// `monthly_summary` 的 typed revision 备忘（收敛调查 §2 assembly 段治理，
/// 2026-09-23）：monthly 全量（月窗 SQL × ~11 条 + provider 折叠）实测 3.6s
/// 冷 / 2.5s+ 热，而托盘/菜单只需要它的 `metered_view` 投影。同 authority
/// revision 直接复用上次的 `Arc<MonthlySummary>`——空闲态（revision 不动）
/// 托盘刷新近零成本；活跃态每次 revision 前进重算一次（300s 节流下 ≈1.2%
/// 占空比）。镜像 lib.rs `OverviewMemo` 的模式：进程内存、单条、无持久化。
/// 键 = (revision, month, data_home)。month 必须进键：月初翻页而 revision
/// 静止（整夜空闲无写）时，缺它会把上月的 metered_view 当本月供出——验收
/// 抓出的窄窗口回退。data_home 进键：单例被并行测试共享时不同 tmp 目录
/// 不得互相污染（read_memo 纪律：params 必须含影响结果的全部输入）。
pub type MonthlyMemoEntry = (
    MemoKey,
    std::sync::Arc<agent_vitals_data::projection::MonthlySummary>,
);
pub type MemoKey = (u64, String, String);

pub struct MonthlySummaryMemo(pub std::sync::Mutex<Option<MonthlyMemoEntry>>);

/// 进程单例：`read_overview_at` 是自由函数且调用点众多（sync tick / IPC /
/// 测试），穿透传参的改动面不成比例；静态 OnceLock 与 lib.rs 里 managed 的
/// `OverviewMemo` 语义一致（进程内存、单条、无持久化）。
static MONTHLY_MEMO: std::sync::OnceLock<MonthlySummaryMemo> = std::sync::OnceLock::new();

fn monthly_memo() -> &'static MonthlySummaryMemo {
    MONTHLY_MEMO.get_or_init(|| MonthlySummaryMemo(std::sync::Mutex::new(None)))
}

impl MonthlySummaryMemo {
    /// 命中或计算。revision 读取失败 → 视为必 miss（每次全量），与
    /// `OverviewMemo` 的降级语义一致。
    pub fn get_or_compute(
        &self,
        dh: &Path,
        month: &str,
    ) -> Option<std::sync::Arc<agent_vitals_data::projection::MonthlySummary>> {
        let revision = agent_vitals_data::authority::AuthorityDb::open_readonly(
            &agent_vitals_data::authority::default_authority_path(dh),
        )
        .ok()
        .and_then(|db| db.revision().ok());
        let Some(revision) = revision else {
            let fresh = monthly_summary_arc(dh, month)?;
            return Some(fresh);
        };
        let key = (revision, month.to_string(), dh.display().to_string());
        {
            let guard = self.0.lock().unwrap_or_else(|e| e.into_inner());
            if let Some((k, cached)) = guard.as_ref() {
                if *k == key {
                    return Some(std::sync::Arc::clone(cached));
                }
            }
        }
        let fresh = monthly_summary_arc(dh, month)?;
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) =
            Some((key, std::sync::Arc::clone(&fresh)));
        Some(fresh)
    }
}

fn monthly_summary_arc(dh: &Path, month: &str) -> Option<std::sync::Arc<agent_vitals_data::projection::MonthlySummary>> {
    use agent_vitals_data::repository::SummaryRepository;
    let repo = agent_vitals_runtime::summary::SqlSummaryRepository::at(dh);
    repo.open_db()?;
    Some(std::sync::Arc::new(
        repo.monthly_summary(&agent_vitals_data::repository::MonthlySummaryQuery { month: month.to_string() }),
    ))
}

/// assembly 专用（REFRESH_STORM R2-F3）：summary / daily 复用本段已算好的
/// memoized monthly 与 shared_daily，profiles 走一条只读连接读取——
/// `budget_profiles_status_sql_at` 内部的第二次全量 monthly + daily 现算
/// （月窗 SQL × ~11 条 ×2）不再发生。输出与 sql_at 逐字节等价
/// （runtime tests `budget_profiles_from_parts_matches_sql_at` 钉住）。
/// 降级语义：库打不开（summary/daily 任一缺席或 profiles 读不到）→ None，
/// 与 sql_at 在 `AuthorityDb::open` 失败时返回 None 对齐——差异仅在"库文件
/// 不存在"的边角：sql_at 的写模式 open 会顺带建库并给出默认 profile DTO，
/// 这里如实返回 None（读路径不该有建库副作用）。
fn budget_profiles_reuse_parts(
    dh: &Path,
    month: &str,
    summary: Option<&agent_vitals_data::projection::MonthlySummary>,
    daily: Option<&agent_vitals_data::projection::DailySummary>,
) -> Option<Value> {
    let summary = summary?;
    let daily = daily?;
    let db = agent_vitals_data::authority::AuthorityDb::open_readonly(
        &agent_vitals_data::authority::default_authority_path(dh),
    )
    .ok()?;
    let profiles = db.budget_profiles_get().ok()?;
    agent_vitals_runtime::budget::budget_profiles_status_from_parts(
        dh, month, profiles, summary, daily,
    )
}

#[derive(Serialize)]
pub struct Overview {
    pub data_home: String,
    pub today: Option<Value>,
    pub month: Value,
    pub days: Vec<DayRow>,
    pub budget_monthly_cny: Option<f64>,
    pub budget: BudgetAlert,
    /// 双预算 profile 的实时状态；各 profile 保持独立币种和计费口径。
    pub budget_profiles: Option<Value>,
    /// 「按量费用」三级口径视图（domain `metered_view`：账单 > 归因估算 > 默认估算，
    /// 按币分栏），今日 / 本月各一份，来自 SQL 权威库的 daily/monthly DTO——与工作台
    /// 总览卡同源。托盘标题与「今日/本月按量成本」两行优先读它；此前托盘从 DSH
    /// state + claude ledger 自己拼钱（`metered_amount`），归因后钱搬进
    /// `metered_declared` 那条路看不见，菜单栏变成「今日 —」（2026-09-17）。
    /// None = 库打不开（退回旧拼法）。
    pub metered_today: Option<Value>,
    pub metered_month: Option<Value>,
    /// 今日跨执行环境 token 总量（SQL daily DTO `tokens_by_harness` 四桶之和，含缓存读写）
    /// ——与工作台「今日消耗」KPI 同一个数。托盘标题「鸟头 + 64.4M」读它；None =
    /// 库打不开（退回 DSH state + claude ledger 的旧合并）。
    pub today_tokens_sql: Option<i64>,
    /// 菜单栏同步回路状态（tick 落盘）。前端据此示警/给「立即同步」入口。
    pub sync: SyncStatus,
    /// 多执行环境导航行（tick 落盘 harnesses.json）。托盘据此渲染 L1 执行环境行 + L2 最近会话。
    pub harnesses: Vec<HarnessRow>,
    /// harnesses.json 的 `generated_at`（RFC3339 UTC）——托盘渲染时据此判 stale
    /// （spec §6 决策 5），与 harnesses 同源同刻，拆开是因为 stale 是派生值不入盘。
    pub harnesses_generated_at: Option<String>,
    pub estimate_note: String,
    /// Claude Code 成本估（账卡分列，D2）：`claude_today` = core `claude_day_cost`
    /// 折 claude-ledger 当日 flat 直图的整报告；`claude_month` = 当月逐日
    /// currency_totals 聚合。两者 None = 没有可报价的账日（无账文件 / 当日缺场 /
    /// 当月无账——「没账可报」≠「估 0」，托盘不显示那一段）。钱在**读时**算：
    /// ledger 只存 token，价表会变 token 不会（与 DSH month.json 同一条纪律）。
    pub claude_today: Option<Value>,
    pub claude_month: Option<Value>,
    /// Claude Code 当日 4 型 token 总量（ledger 当日存在 → Some，含计价认不出的
    /// unknown 模型——消耗量与价目卡无关）。托盘合并行 `· N tokens` 用它拼
    /// 「今日合并 token」；`claude_today` 的报告只带钱，token 数在 money 之外要
    /// 单独量（v1.3 合并总账，见 MENUBAR spec）。「当日缺场 → None」与
    /// `claude_today` 同语义，但两者独立：全 unknown 日 = 有 token、无钱。
    pub claude_today_tokens: Option<i64>,
    /// v0.7 spec §3 第二行菜单栏视图：month.json by_model 折平后做 DSH 8 桶
    /// → Claude 4 型 snake 适配（peak_* 丢弃、其他键按 catalog 输入约定改名），
    /// 喂 core `claude_subscription_uncovered_estimate`。`pricing_basis` 已被
    /// core 函数改写为 `estimated-subscription-exclusion`，不在这里二次加工。
    /// 月无 by_model → None（不摆全零结构，与 `claude_month` 同款诚实降级）。
    pub claude_uncovered_month: Option<Value>,
    /// v0.7 spec §3 第三行菜单栏视图：month.json by_model 折平后直接喂
    /// core `cache_counterfactual_cost`（月级无 `providers`，各家模型走 fallback
    /// 价卡，与 `priced_day` 对同一份 month.json 的处理一致）。无缓存命中的
    /// 语料下 ratio 恒为 1.0（spec §3 原文引用，2026-09-02 实测值），不是
    /// bug——这是"当前能表达的节约来源只有缓存"这一事实的忠实反映。月无 by_model
    /// → None。
    pub month_savings: Option<Value>,
    /// 兼容旧 IPC 契约；无冻结的、有日期依据的 FX 快照时始终为 None。
    /// 旧速览不能从当前价表获取汇率并折算历史金额。
    pub fx: Option<Value>,
    /// 兼容旧展示契约的 CNY 固定订阅记录之和；不能据此断言已付款。
    /// 新托盘使用下方逐币种整数最小单位字段，不把 USD 丢掉。
    pub subscription_cny_month: Option<f64>,
    /// 本月本地固定订阅记录，按原币种保留整数最小单位；None = 权威库不可读。
    pub subscription_month_by_currency: Option<BTreeMap<String, i64>>,
}

/// 数据根：直接用 runtime 的唯一 `HomeResolver`（`AGENT_VITALS_HOME` →
/// `SKILL_VITALS_HOME` → `~/.agent-vitals`（已存在或 legacy 不存在）→ `~/.skill-vitals`）。
///
/// W3：此前这里是一份手写拷贝，且已和 runtime 分叉（全空白 env 当未设、不回落
/// `USERPROFILE`）。同步改为进程内调用后，同步内部（如 `machine_namespace()`）读的是
/// runtime 的解析——两份不一致就会把事实写到托盘读不到的根，所以只留一份。
pub fn data_home() -> PathBuf {
    agent_vitals_runtime::core::home::data_home()
}


/// 北京时区（UTC+8，无夏令时）今天 → `YYYY-MM-DD`。算法逐字段镜像二进制
/// `codex_cost.rs::civil_from_unix_secs`（Howard Hinnant 的 civil_from_days，
/// div_euclid 版，负 epoch 也正确）。
pub fn today_beijing() -> String {
    agent_vitals_runtime::clock::today_system()
}

/// unix 秒 → 某时区（offset 秒）的 (年, 月, 日)。pub(crate)：lib.rs 的
/// `recent_row_text` 做「date 是否当年」判定（北京年，与导航 day_key 同日界）
/// 复用同一实现，不长第二份历法。
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn civil_from_unix_secs(secs: i64, offset_secs: i64) -> (i64, u32, u32) {
    let days = (secs + offset_secs).div_euclid(86400);
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m as u32, d as u32)
}

fn read_json(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// 旧 config.toml `[budget] monthly_cny`。不存在或无有效用户值时返回None，
/// 不能把旧模板默认¥600冒充用户设置。极简解析只认
/// `[budget]` 节里的 snake_case 标量，不引 toml 依赖。
fn monthly_budget_cny(data_home: &Path) -> Option<f64> {
    let text = std::fs::read_to_string(data_home.join("config.toml")).ok()?;
    let mut in_budget = false;
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with('[') && t.ends_with(']') {
            in_budget = t == "[budget]";
            continue;
        }
        if in_budget {
            if let Some(eq) = t.find('=') {
                let key = t[..eq].trim();
                let val = t[eq + 1..].trim();
                if key == "monthly_cny" {
                    if let Ok(x) = val.trim_end_matches(',').parse::<f64>() {
                        return Some(x);
                    }
                }
            }
        }
    }
    None
}

/// 本月本地账单中的 **CNY 固定订阅月费之和**。用户订阅不属于公共价目；
/// `harness_bills` 是唯一展示源。库不可用或无订阅时返回 None（不显示“¥0”）。
fn monthly_subscriptions_by_currency(data_home: &Path, month: &str) -> Option<BTreeMap<String, i64>> {
    let db = agent_vitals_data::authority::AuthorityDb::open(
        &agent_vitals_data::authority::default_authority_path(data_home),
        agent_vitals_runtime::sql_sync::now_ms(),
    )
    .ok()?;
    let mut totals = BTreeMap::<String, i64>::new();
    for (_harness, _provider, basis, minor, currency) in db.harness_bills_for_period(month).ok()? {
        if basis != "fixed_subscription" || minor <= 0 { continue; }
        let previous = totals.get(&currency).copied().unwrap_or(0);
        totals.insert(currency, previous.checked_add(minor)?);
    }
    Some(totals)
}

/// 月度汇总里的订阅月费，逐币种换成最小单位（分）。币种未声明（空串键）的不进来——
/// 没有币种就不能标 ¥ 或 $，宁可缺也不猜。没有任何订阅 → None（不显示「¥0」）。
fn subscription_from_summary(summary: &agent_vitals_domain::data_contract::MonthlySummary) -> Option<BTreeMap<String, i64>> {
    let by_basis = summary.actual_spend_by_basis();
    let fixed = by_basis.get(&agent_vitals_domain::data_contract::BillingBasis::FixedSubscription)?;
    let totals: BTreeMap<String, i64> = fixed.iter()
        .filter(|(currency, amount)| !currency.is_empty() && amount.is_finite() && **amount > 0.0)
        .map(|(currency, amount)| (currency.clone(), (amount * 100.0).round() as i64))
        .filter(|(_, minor)| *minor > 0)
        .collect();
    if totals.is_empty() { None } else { Some(totals) }
}

#[cfg(test)]
fn monthly_cny_subscriptions(data_home: &Path, month: &str) -> Option<f64> {
    monthly_subscriptions_by_currency(data_home, month)?
        .get("CNY").copied().map(|minor| minor as f64 / 100.0)
}

/// 预算卡：从 SQL 权威库**实时算**（`runtime::budget::evaluate_alert_from_sql`），
/// 不读 `alert.json`（spec §5.2 禁读清单；Tier B 收尾）。`evaluate_alert_from_sql`
/// 内部按 `current_month_beijing()` 的北京毫秒窗查 DSH `peaked_days_map` 再喂
/// 不变的 `domain::budget::evaluate_alert`——口径 = 跨执行环境「按量实付」CNY
/// （PM 决策 2026-09-07，当前唯一 CNY MeteredActual 源是 DSH）。
///
/// **`source = "sql"`、`generated_at = None`**：实时算没有「快照时刻」，预算行
/// 不再自带 5 分钟过期标记——所有数字的新鲜度由托盘「上次同步」行统一承载
/// （facts 同步是另一条回路，见 `SyncStatus`）。旧 alert.json 快照的「评估月
/// ≠ 当前月」漂移（2026-09-01 事故：alert 停在 8 月 292% 超支贴成 9 月）在
/// SQL 面**结构上不可能**，month-stale 校正整段删除。
fn budget_alert_from_sql(dh: &Path) -> BudgetAlert {
    let v = agent_vitals_runtime::budget::evaluate_alert_from_sql(dh);
    let get = |k: &str| v.get(k).cloned();
    BudgetAlert {
        level: get("level").and_then(|x| x.as_str().map(String::from)),
        ratio: get("ratio").and_then(|x| x.as_f64()),
        month_ratio: get("month_ratio").and_then(|x| x.as_f64()),
        effective_daily_budget: get("effective_daily_budget").and_then(|x| x.as_f64()),
        snoozed_until: get("snoozed_until").and_then(|x| x.as_str().map(String::from)),
        reasons: get("reasons").and_then(|x| x.as_array().map(|a| {
            a.iter().filter_map(|r| r.as_str().map(String::from)).collect()
        })),
        today_cost: get("today_cost").and_then(|x| x.as_f64()),
        month_cost: get("month_cost").and_then(|x| x.as_f64()),
        monthly_cny: get("monthly_cny").and_then(|x| x.as_f64()),
        peak_over: get("peak_over").and_then(|x| x.as_bool()),
        adaptive_floor_applied: get("adaptive_floor_applied").and_then(|x| x.as_bool()),
        generated_at: None,
        schema_version: None,
        source: "sql".into(),
    }
}

pub fn read_overview() -> Overview {
    read_overview_at(&data_home())
}

/// 参数化的组装入口——数据根由调用方指定，单测往临时目录写 month.json/today.json
/// 就能端到端验证组装（读文件 → core 折叠 → 展示 JSON），不必碰真实环境变量。
/// `read_overview` 的软预算（收敛调查 §8）：超 5s 记 WARN 并点名最慢段
/// （P3 观测面——基线 p50 2.17s、峰值 31.9s，总耗时段级分解进日志）。
const READ_OVERVIEW_BUDGET: std::time::Duration = std::time::Duration::from_secs(5);

fn read_overview_at(dh: &Path) -> Overview {
    let t_total = std::time::Instant::now();
    let mut slowest = ("none", std::time::Duration::ZERO);
    let note = |name: &str, d: std::time::Duration, slowest: &mut (&'static str, std::time::Duration)| {
        agent_vitals_runtime::logging::log_info(
            "read_overview",
            &format!("{name} 完成，用时 {d:?}"),
        );
        if d > slowest.1 {
            *slowest = (match name {
                "budget_sql" => "budget_sql",
                "assembly" => "assembly",
                _ => "bundle",
            }, d);
        }
    };
    let pricing = load_pricing();
    let today = today_beijing();
    let cur_month = current_month_beijing();

    // Phase 4 §5.2：菜单栏不再直读 state/{today,month,claude-ledger}.json——
    // 三份数据从 SQL 权威库取（`runtime::summary::overview_bundle`，开库一次），
    // 与旧 state JSON 同形，喂**同一批** core 折叠函数（today_cost / month_cost
    // / claude_estimates / rollup_by_model），不重写任何计价。SQL 按北京月窗查，
    // 旧「month.json 停在上个月被当本月」的漂移（2026-09-01 事故）结构上不可能。
    let (bundle, bundle_timings) =
        agent_vitals_runtime::summary::overview_bundle_timed(dh);
    // bundle 三段进「最慢段」竞争（验收 #2：真凶在 bundle 时点名也要准）。
    if bundle_timings.open_ms > slowest.1.as_millis() {
        slowest = ("bundle_open", std::time::Duration::from_millis(bundle_timings.open_ms as u64));
    }
    if bundle_timings.dsh_sql_ms > slowest.1.as_millis() {
        slowest = ("bundle_dsh_sql", std::time::Duration::from_millis(bundle_timings.dsh_sql_ms as u64));
    }
    if bundle_timings.claude_sql_ms > slowest.1.as_millis() {
        slowest = ("bundle_claude_sql", std::time::Duration::from_millis(bundle_timings.claude_sql_ms as u64));
    }

    // 今日：SQL 的 DSH 今日桶（按北京日 key 查出，天生就是「今天」的——无
    // 旧 today.json 的 date-stale 问题）。无 DSH 今日用量 → None（不是「花了 0」）。
    let today_val = bundle
        .dsh_today
        .as_ref()
        .and_then(|d| today_cost(d, &pricing, &today));

    // 本月：DSH 逐日 map → core `month_cost`。SQL 月窗已过滤，`filter_days_to_
    // month` 留作防御性无操作层（键必然在当月）。
    let month_val = filter_days_to_month(&bundle.dsh_month_days, &cur_month);
    let month = month_cost(&month_val, &pricing);

    // 逐日行：`priced_day`（唯一覆盖率校验入口）→ 无 by_model 的日子退回
    // `bucket_cost` 的 fallback 近似。与 core `month_cost` 内部同一套判断。
    let mut days = Vec::new();
    if let Some(map) = month_val.as_object() {
        for (date, day) in map {
            days.push(day_to_row(date, day, &pricing));
        }
        days.sort_by(|a, b| a.date.cmp(&b.date));
    }

    // 预算卡：SQL 权威库实时算（跨执行环境按量 CNY 口径），天生按当月窗——
    // 旧 alert.json 快照的月份漂移校正整段删除（见 budget_alert_from_sql doc）。
    let t_budget = std::time::Instant::now();
    let budget = budget_alert_from_sql(dh);
    note("budget_sql", t_budget.elapsed(), &mut slowest);

    // 多执行环境导航快照：读一次 harnesses.json，拆成 harnesses + generated_at 两个字段
    //（后者供托盘判 stale）。**不做任何排序**——快照的 dsh→codex 序是数据层的
    // 字节契约，托盘只渲染（spec §5.3「托盘不做任何排序/求和/日界换算」）。
    let harnesses_snap = read_harnesses_at(dh);

    // Claude Code 估（账卡分列，D2）：SQL 的 claude 逐日账（`claude-ledger.json`
    // days 同形：实时行级事实优先 + legacy_aggregate 深历史按模型补缺）→ core
    // `claude_day_cost` 折钱。无账日 → (None, None)（诚实「无账可报」，不把缺账
    // 当估 0）。`claude_estimates` 内部按 `today` / `cur_month` 前缀过滤。
    let claude_days = bundle
        .claude_month_days
        .as_object()
        .cloned()
        .unwrap_or_default();
    let (claude_today, claude_month, claude_today_tokens) =
        claude_estimates(&claude_days, &today, &cur_month, &pricing);

    // v0.7 spec §3 第二/三行菜单栏视图：month.json by_model 折平后分别喂
    // `claude_subscription_uncovered_estimate` 与 `cache_counterfactual_cost`。
    // 共用 `core::state::rollup_by_model`（与 CLI `state by-model` 同源字节），
    // 同一份已按 `cur_month` 过滤的 `month_val`——避免在 Tauri 层重复实现
    // 折平逻辑、与 `month_cost` 等核心计算口径不同源就是漂移。两视图输入形状
    // 略不同：uncovered 要 8 桶 → 4 型 snake 适配（peak_* 丢弃 + 键改名），
    // savings 直接吃 8 桶 by_model（DSH 计价面语义）。两者都喂 core 单一
    // 决策点；月无 by_model → (None, None) 同款诚实降级。
    let month_rollup = rollup_by_model(&json!({"days": &month_val}));
    let month_rollup_empty = month_rollup
        .as_object().is_none_or(|m| m.is_empty());
    let (claude_uncovered_month, month_savings) = if month_rollup_empty {
        (None, None)
    } else {
        // DSH 8 桶 → Claude 4 型 snake 适配（与 Python `cli.py` 走同一套）。
        let mut claude_models = Map::new();
        if let Some(obj) = month_rollup.as_object() {
            for (model, buckets) in obj {
                let Some(b) = buckets.as_object() else { continue };
                claude_models.insert(
                    model.clone(),
                    json!({
                        "input_tokens": b.get("uncached_input_tokens").cloned().unwrap_or(json!(0)),
                        "cache_read_input_tokens": b.get("cache_read_tokens").cloned().unwrap_or(json!(0)),
                        "cache_creation_input_tokens": b.get("cache_write_tokens").cloned().unwrap_or(json!(0)),
                        "output_tokens": b.get("output_tokens").cloned().unwrap_or(json!(0)),
                    }),
                );
            }
        }
        let uncovered = claude_subscription_uncovered_estimate(&claude_models, &pricing);
        let savings = cache_counterfactual_cost(&json!({"by_model": month_rollup}), &pricing);
        (uncovered, savings)
    };

    // P3 组装段：包住尾部全部零散 SQL（budget_profiles / metered×2 /
    // today_tokens / recent / sync / fx / subscriptions）——它们此前没有
    // 任何一段有计时，是 2.2s 基线最后一块未观测面。
    let t_asm = std::time::Instant::now();
    use agent_vitals_data::repository::SummaryRepository;
    let shared_daily = {
        let repo = agent_vitals_runtime::summary::SqlSummaryRepository::at(dh);
        repo.open_db().map(|_| {
            repo.daily_summary(&agent_vitals_data::repository::DailySummaryQuery {
                date: today_beijing(),
            })
        })
    };
    // R2-F3：monthly 取一次，metered_month 与 budget_profiles 共用同一个
    // `Arc`——budget_profiles 内部不再第二次全量现算 monthly + daily。
    let monthly_summary_arc = monthly_memo().get_or_compute(dh, &cur_month);
    // 订阅月费与工作台总览同源：月度汇总里的 FixedSubscription 档（计费声明持续生效、
    // 零用量月份照摊）。`harness_bills` 表里根本没有订阅行（声明不落那张表），只读它会让
    // 托盘永远拿不到订阅——「本月成本」曾因此恒为「—（无数据）」。库里有账单行时作兜底。
    let subscription_month_by_currency = monthly_summary_arc
        .as_deref()
        .and_then(subscription_from_summary)
        .or_else(|| monthly_subscriptions_by_currency(dh, &cur_month));
    let overview = Overview {
        data_home: dh.display().to_string(),
        today: today_val,
        month,
        days,
        budget_monthly_cny: budget.monthly_cny.or_else(|| monthly_budget_cny(dh)),
        budget,
        budget_profiles: budget_profiles_reuse_parts(
            dh,
            &cur_month,
            monthly_summary_arc.as_deref(),
            shared_daily.as_ref(),
        ),
        // assembly 段治理（收敛调查 §2）：此前三字段各自 SqlSummaryRepository
        // + open_db + 完整 summary——daily 被算了两遍（metered Day 与
        // today_tokens 同日同查询）；monthly 全量 3.6s 无任何缓存。现在
        // 共享一次 daily 计算，monthly 走 revision 备忘。
        metered_today: shared_daily
            .as_ref()
            .map(|d| metered_view_json(d.metered_view())),
        metered_month: monthly_summary_arc
            .as_ref()
            .map(|m| metered_view_json(m.metered_view())),
        today_tokens_sql: shared_daily
            .as_ref()
            .map(|d| d.tokens_by_harness.values().map(|t| t.total).sum()),
        sync: load_sync_status(dh),
        harnesses: harnesses_snap.harnesses,
        harnesses_generated_at: harnesses_snap.generated_at,
        estimate_note: "估算值，不是账单；覆盖率不足的日子按 fallback 价补齐并标注".to_string(),
        claude_today,
        claude_month,
        claude_today_tokens,
        claude_uncovered_month,
        month_savings,
        fx: None,
        subscription_cny_month: subscription_month_by_currency.as_ref()
            .and_then(|totals| totals.get("CNY"))
            .map(|minor| *minor as f64 / 100.0),
        subscription_month_by_currency,
    };
    note("assembly", t_asm.elapsed(), &mut slowest);
    let total = t_total.elapsed();
    if total > READ_OVERVIEW_BUDGET {
        agent_vitals_runtime::logging::log_warn(
            "read_overview",
            &format!(
                "read_overview 超预算（{total:?} ≥ {:?}），最慢段: {} {:?}（段级明细见 INFO 日志）",
                READ_OVERVIEW_BUDGET, slowest.0, slowest.1
            ),
        );
    }
    overview
}


/// SQL 权威库的 `metered_view`（daily/monthly DTO 的同一投影）。库打不开 → None。
/// `BTreeMap<String, MeteredView>` → IPC JSON（与原 `metered_view_sql` 的
/// 映射逐字节同形）。
fn metered_view_json(view: std::collections::BTreeMap<String, agent_vitals_domain::data_contract::MeteredView>) -> Value {
    Value::Object(view.iter().map(|(c, v)| (c.clone(), v.to_json())).collect())
}


/// claude-ledger 的逐日 flat 账（`{date: {model: 4 型 snake}}`）→ (今日估报告,
/// 当月聚合, 今日 token 总量)。纯函数——today/cur_month 由调用方注入，单测不碰
/// 系统钟。
///
/// · 今日 = core `claude_day_cost` 直出的整报告（per_model 也在，哪天面板想画
///   模型分列不用改这里的契约）；
/// · 当月 = 各账日 `currency_totals` 逐日合并（claude 无时段价、同币相加安全；
///   只算 cur_month 前缀的日子）；
/// · 今日 token = `claude_day_total_tokens`（core，与 `claude_day_cost` 同一对日
///   形状嗅探），当日存在 → Some——包括全 unknown 的「有量无量价」日。
/// 今日缺场 / 当月没有任何可报价账日 → 对应侧 None。`days` 为空 map → (None,
/// None, None)。
fn claude_estimates(
    days: &serde_json::Map<String, Value>,
    today: &str,
    cur_month: &str,
    pricing: &Value,
) -> (Option<Value>, Option<Value>, Option<i64>) {
    let today_report = days.get(today).and_then(|day| claude_day_cost(day, pricing));
    let today_tokens = days.get(today).map(claude_day_total_tokens);
    let mut cny = 0.0f64;
    let mut usd = 0.0f64;
    let mut n = 0u32;
    for (date, day) in days {
        if !date.starts_with(cur_month) {
            continue;
        }
        if let Some(r) = claude_day_cost(day, pricing) {
            cny += r
                .get("currency_totals")
                .and_then(|c| c.get("CNY"))
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            usd += r
                .get("currency_totals")
                .and_then(|c| c.get("USD"))
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            n += 1;
        }
    }
    let month_report = if n > 0 {
        Some(json!({
            "currency_totals": {"CNY": cny, "USD": usd},
            "days": n,
            "estimate_disclaimer": "按模型族官方卡折算的估算，不是账单",
        }))
    } else {
        None
    };
    (today_report, month_report, today_tokens)
}

/// 一天的成本行：`priced_day`（唯一覆盖率校验入口）→ 无 by_model 的日子退回
/// `bucket_cost` 的 fallback 近似。与 core `month_cost` 内部同一套判断。面板逐日
/// 列表与工作台日历共用这一份映射——同一份 month.json 只允许有一个「有没有
/// by_model 就……」的判断（CLAUDE.md 的 cost 教训：日历/budget/菜单栏各写一份，
/// 报出 ¥4.50 vs ¥18.00）。
fn day_to_row(date: &str, day: &Value, pricing: &Value) -> DayRow {
    let (total, peak, basis, coverage) = match priced_day(day, pricing) {
        Some(c) => (
            c["total"].as_f64().unwrap_or(0.0),
            c["peak_total"].as_f64().unwrap_or(0.0),
            c["pricing_basis"].as_str().map(|s| s.to_string()),
            c["coverage"].as_f64(),
        ),
        None => {
            let c = bucket_cost(day, pricing);
            (c["total"].as_f64().unwrap_or(0.0), c["peak_total"].as_f64().unwrap_or(0.0), None, None)
        }
    };
    DayRow { date: date.to_string(), total, peak_total: peak, basis, coverage }
}

/// 北京当前月 `YYYY-MM`（`today_beijing()` 的前 7 位）。工作台日历默认落在当月。
pub fn current_month_beijing() -> String {
    today_beijing()[..7].to_string()
}

/// 把一份 days map 过滤到只保留属于 `month`（"YYYY-MM"）的键。两种情况会让
/// `month.json`/`month-archive.json` 混入不属于目标月的行：①历史遗留脏数据；
/// ②日历月已经翻页，但 `merge_month` 的滚档迁移是写触发的，还没有新数据落盘
/// 就不会迁移，`month.json` 会原样停在上个月（真实事故见 `read_overview_at`
/// 的调用点注释）。`read_overview_at`（总览"本月"卡片）与 `read_month_days_at`
/// （日历 tab IPC）现在共用这一份"读哪个月只认哪个月的键"的判断，不再各写一份
/// ——这正是本文件顶部注释警告过的"同一份 month.json 各写一份判断，报出两个价"
/// 在读侧的镜像版本。
fn filter_days_to_month(raw: &Value, month: &str) -> Value {
    let mut filtered = serde_json::Map::new();
    if let Some(map) = raw.as_object() {
        for (date, day) in map {
            if date.starts_with(month) {
                filtered.insert(date.clone(), day.clone());
            }
        }
    }
    Value::Object(filtered)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Phase 4 §5.2：`read_overview_at` 改读 SQL 权威库后，组装级测试
    /// seed `usage_facts` 行而不是写 state/*.json。DSH 行 = 8 桶词表
    /// （`uncached_input_tokens`…）；claude 行同表不同 harness。`u/cr/cw/o` 是
    /// 4 桶 token，`ts_ms` 决定北京日 key。整数直接拼进 SQL（测试用、零注入面）。
    fn seed_overview_db(dir: &Path) -> agent_vitals_data::authority::AuthorityDb {
        let db = agent_vitals_data::authority::AuthorityDb::open(
            &agent_vitals_data::authority::default_authority_path(dir),
            1,
        )
        .unwrap();
        db.conn()
            .execute(
                "INSERT INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version)
                 VALUES ('r', 1, 'cli', 'succeeded', 1) ON CONFLICT(run_id) DO NOTHING",
                [],
            )
            .unwrap();
        db
    }

    fn seed_fact(
        db: &agent_vitals_data::authority::AuthorityDb,
        id: &str,
        harness: &str,
        model: &str,
        ts_ms: i64,
        (u, cr, cw, o): (i64, i64, i64, i64),
    ) {
        db.conn()
            .execute(
                &format!(
                    "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id,
                         source_event_id, observation_kind, provider_id, model_id, event_ts_ms,
                         event_peak, uncached_input_tokens, cache_read_tokens, cache_write_tokens,
                         output_tokens, ingested_run_id, created_at_ms, updated_at_ms)
                     VALUES ('{id}', '{harness}', 'm', 's', '{id}', 'turn', NULL, '{model}',
                             {ts_ms}, 0, {u}, {cr}, {cw}, {o}, 'r', 1, 1)"
                ),
                [],
            )
            .unwrap();
    }

    /// 北京日 `YYYY-MM-DD` → 该日北京中午的 UTC 毫秒（稳落在同一北京日，
    /// 不碰日界）。
    fn bj_noon_ms(date: &str) -> i64 {
        let (start, _) =
            agent_vitals_data::authority_query::beijing_day_bounds_ms(date).unwrap();
        start + 12 * 3_600_000
    }

    /// v0.6 harness-contract spec §6/§11-M3（G7）：托盘的兜底行不再是本文件的
    /// 硬编码三行，而是从 core `harness_capability::HARNESSES` 派生——遍历
    /// `fold != None` 的执行环境。今天恰好等于旧硬编码（workbuddy 仍
    /// `fold: None`），行为零变化；M4 给 workbuddy 补 `HarnessBillTotals` 后，
    /// 这条测试的期望需要同步改成四行——那正是"注册集派生"要买的东西：
    /// 加执行环境不用回来改这个函数，只需要改 HARNESSES 行。
    #[test]
    fn harnesses_snapshot_unavailable_derives_from_harnesses_registry_fold_capability() {
        let snap = HarnessesSnapshot::unavailable();
        let kinds: Vec<&str> = snap.harnesses.iter().map(|h| h.harness_kind.as_str()).collect();
        assert_eq!(kinds, vec!["dsh", "codex", "claude-code"]);
        for h in &snap.harnesses {
            assert_eq!(h.status, "unavailable");
        }
        assert!(snap.generated_at.is_none());
        // workbuddy 声明 fold: None，不该出现在兜底行里。
        assert!(!kinds.contains(&"workbuddy"));
    }

    /// 北京日期键与二进制 `codex_cost.rs` 同一算法：给出固定 epoch 秒，断言
    /// 产出的 YYYY-MM-DD。1787846400 = 2026-08-28 00:00 北京（= 2026-08-27T16:00Z，
    /// 用 civil_from_days 反算核过：1787788800 = 2026-08-27T00:00Z）。
    #[test]
    fn civil_from_unix_secs_pins_beijing_date() {
        let (y, m, d) = civil_from_unix_secs(1787846400, 8 * 3600);
        assert_eq!((y, m, d), (2026, 8, 28));
        // 再退 1 秒 → 北京 2026-08-27 23:59:59，日期不应进位。
        let (y, m, d) = civil_from_unix_secs(1787846399, 8 * 3600);
        assert_eq!((y, m, d), (2026, 8, 27));
    }

    /// 负 epoch（1970 年前）也正确 —— div_euclid 而不是截断除法。
    #[test]
    fn civil_from_unix_secs_handles_negative_epoch() {
        // -1 = 1969-12-31T23:59:59Z，北京 = 1970-01-01 07:59:59。
        let (y, m, d) = civil_from_unix_secs(-1, 8 * 3600);
        assert_eq!((y, m, d), (1970, 1, 1));
    }

    /// data_home 优先序（纯函数版，env 由测试注入）：显式 env 覆盖 > ~/.agent-vitals
    /// （存在或 legacy 不存在）> ~/.skill-vitals。与 snapshot.rs 的同名测试同一组断言。
    #[test]
    fn data_home_prefers_explicit_env() {
        let tmp = std::env::temp_dir().join("sv-menubar-data-home-test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let get = |k: &str| match k {
            "AGENT_VITALS_HOME" => Some(tmp.join("explicit-a").to_string_lossy().into_owned()),
            "SKILL_VITALS_HOME" => Some(tmp.join("explicit-b").to_string_lossy().into_owned()),
            _ => None,
        };
        // AGENT_VITALS_HOME 优先于 SKILL_VITALS_HOME。
        assert_eq!(
            agent_vitals_runtime::core::home::data_home_from(&get, tmp.clone()),
            tmp.join("explicit-a")
        );
        // 只设 SKILL_VITALS_HOME → 用它。
        let get_b = |k: &str| match k {
            "SKILL_VITALS_HOME" => Some(tmp.join("explicit-b").to_string_lossy().into_owned()),
            _ => None,
        };
        assert_eq!(agent_vitals_runtime::core::home::data_home_from(&get_b, tmp.clone()), tmp.join("explicit-b"));
        // 无 env：~/.agent-vitals 存在 → 用它。
        std::fs::create_dir_all(tmp.join(".agent-vitals")).unwrap();
        let none = |_: &str| None;
        assert_eq!(agent_vitals_runtime::core::home::data_home_from(&none, tmp.clone()), tmp.join(".agent-vitals"));
        // 无 env、~/.agent-vitals 不存在、~/.skill-vitals 存在 → 用 legacy。
        std::fs::remove_dir_all(tmp.join(".agent-vitals")).unwrap();
        std::fs::create_dir_all(tmp.join(".skill-vitals")).unwrap();
        assert_eq!(agent_vitals_runtime::core::home::data_home_from(&none, tmp.clone()), tmp.join(".skill-vitals"));
        // 两个都不存在 → 默认 ~/.agent-vitals。
        std::fs::remove_dir_all(tmp.join(".skill-vitals")).unwrap();
        assert_eq!(agent_vitals_runtime::core::home::data_home_from(&none, tmp.clone()), tmp.join(".agent-vitals"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 新安装没有用户预算声明时必须是None，不能继承模板默认值。
    /// 临时目录名带用途后缀——cargo test 并行执行，两条预算测试必须各用各的目录，
    /// 否则一条 remove_dir_all 会删掉另一条刚写好的 config.toml。
    #[test]
    fn monthly_budget_is_unset_without_user_config() {
        let tmp = std::env::temp_dir().join("sv-menubar-budget-default-test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        assert_eq!(monthly_budget_cny(&tmp), None);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// config.toml 里 `[budget] monthly_cny` 生效，其他节的同名字段不算。
    #[test]
    fn monthly_budget_reads_budget_section_only() {
        let tmp = std::env::temp_dir().join("sv-menubar-budget-read-test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(
            tmp.join("config.toml"),
            "[other]\nmonthly_cny = 1\n[budget]\nmonthly_cny = 888\n",
        )
        .unwrap();
        assert_eq!(monthly_budget_cny(&tmp), Some(888.0));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 组装级测试（Phase 4 §5.2：改 seed SQL 权威库）：seed 今日 + 两个当月日的
    /// DSH `usage_facts`，`read_overview_at` 应产出与 core 计价一致的数字——
    /// deepseek-v4-flash uncached off_peak ¥1.5/M：今日 1M → ¥1.5、本月三日
    /// (1+1+2)M → ¥6.0、逐日行按日期排序、预算读 config.toml 的 888。
    /// SQL 事实恒带 model_id → 每日 `basis = "exact"`（旧 month.json 无 by_model
    /// 的「partial/legacy」形态在 SQL 面结构上不存在）。
    #[test]
    fn read_overview_assembles_sql_facts_into_expected_numbers() {
        let tmp = std::env::temp_dir().join("sv-menubar-overview-sql-test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        std::fs::write(tmp.join("config.toml"), "[budget]\nmonthly_cny = 888\n").unwrap();

        let cm = current_month_beijing();
        let today = today_beijing();
        // 两个 ≠ 今天的当月日（{05,15,25} 里至多一个等于今天）。
        let others: Vec<String> = ["05", "15", "25"]
            .iter()
            .map(|d| format!("{cm}-{d}"))
            .filter(|d| d != &today)
            .take(2)
            .collect();
        let db = seed_overview_db(&tmp);
        seed_fact(&db, "t", "dsh", "deepseek-v4-flash", bj_noon_ms(&today), (1_000_000, 0, 0, 0));
        seed_fact(&db, "a", "dsh", "deepseek-v4-flash", bj_noon_ms(&others[0]), (1_000_000, 0, 0, 0));
        seed_fact(&db, "b", "dsh", "deepseek-v4-flash", bj_noon_ms(&others[1]), (2_000_000, 0, 0, 0));
        drop(db);

        let ov = read_overview_at(&tmp);
        let today_total = ov.today.expect("今日有事实").get("total").unwrap().as_f64().unwrap();
        assert!((today_total - 1.5).abs() < 1e-9, "今日应 1.5，got {today_total}");
        let month_total = ov.month.get("total").unwrap().as_f64().unwrap();
        assert!((month_total - 6.0).abs() < 1e-9, "本月应 6.0（1.5+1.5+3.0），got {month_total}");
        assert_eq!(ov.days.len(), 3, "三个当月日");
        assert!(ov.days.iter().all(|d| d.basis.as_deref() == Some("exact")),
                "SQL 事实恒带 model → 每日 exact");
        assert!(ov.days.windows(2).all(|w| w[0].date <= w[1].date), "按日期升序");
        assert_eq!(ov.budget_monthly_cny, Some(888.0));

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// **真机回归**（2026-09-01 的 SQL 面版本）：库里有上个月的 DSH 事实，
    /// `read_overview_at` 的「本月」必须只认当月窗——旧事故是 `month.json`
    /// 停在上个月被整份当本月展示（¥1752.4、292% 超支）。SQL 按北京月窗查，
    /// 结构上不可能，这条钉住月窗归属。
    #[test]
    fn read_overview_month_is_current_window_only() {
        let tmp = std::env::temp_dir().join("sv-menubar-overview-monthwin-test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let cm = current_month_beijing();
        let (start, _) =
            agent_vitals_data::authority_query::beijing_month_bounds_ms(&cm).unwrap();
        let db = seed_overview_db(&tmp);
        // 上个月最后一刻（月窗起点前 1 秒）——量给大，漏进来立刻看得出。
        seed_fact(&db, "prev", "dsh", "deepseek-v4-flash", start - 1_000, (900_000_000, 0, 0, 0));
        drop(db);

        let ov = read_overview_at(&tmp);
        assert_eq!(ov.month.get("total").unwrap().as_f64().unwrap(), 0.0,
                   "上月事实不得进本月总额");
        assert!(ov.days.is_empty(), "上月的逐日行不得出现在本月逐日列表");
        assert!(ov.today.is_none(), "今天无事实 → None");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 空态诚实：数据根没有任何 state 文件 → today None（不是 0 元）、month {0,0}、
    /// days 空、预算保持未设置。不摆全零结构冒充「今天花了 0 元」。
    #[test]
    fn read_overview_empty_state_is_honest() {
        let tmp = std::env::temp_dir().join("sv-menubar-overview-empty-test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("state")).unwrap();
        let ov = read_overview_at(&tmp);
        assert!(ov.today.is_none());
        assert_eq!(ov.month.get("total").unwrap().as_f64().unwrap(), 0.0);
        assert!(ov.days.is_empty());
        assert_eq!(ov.budget_monthly_cny, None);
        // 预算卡实时算自 SQL 权威库：空库没有用户配置 → no_budget；成本仍可
        // 统计，但预算分母、比例和日预算均为空。
        assert_eq!(ov.budget.source, "sql");
        assert_eq!(ov.budget.level.as_deref(), Some("no_budget"));
        assert_eq!(ov.budget.month_cost, None, "无按量事实不摆 0 元");
        assert_eq!(ov.budget.month_ratio, None);
        assert_eq!(ov.budget.monthly_cny, None);
        assert_eq!(ov.budget.effective_daily_budget, None);
        assert_eq!(ov.budget.generated_at, None, "实时算无快照时刻");
        // 无 claude-ledger.json → claude 估两侧 None（诚实「没账可报」，不摆估 0）。
        assert!(ov.claude_today.is_none());
        assert!(ov.claude_month.is_none());
        assert!(ov.claude_today_tokens.is_none());
        assert!(ov.fx.is_none(), "未启用历史 FX 快照时，不向速览提供可变汇率");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 预算卡接线：`budget_alert_from_sql` 反映**权威库当月**的 DSH 按量事实，
    /// 且**只认当月**——旧 alert.json 快照的「评估月 ≠ 当前月」漂移（2026-09-01
    /// 事故：8 月 292% 超支贴成 9 月）在 SQL 面结构上不可能，这条钉住它。
    /// 决策逻辑本身（档位/adaptive floor/snooze）在 `runtime::budget` 的 5 个
    /// 用例里覆盖，这里只钉 Tauri 层的接线 + 月窗归属。
    #[test]
    fn budget_alert_from_sql_reflects_current_month_facts_only() {
        let tmp = std::env::temp_dir().join("sv-menubar-budget-sql-wire-test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let db = agent_vitals_data::authority::AuthorityDb::open(
            &agent_vitals_data::authority::default_authority_path(&tmp),
            1,
        )
        .unwrap();
        db.conn()
            .execute(
                "INSERT INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version)
                 VALUES ('r', 1, 'cli', 'succeeded', 1)",
                [],
            )
            .unwrap();
        // 测试用整数/固定串直接拼进 SQL（无外部输入，注入面为零）——src-tauri
        // 不直接依赖 rusqlite，拿不到 `params!` 宏。
        let seed = |id: &str, ts_ms: i64, u: i64| {
            db.conn()
                .execute(
                    &format!(
                        "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id,
                             source_event_id, observation_kind, provider_id, model_id, event_ts_ms,
                             event_peak, uncached_input_tokens, cache_read_tokens, cache_write_tokens,
                             output_tokens, ingested_run_id, created_at_ms, updated_at_ms)
                         VALUES ('{id}', 'dsh', 'm', 's', '{id}', 'turn', NULL, 'deepseek-v4-flash',
                                 {ts_ms}, 0, {u}, 0, 0, 0, 'r', 1, 1)"
                    ),
                    [],
                )
                .unwrap();
        };
        let cm = current_month_beijing();
        let (m_start, _) =
            agent_vitals_data::authority_query::beijing_month_bounds_ms(&cm).unwrap();
        // 当月一笔大额按量事实；上个月一笔（北京月起点前 1 秒 = 上月最后一刻）。
        seed("cur", m_start + 1_000, 500_000_000);
        seed("prev", m_start - 1_000, 900_000_000);
        db.conn()
            .execute(
                "INSERT INTO budget_config(config_id, monthly_cny_minor, daily_cny_minor,
                     warning_ratio_bp, updated_at_ms) VALUES (1, 100, 50, 8000, 1)",
                [],
            )
            .unwrap();
        drop(db);

        let ov = read_overview_at(&tmp);
        let b = &ov.budget;
        assert_eq!(b.source, "sql");
        let mc = b.month_cost.expect("当月有事实 → month_cost 非 None");
        assert!(mc > 0.0);
        // 上个月那笔（量更大）绝不能进本月——若月窗错了 month_cost 会翻数倍。
        // 用「本月只有 cur 一笔」的独立重算当上界：peaked_days_map 当月窗。
        let db2 = agent_vitals_data::authority::AuthorityDb::open(
            &agent_vitals_data::authority::default_authority_path(&tmp),
            1,
        )
        .unwrap();
        let (_, m_end) =
            agent_vitals_data::authority_query::beijing_month_bounds_ms(&cm).unwrap();
        let cur_only =
            agent_vitals_data::authority_query::peaked_days_map(db2.conn(), "dsh", m_start, m_end)
                .unwrap();
        let recomputed = agent_vitals_domain::cost::month_cost(&cur_only, &load_pricing());
        assert!(
            (mc - recomputed["total"].as_f64().unwrap()).abs() < 1e-6,
            "month_cost 必须等于当月窗重算值（上月那笔不得漏进来）"
        );
        assert_eq!(b.level.as_deref(), Some("over"), "500M flash token 远超 ¥1 月预算");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 本月订阅总额只读本地 harness_bills；公共 pricing.json 不参与。不同币种
    /// 不折算相加，非本月与非订阅账单不进入托盘行。
    #[test]
    fn monthly_cny_subscriptions_reads_local_harness_bills() {
        let tmp = std::env::temp_dir().join("sv-menubar-local-subscriptions-test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let db = seed_overview_db(&tmp);
        let month = current_month_beijing();
        db.harness_bill_put(
            "sub-cny", "claude-code", "minimax", &month, "fixed_subscription",
            11_400, "CNY", "test", 1,
        ).unwrap();
        db.harness_bill_put(
            "sub-usd", "claude-code", "anthropic", &month, "fixed_subscription",
            2_000, "USD", "test", 1,
        ).unwrap();
        db.harness_bill_put(
            "api-cny", "dsh", "deepseek", &month, "metered_actual",
            500, "CNY", "test", 1,
        ).unwrap();
        assert_eq!(monthly_cny_subscriptions(&tmp, &month), Some(114.0));
        let by_currency = monthly_subscriptions_by_currency(&tmp, &month).unwrap();
        assert_eq!(by_currency.get("CNY"), Some(&11_400));
        assert_eq!(by_currency.get("USD"), Some(&2_000));
        assert_eq!(monthly_cny_subscriptions(&tmp, "2000-01"), None);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// claude_estimates 纯函数：flat 直图日（rebuild_days 真机形状，含全零的
    /// `<synthetic>` 未知模型键）→ 今日整报告 + 当月聚合。今日缺场 / 当月无任何
    /// 可报价账日 → None；上个月的账不进当月聚合（ledger 读时仍只认当月键）。
    #[test]
    fn claude_estimates_mix_currencies_and_filter_month() {
        let pricing = load_pricing();
        let zero_day = json!({"<synthetic>": {
            "input_tokens": 0, "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0, "output_tokens": 0}});
        let day_1 = json!({"deepseek-v4-flash": {
            "input_tokens": 2_000_000, "cache_read_input_tokens": 10_000_000,
            "cache_creation_input_tokens": 0, "output_tokens": 400_000},
            "claude-sonnet-5": {
                "input_tokens": 1_000_000, "cache_read_input_tokens": 2_000_000,
                "cache_creation_input_tokens": 0, "output_tokens": 100_000}});
        let day_2 = json!({"claude-sonnet-5": {
            "input_tokens": 100_000, "cache_read_input_tokens": 0,
            "cache_creation_input_tokens": 0, "output_tokens": 20_000}});
        let mut days = serde_json::Map::new();
        days.insert("2026-09-01".into(), day_1.clone());
        days.insert("2026-09-02".into(), day_2);
        days.insert("2026-08-31".into(), day_1); // 上月：不进当月聚合
        days.insert("2026-09-03".into(), zero_day); // 全零未知模型日：不可报价
        let (today, month, today_tokens) =
            claude_estimates(&days, "2026-09-02", "2026-09", &pricing);
        assert_eq!(today_tokens, Some(120_000), "今日 token = 当日全部模型 4 型求和");

        let today_r = today.expect("当日 flat 直图必须可报价");
        let tcny = today_r["currency_totals"]["CNY"].as_f64().unwrap();
        let tusd = today_r["currency_totals"]["USD"].as_f64().unwrap();
        assert!(tcny == 0.0, "当日只有 claude-sonnet-5 → CNY 侧应为 0，got {tcny}");
        assert!(tusd > 0.0, "claude-sonnet-5 按 anthropic USD 卡折算");

        let month_r = month.expect("当月两天可报价");
        assert_eq!(month_r["days"].as_u64().unwrap(), 2, "上月 08-31 与全零日不计入");
        // 聚合 = 当月各可报价日的 currency_totals 逐项相加
        let d1_r = claude_day_cost(&days["2026-09-01"], &pricing).unwrap();
        let expect_cny = d1_r["currency_totals"]["CNY"].as_f64().unwrap();
        let expect_usd = d1_r["currency_totals"]["USD"].as_f64().unwrap()
            + today_r["currency_totals"]["USD"].as_f64().unwrap();
        assert!((month_r["currency_totals"]["CNY"].as_f64().unwrap() - expect_cny).abs() < 1e-9);
        assert!((month_r["currency_totals"]["USD"].as_f64().unwrap() - expect_usd).abs() < 1e-9);

        // 缺今日 / 空 map → 对应 None（token 总量同日缺席 → None）
        let (t_missing, m_ok, tk_missing) = claude_estimates(&days, "2026-09-09", "2026-09", &pricing);
        assert!(t_missing.is_none() && m_ok.is_some() && tk_missing.is_none());
        let empty = serde_json::Map::new();
        let (t_e, m_e, tk_e) = claude_estimates(&empty, "2026-09-02", "2026-09", &pricing);
        assert!(t_e.is_none() && m_e.is_none() && tk_e.is_none());
    }

    /// 端到端（Phase 4 §5.2：改 seed SQL）：库里有当日 + 上月的 claude 事实 →
    /// `read_overview_at` 的 `claude_today`/`claude_month` 落位，上月事实不进
    /// "本月"（SQL 月窗）。claude 事实 (u,cr,cw,o) 映射 ledger 的
    /// (input_tokens, cache_read_input_tokens, cache_creation_input_tokens,
    /// output_tokens)——500K+50K = 550K token；claude-sonnet-5 是 USD 卡。
    #[test]
    fn read_overview_embeds_claude_estimates_from_sql() {
        let tmp = std::env::temp_dir().join("sv-menubar-claude-sql-overview-test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let today = today_beijing();
        let cm = current_month_beijing();
        let (start, _) =
            agent_vitals_data::authority_query::beijing_month_bounds_ms(&cm).unwrap();
        let db = seed_overview_db(&tmp);
        seed_fact(&db, "ct", "claude-code", "claude-sonnet-5", bj_noon_ms(&today),
                  (500_000, 0, 0, 50_000));
        // 上个月一笔——不得进本月聚合。
        seed_fact(&db, "cp", "claude-code", "claude-sonnet-5", start - 1_000,
                  (999_000, 0, 0, 99_000));
        drop(db);

        let ov = read_overview_at(&tmp);
        let today_r = ov.claude_today.expect("当日事实必须折出估");
        assert!(today_r["currency_totals"]["USD"].as_f64().unwrap() > 0.0);
        assert_eq!(ov.claude_today_tokens, Some(550_000), "token 与钱同源同日结构");
        let month_r = ov.claude_month.expect("当月必须有一日");
        assert_eq!(month_r["days"].as_u64().unwrap(), 1, "上月那笔不进本月");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// SyncStatus::ok/fail 构造函数：ok 标志对、stage 对、at 是北京时间（非 None）。
    /// at 的格式由 `beijing_timestamp` 单独钉住，这里只钉「落盘的是可展示时刻」。
    #[test]
    fn sync_status_constructors_flag_and_stage() {
        let ok = SyncStatus::ok("fold", "已折入 s1".into());
        assert!(ok.ok && ok.stage == "fold" && ok.message == "已折入 s1");
        assert!(ok.at.is_some());
        let fail = SyncStatus::fail("discover", "agent-vitals discover 失败".into());
        assert!(!fail.ok && fail.stage == "discover");
        assert!(fail.at.is_some());
    }

    /// 北京时间戳：1787846400 = 2026-08-28 00:00 北京（civil_from_unix_secs 同款
    /// 夹具）。格式 `YYYY-MM-DD HH:MM:SS`，面板可直接展示。
    #[test]
    fn beijing_timestamp_pins_known_epoch() {
        assert_eq!(beijing_timestamp(1787846400), "2026-08-28 00:00:00");
        // +8h → 同日 08:00:00；跨天进位也正确（再 +24h → 08-29）。
        assert_eq!(beijing_timestamp(1787846400 + 8 * 3600), "2026-08-28 08:00:00");
        assert_eq!(beijing_timestamp(1787846400 + 32 * 3600), "2026-08-29 08:00:00");
    }

    /// 缺场默认：没有 last-sync.json → "never / 尚未同步"，ok=false——这是「首次
    /// 启动、还没跑过 tick」的诚实空态，不是失败也不是成功。
    #[test]
    fn sync_status_defaults_to_never_when_missing() {
        let tmp = std::env::temp_dir().join("sv-menubar-sync-missing-test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("state")).unwrap();
        let s = load_sync_status(&tmp);
        assert!(!s.ok && s.stage == "never" && s.message == "尚未同步" && s.at.is_none());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 落盘↔读回往返：save_sync_status_at 写的 JSON 能被 load_sync_status 原样读回
    /// （stage/message/at 不丢）。这是「同步结果可展示」的存储侧契约。
    #[test]
    fn save_then_load_sync_status_round_trips() {
        let tmp = std::env::temp_dir().join("sv-menubar-sync-roundtrip-test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("state")).unwrap();
        let status = SyncStatus::fail("oneline", "oneline 失败（exit 1）：boom".into());
        save_sync_status_at(&tmp, &status);
        let back = load_sync_status(&tmp);
        assert!(!back.ok && back.stage == "oneline");
        assert_eq!(back.message, "oneline 失败（exit 1）：boom");
        assert!(back.at.is_some());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn legacy_sync_status_defaults_dynamic_receipts() {
        let legacy = serde_json::json!({"ok":true,"stage":"complete","message":"新增 0 条","at":null});
        let status: SyncStatus = serde_json::from_value(legacy).unwrap();
        assert!(status.dynamic_harnesses.is_empty());
    }

    #[test]
    fn dynamic_harness_receipt_survives_local_status_persistence() {
        let tmp = std::env::temp_dir().join(format!("sv-dynamic-sync-receipt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let mut status = SyncStatus::ok("complete", "新增 0 条".into());
        status.dynamic_harnesses.push(DynamicHarnessSyncReceipt {
            harness: "harness:zcode".into(), state: "failed".into(),
            error_code: Some("source_unavailable".into()), observed_at: "2026-10-05 12:00:00".into(),
            appended: 0, duplicate: 0,
        });
        save_sync_status_at(&tmp, &status);
        let restored = load_sync_status(&tmp);
        assert_eq!(restored.dynamic_harnesses, status.dynamic_harnesses);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Overview 组装包含 sync：往临时数据根写 last-sync.json，read_overview_at 的
    /// ov.sync 应该原样带出——面板/托盘读 Overview 就能拿到同步状态，不需要第二条
    /// IPC 或第二个文件读取。
    #[test]
    fn read_overview_embeds_sync_status() {
        let tmp = std::env::temp_dir().join("sv-menubar-sync-overview-test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("state")).unwrap();
        save_sync_status_at(&tmp, &SyncStatus::ok("fold", "已折入 sess-x".into()));
        let ov = read_overview_at(&tmp);
        assert!(ov.sync.ok && ov.sync.stage == "fold");
        assert_eq!(ov.sync.message, "已折入 sess-x");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// harnesses.json 往返：save_harnesses_at 写的快照（generated_at + 两行，含 partial
    /// 态）能由 read_harnesses_at 原样读回。session_key 用 `SessionKey::to_json()` 的
    /// 真实形状构造——这是「深链透传给工作台」的字节契约：读回后必须仍能过
    /// `SessionKey::from_json`，一旦在 HarnessRow 里拆开重排，`sessions read` 就认
    /// 不出它了。
    #[test]
    fn harnesses_save_then_read_round_trips() {
        use agent_vitals_domain::session_key::SessionKey;
        let tmp = std::env::temp_dir().join("sv-menubar-harnesses-roundtrip-test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("state")).unwrap();
        let key = SessionKey::new("dsh", "sess-1", "default", "m1").to_json();
        let saved = HarnessesSnapshot {
            generated_at: Some("2026-09-01T02:31:00Z".into()),
            harnesses: vec![
                HarnessRow {
                    harness_kind: "dsh".into(),
                    status: "partial".into(),
                    today_tokens: Some(1234),
                    today_partial: true,
                    today_sessions: Some(2),
                    recent: vec![RecentSessionRow {
                        session_key: key.clone(),
                        title: Some("重构 r2a 查询".into()),
                        date: Some("2026-08-28".into()),
                        model: Some("deepseek-v4-flash".into()),
                        tokens: Some(88000),
                    }],
                },
                HarnessRow::unavailable("codex"),
            ],
        };
        save_harnesses_at(&tmp, &saved);
        let back = read_harnesses_at(&tmp);
        assert_eq!(back, saved);
        assert!(
            SessionKey::from_json(&back.harnesses[0].recent[0].session_key).is_some(),
            "落盘的 session_key 必须仍是 SessionKey::to_json 形状"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 缺场兜底：没有 harnesses.json → generated_at None + 固定三行 unavailable
    /// （dsh→codex→claude-code，status "unavailable"），L1 全 None——托盘永远
    /// 渲染三行，「—」是缺失不是 0；无 generated_at 也就无 stale footer（从未
    /// 成功过）。
    #[test]
    fn harnesses_missing_falls_back_to_three_unavailable_rows() {
        let tmp = std::env::temp_dir().join("sv-menubar-harnesses-missing-test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("state")).unwrap();
        let snap = read_harnesses_at(&tmp);
        assert!(snap.generated_at.is_none());
        let harnesses = &snap.harnesses;
        assert_eq!(harnesses.len(), 3);
        assert_eq!(harnesses[0].harness_kind, "dsh");
        assert_eq!(harnesses[1].harness_kind, "codex");
        assert_eq!(harnesses[2].harness_kind, "claude-code");
        assert!(harnesses
            .iter()
            .all(|h| h.status == "unavailable"
                && h.today_tokens.is_none()
                && h.today_sessions.is_none()
                && h.recent.is_empty()));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 解析失败兜底：harnesses.json 是合法 JSON 但形状不对（数组而不是信封对象）→
    /// 同缺场回退。一条坏文件不该让菜单整块消失。
    #[test]
    fn harnesses_parse_failure_falls_back_to_unavailable() {
        let tmp = std::env::temp_dir().join("sv-menubar-harnesses-corrupt-test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("state")).unwrap();
        std::fs::write(tmp.join("state").join("harnesses.json"), r#"["dsh"]"#).unwrap();
        let snap = read_harnesses_at(&tmp);
        assert!(snap.generated_at.is_none());
        let harnesses = &snap.harnesses;
        assert_eq!(harnesses.len(), 3);
        assert_eq!(harnesses[0].harness_kind, "dsh");
        assert_eq!(harnesses[1].harness_kind, "codex");
        assert_eq!(harnesses[2].harness_kind, "claude-code");
        assert!(harnesses.iter().all(|h| h.status == "unavailable"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// Overview 组装包含 harnesses：往临时数据根写 harnesses.json，read_overview_at 的
    /// ov.harnesses 原样带出 + ov.harnesses_generated_at 同源；空态（无 harnesses.json）→
    /// generated_at None + 固定两行 unavailable。托盘读 Overview 一次就拿到执行环境
    /// 行，不需要第二条 IPC 或第二个文件读取。
    #[test]
    fn read_overview_embeds_harnesses() {
        let tmp = std::env::temp_dir().join("sv-menubar-harnesses-overview-test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("state")).unwrap();
        save_harnesses_at(
            &tmp,
            &HarnessesSnapshot {
                generated_at: Some("2026-09-01T02:31:00Z".into()),
                harnesses: vec![
                    HarnessRow::unavailable("dsh"),
                    HarnessRow::unavailable("codex"),
                ],
            },
        );
        let ov = read_overview_at(&tmp);
        assert_eq!(ov.harnesses.len(), 2);
        assert_eq!(ov.harnesses[0].harness_kind, "dsh");
        assert!(ov.harnesses[0].status == "unavailable");
        assert_eq!(
            ov.harnesses_generated_at.as_deref(),
            Some("2026-09-01T02:31:00Z")
        );

        let tmp2 = std::env::temp_dir().join("sv-menubar-harnesses-overview-empty-test");
        let _ = std::fs::remove_dir_all(&tmp2);
        std::fs::create_dir_all(tmp2.join("state")).unwrap();
        let ov2 = read_overview_at(&tmp2);
        // harnesses.json 缺场 → 固定三行 unavailable（dsh→codex→claude-code）。
        assert_eq!(ov2.harnesses.len(), 3);
        assert_eq!(ov2.harnesses[0].harness_kind, "dsh");
        assert_eq!(ov2.harnesses[1].harness_kind, "codex");
        assert_eq!(ov2.harnesses[2].harness_kind, "claude-code");
        assert!(ov2.harnesses_generated_at.is_none());
        let _ = std::fs::remove_dir_all(&tmp);
        let _ = std::fs::remove_dir_all(&tmp2);
    }

    /// `sessions navigation` 快照 → HarnessRow 映射：完整形状逐字段落位、null 的
    /// today_tokens 对象（Codex 无计量）诚实 None、status 缺场 → unavailable、
    /// harnesses 数组缺失 → 空 vec。映射规则全在这——托盘菜单只渲染不重算。
    #[test]
    fn harness_rows_from_navigation_maps_snapshot_fields() {
        let snap = serde_json::json!({
            "schema_version": 1,
            "generated_at": "2026-09-01T02:31:00Z",
            "harnesses": [
                {
                    "harness_kind": "dsh",
                    "status": "ready",
                    "today_tokens": {"value": 1398214, "basis": "state-file", "coverage": "complete"},
                    "today_sessions": 3,
                    "recent": [{
                        "session_key": {"harness_kind": "dsh", "native_id": "s1", "source_profile": null, "machine_namespace": null},
                        "title": "重构 r2a 查询",
                        "model": "deepseek-v4-flash",
                        "tokens_total": 88000,
                        "date_first": "2026-08-27",
                        "date_last": "2026-08-28",
                        "revision": "2026-08-28"
                    }],
                    "store_revision": 7
                },
                {
                    "harness_kind": "codex",
                    "status": "partial",
                    // Codex 无计量时 today_tokens 是整对象 null——get("value") 为
                    // None，恰好走诚实降级（「—」），不把 null 当成 0。
                    "today_tokens": null,
                    "today_sessions": null,
                    "recent": [],
                    "store_revision": 0
                }
            ]
        });
        let rows = harness_rows_from_navigation(&snap);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].harness_kind, "dsh");
        assert_eq!(rows[0].status, "ready");
        assert_eq!(rows[0].today_tokens, Some(1398214));
        assert!(!rows[0].today_partial, "coverage=complete → 无 ≈");
        assert_eq!(rows[0].today_sessions, Some(3));
        assert_eq!(rows[0].recent.len(), 1);
        assert_eq!(rows[0].recent[0].title.as_deref(), Some("重构 r2a 查询"));
        assert_eq!(rows[0].recent[0].date.as_deref(), Some("2026-08-28"));
        assert_eq!(rows[0].recent[0].tokens, Some(88000));
        // session_key 原样透传（4 字段对象）——深链 `sessions read` 的字节契约。
        assert_eq!(
            rows[0].recent[0].session_key["native_id"],
            serde_json::json!("s1")
        );
        assert_eq!(rows[1].harness_kind, "codex");
        assert_eq!(rows[1].status, "partial");
        assert_eq!(rows[1].today_tokens, None, "null 对象 → None，不编 0");
        assert_eq!(rows[1].today_sessions, None);
        assert!(rows[1].recent.is_empty());
    }

    /// 宽容解析的两个防御面：partial 覆盖率 → today_partial（≈ 前缀的数据来源），
    /// harnesses 数组缺失 → 空 vec（不 panic、不整盘丢弃）。
    #[test]
    fn harness_rows_from_navigation_partial_coverage_and_missing_harnesses() {
        let partial = serde_json::json!({
            "harnesses": [{
                "harness_kind": "codex",
                "status": "ready",
                "today_tokens": {"value": 15000, "basis": "events", "coverage": "partial"},
                "today_sessions": 1,
                "recent": [],
                "store_revision": 3
            }]
        });
        let rows = harness_rows_from_navigation(&partial);
        assert_eq!(rows.len(), 1);
        assert!(rows[0].today_partial, "unaccounted>0 → coverage=partial → ≈15K");

        let no_harnesses = serde_json::json!({"schema_version": 1, "generated_at": "2026-09-01T02:31:00Z"});
        assert!(harness_rows_from_navigation(&no_harnesses).is_empty());
    }

    /// day_to_row 三态：exact（by_model 覆盖完整 → basis "exact"、coverage 1.0）、
    /// partial（覆盖 30% → basis "partial"、coverage 0.3）、无 by_model（→ basis
    /// None、bucket_cost fallback）。夹具与 core `cost.rs` 的 `priced_day_*` 三测
    /// 同一组——菜单栏逐日行不许给同一份日桶报出另一个价。
    #[test]
    fn day_to_row_pins_exact_partial_and_legacy_states() {
        let pricing = load_pricing();
        let bucket = |uncached: u64| serde_json::json!({
            "uncached_input_tokens": uncached, "output_tokens": 0,
            "cache_read_tokens": 0, "cache_write_tokens": 0,
            "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
            "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0,
        });
        let exact = serde_json::json!({
            "uncached_input_tokens": 1000000, "output_tokens": 0,
            "cache_read_tokens": 0, "cache_write_tokens": 0,
            "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
            "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0,
            "by_model": {"deepseek-v4-flash": bucket(1000000)},
        });
        let partial = serde_json::json!({
            "uncached_input_tokens": 1000000, "output_tokens": 0,
            "cache_read_tokens": 0, "cache_write_tokens": 0,
            "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
            "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0,
            "by_model": {"deepseek-v4-flash": bucket(300000)},
        });
        let legacy = serde_json::json!({
            "uncached_input_tokens": 1000000, "output_tokens": 0,
            "cache_read_tokens": 0, "cache_write_tokens": 0,
            "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
            "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0,
        });

        let e = day_to_row("2026-08-01", &exact, &pricing);
        assert_eq!(e.basis.as_deref(), Some("exact"));
        assert_eq!(e.coverage, Some(1.0));
        assert!((e.total - 1.5).abs() < 1e-9);

        let p = day_to_row("2026-08-02", &partial, &pricing);
        assert_eq!(p.basis.as_deref(), Some("partial"));
        assert!((p.coverage.unwrap() - 0.3).abs() < 1e-9);

        let l = day_to_row("2026-08-03", &legacy, &pricing);
        assert_eq!(l.basis, None);
        assert_eq!(l.coverage, None);
        assert!((l.total - 1.5).abs() < 1e-9);
    }

    /// current_month_beijing 就是 today_beijing() 的月键——日历默认月跟着「北京
    /// 今天」走，不引日期库。
    #[test]
    fn current_month_beijing_matches_today_prefix() {
        assert_eq!(current_month_beijing(), today_beijing()[..7].to_string());
    }

    #[test]
    fn sync_pause_control_round_trips_and_corruption_fails_closed() {
        let tmp = std::env::temp_dir().join("sv-menubar-sync-control-test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        assert!(!sync_is_paused_at(&tmp).unwrap(), "缺控制文件默认继续同步");
        save_sync_paused_at(&tmp, true).unwrap();
        assert!(sync_is_paused_at(&tmp).unwrap(), "暂停必须跨重启持久化");
        save_sync_paused_at(&tmp, false).unwrap();
        assert!(!sync_is_paused_at(&tmp).unwrap());
        std::fs::write(tmp.join("state/sync-control.json"), "not-json").unwrap();
        assert!(sync_is_paused_at(&tmp).is_err(), "损坏控制状态必须阻止静默扫描");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    // ── v0.7 spec §3 第二/三行菜单栏视图接线钉测 ────────────────────────
    // 与 CLI `state uncovered`/`state savings`（commit a577497）同源字节——
    // Tauri 侧走的是 `core::state::rollup_by_model` + `core::cost::{
    // claude_subscription_uncovered_estimate, cache_counterfactual_cost}` 同一条
    // 路径，月无 by_model → (None, None) 同款诚实降级（不摆全零结构）。

    /// 当月无 DSH 事实 → month_rollup 空 → 两视图都 None（诚实降级，不摆全零
    /// 结构）。旧「有顶层 8 桶但无 by_model」的老形状在 SQL 面不存在——
    /// `peaked_days_map` 恒带 by_model。
    #[test]
    fn read_overview_v07_uncovered_and_savings_both_null_when_no_facts() {
        let tmp = std::env::temp_dir().join("sv-menubar-v07-empty-sql-test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        drop(seed_overview_db(&tmp)); // 建库但不 seed 事实
        let ov = read_overview_at(&tmp);
        assert!(ov.claude_uncovered_month.is_none(), "无事实 → uncovered None");
        assert!(ov.month_savings.is_none(), "无事实 → savings None");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 公共目录不携带用户套餐：claude-opus-5 与 deepseek 都进入估算视图。
    /// v0.7 菜单栏视图吃的是 DSH `by_model` rollup（`peaked_days_map` 恒带
    /// by_model），seed 两个 model 的 dsh 事实。
    #[test]
    fn read_overview_v07_uncovered_keeps_unconfirmed_provider() {
        let tmp = std::env::temp_dir().join("sv-menubar-v07-uncovered-sql-test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let d = format!("{}-10", current_month_beijing());
        let db = seed_overview_db(&tmp);
        seed_fact(&db, "o", "dsh", "claude-opus-5", bj_noon_ms(&d), (1_000_000, 0, 0, 0));
        seed_fact(&db, "f", "dsh", "deepseek-v4-flash", bj_noon_ms(&d), (1_000_000, 0, 0, 0));
        drop(db);
        let ov = read_overview_at(&tmp);
        let uncovered = ov.claude_uncovered_month.expect("有已知价卡用量 → uncovered 必须存在");
        assert_eq!(uncovered["pricing_basis"], "estimated-subscription-exclusion");
        assert!(uncovered["per_model"].get("claude-opus-5").is_some(),
                "未确认套餐的 claude-opus-5 必须保留在估算视图");
        assert!(uncovered["per_model"].get("deepseek-v4-flash").is_some(),
                "deepseek-v4-flash 未订阅 → 在 uncovered.per_model");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 全 1M cache_read → savings ratio = 1/30（cached 0.05 vs uncached 1.5）。
    #[test]
    fn read_overview_v07_savings_ratio_is_1_over_30_for_cache_only() {
        let tmp = std::env::temp_dir().join("sv-menubar-v07-savings-sql-test");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let d = format!("{}-10", current_month_beijing());
        let db = seed_overview_db(&tmp);
        // uncached 0、全 cache_read。
        seed_fact(&db, "cr", "dsh", "deepseek-v4-flash", bj_noon_ms(&d), (0, 1_000_000, 0, 0));
        drop(db);
        let ov = read_overview_at(&tmp);
        let savings = ov.month_savings.expect("有 by_model → savings Some");
        assert_eq!(savings["currency"], "CNY");
        let ratio = savings["ratio"].as_f64().expect("ratio 必须是数字");
        assert!((ratio - 1.0 / 30.0).abs() < 1e-9, "全 cache_read → ratio = 1/30，got {ratio}");
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
