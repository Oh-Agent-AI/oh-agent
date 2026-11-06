//! Claude Code 会话账 fold —— 独立第三数据面（DSH month.json 之外的 Claude Code 成本）。
//!
//! 2026-09-02 用户决策 D1-D4 的落地：托盘的 Claude Code 分量 = **按模型族官方卡
//! 折算**（catalog 计价面在 core `cost.rs`，钱在读取时算——本模块只折 token 桶）。
//! 为什么独立数据面：DSH 的 month.json/today.json/alert.json/manifest 是 DSH 执行环境
//! 语义（`tokenUsage` 4 桶、peak/off-peak、预算告警），Claude Code 的账单形状
//! 完全不同（cost-state camelCase modelUsage、行级 snake usage、模型名带 gateway
//! 前缀）——混进既有状态链会破坏它的不变量（month.json 只存当前月、merge_month
//! single write、alert 是 DSH 预算）。所以新面独立成 `claude-fold.json`（每会话
//! checkpoint）+ `claude-ledger.json`（逐日 by_model）+ `claude-ledger-archive.json`
//! （跨月滚动），全部由 `claude-sync` 一个写入者维护（镜像 oneline 的 owner
//! fencing：owner 不是 rust 就快速失败，--shadow 演练跳过）。
//!
//! ## 真值分层（2026-09-02 审阅裁决后的事实底座）
//!
//! **cost-state 是账单真值、行只给按天归属**，不是反过来：
//!
//! - `cost-state` 记录 = Claude Code 自报的**整段会话累计**账单（随压缩点/会话
//!   结束写入）。真机证据：ee969d0c 文件尾部两条 cost-state 的 modelUsage 逐
//!   字段相同（只有 totalDuration 变）——证明它是**累计快照**不是增量；同一文
//!   件里 claude-sonnet-5 的 625M cache read 在行里零可见（被压缩抹掉的行还在
//!   cost-state 里）。所以基线语义是 **replace 不是 add**：新 cost-state 到达时
//!   整块替换旧基线、清空旧基线之后的尾差（那些行已被新基线包含），否则两条
//!   同值 cost-state 会把整段会话计两遍——单测钉这条。
//! - **costUSD 永不当账单**（catalog `harness_costusd_note`）：对未知模型按默认卡
//!   $5/$0.5/$25 计，deepseek 网关模型高估 20-70×。本面只取 modelUsage 的 token
//!   桶（camel → snake），钱留给读取时用 catalog 官方卡折算。
//! - cost-state 无日界 → 基线**按 startTime（会话起始 ms）归到北京日**（v1
//!   文档化近似：压缩抹掉的消费归会话起始日；真机上 4/5 会话 cost-state 就在
//!   文件尾、尾差为零，这个近似只在跨日压缩时把中间几天的账移到起始日——已知、
//!   有注释，不是编造）。startTime 缺失退到 cost-state 记录自己的 ts 日；两者
//!   都没有 → 记 `unattributed_rows` 哨兵（基线仍存 checkpoint，但重建时无日可
//!   归——摘要里如实报），**绝不**编造一个日。
//! - 无 cost-state 的会话（真机 136/141——没写过压缩点就说明没压缩过，行就是
//!   全量）= 纯行和，逐行按 ts 归日。
//!
//! ## 行读形状嗅探（审阅裁决 P0）
//!
//! 行级 `message.usage` 真机 100% 是 **API 全形 snake 键**（`input_tokens` /
//! `cache_read_input_tokens` / `cache_creation_input_tokens` / `output_tokens`；
//! 753e080a 尾部另见 6 行只少 inference_geo 等装饰键的 5 键子集——计数键相同）。
//! 短键（`input`/`cache_read`/`cache_creation`/`output`）是真机语料 0 命中的旧
//! 形状（CLAUDE_CODE_INTEGRATION §2.4）——**两态都认**（wide in：机器找、人
//! 分类，与 usage.rs 的 usage_shaped 同条纪律）。两态皆无 → 该行不进任何桶 +
//! `unreadable_usage_rows` 哨兵——绝不把认不出的 usage 当 0。cost-state 的
//! modelUsage 是 camelCase（`inputTokens` 等），单独一路转换。
//!
//! ## Checkpoint / ledger / 归档的写序（镜像 month.json 纪律）
//!
//! - `claude-fold.json`：`{"sessions": {session_id: {size, mtime_ns, baseline,
//!   baseline_day, tail_days, seen_event_ids, unattributed_rows,
//!   unreadable_usage_rows, duplicate_usage_rows}}}`。`seen_event_ids`
//!   （v3 新增，2026-09-06）是本会话已折过的 `source_event_id`
//!   （message.id/uuid）集合——增量续折（resume）也要认得出跨批次的重复行，
//!   emitter 那种"整份重读、内存 HashSet 一次性去重"的做法在这里不成立，
//!   必须持久化。
//!   `size`/`mtime_ns` 是**已折到哪**的指纹（同 r2a fingerprint 的只 seek 精神：
//!   尾读只解析新行）。**无时间戳字段**——mtime/size 就是状态，字节确定性由
//!   构造保证（同一批输入重跑零变化，idempotency 测试钉）。
//! - 每次 sync 按 (size, mtime_ns) 决定 skip / 尾读续折 / 整份重折替换（size
//!   变小 = 截断重写；size 相同而 mtime 变 = 原地重写。两者都整份重折、会话
//!   状态替换——重折会让归档里旧日残留，同「会话删除不清 ledger」裁决：按日
//!   键控无尸害，文档注明）。
//! - 折完所有会话 → **从 checkpoint 全量重建** ledger（不是增量累加——重建
//!   天然幂等，崩溃重跑不会双计；增量累加才是 2026-08 三倍计数事故的温床）。
//!   逐日 by_model 桶里多会话同日相加；当前北京月的日子落 `claude-ledger.json`
//!   （**每次 sync 都写**，哪怕空 days——不清空的话跨月后旧文件停在盘上被误读
//!   成"本月"，这是 alert.json month-stale 事故的同类），更早的日子滚动进
//!   `claude-ledger-archive.json`（形状与语义复刻 month-archive：`{"months":
//!   {"YYYY-MM": {"days": {...}}}}` 逐日替换、幂等——归档只有跨月边界才写，所以
//!   `archived_at` 与 month-archive 同款会带 now 时间戳，差分测试对 ISO 打码）。
//!
//! 与 Python `scripts/agent_vitals/agent/claude_cost.py` 逐字节镜像，由
//! `tests/test_claude_cost.py` 的 `both()` 差分看守（同一批 fixture 会话文件 →
//! 两侧 fold.json/ledger/archive/stdout 字节一致）。

use std::collections::BTreeMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde_json::{json, Map, Value};

use agent_vitals_harnesses::claude_code_usage::SNAKE_KEYS;
use agent_vitals_harnesses::claude_usage_fact::{parse_claude_usage_row, UNATTRIBUTED, UNREADABLE};
use agent_vitals_runtime::sessions::codex_cost::current_month_beijing;
use agent_vitals_harnesses::claude_session::claude_project_files;
use agent_vitals_runtime::state::{atomic_write_json, now_iso_utc, read_json, state_dir};
use agent_vitals_runtime::takeover::require_rust_owner;

