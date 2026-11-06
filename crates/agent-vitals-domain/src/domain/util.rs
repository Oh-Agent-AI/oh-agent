//! 纯计算工具函数 —— CLI 与 wasm 共用。
//!
//! 这个模块存在的理由：`est_tokens` 原先只住在 binary 的 `src/util.rs` 里，
//! 于是 wasm 拿不到它。而 FR-04a 的上下文构成归因（回答「token 都去哪了」）
//! 必须在浏览器侧算 —— 执行环境投影的 `view()` 跑的是 wasm。同一个估算函数在两处
//! 各写一份就是本仓最不能接受的那类缺陷（never a second copy），所以下沉到
//! core，binary 侧改为 re-export。

/// 粗略 token 估算。中文按 0.6 token/字符，其余按 0.3 token/字符——DeepSeek
/// 官方换算比例（<https://api-docs.deepseek.com/zh-cn/quick_start/token_usage>）。
///
/// **换算比例是 2026-08-21 从旧值改过来的**：旧公式是 `cjk/1.5 + other/4`
/// （等价于 CJK×0.667、其余×0.25），来源已不可考。拿真实会话 550 段 assistant
/// 输出（reasoning + text 合并，因为这是推理模型，`outputTokens` 把隐藏的推理
/// 内容也计进去了——只算可见文本会先低估 69%，这个坑在验证时踩过）比对
/// provider 实际返回的 `outputTokens`：旧公式系统性低估 **22.2%**，DeepSeek
/// 官方比例低估 **8.8%**。官方比例明显更准，但仍不是精确值——DeepSeek 自己的
/// 文档写着"以接口返回的用量为准"，这里保留的仍然是估算，不是精确计数。
///
/// CJK 判据是 `U+4E00..=U+9FFF`（含两端）。扩展 A 区（U+3400）与扩展 B 区
/// （U+20000）**不算**，全角标点（U+FF0C）也不算；`as i64` 向下截断而非四舍
/// 五入——比例换了，截断语义没变。这些边界不是随手定的——Python 侧
/// `scripts/agent_vitals/util.py` 的 `est_tokens` 是同一套判据，
/// `tests/test_characterization.py::TestEstTokens` 把每个边界都钉成了具体数值
/// （`est_tokens("hello") == 1`，不是 `> 0`）。
pub fn est_tokens(text: &str) -> i64 {
    if text.is_empty() {
        return 0;
    }
    let mut cjk = 0usize;
    let mut total = 0usize;
    for ch in text.chars() {
        total += 1;
        if ('\u{4e00}'..='\u{9fff}').contains(&ch) {
            cjk += 1;
        }
    }
    let other = total - cjk;
    ((cjk as f64) * 0.6 + (other as f64) * 0.3) as i64
}

/// 复刻 Python 的 `round(x, n)` —— 银行家舍入（round-half-to-even）。
///
/// Rust 的 `f64::round()` 是「四舍五入远离零」，Python 的 `round()` 是
/// 「银行家舍入」。差异只在恰好落在半分点时出现，但预算百分比这类数字**会**
/// 落在那里。Rust 的 `{:.n}` 格式化用的正是银行家舍入，所以格式化再解析回来
/// 即可对齐。
///
/// 迁进 core 的原因与 `est_tokens` 相同：`budget.rs::evaluate_alert` 的 reason
/// 字符串里 `round(ratio * 100)` 需要同一舍入（Python 侧 `budget.py` 用内置
/// `round()`），而二进制侧 `src/util.rs` 改为 re-export —— 一个实现，两个调用面。
pub fn pyround(x: f64, n: usize) -> f64 {
    format!("{:.*}", n, x).parse().unwrap_or(x)
}

