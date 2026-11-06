# Vite 设计经验 → agent-vitals 吸收清单

> 状态：研究结论（2026-08-29）。基于 `vitejs/vite` @ main（浅克隆 `/tmp/vite`，2026-08-29）。
> 目的：回答「从代码的角度，我们的架构要优化吗？能不能类比参考 Vite」——四个并行代码研究
> （插件边界契约 / watch-HMR 增量重建 / 一源多目标 / core 保持执行环境无关）的综合。
> 配套：`RUNTIME_EVIDENCE_CONVERGENCE_SPEC.md`（收敛三阶段）、`DELIVERY_ARCHITECTURE.md`（三投递面）、
> `ARCHITECTURE.md` §10（运行时证据层）。

---

## 0. 一句话结论

**Vite 不是我们的架构模板，但有三条设计纪律值得吸收、一条必须明确反着来：**

1. **边界是真实接口，不是文档约定** —— 插件边界靠类型声明 + 运行时先滤后调落地，
   不是靠文档里的「L3 不许出现执行环境词表」。这是我们 Phase B 唯一要学的核心。
2. **watch 增量重建靠「字节谓词门卫 + 下游幂等」，不靠防抖和墙钟** —— 恰好保住我们
   byte-identical 的铁律。
3. **目标是一等对象**（Vite 的 `Environment` → 我们的 `DeliverySurface`）——把
   「三投递面是同一 fold 的三个投影」从文档口号变成代码里的事实。
4. **反着来：Vite 静默跳过不匹配的插件，我们必须报三态 `Unavailable`。** 对构建工具
   「跳过」是对的；对审计工具「跳过」就是编造 `measured-zero`。

---

## 1. 为什么不能整体模仿 Vite（本质差异）

| 轴 | Vite | 我们 |
|---|---|---|
| 语言 | 一语言（TS），一运行时 | 双语言（Rust core + Python 镜像）+ wasm，**差分测试守一致** |
| 产物 | 一份源码 → dev/build/ssr/worker 多目标 | 一份 fold → DSH tab / HTML / Tauri 三投递面 |
| 铁律 | 构建结果无需逐字节复现 | **golden 逐字节确定**；¥/USD 永不合并；core 无执行环境词表 |
| 边界 | 插件接口 + module graph | `CanonicalSession`/`Signal`/`RuleSpec`（§12 测试守） |

Vite 最大的架构动作是「一语言多目标，零同步成本」——这正是我们**刻意反着来**的地方
（`permanently parallel，无 Rust 取代 Python 出口点`）。合并成一语言违反 stdlib-only
约束，不在桌上。所以 Vite 能给我们的不是架构模板，而是三条**纪律**（§2–§4）。

---

## 2. 吸收 ①：边界是真实接口，不是文档约定

### Vite 的机制

- **顺序契约在类型层**：`enforce: 'pre'|'post'`、`apply: 'serve'|'build'|fn` 是 `Plugin`
  接口字段（`/tmp/vite/packages/vite/src/node/plugin.ts:214-229`），配套注释把整条流水线
  顺序写死在文档里。
- **apply 在配置解析期被求值并剔除**，不是运行时 no-op：`filterPlugin`
  （`config.ts:1526-1541`）在 `resolvePlugins` 之前就把不匹配的插件滤掉。
- **顺序是结构性的**：`resolvePlugins`（`plugins/index.ts:43-157`）用数组字面量摆内置
  插件，用户插件只在三个边界点（pre/normal/post）插入。
- **先滤后调**：容器在调 handler 之前先查 `filter`，不匹配就 `continue`，handler 根本没
  机会跑（`server/pluginContainer.ts:396-397, 553-554`）。

### 映射到我们

- **`rule_outcomes()` 现在是「后置注解」，Vite 模式要求「前置门」**。
  `behavior.rs:462-497` 的 `rule_outcomes` 只读地给已有 findings 打 `RuleOutcome`——注释
  自己写了「不改变 findings 怎么产出，也不重新跑 detect_svNNN」。也就是说 detector 在
  规则注定 `Unavailable` 时**仍然跑了**，跑完再被注解掉。Vite 的模式是反的：dispatcher
  先查 `requires ⊆ coverage`，不满足直接返回 `Unavailable`，**不调 detector**。
  这正是收敛 spec 阶段 B 验收「§10.4 三态落地为可观测」的实装方式。
- **`RuleSpec.requires` 已经是我们的 filter，但没被当 filter 用**。`evidence.rs:336-344`
  的 `RuleSpec { code, requires, enhances, min_fidelity }` 是静态表，`requires` 语义比
  Vite 的 `enforce` 更硬（enforce 只决定插入位置，不检查前置条件）。要守的是：新增规则
  只能往这张表加，不能在各 detector 里再散落信号判断。