/// v0.6.x 前置正确性热修复（归日转正 + 峰谷分辨率 + 残差哨兵，三者同批——
/// 见 `docs/VITALS_CORE_V0_6_HARNESS_CONTRACT_SPEC.md` §5.3 条款 7 / §8 G10、
/// `docs/VITALS_CORE_V0_7_DATA_PLANE_SPEC.md` §5）。`claude-fold.json` 在这次
/// 改动之前没有 `schema_version`：旧 checkpoint 的 `tail_days` 是在"cost-state
/// 一来就清空"的旧算法下产生的，只保留最近一次基线之后的行，历史已经在写盘
/// 那一刻永久丢失——resume 读不回来，唯一正确的补救是强制全量重折一次
/// （源头 JSONL 文件本身没删，可重建）。`FOLD_SCHEMA_VERSION` 不匹配（含缺失，
/// 等价旧版本 0）时，`claude_sync` 清空整份 `sessions`，让每个文件都走
/// `fold_one` 的 "new" 分支——不是迁移函数，是"重新从权威源 ingest"，与 v0.7
/// spec §4.1"事实 cache 可重建"同一个原则。
///
/// **v3（2026-09-06，`apply_record` 补 `message.id` 去重）**：v2 及更早的
/// `tail_days` 是在"同一 assistant 消息重复几行就无条件累加几次"的旧算法
/// 下写的——真机验证 session-54c5e11f 的 `msg_011CejgZRMhsDR9bzwawJ5q6` 在
/// 同一文件里出现 4 次、`usage` 字段逐字节相同，2026-09 月度 claude token
/// 因此被系统性高估约 2 倍（memory `claude-ledger-overcount-bug`）。已写入
/// 的 `tail_days` 里这笔重复计数是**不可逆**的（没有存 `seen_event_ids`，
/// 无法事后甄别哪些累加是重复的）——与 v2 同一个补救：强制全量重折。
const FOLD_SCHEMA_VERSION: u64 = 3;

/// 行级 usage 的 4 个计数键 / 短键旧形状 / 行级读取原语已归位
/// `agent_vitals_harnesses::claude_code_usage`（Stage A emitter 归位的同一批：
/// fold 与 emitter 共享 extractor，emitter 住进 harnesses 后原语必须先行）。
const CAMEL_KEYS: [&str; 4] = [
    "inputTokens",
    "cacheReadInputTokens",
    "cacheCreationInputTokens",
    "outputTokens",
];
/// 高峰时段子桶——每个 SNAKE_KEYS 字段配一个 `peak_` 前缀的子计数，与 DSH
/// `usage.rs::add_buckets` 的 4+4 形状同构（v0.6 spec §5.3 条款 7 的"折叠时
/// 预拆"）。只从 `tail_days`（逐行真实 ts）里累计——cost-state 的 modelUsage
/// 是无时间戳的累计快照，永远没有资格填这四个键。
const PEAK_KEYS: [&str; 4] = [
    "peak_input_tokens",
    "peak_cache_read_input_tokens",
    "peak_cache_creation_input_tokens",
    "peak_output_tokens",
];

fn fold_path() -> std::path::PathBuf {
    state_dir().join("claude-fold.json")
}

fn ledger_path() -> std::path::PathBuf {
    state_dir().join("claude-ledger.json")
}

fn ledger_archive_path() -> std::path::PathBuf {
    state_dir().join("claude-ledger-archive.json")
}

// v0.9 Stage 0.3：`ledger_day_total_tokens`/`claude_ledger_day_tokens`（r2a_store
// 的 claude 执行环境行「今日 token」读的这条只读取值路径，与本文件的 fold 引擎零
// 交集）搬进了 `agent_vitals_runtime::sessions::claude_ledger`——见
// docs/AGENT_VITALS_V0_9_STAGE0_RESEARCH.md §6。`ledger_path()` 仍在本文件
// 内被 `claude_sync` 用，原地保留。

/// "YYYY-MM-DD" → "YYYY-MM"（前 7 字符）。
fn month_key_of(date: &str) -> String {
    date.chars().take(7).collect()
}

/// 从 cost-state modelUsage 的**单个模型条目**（camelCase）读 4 桶。
/// 键不全（真机没见过——客户端漂移）→ None → 哨兵。
fn camel_entry_tokens(entry: &Value) -> Option<[u64; 4]> {
    let obj = entry.as_object()?;
    let mut out = [0u64; 4];
    for (i, k) in CAMEL_KEYS.iter().enumerate() {
        out[i] = obj.get(*k).and_then(Value::as_u64)?;
    }
    Some(out)
}

fn inc(sess: &mut Map<String, Value>, key: &str) {
    let cur = sess.get(key).and_then(Value::as_u64).unwrap_or(0);
    sess.insert(key.to_string(), json!(cur + 1));
}

/// 4 桶加到 `obj`（4 个 snake 键的桶对象）里。用于 baseline / 归档合并这类
/// 只有 4 型、没有峰谷分辨率的场合。
fn bump_obj(obj: &mut Value, t: [u64; 4]) {
    let m = obj.as_object_mut().expect("bucket target is object");
    for (i, k) in SNAKE_KEYS.iter().enumerate() {
        let cur = m.get(*k).and_then(Value::as_u64).unwrap_or(0);
        m.insert((*k).to_string(), json!(cur + t[i]));
    }
}

/// 8 桶加到 `obj`（tail_days[day][model]，4 基础 + 4 峰值子桶，DSH
/// `usage.rs::add_buckets` 同形）。`peak=true` 时额外加进 `PEAK_KEYS`——
/// 子桶恒 ≤ 对应基础桶（同一次加法同时进两边，不会倒挂）。
fn bump_tail(obj: &mut Value, t: [u64; 4], peak: bool) {
    let m = obj.as_object_mut().expect("bucket target is object");
    for (i, k) in SNAKE_KEYS.iter().enumerate() {
        let cur = m.get(*k).and_then(Value::as_u64).unwrap_or(0);
        m.insert((*k).to_string(), json!(cur + t[i]));
    }
    if peak {
        for (i, k) in PEAK_KEYS.iter().enumerate() {
            let cur = m.get(*k).and_then(Value::as_u64).unwrap_or(0);
            m.insert((*k).to_string(), json!(cur + t[i]));
        }
    }
}

