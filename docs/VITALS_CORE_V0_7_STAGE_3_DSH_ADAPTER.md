# Vitals Core v0.7 —— Stage 3：DSH state chain → UsageFact（映射小规格）

> 前置：`VITALS_CORE_V0_7_ADAPTER_DECISIONS.md` 决策 A/B/C/D/D′ + Stage 1（claude）
> / Stage 2（codex）规格。本文把决策 B(a)「DSH 从 usage_events 原始流 replay」细化
> 成可实施、可验收的实现规格。workbuddy 流继续排除（不碰）。

> **修订记录**：
> - **v2（2026-09-03，首轮 review）**：取消 `path.stem`、身份改 `first_sample_seq`
>   锚定、架构改共享 observer、`event_ts_utc` 统一 RFC3339。见 §9 归档的 v1 错误。
> - **v3（2026-09-03，二轮 review）**：`provider_raw` 取消 `__ambiguous__`（只存原始
>   证据）；身份改三段公式并与 `identity_basis` 对齐（compaction 原生 id → native）；
>   归属失败改 strict（硬错误，不伪装空成功）；架构表述改「共享样本解析 + 双消费者
>   observer」，`token_by_model` 保留原 fold；补 observer shadow 覆盖语义。
> - **v4（2026-09-03，三轮 review，本文）**：① **无 compactionId 的身份也锚定首样本**
>   ——observer 开槽即固化 `source_event_id`/`identity_basis`，shadow 永不覆盖（v3
>   对无 id compaction 的 hash 输入误写「支配样本」，append 会改写 fact_id）；②
>   **加 duplicate-source-event-id 硬错误守卫**——fold 去重是**相邻 run**（`last`
>   比较，`usage.py:626-634`），非相邻同 compactionId 重现会折出两个槽、collide 同一
>   `compaction:<id>`，emitter 检出即抛、**不静默去重**（否则 UsageFact 总量与 fold
>   总量对不上账）；「结构性不可能 duplicate」改为「正常语料预期不出现，strict
>   invariant 守卫」；③ Core 边界表述修正——共享 observer 属 usage domain/core，
>   emitter/DSH 文件解析/CLI 属 harness adapter（v3 §0 的「不进 Core」与 Commit 1 动
>   `usage.py`/`usage.rs` 矛盾）；④ 措辞：同模型换 provider 是**同一会话内**。
> - **已落地（2026-09-03）**：v4 规格通过 review，Commit 1（`ba01147`，canonical/FNV
>   原语下沉 + `DshUsageObservation` 开槽即固化身份 + `request_metrics` 字节冻结）
>   与 Commit 2（`753cbdc`，`dsh_usage_fact.{py,rs}` emitter + `dsh-usage-facts` CLI
>   + 23 验收：18 direct-call + 5 语料 byte-parity）双侧落地，全套 gate 绿
>   （Python 1142 / `cargo test --release` 全绿 / clippy clean / 15+15 golden 逐字节
>   一致）。v0.7 完成记录见 `VITALS_CORE_V0_7_DATA_PLANE_SPEC.md` §7。

## 0. 当前结论

- **emit surface = 共享 observer 的逐槽出口**，不是 request_metrics 的展示 DTO，更
  不是「一条 usage 事件 → 一个 fact」。决策 C.1 入口描述的
  `adapters/dsh.py::usage_fold_state`（事件级）是当时的近似——该函数不存在。逐事件
  emit 会把同一笔请求的 `assistant/chunk{type:usage}` 与 `assistant/message{usage}`
  当两笔发（两事件同 `(turn, step)`、同一累计值，fold 用替换语义只算一次）——双计。
- **架构 = 共享样本解析 + 双消费者 observer**（§2.2）：共享 `_usage_sample` 负责
  wire shape 解析（不动）；新 observer 同时服务 request_metrics（展示，输出字节冻结）
  与 UsageFact emitter；`token_by_model` **保留原 fold（`_usage_fold_into`）不改道**
  ——两条路径以 reconcile/golden 测试保证一致。observer 产出每最终槽的
  `DshUsageObservation`，携带 emitter 需要的全部测量字段（含 provider_raw、
  first_sample_seq、compaction_id）与**开槽即固化的身份**（source_event_id +
  identity_basis）。
- **身份一律锚定首样本、开槽即固化**（§3.3）：无论哪段公式，observer 在该槽第一个
  usage 样本到达时就计算并存下 `source_event_id`/`identity_basis`，后续 shadow 只更新
  token/time/model/provider，**永不覆盖身份**：
  ```text
  普通请求     source_event_id = "request:derived:{fnv1a64(canonical_json({turn, step, seq:first_sample_seq}))}"
               identity_basis  = "derived-hash"
  有 compactionId: source_event_id = "compaction:{compaction_id}"
               identity_basis  = "native"        # compaction_id 是执行环境原生标识
  无 compactionId: source_event_id = "compaction:derived:{first_sample_identity_hash}"
               identity_basis  = "derived-hash"  # hash 在开槽时对首样本 canonical 行算好并冻结
  ```
  `first_sample_seq` / `first_sample_identity_hash` 在 shadow 下不变 → 日志 append（同
  槽 shadow、或全新请求）都**不重写旧 fact_id**。`seq=None` 有确定性降级（§3.3）。
- **provider_raw 只存原始证据**（§3.4）：普通请求 = 支配样本那一刻 header 游标里的
  `config.provider`（原始字符串或 None）；compaction = 自带 `data.provider`。
  `__ambiguous__` **永不出现在 fact**——它是 `token_by_model` 聚合后的派生状态，只在
  聚合视图。**同一会话内**同模型切换 provider → 两条 fact 各自保留原始 provider，聚合
  层才报 ambiguous（§6 #6b 新测）。
- **成功结果禁止重复 source_event_id**（§3.5/§4.1）：fold 去重是相邻 run，非相邻同
  compactionId 重现会产出两条同 id 槽 → emitter 检出重复即抛
  `duplicate-source-event-id` 硬错误、**不静默去重**。正常语料预期不出现，由 strict
  invariant 守卫。
- **event_ts_utc 统一 RFC3339 UTC 字符串**（固定毫秒 + `Z`，如
  `2025-06-15T15:08:24.000Z`）。adapter 边界正是消除执行环境 wire 差异的地方，不能把
  「先判 harness 再解析字段」推给下游。
