"""v0.7 Stage 1：Claude observation extractor + UsageFact emitter 共享解析层。

R1 架构审核（commit d0ec2f2 拍板）：`_apply_record` 聚合之前从原始 JSONL
row 旁路 emit；fold 与 emitter 必须调用同一个 row parser，不能形成两套
Claude wire-shape 语义。本模块提供：

- `parse_claude_usage_row(rec, *, ...)`：单条 JSONL record → `Observation`
  或 `Skip(reason)` 判别结果；纯函数，无 I/O，fold 与 emitter 共用
- `ClaudeUsageObservation`：每条有效 `assistant` usage row 的最小事实单元
  （含 emit 所需的 message.id / 归日 / model / token 4 桶 + identity_basis）
- `SkipReason`：fold 仍要计数的三种 sentinel（cost-state 不计、无 usage
  不计、缺字段 unreadable、ts 不可解析 unattributed）

Stage 1 commit 1（extractor 重构 + golden 零漂移）：本模块只引入
parse 入口并被 `_apply_record` 消费，fold 行为完全不变；golden runner
与 `test_claude_cost.py` byte-parity 钉测验证零漂移。

Stage 1 commit 2（emitter + 诊断 CLI + fixture）：本模块新增
`iter_claude_usage_observations(path, ...)` 文件级迭代器与
`claude_jsonl_to_usage_facts` per-message emit；Python/Rust 双语言
parity + 真实 fixture（复用 commit 6421f2a 的 197.5M 三会话语料）。

Rust 平行实现见 `src/agent/claude_usage_fact.rs`（commit 2 落地）。
"""

import json
from pathlib import Path
from typing import Iterator, NamedTuple, Optional, Union

from .claude_cost import (
    SNAKE_KEYS,
    _row_tokens,
    day_from_iso_ts,
    ms_from_iso_ts,
    _is_peak_slot,
)
from ..source_identity import canonical_json, fnv1a64_hex  # 共享原语：Claude/Codex/DSH/UsageFact ID 共用
from .attribution import (GATEWAY, OFFICIAL_VENDOR, UNKNOWN, VENDOR_SHAPE, evidence_basis_of,
                          official_endpoint_of, route_shape)


# Sentinel 原因——fold 仍要递增 unreadable_usage_rows / unattributed_rows，
# 不抛错、不静默吞。emitter 侧对 Skip 不发射 UsageFact，但要把计数
# 累加到 `attempts`/`coverage`（commit 2 落地）。
SKIP = "skip"                  # 行不是 usage observation（cost-state / 无 usage 的 assistant / 非 dict）
UNREADABLE = "unreadable"      # usage 形状不可解析（缺字段 / 错类型 / 两态皆无 / 缺 model）
UNATTRIBUTED = "unattributed"  # ts 不可解析 → 缺日归属


class ClaudeUsageObservation(NamedTuple):
    """一条有效 `assistant` usage row 的最小事实单元。

    - `day` / `model` / `*_tokens` / `peak`：fold 侧走 `tail_days`（已有
      `_bump_tail` 路径，commit 1 不变）。
    - `message_id` / `observation_kind` / `ts_iso` / `machine_namespace` /
      `source_profile` / `identity_basis`：emit 侧走 `build_usage_fact`
      （commit 2 落地）。
    - `native_session_id`：locate 阶段确定的稳定 sid；emit 端把它直接写
      进 UsageFact 的 `native_session_id` 字段（与 R2a SessionKey
      共享）。
    """
    native_session_id: str
    source_event_id: Optional[str]  # message.id → 顶层 uuid；都缺 None（offset+hash 由迭代器补）
    observation_kind: str           # 恒 "assistant-usage"
    identity_basis: str             # "native"（原生 id 取到）/ "derived-hash"（fallback）
    machine_namespace: str
    source_profile: str
    ts_iso: str                     # 原始 ts（如 "2026-09-02T03:00:00.000Z"）
    day: str                        # 归日（如 "2026-09-02"）
    ms: Optional[int]               # epoch ms（解析失败 → None）
    peak: bool                      # _is_peak_slot(ms)；ms 缺场时 False
    model: str                      # message.model
    input_tokens: int
    cache_read_tokens: int
    cache_write_tokens: int
    output_tokens: int
    # 顶层 requestId 与 message.id——L1 路由证据原料（自动归因规格 §1.2）；缺场 None。
    request_id: Optional[str] = None
    message_id: Optional[str] = None


