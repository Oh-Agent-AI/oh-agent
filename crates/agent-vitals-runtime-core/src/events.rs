//! 事件总线的 runtime 侧（AGENT_VITALS_EVENT_BUS_ARCHITECTURE_SPEC）。
//!
//! 职责三件，全部围绕「事实的过去时陈述」：
//! 1. [`insert_outbox`] —— 把事件行写进**调用方持有的事务**（与状态变更同
//!    事务提交；本模块永远不自己开事务，那是双写分叉的入口）；
//! 2. [`EVENT_TYPES`] —— 闭集词表。写入与投递两侧都校验；新事件类型先在
//!    规格 §5 登记再加进来（与分类图谱「先登记后写 emitter」同纪律）；
//! 3. [`Dispatcher`] —— 按消费者反连接扫描未投递事件并执行（at-least-once，
//!    幂等键 = `(event_id, consumer_id)`，由 `event_deliveries` 承载）。
//!
//! 投递语义（spec §4.3）：本进程是「事务后显式唤醒 + 周期兜底」；崩溃恢复
//! 靠下一次 drain 重扫 `event_deliveries` 缺行——与 `PARSER_VERSION` 幂等重
//! 放同构。`payload` 只装枚举值、计数与时间戳；原始路径/内容/凭据类字段与
//! `TrustObservation` 同一禁令（spec §4.1）。

use rusqlite::Connection;
use serde_json::{json, Value};

use agent_vitals_domain::source_identity::fnv1a64_hex;
use crate::clock::now_ms;

/// 事件契约版本。与 authority schema 演进纪律同款：只增不删不改语义。
pub const EVENT_SCHEMA_VERSION: i64 = 1;

/// 事件类别（RUNTIME_INVALIDATION spec §4.2）。`Domain` = 业务状态的过去时陈述，
/// 给领域消费者逐条处理；`Audit` = 审计旁路。**没有 `Invalidation` 类**——失效
/// 信号不是 outbox 行，它由 drain 末尾读权威 revision 派生（[`Invalidation`]）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EventClass {
    Domain,
    Audit,
}

/// 闭集词表（spec §5 首批冻结）+ 类别。写入侧与投递侧双双校验——词表外的
/// `event_type` 在 insert 时被拒绝，防漂移进无人认识的行。
///
/// `AuthorityRevisionAdvanced` 是**保留位**（RUNTIME_INVALIDATION spec §4.4）：它若逐次
/// 落 outbox 就违反「失效信号是派生投影」；留在词表只为不打破闭集校验的历史行。
pub const EVENT_TYPES: &[(&str, EventClass)] = &[
    ("FactsIngested", EventClass::Domain),
    ("AuthorityRevisionAdvanced", EventClass::Domain),
    ("DeclarationSaved", EventClass::Domain),
    ("PriceCardSaved", EventClass::Domain),
    ("HarnessSourceFailed", EventClass::Domain),
    ("SourceRecovered", EventClass::Domain),
    ("McpToolInvoked", EventClass::Audit),
    ("TrustMonitorEvent", EventClass::Domain),
    ("HourTicked", EventClass::Domain),
    ("DayRolled", EventClass::Domain),
];

/// 词表查询：类型 → 类别（词表外 = `None`）。
pub fn event_class(event_type: &str) -> Option<EventClass> {
    EVENT_TYPES
        .iter()
        .find(|(t, _)| *t == event_type)
        .map(|(_, c)| *c)
}

/// 词表查询：类型 → `&'static str`（leak-free 地从闭集取回）。
fn static_type(event_type: &str) -> Option<&'static str> {
    EVENT_TYPES.iter().find(|(t, _)| *t == event_type).map(|(t, _)| *t)
}

/// 一条事件的信封（spec §4.1 冻结形状）。
#[derive(Clone, Debug, PartialEq)]
pub struct AppEvent {
    pub event_type: &'static str,
    pub occurred_at_ms: i64,
    /// 执行环境域事件携带；全局事件（计时器等）为 `None`。
    pub harness: Option<String>,
    /// 来源批次（sync_runs.run_id / IPC 序列），可空。
    pub correlation_id: Option<String>,
    pub producer: &'static str,
    pub payload: Value,
}

impl AppEvent {
    /// `McpToolInvoked`：一次外部 MCP `tools/call` 完成（审计旁路，
    /// fire-and-forget）。生产者是 serve 传输层而非 dispatch 本身——桌面/CLI
    /// 的内部自用调用不是审计对象（spec §5 实施修订）。`args_fingerprint`
    /// 是参数的规范化指纹：**原始参数永不落库**（§4.1 禁令，agents 的查询
    /// 参数可能含敏感内容）。
    pub fn mcp_tool_invoked(
        tool: &str, args_fingerprint: &str, latency_ms: i64, ok: bool, call_seq: u64,
    ) -> Self {
        Self {
            event_type: "McpToolInvoked",
            occurred_at_ms: now_ms(),
            harness: None,
            // 进程内调用序号：event_id 唯一性材料（同毫秒同参数的重复调用不得
            // 互吞——审计日志不允许静默少计）+ 消费方的进程内顺序信号。
            correlation_id: Some(call_seq.to_string()),
            producer: "mcp-serve",
            payload: json!({
                "tool": tool,
                "args_fingerprint": args_fingerprint,
                "latency_ms": latency_ms,
                "ok": ok,
            }),
        }
    }

    /// `TrustMonitorEvent`：一次 trust 传感运行完成（观察已入库、Finding 已
    /// 评价——correlate **留在同一事务内联**，事件是通知不是指令，拆出去会
    /// 丢失 correlate 对自身写入的原子可见性）。这是 P2 常驻传感器的既定通道：
    /// 快照模式（今日）与常驻 watcher（P2）发同一事件，桌面转发/刷新逻辑零
    /// 改动。载荷为**批次摘要计数**——spec §5 原草图（actor/stage/evidence_level
    /// 单观察级）勘正：事件是运行级通知，单观察明细在 trust_observations 里。
    pub fn trust_monitor_event(
        run_id: &str, observations: usize, inserted: usize, findings_upserted: usize,
    ) -> Self {
        Self {
            event_type: "TrustMonitorEvent",
            occurred_at_ms: now_ms(),
            harness: None,
            correlation_id: Some(run_id.to_string()),
            producer: "trust-runtime-monitor",
            payload: json!({
                "run_id": run_id,
                "observations": observations,
                "inserted": inserted,
                "findings_upserted": findings_upserted,
            }),
        }
    }

