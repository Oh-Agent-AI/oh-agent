"""CLI 显示层的成本块 —— 把 usage 报告变成人读的费用行。

纯展示层，不做任何折叠（折叠在 `usage.py`，`peak_*` 子桶已经按每笔请求自己
的 time 精确标出高峰时段）：这里只把 `{by_model, sequence}` × 价格表
（`pricing.json`）变成一组字符串，off-peak 份额（全量 − peak）按空闲价、
peak 份额按高峰价，加总成一个真实发生的费用——不再是「给空闲价和高峰价两个
数，猜不出实际该按哪个算」的区间估算。与 `crates/agent-vitals-domain/src/domain/cost/mod.rs` 逐字节一致，由
`tests/test_cli_matrix.py` 的 `both()` 差分看守。

价格表的权威源是 `catalog/pricing/pricing.json`，`assets/pricing.json` 是CI校验的
逐字节兼容镜像（v0.8 Phase E5 从包内搬到仓库根的
`assets/`——它被 Rust、Python、DSH client 三方共读，不是 Python 包私有数据；
Rust 侧用 `include_str!` 内嵌、本模块用 `Path(__file__).resolve().parents[4]`
爬回仓库根读同一份文件；`integrations/dsh-client/src/client/styles/index.ts`
因浏览器读不到 repo 文件，内嵌自己的 PRICING 副本，lockstep 测试对齐）。
缓存写入报价表没有行 → 按 0 计
（不臆造价格）。高峰时段为北京时间**周一至周五** 9–12、14–18 点，周末全天
空闲；空闲价 = 高峰价的一半。
"""
import json
from pathlib import Path

from .usage import AMBIGUOUS_PROVIDER

# packages/agent-vitals-python/agent_vitals/agent/cost.py → 仓库根需要爬 5 层
# （agent/ → agent_vitals/ → agent-vitals-python/ → packages/ → 根）。
_PRICING_PATH = Path(__file__).resolve().parents[4] / "assets" / "pricing.json"


def load_pricing():
    with open(_PRICING_PATH, encoding="utf-8") as f:
        return json.load(f)


def _strip_zero(x):
    """`f"{x:.1f}"` 去掉尾随 `.0`（226.4 保持，226.0 → 226）。"""
    s = f"{x:.1f}"
    return s[:-2] if s.endswith(".0") else s


def format_number(n):
    """token 数 → 人类可读：226423948 → 226.4M。与 tab 的 formatNumber 同 spec。"""
    if n >= 1_000_000_000:
        return _strip_zero(n / 1e9) + "B"
    if n >= 1_000_000:
        return _strip_zero(n / 1e6) + "M"
    if n >= 1_000:
        return _strip_zero(n / 1e3) + "K"
    return str(int(n))


def format_money(x):
    """金额 → `¥774.7` / `¥22.4` / `¥6.73`。≥100 一位小数否则两位，去尾零。"""
    s = f"{x:.1f}" if x >= 100 else f"{x:.2f}"
    s = s.rstrip("0").rstrip(".")
    return "¥" + s


def _models_of(pricing, provider):
    """某个供应商的模型表；找不到该供应商返回 None。"""
    p = (pricing.get("providers") or {}).get(provider)
    return (p or {}).get("models")


def _norm_model_in(model, cards):
    """`deepseek/deepseek-v4-pro-0813` → 价格卡键 `deepseek-v4-pro`，在**指定
    供应商的表里**匹配；匹配不上返回 None（不臆造）。"""
    seg = str(model).split("/")[-1]
    if seg in cards:
        return seg
    # 最长前缀而非「第一个命中」：旧写法让 claude-opus-5-5 吃到 claude-opus-5 的卡，
    # 且因「有卡」永远不报缺价（2026-09-29 真机）。与 Rust `cost/mod.rs::norm_model_in` 对等。
    hits = [key for key in cards if seg.startswith(key) and _suffix_is_same_model(seg[len(key):])]
    if not hits:
        return None
    return max(hits, key=len)


_TIERS = frozenset({"pro", "mini", "nano", "max", "lite", "flash", "flashx", "air", "turbo",
                    "plus", "ultra", "prime", "fast", "code", "codex"})


def _suffix_is_same_model(rest):
    """前缀之后剩下的部分是否仍指同一模型：日期快照、发布标记、模式标注是；新的
    版本号（-5、.1）、档位（-pro、-flash…）、紧贴的字母数字（glm-5 → glm-5v）不是。
    与 Rust `suffix_is_same_model` 逐条对应。"""
    if not rest:
        return True
    first = rest[0]
    if first.isascii() and first.isalnum():
        return False
    if first == ".":
        return not (len(rest) > 1 and rest[1].isascii() and rest[1].isdigit())
    if first in "-_":
        token = ""
        for c in rest[1:]:
            if c in "-_.":
                break
            token += c
        token = token.lower()
        if token and len(token) <= 2 and all(c.isascii() and c.isdigit() for c in token):
            return False
        if token in _TIERS:
            return False
    return True


def _resolve_card(model, provider, pricing):
    """解析 (供应商, 模型) 实际适用的价格卡 → (模型键, 供应商键, 依据) 或 None。

    顺序：该供应商自己的表 → 回落 fallback_provider（原厂）的同名模型 → 都没有
    才算未计价。**回落是有意的默认行为**：供应商没报价时给一个标注了来源的
    估算，比什么都不给有用；但依据（"fallback"）必须一路传到展示层，由它写明
    「按原厂报价估算」，否则就是拿别家的价冒充实价。
    """
    # 归属不明：哨兵不是真实供应商名，查不到它的表，会一路掉到回落分支。
    # 单独认出来是为了让展示层说对话——也顺带保证这个内部哨兵**永远不会**被
    # 当成供应商名渲染给用户看。
    ambiguous = provider == AMBIGUOUS_PROVIDER
    if provider and not ambiguous:
        cards = _models_of(pricing, provider)
        if cards:
            key = _norm_model_in(model, cards)
            if key is not None:
                return key, provider, "provider"
    fb = pricing.get("fallback_provider")
    if not fb:
        return None
    cards = _models_of(pricing, fb)
    if not cards:
        return None
    key = _norm_model_in(model, cards)
    if key is None:
        return None
    return key, fb, ("ambiguous" if ambiguous else "fallback")


