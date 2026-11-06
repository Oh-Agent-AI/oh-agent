//! DSH 会话的行为 findings 评估（W3 从 runtime `ingest/findings_eval.rs` 搬来）。
//! 一个文件 = 一个会话：读头行拿 native id，跑 `behavior::audit_payload`。

use std::path::PathBuf;

use serde_json::Value;

use crate::sources::session_harnesses::{findings_from_payload, FindingsCtx, SessionFindings};

pub fn evaluate(
    ctx: &FindingsCtx<'_>,
    changed: &[PathBuf],
    _all_files: &[PathBuf],
) -> (Vec<SessionFindings>, Vec<String>) {
    let mut out = Vec::new();
    let mut errors = Vec::new();
    for path in changed {
        let text = match super::read_session_text(path) {
            Ok(text) => text,
            Err(code) => {
                errors.push(format!("dsh findings {}: {code}", path.display()));
                continue;
            }
        };
        let degraded = super::parse_session_log(&text)
            .get("degraded")
            .and_then(Value::as_str)
            .is_some();
        let header = if degraded {
            None
        } else {
            crate::harnesses::dsh::sessions::header::dsh_header(&text)
        };
        let Some((id, _cwd)) = header else {
            errors.push(format!("dsh findings {}: missing-header", path.display()));
            continue;
        };
        let Some(payload) = super::behavior::audit_payload(path, ctx.pricing) else {
            errors.push(format!("dsh findings {}: file-missing", path.display()));
            continue;
        };
        out.push(SessionFindings {
            harness: "dsh",
            native_id: id,
            findings: findings_from_payload("dsh", &payload),
        });
    }
    (out, errors)
}
