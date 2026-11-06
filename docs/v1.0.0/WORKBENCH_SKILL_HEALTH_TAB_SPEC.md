# 工作台「Skill 体检」tab 需求规格

状态：草案（2026-09-18）。目标版本：v1.0.0-beta.3（桌面 app `apps/desktop/src-tauri`）。
关联：[SKILL.md](../../SKILL.md) §1/§5、[README](../../README.md)「Harness compatibility」、
[BETA_1_SETTINGS_PAGE_SPEC.md](BETA_1_SETTINGS_PAGE_SPEC.md)（表单/按钮/文案通用规则沿用）、
[BETA_1_OVERVIEW_IA_REVIEW.md](BETA_1_OVERVIEW_IA_REVIEW.md)。

---

## 0. 一句话结论

**不打破「一次一个执行环境」的规则，但把它说准：规则禁止的是跨执行环境*合并*（把预算相加、
跨执行环境算冲突/重叠、给一个"僵尸总数"），不禁止跨执行环境*并列*（一屏之内按执行环境分栏、每条
发现带执行环境标签）。** 新 tab 采用"并列不合并"：默认一屏看全部执行环境，每个执行环境一张摘要卡 +
一份带执行环境标签的发现列表；只有本规格 §3.5 白名单里的量允许出"总计"，预算、冲突、重叠、
僵尸永远不出跨执行环境的单一数字。这与工作台已经在金额面执行的"分币分栏永不相加、token
面恒全量"是同一条纪律，不是新发明。

---

## 1. 目标与判断标准

**目标**：让用户在桌面 app 里回答"我装的 skill 有没有问题"，与 CLI `doctor` 同一套事实
和同一套 SV 码，不长第三份判定逻辑。

**判断标准**（任何设计取舍按这四条裁）：

1. **同源**：tab 显示的每一个数字、每一条 SV 发现，都能在 `agent-vitals doctor --json`
   的输出里逐字找到出处。tab 不重新测量、不重新判定（`apps/cli/src/skills/doctor.rs:1-6`
   对 CLI 层立的规矩，对 tab 同样成立）。
2. **不编数**：执行环境没有描述预算就不画预算条；探测不到运行时证据就报 `null` 不报 0；
   `doctor` 的 `!` caveat 和 "Not assessed" 段原样带出（SKILL.md §2 第 28 行）。
3. **不越权**：SKILL.md §3 列出的"由模型/人判断"的码（SV401 语义重叠、SV501–508 逐行
   复核、SV101/103 该谁生效、SV201/202 是真死还是没被选中）在 tab 里只能呈现为
   "需你判断"，绝不能标成"程序判定"——与账单确认列表的三态措辞（程序判定 / 已知 /
   缺少证据）同一套纪律。
4. **不拖慢总览**：扫描是文件系统遍历 + 可能拉起 `codex app-server`（
   `crates/agent-vitals-harnesses/src/harnesses/codex/sources/skills.rs:7`），秒级开销；它**不进
   总览那一批并发命令**（2026-09-05 tab 卡顿事故的教训，CLAUDE.md「性能形状」）。

---

## 2. 现状（证据）

- 桌面 app 只有 5 个 tab（总览 / 用量 / 会话 / 待处理 / 设置，`workbench.html:13-16`），
  没有任何 skill 体检入口；在 `workbench.js` / `workbench.html` / `lib.rs` 里搜
  `SVnnn`、`zombie`、`overlap`、`description budget` 零命中（`lib.rs:1471` 的 "doctor"
  指的是数据层的 `data-status`，同名不同物）。
- skill 扫描的全部核心逻辑已经是库：发现/分类/安全扫描在
  `agent_vitals_runtime::skills::{scanner, inventory, security, snapshot}`（v0.8 Phase
  E7.5/E7.6），执行环境适配器在 `agent_vitals_harnesses::harnesses::<h>::{skills, sources::skills}`。
  `apps/cli/src/skills/` 自述"只剩调 runtime service → 渲染的 CLI 层"（`mod.rs:1-10`）。
