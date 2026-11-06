# AGENT_VITALS_EXTENSION_ARCHITECTURE_SPEC — 动态扩展架构：统一扩展注册面 + 官方目录

> 术语调整（2026-10-03）：本文 Agent 执行环境称 `harness`，与应用插件架构中的 Agent Vitals `host` 区分。内部开发阶段直接更新 schema、来源 ID 和文件名，不保留旧名兼容，见 [HOST_HARNESS_TERMINOLOGY.md](HOST_HARNESS_TERMINOLOGY.md)。

- 版本：v1.1（2026-10-01）
- 状态：设计定稿候选。本文整合 2026-10-01 架构评审的全部结论，是「目录时代」
  的总纲；harness 插槽的实现细节以
  [HARNESS_MANIFEST_DSL_SPEC.md](HARNESS_MANIFEST_DSL_SPEC.md) 为准；跨插槽的分发、
  来源持久化、激活事务和目录索引以本文为准。两份规格互相引用同一生命周期，
  不另造 harness 专属安装协议。本文为目标契约，实现状态单列于 §9。
- 关联：`HARNESS_MANIFEST_DSL_SPEC.md`（harness 插槽主规格）、
  `PROVIDER_ROUTE_ATTRIBUTION_SPEC.md`（归因规则）、
  `AGENT_EXECUTION_PROBLEM_TAXONOMY.md`（taxonomy 注册纪律）、
  AGENTS.md「Data Retention & Serving-Face Policy（2026-09-19）」、
  [PRICING_CURRENCY_AND_FX_V2_SPEC.md](PRICING_CURRENCY_AND_FX_V2_SPEC.md)、
  [US_LAUNCH_I18N_AND_BILLING_SPEC.md](US_LAUNCH_I18N_AND_BILLING_SPEC.md)。

**变更记录**

- v1.1（2026-10-01）：明确逐插槽信任矩阵；激活台账与历史 provenance 进入
  状态区；增加内容校验、统一生命周期、激活事务、崩溃恢复及验收门。
  CAP-1 与最小 revision 关联提前至 P0.5；修正旧 URL 兼容策略和实施状态。
- v1.0（2026-10-01）：初稿。整合执行环境热插拔三档分层、官方目录拉取（P0.5）、
  provider 动态接入、插槽清单三档、统一扩展注册面（ExtensionRegistry）、
  磁盘契约（仓库 `catalog/` + 本机 `.d` 三区）、`plugin:` → `harness:` 改名、
  先例对照与分期路线。

---

## §0 背景与问题

三条「维护跑步机」在编译期接入模式下成本最高（执行环境适配、模型适配、价卡
计算）——一个新执行环境 = harnesses crate 解析器 + 四处运行时词表 + CLI 子命令 +
Python 对等实现 + golden 案例 + UI 注册。上游格式漂移不提前通知，修复要等
app 发版。

本架构的目标：**新出的执行环境、provider、价卡默认以数据形态经官方目录下发接入，
格式漂移的修复从「等 app 发版」变为「发一个 revision」**；同时不拆掉产品的
承重墙——计费诚实、行为面审计信任、Python/Rust 字节 parity、离线隐私承诺。

## §1 总原则（一页定调）

1. **数据可下发，执行权不可让渡。** manifest / 价卡 / 映射表 / pattern 清单
   是数据；recipe 引擎、归因规则、redaction、规范化喉咙是本体代码，版本化
   随 app 走。manifest 永远只能填参数，不能越过接口边界。
2. **三轴解耦。** harness 字符串只表机制（官方裸名 vs `harness:<slug>`）；评审档
   归 `origin`（`vendor-catalog` / `local`）；计价档归 billing 锁
   （`metered_estimate` + `has_unresolved`）。任何前缀/徽标不得混装三义。
3. **账面可自助，行为须官方。** 数据面行可来自任何校验通过的插槽；SV6xx
   行为规则、CanonicalSession 投影、TraceGraph、会话叙事只消费官方编译
   适配器（谓词 `harness NOT LIKE 'harness:%'` 在各模块内声明）。
4. **校验后切换。** schema、能力协商及插槽专属影响预览通过后，持久化
   不可变内容，再事务性切换 active generation（§8.3）。单文件 rename
   不是多插槽原子性的替代品；提交前失败保留旧版本。
5. **能力协商（LSP / Terraform 先例）。** 每份数据携带 `requires`（recipe 族
   与 feature）+ `min_app_version`；未知 capability → 拒绝激活并报
   缺失能力及已知最低版本；无法确定支持版本时明确说“不支持该能力”，
   不编造版本号，绝不「结构校验通过、运行时静默跑错」。
