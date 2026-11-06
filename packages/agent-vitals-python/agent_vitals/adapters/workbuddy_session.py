"""WorkBuddy 会话读取器 —— 五段式流水线（locate → shape → extract → derive →
coverage）的"locate → shape → extract"三段，I/O 都在这里；"derive → coverage"在
`scripts/agent_vitals/agent/workbuddy_evidence.py`（与 Rust
`crates/agent-vitals-harnesses/src/harnesses/workbuddy/sessions/evidence.rs` 逐字节对齐），I/O 不进去。

与 Rust `src/agent/workbuddy_session.rs` 逐字节对齐——两条实现产出同一份字典，
`tests/test_cli_matrix.py::both()` 的差分靠这份一致把关（Rust 侧 sqlite 读用
rusqlite bundled，spec §1.4——这里是 Python stdlib `sqlite3`，同一份 fixture db
两边都要能读）。

一个 WorkBuddy 会话横跨**三个可 join 表面**（spec §2.1 的 4 表面里 traces 会话
匿名、不算 join 表面）：

- `workbuddy.db` 的 `sessions` 行（id/permission_mode/use_sandbox_cli/model/cwd/
  title/时间戳）——会话锚点；
- `session_usage` 行（session_id/used/size/credit_json）——执行环境自计费（spec §9，
  成本直接吃 credit_json，不长第四份价格拷贝）；
- `audit-log/*.jsonl` 里按 `sessionId` **字段**（不是文件名）分组的决策记录；
- `file-history/<sessionId>/` 的版本文件数（FileMutations 源）。

**降级铁律与 claude_session 同款**：db 文件缺失/损坏 → `(None, None)`（不可读绝不
编成 0 会话）；audit-log 目录缺失 → 空 dict（存在性探测）；一条坏 JSON 行 → 跳过
并记 degraded（坏行属于哪个 session 无法指认，不该编进任何会话）；会话无 audit-log
记录但 db 有行 → 真会话，照审（决策账本为空是诚实结果，不是不可读）。"""
import json
import math
import sqlite3
import time

from pathlib import Path

from ..paths import user_home

# epoch 秒（2000-01-01 起）的合法性下界。spec §6.2 rule 3 的窗口 =
# [2000-01-01T00:00:00Z, now+24h]。
_WB_TS_MIN_SECS = 946684800


def workbuddy_root(home=None):
    """`~/.workbuddy/`（真实语料实测位置；测试用 isolated_home_env 把 HOME 指到
    fixture root，根就是 `<root>/.workbuddy/`）。Rust 由 main.rs 解析
    `HOME`/`USERPROFILE` 传入同一路径。"""
    if home is None:
        home = user_home()
    return Path(home) / ".workbuddy"


def _val(rec, key, typ):
    """从一行 db 记录里按类型取一列；列不存在 / 类型不符 → None（缺列报缺——
    编个假类型出来反而会把覆盖计数喂错）。"""
    if not isinstance(rec, dict):
        return None
    value = rec.get(key)
    return value if isinstance(value, typ) else None


def read_workbuddy_db(root):
    """读 `workbuddy.db` 的 `sessions` / `session_usage` 两表 → `(sessions, usage)`，
    各自是 `{id → 行 dict}` / `{session_id → 行 dict}`。**`SELECT *` + 按列名取**——
    真实 schema 会漂移，硬编码列清单一漂就全灭；缺列由 `_val` 报 None。

    降级：db 文件缺失 → `(None, None)`；`sessions` 表读不出来（文件不是 sqlite /
    损坏 / 表被改名）→ 整个 db 不可信，`(None, None)`（**不是** `({}, {})`——空表
    是「确实 0 会话」的真测量，读不出来是「不知道」）；`sessions` 可读但
    `session_usage` 表读不出来 → `(sessions, {})`（usage 列缺，会话照审、成本
    Unavailable）。"""
    db_path = root / "workbuddy.db"
    if not db_path.is_file():
        return None, None
    try:
        conn = sqlite3.connect("file:%s?mode=ro" % db_path, uri=True, timeout=5.0)
    except (sqlite3.Error, OSError):
        return None, None
    try:
        sessions = _read_table(conn, "sessions", "id")
        if sessions is None:
            return None, None
        usage = _read_table(conn, "session_usage", "session_id")
        usage = usage if usage is not None else {}
        return sessions, usage
    finally:
        conn.close()


