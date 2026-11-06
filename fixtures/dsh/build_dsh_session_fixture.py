#!/usr/bin/env python3
"""Build hand-written DSH session-log fixtures for the dsh adapter.

These fixtures reproduce the on-disk format written by DSH's DEFAULT session
persistence backend `@deepseek-ai/dsh-session-persistence-jsonl` (plaintext
`.jsonl`, `compression: 'none'`), so that CI can exercise the dsh adapter's
"trigger evidence" read without ever running DSH. The SQLite backend is an
*alternative* store, not the default, and is intentionally not reproduced here.

Only the Python standard library is used (`json`); there is no dependency on
DSH, its packages, or Node.

Run:  python3 fixtures/dsh/build_dsh_session_fixture.py

Output (in the same directory as this script):
    complete.jsonl   - one session, complete discovery, catalog published,
                       model-selected load + user-explicit invocation.
    incomplete.jsonl - one session whose third turn had incomplete discovery
                       (`complete === false`) and therefore published NO catalog.

The script is deterministic (fixed UUIDs / timestamps) and self-verifying: after
writing each file it re-opens it and asserts the evidence the adapter is
supposed to read. See README.md in this directory for the field-by-field
correspondence to the real DSH JSONL schema.
"""

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))

# --- Versions / discriminator copied from DSH source (do not invent these) ---

# packages/core/session/src/types.ts
#   "While the harness is unreleased it is pinned at 0: no compatibility is
#    implied, incompatible logs are rejected, and no migration is provided."
# Stamped into every `SessionHeader.version` (the header line's `version` field).
# A reader meeting any other value MUST refuse the log.
SESSION_FORMAT_VERSION = 0

# packages/session/session-persistence-jsonl/src/format.ts — `HeaderLine`
#   The first JSONL record is the immutable SessionHeader tagged with
#   `type: 'session'` so a reader can tell it apart from an event line.
HEADER_RECORD_TYPE = "session"


def j(obj):
    """Serialize exactly like JS `JSON.stringify` (compact separators)."""
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


# ---------------------------------------------------------------------------
# Event builders
# ---------------------------------------------------------------------------
# Each event line mirrors `SessionEvent` (packChunks off, one event per line):
#   { type, seq, time, data, sourceEventSeqs?, surfaceOp? }
# `data` is the inline `SessionEventMap[type]` object (NOT a JSON string — that
# is the SQLite backend's lossless-text convention). `time` (Unix epoch ms)
# lives inside the event object; `seq` is the 0-based contiguous session index.
#
# Surface events (`user/message`, `assistant/message`, `tool/result`) MUST carry
# a `surfaceOp` ('append' or a replace object); every other type omits it.


def user_message(msg_id, text, source):
    """A `user/message` event's `data` (a `UserMessage`)."""
    return {
        "id": msg_id,
        "role": "user",
        "content": [{"type": "text", "text": text}],
        "source": source,
    }


def catalog_source(entries, update=False):
    """A `skill-catalog` message source (packages/skill/tool-skill/src/index.ts)."""
    src = {"kind": "skill-catalog", "form": "catalog", "entries": entries}
    if update:
        src["update"] = True
    return src


def invocation_source(name):
    """A `skill-invocation` message source (packages/skill/skill/src/index.ts)."""
    return {"kind": "skill-invocation", "name": name, "form": "instructions"}


# ---------------------------------------------------------------------------
# Fixture data
# ---------------------------------------------------------------------------

CATALOG_ENTRIES_COMPLETE = [
    {
        "name": "repo-auditor",
        "description": "Audit a repository for security, licensing, and supply-chain hygiene; reports findings ordered by severity.",
    },
    {
        "name": "release-notes",
        # Trailing "..." is the visible mark of catalogDescription()'s
        # truncation at catalogDescriptionMaxLength (default 500): the stored
        # description is the *published* (already normalized + truncated) text.
        "description": "Generate release notes from merged pull requests and conventional commits since the last tag, grouping breaking changes, features, and fixes…",
    },
    {
        "name": "commit-summarizer",
        "description": "Summarize a range of git commits into concise bullet points for changelogs and PR reviews.",
    },
    {
        "name": "test-runner",
        "description": "Run the project's test suite and group failures by module with the first failing assertion.",
    },
]

CATALOG_ENTRIES_INCOMPLETE = CATALOG_ENTRIES_COMPLETE[:2]

# Skill the model SELECTED via the `skill` tool (tool/call name="skill").
MODEL_SELECTED_SKILL = "commit-summarizer"
# Skill the USER explicitly invoked via a `/name` gesture (skill-invocation).
USER_INVOKED_SKILL = "release-notes"