def model_short(model, pricing):
    fb = pricing.get("fallback_provider")
    cards = _models_of(pricing, fb) if fb else None
    if cards:
        key = _norm_model_in(model, cards)
        if key:
            return key
    return str(model).split("/")[-1][:24]


def _price(buckets, model_key, provider_key, pricing):
    """一个模型桶 → (真实总价, 其中高峰份额的价, 其中缓存命中单独的价)。把
    每种 token 类型拆成高峰份额（peak_*）和空闲份额（全量 − peak_*），各按
    各自单价计价再相加——不是「全量按空闲价」和「全量按高峰价」两个假设性
    区间。`cache_read_cost` 不是另一个独立的桶，是已经算进 total 里那部分
    缓存命中花的钱——单独留出来是为了回答「缓存命中帮我省了多少钱」，
    total 一个数字本身看不出这个切面。"""
    card = pricing["providers"][provider_key]["models"][model_key]
    u_peak = buckets.get("peak_uncached_input_tokens", 0) / 1e6
    c_peak = buckets.get("peak_cache_read_tokens", 0) / 1e6
    o_peak = buckets.get("peak_output_tokens", 0) / 1e6
    u_off = buckets["uncached_input_tokens"] / 1e6 - u_peak
    c_off = buckets["cache_read_tokens"] / 1e6 - c_peak
    o_off = buckets["output_tokens"] / 1e6 - o_peak
    cache_read_cost = (c_off * card["input_cached"]["off_peak"]
                        + c_peak * card["input_cached"]["peak"])
    off = (u_off * card["input_uncached"]["off_peak"]
           + c_off * card["input_cached"]["off_peak"]
           + o_off * card["output"]["off_peak"])
    peak = (u_peak * card["input_uncached"]["peak"]
            + c_peak * card["input_cached"]["peak"]
            + o_peak * card["output"]["peak"])
    return {"total": off + peak, "peak": peak, "cache_read_cost": cache_read_cost}


def fallback_price(buckets, pricing):
    """给一份**没有模型归属**的原始 8 桶按 fallback 模型估个价——`cost_report`
    需要知道"这些 token 是哪个模型"，这里是它唯一的退路，不是另一条计价规则。

    只服务 `cli.py::_augment_calendar_cost` 的"日历某天 by_model 覆盖不全"
    分支（见该函数文档），不在 `crates/agent-vitals-domain/src/domain/cost/mod.rs` 的
    lockstep/差分范围内——
    `calendar` 从来不是 Rust 二进制的子命令，没有 `test_cli_matrix.py` 会
    校验一份 Rust 镜像。calendar.html 的 JS 端已经有一份同语义的硬编码
    近似（`PRICE` 表），这里是它在 Python 侧、直接从 `pricing.json` 读数的
    对应实现，两者近似逻辑一致但不是同一份代码——JS 没有服务端 fetch 能力
    读不到 pricing.json，这是已知、记录在案的限制（见 calendar.html 头部
    注释），不是这里要解决的问题。
    """
    fb_provider = pricing.get("fallback_provider")
    return _price(buckets, "deepseek-v4-flash", fb_provider, pricing)


DAY_BUCKET_FIELDS = (
    "uncached_input_tokens", "output_tokens",
    "cache_read_tokens", "cache_write_tokens",
    "peak_uncached_input_tokens", "peak_output_tokens",
    "peak_cache_read_tokens", "peak_cache_write_tokens",
)


def _sum_by_model(by_model):
    """`by_model` 里每个模型的 8 桶按字段相加，折成一份跟 day/today 顶层
    同形状的 8 桶——用来跟顶层的「真实总量」对账覆盖率。"""
    total = {f: 0 for f in DAY_BUCKET_FIELDS}
    for buckets in by_model.values():
        for f in DAY_BUCKET_FIELDS:
            total[f] += buckets.get(f, 0) or 0
    return total


