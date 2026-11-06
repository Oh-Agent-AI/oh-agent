#!/usr/bin/env python3
"""每日价卡同步：公开价格源 → catalog/pricing 叠加层及 assets 兼容镜像。

    python3 scripts/pricing_sync.py              # 拉取三源，只打印报告
    python3 scripts/pricing_sync.py --write      # 有变化才改写叠加层
    python3 scripts/pricing_sync.py --sources-dir DIR   # 离线：读 DIR 下的
        models.dev.json / litellm.json / openrouter.json（测试与复现用）

为什么是叠加层而不是直接改 `assets/pricing.json` / `codex_pricing.json`：那两份
是编译进二进制的底表，几十个测试钉着它们算出的金额；CI 每天改底表会天天红。
叠加层由 app 每日拉取后与内置底表合并成一份完整快照（见
`agent-vitals-runtime-core::pricing::pricing_catalog::merge_sync_overlay`）。

为什么三源比对而不是认一家（2026-09-29 实测）：
- OpenRouter 漏了最新的 Anthropic 模型（Opus 5.5、Fable 5.1 都没有）；
- 开源权重模型（DeepSeek）三家给出三个不同的数，谁都不能当原厂价；
- 本地手工卡按过期公告写错了 Sonnet 5（$3/$15，官方已宣布维持 $2/$10）——
  三源一致地指出了这一点。
所以规则是：一个字段至少两个源一致才采用；只取原厂自己的条目（models.dev 按
服务商组织、LiteLLM 按 `litellm_provider` 过滤），不取 Azure / Bedrock 等路由价。

不做爬虫（2026-09-14 决定）：这里读的都是公开 JSON 数据，不解析任何 HTML 页面。
只在 CI 里运行；用户的 app 永远只从本仓库拉叠加层，不直连这些第三方源。

2026-09-29 用户决定「全部自动发布」：新卡与改价都直接进叠加层。下面的数据校验
不是审批，只拦明显坏掉的第三方数据（归零、单次变动超过 5 倍），被拦的写进
`rejected` 供人查看，不发布。
"""
from __future__ import annotations

import argparse
import datetime as _dt
import json
import re
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
CATALOG_PRICING = ROOT / "catalog" / "pricing"
OVERLAY_PATH = CATALOG_PRICING / "pricing-sync.json"
sys.path.insert(0, str(ROOT))
from scripts.catalog_mirror import synchronize, atomic_bytes, validate_paths
SCHEMA = "agent-vitals-pricing-sync/v1"

SOURCES = {
    "models.dev": "https://models.dev/api.json",
    "litellm": "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
    "openrouter": "https://openrouter.ai/api/v1/models",
}

# 同步范围：我们的服务商 id → 各源里原厂自己的标识。
# minimax / deepseek 不在范围内：底表是人民币卡（DeepSeek 还有峰谷价），单一美元
# 数字表达不了，且三源对 DeepSeek 互相矛盾——这两家继续由维护者手工维护。
# google / xai 暂不纳入：还没有会产出它们用量的执行环境，Gemini 还有长上下文分档。
CATALOG_PROVIDERS = {
    # ours: (models.dev 服务商, litellm_provider, litellm 键前缀, openrouter 前缀, 模型 id 过滤)
    "anthropic": ("anthropic", "anthropic", "", "anthropic", r"^claude-"),
    "moonshot": ("moonshotai", "moonshot", "moonshot/", "moonshotai", r"^kimi-"),
    "zai": ("zai", "zai", "zai/", "z-ai", r"^glm-"),
}
# OpenAI 走 codex 价表（字段形状不同，见 assets/codex_pricing.json）。
CODEX_PROVIDER = ("openai", "openai", "", "openai", r"^(gpt-[5-9]|codex-)")

# 同一模型的变体/别名不单独建卡：批处理、日期快照、fast 模式等。
SKIP_ID = re.compile(r"(:|-\d{4}-\d{2}-\d{2}$|-\d{8}$|-fast$|-latest$|-preview-\d)")

# Anthropic 官方缓存写入倍率（platform.claude.com/docs/en/about-claude/pricing，
# 适用于全部模型）：5 分钟档 1.25×输入，1 小时档 2×输入。源里缺缓存写入价时按此
# 推算——价卡缺这两个字段时计价会按 0 算，缓存写入量大的会话会被系统性低估。
ANTHROPIC_CACHE_WRITE = (1.25, 2.0)

MAX_CHANGE_RATIO = 5.0
AGREE_TOLERANCE = 0.005  # 相对误差 0.5% 以内视为一致（浮点换算的尾差）


# ─────────────────────────── 读取三源 ───────────────────────────


