//! `query_sql_readonly` 工具（spec §8.2 / 增量 7.5）——**仅 `mcp-internal`
//! feature** 编译，让其他 Agent 调试权威库时不用 `shell` 直连。
//!
//! **双层防线**（spec §8.2 P1-5 警示）：
//! 1. **来源层 authorizer**（`agent_vitals_data::safe_query::authority_callback`）——
//!    按 `SQLITE_READ` 回调按来源表 + 来源列拒绝敏感字段。这是**唯一可靠**防线，
//!    因为它拦不住 `AS` / 表达式 / `json_extract` 的列名混淆。
//! 2. **view 脱敏**（`v_facts_safe` / `v_sessions_safe` / `v_data_quality_safe` /
//!    `v_sync_runs_safe`）——view 定义里就不 SELECT 敏感列。即便 authorizer 漏
//!    掉，view 也不暴露。
//!
//! **不在 v1 兼容承诺内**——公开构建（默认 feature = `[]`）不含此工具。

use std::path::Path;

use serde_json::{json, Value};

use agent_vitals_data::authority::AuthorityDb;

use super::{
    build_envelope, AuthorityHandle, ToolError, ToolSpec,
};

const MAX_ROWS_DEFAULT: usize = 200;
const MAX_ROWS_HARD_CAP: usize = 200;
const MAX_BODY_BYTES: usize = 1024 * 1024;
const SQL_TIMEOUT_MS_DEFAULT: u32 = 3_000;
const SQL_TIMEOUT_MS_HARD_CAP: u32 = 30_000;

pub fn spec() -> ToolSpec {
    ToolSpec {
        name: "query_sql_readonly",
        description: "Run a read-only SELECT or WITH...SELECT against the SQL authority DB and return rows. \
                     Internal-only (mcp-internal feature); not part of v1 compatibility commitment. \
                     Authorizer denies writes / DDL / PRAGMA / ATTACH / sensitive columns \
                     (native_session_id, source_event_id, path_hash, machine_namespace, \
                     session_key, source_id, detail_json, error_detail). Recommended: query \
                     the v_facts_safe / v_sessions_safe / v_data_quality_safe / v_sync_runs_safe \
                     views to avoid touching sensitive columns entirely. Limits: max 200 rows, \
                     max 1 MiB response, 3-second timeout. Unstable.",
        input_schema: json!({
            "type": "object",
            "properties": {
                "sql": {
                    "type": "string",
                    "description": "Single SELECT or WITH...SELECT statement. No INSERT/UPDATE/DELETE/DDL/PRAGMA/ATTACH.",
                },
                "max_rows": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 200,
                    "default": 200,
                    "description": "Cap on returned rows (capped at 200 per spec).",
                },
                "timeout_ms": {
                    "type": "integer",
                    "minimum": 100,
                    "maximum": 30000,
                    "default": 3000,
                    "description": "SQLite busy_timeout in ms (capped at 30000).",
                }
            },
            "required": ["sql"],
            "additionalProperties": false
        }),
        output_schema: json!({
            "type": "object",
            "description": "envelope + data: { columns: [string], rows: [[Value]], row_count, elapsed_ms }"
        }),
    }
}

