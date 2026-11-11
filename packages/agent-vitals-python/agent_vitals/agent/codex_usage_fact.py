"""v0.7 Stage 2：Codex static fold → UsageFact emitter（harness adapter，不进 Core）。

spec §2.3「发射集 == fold 的 by_model 消费集，是构造出来的」：本模块不重抄一套
codex wire-shape 解释，而是驱动 `codex_usage.CodexFoldState`（Stage 2 commit 1
的共享 per-`token_count` 观察者）逐事件 `apply`，按返回的判别出口发射。emitter
只负责 fold 不管的两件事：

1. **byte_offset**（§3.3）：derived `source_event_id` 需要行首在逻辑 JSONL 字节
   流里的位置——明文 rollout 下它也是原文件偏移；`.zst` 下它是完整解压后的
   JSONL 偏移，不能直接当作压缩文件 seek 位置。`codex_cost` 读法在解析后丢掉偏移，
   所以这里在解析字节上做一次带偏移的 `split_lines` 复刻，**不**引入第
   二套换行语义（只认 \\n / \\r\\n / \\r，末段无换行也消费）。
2. **native_session_id 解析**（§3.4）：逻辑 session_id（`session_meta`）→
   `path.stem` 兜底。

发射域 = 本次传入的 rollout 路径集；`source_event_id` 按 **rollout stem 命名
空间**（不是逻辑 session）去重——同物理 rollout 的 byte-identical 复本只保留一
条 + duplicate attempt，异 stem 永不误合并（§3.5.3 / §6.8 / §6.9，2026-09-03
拍板）。degraded 文件（空 / 含坏 JSON 行）镜像 codex-cost 按零事件处理、计进
`malformed`；I/O 错误向上抛（CLI 层 exit 2，镜像 claude-usage-facts）。

Rust 平行实现见 `src/agent/codex_usage_fact.rs`。
"""

import json
from pathlib import Path
from typing import NamedTuple, Optional
from urllib.parse import urlparse

from ..source_identity import canonical_json, fnv1a64_hex
from .codex_usage import (
    CONSUMED,
    NOT_TOKEN_COUNT,
    REPEAT,
    SKIP,
    UNATTRIBUTED,
    UNREADABLE,
    CodexFoldState,
    CodexTokenOutcome,
)
from .usage_fact import build_usage_fact

# 常量与 Stage 1 claude emitter 同源；执行环境差异由 harness / observation_kind 表达。
HARNESS = "codex"
OBSERVATION_KIND = "assistant-usage"


class UsageFactEmitResult(NamedTuple):
    """`codex_rollouts_to_usage_facts` 的返回——诊断 CLI 与未来 writer 共用。

    `malformed` = 本次发射域里 degraded 的**文件**数（codex 的降级是整份：
    一处坏 JSON 即整份不可读，镜像 `codex_session` 的 missing-header / non-json；
    这类文件贡献零事件）。coverage 键是 codex 专属
    `{total_token_count_events, fact_rows, skip_rows}`——计数口径见 spec §4。
    """
    facts: list          # List[Dict]——每个 dict 是 build_usage_fact 输出
    attempts: dict       # 插入序：skip/unreadable/unattributed 恒在，duplicate/bad_id 仅 >0
    coverage: dict       # {"total_token_count_events": n, "fact_rows": n, "skip_rows": n}
    malformed: int       # degraded（整份不可读）的 rollout 文件数


def _iter_raw_lines(data: bytes):
    """在原始字节上复刻 `util.split_lines` 的换行语义（只认 \\n / \\r\\n / \\r，
    末段无换行也消费），产 `(行首字节偏移, 行字节)`。

    偏移是传入字节流的位置；`.zst` 调用方先完整解压，因此为解压后 JSONL 的逻辑
    偏移。不做 UTF-8 解码替换（`errors="replace"` 会把坏
    字节变 U+FFFD 改变后续字节长度），逐字节与 Rust `codex_usage_fact.rs` 的
    同款扫描一致。正常 rollout JSONL 是合法 UTF-8，解码替换只在坏行上发生，而坏
    行整份降级、偏移不被任何 fact 消费。
    """
    out = []
    start = 0
    i = 0
    n = len(data)
    while i < n:
        b = data[i]
        if b == 0x0A:  # \n
            out.append((start, data[start:i]))
            i += 1
            start = i
        elif b == 0x0D:  # \r（\r\n 吞两字节）
            out.append((start, data[start:i]))
            i += 2 if i + 1 < n and data[i + 1] == 0x0A else 1
            start = i
        else:
            i += 1
    if start < n:
        out.append((start, data[start:]))
    return out


