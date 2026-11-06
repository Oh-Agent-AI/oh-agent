# 统一成本视图范式(Unified Cost View)

> **状态**:设计底稿(Tauri 方案的前置)。DSH 为 0 号模板,Codex 为 1 号执行环境。
> 2026-08-29 修订:核心主张从「给 codex 做适配」升级为「统一多桶折叠契约 + 跨执行环境今日总览」。

## 核心主张

多执行环境统一体验的根基**不是**「一个 HTML 塞多个数据块,各自渲染」,而是**统一折叠契约**:

> 每个执行环境的用量都折成同一个形状——`{by_hour_model, by_model, unaccounted}`:
> **一条多桶逻辑**,同时**按时间切**(小时粒度,聚合到天/月)和**按 session 切**(模型)。
> 两条投影必须对账(守恒,2026-08 那个 ¥2386 vs ¥1733 事故的防线)。

DSH 早在 core 里就是这么折的:`usage.rs::token_by_date_model`(小时粒度时间轴)+
`token_by_model`(session 轴)。**Codex 折叠必须补齐到小时粒度**,与 DSH 同一条纪律——
不是「codex 天生没有小时桶」,而是实现没做到。视图层只消费**统一视图契约**(server 已
算好的 cost/tokens/hours/days/by_model),JS 只格式化、不计价。

## 理想画面

用户打开日历,要能同时得到两件事:

1. **顶部 = 跨执行环境今日总览**:今日总 token(所有执行环境求和,币种无关)+ 各币种今日花费
   (DSH ¥、Codex $,**不编汇率**) + 每执行环境一张 mini 卡。
2. **执行环境切换(dsh | codex | …)**:每执行环境渲染自己的明细,但**结构同构**——小时热力图 +
   模型表 + summary 卡片,区别只在币种与执行环境私有装饰(DSH:peak/off-peak;Codex:额度面板、
   5 桶 + speed 模型表)。视图切换(today | month | all)是同一执行环境的三档时间窗。

也就是说:**「知道今日所有 Agent 总花费」和「钻到每个 Agent 的细节」是同一个看板的两层**,
不是两块拼在一起的仪表盘。

## 统一折叠契约

```
fold(events) -> {
  by_hour_model: { "YYYY-MM-DDTHH": { model: { <执行环境 token 桶> } } },  // 时间切,小时粒度
  by_model:      { model: { <执行环境 token 桶> } },                        // session 切
  unaccounted:   [...],                                                // 残差哨兵
}
```

- **时间轴小时粒度是统一基准**:today 直接显示小时,month/all 由小时聚合成天。任何执行环境
  不许只有「天」没有「小时」——这正是 codex 现在缺的。
- 每个执行环境成立 `sum(by_hour_model) == sum(by_model)`(无时间样本被时间轴按设计丢弃),
  各有守恒测试。
- 执行环境 token 桶**不同**(DSH 4 桶 + peak;Codex 5 桶 + speed),但**折叠形状统一**——
  桶内容是执行环境数据,折叠结构是框架。

## 统一视图契约(组件接口 = schema)

server 把「折叠 + 计价」算成每视图一份(JS 只格式化,不重算):

```
view = {
  harness, currency, mode,
  total_cost, total_tokens,
  by_model: [ { model, tokens, cost, priced, cells? } ],   // cells = 执行环境私有列
  hours:    [ { hour, cost, tokens, peak? } ],             // today 视图
  days:     [ { date,  cost, tokens, peak? } ],            // month/all 视图
  sentinels: { unpriced?, unaccounted? },
}
```

共享渲染组件(与执行环境无关):`renderSummary` 卡片、log 色阶 `colorFor` + 热力图引擎、
tooltip、`shortNum`/`commas`/`money`/格式化、三段式加载、执行环境/视图路由。

## 执行环境注册制(模板)

模板内一份 `HARNESSES` 注册表,每个执行环境声明:label / modes / defaultMode / 内联数据布局 /
渲染适配器。DSH 双块嵌入格式被测试钉死,**保持原样**;新执行环境一律用规范单块。

## 跨执行环境今日总览

模板内联所有执行环境的 today 视图,JS 只做**聚合格式化**:

- 今日总 token = Σ 各执行环境 today.total_tokens(币种无关,直接求和)。
- 今日花费 = **按币种**列(¥ DSH 总额、$ Codex 总额)——不编汇率,币种不同的花费不强行相加。
- 每执行环境一张 mini 卡(花费 + token),点击跳该执行环境的 today。

## DSH 0 号模板的模式清单

