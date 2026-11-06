//! Harness-neutral workflow event contract.
//!
//! Adapters may observe very different wire events, but the product-facing
//! workflow queries need one deliberately small shape.  This contract carries
//! redacted identifiers, stable fingerprints, and — since the 2026-09-19 data
//! retention & serving-face policy (AGENTS.md) — **bounded, scrubbed
//! derivations**: error/argument excerpts capped by
//! `domain::enrichment::make_excerpt` (scrub-first, code-point truncation) and
//! size counters.  Unbounded raw text, prompts, paths, raw error bodies, and
//! provider payloads still never cross this boundary; what crosses is the
//! derived residue the policy calls「留存放开」, and it stays excluded from
//! the MCP and redacted-export serving faces.

/// A single observed workflow event suitable for authority storage.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkflowEvent {
    /// Stable adapter-generated identity.  Replaying a source must not create
    /// another row for the same physical event.
    pub event_id: String,
    /// The normalised session ledger key.  `None` is allowed for an event that
    /// is observable but cannot be safely attached to a session.
    pub session_key: Option<String>,
    /// UTC Unix milliseconds from the harness-native event timestamp.
    pub event_ts_ms: i64,
    /// One of the schema's closed event types.
    pub event_type: String,
    pub capability_kind: Option<String>,
    /// A normalised, non-secret capability identifier (for example `bash` or
    /// a skill slug), never the invocation arguments.
    pub capability_id: Option<String>,
    pub capability_version: Option<String>,
    pub outcome: String,
    pub duration_ms: Option<i64>,
    /// Stable category/fingerprint only; raw error text is forbidden.
    pub error_fingerprint: Option<String>,
    /// Stable redacted shape used to group retries without storing arguments.
    pub invocation_fingerprint: Option<String>,
    // ── V16 富化字段（2026-09-19 政策；NULL = 执行环境没有该证据，绝不编造） ──
    /// `家族:细节` 语法的归一化错误码（http/jsonrpc/tool/harness）。执行环境只给布尔
    /// （如 claude 的 `is_error`）时保持 `None`——不从文本猜码。
    pub error_code: Option<String>,
    /// `domain::enrichment::ErrorClass` 十值闭集；仅当 error_code 可分类时填。
    pub error_class: Option<String>,
    /// 错误首行摘录（scrub + ≤120 码点截断，`make_excerpt` 产物）。仅本地呈现。
    pub error_excerpt: Option<String>,
    /// 参数摘要摘录（同上）。仅本地呈现。
    pub args_excerpt: Option<String>,
    /// 序列化请求/结果字节数（§「结果过大」检测原料）。
    pub request_bytes: Option<i64>,
    pub result_bytes: Option<i64>,
    /// 执行环境原生事件 id（claude: record uuid / tool_use call id）——锚点重定位键。
    pub native_event_id: Option<String>,
    /// 源文件行号（1 基）与行首字节偏移——自校验加速 hints，不存路径。
    pub source_line: Option<i64>,
    pub source_byte_offset: Option<i64>,
}

