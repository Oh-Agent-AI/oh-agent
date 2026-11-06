"""Codex 成本计价的 Python 平行实现。

单一真相源是 `apps/cli/src/agent/codex_cost.rs`——那里有一份完整的中文注释讲
**计价铁律**（为什么 cache_write 全进 5m 档、为什么 speed 是 catalog 独立行而
不是乘数、为什么 longContextPriced:false 不触发乘数、为什么最长前缀匹配）。这
一份是它的逐字节镜像，由 `tests/test_cli_matrix.py::both("codex-cost", ...)`
差分看守。

与 `cost.py` 的关系：`cost.py` 是 DSH（¥、peak/off-peak、provider 分层）的计价；
本模块是 Codex（USD、5 桶、speed 行、longContext），**不是**给 DSH 的成本引擎
套 Codex 壳。价格表 `codex_pricing.json` 独立于 `pricing.json`，v0.8 Phase E5
起两者一起搬进仓库根 `assets/`（三方共读，不是 Python 包私有数据）。
"""
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .codex_usage import CODEX_TOKEN_FIELDS, codex_aggregate_hours
from . import state as state_mod

# packages/agent-vitals-python/agent_vitals/agent/codex_cost.py → 仓库根爬 5 层。
_CODEX_PRICING_PATH = Path(__file__).resolve().parents[4] / "assets" / "codex_pricing.json"

# Compatibility name retained for callers; statistics use the OS IANA timezone.
_BEIJING = timezone(timedelta(hours=8))


def _system_timezone():
    # Keep all Python entry points on the same persisted preference resolver as
    # state.py.  This is important because the desktop can change the
    # statistics timezone without changing the process' inherited TZ.
    return state_mod._system_timezone()


def current_month_beijing():
    """系统统计时区当前自然月 → `YYYY-MM`。兼容旧函数名。"""
    return datetime.now(_system_timezone()).strftime("%Y-%m")


def today_beijing():
    """系统统计时区今天 → `YYYY-MM-DD`。兼容旧函数名。"""
    return datetime.now(_system_timezone()).date().isoformat()


def load_codex_pricing():
    with open(_CODEX_PRICING_PATH, encoding="utf-8") as f:
        return json.load(f)


def _strip_zero(x):
    """`f"{x:.1f}"` 去掉尾随 `.0`（226.4 保持，226.0 → 226）。"""
    s = f"{x:.1f}"
    return s[:-2] if s.endswith(".0") else s


def format_number(n):
    """token 数 → 人类可读：226423948 → 226.4M。与 cost.py::format_number 同 spec。"""
    if n >= 1_000_000_000:
        return _strip_zero(n / 1e9) + "B"
    if n >= 1_000_000:
        return _strip_zero(n / 1e6) + "M"
    if n >= 1_000:
        return _strip_zero(n / 1e3) + "K"
    return str(int(n))


def format_usd(x):
    """金额 → `$12.34` / `$123.4`。≥100 一位小数否则两位，去尾零。与
    cost.py::format_money 同一 spec，前缀换成 `$`（USD）。"""
    s = f"{x:.1f}" if x >= 100 else f"{x:.2f}"
    s = s.rstrip("0").rstrip(".")
    return "$" + s


def _rate(entry, key):
    """价格表条目里的金额是**字符串**（cc-trace 原样，避免浮点漂移），解析成 float。"""
    v = entry.get(key)
    try:
        return float(v) if isinstance(v, str) else 0.0
    except (TypeError, ValueError):
        return 0.0


def _resolve_entry(model, speed, entries):
    """`(model, speed)` → 价格表条目：**最长 modelPrefix 匹配**（`gpt-5.6-sol` 命中
    sol 行而非 `gpt-5.6` 泛化行）。同长度时先出现的条目赢（catalog 数组序即作者
    意图）。Codex session 的 `model_raw` 可能带 provider 路由前缀
    （如 `openai/gpt-5.6-sol`），匹配前只剥掉前缀；输出仍保留原始模型名。
    找不到 → None（unpriced）。"""
    match_model = str(model).rsplit("/", 1)[-1]
    best = None
    best_len = 0
    for e in entries:
        if e.get("speed") != speed:
            continue
        prefix = e.get("modelPrefix")
        if not isinstance(prefix, str):
            continue
        if len(prefix) > best_len and match_model.startswith(prefix):
            best_len = len(prefix)
            best = e
    return best


