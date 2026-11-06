# Agent Vitals — 接入 DeepSeek Harness

配套文档：[ARCHITECTURE.md](./ARCHITECTURE.md)（漏斗 / 观察者维度 / reconcile 语义） · [HARNESS_ADAPTER_CONTRACT.md](./HARNESS_ADAPTER_CONTRACT.md)（DSH 适配器契约） · [ENGINEERING.md](./ENGINEERING.md)（§6.6.1 bundle 分发） · [PRODUCT.md](./PRODUCT.md)（§8 排期）

状态：设计，未实施。基线 deepseek-harness `47f9438`（0.1.0-rc.5），agent-vitals `54ef35e`。

---

# 0. 结论

DSH 接入是**两件互不依赖的事**，不要当成一件做：

| | 方向 | 产物 | 排期 |
|---|---|---|---|
| **DSH-1 分发** | agent-vitals → DSH | `dsh-agent-vitals` bundle，让 DSH 用户装得上 | 可与 P1 并行 |
| **DSH-2 能力** | DSH → agent-vitals | `dsh` 执行环境适配器，让 DSH 自己被体检 | Rust 侧稳定之后（双维护，§5） |

DSH-1 约 20 行 JS，一天。DSH-2 是真正的工作，**排在 Rust 侧稳定之后**（§5），且双维护下写两遍。

还有第三件事已经先做了：DSH 暴露出漏斗缺一维，该修正与 DSH 无关也成立，
已并入 [ARCHITECTURE §1.4](./ARCHITECTURE.md) 与 [契约的 observer 一节](./HARNESS_ADAPTER_CONTRACT.md)，排进 P1。

---

# 1. DSH 的 skill 模型与前五个执行环境差在哪

相同的部分：`SKILL.md` 格式、YAML frontmatter、渐进式披露、目录发现。
**所以静态测量——上下文成本、安全扫描、语义重叠、结构检查——一行不用改。**

不同的部分，逐条对应到源码：

| 差异 | 后果 | 源码 |
|---|---|---|
| 无全局描述预算，改为逐条截断 500 字符 | **SV001/SV002 在 DSH 上不成立**，需要一条新发现 | `tool-skill/src/index.ts:391` |
| 二维覆盖：先 scope 层、后 rank | 一维模型会把有意覆盖判成冗余副本 | `skill/src/index.ts:552-566` |
| provider 注册表可插拔，可为远程源 | **磁盘扫描结构性不足**：目录是运行时产物 | `skill/src/index.ts:391` |
| 发现不完整时**整轮不发布目录** | 一个 provider 慢 → 全部 skill 一起消失 | `tool-skill/src/index.ts:224` |
| `skill` 工具被 scope 遮蔽 → 目录为空 | 磁盘毫无异常 | `tool-skill/src/index.ts:223` |
| `modelInvocable` / `userInvocable` 二分 | 用户能调，模型永远选不到 | `skill/src/index.ts:48-53` |
| 每个 agent / preset 目录不同 | 「换个 agent 就不行」 | 同上 552-566 |
| 目录中途重发（digest 变化时） | 生效延后一轮；重载窗口内可能整轮不发布，见 §2.4 | `tool-skill/src/index.ts:224,307` |

**这八条里有五条完全发生在运行时，磁盘上看不出来。** Claude Code 的招牌失效
（预算溢出）至少还能从磁盘算出来；DSH 的这五条一条都不能。这决定了适配器的形态。

---

# 2. 两个证据源，先做便宜的那个

DSH 是第一个**不需要执行环境在跑就能拿到权威历史**的执行环境。

| 证据源 | 回答 | recency | 需要 DSH 在跑 | 成本 |
|---|---|---|---|---|
| **会话日志** | 当时那一轮向模型发布了什么、谁被调用过 | `log` | **否** | 逐行读 JSONL（默认，可能 zstd 压缩） |
| 注册表快照 | 此刻这个 scope 解析出什么 | `probe` | 是 | 我们的 bundle 挂 glue plugin（树外，不改 DSH 仓库） |

## 2.1 会话日志是主路径

`tool-skill/src/index.ts:361-377`：

```ts
const visible = new Set(agent.session.surface.nodes)
const events = agent.session.events
for (let index = events.length - 1; index >= 0; index -= 1) {
  if (event.type !== 'user/message' || event.data.source.kind !== 'skill-catalog') continue
  const entries = readCatalogEntries(event.data.source)
  ...
}
```