- **归属失败 = 硬错误，不是空成功**（§4.1）：缺 header session id、或缺 cwd 且无显式
  profile → CLI exit 2 / library raise。诚实空集只留给「干净会话、post-fork 无
  usage」。因此 DSH 的 emit result **没有** attempts/malformed 类别（结构性不存在），
  coverage 只有 `{observation_rows, fact_rows, unaccounted_events, unaccounted_tokens}`
  ，且成功 emit 时 `observation_rows == fact_rows`、source_event_id 全唯一，无条件
  成立。
- **Core 边界**：共享 observer 属 usage domain/core（Python `agent/usage.py` ↔ Rust
  core `usage.rs`，与 request_metrics/fold 同层）；UsageFact emitter、DSH 文件解析、
  文件 I/O、CLI 属 harness adapter。Stage 3 **不把 DSH 文件解析或写盘职责放入 Core**。
- 实施拆两 commit，镜像 Stage 2：**Commit 1** = byte-neutral 共享 observer refactor
  （request_metrics 输出字节冻结，零漂移门）；**Commit 2** = UsageFact emitter +
  诊断 CLI + fixture + 验收。
- 不改 `adapters/dsh.py` / `usage.py` 的 fold 聚合 / checkpoint/resume / 解码任何一个
  字节；不写盘；不夹带 R3 写链。

## 1. 目标与不动边界

### 1.1 Stage 3 目标

把一份 DSH 会话文件（明文 JSONL 或 zstd 多帧）的 **post-fork 逐请求消耗**重放成
`UsageFact` 事实流：驱动与展示/聚合对账的**共享 observer**（与 `request_metrics` 同
源、与 `token_by_model` reconcile），产出稳定槽身份的 `(facts, coverage)`，并提供只读
诊断 CLI（Python `dsh-usage-facts` ↔ Rust `dsh-usage-facts`，byte-parity）。v0.7 三项
adapter emit 工作的收尾（决策 C 顺序 claude→codex→dsh）。本阶段只 emit、不持久化；
完成后**不**自动修复工作台 P0（那是 R3 写链的事，不在本 stage）。

### 1.2 本阶段不做 / Core 边界

- **共享 observer 属 usage domain/core**（Python `agent/usage.py`、Rust core
  `usage.rs`——与 request_metrics/fold 所在同层）；**UsageFact emitter、DSH 文件
  解析、文件 I/O 与 CLI 属 harness adapter**（`agent/dsh_usage_fact.py` /
  `src/agent/dsh_usage_fact.rs`）。**Stage 3 不把 DSH 文件解析或写盘职责放入 Core**。
- **不重写/不新增 DSH 事件解释**：解码（`decode_zstd_multi_frame` /
  `read_session_text`）、reshape（`parse_session_log`）原样复用。
- **不碰 `token_by_model` / checkpoint / resume 的实现**：它是按模型聚合的 fold 权威
  与可续折叠契约，改道 observer 的收益低于其 resumability 爆炸半径；两条路径的一致
  由既有 reconcile 测试继续钉住（§2.2）。
- **不修 fold 的相邻去重语义**（§3.5）：非相邻同槽重复是 fold 既有边界，Stage 3 不
  扩大去修，只在 emitter 出账前加 duplicate 硬错误守卫。
- **不做 checkpoint/resume 增量写入**（决策 B.3/B.4 不动）。
- **不接 R2a 持久化**（测试 #7 只做身份对账）。
- **不做跨文件去重**：公开函数与 CLI 都是**单 path**（§3.5）。
- **workbuddy 流不碰**。

## 2. 数据源与共享 observer 架构

### 2.1 现有 DSH 数据流（只读）

```
session.jsonl[.zstd]
  │  read_session_text()  → (text, None) | (None, code∈{file-missing, unsupported-compression, zstd-decode-error})
  ▼
  text
  │  parse_session_log(text)  → { ..., usage_events: [...] | None, cwd: ... }
  │     降级时 usage_events=None（不是 []，dsh.py _self_test 钉死）
  ▼
  usage_events  （元素 {type, seq, time, data}；fork marker type="session" seq=None）
  │  post_fork(usage_events)     ← 各消费方入口做一次（幂等：marker seq=None 被保留，
  │                                 二次过滤结果不变，已核）
  ▼
  post_events
  │
  │  ┌─ _usage_sample（共享样本解析，usage.py 权威，现有逻辑，observer 与 fold 共用）
  │  │
  │  ├──► token_by_model fold（_usage_fold_into，聚合权威，不改道）── 按模型聚合
  │  │
  │  └──► 新 DshUsageObservation observer（Commit 1）── 逐相邻槽产出 observation
  │            ├── request_metrics 展示投影（字节冻结）
  │            └── UsageFact emitter（Commit 2，出账前 duplicate 守卫）
  │
  └── observer 与聚合 fold 两条路径以 reconcile/golden 测试钉一致
      （逐槽四桶之和 == by_model 四桶之和；provider 归属对账等）
```

### 2.2 共享样本解析 + 双消费者 observer（Commit 1 的交付物）

现有 `request_metrics` 自己维护一条「request/header 追踪 active model → 逐样本提取 →
同槽去重」的循环，与 `_usage_fold_into` 各写一遍槽语义，且这条循环**丢弃了 provider
与首样本身份**——这正是「UsageFact 不能消费它」的根因。Commit 1 把 request_metrics
的这条循环抽成**独立的逐槽 observer**，让它同时服务 request_metrics（展示）与 emitter
（事实）。**注意表述**：这是「共享样本解析 + 双消费者 observer」——`token_by_model`
的聚合 fold **不接 observer**、继续走 `_usage_fold_into`，观察者与聚合 fold 是**两条
已 reconcile 的路径**，不是唯一逐槽解释。observer 的槽语义与 fold 同款：**相邻 run**
——`last` 同 (turn,step) 比较、只折叠相邻的同槽样本（`usage.py:626-634`），**不是**
全文件 HashMap 去重。非相邻的同 (turn,step) 重现是两个独立槽（普通请求因 first_
sample_seq 不同而身份各异；同 compactionId 重现则 collide，靠 §3.5 守卫）。

observer 逐槽产出的 `DshUsageObservation`：