- **`reverse_project` 的存在就是「边界没做成」的镜像证据**。Vite 的方向是单向的
  （插件 → 规范化 module，绝无 module → 原始字节的桥）；我们却把规范化会话**反投影回
  DSH 原始事件**（`dsh_evidence.rs:197`）让 9 个模块继续读执行环境形状。Vite 没有也不会有
  这个桥。**它被删掉的那天，DSH 词表才真正只剩 `dsh_evidence.rs::derive_coverage`
  （`dsh_evidence.rs:72-166`）一个家。**

### 第一刀

> **把 detector 签名改成 `fn detect(&CanonicalSession) -> RuleOutcome`，dispatcher 先查
> `requires ⊆ coverage`（缺则 `Unavailable`，不调 detector），只把该规则需要的信号明细
> 喂给 detector。用 spec 已排的族①（SV601–610 command/path）做第一个 PR，golden
> 逐字节不变作等价证明。**

这一刀同时撬动三件事：(a) 让 §10.4 三态成为实装的门；(b) 砍掉 `reverse_project` 存在
的理由；(c) 逼出 `CanonicalSession` 缺失的 `Timeline<Observed<T>>` 字段（spec 自己标注的
「真正的设计决策点」）。

> **✅ 已落地（2026-08）**：验收 = golden 逐字节不变 + 全测试绿（`cargo test` /
> `clippy -D warnings` / 761 Python / `test_cli_matrix` 93 差分 / 15 goldens /
> wasm 重建后 `dsh-client` verify-harness 全过）。落地记录见
> `RUNTIME_EVIDENCE_CONTRACT.md` §17.1a「Phase B」：family ①（SV601–610）已
> 前置门控、10 条 detector 改吃 `CanonicalSession` 时间线（`fn(&CanonicalSession)
> -> RuleOutcome`）、`match_behavior` 变 shim、`rule_outcomes` 拆成
> `match_behavior_canonical` + `trajectory_rule_outcomes`。**唯一**有意的行为
> 修正是 SV610 分叉（unavailable 的规则不再漏出 finding），带 Rust + Python
> 双侧回归。`reverse_project` 仍在——family ④ 与 usage/duration 等模块还读老
> 形状，上面 line 67-71 的预言（DSH 词表只剩 `derive_coverage` 一个家）还没到。

---

## 3. 吸收 ②：watch 增量重建的流水线形状

### Vite 的机制（去神话后的真实样子）

- **底层没有 debounce**。经典 chokidar 路径的 `change`/`add`/`unlink` 各接一个 handler
  （`watch.ts:61-99`），防抖只出现在 dep-optimizer（`optimizer.ts:38`）和 bundledDev
  （`bundledDev.ts:67,77`）。**高频写入的合并不靠事件防抖，靠下游请求去重**
  （`_pendingRequests`，`transformRequest.ts:110-127`）。
- **失效是「文件级触发、模块级传播」**：`fileToModulesMap` 命中文件 → 逐个 invalidate →
  递归走 `importers`（`moduleGraph.ts:145-234`）。
- **增量 vs 全量的分叉在 transformRequest**：静态 import 软失效——保留上一份 transform，
  只重写 `?t=<timestamp>` 后缀；否则硬失效整条链重跑（`transformRequest.ts:453-538`）。
- **HMR accept/decline 门卫**是 `propagateUpdate` 沿 importers 上溯：模块自己 accept 或
  importer accept 了它，传播在此停住、发局部 `update`；走到 dead end → `full-reload`
  （`hmr.ts:683-895`）。
- **读完即写有竞态**：`readModifiedFile` 轮询直到 mtime 变化再重读（`hmr.ts:1138-1155`）。

### 映射到我们（「日志 watch + 增量折叠」）

**能抄的：**

1. **启动全量基线 + 之后只处理 append** = `ignoreInitial: true` 的语义：watch 启动时先
   整文件读一遍做基线 fold，此后只报告新的 append。
2. **accept/decline 门卫落成「对字节的结构谓词」，不是对事件类型/时间的启发式**：
   `offset ≤ size` 且 `[offset, EOF)` 按换行切成**完整 JSON 行** → accept（增量）；文件
   变小、或 offset 处是垃圾字节 → decline（整文件重读，对应 rotation/truncate/rewrite）。
   **这是字节的确定性性质，不引入墙钟——正是守 byte-identical 的关键。**
