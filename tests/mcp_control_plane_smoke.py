#!/usr/bin/env python3
"""隔离验证 Data MCP 的类型化控制面读写边界。

脚本只使用临时 AGENT_VITALS_HOME；写入需要显式 ``--allow-local-writes``，
导入数据删除还需要二次确认串。不会调用 sync_facts，避免烟测读取真实执行环境日志。
"""

import argparse
import json
import os
import pathlib
import shutil
import subprocess
import tempfile


def request(method, request_id, params=None):
    message = {"jsonrpc": "2.0", "id": request_id, "method": method}
    if params is not None:
        message["params"] = params
    return message


def run_server(binary, home, calls, allow_writes=False):
    messages = [request("initialize", 1, {
        "protocolVersion": "2025-06-18", "capabilities": {},
        "clientInfo": {"name": "mcp-control-plane-smoke", "version": "1"},
    }), {"jsonrpc": "2.0", "method": "notifications/initialized"}]
    for request_id, name, arguments in calls:
        messages.append(request("tools/call", request_id, {
            "name": name, "arguments": arguments,
        }))
    command = [binary, "data-mcp", "serve"]
    if allow_writes:
        command.append("--allow-local-writes")
    env = dict(os.environ, AGENT_VITALS_HOME=home)
    result = subprocess.run(
        command, input="\n".join(json.dumps(item) for item in messages) + "\n",
        env=env, capture_output=True, text=True, check=False,
    )
    if result.returncode != 0:
        raise SystemExit(f"MCP exited {result.returncode}: {result.stderr}")
    return {item["id"]: item["result"] for item in (
        json.loads(line) for line in result.stdout.splitlines() if line.strip()
    ) if "id" in item and "result" in item}


def data(results, request_id):
    result = results[request_id]
    if result.get("isError"):
        return None, (result.get("structuredContent") or {}).get("error")
    return result["structuredContent"]["data"], None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--bin", required=True)
    args = parser.parse_args()
    home = tempfile.mkdtemp(prefix="agent-vitals-mcp-control-")
    custom_root = pathlib.Path(home) / "custom-source"
    custom_root.mkdir()
    env = dict(os.environ, AGENT_VITALS_HOME=home)
    seed = subprocess.run(
        [args.bin, "data-status", "--json"], env=env,
        capture_output=True, text=True, check=False,
    )
    if seed.returncode not in (0, 1):
        raise SystemExit(f"seed failed: {seed.returncode}: {seed.stderr}")

    denied = run_server(args.bin, home, [
        (2, "control_plane", {"action": "sync_pause_set", "paused": True}),
        (3, "control_plane", {"action": "pricing_catalog_policy_set", "network_enabled": True}),
    ])
    _, error = data(denied, 2)
    assert error and error["code"] == "permission_denied", error
    _, error = data(denied, 3)
    assert error and error["code"] == "permission_denied", error

    calls = [
        (10, "control_plane", {"action": "custom_sources"}),
        (11, "control_plane", {"action": "custom_source_add", "harness": "codex",
                                "root": str(custom_root)}),
        (12, "control_plane", {"action": "custom_sources"}),
        (13, "control_plane", {"action": "source_exclusion_set", "harness": "codex",
                                "excluded": True}),
        (14, "control_plane", {"action": "source_status"}),
        (15, "control_plane", {"action": "retention_set", "months": 24}),
        (16, "control_plane", {"action": "retention_get"}),
        (17, "control_plane", {"action": "statistics_timezone_set",
                                "timezone": "Asia/Shanghai"}),
        (18, "control_plane", {"action": "statistics_timezone_get"}),
        (19, "control_plane", {"action": "sync_pause_set", "paused": True}),
        (20, "control_plane", {"action": "sync_state"}),
        (26, "control_plane", {"action": "pricing_catalog_status"}),
        (27, "control_plane", {"action": "pricing_catalog_policy_set", "network_enabled": True}),
        (28, "control_plane", {"action": "pricing_catalog_status"}),
        (25, "control_plane", {"action": "sync_facts"}),
        (21, "control_plane", {"action": "source_data_delete", "harness": "codex"}),
        (22, "control_plane", {"action": "source_data_delete", "harness": "codex",
                                "confirmation": "DELETE_IMPORTED_SOURCE_DATA"}),
        (23, "control_plane", {"action": "source_exclusion_set", "harness": "codex",
                                "excluded": False}),
        (24, "control_plane", {"action": "custom_source_remove", "harness": "codex",
                                "root": str(custom_root)}),
    ]
    results = run_server(args.bin, home, calls, allow_writes=True)
    for request_id, _, _ in calls:
        if request_id == 21:
            _, error = data(results, request_id)
            assert error and error["code"] == "confirmation_required", error
        else:
            value, error = data(results, request_id)
            assert error is None, (request_id, error)

    initial, _ = data(results, 10)
    listed, _ = data(results, 12)
    assert initial["sources"]["configured_count"] == 0
    assert listed["sources"]["configured_count"] == 1 and listed["sources"]["harnesses"] == ["codex"]
    status, _ = data(results, 14)
    codex = next(item for item in status["source_status"]["sources"] if item["harness"] == "codex")
    assert codex["connection_state"] == "excluded"
    retention, _ = data(results, 16)
    assert retention["months"] == 24
    timezone, _ = data(results, 18)
    assert timezone["timezone"] == "Asia/Shanghai"
    sync, _ = data(results, 20)
    assert sync["sync"]["paused"] is True
    sync_call, _ = data(results, 25)
    assert sync_call["status"] == "paused" and sync_call["report"] is None
    pricing_before, _ = data(results, 26)
    assert pricing_before["pricing"]["state"] == "never_checked"
    assert pricing_before["pricing"]["network_enabled"] is False
    pricing_after, _ = data(results, 28)
    assert pricing_after["pricing"]["network_enabled"] is True
    assert pricing_after["pricing"]["source_url"].startswith("https://")
    deleted, _ = data(results, 22)
    assert deleted["deleted"] == {"facts": 0, "sessions": 0, "source_files": 0}
    assert custom_root.exists()  # removing a configured source must not delete the user's directory
    shutil.rmtree(home, ignore_errors=True)
    print(f"MCP control-plane smoke: PASS ({len(calls)} typed operations, isolated home={home})")


if __name__ == "__main__":
    main()