```text
DshUsageObservation（每相邻槽一条，key = turn/step 或 compaction 负号槽）：
  turn / step           真实 turn/step；compaction 槽 = None（不泄漏内部负号哈希）
  compaction_id         compaction/summary 的原生 data.compactionId；非 compaction = None
  model_raw             §3.4（普通 = 支配样本时 active 游标的 config.model；
                        compaction = 自带 data.model；compaction 缺/非 str → 回落 active）
  provider_raw          §3.4（同上，provider；只允许原始字符串或 None）
  first_sample_seq      该槽**首个**被消费的 usage 样本的 seq（append 稳定锚）
  first_sample_identity_hash  无 id compaction 在开槽时对首样本 canonical 行算好并冻结
  source_event_id       开槽即固化（§3.3 三段公式之一），shadow 永不覆盖
  identity_basis        同上，开槽即固化（"native"/"derived-hash"）
  seq / time            支配样本的 seq / time（value 语义）
  4 token 桶            uncached_input/output/cache_read/cache_write，_opt_int（缺 None）
  context_window / context_tokens / is_peak   展示投影需要（request_metrics 保留）
```

**覆盖更新语义（显式写清）**：同一相邻槽内后来的 usage 样本（shadow，如 chunk 后的
message、双 chunk 后到者、相邻的同槽 compaction 重现）**覆盖 tokens、time、
model_raw、provider_raw**——重扫时取支配样本在流中那一刻的 active 游标重判
model/provider（与 fold/request_metrics 的「后到重判」一致：request_metrics 对每个
样本重算 model、后到者覆盖），但**身份字段不可变**：`source_event_id`/`identity_basis`
/`first_sample_seq`/`first_sample_identity_hash` 在开槽时计算，shadow 永不覆盖。**不要
在观察者里把 model/provider 缓存成槽建立时的值，也不要在 shadow 时重算身份**——header
若在 chunk/message 之间变化，缓存 model/provider 会与 fold 的逐样本重判不一致；而身份
若从支配样本重算，append 就会改写旧 fact_id。实际 DSH 流里一个槽的样本总落在该 turn
的 request header 之后、下一 header 之前，model/provider 游标在槽生命周期内恒定，切换
只会发生在**槽之间**（→ 聚合层 ambiguous）——reconcile 测试与这条流结构观察互相印证。

- **request_metrics = observer 的一薄渲染**：输出 JSON **逐字节不变**（行键
  `request_seq/seq/time/turn/step/model/context_window/context_tokens/四桶/is_peak`
  照旧；`request_seq` 是渲染期重编号；provider/身份字段 **不渲染**）。门禁：
  request_metrics 既有表征/对账测试 + golden 零漂移 + Python↔Rust request_metrics
  parity 全绿。
- **token_by_model fold 不改道**：仍由 `_usage_fold_into` 聚合；观察者与聚合 fold 的
  对账沿用既有「逐槽四桶之和 == by_model 四桶之和」reconcile 测试（§2.1 图示）。
- `_usage_sample`（usage.py）继续是逐样本提取的唯一入口，observer 与 fold 共用，不
  复制。active 游标（config.model/config.provider）推进规则与 fold 的 active +
  `_record_provider` 同谓词：config.model 为 str 才推进 model 游标，provider 取
  `config.provider` 原样 str-or-None。

### 2.3 发射集定义

**发射集 == observer 的相邻槽集**（与 fold 的 by_model 消费集逐槽一致）。不 emit
的、与 token 相关的只有两类：

1. **被替换语义吞掉的重复样本**（同槽 chunk+message / 双 chunk 后到覆盖 / 相邻同槽
   compaction 重现）：不是丢钱，是「同一笔请求的多个视图，只按最终视图出账」。
   coverage 的 `fact_rows` vs 该文件 usage 样本数之差即它的结构表达。
2. **残差哨兵事件**（`usage_shaped_tokens` 认得但 `_usage_sample` 没接住，如实测
   `resume.jsonl` seq=15 那条 turn=None 的 message）：fold 都没折进 by_model，事实
   **不该**覆盖它；由 coverage 的 unaccounted 诚实上报（机器发现、人归类）。

## 3. 字段映射与身份契约

### 3.1 映射表（observation → UsageFact fields）

| UsageFact 字段 | 来源 | 备注 |
|---|---|---|
| `machine_namespace` | CLI 必填且非空（缺失或空串 exit 2） | 同 Stage 1/2：CLI 绝不读 machine.json 的 takeover identity |
| `harness` | 常量 `"dsh"` | == R2a harness_kind |
| `source_profile` | CLI 显式，否则 header cwd 派生 | §3.6；cwd 缺失 → 硬错误 |
| `native_session_id` | 头行 `id` | 与 R2a 同源（`r2a_store.rs:1184`）；缺 → 硬错误 |
| `source_event_id` | observation 固化字段（§3.3） | 无 path.stem；出账前查重 |
| `observation_kind` | 常量 `"assistant-usage"` | 与 claude/codex 同词汇 |
| `identity_basis` | observation 固化字段（§3.3） | native 仅 compaction 有原生 id 时 |
| `event_ts_utc` | RFC3339-ms-Z（epoch ms → 串） | §3.6；跨语言格式契约 |
| `time_basis` | `"native" if time is not None else None` | **显式判空**，epoch 0 是真时间 |
| `source_usage_semantics` | `"delta"` | 全仓统一词汇 |
| `provider_raw` | §3.4 | 原始字符串或 None，绝无 `__ambiguous__` |
| `model_raw` | §3.4 | 无证据 → None（渲染哨兵 "unknown" 只在展示层） |
| `uncached_input_tokens` | observation 四桶同名 | DSH `inputTokens` 即非缓存输入 |
| `cache_read_tokens` / `cache_write_tokens` / `output_tokens` | observation 同名 | None 保真 |
| `turn` / `step` / `call_id` | observation（`USAGE_FACT_FIELDS` 本身含这三键） | compaction 槽 = None |
| 其余 `USAGE_FACT_FIELDS` | 缺省 | `build_usage_fact` 统一置 None |

### 3.2 token 四桶：None 与 0 必须可区分