def _parse_rollout_bytes(data: bytes):
    """原始 rollout 字节 → `(items, degraded)`。

    `items` = [(行首字节偏移, 已解析 dict), ...]，空白行跳过（镜像
    `codex_session.parse_codex_session_log`：空白行不是事件）。任一条非空白行
    JSON 解析失败 → 整份 `degraded="non-json"`；空文件（无任何行）→
    `degraded="missing-header"`——codex-cost 对 degraded 文件按空折叠，emitter
    同款：零事件、计进 malformed。
    """
    segments = _iter_raw_lines(data)
    if not segments:
        return [], "missing-header"
    items = []
    for offset, raw in segments:
        text = raw.decode("utf-8", errors="replace")
        if not text.strip():
            continue
        try:
            item = json.loads(text)
        except json.JSONDecodeError:
            return [], "non-json"
        items.append((offset, item))
    return items, None


def _resolve_native_session_id(path, items) -> str:
    """spec §3.4：`session_meta.payload.session_id`（键整个缺席才退回 `.id`）→
    `path.stem` 兜底。与 `codex_session.parse_codex_session_log` 同一 `session_meta`
    判读（键存在即便 null 不退回 id；多条 session_meta 后写覆盖前写），只取 sid。
    带 session_meta 的文件 → 逻辑 session_id；纯 fold fixture（无 session_meta）
    → 该文件自成一会话（stem 兜底），诚实语义是「不假装知道逻辑归属」。"""
    session_id = None
    for _offset, item in items:
        if item.get("type") != "session_meta":
            continue
        payload = item.get("payload")
        if not isinstance(payload, dict):
            continue
        sid = payload.get("session_id")
        if sid is None and "session_id" not in payload:
            sid = payload.get("id")
        if isinstance(sid, str):
            session_id = sid
    if session_id is not None:
        return session_id
    return _rollout_source_stem(path)


def _rollout_source_stem(path) -> str:
    name = Path(path).name
    for suffix in (".jsonl.zst", ".jsonl"):
        if name.endswith(suffix):
            return name[:-len(suffix)]
    return Path(path).stem


def _resolve_model_provider(items) -> Optional[str]:
    """Return the session-native Codex provider marker, if present."""
    provider = None
    for _offset, item in items:
        if item.get("type") == "session_meta":
            payload = item.get("payload")
            if isinstance(payload, dict) and isinstance(payload.get("model_provider"), str):
                provider = payload["model_provider"]
        payload = item.get("payload")
        settings = payload.get("thread_settings") if isinstance(payload, dict) else None
        if isinstance(settings, dict) and isinstance(settings.get("model_provider_id"), str):
            provider = settings["model_provider_id"]
    return provider


def _route_evidence_from(value):
    """Extract explicit route evidence; custom alone is not route evidence."""
    if not isinstance(value, dict):
        return None
    route = value.get("route") if isinstance(value.get("route"), dict) else value
    provider = route.get("provider_id") or route.get("provider_raw")
    endpoint = route.get("endpoint_host")
    if not isinstance(endpoint, str):
        endpoint = route.get("base_url") or route.get("endpoint")
    if isinstance(endpoint, str):
        parsed = urlparse(endpoint)
        endpoint = (parsed.hostname or endpoint.split("/", 1)[0]).lower().rstrip(".")
    if not isinstance(provider, str):
        provider = None
    if not isinstance(endpoint, str):
        endpoint = None
    if provider is None and endpoint is None:
        return None
    basis = "session-native"
    if provider and endpoint:
        raw = provider.lower()
        known = raw in {"openai", "cogfoundry.ai"}
        endpoint_provider = (
            "cogfoundry.ai" if endpoint == "cogfoundry.ai" or endpoint.endswith(".cogfoundry.ai")
            else "openai" if endpoint == "api.openai.com" or endpoint.endswith(".api.openai.com")
            else None
        )
        if known and endpoint_provider != raw:
            basis = "conflict"
    return provider, endpoint, basis


