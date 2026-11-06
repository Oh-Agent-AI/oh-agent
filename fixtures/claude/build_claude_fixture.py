#!/usr/bin/env python3
"""Build the Claude Code fixtures: `healthy.jsonl`, `dangerous.jsonl`,
`all-recorded.jsonl`.

This reproduces the real on-disk Claude Code JSONL shape
(`~/.claude/projects/<workspace-slug>/<session-id>.jsonl`, one JSON object per
line, each an event record with `type`/`uuid`/`timestamp`/`cwd` and, for message
events, an Anthropic-Message-shaped `message` field: `id`/`model`/`content`/
`usage`). Pure-text user messages carry a *string* content; tool continuations
carry an array of `tool_use`/`tool_result` blocks; a separate `ai-title` record
carries the session title. All content is synthetic.

The three fixtures are the §10 acceptance gate on the evidence layer, one per
"leaf-path" (acceptance #6 — each fixture is a *leaf*: a deliberately narrow
session that exercises exactly one path of the mapping table, so a fixture edit
that stops exercising that path fails loudly instead of silently changing the
gate):

- `healthy.jsonl` — the healthy leaf: one rebuilt turn (pure-text user root),
  two tool calls (one Bash, one Write), two tool results (one `is_error:true` →
  lossy `failed`, one plain → measured `failed:None`), and one title. Write
  targets `/repo/x.rs` (inside the workspace root) so SV604/605/606 never fire.
- `dangerous.jsonl` — the finding leaf: one Bash call `rm -rf /tmp/x`. SV601
  must produce exactly one finding (evidence `"rm -rf"`, severity `critical`,
  call_id `"call1"`) — the same finding shape codex's paginated fixture
  produces for the same danger fragment (§10 acceptance #5: cross-harness same
  finding). SV602/603 must stay `measured_zero` (no sudo, no curl|sh).
- `all-recorded.jsonl` — the full-shape leaf: every record kind the adapter
  must not lose — two turns (two pure-text roots), Bash/Write/Task tool calls,
  a **sidechain** assistant record (`isSidechain: true` with its own Task
  block: Task arm is guarded, the record-level arm counts once → SubagentSpawns
  2, not 3 — P4-12 dedup), a record **without `type`** and one with an
  **unknown type** (→ `attempts`, never silently dropped — P4-13).

The acceptance numbers each fixture must produce are pinned in this script's
self-verification below — the same numbers
`tests/test_cli_matrix.py::test_claude_session_detail_differential` /
`..._dangerous_finding_differential` / `..._all_recorded_differential` assert
against the Rust binary, so the two sides of the differential share the same
source of truth.

Only the Python standard library is used, plus the repo's own
`agent_vitals.claude_evidence` / `claude_session_audit` for self-verification.

Run:  python3 fixtures/claude/build_claude_fixture.py

Output (in the same directory as this script):
    healthy.jsonl     — the healthy Claude session.
    dangerous.jsonl   — one SV601 finding (rm -rf).
    all-recorded.jsonl — every record kind (turns, Task, sidechain, bad types).

The script is deterministic (fixed timestamps / UUIDs) and self-verifying: after
writing it re-parses the files and runs the real evidence + audit projection,
asserting the exact coverage counts and the §10 三态契约 that the fixtures must
produce.
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.normpath(os.path.join(HERE, "..", "..", "scripts"))
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

from agent_vitals.agent import claude_evidence, claude_session_audit  # noqa: E402


def j(obj):
    """Serialize compactly, deterministic key order, no ASCII escaping."""
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def rec(typ, uuid, ts, **extra):
    r = {"type": typ, "uuid": uuid, "timestamp": ts, "cwd": "/repo"}
    r.update(extra)
    return r


def user_text(uuid, ts, text, model="claude-sonnet-4-5"):
    return rec("user", uuid, ts,
               message={"id": uuid, "model": model, "content": text})


def assistant_tool_use(uuid, ts, name, call_id, input_value):
    return rec("assistant", uuid, ts, message={
        "id": uuid, "model": "claude-sonnet-4-5",
        "content": [{"type": "tool_use", "id": call_id, "name": name,
                     "input": input_value}],
        "usage": {"input_tokens": 1, "output_tokens": 1}})


def user_tool_result(uuid, ts, call_id, is_error=None):
    block = {"type": "tool_result", "tool_use_id": call_id, "content": "done"}
    if is_error is not None:
        block["is_error"] = is_error
    return rec("user", uuid, ts, message={"id": uuid, "content": [block]})


def ai_title(uuid, ts, title):
    return rec("ai-title", uuid, ts, aiTitle=title)


def healthy_records():
    return [
        user_text("m1", "2026-08-20T14:27:00Z", "修复这个 bug"),
        assistant_tool_use("m2", "2026-08-20T14:27:05Z", "Bash", "call1",
                           {"command": "ls -la"}),
        user_tool_result("m3", "2026-08-20T14:27:08Z", "call1", is_error=True),
        assistant_tool_use("m4", "2026-08-20T14:27:12Z", "Write", "call2",
                           {"file_path": "/repo/x.rs",
                            "content": "fn main() {}"}),
        user_tool_result("m5", "2026-08-20T14:27:15Z", "call2", is_error=None),
        ai_title("t1", "2026-08-20T14:30:00Z", "我的会话"),
    ]


def write_healthy():
    path = os.path.join(HERE, "healthy.jsonl")
    with open(path, "w", encoding="utf-8") as fh:
        for r in healthy_records():
            fh.write(j(r) + "\n")
    return path


def dangerous_records():
    """finding leaf：一条 Bash `rm -rf /tmp/x`。只喂 SV601 一种危险模式——
    privilege/remote-exec 的正则都不碰它，所以 SV602/603 必须 stays
    `measured_zero`（不是被门控吞掉的 unavailable——ToolCalls 非空，规则照跑
    零命中）。`is_error:false` → `failed:Some(false)`，不触发 SV613(b) 的
    连续失败判据。"""
    return [
        user_text("m1", "2026-08-20T14:27:00Z", "清理临时目录"),
        assistant_tool_use("m2", "2026-08-20T14:27:05Z", "Bash", "call1",
                           {"command": "rm -rf /tmp/x"}),
        user_tool_result("m3", "2026-08-20T14:27:08Z", "call1", is_error=False),
        ai_title("t1", "2026-08-20T14:30:00Z", "危险命令会话"),
    ]


def write_dangerous():
    path = os.path.join(HERE, "dangerous.jsonl")
    with open(path, "w", encoding="utf-8") as fh:
        for r in dangerous_records():
            fh.write(j(r) + "\n")
    return path


def all_recorded_records():
    """full-shape leaf：适配器不该丢的每种记录都来一条——两个纯文本 turn 根
    （turn 2 个）、Bash/Write/Task 三种 tool_use（ToolCalls 4：sidechain 的
    Task 块也照常记录）、三条 tool_result（ToolResults 3）、一条 `isSidechain:
    true` 的 assistant（P4-12 锚点：Task 臂被守卫挡住，记录级臂只计一次 →
    SubagentSpawns 2 而不是 3）、一条缺 `type` 的记录 + 一条 `bogus-type`
    （→ attempts，绝不静默吞，P4-13）。Write 落在 `/repo/a.rs`（根内），
    SV604/605/606 不误报。"""
    return [
        user_text("m1", "2026-08-20T15:00:00Z", "第一个请求"),
        assistant_tool_use("m2", "2026-08-20T15:00:05Z", "Bash", "call1",
                           {"command": "ls -la"}),
        user_tool_result("m3", "2026-08-20T15:00:08Z", "call1", is_error=True),
        assistant_tool_use("m4", "2026-08-20T15:00:12Z", "Write", "call2",
                           {"file_path": "/repo/a.rs", "content": "fn a() {}"}),
        user_tool_result("m5", "2026-08-20T15:00:15Z", "call2", is_error=None),
        user_text("m6", "2026-08-20T15:01:00Z", "第二个请求"),
        assistant_tool_use("m7", "2026-08-20T15:01:05Z", "Task", "call3",
                           {"description": "子代理任务"}),
        user_tool_result("m8", "2026-08-20T15:01:10Z", "call3", is_error=None),
        # sidechain：isSidechain 真本身就是子代理分支的证据——记录级臂计一次，
        # 里面的 Task 块被守卫挡住（评审 P4-12）。
        rec("assistant", "m9", "2026-08-20T15:02:00Z", isSidechain=True,
            message={"id": "m9", "model": "claude-sonnet-4-5",
                     "content": [{"type": "tool_use", "id": "call9",
                                  "name": "Task",
                                  "input": {"description": "侧链分支"}}],
                     "usage": {"input_tokens": 1, "output_tokens": 1}}),
        # 缺 type：没有归类的锚点 → "missing record type" attempt（评审 P4-13）。
        {"uuid": "z1", "timestamp": "2026-08-20T15:03:00Z", "cwd": "/repo"},
        rec("bogus-type", "z2", "2026-08-20T15:03:01Z"),
        ai_title("t1", "2026-08-20T15:04:00Z", "全覆盖会话"),
    ]


def write_all_recorded():
    path = os.path.join(HERE, "all-recorded.jsonl")
    with open(path, "w", encoding="utf-8") as fh:
        for r in all_recorded_records():
            fh.write(j(r) + "\n")
    return path


def self_verify(path):
    """Fixture 必须钉死 §10 验收 #4 的数字——改了映射表/记录就响亮失败。"""
    with open(path, encoding="utf-8") as fh:
        records = [json.loads(line) for line in fh]
    assert len(records) == 6, "健康夹具应是 6 条记录，实际 %d" % len(records)

    evidence = claude_evidence.build_claude_evidence(records, "c0ffee")
    ev = claude_evidence.claude_evidence_json(evidence)
    audit = claude_session_audit.claude_audit_projection(evidence["canonical"])

    cov = ev["coverage"]
    assert cov["ToolCalls"]["measured"] == 2, cov["ToolCalls"]
    assert cov["ToolResults"]["measured"] == 2, cov["ToolResults"]
    assert cov["TurnBoundaries"]["derived"] == 1, cov["TurnBoundaries"]
    assert cov["ApprovalDecisions"]["available"] is False

    rules = audit["rule_outcomes"]
    for code in ("SV607", "SV608", "SV609", "SV610", "SV614"):
        assert rules[code]["status"] == "unavailable", (code, rules[code])
    for code in ("SV601", "SV602", "SV603", "SV604", "SV605", "SV606",
                 "SV611", "SV612", "SV613"):
        assert rules[code]["status"] == "measured_zero", (code, rules[code])
    assert audit["summary"]["rules_unavailable"] == 5
    assert audit["summary"]["findings_total"] == 0


