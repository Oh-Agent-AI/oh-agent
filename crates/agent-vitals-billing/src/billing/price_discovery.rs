//! 本地未计价发现：把「日志里的用量算不出钱」变成「待处理」里的一条任务。
//!
//! **零网络、零凭据、零新同意。** 判定完全来自本地事实表 × 本地价卡
//! （[`crate::summary::unresolved_detail`] 早就在算这件事），本模块补的是**接线**，
//! 不是新的数据来源。
//!
//! **为什么必须有它**：issue 侧的规则映射（`PRICE_COVERAGE` / `price_missing` 等）
//! 早就写好了，但从来没有 producer 写过这类 code —— 于是"这些用量算不出钱"只出现
//! 在总览的一行提示里，从不进「待处理」。真机 2026-09-14 实测：一个型号
//! （`deepseek/deepseek-v4.1-flash`）累计 3.8 亿 token 的名义成本整栏为空、
//! 另有 8 个型号合计 47 亿 token 连归属都没定，而系统从没告诉用户"这里有件事要做"；
//! 用户是看到「无数据」来问才知道的。
//!
//! **两种原因，两种动作**（合并会让用户不知道该做什么）：
//!
//! | 原因 | 含义 | 动作 | 规则 |
//! |---|---|---|---|
//! | `no-price-card` | 归属已定，缺价卡 | 补卡 / 确认模型名 | `PRICE_COVERAGE` |
//! | `billing-route-unknown` | 连归属都没定 | 确认计费方式 | `ROUTE_UNCONFIRMED` |
//!
//! **与"从厂商页抓价"的分界**：本模块只做"发现"，不做"取价"。取价要么由维护者
//! 更新公共目录（既有链路），要么由用户确认后手填——**不做爬虫**。这条分界是刻意
//! 的：每家的定价页格式不同且会变，自动解析出来的价格表会坏得比它带来的价值快。

use std::collections::BTreeMap;

use agent_vitals_data::authority::AuthorityDb;

/// 「路由能定，但没有价卡」→ 动作是补一张卡。
/// 含 `unpriced` → `source_issue_groups` 自动归入 `PRICE_COVERAGE`（既有映射）。
const UNPRICED_CODE: &str = "unpriced_model";

/// 「连归属都没定下来」→ 动作是确认计费方式/路由（REQ-074 的「路由待确认」）。
/// 含 `route` → 归入 `ROUTE_UNCONFIRMED` 规则。
const UNROUTED_CODE: &str = "unrouted_usage";

/// WorkBuddy 的 provider 恒为 null 是**设计**（执行环境就是不报，§2.1 明确记为
/// unresolved money by design）。给它建"去确认路由"的任务，等于让用户去确认一件
/// 执行环境从未提供、也无从确认的信息——那是把设计当缺陷，必须排除。
const ROUTE_UNCONFIRMED_EXEMPT_HARNESSES: &[&str] = &["workbuddy"];

/// 对账一轮：没有价卡的模型 → 建/刷新任务；已经能计价的 → 自动解决。
///
/// 返回仍然有任务的 (模型, 原因) 条数。
///
/// 粒度是**一个模型一条**：可执行单元就是"这个模型要么补卡、要么定路由"。同一个
/// 模型经不同执行环境/服务商出现时仍算一条——要补的是同一张卡。
///
/// **两种原因、两种动作**（合并成一条会让用户不知道该做什么）：
/// - `no-price-card`：归属已定，价卡缺 → 补卡 / 确认模型名；
/// - `billing-route-unknown`：归属本身没定 → 确认计费方式。
pub fn reconcile_unpriced_models(
    db: &AuthorityDb,
    month: &str,
    now_ms: i64,
) -> Result<usize, String> {
    let detail = crate::summary::unresolved_detail(month);

    // (code, model) → (harness/provider, tokens)
    let mut tasks: BTreeMap<(String, String), (String, i64)> = BTreeMap::new();
    if let Some(map) = detail.as_object() {
        for (harness_provider, rows) in map {
            let harness = harness_provider.split('/').next().unwrap_or("");
            let Some(rows) = rows.as_array() else { continue };
            for row in rows {
                let Some(reason) = row.get("reason").and_then(serde_json::Value::as_str) else {
                    continue;
                };
                let Some(code) = task_code_for(reason, harness) else { continue };
                let Some(model) = row.get("model").and_then(serde_json::Value::as_str) else {
                    continue;
                };
                let tokens = row.get("tokens").and_then(serde_json::Value::as_i64).unwrap_or(0);
                let entry = tasks
                    .entry((code.to_string(), model.to_string()))
                    .or_insert_with(|| (harness_provider.clone(), 0));
                entry.1 += tokens;
            }
        }
    }

    let conn = db.conn();
    for ((code, model), (harness_provider, tokens)) in &tasks {
        let (harness, provider) = match harness_provider.split_once('/') {
            Some((harness, provider)) => (harness, provider),
            None => (harness_provider.as_str(), "unknown"),
        };
        let payload = serde_json::json!({
            "harness": harness,
            "provider_id": provider,
            "model_id": model,
            "tokens": tokens,
            // 证据就是"本地事实 × 本地价卡"，明确写出来，免得读的人以为我们查了网。
            "evidence": "本地用量事实与本地价卡比对",
        });
        conn.execute(
            "INSERT INTO data_quality_issues(
                 issue_id, scope_type, scope_key, code, severity,
                 first_seen_at_ms, last_seen_at_ms, resolved_at_ms, detail_json)
             VALUES (?1, 'model', ?2, ?3, 'warning', ?4, ?4, NULL, ?5)
             ON CONFLICT(scope_type, scope_key, code) DO UPDATE SET
                 last_seen_at_ms = excluded.last_seen_at_ms,
                 resolved_at_ms = NULL,
                 detail_json = excluded.detail_json",
            rusqlite::params![
                format!("unresolved-model:{code}:{model}"),
                model,
                code,
                now_ms,
                payload.to_string(),
            ],
        )
        .map_err(|error| error.to_string())?;
    }

    // 已经定下来了 → 自动解决（行保留，历史不丢）。两种 code 各自结算。
    for code in [UNPRICED_CODE, UNROUTED_CODE] {
        let still: Vec<&str> = tasks
            .keys()
            .filter(|(c, _)| c == code)
            .map(|(_, m)| m.as_str())
            .collect();
        resolve_stale_unresolved_issues(conn, code, &still, now_ms).map_err(|e| e.to_string())?;
    }

    Ok(tasks.len())
}

