"""子代理启动事件 —— 从父会话的事件流里提取「什么时候派了谁去干什么」。

单一真相源是 `crates/agent-vitals-domain/src/domain/subagent.rs`；这里是 Python 平行
实现，两侧逐字节对齐（差分由 `tests/test_cli_matrix.py` 的 `both()` 看守）。

为什么是一层独立提取而不是一条规则：启动子代理**不是异常**，不该产生 finding。
但它是时间线上真正的关键事件（一个 turn 里派出去的活会在别处烧掉真金白银），
而且它是把父会话与子会话连起来的**唯一权威链路**。

权威链路为什么在父会话这边：子会话头里的 `parentSession` **不可靠**。真实数据
里 e4b0be69 有 19 次 subagent 调用，但只有 5 个子会话的 `parentSession` 指向
它——另外 14 次是从上游会话 branch 时抄进日志的历史（见 util.fork_boundary），
那些子会话记的是更早那个祖先。反过来，父日志里的 `tool/call name=subagent` →
`tool/result` 文本 `started subagent <uuid>` 是这次调用当场的产物，配上
post_fork 过滤，数出来的 5 个与 DSH 自己 UI 显示的 5 个逐个吻合（连 token 数
都对得上：4.3M / 1.9M / 5.2M / 4M / 262K）。

结果没到 ≠ 这次启动不存在：`agent_id` 为 None 表示「调用发生了，但回执还没写进
日志」。这一行仍然保留——丢掉它等于说这次派活没发生过。
"""
import json

from ..util import post_fork

_MARK = "started subagent "
_HEX = set("0123456789abcdefABCDEF-")


def _agent_id_in(text):
    """从回执文本里抠出 `started subagent <uuid>` 的 id；抠不全就返回 None。

    不用正则：只需定位一个固定前缀后面的 UUID 形状，手写扫描与 Rust 侧逐行
    对得上，也不给 core 引一个 regex 依赖。
    """
    at = text.find(_MARK)
    if at < 0:
        return None
    rest = text[at + len(_MARK):]
    out = []
    for ch in rest:
        if ch not in _HEX:
            break
        out.append(ch)
    got = "".join(out)
    # UUID 是 36 字符（8-4-4-4-12）。长度不对就是没匹配上，不返回半个 id。
    return got if len(got) == 36 else None


def _collect_text(v, out):
    """把一个事件里所有字符串叶子拼起来——回执文本埋在
    `data.message.content[].content[].text` 里，逐层取太脆（DSH 的形状变过）。"""
    if isinstance(v, str):
        out.append(v)
    elif isinstance(v, list):
        for x in v:
            _collect_text(x, out)
    elif isinstance(v, dict):
        for x in v.values():
            _collect_text(x, out)


def subagent_spawns(events):
    """子代理启动列表，按发生顺序。每行：
    `{seq, time, turn, step, call_id, agent_id, description}`。"""
    # 只看分叉之后——分叉前那些是上游会话派的活，属于上游自己那份审计。
    events = post_fork(events)

    order = []
    rows = {}
    for e in events:
        if e.get("type") != "tool/call":
            continue
        data = e.get("data")
        if not isinstance(data, dict) or data.get("name") != "subagent":
            continue
        call_id = data.get("callId")
        if not isinstance(call_id, str):
            continue
        # description 在 arguments 里（原始 JSON 字符串）。解析不出来给 None，
        # 不猜一个标题——宁可少一列，不编一个。
        description = None
        args = data.get("arguments")
        if isinstance(args, str):
            try:
                parsed = json.loads(args)
                if isinstance(parsed, dict) and isinstance(parsed.get("description"), str):
                    description = parsed["description"]
            except (ValueError, TypeError):
                pass
        order.append(call_id)
        rows[call_id] = {
            "seq": e.get("seq"),
            "time": e.get("time"),
            "turn": data.get("turn"),
            "step": data.get("step"),
            "call_id": call_id,
            "agent_id": None,
            "description": description,
        }
    if not order:
        return []

    for e in events:
        if e.get("type") != "tool/result":
            continue
        data = e.get("data")
        if not isinstance(data, dict):
            continue
        src = (data.get("message") or {}).get("source") if isinstance(data.get("message"), dict) else None
        cid = src.get("callId") if isinstance(src, dict) else None
        row = rows.get(cid)
        if row is None:
            continue
        buf = []
        _collect_text(data, buf)
        got = _agent_id_in("\n".join(buf))
        if got:
            row["agent_id"] = got

    return [rows[c] for c in order]
