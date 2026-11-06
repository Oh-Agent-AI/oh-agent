"""Python mirror of `crates/agent-vitals-mcp/src/mcp/{sessions_search,
session_detail,session_ref}.rs` —— v0.9.1 PR #4.5 落地。

CLI Python 侧 `packages/agent-vitals-python/agent_vitals/cli.py:1606-1644`
dispatch 切到 `mcp::dispatch` 之前，必须有一个能直接 `sqlite3` 直连
`<data_home>/agent-vitals.sqlite3` 的 Python wrapper 产与 Rust 同形的
envelope。本文件就是这个 wrapper——byte-mirror spec §6 envelope 的
`data_version / authority_state / authority_revision / generated_at /
timezone / coverage / freshness / warnings / data` 顶层 + data 形状
（`window.{label,hour,from,to}` + `sessions[]` + `window_total_tokens` +
`has_more` + `next_cursor` + 每会话 `session_ref / harness / first_event_at /
last_event_at / event_count / model_ids / identity_kind / tokens{4 桶 +
total} / peak_tokens / cost_minor`）。

Rust 镜像层（旧 `crates/agent-vitals-runtime/src/sessions/r2a_store.rs`）
W8（2026-09-24）已整体删除（此前 behind `legacy-r2a` feature gate）。本 wrapper
是 sessions 路径的**新唯一** Python 实现：`legacy-r2a` PR #5 删 r2a_store
+ r2a.py 时,本文件连同 cli.py dispatch + tests/test_cli_matrix.py 字节对
账一起接管,Python CLI 不再有回退 jsonl 路径可走。

设计取舍：
- **零新规则**：SQL / HMAC / 计价全部调既有实现（`agent_vitals.adapters`、
  `agent_vitals.agent.cost.cost_report`、stdlib `sqlite3`）；不在这里长第
  二份 `cost_report` / 第二份 pyround / 第二份 beijing 时区
- **envelope 形状与 Rust 逐字节一致**：JSON 键名 / 顺序 / null 语义不漂
  ——`tests/test_cli_matrix.py::both("sessions", ...)` byte-alignment gate
  守这个
- **错误路径复用 Rust `ToolError` JSON 形状**：`{"error":{"code":..,
  "message":..}}` + 顶层 envelope（schema_version/data_version/...），
  与 `mcp::error_envelope` 同
"""

import functools
import hashlib
import json
import math
import os
import sqlite3
import sys
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, date, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

# Re-use authoritative Python helpers — do **not** grow a second implementation.
from agent_vitals.agent.cost import cost_report  # noqa: F401  (byte-mirror)
from agent_vitals.agent.codex_cost import today_beijing  # noqa: F401
from agent_vitals.agent import state as state_mod
from agent_vitals.paths import data_home


# ────────────────────────────────────────────────────────────────────────
# Spec §6 envelope constants（与 Rust `mcp/mod.rs` 同源；bump 时两侧同步）。
# ────────────────────────────────────────────────────────────────────────

ENVELOPE_SCHEMA_VERSION = "1"
QUERY_SEMANTICS = "2026-09-07"
# Kept for compatibility with callers that import the old constant. Statistics
# no longer use this fixed offset; they use the OS IANA timezone below.
BEIJING_OFFSET_MS = 8 * 3_600 * 1_000
DAY_MS = 86_400_000
HOUR_MS = 3_600_000
SALT_FILE = ".mcp-session-salt"
SALT_LEN = 32

DEFAULT_SEARCH_LIMIT = 50
MAX_SEARCH_LIMIT = 500
DEFAULT_DETAIL_LIMIT = 200
MAX_DETAIL_LIMIT = 1000

_TIMEZONE_OVERRIDE = ContextVar("sessions_sql_timezone_override", default=None)

# 与 Rust 侧 `agent_vitals_domain::data_contract::MoneyMinor` 接受的币种
# + 对应小数位数（CNY/USD/EUR/GBP/HKD/SGD/AUD/CAD/CHF/NZD = 2, JPY/KRW = 0,
# KWD/BHD/OMR = 3；未知币种走 None 不冒充——与 Rust side 一致）。
_CURRENCY_MINOR_DIGITS = {
    "CNY": 2, "USD": 2, "EUR": 2, "GBP": 2, "HKD": 2, "SGD": 2,
    "AUD": 2, "CAD": 2, "CHF": 2, "NZD": 2,
    "JPY": 0, "KRW": 0,
    "KWD": 3, "BHD": 3, "OMR": 3,
}


# ────────────────────────────────────────────────────────────────────────
# Spec §6.3 北京时区 RFC 3339（mirror Rust `ms_to_rfc3339_beijing`）。
# ────────────────────────────────────────────────────────────────────────

def _system_timezone():
    """Resolve the shared persisted statistics timezone."""
    override = _TIMEZONE_OVERRIDE.get()
    return override or state_mod._system_timezone()


def validate_timezone(name):
    """Return an IANA timezone for a query-local override, or ``None``."""
    if not isinstance(name, str) or not name.strip():
        return None
    try:
        return ZoneInfo(name.strip().lstrip(":"))
    except (ValueError, ZoneInfoNotFoundError):
        return None


@contextmanager
def _timezone_scope(name):
    zone = validate_timezone(name)
    if zone is None:
        yield False
        return
    token = _TIMEZONE_OVERRIDE.set(zone)
    try:
        yield True
    finally:
        _TIMEZONE_OVERRIDE.reset(token)


def _system_timezone_name():
    tz = _system_timezone()
    return getattr(tz, "key", str(tz))


