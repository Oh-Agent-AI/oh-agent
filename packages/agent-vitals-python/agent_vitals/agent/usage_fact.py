"""v0.7 spec §2：统一事实行（`UsageFact`）—— 逻辑 schema 的序列化契约
（候选 #3）+ 迁移函数表的通用骨架（候选 #4）。

**这不是一次数据平面迁移**：本模块只是候选 #3 描述的"共享序列化契约"这一层
——build/validate/`fact_id` 三个纯函数 + 迁移链的通用 walker，没有任何 harness
adapter 被改造成产出 `UsageFact`、没有任何持久化格式被替换。现有四条账
（dsh state 链 / codex 静态 fold / claude ledger / workbuddy credit_json）
继续原样工作，本模块不触碰它们一个字节。这是 v0.7 spec 状态行明确写的
"本版整体仍未立项"下，唯一能安全独立交付的一块：纯计算、零 I/O、零现有格式
变更，随时可以被拿掉而不影响任何现有功能。

**明确没做的**（诚实边界，不是遗漏）：
- 没有把任何一个 harness adapter 接上这份契约——那需要逐执行环境的迁移评审
  （§0.3 的顺序约束），本模块只是评审前置的"契约先写清楚"那一步。
- `billing_date` 派生列（§2.1 时间行）没有在这里实现——它依赖峰谷/归日规则
  版本，本身就是"版本化视图投影"（spec 原文），不是基本事实的一部分；放进
  builder 会把版本化的派生逻辑焊死在契约层，违反"事实保留原始时间分辨率、
  派生列可重建"的设计前提。
- 迁移函数表目前**没有注册任何真实迁移**——`CURRENT_SCHEMA_VERSION = 1` 是
  这份契约的第一个版本，还没有 v2。`migrate_chain` 是通用 walker，用一组
  测试专用的合成迁移表验证机制本身（线性 vN→vN+1、拒绝跨版本跳迁、拒绝
  未来版本、幂等），不是靠一个假的生产迁移凑数。
- 没有文件级原子写入/fsync/故障注入（§5「迁移与故障恢复」）——那需要真实的
  持久化调用点才有意义验证；本模块目前是纯内存契约，硬写一套无人使用的
  文件 I/O 测不出真问题，只会制造一个自己骗自己通过的假验收。

Rust 平行实现见 `crates/agent-vitals-domain/src/contracts/usage_fact.rs`（parity 由
`tests/test_usage_fact.py` 钉住）。
"""

from ..source_identity import fnv1a64_hex  # UsageFact ID 的 FNV 原语共用（见 fact_id docstring）


# 当前 schema 版本（v0.7 spec §4.1：「新的 UsageFact 序列化契约从
# schema_version=1 起步；旧 today/month/ledger 不是 UsageFact v0，不能靠改键
# 假装无损迁移」）。
CURRENT_SCHEMA_VERSION = 1

# §2.1 表的完整键清单——候选 #2（键名收敛为单一共享词表）在这份新契约上直接
# 落地：Python/Rust 共享同一份字面量清单（parity 测试逐项比对），不是各自
# 维护一份可能漂移的字段名。
#
# **身份元组必须在文档里**——`machine_namespace` 与 `native_session_id` 是
# `fact_id` 的输入（§2.1「统一幂等键」公式），不写进文档则持久化后无法
# 从文档独立复算主键，也无法审计跨机器/跨会话碰撞。两个字段同时是
# `_IDENTITY_INPUT_FIELDS`（builder 必填）与 `USAGE_FACT_FIELDS`（序列化
# 必出）——同一份契约下「身份既不可缺也不可隐」。
USAGE_FACT_FIELDS = (
    # 身份
    "fact_id", "identity_basis", "observation_kind",
    "machine_namespace", "native_session_id",
    # 会话引用
    "session_key_ref", "session_key_orphan",
    # 来源
    "harness", "source_profile", "source_event_id", "source_revision", "adapter_version",
    # 模型归属
    "provider_raw", "endpoint_host", "model_raw", "provider_id", "model_id", "normalization_version",
    "route_evidence_id", "attribution_version",
    # 时间
    "event_ts_utc", "event_tz_basis", "time_basis",
    # 去重语义
    "source_usage_semantics", "provider_request_id", "provider_billing_id",
    "turn", "step", "call_id",
    # token 度量
    "uncached_input_tokens", "cache_read_tokens", "cache_write_tokens", "output_tokens",
    # 计费归属
    # `billing_template_id`：Rust 侧 2e011fc（fix(v0.12) preserve billing evidence by
    # pricing snapshot）加进契约，Python 漏跟——四执行环境的 usage-fact 差分在带二进制时
    # 全红，被 E4a 的 workbuddy parity 逼出来（2026-09-11）。契约是一份字面量清单、
    # 两语言逐项比对，少一个键就是所有 emitter 的 `--json` 输出双侧不等。
    "billing_source", "billing_mode", "pricing_basis", "billing_template_id",
    # 执行环境金额
    "amount_decimal", "currency", "amount_basis",
    # 套餐证据
    "account_ref", "billing_period_start", "billing_period_end", "product_scope",
    "quota_window", "is_using_overage", "evidence_basis",
)