def _route_state_before(items, fallback_endpoint_host=None, fallback_basis="missing"):
    """Build ordered route snapshots keyed by source byte offset."""
    states = []
    provider = None
    # Historical attribution is session-only.  Keep arguments for compatibility
    # with older callers, but never seed a rollout from current config/env.
    endpoint = None
    basis = "missing"
    for offset, item in items:
        payload = item.get("payload") if isinstance(item, dict) else None
        if not isinstance(payload, dict):
            continue
        explicit = None
        if item.get("type") == "session_meta":
            explicit = _route_evidence_from(payload)
        elif payload.get("type") == "route_changed":
            explicit = _route_evidence_from(payload)
        elif isinstance(payload.get("thread_settings"), dict):
            explicit = _route_evidence_from(payload["thread_settings"])
        if explicit is not None:
            provider, endpoint, basis = explicit
        states.append((offset, provider, endpoint, basis))
    return states


def _route_at(states, offset):
    current = (None, None, "missing")
    for event_offset, provider, endpoint, basis in states:
        if event_offset > offset:
            break
        current = (provider, endpoint, basis)
    return current


def _route_evidence_id(native_session_id, provider_raw, endpoint_host, evidence_basis):
    key = "{}|{}|{}|{}".format(
        native_session_id, provider_raw or "", endpoint_host or "", evidence_basis
    )
    return "route:" + fnv1a64_hex(key)


def _provider_states_before(items):
    states = []
    provider = None
    for offset, item in items:
        payload = item.get("payload") if isinstance(item, dict) else None
        if isinstance(payload, dict):
            if item.get("type") == "session_meta" and isinstance(payload.get("model_provider"), str):
                provider = payload["model_provider"]
            settings = payload.get("thread_settings")
            if isinstance(settings, dict) and isinstance(settings.get("model_provider_id"), str):
                provider = settings["model_provider_id"]
        states.append((offset, provider))
    return states


def _provider_at(states, offset):
    current = None
    for event_offset, provider in states:
        if event_offset > offset:
            break
        current = provider
    return current


def _derived_event_id(rollout_source_id: str, byte_offset: int, rec: dict) -> str:
    """spec §3.3：`rollout_source_id(:path.stem) + byte_offset + fnv1a64(canonical_row)`。

    `byte_offset` 只在单个物理 rollout 文件内唯一——命名空间必须是 **stem** 而非
    逻辑 session（同一逻辑 session 的两份续接 rollout 可能都有 offset 0 且同形，
    按 session 命名会误判跨文件重复、少算一笔，2026-09-03 修订）。row hash =
    两端一致的 canonical JSON 的 FNV-1a（canonical/FNV 原语在包顶层
    `source_identity`，与 claude/DSH 共用，逐字节一致由 Stage 1/3 parity 钉测
    验证）。
    """
    return "%s:%d:%s" % (
        rollout_source_id,
        byte_offset,
        fnv1a64_hex(canonical_json(rec)),
    )