- **但两块判定逻辑还在二进制 crate 里**，库 crate 拿不到：
  - `apps/cli/src/skills/report.rs::build(&ReportInput) -> Report`（Inventory → 报告
    JSON：预算/冲突/僵尸/harness_summaries）；
  - `apps/cli/src/skills/doctor.rs::diagnose(&doc, split_threshold, overlap_min) -> Vec<Value>`
    （报告 → SV 码诊断；与 Python `doctor.py` 逐字节对齐，
    `tests/test_doctor.py::TestBothImplementationsRenderIdentically`）。
- 桌面 app 已有成熟的"调 CLI 二进制取 JSON"通道：会话 tab 的 `sessions_read` /
  `sessions_findings` / `sessions_issues` 都是 `resolve_binary()` 后 `Command::new(bin)`
  （`apps/desktop/src-tauri/src/store.rs:38-90`），二进制按 `AGENT_VITALS_BIN` → PATH →
  `Contents/Resources/bin/` 解析（`store.rs:74`）。
- CLI 侧 `--harness` 默认 `all`（`apps/cli/src/main.rs:64-65`）；`all` 时报告带
  `harness_summaries`（按执行环境分栏的摘要，`report.rs:131-143`）并显式写一条
  `cross_harness_note`："Harnesses do not share context… do not interpret top-level Tier1 or
  description-budget values as a cross-harness total."（`report.rs:218-220`）——**扫描器
  自己早就是"并列不合并"的**，SKILL.md 的"一次一个执行环境"是给 Agent 写报告时的约束，
  不是数据层做不到。

---

## 3. 核心问题：要不要打破「一次一个执行环境」

### 3.1 这条规则到底约束什么

SKILL.md §1："Never combine context budgets or conflicts across harnesses — run one report
per runtime." README："skills from different harnesses are never combined into one context
budget or conflict set." 两处措辞一致，约束的是**三个由构造决定、只在单执行环境内有定义的量**：

| 量 | 为什么只在执行环境内有定义 |
|---|---|
| 描述预算分母 | 每个执行环境自己的预算（Claude Code 可配、Codex 官方 2%/8k、OpenClaw 可配、DSH 无全局预算→SV004、WorkBuddy/Hermes 不可用）。两个不同分母的百分比相加没有意义，有的执行环境根本没有分母。 |
| 覆盖优先链 | `enterprise > personal > project > plugin` 是 Claude Code 的链，OpenClaw 是 `workspace > project > personal > managed`（`report.rs:214-217` precedence_note）。跨执行环境没有"谁盖过谁"。 |
| 重叠竞争集 | SV401 只在"同一个执行环境、已加载"的 skill 之间算 Jaccard（README "among loaded skills within one harness"）：两个从不出现在同一个 system prompt 里的 skill 不可能互相抢触发。 |

规则保护的是**测量有效性**，不是"一屏只能出现一个执行环境"这种呈现形式。

### 3.2 逐 SV 家族的执行环境相关性

| SV 家族 | 含义 | 执行环境相关性 | 跨执行环境可否合计 |
|---|---|---|---|
| SV001 / SV002 / SV004 | 描述预算告警/溢出/逐条截断 | **分母属于执行环境** | ✗ 永不相加；每执行环境一根条，无分母的执行环境不画条 |
| SV901 | 能力不可用 | 属于执行环境 | ✗ 按执行环境列出 |
| SV101 / SV102 / SV103 | 被更新副本遮蔽 / 冗余副本 / 有意覆盖 | **关系属于执行环境内优先链** | ✗ 永不跨执行环境配对 |
| SV401 | 词法重叠候选 | **关系属于执行环境内已加载集** | ✗ 永不跨执行环境配对 |
| SV201 / SV202 | 零触发 / 休眠 | 证据属于执行环境（只有 claude-code `skillUsage`、dsh 会话日志有；其余不可用） | ✗ 不出"僵尸总数"；可按执行环境并列，标明哪些执行环境无证据 |
| SV301 / SV303 | 单次触发成本高 / 昂贵且未用 | 数字属于 skill，但"是否加载"属于执行环境 | △ 可按 skill 并列排序；不出跨执行环境 Tier1 总和 |
| SV501 – SV508 | 安全命中 | **属于文件**，与执行环境无关：一个恶意 skill 在哪个执行环境里都恶意 | ✓ 可按 `path` 去重后按严重度计数 |
| SV105 / SV902 | frontmatter 无效 / skill 不可读 | 属于文件 | ✓ 同上 |

