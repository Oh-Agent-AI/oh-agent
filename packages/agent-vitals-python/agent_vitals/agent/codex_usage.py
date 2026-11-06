"""Codex 成本折叠的 Python 平行实现。

单一真相源是 `crates/agent-vitals-harnesses/src/harnesses/codex/sessions/usage.rs`——那里有一份完整的中文
注释讲**正确性铁律**（为什么读 `last_token_usage` 不读累计、为什么 `uncached` 是派生
字段、为什么连续去重必须做、为什么 model 是游标）。这一份是它的逐字节镜像，由
`tests/test_cli_matrix.py::both("codex-cost", ...)` 差分看守：Py↔Rust 的 `--json` 输出
必须一字不差。

与 DSH `usage.rs::token_by_date_model` / `usage.py` 的区别（为什么不能复用）：
DSH 的 4 桶 + peak/off-peak 按模型分桶，Codex 是 5 桶 + speed 分桶 + 按
`total_token_usage` 签名去重——线格式与计价维度都不同。这里是独立折叠，不是给
成本引擎套壳。**时间轴粒度与 DSH 同一纪律**（统一多桶折叠契约，见
docs/UNIFIED_COST_VIEW.md）：`by_hour_model` 是小时桶——today 直接显示小时，
month/all 由小时聚合成天。不是"codex 天生只有天"，是统一范式要求补全小时桶。
"""

from datetime import date, timedelta
from typing import NamedTuple, Optional

CODEX_TOKEN_FIELDS = [
    "uncached_input_tokens",
    "output_tokens",
    "cached_input_tokens",
    "cache_write_input_tokens",
    "reasoning_output_tokens",
]

_TOTAL_SIG_FIELDS = (
    "input_tokens",
    "output_tokens",
    "cached_input_tokens",
    "cache_write_input_tokens",
    "reasoning_output_tokens",
    "total_tokens",
)


def codex_token_facts(last):
    """`last_token_usage` → 5 桶 `[uncached, output, cached, cache_write, reasoning]`。

    `None` = 无效（缺 input/output、`uncached < 0`、`reasoning > output`）——交给
    调用方进残差哨兵，绝不把假数字折进桶。`uncached = input - cached - cache_write`
    是**派生**字段；reasoning 已计入 output（`output >= reasoning`），绝不叠加。
    """
    if not isinstance(last, dict):
        return None
    input_t = last.get("input_tokens")
    output = last.get("output_tokens")
    if not isinstance(input_t, int) or isinstance(input_t, bool):
        return None
    if not isinstance(output, int) or isinstance(output, bool):
        return None
    cached = last.get("cached_input_tokens")
    cache_write = last.get("cache_write_input_tokens")
    reasoning = last.get("reasoning_output_tokens")
    if not isinstance(cached, int) or isinstance(cached, bool):
        cached = 0
    if not isinstance(cache_write, int) or isinstance(cache_write, bool):
        cache_write = 0
    if not isinstance(reasoning, int) or isinstance(reasoning, bool):
        reasoning = 0
    uncached = input_t - cached - cache_write
    if uncached < 0 or reasoning > output:
        return None
    return (uncached, output, cached, cache_write, reasoning)


def _total_signature(total):
    """`total_token_usage` 的 6 字段签名（去重键）。缺任一字段 → None（这种 total
    没法判定「同一计量复读」，就不去重，交给下游的 last 校验兜底）。"""
    if not isinstance(total, dict):
        return None
    parts = []
    for f in _TOTAL_SIG_FIELDS:
        v = total.get(f)
        if not isinstance(v, int) or isinstance(v, bool):
            return None
        parts.append(v)
    return tuple(parts)


def _event_ts(event):
    """事件的时间戳**原始字符串**（顶层 `timestamp` 回退 `payload.timestamp`）。
    None = 无时间戳——配额快照没有可排序的 observed_at，就不更新（保持上一份）。"""
    ts = event.get("timestamp")
    if not isinstance(ts, str):
        payload = event.get("payload")
        if isinstance(payload, dict):
            ts = payload.get("timestamp")
    return ts if isinstance(ts, str) else None


