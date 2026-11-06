"""状态文件 I/O —— xbar / 日历 / 预算告警的共享持久层。

四个状态文件，四种写入语义：

  oneline.json      单次审计的「最后一行」快照。xbar / SwiftBar tick 脚本
                    每 5 分钟跑一次 `behavior <log>`，把结果原地覆盖到这里。
                    不是历史，是**当前**。多个客户端（tray、CLI）都从这里
                    读，避免各自重算 cost / peak —— 重算两份就两份可能
                    不一致（见 cost.py 的 peak/off-peak 计价分支）。

  today.json        当日 24 小时桶的累计聚合。每次审计**合并**到对应的小
                    时桶（同一小时多次会话累加），而不是覆盖 —— 日历要看
                    的是「今天到目前为止」，不是「最近一次会话」。

  month.json        **只保存当前自然月**逐日聚合（YYYY-MM-DD → 4+4 token
                    桶 + 可选 by_model）。`merge_month` 每次调用先把不属于
                    当前月的日子迁进 month-archive.json（见下），再落新
                    数据——这是 2026-08 那次「本月成本」在跨月后悄悄变成
                    「有史以来成本」的事故修复，见 `merge_month` 文档注释。

  month-archive.json 跨月归档，`{"months": {"YYYY-MM": {"days": {...}}}}`。
                    读写不直接碰这个文件——用 `read_month(month=None)` 查
                    （当前月读 month.json，历史月读这里）、`list_months()`
                    列出有数据的月份、`_archive_days()`/`merge_month` 写。
                    逐日**替换**而不是累加（迁移幂等），但对已归档月份的
                    **回填**是累加（新证据不能覆盖已有数据）——两条路径的
                    区别见 `merge_month` 与 `_archive_days` 各自的注释。

四件事共用同一把锁：POSIX 用 `flock`，Windows 用 `msvcrt.locking`，锁文件在 `<state_dir>/.lock`。POSIX rename
原子，所以「写 tmp → rename」不需要锁保护；锁是给「read-modify-write」
合并场景防两个并发审计互相覆盖的。

CLAUDE.md 不变量：「**no telemetry · no upload · no network**」——
所有 I/O 都在 `paths.data_home()` 选的兼容数据目录下，不连任何外部服务；
xbar tick 是本地脚本，日历是本地 HTML。
"""

import contextlib
import errno
import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .. import paths

if sys.platform != "win32":
    import fcntl


SCHEMA_VERSION = "1.0.0"


def _system_timezone():
    """Resolve the OS IANA timezone used by statistics date buckets."""
    configured = ""
    try:
        preference = paths.data_home() / "state" / "statistics-timezone.json"
        value = json.loads(preference.read_text(encoding="utf-8"))
        configured = value.get("timezone", "") if isinstance(value, dict) else ""
    except (OSError, json.JSONDecodeError):
        configured = ""
    if not isinstance(configured, str):
        configured = ""
    configured = configured.lstrip(":") or os.environ.get("TZ", "").lstrip(":")
    candidates = [configured] if configured else []
    try:
        localtime = os.path.realpath("/etc/localtime")
        marker = "/zoneinfo/"
        if marker in localtime:
            candidates.append(localtime.split(marker, 1)[1])
    except OSError:
        pass
    for name in candidates:
        try:
            return ZoneInfo(name)
        except (ValueError, ZoneInfoNotFoundError):
            continue
    return datetime.now().astimezone().tzinfo or timezone.utc


def state_dir() -> Path:
    """状态目录路径 —— 用 `paths.data_home()` 的统一兼容选择。

    路径选择与 snapshots.py 同款（CLAUDE.md §Local First）：
    所有 agent-vitals 写出的产物都进数据根目录（`$AGENT_VITALS_HOME`，
    或 legacy `$SKILL_VITALS_HOME` / `~/.skill-vitals`），不进当前目录、
    不进 `/tmp`、不进任何被 git 跟踪的位置。
    """
    p = paths.data_home() / "state"
    try:
        p.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        # 权限 / 只读文件系统 —— 让调用方决定要不要硬崩而不是这里静默
        raise OSError(f"cannot create state dir {p}: {e}") from e
    return p