结论直接从表里读出来：家族分三类——**分母类**（预算）、**关系类**（冲突、重叠）、
**文件类**（安全、结构）。前两类跨执行环境合并是编数，第三类跨执行环境合计是对的（同一个
`SKILL.md` 装在三个执行环境里，安全命中只有一条，不是三条）。SKILL.md 的规则只针对前两类。

### 3.3 与工作台既有聚合纪律的对照

工作台在金额面已经踩过一遍完全同构的坑并立了规矩（CLAUDE.md「v0.9 成本词表与计费
归属」）：

| 金额面（已定） | Skill 面（本规格） |
|---|---|
| 分币分栏永不相加（`HarnessAmount.amounts_by_basis` 一档一个数，USD+CNY 同桶相加就是编造） | 预算按执行环境分栏永不相加（分母不同、有的没有分母） |
| 权威归属在 `by_provider`，`by_harness` 是币种分栏旧口径 | 权威在 `harness_summaries`，顶层 Tier1/预算是"不要当总数读"的字段（`cross_harness_note`） |
| token 面恒全量（token 是同一个单位，跨执行环境可加） | 安全/结构发现按文件去重后可合计（一条发现是一条发现） |
| 费用明细行 = 服务商，执行环境降为"经 Claude Code、Codex"副属性 | 安全发现行 = skill 目录，执行环境降为芯片"装在 claude-code · codex" |

也就是说，本 tab 不需要新的聚合哲学，只需要把金额面已经验证过的"什么能加、什么只能
并列"照搬过来。**这正是不该"打破"规则的理由：规则和工作台其它部分是一致的，打破它
反而会让 Skill tab 成为整个 app 里唯一一处把不同分母相加的地方。**

### 3.4 用户任务视角

- 用户机器上同时有 4–6 个执行环境（截图：「4 个来源正常」；skill 扫描执行环境还多 openclaw /
  hermes 两个）。tab 要回答的是 `doctor` 的问题——"有什么需要我处理"——如果每次只能看
  一个执行环境，一个一眼能答的问题变成 6 次点击，且与总览页"跨执行环境一屏"的心智不一致。
- README「Install」一节**推荐**把同一个 skill 目录克隆到多个执行环境根下
  （`~/.claude/skills`、`~/.codex/skills`、`~/.hermes/skills`…）。"同一个 skill 装了
  几处、哪处生效、哪处有安全命中"本身就是跨执行环境事实，单执行环境视图根本呈现不出来。
- 反过来，用户**没有**"我所有执行环境的描述预算总共用了多少"这个问题——那个数字在现实里
  不对应任何东西。

### 3.5 决定：保留实质、放宽形式，白名单式合计

**REQ-SK-01（不合并）** tab 内**不得**出现以下任何跨执行环境单一数字：描述预算百分比或
字符数总和、Tier1 token 总和、冲突对数、重叠对数、僵尸/休眠 skill 数。验收脚本按字面
禁止（§11.1）。

**REQ-SK-02（并列）** 默认视图 = 全部已检测到的执行环境并列：每执行环境一张摘要卡（§6.1）；
发现列表跨执行环境一份，**每行必带执行环境芯片**，可按执行环境筛选；冲突/重叠对只在同执行环境内成对，
渲染时归在该执行环境名下。

**REQ-SK-03（允许合计的量，穷举）** 只有下列量可以在页头出"总计"：
1. 已扫描的执行环境数 / 未检测到的执行环境数；
2. 去重后的 skill 目录数（按规范化 `path` 去重；同一目录被两个执行环境根命中算一个）；
3. 安全发现数（按 `(path, rule, line)` 去重）按严重度分 critical / warning / info——
   **必须同时显示 `max_severity`（含 cited）而不是只显示 uncited**（CLAUDE.md
   「Security heuristics sort, they never acquit」）；