def _lc_multipliers(bucket, entry):
    """longContext 乘数判定。

    官方门槛属于单次请求，聚合后的小时/日桶不足以提供证据；没有
    `perRequestLongContextEvidence:true` 一律返回 None，避免把累计用量误收为附加费。

    若未来适配器保留了请求级事实，调用方可传入该事实对应的桶并启用乘数。
    """
    # The rollout fold currently preserves aggregate buckets, not a request's
    # actual input size.  Aggregates cannot prove the official >272K-request
    # condition, so never infer the surcharge from them.
    if entry.get("perRequestLongContextEvidence") is not True:
        return None
    threshold = entry.get("longContextThresholdTokens", 0)
    if not isinstance(threshold, int) or isinstance(threshold, bool):
        # 非整数 threshold（防御）：Rust 侧 as_i64 → None → 0，两侧一致。
        threshold = 0
    # `longContextPriced` 缺省 true：standard 行靠「有 threshold + 有乘数」触发；
    # fast 行显式 `false` → fast + longContext 不乘（catalog 里 fast 行都带这个
    # false，见 codex_pricing.json `_note`）。
    lc_priced = entry.get("longContextPriced", True)
    input_total = (bucket.get("uncached_input_tokens", 0)
                   + bucket.get("cached_input_tokens", 0)
                   + bucket.get("cache_write_input_tokens", 0))
    if threshold > 0 and input_total > threshold and lc_priced is not False:
        return (entry.get("longContextInputMultiplierBps", 20000) / 10000.0,
                entry.get("longContextOutputMultiplierBps", 15000) / 10000.0)
    return None


def _price_bucket(bucket, entry, lc=None):
    """一个 5 桶对象 × 价格条目 → USD 费用。`reasoning` 桶存在但不参与计价——
    它已含在 `output` 里（折叠侧的校验保证 `output >= reasoning`），再乘一次就是
    双计。`lc`（可选）= 调用方预判的 `(lc_in, lc_out)` 乘数——小时轴用它把**单日
    聚合桶**的 LC 判定线性应用到每个小时桶（见 `_lc_multipliers`）；缺省按本桶
    自己判（日期轴，桶即聚合桶，判定与 `_lc_multipliers` 等价）。"""
    uncached = bucket.get("uncached_input_tokens", 0)
    cached = bucket.get("cached_input_tokens", 0)
    cache_write = bucket.get("cache_write_input_tokens", 0)
    output = bucket.get("output_tokens", 0)
    input_cost = (
        uncached * _rate(entry, "uncachedInputUsdPerMTok")
        + cached * _rate(entry, "cacheReadUsdPerMTok")
        + cache_write * _rate(entry, "cacheWrite5mUsdPerMTok")
    )
    output_cost = output * _rate(entry, "outputUsdPerMTok")
    if lc is None:
        lc = _lc_multipliers(bucket, entry)
    if lc is not None:
        input_cost *= lc[0]
        output_cost *= lc[1]
    return (input_cost + output_cost) / 1e6


def _bucket_fields(bucket):
    return tuple(bucket.get(f, 0) for f in CODEX_TOKEN_FIELDS)


def _tokens_object(t):
    return dict(zip(CODEX_TOKEN_FIELDS, t))


