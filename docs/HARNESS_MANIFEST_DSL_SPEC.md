# HARNESS_MANIFEST_DSL_SPEC — 自描述执行环境（Manifest + Recipe/DSL/Adapter）设计规格

- 版本：v0.4.2（2026-10-01）
- 状态：定稿候选。本文件是实施前的抢先设计稿；附录 C 的耦合点清单来自
  2026-09-19 对当前代码的实测勘察，行号以 `main` 为准。
- 关联：`AGENT_EXECUTION_PROBLEM_TAXONOMY.md`（行为面为什么不开放的依据）、
  `WORKBENCH_FINDINGS_TAB_SPEC.md`（插件行进入决策矩阵后的展示契约）、
  AGENTS.md「Data Retention & Serving-Face Policy（2026-09-19）」、
  [AGENT_VITALS_EXTENSION_ARCHITECTURE_SPEC.md](AGENT_VITALS_EXTENSION_ARCHITECTURE_SPEC.md)
  （目录时代总纲：插槽清单、磁盘契约 `catalog/` 与 `.d` 布局、分发生命周期）。

**变更记录**

- v0.4.2（2026-10-01）：同步扩展架构 v1.1。harness 提取与身份语义以本文为准；
  目录索引、安装存储、来源持久化和激活事务以扩展架构 §4–§8 为准。
  CAP-1 与最小 revision/provenance 关联在 P0.5 实现；vendor/local 分开保存，
  origin 写 authority，registry.json 仅派生。历史变更记录中的旧安排保留作背景。
- v0.4.1（2026-10-01）：**harness 字符串契约改名 `plugin:` → `harness:`**（机制
  已实施，趁美区首发前迁移，见 §13）。三轴解耦：harness 字符串只表机制（官方
  裸名 vs `harness:<slug>`），评审档归 `origin`，计价档归 billing 锁；`plugin`
  一词让回给真正的插件系统（DSH plugin、Claude Code plugins）。全文术语
  同步：CLI 改 `manifest-*`、原因码 `unreviewed-manifest-route`、徽标
  「本地导入·未审计」、P1 表名 `manifest_revisions`、IPC
  `manifest_preview` / `manifest_import`、应急旁名 `harness:claude-code-drift`。
  新增 §13：命名映射全表、数据迁移方案（重导入为主 + 原地兜底、前置条件与
  时机）、实施落点勘误。历史变更记录保持原文。
- v0.4.0（2026-10-01）：**manifest v2 路线 + v0.3.2 遗留一致性修复 + P0.5
  补强**，一次成稿。① 一致性：§0/§7.3 徽标改为按 `origin` 双轨（「官方
  recipe」/「插件·未审计」）；§6.1/§9.2 的 `has_unresolved` 原因码 origin
  感知；`origin` 写入权属钉死为获取通道安装时写入，manifest 本体不得声明
  （§3.1 与附录 A 注记，防徽标伪造）。② P0.5 补强：目录 `index.json` 最小
  schema、manifest 按不可变 revision 取、拉取面 CLI/MCP 命名、应急旁名
  规则（`<harness>-drift` 救生筏）。③ 新增 §12 manifest v2 路线：capabilities
  协商、多源 join、source.format 扩容、会话身份升级、provider 证据槽、
  recipe 族扩展与明确不升清单。④ 新增附录 D（本体接口契约，Rust 签名草案）
  与附录 E（分层影响清单：harnesses/domain/data/UI/MCP）。
- v0.3.2（2026-10-01）：**官方目录分发定案**（产品决策，关闭 §11.4 的评审
  时点问题）。新增 §10 P0.5「官方 recipe 目录拉取」：允许从本仓 GitHub 项目
  经 pricing catalog 同源通道（raw.githubusercontent.com，opt-in 网络策略、
  请求不含用户数据）拉取 vendor 官方 manifest/recipe 目录；只分发数据形态，
  脚本 adapter 任何情况下不可经目录下发。拉取件与本地导入同路径、同校验、
  同 dry-run 门槛；计价锁与 `has_unresolved` 不因来源放宽，但 provenance 记录
  `origin`（vendor-catalog / local），徽标区分「官方 recipe」与「插件·未审计」。
  §1 非目标、§2 设计要点、§3.1、§9.3 措辞同步；P3 收窄为社区/第三方目录
  （仍政策门槛、未承诺）。
- v0.3.1（2026-09-19）：复审补丁（实施前定稿）。① §4.3 format guard 补齐
  「新发现文件零 target」情形：已安装 revision 下新发现的文件若零
  target/emit → 计 skip 并在报告标黄，不整文件失败（只有存在历史基线的
  文件才做突降 drift 检查）；② §4.4 重复 event key 区分：候选行**字节级
  相同** → 折叠计 duplicate 如实报数，内容不同 → 整文件失败（不静默吞掉
  语义不变）；③ §6.3 补 `manifest_fact_revisions` 随 13 个月 retention 同步
  清理；④ §9.3 adapter 行消息 `fact` 更名 `candidate`，与 §9.1 DTO 对齐；
  ⑤ §10 P-1 加样本数放宽条款（执行环境数不足时按文件/行型多样性折算并如实
  报告）。
- v0.3（2026-09-19）：**recipe-first**。P0 默认路径改为内置、版本化的
  `recipe` + 纯点路径覆写，用户 manifest 不执行代码；脚本 adapter 降为
  P1.5 开发者模式，必须先解决能力沙箱与离线承诺。新增 `CandidateUsageV1 →
  UsageFact` 正式映射、`emit/skip/invalid` 三态、`event_key` 身份规则、语义型
  recipe 命名、P-1 覆盖率验证，以及 authority-first + JSONL 双写失败语义。
  “80%”改为待真实语料验证的目标，不再作为既成事实。
- v0.2（2026-09-19）：**分期反转**。脚本适配器（`adapter`）升为 P0 主路径；
  DSL（`records` 表达式）降为 P2 设计预留，触发条件见 §10。适配层对拍从
  「Rust/Python 双解释器字节一致」变为「同一脚本两侧同跑」（parity 免费）。
  新增 python3 依赖边界与 stdlib-only/3.9 纪律（§9.3）。zcode 试点附录改为
  Python 脚本版（附录 B）。
- v0.1（2026-09-19）：初稿（DSL 优先，脚本为 P2 逃生舱）。

---

## §0 背景与两条判据

执行环境接入今天是**编译期动作**：一个新执行环境 = harnesses crate 解析器 + 四处运行时词表 +
CLI 子命令 + Python 对等实现 + golden 案例 + UI 注册（全清单见附录 C）。用户无法
自助接入——例如重度使用的 ZCode，在官方发版之前进不了账本。

本规格定义**数据面热插拔**机制，判据沿用 findings tab 的两条：

1. **无脑解决**：导入一个常见执行环境 = 拿到 manifest，或把本地样本拖进导入
   向导生成 manifest 草案 → 看 dry-run 预览 → 确认。recipe 覆盖范围内全程
   不写代码、不执行第三方代码、不重启、不发版。
2. **数据是决策证据**：manifest 执行环境的行进入用量/成本/决策矩阵，徽标按 `origin`
   双轨——`vendor-catalog` 显示「官方 recipe」、`local` 显示「本地导入·未审计」
   （v0.4.0 起，与 §10 P0.5 一致）——计价档一律 `metered_estimate`，
   不得污染官方口径。

一句话边界：**账面可自助，行为须官方。**

## §1 非目标

- **行为面不开放**：SV6xx 行为规则、CanonicalSession 投影、TraceGraph、会话叙事
  不消费manifest 执行环境行。提取器再灵活，也产不出经过官方校验的行为投影。
- manifest 不获得任何凭据、不直接写库；P0 只运行本体内置 recipe，不执行
  manifest 携带的脚本或命令。
- **不随 app 捆绑 Python 运行时**（2026-09-19 决策）：P0 完全不依赖 Python；
  未来 P1.5 adapter 若选择 Python，缺运行时 → 诚实降级（§9.4）。
- 不做 WASM 沙箱运行时。脚本 adapter 只有在能力沙箱完成单独评审后才可能
  进入 P1.5 开发者模式，不得进入普通用户默认导入向导。
- 不改三份钱纪律：manifest 执行环境没有官方订阅证据，永远 `metered_estimate` +
  `has_unresolved`（AGENTS.md billing fallback 规则原文适用）。