def _plan_from_rate_limits(rl, observed_at):
    """`payload.rate_limits` → `plan` 块。`plan_type` 非空字符串才算有效
    （`limit_id` 之类不构成套餐身份）；`primary`/`secondary` 只收
    `{used_percent, window_minutes, resets_at}` 三字段、缺啥补啥、非法类型跳过该键；
    `observed_at` 由调用方传事件时间戳。None = 无效 rate_limits——不更新配额快照。

    `used_percent` 的真实值恒是 float（67.0），但 JSON 里整数也可能出现；先试
    int 再试 float（与 Rust 侧 `as_i64` → `as_f64` 同序），否则两侧 `67` vs `67.0`
    序列化不同（逐字节差分当场红）。"""
    if not isinstance(rl, dict):
        return None
    pt = rl.get("plan_type")
    if not isinstance(pt, str) or not pt:
        return None
    has_credits = False
    credits = rl.get("credits")
    if isinstance(credits, dict) and isinstance(credits.get("has_credits"), bool):
        has_credits = credits["has_credits"]
    limits = {}
    for name in ("primary", "secondary"):
        win = rl.get(name)
        if not isinstance(win, dict):
            continue
        entry = {}
        up = win.get("used_percent")
        if isinstance(up, bool):
            pass
        elif isinstance(up, int):
            entry["used_percent"] = up
        elif isinstance(up, float):
            entry["used_percent"] = up
        wm = win.get("window_minutes")
        if isinstance(wm, int) and not isinstance(wm, bool):
            entry["window_minutes"] = wm
        ra = win.get("resets_at")
        if isinstance(ra, int) and not isinstance(ra, bool):
            entry["resets_at"] = ra
        if entry:
            limits[name] = entry
    plan = {"plan_type": pt, "has_credits": has_credits}
    if limits:
        plan["limits"] = limits
    plan["observed_at"] = observed_at
    return plan


def _combine_plan(new_p, prev):
    """把新事件的 plan 与上一次 plan 合并：**新事件没带 `limits`、上一次带了 →
    把上一次的非空限额带过来**（降级快照 primary/secondary 全 null 不抹掉配额
    条），canonical 键序重建 (plan_type, has_credits, limits, observed_at)。新事件
    自带 limits 或上一次没有 → 原样返回。与 Rust 侧 `combine_plan` 逐字节对齐。"""
    if not isinstance(new_p, dict) or "limits" in new_p:
        return new_p
    prev_limits = prev.get("limits") if isinstance(prev, dict) else None
    if not isinstance(prev_limits, dict) or not prev_limits:
        return new_p
    return {
        "plan_type": new_p["plan_type"],
        "has_credits": new_p["has_credits"],
        "limits": prev_limits,
        "observed_at": new_p["observed_at"],
    }


_EPOCH_DATE = date(1970, 1, 1)
_BEIJING_OFFSET_HOURS = 8  # 东八区固定偏移；中国自 1991 年起全境 UTC+8、无夏令时


def _days_from_civil(y, m, d):
    """`YYYY-MM-DD` → 1970-01-01 起的天数（与 Rust 侧 `days_from_civil` 等价；
    用 `date()` 差值实现，跨时区无关）。非真实日期（如 02-30）抛 ValueError，
    调用方转 None——与 Rust 侧的 round-trip 校验同一语义。"""
    return (date(y, m, d) - _EPOCH_DATE).days


def _civil_from_days(days):
    """天数 → ISO `YYYY-MM-DD`（与 Rust 侧 `civil_date_from_days` 等价；
    同 `usage.py::_hour_key` 的 `_EPOCH_DATE + timedelta` 手法）。"""
    return (_EPOCH_DATE + timedelta(days=days)).isoformat()


