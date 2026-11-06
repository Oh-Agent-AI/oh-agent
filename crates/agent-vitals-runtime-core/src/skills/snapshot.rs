//! 快照与 `diff` 的呈现（PRODUCT §5.5、ARCHITECTURE §8.3）。
//!
//! 快照存在的唯一理由：本工具自己规定「装不够 N 天的不算僵尸，2–3 周后复查」，
//! 而复查时没人记得基线。没有快照，那条建议就是空头支票。
//!
//! **快照只落在本机。**它含绝对路径、用户名、skill 名与完整 description ——
//! 一个审计供应链风险的工具不能自己回传数据。

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

use agent_vitals_domain::util::{i, s};
// v0.8 Phase E7.4：本文件从 apps/cli/src/skills/ 迁进本 crate（D7 时
// snapshot_dir/data_home 已经先一步迁到 agent-vitals-runtime::home，本文件
// 当时留在 apps/cli 靠 re-export 桥过去）——现在同一个 crate 内，直接引用
// 兄弟模块，不用再 re-export。
use crate::home::snapshot_dir;

pub const SNAPSHOT_KEEP: i64 = 30;
/// §6.2：2 = 工具自身错误（路径不可读、配置非法等）
const EXIT_TOOL_ERROR: i32 = 2;
const DIR_MODE: u32 = 0o700;
const FILE_MODE: u32 = 0o600;

/// 已有快照，**旧→新**。文件名是 UTC 紧凑时间戳，字典序即时间序。
pub fn list_snapshots() -> Vec<PathBuf> {
    let d = snapshot_dir();
    let mut out: Vec<PathBuf> = match std::fs::read_dir(&d) {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.is_file() && p.extension().map(|x| x == "json").unwrap_or(false))
            .collect(),
        Err(_) => return Vec::new(),
    };
    out.sort();
    out
}

pub fn latest_snapshot() -> Option<PathBuf> {
    list_snapshots().pop()
}

#[cfg(unix)]
fn chmod(p: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode));
}
#[cfg(not(unix))]
fn chmod(_p: &Path, _mode: u32) {}

/// UTC 紧凑时间戳 `YYYYMMDDTHHMMSSZ`。
///
/// 不引第三方时间库：这个仓库的硬约束是零依赖（scan.py 是纯标准库，Rust 侧
/// 也只用必需的几个 crate）。民用历法换算就这几行。
fn utc_stamp(secs: i64) -> String {
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    let (h, mi, sec) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // 1970-01-01 起的天数 → 年月日（Howard Hinnant 的 civil_from_days）
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}{m:02}{d:02}T{h:02}{mi:02}{sec:02}Z")
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 写一份快照并轮换。返回写入的路径。
///
/// **存进去的是一份干净的扫描记录，不带 `diff_vs_baseline`。**否则第二份快照
/// 里会嵌着「相对第一份的差异」，第三份又嵌着第二份的 —— 快照就从「某一时刻
/// 的事实」变成一条越滚越大的历史链，而 diff 本来就该由两份事实现算。
pub fn save_snapshot(out: &Value, keep: i64) -> std::io::Result<PathBuf> {
    let d = snapshot_dir();
    // 目录 0700、文件 0600。Windows 上是空操作，但**不能因此就不调** ——
    // POSIX 上这是唯一的防线。
    std::fs::create_dir_all(&d)?;
    chmod(&d, DIR_MODE);

    let mut body = Map::new();
    if let Some(obj) = out.as_object() {
        for (k, v) in obj {
            if k != "diff_vs_baseline" {
                body.insert(k.clone(), v.clone());
            }
        }
    }
    let ts = utc_stamp(now_secs());
    // 同一秒内跑两次不能互相覆盖：加序号，别让第二次静默吃掉第一次
    let mut path = d.join(format!("{ts}.json"));
    let mut n = 1;
    while path.exists() {
        n += 1;
        path = d.join(format!("{ts}-{n}.json"));
    }
    let text = serde_json::to_string_pretty(&Value::Object(body)).unwrap_or_default();
    std::fs::write(&path, text)?;
    chmod(&path, FILE_MODE);

    // 轮换。keep=0 表示不限制 —— **不是「一份都不留」**，那会让刚写的这份
    // 立刻被删掉，用户看到「已保存」却什么都没有。
    if keep > 0 {
        let all = list_snapshots();
        if all.len() > keep as usize {
            for old in &all[..all.len() - keep as usize] {
                let _ = std::fs::remove_file(old);
            }
        }
    }
    Ok(path)
}