- 不做**社区/第三方** manifest 云端目录（§10 P3，政策门槛、未承诺）。官方
  recipe/manifest 目录自 v0.3.2 起允许分发，且仅限一种形态：从本仓 GitHub
  项目经 pricing catalog 同源通道拉取（§10 P0.5）——opt-in 网络策略、请求
  不携带用户数据；脚本 adapter 任何情况下不可经目录下发（§9.3）。

## §2 总体架构

```
<data_home>/harnesses.d/<slug>/
    manifest.json          （纯配置：slug / discovery / session / recipe / billing 锁）
        │
        ├── recipe + overrides ──► 内置受限提取器（P0）
        ├── records: [...]     ──► DSL 解释器（P2 设计预留）
        └── adapter: {...}     ──► 沙箱子进程（P1.5，未承诺）
        │                       三路产物相同：CandidateUsageV1（untrusted）
        ▼
┌─ 共享规范化喉咙（本体侧）────────────────────────────────────┐
│ Candidate schema 校验 · session/identity 注入 · UsageFact build│
│ 本体生成 fact_id · provenance revision · 强制 billing 锁 ·     │
│ emit/skip/invalid 分类 · 批量上限（超限整文件失败）             │
└────────────────────────────────────────────────────────────────┘
        ▼
sync 编排：authority DB 先写 → facts/harness-<slug>.jsonl 后写
           （沿用现有重试、lease、exactly-once 与对账语义）
        ▼
通用聚合查询按 harness 收纳；pricing / billing / summary / export / MCP /
decision_matrix / UI 逐面审计，不从 `harness TEXT` 推导“下游零改动”
```

设计要点：

- **manifest 是纯配置，recipe 是本体代码**。发现、session 提取、正式身份、
  落盘、去重与账单锁定全部留在本体侧。P0 不把执行权交给 manifest——
  manifest 的来源（本地导入或 P0.5 官方目录拉取）不改变这一点。
- **为什么 recipe 优先**：许多新 CLI 日志可归为少数“单记录 usage”语义族，
  差异集中在字段路径。recipe 固化 token 语义、事件判别和默认映射；manifest
  只能用纯点路径覆写取值位置。它仍是一个受限解释器，必须做 Rust/Python
  parity，并不宣称“零分歧”。
- **覆盖率是验收目标，不是前提**：P-1 用不少于 10 个真实执行环境样本，分别按
  执行环境数和有效 usage 行数统计 recipe-only 覆盖率；目标 ≥80%。达不到就调整
  recipe 边界，不能为了数字把累计快照/多行折叠硬塞进路径覆写。
- 复用而非新建：`FactWriter` exactly-once（`ingest_service.rs` 既有）、
  `HarnessIngestReport` 的 invalid 如实报数惯例、facts JSONL 布局与 13 个月滚动、
  以及 `sync_service` 现有 authority-first + JSONL 双写编排。manifest 执行环境不得另造一条
  专属写库路径。

## §3 Manifest 规范

### 3.1 布局与命名

- 本地输入路径：`<data_home>/harnesses.d/<slug>/manifest.json`。P0 目录内没有可执行脚本。
  P0.5 vendor 下载与 local 导入走相同 schema、format guard 与 dry-run 门槛，
  校验后进入 `state/extensions/objects/<sha256>/payload.json`，按 authority
  active generation 加载，不以扫描输入文件替代激活。`origin` 由获取通道
  在**安装时**写入 authority/provenance，manifest 本体不得声明 origin 字段
  （附录 A schema 无此字段；写了即校验错误）——防本地手写 manifest 伪造
  「官方 recipe」徽标。
- slug 字符集：`[a-z][a-z0-9-]{0,31}`。保留字（不可占用）：`claude-code`、
  `codex`、`dsh`、`workbuddy`、`openclaw`、`hermes`（防 `harness:claude-code`
  式冒充）；`harness-` 文件前缀由本体生成，不占 slug 空间。
- 落库形态：`harness = "harness:<slug>"`；facts 文件 `facts/harness-<slug>.jsonl`。
  slug 字符集校验在 `facts_path` 之前完成，路径穿越防护语义保持不变
  （见 §7.2）。
- `manifest_version`：本规格为 `1`。不认识的版本 → 拒绝加载并给出可操作报错，
  不猜语义。
- `$schema`：指向仓库内 `docs/schemas/harness-manifest-v1.json`（编辑器/Agent 获得
  免费 IntelliSense 与校验；该文件本身进 git）。
- discovery 将路径 canonicalize 后按字节序排序去重；默认不跟随指向 root 外的
  symlink。重复 root/重叠 glob 只处理一次，Rust/Python fixtures 钉住同一顺序。
- `session.pattern` 只接受双方共同支持的正则子集和唯一 `(?P<id>...)` 具名组；
  look-around、backreference 等不在子集内的构造安装期拒绝，不由各语言猜语义。

### 3.2 字段表（v1）

| 字段 | 必填 | 说明 |
|---|---|---|
| `manifest_version` | ✓ | 整数，当前 `1` |
| `slug` | ✓ | §3.1 规则；与目录名一致 |
| `display.name` | ✓ | UI 显示名（徽标由本体附加，不由 manifest 声明） |
| `source.format` | ✓ | P0 仅 `jsonl`；坏 JSON 行计 invalid，不是 skip |
| `source.compression` | ✓ | 可选，默认为 `none`；`zstd` 表示源文件按 Zstandard（支持拼接多帧）压缩，解压后须为 UTF-8 JSONL。`discovery.include` 与 `session.pattern` 应匹配完整压缩文件名（例如 `.jsonl.zst`）。Python 兼容运行时需要可选 `zstandard` 包；Rust 原生运行时内置解码器。 |

例如热更新 harness 的日志若为 `session-abc.jsonl.zst`，声明仍保持逻辑格式为 JSONL，仅增加存储编码，并让发现和 session 提取匹配实际文件名：

```json
{
  "discovery": { "roots": ["~/.zcode/rollouts"], "include": ["session-*.jsonl.zst"] },
  "source": { "format": "jsonl", "compression": "zstd" },
  "session": { "from": "filename", "pattern": "^session-(?P<id>.+)\\.jsonl\\.zst$" }
}
```

这不会为 ZCode 或任何特定插件硬编码路径；插件版本变化后，只要日志结构与该 recipe 一致，维护其本地 manifest 即可接入。未声明 `compression: "zstd"` 的旧 manifest 行为不变。
| `discovery.roots` | ✓ | 路径数组，支持 `~/`；P0 只读本地路径。发现由本体执行，
  统一增量、retention 与安全面 |
| `discovery.include` | ✓ | glob 数组（`*`、`**`、`?`） |
| `session.from` / `session.pattern` | ✓ | P0 仅 `filename` + 受限正则，规范具名组
  写法为 `(?P<id>...)`；`id` 由喉咙提取注入。记录内提取留 P2 |
| `recipe` | ✓ | P0 命名语义族及版本，例如 `request-usage-anthropic-v1` |
| `requires.recipes` / `requires.features` | ✗ | CAP-1 能力声明；逐数组最多 64 项、非空字符串、无重复；未知能力拒绝。旧 local manifest 缺声明仍验证实际 recipe，不视为任意能力许可 |
| `min_app_version` | ✗ | 发布版本 `MAJOR.MINOR.PATCH`，无前导零或后缀，每段为 u32；高于当前运行版本拒绝。目录 entry 必须显式声明，旧 local manifest 缺省无最低版本约束 |
| `overrides` | ✗ | recipe 语义槽位到源记录的纯点路径覆写；无表达式、函数或数组下标 |
| `event_key.paths` | ✓ | 构造 `source_event_id` 的候选键路径数组；不是 `fact_id` |
| `records` | — | DSL 规则数组（§5，P2 capability；P0 schema 不接受） |
| `adapter` | — | 沙箱脚本（§9.3，P1.5 capability；P0 schema 不接受） |
| `limits.max_rows_per_file` | ✗ | 默认 50_000，封顶 500_000 |
| `billing` | ✗ | 仅接受 `lock:metered_estimate`（写了别的值 = 校验错误；
  该字段的存在意义是让 manifest 作者显式承认这个锁定） |
| `trust` | ✗ | 可选的只读 Trust artifact profile；声明 `~/` 下的证据根、归档文件名 token 和扩展名。导入后动态接入 Finding 采集，不读取内容、不声明网络外发 |

## §4 Recipe 提取语义（P0）

### 4.1 Recipe 注册表

