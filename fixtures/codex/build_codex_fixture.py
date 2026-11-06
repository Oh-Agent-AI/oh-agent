#!/usr/bin/env python3
"""Build the Codex rollout fixtures: `legacy.jsonl` + `paginated.jsonl`
(top-level, behavior/evidence corpus) and the Stage-2 `usage-fact/` subtree
(UsageFact emitter corpus, v0.7 spec §6 acceptance fixtures).

These reproduce the real on-disk rollout format observed from the live corpus
(`~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl`, plaintext append-only
JSONL, one `{timestamp, type, payload}` envelope per line). §14.1's Rust enum
names are NOT the wire format — these fixtures use the real snake_case /
PascalCase names (see README.md in this directory for the source-of-truth
field-path table). All content is synthetic: invented session IDs, paths,
commands. No user content, nothing scraped from real sessions.

The top-level two files deliberately exercise the §13 Codex (Legacy) vs Codex
(Paginated) columns with *different* coverage — `legacy.jsonl` carries the
Legacy-only `token_count`/`task_started`/`patch_apply_end` events, while
`paginated.jsonl` carries the Paginated-only TurnItems (`CommandExecution`/
`FileChange`/`HookPrompt`). This is what makes the differential assertion "two
rows, not one" (§17.1) meaningful.

The `usage-fact/` subtree is the Stage-2 emitter corpus (spec §6, v0.7 Stage 2):
each file carries **fold-consumable** `token_count` events (object-shaped
`total_token_usage` / `last_token_usage`, per the real wire — unlike the
top-level `legacy.jsonl`, whose simplified integer totals serve the evidence
layer, not the fold). The set covers the three §8 fixture shapes:

  legacy.jsonl                history_mode=legacy, sid via session_meta,
                              2 Consumed facts + Unattributed/Repeat/Unreadable
                              residuals（每次发射只认 token_count、mode 只做
                              provenance——§5「绝不按 history_mode 分支」）。
  paginated.jsonl             history_mode=paginated + `CommandExecution` +
                              `custom_tool_call` 双影子 exec（token 层产 0 fact，
                              §2.2/§6.5）→ 1 Consumed fact + Repeat/Unreadable 残差。
  rollout-1a.jsonl / 1b.jsonl byte-identical、同逻辑 sid、**异 stem**（§6.8）——
                              source_event_id 按 stem 命名空间 → 各发一条、绝不误合并。
  rollout-live.jsonl          + archive/rollout-live.jsonl：byte-identical、
                              **同 stem** 双路径收录（§6.9 live/archive 双收）→
                              duplicate attempt、保留一条。

Only the Python standard library is used (`json` + the repo's own
`agent_vitals.codex_evidence` for the top-level corpus, `agent_vitals.
codex_usage_fact` for the usage-fact corpus, both for self-verification).

Run:  python3 fixtures/codex/build_codex_fixture.py

Output (relative to this script's directory):
    legacy.jsonl    — a Legacy-mode rollout (evidence corpus).
    paginated.jsonl — a Paginated-mode rollout (evidence corpus).
    usage-fact/legacy.jsonl / paginated.jsonl / rollout-1a.jsonl / 1b.jsonl /
        rollout-live.jsonl / archive/rollout-live.jsonl — emitter corpus.

The script is deterministic (fixed timestamps / IDs) and self-verifying: after
writing each file it re-opens it, asserts the envelope, and runs the relevant
fold over the parsed items asserting the exact counts each fixture must
produce — so a fixture that stops exercising the mapping table fails loudly
instead of silently passing.
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.normpath(os.path.join(HERE, "..", "..", "scripts"))
sys.path.insert(0, SCRIPTS)

# 包级导入，自证用（stdlib-only，无三方依赖）：codex_evidence 自省顶层证据语料，
# codex_usage_fact 自省 usage-fact 发射语料。**不 spec-load 成独立模块**——
# 扁平改名（14648c2）把 codex_evidence.py 移进 agent/ 后，这里曾写死旧根路径
# FileNotFound（builder 静默坏到这次修复）；且 codex_evidence.py 用绝对
# `from agent_vitals.agent import …` 导入，spec-load 会绕过包结构。包级导入让
# 加载路径随包结构走，不重抄。
from agent_vitals.agent import codex_evidence as _ce


def j(obj):
    """Serialize compactly, deterministic key order, no ASCII escaping."""
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


# ---------------------------------------------------------------------------
# Wire-format builders (field paths from the live corpus; see README.md)
# ---------------------------------------------------------------------------

def meta(mode, cli_version, session_id):
    """`session_meta` — carries session_id/id/history_mode/cli_version/cwd.
    `payload.model` is deliberately absent (real session_meta model is null)."""
    return {"timestamp": "2026-07-25T11:19:35.404Z",
            "type": "session_meta",
            "payload": {"session_id": session_id, "id": session_id,
                        "history_mode": mode, "cli_version": cli_version,
                        "cwd": "/Users/alice/repo"}}


def turn_context(turn_id, model, roots, approval_policy, sandbox_policy):
    """`turn_context` — the authoritative carrier of `model` and
    `workspace_roots` (session_meta's model is null on the real wire)."""
    return {"timestamp": "2026-07-25T11:19:36.000Z", "type": "turn_context",
            "payload": {"turn_id": turn_id, "cwd": "/Users/alice/repo",
                        "workspace_roots": roots, "model": model,
                        "approval_policy": approval_policy,
                        "sandbox_policy": sandbox_policy}}


def event(event_type, payload_extra=None, ts="2026-07-25T11:19:37.000Z"):
    """One `event_msg` line; `payload.type` is the event type."""
    payload = {"type": event_type, "turn_id": "t1"}
    if payload_extra:
        payload.update(payload_extra)
    return {"timestamp": ts, "type": "event_msg", "payload": payload}


def item_completed(item, ts="2026-07-25T11:20:02.000Z"):
    """Paginated carrier: `event_msg` with `payload.type == "item_completed"`
    wrapping `payload.item.{type, …}`."""
    return {"timestamp": ts, "type": "event_msg",
            "payload": {"type": "item_completed", "turn_id": "t1", "item": item}}


def response(response_type, ts="2026-07-25T11:19:40.000Z"):
    return {"timestamp": ts, "type": "response_item",
            "payload": {"type": response_type}}


# ---------------------------------------------------------------------------
# Fixture data — two rollouts with intentionally different coverage
# ---------------------------------------------------------------------------

def build_legacy():
    """A Legacy-mode rollout: the §13 Legacy column's measured carriers."""
    return [
        meta("legacy", "0.146.0-alpha.3.1", "codex-legacy-0001"),
        turn_context("t1", "gpt-5.6-sol", ["/Users/alice/repo"],
                     "on-request", "workspace-write"),
        event("task_started"),
        event("mcp_tool_call_end", ts="2026-07-25T11:19:38.000Z"),
        event("web_search_end", ts="2026-07-25T11:19:39.000Z"),
        response("custom_tool_call"),
        response("custom_tool_call_output", ts="2026-07-25T11:19:41.000Z"),
        event("patch_apply_end", ts="2026-07-25T11:19:42.000Z"),
        event("context_compacted", ts="2026-07-25T11:19:43.000Z"),
        event("sub_agent_activity", ts="2026-07-25T11:19:44.000Z"),
        event("thread_settings_applied",
              {"thread_settings": {"approval_policy": "Never"}},
              ts="2026-07-25T11:19:45.000Z"),
        event("token_count",
              {"info": {"total_token_usage": 120000, "last_token_usage": 60000,
                        "model_context_window": 128000},
               "rate_limits": {"plan_type": "plus"}},
              ts="2026-07-25T11:19:46.000Z"),
        event("task_complete", ts="2026-07-25T11:19:47.000Z"),
    ]


def build_paginated():
    """A Paginated-mode rollout: TurnItems + response_items the Legacy column
    cannot supply (duration, FileChange, HookPrompt).

    **必须逐字节等于提交的 `paginated.jsonl`**——该文件后来被手工补进
    `rm -rf` / `sudo apt-get` / `curl | sh` 三条 CommandExecution 与一条 user
    prompt，SV601-603 / UserPrompts 回归测试靠它们承载命中样例；builder 曾因
    停在旧形状而**静默截断语料**（本函数旧版无 item-1b/1c/1d 与 message），
    与提交文件比对才暴露。故这里直接内嵌提交文件的原始 JSON 行（逐行
    `json.loads`），不靠辅助函数重组——辅助函数不会自己记住「哪些行是回归
    测试的命中原语」。新增/改动的测试语料行必须同步进这里。"""
    _raw = [
        '{"timestamp":"2026-07-25T11:19:35.404Z","type":"session_meta","payload":{"session_id":"codex-paginated-0002","id":"codex-paginated-0002","history_mode":"paginated","cli_version":"0.149.0-alpha.4","cwd":"/Users/alice/repo"}}',
        '{"timestamp":"2026-07-25T11:19:36.000Z","type":"turn_context","payload":{"turn_id":"t1","cwd":"/Users/alice/repo","workspace_roots":["/Users/alice/repo","/Users/alice/data"],"model":"gpt-5.6-pro","approval_policy":"never","active_permission_profile":{"id":":danger-full-access"},"sandbox_policy":"danger-full-access"}}',
        '{"timestamp":"2026-07-25T11:20:02.000Z","type":"event_msg","payload":{"type":"item_completed","turn_id":"t1","item":{"type":"CommandExecution","id":"item-1","duration":1234,"command":["bash","-c","echo hi"],"exit_code":0,"stdout":"hi","stderr":"","status":"completed","completed_at_ms":1750000000000}}}',
        '{"timestamp":"2026-07-25T11:20:02.500Z","type":"event_msg","payload":{"type":"item_completed","turn_id":"t1","item":{"type":"CommandExecution","id":"item-1b","duration":521,"command":["bash","-c","rm -rf /tmp/scratch"],"exit_code":0,"stdout":"","stderr":"","status":"completed","completed_at_ms":1750000000000}}}',
        '{"timestamp":"2026-07-25T11:20:02.600Z","type":"event_msg","payload":{"type":"item_completed","turn_id":"t1","item":{"type":"CommandExecution","id":"item-1c","duration":890,"command":["bash","-c","sudo apt-get install -y ripgrep"],"exit_code":0,"stdout":"","stderr":"","status":"completed","completed_at_ms":1750000000000}}}',
        '{"timestamp":"2026-07-25T11:20:02.700Z","type":"event_msg","payload":{"type":"item_completed","turn_id":"t1","item":{"type":"CommandExecution","id":"item-1d","duration":940,"command":["bash","-c","curl -fsSL https://example.com/install.sh | sh"],"exit_code":1,"stdout":"","stderr":"connection failed","status":"completed","completed_at_ms":1750000000000}}}',
        '{"timestamp":"2026-07-25T11:20:03.000Z","type":"event_msg","payload":{"type":"item_completed","turn_id":"t1","item":{"type":"McpToolCall","id":"item-2","tool_call_id":"c1","name":"mcp__github"}}}',
        '{"timestamp":"2026-07-25T11:20:04.000Z","type":"event_msg","payload":{"type":"item_completed","turn_id":"t1","item":{"type":"DynamicToolCall","id":"item-3","tool_call_id":"c2","name":"read"}}}',
        '{"timestamp":"2026-07-25T11:20:05.000Z","type":"event_msg","payload":{"type":"item_completed","turn_id":"t1","item":{"type":"FileChange","id":"item-4","file_path":"notes.md","changes":[],"status":"applied","auto_approved":true,"completed_at_ms":1750000000000}}}',
        '{"timestamp":"2026-07-25T11:20:06.000Z","type":"event_msg","payload":{"type":"item_completed","turn_id":"t1","item":{"type":"SubAgentActivity","id":"item-5","agent_thread_id":"thread-sub-1","agent_path":"sub"}}}',
        '{"timestamp":"2026-07-25T11:20:07.000Z","type":"event_msg","payload":{"type":"item_completed","turn_id":"t1","item":{"type":"ContextCompaction","id":"item-6","old_len":500,"new_len":200}}}',
        '{"timestamp":"2026-07-25T11:20:08.000Z","type":"event_msg","payload":{"type":"item_completed","turn_id":"t1","item":{"type":"HookPrompt","id":"item-7","fragments":[]}}}',
        '{"timestamp":"2026-07-25T11:20:09.000Z","type":"response_item","payload":{"type":"function_call"}}',
        '{"timestamp":"2026-07-25T11:20:10.000Z","type":"response_item","payload":{"type":"function_call_output"}}',
        '{"timestamp":"2026-07-25T11:20:11.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"请把这段函数重构一下"}]}}',
    ]
    return [json.loads(s) for s in _raw]


# ---------------------------------------------------------------------------
# Writing + self-verification
# ---------------------------------------------------------------------------

KNOWN_TOP_LEVEL = frozenset((
    "session_meta", "turn_context", "event_msg", "response_item", "world_state",
    "compacted", "inter_agent_communication_metadata"))


def write_jsonl(path, records):
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(j(r) for r in records) + "\n")


