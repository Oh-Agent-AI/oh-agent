# v1.0.0-beta.1 自动归因优先规格（程序先定，用户只补程序不知道的）

**状态：** Draft v1（2026-09-16，基于本机权威库只读副本与本地配置的实测证据写成）  
**关系：** 是 [计费确认主链规格](BETA_1_BILLING_CONFIRMATION_CHAIN_SPEC.md) v1.2 的上游——它决定「明确计费方式」列表里**该剩多少组**、弹窗里**该问几步**。PRD REQ-018「存在明确官方订阅/路由证据时自动应用并展示依据；没有明确信号时保留未知」、REQ-022「机器能确认的字段预填，每次只确认一条会改变结果的关系」、REQ-031「不能为了去掉黄色状态强迫用户猜测」是本文的边界。  
**关联：** [发布规格](BETA_1_RELEASE_SPEC.md) B06；[Provider 路由归属规格](../PROVIDER_ROUTE_ATTRIBUTION_SPEC.md)；`crates/agent-vitals-provider/src/lib.rs`（`EvidenceBasis` / `resolve_billing_attribution`）；`docs/CLINE_HARNESS_ASSESSMENT.md` 等执行环境评估。

## 0. 结论

截图里「待明确的计费方式」的 30 组，按本机证据分四类：

| 类 | 组成 | 本月 tokens | 程序能定到哪一步 | 只能问用户 |
|---|---|---|---|---|
| A | claude-code · `claude-*`（sonnet / opus / haiku） | ≈4.5B（45%） | 模型厂商 anthropic、**官方路由**（每条记录 `requestId=req_01…`+`message.id=msg_01…`）、**Claude Pro 订阅**（`oauthAccount.organizationType=claude_pro`）、扣款日 20 号（`subscriptionCreatedAt=2025-07-20`）、Apple 内购 | 月费金额确认（预填 $20） |
| B | codex · `provider_raw=openai`（terra / sol / luna / astra） | ≈2.2B（22%） | 厂商 openai、官方路由（rollout `model_provider=openai`）、**ChatGPT 订阅**（`~/.codex/auth.json auth_mode=chatgpt`，无 API key）、套餐等级（已有配额快照 `plan_type`） | 月费金额确认 |
| C | claude-code · 第三方厂商模型（deepseek 系 / MiniMax / glm、moonshot） | ≈2.7B（27%） | 模型厂商（名族映射）；**不是 Anthropic 官方**（无 `requestId`、`message.id` 是各厂商自己的形状：GLM `msg_20…`、MiniMax/DeepSeek 32 位 hex、moonshot `chatcmpl-…`）；计费按量 | 走的是该厂商官方 Anthropic 兼容端点，还是中转（每个**厂商**问一次，不是每个模型）；中转的价卡（D02） |
| D | codex · `model_provider=custom`（`openai/gpt-5.6-*`、`MiniMax-M3`） | ≈0.5B（5%） | 模型厂商（`openai/` 前缀 = OpenRouter 式命名 → 中转已确定）、按量 | 当时 custom 指向哪家（`config.toml` 里已没有 `[model_providers.custom]`，无法追溯）、价卡 |
| E | workbuddy | ≈1M | 积分制，不是货币（E4b） | 无——**不该出现在待确认列表** |

**A+B 共 66% 程序可以完整判定到计费方式；C 只差一个按厂商问一次的路由问题；真正只有用户知道的是 D 和月费金额。** 现在 30 组全部落到用户头上，根因不是证据不存在，而是：

1. claude-code 适配器把 `provider_id/provider_raw/evidence_basis` 一律写成 `null/null/missing`（`crates/agent-vitals-harnesses/src/harnesses/claude_code/sources/usage_fact.rs:209-214`，注释「never infer Anthropic from the model name」——这条纪律对**计费方**是对的，但它连**模型厂商**和**每条记录里现成的路由证据**也一起放弃了）；
2. 账户级证据（Claude 订阅类型、Codex 登录方式）没有任何读取路径；
3. 公共目录 `catalog_2026_09.billing_modes` 只声明了 `deepseek-v4*` 两条（`assets/pricing.json`），模型名族 → 厂商这层事实没有数据；
4. `route_evidence` 表本月对 claude-code / codex 为空（实测：2026-09 claude-code 25,455 条事实、codex 18,295 条，`route_evidence_id` 全为 NULL；表里只有 8 月 dsh 的 53 行和 codex 的 1 行 config-current）。

## 1. 真机证据（2026-09-16，只读）

### 1.1 事实表现状（`usage_facts`，本月，排除 subscription）

所有待确认组共同形状：`evidence_basis = missing`、`route_evidence_id = NULL`、`billing_mode = metered`、`pricing_basis = metered_estimate`。区别只在：

| harness | provider_id | provider_raw | 说明 |
|---|---|---|---|
| claude-code | NULL | NULL | 适配器不产 provider（§0 根因 1） |
| codex | `openai` | `openai` | rollout 自报 `model_provider=openai`，路由证据仍缺（`resolve_billing_attribution` 的 `official_route_missing` 分支，`provider/src/lib.rs:166`） |
| codex | NULL | `custom` | rollout `model_provider=custom`，`config.toml` 现已无该 provider |
| workbuddy | NULL | NULL | 设计如此 |

### 1.2 每条记录里现成的路由证据（claude-code 会话 JSONL，最近 600 个文件抽样）

