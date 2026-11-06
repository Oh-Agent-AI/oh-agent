"""v0.7 Stage 3 commit 2：DSH 会话 → UsageFact emitter（harness adapter，不进 Core）。

把一份 DSH 会话文件（明文 JSONL 或 zstd 多帧）的 **post-fork 逐请求消耗**重放成
`UsageFact` 事实流。spec `docs/VITALS_CORE_V0_7_STAGE_3_DSH_ADAPTER.md`（v4）的
Python 实现；Rust 镜像 `src/agent/dsh_usage_fact.rs`。Python↔Rust stdout byte-parity
由 `tests/test_dsh_usage_fact.py` 钉住。

**本模块不解释任何 DSH wire shape**——读/解码（`adapters/dsh.py::read_session_text`）、
reshape（`parse_session_log`）、身份与 profile（`adapters/dsh_source_profile.py::dsh_header` /
`dsh_source_profile`）、逐槽观测（`usage.py::dsh_usage_observations`）、残差折叠
（`usage_fold_checkpoint`）、UsageFact 契约（`usage_fact.build_usage_fact`）全部复用，
一行新解释都不写。**emit surface = 共享 observer 的相邻槽**：每条 `DshUsageObservation`
emit 一个 fact，身份字段由 observer 开槽即固化（§3.3），本模块只消费、绝不重读日志
复算 source_event_id。

**strict 单文件诊断**（§4.1）：读/解码 → 解析 → 身份（缺 session id）→ 归属（缺 cwd
且无显式 profile）→ 守卫（source_event_id 重复）都是**硬错误**（raise
`DshUsageFactError`，CLI exit 2），不输出空成功伪装成「没有用量」。成功结果恒满足
`observation_rows == fact_rows` 且 source_event_id 全唯一——没有 fake-empty / 部分成功
路径，等式靠不存在这些路径保证。诚实空集只留给「干净解析 + post-fork 零样本」
（exit 0 `facts=[]` + 全 0 coverage，§4.3，与 exit 2 形状可区分）。

RFC3339-ms-Z（§3.6）：epoch ms → `YYYY-MM-DDTHH:MM:SS.mmmZ` 的**纯整数**函数，不用
`datetime.fromtimestamp(ms/1000)` 浮点（避免精度/闰秒分叉）。`time_basis` 显式判空：
合法 epoch 0 是真时间。civil-from-days 用 Hinnant 整数算法（与 Rust core
`budget.rs::civil_from_days` 同一算法族，Python `//` 即 floor、Rust `div_euclid` 同
floor，非负输入下字节一致）。跨语言 parity battery 在测试钉住。
"""

from pathlib import Path
from typing import NamedTuple, Optional

from ..adapters.dsh import read_session_text, parse_session_log
from ..util import post_fork
from ..source_identity import fnv1a64_hex
from ..adapters.dsh_source_profile import dsh_header, dsh_source_profile
from .usage import dsh_usage_observations, usage_fold_checkpoint
from .usage_fact import build_usage_fact

HARNESS = "dsh"                # == R2a harness_kind
OBSERVATION_KIND = "assistant-usage"  # 与 claude/codex 同词汇

# 读/解码错误码 → 人读消息。Rust 镜像产出同一字符串（parity 消息同码）。
_READ_ERROR_MESSAGES = {
    "file-missing": "session file missing or unreadable",
    "unsupported-compression": "zstd support unavailable (zstandard not installed)",
    "zstd-decode-error": "zstd decode failed (truncated or corrupt frame)",
}


class DshUsageFactError(Exception):
    """strict 硬错误。`args[0]` 是 `(code, message)`；code ∈ {file-missing,
    unsupported-compression, zstd-decode-error, parse-degraded,
    missing-session-id, unattributed, duplicate-source-event-id}。

    `__str__` 返回 `"code: message"`——CLI 的 stderr 因此与 Rust 侧 `format!`
    出的同一形状对齐（parity 只要求同码，这里把整条也做成同源）。
    """

    def __init__(self, code: str, message: str):
        super().__init__((code, message))
        self.code = code
        self.message = message

    def __str__(self) -> str:
        return "%s: %s" % (self.code, self.message)


class DshUsageFactEmitResult(NamedTuple):
    """`dsh_session_to_usage_facts` 的返回（spec §5）。`facts` = 逐槽一行
    `build_usage_fact` 输出，source_event_id 已查重；`coverage` 键见 §4.2。"""
    facts: list          # List[Dict]
    coverage: dict       # {observation_rows, fact_rows, unaccounted_events, unaccounted_tokens}


# ────────────────────────────────────────────────────────────────────────
# RFC3339-ms-Z（纯整数，§3.6）
# ────────────────────────────────────────────────────────────────────────