每一次目录发布都是会话事件流里的一条持久消息，**带着那一刻发布的确切条目**
（名字 + 截断后的描述）；`surface.nodes` 还标了哪些在压缩后仍然可见；用户显式
调用是另一条 `skill-invocation` 消息。默认持久化在 `session-persistence-jsonl`
（JSONL 文件：`<DSH_HOME>/sessions/<project>/<id>/session.jsonl[.zstd]`，每行一个
`SessionEvent` JSON）。SQLite 是**备选**后端（`session-persistence-sqlite`，未默认挂载）；
`session-query-sqlite` 只是可选 FTS 搜索索引（默认 `openAt: never` 关闭）。离线读的是
JSONL 会话日志，不是 SQLite。

**用户真正会问的「我的 skill 为什么没触发」，答案在这里，而且是离线可查的**——
那台机器上的 agent 早就退出了，答案还在库里。

这条路径不需要往 DSH 里塞任何东西，是纯读。**先做它。**

## 2.2 注册表快照是补充

`ctx.skills.snapshot()` 回答「此刻这个 scope 有什么」。写快照的插件住在**我们自己的
`dsh-agent-vitals` bundle** 里（树外 glue plugin，`dsh plugin add` 安装，deepseek-harness
仓库零改动）：监听 `skills/change`，把 `{skills, complete}` 写到
`$DSH_HOME/agent-vitals/snapshot.json`，scanner 用 `--runtime-json <file>` 摄入。

**不要模仿 Codex 适配器去 spawn 执行环境。** DSH 是插件运行时，反过来做更稳：没有
子进程、没有超时、没有 JSONL 解析，Codex 那五类失败模式一个都不存在。

映射规则见[契约的 DSH 一节](./HARNESS_ADAPTER_CONTRACT.md)。要点：`complete === false`
时全部降级为 `unknown`，**不是 `false`**——因为 DSH 在发现不完整的那一轮
根本不发布目录，这不是「部分答案」，而是「这一轮所有 skill 对模型都不可见」。

### 2.2.1 快照插件的具体设计

**插件形态**：扩展现有 `dsh/index.js`（DSH-1 的 glue plugin），在同一个 `apply(ctx)` 里
加一段快照写入——不新增第二个插件、不新增第二个 patch row。

```js
export const inject = ['skills']
export function apply(ctx) {
  // DSH-1：注册 skill provider（已有，略）
  ctx.skills.registerProvider(() => ({ /* ... */ }))

  // DSH-2 贵一半：快照写入（纯 JS，不依赖扫描器二进制）
  const write = async () => {
    try {
      const snap = await ctx.skills.snapshot({})        // v1：全局 scope，无 observer
      await writeFile(snapshotPath, JSON.stringify({
        schema_version: '1.0',
        producer: 'dsh-agent-vitals',
        observer: null,                                  // v1：全局 scope，见下
        skills: snap.skills,                             // SkillSummary[]（name/description/…）
        complete: snap.complete,
        written_at: new Date().toISOString(),            // 新鲜度时间戳
      }))
    } catch (e) {
      ctx.logger?.warn(`agent-vitals snapshot write failed: ${e}`)
    }
  }
  void write()                                // apply 时写一次（初始快照）
  ctx.on('skills/change', () => void write()) // 目录变就重写（保持新鲜，零轮询）
}
```

（`snapshotPath` 取 DSH home 路径下的 `agent-vitals/snapshot.json`，具体 API 实现时
确认——插件运行在 Cordis 上下文里，有 `ctx.baseUrl`/home 路径服务可用。）

**写入位置**：`$DSH_HOME/agent-vitals/snapshot.json`（固定路径，scanner 好找）。

**新鲜度**：`written_at` 是 ISO8601 时间戳。scanner 读快照后把它当「最近一次快照」
（`evidence_recency="probe"`），`observed_at = written_at`——报告带时间坐标，不与
`log` 证据并排时在时间上撒谎（§2.3 的同一纪律）。

**scope/observer（v1 简化）**：快照取全局 scope（`snapshot({})`，`observer=null`）。
per-agent / preset scope 需要枚举 scope 链，留到后续——那时快照里填真实 observer，
并可能按 observer 写多份快照。

**降级**：插件写失败只 log、不崩溃（快照是补充证据，不是主路径）。scanner 侧：
文件缺失/畸形 → `unavailable`；`complete===false` → 全部 `unknown`（不是 `false`）。

### 2.2.2 scanner 侧摄入契约（`--runtime-json`）

`--runtime-json <file>` 摄入上面的快照。映射（对齐契约）：

| 快照状态 | scanner 侧 `loaded` 判定 |
|---|---|
| 存在、`complete===true` | `loaded = skills` 里的成员；`evidence_recency="probe"`，`observed_at=written_at` |
| 存在、`complete===false` | 全部 `loaded = unknown`（不是 false） |
| 缺失 / 畸形 / schema 不符 | `unavailable`，绝不报 0 次 |

## 2.3 两者不可混为一谈