3. **按偏移游标批量，不按事件防抖**：每次 tick 把 `[offset, EOF)` 里所有完整行一次折完，
   写一次状态文件。批量单位是「游标到 EOF 的整段」，不是「每次 fs 事件」。cc-trace 的
   `ScanBatch{consumed_bytes/lines/invalid_lines}`（`CC_TRACE_APPLICATION.md:85-92`）
   是现成设计。
4. **永不折叠不完整的 JSON 行**：解析到最后一个 `\n`，残余半行留在 pending tail，下个
   tick 拼上（对应 `readModifiedFile` 的竞态处理）。
5. **「处理中被失效的结果必须丢弃」→ 并发安全规则**：增量 fold 开始前记下文件身份
   （offset + 生成计数器），提交前复查；中途 rewrite/rotation 则丢弃增量、回退全量。
   增量结果只在与「从零全折」等价时才允许落盘。
6. **只 watch 会话目录**，`add` 事件给新文件建独立游标 + 基线，`unlink` 丢弃状态
   （对应 `ensureWatchedFile`/`onFileAddUnlink`）。

**必须和 Vite 不一致的：**

- **ws 推送 → 原子写状态文件**。Vite 把 HMR payload 推给浏览器；我们无常驻浏览器客户端，
  「推送」=把更新后的 fold 原子写进 `today.json`/`month.json`（`state.py` 已有
  `_locked` + `_atomic_write`）。**批量点复用：每 tick 一次原子写，不是每事件一写。**
- **不需要 ModuleGraph**。我们 fold 无依赖边，不存在「失效传播给谁」；一个 session 只有
  一个消费方（它的折叠累加器）。Vite 的 `fileToModulesMap`/importer 递归/软硬失效整套
  都不要。学的是流水线**形状**（基线→事件→门卫→增量或全量→落状态），不是图结构。
- **增量路径不许是「另一条产生不同输出的快路」**。Vite 的软失效输出与全量本来就不同
  （重写 `?t=`），dev server 无所谓；我们的增量 fold **必须与全量重折逐字节相同**——
  增量 = 同一个纯函数作用在更多事件上，绝不另写实现。差分测试钉死：
  `fold_resume(checkpoint, new) == fold(all)`，用现有 fixtures 先写这条测试再写 watcher。

**不能借的（破坏确定性）：**

- **墙钟进输出**。Vite 的 `?t=`/`lastHMRTimestamp` 把当前时刻烤进产物；我们 fold 的时间
  只许来自事件的 `time` 字段。防抖若做成「按时间合并写入」会让 fold 依赖墙钟——必须用
  偏移游标合并，不用 timer。
- **zstd 源不能按字节续**。本机 DSH 会话是 `session.jsonl.zstd`，而 `src/dsh.rs:4-5` 只认
  裸 `.jsonl`。压缩/非 append-only 源无法按偏移 resume。**实时审计第一版要么让 DSH 执行环境
  以 `compression:'none'` 落盘，要么先做 Codex 侧**（Codex 是明文 JSONL，字节偏移最简单）。

### 第一步（甚至不需要 watcher）

> **先写 resumability 差分测试**（`fold_resume(checkpoint@turn边界, events[k..]) ==
> fold(events[0..n])`），输入用现有 fixtures 的明文 `.jsonl`，Python↔Rust 各一侧。
> checkpoint 只从 turn 边界起（§10.2 硬约束，`RUNTIME_EVIDENCE_CONTRACT.md:441-483`）：
> 同 `(turn,step)` 去重槽 `last` 不跨 turn 命中（`usage.rs:402-415`），但 `active`/
> `providers`/`sequence`/`seen[]` 跨 turn 延续，必须进 checkpoint。
> 然后实现字节谓词门卫（纯函数，可单独单测）。**watcher 最后做。**

---

## 4. 吸收 ③：目标是一等对象（`Environment` → `DeliverySurface`）

### Vite 的机制

- **`Environment` 是运行时一等对象**：命名（`config.environments: Record<string, …>`，
  `config.ts:762`）+ 通用判别量（`consumer: 'client'|'server'`、`isBundled`，
  `config.ts:1005-1012`）+ **config Proxy overlay**（环境专属 options 命中优先、否则落回
  共享层，`baseEnvironment.ts:47-60`）+ 按环境插件过滤（`applyToEnvironment`，
  `plugin.ts:404-425`）+ 按环境 state（`perEnvironmentState` WeakMap，`environment.ts:20-31`）。
- **目标差异从通用判别量 derive，不硬编码目标名**：`resolveBuildEnvironmentOptions` 根据
  `consumer` 派生 `minify`/`ssr`/`emitAssets`（`build.ts:455-464`）。共享层只有「位置/
  消费者」这类通用轴，没有「这个目标叫 ssr 所以…」。