recipe 是 Rust/Python 本体内置、版本化、golden 钉死的语义提取器，不由
manifest 提供代码。名称按**数据语义**而不是字段拼写命名；首批候选：

| recipe | 语义 | 主数量 |
|---|---|---|
| `request-usage-anthropic-v1` | 每行一请求；input 已是非缓存输入，cache read/write 分桶 | `uncached_input_tokens` |
| `request-usage-openai-total-input-v1` | 每行一请求；prompt/input 含 cached，recipe 做受控减法 | `total_input_tokens` |
| `request-usage-four-bucket-v1` | 每行一请求；四桶均为增量 | `uncached_input_tokens` |

每个 recipe 必须固化：记录 discriminator、默认路径、token 桶算术、
`source_usage_semantics`、`observation_kind`、必填字段、允许覆写字段和错误分类。
累计快照、跨行差分、session fold 不得伪装成 request recipe。
discriminator 是对覆写后语义槽位及独立事件类型的内置谓词，不由 manifest
提供表达式；recipe 必须列出其 required/forbidden shape，供 dry-run 解释命中原因。

### 4.2 路径覆写

- 路径文法仅为 `IDENT ("." IDENT)*`；无函数、索引、通配、回退或类型转换。
- 缺失与 JSON `null` 必须区分；bool 不得当整数；token 只接受 `0..=i64::MAX`。
- `overrides` 只能改 recipe 声明为可覆写的 Candidate 字段，不能改变 token
  算术、discriminator、billing、harness、identity basis 或 observation kind。
- Rust/Python 共用 fixtures，钉住 Unicode、缺失/null、大整数、错误类型与
  canonical JSON；“实现短”不等于免除 parity。

### 4.3 `emit / skip / invalid` 三态

recipe 先用内置 discriminator 判断记录是否属于本行型：

- 不属于该行型 → `skip(reason=not_target_record)`；
- 已属于但必填路径缺失、null、类型错或算术不成立 → `invalid(code, excerpt)`；
- 完整合法 → `emit(CandidateUsageV1)`。

禁止用“主数量为 null 就 skip”掩盖 schema drift。`skip` 与 `invalid` 分开计数，
报告最多保留 8 条脱敏问题；只有本地 private preview 可临时显示原始上下文。
每文件还有 format guard：非空 JSON 记录文件若零 target/零 emit，**首装**
dry-run 拒绝；**已安装 revision 下新发现的文件**若零 target/emit → 计
skip 并在报告标黄（执行环境更新新增兄弟日志类型是正常演化，不 brick 摄入）；
已安装 revision 若相对历史基线突降为零，整文件报 schema-drift，不推进
checkpoint。discriminator 优先使用事件类型等独立字段；不得仅等价于主 token
路径存在。P0 判据实现为「主数量槽位有效路径的**父容器**是 JSON object」，
两条边界钉死：① 容器存在但不是 object（含显式 null / 数组）→ 一律
`skip(not_target_record)`——形状漂移按无账可记处理，由 format guard 的
计数监控兜底，不升 invalid；② 主数量槽位覆写为顶层路径（无 `.`）时，父
容器判据退化为「记录本身是 object」——作者选这种映射等于宣告全文件皆
目标行型，缺失字段会洪泛成 invalid，这是作者契约而非缺陷。canonical
event_key 的字符串长度前缀一律是 **UTF-8 字节数**（非码点数）。

### 4.4 `event_key`

`event_key.paths` 提取的值按类型标记、长度前缀和固定顺序做 canonical encoding，
生成 `source_event_id`。任一路径缺失/null → matched record 为 invalid。同一
session 内重复 `source_event_id` 分两类：候选行**字节级相同**（执行环境崩溃重写
同一记录是真实场景）→ 折叠计 `duplicate` 如实报数（与 unaccounted 哨兵同一
惯例）；内容不同（同 id 不同载荷）→ 整文件失败，不静默吞掉。最终 `fact_id` 仍由
`build_usage_fact(machine_namespace, harness, source_profile, native_session_id,
source_event_id, observation_kind)` 在本体侧生成，manifest 无权提供或覆盖。

## §5 DSL 语义（表达式语言）——P2 设计预留

> v0.3 本节为**预留设计**：文法与函数白名单保留为将来提炼 DSL 的底稿，
> P0 不实现。触发条件与提炼原则见 §10 P2。

- 类型：`null` / `boolean` / `integer` / `string`。数组仅作为中间值。
  **只有整数，没有浮点**（回避 Rust/Python 浮点格式化对拍这一整类坑）。
- 文法（EBNF，优先级从低到高）：

```
expr    := expr "??" expr                       // 合并：左非 null 取左
        |  expr "or" expr | expr "and" expr | "not" expr
        |  expr ("=="|"!="|"<"|"<="|">"|">=") expr
        |  expr ("+"|"-") expr
        |  primary

primary := literal | path | call | "(" expr ")"
path    := IDENT ("." IDENT | "[" integer "]")*  // 不存在的键/越界 → null
```

- 无赋值、无变量、无用户函数、无递归、无循环；终止性由构造保证。
- 内置函数白名单（封闭集合）：`join` / `split` / `trim` / `lower` / `upper` /
  `replace`（字面量，非正则）/ `regex_extract`（仅具名组，无匹配 → `null`）/
  `hash`（sha256 前 16 hex，两实现字节一致）/ `len` / `num` / `fmt_int`。
- **禁止**：`now`/`random`/`env`/文件与网络访问、用户自定义函数、递归、
  非具名组正则、浮点字面量。
- 求值失败 → 行级 invalid，计入 `HarnessIngestReport.invalid`（沿用「最多 8 条」
  惯例），不中断整文件。

### 5.1 记录提取模型（DSL 专用）

- 一条 record 规则 = `when`（谓词）+ `fields`（Candidate 输出映射）+
  `event_key`（构造 `source_event_id`）；
  多条规则按序求值，**每行最多命中一条**。
- `event_key` 必须决定性；最终 `fact_id` 仍由正式 builder 生成。
- 产物必须是 §9.1 的 `CandidateUsageV1`，并经过同一规范化喉咙。

## §6 信任与账单护栏（所有提取路径共用）

1. **计价锁**：manifest 执行环境事实强制 `billing_mode=metered`、
   `pricing_basis=metered_estimate`；`provider_raw` 交共享 normalizer，只有精确
   命中才填 `provider_id`，否则为 null。即使识别 provider，也不得推断官方
   subscription route。汇总面强制 `has_unresolved=true`，原因码按 `origin`
   区分（v0.4.0）：`vendor-catalog` → `data-plane-recipe-no-billing-evidence`
   （recipe 已过 vendor 评审，缺的是订阅/账单证据）；`local` →
   `unreviewed-manifest-route`（执行环境适配未经官方审计）。manifest 无权声明订阅档。
2. **币种**：P0 阶段manifest 执行环境行不参与金额声明（成本由 pricing catalog join 得出
   estimate）；多币种处理沿用决策矩阵 §4.6 既有规则。
3. **Provenance**：**P0 为逐行 provenance**——每条事实携带
   `source_revision`（manifest 字节 sha256 前 16 hex）与 `adapter_version`
   （recipe 代码 id），存于 facts JSONL 与 `usage_facts.source_profile`
   邻近的身份面；批报告不能成为唯一 provenance。`manifest_revisions` /
   `manifest_fact_revisions(fact_id, revision_id)` 的最小关联能力 **P0.5 落地**，
   复用扩展架构 §5.5 的统一台账，保存完整 SHA-256、origin 与 generation。
   既有短 revision 不承担完整性验证；字节契约变更另经 golden 评审。关联行
   随事实 retention 清理，但活跃/回滚/封账引用未解除前不得回收 revision。
   redacted export/MCP 不暴露本地路径或原文。
4. **行数上限**：单文件默认 50_000 条目标记录、封顶 500_000；超限 → 整文件
   失败且不推进 checkpoint、不提交部分事实。P0 不做分页，避免“截前 N 行”随
   输入顺序变化造成永久漏账。
5. **首装仪式**：manifest 必须经过 `manifest-validate`（dry-run）才可
   `manifest-ingest`。dry-run 报告：命中行数、日期范围、模型清单、invalid
   计数与样例问题、脱敏样本行（截断 ~120 字符，沿用既有 redaction 惯例）、
   **正式 fact_id 稳定性检查**（同文件重放两遍，id 有序序列与分类计数任一
   不一致 → 拒绝安装）。桌面导入向导（P1）把这个报告作为确认面。