观察者的四桶是 `_opt_int` 语义（执行环境没报 → None，缺项 ≠ 0，与 `_buckets_from` 求和按
0 是两种正确语义）。fact 原样带 None → `build_usage_fact` 校验非负整数、允许 None。
**绝不**把缺失当 0 发——那会把「执行环境没报 cacheReadTokens」伪造成「测到 0」。

### 3.3 source_event_id：首样本锚定、开槽固化，与 `identity_basis` 对齐

**为什么不能用 path.stem**（v1 的错）：真实 DSH 文件恒名 `session.jsonl` /
`session.jsonl.zstd`，stem 分别是 `session` / `session.jsonl`——不同会话物理文件 stem
相同（区分不了物理来源），同一明文与其 zstd 复本 stem 又不同（违反「解码前后逐字节
相同」）。`_compaction_identity` 注释只证明「一次 compaction 被 fork 复制进 4 个会话
文件」，**没有**证明四文件同 header id——不能推出「同 native_session_id 多物理文件」
需要 stem。

**身份公式（三段，各带自己的 `identity_basis`；一律开槽即固化）**：

```text
普通请求    source_event_id = "request:derived:{fnv1a64(canonical_json({turn, step, seq:first_sample_seq}))}"
            identity_basis  = "derived-hash"
有 compactionId: source_event_id = "compaction:{compaction_id}"
            identity_basis  = "native"          # compaction_id 是执行环境原生标识
无 compactionId: source_event_id = "compaction:derived:{first_sample_identity_hash}"
            identity_basis  = "derived-hash"    # hash 对首样本 canonical 行、开槽时算好冻结
```

- **开槽即固化是 append 稳定的根基**（v3 的错，review P0）：无 compactionId 的
  compaction 会折进固定负号槽 `turn=-1`（`_compaction_identity` 缺 id 时返回固定 `-1`，
  `usage.py:263-267`），**相邻的后续同槽 compaction（shadow）会让支配样本变化**——v3
  若「hash 输入取支配样本 canonical 行」，append 一条 shadow 后 hash/fact_id 就变。
  v4：observer 在该槽**第一个** usage 样本到达时（开槽）就按首样本计算并**冻结**
  `source_event_id`（普通请求冻结在 first_sample_seq 已知的那一刻，等价于首样本锚；
  有 id compaction 冻结为 `compaction:<id>`；无 id compaction 冻结
  `first_sample_identity_hash` = 首样本 canonical 行的 fnv1a64 hex）。shadow 只更新
  value 字段，身份零变动。普通请求的 first_sample_seq 本身就是冻结值，因此 recompute
  与 freeze 等价——但为统一与防未来回归，observer 一律**存固化字段**，不重算。
- **`identity_basis` 逐槽分**（v2 确立，v4 保留）：`build_usage_fact` 的纪律是
  native = `source_event_id` **真的是执行环境原生 id**，derived-hash = 对内容做的 hash
  fallback（`usage_fact.py` docstring）。普通请求没有逐字原生 id（槽是 adapter 重构）
  → 对 canonical 身份元组做 hash、标 derived-hash（与 Stage 2 `_derived_event_id`
  「derived 必带 hash」同纪律）。compaction 有原生 `compactionId` → `compaction:<id>`
  标 **native**（claude message.id → native 同款；`compaction:` 前缀只是命名空间消歧，
  不改变 id 主体原生）。
- **canonical hash 复用 Stage 1 已跨语言字节一致的 helper**：`_canonical_row_json`
  （sort_keys + 紧凑分隔 + 不转义非 ASCII）→ `_fnv1a_hex`；Rust 镜像
  `canonical_row_string`/`fnv1a_hex`。普通请求的身份元组是 `{"turn": t, "step": s,
  "seq": first_sample_seq}` 的小 dict（canonical serializer 按 key 排序 → 两语言字节
  一致）。
- **`seq=None` 确定性降级**（review 点名，v4 保留）：真实 DSH 被消费的 usage 样本恒带
  整型 seq（fork marker type="session" seq=None 不进 `_usage_sample` 类型白名单，永不
  成为样本）——这条纯属防御。规则：`first_sample_seq` 为 None 时，canonical 身份 dict
  **整体省略 `seq` 键**（只 hash `{"turn": t, "step": s}`），两语言对 None 走同一条
  省略分支——**绝不**让 Python 序列化成 `"None"`、Rust 序列化成 `"null"` 造成字节分叉
  或 id 不稳定。turn/step 对普通槽恒为 int（槽键本身），无 None 之虞。**无 id compaction
  的 `first_sample_identity_hash` 输入形状显式写死**（两语言照抄，杜绝一端产
  `seq:null`、另一端省略该键）：

  ```text
  identity_row = {"type": …, "time": …, "data": …}    # 首样本重塑事件
  若首样本 seq 为整数 → 追加 "seq": seq              # 非整数就整体不进 identity_row
  ```

  即 hash 对象永远不含值为 null 的 `seq` 键。合成单测把这条（seq 整数与 None 两分支）
  的字节形式在两语言钉死，不进 fixture（真机未见缺 id compaction）。
- **duplicate 守卫的例外说明**：普通槽非相邻重现（两个独立相邻 run、同 (turn,step)）
  因 first_sample_seq 不同而身份不同，**不**触发守卫；有 id compaction 非相邻重现
  才 collide（§3.5）。

### 3.4 model_raw / provider_raw：原始证据，逐槽快照

- **普通请求**：槽的 `model_raw` / `provider_raw` = **支配样本（该相邻槽最后一个被消费
  的 usage 样本）**那一刻的 active header 游标 `config.model` / `config.provider`——
  游标在流中按 request/header 事件推进，规则与 fold 的 active + `_record_provider` 同
  谓词（config.model 为 str 才推进 model；provider 取原样 str-or-None）。这就是「该
  请求发生时 header 游标里的 provider」。request_metrics 对每个样本重算 model、后到覆
  盖，与 fold 逐样本重判一致——observer 照抄这条语义（§2.2 覆盖更新），header 若在
  chunk/message 之间变化也不会与 fold 分叉。真无 header 证据 → None。
- **compaction**：自带 `data.model`/`data.provider`（str 时直接取）；自带缺/非 str →
  回落当时 active 游标（与 fold 的 `model_override` 为空时回落 active 同语义——
  `usage.py:616-624`：compaction 无 model 时不走 override 分支，model=active）。