def priced_day(day, pricing):
    """一份「日桶」（`state.py` month.json/today.json 里那种 8 基础字段 +
    可选 `by_model`）→ `{total, peak_total, pricing_basis, coverage}`，或
    `None`（没有 by_model——调用方自己决定退回哪种近似）。

    **唯一的覆盖率校验入口**——`cli.py` 的日历、`budget.py` 的
    month/7d-average 三处过去各写一份「有没有 by_model 就……」，日历那份
    修过覆盖率之后，budget.py 那两份还在裸用 `by_model`，同一份
    `month.json` 因此在两个投影上报出不同的钱（¥4.50 vs ¥18.00）。三处
    都改调这一个函数，覆盖率的判断只写一次，不会有第四个地方重新引入
    同一个 bug。

    **必须校验覆盖率，不能只看「有没有 by_model」**（真实回归：8 月账目
    一度因为从不校验覆盖率，把只覆盖当天 0.7%~32.5% token 的 by_model
    当成"精算"直接报出去，剩下 67%~99% 的 token 静默消失）。做法：把
    `by_model` 折成跟 `day` 同形状的一份总量，与 `day` 做减法算出"没有
    模型归属的剩余 token"——不是 0 就说明这一天的 `by_model` 只覆盖了
    部分时段（例如一个跨零点的会话只把某一天的切片记了下来），剩余部分
    按 `fallback_price` 补齐，标 `pricing_basis: "partial"`，不假装是
    `"exact"`。
    """
    by_model = day.get("by_model") or {}
    if not by_model:
        return None
    report = cost_report({"by_model": by_model}, pricing)
    if report is None:
        return None
    covered = _sum_by_model(by_model)
    day_total = sum(day.get(f, 0) or 0 for f in DAY_BUCKET_FIELDS)
    covered_total = sum(covered.values())
    remainder_total = max(0, day_total - covered_total)
    if remainder_total == 0:
        return {
            "total": report["total"],
            "peak_total": report["peak_total"],
            "pricing_basis": "exact",
            "coverage": 1.0,
        }
    remainder = {
        f: max(0, (day.get(f, 0) or 0) - covered[f])
        for f in DAY_BUCKET_FIELDS
    }
    top_up = fallback_price(remainder, pricing)
    return {
        "total": report["total"] + top_up["total"],
        "peak_total": report["peak_total"] + top_up["peak"],
        "pricing_basis": "partial",
        # day_total 为 0 时 remainder_total 必是 0，已被上面的分支短路——
        # 到这里 day_total 必然 > 0，除法安全。
        "coverage": covered_total / day_total,
    }


def cost_report(usage, pricing):
    """usage 报告 × 价格表 → 结构化成本数据。**这是唯一算价格的地方**——
    `cost_block`（人读文本）与 `--json` 的 `cost` 键都从这里取数，不是两处
    各算一遍再凑成两种格式。之前 `cost` 完全没有 JSON 出口：想拿这份数字只能
    手写脚本重新调 `_price`/`load_pricing`，算一次就要重新验证一次是否用对了
    价格表——现在报告数据里的 `cost` 字段和人读文本走的是同一次计算。

    无任何可分桶的桶、没有未计价 token、也没有 by_source 时返回 None（与
    `cost_block` 的空列表同一语义：没有数据就是没有，不摆一个全零的结构出来）。
    金额是未四舍五入的原始浮点——舍入是格式化文本时才做的展示决定，结构化数据
    不预先舍。

    `by_source`（`{source: {model: 八桶}}`，调用方已折平，见 `state.rollup_by_source`）
    单独折成 `by_source_cost` 插在**最后**——按来源拆账是诊断「同一批被喂了几
    次」的眼睛，但它不是主账单的一部分，插在中间会破坏已有读方的键序。by_source
    为空/缺场时 `by_source_cost` 键整个不出现，输出与没有该功能的版本逐字节一致。

    Rust 平行实现见 `crates/agent-vitals-domain/src/domain/cost/mod.rs::cost_report`。
    """
    by_model = (usage or {}).get("by_model") or {}
    providers = (usage or {}).get("providers")
    total = 0.0
    peak_total = 0.0
    unpriced = 0
    per_model = {}
    for model, buckets in by_model.items():
        # 价目表**按供应商分层**，不是按模型名一张表打天下。真实日志里
        # provider=shengsuanyun 的 pro 和 provider=deepseek-official 的 flash
        # 并存，两家报价不同（胜算云 DeepSeek 线路缓存读 0.15、Ali 线路 0.45）。
        #
        # 解析顺序见 _resolve_card：该供应商自己的表 → 回落原厂 → 未计价。
        # **回落是有意的默认**：供应商没报价时给一个标注了来源的估算，比什么
        # 都不给有用；但依据必须一路传到展示层写明「按原厂报价估算」。
        #
        # provider 为 None（老日志没上报）时自然回落到原厂——与既有行为一致。
        provider = (providers or {}).get(model)
        if not isinstance(provider, str):
            provider = None
        resolved = _resolve_card(model, provider, pricing)
        if resolved is None:
            unpriced += (buckets["uncached_input_tokens"]
                         + buckets["cache_read_tokens"]
                         + buckets["cache_write_tokens"])
            continue
        key, provider_key, basis = resolved
        p = _price(buckets, key, provider_key, pricing)
        total += p["total"]
        peak_total += p["peak"]
        per_model[model] = {
            "short_name": model_short(model, pricing),
            # 供应商随每一行一起给出：同一会话可能横跨两家，只给模型名的话
            # 这张表跟任何一家的账单都对不上。
            # 归属不明时 provider 落 None——AMBIGUOUS_PROVIDER 是内部哨兵，
            # 绝不能作为供应商名渲染给用户看。
            "provider": None if basis == "ambiguous" else provider,
            # 这一行是按谁的报价算的。fallback 时展示层必须说明。
            "pricing_basis": basis,
            "priced_with": provider_key,
            "total": p["total"],
            "peak": p["peak"],
            "cache_read_cost": p["cache_read_cost"],
        }
    bsc = _build_by_source_cost(usage, pricing)
    if not per_model and unpriced == 0 and bsc is None:
        # by_source 也没有才真的一无所有；有 by_source 就继续（_build_by_source_cost
        # 会单独判断「该来源有无可分桶」，不会摆全零行）。
        return None
    out = {
        "currency": "CNY",
        "estimate_disclaimer": "估算值，不是账单",
        "total": total,
        "peak_total": peak_total,
        "per_model": per_model,
        "unpriced_tokens": unpriced,
    }
    if bsc is not None:
        out["by_source_cost"] = bsc
    return out