6. **行为面排除**：issue evaluator、trace_service、session narrative 的查询
   谓词统一加 `harness NOT LIKE 'harness:%'`（或等价白名单），在各自模块内声明，
   不依赖下游自觉。
7. **凭据与出网**：P0 recipe 在本体进程内执行纯读取/取值逻辑，无网络、环境
   变量或任意文件 API。P1.5 adapter 不得仅靠“不传凭据”声称安全；启用前必须
   有可验证的网络禁止、只读文件白名单、净化环境、资源限制和进程树终止。

## §7 摄入核心与代码调整分析（2026-09-19 实测勘察）

### 7.1 现状：封闭词表的真实分布

「加执行环境四处一起改」（`ingest_service.rs` 模块头原文）实测为**三处定义 +
一处别名**：

| 常量 | 位置 | 控制的面 | 处置 |
|---|---|---|---|
| `FACT_HARNESSES` | `crates/agent-vitals-runtime/src/ingest_service.rs:37` | 账面摄入（facts 文件路由、retention 遍历） | **动态化**（§7.2） |
| `facts_path()` | `ingest_service.rs:40` | 未知执行环境拒绝 = **路径穿越防护**（「不给任意 JSON 落任意文件留门」） | **保留语义**，slug 字符集校验前置 |
| `enforce_retention()` | `ingest_service.rs:218` | 13 个月滚动清理按 FACT_HARNESSES 遍历 | registry 驱动，覆盖 `harness-*.jsonl` |
| `TRACE_HARNESSES` | `trace_service.rs:40` | 行为/轨迹面 | **保持官方封闭**（§1 行为面不开放） |
| `HARNESSES` | `reimport_verify.rs:23`（= FACT_HARNESSES 别名） | 重导入校验 | 跟随摄入面，无需单独改 |
| `WIRED_HARNESSES` / `NOT_YET_WIRED_HARNESSES` | `summary.rs:34-35` | token 汇总可见性 | **实施时复核用途**：若是账面汇总则应含 manifest 执行环境（倾向包含），若是行为汇总则保持封闭 |

关键判断：**不是把所有词表全部动态化**。行为面的词表保持封闭正是「行为须
官方」这条产品边界的代码化身；账面摄入是主要开口，source controls、summary、
pricing、export/MCP 等消费面按 §11.1 审计矩阵分别决定动态化或显式排除。

### 7.2 HarnessRegistry（新增）

```
crates/agent-vitals-runtime/src/harness_registry.rs
  official_harnesses() -> [&'static str; 4]          // 现四官方
  plugin_slugs(data_home) -> Vec<PluginHarness>     // 扫 harnesses.d/*/manifest.json，
                                                 // 只读；slug 校验 + 版本检查
  all_harnesses(data_home) -> Vec<String>            // "harness:<slug>" 形态并入
```

- 以 canonical manifest 内容 hash 作为 revision 缓存键；单次 ingest 固定一个
  registry snapshot。更新经 validate 后原子激活，坏新 revision 保留旧版并告警。
  `facts_path` 改为查 registry（官方快捷路径保留常量匹配，manifest 执行环境走 slug 校验后拼 `harness-<slug>.jsonl`）。
- 未通过校验的 manifest：**不进 registry**，CLI/UI 报可操作错误。半坏目录
  不得拖死官方四执行环境的摄入（降级隔离）。

### 7.3 各层调整清单

| 层 | 调整 | 规模 |
|---|---|---|
| harnesses crate | 新增 `generic/manifest.rs`、`discover.rs`、`recipe.rs`、`candidate.rs`；DSL `expr.rs` 缓建，adapter 不进 P0 | 中 |
| runtime | `harness_registry.rs` + Candidate→UsageFact 喉咙 + sync 既有双写编排接入 + billing 锁 + revision provenance | 中→大 |
| CLI | `manifest-list` / `manifest-validate --manifest <p>`（含 dry-run 与 fact_id 稳定性检查）/ `manifest-ingest --manifest <p> [--write]`。**不动** `main.rs:65` 的 `--harness` 枚举（那是 sessions 扫描 = 行为面） | 小 |
| data crate | `usage_facts.harness` 无需改；P0 provenance 走事实行 `source_revision`；P0.5 增加统一台账与 revision 关联并更新 export/rebuild | 无→中 |
| Python 对等 | `generic_manifest.py` + `generic_recipe.py` + Candidate 映射 + CLI；与 Rust 共用 fixtures 做字节差分，不宣称天然 parity | 中 |
| 桌面 UI | workbench.js 执行环境名映射兜底：`harness:<slug>` → manifest.display.name + 按 `origin` 双轨徽标（「官方 recipe」/「本地导入·未审计」）；`SK_HARNESS_ORDER` 官方序后追加。P1 加导入向导 IPC：`manifest_preview` / `manifest_import` | 小→中 |
| golden | `golden/harness-generic-zcode.json`：manifest + fixture → 分类计数/Candidate/UsageFact/落库行；另有 recipe 边界 fixtures | 小→中 |

### 7.4 明确不用动的（架构红利清单）

- authority 的通用聚合查询保持 harness-agnostic；但 pricing、billing declaration、
  summary、source controls、retention、export、MCP、matrix 与 UI 必须逐面审计并
  加契约测试，不能从 `harness TEXT` 推导出“下游零改动”。
- `FactWriter` exactly-once / 崩溃半行修复 / 写后重放自检：manifest 执行环境文件与官方
  文件同机制。
- sessions 扫描、issue evaluator、trace、narrative：行为面本来就排除。
- 桌面端 spawn CLI 的 run_json 通路：`manifest-ingest` 复用同一条路。

## §8 对拍与测试策略

1. **固定 golden（契约）**：manifest+fixture → `emit/skip/invalid` → Candidate
   → UsageFact → 落库行，Rust/Python 双跑字节对齐。runner 需要显式增加 generic
   case 类型，不能假设“零概念变更”。
2. **Candidate 是内部版本化契约**：facts 文件字节序仍由正式 `UsageFact`
   builder 归一化；Candidate 的字段、三态分类与到正式事实的映射由 golden
   钉死，不接受 manifest 自定义新字段。
3. **schema 校验测试**：坏 manifest 全分类（未知版本、坏 slug、缺必填、
   P0 出现 `records`/`adapter`、未知 recipe、非法覆写、`billing` 非法档）拒绝。
4. **降级路径测试**：matched 行缺字段计 invalid、非目标行 skip、行数超限整
   文件回滚、event key 冲突、fact_id 不稳定、双写第二阶段失败重试、半坏
   harnesses.d 不影响官方执行环境。
5. **DSL 专属的生成式差分测试**（随机表达式程序 × 随机记录，断言 Rust ==
   Python 字节一致）：随 DSL 实现进 P2，P0 不存在这个测试面。
6. **诚实边界（写进测试注释）**：对拍证明两侧实现一致，不证明任何一个
   符合执行环境日志的 ground truth——那靠 fixture 选样与 §6.5 dry-run 兜底。
7. **P0.5 目录面测试**（v0.4.0）：index 校验（sha256 不符、未知 slug、
   revision 回退、所需 recipe/最低本体版本不足）拒绝且有可操作报错；拉取件
   与本地导入共用同一 golden 路径；网络策略关闭时降级不产生错误态。

## §9 Candidate 契约、正式映射与长尾 Adapter

### 9.1 `CandidateUsageV1`

recipe/DSL/adapter 的共同输出是版本化内部 DTO，不接受外部 `fact_id`：

`event_ts`（带 offset 的 RFC3339）、`source_event_id`、`model_raw`、
`provider_raw?`、`uncached_input_tokens?`、`cache_read_tokens?`、
`cache_write_tokens?`、`output_tokens?`、`provider_request_id?`。

`event_ts`、`source_event_id`、`model_raw` 必填且非空；至少一个 token 桶非
null，给出的桶必须是非负 i64。时间统一规范化为 UTC
毫秒，拒绝无 offset、闰秒与越界。未知字段拒绝，缺失与 null 保持不同。

### 9.2 `CandidateUsageV1 → UsageFact`

