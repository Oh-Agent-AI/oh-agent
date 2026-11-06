# Agent Vitals — 产品设计

> **Observability for Agent Capabilities**
> Know what your agent can actually do.

配套文档：[ARCHITECTURE.md](./ARCHITECTURE.md)（漏斗模型 / 数据契约 / 诊断引擎） · [ENGINEERING.md](./ENGINEERING.md)（Rust 移植 / 测试 / 分发）

---

# 1. 问题

用户已经从「怎么安装 Skill」进入「**为什么装了却不工作**」。

Phase 1 的全部产品主线就是这一句：

> **Why didn't my Skill work?**

典型症状：

- Skill 文件存在，但 Agent 根本没加载
- Description budget 溢出导致 Skill 静默消失——**没有报错**
- Personal Skill 覆盖 Project Skill（与直觉相反的优先级）
- 两个 Skill 描述语义重叠，模型选错
- 装了几个月从未触发
- Skill 正文过大，一触发就吃掉大量窗口
- 第三方 Skill 存在 prompt injection 或危险执行逻辑
- 「昨天还能用，今天就没了，哪儿都没报错」

这些信息今天分散在文件系统、Agent 配置、Plugin 配置、SKILL.md、usage metadata 和用户经验里，**缺少统一的 observability layer**。

---

# 2. 定位

## 2.1 一句话

**Agent Vitals 是面向 AI Agent 用户与开发团队的本地能力可观测工具**——发现 Agent 实际加载了哪些 Skills、哪些真正被使用、哪些互相干扰、消耗了多少 Context。

回答三个问题：

> **What's alive? What's wrong? What's worth keeping?**

## 2.2 不是什么

**不是** Skill Manager，**不是** Skill Security Scanner，**不是** SKILL.md Linter。

所有 feature 必须过一道判断：

> 这个功能是否帮助用户更清楚地知道 **Agent 实际拥有什么能力、这些能力是否正常工作**？

否定则不进入 Core。

```text
Skill Marketplace / Store / Registry     ×
Skill 编辑器 / 创作平台 / 同步            ×
通用 Agent Manager                        ×
Health Score（0–100 综合评分）            ×   ← 见 §7.3
GUI / Cloud Sync / Team Dashboard         ×   （MVP 阶段）
```

保持 **Observe → Diagnose → Decide**，而不是 Create → Install → Manage → Sell。

---

# 3. 双形态：Evidence 与 Reasoning

这是本产品的核心架构判断。

**CLI 最擅长确定性证据，执行环境模型最擅长语义判断。**两者是**并列的角色**，谁都不能替代谁。

```text
                    Agent Vitals Core
                           │
              ┌────────────┴────────────┐
              ↓                         ↓
        Deterministic               Semantic
          Evidence                  Reasoning
              │                         │
              ↓                         ↓
             CLI                  In-harness Skill
              │                         │
              └────────────┬────────────┘
                           ↓
                       Diagnosis
```

|  | **CLI**（Evidence Engine） | **In-harness Skill**（Reasoning Layer） |
|---|---|---|
| 回答 | **What happened?** | **Why does it matter?** |
| 产出 | `loaded=false` · `usage=0` · `budget=102%` · `shadowed=true` · `core_tokens=8200` | 「github 与 github-tools 文字相似度只有 0.41，但在『review this PR』这个 intent 上实际竞争」 |
| 性质 | 确定性 · 可复现 · 可进 CI | 判断性 · 依赖上下文 · 无法离线复现 |
| 成本 | 零依赖、不联网 | 零——执行环境模型本来就在上下文里 |

上表右下角那格是关键：**语义判断在执行环境内是免费的**。一个独立 CLI 要拿到同等能力，得付 embedding 模型或 API key 的代价；而 skill 形态白得。

> 实现上两者是串联的数据流（CLI 产出 JSON → Skill 读取并推理），见 [ARCHITECTURE.md §9](./ARCHITECTURE.md)。**角色并列、数据串联**，两句话不矛盾。

## 3.1 语义判断的三条路径

| 路径 | 成本 | 何时可用 | 输出命名 |
|---|---|---|---|
| Lexical（CLI 内置） | 免费 | 总是 | **`candidates`** — 待判定，不是结论 |
| In-harness Skill | 免费 | 在 Claude Code 等执行环境内 | `overlap` — 可作结论 |
| `--judge`（外部 API） | 需 key + 联网 | 显式开启 | `overlap` — 可作结论 |

**CLI 不得把 Lexical 结果呈现为 conflict / overlap。**它只能说「这几对值得看一眼」，并给出两条升级路径。用 conflict 这个词而底下只有 Jaccard，第一批用户就会发现结论不可信——**这是最难挽回的信任**。

## 3.2 两类受众

| 受众 | 场景 | 命令 |
|---|---|---|
| **Skill 使用者** | 装了一堆第三方 skill，要诊断和清理 | `doctor` `list` `explain` `overlap` `diff` `plan` |
| **Skill 作者** | 写 skill，要回归和 CI | `intent-fit` `fix` `--fail-on` |

**MVP 先服务使用者**：分发渠道、activation 路径、留存逻辑都更短。

---

# 4. User Journey

信息层级是 **环境 → 对象 → 单体**，命令顺序必须与之对齐。