class Skip(NamedTuple):
    """fold 仍要计数的 sentinel 包装。`reason` 与 sentinel 字段名一一对应：

    - "skip"        → 不递增任何 sentinel（cost-state / 非 dict / 无 usage）
    - "unreadable"  → `_inc(sess, "unreadable_usage_rows")`
    - "unattributed" → `_inc(sess, "unattributed_rows")`
    """
    reason: str  # SKIP / UNREADABLE / UNATTRIBUTED


# 顶层别名：观察者 / 跳过——fold 与 emitter 共用的 parse 出口类型
ParseResult = Union[ClaudeUsageObservation, Skip]


def parse_claude_usage_row(
    rec: object,
    *,
    native_session_id: str,
    machine_namespace: str,
    source_profile: str,
) -> ParseResult:
    """单条 JSONL record → Observation 或 Skip(reason)。纯函数，无 I/O。

    fold 与 emitter 必须调用同一个 row parser（commit d0ec2f2 §2.3）——
    两处 wire-shape 解释分开会让"emit 出的 fact_id 与 fold 出来的 day"
    静默错位。

    字段解析规则与旧 `_apply_record`（v0.6.x 热修后）逐字段一致：

    - `rec` 不是 dict 或 `type != "assistant"` → Skip(SKIP)
    - `message` 不是 dict 或 `usage` 非 dict 或 `usage` 空 → Skip(SKIP)
    - `model` 非 str 或空字符串 → Skip(UNREADABLE)
    - `_row_tokens(usage)` 失败（两态皆无 / 错类型）→ Skip(UNREADABLE)
    - `timestamp` 不可解析 → Skip(UNATTRIBUTED)
    - 都通过 → ClaudeUsageObservation（原生 id = `message.id` 优先、顶层
      `uuid` 次之；两者都缺时 source_event_id=None 且 identity_basis=
      derived-hash——offset+hash fallback 由文件级迭代器补，parse 不掺 I/O）

    关键纪律：**返回的 Observation 字段值与旧 `_apply_record` 计算的
    `(day, model, tokens, peak)` 字节一致**——这是 commit 1 golden 零漂移
    的硬条件。emit 用的额外字段（message_id 等）只是**附加**，不替换
    任何 fold 字段。
    """
    if not isinstance(rec, dict):
        return Skip(SKIP)
    rtype = rec.get("type")
    if rtype != "assistant":
        # cost-state 等非 assistant 行：旧 `_apply_record` 在 rtype != "assistant"
        # 处直接 return（不增 sentinel）——这是 P0「cost-state 不算 usage
        # observation」纪律，保留。
        return Skip(SKIP)
    msg = rec.get("message")
    if not isinstance(msg, dict):
        return Skip(SKIP)
    usage = msg.get("usage")
    if not (isinstance(usage, dict) and usage):
        return Skip(SKIP)
    model = msg.get("model")
    if not isinstance(model, str) or not model:
        return Skip(UNREADABLE)
    tokens = _row_tokens(usage)
    if tokens is None:
        return Skip(UNREADABLE)
    ts = rec.get("timestamp")
    day = day_from_iso_ts(ts) if isinstance(ts, str) else None
    if day is None:
        return Skip(UNATTRIBUTED)
    ms = ms_from_iso_ts(ts) if isinstance(ts, str) else None
    peak = _is_peak_slot(ms) if ms is not None else False
    # `message.id` priority chain（R1 §3.2/§9，Stage 1c 补全）：message.id →
    # 顶层 uuid → offset+hash fallback。本 parse 只解析原生 id 可达的部分
    # （message.id / 顶层 uuid）；offset+hash 需要行字节偏移 + 原始 record，
    # 只在文件级迭代器 `iter_claude_usage_observations` 里补——parse 是纯
    # record→result 映射、不掺 I/O（fold 也调它，fold 不读 source_event_id，
    # golden 零漂移不受影响）。uuid 在真机 assistant 行位于**顶层**（实测与
    # message.id 并存）；Stage 1c 前只认 message.id，缺场即降 derived——
    # 等于把有 uuid 的行也错降级成 fallback。
    native_id = msg.get("id") if isinstance(msg.get("id"), str) else None
    if native_id is None:
        uuid = rec.get("uuid")
        native_id = uuid if isinstance(uuid, str) else None
    return ClaudeUsageObservation(
        native_session_id=native_session_id,
        source_event_id=native_id,
        observation_kind="assistant-usage",
        identity_basis="native" if native_id else "derived-hash",
        machine_namespace=machine_namespace,
        source_profile=source_profile,
        ts_iso=ts,
        day=day,
        ms=ms,
        peak=peak,
        model=model,
        input_tokens=tokens[0],
        cache_read_tokens=tokens[1],
        cache_write_tokens=tokens[2],
        output_tokens=tokens[3],
        request_id=rec.get("requestId") if isinstance(rec.get("requestId"), str) and rec.get("requestId") else None,
        message_id=msg.get("id") if isinstance(msg.get("id"), str) and msg.get("id") else None,
    )