fn arr<'a>(v: &'a Value, k: &str) -> &'a [Value] {
    v.get(k).and_then(|x| x.as_array()).map(|a| a.as_slice()).unwrap_or(&[])
}

/// 兼容旧快照：老的基线里 `added_skills` 是裸数组。
fn diff_name(entry: &Value) -> String {
    if let Some(o) = entry.as_object() {
        let name = o.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let ns = o.get("namespace").and_then(|v| v.as_str()).unwrap_or("");
        return if ns.is_empty() { name.to_string() } else { format!("{ns}:{name}") };
    }
    if let Some(a) = entry.as_array() {
        return a.last().and_then(|v| v.as_str()).unwrap_or("").to_string();
    }
    entry.as_str().unwrap_or("").to_string()
}

pub struct SnapshotOpts {
    pub keep: i64,
    pub redacted: bool,
}

/// `snapshot` 的呈现。返回 (文本, 退出码)。
pub fn render_snapshot(out: &Value, o: &SnapshotOpts) -> (String, i32) {
    let mut w = String::new();
    match save_snapshot(out, o.keep) {
        Err(e) => {
            w.push_str(&format!("Could not save snapshot: {e}\n"));
            (w, 1)
        }
        Ok(path) => {
            let kept = list_snapshots().len();
            w.push_str(&format!("Snapshot saved → {}\n", path.display()));
            w.push_str(&format!("  Retained {} snapshots (--keep {})\n", kept, o.keep));
            w.push_str("  Directory mode 0700, file mode 0600; local only, never uploaded\n");
            if !o.redacted {
                // 落盘的是未脱敏的原始记录 —— 说清楚，别让用户以为它可以随手外发
                w.push_str("  ! Not redacted: contains absolute paths, user names, skill names, and full descriptions. \
Use --redact --redact-names before sharing.\n");
            }
            (w, 0)
        }
    }
}

