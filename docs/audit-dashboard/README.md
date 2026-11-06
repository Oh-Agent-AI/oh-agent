# 审计 Dashboard（DSH「审计」Tab）设计文档

`dsh-client/` 那个「审计」Tab 的产品规格、UX 评审与原型。原先散在仓库外的
`~/Documents/Codex/.../outputs/`，随手一个路径引用就会失效，因此收进 `docs/`。

## 目录

| 文件 | 是什么 | 状态 |
|---|---|---|
| [PRD.md](PRD.md) | 产品需求文档 V1.7。**唯一实施规格**——与 `AUDIT_TAB_DESIGN.md`／`AUDIT_TAB_UX_REVIEW.md` 冲突时以本文为准 | 现行 |
| [REMEDIATION_BACKLOG.md](REMEDIATION_BACKLOG.md) | 对着 `http://127.0.0.1:3080/` 做的视觉/交互验收，P0–P2 问题清单 | P0、P1 已全部完成 |
| [SKILL_EXECUTION_BACKLOG.md](SKILL_EXECUTION_BACKLOG.md) | Skill 执行审计的开发任务清单（T1–T12）。**开工前先看它的 §0**——`SKILL_EXECUTION_AUDIT_PRD.md` §9.1 对现有数据能力的判断有四项要打折扣 | T1–T6、T8–T12 已完成（T7 自然作废）；§6 记了两项遗留 |
| [GOVERNANCE_BACKLOG.md](GOVERNANCE_BACKLOG.md) | 对着一份 Agent 治理行业研究（成本断路器/per-task 预算/反循环恢复等）拆的 backlog，分「已覆盖／V2.1-V3 能做（G1-G4）／结构性做不到」三档。**开工前先看它的 §0**——插件只读投影、无执行前拦截钩子，这是 PRD §3.2 的显式边界，不是待修的缺口 | G1、G2、G3 已完成；G4（依赖 PRD V2.1 排期）待排期 |
| [DURATION_AUDIT_BACKLOG.md](DURATION_AUDIT_BACKLOG.md) | 从 GOVERNANCE_BACKLOG 的"task 超时"分析里拆出来的独立 backlog：工具调用/turn/step 耗时、审批等待延迟、hook 消费——现状是一个都没算。**开工前先看它的 §0**——阈值判断留客户端，不进 core 规则引擎；`approval` 关联键是 `id` 不是 `callId`，是个真坑 | D1–D3、D5–D12 已完成；D4 的 core 抽取函数就绪但执行环境接线（浏览器能否拿到 hook/* 事件）未验证，故意不接进 durationAudit 投影 |
| [prototype/dsh-native-v2.html](prototype/dsh-native-v2.html) | 可交互原型（DSH-native v2） | 参考用 |

## 两份没能拷进来的文件

以下两份在源目录里被 macOS 逐文件的权限限制挡住（同目录其余文件可读，只有这
两个连读取都返回 EPERM），需要手动补：

```
~/Documents/Codex/2026-08-21/http-127-0-0-1-3080/outputs/
├── AUDIT_TAB_UX_AUDIT_AND_REDESIGN.md          → docs/audit-dashboard/UX_AUDIT_AND_REDESIGN.md
└── agent-vitals-session-diagnostic-dashboard-v2.png
                                                 → docs/audit-dashboard/prototype/
```

补之前**这两个路径在本目录下是不存在的**，不是空文件——空文件会让人以为内容
丢了，比缺文件更糟。

## 读之前要知道的两件事

**1. 原型和 PRD 里的具体数字都是某一次采样，不是产品行为的一部分。**
PRD §16.3 已写明这条：同一套逻辑跑在不同会话上会得到合法但不同的数字。自动化
验收一律用 `fixtures/`、`dsh-client/scripts/verify-*.mjs` 里冻结的夹具断言，
不拿文档里的示例数字当页面的期望值——文档换一次采样不该让任何测试变红。

**2. 原型早于实现，有些地方已被实现推翻。** 以实现和 PRD 正文为准，例如：

- 原型画了五类上下文构成，实际只做三类**常驻前缀**（系统提示词／工具定义／
  技能目录）。历史消息不在其中，且**不能用减法补**——`context.*` 是 est_tokens
  估算、`requests[].context_tokens` 是 provider 实测，两个不同估算器相减的差值
  不是"历史消息的大小"（PRD FR-04a）。
- 原型的「关键发现」摘要卡层没有实现。经确认不做：结论区四栏 KPI + 时间线 +
  Finding 队列已经覆盖「概览 → 定位 → 解释 → 证据」整条路径，再加一层是同一
  职能第三次重复。KPI 卡改为内联展开（REMEDIATION_BACKLOG P1-05）。
- 上下文上限 "128K" 是占位，实测值是 1,000,000，且随模型变——按
  `request/context.contextWindow` 的实际上报值取，不写死常量。