```text
npx agent-vitals                       零安装
   ↓
doctor        「我的环境整体怎么样？」
              30 秒内给出「N 个可执行问题」
              ✓ 自动保存快照
   ↓
list          「你到底看到了什么？」
              全量清单 —— 建立对工具的信任
   ↓
explain <n>   「这一个为什么不工作？」
              漏斗逐级 ✓/✕ + 原因 + 可执行修复
   ↓
（用户执行修复：改名 / 缩描述 / 删 skill）
   ↓
doctor（第二次）
              检测到已有快照，自动附加：
              Changes since last scan
   ↓
diff          进入用户路径 —— 由 doctor 带出，而非要求用户记得
```

`list` 是**信任建立步骤**，不可省。用户不会仅凭一句摘要就相信一个刚装的诊断工具——他要先看见清单，确认工具看到的和他知道的一致，才会相信摘要里那些他不知道的部分。

`diff` 有硬前提（**必须已存在历史**），首次使用价值为零。所以它不进 P0，而是由 doctor 在第二次运行时带出。

---

# 5. 命令

```text
agent-vitals                    # = doctor

P0      诊断闭环
├── doctor
├── list
├── explain <name>
└── overlap                     Lexical candidates + In-harness 判定

P0.5    历史与集成
├── snapshot
├── diff
└── --json

P1      深入与自动化
├── cost
├── security
└── CI                          --fail-on / exit code

P1.5    外部模型层
├── intent-fit <name>
├── --judge
└── fix <name>

v1.x
├── watch                       三种模式，见 §5.8（`--oneline` 常驻形态见 §5.8.4）
├── policy
└── report
```

`agent-vitals` 无参数等价于 `doctor`——第一次使用的用户想知道的是「我的 Agent 到底有没有问题」，不该先学 CLI。

> 取消 v0.1 提议的简称 `sv`：runit 在 Debian/Ubuntu 占用 `/usr/bin/sv`。如需短名用 `skv`，上线前实测。

## 5.0 分层的依据

**每一层解决一个不同的问题，层内的命令共享同一个前提条件。**

| 层 | 共同前提 | 解决的问题 |
|---|---|---|
| **P0** | 无 | 诊断闭环：环境 → 对象 → 单体，一次运行就能得出可执行结论 |
| **P0.5** | 需要**序列化与历史** | 让「2–3 周后复查」真的能复查；让结果能进管道 |
| **P1** | 需要 P0.5 的 `--json` 与退出码 | 从人工诊断变成自动化 gate |
| **P1.5** | 需要**外部模型 / API key** | 超出确定性证据的能力 |

### 为什么 `fix` 排在最后

> **诊断产品最重要的是先证明「诊断准」，而不是急着证明「我还能替你治」。**

`fix` 建立在两个尚未被验证的前提上：诊断本身是对的，且改写建议比用户自己写更好。**前者没证明之前，后者是负资产**——一个改错了描述的 `fix`，比不提供 `fix` 伤害大得多，因为用户会照单执行。

同理 `intent-fit`：它输出的是**离线代理指标**（§5.7），在诊断准确性未被真实用户验证前提前发布，会让用户按一个尚未校准的数字改描述。

### `--judge` 推迟到 P1.5 不会削弱 `overlap`

这正是双形态架构（§3）挣来的：

```text
overlap 的语义判断有两条路
  · In-harness Skill   免费、无需 key   ← P0 就有
  · --judge         需 key + 联网    ← 推迟到 P1.5
```

`--judge` 只服务「不在执行环境内、且愿意配 key」的 CLI 用户——是补充路径而非主路径。**若没有双形态，`--judge` 就必须进 P0，整个 MVP 会被一个 API key 依赖卡住。**

---

## 5.1 `doctor`

### 首次运行

```text
Agent Vitals 1.0
──────────────────────────────────────────────────
Harness    Claude Code 2.0.14
        触发数据 ✓ · 加载判定 ✓ · 描述预算 ✓

Skills  43 on disk → 31 loaded
        未加载：插件未启用 8 · 其他执行环境 3 · 其他 1

CRITICAL — 4 个可执行问题

  ✕ SV002  描述预算已溢出
           15,231 / 15,000 chars (102%)  · loaded-only, 31 skills
           约 2 个 skill 可能已被静默丢弃
           ! 不含 Claude Code 内置 skill，实际用量更高
           ! 阈值随版本变化，--budget 可覆盖

  ⚠ SV101  proj-deploy 的新版未生效
           生效  ~/.claude/skills/proj-deploy        (14d ago)
           被盖  ./.claude/skills/proj-deploy        (2h ago)

  ⚠ SV201  7 个 skill 装够 14 天且终身零触发
           另有 3 个装机不足 14 天，样本不足暂不判定

  ⚠ SV301  3 个 skill 触发成本 > 6,000 tokens

启动上下文 (tier1)
  约 3,920 tokens  ·  约占 200k 的 2.0%   [估算]

安全
  2 critical · 1 high
  其中 2 条命中疑似引用语境（仅影响排序，仍需人工过目）

下一步
  agent-vitals list
  agent-vitals explain proj-deploy

  ✓ 已保存快照 → 下次运行会自动对比
```

### 第二次及以后

检测到已有快照，**在结论之前**附加变化段：