def read_jsonl(path):
    with open(path, "r", encoding="utf-8") as f:
        return [json.loads(line) for line in f.read().splitlines() if line.strip()]


def assert_envelope(records):
    assert records, "empty rollout"
    assert records[0]["type"] == "session_meta", records[0]
    for record in records:
        assert isinstance(record, dict), record
        assert record["type"] in KNOWN_TOP_LEVEL, record["type"]
        assert isinstance(record.get("payload"), dict), record
    # provenance round-trips through parse_codex_session_log (same reader both
    # implementations use), so the fixture also proves the reader's field paths.
    session_meta = records[0]["payload"]
    assert session_meta["history_mode"] in ("legacy", "paginated"), session_meta


def assert_coverage(path, expected_signals, expected_counts, session_id, mode):
    records = read_jsonl(path)
    assert_envelope(records)
    signals, coverage, unknown = _ce.derive_coverage(records)
    assert not unknown, "fixture should not trip attempts: %s" % (unknown,)
    assert signals == list(expected_signals), (path, signals, expected_signals)
    for signal, expected in expected_counts.items():
        got = coverage[signal]
        assert got["measured"] == expected[0] and got["derived"] == expected[1] \
            and got["lossy"] == expected[2] and got["unmetered"] == expected[3], \
            "%s: %s = %s, expected %s" % (path, signal, got, expected)
    # provenance: session_id + history_mode from the same record the CLI reads.
    assert records[0]["payload"]["session_id"] == session_id, records[0]
    assert records[0]["payload"]["history_mode"] == mode, records[0]


