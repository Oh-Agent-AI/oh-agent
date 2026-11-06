//! v0.7 Stage 3 commit 2：DSH 会话 → UsageFact emitter（Rust 镜像，harness adapter，
//! 不进 Core）。v0.9 Stage A 从 apps/cli/src/agent/ 归位本执行环境 sources 层
//! （R4 §5.2 scope gap）——CLI 命令经 `agent_vitals_harnesses::dsh_usage_fact`
//! re-export 走同一实现，字节行为零改动（212 项差分 + golden 15/15 钉住）。
//!
//! 镜像 `scripts/agent_vitals/agent/dsh_usage_fact.py`——把一份 DSH 会话文件
//! （明文 JSONL 或 zstd 多帧）的 **post-fork 逐请求消耗**重放成 `UsageFact` 事实流。
//! Python↔Rust stdout byte-parity 由 `tests/test_dsh_usage_fact.py` 钉住（同批文件
//! 两侧 `--json -` 字节相等）。
//!
//! **本模块不解释任何 DSH wire shape**——读/解码（`super::read_session_text`）、
//! reshape（`parse_session_log`）、身份与 profile（`sessions::header` 的
//! `dsh_header`/`dsh_source_profile`，runtime findings 评估器共用同一实现）、
//! 逐槽观测（core `usage::dsh_usage_observations`）、残差
//! 折叠（`usage::usage_fold_checkpoint`）、UsageFact 契约（core
//! `usage_fact::build_usage_fact`）全部复用，一行新解释都不写。**emit surface =
//! 共享 observer 的相邻槽**：每条 `DshUsageObservation` emit 一个 fact，身份字段由
//! observer 开槽即固化（§3.3），本模块只消费、绝不重读日志复算 source_event_id。
//!
//! **strict 单文件诊断**（§4.1）：读/解码 → 解析 → 身份（缺 session id）→ 归属
//! （缺 cwd 且无显式 profile）→ 守卫（source_event_id 重复）都是**硬错误**（CLI
//! exit 2），不输出空成功伪装成「没有用量」。成功结果恒满足
//! `observation_rows == fact_rows` 且 source_event_id 全唯一。诚实空集只留给「干净
//! 解析 + post-fork 零样本」（exit 0 `facts=[]` + 全 0 coverage，§4.3）。
//!
//! 错误以 `Err(String)` 上抛，字符串恒为 `"<code>: <message>"` 且与 Python 的
//! `DshUsageFactError.__str__` 同源（read 错误码 → 消息映射与 `dsh_usage_fact.py`
//! 的 `_READ_ERROR_MESSAGES` 逐字一致）。RFC3339-ms-Z 用纯整数（Hinnant
//! civil-from-days 由 `agent_vitals_domain::util::civil_from_unix_secs`
//! 提供）——不引 chrono、不经浮点（§3.6）。

use std::collections::HashSet;
use std::path::Path;

use serde_json::{json, Map, Value};

use crate::harnesses::dsh::sessions::header::{dsh_header, dsh_source_profile};
use super::{parse_session_log, read_session_text};
use agent_vitals_domain::usage::{
    dsh_usage_observations, usage_fold_checkpoint, DshUsageObservation,
};
use agent_vitals_domain::util::civil_from_unix_secs;
use agent_vitals_domain::usage_fact::build_usage_fact;
use agent_vitals_domain::util::post_fork;
use agent_vitals_domain::source_identity::fnv1a64_hex;
use agent_vitals_provider::{resolve_billing_attribution, EvidenceBasis, RouteEvidence};

const HARNESS: &str = "dsh";
const OBSERVATION_KIND: &str = "assistant-usage";

/// `dsh_session_to_usage_facts` 的返回（spec §5）。`facts` = 逐槽一行
/// `build_usage_fact` 输出（source_event_id 已查重）；coverage 其余四键派生
/// （fact_rows = facts.len()，to_payload_value 里算）。
#[derive(Debug)]
pub struct DshUsageFactEmitResult {
    pub facts: Vec<Value>,
    pub workflow_events: Vec<agent_vitals_domain::workflow::WorkflowEvent>,
    pub observation_rows: usize,
    pub unaccounted_events: i64,
    pub unaccounted_tokens: i64,
}