```text
Changes since last scan (Aug 1)
  + 2 skills · − 1 skill · 1 个新增告警
  描述预算  12,842 → 15,231  (+18.6%)  ⚠ 已溢出

  agent-vitals diff        查看完整变化
```

这是 `diff` 进入用户路径的方式——**由产品带出，不指望用户记得**。

### 三条渲染纪律

**纪律 1 — 描述预算与上下文占用必须分开。**
前者是**描述字符预算**（chars），后者是 **tier1 token 占比**，通常只有 1–2%。v0.1 把 `Context ██████ 91%` 与预算并排，用户第一眼读到「上下文用掉 91%」。**虚报预算危机会让用户去做无用功，比不报更糟。**

**纪律 2 — 预算数字永远与「不含内置 skill」同屏。**
内置 skill（`dataviz` / `code-review` / `artifact-*` / `loop` 等）打包在 CLI 二进制里、磁盘上无 SKILL.md，扫不到但同样占预算。省掉这条 caveat，结论会从高估**翻转成低估**。

**纪律 3 — 未超预算时不得渲染成问题。**
只在 `over_by_chars > 0` 时置顶；没超就正常报一句百分比。

---

## 5.2 `list`

回答「**你到底看到了什么**」。

```text
NAME             LOAD       STATUS      USES   LAST USED   CORE    MAX
──────────────────────────────────────────────────────────────────────
github           loaded     active       143   2h ago      2.1k    8.0k
analytics        loaded     active        38   1d ago      8.7k   15.2k
pdf              loaded     dormant        2   21d ago     4.2k    4.9k
old-search       loaded     zombie         0   never       3.8k    3.8k
new-thing        loaded     too-new        0   never       1.2k    1.2k
proj-deploy      shadowed   active         7   3d ago      2.0k    2.0k
legacy-tool      disabled   —              —   —           2.4k    2.4k

31 loaded · 12 未加载  ·  阈值 dormant=30d zombie=14d
```

### LOAD 与 STATUS 必须分列

v0.1 把 `active / dormant / zombie / shadowed` 挤在一列。但前三者是**使用生命周期**，`shadowed` 是**加载状态**，两者正交。

一个 skill 完全可以既 shadowed 又 active（生效的那份在被用，你改的那份没生效）——**这恰恰是最该被看见的情况**，单列设计会把它显示成 `shadowed` 并隐藏使用数据。见上表 `proj-deploy` 行。

```text
LOAD   ∈ { loaded, shadowed, disabled, other-harness, unknown }
STATUS ∈ { active, occasional, dormant, zombie, too-new, unknown }
```

### 过滤

```bash
agent-vitals list --unused --stale 30 --shadowed --harness claude
agent-vitals list --sort usage|cost|name --top 10 --json
```

---

## 5.3 `explain`

漏斗的 UI，也是 `doctor` / `list` 之后**唯一需要用户学的命令**。

```text
agent-vitals explain proj-deploy

proj-deploy
──────────────────────────────────────────────────
STATUS   NOT IN EFFECT

漏斗

  ✓ Installed        ./.claude/skills/proj-deploy
  ✓ Enabled          project
  ✕ Loaded           被 personal 层覆盖
  · Discoverable     不适用（未加载）
  · Selected         不适用
  · Triggered        不适用

原因

  覆盖优先级 enterprise > personal > project > plugin
  home 目录里的会盖掉项目里的 —— 这与多数人的直觉相反

  生效  ~/.claude/skills/proj-deploy   hash 3f2a91  修改于 14 天前
  被盖  ./.claude/skills/proj-deploy   hash 8c04de  修改于 2 小时前

  你 2 小时前的修改没有生效。

影响

  这个 skill 的正文无论怎么改都不会到达用户。

修复（按省事程度排序）

  1. 改名：项目专属的加前缀（proj-deploy → acme-deploy），从根上消灭冲突
  2. 符号链接：需要单一真相源时，Claude Code 会跟随符号链接，
     且同一目标从多个位置可达时只加载一次
  3. 分层：home 放跨项目通用且稳定的，项目放项目专属的并提交版本库

  注：曾有报告称同名 skill 在实际运行中两个都出现在选择器里，
  而非被遮蔽。若你观察到两个，那不是记错——实际行为可能与文档
  不一致，建议直接改名规避。
```

**`explain` 的价值在于给出「为什么」和「所以呢」**，而不只是「有问题」。每条输出都必须能落到一个用户可以执行的动作。

对健康 skill 则展示完整 ✓ 链、成本三档、overlap candidates 与安全结论。

---

## 5.4 `overlap`

```text
agent-vitals overlap

Overlap candidates                          [Lexical，待判定]

  github  ↔  github-tools
    共享词        pull request · issue · repository
    Jaccard       0.61

  pdf-reader  ↔  ocr-tool
    共享词        pdf · 扫描 · 提取
    Jaccard       0.44

  这是字面相似度筛选，不是结论。语义竞争可能出现在用词完全
  不同的两个 skill 之间，Lexical 查不到。

  要得到可作结论的判断：
    · 在 Claude Code 里运行 /agent-vitals（免费，无需 key）
    · 或 agent-vitals overlap --judge（调用外部模型）
```

判定后（Layer 2 / 3）：

```text
github  ↔  github-tools                     [judged]

  文字相似度仅 0.41，但在以下 intent 上实际竞争：

  会引发争抢的具体说法
    「review this pull request」
    「帮我看看这个仓库有什么问题」

  处置建议
    把 github-tools 的描述收窄到仓库管理操作（权限、
    webhook、settings），并在描述里显式排除 code review。
```

