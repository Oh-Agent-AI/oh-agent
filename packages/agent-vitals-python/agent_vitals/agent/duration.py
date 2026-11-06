"""执行时长审计（Duration Audit，`docs/audit-dashboard/DURATION_AUDIT_BACKLOG.md`
D1）—— 把 `skill.py` 里"`callId` 配对 `tool/call`↔`tool/result`、算
`duration_ms`"这段逻辑推广到所有工具，不再局限于 `name=="skill"`。单一真相源是
`crates/agent-vitals-domain/src/domain/duration.rs`；这里是 Python 平行实现，两侧逐字节
对齐（`tests/test_characterization.py::TestToolCallDurations` 与 Rust 侧
`duration::tests::python_rust_byte_for_byte_parity` 各钉同一个串）。

与 `skill.py` 的两点不同：
1. 不按工具名过滤——这里要的是"所有工具调用花了多久"，不是某一个工具，所以
   没有 explicit/model_selected 两条路径，只有一条通用的 `tool/call` ↔
   `tool/result` 配对。
2. 不解析 `arguments`——`tool_name` 直接来自 `tool/call.data.name`，不像
   `skill.py` 那样还要从 `arguments` 原始 JSON 字符串里再抠一层技能名。

没有 `callId` 的调用整条跳过——这不是"耗时未知"，是这条数据在结构上就配不了
对；与"有 `callId` 但等不到 `tool/result`"（`duration_ms` 缺失、`load_status`
落 "incomplete"，一起进 `missing_fields`）是两种不同性质的缺失，不能混着处理。

`turn`/`step` 复用 `trajectory._coord_map`（与 `skill.py` 同一份坐标表），不
重新扫一遍 `turn/start`・`step/start` 边界。
"""
from .trajectory import _coord_map
from ..util import post_fork, signal_coverage


def _tool_result_failed(data):
    """`tool/result` 是否报告了失败——同 `skill.py::_tool_result_failed`，两种
    独立信号都要看，缺一不可：顶层 `data.error`（六码基础设施错误）与
    `data.message.content[].isError`（工具自己报告的语义失败）。两者都没有才
    算成功。"""
    if data.get("error") is not None:
        return True
    message = data.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    if not isinstance(content, list):
        return False
    return any(isinstance(item, dict) and item.get("isError") is True for item in content)


def _coords_for(seq, coord_map):
    """`(turn, step)`——通过 `_coord_map` 顺延求出；`seq` 缺失/畸形给
    `(None, None)`。"""
    if isinstance(seq, int) and not isinstance(seq, bool) and seq in coord_map:
        turn, step, _call_id = coord_map[seq]
        return turn, step
    return None, None


def tool_call_durations(events):
    """事件流 → `ToolCallDuration[]`，按 `seq` 升序。所有带 `callId` 的
    `tool/call` 都进来，不按工具名过滤。"""
    # 只看分叉之后——同一条纪律，见 skill.py/subagent.py/usage.py 模块注释。
    events = post_fork(events)
    coord_map = _coord_map(events)

    # 第一遍：记下所有 tool/call（按 callId 索引，保留发生顺序）。
    order = []
    by_call = {}
    for e in events:
        if not isinstance(e, dict) or e.get("type") != "tool/call":
            continue
        data = e.get("data")
        if not isinstance(data, dict):
            continue
        call_id = data.get("callId")
        if not isinstance(call_id, str):
            # 没有 callId 就没法配对——结构上就配不了对，整条跳过，不是
            # "耗时未知"（那是有 callId 但等不到结果的 incomplete 状态）。
            continue
        name = data.get("name")
        order.append(call_id)
        by_call[call_id] = {
            "tool_name": name if isinstance(name, str) else None,
            "seq": e.get("seq"),
            "time": e.get("time"),
            "has_result": False,
            "result_time": None,
            "failed": False,
        }
    # 第二遍：把回执配对回去——结果没到 ≠ 这次调用没发生，见模块注释。
    for e in events:
        if not isinstance(e, dict) or e.get("type") != "tool/result":
            continue
        data = e.get("data")
        if not isinstance(data, dict):
            continue
        message = data.get("message")
        source = message.get("source") if isinstance(message, dict) else None
        cid = source.get("callId") if isinstance(source, dict) else None
        call = by_call.get(cid)
        if call is None:
            continue
        call["has_result"] = True
        call["result_time"] = e.get("time")
        call["failed"] = _tool_result_failed(data)

    rows = []
    for cid in order:
        call = by_call.pop(cid, None)
        if call is None:
            continue
        turn, step = _coords_for(call["seq"], coord_map)

        missing = []
        if call["tool_name"] is None:
            missing.append("tool_name")
        if turn is None:
            missing.append("turn")
        if step is None:
            missing.append("step")

        if not call["has_result"]:
            load_status = "incomplete"
        elif call["failed"]:
            load_status = "failed"
        else:
            load_status = "loaded"

        duration_ms = None
        if call["has_result"]:
            call_time, result_time = call["time"], call["result_time"]
            if (isinstance(call_time, int) and not isinstance(call_time, bool)
                    and isinstance(result_time, int) and not isinstance(result_time, bool)):
                duration_ms = result_time - call_time
        if duration_ms is None:
            missing.append("duration_ms")

        rows.append({
            "call_id": cid,
            "tool_name": call["tool_name"],
            "load_status": load_status,
            "duration_ms": duration_ms,
            "seq": call["seq"],
            "turn": turn,
            "step": step,
            "missing_fields": missing,
        })

    rows.sort(key=lambda r: r["seq"] if isinstance(r["seq"], int) and not isinstance(r["seq"], bool)
              else float("inf"))
    return rows