    /// `FactsIngested`：某执行环境的事实批次已在权威库事务内落定。
    ///
    /// `revision` = 本事务**提交后**的权威 revision（spec §5 声明的
    /// `FactsIngested{harness, run_id, revision}`）。生产者在事务内读当前值 + 1
    /// （事务已插入事实，提交必然推进）；领域消费者可据此跳过 ≤ 已处理 revision 的批次。
    pub fn facts_ingested(
        harness: &str, run_id: &str, revision: u64,
        inserted: usize, rejected: usize, duplicate: usize,
    ) -> Self {
        Self {
            event_type: "FactsIngested",
            occurred_at_ms: now_ms(),
            harness: Some(harness.to_string()),
            correlation_id: Some(run_id.to_string()),
            producer: "sync_service",
            // inserted / rejected / duplicate 三个计数分开（独立验证发现：此前
            // 把 rejected 并进 inserted 是契约漂移——payload 字段名必须与语义
            // 一致，消费者迟早会读它们）。
            payload: json!({
                "run_id": run_id, "revision": revision, "inserted": inserted,
                "rejected": rejected, "duplicate": duplicate,
            }),
        }
    }

    fn event_id(&self) -> String {
        // 身份 = 类型 + 事实键（时间戳 + correlation + payload 指纹）。同一次
        // 事实（同 run_id、同计数）重放得到同一 event_id → INSERT OR IGNORE
        // 吸收，生产者侧幂等不需要额外协议。
        // 材料包含 harness（独立验证发现）：同类型、同毫秒、同 correlation 的
        // 两个不同执行环境事件必须互不吸收——计时器类事件（correlation 为 NULL）
        // 尤其依赖这一维度。
        let material = format!(
            "{}\0{}\0{}\0{}\0{}",
            self.event_type,
            self.harness.as_deref().unwrap_or(""),
            self.occurred_at_ms,
            self.correlation_id.as_deref().unwrap_or(""),
            self.payload,
        );
        format!("event:{}", fnv1a64_hex(material.as_bytes()))
    }
}

#[derive(Debug)]
pub enum EventError {
    UnknownType(String),
    Db(rusqlite::Error),
}

impl std::fmt::Display for EventError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EventError::UnknownType(t) => {
                write!(f, "event type `{t}` not in the frozen vocabulary (spec §5)")
            }
            EventError::Db(e) => write!(f, "event outbox write failed: {e}"),
        }
    }
}

/// 把事件写进调用方持有的事务。**本函数不开事务、不提交**——调用方必须
/// 在与状态变更相同的 `with_immediate_txn` 里调它（spec §1.2）。
pub fn insert_outbox(conn: &Connection, event: &AppEvent, run_id: &str) -> Result<(), EventError> {
    if event_class(event.event_type).is_none() {
        return Err(EventError::UnknownType(event.event_type.to_string()));
    }
    conn.execute(
        "INSERT OR IGNORE INTO event_outbox(
             event_id, event_type, schema_version, occurred_at_ms, harness,
             correlation_id, producer, payload_json, ingested_run_id, created_at_ms)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        rusqlite::params![
            event.event_id(),
            event.event_type,
            EVENT_SCHEMA_VERSION,
            event.occurred_at_ms,
            event.harness,
            event.correlation_id,
            event.producer,
            event.payload.to_string(),
            run_id,
            now_ms(),
        ],
    )
    .map(|_| ())
    .map_err(EventError::Db)
}

/// 消费者角色（RUNTIME_INVALIDATION spec §4.2）。
///
/// - `Domain`：读领域事件载荷，逐条处理（price-reconcile / quota / issue 评估器）；
/// - `Audit`：读审计事件；
/// - `Presentation`：展示层。**结构上拿不到载荷**——只能以 [`CoalescingConsumer`]
///   身份参与 drain，得到「本轮有哪些类型 / 哪些执行环境 / 多少条」的合并摘要，
///   再由 flush 派生失效信号。用 [`EventConsumer`] 声明 `Presentation` 角色在
///   `Dispatcher::new` 被拒绝。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConsumerRole {
    Domain,
    Presentation,
    Audit,
}

/// 消费者兴趣集：角色 + 订阅的类型子集（空 = 该角色允许的全部类别）。drain 的反连接
/// SQL 按此过滤，不再每个消费者扫全表。
#[derive(Clone, Copy, Debug)]
pub struct ConsumerInterest {
    pub role: ConsumerRole,
    pub types: &'static [&'static str],
}

impl ConsumerInterest {
    pub const fn domain(types: &'static [&'static str]) -> Self {
        Self { role: ConsumerRole::Domain, types }
    }
    pub const fn audit(types: &'static [&'static str]) -> Self {
        Self { role: ConsumerRole::Audit, types }
    }
    /// 展示层：无类型子集（它不读载荷，只需要看到 Domain 类的行以合并摘要）。
    pub const fn presentation() -> Self {
        Self { role: ConsumerRole::Presentation, types: &[] }
    }

    fn allowed_class(&self) -> EventClass {
        match self.role {
            ConsumerRole::Domain | ConsumerRole::Presentation => EventClass::Domain,
            ConsumerRole::Audit => EventClass::Audit,
        }
    }

    /// 展开为具体类型清单（校验后调用；每项都在词表且属允许类别）。
    fn resolved_types(&self) -> Vec<&'static str> {
        if self.types.is_empty() {
            let class = self.allowed_class();
            EVENT_TYPES.iter().filter(|(_, c)| *c == class).map(|(t, _)| *t).collect()
        } else {
            self.types.iter().filter_map(|t| static_type(t)).collect()
        }
    }

    fn validate(&self, coalescing: bool, consumer_id: &str) -> Result<(), RoleViolation> {
        match self.role {
            ConsumerRole::Presentation => {
                if !coalescing {
                    return Err(RoleViolation {
                        consumer_id: consumer_id.to_string(),
                        reason: "presentation consumers never read payloads — register a CoalescingConsumer".into(),
                    });
                }
                if !self.types.is_empty() {
                    return Err(RoleViolation {
                        consumer_id: consumer_id.to_string(),
                        reason: format!("presentation consumers take no type subset (got {:?})", self.types),
                    });
                }
            }
            ConsumerRole::Domain | ConsumerRole::Audit => {
                let class = self.allowed_class();
                for t in self.types {
                    match event_class(t) {
                        Some(c) if c == class => {}
                        Some(c) => {
                            return Err(RoleViolation {
                                consumer_id: consumer_id.to_string(),
                                reason: format!("`{t}` is {c:?}-class, not allowed for {:?} role", self.role),
                            })
                        }
                        None => {
                            return Err(RoleViolation {
                                consumer_id: consumer_id.to_string(),
                                reason: format!("`{t}` is not in the frozen vocabulary"),
                            })
                        }
                    }
                }
            }
        }
        Ok(())
    }
}