4. 结构问题数（SV105 / SV902，按 path 去重）。
这四个量的共同点：单位是"文件/目录/执行环境"，不是"某执行环境上下文里的份额"。清单是穷举的，
新增合计项要改本规格并同步改验收脚本。

**REQ-SK-04（单执行环境视图仍是一等公民）** 执行环境选择器（§4.2）选中某一执行环境时，页面等价于
`agent-vitals doctor --harness <h>` 的可视化：页头总计段隐藏，只展示该执行环境的卡 + 该执行环境的
发现，并给出"在终端里复现"的命令（含 `run` 标记）。这是 SKILL.md §4/§5 要求 Agent 出
报告时的形态，tab 要能一键回到它。

### 3.6 风险与守卫

| 风险 | 守卫 |
|---|---|
| 页头"总计"日后被顺手加进预算/Tier1 之类的数（最常见的漂移） | §11.1 结构守卫：断言页头合计区不含 `预算`、`Tier1`、`tokens` 字样；vm 单测喂两执行环境 fixture，断言 DOM 里不存在任何跨执行环境预算数字 |
| 同名 skill 在两个执行环境被当成冲突 | 键保持 `(harness, instance_id, namespace, name)`（`analysis.rs` harness_summaries 分组键），tab 不自造键 |
| 扫描拉起 `codex app-server`，每次刷新总览都跑一遍 | 扫描只在 tab 首次打开 / 用户点「重新扫描」时跑；结果进程内缓存（同 `codex_merged_cached` 的 Arc + 时间戳形状）；总览的并发命令批里不包含它 |
| 桌面每次刷新写一份快照，30 份轮换把 `diff` 的基线冲掉 | 桌面调用恒带 `--no-snapshot`；「存为快照」是显式按钮（§6.6）；快照目录/keep 语义与 CLI 完全共用（`snapshot.rs`） |
| 桌面二进制在 `Contents/Resources/bin/`，`detect_self_root()`（`main.rs:987`）找不到 SKILL.md → 若用户把 agent-vitals 装成 skill，自己的规则示例会被扫成 cited 命中 | **不做按名字豁免**（`main.rs:985-986` 已明确拒绝可冒名的豁免）；设置页加一个可选「agent-vitals 自身 skill 目录」路径，填了就透传 `--self-root`；未填就照扫，靠 `cited` 排序 |
| SV401 / SV5xx 被渲染成"程序判定" | 文案规则 §8：这两类的行动列固定为"需你判断 · 在终端 `explain <name>` / 让 Agent 跑 `/agent-vitals`"，不给一键按钮 |
| dsh 不在 `harness_summaries` 的家族列表里（`analysis.rs:597` 只有 5 个家族） | 前置项 P0-3：把 dsh 加进 harness_summaries 或 tab 对 dsh 单独跑一次 `--harness dsh`；不能让 dsh 卡片静默缺席 |

---

## 4. 信息架构

### 4.1 tab 位置与命名

- 顶栏新增第 6 个 tab：**「Skill」**，位于「待处理」之后、「设置」之前
  （`workbench.html:13-16` 的 tab 条）。理由：它和"待处理"同属"需要我处理的东西"，
  但对象不同（安装资产 vs 账单），不并入待处理——待处理已经承载账单确认，再塞进 SV
  码会把两种"待办"混在一个列表里。
- `data-tab="skills"`，section `id="tab-skills"`；导航映射走 Rust 纯函数 `tab_for_menu_id`
  （单测钉住），托盘菜单同步加一项「Skill 体检」。

### 4.2 页头

```
Skill 体检   执行环境 [全部 ▾]                       扫描于 07:44 · run a1b2c3   [重新扫描] [存为快照]
已扫描 4 个执行环境（openclaw、hermes 未检测到）· 27 个 skill 目录 · 安全 1 critical / 3 warning（含引用语境 2）· 结构 0
```

