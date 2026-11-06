#!/usr/bin/env python3
"""生成 `fixtures/codex/cost/` 的三份 rollout 夹具，供 `codex-cost` 的差分与
characterization 测试使用。

与 `fixtures/codex/build_codex_fixture.py` 同一惯例：**确定性**（固定时间戳/ID，
重跑产出字节相同的文件）+ **自校验**（重读自己写出的文件，用真实的 fold/计价
代码断言本文件顶部注释里手算好的期望值，夹具停止覆盖某个行为时响亮失败）。

三份文件覆盖的折叠/计价行为（对应 `docs/CC_TRACE_APPLICATION.md` §D 的实现）：

- `rollout-sol.jsonl`（gpt-5.6-sol）：token_count 在首个 turn_context 之前 →
  unaccounted `token_count_before_turn_context`；去重的**两种形态**（整段复读
  `last==total` 与清零复读 `last` 全 0，都靠 total 签名命中跳过）；last 无效
  （reasoning > output）→ unaccounted `token_count_invalid_last_usage`；
  cache_write 全部进 5m 档；input_total 超阈值 → longContext 乘数。
- `rollout-terra.jsonl`（gpt-5.6-terra → 中途切 gpt-5.6-luna）：model 游标中途
  切换、同一天两个模型分桶；放 archived_sessions 根里，验证归档会话不漏扫。
- `rollout-unpriced.jsonl`（codex-auto-review）：无价目模型 → priced:false、
  token 进 `unpriced_tokens`（诚实上报，不按 0 价冒充）。

夹具跑出来的期望值（手算，与定价表 `assets/codex_pricing.json`
一致；下面 `EXPECTED` 断言的就是这些）：

- sol：08-01 桶（uncached 50000/cached 40000/write 10000/output 10000）= $0.6325；
  08-02 桶（uncached 120000/cached 150000/write 30000/output 60000，input_total
  300000 > 272000 → LC）= $4.425；合计 $5.0575。
- terra：uncached 65000/cached 30000/write 5000/output 20000 = $0.3885。
- luna：uncached 130000/cached 60000/write 10000/output 50000 = $0.0897。
- codex-auto-review：5000+1000 = 6000 tokens，priced:false，unpriced_tokens=6000。
- unaccounted：`token_count_before_turn_context` ×1（tokens_seen 1100）、
  `token_count_invalid_last_usage` ×1（tokens_seen 670）。
- plan（配额快照）：sol 08-02 事件带 plus 67%/11%（observed_at 08-02）、unpriced
  08-03 事件带 plus 77%/9%（observed_at 08-03 12:00:01，全夹具最新）→ **跨文件
  merge 取 08-03 的 77%**（observed_at 最大者赢）。unpriced 12:05 再加一个降级
  快照（info:null + primary/secondary 全 null）——observed_at 前进到 12:05，但
  **limits 保留 77%/9%**（降级快照不抹配额条）。terra 文件无 rate_limits → 其
  fold 的 plan 是 None，merge 跳过。
"""

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]  # 本仓库根

# 让本脚本能 import 仓库里的实现（自校验要用真实 fold/计价）。
sys.path.insert(0, str(REPO / "scripts"))
from agent_vitals import codex_usage, codex_cost  # noqa: E402
from agent_vitals.codex_cost import load_codex_pricing  # noqa: E402


def tc(ts, model, service_tier=None):
    """turn_context 事件行。service_tier 缺省 None（真实语料全 null → speed 默认
    standard）；显式传字符串可造 fast 行（本夹具不用，留给单测）。"""
    payload = {"model": model, "service_tier": service_tier}
    return {"timestamp": ts, "type": "turn_context", "payload": payload}


def tkn_null(ts, rate_limits=None):
    """token_count 事件，但 `info` 是 JSON `null`（真实语料 2026-08-19 rollout 里
    出现过）——事件**没有任何 token 字段**，fold 必须跳过：不进桶、不进 unaccounted。
    曾让 Py↔Rust 分歧：Rust 把 `info: null` 当「有 info」继续读 last → 误报
    `token_count_invalid_last_usage`；Python 的 `isinstance(info, dict)` 直接跳过。
    rate_limits 可选：**info:null 的事件仍带 rate_limits**（配额独立于 token 计量，
    这正是 fold「即使 info 为 null 也读配额」的理由）。"""
    payload = {"type": "token_count", "info": None}
    if rate_limits is not None:
        payload["rate_limits"] = rate_limits
    return {
        "timestamp": ts,
        "type": "event_msg",
        "payload": payload,
    }