| UsageFact 字段 | 来源 |
|---|---|
| `machine_namespace` | 本体机器命名空间 |
| `harness` | `harness:<slug>` |
| `source_profile` | discovery root 的稳定 profile id，不含原始绝对路径 |
| `native_session_id` / `session_key_ref` | manifest session 提取结果 |
| `source_event_id` | §4.4 event key |
| `observation_kind` | recipe 内置常量 |
| `identity_basis` | event key 全部来自执行环境原生字段时为 `native` |
| `event_ts_utc` / `event_tz_basis` / `time_basis` | Candidate 原生时间；不得拿文件时间冒充 |
| token 四桶 / raw provider/model | Candidate 同名字段 |
| `source_usage_semantics` | recipe 内置语义 |
| `adapter_version` | 内置 recipe 代码版本 |
| billing fields | 本体强制的 manifest 执行环境 metered-estimate 矩阵 |
| `fact_id` | `build_usage_fact` 计算，外部不可写 |

manifest 执行环境事实固定 `billing_mode=metered`、`pricing_basis=metered_estimate`。
`provider_raw` 保留；共享 normalizer 精确命中时可填 `provider_id` 与
`billing_source`，否则二者为 null；`evidence_basis` 按原始字段是否存在取
`session-native` 或 `missing`。无论是否识别 provider，`has_unresolved=true`
都在汇总/服务投影层强制，原因码按 `origin` 区分（§6.1）：
`data-plane-recipe-no-billing-evidence` / `unreviewed-manifest-route`。active
billing declarations 不得把 `harness:%` 改成 subscription；必须有 SQL/MCP
回归测试。

### 9.3 Adapter 调用契约（P1.5，未承诺）

adapter 若未来开放，只能在默认关闭的开发者模式运行，输出逐行带类型的
`candidate` / `skip` / `invalid` / `summary` 消息（与 §9.1 CandidateUsageV1
对齐，不与正式 UsageFact 混名），不能用 stderr 承载机器契约。
发现仍由本体完成；子进程只接收单个已授权文件路径。

- 必须证明网络禁止、只读文件白名单、净化环境与 CWD；
- 超时必须杀整个 process group，并限制 stdout/stderr 总字节、单行、内存、
  CPU 与 FD；任何超限整文件失败，不提交部分事实；
- adapter 不可经任何目录分发（P0.5 官方目录与未来社区目录同禁）；没有跨平台
  可靠沙箱时，本阶段保持未实现。

### 9.4 Python 运行时边界（仅 Adapter）

不捆绑 Python；P0 recipe 与官方执行环境对此零依赖。若 P1.5 启用 Python adapter，
才探测 `python3 --version`，并要求 stdlib-only、Python 3.9 兼容。

## §10 分期与验收

- **P-1（recipe feasibility spike）**：不少于 10 个真实执行环境的脱敏 fixture；
  定义 CandidateV1、三态、event key、首批 recipe 与双语言 golden；只 dry-run，
  不写 authority。按执行环境数和有效 usage 行数报告 recipe-only 覆盖率，目标 ≥80%。
  样本放宽条款：真实执行环境数不足 10 时，允许以文件数/行型多样性折算并**如实
  报告折算口径**，不得为凑数虚构样本。
- **P0（安全声明式导入）**：P0-only schema + recipe 注册表/路径覆写 + 正式
  UsageFact 映射 + 逐行 provenance（`source_revision` = manifest sha256；
  revision 关联表在 P0.5）+ 既有 sync 双写编排 + CLI 三命令 + zcode recipe
  试点。不执行 adapter，不实现自动样本推断 UI。
  AC：① zcode 九月真实 rollout 经 `manifest-ingest --write` 进
  `facts/harness-zcode.jsonl` 且重跑零追加；② 决策矩阵出现 ZCode 行且带
  `metered_estimate` + 未审计口径；③ Python 兼容实现双跑 golden 字节一致；
  ④ authority 成功/JSONL 失败后重跑不双计并完成修复；⑤ 半坏 harnesses.d 不影响
  官方摄入。
- **P0.5（官方 recipe 目录拉取，2026-10-01 决策）**：vendor 官方 manifest/
  recipe 目录存放于本仓库 `catalog/`（统一 `index.json` + `harnesses/<slug>.json`，
  index 携带类型、revision 与 sha256），经 GitHub raw——与
  pricing catalog 完全同源（`raw.githubusercontent.com/Oh-Agent-AI/oh-agent/…`）
  ——按需增量拉取。目的：执行环境格式漂移的修复从「等 app 发版」变为「发一个
  recipe revision」。约束：
  - 只分发数据形态（manifest / recipe 引用 / fixture 索引）；脚本 adapter
    不可下发（§9.3 边界原样适用），DSL 未实现前同样不进目录。
  - 网络策略复用 pricing-catalog policy 文件模式：默认关闭、显式 opt-in；
    请求只携带 slug/版本/哈希，不携带任何用户数据。这是 AGENTS.md
    2026-09-19 政策允许的同类出站请求；实施合入时必须同步更新 AGENTS.md
    网络边界一句（出站请求清单加入官方 recipe 目录拉取）。
  - vendor/local 输入分开，安装内容统一存不可变 objects；同 schema 校验、
    format guard 与首装 dry-run。按扩展架构 §8.3 事务切换 generation，
    提交前失败保留旧 revision，不影响官方执行环境摄入。
  - **计价锁与诚实纪律不因来源放宽**：官方目录拉取的行仍是数据面行，
    `metered_estimate` + `has_unresolved` 照旧（recipe 无法证明订阅 scope）；
    行为面仍不消费任何 harnesses.d 行。差异只在 provenance 与徽标：
    `origin: vendor-catalog` 显示「官方 recipe」，`origin: local` 显示
    「本地导入·未审计」。
  - revision 升级走 §11.5 漂移预览（同一源行换 id 默认拒绝激活）后原子切换。
  - 目录 index 采用扩展架构 §5.4 的 typed entries；harness 的 slot_id 为 slug，
    entry schema_version 对应 manifest_version。index 可跟 main 浮动，
    payload 固定完整 commit SHA + SHA-256；tag 仅展示，不作下载定位。
    CAP-1、持久化 origin/revision 关联与激活事务均为 P0.5 前置门。
  - 拉取面命名：CLI `manifest-catalog-status` / `manifest-catalog-update`；MCP
    control_plane 镜像 `pricing_catalog_status` / `pricing_catalog_policy_set`
    既有形态（含网络策略开关）。
  - **应急旁名规则**（v0.4.0）：上游格式漂移打挂编译适配器时，允许官方目录
    下发旁名应急 recipe（如 `claude-code-drift`；保留字只锁精确名，不锁
    `<harness>-drift` 变体），落库仍为 `harness:claude-code-drift`、双徽标如实
    标注、仅保 token 账面——定位是救生筏不是引擎，正式修复仍随 app 发布。
  AC：① 拉取 → 校验 → dry-run → 激活链路对同一 revision 重放不产生双计；
  ② 网络策略关闭时诚实降级为「使用既有本地 manifest」，不把「无法检查更新」
  当错误；③ 篡改/半坏拉取件拒绝激活且保留旧 revision、不影响官方摄入；
  ④ `origin` 贯穿 facts provenance 与 UI 徽标，计价档断言有回归测试。
- **P1（产品期）**：桌面导入向导（选样本 → 本地聚类 → 生成带置信度和歧义
  的 manifest 草案 → dry-run → 预览确认 → 原子安装/回滚）、执行环境徽标、KPI/
  矩阵的插件呈现口径。原始样本只在本地 private presentation face 使用。
  AC：预览报告字段齐全（含 fact_id 稳定性与双计警示）；删除 harnesses.d 条目后
  UI 诚实降级（历史行保留、来源标注）。
- **P1.5（Adapter 开发者模式，未承诺）**：只有能力沙箱跨目标平台验证通过，
  才开放任意 executable；默认关闭、显式风险确认、不可经目录分发。
- **P2（DSL 提炼，触发条件驱动，不排日历）**：当满足「≥3 个真实 recipe
  无法覆盖、但规则模式重复的执行环境」或「分发需求出现」之一时提炼 DSL（§5 底稿
  + 生成式差分测试）。原则：**从证据里长语言，不猜着设计**。
- **P3（社区/第三方目录，政策门槛，未承诺）**：v0.3.2 已把**官方**目录分发
  定案为 P0.5（本仓 GitHub 拉取）。P3 只保留社区/第三方目录：多来源注册、
  签名与信任链、非 vendor manifest 的分发治理——数据形态约束同 P0.5
  （脚本永不下发），且因涉及新的出站目的地，仍须按 2026-09-19 政策另行评审
  并更新 AGENTS.md 网络边界文字。