__all__ = [
    "ClaudeUsageObservation",
    "Skip",
    "SKIP",
    "UNREADABLE",
    "UNATTRIBUTED",
    "ParseResult",
    "UsageFactEmitResult",
    "parse_claude_usage_row",
    "iter_claude_usage_observations",
    "claude_jsonl_to_usage_facts",
]


# ────────────────────────────────────────────────────────────────────
# Stage 1 commit 2：UsageFact emitter + 文件级迭代器
# ────────────────────────────────────────────────────────────────────
# 复用 `parse_claude_usage_row`（commit 1）做行解析，加一个文件级迭代器
# 与「observation → UsageFact」转换。`build_usage_fact` 是 b806762 落地
# 的契约函数，本模块不重写字段校验，只把 Observation 的字段填进去。

from .usage_fact import build_usage_fact  # 延迟到末尾避免循环 import（cost→fact→cost 链）


def _derived_event_id(native_session_id: str, byte_offset: int,
                      rec: dict) -> str:
    """§3.2 fallback：`stable_source_identity + byte_offset +
    normalized_row_hash`。stable_source_identity = native_session_id；
    byte_offset = 行首在**原文件**的字节位置（不以行号替代）；row hash =
    canonical JSON 的 FNV-1a（canonical/FNV 原语在包顶层 `source_identity`，
    Claude/Codex/DSH/UsageFact ID 共用，本模块不长第二份）。同一文件重复读取
    稳定（checkpoint resume 从 from_byte 续读时，已折行的 offset 不变，
    fact-id 集合与 full replay 一致）。"""
    return "%s:%d:%s" % (
        native_session_id,
        byte_offset,
        fnv1a64_hex(canonical_json(rec)),
    )


def _iter_rows_with_offsets(path):
    """产 (行首字节偏移, 已解析 JSON record) 对。行切分语义与 fold 的
    `claude_cost._read_suffix` 逐字节一致（`\\n` 切、剥尾 `\\r`、空行跳过、
    末行无换行符不消费）——emit 的 fallback 行偏移必须与 resume 的 checkpoint
    同源，不允许两套行切分（`test_rows_with_offsets_matches_read_suffix`
    钉测不漂移）。坏行抛错（与 `_read_suffix` 同款：整份 abort）。"""
    with open(path, "rb") as f:
        data = f.read()
    start = 0
    for i, b in enumerate(data):
        if b != 0x0A:
            continue
        line = data[start:i]
        if line.endswith(b"\r"):
            line = line[:len(line) - 1]
        if line:
            try:
                rec = json.loads(line.decode("utf-8", errors="replace"))
            except ValueError as e:
                raise ValueError(
                    "non-json line in %s at byte offset %d: %s"
                    % (path, start, e)) from e
            yield start, rec
        start = i + 1