# ---------------------------------------------------------------------------
# Stage-2 usage-fact corpus（spec §6/§8）—— emitter 是 codex fold 的共享观察者，
# 这里的 token_count 必须 fold-consumable（object 形 total/last），否则不发 fact。
# 与顶层 legacy.jsonl 的 integer-total 简化形（证据层专用）刻意不同。
# ---------------------------------------------------------------------------

def uf_total(input_tokens, output_tokens, cached=0, cache_write=0, reasoning=0):
    """object 形 `last_token_usage`/`total_token_usage` 6 字段（真实 wire）。
    `total_tokens` 只作去重签名 + 残差哨兵的大数，取值不影响本 corpus 的判定。"""
    return {"input_tokens": input_tokens, "output_tokens": output_tokens,
            "cached_input_tokens": cached, "cache_write_input_tokens": cache_write,
            "reasoning_output_tokens": reasoning,
            "total_tokens": input_tokens + output_tokens + cached + cache_write}


def uf_session_meta(sid, mode, cli_version):
    return {"timestamp": "2026-09-02T00:00:00.000Z", "type": "session_meta",
            "payload": {"session_id": sid, "id": sid, "history_mode": mode,
                        "cli_version": cli_version, "cwd": "/Users/alice/repo"}}


def uf_turn_context(model, ts="2026-09-02T00:00:01.000Z"):
    """turn_context 是 model 游标源（token_count 自身不带 model）。"""
    return {"timestamp": ts, "type": "turn_context",
            "payload": {"turn_id": "t1", "cwd": "/Users/alice/repo",
                        "workspace_roots": ["/Users/alice/repo"], "model": model,
                        "approval_policy": "on-request",
                        "sandbox_policy": "workspace-write", "service_tier": None}}


