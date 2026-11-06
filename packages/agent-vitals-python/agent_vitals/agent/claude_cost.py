"""Claude Code 会话账 fold 的 Python 平行实现。

单一真相源是 `src/agent/claude_cost.rs`——那里的模块头注释讲清了为什么
cost-state 是账单真值、行只给按天归属（基线 **replace 不是 add**、两条同值
cost-state + 中间有 usage 行不双计）、行读做两态形状嗅探（API 全形 snake 优先、
短键兜底，两态皆无 → 哨兵，绝不把认不出的 usage 当 0）、checkpoint 用
(size, mtime_ns) 当状态（无时间戳字段，字节确定性由构造保证）、ledger 每次
全量重建（不是增量累加——那是 2026-08 三倍计数事故的温床）。

这一份是它的逐字节镜像，由 `tests/test_claude_cost.py` 的 `both()` 差分看守
（同一批 fixture 会话文件 → 两侧 fold.json/ledger/archive/stdout 字节一致；
`archived_at` 与 month-archive 同款会带 now 时间戳，差分对 ISO 打码）。

Fencing 同 oneline 的 Python 写者纪律：owner 是 rust 时拒绝（writer fencing
§4.2——防迁移期双写），缺 manifest（owner=python 回退）正常写；`--shadow`
演练跳过。与 Rust `require_rust_owner(shadow)` 互为镜像——差分测试里 Rust 走
`--shadow`、Python 走默认（owner=python 的种子基线），谁都不真 cutover。
"""
import json
from datetime import date, timedelta

from .codex_cost import current_month_beijing
from .state import _atomic_write, _now_iso, _read, state_dir
from .usage import _is_peak_slot

# v0.6.x 前置正确性热修复（归日转正 + 峰谷分辨率 + 残差哨兵，三者同批——
# 见 docs/VITALS_CORE_V0_6_HARNESS_CONTRACT_SPEC.md §5.3 条款 7 / §8 G10、
# docs/VITALS_CORE_V0_7_DATA_PLANE_SPEC.md §5）。claude-fold.json 在这次改动
# 之前没有 schema_version：旧 checkpoint 的 tail_days 是在"cost-state 一来
# 就清空"的旧算法下产生的，只保留最近一次基线之后的行，历史全部已经在写盘
# 那一刻永久丢失（不是"还没折"，是"折过又被清掉"）——resume 读不回来，唯一
# 正确的补救是强制全量重折一次（源头 JSONL 文件本身没删，可重建）。
# `FOLD_SCHEMA_VERSION` 不匹配（含缺失，等价旧版本 0）时，claude_sync 清空
# 整份 `sessions`，让每个文件都走 `_fold_one` 的 "new" 分支——不是迁移函数，
# 是"重新从权威源 ingest"，与 v0.7 spec §4.1"事实 cache 可重建"同一个原则。
#
# v3（2026-09-06，`_apply_record` 补 message.id 去重）：v2 及更早的
# tail_days 是在"同一 assistant 消息重复几行就无条件累加几次"的旧算法下
# 写的——真机验证同一 message.id 在同一文件里出现 4 次、usage 字段逐字节
# 相同，2026-09 月度 claude token 因此被系统性高估约 2 倍（见 Rust
# claude_cost.rs 同一常量的注释、memory claude-ledger-overcount-bug）。
# 已写入的 tail_days 里这笔重复计数不可逆（没存 seen_event_ids，事后无法
# 甄别），与 v2 同一补救：强制全量重折。
FOLD_SCHEMA_VERSION = 3

# 行级 usage 的 4 个计数键（API 全形，真机 100%；写入桶的固定键序）。
SNAKE_KEYS = ["input_tokens", "cache_read_input_tokens",
              "cache_creation_input_tokens", "output_tokens"]
# 短键旧形状（真机 0 命中，仍认——旧客户端语料）。顺序与 SNAKE_KEYS 一一对应。
SHORT_KEYS = ["input", "cache_read", "cache_creation", "output"]
# cost-state modelUsage 的 camel 键，同样一一对应。
CAMEL_KEYS = ["inputTokens", "cacheReadInputTokens",
              "cacheCreationInputTokens", "outputTokens"]
