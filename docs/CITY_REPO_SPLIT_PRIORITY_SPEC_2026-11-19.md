# Miami City 拆仓优先级与时序 SPEC

> 日期：2026-11-19  
> 状态：Proposed，等待评审后实施；**本文档取代 `CITY_BUILTIN_GAMES_SDK_MIGRATION_SPEC_2026-11-19.md` §9 的实施时序**，该 spec 的归属矩阵（§4）、SDK 口子（§5）、防回归机制（§8）、验收词表继续有效  
> 适用范围：Agent City（apps/agent-city 全目录）、Desktop 打包链、主仓脚本与测试基础设施、city-game-sdk / agent-vitals-city-sdk / city-game-runtime  
> 决策问题（2026-11-19 评审提出）：**是否应该优先迁移迈阿密 City（项目拆仓），而不是先外置四个内置游戏？**

## 1. 问题定义：两种"迁移"必须先分开

"迁移迈阿密 city 代码"在本次评审中实际指两件不同的事，前置、风险、收益完全不同：

| | **A. City 项目拆仓** | **B. 游戏包外置** |
|---|---|---|
| 内容 | `apps/agent-city`（ui + mcp + relay + worlds 四个子目录）整体迁到独立 GitHub 仓库；主仓打包时按 pinned ref 拉取源码构建，产物进 `plugins/AgentCity.plugin/ui/`，**行为与现在逐字节等价** | 四个 Miami 活动（flight/driving/mecha/cinema）从 City 源码中改写为 sealed build 游戏包，经 `city_game_install` 安装运行（`CITY_BUILTIN_GAMES_SDK_MIGRATION_SPEC` PR-04~08） |
| 性质 | **机械搬迁**：改路径、改打包编排、改 CI；代码本身零改动 | **行为等价迁移**：SDK 口子补齐 + 代码改写 + 等价基线验证 |
| 风险 | 低（构建产物一致性可自动校验） | 中高（帧序敏感的等价性、mecha 远程边界、stateKeys 迁移） |
| 收益 | City 获得独立迭代与发版权；主仓瘦身；原始诉求达成 | 消除内容分支；游戏可独立更新；接入统一安装模型 |

## 2. 依赖链与阻塞项（2026-11-19 代码调研结论）

### 2.1 拆仓的阻塞项

| # | 阻塞项 | 现状证据 | 归属 |
|---|---|---|---|
| S1 | creator-studio 相对路径 import agent-city 源码 | `apps/creator-studio/ui/src/main.tsx:21-26`、`cityPlanPreflight.ts:1-3`、`contentSnapshot.ts:3`；vite.config.ts fs.allow + three alias 特例 | 拆仓前必须解（= migration spec PR-02 的一部分） |
| S2 | plugins.json source 校验只认仓内路径 | `scripts/official-plugins.mjs:20` 正则 `^apps/[a-z0-9-]+/ui$` | 拆仓 PR 内改 |
| S3 | 打包编排从仓内源码构建 | `scripts/prepare-desktop-bundle.mjs:36-44`（npm ci agent-city → buildOfficialPlugins） | 拆仓 PR 内改（pinned ref 拉取） |
| S4 | **主仓 105 个文件引用 `apps/agent-city` 路径**（2026-11-19 grep 实测，排除 node_modules/target） | `scripts/verify-city-*.mjs`、`scripts/verify-mecha-*`（约 40+）、`tests/mecha-*.test.ts`、`evals/creator/run.mjs`、`tools/build-city3d.mjs`、`docs/app-layer-inventory-v1.json`；Rust 侧仅 1 处文档注释（`crates/agent-vitals-query/src/query/city_building.rs:32`） | 拆仓 PR 内按归属迁移或改路径 |
| S5 | 测试基础设施双向依赖 | agent-city/ui package.json 大量 verify 脚本引用 `../../../scripts/mecha-ts-register.mjs`、`../../../scripts/verify-mecha-*`；tests 分散在主仓 `tests/` 与 `apps/agent-city/ui/tests/` 两处 | 拆仓 PR 内拆分：city 专属脚本随仓，通用基础设施留主仓 |
| S6 | 子目录归属未决 | `apps/agent-city/{mcp,relay,worlds}`：relay 是独立 Cloudflare Worker（wrangler.jsonc）；worlds/miami 是世界数据；mcp 是 city-game/mecha MCP 脚本 | 本文 §5.1 定案 |