def build_complete():
    """One session: complete discovery, catalog published, both trigger kinds.

    Returns `(meta, events)` where `meta` holds the JSONL header fields and
    `events` are `(type, data, surface_op)` triples; the writer assigns `seq`
    (0-based, contiguous) and `time` (ms, monotonic).
    """
    meta = {
        "id": "sess-complete-0001",
        "createdAt": 1750000000000,
        "cwd": "/Users/alice/projects/demo",
        "agentPreset": "main",
        # delegationDepth defaults to 0 in the header line (top-level session).
    }
    events = [
        # turn 1 — plain prompt, no catalog yet (pre-step publishes on turn 2)
        ("turn/start", {"turn": 1}, None),
        ("step/start", {"turn": 1, "step": 1}, None),
        ("user/message", user_message(
            "aaaaaaaa-0000-4000-8000-000000000001",
            "Please analyze my repository.",
            {"kind": "user"},
        ), "append"),
        ("step/end", {"turn": 1, "step": 1}, None),
        ("turn/end", {"turn": 1, "reason": {"kind": "completed"}}, None),

        # turn 2 — discovery complete -> FIRST catalog publication
        ("turn/start", {"turn": 2}, None),
        ("step/start", {"turn": 2, "step": 1}, None),
        ("user/message", user_message(
            "aaaaaaaa-0000-4000-8000-000000000002",
            "<system-reminder>\nA skill is a reusable set of task-specific instructions. The following skills are available in this session:\n\n<available_skills>\n- `repo-auditor`: Audit a repository for security, licensing, and supply-chain hygiene; reports findings ordered by severity.\n- `release-notes`: Generate release notes from merged pull requests and conventional commits since the last tag, grouping breaking changes, features, and fixes…\n- `commit-summarizer`: Summarize a range of git commits into concise bullet points for changelogs and PR reviews.\n- `test-runner`: Run the project's test suite and group failures by module with the first failing assertion.\n</available_skills>\n\nIf the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions.\n</system-reminder>",
            catalog_source(CATALOG_ENTRIES_COMPLETE),
        ), "append"),
        ("step/end", {"turn": 2, "step": 1}, None),
        ("turn/end", {"turn": 2, "reason": {"kind": "completed"}}, None),

        # turn 3 — USER-EXPLICIT invocation (`/release-notes` gesture) injects
        # a `skill-invocation` message (this path does NOT check snapshot.complete).
        ("turn/start", {"turn": 3}, None),
        ("step/start", {"turn": 3, "step": 1}, None),
        ("user/message", user_message(
            "aaaaaaaa-0000-4000-8000-000000000003",
            "/release-notes for the v2.0 tag",
            {"kind": "user"},
        ), "append"),
        ("user/message", user_message(
            "aaaaaaaa-0000-4000-8000-000000000004",
            "<skill_content name=\"release-notes\">\n<skill_resources>\nBase directory for this skill: /Users/alice/.dsh/skills/release-notes\n</skill_resources>\n\n<skill_instructions>\nGenerate release notes from merged PRs.\n</skill_instructions>\n</skill_content>",
            invocation_source(USER_INVOKED_SKILL),
        ), "append"),
        ("assistant/message", {
            "turn": 3, "step": 1,
            "message": {
                "id": "bbbbbbbb-0000-4000-8000-000000000001",
                "role": "assistant",
                "content": [{"type": "text", "text": "Here are the release notes for v2.0."}],
                "source": {"kind": "model", "provider": "deepseek", "model": "deepseek-chat"},
            },
        }, "append"),
        ("step/end", {"turn": 3, "step": 1}, None),
        ("turn/end", {"turn": 3, "reason": {"kind": "completed"}}, None),

        # turn 4 — MODEL-SELECTED load: the `skill` tool is called by the model.
        # Recorded as a `tool/call` (name="skill") + its `tool/result`, NOT as a
        # `skill-invocation` message. This is the other half of trigger evidence.
        ("turn/start", {"turn": 4}, None),
        ("step/start", {"turn": 4, "step": 1}, None),
        ("tool/call", {
            "turn": 4, "step": 1,
            "callId": "cccccccc-0000-4000-8000-000000000001",
            "name": "skill",
            "arguments": j({"name": MODEL_SELECTED_SKILL}),
        }, None),
        ("tool/result", {
            "turn": 4, "step": 1,
            "message": {
                "id": "cccccccc-0000-4000-8000-000000000002",
                "role": "user",
                "content": [{
                    "type": "tool-result",
                    "toolCallId": "cccccccc-0000-4000-8000-000000000001",
                    "content": [{
                        "type": "text",
                        "text": "<skill_content name=\"commit-summarizer\">\n<skill_resources>\nBase directory for this skill: /Users/alice/.dsh/skills/commit-summarizer\n</skill_resources>\n\n<skill_instructions>\nSummarize git commits.\n</skill_instructions>\n</skill_content>",
                    }],
                    "isError": False,
                }],
                "source": {"kind": "tool", "callId": "cccccccc-0000-4000-8000-000000000001"},
            },
        }, "append"),
        ("assistant/message", {
            "turn": 4, "step": 1,
            "message": {
                "id": "bbbbbbbb-0000-4000-8000-000000000002",
                "role": "assistant",
                "content": [{"type": "text", "text": "Summarized the last 10 commits."}],
                "source": {"kind": "model", "provider": "deepseek", "model": "deepseek-chat"},
            },
        }, "append"),
        ("step/end", {"turn": 4, "step": 1}, None),
        ("turn/end", {"turn": 4, "reason": {"kind": "completed"}}, None),
    ]
    return meta, events


