//! DSH 会话头身份读法——`dsh_header` / `dsh_source_profile`。
//!
//! v0.9 Stage A emitter 归位（R4 §5.2 scope gap）：这两个纯函数原住
//! `agent_vitals_runtime::sessions::r2a_store`，但 DSH UsageFact emitter 搬进
//! harnesses 后依赖方向不许回头（harnesses ← runtime 是单向的），所以下沉到会话证据
//! 纯层（wasm 可链）。identity/attribution 判读只有这一份：runtime 的
//! findings 评估器（`ingest::findings_eval`）直接调它；Python 镜像在
//! `adapters/dsh_source_profile.py`（W8 前住 `r2a.py`，r2a 已删）。

use serde_json::Value;

/// 从**已解压文本**读会话头：`id` + `cwd`。`id` 缺失 → None（无法建 SessionKey）。
/// 只读头行，不重复解压——调用方已用 `read_session_text` 解过一次。
pub fn dsh_header(text: &str) -> Option<(String, Option<String>)> {
    let line = text.lines().find(|l| !l.trim().is_empty())?;
    let v: Value = serde_json::from_str(line.trim()).ok()?;
    let id = v.get("id").and_then(Value::as_str)?;
    let cwd = v.get("cwd").and_then(Value::as_str).map(str::to_owned);
    Some((id.to_string(), cwd))
}

/// DSH 的 source_profile（§1.3）= 会话头 `cwd` 清洗后的项目路径：
/// `--{cwd.replace('/', "-")}--`。cwd 缺失 → 空串（诚实缺失；native_id 全局唯一，
/// 空 source_profile 不会撞键）。
pub fn dsh_source_profile(cwd: Option<&str>) -> String {
    cwd.map(|c| format!("--{}--", c.replace('/', "-")))
        .unwrap_or_default()
}
