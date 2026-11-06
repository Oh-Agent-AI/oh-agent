//! Stage A（P0）：`UsageFact` append-only JSONL writer——事实写入、去重、
//! 重放与 reconciliation 的机制层（spec §3.4/§3.5/§7 Stage A）。
//!
//! **机制层，不含生产者**：本模块只回答「一份合法的 `UsageFact` 如何幂等地
//! 落盘、如何无歧义地读回」；wire → fact 的生产者（`{claude,codex,dsh}_
//! usage_fact` emitter）仍在 apps/cli（Stage 0.3 记录的归位 scope gap，
//! R4 §7 Stage A 前置项）。两者解耦：writer 消费的是
//! `domain::contracts::usage_fact` 契约层，与 emitter 住在哪个 crate 无关。
//!
//! **P0 显式不做的**（spec §3.5 写入协议的后续段）：writer lease、intent、
//! projection/manifest/checkpoint 都是 P1——本模块只保证单进程内
//! exactly-once 追加与崩溃可读，多进程一致性与可恢复半提交是下一批。
//!
//! 三条设计决定（每条都写明为什么）：
//!
//! 1. **去重 = 内存 `fact_id` 集合 + open 时全文件重放扫描**。`fact_id` 由
//!    契约层从 6 个身份字段算出（`build_usage_fact` 内部 stamp，调用方传了
//!    也会被覆盖——身份不接受外部声称），所以「同一逻辑事件重复 emit」必然
//!    得到同一 `fact_id`，集合查重就是 exactly-once。open 的 O(n) 扫描在
//!    P1 SQLite 索引化之前是唯一诚实的方案；文件按 13 个月保留策略滚动
    //!    （spec §6），单文件规模有上界。
//! 2. **崩溃尾面修复（不是只容忍）**：append 单行 JSON 后进程可能死在写入
//!    中途，留下半行。半行本身无害，**在半行上继续追加有害**——新事实会与
//!    残行合并成一条损坏行（新事实被吞、下次 open 永远 Corrupt）。所以
//!    `open` 重放时判定尾面动作并落实：半行 → 截断回最后一条合法行；完整
//!    JSON 缺收尾 '\n'（write_all 恰好死在换行前）→ 补 '\n' 封口；**中间
//!    行**解析失败 → `Corrupt` 错误——那不是崩溃边界，是真实损坏，静默跳
//!    过就是把损坏伪装成没发生。
//! 3. **不取时钟**：chrono/time 被本 crate 的 dependency_budget 禁止，且
//!    事实自带 `event_ts_utc`（执行环境事件时间）；写入顺序就是文件序，重放
//!    排序（`sort_key`）按 `(time_basis, fact_id)` 确定化——同一份文件在
//!    任何机器上重放出同一个序列。

use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};

use agent_vitals_domain::contracts::usage_fact::build_usage_fact;
use serde_json::json;

/// 单次 append 的结果。`Duplicate` 不是错误：exactly-once 语义下「重复 emit
/// 同一逻辑事件」是调用方的正常行为（重放、重跑、双管道），writer 幂等吞掉。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppendOutcome {
    Appended,
    Duplicate,
}

/// append 失败的原因。`Invalid` 携带契约层的问题清单（缺身份字段、token
/// 非法等——诚实报具体字段名）；`Corrupt` 表示已有文件中间出现不可解析行。
#[derive(Debug)]
pub enum AppendError {
    /// 契约校验失败（`build_usage_fact` 的问题清单原样透出）。
    Invalid(Vec<String>),
    /// 已有文件在非末尾位置存在不可解析行——真实损坏，拒绝继续追加。
    Corrupt { line_no: usize },
    /// 文件系统错误。
    Io(std::io::Error),
}

impl From<std::io::Error> for AppendError {
    fn from(e: std::io::Error) -> Self {
        AppendError::Io(e)
    }
}

impl std::fmt::Display for AppendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AppendError::Invalid(problems) => write!(f, "invalid fact: {}", problems.join("; ")),
            AppendError::Corrupt { line_no } => write!(f, "corrupt line {line_no}"),
            AppendError::Io(e) => write!(f, "io: {e}"),
        }
    }
}

