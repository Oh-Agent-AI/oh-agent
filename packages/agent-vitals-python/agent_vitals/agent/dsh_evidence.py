"""DSH execution_events → canonical session 的翻译层（Python 镜像）。

Rust `crates/agent-vitals-harnesses/src/harnesses/dsh/sessions/evidence.rs::populate_timelines` 的
Python 对应——把 execution_events 翻译成 `canonical_audit.py::audit_projection`
消费的 5 条 harness-neutral timeline（tool_calls/tool_results/approvals/
sandbox_modes/turns）。v0.6 harness-contract spec §7-C / §11-M1 交付：DSH 的
Python behavior 审计从此和 claude/codex/workbuddy 一样，经共享求值器求值，
不再自带一套直判逻辑（`behavior.py` 原来的 `match_behavior_gated` 直接吃裸
DSH 事件 + `trajectory.py::match_trajectory` 各判各的两条路）。G3 的 dsh
Python 侧缺口（"pending M1"）在本模块存在后关闭。

`Coords`/`TOOL_CALL_TYPES`/`_tool_invocation`/`_result_code`/`_int_or_none` 复用
`behavior.py` 现成实现——两边坐标顺延与事件分类逻辑完全同构（`behavior.py`
自己的 `Coords` 文档已经就是 Rust `dsh_evidence.rs::Coords` 的逐字节镜像），
没有理由为这个模块单独写第二份；`trajectory.py`/`compaction.py` 也是同一批
共享导入，见 `scripts/agent_vitals/__init__.py` 顶部注释的公开导入面。

本模块只翻译，不判定——正则匹配住在 `canonical_audit.py`（执行环境无关的共享
求值器）；这里产出的 canonical dict 直接喂给它的 `audit_projection`。
"""

from .behavior import Coords, TOOL_CALL_TYPES, _int_or_none, _result_code, _tool_invocation
from ..util import session_span


def _timeline_entry(observation, seq, time, turn, step, call_id, ordinal):
    """一条 timeline entry。DSH 全部是执行环境原生记录——逐事件 provenance 恒
    "measured"，没有推导/估算（与 Rust `dsh_evidence.rs::make_entry` 对齐；
    `provenance` 字段 `canonical_audit.py::audit_projection` 不读，只为跟其余
    执行环境适配器的 entry 形状保持一致）。"""
    return {
        "observation": observation, "provenance": "measured",
        "seq": seq, "time": time, "turn": turn, "step": step,
        "call_id": call_id, "ordinal": ordinal,
    }


def _flush_turn(turns, pending):
    seq, time, turn, step, call_id, ordinal = pending["entry"]
    turns.append(_timeline_entry({
        "turn": pending["turn"], "sig": pending["sig"], "last_seq": pending["last_seq"],
        "end_reason_kind": pending["end_reason_kind"], "end_error_code": pending["end_error_code"],
        "end_seq": pending["end_seq"], "end_time": pending["end_time"],
    }, seq, time, turn, step, call_id, ordinal))