## §11 开放问题（评审定夺）

1. `WIRED_HARNESSES`、source controls、pricing dispatch、export/MCP 等消费面逐项
   如何收纳 manifest 执行环境；实施前必须形成审计矩阵，不以“SQL 自由文本”代替证明。
2. manifest 执行环境「转正」：未来 ZCode 成为官方执行环境时，`harness:zcode` 历史行的
   迁移策略（重 stamp or 并存标注）。早定避免 facts 重写。
3. `session.from: record` 扩展（会话键只能从记录内容提取的执行环境）——P2。
4. （已决，2026-10-01）目录分发的政策评审——官方目录定为 §10 P0.5：从本仓
   GitHub 拉取、pricing catalog 同模式（opt-in、不带用户数据）；社区/第三方
   目录仍留在 P3 待评审。
5. recipe/event-key 版本升级的身份漂移：升级预览必须比较旧新 revision 的
   `(session, source_event_id, fact_id)` 集合；同一源行换 id 时默认拒绝激活。
6. zcode rollout 的行型清单：实测同文件存在 snake_case 与 camelCase 两套
   `usage` 块，数值关系 `inputTokens = input_tokens + cache_read_input_tokens`
   （886 + 403776 = 404662，2026-09-19 实测）——**请求侧/汇总侧两种行型，
   recipe 必须用 discriminator 只取请求侧，汇总侧计明确 skip；不能仅靠字段
   null，也不能把 dry-run 行数合理性当最后一道正确性证明。
7. `source.format: sqlite`（只读 URI + 声明式表/列选取）的安全面单独立项
   评审时点——v2 分期最后一项（§12.6）。

## §12 manifest v2 路线（2026-10-01 增补）

目标：**新出的执行环境默认以 manifest 经官方目录下发接入**。现状 v1 已覆盖
「JSONL + 文件名会话身份 + 三大 recipe 族 + 纯路径 provider_raw」的规整新
CLI（多数新 coding CLI 属于此类）；v2 补齐其余长尾。分期原则：先下发安全
地基（12.1/12.4），后机制扩展（12.2/12.3），SQLite 单独立项（12.6）。

### 12.1 capabilities 协商（CAP-1，提前至 P0.5 的下发安全前提）

manifest 增 `requires: { recipes: [...], features: [...] }` 块；本体自报
`CapabilitySet`（app 版本、recipe 族、features）。未知 recipe / 未知
feature / manifest_version 超前 → **拒绝激活**并报缺失能力及已知最低版本；
无法确定支持版本时不编造版本号，不得
「结构校验通过、运行时静默跑错」。`manifest_version` 的既有原则逐
capability 推广。

### 12.2 schema 扩展（MAN）

- **多源（MAN-1）**：单一 `discovery`+`source` → `sources: []` 数组，每源
  各自 format/roots/recipe；新增会话身份 join 规则（主键源 + 挂接方式）。
  WorkBuddy 式「SQLite 会话元数据 + JSONL 用量」多店执行环境的前提。
- **格式扩容（MAN-2）**：`jsonl` 之外增 `json`（单文档/数组）、`rotated`
  （`.1`/`.gz` 兄弟文件语义）；`sqlite` 后置单独立项（只读 URI + 声明式
  表/列选取，安全面最大，见 §11.7）。
- **会话身份（MAN-3）**：`session.from: record`（提前自 P2）；**路径段
  捕获**（`~/.claude/projects/<项目名>/<uuid>.jsonl` 的项目名等身份上下文，
  纯文件名正则拿不到）；**时基声明**字段（执行环境记本地时间无 offset 时必须
  声明时区依据，否则 `time_basis` 诚实性守不住）。
- **provider 证据槽（MAN-4）**：`provider_evidence`：`model_provider` 与
  `base_url` 各自可选路径，喂共享 normalizer——「显式 provider 标记优先于
  端点提示」的归因规则（AGENTS.md watchlist）对manifest 执行环境同样成立。

### 12.3 recipe 族扩展（本体代码，随 app 版本走，不经目录下发）

- `message-tree-usage-v1`：树形日志（分支去重、按实际走过的分支计数）；
- `snapshot-delta-v1`：累计快照式用量（受控差分——§4.1 禁止其伪装
  request recipe，正名即立新族）；
- 多行型规则表：一个文件混多行型时按内置规则表选 recipe（P2 DSL 触发条件
  「≥3 个 recipe 覆盖不了的执行环境」大概率因此触发，`records` 保守版提前设计）。

### 12.4 目录规模化（CAT）

index schema 与不可变 revision 见 §10 P0.5 补强条目；另加：capability
标签进 index（旧 app 拉到新 manifest 时的拒绝依据，与 12.1 配套）。

### 12.5 明确不升

脚本分发（永不）、计价锁与 `has_unresolved`（政策）、行为面排除
（`harness NOT LIKE 'harness:%'` 保持）、保留字清单（claude-code/codex/dsh 等
继续锁死精确名，旁名规则见 §10 P0.5）、13 个月 retention 与行数上限。

### 12.6 分期

1. CAP-1 + CAT（下发安全地基）；2. MAN-3 / MAN-4（小步，独立可验收）；
3. MAN-1 多源 join；4. MAN-2 之 json / rotated；5. sqlite 单独立项评审；
recipe 族随本体版本按需长。

## §13 harness 字符串契约迁移：`plugin:` → `harness:`（v0.4.1，2026-10-01）

**背景**：P0 已部分实施——`agent-vitals-query/sources/harness_registry.rs`、
`agent-vitals-harnesses/harnesses/generic/manifest.rs`、
`agent-vitals-ingest/ingest/plugin_ingest.rs`、Python `generic_plugin.py`、
golden `harness-generic-zcode.json`——现行实现以 `plugin:` 为前缀。本节将其
改为 `harness:`，并把 `plugin` 一词让回给真正的插件系统（DSH plugin、
Claude Code `enabledPlugins` / plugin skills——本产品域内两者真实存在）。

### 13.1 三轴解耦（改名的语义理由）

| 轴 | 承载者 | 取值 |
|---|---|---|
| 机制（接入方式） | harness 字符串 | 官方裸名（`claude-code`）vs `harness:<slug>` |
| 评审档 | `origin` | `vendor-catalog` / `local` |
| 计价档 | billing 锁 | `metered_estimate` + `has_unresolved` |

`plugin:` 把三层混在一个前缀里；v0.4.0 的 `origin` 拆走评审档，本节拆完
最后一层。徽标用语随之改为「本地导入·未审计」（local）/「官方 recipe」
（vendor，不变）。

### 13.2 命名映射（全量）

| 项 | 旧（现行实现） | 新（目标契约） |
|---|---|---|
| harness 字符串 | `plugin:<slug>` | `harness:<slug>` |
| facts 文件 | `facts/plugin-<slug>.jsonl` | `facts/harness-<slug>.jsonl` |
| 行为面排除 | `harness NOT LIKE 'plugin:%'` | `harness NOT LIKE 'harness:%'` |
| CLI | `plugin-list` / `-validate` / `-ingest`、`plugin-catalog-*` | `manifest-*`（不用 `harness-*`：`--harness` 枚举是行为面契约，`main.rs:65` 不动） |
| Python | `generic_plugin.py` | `generic_manifest.py`（§7.3 原名，实施回归本名） |
| 原因码 | `unreviewed-plugin-route` | `unreviewed-manifest-route` |
| P0.5 起的逻辑关联表名 | `plugin_revisions` / `plugin_fact_revisions` | `manifest_revisions` / `manifest_fact_revisions`（复用统一扩展台账） |
| 导入向导 IPC | `plugin_preview` / `plugin_import` | `manifest_preview` / `manifest_import` |
| 应急旁名 | `plugin:claude-code-drift` | `harness:claude-code-drift` |
| 徽标 | 「插件·未审计」 | 「本地导入·未审计」 |
| golden | `harness-generic-zcode.json`（内容含旧前缀） | **受控更新**——发布说明单列，不为省事静默刷新 |

保留字规则不变：官方执行环境名继续锁死（防 `harness:claude-code` 式冒充）；
`harness-` 文件前缀由本体生成，不占 slug 空间。

### 13.3 数据迁移（真正的成本点）

- **重导入为主**：manifest 执行环境 facts 全部源自本地日志、可整段重放——旧
  前缀行删除 → 新前缀重 ingest，影响预览走 §11.5 式漂移报告，不重写任何
  事实行。
