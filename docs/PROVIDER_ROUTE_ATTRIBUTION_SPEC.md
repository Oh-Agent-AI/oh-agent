# Provider Route Attribution and Fair-Market Metered Fallback

状态：Draft，面向 v0.11.x 修复；适用于所有执行环境和模型

## 1. 问题定义

当前各执行环境的 session log 对 provider 路由的记录能力不一致：

- Codex 记录 `model_provider=custom`，但通常不记录 endpoint/provider identity；
- DSH 已经记录 `provider_raw`；
- Claude Code 目前主要记录 `model_raw`，缺少可靠 route evidence。

因此 `custom` 流量无法安全归因到 `cogfoundry.ai`，而只能显示为未解析的按量估算。

本 spec 只允许使用执行环境 session log 中的证据。不得使用当前配置、环境变量、账单流水或模型名推断历史 provider。
计费兜底规则对 Codex、DSH、Claude Code、WorkBuddy 以及后续执行环境统一生效。

## 2. 目标

1. 每个 harness adapter 从原始 session log 提取其实际存在的 provider/route 原始证据。
2. Python/Rust adapter 输出完全一致的字段和证据等级。
3. 同一 session 内发生 route 切换时，usage fact 按事件时间继承正确路由。
4. 有明确 endpoint/provider 时，将流量归因到规范 provider（例如 `cogfoundry.ai`）。
5. 没有 route evidence 时保留原始 provider 或 `<unknown>`，不得静默归因。
6. 保留原始字段和 evidence provenance，支持重放和审计。

## 2.1 Custom 的计费兜底规则

当任意执行环境的 session 明确给出 `custom`、第三方 provider、或 provider 缺失，且没有足够的 provider route evidence 时：

```text
billing_mode   = metered
pricing_basis  = metered_estimate
provider_id    = NULL
has_unresolved = true
```

这里的 `custom`/unknown 只决定“不能按官方订阅处理、按量估算”，不决定具体是哪一家供应商。
金额按该模型可验证的公开公允价卡计算（普通输入、缓存命中输入、cache write、输出分别计价）。
继续使用现有稳定字段 `pricing_basis=metered_estimate`，展示或导出时可补充
`pricing_method=fair-market`；结果不能冒充 CogFoundry 实际账单。

如果模型没有 provider-specific 价卡，允许按同名模型的公开原厂价作 fallback，但必须显式标记：

```text
pricing_basis = metered_estimate
pricing_method = fair-market-fallback
```

原始 `model_raw` 不得修改。计价前可以去除路由前缀（例如 `openai/gpt-5.6-sol` →
`gpt-5.6-sol`）用于价卡匹配，但输出和事实 identity 仍保留原始模型名。

统一价格解析顺序：

```text
provider + model 的明确价卡
→ model 的公允原厂价卡
→ unpriced（没有可验证价卡）
```

该顺序适用于 Codex、DSH、Claude Code、WorkBuddy 等所有执行环境；provider identity 与价格来源必须分别展示。

## 3. 非目标

- 不从 `model`/`model_provider=custom` 猜测 provider。
- 不从当前 `config.toml` 或当前环境变量回填旧 session。
- 不从账单金额反推 provider。
- 不在 v0.11.x 内新增 provider 价格目录或订阅合同。
- 不把 provider attribution 当成实际账单金额。

## 4. 统一证据契约

### 4.1 RouteEvidence

```json
{
  "provider_raw": "custom",
  "provider_id": "cogfoundry.ai",
  "endpoint_host": "router.cogfoundry.ai",
  "evidence_basis": "session-native",
  "observed_at_ms": 1788920000000,
  "source_event_id": "rollout-...:12345"
}
```

允许的 `evidence_basis`：

| 值 | 含义 |
|---|---|
| `session-native` | session 原始记录直接提供 provider/endpoint |
| `missing` | session 没有可靠 route evidence |
| `conflict` | 同一时间段存在冲突的 route evidence |

`config-current`、`env-current` 只能用于当前配置诊断，不能用于历史 session attribution。

### 4.2 UsageFact 归因字段

事实行同时保留 `endpoint_host` 与稳定的 `route_evidence_id`；前者是原始路由证据，后者将
token fact 关联到该 session snapshot，不能用一批事实共享的 current-config id 替代。

有 session-native endpoint：

```text
provider_id       = cogfoundry.ai
provider_raw      = custom
billing_mode      = metered
pricing_basis     = metered_estimate
evidence_basis    = session-native
has_unresolved    = true
```

只有 `custom`：

```text
provider_id       = NULL
provider_raw      = custom
billing_mode      = metered
pricing_basis     = metered_estimate
pricing_method    = fair-market
evidence_basis    = missing
has_unresolved    = true
```

`has_unresolved` 表示计费金额或历史路由仍可能不完整；即使 provider identity 已明确，也不能把估算冒充实际账单。
在 v0.11 数据库兼容范围内，`has_unresolved` 与 `pricing_method` 由统一 summary/read-model
根据 `billing_mode`、`pricing_basis`、`evidence_basis` 和是否命中价卡派生；不得把派生的
估算字段回写成事实账单。后续 schema 版本再考虑将其物化到 `usage_facts`。
当前 summary DTO 同时输出 `evidence_basis`、`pricing_method`、`unresolved_reason`，桌面
dual-track 视图必须展示这些字段，避免只显示一个无上下文的“未解析”标签。

## 5. Session log 写入契约

### 5.1 Session 创建时

Codex emitter 应在 `session_meta` 中写入非敏感 route snapshot：

