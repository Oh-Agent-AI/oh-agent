//! v0.7 spec §2：统一事实行（`UsageFact`）—— 逻辑 schema 的序列化契约
//! （候选 #3）+ 迁移函数表的通用骨架（候选 #4）。
//!
//! **这不是一次数据平面迁移**：本模块只是候选 #3 描述的"共享序列化契约"这
//! 一层——build/validate/`fact_id` 三个纯函数 + 迁移链的通用 walker，没有
//! 任何 harness adapter 被改造成产出 `UsageFact`、没有任何持久化格式被替换。
//! 现有四条账（dsh state 链 / codex 静态 fold / claude ledger / workbuddy
//! credit_json）继续原样工作，本模块不触碰它们一个字节。这是 v0.7 spec 状态
//! 行明确写的"本版整体仍未立项"下，唯一能安全独立交付的一块：纯计算、零
//! I/O、零现有格式变更，随时可以被拿掉而不影响任何现有功能。
//!
//! **明确没做的**（诚实边界，不是遗漏）：
//! - 没有把任何一个 harness adapter 接上这份契约——那需要逐执行环境的迁移评审
//!   （§0.3 的顺序约束），本模块只是评审前置的"契约先写清楚"那一步。
//! - `billing_date` 派生列（§2.1 时间行）没有在这里实现——它依赖峰谷/归日
//!   规则版本，本身就是"版本化视图投影"（spec 原文），不是基本事实的一部分；
//!   放进 builder 会把版本化的派生逻辑焊死在契约层，违反"事实保留原始时间
//!   分辨率、派生列可重建"的设计前提。
//! - 迁移函数表目前**没有注册任何真实迁移**——`CURRENT_SCHEMA_VERSION = 1`
//!   是这份契约的第一个版本，还没有 v2。`migrate_chain` 是通用 walker，用
//!   一组测试专用的合成迁移表验证机制本身（线性 vN→vN+1、拒绝跨版本跳迁、
//!   拒绝未来版本、幂等），不是靠一个假的生产迁移凑数。
//! - 没有文件级原子写入/fsync/故障注入（§5"迁移与故障恢复"）——那需要真实
//!   的持久化调用点才有意义验证；本模块目前是纯内存契约，硬写一套无人使用
//!   的文件 I/O 测不出真问题，只会制造一个自己骗自己通过的假验收。
//!
//! Python 镜像：`scripts/agent_vitals/agent/usage_fact.py`。

use serde_json::{json, Map, Value};

use crate::source_identity::fnv1a64_hex;

/// 当前 schema 版本（v0.7 spec §4.1：「新的 `UsageFact` 序列化契约从
/// `schema_version=1` 起步；旧 today/month/ledger 不是 `UsageFact` v0，不能
/// 靠改键假装无损迁移」）。
pub const CURRENT_SCHEMA_VERSION: u32 = 1;

/// §2.1 表的完整键清单——候选 #2（键名收敛为单一共享词表）在这份新契约上
/// 直接落地：Python/Rust 共享同一份字面量清单（parity 测试逐项比对），不是
/// 各自维护一份可能漂移的字段名。
///
/// **身份元组必须在文档里**——`machine_namespace` 与 `native_session_id`
/// 是 `fact_id` 的输入（§2.1「统一幂等键」公式），不写进文档则持久化后无法
/// 从文档独立复算主键，也无法审计跨机器/跨会话碰撞。两个字段同时是
/// `IDENTITY_INPUT_FIELDS`（builder 必填）与 `USAGE_FACT_FIELDS`（序列化
/// 必出）——同一份契约下「身份既不可缺也不可隐」。
pub const USAGE_FACT_FIELDS: &[&str] = &[
    // 身份
    "fact_id",
    "identity_basis",
    "observation_kind",
    "machine_namespace",
    "native_session_id",
    // 会话引用
    "session_key_ref",
    "session_key_orphan",
    // 来源
    "harness",
    "source_profile",
    "source_event_id",
    "source_revision",
    "adapter_version",
    // 模型归属
    "provider_raw",
    "endpoint_host",
    "model_raw",
    "provider_id",
    "model_id",
    "normalization_version",
    "route_evidence_id",
    "attribution_version",
    // 时间
    "event_ts_utc",
    "event_tz_basis",
    "time_basis",
    // 去重语义
    "source_usage_semantics",
    "provider_request_id",
    "provider_billing_id",
    "turn",
    "step",
    "call_id",
    // token 度量
    "uncached_input_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "output_tokens",
    // 计费归属
    "billing_source",
    "billing_mode",
    "pricing_basis",
    "billing_template_id",
    // 执行环境金额
    "amount_decimal",
    "currency",
    "amount_basis",
    // 套餐证据
    "account_ref",
    "billing_period_start",
    "billing_period_end",
    "product_scope",
    "quota_window",
    "is_using_overage",
    "evidence_basis",
];