# 6 个身份输入字段缺一不可（§2.1「统一幂等键」公式的入参）——不含 fact_id
# 本身（那是这 6 个字段算出来的输出，不是输入）。
_IDENTITY_INPUT_FIELDS = (
    "machine_namespace", "harness", "source_profile", "native_session_id",
    "source_event_id", "observation_kind",
)

# token 度量必须是非负整数（真实 0 与缺失可区分——缺失时字段整体不在
# fields 里，不会走到这条校验；fields 里显式给了就必须合法）。
_TOKEN_FIELDS = (
    "uncached_input_tokens", "cache_read_tokens", "cache_write_tokens", "output_tokens",
)


def fact_id(machine_namespace, harness, source_profile, native_session_id,
           source_event_id, observation_kind):
    """`fact_id` 哈希——v0.7 spec §2.1「统一幂等键」公式：
    `hash(machine_namespace, harness, source_profile, native_session_id,
          source_event_id, observation_kind)`。

    用 FNV-1a 而不是密码学哈希：与 `usage.py::_compaction_identity` 同一条
    纪律——这个值只用作去重身份，不需要抗碰撞到密码学强度。FNV 原语本身取自
    包顶层 `source_identity.fnv1a64_hex`（同一边界，Stage 3 拍板把 UsageFact
    ID 也接进共享层）；跨语言字节相同由 Rust 镜像同一算法保证（parity 测试
    钉住）。字段间用 `\\x1f`（unit separator，真实字段值里几乎不可能出现的
    控制字符）拼接，防止 `("ab","c")` 与 `("a","bc")` 撞出同一个哈希。
    """
    joined = "\x1f".join([machine_namespace, harness, source_profile,
                          native_session_id, source_event_id, observation_kind])
    return "uf1-" + fnv1a64_hex(joined)


def build_usage_fact(fields):
    """`fields` (dict) → 一份完整的 `UsageFact` 文档，或抛 `ValueError`（诚实
    报错，不猜、不吞；`args[0]` 是问题清单，每条点名具体字段）。

    - 6 个身份输入字段（`_IDENTITY_INPUT_FIELDS`）必须存在且非空字符串——
      `fact_id` 由它们算出，缺一个就无法产生稳定身份。
    - `identity_basis` 未显式给出时默认 `"native"`；调用方在用「规范化原始
      记录 + 文件稳定身份」的 hash fallback 时**必须**显式传
      `identity_basis="derived-hash"`（§2.1 原文纪律），本函数不会替调用方
      做这个判断——它不知道 `source_event_id` 是不是真的来自执行环境原生 id。
    - token 度量字段若给出，必须是非负整数；给出非法值时报具体字段名，不
      静默清零或吞掉。
    - `fact_id`/`schema_version` 由本函数计算/stamp，调用方传了会被覆盖
      ——身份必须内部一致，不接受外部声称的身份。
    - `USAGE_FACT_FIELDS` 里未被 `fields` 覆盖的键，输出里统一置 `None`——
      与「缺失与真实 0 必须可区分」的契约对应，`None` 是「这个执行环境没有这项
      证据」，不是「这项是 0」。
    """
    fields = fields or {}
    problems = []

    def get_str(k):
        v = fields.get(k)
        return v if isinstance(v, str) and v else None

    identity = []
    for k in _IDENTITY_INPUT_FIELDS:
        v = get_str(k)
        if v is None:
            problems.append("missing or empty identity field: %s" % k)
        else:
            identity.append(v)

    for k in _TOKEN_FIELDS:
        if k in fields and fields[k] is not None:
            v = fields[k]
            if isinstance(v, bool) or not isinstance(v, int) or v < 0:
                problems.append(
                    "token field must be a non-negative integer or null: %s" % k)

    if problems:
        raise ValueError(problems)

    out = {k: fields.get(k) for k in USAGE_FACT_FIELDS}
    out["fact_id"] = fact_id(*identity)
    out["identity_basis"] = fields.get("identity_basis") or "native"
    out["schema_version"] = CURRENT_SCHEMA_VERSION
    return out