/// 复刻 Python 的 `str.splitlines()`（常见终止符部分）。
///
/// 与 `split('\n')` 的区别：CRLF 算一个终止符，且末尾终止符不产生空元素。
/// v0.8 Phase D4 从二进制 `src/util.rs` 迁进 domain —— DSH wire 解析
/// （`agent-vitals-harnesses/harnesses/dsh/sessions/wire.rs`）与扫描器都要按行切，
/// 一个纯 `&str` 实现，多个调用面。二进制侧 `src/util.rs` 改 re-export。
pub fn split_lines(s: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let bytes = s.as_bytes();
    let mut start = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        match bytes[i] {
            b'\n' => {
                out.push(&s[start..i]);
                i += 1;
                start = i;
            }
            b'\r' => {
                out.push(&s[start..i]);
                i += if i + 1 < bytes.len() && bytes[i + 1] == b'\n' { 2 } else { 1 };
                start = i;
            }
            _ => i += 1,
        }
    }
    if start < bytes.len() {
        out.push(&s[start..]);
    }
    out
}

/// Unix 秒 + 时区偏移 → 公历 `(year, month, day)`。Howard Hinnant 的
/// civil-from-days 算法，不引 `chrono`。v0.8 Phase D6 从二进制 `src/agent/
/// codex_cost.rs` 迁进来——`runtime::clock` 与二进制 CLI 都用它（读时钟的
/// `current_month_beijing`/`today_beijing` 在 `agent-vitals-runtime::clock`）。
/// Python 镜像 `codex_cost.py`，差分交叉断言两侧一致。
pub fn civil_from_unix_secs(secs: i64, offset_secs: i64) -> (i64, u32, u32) {
    let days = (secs + offset_secs).div_euclid(86400);
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m as u32, d as u32)
}

/// 纪元时间归一为**毫秒**——本仓「整数纪元一律以毫秒为契约」的唯一实现。
///
/// 秒级输入（`< 1e11`）视为秒并放大 1000 倍，其余原样返回。
///
/// **为什么需要一个具名函数，而不是在消费点写 `if x < 1e11 { x * 1000 }`**：
/// 单位差异不是数据损坏，是**契约在缝上断了**，而断点不止一处。已经发生过两次：
///
/// - `issue_instances.opened_at_ms`：写入点原样抄 `finding.time`，而 `finding.time`
///   的单位由各执行环境适配器决定，真机上 1,542/4,450 条落成 1970 日桶并被时间窗
///   静默排除（`docs/v1.0.0/ISSUE_OPENED_AT_MS_UNIT_DRIFT.md`）。修法是**在边界
///   归一**，并明确禁止「在多个消费点各自内联猜单位」。
/// - `TraceNode.started_at_ms`：同一根因。Claude 的 timeline 构造器明写
///   「`parse_iso` → **秒**」（`harnesses/claude_code/sessions/evidence.rs`），
///   Codex 是毫秒，而 `trace.rs` 把它原样填进名为 `_ms` 的字段。
///
/// 所以这里是那个**单一具名函数**：谁要把纪元整数写进 `_ms` 字段，就调它。
/// `agent_vitals_data::issues::to_epoch_ms` 已改为委托到本函数，不是第二份实现。
///
/// 幂等：毫秒值不会二次放大（`1.789e12 > 1e11`）。`saturating_mul` 而非 `*`——
/// 畸形输入（负值、极大值）不能 panic，也不能回绕成一个小数字后冒充合法时间。
pub fn to_epoch_ms(value: i64) -> i64 {
    /// 1e11 秒 = 公元 5138 年；1e11 毫秒 = 1973 年。任何落在两者之间的真实
    /// 「秒」时间戳都不存在，所以这个阈值对两个方向都不歧义。
    const EPOCH_SECONDS_CUTOFF: i64 = 100_000_000_000;
    if value < EPOCH_SECONDS_CUTOFF {
        value.saturating_mul(1000)
    } else {
        value
    }
}

#[cfg(test)]
mod to_epoch_ms_tests {
    use super::to_epoch_ms;