/// 尾面修复动作（crash 中断点的两种形状，spec §3.5「重启恢复必须识别每个
/// 中断点」）。由 [`replay`] 报告、[`FactWriter::open`] 执行。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TailRepair {
    /// 末行是**完整合法 JSON 但缺收尾换行**：单次 `write_all(line + '\n')`
    /// 理论上可能恰好写到 '\n' 之前。事实本身没坏——补一个 '\n' 封口即可；
    /// 截断它反而丢一条好事实。
    SealNewline,
    /// 末行是 **crash 半行**（JSON 截断）：截断到最后一条合法行的行尾
    /// （字节偏移），恢复干净追加面。半行不可读，丢弃不是丢事实。
    Truncate { offset: u64 },
}

/// open（或重放）一份 facts 文件的结果：合法事实按文件序 + 尾面修复报告。
#[derive(Debug, Default)]
pub struct Replay {
    pub facts: Vec<serde_json::Value>,
    /// 尾面修复需求；`None` = 文件以换行干净收尾（或为空），无需修复。
    pub tail_repair: Option<TailRepair>,
}

/// 逐行解析一份 facts 文件，并判定尾面修复动作。中间坏行直接 Err——
/// 见模块头决定 2。
///
/// 与旧版「容忍末条坏行」的差别：容忍不是无害的——半行尾上继续 append 会
/// 把新事实与残行**合并成一条损坏行**（新事实被吞、下次 open 永远 Corrupt）。
/// 所以重放必须同时给出修复动作，`open` 落实它，追加面才真正干净。
pub fn replay(path: &Path) -> Result<Replay, AppendError> {
    let mut report = Replay::default();
    let Ok(bytes) = std::fs::read(path) else {
        return Ok(report); // 文件不存在 = 零事实，不是错误
    };
    // 按字节扫行（offset 是 truncate 需要的）：每行以 '\n' 终止；`start`
    // 是当前行首，`valid_end` 是最后一条合法/空白终止行的行尾 offset。
    let mut start = 0usize;
    let mut valid_end = 0usize;
    let mut line_no = 0usize;
    let mut i = 0usize;
    let parse = |raw: &[u8]| -> Option<serde_json::Value> {
        let bad = std::str::from_utf8(raw).ok()?;
        let bad = bad.strip_suffix('\r').unwrap_or(bad);
        if bad.trim().is_empty() {
            return None; // 空行：跳过（None 但不算坏）
        }
        serde_json::from_str::<serde_json::Value>(bad).ok()
    };
    while i < bytes.len() {
        if bytes[i] != b'\n' {
            i += 1;
            continue;
        }
        line_no += 1;
        match parse(&bytes[start..i]) {
            Some(v) => {
                report.facts.push(v);
                valid_end = i + 1;
            }
            None if bytes[start..i].iter().all(|b| b.is_ascii_whitespace()) => {
                valid_end = i + 1; // 空白行是合法表面
            }
            None => return Err(AppendError::Corrupt { line_no }),
        }
        start = i + 1;
        i = start;
    }
    // 尾段：无 '\n' 终止的最后一段（crash 半行或缺封口的完整行）。
    let tail = &bytes[start..];
    if !tail.is_empty() {
        match parse(tail) {
            Some(v) => {
                report.facts.push(v);
                report.tail_repair = Some(TailRepair::SealNewline);
            }
            None => {
                report.tail_repair = Some(TailRepair::Truncate { offset: valid_end as u64 });
            }
        }
    }
    Ok(report)
}

/// 保留策略报告（spec §6：UsageFact 13 个月滚动）。
#[derive(Debug, Default, serde::Serialize)]
pub struct RetainReport {
    pub kept: usize,
    pub dropped: usize,
    /// 没有 event_ts_utc 的事实——**一律保留**：无日期不是丢弃理由
    /// （丢了就永远找不回；保留只损失"能被月窗过滤"这一点）。
    pub kept_undated: usize,
}

