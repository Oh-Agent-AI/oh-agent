//! Stage B 遗留收口：Runtime 共享 sync service —— 四执行环境**例行** facts ingest
//! （claude-code / codex / dsh，E4b 起 + workbuddy）。
//!
//! 本模块回答「**哪些会话文件该被 emit**」：文件发现（各执行环境 sources 的
//! locate 面）→ `source_files` SQL 指纹差量 → emitter → authority 写入。这是
//! month.json/today.json 退休路径（§5）的第 ① 步——
//! facts 平面从「手动 `--write` 诊断」升级为「可例行驱动的生产流」（托盘
//! tick / CLI 定时都调这里，不各自长文件枚举）。
//!
//! **`source_files` 是纯性能优化，不是正确性来源**：指纹 `(size, mtime_ns)`
//! 丢失/回退的最坏后果是重发 → writer 层 fact_id exactly-once 全部 Duplicate，
//! 账目零影响。源文件元数据与事实同一 SQL 事务提交；失败文件没有指纹行，
//! 下次必然重试。
//!
//! **namespace**：例行服务用 `takeover::machine_namespace()`（机器身份，
//! 跨次运行稳定）——与 CLI `--write` 要求调用方显式传入不冲突：那是诊断
//! 命令「不许 CLI 编造身份」的纪律，而 sync service 的调用者身份就是机器
//! 本身（machine.json 持久化 UUID，重装明示新 profile，不静默重排历史）。
//!
//! **调用方**：托盘 tick（desktop `run_facts_sync`，claude-sync 成功后叠跑）
//! 与 CLI `sync-facts`。**不在此处的**：watcher（§7.1 门槛未触发）、SQLite
//! 旧 JSON 投影更新（已退役）。

use std::path::{Path, PathBuf};

use agent_vitals_domain::workflow::WorkflowEvent;
use rusqlite::OptionalExtension;
use serde_json::{json, Value};

/// 单文件指纹（size + mtime 纳秒）——与 `claude_cost` fold checkpoint 同款。
/// **无时间戳字段**：指纹就是状态，字节确定性由构造保证。
/// （换行边界扫描在 `agent-vitals-harnesses::sources::parsers`——P3 起它属于
/// 解析器注册表，只有增量能力执行环境才需要写换行边界检查点。）
fn fingerprint(path: &Path) -> Option<(u64, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?;
    Some((meta.len(), mtime.as_nanos() as u64))
}

/// 单执行环境同步结果。`errors` 是「该文件本轮没写进 authority」的
/// 明细——下次 sync 会重试它们（永久坏文件会每次重试并每次出现在这里，
/// 这是诚实噪声：坏文件不该被静默遗忘）。
#[derive(Debug, Default, serde::Serialize)]
pub struct HarnessSyncReport {
    pub harness: String,
    pub files_seen: usize,
    pub files_synced: usize,
    pub files_skipped: usize,
    pub appended: usize,
    pub duplicate: usize,
    /// 迁移期双写（spec §6.1）：权威库侧新插入数。None = 权威库未启用
    /// （打开失败，错误已上 stderr）。
    pub sql_inserted: Option<usize>,
    pub sql_duplicate: Option<usize>,
    pub errors: Vec<String>,
    /// W8：本轮 SourceGraph 判脏的源文件（只 dsh/codex 填）——findings 评估器
    /// 的增量输入。不进 JSON：路径不出本机报告面。
    #[serde(skip)]
    pub findings_candidates: Vec<PathBuf>,
}

/// 三执行环境例行同步报告。
#[derive(Debug, Default, serde::Serialize)]
pub struct SyncReport {
    pub harnesses: Vec<HarnessSyncReport>,
    pub total_appended: usize,
    pub total_duplicate: usize,
    /// 本轮同步末尾按当前有效计费声明新写的归因行数
    /// （`AuthorityDb::billing_apply_active_declarations`）。
    pub declarations_applied: usize,
    /// W8：同步后的行为 findings 评估（`ingest::findings_eval`）。None = 本轮
    /// 没有需要评估的 DSH/Codex 会话。评估错误在这里，不混进执行环境 `errors`
    /// （后者的语义是「该文件没写进 authority、下轮重试」）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub behavior_findings: Option<crate::ingest::findings_eval::EvalReport>,
}

/// R5-F7a（REFRESH_STORM）：按文件指纹的配额扫描缓存。quota 的重活在
/// 「逐行解析 7 天窗内全部会话文件」（真机 541 文件/828MB，每 tick 与脏文件
/// 无关地全量重解析）；缓存 `(size, mtime_ns)` 未变文件的解析贡献，未变文件
/// 零解析。**合并语义与全量扫逐字节一致**（对拍测试钉住）：7 天 recent-floor
/// 按当前时间在合并处施加（`scan_claude_quota_from_contributions`），不随
/// 缓存冻结。state 文件 `facts/.claude-quota-cache.json`，条目裁剪到本轮
/// 文件集（滑出 7 天 mtime 窗的文件自然出局）；mtime 读不到的文件指纹记 0、
/// 永不命中缓存（与全量扫的「mtime 读不到照扫」同态度）。
fn scan_claude_quota_cached(
    data_home: &Path,
    files: &[PathBuf],
    now: std::time::SystemTime,
) -> agent_vitals_harnesses::claude_quota::QuotaScan {
    use agent_vitals_harnesses::claude_quota::{
        scan_claude_quota_from_contributions, quota_contribution_from_file,
        QuotaFileContribution, QuotaScan, QUOTA_SCAN_WINDOW,
    };
    use std::collections::BTreeMap;

    #[derive(serde::Serialize, serde::Deserialize, Clone)]
    struct CachedQuotaEntry {
        size: u64,
        mtime_ns: u64,
        contribution: QuotaFileContribution,
    }
    type CacheMap = BTreeMap<String, CachedQuotaEntry>;

    let cache_path = data_home.join("facts").join(".claude-quota-cache.json");
    let cache: CacheMap = crate::state::read_json(&cache_path)
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default();
    let cutoff = now.checked_sub(QUOTA_SCAN_WINDOW);
    let mut fresh: CacheMap = BTreeMap::new();
    let mut contributions: Vec<QuotaFileContribution> = Vec::new();
    for path in files {
        let Ok(meta) = std::fs::metadata(path) else { continue };
        let in_window = match (cutoff, meta.modified()) {
            (Some(cutoff), Ok(modified)) => modified >= cutoff,
            // mtime 读不到 → 照扫（与全量扫同态度）。
            _ => true,
        };
        if !in_window {
            continue;
        }
        let key = path.display().to_string();
        let size = meta.len();
        let mtime_ns = meta
            .modified()
            .ok()
            .and_then(|m| m.duration_since(std::time::SystemTime::UNIX_EPOCH).ok())
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);
        if mtime_ns != 0 {
            if let Some(entry) = cache.get(&key) {
                if entry.size == size && entry.mtime_ns == mtime_ns {
                    contributions.push(entry.contribution.clone());
                    fresh.insert(key, entry.clone());
                    continue;
                }
            }
        }
        let contribution = quota_contribution_from_file(path);
        fresh.insert(key, CachedQuotaEntry { size, mtime_ns, contribution: contribution.clone() });
        contributions.push(contribution);
    }
    let scan: QuotaScan =
        scan_claude_quota_from_contributions(contributions.iter(), now);
    // 缓存落盘是纯性能优化，任何 I/O 故障（磁盘满/只读目录）都不得拖垮同步
    // ——best-effort 写，失败则本轮不缓存（下轮重解析），评审 P2-2。
    if let Ok(value) = serde_json::to_value(&fresh) {
        let tmp = cache_path.with_extension("json.tmp");
        if std::fs::write(&tmp, value.to_string()).is_ok() {
            let _ = std::fs::rename(&tmp, &cache_path);
        }
    }
    scan
}