    /// 真机取值：Claude 的 timeline entry.time（秒）与 Codex 的（毫秒）。
    /// 两个都来自 2026-09-11 的同一台机器，归一后必须**同量级**——这是本函数
    /// 存在的全部理由。
    #[test]
    fn seconds_are_scaled_and_milliseconds_pass_through() {
        // Claude Code：parse_iso → 秒
        assert_eq!(to_epoch_ms(1_788_449_204), 1_788_449_204_000);
        // Codex：已是毫秒
        assert_eq!(to_epoch_ms(1_789_132_709_000), 1_789_132_709_000);
        // 归一后同量级（同一个月），不是相差 1000 倍
        let claude = to_epoch_ms(1_788_449_204);
        let codex = to_epoch_ms(1_789_132_709_000);
        assert!((codex - claude).abs() < 30 * 86_400_000, "归一后应落在同一个月内");
    }

    /// 阈值两侧各一个值，行为必须明确：1e11 按毫秒原样（它已是 1973 年的毫秒）。
    #[test]
    fn cutoff_boundary_is_explicit() {
        assert_eq!(to_epoch_ms(100_000_000_000), 100_000_000_000);
        assert_eq!(to_epoch_ms(100_000_000_001), 100_000_000_001);
        assert_eq!(to_epoch_ms(99_999_999_999), 99_999_999_999_000);
    }

    /// 幂等：毫秒值再归一一次不变——存量修复要能连跑两次。
    #[test]
    fn normalization_is_idempotent() {
        let once = to_epoch_ms(1_788_449_204);
        assert_eq!(to_epoch_ms(once), once);
    }

    /// 畸形输入不 panic、不回绕。**负值与极大值的行为有意与既有
    /// `issues::to_epoch_ms` 逐位一致**——本函数是它的委托目标，若在这里"顺手
    /// 修正"负数语义，委托就不再是等价变换，存量 Issue 修复的判据也会跟着变。
    /// 负纪元不在契约内（属数据损坏），此处只保证不 panic、不产生"看起来合法"
    /// 的小正数。
    #[test]
    fn malformed_input_does_not_panic_or_wrap() {
        assert_eq!(to_epoch_ms(0), 0);
        // 负值：saturating 只夹在 i64 边界，不把它变成大正数——这比回绕安全。
        assert_eq!(to_epoch_ms(-1), -1000);
        assert!(to_epoch_ms(-1) < 0, "负输入不得变成正数");
        assert_eq!(to_epoch_ms(i64::MIN), i64::MIN, "溢出饱和而非回绕");
        assert_eq!(to_epoch_ms(i64::MAX), i64::MAX);
    }
}

#[cfg(test)]
mod civil_tests {
    use super::civil_from_unix_secs;