def _ms_to_rfc3339_beijing(ms):
    """epoch 毫秒 → RFC 3339 in the OS statistics timezone.

    The historical function name remains as a compatibility symbol; its
    implementation is no longer fixed to Beijing.
    """
    if ms is None:
        return None
    millis = int(ms) % 1000
    dt = datetime.fromtimestamp(int(ms) // 1000, _system_timezone())
    offset = dt.strftime("%z")
    offset = offset[:3] + ":" + offset[3:] if len(offset) == 5 else offset
    return dt.strftime("%Y-%m-%dT%H:%M:%S") + ".%03d%s" % (millis, offset)


def _civil_from_days(z):
    """1970 起的天数 → (y, m, d)——Hinnant civil-from-days 整数算法
    （与 Rust `agent_vitals_domain::util::civil_from_unix_secs` 同款）。
    Python `//` floor 与 Rust `div_euclid` 在非负输入下等价。"""
    z = int(z) + 719468
    era = z // 146097
    doe = z - era * 146097
    yoe = (doe - doe // 1460 + doe // 36524 - doe // 146096) // 365
    y = yoe + era * 400
    doy = doe - (365 * yoe + yoe // 4 - yoe // 100)
    mp = (5 * doy + 2) // 153
    d = doy - (153 * mp + 2) // 5 + 1
    m = mp + 3 if mp < 10 else mp - 9
    y = y + 1 if m <= 2 else y
    return y, m, d


# ────────────────────────────────────────────────────────────────────────
# HMAC-SHA256（RFC 2104）—— 15 行构造，与 Rust `hmac_sha256` 同款。
# ────────────────────────────────────────────────────────────────────────

def _hmac_sha256(key, msg):
    block = 64
    k = bytearray(block)
    if len(key) > block:
        k[:32] = hashlib.sha256(key).digest()
    else:
        k[:len(key)] = key
    ipad = bytes(b ^ 0x36 for b in k)
    opad = bytes(b ^ 0x5c for b in k)
    inner = hashlib.sha256(ipad + msg).digest()
    return hashlib.sha256(opad + inner).digest()


# ────────────────────────────────────────────────────────────────────────
# Salt 持久化（mirror Rust `load_or_create_salt`）—— <data_home>/.mcp-session-salt,
# 32B, 0600（unix）。缺则 `/dev/urandom` 生成；非 unix 退回时间派生（弱,
# session_ref 只要求「不可反推原生 id」）。
# ────────────────────────────────────────────────────────────────────────

def _read_salt(path):
    try:
        with open(path, "rb") as f:
            data = f.read()
        if len(data) == SALT_LEN:
            return bytes(data)
    except OSError:
        return None
    return None


def _random_salt():
    buf = bytearray(SALT_LEN)
    try:
        with open("/dev/urandom", "rb") as f:
            f.readinto(buf)
            return bytes(buf)
    except OSError:
        pass
    # 时间派生退化路径（unix 才有 /dev/urandom）。
    seed = hashlib.sha256(str(datetime.now(tz=timezone.utc).timestamp()).encode()).digest()
    buf[:32] = seed
    return bytes(buf)


def _write_salt(path, salt):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, salt)
    finally:
        os.close(fd)


def load_or_create_salt(home):
    """`<home>/.mcp-session-salt` 32B 随机种子。mirror Rust `load_or_create_salt`."""
    path = Path(home) / SALT_FILE
    salt = _read_salt(path)
    if salt is not None:
        return salt
    salt = _random_salt()
    try:
        _write_salt(path, salt)
    except OSError as e:
        raise RuntimeError(f"create session salt ({path}): {e}") from e
    return salt


# ────────────────────────────────────────────────────────────────────────
# session_ref（HMAC-SHA256 截前 16 字节）+ 反解
# ────────────────────────────────────────────────────────────────────────

def session_ref(salt, session_key):
    """`sr_` + `hex(HMAC(salt, session_key)[..16])`。mirror Rust `session_ref`."""
    mac = _hmac_sha256(salt, session_key.encode("utf-8"))
    return "sr_" + "".join(f"{b:02x}" for b in mac[:16])


def resolve_session_key(salt, target_ref, candidate_keys):
    """候选 `session_key` 集里 HMAC 匹配 `target_ref` 的那个。"""
    for k in candidate_keys:
        if session_ref(salt, k) == target_ref:
            return k
    return None


# ────────────────────────────────────────────────────────────────────────
# Cursor 解析 / 生成（与 Rust `parse_cursor` / `make_cursor` 逐字段对账）
# ────────────────────────────────────────────────────────────────────────

def _parse_search_cursor(c):
    """`<total>:<key_len>:<key>` → (int, str) 或 None."""
    try:
        total_s, rest = c.split(":", 1)
        total = int(total_s)
        len_s, key = rest.split(":", 1)
        if len(key) != int(len_s):
            return None
        return (total, key)
    except (ValueError, AttributeError):
        return None


def _make_search_cursor(total, session_key):
    return f"{total}:{len(session_key)}:{session_key}"


def _parse_detail_cursor(c):
    """`<ts>:<fact_id_len>:<fact_id>` → (int, str) 或 None."""
    try:
        ts_s, rest = c.split(":", 1)
        ts = int(ts_s)
        len_s, fid = rest.split(":", 1)
        if len(fid) != int(len_s):
            return None
        return (ts, fid)
    except (ValueError, AttributeError):
        return None


def _make_detail_cursor(ts, fact_id):
    return f"{ts}:{len(fact_id)}:{fact_id}"


# ────────────────────────────────────────────────────────────────────────
# 错误形态（spec §11 + §6.4 envelope）—— 与 Rust `ToolError::to_json` +
# `error_envelope` 同形。
# ────────────────────────────────────────────────────────────────────────

def _tool_error_envelope(err_code, message):
    """错误路径 envelope（`tools/call` `isError:true` 时返回的形状）。"""
    return {
        "schema_version": ENVELOPE_SCHEMA_VERSION,
        "data_version": {
            "authority_schema": None,
            "query_semantics": QUERY_SEMANTICS,
        },
        "authority_state": "unavailable",
        "authority_revision": None,
        "generated_at": _ms_to_rfc3339_beijing(int(datetime.now(tz=timezone.utc).timestamp() * 1000)),
        "timezone": _system_timezone_name(),
        "coverage": {"status": "unavailable", "missing_harnesses": []},
        "freshness": {"last_successful_sync_at": None, "stale_harnesses": []},
        "warnings": [],
        "data": None,
        "error": {"code": err_code, "message": message},
    }


# ────────────────────────────────────────────────────────────────────────
# Authority DB —— sqlite3 直连 read-only。schema_version 在 `schema_meta`。
# ────────────────────────────────────────────────────────────────────────

def _authority_db_path(home):
    """`<home>/agent-vitals.sqlite3`（mirror Rust `default_authority_path`）。"""
    return Path(home) / "agent-vitals.sqlite3"


def _open_authority(home):
    """只读打开权威库。文件不存在 → `database_missing`；损坏 → `database_unreadable`;
    schema_version 太高 → `schema_too_new`；太低 → `schema_migration_required`."""
    path = _authority_db_path(home)
    if not path.exists():
        return None, _tool_error_envelope(
            "database_missing",
            "authority DB does not exist — run `agent-vitals sync-facts` first",
        )
    try:
        # 非 URI 形式打开（macOS system python 的 sqlite3 模块偶尔对
        # `file:...?mode=ro` URI + schema_meta 查询报 "unable to open database
        # file"——非 URI 形式对只读足够安全：READ 语义由本函数只走 SELECT 保证,
        # 不依赖 URI mode flag)
        conn = sqlite3.connect(str(path))
        conn.row_factory = sqlite3.Row
    except sqlite3.DatabaseError as e:
        return None, _tool_error_envelope(
            "database_unreadable",
            "authority DB is corrupt or not a SQLite file — run `agent-vitals data-status`, "
            "keep the file for diagnosis",
        )
    # schema_version 校验（mirror Rust `AuthorityError::OlderSchema`/`NewerSchema`）
    try:
        row = conn.execute(
            "SELECT value FROM schema_meta WHERE key='schema_version'"
        ).fetchone()
        supported = 2
        if row is None:
            conn.close()
            return None, _tool_error_envelope(
                "schema_migration_required",
                "authority schema is older than supported — run the matching product migration",
            )
        try:
            found = int(row["value"])
        except (ValueError, TypeError):
            conn.close()
            return None, _tool_error_envelope(
                "schema_migration_required",
                "authority schema version unreadable",
            )
        if found > supported:
            conn.close()
            return None, _tool_error_envelope(
                "schema_too_new",
                f"authority schema v{found} is newer than supported v{supported} — "
                "upgrade agent-vitals / the MCP client",
            )
        if found < supported:
            conn.close()
            return None, _tool_error_envelope(
                "schema_migration_required",
                f"authority schema v{found} is older than supported — run the matching product migration",
            )
    except sqlite3.DatabaseError:
        conn.close()
        return None, _tool_error_envelope(
            "database_unreadable",
            "authority DB is corrupt or not a SQLite file — run `agent-vitals data-status`, "
            "keep the file for diagnosis",
        )
    return conn, None


def _schema_version(conn):
    row = conn.execute(
        "SELECT value FROM schema_meta WHERE key='schema_version'"
    ).fetchone()
    if row is None:
        return 0
    try:
        return int(row["value"])
    except (ValueError, TypeError):
        return 0


def _authority_revision(conn, max_observed_ms):
    """spec §6.1 `authority_revision`：最后一次 succeeded run + max(event_ts_ms)。
    mirror Rust `authority_revision`."""
    last = None
    try:
        row = conn.execute(
            "SELECT run_id, COALESCE(completed_at_ms, started_at_ms) "
            "FROM sync_runs WHERE status='succeeded' "
            "ORDER BY COALESCE(completed_at_ms, started_at_ms) DESC LIMIT 1"
        ).fetchone()
        if row is not None:
            last = (row["run_id"], row[1])
    except sqlite3.DatabaseError:
        last = None

    max_obs = max_observed_ms
    if max_obs is None:
        try:
            row = conn.execute(
                "SELECT MAX(event_ts_ms) FROM usage_facts "
                "WHERE deleted_at_ms IS NULL AND observation_kind != 'legacy_aggregate'"
            ).fetchone()
            if row is not None and row[0] is not None:
                max_obs = row[0]
        except sqlite3.DatabaseError:
            max_obs = None

    if last is None:
        return None
    run_id, committed_ms = last
    return {
        "last_completed_run_id": run_id,
        "committed_at": _ms_to_rfc3339_beijing(committed_ms),
        "max_observed_at": _ms_to_rfc3339_beijing(max_obs),
    }


def _freshness(conn):
    last = None
    try:
        row = conn.execute(
            "SELECT MAX(COALESCE(completed_at_ms, started_at_ms)) "
            "FROM sync_runs WHERE status='succeeded'"
        ).fetchone()
        if row is not None and row[0] is not None:
            last = row[0]
    except sqlite3.DatabaseError:
        last = None
    return {
        "last_successful_sync_at": _ms_to_rfc3339_beijing(last),
        "stale_harnesses": [],
    }


def _authority_state(home):
    """SQL authority 是否启用（mirror Rust `sql_authority::is_enabled`）。
    Python 侧简化：`<home>/.sql-authority-enabled` 标记文件存在 → enabled,
    否则 → candidate。"""
    return "enabled" if (Path(home) / ".sql-authority-enabled").exists() else "candidate"


def _now_ms():
    return int(datetime.now(tz=timezone.utc).timestamp() * 1000)


def _build_envelope(conn, home, max_observed_ms, coverage, warnings, data):
    """spec §6 顶层 envelope（mirror Rust `build_envelope`）。"""
    return {
        "schema_version": ENVELOPE_SCHEMA_VERSION,
        "data_version": {
            "authority_schema": _schema_version(conn),
            "query_semantics": QUERY_SEMANTICS,
        },
        "authority_state": _authority_state(home),
        "authority_revision": _authority_revision(conn, max_observed_ms),
        "generated_at": _ms_to_rfc3339_beijing(_now_ms()),
        "timezone": _system_timezone_name(),
        "coverage": coverage,
        "freshness": _freshness(conn),
        "warnings": list(warnings),
        "data": data,
    }


def _coverage_not_applicable():
    return {"status": "not_applicable", "missing_harnesses": []}


def _check_as_of_run_id(conn, args, warnings):
    """spec §6.4.1 as_of_run_id 三态（mirror Rust `check_as_of_run_id`）。"""
    req = args.get("as_of_run_id")
    if not isinstance(req, str) or not req:
        return None
    row = conn.execute(
        "SELECT run_id FROM sync_runs WHERE status='succeeded' "
        "ORDER BY COALESCE(completed_at_ms, started_at_ms) DESC LIMIT 1"
    ).fetchone()
    if row is None:
        return _tool_error_envelope(
            "invalid_argument",
            f"as_of_run_id `{req}` requested but no successful sync run exists yet",
        )
    cur = row["run_id"]
    if cur == req:
        return None
    exists_row = conn.execute(
        "SELECT EXISTS(SELECT 1 FROM sync_runs WHERE run_id = ?)", (req,)
    ).fetchone()
    exists = bool(exists_row[0]) if exists_row is not None else False
    if exists:
        warnings.append({
            "code": "snapshot_drift",
            "message": (
                f"as_of_run_id={req} but current is {cur} — strict cross-tool "
                "consistency not yet enforced (M2)"
            ),
            "requested": req,
            "current": cur,
        })
        return None
    return _tool_error_envelope(
        "invalid_argument",
        f"as_of_run_id `{req}` is not present in this authority DB",
    )


# ────────────────────────────────────────────────────────────────────────
# 北京日 / 月窗口（mirror Rust `beijing_day_bounds_ms` / `beijing_month_bounds_ms`）
# ────────────────────────────────────────────────────────────────────────

def _parse_ymd(s):
    if not isinstance(s, str) or len(s) != 10 or s[4] != "-" or s[7] != "-":
        return None
    try:
        y = int(s[0:4]); m = int(s[5:7]); d = int(s[8:10])
    except ValueError:
        return None
    if not (1 <= m <= 12) or not (1 <= d <= 31):
        return None
    return (y, m, d)


def _beijing_midnight_ms(y, m, d):
    """OS statistics timezone midnight → UTC milliseconds.

    The compatibility name mirrors Rust's public function; the actual boundary
    is civil midnight in the system IANA timezone and therefore DST-aware.
    """
    try:
        local = datetime(int(y), int(m), int(d), tzinfo=_system_timezone())
        return int(local.timestamp() * 1000)
    except (ValueError, OverflowError, OSError):
        return None


def _days_to_utc_midnight_ms(y, m, d):
    """UTC civil date `y-m-d` → UTC 00:00 的 epoch 毫秒。Hinnant
    days-from-civil 反向。"""
    # days_from_civil(y, m, d) = (date - 1970-01-01) 天数；反向用 civil-from-
    # days 取回 epoch days 后转 ms。
    y = int(y); m = int(m); d = int(d)
    if m <= 2:
        y -= 1
        m += 9
    else:
        m -= 3
    # days_from_civil = 365*y + y//4 - y//100 + y//400 + (153*m + 2)//5 + d - 1
    # epoch days = days_from_civil - days_from_civil(1970, 1, 1)
    days = (365 * y + y // 4 - y // 100 + y // 400
            + (153 * m + 2) // 5 + d - 1
            - 719468)
    return days * 86_400_000


def beijing_day_bounds_ms(date_str):
    s = _parse_ymd(date_str)
    if s is None:
        return None
    y, m, d = s
    start = _beijing_midnight_ms(y, m, d)
    if start is None:
        return None
    next_day = date(y, m, d) + timedelta(days=1)
    end = _beijing_midnight_ms(next_day.year, next_day.month, next_day.day)
    return None if end is None else (start, end)


def beijing_month_bounds_ms(month_str):
    if not isinstance(month_str, str) or len(month_str) != 7 or month_str[4] != "-":
        return None
    try:
        y = int(month_str[0:4]); m = int(month_str[5:7])
    except ValueError:
        return None
    if not (1 <= m <= 12):
        return None
    start = _beijing_midnight_ms(y, m, 1)
    if start is None:
        return None
    if m == 12:
        ny, nm = y + 1, 1
    else:
        ny, nm = y, m + 1
    end = _beijing_midnight_ms(ny, nm, 1)
    if end is None:
        return None
    return (start, end)


# ────────────────────────────────────────────────────────────────────────
# 单 harness SQL：sessions_in_window + session_facts_timeline（mirror Rust SQL）
# ────────────────────────────────────────────────────────────────────────

_SQL_SESSIONS_IN_WINDOW = (
    "SELECT session_key, harness, "
    "MIN(event_ts_ms), MAX(event_ts_ms), COUNT(*), "
    "SUM(uncached_input_tokens), SUM(cache_read_tokens), "
    "SUM(cache_write_tokens), SUM(output_tokens), "
    "SUM(CASE WHEN event_peak != 0 THEN "
    "  (uncached_input_tokens + cache_read_tokens "
    "   + cache_write_tokens + output_tokens) ELSE 0 END), "
    "GROUP_CONCAT(DISTINCT COALESCE(model_id, '<unknown>')) "
    "FROM usage_facts "
    "WHERE harness = ?1 "
    "  AND observation_kind != 'legacy_aggregate' "
    "  AND deleted_at_ms IS NULL AND event_ts_ms IS NOT NULL "
    "  AND session_key IS NOT NULL "
    "  AND event_ts_ms >= ?2 AND event_ts_ms < ?3 "
    "  AND (?4 < 0 OR (CAST(strftime('%H', event_ts_ms / 1000, 'unixepoch', printf('%+d hours', (?5 / ?6))) AS INTEGER) = ?4)) "
    "GROUP BY session_key"
)

_SQL_SESSION_TIMELINE = (
    "SELECT fact_id, model_id, event_ts_ms, event_peak, "
    "uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, "
    "observation_kind "
    "FROM usage_facts "
    "WHERE session_key = ?1 "
    "  AND observation_kind != 'legacy_aggregate' "
    "  AND deleted_at_ms IS NULL AND event_ts_ms IS NOT NULL "
    "  AND (event_ts_ms, fact_id) > (?2, ?3) "
    "ORDER BY event_ts_ms, fact_id "
    "LIMIT ?4"
)

_SQL_SESSION_TOTAL_AGG = (
    "SELECT COALESCE(model_id, '<unknown>') AS model, event_ts_ms, "
    "uncached_input_tokens, cache_read_tokens, cache_write_tokens, output_tokens "
    "FROM usage_facts "
    "WHERE session_key = ?1 "
    "  AND observation_kind != 'legacy_aggregate' "
    "  AND deleted_at_ms IS NULL AND event_ts_ms IS NOT NULL"
)

_SQL_SESSION_ROW = (
    "SELECT harness, source_profile FROM sessions WHERE session_key = ?1"
)

_SQL_ALL_SESSION_KEYS = "SELECT session_key FROM sessions"

_SQL_SESSION_COST_BUCKETS = (
    "SELECT COALESCE(model_id, '<unknown>') AS model, event_peak, "
    "SUM(uncached_input_tokens), SUM(cache_read_tokens), "
    "SUM(cache_write_tokens), SUM(output_tokens), "
    "MAX(event_ts_ms) "
    "FROM usage_facts "
    "WHERE session_key = ?1 "
    "  AND observation_kind != 'legacy_aggregate' "
    "  AND deleted_at_ms IS NULL AND event_ts_ms IS NOT NULL "
    "GROUP BY model_id, event_peak"
)


def _all_session_keys(conn):
    """mirror Rust `all_session_keys` —— 用于 HMAC 反解 session_ref。"""
    return [r[0] for r in conn.execute(_SQL_ALL_SESSION_KEYS).fetchall()]


def _session_row(conn, session_key):
    """mirror Rust `session_row` → (harness, source_profile)。"""
    row = conn.execute(_SQL_SESSION_ROW, (session_key,)).fetchone()
    if row is None:
        return None
    return (row["harness"], row["source_profile"])


def _sessions_in_window(conn, start_ms, end_ms, harnesses, hour, min_tokens,
                        after_total, after_key, limit):
    """mirror Rust `sessions_in_window` → (rows, has_more, window_total)。"""
    wired = ["claude-code", "codex", "dsh"]
    selected = [w for w in wired if (not harnesses) or any(h == w for h in harnesses)]
    hour_param = -1 if hour is None else int(hour)

    all_rows = []
    for h in selected:
        cur = conn.execute(_SQL_SESSIONS_IN_WINDOW,
                           (h, start_ms, end_ms, hour_param, BEIJING_OFFSET_MS, HOUR_MS))
        for r in cur.fetchall():
            models_str = r[10] or ""
            models = [m.strip() for m in models_str.split(",") if m.strip()]
            all_rows.append({
                "session_key": r[0],
                "harness": r[1],
                "first_event_ms": r[2],
                "last_event_ms": r[3],
                "event_count": r[4],
                "uncached_input_tokens": r[5] or 0,
                "cache_read_tokens": r[6] or 0,
                "cache_write_tokens": r[7] or 0,
                "output_tokens": r[8] or 0,
                "peak_tokens": r[9] or 0,
                "model_ids": models,
            })

    def _total(row):
        return (row["uncached_input_tokens"] + row["cache_read_tokens"]
                + row["cache_write_tokens"] + row["output_tokens"])

    window_total = sum(_total(r) for r in all_rows)
    all_rows = [r for r in all_rows if _total(r) >= min_tokens]
    all_rows.sort(key=lambda r: (-_total(r), r["session_key"]))
    if after_total is not None and after_key is not None:
        all_rows = [r for r in all_rows
                    if _total(r) < after_total
                    or (_total(r) == after_total and r["session_key"] > after_key)]
    has_more = len(all_rows) > limit
    return (all_rows[:limit], has_more, window_total)


def _session_facts_timeline(conn, session_key, after_ts, after_fact_id, limit):
    """mirror Rust `session_facts_timeline` → (facts, has_more)。"""
    cur = conn.execute(_SQL_SESSION_TIMELINE, (
        session_key,
        after_ts if after_ts is not None else -(2**63),
        after_fact_id if after_fact_id is not None else "",
        limit + 1,
    ))
    rows = cur.fetchall()
    has_more = len(rows) > limit
    rows = rows[:limit]
    facts = []
    for r in rows:
        facts.append({
            "fact_id": r[0],
            "model_id": r[1],
            "event_ts_ms": r[2],
            "event_peak": bool(r[3]),
            "uncached_input_tokens": r[4] or 0,
            "cache_read_tokens": r[5] or 0,
            "cache_write_tokens": r[6] or 0,
            "output_tokens": r[7] or 0,
            "observation_kind": r[8],
        })
    return (facts, has_more)


def _session_total_agg(conn, session_key):
    """mirror Rust session_detail.rs:120-156 —— 全量 4 桶 + models + first/last。
    不受分页影响。"""
    cur = conn.execute(_SQL_SESSION_TOTAL_AGG, (session_key,))
    u = cr = cw = o = n = 0
    first = None
    last = None
    models = set()
    for r in cur.fetchall():
        m, ts, a, b, c, d = r[0], r[1], r[2] or 0, r[3] or 0, r[4] or 0, r[5] or 0
        models.add(m)
        n += 1
        u += a; cr += b; cw += c; o += d
        if first is None or ts < first:
            first = ts
        if last is None or ts > last:
            last = ts
    return {
        "uncached_input_tokens": u,
        "cache_read_tokens": cr,
        "cache_write_tokens": cw,
        "output_tokens": o,
        "total": u + cr + cw + o,
        "event_count": n,
        "model_ids": sorted(models),
        "first_event_ms": first,
        "last_event_ms": last,
    }


# ────────────────────────────────────────────────────────────────────────
# session_cost_minor（mirror Rust `session_cost_minor`）—— JOIN pricing_snapshots
# ────────────────────────────────────────────────────────────────────────

def _pyround(x, n):
    """银行家舍入（mirror Rust `agent_vitals_domain::util::pyround`）。"""
    return float(f"{x:.{n}f}")


def _session_cost_minor(conn, session_key):
    """usage_facts 8 桶 → 选历史价卡 → cost_report → MoneyMinor。
    返回 dict `{amount_minor, currency, basis}` 或 None（mirror Rust 同名）。"""
    cur = conn.execute(_SQL_SESSION_COST_BUCKETS, (session_key,))
    by_model = {}
    max_ts = 0
    for r in cur.fetchall():
        model, peak, u, cr, cw, o, ts = (
            r[0], r[1], r[2] or 0, r[3] or 0, r[4] or 0, r[5] or 0, r[6] or 0,
        )
        if model not in by_model:
            by_model[model] = {
                "u_off": 0, "cr_off": 0, "cw_off": 0, "o_off": 0,
                "u_peak": 0, "cr_peak": 0, "cw_peak": 0, "o_peak": 0,
            }
        if peak:
            by_model[model]["u_peak"] += u
            by_model[model]["cr_peak"] += cr
            by_model[model]["cw_peak"] += cw
            by_model[model]["o_peak"] += o
        else:
            by_model[model]["u_off"] += u
            by_model[model]["cr_off"] += cr
            by_model[model]["cw_off"] += cw
            by_model[model]["o_off"] += o
        if ts and ts > max_ts:
            max_ts = ts

    if not by_model or max_ts == 0:
        return None

    # 选历史价卡
    snap_row = conn.execute(
        "SELECT payload_json FROM pricing_snapshots "
        "WHERE captured_at_ms <= ?1 "
        "ORDER BY captured_at_ms DESC, pricing_version DESC LIMIT 1",
        (max_ts,),
    ).fetchone()
    if snap_row is None:
        return None
    try:
        snap_pricing = json.loads(snap_row[0])
    except (ValueError, TypeError):
        return None

    # 折成 by_model 形状
    by_model_json = {}
    for model, s in by_model.items():
        by_model_json[model] = {
            "uncached_input_tokens": s["u_off"] + s["u_peak"],
            "cache_read_tokens": s["cr_off"] + s["cr_peak"],
            "cache_write_tokens": s["cw_off"] + s["cw_peak"],
            "output_tokens": s["o_off"] + s["o_peak"],
            "peak_uncached_input_tokens": s["u_peak"],
            "peak_cache_read_tokens": s["cr_peak"],
            "peak_cache_write_tokens": s["cw_peak"],
            "peak_output_tokens": s["o_peak"],
        }
    usage = {"by_model": by_model_json}

    report = cost_report(usage, snap_pricing)
    if report is None:
        return None

    total = report.get("total", 0.0)
    if not math.isfinite(total) or total < 0.0:
        return None
    currency = report.get("currency") or "CNY"
    n = _CURRENCY_MINOR_DIGITS.get(currency.upper())
    if n is None:
        return None
    rounded = _pyround(total, n)
    amount_minor = int(round(rounded * (10 ** n)))
    return {
        "amount_minor": amount_minor,
        "currency": currency,
        "basis": "metered_estimate",
    }


# ────────────────────────────────────────────────────────────────────────
# sessions_search —— 与 Rust `mcp::sessions_search::run` byte-mirror
# ────────────────────────────────────────────────────────────────────────

def sessions_search(args, home):
    """`mcp::sessions_search` byte-mirror。`args` 是 dict（CLI argparse 的
    `--json` 输入或 Python API），home 是 `<data_home>` 路径。"""
    if not isinstance(args, dict):
        return _tool_error_envelope("invalid_argument", "args must be an object")

    # 1. date / month 二选一
    d = args.get("date"); m = args.get("month")
    if isinstance(d, str) and isinstance(m, str):
        return _tool_error_envelope(
            "invalid_argument", "exactly one of `date` / `month` is required",
        )
    if isinstance(d, str):
        bounds = beijing_day_bounds_ms(d)
        if bounds is None:
            return _tool_error_envelope(
                "invalid_argument", f"invalid `date`: {d}",
            )
        start_ms, end_ms = bounds
        window_label = d
        has_date = True
    elif isinstance(m, str):
        bounds = beijing_month_bounds_ms(m)
        if bounds is None:
            return _tool_error_envelope(
                "invalid_argument", f"invalid `month`: {m}",
            )
        start_ms, end_ms = bounds
        window_label = m
        has_date = False
    else:
        return _tool_error_envelope(
            "invalid_argument", "exactly one of `date` / `month` is required",
        )

    # 2. hour
    hour = None
    h = args.get("hour")
    if h is not None:
        if not isinstance(h, int) or h < 0 or h > 23:
            return _tool_error_envelope(
                "invalid_argument", "`hour` must be 0..=23",
            )
        if not has_date:
            return _tool_error_envelope(
                "invalid_argument", "`hour` requires `date` (not `month`)",
            )
        hour = h

    # 3. harnesses
    harnesses_arg = args.get("harnesses")
    harnesses = []
    if isinstance(harnesses_arg, list):
        harnesses = [h for h in harnesses_arg if isinstance(h, str)]

    min_tokens = args.get("min_tokens", 0)
    if not isinstance(min_tokens, int):
        min_tokens = 0

    limit = args.get("limit", DEFAULT_SEARCH_LIMIT)
    if not isinstance(limit, int):
        limit = DEFAULT_SEARCH_LIMIT
    limit = max(1, min(limit, MAX_SEARCH_LIMIT))

    cursor = args.get("cursor")
    after_total = after_key = None
    if isinstance(cursor, str) and cursor:
        parsed = _parse_search_cursor(cursor)
        if parsed is None:
            return _tool_error_envelope("invalid_argument", "malformed `cursor`")
        after_total, after_key = parsed

    conn, err = _open_authority(home)
    if err is not None:
        return err
    try:
        warnings = []
        asof_err = _check_as_of_run_id(conn, args, warnings)
        if asof_err is not None:
            return asof_err

        salt = load_or_create_salt(home)
        rows, has_more, window_total = _sessions_in_window(
            conn, start_ms, end_ms, harnesses, hour, min_tokens,
            after_total, after_key, limit,
        )

        if has_more:
            warnings.append({
                "code": "truncated",
                "message": "more sessions match than fit in one page — "
                           "data.sessions does NOT sum to window_total_tokens; "
                           "page with next_cursor",
            })

        def _total(r):
            return (r["uncached_input_tokens"] + r["cache_read_tokens"]
                    + r["cache_write_tokens"] + r["output_tokens"])

        max_ts = max((r["last_event_ms"] for r in rows), default=None)

        next_cursor = None
        if has_more and rows:
            last = rows[-1]
            next_cursor = _make_search_cursor(_total(last), last["session_key"])

        sessions_json = []
        for r in rows:
            cm = _session_cost_minor(conn, r["session_key"])
            sessions_json.append({
                "session_ref": session_ref(salt, r["session_key"]),
                "harness": r["harness"],
                "first_event_at": _ms_to_rfc3339_beijing(r["first_event_ms"]),
                "last_event_at": _ms_to_rfc3339_beijing(r["last_event_ms"]),
                "event_count": r["event_count"],
                "model_ids": r["model_ids"],
                "identity_kind": "harness_raw",
                "tokens": {
                    "uncached_input_tokens": r["uncached_input_tokens"],
                    "cache_read_tokens": r["cache_read_tokens"],
                    "cache_write_tokens": r["cache_write_tokens"],
                    "output_tokens": r["output_tokens"],
                    "total": _total(r),
                },
                "peak_tokens": r["peak_tokens"],
                "cost_minor": cm,
            })

        data = {
            "window": {
                "label": window_label,
                "hour": hour,
                "from": _ms_to_rfc3339_beijing(start_ms),
                "to": _ms_to_rfc3339_beijing(end_ms),
            },
            "sessions": sessions_json,
            "window_total_tokens": window_total,
            "has_more": has_more,
            "next_cursor": next_cursor,
        }
        coverage = {
            "status": "complete",
            "requested_from": _ms_to_rfc3339_beijing(start_ms),
            "requested_to": _ms_to_rfc3339_beijing(end_ms),
            "missing_harnesses": [],
        }
        return _build_envelope(conn, home, max_ts or end_ms, coverage, warnings, data)
    finally:
        conn.close()


# ────────────────────────────────────────────────────────────────────────
# session_detail —— 与 Rust `mcp::session_detail::run` byte-mirror
# ────────────────────────────────────────────────────────────────────────

def session_detail(args, home):
    """`mcp::session_detail` byte-mirror。"""
    if not isinstance(args, dict):
        return _tool_error_envelope("invalid_argument", "args must be an object")

    sref = args.get("session_ref")
    if not isinstance(sref, str) or not sref:
        return _tool_error_envelope(
            "invalid_argument", "`session_ref` is required",
        )

    limit = args.get("limit", DEFAULT_DETAIL_LIMIT)
    if not isinstance(limit, int):
        limit = DEFAULT_DETAIL_LIMIT
    limit = max(1, min(limit, MAX_DETAIL_LIMIT))

    cursor = args.get("cursor")
    after_ts = after_id = None
    if isinstance(cursor, str) and cursor:
        parsed = _parse_detail_cursor(cursor)
        if parsed is None:
            return _tool_error_envelope("invalid_argument", "malformed `cursor`")
        after_ts, after_id = parsed

    conn, err = _open_authority(home)
    if err is not None:
        return err
    try:
        warnings = []
        asof_err = _check_as_of_run_id(conn, args, warnings)
        if asof_err is not None:
            return asof_err

        salt = load_or_create_salt(home)
        keys = _all_session_keys(conn)
        skey = resolve_session_key(salt, sref, keys)
        if skey is None:
            return _tool_error_envelope(
                "invalid_argument",
                "unknown session_ref — it may be from a different machine, "
                "or the session was deleted, or the salt was rotated",
            )

        row = _session_row(conn, skey)
        if row is None:
            return _tool_error_envelope(
                "invalid_argument", "session_ref resolved but the session row is gone",
            )
        harness, _profile = row

        facts, has_more = _session_facts_timeline(conn, skey, after_ts, after_id, limit)
        agg = _session_total_agg(conn, skey)

        timeline = [{
            "event_at": _ms_to_rfc3339_beijing(f["event_ts_ms"]),
            "model_id": f["model_id"],
            "identity_kind": "harness_raw",
            "observation_kind": f["observation_kind"],
            "peak": f["event_peak"],
            "fact_id": f["fact_id"],
            "tokens": {
                "uncached_input_tokens": f["uncached_input_tokens"],
                "cache_read_tokens": f["cache_read_tokens"],
                "cache_write_tokens": f["cache_write_tokens"],
                "output_tokens": f["output_tokens"],
                "total": (f["uncached_input_tokens"] + f["cache_read_tokens"]
                          + f["cache_write_tokens"] + f["output_tokens"]),
            },
        } for f in facts]

        next_cursor = None
        if has_more and facts:
            last = facts[-1]
            next_cursor = _make_detail_cursor(last["event_ts_ms"], last["fact_id"])

        cm = _session_cost_minor(conn, skey)

        data = {
            "session_ref": sref,
            "harness": harness,
            "first_event_at": _ms_to_rfc3339_beijing(agg["first_event_ms"]),
            "last_event_at": _ms_to_rfc3339_beijing(agg["last_event_ms"]),
            "event_count": agg["event_count"],
            "model_ids": agg["model_ids"],
            "identity_kind": "harness_raw",
            "tokens": {
                "uncached_input_tokens": agg["uncached_input_tokens"],
                "cache_read_tokens": agg["cache_read_tokens"],
                "cache_write_tokens": agg["cache_write_tokens"],
                "output_tokens": agg["output_tokens"],
                "total": agg["total"],
            },
            "cost_minor": cm,
            "timeline": timeline,
            "has_more": has_more,
            "next_cursor": next_cursor,
            "note": "usage timeline only; fault/error events need workflow_events (M4)",
        }
        return _build_envelope(
            conn, home, agg["last_event_ms"], _coverage_not_applicable(), warnings, data,
        )
    finally:
        conn.close()


# ────────────────────────────────────────────────────────────────────────
# sessions_navigation —— Tauri 托盘今日 + recent 5 投影（mirror Rust
# `apps/cli/src/main.rs::SessionsAction::Navigation`）。
# ────────────────────────────────────────────────────────────────────────

def sessions_navigation(day, recent_n, home, timezone_name=None):
    """`sessions_navigation_v2` byte-mirror（Tauri 托盘 envelope）。"""
    with _timezone_scope(timezone_name) as valid:
        if timezone_name is not None and not valid:
            return _tool_error_envelope("invalid_argument", "invalid `timezone`")
        if not day:
            day = datetime.now(_system_timezone()).date().isoformat()
        conn, err = _open_authority(home)
        if err is not None:
            return err
        try:
            harnesses = []
            for harness in ("dsh", "codex", "claude-code"):
                today_tokens = _day_token_totals_by_harness_one(conn, day, harness)
                recent = _recent_for_harness(conn, home, day, recent_n, harness)
                sessions = _day_session_count(conn, day, harness)
                value = today_tokens.get("value") if isinstance(today_tokens, dict) else None
                status = "ready" if value is not None else "partial"
                harnesses.append({
                    "harness_kind": harness,
                    "status": status,
                    "today_tokens": today_tokens,
                    "today_sessions": sessions,
                    "recent": recent,
                    "store_revision": None,
                })
            return {
                "schema_version": 1,
                "day_key": day,
                "timezone": _system_timezone_name(),
                "generated_at": _now_iso_utc(),
                "harnesses": harnesses,
            }
        finally:
            conn.close()


def _day_token_totals_by_harness_one(conn, day, harness):
    """单 harness 今日 token 聚合（mirror Rust `day_token_totals_by_harness`
    的单 harness 切片）。值缺失 → `{value: null, basis: null, coverage: null}`."""
    bounds = beijing_day_bounds_ms(day)
    if bounds is None:
        return {"value": None, "basis": None, "coverage": None}
    start_ms, end_ms = bounds
    try:
        row = conn.execute(
            "SELECT SUM(uncached_input_tokens + cache_read_tokens + "
            "          cache_write_tokens + output_tokens) "
            "FROM usage_facts "
            "WHERE harness = ?1 "
            "  AND observation_kind != 'legacy_aggregate' "
            "  AND deleted_at_ms IS NULL AND event_ts_ms IS NOT NULL "
            "  AND event_ts_ms >= ?2 AND event_ts_ms < ?3",
            (harness, start_ms, end_ms),
        ).fetchone()
    except sqlite3.DatabaseError:
        return {"value": None, "basis": None, "coverage": None}
    v = row[0] if row is not None else None
    if v is None:
        return {"value": None, "basis": None, "coverage": None}
    return {"value": int(v), "basis": "sql-facts", "coverage": "complete"}


def _day_session_count(conn, day, harness):
    bounds = beijing_day_bounds_ms(day)
    if bounds is None:
        return 0
    start_ms, end_ms = bounds
    try:
        row = conn.execute(
            "SELECT COUNT(DISTINCT session_key) "
            "FROM usage_facts "
            "WHERE harness = ?1 "
            "  AND observation_kind != 'legacy_aggregate' "
            "  AND deleted_at_ms IS NULL AND event_ts_ms IS NOT NULL "
            "  AND event_ts_ms >= ?2 AND event_ts_ms < ?3",
            (harness, start_ms, end_ms),
        ).fetchone()
    except sqlite3.DatabaseError:
        return 0
    return int(row[0]) if row is not None and row[0] is not None else 0


def _recent_for_harness(conn, home, day, recent_n, harness):
    """mirror Rust `recent_for_harness`：单 harness 在 day 窗口内跑
    `sessions_search` 拿 sessions，按旧 envelope 形状重命名。"""
    try:
        env = sessions_search(
            {"date": day, "harnesses": [harness], "limit": recent_n}, home,
        )
    except Exception:
        return []
    sess = (env.get("data") or {}).get("sessions") or []
    out = []
    for s in sess:
        keys = s.get("model_ids") or []
        model = keys[0] if keys else None
        out.append({
            "session_key": s.get("session_ref"),
            "title": None,
            "model": model,
            "tokens_total": ((s.get("tokens") or {}).get("total")),
            "date_first": s.get("first_event_at"),
            "date_last": s.get("last_event_at"),
            "cost_minor": s.get("cost_minor"),
        })
    return out


def _now_iso_utc():
    """`generated_at` 字段——Rust 用 `state::now_iso_utc()`（UTC ISO8601
    含纳秒）。mirror 同样形状：python `datetime.utcnow().isoformat()+
    "Z"` + 毫秒精度。"""
    now = datetime.now(tz=timezone.utc)
    return (f"{now.year:04}-{now.month:02}-{now.day:02}"
            f"T{now.hour:02}:{now.minute:02}:{now.second:02}"
            f".{now.microsecond // 1000:03}Z")
