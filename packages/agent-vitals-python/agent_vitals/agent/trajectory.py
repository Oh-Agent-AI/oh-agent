"""轨迹级检测器 —— 跨事件/序列级的高危模式（SV611–614）。

与 behavior.py（SV601–610 单事件静态匹配）是两层审计：这里的四个检测器看窗口、
计数、连续段，捕捉「单条事件看不出来」的轨迹症状：

    SV611 重复工具调用 —— 连续相同 (name, arguments) 签名 ≥3 次
    SV612 死循环 —— 连续两个动作序列相同的 turn
    SV613 进度停滞 —— 连续 error turn / 连续工具失败
    SV614 权限异常 —— 同一调用反复审批 / 连续拒绝 / 危险模式反复授予

findings 复用 8 键结构，由消费端追加在 `match_behavior` 之后（字节序稳定）。
单一真相源是 `crates/agent-vitals-domain/src/domain/trajectory.rs`；parity 测试与
`tests/test_cli_matrix.py` 的 both() 差分逐字节看守。

阈值常量选值避开 `fixtures/dsh/behavior.jsonl`（无重复调用、≤2 审批、≤1 超时、
无连续 error turn），让「全部规则都命中」的 fixture 保持干净。harness 侧证实：
`turn/end.reason.kind` 是唯一 LLM 失败信号、`step/end` 是完成心跳、`repeat-tool-
reminder` guard 只存内存（事后审计必须自己重算）——这些都直接落到下面的语义里。
"""

from .behavior import Coords, _int_or_none, _normalize, _tool_invocation

# ── 阈值常量（与 Rust core 逐字节一致）────────────────────────────────────
MIN_REPEAT = 3
MIN_LOOP_TURNS = 2
MIN_ERROR_TURNS = 2
MIN_FAILED_RESULTS = 3
MIN_SAME_CALL_APPROVALS = 3
MIN_CONSECUTIVE_REJECTIONS = 3
MIN_DANGER_GRANTS = 2


def _finding(rule, severity, category, tool, evidence, seq, time, run_end_seq):
    """一条轨迹 finding，与 match_behavior 的 finding 同构（12 键、键序一致，
    `tests/test_characterization.py::test_trajectory_findings_share_the_same_
    key_order` 逐字节看守）。

    turn/step/call_id 先以 None 占位，由 `_fill_coords` 按 seq 回填——占位保证
    键序与 match_behavior 完全一致（后插键会排到末尾，两类 finding 就不同构了）。

    `run_end_seq`（G2，GOVERNANCE_BACKLOG.md）：`seq` 只是判定命中那一刻的
    锚点，本身推不出这段异常在事件流里烧到哪个 seq 才算完——`[seq,
    run_end_seq]` 才是可以拿去跟 dsh-client 的 request_metrics 对齐、算"这段
    烧了多少钱"的真实区间。只有 SV611/612/613 填真实值；SV614（计数类判定，
    不是区间类）置 None——不臆造一个不存在的区间。SV612 只覆盖判定命中的那个
    turn，不回溯被复制的上一个 turn——见 Rust 侧 `trajectory.rs::finding` 的
    同一处注释，这是同一个设计取舍，不是两边各自决定的。
    """
    return {
        "rule": rule,
        "severity": severity,
        "category": category,
        "tool_name": tool,  # None → JSON null（SV611 之外的工具置 None，诚实）
        "evidence": _normalize(evidence),
        "seq": seq,
        "time": time,
        "turn": None,
        "step": None,
        "call_id": None,
        "evidence_recency": "log",
        "run_end_seq": run_end_seq,
    }


def _coord_map(events):
    """seq → (turn, step, call_id)。Rust 平行实现见 `trajectory.rs` 的 `coord_map`。

    轨迹检测器只把**锚点事件的 seq** 记进 finding、不持有事件本身，所以坐标在
    检测跑完后按 seq 回填——比给四个检测器各加一路坐标透传小得多，且与
    match_behavior 用的是同一套 Coords 语义（自带优先、turn 外为 None）。
    """
    coords = Coords()
    out = {}
    for event in events:
        if not isinstance(event, dict):
            continue
        coords.observe(event)
        seq = event.get("seq")
        if isinstance(seq, int) and not isinstance(seq, bool):
            out[seq] = coords.resolve(event)
    return out


def _fill_coords(findings, coord_map):
    """按 finding 自己的 seq 回填坐标。查不到（锚点 seq 缺失/畸形）保持 None。"""
    for f in findings:
        seq = f.get("seq")
        if not isinstance(seq, int) or isinstance(seq, bool):
            continue
        hit = coord_map.get(seq)
        if hit is None:
            continue
        f["turn"], f["step"], f["call_id"] = hit