pub fn run(args: &Value, data_home: &Path) -> Result<Value, ToolError> {
    let sql = args
        .get("sql")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::new("invalid_argument", "`sql` is required"))?;
    let max_rows = args
        .get("max_rows")
        .and_then(Value::as_u64)
        .map(|n| (n as usize).clamp(1, MAX_ROWS_HARD_CAP))
        .unwrap_or(MAX_ROWS_DEFAULT);
    let timeout_ms = args
        .get("timeout_ms")
        .and_then(Value::as_u64)
        .map(|n| (n as u32).clamp(100, SQL_TIMEOUT_MS_HARD_CAP))
        .unwrap_or(SQL_TIMEOUT_MS_DEFAULT);

    // 1. 拿一个只读 + authorizer 守护的连接。`AuthorityHandle::open` 已
    //    校验 schema + 缺文件 → `database_missing`，避免与下面 read-only
    //    路径重复触发 `Corrupt`。
    let _handle = AuthorityHandle::open(data_home)?;
    let db_path = agent_vitals_data::authority::default_authority_path(data_home);
    let conn = AuthorityDb::make_query_sql_readonly_connection(&db_path)
        .map_err(authority_error_to_tool_error)?;
    conn.busy_timeout(std::time::Duration::from_millis(timeout_ms as u64))
        .map_err(|e| ToolError::new("internal_error", format!("busy_timeout: {e}")))?;

    let started = std::time::Instant::now();

    // 2. 改写 LIMIT：用户原 SQL 不带 LIMIT → 加 `LIMIT max_rows`；带 LIMIT
    //    且大于 max_rows → 截到 max_rows；带 LIMIT 且 ≤ max_rows → 不动。
    let capped_sql = rewrite_with_limit(sql, max_rows);

    // 3. prepare + execute。authorizer 在 prepare 阶段会检查列访问
    //    （`SQLITE_READ`），所以敏感列 SELECT 在 prepare 就被拒——我们
    //    不必等到 execute。运行时错误（权限类 / 语法类）映射成业务错误。
    let mut stmt = conn
        .prepare(&capped_sql)
        .map_err(|e| ToolError::new("invalid_argument", format!("prepare: {e}")))?;

    let column_names: Vec<String> = stmt.column_names().into_iter().map(String::from).collect();
    let col_count = column_names.len();

    // 4. 跑 + 限行。每个 row 是 `Vec<Value>`，列按 `column_names` 顺序取。
    let mut rows: Vec<Vec<Value>> = Vec::new();
    let rows_iter = stmt
        .query_map([], |row| {
            let mut v = Vec::with_capacity(col_count);
            for i in 0..col_count {
                v.push(row_to_value(row, i));
            }
            Ok(v)
        })
        .map_err(|e| ToolError::new("invalid_argument", format!("execute: {e}")))?;
    for row in rows_iter {
        let row = row.map_err(|e| ToolError::new("invalid_argument", format!("row: {e}")))?;
        if rows.len() >= max_rows {
            break;
        }
        rows.push(row);
    }

    let elapsed_ms = started.elapsed().as_millis();

    // 体积极限：估算 JSON 序列化字节数 > 1 MiB → 截断 + warn。
    let body_bytes = estimate_body_bytes(&column_names, &rows);
    let mut warnings = Vec::new();
    if body_bytes > MAX_BODY_BYTES {
        // 按行截断到能装下 ~80% 的字节，留余量给 envelope 包装。
        let target_rows = (rows.len() * 8 / 10).max(1);
        rows.truncate(target_rows);
        warnings.push(json!({
            "code": "result_truncated",
            "message": format!("response would have been {body_bytes} bytes (>1 MiB); truncated to {} rows", rows.len()),
        }));
    }

    let data = json!({
        "sql_safe": capped_sql,
        "columns": column_names,
        "row_count": rows.len(),
        "row_count_cap": max_rows,
        "elapsed_ms": elapsed_ms as u64,
        "rows": rows,
    });

    Ok(build_envelope(
        &conn,
        super::authority_state_for(data_home),
        None,
        super::coverage_not_applicable(),
        warnings,
        data,
    ))
}

/// 业务错误到 `AuthorityError` → `ToolError` 的桥（避免直接 `use super::super`）。
fn authority_error_to_tool_error(e: agent_vitals_data::authority::AuthorityError) -> ToolError {
    match e {
        agent_vitals_data::authority::AuthorityError::MissingFile => ToolError::new(
            "database_missing",
            "authority DB does not exist — run `agent-vitals sync-facts` first",
        ),
        agent_vitals_data::authority::AuthorityError::Corrupt => ToolError::new(
            "database_unreadable",
            "authority DB is corrupt or not a SQLite file — run `agent-vitals data-status`, keep the file for diagnosis",
        ),
        agent_vitals_data::authority::AuthorityError::NewerSchema { found, supported } => ToolError::new(
            "schema_too_new",
            format!("authority schema v{found} is newer than supported v{supported} — upgrade agent-vitals"),
        ),
        agent_vitals_data::authority::AuthorityError::OlderSchema { found } => ToolError::new(
            "schema_migration_required",
            format!("authority schema v{found} is older than supported — run the matching product migration"),
        ),
        other => ToolError::new("internal_error", other.to_string()),
    }
}

