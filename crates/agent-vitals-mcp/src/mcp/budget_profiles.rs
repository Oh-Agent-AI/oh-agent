//! Read-only MCP view of the independent budget profiles.

use std::path::Path;

use serde_json::{json, Value};

use super::{build_envelope, AuthorityHandle, ToolError, ToolSpec};

pub fn spec() -> ToolSpec {
    ToolSpec {
        name: "budget_profiles",
        description: "Report independent estimate and confirmed-spend budgets without converting or combining currencies.",
        input_schema: json!({
            "type": "object",
            "properties": {
                "month": { "type": "string", "description": "Optional Beijing month YYYY-MM; defaults to the current month." }
            },
            "additionalProperties": false
        }),
        output_schema: json!({
            "type": "object",
            "description": "spec §6 envelope; data.profiles contains one row per configured budget profile."
        }),
    }
}

pub fn run(args: &Value, data_home: &Path) -> Result<Value, ToolError> {
    let month = args.get("month")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(crate::clock::current_month_beijing);
    if !valid_month(&month) {
        return Err(ToolError::new("invalid_argument", format!("invalid `month`: {month} (expect YYYY-MM)")));
    }
    let handle = AuthorityHandle::open(data_home)?;
    // 与桌面 / CLI 同一份计算（`budget::budget_profiles_status_sql_at`）：此前这里手抄了
    // 一份 spent/ratio/level，订阅摊派与三级按量口径加进去之后 MCP 会和总览卡对不上
    // （2026-09-17）。
    let status = crate::budget::budget_profiles_status_sql_at(data_home, &month)
        .ok_or_else(|| ToolError::new("internal_error", "budget profile status unavailable"))?;
    let coverage = status.get("coverage").cloned().unwrap_or_else(super::coverage_not_applicable);
    let data = json!({
        "month": month,
        "profiles": status.get("profiles").cloned().unwrap_or_else(|| json!([])),
    });
    Ok(build_envelope(
        handle.conn(), handle.authority_state(), None,
        coverage, Vec::new(), data,
    ))
}
fn valid_month(month: &str) -> bool {
    month.is_ascii() && month.len() == 7 && month.as_bytes().get(4) == Some(&b'-')
        && month[..4].parse::<u16>().is_ok()
        && month[5..].parse::<u8>().is_ok_and(|m| (1..=12).contains(&m))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_is_closed_and_month_is_validated() {
        let s = spec();
        assert_eq!(s.input_schema["additionalProperties"], json!(false));
        assert!(valid_month("2026-09"));
        assert!(!valid_month("2026-13"));
        assert!(!valid_month("2026/09"));
    }
}