### 2.2 游戏外置的阻塞项

- SDK 三个口子（scene/camera port、surface 纯库下沉、storage.game 实现）——即 migration spec §5.1~5.3，**与 S1 同属 PR-02**；
- mecha 远程对战口子（单独 RFC，不阻塞其他游戏）。

### 2.3 关键结论：两者的前置几乎重合

migration spec 的 **PR-01~02（防回归测试 + SDK 扩展 + creator-studio 解耦）同时是 A 和 B 的前置**。PR-03（引擎剪反向依赖）不是拆仓的硬前置（game/ 目录随 City 一起搬迁），但建议拆仓前完成——完成后引擎与 SDK 的契约面即收敛，拆仓后的跨仓协作是稳定接口上的协作，而非持续契约 churn。

## 3. 时序对比

### 时序 A：游戏优先（migration spec §9 原样）

```
PR-01~03（主仓：测试+SDK+引擎剪依赖）
  → PR-04~07 在主仓逐个外置四游戏（高风险等价迁移，主仓内原子提交）
  → PR-08 拆仓（city 已瘦身后整体搬迁）
  → PR-09 打包验收
```

- 优点：等价迁移发生在主仓（回滚即时）；拆仓时内容已外置，搬迁面小。
- 缺点：**拆仓目标推迟到约 7 个 PR 之后**；PR-08 的搬迁发生在大量内容 churn 之后，git 历史跨仓映射复杂；主仓长期维持"中间态目录结构"。

### 时序 B：City 优先（本文档建议）

```
阶段 A  PR-01~03（主仓，共享前置，与 migration spec 相同）
阶段 B  PR-S  City 拆仓（机械搬迁，零行为变化，§5）
阶段 C  PR-04'~08' 游戏外置（在 city 仓 ↔ games 仓 ↔ 主仓 SDK 之间，migration spec PR-04~08 内容重排）
阶段 D  PR-09' 打包环境验收（合并拆仓与外置两项验收）
```

- 优点：
  1. **原始诉求（City 独立迭代）尽早达成**，不被游戏迁移的长周期阻塞；
  2. 拆仓零行为风险，先锁定成果；
  3. **避免双重 churn**：先整体搬迁、再做内容改动，git 历史随目录一次性映射，不出现"改完再搬"的历史割裂；
  4. 主仓与 city 仓的职责从拆仓第一天起就是终态（主仓=平台+宿主+SDK+引擎，city 仓=City 应用壳+世界与主题内容），不再有中间态。
- 缺点与缓解：
  1. 阶段 C 的高风险等价迁移变为跨仓操作 → **缓解**：PR-02 已把 SDK 契约定义完毕，迁移期 SDK 按固定版本 pin；GR-04 等价基线在 games 仓对 pinned city commit 运行；city 仓独立 CI 保证每次契约升级前主仓先行合入。
  2. S4 的 105 处路径引用需一次性处置 → **缓解**：机械替换 + 在 CI 增加"主仓零 `apps/agent-city` 路径残留"检查（见 §7 AC-4）。

## 4. 结论

**是的——优先迁移迈阿密 City，但严格排在共享前置（PR-01~03）之后，而不是代替它们。**

理由：

1. 两个方向的前置重合，先做 PR-01~03 不存在浪费；跳过前置直接拆仓会立刻被 S1（creator-studio 断链）与 S3（打包链）卡住。
2. 拆仓是低风险机械工程，先行完成可锁定结构性收益；高风险的游戏等价迁移放最后，失败也不影响已落袋的拆仓成果。
3. 时序 B 消除了时序 A 的历史割裂问题：内容 churn（游戏外置）全部发生在 city 仓内或 games 仓内，主仓从此不再承载 City 内容的任何改动。

**明确的否决项**：不做"未完成 PR-02 就拆仓"的捷径——那会把 creator-studio、打包链、105 处脚本引用同时置于破损状态，等于把机械搬迁变成大爆炸重构。

**归属修订（2026-11-19 二次评审）**：CityEngine 不随拆仓外移——按信任边界原则留在主仓，升格为平台包 `packages/city-engine`（可信计算基与 SDK 同仓演进）；city 仓收窄为 City 应用壳 + 世界数据 + 主题 skin pack（含自引擎迁出的城市纹理/flora 资产）。归属依据见迁移 spec §3.2/§5.2。

## 5. City 拆仓实施清单（新 PR-S）