def _int_or_none(v):
    return v if isinstance(v, int) and not isinstance(v, bool) else None


def _ended_reason(data):
    """`turn/end.data.reason.kind`（"completed"/"error"）。缺失给 None——不是
    "正常结束"的默认值，是没有这个字段。"""
    reason = data.get("reason") if isinstance(data, dict) else None
    kind = reason.get("kind") if isinstance(reason, dict) else None
    return kind if isinstance(kind, str) else None


def turn_durations(events):
    """`turn/start` ↔ `turn/end`，按 `data.turn` 配对 → `TurnDuration[]`，按
    turn 升序。只有 start 没有 end（会话在这个 turn 中途结束/被截断）→
    `duration_ms: None`，`load_status` 标 "incomplete"——不是"这个 turn 没有
    发生"，行照留。"""
    events = post_fork(events)

    order = []
    by_turn = {}
    for e in events:
        if not isinstance(e, dict) or e.get("type") != "turn/start":
            continue
        data = e.get("data")
        turn = data.get("turn") if isinstance(data, dict) else None
        turn = _int_or_none(turn)
        if turn is None:
            continue
        order.append(turn)
        by_turn[turn] = {
            "seq_start": e.get("seq"), "time_start": e.get("time"),
            "has_end": False, "seq_end": None, "time_end": None, "ended_reason": None,
        }
    for e in events:
        if not isinstance(e, dict) or e.get("type") != "turn/end":
            continue
        data = e.get("data")
        turn = _int_or_none(data.get("turn") if isinstance(data, dict) else None)
        if turn is None or turn not in by_turn:
            continue
        pending = by_turn[turn]
        pending["has_end"] = True
        pending["seq_end"] = e.get("seq")
        pending["time_end"] = e.get("time")
        pending["ended_reason"] = _ended_reason(data)

    rows = []
    for turn in order:
        p = by_turn.pop(turn, None)
        if p is None:
            continue
        missing = []
        duration_ms = None
        if p["has_end"]:
            t0, t1 = _int_or_none(p["time_start"]), _int_or_none(p["time_end"])
            if t0 is not None and t1 is not None:
                duration_ms = t1 - t0
        if duration_ms is None:
            missing.append("duration_ms")
        if p["ended_reason"] is None:
            missing.append("ended_reason")

        rows.append({
            "turn": turn,
            "duration_ms": duration_ms,
            "seq_start": p["seq_start"],
            "seq_end": p["seq_end"],
            "ended_reason": p["ended_reason"],
            "load_status": "loaded" if p["has_end"] else "incomplete",
            "missing_fields": missing,
        })

    rows.sort(key=lambda r: r["turn"])
    return rows