```json
{
  "type": "session_meta",
  "payload": {
    "session_id": "...",
    "model_provider": "custom",
    "route": {
      "provider_id": "cogfoundry.ai",
      "endpoint_host": "router.cogfoundry.ai"
    }
  }
}
```

不得写入 API key、Authorization header、完整 query string 或其他 secret。

### 5.2 Route 切换时

如果 session 内 provider/endpoint 发生变化，必须追加有序事件：

```json
{
  "type": "event_msg",
  "payload": {
    "type": "route_changed",
    "provider_raw": "custom",
    "provider_id": "cogfoundry.ai",
    "endpoint_host": "router.cogfoundry.ai"
  }
}
```

后续 `token_count` 继承最近的 route snapshot，直到下一次 `route_changed`。

### 5.3 Thread settings

`thread_settings_applied.thread_settings` 可重复携带：

```json
{
  "model_provider_id": "custom",
  "provider_id": "cogfoundry.ai",
  "endpoint_host": "router.cogfoundry.ai"
}
```

`model_provider_id=custom` 不等于 provider identity；新增 `provider_id`/`endpoint_host` 才是路由证据。

## 6. Harness adapter 实现

### 6.0 分层边界

执行环境特有的 wire/session 解析必须位于 `agent-vitals-harnesses/src/harnesses/<harness>/`：

- session 行格式、provider 字段路径、route timeline、harness-specific normalization input：harness adapter；
- provider matcher、价卡回退、缓存/输入/输出计价公式：`agent-vitals-domain` 的通用 cost/provider 层；
- SQL 写入、汇总、UI DTO：data/runtime/desktop，只消费统一 DTO，不重新解释 harness wire。

现有 `crates/agent-vitals-runtime/src/sessions/codex_cost.rs` 是历史兼容入口，包含 Codex 专用
fold 与价卡逻辑。实施时应将 route/provider 解析迁出 runtime；公平价解析抽到 domain，runtime
只保留兼容包装或调用统一 cost projection，禁止新增 provider-specific 判断。

### 6.1 Codex

修改：

- `crates/agent-vitals-harnesses/src/harnesses/codex/sources/mod.rs`
- `crates/agent-vitals-harnesses/src/harnesses/codex/sources/usage_fact.rs`
- `packages/agent-vitals-python/agent_vitals/agent/codex_usage_fact.py`

新增纯函数：

```text
extract_route_timeline(items) -> Vec<(event_position, RouteEvidence)>
```

解析优先级：

```text
session_meta.payload.route
→ route_changed
→ thread_settings_applied.thread_settings.route/provider_id/endpoint_host
→ 无 route evidence
```

`token_count` 发射时按 event position 选择最近的 route snapshot。禁止把一次全局 current route 传给所有 rollout 文件。

### 6.2 DSH

保留现有 `provider_raw` 逐事件快照逻辑。若原始 header 提供 endpoint，新增 `endpoint_host`，不覆盖原始 `provider_raw`。

### 6.3 Claude Code

继续保留 `model_raw`。只有 session log 新增明确 route 字段后，才填 provider evidence；在此之前不得由 `claude-*` 模型名推断 Anthropic。

### 6.4 WorkBuddy 和其他执行环境

复用相同的 adapter 输出契约：保留执行环境原始 provider/model 字段，能提取 endpoint 就写入
`RouteEvidence`；不能提取时仍进入统一的 `metered_estimate` 价格兜底。执行环境专有的真实 credit
账单若存在，属于独立的 actual billing source，不改变本 spec 的 session-only fallback。

## 7. 统一解析和标准化

Harness adapter 只提取原始证据；provider crate 负责标准化：

```text
router.cogfoundry.ai / beta-router.cogfoundry.ai → cogfoundry.ai
openai 官方 endpoint → openai
无法识别 → unknown
```

标准化 matcher 必须是纯函数、版本化、不可修改历史 raw 值。

## 8. 数据库与重放

复用现有表：

- `route_evidence`
- `usage_facts.route_evidence_id`
- `usage_facts.provider_id/provider_raw/evidence_basis`

不新增账单表，不迁移旧事实的 provider identity。新增 emitter 后：

重放沿用现有 harness sync/reprocess 入口，不新增账单表或 provider 专用 SQL；实现必须把
session-native route snapshot 逐事实写入 `route_evidence_id`，并可从原始 session log 重建。

重放必须验证：

- fact_id 守恒；
- 四个 token bucket 守恒；
- 新增 `cogfoundry.ai` facts 只能来自 session-native route evidence；
- 无 route evidence 的旧 custom facts 仍为 unknown/unresolved。

## 9. 测试要求

必须同时提供 Python/Rust fixture：

1. `custom + session_meta.route=cogfoundry` → `provider_id=cogfoundry.ai`。
2. `custom + route_changed` → 前后 token facts 分别归属不同 provider。
3. `custom` 无 route → provider unknown/unresolved。
4. `openai + current custom config` → 仍归属 openai，不能被 current hint 覆盖。
5. route evidence 冲突 → `evidence_basis=conflict`，产生 quality issue，不静默覆盖。
6. 同一 rollout live/archive 重复 → fact_id 不增加。
7. Python/Rust 输出逐字节一致。

## 10. 验收标准

- 新 Codex session 能在日志中携带 provider/endpoint evidence。
- `router.cogfoundry.ai` session 的 usage facts 显示 `provider_id=cogfoundry.ai`。
- 旧 session 没有 route evidence 时不会被错误标记为 CogFoundry。
- 同一 session 内 route switch 不发生跨 provider 串桶。
- UI 能显示 provider、evidence basis、unresolved 原因。
- 重放前后 token 总量和 fact identity 满足守恒。