- **共享还是独立是显式开关**：build 默认 `sharedConfigBuild: false`——每环境重新 resolve
  一份 config（`build.ts:1929-1964`），不是隐式巧合。

### 映射到我们

- **同构判定**：我们的「一份 fold，三投递面」与 Vite「一份 config+插件，dev/build/ssr
  各取用」是同一问题的**对偶**：Vite 在计算侧参数化（每环境 derive 自己的 transform
  管线），我们在渲染侧参数化（fold 算一次，DSH tab / HTML / Tauri 各自渲染）。
  **注意 Vite 的 `Environment` 对应我们的投递面，不是执行环境**——执行环境是 fold 上游的证据源，
  对应 Vite 的「源码/文件系统」。
- **我们差的一步**：有「一等投影」（DSH 侧 11 个 `sessionProjection`），但没有「一等
  投递面」——HTML/Tauri 作为另外两个投递面，没有一个类型承载「它们是谁、订阅哪几个投影、
  渲染上覆盖什么」，只能各写各的代码路径。「一份 fold 三投影」停在
  `DELIVERY_ARCHITECTURE.md:80` 的口号层面，没落成类型。
- **第一步：渲染 overlay**。`dsh-client/src/harness/index.ts` 各 `view()` 里内嵌的渲染策略
  （`costReportFrom` 的 `currency`/`estimate_disclaimer`，`harness/index.ts:186-234`；
  `completeIf` 的 partial 语义，`harness/index.ts:36-38`；`session_id` 注入，
  `harness/index.ts:579-581`）抽成一个「每面可覆盖的 policy 对象」，让 HTML/Tauri 复用同一
  fold 结果 + 各自 overlay。不碰 core、不碰 golden、不碰定价——纯投递面重构，却把口号
  变成代码事实。
- **把「这个投影在哪个投递面可用」收敛成谓词**：现在是散在 11 个投影里的手写 Set
  （`harness/index.ts:421-440`，`carriesUsage` `412-418`）；Vite 比我们多的一步是把它做成
  「解析期对每个环境显式求值」的谓词。

### 必须不抄的：Vite 的向后兼容 shim

Vite 顶层 `ssr` 字段 merge 进 `environments.ssr`、环境内 `resolve` 又 merge 回顶层
（`config.ts:1635-1776, 2210-2215`）——这是「目标专属字段渗出共享层」的活标本。我们若照
抄成「加一个 `dsh` 顶层配置段、默认流进 DSH 投递面」，就正好犯「core 不许有执行环境词表」
铁律。**overlay 只能改渲染层，不许改变 fold 的字节输出**（与「投递面不碰计算」一致）。

---

## 5. 必须反着来的：三态语义（静默跳过 = 编造）

Vite 的 `filter` 不匹配就 `continue`——对构建工具是对的（不该 css 管 ts）。**对审计是
错的**：一个缺 approval 事件的执行环境若静默跳过审批规则，等于报 `measured-zero` 而不是
`Unavailable`。

- 我们的 `RuleOutcome::Unavailable { missing, reason }`（`evidence.rs:350-357`）和 §10.4
  三态必须保留，**不能学 Vite 的「跳过」**。这是收敛 spec 不变式 #3，也是 Phase B 验收里
  「审批类规则必须报 `Unavailable`，绝不允许安静报 `[]`」的原因。
- `missing: Vec<Signal>` 是结构化归属（比 Vite 打字符串 plugin name 更强）——Vite 的
  `_formatLog` 只把错误归属到 `plugin.name`（`pluginContainer.ts:925-935`），我们的
  `missing` 直接列出「缺哪几个 Signal」。

---

## 6. 不借鉴清单（为什么）

| Vite 机制 | 为什么不借 |
|---|---|
| ModuleGraph / 依赖失效传播 | 我们 fold 无依赖边，一个 session 一个消费方；学图结构是过度设计 |
| 墙钟进产物（`?t=`/HMR timestamp） | 破坏 byte-identical；fold 时间只许来自事件 `time` 字段 |
| 插件注册/调度/排序框架整套 | 9 模块 × 2 语言凭空多一层样板；detector 就一个 `fn(&CanonicalSession) -> RuleOutcome`，「插件列表」是数组、注册是数据不是机制 |
| `enforce`/`order` 排序分档 | 我们 detector 互相独立，各自声明 `requires` 就够；顺序不影响三态正确性 |
| 向后兼容 shim（顶层字段 merge 进环境） | 「目标专属字段渗出共享层」的活标本，照抄即犯 §12 |
| `apply` 的 serve/build 场景过滤 | 我们已有更硬的 `RuleSpec.requires` 前置条件语义 |

