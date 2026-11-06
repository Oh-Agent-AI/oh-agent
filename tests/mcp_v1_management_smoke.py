#!/usr/bin/env python3
"""隔离 Authority DB 上的 v1.0 Data MCP 管理闭环冒烟。

默认 MCP 仍只读；本脚本显式启动 ``--allow-local-writes``，并且只在临时
AGENT_VITALS_HOME 中调用 billing_workflow 的类型化动作。它不允许任意 SQL、
执行环境原始日志或真实用户库参与测试。
"""

import argparse
import json
import os
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bin", required=True)
    args = parser.parse_args()
    home = tempfile.mkdtemp(prefix="agent-vitals-mcp-v1-")
    env = dict(os.environ, AGENT_VITALS_HOME=home)
    seed = subprocess.run(
        [args.bin, "data-status", "--json"], env=env,
        capture_output=True, text=True, check=False,
    )
    if seed.returncode not in (0, 1):
        raise SystemExit(f"seed failed: {seed.returncode}: {seed.stderr}")

    init = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-06-18", "capabilities": {},
        "clientInfo": {"name": "mcp-v1-management-smoke", "version": "1"},
    }}
    requests = [init, {"jsonrpc": "2.0", "method": "notifications/initialized"}]
    calls = [
        (10, {"action": "candidate_put", "candidate_id": "candidate-uat", "harness": "codex",
              "provider_id": "openai", "currency": "USD", "amount_minor": 2000,
              "billing_period_start": "2026-09", "source_pricing_version": "uat-v1"}),
        (11, {"action": "candidate_list"}),
        (12, {"action": "candidate_resolve", "candidate_id": "candidate-uat", "status": "accepted"}),
        (13, {"action": "declaration_save", "revision_id": "revision-uat-1",
              "declaration_id": "declaration-uat", "harness": "codex", "provider_id": "openai",
              "relationship_kind": "official_subscription", "subscription_name": "UAT Plan",
              "amount_minor": 2000, "currency": "USD", "effective_start": "2026-09",
              "source_candidate_id": "candidate-uat", "evidence_ref": "uat", "scopes": []}),
        (14, {"action": "declaration_preview", "harness": "codex", "provider_id": "openai",
              "effective_start": "2026-09", "scopes": []}),
        # 计费主链规格 §7.3：有界（effective_end）预览的命中数 ≤ 开放预览；
        # 预览带 conflict_* 字段（E207 的「仍待确认」桶）。
        (30, {"action": "declaration_preview", "harness": "codex", "provider_id": "openai",
              "effective_start": "2026-09", "effective_end": "2026-09", "scopes": []}),
        (15, {"action": "declaration_revisions", "declaration_id": "declaration-uat"}),
        (16, {"action": "recalc_enqueue", "job_id": "job-uat", "declaration_id": "declaration-uat",
              "revision_id": "revision-uat-1"}),
        (17, {"action": "recalc_status", "job_id": "job-uat"}),
        (18, {"action": "recalc_run", "job_id": "job-uat"}),
        (19, {"action": "recalc_status", "job_id": "job-uat"}),
        (20, {"action": "declaration_revoke", "revision_id": "revision-uat-2",
              "declaration_id": "declaration-uat", "supersedes_revision_id": "revision-uat-1"}),
        (21, {"action": "declaration_revisions", "declaration_id": "declaration-uat"}),
        (31, {"action": "candidate_list"}),
        (22, {"action": "candidate_reopen", "candidate_id": "candidate-uat"}),
        (23, {"action": "harness_bill_put", "bill_id": "bill-uat", "harness": "codex",
              "provider_id": "openai", "billing_period_start": "2026-09", "basis": "harness_billed",
              "amount_minor": 1234, "currency": "USD", "evidence_ref": "uat"}),
        (24, {"action": "harness_bill_list", "billing_period_start": "2026-09"}),
        (25, {"action": "harness_bill_delete", "bill_id": "bill-uat"}),
        (26, {"action": "budget_profile_set", "profile_id": "confirmed", "currency": "USD",
              "monthly_minor": 5000, "daily_minor": 1000, "warning_ratio_bp": 8000}),
        (27, {"action": "budget_snooze_set", "until_ms": 4102444800000}),
        (28, {"action": "budget_get"}),
        (29, {"action": "budget_snooze_clear"}),
    ]
    for request_id, payload in calls:
        requests.append({"jsonrpc": "2.0", "id": request_id, "method": "tools/call",
                         "params": {"name": "billing_workflow", "arguments": payload}})
    proc = subprocess.run(
        [args.bin, "data-mcp", "serve", "--allow-local-writes"],
        input="\n".join(json.dumps(request) for request in requests) + "\n",
        env=env, capture_output=True, text=True, check=False,
    )
    frames = [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]
    if proc.returncode != 0:
        raise SystemExit(f"MCP exited {proc.returncode}: {proc.stderr}")
    if any("error" in frame for frame in frames):
        raise SystemExit(f"protocol error: {frames}")
    results = {frame["id"]: frame["result"] for frame in frames if frame.get("id") in {n for n, _ in calls}}
    if len(results) != len(calls) or any(result.get("isError") for result in results.values()):
        raise SystemExit(f"business error: {results}")
    data = {key: value["structuredContent"]["data"] for key, value in results.items()}
    assert data[11]["candidates"][0]["status"] == "pending"
    assert data[17]["job"]["status"] == "queued"
    assert data[19]["job"]["status"] == "succeeded"
    assert data[30]["preview"]["fact_count"] <= data[14]["preview"]["fact_count"]
    assert "conflict_fact_count" in data[30]["preview"] and "conflict_tokens" in data[30]["preview"]
    assert data[31]["candidates"][0]["status"] == "accepted", "revoke never reopens the source candidate (候选≠归因)"
    assert len(data[21]["revisions"]) == 2 and data[21]["revisions"][1]["change_kind"] == "revoked"
    assert data[24]["bills"][0]["amount_minor"] == 1234
    assert data[28]["snooze_until_ms"] == 4102444800000
    print(f"MCP v1 management smoke: PASS ({len(calls)} typed actions, isolated home={home})")


if __name__ == "__main__":
    main()
