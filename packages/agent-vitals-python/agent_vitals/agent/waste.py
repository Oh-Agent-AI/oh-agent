"""FR-04b 结构性浪费识别 —— 回答"哪些是浪费的"与"我该怎么办"。

单一真相源是 `crates/agent-vitals-domain/src/domain/waste.rs`；这里是 Python 平行实现，
差分防护在 core 的 parity 测试与 `tests/test_cli_matrix.py` 的双实现比较。

**结构性浪费**是规则可直接判定、不需要历史基线的浪费模式（PRD FR-04b）；与
"相对浪费"（缓存命中率偏低等，需要基线才能判断）是两回事，混进来会破坏 FR-05
的"无基线不告警"原则。这个模块只做前者。

V2 覆盖两种模式：

1. 重复工具结果：同一个调用（同名 + 同参数）在不同 turn 里反复得到完全相同的
   结果。第一次是必要的工作，后续每一次都是纯浪费——waste_tokens 按
   est_tokens(内容) × (次数 − 1) 计。
2. 失败重试的上下文增量：连续 ≥3 次工具失败之后，上下文实际增长了多少（通过
   request_metrics 前后两次请求的 context_tokens 差值衡量）——这是失败重试
   真正付出的代价，不是次数本身。

一条明确排除的候选：compaction.compaction_events 的 prune。查过真实日志
（session-e4b0be69）的 10 次 prune 具体剪了什么——全部是 turn 3 到 turn 60 里
互不相同的一次性内容，不是重复读取。那是上下文正常老化被清理，不是浪费；把它
标成"结构性浪费"会让用户觉得系统在冤枉自己的正常行为。
"""

from .behavior import _tool_invocation
from ..util import est_tokens, find_next_request, find_request, post_fork

_MIN_REPEAT_TURNS = 2  # 至少跨 2 个不同 turn 才算"重复"，同一 turn 内多次调用不算
_MIN_FAILED_RESULTS = 3  # 与 trajectory.py 的 SV613b 阈值一致（概念对齐，各自独立扫描）


def _extract_target(args_text):
    """从工具参数里挑一个人能看懂的"目标"标签，用于建议文案。纯展示用途，
    取不到不算错误。"""
    import json as _json
    try:
        parsed = _json.loads(args_text)
    except (ValueError, TypeError):
        parsed = None
    if isinstance(parsed, dict):
        for key in ("path", "file_path", "url", "command", "pattern"):
            v = parsed.get(key)
            if isinstance(v, str):
                return v[:60]
    return args_text[:60]


def detect_duplicate_tool_results(events):
    """重复工具结果：同一个 (工具名, 参数) 在 ≥2 个不同 turn 里得到完全相同的结果。

    相关性判定分两层：先按 (tool_name, args) 分组（模型问了同一个问题），再要求
    结果内容也逐字节相同（真的是重复劳动，不是同一请求换了个答案）。只按输出
    内容分组会把"两次都读到空文件"这种巧合也算进来，语义上站不住。

    真实日志（session-e4b0be69）验证：796 个不同 (工具, 内容) 组合，0 组重复——
    这份日志是正经的开发会话，没有病态重复读取。检测器在干净数据上不该报假
    阳性，这条本身就是负向测试。
    """
    calls = {}  # callId -> (tool_name, args_text)
    for event in events:
        if not isinstance(event, dict):
            continue
        inv = _tool_invocation(event)
        if inv is None:
            continue
        name, args = inv
        call_id = (event.get("data") or {}).get("callId")
        if isinstance(call_id, str):
            calls[call_id] = (name, args)

    groups = {}  # (tool_name, args, content_text) -> [(turn, seq, time, step, call_id)]
    for event in events:
        if not isinstance(event, dict) or event.get("type") != "tool/result":
            continue
        data = event.get("data") or {}
        message = data.get("message")
        if not isinstance(message, dict):
            continue
        source = message.get("source")
        call_id = source.get("callId") if isinstance(source, dict) else None
        if not isinstance(call_id, str) or call_id not in calls:
            continue
        name, args = calls[call_id]
        content = message.get("content")
        import json as _json
        content_text = _json.dumps(content, ensure_ascii=False, separators=(",", ":"))
        turn, step = data.get("turn"), data.get("step")
        seq, time = event.get("seq"), event.get("time")
        key = (name, args, content_text)
        groups.setdefault(key, []).append((turn, seq, time, step, call_id))

    out = []
    # dict 迭代顺序在 CPython 里是插入序（与 Rust 的 HashMap 不同），但为了
    # 与 Rust 侧「按第一次出现的 seq 排序」逐字节对齐，这里也显式排序。
    items = sorted(groups.items(), key=lambda kv: (kv[1][0][1] if kv[1][0][1] is not None else float("inf")))

    for (tool_name, args, content_text), occs in items:
        distinct_turns = {o[0] for o in occs if o[0] is not None}
        if len(distinct_turns) < _MIN_REPEAT_TURNS:
            continue
        turn_min, turn_max = min(distinct_turns), max(distinct_turns)
        waste_tokens = est_tokens(content_text) * (len(occs) - 1)
        target = _extract_target(args)
        turn, seq, time, step, call_id = occs[0]

        if turn_min != turn_max:
            evidence = f"{tool_name} 结果在 T{turn_min}–T{turn_max} 内容相同（重复 {len(occs)} 次）"
        else:
            evidence = f"{tool_name} 结果重复出现 {len(occs)} 次，内容相同"

        out.append({
            "rule": "SV-COST-01",
            "severity": "info",
            "category": "cost",
            "tool_name": tool_name,
            "evidence": evidence,
            "seq": seq,
            "time": time,
            "turn": turn,
            "step": step,
            "call_id": call_id or None,
            "evidence_recency": "log",
            "waste_tokens": waste_tokens,
            "suggestion": (
                f"确认是否需要在每个 turn 重新调用「{tool_name}」处理「{target}」；"
                "如果内容不会变化，可以只调用一次并复用结果。"
            ),
        })
    return out