def _window_label(wm):
    """窗口分钟数 → 人读标签：300→`5小时`、10080→`每周`、其余 → `Nmin`。与 Codex
    UI 同款（「5 小时使用限额 / 每周使用限额」）；未知窗口不猜语义，照实显示分钟数。
    py↔rs 同 spec，文本渲染逐字节对齐（Rust `window_label` 镜像）。"""
    if isinstance(wm, bool) or not isinstance(wm, int):
        wm = 0
    if wm == 300:
        return "5小时"
    if wm == 10080:
        return "每周"
    return "%smin" % wm


def _pct_text(up):
    """`used_percent` → 人读百分比：固定 3 位小数去尾零（67.0 → 67，67.5 →
    67.5）。**不用 `:g`**——它对大数会转科学计数法，与 Rust 的 Display 分歧；
    `:.3f` + 去尾零在两侧完全确定（Rust `pct_text` 同款）。"""
    s = f"{up:.3f}".rstrip("0").rstrip(".")
    return s if s else "0"


def _reset_beijing_text_at(resets_at, today):
    """resets_at（Unix 秒）→ 北京时区人读重置时间：今天 → `HH:MM`，否则 →
    `M月D日 HH:MM`（与 Codex UI 同款：「重置时间：10:03」vs「2026年9月4日 00:40」）。
    `today` 参数化以便单测钉住两个分支；生产路径传 `today_beijing()`。
    Rust `reset_beijing_text_at` 镜像（同 spec，逐字节对齐）。"""
    dt = datetime.fromtimestamp(resets_at, _system_timezone())
    if dt.date().isoformat() == today:
        return dt.strftime("%H:%M")
    return "%s月%s日 %s" % (dt.month, dt.day, dt.strftime("%H:%M"))


def _reset_beijing_text(resets_at):
    return _reset_beijing_text_at(resets_at, today_beijing())


def _plan_line(plan):
    """plan 块 → 人读一行（None = 无有效套餐，不打印）。数字只格式化不重算——
    `used_percent` 直接来自日志 rate_limits。**「剩余」= 100 − used**（Codex UI
    显示剩余，超限按 0 计）；重置时间挂北京（今天 → `HH:MM`，否则 → `M月D日
    HH:MM`）。末尾附快照时间戳（ISO 原样）标注日志滞后。与 Rust 侧 `plan_line`
    逐字节对齐。"""
    if not isinstance(plan, dict):
        return None
    pt = plan.get("plan_type")
    if not isinstance(pt, str) or not pt:
        return None
    parts = [pt + "（订阅套餐）"]
    limits = plan.get("limits")
    if isinstance(limits, dict):
        for _name, win in limits.items():
            if not isinstance(win, dict):
                continue
            up = win.get("used_percent")
            if isinstance(up, bool) or not isinstance(up, (int, float)):
                continue
            remaining = max(0.0, 100.0 - up)
            piece = "%s 剩余%s%%" % (_window_label(win.get("window_minutes")),
                                     _pct_text(remaining))
            resets = win.get("resets_at")
            if isinstance(resets, (int, float)) and not isinstance(resets, bool):
                piece += "（重置 %s）" % _reset_beijing_text(int(resets))
            parts.append(piece)
    obs = plan.get("observed_at")
    if isinstance(obs, str) and obs:
        parts.append("快照@" + obs)
    return " · ".join(parts)