def tkn(ts, total, last, rate_limits=None):
    """token_count 事件行。total/last 是 6 元组
    (input, output, cached, cache_write, reasoning, total_tokens)。
    rate_limits 缺省 None（不带配额状态）；传 dict 时原样放进 payload——
    fold 从 token_count 读配额，**即使 info 为 null 也读**，所以配额附着在
    有效桶事件上就能被折叠。"""
    def obj(t):
        (ti, to, tc, tw, tr, tt) = t
        return {
            "input_tokens": ti, "output_tokens": to,
            "cached_input_tokens": tc, "cache_write_input_tokens": tw,
            "reasoning_output_tokens": tr, "total_tokens": tt,
        }
    payload = {
        "type": "token_count",
        "info": {
            "total_token_usage": obj(total),
            "last_token_usage": obj(last),
            "model_context_window": 258400,
        },
    }
    if rate_limits is not None:
        payload["rate_limits"] = rate_limits
    return {
        "timestamp": ts,
        "type": "event_msg",
        "payload": payload,
    }


# 真实 rate_limits 形态（2026-08 本机语料，plan_type="plus"）。fold 只读
# plan_type / credits.has_credits / primary|secondary 的 used_percent 三字段，
# 其余键（limit_id、unlimited 等）不碰——保留它们以保持「真实形状」。
def rate_limits(plan_type, primary_pct, secondary_pct, primary_resets, secondary_resets):
    return {
        "limit_id": "codex:limit:" + plan_type,
        "limit_name": "codex " + plan_type + " limit",
        "plan_type": plan_type,
        "credits": {"has_credits": False, "unlimited": False, "balance": 0},
        "primary": {
            "used_percent": primary_pct,
            "window_minutes": 300,
            "resets_at": primary_resets,
        },
        "secondary": {
            "used_percent": secondary_pct,
            "window_minutes": 10080,
            "resets_at": secondary_resets,
        },
        "individual_limit": None,
        "spend_control_reached": False,
        "rate_limit_reached_type": None,
    }


SOL_D1_TOTAL = (100000, 10000, 40000, 10000, 2000, 160000)
SOL_D2_TOTAL = (300000, 60000, 150000, 30000, 6000, 540000)

SOL_ROLLOUT = [
    # 1. token_count 在首个 turn_context 之前 → 无法归属模型 → unaccounted
    tkn("2026-08-01T00:00:00Z", (1000, 100, 0, 0, 0, 1100), (1000, 100, 0, 0, 0, 1100)),
    tc("2026-08-01T00:00:01Z", "gpt-5.6-sol"),
    # 2. info 为 JSON null → 跳过（不进桶、不进 unaccounted；见 tkn_null docstring）
    tkn_null("2026-08-01T00:00:01Z"),
    # 3. 合法桶：uncached=100000-40000-10000=50000
    tkn("2026-08-01T00:00:02Z", SOL_D1_TOTAL, SOL_D1_TOTAL),
    # 4. 整段复读：total 签名不变，last 原样 → 去重跳过
    tkn("2026-08-01T00:00:03Z", SOL_D1_TOTAL, SOL_D1_TOTAL),
    # 5. 清零复读：total 签名不变，last 全 0 + 假 total → 仍在去重层跳过（不进
    #    invalid_last_usage——同一计量的复读不是残差）
    tkn("2026-08-01T00:00:04Z", SOL_D1_TOTAL, (0, 0, 0, 0, 0, 0)),
    # 6. 新签名但 last 无效（reasoning 70 > output 60）→ unaccounted invalid
    tkn("2026-08-01T00:00:05Z", (600, 60, 0, 0, 70, 670), (600, 60, 0, 0, 70, 670)),
    # 7. longContext：input_total 300000 > 272000 → input ×2、output ×1.5；
    #    同时带配额快照（plus，67%）。observed_at = 2026-08-02T00:00:00Z。
    tkn("2026-08-02T00:00:00Z", SOL_D2_TOTAL, SOL_D2_TOTAL,
        rate_limits("plus", 67.0, 11.0, 1787858552, 1788351817)),
]