/// 兴趣集与角色的冲突：`Dispatcher::new` 拒绝（spec 验收 9.3）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoleViolation {
    pub consumer_id: String,
    pub reason: String,
}

impl std::fmt::Display for RoleViolation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "consumer `{}`: {}", self.consumer_id, self.reason)
    }
}

/// 一个消费者：稳定 id + 兴趣集 + 处理函数。处理函数拿到的是**已脱离数据库行**的
/// 事件投影。**禁止**在处理函数里使用 drain 正在遍历的那条连接——消费者自
/// 持资源（如按路径自开 AuthorityDb）；drain 在自动提交模式下逐行调用，
/// 不持事务（spec §6「先处理、后记账」的崩溃语义依赖这一点）。
pub type EventHandler = Box<dyn Fn(&AppEvent) -> Result<(), String> + Send + Sync>;

pub struct EventConsumer {
    pub consumer_id: &'static str,
    pub interest: ConsumerInterest,
    pub handle: EventHandler,
}

impl EventConsumer {
    pub fn new(
        consumer_id: &'static str,
        interest: ConsumerInterest,
        handle: impl Fn(&AppEvent) -> Result<(), String> + Send + Sync + 'static,
    ) -> Self {
        Self { consumer_id, interest, handle: Box::new(handle) }
    }
}

/// 一轮 drain 里某个合并型消费者看到的摘要——**没有载荷**。这是展示层拿不到
/// 领域事件内容的结构保证（不靠评审）。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Coalesced {
    /// 本轮 fold 成功的事件数。
    pub events: usize,
    /// 触及的执行环境（执行环境域事件才有；全局事件不贡献）。
    pub harnesses: std::collections::BTreeSet<String>,
    /// 触及的事件类型。
    pub types: std::collections::BTreeSet<&'static str>,
}

/// 合并型消费者（RUNTIME_INVALIDATION spec §4.3）：drain 内逐事件累积 [`Coalesced`]
/// （deliveries **仍逐事件记账**，at-least-once 一字不动），drain 结束时若累积到
/// ≥1 条则调 `flush` **一次**。副作用被合并，投递没有。
///
/// flush 在记账之后：崩溃于 flush 前，事件已记账、这轮的合并摘要丢失——对失效
/// 信号是可接受的（电平语义：下一轮 drain 或页面挂载时的主动拉会重新对齐）；
/// 反过来先 flush 后记账会在崩溃时重复投递领域事件，不可接受。
pub type FlushHandler = Box<dyn Fn(Coalesced) + Send + Sync>;

pub struct CoalescingConsumer {
    pub consumer_id: &'static str,
    pub interest: ConsumerInterest,
    pub flush: FlushHandler,
}

impl CoalescingConsumer {
    pub fn new(
        consumer_id: &'static str,
        interest: ConsumerInterest,
        flush: impl Fn(Coalesced) + Send + Sync + 'static,
    ) -> Self {
        Self { consumer_id, interest, flush: Box::new(flush) }
    }
}

enum ConsumerKind {
    Plain(EventConsumer),
    Coalescing(CoalescingConsumer),
}

impl ConsumerKind {
    fn consumer_id(&self) -> &'static str {
        match self {
            ConsumerKind::Plain(c) => c.consumer_id,
            ConsumerKind::Coalescing(c) => c.consumer_id,
        }
    }
    fn interest(&self) -> ConsumerInterest {
        match self {
            ConsumerKind::Plain(c) => c.interest,
            ConsumerKind::Coalescing(c) => c.interest,
        }
    }
}

/// 一轮投递的报表（诊断面与测试用）。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DispatchReport {
    pub delivered: usize,
    /// 处理函数返回 Err 的行数——投递照记（带 last_error），下一轮不重试
    /// 本事件（at-least-once 的「至少一次」已满足；重试语义属于消费者）。
    pub failed: usize,
    /// 其中是重试投递的次数（非首次失败后的再次尝试）。
    pub retried: usize,
    /// 词表/schema_version 不认识的行（前向兼容：只跳过并计数）。
    pub skipped: usize,
    /// 合并型消费者的 flush 次数（每消费者每轮 ≤ 1）。
    pub flushed: usize,
}

/// 事件分发器：按消费者反连接扫描 outbox 并执行。
///
/// P0 形态（spec §9）：**事务后显式 drain**——CLI 同步尾部调用一次，新事件
/// 与崩溃残留（deliveries 缺行）在同一轮补齐。唤醒通道与 update_hook 快路
/// 属于 P1 桌面常驻 dispatcher 的接线，此处不实现（避免无消费者的死线程）。
pub struct Dispatcher {
    consumers: Vec<ConsumerKind>,
}

impl Dispatcher {
    /// 只有领域/审计消费者时的构造（无合并型）。角色与兴趣集在此校验。
    pub fn new(consumers: Vec<EventConsumer>) -> Result<Self, RoleViolation> {
        Self::with_coalescing(consumers, Vec::new())
    }

    /// 领域/审计消费者 + 合并型消费者。
    pub fn with_coalescing(
        consumers: Vec<EventConsumer>,
        coalescing: Vec<CoalescingConsumer>,
    ) -> Result<Self, RoleViolation> {
        let mut all = Vec::with_capacity(consumers.len() + coalescing.len());
        for c in consumers {
            c.interest.validate(false, c.consumer_id)?;
            all.push(ConsumerKind::Plain(c));
        }
        for c in coalescing {
            c.interest.validate(true, c.consumer_id)?;
            all.push(ConsumerKind::Coalescing(c));
        }
        Ok(Self { consumers: all })
    }