| 模式 | 位置 | 是否可复用 |
|---|---|---|
| 三段式加载:inline blob → fetch → file-picker + stale 哨兵 + 旧格式 schema 推断 | `bootstrap()` | **可复用**(参数化 harness 的 blob 布局) |
| 执行环境/视图路由:`?harness=` + `?file=` + 注入默认 | `getHarness()`/`getMode()` | **可复用** |
| 小时桶今日视图(24 格 + peak 叠加 + tooltip) | `renderToday` | **可复用**(codex 补小时桶后同构) |
| 月网格视图(date 格 + log 色阶 + 今天高亮) | `renderMonth` | **可复用** |
| summary 卡片:`renderSummary(cards)` 吃 `{label,value,note}[]` | 共享 | **复用** |
| 显示机械:`shortNum`/`commas`/`money`/`colorFor`/`positionTip`/`parseISO` | 共享 | **复用** |
| DSH 显示层成本近似 `PRICE`/`costOf()` | calendar.html | **执行环境私有**(仅 `b.cost` 缺失的 fallback) |
| peak 时段判定/占比卡片 | calendar.html | **执行环境私有** |
| Codex 额度面板 `plan.limits`/`windowLabel`/`formatReset` | codex harness | **执行环境私有** |
| Codex 模型明细表(5 桶 + speed + USD + priced) | codex harness | **执行环境私有**(行契约共享) |

## Codex 1 号执行环境的数据契约

`_render_calendar_html` 扫描 codex 会话(事件带顶层 `timestamp`,折叠到小时),产出规范单块:

```
{ harness:"codex", currency:"USD", default:"month",
  views: { today, month, all } }     // 每个 view 即上文统一视图契约
```

codex 扫描**失败时降级**:不内联该块,codex harness 落 empty-state,DSH 渲染不受影响。
`codex-cost --html` 复用**同一模板**(只内联 codex 块 + `AGENT_VITALS_DEFAULT_HARNESS="codex"`),
退役独立的 `codex_cost.html` 第二模板——一套视觉模板,不是两套。

## 为什么 DSH 嵌入格式不动

`tests/test_cli_m3.py` 钉死:`agent-vitals-data-today` 块、`accurate_cost` + `by_model`、
stale 哨兵、sidecar 原始字节。这些是 DSH 作为 0 号模板的**既有契约**。loader 用执行环境声明的
blob 布局适配它;新执行环境一律规范化单块。两代格式 loader 都能读,legacy 单块保留兼容推断。

## Tauri 底稿

菜单栏消费同一个 cost fold(core crate `token_by_date_model`)。统一视图契约
`{view, by_model, hours, days, sentinels}` 将来映射为 Rust 侧同一组结构定义 + 同一棵渲染树:

- 执行环境 = 数据提供者(Codex fold / DSH month.json 增强),不是渲染逻辑。
- 视图 = `today/month/all` 同一组枚举,与 HTML 的 `?harness=&file=` 一一对应。
- 三段式加载的「inline 优先」对应 Tauri 的「进程内直读 state + 实时 fold」,无 CORS,
  退化为一段,**数据契约不变**。
- 跨执行环境今日总览 = 同一契约的 N 份聚合,不是新逻辑。

## 迁移路径

1. **统一折叠契约**:codex 折叠从 `by_date_model`(天)升级为 `by_hour_model`(小时),
   Python + Rust core 镜像,守恒测试 + 差分看守。
2. calendar.html 重构:执行环境注册制 + 跨执行环境今日总览 + codex 小时热力图。
3. `codex-cost --html` 复用同一模板,退役 codex_cost.html。
4. Tauri:同一契约的 Rust 实现(后续)。

## Out of scope

- 不改 DSH 嵌入格式(测试钉死)。
- 不把 DSH 的 `PRICE` 近似「规范化」进框架——它是执行环境私有 fallback。
- **不编汇率**:¥/$ 分列展示,币种不同的花费不强行相加。
- **整折叠 memo,非跨调用累计**:codex 折叠瓶颈是解析不是折叠(真机 51 份
  rollout ≈600MB JSONL ≈38s,单份 210MB 解析 16s、折叠 0.04s)。2026-08-29
  兑现延迟项:`codex_fold_merged` 在 `$AGENT_VITALS_HOME/cache/codex-fold.json`
  做整折叠 memo(签名 = (path, size, mtime_ns) 全等命中、不等重扫原子覆写),
  日历/oneline 二次刷新 0.06s。**仍是纯函数 memo 不是状态**:命中与否输出
  逐字节相同,差分门不受影响;`codex-cost` 的语义(无跨调用累计、重读整文件
  不双计)不变。缓存放 `cache/` 不进 `state/`——`list_state_files`/doctor 的
  读者不该被缓存文件污染。