| 模型 | `requestId` | `message.id` 形状 | 判定 |
|---|---|---|---|
| claude-sonnet-5 / claude-opus-5 / claude-haiku-4-5 | `req_01…`（400/400） | `msg_01…` | **Anthropic 官方 API**（两个 ID 都是 Anthropic 文档格式） |
| `anthropic/claude-opus-5` | 无 | `msg_bd…` | 厂商前缀命名 + 无 `req_` → **中转**（OpenRouter 式）；证明「不能从模型名推计费方」是对的，但形状证据能把它和官方分开 |
| glm-5.3 / glm-5.3-flash / bigmodel/glm-5.3-flash | 无 | `msg_20…`（时间戳式） | 智谱端点 |
| MiniMax-M3 / M2.7 | 无 | 32 位 hex | MiniMax 端点 |
| deepseek-v4-* / deepseek/* | 无 | 32 位 hex | DeepSeek 端点 |
| moonshot/kimi-k3 | 无 | `chatcmpl-…` | OpenAI 兼容端点 |

### 1.3 账户级证据（本地配置，非凭据）

| 来源 | 字段 | 本机值 | 用途 |
|---|---|---|---|
| `~/.claude.json` → `oauthAccount` | `organizationType` | `claude_pro` | 计费方式 = 订阅，套餐 Claude Pro |
| | `billingType` | `apple_subscription` | 付款渠道（Apple 内购，月费可能≠$20） |
| | `subscriptionCreatedAt` | `2025-07-20T22:26:59Z` | 账期锚点：每月 **20 日** |
| `~/.claude/settings.json` → `env` | `ANTHROPIC_BASE_URL` | 未设置 | 无全局中转配置（第三方模型的 BASE_URL 是启动时环境变量，日志不记） |
| `~/.codex/auth.json` | `auth_mode` | `chatgpt`；无 `OPENAI_API_KEY` | codex openai 路由 = **ChatGPT 订阅** |
| `~/.codex/config.toml` | `[model_providers.*]` | 无；`model_provider` 未设 | D 类的 custom 端点已不可追溯 |

`oauthAccount` 同时含 `emailAddress`、`accountUuid`、`organizationUuid`——本规格**只读上表三个字段**，其余不读、不存、不进任何 DTO/导出（§7 P1）。这触及此前暂停的「读凭据文件」评审（memory `network-credential-boundary`）：这里读的是账户**属性**不是令牌，作为单独例外拍板（§8 D1）。

## 2. 证据阶梯：什么算「程序能定」

把「归因」拆成四个独立事实，各有各的证据来源与强度（复用 `agent_vitals_provider::EvidenceBasis`，不新增枚举）：

| 层 | 事实 | 证据 | 强度 | 谁能定 |
|---|---|---|---|---|
| **L0 模型厂商** `model_vendor` | 这个模型是谁家的 | 模型名族（`claude-`→anthropic、`gpt-`/`o`→openai、`deepseek`→deepseek、`MiniMax`→minimax、`glm`/`bigmodel/`→zhipu-glm、`moonshot/`/`kimi`→moonshot、`hy`→hunyuan） | 确定性（目录数据） | **程序** |
| **L1 路由** `route` | 请求打到了谁的端点 | 每条记录：Anthropic `req_01…`+`msg_01…` → `SessionNative`；codex `model_provider=openai` + 有 endpoint → `SessionNative`；厂商 ID 形状匹配 L0 厂商 → `Inferred`（能说"不是 Anthropic 官方、是 X 家形状"，不能分官方端点/中转）；`model_provider=custom` 或 `vendor/` 前缀命名 → 中转（`Inferred`）；配置 `BASE_URL`/`[model_providers]` → `ConfigCurrent` | 见左 | **程序**（A/B 到 SessionNative；C/D 到 Inferred） |
| **L2 计费方式** `billing_mode` | 订阅 / 按量 / 组织 | 账户级：`oauthAccount.organizationType∈{claude_pro,claude_max,…}` → 订阅（`AccountTimeBound`，锚点 `subscriptionCreatedAt`）；codex `auth_mode=chatgpt` → 订阅、`apikey` → 按量；L1=中转 → 按量 | AccountTimeBound / 推导 | **程序**（A/B）；C/D 推导为按量 |
| **L3 用户补充** | 月费金额、中转是哪家、组织承担、价卡、冲突裁决 | 只有用户知道 | — | **用户** |

规则：**L1 的 `Inferred` 永远不能单独把一批用量判成"官方订阅"**（这正是 `usage_fact.rs:206-214` 注释守的边界）；它只用来把选项收窄到"该厂商官方端点 / 中转"，并把问题从"按模型问"变成"按厂商问一次"。`Conflict`（例如 L0 说 anthropic、L1 形状不是 Anthropic 的）保持现有 E207 处理：单列，不归因。

## 3. 词表修正：`provider_id` 是「计费方」，不是「模型厂商」

现状把两个概念塞在一个字段里，所以列表里 `<unknown>` 既可能是"不知道谁家的模型"（从来不是）也可能是"不知道谁收的钱"（才是真问题）。本规格：

- `provider_id` 语义**不变**（计费方/路由方，`by_provider` 键、MCP 输出都不动——避免 MISMATCH）。
- 新增**派生**字段 `model_vendor`（L0），由目录在读取时计算（`billing_route_of` 同一处，`domain/cost/billing.rs:57`），**不写进 `usage_facts`**（DATA_PLANE §2.1 raw 不可改；派生不入库也不需要 schema）。
- 列表与弹窗一律展示 `model_vendor`，`provider_id` 只在"计费方已定"时出现；`<unknown>` 不再上卡面，改成"计费方待定（模型厂商：deepseek）"。

## 4. 现有表单的问题（对照截图）

| 现象 | 问题 | 本规格 |
|---|---|---|
| 列表按 **模型** 一行一行（同厂商 6 行 deepseek） | 用户要做的决定是按厂商/路由的，不是按模型的 | 行的主键改成 `harness × model_vendor × route_state`；一个厂商一行，模型作为折叠清单 |
| 每行都要点「明确计费方式」 | A/B 类程序已能判定，用户只该**确认** | 行内直接展示「程序判定：anthropic · 官方 · Claude Pro（依据：账号类型 claude_pro · 请求 ID req_01…）」+ 单键「确认」；「不对，我来改」才进弹窗 |
| 弹窗第 1 步问"哪家服务商" | L0 永远不该问 | 删除；预填并只读展示 |
| 第 2 步问"官方还是中转" | A/B 有 SessionNative 证据不该问；C 该问但按厂商问一次 | 有 L1≥SessionNative 时隐藏并展示依据；`Inferred` 时才问 |
| 第 3 步默认「官方订阅」 | 对 C/D 是错误默认（它们是按量） | 默认值由 L2 推导：账户订阅证据 → 订阅；中转 → 按量；无证据 → 不预选 |
| 第 5 步让填起止日期 | 订阅用户想的是"哪天订的、每月扣多少"（用户原话） | 订阅：只确认「套餐 · 扣款日 · 月费」（锚点来自 `subscriptionCreatedAt`）；适用范围由程序给：从订阅开始日到今天，回执写明；非订阅才有起止 |
| workbuddy 行 | 积分制无法折算 | 不进列表，标「积分制」 |

## 5. 目标形态

### 5.1 列表（设置 › 计费与套餐 › 待明确的计费方式）

每行 = `harness × model_vendor × route_state`，三种状态：

1. **程序已判定**（A/B）：`claude-code · anthropic · 官方 · Claude Pro 订阅 · 每月 20 日 · 3 个模型 · 4.5B tokens` + 依据链（`账号 claude_pro · 请求 ID req_01… · 订阅自 2025-07-20`）+ 按钮「确认（$20/月）」「不对」。确认 = 一次点击写声明 + 重算（主链 §5.6），弹窗不出现。
2. **差一问**（C）：`claude-code · deepseek · 3 个模型 · 1.57B tokens · 按量` + 「走的是 DeepSeek 官方端点还是中转？」两个按钮直接在行内；选官方 → 立即写声明（official_api，deepseek 价卡）；选中转 → 弹窗只剩"哪家 + 价卡（可暂不清楚）"。
3. **需要补充**（D）：进弹窗，只显示缺的步骤。

排序：按估算金额降序，程序已判定的组置顶（一键确认清掉最多）。

### 5.2 弹窗（主链规格 §5.3a 的收敛）

只保留 L3 问题：中转是哪家（可选「暂不清楚」）、月费、组织承担、订阅确认。步骤编号继续只给可见项。日期：订阅 → 确认扣款日与开始日（预填）；按量 → 起止（预填组的首尾日）。

### 5.3 自动归因的落地边界（REQ-018 vs 声明是「用户的回答」）

两阶段，先 1 后 2：

- **阶段 1（Beta.1）— 判定但不自动写**：程序算出 verdict 并展示依据，写入需要用户一次点击「确认」。声明的 `evidence_ref` 记 `auto:<basis>`（如 `auto:account.claude_pro+request_id.req_01`），可追溯是程序判定用户确认的。
- **阶段 2（Beta.2）— 自动应用 + 撤销**：对 L1≥SessionNative 且 L2=AccountTimeBound 的组，同步管线在 `sync_facts` 后自动写系统声明（`evidence_ref=auto:…`）并入队重算；列表显示「已自动归因（依据…）[撤销]」。系统声明的 `effective_end` 每次同步刷新到当天——这解决了主链 G3 对**用户**声明"不扩展到未来"的限制与订阅"持续生效"之间的矛盾：用户声明有界，系统声明由系统按证据续。

## 6. 改动清单

| ID | 位置 | 改动 | 对应 |
|---|---|---|---|
| A1 | `assets/pricing.json` `catalog_2026_09` 新增 `model_vendors`（前缀 → 厂商）与 `id_shapes`（厂商 → `requestId`/`message.id` 形状） | 数据，不是规则；`tests/test_pricing_lockstep.py` 守三处副本 | L0 / L1 |
| A2 | `crates/agent-vitals-domain/src/domain/cost/billing.rs` | `model_vendor_of(model) -> Option<&str>`；`billing_route_of` 不变 | L0 |
| A3 | `crates/agent-vitals-harnesses/src/harnesses/claude_code/sources/usage_fact.rs` | 每条记录按 §1.2 形状产 `RouteEvidence`：`req_01`+`msg_01` → `provider_raw="anthropic"`, `endpoint_host="api.anthropic.com"`, `SessionNative`；厂商形状 → `provider_raw=<vendor>`, `Inferred`；`anthropic/`/`openai/` 前缀且无 `req_` → `Inferred` + `provider_raw="relay"`；写 `route_evidence` 行并回填 `route_evidence_id`。`provider_id` 仍由 `resolve_billing_attribution` 决定（不再是常量 null） | L1 |
| A4 | `crates/agent-vitals-provider/src/lib.rs::resolve_billing_attribution` | 增加 anthropic 官方分支（与 openai 分支对称：`provider_raw=anthropic` + `SessionNative` + 账户订阅证据 → `Subscription`/`session-provider`；无账户证据 → `Metered`/`route-observed`，`has_unresolved=false`） | L1+L2 |
| A5 | 新 `crates/agent-vitals-harnesses/src/harnesses/claude_code/sources/account.rs` + `codex/sources/account.rs` | 读 §1.3 的字段（白名单三个 + `auth_mode`），产 `AccountEvidence{plan, billing_channel, anchor_date, basis=AccountTimeBound}`；**不读、不存、不序列化** email/accountUuid/token；feature-gated `sources` | L2 |
| A6 | `crates/agent-vitals-runtime/src/billing_preview.rs::confirmation_groups` | 组键改 `harness × model_vendor × route_state`；每组带 `auto_verdict{provider_id, route, billing_mode, plan, anchor_day, basis[], confidence}`；workbuddy 直接排除 | §5.1 |
| A7 | `crates/agent-vitals-data/src/authority_query.rs::SQL_UNRESOLVED_BILLING_GROUPS` | 分组列去掉 `model_id`（模型进 `models[]` 子列表），加 `provider_raw`；待处理投影同步 | §5.1 |
| A8 | `apps/desktop/src-tauri/ui/workbench.js` | 列表三态渲染；「确认」直写声明（`evidence_ref=auto:…`）；弹窗只剩 L3 步骤；订阅步改为确认扣款日/月费；`<unknown>` 不上卡面 | §4/§5 |
| A9 | `apps/desktop/src-tauri/src/lib.rs::validate_desktop_declaration` | 系统判定确认的声明允许 `effective_start = subscriptionCreatedAt`（早于本月）；`effective_end` 仍 ≤ 今天 | §5.2 |
| A12 | 新 `crates/agent-vitals-harnesses/src/sources/endpoint_evidence.rs`（跨执行环境提取器；2026-09-16 泛化，原 claude 专用的 `harnesses/claude_code/sources/config.rs` 已删除） | 逐执行环境读取器（claude=`settings.json` 的 `env` 白名单 5 键；codex=`config.toml` 的 `[model_providers.*].base_url`；pi/workbuddy=逐模型 `baseUrl`/`url`；dsh=`settings.yaml` 的 `llm-*` 段）→ 中立 `EndpointEvidence{base_url, endpoint_host, endpoint_hostnames, model_endpoints, provider_name, gateway_named_models}`，`ConfigCurrent`(4)。**逐模型端点优先**；没有时按执行环境级列表：单个非官方端点敢点名，全是非官方且多个 → `config.endpoint.multiple`，官方与中转混配 → `config.endpoint.ambiguous`，厂商认不出 → 不做断言。凡判 `relay_config` 恒为 `one_question`（强度 4 不能单独判定）；与会话级官方形状并存时追加 `config.endpoint.conflict`（P5） | §2 L2 端点面 / §10.2 层② |
| A11 | 「确认」直写声明（阶段 2） |
| A10 | `tests/`：`test_pricing_lockstep.py`（新目录段）、harnesses 单测（每种 ID 形状一条 fixture）、`billing_preview` R-测（verdict 三态）、隐私测（任何 DTO/导出/日志不含 email/accountUuid） | | §7 |

阶段 2（A11）：`sync_service` 在 ingest 后跑 `auto_attribute()`，对满足 §5.3 条件的组写系统声明并入队；撤销与用户声明同一机制。

## 7. 不变量与验收

- P1 隐私：`oauthAccount` 只读 `organizationType/billingType/subscriptionCreatedAt`；测试 grep 所有 DTO、`data-export-*`、诊断包不出现 `emailAddress`/`accountUuid`/`organizationUuid`。
- P2 `Inferred` 不产订阅：任何 `evidence_basis=inferred` 的事实在没有用户确认前 `billing_mode` 只能是 `metered`。
- P3 冲突不吞：L0 厂商与 L1 形状矛盾 → `Conflict`，进「仍待确认」，不进自动判定。
- P4 词表不漂：`provider_id`/`by_provider`/MCP `cost_breakdown` 键与语义不变；`model_vendor` 是新增派生字段，`test_harness_contract` 与 MCP 冒烟 0 MISMATCH。
- P5 数字守恒：自动归因只写 `billing_fact_attributions`，`usage_facts` 计数与 token 总量不变（`data-reimport-verify`）。
- 本机验收目标：待明确列表 30 组 → **≤ 7 行**（A 1 行确认、B 1 行确认、C 3 个厂商各 1 行一问、D 2 行）；A+B 确认后本月未归属 tokens 从 10.1B 降到 ≤ 3.3B。

## 8. 待拍板

- **D1 读 `oauthAccount` 三字段**：属于此前暂停的凭据文件评审范围；本规格建议作为白名单例外放行（只读属性、不读令牌、不出 DTO）。不放行则 A 类退化为"官方路由已定、订阅需用户点一次"——仍比现在少 44 个问题。
- **D2 阶段 2 的自动写声明**：REQ-018 允许"自动应用并展示依据"，主链规格 §2.3 把声明定义为用户回答；建议用 `evidence_ref=auto:` 前缀区分系统声明，且系统声明可被用户声明 supersede。
- **D3 `model_vendor` 派生 vs 入库**：建议派生（无 schema 变更、无 raw 改写）；代价是每次读要跑一次前缀匹配（目录 < 20 条，可忽略）。
- **D4 C 类的"官方端点 vs 中转"**：能否再从 `message.id` 形状更细分（例如 DeepSeek 官方 vs 胜算云的 hex 长度/前缀）？本规格不承诺，留作 Inferred；若真机样本能证明形状唯一，可升到 `SessionNative`。

## 9. 顺序

1. A1 + A2 + A6/A7 + A8 的列表三态（先让列表**显示**程序能判定什么，但确认仍手动）——这一步不碰适配器与账户读取，零隐私风险，列表立刻从 30 行收敛到按厂商的 ≤ 10 行。
2. A3 + A4（claude-code 路由证据）——A 类变成"官方路由已定"。
3. D1 拍板后 A5（账户证据）——A/B 变成一键确认。
4. A9 + 弹窗收敛 + 测试。
5. 阶段 2（A11）单独评审。

## 10. 可扩展性：归因特征模板化，让新执行环境 / 新厂商 / 新模型快速接入

### 10.1 先看七个执行环境各自给了什么（本仓库已评估的执行环境）

| 特征 | claude-code | codex | dsh | workbuddy | pi | hermes | cline |
|---|---|---|---|---|---|---|---|
| 模型名（raw） | ✅ | ✅ | ✅ | ✅ | ✅ `modelId` | ✅ | ✅ `metadata.modelId`（带厂商前缀 `anthropic/…`） |
| 执行环境自报 provider | ✗ | `model_provider`（openai / custom） | `provider_raw` | ✗（设计如此） | `model_change.provider` | `billing_provider`（`minimax-cn` / `auto`） | `provider` + `modelInfo` |
| 端点 / base_url | 启动环境变量，日志不记 | `config.toml [model_providers.*].base_url` | ✗ | ✗ | `models-store.json` | `.env`（凭据文件，**不读**） | `providers.json` |
| 请求 / 响应 ID 形状 | ✅ `requestId` + `message.id`（§1.2） | 部分 | ? | ✗ | ? | ? | ? |
| 账户 / 套餐证据 | `oauthAccount.{organizationType,billingType,subscriptionCreatedAt}` | `auth.json auth_mode` + 配额快照 `plan_type` | ✗ | credit 积分 | ✗ | ✗ | ✗ |
| 执行环境自报成本 | ✗ | ✗ | ✗ | credit（非货币） | ✅ per-message `usage.cost`（provider-reported） | 列全 0 | ✅ `totalCost` + per-message |
| 本地价卡缓存 | ✗ | ✗ | ✗ | ✗ | `models-store.json` | `models_dev_cache.json`（213 provider / 7,126 带价） | 4 个网关的 `*_models.json` |

结论：**没有一个特征是七个执行环境都有的，但每个执行环境都至少有两个**——所以归因不能是"每个执行环境一套写死的 if"，也不能是"一套字段人人必填"，而应是一条**证据阶梯 + 可插拔的证据提取器**：执行环境声明它能提供哪些提取器，缺的就是 `missing`，不猜。

### 10.2 三层拆分：什么必须写代码，什么能做成模板（数据）

| 层 | 内容 | 形态 | 新执行环境接入要做的 | 新厂商 / 新模型接入要做的 |
|---|---|---|---|---|
| **① 线格式适配器**（已有） | 文件发现、JSONL/SQLite/zstd 解析、会话身份、token 桶语义与去重（`(turn,step)` vs `total_token_usage` 签名等） | **代码**（`harnesses/<h>/sources`），不可模板化——每个执行环境的去重规则都是踩过坑的 | 写一个（现状不变） | 不需要 |
| **② 证据提取器**（本规格新增） | 从 ① 的记录/配置里取出 `AttributionEvidence` 候选：厂商前缀、ID 形状、端点、provider_raw、账户属性、自报成本 | **模板 + 少量代码**：一份执行环境 `AttributionProfile`（声明用哪些提取器、字段在哪个 JSON 指针/文件），提取器本身是通用实现 | 填一份 profile（大多数执行环境 5–10 行） | 不需要 |
| **③ 判定器**（`agent-vitals-provider`） | 证据阶梯 L0–L3 的合成规则：强度比较、冲突判定、订阅判定 | **代码，执行环境无关**；厂商知识全部外置到签名目录 | 不需要 | 不需要 |
| **④ 厂商签名目录**（本规格新增数据） | 每个厂商：模型名前缀/正则、`vendor/` 前缀命名约定、请求/响应 ID 形状、官方端点主机名、套餐标记、价卡引用 | **纯数据**（`assets/attribution_signatures.json`，与 `pricing.json` 同一 lockstep 纪律） | 不需要 | 加一条签名（新模型通常只是前缀已覆盖，零改动） |

现状对照：③ 里现在混着厂商知识——`provider/src/lib.rs` 的 `is_cogfoundry_host` / `is_openai_host` / `Some("openai") =>` / `model_provider == Some("openai")` 全是写死的（`:85-99`、`:140-156`）；`billing_route_of` 只认 `catalog_2026_09.billing_modes` 里的两条 deepseek。**模板化的第一步就是把这些常量搬进 ④**，判定器只剩阶梯规则。

### 10.3 有普适性的特征（可以进 ④ 的签名目录）

按"跨厂商稳定、跨执行环境可得"排序：

1. **模型名族**（L0）：每家厂商的命名前缀稳定多年（`claude-`、`gpt-`/`o`、`deepseek`、`MiniMax-`、`glm-`、`kimi`/`moonshot`、`hy`/`hunyuan`、`qwen`、`gemini`、`llama`）。普适性最高；新模型 95% 落在已有前缀里。
2. **`vendor/model` 前缀命名**：OpenRouter / 胜算云 / Vercel Gateway / Cline 的通用约定——**名字本身就说明走了网关**，且前缀 = 模型厂商。这是"中转"最廉价的判定特征，七个执行环境里 codex-custom、cline、hermes 都能用。
3. **请求 / 响应 ID 形状**（L1）：每家 API 的 `id` 格式是文档级稳定的（Anthropic `msg_01…` / `req_01…`、OpenAI 兼容 `chatcmpl-…`、智谱 `msg_20…` 时间戳式、MiniMax/DeepSeek 32 位 hex）。只要执行环境把原始响应写进日志就能用（claude-code 已证实；cline/pi 待核）。
4. **官方端点主机名**：`api.anthropic.com`、`api.openai.com`、`api.deepseek.com`、`open.bigmodel.cn`、`api.minimax.chat`……配置里出现即 `ConfigCurrent`，会话里出现即 `SessionNative`。`normalize_host` 的边界匹配逻辑已有，只是主机名表要外置。
5. **执行环境自报 provider 的词表映射**：`minimax-cn` → minimax、`auto` → unknown、`custom` → 中转——每个执行环境一张小表，放 profile。
6. **账户 / 套餐标记**：形状各异（claude 的 `organizationType`、codex 的 `auth_mode`、hermes/cline 是"配置里有该 provider 的 key 存在"→ 按量），但**抽象一致**：`AccountEvidence{plan_kind: subscription|api_key|credits|unknown, anchor_date?, channel?}`。profile 里声明"文件 + 字段白名单 + 取值映射"，读取器通用；**白名单之外一律不读**（隐私守卫跨执行环境一次写好）。
7. **执行环境自报成本**：`provider-reported`（pi）> `harness-reported`（cline totalCost）> `credits`（workbuddy）> `none`（hermes 全 0）；这是 `ATTRIBUTABLE_WASTE` §3 的 basis 分级，已有，只需 profile 声明字段位置。

### 10.4 不能模板化、也不该模板化的

- **去重与 token 语义**（①）：Codex 的 `total_token_usage` 签名去重、DSH 的 `(turn,step)`、Claude 的 message.id 去重——错一个就是 2–3 倍重复计数（memory：claude ledger 重复计数事故）。这是代码 + 回归测试，不是配置。
- **冲突裁决**：L0 说 anthropic、L1 形状不是 Anthropic 的 → 只能 `Conflict` 进待确认；模板不能替用户裁决（REQ-031）。
- **中转的价卡**：网关的价格是商业信息，可以从 models.dev 快照给 `catalog-fallback` 档，但不能冒充 `provider-reported`（Hermes 评估 §5）。

### 10.5 新厂商 / 新模型怎么"自己归因"

三条来源，按可信度：

1. **签名目录快照**（④）：随版本发布的 `attribution_signatures.json`；models.dev 的本地镜像（Hermes 已缓存 7,126 带价模型）可以作为**生成**这份快照的上游——离线生成、进仓库、走 `test_pricing_lockstep` 守卫，不在扫描时联网（CLAUDE.md 供应链约束不变）。
2. **本地学习**：用户在弹窗里答过一次"`openai/gpt-5.6-*` 走的是胜算云"，系统把它写成本地签名（`pricing-overrides.json` 的 `routes` 已经是这个机制——`model_prefix → provider`；扩展成 `signatures: {model_prefix|id_shape|endpoint → provider}`），下次同厂商新模型直接命中，不再问。
3. **启发式兜底**：未知前缀 + 无 ID 形状 + 无端点 → 诚实 `missing`，进待确认；**不做"看起来像 X"的猜测**。

### 10.6 与现有架构的落点

- ④ 签名目录：`assets/attribution_signatures.json`（Rust `include_str!`、Python `json.load`、dsh-client 复制），三方 lockstep 测试与 `pricing.json` 同款。
- ② `AttributionProfile`：放进已有的 `contracts/harness_capability.rs::HarnessProfile`（它已经按执行环境声明 `signals`、`degraded_rules`、`fold`），新增 `attribution: &'static AttributionProfile { extractors: &[…], provider_raw_map: &[…], account_evidence: Option<AccountSource>, cost_report: CostBasis }`。注册路径 fail-closed 的纪律不变：不在 `HARNESSES` 里的执行环境任何提取器都不跑。
- ③ 判定器：`agent-vitals-provider::resolve_billing_attribution` 改为接收 `&[AttributionEvidence]` + `&SignatureCatalog`，删除所有厂商常量；现有 `EvidenceBasis` 强度表不变。
- 通用提取器实现放 `crates/agent-vitals-harnesses/src/attribution/`（执行环境无关，纯函数，wasm 可链）；I/O 型提取器（读配置/账户文件）挂 `sources` feature。

### 10.7 一个新执行环境的接入清单（目标：半天）

1. ①：线格式适配器（已有流程，不变）。
2. ②：在 `HarnessProfile` 里填 `attribution`：模型字段路径、provider_raw 字段 + 映射表、ID 字段路径（如有）、端点来源（会话字段 or 配置文件 + 键）、账户证据文件 + 字段白名单（如有）、自报成本字段 + basis。
3. 跑同一套 `attribution` 夹具测试：每个提取器一条"有 → 命中 / 无 → missing"的用例；隐私测试自动覆盖新白名单。
4. 不用改判定器、不用改 UI——列表三态和弹窗读的是 `auto_verdict`，执行环境无关。

Cline 就是现成的验证对象：`metadata.modelId = anthropic/claude-sonnet-4.6` 命中 10.3 第 2 条（网关命名），`providers.json` 命中第 4 条，`totalCost` 命中第 7 条——三条都是模板层就能吃下的，不需要为 Cline 写一行归因代码。

## 11. 执行记录（2026-09-16，分支 `worktree-v1.0.0-beta1-p2-clarify-billing`）

按「分析 → 开发 → 测试 → 子代理验收」循环，三轮落地；§8 四项未拍板的按下列假设执行，用户可推翻：

| 待拍板 | 采用的假设 | 影响面 |
|---|---|---|
| D1 | **放行白名单三字段**：`read_claude_account` 只读 `oauthAccount.{organizationType,billingType,subscriptionCreatedAt}`，`AccountEvidence` 结构没有 email/uuid/token 的槽位；泄漏测试钉住 | 不采纳则 A 类退化为"官方路由已定、订阅需手填" |
| D2 | **只做阶段 1**：判定 + 用户一次点击确认，声明 `evidence_ref = auto:<basis>;confirmation-group:<ids>`；阶段 2 自动写声明未做 | 无系统声明、无撤销 UI |
| D3 | **派生**：`model_vendor` 每次读时按签名目录前缀匹配，不入库、无 schema 变更 | — |
| D4 | **留作 Inferred**：第三方厂商形状（MiniMax hex、GLM `msg_2026…`）只到 `vendor_shape`，不升 `SessionNative` | C 类仍是"差一问" |

### 11.1 三轮改动（与 §6 编号对照）

| 轮 | 落地 | 提交 |
|---|---|---|
| 1 | A1（改为独立 `assets/attribution_signatures.json`，不塞进 `pricing.json`：目录含 ID 正则，与价卡不是同一 lockstep）· A2（`domain::attribution::{model_vendor, route_shape}`，Python 镜像 `agent/attribution.py`）· A3/A4（claude-code emitter 按 §1.2 形状产 `RouteEvidence`，`provider_id` 经 `resolve_billing_attribution`）· `PARSER_VERSION 3` 一次性重放 | 1aa3d78 · a64aada |
| 2 | A5（`claude_code/sources/account.rs`、`codex/sources/account.rs`）· A6（`billing_preview::auto_verdict` + `clusters_of`，DTO 同时返回 `groups` 与 `clusters`，旧消费方不变）· A8 列表三态 + 弹窗预置 · CLI `billing-groups` · 验收审查 5 项修复 | 3cc85d1 · 6f45ba0 |
| 3 | A8 弹窗收敛：订阅步只确认「套餐 · 订阅日期（首次扣款日）· 月费」，适用范围由程序给（订阅日 – 今天），起止行不出现；`evidence_ref=auto:` · A9 核对：`validate_desktop_declaration` 本就没有月份下界，`effective_start` 可早于本月，无需改动 | 本轮 |

未做（有意）：A7（SQL 分组列去 `model_id`——簇在 runtime 层折叠即可，SQL 不动）· A10/A11（阶段 2）· 「确认」直写声明不经弹窗（阶段 1 仍走弹窗确认月费，因为月费不在任何证据里）。

### 11.2 两处有意的偏离（验收审查提出，记录为决策）

1. **推断行 `provider_raw = null`**。`vendor_shape` / `gateway` 形状**不**把厂商写进 `provider_raw`：`normalize_provider` 会把非空 raw 直接变成 `provider_id`，"厂商形状一致"就冒充成了"计费方已定"（P3 不变量）。厂商只进 `auto_verdict.model_vendor`（派生），事实行保持 `provider_id = null`、`evidence_basis = inferred`。
2. **`PARSER_VERSION` 升版是全局的**。它让所有执行环境的 source 一次性重放（含 WorkBuddy），不是只重放 claude-code；代价是一次 25 s 的重放，换来的是不引入按执行环境的版本表。事实幂等（`fact_id`），重放不产生重复。
3. **判定器的冲突规则只对"执行环境没有自报 provider"放开**。`model_provider = None`（Claude Code）时会话级路由证据是唯一真值；执行环境自报了 provider（DSH `provider_raw`、Codex `openai`）的旧口径（provider-v0.11）原样保留——DSH 自报 deepseek 仍落 `metered_estimate`，Python `dsh_usage_fact.py` 与已入库事实都按它对齐，收紧要连同 `attribution_version` 一起升版。

### 11.3 真机结果（隔离副本重放，`isolated_sync.sh`）

- claude-code 本月 25,323 条事实：12,272 → `session-native / anthropic / route-observed`，12,916 → `inferred`，135 `<synthetic>` → `missing`；归属冲突 0。
- `data-status` `unresolved_tokens` 13.61B → 5.0B。
- `billing-groups --month 2026-09`（真机，最终形态）：**30 行 → 9 簇**
  - **2 程序判定（一键确认）**：`claude-code · anthropic`（Claude Pro，4.77B tokens，依据 `route.session-native + account.Claude Pro`）与 `codex · openai`（ChatGPT，2.24B，依据 `harness.provider_reported + account.ChatGPT`）。
  - **6 差一问**：deepseek / minimax / zhipu-glm（`vendor_shape` → 问"官方端点还是中转"）与三个网关式命名簇（`gateway` → 同上）。共 ~3.1B tokens。
    （§11.4 #4 修好簇主键后，网关簇按厂商拆开：claude-code 的 `deepseek` 与 `zhipu-glm` 各成一行，
    所以是 **10 簇**，不再是 9——拆开是对的，标签不再借第一组的厂商名。）
  - **2 需补充**：codex 的 `<unknown>` 与 minimax（无路由证据）。共 ~0.14B tokens。
- 账户证据真机读数：`plan.label=Claude Pro`、`channel=apple_subscription`（由 `billingType` 推出）、`anchor_date=2025-07-20`（订阅锚点，即每月 20 日扣款——与用户"每月20美金、20日扣款"的描述一致）；DTO 中不含 email / accountUuid / organizationUuid / 令牌（真机输出扫描确认）。

### 11.4 验收审查与修复（iteration 3 → 4）

子代理按 §1–§7 逐条验收 iterations 2–3，报 6 条确认缺陷（全部为真，`e97ffa1` 修复）：

| # | 缺陷 | 后果 | 修复 |
|---|---|---|---|
| 1 | `auto_verdict` 把 `evidence_basis="conflict"` 归到 `provider_reported` | codex 自报 openai 而会话路由指向别家的冲突事实，配上 `auth_mode=chatgpt` 就成了「一键确认 ChatGPT 订阅」——违反 §2「Conflict 单列，不归因」与不变量 P3（此前只有写入侧的 `ConflictEvidence::Exclude` 兜住了钱，判定与标签是错的） | `conflict` 短路：`needs_input` + `route_state="conflict"`，`billing_party=null`，依据 `route.conflict` |
| 2 | `ROUTE_KNOWN_OFFICIAL` 收 `account-time-bound`(6)/`config-time-bound`(5) | 低于 §2/§4 的 ≥ `SessionNative` 门槛：配置文件写着"官方"就能产一键订阅。今天无 emitter 产这两种 basis，属潜在洞 | 收窄为 `explicit-official-route` + `session-native`（前端同表同改） |
| 3 | 簇渲染后，挂在有用量组上的旧资产候选被整行跳过 | 提示说"另有 N 条旧版本套餐记录待核对"，页面上却无处核对、无处忽略 | 候选折进对应簇行（证据行 +「这不是我的套餐」） |
| 4 | 簇主键用 `billing_party`，网关行恒空 | 不同厂商的网关模型并成一行，再用第一组的厂商当整行标签——与 §5.1「行 = harness × 厂商 × route_state」不符 | 主键改为 `billing_party or model_vendor` |
| 5 | 从订阅切到按量时，程序写进去的订阅锚点留在 `effective_start` | 真机锚点 `2025-07-20` 会被写进一条**按量**声明 | 切走时撤回组自己的默认起止（只在值仍是程序写入的锚点时才撤，不动用户手改） |
| 6 | `evidence_ref` 在挂了旧候选时丢掉 `auto:` 依据链 | 程序判定 + 候选并存时，追溯性只剩候选 id | 两段都记；簇行的 target 也带上原组的 `candidate`，`source_candidate_id` 不再丢 |

新增测试：Rust `auto_verdict_covers_conflict_api_key_and_cluster_arithmetic`（冲突 / 官方+ApiKey → `official_api` / 官方+无账户 → 问计费方式 / 账户厂商不匹配不套用 / 零 token 组不进列表 / 网关行按厂商拆簇 / 簇内 tokens 与分币金额等于各模型之和）；`verify-workbench-sources.mjs` 新增 8 条断言（含候选折进簇行与锚点撤回）；浏览器 mock 补 `conflict` 分支，使这类缺陷今后能被前端守卫抓到。

### 11.5 修复的复验（iteration 4）

对 §11.4 的六条修复再做一轮验收：**4 条 PASS、1 条 PARTIAL、1 条 PASS 但暴露新缺陷**，另加 3 条低危项。本轮全部处理：

| 来源 | 问题 | 处理 |
|---|---|---|
| 复验 #5 | 我修 #5 时引入的新缺陷：撤回判据用"值相等"，而没有账户锚点的组里 `anchor` 只会被填成组首日，于是**每次 restep 都会把用户手改的结束日期抹回默认** | 改成"程序是否真的写过"标志：只有 `plan.anchor_date`（账户证据）落进 `start` 时才置 `anchorApplied`，撤回只看这个标志 |
| 复验 #2 | 冲突/needs_input 行的计费方式仍默认「官方订阅」（`billing_mode` 为 null 时落到 else 分支），与 §4「无证据 → 不预选」冲突 | `<select>` 增加空占位项；预选只来自 `billing_mode`；未选时保存被前端拒绝并提示。路由先于计费方式判定（中转/仍不确定不需要计费方式） |
| 复验 #3 | §11.4 #2 的收窄没有测试守——把 `account-time-bound`/`config-time-bound` 放回去不会有任何测试变红 | 新增两条事实（两种弱证据 + 官方 provider）断言 `one_question` 且 `route_state != official` |
| 复验 #4 | 浏览器 mock 的簇主键仍只用 `billing_party`，与 Rust 不同键 | 同步为 `billing_party \|\| model_vendor \|\| "<unknown>"`；`rowByGroupId` 提到 `clusterRowsOf` 之前，消除 TDZ 依赖 |

复验同时确认：真实数据下网关簇确实按厂商拆开（`claude-code|deepseek|gateway` 与 `claude-code|zhipu-glm|gateway`）；冲突短路返回的对象与常规路径同键，`clusters_of` 与前端都不会因 `billing_party: null` 出错；新增的 Rust 测试在删掉冲突短路或把簇主键改回 `billing_party` 时都会失败（两条缺陷各自被独立断言抓住）。

### 11.6 端点/配置证据（A12，2026-09-16 用户提问驱动）

**问题**：用户在「明确计费方式」里看到 `claude-code · 服务商未知 · deepseek-v4-flash-0731`（856M tokens），
问"能不能知道是哪个 provider？有 base url 信息吗？胜算云还是 deepseek 官方？"

**排查（只读真机）**：

1. **会话日志里没有端点**：44,827 条含 deepseek 的记录中 `requestId` 只出现 176 次，日志正文里的
   `router.shengsuanyun.com` 全是**对话内容**而非请求元数据——§10.1 表格里 claude-code 那格写的
   "端点：启动环境变量，日志不记"被真机确认。
2. **配置里有**：`~/.claude/settings.json` 的 `env` 为
   `ANTHROPIC_BASE_URL = https://router.shengsuanyun.com/api`，模型映射 `ANTHROPIC_MODEL = deepseek/deepseek-v4-pro-0813`
   等。→ 这批用量走的是**胜算云**，不是 DeepSeek 官方。
3. **两条独立的配置信号**（第二条由用户指出，已实现）：基址不是官方端点；以及**模型映射带
   `vendor/model` 前缀——官方端点不需要厂商 id（`deepseek-v4.1-flash`），中转才需要
   （`deepseek/deepseek/…`）**。只换中转、不改基址的配置靠第二路才不漏判。
4. 该批事实里的模型名是**裸名**（中转上报的上游名），配置里才是带前缀的；所以我们此前判
   `vendor_shape`（32 位 hex 响应 id，中转直通时与官方同形）——这正是它只能到 `Inferred` 的原因。

**真机效果**（`billing-groups --month 2026-09`）：

```
claude-code  shengsuanyun.com  one_question  relay_config  models=11  tokens=2762606626  basis=config.endpoint+config.gateway_named
```

11 个模型（2.76B tokens）从 6 个"请你回答官方还是中转"的行收敛成 **1 行**并直接写出中转名字；
判据是 `config-current`(4)，所以仍是"一次确认"，不是替用户断言。

**隐私**：`env` 里紧挨着 `ANTHROPIC_AUTH_TOKEN`。读取器**白名单取键**（5 个），令牌连值都不复制；
`EndpointEvidence` 没有令牌槽位且故意不 derive `Serialize`；测试注入假令牌 + **穷举解构**（新增字段即编译失败）+ `{:?}` 断言它不出现在结构里。

**残留风险（已显式暴露）**：中转代理 Anthropic 时会**原样保留** `req_01…`/`msg_01…` 形状，于是
"会话级官方形状"与"配置指向中转"可以同时成立。判定不推翻强证据，但依据里出现
`config.endpoint.conflict`，UI 显示"⚠ 但这批用量是官方形状，而配置指向中转——两者需你核对"。
**真机提示**：本机 claude-code 的 Claude Pro 声明（`evidence_ref=auto:route.session-native+account.Claude Pro`）
正是这种形状——若那批用量实际也经胜算云，该声明需要重新核对。

### 11.7 端点证据跨执行环境化 + 执行环境人格归位（A12 泛化，2026-09-16）

用户两条意见驱动：

> 「其他执行环境和模型供应商应该也有类似的逻辑，这个规则不仅仅在 claude」
> 「agent-vitals-runtime 写了很多 adapter 层的逻辑吗？有一些 harness 强相关的逻辑不是应该在执行环境层处理吗」

**第一件：端点证据跨执行环境化。** 真机勘测（只读）证明每个执行环境都有端点配置，形状各不相同：

| 执行环境 | 文件 | 本机实测 |
|---|---|---|
| claude-code | `~/.claude/settings.json` `env` | `router.shengsuanyun.com/api`（中转） |
| dsh | `~/.dsh/settings.yaml` | `agent-default-model.provider: deepseek-official`（用户写的标签）；**LLM 段 `llm-deepseek.baseURL` = `https://api.deepseek.com`（官方）**；中转只在 `web-search-deepseek` 段（搜索，不算 LLM） |
| workbuddy | `~/.workbuddy/models.json` | 配了三个端点：`api.minimaxi.com` / `beta-router.shengsuanyun.com` / `router.shengsuanyun.com` |
| pi | `~/.pi/agent/models-store.json` | 每模型 `baseUrl`（本机 `chatgpt.com`） |
| codex | `~/.codex/config.toml` | **无** `model_providers` 段 → 官方路径，诚实返回"无证据" |
| hermes | `.env` | **凭据文件，整体不读**（§10.1 定案） |
| cline | `~/.cline/data/settings/providers.json` | 只有服务商**名**（`lastUsedProvider: shengsuanyun`）没有 URL——名字 ≠ 中转（可能是自建），故本期不用；留待"未知服务商名"的决策 |

读取器落 `crates/agent-vitals-harnesses/src/sources/endpoint_evidence.rs`（跨执行环境 I/O 层，
路径含 `/sources` 落进既有的 `io_tokens_only_appear_under_sources` 守卫）；判定器只吃中立的
`EndpointEvidence`，不认识任何执行环境的文件格式。每个读取器**白名单取键**：凭据就挨在同文件里
（claude 的 `ANTHROPIC_AUTH_TOKEN`、workbuddy 的 `apiKey`、pi 的 `maxTokens`、cline 的 `tokenSource`），
读取器连值都不复制，测试注入假令牌 + **穷举解构**（新增字段会编译失败）+ `{:?}` 断言。

多端点诚实：配置里列了多个端点时判定器**不替用户挑**（workbuddy 本机就有三个），
只给 `relay_config` + 依据 `config.endpoint.multiple`、计费方留空。

**第二件：逐模型端点（真机形状纠正）。** workbuddy 与 pi 的配置**本来就是逐模型的**——
`~/.workbuddy/models.json` 每条 `{id, name, vendor, url}` 各自带端点（`MiniMax-M3 → api.minimaxi.com`、
`deepseek/deepseek-v4-flash → beta-router.shengsuanyun.com`），pi 每模型带 `baseUrl`。
把它们压成一个"执行环境级端点列表"就丢了配对的精度（验收审查 iteration 7 #2），
所以 `EndpointEvidence.model_endpoints` 逐模型记下来，判定器**逐模型端点优先**：
同一条配置里 MiniMax 走官方、deepseek 走中转，各自判各自的。workbuddy 的读键也从
不存在的 `model` 改成真机的 `id`（旧写法让这个执行环境的前缀信号一直是死的，而测试用的
假键名把错误形状钉成了绿——正是 CLAUDE.md「形状来源纪律」警告的那种假绿）。

执行环境级列表仍在，规则收敛成三档：单个端点 → 敢点名；**全是**非官方端点且多于一个 →
`config.endpoint.multiple`（不挑）；官方与中转**混着配** → `config.endpoint.ambiguous`
（不给断言也不装作没看见）。厂商未知时（`model_vendor` 认不出）**一律不做中转断言**——
那时"官方端点"无从谈起，旧写法会把 `api.anthropic.com` 也说成中转名（验收审查 iteration 7 #1）。

**第三件：执行环境强相关规则搬回执行环境层。** 用户点出的正是本仓库自己的架构纪律
（`HarnessProfile` = 执行环境人格声明，`harnesses/<h>/capability.rs` 为落点）。`billing_preview` 里
原有的两处执行环境名字判断已删除：

| 原写法 | 现写法 |
|---|---|
| `groups.retain(\|g\| g["harness"] != "workbuddy" && …)` | `AttributionProfile::credits_only` 声明 |
| `("provider_reported", Subscription) if harness == "codex"` | `AttributionProfile::provider_reported_implies_official` 声明 |

`AttributionProfile { provider_reported_implies_official, credits_only }` 进
`contracts/harness_capability.rs::HarnessProfile`（§10.6 早已写明它该落在这里），随
`harnesses --json` 序列化——**双实现契约**：Python `harness_capability.py::HARNESSES` 同步加字段，
`test_cli_matrix::test_harnesses_json_byte_parity` 逐字节比对。未知执行环境 fail-closed 到
`NEUTRAL`（不做任何特殊处理）。新增执行环境接入 = 填一行声明，不改判定器。

**仍留在 runtime 的执行环境名字**（本期未动，同一纪律的欠账）。这份清单是**抽样不是穷尽**——
`agent-vitals-runtime` 里执行环境名字面量实测 **171 处出现在非测试代码**（含测试共 460 行命中；
`summary.rs` 46、`sessions/r2a_store.rs` 34、`skills/scanner.rs` 24、`sync_service.rs` 21…）（多数是注册表分派，
如 `FACT_HARNESSES`/`WIRED_HARNESSES`/`TRACE_HARNESSES` 与 `sync_service`/`trace_service` 的 harness→函数分派，
那是正当的路由）；**其中真正像"执行环境名字决定一条规则"的**至少还有：
`mcp/cost_breakdown.rs:405,416`（逐执行环境计价语义）、`mcp/data_status.rs:252,256,258`（逐执行环境状态语义）、
`price_discovery.rs:40`（`ROUTE_UNCONFIRMED_EXEMPT_HARNESSES`）、`sql_sync.rs:136`（provider→harness 映射）、
`skills/scanner.rs:206,226,234,237,251,357,362,371,472,485,503,580,640,660,715`、
`skills/inventory.rs:176,203,214,219`、`sync_service.rs:84,136,170,214`、`r2a_store.rs:368,381,1570`。
用 `/usr/bin/grep -nE '"(claude-code|codex|dsh|workbuddy)"' crates/agent-vitals-runtime/src -r`
自己数一遍再决定收编哪些——**别把这份清单当完整负债表**（验收审查 iteration 7 #7）。

### 11.8 逐模型配置的作用域（A12 收尾，iteration 8）

验收审查发现上一轮修复里最严重的一条：**执行环境级"模型映射带前缀"信号盖过了逐模型端点**。
真机 `~/.workbuddy/models.json` 同时有 `deepseek/deepseek-v4-flash`（前缀）与裸 `MiniMax-M3`，
前者让 `gateway_named_models` 非空，于是**同一个文件里那些自己配了官方端点的模型
（MiniMax → api.minimaxi.com）也被判成"经中转"**，行面还会写"经中转（api.minimaxi.com）"。

根因与修法：前缀信号的作用域必须**跟着配置的形状走**。

| 配置形状 | 前缀信号的作用域 |
|---|---|
| 执行环境级（claude `env`、codex `config.toml`、dsh）——一套映射管全部请求 | 对全执行环境成立 |
| **逐模型**（workbuddy/pi）——每个模型一条 | **只对那条模型成立**（`per_model_config` 标记，判定器改为查该模型自己的条目） |

同时修掉两处随之而来的问题：逐模型端点按"最后一段"匹配（配置常带前缀、事实常是上游裸名），
展示用的 `config_endpoint` 改为**判定实际使用的那个端点**（不再是列表里的第一个）。

**教训（值得单独记一笔）**：这一轮的缺陷之所以能溜过上一轮的测试，是因为**测试夹具用了真实文件
产生不出的形状**（`gateway_named_models` 为空 + 只有两个条目）——正是本仓库「形状来源纪律」
点名的假绿模式，而我在同一次提交里刚刚批评过它。夹具现在按真机形状写：混合前缀与裸 id、
前缀列表非空。凡"逐模型"这类断言，夹具必须复刻真机文件的**混杂性**，而不只是它支持的那个分支。

### 11.9 逐模型配置的**端点列表**也要按模型收口（iteration 9）

§11.8 只把"前缀信号"按模型收口了，**端点列表**仍是执行环境级的——同一类别错误的下半截。
验收审查用一个真机会出现的输入点破：`hy3`（真机 291 条事实）、`glm-5.2`、`deepseek-v4-flash-0731`
这些**没进配置表**的模型，会拿到 `relay_config` + `config_endpoint = api.minimaxi.com`
（文件里第一个端点，恰好是 MiniMax 的**官方**端点），行面写成"经中转（…→ api.minimaxi.com）"。
今天只在 UI 上不可见（workbuddy 行被 `credits_only` 摘掉），但任何未来非积分的逐模型执行环境都会中招。

三条收口（同一原则：**配置是对谁说的，证据就只能用在那个人身上**）：

| 情形 | 处理 |
|---|---|
| 逐模型配置 + 该模型**没有**条目 | 这条模型**没有任何端点证据**（不退回执行环境级列表，也不显示别人的端点） |
| 前缀键指向的端点**是该厂商的官方端点** | 前缀不再算中转证据（`minimax/MiniMax-M3 → api.minimaxi.com` 不该判经中转） |
| 展示用的 `config_endpoint` | 逐模型执行环境只用**该模型自己的**端点；没有条目则留空——"第一个配置的端点"永远不冒充 |

**夹具保真度**（这一轮同时修）：原来的逐模型夹具挂在 `claude-code` 上，而**没有任何读取器
会产出这种组合**（claude/codex/dsh 恒 `per_model_config=false` 且无 `model_endpoints`；
pi/workbuddy 恒为 true）。夹具现在挂在 `pi`（真实可达的配对，且 pi 无注册人格 → 走通用路径），
补齐第三个端点（真机 workbuddy 文件就是三个）、并加了一条**配置表里没有的模型**
（`deepseek-v4-flash-0731`）断言"没有证据就没有断言、也不显示别人的端点"。

### 11.10 簇级展示字段：成员不一致时不许替它们说话（iteration 10）

§11.9 把**组**级的端点证据收口了，但列表渲染的是**簇**——而 `clusters_of` 把第一个成员组的
`auto_verdict` 整份复制给簇。于是同一个簇里两条模型各配了不同中转时，行面只显示第一条的端点
（验收审查 iteration 10 #1：`deepseek-v4-flash → beta-router.shengsuanyun.com` 与
`deepseek/deepseek-v4-pro-0813 → router.shengsuanyun.com` 同簇，行面替后者声称了前者）。
组级判定全对，聚合把差异抹平了。

修法：簇级 `config_endpoint` 只在**成员一致**时沿用第一个的；不一致则留空，并把
`config.endpoint*` 依据换成 `config.endpoint.mixed`（行面："这行里的模型各自配了不同端点"）。
"没有条目"（`null`）与具体端点算**不同的成员值**——这正是"簇里混着一个有端点、一个没有"的情形。

**这一轮同时补上的测试洞**：§11.9 的 (b)（带前缀的键指向官方端点不算中转）**当时没有测试**——
把 `&& !official_for_vendor(harness)` 删掉，292 个测试全绿。夹具现在把 MiniMax 的键换成带前缀的
`minimax/MiniMax-M3 → api.minimaxi.com`（真机 workbuddy 里带前缀的键都指向中转，所以这个输入
只能构造），删掉该子句即变红。夹具的 `provider_name` 也改成 `read_pi` 真正会填的值
（`Some(first provider key)`）——之前写 `None`，是读取器产不出的形状。

三个断言都验证过**会红**：去掉 (a) 的收口 → 孤儿模型变 `relay_config`；去掉 (c) → 显示
`api.minimaxi.com`；去掉簇级 mixed 规则 → 簇沿用第一个成员的端点。夹具会红才算夹具。