- **`provider_raw` 只允许原始字符串或 None**。`__ambiguous__` 是 `_record_provider`
  在**聚合层**对「同一会话内同一模型名被两家 provider 服务过」的派生结论，**永不出现在
  fact** 里——它不代表任何一次请求发生时 header 游标里的真实 provider。分层的本质：
  fact 存**每次请求的原始证据**，ambiguous 是 `token_by_model` 的 providers 图上可
  重建的**聚合态**。下游计价读 provider_raw 拿到的永远是「这笔请求当时是谁服务的」，
  歧义该由聚合层判定。
- `model_raw` 无证据 → None（"unknown" 是 request_metrics 的**渲染哨兵**，不是模型
  名；emitter 在 observer 层就把「无证据」收敛成 None，不改 request_metrics 输出）。

### 3.5 单 path + duplicate 硬错误守卫（无跨文件去重）

发射域 = 一份会话文件。**不做跨文件去重**；单文件内也**不声称「结构性不可能
duplicate」**——fold 去重是**相邻 run**（`last` 同槽比较，`usage.py:626-634`），
**不是全文件 HashMap 去重**。验证过的反例（现有实现即如此）：

```text
compaction c1          → 槽 A（turn = hash(c1)）
普通请求                → 槽 B（打断相邻）
compaction c1           → 槽 C（last 已不是 c1，作为新槽折进，两个 c1 都被 fold 计入）
```

折出**三个**槽；若 emitter 对槽 A、C 都用 `compaction:c1`，就出现两个相同
source_event_id/fact_id。规则：

- **成功结果禁止重复 source_event_id**。emitter 出账前对固化后的 source_event_id 做
  seen-set 检查；重复 → 抛 `duplicate-source-event-id` 硬错误（CLI exit 2）。
- **不静默去重**——若吞掉后一条，UsageFact 总量就与 fold 总量（两个 c1 都折进
  by_model）不一致，reconcile 破；硬错误是唯一诚实出口（同 §4.1 strict 哲学：
  异常文件整体失败，不产出对不上账的部分成功）。
- 普通槽非相邻重现（两个相邻 run、同 (turn,step)）因 first_sample_seq 不同而身份
  不同，**不**触发守卫；observer/本 spec 措辞一律称**相邻 run/相邻槽**，不用「全局唯一
  (turn,step) 槽」。
- 未来若多 path 批扫，每文件一次 strict 调用即可；若要在 emitter 层解决非相邻同 id
  compaction 的语义，那要先修 fold 的去重（本 stage 不修，§1.2）。

### 3.6 event_ts_utc / time_basis / source_profile / strict 归属

- **event_ts_utc = RFC3339 UTC，固定毫秒精度 + `Z`**：epoch-ms → 串的纯函数，Python
  与 Rust **逐字节一致**（adapter 边界消除执行环境 wire 差异，一次性支付格式契约，不能把
  复杂度推给下游）。实现不加新依赖：Rust 侧按 repo 既有 Hinnant civil 纪律做整数
  `civil_from_secs`（core `usage.rs`/`budget.rs` 已有 civil-from-days，chrono **不是**
  依赖）；Python 侧用同一整数数学（不用 `datetime` 的 float `fromtimestamp(ms/1000)`，
  避免精度/闰秒分歧）。`epoch 0 → 1970-01-01T00:00:00.000Z`。parity 用跨语言 battery
  钉（§6 #9）。格式器放 core 还是 agent 实施时定（两条约束：不加 chrono/datetime
  float；跨语言 parity battery）。
- **time_basis**：`"native" if time is not None else None`——**显式判空，不用
  truthiness**：合法 `epoch 0`（time=0）是真时间，不能被当成「无时间」。
- **source_profile 缺省从 header cwd 派生**（`--{cwd.replace('/','-')}--`，与 R2a
  `dsh_source_profile` 同款，`r2a.py::dsh_source_profile` 现成可 import）。
- **归属失败 = 硬错误（strict），不是空成功**（§4.1）：缺 header session id、或缺 cwd
  且未显式给 `--source-profile` → **CLI exit 2 / library raise**，给出 actionable 诊断
  （「header 无 cwd，请显式传 --source-profile <P>」），**不**输出 `facts=[]` 伪装成
  「这文件没有用量」，也**不**退回 `"default"` 占位——空串/占位都会让 R2a 对账静默不
  成立，且「归属失败像没有用量」正是要消灭的形状。诚实声明：**只有 cwd 在场（或显式
  profile）时，fact 身份才可与 R2a 对齐**。真实 DSH 头行带 cwd（SV605 读它），但
  fixture/构造会话可能没有，故这是真实可达的硬错误类别。

## 4. 错误、attempts 与 coverage

### 4.1 错误分层（strict 单文件诊断）

| 层 | 情形 | 处理 |
|---|---|---|
| 参数 | `--machine-namespace` 缺失或空串 | exit 2（同 Stage 1/2） |
| 读/解码 | `file-missing` / `unsupported-compression` / `zstd-decode-error`（截断/坏帧） | **上抛硬错误** → CLI exit 2，消息带 dsh.py 错误码 |
| 解析 | `parse_session_log` 降级 → `usage_events=None` | **上抛硬错误** → CLI exit 2（降级 = 整份不可用，不是读到 0 条） |
| 身份 | header 缺 session `id` | **上抛硬错误** → CLI exit 2（不是 DSH 会话 / 无法定身份） |
| 归属 | header 无 `cwd` 且无显式 profile | **上抛硬错误** → CLI exit 2，消息给 actionable 提示（§3.6） |
| 守卫 | 成功结果里 source_event_id 重复（非相邻同 compactionId 重现） | **上抛硬错误** `duplicate-source-event-id` → CLI exit 2（§3.5） |
| 干净 | 正常 | 逐槽 emit（出账前 seen-set 查重通过） |

