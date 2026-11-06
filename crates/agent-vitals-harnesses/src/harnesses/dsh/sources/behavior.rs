//! 行为审计规则引擎的 I/O 薄封装（v0.9 Stage 0.3 从 `apps/cli` 搬进
//! `agent_vitals_runtime::sessions::behavior`；W3（2026-09-24）再搬到这里——读 DSH
//! 会话日志、把 wire 事件喂给规则，是执行环境适配层的活）。价卡由调用方传入
//! （`audit_payload(path, pricing)`），本 crate 不读 data_home；runtime 的
//! `sessions::behavior` 薄封装负责加载用户价卡覆盖。
//!
//! 纯计算（规则表、`match_behavior`、`usage::token_by_model`、`behavior_gate`）
//! 住在 `crates/agent-vitals-domain`（单一真相源，CLI / Python / wasm 共用）。这里
//! 只留两个 I/O 入口：`audit_session_log`（读会话日志文件
//! `super::read_session_log`，把执行事件喂给 core 的
//! `match_behavior`、把成本账事件喂给 `token_by_model`）与 `audit_payload`
//! （在此基础上叠加 pricing，拼成 `behavior --json` 的 20 键载荷）。

use std::path::Path;

use serde_json::{json, Value};

pub use agent_vitals_domain::behavior::{
    array_signal_status, behavior_gate, flatten, match_behavior_canonical, rule_outcomes_json,
    waste_coverage,
};
use agent_vitals_domain::evidence::Signal;

/// 一份会话的行为审计结果：风险 findings + 按模型分桶的 token 报告（两条正交
/// 的审计维度）。成本由 CLI 显示层（`cost.rs`）用 pricing.json 折算。
pub struct Audit {
    pub findings: Vec<Value>,
    pub usage: Value,
    /// 逐请求时间序列（PRD §9.3）。与 `usage` 同源不同分辨率：那边是按模型的
    /// 总数，这边保留每次请求一行。CLI 出报告不再需要经过 DSH 集成。
    pub requests: Value,
    /// 常驻上下文构成（FR-04a）：系统提示词 / 工具定义 / 技能目录的分类估算。
    pub context: Value,
    /// 上下文压缩事件：时间线的 ✂ 标记 + prune 的**执行环境实测**被丢弃 token 数。
    /// 与 `context` 的 est_tokens 估算 provenance 不同，展示层须分开标注。
    pub compaction: Value,
    /// FR-04b 结构性浪费：规则可直接判定、不需要历史基线的浪费模式。
    pub waste: Value,
    /// 分叉前（从上游会话 branch 时抄进日志的那段）被排除掉的用量。上面每一项
    /// 都只算分叉之后，金额会显著变小——不把排除量说出来，读的人会以为数据坏了。
    /// **没分叉时是 `Value::Null`，不是全零结构**：「没分叉」与「分叉了但上游
    /// 没花钱」是两回事。
    pub pre_fork: Value,
    /// 本会话派出的子代理（FR-03 时间线的关键事件，也是父子会话的权威链路）。
    /// 子会话头里的 parentSession 不可靠——真实数据里 19 次调用只有 5 个子会话
    /// 指回本会话，其余 14 次是分叉前上游派的（见 subagent.rs 的模块注释）。
    pub subagents: Value,
    /// T11：Skill 执行审计——每次调用的触发方式/加载状态/耗时/位置（PRD §9 契约）。
    /// 与 `subagents` 不同：这是**本会话**内 skill 触发记录，不跨会话合并。
    pub skill: Value,
    /// D11：执行时长审计——`{tool_calls, turns, steps, approvals, hooks}` 五个
    /// 数组（`crates/agent-vitals-domain/src/domain/duration.rs` 的五个纯函数）。
    /// `hooks` 是 CLI 独有的一项——浏览器那边的 `durationAudit` 投影**不**收
    /// hook/* 事件（执行环境能不能看到 hook 事件还没验证过），但 CLI 直接读盘上
    /// 的原始 JSONL，`hook/*` 本来就在 `EXECUTION_EVENT_TYPES` 里，这里立即
    /// 可用——两条链路的能力边界不同，不是疏漏。
    pub duration: Value,
    /// P3 group①（docs/RUNTIME_EVIDENCE_CONTRACT.md §10）：SV601–610 每条规则
    /// 的三态结果——`findings`（命中了几条）/ `measured_zero`（测了，零命中）/
    /// `unavailable`（这份日志根本没有该规则依赖的信号，不是"测了是零"）。
    /// **新增、只加不改**：`findings` 字段本身的产出逻辑完全没变。
    pub rule_outcomes: Value,
    /// P3 group②（docs/RUNTIME_EVIDENCE_CONTRACT.md §17，cost fold）：
    /// `usage`/`requests`/`context`/`cost` 这族输出共用同一个信号
    /// （`Signal::Usage`）——这里不是新裁决，是把这族函数早就有的
    /// "零样本不编造" 纪律（`unreported_fields`、`cost_report` 返回
    /// `None`）正式挂到 Signal 词汇上，供跨规则族的一致性检查用。
    pub usage_coverage: Value,
    /// P3 group③（docs/RUNTIME_EVIDENCE_CONTRACT.md §17，duration）：五路
    /// 时长审计（tool_calls/turns/steps/approvals/hooks）各自的信号覆盖——
    /// 空数组现在能分清是"这份日志没有这类事件"（unavailable）还是"有这类
    /// 事件但配不成对"（measured_zero）。只加不改，五个 duration.rs 函数的
    /// 配对逻辑完全没变。
    pub duration_coverage: Value,
    /// P3 group⑤（docs/RUNTIME_EVIDENCE_CONTRACT.md §17，skill / subagent /
    /// compaction / waste）：`skill`/`subagents`/`compaction` 各自对着一个
    /// 单一信号（SkillInvocations/SubagentSpawns/Compaction）判三态；
    /// `waste` 依赖 ToolCalls 或 ToolResults 任一有证据（OR，同 SV613/614）。
    pub skill_coverage: Value,
    pub subagents_coverage: Value,
    pub compaction_coverage: Value,
    pub waste_coverage: Value,
}