- 执行环境选择器：`全部` + 扫描器认得的六个执行环境（`main.rs:65` 的 value_parser 列表），未检测
  到的执行环境在下拉里灰显并注明"未检测到"，不隐藏——用户要知道工具找过。
- 第二行即 REQ-SK-03 的四个合计；选中单执行环境时整行隐藏（REQ-SK-04）。
- `run` 标记原样显示（`doctor --json` 的 `run` 字段）；「在终端复现」复制
  `agent-vitals doctor --harness <h>`。

### 4.3 三层结构

沿用设置页规格 §3.3 的层级：页头 → 分区标题 → 卡/行。分区顺序固定：

1. 执行环境摘要卡行（§6.1）
2. 立即处理（critical + warning 的 SV 发现，§6.2）
3. 安全与结构（§6.3）
4. 冲突与重叠（按执行环境分组，§6.4）
5. 使用证据（僵尸/休眠/太新，按执行环境分组，§6.5）
6. 未评估与 caveat（§6.6）

---

## 5. 数据契约

### 5.1 取数路径（v1）

一次 Tauri 命令 `skills_doctor_report({ harness, selfRoot })`，后端 `Command::new(bin)`：

```
agent-vitals doctor --harness <harness|all> --json - --with-report --no-snapshot [--self-root <dir>]
```

返回 JSON 一份，形状 = 现有 `doctor --json` 载荷（`main.rs:4130-4138`）：

```json
{
  "schema_version": …,
  "run": "…",
  "harness_selection": "all",
  "diagnostics": [ { "code","name","severity","skill","evidence","impact","recommendation","caveats" } ],
  "not_assessed": [ { "code","name","reason" } ],
  "report": { …扫描报告本体（--with-report 时附带）… }
}
```

`diagnostics[]` 每条的形状出处：`apps/cli/src/skills/doctor.rs:78-90`。`report` 的
形状出处：`apps/cli/src/skills/report.rs::build`（`harness_summaries` 出自
`crates/agent-vitals-domain/src/domain/skills/analysis.rs:590`）。

**形状来源纪律**（CLAUDE.md「Stage A–D 审查 10 条确认缺陷的共同根因」）：前端渲染器和
`.mjs` 验收 stub 的 fixture **必须**由真实 CLI 输出捕获（`agent-vitals doctor --json …`
跑在 `tests/fixtures/` 下的 HOME 上），文件头注明生成命令；不允许手写期望形状。

### 5.2 为什么是一次调用而不是两次

预算/加载数/harness_summaries 在扫描报告里，SV 码在 doctor 载荷里，今天 CLI 把它们分成
`--json -`（报告）与 `doctor --json <file>`（诊断）两条路。tab 两样都要，若分两次调用就
扫两遍（含两次拉起 `codex app-server`）。因此前置改动 P0-1/P0-2（§10）：`doctor --json`
支持 `-` 写 stdout（现在是 `std::fs::write(path)`，`main.rs:4141`），并加 `--with-report`
把报告本体塞进同一份载荷。`diagnose()` 本身不动，Python↔Rust 逐字节对齐不受影响。

### 5.3 v1.1：库化（不阻塞 v1）

把 `report::build` 与 `doctor::diagnose`（及其依赖的 `render::{human_tokens,
last_used_text, lifecycle_status}`、`util::run_id`）迁进
`agent_vitals_runtime::skills::{report, doctor}`，CLI 与桌面都改为直接调库，桌面不再
起子进程。这是 CLAUDE.md §7.1 的既定方向（"orchestration/IO 是 Rust-only，纯规则进
Rust core"），命名沿 E7.x（E7.7）。`tests/test_doctor.py` 的差分门保证迁移前后输出不变。

### 5.4 缺失/不可用语义（逐字段）