/// 一条记录 → 会话状态转换（assistant 行入尾差、cost-state 换基线对账锚）。
/// 纯函数：`sess` 是 claude-fold.json 里 `sessions[sid]` 的可变引用。
///
/// v0.6.x 前置热修（归日转正，2026-09-03）：`tail_days` **不再在 cost-state
/// 到来时清空**——旧算法「换基线、清尾差」会把已经有真实逐行 ts 的历史，
/// 整段折进一个只有单一 `startTime` 归属的基线，跨午夜会话的当日消费因此被
/// 错记到会话起始日（真机实测 197.5M flash cache-read 记错一天，见
/// `docs/CLAUDE_COST_DAY_ATTRIBUTION_ANALYSIS.md`）。新规则：`tail_days` 对
/// 整个会话生命周期只增不清，永远是"每笔 usage 按它自己的 ts 归日"的诚实
/// 记录；`cost-state` 的 `modelUsage` 只更新 `baseline`（最新累计自报），在
/// `rebuild_days` 里仅用作**对账锚**——`tail_days` 汇总 ≥ 基线时基线是冗余
/// 信息（被更精确的逐行数据完全覆盖，直接丢弃）；汇总 < 基线时，差值是真实
/// 存在但没有逐行证据的残差，进 `rebuild_days` 返回的 `unaccounted` 池——
/// 不猜它发生在哪一天。
///
/// R1 共享 extractor（commit d0ec2f2 拍板；Stage 1c 收尾）：assistant 行解析
/// 走共享 `parse_claude_usage_row`（`claude_usage_fact.rs`），fold 与 emitter
/// 消费同一个 row parser——两端各自解释 wire shape 会让"emit 出的 fact_id 与
/// fold 出来的 day"静默错位。Skip 只递增对应 sentinel（SKIP 不增），Ok 走
/// `bump_tail` 累加 8 桶；Sentinel 触发条件与旧 inline 逻辑逐字段一致（commit
/// 1 golden 零漂移硬条件）。`native_session_id` / `machine_namespace` /
/// `source_profile` 只进 Observation 的 identity 字段，fold 不读——透传是让
/// 调用形状与 Python `_apply_record` 对齐（future writer / R2a 接线时不用再改
/// 签名），值不影响 fold 输出。
fn apply_record(
    sess: &mut Map<String, Value>,
    rec: &Value,
    native_session_id: &str,
    machine_namespace: &str,
    source_profile: &str,
) {
    // tail_days 是 assistant 行的落点；fresh 会话第一个 assistant 行进来时
    // 还没有这个键——懒建，别 expect。
    if !sess.contains_key("tail_days") {
        sess.insert("tail_days".to_string(), json!({}));
    }
    match rec.get("type").and_then(Value::as_str) {
        Some("cost-state") => {
            // 基线更新：modelUsage 是整段会话的累计自报（真机两条同值
            // cost-state 逐字段相同证明）。只更新对账锚，不再清 tail_days、
            // 不再算 baseline_day——归日全部交给 assistant 行自己的 ts。
            let usage = rec.get("modelUsage");
            let mut baseline = Map::new();
            match usage.and_then(Value::as_object) {
                Some(models) => {
                    for (model, entry) in models {
                        match camel_entry_tokens(entry) {
                            Some(t) => {
                                let mut b = Map::new();
                                for (i, k) in SNAKE_KEYS.iter().enumerate() {
                                    b.insert((*k).to_string(), json!(t[i]));
                                }
                                baseline.insert(model.clone(), Value::Object(b));
                            }
                            None => inc(sess, "unreadable_usage_rows"),
                        }
                    }
                }
                None => inc(sess, "unreadable_usage_rows"),
            }
            sess.insert("baseline".to_string(), Value::Object(baseline));
        }
        Some("assistant") => {
            // R1 共享 extractor（Stage 1c 收尾）：fold 与 emitter 共用一个 row
            // parser。assistant 行形状 → Ok(Observation)（day/model/tokens/peak
            // 已由 parser 填好，fold 不再各自解释 wire shape）或
            // Err(sentinel)。cost-state 在 cost-state 分支处理、不经 parse
            // （parse 只认 assistant）。
            match parse_claude_usage_row(
                rec,
                native_session_id,
                machine_namespace,
                source_profile,
            ) {
                Ok(obs) => {
                    // 去重（2026-09-06 真机对账挖出的头部 bug，见 memory
                    // `claude-ledger-overcount-bug`）：Claude Code 的 session
                    // JSONL 会把同一条**已完成**的 assistant 消息重复写出好
                    // 几行——真机实例 session-54c5e11f 的
                    // `msg_011CejgZRMhsDR9bzwawJ5q6` 在同一文件里出现 4 次，
                    // 4 行的 `usage` 字段逐字节相同（不是流式增量快照，是纯
                    // 重复记录，只有各行自己的顶层 uuid/timestamp 不同）。
                    // 旧代码对每一行无条件 `bump_tail`，真机 2026-09 月度
                    // token 因此被系统性高估约 2 倍。
                    //
                    // 去重键 = `source_event_id`（message.id，缺席回落顶层
                    // uuid）——与 emitter（`claude_usage_fact.rs`）"同一
                    // session 重复 source_event_id 只保留一个 fact"完全同一
                    // 条规则，两条管线现在算出同一个数。**只在
                    // `source_event_id` 非空（`identity_basis=="native"`）
                    // 时去重**：derived-hash 的空 `source_event_id` 需要
                    // emitter 那边的文件级字节偏移才能补全，fold 侧拿不到，
                    // 保留旧行为——真机语料 uuid 恒存在，这个分支理论存在、
                    // 实测未命中，不强行凑一个不可靠的键导致误判去重。
                    if !obs.source_event_id.is_empty() {
                        let seen = sess
                            .entry("seen_event_ids".to_string())
                            .or_insert_with(|| json!({}))
                            .as_object_mut()
                            .expect("seen_event_ids is object");
                        if seen.contains_key(&obs.source_event_id) {
                            inc(sess, "duplicate_usage_rows");
                            return;
                        }
                        seen.insert(obs.source_event_id.clone(), Value::Bool(true));
                    }
                    // 峰谷归属：这一行有真实 ts，分辨率是精确的，不是猜的。
                    // ms/peak 由共享 parser 从同一 ts 算（缺 time 不臆造高峰）。
                    let tail = sess
                        .get_mut("tail_days")
                        .and_then(Value::as_object_mut)
                        .expect("tail_days ensured above");
                    let day_obj = tail.entry(obs.day).or_insert_with(|| json!({}));
                    let model_obj = day_obj
                        .as_object_mut()
                        .expect("day entry is object")
                        .entry(obs.model)
                        .or_insert_with(|| json!({}));
                    bump_tail(
                        model_obj,
                        [
                            obs.input_tokens,
                            obs.cache_read_tokens,
                            obs.cache_write_tokens,
                            obs.output_tokens,
                        ],
                        obs.peak,
                    );
                }
                // 有 usage 但没 model / 两态皆无 → 哨兵，绝不编模型名/当 0。
                Err(UNREADABLE) => inc(sess, "unreadable_usage_rows"),
                // 行有 usage 但 ts 不可解析 → 日线无处可挂 → 哨兵，不猜日。
                Err(UNATTRIBUTED) => inc(sess, "unattributed_rows"),
                // SKIP（cost-state 已分流，这里只可能是无 message/无 usage 的
                // assistant 行等非 usage 行）不增 sentinel。
                Err(_) => {}
            }
        }
        _ => {}
    }
}

/// 把 `{model: {8 snake+peak}}` 桶并进一个**已铺平到 model 层**的日对象
/// （多会话同日相加——逐会话 replacement 会丢别的会话，ledger 必须全量
/// 重建，这就是不增量累加的原因）。峰值子桶随基础桶一起搬，8 键一视同仁
/// ——不是"4 键 + 额外逻辑"，是同一份键表的自然扩展。
fn merge_models_into_day(day: &mut Value, buckets: &Value) {
    let Some(by_model) = buckets.as_object() else {
        return;
    };
    let day_obj = day.as_object_mut().expect("day is object");
    for (model, t8) in by_model {
        let Some(obj) = t8.as_object() else {
            continue;
        };
        let mut hits: Vec<(&str, u64)> = Vec::new();
        for k in SNAKE_KEYS.iter().chain(PEAK_KEYS.iter()) {
            if let Some(v) = obj.get(*k).and_then(Value::as_u64) {
                hits.push((k, v));
            }
        }
        if hits.is_empty() {
            continue;
        }
        let model_obj = day_obj
            .entry(model.clone())
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .expect("day model entry is object");
        for (k, v) in hits {
            let cur = model_obj.get(k).and_then(Value::as_u64).unwrap_or(0);
            model_obj.insert(k.to_string(), json!(cur + v));
        }
    }
}

#[derive(PartialEq, Debug, Clone, Copy)]
enum FoldKind {
    /// 新文件 / 整份重折（size 变小或 size 相同而 mtime 变）→ 状态替换。
    New,
    /// checkpoint 之后有增量 → 从 checkpoint.size 续读。
    Resume,
    /// size/mtime 都没变 → 不动。
    Skip,
}

fn stat_file(path: &Path) -> Option<(u64, u64)> {
    let md = std::fs::metadata(path).ok()?;
    let mtime = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    Some((md.len(), mtime))
}