    #[test]
    fn civil_from_unix_secs_matches_python_oracle() {
        let cases: [(i64, &str); 11] = [
            (0, "1970-01-01"),
            (86400, "1970-01-02"),
            (951782400, "2000-02-29"),
            (1585584000, "2020-03-31"),
            (1725000000, "2024-08-30"),
            (1725245370, "2024-09-02"),
            (1767196799, "2025-12-31"),
            (1767196800, "2026-01-01"),
            (1767225600, "2026-01-01"),
            (1787866858, "2026-08-28"),
            (1788453658, "2026-09-04"),
        ];
        for (secs, want) in cases {
            let (y, m, d) = civil_from_unix_secs(secs, 8 * 3600);
            assert_eq!(format!("{y:04}-{m:02}-{d:02}"), want, "civil_from_unix_secs({secs})");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 与 `tests/test_characterization.py::TestEstTokens` 逐值对齐。
    /// 断言具体数值而非范围——范围断言在移植时毫无用处。
    ///
    /// 期望值按新比例（CJK×0.6、其余×0.3）重新算过，不是从旧测试改的数字——
    /// 换算比例变了，"看起来差不多改一改"式的手改容易把截断边界改错。
    #[test]
    fn est_tokens_matches_python_characterization() {
        assert_eq!(est_tokens(""), 0);
        // 其余字符：×0.3 向下截断
        assert_eq!(est_tokens("hello"), 1); // 5*0.3 = 1.5 → 1
        assert_eq!(est_tokens("xxxx"), 1); // 4*0.3 = 1.2 → 1
        assert_eq!(est_tokens("xxx"), 0); // 3*0.3 = 0.9 → 0，向下取整不是四舍五入
        assert_eq!(est_tokens(&"x".repeat(400)), 120); // 400*0.3 = 120
        // CJK：×0.6
        assert_eq!(est_tokens("中文"), 1); // 2*0.6 = 1.2 → 1
        assert_eq!(est_tokens(&"中".repeat(3)), 1); // 3*0.6 = 1.8 → 1
        assert_eq!(est_tokens(&"中".repeat(150)), 90); // 150*0.6 = 90
        // 混排：「，」是 U+FF0C，不在 CJK 区间内 → 算 other；2*0.6+8*0.3=3.6→3
        assert_eq!(est_tokens("中文，English"), 3);
    }

    /// CJK 区间端点与两侧各一个字符。写成 `<` 而非 `<=` 会在这里露馅。
    #[test]
    fn est_tokens_cjk_range_boundaries() {
        assert_eq!(est_tokens(&"一".repeat(3)), 1); // U+4E00 下界，含；3*0.6=1.8→1
        assert_eq!(est_tokens(&"\u{9fff}".repeat(3)), 1); // U+9FFF 上界，含
        assert_eq!(est_tokens(&"\u{4dff}".repeat(3)), 0); // 下界前一个 → other，3*0.3=0.9→0
        assert_eq!(est_tokens(&"\u{a000}".repeat(3)), 0); // 上界后一个 → other
        assert_eq!(est_tokens(&"\u{3400}".repeat(3)), 0); // 扩展 A 区不算 CJK
        assert_eq!(est_tokens(&"\u{20000}".repeat(3)), 0); // 扩展 B 区不算
    }

    /// 任意 Unicode 不 panic、结果非负（属性测试的用例版）。
    #[test]
    fn est_tokens_total_over_arbitrary_unicode() {
        for s in ["\u{1f600}".repeat(10), "\x00\x01\x02".to_string(),
                  "á̂".to_string(), "🇨🇳🇺🇸".to_string(), "\n\r\t".to_string()] {
            assert!(est_tokens(&s) >= 0);
        }
    }
}

use serde_json::Value;

// ────────────────────────── JSON 字段取值助手 ──────────────────────────
// v0.8 Phase E7.2：从二进制 main.rs 迁来（原 `pub(crate) fn s/i/f/b/chars`）
// ——纯 `serde_json::Value` 字段读取 + 缺省值，不认识任何执行环境/领域词汇，本该
// 一直在这里。main.rs 改 `pub(crate) use agent_vitals_domain::util::{...}`
// 保call site零改动（同 D 阶段 split_lines/pyround 的搬法）。

pub fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}
pub fn i(v: &Value, k: &str) -> i64 {
    v.get(k).and_then(|x| x.as_i64()).unwrap_or(0)
}
pub fn f(v: &Value, k: &str) -> f64 {
    v.get(k).and_then(|x| x.as_f64()).unwrap_or(0.0)
}
pub fn b(v: &Value, k: &str) -> bool {
    v.get(k).and_then(|x| x.as_bool()).unwrap_or(false)
}
pub fn chars(v: &Value, k: &str) -> usize {
    v.get(k).and_then(|x| x.as_str()).map_or(0, |x| x.chars().count())
}

/// 统一成正斜杠，让所有路径判断在 Windows 上也成立——v0.8 Phase E7.6 从
/// `apps/cli/src/util.rs` 迁来（`agent-vitals-harnesses` 的 `workbuddy`/`openclaw`/
/// `codex` 执行环境适配器搬进库 crate 后也要用它，不能各写一份）。
///
/// 移植清单第 6 条：不能依赖 `Path::display()` —— 它在 Windows 上产出反斜杠。
/// 保留显式 normalize，所有路径判断走 normalized string。
///
/// **`\\?\` verbatim 前缀必须剥掉。**`Path::canonicalize()` 在 Windows 上
/// 返回 extended-length（verbatim）路径，例如 `\\?\C:\Users\...`；而
/// `home_n`/`cwd_n`（main.rs）直接从环境变量 norm 而来，从不带这个前缀。
/// `classify()` 靠字符串前缀匹配判定 personal/project/workspace ——
/// 两侧前缀不一致时匹配必然失败，skill 被静默归到 unknown、
/// `loaded_skills` 跟着腰斩（这台机器上 31 → 11）。Python 的
/// `Path.resolve()` 从不产出这个前缀，golden 也不含它。
pub fn norm(p: &std::path::Path) -> String {
    let s = p.to_string_lossy().replace('\\', "/");
    if let Some(rest) = s.strip_prefix("//?/UNC/") {
        format!("//{rest}")
    } else if let Some(rest) = s.strip_prefix("//?/") {
        rest.to_string()
    } else {
        s
    }
}

/// 字节 → 宽松 UTF-8（非法字节替换为 U+FFFD）+ universal newlines（`\r\n`/`\r`
/// 都归一成 `\n`）——v0.8 Phase E7.6 从 `apps/cli/src/util.rs::read_lossy` 拆出
/// 纯转换部分（该函数本身做 `std::fs::read`，是 I/O，留在二进制侧；
/// `agent-vitals-harnesses::harnesses::claude_code::sources::skills::read_harness_config`
/// 读 `~/.claude.json` 需要同一份转换逻辑，不能各写一份 —— 两处的字节来源都是
/// 真实文件，编码/换行异常的处理必须逐字节一致）。
pub fn bytes_to_lossy_normalized(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    if !text.contains('\r') {
        return text.into_owned();
    }
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\r' {
            if chars.peek() == Some(&'\n') {
                chars.next();
            }
            out.push('\n');
        } else {
            out.push(c);
        }
    }
    out
}