/// 读/解码错误码 → 人读消息。与 Python `dsh_usage_fact.py::_READ_ERROR_MESSAGES`
/// 逐字一致（Rust 侧 zstd 恒编译在内，`unsupported-compression` 只在 Python
/// `zstandard` 缺席时出现，这里保留同码映射防漂移）。
fn read_error_message(code: &'static str) -> &'static str {
    match code {
        "file-missing" => "session file missing or unreadable",
        "unsupported-compression" => "zstd support unavailable (zstandard not installed)",
        "zstd-decode-error" => "zstd decode failed (truncated or corrupt frame)",
        other => other,
    }
}

/// epoch 毫秒 → RFC3339-UTC 固定毫秒 + `Z`（`1970-01-01T00:00:00.000Z`）。纯整数
/// （`div_euclid`/`rem_euclid`），与 Python `divmod`（floor）在正负输入下同语义。
/// 日期部分复用 `agent_vitals_domain::util::civil_from_unix_secs(secs, 0)`；time-of-day 用
/// `secs.rem_euclid(86400)` 补（那个函数只回日期，小时桶另算）。
fn rfc3339_ms_z(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let tod = secs.rem_euclid(86400);
    let (y, m, d) = civil_from_unix_secs(secs, 0);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        y,
        m,
        d,
        tod / 3600,
        (tod / 60) % 60,
        tod % 60,
        millis
    )
}

fn opt_i64(v: Option<i64>) -> Value {
    match v {
        Some(n) => json!(n),
        None => Value::Null,
    }
}

fn opt_str(v: &Option<String>) -> Value {
    match v {
        Some(s) => json!(s),
        None => Value::Null,
    }
}

/// `DshUsageObservation` → `build_usage_fact` 输入（§3.1 映射表）。
///
/// `event_ts_utc` = 支配样本 epoch ms → RFC3339-ms-Z；真无 time（None）→ null +
/// `time_basis` null（显式判空，epoch 0 是真时间、不是「无时间」）。四桶/turn/step
/// 原样带 None（缺项 ≠ 0，§3.2）；compaction 槽 turn/step 恒 None（observer 已置，
/// 不泄漏内部负号哈希）。
fn observation_to_usage_fact(
    obs: &DshUsageObservation,
    machine_namespace: &str,
    native_session_id: &str,
    profile: &str,
) -> Result<Value, Vec<String>> {
    let mut fields = Map::new();
    fields.insert("machine_namespace".into(), json!(machine_namespace));
    fields.insert("harness".into(), json!(HARNESS));
    fields.insert("source_profile".into(), json!(profile));
    fields.insert("native_session_id".into(), json!(native_session_id));
    fields.insert("source_event_id".into(), json!(obs.source_event_id));
    fields.insert("observation_kind".into(), json!(OBSERVATION_KIND));
    fields.insert("identity_basis".into(), json!(obs.identity_basis));
    fields.insert(
        "event_ts_utc".into(),
        match obs.time {
            Some(ms) => json!(rfc3339_ms_z(ms)),
            None => Value::Null,
        },
    );
    // time_basis 显式判空，不用 truthiness：合法 epoch 0（time=0）是真时间
    fields.insert(
        "time_basis".into(),
        if obs.time.is_some() { json!("native") } else { Value::Null },
    );
    fields.insert("source_usage_semantics".into(), json!("delta"));
    // provider/model 原始证据（§3.4）：observer 已收敛成原始字符串或 None
    // （正常 = 支配样本那刻 active config；compaction = 自带否则回落）——绝无
    // `__ambiguous__`（那是聚合层的派生状态，不进 fact）。
    fields.insert("provider_raw".into(), opt_str(&obs.provider_raw));
    let route = obs.provider_raw.as_ref().map(|provider_raw| RouteEvidence {
        provider_raw: Some(provider_raw.clone()),
        endpoint_host: None,
        evidence_basis: EvidenceBasis::SessionNative,
    });
    let attribution = resolve_billing_attribution(obs.provider_raw.as_deref(), route.as_ref());
    fields.insert("provider_id".into(), json!(attribution.provider_id));
    let route_evidence_id = obs.provider_raw.as_ref().map(|provider_raw| {
        let key = format!(
            "{}|{}|{}",
            native_session_id,
            provider_raw,
            attribution.evidence_basis.as_str()
        );
        format!("route:{}", fnv1a64_hex(key.as_bytes()))
    });
    fields.insert("route_evidence_id".into(), json!(route_evidence_id));
    fields.insert("billing_source".into(), json!(attribution.provider_id));
    fields.insert("billing_mode".into(), json!(attribution.billing_mode.as_str()));
    fields.insert("pricing_basis".into(), json!(attribution.pricing_basis));
    fields.insert("evidence_basis".into(), json!(attribution.evidence_basis.as_str()));
    fields.insert("normalization_version".into(), json!("provider-v0.11"));
    fields.insert("attribution_version".into(), json!("provider-v0.11"));
    fields.insert("model_raw".into(), opt_str(&obs.model_raw));
    fields.insert("uncached_input_tokens".into(), opt_i64(obs.uncached_input_tokens));
    fields.insert("cache_read_tokens".into(), opt_i64(obs.cache_read_tokens));
    fields.insert("cache_write_tokens".into(), opt_i64(obs.cache_write_tokens));
    fields.insert("output_tokens".into(), opt_i64(obs.output_tokens));
    fields.insert("turn".into(), opt_i64(obs.turn));
    fields.insert("step".into(), opt_i64(obs.step));
    // builder 是唯一校验方（6 身份字段非空 + 四桶非负）。DSH 无 bad_id 类别——obs
    // 身份恒非空、桶恒 None/非负 int，成功路径到不了这里；真走到（调用方传空
    // machine_namespace 之类的参数错）就让问题清单如实上抛。
    build_usage_fact(&fields)
}

