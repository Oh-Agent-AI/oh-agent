//! v0.7 Stage 3：source-event 身份原语（canonical JSON + FNV-1a）共享层。
//!
//! R3 拍板（2026-09-03，docs/VITALS_CORE_V0_7_STAGE_3_DSH_ADAPTER.md §7）：
//! 「observer 是身份形成边界」要求 observer 开槽即算出 `source_event_id`，而
//! canonical+FNV 是跨语言共享的纯函数——**不许在 usage.rs 里长第二份**。本模块
//! 把 Stage 1 Claude emitter 的 helper 抽出来，四方共同调用：
//!
//! ```text
//! Claude adapter ─┐
//! Codex adapter  ─┼─► source_identity
//! DSH observer   ─┤
//! UsageFact ID   ─┘
//! ```
//!
//! **过渡归属**：本模块暂居 vitals-core，只为让已拆 crates 的调用方（binary 的
//! claude/codex emitter、core 的 usage observer / usage_fact）能同一处引用。这是
//! Agent UsageFact/source-event 身份契约，不是任意领域都要的通用机制——将来拆出
//! `agent-vitals-harnesses` crate 时，本模块整体迁往
//! `agent-vitals-harnesses/src/shared/source_identity.rs`，不带 vitals-core 尾巴。
//!
//! Python 镜像：`scripts/agent_vitals/source_identity.py`（同字节）。
//! Stage 1/2 parity 钉测已跨语言验证两侧对同一输入产同字节。

use serde_json::Value;

/// FNV-1a 64 → 16 hex——与 Python `source_identity.fnv1a64_hex` 同一初值/乘子
/// （初值 0xcbf29ce484222325、乘子 0x100000001b3、`{:016x}` 小写无前缀）。
/// 这里 hash 的是 canonical row/身份串，不是 identity 元组，所以返回裸 hex、
/// 不带 "uf1-"（`fact_id` 另拼前缀）。
pub fn fnv1a64_hex(bytes: &[u8]) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for &b in bytes {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{:016x}", h)
}

/// JSON 字符串转义——与 Python `json.dumps(..., ensure_ascii=False)` 同一组：
/// `"` `\` `\b` `\f` `\n` `\r` `\t`，其余 < 0x20 用 `\u00xx`；非 ASCII 原样
/// 输出（UTF-8 字节写进 out）。两边对同一输入产出相同字节，canonical 才成立。
fn push_json_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// canonical JSON 序列化：对象键按字节序排序、紧凑分隔 `,`/`:`、不转义非
/// ASCII。递归直写进 `out`。
///
/// 与 Python `json.dumps(value, sort_keys=True, separators=(",", ":"),
/// ensure_ascii=False)` 字节一致的前提：被序列化的数值只有整数（derived-hash
/// 的 identity row / usage row 里 token 计数都是整数；float costUSD 只在
/// cost-state，不产 fact）；整数两边都是十进制。若未来真机在 canonical 行里出现
/// 浮点，Python float repr 与 serde_json (ryu) 的最短表示可能分叉——文档化的
/// 已知边界，不用浮点就碰不到。codex token_count 的 `rate_limits.*.used_percent`
/// 是真机浮点（0..100 区间），canonical 分叉只会在区间外的小/大浮点出现——
/// usage-fact fixture 与真机值都在 0..100，parity 钉测带着浮点行跑，分叉当场红。
pub fn canonical_json(v: &Value, out: &mut String) {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&n.to_string()),
        Value::String(s) => push_json_string(s, out),
        Value::Array(a) => {
            out.push('[');
            for (i, item) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                canonical_json(item, out);
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                push_json_string(k, out);
                out.push(':');
                canonical_json(map.get(*k).expect("key from keys()"), out);
            }
            out.push('}');
        }
    }
}
