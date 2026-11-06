"""v0.9.1 PR #4.5 — `agent_vitals.agent.sessions_sql` Python wrapper 直测。

这套测试**只**覆盖 sessions_sql.py 的纯函数 + envelope 形状契约（与 Rust
`mcp::{sessions_search, session_detail, session_ref}` byte-mirror）：
- HMAC session_ref 不泄漏 native id
- Cursor 格式 round-trip + 错误形态
- 北京日 / 月窗口边界（含跨 DST/闰秒的安全路径）
- envelope 顶层键集合 + 顺序与 Rust 一致
- `_session_cost_minor` 价卡 JOIN 路径：有 → `{amount_minor, currency, basis}`，
  无 → `None`（spec §0.1 不冒充零成本）
- 缺库 → `database_missing` typed error envelope

**不**覆盖：
- CLI argparse ↔ wrapper 接线（test_cli_matrix.py 守）
- Python ↔ Rust byte-equal envelope（tests/mcp_smoke.py S5 守）
- 真机 SQLite ↔ Rust authority_db schema 同步（不在本文件 scope——本测试用
  Python `sqlite3` 直接创一份最小 v2 schema，断言 wrapper 自身契约；不依赖
  Rust 端开库）

设计依据：
- sessions_sql.py 文件头 1-31 行（wrapper 落地 + byte-mirror 承诺）
- crates/agent-vitals-mcp/src/mcp/sessions_search.rs:267-396（同形 Rust 测试）
- crates/agent-vitals-data/src/authority.rs:107-289（v2 schema DDL）
"""

import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "packages" / "agent-vitals-python") not in sys.path:
    sys.path.insert(
        0, str(ROOT / "packages" / "agent-vitals-python"))

from agent_vitals.agent import sessions_sql  # noqa: E402


# ────────────────────────────────────────────────────────────────────────
# v2 schema（最小集，只覆盖 wrapper 用的 6 表）
# mirror crates/agent-vitals-data/src/authority.rs:107-289 的 DDL（spec §3）。
# 测试用 sqlite3 直创；不调 Rust `AuthorityDb::open` 避免给本测试挂 Rust build。
# ────────────────────────────────────────────────────────────────────────

SCHEMA_V2 = r"""
CREATE TABLE schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE sync_runs (
  run_id TEXT PRIMARY KEY,
  started_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  error_code TEXT,
  error_detail TEXT
);

CREATE TABLE source_files (
  source_id TEXT PRIMARY KEY,
  harness TEXT NOT NULL,
  path_hash TEXT NOT NULL,
  native_session_id TEXT,
  size_bytes INTEGER NOT NULL,
  mtime_ns INTEGER NOT NULL,
  content_fingerprint TEXT,
  parser_version INTEGER NOT NULL,
  first_seen_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER NOT NULL,
  last_successful_run_id TEXT REFERENCES sync_runs(run_id),
  last_error_code TEXT,
  UNIQUE(harness, path_hash)
);

CREATE TABLE sessions (
  session_key TEXT PRIMARY KEY,
  harness TEXT NOT NULL,
  native_session_id TEXT NOT NULL,
  machine_namespace TEXT NOT NULL,
  source_profile TEXT,
  started_at_ms INTEGER,
  ended_at_ms INTEGER,
  last_observed_at_ms INTEGER NOT NULL,
  deleted_at_ms INTEGER,
  UNIQUE(harness, machine_namespace, native_session_id)
);

CREATE TABLE usage_facts (
  fact_id TEXT PRIMARY KEY,
  harness TEXT NOT NULL,
  machine_namespace TEXT NOT NULL,
  native_session_id TEXT NOT NULL,
  session_key TEXT REFERENCES sessions(session_key),
  source_event_id TEXT NOT NULL,
  observation_kind TEXT NOT NULL,
  source_profile TEXT,
  provider_id TEXT,
  model_id TEXT,
  event_ts_ms INTEGER,
  event_peak INTEGER NOT NULL DEFAULT 0,
  uncached_input_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  source_id TEXT REFERENCES source_files(source_id),
  ingested_run_id TEXT NOT NULL REFERENCES sync_runs(run_id),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  deleted_at_ms INTEGER,
  CHECK (uncached_input_tokens >= 0),
  CHECK (cache_read_tokens >= 0),
  CHECK (cache_write_tokens >= 0),
  CHECK (output_tokens >= 0),
  UNIQUE(harness, machine_namespace, native_session_id, source_event_id, observation_kind)
);

CREATE INDEX usage_facts_harness_time
  ON usage_facts(harness, event_ts_ms) WHERE deleted_at_ms IS NULL;
CREATE INDEX usage_facts_session_time
  ON usage_facts(session_key, event_ts_ms) WHERE deleted_at_ms IS NULL;

CREATE TABLE pricing_snapshots (
  pricing_version TEXT PRIMARY KEY,
  captured_at_ms INTEGER NOT NULL,
  source_kind TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE harness_runtime_snapshots (
  harness TEXT NOT NULL,
  snapshot_kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  observed_at_ms INTEGER NOT NULL,
  source_id TEXT REFERENCES source_files(source_id),
  ingested_run_id TEXT NOT NULL REFERENCES sync_runs(run_id),
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(harness, snapshot_kind)
);

CREATE TABLE data_quality_issues (
  issue_id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  code TEXT NOT NULL,
  severity TEXT NOT NULL,
  first_seen_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER NOT NULL,
  resolved_at_ms INTEGER,
  detail_json TEXT NOT NULL,
  UNIQUE(scope_type, scope_key, code)
);
"""