上面那句「文字相似度仅 0.41」正是 Reasoning 层存在的理由——**Lexical 会漏掉它**。

**必须给出「会引发争抢的具体用户说法」。**「优化描述」不合格；「在 pdf-reader 描述里加上『不处理扫描件』，因为它和 ocr-tool 在扫描件场景争抢」才合格。

---

## 5.5 `diff`（P0.5）

```bash
agent-vitals diff              # 对比最近一次快照
agent-vitals diff <file>
```

```text
Changes since Aug 1
──────────────────────────────────────────

Skills
  + database-tools
  + browser
  - legacy-search

描述预算
  12,842 → 15,231   (+18.6%)   ⚠ 已溢出

新增 overlap candidates
  github ↔ database-tools

触发增量
  analytics   +28
  pdf          +0

新增安全命中
  browser  SV502 pipe_to_shell  scripts/setup.sh:9

新可判定（上次太新，现已装够 14 天）
  old-pdf     0 次触发 → zombie
  new-linter  6 次触发 → alive
```

**`newly_judgeable` 才是本次新增的僵尸判定对象**——直接报这一张，不要把老结论重报一遍。

直接回答「为什么昨天还能用」，也是产品**唯一天然产生复访**的能力。

---

## 5.6 P0.5 之后的命令（摘要）

| 层 | 命令 | 作用 | 关键约束 |
|---|---|---|---|
| P0.5 | `snapshot` | 手动存档 | 目录 `0700`，支持 `--redact` |
| P0.5 | `--json` | 正式 API 输出 | 与人类可读输出**基于同一份诊断对象**渲染 |
| P1 | `cost` | 四档成本明细 + Context Efficiency 二维分类 | tier1 / core / refs / max **四个口径不得合并**；拆分判据是 token 不是行数 |
| P1 | `security` | 启发式扫描 | **Detection ≠ conviction**，永不输出 SAFE；`cited` 只排序不抑制 |
| P1 | CI | `--fail-on` + 退出码 | 依赖 P0.5 的 `--json`；关键是**这个 PR 新增了什么**，而非当前有几个问题 |
| P1.5 | `intent-fit` | 描述与 intent 的离线拟合度 | **不是真实 routing**，措辞必须降级（§5.7） |
| P1.5 | `--judge` | 外部模型判定 overlap | 补充路径，非主路径（§5.0） |
| P1.5 | `fix` | 建议改写 description | Suggest → Diff → Confirm → Apply；**与 `--judge` 同一隐私门**；不代替用户删除 |

### 安全的措辞标准

```text
✓  No known suspicious patterns detected.
✕  This skill is safe.
```

必须同时明说：**这是正则启发式，既会误报也会漏报，不替代安全审计。**每条命中带行号——**打开看一眼才是唯一真正的防线**。

---

## 5.7 `intent-fit` 为什么不叫 `test`

v0.1 输出 `Routing accuracy 75%`，是在声称「我知道 Agent 会选哪个 skill」。但实际 routing 取决于完整系统提示、**当时全部 description 的列表**、对话上下文和模型版本。

离线 CLI 算不出这个；用外部 LLM 模拟，模拟的也是一个和真实执行环境不同的上下文。

> **给出一个 75% 的精确数字，比不给更糟**——用户会照着它改描述，而它测的不是真实 routing。

故改名 `intent-fit`，并在输出里明说：

```text
  这不是真实 routing 结果。实际选择还取决于完整系统提示、
  当时加载的全部 skill 列表和对话上下文。要验证真实行为，
  在执行环境内运行。
```

## 5.8 `watch` 有三种模式，不能写死成 fs watcher

`watch` 排在 v1.x。这里锁定两件事：**监听对象由执行环境决定**，且 **B、C 两种模式
共用一个游标、是一份实现**。

| | **A** 无运行时记录的执行环境 | **B** 目录发布（dsh） | **C** 运行时度量 |
|---|---|---|---|
| 监听什么 | skill 目录的文件系统事件 | 会话事件流（append-only） | **同一条**会话事件流 |
| 每次事件 | 重扫全库 | 移动游标读增量 | 移动游标读增量 |
| 消费的 Signal | —（走 fs，不经 Signal 层） | `SkillInvocations` + 目录发布 | `Usage` · `ContextWindow` · `ToolCalls` · `Compaction` |
| 能看到 | 文件变了 | 目录重发（带确切条目）· skill 被调用 · **这一轮因发现不完整整个目录未发布** | 这次会话烧了多少 · 上下文还剩多少 · 刚做了该拦的事 · 刚被压缩掉多少 |
| 成本 | fs watcher + 重扫 | 一个游标 | 同一个游标 |
| 噪声 | 每次文件触碰 | 执行环境按 digest 去重后才有事件 | 逐事件，需自己节流 |

B 列第四行是这条区分最初的价值所在：「这一轮目录整个没发布」在磁盘上永远看不
出来，而它恰好是 dsh 上最难查的失效模式。

> ENGINEERING §1.5 里「`watch` 资源占用被实际抱怨」这条重新迁移的触发条件，
> 只对 A 列成立。B / C 的 watch 是一个日志游标，不构成性能论据。