def detect_failure_run_waste(events, requests):
    """失败重试的上下文增量：连续 ≥3 次工具失败之后，上下文实际增长了多少。

    增量是**真正付出的代价**，不是失败次数本身——次数已经由 SV613 报了。这里
    用 request_metrics 里失败发生前后两次请求的 context_tokens 差值衡量：失败
    结果被塞回上下文、模型往复重试，这段增量此后一直占着位置直到被压缩。

    requests 必须是 usage.request_metrics 的输出（同一批 usage_events）；找不到
    匹配的请求行（该 turn/step 没有 usage 样本）时跳过——不拿其他 turn 的数字
    硬凑，AC-08 要求"缺一不得展示"，数据层同一条纪律。
    """
    out = []
    run = []  # [(turn, step, seq, time, code)]

    def flush():
        if len(run) >= _MIN_FAILED_RESULTS:
            f = _emit_failure_waste(run, requests)
            if f is not None:
                out.append(f)
        run.clear()

    for event in events:
        if not isinstance(event, dict) or event.get("type") != "tool/result":
            continue
        data = event.get("data") or {}
        err = data.get("error")
        code = err.get("code") if isinstance(err, dict) else None
        if code:
            turn, step = data.get("turn"), data.get("step")
            seq, time = event.get("seq"), event.get("time")
            if all(isinstance(x, int) and not isinstance(x, bool)
                   for x in (turn, step, seq, time)):
                run.append((turn, step, seq, time, code))
        else:
            flush()
    flush()
    return out


def _emit_failure_waste(run, requests):
    start_turn, start_step, start_seq, start_time, first_code = run[0]
    end_turn = run[-1][0]

    r_start = find_request(requests, start_turn, start_step)
    if r_start is None or not isinstance(r_start.get("request_seq"), int):
        return None
    r_after = find_next_request(requests, r_start["request_seq"])
    if r_after is None:
        return None

    before, after = r_start.get("context_tokens"), r_after.get("context_tokens")
    if not isinstance(before, int) or not isinstance(after, int):
        return None  # 缺分子——诚实跳过，不拿 None 参与算术

    waste_tokens = after - before
    if waste_tokens <= 0:
        return None  # 没有净增长就不是浪费，不倒扣出一个负数

    if end_turn != start_turn:
        evidence = (f"连续 {len(run)} 次工具失败（首个 {first_code}），"
                    f"T{start_turn}–T{end_turn} 期间上下文增长 {waste_tokens} token")
    else:
        evidence = (f"连续 {len(run)} 次工具失败（首个 {first_code}），"
                    f"T{start_turn} 期间上下文增长 {waste_tokens} token")

    return {
        "rule": "SV-COST-02",
        "severity": "info",
        "category": "cost",
        "tool_name": None,
        "evidence": evidence,
        "seq": start_seq,
        "time": start_time,
        "turn": start_turn,
        "step": start_step,
        "call_id": None,
        "evidence_recency": "log",
        "waste_tokens": waste_tokens,
        "suggestion": "检查失败原因（工具参数、权限或环境问题）；重试前先确认根因，避免同一错误被反复携带进后续上下文。",
    }


def detect_structural_waste(events, requests):
    """两个检测器的合集，按 seq 排序追加——与 match_behavior/match_trajectory
    的追加顺序同一条纪律（字节序稳定）。
    """
    # 只看分叉之后的事件——审计回答的是「**这个**会话干了什么」。从上游会话
    # branch 出来时抄进日志的那段历史属于上游自己那份审计，在这里再算一遍就是
    # 对同一笔钱/同一批行为重复计数（见 util.fork_boundary 的实测数据）。
    events = post_fork(events)
    out = detect_duplicate_tool_results(events) + detect_failure_run_waste(events, requests)
    out.sort(key=lambda f: f["seq"] if f["seq"] is not None else float("inf"))
    return out