6. **无静默热注入。** 网络默认关、显式 opt-in；请求只携带 slug/版本/哈希，
   不携带用户数据；payload 按完整 commit SHA 与内容哈希取，index
   才可浮动跟 `main`；安装与更新都是显式动作。
7. **「错了会怎样」准入门槛。** 每个新插槽先做失效分析：错数据只影响该用户
   估算（可开本地 drop-in）还是冒充官方口径（仅 vendor 目录，无本地写入
   路径）。

## §2 参照先例（这不是发明轮子）

| 先例 | 模式 | 本架构的对应 |
|---|---|---|
| Chrome 扩展 `manifest.json` | 声明能力，引擎执法 | `harnesses.d/<slug>/manifest.json`（纯配置、零执行权） |
| LSP `initialize` 握手 | 能力协商 | CAP-1 `CapabilitySet` / `negotiate` |
| Terraform Registry | 协议版本与版本化分发的参照 | 本方案采用 index + SHA-256 + 固定 commit；当前不提供独立发布签名 |
| VS Code contributions | 声明式登记优先，代码进程隔离 + Marketplace 评审 | origin 双轨徽标 + 首装 dry-run 门槛 |
| nginx `conf.d` + SIGHUP | drop-in 目录 + 校验后切换；dynamic module ABI 锁死仅启动加载 | `.d` 目录布局 + §1.4；「配置热、代码冷」同款切分 |
| Vite / Rollup | 进程内全信任代码插件，用户自装、重启生效 | **刻意不抄**：Vite 用户本就在跑任意构建代码，本产品是审计工具，被审对象不能由被审方提供逻辑 |
| Obsidian | 进程内全信任 + 人工审核 | 反面教材：灵活性最大，靠人治补技术缺口 |

以上是设计参照，不表示本方案继承了这些产品的全部安全保证。本方案采用
声明式数据与版本化分发；签名及信任链不在 P0.5 的保证范围内（§6）。

## §3 架构总览

### 应用层边界（2026-10-03）

本规格管理声明式数据扩展；前端插件由
[应用层规格](AGENT_VITALS_APP_LAYER_ARCHITECTURE_SPEC.md) 管理。
City 是随 Agent Vitals 发布的官方内置前端插件，与 Overview 平级；桌面使用
独立 WebView，浏览器预览使用 iframe。Rust 本体提供注册、版本化的数据 projection。
City 不作为 harness_manifest/content_pack 安装，不把执行包写入数据对象库。
独立应用发布、插件市场及外部安装规范为后续路线，不属于当前插件 MVP。
数据目录来源不授予应用执行信任；插件身份、活动实例和方法/字段范围按应用层
规格与 AGENTS.md 检查。该本地插件面不扩大 MCP/export 权限。content_pack
多文件契约和新索引版本后置；catalog-index-v1 保持原契约，余项保留台账。

```
┌─ 统一扩展注册面（ExtensionRegistry：统一生命周期，按类型执法）─────┐
│  slot 类型：harness_manifest · endpoint_pattern · price_card ·        │
│   model_alias · error_taxonomy · behavior_patterns ·              │
│   trust_profile · subscription_scope · fx_reference · …           │
│  每个 slot 统一携带：capability id · schema 版本 · origin ·        │
│   revision/sha256 · 校验门 · 类型专属影响预览 · fixture 要求       │
└────────────────────────────────────────────────────────────────────┘
              ↓ 只喂参数，不让渡执行权
┌─ 封闭执行面（编译期本体，版本化随 app 走）──────────────────────────┐
│  recipe 族引擎（含 tree / snapshot-delta，v2）· 归因与计费诚实规则   │
│  （provider crate）· normalize_host 边界感知算法 · 规范化喉咙        │
│  （fact_id / billing 锁 / has_unresolved / 行数上限 / format guard）│
│  · redaction · 行为规则引擎（判定语义）                              │
└────────────────────────────────────────────────────────────────────┘
```

落位（接口签名草案见 HARNESS_MANIFEST_DSL_SPEC 附录 D）：