def _consumed_to_usage_fact(
    outcome: CodexTokenOutcome,
    source_event_id: str,
    *,
    native_session_id: str,
    machine_namespace: str,
    source_profile: str,
    model_provider: Optional[str] = None,
    route_provider_raw: Optional[str] = None,
    route_endpoint_host: Optional[str] = None,
    route_evidence_basis: str = "missing",
) -> Optional[dict]:
    """Consumed 事件 → UsageFact dict（`build_usage_fact` 输出）。None → builder
    防御性拒绝（`bad_id` 哨兵——builder 是唯一校验方，不许绕开它自证身份合法）。

    token 映射（§3.1/§3.2，决策 A）：`outcome.facts` = fold 的 5 桶
    `(uncached, output, cached, cache_write, reasoning)`；uncached → input、
    cached → cache_read、cache_write → cache_write、output → output（reasoning
    ⊆ output，**绝不叠加** facts[4]——叠加即双计）。
    """
    facts = outcome.facts  # type: ignore[union-attr]  # Consumed 才走到这里
    endpoint = (route_endpoint_host or "").lower()
    normalized_route = route_provider_raw.lower() if isinstance(route_provider_raw, str) else None
    if endpoint == "cogfoundry.ai" or endpoint.endswith(".cogfoundry.ai"):
        normalized_route = "cogfoundry.ai"
    elif endpoint == "api.openai.com" or endpoint.endswith(".api.openai.com"):
        normalized_route = "openai"
    # Official subscription classification requires a session-native route that
    # also resolves to the official OpenAI endpoint.  An explicit conflict (or
    # a custom endpoint) must remain metered/unresolved even when the session's
    # model_provider marker says openai.
    if (model_provider == "openai" and route_endpoint_host is not None
            and route_evidence_basis == "session-native"
            and normalized_route == "openai"):
        provider_id, billing_mode, pricing_basis, unresolved = "openai", "subscription", "session-provider", False
        evidence_basis = "session-native"
    elif model_provider == "openai":
        provider_id, billing_mode, pricing_basis, unresolved = "openai", "metered", "metered_estimate", True
        evidence_basis = route_evidence_basis
    elif model_provider == "custom" or model_provider is None:
        provider_id = normalized_route
        billing_mode = "metered"
        unresolved = True
        pricing_basis = "metered_estimate"
        evidence_basis = route_evidence_basis
    else:
        provider_id = model_provider
        billing_mode = "metered"
        unresolved = route_evidence_basis in {
            "missing", "conflict", "config-current", "env-current"
        }
        pricing_basis = "metered_estimate" if unresolved else "route-observed"
        evidence_basis = route_evidence_basis
    fields = {
        "machine_namespace": machine_namespace,
        "harness": HARNESS,
        "source_profile": source_profile,
        "native_session_id": native_session_id,
        "source_event_id": source_event_id,
        "observation_kind": OBSERVATION_KIND,
        # codex token_count 无原生 id → 恒 derived-hash（§3.3，不存在 native 态）。
        "identity_basis": "derived-hash",
        # event_ts_utc = 顶层 timestamp 回退 payload.timestamp 的**原样串**；真无
        # 时间戳 → None（无时间仍可 emit，fold 无时间也进 by_model，§2.3）。
        "event_ts_utc": outcome.event_ts_utc,
        # time_basis 与 identity_basis 解耦（Stage 1c 原则）：事件带原生时间戳 →
        # "native"；真无时间戳 → None（诚实「无观测时间」，不冒充 estimated）。
        "time_basis": "native" if outcome.event_ts_utc is not None else None,
        # last_token_usage 是 per-request 增量；复读快照已在 §3.5.2 消解，绝不把
        # 累计 total_token_usage 当 delta 发。
        "source_usage_semantics": "delta",
        # provider/model 归属：只留原始证据 model_raw（该 token_count 归到的
        # turn_context 游标值，token_count 自身不带 model）。没有 resolver 就不填
        # model_id/provider_id/normalization_version（Stage 1 同款，不硬编码）。
        "model_raw": outcome.model,
        "provider_raw": model_provider,
        "endpoint_host": route_endpoint_host,
        "provider_id": provider_id,
        "route_evidence_id": (
            _route_evidence_id(
                native_session_id,
                route_provider_raw,
                route_endpoint_host,
                route_evidence_basis,
            )
            if route_endpoint_host is not None or route_provider_raw is not None
            else None
        ),
        "billing_source": provider_id,
        "billing_mode": billing_mode,
        "pricing_basis": pricing_basis,
        "evidence_basis": evidence_basis,
        "normalization_version": "provider-v0.12",
        "attribution_version": "provider-v0.12",
        "uncached_input_tokens": facts[0],
        "cache_read_tokens": facts[2],
        "cache_write_tokens": facts[3],
        "output_tokens": facts[1],
    }
    try:
        return build_usage_fact(fields)
    except ValueError:
        return None


