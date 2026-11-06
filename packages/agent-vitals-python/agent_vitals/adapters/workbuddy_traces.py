"""WorkBuddy traces 读取层（spec §9E.5 E1：locate → shape → extract）。

`~/.workbuddy/traces/<pid>/trace_<id>.json`，每文件一个 `{trace: {...}, spans: [...]}`。
归属键是 **`trace.sessionId`**（字符串相等，不猜——spec §9E.4 纪律 1）；没有这个键的
trace 进 `unattributed`（真实用量，不是另一类、不是损坏——纪律 2）。

三个只能踩一次的坑（2026-09-11 分析步，§9E.1；09-02 的分析全踩了）：
- `toolInput` / `toolOutput` 是**二次 JSON 编码的字符串**，必须解一层。解不开 → 计入
  `decode_failures`，该 span 对应字段为 None，**不 panic 不猜**（纪律 3）。真机 4 个
  失败全是 `toolInput: ""`（空串不是合法 JSON）——空串 ≠ null，猜成「无输入」是解读，
  照记失败。
- `trace.totalTokens` 不可信（302/675 为 0 但 span 有 usage）——**不读**（纪律 4）。
- 时间戳是 ISO 毫秒串，原样保留，归一化留给消费方（A2 字符串路径）。

只提取、不保留正文（spec §4）：generation `toolOutput` 只取每项的 `model` 与 `usage`；
function `toolInput` 只取 `file_path`。全量读（真机 686MB / 2.0s）。增量在同步管线
那一层（E4b，Rust-only）：`workbuddy_trace_files` 是 locate 面、
`read_workbuddy_trace_file` 是单文件 shape 面，全量读 = 两者复合；这里镜像两个入口
只为钉「逐文件拼接 == 全量」的等式，Python 不长同步写路径。
文件按路径字符串排序。与 Rust `harnesses/workbuddy/sources/traces.rs` 逐字节对齐。
"""

import json
from pathlib import Path


def workbuddy_traces_root(root):
    return Path(root) / "traces"


def _opt_str(d, key):
    v = d.get(key)
    return v if isinstance(v, str) else None


def _opt_int(d, key):
    v = d.get(key)
    # bool 是 int 的子类——Rust `as_i64` 对 bool 返回 None，这里同判。
    return v if isinstance(v, int) and not isinstance(v, bool) else None


_DECODE_FAILED = object()


def _decode_layer(v):
    """二次编码解一层：str → json.loads；None/缺失 → None（真机取消/进行中的
    generation 就是 `toolOutput: null`，不是失败）；其他类型 → 失败哨兵
    （纪律 3：不猜「已经是对象了」）。"""
    if v is None:
        return None
    if isinstance(v, str):
        try:
            return json.loads(v)
        except (ValueError, TypeError):
            return _DECODE_FAILED
    return _DECODE_FAILED


def _usage_of(item):
    if not isinstance(item, dict):
        return None
    u = item.get("usage")
    if not isinstance(u, dict):
        return None

    def g(k):
        v = u.get(k)
        return v if isinstance(v, int) and not isinstance(v, bool) else 0

    ptd = u.get("prompt_tokens_details")
    cached = ptd.get("cached_tokens") if isinstance(ptd, dict) else None
    cached = cached if isinstance(cached, int) and not isinstance(cached, bool) else 0
    ctd = u.get("completion_tokens_details")
    reasoning = ctd.get("reasoning_tokens") if isinstance(ctd, dict) else None
    reasoning = reasoning if isinstance(reasoning, int) and not isinstance(reasoning, bool) else 0
    return {
        "model": _opt_str(item, "model"),
        "prompt_tokens": g("prompt_tokens"),
        "cached_tokens": cached,
        "completion_tokens": g("completion_tokens"),
        "reasoning_tokens": reasoning,
    }


def _shape_span(s):
    """单个 span → summary dict；返回 (summary, decode_failed)。"""
    kind = _opt_str(s, "type") or ""
    failed = False
    file_path = None
    usages = []
    if kind == "function":
        inp = _decode_layer(s.get("toolInput"))
        if inp is _DECODE_FAILED:
            failed = True
        elif isinstance(inp, dict):
            file_path = _opt_str(inp, "file_path")
    elif kind == "generation":
        out = _decode_layer(s.get("toolOutput"))
        if out is _DECODE_FAILED:
            failed = True
        elif isinstance(out, list):
            usages = [u for u in (_usage_of(it) for it in out) if u is not None]
        elif isinstance(out, dict):
            u = _usage_of(out)
            if u is not None:
                usages.append(u)
    return ({
        "span_id": _opt_str(s, "spanId") or "",
        "parent_id": _opt_str(s, "parentId"),
        "name": _opt_str(s, "name") or "",
        "kind": kind,
        "started_at": _opt_str(s, "startedAt"),
        "ended_at": _opt_str(s, "endedAt"),
        "duration_ms": _opt_int(s, "duration"),
        "status": _opt_str(s, "status"),
        "error": _opt_str(s, "error"),
        "tool_name": _opt_str(s, "toolName"),
        "file_path": file_path,
        "usages": usages,
        "agent_name": _opt_str(s, "agentName"),
        "decode_failed": failed,
    }, failed)