# 高峰时段子桶——每个 SNAKE_KEYS 字段配一个 peak_ 前缀的子计数，与 DSH
# `usage.rs::add_buckets` 的 4+4 形状同构（v0.6 spec §5.3 条款 7 的"折叠时
# 预拆"）。这四个键只从 tail_days（逐行真实 ts）里累计——cost-state 的
# modelUsage 是无时间戳的累计快照，永远没有资格填这四个键，见
# `_price_claude_map` 的 `peak_resolved` 参数。
PEAK_KEYS = ["peak_input_tokens", "peak_cache_read_input_tokens",
             "peak_cache_creation_input_tokens", "peak_output_tokens"]


def ledger_day_total_tokens(day):
    """ledger flat 日（{model: 4 型 snake}，rebuild_days 产出）→ 4 型 token 总量。
    r2a.py 的 claude 执行环境行「今日 token」走这里；SNAKE_KEYS 只此一处定义，别在
    r2a 再抄一份键清单。非 dict 值（坏日）→ 0；但「读出 0」只发生在坏数据上，
    空日不落 ledger。

    Rust 平行实现见 `claude_cost.rs::ledger_day_total_tokens`。"""
    total = 0
    if isinstance(day, dict):
        for tokens in day.values():
            if isinstance(tokens, dict):
                for k in SNAKE_KEYS:
                    v = tokens.get(k)
                    if isinstance(v, int) and not isinstance(v, bool):
                        total += v  # Rust as_i64：非整数（含 bool）记 0
    return total


def claude_ledger_day_tokens(day_key):
    """读 ledger 当日（day_key = 北京日）的 4 型 token 总量 → r2a.py
    `sessions_navigation` 的 claude 执行环境行「今日 token」（spec §5.2
    basis=ledger）。

    三种 None：ledger 不存在 / 无 `days` 键 / 当日缺席——都诚实报 None（托盘显
    null/—，不编 0）。「空日不落 ledger」：days 里的日子全是 fold 真测到的桶，
    当日缺席 = 今天没测到账，与 codex 当日桶缺席同语义。当日存在但总和 0（只有
    全零 unknown 桶的病理日）→ 0，「测到 0」不是「没测」。

    Rust 平行实现见 `claude_cost.rs::claude_ledger_day_tokens`。"""
    ledger = _read(_ledger_path())
    if not isinstance(ledger, dict):
        return None
    days = ledger.get("days")
    if not isinstance(days, dict) or day_key not in days:
        return None
    return ledger_day_total_tokens(days[day_key])

# 北京日线的月末天数表（add_day 用；年份闰判定走公历规则）。
_DIM = {1: 31, 3: 31, 5: 31, 7: 31, 8: 31, 10: 31, 12: 31,
        4: 30, 6: 30, 9: 30, 11: 30}


def _fold_path():
    return state_dir() / "claude-fold.json"


def _ledger_path():
    return state_dir() / "claude-ledger.json"


def _ledger_archive_path():
    return state_dir() / "claude-ledger-archive.json"


def month_key_of(date_str):
    """"YYYY-MM-DD" → "YYYY-MM"（前 7 字符）。"""
    return date_str[:7]


def day_from_iso_ts(ts):
    """ISO 时间戳（`YYYY-MM-DDTHH:MM:SS[.fff]Z`）→ **北京日** "YYYY-MM-DD"。

    Rust `claude_cost.rs::day_from_iso_ts` 的镜像（同一组单测 fixture 在两侧各
    钉一遍）。为什么从字符串直接算而不经 epoch：真机 100% 定宽 Z 格式，日线只
    需日期 + 小时两截——北京 = UTC+8，UTC 时刻小时 ≥ 16 就跨到次日。非 ASCII /
    非 Z 后缀 / 超界数字 → None（哨兵，绝不猜时区——带 `+05:00` 的旧格式若
    存在，按 UTC 算会把日线算错）。
    """
    if not isinstance(ts, str) or not ts.isascii():
        return None
    if len(ts) < 20 or ts[10] != "T" or not ts.endswith("Z"):
        return None
    try:
        y = int(ts[0:4])
        mo = int(ts[5:7])
        d = int(ts[8:10])
        hh = int(ts[11:13])
    except ValueError:
        return None
    if not 1 <= mo <= 12 or not 1 <= d <= 31 or hh > 23:
        return None
    if hh >= 16:
        y, mo, d = _add_day(y, mo, d)
    return "%04d-%02d-%02d" % (y, mo, d)