- **原地迁移兜底**：锁路径、源控制开关等不可从日志重放的少量状态，做带
  备份的一次性 rename / UPDATE，走影响预览 + 失效重建流程
  （US_LAUNCH_I18N_AND_BILLING_SPEC §2.1）。
- **前置条件**：确认没有已导出 / 封账的下游消费锁定在 `plugin:` 字符串上。
- **时机**：美区首发**前**完成。发布后 harness 字符串进入 export/MCP 消费者
  数据，成为外部契约，改名成本数量级上升。

### 13.4 实施落点勘误

harness registry 实际落在 `agent-vitals-query/sources/`（附录 C 预案为 runtime
crate），manifest ingest 落在 `agent-vitals-ingest`。附录 C 行号为
2026-09-19 历史勘察，保留作当时快照；实施以本节与附录 D 为准。

---

## 附录 A：JSON Schema 草案（`docs/schemas/harness-manifest-v1.json`）

```jsonc
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "harness-manifest-v1.json",
  "type": "object",
  "required": ["manifest_version", "slug", "display", "discovery", "source", "session",
               "recipe", "event_key"],
  "additionalProperties": false,
  "properties": {
    "$schema": { "type": "string" },
    "manifest_version": { "const": 1 },
    "min_app_version": {
      "type": "string", "pattern": "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$",
      "description": "Each numeric component must fit u32; runtime validates this bound."
    },
    "requires": {
      "type": "object", "additionalProperties": false,
      "properties": {
        "recipes": { "type": "array", "maxItems": 64, "uniqueItems": true,
                     "items": { "type": "string", "minLength": 1 } },
        "features": { "type": "array", "maxItems": 64, "uniqueItems": true,
                      "items": { "type": "string", "minLength": 1 } }
      }
    },
    "slug": { "type": "string", "pattern": "^[a-z][a-z0-9-]{0,31}$" },
    "display": {
      "type": "object", "required": ["name"],
      "properties": { "name": { "type": "string", "maxLength": 24 } },
      "additionalProperties": false
    },
    "discovery": {
      "type": "object", "required": ["roots", "include"],
      "properties": {
        "roots":   { "type": "array", "minItems": 1, "items": { "type": "string" } },
        "include": { "type": "array", "minItems": 1, "items": { "type": "string" } }
      },
      "additionalProperties": false
    },
    "source": { "type": "object", "required": ["format"],
      "properties": { "format": { "enum": ["jsonl"] } },
      "additionalProperties": false },
    "session": { "type": "object", "required": ["from", "pattern"],
      "properties": {
        "from": { "const": "filename" },
        "pattern": { "type": "string" }
      }, "additionalProperties": false },
    "recipe": { "enum": [
      "request-usage-anthropic-v1",
      "request-usage-openai-total-input-v1",
      "request-usage-four-bucket-v1"
    ] },
    "overrides": {
      "type": "object",
      "propertyNames": { "enum": ["event_ts", "model_raw", "provider_raw",
        "uncached_input_tokens", "total_input_tokens", "cache_read_tokens",
        "cache_write_tokens", "output_tokens", "provider_request_id"] },
      "additionalProperties": { "type": "string",
        "pattern": "^[A-Za-z_][A-Za-z0-9_]*(\\.[A-Za-z_][A-Za-z0-9_]*)*$" }
    },
    "event_key": { "type": "object", "required": ["paths"],
      "properties": { "paths": { "type": "array", "minItems": 1,
        "maxItems": 8, "items": { "type": "string",
          "pattern": "^[A-Za-z_][A-Za-z0-9_]*(\\.[A-Za-z_][A-Za-z0-9_]*)*$" } } },
      "additionalProperties": false },
    "limits": { "type": "object",
      "properties": { "max_rows_per_file": { "type": "integer", "minimum": 1,
        "maximum": 500000 } }, "additionalProperties": false },
    "billing": { "type": "object", "required": ["policy"],
      "properties": { "policy": { "const": "lock:metered_estimate" } },
      "additionalProperties": false },
    "session_title_adapter": { "type": "string",
      "enum": ["zcode_sqlite_session_v1"],
      "description": "Optional reviewed read-only title index adapter; no manifest-provided path, SQL, or code." }
  }
}
```

P0 发布 schema 明确不包含 `records` 或可执行脚本 `adapter`。`session_title_adapter`
是单独的闭集只读能力：只能选择已审计的实现，不接受路径、SQL 或代码。

## 附录 B：zcode recipe 试点（2026-09-19 实测格式）

### B.1 `harnesses.d/zcode/manifest.json`

```jsonc
{
  "$schema": "../schemas/harness-manifest-v1.json",
  "manifest_version": 1,
  "slug": "zcode",
  "display": { "name": "ZCode" },
  "discovery": {
    "roots": ["~/.zcode/cli/rollout"],
    "include": ["model-io-sess_*.jsonl"]
  },
  "source": { "format": "jsonl" },
  "session": {
    "from": "filename",
    "pattern": "^model-io-sess_(?P<id>.+)\\.jsonl$"
  },
  "recipe": "request-usage-anthropic-v1",
  "session_title_adapter": "zcode_sqlite_session_v1",
  "overrides": {
    "event_ts": "completedAt",
    "model_raw": "model.modelId",
    "provider_raw": "model.providerId",
    "uncached_input_tokens": "usage.input_tokens",
    "output_tokens": "usage.output_tokens",
    "cache_read_tokens": "usage.cache_read_input_tokens",
    "cache_write_tokens": "usage.cache_write_input_tokens",
    "provider_request_id": "requestId"
  },
  "event_key": { "paths": ["requestId", "attempt"] },
  "billing": { "policy": "lock:metered_estimate" },
  "trust": {
    "roots": ["~/.zcode/v2/checkpoints"],
    "artifact_terms": ["snapshot", "checkpoint"],
    "extensions": [".enc"]
  }
}
```

### B.2 行型与身份说明

`request-usage-anthropic-v1` 的 discriminator 必须明确识别 ZCode 请求侧行；
camelCase 汇总行计 `skip(not_target_record)`。请求侧已匹配后，缺
`usage.input_tokens`、`requestId` 或 `attempt` 均计 invalid，不能静默跳过。

`providerId`（如 `builtin:bigmodel-coding-plan`）作为 `provider_raw`
证据保留，但**不构成**官方订阅证据——计价锁不因此打开，这本身就是 billing
fallback 规则的用例。`requestId` + `attempt` 只生成 `source_event_id`，最终
`fact_id` 由统一 builder 生成；recipe/event-key 升级须走 §11.5 漂移预览。

## 附录 C：现状耦合点勘察清单（2026-09-19，行号以 main 为准）

| # | 耦合点 | 位置 | 本规格处置 |
|---|---|---|---|
| 1 | `FACT_HARNESSES` 封闭词表 | `crates/agent-vitals-runtime/src/ingest_service.rs:37` | §7.2 registry 动态化 |
| 2 | `facts_path` 未知执行环境拒绝（防路径穿越） | `ingest_service.rs:40` | 保留，slug 校验前置 |
| 3 | `enforce_retention` 按 FACT_HARNESSES 遍历 | `ingest_service.rs:218` | registry 驱动 |
| 4 | `TRACE_HARNESSES`（行为面词表） | `trace_service.rs:40` | 保持封闭 |
| 5 | `HARNESSES`（FACT_HARNESSES 别名） | `reimport_verify.rs:23` | 自动跟随 |
| 6 | `WIRED_HARNESSES` / `NOT_YET_WIRED_HARNESSES` | `summary.rs:34-35` | §11.1 复核 |
| 7 | usage_facts 表 | `crates/agent-vitals-data/src/authority.rs:355`（harness 自由文本） | 零迁移 |
| 8 | 配额快照表 CHECK | `authority.rs:986`（仅 claude-code/codex） | 插件不写，无影响 |
| 9 | CLI `--harness` 枚举 + 每执行环境子命令 | `apps/cli/src/main.rs:65` | 枚举不动；新增 manifest-* 子命令 |
| 10 | Python `--harness` choices + 子命令 | `packages/agent-vitals-python/agent_vitals/cli.py:624,840` | 新增 generic twin |
| 11 | UI 执行环境名映射 / `SK_HARNESS_ORDER` | `apps/desktop/src-tauri/ui/workbench.js`（名映射 ≈:4430） | 兜底 + 徽标 + 追加序 |
| 12 | golden 案例形态 | `golden/harness-workbuddy.json` | 同构新增 generic 案例 |
| 13 | 下游消费面 | 通用 SQL 可收自由 harness；pricing/summary/export/MCP/UI 仍有分发或词表 | §11.1 审计矩阵后逐项接入/排除 |
| 14 | Python 运行时 | 仅未来 adapter 开发者模式可能依赖 | P0 无依赖；§9.4 不捆绑 |
| 15 | source controls 封闭词表 | `crates/agent-vitals-runtime/src/source_controls.rs` | 纳入消费面审计；插件必须可停止后续读取 |
| 16 | authority-first 双写 | `sync_service.rs` / `sql_sync.rs` / `ingest_service.rs` | 插件复用同一编排、失败恢复与对账 |