/// 在 SQL 末尾追加 / 替换 LIMIT。**单趟字符级扫描**，跳过：
/// - 单引号字符串字面量（`'...'`）——防止 `WHERE col = 'LIMIT 9999'` 被误匹配
/// - 双引号标识符（`"..."`）——防止 `AS "LIMIT"` 误匹配
/// - 行注释（`--` 到换行）——防止 `-- LIMIT 5` 误匹配
///
/// 多语句（`;` 多于 1 个 / `;` 不在末尾）拒绝改写。`LIMIT` 后必须空白 + 数字。
fn rewrite_with_limit(sql: &str, max_rows: usize) -> String {
    // 1. 多语句检查：`;` 只允许在末尾。
    let mut semis: Vec<usize> = Vec::new();
    let mut in_str = false; // 单引号字符串字面量
    let mut in_id = false;  // 双引号标识符
    let mut in_line_comment = false;
    let bytes = sql.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if in_str {
            if b == b'\'' {
                // 转义 `''`（SQLite string literal 中 `''` 表示一个 `'`）。
                if i + 1 < bytes.len() && bytes[i + 1] == b'\'' {
                    i += 2;
                    continue;
                }
                in_str = false;
            }
            i += 1;
            continue;
        }
        if in_id {
            if b == b'"' {
                in_id = false;
            }
            i += 1;
            continue;
        }
        if in_line_comment {
            if b == b'\n' {
                in_line_comment = false;
            }
            i += 1;
            continue;
        }
        // 普通 SQL 文本。
        if b == b'\'' {
            in_str = true;
        } else if b == b'"' {
            in_id = true;
        } else if b == b';' {
            semis.push(i);
        } else if b == b'-' && i + 1 < bytes.len() && bytes[i + 1] == b'-' {
            in_line_comment = true;
            i += 2;
            continue;
        }
        i += 1;
    }
    if semis.len() > 1 || (!semis.is_empty() && semis[0] != sql.len() - 1) {
        // 多语句 / 中间有 `;` → 不改写，让 prepare 自己报错。
        return sql.to_string();
    }
    let body = if !semis.is_empty() { &sql[..semis[0]] } else { sql };
    let body = body.trim_end();

    // 2. 重新跑一遍扫描，这次专找 LIMIT 关键字（要求空白 + 数字 + 不在
    // 字符串 / 注释 / 标识符内）。
    if let Some((limit_pos, _)) = find_last_real_limit(body) {
        // 解析 LIMIT 后的数字（trim）。
        let after = body[limit_pos + 5..].trim_start();
        // 找数字边界。
        let num_end = after
            .find(|c: char| !c.is_ascii_digit())
            .unwrap_or(after.len());
        let num_str = &after[..num_end];
        let current: Option<usize> = num_str.parse().ok();
        match current {
            Some(n) if n > max_rows => {
                // 替换数字（保留单位，例如 `LIMIT 10000 OFFSET 0` 替换为
                // `LIMIT 50 OFFSET 0`）。
                let new_body =
                    format!("{}{}{}", &body[..limit_pos + 5], max_rows, &after[num_end..]);
                if semis.is_empty() {
                    format!("{new_body} LIMIT {max_rows}")
                } else {
                    format!("{new_body};")
                }
            }
            Some(_) => {
                // 已经 ≤ max_rows → 不动；走原 SQL。
                sql.to_string()
            }
            // LIMIT 后不是数字（语法错）→ prepare 会自己报错，不改写。
            None => sql.to_string(),
        }
    } else {
        // 没有 LIMIT 关键字 → 在末尾追加。
        if semis.is_empty() {
            format!("{body} LIMIT {max_rows}")
        } else {
            format!("{body} LIMIT {max_rows};")
        }
    }
}