    /// 兴趣集展开成 SQL `IN (...)` 字面量列表。值来自闭集词表常量（已校验），
    /// 不是用户输入，故可以内联；空清单返回 `('')`（匹配不到任何行）。
    fn types_in_clause(interest: &ConsumerInterest) -> String {
        let types = interest.resolved_types();
        if types.is_empty() {
            return "('')".to_string();
        }
        let quoted: Vec<String> = types.iter().map(|t| format!("'{t}'")).collect();
        format!("({})", quoted.join(", "))
    }

    /// 扫描并投递所有 `(event, consumer)` 缺行组合。逐事件逐消费者执行：
    /// 查（反连接）→ 调 handler（自持连接）→ 记账——处理成功才写
    /// deliveries，崩溃于两者之间表现为「未投递」，下一轮重扫（幂等键语义，
    /// spec §1.7）。**不要包在 `with_immediate_txn` 里调**：handler 需要能自
    /// 开连接写库，本方法自身只做自动提交级的单语句读写。
    pub fn drain(&self, conn: &Connection) -> Result<DispatchReport, rusqlite::Error> {
        let mut report = DispatchReport::default();
        for consumer in &self.consumers {
            let consumer_id = consumer.consumer_id();
            let interest = consumer.interest();
            // 兴趣集过滤进 SQL：不订阅的类型连行都不物化、不记账（spec 验收 9.4）。
            let sql = format!(
                "SELECT o.event_id, o.event_type, o.schema_version, o.occurred_at_ms, o.harness,
                        o.correlation_id, o.producer, o.payload_json,
                        COALESCE(d.retry_count, 0)
                 FROM event_outbox o
                 LEFT JOIN event_deliveries d
                   ON d.event_id = o.event_id AND d.consumer_id = ?1
                 WHERE o.event_type IN {}
                   AND (d.event_id IS NULL
                    OR (d.last_error IS NOT NULL
                        AND d.retry_count < ?2
                        AND COALESCE(d.next_retry_at_ms, 0) <= ?3))
                 ORDER BY o.created_at_ms, o.event_id",
                Self::types_in_clause(&interest)
            );
            let mut stmt = conn.prepare(&sql)?;
            let now = now_ms();
            let rows = stmt.query_map(
                rusqlite::params![consumer_id, MAX_RETRIES, now],
                |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, i64>(8)?,
                ))
            })?;
            // **先完整物化、关游标，再处理**（2026-09-21 真机验证发现）：懒迭代
            // 会把读快照一直握到 handler 与记账之后——handler 经自持连接提交写入
            // 后，本连接的快照已过期，record_delivery 从读升级为写会撞
            // SQLITE_BUSY（busy_timeout 无效：过期快照在游标关闭前永不自愈）。
            // 物化后每条 INSERT 是独立自动提交事务，且不再边扫边写同一连接。
            let pending: Vec<_> = rows.collect::<Result<Vec<_>, _>>()?;
            drop(stmt);
            let mut coalesced = Coalesced::default();
            for row in pending {
                let (event_id, event_type, schema_version, occurred_at_ms, harness,
                     correlation_id, _producer, payload_json, prior_retries) = row;
                // 前向兼容：未来的 schema_version / 词表外类型只跳过并计数，
                // 不让一条不认识的行卡住整个队列（spec §10.7 的闭集校验是
                // 「拒绝并计数」，不是崩溃）。
                let Some(static_event_type) = static_type(&event_type)
                    .filter(|_| schema_version <= EVENT_SCHEMA_VERSION)
                else {
                    record_delivery(conn, &event_id, consumer_id, now_ms(),
                        Some("skipped: unknown event_type or newer schema_version".to_string()))?;
                    report.skipped += 1;
                    continue;
                };
                let error = match consumer {
                    ConsumerKind::Plain(c) => {
                        let event = AppEvent {
                            event_type: static_event_type,
                            occurred_at_ms,
                            harness,
                            correlation_id,
                            producer: "",
                            payload: serde_json::from_str(&payload_json).unwrap_or(Value::Null),
                        };
                        (c.handle)(&event)
                    }
                    ConsumerKind::Coalescing(_) => {
                        // 只累积头部字段；载荷字符串在此被丢弃，永不解析。
                        coalesced.events += 1;
                        coalesced.types.insert(static_event_type);
                        if let Some(h) = harness {
                            coalesced.harnesses.insert(h);
                        }
                        Ok(())
                    }
                };
                let error = match error {
                    Ok(()) => {
                        report.delivered += 1;
                        None
                    }
                    Err(message) => {
                        report.failed += 1;
                        if prior_retries > 0 {
                            report.retried += 1;
                        }
                        Some(message)
                    }
                };
                record_delivery(conn, &event_id, consumer_id, now_ms(), error)?;
            }
            if let ConsumerKind::Coalescing(c) = consumer {
                if coalesced.events > 0 {
                    (c.flush)(coalesced);
                    report.flushed += 1;
                }
            }
        }
        Ok(report)
    }
}

// ---- 失效信号与「变了才发」原语（RUNTIME_INVALIDATION spec §4.4 / §4.5）----

/// 展示层的失效信号：权威 revision + 本轮 drain 触及的执行环境（**下界**，不是精确集——
/// drain 时读到的 revision 可能超前于本轮 fold 的事件，spec §4.4 顺序注记）。
/// 它不是 outbox 行；由 `CoalescingConsumer::flush` 派生、经
/// [`ChangePublisher::publish_if_advanced`] 发射。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Invalidation {
    pub revision: u64,
    pub harnesses: std::collections::BTreeSet<String>,
}

/// 「变了才发」发布器：进程内保存上次发布值，与之不同才调 `emit`。锁内只比较与
/// 替换，`emit` 在锁外（持锁 emit 会拖住热插拔——HARDENING 验收 I-1）。
/// 进程启动时 `last = None`，首次必发——正好覆盖「窗口先开、tick 后到」与
/// 「webview 未就绪时 emit 是空操作」的丢失窗口（重启重发一次无害）。
pub struct ChangePublisher<T: PartialEq + Clone> {
    last: std::sync::Mutex<Option<T>>,
}

