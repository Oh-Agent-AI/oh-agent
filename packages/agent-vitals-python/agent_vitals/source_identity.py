"""v0.7 Stage 3：source-event 身份原语（canonical JSON + FNV-1a）共享层。

R3 拍板（2026-09-03，docs/VITALS_CORE_V0_7_STAGE_3_DSH_ADAPTER.md §7）：
「observer 是身份形成边界」要求 observer 开槽即算出 `source_event_id`，而
canonical+FNV 是跨语言共享的纯函数——**不许在 usage.py 里长第二份**。本模块
把 Stage 1 Claude emitter 的 helper（`claude_usage_fact._canonical_row_json` /
`_fnv1a_hex`）抽出来，四方共同调用：

```text
Claude adapter ─┐
Codex adapter  ─┼─► source_identity
DSH observer   ─┤
UsageFact ID   ─┘
```

**过渡归属**：本模块暂居包顶层，只为让两处调用方（agent 子树、将来 harness
adapter）能同一处引用。这是 Agent UsageFact/source-event 身份契约，不是任意
领域都要的通用机制——将来拆出 `agent-vitals-harnesses` 包时，本模块整体迁往
`shared/source_identity.py`。

Rust 平行实现：`crates/agent-vitals-domain/src/contracts/source_identity.rs`（同字节）。
`canonical_json` 与 Rust `source_identity::canonical_json` 对同一输入产同字节
（sort_keys + 紧凑分隔 + 不转义非 ASCII）；`fnv1a64_hex` 与 Rust
`source_identity::fnv1a64_hex` 同一初值/乘子/hex 格式。Stage 1/2 parity 钉测
已跨语言验证两侧逐字节一致。
"""

import json


def fnv1a64_hex(text: str) -> str:
    """FNV-1a 64 → 16 hex——与 `usage_fact.fact_id` 同一初值/乘子（Stage 3 把
    fact_id 的 UsageFact ID 也接进本共享层，见 usage_fact.py），只换语义（这里
    hash 的是 canonical row/身份串，不是 identity 元组），所以返回裸 hex、不带
    "uf1-"。跨语言字节相同由 Rust `source_identity::fnv1a64_hex` 同一算法保证。
    """
    h = 0xcbf29ce484222325
    for b in text.encode("utf-8"):
        h ^= b
        h = (h * 0x100000001b3) & 0xFFFFFFFFFFFFFFFF
    return "%016x" % h


def canonical_json(value) -> str:
    """canonical JSON（R1 §3.2「row hash 使用两端一致的 canonical JSON」）：
    sort_keys + 紧凑分隔 + 不转义非 ASCII。Python `json.dumps` 与 Rust 手写
    canonical serializer（`source_identity::canonical_json`）对整数/字符串/
    布尔/null 字节一致；canonical 行里的数值只有整数 token 计数（float
    costUSD 只在 cost-state，不产 fact），不存在浮点表示法分叉。codex
    token_count 的 `rate_limits.*.used_percent` 是真机浮点（0..100 区间），
    canonical 分叉只会在区间外的小/大浮点出现——fixture 与真机值都在 0..100，
    parity 钉测带着浮点行跑，分叉会当场红。
    """
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False)