| 字段 | 不可用时 | tab 渲染 |
|---|---|---|
| `harness_summaries.<h>.description_budget` | 执行环境无预算（dsh/workbuddy/hermes）→ 无此键或 `available:false` | 不画条，写"该执行环境没有描述预算"；dsh 额外写"逐条截断见 SV004" |
| `harness_summaries.<h>.runtime_verified_count` | 无运行时接口或探测失败 → `null` | 显示"—"，hover 写 `codex_runtime.errors[]` 的原因；**绝不显示 0** |
| `trigger_data` | 非 claude-code/dsh 执行环境 | 使用证据分区对该执行环境写"此执行环境不提供触发数据"，不列僵尸 |
| `diagnostics[].caveats` | — | 必须逐条渲染在该发现下方，不折叠、不改写 |
| `not_assessed[]` | — | 必须渲染（§6.6），不得省略 |
| 二进制找不到 | `resolve_binary()` 失败 | 与会话 tab 同一条错误文案（`store.rs:74`），给设置页入口 |

---

## 6. 各分区规格

### 6.1 执行环境摘要卡行

每个已检测执行环境一张卡，横向排列，窄窗口折行（响应式规则同总览 KPI 网格）：

```
Claude Code                    Codex                          DeepSeek Harness
描述预算 ████████░░ 82%        描述预算 ██░░░░░░░░ 21%         描述预算 —（无全局预算，SV004 逐条截断）
12,340 / 15,000 字符           1,690 / 8,000 字符（官方 2% 估算）
已加载 18 · 磁盘 31            已加载 9 · 运行时核实 9/9        已加载 6（会话日志 + 注册表快照）
⚠ 2 · ✕ 0                     ⚠ 0 · ✕ 1                       ⚠ 1 · ✕ 0
```

- 预算条的分母来自该执行环境自己的 `description_budget`，条上标注分母来源（"可配置估算"/
  "官方 2% 估算"/"可配置上限"），与 README 兼容性表同词。
- "运行时核实 n/m" 只在 `runtime_evidence:true` 的执行环境显示；否则整行不出现。
- 卡底部的 ⚠/✕ 是**该执行环境**的 warning/critical 计数，点击 = 执行环境选择器切到该执行环境。

### 6.2 立即处理

`diagnostics` 中 severity ∈ {critical, warning} 的条目，按 severity → SV 码排序（与
`doctor.rs::severity_rank` 一致）。每行：

```
✕ SV002  描述预算溢出         claude-code   超出 15,000 字符 1,240，最少使用的描述会被静默丢弃
         → 行动：禁用或缩短 3 个最少使用 skill 的描述（列出名字与路径）
         ! caveat：预算不含 Claude Code 内置 skill，实际占用更高
```

- 行动列直接取 `recommendation`；caveat 取 `caveats[]`，前缀 `!`。
- SV401 / SV5xx 的行动列固定为"需你判断"（§8），不给一键操作。
- **没有任何"一键禁用/删除"按钮**（SKILL.md §5 第一条）。允许的动作只有：复制路径、
  在终端 `explain <name>`、复制 `agent-vitals doctor --harness <h>` 命令。

### 6.3 安全与结构

- 行 = skill 目录（去重键 `path`），列：严重度（`max_severity`，含 cited）、规则、
  文件:行号、装在哪些执行环境（芯片）。
- `cited=true` 的命中排在同严重度末尾并标"疑似引用语境"，**不降级、不隐藏**
  （CLAUDE.md「Security heuristics sort, they never acquit」）。
- 页头 §4.2 的安全合计与本分区行数必须相等（vm 单测钉住）。

### 6.4 冲突与重叠（按执行环境分组）

- 分组标题 = 执行环境名；组内是该执行环境的 SV101/102/103 组（同名副本：生效的那份加粗，被遮蔽
  的标"被遮蔽"，路径全列）与 SV401 候选对（共享词打出来，后面跟"需你判断"）。
- 两个执行环境之间永不成对；`全部` 视图下也只是把各执行环境的组上下堆叠。

### 6.5 使用证据（按执行环境分组）

- 只对提供触发数据的执行环境（claude-code、dsh）列出 `zombie` / `dormant` / `too-new` 三列；
  其它执行环境一行说明"此执行环境不提供触发数据"。