/// 从字节偏移 `from` 读完整行，逐行解析。返回 (记录, 新偏移)。
/// 末行无换行符 → 不消费（客户端可能正写到一半，下个 sync 补上）。
/// 完整行 JSON 解析失败 → Err（整份 abort、checkpoint 不动，下次 sync 重试
/// ——与 claude_session 的「一条坏行毁整份」同款，绝不拼半截）。
fn read_suffix(path: &Path, from: u64) -> Result<(Vec<Value>, u64), String> {
    let mut f = std::fs::File::open(path)
        .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    f.seek(SeekFrom::Start(from))
        .map_err(|e| format!("cannot seek {}: {e}", path.display()))?;
    let mut bytes = Vec::new();
    f.read_to_end(&mut bytes)
        .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let mut out = Vec::new();
    let mut pos = from;
    let mut start = 0usize;
    for (i, b) in bytes.iter().enumerate() {
        if *b == b'\n' {
            let mut line = &bytes[start..i];
            if line.ends_with(b"\r") {
                line = &line[..line.len() - 1];
            }
            if !line.is_empty() {
                let text = String::from_utf8_lossy(line);
                let v: Value = serde_json::from_str(&text).map_err(|e| {
                    format!(
                        "non-json line in {} at byte offset {}: {e}",
                        path.display(),
                        from + start as u64
                    )
                })?;
                out.push(v);
            }
            pos = from + (i + 1) as u64;
            start = i + 1;
        }
    }
    Ok((out, pos))
}

/// 一个会话文件折进 `sessions`。返回折叠类别（New 含整份重折替换）。
///
/// R1 共享 extractor：`apply_record` 经 `parse_claude_usage_row` 解析 assistant
/// 行，需要 `native_session_id`（= 本文件 stem，Python `_fold_one` 同款）与
/// `machine_namespace`/`source_profile`（caller 注入，fold 不读 identity 字段、
/// 只透传——值不影响 fold 输出，placeholder 与 Python `claude_sync` 对齐）。
fn fold_one(
    sessions: &mut Map<String, Value>,
    path: &Path,
    size: u64,
    mtime: u64,
    machine_namespace: &str,
    source_profile: &str,
) -> Result<FoldKind, String> {
    let sid = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown")
        .to_string();
    let (from, kind) = match sessions.get(&sid) {
        None => (0, FoldKind::New),
        Some(existing) => {
            let csize = existing.get("size").and_then(Value::as_u64).unwrap_or(0);
            let cmtime = existing.get("mtime_ns").and_then(Value::as_u64).unwrap_or(0);
            if size == csize && mtime == cmtime {
                return Ok(FoldKind::Skip);
            }
            if size <= csize {
                (0, FoldKind::New) // 截断重写 / 原地重写 → 整份重折替换
            } else {
                (csize, FoldKind::Resume)
            }
        }
    };
    let (records, new_pos) = read_suffix(path, from)?;
    let mut sess = if kind == FoldKind::New {
        Map::new()
    } else {
        sessions
            .get(&sid)
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default()
    };
    for rec in &records {
        apply_record(&mut sess, rec, &sid, machine_namespace, source_profile);
    }
    sess.insert("size".to_string(), json!(new_pos));
    sess.insert("mtime_ns".to_string(), json!(mtime));
    sessions.insert(sid, Value::Object(sess));
    Ok(kind)
}

/// 从会话状态全量重建逐日桶。返回 (当前月 ledger days, 要滚进归档的 days)。
/// `{day: {model: {8 键}}}` → `{model: [4 型 snake 总量]}`（跨全部日子求和，
/// 只取基础 4 键——峰谷子桶不参与对账，它们是基础桶的子集，加总基础桶就够
/// 判断"这个模型的行级证据覆盖了多少"）。
fn session_row_sum(tail: &Value) -> BTreeMap<String, [u64; 4]> {
    let mut out: BTreeMap<String, [u64; 4]> = BTreeMap::new();
    let Some(days) = tail.as_object() else {
        return out;
    };
    for buckets in days.values() {
        let Some(by_model) = buckets.as_object() else {
            continue;
        };
        for (model, t8) in by_model {
            let Some(obj) = t8.as_object() else {
                continue;
            };
            let acc = out.entry(model.clone()).or_insert([0u64; 4]);
            for (i, k) in SNAKE_KEYS.iter().enumerate() {
                if let Some(v) = obj.get(*k).and_then(Value::as_u64) {
                    acc[i] += v;
                }
            }
        }
    }
    out
}

/// 从会话状态全量重建逐日桶 + 残差对账。返回 (当前月 ledger days, 要滚进
/// 归档的 days, unaccounted 残差 `{model: {4 键}}`)。
///
/// v0.6.x 前置热修（归日转正 + 残差哨兵，2026-09-03）：日桶**只**由
/// `tail_days`（逐行真实 ts，峰谷分辨率精确）铺出——`baseline`（cost-state
/// 累计自报）不再被当成"这一天的用量"塞进任何日子，它只做**对账锚**：
/// 逐会话、逐模型比较 `tail_days` 汇总与最新 `baseline`——汇总 ≥ 基线 →
/// 基线是行级证据的子集，冗余，丢弃；汇总 < 基线 → 差值是真实发生过但没有
/// 留下逐行 ts 证据的用量（比如压缩/截断丢失的早期历史），计入
/// `unaccounted`——它没有日期，也没有峰谷分辨率（不知道何时发生的，不能
/// 假装知道），调用方（`priced_day`/日历这类消费端）必须把它单独标注、
/// 不能悄悄摊进某一天冒充精确。
fn rebuild_days(
    sessions: &Value,
    current: &str,
) -> (Map<String, Value>, Map<String, Value>, Map<String, Value>) {
    let mut all: BTreeMap<String, Value> = BTreeMap::new();
    let mut unaccounted: Map<String, Value> = Map::new();
    let Some(sessions_map) = sessions.as_object() else {
        return (Map::new(), Map::new(), Map::new());
    };
    for sess in sessions_map.values() {
        let Some(obj) = sess.as_object() else {
            continue;
        };
        let tail_value = obj.get("tail_days").cloned().unwrap_or_else(|| json!({}));
        if let Some(tail) = tail_value.as_object() {
            for (day, buckets) in tail {
                let entry = all.entry(day.clone()).or_insert_with(|| json!({}));
                merge_models_into_day(entry, buckets);
            }
        }
        let row_sum = session_row_sum(&tail_value);
        if let Some(baseline) = obj.get("baseline").and_then(Value::as_object) {
            for (model, t4) in baseline {
                let Some(bobj) = t4.as_object() else {
                    continue;
                };
                let mut base_arr = [0u64; 4];
                for (i, k) in SNAKE_KEYS.iter().enumerate() {
                    if let Some(v) = bobj.get(*k).and_then(Value::as_u64) {
                        base_arr[i] = v;
                    }
                }
                let row_arr = row_sum.get(model).copied().unwrap_or([0u64; 4]);
                let residual: [u64; 4] =
                    std::array::from_fn(|i| base_arr[i].saturating_sub(row_arr[i]));
                if residual.iter().any(|v| *v > 0) {
                    let entry = unaccounted
                        .entry(model.clone())
                        .or_insert_with(|| json!({}));
                    bump_obj(entry, residual);
                }
            }
        }
    }
    // 分月：当前月 → ledger；更早的日子 → 归档（写侧逐日替换幂等）。
    let mut ledger = Map::new();
    let mut archive = Map::new();
    for (day, merged) in all {
        if month_key_of(&day) == current {
            ledger.insert(day, merged);
        } else {
            archive.insert(day, merged);
        }
    }
    (ledger, archive, unaccounted)
}

/// `agent-vitals claude-sync` 主入口：发现变化会话 → 尾读折入 checkpoint →
/// 剥掉归档里每个月的 archived_at（写入时刻的元数据，不参与内容比较）。
/// 见 claude_sync 的归档写条件——比较必须剥它，否则候选永远≠现状。
fn strip_archive_ts(value: &Value) -> Value {
    let mut out = value.clone();
    if let Some(months) = out.get_mut("months").and_then(Value::as_object_mut) {
        for entry in months.values_mut() {
            if let Some(o) = entry.as_object_mut() {
                o.remove("archived_at");
            }
        }
    }
    out
}