def cache_dir() -> Path:
    """派生缓存目录 —— 用 `paths.data_home()` 的统一兼容选择。

    与 `state_dir()` 同基目录但独立子目录：这里放**可重建的派生 memo**
    （如 codex 折叠快照，`codex_fold_merged` 整折叠缓存），不放用户可读的
    M3 状态。state 目录的读者（`list_state_files`/`list_months`/doctor）不该
    被缓存文件污染，所以两者严格分开；缓存坏了/被删 = 重建一次，绝不参与
    正确性（codex 侧无状态、无跨调用累计的约束不因缓存改变——缓存是纯函数
    的 memo，命中与否输出逐字节相同）。
    """
    p = paths.data_home() / "cache"
    try:
        p.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        # 权限 / 只读文件系统 —— 缓存是性能优化不是正确性依赖，让调用方
        # 决定要不要降级（codex_fold_merged 会捕获并直接重扫）。
        raise OSError(f"cannot create cache dir {p}: {e}") from e
    return p


@contextlib.contextmanager
def _locked_fd(fd):
    """Lock one byte on Windows or flock the descriptor on POSIX."""
    if sys.platform == "win32":
        import msvcrt
        os.lseek(fd, 0, os.SEEK_SET)
        msvcrt.locking(fd, msvcrt.LK_LOCK, 1)
        try:
            yield
        finally:
            os.lseek(fd, 0, os.SEEK_SET)
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
        return

    fcntl.flock(fd, fcntl.LOCK_EX)
    try:
        yield
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)


@contextlib.contextmanager
def _locked(path: Path):
    """Platform file lock guards read-modify-write.

    Locks are advisory on both platforms. POSIX uses flock; Windows locks
    the first byte with msvcrt. Writers must use this helper to avoid lost
    updates; unrelated readers can still read the file without taking a lock.
    """
    lock_path = path.with_suffix(path.suffix + ".lock")
    fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR, 0o600)
    try:
        with _locked_fd(fd):
            yield
    finally:
        os.close(fd)


