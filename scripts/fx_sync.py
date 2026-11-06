#!/usr/bin/env python3
"""每日汇率同步：两个独立的公开 JSON 源 → assets/fx-sync.json（叠加快照）。

与 `pricing_sync.py` 同一套做法：只取公开结构化 JSON（不爬 HTML）；**两源一致才采用**，
单源币种与分歧币种不发布；相对上一份已发布快照偏差过大或日期倒退时整份不发布，不是逐条放行。
内置快照 `assets/fx-reference-rates.json` 是编进二进制的兜底；本文件只是比它更新的叠加，
由桌面 app 在用户允许公共价格更新时拉取。公开参考汇率，不是银行结算汇率。

用法：
  python3 scripts/fx_sync.py --write           # 联网取数并写 assets/fx-sync.json
  python3 scripts/fx_sync.py --check           # 联网取数，只打印结果，不写文件
  python3 scripts/fx_sync.py --ecb-file a.json --fawaz-file b.json --write   # 离线（测试用）
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "fx-sync.json"
BASELINE = ROOT / "assets" / "fx-reference-rates.json"
ECB_URL = "https://api.frankfurter.dev/v1/latest?base=USD"
FAWAZ_URL = "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json"
AGREE_TOLERANCE = 0.005   # 两源相对差 ≤0.5% 才采用
MAX_JUMP = 0.25           # 相对上一份已发布值偏差 >25% → 整份不发布
SCHEMA_VERSION = 1


def fetch(url: str) -> dict:
    request = urllib.request.Request(url, headers={"User-Agent": "agent-vitals-fx-sync/1"})
    with urllib.request.urlopen(request, timeout=20) as response:  # noqa: S310 固定公开地址
        return json.loads(response.read().decode("utf-8"))


def parse_ecb(doc: dict) -> tuple[str, dict[str, float]]:
    if doc.get("base") != "USD":
        raise ValueError("ECB source base must be USD")
    rates = {k.upper(): float(v) for k, v in doc["rates"].items() if float(v) > 0}
    return str(doc["date"]), rates


def parse_fawaz(doc: dict) -> tuple[str, dict[str, float]]:
    rates = {k.upper(): float(v) for k, v in doc["usd"].items() if isinstance(v, (int, float)) and v > 0}
    return str(doc["date"]), rates


def merge(ecb: tuple[str, dict[str, float]], fawaz: tuple[str, dict[str, float]]):
    """两源日期必须相同；同时出现且相对差 ≤ 容差的币种才采用（取 ECB 值）。"""
    (date_a, rates_a), (date_b, rates_b) = ecb, fawaz
    if date_a != date_b:
        raise ValueError(f"sources disagree on the rate date: {date_a} vs {date_b}")
    adopted: dict[str, str] = {}
    rejected: dict[str, dict] = {}
    single: list[str] = []
    for currency, value in sorted(rates_a.items()):
        other = rates_b.get(currency)
        if other is None:
            single.append(currency)
            continue
        diff = abs(value - other) / value
        if diff <= AGREE_TOLERANCE:
            adopted[currency] = repr(value)
        else:
            rejected[currency] = {"ecb": value, "fawaz": other, "relative_diff": round(diff, 4)}
    adopted["USD"] = "1"
    return date_a, adopted, rejected, single


def validate_against(previous: dict | None, date: str, adopted: dict[str, str]) -> None:
    """相对上一份已发布快照：日期不能倒退，且任何共有币种不得偏差 >25%。违反即整份拒绝。"""
    if previous is None:
        return
    if date < previous["rate_date"]:
        raise ValueError(f"rate date went backwards: {date} < {previous['rate_date']}")
    for currency, entry in previous["rates"].items():
        if currency not in adopted:
            continue
        old, new = float(entry["rate"]), float(adopted[currency])
        if old > 0 and abs(new - old) / old > MAX_JUMP:
            raise ValueError(f"{currency} moved {abs(new - old) / old:.0%} against the previous snapshot; refusing to publish")


def build_document(date: str, adopted: dict[str, str], rejected: dict, now: dt.datetime | None = None) -> dict:
    now = now or dt.datetime.now(dt.timezone.utc)
    return {
        "schema_version": SCHEMA_VERSION,
        "kind": "fx_reference_rates",
        "base": "USD",
        "rate_date": date,
        "captured_at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "meaning": "1 USD = rate × 目标币种。公开参考汇率（欧央行参考价），不是银行结算汇率，也不是用户实际支付汇率。",
        "policy": "两个独立公开 JSON 源一致（相对差 ≤0.5%）才采用；不一致或仅单源的币种不发布；相对上一份已发布快照偏差 >25% 或日期倒退时整份不发布。",
        "sources": [
            {"id": "ecb-frankfurter", "url": ECB_URL, "note": "European Central Bank euro foreign exchange reference rates via Frankfurter"},
            {"id": "fawazahmed0-currency-api", "url": FAWAZ_URL, "note": "cross-check only"},
        ],
        "rates": {c: {"rate": r, "cross_check": 0} for c, r in sorted(adopted.items())},
        "rejected": rejected,
    }


def load_previous() -> dict | None:
    for path in (OUT, BASELINE):
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
    return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--ecb-file")
    parser.add_argument("--fawaz-file")
    args = parser.parse_args(argv)
    ecb_doc = json.loads(Path(args.ecb_file).read_text()) if args.ecb_file else fetch(ECB_URL)
    fawaz_doc = json.loads(Path(args.fawaz_file).read_text()) if args.fawaz_file else fetch(FAWAZ_URL)
    date, adopted, rejected, single = merge(parse_ecb(ecb_doc), parse_fawaz(fawaz_doc))
    validate_against(load_previous(), date, adopted)
    document = build_document(date, adopted, rejected)
    summary = f"fx-sync: {date}: {len(adopted)} adopted, {len(rejected)} disagreed, {len(single)} single-source"
    print(summary)
    if rejected:
        print("  disagreed:", ", ".join(sorted(rejected)))
    if args.write:
        text = json.dumps(document, ensure_ascii=False, indent=2) + "\n"
        # 只有汇率内容变了才写：captured_at 每天都会变，不能让它单独制造提交。
        if OUT.exists():
            current = json.loads(OUT.read_text(encoding="utf-8"))
            if current.get("rate_date") == document["rate_date"] and current.get("rates") == document["rates"]:
                print("  unchanged — not rewriting")
                return 0
        OUT.write_text(text, encoding="utf-8")
        print(f"  wrote {OUT.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