def cost_series(requests, providers, pricing):
    """逐请求费用序列（FR-04 的「费用」纵轴，工作台单会话图与 dsh-client 审计
    tab 共用）。与 `crates/agent-vitals-domain/src/domain/cost/mod.rs::cost_series` 及 dsh-client
    执行环境 `costSeriesFrom`（`integrations/dsh-client/src/harness/index.ts`）是**同一规则的三个镜像**，
    锁步一致。

    - 每笔 request 用 `_resolve_card(model, providers[model], pricing)` 定价格卡；
      `is_peak` 为 None（执行环境没上报时间戳）时**这一笔不计价**——累计值保持、
      `priced` 不增，而不是按空闲价猜一档（猜出来的单价就是编数字）。累计曲线
      因此可能低估，`priced/total` 一并透出，展示层照实说。
    - 单笔费用 = (uncached/1e6)×input_uncached[tier] + (cache_read/1e6)×
      input_cached[tier] + (output/1e6)×output[tier]，`tier = is_peak ?
      "peak" : "off_peak"`。**不含 cache_write**——与 `_price` 的计价成分一致，
      曲线终值必须和 `cost` 键对得上。
    - 返回 `{series: [{request_seq, cumulative}], priced, total}`，`series` 与
      `requests` 同序（request_seq 1..n 连续，去重后回填），浏览器逐项 zip 即可
      ——它只在 `usage.request_metrics` 出的数组上做乘加，展示层不再重算价。
    """
    series = []
    acc = 0.0
    priced = 0
    for r in requests:
        model = r.get("model") or "unknown"
        provider = (providers or {}).get(model)
        if not isinstance(provider, str):
            provider = None
        # 与 cost_report 走同一个解析器——逐请求曲线的单价必须和汇总金额同源，
        # 否则曲线终值跟 cost 键对不上。
        resolved = _resolve_card(model, provider, pricing)
        if resolved is not None:
            key, provider_key, _basis = resolved
            is_peak = r.get("is_peak")
            if is_peak is not None:
                tier = "peak" if is_peak else "off_peak"
                card = pricing["providers"][provider_key]["models"][key]
                u = card["input_uncached"].get(tier, 0.0)
                c = card["input_cached"].get(tier, 0.0)
                o = card["output"].get(tier, 0.0)
                acc += ((r.get("uncached_input_tokens") or 0) / 1e6 * u
                        + (r.get("cache_read_tokens") or 0) / 1e6 * c
                        + (r.get("output_tokens") or 0) / 1e6 * o)
                priced += 1
            # is_peak 为 None：这笔不计价，累计保持（carry）。不是 False——
            # 「没测到」不等于「不在高峰」。
        series.append({"request_seq": r.get("request_seq"), "cumulative": acc})
    return {"series": series, "priced": priced, "total": len(requests)}


def _build_by_source_cost(usage, pricing):
    """`usage["by_source"]`（`{source: {model: 八桶}}`，调用方已折平，见
    `state.rollup_by_source`）→ `{source: {total, peak_total, unpriced_tokens}}`。

    每个来源复用 `cost_report` 的主计价循环（把该来源的 `{model: 桶}` 当作
    by_model 传进去），**不在这里长第二份计价规则**。月级数据没有供应商表
    （month.json 不存 providers），所以各来源一律回落原厂价——与 `priced_day`
    对同一份 month.json 的处理一致，同一个来源的钱在两种 surface 上不会算岔。

    来源里全是未知模型 → 该来源只贡献 `unpriced_tokens`，不臆造价格。来源为空
    或缺场 → None（调用方据此决定要不要插 `by_source_cost` 键）。

    Rust 平行实现见 `cost.rs::build_by_source_cost`。
    """
    by_source = (usage or {}).get("by_source") or {}
    if not by_source:
        return None
    out = {}
    for source, models in by_source.items():
        if not isinstance(models, dict):
            continue
        report = cost_report({"by_model": models}, pricing)
        if report is None:
            # 该来源没有任何可分桶的桶（例如空 models）→ 一个真实的零行，不是
            # 编造——来源行存在本身就说明「这个来源喂过但没贡献可分桶」。
            out[source] = {"total": 0.0, "peak_total": 0.0, "unpriced_tokens": 0}
        else:
            out[source] = {
                "total": report["total"],
                "peak_total": report["peak_total"],
                "unpriced_tokens": report["unpriced_tokens"],
            }
    return out or None


def cost_block(usage, pricing):
    """usage 报告 → 成本行列表；无任何可分桶的桶时返回空列表（与 tab 空态同构，
    不打印假的 ¥0 行）。纯格式化——数字来自 cost_report，这里不重算。"""
    report = cost_report(usage, pricing)
    if report is None:
        return []
    total = report["total"]
    peak_total = report["peak_total"]
    unpriced = report["unpriced_tokens"]
    per_model_map = report["per_model"]

    seq = (usage or {}).get("sequence") or []
    line = "费用（估算）≈ " + format_money(total)
    if peak_total > 0:
        line += "（其中高峰时段 " + format_money(peak_total) + "）"
    if len(seq) == 1:
        line += " · " + model_short(seq[0], pricing)
    elif len(seq) > 1:
        line += " · 中途切换模型（" + " → ".join(model_short(m, pricing) for m in seq) + "）"
    rows = [line]
    # per_model 的展示顺序跟 by_model 的原始遍历顺序一致（dict 保留插入序）。
    if len(per_model_map) > 1:
        for model in (usage or {}).get("by_model") or {}:
            entry = per_model_map.get(model)
            if entry is not None:
                rows.append("  " + entry["short_name"] + "  " + format_money(entry["total"]))
    if unpriced > 0:
        rows.append("另有 " + format_number(unpriced) + " tokens 模型未知未计价")
    return rows


