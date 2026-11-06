# CITY_ROAD_SIMULATION_PROPOSAL v0.2 分析（2026-10-06）

对象：主仓库 `docs/CITY_ROAD_SIMULATION_PROPOSAL.md`（v0.2）。结论：方向正确，建议调整顺序；O-2（迁 Rust）的前提已被实测证实。

## 1. 现状对账更正
- `growWithBuildings` 已提交（07ca5a3a，G1），不再是 WIP；另已完成 G2（行道树/内陆草地）、G3（码头/尺度/标签）、S5（地价形态 + 城区地标，本次提交）。
- 断头路随 R2/S1/S2 增加（30 岛约 386），F1 若用 A* 接入需同时修复。

## 2. 关键实测：V8 与 JavaScriptCore 的布局不一致
同一份 `createCityPlan` 打包后分别在 Node（V8，守卫用）和 macOS `jsc`（JavaScriptCore，App 的 WKWebView 用）运行，
10 种子 × 1/2/5 档共 30 个布局摘要 **30/30 全部不同**。即：**守卫验证的城市 ≠ 用户在 App 里看到的城市**。
原因推测：`Math.sin/cos/atan2/hypot` 等在 ECMAScript 中是实现定义的，末位差异经阈值比较（buildable、clearance、排序）放大成拓扑差异。
复现：`det-entry.ts`（打包 cityPlan，输出 fnv 摘要）→ `node` 与 `/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc` 对比。

**影响**：提案 §3-1「确定性」目前对 App 实际不成立；所有 City 守卫的数字只代表 V8。
**建议**（比 O-2 全量迁移更小的第一步）：
1. 先把守卫加一路 JSC 运行（jsc 随系统自带，零依赖），报告差异；
2. 规划层改用确定性数学（自带多项式 sin/cos/atan2、`Math.hypot` 换 `Math.sqrt(x*x+z*z)`），再测两引擎一致；
3. 若仍不一致或成本过高，再执行 O-2（Rust/wasm 单一产物）。O-2 的动机成立，但先做 1–2 可能就够。

## 3. 对各分期的意见
- **D-桥址**：不必等 A*——主干道角度在现有抖动范围内选「过河跨距最小」即可，TS 小改。
- **D-绕行**：滨海平原几乎全平（高 1.2），等高线只在山体边缘有意义；张量场/symbios 的「沿等高线」在平地退化，提案自己也列了此风险——平原上应以需求驱动为主。
- **F1 需求驱动 A***：可行（粗网格 20–30，~5k 节点 × ≤200 需求点，预算内）。必须新增「**前缀稳定**」守卫：`路网(t1) ⊆ 路网(t2)`，否则回放中道路会跳变；现行「几何规划 + 剪枝」天然满足，增量规划不天然满足。
- **F3 路网面街区**：与 S4 同一件事，建议在 F1 之前做（视觉收益最大、不依赖 A*）。
- **迈阿密考卷**：OSMnx 需联网取数，仅限开发期一次性导出并入库，符合「App 不回传/无新增出站」。

## 4. 建议顺序
确定性修复（JSC 守卫 + 确定性数学）→ D-桥址 → F3/S4 路网面街区 → F1（A* + 前缀稳定守卫）→ F2 介数升格 → O-2 视前两步结果再定。