/// 对单个执行环境执行「发现 → SQL 差量 → emit → authority 写入」。
/// `emit` 的执行环境差异收敛在这个闭包里：输入差量文件集，输出事实批（或
/// 逐文件错误）。
fn sync_harness(
    harness: &str,
    ns: &str,
    db: &agent_vitals_data::authority::AuthorityDb,
    data_home: &Path,
    roots: &agent_vitals_harnesses::sources::session_harnesses::HarnessRoots<'_>,
    files: Vec<PathBuf>,
    report: &mut HarnessSyncReport,
) -> Result<(), String> {
    report.files_seen = files.len();
    let now = crate::clock::now_ms();
    // schema v2 新增了 Codex 当前配额快照。升级已有权威库时，旧 source_files
    // 指纹会让所有 rollout 都被跳过，因而必须强制重放一次，不能把「日志未变」
    // 误当成「新派生状态已经存在」。没有 rate_limits 的历史也只重放一次：同一
    // 事务留下 schema_meta 标记，避免以后每个 tick 扫完整个 rollout 历史。
    let runtime_snapshot_backfill_needed = if harness == "codex" {
        let already_backfilled: Option<i64> = db
            .conn()
            .query_row(
                "SELECT 1 FROM schema_meta
                 WHERE key = 'codex_quota_snapshot_backfilled_v2'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| format!("read Codex quota backfill marker: {e}"))?;
        already_backfilled.is_none()
    } else {
        false
    };
    let mut dirty: Vec<(PathBuf, (u64, u64))> = Vec::new();
    // 配额扫描要用**整份候选清单**（下面这个循环会把 `files` 消费掉）。复制一份
    // 路径而已（247 个 PathBuf，可忽略），换来的是撞窗计数覆盖完整的 7 天窗口——
    // 只看 dirty 会把"近 7 天撞窗 3 次"报成 1 次，那是拿一个支持不了的数字当结论。
    let harness_files: Vec<PathBuf> = files.clone();
    // 发现/失效判定走 SourceGraph classify()（F3 修复 + M2 参数对齐）。
    // 发现层与 emit 层用**同一组 classify 参数**——此前发现层硬编码
    // can_increment=false 而 emit 层判 true，两次调用结论矛盾（复跑 M2）。
    // 发现层只需正确判定 skip（Unchanged） vs 处理（非 Unchanged），
    // 具体增量/全量路由由 emit 层的第二次 classify 决定。
    let expected_version = crate::sql_sync::parser_version();
    // classify 的 expected_parser/can_increment 参数经执行环境解析器注册表
    // （agent-vitals-harnesses::sources::parsers，P3 执行环境铺开）——runtime 不再
    // 持有 harness 字符串特判。
    let descriptor = agent_vitals_harnesses::parsers::descriptor_for(harness);
    let expected_parser = descriptor.parser_id;
    let can_increment_discovery = descriptor.can_increment;
    for path in files {
        let fp = fingerprint(&path);
        let hash = crate::source_graph::path_hash(&path);
        let checkpoint = crate::source_graph::read_checkpoint(db.conn(), harness, &hash)
            .map_err(|e| format!("source_graph checkpoint: {e}"))?;
        let on_disk = fp;
        let decision = crate::source_graph::classify(
            &checkpoint.unwrap_or_default(),
            on_disk,
            can_increment_discovery,
            expected_parser,
            expected_version,
        );
        // codex 配额快照回填需要：即便 Unchanged 也强制走一次
        if matches!(decision, crate::source_graph::Invalidation::Unchanged)
            && !runtime_snapshot_backfill_needed
        {
            report.files_skipped += 1;
            continue;
        }
        let Some(fp) = fp else {
            report
                .errors
                .push(format!("{}: stat failed (vanished?)", path.display()));
            continue;
        };
        // classify 判定非 Unchanged（或回填需要）→ 标脏 + 进处理列表
        crate::source_graph::mark_dirty(db.conn(), harness, &hash)
            .map_err(|e| format!("source_graph mark_dirty: {e}"))?;
        dirty.push((path, fp));
    }

    if agent_vitals_harnesses::sources::session_harnesses::session_harness(harness)
        .is_some_and(|h| h.findings.is_some())
    {
        report.findings_candidates = dirty.iter().map(|(p, _)| p.clone()).collect();
    }
    let mut facts: Vec<Value> = Vec::new();
    // 本轮要落库的执行环境实时快照（kind, payload, observed_at_ms）。Codex 的配额与
    // Claude 的窗口状态共用这一条路，但各自是独立的 snapshot_kind。
    let mut pending_snapshots: Vec<(&'static str, String, i64)> = Vec::new();
    let mut workflow_events: Vec<WorkflowEvent> = Vec::new();
    // V16：任务意图摘录（现仅 claude-code emitter 产；其他执行环境空集）。
    let mut session_excerpts: Vec<agent_vitals_domain::contracts::workflow::SessionExcerpt> =
        Vec::new();
    // V32：解析产出的会话标题（现仅 claude-code 的 ai-title；codex/dsh 的侧车
    // 索引标题在写完事实后走独立的 apply_session_titles 趟）。
    let mut session_titles: Vec<agent_vitals_domain::contracts::workflow::SessionTitle> =
        Vec::new();
    let mut synced_sources: Vec<(PathBuf, (u64, u64))> = Vec::new();
    // codex 的 emitter 跨文件 `seen` 去重只在**单次调用内**成立（live/
    // archived 同 stem 双收靠它）——差量集必须一批喂进去，逐文件调用会把
    // 去重丢给 ingest 层（账不错但 duplicate 通胀 + 双倍 emit；tick 常驻后
    // 每 5 分钟付一次，审查 P2-1）。claude/dsh 是单文件语义，逐文件隔离错误。
    let codex_dirty: Vec<PathBuf> = dirty.iter().map(|(p, _)| p.clone()).collect();
    if harness == "codex" && !codex_dirty.is_empty() {
        match agent_vitals_harnesses::codex_usage_fact::codex_rollouts_to_usage_facts_with_route(
            &codex_dirty,
            ns,
            "default",
            None,
        ) {
            Ok(r) => {
                if let (Some(contract), Some(payload)) = (r.quota_snapshot, r.quota_snapshot_payload_json) {
                    // 观察时刻挪到这里派生：**解析失败只跳过这条快照，不再让整批写入
                    // 失败**（旧行为是 Err 上抛，一个坏时间戳会连累整个执行环境的 facts）。
                    match agent_vitals_domain::budget::parse_iso(&contract.observed_at) {
                        Some((seconds, _)) => pending_snapshots.push((
                            "codex_quota",
                            payload,
                            seconds.saturating_mul(1_000),
                        )),
                        None => report
                            .errors
                            .push("codex quota snapshot: observed_at 不可解析，跳过落库".to_string()),
                    }
                }
                facts.extend(r.facts);
                workflow_events.extend(r.workflow_events);
                synced_sources.extend(dirty.iter().cloned());
            }
            Err(e) => {
                // 批量 Err = 任一文件读失败（read 层错误）——全部重试，
                // 错误如实上呈。
                report.errors.push(format!("codex batch: {e}"));
            }
        }
    }
    let mut incremental_checkpoints: std::collections::HashMap<String, crate::source_graph::SourceCheckpointOverride> = std::collections::HashMap::new();
    // 解析路由经执行环境注册表（P3 收编，此前 `harness == "claude-code"` 字面量
    // 特判散落两处）。trait 背书的逐文件执行环境在这里走 parse_increment/parse_full；
    // codex 是批 emitter（跨文件 seen 去重 + 整批配额折叠，见上），
    // 注册表对它只给 descriptor 申报、不给 trait 实现。
    let registered = agent_vitals_harnesses::parsers::parser_for(harness);
    for (path, fp) in &dirty {
        if harness == "codex" {
            continue; // 已批量处理
        }
        let Some(parser) = registered else {
            report.errors.push(format!(
                "{}: harness `{harness}` has no registered parser",
                path.display()
            ));
            continue;
        };
        // P1b/P3：SourceGraph 增量路由——classify 已在发现层标脏并判定软/硬。
        // 这里查检查点 + 注册表 descriptor 决定走增量还是全量。
        let hash = crate::source_graph::path_hash(path);
        let checkpoint = crate::source_graph::read_checkpoint(db.conn(), harness, &hash)
            .map_err(|e| format!("source_graph checkpoint: {e}"))?
            .unwrap_or_default();
        // can_increment = 解析器申报（descriptor）合取检查点已有起读 offset
        //（trait 缺省判定）；全量申报执行环境恒 false。
        let can_increment = parser.can_increment(&checkpoint);
        let emit_expected_parser = if can_increment {
            parser.descriptor().parser_id
        } else {
            crate::source_graph::FULL_PARSE_V0
        };
        let decision = crate::source_graph::classify(
            &checkpoint, Some(*fp), can_increment,
            emit_expected_parser,
            crate::sql_sync::parser_version(),
        );
        let incremental_offset = match &decision {
            crate::source_graph::Invalidation::Incremental { from_offset } => Some(*from_offset),
            _ => None,
        };
        let ctx = crate::source_graph::ParseContext {
            machine_namespace: ns,
            source_profile: "default",
        };

        type EmitTuple = (
            Vec<Value>,
            Vec<WorkflowEvent>,
            Vec<agent_vitals_domain::contracts::workflow::SessionExcerpt>,
            Vec<agent_vitals_domain::contracts::workflow::SessionTitle>,
        );
        let emit: Result<EmitTuple, String> = if let Some(from_offset) = incremental_offset {
            // 增量路径：usage facts 从 offset 续读（GB 级收益）。检查点推进
            // 随写事务（checkpoint_overrides 穿透 write_flat_facts_with_sources
            // ——M1 修复：事务外死写会被写路径覆盖，parser_id 从不跨 tick 存活）。
            parser.parse_increment(&ctx, path, from_offset).map(|out| {
                incremental_checkpoints.insert(hash.clone(),
                    crate::source_graph::SourceCheckpointOverride {
                        parser_id: parser.descriptor().parser_id.to_string(),
                        byte_offset: Some(out.new_offset),
                    });
                (out.facts, out.workflow_events, out.session_excerpts, out.session_titles)
            })
        } else {
            // 全量路径（首见/硬失效/全量申报执行环境）。增量能力执行环境的全量轮也要
            // 写自己的 parser_id + **换行边界**（不是 stat size）：否则下次
            // classify 判 parser-id-mismatch，该文件永远进不了增量（F2 死循环
            // 防线）。全量申报执行环境不覆写——写路径按 FULL_PARSE_V0 + stat size
            // 落（dsh/workbuddy 现状，它们的 offset 无语义）。
            parser.parse_full(&ctx, path).map(|out| {
                if parser.descriptor().can_increment {
                    incremental_checkpoints.insert(hash.clone(),
                        crate::source_graph::SourceCheckpointOverride {
                            parser_id: parser.descriptor().parser_id.to_string(),
                            byte_offset: Some(out.new_offset),
                        });
                }
                (out.facts, out.workflow_events, out.session_excerpts, out.session_titles)
            })
        };
        match emit {
            Ok((f, events, excerpts, titles)) => {
                facts.extend(f);
                workflow_events.extend(events);
                session_excerpts.extend(excerpts);
                session_titles.extend(titles);
                synced_sources.push((path.clone(), *fp));
            }
            Err(e) => report.errors.push(format!("{}: {e}", path.display())),
        }
    }

    // Claude Pro 的窗口状态（`quotaLimits`）。扫**最近 7 天改动过的**会话文件
    // （窗口由 `scan_claude_quota` 自己按 mtime 筛；7 天 = 最长窗口，再往前扫
    // 不会改变结论）。扫不到就保持旧快照不动（不写空值）：
    // 窗口状态是"越新越准"的观察，空值覆盖反而会把已有证据抹掉，过期与否交给
    // 状态机按 `resets_at` 判。
    if harness == "claude-code" {
        let scan = scan_claude_quota_cached(data_home, &harness_files, std::time::SystemTime::now());
        // 待处理任务：窗口耗尽 → 建一条；重置或不再有证据 → 自动解决。与快照
        // 同一轮推进，所以「窗口一重置，任务自己从列表里消失」不需要额外机制。
        let exhausted = scan.latest.as_ref().and_then(|snapshot| {
            match agent_vitals_harnesses::claude_quota::window_state(snapshot, now / 1_000) {
                agent_vitals_harnesses::claude_quota::WindowState::Exhausted { resets_at, window } => Some((
                    resets_at,
                    window,
                    agent_vitals_harnesses::claude_quota::window_label(window),
                )),
                agent_vitals_harnesses::claude_quota::WindowState::Unknown => None,
            }
        });
        if let Err(e) = agent_vitals_data::issues::reconcile_quota_window_issue(
            db.conn(), harness, exhausted, now,
        ) {
            report.errors.push(format!("claude quota issue: {e}"));
        }
        if let Some(snapshot) = scan.latest {
            // 撞窗次数与"最新那次"同一份 payload：`unknown` 态唯一的可显示内容
            // 就是它（spec §8.3.2「窗口状态未知 · 本周撞窗 N 次」）。
            pending_snapshots.push((
                "claude_quota",
                snapshot.payload_with_windows(scan.windows_recent),
                snapshot.observed_at_secs.saturating_mul(1_000),
            ));
        }
    }

    if !synced_sources.is_empty() {
        let snapshot_write = (!pending_snapshots.is_empty() || runtime_snapshot_backfill_needed)
            .then(|| crate::sql_sync::RuntimeSnapshotWrite {
                snapshots: pending_snapshots
                    .iter()
                    .map(|(kind, payload, observed_at_ms)| crate::sql_sync::RuntimeQuotaSnapshot {
                        snapshot_kind: kind,
                        payload_json: payload.as_str(),
                        observed_at_ms: *observed_at_ms,
                    })
                    .collect(),
                backfill_marker: runtime_snapshot_backfill_needed
                    .then_some("codex_quota_snapshot_backfilled_v2"),
            });
        let outcome = crate::sql_sync::write_flat_facts_with_sources_and_extension(
            db,
            harness,
            ns,
            &synced_sources,
            &incremental_checkpoints,
            &facts,
            &workflow_events,
            &session_excerpts,
            &session_titles,
            None,
            snapshot_write,
            now,
            None,
        )?;
        report.files_synced += outcome.files_synced;
        report.appended = outcome.inserted;
        report.duplicate = outcome.duplicate;
        report.sql_inserted = Some(outcome.inserted);
        report.sql_duplicate = Some(outcome.duplicate);
        report.errors.extend(outcome.errors);
    }

    // V32：侧车索引型会话标题——注册表声明（codex `session_index.jsonl`、DSH
    // `storages/workspace.json`；调度器不做 harness 特判）。索引每 tick 重读、
    // 与脏文件无关：用户重命名线程后 rollout 未变也要能刷标题。无变更轮零写
    // 零 revision（apply_session_titles 的先读后写纪律）。
    if let Some(title_index) = agent_vitals_harnesses::sources::session_harnesses::session_harness(harness)
        .and_then(|registered| registered.title_index)
    {
        let titles = title_index(roots);
        if !titles.is_empty() {
            if let Err(e) = crate::sql_sync::apply_session_titles(db, harness, ns, &titles, now) {
                report.errors.push(format!("{harness} session titles: {e}"));
            }
        }
    }

    Ok(())
}

/// 例行同步入口（`ingest_service::FACT_HARNESSES` 全部执行环境）。幂等：重复调用第二次
/// 基本全 skipped / duplicate。
pub fn sync_facts(data_home: &Path) -> Result<SyncReport, String> {
    sync_facts_filtered(data_home, None)
}

/// 定向同步入口（LIGHT-PATH spec §5.2）：`only` 给出时只跑这些执行环境的批
/// （批级过滤——codex 的整批语义在 `sync_harness` 之内，不受影响）。`None` =
/// 全执行环境，行为与 [`sync_facts`] 逐字节一致。被过滤掉的执行环境不 acquire
/// lease、不产生 HarnessSyncReport（对账责任整体留给周期重 tick）。
pub fn sync_facts_filtered(
    data_home: &Path,
    only: Option<&std::collections::BTreeSet<String>>,
) -> Result<SyncReport, String> {
    // 读取范围决定本轮会接触哪些本地数据，必须在任何维护写入之前完整校验。
    // 配置损坏时宁可不启动同步，也不能先清理一部分旧事实再报告错误。
    let custom_sources = crate::custom_sources::custom_source_roots(data_home)
        .map_err(|error| format!("custom source configuration failed: {error}"))?;
    let source_home = PathBuf::from(std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default());
    super::extension_installer::ensure_active_compiled_sources_exclusive(data_home, &source_home)
        .map_err(|error| format!("source exclusivity failed: {error}"))?;
    // Validate the control file before maintenance writes; the authoritative
    // decision is re-read under each harness lease immediately before import.
    crate::source_controls::excluded_harnesses(data_home)
        .map_err(|error| format!("source controls failed: {error}"))?;
    // **machine_namespace 首建单飞（审查 P2-3）**：machine.json 缺失时两个
    // 进程同时首启（托盘 tick + 外部 cron）会各自生成不同 ns、写各自的
    // machine.json（rename 竞态一方覆盖）→ 同一批文件的事实按两个 ns 拆开
    // 入库。把 bootstrap 关进 facts 锁（machine.json 快路径存在时锁是无谓
    // 成本，纳秒级；仅首次首启真正串行）。
    let ns = {
        let _g = crate::lease::acquire_blocking(
            &data_home.join("facts").join(".ingest.lock"),
            "facts-ns-bootstrap",
            60_000,
            10_000,
        )
        .map_err(|e| format!("facts ns bootstrap lease: {e}"))?;
        crate::takeover::machine_namespace()
    };
    // SQL authority 既是事实库也是例行同步的唯一差量索引。打开失败就失败，不能
    // 回落 JSON checkpoint 或旧 ingest 链，否则会制造「看似同步成功、SQL 未写」。
    let authority = agent_vitals_data::authority::AuthorityDb::open(
        &agent_vitals_data::authority::default_authority_path(data_home),
        crate::clock::now_ms(),
    )
    .map_err(|e| format!("authority open failed: {e}"))?;
    if let Err(e) =
        crate::sql_sync::migrate_json_checkpoint(&authority, data_home, crate::clock::now_ms())
    {
        return Err(format!("checkpoint migration failed: {e}"));
    }
    {
        let db = &authority;
        let bj_day = crate::clock::today_beijing();
        let ret_path = data_home.join("facts").join(".authority-retention.json");
        let last: Option<String> = crate::state::read_json(&ret_path).and_then(|v| {
            v.get("last_retention_date")
                .and_then(Value::as_str)
                .map(String::from)
        });
        // matches! 直接比 Option<String>（as_deref 会触发 needless lint）。
        if !matches!(&last, Some(d) if d == &bj_day) {
            // 保留滚动也是写入 → maintenance run（spec §5.4「记录 maintenance
            // run」）+ 事务；失败不盖日戳（审查 P2：静默顺延 24h 是劣化）。
            let run_id = crate::sql_sync::new_run_id("maintenance");
            let _ = db.begin_run(&run_id, "maintenance", crate::clock::now_ms());
            let retention_months = crate::retention::retention_months(data_home)
                .map_err(|error| format!("retention configuration failed: {error}"))?;
            let cutoff = crate::sql_sync::retention_cutoff_ms(
                &crate::clock::current_month_beijing(),
                retention_months - 1,
            )
            .unwrap_or(0);
            let now = crate::clock::now_ms();
            // 四步各自计数、各自如实报数（独立验证发现：and_then 链只保留尾环
            // 计数，此前 eprintln 拿它当 facts 数——标签与对象双双错位）。
            // 失败语义不变：任一步 Err → 整轮 failed、不盖日戳、下轮全量重跑
            // （四步皆幂等 DELETE，重跑已成功步为 0 行）。
            let steps: [(&str, Result<usize, agent_vitals_data::authority::AuthorityError>); 4] = [
                ("usage_facts", db.retention_usage_facts(cutoff)),
                ("session_excerpts", db.retention_session_excerpts(cutoff)),
                // v23 事件 outbox 保留 + v18 孤儿接线（retention_trust_observations
                // 有实现有测试但生产零调用——2026-09-21 迭代 3 发现）。
                ("event_outbox", db.retention_event_outbox(now)),
                ("trust_observations", db.retention_trust_observations(now)),
            ];
            let failed = steps
                .iter()
                .find(|(_, r)| r.is_err())
                .map(|(name, _)| *name);
            let summary: Vec<String> = steps
                .iter()
                .filter_map(|(name, r)| match r {
                    Ok(n) if *n > 0 => Some(format!("{name} {n}")),
                    _ => None,
                })
                .collect();
            if !summary.is_empty() {
                crate::core::logging::log_info(
                    "sync_service",
                    &format!("authority retention ({retention_months}mo): {}", summary.join(", ")),
                );
            }
            let _ = db.finish_run(
                &run_id,
                if failed.is_none() { "succeeded" } else { "failed" },
                failed.map(|_| "retention_failed".to_string()).as_deref(),
                None,
                crate::clock::now_ms(),
            );
            match failed {
                None => {
                    crate::state::atomic_write_json(
                        &ret_path,
                        &json!({"last_retention_date": bj_day}),
                    );
                }
                Some(step) => {
                    let detail = steps
                        .iter()
                        .find_map(|(_, r)| match r {
                            Err(e) => Some(e.to_string()),
                            _ => None,
                        })
                        .unwrap_or_default();
                    crate::core::logging::log_warn(
                        "sync_service",
                        &format!("authority retention failed at {step}: {detail}"),
                    );
                }
            }
        }
    }
    let mut report = SyncReport::default();

    // 各执行环境 locate 面直取（harnesses sources 的既有函数，不在这里重写枚举）。
    let user_home = PathBuf::from(
        std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_default(),
    );
    // 定向同步（LIGHT-PATH §5.2，验收 #2）：walk 也按执行环境裁剪——非唤醒执行环境
    // 不付目录遍历成本（stat 对账与解析本来就在后面的批过滤里跳过，但目录
    // walk 本身每执行环境几百次 stat，不裁剪的话轻 tick 的发现面仍是全执行环境）。
    let wanted = |harness: &str| only.map_or(true, |set| set.contains(harness));
    // R5-F7b（REFRESH_STORM）：四个内置执行环境的清单与错误同一次遍历（此前每执行环境
    // 两个函数各自 walk 一遍——codex 真机 2.96 万文件 × 2 趟/轻 tick，claude
    // 541 文件 × 2 趟同款）；且错误面同样按唤醒裁剪——执行环境未唤醒时一趟都不走
    // （此前各 *_walk_errors 不看 wanted）。claude/dsh/workbuddy 是 F7b 从 codex
    // 推广的同款（模板提交 09c8533）。
    // W3：执行环境的「根在哪、根下怎么枚举」来自 harnesses 的会话执行环境注册表，这里不再按执行环境名
    // 分支。注册表顺序即批次顺序（claude-code → codex → dsh → workbuddy，同步报告
    // `harnesses[]` 顺序不变）；错误也是先四个内置根、再自定义源根（与原逐执行环境写法同序）。
    let dsh_home = crate::home::dsh_home();
    let roots = agent_vitals_harnesses::sources::session_harnesses::HarnessRoots {
        user_home: &user_home,
        dsh_home: dsh_home.as_deref(),
    };
    let registry = &agent_vitals_harnesses::sources::session_harnesses::SESSION_HARNESSES;
    let mut batches: Vec<(&str, Vec<PathBuf>)> = Vec::with_capacity(registry.len());
    let mut discovery_errors: Vec<(String, String)> = Vec::new();
    for harness in registry.iter() {
        // 根未知（如 DSH_HOME 与 HOME 都没有）→ 空清单、无错误：无根不报错，同原语义。
        let (files, errors) = match (wanted(harness.id), (harness.default_root)(&roots)) {
            (true, Some(root)) => (harness.files_under)(&root),
            _ => (Vec::new(), Vec::new()),
        };
        discovery_errors.extend(errors.into_iter().map(|error| (harness.id.to_string(), error)));
        batches.push((harness.id, files));
    }
    // 自定义源根：原实现不看 `wanted`（未唤醒执行环境的自定义根也会遍历，批次随后被
    // `only` 过滤）。W3 只做结构迁移，行为原样保留。
    for source in custom_sources {
        let Some(harness) = agent_vitals_harnesses::sources::session_harnesses::session_harness(&source.harness)
            .filter(|harness| harness.accepts_custom_roots)
        else {
            continue;
        };
        let (files, errors) = (harness.files_under)(Path::new(&source.root));
        discovery_errors.extend(errors.into_iter().map(|error| (harness.id.to_string(), error)));
        if let Some((_, batch)) = batches.iter_mut().find(|(id, _)| *id == harness.id) {
            batch.extend(files);
        }
    }
    for (_, files) in &mut batches {
        files.sort();
        files.dedup();
    }
    // W8：findings 评估的输入在执行环境循环里收集、循环后在锁外算（见 findings_eval）。
    // 回填标记缺失 = 升级后首轮：全部会话评估一次（它们在 SourceGraph 眼里是
    // Unchanged，不回填就永远停在 r2a 最后一次运行的样子）。
    let findings_backfill = authority
        .conn()
        .query_row(
            "SELECT 1 FROM schema_meta WHERE key = ?1",
            [crate::ingest::findings_eval::BACKFILL_META_KEY],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|e| format!("read findings backfill marker: {e}"))?
        .is_none();
    let mut findings_work: Vec<(
        &'static agent_vitals_harnesses::sources::session_harnesses::SessionHarness,
        Vec<PathBuf>,
        Vec<PathBuf>,
    )> = Vec::new();
    for (harness, files) in batches {
        // Serialize each harness's ingest with source deletion.  The exclusion
        // decision is deliberately re-read while holding the same per-harness
        // lease as the delete command; otherwise a concurrent sync could pass
        // an old exclusion snapshot and re-import data after deletion.
        if let Some(only) = only {
            if !only.contains(harness) {
                continue;
            }
        }
        let harness_lease = crate::lease::acquire_blocking(
            &crate::source_controls::harness_data_lock_path(data_home, harness)?,
            "facts-source-sync",
            600_000,
            10_000,
        )
        .map_err(|error| format!("source {harness} lease: {error}"))?;
        let _harness_heartbeat = harness_lease.heartbeat(std::time::Duration::from_secs(30), 600_000);
        let excluded_harnesses = crate::source_controls::excluded_harnesses(data_home)
            .map_err(|error| format!("source controls failed: {error}"))?;
        if excluded_harnesses.contains(harness) {
            continue;
        }
        let mut r = HarnessSyncReport {
            harness: harness.to_string(),
            ..Default::default()
        };
        let evaluated_harness = agent_vitals_harnesses::sources::session_harnesses::session_harness(harness)
            .filter(|h| h.findings.is_some());
        let all_files = if evaluated_harness.is_some() { files.clone() } else { Vec::new() };
        sync_harness(harness, &ns, &authority, data_home, &roots, files, &mut r)?;
        if let Some(eval_harness) = evaluated_harness {
            let changed = if findings_backfill {
                all_files.clone()
            } else {
                std::mem::take(&mut r.findings_candidates)
            };
            findings_work.push((eval_harness, changed, all_files));
        }
        for (error_harness, error) in &discovery_errors {
            if error_harness == harness {
                r.errors.push(format!("discovery: {error}"));
            }
        }
        report.total_appended += r.appended;
        report.total_duplicate += r.duplicate;
        report.harnesses.push(r);
    }

    // W8：行为 findings 评估。规则计算在锁外（DSH 解压 + 审计、Codex 解析都慢，
    // CLAUDE.md「临界区必须短」）；写库每执行环境一个短临界区，并在锁内重读排除
    // 名单——与上面的摄取同一把执行环境锁，删除数据源与评估写入不会交错。
    if findings_work.iter().any(|(_, changed, _)| !changed.is_empty()) {
        use crate::ingest::findings_eval;
        let mut eval = findings_eval::EvalReport::default();
        let mut all_persisted = true;
        // 价卡（内置 + 用户覆盖）一轮只加载一次，各执行环境评估共用。
        let pricing = crate::price_overrides::merged_main(data_home);
        let codex_index_cache = data_home.join("facts").join(".codex-session-index.json");
        let ctx = agent_vitals_harnesses::sources::session_harnesses::FindingsCtx {
            roots,
            codex_index_cache: &codex_index_cache,
            pricing: &pricing,
        };
        for (session_harness, changed, all_files) in &findings_work {
            let harness = session_harness.id;
            let Some(evaluate) = session_harness.findings else { continue };
            if changed.is_empty() {
                continue;
            }
            let (sessions, errors) = evaluate(&ctx, changed, all_files);
            eval.errors.extend(errors);
            if sessions.is_empty() {
                continue;
            }
            let _lease = crate::lease::acquire_blocking(
                &crate::source_controls::harness_data_lock_path(data_home, harness)?,
                "findings-eval",
                600_000,
                10_000,
            )
            .map_err(|error| format!("findings {harness} lease: {error}"))?;
            if crate::source_controls::excluded_harnesses(data_home)
                .map_err(|error| format!("source controls failed: {error}"))?
                .contains(harness)
            {
                continue;
            }
            // r2a 每轮都先修旧行的秒/毫秒单位（幂等），评估器沿用。
            if let Err(error) = agent_vitals_data::issues::repair_issue_timestamp_units(authority.conn()) {
                eval.errors.push(format!("issue timestamp migration: {error}"));
            }
            let now = crate::clock::now_ms();
            for session in &sessions {
                // 计数先记在局部，事务成功才并入——回滚的会话不能被报成已写。
                let mut local = findings_eval::EvalReport::default();
                let result = authority.with_immediate_txn(|conn| {
                    findings_eval::persist(conn, &ns, session, now, &mut local)
                        .map_err(agent_vitals_data::authority::AuthorityError::Sqlite)
                });
                match result {
                    Ok(()) => {
                        eval.sessions_evaluated += local.sessions_evaluated;
                        eval.findings_upserted += local.findings_upserted;
                        eval.reopened += local.reopened;
                        eval.closed += local.closed;
                    }
                    Err(error) => {
                        all_persisted = false;
                        eval.errors.push(format!(
                            "findings persist {harness}/{}: {error}",
                            session.native_id
                        ));
                    }
                }
            }
        }
        // 回填标记只在全执行环境路径、且没有写库失败时落：定向同步只评估了部分执行环境，
        // 写失败的会话下轮还得重评。单文件读失败不阻塞——那个文件变了自然重评。
        if findings_backfill && only.is_none() && all_persisted {
            authority
                .conn()
                .execute(
                    "INSERT OR REPLACE INTO schema_meta(key, value) VALUES(?1, '1')",
                    [findings_eval::BACKFILL_META_KEY],
                )
                .map_err(|e| format!("write findings backfill marker: {e}"))?;
        }
        if !eval.errors.is_empty() {
            crate::core::logging::log_warn(
                "sync_service",
                &format!("behavior findings: {} error(s), first: {}", eval.errors.len(), eval.errors[0]),
            );
        }
        report.behavior_findings = Some(eval);
    }

    // 插件执行环境周期再摄取（zcode 接入收尾，2026-09-23）：只在全量路径跑
    // （定向过滤只针对内置执行环境批）；exactly-once 由 fact_id 幂等兜底，
    // 单 manifest 失败隔离进 errors 不拖垮整轮。首装 format guard 挡
    // 「include/recipe 与数据不匹配」的 manifest（零 emit 拒写）。
    if only.is_none() {
        let user_home_for_plugins = user_home.clone();
        let active_dynamic_slugs = active_harness_manifest_slugs(data_home);
        for (slug, result) in crate::plugin_ingest::ingest_installed(&ns, data_home, &user_home_for_plugins) {
            if !active_dynamic_slugs.as_ref().is_ok_and(|active| active.contains(&slug)) {
                // Candidate manifests and registry-level diagnostics are not active
                // data sources and must not appear as source-health failures.
                continue;
            }
            match result {
                Ok(payload) => {
                    // 验收修正：appended 在 ingest.harnesses[0]（IngestReport 嵌套层），
                    // 顶层无此键——此前恒读 0，成功再摄取完全不可见。
                    let appended = payload["ingest"]["harnesses"]
                        .as_array()
                        .and_then(|harnesses| harnesses.first())
                        .and_then(|h| h.get("appended"))
                        .and_then(Value::as_i64)
                        .unwrap_or(0);
                    let duplicate = payload["ingest"]["harnesses"]
                        .as_array()
                        .and_then(|harnesses| harnesses.first())
                        .and_then(|h| h.get("duplicate"))
                        .and_then(Value::as_i64)
                        .unwrap_or(0);
                    report.harnesses.push(HarnessSyncReport {
                        harness: format!("harness:{slug}"),
                        appended: appended.max(0) as usize,
                        duplicate: duplicate.max(0) as usize,
                        ..Default::default()
                    });
                    if appended > 0 {
                        crate::core::logging::log_info(
                            "sync",
                            &format!("harness:{slug} 再摄取 +{appended} 条"),
                        );
                        report.total_appended += appended as usize;
                    }
                }
                Err(error) => {
                    report.harnesses.push(HarnessSyncReport {
                        harness: format!("harness:{slug}"),
                        errors: vec![error],
                        ..Default::default()
                    });
                }
            }
        }
    }
    // v1.0 升级闭环：旧个人订阅若存在于历史价卡快照，先落为本地 harness_bills。
    // 正常桌面同步也会经过这里，用户无需手动执行 CLI 迁移；失败只警告，不能
    // 阻断三执行环境事实导入。
    // R5-F7c（REFRESH_STORM）：迁移与价格快照都是幂等重活（遍历全部快照
    // JSON / 事务写），此前每 tick 无条件跑——改为按日节流（retention 的
    // `.authority-retention.json` 同款范式：state 文件记日戳，失败不盖戳、
    // 静默顺延到下一 tick 重跑）。候选/声明一致性自愈仍每 tick（计费正确性
    // 链路，spec §4.7 裁决）。
    let daily_bookkeeping_due = {
        let bj_day = crate::clock::today_beijing();
        let stamp_path = data_home.join("facts").join(".daily-bookkeeping.json");
        let last: Option<String> = crate::state::read_json(&stamp_path)
            .and_then(|v| v.get("last_run_date").and_then(Value::as_str).map(String::from));
        !matches!(&last, Some(d) if d == &bj_day)
    };
    if daily_bookkeeping_due {
        let mut bookkeeping_ok = true;
        if let Err(e) = crate::sql_sync::migrate_legacy_subscription_snapshots(
            &authority,
            crate::clock::now_ms(),
        ) {
            bookkeeping_ok = false;
            crate::core::logging::log_warn("sync_service", &format!("legacy subscriptions: {e}"));
        }
        // Phase 2.8：落当前价格快照（§5.3）。幂等——价卡不变则无新版本。
        if let Err(e) = crate::sql_sync::snapshot_current_pricing(&authority) {
            bookkeeping_ok = false;
            crate::core::logging::log_warn("sync_service", &format!("pricing snapshot: {e}"));
        }
        if bookkeeping_ok {
            crate::state::atomic_write_json(
                &data_home.join("facts").join(".daily-bookkeeping.json"),
                &serde_json::json!({ "last_run_date": crate::clock::today_beijing() }),
            );
        }
    }
    // 候选状态与声明占用的一致性自愈（候选被有效声明占着 = accepted）；旧版本的
    // 「重新打开」留下的分裂态在这里收口，否则待确认面板反复问、新声明反复撞
    // 「already used by another live declaration」。
    match authority.reconcile_candidate_claims(crate::clock::now_ms()) {
        Ok(n) if n > 0 => crate::core::logging::log_info(
            "sync_service",
            &format!("billing candidates: re-marked {n} record(s) accepted (held by live declarations)"),
        ),
        Ok(_) => {}
        Err(e) => crate::core::logging::log_warn("sync_service", &format!("candidate claims: {e}")),
    }
    // 本地价格发现（零网络）改为事件驱动（EVENT_BUS spec §9 P0 验收 #4）：
    // FactsIngested 已在各执行环境写入事务内落 outbox；价卡快照仍显式先行（消费
    // 者依赖最新价卡做判定），随后一次性 drain——本轮新事件与上次崩溃残留
    // （deliveries 缺行）同轮补投，顺序与原内联调用等价。
    {
        let authority_path = agent_vitals_data::authority::default_authority_path(data_home);
        let dispatcher = crate::events::Dispatcher::new(vec![
            crate::events::EventConsumer::new(
                "price-reconcile",
                crate::events::ConsumerInterest::domain(&["FactsIngested", "PriceCardSaved"]),
                move |_event| {
                // 消费者自持连接（drain 不持事务，spec §6）。打开失败按处理
                // 失败记账——**不重投本事件**（deliveries 反连接永久排除）；
                // price-reconcile 忽略事件载荷做全量 reconcile，下一轮
                // FactsIngested 自然自愈，所以这个语义是安全的。
                let db = agent_vitals_data::authority::AuthorityDb::open(
                    &authority_path,
                    crate::clock::now_ms(),
                )
                .map_err(|e| e.to_string())?;
                crate::price_discovery::reconcile_unpriced_models(
                    &db,
                    &crate::clock::current_month_beijing(),
                    crate::clock::now_ms(),
                )
                .map(|_| ())
            }),
        ])
        .expect("price-reconcile interest is a static Domain-class subset");
        match dispatcher.drain(authority.conn()) {
            Ok(report) if report.failed > 0 || report.skipped > 0 => crate::core::logging::log_warn(
                "sync_service",
                &format!("event dispatch: {} failed, {} skipped", report.failed, report.skipped),
            ),
            Ok(_) => {}
            Err(e) => crate::core::logging::log_warn("sync_service", &format!("event dispatch: {e}")),
        }
    }
    // 计费声明是持续生效的规则：用户在归因表单里填的「结束时间为空 = 持续有效」
    // 意味着之后同特征的新事实必须自动沿用，而不是每个新会话都回到待确认面板
    // 再问一遍（2026-09-16 真机：anthropic 订阅 / shengsuanyun 中转都声明过，
    // 当晚新会话照样弹出，用户把同一条中转声明重复保存了 7 次）。重算 job 只
    // 物化保存前的历史，这里补上「保存之后」那一半。失败只警告：归因是事实之上
    // 的解释层，不能反过来让事实同步失败。
    {
        let _lease = crate::lease::acquire_blocking(
            &data_home.join("facts").join(".ingest.lock"),
            "facts-apply-declarations",
            60_000,
            5_000,
        );
        match authority.billing_apply_active_declarations(crate::clock::now_ms()) {
            Ok(applied) => {
                report.declarations_applied = applied.attributed;
                if applied.attributed > 0 {
                    crate::core::logging::log_info(
                        "sync_service",
                        &format!(
                            "billing declarations: attributed {} new facts under {} active rule(s)",
                            applied.attributed, applied.revisions
                        ),
                    );
                }
            }
            Err(e) => crate::core::logging::log_warn("sync_service", &format!("billing declarations: {e}")),
        }
    }
    Ok(report)
}

fn active_harness_manifest_slugs(data_home: &Path) -> Result<std::collections::BTreeSet<String>, String> {
    let path = agent_vitals_data::authority::default_authority_path(data_home);
    if !path.exists() { return Ok(std::collections::BTreeSet::new()); }
    let db = agent_vitals_data::authority::AuthorityDb::open_readonly(&path)
        .map_err(|error| format!("extension authority: {error}"))?;
    let mut statement = db.conn().prepare(
        "SELECT s.slot_id FROM extension_active a JOIN extension_activation_slots s
         ON s.generation=a.generation WHERE s.slot_type='harness_manifest' ORDER BY s.slot_id"
    ).map_err(|error| error.to_string())?;
    let slugs = statement.query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<std::collections::BTreeSet<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(slugs)
}

/// Force a Codex source replay for attribution migrations. This deliberately
/// invalidates only the Codex parser checkpoints; the normal sync path then
/// re-reads unchanged rollout files and preserves idempotent fact identities.
pub fn force_codex_provider_replay(data_home: &Path) -> Result<SyncReport, String> {
    let path = agent_vitals_data::authority::default_authority_path(data_home);
    let db = agent_vitals_data::authority::AuthorityDb::open(&path, crate::clock::now_ms())
        .map_err(|e| format!("open authority for replay: {e}"))?;
    db.with_immediate_txn(|conn| {
        conn.execute(
            "UPDATE source_files SET parser_version = parser_version - 1 WHERE harness = 'codex'",
            [],
        ).map(|_| ()).map_err(agent_vitals_data::authority::AuthorityError::Sqlite)
    }).map_err(|e| format!("invalidate Codex checkpoints: {e}"))?;
    drop(db);
    sync_facts(data_home)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_home(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "avd-sync-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    /// R5-F7a 对拍（spec §4.7 测试要求）：缓存路径与全量扫在任何状态变迁下
    /// 逐字段一致——冷缓存（全解析）、暖缓存（全命中）、内容变更（部分失效）、
    /// 以及 recent-floor 随时间滑动（旧命中滑出 7 天窗后不计入，不因缓存冻结）。
    #[test]
    fn quota_scan_cached_matches_full_scan_across_state_changes() {
        let home = tmp_home("f7a");
        std::fs::create_dir_all(home.join("facts")).unwrap();
        let line = |ts: &str, resets: i64, window: &str| {
            format!(
                r#"{{"type":"assistant","uuid":"u1","timestamp":"{ts}","quotaLimits":{{"status":"rejected","resetsAt":{resets},"unifiedRateLimitFallbackAvailable":false,"rateLimitType":"{window}","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false}}}}"#
            )
        };
        let write_file = |name: &str, lines: &[String]| {
            let path = home.join(format!("{name}.jsonl"));
            std::fs::write(&path, lines.join("\n")).unwrap();
            path
        };
        // 时间戳相对「现在」生成：此前写死 2026-09-20/21，而 windows_recent 的窗口是
        // now 往前 7 天——到 2026-09-27 fixture 自己滑出窗，本测试在无任何代码改动时
        // 开始失败（时间炸弹）。
        let now = std::time::SystemTime::now();
        let ago = |hours: i64| -> (String, i64) {
            let ts = jiff::Timestamp::try_from(now).unwrap() - jiff::SignedDuration::from_hours(hours);
            (ts.strftime("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(), ts.as_second() + 5 * 3600)
        };
        let (ts_a, resets_a) = ago(48);
        let (ts_b, resets_b) = ago(24);
        let (ts_plain, _) = ago(36);
        let mut files = vec![
            write_file("a", &[line(&ts_a, resets_a, "five_hour")]),
            write_file("b", &[line(&ts_b, resets_b, "seven_day")]),
            write_file("plain", &[format!(r#"{{"type":"assistant","timestamp":"{ts_plain}"}}"#)]),
        ];

        // 冷缓存：缓存路径 == 全量基准。
        let full = agent_vitals_harnesses::claude_quota::scan_claude_quota(&files, now);
        let cached = scan_claude_quota_cached(&home, &files, now);
        assert_eq!(cached, full, "冷缓存必须与全量扫一致");
        assert!(cached.latest.is_some(), "fixture 必须产出快照，防止空对空");
        assert!(cached.windows_recent >= 2, "两个窗口命中都应计入");

        // 暖缓存（全部命中缓存，零解析）：结果不变，且缓存文件已落盘。
        let cached_again = scan_claude_quota_cached(&home, &files, now);
        assert_eq!(cached_again, full, "暖缓存必须与全量扫一致");
        assert!(home.join("facts").join(".claude-quota-cache.json").exists());

        // 内容变更：a 换成更新的快照 → 缓存失效重解析，仍与全量一致。
        let (ts_a2, resets_a2) = ago(12);
        files[0] = write_file("a", &[line(&ts_a2, resets_a2, "five_hour")]);
        let full2 = agent_vitals_harnesses::claude_quota::scan_claude_quota(&files, now);
        let cached2 = scan_claude_quota_cached(&home, &files, now);
        assert_eq!(cached2, full2, "部分失效后必须与全量扫一致");
        assert_ne!(cached2.latest, full.latest, "fixture 前后必须有差异，防止假对拍");

        // recent-floor 滑动：把 now 推到 8 天后，同时把文件 mtime 也拨到
        // 「future - 1 天」——保持 mtime 窗内（否则两路都被 mtime 窗筛掉、
        // 空转对拍，评审 P2-1），贡献非空而 observed_at 已滑出 recent floor。
        // windows_recent 必须归零（缓存不冻结 floor）；latest 保持（不过滤）。
        let future = now + std::time::Duration::from_secs(8 * 24 * 3600);
        let future_mtime = std::time::SystemTime::now() + std::time::Duration::from_secs(7 * 24 * 3600);
        for path in &files {
            let file = std::fs::File::options().append(true).open(path).unwrap();
            file.set_modified(future_mtime).unwrap();
        }
        let full_future = agent_vitals_harnesses::claude_quota::scan_claude_quota(&files, future);
        assert!(full_future.latest.is_some(), "mtime 仍在窗内，贡献必须非空（防空转腿）");
        let cached_future = scan_claude_quota_cached(&home, &files, future);
        assert_eq!(cached_future, full_future, "floor 滑动后必须与全量扫一致");
        assert_eq!(cached_future.windows_recent, 0, "滑出窗的命中不得因缓存冻结而计入");
        assert!(cached_future.latest.is_some(), "latest 不过滤，滑窗后仍保持");

        let _ = std::fs::remove_dir_all(&home);
    }

    /// 一份最小 claude 会话（两条 usage 行）。
    fn claude_session(home: &Path) -> PathBuf {
        let dir = home.join(".claude").join("projects").join("p-x");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("sess-a.jsonl");
        std::fs::write(
            &p,
            concat!(
                r#"{"type":"assistant","uuid":"u1","timestamp":"2026-09-05T10:00:00.000Z","message":{"id":"msg_1","model":"claude-sonnet-5","usage":{"input_tokens":10,"cache_read_input_tokens":20,"cache_creation_input_tokens":5,"output_tokens":3}}}"#,
                "\n",
                r#"{"type":"assistant","uuid":"u2","timestamp":"2026-09-05T10:01:00.000Z","message":{"id":"msg_2","model":"claude-sonnet-5","usage":{"input_tokens":11,"cache_read_input_tokens":21,"cache_creation_input_tokens":6,"output_tokens":4}}}"#,
                "\n",
                r#"{"type":"user","uuid":"u3","timestamp":"2026-09-05T10:01:10.000Z","message":{"content":[{"type":"text","text":"run the check"}]}}"#,
                "\n",
                r#"{"type":"assistant","uuid":"u4","timestamp":"2026-09-05T10:01:11.000Z","message":{"content":[{"type":"tool_use","id":"call-1","name":"Bash","input":{"command":"cat /private/secret"}}]}}"#,
                "\n",
                r#"{"type":"user","uuid":"u5","timestamp":"2026-09-05T10:01:12.000Z","message":{"content":[{"type":"tool_result","tool_use_id":"call-1","is_error":true,"content":"secret output"}]}}"#,
                "\n",
            ),
        )
        .unwrap();
        p
    }

    /// 一份最小 codex rollout（一条 token_count）。
    fn codex_rollout(home: &Path) -> PathBuf {
        let dir = home
            .join(".codex")
            .join("sessions")
            .join("2026")
            .join("09")
            .join("05");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("rollout-2026-09-05T17-00-00-abc.jsonl");
        std::fs::write(
            &p,
            concat!(
                r#"{"timestamp":"2026-09-05T17:00:00.000Z","type":"session_meta","payload":{"id":"cx-1","cwd":"/tmp/w"}}"#,
                "\n",
                r#"{"timestamp":"2026-09-05T17:01:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":10,"output_tokens":20,"reasoning_output_tokens":0},"last_token_usage":{"input_tokens":100,"cached_input_tokens":10,"output_tokens":20,"reasoning_output_tokens":0},"model_context_window":272000},"rate_limits":{"plan_type":"plus","credits":{"has_credits":false},"primary":{"used_percent":67,"window_minutes":300,"resets_at":1788602460}}}}"#,
                "\n",
            ),
        )
        .unwrap();
        p
    }

    fn with_isolated_home<F: FnOnce(&Path)>(f: F) {
        // **必须用 crate::ENV_LOCK**（state/budget/r2a/summary 的测试全在用
        // 同一把）：任何会改 HOME/AGENT_VITALS_HOME 的测试持别的锁 = 两组
        // 并发互相把 atomic_write 写到对方家目录——2026-09-06 实际撞过。
        let _g = crate::ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = tmp_home("iso");
        std::fs::create_dir_all(&home).unwrap();
        let data_home = home.join("data");
        std::env::set_var("AGENT_VITALS_HOME", &data_home);
        let prev_home = std::env::var("HOME").ok();
        std::env::set_var("HOME", &home);
        let prev_profile = std::env::var("USERPROFILE").ok();
        std::env::remove_var("USERPROFILE");
        f(&home);
        match prev_home {
            Some(h) => std::env::set_var("HOME", h),
            None => std::env::remove_var("HOME"),
        }
        if let Some(h) = prev_profile {
            std::env::set_var("USERPROFILE", h);
        }
        std::env::remove_var("AGENT_VITALS_HOME");
        let _ = std::fs::remove_dir_all(&home);
    }

    /// W8：行为 findings 由同步产出（取代 r2a `sessions findings`）。钉三件事：
    /// 1) 首轮（回填标记缺失）评估全部 DSH 会话、落 issue、写标记；
    /// 2) 源未变的下一轮不再评估（增量，不是每 tick 全量）；
    /// 3) 删标记重跑 = 再回填一次，issue 原地命中不新增（幂等身份）。
    #[test]
    fn sync_evaluates_behavior_findings_incrementally_with_one_time_backfill() {
        with_isolated_home(|home| {
            let dir = home.join(".dsh/sessions/--Users-alice-projects-demo--/agent-1");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::copy(
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/dsh/behavior.jsonl"),
                dir.join("session.jsonl"),
            )
            .unwrap();
            let data = PathBuf::from(std::env::var("AGENT_VITALS_HOME").unwrap());
            let issues = |data: &Path| -> (i64, i64) {
                let db = agent_vitals_data::authority::AuthorityDb::open(
                    &agent_vitals_data::authority::default_authority_path(data),
                    crate::clock::now_ms(),
                )
                .unwrap();
                let n: i64 = db.conn().query_row(
                    "SELECT COUNT(*) FROM issue_instances
                     WHERE harness='dsh' AND session_key='sess-behavior-0001' AND evaluator_id='legacy-finding'",
                    [], |r| r.get(0)).unwrap();
                let marker: i64 = db.conn().query_row(
                    "SELECT COUNT(*) FROM schema_meta WHERE key=?1",
                    [crate::ingest::findings_eval::BACKFILL_META_KEY], |r| r.get(0)).unwrap();
                (n, marker)
            };

            let r1 = sync_facts(&data).unwrap();
            let eval = r1.behavior_findings.as_ref().expect("首轮必须评估");
            assert!(eval.errors.is_empty(), "{:?}", eval.errors);
            assert_eq!(eval.sessions_evaluated, 1);
            let (n1, marker) = issues(&data);
            assert!(n1 > 0, "behavior.jsonl 必须产出行为 issue");
            assert_eq!(marker, 1, "回填标记落库");
            assert_eq!(eval.findings_upserted as i64, n1);

            let r2 = sync_facts(&data).unwrap();
            assert!(r2.behavior_findings.is_none(), "源未变 → 不评估");

            let db = agent_vitals_data::authority::AuthorityDb::open(
                &agent_vitals_data::authority::default_authority_path(&data),
                crate::clock::now_ms(),
            )
            .unwrap();
            db.conn()
                .execute("DELETE FROM schema_meta WHERE key=?1", [crate::ingest::findings_eval::BACKFILL_META_KEY])
                .unwrap();
            drop(db);
            let r3 = sync_facts(&data).unwrap();
            assert_eq!(r3.behavior_findings.as_ref().unwrap().sessions_evaluated, 1, "删标记 → 再回填");
            assert_eq!(issues(&data), (n1, 1), "同一身份原地命中，不新增");
        });
    }

    #[test]
    fn sync_is_incremental_across_runs() {
        with_isolated_home(|home| {
            claude_session(home);
            codex_rollout(home);
            let data = std::env::var("AGENT_VITALS_HOME").unwrap();
            let data = PathBuf::from(data);

            let r1 = sync_facts(&data).unwrap();
            let cl = r1.harnesses.iter().find(|h| h.harness == "claude-code").unwrap();
            let cx = r1.harnesses.iter().find(|h| h.harness == "codex").unwrap();
            assert_eq!(cl.files_synced, 1, "首次全量：claude 1 文件");
            assert_eq!(cl.appended, 2, "两条 usage 事实");
            assert_eq!(cx.files_synced, 1, "首次全量：codex 1 文件");
            assert!(r1.total_appended > 0);
            let db = agent_vitals_data::authority::AuthorityDb::open(
                &agent_vitals_data::authority::default_authority_path(&data),
                crate::clock::now_ms(),
            )
            .unwrap();
            let (quota, _) = db
                .runtime_snapshot_get("codex", "codex_quota")
                .unwrap()
                .expect("codex rate_limits 必须与同步事实同批落 SQL");
            assert_eq!(
                serde_json::from_str::<Value>(&quota).unwrap()["plan_type"],
                "plus"
            );
            let workflow_count: i64 = db
                .conn()
                .query_row(
                    "SELECT COUNT(*) FROM workflow_events WHERE session_key LIKE '11:claude-code|%'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(workflow_count >= 3, "Claude workflow 事件必须随 facts 一起落 authority");

            // 第二次：全部 skipped（SQL source_files 指纹命中），零新增。
            let r2 = sync_facts(&data).unwrap();
            for h in &r2.harnesses {
                assert_eq!(h.files_synced, 0, "{harness} 二次不应有处理", harness = h.harness);
                assert_eq!(h.files_skipped, h.files_seen);
            }
            assert_eq!(r2.total_appended, 0);

            // 内容变化（追加一行）→ 该文件重新处理，但事实 exactly-once
            // → duplicate 而非双计。
            let sess = home.join(".claude/projects/p-x/sess-a.jsonl");
            let mut text = std::fs::read_to_string(&sess).unwrap();
            text.push_str(
                r#"{"type":"assistant","uuid":"u3","timestamp":"2026-09-05T10:02:00.000Z","message":{"id":"msg_3","model":"claude-sonnet-5","usage":{"input_tokens":1,"cache_read_input_tokens":1,"cache_creation_input_tokens":1,"output_tokens":1}}}"#,
            );
            text.push('\n');
            std::fs::write(&sess, text).unwrap();
            let r3 = sync_facts(&data).unwrap();
            let cl3 = r3.harnesses.iter().find(|h| h.harness == "claude-code").unwrap();
            assert_eq!(cl3.files_synced, 1, "变化文件重新处理");
            assert_eq!(cl3.appended, 1, "只有新行是新事实");
            // P1b 增量语义：只读新行，旧行不重发 → duplicate=0（此前全量重解析
            // 会 re-emit 旧行为 duplicate=2；增量是行为改进——更少 I/O 同终态）。
            assert_eq!(cl3.duplicate, 0, "增量路径不重读旧行，无 duplicate");
        });
    }

    #[test]
    fn normal_sync_surfaces_legacy_subscription_as_pending_candidate() {
        with_isolated_home(|_home| {
            let data = PathBuf::from(std::env::var("AGENT_VITALS_HOME").unwrap());
            let db = agent_vitals_data::authority::AuthorityDb::open(
                &agent_vitals_data::authority::default_authority_path(&data),
                crate::clock::now_ms(),
            ).unwrap();
            let month = crate::clock::current_month_beijing();
            let payload = serde_json::json!({"pricing": {"catalog_2026_09": {
                "subscriptions": {"legacy": {
                    "provider": "minimax", "currency": "CNY", "amount_per_month": 114.0,
                    "reported_at": format!("{month}-01")
                }}
            }}}).to_string();
            db.pricing_snapshot_put("legacy-subscription-for-sync", "legacy", &payload, 1).unwrap();
            drop(db);

            sync_facts(&data).unwrap();
            let candidates = agent_vitals_data::authority::AuthorityDb::open(
                &agent_vitals_data::authority::default_authority_path(&data),
                crate::clock::now_ms(),
            ).unwrap().pending_billing_import_candidates().unwrap();
            assert!(candidates.iter().any(|(_id, harness, provider, currency, amount, start, status)| {
                harness == "claude-code" && provider == "minimax"
                    && *amount == 11_400 && currency == "CNY" && start == &month && status == "pending"
            }), "normal sync must surface an unconfirmed legacy declaration: {candidates:?}");
        });
    }

    #[test]
    fn codex_quota_schema_backfill_replays_unchanged_rollout_once() {
        with_isolated_home(|home| {
            let rollout = codex_rollout(home);
            let data = PathBuf::from(std::env::var("AGENT_VITALS_HOME").unwrap());
            sync_facts(&data).unwrap();
            let db = agent_vitals_data::authority::AuthorityDb::open(
                &agent_vitals_data::authority::default_authority_path(&data),
                crate::clock::now_ms(),
            )
            .unwrap();

            // 模拟由 schema v1 升级而来：原 rollout 指纹已经存在，但 v2 的
            // 派生快照及其 backfill 标记都尚未写入。
            db.conn()
                .execute(
                    "DELETE FROM harness_runtime_snapshots
                     WHERE harness = 'codex' AND snapshot_kind = 'codex_quota'",
                    [],
                )
                .unwrap();
            db.conn()
                .execute(
                    "DELETE FROM schema_meta
                     WHERE key = 'codex_quota_snapshot_backfilled_v2'",
                    [],
                )
                .unwrap();

            let replay = sync_facts(&data).unwrap();
            let codex = replay.harnesses.iter().find(|h| h.harness == "codex").unwrap();
            assert_eq!(codex.files_seen, 1);
            assert_eq!(codex.files_synced, 1, "unchanged rollout 必须为 v2 补快照");
            assert!(db
                .runtime_snapshot_get("codex", "codex_quota")
                .unwrap()
                .is_some());
            assert!(db
                .conn()
                .query_row(
                    "SELECT 1 FROM schema_meta
                     WHERE key = 'codex_quota_snapshot_backfilled_v2'",
                    [],
                    |_| Ok(true),
                )
                .unwrap());

            let stable = sync_facts(&data).unwrap();
            let codex = stable.harnesses.iter().find(|h| h.harness == "codex").unwrap();
            assert_eq!(codex.files_synced, 0, "backfill 后恢复普通 SQL 差量同步");
            assert!(rollout.exists());
        });
    }

    #[test]
    fn parser_version_change_replays_an_unchanged_source() {
        with_isolated_home(|home| {
            let source = claude_session(home);
            let data = PathBuf::from(std::env::var("AGENT_VITALS_HOME").unwrap());
            let first = sync_facts(&data).unwrap();
            assert_eq!(first.harnesses[0].files_synced, 1);

            let db = agent_vitals_data::authority::AuthorityDb::open(
                &agent_vitals_data::authority::default_authority_path(&data),
                crate::clock::now_ms(),
            )
            .unwrap();
            let path_hash = agent_vitals_domain::source_identity::fnv1a64_hex(
                source.to_string_lossy().as_bytes(),
            );
            db.conn()
                .execute(
                    "UPDATE source_files SET parser_version = parser_version - 1
                     WHERE harness = 'claude-code' AND path_hash = ?1",
                    rusqlite::params![path_hash],
                )
                .unwrap();

            let second = sync_facts(&data).unwrap();
            let claude = second
                .harnesses
                .iter()
                .find(|harness| harness.harness == "claude-code")
                .unwrap();
            assert_eq!(claude.files_synced, 1, "解析器升级必须重放原文件");
            assert_eq!(claude.appended, 0, "原事实仍由 fact_id 幂等吸收");
            assert_eq!(claude.duplicate, 2);
        });
    }

    #[test]
    fn failing_files_are_reported_and_not_recorded_in_sql() {
        with_isolated_home(|home| {
            let dir = home.join(".claude/projects/p-bad");
            std::fs::create_dir_all(&dir).unwrap();
            // 不可读会导致 Err（read 失败走 Err 串）；用一个坏 JSON 行文件
            // ——emitter 对坏行抛错 → 该文件不能写入 source_files。
            let p = dir.join("bad.jsonl");
            std::fs::write(&p, "{not json\n").unwrap();
            let data = PathBuf::from(std::env::var("AGENT_VITALS_HOME").unwrap());
            let r = sync_facts(&data).unwrap();
            let cl = r.harnesses.iter().find(|h| h.harness == "claude-code").unwrap();
            assert!(!cl.errors.is_empty(), "坏文件必须出现在 errors 里");
            let db = agent_vitals_data::authority::AuthorityDb::open(
                &agent_vitals_data::authority::default_authority_path(&data),
                crate::clock::now_ms(),
            )
            .unwrap();
            let n: i64 = db
                .conn()
                .query_row(
                    "SELECT COUNT(*) FROM source_files WHERE harness = 'claude-code'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(n, 0, "失败文件不得留下 SQL 指纹，才能被下轮重试");
            let r2 = sync_facts(&data).unwrap();
            let cl2 = r2.harnesses.iter().find(|h| h.harness == "claude-code").unwrap();
            assert!(!cl2.errors.is_empty(), "下次 sync 重试坏文件（诚实噪声）");
        });
    }

    #[test]
    fn one_harness_read_failure_does_not_block_another_harness() {
        with_isolated_home(|home| {
            let bad_dir = home.join(".claude/projects/p-bad");
            std::fs::create_dir_all(&bad_dir).unwrap();
            std::fs::write(bad_dir.join("bad.jsonl"), "{not json\n").unwrap();
            codex_rollout(home);
            let data = PathBuf::from(std::env::var("AGENT_VITALS_HOME").unwrap());

            let report = sync_facts(&data).unwrap();
            let claude = report.harnesses.iter().find(|harness| harness.harness == "claude-code").unwrap();
            let codex = report.harnesses.iter().find(|harness| harness.harness == "codex").unwrap();
            assert!(!claude.errors.is_empty(), "坏的 Claude 文件必须保留失败证据");
            assert_eq!(codex.files_synced, 1, "Codex 仍必须完成本轮导入");
        });
    }

    #[test]
    fn configured_retention_window_is_applied_by_sync_maintenance() {
        with_isolated_home(|_home| {
            let data = PathBuf::from(std::env::var("AGENT_VITALS_HOME").unwrap());
            crate::retention::save_retention_months(&data, 1).unwrap();
            let db = agent_vitals_data::authority::AuthorityDb::open(
                &agent_vitals_data::authority::default_authority_path(&data),
                crate::clock::now_ms(),
            ).unwrap();
            db.begin_run("retention-test", "test", 1).unwrap();
            let cutoff = crate::sql_sync::retention_cutoff_ms(
                &crate::clock::current_month_beijing(), 0,
            ).unwrap();
            db.conn().execute(
                "INSERT INTO usage_facts(fact_id, harness, machine_namespace, native_session_id,
                     source_event_id, observation_kind, event_ts_ms, event_peak,
                     uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens,
                     ingested_run_id, created_at_ms, updated_at_ms)
                 VALUES ('expired-by-config', 'codex', 'm', 's', 'event', 'token_count',
                         ?1, 0, 1, 0, 0, 0, 'retention-test', 1, 1)",
                rusqlite::params![cutoff - 1],
            ).unwrap();
            drop(db);

            sync_facts(&data).unwrap();

            let db = agent_vitals_data::authority::AuthorityDb::open_readonly(
                &agent_vitals_data::authority::default_authority_path(&data),
            ).unwrap();
            let remaining: i64 = db.conn().query_row(
                "SELECT COUNT(*) FROM usage_facts WHERE fact_id = 'expired-by-config'",
                [], |row| row.get(0),
            ).unwrap();
            assert_eq!(remaining, 0, "maintenance must use the saved one-month window");
        });
    }

    #[test]
    fn malformed_retention_configuration_stops_sync_before_maintenance() {
        with_isolated_home(|_home| {
            let data = PathBuf::from(std::env::var("AGENT_VITALS_HOME").unwrap());
            std::fs::create_dir_all(data.join("state")).unwrap();
            std::fs::write(data.join("state").join("retention-config.json"), b"invalid").unwrap();
            let error = sync_facts(&data).unwrap_err();
            assert!(error.contains("retention configuration failed"), "{error}");
        });
    }

    #[test]
    fn malformed_custom_source_configuration_stops_sync() {
        with_isolated_home(|_home| {
            let data = PathBuf::from(std::env::var("AGENT_VITALS_HOME").unwrap());
            std::fs::create_dir_all(data.join("state")).unwrap();
            std::fs::write(data.join("state").join("custom-sources.json"), b"invalid").unwrap();
            let error = sync_facts(&data).unwrap_err();
            assert!(error.contains("custom source configuration failed"), "{error}");
            assert!(!data.join("facts").join(".authority-retention.json").exists());
        });
    }

    #[test]
    fn malformed_source_controls_stop_sync_before_maintenance() {
        with_isolated_home(|_home| {
            let data = PathBuf::from(std::env::var("AGENT_VITALS_HOME").unwrap());
            std::fs::create_dir_all(data.join("state")).unwrap();
            std::fs::write(data.join("state").join("source-controls.json"), b"invalid").unwrap();
            let error = sync_facts(&data).unwrap_err();
            assert!(error.contains("source controls failed"), "{error}");
            assert!(!data.join("facts").join(".authority-retention.json").exists());
        });
    }

    #[test]
    fn excluded_harness_is_not_read_by_sync() {
        with_isolated_home(|home| {
            claude_session(home);
            let data = PathBuf::from(std::env::var("AGENT_VITALS_HOME").unwrap());
            crate::source_controls::set_harness_excluded(&data, "claude-code", true).unwrap();
            let report = sync_facts(&data).unwrap();
            assert!(!report.harnesses.iter().any(|harness| harness.harness == "claude-code"));
        });
    }

    #[test]
    fn custom_claude_root_is_ingested_by_normal_sync() {
        with_isolated_home(|home| {
            let custom_home = home.join("custom-claude");
            claude_session(&custom_home);
            let data = PathBuf::from(std::env::var("AGENT_VITALS_HOME").unwrap());
            assert!(crate::custom_sources::add_custom_source_root(
                &data, "claude-code", &custom_home,
            ).unwrap());
            let report = sync_facts(&data).unwrap();
            let claude = report.harnesses.iter().find(|harness| harness.harness == "claude-code").unwrap();
            assert_eq!(claude.files_synced, 1);
            assert_eq!(claude.appended, 2);
        });
    }
}