def _route_fields(obs: ClaudeUsageObservation) -> dict:
    kind, vendor = route_shape(obs.model, obs.request_id, obs.message_id)
    basis = evidence_basis_of(kind)
    if kind == OFFICIAL_VENDOR:
        provider_raw, endpoint_host, provider_id, pricing_basis = vendor, official_endpoint_of(vendor), vendor, "route-observed"
    else:
        provider_raw, endpoint_host, provider_id, pricing_basis = None, None, None, "metered_estimate"
    if kind == UNKNOWN:
        route_evidence_id = None
    else:
        shape_key = {OFFICIAL_VENDOR: "official:%s" % vendor, VENDOR_SHAPE: "vendor-shape:%s" % vendor,
                     GATEWAY: "gateway"}[kind]
        key = "claude-code|%s|%s|%s|%s|%s" % (
            obs.native_session_id, shape_key, provider_raw or "", endpoint_host or "", basis)
        route_evidence_id = "route:" + fnv1a64_hex(key)
    return {
        "provider_raw": provider_raw,
        "endpoint_host": endpoint_host,
        "provider_id": provider_id,
        "billing_source": provider_id,
        "pricing_basis": pricing_basis,
        "evidence_basis": basis,
        "route_evidence_id": route_evidence_id,
    }


def _observation_to_usage_fact(
    obs: ClaudeUsageObservation,
) -> Optional[dict]:
    """Observation → UsageFact dict（`build_usage_fact` 输出）。

    None → `build_usage_fact` 拒绝（防御性 `bad_id` 哨兵；Stage 1c 后
    iter 已给 derived-hash Observation 补上非空 source_event_id，正常
    路径走不到——保留是因为 builder 是唯一校验方，不许绕开它自证）。
    """
    fields = {
        "machine_namespace": obs.machine_namespace,
        "harness": "claude-code",
        "source_profile": obs.source_profile,
        "native_session_id": obs.native_session_id,
        "source_event_id": obs.source_event_id,
        "observation_kind": obs.observation_kind,
        "identity_basis": obs.identity_basis,
        "event_ts_utc": obs.ts_iso,
        # time_basis 与 identity_basis 解耦（Stage 1c）：fact 只在原生 ts
        # 可归日时发射（否则 unattributed skip），事件时间证据恒为原生——
        # 不存在「estimated session start 冒充事件时间」的路径。identity_basis
        # 只描述 source_event_id 的来源，不决定 time_basis。
        "time_basis": "native",
        "source_usage_semantics": "delta",
        # L1 路由证据（镜像 Rust `Observation::to_usage_fact`）：不从模型名推计费方，
        # 但请求/响应 ID 形状是路由证据——两个 ID 同时命中厂商文档格式 = 官方端点
        # （session-native）；只与厂商形状一致或网关式命名 = inferred；缺 = missing。
        **_route_fields(obs),
        "billing_mode": "metered",
        "normalization_version": "provider-v0.11",
        "attribution_version": "provider-v1.0-beta.1",
        # provider/model 归属（Stage 1c）：只保留原始证据 `model_raw`。
        # DATA_PLANE §2.1「raw 值不可改；规范化 id 由带版本的映射产生」——
        # Stage 1 没有 resolver，model_id/model_normalized/provider_id/
        # provider_raw/normalization_version 一律不填（序列化为 None），
        # 绝不用单一真机 provider 硬编码冒充真值。
        "model_raw": obs.model,
        "uncached_input_tokens": obs.input_tokens,
        "cache_read_tokens": obs.cache_read_tokens,
        "cache_write_tokens": obs.cache_write_tokens,
        "output_tokens": obs.output_tokens,
    }
    try:
        return build_usage_fact(fields)
    except ValueError:
        return None


class UsageFactEmitResult(NamedTuple):
    """`claude_jsonl_to_usage_facts` 的返回——诊断 CLI 与未来 writer
    共用结构。`malformed` 是源文件读不出的总行数（坏 JSON / 截断等
    I/O 错误，与 Skip 三类「行级不可用」分开计数）。"""
    facts: list          # List[Dict]——每个 dict 是 build_usage_fact 输出
    attempts: dict       # 插入序：skip/unreadable/unattributed 恒在，duplicate/bad_id 仅 >0
    coverage: dict       # {"total_rows": n, "fact_rows": n, "skip_rows": n}
    malformed: int       # 源 JSONL 坏行数（解析失败、截断等 I/O 错误）


