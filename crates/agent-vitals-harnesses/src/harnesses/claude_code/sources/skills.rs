//! Claude Code `~/.claude.json` 的 I/O 层——v0.8 Phase E7.6 从 `apps/cli/src/
//! skills/harness.rs` 拆出。解释逻辑（哪些插件启用了、`skillUsage` 怎么读）纯
//! 部分在 `harnesses::claude_code::skills::parse_harness_config`；这里只做「文件
//! 存不存在、读不读得到、JSON 解不解析得出来」三件真实 I/O 的事，跟 `sources/
//! mod.rs`（会话 I/O）分开——skill 配置与会话日志是两条独立证据线，即便都在
//! `~/.claude.json` 这同一份文件附近，读取时机与失败语义都不一样。

use std::path::PathBuf;

use serde_json::Value;

use crate::harnesses::claude_code::skills::{parse_harness_config, HarnessConfig};

pub fn read_harness_config(home: &str) -> HarnessConfig {
    let path = PathBuf::from(home).join(".claude.json");
    let missing = HarnessConfig {
        enabled: None,
        usage: serde_json::Map::new(),
        present: false,
    };
    if !path.is_file() {
        return missing;
    }
    // 与 apps/cli::util::read_lossy 同一份转换逻辑（宽松 UTF-8 + universal
    // newlines）——两处的字节来源都是真实文件，不能各写一份近似实现。
    let text = match std::fs::read(&path) {
        Ok(bytes) => agent_vitals_domain::util::bytes_to_lossy_normalized(&bytes),
        Err(_) => return missing,
    };
    let doc: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return missing,
    };
    parse_harness_config(&doc)
}