/// 读会话日志 → 执行事件 + 成本账事件 → (findings, usage, requests, context, compaction, waste)（端到端入口）。
///
/// 降级时（不可读 / 畸形 / schema 不符，`degraded` 为字符串）返回 `None`，
/// **绝不返回空列表 = 0 条**——空列表只在「读全了但确实 0 条执行事件」时出现。
pub fn audit_session_log(path: &Path) -> Option<Audit> {
    let session = super::read_session_log(path);
    if session.get("degraded").and_then(|v| v.as_str()).is_some() {
        return None;
    }
    // P2（docs/RUNTIME_EVIDENCE_CONTRACT.md §17）：先把已经抽好的事件数组折成
    // evidence::CanonicalSession（core::dsh_evidence），再反向投影回老形状的
    // events/usage_events/cwd——下游 trajectory/usage/compaction/waste/
    // subagent/skill/duration 全读老形状，只有 family ① 规则（SV601–610，
    // phase B 先滤后调）读 canonical。两个面都必须字节不变。
    let execution_events: Vec<Value> = session
        .get("execution_events")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let usage_events_raw: Vec<Value> = session
        .get("usage_events")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let cwd_raw: Option<String> = session.get("cwd").and_then(|v| v.as_str()).map(str::to_owned);
    let session_id = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown")
        .to_string();
    let dsh_evidence = crate::dsh_evidence::build_dsh_evidence(
        execution_events, usage_events_raw, cwd_raw.clone(), session_id,
    );
    let (events, usage_events, _cwd_owned) = crate::dsh_evidence::reverse_project(&dsh_evidence);
    // P3 group①：SV601–610 前置门控 + SV611–614 后置标注，三态都基于**分叉后**
    // 的证据判——但 `dsh_evidence`（上面）是从分叉前的 execution_events 建的，
    // 服务于 compaction/subagent/skill/duration 那些本来就该看到完整历史的
    // 消费者，不能动。family ① 只看审计范围内（分叉后）的事件，所以这里用
    // post_fork 重新 build 一份 canonical，供门控 + flatten + coverage 共用。
    // post_fork 幂等（util.rs 注释），这第二次 build 只是"拿审计范围内证据"，
    // 不改已有语义。
    // **这份 canonical 的 workspace 根必须传真 cwd**——旧代码这里传 None，会让
    // SV605 退化成纯绝对路径启发式，漏掉工作区内相对路径的写文件（cwd bug）；
    // 门控 dispatcher 现在直接吃这份 canonical，SV605 的 workspace_root 判断
    // 从此依赖这一行。
    let post_fork_events = agent_vitals_domain::util::post_fork(&events);
    let post_fork_usage_events = agent_vitals_domain::util::post_fork(&usage_events);
    let post_fork_evidence = crate::dsh_evidence::build_dsh_evidence(
        post_fork_events, post_fork_usage_events, cwd_raw.clone(), String::new(),
    );
    // 单事件规则（SV601–610）与轨迹级检测（SV611–614）都吃同一份分叉后
    // canonical、都由前置门控 dispatcher 产出（先滤后调，§10 三态契约）——
    // 二者从此同源、同范围（分叉前缀的轨迹异常不再计入本会话，见
    // match_trajectory_canonical）。字节序稳定：family ① 用私有键 `__ord`
    // （事件下标）重建 (event, rule) 序，family ④ 按码序追加，合起来与旧
    // 实现逐字节一致。
    let family1_outcomes = match_behavior_canonical(&post_fork_evidence.canonical);
    let trajectory_outcomes =
        agent_vitals_domain::trajectory::match_trajectory_canonical(&post_fork_evidence.canonical);
    let mut findings = flatten(&family1_outcomes);
    findings.extend(agent_vitals_domain::trajectory::flatten_trajectory(&trajectory_outcomes));
    // 三态结果合并成一份 `--json` 的 outcomes：family ① 在前、family ④ 在后，
    // 键序即 rule_specs 的 SV601..SV614。
    let mut all_outcomes = family1_outcomes;
    all_outcomes.extend(trajectory_outcomes);
    let rule_outcomes_val = rule_outcomes_json(&all_outcomes);
    let usage_coverage_val = agent_vitals_domain::usage::usage_signal_status(&post_fork_evidence.canonical.coverage);
    // 三个消费者共用 usage_events（各取所需，不认识的事件类型自然跳过）：
    // token_by_model 按模型分桶、request_metrics 保留逐请求分辨率、
    // context_composition 从 header.system/tools 与 skill-catalog 载体算常驻前缀。
    let usage = agent_vitals_domain::usage::token_by_model(&usage_events);
    let requests_val = agent_vitals_domain::usage::request_metrics(&usage_events);
    let context = agent_vitals_domain::usage::context_composition(&usage_events);
    let compaction = crate::compaction::compaction_events(&events);
    let waste = Value::Array(crate::waste::detect_structural_waste(&events, requests_val.as_array().unwrap_or(&Vec::new())));
    // 分叉前被排除掉的用量。上面每一项都只算分叉之后（post_fork），金额会因此
    // 显著变小；不把排除量说出来，读的人会以为数据坏了。没分叉时是 null。
    let pre_fork = agent_vitals_domain::usage::pre_fork_usage(&usage_events);
    let subagents = agent_vitals_domain::subagent::subagent_spawns(&events);
    let skill = agent_vitals_domain::skill::skill_invocations(&events, requests_val.as_array().unwrap_or(&Vec::new()));
    let duration = json!({
        "tool_calls": agent_vitals_domain::duration::tool_call_durations(&events),
        "turns": agent_vitals_domain::duration::turn_durations(&events),
        "steps": agent_vitals_domain::duration::step_durations(&events),
        "approvals": agent_vitals_domain::duration::approval_latencies(&events),
        "hooks": agent_vitals_domain::duration::hook_executions(&events),
    });
    // P3 group③：五路时长审计各自的信号覆盖——用同一份 post_fork_evidence 的
    // coverage（execution 事件派生的信号，跟 rule_outcomes 同源）。
    let duration_coverage_val = agent_vitals_domain::duration::duration_coverage(
        &duration, &post_fork_evidence.canonical.coverage,
    );
    // P3 group⑤：skill/subagent/compaction 各自对着单一信号判三态；waste
    // 是 ToolCalls/ToolResults 任一有证据即可（同 SV613/614 的 OR 语义）。
    // 都用 post_fork_evidence 的 coverage——跟 rule_outcomes/duration_coverage
    // 同源、同一个"审计范围内"的理由。
    let cov = &post_fork_evidence.canonical.coverage;
    let skill_count = skill.as_array().map_or(0, |a| a.len());
    let subagents_count = subagents.as_array().map_or(0, |a| a.len());
    // compaction_events 是 {"compactions": [...], "prunes": [...], ...}
    // 嵌套形状，不是裸数组——两个子数组的长度和才是"这份日志有多少条压缩
    // 相关记录"，`.as_array()` 对一个 object 会拿到 None。
    let compaction_count = compaction.get("compactions").and_then(|v| v.as_array()).map_or(0, |a| a.len())
        + compaction.get("prunes").and_then(|v| v.as_array()).map_or(0, |a| a.len());
    let skill_coverage_val = array_signal_status(skill_count, Signal::SkillInvocations, cov);
    let subagents_coverage_val = array_signal_status(subagents_count, Signal::SubagentSpawns, cov);
    let compaction_coverage_val = array_signal_status(compaction_count, Signal::Compaction, cov);
    let waste_coverage_val = waste_coverage(&waste, cov);
    Some(Audit {
        findings, usage, requests: requests_val, context, compaction, waste, pre_fork, subagents,
        skill, duration, rule_outcomes: rule_outcomes_val, usage_coverage: usage_coverage_val,
        duration_coverage: duration_coverage_val, skill_coverage: skill_coverage_val,
        subagents_coverage: subagents_coverage_val, compaction_coverage: compaction_coverage_val,
        waste_coverage: waste_coverage_val,
    })
}

