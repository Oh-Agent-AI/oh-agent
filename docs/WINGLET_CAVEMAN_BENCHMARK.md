# Winglet 与 Caveman 对比研究

> 研究日期：2026-09-01。来源：[AgentWinglet/agent-winglet](https://github.com/AgentWinglet/agent-winglet)
> 与 [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman)（后者已 `git clone --depth 1`
> 到本地逐行核实，HEAD `df2ccd8` "Merge PR #930"；前者未 clone，仅有网页层信息）。
> **本文所有 Caveman 代码/文档引用均对照本地 clone，不是 README 转述**；克隆不含
> 未推送的 HEAD，raw benchmark artifacts 按作者自述未入库（见 §3.2）。
> 结论只写到「建议 + 取舍」，落地动作需单独评估。

## 0. 一句话

Winglet 在带内（PostToolUse hook）对**每次工具调用刚产生的输出**做去重/裁剪/退役，
工程诚实度**高于**我初判：有 SWE-bench 实测、质量数字是双侧区间、终端收据只报字节
不报钱；但它的"省了 X%"是**单边收据**（只算裁掉的字节，不算总会话成本），用户真正
关心的"总账单省了多少"它无法回答。Caveman 是同一个"带内省 token"格子里更重的
**工程化版本**——用 proxy 站在组装后的请求体上，把"可还原、可验账、负样本可见"做成了
类型系统与代码门控，甚至把"证明省了钱"本身做成了收费商品。两者都**不做**本产品的
判断层（skill 库健康度 / 该不该存在），所以它们更靠谱也不改变本产品的站位。

## 1. Winglet：hook 单边收据，省字节不等于省账单

- **机制**：PostToolUse hook 拦截每次工具调用刚产生的输出——重复 Bash 命令去重为
  `[unchanged since turn N]`、长输出裁头尾、investigate 输出退役为磁盘 receipt、
  过界后建议 `/compact`。改的是 `updatedToolOutput` 字段，**只对"本次调用刚产出、还没
  进入上下文"的内容生效**（代码反复声明 "A PostToolUse hook can never rewrite a call
  already delivered"）。它不压缩请求体，所以不需要 proxy。
- **它有真基准**：README 列 SWE-bench Verified + Multi-SWE-bench Flash 实测——使用
  节省 26.7%–56.0%、计算成本 21.1%–35.9%、质量变化 **-1.0% 到 +2.0%**（双侧，含负向）。
- **工程诚实的一面**：`receiptMessage` 明说"no measurement of total session cost
  exists (paired-run test came back inconclusive)"——所以终端收据只报原始裁掉字节数、
  绝不报钱；桌面 app 的钱数是"已裁字节 × 单价"的换算，不是重新测量总账单，且自带
  caveat。
- **问题（PM 视角）**：
  1. **维度错位**：它报告的"裁掉多少字节"是 `measured`（真的量了），但不是用户想要的
     "总账单省了多少"——后者需要总会话成本基线，而它自己承认配对测试无结论。这是
     `measured ≠ billable/causal` 的实例（见 §2.4 标签语义）。
  2. 单价是汇率不是常数（DeepSeek 2026-08 涨价、LLMflation 使单位价每年降 ~10×），
     烤死在 build 时的价格会过期——除非像它那样只报字节、把换算留在带 caveat 的 app。
  3. 订阅模型下省 token 根本不省钱——"让订阅多走 50%"翻译过来是"同一份订阅干更多活"，
     这是价值提升，不是省钱；按量用户"省钱"是真的，但单价会烂。
  4. 看不见的质量成本：被裁的轨迹可能恰好是 agent 下一步判断的依据（它用相位边界
     缓解——过 investigate→implement 边界后才退役，boundary 前只做头尾裁剪，且失败/
     中断/镜像/带 stderr 的输出一律不碰——这比初判谨慎得多，但没有 Caveman rewriter
     那种逐字段存活门控）。

结论：**工程诚实度中上（有基准、有字节-only 纪律），但"省了多少钱"的感知建立在
单边收据上，作为留存/增长机制合理，作为总账记账不合理。**（详见 `docs/PRODUCT.md`
与当时的产品辩论；本文件不重复展开。）

## 2. Caveman：同格子的工程化诚实

口号 "why use many token when few do trick"。两条路径：**response skill**（MIT，教
agent 用穴居人语回答，只省输出 token）与 **local runtime / proxy**（BSL-1.1，压缩
agent *读入*的工具输出/日志/JSON，本地 SQLite 存原字节可还原）。102k stars。

**规模**（本地 clone 实测）：Go 131,435 行、TS/JS 100,406 行、Python 15,445 行，
25MB checkout。这不是 README 那个"轻量瘦身"的皮，是个大型工程。

### 2.1 S0–S4 安全分级——诚实是类型行为（`engine/safety/safety.go`）

每个压缩器必须声明一个安全类，类在注册表里决定了诚实契约：

| 类 | 语义 | 强制要求 |
|---|---|---|
| S0/S1 | 字节安全（元数据 / provider-native 缓存提示） | 不改模型可见字节 |
| S2 | 需 SDK 合作的结构变化 | 模型可见但可逆 |
| S3 | 行为变化（路由/推理） | 不可逆，需 eval 门控 |
| **S4** | **lossy 结构压缩** | **`RequiresCCR: true`——必须存原字节才准跑，且必须披露丢弃了什么** |

关键：`RequiresCCR` 写在类型注册表里，不是某个函数记得检查。**任何 lossy 压缩器
不先存原字节就跑不起来**——这就是本仓库 `evidence.rs`"adapter 不得用读不到的东西
刷覆盖"的镜像，但做成了不可绕过的编译器行为。

### 2.2 CCR——content-addressed 字节还原（`engine/ccr/store.go`）

- handle 是原字节的 sha256 → 幂等（同 payload 压两次同 handle、只存一次）。
- **先存后压**：压缩前把 exact original 写进本地 SQLite（js/wasm 下是纯 Go in-memory
  map，平台分裂但同一接口）。
- 存储超预算 → `ErrBudgetExceeded`，**拒绝发布 lossy 字节、原样 pass through**。
- 未知 handle 显式 miss——`The store never guesses a recovery`。宁可不省，绝不破坏。

### 2.3 rewriter 验收门控——防呆核心（`rewriter/gate.go`）

`Accept(original, rewritten, θ)` 是纯函数（no clock/network/state），拒绝即保留原块，
**任何一项不过就整块不过**。注释自述设计动机：

> The only unsafe direction is accepting a rewrite that dropped a failure the
> agent still has to act on: that turns a token saving into a silent wrong turn,
> which is the failure class this whole component exists to avoid.

门控的具体规则（全部字节级）：

- failure signal 必须存活（`fail/error/panic/fatal/timeout/denied/…`，原文本有、
  改写后无 → 拒绝）；
- tally 数字**带名词**存活（`5 failed` 改成 `1 failed` 不算——"keeps every signal
  word and still lies about the size of the problem"）；
- 非零 `exit code N` / `exit status N` 必须存活；
- `path:line:col` 源文件定位**无条件**保护（即使所在行无失败词），
  CPython `File "...", line N`、tsc/MSVC `path.ext(line,col)` 均在内；
- 失败行整行逐字保留，`"error"` 一词不能代表多个不同失败。

### 2.4 证据标签体系——数字不可通过措辞互相转化

`docs/technical/accounting-and-evidence.md` 定义 7 个 basis：

```
measured · inferred · provider_reported · benchmark_counterfactual
· observed · verified · unpriced
```

每条的"是什么 / 不是什么"明确列出（如 `measured` ≠ billable/causal；
`benchmark_counterfactual` ≠ production savings；`unpriced` ≠ zero cost）。
`verified` 是**保留给连接态**的词——本地运行时永不铸造。成本显示是
`provider-reported or explicitly selected token units × dated public catalog rate`，
且明说 **"This is not an invoice"**（可能因协议价/订阅/区域价/缓存/积分/税而异）。

### 2.5 已发布的实测数字与它们的边界

**33.2% 输入缩减**（`docs/WRAP-BENCHMARK.md`）：

- 6 个确定性 fixture（log/JSON/CSV/test-output/YAML/HTML，各 60–95KB），54 次 agent
  run（每臂每例 3 次），18 对直接/Caveman 配对；`claude-sonnet-5`；provider
  `modelUsage` 计数，`input_tokens + cache_read + cache_creation` 求和。
- 结果：885,793 → 591,673 tokens（-33.2%），case-clustered 95% CI 14.6%–48.5%；
  exact-answer 18/18。
- **负样本未藏**：HTML 例 **-9.9%（更差）** 保留在表里，"unsupported and no-op
  inputs stay in the aggregate"。
- **对照组 15/18 失败可见**：Headroom wrap 三例 YAML 未过 exact-answer 门，不计数。
- **主动声明不可复现**："published report and provenance hashes, but not raw
  harness or run artifacts… Treat result as pinned report, not reproducible public
  benchmark"。CI 无独立复现路径——这是它的诚实缺口，也是我们克隆后无法自己跑
  验证的原因（本地无 Go 工具链亦未跑测试）。
- 全部 provenance（corpus/skill/harness/MCP binary/Claude binary/harness commit SHA）
  以 SHA-256 列出。

**response skill 的输出缩减**：**不发布**。`skills/caveman/README.md` 与
`HONEST-NUMBERS.md` 明说 "No reduction or quality-equivalence claim is published"。
`evals/` 的对照是 `__terse__` 控制臂（不是空 baseline——避免把"答简洁点"的通用效果
算成技能功劳），快照已提交 git（2026-04-08，claude-opus-4-6，10 prompts），
`measure.py` 用 tiktoken o200k_base（自认是 Claude tokenizer 的近似，只比比例不比
绝对值）。快照里技能输出确实明显更短（如 React re-render 解释 baseline ~300 tokens
→ caveman ~60 tokens），但**未经质量等价评审**，仓库明确不发布该数字。

**skill 的输入代价**：每轮 +~1–1.5k 输入 token（SKILL.md 规则 + 技能清单常驻）。
`HONEST-NUMBERS.md` 列了三个净亏案例：issue #145（terse 负载净亏）、#506（Copilot
按 request 计费，省输出不省 request）、#550（Cursor 实测 4.3M vs 1M tokens 且墙钟
时间翻倍，不可复现故只当警告）。**结论：本地 A/B 若净亏就关掉。**

### 2.6 商业化：we give away the tool, we sell the proof

`ANNOUNCEMENT.md` 心法原句：**"We give away the tool, we sell the proof."**
免费层只给 `inferred` 节省；`verified`（真实流量 eval gate + 质量守卫 + 自动回滚 +
签名计量）是 Cloud 收费点。许可证：MIT 覆盖 skill/CLI/SDK/evals/contracts（漏斗），
BSL-1.1 覆盖 engine/proxy/cacheengine/rewriter/browse/mcp/shrink（引擎 IP），
BSL 四年后自动转 Apache-2.0，Additional Use Grant 允许第一方自托管生产免费。

### 2.7 我们不学的东西

- **Pixel 模式**（`engine/pixel/`）：把历史对话渲染成图片喂视觉模型。这是数据质量
  换 token 数（Goodhart），TOON（`toon_encode.go`，`LosslessToModel: true` 的无损重
  编码）可学，pixel 不可学。工程上它如实标了 S4 lossy + 可还原，但本产品立场是
  "量不到就不报"，图片化让模型"看"文字是换了一个不诚实的量纲。

## 3. 重叠地图与差异

| 维度 | Winglet | Caveman | 本产品 |
|---|---|---|---|
| 层 | 带内轨迹编辑（PostToolUse hook） | 带内压缩 proxy | 诊断/处方（不带内） |
| 是否可验账 | 单边收据（只报裁掉字节；质量有 SWE-bench 双侧区间） | 是（basis 标签 + CCR + 负样本） | 是（measured 纪律 + golden 锁） |
| 是否做判断层 | 否 | 否 | **是**（SV 码 / plan / 冲突 / 僵尸） |
| "省钱"呈现 | 每次调用省 X%（`measured`，但非 `billable`） | provider_reported 基准 + inferred 本地 | measured 每事件 + 月度账本（规划） |
| 诚实形态 | 声明 + 基准 + 字节-only 纪律 | **类型 + 门控 + 标签** | 纪律 + 测试 |

**互补而非竞争**：Caveman 压缩"你确实要读的东西"；本产品判断"这个东西到底要不要
存在"。两者叠加成立——一个用户可以先跑 `plan` 决定删/拆/裁，再把真正要读的内容
交给 Caveman 类运行时压缩。

## 4. 可落地动作（按价值排序，全部需单独评估）

### A. 学：把 plan 的诚实性规则从 docstring 升级为类型/门控（中价值，中成本）

`plan.rs` 现在靠 docstring + 测试钉住"savings_per_event 必须测量"等规则。参考
S0–S4 注册表，把 `SavingsPerEvent` 做成一个"只能由报告字段构造、不能由模型手工
捏造"的类型；`events_per_month` 只能来自 `--startup-rate`。这不改变行为，但把
"诚实"从约定变成编译器拒绝。

### B. 学：证据 basis 标签进 plan 输出（低价值，低成本）

plan 的 `rationale` 目前是散文。可以给每个 item 加一个 `basis` 字段
（`measured` / `estimated` / `unavailable`），并像 Caveman 一样写死
"标签不因措辞转化"。我们的 `measured_lifetime_triggers` vs `events_per_month`
已经隐含这个区分，显式化即可。

### C. 学：负样本与不可复现主动披露（低价值，低成本）

Caveman 把 -9.9% 的失败案例和"不可独立复现"写进基准文档。我们的 golden 测试是
字节级锁，但报告层没有"这一数字在什么范围内有效、哪些样本失败"的显式声明。
可在 `plan`/`doctor` 输出加一句 scope 声明。

### D. 不学（暂不）：带内执行器

Caveman 的 proxy 正是 plan 文档"后续"里的"带内执行器"位。它证明这条路技术上走得通，
但没推翻"审计者不成为参与者"的设计姿态。我们的判断层是它没有的东西，先守住。

### E. 存档为基准坐标（零成本）

本文作为 Winglet/Caveman 的能力基线存档；未来任何"我们也来做运行时省 token"的
提议，以本文 §2.7 + §4-D 为对照，避免重复造轮子或引入反事实数字。

## 5. 与产品辩论的关系

本文件回答"用户如何感知省钱"时的两个坐标：

- Winglet 是**单边收据坐标**（`measured` 裁字节 ≠ `billable` 省账单，且"省了多少钱"的
  感知建立在不可复核的配对测试之上 → 不能作为我们的目标）；
- Caveman 是**工程化诚实坐标**（可验账 → 证明了"运行时省钱"可以做得诚实，但那是
  带内格子，不是判断格子）。我们的路线图（plan → 月度对账，`docs/PRODUCT.md`）
  站的是"判断层的可验账"，与 Caveman 的"执行层的可验账"互补。
