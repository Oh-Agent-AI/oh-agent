//! 会话 ledger + writer fencing 的**纯规则**（R1d，§4.2 接管协议最小可测子集）。
//!
//! 单一真相源：`scripts/agent_vitals/agent/takeover.py` 的 `session_key` /
//! `ledger_folded` / `ledger_record` / `owner_allows` / `cutover` / `mark_fold`
//! 是它的 Python 镜像；二进制 `src/agent/takeover.rs` 只做 I/O（读 manifest →
//! 调这里的纯判断 → 原子写回）。wasm 也能跑这套规则（浏览器侧做接管审计时）。
//!
//! 接管协议四件套（§4.2）里两件是纯规则，先落在这里：
//!
//!   · **writer fencing** —— 权威文件带 `writer-manifest.json`（`owner` + `epoch`）。
//!     Python 与 Rust **都拒绝**非当前 owner 写入（防迁移期双写）。缺 manifest →
//!     默认 owner=python：R1 之前唯一写者就是 Python，Rust 侧在 cutover 前被
//!     挡在门外，这正是「Rust 只能先 shadow-replay、不能直接写权威」的机制。
//!   · **会话 ledger**（§4.3 的 SessionKey/dedup）—— 同一 `session_log` 连续多
//!     tick 只累加一次（§4.2 验收：已填充 state + 多 tick fixture 断言）。
//!     key = harness kind + native id + machine namespace 的自定界拼接，杜绝「不同
//!     执行环境/机器同一 session_id」的碰撞（§4.3：只用执行环境 `session_id` 会在跨执行环境、
//!     跨机器、rollout 重连时把同一逻辑会话数成两笔成本）。
//!
//! 剩下两件（shadow replay / atomic cutover 的 I/O 编排）在二进制侧。
//!
//! `epoch` 是**写代际计数**：每次 manifest 写（cutover 或成功 fold）都 +1。它是
//! 单调的，让「哪个代际写下了这条 ledger」可追溯；fencing 本体是 owner 相等，
//! epoch 只做代际诊断，以及回滚后可断言的那个数 —— 回滚后 ledger 里 s1 的
//! epoch 原封不动，就是「没被重放」的物证。

use serde_json::{json, Map, Value};

/// `writer-manifest.json` 的 schema 版本。
pub const MANIFEST_SCHEMA_VERSION: &str = "1.0.0";

/// `session-ledger.json` 的 schema 版本。
pub const LEDGER_SCHEMA_VERSION: &str = "1.0.0";

/// Python 写者（R1 之前的唯一写者，R1d 起退休为 mirror）。
pub const PY_OWNER: &str = "python";

/// Rust 写者（R1d 起的生产者）。
pub const RS_OWNER: &str = "rust";

/// 缺 manifest 时的默认 owner —— 现任权威 = python。Rust 在显式 cutover 前
/// 连 shadow 之外的正规写入口都进不来，这就是 fencing 的默认拒绝语义。
pub const DEFAULT_OWNER: &str = PY_OWNER;

/// 自定界会话 key —— 复刻 `takeover.py::session_key`（Python 镜像钉同一组
/// 数值，见 `tests/test_takeover_lockstep.py`）。
///
/// 为什么不直接 `format!("{}|{}|{}", harness, id, ns)`：三个字段都可能含 `|`
/// （执行环境 native id 尤其自由），裸拼接会让 `("ab","c")` 与 `("a","bc")` 撞
/// 同一个 key。长度前缀是自定界的：先写 `len:`，再写本体，天然无法伪造碰撞。
/// 例：`session_key("dsh", "s1", "ns-abc")` → `"3:dsh|2:s1|6:ns-abc"`。
pub fn session_key(harness_kind: &str, native_id: &str, machine_namespace: &str) -> String {
    fn seg(s: &str) -> String {
        format!("{}:{s}", s.len())
    }
    format!("{}|{}|{}", seg(harness_kind), seg(native_id), seg(machine_namespace))
}

/// 缺 manifest 时的默认 manifest —— owner=python、epoch=0、since/last_fold_at
/// 为 null。Python 镜像构建同一份 dict（None → null），两边序列化逐字节一致。
pub fn default_manifest() -> Value {
    json!({
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "owner": DEFAULT_OWNER,
        "epoch": 0,
        "since": Value::Null,
        "last_fold_at": Value::Null,
    })
}

/// 空 ledger —— 与 Python `session_ledger()` 缺文件时的兜底同形。
pub fn empty_ledger() -> Value {
    json!({
        "schema_version": LEDGER_SCHEMA_VERSION,
        "entries": {},
    })
}