def migrate_chain(doc, migrations, target_version):
    """迁移链结果——用带 `status` 标签的 dict 而不是异常/tuple，方便 Rust
    镜像输出同一形状（parity 测试直接比较整个结构）。`migrations` 是
    `{version: fn(doc) -> doc}`。

    - `"current"`：文档已经是目标版本，原样返回，不是"迁移了一次空动作"。
    - `"migrated"`：文档从旧版本走完整条链到达目标版本。
    - `"future-readonly"`：文档版本号比目标版本新——**不迁移、不报错**，
      原样返回并打一个 `warning`；调用方可以读但不得写回（§5「未知未来版本
      拒绝写入、允许带告警只读」），写回与否是调用方的责任，本函数只负责
      标注。
    - `"error"`：文档缺 `schema_version` 字段，或链路中间某个中间版本没有
      对应的迁移函数（迁移表本身不完整）——两种情况都不是"当前版本"也不是
      "未来版本"，无法安全处理，诚实报错而不是瞎猜一个版本。
    """
    version = doc.get("schema_version") if isinstance(doc, dict) else None
    if not isinstance(version, int) or isinstance(version, bool):
        return {"status": "error", "doc": doc, "error": "missing schema_version"}
    # P1-2 修订：schema_version 必须是 u32 表示范围内的非负整数（与 Rust
    # 镜像同步——Rust 侧 as u32 会截断，Python int 是任意精度，靠这条显式
    # 校验保持字节一致）。u32::MAX = 0xFFFFFFFF。
    if version < 0 or version > 0xFFFFFFFF:
        return {
            "status": "error",
            "doc": doc,
            "error": "schema_version %d exceeds u32::MAX (4294967295)" % version,
        }
    if version == target_version:
        return {"status": "current", "doc": doc}
    if version > target_version:
        return {
            "status": "future-readonly",
            "doc": doc,
            "warning": ("document schema_version %d is newer than this "
                       "reader's target %d; read-only, do not write back"
                       % (version, target_version)),
        }
    cur = doc
    v = version
    while v < target_version:
        step = migrations.get(v)
        if step is None:
            return {
                "status": "error",
                "doc": cur,
                "error": "no migration registered for schema_version %d -> %d"
                        % (v, v + 1),
            }
        cur = step(cur)
        # P1-3 修订：迁移步必须实际把版本号抬到下一档。真实迁移若忘了
        # 升 schema_version，写链会拿旧格式当新格式写回——比「找不到迁移
        # 函数」更隐蔽，因为它返回了 "migrated" 标签。逐步校验，坏迁移
        # 立即报错。校验前先确认仍是合法 u32 范围（P1-2）。
        next_v = cur.get("schema_version") if isinstance(cur, dict) else None
        if not isinstance(next_v, int) or isinstance(next_v, bool):
            return {
                "status": "error",
                "doc": cur,
                "error": "migration step for schema_version %d removed schema_version field (expected %d)"
                        % (v, v + 1),
            }
        if next_v > 0xFFFFFFFF:
            return {
                "status": "error",
                "doc": cur,
                "error": "migration step produced schema_version %d exceeding u32::MAX"
                        % next_v,
            }
        if next_v != v + 1:
            return {
                "status": "error",
                "doc": cur,
                "error": "migration step for schema_version %d did not advance version (got %d, expected %d)"
                        % (v, next_v, v + 1),
            }
        v += 1
    return {"status": "migrated", "doc": cur}