/// 6 个身份输入字段缺一不可（§2.1「统一幂等键」公式的入参）——不含
/// `fact_id` 本身（那是这 6 个字段算出来的输出，不是输入）。
const IDENTITY_INPUT_FIELDS: &[&str] = &[
    "machine_namespace",
    "harness",
    "source_profile",
    "native_session_id",
    "source_event_id",
    "observation_kind",
];

/// token 度量必须是非负整数（真实 0 与缺失可区分——缺失时字段整体不在
/// `fields` 里，不会走到这条校验；`fields` 里显式给了就必须合法）。
const TOKEN_FIELDS: &[&str] = &[
    "uncached_input_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "output_tokens",
];

/// `fact_id` 哈希——v0.7 spec §2.1「统一幂等键」公式：
/// `hash(machine_namespace, harness, source_profile, native_session_id,
///       source_event_id, observation_kind)`。
///
/// 用 FNV-1a 而不是密码学哈希：与 `usage::compaction_identity` 同一条纪律——
/// 这个值只用作去重身份，不需要抗碰撞到密码学强度，避免给 core crate（wasm
/// 也要编译）新增依赖。FNV 原语本身取自 `source_identity::fnv1a64_hex`（同一
/// 边界，不许第三份 inline 拷贝——Stage 3 拍板把 UsageFact ID 也接进共享层）；
/// 跨语言字节相同由 Python 镜像同一算法保证（parity 测试钉住）。字段间用
/// `\x1f`（unit separator，真实字段值里几乎不可能出现的控制字符）拼接，防止
/// `("ab","c")` 与 `("a","bc")` 撞出同一个哈希。
pub fn fact_id(
    machine_namespace: &str,
    harness: &str,
    source_profile: &str,
    native_session_id: &str,
    source_event_id: &str,
    observation_kind: &str,
) -> String {
    let joined = [
        machine_namespace,
        harness,
        source_profile,
        native_session_id,
        source_event_id,
        observation_kind,
    ]
    .join("\u{1f}");
    format!("uf1-{}", fnv1a64_hex(joined.as_bytes()))
}