def codex_hour_of(event):
    """事件时间戳 → `YYYY-MM-DDTHH` 北京小时桶键（统一多桶折叠：时间轴小时粒度，
    与 DSH `usage.rs::hour_buckets` 同一条纪律——**北京时间**小时，不是 UTC）。

    Codex 事件时间戳是 UTC ISO 串（实测全带 `Z` 后缀）。统一契约要求小时桶与
    DSH 同为北京时间：否则日历把 UTC 小时当北京小时渲染（今天 08:59 的消费显示成
    「00:00」），且 `--today` 按北京日前缀过滤会把北京凌晨 0-7 点的消费整块丢掉。
    顶层 `timestamp` 回退 `payload.timestamp`；不是合法小时时间戳、或日历上不存在
    的日期（如 02-30）→ None（未知时间，不编造）。"""
    ts = event.get("timestamp")
    if not isinstance(ts, str):
        payload = event.get("payload")
        if isinstance(payload, dict):
            ts = payload.get("timestamp")
    if not isinstance(ts, str) or len(ts) < 13:
        return None
    # YYYY-MM-DDTHH 结构校验（与 Rust 侧 `codex_hour_of` 同一条判定）。
    if not (ts[4] == "-" and ts[7] == "-" and ts[10] == "T"
            and ts[:4].isdigit() and ts[5:7].isdigit()
            and ts[8:10].isdigit() and ts[11:13].isdigit()):
        return None
    y, m, d, hh = int(ts[0:4]), int(ts[5:7]), int(ts[8:10]), int(ts[11:13])
    try:
        days = _days_from_civil(y, m, d)
    except ValueError:
        return None  # 日历上不存在的日期，不编造小时键（Rust 侧 round-trip 同判）。
    if _civil_from_days(days) != "%04d-%02d-%02d" % (y, m, d):
        return None
    total_hours = days * 24 + hh + _BEIJING_OFFSET_HOURS
    bj_days, bj_hour = divmod(total_hours, 24)
    return "%sT%02d" % (_civil_from_days(bj_days), bj_hour)


def normalize_speed(tier):
    """`default|standard → standard`、`fast|priority → fast`，其余 → None（未知档位
    不猜，保持当前 speed——不是把未知档位静默降级成 standard）。"""
    if tier in ("default", "standard"):
        return "standard"
    if tier in ("fast", "priority"):
        return "fast"
    return None


def speed_from_payload(payload):
    """`payload.service_tier` 优先，回退 `thread_settings/service_tier`。"""
    if not isinstance(payload, dict):
        return None
    tier = payload.get("service_tier")
    if isinstance(tier, str):
        s = normalize_speed(tier)
        if s is not None:
            return s
    thread = payload.get("thread_settings")
    if isinstance(thread, dict):
        tier = thread.get("service_tier")
        if isinstance(tier, str):
            return normalize_speed(tier)
    return None


def _add_bucket(map_, model, speed, facts):
    """把 5 桶折进 `map_[model][speed]`。桶对象存在则按位累加，不存在则按
    `CODEX_TOKEN_FIELDS` 的桶序新建（键序是字节一致的一部分，不能重排）。"""
    speed_map = map_.setdefault(model, {})
    bucket = speed_map.get(speed)
    if bucket is None:
        bucket = {f: 0 for f in CODEX_TOKEN_FIELDS}
        speed_map[speed] = bucket
    for field, n in zip(CODEX_TOKEN_FIELDS, facts):
        bucket[field] += n


def _bucket_to_array(bucket):
    return tuple(bucket.get(f, 0) for f in CODEX_TOKEN_FIELDS)


def _bump_unaccounted(unaccounted, ttype, total_tokens):
    entry = unaccounted.setdefault(ttype, {"count": 0, "tokens_seen": 0})
    entry["count"] += 1
    entry["tokens_seen"] += total_tokens