---

## 7. 落地顺序（和收敛 spec 对齐）

```
Phase A  timeaxis 统一          —— 独立，先落（低风险消重复）
   │
Phase B  detector 新输入契约    —— 本研究的直接产出：
   │        · 选「扩 CanonicalSession 挂 Timeline<Observed<T>>」，
   │          不选「规范化事件中间层」     （§8 理由）
   │        · 第一刀 = 先滤后调（§2），族①先做，golden 逐字节不变
   │        · 删 reverse_project 是最后一步
   │
Phase C  wasm 边界上移           —— 依赖 B
   │        · canonicalize 收进 core，wasm 导出（避免 dsh-client TS 第四个副本）
   │        · 审计 tab 多执行环境化 = 引入 DeliverySurface（§4）
   │
watch 实时审计                  —— 与 A/B/C 正交，可并行
        · resumability 差分测试 → 字节谓词门卫 → watcher（§3）
        · 先解决源：DSH 落明文 or 先做 Codex
```

### Timeline 的 T 必须是什么（新增的硬约束）

`Timeline<Observed<T>>` 的 T **不得是 `Value`**，必须是执行环境无关的窄类型（如
`ToolCall { name, arguments }`）；执行环境特有残余走 `evidence.rs:412` 规定的不透明 payload。
若 T = `Value`，执行环境字段会原样透传回来，§12 白守（`shared_type_layer_has_no_harness_
identifiers_in_code`，`evidence.rs:534-561`）。canonicalize 收进 core 并在 wasm 导出，
TS 侧只做 raw → wasm → render，规则逻辑降为零。

---

## 8. 为什么选 `Timeline<Observed<T>>` 而不是「规范化事件中间层」

1. **Vite 从不造「万能源文件格式」**。管线传 `code:string`，但从不把 CSS/Vue/wasm 统一成
   一个规范化 schema；类型知识靠插件 filter 声明 + handler 内部消化。方案 B 的「规范化
   事件」正是造一个巨型 NormalizedEvent schema 让所有执行环境往里塞——就是 `evidence.rs:412`
   明确警告的「每执行环境怪癖的并集」。
2. **A 精确对应 Vite 的三件套**：统一钩子参数（`detect(&CanonicalSession)`）+ 声明式门控
   （`RuleSpec.requires` ≈ filter）+ 类型化明细（`Timeline<Observed<T>>` ≈ moduleType/
   ModuleNode）。§10.2 的图本来就画了 `Signal → Timeline<Observed<T>>`，A 是实装已设计
   字段，不是发明。
3. **A 的同步税更低且随执行环境数不变**：`Signal` 枚举已固定 19 个变体；新执行环境只是往已有
   Signal 的 timeline 里填数据，Signal 集合和 detector 都不变。B 每加一个执行环境都要扩事件
   枚举 + 迁移所有 detector，是随执行环境数增长的税。
4. **§12 护栏在 A 下更有意义**：A 的 T 是中性窄类型、由适配器填充，护栏直接守住；B 的
   schema 更大，执行环境字段更易渗漏。

---

## 9. 关键文件索引

**Vite**（`/tmp/vite`，浅克隆，勿作持久引用）：`packages/vite/src/node/plugin.ts`（enforce/
apply/filter 声明）、`node/plugins/index.ts`（结构性排序 + filter 编译）、
`node/server/pluginContainer.ts`（先滤后调）、`node/config.ts`（apply 预滤 / environment
派生）、`node/environment.ts` + `baseEnvironment.ts`（Environment 一等对象 + Proxy overlay）、
`node/server/{moduleGraph,transformRequest,hmr}.ts`（失效/HMR 门卫）、`node/watch.ts`、
`node/build.ts`（sharedConfigBuild 显式开关）。

**我们**：`crates/agent-vitals-core/src/contracts/evidence.rs`（RuleSpec:336 / RuleOutcome:350 /
CanonicalSession:413 / §12:534）、`behavior.rs`（rule_outcomes:462）、`dsh_evidence.rs`
（derive_coverage:72 / reverse_project:197）、`usage.rs`（替换语义:402）、
`dsh-client/src/harness/index.ts`（costReportFrom:186 / carriesUsage:412 / apply:421-440）、
`docs/RUNTIME_EVIDENCE_CONVERGENCE_SPEC.md`、`docs/DELIVERY_ARCHITECTURE.md`、
`docs/CC_TRACE_APPLICATION.md`（ScanBatch:85-92）、`docs/RUNTIME_EVIDENCE_CONTRACT.md`
（§10.2:441-483）。