def ms_from_iso_ts(ts):
    """同 `day_from_iso_ts` 认的时间戳格式 → epoch 毫秒。给 `usage.py::
    _is_peak_slot` 用——它要精确的北京小时 + 星期几，`day_from_iso_ts` 只算到
    "哪一天"不够。复用同一套格式校验（不额外校验分/秒范围外的输入会被
    `date()` 构造器自己拒——ValueError 兜底），不重开一套解析规则；只多读
    `mm`/`ss` 两截。用 `date()` 做民历转儒略日（与 `day_from_ms` 同一手法），
    不手写另一套闰年表。
    """
    if not isinstance(ts, str) or not ts.isascii():
        return None
    if len(ts) < 20 or ts[10] != "T" or not ts.endswith("Z"):
        return None
    try:
        y = int(ts[0:4])
        mo = int(ts[5:7])
        d = int(ts[8:10])
        hh = int(ts[11:13])
        mm = int(ts[14:16])
        ss = int(ts[17:19])
    except ValueError:
        return None
    if not 1 <= mo <= 12 or not 1 <= d <= 31 or hh > 23 or mm > 59 or ss > 59:
        return None
    try:
        days = (date(y, mo, d) - date(1970, 1, 1)).days
    except ValueError:
        return None
    return (days * 86400 + hh * 3600 + mm * 60 + ss) * 1000


def _add_day(y, mo, d):
    """公历日 +1（月末/年末/闰年走同一张表）。镜像 Rust add_day。"""
    if mo == 2:
        leap = (y % 4 == 0 and y % 100 != 0) or y % 400 == 0
        dim = 29 if leap else 28
    else:
        dim = _DIM.get(mo, 31)
    if d < dim:
        return y, mo, d + 1
    if mo == 12:
        return y + 1, 1, 1
    return y, mo + 1, 1