这是新增 `evidence_recency` 字段的原因（[契约](./HARNESS_ADAPTER_CONTRACT.md)）。
一个月前的 `log` 证据说明不了现在，与 `probe` 证据并排渲染而不带时间坐标，
报告就开始在时间上撒谎。对应的 reconcile 语义是 [ARCHITECTURE §4.1](./ARCHITECTURE.md) 新增的第三种：`historical`。

## 2.4 热重载：目录是「上一轮的快照」，不是磁盘的镜像

DSH 支持 skill 热加载，链路是：chokidar 检测（稳定阈值默认 200ms）→ provider
`invalidate()` → 注册表 `revision++` 并发 `skills/change` → **下一次
`agent/pre-step`** 重算 digest → 变了才重发目录，且在消息窗口内是**原地替换**
那条目录消息而非追加。

设计是干净的，但有三条边界会变成用户口中的「改了不生效」：

| # | 边界 | 源码 | 磁盘可见 |
|---|---|---|---|
| 1 | 生效时机是**下一轮**，当轮不可见 | `tool-skill/src/index.ts:213` | – |
| 2 | 重载窗口内 `!complete` → **整轮不发布目录**，模型看到的是旧版本，且不报错 | `tool-skill/src/index.ts:224` | – |
| 3 | `watchMaxProjects`（默认 128）按插入顺序 **LRU 静默驱逐**，被驱逐的 project 根停止监听 | `skill-filesystem/src/index.ts:318-329` | **是** |

第 3 条是「有时候热加载生效、有时候不生效」的确切原因，对在很多仓库之间切换的
用户尤其常见。

**对适配器的两点影响**：

- **配置类证据不受 §5 排期约束。** `watch` / `watchMaxProjects` / `watchUsePolling`
  / `watchStabilityThresholdMs` 都在 profile 的 cordis 配置里，**磁盘可读**，
  不需要运行时证据也不需要 DSH 在跑。这是 DSH-2 中唯一可以提前做的部分。
- **扫描与目录的不一致是正常的。** agent-vitals 扫的是时刻 T 的磁盘，DSH 的目录
  是上一轮 pre-step 的快照。报告必须能表达这个差而不是把它报成冲突——这正是
  `evidence_recency` 存在的理由（§2.3）。

新增诊断码候选：**热重载不可达**（监听关闭，或该 project 根已被 LRU 驱逐）。
它与 SV101 不是一回事——SV101 是有两份副本互相遮蔽，这一条是只有一份、
但执行环境根本没看见改动。

---

# 3. 适配器要改哪些（DSH-2）

## 3.1 agent-vitals 侧

| # | 改动 | 位置 |
|---|---|---|
| A1 | `--harness` 增加 `dsh` | `cli.py:88` 与 `cli.py:152` **两处**（主 parser + 子命令循环） |
| A2 | `DEFAULT_ROOTS` 增加 dsh 根 | `cli.py:65`，根表见[契约](./HARNESS_ADAPTER_CONTRACT.md) |
| A3 | `classify()` 增加 dsh 分支 | `discovery.py:38` |
| A4 | `scan_skill_dir()` 的 loaded 判定 | `discovery.py:108`；磁盘只能证明 discoverable，`loaded` 留给证据 |
| A5 | `conflict_domain` 加 dsh 规则 | `discovery.py:202`，层必须进 domain |
| A6 | **`level_rank()` 改成二维** | `analysis.py:4-16`；注意 `compat.py:12` 把它作为公开面导出 |
| A7 | **跨层重名不算冲突** | `analysis.py:31`；只有同层重名才进冲突判定 |
| A8 | 预算能力显式不可用 + 新增截断发现 | `analysis.py:62` 走 `not available` 分支；**新码不能用 SV003**（已被「不予判断」表占用），用 SV004 |
| A9 | 触发证据换源到会话库 | `analysis.py:113` 现在硬编码 claude-code |
| A10 | 新建 `adapters/dsh.py` | 会话库查询 + `--runtime-json` 摄入 |
| A11 | `--runtime-json` 参数 | `cli.py` + `inventory.py:23` |
| A12 | doctor / explain / report / redact / snapshots 的 dsh 分支 | 各自文件 |

## 3.2 测试与 golden

| # | 改动 |
|---|---|
| C1 | `fixtures/generate.py:84` 造 dsh 目录树，**必须同时有同层重名与跨层重名**，否则 A7 没法验 |
| C2 | `tests/golden_runner.py:56` 场景表加 `harness-dsh` + `golden/harness-dsh.json` |
| C3 | 手写会话库 fixture（complete / incomplete 两版），CI 不得依赖真跑 DSH |
| C4 | 降级用例：证据缺失 / 畸形 / schema 不符，只降级对应能力，不丢磁盘测量与安全发现 |
| C5 | 脱敏：`observer`、`session_id`、`instance_root` 等新字段必须进 `redact.py`，`test_properties.py` 的性质覆盖任意深度 |
| C6 | A6 改了返回类型 → `test_characterization.py` 的精确值同步 |