/// 单份 DSH 会话文件 → `DshUsageFactEmitResult`（spec §5）。错误一律
/// `Err("code: message")`，与 Python 的 `DshUsageFactError.__str__` 同源。
pub fn dsh_session_to_usage_facts(
    path: &Path,
    machine_namespace: &str,
    source_profile: Option<&str>,
) -> Result<DshUsageFactEmitResult, String> {
    // §4.1 分层：读/解码。read_session_text 的 Err 就是错误码字符串。
    let text = read_session_text(path)
        .map_err(|code| format!("{}: {}", code, read_error_message(code)))?;

    // §4.1 分层：解析（整份可用才继续；降级 = 整份不可用，不是读到 0 条）。
    let parsed = parse_session_log(&text);
    let usage_events = match parsed.get("usage_events") {
        Some(Value::Array(arr)) => arr.clone(),
        _ => {
            let reason = parsed
                .get("degraded")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            return Err(format!("parse-degraded: session parse degraded ({reason})"));
        }
    };

    // §4.1 分层：身份（缺 session id 不是 DSH 会话）。空串 id 同缺失（r2a 的
    // `dsh_header` 对 `"id":""` 给 Some("")，空 id 会送进 builder 被拒、身份成谜）→
    // 在这里即硬错误。
    let Some((native_session_id, cwd)) = dsh_header(&text) else {
        return Err(
            "missing-session-id: session header is missing id (not a DSH session or \
             cannot establish identity)"
                .to_string(),
        );
    };
    if native_session_id.is_empty() {
        return Err(
            "missing-session-id: session header is missing id (not a DSH session or \
             cannot establish identity)"
                .to_string(),
        );
    }

    // §4.1 分层：归属。显式 profile 优先；空串不当证据（同 None——把空身份送进
    // builder 会让 Python 抛 ValueError 而 Rust 走 Err，两侧为同一输入报不同的错）
    // → 落到 cwd 派生或 unattributed，两语言行为恒一。cwd 缺失 → 硬错误 + actionable。
    let profile: String = match source_profile {
        Some(p) if !p.is_empty() => p.to_string(),
        _ => match &cwd {
            Some(cwd) => dsh_source_profile(Some(cwd)),
            None => {
                return Err(
                    "unattributed: session header has no cwd; pass an explicit \
                     --source-profile <P>"
                        .to_string(),
                );
            }
        },
    };

    // 分叉过滤一次、两个消费方共用。observer 内部再 post_fork 一次（幂等）；
    // `usage_fold_checkpoint` 不自己 post_fork（调用方负责），这里显式 post_fork 后
    // 传给两者。
    let post_events = post_fork(&usage_events);
    let observations = dsh_usage_observations(&post_events);
    let state = usage_fold_checkpoint(&post_events);

    // §3.5/§4.1 守卫：出账前 seen-set 查重。fold 去重是**相邻 run**，非相邻同
    // compactionId 重现会折出两条同 source_event_id 的槽——检出即整份硬错误、不静默
    // 去重（吞掉后一条会让 UsageFact 总量与 fold 总量对不上账）。
    let mut seen: HashSet<String> = HashSet::new();
    let mut facts: Vec<Value> = Vec::new();
    for obs in &observations {
        if seen.contains(&obs.source_event_id) {
            return Err(format!(
                "duplicate-source-event-id: duplicate source_event_id: {}",
                obs.source_event_id
            ));
        }
        seen.insert(obs.source_event_id.clone());
        let fact = observation_to_usage_fact(obs, machine_namespace, &native_session_id, &profile)
            .map_err(|problems| format!("internal: {}", problems.join("; ")))?;
        facts.push(fact);
    }

    // §4.2 coverage：unaccounted 是「文件报了 token 形状但 fold/事实都没接住」的残差
    // 哨兵（usage_fold_checkpoint 的 unaccounted → 求和）。`observation_rows ==
    // fact_rows` 由「无 fake-empty / 部分成功路径」无条件保证，不靠兜底计数凑。
    let (unaccounted_events, unaccounted_tokens) = state.unaccounted.iter().fold(
        (0i64, 0i64),
        |(events, tokens), (_t, (count, tokens_seen))| {
            (events + *count as i64, tokens + *tokens_seen)
        },
    );
    let workflow_events = crate::harnesses::dsh::sessions::workflow::from_events(
        parsed
            .get("execution_events")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]),
        parsed
            .get("usage_events")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]),
        &native_session_id,
        machine_namespace,
        &profile,
    );
    Ok(DshUsageFactEmitResult {
        facts,
        workflow_events,
        observation_rows: observations.len(),
        unaccounted_events,
        unaccounted_tokens,
    })
}

