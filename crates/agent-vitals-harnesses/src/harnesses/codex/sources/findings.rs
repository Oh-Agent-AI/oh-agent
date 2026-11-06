//! Codex 会话的行为 findings 评估（W3 从 runtime `ingest/findings_eval.rs` 搬来）。
//!
//! 一个会话可以横跨多份 rollout（live / archived 拷贝、resume 新开的文件）。只能按
//! **内容**里的 session_id 分组：第一版按「文件名含 session uuid」挑兄弟文件，真机回填
//! 对拍抓到——resume 会开新 uuid 命名的 rollout 却沿用原会话的 session_meta id，一个
//! 真实会话横跨 25 个文件、文件名命中的只有 1 个；合并事件流不同 → seq 整体偏移 →
//! issue 被误关、换指纹重开。
//!
//! session_id 只能从内容读（整份解析），所以按 `(size, mtime_ns)` 指纹缓存「路径 →
//! session_id」：未变文件零解析，变了的文件本来就要解析。分组结果与 r2a 的全量过滤
//! 逐一等价。缓存读不到 / 坏了 = 全部重解析（慢但对），不影响正确性。

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::sources::session_harnesses::{findings_from_payload, FindingsCtx, SessionFindings};

fn fingerprint(path: &Path) -> Option<(u64, u128)> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_nanos();
    Some((meta.len(), mtime))
}

/// 先写同目录临时文件再 rename：进程中途被杀不会留下半份 JSON（半份会被当成坏缓存
/// 全量重解析，不致错，但每轮都付一次全量）。写失败静默——缓存只是加速。
fn write_cache(path: &Path, data: &Value) {
    let Some(dir) = path.parent() else { return };
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    if std::fs::write(&tmp, data.to_string()).is_ok() && std::fs::rename(&tmp, path).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

/// 「路径 → session_id」索引（见模块文档）。缓存只保留本轮文件集的条目。
pub(crate) fn session_index(cache_path: &Path, all_files: &[PathBuf]) -> BTreeMap<PathBuf, String> {
    let cached: Value = std::fs::read(cache_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(Value::Null);
    let mut index = BTreeMap::new();
    let mut entries = serde_json::Map::new();
    for path in all_files {
        let key = path.to_string_lossy().to_string();
        let fp = fingerprint(path);
        let hit = fp.and_then(|(size, mtime)| {
            let e = cached.get("entries")?.get(&key)?;
            (e.get("size")?.as_u64()? == size && e.get("mtime_ns")?.as_str()? == mtime.to_string())
                .then(|| e.get("session_id")?.as_str().map(str::to_owned))
                .flatten()
        });
        let sid = hit.unwrap_or_else(|| super::session_audit::codex_session_id_of(path));
        if let Some((size, mtime)) = fp {
            // mtime 用字符串存：纳秒超出 JSON 安全整数范围。
            entries.insert(key, json!({"size": size, "mtime_ns": mtime.to_string(), "session_id": sid}));
        }
        index.insert(path.clone(), sid);
    }
    write_cache(cache_path, &json!({"version": 1, "entries": entries}));
    index
}

/// 变化文件 → 受影响的 session → 各自的全部文件（`codex_rollout_files` 同一全局序）。
pub(crate) fn groups(
    changed: &[PathBuf],
    index: &BTreeMap<PathBuf, String>,
) -> BTreeMap<String, Vec<PathBuf>> {
    let sids: BTreeSet<&String> = changed.iter().filter_map(|p| index.get(p)).collect();
    let mut groups: BTreeMap<String, Vec<PathBuf>> = BTreeMap::new();
    for (path, sid) in index {
        if sids.contains(sid) {
            groups.entry(sid.clone()).or_default().push(path.clone());
        }
    }
    for files in groups.values_mut() {
        files.sort_by(|a, b| a.to_string_lossy().cmp(&b.to_string_lossy()));
    }
    groups
}

pub fn evaluate(
    ctx: &FindingsCtx<'_>,
    changed: &[PathBuf],
    all_files: &[PathBuf],
) -> (Vec<SessionFindings>, Vec<String>) {
    let mut universe: Vec<PathBuf> = all_files.iter().chain(changed.iter()).cloned().collect();
    universe.sort();
    universe.dedup();
    let index = session_index(ctx.codex_index_cache, &universe);
    let mut out = Vec::new();
    let mut errors = Vec::new();
    for (sid, files) in groups(changed, &index) {
        match super::session_audit::codex_session_audit_json_for_files(ctx.roots.user_home, &sid, &files) {
            Some(payload) => out.push(SessionFindings {
                harness: "codex",
                native_id: sid.clone(),
                findings: findings_from_payload("codex", &payload),
            }),
            None => errors.push(format!("codex findings {sid}: no rollout matched")),
        }
    }
    (out, errors)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sources::session_harnesses::HarnessRoots;

    /// Codex 分组按**内容** session_id：live + archived 拷贝、以及 resume 新开的
    /// 文件（文件名是另一个 uuid，但 session_meta 仍是原会话 id）都归同一会话。
    /// 第一版按文件名预筛，真机一个 25 文件的会话只挑到 1 个（见模块文档）。
    #[test]
    fn groups_follow_content_session_id_not_file_name() {
        let t = std::env::temp_dir().join(format!("av-findings-codex-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&t);
        let live = t.join(".codex/sessions/2026/09/05");
        let arch = t.join(".codex/archived_sessions");
        std::fs::create_dir_all(&live).unwrap();
        std::fs::create_dir_all(&arch).unwrap();
        let cache = t.join("data/facts/.codex-session-index.json");
        let sid = "019f0000-0000-7000-8000-000000000001";
        let meta = |id: &str| format!(
            "{}\n",
            json!({"timestamp":"2026-09-05T17:00:00.000Z","type":"session_meta","payload":{"id":id,"cwd":"/tmp/w"}})
        );
        let name = format!("rollout-2026-09-05T17-00-00-{sid}.jsonl");
        std::fs::write(live.join(&name), meta(sid)).unwrap();
        std::fs::write(arch.join(&name), meta(sid)).unwrap();
        // resume：新 uuid 的文件名，内容仍是原会话 id。
        let resumed = live.join("rollout-2026-09-06T09-00-00-019f0000-0000-7000-8000-00000000aaaa.jsonl");
        std::fs::write(&resumed, meta(sid)).unwrap();
        let other = live.join("rollout-2026-09-05T18-00-00-019f0000-0000-7000-8000-00000000ffff.jsonl");
        std::fs::write(&other, meta("019f0000-0000-7000-8000-00000000ffff")).unwrap();
        let all = super::super::codex_rollout_files(&t);
        assert_eq!(all.len(), 4);

        let index = session_index(&cache, &all);
        let g = groups(std::slice::from_ref(&resumed), &index);
        assert_eq!(g.len(), 1, "只动了一个会话");
        assert_eq!(g[sid].len(), 3, "live + archived + resume 三份同属一个会话");
        assert!(!g[sid].contains(&other));
        // 缓存命中：第二次索引结果一致（且缓存文件已落盘，父目录按需创建）。
        assert!(cache.exists());
        assert_eq!(session_index(&cache, &all), index);

        let pricing = Value::Null;
        let ctx = FindingsCtx {
            roots: HarnessRoots { user_home: &t, dsh_home: None },
            codex_index_cache: &cache,
            pricing: &pricing,
        };
        let (sessions, errors) = evaluate(&ctx, &[resumed], &all);
        assert!(errors.is_empty(), "{errors:?}");
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].native_id, sid);
        let _ = std::fs::remove_dir_all(&t);
    }
}