/// `fields` → 一份完整的 `UsageFact` 文档，或校验失败的问题清单（诚实报错，
/// 不猜、不吞）。
///
/// - 6 个身份输入字段（`IDENTITY_INPUT_FIELDS`）必须存在且非空字符串——
///   `fact_id` 由它们算出，缺一个就无法产生稳定身份。
/// - `identity_basis` 未显式给出时默认 `"native"`；调用方在用「规范化原始
///   记录 + 文件稳定身份」的 hash fallback 时**必须**显式传
///   `identity_basis="derived-hash"`（§2.1 原文纪律），本函数不会替调用方
///   做这个判断——它不知道 `source_event_id` 是不是真的来自执行环境原生 id。
/// - token 度量字段若给出，必须是非负整数；给出非法值时报具体字段名，不
///   静默清零或吞掉。
/// - `fact_id`/`schema_version` 由本函数计算/stamp，调用方传了会被覆盖
///   （身份必须内部一致，不接受外部声称的身份）。
/// - `USAGE_FACT_FIELDS` 里未被 `fields`覆盖的键，输出里统一置 `null`——
///   与「缺失与真实 0 必须可区分」的契约对应，`null` 是「这个执行环境没有这项
///   证据」，不是「这项是 0」。
pub fn build_usage_fact(fields: &Map<String, Value>) -> Result<Value, Vec<String>> {
    let mut problems = Vec::new();

    let get_str = |k: &str| -> Option<&str> {
        fields
            .get(k)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
    };
    let mut identity: Vec<&str> = Vec::with_capacity(IDENTITY_INPUT_FIELDS.len());
    for k in IDENTITY_INPUT_FIELDS {
        match get_str(k) {
            Some(v) => identity.push(v),
            None => problems.push(format!("missing or empty identity field: {k}")),
        }
    }
    for k in TOKEN_FIELDS {
        if let Some(v) = fields.get(*k) {
            let ok = v.is_null() || v.as_i64().is_some_and(|n| n >= 0);
            if !ok {
                problems.push(format!(
                    "token field must be a non-negative integer or null: {k}"
                ));
            }
        }
    }
    if !problems.is_empty() {
        return Err(problems);
    }

    let computed_fact_id = fact_id(
        identity[0],
        identity[1],
        identity[2],
        identity[3],
        identity[4],
        identity[5],
    );
    let mut out = Map::new();
    for k in USAGE_FACT_FIELDS {
        out.insert(
            (*k).to_string(),
            fields.get(*k).cloned().unwrap_or(Value::Null),
        );
    }
    out.insert("fact_id".to_string(), json!(computed_fact_id));
    out.insert(
        "identity_basis".to_string(),
        fields
            .get("identity_basis")
            .cloned()
            .unwrap_or_else(|| json!("native")),
    );
    out.insert("schema_version".to_string(), json!(CURRENT_SCHEMA_VERSION));
    Ok(Value::Object(out))
}

/// 一步迁移函数：旧版本文档 → 下一版本文档。纯函数，不做 I/O。
pub type MigrationStep = fn(Value) -> Value;