# 单条 token_count 事件的折合出口（mirror `CodexTokenOutcome`，spec §4 判别表）。
# 单元变体用 kind 常量标记；Consumed 带 5 桶 + 归属 model + 原始时间戳。fold 与
# UsageFact emitter 共用同一份判别——emitter 绝不另起一套 wire-shape 解释。
NOT_TOKEN_COUNT = "not-token-count"
SKIP = "skip"                # info 非 dict / null → skip attempt
REPEAT = "repeat"            # 同一计量复读 → 不 emit、不计 attempt
UNREADABLE = "unreadable"    # last_token_usage 无效 → unreadable attempt
UNATTRIBUTED = "unattributed"  # 首个 turn_context 前 → unattributed attempt
CONSUMED = "consumed"        # 折进 by_model → 可 emit


class CodexTokenOutcome(NamedTuple):
    """单条 token_count 事件的折合出口。`kind` ∈ 上述常量；`facts`（5 桶 tuple）、
    `model`、`event_ts_utc` 只在 Consumed 上有值（event_ts_utc = 顶层 timestamp
    回退 payload.timestamp 的原样串，真无时间戳 → None）。"""
    kind: str
    facts: Optional[tuple] = None
    model: Optional[str] = None
    event_ts_utc: Optional[str] = None


class CodexFoldState:
    """单文件 codex 折叠的**共享 per-`token_count` 观察者**（spec §2.3，mirror
    `codex_usage.rs::CodexFoldState`）：把 `codex_fold_file` 曾经的内联状态（model/
    speed 游标、`last_total_sig` 去重、plan 快照、两份桶、unaccounted 残差）提
    出来，暴露逐事件 `apply`。fold 与 emitter 驱动**同一份状态机**，「emit 集 ==
    by_model 消费集」是构造出来的，不是事后对齐的。

    `codex_fold_file` 退成薄驱动（new → 逐事件 apply → finish），输出与重构前逐
    字节一致——零漂移由 golden + `both("codex-cost")` 差分看守。
    """

    def __init__(self):
        self.model = None
        self.speed = "standard"
        self.last_total_sig = None
        self.plan = None
        self.by_hour_model = {}
        self.by_model = {}
        self.unaccounted = {}

    def apply(self, event):
        """逐事件推进折叠。判别出口只对 token_count 事件有意义；turn_context /
        thread_settings_applied 只更新游标、返回 NotTokenCount。token_count 分支
        逐字节对应重构前的 `codex_fold_file` 内联体。"""
        if not isinstance(event, dict):
            return CodexTokenOutcome(NOT_TOKEN_COUNT)
        etype = event.get("type")
        if etype == "turn_context":
            payload = event.get("payload")
            if isinstance(payload, dict):
                m = payload.get("model")
                if isinstance(m, str):
                    self.model = m
                s = speed_from_payload(payload)
                if s is not None:
                    self.speed = s
            return CodexTokenOutcome(NOT_TOKEN_COUNT)
        if etype == "event_msg":
            payload = event.get("payload")
            if not isinstance(payload, dict):
                return CodexTokenOutcome(NOT_TOKEN_COUNT)
            ptype = payload.get("type")
            if ptype == "thread_settings_applied":
                s = speed_from_payload(payload)
                if s is not None:
                    self.speed = s
                return CodexTokenOutcome(NOT_TOKEN_COUNT)
            if ptype == "token_count":
                # 配额状态从 token_count 读——**即使 info 为 null 也读**（真实语料
                # 里 info:null 的事件仍带 rate_limits，配额是独立于 token 计量的
                # 状态）。plan_type/has_credits/observed_at 最后看见的赢（事件序即
                # 时间序）；`limits` 走 _combine_plan 保留上一次非空限额——降级快照
                # （primary/secondary 全 null，真实语料 08-27 出过）不该抹掉配额条。
                # 时间戳只取一次，原样串喂 Consumed（emitter 的 event_ts_utc）。
                event_ts_utc = _event_ts(event)
                if event_ts_utc is not None:
                    p = _plan_from_rate_limits(payload.get("rate_limits"), event_ts_utc)
                    if p is not None:
                        self.plan = _combine_plan(p, self.plan)
                info = payload.get("info")
                if not isinstance(info, dict):
                    return CodexTokenOutcome(SKIP)
                total = info.get("total_token_usage")
                # 去重：同一计量复读（total 签名不变）→ Repeat。累计总量单调不减，
                # 连续去重 = 完全去重（实测 366 处重复签名都是连续成对）。签名先于
                # last 校验更新：复读事件即便 last 无效也按 Repeat 处理（与重构前
                # `continue` 落在同一点）。
                if isinstance(total, dict):
                    sig = _total_signature(total)
                    if sig is not None:
                        if self.last_total_sig == sig:
                            return CodexTokenOutcome(REPEAT)
                        self.last_total_sig = sig
                total_tokens = 0
                if isinstance(total, dict):
                    tt = total.get("total_tokens")
                    if isinstance(tt, int) and not isinstance(tt, bool):
                        total_tokens = tt
                facts = codex_token_facts(info.get("last_token_usage"))
                if facts is None:
                    _bump_unaccounted(self.unaccounted,
                                      "token_count_invalid_last_usage", total_tokens)
                    return CodexTokenOutcome(UNREADABLE)
                if self.model is None:
                    # 首个 turn_context 之前：看见了 token、没模型可归。
                    _bump_unaccounted(self.unaccounted,
                                      "token_count_before_turn_context", total_tokens)
                    return CodexTokenOutcome(UNATTRIBUTED)
                hour = codex_hour_of(event)
                if hour is not None:
                    _add_bucket(self.by_hour_model.setdefault(hour, {}),
                                self.model, self.speed, facts)
                _add_bucket(self.by_model, self.model, self.speed, facts)
                return CodexTokenOutcome(CONSUMED, facts, self.model, event_ts_utc)
            return CodexTokenOutcome(NOT_TOKEN_COUNT)
        return CodexTokenOutcome(NOT_TOKEN_COUNT)

    def finish(self):
        """折叠收尾：小时升序、unaccounted 按 type 名升序、plan 快照或 None。与
        重构前的 `codex_fold_file` 尾部逐字节一致（Rust 侧 BTreeMap 排序、serde_json
        Map 插入序对齐——键序是字节一致的一部分，不能重排）。"""
        by_hour_out = {}
        for h in sorted(self.by_hour_model):
            by_hour_out[h] = self.by_hour_model[h]
        unaccounted_out = [
            {"type": t, "count": v["count"], "tokens_seen": v["tokens_seen"]}
            for t, v in sorted(self.unaccounted.items())
        ]
        return {"by_hour_model": by_hour_out, "by_model": self.by_model,
                "unaccounted": unaccounted_out, "plan": self.plan}


