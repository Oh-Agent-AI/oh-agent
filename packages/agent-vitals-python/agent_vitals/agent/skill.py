"""Skill 执行审计（Skill Execution Audit，backlog T3）—— 把「谁在什么时候被
什么方式触发、加载成功没有、花了多久」从执行事件流里抽出来，产出
`SkillInvocationEvent[]`（`docs/audit-dashboard/SKILL_EXECUTION_BACKLOG.md`
T3 表格 = PRD §9 契约的蒸馏）。单一真相源是
`crates/agent-vitals-domain/src/domain/skill.rs`；这里是 Python 平行实现，两侧逐字节
对齐（差分由 `tests/test_cli_matrix.py` 的 `both()` 看守）。

两种触发方式，落库形态完全不同（`fixtures/dsh/README.md` 实测验证过）：

- explicit（用户 `/<name>` 手势）：`user/message`，
  `data.source.kind == "skill-invocation"`，`data.source.name` 是技能名。
  一次性事件，没有二段式 call/result——`tool-skill/src/index.ts` 只对已验证
  user-invocable 的技能名生效，落库时内容已经原样注入同一条事件里。所以
  `load_status` 对 explicit 恒为 "loaded"：不存在"调用了但没加载"的中间态。
  `duration_ms` 也不是"缺失"，是这类触发没有耗时概念——不进 `missing_fields`。
- model_selected（模型自己选中加载）：`tool/call`（`data.name=="skill"`，
  `arguments` 是原始 JSON 字符串）配 `tool/result`（`data.message.source.callId`
  回连）。照 `subagent.py` 的 callId 配对写：结果没到 ≠ 调用没发生，行照留，
  `load_status` 落 "incomplete"。失败信号分两种——`tool/result` 顶层
  `data.error`（六码基础设施错误：SANDBOX_DENIED/TIMEOUT/…）与
  `data.message.content[].isError`（工具自己报告的语义失败，比如"没这个技能"）。

`turn`/`step` 统一走 `trajectory._coord_map`（边界顺延）而不是各自读事件自带
字段——`tool/call` 通常自带，`user/message` 从不带，两路分开写就是两份逻辑；
`_coord_map` 本来就"自带优先，否则顺延"，合并成一条路径更不容易漂移。
`request_seq` 靠 `(turn, step)` 精确匹配回 `request_metrics` 算出的那一行
（与 `util.find_request` 同一种匹配规则，不是"最近的 seq"）。

纪律（backlog T3）：缺失字段进 `missing_fields`，绝不填默认值/0。真实量级
唯一实测样本：`turn:5 step:3`，call→result 的 Δt = 18ms。
"""
import json

from .trajectory import _coord_map
from ..util import find_request, post_fork


def _skill_call_name(data):
    """`tool/call`（`name=="skill"`）的 `arguments`（原始 JSON 字符串）里解出
    技能名。解析失败给 None——不猜一个名字，宁可少一列。"""
    args = data.get("arguments")
    if not isinstance(args, str):
        return None
    try:
        parsed = json.loads(args)
    except (ValueError, TypeError):
        return None
    name = parsed.get("name") if isinstance(parsed, dict) else None
    return name if isinstance(name, str) else None


def _tool_result_failed(data):
    """`tool/result` 是否报告了失败——两种独立信号都要看，缺一不可：顶层
    `data.error`（六码基础设施错误）与 `data.message.content[].isError`
    （工具自己报告的语义失败）。两者都没有才算成功。"""
    if data.get("error") is not None:
        return True
    message = data.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    if not isinstance(content, list):
        return False
    return any(isinstance(item, dict) and item.get("isError") is True for item in content)


def _coords_for(seq, coord_map):
    """`(turn, step)`——通过 `_coord_map` 顺延求出；`seq` 缺失/畸形给 (None, None)。"""
    if isinstance(seq, int) and not isinstance(seq, bool) and seq in coord_map:
        turn, step, _call_id = coord_map[seq]
        return turn, step
    return None, None


def _request_seq_for(turn, step, requests):
    """按 `(turn, step)` 回 `request_metrics` 找对应请求的 `request_seq`。"""
    if turn is None or step is None:
        return None
    row = find_request(requests, turn, step)
    if row is None:
        return None
    rs = row.get("request_seq")
    return rs if isinstance(rs, int) and not isinstance(rs, bool) else None