DSH 的 decode/parse 是**全有或全无**（`decode_zstd_multi_frame` 截断 → None 整体；
`parse_session_log` 降级 → `usage_events=None`，没有部分解析态），所以单文件诊断下
「文件不可读」与「malformed 部分」不可分——统一为硬错误。这与既有的批处理消费者不
冲突：behavior 审计等走 `read_session_log` 的 (events, code) 降级返回、把不可读会话标
Unavailable 继续跑，那是批处理语义；本 stage 的**单文件 emit CLI 是 strict**，一份
打不开的会话就是这一次调用的失败。**故 emit result 没有 attempts / malformed 字段**：
DSH 没有 codex 的 wire 行级 skip/unreadable/unattributed 类别（归属失败在**文件**层且
已是硬错误）、也没有 duplicate 类别作为**正常成功路径**（duplicate 是硬错误分支，不进
coverage）——硬套恒 0/恒空键会造假键。coverage 的键按执行环境各异，claude_usage_fact 与
codex_usage_fact 本就不同，此处一致。

### 4.2 coverage（DSH 专属键）

```text
coverage = {
  "observation_rows": 0,    # observer 产出的相邻槽数（= 请求层实际观测数）
  "fact_rows": 0,           # emit 的 fact 数
  "unaccounted_events": 0,  # 残差哨兵事件数（usage_fold_render 的 unaccounted_usage）
  "unaccounted_tokens": 0,  # 残差哨兵 token 数
}
```

- **不变量：成功 emit 时 `observation_rows == fact_rows` 且 source_event_id 全唯一，
  无条件成立**——单 path、每观测必 emit（归属失败是**文件层硬错误**、不产生观测、也到
  不了成功返回）；重复 source_event_id 由守卫在出账前整体硬错误（§3.5），不产出部分
  fact。不需要 unattributed_rows 之类的兜底计数来维持等式——等式靠**没有 fake-empty /
  部分成功路径**保证，而不是靠不算数（在 review 给的两条路里选严格那条）。
- unaccounted = 「文件报了 token 形状但 fold/事实都没接住」的唯一诚实出口（机器发现、
  人归类）。`fact_rows == 0` + `unaccounted_tokens > 0`：该文件有 token 形状的证据但
  fold 一条都没接住 → 报告同时给出这两数，读者一眼看出「不是干净的空」。

### 4.3 会话无 usage 的诚实输出

文件干净解析、post-fork 后零样本 → `facts=[]`、`coverage={observation_rows:0,
fact_rows:0, unaccounted_events:0, unaccounted_tokens:0}`。诚实的「没有可审计的
post-fork 用量」，不是错误、也不冒充覆盖——与 §4.1 的归属失败/duplicate 硬错误
**形状可区分**（一个 exit 0 空集、一个 exit 2 诊断）。

## 5. 接口、CLI 与 commit 拆分

```python
# scripts/agent_vitals/agent/dsh_usage_fact.py（harness adapter，不进 Core）
HARNESS = "dsh"
OBSERVATION_KIND = "assistant-usage"

class DshUsageFactError(Exception):
    """args[0] 是 (code, message)；code ∈ {file-missing, unsupported-compression,
    zstd-decode-error, parse-degraded, missing-session-id, unattributed,
    duplicate-source-event-id}。"""

class DshUsageFactEmitResult(NamedTuple):
    facts: list          # List[Dict]，build_usage_fact 输出，逐槽一行；source_event_id 已查重
    coverage: dict       # {observation_rows, fact_rows, unaccounted_events, unaccounted_tokens}

def dsh_session_to_usage_facts(path, *, machine_namespace: str,
                               source_profile: Optional[str] = None,
                               ) -> DshUsageFactEmitResult:
    """读/解码/解析复用 adapters/dsh.py；identity（头行 id/cwd）复用
    r2a.py::dsh_header(text)，不写第三份头行解析。归属失败/duplicate → raise
    DshUsageFactError（不返回空成功、不静默去重）。"""
```

- **单 path**；`source_profile=None` → header cwd 派生；cwd 缺失 → raise
  `unattributed`。
- CLI：`scan.py dsh-usage-facts --path <session-file> [--source-profile P]
  --machine-namespace NS [--json FILE|-]`；参数/读/身份/归属/duplicate 错误 → exit 2 +
  stderr 诊断；成功 → JSON `{facts:[…], coverage}`（键序固定，byte-parity 比较 stdout
  整串）。Rust 镜像 `src/agent/dsh_usage_fact.rs` + `src/main.rs` 的
  `Cmd::DshUsageFacts`。
- commit 拆分与 Stage 2 同款：Commit 1 用共享 observer 产槽但**不新增任何 emitter
  代码**（先让地基稳定），Commit 2 才加 emitter + CLI + fixture + 测试。

**Commit 1（byte-neutral 共享 observer refactor，零漂移门）**：抽 `DshUsageObservation`
observer（§2.2，含 provider_raw/first_sample_seq/first_sample_identity_hash/固化身份/
active 游标），request_metrics 改道其上、输出字节不变。**这层属 usage domain/core**：
Python `agent/usage.py` + Rust core `usage.rs` 同改（与 request_metrics/fold 同层，
不是 harness adapter）。门禁：request_metrics 表征/对账、golden 零漂移、Python↔Rust
request_metrics parity 全绿。provider 游标、首样本锚、固化身份是**新携带字段**
（request_metrics 不渲染 → 无输出影响），但它们的提取逻辑与 fold 同谓词，reconcile
测试在 commit 1 内即可先行钉住 observer↔fold 一致（不依赖 emitter）。

**Commit 2（emitter + CLI + fixture + 验收）**：`dsh_usage_fact.py`/`dsh_usage_fact.rs`
+ CLI 双侧 + fixture + 测试（§6）全绿。**这层属 harness adapter**，不进 Core。

## 6. 验收测试

fixture 复用现有：`behavior.jsonl`（slot(9,1)=chunk130+message131 同槽 shadow、
(10,1) chunk、(11,1) chunk；header 无 provider = 老日志态）与 `resume.jsonl`
（slot(1,1)=chunk3+message4、slot(2,1)=chunk8、**双 chunk(13/14) 同槽 (3,1)**、
**原生 compaction `cmp-1` + 自带 model/provider**、**seq=15 turn=None 的 message →
残差哨兵 unaccounted**；header 带 provider = 新日志态）已覆盖多数面。append-shadow、
provider-switch、无 id compaction 需构造（§6 #2/#6b/#5b/#5c）。commit 2 加小构造
helper，不动现有产物。