### 5.1 仓库范围与子目录归属

| 内容 | 去向 | 理由 |
|---|---|---|
| `apps/agent-city/ui/src/engine/`（含 `viewport/`） | **主仓 `packages/city-engine` 平台包** | 可信引擎属信任计算基，不外移（二次评审修正）；与 SDK 同仓演进，Studio 包化消费 |
| `apps/agent-city/ui/` 其余应用壳（CityApp/CityExperience/面板/preview 等，含 `src/game/` 过渡期暂留） | city 仓 | 应用内容层；游戏外置（阶段 C）时逐步移出到 games 仓 |
| 引擎默认城市纹理与 flora（`assets/*.jpg` ~1.9MB、`assets/flora/` 304KB） | city 仓（主题 skin pack 资产） | Miami 风味内容不进平台包；引擎留中性默认 + 加载器 |
| `apps/agent-city/worlds/miami` | city 仓 | 世界数据随世界生成器 |
| `apps/agent-city/relay/` 的协议与 Worker 代码（protocol.ts + worker.ts + tests） | **主仓平台层**（如 `infra/app-remote-relay/`） | 通用 app-remote 中继基础设施，裁决依据见 §5.1.1 |
| relay 的城市部署配置（worker 名/路由、capability 政策、assets 来源） | city 仓部署配置 | 城市仅提供部署参数，不拥有中继代码 |
| `apps/agent-city/mcp/`（city-game-mcp / mecha-mcp / experienceStore / releaseStore） | **games 仓**（阶段 C 随游戏迁移），终态并入主仓通用 sealed-build harness | 游戏内容 harness，裁决依据见 §5.1.2；主仓 MCP（crates/agent-vitals-mcp）不受影响 |
| city 专属 verify 脚本（verify-city-*、verify-mecha-*、verify-plan-repair-* 等） | city 仓 `scripts/` | 随被测代码 |
| 通用基础设施（run-npm.mjs、official-plugins.mjs、prepare-desktop-bundle.mjs、mecha-ts-register.mjs*） | 主仓；mecha-ts-register 属边界案例，随 mecha 测试主体迁 city 仓、主仓保留转发桩一个版本 | 避免双份漂移 |
| `tests/mecha-*.test.ts`（主仓 tests/ 下被 agent-city 引用的） | city 仓 `tests/` | 随被测代码；主仓 golden/parity 测试不动 |
| 主仓保留 | host src-tauri、SDK 三包、creator-studio、CLI、catalog、desktop ui-dev | 平台层 |

### 5.1.1 relay 归属裁决：通用基础设施上移平台层（2026-11-19 评审修正）

初稿将 relay 归入 city 仓，评审修正为平台层。代码证据：

- `relay/protocol.ts` 全文为通用 `app-remote:v1` 协议：`Scope { appId, sessionId, capability }`、host/owner/guest 角色、RoomRecord/AccessRecord/TicketRecord、通用 capability 解析——**零城市业务类型**；
- `relay/worker.ts`（428 行）实现的是通用中继语义：房间生命周期、host 租约、孤儿房间回收、访问审批、票据过期、限速、WebSocket 扇出，以及"只持久化短生命周期授权元数据、消息体内存中转"的持久化策略——即 AGENTS.md 第 7/8 条对中继的约束，且以 app 无关方式实现；
- 城市专属项仅有三处**配置级**内容：`dreamCapability = "city-dream:v1"` 访客上限常量、worker 名与路由（`agent-city-mecha-relay` / relay.ohagent.ai）、assets 绑定托管 `../ui/dist`。

落地方式：中继代码进主仓平台层（`infra/app-remote-relay/`），capability 政策与 assets 来源改为部署配置注入；city 仓只保留一份部署配置（平台 Worker 版本 pin + 城市 capability 清单 + assets 指向），与 `builtin-city.json` 的"平台代码 + 配置文件"模式同构。这也与隔离 spec"City 远程是独立版本化 face"的定位一致：**多应用中继基础设施不归单一应用所有**。

**部署耦合待解项**：当前 relay 的 assets 绑定直接托管 `../ui/dist`（中继域名同时服务城市远程页面），意味着城市 UI 每次发布都牵动中继部署。上移平台层时必须解开：远程页面资产改走独立发布渠道（release channel / CDN），或城市侧部署配置以 pinned dist 输入组合平台 Worker。未解开前 relay 不得迁移（见 §8 R4a）。

