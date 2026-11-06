# 投递架构 —— 一份计算，多投递面，Tauri 是唯一跨执行环境常驻收口

> 状态：定论（2026-08-29）。本文回答一个反复出现的问题：**审计 UI 到底住在哪、谁来渲染。**
> 配套：`ARCHITECTURE.md` §0（沙漏）、§10（运行时证据层）、
> `RUNTIME_EVIDENCE_CONVERGENCE_SPEC.md`（让实现追上 §10）、
> `DSH_INTEGRATION.md`（DSH 插件模型）、`UNIFIED_COST_VIEW.md`（跨执行环境成本视图）。

---

## 0. 一句话

所有审计的**计算都在执行环境侧**（Rust core + wasm，读磁盘 fold / live 事件流）；
本文只决定**计算结果渲染在哪个面**。结论：**DSH 是唯一能让插件自带 tab 的执行环境，
其余执行环境的审计只能住进我们自己的面；Tauri 是唯一能把「每执行环境审计 + 跨执行环境总览」
合成一个常驻产品的壳。**

---

## 1. 决定性不对称：哪些执行环境能托管「审计 tab」

| 执行环境 | 运行时 | 能否在自己的客户端里渲染审计 tab | 我们已有的 |
|---|---|---|---|
| **DSH** | Cordis 插件运行时 | ✅ `sessionProjections` + `useProjection` | `dsh-client`（双面插件，已做） |
| **Codex** | agent runtime + extension-api | ❌ 插件只有 harness 侧 contributor，前端固定 | `codex-cost`/`codex-evidence`（离线） |
| **Claude Code** | CLI（无运行时查询接口） | ❌ 纯日志读取 | 装机层适配器 |
| **WorkBuddy** | SQLite + JSONL（无运行时查询接口） | ❌ 纯日志读取 | 未做（P6） |

**Codex 的「harness 侧 contributor」与「客户端 UI」是两回事**（2026-08 调研结论）：

- 8 种 Contributor（`ToolContributor` / `ContextContributor` / `TurnItemContributor` /
  `ThreadLifecycleContributor` / `TurnLifecycleContributor` / `ConfigContributor` /
  `McpServerContributor` / `TokenUsageContributor`）全部跑在 **agent/harness 侧**，
  没有「往 Codex 自己的前端注入一个 React tab」的扩展点。
- 唯一能「嵌入自定义 UI」的正路是 **App Server**（JSON-RPC 2.0 over stdio/websocket）：
  客户端连 `codex app-server`，收 `item/*`/`turn/*`/approval 流，**自己渲染**。这正是
  VS Code 扩展 / desktop / Codex Web 的做法——它们是 App Server 的消费者，不是「插件
  往执行环境里塞了个 panel」。

所以「每个执行环境都要有 DSH tab 那种效果」这个需求，**本身就等于「我们需要一个自己的
UI 面」**——因为只有 DSH 会替我们渲染，Codex / Claude Code / WorkBuddy 都不会。

---

## 2. 两种审计模式（这是所有投递决策的分水岭）

| 模式 | 语义 | DSH | Codex | Claude Code / WorkBuddy |
|---|---|---|---|---|
| **A 事后离线** | 会话结束后读日志出报告 | `behavior --json` / `--html` | `codex-cost --html` / `codex-evidence` ✅ | 读日志出报告（P5/P6） |
| **B 会话内实时** | 边跑边看「现在烧什么、刚批准什么」 | ✅ 自己的 tab（live 投影） | ❌ 唯一的路是 **App Server 客户端**（新程序） | ❌ 做不到（无那个面） |

**模式 A 已经 80% 有了**（`codex-cost --html` 就是 Codex 的「DSH tab 离线版」）。
**模式 B 只有 DSH 切下去了**；Codex 要做 live 只能写 App Server 客户端，其他执行环境
做不到 live。

---

## 3. 投递面收敛图

```
                    ┌─────────────────────────────────────────────┐
                    │  一份计算（Rust core + wasm，已基本就绪）        │
                    │  fold → CanonicalSession + findings + cost   │
                    │  读磁盘 fold（离线）/ live 事件流（在线）         │
                    └───────────────────┬─────────────────────────┘
                                        │
              ┌─────────────────────────┼─────────────────────────┐
              ▼                         ▼                         ▼
   ┌───────────────────┐   ┌───────────────────┐   ┌────────────────────────┐
   │ ① DSH live tab     │   │ ② 独立 HTML         │   │ ③ 自己的 UI 面（Tauri） │
   │ dsh-client 双面插件 │   │ calendar.html（跨执行环境）│   │ 常驻菜单栏 + webview      │
   │ (DSH 专属，已做)     │   │ codex-cost --html    │   │ ┌──────────────────────┐ │
   └───────────────────┘   │ codex-evidence       │   │ │ 每执行环境审计 panel       │ │
                           │ (已做，浏览器打开)     │   │ │ + 跨执行环境今日总览       │ │
                           └───────────────────┘   │ │ live 靠 App Server     │ │
                                                    │ │ post-hoc 读 fold       │ │
                                                    │ └──────────────────────┘ │
                                                    └────────────────────────┘
```