- `too-new` 必须带"N 天后可判定"（`zombie_min_age_days` 减已安装天数），不得落进僵尸。

### 6.6 未评估与 caveat；动作栏

- 原样列出 `not_assessed[]`（码、名、原因），标题「本次未评估」。
- 动作栏：**重新扫描**（主）、**存为快照**（次，成功后回执"已存 · 下次扫描会显示变化"）、
  **与上次快照对比**（有快照时出现，结果按 `render_diff` 的四条规矩渲染：没有基线不等于
  没有变化）、**导出脱敏 JSON**（恒带 `--redact --redact-names`，与设置页脱敏诊断包同款
  "用户主动保存、不自动上传"）。

---

## 7. 状态

| 状态 | 触发 | 渲染 |
|---|---|---|
| 未扫描 | tab 首次打开 | 页头显示「尚未扫描」+ 主按钮「开始扫描」；**不自动跑**（首次打开就拉起 codex app-server 会让 tab 首屏空转数秒） |
| 扫描中 | 点击后 | 骨架卡 + "正在遍历 N 个执行环境根…"，按钮禁用；可取消（kill 子进程） |
| 完成 | 子进程 exit 0/1 | 正常渲染；exit 1 只是"有发现"，不是错误（README「CI」退出码契约） |
| 工具失败 | exit 2 / 二进制缺失 / JSON 解析失败 | 红色 notice，原样带 stderr 首行，不冒充"没有发现" |
| 结果过期 | 上次扫描 > 24h，或设置页执行环境根有改动 | 页头时间戳旁标"可能过期"，不自动重扫 |
| 探测被禁用 | `AGENT_VITALS_DISABLE_CODEX_RUNTIME` / `…OPENCLAW_RUNTIME` 生效 | 对应执行环境卡写"运行时探测已禁用（环境变量）"，计数 `null` |

---

## 8. 文案规则

- SV 码永远与人话并列出现（`SV002 描述预算溢出`），不单独出现裸码；码表用 SKILL.md §2
  的中文（`references/guide.zh-CN.md`）。
- 三态措辞与账单确认列表对齐：**程序判定**（预算、结构、冲突副本的事实部分）/ **已知**
  （有证据但要你决定，如 SV103 有意覆盖）/ **需你判断**（SV401、SV5xx、SV201/202 的
  "真死还是没被选中"）。
- 数字后缀规则：token 恒标"估算"，触发次数恒标"测量"，语义重叠恒标"候选"。
- 不出现 "provider" "路由" 等内部词（沿用 KPI 决策卡的"可信度行不含内部词"守卫）。

---

## 9. 与 CLI / Agent 的分工

tab 做 SKILL.md §2 的"读诊断"，不做 §3 的"补判断"。它把 `doctor` 的输出可视化，把
需要模型的部分交回给 Agent：每个"需你判断"行都带"让 Agent 判断"提示——复制
`/agent-vitals` 或 `agent-vitals explain <name>`。tab 永远不：删/禁用 skill、改执行环境配置、
改预算阈值（`--budget` 只在设置页作为高级项，默认沿 CLI 默认）。

---

## 10. 实施顺序

**P0 前置（CLI，独立 PR，先合）**
- P0-1 `doctor --json -` 写 stdout（`main.rs:4141` 的 `std::fs::write` 分支加 `-` 特判，
  与主扫描 `--json -` 语义一致）。
- P0-2 `doctor --with-report`：载荷里加 `"report": doc`。Python 侧 `doctor.py` 同步，
  `test_doctor.py` 差分门覆盖。
- P0-3 `harness_summaries` 补 `dsh` 家族（`analysis.rs:597`），或在 tab 侧对 dsh 单独跑
  `--harness dsh` 合并——二选一，倾向前者（一处改，CLI 报告也受益）。
- P0-4 桌面二进制打包：确认 `Contents/Resources/bin/agent-vitals` 随 `cargo tauri build`
  一起进 bundle（会话 tab 已依赖它，验证一下现状即可）。