| 层 | 职责 |
|---|---|
| `agent-vitals-harnesses/generic/` | 能力协商、发现、解码（RecordSource 统一记录流）、recipe 注册表 |
| `agent-vitals-runtime` + `agent-vitals-ingest` | 规范化喉咙、catalog 客户端、激活 / revision 管理、双写编排 |
| `agent-vitals-provider` | 归因与计费诚实规则（封闭）；endpoint pattern 的**数据**经插槽喂入 |
| `agent-vitals-query/sources` | HarnessRegistry、合并语义、锁与源控制 |
| `agent-vitals-domain` | 计价锁枚举、origin 感知原因码等确定性策略常量 |
| `agent-vitals-data` | 激活 generation、revision 台账与历史 provenance 关联；事务与迁移 |
| `agent-vitals-mcp` | control_plane 镜像 `pricing_catalog_*` 形态的目录状态 / 策略面 |
| Python twin | 同组签名，共用 fixtures，golden 字节对拍 |

## §4 插槽类型清单（三档）

### 第一档：优先数据化候选（不等于全部进入 P0.5）

| slot | 内容 | 备注 |
|---|---|---|
| `harness_manifest` | 发现 / 会话 / recipe 引用 / 证据槽 / billing 锁 | 主规格全篇；v1 覆盖「JSONL + 文件名会话 + 三 recipe 族」的规整新 CLI |
| `model_alias` | `model_raw` → 价卡键归一表 | 高频低险；错→估算偏差（有 basis 标注兜底） |
| `endpoint_pattern` | 域名 → provider_id 映射（数据） | `normalize_host` 算法留本体；替代 `is_cogfoundry_host` 式硬编码 |
| `error_taxonomy` | HTTP / JSON-RPC −32xxx / 工具错误分类表 | 分类规则（截断、脱敏）留本体；先注册后写 emitter 的纪律不变 |
| `behavior_patterns` | 敏感路径表、破坏性命令清单等 pattern 数据 | ⚠️ 规则引擎语义封闭；**仅 vendor-catalog，永不开放第三方**——踩在「行为须官方」边上，靠 origin 单源保住审计信任 |

### 第二档：可做，门槛更高

| slot | 为什么门槛高 |
|---|---|
| `subscription_scope` | 直接喂「什么算 subscription」的判定，错 = 错账。仅 vendor + 版本化 + 影响预览（哪些历史行变 basis） |
| `fx_reference` | 参考汇率快照；按 FX V2 的快照绑定与封账规则，绝不把估算换汇变成可计价 |
| `quota_window` / 峰谷窗口表 | 时间语义（IANA、DST）留本体，窗口数据随目录 |
| `trust_profile` | manifest `trust` 字段已是插槽化形态；扩展覆盖面即可 |
| duration / slow-call 阈值默认值 | 低价值低风险，顺手 |

### 第三档：明确不做

- **redaction 规则**——serving-face 安全边界，不可数据化下发；
- **L1 canary / probe 套件**——政策保密，永不进任何 agent 可读面；远程更新
  只能走签名内部通道，不进公共 catalog；
- **归因 / 计费诚实规则**（provider crate）——`attribution_version` + Python
  parity + 已入库事实锁死，动它是升版评审不是配置项；
- **行为规则引擎语义**——只开 pattern 数据（见第一档），判定逻辑封闭；
- **i18n 资源**——随 app 走（发布说明双语是发布纪律）。

准入判据统一为一句话：**`.d` / 本地 drop-in 只开给「错了也只影响该用户自己
估算或只限定本地证据发现范围」的插槽；会冒充官方口径的插槽只允许 vendor
安装通道，无受支持的本地导入路径。**具体权限以下表为准，不能从优先级推导。

### 4.1 信任与影响矩阵（由本体定义，payload 不得扩大权限）

| slot | 安装来源 | 影响预览 / 强制限制 |
|---|---|---|
| `harness_manifest` | local、vendor | 命中率、invalid、token 差异、身份集合；始终锁估算，不授予行为能力 |
| `price_card` / `model_alias` | local、vendor | 受影响模型、估算差额与缺价；local 不可改变官方账单、订阅资格或封账快照 |
| `endpoint_pattern` | local、vendor | 受影响 provider 映射及冲突；local 映射只作估算提示，不能证明官方路由或覆盖源日志显式证据 |
| `error_taxonomy` | vendor-only | 分类变化计数；新问题类仍须先登记 taxonomy 文档 |
| `behavior_patterns` | vendor-only | 固定回放集的 finding 增减；只改变 pattern，不改变判定引擎或数据源资格 |
| `subscription_scope` | vendor-only | billing basis 变化预览；scope 不替代路由及订阅证据，不能解除 `harness:` 估算锁 |
| `fx_reference` | vendor-only | 币种、有效期、受影响快照；按 FX V2 保持封账绑定 |
| `quota_window` | vendor-only | 时区、边界、DST 变化；不创造官方配额证据 |
| `trust_profile` | local、vendor | 仅证据发现范围及本体内置适配器选择；不得设置严重性、置信度、行为资格或通知判定 |
| duration / slow-call 默认阈值 | vendor-only | 分类变化预览；用户偏好如另行提供，必须与官方默认值区分 |
| attribution signatures（归因匹配表） | vendor-only | 归因变化预览；不替代 `attribution_version`，不重写已有归因事实 |