/// 会话分叉边界：日志头 `session` 事件里的 `seedLength`；没有就是没分叉。
///
/// **为什么需要它**：DSH 里从已有会话「branch into new conversation」派生出的
/// 新会话，会先把上游会话的整段事件历史**原样抄进自己的日志**，再往后追加自己
/// 的事件。抄来的那段里包含上游当时的 `usage` 记录——那是上游真金白银调过的
/// API，已经算在上游自己那本账里了。不认这条边界就等于对同一笔钱重复计费。
///
/// 实测 session-e4b0be69：分叉前 ¥680.36 / 分叉后 ¥433.30，显示的 ¥1113.66 里
/// **61% 是上游的账**。证据不是推测——分叉前那段的 513 个 callId 逐个都能在上游
/// 日志里找到（100%），而分叉后那段只有 3.5% 重叠。
///
/// ## 为什么**不能**用 `session/end-seed` 事件
///
/// 初版就是那么做的（图省事：事件在流里，wasm 和执行环境都拿得到，不用透传 header），
/// 并且在 e4b0be69 上验证通过——那个会话的第一个 `end-seed` 正好等于 seedLength。
/// **但那是巧合。**`session/end-seed` 标记的是「一段续种结束」，**会话每次被
/// 重新唤醒都会触发**：真实日志 session-6b47acc7 完全没分叉（`seedLength` 缺席、
/// `parentSession` 为空），却有一个 `end-seed` 落在 seq=65762——整份日志的最后
/// 一个事件。按「第一个 end-seed」判，整个会话都会被当成分叉前数据丢光，UI 上
/// 费用/上下文/常驻前缀/子代理全变「不可用」。
///
/// 一个事件是不是分叉边界，取决于**当初有没有分叉**，而这件事只有日志头知道。
/// 所以这里只认 `seedLength`：它缺席就是没分叉，一个事件都不滤。
pub fn fork_boundary(events: &[Value]) -> Option<i64> {
    for e in events {
        if e.get("type").and_then(|v| v.as_str()) != Some("session") {
            continue;
        }
        // 顶层与 data 下都看一眼：CLI 侧读的是原始日志头（顶层），执行环境侧是从
        // `session.header` 合成的（可能挂在 data 下）。
        let n = e
            .get("seedLength")
            .or_else(|| e.pointer("/data/seedLength"))
            .and_then(|v| v.as_i64());
        // 0 或负数不是有效边界——那是「没有续种」，不是「续种了 0 个事件」。
        return n.filter(|x| *x > 0);
    }
    None
}

