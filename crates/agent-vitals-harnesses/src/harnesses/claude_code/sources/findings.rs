//! Claude Code 会话的行为 findings 评估（W3 从 runtime `ingest/findings_eval.rs` 搬来）。
//!
//! session_id 就是文件 stem（`file_info` 不看内容），同会话候选按 stem 精确匹配——与
//! r2a `claude_session_id_of` + 全量过滤逐一等价，零额外解析。subagent 文件
//! （`<sid>/subagents/agent-*.jsonl`）stem 不同，r2a 起就是独立会话。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use crate::sources::session_harnesses::{findings_from_payload, FindingsCtx, SessionFindings};

pub fn evaluate(
    _ctx: &FindingsCtx<'_>,
    changed: &[PathBuf],
    all_files: &[PathBuf],
) -> (Vec<SessionFindings>, Vec<String>) {
    let stem = |p: &Path| p.file_stem().and_then(|s| s.to_str()).unwrap_or("unknown").to_string();
    let sids: BTreeSet<String> = changed.iter().map(|p| stem(p)).collect();
    let mut out = Vec::new();
    for sid in sids {
        let mut candidates: Vec<PathBuf> = all_files
            .iter()
            .chain(changed.iter())
            .filter(|p| stem(p) == sid)
            .cloned()
            .collect();
        candidates.sort_by(|a, b| a.to_string_lossy().cmp(&b.to_string_lossy()));
        candidates.dedup();
        // None = 空会话（无记录）：r2a 同样不建条目——不是错误，也不关旧 issue。
        if let Some(payload) = super::claude_session_audit_json_for_files(&sid, &candidates) {
            out.push(SessionFindings {
                harness: "claude-code",
                native_id: sid,
                findings: findings_from_payload("claude-code", &payload),
            });
        }
    }
    (out, Vec::new())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sources::session_harnesses::HarnessRoots;

    /// Claude Code：session_id = 文件 stem。dangerous 夹具（fixtures/claude，§10
    /// 验收单一来源）必须产出 SV601；stem 不同的 healthy 会话独立成条、不串。
    #[test]
    fn evaluate_groups_by_file_stem_and_finds_sv601() {
        let t = std::env::temp_dir().join(format!("av-findings-claude-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&t);
        let proj = t.join(".claude/projects/-tmp-w");
        std::fs::create_dir_all(&proj).unwrap();
        let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/claude");
        std::fs::copy(fixtures.join("dangerous.jsonl"), proj.join("dangerous.jsonl")).unwrap();
        std::fs::copy(fixtures.join("healthy.jsonl"), proj.join("healthy.jsonl")).unwrap();
        let all = super::super::claude_project_files(&t);
        assert_eq!(all.len(), 2);

        let pricing = serde_json::Value::Null;
        let cache = t.join("cache.json");
        let ctx = FindingsCtx {
            roots: HarnessRoots { user_home: &t, dsh_home: None },
            codex_index_cache: &cache,
            pricing: &pricing,
        };
        let (sessions, errors) = evaluate(&ctx, &[proj.join("dangerous.jsonl")], &all);
        assert!(errors.is_empty());
        assert_eq!(sessions.len(), 1, "只评估变化的那个会话");
        assert_eq!(sessions[0].native_id, "dangerous");
        assert!(sessions[0].findings.iter().any(|f| f.rule == "SV601"), "{:?}", sessions[0].findings);
        let _ = std::fs::remove_dir_all(&t);
    }
}