def read_workbuddy_source_snapshot(root):
    """WAL 快照标注（spec §10 B3，`WORKBUDDY_OBSERVABILITY_ASK.md` P0-1「若不做」
    降级路径）：`{journal_mode, db_bytes, wal_bytes}`，让读者看见"这是一次时点
    快照"而不是把它当成稳定通道。**防御性约束（spec §2 实测行）钉在这里**：绝不能
    把打开方式改成 `immutable=1`、也绝不能裸拷主库文件——WAL 模式下已提交数据大半
    在 `-wal` 文件里（真机 155KB 主库 vs 630KB WAL），`immutable=1` 会静默忽略
    WAL、读到上一次 checkpoint 的陈旧状态（真机实测因此少读到 1 个会话：22 vs
    23）；裸拷主库同理会撕裂或漏 WAL。现有 `mode=ro` 连接已参与 WAL、读到最新
    状态——这里另开一个同样只读的连接只为查 pragma，不改变、不影响主查询的打开
    方式。**不含 mtime**——fixture 上非确定，会破坏逐字节差分（spec 明令）。

    db 缺失/不可读 → None（与 `read_workbuddy_db` 的 `(None, None)` 同一降级
    纪律：不可读绝不编成一个假快照）。Rust 镜像
    `sources/mod.rs::read_workbuddy_source_snapshot`。"""
    db_path = root / "workbuddy.db"
    if not db_path.is_file():
        return None
    try:
        db_bytes = db_path.stat().st_size
        conn = sqlite3.connect("file:%s?mode=ro" % db_path, uri=True, timeout=5.0)
    except (sqlite3.Error, OSError):
        return None
    try:
        journal_mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
    except sqlite3.Error:
        return None
    finally:
        conn.close()
    wal_path = root / "workbuddy.db-wal"
    try:
        wal_bytes = wal_path.stat().st_size
    except OSError:
        wal_bytes = 0
    return {
        "journal_mode": journal_mode,
        "db_bytes": db_bytes,
        "wal_bytes": wal_bytes,
    }


# 2026-09-11 真机 `PRAGMA table_info(sessions)` 快照（30 列，按声明序）——
# **声明的已知列基线，不是规则**（spec §11 规则 16）：这份清单只钉「此刻观测到
# 什么」，列本身会随 WorkBuddy 版本迁移增删（`.workbuddy-sqlite-migrations/`
# 已有 11 个迁移文件，`sessions` 被加列 6 次）。漂移不落判定分支，只落
# `read_workbuddy_schema_probe` 的哨兵。Rust 镜像
# `sources/mod.rs::WB_KNOWN_SESSIONS_COLUMNS`，逐字节同序
# （`tests/test_regressions.py` 的 parity 测试钉住）。
WB_KNOWN_SESSIONS_COLUMNS = (
    "id", "cwd", "user_id", "title", "custom_title", "status", "created_at",
    "updated_at", "last_activity_at", "deleted_at", "is_playground",
    "source_mode", "is_background_automation", "mode", "model", "expert_id",
    "expert_locale", "expert_runtime_identity", "expert_marketplace",
    "permission_mode", "use_sandbox_cli", "project_id", "plugin_context_json",
    "last_user_prompt_expert_selection", "context_window", "buddy_snapshot_id",
    "buddy_binding_json", "thought_level", "addon_selection", "session_settings",
)

# 2026-09-11 真机 `PRAGMA table_info(session_usage)` 快照（5 列）——同上，声明
# 基线而非规则。Rust 镜像 `WB_KNOWN_SESSION_USAGE_COLUMNS`。
WB_KNOWN_SESSION_USAGE_COLUMNS = (
    "session_id", "used", "size", "updated_at", "credit_json",
)


def _table_exists(conn, table):
    """表是否存在——用 `sqlite_master` 查，不靠 `PRAGMA table_info` 的空结果集
    区分「表不存在」和「表存在但巧合 0 列」（sqlite 不允许 0 列表，所以后者不
    可能发生，但显式查存在性比依赖这条隐含约束更诚实）。"""
    row = conn.execute(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?",
        (table,)).fetchone()
    return bool(row and row[0])