def build_incomplete():
    """One session: turn 2 publishes a catalog, turn 3 discovery is incomplete.

    `complete === false` has NO persisted field: DSH's tool-skill listener does
    `if (!snapshot.complete) return decision` and appends no `skill-catalog`
    message. The absence of that message for turn 3 is the entire signal.
    """
    meta = {
        "id": "sess-incomplete-0002",
        "createdAt": 1750001000000,
        "cwd": "/Users/alice/projects/demo",
        "agentPreset": "main",
    }
    events = [
        ("turn/start", {"turn": 1}, None),
        ("step/start", {"turn": 1, "step": 1}, None),
        ("user/message", user_message(
            "dddddddd-0000-4000-8000-000000000001",
            "Hello.",
            {"kind": "user"},
        ), "append"),
        ("step/end", {"turn": 1, "step": 1}, None),
        ("turn/end", {"turn": 1, "reason": {"kind": "completed"}}, None),

        # turn 2 — discovery complete -> catalog published (2 skills).
        ("turn/start", {"turn": 2}, None),
        ("step/start", {"turn": 2, "step": 1}, None),
        ("user/message", user_message(
            "dddddddd-0000-4000-8000-000000000002",
            "<system-reminder>\nA skill is a reusable set of task-specific instructions. The following skills are available in this session:\n\n<available_skills>\n- `repo-auditor`: Audit a repository for security, licensing, and supply-chain hygiene; reports findings ordered by severity.\n- `release-notes`: Generate release notes from merged pull requests and conventional commits since the last tag, grouping breaking changes, features, and fixes…\n</available_skills>\n\nIf the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions.\n</system-reminder>",
            catalog_source(CATALOG_ENTRIES_INCOMPLETE),
        ), "append"),
        ("step/end", {"turn": 2, "step": 1}, None),
        ("turn/end", {"turn": 2, "reason": {"kind": "completed"}}, None),

        # turn 3 — discovery INCOMPLETE (e.g. a provider stalled during the hot
        # reload window). The prompt is claimed, but NO `skill-catalog` message
        # is appended: the model silently keeps turn 2's catalog. A skill added
        # during this window appears in NO catalog record.
        ("turn/start", {"turn": 3}, None),
        ("step/start", {"turn": 3, "step": 1}, None),
        ("user/message", user_message(
            "dddddddd-0000-4000-8000-000000000003",
            "Summarize the recent commits for me.",
            {"kind": "user"},
        ), "append"),
        ("step/end", {"turn": 3, "step": 1}, None),
        ("turn/end", {"turn": 3, "reason": {"kind": "completed"}}, None),
    ]
    return meta, events


# ---------------------------------------------------------------------------
# Writing
# ---------------------------------------------------------------------------

SURFACE_TYPES = {"user/message", "assistant/message", "tool/result"}


def header_line(meta):
    """Build the `type: 'session'` header record (format.ts `toHeaderLine`)."""
    line = {
        "type": HEADER_RECORD_TYPE,
        "version": SESSION_FORMAT_VERSION,
        "id": meta["id"],
        "createdAt": meta["createdAt"],
    }
    if "cwd" in meta:
        line["cwd"] = meta["cwd"]
    # `delegationDepth` is always serialized (top-level sessions default to 0).
    line["delegationDepth"] = meta.get("delegationDepth", 0)
    if "agentPreset" in meta:
        line["agentPreset"] = meta["agentPreset"]
    return line


def event_line(seq, time, etype, data, surface_op):
    """Flatten one `(type, data, surface_op)` triple into a SessionEvent line."""
    event = {"type": etype, "seq": seq, "time": time, "data": data}
    if surface_op is not None:
        # Surface events carry the SurfaceOp inline (`"append"` or a replace obj).
        event["surfaceOp"] = surface_op
    return event