`price_card` 纳入首批价卡兼容工作；其余插槽按 §10 逐项启用。未实现的 slot
或 impact preview 必须拒绝激活。vendor-only 表示应用通道限制，不能阻止
拥有本机写权限的人篡改整个程序和数据库；该威胁不在本离线应用的承诺内。

## §5 磁盘契约

### 5.1 仓库侧：`catalog/`（`assets/` 只留真静态资源）

```
catalog/                            # 官方目录：下发契约数据（index 驱动）
  index.json                        # 统一 typed entries，契约见 §5.4
  harnesses/<slug>.json                 # 执行环境 manifest（原 P0.5 的 assets/harnesses.d/，
                                    #   未实现即改名，零迁移成本）
  providers/<id>.json               # provider 身份 + endpoint_patterns
  pricing/<provider>.json           # 价卡（渐进按 provider 拆分）
  fx/reference-rates.json
  attribution/signatures.json       # 信任承载：仅 vendor 下发，永无本地 .d
assets/                             # 真·静态资源（templates/ 等）
```

词汇表（三个易混词钉死）：

| 词 | 归属 | 语义 |
|---|---|---|
| `catalog/` | 仓库侧 | vendor 分发源，版本化契约数据 |
| `config`（本机 `config.toml`） | 本机侧 | 应用行为设置 |
| authority 中的扩展台账 | 本机侧 | 激活状态与 origin 的持久化权威；registry.json 仅为派生快照 |

**`pricing.json` URL 迁移**：`PUBLIC_PRICING_CATALOG_URL` 已随版本发出（指向
`assets/pricing.json`），直接搬走会让老安装从此 404。过渡方案：
`catalog/pricing/` 为权威，`assets/pricing.json` 保留为 CI 同步镜像
（sync 脚本 + 漂移测试，不一致即红）；旧路径保持兼容，不以“新版本已发布”
推断旧客户端已消失。确需退役时另行公布最低支持版本、支持截止日期及降级
行为；在此之前保留旧 schema 兼容镜像。更新失败继续使用最后有效价卡，
无有效价卡则金额为未知并提示缺价，不清零。

### 5.2 本机侧：`~/.agent-vitals/` 三区

```
~/.agent-vitals/
├─【配置区：用户声明，须保留与迁移，不能假定可重拉】
│  ├─ config.toml                    # 主配置（现有）
│  ├─ harnesses.d/<slug>/manifest.json   # 本地 manifest 输入；安装时复制为不可变内容
│  ├─ providers.d/<id>.json          # provider 身份 / 端点映射 drop-in
│  ├─ pricing.d/<id>.json            # 价卡 + 模型别名 drop-in（manual-rate 统一到此）
│  └─ catalog/
│     ├─ policy.toml                 # 网络开关（收编 pricing-catalog-policy.json）
│     └─ registry.json               # authority 派生状态快照，丢失可重建，不参与授权
│
├─【缓存区：可随时丢弃重建】
│  └─ cache/catalog/                 # index、下载 staging、未安装件；不含唯一有效版本
│
└─【状态区：不可丢。与 harness 主规格 §13.3 一起迁移】
   ├─ authority.db / agent-vitals.sqlite3（沿用实际数据库路径，不另建第二 authority）
   │                                # 含 revision、activation、provenance 关联
   ├─ state/extensions/objects/<sha256>/payload.json
   │                                # 已安装不可变内容，离线恢复与回放所需
   ├─ facts/harness-<slug>.jsonl
   ├─ state/（锁路径、源控制开关）、machine.json、snapshots/、logs/
```

vendor 下载与 local `.d` 导入均经过校验后进入 objects；authority 的 active
generation 指向具体 revision。扫描 `.d` 只能产生候选更新，不能静默热激活。
vendor 不写入 local 输入目录，用户修改 vendor 内容须显式“复制为本地覆盖”。

### 5.3 合并规则（`.d` 约定的精髓在语义不在目录）