/// CLI `--json` 输出的完整 payload——spec §5 字面 `{facts, coverage}`（键序固定），
/// 与 Python `cli.py` 的 `dsh-usage-facts` handler 的 payload dict 插入序一致。
pub fn to_payload_value(result: &DshUsageFactEmitResult) -> Value {
    let mut out = Map::new();
    out.insert("facts".to_string(), json!(result.facts));
    let mut cov = Map::new();
    cov.insert("observation_rows".to_string(), json!(result.observation_rows));
    cov.insert("fact_rows".to_string(), json!(result.facts.len()));
    cov.insert("unaccounted_events".to_string(), json!(result.unaccounted_events));
    cov.insert("unaccounted_tokens".to_string(), json!(result.unaccounted_tokens));
    out.insert("coverage".to_string(), Value::Object(cov));
    Value::Object(out)
}

/// 人读摘要——与 Python handler 的 print 同源（diagnostic 面，不是 parity 面）。
pub fn to_human_summary(result: &DshUsageFactEmitResult, path: &Path, machine_namespace: &str) -> String {
    format!(
        "Source: {}\nMachine namespace: {}\nFacts: {} (observation_rows={}, \
         unaccounted_events={}, unaccounted_tokens={})\nCoverage: \
         {{'observation_rows': {}, 'fact_rows': {}, 'unaccounted_events': {}, \
         'unaccounted_tokens': {}}}\n",
        path.display(),
        machine_namespace,
        result.facts.len(),
        result.observation_rows,
        result.unaccounted_events,
        result.unaccounted_tokens,
        result.observation_rows,
        result.facts.len(),
        result.unaccounted_events,
        result.unaccounted_tokens,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_file(name: &str) -> std::path::PathBuf {
        // 唯一后缀：多个测试并发同用 `slot.jsonl` 这类名字会互相覆盖
        // （pid 相同、名字相同），偶发 flake——按调用时刻打点。
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let tmp = std::env::temp_dir().join(format!(
            "av-dsh-usage-fact-test-{}-{nanos}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&tmp);
        tmp
    }

    /// 最小 DSH 会话：header + request/header（pro）+ 一个 usage chunk（槽 (1,1)）+
    /// message shadow（同一槽、覆盖四桶）+ turn/end。镜像 resume.jsonl 槽 (1,1) 的
    /// wire 形状（camelCase 桶名）。
    fn one_slot_session(id: &str, cwd: &str) -> String {
        format!(
            r#"{{"type":"session","version":0,"id":"{id}","createdAt":1750000000000,"cwd":"{cwd}"}}
{{"type":"turn/start","seq":1,"time":1750000001000,"data":{{"turn":1}}}}
{{"type":"request/header","seq":2,"time":1750000002000,"data":{{"header":{{"config":{{"model":"deepseek/deepseek-v4-pro-0813","provider":"shengsuanyun"}}}}}}}}
{{"type":"assistant/chunk","seq":3,"time":1750000003000,"data":{{"turn":1,"step":1,"chunk":{{"type":"usage","usage":{{"inputTokens":1000,"outputTokens":200,"cacheReadTokens":300}}}}}}}}
{{"type":"assistant/message","seq":4,"time":1750000004000,"data":{{"turn":1,"step":1,"usage":{{"inputTokens":1200,"outputTokens":250,"cacheReadTokens":300}}}}}}
{{"type":"turn/end","seq":5,"time":1750000005000,"data":{{"turn":1}}}}
"#
        )
    }

    #[test]
    fn rfc3339_epoch_zero_and_resume_timestamps() {
        assert_eq!(rfc3339_ms_z(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(rfc3339_ms_z(1750000000000), "2025-06-15T15:06:40.000Z");
        assert_eq!(rfc3339_ms_z(1750000003000), "2025-06-15T15:06:43.000Z");
        // 毫秒位保留
        assert_eq!(rfc3339_ms_z(1750000003456), "2025-06-15T15:06:43.456Z");
    }

    #[test]
    fn emits_one_slot_from_reconstructed_session() {
        let p = temp_file("slot.jsonl");
        std::fs::write(&p, one_slot_session("sess-x", "/tmp/dshfx/workdir")).unwrap();
        let r = dsh_session_to_usage_facts(&p, "ns-test", None).unwrap();
        assert_eq!(r.facts.len(), 1);
        assert_eq!(r.observation_rows, 1);
        assert_eq!(r.unaccounted_events, 0);
        assert_eq!(r.unaccounted_tokens, 0);
        let f = &r.facts[0];
        assert_eq!(f.get("harness").and_then(Value::as_str), Some("dsh"));
        assert_eq!(f.get("native_session_id").and_then(Value::as_str), Some("sess-x"));
        assert_eq!(
            f.get("source_profile").and_then(Value::as_str),
            Some("---tmp-dshfx-workdir--")
        );
        assert_eq!(f.get("identity_basis").and_then(Value::as_str), Some("derived-hash"));
        assert_eq!(f.get("turn").and_then(Value::as_i64), Some(1));
        assert_eq!(f.get("step").and_then(Value::as_i64), Some(1));
        assert_eq!(f.get("model_raw").and_then(Value::as_str), Some("deepseek/deepseek-v4-pro-0813"));
        assert_eq!(f.get("provider_raw").and_then(Value::as_str), Some("shengsuanyun"));
        // shadow 支配：uncached=1200（message），cacheRead=300
        assert_eq!(f.get("uncached_input_tokens").and_then(Value::as_i64), Some(1200));
        assert_eq!(f.get("cache_read_tokens").and_then(Value::as_i64), Some(300));
        assert_eq!(f.get("cache_write_tokens"), Some(&Value::Null));
        assert_eq!(f.get("time_basis").and_then(Value::as_str), Some("native"));
        assert_eq!(f.get("event_ts_utc").and_then(Value::as_str), Some("2025-06-15T15:06:44.000Z"));
        assert!(f.get("source_event_id").and_then(Value::as_str).unwrap().starts_with("request:derived:"));
        let payload = to_payload_value(&r);
        assert_eq!(payload["coverage"]["fact_rows"].as_i64(), Some(1));
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn explicit_profile_wins_over_header_cwd() {
        let p = temp_file("slot.jsonl");
        std::fs::write(&p, one_slot_session("sess-x", "/tmp/dshfx/workdir")).unwrap();
        let r = dsh_session_to_usage_facts(&p, "ns-test", Some("project-alpha")).unwrap();
        assert_eq!(
            r.facts[0].get("source_profile").and_then(Value::as_str),
            Some("project-alpha")
        );
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn missing_header_id_is_missing_session_id_error() {
        let p = temp_file("noid.jsonl");
        // type=session 无 id → 解析成功但无法建身份
        std::fs::write(
            &p,
            r#"{"type":"session","version":0,"cwd":"/tmp/dshfx/workdir"}"#,
        )
        .unwrap();
        let err = dsh_session_to_usage_facts(&p, "ns-test", None).unwrap_err();
        assert!(err.starts_with("missing-session-id:"), "{err}");
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn empty_string_id_is_missing_session_id_error() {
        let p = temp_file("emptyid.jsonl");
        std::fs::write(&p, r#"{"type":"session","version":0,"id":"","cwd":"/tmp/x"}"#).unwrap();
        let err = dsh_session_to_usage_facts(&p, "ns-test", None).unwrap_err();
        assert!(err.starts_with("missing-session-id:"), "{err}");
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn no_cwd_without_explicit_profile_is_unattributed() {
        let p = temp_file("nocwd.jsonl");
        std::fs::write(&p, one_slot_session("sess-x", "")).unwrap();
        // header 无 cwd 键（one_slot_session 的 cwd 为空串 → dsh_header 给 Some("")，
        // 不是 None）——构造真正缺 cwd 键的文件：
        let text = one_slot_session("sess-x", "X").replace(r#","cwd":"X""#, "");
        std::fs::write(&p, text).unwrap();
        let err = dsh_session_to_usage_facts(&p, "ns-test", None).unwrap_err();
        assert!(err.starts_with("unattributed:"), "{err}");
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn missing_file_is_read_hard_error() {
        let err = dsh_session_to_usage_facts(
            &std::path::PathBuf::from("/no/such/session.jsonl"),
            "ns-test",
            None,
        )
        .unwrap_err();
        assert_eq!(err, "file-missing: session file missing or unreadable");
    }

    #[test]
    fn degraded_body_is_parse_degraded_not_empty_success() {
        let p = temp_file("degraded.jsonl");
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(br#"{"type":"session","version":0,"id":"s","cwd":"/tmp/x"}"#).unwrap();
        f.write_all(b"\n{not json}\n").unwrap();
        drop(f);
        let err = dsh_session_to_usage_facts(&p, "ns-test", None).unwrap_err();
        assert!(err.starts_with("parse-degraded: session parse degraded (non-json)"), "{err}");
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn duplicate_source_event_id_is_hard_error() {
        // 守卫抓的是 fold 相邻-run 去重漏不掉的**非相邻重现**：同 compactionId 的
        // compaction 相邻出现会被 observer 折进同一槽（shadow，1 个 observation）；
        // 中间隔一个异 key 槽再重现，observer 会开第二个槽、且 source_event_id
        // 恒为 "compaction:cmp-1" → 两条同 id → 守卫必须整份拒绝（不静默去重——
        // 吞掉后一条会让 UsageFact 总量与 fold 总量对不上账）。
        let p = temp_file("dup.jsonl");
        let header = r#"{"type":"session","version":0,"id":"s","cwd":"/tmp/x"}"#;
        let comp = |id: &str| {
            format!(
                r#"{{"type":"compaction/summary","seq":5,"time":1750000005000,"data":{{"compactionId":"{id}","model":"deepseek-v4-flash","provider":"deepseek-official","usage":{{"inputTokens":462,"outputTokens":100,"cacheReadTokens":100}}}}}}"#
            )
        };
        let normal = r#"{"type":"assistant/chunk","seq":6,"time":1750000006000,"data":{"turn":1,"step":1,"chunk":{"type":"usage","usage":{"inputTokens":5,"outputTokens":1}}}}"#;
        std::fs::write(&p, format!("{header}\n{}\n{normal}\n{}\n", comp("cmp-1"), comp("cmp-1")))
            .unwrap();
        let err = dsh_session_to_usage_facts(&p, "ns-test", None).unwrap_err();
        assert!(err.starts_with("duplicate-source-event-id:"), "{err}");
        assert!(err.contains("compaction:cmp-1"), "{err}");
        std::fs::remove_file(&p).ok();
    }
}