TERRA_ROLLOUT = [
    tc("2026-07-15T09:00:00Z", "gpt-5.6-terra"),
    tkn("2026-07-15T09:00:01Z",
        (100000, 20000, 30000, 5000, 2000, 155000),
        (100000, 20000, 30000, 5000, 2000, 155000)),
    # model 游标中途切换 → 同一天两个模型分桶
    tc("2026-07-15T09:01:00Z", "gpt-5.6-luna"),
    tkn("2026-07-15T09:01:01Z",
        (200000, 50000, 60000, 10000, 5000, 320000),
        (200000, 50000, 60000, 10000, 5000, 320000)),
]

UNPRICED_ROLLOUT = [
    tc("2026-08-03T12:00:00Z", "codex-auto-review"),
    # 全夹具里 observed_at 最新的事件（08-03 12:00:01Z > 08-02）→ merge 时这份
    # 配额快照赢（77%）。与 sol 的 67% 不同，证明跨文件 merge 取的是最新快照。
    tkn("2026-08-03T12:00:01Z", (5000, 1000, 0, 0, 0, 6000), (5000, 1000, 0, 0, 0, 6000),
        rate_limits("plus", 77.0, 9.0, 1787900000, 1788351817)),
    # 降级快照：info:null 且 primary/secondary 全 null（真实语料 2026-08-27 18:18
    # 事件同款）——只有 plan_type + limit_id。这事件让 observed_at 前进到 12:05，
    # 但 **limits 必须保留上一次的 77%/9%**（真实 defect：直接覆盖会抹掉配额条）。
    tkn_null("2026-08-03T12:05:00Z", {
        "limit_id": "premium",
        "limit_name": None,
        "plan_type": "plus",
        "credits": {"has_credits": False, "unlimited": False, "balance": "0"},
        "primary": None,
        "secondary": None,
    }),
]

FILES = {
    "rollout-sol.jsonl": SOL_ROLLOUT,
    "rollout-terra.jsonl": TERRA_ROLLOUT,
    "rollout-unpriced.jsonl": UNPRICED_ROLLOUT,
}

# ── 自校验：用真实 fold/计价代码断言手算的期望值 ────────────────────────────────
def _fold_file(rollout):
    return codex_usage.codex_fold_file(rollout)


def _expect_cost(bucket, expected):
    entry = load_codex_pricing()
    # 直接从 folding 结果里取桶，喂给同一个 codex_cost 计价函数
    sol_entry = None
    for e in entry["entries"]:
        if e.get("modelPrefix") == "gpt-5.6-sol" and e.get("speed") == "standard":
            sol_entry = e
            break
    assert sol_entry is not None, "定价表里必须有 gpt-5.6-sol standard 行"
    from agent_vitals.codex_cost import _price_bucket  # 内部计价函数，逐字节对齐 Rust
    got = _price_bucket(bucket, sol_entry)
    assert abs(got - expected) < 1e-9, "sol 桶计价 %.9f != 期望 %.9f" % (got, expected)