## 3.3 Rust 侧

新建 `src/dsh.rs`，改 `harness.rs` / `discovery.rs` / `inventory.rs` / `analysis.rs` / `main.rs`；
`level_rank_for`（`main.rs:44`）从 `u8` 换成元组。

**双维护下写两遍（Python + Rust）**——永久差分护栏（§6.8）意味着每个执行环境适配器都要在两个实现里逐字节对齐，这正是 §5 的理由。

---

# 4. DSH-1：bundle 形态

完整约束见 [ENGINEERING §6.6.1](./ENGINEERING.md)。要点：

```
agent-vitals/
├── SKILL.md          ← 前五个执行环境，不动
├── scripts/          ← 扫描器，不动
└── dsh/              ← 新增
    ├── package.json      name: dsh-agent-vitals；dsh.bundle.patch；无 build
    ├── cordis.patch.yml  一行 insert row
    └── index.js          约 20 行，resourceBase 指向 ../，调 PATH 上的二进制
```

三条硬约束：**只发 npm 预构建**（git 安装需要 `allowBuilds`，等于安装期沙箱外
执行代码，与本工具的定位自相矛盾）、**不带扫描器副本**、**不做构建步骤**。

发布后给仓库打 GitHub `dsh-plugin` topic。

> **DSH-2 落地后，DSH-1 的 SKILL.md 不再声明 dsh 不是被体检的执行环境**——该声明
> 已随适配器就位解除。`--harness dsh` 现在是正规入口；`--path` 指向 dsh 的 skill
> 根仍会绕过运行时的 scope/rank 解析，结论不可靠，应改用 `--harness dsh`。

---

# 5. 为什么 DSH-2 排在 Rust 稳定之后（双维护下写两遍）

2026-08 修订（双实现永久并行）后，两条「硬约束」的表述变了，但结论仍在：

1. `RUST_PORT_PLAN.md` 的 entry criteria 已达成、Rust 侧已收敛（golden 12/12
   逐字节一致）。多一个执行环境**不再**推后 entry criteria —— 它已经过了。
2. ENGINEERING §6.8 的并行维护期是**永久的**（双实现保留）。每个执行环境适配器
   **写两遍**（Python + Rust），且永久增加一个 differential 变红的来源。

所以 DSH-2 的开工时点是「Rust 侧稳定之后」，而不是等一个不存在的「Rust 替换
Python」时刻。

代价是 DSH 用户多等一个周期。**可以接受**：Phase 1 的卖点（静默预算溢出）在
DSH 上本来就不成立，他们等的不是自己的痛点。

---

# 6. 进入 DSH 的正确姿势是 Phase 3

见 [PRODUCT §8.2](./PRODUCT.md)。摘要：

- DSH 的**工具注册表与技能注册表是同一个模型**，Agent Vitals → Tool Vitals 在
  DSH 上是同一套逻辑换个注册表，在 Claude Code 上是两套新逻辑；
- DSH 的 preset / scope 让每个 agent 的能力集真的不一样，「我这个 agent 到底
  拥有什么能力」在那里是实问题；
- 反过来，用 Phase 1 的话术进 DSH 是在卖一个它没有的病。

---

# 7. `watch` 在 DSH 上是另一种东西

见 [PRODUCT §5.8](./PRODUCT.md)。一句话：在 DSH 上监听 skill 目录是重复劳动
（DSH 自己就在用 chokidar 监听并按 digest 去重后落库），正确的监听对象是
**会话事件流**——成本是一个游标，而且能看到「这一轮因发现不完整整个目录未发布」
这个磁盘上永远看不出来的失效。

---

# 8. 未决取舍

**（已决，2026-08）Rust 与 Python 的收敛时间点。** 双维护永久并行已定，不再有
「收敛到单实现」的时点。DSH-2 的开工只受「Rust 侧稳定」约束（见 §5）；DSH-1
不受影响（它只调 PATH 上的二进制，两种实现都行）。

**会话库的查询契约。** DSH 自述 `SESSION_FORMAT_VERSION` 为 0 且不作兼容承诺。
A9 的证据链必须在 schema 不符时降级为 `unavailable`，**绝不报 0 次**——报 0 次
会直接变成假的 SV201。这是 A9 排在 A1–A8 之后的原因：它是唯一可能被上游卡住的一环。

**`bundled` 层（rank 600）的成本口径。** 那些 skill 不在任何 skill 根里，只在
运行时证据中出现。是否计入 Tier 1 成本会改变总量口径，需要在实现前定。