def _seed_authority(home: Path, *, with_pricing: bool = False) -> None:
    """在 home 创 schema v2 + 1 个 sync_runs + (可选) 1 个 pricing_snapshot。

    不放 sessions/usage_facts —— 各测试自己 seed 业务数据。
    """
    home.mkdir(parents=True, exist_ok=True)
    db = home / "agent-vitals.sqlite3"
    conn = sqlite3.connect(str(db))
    try:
        conn.executescript(SCHEMA_V2)
        conn.execute(
            "INSERT INTO schema_meta(key, value) VALUES ('schema_version', '2')"
        )
        conn.execute(
            "INSERT INTO sync_runs(run_id, started_at_ms, trigger, status, schema_version)"
            " VALUES ('run', 1, 'cli', 'succeeded', 2)"
        )
        if with_pricing:
            # pricing JSON 形状（mirror cost.py::_price 的取键）：
            #   providers.<provider>.models.<model>.{input_uncached, input_cached, output}
            #   各自的 off_peak / peak。`cache_write` 不参与（spec §6.7 单独
            #   计费路径，不在 cost_report 折算里）。
            payload = (
                '{"fallback_provider":"deepseek-official",'
                '"providers":{"deepseek-official":{"models":{"deepseek-v4-pro":'
                '{"input_uncached":{"off_peak":4.5,"peak":9.0},'
                '"input_cached":{"off_peak":0.45,"peak":0.9},'
                '"output":{"off_peak":9.0,"peak":18.0}}}}}}'
            )
            conn.execute(
                "INSERT INTO pricing_snapshots(pricing_version, captured_at_ms, source_kind, payload_json)"
                " VALUES ('v1', ?, 'cli_seed', ?)",
                (1, payload),
            )
        conn.commit()
    finally:
        conn.close()


def _add_session(conn, session_key: str, harness: str, native_id: str,
                 ns: str = "m", profile: str = "default") -> None:
    conn.execute(
        "INSERT INTO sessions(session_key, harness, native_session_id, machine_namespace,"
        " source_profile, last_observed_at_ms)"
        " VALUES (?, ?, ?, ?, ?, 1)",
        (session_key, harness, native_id, ns, profile),
    )