def step_durations(events):
    """`step/start` ↔ `step/end`，按 `(turn, step)` 配对 → `StepDuration[]`，
    按 `(turn, step)` 升序。同 `turn_durations`：只有 start 没有 end →
    "incomplete"。"""
    events = post_fork(events)

    order = []
    by_step = {}
    for e in events:
        if not isinstance(e, dict) or e.get("type") != "step/start":
            continue
        data = e.get("data")
        turn = _int_or_none(data.get("turn") if isinstance(data, dict) else None)
        step = _int_or_none(data.get("step") if isinstance(data, dict) else None)
        if turn is None or step is None:
            continue
        key = (turn, step)
        order.append(key)
        by_step[key] = {
            "seq_start": e.get("seq"), "time_start": e.get("time"),
            "has_end": False, "seq_end": None, "time_end": None,
        }
    for e in events:
        if not isinstance(e, dict) or e.get("type") != "step/end":
            continue
        data = e.get("data")
        turn = _int_or_none(data.get("turn") if isinstance(data, dict) else None)
        step = _int_or_none(data.get("step") if isinstance(data, dict) else None)
        key = (turn, step)
        if turn is None or step is None or key not in by_step:
            continue
        pending = by_step[key]
        pending["has_end"] = True
        pending["seq_end"] = e.get("seq")
        pending["time_end"] = e.get("time")

    rows = []
    for key in order:
        p = by_step.pop(key, None)
        if p is None:
            continue
        turn, step = key
        missing = []
        duration_ms = None
        if p["has_end"]:
            t0, t1 = _int_or_none(p["time_start"]), _int_or_none(p["time_end"])
            if t0 is not None and t1 is not None:
                duration_ms = t1 - t0
        if duration_ms is None:
            missing.append("duration_ms")

        rows.append({
            "turn": turn,
            "step": step,
            "duration_ms": duration_ms,
            "seq_start": p["seq_start"],
            "seq_end": p["seq_end"],
            "load_status": "loaded" if p["has_end"] else "incomplete",
            "missing_fields": missing,
        })

    rows.sort(key=lambda r: (r["turn"], r["step"]))
    return rows


def approval_latencies(events):
    """`approval/asked` ↔ `approval/decided`，按事件的 **`id`** 配对——**不是**
    `callId`（`approval/asked.data.callId` 是可选字段；按它配对会把大量审批
    错误地标成"孤立"或配对到错误的调用上，`fixtures/dsh/README.md` 已经踩过
    这个坑）→ `ApprovalLatency[]`，按 seq 升序。

    只有 `asked` 没有 `decided`（人一直没处理，或会话在等待中结束）→
    `wait_ms: None`，`status` 落 "pending"——这是与 "incomplete" 不同的第三种
    状态："incomplete" 暗示"本该有结果但配对失败"，"pending" 是"确实还没
    决定"，两者对用户的含义不同。"""
    events = post_fork(events)
    coord_map = _coord_map(events)

    order = []
    by_id = {}
    for e in events:
        if not isinstance(e, dict) or e.get("type") != "approval/asked":
            continue
        data = e.get("data")
        if not isinstance(data, dict):
            continue
        aid = data.get("id")
        if not isinstance(aid, str):
            continue
        seq = e.get("seq")
        turn, step = _coords_for(seq, coord_map)
        tool_name = data.get("toolName")
        order.append(aid)
        by_id[aid] = {
            "tool_name": tool_name if isinstance(tool_name, str) else None,
            "turn": turn, "step": step, "seq": seq, "time": e.get("time"),
            "has_decided": False, "decided_time": None, "outcome": None,
        }
    for e in events:
        if not isinstance(e, dict) or e.get("type") != "approval/decided":
            continue
        data = e.get("data")
        if not isinstance(data, dict):
            continue
        aid = data.get("id")
        if not isinstance(aid, str) or aid not in by_id:
            continue
        pending = by_id[aid]
        pending["has_decided"] = True
        pending["decided_time"] = e.get("time")
        outcome = data.get("outcome")
        pending["outcome"] = outcome if isinstance(outcome, str) else None

    rows = []
    for aid in order:
        p = by_id.pop(aid, None)
        if p is None:
            continue
        missing = []
        if p["tool_name"] is None:
            missing.append("tool_name")
        if p["turn"] is None:
            missing.append("turn")
        if p["step"] is None:
            missing.append("step")

        wait_ms = None
        if p["has_decided"]:
            t0, t1 = _int_or_none(p["time"]), _int_or_none(p["decided_time"])
            if t0 is not None and t1 is not None:
                wait_ms = t1 - t0
        if wait_ms is None:
            missing.append("wait_ms")
        if p["has_decided"] and p["outcome"] is None:
            missing.append("outcome")

        rows.append({
            "id": aid,
            "tool_name": p["tool_name"],
            "wait_ms": wait_ms,
            "outcome": p["outcome"],
            "status": "decided" if p["has_decided"] else "pending",
            "turn": p["turn"],
            "step": p["step"],
            "seq": p["seq"],
            "missing_fields": missing,
        })

    rows.sort(key=lambda r: r["seq"] if isinstance(r["seq"], int) and not isinstance(r["seq"], bool)
              else float("inf"))
    return rows


