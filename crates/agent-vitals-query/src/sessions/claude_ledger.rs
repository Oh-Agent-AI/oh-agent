//! Claude Code ledger 的只读取值面（v0.9 Stage 0.3，
//! `docs/AGENT_VITALS_V0_9_STAGE0_RESEARCH.md` §6）。
//!
//! `claude_cost.rs`（Claude Code 会话账 fold 引擎：`claude_sync`/fold/rebuild）
//! **整体没有搬**——它与留在 `apps/cli` 的 `claude_usage_fact.rs` 存在真实的
//! 双向耦合（互相 `use` 对方的函数），若整体搬进这个 crate 会把一个 pinned
//! 的 v0.7 UsageFact 发射器也拖进来，或者制造 runtime 反向依赖 apps/cli 的
//! 编译错误——两条路都不对。r2a_store.rs 只用到 `claude_ledger_day_tokens`
//! 一个函数，而这个函数是完全自包含的纯读取路径，与 fold 引擎零交集，所以
//! 单独抽成这个小文件搬过来，`claude_cost.rs` 本体原地留下。

use agent_vitals_domain::cost::claude_day_total_tokens;
use crate::state::{read_json, state_dir};
use serde_json::Value;

/// ledger 路径单点：`state_dir()/claude-ledger.json`。v0.9 Stage 0.4c 起
/// `summary.rs` 的 claude 执行环境金额也走这里——路径字面量只许出现这一处。
pub(crate) fn ledger_path() -> std::path::PathBuf {
    state_dir().join("claude-ledger.json")
}

/// ledger flat 日 → 4 型 token 总量。r2a_store 的 claude 执行环境行「今日 token」与
/// 托盘合并行的 `· N tokens` 都走这里。**求和委托 core `claude_day_total_tokens`**
/// ——键清单只在 core 一处定义（托盘是 src-tauri crate，够不到 apps/cli，只能
/// 用 core；本 crate 与 src-tauri 都归到 core，就不会长出第二份键集合）。
/// 非对象值（坏日）→ 0；但「读出 0」只发生在坏数据上，空日不落 ledger。
pub fn ledger_day_total_tokens(day: &Value) -> i64 {
    claude_day_total_tokens(day)
}

/// 读 ledger 当日（day_key = 北京日）的 4 型 token 总量 → r2a `sessions
/// navigation` 的 claude 执行环境行「今日 token」（spec §5.2 basis=ledger）。
///
/// 三种 None：ledger 不存在 / 无 `days` 键 / 当日缺席——都诚实报 None（托盘显
/// null/—，不编 0）。「空日不落 ledger」：days 里的日子全是 fold 真测到的桶
/// （cost-state 基线日 + 行尾归属日），当日缺席 = 今天没测到账，与 codex 当日
/// 桶缺席同语义。当日存在但总和 0（只有全零 unknown 桶的病理日）→ Some(0)，
/// 「测到 0」不是「没测」。
pub fn claude_ledger_day_tokens(day_key: &str) -> Option<i64> {
    let ledger = read_json(&ledger_path())?;
    let day = ledger.get("days")?.as_object()?.get(day_key)?;
    Some(ledger_day_total_tokens(day))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ledger_day_total_tokens_sums_snake_keys_ignoring_extras() {
        // r2a claude 执行环境行走 `claude_ledger_day_tokens` → 这里。flat 日含真实
        // 模型 + `<synthetic>`（全零，cost-state 里的 unknown 占位——0 不能贡献
        // 也不该炸）+ 无关装饰键：只数 SNAKE_KEYS 4 型，其余键一律无视。
        let day = json!({
            "<synthetic>": {"input_tokens": 0, "cache_read_input_tokens": 0,
                            "cache_creation_input_tokens": 0, "output_tokens": 0},
            "deepseek-v4-flash": {"input_tokens": 12_000, "cache_read_input_tokens": 1000,
                                  "cache_creation_input_tokens": 0, "output_tokens": 200,
                                  "server_tool_use": 3},
            "claude-sonnet-5": {"input_tokens": 0, "cache_read_input_tokens": 62_500,
                                "cache_creation_input_tokens": 0, "output_tokens": 0},
        });
        assert_eq!(ledger_day_total_tokens(&day), 75_700);
        // 非对象（坏日）→ 0，不 panic（真实数据里空日不落 ledger，这是防御面）。
        assert_eq!(ledger_day_total_tokens(&Value::Null), 0);
        assert_eq!(ledger_day_total_tokens(&json!({})), 0);
    }
}
