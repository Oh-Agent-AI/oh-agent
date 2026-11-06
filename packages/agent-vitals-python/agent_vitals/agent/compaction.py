"""上下文压缩事件 —— 时间线的 ✂ 标记，以及 FR-04b 结构性浪费的**实测**来源。

单一真相源是 `crates/agent-vitals-domain/src/domain/compaction.rs`；这里是 Python 平行
实现，差分防护在 core 的 parity 测试与 `tests/test_cli_matrix.py` 的双实现比较。

真实日志（session-e4b0be69）里是**两种不同机制**，不能混成一个概念：

    compaction/start · end   {compactionId, turn}                     一次完整压缩的起止
    compaction/summary       {compactionId, summary}                  压缩产出的摘要正文
    compaction/prune         {shadowedRange, shadowedSeqs,
                              shadowedTokenCount}                     增量剪除被遮蔽的内容

`prune` 是最有价值的一条：`shadowedTokenCount` 是**执行环境自己算出来的被丢弃 token
数**——不是我们的 est_tokens 估算，是 harness 的测量值。FR-04b 要回答「哪些是
浪费的」，与其自己写重复内容检测器再估算量级，不如直接用这个实测值。两者
provenance 不同，展示层必须分开标注（context_composition 那边是估算）。

实测形态：10 次 prune 全部落在 turn 85（同一次爆发），合计 33,099 token；而
turn 85 正是上下文峰值所在（799,841 / 1,000,000 = 80.0%）。完整压缩发生在两个
turn 之后的 turn 87。这条因果链是时间线要讲的故事，所以 turn 必须给准。
"""

from ..util import post_fork
from .behavior import Coords


def compaction_events(events):
    """事件流 → 压缩事件的结构化视图。Rust 平行实现见 `compaction.rs`。

    `pruned_tokens_total` **只累加真正上报了 shadowedTokenCount 的那些**，没上报
    的计入 `prunes_without_token_count` 单独暴露——与 unreported_fields 同一条
    纪律：缺口要看得见，但不能让一条畸形事件把整个有用的数字毁掉（那样就从
    「部分已知」退化成「完全未知」，反而更差）。

    turn：compaction/start · end 自带；prune 不带，从 turn/start 顺延（与 finding
    坐标同一套 Coords 语义，turn 外为 None）。
    """
    # 只看分叉之后的事件——审计回答的是「**这个**会话干了什么」。从上游会话
    # branch 出来时抄进日志的那段历史属于上游自己那份审计，在这里再算一遍就是
    # 对同一笔钱/同一批行为重复计数（见 util.fork_boundary 的实测数据）。
    events = post_fork(events)
    compactions = []
    prunes = []
    pruned_total = 0
    missing_count = 0
    coords = Coords()

    for event in events:
        if not isinstance(event, dict):
            continue
        coords.observe(event)
        etype = event.get("type")
        if not isinstance(etype, str) or not etype.startswith("compaction/"):
            continue
        data = event.get("data")
        data = data if isinstance(data, dict) else {}
        seq = event.get("seq")
        seq = seq if isinstance(seq, int) and not isinstance(seq, bool) else None
        time = event.get("time")
        time = time if isinstance(time, int) and not isinstance(time, bool) else None
        turn, _step, _call_id = coords.resolve(event)
        cid = data.get("compactionId")
        cid = cid if isinstance(cid, str) else None

        if etype == "compaction/prune":
            count = data.get("shadowedTokenCount")
            count = count if isinstance(count, int) and not isinstance(count, bool) else None
            if count is None:
                missing_count += 1
            else:
                pruned_total += count
            seqs = data.get("shadowedSeqs")
            seq_count = len(seqs) if isinstance(seqs, list) else None
            prunes.append({
                "seq": seq,
                "time": time,
                "turn": turn,
                # 执行环境上报的实测值（不是 est_tokens 估算）；缺则 None。
                "shadowed_token_count": count,
                "shadowed_seq_count": seq_count,
            })
        elif etype == "compaction/start":
            compactions.append({
                "compaction_id": cid,
                "start_seq": seq,
                "start_time": time,
                "turn": turn,
                "end_seq": None,
                "has_summary": False,
            })
        elif etype in ("compaction/summary", "compaction/end"):
            # 按 compactionId 回填到对应的 start 上；找不到（只有 end 没有 start，
            # 例如日志被截断）就不硬造一条——宁缺勿造。
            target = None
            if cid is not None:
                for c in reversed(compactions):
                    if c["compaction_id"] == cid:
                        target = c
                        break
            if target is not None:
                if etype == "compaction/end":
                    target["end_seq"] = seq
                else:
                    target["has_summary"] = True

    return {
        "compactions": compactions,
        "prunes": prunes,
        "pruned_tokens_total": pruned_total,
        "prunes_without_token_count": missing_count,
    }