def codex_fold_file(events):
    """单文件有序折叠：一份 rollout 的原始条目流 → `{by_hour_model, by_model,
    unaccounted, plan}`。纯函数，不碰文件系统——I/O 在适配器层。

    薄驱动：`CodexFoldState` → 逐事件 apply → finish（spec §2.3 byte-neutral
    refactor）。折叠语义（为什么读 last 不读累计、复读去重、plan 快照、游标）见
    `CodexFoldState`；输出顺序是字节一致的一部分（Rust 侧 BTreeMap 排序）。
    """
    state = CodexFoldState()
    for event in events:
        state.apply(event)
    return state.finish()


def codex_merge_folds(folds):
    """跨文件合并：多个 `codex_fold_file` 的结果逐桶求和。纯函数。

    顺序确定性（字节一致的一部分）：小时**全局升序**（先收集全部小时排序，再按序
    遍历——跨文件时插入序不可靠）；每个小时内的模型、速度按**跨文件首现序**（按
    folds 顺序）。`by_model` 按 folds 顺序。`unaccounted` 按 type 名升序求和。
    `plan` 取 `observed_at` 最大者（各会话的配额快照不同，选「最新」的那个；平手
    先见者赢——按 folds 顺序，确定性）；`limits` 单独取「最后看见的非空限额」——
    最新快照是降级形态（primary/secondary 全 null）时不抹掉配额条（见
    `_combine_plan`，与单文件折叠同一语义）。
    """
    all_hours = set()
    for fold in folds:
        bh = fold.get("by_hour_model")
        if isinstance(bh, dict):
            all_hours.update(bh.keys())

    by_hour_out = {}
    for h in sorted(all_hours):
        hour_map = {}
        for fold in folds:
            bh = fold.get("by_hour_model")
            if not isinstance(bh, dict):
                continue
            models = bh.get(h)
            if not isinstance(models, dict):
                continue
            for m, speeds in models.items():
                if not isinstance(speeds, dict):
                    continue
                for spd, bucket in speeds.items():
                    _add_bucket(hour_map, m, spd, _bucket_to_array(bucket))
        by_hour_out[h] = hour_map

    by_model = {}
    for fold in folds:
        bm = fold.get("by_model")
        if not isinstance(bm, dict):
            continue
        for m, speeds in bm.items():
            if not isinstance(speeds, dict):
                continue
            for spd, bucket in speeds.items():
                _add_bucket(by_model, m, spd, _bucket_to_array(bucket))

    unaccounted = {}
    for fold in folds:
        ua = fold.get("unaccounted")
        if not isinstance(ua, list):
            continue
        for e in ua:
            if not isinstance(e, dict):
                continue
            t = e.get("type")
            if not isinstance(t, str):
                t = ""
            c = e.get("count")
            s = e.get("tokens_seen")
            entry = unaccounted.setdefault(t, {"count": 0, "tokens_seen": 0})
            entry["count"] += c if isinstance(c, int) and not isinstance(c, bool) else 0
            entry["tokens_seen"] += s if isinstance(s, int) and not isinstance(s, bool) else 0

    unaccounted_out = [
        {"type": t, "count": v["count"], "tokens_seen": v["tokens_seen"]}
        for t, v in sorted(unaccounted.items())
    ]
    # plan_type/has_credits/observed_at 取 observed_at 最大者；`limits` 单独取
    # 「最后看见的**非空**限额」（limits_plan 里带 limits 的那份）——与单文件折叠
    # 同一语义：某文件的最后一次快照是降级形态（primary/secondary 全 null）时，
    # 别把别的文件带来的配额条抹掉。最后 _combine_plan 把二者合一。
    plan_out = None
    limits_plan = None
    for fold in folds:
        p = fold.get("plan")
        if not isinstance(p, dict):
            continue
        oa = p.get("observed_at", "")
        if plan_out is None or oa > plan_out.get("observed_at", ""):
            plan_out = p
        if isinstance(p.get("limits"), dict):
            if limits_plan is None or oa > limits_plan.get("observed_at", ""):
                limits_plan = p
    if plan_out is not None and limits_plan is not None:
        plan_out = _combine_plan(plan_out, limits_plan)
    return {"by_hour_model": by_hour_out, "by_model": by_model,
            "unaccounted": unaccounted_out, "plan": plan_out}