# ── Claude Code 语料计价（catalog_2026_09）——独立的第二计价面 ────────────
# 上面的函数全部服务 DSH 运行时账（providers 段，CNY，高峰/空闲拆分）。Claude
# Code 会话文件没有 provider 路由证据（message.model 是唯一计价键），价目表在
# `pricing.json::catalog_2026_09`（按提供商分栏、currency 各异、平费率——没有
# peak/off_peak）。这一段是**独立的第二计价面**：输出全量标
# pricing_basis="catalog"，每个数都是「按官方卡折算的估算」，不许与 DSH 的
# 账单数混加（¥/$ 分桶由调用方分开渲染）。不碰 `_resolve_card`/Basis——新面
# 直接写字面量 "catalog"，DSH 路径零改动、字节稳定。
#
# 计价输入统一用 claude 4 型 snake 键名：input_tokens（uncached，不含缓存写/
# 读——Anthropic API 语义）/cache_read_input_tokens/cache_creation_input_tokens/
# output_tokens；与 claude 行 usage 及 cost-state modelUsage 的语义一一对应。
# Rust 平行实现见 `cost.rs::claude_session_cost`/`claude_day_cost`，数值由两侧
# 同夹具钉测互守（core inline + tests/test_catalog_pricing.py 同数）。


def _resolve_card_catalog(model, pricing):
    """目录卡解析：在 `catalog_2026_09.providers.*` 找模型卡 → 找不到再在顶层
    `providers.*`（deepseek 官方 ¥ 卡；catalog 的 _doc 明说 deepseek 不重复收）
    找。返回 (供应商键, 模型卡键, 币种)——两层都要求显式 `currency`；
    缺币种的卡不得按 CNY 猜价。前缀匹配与 `_norm_model_in` 同一条规则：
    `deepseek-v4-pro[1M]`/`deepseek-v4-pro-0813` 都落 `deepseek-v4-pro`——键是
    短的、模型是长的，**无需为 `[1M]` 变体写剥离代码**。但注意：`[1M]` 档的
    官方价不在任何价表里，按 pro 卡折是记录在案的近似（ee969d0c 有 3.5M in /
    47M cr 走它，不是角落），不是想当然的精确。"""
    catalog = ((pricing.get("catalog_2026_09") or {}).get("providers") or {})
    for provider, pv in catalog.items():
        models = (pv or {}).get("models") or {}
        key = _norm_model_in(model, models)
        if key is not None:
            currency = (pv or {}).get("currency")
            if currency:
                return provider, key, currency
    top = pricing.get("providers") or {}
    for provider, pv in top.items():
        models = (pv or {}).get("models") or {}
        key = _norm_model_in(model, models)
        if key is not None:
            currency = (pv or {}).get("currency")
            if currency:
                return provider, key, currency
    return None


def _catalog_card(pricing, provider, key):
    """目录卡的平费率主体：先 `catalog_2026_09.providers` 再顶层 `providers`
    （deepseek 官方卡）——与 `_resolve_card_catalog` 的两段搜索一一对应。"""
    cat = ((pricing.get("catalog_2026_09") or {}).get("providers") or {})
    if provider in cat:
        card = ((cat[provider] or {}).get("models") or {}).get(key)
        if card is not None:
            return card
    top = pricing.get("providers") or {}
    if provider in top:
        return ((top[provider] or {}).get("models") or {}).get(key)
    return None


def _flat_rate(card, key):
    """平费率读取：`card[key]` 是数字（catalog 平费率/M3 档位）就取它。

    **不再对 `{off_peak, peak}` 时变卡取 off_peak**（v0.6.x 前置热修，
    2026-09-03 撤销）：旧版本在这里把时变卡的 off_peak 单价当"保守估算"
    直接用，实际是拿时间维下界冒充精确——真机对账证明它不是保守而是系统性
    低估（托盘 claude 今日 ¥45.40 vs 官方账单 ¥74.3797，89% 差额来自这一步；
    见 `docs/CLAUDE_COST_DAY_ATTRIBUTION_ANALYSIS.md`，v0.6 spec §5.3 条款 7 /
    §8 G10）。时变卡字段一律经 `_priced_field` 做峰谷拆分计价；这个函数收窄
    成只服务真正平费率的字段（catalog anthropic/moonshot USD 卡、MiniMax
    档位卡），命中 dict 形状时诚实返回 0.0 而不是猜一个方向。"""
    v = card.get(key)
    if isinstance(v, (int, float)):
        return float(v)
    return 0.0


def _priced_field(card, key, total, peak):
    """一个 token 字段（如 `input_uncached`）的计价：`card[key]` 是数字（平
    费率）→ `total × 该价`；是 `{off_peak, peak}` 对象（时变卡）→
    `(total-peak) × off_peak + peak × peak_rate` 分别计价（v0.6 spec §5.3
    条款 7 的峰谷读法，`bucket_price` 族的同一思想）。`peak` 由调用方给出，
    钳制在 `[0, total]` 防御倒挂；调用方对"压根不知道峰谷切分"的输入传
    `peak=0`——这时时变卡会算出与旧下界读法数值相同的结果，但**不是同一件
    事**：这里的 0 只是"没有更多信息"，`pricing_basis` 必须由调用方另行
    标注为非 exact（见 `_price_claude_model` 的 `unresolved`），不能靠这个
    函数自己判断"该不该报精确"——它只管算数，不管诚实性标注。"""
    v = card.get(key)
    if isinstance(v, (int, float)):
        return total * float(v)
    if isinstance(v, dict):
        peak = min(max(peak, 0.0), total)
        off = total - peak
        return off * v.get("off_peak", 0.0) + peak * v.get("peak", 0.0)
    return 0.0


