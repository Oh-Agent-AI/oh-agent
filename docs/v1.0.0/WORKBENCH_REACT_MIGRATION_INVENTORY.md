# Workbench React 迁移盘点

状态：React 默认入口已切换（2026-09-23）；Phase 4 真机与功能等价验收仍未完成。

本文记录旧 Workbench 的可见入口、IPC 边界和 React 迁移状态。默认 Tauri 配置现指向 `ui-react-dist/index.html`；旧页面通过显式 `tauri.legacy.conf.json` 保留为短期兼容/回退面。默认入口切换不等于功能等价或发布验收完成。

## 页面归属

| 旧 tab | 旧入口 | React 目标 | 当前状态 | 下一步 |
|---|---|---|---|---|
| 总览 | `tab-overview` | `features/overview/OverviewPage.tsx` | 已迁移总览聚合切片：安全 DTO、费用/预算/新鲜度/执行环境覆盖、月度/今日 summary、tokens_by_harness、按 basis 支出、最近观测日；React bridge 已锁定 token 与按币种 basis 守恒，并覆盖 malformed DTO/独立失败合同；仍需真实 Tauri/旧页截图对照 | Phase 3：完成旧页数字对照与真实 `.app` 验收 |
| 用量 | `tab-calendar` | `features/usage/UsagePage.tsx` | 已迁移首个日历切片：安全月份/日历/小时 DTO、按币种成本、来源新鲜度与覆盖状态；月份窗口不一致时显式标注并保留来源窗口、完整最后观测时间、未决计费项与覆盖证据；完整旧页对照仍待完成 | Phase 3：补齐旧页数字对照与统计时区设置联动 |
| 会话 | `tab-sessions` | `features/sessions/SessionsPage.tsx` + `features/sessions/SessionDetail.tsx` | 已迁移安全列表和只读详情：筛选、keyset 分页、摘要、计费桶、usage/workflow 脱敏时间线；详情分页已贯通 React bridge → Tauri → CLI，page size/cursor 有界且有对拍契约；完整轨迹图和原始报告仍不迁移 | Phase 3：真实 Tauri 对拍与轨迹图安全投影评估 |
| 待处理/发现 | `tab-findings` | `features/findings/FindingsPage.tsx` | 已迁移首个垂直切片：安全 Finding 投影、待办、证据明细、决策矩阵和新鲜度；bridge 拒绝超量 rules/issues、非法 refreshed 和 malformed evidence；证据明细支持数字游标分页，跨页保留稳定汇总并去重，合并规则已抽成可测试纯函数；统一 `app-event` 订阅与 150ms burst 合并刷新；待办只按后端 `manual_follow_up`/`action_kind` 判定，并可直达对应设置分区，不从执行环境名或风险规则名猜测动作 | Phase 2：补旧页数值对照与 Finding 生命周期/证据一致性验收 |
| 测试 | `tab-test` | `features/test/TestPage.tsx` | 已迁移只读路线质量面：执行环境 × 实际模型族、非官方族/API 错误/无基准状态与安全 DTO；刷新失败保留旧报告并显示原始报告窗口；主动 probe mutation 仍保留旧页 | Phase 3 后半：补真实 Tauri 对拍，再评估显式 mutation |
| Skill | `tab-skills` | `features/skills/SkillsPage.tsx` | 已迁移安全扫描、显式本机快照、受控快照对比、脱敏 JSON 导出和扫描高级设置：对比/导出 DTO 仅返回有界执行环境/Skill 标签、规则、行号、计数和不上传回执，丢弃基线路径、`where`、description 与 CLI 输出；执行环境选项合并扫描返回的动态注册项，设置保存后显式要求重新扫描 | Phase 3 后半：真实 CLI 对拍并单独审查导出脱敏 |
| 设置 | `tab-sources` | `features/settings/SettingsPage.tsx` | 已迁移数据源健康、安全同步控制、其他本机位置、预算估算表单（含二次确认停用 estimate profile，历史用量/confirmed profile 保留）、计费只读面、计费候选“不是我的/重新打开”可逆处置、计费声明的影响预览→确认保存（官方 API/中转第三方/组织承担）、当前声明二次确认撤销与订阅修订（新修订从当前北京时间统计月开始、历史月份不变、原 scopes 原样带回）及重算回执、失败/取消任务的安全重试回执、统计与数据、关于与诊断：动态来源列表、失败原因映射、同步回执轮询、路径显式展开、预算状态/80%固定阈值/本周期静默、待确认分组/声明/重算/已有账单、时区/保留期保存、价格目录只读、月度摘要 CSV、版本表/脱敏诊断包/手动更新检查、Claude Pro 额度提醒（只读配置/保存回执/通知权限状态）；停止/恢复读取与删除已导入投影均迁移，能力由后端统一 `supported_harnesses` 注册表门控，注册表包含内置执行环境和校验通过的热插拔插件，删除回执包含 facts/sessions/source_files/Trust/路由/任务摘录并广播跨页失效事件；MCP 删除复用同一执行环境租约和回执；自动更新安装按 Beta D06 有意延期（React 不提供自动安装） | Phase 3：剩余高风险写控制与真实 Tauri 对拍 |