def _add_fact(conn, fact_id: str, harness: str, session_key: str,
              ts_ms: int, *, uncached: int = 0, cache_read: int = 0,
              cache_write: int = 0, output: int = 0, peak: int = 0,
              model: str = "deepseek-v4-pro", provider: str = "deepseek-official",
              native_id: str = "nat-1") -> None:
    # usage_facts 列序（schema v2 DDL，21 列）：fact_id, harness,
    # machine_namespace, native_session_id, session_key, source_event_id,
    # observation_kind, source_profile, provider_id, model_id, event_ts_ms,
    # event_peak, uncached_input_tokens, cache_read_tokens, cache_write_tokens,
    # output_tokens, source_id, ingested_run_id, created_at_ms, updated_at_ms,
    # deleted_at_ms。source_profile / source_id / deleted_at_ms 三个
    # nullable 列置 None —— 测试不关心 source 文件与软删除语义。
    conn.execute(
        "INSERT INTO usage_facts(fact_id, harness, machine_namespace,"
        " native_session_id, session_key, source_event_id, observation_kind,"
        " source_profile, provider_id, model_id, event_ts_ms, event_peak,"
        " uncached_input_tokens, cache_read_tokens, cache_write_tokens,"
        " output_tokens, source_id, ingested_run_id, created_at_ms,"
        " updated_at_ms, deleted_at_ms)"
        " VALUES (?, ?, 'm', ?, ?, ?, 'assistant-usage', NULL, ?, ?,"
        " ?, ?, ?, ?, ?, ?, NULL, 'run', 1, 1, NULL)",
        (fact_id, harness, native_id, session_key, fact_id, provider, model,
         ts_ms, peak, uncached, cache_read, cache_write, output),
    )


# ────────────────────────────────────────────────────────────────────────
# HMAC session_ref — 不能泄漏 native id；同一 salt + key → 同一 ref
# ────────────────────────────────────────────────────────────────────────

class SessionRefHmacTests(unittest.TestCase):
    """mirror crates/agent-vitals-query/src/query/session_ref.rs（W3 从 mcp/ 移来）。

    钉住：
    1. ref 形如 `sr_<32 hex>`（HMAC-SHA256 截前 16 字节）
    2. ref 不含 native id / machine_namespace 字面值
    3. 同 salt + 同 key → 同 ref（决定性，分页才能 round-trip）
    4. 不同 salt + 同 key → 不同 ref（salt 是脱敏强度的根）
    5. resolve_session_key 在候选集里反解出原 key
    """

    def test_ref_is_sr_prefixed_32_hex(self):
        salt = os.urandom(32)
        ref = sessions_sql.session_ref(salt, "5:codex|2:s1|5:/repo|6:ns-abc")
        self.assertTrue(ref.startswith("sr_"))
        hex_part = ref[len("sr_"):]
        self.assertEqual(len(hex_part), 32)
        int(hex_part, 16)  # 必须能 parse 为 hex；不抛即过

    def test_ref_does_not_leak_native_id_or_namespace(self):
        """native id / machine_namespace 都不应出现在 ref 里。
        这条断言用真实业务值做 fixture：一旦哪天实现退回成 hash(input) 截断
        或者拼了 native_id 前缀,这条立刻红。
        """
        salt = os.urandom(32)
        key = "5:claude-code|20:secretnativeid1234567|4:ns01|9:some-prof"
        ref = sessions_sql.session_ref(salt, key)
        for forbidden in ("secretnativeid1234567", "ns01", "claude-code",
                          "some-prof"):
            self.assertNotIn(
                forbidden, ref,
                f"session_ref leaked component {forbidden!r}: {ref}",
            )

    def test_same_salt_same_key_same_ref(self):
        salt = os.urandom(32)
        a = sessions_sql.session_ref(salt, "5:codex|2:s1|5:/repo|6:ns")
        b = sessions_sql.session_ref(salt, "5:codex|2:s1|5:/repo|6:ns")
        self.assertEqual(a, b, "决定性 — 分页 cursor / dedup 依赖")

    def test_different_salt_same_key_different_ref(self):
        a = sessions_sql.session_ref(os.urandom(32), "5:codex|2:s1|5:/repo|6:ns")
        b = sessions_sql.session_ref(os.urandom(32), "5:codex|2:s1|5:/repo|6:ns")
        self.assertNotEqual(a, b, "salt 改了 → ref 必变（防跨用户碰撞）")

    def test_resolve_session_key_finds_match(self):
        salt = os.urandom(32)
        keys = [
            "5:claude-code|9:healthy01|4:ns01|7:prof-1",
            "5:claude-code|9:dangerous|4:ns01|7:prof-2",
            "5:codex|10:rollout-sol|4:ns01|7:prof-3",
        ]
        target = sessions_sql.session_ref(salt, keys[1])
        self.assertEqual(sessions_sql.resolve_session_key(salt, target, keys), keys[1])

    def test_resolve_session_key_returns_none_on_no_match(self):
        salt = os.urandom(32)
        keys = ["5:codex|2:s1|5:/r|6:ns01", "5:codex|2:s2|5:/r|6:ns01"]
        target = sessions_sql.session_ref(salt, "5:codex|2:s3|5:/r|6:ns01")
        self.assertIsNone(sessions_sql.resolve_session_key(salt, target, keys))

    def test_salt_file_round_trip(self):
        """load_or_create_salt 在 home 下创建 32B salt 文件（0600 模式,
        第二次读回同一份 —— 这是 sessions_search 与 session_detail 共用
        session_ref 的前提）。"""
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            s1 = sessions_sql.load_or_create_salt(home)
            self.assertEqual(len(s1), 32)
            self.assertTrue((home / sessions_sql.SALT_FILE).is_file())
            s2 = sessions_sql.load_or_create_salt(home)
            self.assertEqual(s1, s2, "同一 home 必须读回同一 salt")