def _atomic_write(path: Path, data: dict) -> None:
    """写入 `<file>.tmp.<pid>` → `rename(path)`。POSIX rename 在同一文件
    系统内是原子操作 —— 任何时刻读 `<file>` 要么看到旧版、要么看到新版，
    不会看到半截。

    失败时清理 tmp 文件，避免 `.tmp.*` 残留塞满 state 目录。
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_fd, tmp_path = tempfile.mkstemp(
        prefix=path.name + ".tmp.", dir=str(path.parent))
    try:
        with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2,
                      sort_keys=True, default=str)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, path)  # atomic on POSIX, replace on Windows
    except Exception:
        # 出错清理 tmp —— 不要留垃圾在 state 目录里
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def _read(path: Path):
    """读 state 文件，缺 / 坏掉返回 None。

    与 CLAUDE.md 「缺列不编列」同条纪律：state 文件损坏宁可**丢一份**
    历史也不要拼一个错的桶。xbar 会拿 None 当作「没有最新数据」并
    显示空菜单栏，而不是显示一个凭空算的 ¥0。
    """
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def _now_iso():
    """UTC ISO8601 字符串。状态文件里的时间戳统一 UTC，渲染层按需
    折算 —— 与 cost_report 同一条原则：规则唯一真相源、时间显示归
    渲染层。
    """
    return datetime.now(timezone.utc).isoformat()


# ────────────────────────── oneline.json ──────────────────────────


def write_oneline(audit: dict) -> Path:
    """把单次审计的「一行摘要」写到 oneline.json —— xbar tick 直接读。

    `audit` 是 `behavior.audit_session_log` 的产物（或行为审计子集
    + cost 子集），至少含：
      - session_id / session_start / duration_ms
      - tokens_total / tokens_peak（来自 token_by_model）
      - cost_cny / cost_peak_cny（来自 cost_report）
      - findings_total / findings_max_severity（来自 behavior）
      - hour_buckets_summary（来自 hour_buckets 的元信息）
    """
    path = state_dir() / "oneline.json"
    data = dict(audit)
    data["schema_version"] = SCHEMA_VERSION
    data["generated_at"] = _now_iso()
    _atomic_write(path, data)
    return path


def read_oneline():
    return _read(state_dir() / "oneline.json")


# ────────────────────────── alert.json ──────────────────────────


def write_alert(alert: dict) -> Path:
    """把 `budget.evaluate()` 的结果写到 alert.json —— xbar tick 直接读。

    在这之前 xbar 完全不知道 `budget.py` 的存在：菜单栏自己在 bash 里硬编码
    `BUDGET_DAILY_CNY=30` / `BUDGET_MONTHLY_CNY=500` 重新算一遍百分比，用户
    通过 `budget set --daily 50` 改的配置、adaptive floor、snooze、
    peak_share_max 反博弈——一条都不会反映到菜单栏上（`budget show` 里全对，
    菜单栏上全错）。写这份文件让 oneline 触发时顺手把**同一个**
    `budget.evaluate()` 结果落盘，xbar 变成纯只读消费者，不用重新实现一遍
    阈值 / 自适应 / snooze 逻辑（也不需要知道 repo 装在哪里去 shell 出
    python——它只读 state 文件）。

    调用时机：与 oneline.json 一样，`oneline` 命令末尾（见 cli.py）。
    """
    path = state_dir() / "alert.json"
    data = dict(alert)
    data["schema_version"] = SCHEMA_VERSION
    data["generated_at"] = _now_iso()
    _atomic_write(path, data)
    return path


# ────────────────────────── today.json / month.json ──────────────


def _today_key(time_ms=None):
    """系统统计时区的 'YYYY-MM-DD'。"""
    zone = _system_timezone()
    if time_ms is None:
        return datetime.now(zone).date().isoformat()
    return datetime.fromtimestamp(int(time_ms) / 1000, tz=zone).date().isoformat()


def _month_key(date_str=None):
    """系统统计时区的 'YYYY-MM'。`date_str` 为 'YYYY-MM-DD' 时取它的月份,否则用今天。

    **当前月一律按真实时间算,不读 `month.json` 的 `month` 字段**——那个字段
    是写入时刻盖的戳,跨月之后它和 `days` 里的实际内容本来就会不一致
    （真实事故：9 月的 month.json 里还留着 8 月的日子,`month` 却写着
    "2026-09",按它过滤等于什么都没过滤）。
    """
    if date_str:
        return str(date_str)[:7]
    return datetime.now(_system_timezone()).date().isoformat()[:7]


def archive_path() -> Path:
    """跨月归档文件。

    形状是 `{"2026-08": {"days": {...}, "archived_at": ...}, ...}` 而不是
    JSONL：归档要能**按月合并**（同一个月可能分几次落进来——先跨月迁移一
    批,之后又回填一批历史日志),append-only 的 JSONL 要么重复累加要么得
    在读侧做 last-wins 折叠,两种都比一个按月键的 dict 更容易出错。体积上
    也不需要 JSONL：一年 12 个月 × 31 天 ≈ 75KB,永远不会大到要流式读。
    """
    return state_dir() / "month-archive.json"


def _archive_days(days_by_date):
    """把若干「日桶」写进归档,**逐日替换**而不是累加。在调用方的锁内调用。

    为什么是替换：`month.json` 里某一天的记录**就是那一天的完整累计**
    （`merge_month` 一直往里加）。把它搬进归档时替换掉归档里的同一天,
    这个操作是**幂等**的——写完归档、还没来得及从 month.json 删掉就崩溃,
    下次重跑得到完全一样的结果,不会把那天算两遍。累加则不幂等,崩一次就
    多算一次（这正是 `rotate_today` 曾经犯的错,见那边的注释）。

    代价：调用方必须保证同一天**只存在于一个文件里**——`merge_month` 通过
    「先迁移旧月、再落新数据」的顺序保证这一点,见那边的注释。
    """
    if not days_by_date:
        return
    p = archive_path()
    archive = _read(p) or {}
    months = archive.setdefault("months", {})
    for date_str, day in days_by_date.items():
        entry = months.setdefault(_month_key(date_str), {"days": {}})
        entry["days"][date_str] = day        # 逐日替换 —— 幂等
        entry["archived_at"] = _now_iso()
    archive["schema_version"] = SCHEMA_VERSION
    _atomic_write(p, archive)


def read_month(month=None):
    """读某一个自然月的 `{"month": "YYYY-MM", "days": {...}}`。

    `month=None` → 当前真实月（读 `month.json`）；历史月读归档。
    月份不存在时返回 `None` —— 与「缺列不编列」一致,不返回一个空壳让
    调用方误以为"那个月花了 0 元"。
    """
    target = month or _month_key()
    if target == _month_key():
        data = _read(state_dir() / "month.json") or {}
        days = {d: b for d, b in (data.get("days") or {}).items()
                if _month_key(d) == target}
        return {"month": target, "days": days} if days else None
    archive = _read(archive_path()) or {}
    entry = (archive.get("months") or {}).get(target)
    return {"month": target, "days": entry["days"]} if entry and entry.get("days") else None


def list_months():
    """有数据的自然月,升序。当前月 + 归档里的所有月份。"""
    months = set((_read(archive_path()) or {}).get("months") or {})
    for d in (_read(state_dir() / "month.json") or {}).get("days") or {}:
        months.add(_month_key(d))
    return sorted(months)


def _merge_buckets(existing, new_buckets, key_field):
    """把 new_buckets 折进 existing[key_field] → 8 token 字段。

    现有桶的 schema 与 hour_buckets() 单条 row 完全一致（4 基础 + 4
    peak_* 字段），逐字段相加。key_field 是「日期字段名」（today 用
    'hour'，month 用 'date'）—— 同一小时内多次审计累加；不同小时
    各自独立桶。
    """
    if existing is None:
        existing = {}
    for nb in new_buckets:
        if nb.get("date") is None:
            continue  # time 缺失的样本不入日历
        k = str(nb.get(key_field))
        cur = existing.setdefault(k, {
            "uncached_input_tokens": 0, "output_tokens": 0,
            "cache_read_tokens": 0, "cache_write_tokens": 0,
            "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
            "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0,
        })
        for fld in ("uncached_input_tokens", "output_tokens",
                    "cache_read_tokens", "cache_write_tokens",
                    "peak_uncached_input_tokens", "peak_output_tokens",
                    "peak_cache_read_tokens", "peak_cache_write_tokens"):
            cur[fld] = cur.get(fld, 0) + (nb.get(fld) or 0)
    return existing


def _merge_model_buckets(existing, by_model):
    """把 `token_by_model()` 的 `by_model` 折进 existing,按模型名累加 8 字段。

    不能复用 `_merge_buckets` —— 那边 `nb.get("date") is None` 的跳过逻辑
    是给 hour_buckets 行(缺时间戳的样本不进日历)准备的;按模型的行根本
    没有 `date` 字段,套用会把每一行都当成"时间缺失"整批跳过。
    """
    if existing is None:
        existing = {}
    for model, b in (by_model or {}).items():
        cur = existing.setdefault(str(model), {
            "uncached_input_tokens": 0, "output_tokens": 0,
            "cache_read_tokens": 0, "cache_write_tokens": 0,
            "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
            "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0,
        })
        for fld in ("uncached_input_tokens", "output_tokens",
                    "cache_read_tokens", "cache_write_tokens",
                    "peak_uncached_input_tokens", "peak_output_tokens",
                    "peak_cache_read_tokens", "peak_cache_write_tokens"):
            cur[fld] = cur.get(fld, 0) + (b.get(fld) or 0)
    return existing


def _merge_source_into_day(day, source, models):
    """把 per-source 拆账的 `{source: {model: 八桶}}` 折进 day（`merge_month` 的
    当前月与历史月回填两处都调它）。

    与 Rust `state.rs::merge_source_into_day` 同构：`_merge_buckets` 只读 8 个
    token 字段、不碰 by_model 也不碰 by_source，所以 by_source 要像 by_model
    一样在 `_merge_buckets` 之外单独折。同一来源喂第二次是**累加**（同一批被
    喂了两次时，诊断靠的是两个来源**键并存**、各来源行是各自的量），不是覆盖。
    """
    prev = (day.get("by_source") or {}).get(source)
    day.setdefault("by_source", {})[source] = _merge_model_buckets(prev, models)


def rollup_by_source(month_json):
    """把 month.json 的**逐日** by_source（`days[date]["by_source"] =
    {source: {model: 八桶}}`）折平成 `{source: {model: 八桶}}`——给
    `state by-source` / 日历按来源合计用。

    逐日结构在 month.json 里是对的（按天归位、随天一起归档），但「本月各来源
    各自贡献多少」需要在展示侧按天折平；不折平的话，诊断「同一批被喂了几次」
    就要肉眼跨所有天求和。
    """
    out = {}
    for day in (month_json.get("days") or {}).values():
        for source, models in (day.get("by_source") or {}).items():
            src = out.setdefault(source, {})
            for model, b in models.items():
                cur = src.setdefault(model, {
                    "uncached_input_tokens": 0, "output_tokens": 0,
                    "cache_read_tokens": 0, "cache_write_tokens": 0,
                    "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
                    "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0,
                })
                for fld in ("uncached_input_tokens", "output_tokens",
                            "cache_read_tokens", "cache_write_tokens",
                            "peak_uncached_input_tokens", "peak_output_tokens",
                            "peak_cache_read_tokens", "peak_cache_write_tokens"):
                    cur[fld] = cur.get(fld, 0) + (b.get(fld) or 0)
    return out


def rollup_by_model(month_json):
    """把 month.json 的**逐日** by_model（`days[date]["by_model"] = {model: 八桶}`）
    折平成 `{model: 八桶}`——v0.7 spec §3「按 provider/model 月成本」视图的输入：
    零新数据、零新持久化，纯粹把已有的逐日 by_model 折平成月度粒度再喂给既有
    `cost.cost_report`。与 `rollup_by_source` 同一折法，只是不带 source 那层键
    ——直接复用 `_merge_model_buckets` 而不是手写循环。

    Rust 平行实现见 `state.rs::rollup_by_model`。
    """
    out = {}
    for day in (month_json.get("days") or {}).values():
        out = _merge_model_buckets(out, day.get("by_model") or {})
    return out


def rotate_today(now=None):
    """如果 today.json 的 date 字段 != 当前 BJ 日期,**清空** today.json。

    这是修 #1 误报的关键 — 不 rotate 的话,38 个 session 的累积
    数据会一直被当成「今天」算 cost,显示 ¥1172/¥30 = 3908% 这种
    假告警。

    调用时机: 每次 merge_today 开头先调一次 rotate_today(now),
    跨 BJ 0:00 时自动滚动。now=None → 用当前系统时间。

    **旧数据不在这里搬进 month.json——那会重复计数。** 这里曾经调
    `_move_today_to_month()` 把旧桶累加进 `month.days[<old_date>]`，
    注释说「与 merge_month 的逻辑对称」；但唯一的生产调用方
    （`cli.py` 的 oneline）对同一份 hour_buckets **同时**调
    `merge_today` 和 `merge_month`，而 `merge_month` 已经按每个桶
    自带的 `date` 字段把它们记进 month.json 了。于是每跨一天，
    昨天的量就被再加一遍——实测 2026-08 的 month.json 每一天都正好
    是真实值的 3 倍（rotate 一遍 + merge_month 一遍 + 额外手跑
    oneline 一遍），月度成本因此从 ¥1733 虚增到 ¥2386。

    旧测试没发现是因为它们都直接手写 today.json、month.json 是空的，
    重复相加看起来就等于正确值；真实路径下 month.json 里**已经有**
    同一批数据。

    **不变量：month.json 里每个 token 只能被记一次，归属它自己的
    日期，由 `merge_month` 独家负责。** rotate 只做「把 today.json
    这个当日累加器清零，换上新日期」这一件事。

    跨月不特殊处理 — month.json.days 已累积所有历史日,跨月不
    切分(年视图需要的话再加 month-archive.jsonl)。这是 spec 没
    明确的小决策点,见 M8 评估说明。
    """
    path = state_dir() / "today.json"
    # `now` 三种输入:None → 当前系统时间;str → 已是 'YYYY-MM-DD',直接用;
    # datetime → _to_bj_date() 折算成 date 对象再 isoformat()。之前误把
    # `.isoformat()` 套在整个三元表达式外层,str 分支下对字符串调
    # `.isoformat()` 会直接 AttributeError——测试只喂过 datetime,没测到。
    if now is None:
        today_bj = _today_key()
    elif isinstance(now, str):
        today_bj = now
    else:
        today_bj = _to_bj_date(now).isoformat()
    with _locked(path):
        existing = _read(path) or {}
        old_date = existing.get("date")
        if old_date and old_date != today_bj:
            # **不搬进 month.json**——merge_month 已经按各桶自己的 date
            # 记过一遍了，再搬一次就是重复计数（见本函数文档注释里的
            # 3 倍虚增实测）。这里只清空当日累加器。
            # 清空 today.json,留下 schema_version 和新 date
            existing = {
                "schema_version": SCHEMA_VERSION,
                "date": today_bj,
                "buckets": {},
                "generated_at": _now_iso(),
                "rotated_from": old_date,  # 留个 audit 痕迹
            }
            _atomic_write(path, existing)
            return old_date  # 告诉调用方发生过 rotate
    return None


def _to_bj_date(dt):
    """datetime → 系统统计时区 ISO date (YYYY-MM-DD)。接受 datetime 或 None。"""
    from datetime import datetime as _dt
    if isinstance(dt, str):
        # ISO 字符串直接取前 10 位
        return dt[:10]
    return datetime.fromtimestamp(dt.timestamp(), tz=_system_timezone()).date()


def merge_today(hour_buckets_result, by_model=None) -> Path:
    """把 hour_buckets 里**属于今天**的 (date, hour) 桶合并到 today.json。

    锁住同一 `<state_dir>/.lock`，read-modify-write 期间不让其他
    tick 进来 —— 否则两个并发审计可能各读一份、各写一份，后者覆盖
    前者的累加。

    **跨日自动 rotate** — 调用 rotate_today() 先处理跨日累积。
    这是修「¥1172/¥30 = 3908% 假告警」的关键。

    **必须按 date 过滤，不能只按 hour 折叠**——`_merge_buckets(...,
    key_field="hour")` 完全不看 `date` 字段，只看几点。一次 oneline 审计
    的是任意一份日志（`dsh_autosync.py` 的 skip 提示明确建议"回填历史
    日志用 oneline"），如果那份日志的事件恰好落在 21、22 点，不管是哪
    一天的 21、22 点，都会被塞进 today.json 的 21/22 点格子——真机复现：
    北京时间 15:10 查看日历，"今天 24 小时"热力图里却有 21 点、22 点的
    数据，物理上不可能（一天还没过完）。这里先把不属于今天的桶滤掉，
    今天.json 就只剩下真的发生在今天的小时。

    `by_model`(可选)累加进 `today.json["by_model"]` —— 与 (date, hour) 桶是
    **并列的新字段**,不是替换,budget.py 按模型精确定价时读它,旧的
    (date, hour) 桶继续只服务日历热力图,互不影响。

    **调用方必须传"已经按今天切好片"的那一份**，也就是
    `usage.token_by_date_model(events)[今天]`，而不是整段
    `token_by_model(events)["by_model"]`。真机复现过后者的后果：一个跨
    08-23/08-26/08-27 三天的长会话（中途 compact）被审计后，hour 桶被这
    里正确过滤成只剩今天的 245,760 token，而整段 by_model 是
    17,596,160——同一个 today.json 里两个字段差 70 倍，「今日估算成本」
    （读 by_model）于是报出整段会话的钱。`cli.py` 的 oneline 已按此调用。

    下面那道 `dated_buckets and not todays_buckets → 丢弃 by_model` 是
    **兜底**，不是主防线：它只能挡"整段都不是今天"，挡不住"整段里只有
    一部分是今天"（上面那个 70 倍就是后者）。留着是防未来有调用方忘了
    切片；真正的正确性来自调用方传对数据。没有任何带日期的桶时**保留**
    by_model——宁可像过去一样可能收进不该收的账，也不能把真today的数据
    （只是恰好没测到时间戳）误判成"不是今天"而丢掉，这不对称是有意的
    （见 CLAUDE.md「heuristics sort, they never acquit」同一条纪律：
    没有实锤证据时不能主动认定）。
    """
    path = state_dir() / "today.json"
    rotate_today()  # 跨 BJ 0:00 自动滚动
    today_key = _today_key()
    with _locked(path):
        existing = _read(path) or {}
        all_buckets = hour_buckets_result.get("buckets", [])
        dated_buckets = [b for b in all_buckets if b.get("date")]
        todays_buckets = [b for b in dated_buckets if b["date"] == today_key]
        if by_model and dated_buckets and not todays_buckets:
            by_model = None
        existing["buckets"] = _merge_buckets(
            existing.get("buckets"), todays_buckets, key_field="hour")
        if by_model:
            existing["by_model"] = _merge_model_buckets(
                existing.get("by_model"), by_model)
        existing["schema_version"] = SCHEMA_VERSION
        existing["generated_at"] = _now_iso()
        existing["date"] = today_key
        _atomic_write(path, existing)
    return path


def merge_month(hour_buckets_result, by_date_model=None) -> Path:
    """把 hour_buckets 的所有桶合并到 month.json（按日期折叠）。

    `by_date_model`: `{date_str: {model: 八桶}}`（见
    `usage.py::token_by_date_model`）——**不是**整段 session 一次性的
    `by_model`。历史上这里收的是后者，一律写进 `_today_key()`（今天）,
    对「审计一份刚结束的当天会话」这个唯一被测过的场景凑巧是对的（那时
    "今天" 就是会话真实发生的那天），但对「回填历史日志」（
    `dsh_autosync.py` 的 skip 提示明确建议的用法：「run oneline manually
    if you want a historical backfill」）或跨零点的长会话就是错的——
    真实 case：`session-e4b0be69` 横跨 4 天，整段 by_model 被记成回填当天，
    月度精算成本因此漏记了没落在该日的部分（8月账目一度因此偏差 4 倍）。
    现在按 `by_date_model` 自带的日期直接归位，回填哪天都不会记错。

    **month.json 里每个 token 只被记一次，且只由这个函数负责。**
    `rotate_today` 曾经也往 month.json 里搬一份（`_move_today_to_month`，
    已删除），与这里重复计数——见 `rotate_today` 的文档注释。

    **month.json 只保存「当前自然月」**，跨月的日子迁进
    `month-archive.json`（见 `archive_path`）。过去 `days` 无限累积、
    `month` 字段只是写入时刻盖的戳，而所有读者都不按月过滤——9 月 1 日
    起「本月成本」实际会变成「有史以来成本」（实测一个含 8 月两天 + 9 月
    一天的 month.json 报出 201 倍的金额）。

    **两个文件之间的顺序是有意的：先迁旧月、再落新数据。**
    ① 迁移用逐日**替换**（`_archive_days`），因此幂等——写完归档还没删
    month.json 就崩溃时，重跑得到同样结果，不会重复计数；
    ② 迁移在前保证「一天只存在于一个文件里」：迁完之后本次的新数据才按
    各自的月份分流，历史月的部分直接累加进归档，不会再回到 month.json，
    也就不会出现「同一天一半在归档一半在 month.json」。
    """
    path = state_dir() / "month.json"
    with _locked(path):
        existing = _read(path) or {}
        current = _month_key()

        # ① 先把 month.json 里不属于当前月的日子迁进归档（幂等，见上）
        stale = {d: b for d, b in (existing.get("days") or {}).items()
                 if _month_key(d) != current}
        if stale:
            _archive_days(stale)
            existing["days"] = {d: b for d, b in existing["days"].items()
                                if _month_key(d) == current}

        # ② 再落本次的新数据，按各自日期所属的月份分流
        merged = _merge_buckets({}, hour_buckets_result.get("buckets", []),
                                key_field="date")
        for date_key, by_model in (by_date_model or {}).items():
            # `token_by_date_model` 的 by_source 轴是顶层并列键，不是日期——
            # 跳过，单独按「日期 → source → 模型」折（见下）。不跳的话它会被
            # 当成某一天，_merge_model_buckets 会把 `{date: {source: {model}}}`
            # 整段塞进 by_model，月账直接错一个量级。
            if date_key == "by_source":
                continue
            if not by_model:
                continue
            day = merged.setdefault(date_key, {
                "uncached_input_tokens": 0, "output_tokens": 0,
                "cache_read_tokens": 0, "cache_write_tokens": 0,
                "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
                "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0,
            })
            day["by_model"] = _merge_model_buckets(day.get("by_model"), by_model)
        # by_source 也折进 merged，让下面的 cur/old 分流统一携带它——与
        # by_model 同一套语义（合并、日期缺桶补零桶），只多一层 source 键。
        for date_key, sources in ((by_date_model or {}).get("by_source") or {}).items():
            if not sources:
                continue
            day = merged.setdefault(date_key, {
                "uncached_input_tokens": 0, "output_tokens": 0,
                "cache_read_tokens": 0, "cache_write_tokens": 0,
                "peak_uncached_input_tokens": 0, "peak_output_tokens": 0,
                "peak_cache_read_tokens": 0, "peak_cache_write_tokens": 0,
            })
            for src, models in sources.items():
                _merge_source_into_day(day, src, models)

        cur_days = {d: b for d, b in merged.items() if _month_key(d) == current}
        old_days = {d: b for d, b in merged.items() if _month_key(d) != current}

        existing["days"] = _merge_buckets(
            existing.get("days"),
            [dict(b, date=d) for d, b in cur_days.items()],
            key_field="date")
        for d, b in cur_days.items():
            if b.get("by_model"):
                existing["days"][d]["by_model"] = _merge_model_buckets(
                    existing["days"][d].get("by_model"), b["by_model"])
            # by_source 与 by_model 一样在 _merge_buckets 之外单独折——
            # _merge_buckets 只读 8 个 token 字段，会把 by_source 丢回 new_day。
            if b.get("by_source"):
                day = existing["days"][d]
                for src, models in b["by_source"].items():
                    _merge_source_into_day(day, src, models)

        if old_days:
            # 历史月的回填：累加进归档里已有的那一天，而不是替换——这里的
            # 输入是「本次新测到的量」，不是那一天的完整累计。
            archive = _read(archive_path()) or {}
            months = archive.get("months") or {}
            rebuilt = {}
            for d, b in old_days.items():
                prev = ((months.get(_month_key(d)) or {}).get("days") or {}).get(d)
                acc = _merge_buckets({}, [dict(prev or {}, date=d)], key_field="date") \
                    if prev else {}
                acc = _merge_buckets(acc, [dict(b, date=d)], key_field="date")
                if b.get("by_model") or (prev or {}).get("by_model"):
                    acc[d]["by_model"] = _merge_model_buckets(
                        (prev or {}).get("by_model"), b.get("by_model") or {})
                # by_source 的回填也是累加（prev 的 source 桶 ∪ 本次的），不是
                # 替换——同一天被回填两次，两个来源各留各的键。
                if b.get("by_source") or (prev or {}).get("by_source"):
                    day = acc[d]
                    for src, models in ((prev or {}).get("by_source") or {}).items():
                        _merge_source_into_day(day, src, models)
                    for src, models in (b.get("by_source") or {}).items():
                        _merge_source_into_day(day, src, models)
                rebuilt[d] = acc[d]
            _archive_days(rebuilt)

        existing["schema_version"] = SCHEMA_VERSION
        existing["generated_at"] = _now_iso()
        existing["month"] = current
        _atomic_write(path, existing)
    return path


# ────────────────────────── 列出 / 清理 ──────────────────────────


def append_session_history(summary):
    """追加一行到 sessions.jsonl —— xbar 显示「最近 5 次审计」用。

    追加(append-only)+平台文件锁，确保多个并发 oneline 不会丢行。
    sessions.jsonl **不** rotate 也没事 —— 月增 ~100 行,几年才上 MB。

    summary 是 oneline 的那一份 dict(见 cli.py::oneline handler),
    至少含 session_id / tokens_total / cost_cny / model。
    自动补 generated_at(ISO8601)——不依赖调用方记得塞。
    """
    path = state_dir() / "sessions.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    # 自动补 generated_at — xbar 的 hhmm 解析靠它
    payload = dict(summary)
    payload.setdefault("generated_at", _now_iso())
    lock_path = path.with_suffix(path.suffix + ".lock")
    fd = os.open(str(lock_path), os.O_CREAT | os.O_RDWR, 0o600)
    try:
        with _locked_fd(fd):
            line = json.dumps(payload, ensure_ascii=False, default=str)
            with open(path, "a", encoding="utf-8") as f:
                f.write(line + "\n")
    finally:
        os.close(fd)



def list_state_files():
    """返回 state 目录下所有 .json 文件的 path 列表（不含 .lock / .tmp.*）。

    给 doctor / overlap / explain 等「扫描本地状态」的命令用。
    """
    p = state_dir()
    return sorted(f for f in p.glob("*.json") if f.is_file())