/// 把 facts 文件截断到只保留 `cutoff_month`（"YYYY-MM"）及以后的事实。
///
/// **这是对权威自身的重写**——append-only 的唯一合法例外，条件全部写在
/// spec §6：只丢「有日期且日期早于 cutoff」的行；无日期行保留；原子替换
/// （temp + rename，与 state 写同款）；调用方必须持有 writer lease（本函数
/// 不拿锁——机制层不做编排决定）。幂等：重复调用第二次 dropped=0。
pub fn retain(path: &Path, cutoff_month: &str) -> Result<RetainReport, AppendError> {
    let rep = replay(path)?;
    let mut report = RetainReport::default();
    let mut kept_lines: Vec<String> = Vec::with_capacity(rep.facts.len());
    for fact in &rep.facts {
        // 日期判读必须严格是零填充 "YYYY-MM"（前 7 字节 + 两段数字）。
        // **审查 P2**：解析不出（year-only、epoch 数字串、非 ASCII）一律按
        // undated 保留——retain 是对权威的不可逆重写，把「格式不齐」当成
        // 「过期」就是静默丢数据（epoch 串 "1753000…" 的字符串序恒小于
        // cutoff，原来的兜底会把它们全部永久删除）。
        let dated = fact
            .get("event_ts_utc")
            .and_then(|v| v.as_str())
            .and_then(|ts| {
                let ym = ts.get(..7)?;
                let (y, m) = ym.split_at(4);
                let m = m.strip_prefix('-')?;
                y.parse::<i64>().ok()?;
                m.parse::<i64>().ok()?;
                Some(ym.to_string())
            });
        match dated {
            None => {
                report.kept_undated += 1;
                kept_lines.push(fact.to_string());
            }
            Some(ym) if ym.as_str() < cutoff_month => report.dropped += 1,
            Some(_) => {
                report.kept += 1;
                kept_lines.push(fact.to_string());
            }
        }
    }
    // 原子替换：同目录 temp（同文件系统 rename 才原子）+ rename。crash 在
    // rename 前只留一个 tmp 尾巴，权威文件完好。
    if report.dropped > 0 {
        let dir = path.parent().unwrap_or(Path::new("."));
        let tmp = dir.join(format!(
            ".{}.retain-tmp.{}",
            path.file_name().and_then(|n| n.to_str()).unwrap_or("facts"),
            std::process::id()
        ));
        std::fs::write(&tmp, {
            let mut s = kept_lines.join("\n");
            if !s.is_empty() {
                s.push('\n');
            }
            s
        })?;
        std::fs::rename(&tmp, path)?;
    }
    Ok(report)
}

/// append-only `UsageFact` writer。
///
/// `open` 做一次全文件重放构建 `fact_id` 集合（去重的依据），并**落实尾面
/// 修复**（[`TailRepair`]：半行截断 / 缺封口补 '\n'）——修复之后追加面才
/// 是干净的，否则新 append 会与 crash 残行合并成一条损坏行（新事实被吞，
/// 下次 open 永远 Corrupt）。之后的每次 `append` 校验 → 查重 → 单行追加。
///
/// **单写者假设**：同一进程内**顺序地**反复 open 同一文件是安全的（每次都
/// 重扫——调用方应持有 writer 复用，而不是每条 fact open 一次）；但**两个
/// `FactWriter` 同时存活**于同一文件不安全——后开者的 seen 是 open 时刻的
/// 快照，看不见前者新写入的事实，可能双写。P0 的单进程假设不含并发多
/// writer；跨进程/多 writer 互斥是 Stage B 的 lease（spec §3.5）。
pub struct FactWriter {
    facts_path: PathBuf,
    seen: HashSet<String>,
    tail_repair: Option<TailRepair>,
}

impl FactWriter {
    /// 打开（不存在则首次 append 时创建）。构建 seen 集合 + 修复 crash 尾面；
    /// 中间坏行在此提前暴露——带着一个已损坏的文件继续 append 只会让损坏
    /// 更难定位。修复动作可通过 [`Self::tail_repair`] 观测（调用方如实上报）。
    pub fn open(path: &Path) -> Result<Self, AppendError> {
        let rep = replay(path)?;
        let seen = rep
            .facts
            .iter()
            .filter_map(|f| f.get("fact_id").and_then(|v| v.as_str()).map(String::from))
            .collect();
        let mut tail_repair = None;
        if let Some(repair) = rep.tail_repair {
            match repair {
                TailRepair::SealNewline => {
                    let mut f = std::fs::OpenOptions::new().append(true).open(path)?;
                    f.write_all(b"\n")?;
                }
                TailRepair::Truncate { offset } => {
                    let f = std::fs::OpenOptions::new().write(true).open(path)?;
                    f.set_len(offset)?;
                }
            }
            tail_repair = Some(repair);
        }
        Ok(Self { facts_path: path.to_path_buf(), seen, tail_repair })
    }

    /// open 时执行的尾面修复（`None` = 文件本来干净）。观测/上报用。
    pub fn tail_repair(&self) -> Option<TailRepair> {
        self.tail_repair
    }