impl WorkflowEvent {
    /// Validate the cross-harness contract.  Wire-specific missing-field policy
    /// remains in the adapter; the data layer rejects only malformed output.
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.event_id.is_empty() || self.event_id.len() > 256 {
            return Err("workflow event id is empty or too long");
        }
        if self.session_key.as_deref().is_some_and(|v| v.is_empty()) {
            return Err("workflow event session key is empty");
        }
        if self.event_ts_ms < 0 {
            return Err("workflow event timestamp is negative");
        }
        if !matches!(
            self.event_type.as_str(),
            "task_started"
                | "task_finished"
                | "skill_invoked"
                | "skill_finished"
                | "tool_invoked"
                | "tool_finished"
                | "model_switched"
                | "approval_denied"
        ) {
            return Err("workflow event type is unknown");
        }
        if let Some(kind) = self.capability_kind.as_deref() {
            if !matches!(kind, "skill" | "tool" | "model") {
                return Err("workflow event capability kind is unknown");
            }
        }
        if !matches!(
            self.outcome.as_str(),
            "succeeded" | "failed" | "cancelled" | "unknown"
        ) {
            return Err("workflow event outcome is unknown");
        }
        if self.duration_ms.is_some_and(|value| value < 0) {
            return Err("workflow event duration is negative");
        }
        for value in [
            self.capability_id.as_deref(),
            self.capability_version.as_deref(),
            self.error_fingerprint.as_deref(),
            self.invocation_fingerprint.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            if value.is_empty() || value.len() > 256 {
                return Err("workflow event redacted value is empty or too long");
            }
        }
        // V16 富化字段：词表闭集（内联 matches!，与 enrichment::ErrorClass 的
        // 同步由 enrichment 侧测试钉住——contracts 不引 domain，分层只允许反向）
        // + 有界性。摘录以码点计（CJK 每字符 3 字节，按字节限会把 120 码点
        // 上限错切成 40 个汉字）。
        if let Some(class) = self.error_class.as_deref() {
            if !matches!(
                class,
                "transport"
                    | "rate_limit"
                    | "auth"
                    | "schema_violation"
                    | "method_not_found"
                    | "timeout"
                    | "parse"
                    | "tool_policy"
                    | "context_overflow"
                    | "unknown"
            ) {
                return Err("workflow event error class is unknown");
            }
        }
        for value in [self.error_code.as_deref(), self.native_event_id.as_deref()]
            .into_iter()
            .flatten()
        {
            if value.is_empty() || value.len() > 256 {
                return Err("workflow event enrichment value is empty or too long");
            }
        }
        for excerpt in [self.error_excerpt.as_deref(), self.args_excerpt.as_deref()]
            .into_iter()
            .flatten()
        {
            if excerpt.is_empty() || excerpt.chars().count() > 256 {
                return Err("workflow event excerpt is empty or too long");
            }
        }
        for size in [self.request_bytes, self.result_bytes, self.source_line, self.source_byte_offset]
            .into_iter()
            .flatten()
        {
            if size < 0 {
                return Err("workflow event enrichment size is negative");
            }
        }
        Ok(())
    }
}

/// 任务意图摘录（V16 `session_excerpts` 的契约形状）。取材与算法的单一真相源
/// 是 `domain::enrichment::make_excerpt`（scrub 先于截断、共享 WS 集、标记保护；
/// Python 镜像 + `fixtures/enrichment/vectors.json` 双侧锁步）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionExcerpt {
    /// 归一会话 ledger key（非空）。
    pub session_key: String,
    /// 会话内稳定序号（claude: 记录在源文件中的位置序）。
    pub ordinal: i64,
    /// 闭集：`user_first | user_turn | assistant_final | subagent_task`。
    pub role: String,
    /// scrub + 截断后的文本；空文本不产行（adapter 侧就不产）。
    pub excerpt: String,
    /// 闭集：`verbatim | truncated | scrubbed`。
    pub provenance: String,
    /// 执行环境原生事件 id（锚点重定位键）。
    pub native_event_id: String,
}

impl SessionExcerpt {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.session_key.is_empty() {
            return Err("session excerpt session key is empty");
        }
        if self.ordinal < 0 {
            return Err("session excerpt ordinal is negative");
        }
        if !matches!(
            self.role.as_str(),
            "user_first" | "user_turn" | "assistant_final" | "subagent_task"
        ) {
            return Err("session excerpt role is unknown");
        }
        if !matches!(
            self.provenance.as_str(),
            "verbatim" | "truncated" | "scrubbed"
        ) {
            return Err("session excerpt provenance is unknown");
        }
        if self.excerpt.is_empty() || self.excerpt.chars().count() > 256 {
            return Err("session excerpt text is empty or too long");
        }
        if self.native_event_id.is_empty() || self.native_event_id.len() > 256 {
            return Err("session excerpt native event id is empty or too long");
        }
        Ok(())
    }
}