/// 在 body 中找**最后**一个「真实」的 `LIMIT ` 关键字（大小写不敏感、词边界、
/// 不在字符串字面量 / 注释 / 双引号标识符内）。返回 `(byte_offset, end_offset)`。
///
/// 跟 `find_last_limit` 的区别：本版本是**字符串感知**的——会跳过 `'...'` /
/// `"..."` / `-- ...` 区域。`find_last_limit` 保留作为更低层的工具，但
/// `rewrite_with_limit` 不再用它（review 增量 7.5 实测它会被字符串字面量
/// 里的 `LIMIT 9999` 误匹配，造成数据损坏）。
fn find_last_real_limit(body: &str) -> Option<(usize, usize)> {
    let needle = "LIMIT";
    let bytes_upper = body.to_ascii_uppercase();
    let mut last: Option<(usize, usize)> = None;
    let mut i = 0;
    let mut in_str = false;
    let mut in_id = false;
    let mut in_line_comment = false;
    while i < body.len() {
        let b = body.as_bytes()[i];
        if in_str {
            if b == b'\'' {
                if i + 1 < body.len() && body.as_bytes()[i + 1] == b'\'' {
                    i += 2;
                    continue;
                }
                in_str = false;
            }
            i += 1;
            continue;
        }
        if in_id {
            if b == b'"' {
                in_id = false;
            }
            i += 1;
            continue;
        }
        if in_line_comment {
            if b == b'\n' {
                in_line_comment = false;
            }
            i += 1;
            continue;
        }
        if b == b'\'' {
            in_str = true;
        } else if b == b'"' {
            in_id = true;
        } else if b == b'-' && i + 1 < body.len() && body.as_bytes()[i + 1] == b'-' {
            in_line_comment = true;
            i += 2;
            continue;
        }
        // 找 `LIMIT` 词边界匹配。
        if i + needle.len() < bytes_upper.len()
            && &bytes_upper[i..i + needle.len()] == needle
        {
            // 词边界：abs 之前不是 `[A-Z0-9_]`；abs + 5 之后是空白。
            let before_ok =
                i == 0 || !bytes_upper.as_bytes()[i - 1].is_ascii_alphanumeric();
            let after_byte = bytes_upper.as_bytes()[i + needle.len()];
            let after_ok = after_byte == b' ' || after_byte == b'\t' || after_byte == b'\n';
            if before_ok && after_ok {
                last = Some((i, i + needle.len()));
            }
        }
        i += 1;
    }
    last
}


/// 行体字节估算——粗略（不精确序列化），够用来判要不要 warn。
fn estimate_body_bytes(column_names: &[String], rows: &[Vec<Value>]) -> usize {
    let col_bytes: usize = column_names.iter().map(|n| n.len() + 4).sum();
    let row_bytes: usize = rows
        .iter()
        .map(|r| r.iter().map(value_byte_size).sum::<usize>() + 16)
        .sum();
    col_bytes + row_bytes + 64
}

fn value_byte_size(v: &Value) -> usize {
    match v {
        Value::Null => 4,
        Value::Bool(_) => 5,
        Value::Number(_) => 8,
        Value::String(s) => s.len() + 4,
        Value::Array(a) => a.iter().map(value_byte_size).sum::<usize>() + 4,
        Value::Object(o) => o.iter().map(|(k, v)| k.len() + value_byte_size(v)).sum::<usize>() + 4,
    }
}