### 5.1.2 mcp 归属裁决：游戏内容 harness 随游戏走，不进 city 仓（2026-11-19 评审修正）

与 relay 相反，`apps/agent-city/mcp/` **不是**通用逻辑：

- `city-game-mcp.mjs` 直接 import 游戏仿真核心：`../ui/src/game/FlightSimulation.ts`、`DrivingSimulation.ts`、`game/activity/mountedMiniGame.ts`、`engine/worldScale.ts`；`mecha-mcp.mjs` 直接 import `game/mecha/rules.ts`、`sequentialTurn.ts`、`ai/sequentialAutoBattle.ts` 等——它们是绑死 Miami 玩法实现的 agent 无头试玩 harness（其文件头自述"沿用 mecha-combat MCP 的惯例"：**模式**通用，**实例**是内容）；
- 阶段 C 游戏外置后，这些 import 目标离开 city 仓，harness 留在 city 仓必然悬空。

落地方式：阶段 C 时随对应游戏迁入 games 仓（作为各游戏的 agent 试玩 harness）；终态由主仓**已有的**通用 sealed-build harness 取代——`scripts/code-game-mcp-cli.mjs`（经宿主 MCP 驱动 sealed build）与 `packages/city-game-sdk` 的无头运行器 `previewGame.ts` 已经是同一模式的平台实现。通用部分（stdio 会话循环、输入词表归一、trace 摘要）届时并入平台 harness，游戏只贡献输入词表等数据。`experienceStore/releaseStore` 随 harness 同迁，不单独归属。

### 5.2 主仓侧改造

1. `plugins.json` city 条目增加外部源声明：`source` 保留语义扩展为 `{ repo, ref, path }` 或新增 `externalSource` 字段；`official-plugins.mjs` 校验同步扩展（S2）。
2. `prepare-desktop-bundle.mjs`：拉取 pinned ref（git clone --depth 1 + tag 校验）→ npm ci → 构建 → 产物 digest 记录进 `apps/desktop/builtin-games.json` 同级的 `builtin-city.json`（记录 ref + dist 树 sha256，CI 复核）。
3. `debugProbeMarker` / isolation probe 脚本适配新布局。
4. S4 的 105 处引用按 §5.1 归属迁移或改指 city 仓 checkout 路径（CI 辅助脚本以环境变量 `AGENT_CITY_REPO` 定位，模式沿用现有 `AGENT_VITALS_REPO`）。
5. CI：Verify 工作流增加"拉取 city pinned ref 构建 AgentCity.plugin 并比对 digest"步骤；主仓合并门槛含拆仓一致性检查。
6. 引擎升格 `packages/city-engine` 平台包在 PR-02/03 内完成（本就属主仓），拆仓仅搬迁应用壳——SP-AC2 的 dist 逐字节一致验收口径不变（应用 dist 内嵌引擎代码，引擎升级 → digest 更新 → 单行配置 PR）。

### 5.3 city 仓侧建设

1. CI：构建 + verify 脚本矩阵 + relay 部署检查；产物（dist）供主仓 pinned 消费。
2. 消费主仓 `city-engine` 平台包与 SDK 三包：git 依赖或 npm registry，版本 pin 策略（迁移期锁 patch 版本，契约稳定后改 semver）。
3. 版本与发布：city 仓独立版本号；主仓 `builtin-city.json` 记录每次升级的 ref，升级 = 主仓单行 PR + CI digest 复核。

### 5.4 零行为变化验收

拆仓 PR 的验收口径是**构建产物逐字节一致**：拆仓前后各构建一次 AgentCity.plugin dist，对比文件清单与内容 hash；有差异即拆仓引入了行为变化，按缺陷处理。唯一允许的差异是构建工具链注入的路径注释/指纹，需逐项列明。

## 6. 阶段 C 的时序重排（游戏外置）

migration spec PR-04~08 的内容不变，执行位置调整：

| 原编号 | 调整后 | 变化 |
|---|---|---|
| PR-04（cinema） | PR-04' | 在 city 仓内实施（cinematic 数据外置到 games 仓 miami-cinema 包） |
| PR-05（mecha） | PR-05' | 同上；远程对战仍留宿主（R1 不变） |
| PR-06（flight） | PR-06' | 同上 |
| PR-07（driving） | PR-07' | 同上 |
| PR-08（拆仓+预置安装） | PR-08' | 拆仓已由 PR-S 完成；本 PR 只做：`builtin-games.json` 预置安装接线 + 活动入口读注册表 + 删除 city 仓内 miamiActivityHost/Entries/InteractionRuntime/builtin.ts Miami 目录 |
| PR-09（打包验收） | PR-09' | 合并 PR-S 与 PR-08' 的打包验收（无 Node/无源码全链路） |