# ────────────────────────────────────────────────────────────────────────
# Cursor 解析 / 生成 — 与 Rust `parse_*_cursor`/`make_*_cursor` 逐字段对账
# ────────────────────────────────────────────────────────────────────────

class CursorRoundtripTests(unittest.TestCase):
    """mirror crates/agent-vitals-mcp/src/mcp/sessions_search.rs:375-396
    `parse_search_cursor_roundtrip_and_errors` + session_detail 同款测试。

    钉住 cursor 格式 `<total>:<key_len>:<key>` / `<ts>:<fid_len>:<fid>`
    ——长度前缀是 spec §0 不让内嵌冒号误分隔；round-trip 必须稳定。
    """

    def test_search_cursor_roundtrip_with_embedded_colons(self):
        key = "5:codex|2:s1|5:/repo|6:ns-abc"
        total = 1234
        cur = sessions_sql._make_search_cursor(total, key)
        got = sessions_sql._parse_search_cursor(cur)
        self.assertIsNotNone(got)
        self.assertEqual(got, (total, key))

    def test_search_cursor_length_mismatch_returns_none(self):
        # 长度前缀与实际 key 长度不一致 → None（mirror Rust invalid_argument）
        key = "5:codex|2:s1|5:/repo|6:ns-abc"
        bad = f"1234:{len(key) + 1}:{key}"
        self.assertIsNone(sessions_sql._parse_search_cursor(bad))

    def test_search_cursor_malformed_inputs_return_none(self):
        # 缺段 / 非数字 / 纯空 —— 全 invalid_argument 对应 None。
        for bad in ["", "100", "100:5", "abc:5:xyz", "100:abc:xyz"]:
            self.assertIsNone(
                sessions_sql._parse_search_cursor(bad),
                f"expected None for {bad!r}",
            )

    def test_detail_cursor_roundtrip(self):
        ts = 1_700_000_000_000
        fid = "f1234567-89ab-cdef-0123-456789abcdef"
        cur = sessions_sql._make_detail_cursor(ts, fid)
        got = sessions_sql._parse_detail_cursor(cur)
        self.assertEqual(got, (ts, fid))

    def test_detail_cursor_malformed_inputs_return_none(self):
        for bad in ["", "1234", "1234:5", "abc:5:xyz", "1234:abc:xyz"]:
            self.assertIsNone(
                sessions_sql._parse_detail_cursor(bad),
                f"expected None for {bad!r}",
            )


# ────────────────────────────────────────────────────────────────────────
# 北京日 / 月窗口 + ms → RFC 3339 `+08:00`
# ────────────────────────────────────────────────────────────────────────