def uf_token_count(ts, total, last, rate_limits=None):
    """fold-consumable `event_msg/token_count`。payload 无 turn_id/id —— 与 spec
    §3.3 wire 实证一致（token_count envelope 只有 type/info/rate_limits）。"""
    info = {"total_token_usage": total, "last_token_usage": last}
    payload = {"type": "token_count", "info": info}
    if rate_limits is not None:
        payload["rate_limits"] = rate_limits
    return {"timestamp": ts, "type": "event_msg", "payload": payload}


def uf_paginated_exec(ts):
    """Paginated wire 的双影子 exec（token 层产 0 fact，§2.2）：`item_completed`
    CommandExecution 与 `response_item` custom_tool_call 是同一逻辑 exec 的两份
    影子——行为层（SV611）要跳过影子，token 层根本不读它俩。"""
    return [
        {"timestamp": ts, "type": "event_msg",
         "payload": {"type": "item_completed", "turn_id": "t1",
                     "item": {"type": "CommandExecution", "id": "item-1",
                              "duration": 1234, "command": ["bash", "-c", "echo hi"],
                              "exit_code": 0, "stdout": "hi", "stderr": "",
                              "status": "completed", "completed_at_ms": 1750000000000}}},
        {"timestamp": ts, "type": "response_item",
         "payload": {"type": "custom_tool_call", "call_id": "call-1"}},
    ]