def _live_columns(conn, table):
    """`PRAGMA table_info(<table>)` 的活列名，按声明序返回；表不存在 → None
    （显式用 `_table_exists` 判定，不靠空结果集猜）。"""
    if not _table_exists(conn, table):
        return None
    cur = conn.execute("PRAGMA table_info(%s)" % table)
    return [row[1] for row in cur.fetchall()]


def _table_drift(conn, table, known):
    """单表的漂移比对：`unknown` = 活列 − 已知（按活列出现序），`missing` =
    已知 − 活列（按已知清单序）。表不存在 → None（**不是** `{"unknown":[],
    "missing":known}`——缺席不是「全部已知列都漂移没了」，是「这张表读不到」，
    与 `read_workbuddy_source_snapshot` 的降级纪律同款）。"""
    live = _live_columns(conn, table)
    if live is None:
        return None
    live_set = set(live)
    known_set = set(known)
    unknown = [c for c in live if c not in known_set]
    missing = [k for k in known if k not in live_set]
    return {"unknown": unknown, "missing": missing}


def read_workbuddy_schema_probe(root):
    """双向 schema 哨兵（spec §10 B4，`WORKBUDDY_OBSERVABILITY_ASK.md` P0-2
    「若不做」降级路径）：`sessions`/`session_usage` 的活列集与
    `WB_KNOWN_{SESSIONS,SESSION_USAGE}_COLUMNS` 比对，`migrations_applied` 读
    `__workbuddy_drizzle_migrations` 行数——**测量，不是推断**（不解析迁移
    文件、不猜版本号）。db 不可读 → 整个 probe None（与
    `read_workbuddy_source_snapshot` 同一降级铁律）；单表缺失 → 该表条目 None
    （缺席不是「零漂移」）；迁移表缺失 → None。Rust 镜像
    `sources/mod.rs::read_workbuddy_schema_probe`。"""
    db_path = root / "workbuddy.db"
    if not db_path.is_file():
        return None
    try:
        conn = sqlite3.connect("file:%s?mode=ro" % db_path, uri=True, timeout=5.0)
    except (sqlite3.Error, OSError):
        return None
    try:
        migrations_applied = None
        if _table_exists(conn, "__workbuddy_drizzle_migrations"):
            row = conn.execute(
                "SELECT COUNT(*) FROM __workbuddy_drizzle_migrations").fetchone()
            migrations_applied = row[0] if row else None
        return {
            "migrations_applied": migrations_applied,
            "sessions": _table_drift(conn, "sessions", WB_KNOWN_SESSIONS_COLUMNS),
            "session_usage": _table_drift(
                conn, "session_usage", WB_KNOWN_SESSION_USAGE_COLUMNS),
        }
    except sqlite3.Error:
        return None
    finally:
        conn.close()


def _read_table(conn, table, key_col):
    """读一张表 → `{key_col → 行 dict}`；表缺失/读失败 → None（调用方决定是
    降级整库还是只降这一列）。"""
    try:
        cur = conn.execute("SELECT * FROM %s" % table)
    except sqlite3.Error:
        return None
    cols = [d[0] for d in cur.description]
    out = {}
    for row in cur.fetchall():
        rec = dict(zip(cols, row))
        key = rec.get(key_col)
        # 只收字符串键（Rust 侧读表收 String）。SQLite 的 int 主键（如
        # session_id 存成数字）会在这里被跳过——保留 int 键会让 `{key → 行}` 的
        # 字典两侧不同构（评审 P3-7：真实语料 session_id 恒字符串，边缘对齐）。
        if not isinstance(key, str):
            continue
        out[key] = rec
    return out


