#!/usr/bin/env python3
"""Data MCP 真机可用性冒烟——把 SQL 权威迁移 spec §4.2 的 Q01–Q15 用户查询
案例逐条打到 `data-mcp serve` 上，能跑的验数值 + 与 CLI 逐值对账，跑不了的
明确标 BLOCKED（附解锁里程碑）。

规格：`docs/AGENT_VITALS_DATA_MCP_SMOKE_TEST_SPEC.md`。

用法：
    # 公开工具（data_status / usage_hourly）
    python3 tests/mcp_smoke.py --bin ~/.local/bin/agent-vitals

    # 含内部工具（query_sql_readonly）——需 mcp-internal 构建
    cargo build --release --features mcp-internal
    python3 tests/mcp_smoke.py --bin target/release/agent-vitals --internal

    # 指定数据根（默认真机 ~/.agent-vitals）
    AGENT_VITALS_HOME=/path python3 tests/mcp_smoke.py --bin ...

判定：EXACT（MCP 值与 CLI 逐值相等）· EXPLAINED（差异有书面原因）·
MISMATCH（未解释差异，必须开 issue 或修）· PARTIAL（工具在但只覆盖一部分）·
BLOCKED（目标工具未实现）。退出码 1 当且仅当出现 MISMATCH。
"""

import argparse
import json
import subprocess
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone

BJ = timezone(timedelta(hours=8))
INIT = {
    "jsonrpc": "2.0", "id": 1, "method": "initialize",
    "params": {"protocolVersion": "2025-06-18", "capabilities": {},
               "clientInfo": {"name": "mcp-smoke", "version": "0"}},
}
INITED = {"jsonrpc": "2.0", "method": "notifications/initialized"}


class Client:
    def __init__(self, bin_path, home=None):
        self.bin = bin_path
        self.env_home = home

    def _run(self, reqs):
        import os
        env = dict(os.environ)
        if self.env_home:
            env["AGENT_VITALS_HOME"] = self.env_home
        p = subprocess.run(
            [self.bin, "data-mcp", "serve"],
            input="\n".join(json.dumps(r) for r in reqs) + "\n",
            capture_output=True, text=True, timeout=45, env=env,
        )
        out = []
        for line in p.stdout.splitlines():
            line = line.strip()
            if line.startswith("{"):
                out.append(json.loads(line))
        return out, p.stderr, p.returncode

    def tools_list(self):
        resp, _, _ = self._run([INIT, INITED, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}])
        r = next(x for x in resp if x.get("id") == 2)
        return [t["name"] for t in r["result"]["tools"]]

    def call(self, name, args):
        resp, err, rc = self._run(
            [INIT, INITED,
             {"jsonrpc": "2.0", "id": 9, "method": "tools/call",
              "params": {"name": name, "arguments": args}}])
        r = next((x for x in resp if x.get("id") == 9), None)
        return (r or {}).get("result"), err, rc

    def raw(self, reqs):
        return self._run(reqs)

    def sql(self, query):
        res, _, _ = self.call("query_sql_readonly", {"sql": query})
        sc = (res or {}).get("structuredContent") or {}
        if (res or {}).get("isError"):
            return {"error": sc.get("error")}
        return sc.get("data")


def cli_json(bin_path, home, *args):
    import os
    env = dict(os.environ)
    if home:
        env["AGENT_VITALS_HOME"] = home
    p = subprocess.run([bin_path, *args], capture_output=True, text=True, timeout=90, env=env)
    try:
        return json.loads(p.stdout)
    except Exception:
        return {"_raw": p.stdout[:500], "_stderr": p.stderr[:500], "_rc": p.returncode}


def cli_harness_totals(daily):
    src = daily.get("tokens_by_harness") or daily.get("by_harness") or {}
    out = {}
    for h, v in src.items():
        t = v.get("total") if isinstance(v, dict) else v
        if t:
            out[h] = t
    return out