impl<T: PartialEq + Clone> Default for ChangePublisher<T> {
    fn default() -> Self {
        Self { last: std::sync::Mutex::new(None) }
    }
}

impl<T: PartialEq + Clone> ChangePublisher<T> {
    pub fn new() -> Self {
        Self::default()
    }

    /// 与上次发布值不同才 `emit`；返回是否发布。
    pub fn publish_if_changed(&self, next: T, emit: impl FnOnce(&T)) -> bool {
        let changed = {
            let mut last = self.last.lock().unwrap_or_else(|e| e.into_inner());
            if last.as_ref() == Some(&next) {
                false
            } else {
                *last = Some(next.clone());
                true
            }
        };
        if changed {
            emit(&next);
        }
        changed
    }

    /// 上次发布的值（诊断面）。
    pub fn last(&self) -> Option<T> {
        self.last.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

impl ChangePublisher<Invalidation> {
    /// revision **严格前进**才发（`>` 而非 `!=`）。同 revision 再来一次——哪怕 harnesses
    /// 不同——也吞掉：harnesses 只是下界提示，revision 才是电平。
    pub fn publish_if_advanced(&self, next: Invalidation, emit: impl FnOnce(&Invalidation)) -> bool {
        let advanced = {
            let mut last = self.last.lock().unwrap_or_else(|e| e.into_inner());
            match last.as_ref() {
                Some(prev) if prev.revision >= next.revision => false,
                _ => {
                    *last = Some(next.clone());
                    true
                }
            }
        };
        if advanced {
            emit(&next);
        }
        advanced
    }
}

pub const MAX_RETRIES: i64 = 3;
const RETRY_BASE_MS: i64 = 30_000; // 30s → 1min → 2min → 穷尽后永久死信

fn record_delivery(
    conn: &Connection,
    event_id: &str,
    consumer_id: &str,
    at_ms: i64,
    error: Option<String>,
) -> Result<(), rusqlite::Error> {
    match &error {
        None => conn.execute(
            "INSERT INTO event_deliveries(event_id, consumer_id, delivered_at_ms, last_error, retry_count, next_retry_at_ms)
             VALUES (?1, ?2, ?3, NULL, 0, NULL)
             ON CONFLICT(event_id, consumer_id) DO UPDATE SET
               delivered_at_ms = excluded.delivered_at_ms,
               last_error = NULL, retry_count = 0, next_retry_at_ms = NULL",
            rusqlite::params![event_id, consumer_id, at_ms],
        ).map(|_| ()),
        Some(err) => {
            // 统一走 UPSERT：首插（retry_count 0→1）与重试失败（N→N+1）同一逻辑，
            // 退避 = at_ms + BASE * 2^(retry_count-1)。穷尽后 next_retry_at_ms = NULL
            // （永久死信——反连接不再发现，last_error 保留诊断）。
            let next_retry = at_ms + RETRY_BASE_MS;
            conn.execute(
                "INSERT INTO event_deliveries(event_id, consumer_id, delivered_at_ms, last_error, retry_count, next_retry_at_ms)
                 VALUES (?1, ?2, ?3, ?4, 1, ?5)
                 ON CONFLICT(event_id, consumer_id) DO UPDATE SET
                   delivered_at_ms = excluded.delivered_at_ms,
                   last_error = excluded.last_error,
                   retry_count = CASE WHEN event_deliveries.retry_count >= ?6
                     THEN event_deliveries.retry_count
                     ELSE event_deliveries.retry_count + 1 END,
                   next_retry_at_ms = CASE WHEN event_deliveries.retry_count + 1 >= ?6
                     THEN NULL
                     ELSE ?7 END",
                rusqlite::params![event_id, consumer_id, at_ms, err,
                                  next_retry, MAX_RETRIES, next_retry],
            ).map(|_| ())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_vitals_data::authority::AuthorityDb;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn tmp_db(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "avd-events-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ))
    }

    fn seed(db: &AuthorityDb) -> String {
        db.begin_run("run-1", "cli", 1).expect("seed run");
        "run-1".to_string()
    }

    fn db_err(e: EventError) -> agent_vitals_data::authority::AuthorityError {
        agent_vitals_data::authority::AuthorityError::Sqlite(
            rusqlite::Error::InvalidParameterName(format!("__event__:{e}")),
        )
    }

    fn emit(db: &AuthorityDb, event: &AppEvent, run_id: &str) {
        db.with_immediate_txn(|conn| insert_outbox(conn, event, run_id).map_err(db_err))
            .expect("emit event in txn");
    }

    /// 验收 #2：同一事件投递两次，消费者 no-op（幂等键生效）。
    #[test]
    fn drain_is_idempotent_per_consumer() {
        let path = tmp_db("idem");
        let db = AuthorityDb::open(&path, 1).expect("open");
        let run = seed(&db);
        let event = AppEvent::facts_ingested("zcode", &run, 1, 3, 0, 1);
        emit(&db, &event, &run);

        static CALLS: AtomicUsize = AtomicUsize::new(0);
        let dispatcher = Dispatcher::new(vec![EventConsumer::new("test-counter", ConsumerInterest::domain(&[]), |_| { CALLS.fetch_add(1, Ordering::SeqCst); Ok(()) },
        )]).expect("valid interest");
        let first = dispatcher.drain(db.conn()).expect("drain 1");
        let second = dispatcher.drain(db.conn()).expect("drain 2");
        assert_eq!((first.delivered, first.failed, first.skipped), (1, 0, 0));
        assert_eq!((second.delivered, second.failed, second.skipped), (0, 0, 0),
            "重复 drain 不得重复投递");
        assert_eq!(CALLS.load(Ordering::SeqCst), 1);
        drop(db);
        cleanup(&path);
    }

    /// 验收 #1（崩溃恢复等价）：事件落库后进程死亡（无 deliveries），
    /// 新 Dispatcher 重扫补投。
    #[test]
    fn crash_between_emit_and_deliver_recovers_on_next_drain() {
        let path = tmp_db("crash");
        let db = AuthorityDb::open(&path, 1).expect("open");
        let run = seed(&db);
        let event = AppEvent::facts_ingested("claude-code", &run, 1, 7, 0, 0);
        emit(&db, &event, &run);
        drop(db); // 模拟崩溃：事件已提交、投递未发生

        let db2 = AuthorityDb::open(&path, 1).expect("reopen");
        let dispatcher = Dispatcher::new(vec![EventConsumer::new("test-recovery", ConsumerInterest::domain(&[]), |_| Ok(()))]).expect("valid interest");
        let report = dispatcher.drain(db2.conn()).expect("recover");
        assert_eq!(report.delivered, 1, "崩溃残留事件由重开后的 drain 补投");
        drop(db2);
        cleanup(&path);
    }

    /// 词表外类型在写入侧被拒（闭集校验的前半）。
    #[test]
    fn unknown_event_type_is_rejected_at_insert() {
        let path = tmp_db("vocab");
        let db = AuthorityDb::open(&path, 1).expect("open");
        let run = seed(&db);
        let bad = AppEvent {
            event_type: "NotARealEvent",
            occurred_at_ms: 1,
            harness: None,
            correlation_id: None,
            producer: "test",
            payload: serde_json::json!({}),
        };
        let err = db.with_immediate_txn(|conn| insert_outbox(conn, &bad, &run).map_err(db_err));
        let message = format!("{err:?}");
        assert!(message.contains("NotARealEvent"), "词表外类型要被拒绝: {message}");
        drop(db);
        cleanup(&path);
    }

    /// 消费者失败：投递照记（带 last_error），下一轮不重试本事件。
    #[test]
    fn failed_handler_records_error_and_does_not_retry() {
        let path = tmp_db("fail");
        let db = AuthorityDb::open(&path, 1).expect("open");
        let run = seed(&db);
        let event = AppEvent::facts_ingested("dsh", &run, 1, 1, 0, 0);
        emit(&db, &event, &run);
        let dispatcher = Dispatcher::new(vec![EventConsumer::new("test-failer", ConsumerInterest::domain(&[]), |_| Err("boom".to_string()))]).expect("valid interest");
        let first = dispatcher.drain(db.conn()).expect("drain 1");
        let second = dispatcher.drain(db.conn()).expect("drain 2");
        assert_eq!((first.delivered, first.failed), (0, 1));
        assert_eq!((second.delivered, second.failed), (0, 0), "失败行不重试");
        let last_error: String = db.conn().query_row(
            "SELECT COALESCE(last_error, '') FROM event_deliveries",
            [], |r| r.get(0),
        ).expect("read error");
        assert!(last_error.contains("boom"), "回收原因留痕（spec §12.1-5）: {last_error}");
        drop(db);
        cleanup(&path);
    }

    /// 527d480 的回归钉子（终验建议）：handler 经**第二连接**提交写入后，
    /// drain 连接继续记账——旧实现的懒迭代把读快照握过 handler 提交点，
    /// record_delivery 的读→写升级撞过期快照 SQLITE_BUSY（busy_timeout 对
    /// 过期快照无效）；物化实现必须无错通过。真机 2026-09-21 首次暴露。
    #[test]
    fn drain_survives_handler_writing_via_second_connection() {
        let path = tmp_db("wal-snapshot");
        let db = AuthorityDb::open(&path, 1).expect("open");
        let run = seed(&db);
        let event = AppEvent::facts_ingested("codex", &run, 1, 5, 0, 0);
        emit(&db, &event, &run);

        // handler 自持第二条连接并提交一次真实写入（模拟 price-reconcile
        // 开自己的 AuthorityDb 写 data_quality_issues 的生产形态）。
        let writer_path = path.clone();
        let dispatcher = Dispatcher::new(vec![EventConsumer::new("second-conn-writer", ConsumerInterest::domain(&[]), move |_event| {
                let writer = AuthorityDb::open(&writer_path, 1_700_000_000_001)
                    .map_err(|e| e.to_string())?;
                writer
                    .begin_run("handler-side-write", "cli", 1_700_000_000_002)
                    .map_err(|e| e.to_string())
            },
        )]).expect("valid interest");
        let report = dispatcher
            .drain(db.conn())
            .expect("物化 drain 不得因 handler 的第二连接写入而死锁");
        assert_eq!((report.delivered, report.failed, report.skipped), (1, 0, 0));
        // 记账与 handler 写入都真实落库。
        let deliveries: i64 = db.conn().query_row(
            "SELECT COUNT(*) FROM event_deliveries WHERE consumer_id = 'second-conn-writer'",
            [], |r| r.get(0),
        ).unwrap();
        assert_eq!(deliveries, 1);
        let side_write: i64 = db.conn().query_row(
            "SELECT COUNT(*) FROM sync_runs WHERE run_id = 'handler-side-write'",
            [], |r| r.get(0),
        ).unwrap();
        assert_eq!(side_write, 1, "handler 的第二连接写入必须可见");
        drop(db);
        cleanup(&path);
    }

    /// FactsIngested 端到端：构造器 → 事务内发射 → outbox 行 → drain → 消费者
    /// 收到完整载荷 → deliveries 记录。
    #[test]
    fn facts_ingested_end_to_end() {
        let path = tmp_db("e2e-facts");
        let db = AuthorityDb::open(&path, 1).expect("open");
        let run = seed(&db);
        let event = AppEvent::facts_ingested("claude-code", &run, 1, 25, 3, 7);
        emit(&db, &event, &run);

        // outbox 行断言
        let (etype, harness, payload): (String, Option<String>, String) = db.conn().query_row(
            "SELECT event_type, harness, payload_json FROM event_outbox",
            [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        ).unwrap();
        assert_eq!(etype, "FactsIngested");
        assert_eq!(harness.as_deref(), Some("claude-code"));
        assert!(payload.contains("\"inserted\":25"), "载荷带 inserted: {payload}");

        // 消费者收到
        let received = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let rx = received.clone();
        let dispatcher = Dispatcher::new(vec![EventConsumer::new("e2e-facts", ConsumerInterest::domain(&[]), move |e| {
            rx.lock().unwrap().push(e.clone());
            Ok(())
        })]).expect("valid interest");
        let report = dispatcher.drain(db.conn()).unwrap();
        assert_eq!(report.delivered, 1);
        let recv = received.lock().unwrap().clone();
        assert_eq!(recv[0].event_type, "FactsIngested");
        assert_eq!(recv[0].harness.as_deref(), Some("claude-code"));
        assert_eq!(recv[0].correlation_id.as_deref(), Some(run.as_str()));
        assert_eq!(recv[0].payload["inserted"], 25);
        drop(db);
        cleanup(&path);
    }

    /// TrustMonitorEvent 端到端：全局事件（harness=None）载荷完整到达消费者。
    #[test]
    fn trust_monitor_event_end_to_end() {
        let path = tmp_db("e2e-trust");
        let db = AuthorityDb::open(&path, 1).expect("open");
        let run = seed(&db);
        let event = AppEvent::trust_monitor_event(&run, 5, 3, 2);
        emit(&db, &event, &run);

        let received = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let rx = received.clone();
        let dispatcher = Dispatcher::new(vec![EventConsumer::new("e2e-trust", ConsumerInterest::domain(&[]), move |e| {
            rx.lock().unwrap().push(e.clone());
            Ok(())
        })]).expect("valid interest");
        let report = dispatcher.drain(db.conn()).unwrap();
        assert_eq!(report.delivered, 1);
        let recv = received.lock().unwrap().clone();
        assert_eq!(recv[0].event_type, "TrustMonitorEvent");
        assert_eq!(recv[0].harness, None, "全局事件 harness=None");
        assert_eq!(recv[0].payload["observations"], 5);
        assert_eq!(recv[0].payload["findings_upserted"], 2);
        drop(db);
        cleanup(&path);
    }

    /// 重试穷尽后永久死信：next_retry_at_ms 变 NULL 后反连接不再发现。
    #[test]
    fn retry_exhaustion_permanent_dead_letter() {
        let path = tmp_db("dead-letter");
        let db = AuthorityDb::open(&path, 1).expect("open");
        let run = seed(&db);
        emit(&db, &AppEvent::facts_ingested("dsh", &run, 1, 1, 0, 0), &run);
        let dispatcher = Dispatcher::new(vec![EventConsumer::new("dl", ConsumerInterest::domain(&[]), |_| Err("dead".into()))]).expect("valid interest");

        // 第一次失败 → retry_count=1
        let r1 = dispatcher.drain(db.conn()).unwrap();
        assert_eq!(r1.failed, 1);

        // 手动推到穷尽边界，让它吃最后一次重试
        db.conn().execute(
            "UPDATE event_deliveries SET retry_count = ?1, next_retry_at_ms = 0 WHERE consumer_id = 'dl'",
            [MAX_RETRIES - 1],
        ).unwrap();
        let r2 = dispatcher.drain(db.conn()).unwrap();
        assert_eq!(r2.failed, 1, "最后一次重试");

        // 穷尽后 next_retry_at_ms=NULL，不再被反连接发现
        let next: Option<i64> = db.conn().query_row(
            "SELECT next_retry_at_ms FROM event_deliveries WHERE consumer_id = 'dl'",
            [], |r| r.get(0),
        ).unwrap();
        assert!(next.is_none(), "穷尽后应 NULL，got {next:?}");
        let r3 = dispatcher.drain(db.conn()).unwrap();
        assert_eq!((r3.delivered, r3.failed), (0, 0), "永久死信不再投递");
        drop(db);
        cleanup(&path);
    }

    fn cleanup(path: &std::path::PathBuf) {
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(path.with_extension("sqlite3-shm"));
        let _ = std::fs::remove_file(path.with_extension("sqlite3-wal"));
    }

    // ---- RUNTIME_INVALIDATION spec §4.2–§4.5（验收 9.3 9.4 9.6 9.7 9.8 9.9）----

    /// 9.3：展示层角色用普通消费者、或声明 Domain 类型子集 → 构造期拒绝。
    #[test]
    fn presentation_consumer_cannot_subscribe_domain_events() {
        let plain = Dispatcher::new(vec![EventConsumer::new(
            "ui-plain", ConsumerInterest::presentation(), |_| Ok(()),
        )]);
        assert!(plain.is_err(), "presentation role must not read payloads via EventConsumer");

        let subset = Dispatcher::with_coalescing(vec![], vec![CoalescingConsumer::new(
            "ui-subset",
            ConsumerInterest { role: ConsumerRole::Presentation, types: &["FactsIngested"] },
            |_| {},
        )]);
        assert!(subset.is_err(), "presentation role takes no type subset");

        let audit_wants_domain = Dispatcher::new(vec![EventConsumer::new(
            "audit-x", ConsumerInterest::audit(&["FactsIngested"]), |_| Ok(()),
        )]);
        assert!(audit_wants_domain.is_err(), "audit role cannot subscribe Domain-class types");

        let unknown = Dispatcher::new(vec![EventConsumer::new(
            "dom-x", ConsumerInterest::domain(&["NotAType"]), |_| Ok(()),
        )]);
        assert!(unknown.is_err());

        let ok = Dispatcher::with_coalescing(
            vec![EventConsumer::new("dom", ConsumerInterest::domain(&["FactsIngested"]), |_| Ok(()))],
            vec![CoalescingConsumer::new("ui", ConsumerInterest::presentation(), |_| {})],
        );
        assert!(ok.is_ok());
    }

    /// 9.4：兴趣集过滤在 SQL 层——不订阅的类型零投递、零记账。
    #[test]
    fn interest_filter_skips_unsubscribed_types_without_bookkeeping() {
        let path = tmp_db("interest");
        let db = AuthorityDb::open(&path, 1).expect("open");
        let run = seed(&db);
        emit(&db, &AppEvent::facts_ingested("dsh", &run, 1, 1, 0, 0), &run);
        emit(&db, &AppEvent::trust_monitor_event(&run, 2, 2, 0), &run);

        static SEEN: AtomicUsize = AtomicUsize::new(0);
        let dispatcher = Dispatcher::new(vec![EventConsumer::new(
            "only-trust", ConsumerInterest::domain(&["TrustMonitorEvent"]),
            |e| { assert_eq!(e.event_type, "TrustMonitorEvent"); SEEN.fetch_add(1, Ordering::SeqCst); Ok(()) },
        )]).expect("valid");
        let report = dispatcher.drain(db.conn()).expect("drain");
        assert_eq!(report.delivered, 1);
        assert_eq!(SEEN.load(Ordering::SeqCst), 1);
        let deliveries: i64 = db.conn().query_row(
            "SELECT COUNT(*) FROM event_deliveries WHERE consumer_id = 'only-trust'", [], |r| r.get(0),
        ).unwrap();
        assert_eq!(deliveries, 1, "the FactsIngested row must not even be bookkept for this consumer");
        let _ = std::fs::remove_file(&path);
    }

    /// 9.6：合成 1000 条 FactsIngested 一轮 drain → flush 恰 1 次，deliveries 1000 行，
    /// harnesses 为合成执行环境集。9.9：flush 拿到的摘要结构上没有载荷。
    #[test]
    fn coalescing_consumer_flushes_once_per_drain_with_harnesses_and_no_payload() {
        let path = tmp_db("coalesce");
        let db = AuthorityDb::open(&path, 1).expect("open");
        let run = seed(&db);
        let harnesses = ["claude-code", "codex", "dsh", "workbuddy"];
        db.with_immediate_txn(|conn| {
            for i in 0..1000u64 {
                let harness = harnesses[(i % 4) as usize];
                let mut e = AppEvent::facts_ingested(harness, &run, i, 1, 0, 0);
                e.occurred_at_ms = 1_000 + i as i64; // 身份材料含时间戳，保证 1000 条互不吸收
                e.payload["secret-marker"] = json!("SENSITIVE-PAYLOAD");
                insert_outbox(conn, &e, &run).map_err(db_err)?;
            }
            Ok(())
        }).expect("emit 1000");

        let flushes = std::sync::Arc::new(std::sync::Mutex::new(Vec::<Coalesced>::new()));
        let sink = std::sync::Arc::clone(&flushes);
        let dispatcher = Dispatcher::with_coalescing(vec![], vec![CoalescingConsumer::new(
            "desktop-ui", ConsumerInterest::presentation(),
            move |c| sink.lock().unwrap().push(c),
        )]).expect("valid");
        let report = dispatcher.drain(db.conn()).expect("drain");
        assert_eq!((report.delivered, report.flushed), (1000, 1));
        let got = flushes.lock().unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].events, 1000);
        let expect: std::collections::BTreeSet<String> = harnesses.iter().map(|h| h.to_string()).collect();
        assert_eq!(got[0].harnesses, expect);
        assert_eq!(got[0].types.iter().copied().collect::<Vec<_>>(), vec!["FactsIngested"]);
        // 9.9：结构保证——`Coalesced` 的 Debug 输出里不可能出现载荷字段。
        assert!(!format!("{:?}", got[0]).contains("SENSITIVE-PAYLOAD"));
        let deliveries: i64 = db.conn().query_row(
            "SELECT COUNT(*) FROM event_deliveries WHERE consumer_id = 'desktop-ui'", [], |r| r.get(0),
        ).unwrap();
        assert_eq!(deliveries, 1000);
        drop(got); // 同线程再锁 std Mutex 会死锁
        // 第二轮 drain：无新事件 → 不 flush。
        let again = dispatcher.drain(db.conn()).expect("drain 2");
        assert_eq!((again.delivered, again.flushed), (0, 0));
        assert_eq!(flushes.lock().unwrap().len(), 1);
        let _ = std::fs::remove_file(&path);
    }

    /// 9.8：合并型消费者与普通消费者混排，普通消费者一条失败不影响合并型的
    /// flush；每条各自记账。
    #[test]
    fn coalescing_flush_is_independent_of_plain_consumer_failures() {
        let path = tmp_db("coalesce-mixed");
        let db = AuthorityDb::open(&path, 1).expect("open");
        let run = seed(&db);
        emit(&db, &AppEvent::facts_ingested("dsh", &run, 1, 1, 0, 0), &run);
        emit(&db, &AppEvent::facts_ingested("codex", &run, 2, 1, 0, 0), &run);
        static FLUSHED: AtomicUsize = AtomicUsize::new(0);
        let dispatcher = Dispatcher::with_coalescing(
            vec![EventConsumer::new("failer", ConsumerInterest::domain(&[]), |e| {
                if e.harness.as_deref() == Some("codex") { Err("boom".into()) } else { Ok(()) }
            })],
            vec![CoalescingConsumer::new("ui", ConsumerInterest::presentation(), |c| {
                assert_eq!(c.events, 2);
                FLUSHED.fetch_add(1, Ordering::SeqCst);
            })],
        ).expect("valid");
        let report = dispatcher.drain(db.conn()).expect("drain");
        assert_eq!((report.delivered, report.failed, report.flushed), (3, 1, 1));
        assert_eq!(FLUSHED.load(Ordering::SeqCst), 1);
        let _ = std::fs::remove_file(&path);
    }

    /// 9.7：revision 未前进不发；前进才发；首发必发。
    #[test]
    fn invalidation_publishes_only_when_revision_advances() {
        let publisher = ChangePublisher::<Invalidation>::new();
        let inv = |r: u64| Invalidation { revision: r, harnesses: Default::default() };
        let mut emitted = Vec::new();
        assert!(publisher.publish_if_advanced(inv(5), |i| emitted.push(i.revision)));
        assert!(!publisher.publish_if_advanced(inv(5), |i| emitted.push(i.revision)), "same revision: swallowed");
        assert!(!publisher.publish_if_advanced(inv(4), |i| emitted.push(i.revision)), "older: swallowed");
        assert!(publisher.publish_if_advanced(inv(6), |i| emitted.push(i.revision)));
        assert_eq!(emitted, vec![5, 6]);
        assert_eq!(publisher.last().map(|i| i.revision), Some(6));
    }

    #[test]
    fn change_publisher_emits_on_first_and_on_difference_only() {
        let publisher = ChangePublisher::<(bool, String)>::new();
        let mut n = 0;
        assert!(publisher.publish_if_changed((true, "ok".into()), |_| n += 1));
        assert!(!publisher.publish_if_changed((true, "ok".into()), |_| n += 1));
        assert!(publisher.publish_if_changed((false, "ok".into()), |_| n += 1));
        assert!(publisher.publish_if_changed((true, "ok".into()), |_| n += 1), "flip back is a change");
        assert_eq!(n, 3);
    }

}