def hook_executions(events):
    """hook/result 抽取（D4）——`durationMs` 是 harness 自己算好写进日志的，
    不需要跟 hook/invoked 配对去减两次时间戳：`durationMs` 已经是排队+执行
    的总时长，`hook/invoked.time` 到 `hook/result.time` 的墙钟差是另一个数字
    （两者含义不同，混用会把"harness 自报的执行耗时"偷换成"两条日志间隔"）。
    所以 hook/invoked 完全不用读——hook/result 自己就带了 handlerId/point/
    decision/durationMs 这些字段。

    顺带给出 decision（pass/deny/其它）的分布计数。

    ⚠️ D4 的执行环境前提尚未验证：`integrations/dsh-client/src/harness/index.ts` 的
    `RELEVANT_TYPES` 目前没有收 hook/*（见 DURATION_AUDIT_BACKLOG.md D4）。
    这个函数在 CLI 侧立即可用；执行环境投影（D6）故意不把 hook/* 加进
    `RELEVANT_TYPES`，直到有人拿真实会话实测过。"""
    events = post_fork(events)
    coord_map = _coord_map(events)

    rows = []
    decision_counts = {}

    for e in events:
        if not isinstance(e, dict) or e.get("type") != "hook/result":
            continue
        data = e.get("data")
        if not isinstance(data, dict):
            continue
        handler_id = data.get("handlerId")
        if not isinstance(handler_id, str):
            continue

        seq = e.get("seq")
        turn, _step = _coords_for(seq, coord_map)

        point = data.get("point")
        point = point if isinstance(point, str) else None
        decision = data.get("decision")
        decision = decision if isinstance(decision, str) else None
        duration_ms = _int_or_none(data.get("durationMs"))

        missing = []
        if point is None:
            missing.append("point")
        if decision is None:
            missing.append("decision")
        if duration_ms is None:
            missing.append("duration_ms")
        if turn is None:
            missing.append("turn")

        decision_key = decision if decision is not None else "missing"
        decision_counts[decision_key] = decision_counts.get(decision_key, 0) + 1

        rows.append({
            "handler_id": handler_id,
            "point": point,
            "decision": decision,
            "duration_ms": duration_ms,
            "turn": turn,
            "seq": seq,
            "missing_fields": missing,
        })

    rows.sort(key=lambda r: r["seq"] if isinstance(r["seq"], int) and not isinstance(r["seq"], bool)
              else float("inf"))
    # dict 按 key 字典序排——序列化要与 Rust 的 BTreeMap 输出一致，
    # byte-for-byte 差分测试才能钉住一个确定的字符串。
    return {
        "executions": rows,
        "decision_counts": dict(sorted(decision_counts.items())),
    }


# P3 group③（docs/RUNTIME_EVIDENCE_CONTRACT.md §17，duration）：五路各自
# 依赖的信号。与 Rust `duration.rs::duration_coverage` 逐字节对齐。
_DURATION_SIGNALS = {
    "tool_calls": "ToolCalls", "turns": "TurnBoundaries", "steps": "StepBoundaries",
    "approvals": "ApprovalDecisions", "hooks": "Hooks",
}


def duration_coverage(duration, events):
    """五路执行时长审计各自的信号覆盖——空数组现在能分清是"这份日志没有
    这类事件"（unavailable）还是"有这类事件但配不成对"（measured_zero）。
    只加不改，五个函数各自的配对逻辑完全没变。`events` 必须是**分叉之后**
    的（调用方负责先 `post_fork`），与 `rule_outcomes` 同一个理由。
    """
    coverage = signal_coverage(events)
    out = {}
    for key, signal in _DURATION_SIGNALS.items():
        if coverage.get(signal, 0) == 0:
            out[key] = {
                "status": "unavailable",
                "missing": [signal],
                "reason": "no evidence for required signal(s) in this session",
            }
            continue
        # hooks 是嵌套形状 {"executions": [...], "decision_counts": {...}}，
        # 其余四路是裸数组。
        records = duration[key]["executions"] if key == "hooks" else duration[key]
        out[key] = ({"status": "measured", "count": len(records)} if records
                    else {"status": "measured_zero"})
    return out