def day_from_ms(ms):
    """epoch 毫秒 → 北京日。cost-state 的 `startTime`（会话起始，ms）走这条。

    与 Rust 的 `civil_from_unix_secs(ms.div_euclid(1000), 8*3600)` 同值：ms ≥ 0
    时 `// 1000` 就是 floor，`date(1970,1,1) + timedelta` 是同一本格里高利历。
    负 ms 两侧也同（floor div 与 div_euclid 同义）——但真机无负 startTime，
    两侧各自的钉测用正 ms 就够了。
    """
    secs = ms // 1000 + 8 * 3600
    return (date(1970, 1, 1) + timedelta(days=secs // 86400)).isoformat()


def _bump_obj(obj, t):
    """4 桶加到 `obj`（4 个 snake 键的桶 dict）。用于 baseline / 归档合并这类
    只有 4 型、没有峰谷分辨率的场合。"""
    for i, k in enumerate(SNAKE_KEYS):
        obj[k] = int(obj.get(k) or 0) + int(t[i])


def _bump_tail(obj, t, peak):
    """8 桶加到 `obj`（tail_days[day][model]，4 基础 + 4 峰值子桶，DSH
    `usage.rs::add_buckets` 同形）。`peak=True` 时额外加进 `PEAK_KEYS`——
    子桶恒 ≤ 对应基础桶（同一次加法同时进两边，不会倒挂）。"""
    for i, k in enumerate(SNAKE_KEYS):
        obj[k] = int(obj.get(k) or 0) + int(t[i])
    if peak:
        for i, k in enumerate(PEAK_KEYS):
            obj[k] = int(obj.get(k) or 0) + int(t[i])


def _inc(sess, key):
    """会话状态上的哨兵计数器 +1（unattributed_rows / unreadable_usage_rows）。"""
    sess[key] = int(sess.get(key) or 0) + 1


def _row_tokens(usage):
    """从 usage 对象嗅 4 桶 token。两态都认、全形优先；键在而值不是数 → 该形
    状不算命中（corpus 值全 int）。两态皆无 → None → 哨兵计数（P0）。"""
    if not isinstance(usage, dict):
        return None
    for keys in (SNAKE_KEYS, SHORT_KEYS):
        out = []
        for k in keys:
            v = usage.get(k)
            if not isinstance(v, int) or isinstance(v, bool):
                break
            out.append(v)
        if len(out) == 4:
            return out
    return None


def _camel_entry_tokens(entry):
    """从 cost-state modelUsage 的**单个模型条目**（camelCase）读 4 桶。
    键不全（真机没见过——客户端漂移）→ None → 哨兵。"""
    if not isinstance(entry, dict):
        return None
    out = []
    for k in CAMEL_KEYS:
        v = entry.get(k)
        if not isinstance(v, int) or isinstance(v, bool):
            return None
        out.append(v)
    return out


def _apply_record(sess, rec, *, native_session_id, machine_namespace, source_profile):
    """一条记录 → 会话状态转换（assistant 行入尾差、cost-state 换基线对账
    锚）。纯函数：`sess` 是 claude-fold.json 里 `sessions[sid]` 的 dict。

    v0.6.x 前置热修（归日转正，2026-09-03）：`tail_days` **不再在 cost-state
    到来时清空**——旧算法「换基线、清尾差」会把已经有真实逐行 ts 的历史,
    整段折进一个只有单一 `startTime` 归属的基线,跨午夜会话的当日消费因此被
    错记到会话起始日（真机实测 197.5M flash cache-read 记错一天,见
    `docs/CLAUDE_COST_DAY_ATTRIBUTION_ANALYSIS.md`）。新规则：`tail_days`
    对整个会话生命周期只增不清,永远是"每笔 usage 按它自己的 ts 归日"的诚实
    记录；`cost-state` 的 `modelUsage` 只更新 `baseline`（最新累计自报），
    在 `_rebuild_days` 里仅用作**对账锚**——`tail_days` 汇总 ≥ 基线时基线
    是冗余信息（被更精确的逐行数据完全覆盖，直接丢弃）；汇总 < 基线时,
    差值是真实存在但没有逐行证据的残差（比如日志早期部分被截断/未采集），
    进 `_rebuild_days` 返回的 `unaccounted` 池——不猜它发生在哪一天。

    Stage 1 R1 重构（commit d0ec2f2 拍板，commit 1：extractor + golden 零
    漂移）：assistant 行解析走共享 extractor `parse_claude_usage_row`，
    fold 与未来的 emitter 消费同一个 Observation。fold 行为字节不变——
    sentinel 触发条件与 `_bump_tail` 入参逐字段一致，golden runner 与
    `test_claude_cost.py` byte-parity 验证零漂移。
    """
    # tail_days 是 assistant 行的落点；fresh 会话第一个 assistant 行进来时
    # 还没有这个键——懒建，别 expect。
    sess.setdefault("tail_days", {})
    rtype = rec.get("type") if isinstance(rec, dict) else None
    if rtype == "cost-state":
        # 基线更新：modelUsage 是整段会话的累计自报（真机两条同值 cost-state
        # 逐字段相同证明）。只更新对账锚，不再清 tail_days、不再算
        # baseline_day——归日全部交给 assistant 行自己的 ts（见上）。
        usage = rec.get("modelUsage")
        baseline = {}
        if isinstance(usage, dict):
            for model, entry in usage.items():
                t = _camel_entry_tokens(entry)
                if t is None:
                    _inc(sess, "unreadable_usage_rows")
                else:
                    baseline[model] = dict(zip(SNAKE_KEYS, t))
        else:
            _inc(sess, "unreadable_usage_rows")
        sess["baseline"] = baseline
        return
    if rtype != "assistant":
        return
    # R1 共享 extractor：fold 与 emitter 共用一个 row parser（commit
    # d0ec2f2 §2.3）——返回 Observation 或 Skip(reason)；fold 侧对 Skip
    # 递增 sentinel 后 return，Observation 走 `_bump_tail` 累加 8 桶。
    # **Sentinel 触发条件与旧 `_apply_record` 逐字段一致**（commit 1
    # golden 零漂移硬条件）。
    from .claude_usage_fact import Skip, parse_claude_usage_row, UNREADABLE, UNATTRIBUTED
    result = parse_claude_usage_row(
        rec,
        native_session_id=native_session_id,
        machine_namespace=machine_namespace,
        source_profile=source_profile,
    )
    if isinstance(result, Skip):
        if result.reason == UNREADABLE:
            _inc(sess, "unreadable_usage_rows")
        elif result.reason == UNATTRIBUTED:
            _inc(sess, "unattributed_rows")
        # SKIP 不增 sentinel（cost-state / 非 dict / 无 usage 都不计）。
        return
    # 去重（2026-09-06，见 FOLD_SCHEMA_VERSION 的 v3 注释/Rust 同一函数的
    # 镜像注释）：同一 session 内相同 source_event_id（message.id/uuid）的
    # 重复行是同一条已完成消息的重复记录，无条件累加会把同一笔已计费用量
    # 算 2~4 遍。与 emitter（claude_usage_fact.py）"同一 session 重复
    # source_event_id 只保留一个 fact"完全同一条规则。只在
    # source_event_id 非空（identity_basis=="native"）时去重——derived-hash
    # 的空 source_event_id 需要 emitter 那边的文件级字节偏移才能补全，fold
    # 侧拿不到，保留旧行为（真机语料 uuid 恒存在，未命中这个分支）。
    if result.source_event_id:
        seen = sess.setdefault("seen_event_ids", {})
        if result.source_event_id in seen:
            _inc(sess, "duplicate_usage_rows")
            return
        seen[result.source_event_id] = True
    # Observation → fold tail_days。emit 用的额外字段（message_id 等）
    # 在 commit 2 落地，本函数只读 fold 字段（day / model / tokens_4 / peak）。
    tokens = (result.input_tokens, result.cache_read_tokens,
              result.cache_write_tokens, result.output_tokens)
    day_obj = sess["tail_days"].setdefault(result.day, {})
    model_obj = day_obj.setdefault(result.model, {})
    _bump_tail(model_obj, tokens, result.peak)


def _merge_models_into_day(day, buckets):
    """把 `{model: {8 snake+peak}}` 桶并进一个**已铺平到 model 层**的日对象
    （多会话同日相加——逐会话 replacement 会丢别的会话，ledger 必须全量重建，
    这就是不增量累加的原因）。峰值子桶随基础桶一起搬，8 键一视同仁——这里
    不是"4 键 + 额外逻辑"，是同一份键表的自然扩展。"""
    if not isinstance(buckets, dict):
        return
    for model, t8 in buckets.items():
        if not isinstance(t8, dict):
            continue
        hits = {}
        for k in SNAKE_KEYS + PEAK_KEYS:
            v = t8.get(k)
            if isinstance(v, int) and not isinstance(v, bool):
                hits[k] = v
        if not hits:
            continue
        out = day.setdefault(model, {})
        for k, v in hits.items():
            out[k] = int(out.get(k) or 0) + v


def _stat_file(path):
    """(size, mtime_ns)，stat 失败 → None（枚举与 stat 之间文件消失 → 不计）。"""
    try:
        st = path.stat()
    except OSError:
        return None
    return st.st_size, st.st_mtime_ns


def _read_suffix(path, from_byte):
    """从字节偏移 `from` 读完整行，逐行解析。返回 (记录列表, 新偏移)。

    末行无换行符 → 不消费（客户端可能正写到一半，下个 sync 补上）。完整行
    JSON 解析失败 → 抛错（整份 abort、checkpoint 不动，下次 sync 重试——与
    claude_session 的「一条坏行毁整份」同款，绝不拼半截）。
    """
    with open(path, "rb") as f:
        f.seek(from_byte)
        data = f.read()
    records = []
    pos = from_byte
    start = 0
    for i, byte in enumerate(data):
        if byte == 0x0A:  # \n
            line = data[start:i]
            if line.endswith(b"\r"):
                line = line[:len(line) - 1]
            if line:
                try:
                    rec = json.loads(line.decode("utf-8", errors="replace"))
                except ValueError as e:
                    raise ValueError(
                        "non-json line in %s at byte offset %d: %s"
                        % (path, from_byte + start, e)) from e
                records.append(rec)
            pos = from_byte + i + 1
            start = i + 1
    return records, pos


def _fold_one(sessions, path, size, mtime, *, machine_namespace, source_profile):
    """一个会话文件折进 `sessions`。返回折叠类别（"new" 含整份重折替换）。
    对应 Rust `fold_one` → FoldKind（New/Resume/Skip）。

    Stage 1 R1 重构（commit d0ec2f2）：`_apply_record` 通过共享 extractor
    `parse_claude_usage_row` 解析 assistant 行——`machine_namespace` 与
    `source_profile` 由 caller（`claude_sync`）从 R2a 注入，本函数只透传，
    不解析、不生成。fold 行为字节不变。
    """
    sid = path.stem
    existing = sessions.get(sid)
    if not isinstance(existing, dict):
        # 缺 / fold.json 被手改坏 → 整份重折替换（与 Rust `as_object` 的
        # None 分支同结果）。
        from_byte, kind = 0, "new"
    else:
        csize = int(existing.get("size") or 0)
        cmtime = int(existing.get("mtime_ns") or 0)
        if size == csize and mtime == cmtime:
            return "skip"
        if size <= csize:
            # 截断重写 / 原地重写 → 整份重折替换
            from_byte, kind = 0, "new"
        else:
            from_byte, kind = csize, "resume"
    records, new_pos = _read_suffix(path, from_byte)
    # existing 不是 dict（fold.json 被手改坏）→ 当整份重折替换，与 Rust 的
    # `as_object().cloned().unwrap_or_default()` 同结果。
    sess = {} if kind == "new" else dict(existing) if isinstance(existing, dict) else {}
    for rec in records:
        _apply_record(
            sess, rec,
            native_session_id=sid,
            machine_namespace=machine_namespace,
            source_profile=source_profile,
        )
    sess["size"] = new_pos
    sess["mtime_ns"] = mtime
    sessions[sid] = sess
    return kind


def _session_row_sum(tail):
    """`{day: {model: {8 键}}}` → `{model: [4 型 snake 总量]}`（跨全部日子
    求和，只取基础 4 键——峰谷子桶不参与对账,它们是基础桶的子集,加总基础桶
    就够判断"这个模型的行级证据覆盖了多少"）。"""
    out = {}
    if not isinstance(tail, dict):
        return out
    for buckets in tail.values():
        if not isinstance(buckets, dict):
            continue
        for model, t8 in buckets.items():
            if not isinstance(t8, dict):
                continue
            acc = out.setdefault(model, [0, 0, 0, 0])
            for i, k in enumerate(SNAKE_KEYS):
                v = t8.get(k)
                if isinstance(v, int) and not isinstance(v, bool):
                    acc[i] += v
    return out


def _rebuild_days(sessions, current):
    """从会话状态全量重建逐日桶 + 残差对账。返回 (当前月 ledger days,
    要滚进归档的 days, unaccounted 残差 `{model: {4 键}}`)。

    v0.6.x 前置热修（归日转正 + 残差哨兵，2026-09-03）：日桶**只**由
    `tail_days`（逐行真实 ts，峰谷分辨率精确）铺出——`baseline`
    （cost-state 累计自报）不再被当成"这一天的用量"塞进任何日子，它只做
    **对账锚**：逐会话、逐模型比较 `tail_days` 汇总与最新 `baseline`——
    汇总 ≥ 基线 → 基线是行级证据的子集，冗余，丢弃；汇总 < 基线 → 差值是
    真实发生过但没有留下逐行 ts 证据的用量（比如压缩/截断丢失的早期历史），
    计入 `unaccounted`——它没有日期，也没有峰谷分辨率（不知道何时发生的，
    不能假装知道），调用方（`priced_day`/日历这类消费端）必须把它单独标注、
    不能悄悄摊进某一天冒充精确。
    """
    all_days = {}
    unaccounted = {}
    if isinstance(sessions, dict):
        for sess in sessions.values():
            if not isinstance(sess, dict):
                continue
            tail = sess.get("tail_days")
            if isinstance(tail, dict):
                for day, buckets in tail.items():
                    _merge_models_into_day(
                        all_days.setdefault(day, {}), buckets)
            row_sum = _session_row_sum(tail)
            baseline = sess.get("baseline")
            if isinstance(baseline, dict):
                for model, t4 in baseline.items():
                    if not isinstance(t4, dict):
                        continue
                    base_arr = [0, 0, 0, 0]
                    for i, k in enumerate(SNAKE_KEYS):
                        v = t4.get(k)
                        if isinstance(v, int) and not isinstance(v, bool):
                            base_arr[i] = v
                    row_arr = row_sum.get(model, [0, 0, 0, 0])
                    residual = [max(0, base_arr[i] - row_arr[i]) for i in range(4)]
                    if any(residual):
                        _bump_obj(unaccounted.setdefault(model, {}), residual)
    # 分月：当前月 → ledger；更早的日子 → 归档（写侧逐日替换幂等）。
    ledger = {}
    archive = {}
    for day, merged in all_days.items():
        if month_key_of(day) == current:
            ledger[day] = merged
        else:
            archive[day] = merged
    return ledger, archive, unaccounted


def _add_days_to_archive(archive, days_by_date, now_iso):
    """把若干「日桶」并进归档文件,**逐日替换**而不是累加（镜像 core
    `state.rs::add_days_to_archive`——同一份纯函数语义，写 claude 自己的
    归档文件、不碰 DSH 的 month-archive）。幂等：写完归档、还没来得及从
    ledger 挪走就崩溃，下次重跑得到完全一样的结果。
    """
    out = dict(archive or {})
    months = out.setdefault("months", {})
    for date_str, day in days_by_date.items():
        entry = months.setdefault(month_key_of(date_str), {"days": {}})
        entry["days"][date_str] = day  # 逐日替换 —— 幂等
        entry["archived_at"] = now_iso
    from .state import SCHEMA_VERSION
    out["schema_version"] = SCHEMA_VERSION
    return out


def _strip_archive_ts(archive):
    """剥掉归档里每个月的 archived_at（写入时刻的元数据，不参与内容比较）。
    镜像 Rust `strip_archive_ts`——claude_sync 的归档写条件依赖它。"""
    import copy
    out = copy.deepcopy(archive) if archive else {}
    for entry in (out.get("months") or {}).values():
        if isinstance(entry, dict):
            entry.pop("archived_at", None)
    return out


def claude_sync(home, shadow=False):
    """`claude-sync` 主入口：发现变化会话 → 尾读折入 checkpoint → 重建
    ledger + 归档 → 打印确定性摘要（与 Rust 三行逐字节一致）。fencing 同
    oneline 的 Python 写者纪律：owner=rust 时拒绝（exit 2 由 CLI 层转），
    --shadow 跳过。单文件坏行只计 failed、不 abort 整轮（下轮重试）。

    与 Rust `claude_cost.rs::claude_sync` 一一对应；home 为会话目录根
    （.claude/projects 的父），通常由 CLI 从环境解析传入。
    """
    from ..adapters.claude_session import claude_project_files
    from .takeover import owner_allows_python

    if not shadow and not owner_allows_python():
        # 镜像 Rust 的 Err(String)：CLI 层捕获后转 exit 2（Rust 侧同款）。
        raise ValueError(
            "writer fencing: state owner is 'rust', not 'python'; run "
            "'state takeover python' first, or --shadow to rehearse on a copy")

    files = claude_project_files(home)
    fp = _fold_path()
    folds = _read(fp) or {"sessions": {}}
    # v0.6.x 前置热修的强制重折闸门：旧 checkpoint（`schema_version` 缺失或
    # 不是当前版本）是在"cost-state 一来就清 tail_days"的旧算法下写的——它的
    # `tail_days` 只剩最近一次基线之后的行，更早的历史已经被旧算法永久清掉，
    # 不是"还没折"而是"折过又被丢"，resume 读不回来。清空 `sessions` 让
    # `_fold_one` 对每个文件都走 "new" 分支，从源头 JSONL 重新 ingest——与
    # v0.7 spec §4.1"事实 cache 可重建"同一个原则，不是迁移函数（没有可从
    # 旧结构直接推导新结构的路径，旧结构本身就丢了信息）。
    if folds.get("schema_version") != FOLD_SCHEMA_VERSION:
        folds = {"sessions": {}}
    sessions = folds.setdefault("sessions", {})
    # Stage 1 R1 commit 1（extractor 重构 + golden 零漂移）：machine_namespace
    # 与 source_profile 经共享 extractor 注入 `_apply_record`，但本 commit
    # 不触发 `state/machine.json` 写入（那会让 Python 端多出这个文件、
    # 破坏与 Rust 的 byte-parity）—— fold 行为字节不变要求不读不写 state
    # 目录。占位值不影响 fold（fold 只用 day/model/tokens/peak，emit 用
    # machine_namespace 与 source_profile 留给 commit 2 接线）。
    # 见 `docs/VITALS_CORE_V0_7_STAGE_1_CLAUDE_ADAPTER.md` §9 拍板表。
    machine_namespace = "ns-placeholder"  # commit 2: takeover.machine_namespace()
    source_profile = "default"
    scanned = fresh = resumed = skipped = failed = 0
    for path in files:
        scanned += 1
        st = _stat_file(path)
        if st is None:
            continue  # 枚举与 stat 之间文件消失 → 不计（下轮不再有它）
        size, mtime = st
        try:
            kind = _fold_one(
                sessions, path, size, mtime,
                machine_namespace=machine_namespace,
                source_profile=source_profile,
            )
        except (OSError, ValueError):
            failed += 1
            continue
        if kind == "new":
            fresh += 1
        elif kind == "resume":
            resumed += 1
        else:
            skipped += 1
    # 摘要统计（最终态）：基线会话数 / 纯行和会话数 / 两个哨兵计数。
    with_baseline = row_sum_only = unreadable = unattributed = duplicate = 0
    for sess in sessions.values():
        if not isinstance(sess, dict):
            continue
        if "baseline" in sess:
            with_baseline += 1
        else:
            row_sum_only += 1
        unreadable += int(sess.get("unreadable_usage_rows") or 0)
        unattributed += int(sess.get("unattributed_rows") or 0)
        duplicate += int(sess.get("duplicate_usage_rows") or 0)
    folds["schema_version"] = FOLD_SCHEMA_VERSION
    _atomic_write(fp, folds)
    # 全量重建 ledger + 归档 + 残差（幂等；崩溃重跑不会双计）。rebuild_days
    # 吃的是 sessions 映射（sid → 会话状态），不是 {"sessions": …} 外壳——
    # 两层结构刚写出时混过一次：把外壳喂进去，整本折叠空账，ledger 恒为空
    # 还不报错（smoke 时抓到的同款 bug 在 Rust 侧一行同型，两侧一起修）。
    now = _now_iso()
    current = current_month_beijing()
    ledger_days, archive_days, unaccounted = _rebuild_days(folds.get("sessions"), current)
    # 归档只在**日桶内容**变化时落盘：_add_days_to_archive 每调用都会给当月
    # 盖一个新 archived_at，若每轮无条件写，零变化的幂等重跑也会改写整个
    # 文件（真机冻结语料复跑抓到：fold/ledger 字节不变、archive 每轮都变）。
    # archived_at 记录的是「真正归档那次」的时刻，不是「本轮核对过」。
    if archive_days:
        existing = _read(_ledger_archive_path()) or {}
        candidate = _add_days_to_archive(existing, archive_days, now)
        if _strip_archive_ts(candidate) != _strip_archive_ts(existing):
            _atomic_write(_ledger_archive_path(), candidate)
    # 每次 sync 都写（哪怕空 days）——不清空的话跨月后旧文件停在盘上被误读
    # 成"本月"，这是 alert.json month-stale 事故的同类。`unaccounted` 恒写
    # （哪怕空 dict）——同一条纪律：缺席必须是"测过是空"，不是"没写这个键"。
    _atomic_write(_ledger_path(), {"days": ledger_days, "unaccounted": unaccounted})
    unaccounted_tokens = sum(
        int(t.get(k) or 0) for t in unaccounted.values() for k in SNAKE_KEYS
    )
    print("claude-sync: scanned %d files; folded %d (new %d, resumed %d); "
          "skipped %d; failed %d" % (scanned, fresh + resumed, fresh, resumed,
                                     skipped, failed))
    print("claude-sync: cost-state baselines: %d sessions; row-sum only: %d"
          % (with_baseline, row_sum_only))
    print("claude-sync: ledger days: %d; unreadable usage rows: %d; "
          "unattributed rows: %d; duplicate usage rows: %d"
          % (len(ledger_days), unreadable, unattributed, duplicate))
    print("claude-sync: unaccounted residual: %d models; %d tokens"
          % (len(unaccounted), unaccounted_tokens))