def match_trajectory(events):
    """事件序列 → 轨迹 findings（SV611–614），按码序追加。"""
    findings = []
    findings.extend(_detect_repeated(events))
    findings.extend(_detect_loop(events))
    findings.extend(_detect_stall(events))
    findings.extend(_detect_permission(events))
    _fill_coords(findings, _coord_map(events))
    return findings


def _detect_repeated(events):
    """SV611：连续相同 (name, arguments) 签名 ≥3 次。

    对齐 harness repeat-tool-reminder 的连续语义（同一个调用紧挨着又来一遍才是
    「重复」）。每次越过 MIN_REPEAT 的倍数报一条（run 为 6 时报 ×3 和 ×6）。
    """
    out = []
    prev = None  # (name, args) 签名
    count = 0
    anchor = None  # (name, seq, time)
    for event in events:
        if not isinstance(event, dict):
            continue
        inv = _tool_invocation(event)
        if inv is None:
            continue
        name, args = inv
        sig = (name, args)
        if prev == sig:
            count += 1
        else:
            prev = sig
            count = 1
            anchor = (name, _int_or_none(event.get("seq")), _int_or_none(event.get("time")))
        if count >= MIN_REPEAT and count % MIN_REPEAT == 0:
            if anchor is not None:
                aname, seq, time = anchor
                # G2：本次达标窗口的终点就是让 count 越过阈值倍数的这个事件；
                # 窗口是累计的（anchor 始终是 run 起点），run 到 6 时再报一次，
                # 覆盖的区间会比到 3 时那次更宽——如实反映"到目前为止一共烧了
                # 多少"，不是"最近 3 次"这个更窄的窗口。
                out.append(_finding("SV611", "warning", "trajectory", aname,
                                    f"{aname} 连续重复 {count} 次", seq, time,
                                    _int_or_none(event.get("seq"))))
    return out


def _detect_loop(events):
    """SV612：连续两个「动作序列相同」的 turn。

    turn 签名 = 该 turn 内 tool/call 的 (name, arguments) 有序列表，按 turn/start
    边界分组；空 turn 跳过。同一段连续相同 turn 只报一次。
    """
    out = []
    turns = []  # (turn, sigs, seq, time, 该 turn 目前观察到的最后 seq)
    current = None
    for event in events:
        if not isinstance(event, dict):
            continue
        if event.get("type") == "turn/start":
            if current is not None:
                turns.append(current)
            data = event.get("data") or {}
            seq = _int_or_none(event.get("seq"))
            current = [data.get("turn"), [], seq, _int_or_none(event.get("time")), seq]
            continue
        # turn 内任何事件都推进「目前观察到的最后 seq」——不止工具调用：G2 的
        # run_end_seq 要覆盖这个 turn 实际占到的位置，只用最后一次工具调用的
        # seq 会把区间掐得偏短。
        if current is not None:
            es = event.get("seq")
            if isinstance(es, int) and not isinstance(es, bool):
                current[4] = es
        inv = _tool_invocation(event)
        if inv is not None and current is not None:
            current[1].append(inv)
    if current is not None:
        turns.append(current)

    prev_sig = None
    run_count = 0
    for turn, sigs, seq, time, last_seq in turns:
        if not sigs:
            continue
        if prev_sig == sigs:
            run_count += 1
        else:
            prev_sig = list(sigs)
            run_count = 1
        # 只在 run 长度恰好到达阈值时报一次（run 更长不重报，run 中断后新序列重新数）
        if run_count == MIN_LOOP_TURNS:
            # G2：只覆盖判定命中的这个 turn（seq 锚定的那个），不含被复制的
            # 上一个 turn——见 `_finding` 文档注释的设计取舍。
            out.append(_finding("SV612", "warning", "trajectory", None,
                                f"死循环: turn {turn} 与上一 turn 动作序列相同", seq, time,
                                last_seq))
    return out