def codex_cost_report(by_hour_model, by_model, unaccounted, plan, pricing, want_hours=False):
    """折叠结果 × 价格表 → 结构化成本报告。**这是唯一算价格的地方**——人读文本、
    `--json`、`--html` 都从这里取数，不是三处各算一遍。

    `by_hour_model` 是折叠的时间轴（小时桶键 `YYYY-MM-DDTHH`，统一多桶折叠契约）。
    先 `codex_aggregate_hours` 聚合成单日桶再计价；`want_hours=True` 时另输出 `hours`
    供 today 视图渲染小时热力图。

    `plan` 是折叠出的配额快照（dict 或 None），原样透传到输出——报告不解释它，
    展示层自己判「订阅 → 重标价」。

    `None` = 没有任何 token 可计价（空折叠：per_model 空、unpriced 0）。有未计价
    token 时返回 dict（total 0 + unpriced > 0 是「看见了、没价目」的诚实上报）。

    官方的长上下文附加价不能从聚合桶中推断：月/日累计超过阈值均不说明某次请求
    超过阈值。当前实现因此报告基础用量价格；以后若 fold 保留每请求证据，可由
    价格条目显式启用该项。per_model = 各日期价 + untimed 剩余，所有样本带时间时
    `sum(days.cost) == total_cost_usd`。
    """
    if not isinstance(by_model, dict):
        return None
    entries = pricing.get("entries") or []

    # ── Pass 0：时间轴聚合 + 日期轴计价 ──────────────────────────────
    # 小时桶先按日聚合（`codex_aggregate_hours`），LC 判定粒度锚定在单日聚合桶；
    # 同时记下每个 (model, spd) 的「有日期份额」成本与 token，供 per_model 轴
    # 求 untimed 剩余用。by_date_model 键序 = 聚合的日期升序，days 保持升序。
    by_date_model = (codex_aggregate_hours(by_hour_model)
                     if isinstance(by_hour_model, dict) else {})
    dated_cost = {}    # (model, spd) -> USD 费用（只含有价目桶）
    dated_tokens = {}  # (model, spd) -> [5 桶]
    days = []
    for date, date_map in by_date_model.items():
        if not isinstance(date_map, dict):
            continue
        cost = 0.0
        toks = 0
        for model, speeds in date_map.items():
            if not isinstance(speeds, dict):
                continue
            for spd, bucket in speeds.items():
                if not isinstance(bucket, dict):
                    continue
                facts = _bucket_fields(bucket)
                toks += sum(facts[:4])
                key = (model, spd)
                dt = dated_tokens.get(key)
                if dt is None:
                    dt = [0] * 5
                    dated_tokens[key] = dt
                for i in range(5):
                    dt[i] += facts[i]
                entry = _resolve_entry(model, spd, entries)
                if entry is not None:
                    c = _price_bucket(bucket, entry)
                    cost += c
                    dated_cost[key] = dated_cost.get(key, 0.0) + c
        days.append({"date": date, "cost_usd": cost, "tokens": toks})

    # ── Pass 0b：小时轴计价（today 视图） ─────────────────────────────
    # 小时桶直接按基础费率计价。小时升序。
    hours = []
    if want_hours and isinstance(by_hour_model, dict):
        for h in sorted(by_hour_model):
            hour_map = by_hour_model[h]
            if not isinstance(hour_map, dict):
                continue
            cost = 0.0
            toks = 0
            for model, speeds in hour_map.items():
                if not isinstance(speeds, dict):
                    continue
                for spd, bucket in speeds.items():
                    if not isinstance(bucket, dict):
                        continue
                    facts = _bucket_fields(bucket)
                    toks += sum(facts[:4])
                    entry = _resolve_entry(model, spd, entries)
                    if entry is not None:
                        cost += _price_bucket(bucket, entry)
            hours.append({"hour": h, "cost_usd": cost, "tokens": toks})

    # ── Pass 1：per_model / 总价 / 未计价 ──────────────────────────────
    # 遍历顺序 = 折叠的模型首现序（Python dict 插入序），与 Rust preserve_order 对齐。
    total = 0.0
    unpriced = 0
    total_tokens = [0] * 5
    per_model = {}
    for model, speeds in by_model.items():
        if not isinstance(speeds, dict):
            continue
        tokens = [0] * 5
        cost = 0.0
        all_priced = True
        speed_names = []
        for spd, bucket in speeds.items():
            if not isinstance(bucket, dict):
                continue
            facts = _bucket_fields(bucket)
            for i in range(5):
                tokens[i] += facts[i]
            entry = _resolve_entry(model, spd, entries)
            if entry is not None:
                key = (model, spd)
                dated = dated_tokens.get(key) or [0] * 5
                # untimed 剩余 = by_model − Σ 各日期桶（fold 保证逐桶 ≥，不会负）。
                untimed = [facts[i] - dated[i] for i in range(5)]
                cost += (dated_cost.get(key, 0.0)
                         + _price_bucket(_tokens_object(untimed), entry))
            else:
                # 无价目：token 进 unpriced_tokens，诚实上报——绝不按 0 价冒充。
                all_priced = False
                for i in range(4):
                    unpriced += facts[i]
            speed_names.append(spd)
        for i in range(5):
            total_tokens[i] += tokens[i]
        total += cost
        per_model[model] = {
            "tokens": _tokens_object(tokens),
            "cost_usd": cost,
            "priced": all_priced,
            # 模型名下可能挂多个 speed 子桶（真实数据只有 standard）；诚实列出
            # 全部 speed，不挑一个代表。
            "speed": ",".join(speed_names),
        }
    if not per_model and unpriced == 0:
        return None

    out = {
        "total_cost_usd": total,
        "total_tokens": _tokens_object(total_tokens),
        "per_model": per_model,
        "days": days,
        "unpriced_tokens": unpriced,
        "unaccounted_usage": unaccounted if isinstance(unaccounted, list) else [],
        "plan": plan,
    }
    if want_hours:
        out["hours"] = hours
    return out