GR-01（零 miami 扫描）的范围相应调整：主仓 packages/ 与 src-tauri/ 在 PR-03 后即应转绿；city 仓 engine/ 在 PR-08' 后转绿。

## 7. 验收标准

| ID | 场景 | 必须证据 |
|---|---|---|
| SP-AC1 | 前置完成 | PR-01~03 全部合入：GR-01 在主仓范围转绿；creator-studio 无 agent-city 相对路径 import |
| SP-AC2 | 拆仓产物一致 | 拆仓前后 AgentCity.plugin dist 文件清单与内容 hash 一致（§5.4 允许清单除外） |
| SP-AC3 | 打包含 pinned ref | `builtin-city.json` 记录 ref + dist sha256；CI 改动 ref 或 dist 任一项即失败 |
| SP-AC4 | 主仓零残留 | 主仓源码/脚本/CI 零 `apps/agent-city` 路径引用（文档与 inventory 除外，需标注指向 city 仓） |
| SP-AC5 | 双仓协作 | 主仓 SDK 契约变更先合入，city 仓按 pin 升级；演练一次完整升级链路并留痕 |
| SP-AC6 | 开发体验 | 主仓与 city 仓各自 `npm ci && npm run build`、verify 脚本矩阵独立通过；平台 relay CI 独立通过，city 仓部署配置可完成中继部署（R4 解耦后） |
| SP-AC7 | 回退 | 删除主仓对外部源的拉取、恢复仓内源码构建，一次提交可回退 |
| SP-AC8 | 阶段 C 验收 | migration spec §11 MG-AC01~12 在新布局下全部通过 |

## 8. 风险

- **R1 跨仓契约 churn 提前化**：阶段 B 后任何 SDK 契约改动都是双仓流程。缓解：PR-02 一次性定义契约面（scene/camera port、surface、storage）；迁移期 pin 固定版本；契约收敛前不启动阶段 C。
- **R2 105 处引用的迁移遗漏**：以 SP-AC4 的 CI 残留检查兜底；`docs/app-layer-inventory-v1.json` 类文档引用不阻塞但需标注。
- **R3 测试基础设施拆分争议**：mecha-ts-register/verify-mecha-* 同时服务两仓的可能性 → 按"随被测代码"原则裁决，边界案例（R3a：mecha-ts-register）主仓保留转发桩一个版本。
- **R4 relay 迁移前置**：relay 代码上移平台层前必须先解开 assets 部署耦合（当前中继域名直接托管 `../ui/dist`，城市 UI 发布牵动中继部署）——**R4a**：未完成资产渠道解耦前 relay 不迁移，城市远程页面行为不变；R4b：capability 政策（city-dream 访客上限等）从常量改为部署配置时，行为必须逐项等价（有 relay tests 兜底）。SP-AC6 改为验证：平台层 relay CI 独立通过 + city 仓部署配置可部署。
- **R5 与在途工作的冲突**：当前工作区有未提交的 preview 隔离改动（`source` 键等）；PR-S 必须在在途 PR 合入后启动，避免路径迁移与功能改动叠加。
- **R6 阶段 C 的等价基线跨仓**：GR-04 需要旧实现（city 仓 pinned commit）与新实现（games 仓）对比，games 仓 CI 引擎需能拉取 pinned city commit——拆仓时一并建设。

## 9. 迁移要求汇总

- 先后顺序不可调换：**PR-01~03 → PR-S（拆仓）→ PR-04'~08'（游戏外置）→ PR-09'（验收）**。
- 拆仓 PR 是纯机械工程：代码零改动、产物逐字节一致、可单提交回退。
- 主仓此后对 City 内容的唯一合法引用是 `builtin-city.json`（ref + digest）；后续 `builtin-games.json`（游戏包）沿用同一模式，两者构成"打包默认包含"的统一配置面。
- migration spec 的归属矩阵、SDK 口子、防回归机制、错误词表、MG-AC 验收词表全部继续有效；其 §9 时序由本文档 §6 取代。