def codex_aggregate_hours(by_hour_model):
    """时间轴小时桶 → 日期桶：`by_hour_model`（{hour:{model:{speed:桶}}}）逐小时
    求和折回 `by_date_model`（{date:{model:{speed:桶}}}）。小时键 `YYYY-MM-DDTHH`
    取前 10 位成日期；日期升序（小时已升序，逐小时插入即升序）。

    **longContext 判定的粒度锚点**：`codex_cost_report` 按**单日聚合桶**判 LC
    （"这一次请求的上下文超窗"按日看），不按小时桶——小时桶拆开会把一日的大请求
    摊薄成不触发的小桶（踩过的坑：合并桶又会让多日小请求累加成假超窗）。所以
    hour 折叠 → date 聚合 → 按日计价是必须的投影，不是可选的便利。
    """
    out = {}
    if not isinstance(by_hour_model, dict):
        return out
    for h, hour_map in by_hour_model.items():
        date = h[:10]
        date_map = out.setdefault(date, {})
        if not isinstance(hour_map, dict):
            continue
        for m, speeds in hour_map.items():
            if not isinstance(speeds, dict):
                continue
            for spd, bucket in speeds.items():
                _add_bucket(date_map, m, spd, _bucket_to_array(bucket))
    return out


def codex_by_model_from_hours(by_hour_model, prefix=None):
    """时间轴投影 → 模型轴投影：`by_hour_model`（{hour:{model:{speed:桶}}}）逐桶
    求和折回 `by_model`（{model:{speed:桶}}）。模型/速度按**跨小时首现序**（小时
    已升序，逐小时插入即首现序），与 `codex_fold_file` 的模型轴同一约定。

    `prefix`（可选）按小时键前缀过滤：`--today` 传 `YYYY-MM-DD`、`--month` 传
    `YYYY-MM`（小时键 `YYYY-MM-DDTHH` 用 `startswith` 匹配）。

    踩过的坑：`codex-cost --month` 过滤时间轴后，by_model 必须**重算**——过滤掉了
    哪些小时，模型轴就必须同样丢掉那些 token，否则 per_model 里残留被过滤时间的
    用量，days 与 per_model 对不上（守恒测试红）。一开始想当然拿 `codex_merge_folds`
    把过滤后的时间轴 "折回去"，但 merge 的 by_model **只读各 fold 的 `by_model`
    字段**、从不读时间轴，传 `{"by_model": {}}` 得到的是空模型轴——整份月报告静默
    变全零（per_model 空 + unpriced 0 → 返回 None → 全零兜底），一个「看不见的错」。
    重算不是新数据：`by_model == Σ 各小时桶`（同一折叠的两投影，usage.rs 时间轴
    守恒同款纪律），无时间样本没有小时桶、被过滤按设计丢弃。
    """
    out = {}
    if not isinstance(by_hour_model, dict):
        return out
    for h, hour_map in by_hour_model.items():
        if prefix is not None and not h.startswith(prefix):
            continue
        if not isinstance(hour_map, dict):
            continue
        for m, speeds in hour_map.items():
            if not isinstance(speeds, dict):
                continue
            for spd, bucket in speeds.items():
                _add_bucket(out, m, spd, _bucket_to_array(bucket))
    return out