def populate_timelines(execution_events):
    """跑一遍 `Coords`，把 execution_events 里的工具调用/结果/审批/沙箱/turn
    事件翻译成五个 harness-neutral timeline（§11.5）。与 Rust
    `dsh_evidence.rs::populate_timelines` 逐字节对齐：边界事件先推进坐标、
    再对本事件取坐标，`ordinal` 是「在传入数组里的下标」；turn 生命周期是
    同一遍里额外跑的状态化 pass（`pending`），不是第二次遍历——`last_seq`
    需要"下一个 turn/start 之前最后出现的事件 seq"，单遍才能拿到。

    返回 `{"tool_calls": {"entries": [...]}, ...}` 五键 dict，直接是
    `canonical_audit.py::audit_projection` 期待的 `tls` 形状（含 turns）。
    """
    tool_calls, tool_results, approvals, sandbox_modes, turns = [], [], [], [], []
    coords = Coords()
    pending = None

    for ordinal, event in enumerate(execution_events):
        if not isinstance(event, dict):
            continue
        coords.observe(event)
        turn, step, call_id = coords.resolve(event)
        seq = _int_or_none(event.get("seq"))
        time = _int_or_none(event.get("time"))
        etype = event.get("type")
        data = event.get("data")
        data = data if isinstance(data, dict) else {}

        if etype == "turn/start":
            if pending is not None:
                _flush_turn(turns, pending)
            turn_no = _int_or_none(data.get("turn"))
            pending = {
                "turn": turn_no if turn_no is not None else 0,
                "sig": [], "last_seq": seq,
                "entry": (seq, time, turn, step, call_id, ordinal),
                "end_reason_kind": None, "end_error_code": None,
                "end_seq": None, "end_time": None,
            }
            continue

        # turn/start 之外的任何事件都推进「最后事件 seq」——turn/end 自身也在
        # 内（它既推进 last_seq 又填 end_* 字段，两者在 fixture 里恒相等但
        # 语义不同）。
        if pending is not None and seq is not None:
            pending["last_seq"] = seq

        if etype in TOOL_CALL_TYPES:
            inv = _tool_invocation(event)
            if inv is not None:
                name, args_text = inv
                tool_calls.append(_timeline_entry(
                    {"name": name, "args_text": args_text}, seq, time, turn, step, call_id, ordinal))
                if pending is not None:
                    pending["sig"].append((name, args_text))
        elif etype == "tool/result":
            tool_results.append(_timeline_entry(
                {"failed": None, "error_code": _result_code(event)}, seq, time, turn, step, call_id, ordinal))
        elif etype == "approval/asked":
            tool_name = data.get("toolName")
            reason = data.get("reason")
            asked = {
                "tool_name": tool_name if isinstance(tool_name, str) else None,
                "reason": reason if isinstance(reason, str) else None,
            }
            approvals.append(_timeline_entry(
                {"asked": asked, "decided": None}, seq, time, turn, step, call_id, ordinal))
        elif etype == "approval/decided":
            outcome = data.get("outcome")
            decided = {"outcome": outcome} if isinstance(outcome, str) else None
            approvals.append(_timeline_entry(
                {"asked": None, "decided": decided}, seq, time, turn, step, call_id, ordinal))
        elif etype == "sandbox/mode":
            mode = data.get("mode")
            sandbox_modes.append(_timeline_entry(
                {"mode": mode if isinstance(mode, str) else ""}, seq, time, turn, step, call_id, ordinal))
        elif etype == "turn/end":
            if pending is not None:
                reason = data.get("reason")
                reason = reason if isinstance(reason, dict) else {}
                kind = reason.get("kind")
                error = reason.get("error")
                error = error if isinstance(error, dict) else {}
                code = error.get("code")
                pending["end_reason_kind"] = kind if isinstance(kind, str) else None
                pending["end_error_code"] = code if isinstance(code, str) else None
                pending["end_seq"] = seq
                pending["end_time"] = time

    if pending is not None:
        _flush_turn(turns, pending)

    return {
        "tool_calls": {"entries": tool_calls},
        "tool_results": {"entries": tool_results},
        "approvals": {"entries": approvals},
        "sandbox_modes": {"entries": sandbox_modes},
        "turns": {"entries": turns},
    }


def build_dsh_canonical(execution_events, cwd=None, session_id=""):
    """execution_events (+ cwd/session_id) → canonical dict，直接喂给
    `canonical_audit.py::audit_projection`。镜像 Rust
    `dsh_evidence.rs::build_dsh_evidence`（只取它产出 `CanonicalSession` 的那
    部分——覆盖计数/Signal 派生仍由 `util.signal_coverage` 承担，见
    `behavior.py::audit_session_log`，本模块不重新发明第二份覆盖率）。
    """
    timelines = populate_timelines(execution_events)
    # D1–D4：喂进本证据的**执行流**事件的 `time` min/max（DSH 的 time 是毫秒）。
    # 只用 execution_events、不含 usage_events —— 与 Rust 侧口径一致：Rust 的
    # `build_dsh_evidence` 虽收两组事件，跨度也只取执行流，否则两边会对同一份
    # 会话给出不同跨度。0 条事件 → None（不造 (0,0)）。
    native_times = [t for t in (_int_or_none(e.get("time")) for e in execution_events)
                    if t is not None]
    meta = {
        "session_id": session_id,
        "harness_id": "dsh",
        "workspace_roots": [cwd] if cwd else [],
        "model": None,
        "span": session_span(native_times),
    }
    return {"meta": meta, **timelines}