/// 迁移链结果——用带 `status` 标签的 JSON 而不是 Rust enum，方便 Python
/// 镜像输出同一形状（parity 测试直接比较整个结构）。
///
/// - `"current"`：文档已经是目标版本，原样返回，不是"迁移了一次空动作"。
/// - `"migrated"`：文档从旧版本走完整条链到达目标版本。
/// - `"future-readonly"`：文档版本号比目标版本新——**不迁移、不报错**，
///   原样返回并打一个 `warning`；调用方可以读但不得写回（§5「未知未来版本
///   拒绝写入、允许带告警只读」），写回与否是调用方的责任，本函数只负责
///   标注。
/// - `"error"`：文档缺 `schema_version` 字段，或链路中间某个中间版本没有
///   对应的迁移函数（迁移表本身不完整）——两种情况都不是"当前版本"也不是
///   "未来版本"，无法安全处理，诚实报错而不是瞎猜一个版本。
pub fn migrate_chain(
    doc: Value,
    migrations: &std::collections::BTreeMap<u32, MigrationStep>,
    target_version: u32,
) -> Value {
    // P1-2 修订：`schema_version` 必须是 u32 表示范围内的非负整数。`as u32`
    // 直接截断会让 u32::MAX+1 = 1（与 Python 镜像字节不同——Python int
    // 是任意精度），破坏跨语言一致性。截断前显式拒绝。
    let version: u32 = match doc.get("schema_version").and_then(Value::as_u64) {
        Some(v) if v <= u32::MAX as u64 => v as u32,
        Some(v) => {
            return json!({
                "status": "error",
                "doc": doc,
                "error": format!(
                    "schema_version {v} exceeds u32::MAX ({})",
                    u32::MAX
                ),
            });
        }
        None => {
            return json!({
                "status": "error",
                "doc": doc,
                "error": "missing schema_version",
            });
        }
    };
    if version == target_version {
        return json!({"status": "current", "doc": doc});
    }
    if version > target_version {
        return json!({
            "status": "future-readonly",
            "doc": doc,
            "warning": format!(
                "document schema_version {version} is newer than this reader's target {target_version}; read-only, do not write back"
            ),
        });
    }
    // 严格线性：v..target 逐步应用，禁止跨版本跳迁（§4.1）。
    let mut cur = doc;
    let mut v = version;
    while v < target_version {
        let Some(step) = migrations.get(&v) else {
            return json!({
                "status": "error",
                "doc": cur,
                "error": format!("no migration registered for schema_version {v} -> {}", v + 1),
            });
        };
        cur = step(cur);
        // P1-3 修订：迁移步必须实际把版本号抬到下一档。真实迁移若忘了
        // 升 schema_version，写链会拿旧格式当新格式写回——比「找不到迁移函数」
        // 更隐蔽，因为它返回了"migrated"标签。逐步校验，坏迁移立即报错。
        let next_v = cur
            .get("schema_version")
            .and_then(Value::as_u64)
            .map(|x| x as u32);
        match next_v {
            Some(next) if next == v + 1 => v += 1,
            Some(other) => {
                return json!({
                    "status": "error",
                    "doc": cur,
                    "error": format!(
                        "migration step for schema_version {v} did not advance version \
                         (got {other}, expected {})",
                        v + 1
                    ),
                });
            }
            None => {
                return json!({
                    "status": "error",
                    "doc": cur,
                    "error": format!(
                        "migration step for schema_version {v} removed schema_version \
                         field (expected {})",
                        v + 1
                    ),
                });
            }
        }
    }
    json!({"status": "migrated", "doc": cur})
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fact_id_is_deterministic_and_order_sensitive() {
        let a = fact_id("ns", "claude-code", "default", "sess-1", "evt-1", "message");
        let b = fact_id("ns", "claude-code", "default", "sess-1", "evt-1", "message");
        assert_eq!(a, b, "同输入必须同输出——fact_id 不能受调用顺序/时间影响");
        // 字段边界不能被拼接吞掉：("ab","c") 与 ("a","bc") 必须给出不同哈希。
        let c = fact_id("ab", "c", "default", "sess-1", "evt-1", "message");
        let d = fact_id("a", "bc", "default", "sess-1", "evt-1", "message");
        assert_ne!(
            c, d,
            "unit separator 分隔失效会让不同身份撞出同一个 fact_id"
        );
    }

    /// 与 `usage_fact.py::fact_id` 对同一组入参逐字节一致——手工交叉验证过
    /// 一次（两侧跑同一组入参得到同一个字符串），这里钉死那个值防回归。
    #[test]
    fn fact_id_matches_python_mirror_pinned_value() {
        assert_eq!(
            fact_id("m1", "claude-code", "default", "sess-1", "evt-1", "message"),
            "uf1-6831c1133defe99f"
        );
    }

    #[test]
    fn build_usage_fact_fills_all_fields_and_stamps_identity() {
        let mut fields = Map::new();
        fields.insert("machine_namespace".into(), json!("m1"));
        fields.insert("harness".into(), json!("claude-code"));
        fields.insert("source_profile".into(), json!("default"));
        fields.insert("native_session_id".into(), json!("sess-1"));
        fields.insert("source_event_id".into(), json!("evt-1"));
        fields.insert("observation_kind".into(), json!("message"));
        fields.insert("uncached_input_tokens".into(), json!(100));
        let out = build_usage_fact(&fields).unwrap();
        assert_eq!(out["schema_version"], CURRENT_SCHEMA_VERSION);
        assert_eq!(out["identity_basis"], "native");
        assert_eq!(
            out["fact_id"],
            fact_id("m1", "claude-code", "default", "sess-1", "evt-1", "message")
        );
        assert_eq!(out["uncached_input_tokens"], 100);
        // 未提供的字段必须存在且为 null——不是缺场，是显式"没有这项证据"。
        assert!(out.get("cache_read_tokens").is_some());
        assert!(out["cache_read_tokens"].is_null());
        assert_eq!(
            out.as_object().unwrap().len(),
            USAGE_FACT_FIELDS.len() + 1, // + schema_version（fact_id/identity_basis 已在 USAGE_FACT_FIELDS 里）
        );
    }

    /// P1-1 修订：`machine_namespace` 与 `native_session_id` 是 `fact_id` 入参
    /// （§2.1「统一幂等键」公式），必须写入文档——持久化后能从文档独立复算
    /// 主键。两字段同时是 `IDENTITY_INPUT_FIELDS`（必填）与
    /// `USAGE_FACT_FIELDS`（必出）。
    #[test]
    fn build_usage_fact_writes_identity_tuple_to_doc() {
        let mut fields: Map<String, Value> = Map::new();
        for (k, v) in [
            ("machine_namespace", json!("m1")),
            ("harness", json!("claude-code")),
            ("source_profile", json!("default")),
            ("native_session_id", json!("sess-1")),
            ("source_event_id", json!("evt-1")),
            ("observation_kind", json!("message")),
            ("uncached_input_tokens", json!(1)),
        ] {
            fields.insert(k.into(), v);
        }
        let out = build_usage_fact(&fields).unwrap();
        assert_eq!(out["machine_namespace"], "m1");
        assert_eq!(out["native_session_id"], "sess-1");
        // 从文档字段独立复算 fact_id → 必须字节相等。
        let reconstructed_fact_id = fact_id(
            out["machine_namespace"].as_str().unwrap(),
            out["harness"].as_str().unwrap(),
            out["source_profile"].as_str().unwrap(),
            out["native_session_id"].as_str().unwrap(),
            out["source_event_id"].as_str().unwrap(),
            out["observation_kind"].as_str().unwrap(),
        );
        assert_eq!(
            out["fact_id"],
            json!(reconstructed_fact_id),
            "fact_id 必须能从文档字段独立复算"
        );
    }

    #[test]
    fn build_usage_fact_rejects_missing_identity_fields_by_name() {
        let mut fields = Map::new();
        fields.insert("harness".into(), json!("claude-code"));
        let err = build_usage_fact(&fields).unwrap_err();
        // 5 个缺失字段各自报名字，不是一个笼统的"invalid"。
        assert!(err.iter().any(|m| m.contains("machine_namespace")));
        assert!(err.iter().any(|m| m.contains("source_profile")));
        assert!(err.iter().any(|m| m.contains("native_session_id")));
        assert!(err.iter().any(|m| m.contains("source_event_id")));
        assert!(err.iter().any(|m| m.contains("observation_kind")));
        assert!(!err
            .iter()
            .any(|m| m.contains("\"harness\"") || m.ends_with(" harness")));
    }

    #[test]
    fn build_usage_fact_rejects_negative_token_fields() {
        let mut fields = Map::new();
        for (k, v) in [
            ("machine_namespace", "m1"),
            ("harness", "h"),
            ("source_profile", "p"),
            ("native_session_id", "s"),
            ("source_event_id", "e"),
            ("observation_kind", "o"),
        ] {
            fields.insert(k.into(), json!(v));
        }
        fields.insert("output_tokens".into(), json!(-5));
        let err = build_usage_fact(&fields).unwrap_err();
        assert!(err.iter().any(|m| m.contains("output_tokens")));
    }

    #[test]
    fn build_usage_fact_respects_explicit_derived_hash_basis() {
        let mut fields = Map::new();
        for (k, v) in [
            ("machine_namespace", "m1"),
            ("harness", "h"),
            ("source_profile", "p"),
            ("native_session_id", "s"),
            ("source_event_id", "e"),
            ("observation_kind", "o"),
        ] {
            fields.insert(k.into(), json!(v));
        }
        fields.insert("identity_basis".into(), json!("derived-hash"));
        let out = build_usage_fact(&fields).unwrap();
        assert_eq!(out["identity_basis"], "derived-hash");
    }

    fn bump_version(mut doc: Value) -> Value {
        doc["schema_version"] = json!(doc["schema_version"].as_u64().unwrap() + 1);
        doc["migrated_through"] = json!(
            doc.get("migrated_through")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                + 1
        );
        doc
    }

    #[test]
    fn migrate_chain_walks_sequential_versions_not_a_jump() {
        let mut migrations: std::collections::BTreeMap<u32, MigrationStep> =
            std::collections::BTreeMap::new();
        migrations.insert(1, bump_version);
        migrations.insert(2, bump_version);
        let doc = json!({"schema_version": 1});
        let out = migrate_chain(doc, &migrations, 3);
        assert_eq!(out["status"], "migrated");
        assert_eq!(out["doc"]["schema_version"], 3);
        assert_eq!(
            out["doc"]["migrated_through"], 2,
            "必须经过两步，不是直接跳到 3"
        );
    }

    #[test]
    fn migrate_chain_current_version_is_a_noop_not_a_migration() {
        let migrations: std::collections::BTreeMap<u32, MigrationStep> =
            std::collections::BTreeMap::new();
        let doc = json!({"schema_version": 2, "x": 1});
        let out = migrate_chain(doc.clone(), &migrations, 2);
        assert_eq!(out["status"], "current");
        assert_eq!(out["doc"], doc);
    }

    #[test]
    fn migrate_chain_future_version_is_readonly_not_an_error() {
        let migrations: std::collections::BTreeMap<u32, MigrationStep> =
            std::collections::BTreeMap::new();
        let doc = json!({"schema_version": 5});
        let out = migrate_chain(doc, &migrations, 2);
        assert_eq!(out["status"], "future-readonly");
        assert_eq!(out["doc"]["schema_version"], 5, "不迁移、不篡改，原样返回");
        assert!(out["warning"].as_str().unwrap().contains("read-only"));
    }

    #[test]
    fn migrate_chain_missing_migration_step_is_an_honest_error() {
        // 只注册了 1->2，但目标是 3——2->3 缺失，不能假装能到达。
        let mut migrations: std::collections::BTreeMap<u32, MigrationStep> =
            std::collections::BTreeMap::new();
        migrations.insert(1, bump_version);
        let doc = json!({"schema_version": 1});
        let out = migrate_chain(doc, &migrations, 3);
        assert_eq!(out["status"], "error");
        assert_eq!(
            out["doc"]["schema_version"], 2,
            "已完成的那一步保留，不整体丢弃"
        );
    }

    #[test]
    fn migrate_chain_missing_schema_version_is_an_honest_error() {
        let migrations: std::collections::BTreeMap<u32, MigrationStep> =
            std::collections::BTreeMap::new();
        let out = migrate_chain(json!({"x": 1}), &migrations, 1);
        assert_eq!(out["status"], "error");
        assert_eq!(out["error"], "missing schema_version");
    }

    #[test]
    fn migrate_chain_is_idempotent_at_target_version() {
        let mut migrations: std::collections::BTreeMap<u32, MigrationStep> =
            std::collections::BTreeMap::new();
        migrations.insert(1, bump_version);
        let doc = json!({"schema_version": 1});
        let once = migrate_chain(doc, &migrations, 2);
        assert_eq!(once["status"], "migrated");
        let twice = migrate_chain(once["doc"].clone(), &migrations, 2);
        assert_eq!(twice["status"], "current");
        assert_eq!(twice["doc"], once["doc"]);
    }

    /// P1-2 修订：`schema_version` 超出 u32::MAX (=4294967295) → 显式
    /// 报错。Rust 侧 `as u32` 会截断成 1，Python int 是任意精度——显式校验
    /// 保证跨语言字节一致（4294967297 在 Rust 是 1，在 Python 是 4294967297，
    /// 都不应被默默接受）。
    #[test]
    fn migrate_chain_schema_version_exceeding_u32_max_is_an_honest_error() {
        let mut migrations: std::collections::BTreeMap<u32, MigrationStep> =
            std::collections::BTreeMap::new();
        migrations.insert(1, bump_version as MigrationStep);
        let out = migrate_chain(json!({"schema_version": 4_294_967_297u64}), &migrations, 2);
        assert_eq!(out["status"], "error");
        assert!(
            out["error"].as_str().unwrap().contains("exceeds u32::MAX"),
            "expected error mentioning u32::MAX, got: {:?}",
            out["error"]
        );
        // 边界：u32::MAX 本身仍合法（4294967295 → 截断到 4294967295，无信息丢失）。
        // 比 target_version=2 大得多，所以走 future-readonly 分支——不是
        // migrated 也合法，关键是**不**是 error（没被截断成 1→走迁移分支）。
        let out_max = migrate_chain(json!({"schema_version": u32::MAX as u64}), &migrations, 2);
        assert_ne!(
            out_max["status"], "error",
            "u32::MAX 边界必须不被截断——错误地当成 1 会进入 migrated 分支"
        );
        assert_eq!(
            out_max["status"], "future-readonly",
            "u32::MAX 比 target_version=2 大得多，正确分支是 future-readonly"
        );
    }

    /// P1-3 修订：迁移步必须实际把 schema_version 抬到下一档。真实迁移若
    /// 忘了升版本，写链会拿旧格式当新格式写回——比「找不到迁移函数」更隐蔽，
    /// 因为它返回了 "migrated" 标签。逐步校验，坏迁移立即报错。
    #[test]
    fn migrate_chain_must_advance_schema_version_per_step() {
        // 坏迁移：原样返回 doc（不动 schema_version）。
        fn bad_step_noop(d: Value) -> Value {
            d
        }
        let mut migrations: std::collections::BTreeMap<u32, MigrationStep> =
            std::collections::BTreeMap::new();
        migrations.insert(1, bad_step_noop);
        let out = migrate_chain(json!({"schema_version": 1}), &migrations, 2);
        assert_eq!(out["status"], "error");
        assert!(
            out["error"]
                .as_str()
                .unwrap()
                .contains("did not advance version"),
            "expected error mentioning 'did not advance version', got: {:?}",
            out["error"]
        );
        // 坏迁移：抬到错误档位（v+2 而非 v+1，跳迁）。
        fn bad_step_skip(d: Value) -> Value {
            let mut out = d.as_object().cloned().unwrap();
            out.insert("schema_version".into(), json!(3));
            Value::Object(out)
        }
        let mut migrations: std::collections::BTreeMap<u32, MigrationStep> =
            std::collections::BTreeMap::new();
        migrations.insert(1, bad_step_skip);
        let out = migrate_chain(json!({"schema_version": 1}), &migrations, 2);
        assert_eq!(out["status"], "error");
        assert!(out["error"]
            .as_str()
            .unwrap()
            .contains("did not advance version"));
        // 坏迁移：把 schema_version 字段直接删了。
        fn bad_step_remove(d: Value) -> Value {
            let mut out = d.as_object().cloned().unwrap();
            out.remove("schema_version");
            Value::Object(out)
        }
        let mut migrations: std::collections::BTreeMap<u32, MigrationStep> =
            std::collections::BTreeMap::new();
        migrations.insert(1, bad_step_remove);
        let out = migrate_chain(json!({"schema_version": 1}), &migrations, 2);
        assert_eq!(out["status"], "error");
        assert!(
            out["error"]
                .as_str()
                .unwrap()
                .contains("removed schema_version"),
            "expected error mentioning 'removed schema_version', got: {:?}",
            out["error"]
        );
    }

    #[test]
    fn usage_fact_fields_has_no_duplicates() {
        let mut seen = std::collections::HashSet::new();
        for f in USAGE_FACT_FIELDS {
            assert!(seen.insert(*f), "duplicate field in USAGE_FACT_FIELDS: {f}");
        }
    }
}