/// 重建 ledger + 归档 → 打印确定性摘要。owner fencing 同 oneline
/// （require_rust_owner，--shadow 跳过）。单文件坏行只计 failed、不 abort
/// 整轮（下轮重试），exit 0——fencing/审计失败才 Err。
pub fn claude_sync(home: &Path, shadow: bool) -> Result<(), String> {
    require_rust_owner(shadow)?;
    let files = claude_project_files(home);
    let fp = fold_path();
    let mut folds = read_json(&fp).unwrap_or_else(|| json!({"sessions": {}}));
    // v0.6.x 前置热修的强制重折闸门：旧 checkpoint（`schema_version` 缺失或
    // 不是当前版本）是在"cost-state 一来就清 tail_days"的旧算法下写的——它的
    // `tail_days` 只剩最近一次基线之后的行，更早的历史已经被旧算法永久清掉，
    // 不是"还没折"而是"折过又被丢"，resume 读不回来。清空 `sessions` 让
    // `fold_one` 对每个文件都走 New 分支，从源头 JSONL 重新 ingest——与
    // v0.7 spec §4.1"事实 cache 可重建"同一个原则，不是迁移函数（没有可从
    // 旧结构直接推导新结构的路径，旧结构本身就丢了信息）。
    if folds.get("schema_version").and_then(Value::as_u64) != Some(FOLD_SCHEMA_VERSION) {
        folds = json!({"sessions": {}});
    }
    let sessions = match folds.get_mut("sessions") {
        Some(Value::Object(m)) => m,
        _ => {
            folds["sessions"] = json!({});
            folds
                .get_mut("sessions")
                .and_then(Value::as_object_mut)
                .expect("just inserted")
        }
    };
    let mut scanned = 0u64;
    let mut fresh = 0u64;
    let mut resumed = 0u64;
    let mut skipped = 0u64;
    let mut failed = 0u64;
    for path in &files {
        scanned += 1;
        let Some((size, mtime)) = stat_file(path) else {
            continue; // 枚举与 stat 之间文件消失 → 不计（下轮不再有它）
        };
        // machine_namespace/source_profile 目前与 Python claude_sync 同款
        // placeholder（fold 不读 identity 字段，值不影响输出；等 R2a 接线后
        // 才注入真实 namespace）。
        match fold_one(sessions, path, size, mtime, "ns-placeholder", "default") {
            Ok(FoldKind::New) => fresh += 1,
            Ok(FoldKind::Resume) => resumed += 1,
            Ok(FoldKind::Skip) => skipped += 1,
            Err(_) => failed += 1,
        }
    }
    // 摘要统计（最终态）：基线会话数 / 纯行和会话数 / 两个哨兵计数。
    let mut with_baseline = 0u64;
    let mut row_sum_only = 0u64;
    let mut unreadable = 0u64;
    let mut unattributed = 0u64;
    let mut duplicate = 0u64;
    for sess in sessions.values() {
        let Some(o) = sess.as_object() else {
            continue;
        };
        if o.contains_key("baseline") {
            with_baseline += 1;
        } else {
            row_sum_only += 1;
        }
        unreadable += o.get("unreadable_usage_rows").and_then(Value::as_u64).unwrap_or(0);
        unattributed += o.get("unattributed_rows").and_then(Value::as_u64).unwrap_or(0);
        duplicate += o.get("duplicate_usage_rows").and_then(Value::as_u64).unwrap_or(0);
    }
    folds["schema_version"] = json!(FOLD_SCHEMA_VERSION);
    atomic_write_json(&fp, &folds);
    // 全量重建 ledger + 归档 + 残差（幂等；崩溃重跑不会双计）。rebuild_days
    // 吃的是 sessions 映射（sid → 会话状态），不是 {"sessions": …} 外壳——
    // 两层结构刚写出时混过一次：把外壳喂进去，整本折叠空账，ledger 恒为空
    // 还不报错（Python smoke 抓到；两侧一行同型，一起修）。
    let now = now_iso_utc();
    let current = current_month_beijing();
    let sessions_v = folds.get("sessions").cloned().unwrap_or_else(|| json!({}));
    let (ledger_days, archive_days, unaccounted) = rebuild_days(&sessions_v, &current);
    // 归档只在**日桶内容**变化时落盘：add_days_to_archive 每调用都会给当月
    // 盖一个新 archived_at，若每轮无条件写，零变化的幂等重跑也会改写整个
    // 文件（真机冻结语料复跑抓到：fold/ledger 字节不变、archive 每轮都变）。
    // archived_at 记录的是「真正归档那次」的时刻，不是「本轮核对过」。
    let unaccounted_tokens: u64 = unaccounted
        .values()
        .flat_map(|t| SNAKE_KEYS.iter().filter_map(|k| t.get(*k).and_then(Value::as_u64)))
        .sum();
    // Phase 4.2（spec §6.1）：`sql_authority_enabled` 后 `claude-ledger.json` /
    // `-archive.json`（§5.2 业务读源）不再更新——SQL 权威库是唯一权威，
    // `sync-facts` 的 claude UsageFact + `data-migrate` 的 legacy_aggregate
    // 已捕获。`claude-fold.json`（checkpoint，上面 line ~665）照常写。
    if agent_vitals_runtime::sql_authority::is_enabled_default() {
        println!("claude-sync: sql-authority enabled — legacy ledger writes frozen (claude-fold checkpoint still updated)");
    } else {
        if !archive_days.is_empty() {
            let existing = read_json(&ledger_archive_path()).unwrap_or_else(|| json!({}));
            let candidate = agent_vitals_domain::state::add_days_to_archive(
                &existing, &json!(archive_days), &now);
            if strip_archive_ts(&candidate) != strip_archive_ts(&existing) {
                atomic_write_json(&ledger_archive_path(), &candidate);
            }
        }
        // `unaccounted` 恒写（哪怕空 object）——缺席必须是"测过是空"，不是"没写这个键"。
        atomic_write_json(
            &ledger_path(),
            &json!({ "days": ledger_days, "unaccounted": unaccounted }),
        );
    }
    println!(
        "claude-sync: scanned {scanned} files; folded {} (new {fresh}, resumed {resumed}); skipped {skipped}; failed {failed}",
        fresh + resumed
    );
    println!(
        "claude-sync: cost-state baselines: {with_baseline} sessions; row-sum only: {row_sum_only}"
    );
    println!(
        "claude-sync: ledger days: {}; unreadable usage rows: {unreadable}; unattributed rows: {unattributed}; duplicate usage rows: {duplicate}",
        ledger_days.len()
    );
    println!(
        "claude-sync: unaccounted residual: {} models; {unaccounted_tokens} tokens",
        unaccounted.len()
    );
    Ok(())
}