## Phase 2 Trust / Findings 边界

| 能力 | Rust/Tauri command | React bridge | 状态 |
|---|---|---|---|
| 执行环境覆盖发现 | `trust_discover` | `discoverTrust()` | 已有；只接收执行环境标签、检测状态和覆盖状态 |
| Profile 授权生命周期 | `trust_profile_proposal_status` / `trust_profile_approve` / `trust_profile_reject` / `trust_profile_revoke` | `readTrustProfileStatus()` 与哈希绑定决策 | React 已显示待审/已批准 Profile 的路径类别预览与清单 hash；广域/不可分类 scope 禁止批准；批准、拒绝、撤销都必须匹配当前清单 hash，不展示原路径 |
| 通知抑制 | `trust_suppression_list` / `trust_suppression_create` / `trust_suppression_revoke` | `readTrustSuppressions()` / `createTrustSuppression()` / `revokeTrustSuppression()` | React 已支持逐规则抑制与恢复；确认文本说明为全局后续通知控制，不删除历史 Finding/证据 |
| 历史本地审计 | `trust_audit` | `auditTrust(harness)` | 已有；原始路径/内容不进入 renderer |
| 运行时一次快照 | `trust_runtime_snapshot` | `runTrustRuntimeSnapshot()` | 已接入；Rust 只返回能力与有界计数 |
| 监控配置 | `trust_monitor_config` / `save_trust_monitor_config` | `readTrustMonitorConfig()` / `saveTrustMonitorConfig()` | 已接入；不可观察时 fail-closed |
| Finding 聚合 | `findings_groups_safe` | `readFindings()` | 已有 versioned safe DTO |
| 决策矩阵 | `decision_matrix_safe` | `readDecisionMatrix()` | 已有 versioned safe DTO |
| 事件刷新 | `app-event`（`FoldCompleted` / `FactsIngested` / `SyncStatusChanged` / `TrustMonitorInvalidated` / `SourceDataDeleted`） | React 页面统一通过 `listenAppEvents` 订阅；payload 只作 allowlist 失效信号，外部 MCP/CLI 删除保留 DOM revision-poll fallback；Findings burst 以 150ms 合并刷新；Settings 各投影刷新带 request generation 与卸载守卫 | 已完成统一 feature invalidation 与设置页竞态硬化 |

## 安全与可见性约束

- React 组件不得直接调用 `window.__TAURI__`；所有 command 只能经 `react/src/lib/tauri.ts`。
- Trust evidence 只允许安全引用（`tr_...`）、类别、等级、来源、时间、范围和聚合计数；路径、文件内容、JWT、上传凭证、原始网络请求、canary 和 native session id 不得进入 React state。
- `trust_runtime_snapshot` 的 capability 是覆盖状态，不是风险结论；`unavailable` 必须在 UI 中显示为不可观察，不能显示为“安全”。
- 旧页与 React 页并存期间只维护一个数据真相：Rust/runtime/authority；不得在 React mock 中复制真实 SQLite 或执行环境日志。

## 迁移退出检查

- [x] Phase 0 页面、command、事件和目标归属已列出。
- [x] Phase 1 React shell、hash route、bridge、Error Boundary、离线 mock 已建立。
- [x] React bundle 已输出到 `src-tauri/ui-react-dist`，默认 Tauri 配置指向 React；旧 UI 有显式 `tauri.legacy.conf.json` 回退构建配置。
- [x] Phase 2 Trust/Findings 的证据详情完成（监控控制、一次性快照、事件失效刷新和可展开的安全证据明细已完成；旧页数值对照与真实 `.app` 验收仍属于发布门槛）。
- [x] Phase 2 可信度硬化完成：刷新失败保留旧矩阵/路线质量报告并显示原始窗口；来源停止/恢复读取只对后端声明可控的执行环境开放，失败时 fail-closed。
- [x] React candidate `.app` 构建入口已独立建立：`scripts/build-macos-react-app.sh` 使用 `tauri.react.conf.json` 打包 `ui-react-dist`，校验随包 CLI/schema/架构，并只在显式 `OPEN_APP=1` 时通过 `open` 启动；本地已成功产出 arm64 未签名诊断包。
- [ ] Phase 3 其余四个 tab 完成并通过旧页对照。
- [ ] Phase 4 `.app` 真机视觉/交互验收、未迁移高风险功能收口、菜单目标与完整功能回归；通过后再决定旧页面回退窗口关闭时间。