class BeijingDateBoundsTests(unittest.TestCase):
    """mirror Rust `beijing_day_bounds_ms` / `beijing_month_bounds_ms` /
    `ms_to_rfc3339_beijing`。钉住双偏移陷阱（spec §6.3）：本 wrapper
    `local = ms + BEIJING_OFFSET_MS` 后当 UTC civil 解,字符串尾巴硬编
    `+08:00` —— **不是** Python `datetime.fromtimestamp(s, tz=+08:00)`
    的语义（那个会把 `s` 当 UTC 0 偏移,再加 8h,造成"双偏移"事故）。
    """

    def test_day_bounds_24h_apart(self):
        start, end = sessions_sql.beijing_day_bounds_ms("2026-09-07")
        self.assertIsNotNone(start)
        self.assertEqual(end - start, sessions_sql.DAY_MS)

    def test_month_bounds_30_or_31_days_apart(self):
        # 9 月：30 天
        start, end = sessions_sql.beijing_month_bounds_ms("2026-09")
        self.assertEqual(end - start, 30 * sessions_sql.DAY_MS)
        # 10 月：31 天
        start, end = sessions_sql.beijing_month_bounds_ms("2026-10")
        self.assertEqual(end - start, 31 * sessions_sql.DAY_MS)

    def test_invalid_date_format_returns_none(self):
        self.assertIsNone(sessions_sql.beijing_day_bounds_ms("2026-9-7"))   # 单位数
        self.assertIsNone(sessions_sql.beijing_day_bounds_ms("20260907"))   # 无分隔符
        self.assertIsNone(sessions_sql.beijing_day_bounds_ms("2026-13-01"))  # 月越界

    def test_ms_to_rfc3339_beijing_no_double_shift(self):
        """UTC 1970-01-01 00:00 = 北京 1970-01-01 08:00。Python 早期版本的
        `datetime.fromtimestamp(0, tz=+08:00)` 会正确返回 08:00 +08:00,
        但**只要传 ms > 0 就双偏移**——锁住固定 ms 比对 Rust 同名输出。"""
        s = sessions_sql._ms_to_rfc3339_beijing(0)
        self.assertEqual(s, "1970-01-01T08:00:00.000+08:00")

    def test_ms_to_rfc3339_beijing_known_anchor(self):
        """2026-09-08 北京 00:00:00.000 = UTC 2026-09-07 16:00:00.000。
        ms = (2026-09-07 - 1970-01-01) UTC 0 点的 epoch ms + 16h。
        钉住 Rust 同名函数输出值,防止双偏移回归。"""
        utc_2026_09_07_16_00 = (
            sessions_sql._days_to_utc_midnight_ms(2026, 9, 7) + 16 * 3_600_000
        )
        s = sessions_sql._ms_to_rfc3339_beijing(utc_2026_09_07_16_00)
        self.assertEqual(s, "2026-09-08T00:00:00.000+08:00")

    def test_query_local_timezone_override_is_dst_aware(self):
        """显式查询时区只作用于本次调用，并正确处理 23 小时春季切换月。"""
        self.assertIsNotNone(sessions_sql.validate_timezone("America/Los_Angeles"))
        self.assertIsNone(sessions_sql.validate_timezone("not/a-zone"))
        with sessions_sql._timezone_scope("America/Los_Angeles") as valid:
            self.assertTrue(valid)
            start, end = sessions_sql.beijing_month_bounds_ms("2026-03")
            self.assertEqual(start, 1772352000000)  # 2026-03-01T08:00:00Z
            self.assertEqual(end, 1775026800000)    # 2026-04-01T07:00:00Z
            self.assertEqual(end - start, 31 * sessions_sql.DAY_MS - sessions_sql.HOUR_MS)


# ────────────────────────────────────────────────────────────────────────
# 缺库 → typed error envelope（AuthorityError → ToolError 映射守门）
# ────────────────────────────────────────────────────────────────────────

class DatabaseMissingTests(unittest.TestCase):
    """mirror Rust `AuthorityError::MissingFile` → `ToolError { code:
    "database_missing" }`。CLI / MCP 在库缺席时**必须**报这条 typed error,
    而不是静默空 envelope（spec §6.4 §0.1）。"""

    def test_sessions_search_returns_database_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = sessions_sql.sessions_search(
                {"date": "2026-09-07"}, Path(tmp))
            self.assertEqual(env["schema_version"], "1")
            self.assertIsNone(env["data"])
            self.assertEqual(env["error"]["code"], "database_missing")
            self.assertIn("authority DB does not exist", env["error"]["message"])

    def test_session_detail_returns_database_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = sessions_sql.session_detail(
                {"session_ref": "sr_" + "0" * 32}, Path(tmp))
            self.assertEqual(env["error"]["code"], "database_missing")

    def test_invalid_args_return_invalid_argument(self):
        """exactly-one-of date/month 守门（mirror Rust 同款）。"""
        with tempfile.TemporaryDirectory() as tmp:
            _seed_authority(Path(tmp))
            # 都没传
            env = sessions_sql.sessions_search({}, Path(tmp))
            self.assertEqual(env["error"]["code"], "invalid_argument")
            # 两个都传
            env = sessions_sql.sessions_search(
                {"date": "2026-09-07", "month": "2026-09"}, Path(tmp))
            self.assertEqual(env["error"]["code"], "invalid_argument")
            # hour 跟 month 互斥
            env = sessions_sql.sessions_search(
                {"month": "2026-09", "hour": 5}, Path(tmp))
            self.assertEqual(env["error"]["code"], "invalid_argument")