def _card_is_time_varying(card):
    """时变卡判定：`input_uncached` 字段是 `{off_peak, peak}` 形状——与 v0.6
    spec §8 G10 的机械判据同一条规则（今天命中 deepseek-official 的
    flash/pro、shengsuanyun 的 pro 三张卡；catalog 的平费率/档位卡这个字段
    恒是数字）。"""
    v = (card or {}).get("input_uncached")
    return isinstance(v, dict)


def _cache_write_rate(card):
    """缓存写入（cache_creation）单价：catalog 卡按 1h 档（5min 是 1.25×输入、
    1h 是 2×——Claude Code 自报 costUSD 按 1h 计，harness_costusd_note 说它与
    catalog 逐分吻合的前提就是 1h，照它走才能拿 cost-state 当差分 oracle）；
    没有 1h 档的卡（M2.7 的 `cache_write`、deepseek 无行 → 0）各取各的。"""
    r = _flat_rate(card, "cache_write_1hr")
    if r > 0:
        return r
    return _flat_rate(card, "cache_write")


def _first_tier(card):
    """tiers 卡（MiniMax-M3）：整请求按输入长度 cliff 分档；cost-state/日账
    只有会话聚合、分不出单请求长度 → 一律取首档（≤512K），档位标签随行透出
    ——超长请求会话会被低估，靠标签露馅而不是假装精确。"""
    tiers = (card or {}).get("tiers")
    if not tiers:
        return None
    first = tiers[0]
    return (first or {}).get("label", ""), first


def _price_claude_model(model, tokens, pricing, *, peak_resolved):
    """单模型 tokens（claude snake 键名）→ 计价。`peak_resolved=True` 时
    额外读 `peak_` 前缀的峰值子桶（`claude_cost.py::PEAK_KEYS`），对时变卡
    做峰谷拆分；`False` 时全部按 off_peak 计价（cost-state 累计口径没有
    逐行 ts，压根没有峰谷可分）。返回 (供应商, 币种, 总价, 档位标签,
    unresolved)——`unresolved=True` 表示命中了时变卡但没给峰谷分辨率，
    `_price_claude_map` 据此把 `pricing_basis` 标成非 exact，不能让下游误
    读成账单级精确。模型/卡都匹配不上 → None（不臆造）。"""
    resolved = _resolve_card_catalog(model, pricing)
    if resolved is None:
        return None
    provider, key, currency = resolved
    card = _catalog_card(pricing, provider, key)
    if card is None:
        return None
    tiered = _first_tier(card)
    label = None
    if tiered is not None:
        label, card = tiered

    def m(k):
        return (tokens.get(k) or 0) / 1e6

    def mp(k):
        return (tokens.get("peak_" + k) or 0) / 1e6 if peak_resolved else 0.0

    input_t, input_p = m("input_tokens"), mp("input_tokens")
    cread_t, cread_p = m("cache_read_input_tokens"), mp("cache_read_input_tokens")
    ccreate_t, ccreate_p = m("cache_creation_input_tokens"), mp("cache_creation_input_tokens")
    output_t, output_p = m("output_tokens"), mp("output_tokens")

    # 缓存写入：卡上 `cache_write` 是 `{off_peak, peak}` 对象（用户补的中转卡）→ 与其他
    # 三维同一峰谷读法；否则走 catalog 的平费率。与 Rust `claude.rs` 同步（2026-09-17）。
    if isinstance(card.get("cache_write"), dict):
        cache_write_cost = _priced_field(card, "cache_write", ccreate_t, ccreate_p)
    else:
        cache_write_cost = ccreate_t * _cache_write_rate(card)
    total = (_priced_field(card, "input_uncached", input_t, input_p)
             + _priced_field(card, "input_cached", cread_t, cread_p)
             + cache_write_cost
             + _priced_field(card, "output", output_t, output_p))
    unresolved = (not peak_resolved) and _card_is_time_varying(card)
    return provider, currency, total, label, unresolved


def _price_claude_map(models, pricing, *, peak_resolved=True):
    """`{模型: tokens}` → 价目报告。`claude_session_cost`（cost-state camel
    转换后，`peak_resolved=False`）与 `claude_day_cost`（ledger by_model
    直通，`peak_resolved=True`）共用——两面的钱必须同源，不在这里为日面长
    第二份计价规则（DSH 侧 token_by_date_model==token_by_model 那条纪律的
    claude 镜像）；`peak_resolved` 只影响时变卡是否能做峰谷拆分，不影响
    这条"同源"纪律本身——两个调用方过的是同一个函数、同一套读法分界。

    未知模型（`<synthetic>` 等）→ token 四型全进 unpriced。注意与 `cost_report`
    的 unpriced 词表不同：那边不含 output（DSH 钉测形状），claude cost-state
    只有这 4 型、output 同样是真实消费，未知就该全数报出来，别悄悄吞掉 output。

    `pricing_basis`（顶层与逐模型）：`peak_resolved=True` 且未命中时变卡，或
    时变卡有真实峰谷分辨率 → `"catalog"`（v0.6.x 前置热修后这是精确值，不再
    是估算）；命中时变卡但 `peak_resolved=False`（如 cost-state 的会话累计
    口径，压根没有逐行 ts）→ `"partial"`，如实标注"这个数字全按 off_peak
    算，不是账单精度"（v0.6 spec §5.3 条款 7 的"做不到时报 partial，不得取
    时间维下界冒充精确"）。
    """
    cny = 0.0
    usd = 0.0
    unpriced = 0
    per_model = {}
    any_unresolved = False
    for model, tokens in models.items():
        if not isinstance(tokens, dict):
            continue
        priced = _price_claude_model(model, tokens, pricing, peak_resolved=peak_resolved)
        if priced is None:
            unpriced += ((tokens.get("input_tokens") or 0)
                         + (tokens.get("cache_read_input_tokens") or 0)
                         + (tokens.get("cache_creation_input_tokens") or 0)
                         + (tokens.get("output_tokens") or 0))
            continue
        provider, currency, total, tier, unresolved = priced
        if unresolved:
            any_unresolved = True
        if currency == "USD":
            usd += total
        else:
            # 币种只可能是目录卡显式写的 USD/CNY 或顶层段默认 CNY；真有第三种
            # 币种落进来会静默混进 CNY——加新币种时改这里。
            cny += total
        entry = {
            "short_name": model_short(model, pricing),
            "currency": currency,
            "pricing_basis": "partial" if unresolved else "catalog",
            "priced_with": provider,
            "total": total,
        }
        if tier is not None:
            entry["tier"] = tier
        per_model[model] = entry
    if not per_model and unpriced == 0:
        return None
    return {
        "pricing_basis": "partial" if any_unresolved else "catalog",
        "currency_totals": {"CNY": cny, "USD": usd},
        "per_model": per_model,
        "unpriced_tokens": unpriced,
        "estimate_disclaimer": "按模型族官方卡折算的估算，不是账单",
    }