/// 会话标题（City 楼名等本地展示面的取材）。与 [`SessionExcerpt`] 同一投
/// 影族：有界、脱敏后的用户/AI 生成文本，落在 `sessions.title` 业务列。
///
/// **为什么按 `native_session_id` 而不是 ledger session_key 键**：DSH 的
/// profile 由会话日志 header 派生（`dsh_source_profile`），侧车索引
/// （`workspace.json`）只有 session id → 标题映射、没有 profile——按
/// session_key join 需要猜 profile，猜错就静默丢标题。写路径按
/// `(harness, machine_namespace, native_session_id)` 自然键 UPDATE，
/// 与 `sessions` 表的 UNIQUE 约束同一身份。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionTitle {
    /// 执行环境原生会话 id（非空；codex = 逻辑 `payload.session_id`，与标题
    /// 索引的 join 键同源）。
    pub native_session_id: String,
    /// 脱敏 + 截断后的标题文本；空文本不产行（adapter 侧就不产）。
    pub title: String,
    /// 闭集：adapter 明确采集的原生标题来源。
    pub source: String,
}

/// 会话标题的字符上限——与摘录同界（`SessionExcerpt::validate` 的 256）。
pub const SESSION_TITLE_MAX_CHARS: usize = 256;

impl SessionTitle {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.native_session_id.is_empty() {
            return Err("session title native session id is empty");
        }
        if self.title.is_empty() || self.title.chars().count() > SESSION_TITLE_MAX_CHARS {
            return Err("session title text is empty or too long");
        }
        if !matches!(
            self.source.as_str(),
            "codex_thread_name" | "claude_ai_title" | "dsh_workspace_title" | "zcode_session_title"
        ) {
            return Err("session title source is unknown");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{SessionExcerpt, SessionTitle, WorkflowEvent};

    fn base_event() -> WorkflowEvent {
        WorkflowEvent {
            event_id: "workflow:t:1".to_string(),
            session_key: Some("claude-code|ns|default|s1".to_string()),
            event_ts_ms: 1,
            event_type: "tool_finished".to_string(),
            capability_kind: Some("tool".to_string()),
            capability_id: Some("bash".to_string()),
            capability_version: None,
            outcome: "failed".to_string(),
            duration_ms: None,
            error_fingerprint: None,
            invocation_fingerprint: None,
            error_code: None,
            error_class: None,
            error_excerpt: None,
            args_excerpt: None,
            request_bytes: None,
            result_bytes: None,
            native_event_id: None,
            source_line: None,
            source_byte_offset: None,
        }
    }

    /// contracts 的内联 error_class 闭集必须与 `enrichment::ErrorClass` 十值
    /// 逐一同步——分层不许 contracts 引 domain（生产代码），同步由本测试钉住：
    /// 任何一侧加值而另一侧不跟，这里立刻炸。
    #[test]
    fn inline_error_class_set_matches_enrichment_enum() {
        let classes = [
            "transport", "rate_limit", "auth", "schema_violation", "method_not_found",
            "timeout", "parse", "tool_policy", "context_overflow", "unknown",
        ];
        assert_eq!(classes.len(), crate::domain::enrichment::ErrorClass::variant_count());
        for wire in classes {
            assert_eq!(
                crate::domain::enrichment::ErrorClass::from_wire(wire)
                    .map(|c| c.as_str()),
                Some(wire),
                "enrichment 词表与测试清单不同步：{wire}"
            );
            let mut event = base_event();
            event.error_class = Some(wire.to_string());
            assert!(event.validate().is_ok(), "闭集内应通过：{wire}");
        }
        let mut event = base_event();
        event.error_class = Some("credits".to_string());
        assert_eq!(event.validate(), Err("workflow event error class is unknown"));
    }

    /// contracts 的内联 role/provenance 闭集与 enrichment 枚举逐值 round-trip
    /// 同步（error_class 版的镜像钉子——wire 串改名时 count 不变，只有逐值
    /// round-trip 才会炸；否则 push_excerpt 的 validate 吞掉一切、摘录静默消失）。
    #[test]
    fn inline_excerpt_vocabularies_match_enrichment_enums() {
        for wire in ["user_first", "user_turn", "assistant_final", "subagent_task"] {
            assert_eq!(
                crate::domain::enrichment::ExcerptRole::from_wire(wire)
                    .map(|r| r.as_str()),
                Some(wire),
                "enrichment role 词表与内联集不同步：{wire}"
            );
        }
        assert_eq!(crate::domain::enrichment::ExcerptRole::variant_count(), 4);
        for wire in ["verbatim", "truncated", "scrubbed"] {
            assert_eq!(
                crate::domain::enrichment::ExcerptProvenance::from_wire(wire)
                    .map(|p| p.as_str()),
                Some(wire),
                "enrichment provenance 词表与内联集不同步：{wire}"
            );
        }
    }

    #[test]
    fn excerpt_vocabulary_and_bounds_are_enforced() {
        let classes = crate::domain::enrichment::ExcerptRole::variant_count();
        assert_eq!(classes, 4, "role 闭集四值，新增必须先改 spec");
        for (role, ok) in [
            ("user_first", true),
            ("user_turn", true),
            ("assistant_final", true),
            ("subagent_task", true),
            ("bogus", false),
        ] {
            let excerpt = SessionExcerpt {
                session_key: "k".to_string(),
                ordinal: 0,
                role: role.to_string(),
                excerpt: "文本".to_string(),
                provenance: "verbatim".to_string(),
                native_event_id: "uuid-1".to_string(),
            };
            assert_eq!(excerpt.validate().is_ok(), ok, "role={role}");
        }
        for provenance in ["verbatim", "truncated", "scrubbed"] {
            let excerpt = SessionExcerpt {
                session_key: "k".to_string(),
                ordinal: 0,
                role: "user_turn".to_string(),
                excerpt: "文本".to_string(),
                provenance: provenance.to_string(),
                native_event_id: "uuid-1".to_string(),
            };
            assert!(excerpt.validate().is_ok(), "provenance={provenance}");
        }
        // 摘录有界性按码点计：249 个 CJK 字符（747 字节）必须通过 256 码点上限。
        let long = SessionExcerpt {
            session_key: "k".to_string(),
            ordinal: 0,
            role: "user_first".to_string(),
            excerpt: "锚".repeat(249),
            provenance: "truncated".to_string(),
            native_event_id: "uuid-1".to_string(),
        };
        assert!(long.validate().is_ok(), "按码点而非字节计上限");
        let negative = SessionExcerpt {
            session_key: "k".to_string(),
            ordinal: -1,
            role: "user_first".to_string(),
            excerpt: "x".to_string(),
            provenance: "verbatim".to_string(),
            native_event_id: "u".to_string(),
        };
        assert!(negative.validate().is_err());
    }

    #[test]
    fn session_title_validates_closed_shape() {
        let base = SessionTitle {
            native_session_id: "s1".to_string(),
            title: "修复菜单栏图标".to_string(),
            source: "claude_ai_title".to_string(),
        };
        assert!(base.validate().is_ok());
        let zcode = SessionTitle { source: "zcode_session_title".to_string(), ..base.clone() };
        assert!(zcode.validate().is_ok());

        let empty_sid = SessionTitle { native_session_id: String::new(), ..base.clone() };
        assert!(empty_sid.validate().is_err());
        let empty_text = SessionTitle { title: String::new(), ..base.clone() };
        assert!(empty_text.validate().is_err());
        let too_long = SessionTitle { title: "题".repeat(257), ..base.clone() };
        assert!(too_long.validate().is_err());
        // 按码点而非字节计上限（与摘录同纪律）
        let edge = SessionTitle { title: "题".repeat(256), ..base.clone() };
        assert!(edge.validate().is_ok());
        let bad_source = SessionTitle { source: "guessed".to_string(), ..base };
        assert!(bad_source.validate().is_err());
    }

}
