"""WorkBuddy traces → `UsageFact`（spec §9E.5 E4a/E4b）。两个入口：全量
`workbuddy_traces_to_usage_facts(root)`（CLI 只读诊断面）与单文件
`workbuddy_trace_file_to_usage_facts(path)`（Rust 侧是 sync_service 的 ingest 面；
Python 镜像它只为钉「逐文件拼接 == 全量」，Python 不长写路径）。

源：generation span 解码后的 `usage`（OpenAI 兼容格式）+ 逐调用 `model`——E1 的读取层
（`adapters/workbuddy_traces.py`）已解开二次编码、只留 `usages`/`model`。每个 generation
span 恰好一条 usage（真机 5,067/5,067）→ `source_event_id = spanId` 是原生身份
（`identity_basis: native`）。

桶映射（与 Codex 同形）：uncached = prompt − cached、cache_read = cached、cache_write = 0
（OpenAI 格式无此桶）、output = completion（**已含** reasoning，绝不叠加）。

归属：镜像 Rust `resolve_billing_attribution(None, None)` 的输出——WorkBuddy 的轨道
（平台积分 / 自配 key / 限免）是请求级且本机不可判（spec §2.1）：`provider_id: None`、
`billing_mode: "metered"`（resolver 的保守默认，非「免费」）、`pricing_basis:
"metered_estimate"`、`evidence_basis: "missing"`。不解析 `model` 前缀、不把 models.json
当 RouteEvidence。

未归属 trace（无 `trace.sessionId`）按 Codex 先例计 `attempts["unattributed"]`，不发事实
——`native_session_id` 是身份必填字段，编一个就是编 session。

与 Rust `harnesses/workbuddy/sources/usage_fact.rs` 逐字节对齐（`tests/test_workbuddy_usage_fact.py`）。
"""

from pathlib import Path
from typing import NamedTuple

from ..adapters import workbuddy_traces
from .usage_fact import build_usage_fact

HARNESS = "workbuddy"
OBSERVATION_KIND = "assistant-usage"
SKIP = "skip"
UNREADABLE = "unreadable"
UNATTRIBUTED = "unattributed"


class UsageFactEmitResult(NamedTuple):
    facts: list
    attempts: dict
    coverage: dict
    malformed: int


def _span_to_usage_fact(span, native_session_id, machine_namespace, source_profile):
    usages = span.get("usages") or []
    if not usages:
        return None
    u = usages[0]
    uncached = max(u["prompt_tokens"] - u["cached_tokens"], 0)
    started_at = span.get("started_at")
    fields = {
        "machine_namespace": machine_namespace,
        "harness": HARNESS,
        "source_profile": source_profile,
        "native_session_id": native_session_id,
        "source_event_id": span["span_id"],
        "observation_kind": OBSERVATION_KIND,
        # spanId 是执行环境原生 id——不像 Codex 的 token_count 要靠字节偏移派生。
        "identity_basis": "native",
        # span.startedAt 原样 ISO 毫秒串；缺失 → None（诚实无观测时间）。
        "event_ts_utc": started_at,
        "time_basis": "native" if started_at is not None else None,
        "source_usage_semantics": "delta",
        "model_raw": u.get("model"),
        # 镜像 resolve_billing_attribution(None, None)。
        "provider_raw": None,
        "endpoint_host": None,
        "provider_id": None,
        "route_evidence_id": None,
        "billing_source": None,
        "billing_mode": "metered",
        "pricing_basis": "metered_estimate",
        "evidence_basis": "missing",
        "normalization_version": "provider-v0.11",
        "attribution_version": "provider-v0.11",
        "uncached_input_tokens": uncached,
        "cache_read_tokens": u["cached_tokens"],
        "cache_write_tokens": 0,
        "output_tokens": u["completion_tokens"],
    }
    try:
        return build_usage_fact(fields)
    except ValueError:
        return None


def workbuddy_traces_to_usage_facts(root, *, machine_namespace, source_profile="default"):
    """`<workbuddy_root>/traces/**` → `UsageFactEmitResult`。facts 按 trace 文件路径序、
    span 原序。不写盘。root / traces 目录不存在 → OSError（CLI exit 2，与其他执行环境的
    usage-facts 同款：源不可读不冒充 0 事实）。"""
    root = Path(root)
    if not root.is_dir():
        raise OSError("%s: not a directory" % root)
    if not workbuddy_traces.workbuddy_traces_root(root).is_dir():
        raise OSError("%s: no traces/ directory" % root)
    read = workbuddy_traces.read_workbuddy_traces(root)
    out = _Acc()
    all_traces = [t for v in read["by_session"].values() for t in v] + list(read["unattributed"])
    all_traces.sort(key=lambda t: str(t["path"]))
    for tr in all_traces:
        _emit_trace(tr, machine_namespace, source_profile, out)
    return out.result(malformed=len(read["degraded"]))


def workbuddy_trace_file_to_usage_facts(path, *, machine_namespace, source_profile="default"):
    """单个 trace 文件 → `UsageFactEmitResult`。读不了 / 不是 trace 形状 → ValueError
    （Rust 侧 sync 把它记进该文件的 errors 留待重试）。`malformed` 恒 0。"""
    tr = workbuddy_traces.read_workbuddy_trace_file(path)
    out = _Acc()
    _emit_trace(tr, machine_namespace, source_profile, out)
    return out.result(malformed=0)


class _Acc:
    """一次 emit 的累加器（Rust `UsageFactEmitResult` 的可变形态）。"""

    def __init__(self):
        self.facts = []
        self.attempts = {SKIP: 0, UNREADABLE: 0, UNATTRIBUTED: 0}
        self.total_generation_spans = 0
        self.skip_rows = 0

    def result(self, *, malformed):
        coverage = {
            "total_generation_spans": self.total_generation_spans,
            "fact_rows": len(self.facts),
            "skip_rows": self.skip_rows,
        }
        return UsageFactEmitResult(facts=self.facts, attempts=self.attempts,
                                   coverage=coverage, malformed=malformed)


def _emit_trace(tr, machine_namespace, source_profile, out):
    """一个 trace 的全部 generation span → facts / attempts。每个 span 恰落一个桶：
    decode_failed 先判、再判无 usage、再判无 sessionId。"""
    for span in tr["spans"]:
        if span.get("kind") != "generation":
            continue
        out.total_generation_spans += 1
        if span.get("decode_failed"):
            # toolOutput 解不开（真机 4 例全是空串）→ unreadable，不是 skip。
            out.attempts[UNREADABLE] += 1
            continue
        if not span.get("usages"):
            # 取消/进行中（toolOutput null）或解码后无 usage → 跳过，不是失败。
            out.attempts[SKIP] += 1
            out.skip_rows += 1
            continue
        sid = tr.get("session_id")
        if sid is None:
            out.attempts[UNATTRIBUTED] += 1
            continue
        fact = _span_to_usage_fact(span, sid, machine_namespace, source_profile)
        if fact is None:
            out.attempts["bad_id"] = out.attempts.get("bad_id", 0) + 1
        else:
            out.facts.append(fact)


__all__ = [
    "HARNESS",
    "OBSERVATION_KIND",
    "UsageFactEmitResult",
    "workbuddy_trace_file_to_usage_facts",
    "workbuddy_traces_to_usage_facts",
]