// ────────────────────────── 纯函数单测 ──────────────────────────
// 与 `tests/test_claude_cost.py` 钉同一组数值，docstring 互相指认；
// claude-sync 端到端差分由该文件的 `both()` 看守。改数字 = 两边一起改。

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn camel_entry_tokens_converts_cost_state() {
        // Python 同组 fixture：cost-state modelUsage 的 camel 条目 → snake 4 桶。
        let entry = json!({"inputTokens": 12646741, "outputTokens": 6111069,
                           "cacheReadInputTokens": 731886848,
                           "cacheCreationInputTokens": 0,
                           "webSearchRequests": 3, "costUSD": 581.98});
        assert_eq!(camel_entry_tokens(&entry), Some([12_646_741, 731_886_848, 0, 6_111_069]));
        // 键不全（客户端漂移）→ None → 哨兵。
        assert_eq!(camel_entry_tokens(&json!({"inputTokens": 1})), None);
    }

    #[test]
    fn baseline_is_reconciliation_anchor_not_a_day_dump() {
        // 新算法钉测（取代旧的 baseline_replace_does_not_double_count）：
        // cost-state 只更新 baseline，不再清 tail_days、不再造
        // baseline_day——中间那条行在两次基线之间原样留在 tail_days 里，
        // 日期是它自己 ts 算出来的（08-31，19Z≥16 进位），不是被吞掉也不是
        // 被摊给某一天。Python 同名测试同 fixture。
        let cs = |start: i64| json!({
            "type": "cost-state",
            "timestamp": "2026-08-30T18:00:00.000Z",
            "startTime": start,
            "modelUsage": {
                "deepseek-v4-flash": {"inputTokens": 1000, "outputTokens": 100,
                                      "cacheReadInputTokens": 0,
                                      "cacheCreationInputTokens": 0,
                                      "webSearchRequests": 0, "costUSD": 0.1}
            },
            "hasUnknownModelCost": true,
        });
        let row = json!({
            "type": "assistant",
            "timestamp": "2026-08-30T19:00:00.000Z",
            "message": {"model": "deepseek-v4-flash", "usage": {
                "input_tokens": 10, "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 0, "output_tokens": 1}},
        });
        let mut sess = Map::new();
        for rec in [&cs(1_788_084_986_000), &row, &cs(1_788_084_986_000)] {
            apply_record(&mut sess, rec, "test-sid", "ns-placeholder", "default");
        }
        assert_eq!(
            sess.get("baseline")
                .unwrap()
                .get("deepseek-v4-flash")
                .unwrap()
                .get("input_tokens"),
            Some(&json!(1000))
        );
        assert!(!sess.contains_key("baseline_day"));
        assert_eq!(
            sess.get("tail_days").unwrap().get("2026-08-31").unwrap()
                .get("deepseek-v4-flash").unwrap().get("input_tokens"),
            Some(&json!(10))
        );
        assert_eq!(sess.get("unattributed_rows"), None);
        assert_eq!(sess.get("unreadable_usage_rows"), None);
        // 对账：基线 1000 > 行和 10 → 差值 990 是残差，不体现在 tail_days 里。
        let mut sessions = Map::new();
        sessions.insert("s1".to_string(), Value::Object(sess));
        let (ledger, _archive, unaccounted) =
            rebuild_days(&Value::Object(sessions), "2026-08");
        assert_eq!(
            ledger.get("2026-08-31").unwrap().get("deepseek-v4-flash").unwrap().get("input_tokens"),
            Some(&json!(10))
        );
        assert_eq!(
            unaccounted.get("deepseek-v4-flash").unwrap().get("input_tokens"),
            Some(&json!(990))
        );
    }

    /// 2026-09-06 真机对账挖出的头部 bug 回归（memory
    /// `claude-ledger-overcount-bug`）：同一条 assistant 消息（同一
    /// `message.id`）重复出现——真机实例 4 次、usage 字段逐字节相同——旧
    /// 算法无条件 `bump_tail`，claude-code 月度 token 因此被系统性高估约
    /// 2 倍。这里钉最小复现：同一 message.id 出现 3 次只应计一次。
    #[test]
    fn duplicate_message_id_is_counted_once() {
        let row = |ts: &str| json!({
            "type": "assistant", "timestamp": ts,
            "message": {"id": "msg_dup", "model": "claude-opus-5", "usage": {
                "input_tokens": 100, "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 0, "output_tokens": 10}},
        });
        let mut sess = Map::new();
        for ts in ["2026-09-05T04:44:53.062Z", "2026-09-05T04:44:53.587Z",
                   "2026-09-05T04:44:54.781Z"] {
            apply_record(&mut sess, &row(ts), "test-sid", "ns-placeholder", "default");
        }
        let tail = sess.get("tail_days").unwrap().get("2026-09-05").unwrap()
            .get("claude-opus-5").unwrap();
        assert_eq!(tail.get("input_tokens"), Some(&json!(100)), "重复行不能累加两次");
        assert_eq!(tail.get("output_tokens"), Some(&json!(10)));
        // 两次重复（3 次出现 − 1 次首见）计成 duplicate sentinel。
        assert_eq!(sess.get("duplicate_usage_rows"), Some(&json!(2)));
        assert_eq!(
            sess.get("seen_event_ids").unwrap().as_object().unwrap().len(),
            1,
            "去重集合只应记住一个 message.id"
        );
    }

    /// 对照组：不同 `message.id`、相同 usage 的两条行必须都计入——去重键是
    /// message.id 本身，不是"usage 数值相同就判重复"（那会把两次真实独立
    /// 的相同用量的调用误判成一次）。
    #[test]
    fn different_message_ids_with_identical_usage_both_count() {
        let row = |id: &str, ts: &str| json!({
            "type": "assistant", "timestamp": ts,
            "message": {"id": id, "model": "claude-opus-5", "usage": {
                "input_tokens": 100, "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 0, "output_tokens": 10}},
        });
        let mut sess = Map::new();
        apply_record(&mut sess, &row("msg_a", "2026-09-05T04:44:53.062Z"),
                     "test-sid", "ns-placeholder", "default");
        apply_record(&mut sess, &row("msg_b", "2026-09-05T04:44:54.062Z"),
                     "test-sid", "ns-placeholder", "default");
        let tail = sess.get("tail_days").unwrap().get("2026-09-05").unwrap()
            .get("claude-opus-5").unwrap();
        assert_eq!(tail.get("input_tokens"), Some(&json!(200)), "两条不同消息都必须计入");
        assert_eq!(sess.get("duplicate_usage_rows"), None, "两条都是首见，没有重复");
    }

    #[test]
    fn cost_state_mid_file_then_tail_rows_by_day() {
        // Python 同名测试同 fixture：基线不再落在任何一天，只做对账锚。
        let cs = json!({
            "type": "cost-state", "timestamp": "2026-08-30T11:00:00.000Z",
            // 1788084986000 ms = 2026-08-30T10:16:26Z → 北京 08-30（真值，别手算）。
            "startTime": 1_788_084_986_000i64,
            "modelUsage": {"claude-opus-5": {"inputTokens": 500, "outputTokens": 0,
                                             "cacheReadInputTokens": 0,
                                             "cacheCreationInputTokens": 0,
                                             "webSearchRequests": 0, "costUSD": 0.0}},
            "hasUnknownModelCost": false,
        });
        let row = |ts: &str, n: u64| json!({
            "type": "assistant", "timestamp": ts,
            "message": {"model": "deepseek-v4-flash", "usage": {
                "input_tokens": n, "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 0, "output_tokens": 0}},
        });
        let mut sess = Map::new();
        for rec in [&cs, &row("2026-08-30T19:00:00.000Z", 10), // 北京 08-31 03:00
                    &row("2026-08-31T12:00:00.000Z", 20),     // 北京 08-31
                    &row("2026-08-31T20:00:00.000Z", 30)]     // 北京 09-01
        {
            apply_record(&mut sess, rec, "test-sid", "ns-placeholder", "default");
        }
        assert!(!sess.contains_key("baseline_day"));
        assert_eq!(
            sess.get("baseline").unwrap().get("claude-opus-5").unwrap().get("input_tokens"),
            Some(&json!(500))
        );
        let tail = sess.get("tail_days").unwrap();
        // 三条行的 UTC ts 各自跨日：08-30T19Z→08-31、08-31T12Z→08-31（累 30）、
        // 08-31T20Z→09-01。
        assert_eq!(
            tail.get("2026-08-31").unwrap().get("deepseek-v4-flash").unwrap().get("input_tokens"),
            Some(&json!(30))
        );
        assert_eq!(
            tail.get("2026-09-01").unwrap().get("deepseek-v4-flash").unwrap().get("input_tokens"),
            Some(&json!(30))
        );
        assert_eq!(tail.get("2026-08-30"), None);
        assert_eq!(tail.as_object().unwrap().len(), 2);
        // claude-opus-5 的基线在 tail_days 里零覆盖（所有行都是
        // deepseek-v4-flash）→ 500 全部是残差，不落在任何一天。
        let mut sessions = Map::new();
        sessions.insert("s1".to_string(), Value::Object(sess));
        let (ledger, _archive, unaccounted) =
            rebuild_days(&Value::Object(sessions), "2026-08");
        assert_eq!(
            unaccounted.get("claude-opus-5").unwrap().get("input_tokens"),
            Some(&json!(500))
        );
        assert!(ledger
            .get("2026-08-31")
            .and_then(|d| d.get("claude-opus-5"))
            .is_none());
    }

    #[test]
    fn no_cost_state_session_is_row_sum() {
        // Python 同名测试同 fixture：无 cost-state → 无 baseline 键、纯行和。
        let row = json!({
            "type": "assistant", "timestamp": "2026-08-31T10:00:00.000Z",
            "message": {"model": "deepseek-v4-flash", "usage": {
                "input_tokens": 7, "cache_read_input_tokens": 8,
                "cache_creation_input_tokens": 0, "output_tokens": 9}},
        });
        let mut sess = Map::new();
        apply_record(&mut sess, &row, "test-sid", "ns-placeholder", "default");
        assert!(!sess.contains_key("baseline"));
        assert_eq!(
            sess.get("tail_days").unwrap().get("2026-08-31").unwrap()
                .get("deepseek-v4-flash").unwrap().get("cache_read_input_tokens"),
            Some(&json!(8))
        );
    }

    #[test]
    fn unparseable_ts_and_usage_are_sentineled_not_faked() {
        // Python 同名测试同 fixture：ts 坏 → unattributed 哨兵；usage 键两态
        // 皆无 → unreadable 哨兵；usage 有而 model 缺 → unreadable。
        let mut sess = Map::new();
        apply_record(&mut sess, &json!({
            "type": "assistant", "timestamp": "bogus",
            "message": {"model": "deepseek-v4-flash", "usage": {
                "input_tokens": 1, "cache_read_input_tokens": 0,
                "cache_creation_input_tokens": 0, "output_tokens": 0}},
        }), "test-sid", "ns-placeholder", "default");
        apply_record(&mut sess, &json!({
            "type": "assistant", "timestamp": "2026-08-31T10:00:00.000Z",
            "message": {"model": "deepseek-v4-flash", "usage": {"prompt_tokens": 5}},
        }), "test-sid", "ns-placeholder", "default");
        apply_record(&mut sess, &json!({
            "type": "assistant", "timestamp": "2026-08-31T10:00:00.000Z",
            "message": {"usage": {"input_tokens": 1, "cache_read_input_tokens": 0,
                                  "cache_creation_input_tokens": 0,
                                  "output_tokens": 0}},
        }), "test-sid", "ns-placeholder", "default");
        assert_eq!(sess.get("unattributed_rows"), Some(&json!(1)));
        assert_eq!(sess.get("unreadable_usage_rows"), Some(&json!(2)));
        assert_eq!(sess.get("tail_days").unwrap().as_object().unwrap().len(), 0);
    }

    #[test]
    fn rebuild_partitions_current_month_and_merges_sessions() {
        // Python 同名测试同 fixture：当前月进 ledger、更早进 archive（传入
        // 固定 current——纯函数不读钟）。s1 只有 baseline（无 tail_days 覆盖）
        // → 100 全部是残差，不进任何一天；s2 的行 50 单独落 08-31（不再被
        // s1 的基线加成 150）。
        let sessions = json!({
            "s1": {"size": 1, "mtime_ns": 1, "baseline": {
                "deepseek-v4-flash": {"input_tokens": 100, "cache_read_input_tokens": 0,
                                      "cache_creation_input_tokens": 0,
                                      "output_tokens": 0}},
                "tail_days": {}},
            "s2": {"size": 1, "mtime_ns": 1, "tail_days": {
                "2026-08-31": {"deepseek-v4-flash": {"input_tokens": 50,
                    "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0,
                    "output_tokens": 0}}}},
            "s3": {"size": 1, "mtime_ns": 1, "tail_days": {
                "2026-09-01": {"claude-sonnet-5": {"input_tokens": 20,
                    "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0,
                    "output_tokens": 0}}}},
        });
        let (ledger, archive, unaccounted) = rebuild_days(&sessions, "2026-09");
        // 当前月 = 2026-09：08-31 是过去月 → 滚进 archive；只有 09-01 留 ledger。
        assert_eq!(ledger.len(), 1);
        let d1 = ledger.get("2026-09-01").unwrap();
        assert_eq!(
            d1.get("claude-sonnet-5").unwrap().get("input_tokens"),
            Some(&json!(20))
        );
        assert_eq!(archive.len(), 1);
        let d31 = archive.get("2026-08-31").unwrap();
        assert_eq!(
            d31.get("deepseek-v4-flash").unwrap().get("input_tokens"),
            Some(&json!(50))
        );
        assert_eq!(
            unaccounted.get("deepseek-v4-flash").unwrap().get("input_tokens"),
            Some(&json!(100))
        );
    }

    // `ledger_day_total_tokens_sums_snake_keys_ignoring_extras` 随函数一起搬进
    // agent_vitals_runtime::sessions::claude_ledger（v0.9 Stage 0.3）。

    // ── 真机对账 fixture（spec §5 后段）── 钉住 197.5M 归日 + 残差哨兵 ────
    // Python `tests/test_claude_cost.py::RealWorldMisattributionCase` 同夹具
    // 同期望值互守（CLAUDE.md「同夹具同期望值两侧各钉一遍」纪律）。真机来源：
    // `docs/CLAUDE_COST_DAY_ATTRIBUTION_ANALYSIS.md` §5、§7 的 2279b7b0 /
    // 753e080a / b695a35f 三段实测。ms 约定：北京 09-01T00:00:00+08:00 =
    // UTC 2026-08-31T16:00:00Z = 1_788_192_000_000（其余类推）。

    fn real_world_cs(start_ms: i64, cr_total: i64) -> Value {
        json!({
            "type": "cost-state",
            "timestamp": "2026-09-01T18:00:00.000Z",
            "startTime": start_ms,
            "modelUsage": {"deepseek-v4-flash": {
                "inputTokens": 0, "outputTokens": 0,
                "cacheReadInputTokens": cr_total,
                "cacheCreationInputTokens": 0,
                "webSearchRequests": 0, "costUSD": 0.0}},
            "hasUnknownModelCost": false,
        })
    }

    fn real_world_row(ts_z: &str, cr: i64) -> Value {
        json!({
            "type": "assistant", "timestamp": ts_z,
            "message": {"model": "deepseek-v4-flash", "usage": {
                "input_tokens": 0, "cache_read_input_tokens": cr,
                "cache_creation_input_tokens": 0, "output_tokens": 0}},
        })
    }

    fn build_real_world_session(start_ms: i64, cr_total: i64,
                                 row_pairs: &[(&str, i64)]) -> Map<String, Value> {
        let mut sess = Map::new();
        let recs: Vec<Value> =
            std::iter::once(real_world_cs(start_ms, cr_total))
                .chain(row_pairs.iter().map(|(t, c)| real_world_row(t, *c)))
                .collect();
        for rec in &recs {
            apply_record(&mut sess, rec, "test-sid", "ns-placeholder", "default");
        }
        sess
    }

    /// 2279b7b0：startTime 北京 09-01、baseline 38.7M、rows 5.7M（4 行 09-02）。
    /// 旧算法把 baseline 整段塞进 09-01（错）；新算法：tail_days[09-02] = 5.7M，
    /// baseline - 行和 = 33M 进 unaccounted，09-01 / 08-31 都不出现。
    #[test]
    fn real_world_2279b7b0_baseline_minus_tail_lands_in_unaccounted() {
        let start_0901_bj: i64 = 1_788_192_000_000;
        let rows = [
            ("2026-09-02T03:00:00.000Z", 1_500_000_i64),
            ("2026-09-02T05:00:00.000Z", 1_500_000),
            ("2026-09-02T07:00:00.000Z", 1_500_000),
            ("2026-09-02T09:00:00.000Z", 1_200_000),
        ];
        let sess = build_real_world_session(start_0901_bj, 38_700_000, &rows);
        assert!(!sess.contains_key("baseline_day"),
                "v0.6.x 热修撤掉的旧路径：baseline 不再进 baseline_day");
        assert_eq!(
            sess.get("tail_days").unwrap()
                .get("2026-09-02").unwrap()
                .get("deepseek-v4-flash").unwrap()
                .get("cache_read_input_tokens"),
            Some(&json!(5_700_000)),
            "rows 按真实 ts 归 09-02，不是被吞也不是摊给某一天"
        );
        let mut sessions = Map::new();
        sessions.insert("s1".to_string(), Value::Object(sess));
        let (ledger, archive, unaccounted) =
            rebuild_days(&Value::Object(sessions), "2026-09");
        assert_eq!(
            ledger.get("2026-09-02").unwrap()
                .get("deepseek-v4-flash").unwrap()
                .get("cache_read_input_tokens"),
            Some(&json!(5_700_000))
        );
        assert_eq!(
            unaccounted.get("deepseek-v4-flash").unwrap()
                .get("cache_read_input_tokens"),
            Some(&json!(33_000_000)),
            "baseline 38.7M - 行和 5.7M = 33M 残差，不在任何一天"
        );
        assert!(ledger.get("2026-09-01").is_none(),
                "旧算法 bug 反向断言：09-01 不应再吃这条 session 的账");
        assert!(ledger.get("2026-08-31").is_none());
        assert!(archive.is_empty(),
                "当前月=2026-09、09-02 也在当月，无日子需要归档");
    }
    /// 同款规律：tail_days[09-02] = 44.9M、unaccounted = 92.2M。
    #[test]
    fn real_world_753e080a_same_pattern_larger_volume() {
        let start_0901_bj_mid: i64 = 1_788_235_200_000;
        let row_cr: i64 = 5_612_500; // × 8 = 44_900_000
        let rows = [
            ("2026-09-02T03:00:00.000Z", row_cr),
            ("2026-09-02T05:00:00.000Z", row_cr),
            ("2026-09-02T07:00:00.000Z", row_cr),
            ("2026-09-02T09:00:00.000Z", row_cr),
            ("2026-09-02T11:00:00.000Z", row_cr),
            ("2026-09-02T13:00:00.000Z", row_cr),
            ("2026-09-02T14:00:00.000Z", row_cr),
            ("2026-09-02T15:00:00.000Z", row_cr),
        ];
        let sess = build_real_world_session(start_0901_bj_mid, 137_100_000, &rows);
        assert_eq!(
            sess.get("tail_days").unwrap()
                .get("2026-09-02").unwrap()
                .get("deepseek-v4-flash").unwrap()
                .get("cache_read_input_tokens"),
            Some(&json!(44_900_000))
        );
        let mut sessions = Map::new();
        sessions.insert("s1".to_string(), Value::Object(sess));
        let (ledger, _archive, unaccounted) =
            rebuild_days(&Value::Object(sessions), "2026-09");
        assert_eq!(
            ledger.get("2026-09-02").unwrap()
                .get("deepseek-v4-flash").unwrap()
                .get("cache_read_input_tokens"),
            Some(&json!(44_900_000))
        );
        assert_eq!(
            unaccounted.get("deepseek-v4-flash").unwrap()
                .get("cache_read_input_tokens"),
            Some(&json!(92_200_000))
        );
    }

    /// b695a35f：startTime 北京 08-31、baseline 88.3M、rows 16.0M（4 行 09-02）。
    /// 旧算法把 baseline 整段塞进 08-31（错）；新算法：08-31 不出现，
    /// unaccounted = 72.3M。
    #[test]
    fn real_world_b695a35f_baseline_starttime_08_31_no_day_bucket() {
        let start_0831_bj_eve: i64 = 1_788_170_400_000;
        let rows = [
            ("2026-09-02T03:00:00.000Z", 4_000_000_i64),
            ("2026-09-02T05:00:00.000Z", 4_000_000),
            ("2026-09-02T07:00:00.000Z", 4_000_000),
            ("2026-09-02T09:00:00.000Z", 4_000_000),
        ];
        let sess = build_real_world_session(start_0831_bj_eve, 88_300_000, &rows);
        let mut sessions = Map::new();
        sessions.insert("s1".to_string(), Value::Object(sess));
        let (ledger, _archive, unaccounted) =
            rebuild_days(&Value::Object(sessions), "2026-09");
        assert_eq!(
            ledger.get("2026-09-02").unwrap()
                .get("deepseek-v4-flash").unwrap()
                .get("cache_read_input_tokens"),
            Some(&json!(16_000_000))
        );
        assert_eq!(
            unaccounted.get("deepseek-v4-flash").unwrap()
                .get("cache_read_input_tokens"),
            Some(&json!(72_300_000))
        );
        assert!(ledger.get("2026-08-31").is_none(),
                "旧算法 bug 反向断言：08-31 不应再有这条 session 的任何桶");
    }

    /// 三段实测合并：tail_days[09-02] = 5.7+44.9+16.0 = 66.6M cache_read；
    /// unaccounted = 33+92.2+72.3 = 197.5M cache_read ——spec §5 后段点名的
    /// 真机验收数字，单测一旦回归立刻红。
    #[test]
    fn real_world_three_sessions_combined_unaccounted_is_197_5_m() {
        let sessions = json!({
            "2279b7b0": Value::Object(build_real_world_session(
                1_788_192_000_000_i64, 38_700_000, &[
                    ("2026-09-02T03:00:00.000Z", 1_500_000_i64),
                    ("2026-09-02T05:00:00.000Z", 1_500_000),
                    ("2026-09-02T07:00:00.000Z", 1_500_000),
                    ("2026-09-02T09:00:00.000Z", 1_200_000),
                ])),
            "753e080a": Value::Object(build_real_world_session(
                1_788_235_200_000_i64, 137_100_000, &[
                    ("2026-09-02T03:00:00.000Z", 11_225_000_i64),
                    ("2026-09-02T05:00:00.000Z", 11_225_000),
                    ("2026-09-02T07:00:00.000Z", 11_225_000),
                    ("2026-09-02T09:00:00.000Z", 11_225_000),
                ])),
            "b695a35f": Value::Object(build_real_world_session(
                1_788_170_400_000_i64, 88_300_000, &[
                    ("2026-09-02T03:00:00.000Z", 4_000_000_i64),
                    ("2026-09-02T05:00:00.000Z", 4_000_000),
                    ("2026-09-02T07:00:00.000Z", 4_000_000),
                    ("2026-09-02T09:00:00.000Z", 4_000_000),
                ])),
        });
        let (ledger, archive, unaccounted) = rebuild_days(&sessions, "2026-09");
        assert_eq!(
            ledger.get("2026-09-02").unwrap()
                .get("deepseek-v4-flash").unwrap()
                .get("cache_read_input_tokens"),
            Some(&json!(66_600_000)),
            "5.7 + 44.9 + 16.0 = 66.6M cache_read 正确归 09-02"
        );
        assert_eq!(
            unaccounted.get("deepseek-v4-flash").unwrap()
                .get("cache_read_input_tokens"),
            Some(&json!(197_500_000)),
            "33 + 92.2 + 72.3 = 197.5M cache_read 进 unaccounted（spec §5 后段点名数字）"
        );
        assert!(ledger.get("2026-09-01").is_none());
        assert!(ledger.get("2026-08-31").is_none());
        assert!(archive.is_empty(),
                "当前月=2026-09、09-02 也在当月，无日子需要归档");
    }
}