1. 合并键为 `(slot_type, slot_id)`。仅 §4.1 允许 local 的类型可显式覆盖
   vendor；两份内容均保留，台账记录选择和 pin。同来源同键多份拒绝选择，
   不按扫描顺序 last-wins。首次冲突需预览后确认，不能因出现文件自动覆盖。
2. harness 的目录名等于 slug；provider/price 文件 stem 等于内容 id。坏候选
   逐件隔离，已有 active 内容保持；同一依赖组任一校验失败则整组不激活。
3. local pin 不被目录更新写穿；解钉为显式激活动作，重新预览 vendor 版本。
4. origin 由获取通道与内容校验结果写入 authority；payload 不得自报 origin。
   加载时校验完整 SHA-256，并对同一份已校验 bytes 解析，避免校验后重新
   打开文件造成竞态。对象损坏拒绝加载并报告，不静默降级或保留官方徽标。
5. 配置与状态迁移均保留用户内容并做可恢复备份；仅缓存和派生快照可丢弃。
   活跃、回滚保留以及历史 provenance 引用的对象不得当缓存回收。

### 5.4 目录索引契约（P0.5 必须有 schema 与双语言 fixtures）

顶层含 `index_schema_version`、单调递增 `catalog_sequence`、`published_at`
和 `entries`。每项身份为 `(slot_type, slot_id, revision)`；revision 是完整
commit SHA，`sha256` 是原始 payload bytes 的完整 SHA-256，两者不能混用。

必填字段：`slot_type`、`slot_id`、`revision`、`payload_path`、`sha256`、
`schema_version`、`requires`、`min_app_version`、`display`、`dependencies`。
harness payload 的 `manifest_version` 必须与 entry 的 schema_version 对应。
entry 的 `display` 是 1..=256 字符的目录展示字符串；harness payload 的
`display.name` 保持自身 schema。`published_at` 使用有效 UTC 日历时间
`YYYY-MM-DDTHH:MM:SSZ`，catalog_sequence 为 u64；schema_version 为正 u32。
`requires` 按插槽声明 recipes/features；依赖固定到具体类型、id、revision
及哈希。P0.5 无依赖时显式空数组；非空依赖必须闭包校验后整组激活。

索引同身份重复、循环依赖、冲突的同键版本、未知 schema 或能力均拒绝该
激活组。payload_path 只允许本仓库相对路径，拒绝绝对路径、`..`、外部 URL；
下载限制 HTTPS 同源、大小、超时与重定向目标。slot id 不直接成为未验证路径。
tag 可作展示标签，不能作为下载定位依据。

应用记录已接受最高 catalog_sequence；更旧索引拒绝作为更新。相同 sequence
却不同 index 哈希视为冲突。显式回滚只选择已验证的历史内容，不降低最高序号。
该机制不能识别首次安装时的陈旧索引，也不能证明离线缓存仍是最新版；状态面
展示最后成功检查时间，不把“网络关闭”解释为“已是最新”。

### 5.5 来源与历史 provenance（P0.5 地基）

authority 增加逻辑记录（具体 SQL migration 随实现评审）：

- revision：类型、id、完整内容哈希、origin、vendor commit/来源标识、schema、
  capabilities、安装时间；同内容 local/vendor 记录可区分，不由哈希猜来源。
- activation：generation、上一 generation、完整有效 slot→revision 映射、
  预览摘要/哈希、动作与提交时间；当前指针是唯一激活权威。
- provenance 关联：摄入批次或产物关联所用 generation、revision 与引擎版本；
  可从每条 fact/分类结果追到来源，不仅关联到“当前安装的 harness”。

不向 billing/behavior fact 契约硬塞配置字段；优先新增关联表，保证关联与
对应 authority 写入同事务。facts JSONL 的 revision 表达及导出/重建的关联
保留方式须在 P0.5 schema 评审中钉死并做 parity；禁止未经 golden 评审改字节。
导出仅携带已脱敏的来源标识、revision、origin 等必要元数据，不包含发现根、
原始错误、调用参数、payload 或 canary；private/redacted 面仍各自执法。

卸载只移除 active 选择，保留历史关联和必要对象；更新及回滚只影响随后运行。
历史重算是独立的预览/确认操作，产生可追溯新结果，不覆写封账快照。旧数据
无法证明 vendor 来源时标为来源未知并保持 unresolved，不追认官方身份。

## §6 安全与信任模型