def self_verify_dangerous(path):
    """finding leaf 必须钉死的数字：SV601 恰好 1 条 finding，evidence 是剥壳后的
    危险片段 `rm -rf`（不是整条命令）、severity critical、call_id 透传 tool_use
    块的 id；SV602/603 照跑零命中（measured_zero，不是 unavailable——ToolCalls
    非空，门控放行了）；rules_unavailable 5（SV607/608/609/610/614）。"""
    with open(path, encoding="utf-8") as fh:
        records = [json.loads(line) for line in fh]
    assert len(records) == 4, "dangerous 夹具应是 4 条记录，实际 %d" % len(records)

    evidence = claude_evidence.build_claude_evidence(records, "c0ffee")
    ev = claude_evidence.claude_evidence_json(evidence)
    audit = claude_session_audit.claude_audit_projection(evidence["canonical"])

    cov = ev["coverage"]
    assert cov["ToolCalls"]["measured"] == 1, cov["ToolCalls"]
    assert cov["ToolResults"]["measured"] == 1, cov["ToolResults"]
    assert cov["TurnBoundaries"]["derived"] == 1, cov["TurnBoundaries"]

    assert audit["summary"] == {"critical": 1, "warning": 0, "info": 0,
                                "findings_total": 1, "rules_unavailable": 5}, \
        audit["summary"]
    findings = audit["findings"]
    assert len(findings) == 1, findings
    f = findings[0]
    assert f["rule"] == "SV601"
    assert f["severity"] == "critical"
    assert f["evidence"] == "rm -rf", f["evidence"]
    assert f["call_id"] == "call1", f["call_id"]
    assert f["tool_name"] == "bash"
    assert f["turn"] == 0, "首个 turn 根 → turn 0（合成序数是 0 基的）"
    rules = audit["rule_outcomes"]
    for code in ("SV602", "SV603", "SV604", "SV605", "SV606",
                 "SV611", "SV612", "SV613"):
        assert rules[code]["status"] == "measured_zero", (code, rules[code])
    for code in ("SV607", "SV608", "SV609", "SV610", "SV614"):
        assert rules[code]["status"] == "unavailable", (code, rules[code])