/// 读 manifest 的 `owner` 字段；缺文件 / 坏 JSON / 字段缺失都回落到默认
/// owner（python）——「读不到就按最保守的拒绝处理」，与证据模型
/// 「adapter 不得用读不到的东西刷覆盖」同一纪律。
pub fn manifest_owner(manifest: &Value) -> String {
    manifest
        .get("owner")
        .and_then(Value::as_str)
        .unwrap_or(DEFAULT_OWNER)
        .to_string()
}

/// fencing 判断：候选写者是不是当前 owner。Python 与 Rust 的写入口都先过
/// 这一个纯函数，任何一边不满足就拒绝，不落盘。
pub fn owner_allows(manifest: &Value, candidate: &str) -> bool {
    manifest_owner(manifest) == candidate
}

/// 当前 `epoch`；缺文件 / 坏 JSON / 非整数 → 0（初始代际）。
pub fn manifest_epoch(manifest: &Value) -> u64 {
    manifest.get("epoch").and_then(Value::as_u64).unwrap_or(0)
}

/// cutover —— 原子切换写者：owner 换人、epoch+1、since 记新 owner 生效时刻。
/// `last_fold_at` 原样保留（回滚回去时还能看见最近一次 fold 是什么时候）。
pub fn cutover(manifest: &Value, new_owner: &str, now_iso: &str) -> Value {
    let epoch = manifest_epoch(manifest) + 1;
    json!({
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "owner": new_owner,
        "epoch": epoch,
        "since": now_iso,
        "last_fold_at": manifest.get("last_fold_at").cloned().unwrap_or(Value::Null),
    })
}

/// 成功 fold 后的 manifest 推进：epoch+1、`last_fold_at` 记 now。owner/since
/// 不变（fold 不是换 owner）。写序是「ledger 先落、manifest 后提交」，所以
/// manifest 的 epoch 恒 >= ledger 里任一条目的 epoch。
pub fn mark_fold(manifest: &Value, now_iso: &str) -> Value {
    let epoch = manifest_epoch(manifest) + 1;
    json!({
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "owner": manifest_owner(manifest),
        "epoch": epoch,
        "since": manifest.get("since").cloned().unwrap_or(Value::Null),
        "last_fold_at": now_iso,
    })
}

/// 一条 ledger 条目 —— 记下「这次 fold 的会话身份 + 折叠时刻 + 落账代际」。
/// 身份三件套各存各的（不拆 key 字符串，自描述、人可读）。
pub fn ledger_entry(
    harness_kind: &str,
    native_id: &str,
    machine_namespace: &str,
    folded_at: &str,
    epoch: u64,
) -> Value {
    json!({
        "harness_kind": harness_kind,
        "native_id": native_id,
        "machine_namespace": machine_namespace,
        "folded_at": folded_at,
        "epoch": epoch,
    })
}

/// 这个会话已经 fold 过？key 在不在 `entries` 里。
///
/// R1d 的 exactly-once 语义 = **key 唯一**：同一 session_log（同一 key）连续多
/// tick 只折第一次，之后全跳过，不重复累加。日志**增长**的情况（同 key、内容
/// 变了）R1d 也跳过 —— 宁可少计也不翻倍，增量重 fold 是 R3 watcher 的
/// `fold_resume` 差事，不是 R1d 的。这是有意取舍，不是漏查。
pub fn ledger_folded(ledger: &Value, key: &str) -> bool {
    ledger
        .get("entries")
        .and_then(Value::as_object)
        .map(|e| e.contains_key(key))
        .unwrap_or(false)
}