- 分发完整性：GitHub TLS + 仓库写权限控制 + index 内 sha256；manifest 按
  固定完整 commit 取。这是来源通道与完整性校验，不是独立发布签名；仓库
  发布权限被攻破时，攻击者可同时替换 index 与 payload。签名体系后置到
  P3 再议；vendor-only 不等于具有密码学发布者证明。
- 网络边界：本数据扩展规格新增出站 = 官方目录拉取（pricing catalog 同类，opt-in、
  不带用户数据）；实施合入时同步更新 AGENTS.md 网络边界一句；
- 执行边界：永不执行数据扩展 manifest 携带的代码；脚本 adapter（P1.5）仅默认关闭的
  开发者模式，须先过能力沙箱评审，且不可经任何目录分发；
- 信任插槽逐项按 §4.1 执法，不按分档推断权限。声明式输入仍须有 payload
  字节、条目数、路径/正则长度和运行资源上限；不能因“无代码”而取消限额。

## §7 诚实与计费边界（不变量）

- 数据面行（`harness:<slug>`）一律 `metered_estimate` + `has_unresolved`，
  原因码按 origin：`data-plane-recipe-no-billing-evidence`（vendor）/
  `unreviewed-manifest-route`（local）；
- manifest 无权声明订阅档；active billing declarations 不得把 `harness:%` 改成
  subscription（SQL/MCP 回归测试钉死）；
- 估算 ≠ 账单、unknown ≠ zero；缺字段报 null 不编造；
- 行为面 / trace / narrative 谓词 `harness NOT LIKE 'harness:%'` 在各模块内声明，
  同时由共享查询入口限制为本体注册的编译适配器白名单。前缀排除只作额外
  防线，未知裸 harness 也不能进入；迁移期间同时排除 `plugin:%`。`trust_profile`
  的本地 artifact 发现不授予 SV6xx/TraceGraph/CanonicalSession 消费资格；
- golden / Python-Rust 字节 parity 对所有插槽数据同样成立：数据驱动不豁免
  契约测试。

## §8 分发与生命周期

### 8.1 统一协议与类型专属预览

所有 slot 走 `fetch/stage → verify → validate → negotiate → preview →
confirm → commit`。ExtensionRegistry 统一编排；schema、来源权限和
`preview_impact` 由本体内置的 slot handler 按 §4.1 执行。没有 handler
不能靠通用 JSON 校验激活；golden 验证在发布 CI 执行，不要求客户端执行下载的测试代码。

harness 预览比较同一冻结输入范围的 `(session, source_event_id, fact_id)`、
token 值及 emit/skip/invalid；同源行换 id 默认拒绝，需要独立迁移流程。
预览须注明采样范围、截断和未覆盖部分；没有日志时可暂存，不能绕过首装
format guard 宣称已验证。其他 slot 使用 §4.1 的影响维度，不套用 fact_id。

预览绑定当前 generation、候选哈希、引擎版本及输入范围指纹；任一变化使
确认失效，重新预览。预览和检查不写入正式事实，也不向网络发送本地样本。

### 8.2 操作与网络策略

CLI 保留 `manifest-catalog-status` / `manifest-catalog-update`，作为统一
catalog 服务的 harness 视图；其他 slot 随实现增加类型化入口，不复制下载逻辑。
MCP control_plane 镜像既有 pricing_catalog 策略，但只展示脱敏状态/影响。
update 只检查、下载与预览；激活必须有针对预览的显式确认，不因网络 opt-in
而自动安装。网络关闭时使用既有有效内容，显示无法检查更新，不报摄入错误。
网络关闭下所有安装件仍须可加载、校验与回滚，不触发隐式联网。

### 8.3 原子激活与恢复

1. 在同一文件系统 staging 中下载/复制，校验哈希、schema、能力、依赖闭包
   和影响；来源由调用通道注入，公共导入接口不接受任意 origin 参数。
2. 将校验后的 bytes 写入 `state/extensions/objects/<sha256>/payload.json`，
   刷新文件后原子移入并刷新父目录。已有同哈希对象须校验，不静默覆盖坏对象。
3. 获取 activation 写锁，以预览的旧 generation 作比较并交换条件。在单个
   authority 事务中写入 revision/activation 记录并切换完整映射；提交前再次
   确认依赖对象存在且校验通过。并发修改使预览失效，整组不部分提交。
4. 提交成功即为激活线性化点。每轮摄入/查询固定一个 generation，运行中
   不混用新旧依赖；下一轮读取新 generation。旧运行结果携带旧 provenance。