1. **单文件 emit（对账 fold）**：`behavior.jsonl` → 每相邻槽一个 fact（slot
   (9,1)/(10,1)/(11,1) 共 3），6 身份字段正确；fact 四桶求和 == `token_by_model` 四桶
   求和；同槽 chunk+message 只出一 fact（无双计）；model_raw = 各槽 header 激活 model
   （(9,1)→pro、(10,1)→flash、(11,1)→pro，behavior header 无 provider →
   provider_raw=None 老日志态）；fact 行带 turn/step。
2. **append 不改写旧 fact_id（普通请求）**：只含 chunk seq=130 的前缀 → 全量（+message
   seq=131）。重扫：slot(9,1) 的 fact_id **不变**（身份开槽即固化、first_sample_seq=130
   锚定 canonical 身份元组），token 字段更新为 message 最终值（input 1.0M→1.2M）。
3. **多帧增量 emit**：`session.jsonl.zstd`（3 帧）emit == 同内容明文 emit 逐字节相同
   （帧边界不可见；无 path.stem 的身份保证两态一致）；追加全新请求的新帧 → 重扫得新
   fact、旧 fact 逐字节不变。
4. **compaction emit（native basis）**：`resume.jsonl` → compaction 槽一 fact，
   turn/step=None，model_raw=自带 `deepseek-v4-flash`、provider_raw=自带
   `deepseek-official`，source_event_id=`compaction:cmp-1`，**identity_basis="native"**
   （compactionId 是原生标识），四桶=compaction usage 四桶。
5. **同槽双 chunk 首样本稳定**：`resume.jsonl` slot(3,1)=chunk13→chunk14 → 单 fact，
   source_event_id = `request:derived:` + 测试内用同一共享 helper 复算的
   `fnv1a64(canonical_json({"turn":3,"step":1,"seq":13}))`（first_sample_seq=13 不因
   chunk14 覆盖改变），四桶取 chunk14 最终值。
5b. **无 compactionId + append shadow → fact_id 不变**（构造 temp 会话）：两个相邻的
   无 id compaction（`_compaction_identity` 缺 id → 固定 turn=-1，相邻即同槽）。前缀
   只含第一个、全量含两个 → 重扫 fact_id **不变**（`first_sample_identity_hash` 开槽
   固化），token/model/provider 取支配（第二个）样本；fold 侧也只有一个负号槽被计入
   （reconcile 一致）。
5c. **同 compactionId 非相邻重现 → duplicate-source-event-id**（构造 temp 会话）：
   `[compaction c1, 普通请求, compaction c1]` → fold 折进三个槽（request_metrics 出三
   行、by_model 把两个 c1 都计入）→ emitter **raise `duplicate-source-event-id`**
   （不静默去重、不出部分 fact）。测试同时断言 request_metrics 三行、reconcile 在
   request_metrics 层成立，佐证「守卫在出账前、不是误伤」。
6. **provider_raw 原始性 + 聚合层才 ambiguous**：
   - 6a. `resume.jsonl` slot(1,1)/slot(3,1) model=pro → provider_raw=`shengsuanyun`；
     slot(2,1) model=flash → `deepseek-official`。fact 里只有原始单串，无
     `__ambiguous__`。
   - 6b. **同一会话内同模型切换 provider（构造 temp 会话）**：header1
     `{model:"X", provider:"A"}` + turn1 请求 + chunk；header2 `{model:"X",
     provider:"B"}` + turn2 请求 + chunk → 两条 fact 的 provider_raw 分别为
     `"A"`/`"B"`（各自保留），而 `token_by_model` 聚合的 `providers["X"] ==
     "__ambiguous__"`——「原始证据在 fact、派生结论在聚合层」的分层被钉死。
   - 6c. **无 header model 证据的槽 → model_raw=None（非 "unknown"）**。
7. **R2a SessionKey 对得上**：对同一文件，fact 的 `(harness, machine_namespace,
   source_profile, native_session_id)` == R2a 四元 `SessionKey` 分量
   （`SessionKey::new("dsh", header.id, dsh_source_profile(cwd), ns)`，
   `r2a_store.rs:1184`）。
8. **unaccounted 诚实面 + strict 归属**：
   - `resume.jsonl` seq=15 turn=None message（fold 拒收但有 token 形状）→ 不出 fact、
     coverage `unaccounted_events=1`/`unaccounted_tokens=86`；`observation_rows ==
     fact_rows`。
   - **cwd 缺失**（构造无 cwd 头行 + 无显式 profile）→ library raise
     `unattributed` / CLI exit 2（stderr 给 actionable 提示），**不**返回 `facts=[]`；
     显式 `--source-profile` 则恢复 emit。
   - **header 缺 session id** → library raise `missing-session-id` / CLI exit 2。
   - **clean 空**：干净解析 + post-fork 零样本 → exit 0 `facts=[]` + 全 0 coverage
     （与上述 exit 2 形状可区分，§4.3）。
9. **byte-parity Python↔Rust**：`AGENT_VITALS_BIN` 差分跑同一 fixture 集 → JSON
   stdout 逐字节相等（含 RFC3339 event_ts_utc、provider_raw、derived/native
   source_event_id、identity_basis）；RFC3339 格式器跨语言 battery（epoch 0、真实 ms、
   整数边界）逐字节一致；身份 canonical hash 跨语言 battery（含普通槽
   `first_sample_seq` None → 省略 seq 键、以及无 id compaction `identity_row` 的
   seq 整数 / None 两分支——两语言同一省略规则，Python 不产 "None"/Rust 不产
   "null"）；`--machine-namespace` 缺失或空串 exit 2；不存在文件 exit 2；duplicate 文件
   exit 2 + 消息两语言同码。
10. **Commit 1 零漂移门**（在 commit 1 内验证）：request_metrics 对同一批 fixture 的
    JSON 输出 refactor 前后逐字节相同；Python↔Rust request_metrics parity 全绿；
    observer↔fold 四桶 reconcile 在 commit 1 内先行钉住。

## 7. 决策汇总（v4 修订，待 review 通过）