def render_codex_cost(out):
    """人读文本：harness/月/币种 + 一行总费用 + 每模型一行。纯格式化——数字来自
    `codex_cost_report` + CLI 的 harness/currency/month 包装（`out` 即 `--json` 输出的
    同一个 dict），这里不重算。空报告（None）由调用方处理，不打印假的 `$0` 行。
    Rust 侧 `main.rs::render_codex_cost` 逐字节对齐这一份。"""
    currency = out.get("currency", "USD")
    harness = out.get("harness")
    month = out.get("month")
    total = out.get("total_cost_usd", 0.0)
    unpriced = out.get("unpriced_tokens", 0)
    per_model = out.get("per_model") or {}
    tt = out.get("total_tokens") or {}

    parts = []
    if isinstance(harness, str):
        parts.append(f"harness: {harness}\n")
    if isinstance(month, str):
        parts.append(f"month: {month}\n")
    parts.append(f"currency: {currency}\n")
    plan_line = _plan_line(out.get("plan"))
    if plan_line is not None:
        parts.append(f"plan: {plan_line}\n")
    # reasoning 是 output 的子集，故人读总量只加 4 个独立桶。
    all_tokens = sum(
        tt.get(f, 0) for f in CODEX_TOKEN_FIELDS[:4]
        if isinstance(tt.get(f), int) and not isinstance(tt.get(f), bool)
    )
    # 订阅套餐（plan 存在）时，per-token 美元是「按量标价」不是账单——账单 = 套餐
    # 固定费。诚实标注，别让用户把标价当成实际支出。
    label = "total cost (按量标价)" if plan_line is not None else "total cost"
    line = f"{label}: {format_usd(total)}"
    if all_tokens > 0:
        line += f" · total tokens: {format_number(all_tokens)}"
    parts.append(line + "\n")
    # 按折叠的模型首现序展示（per_model 的插入序即 by_model 序）。
    for model, entry in per_model.items():
        if not isinstance(entry, dict):
            continue
        cost = entry.get("cost_usd", 0.0)
        speeds = entry.get("speed", "standard")
        if entry.get("priced"):
            parts.append(f"  {model}  {format_usd(cost)}  ({speeds})\n")
        else:
            parts.append(f"  {model}  unpriced  ({speeds})\n")
    if unpriced > 0:
        parts.append(f"另有 {format_number(unpriced)} tokens 模型未计价\n")
    for e in (out.get("unaccounted_usage") or []):
        if not isinstance(e, dict):
            continue
        t = e.get("type", "?")
        c = e.get("count", 0)
        s = e.get("tokens_seen", 0)
        parts.append(f"未接住 {c} × {t}（看见 {format_number(s)} tokens）\n")
    return "".join(parts)
