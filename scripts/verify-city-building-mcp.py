#!/usr/bin/env python3
"""Verify Agent City building MCP + UI bridge: persist → push envelope → apply path.

Primary gate is the Rust tests plus the no-WebGL entity-bridge script. Optional
--bin checks tools/list on a live data-mcp process.

    python3 scripts/verify-city-building-mcp.py
    python3 scripts/verify-city-building-mcp.py --bin target/debug/agent-vitals
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOOLS = ["get_building", "preview_building", "set_building_model", "reset_building", "im_publish"]
INIT = {
    "jsonrpc": "2.0", "id": 1, "method": "initialize",
    "params": {"protocolVersion": "2025-06-18", "capabilities": {},
               "clientInfo": {"name": "city-building-mcp-verify", "version": "0"}},
}
INITED = {"jsonrpc": "2.0", "method": "notifications/initialized"}


def run_cargo(args: list[str]) -> None:
    print("+ cargo", *args, flush=True)
    subprocess.check_call(["cargo", *args], cwd=ROOT)


def tools_list(bin_path: str) -> list[str]:
    payload = "\n".join(json.dumps(r) for r in [INIT, INITED, {
        "jsonrpc": "2.0", "id": 2, "method": "tools/list",
    }]) + "\n"
    proc = subprocess.run(
        [bin_path, "data-mcp", "serve"],
        input=payload, capture_output=True, text=True, timeout=45, cwd=ROOT,
    )
    frames = [json.loads(line) for line in proc.stdout.splitlines() if line.startswith("{")]
    listed = next(frame for frame in frames if frame.get("id") == 2)
    return [tool["name"] for tool in listed["result"]["tools"]]


def permission_denied_without_writes(bin_path: str) -> None:
    payload = "\n".join(json.dumps(r) for r in [INIT, INITED, {
        "jsonrpc": "2.0", "id": 9, "method": "tools/call",
        "params": {"name": "set_building_model", "arguments": {
            "session_id": "sr_00000000000000000000000000000000",
            "expected_revision": 0,
            "inheritance": {
                "kit_version": "session-kit/inheritance/v1",
                "base": {"kind": "projection"},
                "overrides": {},
            },
        }},
    }]) + "\n"
    proc = subprocess.run(
        [bin_path, "data-mcp", "serve"],
        input=payload, capture_output=True, text=True, timeout=45, cwd=ROOT,
    )
    frames = [json.loads(line) for line in proc.stdout.splitlines() if line.startswith("{")]
    result = next(frame for frame in frames if frame.get("id") == 9)["result"]
    err = (result.get("structuredContent") or {}).get("error") or {}
    if not result.get("isError") or err.get("code") != "permission_denied":
        raise SystemExit(f"set without --allow-local-writes should be permission_denied, got {result}")

    payload = "\n".join(json.dumps(r) for r in [INIT, INITED, {
        "jsonrpc": "2.0", "id": 10, "method": "tools/call",
        "params": {"name": "im_publish", "arguments": {
            "session_id": "sr_00000000000000000000000000000000",
            "agent_id": "nano", "agent_name": "Nano",
            "kind": "chat", "payload": {"text": "hi"},
        }},
    }]) + "\n"
    proc = subprocess.run(
        [bin_path, "data-mcp", "serve"],
        input=payload, capture_output=True, text=True, timeout=45, cwd=ROOT,
    )
    frames = [json.loads(line) for line in proc.stdout.splitlines() if line.startswith("{")]
    result = next(frame for frame in frames if frame.get("id") == 10)["result"]
    err = (result.get("structuredContent") or {}).get("error") or {}
    if not result.get("isError") or err.get("code") != "permission_denied":
        raise SystemExit(f"im_publish without --allow-local-writes should be permission_denied, got {result}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bin", help="optional agent-vitals binary for a live tools/list check")
    args = parser.parse_args()

    run_cargo(["test", "-p", "agent-vitals-query", "--lib", "query::city_building::", "--", "--test-threads=1"])
    run_cargo(["test", "-p", "agent-vitals-query", "--lib", "query::city_im::", "--", "--test-threads=1"])
    run_cargo(["test", "-p", "agent-vitals-query", "--test", "city_v3", "buildings_overrides", "--", "--test-threads=1"])
    run_cargo(["test", "-p", "agent-vitals-mcp", "--lib", "city_building::", "--", "--test-threads=1"])
    run_cargo(["test", "-p", "agent-vitals-mcp", "--lib", "city_im::", "--", "--test-threads=1"])
    print("Rust ReACT loop: get → preview fail → preview pass → set conflict → set → get → reset")
    print("+ node scripts/verify-city-entity-bridge.mjs", flush=True)
    subprocess.check_call(["node", str(ROOT / "scripts/verify-city-entity-bridge.mjs")], cwd=ROOT)
    print("Entity envelope + building apply path (no WebGL)")
    print("+ node scripts/verify-city-squad-im.mjs", flush=True)
    subprocess.check_call(["node", str(ROOT / "scripts/verify-city-squad-im.mjs")], cwd=ROOT)
    print("Squad IM envelope parse/filter/claim tint (no WebGL)")

    if args.bin:
        names = tools_list(args.bin)
        missing = [name for name in TOOLS if name not in names]
        if missing:
            raise SystemExit(f"tools/list missing {missing}; got {names}")
        permission_denied_without_writes(args.bin)
        print(f"Live MCP tools/list includes {TOOLS}; set/im_publish without writes is permission_denied")

    print("ok — contract: docs/CITY_BUILDING_MCP.md")
    return 0


if __name__ == "__main__":
    sys.exit(main())
