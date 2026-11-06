//! 行为 findings 评估器：同步后对有变化的 DSH / Codex 会话跑 behavior 规则，
//! 结果落 `issue_instances`（W8，docs/ARCHITECTURE_OPTIMIZATION_GUIDE.md）。
//!
//! 为什么搬到同步路径：此前唯一生产者是 `sessions/r2a_store.rs` 的
//! `sessions findings`——整套 legacy SessionStore（全执行环境遍历 + 文件指纹缓存）
//! 只为这一个出口活着，且只在旧 DOM 界面的「重载」按钮或首启引导时触发。React
//! 切换（ed1660c）后没有任何入口再触发它，Findings 页读到的 Issues 停在了
//! 2026-09-20（真机：5,332 条全是 `legacy-finding`，最后更新 09-20 15:23）。
//! 同步本来就知道「本轮哪些源文件变了」（SourceGraph 差量），在这里评估即可
//! 增量、自动、不依赖任何界面。
//!
//! **身份连续性**：evaluator_id / version / instance_fingerprint 格式 /
//! metadata 形状与 r2a 的 `persist_findings_as_issues` 逐字段一致——唯一键是
//! `(machine_namespace, issue_type, instance_fingerprint)`，换任何一项都会让
//! 已有 issue 全部「消失 + 重新出现」，用户的 acknowledged/wontfix 状态跟着丢。
//! `evaluator_id = "legacy-finding"` 这个名字已经名不副实，改名要配迁移，另做。
//!
//! **只关闭本轮真正评估过的会话**：读失败 / 头行缺失的会话不进结果集，它的
//! issue 保持原状——没观察到 ≠ 观察到已消失（与 r2a 同义）。
//!
//! 规则计算本身在锁外做（DSH 解压 + 审计、Codex 解析都慢）；写库由调用方
//! 在短临界区里调 [`persist`]。

use std::collections::BTreeSet;

use rusqlite::Connection;

// W3：会话级评估（每执行环境怎么读、怎么分组）搬到 harnesses 的注册表
// `sources::session_harnesses`；这里只剩写库。旧路径保留。
pub use agent_vitals_harnesses::sources::session_harnesses::{findings_from_payload, SessionFindings};

/// 与 r2a 写入的既有 issue 同一身份（见模块文档「身份连续性」）。
pub const EVALUATOR_ID: &str = "legacy-finding";
pub const EVALUATOR_VERSION: &str = "v0.11";
/// 一次性全量回填标记：升级前已同步过的会话在 SourceGraph 眼里是 Unchanged，
/// 不回填的话它们的 findings 永远停在 r2a 最后一次运行的样子。
pub const BACKFILL_META_KEY: &str = "behavior_findings_evaluated_v1";



#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize)]
pub struct EvalReport {
    pub sessions_evaluated: usize,
    pub findings_upserted: usize,
    pub reopened: usize,
    pub closed: usize,
    pub errors: Vec<String>,
}