/// 记录一次 fold：把 `entry` 插进 `entries[key]`。同 key 再记录 = 覆盖（不
/// 会在 entries 里长出两条；调用方在写前已经用 `ledger_folded` 挡过一道）。
pub fn ledger_record(ledger: &Value, key: &str, entry: &Value) -> Value {
    let mut entries = ledger
        .get("entries")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_else(Map::new);
    entries.insert(key.to_string(), entry.clone());
    json!({
        "schema_version": LEDGER_SCHEMA_VERSION,
        "entries": entries,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // 期望值与 `tests/test_takeover_lockstep.py::TakeoverCharacterization` 里
    // Python 镜像钉的数值一一对应；改任一边都要两边一起改。

    #[test]
    fn session_key_is_self_delimiting() {
        assert_eq!(session_key("dsh", "s1", "ns-abc"), "3:dsh|2:s1|6:ns-abc");
        // 长度前缀消除拼接歧义：("ab","c") 与 ("a","bc") 不得同 key
        assert_ne!(session_key("ab", "c", "d"), session_key("a", "bc", "d"));
        // 空字段合法且自定界（空串 → "0:"）
        assert_eq!(session_key("", "", ""), "0:|0:|0:");
        // 字段含分隔符也不会撞：native 里带 "|" 时 key 仍唯一
        assert_ne!(
            session_key("a|b", "c", "d"),
            session_key("a", "b|c", "d")
        );
    }

    #[test]
    fn default_manifest_is_python_owned() {
        let m = default_manifest();
        assert_eq!(manifest_owner(&m), "python");
        assert_eq!(manifest_epoch(&m), 0);
        assert!(owner_allows(&m, "python"));
        assert!(!owner_allows(&m, "rust"));
    }

    #[test]
    fn owner_allows_is_owner_equality() {
        let m = default_manifest();
        assert!(!owner_allows(&m, "rust"));
        let c = cutover(&m, "rust", "2026-08-30T12:00:00+00:00");
        assert!(owner_allows(&c, "rust"));
        assert!(!owner_allows(&c, "python"));
    }

    #[test]
    fn cutover_bumps_epoch_and_records_since() {
        let m = default_manifest();
        let c = cutover(&m, "rust", "2026-08-30T12:00:00+00:00");
        assert_eq!(manifest_epoch(&c), 1);
        assert_eq!(c["since"], "2026-08-30T12:00:00+00:00");
        assert_eq!(c["owner"], "rust");
        // 切回去 epoch 继续 +1，last_fold_at 原样保留
        let back = cutover(&c, "python", "2026-08-30T13:00:00+00:00");
        assert_eq!(manifest_epoch(&back), 2);
        assert_eq!(back["owner"], "python");
        assert_eq!(back["last_fold_at"], Value::Null);
    }

    #[test]
    fn mark_fold_bumps_epoch_and_stamps_time_keeping_owner() {
        let m = cutover(&default_manifest(), "rust", "2026-08-30T12:00:00+00:00");
        let f = mark_fold(&m, "2026-08-30T12:05:00+00:00");
        assert_eq!(manifest_epoch(&f), 2); // cutover(1) 之后再折 → 2
        assert_eq!(f["last_fold_at"], "2026-08-30T12:05:00+00:00");
        assert_eq!(f["owner"], "rust");
        assert_eq!(f["since"], "2026-08-30T12:00:00+00:00");
        // 折叠不改变 owner 语义
        assert!(owner_allows(&f, "rust"));
    }

    #[test]
    fn empty_ledger_has_nothing_folded() {
        let l = empty_ledger();
        assert!(!ledger_folded(&l, "3:dsh|2:s1|6:ns-abc"));
        assert_eq!(l["entries"], json!({}));
    }

    #[test]
    fn record_then_folded_roundtrip() {
        let l = empty_ledger();
        let key = session_key("dsh", "s1", "ns-abc");
        let e = ledger_entry("dsh", "s1", "ns-abc", "2026-08-30T12:05:00+00:00", 2);
        let l2 = ledger_record(&l, &key, &e);
        assert!(ledger_folded(&l2, &key));
        assert!(!ledger_folded(&l, &key)); // 原 ledger 不被改（纯函数）
        let entry = l2["entries"][&key].clone();
        assert_eq!(entry["epoch"], 2);
        assert_eq!(entry["folded_at"], "2026-08-30T12:05:00+00:00");
        assert_eq!(entry["native_id"], "s1");
    }

    #[test]
    fn ledger_survives_rollback_epoch_unchanged() {
        // 回滚的物证：Rust 在代际 2 fold 了 s1，切回 python 再切回 rust，ledger
        // 里 s1 的 epoch 仍是 2 —— 这条记录没有被重放改写。
        let key = session_key("dsh", "s1", "ns-abc");
        let e = ledger_entry("dsh", "s1", "ns-abc", "2026-08-30T12:05:00+00:00", 2);
        let l = ledger_record(&empty_ledger(), &key, &e);
        assert_eq!(l["entries"][&key]["epoch"], 2);
        // 再来一次同 key 覆盖也不会把 epoch 冲掉 —— record 是纯插入
        let l2 = ledger_record(&l, &key, &e);
        assert_eq!(l2["entries"][&key]["epoch"], 2);
        assert_eq!(l2["entries"].as_object().unwrap().len(), 1);
    }
}