/// 未计价原因 → 任务 code。`None` = 不为这条原因建任务。
///
/// 单独成函数是为了让 **WorkBuddy 的豁免**能被直接断言——它是这里唯一一个
/// "看起来该建任务、其实不该"的分支（设计使然，不是缺陷）。
fn task_code_for(reason: &str, harness: &str) -> Option<&'static str> {
    match reason {
        "no-price-card" => Some(UNPRICED_CODE),
        "billing-route-unknown" if !ROUTE_UNCONFIRMED_EXEMPT_HARNESSES.contains(&harness) => {
            Some(UNROUTED_CODE)
        }
        _ => None,
    }
}

/// 把「已经不在无价卡集合里」的旧任务结算掉。
///
/// 单独成函数是为了能直接测那段手写的 `NOT IN (?1,?2,…)` ——占位符数量是动态的，
/// 而且空集合要退化成"全部解决"，这两点最容易写错。
fn resolve_stale_unresolved_issues(
    conn: &rusqlite::Connection,
    code: &str,
    still_unpriced: &[&str],
    now_ms: i64,
) -> rusqlite::Result<usize> {
    if still_unpriced.is_empty() {
        // 空集合不能生成 `NOT IN ()`（那是语法错误）；语义是"已经没有无价卡的模型了"。
        return conn.execute(
            &format!(
                "UPDATE data_quality_issues SET resolved_at_ms = ?1
                 WHERE code = '{code}' AND resolved_at_ms IS NULL"
            ),
            [now_ms],
        );
    }
    let placeholders = (1..=still_unpriced.len())
        .map(|i| format!("?{i}"))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "UPDATE data_quality_issues SET resolved_at_ms = ?{}
         WHERE code = '{code}' AND resolved_at_ms IS NULL
           AND scope_key NOT IN ({placeholders})",
        still_unpriced.len() + 1
    );
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = still_unpriced
        .iter()
        .map(|m| Box::new((*m).to_string()) as Box<dyn rusqlite::ToSql>)
        .collect();
    params.push(Box::new(now_ms));
    let refs: Vec<&dyn rusqlite::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    conn.execute(&sql, refs.as_slice())
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_vitals_data::authority::AuthorityDb;

    fn seed(conn: &rusqlite::Connection, model: &str, now_ms: i64) {
        conn.execute(
            "INSERT INTO data_quality_issues(
                 issue_id, scope_type, scope_key, code, severity,
                 first_seen_at_ms, last_seen_at_ms, resolved_at_ms, detail_json)
             VALUES (?1, 'model', ?2, ?3, 'warning', ?4, ?4, NULL, '{}')",
            rusqlite::params![format!("unpriced-model:{model}"), model, UNPRICED_CODE, now_ms],
        )
        .unwrap();
    }

    fn open_count(conn: &rusqlite::Connection) -> i64 {
        conn.query_row(
            &format!("SELECT COUNT(*) FROM data_quality_issues WHERE code = '{UNPRICED_CODE}' AND resolved_at_ms IS NULL"),
            [], |r| r.get(0),
        ).unwrap()
    }

    #[test]
    fn stale_unpriced_issues_are_resolved_and_current_ones_survive() {
        let dir = std::env::temp_dir().join(format!("av-pricedisc-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = AuthorityDb::open(&dir.join("agent-vitals.sqlite3"), 1_700_000_000_000).unwrap();
        for m in ["a", "b", "c"] { seed(db.conn(), m, 1_000); }
        assert_eq!(open_count(db.conn()), 3);

        // 只有 a 还是无价卡 → b、c 必须被结算掉。
        let n = resolve_stale_unresolved_issues(db.conn(), UNPRICED_CODE, &["a"], 2_000).unwrap();
        assert_eq!(n, 2, "应结算两条");
        assert_eq!(open_count(db.conn()), 1, "只剩 a 还开着");
        let a_open: i64 = db.conn().query_row(
            &format!("SELECT COUNT(*) FROM data_quality_issues WHERE code='{UNPRICED_CODE}' AND scope_key='a' AND resolved_at_ms IS NULL"),
            [], |r| r.get(0)).unwrap();
        assert_eq!(a_open, 1, "当前的不能误伤");

        // 空集合 = 全部解决（这里最容易写成 `NOT IN ()` 语法错误）。
        let n = resolve_stale_unresolved_issues(db.conn(), UNPRICED_CODE, &[], 3_000).unwrap();
        assert_eq!(n, 1);
        assert_eq!(open_count(db.conn()), 0);

        // 幂等：再跑一次无事发生。
        assert_eq!(resolve_stale_unresolved_issues(db.conn(), UNPRICED_CODE, &[], 4_000).unwrap(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reason_maps_to_code_and_workbuddy_is_exempt_from_route_tasks() {
        // 两种原因两种动作；workbuddy 的 provider 恒为 null 是**设计**，
        // 不能建"去确认路由"的任务（用户无从确认执行环境从未提供的信息）。
        assert_eq!(task_code_for("no-price-card", "claude-code"), Some(UNPRICED_CODE));
        assert_eq!(task_code_for("billing-route-unknown", "claude-code"), Some(UNROUTED_CODE));
        assert_eq!(task_code_for("billing-route-unknown", "workbuddy"), None);
        // 无价卡与执行环境无关：workbuddy 真出现缺卡也该建（虽然当前不可能，因为它没有价卡面）。
        assert_eq!(task_code_for("no-price-card", "workbuddy"), Some(UNPRICED_CODE));
        // 别的原因不建任务（归属已定的部分覆盖等由别的流程管）。
        assert_eq!(task_code_for("partial-price-basis", "claude-code"), None);
    }

    #[test]
    fn routed_codes_land_in_their_own_rules_with_the_model_as_the_object() {
        // 接线契约：code 含 `unpriced` → 既有映射自动归 PRICE_COVERAGE；
        // object 取 model_id（任务主体就是"某个模型"）。
        let dir = std::env::temp_dir().join(format!("av-pricedisc-rule-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = AuthorityDb::open(&dir.join("agent-vitals.sqlite3"), 1_700_000_000_000).unwrap();
        // 用**真实 producer 的 payload 形状**播种（detail 里带 model_id）——
        // 之前用空 detail 播种，object 会落到 code 上，测的就不是真实形状了。
        db.conn().execute(
            "INSERT INTO data_quality_issues(
                 issue_id, scope_type, scope_key, code, severity,
                 first_seen_at_ms, last_seen_at_ms, resolved_at_ms, detail_json)
             VALUES (?1, 'model', ?2, ?3, 'warning', ?4, ?4, NULL, ?5)",
            rusqlite::params![
                "unpriced-model:acme/model-x", "acme/model-x", UNPRICED_CODE, 1_000i64,
                serde_json::json!({
                    "harness": "claude-code",
                    "provider_id": "deepseek-official",
                    "model_id": "acme/model-x",
                    "tokens": 14700,
                }).to_string(),
            ],
        ).unwrap();
        // 再播一条"路由未确认"，验证它归到**另一条**规则上。
        db.conn().execute(
            "INSERT INTO data_quality_issues(
                 issue_id, scope_type, scope_key, code, severity,
                 first_seen_at_ms, last_seen_at_ms, resolved_at_ms, detail_json)
             VALUES (?1, 'model', ?2, ?3, 'warning', ?4, ?4, NULL, ?5)",
            rusqlite::params![
                "unresolved-model:unrouted_usage:acme/model-y", "acme/model-y", UNROUTED_CODE, 1_000i64,
                serde_json::json!({"harness": "claude-code", "model_id": "acme/model-y"}).to_string(),
            ],
        ).unwrap();
        let groups = agent_vitals_data::issues::source_issue_groups(db.conn(), None, None).unwrap();
        let g = groups.iter().find(|g| g["rule"] == "PRICE_COVERAGE").expect("缺价应归 PRICE_COVERAGE");
        assert_eq!(g["object"], "acme/model-x", "object 应是模型");
        let r = groups.iter().find(|g| g["rule"] == "ROUTE_UNCONFIRMED").expect("路由未确认应独立成一条规则");
        assert_eq!(r["object"], "acme/model-y", "两类问题不混在一起");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