# ────────────────────────────────────────────────────────────────────────
# 真实 DB:hour 过滤、cost_minor 路径、envelope 形状
# ────────────────────────────────────────────────────────────────────────

class SeededEnvelopeTests(unittest.TestCase):
    """塞一份最小 v2 DB,跑 sessions_search / session_detail,断言 envelope
    形状 + hour / cost_minor / cursor 行为。

    钉住的契约（与 Rust side 对账）：
    1. envelope 顶层 schema_version = "1",data_version.query_semantics =
       "2026-09-07"（spec §6 envelope）
    2. data.window.label = 入参的 YYYY-MM-DD
    3. data.sessions[].session_ref 以 `sr_` 起头,**不**含 native id
    4. hour=N 过滤掉非该小时的事件
    5. cost_minor 有价卡 → object;无价卡 → null（spec §0.1 不冒充）
    """

    def _seed(self, with_pricing: bool):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        _seed_authority(self.home, with_pricing=with_pricing)
        db = self.home / "agent-vitals.sqlite3"
        conn = sqlite3.connect(str(db))
        try:
            _add_session(conn, "5:claude-code|9:healthy01|4:ns01|7:prof-1",
                         "claude-code", "healthy01")
            _add_session(conn, "5:claude-code|9:dangerous|4:ns01|7:prof-2",
                         "claude-code", "dangerous")
            # day = 2026-09-07 (Beijing) 的 start_ms(epoch UTC)
            start_ms, end_ms = sessions_sql.beijing_day_bounds_ms("2026-09-07")
            # hour 9 (Beijing 09:00) 一个 fact
            _add_fact(conn, "f1", "claude-code", "5:claude-code|9:healthy01|4:ns01|7:prof-1",
                      start_ms + 9 * 3_600_000, uncached=300)
            # hour 22 一个 fact (peak)
            _add_fact(conn, "f2", "claude-code", "5:claude-code|9:dangerous|4:ns01|7:prof-2",
                      start_ms + 22 * 3_600_000, uncached=500, peak=1)
            # hour 22 第二个 fact 给同会话
            _add_fact(conn, "f3", "claude-code", "5:claude-code|9:dangerous|4:ns01|7:prof-2",
                      start_ms + 22 * 3_600_000 + 1000, uncached=200)
            conn.commit()
        finally:
            conn.close()

    def test_envelope_top_level_keys_and_types(self):
        self._seed(with_pricing=False)
        env = sessions_sql.sessions_search(
            {"date": "2026-09-07"}, self.home)
        self.assertEqual(env["schema_version"], "1")
        self.assertEqual(env["data_version"]["query_semantics"], "2026-09-07")
        self.assertEqual(env["timezone"], "Asia/Shanghai")
        self.assertIn("authority_state", env)
        self.assertIn("coverage", env)
        self.assertIn("freshness", env)
        self.assertIn("warnings", env)
        # data 不是 None —— 库在场,业务数据在场
        self.assertIsNotNone(env["data"])
        d = env["data"]
        self.assertEqual(d["window"]["label"], "2026-09-07")
        self.assertEqual(d["window_total_tokens"], 1000)  # 300 + 500 + 200
        self.assertEqual(len(d["sessions"]), 2)
        self.assertIn("next_cursor", d)
        self.assertIn("has_more", d)

    def test_session_ref_does_not_leak_native_id_in_envelope(self):
        self._seed(with_pricing=False)
        env = sessions_sql.sessions_search(
            {"date": "2026-09-07"}, self.home)
        envelope_json = json.dumps(env, ensure_ascii=False, sort_keys=True)
        for forbidden in ("healthy01", "dangerous", "ns01", "prof-1", "prof-2"):
            self.assertNotIn(
                forbidden, envelope_json,
                f"native/namespace leaked into envelope: {forbidden!r}",
            )
        for s in env["data"]["sessions"]:
            self.assertTrue(s["session_ref"].startswith("sr_"))

    def test_hour_filter_drops_out_of_window_events(self):
        """hour=9 应只取北京 09:00 那个 fact (300 token);hour=22 取 700。"""
        self._seed(with_pricing=False)
        env9 = sessions_sql.sessions_search(
            {"date": "2026-09-07", "hour": 9}, self.home)
        self.assertEqual(env9["data"]["window_total_tokens"], 300)
        env22 = sessions_sql.sessions_search(
            {"date": "2026-09-07", "hour": 22}, self.home)
        self.assertEqual(env22["data"]["window_total_tokens"], 700)
        # hour=9 看到的应是 healthy01 会话
        s = env9["data"]["sessions"][0]
        self.assertEqual(s["harness"], "claude-code")

    def test_cost_minor_null_without_pricing_snapshot(self):
        """无价卡 → cost_minor = null（spec §0.1）。"""
        self._seed(with_pricing=False)
        env = sessions_sql.sessions_search(
            {"date": "2026-09-07"}, self.home)
        for s in env["data"]["sessions"]:
            self.assertIsNone(
                s["cost_minor"],
                f"no pricing snapshot → cost_minor must be null: {s}",
            )

    def test_cost_minor_object_with_pricing_snapshot(self):
        """有价卡 → cost_minor 是 {amount_minor: i64, currency, basis}。"""
        self._seed(with_pricing=True)
        env = sessions_sql.sessions_search(
            {"date": "2026-09-07"}, self.home)
        any_with_cost = False
        for s in env["data"]["sessions"]:
            cm = s["cost_minor"]
            self.assertIsNotNone(cm, "有价卡覆盖 → cost_minor 非 null")
            self.assertIn("amount_minor", cm)
            self.assertIsInstance(cm["amount_minor"], int)
            self.assertEqual(cm["currency"], "CNY")
            self.assertEqual(cm["basis"], "metered_estimate")
            any_with_cost = True
        self.assertTrue(any_with_cost, "至少应有一条会话带 cost_minor")