def self_check():
    sol_fold = _fold_file(SOL_ROLLOUT)
    sol_bm = sol_fold["by_model"]["gpt-5.6-sol"]["standard"]
    # uncached 派生 + cache_write 进桶
    assert sol_bm["uncached_input_tokens"] == 50000 + 120000, sol_bm
    assert sol_bm["cached_input_tokens"] == 40000 + 150000, sol_bm
    assert sol_bm["cache_write_input_tokens"] == 10000 + 30000, sol_bm
    assert sol_bm["output_tokens"] == 10000 + 60000, sol_bm
    assert sol_bm["reasoning_output_tokens"] == 2000 + 6000, sol_bm
    # 去重：整段复读 + 清零复读都被跳过 → 只有 2 个真桶（08-01、08-02 各一小时）。
    # 时间轴是小时桶（统一多桶折叠契约，见 docs/UNIFIED_COST_VIEW.md）。
    assert set(sol_fold["by_hour_model"].keys()) == {"2026-08-01T00", "2026-08-02T00"}, sol_fold["by_hour_model"]
    # unaccounted 两条，type 升序
    ua = sol_fold["unaccounted"]
    assert [u["type"] for u in ua] == ["token_count_before_turn_context", "token_count_invalid_last_usage"], ua
    assert ua[0]["count"] == 1 and ua[0]["tokens_seen"] == 1100, ua
    assert ua[1]["count"] == 1 and ua[1]["tokens_seen"] == 670, ua
    # 计价：逐桶（含 longContext）
    d1 = sol_fold["by_hour_model"]["2026-08-01T00"]["gpt-5.6-sol"]["standard"]
    d2 = sol_fold["by_hour_model"]["2026-08-02T00"]["gpt-5.6-sol"]["standard"]
    _expect_cost(d1, 0.6325)
    _expect_cost(d2, 4.425)

    terra_fold = _fold_file(TERRA_ROLLOUT)
    assert set(terra_fold["by_hour_model"].keys()) == {"2026-07-15T09"}
    assert set(terra_fold["by_hour_model"]["2026-07-15T09"].keys()) == {"gpt-5.6-terra", "gpt-5.6-luna"}

    up_fold = _fold_file(UNPRICED_ROLLOUT)
    assert up_fold["by_model"]["codex-auto-review"]["standard"]["uncached_input_tokens"] == 5000
    assert up_fold["by_model"]["codex-auto-review"]["standard"]["output_tokens"] == 1000

    # ── plan（配额快照）────────────────────────────────────────────────
    # sol 08-02 事件的 rate_limits → 单文件最后看见的赢。
    sol_plan = sol_fold["plan"]
    assert sol_plan["plan_type"] == "plus", sol_plan
    assert sol_plan["has_credits"] is False, sol_plan
    # used_percent 保类型（真实语料是 float 67.0；整数也合法，别强转）。
    assert sol_plan["limits"]["primary"]["used_percent"] == 67.0, sol_plan
    assert sol_plan["limits"]["primary"]["window_minutes"] == 300, sol_plan
    assert sol_plan["limits"]["primary"]["resets_at"] == 1787858552, sol_plan
    assert sol_plan["limits"]["secondary"]["used_percent"] == 11.0, sol_plan
    assert sol_plan["limits"]["secondary"]["window_minutes"] == 10080, sol_plan
    assert sol_plan["observed_at"] == "2026-08-02T00:00:00Z", sol_plan

    # unpriced 文件 plan：observed_at 前进到 12:05（降级快照），但 limits 保留
    # 12:00:01 的 77%——降级快照不抹掉配额条（真实 defect 的回归）。
    up_plan = up_fold["plan"]
    assert up_plan["plan_type"] == "plus", up_plan
    assert up_plan["observed_at"] == "2026-08-03T12:05:00Z", up_plan
    assert up_plan["limits"]["primary"]["used_percent"] == 77.0, up_plan
    assert up_plan["limits"]["primary"]["window_minutes"] == 300, up_plan
    assert up_plan["limits"]["primary"]["resets_at"] == 1787900000, up_plan

    # terra 无 rate_limits → plan None（merge 必须跳过，不被它污染）。
    assert _fold_file(TERRA_ROLLOUT)["plan"] is None

    # 跨文件 merge：observed_at 最大者赢（08-03 12:05 的 plus），limits 是最后
    # 非空限额（77%）。
    merged = codex_usage.codex_merge_folds([sol_fold, _fold_file(TERRA_ROLLOUT), up_fold])
    mplan = merged["plan"]
    assert mplan["plan_type"] == "plus", mplan
    assert mplan["limits"]["primary"]["used_percent"] == 77.0, mplan
    assert mplan["limits"]["secondary"]["used_percent"] == 9.0, mplan
    assert mplan["observed_at"] == "2026-08-03T12:05:00Z", mplan
    print("self-check OK")


def main():
    self_check()
    for name, rollout in FILES.items():
        text = "".join(json.dumps(e, ensure_ascii=False) + "\n" for e in rollout)
        (HERE / name).write_text(text, encoding="utf-8")
        print("wrote %s (%d events)" % (name, len(rollout)))


if __name__ == "__main__":
    main()