def _fetch(url: str) -> object:
    req = urllib.request.Request(url, headers={"User-Agent": "agent-vitals-pricing-sync/1"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read())


def load_sources(sources_dir: Path | None) -> dict:
    out = {}
    for name, url in SOURCES.items():
        if sources_dir:
            out[name] = json.loads((sources_dir / f"{name}.json").read_text())
        else:
            out[name] = _fetch(url)
    return out


def _per_million(value) -> float | None:
    """每 token 的价格（LiteLLM 浮点 / OpenRouter 字符串）→ 每百万 token。"""
    if value in (None, ""):
        return None
    try:
        v = float(value) * 1_000_000
    except (TypeError, ValueError):
        return None
    return round(v, 6) if v >= 0 else None


def _num(value) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    return round(v, 6) if v >= 0 else None


FIELDS = ("input", "cache_read", "cache_write_5m", "cache_write_1h", "output")


def quotes_for(sources: dict, spec: tuple) -> dict[str, dict[str, dict]]:
    """→ {model_id: {source_name: {field: price_per_million}}}，只含原厂条目。"""
    md_provider, ll_provider, ll_prefix, or_prefix, id_pattern = spec
    pattern = re.compile(id_pattern)
    quotes: dict[str, dict[str, dict]] = {}

    md_models = (sources["models.dev"].get(md_provider) or {}).get("models") or {}
    for mid, m in md_models.items():
        cost = m.get("cost") or {}
        quotes.setdefault(mid, {})["models.dev"] = {
            "input": _num(cost.get("input")),
            "cache_read": _num(cost.get("cache_read")),
            "cache_write_5m": _num(cost.get("cache_write")),
            "cache_write_1h": None,
            "output": _num(cost.get("output")),
        }

    for key, v in sources["litellm"].items():
        if not isinstance(v, dict) or v.get("litellm_provider") != ll_provider:
            continue
        if not key.startswith(ll_prefix):
            continue
        mid = key[len(ll_prefix):]
        if "/" in mid:
            continue
        quotes.setdefault(mid, {})["litellm"] = {
            "input": _per_million(v.get("input_cost_per_token")),
            "cache_read": _per_million(v.get("cache_read_input_token_cost")),
            "cache_write_5m": _per_million(v.get("cache_creation_input_token_cost")),
            "cache_write_1h": _per_million(v.get("cache_creation_input_token_cost_above_1hr")),
            "output": _per_million(v.get("output_cost_per_token")),
        }

    for m in sources["openrouter"].get("data", []):
        oid = m.get("id", "")
        if not oid.startswith(or_prefix + "/"):
            continue
        mid = oid.split("/", 1)[1]
        # OpenRouter 把 Anthropic 版本号写成点号（claude-sonnet-5.5），原厂 id 是连字符
        if md_provider == "anthropic":
            mid = mid.replace(".", "-")
        p = m.get("pricing") or {}
        quotes.setdefault(mid, {})["openrouter"] = {
            "input": _per_million(p.get("prompt")),
            "cache_read": _per_million(p.get("input_cache_read")),
            "cache_write_5m": _per_million(p.get("input_cache_write")),
            "cache_write_1h": _per_million(p.get("input_cache_write_1h")),
            "output": _per_million(p.get("completion")),
        }

    return {mid: q for mid, q in quotes.items() if pattern.search(mid) and not SKIP_ID.search(mid)}


def _close(a: float, b: float) -> bool:
    if a == b:
        return True
    return abs(a - b) <= AGREE_TOLERANCE * max(abs(a), abs(b))


def agreed(per_source: dict[str, dict], field: str) -> tuple[float | None, list[str]]:
    """某字段至少两个源一致时返回 (值, 一致的源)；否则 (None, [])。"""
    values = [(name, q.get(field)) for name, q in sorted(per_source.items()) if q.get(field) is not None]
    best: tuple[float | None, list[str]] = (None, [])
    for name, v in values:
        group = [n for n, w in values if _close(v, w)]
        if len(group) >= 2 and len(group) > len(best[1]):
            best = (v, group)
    return best


def consensus(per_source: dict[str, dict], provider: str) -> tuple[dict | None, str | None, list[str]]:
    """→ (价格, 未采用原因, 参与一致的源)。输入、缓存读取、输出三项必须一致：缓存读取
    是编程 Agent 用量的大头（本机实测 >90%），它缺失或不一致时宁可不发布。"""
    price, used = {}, set()
    for field in ("input", "cache_read", "output"):
        value, group = agreed(per_source, field)
        if value is None and field == "cache_read" and all(q.get("cache_read") is None for q in per_source.values()):
            # 没有一个源给缓存读取价：这类模型（gpt-5-pro 等）不提供缓存折扣，缓存命中
            # 也按全价输入计——取输入价是保守估计。「都没写」与「写了对不上」要分开：
            # 后者说明有源在报错价，照样拒绝。
            continue
        if value is None:
            return None, f"{field} 没有两个以上的源一致", []
        price[field] = value
        used.update(group)
    price.setdefault("cache_read", price["input"])
    for field in ("cache_write_5m", "cache_write_1h"):
        value, group = agreed(per_source, field)
        if value is not None:
            price[field] = value
            used.update(group)
    if provider == "anthropic":
        k5, k1 = ANTHROPIC_CACHE_WRITE
        price.setdefault("cache_write_5m", round(price["input"] * k5, 6))
        price.setdefault("cache_write_1h", round(price["input"] * k1, 6))
    if price["input"] <= 0 or price["output"] <= 0:
        return None, "输入或输出价为 0（第三方数据可疑）", []
    return price, None, sorted(used)


# ─────────────────────────── 与底表比对 ───────────────────────────


def _card(price: dict) -> dict:
    card = {"input_uncached": price["input"], "input_cached": price["cache_read"], "output": price["output"]}
    if "cache_write_5m" in price:
        card["cache_write_5min"] = price["cache_write_5m"]
    if "cache_write_1h" in price:
        card["cache_write_1hr"] = price["cache_write_1h"]
    return card


def _fmt(v: float) -> str:
    s = f"{v:.6f}".rstrip("0").rstrip(".")
    return s or "0"


def _codex_entry(model: str, price: dict) -> dict:
    entry = {
        "modelPrefix": model,
        "speed": "standard",
        "uncachedInputUsdPerMTok": _fmt(price["input"]),
        "cacheReadUsdPerMTok": _fmt(price["cache_read"]),
        "outputUsdPerMTok": _fmt(price["output"]),
        "usInferenceMultiplierBps": 10000,
    }
    if "cache_write_5m" in price:
        entry["cacheWrite5mUsdPerMTok"] = _fmt(price["cache_write_5m"])
    if "cache_write_1h" in price:
        entry["cacheWrite1hUsdPerMTok"] = _fmt(price["cache_write_1h"])
    return entry


def _ratio_ok(new: float, old: float | None) -> bool:
    if old is None or old == 0:
        return True
    r = new / old
    return 1 / MAX_CHANGE_RATIO <= r <= MAX_CHANGE_RATIO


def build_overlay(sources: dict, base_pricing: dict, base_codex: dict) -> dict:
    catalog: dict[str, dict] = {}
    codex_entries: list[dict] = []
    rejected: list[dict] = []
    base_catalog = (base_pricing.get("catalog_2026_09") or {}).get("providers") or {}

    for ours, spec in CATALOG_PROVIDERS.items():
        base_models = (base_catalog.get(ours) or {}).get("models") or {}
        base_currency = (base_catalog.get(ours) or {}).get("currency", "USD")
        if base_currency != "USD":
            continue  # 底表不是美元卡：不叠加美元价，避免同一服务商混币
        for mid, per_source in sorted(quotes_for(sources, spec).items()):
            price, reason, used = consensus(per_source, ours)
            if price is None:
                if len(per_source) >= 2:
                    rejected.append({"provider": ours, "model": mid, "reason": reason})
                continue
            card = _card(price)
            base = base_models.get(mid)
            if base is not None and all(_close(card[k], base.get(k, -1)) for k in card if isinstance(base.get(k), (int, float))) \
                    and all(k in base for k in card):
                continue  # 与底表一致，无需叠加
            if base is not None:
                bad = [k for k in ("input_uncached", "output") if not _ratio_ok(card[k], base.get(k))]
                if bad:
                    rejected.append({"provider": ours, "model": mid, "reason": f"{'/'.join(bad)} 相对底表变动超过 {MAX_CHANGE_RATIO:g} 倍"})
                    continue
            card["_sync"] = {"kind": "update" if base is not None else "new", "agreed_by": used}
            catalog.setdefault(ours, {"currency": "USD", "models": {}})["models"][mid] = card

    base_entries = {(e.get("modelPrefix"), e.get("speed")): e for e in base_codex.get("entries", [])}
    for mid, per_source in sorted(quotes_for(sources, CODEX_PROVIDER).items()):
        price, reason, used = consensus(per_source, "openai")
        if price is None:
            if len(per_source) >= 2:
                rejected.append({"provider": "openai", "model": mid, "reason": reason})
            continue
        entry = _codex_entry(mid, price)
        base = base_entries.get((mid, "standard"))
        if base is not None:
            same = all(
                _close(float(entry[k]), float(base[k]))
                for k in ("uncachedInputUsdPerMTok", "cacheReadUsdPerMTok", "outputUsdPerMTok")
                if k in base
            )
            if same:
                continue
            bad = [k for k in ("uncachedInputUsdPerMTok", "outputUsdPerMTok")
                   if k in base and not _ratio_ok(float(entry[k]), float(base[k]))]
            if bad:
                rejected.append({"provider": "openai", "model": mid, "reason": f"{'/'.join(bad)} 相对底表变动超过 {MAX_CHANGE_RATIO:g} 倍"})
                continue
            # 改价时保留底表里本工具认得、但三源给不出的字段（长上下文阈值与倍率等）
            entry = {**{k: v for k, v in base.items() if not k.startswith("_")}, **entry}
        entry["_sync"] = {"kind": "update" if base is not None else "new", "agreed_by": used}
        codex_entries.append(entry)

    return {
        "schema": SCHEMA,
        "catalog": {p: catalog[p] for p in sorted(catalog)},
        "codex_entries": codex_entries,
        "rejected": rejected,
    }


# ─────────────────────────── 输出 ───────────────────────────


def _content(overlay: dict) -> dict:
    return {k: v for k, v in overlay.items() if k not in ("updated_at", "_doc", "sources")}


def finalize(overlay: dict, previous: dict | None, today: str) -> tuple[dict, bool]:
    """内容没变就保留原 updated_at 并报告「无变化」——CI 据此不提交，避免每天一个空提交。"""
    changed = previous is None or _content(previous) != _content(overlay)
    updated_at = today if changed else (previous or {}).get("updated_at", today)
    doc = ("由 scripts/pricing_sync.py 每日生成，勿手改。只含相对底表（pricing.json / "
           "codex_pricing.json）新增或改价的条目；app 拉取后与内置底表合并成完整快照。"
           "每张卡的 _sync 记录采纳它的源。")
    return {"schema": SCHEMA, "_doc": doc, "updated_at": updated_at, "sources": SOURCES, **_content(overlay)}, changed


def report(overlay: dict, changed: bool) -> str:
    lines = [f"## 价卡同步 {overlay['updated_at']}", ""]
    lines.append("叠加层有变化，已更新。" if changed else "叠加层无变化。")
    lines.append("")
    rows = []
    for provider, block in overlay["catalog"].items():
        for mid, card in block["models"].items():
            rows.append((card["_sync"]["kind"], provider, mid, card["input_uncached"], card["input_cached"], card["output"], ",".join(card["_sync"]["agreed_by"])))
    for e in overlay["codex_entries"]:
        rows.append((e["_sync"]["kind"], "openai", e["modelPrefix"], e["uncachedInputUsdPerMTok"], e["cacheReadUsdPerMTok"], e["outputUsdPerMTok"], ",".join(e["_sync"]["agreed_by"])))
    if rows:
        lines += ["| 类型 | 服务商 | 模型 | 输入 | 缓存读取 | 输出 | 一致的源 |", "|---|---|---|---|---|---|---|"]
        lines += [f"| {'新增' if k == 'new' else '改价'} | {p} | `{m}` | {i} | {c} | {o} | {s} |" for k, p, m, i, c, o, s in rows]
    if overlay["rejected"]:
        lines += ["", f"### 未采用（{len(overlay['rejected'])}）", ""]
        lines += [f"- {r['provider']} `{r['model']}`：{r['reason']}" for r in overlay["rejected"]]
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--write", action="store_true", help="更新 catalog 叠加层及 assets 兼容镜像")
    ap.add_argument("--root", type=Path, default=ROOT, help="价卡仓库根目录（离线测试）")
    ap.add_argument("--sources-dir", type=Path, help="从本地目录读三源 JSON（离线/测试）")
    ap.add_argument("--overlay", type=Path, help="自定义输出（不更新仓库镜像）")
    ap.add_argument("--today", help="覆盖日期（测试用，YYYY-MM-DD）")
    args = ap.parse_args(argv)
    overlay_path = args.overlay or args.root / "catalog/pricing/pricing-sync.json"
    if args.write and args.overlay is None:
        validate_paths(args.root, allow_missing_mirrors=True)

    sources = load_sources(args.sources_dir)
    base_pricing = json.loads((args.root / "catalog/pricing/pricing.json").read_text(encoding="utf-8"))
    base_codex = json.loads((args.root / "catalog/pricing/codex_pricing.json").read_text(encoding="utf-8"))
    overlay = build_overlay(sources, base_pricing, base_codex)

    previous = json.loads(overlay_path.read_text(encoding="utf-8")) if overlay_path.exists() else None
    today = args.today or _dt.datetime.now(_dt.timezone.utc).date().isoformat()
    final, changed = finalize(overlay, previous, today)
    sys.stdout.write(report(final, changed))
    if args.write and changed:
        atomic_bytes(overlay_path, (json.dumps(final, ensure_ascii=False, indent=2, sort_keys=False) + "\n").encode("utf-8"))
    if args.write and args.overlay is None:
        synchronize(args.root, write=True)
        synchronize(args.root)
    return 0


if __name__ == "__main__":
    sys.exit(main())