三个面的关系，**不是三套要分别维护的 UI**，而是同一份 fold 的三个投影：

- **① DSH live tab** = 那份 fold 的「DSH 会话内实时」投影（DSH 执行环境替我们渲染）。
- **② 独立 HTML** = 那份 fold 的「事后离线」投影（浏览器打开，零网络零依赖，已做）。
- **③ Tauri** = 那份 fold 的「常驻 + 跨执行环境」投影，是唯一能同时装下「每执行环境审计
  panel + 跨执行环境今日总览」的**常驻面**。

---

## 4. Tauri 的定位（不是替代，是收口）

Tauri **不替代** ① 和 ②，而是它们的**常驻收口**：

- 对 DSH：① 已经是更好的 live 体验（执行环境内 tab），Tauri 不做 DSH 的 live，只做
  DSH 的 post-hoc + 跨执行环境总览里 DSH 那一列。
- 对 Codex：② 已是 post-hoc 审计；Tauri 要么只做 post-hoc 的常驻版，要么（若要 live）
  通过 App Server 客户端做 live 版。
- 对跨执行环境总览：`calendar.html` 已能用；Tauri 把它从「打开一个文件」升级成「常驻」。

**Tauri 的全部价值，只在一个不可替代点：常驻 + 自主 UI。** 计算一点不碰（CLAUDE.md
里「menu-bar work (Rust-Tauri) consumes this same fold」就是这条边界的注脚）。所以
它永远只是一个「读同一份 fold 的壳」，成本可控、可后置。

---

## 5. 决策框架

```
需要「每执行环境审计 + 跨执行环境总览」吗？
│
├─ 只要事后看报告（模式 A）──────────→ 独立 HTML 已够，无需 Tauri
│                                        · 每执行环境：codex-cost --html（已有）
│                                        · 跨执行环境：calendar.html（已有）
│                                        · 加常驻一行：xbar/SwiftBar 插件（5m.sh 已有雏形）
│
└─ 要会话内实时审计（模式 B）────────→ 需要自己的 UI 面
                                         · DSH：已经靠自己的 tab 有了（不做）
                                         · Codex：App Server 客户端（新程序）
                                         · 此时 Tauri 是唯一能把 live/post-hoc 审计
                                           + 跨执行环境总览合成一个常驻产品的壳
```

---

## 6. 现状 vs 待办

| 面 | 现状 | 待办 |
|---|---|---|
| ① DSH live tab | ✅ dsh-client（findings/token/cost/timeline） | 无（阶段 B/C 后升级为读 CanonicalSession，见收敛 spec） |
| ② 独立 HTML | ✅ `calendar.html`（跨执行环境）· `codex-cost --html` | 缺 `codex-evidence --html`（coverage 可视化） |
| ③ Tauri | ⏳ 概念图 `docs/design/agent-vitals-menubar-concept-v1.png` | 未实现 |
| Codex 行为审计 | ❌ 无 SV 码（非 UI 问题） | 收敛 spec 阶段 B/C：走同一规则引擎，诚实报三态 |
| Codex live | ❌ 无 App Server 客户端 | 未评估（要实测 contributor 的 token 粒度） |

**注意**：Codex「审计 agent 行为」做不了，不是缺 UI，是 Codex 没有审批/沙箱/子代理
事件、也没人写行为规则。按 §10.4 三态，应诚实显示「审批类规则：unavailable」，不是
伪造一个空 tab。这块归 `RUNTIME_EVIDENCE_CONVERGENCE_SPEC.md` 阶段 B/C，不归本文。

---

## 7. 引用的关键结论出处

- Codex 无「注入 tab」扩展点：extension-api 8 种 Contributor 全在 harness 侧；App Server
  是唯一外部 UI 通道（2026-08 调研，见会话记录，未单独落 doc）。
- DSH 双面插件模型：`DSH_INTEGRATION.md` §2.2。
- 跨执行环境成本视图：`UNIFIED_COST_VIEW.md`。
- 运行时证据层收口：`ARCHITECTURE.md` §10 + `RUNTIME_EVIDENCE_CONVERGENCE_SPEC.md`。