| 项 | v4 拍板值 | 上一版的问题（review） |
|---|---|---|
| 身份固化 | observer **开槽即固化** source_event_id/identity_basis（首样本锚），shadow 永不覆盖 | v3 无 id compaction 的 hash 输入误写「支配样本」→ append shadow 改写 fact_id |
| duplicate 守卫 | 成功禁止重复 source_event_id；检出即抛 `duplicate-source-event-id` 硬错误，**不静默去重** | v3 称「结构性不可能 duplicate」——fold 只做相邻去重，非相邻同 compactionId 重现会 collide |
| 槽措辞 | 相邻 run/相邻槽（`last` 比较语义），非「全局唯一 (turn,step) 槽」 | v3 §3.5 全局唯一表述与 fold 实际语义不符 |
| Core 边界 | 共享 observer 属 usage domain/core（`usage.py`+core `usage.rs`）；emitter/DSH 文件解析/CLI 属 harness adapter | v3 §0「不进 Core」与 Commit 1 动 usage.py/usage.rs 矛盾 |
| provider 措辞 | 同一会话内同模型切换 provider → 聚合层 ambiguous | v3 §0「跨会话」与 #6b/单会话聚合不符 |
| `provider_raw` | 只存原始字符串/None；普通=支配样本时 header 游标 `config.provider`，compaction=自带 `data.provider` | v2 允许 `__ambiguous__` 进 fact |
| `source_event_id` + basis | 普通=`request:derived:` + canonical 身份元组 hash / derived-hash；有 id compaction=`compaction:<id>` / **native**；无 id=`compaction:derived:{first_sample_identity_hash}` / derived-hash | v2 不含 hash 却标 derived-hash |
| `seq=None` | canonical dict 省略 seq 键（两语言同分支） | v2 未规定 → 字节分叉或 id 不稳定 |
| 归属失败 | **硬错误 exit 2**：缺 session id、缺 cwd 且无显式 profile | v2 返回成功空集 → 伪装成无用量 |
| emit result | `(facts, coverage)`；无 attempts/malformed；`observation_rows == fact_rows` + id 全唯一 无条件 | v2 的假键/假等式 |
| 架构表述 | 共享样本解析 + **双消费者 observer**（request_metrics + emitter）；`token_by_model` 保留原 fold | v2 自称「三路唯一」却保留 fold |
| observer 覆盖语义 | shadow 覆盖 tokens/time/model/provider（支配样本时重读游标），身份/first_sample_seq 不可变 | v2 未写清 → 与 fold 分叉 / append 改写 |

未变（二/三轮 review 已拍板）：RFC3339 UTC 固定毫秒、`time_basis` 显式判空、None
token 不转 0、单 path 无跨文件去重、`observation_kind="assistant-usage"`、
`source_usage_semantics="delta"`、harness="dsh"、内存 emit 不夹带 R3 写链、不冒充解决 R3
增量重折与 Workbench 断更、workbuddy 排除。

## 8. 已知遗留 / 实施期定夺

1. **RFC3339 格式器位置**：core vs agent 实施时定；两条硬约束——不加 chrono /
   datetime float、跨语言 parity battery。commit 1 或 2 引入皆可（emitter 需要即
   commit 2；request_metrics 不想用时放 commit 2）。
2. **双 chunk 同槽（resume.jsonl chunk13/14）的真实语义**：fold 当相邻替换（后到者胜）
   ——fixture 如此构造，Stage 3 继承 fold 语义；若真机存在「同 (turn,step) 相邻两次
   chunk 是两次独立计费」，那是 fold 的既有边界，不在本 stage 修。
3. **compaction 自带 model/provider 缺/非 str → 回落 active 游标**（§3.4）：与 fold
   的 model_override 空回落同语义；真机未见的边角，合成单测钉住（不承诺新 fixture）。
4. **非相邻同 compactionId 重现的真实语义**：fold 计入两次、emitter 按 duplicate 硬
   错误拒绝出账——若真机存在同 id compaction 被 fork/重试复制到同一会话文件，需要先
   厘清 fold 该不该折，再决定守卫降级成去重（那是 fold 语义修订，独立排期，不在本
   stage）。
5. **future 批扫**（目录级、R2a discovery 循环）：届时在 CLI 层循环、每文件一次
   strict 调用即可；若要跨文件 duplicate 语义需回本 spec 补类别，不在本 stage。

## 9. 归档：已被 review 推翻的错误（不实施）

- **path.stem 当物理文件身份**（v1）：真实文件恒名 session.jsonl[.zstd]，stem 分不出
  物理来源、明文/zstd stem 不同破坏 byte 相同。
- **支配事件 seq 当身份**（v1）：chunk130→message131 让支配 seq 130→131，append 会
  改写旧 fact_id。`first_sample_seq` 锚定修掉。
- **request_metrics 当 emit surface**（v1）：它是展示 DTO，丢 provider/首样本身份、
  "unknown" 是渲染哨兵。
- **不含 hash 的槽 id 标 derived-hash**（v2）：与 Data Plane 契约冲突；对 canonical
  身份元组做 hash。
- **provider_raw 允许 `__ambiguous__`**（v2）：聚合层派生状态混进原始证据。
- **归属失败返回成功空集 + attempts 兜底**（v2）：伪装成「无用量」；改硬错误 +
  `observation_rows == fact_rows` 无条件。
- **无 id compaction 的身份 hash 取支配样本 canonical 行**（v3）：append shadow 会改
  写 fact_id；改开槽即固化 `first_sample_identity_hash`。
- **「单文件结构性不可能 duplicate」**（v3）：fold 只做相邻去重，非相邻同 compactionId
  重现 collide；改 strict invariant（duplicate-source-event-id 守卫）兜底。
- **「不进 Core」覆盖整个 stage**（v3 §0 措辞）：共享 observer 属 usage domain/core；
  harness adapter 边界只圈 emitter/DSH 文件解析/CLI。

## 10. 工作量（粗估）

Commit 1 observer refactor + 零漂移门 ≈ Stage 2 commit 1（`CodexFoldState`）同量，
~150 行 + 门禁测试。Commit 2 emitter + CLI + fixture + 验收 ≈ Stage 2 commit 2 同量，
Python ~160 行 + CLI ~40 行 + 测试 ~320 行；Rust 镜像同量（含 seen-set 守卫）。RFC3339
格式器 + canonical 身份 hash + duplicate 守卫两语言各 ~40 行 + battery。决策 C.1 原估
「~100 行 + 6 测」不含 observer refactor 与契约函数与守卫，总盘子约 Stage 2 的 1.3
倍。