/// 只保留分叉之后的事件。没有分叉标记时原样返回。
///
/// 所有 core 的公开分析入口都先过这一道：审计回答的是「**这个**会话干了什么」，
/// 上游会话干过的事属于上游自己那份审计。
pub fn post_fork(events: &[Value]) -> Vec<Value> {
    match fork_boundary(events) {
        Some(b) => events
            .iter()
            // map_or(true, …) 而不是 is_none_or —— 后者要 Rust 1.82，本仓 MSRV 是 1.74。
            // 语义：没有 seq 的事件一律保留（缺 seq 是"没上报"，不是"在分叉之前"）。
            .filter(|e| e.get("seq").and_then(|v| v.as_i64()).map_or(true, |q| q >= b))
            .cloned()
            .collect(),
        None => events.to_vec(),
    }
}

/// 把一次 `(turn, step)` 对回 `usage::request_metrics` 算出的那次请求行——
/// **精确匹配 turn+step，不是「最近的 seq」**（`skill.rs` 与 `waste.rs` 共用，
/// 两处都要「该 skill 触发/该失败发生在哪次请求里」，语义完全一致）。
/// `requests` 必须是 `request_metrics` 的输出。
pub fn find_request(requests: &[Value], turn: i64, step: i64) -> Option<&Value> {
    requests
        .iter()
        .find(|r| r["turn"].as_i64() == Some(turn) && r["step"].as_i64() == Some(step))
}

/// `find_request` 命中之后、上下文增量算 after 值用的那次请求：`request_seq`
/// 严格大于 `after_request_seq` 里最小的一次（`waste.rs::emit_failure_waste` 用）。
pub fn find_next_request(requests: &[Value], after_request_seq: i64) -> Option<&Value> {
    requests
        .iter()
        .filter(|r| r["request_seq"].as_i64().is_some_and(|n| n > after_request_seq))
        .min_by_key(|r| r["request_seq"].as_i64().unwrap_or(i64::MAX))
}

#[cfg(test)]
mod fork_tests {
    use super::*;
    use serde_json::json;

    fn ev(t: &str, seq: i64) -> Value {
        json!({"type": t, "seq": seq, "data": {}})
    }
    fn header(seed: Option<i64>) -> Value {
        match seed {
            Some(n) => json!({"type": "session", "seq": Value::Null, "data": {"seedLength": n}}),
            None => json!({"type": "session", "seq": Value::Null, "data": {}}),
        }
    }

    /// 边界来自日志头的 `seedLength`；之前的事件全部滤掉。
    ///
    /// 钉的是一个**真实的重复计费缺陷**：从上游会话 branch 出来的新会话，日志
    /// 前半段是上游历史的原样拷贝，含上游当时的 usage 记录。实测
    /// session-e4b0be69 的显示金额 ¥1113.66 里有 ¥680.36（61%）是上游的账。
    #[test]
    fn boundary_comes_from_header_seed_length() {
        let events = vec![header(Some(3)), ev("tool/call", 1), ev("tool/call", 2), ev("tool/call", 4)];
        assert_eq!(fork_boundary(&events), Some(3));
        let kept: Vec<i64> = post_fork(&events)
            .iter()
            .filter_map(|e| e["seq"].as_i64())
            .collect();
        assert_eq!(kept, vec![4], "分叉前的 seq 1/2 必须滤掉");
    }