/// 20 键行为审计载荷（`behavior --json` 的输出形状 + cost/pre_fork_cost）。DSH
/// SessionReport 的 `session` 载荷就是这份（R2a §2.4，不复用第二套字段名）。
/// main.rs 的 `behavior --json` 与同步后的 findings 评估（`ingest::findings_eval`）共用它。
///
/// 键序 = 字节一致的一部分，**不能重排**（与 Python cli.py 的 `json.dumps` 逐字节
/// 对齐）：findings → usage → requests → context → compaction → waste → cost →
/// pre_fork → pre_fork_cost → subagents → skill → duration → rule_outcomes →
/// usage_coverage → duration_coverage → skill_coverage → subagents_coverage →
/// compaction_coverage → waste_coverage → cost_series。`cost_series` 在末尾追加
/// （浏览器/工作台逐请求费用曲线读它，见 cost.rs::cost_series——与 dsh-client 执行环境
/// `costSeriesFrom` 同一规则的第三个镜像，展示层不再重算价）。
///
/// `cost` 不是 audit 六键之一——它读的是 `usage` × pricing.json，是 `usage` 上的
/// 一次派生计算（展示层定价，core 只给 token）。`pre_fork` 与 `usage` 是同一个
/// 形状，定价走同一个 `cost_report`；没分叉时 `pre_fork`/`pre_fork_cost` 都是
/// null，**不是**全零结构（「没分叉」和「分叉了但上游没花钱」是两回事）。
///
/// 降级时（不可读/畸形/schema 不符）返回 `None`——调用方 exit 2，绝不返回空载荷。
pub fn audit_payload(path: &Path, pricing: &Value) -> Option<Value> {
    let audit = audit_session_log(path)?;
    let findings = &audit.findings;
    let cost = agent_vitals_domain::cost::cost_report(&audit.usage, pricing);
    let pre_fork_cost = if audit.pre_fork.is_null() {
        None
    } else {
        agent_vitals_domain::cost::cost_report(&audit.pre_fork, pricing)
    };
    let requests_slice: &[serde_json::Value] =
        audit.requests.as_array().map(|v| v.as_slice()).unwrap_or(&[]);
    Some(json!({
        "findings": findings,
        "usage": &audit.usage,
        "requests": &audit.requests,
        "context": &audit.context,
        "compaction": &audit.compaction,
        "waste": &audit.waste,
        "cost": cost,
        "pre_fork": &audit.pre_fork,
        "pre_fork_cost": pre_fork_cost,
        "subagents": &audit.subagents,
        "skill": &audit.skill,
        "duration": &audit.duration,
        "rule_outcomes": &audit.rule_outcomes,
        "usage_coverage": &audit.usage_coverage,
        "duration_coverage": &audit.duration_coverage,
        "skill_coverage": &audit.skill_coverage,
        "subagents_coverage": &audit.subagents_coverage,
        "compaction_coverage": &audit.compaction_coverage,
        "waste_coverage": &audit.waste_coverage,
        "cost_series": agent_vitals_domain::cost::cost_series(requests_slice, &audit.usage["providers"], pricing),
    }))
}