    /// 校验（`build_usage_fact`：补 `fact_id`/`schema_version`、缺失键置
    /// null）→ 查重 → 追加。返回写入的事实文档（调用方可用于后续断言）。
    pub fn append(
        &mut self,
        fields: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<(AppendOutcome, Option<serde_json::Value>), AppendError> {
        let fact = build_usage_fact(fields).map_err(AppendError::Invalid)?;
        let fact_id = fact
            .get("fact_id")
            .and_then(|v| v.as_str())
            .expect("build_usage_fact stamps fact_id")
            .to_string();
        if self.seen.contains(&fact_id) {
            return Ok((AppendOutcome::Duplicate, None));
        }
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.facts_path)?;
        // 单行 + 换行一次 write：O_APPEND 下小行的单次 write 是追加原子的
        // 临界保护（P0 单进程的假设在模块头写明；多进程是 P1 的 lease）。
        let mut line = fact.to_string();
        line.push('\n');
        file.write_all(line.as_bytes())?;
        file.flush()?;
        self.seen.insert(fact_id);
        Ok((AppendOutcome::Appended, Some(fact)))
    }

    /// 已去重的 fact_id 数（观测/测试用）。
    pub fn seen_count(&self) -> usize {
        self.seen.len()
    }
}

/// reconciliation：facts 的每执行环境 token 总和 vs 消费方 DTO 的
/// `tokens_by_harness`（Stage D 冻结形状）。**报告式，不 panic**——与
/// `usage.rs::unaccounted_usage` 哨兵同一惯例：发现矛盾是报告给上层决定，
/// 不是 writer 代替调用方 abort。
///
/// fact 的 token 桶（snake 四桶）与 `tokens_by_harness` 的四轴同词表；harness 取
/// `harness` 字段（by_harness 视角聚合）。缺桶按 0 计——「缺失」在 fact 层是
/// null（执行环境没这项证据），聚合为 0 是对的；「真实 0」也是 0，两者在聚合
/// 面等价是设计使然（区分发生在单 fact 层，那里 null 与 0 是不同的值）。
pub fn reconcile_tokens(
    facts: &[serde_json::Value],
    tokens_by_harness: &serde_json::Value,
) -> serde_json::Value {
    let mut from_facts: std::collections::BTreeMap<String, i64> = Default::default();
    for f in facts {
        let harness = f.get("harness").and_then(|v| v.as_str()).unwrap_or("unknown");
        let g = |k: &str| f.get(k).and_then(|v| v.as_i64()).unwrap_or(0);
        *from_facts.entry(harness.to_string()).or_insert(0) += g("uncached_input_tokens")
            + g("cache_read_tokens")
            + g("cache_write_tokens")
            + g("output_tokens");
    }
    let mut from_dto: std::collections::BTreeMap<String, i64> = Default::default();
    if let Some(map) = tokens_by_harness.as_object() {
        for (harness, t) in map {
            from_dto.insert(harness.clone(), t.get("total").and_then(|v| v.as_i64()).unwrap_or(0));
        }
    }
    let mut mismatches = Vec::new();
    let harnesses: std::collections::BTreeSet<&String> =
        from_facts.keys().chain(from_dto.keys()).collect();
    for harness in harnesses {
        let a = from_facts.get(harness).copied().unwrap_or(0);
        let b = from_dto.get(harness).copied().unwrap_or(0);
        if a != b {
            mismatches.push(json!({
                "harness": harness,
                "facts_total": a,
                "projection_total": b,
                "delta": a - b,
            }));
        }
    }
    json!({
        "reconciled": mismatches.is_empty(),
        "harnesses_compared": from_facts.len().max(from_dto.len()),
        "mismatches": mismatches,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 合法 fact 的身份字段（fact_id 由 build_usage_fact 内部计算）。
    fn base_fields() -> serde_json::Map<String, serde_json::Value> {
        let mut m = serde_json::Map::new();
        m.insert("machine_namespace".to_string(), json!("m1"));
        m.insert("harness".to_string(), json!("codex"));
        m.insert("source_profile".to_string(), json!("default"));
        m.insert("native_session_id".to_string(), json!("sess-1"));
        m.insert("source_event_id".to_string(), json!("evt-1"));
        m.insert("observation_kind".to_string(), json!("token_count"));
        m.insert("uncached_input_tokens".to_string(), json!(800));
        m.insert("output_tokens".to_string(), json!(80));
        m
    }

    fn tmp_path(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "avd-evidence-{}-{}-{}",
            tag,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn append_is_exactly_once_across_reopen() {
        let path = tmp_path("dedup");
        let fields = base_fields();
        let mut w = FactWriter::open(&path).unwrap();
        let (out1, f1) = w.append(&fields).unwrap();
        assert_eq!(out1, AppendOutcome::Appended);
        assert!(f1.is_some());
        // 同一逻辑事件重复 emit（模拟重放/双管道）→ Duplicate，不落第二行。
        let (out2, f2) = w.append(&fields).unwrap();
        assert_eq!(out2, AppendOutcome::Duplicate);
        assert!(f2.is_none());
        // 跨 writer 实例（重新 open = 模拟重启）：去重集合从文件重建。
        drop(w);
        let mut w2 = FactWriter::open(&path).unwrap();
        assert_eq!(w2.seen_count(), 1, "重启后 seen 集合必须从文件重建");
        let (out3, _) = w2.append(&fields).unwrap();
        assert_eq!(out3, AppendOutcome::Duplicate);
        // 文件里恰好一行。
        assert_eq!(replay(&path).unwrap().facts.len(), 1);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn different_identity_is_a_different_fact() {
        let path = tmp_path("distinct");
        let mut w = FactWriter::open(&path).unwrap();
        let a = base_fields();
        let mut b = base_fields();
        b.insert("source_event_id".to_string(), json!("evt-2"));
        w.append(&a).unwrap();
        w.append(&b).unwrap();
        assert_eq!(w.seen_count(), 2, "不同身份必是不同事实");
        assert_eq!(replay(&path).unwrap().facts.len(), 2);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn invalid_fact_is_rejected_with_field_names() {
        let path = tmp_path("invalid");
        let mut w = FactWriter::open(&path).unwrap();
        let mut bad = base_fields();
        bad.remove("native_session_id");
        bad.insert("uncached_input_tokens".to_string(), json!(-5));
        let err = w.append(&bad).unwrap_err();
        match err {
            AppendError::Invalid(problems) => {
                let joined = problems.join("; ");
                assert!(joined.contains("native_session_id"), "{joined}");
                assert!(joined.contains("uncached_input_tokens"), "{joined}");
            }
            other => panic!("expected Invalid, got {other:?}"),
        }
        // 被拒绝的 fact 不得留半行在文件里。
        assert_eq!(replay(&path).unwrap().facts.len(), 0);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn crash_half_line_is_repaired_on_open_next_append_stays_readable() {
        let path = tmp_path("crash");
        // 模拟 crash 半行：一条完整 fact + 一条截断的 JSON（无收尾换行）。
        let mut w = FactWriter::open(&path).unwrap();
        w.append(&base_fields()).unwrap();
        drop(w);
        let mut text = std::fs::read_to_string(&path).unwrap();
        text.push_str("{\"fact_id\": \"uf1-trunca");
        std::fs::write(&path, text).unwrap();

        let rep = replay(&path).unwrap();
        assert_eq!(rep.facts.len(), 1, "完整行照常读回");
        let first_newline = std::fs::read_to_string(&path).unwrap().find('\n').unwrap();
        assert_eq!(
            rep.tail_repair,
            Some(TailRepair::Truncate { offset: (first_newline + 1) as u64 }),
            "报告截断修复动作（截回第一条合法行行尾）"
        );

        // open 落实修复（截掉半行），随后的 append 落在干净表面上——这条
        // 断言是本测试的牙：旧实现只「容忍」不修复，append 与残行合并成
        // 损坏行，e2 被吞、下次 open 永远 Corrupt（测试还绿——只数行数不
        // 验证可读性的假绿）。
        let mut w = FactWriter::open(&path).unwrap();
        assert!(matches!(
            w.tail_repair(),
            Some(TailRepair::Truncate { .. })
        ), "open 报告执行了截断修复");
        let mut second = base_fields();
        second.insert("source_event_id".to_string(), json!("evt-2"));
        w.append(&second).unwrap();
        drop(w);

        // 重开：两条事实都可读、可去重——修复后追加面干净。
        let mut w = FactWriter::open(&path).unwrap();
        assert_eq!(w.tail_repair(), None, "修复后文件干净");
        assert_eq!(w.seen_count(), 2, "e2 必须真实可读，不是被吞在损坏行里");
        let (out, _) = w.append(&second).unwrap();
        assert_eq!(out, AppendOutcome::Duplicate, "重放去重照常工作");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn complete_json_without_trailing_newline_is_sealed_not_dropped() {
        let path = tmp_path("seal");
        let mut w = FactWriter::open(&path).unwrap();
        w.append(&base_fields()).unwrap();
        drop(w);
        // 模拟 write_all 恰好死在 '\n' 之前：事实完整但文件不封口。
        let text = std::fs::read_to_string(&path).unwrap();
        let text = text.strip_suffix('\n').unwrap();
        std::fs::write(&path, text).unwrap();

        let rep = replay(&path).unwrap();
        assert_eq!(rep.facts.len(), 1, "末行是完整 JSON，仍读回");
        assert_eq!(rep.tail_repair, Some(TailRepair::SealNewline));

        // open 封口（补 '\n'）而不是截断——截断会丢一条好事实。
        let mut w = FactWriter::open(&path).unwrap();
        assert_eq!(w.tail_repair(), Some(TailRepair::SealNewline));
        let mut second = base_fields();
        second.insert("source_event_id".to_string(), json!("evt-2"));
        w.append(&second).unwrap();
        drop(w);
        let rep = replay(&path).unwrap();
        assert_eq!(rep.facts.len(), 2, "两条事实都可读");
        assert_eq!(rep.tail_repair, None, "封口后干净收尾");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn mid_file_corruption_is_reported_not_skipped() {
        let path = tmp_path("corrupt");
        let mut w = FactWriter::open(&path).unwrap();
        w.append(&base_fields()).unwrap();
        let mut second = base_fields();
        second.insert("source_event_id".to_string(), json!("evt-2"));
        w.append(&second).unwrap();
        drop(w);

        // 中间坏行 = 真实损坏，必须报 Corrupt 而不是静默跳过。
        let mut broken = std::fs::read_to_string(&path).unwrap();
        broken = broken.replace("}\n{", "}\nNOT_JSON\n{");
        std::fs::write(&path, &broken).unwrap();
        match replay(&path) {
            Err(AppendError::Corrupt { line_no }) => assert_eq!(line_no, 2),
            other => panic!("expected Corrupt, got {other:?}"),
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn retain_drops_only_dated_old_facts_and_is_idempotent() {
        let path = tmp_path("retain");
        let mut w = FactWriter::open(&path).unwrap();
        let mut mk = |event: &str, ts: Option<&str>| {
            let mut f = base_fields();
            f.insert("source_event_id".to_string(), json!(event));
            if let Some(ts) = ts {
                f.insert("event_ts_utc".to_string(), json!(ts));
            }
            w.append(&f).unwrap();
        };
        mk("old", Some("2025-01-15T10:00:00.000Z"));
        mk("recent", Some("2026-09-05T10:00:00.000Z"));
        mk("undated", None);
        drop(w);

        // cutoff = 2025-06：old（2025-01）被丢；recent 与 undated 保留。
        let rep = retain(&path, "2025-06").unwrap();
        assert_eq!(rep.dropped, 1);
        assert_eq!(rep.kept, 1);
        assert_eq!(rep.kept_undated, 1);
        let after = replay(&path).unwrap();
        assert_eq!(after.facts.len(), 2);
        // 幂等：第二次跑 dropped=0。
        let rep2 = retain(&path, "2025-06").unwrap();
        assert_eq!(rep2.dropped, 0);
        assert_eq!(replay(&path).unwrap().facts.len(), 2);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn reconcile_reports_mismatch_without_panicking() {
        let mut fields = base_fields();
        fields.insert("cache_read_tokens".to_string(), json!(200));
        let fact = build_usage_fact(&fields).unwrap();
        let facts = vec![fact];
        let dto = json!({ "codex": { "total": 1080 } }); // 800+200+80=1080 一致
        let ok = reconcile_tokens(&facts, &dto);
        assert_eq!(ok["reconciled"], json!(true));
        let dto_bad = json!({ "codex": { "total": 999 } });
        let bad = reconcile_tokens(&facts, &dto_bad);
        assert_eq!(bad["reconciled"], json!(false));
        assert_eq!(bad["mismatches"][0]["delta"], json!(81));
    }
}