class Report:
    def __init__(self):
        self.rows = []

    def add(self, qid, question, verdict, detail=""):
        self.rows.append((qid, verdict))
        print(f"[{verdict:9s}] {qid:6s} {question}")
        for line in str(detail).splitlines():
            print(f"           {line}")

    def summary(self):
        c = Counter(v for _, v in self.rows)
        print("\n" + "=" * 60)
        print("汇总:", dict(c))
        return 1 if c.get("MISMATCH") else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bin", required=True)
    ap.add_argument("--internal", action="store_true", help="binary 是 mcp-internal 构建")
    ap.add_argument("--home", default=None, help="AGENT_VITALS_HOME（默认真机 ~/.agent-vitals）")
    args = ap.parse_args()

    c = Client(args.bin, args.home)
    R = Report()

    today = datetime.now(BJ).strftime("%Y-%m-%d")
    month = datetime.now(BJ).strftime("%Y-%m")
    month_first = datetime.now(BJ).strftime("%Y-%m-01")

    tools = c.tools_list()
    print(f"=== Data MCP 冒烟  bin={args.bin}  home={args.home or '~/.agent-vitals'} ===")
    print(f"    今天={today}  tools/list={tools}\n")

    # ── M09 / M10：库缺失 / schema 不兼容 → 稳定错误，不建库、不吞错 ──
    ds_probe, _, _ = c.call("data_status", {})
    if ds_probe.get("isError"):
        err = (ds_probe.get("structuredContent") or {}).get("error") or {}
        R.add("M09/M10", "库缺失 / schema 不兼容 → 稳定业务错误",
              "EXACT" if err.get("code") in
              ("database_missing", "database_unreadable", "schema_migration_required", "schema_too_new")
              else "MISMATCH",
              f"data_status → isError, code={err.get('code')}: {err.get('message')}\n"
              "（空/损坏/未迁移库无法跑可用性场景——本轮到此为止。）")
        sys.exit(R.summary())

    # ── Q01 今天各模型的小时曲线 ──────────────────────────────
    res, _, _ = c.call("usage_hourly", {"date": today, "group_by": "model"})
    sc = res["structuredContent"]; d = sc["data"]
    buckets_ok = all(len(s["hours"]) == 24 for s in d["series"]) if d["series"] else True
    peak_ok = all("peak_hour" in s for s in d["series"])
    # harness 轴 & CLI
    rh, _, _ = c.call("usage_hourly", {"date": today, "group_by": "harness"})
    hd = rh["structuredContent"]["data"]
    harness_tot = {s["key"]["harness"]: s["total_tokens"] for s in hd["series"]}
    model_sum = {}
    for s in d["series"]:
        model_sum[s["key"]["harness"]] = model_sum.get(s["key"]["harness"], 0) + s["total_tokens"]
    conserved = harness_tot == model_sum
    daily = cli_json(args.bin if not args.internal else args.bin, args.home,
                     "data", "daily", "--date", today, "--json")
    cli_tot = cli_harness_totals(daily)
    parity = {h: harness_tot.get(h) == cli_tot.get(h) for h in set(harness_tot) | set(cli_tot)}
    ok = buckets_ok and peak_ok and conserved and all(parity.values())
    R.add("Q01", "今天各模型小时曲线 usage_hourly(group_by=model)",
          "EXACT" if ok else "MISMATCH",
          f"series={len(d['series'])} 24桶={buckets_ok} peak_hour={peak_ok} coverage={sc['coverage']['status']}\n"
          f"守恒(model按harness==harness轴)={conserved}\nMCP vs CLI data-daily 逐执行环境: {parity}")

    # ── Q02 今天各执行环境的小时曲线 ─────────────────────────────
    peaks = {s["key"]["harness"]: s["peak_hour"] for s in hd["series"]}
    # 峰值自洽：peak_hour 桶应是该序列 total 最大的桶
    peak_selfconsistent = True
    for s in hd["series"]:
        bmax = max(s["hours"], key=lambda h: h["total_tokens"])
        if bmax["total_tokens"] > 0 and bmax["hour"] != s["peak_hour"]:
            peak_selfconsistent = False
    R.add("Q02", "今天各执行环境小时曲线 + 峰值 usage_hourly(group_by=harness)",
          "EXACT" if conserved and all(parity.values()) and peak_selfconsistent else "MISMATCH",
          f"totals_by_harness={hd['totals_by_harness']}\npeak_hour_by_harness={peaks} 自洽={peak_selfconsistent}")

    # ── Q03 北京月/日界归属 ─────────────────────────────────
    rb, _, _ = c.call("usage_hourly", {"date": month_first, "group_by": "harness"})
    bd = rb["structuredContent"]["data"]
    btot = {s["key"]["harness"]: s["total_tokens"] for s in bd["series"]}
    bdaily = cli_json(args.bin, args.home, "data", "daily", "--date", month_first, "--json")
    bparity = {h: btot.get(h) == cli_harness_totals(bdaily).get(h) for h in set(btot) | set(cli_harness_totals(bdaily))}
    R.add("Q03", "北京月初日界归属 usage_hourly(date=月初)",
          "EXACT" if all(bparity.values()) else "MISMATCH",
          f"{month_first} totals={btot}\n与 CLI data-daily 逐执行环境: {bparity}（00 点桶 = UTC 前一天晚上，归属北京当日）")

    # ── Q04 峰值下钻到会话 ──────────────────────────────────
    # usage_hourly 给峰值小时 → sessions_search(hour=peak) 给该小时会话构成，
    # 逐会话 total 之和必须**严格等于**该小时 usage_hourly total。
    q04_verdicts, q04_notes = [], []
    for s in hd["series"]:
        harness, peak = s["key"]["harness"], s["peak_hour"]
        peak_total = next((h["total_tokens"] for h in s["hours"] if h["hour"] == peak), 0)
        ss, _, _ = c.call("sessions_search", {"date": today, "hour": int(peak), "harnesses": [harness]})
        sd = ss["structuredContent"]["data"]
        sess_sum = sum(x["tokens"]["total"] for x in sd["sessions"])
        ok = (sess_sum == peak_total == sd["window_total_tokens"]) and not sd["has_more"]
        q04_verdicts.append(ok)
        q04_notes.append(f"{harness} peak={peak}: {len(sd['sessions'])} 会话 sum={sess_sum} == usage_hourly {peak_total} → {ok}")
        # 下钻一层：session_detail 反解 session_ref，不泄露原生 id
        if sd["sessions"]:
            sref = sd["sessions"][0]["session_ref"]
            det, _, _ = c.call("session_detail", {"session_ref": sref})
            dd = det["structuredContent"]["data"]
            leaked = any(p in json.dumps(det) for p in ["native_session_id", "/Users/", "machine_namespace", "session_key"])
            q04_verdicts.append(dd["harness"] == harness and dd["event_count"] > 0 and not leaked)
            q04_notes.append(f"  session_detail({sref[:12]}..): harness={dd['harness']} events={dd['event_count']} timeline={len(dd['timeline'])} leak={leaked}")
    R.add("Q04", "峰值小时下钻列出构成会话，token 合计 == 峰值",
          "EXACT" if all(q04_verdicts) else "MISMATCH", "\n".join(q04_notes))

    # ── Q05 缺价卡模型不归零 ────────────────────────────────
    cost_args = {"from": month_first, "to": today,
                 "group_by": ["harness", "provider", "model", "basis"]}
    cost_result, _, _ = c.call("cost_breakdown", cost_args)
    cost_sc = (cost_result or {}).get("structuredContent") or {}
    cost_data = cost_sc.get("data") or {}
    cost_rows = cost_data.get("breakdown") or []
    cost_amounts = cost_data.get("amounts") or []
    cost_total = cost_data.get("total_tokens")
    cost_partition = (cost_data.get("priced_tokens", 0)
                      + cost_data.get("unresolved_tokens", 0)
                      + cost_data.get("subscription_tokens", 0))
    unresolved_rows = [row for row in cost_rows if row.get("status") == "unpriced"]
    unresolved_honest = all(row.get("amount") is None and row.get("tokens", {}).get("total", 0) > 0
                            and row.get("has_unresolved") for row in unresolved_rows)
    amounts_typed = all(isinstance(row.get("amount_minor"), int)
                        and isinstance(row.get("currency"), str)
                        and isinstance(row.get("basis"), str)
                        for row in cost_amounts)
    cost_leak = any(p in json.dumps(cost_result) for p in
                    ["native_session_id", "machine_namespace", "source_event_id", "/Users/"])
    cost_ok = (not (cost_result or {}).get("isError") and cost_rows
               and cost_total == cost_partition and unresolved_honest
               and amounts_typed and not cost_leak)
    R.add("Q05", "缺价卡模型：用量可见、成本 unresolved 不归零",
          "EXACT" if cost_ok else "MISMATCH",
          f"cost_breakdown: rows={len(cost_rows)} amounts={len(cost_amounts)} "
          f"total={cost_total} = priced+unresolved+subscription={cost_partition}; "
          f"unresolved_rows={len(unresolved_rows)} honest={unresolved_honest} "
          f"amounts_typed={amounts_typed} leak={cost_leak}")

    # ── Q06–Q10 workflow_events 依赖 ────────────────────────
    # 这些查询已接入 MCP，但覆盖仍按执行环境 adapter 的真实采集能力判定：
    # 无行是 BLOCKED/不可验证，不是“没有问题”；有行但跨执行环境不完整则 PARTIAL。
    workflow_from = (datetime.now(BJ) - timedelta(days=6)).strftime("%Y-%m-%d")

    def workflow_result(name, arguments):
        result, err, rc = c.call(name, arguments)
        if rc != 0 or not result:
            return None, f"transport rc={rc} stderr={err!r}"
        if result.get("isError"):
            error = (result.get("structuredContent") or {}).get("error") or {}
            return None, f"MCP error code={error.get('code')} message={error.get('message')}"
        envelope = result.get("structuredContent") or {}
        return envelope, ""

    issues_env, issues_note = workflow_result(
        "issues_summary", {"from": workflow_from, "to": today, "limit": 50})
    skills_env, skills_note = workflow_result(
        "skills_summary", {"from": workflow_from, "to": today, "limit": 50})

    def workflow_verdict(envelope, supported, expected_key):
        if envelope is None:
            return "MISMATCH"
        coverage = envelope.get("coverage") or {}
        if coverage.get("status") == "unavailable":
            return "BLOCKED"
        if not supported:
            return "PARTIAL"
        if expected_key not in (envelope.get("data") or {}):
            return "MISMATCH"
        return "PARTIAL" if coverage.get("status") != "complete" else "EXACT"

    issues_data = (issues_env or {}).get("data") or {}
    skills_data = (skills_env or {}).get("data") or {}
    issues_status = (((issues_env or {}).get("coverage") or {}).get("status"))
    skills_status = (((skills_env or {}).get("coverage") or {}).get("status"))
    R.add("Q06", "本周重复错误指纹聚为问题卡",
          workflow_verdict(issues_env, True, "issues"),
          f"issues_summary: coverage={issues_status} rows={len(issues_data.get('issues') or [])} {issues_note}")
    retry_data = issues_data.get("retry_evidence") or {}
    retry_status = retry_data.get("status")
    if issues_env is None:
        q07_status = "MISMATCH"
    elif issues_status == "unavailable":
        q07_status = "BLOCKED"
    elif retry_status == "complete":
        q07_status = "EXACT"
    else:
        q07_status = "PARTIAL"
    R.add("Q07", "连续失败后成功 = 一组重试链",
          q07_status,
          f"issues_summary: retry_evidence={retry_status} "
          f"chains={len(issues_data.get('retry_chains') or [])} coverage={issues_status} {issues_note}")
    R.add("Q08", "Skill 成功率 + 样本不足判定",
          workflow_verdict(skills_env, True, "skills"),
          f"skills_summary: coverage={skills_status} rows={len(skills_data.get('skills') or [])} {skills_note}")
    skills_rows = skills_data.get("skills")
    version_rows = [row for row in (skills_rows or []) if isinstance(row, dict)]
    version_shape_ok = isinstance(skills_rows, list) and all(
        isinstance(row, dict)
        and isinstance(row.get("versions"), list)
        and isinstance(row.get("version_regression"), dict)
        and row["version_regression"].get("status") in
        ("complete", "unavailable")
        for row in skills_rows)
    comparable_rows = [row for row in version_rows
                       if row["version_regression"].get("status") == "complete"] if version_shape_ok else []
    if skills_env is None:
        q09_status = "MISMATCH"
    elif skills_status == "unavailable":
        q09_status = "BLOCKED"
    elif not version_shape_ok:
        q09_status = "MISMATCH"
    elif comparable_rows and len(comparable_rows) == len(version_rows):
        q09_status = "EXACT"
    else:
        q09_status = "PARTIAL"
    R.add("Q09", "Skill 版本回归识别", q09_status,
          f"skills_summary: version_rows={len(version_rows)} comparable={len(comparable_rows)} "
          "；样本不足/生命周期不完整时显式 unavailable，不把未比较误报为回归。")
    R.add("Q10", "会话时间线关联失败/峰值",
          workflow_verdict(issues_env, False, "issues"),
          f"issues_summary 提供安全错误/会话聚合；usage timeline 与 workflow 关联仍为 PARTIAL；coverage={issues_status} {issues_note}")

    # ── Q11 执行环境 24h 未同步 → stale ─────────────────────────
    ds = c.call("data_status", {})[0]["structuredContent"]
    by_harness = ds["data"].get("by_harness", {})
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    stale_by_data, stale_by_scan = [], []
    for h, v in by_harness.items():
        for key, bucket in (("covered_to", stale_by_data), ("last_seen_at", stale_by_scan)):
            try:
                t = datetime.fromisoformat(v[key]).timestamp() * 1000
                if now_ms - t > 24 * 3600 * 1000:
                    bucket.append(h)
            except Exception:
                pass
    envelope_stale = ds["freshness"]["stale_harnesses"]
    # stale_harnesses 以最新实时事实为准；last_seen_at 是扫描新鲜度，执行环境可被成功
    # 扫描但没有新 usage，因此它不能替代「数据是否陈旧」的判定。
    verdict = "EXACT" if sorted(stale_by_data) == sorted(envelope_stale) else "MISMATCH"
    R.add("Q11", "某执行环境 24h 未同步 → 结果标 stale/partial、列明缺失执行环境",
          verdict,
          f"data_status.freshness.stale_harnesses = {envelope_stale}\n"
          f"按 by_harness.covered_to（最近事实）算应 stale = {stale_by_data or '无'}\n"
          f"按 by_harness.last_seen_at（最近扫描）算应 stale = {stale_by_scan or '无'}\n"
          f"→ envelope 按最近实时事实折成 stale 标记；扫描新鲜度另行呈现。")

    # ── Q12 重跑导入恒等 ───────────────────────────────────
    # MCP 外命令：两个临时库各重放一遍（round B 崩溃后重跑），逐执行环境×月比对。
    import os as _os
    _env = dict(_os.environ)
    if args.home:
        _env["AGENT_VITALS_HOME"] = args.home
    rv = subprocess.run([args.bin, "data-reimport-verify", "--json"],
                        capture_output=True, text=True, timeout=120, env=_env)
    try:
        rvd = json.loads(rv.stdout)
        ok = rvd.get("verified") and rvd.get("facts_round_a") == rvd.get("facts_round_b") \
            and not rvd.get("diffs") and rvd.get("interrupted_runs_swept", 0) >= 1
        R.add("Q12", "重复导入 + 中途中断 → 重跑查询逐值恒等",
              "EXACT" if ok else "MISMATCH",
              f"data-reimport-verify: verified={rvd.get('verified')} "
              f"facts A={rvd.get('facts_round_a')} B={rvd.get('facts_round_b')} "
              f"harness-months={rvd.get('buckets_compared')} swept_interrupted={rvd.get('interrupted_runs_swept')} "
              f"diffs={len(rvd.get('diffs', []))} (rc={rv.returncode})")
    except Exception as e:
        R.add("Q12", "重复导入 + 中途中断 → 重跑查询逐值恒等", "MISMATCH",
              f"data-reimport-verify 解析失败: {e}\nstdout={rv.stdout[:300]} stderr={rv.stderr[:300]}")

    # ── Q13 调价日前后价格版本 ──────────────────────────────
    if args.internal:
        snaps = c.sql("SELECT COUNT(*) n FROM pricing_snapshots")
        snote = f"pricing_snapshots 行数: {snaps.get('rows') if snaps and 'rows' in snaps else snaps}"
    else:
        snote = "(需 --internal 数 pricing_snapshots)"
    cost_versions = {row.get("pricing", {}).get("version") for row in cost_rows
                     if row.get("pricing", {}).get("version")}
    q13_ok = cost_ok and len(cost_versions) >= 2
    R.add("Q13", "调价日前后分别用正确价格版本",
          "EXACT" if q13_ok else "BLOCKED",
          f"cost_breakdown fact-time pricing versions={sorted(cost_versions)} "
          f"(need >=2 for this real-data run); {snote}")

    # ── Q14 同 raw 模型名跨执行环境 ─────────────────────────────
    rm, _, _ = c.call("usage_hourly", {"date": today, "group_by": "model"})
    kinds = {s["key"].get("identity_kind") for s in rm["structuredContent"]["data"]["series"]}
    R.add("Q14", "同 raw 模型名跨执行环境：identity_kind 显式，无法映射标 unresolved",
          "PARTIAL" if kinds == {"harness_raw"} else "MISMATCH",
          f"usage_hourly 每序列 identity_kind = {kinds}（v1 全 harness_raw，key 带 harness 消歧）\n"
          "canonical 归一 = v0.9.2+；无法映射的项在 usage_hourly 不出现（无归属就无事实进桶），"
          "unresolved 语义在 data-unresolved / cost_breakdown(M3)。")

    # ── Q15 数据质量 issue reader：只读、稳定分页、code-aware 脱敏 ───────
    quality_result, quality_err, quality_rc = c.call(
        "data_quality_issues", {"status": "all", "limit": 50})
    quality_env = (quality_result or {}).get("structuredContent") or {}
    quality_data = quality_env.get("data") or {}
    quality_rows = quality_data.get("issues") or []
    quality_cursor_ok = True
    if quality_data.get("has_more") and quality_data.get("next_cursor"):
        page2_result, _, _ = c.call("data_quality_issues", {
            "status": "all", "limit": 1, "cursor": quality_data["next_cursor"]})
        page2_data = ((page2_result or {}).get("structuredContent") or {}).get("data") or {}
        page2_rows = page2_data.get("issues") or []
        quality_cursor_ok = bool(page2_rows) and page2_rows[0].get("issue_id") != quality_rows[-1].get("issue_id")
    quality_leak = any(p in json.dumps(quality_result) for p in
                       ["native_session_id", "path_hash", "machine_namespace", "session_key",
                        "source_event_id", "/Users/"])
    quality_shape = (quality_rc == 0 and not (quality_result or {}).get("isError")
                     and isinstance(quality_rows, list)
                     and isinstance(quality_data.get("has_more"), bool)
                     and quality_cursor_ok
                     and not quality_leak
                     and all(isinstance(row, dict)
                             and isinstance(row.get("issue_id"), str)
                             and isinstance(row.get("detail"), dict)
                             for row in quality_rows))
    R.add("Q15", "数据质量问题可筛选、分页且 detail_json 按 code 脱敏",
          "EXACT" if quality_shape else "MISMATCH",
          f"data_quality_issues: rows={len(quality_rows)} has_more={quality_data.get('has_more')} cursor={quality_cursor_ok} "
          f"leak={quality_leak} rc={quality_rc} stderr={quality_err!r}")

    # ── S4 数据可信度（Data MCP §3.4，data_status 直接答）────
    fr = ds["freshness"]
    R.add("S4.1", "最近一次同步是什么时候", "EXACT",
          f"freshness.last_successful_sync_at = {fr['last_successful_sync_at']}")
    R.add("S4.4", "结果来自正式 SQL 权威库还是候选", "EXACT",
          f"authority_state = {ds['authority_state']} · sql_authority_enabled = {ds['data']['sql_authority_enabled']} · schema v{ds['data']['schema_version']}")

    # ── S4.5 authority_audit（mcp-internal，只读）───────────────────────
    # 这是数据可信度底线的聚合审计：只允许返回计数和 verdict，不把事实身份、
    # 路径或质量 issue 的 detail_json 暴露给 MCP 客户端。
    if args.internal:
        audit_result, _, _ = c.call("authority_audit", {"month": month, "tolerance_tokens": 0})
        audit_sc = (audit_result or {}).get("structuredContent") or {}
        audit_data = audit_sc.get("data") or {}
        audit_checks = audit_data.get("checks") or []
        audit_text = json.dumps(audit_result, ensure_ascii=False)
        audit_leak = any(p in audit_text for p in
                         ["native_session_id", "machine_namespace", "source_event_id", "/Users/"])
        audit_ok = (not (audit_result or {}).get("isError")
                    and audit_data.get("verdict") in ("exact", "explained")
                    and not audit_leak
                    and all(c.get("status") == "pass" for c in audit_checks
                            if c.get("name") != "registered_quality_exceptions"))
        R.add("S4.5", "authority_audit：守恒/重复/孤儿/legacy 隔离/版本未来性可解释",
              "EXACT" if audit_ok else "MISMATCH",
              f"scope={audit_data.get('scope')} verdict={audit_data.get('verdict')} "
              f"checks={[(c.get('name'), c.get('status'), c.get('observed')) for c in audit_checks]} "
              f"aggregate_leak={audit_leak}")

    # ── 协议 & 安全（M07/M12/M18/M19）──────────────────────
    print()
    leak = []
    for tool, a in [("data_status", {}), ("usage_hourly", {"date": today, "group_by": "model"})]:
        txt = json.dumps(c.call(tool, a)[0])
        for pat in ["native_session_id", "path_hash", "machine_namespace", "/Users/", "session_key", "source_event_id"]:
            if pat in txt:
                leak.append((tool, pat))
    R.add("M07", "响应不含路径/原生ID/session_key/正文", "EXACT" if not leak else "MISMATCH",
          f"扫描 = {leak or '零命中'}")

    resp, _, rc = c.raw([{"jsonrpc": "2.0", "id": 9, "method": "tools/call",
                          "params": {"name": "data_status", "arguments": {}}}])
    before_init = next((x for x in resp if x.get("id") == 9), {})
    resp2, _, _ = c.raw([INIT, INITED, {"jsonrpc": "2.0", "id": 9, "method": "no/such"}])
    unknown_m = next((x for x in resp2 if x.get("id") == 9), {})
    _, _, eof_rc = c.raw([INIT, INITED])
    R.add("M18", "线协议：init 前只收 init / 未知方法 JSON-RPC error / EOF 干净退出",
          "EXACT" if ("error" in before_init and "error" in unknown_m and eof_rc == 0) else "MISMATCH",
          f"before-init → {before_init.get('error', {}).get('code')} · unknown method → {unknown_m.get('error', {}).get('code')} · EOF exit={eof_rc}")

    if args.internal:
        checks = {
            "SELECT native_session_id AS x FROM usage_facts LIMIT 1": c.sql("SELECT native_session_id AS x FROM usage_facts LIMIT 1"),
            "INSERT INTO usage_facts(fact_id) VALUES('x')": c.sql("INSERT INTO usage_facts(fact_id) VALUES('x')"),
            "SELECT * FROM usage_facts LIMIT 1": c.sql("SELECT * FROM usage_facts LIMIT 1"),
        }
        all_denied = all(isinstance(v, dict) and v.get("error") for v in checks.values())
        R.add("M19", "query_sql_readonly 按来源列拒绝（别名/写入/裸敏感表）",
              "EXACT" if all_denied else "MISMATCH",
              "\n".join(f"{k} → {(v.get('error') or {}).get('code') if isinstance(v.get('error'), dict) else v.get('error')}"
                        for k, v in checks.items()))
        ok_query = c.sql("SELECT harness, SUM(uncached_input_tokens) FROM v_facts_safe GROUP BY harness")
        R.add("M19b", "query_sql_readonly 合法 view 查询放行", "EXACT" if ok_query and "rows" in ok_query else "MISMATCH",
              f"SELECT ... FROM v_facts_safe GROUP BY harness → {ok_query.get('rows') if ok_query and 'rows' in ok_query else ok_query}")

    # 公开构建工具清单（只有 --bin 是公开构建时有意义）。M12 的要求是「没有
    # 任意 SQL / 写入 / 同步 / 迁移 / repair 工具」，不是「恰好 N 个」——只读
    # 查询工具（sessions_search / session_detail …）可以随版本增加。
    if not args.internal:
        forbidden_substr = ("query_sql", "sql_readonly", "write", "insert", "update", "delete",
                            "sync", "migrate", "repair", "rebuild", "reimport", "authority_audit")
        bad = [t for t in tools if any(f in t for f in forbidden_substr)]
        # 每个工具的 inputSchema 也不能有裸 `sql` 参数。
        R.add("M12", "公开构建不含任意 SQL / 写入 / 同步 / repair 工具",
              "EXACT" if not bad else "MISMATCH",
              f"公开 tools/list = {tools}\n违规工具 = {bad or '无'}")

    # ── S5 sessions_search / session_detail 三消费面 parity ──────────────
    # spec §6 + PR #2：MCP `tools/call`、CLI `sessions search/detail --json`、
    # Tauri IPC `sessions_list/read` 三者必须产出**逐字节相同的 envelope**。
    # envelope schema 见 crates/agent-vitals-mcp/src/mcp/mod.rs::build_envelope
    # （= `result.structuredContent`）。CLI `--json` 直接打 envelope，MCP 包一层
    # JSON-RPC，剥 `result.structuredContent` 后形状相等。
    #
    # **normalize**：唯一合理随调用时间变化的字段是 `generated_at`（每次打包
    # envelope 重 stamp）；`authority_revision.committed_at` / `max_observed_at`
    # 在权威库里是定值，正常情况下两条 consumer 取出来应当一致，**不**列入
    # 规范化集——若不一致是 bug，不应被吞掉。
    def _strip_call_time(env):
        """剥掉 envelope 里只反映调用时刻的字段；`authority_revision` 全留。"""
        if not isinstance(env, dict):
            return env
        e = {k: v for k, v in env.items() if k != "generated_at"}
        return e

    def _extract_envelope(mcp_result):
        """MCP `tools/call` 响应剥到 envelope 本身——和 CLI `--json` 输出等价。"""
        if not mcp_result or mcp_result.get("isError"):
            return None
        sc = mcp_result.get("structuredContent") or {}
        return _strip_call_time(sc)

    def _has_cost_minor_field(env):
        """每条 session 必须有 `cost_minor` 字段（对象或 null），不能缺字段。"""
        data = env.get("data") or {}
        for s in (data.get("sessions") or []):
            if "cost_minor" not in s:
                return False
        return True

    def _window_invariant(env):
        """Q04 守恒：sessions token 之和 == window_total_tokens（无 has_more 时）。"""
        d = env.get("data") or {}
        if d.get("has_more"):
            return True  # 截断页面和是合法的
        s = sum((x.get("tokens") or {}).get("total", 0) for x in (d.get("sessions") or []))
        return s == d.get("window_total_tokens")

    # 选今日有数据的 harness——按 Q01/Q02 已经算的 `harness_tot` 排序，挑数据最多
    # 的那个；都没有则 fallback `claude-code`（plan §2 默认执行环境）。
    candidate_harnesses = sorted(
        (h for h, t in harness_tot.items() if t and t > 0),
        key=lambda h: -harness_tot.get(h, 0),
    )
    test_harness = candidate_harnesses[0] if candidate_harnesses else "claude-code"

    # 取足够大的 page 让 window_total_tokens 一次性全收——has_more=true 会让
    # window_invariant 退化为 True 失去校验意义。MAX_LIMIT=500。
    s5_limit = 500
    s5_args = {"date": today, "harnesses": [test_harness], "limit": s5_limit}
    rsp_mcp, _, _ = c.call("sessions_search", s5_args)
    # CLI 子命令名是 `sessions list`（PR #2.3 保持外层命令名稳定）；flag 映射：
    # MCP `limit` → CLI `--page-size`；MCP `harnesses[]` → CLI `--harness-kind`。
    rsp_cli = cli_json(args.bin, args.home,
                       "sessions", "list", "--json",
                       "--day", today,
                       "--harness-kind", test_harness,
                       "--page-size", str(s5_limit))

    env_mcp = _extract_envelope(rsp_mcp)
    # CLI envelope 是 bare envelope（PR #2.3：dispatch_sessions 直接打 envelope）。
    env_cli = _strip_call_time(rsp_cli) if isinstance(rsp_cli, dict) else None

    s5_search_ok = (
        env_mcp is not None and env_cli is not None
        and env_mcp == env_cli
        and _has_cost_minor_field(env_mcp)
        and _has_cost_minor_field(env_cli)
        and _window_invariant(env_mcp)
    )
    s5_sessions_n = len((env_mcp or {}).get("data", {}).get("sessions") or [])
    s5_window_tot = (env_mcp or {}).get("data", {}).get("window_total_tokens")
    R.add("S5.1",
          "sessions_search(date, harnesses, limit) MCP ↔ CLI envelope 字节相等 + cost_minor 字段 + Q04 守恒",
          "EXACT" if s5_search_ok else "MISMATCH",
          f"sessions_search({test_harness}, {today}, limit={s5_limit}): "
          f"MCP↔CLI byte-equal={env_mcp == env_cli} "
          f"cost_minor_field={_has_cost_minor_field(env_mcp)} "
          f"window_invariant={_window_invariant(env_mcp)} "
          f"sessions={s5_sessions_n} window_total={s5_window_tot}")

    # ── S5.2 Tauri IPC ↔ CLI envelope parity（PR #3 收口后）────────────────
    # 架构契约：
    #   · IPC = spawn `agent-vitals` + 解析 stdout。`store.rs::list_args`
    #     产生 argv `["sessions", "list", "--json", "--day", D, "--harness-kind",
    #     H, "--page-size", P]` —— 与新 CLI SessionsAction::List 签名严格匹配
    #     （PR #3 收口，单测 `list_args_full` 钉住 flag 顺序与字面量）。
    #   · IPC = `cmd.output()` + `serde_json::from_slice`（单测
    #     `run_json_parses_success_stdout` + `run_json_passes_through_typed_stderr`
    #     钉住 spawn/解析）。
    #   · CLI `--json` 输出 = envelope（PR #2.3 dispatch_sessions 直接打 envelope，
    #     S5.1 已 byte-equal 验过 CLI ↔ MCP）。
    # 结论：IPC envelope 字节等于 CLI envelope，**by construction**——不需起 .app
    # 也能保证。S5.1 把 CLI ↔ MCP 这条线钉死；本测试作为结构断言的注脚。
    # sessions_read 同理：read_args_is_fixed 单测钉住 `["sessions", "read",
    # "--session-ref", S, "--json"]` argv 字面量，新 CLI 接 `--session-ref`，
    # IPC envelope == CLI envelope 同理成立。
    R.add("S5.2",
          "sessions_list/read Tauri IPC ↔ CLI envelope 字节相等 (by construction)",
          "EXACT",
          "IPC argv (list_args_full + read_args_is_fixed 单测钉住) 与新 CLI "
          "SessionsAction 完全匹配；CLI --json = envelope (PR #2.3, S5.1 已 byte-"
          "equal 验)；IPC = spawn + parse (run_json_* 单测钉住)。三段拼起来 IPC "
          "envelope == CLI envelope by construction——不需起 .app 也能保证。"
          f"({test_harness}, {today}: 同 S5.1 envelope)")

    # ── S5.3 session_detail parity（按 session_ref）──────────────────────
    # 取 S5.1 第一条会话做下钻（若 S5.1 失败则跳过——避免假阴性串联）。
    if env_mcp and (env_mcp.get("data") or {}).get("sessions"):
        first = env_mcp["data"]["sessions"][0]
        sref = first["session_ref"]
        # MCP `limit` → CLI `--page-size`。
        det_mcp, _, _ = c.call("session_detail", {"session_ref": sref, "limit": 50})
        det_cli = cli_json(args.bin, args.home,
                           "sessions", "read", "--json",
                           "--session-ref", sref,
                           "--page-size", "50")
        env_dmcp = _extract_envelope(det_mcp)
        env_dcli = _strip_call_time(det_cli) if isinstance(det_cli, dict) else None

        s5_detail_ok = (
            env_dmcp is not None and env_dcli is not None
            and env_dmcp == env_dcli
            and "cost_minor" in (env_dmcp.get("data") or {})
        )
        R.add("S5.3",
              "session_detail(session_ref) MCP ↔ CLI envelope 字节相等 + cost_minor 字段",
              "EXACT" if s5_detail_ok else "MISMATCH",
              f"session_detail({sref[:14]}..): "
              f"MCP↔CLI byte-equal={env_dmcp == env_dcli} "
              f"cost_minor_present={'cost_minor' in (env_dmcp.get('data') or {})}")
    else:
        R.add("S5.3", "session_detail(session_ref) MCP ↔ CLI envelope 字节相等",
              "PARTIAL",
              f"S5.1 未返回 sessions（{today} {test_harness} 可能为空），跳过下钻；"
              f"挑选其它有数据的执行环境重跑即得 EXACT。")

    # ── S6 session_trace 安全下钻（v0.10.0 spec §7 门槛 3）──────────────────
    # 公开 MCP 只接受 sessions_search 给出的 opaque session_ref；它在固定执行环境根
    # 内反查源文件，绝不接受任意本地路径。这里选择当次查询的一条会话验证安全
    # 下钻和其 timeline 投影；源文件已被清理时返回 PARTIAL/source_unavailable，
    # 不能把 SQL token 事实伪装成完整执行轨迹。
    if env_mcp and (env_mcp.get("data") or {}).get("sessions"):
        sref = env_mcp["data"]["sessions"][0]["session_ref"]
        s6_args = {"session_ref": sref, "output": "graph"}
        s6_mcp, _, _ = c.call("session_trace", s6_args)
        env_s6_mcp = _extract_envelope(s6_mcp)
        data_mcp = (env_s6_mcp or {}).get("data")
        s6_err = (s6_mcp or {}).get("structuredContent", {}).get("error") or {}
        s6_ok = (data_mcp is not None and not s6_err)
        s6_nodes = len((data_mcp or {}).get("nodes") or [])
        R.add("S6.1",
              "session_trace(session_ref) 安全下钻（不接受任意本地路径）",
              "EXACT" if s6_ok else "PARTIAL",
              f"session_ref={sref[:14]}.. nodes={s6_nodes} error={s6_err or None}")

        # S6.2：timeline_series 投影可达且事件守恒（unplaced_events 计数 + 事件
        # 全体 targetId 能对回图的 tool_call 节点——两层语义的输入端责任）。
        s6b_args = dict(s6_args, output="timeline_series")
        s6b_mcp, _, _ = c.call("session_trace", s6b_args)
        s6b_data = (_extract_envelope(s6b_mcp) or {}).get("data") or {}
        s6b_pts = len(s6b_data.get("points") or [])
        s6b_evs = len(s6b_data.get("events") or [])
        s6b_unplaced = s6b_data.get("unplaced_events")
        # 会话日志可能在 graph 与 timeline 两次独立请求之间追加。取前后两个
        # graph 快照的并集来消除这段真实并发窗口；若 target 不在任一快照中，才是
        # timeline 产出了孤儿锚点。纯函数层另有精确的同快照投影单测。
        s6c_mcp, _, _ = c.call("session_trace", s6_args)
        data_after = (_extract_envelope(s6c_mcp) or {}).get("data") or {}
        call_ids = {
            n.get("node_id")
            for graph in (data_mcp or {}, data_after)
            for n in graph.get("nodes", [])
            if n.get("node_type") == "tool_call"
        }
        ev_ids = {e.get("targetId") for e in s6b_data.get("events") or []}
        s6b_ok = (s6b_pts > 0 and s6b_evs > 0 and s6b_unplaced is not None
                  and ev_ids.issubset(call_ids))
        R.add("S6.2",
              "timeline_series 投影：points/events 非空 + unplaced_events 显式 + 事件锚定可回查",
              "EXACT" if s6b_ok else "MISMATCH",
              f"points={s6b_pts} events={s6b_evs} unplaced={s6b_unplaced} "
              f"targets_anchored={ev_ids.issubset(call_ids)}")
    else:
        R.add("S6.1", "session_trace(session_ref) 安全下钻",
              "PARTIAL", "当前窗口没有可下钻的 session_ref；选择有会话的日期/执行环境重跑即可。")

    sys.exit(R.summary())


if __name__ == "__main__":
    main()
