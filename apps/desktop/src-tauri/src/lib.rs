//! 菜单栏应用入口：托盘 + 工作台主窗口。计算全部委托给 core（`overview.rs` 只做 I/O
//! 与组装），本文件只负责 Tauri 胶水：托盘菜单、窗口显隐、IPC 命令。
//!
//! 菜单栏本身也展示「今日/本月/预算」三个数字 —— 那是**同一个** `read_overview`
//! 的文本渲染，不是第二份计算。所有金额格式 `fmt_money` 与 core 的 `format_money`
//! 同 spec（≥100 一位小数、否则两位、去尾零），避免菜单栏和工作台对同一份钱报出
//! 两个格式。
mod overview;
mod store;
mod budget_alerts;
// Claude Pro 的额度窗口提醒：与预算提醒共用投递账本，但键按窗口取。
mod quota_alerts;
mod plugin_host;
mod plugin_projections;
mod plugin_state;
mod update_check;
// 「测试」板 Claude IP 风险自检：全部出站探测收敛在此模块（离线包契约：React
// 源码不得含远端 URL / 网络客户端），并按 scutil --proxy 对齐系统代理路由。
mod ip_check;
#[cfg(all(feature = "plugin-isolation-probe", target_os = "macos"))]
mod plugin_isolation_probe;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri_plugin_notification::NotificationExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, atomic::{AtomicU64, Ordering}};
use tauri::menu::{Menu, MenuBuilder, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

use overview::{HarnessRow, HarnessesSnapshot, Overview, RecentSessionRow, SyncStatus};

/// 同步互斥：定时 tick 与「立即同步」（菜单/IPC）共用同一把锁，保证任意时刻至多
/// 一轮 discover→oneline 在跑。oneline 写链本身有 fencing + exactly-once，锁不是
/// 为了防重复写，是防两轮并发白白各折一遍 + 两次托盘重建。
struct SyncLock(Mutex<()>);

/// R4-P0（TRUST_SENSOR_OPTIMIZATION spec §4.1）：执行环境最近活动时刻表。watcher
/// 唤醒时刷新（LIGHT-PATH 的唤醒槽天然携带「哪个执行环境刚有写入」）；trust 传感
/// tick 到点据此门控——冷却窗内无活跃执行环境且空闲确认窗未到 → 整轮跳过（不
/// lsof、不开库、不发事件）。进程内存、无持久化；条目按时限裁剪有界。
struct HarnessActivityTable(std::sync::Mutex<std::collections::BTreeMap<String, std::time::Instant>>);

/// 门控冷却窗：活动时刻在此窗内的执行环境算「活跃」。
const TRUST_ACTIVITY_COOLDOWN: std::time::Duration = std::time::Duration::from_secs(120);
/// 空闲确认窗：兜底「活动表漏记」（app 重启后表为空等），到期强制校准一轮。
const TRUST_IDLE_CONFIRM_WINDOW: std::time::Duration = std::time::Duration::from_secs(600);

impl HarnessActivityTable {
    fn mark(&self, harnesses: impl IntoIterator<Item = impl AsRef<str>>) {
        let now = std::time::Instant::now();
        let mut guard = self.0.lock().unwrap_or_else(|e| e.into_inner());
        for harness in harnesses {
            guard.insert(harness.as_ref().to_string(), now);
        }
        // 有界：只保留冷却窗 + 空闲确认窗内的条目。
        let horizon = TRUST_ACTIVITY_COOLDOWN + TRUST_IDLE_CONFIRM_WINDOW;
        guard.retain(|_, at| now.duration_since(*at) < horizon);
    }

    fn any_active_within(&self, window: std::time::Duration) -> bool {
        let now = std::time::Instant::now();
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .any(|at| now.duration_since(*at) < window)
    }
}

/// R4-P0 门控决策（纯函数，测试钉住 spec §6 门控三行）：候选集为空且距上次
/// 真实采样不足空闲确认窗 → 跳过。任何一者不满足（有活跃执行环境 / 确认窗到期
/// / 从未采样过——首启校准）→ 执行。
fn trust_gate_should_sample(
    initial_sample_pending: bool,
    any_active_in_cooldown: bool,
    since_last_sample: std::time::Duration,
) -> bool {
    initial_sample_pending || any_active_in_cooldown || since_last_sample >= TRUST_IDLE_CONFIRM_WINDOW
}

struct SyncRequests(Mutex<std::collections::BTreeMap<String, bool>>);
static SYNC_REQUEST_SEQ: AtomicU64 = AtomicU64::new(1);
/// 单一 UI 事件出口（EVENT_BUS spec §1.3）：webview 只 listen 这一个通道，
/// 类型在 payload.type 判别。旧 `sync-status-updated` / `usage-fold-updated`
/// 双通道已收编（2026-09-21 迭代 1）；trust 会话的 `trust-monitor-updated`
/// 通道在本次合并时一并收编为 TrustMonitorInvalidated 类型。
const APP_EVENT: &str = "app-event";

/// 只有还没有任何同步回执的启动才主动拉起工作台。后续启动继续保持菜单栏
/// 工具的安静行为；首次用户无需先知道菜单栏入口，能直接看到本机解析说明。
fn should_show_first_value_workspace(sync: &SyncStatus) -> bool {
    sync.stage == "never"
}

fn should_show_workbench_on_start(sync: &SyncStatus, args: &[String]) -> bool {
    should_show_first_value_workspace(sync)
        || args.iter().any(|arg| arg == "--show-workbench")
}

/// 独立的 macOS 菜单栏模板图。不能复用彩色 App Icon：模板图只提供 alpha
/// 轮廓，由 AppKit 根据浅色、深色、选中和辅助功能状态自动着色。44×36px 源图按
/// 22×18pt 呈现，横向画布避免啄木鸟在方形透明留白中显得过小，并保留 Retina 细节。
fn tray_template_icon() -> tauri::Result<tauri::image::Image<'static>> {
    tauri::image::Image::from_bytes(include_bytes!("../icons/trayTemplate@2x.png"))
}

/// 金额修剪 + 符号（`fmt_money`/`fmt_usd` 共享）。尾零与小数点只修剪、不做进位
/// 取舍——精度由上面的档位决定。与 core `cost.rs::format_money` 同 spec。
fn fmt_currency(x: f64, symbol: &str) -> String {
    if x > 0.0 && x < 0.01 {
        return format!("<{symbol}0.01");
    }
    let s = if x >= 100.0 { format!("{x:.1}") } else { format!("{x:.2}") };
    let s = s.trim_end_matches('0').trim_end_matches('.').to_string();
    format!("{symbol}{s}")
}

/// 金额 → `¥600` / `¥774.7` / `¥6.73`。与 core `cost.rs::format_money` 同 spec。
fn fmt_money(x: f64) -> String {
    fmt_currency(x, "¥")
}

/// USD 金额 → `$3` / `$28` / `$0.52`（Claude 估列用）。¥ 与 $ 分开标、不混加
/// （D2 分币分列）——一个数同时标两种货币是记账错误，两个估分开才是诚实。
fn fmt_usd(x: f64) -> String {
    fmt_currency(x, "$")
}

/// RFC3339 时间戳 → unix 秒。只认 alert.json 的机器格式（`2026-08-30T07:04:38.548588+00:00`
/// 这类）：`YYYY-MM-DDTHH:MM:SS[.frac](Z|±HH:MM)`，小数位任意、可缺省。与
/// `overview::civil_from_unix_secs` 互为逆运算（days_from_civil 是 civil_from_days
/// 的反函数，Howard Hinnant 同一套）。解析失败 → None（调用方决定如何处理——
/// 缺新鲜度信息不等于缺数据）。
fn parse_rfc3339_secs(s: &str) -> Option<i64> {
    let t = s.find('T')?;
    let mut d = s[..t].split('-');
    let y: i64 = d.next()?.parse().ok()?;
    let mo: u32 = d.next()?.parse().ok()?;
    let day: u32 = d.next()?.parse().ok()?;
    let rest = s.get(t + 1..)?;
    let h: u32 = rest.get(0..2)?.parse().ok()?;
    let mi: u32 = rest.get(3..5)?.parse().ok()?;
    let se: u32 = rest.get(6..8)?.parse().ok()?;
    // 范围 sanity（不做完整历法校验）：乱填的月份/日期/时分秒解析出来也是垃圾秒数，
    // 会污染 freshness 判据。机器写的 alert.json 不会走到这里，挡住手填测试而已。
    if !(1..=12).contains(&mo) || !(1..=31).contains(&day)
        || h > 23 || mi > 59 || se > 59 {
        return None;
    }
    let tail = rest.get(8..)?;
    // tail = [".frac"] + 时区。时区从第一个 + / - / Z 起算；小数在前的话跳过。
    let tz = match tail.find(['+', '-', 'Z']) {
        Some(p) => &tail[p..],
        None => "Z",
    };
    let offset = if tz == "Z" {
        0
    } else {
        let sign = if tz.starts_with('+') { 1 } else { -1 };
        let oh: i32 = tz.get(1..3)?.parse().ok()?;
        let om: i32 = tz.get(4..6)?.parse().ok()?;
        sign * (oh * 3600 + om * 60)
    };
    let days = days_from_civil(y, mo, day);
    Some(days * 86400 + (h * 3600 + mi * 60 + se) as i64 - offset as i64)
}

/// civil_from_days 的反函数：`(y,m,d)` → 自 1970-01-01 的天数。验证过的一组锚点：
/// days_from_civil(2026,8,27) = 20692（= 1787788800 秒，2026-08-27T00:00Z）。
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = if m > 2 { m as i64 - 3 } else { m as i64 + 9 };
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// 同步 tick 周期（start_refresh_tick 的 sleep 与执行环境区 stale 判定共用——
/// 「2 × tick」是 spec §6 决策 5 的过期定义，周期改了 stale 窗口跟着改，不能
/// 两处各写一个 5 分钟）。
const TICK_PERIOD: std::time::Duration = std::time::Duration::from_secs(5 * 60);
/// watcher wake 恰好撞上手动同步或 trust 快照时的短重试窗。不能把已经消费的
/// 单槽 wake 丢回 5 分钟周期，否则「秒级唤醒」会在锁竞争下静默退化。
const SYNC_LOCK_RETRY_PERIOD: std::time::Duration = std::time::Duration::from_secs(1);

/// 通用过期判定：`generated_at` 年龄 > window。`stale_from`（预算 5 分钟）与
/// `harnesses_stale_from`（执行环境区 2 × tick）共用；「无新鲜度信息」→ 不算过期，
/// 解析失败 → 也不算（机器写的文件不会走到，与工作台 `Invalid Date` 走不 stale
/// 的现状一致）。
fn stale_after(generated_at: Option<&str>, now_secs: i64, window_secs: i64) -> bool {
    let Some(at) = generated_at.and_then(parse_rfc3339_secs) else {
        return false;
    };
    now_secs - at > window_secs
}

/// 预算数据是否过期（> 5 分钟）。与工作台 `workbench.js` 的 `> 5*60*1000` 同一阈值——
/// 托盘和工作台对同一份 alert.json 必须判同一个「过期」，不能一个绿一个黄。
fn stale_from(generated_at: Option<&str>, now_secs: i64) -> bool {
    stale_after(generated_at, now_secs, 5 * 60)
}

/// 预算状态行的权威来源：alert.json（`budget.evaluate()` 落盘）。**只读展示，
/// 不重算百分比**——迁移要修的 D2 缺口正是托盘自算 remaining% 与 budget.py 规则
/// 无关。缺场时降级为「等预算数据」，不臆造「预算超支/剩余 X%」。
///
/// now 由调用方注入（`build_menu` 读一次系统时钟，整个菜单的所有行共用同一个
/// "现在"——各行分别读钟会让同一次重建里的新鲜度判定互相不一致），单测因此不用
/// 碰系统时钟。
#[cfg(test)]
fn budget_status_text_at(ov: &Overview, now_secs: i64) -> String {
    budget_status_text_at_localized(ov, now_secs, NativeUiLanguage::Chinese)
}

fn budget_status_text_at_localized(ov: &Overview, now_secs: i64, language: NativeUiLanguage) -> String {
    if let Some(rows) = ov.budget_profiles.as_ref()
        .and_then(|v| v.get("profiles"))
        .and_then(Value::as_array)
        .filter(|rows| !rows.is_empty())
    {
        let summary = rows.iter().filter_map(|row| {
            let id = row.get("profile_id").and_then(Value::as_str)?;
            let currency = row.get("currency").and_then(Value::as_str)?;
            let level = row.get("level").and_then(Value::as_str)?;
            // 已用 = 按量 + 订阅摊派（total_spent_minor，与总览卡同口径）；旧载荷退回 spent。
            let spent = row.get("total_spent_minor").or_else(|| row.get("spent_minor"))
                .and_then(Value::as_i64).unwrap_or(0);
            let limit = row.get("monthly_minor").and_then(Value::as_i64)?;
            let label = if id == "estimate" {
                native_label(language, "Estimated", "估算")
            } else {
                native_label(language, "Confirmed", "已确认")
            };
            let state = match level {
                "exceeded" => native_label(language, "exceeded", "超支"),
                "warn" => native_label(language, "near limit", "接近"),
                "incomplete" => native_label(language, "partial coverage", "部分覆盖"),
                "no_data" => native_label(language, "no data", "无数据"),
                "disabled" => native_label(language, "disabled", "未启用"),
                _ => native_label(language, "within limit", "正常"),
            };
            Some(format!("{label} {currency} {state} {spent:.2}/{limit:.2}",
                spent = spent as f64 / 100.0, limit = limit as f64 / 100.0))
        }).collect::<Vec<_>>().join(native_label(language, "; ", "；"));
        if !summary.is_empty() {
            return format!("{}{summary}", native_label(language, "Budget: ", "预算："));
        }
    }
    let b = &ov.budget;
    // 预算分母：alert.json 的 monthly_cny 是 evaluate() 算 ratio 用的那份，
    // 与它同屏显示的必须一致；缺场才退回 config。
    let denom = b.monthly_cny.or(ov.budget_monthly_cny);
    let mc = fmt_money(b.month_cost.unwrap_or(0.0));
    let denom_money = denom.map(fmt_money).unwrap_or_else(|| native_label(language, "not set", "未设置").into());
    let base = match (b.source.as_str(), b.level.as_deref()) {
        ("missing", _) => native_label(language, "Budget: waiting for budget data (run a sync)", "预算：等预算数据（跑一次 oneline）").to_string(),
        (_, Some("no_budget")) => native_label(language, "Budget: not set (costs are still tracked)", "预算：未设置（成本仍按实际口径统计）").to_string(),
        (_, Some("over")) => match language {
            NativeUiLanguage::English => format!("🚨 Budget exceeded: {mc} (monthly {denom_money})"),
            NativeUiLanguage::Chinese => format!("🚨 预算超支：{mc}（月 {denom_money}）"),
        },
        (_, Some("snoozed")) => match &b.snoozed_until {
            Some(u) => match language {
                NativeUiLanguage::English => format!("🔕 Budget alerts snoozed until {u}"),
                NativeUiLanguage::Chinese => format!("🔕 预算静默至 {u}"),
            },
            None => native_label(language, "🔕 Budget alerts snoozed", "🔕 预算已静默").to_string(),
        },
        (_, Some("warn")) => {
            // 百分比来自 alert.json 的 month_ratio，不是 (budget - spent)/budget。
            let pct = b.month_ratio.unwrap_or(0.0) * 100.0;
            match language {
                NativeUiLanguage::English => format!("⚠️ Budget {pct:.0}%: {mc} / {denom_money}"),
                NativeUiLanguage::Chinese => format!("⚠️ 预算 {pct:.0}%：{mc} / {denom_money}"),
            }
        }
        (_, Some("disabled")) => native_label(language, "Budget disabled", "预算已禁用").to_string(),
        // ok 或未知 level：显示权威数值本身，不添油加醋。
        _ => match language {
            NativeUiLanguage::English => format!("✓ Budget: {mc} / {denom_money}"),
            NativeUiLanguage::Chinese => format!("✓ 预算：{mc} / {denom_money}"),
        },
    };
    // 健康 ≠ 新鲜度（规格 R1）：数据过期时主入口不得呈现「正常」。✓ 是「一切正常」
    // 语义，stale 时绝不显示它——换成明确的过期标记；over/warn/snoozed 本身有非正常
    // 语义、仍要显示，但带过期后缀，避免「过期还绿」。
    if stale_from(b.generated_at.as_deref(), now_secs) {
        if base.starts_with('✓') {
            match language {
                NativeUiLanguage::English => format!("⚠ Budget (stale data): {mc} / {denom_money}"),
                NativeUiLanguage::Chinese => format!("⚠ 预算（数据过期）：{mc} / {denom_money}"),
            }
        } else {
            format!("{base}{}", native_label(language, " (stale data)", "（数据过期）"))
        }
    } else {
        base
    }
}

/// 大数缩写：≥1M → "1.4M"，≥1K → "8.2K"（<10K 留一位小数），<1K 原样。
fn fmt_tokens(n: i64) -> String {
    if n >= 1_000_000 {
        format!("{:.1}M", n as f64 / 1_000_000.0)
    } else if n >= 1_000 {
        let k = n as f64 / 1_000.0;
        if k < 10.0 { format!("{:.1}K", k) } else { format!("{:.0}K", k) }
    } else {
        n.to_string()
    }
}

/// 托盘标题：菜单栏里图标旁那一段常驻文字。**只放今日 token**（「鸟头 + 64.4M」），
/// 与工作台「今日消耗」KPI 对齐、同一个数（SQL daily DTO 的 `tokens_by_harness`；库缺席
/// 才退回旧合并）。钱不进标题——用户定向 2026-09-17：状态栏要的是消耗量的直观信号，
/// 价格在菜单与工作台里看。无今日数据诚实「—」，不臆造 0。
fn today_title(ov: &Overview) -> String {
    let tokens = today_tokens(ov);
    if tokens > 0 { fmt_tokens(tokens) } else { "—".to_string() }
}

/// 今日 token：SQL DTO 优先（与 KPI 同源），否则旧的 DSH state + claude ledger 合并。
fn today_tokens(ov: &Overview) -> i64 {
    ov.today_tokens_sql.unwrap_or_else(|| today_merged_tokens(ov))
}

/// 模型短名：`deepseek/deepseek-v4-pro-0813` → `deepseek-v4-pro-0813`。只砍
/// provider 前缀（第一个 `/` 之前），不做别的美化——菜单一行的宽度有限，但把
/// `-0813` 这种版本尾巴也砍掉就会让两个不同版本在菜单里长得一模一样。
fn short_model(name: &str) -> &str {
    name.rsplit('/').next().unwrap_or(name)
}

/// 执行环境显示名映射（v0.6 harness-contract spec §6/§11-M3，G7）：从 core
/// `harness_capability::HARNESSES` 行的 `display` 字段读——真相源是 M0 建的注册表，
/// 这里不再是 Tauri 本地字面量表。展示名与数据侧的 `dsh`/`codex` 之类的键值
/// 是两回事——与 `short_model` 同类性质，不落盘、不入快照。未知执行环境（含未来
/// 新加但本二进制还没升级到的执行环境）原样透传，fail-open，不至于长得像个
/// 错别字（`harness_capability::harness_profile` 的查询路径本就 fail-open——注册路径
/// 才 fail-closed，见 v0.6 spec §5.3 条款 2）。WorkBuddy 现在也能正确解析出
/// "WorkBuddy"（此前的本地字面量表没收它，因为它没有托盘行——展示名与"有没有
/// 折叠能力"是两件事，工作台的会话浏览面一直支持 workbuddy）。
fn harness_display_name(kind: &str) -> String {
    agent_vitals_domain::harness_capability::harness_profile(kind)
        .map(|h| h.display.to_string())
        .unwrap_or_else(|| {
            if kind.starts_with("harness:") || kind.starts_with("plugin:") {
                agent_vitals_runtime::harness_registry::plugin_display_name(&overview::data_home(), kind)
            } else {
                kind.to_string()
            }
        })
}

/// 界面用：全部 manifest 执行环境的 `{ "harness:<slug>": 显示名 }`。内置执行环境的名字界面自带。
#[tauri::command(async)]
fn harness_display_names() -> Value {
    let mut map = serde_json::Map::new();
    if let Ok(list) = agent_vitals_runtime::query::app_harnesses::list(&overview::data_home()) {
        if let Some(items) = list["harnesses"].as_array() {
            for item in items { if let Some(id) = item["id"].as_str() { map.insert(id.into(), item["display_name"].clone()); } }
        }
    }
    Value::Object(map)
}

#[tauri::command(async)]
fn harness_inventory(window_days: u16) -> Result<Value, String> {
    agent_vitals_runtime::query::app_harnesses::inventory(&overview::data_home(), window_days,
        agent_vitals_runtime::core::clock::now_ms()).map_err(str::to_string)
}

/// 读 claude 估报告（core `claude_day_cost` / 当月聚合 `currency_totals`）的单侧
/// 币种金额。报告缺场 / 该币键缺场 / 值非数 → 0.0。**0 是「这一侧没有钱」的哨兵，
/// 不是测量到的 0**——CNY 0 意为「当日没有 CNY 价流」（纯 anthropic 卡日）。
fn claude_currency(claude: &Option<Value>, key: &str) -> f64 {
    claude
        .as_ref()
        .and_then(|r| r.get("currency_totals"))
        .and_then(|c| c.get(key))
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
}

/// 旧载荷的菜单兜底：同币种的 DSH 观测值与 Claude 估算可相加，但 USD 始终单列。
/// 有估算分量的币种加 `≈`；无数据返回 None，不把缺价或缺汇率解释成零。
fn metered_amount(dsh_cny: Option<f64>, claude_cny: f64, claude_usd: f64) -> Option<String> {
    let mut parts = Vec::new();
    let claude_cny = if claude_cny.is_finite() && claude_cny > 0.0 { claude_cny } else { 0.0 };
    if let Some(d) = dsh_cny.filter(|v| v.is_finite()) {
        let cny = d + claude_cny;
        parts.push(format!("{}CNY {}", if claude_cny > 0.0 { "≈" } else { "" }, fmt_money(cny)));
    } else if claude_cny > 0.0 {
        parts.push(format!("≈CNY {}", fmt_money(claude_cny)));
    }
    if claude_usd.is_finite() && claude_usd > 0.0 {
        parts.push(format!("≈USD {}", fmt_usd(claude_usd)));
    }
    if parts.is_empty() { None } else { Some(parts.join(" · ")) }
}

/// `metered_view`（`{币种: {amount, actual, declared_estimate, default_estimate, label}}`）
/// → 托盘一格钱。逐币种独立显示，`label` 为估算的币种单独带 `≈`；不再使用 FX
/// 合成一个看似可加的主账。视图为空 → None；旧载荷（None）走上面的兼容兜底。
fn metered_view_text(view: Option<&serde_json::Value>) -> Option<String> {
    let view = view?.as_object()?;
    let mut parts = Vec::new();
    for (currency, value) in view {
        let Some(amount) = value.get("amount").and_then(Value::as_f64).filter(|v| v.is_finite() && *v >= 0.0) else { continue };
        let approximate = value.get("label").and_then(Value::as_str) != Some("actual");
        let formatted = fmt_currency_amount(currency, amount);
        parts.push(format!("{}{currency} {formatted}", if approximate { "≈" } else { "" }));
    }
    if parts.is_empty() { None } else { Some(parts.join(" · ")) }
}

/// 托盘的报告币种上下文：目标币种 + 汇率策略。由菜单构建时从磁盘读一次；测试传 `None`。
struct TrayFx { target: String, policy: agent_vitals_domain::fx::FxPolicy }

impl TrayFx {
    fn load() -> Self {
        let data_home = overview::data_home();
        let (target, _) = agent_vitals_runtime::fx_settings::reporting_currency(&data_home, &system_locale())
            .unwrap_or_else(|_| ("USD".to_string(), true));
        Self { target, policy: agent_vitals_runtime::fx_settings::policy(&data_home) }
    }
}

/// 无小数位的币种（报告币种可选 JPY / KRW / IDR…）；其余按两位小数。
fn zero_decimal_currency(currency: &str) -> bool { matches!(currency, "JPY" | "KRW" | "IDR" | "VND" | "HUF") }

fn fmt_currency_amount(currency: &str, amount: f64) -> String {
    match currency {
        "CNY" => fmt_money(amount),
        "USD" => fmt_usd(amount),
        // 其他币种曾直接 `to_string()`，EUR 会显示成 59.28470000000001。
        // 不足最小单位的非零金额写 `<` 而不是 `0.00`，与 CNY / USD 的 `<¥0.01` 一致。
        _ if zero_decimal_currency(currency) => if amount > 0.0 && amount < 0.5 { "<1".to_string() } else { format!("{:.0}", amount) },
        _ => if amount > 0.0 && amount < 0.005 { "<0.01".to_string() } else { format!("{:.2}", amount) },
    }
}

/// 本月成本一格钱：按量视图 + 订阅月费，逐币种合并（同币相加、跨币不加）。
/// 给了报告币种且**每个币种都能折算**时，显示折算后的约数合计并保留原币种明细
/// （`≈USD $67.3 [CNY ¥182.6 · USD $40]`）；任一币种折不了就整体退回分币种显示，
/// 不能一部分折、一部分不折地拼出一个看似完整的数。
fn month_cost_text(ov: &Overview, fx: Option<&TrayFx>, language: NativeUiLanguage) -> Option<String> {
    let mut totals: std::collections::BTreeMap<String, (f64, bool)> = std::collections::BTreeMap::new();
    if let Some(view) = ov.metered_month.as_ref().and_then(Value::as_object) {
        for (currency, value) in view {
            let Some(amount) = value.get("amount").and_then(Value::as_f64).filter(|v| v.is_finite() && *v >= 0.0) else { continue };
            let approximate = value.get("label").and_then(Value::as_str) != Some("actual");
            let entry = totals.entry(currency.clone()).or_insert((0.0, false));
            entry.0 += amount;
            entry.1 |= approximate;
        }
    }
    if let Some(subs) = ov.subscription_month_by_currency.as_ref() {
        for (currency, minor) in subs.iter().filter(|(_, minor)| **minor > 0) {
            totals.entry(currency.clone()).or_insert((0.0, false)).0 += *minor as f64 / 100.0;
        }
    }
    if totals.is_empty() { return None; }
    let per_currency: Vec<String> = totals.iter().map(|(currency, (amount, approximate))| {
        format!("{}{currency} {}", if *approximate { "≈" } else { "" }, fmt_currency_amount(currency, *amount))
    }).collect();
    if let Some(fx) = fx {
        // 只有一个币种且就是报告币种：无需折算，保持原样。
        let needs_conversion = totals.keys().any(|currency| currency != &fx.target);
        if needs_conversion {
            let converted: Option<Vec<agent_vitals_domain::fx::Conversion>> = totals.iter()
                .map(|(currency, (amount, _))| fx.policy.convert(*amount, currency, &fx.target))
                .collect();
            if let Some(items) = converted {
                let sum: f64 = items.iter().map(|c| c.target_amount).sum();
                // 汇率出处必须写出来：用了手动汇率就标「手动汇率」，否则写参考汇率的日期。
                let manual = items.iter().any(|c| c.rate_source == agent_vitals_domain::fx::RateSource::UserAssumption);
                let date = items.iter().find(|c| c.rate_source == agent_vitals_domain::fx::RateSource::BundledSnapshot).and_then(|c| c.rate_date.clone());
                let source = match (manual, date) {
                    (true, Some(d)) => format!("{} + {d}", native_label(language, "manual rate", "手动汇率")),
                    (true, None) => native_label(language, "manual rate", "手动汇率").to_string(),
                    (false, Some(d)) => format!("{} {d}", native_label(language, "ECB", "欧央行")),
                    (false, None) => String::new(),
                };
                let suffix = if source.is_empty() { String::new() } else { format!(" · {source}") };
                return Some(format!("≈{} {} [{}]{suffix}", fx.target, fmt_currency_amount(&fx.target, sum), per_currency.join(" · ")));
            }
        }
    }
    Some(per_currency.join(" · "))
}

/// 今日合并 token（v1.3）：DSH 当日实测 + Claude Code 当日 ledger（core
/// `claude_day_total_tokens`，Overview 已嵌）。一侧缺场 → 另一侧照常；两侧都缺
/// → 0（调用方反正渲染 —，0 不会被看见）。token 是消耗量的直观信号、与计价无
/// 关——全 unknown 的 claude 日 token 依旧计入（价目卡不认 ≠ 没消耗）。
fn today_merged_tokens(ov: &Overview) -> i64 {
    let dsh = ov.today.as_ref().and_then(|t| t["tokens"].as_i64()).unwrap_or(0);
    dsh + ov.claude_today_tokens.unwrap_or(0)
}

/// L1 执行环境行文案（spec §4/§8）：`<显示名> · <tokens|—> · <N 会话|—>`。两个
/// 测量字段都缺 → 单个 `· —`（unavailable 降级矩阵的形态）；只缺一个 → 该槽
/// 位「—」另一个照常。`today_partial`（覆盖率 partial）→ token 加 `≈` 前缀：
/// 快照的 coverage 是保守下界标注，渲染成精确值就是编造。
#[cfg(test)]
fn harness_row_text(row: &HarnessRow) -> String {
    harness_row_text_localized(row, NativeUiLanguage::Chinese)
}

fn harness_row_text_localized(row: &HarnessRow, language: NativeUiLanguage) -> String {
    let name = harness_display_name(&row.harness_kind);
    let token_part = row.today_tokens.map(|t| {
        let s = fmt_tokens(t);
        if row.today_partial { format!("≈{s}") } else { s }
    });
    let sess_part = row.today_sessions.map(|n| match language {
        NativeUiLanguage::English => format!("{n} {}", if n == 1 { "session" } else { "sessions" }),
        NativeUiLanguage::Chinese => format!("{n} 会话"),
    });
    let middle = match (token_part, sess_part) {
        (Some(t), Some(s)) => format!("{t} · {s}"),
        (Some(t), None) => format!("{t} · —"),
        (None, Some(s)) => format!("— · {s}"),
        (None, None) => "—".to_string(),
    };
    format!("{name} · {middle}")
}

/// 标题截断（spec §4）：超 24 字符 → 前 23 字符 + `…`。按字符数不是字节数——
/// 中文标题一个字符一个字符地数，按字节截会切成半个字。
fn truncate_title(s: &str, max_chars: usize) -> String {
    let n = s.chars().count();
    if n > max_chars {
        format!("{}…", s.chars().take(max_chars - 1).collect::<String>())
    } else {
        s.to_string()
    }
}

/// 北京时刻的 `HH:MM`（spec §8 stale footer 用）：`generated_at` 是 RFC3339 UTC，
/// 渲染成北京的快照时刻——与日界判定（day_key 北京日）同一时区，早上 8 点前的
/// 快照不会显示成昨天的点。
fn beijing_hhmm(secs: i64) -> String {
    let local = agent_vitals_runtime::clock::local_timestamp_text(secs);
    local[11..16].to_string()
}

/// 多执行环境导航快照是否过期（spec §6 决策 5）：`generated_at` 年龄 > 2 × tick
/// （10 分钟）→ 执行环境子菜单底部挂「数据更新于 hh:mm · 可能已过期」。与
/// `stale_from`（预算 5 分钟窗口）分开——两处「过期」的定义本来就不同，共用一个
/// 窗口会把预算卡 5 分钟语义硬套到执行环境快照上。
fn harnesses_stale_from(generated_at: Option<&str>, now_secs: i64) -> bool {
    stale_after(generated_at, now_secs, 2 * TICK_PERIOD.as_secs() as i64)
}

/// L2 最近会话行文案（spec §4）：`<date> · <身份> · <tokens>`。date 折 `MM-DD`
/// （非当年带年 `YYYY-MM-DD`——「8 月 28 日」在当年语境够用，跨年不标年会在
/// 一年后长得一模一样）；身份 = title（截断 24 字符）→ short_model → native_id
/// 的 fallback 链；tokens 缺段省略。date 只做展示层折叠，`RecentSessionRow.date`
/// 里存的完整 `YYYY-MM-DD` 原样保留。「当年」判定用北京年——与导航 day_key 的
/// 日界一致（UTC 12-31 晚的会话在 UTC 年上跨年、北京年上不跨，整个多执行环境导航
/// 都按北京日界走）。
fn recent_row_text(row: &RecentSessionRow, now_secs: i64) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(d) = &row.date {
        let current_year = agent_vitals_runtime::clock::local_timestamp_text(now_secs)[..4].to_string();
        let year_is_current = d.len() >= 10
            && d[..4] == current_year;
        parts.push(if year_is_current {
            d[5..10].to_string()
        } else {
            d.clone()
        });
    }
    let identity = row
        .title
        .as_deref()
        .map(|t| truncate_title(t, 24))
        .or_else(|| row.model.as_deref().map(short_model).map(String::from))
        .or_else(|| {
            row.session_key
                .get("native_id")
                .and_then(Value::as_str)
                .map(String::from)
        });
    if let Some(id) = identity {
        parts.push(id);
    }
    if let Some(t) = row.tokens {
        parts.push(fmt_tokens(t));
    }
    parts.join(" · ")
}

/// 日预算一行：**分子与百分比只在可信时显示**。
///
/// 分母 `effective_daily_budget` 来自 alert.json，但它是一个**设置**
/// （config 的 daily_cny 过一遍 adaptive floor），不是测量值——过期的设置仍然
/// 是当前设置，照常显示。分子/百分比是**测量值**，两条都必须成立才显示：
/// ①今天真的有数据（`ov.today` 非 None——`today_cost` 已按北京日期校验过
/// today.json 的 date）；②alert.json 不过期。少任何一条就只显示分母 + 一句
/// 说明。
///
/// **为什么不自己算 `today_cost / daily_budget`**：那正是迁移要修的 D2 缺口
/// ——托盘自算的百分比与 `budget.py` 的规则（adaptive floor、peak_share_max、
/// snooze）无关，`budget show` 里全对、菜单栏上全错。百分比一律读 alert.json
/// 的 `ratio`，不重算。
///
/// **为什么要 ①**：alert.json 的 `today_cost` 是它落盘那一刻的"今日"。日历翻页
/// 之后没再跑过 oneline 时，它说的是**昨天**的今日——真机 2026-09-01 就是这样：
/// today.json 停在 08-31（`ov.today` 正确地为 None），alert.json 停在 08-30 报
/// today_cost ¥0.12。少了这个门，菜单会同时出现"今日成本：—（无数据）"和
/// "今日按量预算：¥0.12 / ¥30（0%）"两行自相矛盾的话。
#[cfg(test)]
fn daily_budget_text(ov: &Overview, now_secs: i64) -> Option<String> {
    daily_budget_text_localized(ov, now_secs, NativeUiLanguage::Chinese)
}

fn daily_budget_text_localized(ov: &Overview, now_secs: i64, language: NativeUiLanguage) -> Option<String> {
    // 设置页存了 estimate profile 时，这条 legacy（DSH-only，¥1 默认分母）日预算行
    // 只会和上面「本月预算」行打架（真机：「今日按量预算 — / ¥1（今日无数据）」挂在
    // 「预算：估算 CNY 超支 1450.96/500.00」上面）。profile 有日限额就按 profile 报
    // （已用 = 今日按量 + 订阅日摊），没有日限额就整行不显示。
    if let Some(profile) = ov.budget_profiles.as_ref()
        .and_then(|v| v.get("profiles")).and_then(Value::as_array)
        .and_then(|rows| rows.iter().find(|r| r.get("profile_id").and_then(Value::as_str) == Some("estimate")))
    {
        let daily_limit = profile.get("daily_minor").and_then(Value::as_i64)?;
        if daily_limit <= 0 { return None; }
        let spent = profile.get("daily_total_minor").or_else(|| profile.get("daily_spent_minor"))
            .and_then(Value::as_i64).unwrap_or(0);
        let denom = fmt_money(daily_limit as f64 / 100.0);
        return Some(match profile.get("daily_ratio_bp").and_then(Value::as_i64) {
            Some(bp) => match language {
                NativeUiLanguage::English => format!("Today’s budget: ≈{} / {denom} ({}%)", fmt_money(spent as f64 / 100.0), bp / 100),
                NativeUiLanguage::Chinese => format!("今日预算：≈{} / {denom}（{}%）", fmt_money(spent as f64 / 100.0), bp / 100),
            },
            // 比例缺失有两种原因，不能都写成「无数据」：
            //  ① 部分覆盖（`daily_level == "incomplete"`）：有已知金额（今日按量 + 订阅日摊），
            //     只是还有别的币种订阅没法折成预算币种（不做汇率折算）→ 比例被整体压掉。
            //     工作台总览能分币种列出，托盘预算行是单币口径，应显示已知部分当下限，
            //     与月预算行「部分覆盖 5.22/500」同一处理，不能说成没数据。
            //  ② 确实没有可计价金额。
            None if spent > 0 && profile.get("daily_level").and_then(Value::as_str) == Some("incomplete") => match language {
                NativeUiLanguage::English => format!("Today’s budget: ≥{} / {denom} (partial: other-currency amounts not included)", fmt_money(spent as f64 / 100.0)),
                NativeUiLanguage::Chinese => format!("今日预算：≥{} / {denom}（部分覆盖：不含其他币种金额）", fmt_money(spent as f64 / 100.0)),
            },
            None => match language {
                NativeUiLanguage::English => format!("Today’s budget: — / {denom} (no priced spend today)"),
                NativeUiLanguage::Chinese => format!("今日预算：— / {denom}（今日暂无可计价金额）"),
            },
        });
    }
    let b = &ov.budget;
    let daily = b.effective_daily_budget?;
    let denom = fmt_money(daily);
    let fresh = !stale_from(b.generated_at.as_deref(), now_secs);
    if ov.today.is_none() {
        return Some(match language {
            NativeUiLanguage::English => format!("Today’s metered budget: — / {denom} (no priced spend today)"),
            NativeUiLanguage::Chinese => format!("今日按量预算：— / {denom}（今日暂无可计价金额）"),
        });
    }
    if !fresh {
        return Some(match language {
            NativeUiLanguage::English => format!("Today’s metered budget: — / {denom} (stale; not reevaluated)"),
            NativeUiLanguage::Chinese => format!("今日按量预算：— / {denom}（数据过期，未重新评估）"),
        });
    }
    match (b.today_cost, b.ratio) {
        (Some(c), Some(r)) => {
            Some(match language {
                NativeUiLanguage::English => format!("Today’s metered budget: {} / {denom} ({:.0}%)", fmt_money(c), r * 100.0),
                NativeUiLanguage::Chinese => format!("今日按量预算：{} / {denom}（{:.0}%）", fmt_money(c), r * 100.0),
            })
        }
        // alert.json 在场且新鲜，但这两个字段是 null——`evaluate()` 对"今日无
        // 数据"就是这么落盘的。不拿 null 当 0。
        _ => Some(match language {
            NativeUiLanguage::English => format!("Today’s metered budget: — / {denom} (no priced spend today)"),
            NativeUiLanguage::Chinese => format!("今日按量预算：— / {denom}（今日暂无可计价金额）"),
        }),
    }
}

/// 本月固定订阅记录逐币种展示；本地声明/记录不是付款凭证。权威库在场且为空时
/// 不退回旧 CNY 字段；旧载荷只有 CNY 时保留兼容行，但同样不声称已付款。
#[cfg(test)]
fn subscription_line_text(ov: &Overview) -> Option<String> {
    subscription_line_text_localized(ov, NativeUiLanguage::Chinese)
}

fn subscription_line_text_localized(ov: &Overview, language: NativeUiLanguage) -> Option<String> {
    if let Some(totals) = &ov.subscription_month_by_currency {
        let amounts = totals.iter().filter(|(_, minor)| **minor > 0).map(|(currency, minor)| {
            if currency == "USD" || currency == "CNY" {
                let symbol = if currency == "USD" { "$" } else { "¥" };
                let whole = minor / 100;
                let cents = minor % 100;
                if cents == 0 {
                    format!("{currency} {symbol}{whole}")
                } else {
                    format!("{currency} {symbol}{whole}.{cents:02}")
                }
            } else {
                format!("{currency} {minor} {}", native_label(language, "minor units (precision unavailable)", "最小单位（精度未知）"))
            }
        }).collect::<Vec<_>>().join(" · ");
        if amounts.is_empty() { return None; }
        return Some(format!("{}{amounts}{}",
            native_label(language, "Recorded subscription: ", "已记录订阅："),
            native_label(language, " (not payment-verified; excluded from metered budget)", "（非付款凭证，不计入按量预算）")));
    }
    let cny = ov.subscription_cny_month?;
    Some(match language {
        NativeUiLanguage::English => format!("Recorded subscription: CNY {} (not payment-verified; excluded from metered budget)", fmt_money(cny)),
        NativeUiLanguage::Chinese => format!("已记录订阅：CNY {}（非付款凭证，不计入按量预算）", fmt_money(cny)),
    })
}

/// 同步状态一行：**成功也显示**，不是只在失败时才出现。
///
/// "上次成功同步是几点"是判断菜单里这些数字新不新的最直接信号——比预算行末尾
/// 那个「（数据过期）」后缀更直白，也覆盖了预算行不涉及的部分（今日/本月/最近
/// 会话都来自同一轮 tick）。原来只在 `!ok` 时显示，成功时菜单里没有任何时间戳，
/// 用户没法区分"数字是刚更新的"和"app 静默卡住半天了"。
#[cfg(test)]
fn sync_line_text(sync: &SyncStatus) -> String {
    sync_line_text_localized(sync, NativeUiLanguage::Chinese)
}

fn sync_line_text_localized(sync: &SyncStatus, language: NativeUiLanguage) -> String {
    if !sync.ok {
        return if sync.stage == "never" {
            native_label(language, "Not synced yet", "尚未同步").to_string()
        } else {
            match language {
                NativeUiLanguage::English => "⚠ Last sync failed; see Settings for details".to_string(),
                NativeUiLanguage::Chinese => format!("⚠ 上次同步失败：{}", sync.message),
            }
        };
    }
    // `at` 是北京时间 `YYYY-MM-DD HH:MM:SS`，菜单只要 HH:MM。成功形态加
    // 成功形态带覆盖执行环境后缀（spec §4）：同步回路只折 DSH 会话 + 尾折 Claude 账
    // （2026-09-02 起，tick 顺序见 sync_tick），Codex 没有同步循环——时间戳的覆盖范围
    // 必须说清楚，不能让人以为它是全执行环境的新鲜度。后缀写执行环境名而不是内部术语
    // （曾写「DSH 折叠 + Claude 账」，用户看不懂）。
    match (language, sync.at.as_deref().and_then(|s| s.get(11..16))) {
        (NativeUiLanguage::English, Some(hhmm)) => format!("Last sync: {hhmm} succeeded · DeepSeek Harness, Claude Code"),
        (NativeUiLanguage::English, None) => "Last sync: succeeded · DeepSeek Harness, Claude Code".to_string(),
        (NativeUiLanguage::Chinese, Some(hhmm)) => format!("上次同步：{hhmm} 成功（DeepSeek Harness、Claude Code）"),
        (NativeUiLanguage::Chinese, None) => "上次同步：成功（DeepSeek Harness、Claude Code）".to_string(),
    }
}

/// 托盘菜单的执行环境区行树（spec §4/§5.3/§8）。纯数据——`build_menu_at` 只做
/// `MenuRow` → Tauri `MenuItem/Submenu` 的机械翻译，菜单结构可以单测钉住，
/// 不用起 AppHandle。只有 Item 与 Submenu：执行环境区内的分隔线由 build_menu_at
/// 在区块之间直接加，不属于行树（harness_menu_rows 从不产 Separator）。
#[derive(Debug, PartialEq)]
enum MenuRow {
    Item { id: String, text: String, enabled: bool },
    Submenu { id: String, text: String, rows: Vec<MenuRow> },
}

/// 执行环境区菜单行（spec §4/§8 降级矩阵逐格）：
/// · `status == "unavailable"` → L2 单行禁用「会话数据暂不可用」（空子菜单无
///   任何用户可操作物，禁用文案严格更有信息量——spec §8 原文对 cancelled 说不
///   渲染 L2，这里渲染禁用文案是**计划里注明的偏离**，更诚实）；
/// · ready 且 recent 空 → 禁用「尚无会话」（真零，不是失败——两种状态必须
///   可区分）；
/// · 其余 → 最近会话行（id `session:{kind}:{i}`，排序/截取在数据层已完成，
///   这里只按序渲染）。
/// stale（spec §6 决策 5）→ 每个执行环境子菜单底部禁用项「数据更新于 hh:mm ·
/// 可能已过期」（hh:mm 是北京时刻，`generated_at` UTC 转北京渲染）。
#[cfg(test)]
fn harness_menu_rows(
    harnesses: &[HarnessRow],
    generated_at: Option<&str>,
    now_secs: i64,
) -> Vec<MenuRow> {
    harness_menu_rows_localized(harnesses, generated_at, now_secs, NativeUiLanguage::Chinese)
}

fn harness_menu_rows_localized(
    harnesses: &[HarnessRow],
    generated_at: Option<&str>,
    now_secs: i64,
    language: NativeUiLanguage,
) -> Vec<MenuRow> {
    let mut out = Vec::new();
    for row in harnesses {
        let mut l2 = if row.status == "unavailable" {
            vec![MenuRow::Item {
                id: format!("session:unavailable:{}", row.harness_kind),
                text: native_label(language, "Session data unavailable", "会话数据暂不可用").into(),
                enabled: false,
            }]
        } else if row.recent.is_empty() {
            vec![MenuRow::Item {
                id: format!("session:none:{}", row.harness_kind),
                text: native_label(language, "No sessions yet", "尚无会话").into(),
                enabled: false,
            }]
        } else {
            row.recent
                .iter()
                .enumerate()
                .map(|(i, r)| MenuRow::Item {
                    id: format!("session:{}:{}", row.harness_kind, i),
                    text: recent_row_text(r, now_secs),
                    enabled: true,
                })
                .collect()
        };
        if harnesses_stale_from(generated_at, now_secs) {
            l2.push(MenuRow::Item {
                id: format!("session:stale:{}", row.harness_kind),
                text: format!(
                    "{}{}{}",
                    native_label(language, "Updated at ", "数据更新于 "),
                    generated_at
                        .and_then(parse_rfc3339_secs)
                        .map(beijing_hhmm)
                        .unwrap_or_else(|| "??:??".into()),
                    native_label(language, " · may be stale", " · 可能已过期")
                ),
                enabled: false,
            });
        }
        out.push(MenuRow::Submenu {
            id: format!("harness:{}", row.harness_kind),
            text: harness_row_text_localized(row, language),
            rows: l2,
        });
    }
    out
}

/// MenuRow 树 → Tauri 菜单项数组（机械翻译，`dyn IsMenuItem` trait 对象）。
/// Submenu 用 `Submenu::with_id_and_items`（items 是 `&[&dyn IsMenuItem]`
/// 切片）：子菜单带 id（`harness:{kind}`），菜单事件才拿得到动态 id 做深链分发。
/// 递归翻译 L2 项。
fn menu_row_items<M: tauri::Manager<tauri::Wry>>(
    app: &M,
    rows: &[MenuRow],
) -> tauri::Result<Vec<Box<dyn tauri::menu::IsMenuItem<tauri::Wry>>>> {
    let mut out: Vec<Box<dyn tauri::menu::IsMenuItem<tauri::Wry>>> = Vec::new();
    for row in rows {
        match row {
            MenuRow::Item { id, text, enabled } => {
                out.push(Box::new(MenuItem::with_id(
                    app, id, text, *enabled, None::<&str>,
                )?));
            }
            MenuRow::Submenu { id, text, rows } => {
                let children = menu_row_items(app, rows)?;
                let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> =
                    children.iter().map(|b| b.as_ref()).collect();
                out.push(Box::new(Submenu::with_id_and_items(
                    app, id, text, true, &refs,
                )?));
            }
        }
    }
    Ok(out)
}

/// MenuRow 树 → 追加进 MenuBuilder（`menu_row_items` 的一层薄壳：builder 一次
/// item 一个，翻译逻辑都在上面，这里只管把 trait 对象逐个放进去）。
fn append_menu_rows<'a, M: tauri::Manager<tauri::Wry>>(
    builder: tauri::menu::MenuBuilder<'a, tauri::Wry, M>,
    app: &'a M,
    rows: &[MenuRow],
) -> tauri::Result<tauri::menu::MenuBuilder<'a, tauri::Wry, M>> {
    let items = menu_row_items(app, rows)?;
    let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> =
        items.iter().map(|b| b.as_ref()).collect();
    let mut b = builder;
    for r in refs {
        b = b.item(r);
    }
    Ok(b)
}

fn build_menu(app: &AppHandle, ov: &Overview) -> tauri::Result<Menu<tauri::Wry>> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    build_menu_at(app, ov, now)
}

/// 账卡两行（今日/本月按量成本）的文案。纯函数拆出来给 build_menu 拼行、给单测钉
/// 每一格——用户最先看到的菜单文案不能只靠人工核对。
///
/// SQL `metered_view` 优先，同币种三级取代规则由 domain 决定；旧载荷才读取 DSH
/// 与 Claude 账。菜单首行是今日 token，金额行保留币种与估算标记，绝不跨币相加。
#[cfg(test)]
fn today_tokens_row_text(ov: &Overview) -> String {
    today_tokens_row_text_localized(ov, NativeUiLanguage::Chinese)
}

fn today_tokens_row_text_localized(ov: &Overview, language: NativeUiLanguage) -> String {
    let tokens = today_tokens(ov);
    let label = native_label(language, "Today’s usage: ", "今日消耗：");
    if tokens > 0 { format!("{label}{} tokens", fmt_tokens(tokens)) } else { format!("{label}—") }
}

#[cfg(test)]
fn money_rows_text(ov: &Overview) -> (String, String) {
    money_rows_text_localized(ov, NativeUiLanguage::Chinese)
}

#[cfg(test)]
fn money_rows_text_localized(ov: &Overview, language: NativeUiLanguage) -> (String, String) {
    money_rows_text_fx(ov, language, None)
}

fn money_rows_text_fx(ov: &Overview, language: NativeUiLanguage, fx: Option<&TrayFx>) -> (String, String) {
    // 2026-09-17 起先读 SQL 的 `metered_view`（账单 > 归因估算 > 默认估算，与工作台
    // 总览卡同一个数）；库缺席才退回旧的 DSH state + claude ledger 拼法。
    let today_money = if ov.metered_today.is_some() {
        metered_view_text(ov.metered_today.as_ref())
    } else {
        metered_amount(
            ov.today.as_ref().and_then(|t| t["total"].as_f64()),
            claude_currency(&ov.claude_today, "CNY"),
            claude_currency(&ov.claude_today, "USD"),
        )
    };
    // token 不再挂在这一行（首行「今日消耗」已经是它），这里只剩钱。
    let today_text = match today_money {
        Some(m) => format!("{}{m}", native_label(language, "Today’s metered cost: ", "今日按量成本：")),
        // 今天没有可报的按量钱（全在套餐内 / 没用量）→ 诚实的 —（缺列报缺）。
        None => native_label(language, "Today’s metered cost: — (no data)", "今日按量成本：—（无数据）").to_string(),
    };
    // 本月行：同款合并，但 **只显示金额、去掉 `/ ¥600` 分母**（v1.3）。分母是 DSH
    // 预算——合并后 ¥ 主账已跨执行环境，拿 DSH 预算给整个合并总账当分母是把「本月花
    // 了多少」和「DSH 预算还剩多少」绑成一行；DSH 预算状态常驻在底部预算行
    // （budget_item）照常显示，这里不需要第二遍。
    //
    // DSH 侧本月是否「有折到账」：当月过滤后**有日**才算（镜像今日 None 语义——
    // 当月空 / 全是上月残留 = 本月没折到账，不是花了 0）。有日但金额 ¥0（只折到
    // 免费 token 的日子）→ Some(0)，「测到 0」不是「没测」。
    let month_total = ov.month["total"].as_f64().unwrap_or(0.0);
    // `ov.days` = read_overview_at 当月过滤后的逐日行（同款 cur_month 过滤）——
    // 非空 ⇔ DSH 本月确实折到过账。month_cost 聚合本身不带日数，不能从
    // `ov.month` 里看。
    let month_has_days = !ov.days.is_empty();
    // 本月成本 = 按量（账单 > 归因估算 > 默认估算）+ 订阅月费，**同币种内相加、币种之间不加**；
    // 任一成分是估算就整个币种段标 `≈`（订阅是声明值，本身不带估算）。曾叫「本月按量成本」，
    // 订阅月费不在里面，用户看到 — 而下面预算行有数，读起来互相矛盾。
    // 库缺席（旧载荷兜底）时拿不到订阅明细，只能给按量，所以保持旧标签「按量成本」不撒谎。
    let has_subscription = ov.subscription_month_by_currency.as_ref().is_some_and(|m| m.values().any(|minor| *minor > 0));
    let merged_path = ov.metered_month.is_some() || has_subscription;
    let month_money = if merged_path {
        month_cost_text(ov, fx, language)
    } else {
        metered_amount(
            if month_has_days { Some(month_total) } else { None },
            claude_currency(&ov.claude_month, "CNY"),
            claude_currency(&ov.claude_month, "USD"),
        )
    };
    // 两侧都没有当月可报金额时不能凭空给出 CNY 0；缺列报缺。
    let month_text = match (month_money, merged_path) {
        (Some(m), true) => format!("{}{m}", native_label(language, "Monthly cost: ", "本月成本：")),
        (Some(m), false) => format!("{}{m}", native_label(language, "Monthly metered cost: ", "本月按量成本：")),
        (None, true) => native_label(language, "Monthly cost: — (no data)", "本月成本：—（无数据）").to_string(),
        (None, false) => native_label(language, "Monthly metered cost: — (no data)", "本月按量成本：—（无数据）").to_string(),
    };
    (today_text, month_text)
}

/// 参数化版——now 由调用方注入，单测钉住每一行文案不用碰系统时钟。
fn build_menu_at(app: &AppHandle, ov: &Overview, now_secs: i64) -> tauri::Result<Menu<tauri::Wry>> {
    let language = native_ui_language();
    let tray_fx = TrayFx::load();
    let (today_text, month_text) = money_rows_text_fx(ov, language, Some(&tray_fx));
    let budget_text = budget_status_text_at_localized(ov, now_secs, language);
    // 信息行一律 enabled=true：macOS 对 disabled 菜单项强制灰色渲染，作为常驻
    // 信息几乎不可读；enabled 后文字是系统默认黑。代价是悬停高亮 + 点击会触发
    // MenuEvent——handler 的 `_ => {}` 兜底这些 id，点击什么也不做，只有菜单
    // 关闭。黑字可读 > 不可点态的视觉暗示，值得。
    // 「今日按量成本」行已去掉（用户定向 2026-09-17）：首行只放今日消耗 token，钱看
    // 本月行与预算行。`today_text` 仍由 money_rows_text 算出并有单测钉住，只是不上菜单。
    let _ = today_text;
    let tokens_item = MenuItem::with_id(app, "today_tokens", today_tokens_row_text_localized(ov, language), true, None::<&str>)?;
    let month_item = MenuItem::with_id(app, "month", month_text, true, None::<&str>)?;
    let budget_item = MenuItem::with_id(app, "budget", budget_text, true, None::<&str>)?;
    let mut builder = MenuBuilder::new(app).item(&tokens_item);
    // 日预算：紧跟今日成本，回答"今天这些钱占日额度多少"。缺 alert.json 时整条
    // 不显示——预算行本身已经说了「等预算数据」，不用再空一行。
    if let Some(t) = daily_budget_text_localized(ov, now_secs, language) {
        builder = builder.item(&MenuItem::with_id(app, "daily", t, true, None::<&str>)?);
    }
    builder = builder.item(&month_item);
    // 执行环境区（spec §4）：每执行环境一个子菜单——L1 = 显示名 · 今日 token · 会话数，
    // L2 = 最近会话跳转行（结构由 harness_menu_rows 纯函数钉住，§9.2）。平铺的
    // 「最近会话」行随面板一起删除（2026-09-01 spec 修订）——最近会话入口收敛
    // 到执行环境子菜单里，顶层菜单只剩钱行与操作项。
    builder = builder.separator();
    builder = append_menu_rows(
        builder,
        app,
        &harness_menu_rows_localized(&ov.harnesses, ov.harnesses_generated_at.as_deref(), now_secs, language),
    )?;
    builder = builder.separator().item(&budget_item);
    // 本月订阅记录紧跟预算行，逐币种显示，明确不是付款凭证。无订阅不显示。
    if let Some(t) = subscription_line_text_localized(ov, language) {
        builder = builder.item(&MenuItem::with_id(app, "subscription", t, true, None::<&str>)?);
    }
    // 同步状态常驻（成功也显示）——托盘是主入口，"数字是什么时候的"必须在这里
    // 一眼可见，不该等到打开工作台才发现同步早就断了。
    builder = builder.item(&MenuItem::with_id(
        app,
        "sync",
        sync_line_text_localized(&ov.sync, language),
        true,
        None::<&str>,
    )?);
    // 工作台主窗口入口（任务 #5）：独立可缩放窗口，五页 总览/日历/会话/Findings/
    // 数据源。**没有"打开面板…"菜单项**，面板本身也已经整体删除（2026-09-01）
    // ——面板展示的今日/本月/预算/本月逐日本来就是工作台"总览"tab 的严格子集，
    // 一个字段不多；用户先反馈两者"功能重合"（菜单项先删），又反馈左右键该跟
    // 大多数状态栏图标一样统一弹菜单（右键的专属"弹面板"手势也删），面板到此
    // 已经没有任何入口——留着 `toggle_window`/独立 HTML+JS+CSS 就是纯粹的死
    // 代码，一并删除，不留一份没人能打开的界面。
    let workbench_item = MenuItem::with_id(app, "workbench", native_label(language, "Open workspace…", "打开工作台…"), true, None::<&str>)?;
    let skill_health_item = MenuItem::with_id(app, "skill_health", native_label(language, "Skill audit", "Skill 体检"), true, None::<&str>)?;
    let refresh_item = MenuItem::with_id(app, "refresh", native_label(language, "Sync now", "立即同步"), true, None::<&str>)?;
    let menu = builder
        .separator()
        .item(&workbench_item)
        .item(&skill_health_item)
        .item(&refresh_item)
        .separator()
        .item(&PredefinedMenuItem::quit(app, Some(native_label(language, "Quit", "退出")))?)
        .build()?;
    // HarnessesCache：深链分发的映射依据（spec §9.2 #12）——缓存必须等于刚构建的
    // 菜单用的执行环境行，否则 `session:{kind}:{i}` 会查到错行。写在这里而不是
    // refresh 里：startup warm-start（read_overview 带 harnesses.json 旧快照）与
    // 每轮 tick 的 build_menu 都经过同一写入点，缓存不会停在旧菜单。
    app.state::<HarnessesCache>().0.lock().unwrap_or_else(|e| e.into_inner()).clone_from(&ov.harnesses);
    Ok(menu)
}

/// 重建托盘 —— 标题（今日成本）与菜单里的数字不是静态文案，每次刷新都要用最新
/// 的 overview 重建。**`ov` 由调用方算好传进来，这里不再自己查**：2026-09-23
/// 真机验收先把 `refresh` 钉成 `sync_tick_inner` 的头号耗时大头（单次 33.5s，
/// 占 tick 总时间 82%），往下拆一层才发现真正的大头根本不在 `refresh` 内部
/// ——是 `refresh`/`budget_alerts::maybe_notify`/`quota_alerts::maybe_notify`
/// 三处各自独立调用同一份重 SQL 聚合（`overview::read_overview()`，calendar_
/// month/day_freshness/claude_provider_amounts/billing_declarations，原始
/// 事故热栈那几个函数），一个 tick 里白算两三遍。查询本身收口到
/// `sync_tick_inner` 里只调一次，`refresh` 现在只剩「托盘更新」
/// （`set_title`+`build_menu`+`set_menu`，原生 Cocoa 调用）。
/// 单次 refresh 的软预算（LIGHT-PATH spec §5.4）：只观测不改行为——超预算
/// 记 WARN 并点名最慢子步，为上轮 33.5s 爆炸的根因归因提供观测面。
const REFRESH_BUDGET: std::time::Duration = std::time::Duration::from_secs(5);

fn refresh(app: &AppHandle, ov: &overview::Overview) {
    let t0 = std::time::Instant::now();
    let mut slowest = ("none", std::time::Duration::ZERO);
    if let Some(tray) = app.tray_by_id("main") {
        let s = std::time::Instant::now();
        let _ = tray.set_title(Some(today_title(ov)));
        let d = s.elapsed();
        if d > slowest.1 {
            slowest = ("set_title", d);
        }
        let s = std::time::Instant::now();
        if let Ok(menu) = build_menu(app, ov) {
            let _ = tray.set_menu(Some(menu));
        }
        let d = s.elapsed();
        if d > slowest.1 {
            slowest = ("build_menu+set_menu", d);
        }
    }
    let total = t0.elapsed();
    if total >= REFRESH_BUDGET {
        agent_vitals_runtime::logging::log_warn(
            "sync",
            &format!(
                "refresh 超预算（{:?} ≥ {:?}），最慢子步: {} {:?}",
                total,
                REFRESH_BUDGET,
                slowest.0,
                slowest.1
            ),
        );
    }
}

/// `sessions navigation` 一轮查询的硬超时（spec §6 决策 5）：20 秒后 kill。
/// 冷 store 首建 30s+ 时首轮会超时——执行环境区退化为上一轮快照（或 unavailable），
/// 下一轮 tick（5 分钟后）重试，不阻塞托盘。工作台 IPC 的 `sessions list`
/// 故意**没有**超时（冷构建 30s+ 是合法的，前端有 loading banner）——这里是
/// tick 内的阻塞点，必须有界，否则一轮同步能把 SyncLock 占死 30 秒。
const NAVIGATION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// spawn `sessions navigation` 并等 stdout，带 20s 硬超时：`try_wait` 50ms 轮询，
/// 超时 → `child.kill()` + `wait()`（回收，不留僵尸）→ None。非零退出/spawn
/// 失败/超时一律 None——调用方决定是保留旧快照还是 degraded，这里不编造。
///
/// stderr 与 discover 同款 G4 盲区：之前是 `piped()` 了却从未读过，子进程真正
/// 报的错（比如时区非法、执行环境目录不可读）在这三条 `None` 路径里全部消失。
fn run_navigation(bin: &Path, day: &str) -> Option<Value> {
    let timezone = agent_vitals_runtime::statistics_timezone::timezone_name(&overview::data_home())
        .ok()
        .unwrap_or_else(agent_vitals_runtime::clock::system_timezone_name);
    let mut child = match std::process::Command::new(bin)
        .args([
            "sessions".to_string(),
            "navigation".to_string(),
            "--day".to_string(),
            day.to_string(),
            "--timezone".to_string(),
            timezone,
            "--recent".to_string(),
            "5".to_string(),
            "--json".to_string(),
        ])
        .env("AGENT_VITALS_HOME", overview::data_home())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(e) => {
            agent_vitals_runtime::logging::log_warn("sync", &format!("sessions navigation spawn 失败: {e}"));
            return None;
        }
    };
    let start = std::time::Instant::now();
    loop {
        let wait = match child.try_wait() {
            Ok(wait) => wait,
            Err(e) => {
                agent_vitals_runtime::logging::log_warn("sync", &format!("sessions navigation try_wait 失败: {e}"));
                return None;
            }
        };
        match wait {
            Some(status) if status.success() => {
                use std::io::Read;
                let mut out = String::new();
                if let Some(stdout) = child.stdout.as_mut() {
                    let _ = stdout.read_to_string(&mut out);
                }
                return match serde_json::from_str(&out) {
                    Ok(value) => {
                        agent_vitals_runtime::logging::log_info(
                            "sync",
                            &format!("sessions navigation 完成，用时 {:?}", start.elapsed()),
                        );
                        Some(value)
                    }
                    Err(e) => {
                        agent_vitals_runtime::logging::log_warn(
                            "sync",
                            &format!("sessions navigation 输出不是合法 JSON: {e}"),
                        );
                        None
                    }
                };
            }
            Some(status) => {
                use std::io::Read;
                let mut err_out = String::new();
                if let Some(stderr) = child.stderr.as_mut() {
                    let _ = stderr.read_to_string(&mut err_out);
                }
                agent_vitals_runtime::logging::log_warn(
                    "sync",
                    &format!("sessions navigation 失败（{status}）：{}", err_out.trim()),
                );
                return None;
            }
            None => {
                if start.elapsed() > NAVIGATION_TIMEOUT {
                    agent_vitals_runtime::logging::log_warn(
                        "sync",
                        &format!("sessions navigation 超时（{NAVIGATION_TIMEOUT:?}），已 kill"),
                    );
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
    }
}

/// 一轮 tick 的执行环境区刷新（spec §6 决策 5）：spawn `sessions navigation` →
/// 快照落盘 harnesses.json。**刷新失败不覆盖 harnesses.json**——保留末次成功快照，它靠
/// generated_at 变旧自然转 stale，托盘显示「数据更新于 hh:mm · 可能已过期」
/// 而不是整块消失或摆 0。二进制缺失同样静默（顶层钱行有自己的降级文案，执行环境
/// 区上一轮快照继续服务）。单飞由 SyncLock 保证——只在 sync_tick 里被调用，
/// tick 与「立即同步」都持锁。
fn refresh_harnesses(app: &AppHandle) {
    let Some(bin) = resolve_binary() else { return };
    let Some(snap) = run_navigation(&bin, &overview::today_beijing()) else {
        return;
    };
    let harnesses = overview::harness_rows_from_navigation(&snap);
    overview::save_harnesses_at(
        &overview::data_home(),
        &HarnessesSnapshot {
            generated_at: snap
                .get("generated_at")
                .and_then(Value::as_str)
                .map(String::from),
            harnesses,
        },
    );
    // harnesses.json 与 authority revision 独立；只靠事实失效事件会让 React 保留旧执行环境卡。
    let _ = app.emit(APP_EVENT, serde_json::json!({ "type": "HarnessNavigationChanged" }));
}

/// `agent-vitals` 二进制解析：`AGENT_VITALS_BIN` env 覆盖 → 与自身同目录 / 兄弟
/// `Resources/bin`（把 CLI 打进 .app 部署时用）→ PATH。tick 靠它做发现与折账
/// （discovery/oneline 是二进制 crate 的模块，src-tauri 是独立 workspace import
/// 不到——spawn 是「不长第二份拷贝」的唯一路径）。
///
/// **PATH 只放最后**：登录项/launchd 启动的 app PATH 是极简的（没有 ~/.local/bin），
/// 真机 last-sync 报「未找到二进制」正是这个——部署必须不依赖登录 shell 的 PATH。
static BUNDLED_RESOURCE_DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

fn resolve_binary() -> Option<PathBuf> {
    resolve_binary_from(
        &|k| std::env::var(k).ok(),
        std::env::var("PATH").unwrap_or_default(),
        std::env::current_exe().ok(),
        BUNDLED_RESOURCE_DIR.get().cloned(),
        if cfg!(windows) { "agent-vitals.exe" } else { "agent-vitals" },
        &|p: &Path| p.is_file(),
    )
}

/// 读取实际会被桌面同步回路使用的 CLI 版本。诊断只读探测：二进制缺失、
/// 启动失败或输出无法识别时返回 `None`，不把 App 版本冒充 CLI 版本。
fn resolved_cli_version() -> Option<String> {
    let binary = resolve_binary()?;
    let output = Command::new(binary).arg("--version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(ToOwned::to_owned)
}

/// 纯函数版二进制解析——env、自身可执行文件、文件判断由调用方注入，单测不碰真实
/// 环境变量。优先序：AGENT_VITALS_BIN > Tauri 资源目录 > 自身目录 > PATH。
fn resolve_binary_from(
    get_env: &dyn Fn(&str) -> Option<String>,
    path: String,
    exe: Option<PathBuf>,
    resource_dir: Option<PathBuf>,
    binary_name: &str,
    is_file: &dyn Fn(&Path) -> bool,
) -> Option<PathBuf> {
    if let Some(b) = get_env("AGENT_VITALS_BIN") {
        let p = PathBuf::from(b);
        if is_file(&p) {
            return Some(p);
        }
    }
    if let Some(dir) = resource_dir {
        let bundled = dir.join("bin").join(binary_name);
        if is_file(&bundled) {
            return Some(bundled);
        }
    }
    // 自身目录：`Contents/MacOS/agent-vitals`（与 menubar 同目录）或
    // `Contents/Resources/bin/agent-vitals`（打包版放 CLI 的规范位置）。用
    // parent 遍历而不是字面 `..`——返回的路径不含 `..`，对 display/spawn 都干净。
    if let Some(macos) = exe.as_deref().and_then(|e| e.parent()) {
        let sibling = macos.join(binary_name);
        if is_file(&sibling) {
            return Some(sibling);
        }
        if let Some(contents) = macos.parent() {
            let bundled = contents.join("Resources").join("bin").join(binary_name);
            if is_file(&bundled) {
                return Some(bundled);
            }
        }
    }
    for dir in std::env::split_paths(&path) {
        let cand = dir.join(binary_name);
        if is_file(&cand) {
            return Some(cand);
        }
    }
    None
}


/// fold 完成事件名。与工作台 `src-tauri/ui/workbench.js` 顶部的
/// `listen("app-event", …)` 一一对应——改类型串/负载字段必须两处同步改
/// （workbench.js 的事件桥注释里反向引用了这个名字与负载）。
/// 展示层失效信号的发布器（RUNTIME_INVALIDATION spec §4.4）：权威 revision 严格
/// 前进才向 webview 发 `Invalidated`。它取代了 `FoldCompleted` + 200ms 去抖——
/// 那套是时间去抖（不确定、不可测），这套是电平比较（同 revision 再来一千次也
/// 只发一次）。tick 线程与「立即同步」共享，故经 `app.manage` 注册。
struct InvalidationPublisher(
    agent_vitals_runtime::events::ChangePublisher<agent_vitals_runtime::events::Invalidation>,
);

/// `SyncStatusChanged` 的「变了才发」发布器（spec §4.5）：ok/stage/message/逐动态来源回执
/// 与上次相同就不发。此前每 tick 必发，是 REVIEW G2 的实例之一。页面挂载时都会
/// 主动 `read_sync_status`，所以「首次扫描要让工作台结束正在整理」由主动拉满足，
/// 不再依赖每 tick 必发；进程启动后首次仍必发（`last = None`）。
struct SyncStatusPublisher(
    agent_vitals_runtime::events::ChangePublisher<(bool, String, String, Vec<overview::DynamicHarnessSyncReceipt>)>,
);

/// 菜单栏「信息行」点击产生的导航目标（React canonical page ID）。持久存目标是因为窗口未建/未
/// 可见时 `emit` 是空操作（`publish_invalidation` 注释）——目标要留到工作台下次
/// init/focus 时 pull 出来消费；`focus-tab` 事件只是通知，pull 是最终仲裁。工作台 apply
/// 成功后调 `clear_nav_target` 清除，防陈旧目标在下次 focus 重复应用。
struct NavTarget(Mutex<Option<String>>);

/// 会话深链目标（spec §7.1）：强类型（serde tag `type` + camelCase 变体名），
/// 不再是裸 `Value`。`sessionDetail`（L2 行 → 会话详情）与 `sessionList`（打开
/// 会话列表按 harness 过滤，为「查看全部会话」回归预留——v1 菜单只发射前者，
/// §7.1）由 `type` 字段区分，工作台前端据此分发。v1 前端只消费（peek 回来 +
/// apply 后 clear），不从前端发射。
#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(tag = "type", rename_all = "camelCase")]
enum WorkbenchTarget {
    SessionList { harness_kind: Option<String> },
    SessionDetail { session_ref: String, harness_kind: String },
}

/// 会话深链的待消费目标（spec §7.2）：菜单 L2 点击 → `focus_session` 覆盖式存入、
/// 推 `focus-target` 事件、`show_workbench`；工作台在 init / window focus /
/// `visibilitychange`(visible) 时 pull（`peek_focus_target`，**非破坏性**），
/// **成功应用后**才 `clear_focus_target`（应用失败也 clear——错误横幅已向用户
/// 说明，菜单再点会覆盖新目标，不无限重试）。持久是因为窗口未建/未可见时
/// emit 是空操作，目标要留到工作台下次可见；事件只是通知，pull 是最终仲裁
/// （§7.2 末句）。与 `NavTarget` 并存：那是信息行→tab 名（另一维度），spec §7
/// 只描述深链机制，未要求取代信息行通路。
struct FocusTarget(Mutex<Option<WorkbenchTarget>>);

impl FocusTarget {
    fn set(&self, target: WorkbenchTarget) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(target);
    }

    fn peek(&self) -> Option<WorkbenchTarget> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn clear(&self) {
        *self.0.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

/// 最近一次托盘菜单构建用的执行环境行（spec §9.2 #12 的映射依据）：动态菜单 id
/// `session:{kind}:{i}` 按 id 查行 → 行内 session_key → `SessionDetail`。由
/// `build_menu_at` 每次构建后写入——缓存 == 刚构建的菜单；startup warm-start
/// （read_overview 带 harnesses.json 旧快照）与每轮 tick 都经过同一写入点，缓存
/// 不会停在旧菜单。
struct HarnessesCache(Mutex<Vec<HarnessRow>>);

/// `SyncStatusChanged` 的 app-event 载荷（类型化信封，spec §1.3）。
fn sync_status_payload(status: &SyncStatus) -> serde_json::Value {
    serde_json::json!({
        "type": "SyncStatusChanged",
        "ok": status.ok, "stage": status.stage, "message": status.message,
    })
}

/// 事件总线消费（EVENT_BUS spec §9-P1 + RUNTIME_INVALIDATION spec §4.3）：tick 尾部
/// drain——CLI 子进程已在 outbox 里落了 FactsIngested 等事实事件，这里以
/// `desktop-ui` **合并型**消费者身份取走：逐行记账不变（at-least-once），但副作用
/// 合并成一次 flush——读当前 revision，经 `InvalidationPublisher` 发至多一条
/// `Invalidated{revision, harnesses}`。展示层结构上拿不到载荷（`Coalesced` 没有那个
/// 字段），领域事件不再逐条透传给 webview。
///
/// 消费者只 emit、不碰 drain 的连接（flush 自开只读连接读 revision，spec §6 自持资源）。
fn drain_event_bus(app: &AppHandle) {
    use agent_vitals_runtime::events::{CoalescingConsumer, ConsumerInterest, Dispatcher};
    let path = agent_vitals_data::authority::default_authority_path(&overview::data_home());
    let Ok(db) = agent_vitals_data::authority::AuthorityDb::open(
        &path,
        agent_vitals_runtime::sql_sync::now_ms(),
    ) else {
        return; // 库缺席（首装未同步）不是错误——没有事件可投
    };
    let app2 = app.clone();
    let dispatcher = match Dispatcher::with_coalescing(
        Vec::new(),
        vec![CoalescingConsumer::new("desktop-ui", ConsumerInterest::presentation(), move |c| {
            publish_invalidation(&app2, c.harnesses);
        })],
    ) {
        Ok(d) => d,
        Err(e) => {
            agent_vitals_runtime::logging::log_warn("events", &format!("consumer registration: {e}"));
            return;
        }
    };
    if let Err(e) = dispatcher.drain(db.conn()) {
        agent_vitals_runtime::logging::log_warn("events", &format!("drain: {e}"));
    }
}

/// 读当前权威 revision，严格前进才向 webview 发 `Invalidated`。`harnesses` 是本轮 drain
/// 触及的执行环境（下界提示；spec §4.4 顺序注记）；不经 outbox 的写（桌面 IPC 的声明/
/// 价卡保存、`with_immediate_txn` 的任何提交）由 `sync_tick` 尾部的空 harnesses 电平检查
/// 兜住——同 revision 的第二次调用被发布器吞掉，所以两条路径不会双发。
fn publish_invalidation(app: &AppHandle, harnesses: std::collections::BTreeSet<String>) {
    let path = agent_vitals_data::authority::default_authority_path(&overview::data_home());
    let Ok(db) = agent_vitals_data::authority::AuthorityDb::open_readonly(&path) else { return };
    let Ok(revision) = db.revision() else { return };
    drop(db);
    let publisher = app.state::<InvalidationPublisher>();
    publisher.0.publish_if_advanced(
        agent_vitals_runtime::events::Invalidation { revision, harnesses },
        |inv| {
            agent_vitals_runtime::logging::log_info(
                "emit",
                &format!("Invalidated revision={} harnesses={:?}", inv.revision, inv.harnesses),
            );
            let _ = app.emit(APP_EVENT, serde_json::json!({
                "type": "Invalidated",
                "schema_version": 1,
                "revision": inv.revision,
                "harnesses": inv.harnesses.iter().collect::<Vec<_>>(),
            }));
        },
    );
}

/// `SyncStatusChanged`：变了才发（spec §4.5）。
fn publish_sync_status(app: &AppHandle, status: &SyncStatus) {
    let publisher = app.state::<SyncStatusPublisher>();
    let key = sync_status_publish_key(status);
    publisher.0.publish_if_changed(key, |_| {
        agent_vitals_runtime::logging::log_info(
            "emit",
            &format!("SyncStatusChanged ok={} stage={} ", status.ok, status.stage),
        );
        let _ = app.emit(APP_EVENT, sync_status_payload(status));
    });
}

fn sync_status_publish_key(status: &SyncStatus) -> (bool, String, String, Vec<overview::DynamicHarnessSyncReceipt>) {
    (status.ok, status.stage.clone(), status.message.clone(), status.dynamic_harnesses.clone())
}

/// `sync_tick_inner` 的计时外壳（REVIEW P1「事件链路打点：tick 开始/结束与
/// 耗时」）：三条内部 return 路径（paused/控制态不可读/正常流程）都在
/// `sync_tick_inner` 里，包一层比在每个 return 前插日志更不容易漏——新增一条
/// 分支自动继承计时，不用记得在新分支里也打点。
/// 托盘刷新的最小间隔（轻 tick 节流）。**收敛调查 §3.3（P2）**：60s 与轻
/// tick 的涌现间隔（冷却 30s + tick 自身耗时 → 实测 61–82s）失配——间隔恒
/// ≥ 窗口，节流形同虚设（实测 17/20 轻 tick 都跑了 read_overview，2.5–21.9s）。
/// 修正为与 `TICK_PERIOD` 对齐：托盘新鲜度回到重 tick 的 5 分钟口径（不是
/// 新增滞后）；关系由 `tray_refresh_interval_respects_tick_regime` 断言钉死。
const TRAY_REFRESH_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5 * 60);

/// 连续轻 tick 达到该次数即强制升级重 tick（LIGHT-PATH spec §5.2 排序规则，
/// 防饥饿——另一条规则是 `TICK_PERIOD` 到期，谁先到算谁）。
const LIGHT_TICKS_PER_HEAVY: u32 = 16;

/// 重 tick：全执行环境对账 + 全部投影（5 分钟周期 / 防饥饿升级 / 轻路径失败
/// 升级 / 手动同步）。与升级前行为逐项一致。
fn sync_tick(app: &AppHandle) {
    let start = std::time::Instant::now();
    sync_tick_inner(app);
    agent_vitals_runtime::logging::log_info("sync", &format!("tick finished in {:?}", start.elapsed()));
}

/// 轻 tick（LIGHT-PATH spec §5.2）：唤醒驱动的定向同步。只跑被唤醒执行环境的
/// 批；跳过 navigation 子进程 / read_overview / alerts（对账责任整体留给
/// 5 分钟重 tick）。**任一步失败即升级重 tick**（spec 不变量 5：轻失败
/// 不得等于本轮没对账）。`tray_due` = 距上次托盘重建超过
/// [`TRAY_REFRESH_INTERVAL`]；返回本轮是否刷新了托盘（调用方推进节流钟）。
fn sync_tick_light(
    app: &AppHandle,
    harnesses: &std::collections::BTreeSet<String>,
    tray_due: bool,
) -> (bool, bool) {
    if overview::sync_is_paused() == Ok(true) {
        // 暂停态无事可做；状态面留给重 tick 的既有分支（paused 分支照常
        // 每 5 分钟重写一次状态）。
        return (false, false);
    }
    let t0 = std::time::Instant::now();
    // W3：进程内同步（runtime `ingest::engine`），不再 spawn `discover`/`oneline`/
    // `claude-sync`/`sync-facts`。三个遗留步骤的产物已无读取方（见 engine 模块文档）。
    let run = agent_vitals_runtime::ingest::engine::run_sync(&overview::data_home(), Some(harnesses));
    let report = match run {
        agent_vitals_runtime::ingest::engine::SyncRun::Paused => return (false, false),
        agent_vitals_runtime::ingest::engine::SyncRun::Completed(report) => report,
        other => {
            // spec 不变量 5：轻失败不得等于本轮没对账 → 升级重 tick。
            agent_vitals_runtime::logging::log_warn(
                "sync",
                &format!("轻 tick 失败，升级重 tick: {other:?}"),
            );
            sync_tick(app);
            return (true, true);
        }
    };
    // 成功一律上报 `complete`：React 的同步状态只认 `complete` 为正常（boundedEnum
    // 白名单），此前轻 tick 报 `light`、重 tick 报 `discover`/`fold`，每次成功都被
    // 数据源页显示成失败。
    let mut status = SyncStatus::ok(
        "complete",
        format!(
            "定向同步 {:?} · {}",
            harnesses.iter().collect::<Vec<_>>(),
            agent_vitals_runtime::ingest::engine::summarize(&report)
        ),
    );
    // Light sync is scoped to compiled harnesses and never attempts manifest ingest.
    // Its successful status must not erase dynamic-source diagnostics from the last
    // full sync.
    status.dynamic_harnesses = overview::load_sync_status(&overview::data_home()).dynamic_harnesses;
    overview::save_sync_status(&status);
    publish_sync_status(app, &status);
    timed("drain_event_bus", || drain_event_bus(app));
    let harnesses_for_invalidation = harnesses.clone();
    timed("publish_invalidation", || {
        publish_invalidation(app, harnesses_for_invalidation)
    });
    if tray_due {
        let ov = timed_value("read_overview", overview_snapshot_typed_sync);
        timed("refresh", || refresh(app, &ov));
        agent_vitals_runtime::logging::log_info(
            "sync",
            &format!(
                "轻 tick 完成（{} 个执行环境，含托盘节流刷新），用时 {:?}",
                harnesses.len(),
                t0.elapsed()
            ),
        );
        return (true, false);
    }
    agent_vitals_runtime::logging::log_info(
        "sync",
        &format!(
            "轻 tick 完成（{} 个执行环境），用时 {:?}",
            harnesses.len(),
            t0.elapsed()
        ),
    );
    (false, false)
}

/// 单步计时包装：只覆盖 `sync_tick_inner` 尾部那串进程内直调（`refresh`/
/// `budget_alerts`/`quota_alerts`/`drain_event_bus`/`publish_invalidation`）——
/// 子进程 spawn 那 4 步（discover/claude-sync/sync-facts/sessions navigation）
/// 各自早已有独立计时日志，不用这层再包一次。2026-09-22 真机验收发现总 tick
/// 耗时（`tick finished in`）从基线的几十毫秒涨到稳定 7-13s，但子进程耗时加
/// 起来只占 2-5s——缺口就在这几步进程内直调上，此前没有任何一步单独计时，
/// 只能盯着总数猜；这层补上之后缺口该在哪一步就能直接读出来，不用再猜。
fn timed(label: &str, f: impl FnOnce()) {
    let start = std::time::Instant::now();
    f();
    agent_vitals_runtime::logging::log_info("sync", &format!("{label} 完成，用时 {:?}", start.elapsed()));
}

/// `timed` 的取值版——`refresh` 要拿 `read_overview()` 的结果接着建菜单，
/// 不能用只返回 `()` 的 `timed`。
fn timed_value<T>(label: &str, f: impl FnOnce() -> T) -> T {
    let start = std::time::Instant::now();
    let value = f();
    agent_vitals_runtime::logging::log_info("sync", &format!("{label} 完成，用时 {:?}", start.elapsed()));
    value
}

/// 一轮同步 + 落盘状态 + 重建托盘。**每一条路径都走到这里**——没有提前 return
/// 跳过托盘更新的分支（这正是「多数正常路径连 state 重读都不做」的修复：无未折
/// 会话/二进制缺失/discover 失败也要刷新，把外部更新带进托盘）。
/// 引擎结果 → 托盘 / 工作台的同步状态。成功一律 `complete`（React 白名单里唯一的
/// 正常态，见 `sync_tick_light` 注释）；执行环境级文件错误不算整轮失败（与 CLI 退出码 0
/// 同义），但如实写进 message。
fn status_from_run(run: &agent_vitals_runtime::ingest::engine::SyncRun) -> SyncStatus {
    use agent_vitals_runtime::ingest::engine::{summarize, SyncRun};
    match run {
        SyncRun::Paused => SyncStatus::ok("paused", "已按你的选择暂停本机解析".into()),
        SyncRun::ControlUnreadable(error) => {
            SyncStatus::fail("control", format!("同步控制状态不可读：{error}"))
        }
        SyncRun::Completed(report) => {
            let mut status = SyncStatus::ok("complete", summarize(report));
            status.dynamic_harnesses = dynamic_harness_receipts(report);
            status
        }
        SyncRun::Failed(error) => SyncStatus::fail("facts", error.clone()),
    }
}

fn dynamic_harness_receipts(
    report: &agent_vitals_runtime::ingest::sync_service::SyncReport,
) -> Vec<overview::DynamicHarnessSyncReceipt> {
    use std::collections::BTreeSet;
    let dynamic_slugs = report.harnesses.iter()
        .filter_map(|entry| entry.harness.strip_prefix("harness:"))
        .filter(|slug| agent_vitals_runtime::sources::harness_registry::plugin_slug_ok(slug))
        .collect::<BTreeSet<_>>();
    let observed_at = overview::local_timestamp_now();
    dynamic_slugs.into_iter().filter_map(|slug| {
        let harness = format!("harness:{slug}");
        let entry = report.harnesses.iter().find(|entry| entry.harness == harness)?;
        let error_code = entry.errors.first().map(|error| classify_dynamic_harness_error(error));
        Some(overview::DynamicHarnessSyncReceipt {
            harness,
            state: if error_code.is_some() { "failed".into() }
                else if entry.appended == 0 && entry.duplicate == 0 { "empty".into() }
                else { "ok".into() },
            error_code,
            observed_at: observed_at.clone(),
            appended: entry.appended,
            duplicate: entry.duplicate,
        })
    }).collect()
}

fn classify_dynamic_harness_error(error: &str) -> String {
    let error = error.to_ascii_lowercase();
    if error.contains("permission") || error.contains("denied") { "permission_denied" }
    else if error.contains("lease") || error.contains("lock") { "source_busy" }
    // Do not classify from `manifest`/`json` alone: normal source read errors
    // commonly include paths ending in `manifest.json` or `session.jsonl`.
    else if error.contains("parse") || error.contains("malformed") || error.contains("invalid json")
        || error.contains("not valid json") || error.contains("不是合法 json")
        || error.contains("校验失败") || error.starts_with("active object:")
        || (error.contains("slug `") && error.contains("不一致")) { "manifest_or_source_invalid" }
    else if error.contains("authority") || error.contains("database") || error.contains("sqlite") { "authority_unavailable" }
    else if error.contains("source") || error.contains("file") || error.contains("read") { "source_unavailable" }
    else { "ingest_failed" }.into()
}

fn sync_tick_inner(app: &AppHandle) {
    // W3：进程内同步引擎（暂停判定也在引擎里）。遗留的 discover/oneline/claude-sync
    // 三步已移除——产物（oneline.json / sessions.jsonl / claude-fold.json）无读取方。
    let run = agent_vitals_runtime::ingest::engine::run_sync(&overview::data_home(), None);
    let mut status = status_from_run(&run);
    if status.stage != "complete" {
        // Pausing or a whole-run failure says nothing new about each previously
        // active manifest. Preserve its last concrete receipt until a retry runs.
        status.dynamic_harnesses = overview::load_sync_status(&overview::data_home()).dynamic_harnesses;
    }
    if matches!(
        run,
        agent_vitals_runtime::ingest::engine::SyncRun::Paused
            | agent_vitals_runtime::ingest::engine::SyncRun::ControlUnreadable(_)
    ) {
        overview::save_sync_status(&status);
        publish_sync_status(app, &status);
        let ov = timed_value("read_overview", overview_snapshot_typed_sync);
        timed("refresh", || refresh(app, &ov));
        return;
    }
    overview::save_sync_status(&status);
    // 「变了才发」：内容相同的 SyncStatus 不再每 tick 重发（REVIEW G2）。工作台
    // 「正在整理」的生命周期由页面挂载时主动 read_sync_status + 进程首发覆盖。
    publish_sync_status(app, &status);
    // 执行环境区：sessions navigation（20s 硬超时；失败不覆盖 harnesses.json——上一轮
    // 快照继续渲染并自然转 stale，spec §6 决策 5）。
    refresh_harnesses(app);
    // 2026-09-23 真机验收：这份 overview 只查一次，`refresh`/`budget_alerts`/
    // `quota_alerts` 三处共用同一个引用——此前各自独立 `read_overview()`，
    // 一个 tick 里白算两三遍同一份重 SQL 聚合（budget_alerts 单独一项就是
    // 3.4-3.9s）。
    let ov = timed_value("read_overview", overview_snapshot_typed_sync);
    timed("refresh", || refresh(app, &ov));
    timed("budget_alerts", || budget_alerts::maybe_notify(app, &ov));
    timed("quota_alerts", || quota_alerts::maybe_notify(app, &ov));
    // 事件总线 drain：无论本轮是否有新折账——drain 自己知道有没有（deliveries
    // 反连接），空轮是 no-op；崩溃残留也在此补投。desktop-ui 合并型消费者在
    // flush 里发 `Invalidated`（带 harnesses）。
    timed("drain_event_bus", || drain_event_bus(app));
    // 电平检查（spec §4.4）：不经 outbox 的写（DSH oneline 折账落库、桌面 IPC 的
    // 声明/价卡保存……）也要让 webview 失效——revision 前进才发；上面 flush 已发过
    // 的同 revision 被发布器吞掉。这取代了旧 `FoldCompleted`（fold 成功 → 200ms 去抖
    // → 必发）：现在 fold 有没有真的改库由 revision 说了算。
    timed("publish_invalidation", || publish_invalidation(app, std::collections::BTreeSet::new()));
}


/// 每 5 分钟一轮：发现最新未折 DSH 会话 → spawn `agent-vitals oneline` 折账 →
/// 重建托盘。启动先跑一轮（托盘一亮就是新数据，不用等 5 分钟）。detached 线程
/// 即可：Tauri 的 tray 操作线程安全，AppHandle 可跨线程调用。互斥锁保证定时轮
/// 与「立即同步」不并发叠跑。
///
/// P2 watcher 接线：循环尾部从 `sleep(TICK_PERIOD)` 改为
/// `recv_timeout(TICK_PERIOD)`——watcher 去抖后 wake 一发，下一轮对账立刻跑；
/// 没事件时行为与纯 sleep 逐字节一致（周期兜底，spec §7）。
fn start_refresh_tick(
    app: AppHandle,
    slot: std::sync::Arc<agent_vitals_runtime::ingest::watch::WakeSlot>,
) {
    use agent_vitals_runtime::ingest::scheduler::{LightOutcome, SchedulerConfig, TickScheduler};
    use agent_vitals_runtime::ingest::watch::{wait_for_wake, TickKind, TickWait};
    std::thread::spawn(move || {
        // W3：轻/重决策、防饥饿、托盘节流、唤醒冷却都在 runtime 的纯状态机里（有单测，
        // 规则与此前本闭包逐条等价）；这里只剩线程、锁、等待唤醒和 UI 副作用。
        let mut scheduler = TickScheduler::new(
            SchedulerConfig {
                tick_period: TICK_PERIOD,
                light_ticks_per_heavy: LIGHT_TICKS_PER_HEAVY,
                tray_refresh_interval: TRAY_REFRESH_INTERVAL,
            },
            std::time::Instant::now(),
        );
        loop {
            let lock = app.state::<SyncLock>();
            if let Ok(_guard) = lock.0.try_lock() {
                // plan 只在拿到锁之后调用——锁被占的重试路径上执行环境集合不丢（验收 #3）。
                let plan = scheduler.plan(std::time::Instant::now());
                match &plan.kind {
                    TickKind::Heavy => {
                        sync_tick(&app);
                        scheduler.heavy_finished(std::time::Instant::now());
                    }
                    TickKind::Light(harnesses) => {
                        let (tray_refreshed, escalated) = sync_tick_light(&app, harnesses, plan.tray_due);
                        scheduler.light_finished(
                            LightOutcome { tray_refreshed, escalated },
                            std::time::Instant::now(),
                        );
                    }
                }
            } else {
                // 不进入 wait：本轮可能正是 watcher 唤醒；若现在消费掉它再等
                // TICK_PERIOD，会把低延迟保证丢失。短等后重试，仍不并发写库。
                std::thread::sleep(SYNC_LOCK_RETRY_PERIOD);
                continue;
            }
            match wait_for_wake(&slot, TICK_PERIOD) {
                TickWait::Woken(harnesses) => {
                    // R4-P0：watcher 唤醒 = 该执行环境刚有写入——刷新 trust 门控的
                    // 活动时刻表（TRUST_SENSOR_OPTIMIZATION spec §4.1）。
                    app.state::<HarnessActivityTable>().mark(&harnesses);
                    // 冷却下限（真机 2026-09-22 验收）：睡满剩余冷却再执行——不丢弃最后
                    // 一批写入；冷却窗本身是动态的（REVIEW P4 自看护）。
                    let cooldown = app.state::<WatcherCooldownOverride>().get();
                    if let Some(remaining) = scheduler.woken(harnesses, cooldown, std::time::Instant::now()) {
                        std::thread::sleep(remaining);
                    }
                }
                TickWait::TimedOut => {
                    // 周期到 → 下一轮 plan 必然判重（上次重 tick 已满周期）。
                }
            }
        }
    });
}

/// P2 watcher（AGENT_VITALS_SOURCE_GRAPH_INFRASTRUCTURE_SPEC §9-P2，方案 A
/// 2026-09-22 拍板）。源目录（claude/codex/dsh/workbuddy + skills 安装根的
/// home 相对部分）事件 → 去抖 → 唤醒同步 tick；skills 根同时注册为
/// watch-only 消费者（失效 Skill 体检的进程内报告缓存）。
///
/// 降级纪律：feature `watcher` 未启用、注册表为空、notify 初始化失败——
/// 全部退回「tick 周期对账」，不装死不报错（spec §1.5 watcher 可插拔）。
/// trust profile 目录**不**监听：trust 传感自身 2s 轮询已亚秒级，watcher
/// 无增量（P2_WATCHER_PRODUCT_REVIEW.md 决策记录）。
/// 监督者状态：持有 watcher 句柄，源配置变更命令经 [`refresh_watch_topology`]
/// 提交新拓扑快照（Phase C 热插拔——不重启线程、不重启 app）。
struct WatcherSupervisor(std::sync::Mutex<Option<agent_vitals_runtime::ingest::watch::WatcherHandle>>);

/// 自看护（REVIEW P4）的动态 watcher 冷却——毫秒存成 `AtomicU64`，是
/// `start_watcher_health_publisher`（唯一写者，CPU 采样→`SelfMonitor::step`
/// 后落这里）与 `start_refresh_tick`（唯一读者，每次 `TickWait::Woken` 读一次）
/// 之间最小的共享面。不用 `Mutex<Duration>`——两边都只做单值读/写，原子够，
/// 没有必要为一个 u64 拿锁。初值 = 基线冷却，未节流时读到的恒是这个值。
struct WatcherCooldownOverride(std::sync::atomic::AtomicU64);

impl WatcherCooldownOverride {
    fn baseline() -> Self {
        Self(std::sync::atomic::AtomicU64::new(
            agent_vitals_runtime::ingest::watch::WATCHER_SYNC_COOLDOWN.as_millis() as u64,
        ))
    }

    fn get(&self) -> std::time::Duration {
        std::time::Duration::from_millis(self.0.load(std::sync::atomic::Ordering::Relaxed))
    }

    fn set(&self, cooldown: std::time::Duration) {
        self.0.store(cooldown.as_millis() as u64, std::sync::atomic::Ordering::Relaxed);
    }
}

/// 源配置变更后的拓扑刷新（spec Phase C.2）：配置写入提交后再请求替换——
/// 读取的是已提交状态，与 sync 的下一次读取一致。worker 已退出时静默跳过
/// （周期兜底仍在服务）。
fn refresh_watch_topology(app: &AppHandle) {
    // 派生（读两份配置文件）在锁**外**做——supervisor 锁只护住句柄读取与
    // replace 的发送（验收 I-1：锁内 I/O 会把健康查询与热插拔串行化）。
    let user_home = std::path::PathBuf::from(
        std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_default(),
    );
    if user_home.as_os_str().is_empty() {
        return;
    }
    let registry = match agent_vitals_runtime::sources::watch_topology::watch_topology(
        &overview::data_home(),
        &user_home,
    ) {
        Ok(topology) => {
            let skills = app.state::<store::SkillsScanState>().inner().clone();
            agent_vitals_runtime::ingest::watch::WatchRegistry::from_topology(
                &topology,
                move |_harness| {
                    let skills = skills.clone();
                    std::sync::Arc::new(move || skills.invalidate())
                },
            )
        }
        Err(error) => {
            agent_vitals_runtime::logging::log_warn("watch_topology", &format!("派生失败（保持现拓扑）: {error}"));
            return;
        }
    };
    let supervisor = app.state::<WatcherSupervisor>();
    let guard = supervisor.0.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(handle) = guard.as_ref() {
        if let Err(error) = handle.replace(registry) {
            agent_vitals_runtime::logging::log_warn("watch_topology", &format!("替换未送达（worker 已退出）: {error}"));
        }
    }
}

fn watcher_mode_str(mode: agent_vitals_runtime::ingest::watch::WatcherMode) -> &'static str {
    use agent_vitals_runtime::ingest::watch::WatcherMode;
    match mode {
        WatcherMode::Active => "active",
        WatcherMode::Degraded => "degraded",
        WatcherMode::Disabled => "disabled",
        WatcherMode::Unavailable => "unavailable",
    }
}

/// `watcher_health` IPC 的有界 DTO（HARDENING spec §5.6）：闭集枚举 + 计数，
/// **无路径无原生错误串**。watcher 从未启动（老进程/异常路径）= disabled 快照。
fn watcher_health_payload(handle: Option<&agent_vitals_runtime::ingest::watch::WatcherHandle>) -> serde_json::Value {
    let h = handle.map(|w| w.health()).unwrap_or_default();
    serde_json::json!({
        "status": "ok",
        "schema_version": 1,
        "mode": watcher_mode_str(h.mode),
        "reason_code": h.reason_code,
        "topology_revision": h.topology_revision,
        "facts_roots_registered": h.facts_roots_registered,
        "facts_roots_attached": h.facts_roots_attached,
        "cache_roots_registered": h.cache_roots_registered,
        "cache_roots_attached": h.cache_roots_attached,
        "pending_roots": h.pending_roots,
        "last_event_at_ms": h.last_event_at_ms,
        "last_wake_at_ms": h.last_wake_at_ms,
        "coalesced_wake_count": h.coalesced_wake_count,
    })
}

#[tauri::command]
fn watcher_health(app: AppHandle) -> Result<serde_json::Value, String> {
    let supervisor = app.state::<WatcherSupervisor>();
    let guard = supervisor.0.lock().unwrap_or_else(|e| e.into_inner());
    Ok(watcher_health_payload(guard.as_ref()))
}

/// 健康变更巡检（spec §5.6）：2s 读一次快照，**只在 mode/revision/挂载数/
/// pending/reason 变化时**发 `WatcherHealthChanged`——绝不按文件事件频率发。
/// 巡检线程读的是进程内 mutex 快照，无 DB 访问。
fn start_watcher_health_publisher(app: AppHandle) {
    std::thread::spawn(move || {
        type HealthKey = (
            agent_vitals_runtime::ingest::watch::WatcherMode,
            u64,
            u32,
            u32,
            u32,
            Option<&'static str>,
        );
        let publisher = agent_vitals_runtime::events::ChangePublisher::<HealthKey>::new();
        // 自看护（REVIEW P4，G5）：复用这条已有的 2s 巡检骨架读自身 CPU——不另起
        // 一条线程。`self_monitor`/`prev_cpu_sample` 只属于这个线程，不需要锁。
        let mut self_monitor = agent_vitals_runtime::ingest::self_monitor::SelfMonitor::new();
        let mut prev_cpu_sample: Option<(u64, std::time::Instant)> = None;
        loop {
            if let Some(cur_ns) = agent_vitals_runtime::ingest::self_monitor::process_cpu_time_ns() {
                let now = std::time::Instant::now();
                if let Some((prev_ns, prev_at)) = prev_cpu_sample {
                    let pct = agent_vitals_runtime::ingest::self_monitor::cpu_percent(prev_ns, prev_at, cur_ns, now);
                    use agent_vitals_runtime::ingest::self_monitor::Transition;
                    match self_monitor.step(pct, now) {
                        Transition::Escalated => {
                            let cooldown = self_monitor.cooldown();
                            app.state::<WatcherCooldownOverride>().set(cooldown);
                            agent_vitals_runtime::logging::log_warn(
                                "self_monitor",
                                &format!("CPU {pct:.0}% 持续过高，watcher 冷却拉长到 {cooldown:?}"),
                            );
                        }
                        Transition::Recovered => {
                            let cooldown = self_monitor.cooldown();
                            app.state::<WatcherCooldownOverride>().set(cooldown);
                            agent_vitals_runtime::logging::log_info(
                                "self_monitor",
                                &format!("CPU 回落，watcher 冷却收回基线 {cooldown:?}"),
                            );
                        }
                        Transition::Unchanged => {}
                    }
                }
                prev_cpu_sample = Some((cur_ns, now));
            }
            // 快照在 supervisor 锁内取（短持锁、零 I/O），比较与 emit 在锁外
            // （验收 I-1：持锁 emit 会拖住热插拔）。
            let snapshot = {
                let supervisor = app.state::<WatcherSupervisor>();
                let guard = supervisor.0.lock().unwrap_or_else(|e| e.into_inner());
                guard.as_ref().map(|w| w.health()).unwrap_or_default()
            };
            // `throttled` 只在 watcher 自己没有更具体的原因码时才顶上——一个
            // 真实的 backend 故障比「CPU 高」更值得被看见，不能被节流覆盖掉。
            let effective_reason = snapshot.reason_code.or_else(|| {
                self_monitor.is_throttled().then_some("throttled")
            });
            let key: HealthKey = (
                snapshot.mode,
                snapshot.topology_revision,
                snapshot.facts_roots_attached,
                snapshot.cache_roots_attached,
                snapshot.pending_roots,
                effective_reason,
            );
            // 「变了才发」统一走 runtime 的 ChangePublisher（spec §4.5）——与
            // SyncStatusChanged / Invalidated 同一原语，不再手写 last 比较。
            // 2s 轮询本身从不落日志（那才是真正的噪音源）；`publish_if_changed`
            // 已经判定过「这是不是一次真实跳变」，日志顺着它的判定走，零额外
            // 逻辑——之前的盲区不是巡检太吵，是巡检完全不留痕：出问题时只有
            // 「现在」的一份快照，没有「上一次从哪个状态、什么时候变成现在这样」。
            publisher.publish_if_changed(key, |_| {
                // `coalesced_wake_count` 不进 key（涨得太勤，进 key 会让「变了
                // 才发」形同虚设）——但作为上下文搭在真实跳变的这条日志里免费：
                // REVIEW P1「watcher wake/冷却命中」要的是「能查」，不是「每次
                // 都记」，这行本来就只在 mode/reason/topology 真变化时才写。
                // component 用 "emit"（不是 "watcher_health"）——跟另外 4 处
                // app.emit 前的埋点同一个 tag，2026-09-22 真机验收发现这行原来
                // 单起一个 component，按 "emit" 做日志检索/统计时会漏掉这一类
                // 事件（功能不受影响，纯粹是 grep 不到）。消息体前缀事件类型名，
                // 与其余 4 处「类型名在前」的格式对齐。
                agent_vitals_runtime::logging::log_info(
                    "emit",
                    &format!(
                        "WatcherHealthChanged mode={} topology_revision={} pending_roots={} reason={} coalesced_wakes={}",
                        watcher_mode_str(snapshot.mode),
                        snapshot.topology_revision,
                        snapshot.pending_roots,
                        effective_reason.unwrap_or("none"),
                        snapshot.coalesced_wake_count,
                    ),
                );
                let _ = app.emit(APP_EVENT, serde_json::json!({
                    "type": "WatcherHealthChanged",
                    "schema_version": 1,
                    "mode": watcher_mode_str(snapshot.mode),
                    "topology_revision": snapshot.topology_revision,
                    "pending_roots": snapshot.pending_roots,
                    "reason_code": effective_reason,
                }));
            });
            std::thread::sleep(std::time::Duration::from_secs(2));
        }
    });
}

fn start_source_watcher(app: &AppHandle)
    -> (
        std::sync::Arc<agent_vitals_runtime::ingest::watch::WakeSlot>,
        agent_vitals_runtime::ingest::watch::WatcherHandle,
    )
{
    use agent_vitals_runtime::ingest::watch::{TickWaker, WatchRegistry};

    let channel = TickWaker::channel();
    let slot = channel.slot_arc();

    let user_home = std::path::PathBuf::from(
        std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_default(),
    );
    // Phase B：监听根由 runtime 拓扑投影唯一决定（内置 + 已批准自定义源 +
    // skills 缓存根，同一份 ingest 配置派生）——desktop 不再自建清单。
    // 拓扑读失败按「空注册表」降级（NoopWatcher + 周期兜底），不装死。
    let registry = if user_home.as_os_str().is_empty() {
        WatchRegistry::new()
    } else {
        match agent_vitals_runtime::sources::watch_topology::watch_topology(
            &overview::data_home(),
            &user_home,
        ) {
            Ok(topology) => {
                if !topology.rejected.is_empty() {
                    // 只记原因码与数量——被拒路径不进日志（serving-face 纪律
                    // 的本地同款保守）。
                    agent_vitals_runtime::logging::log_info(
                        "watch_topology",
                        &format!("有 {} 个被拒根（tick 兜底照常）", topology.rejected.len()),
                    );
                }
                let skills = app.state::<store::SkillsScanState>().inner().clone();
                WatchRegistry::from_topology(&topology, move |harness| {
                    let skills = skills.clone();
                    let _ = harness;
                    std::sync::Arc::new(move || skills.invalidate())
                })
            }
            Err(error) => {
                agent_vitals_runtime::logging::log_warn("watch_topology", &format!("派生失败（tick 兜底照常）: {error}"));
                WatchRegistry::new()
            }
        }
    };

    let handle =
        agent_vitals_runtime::ingest::watch::spawn_watcher(registry, channel.waker);
    if handle.is_noop() {
        agent_vitals_runtime::logging::log_info("watcher", "未启用（feature 关闭），tick 周期兜底");
    }
    (slot, handle)
}

/// Opt-in Trust runtime monitor. The loop is always installed with the app,
/// but it is inert until the user enables it through the Findings control. The
/// sensor only writes redacted, type-level observations to the local authority
/// DB; it never forwards payloads or asks for elevated permissions.
fn start_trust_monitor_tick(app: AppHandle) {
    std::thread::spawn(move || {
        let mut next_run = std::time::Instant::now();
        // R4-P0 门控状态：上次真实采样时刻与跳过轮的
        // 小时聚合日志（spec §11：跳过轮不全静默）。
        let mut last_sampled_at = std::time::Instant::now();
        // 首启或再次开启后的首轮必须真实采样；SyncLock 忙时保留待采标记。
        let mut initial_sample_pending = true;
        let mut skipped_since_log: u64 = 0;
        let mut last_skip_log = std::time::Instant::now();
        loop {
            let state = trust_monitor_state_read();
            if state.get("enabled").and_then(Value::as_bool) != Some(true) {
                std::thread::sleep(std::time::Duration::from_secs(2));
                next_run = std::time::Instant::now();
                last_sampled_at = std::time::Instant::now();
                initial_sample_pending = true;
                continue;
            }
            if std::time::Instant::now() < next_run {
                std::thread::sleep(std::time::Duration::from_secs(2));
                continue;
            }

            // R4-P0 活动门控（TRUST_SENSOR_OPTIMIZATION spec §4.1）：冷却窗内
            // 无活跃执行环境且空闲确认窗未到 → 整轮跳过——不 lsof、不开库、不发
            // 事件、不碰 SyncLock。空闲确认窗到期强制校准一轮，兜活动表漏记。
            let gate = trust_gate_should_sample(
                initial_sample_pending,
                app.state::<HarnessActivityTable>()
                    .any_active_within(TRUST_ACTIVITY_COOLDOWN),
                last_sampled_at.elapsed(),
            );
            if !gate {
                skipped_since_log += 1;
                if last_skip_log.elapsed() >= std::time::Duration::from_secs(3600) {
                    agent_vitals_runtime::logging::log_info(
                        "trust_sensor",
                        &format!(
                            "活动门控：过去一小时跳过 {skipped_since_log} 轮空闲传感（零 lsof / 零库访问 / 零事件）"
                        ),
                    );
                    skipped_since_log = 0;
                    last_skip_log = std::time::Instant::now();
                }
            } else {
                // Sync and the monitor both touch the authority DB. Avoid making a
                // user-triggered sync wait behind a sensor pass.
                let lock = app.state::<SyncLock>();
                if let Ok(_guard) = lock.0.try_lock() {
                    last_sampled_at = std::time::Instant::now();
                    initial_sample_pending = false;
                    let now_ms = agent_vitals_runtime::sql_sync::now_ms();
                    let report = agent_vitals_runtime::trust_runtime_monitor::snapshot_and_store(
                        &overview::data_home(),
                        &agent_vitals_runtime::takeover::machine_namespace(),
                        now_ms,
                    );
                    trust_monitor_record_report(&app, report, now_ms);
                };
            }
            let interval = state
                .get("interval_seconds")
                .and_then(Value::as_i64)
                .unwrap_or(30)
                .clamp(5, 3600) as u64;
            // R4-F6：interval 上限收敛——P0 门控下空闲零开销，5..=3600 全程
            // 安全（此前硬顶 60s 与设置界面的允许域 5..=3600 矛盾）。
            next_run = std::time::Instant::now() + std::time::Duration::from_secs(
                if initial_sample_pending { 2 } else { interval }
            );
            std::thread::sleep(std::time::Duration::from_secs(2));
        }
    });
}

fn trust_monitor_state_read() -> Value {
    let path = agent_vitals_data::authority::default_authority_path(&overview::data_home());
    let Ok(db) = agent_vitals_data::authority::AuthorityDb::open_readonly(&path) else {
        return serde_json::json!({
            "status": "unavailable", "enabled": false,
            "notifications_enabled": false, "capability": "unavailable",
            "reason": "authority_unavailable"
        });
    };
    let Ok(Some(state)) = db.trust_monitor_state_get() else {
        return serde_json::json!({
            "status": "unavailable", "enabled": false,
            "notifications_enabled": false, "capability": "unavailable",
            "reason": "monitor_state_unavailable"
        });
    };
    let capability = match state.capability.as_str() {
        "not_started" | "available" | "partial" | "unavailable" => state.capability.as_str(),
        _ => "unavailable",
    };
    let last_error_code = match state.last_error_code.as_deref() {
        Some("sensor_unavailable" | "snapshot_failed" | "sensor_partial" | "authority_unavailable" | "monitor_state_unavailable") => state.last_error_code.as_deref(),
        _ => None,
    };
    // R6a：知情同意四态闭集（legacy_default 待询问 / default 出厂开（R6c 起）/
    // user 显式选择 / dismissed 永不再问）——前端据此决定一次性条幅。
    let enabled_source = match state.enabled_source.as_str() {
        "legacy_default" | "default" | "user" | "dismissed" => state.enabled_source.as_str(),
        _ => "legacy_default",
    };
    serde_json::json!({
        "status": "ok",
        "enabled": state.enabled,
        "enabled_source": enabled_source,
        "interval_seconds": state.interval_seconds,
        "notifications_enabled": state.notifications_enabled,
        "capability": capability,
        "last_success_at_ms": state.last_success_at_ms,
        "last_error_code": last_error_code,
        "updated_at_ms": state.updated_at_ms,
    })
}

fn trust_monitor_record_report(
    app: &AppHandle,
    report: Result<agent_vitals_runtime::trust_runtime_monitor::TrustRuntimeSnapshotReport, String>,
    now_ms: i64,
) {
    let path = agent_vitals_data::authority::default_authority_path(&overview::data_home());
    let Ok(db) = agent_vitals_data::authority::AuthorityDb::open(&path, now_ms) else { return };
    let (capability, error_code, notification_keys, inserted) = match report {
        Ok(report) if report.capability == "macos_lsof_partial" => {
            ("partial", None, report.notification_keys, report.inserted)
        }
        Ok(report) if report.capability.starts_with("runtime_sensor_unavailable") => {
            ("unavailable", Some("sensor_unavailable"), report.notification_keys, report.inserted)
        }
        Ok(report) => ("partial", Some("sensor_partial"), Vec::new(), report.inserted),
        Err(_) => ("unavailable", Some("snapshot_failed"), Vec::new(), 0),
    };
    let status_changed = db.trust_monitor_state_get().ok().flatten()
        .map(|previous| previous.capability != capability || previous.last_error_code.as_deref() != error_code)
        .unwrap_or(true);
    if db.trust_monitor_record_result(capability, Some(now_ms), error_code, now_ms).is_err() {
        return;
    }
    // 有新观察或能力状态变化才通知 UI；首轮即使没有证据，也要让“尚未采集”
    // 变为“部分可观察”。稳定心跳不 emit，避免刷新风暴。
    // 注：`trust_monitor_record_result` 的每轮单行
    // autocommit UPDATE 保留——它不推进 revision，是「传感器活着」的健康面
    // 信号（last_success_at_ms），不是失效信号。
    if inserted > 0 || status_changed {
        agent_vitals_runtime::logging::log_info("emit", &format!("TrustMonitorInvalidated capability={capability} inserted={inserted}"));
        let _ = app.emit(APP_EVENT, serde_json::json!({
            "type": "TrustMonitorInvalidated", "kind": "trust_monitor_invalidated",
        }));
    }
    if notification_keys.is_empty() { return; }
    let Ok(Some(state)) = db.trust_monitor_state_get() else { return };
    if !state.notifications_enabled { return; }
    let should_notify = notification_keys.into_iter().any(|key| {
        db.trust_monitor_claim_alert(&key, now_ms, 15 * 60 * 1000).unwrap_or(false)
    });
    if !should_notify { return; }
    let language = native_ui_language();
    let _ = app.notification().builder()
        .title(native_label(language, "Local agent trust audit", "本地 Agent 信任审计"))
        .body(native_label(language, "A local activity chain needs review. Open Findings to inspect it.", "检测到需要复核的本地行为链，请打开 Findings 查看。"))
        .show();
}

/// 「立即同步」（托盘菜单 / 工作台按钮共用）：受控 tick 一次。跑在后台线程，菜单
/// 事件处理器不阻塞；互斥锁阻塞等待在途同步结束，保证用户点的这一次真的执行。
fn sync_now(app: &AppHandle) {
    sync_now_tracked(app, None);
}

fn sync_now_tracked(app: &AppHandle, request_id: Option<String>) {
    let app = app.clone();
    // 托盘菜单点击会立即关闭，但同步在后台可能持续数十秒。把状态栏标题临时
    // 改为明确的进行中状态；sync_tick 完成时 refresh() 会恢复今日 token 标题，
    // 同时重建菜单里的成功/失败状态。工作台按钮另有自己的进度文案。
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_title(Some(native_label(native_ui_language(), "Syncing…", "同步中…")));
    }
    std::thread::spawn(move || {
        let lock = app.state::<SyncLock>();
        let _guard = lock.0.lock().unwrap_or_else(|e| e.into_inner());
        sync_tick(&app);
        if let Some(id) = request_id {
            let requests = app.state::<SyncRequests>();
            let mut requests = requests.0.lock().unwrap_or_else(|e| e.into_inner());
            requests.insert(id, true);
        }
    });
}

/// 后台预热 SQL 权威库 readonly handle：app 启动就 spawn 一轮 `data-status --json`，
/// 让权威库 SQLite 文件句柄在用户点会话/findings tab 之前就绪——v0.9.1 起
/// sessions 数据唯一来源是 SQL 权威库（`agent-vitals.sqlite3` schema v2），
/// 旧 r2a_store jsonl 重放路径已退役（PR #3 收口，PR #4 feature gate，
/// PR #5 整文件删除）。
///
/// **data-status 比 sessions list 更轻**——它只读 schema 版本 + 跑
/// `PRAGMA integrity_check` + 计数 facts / sessions，不返回大 list DTO；
/// 权威库 readonly open 本就 sub-second，预热目的是让权威库的 SQLite
/// 文件预热进 page cache 与（若有）wal checkpoint 落盘，避免首次
/// sessions list 头几页的 PRAGMA / planner 抖动。
///
/// best-effort：二进制缺失/数据根不可写静默吞掉，用户点击时再正常走
/// async 路径；`StoreBuildLock` 保证与用户点击并发时后者等前者写完——
/// 这里没有可写的 cache，但锁依然有意义：避免 cold open 与
/// mcp_sessions_search 同时打开各跑一次 `PRAGMA integrity_check` 触发
/// 不必要的临时连接抖动）。
fn warm_authority_db(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let lock = app.state::<store::StoreBuildLock>().inner().clone();
        let _guard = lock.acquire();
        let Some(bin) = resolve_binary() else { return };
        let mut cmd = std::process::Command::new(&bin);
        cmd.args(["data-status", "--json"]);
        cmd.env("AGENT_VITALS_HOME", overview::data_home());
        let _ = cmd.output();
    });
}

/// 打开工作台主窗口：显示 + 聚焦。**不做 toggle**——工作台是常驻主窗口，× 只
/// 隐藏不销毁（`on_window_event` 拦截 prevent_close + hide），再开保留当前
/// tab/月/分页状态，不是重建一个空白窗口。
/// 工作台窗口句柄获取。**不能用 `get_webview_window`**：tauri 的实现要求窗口内
/// 【所有】webview 与窗口同名（`is_webview_window`），而 plugin_host 的 `add_child`
/// 会把插件 webview（plugin-city-N）挂进工作台窗口——插件一开，该 API 对
/// "workbench" 恒返回 None（窗口与 webview 实际都在，日志已证），表现为
/// 「开 City 后关窗，Dock/菜单都唤不回工作台」。窗口优先 + 按名取主 webview。
fn workbench_parts(app: &AppHandle) -> Option<(tauri::Window, Option<tauri::Webview>)> {
    let window = app.get_window("workbench")?;
    let main = window.webviews().into_iter().find(|view| view.label() == "workbench");
    Some((window, main))
}

fn show_workbench(app: &AppHandle) {
    let Some((window, main)) = workbench_parts(app) else {
        agent_vitals_runtime::logging::log_warn("workbench", "show: window lookup FAILED (registry lost)");
        return;
    };
    // 工作台可见期间显示 Dock 图标（用户理想形态：关窗图标消失、菜单栏唤起）。
    // 双向 Process Transform 此前被判「间歇性卡死再唤起」而降级为单向——后来
    // 证实那些失败的真根因是 get_webview_window 多 webview 门槛 + tao show 在
    // wedge 态静默无效（均已修复），与图标切换无关，故恢复双向。tao 自带 1s
    // 防抖防快速开关产生幽灵图标。
    #[cfg(target_os = "macos")]
    let _ = app.set_dock_visibility(true);
    // 诊断 2026-10-09「开 City 后关窗，二次唤起失败」：窗口在 CGWindowList 里存在
    // 但 onScreen=false——记录 NSApp 层 hidden 与 show/focus 的真实返回值定位卡点。
    #[cfg(target_os = "macos")]
    {
        // objc 0.2 的宏内部会生成 cfg(cargo-clippy)（与 plugin_host 的用法一致），
        // clippy -D warnings 会把它当 unexpected_cfgs——就地豁免。
        #[allow(unexpected_cfgs, clippy::undocumented_unsafe_blocks)]
        let app_hidden: bool = unsafe {
            use objc::{msg_send, sel, sel_impl};
            let ns_app: *mut objc::runtime::Object = msg_send![objc::class!(NSApplication), sharedApplication];
            msg_send![ns_app, isHidden]
        };
        agent_vitals_runtime::logging::log_info("workbench", &format!("show: nsapp_hidden={app_hidden}"));
    }
    let shown = window.show();
    let webview_shown = main.as_ref().map(|view| view.show());
    let focused = window.set_focus();
    // 重锤兜底（2026-10-09 实测）：City 插件打开后关窗再唤起，tao 的 show/set_focus
    // 返回 Ok 但 NSWindow 不排到前台（CGWindowList onScreen=false）。直接走 AppKit：
    // 应用级激活 + 反最小化 + makeKeyAndOrderFront——分别覆盖「后台应用无权切 Space」
    // 「窗口处于最小化」「orderFront 被吞」三类静默失败。
    #[cfg(target_os = "macos")]
    {
        #[allow(unexpected_cfgs, clippy::undocumented_unsafe_blocks)]
        unsafe {
            use objc::{msg_send, sel, sel_impl};
            let ns_app: *mut objc::runtime::Object = msg_send![objc::class!(NSApplication), sharedApplication];
            #[allow(clippy::upper_case_acronyms)]
            const YES: u8 = 1;
            let _: () = msg_send![ns_app, activateIgnoringOtherApps: YES];
            if let Ok(handle) = window.ns_window() {
                let ns_window = handle as *mut objc::runtime::Object;
                let miniaturized: bool = msg_send![ns_window, isMiniaturized];
                if miniaturized {
                    let nil: *mut objc::runtime::Object = std::ptr::null_mut();
                    let _: () = msg_send![ns_window, deminiaturize: nil];
                }
                let nil2: *mut objc::runtime::Object = std::ptr::null_mut();
                let _: () = msg_send![ns_window, makeKeyAndOrderFront: nil2];
            }
        }
    }
    agent_vitals_runtime::logging::log_info("workbench", &format!("show: show={shown:?} webview={webview_shown:?} focus={focused:?}"));
}

/// 信息行菜单 id → 工作台 tab 名。纯函数，单测钉住映射——切错 tab 的回归靠它挡。
/// `session:{kind}:{i}` / `harness:{kind}` 深链 id 不在这里（#11 的 WorkbenchTarget
/// 分发）；平铺「最近会话」行已删，「recent」id 不再存在。
fn tab_for_menu_id(id: &str) -> Option<&'static str> {
    match id {
        // 首行「今日消耗」→ 用量页（今天那格 + 按小时面板就是它的下钻）；此前这个 id
        // 落进 `_ => None`，点了没有任何反馈（2026-09-17 反馈）。
        "today_tokens" => Some("usage"),
        "today" | "daily" | "month" | "budget" | "subscription" => Some("overview"),
        "sync" => Some("settings"),
        // 托盘「Skill 体检」→ Skill tab（WORKBENCH_SKILL_HEALTH_TAB_SPEC §4.1）。
        "skill_health" => Some("skills"),
        _ => None,
    }
}

/// 菜单信息行点击 → 跳工作台对应 tab。双通路：持久目标（managed state，窗口不可见时
/// 下次 pull 命中）+ `focus-tab` 事件（窗口已可见时一戳就跳）。**写目标先于 show**——
/// 避免「emit 早于 listen、show 的 focus 事件又没触发」的窗口期把目标丢掉。块作用域
/// 先释放锁再 emit（与 `publish_invalidation` 同款 E0716 规避）。
fn focus_tab(app: &AppHandle, tab: &str) {
    {
        let nav = app.state::<NavTarget>();
        let mut g = nav.0.lock().unwrap_or_else(|e| e.into_inner());
        *g = Some(tab.to_string());
    }
    show_workbench(app);
    let _ = app.emit("focus-tab", tab);
}

/// 系统预算提醒的唯一点击目标。导航到设置页预算分区，避免通知 payload 变成任意
/// 工作台导航入口；写目标先于显示，工作台隐藏时也能在下次聚焦时消费。
#[tauri::command]
fn focus_budget_from_notification(app: AppHandle) -> Result<(), String> {
    focus_tab(&app, "settings#settings-budget");
    Ok(())
}

/// 动态菜单 id → 会话深链目标（spec §9.2 #12）。纯函数，单测钉住映射：
/// · `session:{kind}:{i}` → 该执行环境第 i 行 recent 的 `SessionDetail`。CLI v2 的导航
///   投影通过兼容字段 `session_key` 携带不透明 `session_ref`；只接受安全引用，
///   不把 native session key 跨 IPC 边界传给 UI。
/// · `harness:{kind}` → `SessionList{harness_kind: Some(kind)}`（v1 点击子菜单本身不产
///   事件，发射点留给「查看全部会话」回归，§7.1）。
/// · 禁用 id（`session:unavailable:{kind}` / `session:none:{kind}` /
///   `session:stale:{kind}`）→ None——禁用项点不到，事件即便到达也不该有目标。
fn workbench_target_for_menu_id(id: &str, harnesses: &[HarnessRow]) -> Option<WorkbenchTarget> {
    let mut parts = id.splitn(3, ':');
    let head = parts.next()?;
    let kind = parts.next()?;
    match (head, kind) {
        ("harness", k) => Some(WorkbenchTarget::SessionList {
            harness_kind: Some(k.to_string()),
        }),
        ("session", k) if k == "unavailable" || k == "none" || k == "stale" => None,
        ("session", k) => {
            let i: usize = parts.next()?.parse().ok()?;
            let row = harnesses.iter().find(|r| r.harness_kind == k)?;
            let session_ref = row.recent.get(i)?.session_key.as_str()?;
            if !is_safe_session_ref(session_ref) {
                return None;
            }
            Some(WorkbenchTarget::SessionDetail {
                session_ref: session_ref.to_string(),
                harness_kind: k.to_string(),
            })
        }
        _ => None,
    }
}

fn is_safe_session_ref(value: &str) -> bool {
    let Some(suffix) = value.strip_prefix("sr_") else { return false };
    (8..=128).contains(&suffix.len())
        && suffix.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

/// 会话深链的核心动作（spec §7.2 的 focus_session 语义）：**覆盖式**存入
/// FocusTarget（写先于 show——窗口不可见时 emit 是空操作，目标必须已落持久
/// slot）→ show_workbench → `focus-target` 事件（窗口已可见时一戳就跳）。事件
/// 只是通知，pull 是最终仲裁。命令与菜单分发共用这一条路径，语义只写一处。
fn focus_session_target(app: &AppHandle, target: WorkbenchTarget) {
    app.state::<FocusTarget>().set(target);
    // Plugin requests run as async Tauri commands on a Tokio worker. `show_workbench`
    // reaches AppKit (`NSApplication` / `NSWindow::makeKeyAndOrderFront`), which must
    // only run on the main thread or macOS traps with “Must only be used from the main
    // thread”. Marshal every caller (plugin IPC, commands, and tray callbacks) through
    // the same main-thread hop; keep the target stored first so the workbench can pull
    // it even if it is not visible yet.
    let app = app.clone();
    let app_for_dispatch = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        show_workbench(&app_for_dispatch);
        let _ = app_for_dispatch.emit("focus-target", ());
    }) {
        agent_vitals_runtime::logging::log_warn(
            "workbench",
            &format!("session focus dispatch to main thread failed: {error}"),
        );
    }
}

/// 工作台前端请求当前 overview —— 与托盘菜单同一份数据源，前端只渲染。
///
/// 2026-09-01 之前这里还有一份面板（`ui/index.html`/`main.js`，弹出层 popover
/// 窗口，label "overview"）共用同一个命令；面板已整体删除——左右键统一弹菜单
/// 之后它连入口都没有了，面板展示的字段本来就是工作台"总览"tab 的严格子集，
/// 没有理由为一份没有入口、内容更少的旧界面继续维护 `toggle_window`/
/// `hide_window`/一份独立的 HTML+JS+CSS。命令名留作 `read_overview` 不改，
/// 只是现在唯一的调用方是工作台。
///
/// `read_overview` IPC 的 revision 备忘（LIGHT-PATH spec §5.3 → REFRESH_STORM
/// R2 收口）：同 authority revision 直接复用上次序列化结果；槽键含 data_home
/// （并行测试的 tmp 目录互不串槽，`MonthlySummaryMemo` 同款纪律）。进程内存、
/// 单条（最新覆盖）、无持久化（HARDENING §5.5 同款纪律）。R2 起从 managed
/// State 改为进程单例：IPC 路径的 `spawn_blocking` 闭包要 'static，State 的
/// 借用进不去；托盘/tick 的四处直调点（`overview::read_overview()`）收口到
/// 同一槽——此前它们各自全量重算且完全绕过备忘（2026-09-23 风暴的放大器之一）。
/// IPC 路径经 `run_heavy_read`：ReadGate 2 permits + **拿到许可后双检查**——
/// 同 revision 突发 N 个并发 invoke 的实际全量计算 ≤ `HEAVY_READ_PERMITS`
/// （不引入 per-key single-flight，背压 spec §5.1 裁决）。
struct OverviewMemoEntry {
    revision: u64,
    data_home: String,
    state_stamp: OverviewStateStamp,
    /// 托盘/菜单面：类型化快照，Arc 零拷贝共享。
    overview: std::sync::Arc<overview::Overview>,
    /// IPC 面：预序列化结果（同 revision 的连续 invoke 不再重跑 2.2s 级聚合，
    /// 也不重复序列化）。
    value: Value,
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct OverviewStateStamp {
    harnesses: Option<(u128, u64)>,
    sync: Option<(u128, u64)>,
}

fn overview_file_stamp(path: &Path) -> Option<(u128, u64)> {
    let metadata = std::fs::metadata(path).ok()?;
    let modified = metadata.modified().ok()?
        .duration_since(std::time::UNIX_EPOCH).ok()?.as_nanos();
    Some((modified, metadata.len()))
}

fn overview_state_stamp(data_home: &str) -> OverviewStateStamp {
    let state = Path::new(data_home).join("state");
    OverviewStateStamp {
        harnesses: overview_file_stamp(&state.join("harnesses.json")),
        sync: overview_file_stamp(&state.join("last-sync.json")),
    }
}

struct OverviewMemo {
    slot: std::sync::Mutex<Option<OverviewMemoEntry>>,
    hits: std::sync::atomic::AtomicU64,
    computed: std::sync::atomic::AtomicU64,
}

fn overview_memo() -> &'static OverviewMemo {
    static MEMO: std::sync::OnceLock<OverviewMemo> = std::sync::OnceLock::new();
    MEMO.get_or_init(|| OverviewMemo {
        slot: std::sync::Mutex::new(None),
        hits: std::sync::atomic::AtomicU64::new(0),
        computed: std::sync::atomic::AtomicU64::new(0),
    })
}

/// 槽命中：revision 与 data_home 都一致才算同一条目。锁内只做查/比对/clone
/// （ReadMemo 同款锁纪律），计数走原子量不占锁。
fn overview_memo_get(revision: u64, data_home: &str) -> Option<(std::sync::Arc<overview::Overview>, Value)> {
    let state_stamp = overview_state_stamp(data_home);
    let guard = overview_memo().slot.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(entry) = guard.as_ref() {
        if entry.revision == revision && entry.data_home == data_home && entry.state_stamp == state_stamp {
            overview_memo()
                .hits
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            return Some((std::sync::Arc::clone(&entry.overview), entry.value.clone()));
        }
    }
    None
}

/// 写回（防陈旧）：同 data_home 且槽内 revision ≥ 本次——排队期间别人已写了
/// 更新的结果——则不覆盖；不同 data_home（切库/并行测试）按单槽最新覆盖语义
/// 直接替换。
#[cfg(test)]
fn overview_memo_put(revision: u64, data_home: String, ov: std::sync::Arc<overview::Overview>, value: Value) {
    let state_stamp = overview_state_stamp(&data_home);
    overview_memo_put_at(revision, data_home, ov, value, state_stamp);
}

fn overview_memo_put_at(revision: u64, data_home: String, ov: std::sync::Arc<overview::Overview>, value: Value, state_stamp: OverviewStateStamp) {
    if overview_state_stamp(&data_home) != state_stamp {
        return;
    }
    let mut guard = overview_memo().slot.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(existing) = guard.as_ref() {
        if existing.data_home == data_home &&
            (existing.revision > revision || existing.revision == revision && existing.state_stamp == state_stamp) {
            return;
        }
    }
    *guard = Some(OverviewMemoEntry { revision, data_home, state_stamp, overview: ov, value });
}

fn authority_revision_at(path: &std::path::Path) -> Option<u64> {
    agent_vitals_data::authority::AuthorityDb::open_readonly(path)
        .ok()
        .and_then(|db| db.revision().ok())
}

/// 计算并写回。调用方必须已在 ReadGate 许可下（IPC 排队路径），或托盘路径的
/// try_acquire 直算豁免。入口先做双检查——排队期间首个完成者可能已写回同
/// revision 结果，直接命中返回（这就是并发 miss 收敛为 ≤ permits 次的机制）。
fn overview_snapshot_compute(revision: u64, data_home: String) -> (std::sync::Arc<overview::Overview>, Value) {
    if let Some(hit) = overview_memo_get(revision, &data_home) {
        return hit;
    }
    let state_stamp = overview_state_stamp(&data_home);
    let ov = std::sync::Arc::new(overview::read_overview());
    let value = serde_json::to_value(ov.as_ref()).unwrap_or(Value::Null);
    overview_memo_put_at(revision, data_home, std::sync::Arc::clone(&ov), value.clone(), state_stamp);
    let computed = overview_memo()
        .computed
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        + 1;
    let hits = overview_memo().hits.load(std::sync::atomic::Ordering::Relaxed);
    agent_vitals_runtime::logging::log_info(
        "read_overview",
        &format!("备忘重算 revision={revision}（累计 computed={computed} hits={hits}）"),
    );
    (ov, value)
}

/// 同步入口（托盘 / tick 线程上下文，四处直调点收口到这里）：不排队——
/// `try_acquire` 有许可就守闸门（与 IPC 共享 2 permits，常态下互斥）；占满也
/// 直算（托盘每 300s 一刷，不能被 IPC 风暴饿死），直算仍读写同一备忘槽，
/// 与 IPC 路径共享去重收益。
///
/// **同 revision 扇出必须串行**（真机 2026-09-24 soak 抓出）：托盘启动/重建
/// 会在 1-2 秒内并发调本函数 3-5 次（菜单构建、标题、tick 尾部），try_acquire
/// 的「不饿死」豁免让它们各自全量重算同一 revision——自造风暴。锁内二次
/// 检查备忘：首个计算者写回后，其余等待者直接命中（不是 per-key 条件变量，
/// 是同步路径的单把粗粒度串行锁；阻塞上界 = 一次计算）。
fn overview_snapshot_typed_sync() -> std::sync::Arc<overview::Overview> {
    let dh = overview::data_home();
    let path = agent_vitals_data::authority::default_authority_path(&dh);
    let Some(revision) = authority_revision_at(&path) else {
        // revision 读不到（库不存在/只读失败）——按现状全量算，不缓存。
        return std::sync::Arc::new(overview::read_overview());
    };
    let data_home = dh.display().to_string();
    if let Some((ov, _)) = overview_memo_get(revision, &data_home) {
        return ov;
    }
    static SYNC_COMPUTE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _serial = SYNC_COMPUTE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    // 锁内双检查：等待期间首个计算者可能已写回同 revision 结果。
    if let Some((ov, _)) = overview_memo_get(revision, &data_home) {
        return ov;
    }
    let _permit = heavy_read_gate().try_acquire();
    overview_snapshot_compute(revision, data_home).0
}

/// IPC 异步入口：搬出 tokio worker（`run_heavy_read`）+ ReadGate 排队 + 双检查。
async fn overview_snapshot_value_async() -> Value {
    overview_snapshot_value_async_at(overview::data_home()).await
}

/// `overview_snapshot_value_async` 的 data_home 注入变体——测试用 tmp home 直接
/// 调这里，不碰进程级 env（desktop 测试并行跑在同一进程，`AGENT_VITALS_HOME`
/// 的设置/清理会与读真机数据的既有测试竞态）。
async fn overview_snapshot_value_async_at(dh: std::path::PathBuf) -> Value {
    let path = agent_vitals_data::authority::default_authority_path(&dh);
    let Some(revision) = authority_revision_at(&path) else {
        // 库不可开：按现状全量算，不缓存。仍在阻塞池跑（降级路径同样可能不轻）。
        return run_heavy_read(move || {
            serde_json::to_value(overview::read_overview()).unwrap_or(Value::Null)
        })
        .await;
    };
    let data_home = dh.display().to_string();
    if let Some((_, value)) = overview_memo_get(revision, &data_home) {
        return value;
    }
    run_heavy_read(move || overview_snapshot_compute(revision, data_home).1).await
}

#[tauri::command(async)]
async fn read_overview() -> Value {
    overview_snapshot_value_async().await
}

/// 工作台总览的权威质量状态。金额仍由 summary DTO 提供；这里仅转发
/// `data_status` 的只读健康、价格快照和 token 归因状态，避免前端自行推断。
#[tauri::command(async)]
fn data_status() -> Value {
    let data_home = overview::data_home();
    let path = agent_vitals_data::authority::default_authority_path(&data_home);
    let db = match agent_vitals_data::authority::AuthorityDb::open_readonly(&path) {
        Ok(db) => db,
        Err(error) => {
            use agent_vitals_data::authority::AuthorityError;
            let (code, action) = match error {
                AuthorityError::MissingFile => ("database_missing", "retry_sync"),
                AuthorityError::NewerSchema { .. } => ("schema_too_new", "upgrade_app"),
                AuthorityError::OlderSchema { .. } => ("schema_migration_required", "upgrade_app"),
                AuthorityError::Corrupt => ("database_unreadable", "restore_backup"),
                AuthorityError::Io(_) | AuthorityError::Sqlite(_) => ("database_unreadable", "restore_backup"),
            };
            return serde_json::json!({
                "status": "unavailable",
                "code": code,
                "reason": error.to_string(),
                "recovery_action": { "kind": action, "label": if action == "restore_backup" { "选择备份恢复" } else { "查看恢复选项" } }
            });
        }
    };
    let enabled = agent_vitals_runtime::sql_authority::is_enabled(&data_home);
    serde_json::json!({
        "status": "ok",
        // 热路径用 quick_check 深度：工作台每次切 tab 都会走到这里，全量
        // integrity_check 在大库上要 0.5–1.2s，是刷新的唯一长杆。CLI/MCP 的
        // doctor 面仍是全量检查（见 runtime::mcp::data_status_report_quick 注释）。
        "data": agent_vitals_runtime::mcp::data_status_report_quick(db.conn(), true, enabled)
    })
}

/// 从用户明确选择的备份恢复权威库。恢复顺序是：先验证备份、保留当前文件、写入同目录
/// 临时文件、再次验证临时文件，最后原子替换；任何中间步骤失败都不触碰当前库。
/// 不接受前端传入路径，避免把任意路径写入权限伪装成恢复动作。
fn restore_authority_backup_file(
    backup: &Path,
    target: &Path,
    stamp: i64,
) -> Result<Option<PathBuf>, String> {
    agent_vitals_data::authority::AuthorityDb::open_readonly(backup)
        .map_err(|error| format!("selected backup is not readable: {error}"))?;
    let parent = target.parent().ok_or_else(|| "authority path has no parent".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("create authority directory failed: {error}"))?;
    let preserved = parent.join(format!("authority.sqlite.pre-restore-{stamp}.bak"));
    if target.exists() {
        std::fs::copy(target, &preserved)
            .map_err(|error| format!("preserve current authority database failed: {error}"))?;
    }
    let temporary = parent.join(format!("authority.sqlite.restore-{stamp}-{}.tmp", std::process::id()));
    if temporary.exists() {
        return Err("restore temporary file already exists; please retry".into());
    }
    let result = (|| {
        std::fs::copy(backup, &temporary)
            .map_err(|error| format!("stage selected backup failed: {error}"))?;
        std::fs::File::open(&temporary)
            .and_then(|file| file.sync_all())
            .map_err(|error| format!("flush staged backup failed: {error}"))?;
        agent_vitals_data::authority::AuthorityDb::open_readonly(&temporary)
            .map_err(|error| format!("staged backup validation failed: {error}"))?;
        std::fs::rename(&temporary, target)
            .map_err(|error| format!("replace authority database failed: {error}"))?;
        Ok::<(), String>(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result.map(|()| target.exists().then_some(preserved))
}

#[tauri::command]
fn restore_authority_backup() -> Result<Value, String> {
    let Some(backup) = rfd::FileDialog::new()
        .add_filter("SQLite database", &["sqlite", "db", "sqlite3"])
        .pick_file() else {
        return Ok(serde_json::json!({ "status": "cancelled" }));
    };
    let data_home = overview::data_home();
    let target = agent_vitals_data::authority::default_authority_path(&data_home);
    let stamp = agent_vitals_runtime::sql_sync::now_ms();
    let preserved = restore_authority_backup_file(&backup, &target, stamp)?;
    Ok(serde_json::json!({
        "status": "restored",
        "preserved_current": preserved.is_some(),
        "backup_path": backup.to_string_lossy(),
    }))
}

/// 升级时从旧公共资产发现的套餐声明。它们是用户核对入口，不是账单：前端
/// 只能拿到展示所需的服务商、金额和起始月份，不能拿到原始价格快照或路径。
#[tauri::command(async)]
fn billing_import_candidates() -> Value {
    let data_home = overview::data_home();
    let path = agent_vitals_data::authority::default_authority_path(&data_home);
    let Ok(db) = agent_vitals_data::authority::AuthorityDb::open_readonly(&path) else {
        return serde_json::json!({ "status": "unavailable", "candidates": [] });
    };
    let window = agent_vitals_data::authority_query::beijing_month_bounds_ms(
        &overview::current_month_beijing(),
    );
    match db.billing_import_candidates() {
        Ok(rows) => serde_json::json!({
            "status": "ok",
            "candidates": rows.into_iter().map(|(candidate_id, harness, provider_id, currency, amount_minor, billing_period_start, status)| {
                let impact = window.and_then(|(window_start_ms, window_end_ms)| {
                    db.billing_declaration_impact_preview_for(
                        &provider_id, &billing_period_start, None, &[],
                        Some((window_start_ms, window_end_ms)),
                    ).ok()
                });
                serde_json::json!({
                    "candidate_id": candidate_id,
                    "harness": harness,
                    "provider_id": provider_id,
                    "currency": currency,
                    "amount_minor": amount_minor,
                    "billing_period_start": billing_period_start,
                    "status": status,
                    "impact": impact.map(|preview| serde_json::json!({
                        "status": "ok", "fact_count": preview.fact_count,
                        "session_count": preview.session_count,
                        "total_tokens": preview.total_tokens,
                    })).unwrap_or_else(|| serde_json::json!({"status": "unavailable"})),
                })
            }).collect::<Vec<_>>()
        }),
        Err(error) => serde_json::json!({ "status": "unavailable", "reason": error.to_string(), "candidates": [] }),
    }
}

/// 「确认计费方式」面板的待确认组（REQ-023）：执行环境 × provider × 模型 × 路由证据 ×
/// 计价依据，带分币估算金额、按金额降序。数据来自
/// `runtime::billing_preview::confirmation_groups`（组 SQL 与待处理投影同一份，
/// 金额与 MCP `cost_breakdown` 同一条计价路径）。此前面板只从旧资产迁移候选出发，
/// 没有旧资产的用户永远看不到待确认组（计费主链规格 G5）。
#[tauri::command(async)]
fn billing_confirmation_groups(month: String) -> Value {
    let path = agent_vitals_data::authority::default_authority_path(&overview::data_home());
    let Ok(db) = agent_vitals_data::authority::AuthorityDb::open_readonly(&path) else {
        return serde_json::json!({ "status": "unavailable", "month": month, "groups": [] });
    };
    agent_vitals_runtime::billing_preview::confirmation_groups(&db, &month)
}

/// 候选只有「不是我的」与「重新打开」两个直接决定。「接受」不再是独立动作：
/// 它曾经只把候选翻成 accepted 而不写声明、不重算，用量继续按量估算，与提示
/// 文案「确认后就能分清哪些在套餐内」相反（计费主链规格 G1）。接受现在只能
/// 由 `save_billing_declaration_revision` 在同一事务内完成。
fn candidate_decision_status(decision: &str) -> Result<&'static str, String> {
    match decision {
        "dismiss" => Ok("dismissed"),
        "reopen" => Ok("pending"),
        "accept" => Err("accepting a candidate requires saving a billing declaration".to_string()),
        _ => Err("invalid billing candidate decision".to_string()),
    }
}

#[tauri::command]
fn resolve_billing_import_candidate(candidate_id: String, decision: String) -> Result<Value, String> {
    let status = candidate_decision_status(&decision)?;
    let data_home = overview::data_home();
    let path = agent_vitals_data::authority::default_authority_path(&data_home);
    let db = agent_vitals_data::authority::AuthorityDb::open(&path, agent_vitals_runtime::sql_sync::now_ms())
        .map_err(|error| error.to_string())?;
    let changed = db.with_immediate_txn(|_| {
        let now_ms = agent_vitals_runtime::sql_sync::now_ms();
        if status == "pending" {
            db.billing_import_candidate_reopen(&candidate_id, now_ms)
        } else {
            db.billing_import_candidate_resolve(&candidate_id, status, now_ms)
        }
    }).map_err(|error| error.to_string())?;
    Ok(serde_json::json!({ "status": status, "changed": changed }))
}

#[derive(Deserialize)]
struct BillingScopeInput {
    scope_kind: String,
    scope_value: String,
}

#[derive(Deserialize)]
struct HarnessBillInput {
    bill_id: String,
    harness: String,
    provider_id: String,
    billing_period: String,
    billing_basis: String,
    amount_minor: i64,
    currency: String,
    evidence_ref: String,
}

/// 桌面端预算表单的窄 DTO。金额仍是 CNY 最小单位，避免 UI 浮点数进入权威库。
#[derive(Deserialize)]
struct BudgetConfigInput {
    monthly_cny_minor: i64,
    daily_cny_minor: i64,
    warning_ratio_bp: i64,
}

#[derive(Deserialize)]
struct BudgetProfileInput {
    profile_id: String,
    currency: String,
    monthly_minor: i64,
    daily_minor: Option<i64>,
    warning_ratio_bp: i64,
}

#[derive(Deserialize)]
struct PriceRouteInput {
    /// 型号**前缀**（与价目表 `billing_modes` 同一套匹配语义：全等或前缀）。
    model_prefix: String,
    provider_id: String,
    /// `metered` 或 `subscription`。
    mode: String,
}

#[derive(Deserialize)]
struct PriceCardInput {
    provider_id: String,
    model_id: String,
    /// 每档是 `{off_peak, peak}`；三个维度都必须给（半张卡拒绝）。
    input_uncached: Value,
    input_cached: Value,
    output: Value,
    /// 第四维可选（2026-09-17：胜算云把所有非命中输入都记作"写入"，没有这一档的中转
    /// 卡会把缓存写入静默算成 0）。不给 → 卡里没有这个键，沿用 catalog 平费率；给了
    /// 必须两档齐全，与三个必填维同一条 sanitize 纪律。
    #[serde(default)]
    cache_write: Option<Value>,
    /// 卡的币种（ISO 三位字母）。不给 = 旧表单（只认人民币）→ 按 CNY 校验，与服务商币种不符就拒绝，
    /// 而不是把别的币种的数字当人民币存下来。
    #[serde(default)]
    currency: Option<String>,
}

#[derive(Deserialize)]
struct RetentionConfigInput {
    months: u32,
}

#[derive(Deserialize)]
struct CustomSourceRootInput {
    harness: String,
    root: String,
}

#[derive(Deserialize)]
struct SourceHarnessControlInput {
    harness: String,
    excluded: bool,
}

#[tauri::command(async)]
fn custom_source_roots() -> Value {
    let data_home = overview::data_home();
    match agent_vitals_runtime::custom_sources::custom_source_roots(&data_home) {
        Ok(sources) => serde_json::json!({ "status": "ok", "sources": sources }),
        Err(error) => serde_json::json!({ "status": "unavailable", "reason": error }),
    }
}

/// 用户发起的原生目录选择。选择的是执行环境根目录（包含 `.claude` / `.codex`
/// 或 `sessions` 的目录），取消不是错误；不会在此处读取或写入会话内容。
#[tauri::command]
fn pick_custom_source_root() -> Option<String> {
    rfd::FileDialog::new().pick_folder()
        .map(|path| path.to_string_lossy().into_owned())
}

#[tauri::command]
fn add_custom_source_root(app: AppHandle, input: CustomSourceRootInput) -> Result<Value, String> {
    let data_home = overview::data_home();
    let changed = agent_vitals_runtime::custom_sources::add_custom_source_root(
        &data_home, &input.harness, Path::new(&input.root),
    )?;
    // 配置已提交——新批准的自定义源即时获得秒级监听（Phase C 热插拔）。
    refresh_watch_topology(&app);
    Ok(serde_json::json!({ "status": "saved", "changed": changed }))
}

#[tauri::command]
fn remove_custom_source_root(app: AppHandle, input: CustomSourceRootInput) -> Result<Value, String> {
    let data_home = overview::data_home();
    let changed = agent_vitals_runtime::custom_sources::remove_custom_source_root(
        &data_home, &input.harness, Path::new(&input.root),
    )?;
    refresh_watch_topology(&app);
    Ok(serde_json::json!({ "status": "removed", "changed": changed }))
}

#[tauri::command]
fn source_harness_controls() -> Value {
    let data_home = overview::data_home();
    match agent_vitals_runtime::source_controls::excluded_harnesses(&data_home) {
        Ok(excluded_harnesses) => serde_json::json!({ "status": "ok", "excluded_harnesses": excluded_harnesses, "supported_harnesses": agent_vitals_runtime::source_controls::supported_harnesses_for(&data_home) }),
        Err(error) => serde_json::json!({ "status": "unavailable", "reason": error }),
    }
}

#[tauri::command(async)]
fn source_data_revision() -> Value {
    serde_json::json!({
        "status": "ok",
        "revision": agent_vitals_runtime::source_controls::source_data_revision(&overview::data_home()),
    })
}

/// 仅工作台本机显示的标准读取目录；不混入 MCP/导出 DTO，避免路径离开桌面。
#[tauri::command(async)]
fn source_read_locations() -> Value {
    let home = PathBuf::from(
        std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default(),
    );
    let dsh = agent_vitals_runtime::home::dsh_home().map(|path| path.join("sessions"));
    serde_json::json!({
        "status": "ok",
        "locations": {
            "claude-code": home.join(".claude").join("projects").to_string_lossy(),
            // Phase B：codex 读取位置此前显示为 ~/sessions（codex_home() 返回 home 根，
// 直接 join 的历史笔误）——真实发现根在 ~/.codex 下。
            "codex": home.join(".codex").join("sessions").to_string_lossy(),
            "dsh": dsh.map(|path| path.to_string_lossy().into_owned()),
        }
    })
}

#[tauri::command]
fn set_source_harness_excluded(app: AppHandle, input: SourceHarnessControlInput) -> Result<Value, String> {
    let changed = agent_vitals_runtime::source_controls::set_harness_excluded(
        &overview::data_home(), &input.harness, input.excluded,
    )?;
    // 配置已提交——监听拓扑即时跟上（排除 = 移除该执行环境全部监听根）。
    refresh_watch_topology(&app);
    Ok(serde_json::json!({ "status": "saved", "changed": changed, "excluded": input.excluded }))
}

#[tauri::command]
fn delete_imported_source_data(app: AppHandle, harness: String) -> Result<Value, String> {
    let data_home = overview::data_home();
    // 先禁止未来读取，再在同一执行环境租约下清理 authority 投影。
    let deleted = agent_vitals_runtime::source_controls::delete_imported_source_data(&data_home, &harness)?;
    refresh_watch_topology(&app);
    let receipt = serde_json::json!({
        "status": "deleted", "harness": harness.clone(), "facts": deleted.facts,
        "sessions": deleted.sessions, "source_files": deleted.source_files,
        "trust_observations": deleted.trust_observations,
        "route_evidence": deleted.route_evidence,
        "session_excerpts": deleted.session_excerpts,
    });
    agent_vitals_runtime::logging::log_info("emit", &format!("SourceDataDeleted harness={harness}"));
    let _ = app.emit(APP_EVENT, serde_json::json!({
        "type": "SourceDataDeleted", "kind": "source_data_deleted", "harness": harness.clone(),
        "facts": deleted.facts, "sessions": deleted.sessions,
        "source_files": deleted.source_files,
        "trust_observations": deleted.trust_observations,
        "route_evidence": deleted.route_evidence,
        "session_excerpts": deleted.session_excerpts,
    }));
    let _ = app.emit("source-data-deleted", serde_json::json!({ "harness": harness }));
    Ok(receipt)
}

#[tauri::command(async)]
fn retention_config() -> Value {
    let data_home = overview::data_home();
    match agent_vitals_runtime::retention::retention_months(&data_home) {
        Ok(months) => serde_json::json!({
            "status": "ok", "months": months,
            "default_months": agent_vitals_runtime::retention::DEFAULT_RETENTION_MONTHS,
            "minimum_months": agent_vitals_runtime::retention::MIN_RETENTION_MONTHS,
            "maximum_months": agent_vitals_runtime::retention::MAX_RETENTION_MONTHS,
        }),
        Err(error) => serde_json::json!({ "status": "unavailable", "reason": error }),
    }
}

#[tauri::command]
fn save_retention_config(input: RetentionConfigInput) -> Result<Value, String> {
    let data_home = overview::data_home();
    agent_vitals_runtime::retention::save_retention_months(&data_home, input.months)?;
    Ok(serde_json::json!({ "status": "saved", "months": input.months }))
}

#[tauri::command(async)]
fn statistics_timezone_config() -> Value {
    let data_home = overview::data_home();
    match agent_vitals_runtime::statistics_timezone::timezone_name(&data_home) {
        Ok(timezone) => serde_json::json!({
            "status": "ok",
            "timezone": timezone,
            "system_timezone": agent_vitals_runtime::clock::system_timezone_name(),
            "system_timezone_fallback": agent_vitals_runtime::clock::system_timezone_fallback(),
            "follows_system": agent_vitals_runtime::statistics_timezone::follows_system(&data_home).unwrap_or(false),
        }),
        Err(error) => serde_json::json!({ "status": "unavailable", "reason": error }),
    }
}

#[tauri::command]
fn save_statistics_timezone_config(app: AppHandle, timezone: String) -> Result<Value, String> {
    let data_home = overview::data_home();
    let saved = agent_vitals_runtime::statistics_timezone::save_timezone(&data_home, &timezone)?;
    let effective = agent_vitals_runtime::statistics_timezone::apply(&data_home)?;
    // The Workbench refreshes its active tab after the IPC returns, but the
    // tray is a separate consumer and its harness rows come from harnesses.json. A
    // plain menu rebuild would therefore retain the old day's navigation
    // snapshot. Re-run the bounded navigation refresh off the command thread,
    // then rebuild the tray from the newly written snapshot.
    let background_app = app.clone();
    std::thread::spawn(move || {
        refresh_harnesses(&background_app);
        refresh(&background_app, overview_snapshot_typed_sync().as_ref());
    });
    refresh(&app, overview_snapshot_typed_sync().as_ref());
    // follows_system 时 `saved` 是哨兵 "system"；回执给界面的是实际生效的 IANA 名。
    let follows = saved == agent_vitals_runtime::statistics_timezone::FOLLOW_SYSTEM;
    Ok(serde_json::json!({ "status": "saved", "timezone": if follows { effective } else { saved }, "follows_system": follows }))
}

/// 系统区域标识（`en_US` / `zh_CN` …），报告币种默认值用。读不到 → 空串（默认 USD）。
fn system_locale() -> String {
    #[cfg(target_os = "macos")]
    if let Ok(output) = std::process::Command::new("/usr/bin/defaults").args(["read", "-g", "AppleLocale"]).output() {
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !text.is_empty() { return text; }
        }
    }
    #[cfg(target_os = "macos")]
    if let Ok(output) = std::process::Command::new("/usr/bin/defaults").args(["read", "-g", "AppleLanguages"]).output() {
        // `("zh-Hans-CN", "en-CN")` 的第一项带区域（zh-Hans-CN）；AppleLocale 缺失时用它定区域。
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout).to_string();
            if let Some(first) = text.split(['"', '\'']).nth(1) { if !first.is_empty() { return first.to_string(); } }
        }
    }
    std::env::var("LC_ALL").or_else(|_| std::env::var("LANG")).unwrap_or_default()
}

/// 汇率 V2 的界面入口。账单层始终原币种；这里只给「报告币种 + 汇率出处 + 是否过期」。
#[tauri::command(async)]
fn fx_status() -> Value {
    let data_home = overview::data_home();
    let locale = system_locale();
    let _ = agent_vitals_runtime::core::fx_settings::save_locale_hint(&data_home, &locale);
    let (currency, is_default) = agent_vitals_runtime::fx_settings::reporting_currency(&data_home, &locale)
        .unwrap_or_else(|_| (agent_vitals_domain::fx::default_reporting_currency(&locale).to_string(), true));
    let policy = agent_vitals_runtime::fx_settings::policy(&data_home);
    let rate_date = policy.snapshot().rate_date.clone();
    let (_, synced, fetched_at_ms) = agent_vitals_runtime::fx_settings::effective_snapshot(&data_home);
    let age = agent_vitals_domain::fx::FxPolicy::age_days(&rate_date, &overview::today_beijing());
    let manual: Vec<Value> = agent_vitals_runtime::fx_settings::manual_rates(&data_home).unwrap_or_default().into_iter()
        .map(|r| serde_json::json!({ "from": r.from, "to": r.to, "rate": r.rate, "as_of": r.as_of })).collect();
    serde_json::json!({
        "status": "ok",
        "reporting_currency": currency,
        "reporting_currency_is_default": is_default,
        "default_currency": agent_vitals_domain::fx::default_reporting_currency(&locale),
        "system_locale": locale,
        "rate_date": rate_date,
        "rate_age_days": age,
        // 超过 14 天标过期：界面据此提示「汇率已过期」，数字仍显示但必须带 ≈ 与日期。
        "rate_stale": age.is_none_or(|days| days > 14),
        "rate_source": if synced { "synced_snapshot" } else { "bundled_snapshot" },
        "rate_fetched_at_ms": fetched_at_ms,
        "supported_currencies": policy.snapshot().rates_per_usd.keys().collect::<Vec<_>>(),
        "manual_rates": manual,
    })
}

#[tauri::command]
fn save_reporting_currency_config(app: AppHandle, currency: String) -> Result<Value, String> {
    let saved = agent_vitals_runtime::fx_settings::save_reporting_currency(&overview::data_home(), &currency)?;
    refresh(&app, overview_snapshot_typed_sync().as_ref());
    Ok(serde_json::json!({ "status": "saved", "currency": saved }))
}

#[tauri::command]
fn save_fx_manual_rate(app: AppHandle, from: String, to: String, rate: f64, as_of: Option<String>) -> Result<Value, String> {
    agent_vitals_runtime::fx_settings::save_manual_rate(&overview::data_home(), agent_vitals_domain::fx::UserRate {
        from, to, rate, as_of: as_of.filter(|d| !d.trim().is_empty()),
    })?;
    refresh(&app, overview_snapshot_typed_sync().as_ref());
    Ok(serde_json::json!({ "status": "saved" }))
}

#[tauri::command]
fn remove_fx_manual_rate(app: AppHandle, from: String, to: String) -> Result<Value, String> {
    agent_vitals_runtime::fx_settings::remove_manual_rate(&overview::data_home(), &from, &to)?;
    refresh(&app, overview_snapshot_typed_sync().as_ref());
    Ok(serde_json::json!({ "status": "removed" }))
}

/// 把 `{币种: 金额}` 折成报告币种的约数合计，逐项带出处。折不了的币种原样列在 `unavailable`
/// （界面保留原币种、标「折算不可用」），绝不用默认汇率顶。折算结果只用于展示，不进账。
#[tauri::command(async)]
fn fx_convert_amounts(amounts: std::collections::BTreeMap<String, f64>) -> Value {
    let data_home = overview::data_home();
    let (target, _) = agent_vitals_runtime::fx_settings::reporting_currency(&data_home, &system_locale())
        .unwrap_or_else(|_| ("USD".to_string(), true));
    let policy = agent_vitals_runtime::fx_settings::policy(&data_home);
    let mut items = Vec::new();
    let mut unavailable = Vec::new();
    let mut total = 0.0_f64;
    let mut approximate = false;
    for (currency, amount) in amounts.iter().filter(|(_, amount)| **amount != 0.0) {
        match policy.convert(*amount, currency, &target) {
            Some(c) => {
                total += c.target_amount;
                approximate |= c.approximate;
                items.push(serde_json::json!({
                    "currency": c.source_currency, "amount": c.source_amount, "converted": c.target_amount, "rate": c.rate,
                    "rate_source": match c.rate_source {
                        agent_vitals_domain::fx::RateSource::BundledSnapshot => "bundled_snapshot",
                        agent_vitals_domain::fx::RateSource::UserAssumption => "user_assumption",
                        agent_vitals_domain::fx::RateSource::Identity => "identity",
                    },
                    "rate_date": c.rate_date,
                }));
            }
            None => unavailable.push(serde_json::json!({ "currency": currency, "amount": amount })),
        }
    }
    serde_json::json!({ "status": "ok", "target": target, "total": total, "approximate": approximate, "items": items, "unavailable": unavailable })
}

const UI_LANGUAGE_CONFIG_FILE: &str = "ui-language.json";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NativeUiLanguage { English, Chinese }

fn language_from_system_list(text: &str) -> NativeUiLanguage {
    let first = text.split(['\"', '\'']).nth(1).unwrap_or("");
    if first.to_ascii_lowercase().starts_with("zh") { NativeUiLanguage::Chinese }
    else { NativeUiLanguage::English }
}

fn system_ui_language() -> NativeUiLanguage {
    #[cfg(target_os = "macos")]
    if let Ok(output) = std::process::Command::new("/usr/bin/defaults")
        .args(["read", "-g", "AppleLanguages"]).output() {
        if output.status.success() {
            return language_from_system_list(&String::from_utf8_lossy(&output.stdout));
        }
    }
    let locale = std::env::var("LANG").unwrap_or_default();
    if locale.to_ascii_lowercase().starts_with("zh") { NativeUiLanguage::Chinese }
    else { NativeUiLanguage::English }
}

fn native_ui_language() -> NativeUiLanguage {
    match ui_language_preference().as_deref() {
        Ok("en") => NativeUiLanguage::English,
        Ok("zh-Hans") => NativeUiLanguage::Chinese,
        _ => system_ui_language(),
    }
}

fn native_label(language: NativeUiLanguage, english: &'static str, chinese: &'static str) -> &'static str {
    match language { NativeUiLanguage::English => english, NativeUiLanguage::Chinese => chinese }
}

fn ui_language_preference() -> Result<String, String> {
    let path = overview::data_home().join("state").join(UI_LANGUAGE_CONFIG_FILE);
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok("system".to_string()),
        Err(error) => return Err(format!("UI language preference unreadable: {error}")),
    };
    let value: Value = serde_json::from_str(&text)
        .map_err(|error| format!("UI language preference invalid: {error}"))?;
    let language = value.get("language").and_then(Value::as_str)
        .ok_or_else(|| "UI language preference missing language".to_string())?;
    match language {
        "system" | "en" | "zh-Hans" => Ok(language.to_string()),
        _ => Err("UI language preference unsupported".to_string()),
    }
}

#[tauri::command]
fn ui_language_config() -> Result<Value, String> {
    let path = overview::data_home().join("state").join(UI_LANGUAGE_CONFIG_FILE);
    Ok(serde_json::json!({ "status": "ok", "language": ui_language_preference()?, "has_preference": path.exists() }))
}

#[tauri::command]
fn save_ui_language_config(app: AppHandle, language: String) -> Result<Value, String> {
    if !matches!(language.as_str(), "system" | "en" | "zh-Hans") {
        return Err("unsupported UI language preference".to_string());
    }
    let directory = overview::data_home().join("state");
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let temporary = directory.join("ui-language.json.tmp");
    let target = directory.join(UI_LANGUAGE_CONFIG_FILE);
    let contents = serde_json::to_vec(&serde_json::json!({ "language": language }))
        .map_err(|error| error.to_string())?;
    std::fs::write(&temporary, contents).map_err(|error| error.to_string())?;
    std::fs::rename(&temporary, target).map_err(|error| error.to_string())?;
    refresh(&app, overview_snapshot_typed_sync().as_ref());
    Ok(serde_json::json!({ "status": "saved", "language": language }))
}

/// 每日同步叠加层（`.github/workflows/pricing-sync.yml` 每天生成）。app 拉到后与
/// 内置底表合并成完整快照入库；旧链路拉的是完整 `pricing.json` 且只存它一份，
/// 快照里没有 `codex_pricing`，开启更新后 codex 用量会全部算不出金额。
const PUBLIC_PRICING_CATALOG_URL: &str =
    "https://raw.githubusercontent.com/Oh-Agent-AI/oh-agent/main/assets/pricing-sync.json";
/// 6 小时而非 24 小时：CI 每天发布一次叠加层，24 小时的检查间隔叠上发布时间
/// 会让新模型的价卡最晚拖近两天才到。拉的是本仓库十几 KB 的静态文件、不带任何
/// 用户数据，多检查几次没有隐私代价。
/// 每日汇率快照（`.github/workflows/pricing-sync.yml` 同一个作业里由 `scripts/fx_sync.py` 生成）。
/// 与价卡同一个开关、同一类请求：固定公开 HTTPS 地址、纯静态文件、不带任何用户数据；
/// 校验不过只丢弃，当前生效的汇率（已同步的或内置的）原样保留。
const PUBLIC_FX_SNAPSHOT_URL: &str =
    "https://raw.githubusercontent.com/Oh-Agent-AI/oh-agent/main/assets/fx-sync.json";
const PRICING_CHECK_INTERVAL_MS: i64 = 6 * 60 * 60 * 1000;
const PRICING_UPDATE_STATUS_FILE: &str = "pricing-catalog-update.json";
const PRICING_UPDATE_POLICY_FILE: &str = "pricing-catalog-policy.json";

#[derive(Debug, Serialize, Deserialize, Default)]
struct PricingCatalogUpdateStatus {
    state: String,
    source_url: String,
    last_checked_at_ms: Option<i64>,
    last_success_at_ms: Option<i64>,
    source_version: Option<String>,
    model_count: Option<usize>,
    failure_reason: Option<String>,
    #[serde(default)]
    failure_count: u32,
    #[serde(default)]
    next_check_at_ms: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct PricingCatalogPolicy {
    network_enabled: bool,
}

fn pricing_catalog_status_path(data_home: &Path) -> PathBuf {
    data_home.join(PRICING_UPDATE_STATUS_FILE)
}

fn pricing_catalog_policy_path(data_home: &Path) -> PathBuf {
    data_home.join(PRICING_UPDATE_POLICY_FILE)
}

fn read_pricing_catalog_policy(data_home: &Path) -> PricingCatalogPolicy {
    std::fs::read(pricing_catalog_policy_path(data_home))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn write_pricing_catalog_policy(
    data_home: &Path,
    policy: &PricingCatalogPolicy,
) -> Result<(), String> {
    std::fs::create_dir_all(data_home).map_err(|e| format!("create data home failed: {e}"))?;
    let bytes = serde_json::to_vec_pretty(policy)
        .map_err(|e| format!("serialize pricing policy failed: {e}"))?;
    let tmp = data_home.join("pricing-catalog-policy.json.tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("write pricing policy failed: {e}"))?;
    std::fs::rename(&tmp, pricing_catalog_policy_path(data_home))
        .map_err(|e| format!("commit pricing policy failed: {e}"))
}

fn read_pricing_catalog_status(data_home: &Path) -> PricingCatalogUpdateStatus {
    let path = pricing_catalog_status_path(data_home);
    std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_else(|| PricingCatalogUpdateStatus {
            state: "never_checked".into(),
            source_url: PUBLIC_PRICING_CATALOG_URL.into(),
            ..Default::default()
        })
}

fn write_pricing_catalog_status(
    data_home: &Path,
    status: &PricingCatalogUpdateStatus,
) -> Result<(), String> {
    std::fs::create_dir_all(data_home).map_err(|e| format!("create data home failed: {e}"))?;
    let bytes = serde_json::to_vec_pretty(status)
        .map_err(|e| format!("serialize pricing status failed: {e}"))?;
    let tmp = data_home.join("pricing-catalog-update.json.tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("write pricing status failed: {e}"))?;
    std::fs::rename(&tmp, pricing_catalog_status_path(data_home))
        .map_err(|e| format!("commit pricing status failed: {e}"))
}

fn fail_pricing_catalog_update(
    data_home: &Path,
    status: &mut PricingCatalogUpdateStatus,
    state: &str,
    reason: String,
) -> Result<Value, String> {
    status.state = state.into();
    status.failure_reason = Some(reason.clone());
    status.failure_count = status.failure_count.saturating_add(1);
    let backoff_hours = 1_i64 << status.failure_count.min(7);
    status.next_check_at_ms = Some(
        status
            .last_checked_at_ms
            .unwrap_or_else(agent_vitals_runtime::sql_sync::now_ms)
            .saturating_add(backoff_hours.saturating_mul(60 * 60 * 1000)),
    );
    write_pricing_catalog_status(data_home, status)?;
    Err(reason)
}

#[tauri::command(async)]
fn public_pricing_catalog_status() -> Value {
    let data_home = overview::data_home();
    let mut status = serde_json::to_value(read_pricing_catalog_status(&data_home))
        .unwrap_or_else(|_| serde_json::json!({ "state": "unavailable" }))
        ;
    status["network_enabled"] = Value::Bool(read_pricing_catalog_policy(&data_home).network_enabled);
    status
}

#[tauri::command]
fn save_public_pricing_catalog_policy(network_enabled: bool) -> Result<Value, String> {
    let data_home = overview::data_home();
    write_pricing_catalog_policy(&data_home, &PricingCatalogPolicy { network_enabled })?;
    Ok(serde_json::json!({ "status": "saved", "network_enabled": network_enabled }))
}

/// 手动检查维护者发布的公共价格目录。请求只访问固定 HTTPS 公共地址，不携带
/// AGENT_VITALS_HOME、日志内容、会话、账户或任何本地数据；下载失败/校验失败
/// 只写检查状态，绝不删除或替换当前有效价卡。
#[tauri::command]
async fn update_public_pricing_catalog_internal(enforce_schedule: bool) -> Result<Value, String> {
    let data_home = overview::data_home();
    let policy = read_pricing_catalog_policy(&data_home);
    if !policy.network_enabled {
        return Err("公共价格联网检查未开启；请先明确允许访问公共价格服务".into());
    }
    let now = agent_vitals_runtime::sql_sync::now_ms();
    let mut status = read_pricing_catalog_status(&data_home);
    if enforce_schedule
        && (status.next_check_at_ms.is_some_and(|next| now < next)
            || status
                .last_checked_at_ms
                .is_some_and(|last| now.saturating_sub(last) < PRICING_CHECK_INTERVAL_MS))
    {
        return Ok(serde_json::json!({ "status": "skipped", "reason": "daily_check_window" }));
    }
    status.source_url = PUBLIC_PRICING_CATALOG_URL.into();
    status.last_checked_at_ms = Some(now);
    status.failure_reason = None;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .user_agent("agent-vitals-public-pricing-check/1")
        .build()
        .map_err(|e| format!("create public pricing client failed: {e}"));
    let client = match client {
        Ok(client) => client,
        Err(reason) => return fail_pricing_catalog_update(&data_home, &mut status, "failed", reason),
    };
    let response = client
        .get(PUBLIC_PRICING_CATALOG_URL)
        .send()
        .await;
    let response = match response {
        Ok(response) => response,
        Err(error) => {
            return fail_pricing_catalog_update(
                &data_home,
                &mut status,
                "failed",
                format!("public pricing request failed: {error}"),
            )
        }
    };
    if !response.status().is_success() {
        return fail_pricing_catalog_update(
            &data_home,
            &mut status,
            "failed",
            format!("public pricing returned HTTP {}", response.status()),
        );
    }
    if response.content_length().is_some_and(|length| length > 2 * 1024 * 1024) {
        return fail_pricing_catalog_update(
            &data_home,
            &mut status,
            "failed",
            "public pricing response exceeds 2 MiB limit".into(),
        );
    }
    let bytes = match response.bytes().await {
        Ok(bytes) => bytes,
        Err(error) => {
            return fail_pricing_catalog_update(
                &data_home,
                &mut status,
                "failed",
                format!("read public pricing response failed: {error}"),
            )
        }
    };
    if bytes.len() > 2 * 1024 * 1024 {
        return fail_pricing_catalog_update(
            &data_home,
            &mut status,
            "failed",
            "public pricing response exceeds 2 MiB limit".into(),
        );
    }
    let validated = match agent_vitals_runtime::pricing_catalog::validate_sync_overlay(&bytes) {
        Ok(validated) => validated,
        Err(reason) => return fail_pricing_catalog_update(&data_home, &mut status, "rejected", reason),
    };
    let authority_path = agent_vitals_data::authority::default_authority_path(&data_home);
    let db = agent_vitals_data::authority::AuthorityDb::open(&authority_path, now)
        .map_err(|e| format!("open authority database failed: {e}"))?;
    agent_vitals_runtime::sql_sync::snapshot_with_sync_overlay(&db, &validated)
        .map_err(|e| format!("save sync overlay and pricing snapshot atomically failed: {e}"))?;
    // 汇率与价卡同一次检查、同一个开关；汇率失败不影响价卡（各自独立，失败只记一行原因）。
    let fx = fetch_public_fx_snapshot(&data_home, now).await;
    status.state = "ok".into();
    status.last_success_at_ms = Some(now);
    status.source_version = Some(validated.version.clone());
    status.model_count = Some(validated.card_count);
    status.failure_count = 0;
    status.next_check_at_ms = Some(now.saturating_add(PRICING_CHECK_INTERVAL_MS));
    write_pricing_catalog_status(&data_home, &status)?;
    Ok(serde_json::json!({
        "status": "updated",
        "source_url": PUBLIC_PRICING_CATALOG_URL,
        "source_version": validated.version,
        "model_count": validated.card_count,
        "last_success_at_ms": now,
        "fx": fx,
    }))
}

/// 拉取并保存公共汇率快照。返回 `{status:"updated"|"failed", ...}`，从不抛错：汇率拿不到时
/// 应用继续用已有汇率（报告里会按快照日期标「≈ 与日期」，过期则标过期）。
async fn fetch_public_fx_snapshot(data_home: &Path, now: i64) -> Value {
    let failed = |reason: String| serde_json::json!({ "status": "failed", "reason": reason });
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .user_agent("agent-vitals-public-fx-check/1")
        .build()
    {
        Ok(client) => client,
        Err(error) => return failed(format!("create fx client failed: {error}")),
    };
    let response = match client.get(PUBLIC_FX_SNAPSHOT_URL).send().await {
        Ok(response) if response.status().is_success() => response,
        Ok(response) => return failed(format!("fx snapshot returned HTTP {}", response.status())),
        Err(error) => return failed(format!("fx snapshot request failed: {error}")),
    };
    if response.content_length().is_some_and(|length| length > 256 * 1024) {
        return failed("fx snapshot exceeds the 256 KiB limit".into());
    }
    let bytes = match response.bytes().await {
        Ok(bytes) => bytes,
        Err(error) => return failed(format!("read fx snapshot failed: {error}")),
    };
    match agent_vitals_runtime::fx_settings::save_synced(data_home, &bytes, &overview::today_beijing(), now) {
        Ok(snapshot) => serde_json::json!({ "status": "updated", "rate_date": snapshot.rate_date }),
        Err(reason) => failed(reason),
    }
}

#[tauri::command]
async fn update_public_pricing_catalog() -> Result<Value, String> {
    update_public_pricing_catalog_internal(false).await
}

// ── 官方 manifest 目录（E06，扩展架构 §8.2）────────────────────────────
// 与公共价卡同一条纪律：HTTP 只在桌面层；请求固定公共 HTTPS 地址、不带任何
// 用户数据；默认关闭、显式 opt-in；失败只写状态文件，绝不影响已装内容。
// 索引检查与 harness payload 预览/确认分开；支持的条目数不代表已安装数量。
const MANIFEST_CATALOG_INDEX_URL: &str =
    agent_vitals_runtime::ingest::vendor_manifest_install::OFFICIAL_INDEX_URL;
const MANIFEST_CATALOG_STATUS_FILE: &str = "manifest-catalog-update.json";
const MANIFEST_CATALOG_POLICY_FILE: &str = "manifest-catalog-policy.json";
const MANIFEST_CATALOG_CHECK_INTERVAL_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Serialize, Deserialize, Default)]
struct ManifestCatalogStatus {
    state: String,
    source_url: String,
    last_checked_at_ms: Option<i64>,
    last_success_at_ms: Option<i64>,
    catalog_sequence: Option<u64>,
    index_sha256: Option<String>,
    entry_count: Option<usize>,
    supported_entries: Option<usize>,
    failure_reason: Option<String>,
    #[serde(default)]
    failure_count: u32,
    #[serde(default)]
    next_check_at_ms: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct ManifestCatalogPolicy {
    network_enabled: bool,
}

fn manifest_catalog_status_path(data_home: &Path) -> PathBuf {
    data_home.join(MANIFEST_CATALOG_STATUS_FILE)
}

fn manifest_catalog_policy_path(data_home: &Path) -> PathBuf {
    data_home.join(MANIFEST_CATALOG_POLICY_FILE)
}

fn read_manifest_catalog_policy(data_home: &Path) -> ManifestCatalogPolicy {
    std::fs::read(manifest_catalog_policy_path(data_home))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn write_manifest_catalog_policy(
    data_home: &Path,
    policy: &ManifestCatalogPolicy,
) -> Result<(), String> {
    std::fs::create_dir_all(data_home).map_err(|e| format!("create data home failed: {e}"))?;
    let bytes = serde_json::to_vec_pretty(policy)
        .map_err(|e| format!("serialize manifest catalog policy failed: {e}"))?;
    let tmp = data_home.join("manifest-catalog-policy.json.tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("write manifest catalog policy failed: {e}"))?;
    std::fs::rename(&tmp, manifest_catalog_policy_path(data_home))
        .map_err(|e| format!("commit manifest catalog policy failed: {e}"))
}

fn read_manifest_catalog_status(data_home: &Path) -> ManifestCatalogStatus {
    std::fs::read(manifest_catalog_status_path(data_home))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_else(|| ManifestCatalogStatus {
            state: "never_checked".into(),
            source_url: MANIFEST_CATALOG_INDEX_URL.into(),
            ..Default::default()
        })
}

fn read_manifest_catalog_status_for_update(data_home: &Path) -> Result<ManifestCatalogStatus, String> {
    use std::io::Read;
    let file = match std::fs::File::open(manifest_catalog_status_path(data_home)) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(read_manifest_catalog_status(data_home)),
        Err(error) => return Err(format!("read catalog status failed: {error}")),
    };
    let mut bytes = Vec::new();
    file.take(1024 * 1024 + 1).read_to_end(&mut bytes).map_err(|e| format!("read catalog status failed: {e}"))?;
    if bytes.len() > 1024 * 1024 { return Err("catalog status bytes limit".into()); }
    serde_json::from_slice(&bytes).map_err(|e| format!("catalog status invalid; update refused: {e}"))
}

fn write_manifest_catalog_status(
    data_home: &Path,
    status: &ManifestCatalogStatus,
) -> Result<(), String> {
    std::fs::create_dir_all(data_home).map_err(|e| format!("create data home failed: {e}"))?;
    let bytes = serde_json::to_vec_pretty(status)
        .map_err(|e| format!("serialize manifest catalog status failed: {e}"))?;
    let tmp = data_home.join("manifest-catalog-update.json.tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("write manifest catalog status failed: {e}"))?;
    std::fs::rename(&tmp, manifest_catalog_status_path(data_home))
        .map_err(|e| format!("commit manifest catalog status failed: {e}"))
}

fn fail_manifest_catalog_update(
    data_home: &Path,
    status: &mut ManifestCatalogStatus,
    state: &str,
    reason: String,
) -> Result<Value, String> {
    status.state = state.into();
    status.failure_reason = Some(reason.clone());
    status.failure_count = status.failure_count.saturating_add(1);
    let backoff_hours = 1_i64 << status.failure_count.min(7);
    status.next_check_at_ms = Some(
        status
            .last_checked_at_ms
            .unwrap_or_else(agent_vitals_runtime::core::clock::now_ms)
            .saturating_add(backoff_hours.saturating_mul(60 * 60 * 1000)),
    );
    write_manifest_catalog_status(data_home, status)?;
    Err(reason)
}

/// 本体当前支持的 slot/能力（E01 capability 协商的目录面镜像——来源是
/// `generic_manifest::CapabilitySet::default()`，不维护第二份词表）。
fn manifest_catalog_slot_support() -> std::collections::BTreeMap<String, agent_vitals_domain::domain::catalog_index::SlotSupport> {
    agent_vitals_runtime::ingest::vendor_manifest_install::harness_slot_support()
}

fn manifest_catalog_cache_path(data_home: &Path) -> PathBuf {
    data_home.join("cache").join("catalog").join("index.json")
}

const MANIFEST_CATALOG_INDEX_MAX_BYTES: usize = 4 * 1024 * 1024;
static MANIFEST_CATALOG_UPDATE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn append_manifest_catalog_chunk(bytes: &mut Vec<u8>, chunk: &[u8]) -> Result<(), &'static str> {
    if chunk.len() > MANIFEST_CATALOG_INDEX_MAX_BYTES.saturating_sub(bytes.len()) {
        return Err("manifest catalog response exceeds 4 MiB limit");
    }
    bytes.extend_from_slice(chunk);
    Ok(())
}

fn accepted_manifest_catalog_floor(
    data_home: &Path,
    status: &ManifestCatalogStatus,
    support: &std::collections::BTreeMap<String, agent_vitals_domain::domain::catalog_index::SlotSupport>,
    app_version: &str,
) -> Result<Option<(u64, String)>, String> {
    let mut highest = match (status.catalog_sequence, status.index_sha256.as_deref()) {
        (Some(sequence), Some(hash)) => Some((sequence, hash.to_string())),
        (None, None) => None,
        _ => return Err("manifest catalog status has an incomplete sequence/hash pair".into()),
    };
    let path = manifest_catalog_cache_path(data_home);
    let file = match std::fs::File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(highest),
        Err(error) => return Err(format!("read manifest catalog cache failed: {error}")),
    };
    use std::io::Read;
    let mut bytes = Vec::new();
    file.take((MANIFEST_CATALOG_INDEX_MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes).map_err(|e| format!("read manifest catalog cache failed: {e}"))?;
    let index = agent_vitals_domain::domain::catalog_index::parse_catalog(&bytes)
        .map_err(|e| format!("cached manifest catalog invalid: {e}"))?;
    use sha2::Digest;
    let hash = format!("{:x}", sha2::Sha256::digest(&bytes));
    agent_vitals_domain::domain::catalog_index::validate_catalog(
        &index, support, app_version, &hash, None)
        .map_err(|e| format!("cached manifest catalog invalid: {e}"))?;
    let sequence = index["catalog_sequence"].as_u64().ok_or("cached catalog has no sequence")?;
    match &highest {
        Some((previous, _)) if sequence < *previous => {},
        Some((previous, previous_hash)) if sequence == *previous && hash != *previous_hash => {
            return Err("manifest catalog cache/status sequence conflict".into());
        }
        _ => highest = Some((sequence, hash)),
    }
    Ok(highest)
}

fn write_manifest_catalog_index_cache(data_home: &Path, bytes: &[u8]) -> Result<(), String> {
    let path = manifest_catalog_cache_path(data_home);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create catalog cache dir failed: {e}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("write catalog cache failed: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("commit catalog cache failed: {e}"))
}

#[tauri::command(async)]
fn manifest_catalog_status() -> Value {
    let data_home = overview::data_home();
    let mut status = serde_json::to_value(read_manifest_catalog_status(&data_home))
        .unwrap_or_else(|_| serde_json::json!({ "state": "unavailable" }));
    status["network_enabled"] = Value::Bool(read_manifest_catalog_policy(&data_home).network_enabled);
    status
}

#[tauri::command]
fn save_manifest_catalog_policy(network_enabled: bool) -> Result<Value, String> {
    let data_home = overview::data_home();
    write_manifest_catalog_policy(&data_home, &ManifestCatalogPolicy { network_enabled })?;
    Ok(serde_json::json!({ "status": "saved", "network_enabled": network_enabled }))
}

/// 手动检查官方 manifest 目录索引。请求只访问固定公共 HTTPS 地址，不携带
/// AGENT_VITALS_HOME、日志内容、会话或任何本地数据；下载/校验失败只写状态，
/// 已装 manifest 与缓存旧索引原样保留。payload 激活需要独立的显式确认
/// （扩展架构 §8.2），不在本命令内自动发生。
#[tauri::command]
async fn update_manifest_catalog() -> Result<Value, String> {
    let data_home = overview::data_home();
    let _update_guard = MANIFEST_CATALOG_UPDATE_LOCK.lock().await;
    let policy = read_manifest_catalog_policy(&data_home);
    if !policy.network_enabled {
        return Err("manifest 目录联网检查未开启；请先明确允许访问公共目录服务".into());
    }
    let now = agent_vitals_runtime::core::clock::now_ms();
    let mut status = read_manifest_catalog_status_for_update(&data_home)?;
    if status.next_check_at_ms.is_some_and(|next| now < next)
        || status
            .last_checked_at_ms
            .is_some_and(|last| now.saturating_sub(last) < MANIFEST_CATALOG_CHECK_INTERVAL_MS)
    {
        return Ok(serde_json::json!({ "status": "skipped", "reason": "check_window" }));
    }
    status.source_url = MANIFEST_CATALOG_INDEX_URL.into();
    status.last_checked_at_ms = Some(now);
    status.failure_reason = None;

    let client = match manifest_catalog_client() {
        Ok(client) => client,
        Err(error) => {
            return fail_manifest_catalog_update(&data_home, &mut status, "failed", format!("create manifest catalog client failed: {error}"))
        }
    };
    let mut response = match client.get(MANIFEST_CATALOG_INDEX_URL).send().await {
        Ok(response) => response,
        Err(error) => {
            return fail_manifest_catalog_update(&data_home, &mut status, "failed", format!("manifest catalog request failed: {error}"))
        }
    };
    if !response.status().is_success() {
        return fail_manifest_catalog_update(&data_home, &mut status, "failed", format!("manifest catalog returned HTTP {}", response.status()));
    }
    if response.content_length().is_some_and(|length| length > MANIFEST_CATALOG_INDEX_MAX_BYTES as u64) {
        return fail_manifest_catalog_update(&data_home, &mut status, "failed", "manifest catalog response exceeds 4 MiB limit".into());
    }
    let mut bytes = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if let Err(reason) = append_manifest_catalog_chunk(&mut bytes, &chunk) {
                    return fail_manifest_catalog_update(&data_home, &mut status, "failed", reason.into());
                }
            }
            Ok(None) => break,
            Err(error) => {
                return fail_manifest_catalog_update(&data_home, &mut status, "failed", format!("read manifest catalog response failed: {error}"))
            }
        }
    }
    let index = match agent_vitals_domain::domain::catalog_index::parse_catalog(&bytes) {
        Ok(index) => index,
        Err(reason) => return fail_manifest_catalog_update(&data_home, &mut status, "rejected", reason.into()),
    };
    use sha2::Digest;
    let index_sha256 = format!("{:x}", sha2::Sha256::digest(&bytes));
    let support = manifest_catalog_slot_support();
    let capabilities = agent_vitals_harnesses::generic_manifest::CapabilitySet::default();
    let highest = match accepted_manifest_catalog_floor(&data_home, &status, &support, &capabilities.app_version) {
        Ok(highest) => highest,
        Err(reason) => return fail_manifest_catalog_update(&data_home, &mut status, "rejected", reason),
    };
    let highest_ref = highest.as_ref().map(|(sequence, hash)| (*sequence, hash.as_str()));
    if let Err(reason) = agent_vitals_domain::domain::catalog_index::validate_catalog(
        &index,
        &support,
        &capabilities.app_version,
        &index_sha256,
        highest_ref,
    ) {
        return fail_manifest_catalog_update(&data_home, &mut status, "rejected", reason.into());
    }
    write_manifest_catalog_index_cache(&data_home, &bytes)?;
    let entry_count = index["entries"].as_array().map(|entries| entries.len());
    let supported_entries = index["entries"]
        .as_array()
        .map(|entries| entries.iter().filter(|entry| entry["slot_type"] == "harness_manifest").count());
    status.state = "ok".into();
    status.last_success_at_ms = Some(now);
    status.catalog_sequence = index["catalog_sequence"].as_u64();
    status.index_sha256 = Some(index_sha256);
    status.entry_count = entry_count;
    status.supported_entries = supported_entries;
    status.failure_count = 0;
    status.next_check_at_ms = Some(now.saturating_add(MANIFEST_CATALOG_CHECK_INTERVAL_MS));
    write_manifest_catalog_status(&data_home, &status)?;
    Ok(serde_json::json!({
        "status": "checked",
        "source_url": MANIFEST_CATALOG_INDEX_URL,
        "catalog_sequence": status.catalog_sequence,
        "entry_count": status.entry_count,
        "supported_entries": status.supported_entries,
        "activation": "payload 下载与激活确认需要显式确认命令（扩展架构 §8.2），本命令只拉取并缓存索引",
        "last_success_at_ms": now,
    }))
}

fn manifest_catalog_client() -> Result<reqwest::Client, reqwest::Error> {
    reqwest::Client::builder().timeout(std::time::Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none()).user_agent("agent-vitals-manifest-catalog-check/1")
        .build()
}

async fn fetch_official_manifest_bytes(client: &reqwest::Client, url: &str,
    limit: usize) -> Result<Vec<u8>, String> {
    let mut response = client.get(url).send().await.map_err(|e| format!("catalog request failed: {e}"))?;
    if !response.status().is_success() { return Err(format!("catalog returned HTTP {}", response.status())); }
    if response.content_length().is_some_and(|length| length > limit as u64) {
        return Err("catalog response bytes limit".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| format!("catalog response read failed: {e}"))? {
        if chunk.len() > limit.saturating_sub(bytes.len()) { return Err("catalog response bytes limit".into()); }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

/// Fetch the exact official dependency group and preview it. A matching confirm
/// hash repeats the fetch and local impact calculation before one ledger CAS.
#[tauri::command]
async fn install_manifest_catalog_harness(slug: String, release_local_pins: Vec<String>,
    confirm: Option<String>) -> Result<Value, String> {
    let _update_guard = MANIFEST_CATALOG_UPDATE_LOCK.lock().await;
    let data_home = overview::data_home();
    if !read_manifest_catalog_policy(&data_home).network_enabled {
        return Err("manifest 目录联网检查未开启；请先明确允许访问公共目录服务".into());
    }
    read_manifest_catalog_status_for_update(&data_home)?;
    match install_manifest_catalog_harness_internal(data_home.clone(), slug, release_local_pins, confirm).await {
        Ok(result) => Ok(result),
        Err(reason) => {
            let mut status = read_manifest_catalog_status_for_update(&data_home)?;
            status.last_checked_at_ms = Some(agent_vitals_runtime::core::clock::now_ms());
            fail_manifest_catalog_update(&data_home, &mut status, "failed", reason)
        }
    }
}

async fn install_manifest_catalog_harness_internal(data_home: PathBuf, slug: String,
    release_local_pins: Vec<String>, confirm: Option<String>) -> Result<Value, String> {
    use agent_vitals_runtime::ingest::vendor_manifest_install as vendor;
    use sha2::Digest;
    let client = manifest_catalog_client().map_err(|e| format!("create catalog client failed: {e}"))?;
    let download_deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(30);
    let index_bytes = tokio::time::timeout_at(download_deadline,
        fetch_official_manifest_bytes(&client, MANIFEST_CATALOG_INDEX_URL, MANIFEST_CATALOG_INDEX_MAX_BYTES))
        .await.map_err(|_| "catalog dependency group download timed out")??;
    let index = agent_vitals_domain::domain::catalog_index::parse_catalog(&index_bytes).map_err(str::to_string)?;
    let index_hash = format!("{:x}", sha2::Sha256::digest(&index_bytes));
    let mut status = read_manifest_catalog_status_for_update(&data_home)?;
    let support = manifest_catalog_slot_support();
    let capabilities = agent_vitals_harnesses::generic_manifest::CapabilitySet::default();
    let floor = accepted_manifest_catalog_floor(&data_home, &status, &support, &capabilities.app_version)?;
    agent_vitals_domain::domain::catalog_index::validate_catalog(&index, &support,
        &capabilities.app_version, &index_hash, floor.as_ref().map(|(seq, hash)| (*seq, hash.as_str())))
        .map_err(str::to_string)?;
    let entries = vendor::harness_dependency_group(&index_bytes, &slug)?;
    let mut payloads = std::collections::BTreeMap::new();
    let mut total = 0_usize;
    for entry in &entries {
        if !read_manifest_catalog_policy(&data_home).network_enabled {
            return Err("manifest 目录联网许可已撤销".into());
        }
        let url = vendor::official_payload_url(entry)?;
        let remaining = vendor::MAX_GROUP_BYTES.saturating_sub(total);
        let limit = agent_vitals_runtime::core::extension_objects::MAX_PAYLOAD_BYTES.min(remaining);
        let bytes = tokio::time::timeout_at(download_deadline, fetch_official_manifest_bytes(&client, &url, limit))
            .await.map_err(|_| "catalog dependency group download timed out")??;
        total += bytes.len();
        if entry["sha256"] != format!("{:x}", sha2::Sha256::digest(&bytes)) {
            return Err(format!("catalog payload hash mismatch: {}", entry["slot_id"]));
        }
        payloads.insert(entry["slot_id"].as_str().ok_or("catalog identity")?.to_string(), bytes);
    }
    // Persist the accepted index, never payloads in local override directories.
    write_manifest_catalog_index_cache(&data_home, &index_bytes)?;
    let now = agent_vitals_runtime::core::clock::now_ms();
    status.state = "ok".into();
    status.source_url = MANIFEST_CATALOG_INDEX_URL.into();
    status.last_checked_at_ms = Some(now);
    status.last_success_at_ms = Some(now);
    status.catalog_sequence = index["catalog_sequence"].as_u64();
    status.index_sha256 = Some(index_hash);
    status.entry_count = index["entries"].as_array().map(Vec::len);
    status.supported_entries = status.entry_count;
    status.failure_reason = None;
    status.failure_count = 0;
    status.next_check_at_ms = Some(now.saturating_add(MANIFEST_CATALOG_CHECK_INTERVAL_MS));
    write_manifest_catalog_status(&data_home, &status)?;
    let home = PathBuf::from(std::env::var("HOME").map_err(|_| "user home unavailable")?);
    let machine_namespace = agent_vitals_runtime::takeover::machine_namespace();
    tauri::async_runtime::spawn_blocking(move || vendor::install_official_harness_group(
        &index_bytes, &slug, &payloads, &release_local_pins, &machine_namespace,
        &data_home, &home, &[], confirm.as_deref()))
        .await.map_err(|e| format!("catalog installer task failed: {e}"))?
}

fn start_public_pricing_catalog_tick() {
    tauri::async_runtime::spawn(async {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(5 * 60)).await;
            let data_home = overview::data_home();
            if !read_pricing_catalog_policy(&data_home).network_enabled {
                continue;
            }
            let _ = update_public_pricing_catalog_internal(true).await;
        }
    });
}

/// 「发现」tab 新鲜度条的数据面（WORKBENCH_FINDINGS_TAB_SPEC §4.8）。
/// 只读一个数：上次成功同步时刻 + stale 执行环境名单（runtime 与 MCP envelope
/// 同源），DB 打不开就如实报 unavailable，不编一个空名单。
fn findings_freshness_state(report: &Value) -> &'static str {
    let Some(last) = report.get("last_successful_sync_at").and_then(Value::as_str) else {
        return "not_yet_synced";
    };
    if parse_rfc3339_secs(last).is_none() {
        return "unknown";
    }
    let Some(stale_harnesses) = report.get("stale_harnesses").and_then(Value::as_array) else {
        return "unknown";
    };
    if stale_harnesses.iter().any(|harness| !harness.is_string()) {
        return "unknown";
    }
    if !stale_harnesses.is_empty() {
        "stale"
    } else {
        "fresh"
    }
}

fn findings_safe_harness_label(value: &Value) -> String {
    let Some(harness) = value.as_str() else { return "generic".to_string(); };
    if let Some(slug) = harness.strip_prefix("harness:").or_else(|| harness.strip_prefix("plugin:")) {
        if agent_vitals_runtime::harness_registry::plugin_slug_ok(slug) {
            return harness.to_string();
        }
        return "generic".to_string();
    }
    if harness.len() <= 32 && !harness.is_empty() && harness.chars().all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '_' | '-')) {
        harness.to_string()
    } else {
        "generic".to_string()
    }
}

#[tauri::command]
fn findings_freshness() -> Value {
    let data_home = overview::data_home();
    let path = agent_vitals_data::authority::default_authority_path(&data_home);
    match agent_vitals_data::authority::AuthorityDb::open_readonly(&path) {
        Ok(db) => {
            let raw = agent_vitals_runtime::mcp::data_freshness_report(db.conn());
            let state = findings_freshness_state(&raw);
            let last = raw.get("last_successful_sync_at").cloned().unwrap_or(Value::Null);
            let stale_harnesses = raw.get("stale_harnesses").and_then(Value::as_array).map(|harnesses| harnesses.iter().map(findings_safe_harness_label).collect::<Vec<_>>()).unwrap_or_default();
            serde_json::json!({
                "status": "ok",
                "freshness": {"state": state, "last_successful_sync_at": last, "stale_harnesses": stale_harnesses, "syncing": false},
            })
        }
        Err(_) => serde_json::json!({ "status": "unavailable" }),
    }
}

/// v2 增补（REVIEW P1「诊断包 v2 增补：日志尾（脱敏）+ watcher 健康 + 事件
/// 计数快照」）：四段都是**聚合**，不是内部状态原样倒出去——watcher 健康本身
/// 就是闭集词表 + 计数（无路径无原始错误串，见 `WatcherHealth` 自身文档），
/// 日志尾经 `redact_path_like` 脱敏，事件总线只给计数（`event_deliveries.
/// last_error` 的具体文本不进来，只数「有没有」）。`ReadGate`/`ReadMemo`
/// 是导出那一瞬间的快照，`ReadMemo` 的 hits/misses 是进程启动以来的累计。
fn diagnostic_observability_snapshot(app: &AppHandle) -> Value {
    let log_tail = agent_vitals_runtime::logging::read_redacted_tail(
        agent_vitals_runtime::logging::DIAGNOSTIC_TAIL_MAX_LINES,
    );
    let watcher_health = {
        let supervisor = app.state::<WatcherSupervisor>();
        let guard = supervisor.0.lock().unwrap_or_else(|e| e.into_inner());
        guard.as_ref().map(|w| w.health())
    };
    let watcher_health_json = watcher_health.map(|h| serde_json::json!({
        "mode": watcher_mode_str(h.mode),
        "topology_revision": h.topology_revision,
        "facts_roots_attached": h.facts_roots_attached,
        "cache_roots_attached": h.cache_roots_attached,
        "pending_roots": h.pending_roots,
        "coalesced_wake_count": h.coalesced_wake_count,
        "reason_code": h.reason_code,
    })).unwrap_or(Value::Null);
    let cooldown = app.state::<WatcherCooldownOverride>().get();
    let gate = heavy_read_gate().stats();
    let memo = agent_vitals_runtime::query::read_memo::ReadMemo::global().stats();
    serde_json::json!({
        "log_tail": log_tail,
        "log_tail_lines": log_tail.len(),
        "log_tail_max_lines": agent_vitals_runtime::logging::DIAGNOSTIC_TAIL_MAX_LINES,
        "watcher_health": watcher_health_json,
        "watcher_cooldown_ms": cooldown.as_millis() as u64,
        "watcher_cooldown_is_throttled": cooldown > agent_vitals_runtime::ingest::watch::WATCHER_SYNC_COOLDOWN,
        "read_gate": { "permits": gate.permits, "held": gate.held, "waiting": gate.waiting },
        "read_memo": { "hits": memo.hits, "misses": memo.misses, "entries": memo.entries },
        "event_bus": event_bus_backlog_snapshot(&overview::data_home()),
    })
}

/// 事件总线积压：outbox 总行数 / deliveries 总行数 / 带 `last_error` 的
/// deliveries 行数——只数不读内容。库缺席（未同步机器）不是错误，报
/// `unavailable`，不编造零。`data_home` 是参数而非读全局——纯粹为可测试性：
/// 注入一个临时目录，不需要碰 `AGENT_VITALS_HOME` 环境变量、不需要新增一把
/// 跨测试序列化锁（这个文件里其余测试都读真机 data_home，貌似没人当心过
/// 并行测试互相踩环境变量，这个函数选择不加入那个赌注）。
fn event_bus_backlog_snapshot(data_home: &Path) -> Value {
    let path = agent_vitals_data::authority::default_authority_path(data_home);
    let Ok(db) = agent_vitals_data::authority::AuthorityDb::open_readonly(&path) else {
        return serde_json::json!({ "status": "unavailable" });
    };
    let outbox_rows: i64 = db.conn()
        .query_row("SELECT COUNT(*) FROM event_outbox", [], |r| r.get(0))
        .unwrap_or(0);
    let delivery_rows: i64 = db.conn()
        .query_row("SELECT COUNT(*) FROM event_deliveries", [], |r| r.get(0))
        .unwrap_or(0);
    let delivery_rows_with_last_error: i64 = db.conn()
        .query_row("SELECT COUNT(*) FROM event_deliveries WHERE last_error IS NOT NULL", [], |r| r.get(0))
        .unwrap_or(0);
    serde_json::json!({
        "status": "ok",
        "outbox_rows": outbox_rows,
        "delivery_rows": delivery_rows,
        "delivery_rows_with_last_error": delivery_rows_with_last_error,
    })
}

/// `data_status()` 报告里的价目表版本号——独立抽成纯函数是因为它 2026-09-22
/// 真机验收才被抓出来错过一次：`data_status.data.pricing` 的字段是
/// `latest_version`（`data_status.rs:712`），这里曾经读的是不存在的
/// `version`，逐次返回 `null`，`export_diagnostic_package` 本体因原生文件
/// 对话框没法无头跑，组成它的聚合函数（`data_status` 自己）各自测过，唯独
/// 这行字段抽取的胶水代码从没被单测覆盖过。
fn diagnostic_pricing_version(status: &Value) -> Value {
    status.get("data")
        .and_then(|data| data.get("pricing"))
        .and_then(|pricing| pricing.get("latest_version"))
        .cloned()
        .unwrap_or(Value::Null)
}

/// 生成用户主动选择保存的脱敏诊断包。只组合现有的状态 DTO + v2 的可观测性
/// 聚合（日志尾/watcher 健康/事件总线积压/读侧缓存命中率）；不读取会话正文、
/// 原始日志（日志尾经脱敏投影，不是原文）、账户标识，也不执行上传。取消
/// 保存对用户来说是 no-op。
#[tauri::command]
fn export_diagnostic_package(app: AppHandle) -> Result<Value, String> {
    let Some(path) = rfd::FileDialog::new()
        .set_file_name("agent-vitals-diagnostics.json")
        .save_file() else {
        return Ok(serde_json::json!({ "status": "cancelled" }));
    };
    let status = data_status();
    let package = serde_json::json!({
        "diagnostic_contract": "agent-vitals-diagnostic/v2",
        "versions": {
            "app": env!("CARGO_PKG_VERSION"),
            "cli": resolved_cli_version(),
            "engine": agent_vitals_domain::session_key::ENGINE_VERSION,
            "architecture": std::env::consts::ARCH,
            "authority_schema": agent_vitals_data::authority::SCHEMA_VERSION,
            "query_envelope": agent_vitals_runtime::mcp::ENVELOPE_SCHEMA_VERSION,
            "statistics_timezone": agent_vitals_runtime::clock::statistics_timezone_name(),
            "pricing": diagnostic_pricing_version(&status),
        },
        "privacy": {
            "contains_session_content": false,
            "contains_absolute_paths": false,
            "contains_account_identifiers": false,
            "upload_performed": false,
            // v2 新增字段：日志尾是脱敏投影，不是原始文件内容——本地那份
            // app.log 允许含路径（2026-09-19 政策：不出机器），这里导出的
            // 不是它，是经 `redact_path_like` 处理过的版本。
            "log_tail_is_redacted_projection": true,
        },
        "data_status": status,
        "source_status": data_source_status(),
        "sync_pause": sync_pause_state(),
        "retention": retention_config(),
        "budget": budget_config(),
        "budget_profiles": budget_profiles_status(overview::current_month_beijing()),
        "observability": diagnostic_observability_snapshot(&app),
    });
    let bytes = serde_json::to_vec_pretty(&package)
        .map_err(|error| format!("diagnostic serialization failed: {error}"))?;
    std::fs::write(&path, bytes)
        .map_err(|error| format!("diagnostic write failed: {error}"))?;
    Ok(serde_json::json!({
        "status": "saved",
        "path": path.to_string_lossy(),
        "upload_performed": false,
    }))
}

#[tauri::command(async)]
fn about_diagnostics() -> Value {
    let data_home = overview::data_home();
    let authority_path = agent_vitals_data::authority::default_authority_path(&data_home);
    let pricing = agent_vitals_data::authority::AuthorityDb::open_readonly(&authority_path)
        .ok()
        .and_then(|db| db.pricing_snapshot_latest().ok().flatten())
        .map(|(version, captured_at_ms)| serde_json::json!({
            "version": version,
            "captured_at_ms": captured_at_ms,
        }));
    serde_json::json!({
        "status": "ok",
        "app_version": env!("CARGO_PKG_VERSION"),
        "cli_version": resolved_cli_version(),
        "engine_version": agent_vitals_domain::session_key::ENGINE_VERSION,
        "architecture": std::env::consts::ARCH,
        "authority_schema": agent_vitals_data::authority::SCHEMA_VERSION,
        "statistics_timezone": agent_vitals_runtime::clock::statistics_timezone_name(),
        "pricing": pricing,
        "pricing_update": read_pricing_catalog_status(&data_home),
        // 只要 last-sync.json 这一份状态，不必为它把整份 overview 重算一遍
        // （read_overview 会跑 SQL bundle + 预算 profile 聚合，≈130–360ms）。
        "sync": overview::load_sync_status(&data_home),
    })
}

use update_check::{
    classify_releases_http, resolve_open_url, ReleasesHttpClass, SelectOutcome, TRUSTED_RELEASES_URL,
};

/// 应用内版本检查：拉取 `/releases` 列表（`/releases/latest` 会跳过 prerelease，
/// beta 用户因此永远收不到下一个 beta），再由 `update_check::select_update`
/// 按通道与 semver 选候选。只报告、不下载、不安装（automatic_install 恒为 false）。
/// 列表为空 / 404 / 无 app-v → no_release；真限流（429，或 403 且 remaining=0 /
/// Retry-After）→ unavailable/rate_limited；其它 403 → unavailable/forbidden。
/// 正式版用户面对「只有 beta」时是 ok + on_latest_stable，不是 no_release。
/// 这些都不当作错误弹给用户。CARGO_PKG_VERSION 由 Cargo 保证是 semver。
#[tauri::command]
async fn check_for_updates() -> Result<Value, String> {
    let current_version = env!("CARGO_PKG_VERSION");
    let current = semver::Version::parse(current_version)
        .expect("CARGO_PKG_VERSION is Cargo-enforced semver");
    let unavailable = |reason: &str| {
        serde_json::json!({
            "status": "unavailable",
            "reason": reason,
            "current_version": current_version,
            "release_url": TRUSTED_RELEASES_URL,
            "automatic_install": false,
        })
    };
    let no_release = || {
        serde_json::json!({
            "status": "no_release",
            "current_version": current_version,
            "release_url": TRUSTED_RELEASES_URL,
            "automatic_install": false,
        })
    };
    let client = reqwest::Client::builder()
        .user_agent(format!("agent-vitals/{current_version}"))
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|error| format!("build update client failed: {error}"))?;
    let response = client
        .get(update_check::RELEASES_API)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .map_err(|error| format!("check updates failed: {error}"))?;
    let remaining = response
        .headers()
        .get("x-ratelimit-remaining")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let retry_after = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let status = response.status();
    match classify_releases_http(
        status.as_u16(),
        remaining.as_deref(),
        retry_after.as_deref(),
    ) {
        ReleasesHttpClass::Ok => {}
        ReleasesHttpClass::NotFound => return Ok(no_release()),
        ReleasesHttpClass::RateLimited => return Ok(unavailable("rate_limited")),
        ReleasesHttpClass::Forbidden => return Ok(unavailable("forbidden")),
        ReleasesHttpClass::Other => {
            return Err(format!("check updates returned HTTP {status}"));
        }
    }
    let payload: Value = response
        .json()
        .await
        .map_err(|error| format!("parse update response failed: {error}"))?;
    Ok(match update_check::select_update(&current, &payload) {
        SelectOutcome::Selected(selection) => serde_json::json!({
            "status": "ok",
            "current_version": current_version,
            "latest_tag": selection.latest.tag,
            "update_available": selection.update_available,
            "release_url": selection.latest.release_url,
            "automatic_install": false,
        }),
        SelectOutcome::OnLatestStable => serde_json::json!({
            "status": "ok",
            "current_version": current_version,
            "update_available": false,
            "reason": "on_latest_stable",
            "release_url": TRUSTED_RELEASES_URL,
            "automatic_install": false,
        }),
        SelectOutcome::None => no_release(),
    })
}

/// 只打开可信发布根，或检查结果里已经过 `resolve_open_url` 校验的 tag 页。
/// 前端传入的 `url` 不可信：命令侧会再校验一遍，非法值回落到根。
#[tauri::command]
fn open_trusted_releases_page(url: Option<String>) -> Result<Value, String> {
    let target = resolve_open_url(url.as_deref());
    #[cfg(target_os = "macos")]
    let status = std::process::Command::new("open")
        .arg(&target)
        .status()
        .map_err(|e| format!("open trusted releases page failed: {e}"))?;
    #[cfg(target_os = "linux")]
    let status = std::process::Command::new("xdg-open")
        .arg(&target)
        .status()
        .map_err(|e| format!("open trusted releases page failed: {e}"))?;
    #[cfg(target_os = "windows")]
    let status = std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", target.as_str()])
        .status()
        .map_err(|e| format!("open trusted releases page failed: {e}"))?;
    if !status.success() {
        return Err(format!("open trusted releases page exited with {status}"));
    }
    Ok(serde_json::json!({
        "status": "opened",
        "url": target,
        "automatic_install": false,
    }))
}

#[tauri::command(async)]
fn budget_config() -> Value {
    let data_home = overview::data_home();
    let path = agent_vitals_data::authority::default_authority_path(&data_home);
    let Ok(db) = agent_vitals_data::authority::AuthorityDb::open_readonly(&path) else {
        return serde_json::json!({ "status": "unavailable" });
    };
    match db.budget_config_get() {
        Ok(Some(config)) => serde_json::json!({
            "status": "ok",
            "monthly_cny_minor": config.monthly_cny_minor,
            "daily_cny_minor": config.daily_cny_minor,
            "warning_ratio_bp": config.warning_ratio_bp,
            "updated_at_ms": config.updated_at_ms,
            "origin": agent_vitals_runtime::budget::budget_config_origin(&data_home),
        }),
        Ok(None) => serde_json::json!({ "status": "missing" }),
        Err(error) => serde_json::json!({ "status": "unavailable", "reason": error.to_string() }),
    }
}

#[tauri::command(async)]
fn budget_profiles_status(month: String) -> Value {
    agent_vitals_runtime::budget::budget_profiles_status_sql_at(
        &overview::data_home(), &month,
    ).unwrap_or_else(|| serde_json::json!({
        "status": "unavailable", "reason": "budget profile status unavailable",
    }))
}

#[tauri::command]
fn save_budget_profile(app: AppHandle, input: BudgetProfileInput) -> Result<Value, String> {
    let data_home = overview::data_home();
    let path = agent_vitals_data::authority::default_authority_path(&data_home);
    let now_ms = agent_vitals_runtime::sql_sync::now_ms();
    let db = agent_vitals_data::authority::AuthorityDb::open(&path, now_ms)
        .map_err(|error| error.to_string())?;
    db.budget_profile_set(
        &input.profile_id, &input.currency, input.monthly_minor,
        input.daily_minor, input.warning_ratio_bp, now_ms,
    ).map_err(|error| error.to_string())?;
    let notification_permission = app.notification().request_permission()
        .map(|state| format!("{state:?}"))
        .unwrap_or_else(|error| format!("unavailable: {error}"));
    Ok(serde_json::json!({
        "status": "saved", "profile_id": input.profile_id, "currency": input.currency,
        "notification_permission": notification_permission,
    }))
}

/// Clear the user-owned estimate budget. This is intentionally a delete rather
/// than a zero-value profile: the schema requires positive limits, and an
/// absent profile is the explicit "not configured" state. Usage history and
/// the separately-owned confirmed profile remain untouched.
#[tauri::command]
fn disable_budget_profile() -> Result<Value, String> {
    let data_home = overview::data_home();
    let path = agent_vitals_data::authority::default_authority_path(&data_home);
    let now_ms = agent_vitals_runtime::sql_sync::now_ms();
    let db = agent_vitals_data::authority::AuthorityDb::open(&path, now_ms)
        .map_err(|error| error.to_string())?;
    let changed = db.budget_profile_delete("estimate")
        .map_err(|error| error.to_string())?;
    Ok(serde_json::json!({ "status": "disabled", "profile_id": "estimate", "changed": changed }))
}

#[tauri::command]
fn save_budget_config(app: AppHandle, input: BudgetConfigInput) -> Result<Value, String> {
    if input.monthly_cny_minor < 0 || input.daily_cny_minor < 0
        || !(0..=10_000).contains(&input.warning_ratio_bp)
    {
        return Err("budget amounts must be non-negative and warning ratio must be 0..=10000".to_string());
    }
    let data_home = overview::data_home();
    let path = agent_vitals_data::authority::default_authority_path(&data_home);
    let now_ms = agent_vitals_runtime::sql_sync::now_ms();
    let db = agent_vitals_data::authority::AuthorityDb::open(&path, now_ms)
        .map_err(|error| error.to_string())?;
    db.budget_config_set(
        input.monthly_cny_minor, input.daily_cny_minor, input.warning_ratio_bp, now_ms,
    ).map_err(|error| error.to_string())?;
    let origin_recorded = agent_vitals_runtime::budget::mark_budget_config_user_owned(&data_home).is_ok();
    // 预算金额均为 0 表示明确停用兼容预算；停用时不应触发 macOS
    // 通知权限请求。只有用户真正启用至少一个预算周期时才申请权限（REQ-039）。
    let notification_permission = budget_notifications_enabled(
        input.monthly_cny_minor, input.daily_cny_minor,
    ).then(|| app.notification().request_permission()
        .map(|state| format!("{state:?}"))
        .unwrap_or_else(|error| format!("unavailable: {error}")));
    Ok(serde_json::json!({
        "status": "saved", "updated_at_ms": now_ms,
        "origin": "user", "origin_recorded": origin_recorded,
        "notification_permission": notification_permission,
    }))
}

fn budget_notifications_enabled(monthly_minor: i64, daily_minor: i64) -> bool {
    monthly_minor > 0 || daily_minor > 0
}

#[tauri::command]
fn snooze_budget_until(until_ms: i64) -> Result<Value, String> {
    let now_ms = agent_vitals_runtime::sql_sync::now_ms();
    if until_ms <= now_ms {
        return Err("budget snooze must end in the future".to_string());
    }
    let data_home = overview::data_home();
    let path = agent_vitals_data::authority::default_authority_path(&data_home);
    let db = agent_vitals_data::authority::AuthorityDb::open(&path, now_ms)
        .map_err(|error| error.to_string())?;
    db.budget_snooze_set(until_ms, now_ms)
        .map_err(|error| error.to_string())?;
    Ok(serde_json::json!({ "status": "snoozed", "until_ms": until_ms }))
}

fn budget_period_end_ms_for_month(month: &str) -> Option<i64> {
    let mut parts = month.split('-');
    let year: i64 = parts.next()?.parse().ok()?;
    let month_number: u32 = parts.next()?.parse().ok()?;
    if parts.next().is_some() || !(1..=12).contains(&month_number) {
        return None;
    }
    let (next_year, next_month) = if month_number == 12 {
        (year + 1, 1)
    } else {
        (year, month_number + 1)
    };
    // 预算周期按系统统计时区自然月；由 authority query 生成下月一日的
    // 民历午夜，自动处理 DST 的 23/25 小时自然日。
    let next_month_key = format!("{next_year:04}-{next_month:02}");
    agent_vitals_data::authority_query::beijing_month_bounds_ms(&next_month_key)
        .map(|(start_ms, _)| start_ms)
}

#[tauri::command]
fn snooze_budget_current_period() -> Result<Value, String> {
    let now_ms = agent_vitals_runtime::sql_sync::now_ms();
    let month = overview::current_month_beijing();
    let until_ms = budget_period_end_ms_for_month(&month)
        .ok_or_else(|| format!("invalid current budget month: {month}"))?;
    if until_ms <= now_ms {
        return Err("current budget period has already ended".to_string());
    }
    snooze_budget_until(until_ms)
}

/// 补卡表单的「按原厂官方价预填」：**原样返回官方卡的报价币种与价格，不做任何换算**。
/// 表单据此把币种定为官方币种，并在与所选服务商的报价币种不一致时拒绝预填（保存时后端
/// `save_card_checked` 也会再拒绝一次）。曾经对非 CNY 卡一律拒绝，导致 Anthropic 等 USD 服务商永远预填不了。
#[tauri::command]
fn official_price_card(provider_id: String, model_id: String) -> Value {
    let pricing = agent_vitals_runtime::price_overrides::merged_main(&overview::data_home());
    let preferred = agent_vitals_domain::cost::canonical_provider_id(&provider_id, &pricing);
    let Some((from_provider, key, currency, six)) = agent_vitals_domain::cost::official_card_body(
        &model_id, &pricing, (!preferred.is_empty()).then_some(preferred.as_str()),
    ) else {
        return serde_json::json!({ "found": false });
    };
    serde_json::json!({
        "found": true, "provider": from_provider, "card_key": key, "rates": six,
        "currency": currency,
    })
}

/// 设置 › MCP 子板块的数据：本机 CLI 路径（与托盘同步用的是同一份解析，
/// `resolve_binary`）、版本、可用工具清单（直接从运行时的 `tool_specs()` 取——
/// 页面上的清单不能是手抄的第二份）。CLI 找不到 → `cli_path: null`，页面照实说
/// 「未找到」而不是给一条不存在的路径。
#[tauri::command]
fn mcp_setup_info() -> Value {
    let cli_path = resolve_binary().map(|p| p.display().to_string());
    let tools = agent_vitals_runtime::mcp::tool_specs().into_iter().map(|t| serde_json::json!({
        "name": t.name,
        "description": t.description,
    })).collect::<Vec<_>>();
    serde_json::json!({
        "cli_path": cli_path,
        "cli_version": resolved_cli_version(),
        "data_home": overview::data_home().display().to_string(),
        "tools": tools,
    })
}

/// 设置 › MCP 的可下载 Agent Skill（`SKILL.md`）：接入命令 + 诚实规则 + 工具清单
/// （运行时 `tool_specs()`，不手抄）+ 常用任务。同一份文本也给「复制全部」用——
/// 用户把它贴给 Agent 或装成 skill，两条路一个来源。
fn mcp_skill_markdown() -> String {
    let bin = resolve_binary().map(|p| p.display().to_string()).unwrap_or_else(|| "/path/to/agent-vitals".to_string());
    let shell_bin = if bin.contains(' ') { format!("\"{bin}\"") } else { bin.clone() };
    let tools = agent_vitals_runtime::mcp::tool_specs().into_iter().map(|t| {
        let first = t.description.split(". ").next().unwrap_or(t.description).trim_end_matches('.');
        format!("- `{}` — {first}.", t.name)
    }).collect::<Vec<_>>().join("\n");
    format!(r#"---
name: agent-vitals-mcp
description: Query the user's local Oh Agent data over MCP — AI tool token usage, spend (bills vs subscriptions vs estimates), budgets, billing attribution, missing price cards, sessions and data quality. Use when the user asks how much they spent on AI coding tools, which provider or model costs most, whether a budget is exceeded, what usage is still unattributed or unpriced, or asks you to fill in price cards. 查询本机 Oh Agent 的用量、花费、预算、归因与价卡；用户问「这个月 AI 工具花了多少」「哪家最贵」「预算超了没」「哪些用量还没归因/没价卡」「帮我补价卡」时使用。
---

# Oh Agent MCP

Oh Agent runs on the user's machine and reads their AI coding tools' session logs (Claude Code, Codex, DeepSeek Harness, WorkBuddy) into a local SQLite authority. This skill talks to it over MCP. The server is local, zero-network, read-only by default.

## Setup (once)

Claude Code:

```bash
claude mcp add agent-vitals -- {shell_bin} data-mcp serve --allow-local-writes
```

Codex CLI (`~/.codex/config.toml`):

```toml
[mcp_servers.agent-vitals]
command = "{bin}"
args = ["data-mcp", "serve", "--allow-local-writes"]
```

Any MCP client (`mcpServers` JSON):

```json
{{ "mcpServers": {{ "agent-vitals": {{ "command": "{bin}", "args": ["data-mcp", "serve", "--allow-local-writes"] }} }} }}
```

Drop `--allow-local-writes` for a strictly read-only server. With it, the only writes are typed local actions (price cards, billing declarations, budget settings, source controls, city building model overrides) — never SQL, never files, never URLs.

## Ground rules — keep the numbers honest

1. **Three kinds of money, never merged.** `metered_actual` / `harness_billed` = real bills; `fixed_subscription` = declared monthly fees; `metered_estimate` / `metered_declared` = price card × tokens. Carry the `≈` / "estimate" label into your answer. Never call an estimate a bill.
2. **Currencies are never added.** Report CNY and USD side by side. Only the overview's `metered_view` may show a converted `≈` figure, and it says so.
3. **Gaps are gaps, not zero.** `unresolved`, `unpriced_tokens`, `has_unresolved`, `coverage.partial` mean "unknown". Say so; do not fill with 0.
4. **Never invent prices.** `price_cards.card_put` only with a real source (a pricing page URL or the user's own statement) recorded in `source`. If you cannot find a price, skip that model and say so.
5. **Do not read the user's logs or database yourself.** The server already did; everything you need is a tool call. Never suggest SQL or file access.
6. **Attribution is the user's decision.** `billing_workflow` declarations change what counts as subscription-covered; propose, show the impact preview, and let the user confirm.

## Tools

{tools}

Every response is an envelope with `data`, `coverage`, `freshness` and `warnings`; read `coverage`/`freshness` before quoting a number as current.

## Common tasks

**Monthly spend review** — `control_plane` `monthly_summary` (by provider: subscription fees, metered estimates, unresolved) + `cost_breakdown` for the split; call out the largest line and which lines are estimates. Then `budget_profiles` for budget status (spent = metered three-tier view + subscription fees amortised by day).

**Fill missing price cards** — `price_cards` `missing_list`; for each row with `covered=false`, look up that provider's official price for the model (input / cached input / output, per million tokens, in the provider's settlement currency); `card_put` with `source`. Rows with `covered=true` are inside a subscription and only affect the nominal reference — mention, don't chase.

**Data health** — `data_status` (sync, integrity, `unresolved_tokens_month`, `unpriced_metered_tokens_month`) + `data_quality_issues`; list what needs the user's hand, most valuable first.

**Session drill-down** — `sessions_search` (window / harness / model) → `session_detail` / `session_trace` by `session_ref`. Never ask for or echo native session ids or paths.

**Edit one Agent City session building** — `sessions_search` → `get_building` with that `session_ref` (or the `ca_…` `asset_ref`) → `preview_building`. `data.ok` is not design approval: if `data.warnings` is non-empty, show every warning (massing/additive) and do not set until the user accepts or you redesign inside the current mass. Only then `set_building_model` with `expected_revision`. Confirm via returned `revision` + `build_event_id`. `reset_building` restores the default. Mutations need `--allow-local-writes`. On failure read structured `data.error` (`validation` vs `conflict`, including `disconnected_part` / `massing_drift`); do not depend on screenshots. An open City window plays the construction animation from the host event.

**Hourly pattern** — `usage_hourly` for one day (tokens only; cost per hour lives in `cost_breakdown`).

## Install this file as a skill

- Claude Code: save as `~/.claude/skills/agent-vitals-mcp/SKILL.md`.
- Codex: save as `~/.codex/skills/agent-vitals-mcp/SKILL.md`.
- Other harnesses: any skills directory that reads `SKILL.md` frontmatter.

安装后把上面的 MCP 接入命令执行一次即可；skill 只负责教 Agent 怎么用这些工具、怎么诚实地说数字。
"#, shell_bin = shell_bin, bin = bin, tools = tools)
}

/// 「复制全部」用：整份 skill 文本。
#[tauri::command]
fn mcp_skill_text() -> String {
    mcp_skill_markdown()
}

/// 「下载 SKILL.md」：系统保存对话框，默认文件名 SKILL.md。取消 → cancelled。
#[tauri::command]
fn export_mcp_skill() -> Result<Value, String> {
    let Some(path) = rfd::FileDialog::new()
        .set_file_name("SKILL.md")
        .save_file() else {
        return Ok(serde_json::json!({ "status": "cancelled" }));
    };
    std::fs::write(&path, mcp_skill_markdown()).map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "status": "saved", "file_name": path.file_name().map(|f| f.to_string_lossy().to_string()) }))
}

#[tauri::command]
fn clear_budget_snooze() -> Result<Value, String> {
    let data_home = overview::data_home();
    let path = agent_vitals_data::authority::default_authority_path(&data_home);
    let db = agent_vitals_data::authority::AuthorityDb::open(
        &path, agent_vitals_runtime::sql_sync::now_ms(),
    ).map_err(|error| error.to_string())?;
    db.budget_snooze_clear().map_err(|error| error.to_string())?;
    Ok(serde_json::json!({ "status": "cleared" }))
}

/// 桌面端声明的 Beta 范围纪律（计费主链规格 §5.4 / B3；2026-09-16 按产品决策
/// 放开结束日期）。数据层 `billing_declaration_revision_save` 故意保持通用（内部
/// MCP 仍可写开放期），这里是用户面：`unknown` 不是声明；`effective_start` 必填且
/// 不晚于今天（北京时间）；`effective_end` **选填**——留空表示「持续有效」（按量
/// 充值 / 长期付费没有结束日），填了则必须不早于起始、不晚于今天。
///
/// 留空在这里为什么不再需要堵（规格 §3 事实 3 担心的"一次 retry 把之后同步进来的
/// 事实扫进订阅覆盖"）：归因只在重算 COMMIT 时按当时存在的事实写入，而成功任务
/// 是终态（`UNIQUE(revision_id)`，`billing_recalculation_retry` 只收 failed /
/// cancelled），没有任何周期性重跑——所以留空只是「这个关系还没结束」的记录，
/// 不是「自动扩展到未来」的开关。真是那条路径要重建，属于独立的决定。
fn validate_desktop_declaration(
    relationship_kind: &str, effective_start: &str, effective_end: Option<&str>,
) -> Result<(), String> {
    if relationship_kind == "unknown" {
        return Err("\"unknown\" is not a billing declaration; keep the group pending instead".to_string());
    }
    let start_date = agent_vitals_data::authority::billing_boundary_date(effective_start, false)
        .ok_or_else(|| "effective_start must be YYYY-MM-DD (YYYY-MM is accepted for legacy data)".to_string())?;
    // 空串与 None 同义：前端把清空的日期输入框发成 null，但脚本/历史调用可能发 ""。
    let Some(end) = effective_end.map(str::trim).filter(|end| !end.is_empty()) else {
        return Ok(());
    };
    let end_date = agent_vitals_data::authority::billing_boundary_date(end, true)
        .ok_or_else(|| "effective_end must be YYYY-MM-DD (YYYY-MM is accepted for legacy data)".to_string())?;
    if end_date < start_date {
        return Err("effective_end must not be earlier than effective_start".to_string());
    }
    let today = overview::today_beijing();
    if end_date > today {
        return Err("effective_end must not be later than today (Beijing date)".to_string());
    }
    Ok(())
}

/// 保存一条可追溯的计费关系修订。声明当前态与不可变修订在同一个用户动作中
/// 写入；scope 由前端显式传入，空数组表示只使用执行环境/provider/有效期约束。
/// 官方订阅在保存成功后立即入队重算并返回 `job`——「保存」与「应用」曾是
/// 两次点击，只保存不应用会留下声明已存在、数字未变、待处理也不显示的半状态
/// （规格 G6）。入队失败不回滚修订（修订是不可变事实），回执如实带出。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn save_billing_declaration_revision(
    revision_id: String,
    declaration_id: String,
    supersedes_revision_id: Option<String>,
    provider_id: String,
    relationship_kind: String,
    subscription_name: Option<String>,
    amount_minor: Option<i64>,
    currency: Option<String>,
    effective_start: String,
    effective_end: Option<String>,
    source_candidate_id: Option<String>,
    evidence_ref: Option<String>,
    scopes: Vec<BillingScopeInput>,
) -> Result<Value, String> {
    validate_desktop_declaration(
        &relationship_kind, &effective_start, effective_end.as_deref(),
    )?;
    // 计费方归一到目录 id：程序判定给的是端点主机名（`shengsuanyun.com`），目录是
    // `shengsuanyun`——两种拼法各存一份就是两个 provider，价卡永远对不上后者
    // （2026-09-16 真机 9 条重复声明里两种拼法混存）。
    let provider_id = agent_vitals_domain::cost::canonical_provider_id(
        &provider_id, &agent_vitals_domain::cost::load_pricing(),
    );
    let data_home = overview::data_home();
    let path = agent_vitals_data::authority::default_authority_path(&data_home);
    let db = agent_vitals_data::authority::AuthorityDb::open(
        &path, agent_vitals_runtime::sql_sync::now_ms(),
    ).map_err(|error| error.to_string())?;
    let now_ms = agent_vitals_runtime::sql_sync::now_ms();
    let scope_refs = scopes.iter()
        .map(|scope| (scope.scope_kind.as_str(), scope.scope_value.as_str()))
        .collect::<Vec<_>>();
    let changed = db.billing_declaration_revision_save(
        &revision_id, &declaration_id, supersedes_revision_id.as_deref(),
        &provider_id, &relationship_kind, subscription_name.as_deref(),
        amount_minor, currency.as_deref(), &effective_start, effective_end.as_deref(),
        source_candidate_id.as_deref(), evidence_ref.as_deref(), &scope_refs, now_ms,
    ).map_err(|error| error.to_string())?;
    // 重复保存守卫命中：内容与某条现行声明完全一致，没有新建修订——没有可入队重算的对象，回执如实说明。
    if !changed && !db.billing_declaration_revisions(&declaration_id)
        .map(|revisions| revisions.iter().any(|revision| revision.0 == revision_id)).unwrap_or(false)
    {
        return Ok(serde_json::json!({
            "status": "saved", "revision_id": revision_id, "declaration_id": declaration_id,
            "changed": false, "duplicate": true, "job": Value::Null,
        }));
    }
    // **所有关系种类都入队重算**（2026-09-16 放开，此前只有官方订阅）。非订阅关系的
    // 重算写 `user_declared` 归因行——金额排除谓词不认它（D02：不改金额），但待确认
    // 组的谓词认它：确认经中转/按量/组织后，那组事实标成"已回答"、行从待确认关掉。
    // 不入队的后果是真机踩过的：third_party 声明存下了，可没有任何东西消费它，
    // 行永远留在待确认里（axis 规格 F6 的发作面）。
    let job = {
        let job_id = format!("billing-{revision_id}");
        match db.billing_recalculation_enqueue(&job_id, &declaration_id, &revision_id, now_ms) {
            Ok(queued) => {
                drop(db);
                if queued {
                    spawn_billing_recalculation_worker(path, job_id.clone());
                }
                serde_json::json!({ "job_id": job_id, "status": "queued", "changed": queued })
            }
            Err(error) => serde_json::json!({
                "job_id": job_id, "status": "enqueue_failed", "error": error.to_string(),
            }),
        }
    };
    Ok(serde_json::json!({
        "status": "saved", "revision_id": revision_id,
        "declaration_id": declaration_id, "changed": changed, "job": job,
    }))
}

/// 读取当前仍有效的计费声明；修订历史由影响预览和重算回执继续追踪。
///
/// 经 memo（RUNTIME_INVALIDATION spec §5.1）：无查询参数，`params` 恒为 `""`；
/// N+1（每条声明再查 revisions/scopes）的成本只在 revision 前进时付一次。
#[tauri::command(async)]
fn billing_declarations() -> Value {
    let data_home = overview::data_home();
    let path = agent_vitals_data::authority::default_authority_path(&data_home);
    let Ok(db) = agent_vitals_data::authority::AuthorityDb::open_readonly(&path) else {
        return serde_json::json!({ "status": "unavailable", "declarations": [] });
    };
    let value = match agent_vitals_runtime::query::read_memo::ReadVersion::observe(Some(&db), &data_home) {
        Some(version) => agent_vitals_runtime::query::read_memo::ReadMemo::global().get_or_compute(
            "billing_declarations", &data_home, "", &version,
            || billing_declarations_value(&db),
        ),
        None => std::sync::Arc::new(billing_declarations_value(&db)),
    };
    serde_json::Value::clone(&value)
}

fn billing_declarations_value(db: &agent_vitals_data::authority::AuthorityDb) -> Value {
    match db.billing_declarations() {
        Ok(rows) => serde_json::json!({ "status": "ok", "declarations": rows.into_iter().map(|row| {
            let (declaration_id, provider_id, relationship_kind, subscription_name,
                amount_minor, currency, effective_start, effective_end, source_candidate_id) = row;
            let current_revision_id = db.billing_declaration_revisions(&declaration_id)
                .ok().and_then(|revisions| revisions.last().map(|revision| revision.0.clone()));
            // 当前修订的作用域：修改订阅必须原样带回，否则修订会悄悄把声明范围
            // 从"这几个模型"放宽成"该服务商全部模型"（B13）。
            let scopes = current_revision_id.as_deref()
                .and_then(|revision_id| db.billing_declaration_scopes(revision_id).ok())
                .map(|rows| rows.into_iter().map(|(_, kind, value)| serde_json::json!({
                    "scope_kind": kind, "scope_value": value,
                })).collect::<Vec<_>>())
                .unwrap_or_default();
            serde_json::json!({
                "declaration_id": declaration_id, "provider_id": provider_id,
                "relationship_kind": relationship_kind, "subscription_name": subscription_name,
                "amount_minor": amount_minor, "currency": currency,
                "effective_start": effective_start, "effective_end": effective_end,
                "source_candidate_id": source_candidate_id,
                "current_revision_id": current_revision_id,
                "scopes": scopes,
            })
        }).collect::<Vec<_>>() }),
        Err(error) => serde_json::json!({ "status": "unavailable", "reason": error.to_string(), "declarations": [] }),
    }
}

/// 撤销只追加不可变修订，不删除已有影响、历史或证据；聚合查询仅认当前 saved
/// 修订，因此撤销完成后读取端会立即恢复按量/未定归类。
#[tauri::command]
fn revoke_billing_declaration(
    revision_id: String, declaration_id: String, supersedes_revision_id: String,
) -> Result<Value, String> {
    let data_home = overview::data_home();
    let path = agent_vitals_data::authority::default_authority_path(&data_home);
    let db = agent_vitals_data::authority::AuthorityDb::open(
        &path, agent_vitals_runtime::sql_sync::now_ms(),
    ).map_err(|error| error.to_string())?;
    let changed = db.billing_declaration_revision_revoke(
        &revision_id, &declaration_id, &supersedes_revision_id,
        agent_vitals_runtime::sql_sync::now_ms(),
    ).map_err(|error| error.to_string())?;
    Ok(serde_json::json!({
        "status": "revoked", "revision_id": revision_id,
        "declaration_id": declaration_id, "changed": changed,
    }))
}

/// 对尚未保存的声明做只读影响预览。参数就是保存时的参数（执行环境、provider、
/// 关系、起止月、作用域）——不再由前端另传统计月窗口：预览范围必须等于写入范围
/// （计费主链规格 G2/R1）。三组数字与分币金额由 `runtime::billing_preview` 用与重算
/// 归因同一条谓词、与 MCP `cost_breakdown` 同一条计价路径算出。
#[tauri::command(async)]
fn billing_candidate_impact_preview(
    provider_id: String, relationship_kind: String, effective_start: String,
    effective_end: Option<String>, scopes: Vec<BillingScopeInput>,
) -> Value {
    let path = agent_vitals_data::authority::default_authority_path(&overview::data_home());
    let Ok(db) = agent_vitals_data::authority::AuthorityDb::open_readonly(&path) else {
        return serde_json::json!({"status": "unavailable", "reason": "authority database is unavailable"});
    };
    // 预览范围必须等于写入范围（G2/R1）：provider 归一与保存路径同一条规则。
    let provider_id = agent_vitals_domain::cost::canonical_provider_id(
        &provider_id, &agent_vitals_domain::cost::load_pricing(),
    );
    let scope_refs = scopes.iter()
        .map(|scope| (scope.scope_kind.as_str(), scope.scope_value.as_str()))
        .collect::<Vec<_>>();
    agent_vitals_runtime::billing_preview::declaration_impact_preview(
        &db, &provider_id, &relationship_kind, &effective_start,
        effective_end.as_deref(), &scope_refs,
    )
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn save_harness_bill(
    bill_id: String, harness: String, provider_id: String, billing_period: String,
    billing_basis: String, amount_minor: i64, currency: String, evidence_ref: String,
) -> Result<Value, String> {
    let data_home = overview::data_home();
    let path = agent_vitals_data::authority::default_authority_path(&data_home);
    let db = agent_vitals_data::authority::AuthorityDb::open(
        &path, agent_vitals_runtime::sql_sync::now_ms(),
    ).map_err(|error| error.to_string())?;
    db.harness_bill_put(
        &bill_id, &harness, &provider_id, &billing_period, &billing_basis,
        amount_minor, &currency, &evidence_ref, agent_vitals_runtime::sql_sync::now_ms(),
    ).map_err(|error| error.to_string())?;
    Ok(serde_json::json!({ "status": "saved", "bill_id": bill_id }))
}

#[tauri::command]
fn save_harness_bills(rows: Vec<HarnessBillInput>) -> Result<Value, String> {
    if rows.is_empty() {
        return Err("no bill rows to import".to_string());
    }
    let data_home = overview::data_home();
    let path = agent_vitals_data::authority::default_authority_path(&data_home);
    let db = agent_vitals_data::authority::AuthorityDb::open(
        &path, agent_vitals_runtime::sql_sync::now_ms(),
    ).map_err(|error| error.to_string())?;
    let now_ms = agent_vitals_runtime::sql_sync::now_ms();
    db.with_immediate_txn(|_| {
        for row in &rows {
            db.harness_bill_put(
                &row.bill_id, &row.harness, &row.provider_id, &row.billing_period,
                &row.billing_basis, row.amount_minor, &row.currency, &row.evidence_ref, now_ms,
            )?;
        }
        Ok(())
    }).map_err(|error| error.to_string())?;
    Ok(serde_json::json!({ "status": "saved", "count": rows.len() }))
}

#[tauri::command(async)]
fn harness_bills_for_period(billing_period: String) -> Value {
    let data_home = overview::data_home();
    let path = agent_vitals_data::authority::default_authority_path(&data_home);
    let Ok(db) = agent_vitals_data::authority::AuthorityDb::open_readonly(&path) else {
        return serde_json::json!({ "status": "unavailable", "bills": [] });
    };
    match db.harness_bill_details_for_period(&billing_period) {
        Ok(rows) => serde_json::json!({ "status": "ok", "bills": rows.into_iter().map(|(bill_id, harness, provider_id, billing_basis, amount_minor, currency, evidence_ref)| {
            serde_json::json!({ "bill_id": bill_id, "harness": harness, "provider_id": provider_id, "billing_basis": billing_basis, "amount_minor": amount_minor, "currency": currency, "evidence_ref": evidence_ref })
        }).collect::<Vec<_>>() }),
        Err(error) => serde_json::json!({ "status": "unavailable", "reason": error.to_string(), "bills": [] }),
    }
}

#[tauri::command]
fn delete_harness_bill(bill_id: String) -> Result<Value, String> {
    let data_home = overview::data_home();
    let path = agent_vitals_data::authority::default_authority_path(&data_home);
    let db = agent_vitals_data::authority::AuthorityDb::open(
        &path, agent_vitals_runtime::sql_sync::now_ms(),
    ).map_err(|error| error.to_string())?;
    let deleted = db.harness_bill_delete(
        &bill_id, agent_vitals_runtime::sql_sync::now_ms(),
    ).map_err(|error| error.to_string())?;
    Ok(serde_json::json!({ "status": "deleted", "bill_id": bill_id, "deleted": deleted }))
}

/// 声明保存后创建重算任务；这里只入队，不在 IPC 调用线程执行重算。
fn spawn_billing_recalculation_worker(path: PathBuf, job_id: String) {
    std::thread::spawn(move || {
        let lease_path = path
            .parent()
            .map(|parent| parent.join(".billing-recalculation.lock"))
            .unwrap_or_else(|| PathBuf::from(".billing-recalculation.lock"));
        let holder = format!("billing-recalculation-{job_id}");
        let Ok(_lease) = agent_vitals_runtime::lease::acquire_blocking(
            &lease_path, &holder, 60_000, 60_000,
        ) else {
            if let Ok(db) = agent_vitals_data::authority::AuthorityDb::open(
                &path, agent_vitals_runtime::sql_sync::now_ms(),
            ) {
                let _ = db.billing_recalculation_set_status(
                    &job_id, "failed", Some("worker_busy"),
                    Some("recalculation worker lock was held"),
                    agent_vitals_runtime::sql_sync::now_ms(),
                );
            }
            return;
        };
        let Ok(worker_db) = agent_vitals_data::authority::AuthorityDb::open(
            &path, agent_vitals_runtime::sql_sync::now_ms(),
        ) else { return };
        for attempt in 0..3 {
            if attempt > 0 {
                std::thread::sleep(std::time::Duration::from_millis(250 * (1_u64 << (attempt - 1))));
                let _ = worker_db.billing_recalculation_retry(
                    &job_id, agent_vitals_runtime::sql_sync::now_ms(),
                );
            }
            match worker_db.billing_recalculation_run(
                &job_id, agent_vitals_runtime::sql_sync::now_ms(),
            ) {
                Ok(true) => return,
                Ok(false) => {
                    // false means the job was missing or no longer queued; it is
                    // never a successful recalculation receipt. A terminal job
                    // remains untouched by the final failure update below.
                }
                Err(_) => {
                    // The data layer records failures after entering `running`.
                    // Keep the retry loop here for transient database/worker errors.
                }
            }
        }
        let _ = worker_db.billing_recalculation_set_status(
            &job_id, "failed", Some("worker_failed"),
            Some("recalculation worker failed after retries"),
            agent_vitals_runtime::sql_sync::now_ms(),
        );
    });
}

fn recover_billing_recalculations(path: PathBuf) {
    let Ok(db) = agent_vitals_data::authority::AuthorityDb::open(
        &path, agent_vitals_runtime::sql_sync::now_ms(),
    ) else { return };
    let queued = db.billing_recalculation_recover(
        agent_vitals_runtime::sql_sync::now_ms(),
    ).unwrap_or_default();
    drop(db);
    for job_id in queued {
        spawn_billing_recalculation_worker(path.clone(), job_id);
    }
}

#[tauri::command]
fn enqueue_billing_recalculation(
    job_id: String, declaration_id: String, revision_id: String,
) -> Result<Value, String> {
    let data_home = overview::data_home();
    let path = agent_vitals_data::authority::default_authority_path(&data_home);
    let db = agent_vitals_data::authority::AuthorityDb::open(
        &path, agent_vitals_runtime::sql_sync::now_ms(),
    ).map_err(|error| error.to_string())?;
    let changed = db.billing_recalculation_enqueue(
        &job_id, &declaration_id, &revision_id, agent_vitals_runtime::sql_sync::now_ms(),
    ).map_err(|error| error.to_string())?;
    drop(db);
    if changed {
        spawn_billing_recalculation_worker(path.clone(), job_id.clone());
    }
    Ok(serde_json::json!({ "status": "queued", "job_id": job_id, "changed": changed }))
}

/// 失败/取消任务的显式重试入口；重试仍在后台执行，不阻塞 IPC 调用线程。
#[tauri::command]
fn retry_billing_recalculation(job_id: String) -> Result<Value, String> {
    let data_home = overview::data_home();
    let path = agent_vitals_data::authority::default_authority_path(&data_home);
    let db = agent_vitals_data::authority::AuthorityDb::open(
        &path, agent_vitals_runtime::sql_sync::now_ms(),
    ).map_err(|error| error.to_string())?;
    let changed = db.billing_recalculation_retry(
        &job_id, agent_vitals_runtime::sql_sync::now_ms(),
    ).map_err(|error| error.to_string())?;
    drop(db);
    if !changed {
        return Err("only failed or cancelled recalculation jobs can be retried".to_string());
    }
    spawn_billing_recalculation_worker(path, job_id.clone());
    Ok(serde_json::json!({ "status": "queued", "job_id": job_id, "changed": true }))
}

/// 查询重算任务回执；未找到和数据库不可用均返回可识别的业务错误。
#[tauri::command]
fn billing_recalculation_job_status(job_id: String) -> Result<Value, String> {
    let data_home = overview::data_home();
    let path = agent_vitals_data::authority::default_authority_path(&data_home);
    let db = agent_vitals_data::authority::AuthorityDb::open_readonly(&path)
        .map_err(|error| error.to_string())?;
    let Some((job_id, declaration_id, revision_id, status, requested_at_ms, started_at_ms,
        completed_at_ms, error_code, error_detail)) = db.billing_recalculation_job(&job_id)
        .map_err(|error| error.to_string())? else {
        return Err("unknown recalculation job".to_string());
    };
    Ok(serde_json::json!({
        "status": status, "job_id": job_id, "declaration_id": declaration_id,
        "revision_id": revision_id, "requested_at_ms": requested_at_ms,
        "started_at_ms": started_at_ms, "completed_at_ms": completed_at_ms,
        "error_code": error_code, "error_detail": error_detail,
    }))
}

/// 查询重算待处理列表；用于工作台重启后展示「重算待重试」而不丢失旧结果。
#[tauri::command(async)]
fn billing_recalculation_jobs() -> Result<Value, String> {
    let data_home = overview::data_home();
    let path = agent_vitals_data::authority::default_authority_path(&data_home);
    let db = agent_vitals_data::authority::AuthorityDb::open_readonly(&path)
        .map_err(|error| error.to_string())?;
    let jobs = db.billing_recalculation_jobs_needing_attention()
        .map_err(|error| error.to_string())?;
    Ok(serde_json::json!({
        "status": "ok",
        "jobs": jobs.into_iter().map(|(job_id, declaration_id, revision_id, status,
            requested_at_ms, started_at_ms, completed_at_ms, error_code, error_detail)| {
            serde_json::json!({
                "job_id": job_id, "declaration_id": declaration_id, "revision_id": revision_id,
                "status": status, "requested_at_ms": requested_at_ms, "started_at_ms": started_at_ms,
                "completed_at_ms": completed_at_ms, "error_code": error_code, "error_detail": error_detail,
            })
        }).collect::<Vec<_>>()
    }))
}

/// 工作台「数据源」页的独立契约。会话搜索只回答时间窗内的会话，不能再被
/// 借来承载扫描健康；这里从 SQL authority 的 source_files / usage_facts 读取
/// 每个已接线执行环境的扫描、导入和失败范围。执行环境集合复用 ingest registry，前端
/// 不再硬编码两个卡片。路径只以 source_id/path_hash 留在库内，本 DTO 不泄露。
#[tauri::command(async)]
fn data_source_status() -> Value {
    let data_home = overview::data_home();
    let path = agent_vitals_data::authority::default_authority_path(&data_home);
    let Ok(db) = agent_vitals_data::authority::AuthorityDb::open_readonly(&path) else {
        return serde_json::json!({
            "status": "unavailable",
            "reason": "authority database is missing or unreadable",
            "sources": []
        });
    };
    let mut report = agent_vitals_runtime::mcp::source_status_report(db.conn()).unwrap_or_else(|reason| {
        serde_json::json!({ "status": "unavailable", "reason": reason, "sources": [] })
    });
    merge_dynamic_harness_sources(&mut report, db.conn(), &overview_snapshot_typed_sync().sync.dynamic_harnesses);
    let excluded_harnesses = match agent_vitals_runtime::source_controls::excluded_harnesses(&data_home) {
        Ok(harnesses) => harnesses,
        Err(error) => return serde_json::json!({ "status": "unavailable", "reason": error, "sources": [] }),
    };
    if let Some(sources) = report.get_mut("sources").and_then(Value::as_array_mut) {
        for source in sources {
            let harness = source.get("harness").and_then(Value::as_str).unwrap_or("");
            if excluded_harnesses.contains(harness) {
                source["connection_state"] = Value::String("excluded".into());
                source["recovery_action"] = serde_json::json!({
                    "kind": "include_source", "label": "恢复读取"
                });
            }
        }
    }
    merge_source_sync_failure(&mut report, &overview_snapshot_typed_sync().sync);
    if matches!(overview::sync_is_paused(), Ok(true)) {
        if let Some(sources) = report.get_mut("sources").and_then(Value::as_array_mut) {
            for source in sources {
                if source.get("connection_state").and_then(Value::as_str) == Some("excluded") { continue; }
                source["connection_state"] = Value::String("paused".into());
                source["recovery_action"] = serde_json::json!({
                    "kind": "resume_sync", "label": "恢复同步"
                });
            }
        }
    }
    report
}

fn merge_dynamic_harness_sources(report: &mut Value, conn: &rusqlite::Connection, receipts: &[overview::DynamicHarnessSyncReceipt]) {
    use std::collections::{BTreeMap, BTreeSet};
    let mut slugs = BTreeSet::new();
    if let Ok(mut statement) = conn.prepare(
        "SELECT s.slot_id FROM extension_active a JOIN extension_activation_slots s
         ON s.generation=a.generation WHERE s.slot_type='harness_manifest'"
    ) {
        if let Ok(rows) = statement.query_map([], |row| row.get::<_, String>(0)) {
            slugs.extend(rows.flatten().filter(|slug| agent_vitals_runtime::sources::harness_registry::plugin_slug_ok(slug)));
        }
    }
    if let Ok(mut statement) = conn.prepare(
        "SELECT DISTINCT slot_id FROM extension_revisions WHERE slot_type='harness_manifest'"
    ) {
        if let Ok(rows) = statement.query_map([], |row| row.get::<_, String>(0)) {
            slugs.extend(rows.flatten().filter(|slug| agent_vitals_runtime::sources::harness_registry::plugin_slug_ok(slug)));
        }
    }
    if let Ok(mut statement) = conn.prepare("SELECT DISTINCT harness FROM source_files WHERE harness LIKE 'harness:%'") {
        if let Ok(rows) = statement.query_map([], |row| row.get::<_, String>(0)) {
            slugs.extend(rows.flatten().filter_map(|id| id.strip_prefix("harness:").map(str::to_owned))
                .filter(|slug| agent_vitals_runtime::sources::harness_registry::plugin_slug_ok(slug)));
        }
    }
    if let Ok(mut statement) = conn.prepare("SELECT DISTINCT harness FROM usage_facts WHERE harness LIKE 'harness:%'") {
        if let Ok(rows) = statement.query_map([], |row| row.get::<_, String>(0)) {
            slugs.extend(rows.flatten().filter_map(|id| id.strip_prefix("harness:").map(str::to_owned))
                .filter(|slug| agent_vitals_runtime::sources::harness_registry::plugin_slug_ok(slug)));
        }
    }
    let receipt_by_slug = receipts.iter().filter_map(|receipt| receipt.harness.strip_prefix("harness:")
        .map(|slug| (slug.to_owned(), receipt))).collect::<BTreeMap<_, _>>();
    let Some(sources) = report.get_mut("sources").and_then(Value::as_array_mut) else { return };
    for slug in slugs.into_iter().take(124) {
        let harness = format!("harness:{slug}");
        let source_stats = conn.query_row(
            "SELECT COUNT(*), MAX(last_seen_at_ms),
                    COALESCE(SUM(CASE WHEN last_error_code IS NOT NULL THEN 1 ELSE 0 END), 0)
             FROM source_files WHERE harness=?1",
            [&harness], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<i64>>(1)?, row.get::<_, i64>(2)?))
        ).unwrap_or((0, None, 0));
        let import_stats = conn.query_row(
            "SELECT COUNT(*), COUNT(DISTINCT session_key), MIN(event_ts_ms), MAX(event_ts_ms)
             FROM usage_facts WHERE harness=?1 AND deleted_at_ms IS NULL AND observation_kind!='legacy_aggregate'",
            [&harness], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, Option<i64>>(2)?, row.get::<_, Option<i64>>(3)?))
        ).unwrap_or((0, 0, None, None));
        let active = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM extension_active a JOIN extension_activation_slots s
             ON s.generation=a.generation WHERE s.slot_type='harness_manifest' AND s.slot_id=?1)",
            [&slug], |row| row.get::<_, bool>(0)
        ).unwrap_or(false);
        let receipt = receipt_by_slug.get(&slug).copied();
        let failed = source_stats.2 > 0 || receipt.is_some_and(|item| item.state == "failed");
        let state = if failed { "needs_attention" }
            else if source_stats.0 > 0 || receipt.is_some() { "connected" }
            else { "not_detected" };
        let mut error_codes = Vec::new();
        if source_stats.2 > 0 { error_codes.push(Value::String("source_unavailable".into())); }
        if let Some(code) = receipt.and_then(|item| item.error_code.as_deref()) {
            if !error_codes.iter().any(|existing| existing.as_str() == Some(code)) { error_codes.push(Value::String(code.into())); }
        }
        let recovery_action = if !active { serde_json::json!({"kind":"none","label":"历史来源"}) }
            else if failed { serde_json::json!({"kind":"retry_sync","label":"重新同步"}) }
            else { serde_json::json!({"kind":"sync","label":"立即同步"}) };
        sources.push(serde_json::json!({
            "source_id": harness, "harness": harness, "registration_state": if active { "active" } else { "historical" },
            "authorization": "unknown", "connection_state": state,
            "scan": { "last_scanned_at_ms": source_stats.1, "source_count": source_stats.0 },
            "log": { "last_event_at_ms": import_stats.3 },
            "import_scope": { "facts": import_stats.0, "sessions": import_stats.1,
                "first_event_at_ms": import_stats.2, "last_event_at_ms": import_stats.3 },
            "failed_scope": { "sources": if failed { source_stats.2.max(1) } else { 0 }, "error_codes": error_codes,
                "last_attempt": receipt.map(|item| serde_json::json!({"state":item.state,"observed_at":item.observed_at,
                    "appended":item.appended,"duplicate":item.duplicate})) },
            "recovery_action": recovery_action
        }));
    }
}

#[tauri::command(async)]
fn sync_pause_state() -> Value {
    match overview::sync_is_paused() {
        Ok(paused) => serde_json::json!({ "status": "ok", "paused": paused }),
        Err(error) => serde_json::json!({ "status": "unavailable", "reason": error }),
    }
}

#[tauri::command]
fn set_sync_paused(paused: bool) -> Result<Value, String> {
    overview::save_sync_paused(paused)?;
    Ok(serde_json::json!({ "status": "saved", "paused": paused }))
}

/// 扫描器在发现目录权限/解析失败时可能尚未写出 source_files 行；最近同步状态
/// 是这类失败的生产证据。把能明确归属的执行环境标为需要处理；无法归属的 facts
/// 同步失败影响全部执行环境，不能伪装成三个“已连接”。
fn merge_source_sync_failure(report: &mut Value, sync: &SyncStatus) {
    if sync.ok || sync.stage == "never" { return; }
    let message = sync.message.to_lowercase();
    let Some(sources) = report.get_mut("sources").and_then(Value::as_array_mut) else { return };
    let explicitly_scoped = ["claude", "codex", "dsh", "deepseek"]
        .iter().any(|marker| message.contains(marker));
    for source in sources {
        if source.get("connection_state").and_then(Value::as_str) == Some("excluded") { continue; }
        let harness = source.get("harness").and_then(Value::as_str).unwrap_or("");
        let affected = if explicitly_scoped {
            (harness == "claude-code" && message.contains("claude"))
                || (harness == "codex" && message.contains("codex"))
                || (harness == "dsh" && (message.contains("dsh") || message.contains("deepseek")))
        } else { true };
        if !affected { continue; }
        source["connection_state"] = Value::String("needs_attention".into());
        source["authorization"] = Value::String("unknown_or_failed".into());
        let error_code = if message.contains("permission") || message.contains("denied") {
            "permission_denied"
        } else if message.contains("disk full") || message.contains("no space") {
            "disk_full"
        } else if message.contains("parse") || message.contains("json") || message.contains("malformed") {
            "source_parse_failed"
        } else {
            "source_read_failed"
        };
        let prior_failed = source["failed_scope"]["sources"].as_u64().unwrap_or(0);
        source["failed_scope"]["sources"] = serde_json::json!(prior_failed.max(1));
        let mut error_codes = source["failed_scope"]["error_codes"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        if !error_codes.iter().any(|code| code.as_str() == Some(error_code)) {
            error_codes.push(Value::String(error_code.into()));
        }
        source["failed_scope"]["error_codes"] = Value::Array(error_codes);
        source["failed_scope"]["sync"] = serde_json::json!({
            "stage": sync.stage, "message": sync.message
        });
        source["recovery_action"] = serde_json::json!({
            "kind": "retry_sync", "label": "重新同步"
        });
    }
}


/// 重查询的有界并发闸门 + 阻塞线程池执行（RUNTIME_INVALIDATION spec §5.3）：
/// `#[tauri::command(async)]` 修饰的**同步**函数体此前直接跑在 tokio worker 上
/// （`respond_async_serialized` 的 future 里内联执行），N 个并发命令钉死 N 个
/// worker——本次事故热栈的直接机制。`run_heavy_read` 把闭包搬进
/// `tauri::async_runtime::spawn_blocking`（阻塞线程池，不占 worker）并在进入前
/// 拿 `ReadGate` 许可，把最坏情况（`ReadMemo` 全 miss）的并发钉在
/// `HEAVY_READ_PERMITS`（2）。四个接线点：`data_monthly_summary` /
/// `data_daily_summary` / `read_calendar_month` / `read_hourly_distribution`——
/// 本次事故热栈点名的四个符号。
fn heavy_read_gate() -> &'static agent_vitals_runtime::query::read_gate::ReadGate {
    static GATE: std::sync::OnceLock<agent_vitals_runtime::query::read_gate::ReadGate> =
        std::sync::OnceLock::new();
    GATE.get_or_init(|| {
        agent_vitals_runtime::query::read_gate::ReadGate::new(
            agent_vitals_runtime::query::read_gate::HEAVY_READ_PERMITS,
        )
    })
}

/// `f` 在阻塞线程池上、持有一个 `ReadGate` 许可时执行。调用方必须 `.await` ——
/// 这就是把执行搬出 tokio worker 的机制本身。
async fn run_heavy_read<F, R>(f: F) -> R
where
    F: FnOnce() -> R + Send + 'static,
    R: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = heavy_read_gate().acquire();
        f()
    })
    .await
    .unwrap_or_else(|e| {
        // spawn_blocking 的 JoinError 只在闭包 panic 或运行时关闭时发生；这些查询
        // 都是幂等只读，重试（下一次 invoke）就是完整的恢复路径，这里不吞错误、
        // 直接向上传播，让 Tauri 的 IPC 层照常把它变成一次失败的 invoke。
        panic!("heavy read task join failed: {e}")
    })
}

/// v0.9 Stage 0.6 工作台 Data Query API（spec §7 目标态"Tauri 只调
/// monthly_summary 等 API"）：经 `SummaryRepository` trait 调 runtime 的
/// repository——Phase 3.5 Tier A 起读 SQL 权威库
/// （`SqlSummaryRepository`，含 legacy_aggregate 深历史），与 CLI `data
/// coverage` 同源。薄转发，无定价/无直读 state JSON。`--json` 与
/// CLI `data coverage` 是**同一份冻结 DTO**（`data_contract.rs::to_json`），
/// 工作台总览/日历两页的诚实字段（freshness/coverage/excluded_harnesses）都从
/// 这里取，不许前端自己从金额反推"有没有数据"。
#[tauri::command(async)]
async fn data_monthly_summary(month: String) -> Value {
    run_heavy_read(move || {
        use agent_vitals_data::repository::MonthlySummaryQuery;
        let repo = agent_vitals_runtime::summary::SqlSummaryRepository::new();
        let value = repo.monthly_summary_json_memoized(
            &MonthlySummaryQuery { month },
            agent_vitals_runtime::query::read_memo::ReadMemo::global(),
        );
        Value::clone(&value)
    })
    .await
}

/// v0.9 Stage 0.6 单日版（北京日 YYYY-MM-DD）。与 `data_monthly_summary`
/// 同一条 trait 路径、同一份 DTO 契约（同为 SQL 权威库读源）。
#[tauri::command(async)]
async fn data_daily_summary(date: String) -> Value {
    run_heavy_read(move || {
        use agent_vitals_data::repository::DailySummaryQuery;
        let repo = agent_vitals_runtime::summary::SqlSummaryRepository::new();
        let value = repo.daily_summary_json_memoized(
            &DailySummaryQuery { date },
            agent_vitals_runtime::query::read_memo::ReadMemo::global(),
        );
        Value::clone(&value)
    })
    .await
}

/// Workbench Overview query bundle. These panels are a single logical view,
/// so bracket all three SQL projections with the same authority revision. If
/// an ingest commits during the read, retry once; if writes remain active,
/// return the final values with `is_consistent = false` instead of claiming a
/// cross-revision snapshot.
#[tauri::command(async)]
async fn read_overview_details_snapshot(month: String, date: String) -> Value {
    run_heavy_read(move || {
        overview_details_snapshot_at(overview::data_home(), &month, &date)
    }).await
}

fn overview_details_snapshot_at(data_home: std::path::PathBuf, month: &str, date: &str) -> Value {
    use agent_vitals_data::repository::{DailySummaryQuery, MonthlySummaryQuery};
    let path = agent_vitals_data::authority::default_authority_path(&data_home);
    let repo = agent_vitals_runtime::query::summary::SqlSummaryRepository::at(data_home);
    let memo = agent_vitals_runtime::query::read_memo::ReadMemo::global();
    let mut result = Value::Null;
    for attempt in 0..2 {
        let revision_before = authority_revision_at(&path);
        // 趋势面板失败小时（OVERVIEW_TREND_PANEL spec v1.1 §3）：在 revision_before
        // 采样之后读取，与 monthly/daily/calendar 同处一致性括号内。
        let failure_hours = repo
            .open_db()
            .and_then(|db| agent_vitals_data::issues::failure_hours_day(db.conn(), date));
        // 趋势图本周/本月档的失败日（OVERVIEW_TREND_RANGE_SPEC §2.2）：窗口
        // [date-30d, date] 一定覆盖「本月 1 日起」与「本周周一起」；同一 revision 括号。
        let failure_days = repo
            .open_db()
            .and_then(|db| agent_vitals_data::issues::failure_days_trailing(db.conn(), date, 30));
        let monthly = repo.monthly_summary_json_memoized(&MonthlySummaryQuery { month: month.to_string() }, memo);
        let daily = repo.daily_summary_json_memoized(&DailySummaryQuery { date: date.to_string() }, memo);
        let calendar = agent_vitals_runtime::query::summary::calendar_month_memoized(month, &repo, memo);
        let revision_after = authority_revision_at(&path);
        let is_consistent = revision_before.is_some() && revision_before == revision_after;
        result = serde_json::json!({
            "month": month,
            "date": date,
            "monthly": monthly.as_ref(),
            "daily": daily.as_ref(),
            "calendar": calendar.as_ref(),
            "failure_hours": failure_hours,
            "failure_days": failure_days,
            "authority_revision": revision_after,
            "is_consistent": is_consistent,
            "errors": if is_consistent { Vec::<String>::new() } else { vec!["汇总期间数据发生变化或权威库不可用，当前结果可能跨 revision".to_string()] },
        });
        if is_consistent || attempt == 1 { break; }
    }
    result
}

/// Claude Pro 额度提醒的开关（默认关）。
///
/// **为什么自带开关**：系统通知权限必须由一次用户动作触发申请；额度提醒与预算
/// 提醒是两件事，从不用预算的用户不该因此永远收不到窗口提醒。文件缺失表示默认关闭；
/// 文件存在但不可读取则返回 unavailable，让 UI 诚实显示配置损坏，而投递端仍 fail-closed。
#[tauri::command]
fn quota_reminder_config() -> Value {
    match agent_vitals_runtime::quota_reminder::is_enabled(&overview::data_home()) {
        Ok(enabled) => serde_json::json!({ "status": "ok", "enabled": enabled }),
        Err(_) => serde_json::json!({ "status": "unavailable", "enabled": false, "notification_permission": null }),
    }
}

/// 写入开关；**打开的那一刻才申请系统通知权限**（REQ-039：权限在用户启用提醒时申请）。
#[tauri::command]
fn save_quota_reminder_config(app: AppHandle, enabled: bool) -> Result<Value, String> {
    let data_home = overview::data_home();
    let notification_permission = enabled.then(|| {
        app.notification()
            .request_permission()
            .map(|state| format!("{state:?}"))
            .unwrap_or_else(|error| format!("unavailable: {error}"))
    });
    agent_vitals_runtime::quota_reminder::set_enabled(&data_home, enabled)?;
    Ok(serde_json::json!({
        "status": "saved",
        "enabled": enabled,
        "notification_permission": notification_permission,
    }))
}

/// Read the explicit Trust runtime monitor state. Monitoring is opt-in and
/// fail-closed when the local authority DB or sensor capability is unavailable.
#[tauri::command]
fn trust_monitor_config() -> Value {
    trust_monitor_state_read()
}

/// R6a（REFRESH_STORM）：询问条幅的「稍后」——dismiss 后前端永不再弹，
/// enabled 保持不动（显式开/关走 save_trust_monitor_config，置 `user`）。
#[tauri::command(async)]
fn trust_monitor_dismiss(app: AppHandle) -> Result<Value, String> {
    let path = agent_vitals_data::authority::default_authority_path(&overview::data_home());
    let db = agent_vitals_data::authority::AuthorityDb::open(&path, agent_vitals_runtime::sql_sync::now_ms())
        .map_err(|_| "authority_unavailable".to_string())?;
    db.trust_monitor_dismiss().map_err(|_| "monitor_state_save_failed".to_string())?;
    let _ = app.emit(APP_EVENT, serde_json::json!({
        "type": "TrustMonitorInvalidated", "kind": "trust_monitor_invalidated",
    }));
    Ok(trust_monitor_state_read())
}

/// Persist Trust monitoring controls. Notification permission is requested only
/// when the user explicitly turns notifications on; disabling the monitor also
/// disables its notifications so a stale permission cannot create surprises.
#[tauri::command]
fn save_trust_monitor_config(
    app: AppHandle,
    enabled: bool,
    interval_seconds: i64,
    notifications_enabled: bool,
) -> Result<Value, String> {
    if !(5..=3600).contains(&interval_seconds) {
        return Err("interval_seconds must be between 5 and 3600".into());
    }
    let notifications_enabled = enabled && notifications_enabled;
    let notification_permission = notifications_enabled.then(|| {
        app.notification()
            .request_permission()
            .map(|state| format!("{state:?}"))
            .unwrap_or_else(|_| "unavailable".to_string())
    });
    let now_ms = agent_vitals_runtime::sql_sync::now_ms();
    let path = agent_vitals_data::authority::default_authority_path(&overview::data_home());
    let db = agent_vitals_data::authority::AuthorityDb::open(&path, now_ms)
        .map_err(|_| "authority_unavailable".to_string())?;
    db.trust_monitor_state_set(enabled, interval_seconds, notifications_enabled, now_ms)
        .map_err(|_| "monitor_state_save_failed".to_string())?;
    let mut result = trust_monitor_state_read();
    if let Value::Object(ref mut object) = result {
        object.insert("notification_permission".into(),
            notification_permission.map(Value::String).unwrap_or(Value::Null));
    }
    // R3-F5：传感轮的 TrustMonitorInvalidated 已改为「有新观察才发」，配置被他处
    // 修改后的 TrustPage 重读场景由这里兜——保存成功即发一条（本地、用户动作驱动）。
    let _ = app.emit(APP_EVENT, serde_json::json!({
        "type": "TrustMonitorInvalidated", "kind": "trust_monitor_invalidated",
    }));
    Ok(result)
}

/// 用户补的价卡（`state/pricing-overrides.json`）。
///
/// **为什么有这一层**：价目表 `assets/pricing.json` 是 `include_str!` 编进二进制的，
/// 运行时改不了；而"厂商出了新型号、价目表里还没有"是必然反复发生的事
/// （2026-09-14 的 `deepseek/deepseek-v4.1-flash`）。这一层让用户能自己补一张卡，
/// 把"算不出来"变成"按他填的价算得出来"。
#[tauri::command]
fn price_cards() -> Value {
    let data_home = overview::data_home();
    serde_json::json!({
        "status": "ok",
        "cards": agent_vitals_runtime::price_overrides::cards(&data_home),
    })
}

/// 写入/替换一张用户补的价卡。三个维度（未命中输入/命中输入/输出）各两档峰谷，
/// **必须齐全**——半张卡会让计价按缺档静默算出一个看似正常的错数字。第四维
/// `cache_write` 可选（中转把缓存写入单独计价时才需要）。
#[tauri::command]
fn save_price_card(input: PriceCardInput) -> Result<Value, String> {
    let data_home = overview::data_home();
    let mut card = serde_json::json!({
        "input_uncached": input.input_uncached,
        "input_cached": input.input_cached,
        "output": input.output,
    });
    if let Some(cache_write) = input.cache_write {
        card["cache_write"] = cache_write;
    }
    agent_vitals_runtime::price_overrides::save_card_checked(
        &data_home, &input.provider_id, &input.model_id, &card,
        input.currency.as_deref().unwrap_or("CNY"),
    )?;
    Ok(serde_json::json!({
        "status": "saved",
        "provider_id": input.provider_id,
        "model_id": input.model_id,
    }))
}

/// 用户声明的**型号归属**（"这个型号算哪个服务商的账"）。
///
/// **与补价卡是两件事，且有先后**：`billing_route_of` 只读价目表里的
/// `catalog_2026_09.billing_modes`（模型名前缀 → 服务商），公共目录只声明了少数
/// 几条。归属没定 → 整批用量 `billing-route-unknown`（**不是"怎么付"的问题，是
/// "算谁的"**，所以计费声明解决不了）；归属定了但没价卡 → `no-price-card`。
/// 声明归属后状态会前进到缺价卡，那时才轮到补价卡。
#[tauri::command]
fn price_routes() -> Value {
    let data_home = overview::data_home();
    serde_json::json!({
        "status": "ok",
        "routes": agent_vitals_runtime::price_overrides::routes(&data_home),
    })
}

#[tauri::command]
fn save_price_route(input: PriceRouteInput) -> Result<Value, String> {
    let data_home = overview::data_home();
    agent_vitals_runtime::price_overrides::save_route(
        &data_home, &input.model_prefix, &input.provider_id, &input.mode,
    )?;
    Ok(serde_json::json!({
        "status": "saved",
        "model_prefix": input.model_prefix,
        "provider_id": input.provider_id,
    }))
}

#[tauri::command]
fn delete_price_route(model_prefix: String) -> Result<Value, String> {
    let data_home = overview::data_home();
    agent_vitals_runtime::price_overrides::remove_route(&data_home, &model_prefix)?;
    Ok(serde_json::json!({ "status": "removed" }))
}

/// 补价卡表单的服务商清单：目录里的服务商 + 用户为新服务商声明过的币种，各带报价币种。
/// 表单据此把币种选项限制在服务商自己的报价币种上（币种是服务商级的，见 `save_card_checked`）。
#[tauri::command(async)]
fn price_card_providers() -> Value {
    let data_home = overview::data_home();
    let pricing = agent_vitals_runtime::price_overrides::merged_main(&data_home);
    let mut ids = std::collections::BTreeSet::new();
    for pointer in ["/providers", "/catalog_2026_09/providers"] {
        if let Some(map) = pricing.pointer(pointer).and_then(Value::as_object) {
            ids.extend(map.keys().filter(|key| !key.starts_with('_')).cloned());
        }
    }
    ids.extend(agent_vitals_runtime::price_overrides::currencies(&data_home).keys().cloned());
    let base = agent_vitals_domain::cost::load_pricing();
    let providers: Vec<Value> = ids.into_iter().map(|id| {
        let mut currency = agent_vitals_domain::cost::provider_quote_currency(&id, &pricing);
        // 并列报价的服务商（官方给了几个币种各一套价）：没补过自己的卡 → 币种没被钉死，表单让用户从 offered 里选；
        // 补过 → 钉在那些卡的币种上（merged 视图里的 currency 就是它）。
        let offered = agent_vitals_runtime::pricing::quote_variants::offered_currencies(&base, &id);
        let has_cards = agent_vitals_runtime::price_overrides::cards(&data_home).get(&id)
            .and_then(Value::as_object).is_some_and(|m| !m.is_empty());
        if offered.is_some() && !has_cards { currency = None; }
        serde_json::json!({ "id": id, "currency": currency, "offered": offered })
    }).collect();
    serde_json::json!({ "status": "ok", "providers": providers })
}

/// 设置页「并列报价」板块：每个有多套官方报价的服务商当前用哪套、依据是什么（用户选择 / 默认假设 /
/// 保持基础卡 / 被自己的价卡钉住）、还能选什么。
#[tauri::command(async)]
fn quote_variants_status() -> Value {
    let providers = agent_vitals_runtime::pricing::quote_variants::status(&overview::data_home());
    serde_json::json!({ "status": "ok", "providers": providers })
}

/// 保存（`currency` 为 null → 清除，回到默认假设）某服务商的报价币种选择。选择只改「用哪套官方价」，
/// 不做任何换算；保存后刷新总览/托盘，金额随之重算。
#[tauri::command]
fn save_quote_choice(app: AppHandle, provider_id: String, currency: Option<String>) -> Result<Value, String> {
    agent_vitals_runtime::pricing::quote_variants::save_choice(&overview::data_home(), &provider_id, currency.as_deref())?;
    refresh(&app, overview_snapshot_typed_sync().as_ref());
    Ok(serde_json::json!({ "status": "saved" }))
}

#[tauri::command]
fn delete_price_card(provider_id: String, model_id: String) -> Result<Value, String> {
    let data_home = overview::data_home();
    agent_vitals_runtime::price_overrides::remove_card(&data_home, &provider_id, &model_id)?;
    Ok(serde_json::json!({ "status": "removed" }))
}

/// 决策卡「现在该用谁」的 Claude Pro 窗口状态（2026-09-14）。
///
/// 与 Codex 那行**不等价**：Claude 的本地日志里没有正向余量（42/42 条
/// `quotaLimits` 全是 `status:"rejected"`，无 `used_percent`），所以只可能给出
/// `unknown` 或 `exhausted`（+ 重置时刻），**永远不会有"剩余 N%"**——
/// `ROUTE_UNIT_COST_DECISION_SPEC` §8.3.2 明令不得显示百分比。
#[tauri::command(async)]
fn data_claude_quota() -> Option<Value> {
    // 窗口状态由同步管线扫 ~/.claude 的 quotaLimits 落库，这里只读快照 ——
    // 读面不现扫（与 data_codex_quota 同一条纪律）。`now` 在这里取一次并注入
    // 状态机，保证卡片/待处理/通知拿到同一个"现在"。
    let now_secs = agent_vitals_runtime::sql_sync::now_ms() / 1_000;
    agent_vitals_runtime::summary::claude_quota_status(now_secs)
}

/// 决策卡「现在该用谁」的 Codex 窗口余量（v0.9 Stage D）。plan 是"当前
/// 状态"的单快照、不按日期分桶——独立命令而不是塞进月/日 summary，语义
/// 才不混。无 rollout / 无 plan 事件 → null（无 ChatGPT 订阅证据，不得编
/// 造余量）。
#[tauri::command(async)]
fn data_codex_quota() -> Option<Value> {
    // codex rollout 根在 ~/.codex，不在数据根——解析复用 runtime 的 codex_home
    // （HOME → USERPROFILE → 空串，审查 #4：手写 HOME-only 在 Windows 上静默假
    // Unavailable）。
    agent_vitals_runtime::summary::codex_quota_snapshot(
        &agent_vitals_runtime::summary::codex_home(),
    )
}

/// Token 日历的逐日跨执行环境数据（v0.9 Stage D——此前日历只画 DSH 日轴，
/// DSH 零用量月份让 claude/codex 的真实用量在日历上不可见）。每天三执行环境
/// 各自 token + 耗费，钱不跨执行环境不跨币合并（口径各异，格子副行分币并列）。
#[tauri::command(async)]
async fn read_calendar_month(month: String) -> Value {
    run_heavy_read(move || {
        agent_vitals_runtime::summary::calendar_month(
            &month,
        )
    })
    .await
}

/// 单日按小时分布（北京小时）——三执行环境统一（v0.9.1 Phase 3.5 Tier B 起）：
/// `usage_facts` 行级事实按北京小时聚合（`authority_query::hourly_by_harness`），
/// dsh / codex / claude-code 一视同仁；`harnesses_available` 如实标注每执行环境在场
/// 与否（`sql-facts`），库打不开 = 全执行环境缺席。旧「codex=fold、claude=facts-index
/// 部分覆盖」的三路拼装与 `codex_home` 参数已随 Tier B 退役（R0 化石清理）。
#[tauri::command(async)]
async fn read_hourly_distribution(date: String) -> Value {
    run_heavy_read(move || {
        agent_vitals_runtime::summary::hourly_distribution(&date)
    })
    .await
}

/// 工作台「立即同步」按钮：返回本次请求的单调 ID。后台完成后由
/// sync_request_status 精确确认，不再用秒级时间戳猜测是否是本次同步。
#[tauri::command]
fn trigger_sync(app: AppHandle) -> String {
    let id = format!("sync-{}", SYNC_REQUEST_SEQ.fetch_add(1, Ordering::Relaxed));
    {
        let requests = app.state::<SyncRequests>();
        let mut requests = requests.0.lock().unwrap_or_else(|e| e.into_inner());
        if requests.len() > 32 { requests.retain(|_, completed| !*completed); }
        requests.insert(id.clone(), false);
    }
    sync_now_tracked(&app, Some(id.clone()));
    id
}

#[tauri::command]
fn sync_request_status(app: AppHandle, request_id: String) -> Value {
    let requests = app.state::<SyncRequests>();
    let requests = requests.0.lock().unwrap_or_else(|e| e.into_inner());
    match requests.get(&request_id) {
        Some(completed) => serde_json::json!({ "request_id": request_id, "completed": completed }),
        None => serde_json::json!({ "request_id": request_id, "error": "unknown_request" }),
    }
}

/// v0.10.0 Traces tab 的数据面（spec §7 门槛 3 的 Tauri IPC 消费面）：薄转发到
/// runtime 的 MCP `session_trace` 工具——**in-process** 而非 store.rs 的 spawn
/// CLI，两个理由：(1) 数据面是纯函数 + memo（常驻进程里同会话反复下钻命中同
/// 一份 `Arc<TraceGraph>`，spawn 每次冷启动反而更慢）；(2) envelope 形状与 MCP
/// / CLI 三面同源（`mcp::build_envelope`），door-3 parity 由构造保证。
///
/// 错误面：MCP `ToolError` → `{error: {code, message}}`（与 store.rs 的类型化
/// 错误透传同形状），前端按 code 分支展示。`spawn_blocking`：首次权威库打开是
/// 冷 IO（与 sessions_* 同一条纪律）。
#[tauri::command]
async fn session_trace(
    session_ref: String,
    output: Option<String>,
) -> Value {
    let args = serde_json::json!({
        "session_ref": session_ref,
        "output": output.unwrap_or_else(|| "timeline_series".to_string()),
    });
    let data_home = overview::data_home();
    tauri::async_runtime::spawn_blocking(move || {
        match agent_vitals_runtime::mcp::dispatch("session_trace", &args, &data_home) {
            Ok(v) => v,
            Err(e) => serde_json::json!({"error": {"code": e.code, "message": e.message}}),
        }
    })
    .await
    .unwrap_or_else(|_| serde_json::json!({"error": {"code": "cancelled", "message": "join error"}}))
}

/// 会话消耗诊断检查器的原始证据（SESSION_TRACE_DIAGNOSTICS_SPEC r6 §8.4、§10）：
/// 区间内每次失败的错误/参数摘录、逐次调用、安全提醒命令摘要。**本地呈现层
/// 专属**——不走 `mcp::dispatch`，那是 agent 消费面，摘录不出那个面（与 CLI
/// `trace-anchors` 同一信任域）。`from`/`to` 为 1 基步号（含两端）。
#[tauri::command]
async fn session_trace_evidence(session_ref: String, from: usize, to: usize, include_calls: Option<bool>) -> Value {
    let data_home = overview::data_home();
    tauri::async_runtime::spawn_blocking(move || {
        match agent_vitals_runtime::query::session_insights::session_trace_evidence_for_ref(&data_home, &session_ref, from, to, include_calls.unwrap_or(true)) {
            Ok(v) => serde_json::json!({ "data": v }),
            Err(e) => serde_json::json!({ "error": { "code": e.split(':').next().unwrap_or("internal_error"), "message": e } }),
        }
    })
    .await
    .unwrap_or_else(|_| serde_json::json!({"error": {"code": "cancelled", "message": "join error"}}))
}

/// 工作台 pull：**非破坏性**读导航目标（窗口未建/未可见时菜单点击的目标留在这里，等
/// init/focus 时消费；`peek` 不消费，apply 成功后由 `clear_nav_target` 显式清）。
#[tauri::command]
fn peek_nav_target(state: tauri::State<'_, NavTarget>) -> Option<String> {
    state.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// 工作台 apply 成功后清除导航目标——陈旧目标不清会在下次 focus 时重复跳一次 tab。
#[tauri::command]
fn clear_nav_target(state: tauri::State<'_, NavTarget>) {
    *state.0.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

/// 会话深链发射点（spec §7.2 的 focus_session）：覆盖式存入 + `focus-target`
/// 事件 + show_workbench。前端 v1 不发射（消费侧是 peek/clear），这个命令是给
/// 菜单分发与未来「查看全部会话」回归共用的 IPC 面。
#[tauri::command]
fn focus_session(app: AppHandle, target: WorkbenchTarget) {
    focus_session_target(&app, target);
}

/// 工作台 pull：**非破坏性**读深链目标（窗口未建/未可见时菜单点击的目标留在
/// 这里，等 init/focus/visibilitychange 时消费；`peek` 不消费，apply 成功后由
/// `clear_focus_target` 显式清——失败也清，不无限重试，spec §7.2）。
#[tauri::command]
fn peek_focus_target(state: tauri::State<'_, FocusTarget>) -> Option<WorkbenchTarget> {
    state.peek()
}

/// 工作台 apply 成功后清除深链目标（失败也清——错误横幅已向用户说明，菜单再点
/// 会覆盖新目标）。
#[tauri::command]
fn clear_focus_target(state: tauri::State<'_, FocusTarget>) {
    state.clear();
}

/// 工作台"截图"按钮：把窗口内容直接拷进系统剪贴板，省得用户手动截图裁剪再贴过来。
/// 用 `screencapture -l<windowNumber>`（按窗口 ID 截）而不是拿 outer_position/
/// outer_size 算区域再 `-R x,y,w,h`——后者要在物理像素和 Retina scale factor 之间
/// 换算，前者让系统自己按窗口分辨率截，不用算。
/// 注意：这是 macOS 系统权限，不是这段代码能探测的——第一次调用如果没有"屏幕录制"
/// 权限，`screencapture` 仍然 exit 0，只是拷贝出一张黑图/空图；这里不做静默降级。
#[tauri::command]
fn capture_workbench_screenshot(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use objc::{msg_send, sel, sel_impl};
        let (window, _) = crate::workbench_parts(&app)
            .ok_or_else(|| "工作台窗口未打开".to_string())?;
        let ns_window = window.ns_window().map_err(|e| e.to_string())? as *mut objc::runtime::Object;
        if ns_window.is_null() {
            return Err("拿不到窗口句柄".to_string());
        }
        // objc `msg_send!` 宏内部的 cfg 会被 clippy 的 unexpected_cfgs 误报
        // （宏展开跨 crate 的已知噪音，非本仓库代码）——桌面 crate 自身要能
        // 过 -D warnings gate，必须在这里压掉。
        #[allow(unexpected_cfgs)]
        let win_num: i64 = unsafe { msg_send![ns_window, windowNumber] };
        let status = std::process::Command::new("screencapture")
            .args(["-x", "-c", "-o", &format!("-l{}", win_num)])
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("screencapture 失败".to_string());
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("截图功能目前只支持 macOS".to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    #[cfg(all(feature = "plugin-isolation-probe", target_os = "macos"))]
    if let Some(report) = plugin_isolation_probe::report_argument() {
        plugin_isolation_probe::run(report, context);
        return;
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .manage(SyncLock(Mutex::new(())))
        .manage(HarnessActivityTable(std::sync::Mutex::new(
            std::collections::BTreeMap::new(),
        )))
        .manage(SyncRequests(Mutex::new(std::collections::BTreeMap::new())))
        // 失效信号 / 同步状态的「变了才发」发布器：tick 与手动同步线程共享。
        .manage(InvalidationPublisher(agent_vitals_runtime::events::ChangePublisher::new()))
        .manage(SyncStatusPublisher(agent_vitals_runtime::events::ChangePublisher::new()))
        // 自看护（REVIEW P4）动态 watcher 冷却：health publisher 写、refresh
        // tick 读，见 WatcherCooldownOverride 注释。
        .manage(WatcherCooldownOverride::baseline())
        // 菜单信息行导航目标：菜单点击 → 工作台（见 NavTarget 注释）。
        .manage(NavTarget(Mutex::new(None)))
        // 会话深链待消费目标（spec §7.2）：菜单 L2 → 工作台详情。与 NavTarget
        // 并存——不同维度（会话目标 vs tab 名），见 FocusTarget 注释。
        .manage(FocusTarget(Mutex::new(None)))
        // 最近一次菜单构建用的执行环境行（spec §9.2 #12 映射依据，见 build_menu_at）。
        .manage(HarnessesCache(Mutex::new(Vec::new())))
        // R2a 冷构建串行锁：后台预热与用户点击并发 spawn CLI 时，后到者等锁 →
        // 直接命中 cache（见 store.rs StoreBuildLock 注释）。
        .manage(store::StoreBuildLock::new())
        // Skill 体检 tab 的扫描缓存 + 取消把手（store.rs SkillsScanState 注释）。
        .manage(store::SkillsScanState::new())
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                agent_vitals_runtime::logging::log_warn("workbench", &format!("window destroyed: {}", window.label()));
            }
            // 工作台 × 按钮 → 隐藏不销毁。config-created 窗口被 × 关掉会 destroy，
            // 之后 reopen 是 no-op（get_webview_window 返回 None）；hide 保状态——
            // 当前 tab/月/分页游标都在，再开就是上次的样子。
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "workbench" {
                    api.prevent_close();
                    agent_vitals_runtime::logging::log_info("workbench", "close-requested -> hide");
                    let _ = window.hide();
                    // 关窗 = 撤 Dock 图标（用户理想形态：无窗口时回到纯菜单栏，
                    // 经菜单栏唤起）。真根因（webview 门槛/wedge）已修，双向安全。
                    #[cfg(target_os = "macos")]
                    let _ = window.app_handle().set_dock_visibility(false);
                }
            }
        })
        .manage(plugin_host::PluginHost::default())
        .invoke_handler({
            let handler: Box<dyn Fn(tauri::ipc::Invoke) -> bool + Send + Sync> = Box::new(tauri::generate_handler![
            plugin_host::plugin_open,
            plugin_host::plugin_set_bounds,
            plugin_host::plugin_close,
            plugin_host::plugin_snapshot,
            plugin_host::plugin_command,
            plugin_host::plugin_message,
            plugin_host::plugin_request,
            plugin_host::plugin_invalidate,
            read_overview,
            data_status,
            billing_import_candidates,
            billing_confirmation_groups,
            resolve_billing_import_candidate,
            save_billing_declaration_revision,
            billing_declarations,
            revoke_billing_declaration,
            billing_candidate_impact_preview,
            custom_source_roots,
            pick_custom_source_root,
            add_custom_source_root,
            remove_custom_source_root,
            watcher_health,
            source_harness_controls,
            source_data_revision,
            source_read_locations,
            set_source_harness_excluded,
            delete_imported_source_data,
            retention_config,
            save_retention_config,
            statistics_timezone_config,
            harness_display_names,
            harness_inventory,
            fx_status,
            save_reporting_currency_config,
            save_fx_manual_rate,
            remove_fx_manual_rate,
            fx_convert_amounts,
            save_statistics_timezone_config,
            ui_language_config,
            save_ui_language_config,
            public_pricing_catalog_status,
            manifest_catalog_status,
            save_manifest_catalog_policy,
            update_manifest_catalog,
            install_manifest_catalog_harness,
            save_public_pricing_catalog_policy,
            update_public_pricing_catalog,
            restore_authority_backup,
            export_diagnostic_package,
            about_diagnostics,
            ip_check::ip_check_run,
            check_for_updates,
            open_trusted_releases_page,
            budget_config,
            budget_profiles_status,
            save_budget_profile,
            disable_budget_profile,
            save_budget_config,
            snooze_budget_until,
            snooze_budget_current_period,
            clear_budget_snooze,
            official_price_card,
            price_card_providers,
            quote_variants_status,
            save_quote_choice,
            mcp_setup_info,
            mcp_skill_text,
            export_mcp_skill,
            save_harness_bill,
            save_harness_bills,
            harness_bills_for_period,
            delete_harness_bill,
            enqueue_billing_recalculation,
            retry_billing_recalculation,
            billing_recalculation_job_status,
            billing_recalculation_jobs,
            sync_pause_state,
            set_sync_paused,
            data_source_status,
            data_monthly_summary,
            data_daily_summary,
            read_overview_details_snapshot,
            data_codex_quota,
            data_claude_quota,
            quota_reminder_config,
            trust_monitor_config,
            save_trust_monitor_config,
        trust_monitor_dismiss,
            price_cards,
            save_price_card,
            delete_price_card,
            price_routes,
            save_price_route,
            delete_price_route,
            save_quota_reminder_config,
            read_calendar_month,
            read_hourly_distribution,
            trigger_sync,
            sync_request_status,
            session_trace,
            session_trace_evidence,
                store::probe_routes_list,
                store::probe_current_hint,
                store::routes_quality,
            store::probe_run_start,
            store::probe_run_result,
            store::probe_report,
        store::sessions_list,
            store::sessions_read,
            store::sessions_findings,
            store::trust_audit,
            store::trust_evidence_read,
            store::trust_discover,
            store::trust_runtime_snapshot,
            store::trust_profile_list,
            store::trust_profile_validate,
            store::trust_profile_stage,
            store::trust_profile_proposal_status,
            store::trust_profile_approve,
            store::trust_profile_reject,
            store::trust_profile_revoke,
            store::trust_suppression_create,
            store::trust_suppression_revoke,
            store::trust_suppression_list,
            store::sessions_issues,
            store::findings_groups_safe,
            store::decision_matrix_safe,
            store::decision_matrix,
            findings_freshness,
            store::skills_doctor_report,
            store::skills_scan_cancel,
            store::skills_snapshot_save,
            store::skills_diff_latest,
            store::skills_export_pick_path,
            store::skills_export_redacted,
            store::skills_scan_settings,
            store::save_skills_scan_settings,
            store::issue_transition,
            store::issue_groups_list,
            store::issue_group_instances,
            store::issue_instance_read,
            peek_nav_target,
            clear_nav_target,
            focus_session,
            peek_focus_target,
            clear_focus_target,
            focus_budget_from_notification,
            capture_workbench_screenshot,
            ]);
            move |invoke: tauri::ipc::Invoke| {
                // The official fixture plugin must not inherit authority/log APIs.
                if invoke.message.webview().label().starts_with("plugin-")
                    && !matches!(invoke.message.command(), "plugin_message" | "plugin_request") {
                    invoke.resolver.reject("plugin_command_unavailable");
                    return true;
                }
                handler(invoke)
            }
        })
        .setup(|app| {
            let _ = BUNDLED_RESOURCE_DIR.set(app.path().resource_dir()?);
            if let Err(error) = agent_vitals_runtime::statistics_timezone::apply(
                &overview::data_home(),
            ) {
                agent_vitals_runtime::logging::log_warn("timezone", &format!("unavailable: {error}"));
            }
            // 记下系统区域：CLI / MCP 不读系统偏好，靠这份提示算出与 app 相同的默认报告币种
            // （并列报价的「默认假设」据此挑套）。
            let _ = agent_vitals_runtime::core::fx_settings::save_locale_hint(&overview::data_home(), &system_locale());
            start_public_pricing_catalog_tick();
            // 菜单栏工具：启动必须显式 `.accessory`（基线形态：无 Dock 图标），光靠
            // Info.plist 的 LSUIElement 不够——tao 的事件循环启动时会显式
            // setActivationPolicy(Regular) 把 plist 值盖掉（2026-09-14：删掉这行改用
            // plist 后，release 包 open 起来鸟头落进 Dock、状态栏项不出现）。
            // skipTaskbar/visible:false 只藏窗口，藏不住进程的 Dock 图标。
            // 2026-10-09 起：首次唤起工作台时 Dock 图标单向出现（会话内不隐藏，
            // 点图标走 Reopen 重开）；逆向 Transform 会间歇性卡死再唤起，不做。
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            recover_billing_recalculations(
                agent_vitals_data::authority::default_authority_path(&overview::data_home()),
            );
            let authority_path = agent_vitals_data::authority::default_authority_path(&overview::data_home());
            match agent_vitals_data::authority::AuthorityDb::open(
                &authority_path,
                agent_vitals_runtime::sql_sync::now_ms(),
            ) {
                Ok(db) => {
                    if let Err(error) = agent_vitals_data::issues::repair_issue_timestamp_units(db.conn()) {
                        agent_vitals_runtime::logging::log_warn("migration", &format!("issue timestamp units failed: {error}"));
                    }
                }
                Err(error) => agent_vitals_runtime::logging::log_warn("migration", &format!("issue timestamp units: database unavailable: {error}")),
            }
            let ov = overview_snapshot_typed_sync();
            let menu = build_menu(app.handle(), ov.as_ref())?;
            TrayIconBuilder::with_id("main")
                .icon(tray_template_icon()?)
                .icon_as_template(true)
                .title(today_title(&ov))
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| {
                    let id = event.id().as_ref();
                    match id {
                        "workbench" => show_workbench(app),
                        "refresh" => sync_now(app),
                        _ => {
                            let harnesses = app
                                .state::<HarnessesCache>()
                                .0
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .clone();
                            if let Some(target) = workbench_target_for_menu_id(id, &harnesses) {
                                focus_session_target(app, target);
                            } else if let Some(tab) = tab_for_menu_id(id) {
                                focus_tab(app, tab);
                            }
                        }
                    }
                })
                .build(app)?;
            let (wake, watcher_handle) = start_source_watcher(app.handle());
            app.manage(WatcherSupervisor(std::sync::Mutex::new(Some(watcher_handle))));
            start_watcher_health_publisher(app.handle().clone());
            start_refresh_tick(app.handle().clone(), wake);
            start_trust_monitor_tick(app.handle().clone());
            let args: Vec<String> = std::env::args().collect();
            if should_show_workbench_on_start(&ov.sync, &args) {
                show_workbench(app.handle());
            }
            // SQL 权威库后台预热：app 启动就 spawn 一轮 data-status（sub-second）
            // 让权威库 SQLite handle + page cache 在用户点会话/findings tab 之前
            // 就绪，避免首点 PRAGMA / planner 抖动（见 warm_authority_db 函数注释）。
            warm_authority_db(app.handle());
            Ok(())
        })
        .build(context)
        .expect("error while building agent-vitals menubar")
        .run(|app, event| {
            // 点 Dock 图标重开工作台（应用常驻 Dock 后，这是与菜单栏入口并列的唤起路径）。
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                agent_vitals_runtime::logging::log_info("workbench", "dock reopen event");
                show_workbench(app);
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = (app, event);
            }
        });
}

#[cfg(test)]
mod tests {
    #[test]
    fn manifest_catalog_http_enforces_stream_limits_and_refuses_redirects() {
        use std::io::{Read, Write};
        fn server(response: &'static [u8]) -> (String, std::thread::JoinHandle<()>) {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let worker = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
                let mut request = [0; 4096];
                let bytes_read = stream.read(&mut request).unwrap();
                assert!(bytes_read > 0, "client should send an HTTP request");
                stream.write_all(response).unwrap();
            });
            (url, worker)
        }
        let (url, worker) = server(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n5\r\nhello\r\n5\r\nworld\r\n0\r\n\r\n");
        let result = tauri::async_runtime::block_on(async {
            super::fetch_official_manifest_bytes(&super::manifest_catalog_client().unwrap(), &url, 6).await
        });
        assert!(result.unwrap_err().contains("bytes limit"));
        worker.join().unwrap();
        let (url, worker) = server(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        let result = tauri::async_runtime::block_on(async {
            super::fetch_official_manifest_bytes(&super::manifest_catalog_client().unwrap(), &url, 6).await
        });
        assert!(result.unwrap_err().contains("HTTP 302"));
        worker.join().unwrap();
    }

    #[test]
    fn manifest_catalog_floor_recovers_from_cached_index() {
        let data_home = std::env::temp_dir().join(format!(
            "agent-vitals-catalog-floor-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
        ));
        let path = super::manifest_catalog_cache_path(&data_home);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let bytes = br#"{"index_schema_version":1,"catalog_sequence":7,"published_at":"2026-10-01T00:00:00Z","entries":[]}"#;
        std::fs::write(&path, bytes).unwrap();
        let support = super::manifest_catalog_slot_support();
        let app_version = agent_vitals_harnesses::generic_manifest::CapabilitySet::default().app_version;
        let mut status = super::ManifestCatalogStatus::default();
        let result = super::accepted_manifest_catalog_floor(&data_home, &status, &support, &app_version).unwrap();
        assert_eq!(result.as_ref().map(|(sequence, _)| *sequence), Some(7));
        status.catalog_sequence = Some(7);
        status.index_sha256 = Some("0".repeat(64));
        assert!(super::accepted_manifest_catalog_floor(&data_home, &status, &support, &app_version).is_err());
        status.catalog_sequence = Some(8);
        assert_eq!(super::accepted_manifest_catalog_floor(&data_home, &status, &support, &app_version).unwrap(),
            Some((8, "0".repeat(64))));
        status.catalog_sequence = Some(6);
        assert_eq!(super::accepted_manifest_catalog_floor(&data_home, &status, &support, &app_version).unwrap()
            .as_ref().map(|(sequence, _)| *sequence), Some(7));
        std::fs::write(super::manifest_catalog_status_path(&data_home), b"{corrupt").unwrap();
        assert!(super::read_manifest_catalog_status_for_update(&data_home).is_err());
        assert_eq!(std::fs::read(super::manifest_catalog_status_path(&data_home)).unwrap(), b"{corrupt");
        std::fs::write(&path, vec![b' '; super::MANIFEST_CATALOG_INDEX_MAX_BYTES + 1]).unwrap();
        assert!(super::accepted_manifest_catalog_floor(&data_home, &status, &support, &app_version)
            .unwrap_err().contains("index_bytes_limit"));
        std::fs::remove_dir_all(&data_home).unwrap();
    }

    #[test]
    fn manifest_catalog_chunk_limit_is_enforced_without_content_length() {
        let mut bytes = Vec::new();
        super::append_manifest_catalog_chunk(&mut bytes, &[1, 2]).unwrap();
        super::append_manifest_catalog_chunk(&mut bytes,
            &vec![0; super::MANIFEST_CATALOG_INDEX_MAX_BYTES - 2]).unwrap();
        assert_eq!(bytes.len(), super::MANIFEST_CATALOG_INDEX_MAX_BYTES);
        assert!(super::append_manifest_catalog_chunk(&mut bytes, &[3]).is_err());
        assert_eq!(bytes.len(), super::MANIFEST_CATALOG_INDEX_MAX_BYTES);
    }

    #[test]
    fn official_usd_card_is_returned_in_its_own_currency_never_converted() {
        let result = super::official_price_card(
            "anthropic".to_string(),
            "anthropic/claude-sonnet-5".to_string(),
        );
        assert_eq!(result["found"], true, "{result}");
        assert_eq!(result["currency"], "USD", "官方卡原样带着它的报价币种");
        // 没有换算：美元价是个位数到两位数，乘 7 以上的汇率会明显更大
        let output = result["rates"]["output"]["off_peak"].as_f64().unwrap();
        assert!(output > 0.0 && output < 100.0, "USD 价格未被换算：{output}");
        assert!(result.get("reason").is_none());
    }
    #[test]
    fn native_menu_language_follows_first_system_language() {
        assert_eq!(language_from_system_list("(\n    \"en-US\",\n    \"zh-Hans\"\n)"), NativeUiLanguage::English);
        assert_eq!(language_from_system_list("(\n    \"zh-Hans-CN\",\n    \"en-US\"\n)"), NativeUiLanguage::Chinese);
        assert_eq!(language_from_system_list("(\n    \"de-DE\"\n)"), NativeUiLanguage::English);
        assert_eq!(native_label(NativeUiLanguage::English, "Sync now", "立即同步"), "Sync now");
        assert_eq!(native_label(NativeUiLanguage::Chinese, "Sync now", "立即同步"), "立即同步");
    }

    #[test]
    fn overview_details_snapshot_reports_one_stable_authority_revision() {
        let root = std::env::temp_dir().join(format!("agent-vitals-overview-snapshot-{}", std::process::id()));
        let path = agent_vitals_data::authority::default_authority_path(&root);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let _db = agent_vitals_data::authority::AuthorityDb::open(&path, agent_vitals_runtime::core::clock::now_ms()).unwrap();
        let result = overview_details_snapshot_at(root.clone(), "2026-09", "2026-09-24");
        assert_eq!(result["month"], "2026-09");
        assert_eq!(result["date"], "2026-09-24");
        assert_eq!(result["is_consistent"], true);
        assert!(result["authority_revision"].as_u64().is_some());
        assert!(result["monthly"].is_object());
        assert!(result["daily"].is_object());
        assert!(result["calendar"].is_object());
        // 空库 = 读到零失败（对象空 hours），不是 null——降级语义只在库不可用时出现。
        assert_eq!(result["failure_hours"]["date"], "2026-09-24");
        assert_eq!(result["failure_hours"]["hours"].as_object().unwrap().len(), 0);
        // 失败日（趋势图周/月档）：窗口回溯 30 天到请求日；空库同样是读到零失败。
        assert_eq!(result["failure_days"]["to"], "2026-09-24");
        assert_eq!(result["failure_days"]["from"], "2026-08-25");
        assert_eq!(result["failure_days"]["days"].as_object().unwrap().len(), 0);
        assert!(result["errors"].as_array().unwrap().is_empty());
        drop(_db);
        std::fs::remove_dir_all(root).ok();
    }

    /// R4-P0 活动门控（TRUST_SENSOR_OPTIMIZATION spec §6 门控三行 + 活动表
    /// 行为）：空闲跳过、活跃立即恢复、确认窗到期强制校准；表条目按时限
    /// 裁剪有界。
    #[test]
    fn trust_activity_gate_skips_idle_and_forces_calibration() {
        use std::time::Duration;
        // 活动表空 + 空闲确认窗内 → 不采样。
        assert!(!trust_gate_should_sample(false, false, Duration::from_secs(60)));
        assert!(trust_gate_should_sample(true, false, Duration::from_secs(0)), "开启后首轮立即采样");
        // 活动表刚刷新 → 立即恢复采样。
        assert!(trust_gate_should_sample(false, true, Duration::from_secs(0)));
        assert!(trust_gate_should_sample(false, true, Duration::from_secs(3_600)));
        // 空闲确认窗到期 → 强制校准轮执行（兜活动表漏记）。
        assert!(trust_gate_should_sample(false, false, TRUST_IDLE_CONFIRM_WINDOW));
        assert!(trust_gate_should_sample(false, false, TRUST_IDLE_CONFIRM_WINDOW + Duration::from_secs(1)));

        let table = HarnessActivityTable(std::sync::Mutex::new(std::collections::BTreeMap::new()));
        assert!(!table.any_active_within(TRUST_ACTIVITY_COOLDOWN), "空表不算活跃");
        table.mark(["claude-code"]);
        assert!(table.any_active_within(TRUST_ACTIVITY_COOLDOWN), "刚标记必须活跃");
        // 过期条目不再算活跃（用比冷却窗更长的 elapsed 模拟）。
        {
            let mut guard = table.0.lock().unwrap();
            for at in guard.values_mut() {
                *at = std::time::Instant::now()
                    - (TRUST_ACTIVITY_COOLDOWN + TRUST_IDLE_CONFIRM_WINDOW);
            }
        }
        assert!(!table.any_active_within(TRUST_ACTIVITY_COOLDOWN), "过期条目不算活跃");
        // 重新标记后，超时限的旧条目被裁剪（表有界）。
        table.mark(["codex"]);
        let guard = table.0.lock().unwrap();
        assert_eq!(guard.len(), 1, "裁剪后只剩活跃条目");
        assert!(guard.contains_key("codex"));
    }

    /// 收敛调查 §5.2.1（P2a）：托盘节流窗与轻 tick 节奏的隐含耦合变成会红的
    /// 测试——窗口必须骑在重 tick 周期上（≥ TICK_PERIOD），且显著大于轻 tick
    /// 的最小可达间隔（WATCHER_SYNC_COOLDOWN + 一次典型轻 tick 的预算）。
    /// 60s 时代这条测试是红的（60 < 300）；改回任何过小取值会立刻再红。
    #[test]
    fn tray_refresh_interval_respects_tick_regime() {
        use std::time::Duration;
        let cooldown =
            agent_vitals_runtime::ingest::watch::WATCHER_SYNC_COOLDOWN;
        let light_tick_typical = Duration::from_secs(10);
        assert!(
            TRAY_REFRESH_INTERVAL >= TICK_PERIOD,
            "托盘节流窗必须 ≥ 重 tick 周期（骑重 tick 口径）: {TRAY_REFRESH_INTERVAL:?} < {TICK_PERIOD:?}"
        );
        assert!(
            TRAY_REFRESH_INTERVAL > cooldown + light_tick_typical,
            "托盘节流窗必须显著大于轻 tick 最小可达间隔（冷却 + 典型耗时）:              {TRAY_REFRESH_INTERVAL:?} <= {cooldown:?} + {light_tick_typical:?}"
        );
    }

    use super::*;

    /// 2026-09-22 真机验收抓出的字段名 bug：`data_status.data.pricing` 里
    /// 真实字段是 `latest_version`，读错成 `version` 会让诊断包的
    /// `versions.pricing` 永远是 `null`，即使价目表数据本身齐全。
    #[test]
    fn diagnostic_pricing_version_reads_the_real_field_name() {
        let status = serde_json::json!({
            "data": { "pricing": { "latest_version": "abc123", "stale": false } }
        });
        assert_eq!(diagnostic_pricing_version(&status), serde_json::json!("abc123"));
    }

    #[test]
    fn diagnostic_pricing_version_is_null_when_absent_not_an_error() {
        assert_eq!(diagnostic_pricing_version(&serde_json::json!({})), Value::Null);
        let no_pricing_key = serde_json::json!({ "data": {} });
        assert_eq!(diagnostic_pricing_version(&no_pricing_key), Value::Null);
    }

    /// R2 备忘并发与防陈旧（REFRESH_STORM spec §9 R2 行）。两个断言族：
    /// - 8 路并发同 revision 走**异步入口**（`run_heavy_read` + ReadGate 2
    ///   permits + 拿到许可后双检查）——实际全量计算 ∈ [1,
    ///   HEAVY_READ_PERMITS]，其余排队后命中；8 份返回值逐字节一致。这是
    ///   「同 revision 突发 N 个并发 invoke 的实际计算 ≤ permits」契约的钉子。
    /// - 写回防陈旧（槽内 revision ≥ 本次不覆盖）与跨 data_home 隔离（并行
    ///   测试 tmp 目录互不串槽，`MonthlySummaryMemo` 同款键纪律）。
    ///
    /// env：不碰进程级变量——直接调 `overview_snapshot_value_async_at` 注入
    /// tmp home；其余 desktop 测试都显式传 home，互不影响。
    #[test]
    fn overview_memo_concurrency_and_stale_guard() {
        let home = tmp_home("ovmemo");
        let path = agent_vitals_data::authority::default_authority_path(&home);
        {
            let db = agent_vitals_data::authority::AuthorityDb::open(&path, 1).unwrap();
            db.with_immediate_txn(|conn| {
                conn.execute(
                    "INSERT INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version)
                     VALUES ('ovmemo', 1, 'cli', 'succeeded', 1)",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        }
        let revision = authority_revision_at(&path).expect("写入后 revision 必可读");
        assert!(revision >= 1, "含行变更的事务必须推进 revision");

        let computed_before = overview_memo()
            .computed
            .load(std::sync::atomic::Ordering::Relaxed);
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
        let mut handles = Vec::new();
        for _ in 0..8 {
            let barrier = std::sync::Arc::clone(&barrier);
            let thread_home = home.clone();
            handles.push(std::thread::spawn(move || {
                barrier.wait();
                tauri::async_runtime::block_on(overview_snapshot_value_async_at(thread_home))
            }));
        }
        let mut values = Vec::new();
        for (i, handle) in handles.into_iter().enumerate() {
            values.push(handle.join().unwrap_or_else(|_| panic!("并发读 #{i} 不得 panic")));
        }
        let first = &values[0];
        assert!(!first.is_null(), "空库降级也必须返回投影对象，不是 Null");
        for (i, value) in values.iter().enumerate() {
            assert_eq!(value, first, "并发同 revision 的 #{i} 号返回必须与首份一致");
        }
        let permits = agent_vitals_runtime::query::read_gate::HEAVY_READ_PERMITS as u64;
        let computed_delta =
            overview_memo().computed.load(std::sync::atomic::Ordering::Relaxed) - computed_before;
        assert!(
            (1..=permits).contains(&computed_delta),
            "8 路并发同 revision 的实际计算次数必须 ∈ [1, {permits}]，实测 {computed_delta}"
        );

        // ② 防陈旧 + 跨 home：直接操纵槽（单槽语义），用标记值区分覆盖与否。
        let data_home = home.display().to_string();
        let (ov, value) = overview_memo_get(revision, &data_home)
            .expect("并发阶段计算后槽内必有值");
        assert!(
            overview_memo_get(revision, "/nonexistent/other-home").is_none(),
            "跨 data_home 不得串槽"
        );
        let stale_marker = serde_json::json!({ "stale": true });
        overview_memo_put(revision - 1, data_home.clone(), std::sync::Arc::clone(&ov), stale_marker);
        let (_, after_stale) = overview_memo_get(revision, &data_home).expect("槽仍应是新 revision");
        assert_eq!(after_stale, value, "旧 revision 写回不得覆盖新值");
        let advance_marker = serde_json::json!({ "advance": true });
        overview_memo_put(revision + 1, data_home.clone(), ov, advance_marker.clone());
        let (ov, after_advance) =
            overview_memo_get(revision + 1, &data_home).expect("前进写回应生效");
        assert_eq!(after_advance, advance_marker, "更新的 revision 写回必须生效");

        // 执行环境和同步快照独立于 authority revision 更新，必须使同 revision 缓存失效。
        std::fs::create_dir_all(home.join("state")).unwrap();
        std::fs::write(home.join("state/harnesses.json"), "{} ").unwrap();
        assert!(overview_memo_get(revision + 1, &data_home).is_none(), "执行环境快照变化必须失效");
        overview_memo_put(revision + 1, data_home.clone(), ov, advance_marker);
        std::fs::write(home.join("state/last-sync.json"), "{} ").unwrap();
        assert!(overview_memo_get(revision + 1, &data_home).is_none(), "同步状态变化必须失效");
    }

    fn tmp_home(tag: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!(
            "avdesk-diag-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    /// 诊断包 v2 的事件总线积压快照——库缺席报 `unavailable` 不编造零；
    /// 有数据时三个计数各自独立（outbox 总数 / deliveries 总数 / 带
    /// `last_error` 的 deliveries 数不能是同一个数字，否则说明查询写错了
    /// WHERE 子句）。
    #[test]
    fn event_bus_backlog_snapshot_counts_without_reading_content() {
        let home = tmp_home("backlog");
        assert_eq!(
            event_bus_backlog_snapshot(&home),
            serde_json::json!({ "status": "unavailable" }),
            "missing database must report unavailable, not fabricate zero counts",
        );

        let path = agent_vitals_data::authority::default_authority_path(&home);
        {
            let db = agent_vitals_data::authority::AuthorityDb::open(&path, 1).unwrap();
            db.with_immediate_txn(|conn| {
                conn.execute(
                    "INSERT INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version)
                     VALUES ('run', 1, 'cli', 'succeeded', 1)", [],
                )?;
                for i in 0..3 {
                    conn.execute(
                        &format!(
                            "INSERT INTO event_outbox(event_id, event_type, schema_version, occurred_at_ms,
                                 harness, correlation_id, producer, payload_json, ingested_run_id, created_at_ms)
                             VALUES ('evt-{i}', 'FactsIngested', 1, 1, 'dsh', 'run', 'sync_service', '{{}}', 'run', 1)"
                        ),
                        [],
                    )?;
                }
                // 两条投递记录：一条干净，一条带 last_error——三个计数必须互不相等。
                conn.execute(
                    "INSERT INTO event_deliveries(event_id, consumer_id, delivered_at_ms, last_error, retry_count)
                     VALUES ('evt-0', 'desktop-ui', 1, NULL, 0)", [],
                )?;
                conn.execute(
                    "INSERT INTO event_deliveries(event_id, consumer_id, delivered_at_ms, last_error, retry_count)
                     VALUES ('evt-1', 'price-reconcile', 1, 'boom', 1)", [],
                )?;
                Ok(())
            }).unwrap();
        }

        let snapshot = event_bus_backlog_snapshot(&home);
        assert_eq!(snapshot["status"], "ok");
        assert_eq!(snapshot["outbox_rows"], 3);
        assert_eq!(snapshot["delivery_rows"], 2);
        assert_eq!(snapshot["delivery_rows_with_last_error"], 1);
        // 脱敏/只数不读的纪律：快照里不能出现 "boom"（那是 last_error 的原文）。
        assert!(!snapshot.to_string().contains("boom"));

        let _ = std::fs::remove_dir_all(&home);
    }

    /// watcher_health DTO 的形状纪律（HARDENING spec §5.6/§7「desktop IPC」行）：
    /// 闭集 mode 字符串、原因码来自闭集、**无任何路径/错误串字段**、
    /// 未启动 watcher 的缺省快照 = disabled。
    #[test]
    fn watcher_health_payload_is_bounded_and_path_free() {
        let payload = watcher_health_payload(None);
        assert_eq!(payload.get("mode"), Some(&serde_json::json!("disabled")));
        let allowed_modes = ["active", "degraded", "disabled", "unavailable"];
        assert!(allowed_modes.contains(&payload.get("mode").and_then(|m| m.as_str()).unwrap_or("")));
        let serialized = payload.to_string();
        for forbidden in ["\"path\"", "\"root\"", "error"] {
            assert!(!serialized.contains(forbidden), "DTO 不得携带 {forbidden}: {serialized}");
        }
        // 有句柄时的健康面：字段齐全（desktop 启用 watcher feature，句柄
        // 非 noop；健康快照由 worker 异步写，这里只钉字段存在性）。
        use agent_vitals_runtime::ingest::watch::TickWaker;
        let waker = TickWaker::channel().waker;
        let registry = agent_vitals_runtime::ingest::watch::WatchRegistry::new();
        let handle = agent_vitals_runtime::ingest::watch::spawn_watcher(registry, waker);
        let payload = watcher_health_payload(Some(&handle));
        for field in ["mode", "schema_version", "topology_revision", "facts_roots_registered", "pending_roots"] {
            assert!(payload.get(field).is_some(), "缺字段 {field}");
        }
    }

    #[test]
    fn findings_freshness_never_calls_missing_sync_complete() {
        assert_eq!(findings_freshness_state(&serde_json::json!({"last_successful_sync_at": null, "stale_harnesses": []})), "not_yet_synced");
        assert_eq!(findings_freshness_state(&serde_json::json!({"last_successful_sync_at": "2026-09-20T12:00:00+08:00", "stale_harnesses": ["generic"]})), "stale");
        assert_eq!(findings_freshness_state(&serde_json::json!({"last_successful_sync_at": "2026-09-20T12:00:00+08:00", "stale_harnesses": []})), "fresh");
        assert_eq!(findings_freshness_state(&serde_json::json!({"last_successful_sync_at": "not-a-timestamp", "stale_harnesses": []})), "unknown");
        assert_eq!(findings_freshness_state(&serde_json::json!({"last_successful_sync_at": "2026-09-20T12:00:00+08:00"})), "unknown");
        assert_eq!(findings_freshness_state(&serde_json::json!({"last_successful_sync_at": "2026-09-20T12:00:00+08:00", "stale_harnesses": [42]})), "unknown");
    }

    #[test]
    fn findings_freshness_harness_projection_is_bounded() {
        assert_eq!(findings_safe_harness_label(&serde_json::json!("zcode")), "zcode");
        assert_eq!(findings_safe_harness_label(&serde_json::json!("plugin:zcode")), "plugin:zcode");
        assert_eq!(findings_safe_harness_label(&serde_json::json!("plugin:../escape")), "generic");
        assert_eq!(findings_safe_harness_label(&serde_json::json!("/Users/Admin/private")), "generic");
        assert_eq!(findings_safe_harness_label(&serde_json::json!("harness with spaces")), "generic");
    }

    /// 规格 R6：「接受」不再是候选的直接决定——它曾经只翻状态、不归因、不重算，
    /// 用户以为确认了而数字没变。dismiss/reopen 照旧。
    #[test]
    fn candidate_accept_is_no_longer_a_direct_decision() {
        assert!(candidate_decision_status("accept").is_err());
        assert_eq!(candidate_decision_status("dismiss"), Ok("dismissed"));
        assert_eq!(candidate_decision_status("reopen"), Ok("pending"));
        assert!(candidate_decision_status("approve").is_err());
    }

    /// 规格 R4 + B3（2026-09-16 起结束日期改为选填）：`unknown` 不是声明；起始必填
    /// 且真实存在；结束留空＝开放到未来，填了则不早于起始、不晚于今天。
    #[test]
    fn desktop_declaration_is_bounded_when_dated_and_open_ended_when_blank() {
        // `unknown` 永远不是声明；起始必须是一个真实存在的日期。
        assert!(validate_desktop_declaration("unknown", "2026-07", Some("2026-09-30")).is_err());
        assert!(validate_desktop_declaration("official_api", "", None).is_err());
        assert!(validate_desktop_declaration("official_api", "2026-13-01", None).is_err());
        assert!(validate_desktop_declaration("official_api", "2026-07", None).is_ok());
        // 结束是选填的：None / 空串 / 纯空白都表示「持续有效」（按量充值没有结束日）。
        assert!(validate_desktop_declaration("official_subscription", "2026-07-01", None).is_ok());
        assert!(validate_desktop_declaration("official_subscription", "2026-07-01", Some("")).is_ok());
        assert!(validate_desktop_declaration("official_subscription", "2026-07-01", Some("  ")).is_ok());
        // 填了就必须是一段真实可行的区间：不早于起始、不晚于今天（北京时间）。
        assert!(validate_desktop_declaration("official_subscription", "2026-08-15", Some("2026-08-14")).is_err());
        // 「晚于今天」用一个永远在未来的日期：写死某个具体日期，到了那天它就变成合法的今天（2026-10-01 踩到）。
        assert!(validate_desktop_declaration("official_subscription", "2026-07-01", Some("2099-01-01")).is_err());
        assert!(validate_desktop_declaration("official_subscription", "2026-07-01", Some("2026-09-15")).is_ok());
        assert!(validate_desktop_declaration("organization", "2026-09-01", Some("2026-09-15")).is_ok());
    }


    /// W3：同步状态映射。成功必须是 `complete`（React 唯一认的正常态）；执行环境级文件
    /// 错误不让整轮失败但要写进 message；整轮失败 / 暂停 / 开关不可读各有阶段名。
    #[test]
    fn sync_status_maps_engine_outcomes() {
        use agent_vitals_runtime::ingest::engine::SyncRun;
        use agent_vitals_runtime::ingest::sync_service::{HarnessSyncReport, SyncReport};
        let ok = status_from_run(&SyncRun::Completed(SyncReport { total_appended: 2, ..Default::default() }));
        assert!(ok.ok);
        assert_eq!((ok.stage.as_str(), ok.message.as_str()), ("complete", "新增 2 条"));
        let mut report = SyncReport::default();
        report.harnesses.push(HarnessSyncReport { harness: "dsh".into(), errors: vec!["x".into()], ..Default::default() });
        let partial = status_from_run(&SyncRun::Completed(report));
        assert!(partial.ok, "执行环境级文件错误不让整轮失败");
        assert!(partial.message.contains("1 个文件读取失败"));
        let failed = status_from_run(&SyncRun::Failed("disk full".into()));
        assert!(!failed.ok);
        assert_eq!((failed.stage.as_str(), failed.message.as_str()), ("facts", "disk full"));
        assert_eq!(status_from_run(&SyncRun::Paused).stage, "paused");
        assert!(!status_from_run(&SyncRun::ControlUnreadable("io".into())).ok);
    }

    #[test]
    fn dynamic_harness_receipts_are_safe_and_retry_replaces_failure() {
        use agent_vitals_runtime::ingest::sync_service::{HarnessSyncReport, SyncReport};
        for (raw, expected) in [
            ("permission denied at /private/log.json", "permission_denied"),
            ("manifest parse failed at /private/manifest.json", "manifest_or_source_invalid"),
            ("manifest lease lock held", "source_busy"),
            ("authority database sqlite unavailable", "authority_unavailable"),
            ("source file read failed at /private/input.jsonl", "source_unavailable"),
            ("unexpected internal failure /private/path", "ingest_failed"),
        ] {
            assert_eq!(classify_dynamic_harness_error(raw), expected);
        }
        let mut failed = SyncReport::default();
        failed.harnesses.push(HarnessSyncReport {
            harness: "harness:zcode".into(),
            errors: vec!["manifest parse failed at /Users/private/secret.json".into()],
            ..Default::default()
        });
        let failure = dynamic_harness_receipts(&failed);
        assert_eq!(failure.len(), 1);
        assert_eq!(failure[0].state, "failed");
        assert_eq!(failure[0].error_code.as_deref(), Some("manifest_or_source_invalid"));
        assert!(!serde_json::to_string(&failure).unwrap().contains("/Users/private"));
        assert!(!serde_json::to_string(&failure).unwrap().contains("secret.json"));

        let mut recovered = SyncReport::default();
        recovered.harnesses.push(HarnessSyncReport { harness: "harness:zcode".into(), ..Default::default() });
        let retry = dynamic_harness_receipts(&recovered);
        assert_eq!(retry[0].state, "empty", "zero-event success is still an observed success");
        assert_eq!(retry[0].error_code, None, "successful retry clears prior error");
    }

    #[test]
    fn dynamic_harness_source_projection_combines_active_history_and_receipt() {
        use agent_vitals_runtime::ingest::sync_service::{HarnessSyncReport, SyncReport};
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE extension_active(singleton INTEGER, generation INTEGER);
            CREATE TABLE extension_activation_slots(generation INTEGER, slot_type TEXT, slot_id TEXT);
            CREATE TABLE extension_revisions(revision_id TEXT, slot_type TEXT, slot_id TEXT);
            CREATE TABLE source_files(harness TEXT, last_seen_at_ms INTEGER, last_error_code TEXT);
            CREATE TABLE usage_facts(harness TEXT, deleted_at_ms INTEGER, observation_kind TEXT,
                session_key TEXT, event_ts_ms INTEGER);
            INSERT INTO extension_active VALUES(1, 3);
            INSERT INTO extension_activation_slots VALUES(3, 'harness_manifest', 'zcode');
            INSERT INTO extension_revisions VALUES('retired-revision', 'harness_manifest', 'retired-agent');
            INSERT INTO source_files VALUES('harness:oldplug', 100, NULL);
            INSERT INTO usage_facts VALUES('harness:oldplug', NULL, 'event', 's1', 90);")
            .unwrap();
        let data_home = std::env::temp_dir().join(format!("av-dynamic-receipt-{}-{}", std::process::id(),
            agent_vitals_runtime::core::clock::now_ms()));
        let mut failed_report = SyncReport::default();
        failed_report.harnesses.push(HarnessSyncReport {
            harness: "harness:zcode".into(),
            errors: vec!["source file read failed at /Users/private/events.jsonl".into()],
            ..Default::default()
        });
        let failed_status = status_from_run(&agent_vitals_runtime::ingest::engine::SyncRun::Completed(failed_report));
        overview::save_sync_status_at(&data_home, &failed_status);
        let persisted_failure = overview::load_sync_status(&data_home);
        assert_eq!(persisted_failure.dynamic_harnesses[0].error_code.as_deref(), Some("source_unavailable"));
        let mut report = serde_json::json!({"status":"ok","sources":[]});
        merge_dynamic_harness_sources(&mut report, &conn, &persisted_failure.dynamic_harnesses);
        let rows = report["sources"].as_array().unwrap();
        assert_eq!(rows.len(), 3);
        let active = rows.iter().find(|row| row["harness"] == "harness:zcode").unwrap();
        assert_eq!(active["registration_state"], "active");
        assert_eq!(active["connection_state"], "needs_attention");
        assert_eq!(active["failed_scope"]["error_codes"][0], "source_unavailable");
        assert!(!active.to_string().contains("/Users/"));
        let history = rows.iter().find(|row| row["harness"] == "harness:oldplug").unwrap();
        assert_eq!(history["registration_state"], "historical");
        assert_eq!(history["connection_state"], "connected");
        let revision_only = rows.iter().find(|row| row["harness"] == "harness:retired-agent").unwrap();
        assert_eq!(revision_only["registration_state"], "historical");
        assert_eq!(revision_only["connection_state"], "not_detected");

        let mut success_report = SyncReport::default();
        success_report.harnesses.push(HarnessSyncReport { harness: "harness:zcode".into(), ..Default::default() });
        let recovered_status = status_from_run(&agent_vitals_runtime::ingest::engine::SyncRun::Completed(success_report));
        overview::save_sync_status_at(&data_home, &recovered_status);
        let persisted_recovery = overview::load_sync_status(&data_home);
        assert_eq!(persisted_recovery.dynamic_harnesses[0].state, "empty");
        assert_eq!(persisted_recovery.dynamic_harnesses[0].error_code, None);
        let mut recovered_projection = serde_json::json!({"status":"ok","sources":[]});
        merge_dynamic_harness_sources(&mut recovered_projection, &conn, &persisted_recovery.dynamic_harnesses);
        let recovered = recovered_projection["sources"].as_array().unwrap().iter()
            .find(|row| row["harness"] == "harness:zcode").unwrap();
        assert_eq!(recovered["connection_state"], "connected");
        assert_eq!(recovered["failed_scope"]["error_codes"], serde_json::json!([]));
        assert_eq!(recovered["failed_scope"]["last_attempt"]["state"], "empty");
        let _ = std::fs::remove_dir_all(data_home);
    }

    #[test]
    fn first_value_workspace_only_opens_before_any_sync_receipt() {
        assert!(should_show_first_value_workspace(&SyncStatus::fail("never", "尚未同步".into())));
        assert!(!should_show_first_value_workspace(&SyncStatus::ok("discover", "no records".into())));
        assert!(!should_show_first_value_workspace(&SyncStatus::fail("partial", "disk full".into())));
    }


    #[test]
    fn source_status_applies_real_scanner_failure_only_to_named_harness() {
        let mut report = serde_json::json!({ "sources": [
            { "harness": "claude-code", "connection_state": "connected", "failed_scope": {} },
            { "harness": "codex", "connection_state": "connected", "failed_scope": {} },
            { "harness": "dsh", "connection_state": "not_detected", "failed_scope": {} }
        ]});
        let sync = SyncStatus::fail("partial", "DSH permission denied".into());
        merge_source_sync_failure(&mut report, &sync);
        assert_eq!(report["sources"][0]["connection_state"], "connected");
        assert_eq!(report["sources"][1]["connection_state"], "connected");
        assert_eq!(report["sources"][2]["connection_state"], "needs_attention");
        assert_eq!(report["sources"][2]["failed_scope"]["sync"]["stage"], "partial");
        assert_eq!(report["sources"][2]["failed_scope"]["sources"], 1);
        assert_eq!(report["sources"][2]["failed_scope"]["error_codes"], serde_json::json!(["permission_denied"]));
    }

    #[test]
    fn source_status_applies_unscoped_facts_failure_to_all_harnesses() {
        let mut report = serde_json::json!({ "sources": [
            { "harness": "claude-code", "connection_state": "connected", "failed_scope": {} },
            { "harness": "codex", "connection_state": "connected", "failed_scope": {} },
            { "harness": "dsh", "connection_state": "connected", "failed_scope": {} }
        ]});
        merge_source_sync_failure(&mut report, &SyncStatus::fail("facts", "disk full".into()));
        assert!(report["sources"].as_array().unwrap().iter()
            .all(|s| s["connection_state"] == "needs_attention"));
    }

    /// Stage 0.6 的 Data Query API 面是薄转发，但"薄"也要钉住：DTO 与 CLI
    /// `data coverage` 同一份 `to_json()`（四执行环境 by_harness——WorkBuddy 自 E4b 起
    /// 接线，只有 token 没有金额，见 docs/WORKBUDDY_ONBOARDING_SPEC.md §9E.5——
    /// excluded 空 + coverage 4/4），托盘侧不许长出第二种形状。真机结构性断言
    /// （金额值随机器变，形状不随）。
    #[test]
    fn data_monthly_summary_dto_matches_the_frozen_contract_shape() {
        let d = tauri::async_runtime::block_on(data_monthly_summary(overview::current_month_beijing()));
        let keys: Vec<&String> = d["by_harness"].as_object().unwrap().keys().collect();
        assert_eq!(keys, ["claude-code", "codex", "dsh", "workbuddy"]);
        assert_eq!(d["excluded_harnesses"], serde_json::json!([]));
        assert_eq!(d["coverage"]["measured_fields"], 4);
        assert_eq!(d["coverage"]["total_fields"], 4);
        // WorkBuddy 行永远没有金额（三轨请求级不可判，§2.1）。
        assert_eq!(d["by_harness"]["workbuddy"]["amounts_by_basis"], serde_json::json!({}));
        // 冻结契约的三条不变式之一在托盘侧同样成立：excluded 与 by_harness 不相交。
        for harness in d["excluded_harnesses"].as_array().unwrap() {
            assert!(d["by_harness"].get(harness.as_str().unwrap()).is_none());
        }
    }

    /// Stage D 决策卡的数据面：`data_codex_quota` 返回 plan 快照原样
    /// （`plan_type` 必在——本机 Codex 60 份 rollout 全带 ChatGPT plan 字段）
    /// 或 null（无 rollout/无 plan 事件，不得编造余量）。函数级断言；invoke
    /// 路由由真实 app 的决策卡目视验收。
    #[test]
    fn data_codex_quota_returns_plan_snapshot_or_null() {
        let q = data_codex_quota();
        if let Some(p) = q {
            assert!(p.get("plan_type").and_then(|v| v.as_str()).is_some(),
                    "plan 快照缺 plan_type: {p}");
        }
        // null 分支 = 无证据，同样合法（不得编造）。
    }

    /// RUNTIME_INVALIDATION spec 验收 9.13：`ReadGate` 把并发重查询的执行钉在
    /// `HEAVY_READ_PERMITS`。三路并发 `spawn_blocking` 争抢一个容量为 2 的闸门，
    /// 用一把互斥锁记录「同时在临界区里的任务数」的峰值——峰值必须 ≤ 2。
    #[test]
    fn heavy_read_gate_bounds_concurrent_execution() {
        use agent_vitals_runtime::query::read_gate::ReadGate;
        let gate = std::sync::Arc::new(ReadGate::new(2));
        let concurrent = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let peak = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let handles: Vec<_> = (0..6).map(|_| {
            let gate = std::sync::Arc::clone(&gate);
            let concurrent = std::sync::Arc::clone(&concurrent);
            let peak = std::sync::Arc::clone(&peak);
            std::thread::spawn(move || {
                let _permit = gate.acquire();
                let now = concurrent.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                peak.fetch_max(now, std::sync::atomic::Ordering::SeqCst);
                std::thread::sleep(std::time::Duration::from_millis(20));
                concurrent.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
            })
        }).collect();
        for h in handles { h.join().unwrap(); }
        assert!(peak.load(std::sync::atomic::Ordering::SeqCst) <= 2,
            "concurrent executions under the gate must never exceed its permit count");
    }

    /// Token 日历的跨执行环境数据面（真机形状）：本机 2026-09 claude/codex 有
    /// 真实用量（DSH 才全零），日历聚合不得全零；钱的键分币齐全。
    #[test]
    fn read_calendar_month_is_cross_harness_not_dsh_only() {
        let v = tauri::async_runtime::block_on(read_calendar_month(overview::current_month_beijing()));
        let days = v["days"].as_object().expect("days map");
        let total: i64 = days.values().map(|d| d["total_tokens"].as_i64().unwrap_or(0)).sum();
        assert!(total > 0, "本机 2026-09 claude/codex 有真实用量，日历不得全零（got {total}）");
        // 有用量的日子 token 与钱键齐全（分币），形状=日历格子渲染的输入。
        for (date, d) in days {
            assert!(d.get("dsh_tokens").is_some() && d.get("claude_tokens").is_some()
                && d.get("codex_tokens").is_some(), "{date} 缺执行环境 token 键");
            assert!(d.get("dsh_cost_cny").is_some() && d.get("claude_cost_cny").is_some()
                && d.get("claude_cost_usd").is_some() && d.get("codex_cost_usd").is_some(),
                "{date} 缺分币耗费键");
        }
    }

    /// 当日按小时（旧 calendar.html 小时格组件接入）的数据面：真机形状 +
    /// 跨面守恒。codex 的小时来自 fold by_hour_model（全量历史），日历格里
    /// 同一天的 codex_tokens 来自同一 fold 的 by_model——小时和 ≤ 日总量
    /// （无时间样本的量只在 by_model，usage.rs 头注释），且来源标注合法。
    #[test]
    fn read_hourly_distribution_matches_authority_facts_day() {
        let month = overview::current_month_beijing();
        let cal = tauri::async_runtime::block_on(read_calendar_month(month.clone()));
        let days = cal["days"].as_object().expect("days map");
        // 找一个 codex 有用量的日子（本机 2026-09 codex 3.27 亿 token，必有）。
        let (date, day_row) = days.iter()
            .find(|(_, d)| d["codex_tokens"].as_i64().unwrap_or(0) > 0)
            .map(|(k, v)| (k.clone(), v.clone()))
            .expect("本机当月必有 codex 用量日");
        let v = tauri::async_runtime::block_on(read_hourly_distribution(date.clone()));
        assert_eq!(v["date"], serde_json::json!(date));
        let hours = v["hours"].as_array().expect("hours array");
        assert_eq!(hours.len(), 24, "24 小时全量输出（空小时 = null，不裁剪）");
        // 小时轴之和 ≤ 日历日总量（差 = 无时间样本，usage.rs 诚实缺口）。
        let hour_sum: i64 = hours.iter()
            .map(|h| h["codex_tokens"].as_i64().unwrap_or(0)).sum();
        let cal_total = day_row["codex_tokens"].as_i64().unwrap_or(0);
        assert!(hour_sum <= cal_total,
                "codex 小时和 {hour_sum} 不得超过日历日总量 {cal_total}");
        assert!(hour_sum > 0, "codex 用量日的小时图不得全空（fold 全量历史）");
        // 来源标注合法（消费方按这个渲染覆盖面提示）。Phase 3.5 Tier B：
        // 三执行环境统一 `sql-facts`（hourly_distribution 切权威库后唯一来源）。
        let src = &v["harnesses_available"];
        assert_eq!(src["codex"], serde_json::json!("sql-facts"), "codex 来源切 SQL 后统一标注");
        assert!(src["dsh"].is_null() || src["dsh"] == "sql-facts",
                "dsh 来源非法: {src}");
        assert!(src["claude"].is_null() || src["claude"] == "sql-facts",
                "claude 来源非法: {src}");
    }

    fn ov_with(budget: overview::BudgetAlert) -> Overview {
        Overview {
            data_home: "/tmp".into(),
            today: None,
            month: serde_json::json!({"total": 0.0}),
            days: vec![],
            budget_monthly_cny: Some(600.0),
            budget,
            budget_profiles: None,
            metered_today: None,
            metered_month: None,
            today_tokens_sql: None,
            sync: SyncStatus::default(),
            harnesses: vec![
                overview::HarnessRow::unavailable("dsh"),
                overview::HarnessRow::unavailable("codex"),
                overview::HarnessRow::unavailable("claude-code"),
            ],
            harnesses_generated_at: None,
            estimate_note: String::new(),
            claude_today: None,
            claude_month: None,
            claude_today_tokens: None,
            claude_uncovered_month: None,
            month_savings: None,
            // 镜像 read_overview 在真机上的产物（pricing.json 有 fx_estimate 节）：
            // 速览层混币折算按此汇率。`fx: None` 的降级路径由专门用例钉。
            fx: Some(serde_json::json!({"usd_cny": 7.15, "as_of": "2026-09"})),
            subscription_cny_month: None,
            subscription_month_by_currency: None,
        }
    }

    #[test]
    fn today_title_is_tokens_only_and_aligned_with_kpi() {
        // 用户定向 2026-09-17：标题 = 「鸟头 + 64.4M」，不带价格；数字与工作台
        // 「今日消耗」KPI 同源（SQL daily DTO），库缺席退回旧合并。
        let mut ov = ov_with(overview::BudgetAlert::default());
        assert_eq!(today_title(&ov), "—", "无今日数据不得臆造 0");
        ov.today_tokens_sql = Some(64_400_000);
        assert_eq!(today_title(&ov), "64.4M");
        // 有钱也不进标题。
        ov.metered_today = Some(serde_json::json!({ "CNY": { "amount": 41.77, "actual": 0.0, "declared_estimate": 41.77, "default_estimate": 0.0, "label": "estimate" } }));
        assert_eq!(today_title(&ov), "64.4M");
        assert_eq!(today_tokens_row_text(&ov), "今日消耗：64.4M tokens");
        // SQL 缺席：退回 DSH state + claude ledger 合并。
        let mut legacy = ov_with(overview::BudgetAlert::default());
        legacy.today = Some(serde_json::json!({"total": 12.34, "tokens": 1_398_214}));
        legacy.claude_today_tokens = Some(100_000);
        assert_eq!(today_title(&legacy), "1.5M");
        // SQL 报「今天 0」是事实：标题「—」（不是缺席，但也不摆 0）。
        let mut zero = ov_with(overview::BudgetAlert::default());
        zero.today_tokens_sql = Some(0);
        zero.claude_today_tokens = Some(100_000);
        assert_eq!(today_title(&zero), "—");
    }

    /// 旧 CNY 字段兼容：有记录但不宣称已付款；无订阅不摆 ¥0。
    #[test]
    fn subscription_line_shows_recorded_note_or_hides() {
        let mut ov = ov_with(overview::BudgetAlert::default());
        assert_eq!(subscription_line_text(&ov), None, "无订阅 → 整行不显示");
        ov.subscription_cny_month = Some(232.0);
        assert_eq!(
            subscription_line_text(&ov).unwrap(),
            "已记录订阅：CNY ¥232（非付款凭证，不计入按量预算）"
        );
        ov.subscription_cny_month = Some(0.0); // (total>0).then_some 保证不会是这个，防御性
        assert_eq!(subscription_line_text(&ov), Some("已记录订阅：CNY ¥0（非付款凭证，不计入按量预算）".into()));
    }

    #[test]
    fn subscription_line_keeps_usd_and_cny_declared_amounts_separate() {
        let mut ov = ov_with(overview::BudgetAlert::default());
        ov.subscription_cny_month = Some(114.0);
        ov.subscription_month_by_currency = Some([
            ("CNY".to_string(), 11_400),
            ("USD".to_string(), 2_005),
        ].into());
        assert_eq!(
            subscription_line_text_localized(&ov, NativeUiLanguage::English),
            Some("Recorded subscription: CNY ¥114 · USD $20.05 (not payment-verified; excluded from metered budget)".into())
        );
        ov.subscription_month_by_currency = Some(Default::default());
        assert_eq!(subscription_line_text(&ov), None, "权威空账不退回旧 CNY 字段");
    }

    #[test]
    fn fmt_tokens_abbreviates_large_counts() {
        assert_eq!(fmt_tokens(0), "0");
        assert_eq!(fmt_tokens(999), "999");
        assert_eq!(fmt_tokens(8238), "8.2K");
        assert_eq!(fmt_tokens(10000), "10K");
        assert_eq!(fmt_tokens(1398214), "1.4M");
    }

    #[test]
    fn short_model_strips_provider_prefix_only() {
        assert_eq!(short_model("deepseek/deepseek-v4-pro-0813"), "deepseek-v4-pro-0813");
        assert_eq!(short_model("deepseek-v4-flash"), "deepseek-v4-flash");
        // 版本尾巴保留——砍掉它，两个不同版本在菜单里就长得一模一样了。
        assert_ne!(short_model("a/m-0813"), short_model("a/m-0901"));
    }

    /// 日预算行的分子/百分比只在「今天真有数据 + alert 新鲜」时出现。这条钉的是
    /// 真机 2026-09-01 的形态：today.json 停在昨天（`ov.today` 为 None），
    /// alert.json 仍报着上一次评估的 today_cost —— 菜单绝不能同时说
    /// 「今日成本：—（无数据）」和「今日按量预算：¥0.12 / ¥30（0%）」。
    #[test]
    fn daily_budget_line_hides_numerator_when_today_has_no_data() {
        let ov = ov_with(overview::BudgetAlert {
            source: "alert".into(),
            level: Some("ok".into()),
            effective_daily_budget: Some(30.0),
            today_cost: Some(0.1224042),
            ratio: Some(0.00408014),
            generated_at: Some(FIXTURE_AT.into()),
            ..Default::default()
        });
        assert!(ov.today.is_none());
        assert_eq!(
            daily_budget_text(&ov, FIXTURE_AT_SECS).unwrap(),
            "今日按量预算：— / ¥30（今日暂无可计价金额）",
            "今天没有数据时，alert.json 里那个属于别的一天的 today_cost 不得冒充今日"
        );
    }

    /// 今天有数据 + alert 新鲜 → 显示权威分子与百分比（`ratio` 直接来自
    /// alert.json，不是 today_cost/daily 自算——那是 D2 缺口）。
    #[test]
    fn daily_budget_line_uses_alert_ratio_when_fresh_and_today_has_data() {
        let mut ov = ov_with(overview::BudgetAlert {
            source: "alert".into(),
            level: Some("warn".into()),
            effective_daily_budget: Some(30.0),
            today_cost: Some(24.0),
            // 故意不等于 24/30=80%：证明这里读的是 alert 的 ratio，没有自算。
            ratio: Some(0.93),
            generated_at: Some(FIXTURE_AT.into()),
            ..Default::default()
        });
        ov.today = Some(serde_json::json!({"total": 24.0, "peak_total": 0.0, "tokens": 100}));
        assert_eq!(daily_budget_text(&ov, FIXTURE_AT_SECS).unwrap(), "今日按量预算：¥24 / ¥30（93%）");
    }

    /// alert 过期时不报旧的分子/百分比，只留分母（分母是设置，不是测量值，过期
    /// 的设置仍然是当前设置）。
    #[test]
    fn daily_budget_line_drops_stale_numerator_but_keeps_the_setting() {
        let mut ov = ov_with(overview::BudgetAlert {
            source: "alert".into(),
            level: Some("ok".into()),
            effective_daily_budget: Some(30.0),
            today_cost: Some(24.0),
            ratio: Some(0.8),
            generated_at: Some(FIXTURE_AT.into()),
            ..Default::default()
        });
        ov.today = Some(serde_json::json!({"total": 24.0, "peak_total": 0.0, "tokens": 100}));
        assert_eq!(
            daily_budget_text(&ov, FIXTURE_AT_SECS + 3600).unwrap(),
            "今日按量预算：— / ¥30（数据过期，未重新评估）"
        );
    }

    /// 没有 alert.json（拿不到日预算这个设置）→ 整行不显示，不空占一行；预算行
    /// 本身已经说了「等预算数据」。
    #[test]
    fn daily_budget_line_absent_without_alert() {
        let ov = ov_with(overview::BudgetAlert { source: "missing".into(), ..Default::default() });
        assert!(daily_budget_text(&ov, FIXTURE_AT_SECS).is_none());
    }

    /// harness 显示名映射（spec §4）：dsh → DeepSeek Harness、codex → Codex、
    /// claude-code → Claude Code（第三执行环境行，D5）；未知执行环境原样显示（未来加执行环境
    /// 不硬编码）。
    #[test]
    fn harness_display_name_maps_three_harnesses_and_unknown() {
        assert_eq!(harness_display_name("dsh"), "DeepSeek Harness");
        assert_eq!(harness_display_name("codex"), "Codex");
        assert_eq!(harness_display_name("claude-code"), "Claude Code");
        assert_eq!(harness_display_name("future-harness"), "future-harness");
    }

    /// v0.6 harness-contract spec §6/§11-M3：改从 `HARNESSES` 行派生后，WorkBuddy
    /// 也能正确解析——它没有托盘行（`fold: None`），但工作台的会话浏览面
    /// 一直支持它，展示名不该因为没有折叠能力就缺席。
    #[test]
    fn harness_display_name_resolves_workbuddy_even_though_it_has_no_tray_row() {
        assert_eq!(harness_display_name("workbuddy"), "WorkBuddy");
    }

    /// 托盘按量视图与 SQL `metered_view` 同币分栏，不用旧 FX 便利折算生成跨币总计。
    #[test]
    fn metered_view_text_prefers_sql_view_and_marks_estimates() {
        let est = serde_json::json!({ "CNY": { "amount": 41.77, "actual": 0.0, "declared_estimate": 41.77, "default_estimate": 0.0, "label": "estimate" } });
        assert_eq!(metered_view_text(Some(&est)), Some("≈CNY ¥41.77".to_string()));
        let actual = serde_json::json!({ "CNY": { "amount": 12.34, "actual": 12.34, "declared_estimate": 0.0, "default_estimate": 0.0, "label": "actual" } });
        assert_eq!(metered_view_text(Some(&actual)), Some("CNY ¥12.34".to_string()));
        let mixed = serde_json::json!({
            "CNY": { "amount": 10.0, "actual": 10.0, "declared_estimate": 0.0, "default_estimate": 0.0, "label": "actual" },
            "USD": { "amount": 2.0, "actual": 0.0, "declared_estimate": 2.0, "default_estimate": 0.0, "label": "estimate" } });
        assert_eq!(metered_view_text(Some(&mixed)), Some("CNY ¥10 · ≈USD $2".to_string()), "跨币不相加，估算只标在 USD 段");
        let usd_only = serde_json::json!({ "USD": { "amount": 3.0, "actual": 0.0, "declared_estimate": 3.0, "default_estimate": 0.0, "label": "estimate" } });
        assert_eq!(metered_view_text(Some(&usd_only)), Some("≈USD $3".to_string()));
        let zero = serde_json::json!({ "USD": { "amount": 0.0, "actual": 0.0, "label": "actual" } });
        assert_eq!(metered_view_text(Some(&zero)), Some("USD $0".to_string()), "权威零与无数据必须区分");
        assert_eq!(metered_view_text(Some(&serde_json::json!({}))), None, "视图为空 → 调用方写「—」");
        assert_eq!(metered_view_text(None), None, "旧载荷 → 退回旧拼法");
    }

    /// 设置 › MCP 的 SKILL.md：frontmatter 合法（name/description 两行、`---` 围栏），
    /// 工具清单来自运行时 `tool_specs()`（每个注册的工具都出现，页面不手抄）。
    #[test]
    fn mcp_skill_markdown_has_frontmatter_and_every_tool() {
        let md = mcp_skill_markdown();
        assert!(md.starts_with("---\nname: agent-vitals-mcp\ndescription: "), "frontmatter 开头");
        let fence_end = md[4..].find("\n---\n").expect("frontmatter 围栏闭合") + 4;
        let front = &md[..fence_end];
        assert_eq!(front.matches("\ndescription: ").count(), 1);
        for t in agent_vitals_runtime::mcp::tool_specs() {
            assert!(md.contains(&format!("- `{}` — ", t.name)), "工具 {} 不在清单里", t.name);
        }
        assert!(md.contains("data-mcp serve --allow-local-writes"));
        assert!(md.contains("Never invent prices"), "诚实规则必须在");
    }

    #[test]
    fn metered_amount_truth_table() {
        // 纯 DSH 实测：claude 无价流 → 不带 ≈（实测不标成估）；含测到 0。
        assert_eq!(metered_amount(Some(12.34), 0.0, 0.0), Some("CNY ¥12.34".to_string()));
        assert_eq!(metered_amount(Some(0.0), 0.0, 0.0), Some("CNY ¥0".to_string()));
        // DSH 缺场 + claude CNY 估 → 估占主导，≈¥X。
        assert_eq!(metered_amount(None, 37.17, 0.0), Some("≈CNY ¥37.17".to_string()));
        // 混合：DSH 实测 ¥12.34 + claude 估 ¥6 → 相加 + ≈（含估分量）。
        assert_eq!(metered_amount(Some(12.34), 6.0, 0.0), Some("≈CNY ¥18.34".to_string()));
        assert_eq!(metered_amount(Some(0.0), 6.0, 0.0), Some("≈CNY ¥6".to_string()));
        // USD 始终保留原币种，不论 CNY 是否存在或 FX 目录是否可用。
        assert_eq!(metered_amount(None, 0.0, 3.0), Some("≈USD $3".to_string()));
        assert_eq!(metered_amount(Some(0.0), 0.0, 3.0), Some("CNY ¥0 · ≈USD $3".to_string()));
        assert_eq!(metered_amount(Some(12.34), 0.0, 3.0), Some("CNY ¥12.34 · ≈USD $3".to_string()));
        assert_eq!(metered_amount(Some(12.34), 6.0, 3.0), Some("≈CNY ¥18.34 · ≈USD $3".to_string()));

        // 两币皆无 → None，不摆 ¥0。
        assert_eq!(metered_amount(None, 0.0, 0.0), None);
        // 数字走 fmt_money/fmt_usd 同款修剪。
        assert_eq!(metered_amount(None, 200.0, 0.0), Some("≈CNY ¥200".to_string()));
        assert_eq!(metered_amount(None, 0.0, 0.52), Some("≈USD $0.52".to_string()));
    }

    /// claude_currency 读报告的 currency_totals 单侧金额：缺场/该币键缺场/值非数
    /// → 0.0。坏数据不 panic。
    #[test]
    fn claude_currency_reads_one_side_of_the_report() {
        let none: Option<Value> = None;
        assert_eq!(claude_currency(&none, "CNY"), 0.0);
        assert_eq!(claude_currency(&none, "USD"), 0.0);
        let r = Some(serde_json::json!({"currency_totals": {"CNY": 6.0}}));
        assert_eq!(claude_currency(&r, "CNY"), 6.0);
        assert_eq!(claude_currency(&r, "USD"), 0.0);
        // currency_totals 缺场（坏数据）→ 0，不 panic。
        assert_eq!(claude_currency(&Some(serde_json::json!({"days": 3})), "CNY"), 0.0);
    }

    /// 账卡两行（money_rows_text）：真机那天（2026-09-02）的三种形态逐格钉住——
    /// 这是用户直接看的文案，字符串本身必须有测试，不能只靠人工核对。
    #[test]
    fn money_rows_merge_dsh_and_claude_never_say_no_data_when_metered() {
        // ① 真机形态：DSH 空转（今日 None）+ Claude deepseek 全在账 → 合并 ≈¥，token
        // 全量并排。这正是用户报「按量成本无数据」的那天——修复后必须是有数的。
        let mut ov = ov_with(overview::BudgetAlert::default());
        ov.claude_today = Some(serde_json::json!({"currency_totals": {"CNY": 37.17, "USD": 0.0}}));
        ov.claude_today_tokens = Some(188_213_789);
        ov.claude_month = Some(serde_json::json!({"currency_totals": {"CNY": 106.1, "USD": 0.0}}));
        let (today, month) = money_rows_text(&ov);
        assert_eq!(today, "今日按量成本：≈CNY ¥37.17");
        assert_eq!(month, "本月按量成本：≈CNY ¥106.1", "DSH 本月无日键 → 纯 claude 估主导");
        // ② 纯 DSH 日（claude 无 CNY 价流）：实测精度，无 ≈；月行带实测 ¥。
        ov = ov_with(overview::BudgetAlert::default());
        ov.today = Some(serde_json::json!({"total": 12.34, "tokens": 1_398_214}));
        ov.month = serde_json::json!({"total": 612.5});
        ov.days = vec![overview::DayRow {
            date: "2026-09-01".into(),
            total: 612.5,
            peak_total: 0.0,
            basis: None,
            coverage: None,
        }];
        let (today, month) = money_rows_text(&ov);
        assert_eq!(today, "今日按量成本：CNY ¥12.34");
        assert_eq!(month, "本月按量成本：CNY ¥612.5", "分母已移除——预算只活在底部预算行");
        // ③ 两执行环境今天都无按量钱 → 今日诚实的 —；本月空 → ¥0 兜底。
        let ov = ov_with(overview::BudgetAlert::default());
        let (today, month) = money_rows_text(&ov);
        assert_eq!(today, "今日按量成本：—（无数据）");
        assert_eq!(month, "本月按量成本：—（无数据）");
    }

    #[test]
    fn money_rows_keep_currencies_separate_and_respect_empty_authority_view() {
        let mut ov = ov_with(overview::BudgetAlert::default());
        ov.fx = Some(serde_json::json!({"usd_cny": 7.15, "as_of": "2026-09"}));
        ov.metered_month = Some(serde_json::json!({
            "CNY": {"amount": 10.0, "label": "actual"},
            "USD": {"amount": 2.0, "label": "estimate"}
        }));
        let (_, month) = money_rows_text_localized(&ov, NativeUiLanguage::English);
        assert_eq!(month, "Monthly cost: CNY ¥10 · ≈USD $2");
        assert!(!month.contains("24.3"), "FX 目录存在也不得折合跨币总额");

        ov.metered_today = Some(serde_json::json!({}));
        ov.metered_month = Some(serde_json::json!({}));
        ov.today = Some(serde_json::json!({"total": 12.34}));
        ov.claude_today = Some(serde_json::json!({"currency_totals": {"USD": 3.0}}));
        ov.claude_month = Some(serde_json::json!({"currency_totals": {"USD": 3.0}}));
        let (today, month) = money_rows_text_localized(&ov, NativeUiLanguage::English);
        assert_eq!(today, "Today’s metered cost: — (no data)");
        assert_eq!(month, "Monthly cost: — (no data)", "权威视图在场但为空 → 合并路径、不退回旧载荷");
    }

    /// 本月成本 = 按量 + 订阅月费：同币相加、跨币不加，估算成分标 ≈（用户 2026-10-01 要求）。
    #[test]
    fn month_cost_includes_metered_and_subscription_per_currency() {
        let mut ov = ov_with(overview::BudgetAlert::default());
        ov.metered_month = Some(serde_json::json!({
            "CNY": {"amount": 20.55, "label": "actual"},
            "USD": {"amount": 2.0, "label": "estimate"}
        }));
        ov.subscription_month_by_currency = Some([("CNY".to_string(), 16_200_i64), ("USD".to_string(), 4_000_i64)].into_iter().collect());
        let (_, month) = money_rows_text_localized(&ov, NativeUiLanguage::English);
        assert_eq!(month, "Monthly cost: CNY ¥182.6 · ≈USD $42", "托盘金额一位小数约定；CNY 实付 20.55 + 订阅 162；USD 估算 2 + 订阅 40 → 估算段标 ≈；不跨币相加");
        let (_, zh) = money_rows_text_localized(&ov, NativeUiLanguage::Chinese);
        assert!(zh.starts_with("本月成本："), "{zh}");
        // 只有订阅、没有按量：成本就是订阅月费，不是「无数据」
        let mut only_sub = ov_with(overview::BudgetAlert::default());
        only_sub.subscription_month_by_currency = Some([("USD".to_string(), 2_000_i64)].into_iter().collect());
        let (_, month) = money_rows_text_localized(&only_sub, NativeUiLanguage::English);
        assert_eq!(month, "Monthly cost: USD $20");
    }

    /// 日预算「部分覆盖」：有已知金额（订阅日摊）但另有币种没法折算 → 显示已知下限，
    /// 不写成「无数据」（2026-10-01 真机：总览 CNY 5.23 + USD 1.29，托盘却是 — / ¥30）。
    #[test]
    fn daily_budget_shows_known_floor_when_partially_covered() {
        let mut ov = ov_with(overview::BudgetAlert::default());
        ov.budget_profiles = Some(serde_json::json!({ "profiles": [{
            "profile_id": "estimate", "currency": "CNY", "daily_minor": 3000,
            "daily_total_minor": 522, "daily_ratio_bp": null, "daily_level": "incomplete",
        }]}));
        let zh = daily_budget_text_localized(&ov, 0, NativeUiLanguage::Chinese).unwrap();
        assert!(zh.starts_with("今日预算：≥") && zh.contains("5.2") && zh.contains("部分覆盖"), "{zh}");
        let en = daily_budget_text_localized(&ov, 0, NativeUiLanguage::English).unwrap();
        assert!(en.contains("≥") && en.contains("partial"), "{en}");
        // 确实没有金额 → 仍然是「暂无可计价金额」，不冒充 ≥0
        ov.budget_profiles = Some(serde_json::json!({ "profiles": [{
            "profile_id": "estimate", "currency": "CNY", "daily_minor": 3000,
            "daily_total_minor": 0, "daily_ratio_bp": null, "daily_level": "no_data",
        }]}));
        let none = daily_budget_text_localized(&ov, 0, NativeUiLanguage::Chinese).unwrap();
        assert!(none.contains("暂无可计价金额"), "{none}");
    }

    /// 报告币种：每个币种都能折算 → 显示 ≈ 合计 + 原币种明细；报告币种单币时不折算；
    /// 任一币种折不了 → 整体退回分币种（不拼半折半不折的假合计）。
    #[test]
    fn month_cost_converts_to_the_reporting_currency_with_the_originals_kept() {
        use agent_vitals_domain::fx::{FxPolicy, UserRate};
        let mut ov = ov_with(overview::BudgetAlert::default());
        ov.metered_month = Some(serde_json::json!({"CNY": {"amount": 20.0, "label": "actual"}}));
        ov.subscription_month_by_currency = Some([("CNY".to_string(), 16_000_i64), ("USD".to_string(), 4_000_i64)].into_iter().collect());
        let policy = FxPolicy::bundled().unwrap().with_user_rate(UserRate { from: "USD".into(), to: "CNY".into(), rate: 6.8, as_of: None }).unwrap();
        // 报告币种 USD：CNY 180 → USD 26.47 + USD 40 = 66.47
        let usd = TrayFx { target: "USD".into(), policy: policy.clone() };
        let (_, month) = money_rows_text_fx(&ov, NativeUiLanguage::English, Some(&usd));
        assert_eq!(month, "Monthly cost: ≈USD $66.47 [CNY ¥180 · USD $40] · manual rate", "手动汇率必须在托盘里标出来");
        // 报告币种 CNY：USD 40 → 272 + 180 = 452
        let cny = TrayFx { target: "CNY".into(), policy: policy.clone() };
        let (_, month) = money_rows_text_fx(&ov, NativeUiLanguage::Chinese, Some(&cny));
        assert_eq!(month, "本月成本：≈CNY ¥452 [CNY ¥180 · USD $40] · 手动汇率");
        // 用内置快照时写参考汇率的日期（欧央行），不写成「手动」
        let bundled = TrayFx { target: "CNY".into(), policy: agent_vitals_domain::fx::FxPolicy::bundled().unwrap() };
        let (_, month) = money_rows_text_fx(&ov, NativeUiLanguage::English, Some(&bundled));
        assert!(month.contains("· ECB 20") && !month.contains("manual"), "{month}");
        // 不足一分的非零金额不写成 0.00
        assert_eq!(fmt_currency_amount("EUR", 0.001), "<0.01");
        assert_eq!(fmt_currency_amount("EUR", 0.0), "0.00");
        assert_eq!(fmt_currency_amount("JPY", 0.3), "<1");
        // 其他报告币种：EUR 两位小数、JPY 无小数；不出现 59.28470000000001 这类浮点原文
        let eur = TrayFx { target: "EUR".into(), policy: agent_vitals_domain::fx::FxPolicy::bundled().unwrap() };
        let (_, month) = money_rows_text_fx(&ov, NativeUiLanguage::English, Some(&eur));
        let eur_amount = month.split("≈EUR ").nth(1).and_then(|t| t.split(' ').next()).unwrap_or("");
        assert!(eur_amount.split('.').nth(1).is_some_and(|frac| frac.len() == 2), "EUR 应两位小数：{month}");
        let jpy = TrayFx { target: "JPY".into(), policy: agent_vitals_domain::fx::FxPolicy::bundled().unwrap() };
        let (_, month) = money_rows_text_fx(&ov, NativeUiLanguage::English, Some(&jpy));
        let jpy_amount = month.split("≈JPY ").nth(1).and_then(|t| t.split(' ').next()).unwrap_or("");
        assert!(!jpy_amount.is_empty() && jpy_amount.chars().all(|c| c.is_ascii_digit()), "JPY 应无小数：{month}");
        // 只有一个币种且就是报告币种：不折算、不加 ≈
        ov.subscription_month_by_currency = Some([("CNY".to_string(), 16_000_i64)].into_iter().collect());
        let (_, month) = money_rows_text_fx(&ov, NativeUiLanguage::English, Some(&cny));
        assert_eq!(month, "Monthly cost: CNY ¥180");
        // 含折不了的币种：整体退回分币种
        ov.subscription_month_by_currency = Some([("CNY".to_string(), 16_000_i64), ("XXX".to_string(), 500_i64)].into_iter().collect());
        let (_, month) = money_rows_text_fx(&ov, NativeUiLanguage::English, Some(&cny));
        assert!(!month.contains('[') && month.contains("CNY ¥180") && month.contains("XXX"), "{month}");
        // 不给 fx（旧调用/测试）：行为与此前一致
        let (_, plain) = money_rows_text_fx(&ov, NativeUiLanguage::English, None);
        assert_eq!(plain, month);
    }

    /// fmt_usd 与 fmt_money 同修剪 spec：整美元不拖 `.0`，小数保留非零尾。
    #[test]
    fn fmt_currency_symbols_share_trim_spec() {
        assert_eq!(fmt_usd(28.0), "$28");
        assert_eq!(fmt_usd(0.52), "$0.52");
        assert_eq!(fmt_usd(123.4), "$123.4");
        assert_eq!(fmt_money(6.0), "¥6");
        assert_eq!(fmt_money(0.05), "¥0.05");
        assert_eq!(fmt_money(0.001), "<¥0.01", "非零小额不能显示成免费");
        assert_eq!(fmt_usd(0.0004), "<$0.01");
    }

    /// L1 执行环境行（spec §4/§8 矩阵逐格）：完整 → `显示名 · token · N 会话`；
    /// 全缺 → 单个 `· —`（unavailable 形态）；只缺一个 → 该槽位「—」；
    /// partial 覆盖率 → token 加 `≈` 前缀（保守下界标注不能渲染成精确值）。
    #[test]
    fn harness_row_text_renders_values_dashes_and_approx() {
        let full = HarnessRow {
            harness_kind: "dsh".into(),
            status: "ready".into(),
            today_tokens: Some(1398214),
            today_partial: false,
            today_sessions: Some(3),
            recent: vec![],
        };
        assert_eq!(harness_row_text(&full), "DeepSeek Harness · 1.4M · 3 会话");
        let partial = HarnessRow { today_partial: true, ..full.clone() };
        assert_eq!(harness_row_text(&partial), "DeepSeek Harness · ≈1.4M · 3 会话");
        assert_eq!(harness_row_text(&HarnessRow::unavailable("codex")), "Codex · —");
        let no_sessions = HarnessRow {
            today_tokens: Some(500),
            today_sessions: None,
            ..full.clone()
        };
        assert_eq!(harness_row_text(&no_sessions), "DeepSeek Harness · 500 · —");
        let no_tokens = HarnessRow {
            today_tokens: None,
            today_sessions: Some(2),
            ..full.clone()
        };
        assert_eq!(harness_row_text(&no_tokens), "DeepSeek Harness · — · 2 会话");
    }

    #[test]
    fn tray_information_rows_have_english_labels_without_changing_values() {
        let ov = ov_with(overview::BudgetAlert::default());
        assert_eq!(today_tokens_row_text_localized(&ov, NativeUiLanguage::English), "Today’s usage: —");
        let (today, month) = money_rows_text_localized(&ov, NativeUiLanguage::English);
        assert_eq!(today, "Today’s metered cost: — (no data)");
        assert_eq!(month, "Monthly metered cost: — (no data)");
        let row = HarnessRow {
            harness_kind: "codex".into(),
            status: "ready".into(),
            today_tokens: Some(15000),
            today_partial: true,
            today_sessions: Some(1),
            recent: vec![],
        };
        assert_eq!(harness_row_text_localized(&row, NativeUiLanguage::English), "Codex · ≈15K · 1 session");
        let sync = SyncStatus { ok: false, stage: "error".into(), message: "本地路径错误".into(), at: None, dynamic_harnesses: Vec::new() };
        assert_eq!(sync_line_text_localized(&sync, NativeUiLanguage::English), "⚠ Last sync failed; see Settings for details");
    }

    /// L2 最近会话行（spec §4）：`MM-DD · 身份 · tokens`；title 超 24 字符截断；
    /// 无 title → short_model → native_id 的 fallback 链；跨年显示完整日期；
    /// tokens 缺段省略。
    #[test]
    fn recent_row_text_formats_date_identity_and_tokens() {
        // FIXTURE_AT_SECS = 2026-08-30 → 北京年 2026。
        let row = RecentSessionRow {
            session_key: serde_json::json!({"harness_kind": "dsh", "native_id": "s1"}),
            title: Some("重构 r2a 查询".into()),
            date: Some("2026-08-28".into()),
            model: Some("deepseek/deepseek-v4-flash".into()),
            tokens: Some(88000),
        };
        assert_eq!(
            recent_row_text(&row, FIXTURE_AT_SECS),
            "08-28 · 重构 r2a 查询 · 88K"
        );
        // 跨年（2025 的会话在 2026 年看）→ 完整日期，不折 MM-DD。
        let last_year = RecentSessionRow { date: Some("2025-12-31".into()), ..row.clone() };
        assert_eq!(
            recent_row_text(&last_year, FIXTURE_AT_SECS),
            "2025-12-31 · 重构 r2a 查询 · 88K"
        );
        // 超长 title（27 字符）→ 前 23 字符 + …（按字符数截，中文不会切成半个字）。
        let long = RecentSessionRow {
            title: Some("这是一个非常长的会话标题它绝对超过二十四个字符必须截断".into()),
            ..row.clone()
        };
        assert_eq!(
            recent_row_text(&long, FIXTURE_AT_SECS),
            "08-28 · 这是一个非常长的会话标题它绝对超过二十四个字符… · 88K"
        );
        // 无 title → short_model；再无 model → native_id；tokens 缺 → 省略。
        let no_title = RecentSessionRow { title: None, ..row.clone() };
        assert_eq!(recent_row_text(&no_title, FIXTURE_AT_SECS), "08-28 · deepseek-v4-flash · 88K");
        let no_model = RecentSessionRow { title: None, model: None, ..row.clone() };
        assert_eq!(recent_row_text(&no_model, FIXTURE_AT_SECS), "08-28 · s1 · 88K");
        let no_tokens = RecentSessionRow { tokens: None, ..row.clone() };
        assert_eq!(recent_row_text(&no_tokens, FIXTURE_AT_SECS), "08-28 · 重构 r2a 查询");
    }

    /// 执行环境区结构（spec §4/§9.2）：固定两执行环境子菜单（harnesses 数组序 = dsh→codex），
    /// L2 行 id `session:{kind}:{i}` 按序编号；unavailable 执行环境 → L2 单行禁用
    /// 「会话数据暂不可用」。平铺「最近会话」行已删——结构里只有执行环境子菜单。
    #[test]
    fn harness_menu_rows_builds_two_submenus_dsh_first() {
        let harnesses = vec![
            HarnessRow {
                harness_kind: "dsh".into(),
                status: "ready".into(),
                today_tokens: Some(15000),
                today_partial: false,
                today_sessions: Some(1),
                recent: vec![
                    RecentSessionRow {
                        session_key: serde_json::json!({"native_id": "s1"}),
                        title: Some("会话甲".into()),
                        date: Some("2026-08-28".into()),
                        model: None,
                        tokens: Some(5000),
                    },
                    RecentSessionRow {
                        session_key: serde_json::json!({"native_id": "s2"}),
                        title: Some("会话乙".into()),
                        date: Some("2026-08-27".into()),
                        model: None,
                        tokens: Some(3000),
                    },
                ],
            },
            HarnessRow::unavailable("codex"),
        ];
        let rows = harness_menu_rows(&harnesses, None, FIXTURE_AT_SECS);
        assert_eq!(rows.len(), 2);
        match &rows[0] {
            MenuRow::Submenu { id, text, rows: l2 } => {
                assert_eq!(id, "harness:dsh");
                assert_eq!(text, "DeepSeek Harness · 15K · 1 会话");
                assert_eq!(
                    *l2,
                    vec![
                        MenuRow::Item {
                            id: "session:dsh:0".into(),
                            // fmt_tokens：<10K 留一位小数 → 5.0K（与既有钉住的
                            // fmt_tokens_abbreviates_large_counts 同规则）。
                            text: "08-28 · 会话甲 · 5.0K".into(),
                            enabled: true,
                        },
                        MenuRow::Item {
                            id: "session:dsh:1".into(),
                            text: "08-27 · 会话乙 · 3.0K".into(),
                            enabled: true,
                        },
                    ]
                );
            }
            other => panic!("rows[0] 应是 Submenu，实际 {other:?}"),
        }
        match &rows[1] {
            MenuRow::Submenu { id, text, rows: l2 } => {
                assert_eq!(id, "harness:codex");
                assert_eq!(text, "Codex · —");
                assert_eq!(
                    *l2,
                    vec![MenuRow::Item {
                        id: "session:unavailable:codex".into(),
                        text: "会话数据暂不可用".into(),
                        enabled: false,
                    }]
                );
            }
            other => panic!("rows[1] 应是 Submenu，实际 {other:?}"),
        }
    }

    /// 降级矩阵（spec §8）：ready + 零会话 → 禁用「尚无会话」（真零不是失败——
    /// 与 unavailable 的「会话数据暂不可用」必须可区分）；stale 快照（年龄 >
    /// 2 × tick）→ 执行环境子菜单底部「数据更新于 hh:mm · 可能已过期」，hh:mm 是
    /// 北京时刻（UTC +8）。
    #[test]
    fn harness_menu_rows_degradation_and_stale_footer() {
        let zero = vec![HarnessRow {
            harness_kind: "codex".into(),
            status: "ready".into(),
            today_tokens: Some(0),
            today_partial: false,
            today_sessions: Some(0),
            recent: vec![],
        }];
        let rows = harness_menu_rows(&zero, None, FIXTURE_AT_SECS);
        assert_eq!(
            rows[0],
            MenuRow::Submenu {
                id: "harness:codex".into(),
                text: "Codex · 0 · 0 会话".into(),
                rows: vec![MenuRow::Item {
                    id: "session:none:codex".into(),
                    text: "尚无会话".into(),
                    enabled: false,
                }],
            }
        );

        // stale 窗口 = 2 × tick = 10 分钟：+9 分钟仍新鲜、+11 分钟过期。
        let fresh_now = FIXTURE_AT_SECS + 9 * 60;
        let stale_now = FIXTURE_AT_SECS + 11 * 60;
        let harnesses = vec![HarnessRow {
            harness_kind: "dsh".into(),
            status: "ready".into(),
            today_tokens: Some(100),
            today_partial: false,
            today_sessions: Some(1),
            recent: vec![RecentSessionRow {
                session_key: serde_json::json!({"native_id": "s"}),
                title: Some("t".into()),
                date: Some("2026-08-28".into()),
                model: None,
                tokens: None,
            }],
        }];
        let fresh = harness_menu_rows(&harnesses, Some(FIXTURE_AT), fresh_now);
        assert!(!matches!(
            &fresh[0],
            MenuRow::Submenu { rows, .. }
                if rows.iter().any(|r| matches!(r, MenuRow::Item { id, .. } if id == "session:stale:dsh"))
        ));
        let stale = harness_menu_rows(&harnesses, Some(FIXTURE_AT), stale_now);
        match &stale[0] {
            MenuRow::Submenu { rows, .. } => assert_eq!(
                rows.last(),
                Some(&MenuRow::Item {
                    id: "session:stale:dsh".into(),
                    // FIXTURE_AT = 08-30 07:04:38Z → +8h = 15:04 北京。
                    text: "数据更新于 15:04 · 可能已过期".into(),
                    enabled: false,
                })
            ),
            other => panic!("stale[0] 应是 Submenu，实际 {other:?}"),
        }
    }

    /// 同步行常驻：成功时也显示（带 HH:MM），不是只在失败时才出现——用户要能一眼
    /// 看出菜单里的数字是什么时候的。
    #[test]
    fn sync_line_shows_time_on_success_not_only_on_failure() {
        let ok = SyncStatus {
            ok: true,
            stage: "discover".into(),
            message: "无未折 DSH 会话".into(),
            at: Some("2026-09-01 09:50:52".into()),
            dynamic_harnesses: Vec::new(),
        };
        assert_eq!(sync_line_text(&ok), "上次同步：09:50 成功（DeepSeek Harness、Claude Code）");
        let never = SyncStatus::default();
        assert_eq!(sync_line_text(&never), "尚未同步");
        let failed = SyncStatus {
            ok: false,
            stage: "fold".into(),
            message: "oneline 失败".into(),
            at: Some("2026-09-01 09:50:52".into()),
            dynamic_harnesses: Vec::new(),
        };
        assert_eq!(sync_line_text(&failed), "⚠ 上次同步失败：oneline 失败");
        // at 缺场（老状态文件）也不能崩，退化成不带时间的成功。
        let ok_no_at = SyncStatus { at: None, ..ok };
        assert_eq!(sync_line_text(&ok_no_at), "上次同步：成功（DeepSeek Harness、Claude Code）");
    }

    #[test]
    /// 信息行点击 → React canonical page 的映射钉死。today/daily/month/budget 都是总览页的
    /// 数字，sync 是设置页；workbench/refresh 不是导航行；`recent` 已随平铺行
    /// 删除（执行环境导航的 L2 深链走 WorkbenchTarget，不走 tab 映射）。
    fn tab_for_menu_id_maps_info_rows_to_workbench_tabs() {
        for id in ["today", "daily", "month", "budget", "subscription"] {
            assert_eq!(tab_for_menu_id(id), Some("overview"), "id={id} 应跳总览");
        }
        assert_eq!(tab_for_menu_id("sync"), Some("settings"));
        assert_eq!(tab_for_menu_id("today_tokens"), Some("usage"), "首行今日消耗点击要有去处");
        assert_eq!(tab_for_menu_id("skill_health"), Some("skills"), "托盘 Skill 体检点击要有去处");
        for id in ["workbench", "refresh", "recent", "harness:dsh", "session:dsh:0", "nope", ""] {
            assert_eq!(tab_for_menu_id(id), None, "id={id} 不是信息行导航");
        }
    }

    /// 夹具：alert.json 真机形态的 generated_at（2026-08-30 实测），以及用它作
    /// 「现在」的固定秒数——单测不碰系统时钟。
    const FIXTURE_AT: &str = "2026-08-30T07:04:38.548588+00:00";
    const FIXTURE_AT_SECS: i64 = 1788073478;

    /// 缺场降级：没有 alert.json 不臆造百分比，直说「等预算数据」。
    #[test]
    fn budget_line_missing_alert_is_honest() {
        let ov = ov_with(overview::BudgetAlert { source: "missing".into(), ..Default::default() });
        assert_eq!(budget_status_text_at(&ov, FIXTURE_AT_SECS), "预算：等预算数据（跑一次 oneline）");
    }

    /// over：百分比与剩余都由 alert.json 的权威字段而来，这里只是翻译成一行字。
    #[test]
    fn budget_line_over_uses_alert_authority() {
        let ov = ov_with(overview::BudgetAlert {
            source: "alert".into(),
            level: Some("over".into()),
            month_cost: Some(612.5),
            monthly_cny: Some(600.0),
            ..Default::default()
        });
        assert_eq!(budget_status_text_at(&ov, FIXTURE_AT_SECS), "🚨 预算超支：¥612.5（月 ¥600）");
    }

    /// snoozed：显示静默截止时间；月占比不显示（被静默盖过）。
    #[test]
    fn budget_line_snoozed_shows_until() {
        let ov = ov_with(overview::BudgetAlert {
            source: "alert".into(),
            level: Some("snoozed".into()),
            snoozed_until: Some("2026-08-31T00:00:00".into()),
            month_ratio: Some(0.5),
            ..Default::default()
        });
        assert_eq!(budget_status_text_at(&ov, FIXTURE_AT_SECS), "🔕 预算静默至 2026-08-31T00:00:00");
    }

    /// warn：百分比直接取 alert.json 的 month_ratio，绝不再用 (budget-spent)/budget
    /// 自算——那是 D2 缺口。
    #[test]
    fn budget_line_warn_uses_alert_ratio_not_recomputed() {
        let ov = ov_with(overview::BudgetAlert {
            source: "alert".into(),
            level: Some("warn".into()),
            month_ratio: Some(0.021314526166666667),
            month_cost: Some(12.7887157),
            monthly_cny: Some(600.0),
            ..Default::default()
        });
        assert_eq!(budget_status_text_at(&ov, FIXTURE_AT_SECS), "⚠️ 预算 2%：¥12.79 / ¥600");
    }

    /// ok / 未知 level：显示权威数值本身，不添油加醋。
    #[test]
    fn budget_line_ok_prints_authority_numbers() {
        let ov = ov_with(overview::BudgetAlert {
            source: "alert".into(),
            level: Some("ok".into()),
            month_cost: Some(12.7887157),
            monthly_cny: Some(600.0),
            ..Default::default()
        });
        assert_eq!(budget_status_text_at(&ov, FIXTURE_AT_SECS), "✓ 预算：¥12.79 / ¥600");
    }

    #[test]
    fn budget_line_lists_profiles_without_combining_currencies() {
        let mut ov = ov_with(overview::BudgetAlert::default());
        ov.budget_profiles = Some(serde_json::json!({
            "profiles": [
                {"profile_id": "estimate", "currency": "CNY", "level": "warn", "spent_minor": 8100, "monthly_minor": 10000},
                {"profile_id": "confirmed", "currency": "USD", "level": "ok", "spent_minor": 2500, "monthly_minor": 10000}
            ]
        }));
        assert_eq!(budget_status_text_at(&ov, FIXTURE_AT_SECS), "预算：估算 CNY 接近 81.00/100.00；已确认 USD 正常 25.00/100.00");
        assert_eq!(
            budget_status_text_at_localized(&ov, FIXTURE_AT_SECS, NativeUiLanguage::English),
            "Budget: Estimated CNY near limit 81.00/100.00; Confirmed USD within limit 25.00/100.00"
        );
    }

    #[test]
    fn english_budget_status_preserves_missing_and_stale_alert_semantics() {
        let missing = ov_with(overview::BudgetAlert { source: "missing".into(), ..Default::default() });
        assert_eq!(
            budget_status_text_at_localized(&missing, FIXTURE_AT_SECS, NativeUiLanguage::English),
            "Budget: waiting for budget data (run a sync)"
        );
        let stale = ov_with(overview::BudgetAlert {
            source: "alert".into(),
            level: Some("over".into()),
            generated_at: Some(FIXTURE_AT.into()),
            month_cost: Some(612.5),
            monthly_cny: Some(600.0),
            ..Default::default()
        });
        assert_eq!(
            budget_status_text_at_localized(&stale, FIXTURE_AT_SECS + 3600, NativeUiLanguage::English),
            "🚨 Budget exceeded: ¥612.5 (monthly ¥600) (stale data)"
        );
    }

    #[test]
    fn budget_line_no_budget_never_prints_a_default_amount_or_percent() {
        let budget = overview::BudgetAlert {
            source: "sql".into(),
            level: Some("no_budget".into()),
            month_cost: Some(42.0),
            ..Default::default()
        };
        let mut ov = ov_with(budget);
        ov.budget_monthly_cny = None;
        let line = budget_status_text_at(&ov, 0);
        assert_eq!(line, "预算：未设置（成本仍按实际口径统计）");
        assert!(!line.contains("600"));
        assert!(!line.contains('%'));
    }

    /// AGENT_VITALS_BIN 优先于自身目录与 PATH（env 指向的文件存在就用它）。
    #[test]
    #[cfg(not(windows))]
    fn resolve_binary_prefers_env_override() {
        let get = |k: &str| match k {
            "AGENT_VITALS_BIN" => Some("/opt/av/agent-vitals".into()),
            _ => None,
        };
        let is_file = |p: &Path| p.to_string_lossy() == "/opt/av/agent-vitals";
        assert_eq!(
            resolve_binary_from(&get, "/usr/bin:/opt/av".into(), None, None, "agent-vitals", &is_file),
            Some(PathBuf::from("/opt/av/agent-vitals"))
        );
    }

    /// 无 env、无自身目录 → PATH 查找。
    #[test]
    #[cfg(not(windows))]
    fn resolve_binary_falls_back_to_path() {
        let none = |_: &str| None;
        let is_file = |p: &Path| p.to_string_lossy() == "/usr/local/bin/agent-vitals";
        assert_eq!(
            resolve_binary_from(&none, "/usr/bin:/usr/local/bin".into(), None, None, "agent-vitals", &is_file),
            Some(PathBuf::from("/usr/local/bin/agent-vitals"))
        );
    }

    /// env 指向的文件不存在 → 不硬用，退回自身目录/PATH（宁可 PATH 也不起一个
    /// 不存在的）。
    #[test]
    #[cfg(not(windows))]
    fn resolve_binary_env_must_exist() {
        let get = |k: &str| match k {
            "AGENT_VITALS_BIN" => Some("/gone/agent-vitals".into()),
            _ => None,
        };
        let is_file = |p: &Path| p.to_string_lossy() == "/usr/local/bin/agent-vitals";
        assert_eq!(
            resolve_binary_from(&get, "/usr/local/bin".into(), None, None, "agent-vitals", &is_file),
            Some(PathBuf::from("/usr/local/bin/agent-vitals"))
        );
    }

    /// 自身目录解析：CLI 放进 .app 的 `Contents/MacOS/`（与 menubar 同目录）时，
    /// 无 env 无 PATH 也能找到——登录项启动的 app 不必依赖登录 shell 的 PATH。
    #[test]
    #[cfg(not(windows))]
    fn resolve_binary_finds_sibling_next_to_exe() {
        let none = |_: &str| None;
        let exe = Some(PathBuf::from(
            "/Applications/Oh Agent.app/Contents/MacOS/agent-vitals-menubar",
        ));
        let is_file = |p: &Path| {
            p.to_string_lossy() == "/Applications/Oh Agent.app/Contents/MacOS/agent-vitals"
        };
        assert_eq!(
            resolve_binary_from(&none, "".into(), exe, None, "agent-vitals", &is_file),
            Some(PathBuf::from(
                "/Applications/Oh Agent.app/Contents/MacOS/agent-vitals"
            ))
        );
    }

    /// 兄弟目录优先于 PATH：即使 PATH 里也有，app 自带的 CLI 必须赢（部署版不该
    /// 被 PATH 上另一份不同版本的二进制劫持）。
    #[test]
    #[cfg(not(windows))]
    fn resolve_binary_bundle_wins_over_path() {
        let none = |_: &str| None;
        let exe = Some(PathBuf::from(
            "/Applications/Oh Agent.app/Contents/MacOS/agent-vitals-menubar",
        ));
        let is_file = |p: &Path| {
            let s = p.to_string_lossy();
            s == "/Applications/Oh Agent.app/Contents/Resources/bin/agent-vitals"
                || s == "/usr/local/bin/agent-vitals"
        };
        assert_eq!(
            resolve_binary_from(&none, "/usr/local/bin".into(), exe, None, "agent-vitals", &is_file),
            Some(PathBuf::from(
                "/Applications/Oh Agent.app/Contents/Resources/bin/agent-vitals"
            ))
        );
    }

    /// 自身目录里的候选都不存在 → 退回 PATH。
    #[test]
    #[cfg(not(windows))]
    fn resolve_binary_bundle_missing_falls_back_to_path() {
        let none = |_: &str| None;
        let exe = Some(PathBuf::from(
            "/Applications/Oh Agent.app/Contents/MacOS/agent-vitals-menubar",
        ));
        let is_file = |p: &Path| p.to_string_lossy() == "/usr/local/bin/agent-vitals";
        assert_eq!(
            resolve_binary_from(&none, "/usr/local/bin".into(), exe, None, "agent-vitals", &is_file),
            Some(PathBuf::from("/usr/local/bin/agent-vitals"))
        );
    }


    #[test]
    fn resolve_binary_platform_config_matches_packaged_resource() {
        use tauri::utils::{config::parse::read_from, platform::Target};
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        for (target, source, destination) in [
            (Target::Windows, "../../../target/release/agent-vitals.exe", "bin/agent-vitals.exe"),
            (Target::Linux, "../../../target/release/agent-vitals", "bin/agent-vitals"),
            (Target::MacOS, "../../../target/release/agent-vitals", "bin/agent-vitals"),
        ] {
            let (value, _) = read_from(target, root).unwrap();
            let resources = value["bundle"]["resources"].as_object().unwrap();
            assert_eq!(resources.len(), 1);
            assert_eq!(resources[source], destination);
            let _: tauri::utils::config::Config = serde_json::from_value(value).unwrap();
        }
    }

    #[test]
    fn resolve_binary_uses_platform_resource_directory_before_path() {
        for name in ["agent-vitals", "agent-vitals.exe"] {
            let resource = PathBuf::from("installed-resources");
            let expected = resource.join("bin").join(name);
            let path_dir = PathBuf::from("path-bin");
            let path_binary = path_dir.join(name);
            let path = std::env::join_paths([&path_dir]).unwrap().into_string().unwrap();
            let is_file = |p: &Path| p == expected || p == path_binary;
            assert_eq!(resolve_binary_from(&|_| None, path.clone(), None,
                Some(resource.clone()), name, &is_file), Some(expected.clone()));
            let missing = |p: &Path| p == path_binary;
            assert_eq!(resolve_binary_from(&|_| None, path, None,
                Some(resource), name, &missing), Some(path_binary));
            assert_eq!(resolve_binary_from(&|_| Some("override".into()), String::new(), None,
                Some(PathBuf::from("resources")), name, &|_| true), Some(PathBuf::from("override")));
            let sibling = PathBuf::from("installed").join(name);
            assert_eq!(resolve_binary_from(&|_| Some("missing".into()), String::new(),
                Some(PathBuf::from("installed").join("desktop")), None, name,
                &|p| p == sibling), Some(sibling));
        }
    }

    /// days_from_civil 锚点：2026-08-27T00:00Z = 1787788800 秒（= 20692 天）。与
    /// overview.rs 的 civil_from_unix_secs 互为逆运算，锚点对上了两个方向都信得过。
    #[test]
    fn days_from_civil_matches_known_epoch_anchor() {
        assert_eq!(days_from_civil(2026, 8, 27), 20692);
        assert_eq!(days_from_civil(2026, 8, 27) * 86400, 1787788800);
        // 纪元起点：1970-01-01 = 0 天。
        assert_eq!(days_from_civil(1970, 1, 1), 0);
    }

    #[test]
    fn budget_period_end_uses_next_beijing_month_boundary() {
        assert_eq!(
            budget_period_end_ms_for_month("2026-09"),
            Some((days_from_civil(2026, 10, 1) * 86_400 - 8 * 3_600) * 1_000)
        );
        assert_eq!(
            budget_period_end_ms_for_month("2026-12"),
            Some((days_from_civil(2027, 1, 1) * 86_400 - 8 * 3_600) * 1_000)
        );
        assert_eq!(budget_period_end_ms_for_month("2026-13"), None);
    }

    /// RFC3339 解析钉住 alert.json 真机夹具：`2026-08-30T07:04:38.548588+00:00`
    /// = 1788073478 秒。同一瞬间用 Z / +08:00 / -05:00 三种写法必须解析出同一秒——
    /// 时区换算不对，freshness 判据会跟着错。
    #[test]
    fn parse_rfc3339_pins_fixture_and_offsets() {
        assert_eq!(parse_rfc3339_secs(FIXTURE_AT), Some(FIXTURE_AT_SECS));
        assert_eq!(parse_rfc3339_secs("2026-08-30T07:04:38Z"), Some(FIXTURE_AT_SECS));
        assert_eq!(parse_rfc3339_secs("2026-08-30T15:04:38+08:00"), Some(FIXTURE_AT_SECS));
        assert_eq!(parse_rfc3339_secs("2026-08-30T02:04:38-05:00"), Some(FIXTURE_AT_SECS));
        // 无小数位也认；负 epoch 前后（1970-01-01T00:00:00Z）→ 0。
        assert_eq!(parse_rfc3339_secs("2026-08-30T07:04:38+00:00"), Some(FIXTURE_AT_SECS));
        assert_eq!(parse_rfc3339_secs("1970-01-01T00:00:00Z"), Some(0));
    }

    /// 烂输入 → None（调用方按「无新鲜度信息」处理，不 panic 不臆造）。
    #[test]
    fn parse_rfc3339_garbage_is_none() {
        assert_eq!(parse_rfc3339_secs("not-a-timestamp"), None);
        assert_eq!(parse_rfc3339_secs("2026-08-30"), None);
        assert_eq!(parse_rfc3339_secs(""), None);
        assert_eq!(parse_rfc3339_secs("2026-13-40T25:61:61Z"), None);
    }

    /// stale 判据：> 5 分钟算过期（与工作台 workbench.js 同一阈值）；5 分钟内新鲜；
    /// generated_at 缺场 / 解析失败 → 不算过期（没有新鲜度信息 ≠ 过期）。
    #[test]
    fn stale_from_uses_5min_window() {
        assert!(!stale_from(Some(FIXTURE_AT), FIXTURE_AT_SECS + 120));
        assert!(stale_from(Some(FIXTURE_AT), FIXTURE_AT_SECS + 301));
        // 恰在边界内（300s）还算新鲜。
        assert!(!stale_from(Some(FIXTURE_AT), FIXTURE_AT_SECS + 300));
        assert!(!stale_from(None, FIXTURE_AT_SECS + 99999));
        assert!(!stale_from(Some("garbage"), FIXTURE_AT_SECS + 99999));
    }

    /// disabled 预算：alert.json 明确判禁用，托盘直说「已禁用」，绝不落入
    /// 「已用 xx%」的通用文案（review fix 6 的托盘侧）。
    #[test]
    fn budget_line_disabled_is_explicit() {
        let ov = ov_with(overview::BudgetAlert {
            source: "alert".into(),
            level: Some("disabled".into()),
            ..Default::default()
        });
        assert_eq!(budget_status_text_at(&ov, 0), "预算已禁用");
    }

    /// stale + ok：主入口绝不显示 ✓ —— 数据过期必须呈现为过期，不能假装正常
    /// （review fix 3：health 与 freshness 正交）。
    #[test]
    fn budget_line_stale_ok_never_shows_checkmark() {
        let ov = ov_with(overview::BudgetAlert {
            source: "alert".into(),
            level: Some("ok".into()),
            generated_at: Some(FIXTURE_AT.into()),
            month_cost: Some(12.7887157),
            monthly_cny: Some(600.0),
            ..Default::default()
        });
        // 新鲜（+60s）→ ✓；过期（+1h）→ ⚠ 数据过期。
        assert_eq!(budget_status_text_at(&ov, FIXTURE_AT_SECS + 60), "✓ 预算：¥12.79 / ¥600");
        assert_eq!(
            budget_status_text_at(&ov, FIXTURE_AT_SECS + 3600),
            "⚠ 预算（数据过期）：¥12.79 / ¥600"
        );
    }

    /// stale + over：超支语义仍要显示，但带过期后缀——「过期还绿」和「过期还超支
    /// 却不标过期」一样都是欺骗。
    #[test]
    fn budget_line_stale_over_keeps_alert_semantics_with_suffix() {
        let ov = ov_with(overview::BudgetAlert {
            source: "alert".into(),
            level: Some("over".into()),
            generated_at: Some(FIXTURE_AT.into()),
            month_cost: Some(612.5),
            monthly_cny: Some(600.0),
            ..Default::default()
        });
        assert_eq!(
            budget_status_text_at(&ov, FIXTURE_AT_SECS + 3600),
            "🚨 预算超支：¥612.5（月 ¥600）（数据过期）"
        );
    }

    /// RUNTIME_INVALIDATION spec §4.4：`FoldCompleted` 的时间去抖被 revision 电平
    /// 比较取代。fold 成功但没改库（revision 不动）→ 不发；改了库 → 只发一次；
    /// 同 revision 的 flush 路径与尾部电平检查两条路径不会双发。
    #[test]
    fn invalidation_replaces_fold_debounce_with_revision_level_compare() {
        use agent_vitals_runtime::events::{ChangePublisher, Invalidation};
        let publisher = ChangePublisher::<Invalidation>::new();
        let inv = |r: u64, harnesses: &[&str]| Invalidation {
            revision: r, harnesses: harnesses.iter().map(|h| h.to_string()).collect(),
        };
        let mut sent = Vec::new();
        // drain flush 带 harnesses 先发
        assert!(publisher.publish_if_advanced(inv(7, &["dsh"]), |i| sent.push(i.revision)));
        // 同 tick 尾部的空 harnesses 电平检查：同 revision → 吞
        assert!(!publisher.publish_if_advanced(inv(7, &[]), |i| sent.push(i.revision)));
        // 200ms 内的第二轮完成、库没变 → 吞（旧去抖窗的场景，现在靠 revision 判）
        assert!(!publisher.publish_if_advanced(inv(7, &["dsh"]), |i| sent.push(i.revision)));
        // 库变了 → 发
        assert!(publisher.publish_if_advanced(inv(8, &[]), |i| sent.push(i.revision)));
        assert_eq!(sent, vec![7, 8]);
    }

    /// SyncStatusChanged 变了才发：摘要相同但动态逐源结果改变时也必须刷新。
    #[test]
    fn sync_status_publishes_only_on_change() {
        use agent_vitals_runtime::events::ChangePublisher;
        let publisher = ChangePublisher::<(bool, String, String, Vec<overview::DynamicHarnessSyncReceipt>)>::new();
        let key = sync_status_publish_key;
        let mut n = 0;
        assert!(publisher.publish_if_changed(key(&SyncStatus::ok("discover", "无未折 DSH 会话".into())), |_| n += 1));
        assert!(!publisher.publish_if_changed(key(&SyncStatus::ok("discover", "无未折 DSH 会话".into())), |_| n += 1));
        assert!(publisher.publish_if_changed(key(&SyncStatus::ok("fold", "已折入 s1".into())), |_| n += 1));
        assert!(publisher.publish_if_changed(key(&SyncStatus::fail("fold", "oneline 失败".into())), |_| n += 1));
        let mut with_dynamic = SyncStatus::ok("complete", "新增 0 条".into());
        assert!(publisher.publish_if_changed(key(&with_dynamic), |_| n += 1));
        with_dynamic.dynamic_harnesses.push(overview::DynamicHarnessSyncReceipt {
            harness: "harness:zcode".into(), state: "failed".into(), error_code: Some("source_unavailable".into()),
            observed_at: "2026-10-05 12:00:00".into(), appended: 0, duplicate: 0,
        });
        assert!(publisher.publish_if_changed(key(&with_dynamic), |_| n += 1));
        assert_eq!(n, 5);
    }

    #[test]
    fn explicit_show_workbench_flag_overrides_existing_sync_receipt() {
        let ready = SyncStatus::ok("discover", "ready".into());
        assert!(!should_show_workbench_on_start(&ready, &[]));
        assert!(should_show_workbench_on_start(&ready, &["--show-workbench".into()]));
    }

    /// spec §9.2 #11 深链 slot 语义：peek 连续读两次返回同一目标（持久、
    /// 非破坏性——窗口未建/不可见时菜单点击的目标要留到工作台下次消费）；
    /// clear 后 None；set 覆盖旧目标。命令体（peek/clear）只是 slot 方法的
    /// 一层薄壳，语义直接钉在 slot 上。
    #[test]
    fn focus_target_peek_persists_clear_resets_and_set_overwrites() {
        let a = WorkbenchTarget::SessionDetail { session_ref: "sr_0123456789".into(), harness_kind: "dsh".into() };
        let b = WorkbenchTarget::SessionList { harness_kind: Some("codex".into()) };
        let slot = FocusTarget(Mutex::new(None));
        // 未设置 → None。
        assert_eq!(slot.peek(), None);
        // set 后 peek 两次 → 同一目标（持久）。
        slot.set(a.clone());
        assert_eq!(slot.peek(), Some(a.clone()));
        assert_eq!(slot.peek(), Some(a.clone()));
        // 覆盖式存入 → 旧目标消失，新目标生效。
        slot.set(b.clone());
        assert_eq!(slot.peek(), Some(b.clone()));
        // clear → None。
        slot.clear();
        assert_eq!(slot.peek(), None);
    }

    /// serde round-trip：路由目标只含安全的不透明 session_ref 与执行环境类型，
    /// 不泄露 native session key；外层 `type` tag 使用 camelCase 变体名。
    #[test]
    fn workbench_target_serde_round_trip_uses_opaque_session_ref() {
        let detail = WorkbenchTarget::SessionDetail { session_ref: "sr_0123456789".into(), harness_kind: "dsh".into() };
        let v = serde_json::to_value(&detail).unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "type": "sessionDetail",
                "session_ref": "sr_0123456789",
                "harness_kind": "dsh"
            })
        );
        // round-trip 闭合：同一 JSON 解析回原目标。
        let back: WorkbenchTarget = serde_json::from_value(v).unwrap();
        assert_eq!(back, detail);
        // SessionList 变体：harness_kind 可空（None = 全部，§7.1）。
        let list = WorkbenchTarget::SessionList { harness_kind: None };
        let lv = serde_json::to_value(&list).unwrap();
        assert_eq!(lv, serde_json::json!({"type": "sessionList", "harness_kind": null}));
        let back: WorkbenchTarget = serde_json::from_value(lv).unwrap();
        assert_eq!(back, list);
    }

    /// 动态菜单 id → WorkbenchTarget 映射：`session:{kind}:{i}` →
    /// SessionDetail（不透明 ref 与行内一致）；`harness:{kind}` → SessionList；禁用 id
    /// （unavailable/none/stale）→ None（禁用项点不到，事件即便到达也不该有
    /// 目标）；越界索引/未知执行环境 → None。
    #[test]
    fn menu_ids_map_to_workbench_targets_and_disabled_ids_are_inert() {
        let harnesses = vec![
            HarnessRow {
                harness_kind: "dsh".into(),
                status: "ready".into(),
                today_tokens: Some(1500),
                today_partial: false,
                today_sessions: Some(2),
                recent: vec![
                    RecentSessionRow {
                        session_key: serde_json::json!("sr_0123456789"),
                        title: Some("title".into()),
                        date: Some("2026-09-01".into()),
                        model: Some("m".into()),
                        tokens: Some(100),
                    },
                    // session_key 不完整（容错投影会保留这种行，overview.rs）：
                    // 该行仍渲染，但点了不动——不发一个回传不了的目标。
                    RecentSessionRow {
                        session_key: Value::Null,
                        title: Some("bad-key".into()),
                        date: None,
                        model: None,
                        tokens: None,
                    },
                ],
            },
            HarnessRow::unavailable("codex"),
        ];
        // 正常 L2 → SessionDetail，不透明 ref 原样带出。
        match workbench_target_for_menu_id("session:dsh:0", &harnesses) {
            Some(WorkbenchTarget::SessionDetail { session_ref, harness_kind }) => {
                assert_eq!(session_ref, "sr_0123456789");
                assert_eq!(harness_kind, "dsh");
            }
            other => panic!("session:dsh:0 应映射 SessionDetail，得 {other:?}"),
        }
        // 越界索引 → None。
        assert_eq!(workbench_target_for_menu_id("session:dsh:5", &harnesses), None);
        // session_key 不可回传（null）→ None。
        assert_eq!(workbench_target_for_menu_id("session:dsh:1", &harnesses), None);
        // 未知执行环境 → None。
        assert_eq!(workbench_target_for_menu_id("session:other:0", &harnesses), None);
        // harness:{kind} → SessionList（v1 子菜单点击不产事件，发射点留给将来）。
        assert_eq!(
            workbench_target_for_menu_id("harness:codex", &harnesses),
            Some(WorkbenchTarget::SessionList { harness_kind: Some("codex".into()) })
        );
        // 禁用 id 一律 None。
        assert_eq!(
            workbench_target_for_menu_id("session:unavailable:codex", &harnesses),
            None
        );
        assert_eq!(workbench_target_for_menu_id("session:none:codex", &harnesses), None);
        assert_eq!(workbench_target_for_menu_id("session:stale:dsh", &harnesses), None);
    }

    #[test]
    fn disabled_budget_does_not_enable_notification_permission_flow() {
        assert!(!budget_notifications_enabled(0, 0));
        assert!(budget_notifications_enabled(1, 0));
        assert!(budget_notifications_enabled(0, 1));
    }

    #[test]
    fn authority_backup_restore_validates_and_preserves_current_file() {
        let root = std::env::temp_dir().join(format!(
            "sv-menubar-restore-test-{}-{}",
            std::process::id(),
            agent_vitals_runtime::sql_sync::now_ms()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let backup = root.join("backup.sqlite");
        let target = root.join("authority.sqlite");
        drop(agent_vitals_data::authority::AuthorityDb::open(&backup, 1).unwrap());
        std::fs::write(&target, b"old-current").unwrap();

        let preserved = restore_authority_backup_file(&backup, &target, 42).unwrap();
        let preserved_path = root.join("authority.sqlite.pre-restore-42.bak");
        assert_eq!(preserved.as_deref(), Some(preserved_path.as_path()));
        assert_eq!(std::fs::read(preserved.unwrap()).unwrap(), b"old-current");
        assert!(agent_vitals_data::authority::AuthorityDb::open_readonly(&target).is_ok());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn invalid_authority_backup_does_not_replace_current_file() {
        let root = std::env::temp_dir().join(format!(
            "sv-menubar-invalid-restore-test-{}-{}",
            std::process::id(),
            agent_vitals_runtime::sql_sync::now_ms()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let backup = root.join("bad.sqlite");
        let target = root.join("authority.sqlite");
        std::fs::write(&backup, b"not-a-database").unwrap();
        std::fs::write(&target, b"keep-current").unwrap();

        assert!(restore_authority_backup_file(&backup, &target, 43).is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"keep-current");
        assert!(!root.join("authority.sqlite.pre-restore-43.bak").exists());
        let _ = std::fs::remove_dir_all(root);
    }
}