### 5.8.1 C 列是后加的，而且它和 B 是同一份实现

本节原本只有 A、B 两列——写它的时候行为审计 / 成本折叠 / 时长审计**还不存在**，
所以两列问的都是同一个问题：「我的 skill 到底加载了没有」。B 列只是换了个更好的
观测点（用运行时证据回答装机层的问题，即 `evidence_recency: log`）。

C 列问的是另一件事：**现在在烧什么、该不该拦**。

但 C **不是第三个实现**。在
[RUNTIME_EVIDENCE_CONTRACT](./RUNTIME_EVIDENCE_CONTRACT.md) 的 Signal 模型下，
B 和 C 是**同一条 `locate` + 同一个游标 + 同一个 `extract`**，区别只在规则声明的
`requires`。写 §5.8 的时候没有这层抽象，只能把两种用途描述成两种实现；现在
C 可以直接以 `requires` 的差异接进去。

### 5.8.2 不要监听执行环境已经在监听的东西

在 dsh 上用 fs watcher 是**重复劳动**：DSH 的 `skill-filesystem` 自己就在监听目录，
变更触发 `skills/change`，`tool-skill` 在目录内容 digest 变化时重发并落库。
去监听同一批目录，等于更差地重算执行环境已经算过并记下来的结论。

> **未决**：这条对 Claude Code / Codex 是否同样成立尚未核实。两者都有 skill 热
> 加载，若它们同样自己监听并留下记录，A 列的适用执行环境会比本节假设的更少。落地
> A 列之前先查这一条。

### 5.8.3 硬前提：折叠必须可从 turn 边界续

实测本机日志规模：

```text
Codex 最大单份 rollout      200 MB
Claude Code 当前会话         33 MB
DSH 全部会话合计              52 MB（单份最大 8.5 MB，且为 .zstd）
```

**每 tick 全量重解析不可行。增量游标 + 可续折叠是硬需求，不是优化项。**
约束写在 [RUNTIME_EVIDENCE_CONTRACT §10.2](./RUNTIME_EVIDENCE_CONTRACT.md)。

> 顺带记一个现存缺口：本机 DSH 会话全是 `session.jsonl.zstd`，而 `src/dsh.rs`
> 明说「只认裸文本 `.jsonl`，zstd 解压是上游的事」——**今天读不了这台机器上的
> 任何 DSH 会话**。与 watch 无关，但 watch 会先撞上它。

### 5.8.4 常驻形态：状态文件是核心资产，服务器不是

> **2026-08-31 更新**：菜单栏主形态已迁到 **Tauri 菜单栏 app**
> （`src-tauri/`，独立 workspace）。它自带 5 分钟 tick、spawn Rust `oneline`
> 折 DSH 会话、预算读 `alert.json` 权威，**不再依赖 xbar / SwiftBar**
> （`contrib/xbar/agent-vitals.5m.sh` 标记为 legacy 降级通道，见
> `docs/MENUBAR_MIGRATION.md`）。本节「状态文件是核心资产」的结论**仍然成立**
> ——Tauri 与旧插件读的是同一份 `state/` 文件，本节的落地顺序与安全底线
> 不变；只是「每 N 秒执行一次脚本」的执行模型由 app 自带的 tick 取代。

xbar / SwiftBar 的执行模型是「每 N 秒**执行一次**脚本、抓 stdout 渲染菜单」，
脚本跑完就退出。**常驻的是 xbar，不是我们。** 三条推论：

1. **游标状态必须落盘**（状态文件），不能存在进程内存里。
2. 想要 HTTP 服务就得**真养一个 daemon**：端口冲突、PID 文件、崩溃残留、开机
   自启、tick 脚本每次「探测-或-拉起」。这是另一档承诺。
3. 而 xbar 菜单项本身就能点击执行命令 → 生成 HTML → `open`。**零端口、零
   daemon、零认证问题。**

「每次点击都要重新解析 33 MB」这个反对意见不成立：tick 脚本为了出状态栏那一行，
本来就在维护增量状态；HTML 生成读**那份已折好的状态**，不重解析原始日志。

**落地顺序：**

1. tick 脚本 + 状态文件 + 一行状态栏（`agent-vitals watch --oneline`）
2. 菜单项 → 生成 HTML → 打开（见 §5.9）
3. **确实出现「需要一个自己会动的页面」的场景时**，才加服务器 —— 那时状态文件
   已经在了，加服务器是纯增量

若最终要加服务器，安全底线不可省：**只绑 `127.0.0.1` · 随机端口 · URL 携带一次性
token · 校验 `Origin`**。它暴露的是执行过的命令、绝对路径、evidence 原文，本机
任意进程可读、CORS 一松浏览器页面也能 fetch。这是 §8 Local First 之外的**新增
攻击面**，不是顺手就能加的东西。

> **边界**：常驻的本地 HTTP 服务仍在**纯读**这一侧；往用户的 agent 配置里装
> hook 不是。后者是产品定位的改变（RUNTIME_EVIDENCE_CONTRACT §14.8.3），要单独
> 决定，不要因为「反正已经有常驻进程了」顺手越过去。

### 5.8.5 C 模式的告警纪律：按「值不值得打扰」判，不按「有没有数据」判