/// `diff` 的呈现（PRODUCT §5.5）。返回 (文本, 是否走 stderr, 退出码)。
pub fn render_diff(out: &Value, zombie_gate: i64) -> (String, bool, i32) {
    let d = match out.get("diff_vs_baseline") {
        None => {
            // **「没有基线」与「没有变化」必须区分。**返回 0 加一句空输出会被
            // 读成「查过了，没变化」—— 同 §3.1 的 null ≠ 0，只是换到了退出码上。
                        // **2，不是 1。**§6.2 把 1 定义成「存在达到阈值的发现」；拿它表示
            // 「没东西可比」是在滥用那个码 —— CI 会把前置条件缺失读成「扫出
            // 问题」。2 才是「工具没能完成工作」。
            return (
                "No snapshot is available for comparison.\nRun `agent-vitals doctor` \
(saves one automatically) or `agent-vitals snapshot` first.\n".to_string(),
                true, EXIT_TOOL_ERROR,
            );
        }
        Some(d) => d,
    };
    if let Some(e) = d.get("error").and_then(|v| v.as_str()) {
        return (format!("{e}\n"), true, EXIT_TOOL_ERROR);
    }

    let mut w = String::new();
    macro_rules! p {
        ($($t:tt)*) => { w.push_str(&format!($($t)*)); w.push('\n'); };
    }

    let base = s(d, "baseline_file");
    let short = Path::new(&base)
        .file_name()
        .map(|x| x.to_string_lossy().to_string())
        .unwrap_or_else(|| base.clone());
    // 标题行只放文件名（路径可能很长），完整路径在末行给出 —— 既可读又可复现
    p!("Changes since {}", if short.is_empty() { base.clone() } else { short });
    p!("{}", "─".repeat(42));

    let added = arr(d, "added_skills");
    let removed = arr(d, "removed_skills");
    if !added.is_empty() || !removed.is_empty() {
        p!("");
        p!("Skills");
        for k in added {
            p!("  + {}", diff_name(k));
        }
        for k in removed {
            p!("  - {}", diff_name(k));
        }
    }

    // **没变就不出现这一小节。**打一句「无变化 (+0.0%)」既占地方又自相矛盾，
    // 而 diff 只该回答「这次多出/少了什么」。
    let pct = arr(d, "budget_pct_then_now");
    let pt = pct.first().and_then(|v| v.as_f64());
    let pn = pct.get(1).and_then(|v| v.as_f64());
    let delta = d.get("budget_delta_chars").and_then(|v| v.as_i64()).unwrap_or(0);
    let budget_changed = delta != 0 && pt.is_some() && pn.is_some();
    if budget_changed {
        let over = out
            .get("description_budget")
            .and_then(|b| b.get("over_by_chars"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        p!("");
        p!("Description budget");
        p!("  {:+} chars   {:.1}% → {:.1}%{}", delta, pt.unwrap_or(0.0), pn.unwrap_or(0.0),
           if over > 0 { "   ⚠ overflow" } else { "" });
    }

    let new_pairs = arr(d, "new_overlap_candidates");
    if !new_pairs.is_empty() {
        p!("");
        p!("New overlap candidates          [Lexical, review required]");
        for pr in new_pairs {
            let a = pr.get(0).and_then(|v| v.as_str()).unwrap_or("");
            let b = pr.get(1).and_then(|v| v.as_str()).unwrap_or("");
            p!("  {} ↔ {}", a, b);
        }
    }

    let ud = arr(d, "usage_delta");
    if !ud.is_empty() {
        p!("");
        p!("Trigger deltas");
        let width = ud.iter().map(|x| s(x, "name").chars().count()).max().unwrap_or(0);
        for x in ud {
            p!("  {}  {:+}   (total {})", pad(&s(x, "name"), width),
               i(x, "delta"), i(x, "now"));
        }
    }

    let ns = arr(d, "new_security_findings");
    if !ns.is_empty() {
        p!("");
        p!("New security findings");
        for x in ns {
            p!("  {}  {}  {}:{}", s(x, "skill"), s(x, "rule"), s(x, "where"), i(x, "line"));
        }
    }

    let nj = arr(d, "newly_judgeable");
    if !nj.is_empty() {
        // **只报这一批。**老结论重报一遍会把「本次新增的判定对象」淹掉，
        // 而那恰恰是复查唯一要看的东西（PRODUCT §5.5）。
        p!("");
        p!("Newly judgeable (previously too new; now at least {} days old)", zombie_gate);
        let width = nj.iter().map(|x| s(x, "name").chars().count()).max().unwrap_or(0);
        for x in nj {
            p!("  {}  {} triggers → {}", pad(&s(x, "name"), width),
               i(x, "usage_count"), s(x, "verdict"));
        }
    }

    if added.is_empty() && removed.is_empty() && !budget_changed
        && new_pairs.is_empty() && ud.is_empty() && ns.is_empty() && nj.is_empty()
    {
        p!("");
        p!("  No changes from the baseline.");
    }
    p!("");
    p!("  Baseline: {}", base);
    (w, false, 0)
}

/// 按**字符数**左对齐补空格（同 skills::render::pad 的口径）。
fn pad(s: &str, w: usize) -> String {
    let n = s.chars().count();
    let mut out = s.to_string();
    if n < w {
        out.push_str(&" ".repeat(w - n));
    }
    out
}

/// doctor 跑完之后存一份快照，并**在写成功之后**才说自己存了。
///
/// 这句话曾经被刻意删掉：快照没实现之前打「✓ 已保存快照 → 下次运行会自动
/// 对比」，是承诺一件工具做不到的事。现在它能做到了，但那条纪律不变 ——
/// **写失败就不能说写成功**。只读的 home、没权限的目录都会走到这条路上。
pub fn doctor_snapshot(out: &Value, enabled: bool) -> String {
    let mut w = String::new();
    if !enabled {
        w.push('\n');
        w.push_str("  No snapshot saved. To compare before and after:\n");
        w.push_str("    agent-vitals snapshot   then agent-vitals diff\n");
        return w;
    }
    match save_snapshot(out, SNAPSHOT_KEEP) {
        Err(e) => {
            w.push('\n');
            w.push_str(&format!("  ! Could not save snapshot: {e}\n"));
            w.push_str("    Automatic comparison is unavailable; you can still save one manually with --json.\n");
        }
        Ok(path) => {
            w.push('\n');
            w.push_str("  ✓ Snapshot saved → the next run will compare automatically\n");
            w.push_str(&format!("    {}\n", path.display()));
        }
    }
    w
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn utc_stamp_matches_python_strftime() {
        // python: time.strftime("%Y%m%dT%H%M%SZ", time.gmtime(x))
        assert_eq!(utc_stamp(0), "19700101T000000Z");
        assert_eq!(utc_stamp(1_000_000_000), "20010909T014640Z");
        assert_eq!(utc_stamp(1_767_225_600), "20260101T000000Z");
        assert_eq!(utc_stamp(1_782_000_000), "20260621T000000Z");
        assert_eq!(utc_stamp(1_786_000_000), "20260806T070640Z");
        // 闰年 2 月末与 3 月初
        assert_eq!(utc_stamp(1_709_164_800), "20240229T000000Z");
        assert_eq!(utc_stamp(1_709_251_200), "20240301T000000Z");
    }

    #[test]
    fn newly_judgeable_section_renders() {
        // 这一段端到端不可达：触发它需要 skill 在两次扫描之间跨过年龄闸，
        // 那是真实日历时间。逻辑本身由 diff_against 的特征测试钉着，这里只
        // 验渲染 —— 与 Python 侧 test_snapshot.py 的同名测试对应。
        let out = json!({
            "diff_vs_baseline": {
                "baseline_file": "/snaps/old.json",
                "added_skills": [], "removed_skills": [], "usage_delta": [],
                "budget_pct_then_now": [Value::Null, Value::Null],
                "budget_delta_chars": 0,
                "new_overlap_candidates": [], "new_security_findings": [],
                "newly_judgeable": [
                    {"name": "old-pdf", "usage_count": 0, "verdict": "zombie"},
                    {"name": "new-linter", "usage_count": 6, "verdict": "alive"},
                ],
            }
        });
        let (t, _, rc) = render_diff(&out, 14);
        assert_eq!(rc, 0);
        assert!(t.contains("Newly judgeable (previously too new; now at least 14 days old)"), "{t}");
        assert!(t.contains("old-pdf"));
        assert!(t.contains("zombie"));
        assert!(t.contains("new-linter"));
        assert!(t.contains("alive"));
        assert!(!t.contains("No changes from the baseline"),
                "有 newly_judgeable 还说没变化，是自相矛盾");
    }

    #[test]
    fn no_baseline_is_a_tool_error_not_a_finding() {
        // **2，不是 1。**这条原本断言 1，理由是「非零即可，别被读成没有变化」。
        // 理由仍然成立，但码选错了：§6.2 把 1 定义成「存在达到阈值的发现」，
        // 拿它表示「没东西可比」会让 CI 把前置条件缺失读成「扫出问题」。
        let (t, stderr, rc) = render_diff(&json!({}), 14);
        assert_eq!(rc, EXIT_TOOL_ERROR);
        assert!(stderr);
        assert!(t.contains("No snapshot is available for comparison."));
        assert!(!t.contains("No changes from the baseline"));
    }

    #[test]
    fn old_bare_array_entries_still_render() {
        // 旧快照里 added_skills 是裸数组；换形状之后不能让老基线渲染成空
        assert_eq!(diff_name(&json!(["claude-code", Value::Null, "", "x"])), "x");
        assert_eq!(diff_name(&json!({"namespace": "pg", "name": "gh"})), "pg:gh");
        assert_eq!(diff_name(&json!({"namespace": "", "name": "gh"})), "gh");
    }

    #[test]
    fn pad_counts_chars_not_display_width() {
        // 与 skills::render::pad 同口径：两个实现的格式化原语都按字符计，字符计才能
        // 让输出逐字节一致（显示宽度在 CJK 名字上两边都会偏，但偏得一样）。
        assert_eq!(pad("中文", 4), "中文  ");
        assert_eq!(pad("ab", 4), "ab  ");
    }
}