5. 提交后重建 registry.json 派生快照。该写入失败只告警，不撤销已提交激活；
   重启时以 authority 重建，绝不以旧快照覆盖数据库。

提交前崩溃：旧指针有效，新对象是未引用对象，可稍后清理。提交后崩溃：
新指针及对象完整，从数据库恢复。已提交对象缺失/哈希不符：隔离受影响组，
保留历史数据并报告需恢复；不空跑成零用量，不偷偷使用另一 revision。
回滚经过同样校验和事务，生成新的 activation，指向历史版本；不能抹除
已产生事实或绕过当前版本的能力限制。数据库迁移失败则不启用新 catalog。

### 8.4 应急旁名与退出

官方目录可下发 `<harness>-drift` recipe，落库 `harness:<harness>-drift`，只保用量
估算。启用预览必须检测与编译适配器的源文件/事件时间范围重叠；无法证明
互斥就阻止同范围同时摄入。正式修复后先预览切回的范围与去重结果，再解除
应急摄入；不得简单同时启用两个不同 harness 身份。历史旁名事实保留其 provenance，
合并/重算须走显式迁移，不能凭正式版上线自动再算一遍。

## §9 与既有实现 / 规格的关系

- **HARNESS_MANIFEST_DSL_SPEC v0.4.2**：harness 插槽与 `plugin:` → `harness:` 迁移的
  主规格（含 §13 命名映射与数据迁移、附录 D 接口契约、附录 E 分层影响）；
- **已有基础实现**（2026-10-01 仓库检查）：
  `crates/agent-vitals-query/src/sources/harness_registry.rs`、
  `crates/agent-vitals-harnesses/src/harnesses/generic/manifest.rs`、
  `crates/agent-vitals-ingest/src/ingest/plugin_ingest.rs`；Python 已有
  `generic_plugin.py`、`generic_manifest.py`、`generic_recipe.py`，以及
  `harness-generic-zcode.json` golden 和 harnesses.d 发现机制。已有 pricing catalog 通道。
- **本轮检查仍未完成的目标**：Rust facts_harness 仍生成 `plugin:<slug>`；
  `harness:` 迁移、统一 catalog/ExtensionRegistry、本文的 origin/revision
  台账、CAP-1 及激活事务不能标记为已实现。已有模块不代表通过本规格验收。
- **claude-code / codex 不退出编译适配器**：manifest 能迁移的只有用量数据面
  且是「搬家不是消失」（recipe 也是本体代码）；装机层 skill 体检、订阅计费
  链、配额快照、Codex app-server 活查询四件在机制上无位置。v2 recipe 族
  落地后可渐进把它们的用量提取并入共享 recipe，专用代码缩到四件不可替代件。

## §10 分期路线

| 阶段 | 内容 |
|---|---|
| P-1 | recipe feasibility spike（≥10 执行环境脱敏 fixture、覆盖率 ≥80% 目标、双语言 golden） |
| P0 | 安全声明式导入（manifest v1 + zcode 试点；CLI 三命令；`harness:` 前缀落地） |
| P0.5 | CAP-1 + typed index → revision/provenance 关联与激活事务 → harness 官方目录拉取；catalog 仓库布局、pricing 兼容镜像、应急旁名互斥门；完整通过 §12 |
| P1 | 桌面导入向导、执行环境徽标、KPI/矩阵呈现口径；复用 P0.5 台账，不推迟来源持久化 |
| P1.5 | Adapter 开发者模式（未承诺，沙箱评审前置，不可目录分发） |
| v2（MAN） | 复用 P0.5 CAP-1 → MAN-3/4（会话身份、provider 证据槽）→ MAN-1 多源 join → MAN-2 json/rotated → sqlite 单独立项；recipe 族随版本生长 |
| 目录时代增量 | `providers.d` / `pricing.d` 插槽、endpoint_pattern 数据化、taxonomy / behavior_patterns（vendor-only）、subscription_scope（vendor + 影响预览） |
| P3（政策门槛，未承诺） | 社区 / 第三方目录：多来源注册、签名与信任链、分发治理 |

DSL 政策：P2 触发条件驱动（「≥3 个 recipe 覆盖不了的执行环境」或「分发需求
出现」），从证据里长语言；`RuleTable`（多行型分流）设计为 DSL 的有界退化
形，将来激活即增量松绑。永不入门：跨行状态、浮点、时间函数、env / 文件 /
网络、控制流扩展。

## §11 明确不做清单