常驻形态一旦会主动说话，就从「报告」变成了「告警」，判据必须跟着换。
`doctor` 今天是**有多少报多少**——那是报告的正确姿势，不是告警的。

四条纪律（来自 `teamai-cli` 的 Stop hook 摩擦门控，
[RUNTIME_EVIDENCE_CONTRACT §14.9](./RUNTIME_EVIDENCE_CONTRACT.md)）：

1. **又长又顺的会话不该触发。** 工具调用很多但没有摩擦，那是顺利，不是题材。
   判据是「用户有没有跟它较劲」，不是「有没有数据」。
2. **要有一道独立于严重度的硬闸。** 一个被拒过一次的单命令会话，摩擦分再高
   也不值得打扰。**严重不等于值得打断。**
3. **只列实际非零的信号**，不列没触发的。
4. **每个会话最多说一次**，靠状态文件里的标志位防重复（§5.8.4 的状态文件正好
   是它的家）。

分层求值同样值得抄——先用便宜的计数快速退出，够阈值了才去读日志算细账：

```text
第 1 层（便宜）  工具调用数 < 基线   → 退出
第 2 层（惰性）  读日志算摩擦/命中   → 不够 → 退出
硬闸            工具调用数 < 基线   → 无论分数多高都退出
                → 说一次，只列非零项
```

**边界：拿触发机制，不拿沉淀动作。** teamai-cli 的目的是给团队沉淀知识
（`/teamai-share-learnings` 把总结推到共享仓库）；照抄整条流程我们就成了知识库
工具，过不了 §2.2 那道判断题。我们该说的只有一句：

> 这次会话有 N 个行为发现，`agent-vitals behavior <log>` 看详情。

**而且这条不需要 hook。** teamai-cli 必须用 Stop hook，是因为它要把提示打进
**AI 的上下文**里让 AI 转述；我们只需要在状态栏或终端里说一句——tick 脚本看到
会话文件停止增长就到了同一个时刻，零写入用户配置。

这条已经落地：原先是 `scripts/dsh_autosync.py`（由 `contrib/xbar/
agent-vitals.5m.sh` 每个 tick 顺手调用）——"tick 看到会话文件停止增长"
的第一版实现，`(mtime, size)` 连续 5 分钟不变即视为会话已结束，解压
（DSH 的 `.zstd` 是多帧追加写的）后跑一次 `oneline`，每个会话只同步一次
（`oneline` 没有按 session 去重，同步两次会重复计费）。

> **2026-09-01 更新**：`scripts/dsh_autosync.py` 与 xbar/SwiftBar 菜单栏
> 形态一起删除（见 `docs/MENUBAR_MIGRATION.md`）——它的两项职责都已被
> Rust 原生取代：发现「停止增长的会话」是 Tauri tick 的
> `discover → oneline`（`src-tauri/src/lib.rs`），多帧 zstd 解压是
> `src/dsh.rs` 直接内置的 `ruzstd`（R2a §6.3-1，纯 Rust、零 C 依赖），
> 不再需要 Python 侧单独跑一个自动同步脚本。

---

## 5.9 审计视图的投递方式：DSH 那个 tab 是特例，不是模型

`dsh-client` 的审计 tab 在浏览器里，唯一原因是 **DSH 自己有 web UI 和双面插件
架构**。Codex / Claude Code / WorkBuddy 都没有可供第三方渲染的位置——Codex 的
插件清单声明的是 `skills` / `mcp_servers` / `apps` / `hooks`，其余 `display_name`
`logo` `brand_color` 是市场列表元数据，**没有 webview / panel / custom view 扩展点**。

所以不该按「给每个执行环境做一个 tab」规划。

### 5.9.1 客户端那 5,597 行本来就是执行环境无关的

`dsh-client/src/client/` 全部 5,597 行代码，对 DSH 的依赖**只有一处，而且是
`import type`**（编译期消失）：

```ts
export function AuditView({ useProjection }: ConvViewProps) {
```

整个审计 tab 的对外接口就是**一个函数**，消费 15 个投影：

```text
behaviorFindings · tokenUsage · tokenByModel · costReport · requestMetrics
contextComposition · compactionEvents · structuralWaste · subagentSpawns
skillAudit · skillAttribution · durationAudit · sessionCwd · loopCosts · preForkUsage
```

全部走 `useProjection?.('name')`——**注意可选链**：缺哪个投影就是 `undefined`，
组件已经逐投影降级。也就是说，运行时契约里的 coverage 模型，**UI 层其实已经
实现了**：拿不到 `durationAudit` 的执行环境传 `undefined` 即可，组件一行不用改。

### 5.9.2 四种投递方式

| 方案 | 怎么用 | 复用那 5,597 行 | 代价 |
|---|---|---|---|
| **静态 HTML 导出** | `agent-vitals audit --html`，双击打开 | **全部** | 数据是快照，不实时；零服务器 |
| 本地 serve | `agent-vitals serve` → localhost | 全部 | 要 daemon（§5.8.4） |
| TUI | `agent-vitals audit --tui` | **0**，渲染需重写 | 不用浏览器，契合终端用户 |
| 执行环境插件 tab | 仅 dsh 可行 | 全部 | 其他执行环境**无此扩展点** |

**默认选静态 HTML 导出**：复用最大、零常驻、一个文件可直接转发，且**执行环境无关**——
同一个生成器同时服务 Codex / Claude Code / WorkBuddy，不是「为 Codex 做一个」。