def claude_session_cost(model_usage, pricing):
    """cost-state 的 modelUsage（camelCase：inputTokens/outputTokens/
    cacheReadInputTokens/cacheCreationInputTokens/costUSD）→ 会话账金额。
    键名转 claude snake 后走 `_price_claude_map`——转换只有键名映射，不重算。
    `webSearchRequests`/`costUSD` 不参与计价（web search 没有 token 单价；
    costUSD 对网关模型按默认卡 $5/$0.5/$25 计、高估 20–70×——harness_costusd_note
    说清了，绝不能当账单数字）。modelUsage 为空/缺场 → None。

    `peak_resolved=False`：cost-state 的累计口径没有逐行 ts，压根不知道这些
    token 里有多少落在高峰时段——时变卡这里恒报 `pricing_basis="partial"`
    （v0.6.x 前置热修，2026-09-03；此前这里悄悄按 off_peak 下界算出一个
    看似精确的数字，是被撤销的旧行为）。与 `claude_day_cost` 共用
    `_price_claude_map`，两面同源。

    Rust 平行实现见 `cost.rs::claude_session_cost`。"""
    models = {}
    for model, ms in (model_usage or {}).items():
        if not isinstance(ms, dict):
            continue
        models[model] = {
            "input_tokens": ms.get("inputTokens") or 0,
            "cache_read_input_tokens": ms.get("cacheReadInputTokens") or 0,
            "cache_creation_input_tokens": ms.get("cacheCreationInputTokens") or 0,
            "output_tokens": ms.get("outputTokens") or 0,
        }
    if not models:
        return None
    return _price_claude_map(models, pricing, peak_resolved=False)


def claude_day_cost(day, pricing):
    """claude-ledger 的一天 → 当日金额。两种形状都认：
    - **by_model 包一层** `{"by_model": {模型: tokens}}`——本函数早期设计
      （无生产调用方）；
    - **flat 直图** `{模型: tokens}`——claude_cost.py `rebuild_days` 的真实
      形状：逐日账只有 token、模型直作键。
    真实账本没有模型叫 by_model，嗅 by_model 键无歧义；日级元数据若将来包一层，
    也只是 flat 的直接超集。结构与 `claude_session_cost` 完全相同（同一个
    `_price_claude_map`），只是输入已 snake 键、无需转换。没有任何模型可计价
    的日子（空 dict / 全零 token 未知模型 → _price_claude_map 返回 None）→ None
    （调用方自己决定退回哪种近似，不摆全零结构）。

    `peak_resolved=True`：v0.6.x 前置热修后（2026-09-03），ledger 日桶的每个
    模型都带 `peak_` 前缀的峰值子桶（`claude_cost.py::PEAK_KEYS`，来自
    `tail_days` 逐行真实 ts，精确不是估算），时变卡走峰谷拆分计价，
    `pricing_basis="catalog"`——不再是 v0.6 spec §8 G10 登记过的
    `pending v0.7`/`pending v0.6.x` 缺口。

    Rust 平行实现见 `cost.rs::claude_day_cost`。"""
    if not isinstance(day, dict):
        return None
    models = day["by_model"] if "by_model" in day else day
    if not models:
        return None
    return _price_claude_map(models, pricing, peak_resolved=True)