def build_uf_legacy():
    """history_mode=legacy；2 次 Consumed + 三类残差（Unattributed/Repeat/
    Unreadable），发射计数见 build 时 self-check。"""
    tc0 = uf_token_count("2026-09-02T00:00:00.500Z",
                         uf_total(300, 30), uf_total(300, 30))
    t1 = uf_total(1000, 150, cached=400, cache_write=100, reasoning=30)
    t2 = uf_total(2500, 400, cached=900, cache_write=100, reasoning=50)
    t3 = uf_total(600, 60)
    repeat_last = uf_total(0, 0, 0, 0, 0)  # 清零复读（假 total，见 core 注释）
    unread_last = uf_total(100, 5, 0, 0, reasoning=9)  # reasoning > output
    return [
        uf_session_meta("codex-usage-legacy-0001", "legacy", "0.146.0-alpha.3.1"),
        tc0,                                              # 首 turn_context 前 → Unattributed
        uf_turn_context("gpt-5.6-sol"),
        uf_token_count("2026-09-02T00:00:02.000Z", t1, t1),       # Consumed #1
        uf_token_count("2026-09-02T00:00:03.000Z", t1, repeat_last),  # 同 total 复读 → Repeat
        uf_token_count("2026-09-02T00:00:04.000Z", t2, t2),       # Consumed #2
        uf_token_count("2026-09-02T00:00:05.000Z", t3, unread_last),  # reasoning>output → Unreadable
    ]


def build_uf_paginated():
    """history_mode=paginated + CommandExecution/custom_tool_call 双影子（§6.5）；
    1 次 Consumed + Repeat/Unreadable 残差。mode 只做 provenance——emitter 绝不按
    history_mode 分支（§5），验收 #3/#4 是同一份规则在两个 mode 词表上都 emit。"""
    p1 = uf_total(2000, 200, cached=600, cache_write=200, reasoning=20)
    p2 = uf_total(500, 50)
    return [
        uf_session_meta("codex-usage-paginated-0002", "paginated", "0.149.0-alpha.4"),
        uf_turn_context("gpt-5.6-pro"),
        *uf_paginated_exec("2026-09-02T00:00:01.500Z"),
        uf_token_count("2026-09-02T00:00:02.000Z", p1, p1),       # Consumed
        uf_token_count("2026-09-02T00:00:03.000Z", p1, uf_total(0, 0, 0, 0, 0)),  # Repeat
        uf_token_count("2026-09-02T00:00:04.000Z", p2, uf_total(200, 20, 0, 0, reasoning=30)),  # Unreadable
    ]


def build_uf_single(sid, mode, model, input_tokens, output_tokens, cached, cache_write):
    """跨 stem / live-archive 两族共用的「单 fact」内容：session_meta + turn_context
    + 1 次 Consumed token_count。同一 sid 的内容在多个文件里 byte-identical 复写。"""
    t = uf_total(input_tokens, output_tokens, cached=cached, cache_write=cache_write)
    return [
        uf_session_meta(sid, mode, "0.149.0-alpha.4"),
        uf_turn_context(model),
        uf_token_count("2026-09-02T00:00:02.000Z", t, t),
    ]