def _shape_trace(path, doc):
    tr = doc.get("trace") if isinstance(doc, dict) else None
    if not isinstance(tr, dict):
        raise ValueError("malformed: no `trace` object")
    trace_id = _opt_str(tr, "traceId")
    if trace_id is None:
        raise ValueError("malformed: no traceId")
    sid = _opt_str(tr, "sessionId")
    session_id = sid if sid else None
    decode_failures = 0
    spans = []
    for s in (doc.get("spans") or []):
        if not isinstance(s, dict):
            continue
        summ, failed = _shape_span(s)
        if failed:
            decode_failures += 1
        spans.append(summ)
    return {
        "trace_id": trace_id,
        "path": path,
        "name": _opt_str(tr, "name"),
        "session_id": session_id,
        "started_at": _opt_str(tr, "startedAt"),
        "ended_at": _opt_str(tr, "endedAt"),
        "spans": spans,
        "decode_failures": decode_failures,
    }


def workbuddy_trace_files(root):
    """locate 面：`<root>/traces/*/trace_*.json` 全部文件，按路径字符串排序。目录
    缺失 → 空列表。"""
    tdir = workbuddy_traces_root(root)
    files = []
    if not tdir.is_dir():
        return files
    try:
        for pid in tdir.iterdir():
            if not pid.is_dir():
                continue
            try:
                for f in pid.iterdir():
                    if f.is_file() and f.name.startswith("trace_") and f.name.endswith(".json"):
                        files.append(f)
            except OSError:
                continue
    except OSError:
        return files
    files.sort(key=str)
    return files


def read_workbuddy_trace_file(path):
    """shape 面：读一个 trace 文件 → trace dict；读不了 / 不是 trace 形状 → ValueError，
    文案与 `degraded` 的原因串同一词表。"""
    path = Path(path)
    try:
        raw = path.read_bytes()
    except OSError:
        raise ValueError("unreadable")
    try:
        doc = json.loads(raw)
    except (ValueError, TypeError):
        raise ValueError("malformed: not JSON")
    return _shape_trace(path, doc)


def read_workbuddy_traces(root):
    """读 `<root>/traces/*/trace_*.json` 全部文件 → `{files, by_session, unattributed,
    degraded}`。目录缺失 → 空结果（存在性探测）。= locate ∘ shape。"""
    out = {"files": 0, "by_session": {}, "unattributed": [], "degraded": []}
    for path in workbuddy_trace_files(root):
        out["files"] += 1
        try:
            tr = read_workbuddy_trace_file(path)
        except ValueError as e:
            out["degraded"].append((path, str(e)))
            continue
        if tr["session_id"] is not None:
            out["by_session"].setdefault(tr["session_id"], []).append(tr)
        else:
            out["unattributed"].append(tr)
    return out


def session_spans(read, session_id):
    """本会话全部 trace 的 span 摘要（dict 形状即 Rust `span_summary_json`），按 trace
    文件路径序再 span 原序拼接（evidence 层再按 `(started_at, span_id)` 定序）。"""
    return [s for tr in read["by_session"].get(session_id, []) for s in tr["spans"]]


def traces_probe_json(read, session_id):
    """spec §9E.5 E1 的 `traces_probe` 块（单会话审计 JSON 末位键）。键序是差分契约。
    `this_session` 为该会话无 trace 时给零值对象（真测量）；null 留给目录不存在。"""
    mine = read["by_session"].get(session_id, [])
    by_type = {}
    gen_with_usage = 0
    edit_write_with_path = 0
    decode_failures_mine = 0
    for tr in mine:
        decode_failures_mine += tr["decode_failures"]
        for s in tr["spans"]:
            by_type[s["kind"]] = by_type.get(s["kind"], 0) + 1
            if s["kind"] == "generation" and s["usages"]:
                gen_with_usage += 1
            if (s["kind"] == "function" and s["tool_name"] in ("Edit", "Write")
                    and s["file_path"] is not None):
                edit_write_with_path += 1
    total_decode_failures = sum(t["decode_failures"] for v in read["by_session"].values() for t in v)
    total_decode_failures += sum(t["decode_failures"] for t in read["unattributed"])
    return {
        "files": read["files"],
        "attributed_traces": sum(len(v) for v in read["by_session"].values()),
        "unattributed_traces": len(read["unattributed"]),
        "degraded_files": len(read["degraded"]),
        "decode_failures": total_decode_failures,
        "this_session": {
            "traces": len(mine),
            # Rust BTreeMap 按键排序序列化；这里同样按键排序。
            "spans_by_type": {k: by_type[k] for k in sorted(by_type)},
            "generation_with_usage": gen_with_usage,
            "edit_write_with_path": edit_write_with_path,
            "decode_failures": decode_failures_mine,
        },
    }
