# 会话成本 Baseline(实测快照)

> 采集日期:2026-09-01。工具:本仓库 Rust 二进制 `target/release/agent-vitals`
> 的 `codex-session` / `behavior` 子命令(lockstep,与 Python 逐字节一致)。
> 观测单位 = 逻辑会话。**所有数字是聚合,不含任何原始行。**
>
> **用前必读**:DSH 语料存在**缓存 bug 时间分界**——08-18 之前命中率 ~2%,
> 之后 ~93%(下 §2)。**DSH baseline 一律限定 post-08-18**,否则被 bug 期污染。

## 1. 语料声明

| 执行环境 | 逻辑会话数 | 源文件 | 语料期 |
|---|---|---|---|
| Codex | 29 | 56 rollout | 2026-07-25 → 09-01 |
| DSH(post-08-18) | 22 | 22 zstd | 2026-08-18 → 08-31 |
| DSH(全部,仅供对照) | 59 | 59 zstd | 2026-07-25 → 08-31 |

> Claude Code 语料另见 [CLAUDE_CODE_CORPUS.md](./CLAUDE_CODE_CORPUS.md):52,326 事件 / 26,338 逻辑请求
> / 4 个模型家族,2026-08-03 → 09-02。catalog-provider 估算(2026-09-02 价表):事件级 **USD $3,542.42 + CNY ¥1,063.86**;
> 回声合并(逻辑级)后 **USD $1,883.44 + CNY ¥544.77**——执行环境计费语义不裁定,两档皆列。
> 因 basis=catalog(非账单)、无已知事故分界、语料为活快照,不并入本表;计价假设见该文档 §6。
> WorkBuddy 语料另见 [WORKBUDDY_CORPUS.md](./WORKBUDDY_CORPUS.md):22 会话 / 2,071,123 tokens
> / **harness-billed 4,307.76 credit**(credit_json 是执行环境自己的积分账单,**单位=积分非 ¥**;
> 积分↔¥ 按官方公开价标注仅作机会成本,§4 双口径:现金 ¥0),2026-07-29 → 08-23。
> 因 basis=harness-billed 积分账单(非 catalog 估算)、语料为活账本,不并入本表;计价语义见该文档 §4。

## 2. 缓存 bug 分界(DSH,实测钉死)

| 区间 | 会话 | cache-read 中位 | uncached/output | 成本合计 | 占总成本 |
|---|---|---|---|---|---|
| pre-08-18 | 30 | **1.9%** | 193× | ¥1,729.37 | 98.7% |
| post-08-18 | 22 | **93.0%** | 8× | ¥23.07 | 1.3% |

结论:DSH 08-18 前的低命中是**已修复的 bug**,不是稳态;pre-08-18 数据不得进 baseline。

## 3. Baseline 指标表

| 指标 | Codex(USD) | DSH post-08-18(CNY) | 可比性 |
|---|---|---|---|
| **cost/request 中位** | **$0.0573**(p25 $0.0399 / p75 $0.0681) | **¥0.0170**(p25 ¥0.0087 / p75 ¥0.0348) | 口径一致(计价原子单位),币种不同不比绝对值 |
| cost/request 上限 | $0.1167 | ¥0.0675 | — |
| **cost/turn 中位** | **$0.032**(spread 2.1×) | ¥0.248(仅 4 个多 turn 会话) | **Codex 可用;DSH 样本太少,不作为 baseline** |
| cache-read 占输入 | 95.7% | 93.0%(min 72.2%) | 机制相近,可横向参考 |
| uncached/output | ~12× | ~8× | 结构诊断 |
| 成本长尾集中 | top-5 占 74% | top-2 占 69%(全语料) | **两执行环境同构:长尾主导** |

### 各执行环境补充结构

- **Codex**:模型 gpt-5.6-sol ×24 / terra ×3 / auto-review ×2;legacy ×23 / paginated ×6;总成本 $832.28;cost 中位 $8.25/会话。
- **DSH post-08-18**:总成本 ¥23.07;4 个多 turn 会话占 ¥17.19,turn=1 会话占 ¥5.88(其中 12 个长任务 req≥10 占 ¥4.94)。**修复后 DSH 成本已接近可忽略**;deepseek-v4-pro 25 会话 / flash 22 会话(全语料)。

## 4. 评价优化效果的用法

1. **同量纲前后对比**:同一批任务/会话,优化前后各跑一次,比**分布分位数**(中位+p75),不比均值——成本长尾主导,均值被异常会话污染。
2. **主指标 = cost/request**(定义最稳);**辅助 = cache-read 占比**(DSH 的缓存管线健康度是最大变量)。
3. **币种隔离**:Codex USD / DSH CNY,不同币种不直接比;token 比例(unc/output、cache 占比)跨执行环境可比。
4. **token 结构做 primary,钱做 secondary**:价格表会随 LLMflation/汇率漂移,token 比例不会。

## 5. 诚实性注记

- **effort**:Codex 7 会话 None(非缺失=零,单列)。
- **恒 turn=1**:DSH 41/52 会话 turn=1,是"一次用户消息内长任务"的真实结构,不是 bug(见 `docs/COST_BASELINE.md` 讨论),但使 cost/turn 分母不可靠。
- 未做因果推断:cost/request 的稳定性是观测;修复缓存是 08-18 前后的环境变化,不在此归因。