def _detect_stall(events):
    """SV613：进度停滞。(a) 连续 error turn ≥2；(b) 连续带 error.code 的
    tool/result ≥3。各自只在同类事件上跑 run；**run 在「断掉」（一个成功/无关
    事件）或流结束时关闭，报 run 的真实总长度**（真实 run 5 个失败就报 5，不报
    阈值倍数 3）——锚点仍是 run 起点。与 Rust core 逐字节一致。"""
    out = []

    # (a) 连续 turn/end 以 reason.kind == "error" 结束
    # `last_seq`（G2）是 run 里最后一个事件的 seq——与 anchor 的起点 seq 一起
    # 构成 [seq, run_end_seq] 这段停滞真实覆盖的区间。
    def _flush_error_run(run, anchor, last_seq):
        if run >= MIN_ERROR_TURNS and anchor is not None:
            seq, time, code = anchor
            suffix = f"（{code}）" if code else ""
            out.append(_finding("SV613", "warning", "trajectory", None,
                                f"进度停滞: 连续 {run} 个 turn 以 error 结束{suffix}", seq, time,
                                last_seq))
        return 0, None, None

    err_run = 0
    err_anchor = None
    err_last = None
    for event in events:
        if not isinstance(event, dict):
            continue
        if event.get("type") != "turn/end":
            continue
        data = event.get("data") or {}
        kind = (data.get("reason") or {}).get("kind")
        if kind == "error":
            if err_run == 0:
                code = ((data.get("reason") or {}).get("error") or {}).get("code") or ""
                err_anchor = (_int_or_none(event.get("seq")), _int_or_none(event.get("time")), code)
            err_run += 1
            err_last = _int_or_none(event.get("seq"))
        else:
            err_run, err_anchor, err_last = _flush_error_run(err_run, err_anchor, err_last)
    _flush_error_run(err_run, err_anchor, err_last)

    # (b) 连续 tool/result 带 error.code
    def _flush_fail_run(run, anchor, last_seq):
        if run >= MIN_FAILED_RESULTS and anchor is not None:
            seq, time, first_code = anchor
            out.append(_finding("SV613", "warning", "trajectory", None,
                                f"进度停滞: 连续 {run} 个工具失败（首个 {first_code}）", seq, time,
                                last_seq))
        return 0, None, None

    fail_run = 0
    fail_anchor = None
    fail_last = None
    for event in events:
        if not isinstance(event, dict):
            continue
        if event.get("type") != "tool/result":
            continue
        data = event.get("data") or {}
        err = data.get("error")
        code = err.get("code") if isinstance(err, dict) else None
        if code is not None:
            if fail_run == 0:
                fail_anchor = (_int_or_none(event.get("seq")), _int_or_none(event.get("time")), code)
            fail_run += 1
            fail_last = _int_or_none(event.get("seq"))
        else:
            fail_run, fail_anchor, fail_last = _flush_fail_run(fail_run, fail_anchor, fail_last)
    _flush_fail_run(fail_run, fail_anchor, fail_last)
    return out


def _detect_permission(events):
    """SV614：权限异常。(a) 同一 callId 审批 ≥3；(b) 连续 rejected ≥3；
    (c) danger-full-access ≥2 次。"""
    out = []

    # (a) 同一 callId 审批次数（callId 排序保证确定性，对齐 Rust 的 sort_by）
    by_call = {}
    for event in events:
        if not isinstance(event, dict):
            continue
        if event.get("type") != "approval/asked":
            continue
        data = event.get("data") or {}
        call_id = data.get("callId")
        if not isinstance(call_id, str):
            continue
        if call_id not in by_call:
            by_call[call_id] = [0, _int_or_none(event.get("seq")), _int_or_none(event.get("time"))]
        by_call[call_id][0] += 1
    for call_id in sorted(by_call):
        count, seq, time = by_call[call_id]
        if count >= MIN_SAME_CALL_APPROVALS:
            # G2：计数类判定，没有"从哪烧到哪"的区间概念——诚实置 None。
            out.append(_finding("SV614", "warning", "approval", None,
                                f"权限异常: 同一调用 {call_id} 请求审批 {count} 次", seq, time,
                                None))

    # (b) 连续 rejected
    rej_run = 0
    anchor = None
    for event in events:
        if not isinstance(event, dict):
            continue
        if event.get("type") != "approval/decided":
            continue
        data = event.get("data") or {}
        if data.get("outcome") == "rejected":
            if rej_run == 0:
                anchor = (_int_or_none(event.get("seq")), _int_or_none(event.get("time")))
            rej_run += 1
            if rej_run >= MIN_CONSECUTIVE_REJECTIONS and rej_run % MIN_CONSECUTIVE_REJECTIONS == 0:
                if anchor is not None:
                    seq, time = anchor
                    out.append(_finding("SV614", "warning", "approval", None,
                                        f"权限异常: 连续 {rej_run} 次审批被拒", seq, time,
                                        None))
        else:
            rej_run = 0
            anchor = None

    # (c) danger-full-access 出现次数
    danger = 0
    dseq = dtime = None
    for event in events:
        if not isinstance(event, dict):
            continue
        if event.get("type") != "sandbox/mode":
            continue
        data = event.get("data") or {}
        if data.get("mode") == "danger-full-access":
            if danger == 0:
                dseq = _int_or_none(event.get("seq"))
                dtime = _int_or_none(event.get("time"))
            danger += 1
    if danger >= MIN_DANGER_GRANTS:
        out.append(_finding("SV614", "warning", "approval", None,
                            f"权限异常: 危险模式 danger-full-access 授予 {danger} 次",
                            dseq, dtime, None))
    return out