def write_usage_fact_fixtures():
    """写 `usage-fact/` 六份文件并用真 emitter self-check（两次发射不变量：
    内容变了但测试没跟上会当场红，镜像顶层 fixture 的 assert_coverage 风格）。"""
    from agent_vitals.agent.codex_usage_fact import codex_rollouts_to_usage_facts

    base = os.path.join(HERE, "usage-fact")
    arch = os.path.join(base, "archive")
    os.makedirs(arch, exist_ok=True)

    uf_legacy = os.path.join(base, "legacy.jsonl")
    uf_paginated = os.path.join(base, "paginated.jsonl")
    c1a = os.path.join(base, "rollout-1a.jsonl")
    c1b = os.path.join(base, "rollout-1b.jsonl")
    live = os.path.join(base, "rollout-live.jsonl")
    live_arch = os.path.join(arch, "rollout-live.jsonl")

    for p, records in [
        (uf_legacy, build_uf_legacy()),
        (uf_paginated, build_uf_paginated()),
        # §6.8：异 stem、同逻辑 sid、byte-identical → 各发一条、绝不误合并。
        (c1a, build_uf_single("codex-usage-cross-0004", "legacy", "gpt-5.6-sol",
                              800, 80, cached=200, cache_write=50)),
        (c1b, build_uf_single("codex-usage-cross-0004", "legacy", "gpt-5.6-sol",
                              800, 80, cached=200, cache_write=50)),
        # §6.9：同 stem live/archive 双收（byte-identical）→ duplicate、保留一条。
        (live, build_uf_single("codex-usage-live-0005", "paginated", "gpt-5.6-terra",
                               1200, 120, cached=300, cache_write=100)),
        (live_arch, build_uf_single("codex-usage-live-0005", "paginated", "gpt-5.6-terra",
                                    1200, 120, cached=300, cache_write=100)),
    ]:
        assert_envelope(records)
        write_jsonl(p, records)

    ns = "ns-fixture-build"
    expect = {
        # (path, expected coverage dict, expected attempts dict)
        uf_legacy: ({"total_token_count_events": 4, "fact_rows": 2, "skip_rows": 2},
                    {"skip": 0, "unreadable": 1, "unattributed": 1}),
        uf_paginated: ({"total_token_count_events": 2, "fact_rows": 1, "skip_rows": 1},
                       {"skip": 0, "unreadable": 1, "unattributed": 0}),
        c1a: ({"total_token_count_events": 1, "fact_rows": 1, "skip_rows": 0},
              {"skip": 0, "unreadable": 0, "unattributed": 0}),
        c1b: ({"total_token_count_events": 1, "fact_rows": 1, "skip_rows": 0},
              {"skip": 0, "unreadable": 0, "unattributed": 0}),
        live: ({"total_token_count_events": 1, "fact_rows": 1, "skip_rows": 0},
               {"skip": 0, "unreadable": 0, "unattributed": 0}),
        live_arch: ({"total_token_count_events": 1, "fact_rows": 1, "skip_rows": 0},
                    {"skip": 0, "unreadable": 0, "unattributed": 0}),
    }
    for p, (cov, att) in expect.items():
        r = codex_rollouts_to_usage_facts([p], machine_namespace=ns, source_profile="default")
        assert r.coverage == cov, "%s coverage %s != %s" % (p, r.coverage, cov)
        assert r.attempts == att, "%s attempts %s != %s" % (p, r.attempts, att)
        assert r.malformed == 0, p
        assert len(r.facts) == cov["fact_rows"], p

    # §6.8 双文件 → 2 fact（同形同 offset 异 stem 不误合并）；§6.9 双文件 → 1 fact
    # + duplicate（同 stem 双收）。跨文件语义在 builder 就钉住，测试只是同一断言
    # 的 byte-parity 侧。
    cross = codex_rollouts_to_usage_facts([c1a, c1b], machine_namespace=ns,
                                          source_profile="default")
    assert cross.coverage == {"total_token_count_events": 2, "fact_rows": 2, "skip_rows": 0}, cross.coverage
    assert cross.attempts == {"skip": 0, "unreadable": 0, "unattributed": 0}, cross.attempts
    assert len({f["source_event_id"] for f in cross.facts}) == 2, "异 stem 必须各发一条"
    livepair = codex_rollouts_to_usage_facts([live, live_arch], machine_namespace=ns,
                                             source_profile="default")
    assert livepair.coverage == {"total_token_count_events": 2, "fact_rows": 1, "skip_rows": 1}, livepair.coverage
    assert livepair.attempts == {"skip": 0, "unreadable": 0, "unattributed": 0, "duplicate": 1}, livepair.attempts
    return base, uf_legacy, uf_paginated, c1a, c1b, live, live_arch