def self_verify_all_recorded(path):
    """full-shape leaf 必须钉死的数字：每个信号的原样计数（coverage 与 timeline
    同源）、SubagentSpawns 的去重（2 不是 3——P4-12）、attempts 两条（P4-13：
    缺 type + 未知 type，按字典序）、rules_unavailable 5、零 findings。"""
    with open(path, encoding="utf-8") as fh:
        records = [json.loads(line) for line in fh]
    assert len(records) == 12, "all-recorded 夹具应是 12 条记录，实际 %d" % len(records)

    evidence = claude_evidence.build_claude_evidence(records, "c0ffee")
    ev = claude_evidence.claude_evidence_json(evidence)
    audit = claude_session_audit.claude_audit_projection(evidence["canonical"])

    cov = ev["coverage"]
    assert cov["ToolCalls"]["measured"] == 4, cov["ToolCalls"]
    assert cov["ToolResults"]["measured"] == 3, cov["ToolResults"]
    assert cov["TurnBoundaries"]["derived"] == 2, cov["TurnBoundaries"]
    assert cov["UserPrompts"]["measured"] == 2, cov["UserPrompts"]
    assert cov["SubagentSpawns"]["measured"] == 2, cov["SubagentSpawns"]
    assert cov["StepBoundaries"]["derived"] == 4, cov["StepBoundaries"]
    assert cov["Usage"]["measured"] == 4, cov["Usage"]
    assert cov["UsageAggregate"]["derived"] == 1, cov["UsageAggregate"]
    assert cov["FileMutations"]["derived"] == 1, cov["FileMutations"]

    assert audit["summary"] == {"critical": 0, "warning": 0, "info": 0,
                                "findings_total": 0, "rules_unavailable": 5}, \
        audit["summary"]
    rules = audit["rule_outcomes"]
    for code in ("SV601", "SV602", "SV603", "SV604", "SV605", "SV606",
                 "SV611", "SV612", "SV613"):
        assert rules[code]["status"] == "measured_zero", (code, rules[code])
    for code in ("SV607", "SV608", "SV609", "SV610", "SV614"):
        assert rules[code]["status"] == "unavailable", (code, rules[code])
    assert ev["attempts"] == [
        {"source_id": "claude.session.jsonl", "kind": "LogFile",
         "surface": "SessionLog", "available": False,
         "error": "missing record type", "observed_span": None},
        {"source_id": "claude.session.jsonl", "kind": "LogFile",
         "surface": "SessionLog", "available": False,
         "error": "unknown record type: bogus-type", "observed_span": None},
    ], ev["attempts"]
    # sidechain 的 Task 块照常记录进 tool_calls timeline（turn=None）。timeline
    # 在 canonical 上（`claude_evidence_json` 不序列化 timeline）。
    tl = evidence["canonical"]["tool_calls"]["entries"]
    names = [e["observation"]["name"] for e in tl]
    assert names == ["bash", "write", "task", "task"], names
    assert [e.get("turn") for e in tl] == [0, 0, 1, None], tl


def main():
    path = write_healthy()
    self_verify(path)
    print("wrote %s (%d records)" % (path, len(healthy_records())))
    path = write_dangerous()
    self_verify_dangerous(path)
    print("wrote %s (%d records)" % (path, len(dangerous_records())))
    path = write_all_recorded()
    self_verify_all_recorded(path)
    print("wrote %s (%d records)" % (path, len(all_recorded_records())))
    print("self-verification passed")


if __name__ == "__main__":
    main()