def read_workbuddy_audit_log(root):
    """读 `audit-log/*.jsonl`（顶层文件，不含 `spool/` 待落盘缓冲）→
    `(records_by_session, file_of, degraded)`：

    - `records_by_session`：`{sessionId → [记录 dict]}`——按 `sessionId` **字段**
      分组（spec §2.1：join 锚点是字段不是文件名；一个文件可能横跨多个会话）。
    - `file_of`：`{sessionId → 首个出现的文件路径}`（`--list`/`file` 字段用它指认
      主账本文件；多文件会话罕见，首文件够诚实）。
    - `degraded`：`[(path, n_or_reason), ...]`——坏 JSON 行 / 无 sessionId 的记录 /
      不可读文件（无法指认归属的账本缺口，记下来由组合层 surface，绝不吞掉）。

    记录跨文件拼接后交给 evidence 层按 `sequence` 排序（并发 spool 写的跳号
    由 sequence 救回来，spec §2.3）。"""
    audit_dir = root / "audit-log"
    records_by_session = {}
    file_of = {}
    degraded = []
    if not audit_dir.is_dir():
        return records_by_session, file_of, degraded
    for path in sorted(audit_dir.glob("*.jsonl"), key=str):
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            degraded.append((str(path), "unreadable"))
            continue
        bad = 0
        for line in text.split("\n"):
            if line.strip() == "":
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                bad += 1
                continue
            if not isinstance(rec, dict):
                bad += 1
                continue
            sid = rec.get("sessionId")
            if not isinstance(sid, str) or not sid:
                bad += 1
                continue
            if sid not in file_of:
                file_of[sid] = str(path)
            records_by_session.setdefault(sid, []).append(rec)
        if bad:
            degraded.append((str(path), "malformed: %d record(s) skipped" % bad))
    return records_by_session, file_of, degraded


def count_workbuddy_file_history(root, session_id):
    """`file-history/<sessionId>/` 下的文件数 = FileMutations 源（spec §3 Measured
    行：`<contentHash>@v<n>` 版本快照数）。目录缺失 → 0（无文件快照是诚实测量，
    不是不可读）。"""
    fh = root / "file-history" / session_id
    if not fh.is_dir():
        return 0
    return sum(1 for p in fh.iterdir() if p.is_file())


def workbuddy_session_meta(root, session_id, db_rec, db_usage):
    """把一个会话的跨表面数据组装成 evidence 层的 `session_meta`。db 行缺失 →
    相关列 None（audit-log 独苗会话照审，元数据降级）；`db_usage is None`（db 整库
    降级）→ used/credit_json None。`file_mutations` 永远有个 int（0 或真实计数）。"""
    # 时间戳列按 spec §6.2 归一：真机 created_at/updated_at 是 epoch-ms 整数，
    # `_val(..., str)` 会把它们读成 None（这就是 `--list` 日期列全空的根因）。
    now_secs = now_unix_secs()
    ts_created, _ = normalize_wb_ts(db_rec.get("created_at")
                                    if isinstance(db_rec, dict) else None, now_secs)
    ts_updated, _ = normalize_wb_ts(db_rec.get("updated_at")
                                    if isinstance(db_rec, dict) else None, now_secs)
    meta = {
        "permission_mode": _val(db_rec, "permission_mode", str),
        "use_sandbox_cli": _val(db_rec, "use_sandbox_cli", int),
        "model": _val(db_rec, "model", str),
        "cwd": _val(db_rec, "cwd", str),
        "title": _val(db_rec, "title", str),
        "created_at": ts_created,
        "updated_at": ts_updated,
        "used": None,
        "credit_json": None,
    }
    if db_usage is not None:
        usage = db_usage.get(session_id)
        if isinstance(usage, dict):
            meta["used"] = _val(usage, "used", int)
            cj = usage.get("credit_json")
            meta["credit_json"] = cj if isinstance(cj, str) else None
    meta["file_mutations"] = count_workbuddy_file_history(root, session_id)
    return meta


def now_unix_secs():
    """读时钟：当前 unix 秒。合法性窗口上界 = `now + 24h`（spec §6.2 rule 3）。
    Rust 镜像 `sources/mod.rs::now_unix_secs`。"""
    return int(time.time())


def _epoch_secs_to_iso(secs):
    """epoch 秒 → `YYYY-MM-DDTHH:MM:SSZ`（UTC，秒精度）。`time.gmtime` 是
    proleptic Gregorian，与 Rust 的 Hinnant `civil_from_unix_secs` 在合法窗口内
    （2000..now+24h）逐字节一致。"""
    t = time.gmtime(secs)
    return "%04d-%02d-%02dT%02d:%02d:%02dZ" % (
        t.tm_year, t.tm_mon, t.tm_mday, t.tm_hour, t.tm_min, t.tm_sec)