def codex_rollouts_to_usage_facts(
    paths,
    *,
    machine_namespace: str,
    source_profile: str,
    route_endpoint_host: Optional[str] = None,
    route_evidence_basis: str = "missing",
) -> UsageFactEmitResult:
    """整批 rollout 文件 → `(facts, attempts, coverage, malformed)`。

    - `paths`：一个或多个 rollout 文件（Path 或 str）。facts 按传入文件序、文件内
      行序。
    - 发射域 = `paths`；`source_event_id`（stem 命名空间）跨文件去重：同 stem 的
      byte-identical 复本（live/archive 双收）只保留一条 + duplicate attempt；
      异 stem 永不共享 offset 命名空间、绝不误合并（§6.8/§6.9）。
    - attempts/coverage 镜像 spec §4：Repeat（复读）不 emit 也不计；skip /
      unreadable / unattributed 各计一次；Consumed 里 builder 拒绝 → bad_id。
    - degraded 文件（空 / 含坏 JSON 行）贡献零事件、`malformed` +1（codex-cost
      同款语义——坏数据不能静默消失，但也不 abort 整批）。I/O 错误（不可读）向上
      抛，由 CLI 层 exit 2。
    - 不写盘。诊断 CLI 与未来 writer 共用此函数。
    """
    facts: list = []
    attempts = {SKIP: 0, UNREADABLE: 0, UNATTRIBUTED: 0}
    total = 0        # total_token_count_events（每次非 Repeat 的 token_count）
    skip_rows = 0
    duplicate = 0
    bad_id = 0
    malformed = 0
    seen: set = set()
    for p in paths:
        p = Path(p)
        data = p.read_bytes()  # OSError → 上抛（CLI exit 2，镜像 claude-usage-facts）
        if str(p).endswith(".jsonl.zst"):
            from ..adapters.dsh import _zstd, decode_zstd_multi_frame

            if _zstd() is None:
                malformed += 1
                continue
            data = decode_zstd_multi_frame(data)
            if data is None:
                malformed += 1
                continue
        items, degraded = _parse_rollout_bytes(data)
        if degraded is not None:
            malformed += 1
            continue
        native_session_id = _resolve_native_session_id(p, items)
        model_provider = _resolve_model_provider(items)
        route_states = _route_state_before(items, route_endpoint_host, route_evidence_basis)
        provider_states = _provider_states_before(items)
        state = CodexFoldState()
        for offset, item in items:
            outcome = state.apply(item)
            kind = outcome.kind
            if kind is NOT_TOKEN_COUNT or kind is REPEAT:
                continue
            total += 1
            if kind is SKIP:
                attempts[SKIP] += 1
                skip_rows += 1
                continue
            if kind is UNREADABLE:
                attempts[UNREADABLE] += 1
                skip_rows += 1
                continue
            if kind is UNATTRIBUTED:
                attempts[UNATTRIBUTED] += 1
                skip_rows += 1
                continue
            # Consumed：可折进 by_model = 可 emit（§2.3 发射集定义）。
            source_event_id = _derived_event_id(_rollout_source_stem(p), offset, item)
            if source_event_id in seen:
                # §3.5.3 同物理 rollout（同 stem）重复来源 → duplicate、只留一条。
                duplicate += 1
                skip_rows += 1
                continue
            seen.add(source_event_id)
            route_provider_raw_at, route_endpoint_host_at, route_basis_at = _route_at(route_states, offset)
            model_provider_at = _provider_at(provider_states, offset) or model_provider
            fact = _consumed_to_usage_fact(
                outcome, source_event_id,
                native_session_id=native_session_id,
                machine_namespace=machine_namespace,
                source_profile=source_profile,
                model_provider=model_provider_at,
                route_provider_raw=route_provider_raw_at,
                route_endpoint_host=route_endpoint_host_at,
                route_evidence_basis=route_basis_at,
            )
            if fact is None:
                bad_id += 1
                skip_rows += 1
                continue
            facts.append(fact)
    if duplicate:
        attempts["duplicate"] = duplicate
    if bad_id:
        attempts["bad_id"] = bad_id
    return UsageFactEmitResult(
        facts=facts,
        attempts=attempts,
        coverage={"total_token_count_events": total, "fact_rows": len(facts),
                  "skip_rows": skip_rows},
        malformed=malformed,
    )


__all__ = [
    "HARNESS",
    "OBSERVATION_KIND",
    "UsageFactEmitResult",
    "codex_rollouts_to_usage_facts",
    "_iter_raw_lines",
    "_parse_rollout_bytes",
    "_resolve_native_session_id",
    "_derived_event_id",
    "_consumed_to_usage_fact",
]