def skill_invocations(events, requests):
    """事件流 + 已算好的 `request_metrics` 输出 → `SkillInvocationEvent[]`，
    按 seq 升序。"""
    # 只看分叉之后——同一条纪律，见 subagent.py/usage.py 模块注释。
    events = post_fork(events)
    coord_map = _coord_map(events)
    rows = []

    # ── explicit：user/message 的 skill-invocation 载体 ─────────────────────
    for e in events:
        if not isinstance(e, dict) or e.get("type") != "user/message":
            continue
        data = e.get("data")
        source = data.get("source") if isinstance(data, dict) else None
        if not isinstance(source, dict) or source.get("kind") != "skill-invocation":
            continue
        name = source.get("name")
        if not isinstance(name, str):
            # 没有名字就没法识别是哪个技能——宁可整行不出，也不猜一个名字。
            continue
        seq = e.get("seq")
        turn, step = _coords_for(seq, coord_map)

        missing = []
        if turn is None:
            missing.append("turn")
        if step is None:
            missing.append("step")
        request_seq = _request_seq_for(turn, step, requests)
        if request_seq is None:
            missing.append("request_seq")

        rows.append({
            "name": name,
            "trigger_mode": "explicit",
            "load_status": "loaded",
            "duration_ms": None,
            "seq": seq,
            "time": e.get("time"),
            "turn": turn,
            "step": step,
            "call_id": None,
            "request_seq": request_seq,
            "missing_fields": missing,
        })

    # ── model_selected：tool/call(name="skill") ↔ tool/result(callId) ───────
    order = []
    by_call = {}
    for e in events:
        if not isinstance(e, dict) or e.get("type") != "tool/call":
            continue
        data = e.get("data")
        if not isinstance(data, dict) or data.get("name") != "skill":
            continue
        call_id = data.get("callId")
        if not isinstance(call_id, str):
            continue
        order.append(call_id)
        by_call[call_id] = {
            "name": _skill_call_name(data),
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

    for cid in order:
        call = by_call.pop(cid, None)
        if call is None:
            continue
        turn, step = _coords_for(call["seq"], coord_map)

        missing = []
        if call["name"] is None:
            missing.append("name")
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

        request_seq = _request_seq_for(turn, step, requests)
        if request_seq is None:
            missing.append("request_seq")

        rows.append({
            "name": call["name"],
            "trigger_mode": "model_selected",
            "load_status": load_status,
            "duration_ms": duration_ms,
            "seq": call["seq"],
            "time": call["time"],
            "turn": turn,
            "step": step,
            "call_id": cid,
            "request_seq": request_seq,
            "missing_fields": missing,
        })

    rows.sort(key=lambda r: r["seq"] if isinstance(r["seq"], int) and not isinstance(r["seq"], bool)
              else float("inf"))
    return rows


def skill_invocations_enriched(events, requests, spawns):
    """T6 — 子 Agent 聚合与覆盖率。

    `spawns` 是 `subagent_spawns()` 的输出。返回：
    {
        "enriched": [...SkillInvocationEvent[], agent_id 填充],
        "sessions_discovered": int,
        "sessions_covered": int,   # 实际读取由执行环境侧完成，这里只出占位
        "missing_sessions": [],
        "coverage_by_skill": {},
    }
    """
    invocations = skill_invocations(events, requests)
    # call_id → agent_id
    call_to_agent = {}
    for s in spawns:
        cid = s.get("call_id") if isinstance(s, dict) else None
        aid = s.get("agent_id") if isinstance(s, dict) else None
        if isinstance(cid, str) and isinstance(aid, str):
            call_to_agent[cid] = aid

    enriched = []
    for inv in invocations:
        e = dict(inv)
        if e.get("trigger_mode") == "model_selected":
            cid = e.get("call_id")
            if isinstance(cid, str) and cid in call_to_agent:
                e["agent_id"] = call_to_agent[cid]
            else:
                e["agent_id"] = None
        else:
            e["agent_id"] = None
        enriched.append(e)

    all_agents = {s["agent_id"] for s in spawns if isinstance(s, dict) and isinstance(s.get("agent_id"), str)}
    sessions_discovered = len(all_agents)

    return {
        "enriched": enriched,
        "sessions_discovered": sessions_discovered,
        "sessions_covered": sessions_discovered,  # 实际读取由执行环境完成
        "missing_sessions": [],
        "coverage_by_skill": {},
    }