def claude_subscription_uncovered_estimate(models, pricing):
    """未落入已声明订阅覆盖范围（估算）——v0.7 spec §3 交付矩阵第二行，
    **provider 粒度**版本（澄清后的选择：模型粒度需要新增结构化字段，与
    "零新数据"矛盾；provider 粒度复用 `pricing.json` 现有
    `catalog_2026_09.subscriptions.*` 字段即可判定，代价是这个视图判的是
    provider 整体有没有已声明订阅，不是逐模型——因此叫"未落入已声明订阅
    覆盖范围"而不是"模型集排除"）。

    `models` 是 claude 4 型 snake 键 tokens（ledger 的 `by_model` 或
    cost-state 转换后的形状，与 `claude_day_cost`/`claude_session_cost`
    同型）。provider 在 `catalog_2026_09.subscriptions.*.provider` 出现过
    → 该 provider 全部用量视为已订阅覆盖，不进本视图；没出现过 → 全部
    token 进本视图的 catalog 反事实金额，标
    `pricing_basis="estimated-subscription-exclusion"`——不得据此断言这是
    真实按量现金成本（可能仍是企业套餐、免费额度、代理路由或未知来源，
    v0.7 spec §3 原文措辞）。`models` 为空/无可归属 provider 的模型 →
    `None`。

    Rust 平行实现见 `cost.rs::claude_subscription_uncovered_estimate`。
    """
    subs = (pricing.get("catalog_2026_09") or {}).get("subscriptions") or {}
    covered = {v.get("provider") for k, v in subs.items()
              if k != "_doc" and isinstance(v, dict)}
    uncovered = {}
    for model, tokens in (models or {}).items():
        if not isinstance(tokens, dict):
            continue
        resolved = _resolve_card_catalog(model, pricing)
        if resolved is None:
            continue  # 未知模型：本视图只处理"能定位到 provider 才能判是否覆盖"的模型
        provider, _key, _currency = resolved
        if provider in covered:
            continue
        uncovered[model] = tokens
    if not uncovered:
        return None
    report = _price_claude_map(uncovered, pricing, peak_resolved=True)
    if report is None:
        return None
    report = dict(report)
    report["pricing_basis"] = "estimated-subscription-exclusion"
    report["per_model"] = {
        m: dict(pm, pricing_basis="estimated-subscription-exclusion")
        for m, pm in report["per_model"].items()
    }
    report["estimate_disclaimer"] = (
        "未落入已声明订阅覆盖范围的估算；可能仍属企业套餐、免费额度、"
        "代理路由或未知来源，不构成按量现金成本的确认")
    return report


def _nominal_price(buckets, model_key, provider_key, pricing):
    """反事实基线：把缓存命中份额（cache_read）也按 uncached 单价折——
    「假装没发生缓存」的名义单价，用来算缓存节约（v0.7 spec §3「名义 vs
    实际单位成本」交付矩阵第三行）。cache_write/output 与真实计价一致，
    只有 input 侧的 cached/uncached 二分被抹平。这是 DSH 运行时计价面
    （`providers` 段，与 `_price` 同源）的函数，不是 claude catalog 面——
    catalog 面（`claude_session_cost` 等）目前没有平费率卡的"缓存折扣"
    语义要抹平（cache_write 是溢价不是折扣），此函数不服务那一面。
    """
    card = pricing["providers"][provider_key]["models"][model_key]
    u_peak = buckets.get("peak_uncached_input_tokens", 0) / 1e6
    c_peak = buckets.get("peak_cache_read_tokens", 0) / 1e6
    o_peak = buckets.get("peak_output_tokens", 0) / 1e6
    u_off = buckets["uncached_input_tokens"] / 1e6 - u_peak
    c_off = buckets["cache_read_tokens"] / 1e6 - c_peak
    o_off = buckets["output_tokens"] / 1e6 - o_peak
    off = ((u_off + c_off) * card["input_uncached"]["off_peak"]
           + o_off * card["output"]["off_peak"])
    peak = ((u_peak + c_peak) * card["input_uncached"]["peak"]
            + o_peak * card["output"]["peak"])
    return off + peak


def cache_counterfactual_cost(usage, pricing):
    """无缓存反事实 vs 实际单位成本（节约因子）——v0.7 spec §3 交付矩阵第三行。
    `actual` = `cost_report` 的真实计价 `total`（当前定价引擎能表达的
    "实际"，尚未建模订阅覆盖/路由折扣，见下）；`no_cache_counterfactual` =
    假设所有 input（含缓存命中部分）都按 uncached 单价算的反事实总价，逐
    模型用 `_nominal_price` 求和。`ratio = actual / no_cache_counterfactual`，
    <1 表示节约。

    **改名记录（2026-09-05）**：原 `nominal_vs_actual_cost`，输出键 `nominal` →
    `no_cache_counterfactual`。`nominal` 一词让位给 ATTRIBUTABLE_WASTE §6.7
    的市场标价口径（官方价、不扣套餐/折扣）；本函数的反事实是"要是没缓存
    会花多少"，与市场标价无关，实测两者差 8~10 倍，共用一词会在同一张报表
    里打架。Rust 侧同步改名。

    **当前唯一建模的节约信号是缓存折扣**（cached 0.05 vs uncached 1.5 =
    1/30）；订阅覆盖、路由折扣、模型替代尚未接入计价引擎，故没有缓存命中
    的语料下 ratio 恒为 1.00（2026-09-02 实测值）——这不是本函数的 bug，是
    "当前能表达的节约来源只有缓存"这一事实的忠实反映，未来接入订阅/路由
    信号后 ratio 才会承载更多信号（v0.7 spec §3 原文）。

    usage 为空/无可计价模型 → `None`。

    Rust 平行实现见 `cost.rs::cache_counterfactual_cost`。
    """
    report = cost_report(usage, pricing)
    if report is None:
        return None
    by_model = (usage or {}).get("by_model") or {}
    providers = (usage or {}).get("providers")
    no_cache = 0.0
    for model, buckets in by_model.items():
        provider = (providers or {}).get(model)
        if not isinstance(provider, str):
            provider = None
        resolved = _resolve_card(model, provider, pricing)
        if resolved is None:
            continue
        key, provider_key, _basis = resolved
        no_cache += _nominal_price(buckets, key, provider_key, pricing)
    actual = report["total"]
    ratio = (actual / no_cache) if no_cache > 0 else None
    return {
        "currency": "CNY",
        "actual": actual,
        "no_cache_counterfactual": no_cache,
        "ratio": ratio,
        "estimate_disclaimer": (
            "actual 是当前定价引擎的真实计价（未建模订阅覆盖/路由折扣），"
            "no_cache_counterfactual 是假设无缓存命中的反事实基线"
            "（不是市场标价的\"名义成本\"，见 ATTRIBUTABLE_WASTE §6.7）；"
            "ratio<1 表示节约，"
            "当前唯一建模的节约来源是缓存折扣"),
    }