def iter_claude_usage_observations(
    path, *,
    machine_namespace: str,
    source_profile: str,
    native_session_id: Optional[str] = None,
) -> Iterator[Union[ClaudeUsageObservation, Skip]]:
    """Stage 1 R1 §2.2 文件级迭代器——读 JSONL → yield Observation 或 Skip。

    Observation 的 `source_event_id` 已解析：message.id / 顶层 uuid 原生 id，
    或（两者都缺）derived offset+hash fallback（§3.2，Stage 1c 补全）——
    所以下游 emit 看到的 Observation 身份恒非空。

    `native_session_id` 默认 = `path.stem`（Claude 项目文件名约定
    `<sid>.jsonl`，与现有 `claude-sync::claude_project_files` 同款）；
    显式传入优先（adapter 调用方可能从 R2a 派生 sid 而非文件 stem）。
    """
    p = Path(path)
    sid = native_session_id if native_session_id is not None else p.stem
    for offset, rec in _iter_rows_with_offsets(p):
        result = parse_claude_usage_row(
            rec,
            native_session_id=sid,
            machine_namespace=machine_namespace,
            source_profile=source_profile,
        )
        if isinstance(result, Skip):
            yield result
            continue
        if result.identity_basis == "derived-hash":
            # 原生 id 缺场 → 用行字节偏移 + canonical row hash 补稳定身份。
            # NamedTuple._replace 保持其它字段（含 identity_basis=derived-hash）。
            result = result._replace(
                source_event_id=_derived_event_id(sid, offset, rec))
        yield result


def claude_jsonl_to_usage_facts(
    path, *,
    machine_namespace: str,
    source_profile: str,
    native_session_id: Optional[str] = None,
) -> UsageFactEmitResult:
    """整份 Claude JSONL → (facts, attempts, coverage, malformed)。

    facts：每条有效 Observation emit 一个 UsageFact dict（`build_usage_fact`
    输出）；attempts：Skip(reason) 计数 + duplicate（重复 source_event_id，
    §3.4 只保留一个 fact）+ bad_id（builder 防御性拒绝）；coverage：总行 /
    fact 行 / skip 行比例；malformed：源 JSONL 解析失败行数（I/O 层错误，
    与 Skip 三个行级原因分开）。

    不写盘。诊断 CLI 与未来 writer 共用此函数。
    """
    facts: list = []
    attempts = {SKIP: 0, UNREADABLE: 0, UNATTRIBUTED: 0}
    seen: set = set()
    total = 0
    skip = 0
    duplicate = 0
    bad_id = 0
    for result in iter_claude_usage_observations(
            path,
            machine_namespace=machine_namespace,
            source_profile=source_profile,
            native_session_id=native_session_id):
        total += 1
        if isinstance(result, Skip):
            attempts[result.reason] = attempts.get(result.reason, 0) + 1
            skip += 1
            continue
        if result.source_event_id in seen:
            # §3.4 同一 session 重复出现相同 native event id → duplicate
            # attempt、只保留一个 fact；不得加 ordinal 掩盖重复。
            duplicate += 1
            skip += 1
            continue
        seen.add(result.source_event_id)
        fact = _observation_to_usage_fact(result)
        if fact is None:
            bad_id += 1
            skip += 1
            continue
        facts.append(fact)
    if duplicate:
        attempts["duplicate"] = duplicate
    if bad_id:
        attempts["bad_id"] = bad_id
    return UsageFactEmitResult(
        facts=facts,
        attempts=attempts,
        coverage={"total_rows": total, "fact_rows": len(facts),
                  "skip_rows": skip},
        malformed=0,  # _iter_rows_with_offsets 当前坏行抛异常（commit 1
                       # 既有行为），不改 I/O 路径，malformed 留给未来软失败版。
    )