def normalize_wb_ts(value, now_secs):
    """WorkBuddy 时间戳归一（spec §6.2）——`audit-log.timestamp` /
    `sessions.created_at` / `updated_at` 三处同一规则。返回 `(iso_or_None,
    out_of_window)`：

    - **字符串** → 原样（走既有路径，不回归其他执行环境/旧形状），`out_of_window=False`。
    - **整数/浮点** → 按毫秒解释，归一成 `YYYY-MM-DDTHH:MM:SSZ`；落在
      `[2000-01-01T00:00:00Z, now+24h]` 之外 → `(None, True)`（报 null 且进 attempts）。
    - **其余类型（bool/null/object）/缺失** → `(None, False)`（报 null，不进 attempts）。

    曾经三处都只收字符串（`_is_iso_ts` / `Value::as_str`），真机三处却都是 13 位
    epoch-ms 整数（2026-09-10 实测），于是 `date_span` 恒 null、`--list` 日期列全空。
    **不做秒/毫秒位数嗅探**（spec §6.2 rule 5）：真机只观测到毫秒。

    Rust 镜像 `sources/mod.rs::normalize_wb_ts`，逐字节对齐。"""
    if isinstance(value, str):
        return value, False
    # bool 是 int 的子类——必须先短路（否则 True → 归一成 1970 年）。
    if isinstance(value, bool):
        return None, False
    if isinstance(value, int):
        secs = value // 1000
    elif isinstance(value, float):
        if not math.isfinite(value):
            return None, True
        secs = math.floor(value / 1000.0)
    else:
        return None, False
    if secs < _WB_TS_MIN_SECS or secs > now_secs + 86400:
        return None, True
    return _epoch_secs_to_iso(secs), False


def lifecycle_of(db_rec):
    """spec §10 B5（`WORKBUDDY_OBSERVABILITY_ASK.md` P0-3「若不做」降级路径）：
    `status`/`source_mode`/`is_playground`/`deleted_at`/`is_background_automation`
    按列名原样浮出，**只浮出不过滤**——语义执行环境未声明，过滤是消费方的事（哪怕
    按字面值过滤，如排除 `is_playground=1`，本身也是一次未经执行环境声明语义的
    推断，spec 选择不做）。db 行整体缺失（audit-log 独苗会话）→ None（不是全
    null 对象——没有行就没有生命周期状态可言）；行存在但某列缺失/NULL/类型不符
    → 该字段 None（与 `_val` 同款缺列报缺纪律）。`is_playground`/
    `is_background_automation` 保持执行环境存的 INTEGER（不转 bool——转型是解读）；
    `status`/`source_mode` 是 TEXT，原样字符串；`deleted_at` 是 INTEGER
    epoch-ms，走与 A2 `created_at`/`updated_at` 同一条 `normalize_wb_ts` 路径。

    Rust 镜像 `sources/mod.rs::lifecycle_of`，逐字节对齐；键序固定
    `{status, source_mode, is_playground, deleted_at, is_background_automation}`。"""
    if not isinstance(db_rec, dict):
        return None
    now_secs = now_unix_secs()
    deleted_at, _ = normalize_wb_ts(db_rec.get("deleted_at"), now_secs)
    return {
        "status": _val(db_rec, "status", str),
        "source_mode": _val(db_rec, "source_mode", str),
        "is_playground": _val(db_rec, "is_playground", int),
        "deleted_at": deleted_at,
        "is_background_automation": _val(db_rec, "is_background_automation", int),
    }


def date_span_of(records, meta):
    """会话活动时间跨度：audit-log 记录 timestamp 的 min/max（跨文件全取，归一后
    ISO 串字典序 = 时间序）；无记录 → db 行 created_at/updated_at 兜底（已在
    `workbuddy_session_meta` 归一）。都没有 → None。"""
    now_secs = now_unix_secs()
    stamps = []
    for r in records:
        if not isinstance(r, dict):
            continue
        iso, _ = normalize_wb_ts(r.get("timestamp"), now_secs)
        if iso is not None:
            stamps.append(iso)
    if stamps:
        return {"first": min(stamps), "last": max(stamps)}
    first = meta.get("created_at")
    last = meta.get("updated_at")
    if first is None and last is None:
        return {"first": None, "last": None}
    return {"first": first, "last": last}