**v1（桌面，本规格主体）**
1. `store.rs` 加 `skills_doctor_report`（子进程 + 进程内缓存 + 取消）；`lib.rs` 注册 IPC。
2. `workbench.html` 加 tab 与六个分区骨架；`tab_for_menu_id` + 托盘菜单项。
3. `workbench.js` 渲染器：`renderSkillHealth(payload, harnessFilter)` 纯函数化（便于 vm 测）。
4. 设置页「统计与数据」加两项：agent-vitals 自身 skill 目录（可选，透传 `--self-root`）、
   描述预算覆盖（高级，默认空 = CLI 默认）。
5. 验收脚本 `scripts/verify-workbench-skills.mjs`（§11）。
6. `.app` 真机：`cargo tauri build --bundles app` → 安装 → 六个执行环境各一张截图（含至少一个
   "未检测到"与一个"无预算"执行环境）。

**v1.1** §5.3 库化；桌面去子进程。

---

## 11. 验收

### 11.1 结构守卫（扩展 `verify-workbench-visibility.mjs` 同款静态断言）
- tab 条含 `data-tab="skills"`；section `#tab-skills` 存在且含六个分区 id。
- 页头合计区（`#sk-totals`）的模板文本**不含** `预算`、`Tier1`、`tokens`、`冲突`、`重叠`、
  `僵尸` 六个词（REQ-SK-01 的字面守卫）。
- 不存在任何 `disable`/`delete`/`禁用`/`删除` 按钮（SKILL.md §5）。

### 11.2 vm 单测（`verify-workbench-kpi-decide.mjs` 同款，真 `workbench.js`）
fixture = 真实 CLI 对 `tests/fixtures/` HOME 的输出（两执行环境：claude-code 有预算、dsh 无预算；
同一 skill 目录装在两处；一条 cited 安全命中；一个 too-new）：
- `全部` 视图：两张执行环境卡；claude-code 有预算条，dsh 无条且文案含 "SV004"；页头安全合计
  = 安全分区行数；同目录安全命中只一行、两枚执行环境芯片；DOM 中不存在任何把两执行环境预算相加
  的数字（对 fixture 里两个分母之和做字面断言）。
- 单执行环境视图：合计行隐藏；只剩该执行环境的发现；复现命令含 `--harness <h>` 与 `run`。
- `runtime_verified_count:null` 渲染为 "—" 而非 "0"。
- `caveats[]` 与 `not_assessed[]` 逐条出现在 DOM。
- SV401 / SV5xx 行的行动列文本为"需你判断"，无按钮。
- 子进程 exit 2 → 错误 notice；exit 1 → 正常渲染。

### 11.3 真机（`.app`）
- 六个执行环境各一截图；至少验证一次「存为快照 → 改一个 skill 的描述 → 重新扫描 → 与上次快照
  对比」闭环，`diff` 段只列新增项。

---

## 12. 需要拍板的决定

1. **tab 名**：「Skill」vs「体检」vs「安装」。倾向「Skill」——短，且与"用量/会话"同为
   对象名词。
2. **首次打开是否自动扫描**：本规格选"不自动"（§7），理由是 codex app-server 拉起成本；
   若你更看重首屏就有内容，可改为"自动但 codex 探测延后到用户确认"。
3. **描述预算覆盖是否进设置页**：影响 SV001/002 的判定阈值，属高级项；不放也能用。
4. **P0-3 走哪条路**（改 `harness_summaries` vs tab 侧补跑 dsh）。

---

## 13. 非目标

- 不在桌面里实现 SV401 语义判断、SV5xx 逐行复核——那是模型/人的工作（SKILL.md §3）。
- 不做跨执行环境"同一 skill 的内容级去重"（按内容哈希识别克隆），v1 只按 path 去重。
- 不做 skill 的启停/删除/编辑。
- 不把 Skill 体检并入总览页；总览最多在"可信度行"下加一行"Skill 体检：N 条待处理 ›"
  的入口（可选，单独立项）。