# ────────────────────────────────────────────────────────────────────────
# Pagination —— has_more + next_cursor round-trip
# ────────────────────────────────────────────────────────────────────────

class PaginationTests(unittest.TestCase):
    """mirror Rust `pagination_flags_truncation_with_warning`
    （sessions_search.rs:289-312）。

    钉住：limit 触发 truncation → warning[code=truncated] + has_more=true
    + next_cursor 非空；第二页拿 cursor 后无重复、不会漏。
    """

    def _seed(self, n: int):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name)
        _seed_authority(self.home)
        db = self.home / "agent-vitals.sqlite3"
        conn = sqlite3.connect(str(db))
        try:
            start_ms, _ = sessions_sql.beijing_day_bounds_ms("2026-09-07")
            for i in range(n):
                skey = f"5:dsh|1:{i}|1:n"
                _add_session(conn, skey, "dsh", f"sid-{i:04d}")
                _add_fact(conn, f"f{i}", "dsh", skey,
                          start_ms + i * 1000, uncached=100 - i)
            conn.commit()
        finally:
            conn.close()

    def test_limit_truncates_with_truncated_warning_and_has_more(self):
        self._seed(n=5)
        env = sessions_sql.sessions_search(
            {"date": "2026-09-07", "limit": 2}, self.home)
        self.assertEqual(len(env["data"]["sessions"]), 2)
        self.assertTrue(env["data"]["has_more"])
        warnings = env["warnings"]
        self.assertTrue(
            any(w["code"] == "truncated" for w in warnings),
            f"expected truncated warning, got {warnings!r}",
        )
        self.assertIsNotNone(env["data"]["next_cursor"])

    def test_pagination_cursor_no_overlap(self):
        self._seed(n=5)
        page1 = sessions_sql.sessions_search(
            {"date": "2026-09-07", "limit": 2}, self.home)
        cur = page1["data"]["next_cursor"]
        page2 = sessions_sql.sessions_search(
            {"date": "2026-09-07", "limit": 2, "cursor": cur}, self.home)
        ids1 = {s["session_ref"] for s in page1["data"]["sessions"]}
        ids2 = {s["session_ref"] for s in page2["data"]["sessions"]}
        self.assertEqual(len(ids1), 2)
        self.assertEqual(len(ids2), 2)
        self.assertEqual(ids1 & ids2, set(),
                         f"page 1/2 must not overlap: {ids1 & ids2}")


if __name__ == "__main__":
    unittest.main()