def _civil_from_days(z):
    """1970 起的天数 → (y, m, d)——Hinnant civil-from-days 整数算法（与 Rust
    core `budget.rs::civil_from_days` 同一算法；Python `//` floor 与 Rust
    `div_euclid` 在非负输入下等价，epoch 之后的天数恒非负）。"""
    z += 719468
    era = z // 146097
    doe = z - era * 146097
    yoe = (doe - doe // 1460 + doe // 36524 - doe // 146096) // 365
    y = yoe + era * 400
    doy = doe - (365 * yoe + yoe // 4 - yoe // 100)
    mp = (5 * doy + 2) // 153
    d = doy - (153 * mp + 2) // 5 + 1
    m = mp + 3 if mp < 10 else mp - 9
    y = y + 1 if m <= 2 else y
    return y, m, d


def _rfc3339_ms_z(ms: int) -> str:
    """epoch 毫秒 → RFC3339-UTC 固定毫秒 + `Z`（`1970-01-01T00:00:00.000Z`）。

    纯整数运算（`divmod` 即 floor）：不用 `datetime.fromtimestamp(ms/1000)`
    浮点路径（spec §3.6 禁止）。ms 非负（DSH `time` 恒 epoch 之后）；负数若传入
    也会按 floor 得到与 Rust `div_euclid`/`rem_euclid` 一致的结果，防未来分叉。
    """
    secs, sub = divmod(ms, 1000)
    days, tod = divmod(secs, 86400)
    y, m, d = _civil_from_days(days)
    return "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ" % (
        y, m, d, tod // 3600, (tod // 60) % 60, tod % 60, sub)


# ────────────────────────────────────────────────────────────────────────
# 主入口
# ────────────────────────────────────────────────────────────────────────

def dsh_session_to_usage_facts(
    path,
    *,
    machine_namespace: str,
    source_profile: Optional[str] = None,
) -> DshUsageFactEmitResult:
    """单份 DSH 会话文件 → `(facts, coverage)`（spec §5）。

    - `source_profile=None` → 从 header cwd 派生（`dsh_source_profile`）；cwd 缺失
      → raise `unattributed`（不给 actionable 之外的空成功）。
    - 身份字段（harness/machine_namespace/source_profile/native_session_id/
      source_event_id/observation_kind）都来自 observer 固化身份或本函数参数——
      R2a 四元对齐即验收 #7。
    - 归属失败 / duplicate → raise `DshUsageFactError`（不返回空成功、不静默去重）。
    - 干净空（解析 OK + post-fork 零样本）→ `facts=[]` + 全 0 coverage。
    """
    # §4.1 分层：读/解码
    text, read_err = read_session_text(path)
    if read_err is not None:
        raise DshUsageFactError(
            read_err, _READ_ERROR_MESSAGES[read_err])

    # §4.1 分层：解析（整份可用才继续；降级 = 整份不可用，不是读到 0 条）
    ev = parse_session_log(text)
    if ev.get("usage_events") is None:
        raise DshUsageFactError(
            "parse-degraded", "session parse degraded (%s)" % ev.get("degraded"))

    # §4.1 分层：身份（缺 session id 不是 DSH 会话）。空串 id 同缺失——`build_usage_fact`
    # 拒绝空身份字段，空 id 会被后续静默 skip，故在此即硬错误（诚实、可诊断）。
    hdr = dsh_header(text)
    if hdr is None or not hdr[0]:
        raise DshUsageFactError(
            "missing-session-id",
            "session header is missing id (not a DSH session or cannot "
            "establish identity)")
    native_session_id, cwd = hdr

    # §4.1 分层：归属。显式 profile 优先；否则 header cwd 派生；cwd 缺失 → 硬错误，
    # 给 actionable 提示。空串 profile 不当证据（空串当 "已提供" 会把空身份送进
    # build_usage_fact，Python 抛 ValueError、Rust 走 builder Err——两侧会为同一输入
    # 报不同的错）→ 空串同 None、落到 cwd 派生或 unattributed，两语言行为恒一。
    # 空串 cwd 则相反：只来自 dsh_header 给了非 None 的 cwd=""（构造会话），
    # dsh_source_profile("") 会产出 "--"，镜像两侧一致，不冒充。
    if source_profile:
        profile = source_profile
    elif cwd is not None:
        profile = dsh_source_profile(cwd)
    else:
        raise DshUsageFactError(
            "unattributed",
            "session header has no cwd; pass an explicit --source-profile <P>")

    # 分叉过滤一次、两个消费方共用。observer 内部再 post_fork 一次（幂等：marker
    # seq=None 被保留、二次过滤结果不变）；`usage_fold_checkpoint` 不自己 post_fork
    # （调用方负责），所以这里显式 post_fork 后传给两者。
    post_events = post_fork(ev["usage_events"])
    observations = dsh_usage_observations(post_events)
    state = usage_fold_checkpoint(post_events)

    # §3.5/§4.1 守卫：出账前 seen-set 查重。fold 去重是**相邻 run**，非相邻同
    # compactionId 重现会折出两条同 source_event_id 的槽——检出即整份硬错误、不静默
    # 去重（吞掉后一条会让 UsageFact 总量与 fold 总量对不上账）。
    seen: set = set()
    facts: list = []
    for obs in observations:
        if obs.source_event_id in seen:
            raise DshUsageFactError(
                "duplicate-source-event-id",
                "duplicate source_event_id: %s" % obs.source_event_id)
        seen.add(obs.source_event_id)
        facts.append(_observation_to_usage_fact(
            obs, machine_namespace, native_session_id, profile))

    # §4.2 coverage：unaccounted 是「文件报了 token 形状但 fold/事实都没接住」的
    # 残差哨兵（usage_fold_checkpoint 的 unaccounted dict → 求和）。`observation_rows
    # == fact_rows` 由「无 fake-empty / 部分成功路径」无条件保证，不靠兜底计数凑。
    unaccounted = state["unaccounted"]
    coverage = {
        "observation_rows": len(observations),
        "fact_rows": len(facts),
        "unaccounted_events": sum(v["count"] for v in unaccounted.values()),
        "unaccounted_tokens": sum(v["tokens_seen"] for v in unaccounted.values()),
    }
    return DshUsageFactEmitResult(facts=facts, coverage=coverage)


def _observation_to_usage_fact(obs, machine_namespace, native_session_id, profile):
    """`DshUsageObservation` → `build_usage_fact` 输入 dict（§3.1 映射表）。

    `event_ts_utc` = 支配样本 epoch ms → RFC3339-ms-Z；真无 time（None）→ None +
    `time_basis=None`（显式判空，epoch 0 是真时间、不是「无时间」）。四桶原样带
    None（`_opt_int` 语义，缺项 ≠ 0，§3.2）。turn/step：普通槽为真实 int；
    compaction 槽 observer 已置 None（不泄漏内部负号哈希）。
    """
    fields = {
        "machine_namespace": machine_namespace,
        "harness": HARNESS,
        "source_profile": profile,
        "native_session_id": native_session_id,
        "source_event_id": obs.source_event_id,
        "observation_kind": OBSERVATION_KIND,
        "identity_basis": obs.identity_basis,
        "event_ts_utc": _rfc3339_ms_z(obs.time) if obs.time is not None else None,
        # time_basis 显式判空，不用 truthiness：合法 epoch 0（time=0）是真时间
        "time_basis": "native" if obs.time is not None else None,
        "source_usage_semantics": "delta",
        # provider/model 原始证据（§3.4）：observer 已收敛成原始字符串或 None——
        # 绝无 __ambiguous__（那是 token_by_model 聚合层的派生状态，不进 fact）。
        "provider_raw": obs.provider_raw,
        "provider_id": obs.provider_raw if isinstance(obs.provider_raw, str) and obs.provider_raw.strip() else None,
        "route_evidence_id": (
            "route:{}".format(fnv1a64_hex("{}|{}|{}".format(
                native_session_id, obs.provider_raw, "session-native"
            )))
            if isinstance(obs.provider_raw, str) and obs.provider_raw.strip()
            else None
        ),
        "billing_source": obs.provider_raw if isinstance(obs.provider_raw, str) and obs.provider_raw.strip() else None,
        "billing_mode": "metered",
        # Route evidence identifies the provider, but does not itself prove a
        # settled bill. Keep the fact at the conservative estimate basis; the
        # projection layer may promote an official, measured source separately.
        "pricing_basis": "metered_estimate",
        "evidence_basis": "session-native" if obs.provider_raw else "missing",
        "normalization_version": "provider-v0.11",
        "attribution_version": "provider-v0.11",
        "model_raw": obs.model_raw,
        "uncached_input_tokens": obs.uncached_input_tokens,
        "cache_read_tokens": obs.cache_read_tokens,
        "cache_write_tokens": obs.cache_write_tokens,
        "output_tokens": obs.output_tokens,
        "turn": obs.turn,
        "step": obs.step,
    }
    # builder 是唯一校验方：不绕开它自证身份合法。DSH 无 bad_id 类别——obs 的
    # 身份字段恒非空、四桶恒 None/非负 int，正常路径走不到 ValueError（真触发是
    # 调用方传了空 machine_namespace 之类的参数错，让它如实炸）。
    return build_usage_fact(fields)


__all__ = [
    "HARNESS",
    "OBSERVATION_KIND",
    "DshUsageFactError",
    "DshUsageFactEmitResult",
    "dsh_session_to_usage_facts",
    "_rfc3339_ms_z",
]