def main():
    legacy_path = os.path.join(HERE, "legacy.jsonl")
    paginated_path = os.path.join(HERE, "paginated.jsonl")
    write_jsonl(legacy_path, build_legacy())
    write_jsonl(paginated_path, build_paginated())
    uf_files = write_usage_fact_fixtures()

    # Legacy column (§13): the two rows must be different — that is the §17.1
    # "two rows, not one" assertion, pinned at fixture build time.
    assert_coverage(
        legacy_path,
        expected_signals=["ToolCalls", "ToolResults", "TurnBoundaries", "Usage",
                          "UsageAggregate", "ContextWindow", "QuotaConsumption",
                          "ApprovalPolicy", "SandboxModes", "Compaction",
                          "SubagentSpawns", "SkillInvocations", "FileMutations"],
        expected_counts={
            "ToolCalls": (3, 0, 0, 0),      # mcp_tool_call_end + web_search_end + custom_tool_call
            "ToolResults": (1, 0, 0, 0),    # custom_tool_call_output
            "TurnBoundaries": (2, 0, 0, 0), # task_started + task_complete
            "Usage": (1, 0, 0, 0),
            "UsageAggregate": (0, 1, 0, 0), # derived presence marker
            "ContextWindow": (1, 0, 0, 0),
            "QuotaConsumption": (1, 0, 0, 0),  # token_count.rate_limits（legacy 携带）
            "ApprovalPolicy": (2, 0, 0, 0), # turn_context + thread_settings_applied
            "SandboxModes": (1, 0, 0, 0),   # turn_context.sandbox_policy
            "Compaction": (1, 0, 0, 0),
            "SubagentSpawns": (1, 0, 0, 0),
            "SkillInvocations": (0, 1, 0, 0),  # derived presence marker
            "FileMutations": (0, 0, 1, 0),  # patch_apply_end → lossy bucket
            "Hooks": (0, 0, 0, 0),          # absent in Legacy, not in SignalSet
            "ApprovalDecisions": (0, 0, 0, 0),
        },
        session_id="codex-legacy-0001", mode="legacy")

    assert_coverage(
        paginated_path,
        expected_signals=["ToolCalls", "ToolResults", "ApprovalDecisions",
                          "ApprovalPolicy", "SandboxModes", "Compaction",
                          "SubagentSpawns", "SkillInvocations", "Hooks",
                          "FileMutations", "UserPrompts"],
        expected_counts={
            # 提交语料 15 行：4 CommandExecution（item-1..1d）+ McpToolCall +
            # DynamicToolCall + function_call response_item。
            "ToolCalls": (7, 0, 0, 0),
            "ToolResults": (5, 0, 0, 0),    # 4 CommandExecution + function_call_output
            "FileMutations": (1, 0, 0, 0),  # FileChange → measured bucket (not lossy)
            "ApprovalDecisions": (1, 0, 0, 0),  # FileChange.auto_approved
            "ApprovalPolicy": (1, 0, 0, 0),     # turn_context only
            "SandboxModes": (1, 0, 0, 0),   # turn_context.sandbox_policy
            "Compaction": (1, 0, 0, 0),
            "SubagentSpawns": (1, 0, 0, 0),
            "SkillInvocations": (0, 1, 0, 0),
            "Hooks": (1, 0, 0, 0),          # HookPrompt — Paginated-only
            "UserPrompts": (1, 0, 0, 0),    # response_item role=user message（回归补的）
        },
        session_id="codex-paginated-0002", mode="paginated")

    print("wrote %s (%d records) and %s (%d records)"
          % (legacy_path, len(read_jsonl(legacy_path)),
             paginated_path, len(read_jsonl(paginated_path))))
    base, uf_legacy, uf_paginated, c1a, c1b, live, live_arch = uf_files
    uf_count = sum(len(read_jsonl(p)) for p in
                   (uf_legacy, uf_paginated, c1a, c1b, live, live_arch))
    print("wrote usage-fact corpus under %s (%d records across %d files)"
          % (base, uf_count, 6))
    print("self-verification passed")


if __name__ == "__main__":
    main()