def codex_day_tokens(by_date_model, day_key):
    """`sessions navigation` 的 Codex 今日 token：`codex_aggregate_hours` 的日期桶
    （{date:{model:{speed:桶}}}）→ 当日 5 桶全模型/全速度求和（spec §5.2
    `basis="events"`，与 codex-cost 的 days[].tokens 同一求和口径）。None =
    该日没有 token 事件被折入（「测不出」，不是 0——「今天没跑」与「今天没测到」
    是两个词；零会话的真零由调用方按 store 判）。mirror
    `codex_usage.rs::codex_day_tokens`。"""
    if not isinstance(by_date_model, dict):
        return None
    day_map = by_date_model.get(day_key)
    if not isinstance(day_map, dict):
        return None
    total = 0
    for speeds in day_map.values():
        if not isinstance(speeds, dict):
            continue
        for bucket in speeds.values():
            total += sum(_bucket_to_array(bucket))
    return total


def unaccounted_tokens_seen(unaccounted):
    """折叠残差哨兵：`unaccounted` 条目（`{type, count, tokens_seen}` 列表）的
    `tokens_seen` 总和。>0 → 有 token 看见了没接住，当日数可能是下界 →
    coverage=partial（spec §5.2；全时段残差，当日粒度不重算）。mirror
    `codex_usage.rs::unaccounted_tokens_seen`。"""
    if not isinstance(unaccounted, list):
        return 0
    total = 0
    for e in unaccounted:
        if not isinstance(e, dict):
            continue
        v = e.get("tokens_seen")
        if isinstance(v, int) and not isinstance(v, bool):
            total += v
    return total