// `Value` helper：把 `rusqlite::Row` 的第 i 列转成 `serde_json::Value`。
// NULL → JSON null，数值 / 字符串 / 字节按原值；其它类型用 `to_string()`。
// 这是调试工具——容忍语义损失（精度 / 大整数 → f64），但保证不 panic。
fn row_to_value(row: &rusqlite::Row, i: usize) -> Value {
    use rusqlite::types::ValueRef;
    match row.get_ref(i) {
        Ok(ValueRef::Null) => Value::Null,
        Ok(ValueRef::Integer(n)) => json!(n),
        Ok(ValueRef::Real(f)) => json!(f),
        Ok(ValueRef::Text(s)) => match std::str::from_utf8(s) {
            Ok(t) => Value::String(t.to_string()),
            Err(_) => Value::String(format!("<binary {} bytes>", s.len())),
        },
        Ok(ValueRef::Blob(b)) => Value::String(format!("<blob {} bytes>", b.len())),
        Err(e) => Value::String(format!("<decode error: {e}>")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_is_closed_and_required_sql() {
        let s = spec();
        assert_eq!(s.name, "query_sql_readonly");
        assert_eq!(s.input_schema["type"], "object");
        assert_eq!(s.input_schema["additionalProperties"], json!(false));
        assert!(s.input_schema["required"].as_array().unwrap().contains(&json!("sql")));
    }

    #[test]
    fn rewrite_appends_limit_when_missing() {
        let sql = "SELECT harness FROM usage_facts";
        let r = rewrite_with_limit(sql, 50);
        assert!(r.contains("LIMIT 50"));
    }

    #[test]
    fn rewrite_caps_existing_limit() {
        let sql = "SELECT harness FROM usage_facts LIMIT 10000";
        let r = rewrite_with_limit(sql, 50);
        assert!(r.contains("LIMIT 50"), "got {r}");
        assert!(!r.contains("LIMIT 10000"), "got {r}");
    }

    #[test]
    fn rewrite_keeps_smaller_limit() {
        let sql = "SELECT harness FROM usage_facts LIMIT 5";
        let r = rewrite_with_limit(sql, 50);
        assert!(r.contains("LIMIT 5"));
    }

    #[test]
    fn rewrite_leaves_multi_statement_alone() {
        let sql = "SELECT 1; DROP TABLE usage_facts";
        let r = rewrite_with_limit(sql, 50);
        // 多语句（中间有 `;`）→ 不改写，让 prepare 自己报错。
        assert_eq!(r, sql);
    }

    #[test]
    fn rewrite_handles_trailing_semicolon() {
        let sql = "SELECT harness FROM usage_facts;";
        let r = rewrite_with_limit(sql, 50);
        assert!(r.contains("LIMIT 50"), "got {r}");
        assert!(r.ends_with(';'), "got {r}");
    }

    #[test]
    fn rewrite_is_case_insensitive() {
        let sql = "SELECT harness FROM usage_facts limit 10000";
        let r = rewrite_with_limit(sql, 50);
        assert!(r.contains("LIMIT 50"), "got {r}");
        assert!(!r.contains("10000"), "got {r}");
    }

    #[test]
    fn rewrite_does_not_corrupt_line_comment() {
        // 行注释 `-- ...` 里的 LIMIT 不应被改写。
        let sql = "SELECT * FROM v_facts_safe -- LIMIT 5";
        let r = rewrite_with_limit(sql, 50);
        // 没有真实 LIMIT（被行注释包住）→ 末尾追加 LIMIT 50。
        assert!(r.contains("LIMIT 50"));
        assert!(r.contains("-- LIMIT 5"), "注释保持原样：{r}");
        // 关键不变量：注释里的 `LIMIT 5` **没**被错误地截成 50。
        assert!(r.contains("-- LIMIT 5"), "原注释不变：{r}");
    }

    #[test]
    fn rewrite_does_not_match_quoted_identifier() {
        // 双引号标识符里的 LIMIT 不应被改写。
        let sql = "SELECT harness AS \"LIMIT 5\" FROM v_facts_safe";
        let r = rewrite_with_limit(sql, 50);
        assert!(r.contains("\"LIMIT 5\""), "引号标识符保持：{r}");
    }

    #[test]
    fn rewrite_handles_sql_with_quotes_correctly() {
        // 真实 LIMIT + 字符串里的 LIMIT 共存。
        let sql = "SELECT * FROM v_facts_safe WHERE harness = 'foo' LIMIT 10000";
        let r = rewrite_with_limit(sql, 50);
        assert!(r.contains("LIMIT 50"), "应被改写：{r}");
        assert!(!r.contains("10000"), "应截断 10000：{r}");
    }

    #[test]
    fn rewrite_does_not_replace_in_substring_token() {
        // 验证 `find_last_limit` 词边界：colimit_audit 内的 `limit` 不能
        // 被误判为 LIMIT 关键字 → 没有 `LIMIT ` 词边界 → 走"追加"分支。
        let sql = "SELECT harness FROM colimit_audit";
        let r = rewrite_with_limit(sql, 50);
        // 追加分支：原 SQL 末尾接 " LIMIT 50"。"colimit_audit" 这个 token 保持原样
        // （没有在 colimit_audit 与 LIMIT 50 之间插入东西）。
        assert_eq!(r, "SELECT harness FROM colimit_audit LIMIT 50");
    }
}

// 桥 `ToolError` 的 code→`AuthorityError` 适配放模块外，`super` 容易乱。
// （单测里的 ToolError 也已经过 `super::ToolError::new` 调用——避免循环。）