def write_jsonl(path, meta, events):
    lines = [header_line(meta)]
    for seq, (etype, data, surface_op) in enumerate(events):
        # Envelope `time` is ms since epoch; derive it deterministically and
        # monotonically from the session's createdAt so every event carries a
        # plausible, strictly increasing coordinate.
        time = meta["createdAt"] + (seq + 1) * 1000
        lines.append(event_line(seq, time, etype, data, surface_op))
    with open(path, "w", encoding="utf-8") as f:
        # JSONL: one record per line, every line newline-terminated (including
        # the last — the real writer appends the final newline).
        f.write("\n".join(j(line) for line in lines) + "\n")


# ---------------------------------------------------------------------------
# Self-verification (reads the JSONL back exactly as the adapter would)
# ---------------------------------------------------------------------------

def read_evidence(path):
    with open(path, "r", encoding="utf-8") as f:
        lines = f.read().splitlines()

    assert lines, "empty log"
    header = json.loads(lines[0])
    events = [json.loads(line) for line in lines[1:]]

    catalogs = []          # (seq, [names]) from skill-catalog messages
    invocations = []       # (seq, name) from skill-invocation messages
    skill_tool_calls = []  # (seq, name) from tool/call name="skill"
    for event in events:
        etype = event["type"]
        d = event["data"]
        if etype == "user/message":
            src = d.get("source", {})
            if src.get("kind") == "skill-catalog":
                catalogs.append((event["seq"], [e["name"] for e in src["entries"]]))
            elif src.get("kind") == "skill-invocation":
                invocations.append((event["seq"], src["name"]))
        elif etype == "tool/call" and d.get("name") == "skill":
            skill_tool_calls.append((event["seq"], json.loads(d["arguments"])["name"]))

    return {
        "header": header,
        "events": events,
        "catalogs": catalogs,
        "invocations": invocations,
        "skill_tool_calls": skill_tool_calls,
    }


def assert_envelope(ev):
    """Assert every record has the SessionHeader / SessionEvent shape.

    - header: `type == 'session'`, `version == SESSION_FORMAT_VERSION`,
      integer id/createdAt, and an integer `delegationDepth`.
    - events: `type/seq/time/data` present; `seq` is 0-based and contiguous;
      `time` is an integer Unix-ms; surface types carry `surfaceOp`, the rest
      must not.
    """
    header = ev["header"]
    assert header["type"] == HEADER_RECORD_TYPE, header
    assert header["version"] == SESSION_FORMAT_VERSION, header
    assert isinstance(header["id"], str) and header["id"], header
    assert isinstance(header["createdAt"], int) and header["createdAt"] >= 0, header
    assert isinstance(header["delegationDepth"], int) and header["delegationDepth"] >= 0, header

    for seq, event in enumerate(ev["events"]):
        assert isinstance(event, dict), event
        assert set(event) >= {"type", "seq", "time", "data"}, event
        assert event["seq"] == seq, (seq, event)
        assert isinstance(event["time"], int) and event["time"] >= 0, event
        assert isinstance(event["data"], dict), event
        if event["type"] in SURFACE_TYPES:
            assert "surfaceOp" in event, event
            op = event["surfaceOp"]
            assert op == "append" or (
                isinstance(op, dict) and op.get("op") == "replace"
            ), event
        else:
            assert "surfaceOp" not in event, event


def main():
    complete_path = os.path.join(HERE, "complete.jsonl")
    incomplete_path = os.path.join(HERE, "incomplete.jsonl")

    meta, events = build_complete()
    write_jsonl(complete_path, meta, events)

    meta, events = build_incomplete()
    write_jsonl(incomplete_path, meta, events)

    # --- assert complete ---
    ev = read_evidence(complete_path)
    assert_envelope(ev)
    assert ev["header"]["id"] == "sess-complete-0001"
    assert len(ev["events"]) == 24, len(ev["events"])
    assert len(ev["catalogs"]) == 1, ev["catalogs"]
    assert ev["catalogs"][0][1] == [e["name"] for e in CATALOG_ENTRIES_COMPLETE]
    assert ev["invocations"] == [(13, USER_INVOKED_SKILL)], ev["invocations"]
    assert ev["skill_tool_calls"] == [(19, MODEL_SELECTED_SKILL)], ev["skill_tool_calls"]

    # --- assert incomplete ---
    ev = read_evidence(incomplete_path)
    assert_envelope(ev)
    assert ev["header"]["id"] == "sess-incomplete-0002"
    assert len(ev["events"]) == 15, len(ev["events"])
    assert len(ev["catalogs"]) == 1, ev["catalogs"]  # only turn 2's catalog
    assert ev["catalogs"][0][1] == [e["name"] for e in CATALOG_ENTRIES_INCOMPLETE]
    assert ev["invocations"] == [], ev["invocations"]
    assert ev["skill_tool_calls"] == [], ev["skill_tool_calls"]

    print(f"wrote {complete_path} (complete)")
    print(f"wrote {incomplete_path} (incomplete)")
    print("self-verification passed")


if __name__ == "__main__":
    main()