两条落地约束：

1. **`ExportPayload` 不能直接驱动 UI。** 它是扁平化的**摘要报告**（给人和机器读），
   不是 UI 的状态。静态 HTML 要内嵌的是上面那 15 个投影的原始形状。两份载荷
   **并存，不要合并**。
2. **`HarnessHidden` 规则在这里更严**（RUNTIME_EVIDENCE_CONTRACT §3.2）。静态 HTML
   天生是要转发的，而 Codex 的 `SecurityRiskScore` 会落进 rollout。默认排除、
   且把「排除了什么」写在页面上。

---

# 6. 状态与阈值

## 6.1 生命周期

| 状态 | 判据 |
|---|---|
| `active` | 最近 7 天内触发过 |
| `occasional` | 7–30 天内触发过 |
| `dormant` | 有历史触发，但超过 `dormant_days`（默认 30）未触发 |
| `zombie` | 装够 `zombie_age_days`（默认 14）且**终身**零触发 |
| `too-new` | 零触发但装机不足 `zombie_age_days` |
| `unknown` | 执行环境无触发数据 |

**阈值必须显示在输出末行。**没有阈值的状态词无法解释也无法复现。

## 6.2 两条硬规矩

**`zombie` ≠ useless。**CLI 永远不因 `usage = 0` 自动删除任何东西。零触发也可能是「预算把它挤掉了」或「描述没被选中」——那是 SV002 / SV401 的问题，不是这个 skill 该死。

**零触发必须先过年龄闸。**今早刚装、零触发说明不了任何事。没有这道闸，用户会照着删掉他昨天刚装的 skill。

---

# 7. 报告质量标准

## 7.1 三条硬要求

1. **每条建议必须具体到可执行。**「优化描述」不合格；「把 pdf-reader 的描述里加上『不处理扫描件』，因为它和 ocr-tool 在扫描件场景争抢」才合格。
2. **区分事实与推断。**token 是估算、触发次数是实测、重叠是判断——三者在报告里要能分辨。
3. **不确定就说不确定。**样本或数据不足时明说，不要为了报告完整而编。

## 7.2 缺一列的报告有价值，编一列的没有

三项能力依赖 Claude Code 的 `~/.claude.json`：描述预算、加载判定、触发数据。其他执行环境上必须报为不可用。

> **绝不用装机时间或 mtime 顶替缺失的触发数。**

## 7.3 为什么没有 Health Score

v0.1 设计了 0–100 分（`Critical -20 / High -10 / …`）。删除的两个理由：

1. **扣分表是任意的**，而它会成为用户唯一记住的数字
2. **`critical_count` 按设计包含 cited 命中**——任何认真写了「如何防御 prompt injection」的 skill 都会给用户扣 20 分。今天这不是问题，因为 flagged 只是一张待核对的清单；一旦驱动头条分数，误报成本就从「多看一行」放大成「分数难看 → 删掉好 skill」

头条改为**可执行问题数 + 由最高严重度导出的状态词**：

```text
HEALTHY           无 warning 及以上
NEEDS ATTENTION   有 warning，无 critical
CRITICAL          有 critical
```

这也更贴合 North Star（§9）。

---

# 8. Roadmap

## 8.1 MVP

```text
P0     doctor · list · explain · overlap
P0.5   snapshot · diff · --json
P1     CI · cost · security
       + 漏斗补上观察者维度（ARCHITECTURE §1.4）
P1.5   intent-fit · --judge · fix
```

分层依据见 §5.0。直接复用现有能力：描述预算 · 上下文成本 · 覆盖冲突 · 触发数据 · 结构 · 安全 · 基线 · 脱敏。

**观察者维度为什么排进 P1**：它不是新执行环境，是补回漏斗一直缺的一维——`Loaded`
之后每一级都该带「对谁而言」。它不依赖任何新执行环境、不进双实现差分护栏的风险面
（ENGINEERING §6.8），但它是 DSH 适配器与 Phase 3 的共同前提。晚做要返工两次。
OpenClaw 的 `--agent` 求证也会从特例回归为这一维的正常取值。

### DSH 相关工作不进 P0–P1.5 主线

DSH 的两项工作各有依赖，单独排：

```text
DSH-1  dsh bundle 上架          可与 P1 并行；约 20 行 JS，无扫描器副本
DSH-2  dsh harness adapter         双维护下写两遍（Python + Rust），排在 Rust 稳定之后
```

**DSH-2 的排期在「保留 Python、双维护永久并行」修订下重新表述（2026-08）。**不再有
「Rust 替换 Python」的退出点，所以「排在 Rust 之后只写一遍」的前提消失——dsh 适配器
**始终写两遍**，并永久增加一个 `differential` 变红的来源。排期改为「Rust 侧稳定
（golden 全绿、双维护护栏就位）之后」开工，而不是等一个不存在的「替换」时刻。

代价是 DSH 用户多等一个周期（等 Rust 稳定），且 DSH-2 的双实现成本是永久的。见 §8.2。

**P0 必须自成闭环**——用户跑完 `doctor → list → explain` 应当已经能采取行动，不依赖任何后续层。若 P0 做不到这一点，说明诊断本身不够准，此时往后加层只会放大错误。

## 8.2 阶段

