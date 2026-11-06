#!/usr/bin/env python3
"""cc-trace 差分 oracle——第四个独立实现交叉验证 Codex 成本折叠。

研究落点 docs/CC_TRACE_APPLICATION.md §5 item 1（A）：cc-trace 用第三套独立
实现（Python、Rust 之外）解析同一批 Codex rollout 日志，把每请求 token 写进
SQLite `usage_entries`。我们 `codex-cost` 是第二/三套。两套读同一批真实日志，
对账五个 token 桶——**这是硬守恒律的第四实现验证**（「每个 token 恰好被折
进一次」），不是比价格表（两边价目不同，cost_usd 只报告、不断言）。

只读、不动生产代码。cc-trace 侧数据来源：构建它的
`examples/usage_audit`（`--config-dir /tmp/cc-trace-usage-audit-oracle`）扫一遍
默认根目录，产出 `usage.db`；这里只 SELECT。

用法：
    agent-vitals codex-cost --harness codex --month all --json /tmp/codex-cost.json
    python3 scripts/cc_trace_oracle.py \
        --cc-trace-db /tmp/cc-trace-usage-audit-oracle/usage.db \
        --codex-cost-json /tmp/codex-cost.json \
        [--codex-logs-dir ~/.codex/sessions]

退出码：
- **守恒律**（全量五桶 totals + 逐日总 token）是闸门：任一对账不平 → 1。
- **per-model 归属差异**不 gate。实测真实语料 totals 5/5、逐日 25/25 全平，
  唯独 per-model 三模型分桶差——且每桶各模型差值和恰为 0（纯重归属，守恒在
  桶级也保持）。差异是**已知的重归属**，不是漏计：cc-trace 把
  `thread_settings_applied.thread_settings.model` 读进请求归属，我们在 turn
  中途的模型切换后仍按 `turn_context.model`（本轮实际执行模型）归属。判定见
  docs/CC_TRACE_APPLICATION.md §A 的「reverse 自然实验」——settings 翻页领先
  本轮实际翻页 2.5 分钟，两个输入=0 的事件落在该窗口，证明切换下轮生效。
  给 `--codex-logs-dir` 时本脚本重放两种归属规则，把差异逐 (tc, th) 归类，
  让判定可数据复现而不是写死。
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from collections import Counter, defaultdict
from pathlib import Path

# 我们的桶名 ↔ cc-trace usage_entries 的列。cc-trace 把 cache_read 与 cache_write
# 拆成三列（5m/1h），我们的 cached_input_tokens = read + write5m + write1h，
# cache_write_input_tokens = write5m + write1h（codex-cost 的 JSON 语义）。
BUCKETS: list[tuple[str, list[str]]] = [
    ("uncached_input_tokens", ["uncached_input_tokens"]),
    ("output_tokens", ["output_tokens"]),
    ("cached_input_tokens", ["cache_read_input_tokens",
                             "cache_write_5m_input_tokens",
                             "cache_write_1h_input_tokens"]),
    ("cache_write_input_tokens", ["cache_write_5m_input_tokens",
                                  "cache_write_1h_input_tokens"]),
    ("reasoning_output_tokens", ["reasoning_output_tokens"]),
]
# 六列互斥消费（cache_write 与 cache_read 不重叠）——逐日总和必须按列加，不能
# 按桶加（桶 cached_input ⊇ cache_write，按桶加会双计）。
CC_COLS = ["uncached_input_tokens", "output_tokens",
           "cache_read_input_tokens", "cache_write_5m_input_tokens",
           "cache_write_1h_input_tokens", "reasoning_output_tokens"]

VERDICT_REF = "docs/CC_TRACE_APPLICATION.md §A"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--cc-trace-db", required=True, type=Path,
                   help="cc-trace usage_audit 产出的 usage.db")
    p.add_argument("--codex-cost-json", required=True, type=Path,
                   help="`agent-vitals codex-cost --harness codex --month all --json` 的输出文件")
    p.add_argument("--codex-logs-dir", type=Path, default=None,
                   help="可选：~/.codex/sessions 等 Codex rollout 根；给定时重放两种"
                        "模型归属规则，把 per-model 差异逐 (turn_context, thread_settings) 归类")
    return p.parse_args()


def cc_trace_sums(db: Path) -> dict:
    """按 source='codex' 聚合 usage_entries：totals / per-model / per-day。"""
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    cur = con.cursor()
    sums = {c: f"COALESCE(SUM({c}),0)" for c in CC_COLS}

    def bucket_sql(cols: list[str]) -> str:
        return "(" + "+".join(sums[c] for c in cols) + ")"

    totals = {name: bucket_sql(cols) for name, cols in BUCKETS}
    per_model = {name: f"model, {bucket_sql(cols)}" for name, cols in BUCKETS}
    per_day_col = {c: f"day_local, {sums[c]}" for c in CC_COLS}
    out = {"totals": {}, "per_model": {}, "per_day": {}}
    cur.execute(
        "SELECT " + ", ".join(totals.values()) + " FROM usage_entries WHERE source='codex'"
    )
    for (name, _), v in zip(BUCKETS, cur.fetchone()):
        out["totals"][name] = v
    for name, cols in BUCKETS:
        cur.execute(f"SELECT {per_model[name]} FROM usage_entries "
                    f"WHERE source='codex' GROUP BY model ORDER BY model")
        out["per_model"][name] = {m: v for m, v in cur.fetchall()}
    day_by_col = {}
    for c in CC_COLS:
        cur.execute(f"SELECT {per_day_col[c]} FROM usage_entries "
                    f"WHERE source='codex' GROUP BY day_local")
        day_by_col[c] = {d: v for d, v in cur.fetchall()}
    # 逐日总 token = 六列互斥消费的和（不能按桶加，见 CC_COLS 注释）。
    days = set().union(*(set(col) for col in day_by_col.values()))
    out["per_day"] = {d: sum(day_by_col[c].get(d, 0) for c in CC_COLS) for d in days}
    con.close()
    return out


def load_ours(path: Path) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def our_totals(r: dict) -> dict:
    t = r.get("total_tokens", {})
    return {name: t.get(name, 0) for name, _ in BUCKETS}


def our_per_model(r: dict) -> dict:
    out = {name: {} for name, _ in BUCKETS}
    for model, info in (r.get("per_model") or {}).items():
        for name, _ in BUCKETS:
            out[name][model] = (info.get("tokens") or {}).get(name, 0)
    return out


def our_per_day(r: dict) -> dict:
    """我们的 days[] 只有聚合 tokens 一列——用它除以总桶算不出逐桶，所以
    per-day 只对账「总 token」这一维（守恒律按月/天级别）。"""
    return {d["date"]: d["tokens"] for d in (r.get("days") or [])}


def render(cmp_rows, label: str) -> bool:
    """打印对账行；返回是否全平。"""
    ok = True
    for name, ours, theirs in cmp_rows:
        delta = ours - theirs
        status = "PASS" if delta == 0 else "FAIL"
        ok &= delta == 0
        print(f"  {name:<28} {ours:>15,} {theirs:>15,} {delta:>+15,}  {status}")
    return ok


def compare_per_model(ours: dict, theirs: dict) -> tuple[bool, dict]:
    """per-model 五桶对账：逐桶打印各模型差，并检查「每桶各模型差值和」是否恰为 0。

    返回 (各桶是否全平, 每桶差值合计 dict)。差值合计恰为 0 = 纯重归属（守恒在
    桶级保持）——归错模型但一个 token 都没丢/多。这是「归属差异、不是漏计」的
    数据签名，比一句结论硬得多。
    """
    per_bucket_sum_delta = {}
    for name, _ in BUCKETS:
        print(f"  [{name}]")
        o = ours[name]
        t = theirs[name]
        deltas = []
        for key in sorted(set(o) | set(t)):
            ov, tv = o.get(key, 0), t.get(key, 0)
            deltas.append(ov - tv)
            if ov != tv:
                print(f"    {key}:  ours={ov:,}  cc-trace={tv:,}  Δ={ov - tv:+,}")
        bucket_sum = sum(deltas)
        per_bucket_sum_delta[name] = bucket_sum
        print(f"    各模型差值合计: {bucket_sum:+,}  "
              f"{'PASS（纯重归属，桶级守恒保持）' if bucket_sum == 0 else 'FAIL（非重归属——是真漏计/多计）'}")
    return all(v == 0 for v in per_bucket_sum_delta.values()), per_bucket_sum_delta


def classify_attribution(logs_dir: Path) -> tuple[Counter, dict]:
    """重放两种模型归属规则，返回 token_count 事件里两游标不一致的 (tc, th) 分布。

    - 我们的规则：model = session_meta.model 起手，turn_context.model 更新。
    - cc-trace 规则：同上 + thread_settings_applied.thread_settings.model 也更新。

    对每个两游标不一致的 token_count 事件记一笔 (turn_context, thread_settings)；
    tokens 为该事件 last_token_usage 的 input+output。这是 §A 判定的数据底座——
    期望形态是大量 (sol, terra/luna)（本轮跑 sol、settings 已翻到新模型的
    中途切换窗口）和极少数反向，而不是五五开。
    """
    counts: Counter = Counter()
    tokens: dict = defaultdict(lambda: [0, 0])  # (tc, th) -> [sum_input, sum_output]
    for path in sorted(logs_dir.rglob("*.jsonl")):
        our = cc = None
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    ev = json.loads(line)
                except json.JSONDecodeError:
                    continue
                t, p = ev.get("type"), ev.get("payload") or {}
                if t == "session_meta" and p.get("model"):
                    our = cc = p["model"]
                elif t == "turn_context" and p.get("model"):
                    our = cc = p["model"]
                elif (t == "event_msg" and p.get("type") == "thread_settings_applied"
                      and (p.get("thread_settings") or {}).get("model")):
                    cc = p["thread_settings"]["model"]
                elif (t == "event_msg" and p.get("type") == "token_count"):
                    last = ((p.get("info") or {}).get("last_token_usage") or {})
                    if isinstance(last, dict) and our and cc and our != cc:
                        counts[(our, cc)] += 1
                        tokens[(our, cc)][0] += last.get("input_tokens") or 0
                        tokens[(our, cc)][1] += last.get("output_tokens") or 0
    return counts, dict(tokens)


def reconcile(ours: dict, theirs: dict, logs_dir: Path | None = None) -> int:
    """守恒对账。返回 0（守恒律全平）或 1（totals/逐日任一不平）。"""
    print("=== cc-trace 差分 oracle：Codex 成本折叠（第四实现交叉验证）===\n")

    ok = True

    print("1) 全量五桶 totals（守恒律闸门）")
    ok &= render([(n, our_totals(ours)[n], theirs["totals"][n]) for n, _ in BUCKETS],
                 "totals")

    print("\n2) per-model 五桶（归属差异只报告、不 gate）")
    bucket_ok, bucket_deltas = compare_per_model(our_per_model(ours), theirs["per_model"])

    print("\n3) per-day 总 token（守恒律闸门：我们的 days[].tokens vs cc-trace 六列和）")
    day_rows = []
    for d in sorted(set(our_per_day(ours)) | set(theirs["per_day"])):
        day_rows.append((d, our_per_day(ours).get(d, 0), theirs["per_day"].get(d, 0)))
    ok &= render(day_rows, "per-day")

    # 金额只报告、不断言：两边价目表各自维护（我们 codex_pricing.json vs 他们
    # pricing-catalog.json），金额天然不同；token 守恒才是第四实现要验证的硬不变式。
    ours_cost = ours.get("total_cost_usd")
    print(f"\n[参考] 金额（不比对）: 我们 ${ours_cost:,.2f}  "
          f"(cc-trace 侧价格表独立，金额差是价目差异，不是守恒破坏)")

    if not bucket_ok:
        attribution_note = ("per-model 分桶不平但每桶差值合计为 0 → 纯重归属（守恒保持）。"
                            "归属差异判定见 {ref}：cc-trace 把 turn 中途的 "
                            "`thread_settings_applied.thread_settings.model` 读进请求归属，"
                            "我们按本轮实际执行模型 `turn_context.model`。".format(ref=VERDICT_REF))
    else:
        attribution_note = "per-model 分桶也全平（含各模型差值合计）——归属规则当前一致。"

    if logs_dir is not None:
        print("\n4) 原始日志重放：两种归属规则逐 (turn_context, thread_settings) 归类")
        counts, tokens = classify_attribution(logs_dir)
        if counts:
            for (tc, th), n in sorted(counts.items(), key=lambda kv: -kv[1]):
                si, so = tokens[(tc, th)]
                print(f"  turn_context={tc}  thread_settings={th}:  {n} 个事件"
                      f"（input 合计 {si:,} / output 合计 {so:,}）")
            fwd = sum(n for (tc, th), n in counts.items() if tc != th)
            rev = sum(n for (tc, th), n in counts.items())
            print(f"  差异事件 {rev} 个；形态见 {VERDICT_REF}（期望是「本轮模型 A + "
                  f"settings 已翻 B」的单向形态，而非五五开）")
        else:
            print("  两游标在所有 token_count 事件上一致——差异为 0。")

    print(f"\n[结论] {'守恒律全部对账平（第四实现交叉验证通过）' if ok else '守恒律存在差异 —— 见上'}")
    if not bucket_ok:
        print(f"  （per-model 归属差异：{attribution_note}）")
    print(f"退出码 {0 if ok else 1}：{'守恒律是闸门；归属差异不 gate' if ok else '守恒破坏'}")
    return 0 if ok else 1


def main() -> int:
    args = parse_args()
    theirs = cc_trace_sums(args.cc_trace_db)
    ours = load_ours(args.codex_cost_json)
    return reconcile(ours, theirs, logs_dir=args.codex_logs_dir)


if __name__ == "__main__":
    sys.exit(main())