## 附录 D：本体接口契约（Rust 签名草案，v0.4.0）

原则：所有接口都是「本体保留执行权、manifest 只提供数据」这条线的代码化
边界；manifest 永远只能填参数，不能越过它。落位：1–4 于
`agent-vitals-harnesses/generic/`，5/7/8 于 `agent-vitals-runtime/`
（`harness_registry.rs` + catalog 子模块），6 于 `agent-vitals-provider` 与
harnesses 会话子模块，MCP 面于 `agent-vitals-mcp/control_plane`。Python twin
实现同一组签名，golden 两侧字节对拍。其中 1/2/5/7/8 是 P0/P0.5 地基；
3 的 Sqlite 变体、4 的 tree/snapshot 族、6 的 Composite join 是 v2 分期项
（§12.6）。

```rust
// 1. 能力协商（harnesses/generic/manifest.rs）——下发安全的门
pub struct CapabilitySet { pub app_version: Version,
    pub recipes: Vec<RecipeId>, pub features: Vec<FeatureId> }
pub fn parse_manifest(bytes: &[u8]) -> Result<HarnessManifest, ManifestError>;
pub fn negotiate(m: &HarnessManifest, caps: &CapabilitySet)
    -> Result<(), CapabilityError>;   // 拒绝未知能力；仅在已知时提示最低支持版本

// 2. 发现（harnesses/generic/discover.rs）
pub struct DiscoveredFile { pub path: CanonicalPath,
    pub filename_captures: CaptureMap,   // session.from: filename
    pub path_captures: CaptureMap }      // v2：路径段捕获
pub fn discover(spec: &DiscoverySpec) -> Vec<DiscoveredFile>;
// roots × globs，canonicalize、字节序排序去重——顺序由 fixtures 钉死

// 3. 解码——统一记录流，所有格式归一的地方
pub trait RecordSource { fn records(&self) -> RecordIter; }
// Record = JSON 值 + (行号/字节 offset) 溯源；SQLite 行 → 记录为声明式
// 表/列选取，同样不执行代码
pub fn open_source(format: &SourceFormat, path: &Path) -> Box<dyn RecordSource>;

// 4. 提取——recipe 注册表（本体代码的唯一入口）
pub trait Recipe {
    fn id(&self) -> RecipeId;
    fn discriminate(&self, rec: &Record) -> Discriminant; // dry-run 可解释命中原因
    fn extract(&self, rec: &Record, ov: &Overrides) -> Extraction; }
impl RecipeRegistry {
    pub fn get(&self, id: &str) -> Option<Arc<dyn Recipe>>;
    pub fn resolve(&self, table: &RuleTable, rec: &Record) -> RecipeId; } // v2 多行型
// 树形/快照差分 recipe 吃 RecordTree/窗口而非单条记录——同一 trait、不同
// 输入面，这是 v2 唯一动 trait 的地方

// 5. 规范化喉咙（runtime）——所有路径的合流点，manifest 无权绕过
pub struct IngestContext { pub machine_namespace: ..,
    pub harness: String,                    // "harness:<slug>"
    pub origin: Origin,                  // 安装时写入，非 manifest 字段（§3.1）
    pub source_revision: Revision,       // manifest sha256
    pub session: SessionKey }
pub fn normalize(c: CandidateUsageV1, ctx: &IngestContext) -> UsageFact;
// fact_id 由本体 build_usage_fact 生成；billing 锁、has_unresolved（原因码
// 按 origin，§6.1）、行数上限、format guard 全部在这一层强制

// 6. 身份与归因（v2 的两个扩展点）
pub enum SessionResolver { FromFilename(Pattern), FromRecord(PathSpec),
    Composite(JoinSpec) }
pub fn resolve_session(r: &SessionResolver, f: &DiscoveredFile,
    rec: &Record) -> SessionKey;
pub struct ProviderEvidence {
    pub model_raw: PathSpec, pub provider_raw: Option<PathSpec>,
    pub model_provider: Option<PathSpec>, pub base_url: Option<PathSpec> }
pub fn normalize_provider(e: &ProviderEvidence, rec: &Record)
    -> ProviderAttribution;   // 精确命中才填 provider_id；origin 感知原因码

// 7. 目录客户端与激活（runtime/catalog，镜像 pricing-catalog 模式）
pub trait HarnessCatalogClient {
    fn fetch_index(&self) -> Result<CatalogIndex>;  // 见 P0.5 index schema
    fn fetch_manifest(&self, slug: &str, rev: Revision) -> Result<Bytes>; }
// 获取通道构造不可由 payload 伪造的 VerifiedInstall；含内容哈希与来源。
// 内部执行扩展架构 §8.3 的 generation 事务，不把任意 origin 暴露给导入方。
pub fn install(data_home: &Path, candidate: VerifiedInstall,
    confirmation: PreviewConfirmation) -> Result<Activation>;
pub fn dry_run(m: &HarnessManifest) -> DryRunReport;   // fact_id 稳定性、脱敏样例
pub fn upgrade_preview(old: Revision, new: Revision) -> DriftReport; // §11.5
// 网络策略门：默认关、显式 opt-in；校验失败保留旧 revision 原子回退

// 8. 消费面与测试面（不改契约，只加投影）
// HarnessRegistry::all_harnesses() 驱动 facts_path（保留 slug 校验 + 路径穿越防护）
// 与 retention 遍历；summary/pricing/export/MCP 按 §11.1 审计矩阵逐面加
// origin 投影与徽标；行为面谓词 harness NOT LIKE 'harness:%' 原样；
// CLI：manifest-list / manifest-validate / manifest-ingest
//     + manifest-catalog-status / manifest-catalog-update
```

## 附录 E：分层影响清单（v0.4.0）

| 层 | 改动量 | 内容 |
|---|---|---|
| harnesses（`agent-vitals-harnesses`） | 大（全新增量） | `generic/` 新模块（附录 D 1–4）；**官方六执行环境适配器零改动**；Python twin（`generic_manifest.py` / `generic_recipe.py`）同步，共用 fixtures |
| runtime | 大 | `harness_registry.rs`、规范化喉咙、目录客户端、激活/revision 管理（附录 D 5/7/8）；sync 双写编排复用 |
| domain（`agent-vitals-domain`） | 小（只进策略，不动模型） | 计价锁枚举与强制规则落 domain 常量；origin 感知原因码（§6.1/§9.2）；v2 provider 归因规则；declarations 不得把 `harness:%` 改 subscription 的回归测试 |
| data（`agent-vitals-data`） | P0.5 新增台账与关联 migration | `usage_facts.harness` 自由文本直接落；origin/revision、active generation 与历史关联按扩展架构 §5.5 持久化；配额快照保持封闭；export/rebuild 保留脱敏 provenance，历史重算须预览 |
| UI（workbench.js / React） | 中 | 徽标按 `origin` 双轨；`SK_HARNESS_ORDER` 官方序后追加；P0.5 目录状态/更新面（镜像 pricing catalog UI；网络关≠错误）；P1 导入向导 IPC（`manifest_preview` / `manifest_import`）；plugin 行金额只有「按量估算」桶（BILL-01 映射）；删除 harnesses.d 条目后诚实降级（历史行保留 + 来源标注） |
| MCP（`agent-vitals-mcp`） | 小 | control_plane 镜像 `pricing_catalog_status` / `pricing_catalog_policy_set` 形态（含网络策略开关）；redaction 规则对 `harness:` 执行环境行同样适用 |

检验标准：data 层允许新增扩展台账与 provenance 关联表；既有 billing/behavior
事实契约保持纯净。其他消费层以投影与口径调整为主；改动事实 schema、身份
或计费语义必须单独评审，并验证 golden 与双语言 parity。