**Phase 1 — Skill Health**（当前）
> *Why didn't my Skill work?*
Discovery · Loaded · Budget · Usage · Overlap · Shadowing · Security

**Phase 2 — Skill Intelligence**
> *Which Skills are actually worth keeping?*
Intent Fit · Context Efficiency · Skill Coverage · Regression

**Phase 3 — Agent Capability Observability**
对象从 Skill 扩展到 Skill / MCP / Tool / Memory / Context：

```text
Agent Vitals
├── Agent Vitals
├── MCP Vitals
├── Tool Vitals
├── Memory Vitals
└── Context Vitals
```

> **首发执行环境是 dsh，不是 Claude Code。** 两条理由：
>
> 1. **边际成本**。DSH 的工具注册表与技能注册表是同一个模型——同样的分层、
>    同样的近层覆盖远层、同样的层内 rank 决胜（其文档原话：skills registry 是
>    "the shape the tools registry established"）。在 Claude Code 上
>    Agent Vitals → Tool Vitals 是两套新逻辑；在 DSH 上是同一套逻辑换个注册表。
> 2. **问题是否真实存在**。DSH 的 preset / scope 让每个 agent 的能力集**真的
>    不一样**，「我这个 agent 到底拥有什么能力」在那里是个有确定答案的实问题；
>    在 Claude Code 上它更接近一个概念。
>
> 反过来也成立：**不要拿 Phase 1 的姿势进 DSH。** Phase 1 的卖点是静默预算溢出，
> 而 DSH 从设计上就没有这个失效模式（无全局预算，改为逐条截断）。用 Phase 1
> 的话术进入 DSH，是在卖一个它没有的病。

**Phase 4 — Agent Capability Governance**（企业方向，未验证）
企业关心的不是「我装了多少 Skill」，而是「我的 Agent 到底拥有什么能力」：
Capability Registry · Approved Skills · Version · Security · Usage · Cost · Policy

> 记在这里是为了不丢失方向，不是排期。Phase 1 未被验证之前，它对当前决策没有任何约束力。

## 8.3 三条护城河

语言、CLI 手感、渲染都不是护城河——它们可被复制且跨语言可移植（ENGINEERING §1.5）。真正会累积的是三样：

1. **Capability Model** —— Skill Execution Funnel 这套「能力为什么没生效」的分解方式（ARCHITECTURE §1）
2. **Diagnostic Knowledge** —— 诊断规则与文案：SV*** 码、阈值、措辞纪律。**这是唯一一条现在就在增长的**
3. **Historical Dataset** —— 长期积累的 Skill × Description × Cost × Conflict × Trigger × Success 序列

第 3 条有一个与 ARCHITECTURE §8 隐私模型的硬约束：**它只能是本地的**。快照留在用户机器上，因此这份数据集是每个用户自己的，不是我们的。放弃「聚合用户数据形成壁垒」这条路是刻意的——一个审计供应链风险的工具不能自己回传数据。

## 8.4 分发（要点）

**npm 为主推渠道**——Node 在目标 Agent CLI 用户中具有极高覆盖率（Claude Code 自身即 npm 分发）：

```bash
npx agent-vitals        # 零安装试用，转化率天花板
```

**dsh 是形态不同的第六条渠道**：不是二进制、不是 npm 包、也不是 skill 目录，
而是一个 profile layer（`package.json` 声明 `dsh.bundle.patch`，用
`dsh plugin --profile <name> add` 安装）。它只能发 npm 预构建——从 git 安装会
触发 `prepare`，而 pnpm ≥10 要求用户显式 `allowBuilds` 授权，DSH 官方文档把这
件事定性为「安装期在任何沙箱之外执行该包的代码」。**一个审计供应链风险的工具
要求这个授权是自相矛盾的**，这与 ENGINEERING §6.2 禁用 postinstall 是同一条原则。

完整方案见 [ENGINEERING.md](./ENGINEERING.md)。

---

# 9. 成功指标

**不以「扫描了多少检查项」作为成功标准。**

早期核心指标：

> **Diagnosed actionable problems**
> 找到并帮助用户理解了多少个真正可采取行动的问题。

| 指标 | 定义 |
|---|---|
| Activation | 安装后是否运行了 `doctor` |
| Discovery | 多少用户首次扫描就发现了真实问题 |
| **Actionability** | 是否据此删除 skill / 改描述 / 修 shadowing / 降成本 |
| Repeat | 是否再次运行（`diff` 是唯一自然复访路径） |
| CI Adoption | 是否有人把它加进 skill repo 的 CI |

**长期 North Star：** *Capabilities observed.*

---

# 10. 未决问题（产品侧）

1. **`explain` 对未加载 skill 的成本展示口径**——它不占上下文，但用户想知道「修好了会花多少」。倾向：展示但标注「当前未生效」。
2. **`overlap` Layer 1 的阈值**——Jaccard 0.60 是拍的。需在真实技能库上标注一批样本反推，否则 candidates 列表要么全是噪声要么空。
3. **`SV203` orphaned usage record 的呈现**——`skillUsage` 里有、磁盘上没有的记录，既可能说明用户真实高频用法，也可能只是改过名（改名会切断触发历史）。两者要能区分。
4. **多执行环境并存时的默认 scope**——只报 Claude Code 还是全报？倾向默认全扫描但按执行环境分组，预算只对 Claude Code 计算。