完全代码热插拔 / WASM 运行时；行为面开放给非官方数据源；第三方 / 社区目录
（P3 前）；订阅 scope、taxonomy、行为 pattern、归因签名的本地 drop-in；
redaction 数据化；遥测与用户数据上传；云 SaaS 化；i18n 目录化。

## §12 验收与故障注入门

以下是 P0.5 发布门，新增 slot 须补充自己的影响预览 fixture。仅编辑本文
不表示这些测试已实现或通过。

| 场景 | 必须观察到的结果 |
|---|---|
| vendor 文件被改、对象哈希不符、payload 自报 origin | 拒绝受影响激活/加载；不能继承官方徽标；其他组继续运行 |
| local 覆盖及 vendor 更新 | 覆盖须确认，pin 不写穿；解除 pin 重新预览；vendor-only 拒绝 local |
| 未知能力、schema、依赖缺失/环、路径穿越、超限 | 明确拒绝；旧版本保持；不执行下载内容、不越界访问 |
| 对象写入、DB 提交、快照输出各边界中断 | 重启只见完整旧/新 generation，无半激活；快照可重建 |
| 两进程激活、预览后输入或 active 变化 | generation 校验阻止过期提交，要求重新预览 |
| 安装后禁网并清空 cache、卸载或回滚 | 有效对象仍可离线读取；历史来源及估算原因不丢失 |
| harness 自报订阅、local endpoint/alias 指向官方 provider | SQL、summary、MCP 均不能由此产生 subscription 或官方路由证据 |
| `harness:`、迁移期 `plugin:`、未知裸 harness 进入行为查询 | 共享白名单及模块守卫拒绝，编译适配器原有结果不变 |
| 同源重放、升级 id 漂移、应急旁名与正式适配器重叠 | 重放不双计；漂移/重叠阻止激活或要求专门迁移 |
| 历史重算、封账、脱敏 export/rebuild | 不覆写封账；来源可追；无原始参数、错误、凭据或 canary 外泄 |
| 旧客户端价卡 URL 与双语言 fixtures | 镜像保持旧 schema；schema/归并/错误与事实输出满足 Python/Rust parity |

验证命令沿用仓库 Python unittest、golden `--diff`、Rust release tests 与
clippy 门；迁移、崩溃恢复及目录 fixtures 需有针对性测试。禁止用批量更新
golden 掩盖意外的 fact 契约或计费变化。

---

## 附录 A：关键决策记录（ADR 简表）

| # | 决策 | 一句话理由 |
|---|---|---|
| 1 | 统一数据扩展生命周期 + 封闭执行面 | 数据扩展不授予归因、计费或行为判定执行权 |
| 2 | harness 字符串 `plugin:` → `harness:`，CLI 用 `manifest-*` | 三轴解耦；`plugin` 让回给真正的插件系统（DSH plugin、Claude Code plugins）；`harness-*` 会撞 `--harness` 行为面枚举 |
| 3 | 仓库侧 `catalog/` 取代 `assets/` 放契约数据 | assets 语义是静态资源；pricing/providers/manifests 是版本化契约数据；pricing.json 旧 URL 走镜像过渡 |
| 4 | recipe-first，DSL 后置 P2 | v0.2 脚本优先的教训；受限解释器 + parity 可对拍；语言从证据里长 |
| 5 | origin 与完整哈希写入 authority，历史产物关联固定 revision | 可编辑快照不作授权依据，变更内容不能继承官方身份 |
| 6 | manifest 按不可变 revision 取，index 才浮动 main | manifest 驱动解析，错了是错账 |
| 7 | 信任承载插槽无 `.d` | 错数据冒充官方口径（订阅 scope / 行为 pattern / taxonomy / 签名）不可接受 |
| 8 | claude-code / codex 不退出编译适配器 | 四件机制外部件（装机层 / 订阅链 / 配额 / app-server）+ 用量面是搬家不是删除 |
| 9 | 应急旁名 `<harness>-drift` | 上游漂移时的韧性：救生筏保账面，正式修复随版走 |
| 10 | 旧价卡 URL 持续兼容，退役须另定支持期 | 无遥测不能推断旧安装消失，发新版本不等于可以删除旧入口 |
| 11 | 不可变对象先持久化，DB 事务切换 generation | 保证依赖组与 provenance 一致；单文件 rename 不足以保证跨文件事务 |
| 12 | CAP-1 与 provenance 提前到 P0.5 | 首次目录分发即需要能力门与历史来源，不能推迟到产品向导阶段 |