    /// **`session/end-seed` 不是分叉边界。**
    ///
    /// 初版就是那么判的，还在一个已分叉的会话上验证通过——那是巧合。这个标记
    /// 的是「一段续种结束」，会话每次被唤醒都会触发：真实日志 session-6b47acc7
    /// 完全没分叉（header 无 seedLength），唯一的 end-seed 落在**最后一个事件**
    /// 上。按事件判会把整个会话丢光，UI 上费用/上下文/常驻前缀/子代理全变
    /// 「不可用」——这个回归是用户在真机上发现的。
    #[test]
    fn end_seed_event_is_not_a_boundary() {
        // **没有 header 标记事件**——适配器只在 seedLength > 0 时才合成一个，
        // 未分叉的会话流里压根没有它。夹具必须是这个形状，否则 header 分支会
        // 先 return，测试就永远走不到 end-seed，红-绿验证也照过（第一版就是
        // 这么假绿的）。
        let events = vec![
            ev("tool/call", 1),
            ev("tool/call", 2),
            ev("session/end-seed", 3), // 末尾的续跑标记
        ];
        assert_eq!(fork_boundary(&events), None, "没有 seedLength 就是没分叉");
        assert_eq!(post_fork(&events).len(), 3, "未分叉的会话一个事件都不能滤");
    }

    /// 没有日志头（或头里没这个字段）时同样不滤——子代理会话就是这样。
    #[test]
    fn missing_header_or_field_means_no_fork() {
        let no_header = vec![ev("tool/call", 0), ev("tool/call", 1)];
        assert_eq!(fork_boundary(&no_header), None);
        assert_eq!(post_fork(&no_header).len(), 2);
        let no_field = vec![header(None), ev("tool/call", 1)];
        assert_eq!(fork_boundary(&no_field), None);
        assert_eq!(post_fork(&no_field).len(), 2);
    }

    /// 0 或负数不是有效边界——那是「没有续种」，不是「续种了 0 个事件」。
    #[test]
    fn zero_seed_length_is_not_a_boundary() {
        assert_eq!(fork_boundary(&[header(Some(0))]), None);
        assert_eq!(fork_boundary(&[header(Some(-1))]), None);
    }

    /// 没有 seq 的事件不能被静默丢掉——缺 seq 是"没上报"，不是"在分叉之前"。
    #[test]
    fn events_without_seq_survive() {
        let events = vec![
            header(Some(5)),
            json!({"type": "tool/call", "data": {}}),
            ev("tool/call", 6),
        ];
        // 日志头自己也没有 seq，同样保留（它就是边界的载体）。
        assert_eq!(post_fork(&events).len(), 3);
    }
}

#[cfg(test)]
mod json_field_accessor_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn missing_key_returns_the_declared_default() {
        let v = json!({});
        assert_eq!(s(&v, "k"), "");
        assert_eq!(i(&v, "k"), 0);
        assert_eq!(f(&v, "k"), 0.0);
        assert!(!b(&v, "k"));
        assert_eq!(chars(&v, "k"), 0);
    }

    #[test]
    fn wrong_type_falls_back_to_default_not_a_panic() {
        // 键存在但类型不对——例如把数字塞进本该是字符串的字段——不能 panic，
        // 也不能悄悄转型，只能按"没读到"处理。
        let v = json!({"k": 42});
        assert_eq!(s(&v, "k"), "");
        assert!(!b(&v, "k"));
    }

    #[test]
    fn chars_counts_unicode_scalars_not_bytes() {
        let v = json!({"k": "中文abc"});
        assert_eq!(chars(&v, "k"), 5, "3 个中文字符 + 3 个 ASCII 字符 = 5，不是字节数");
    }
}

#[cfg(test)]
mod bytes_to_lossy_normalized_tests {
    use super::*;

    #[test]
    fn plain_lf_passes_through_unchanged() {
        assert_eq!(bytes_to_lossy_normalized(b"a\nb\n"), "a\nb\n");
    }

    #[test]
    fn crlf_and_bare_cr_both_normalize_to_lf() {
        assert_eq!(bytes_to_lossy_normalized(b"a\r\nb\rc"), "a\nb\nc");
    }

    #[test]
    fn invalid_utf8_bytes_become_replacement_character() {
        let out = bytes_to_lossy_normalized(&[b'a', 0xFF, b'b']);
        assert!(out.contains('\u{FFFD}'));
        assert!(out.starts_with('a') && out.ends_with('b'));
    }

    #[test]
    fn empty_input_is_empty_output() {
        assert_eq!(bytes_to_lossy_normalized(b""), "");
    }
}