/// 单会话落库（调用方包事务）：upsert 本轮每条 finding；已关闭 / 已确认 /
/// wontfix 的再次出现 → 重开；本评估器对该会话旧有、本轮未再观察到的 → 关闭。
/// 语义与 r2a `persist_findings_as_issues` + `close_missing_legacy_issues` 一致。
pub fn persist(
    conn: &Connection,
    ns: &str,
    session: &SessionFindings,
    now_ms: i64,
    report: &mut EvalReport,
) -> rusqlite::Result<()> {
    use agent_vitals_data::issues;
    let mut current: BTreeSet<String> = BTreeSet::new();
    for finding in &session.findings {
        let evidence = finding.evidence.as_deref().unwrap_or("");
        let seq = finding.seq.map(|v| v.to_string()).unwrap_or_default();
        let fingerprint = format!("{}\0{}\0{}\0{}", session.native_id, finding.rule, seq, evidence);
        let evidence_fingerprint = format!(
            "fnv1a64:{}",
            agent_vitals_domain::source_identity::fnv1a64_hex(evidence.as_bytes())
        );
        let opened_at_ms = finding.time.map(issues::to_epoch_ms).unwrap_or(now_ms);
        let remedy = issues::remedy_for(&finding.rule);
        // 键序与 r2a 逐字一致（metadata_json 是 upsert 覆写的字段）。`source`
        // 保留旧值：它标识的是这类 issue 的族，不是本次调用栈。
        let metadata = serde_json::json!({
            "category": finding.category,
            "tool_name": finding.tool_name,
            "evidence": finding.evidence,
            "time": opened_at_ms,
            "seq": finding.seq,
            "source": "sessions_findings",
            "remedy": {
                "remedy_id": remedy.remedy_id,
                "diagnostic_only": remedy.diagnostic_only,
            },
        })
        .to_string();
        let input = issues::IssueInput {
            machine_namespace: ns,
            harness: session.harness,
            session_key: Some(&session.native_id),
            issue_type: &finding.rule,
            instance_fingerprint: &fingerprint,
            status: "open",
            severity: &finding.severity,
            evaluator_id: EVALUATOR_ID,
            evaluator_version: EVALUATOR_VERSION,
            evidence_fingerprint: &evidence_fingerprint,
            opened_at_ms,
            metadata_json: &metadata,
        };
        let issue_id = issues::upsert_issue(conn, &input)?;
        report.findings_upserted += 1;
        let status: Option<String> = conn
            .query_row("SELECT status FROM issue_instances WHERE issue_id = ?1", [&issue_id], |r| r.get(0))
            .ok();
        if matches!(status.as_deref(), Some("closed" | "wontfix" | "acknowledged")) {
            issues::transition_issue(
                conn, &issue_id, "open", now_ms, "reappeared", EVALUATOR_ID,
                &evidence_fingerprint, EVALUATOR_ID, EVALUATOR_VERSION, &fingerprint,
            )?;
            report.reopened += 1;
        }
        current.insert(issue_id);
    }
    let mut stmt = conn.prepare(
        "SELECT issue_id FROM issue_instances
         WHERE machine_namespace = ?1 AND harness = ?2 AND session_key = ?3
           AND evaluator_id = ?4 AND status IN ('open', 'acknowledged')
         ORDER BY issue_id",
    )?;
    let open_ids = stmt
        .query_map(
            rusqlite::params![ns, session.harness, session.native_id, EVALUATOR_ID],
            |r| r.get::<_, String>(0),
        )?
        .collect::<Result<Vec<_>, _>>()?;
    for issue_id in open_ids {
        if current.contains(&issue_id) {
            continue;
        }
        issues::transition_issue(
            conn, &issue_id, "closed", now_ms, "not observed on re-evaluation",
            EVALUATOR_ID, "re-evaluation:absent", EVALUATOR_ID, EVALUATOR_VERSION,
            &format!("re-evaluation:{issue_id}"),
        )?;
        report.closed += 1;
    }
    report.sessions_evaluated += 1;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_vitals_domain::findings::FindingRef;
    use std::path::PathBuf;

    fn tmp_db(tag: &str) -> (PathBuf, agent_vitals_data::authority::AuthorityDb) {
        let path = std::env::temp_dir().join(format!(
            "av-findings-eval-{tag}-{}-{}",
            std::process::id(),
            crate::clock::now_ms()
        ));
        let db = agent_vitals_data::authority::AuthorityDb::open(&path, 1).unwrap();
        (path, db)
    }

    fn finding(rule: &str, evidence: &str, seq: u64) -> FindingRef {
        FindingRef {
            rule: rule.into(),
            severity: "warning".into(),
            category: "shell".into(),
            tool_name: Some("bash".into()),
            evidence: Some(evidence.into()),
            time: Some(1_700_000_000_000),
            seq: Some(seq),
        }
    }

    fn status(db: &agent_vitals_data::authority::AuthorityDb, id: &str) -> String {
        db.conn()
            .query_row("SELECT status FROM issue_instances WHERE issue_id=?1", [id], |r| r.get(0))
            .unwrap()
    }


    /// 身份连续性：r2a 以前写下的 issue（同 fingerprint 格式）必须被评估器原地
    /// 命中——同一 issue_id、不新增行；用户 acknowledged 的再次观察到 → 重开。
    #[test]
    fn persist_reuses_r2a_issue_identity_and_reopens_reappeared() {
        let (path, db) = tmp_db("identity");
        let f = finding("SV601", "rm -rf /tmp/x", 3);
        // 模拟 r2a 写入：fingerprint = native_id\0rule\0seq\0evidence。
        let legacy_fp = "sess-1\0SV601\u{0}3\0rm -rf /tmp/x";
        let legacy = agent_vitals_data::issues::IssueInput {
            machine_namespace: "ns", harness: "dsh", session_key: Some("sess-1"),
            issue_type: "SV601", instance_fingerprint: legacy_fp, status: "open",
            severity: "warning", evaluator_id: "legacy-finding", evaluator_version: "v0.11",
            evidence_fingerprint: "e", opened_at_ms: 1, metadata_json: "{}",
        };
        let legacy_id = agent_vitals_data::issues::upsert_issue(db.conn(), &legacy).unwrap();
        agent_vitals_data::issues::transition_issue(db.conn(), &legacy_id, "acknowledged", 2,
            "seen", "user", "user-action", "user", "v1", "ack").unwrap();

        let session = SessionFindings { harness: "dsh", native_id: "sess-1".into(), findings: vec![f] };
        let mut report = EvalReport::default();
        persist(db.conn(), "ns", &session, 10, &mut report).unwrap();

        let rows: i64 = db.conn().query_row("SELECT COUNT(*) FROM issue_instances", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 1, "同一身份不得新增行");
        assert_eq!(status(&db, &legacy_id), "open", "acknowledged 再观察到 → 重开（r2a 同义）");
        assert_eq!((report.findings_upserted, report.reopened, report.closed), (1, 1, 0));
        let _ = std::fs::remove_file(path);
    }

    /// 原 r2a `re_evaluation_closes_absent_issues_but_preserves_later`：本轮没再
    /// 观察到的 open 关闭；用户 `later` 不动；别的会话 / 别的 evaluator 不碰。
    #[test]
    fn persist_closes_absent_but_preserves_later_and_other_sessions() {
        let (path, db) = tmp_db("close");
        let mut report = EvalReport::default();
        let both = SessionFindings {
            harness: "codex",
            native_id: "c1".into(),
            findings: vec![finding("SV611", "a", 1), finding("SV611", "b", 2), finding("SV611", "c", 3)],
        };
        persist(db.conn(), "ns", &both, 1, &mut report).unwrap();
        let other = SessionFindings { harness: "codex", native_id: "c2".into(), findings: vec![finding("SV611", "a", 1)] };
        persist(db.conn(), "ns", &other, 1, &mut report).unwrap();
        let id_of = |sid: &str, ev: &str, seq: u64| -> String {
            db.conn().query_row(
                "SELECT issue_id FROM issue_instances WHERE session_key=?1 AND instance_fingerprint=?2",
                [sid, &format!("{sid}\0SV611\0{seq}\0{ev}")], |r| r.get(0)).unwrap()
        };
        let later = id_of("c1", "c", 3);
        agent_vitals_data::issues::transition_issue(db.conn(), &later, "later", 2,
            "remind later", "user", "user-action:later", "user", "v1", "defer").unwrap();

        // 第二轮：只剩 a。
        let mut report = EvalReport::default();
        let only_a = SessionFindings { harness: "codex", native_id: "c1".into(), findings: vec![finding("SV611", "a", 1)] };
        persist(db.conn(), "ns", &only_a, 5, &mut report).unwrap();
        assert_eq!(status(&db, &id_of("c1", "a", 1)), "open");
        assert_eq!(status(&db, &id_of("c1", "b", 2)), "closed");
        assert_eq!(status(&db, &later), "later", "用户 later 不被评估器关闭");
        assert_eq!(status(&db, &id_of("c2", "a", 1)), "open", "别的会话不碰");
        assert_eq!(report.closed, 1);
        let _ = std::fs::remove_file(path);
    }


}
