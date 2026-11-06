# B1 总览后端接入代码审查

## Code Review Round 1 — 2026-09-13

**Scope**: B1-M1.1 总览数据访问层、mock 契约、设置懒加载和决定卡边界  
**Build Status**: UI build、可见性检查、总览合同测试、KPI 检查和 fold bridge 检查通过；原生 `.app` 尚未验证。

### Issues

#### Issue 1 (High): 顶部来源摘要仍然没有消费 `data_source_status`

**File**: `apps/desktop/src-tauri/ui/workbench.js:609,750`

`loadOverviewData()` 已经请求并校验了 `data_source_status`，但 `renderOverview()` 仍调用 `sourcesBrief(monthly)`，而 `sourcesBrief()` 继续遍历 `monthly.by_harness` 的 `freshness` 和 `has_unresolved`。这会让连接状态为 `needs_attention`、`paused` 或 `excluded` 的来源被错误计为正常，也让真正未探测到的来源无法按来源状态展示。它违反规格中“顶部来源摘要必须以 `data_source_status` 为准”的合同。

**Fix**: 让 `sourcesBrief(report)` 只消费 `data_source_status` 的 `sources`，明确映射 `connected → 正常`、`needs_attention/paused/excluded → 需检查`、`not_detected → 尚未接入且不计入正常/需检查`，`status=unavailable` 显示“来源状态不可用”。调用改为 `sourcesBrief(data.sources)`，并补充对应 mock 合同断言。

#### Issue 2 (High): 决定卡仍然推荐没有证据的 Claude/GLM

**File**: `apps/desktop/src-tauri/ui/workbench.js:2459`

当 Codex 剩余额度低于 15% 时，当前文案仍为“建议先切到 Claude Code 或 GLM”。规格第 7 节明确禁止在没有替代提供商真实配额、冻结价格和稳定性证据时指名推荐；这也是本批次明确要求修正的行为。当前测试只验证“即将限流”，没有断言不能出现提供商推荐，因此回归未被捕获。

**Fix**: 改为“Codex 额度较低；请在用量或设置中确认可用线路”，并在 `verify-workbench-kpi-decide.mjs` 和总览合同测试中断言低额度文案不包含 `Claude`、`GLM` 或“切到”。

### Verdict: NEEDS_FIX

## Code Review Round 2 — 2026-09-13

**Scope**: Round 1 修复复核  
**Build Status**: PASS

Round 1 的两项高优先级问题均已修复：

- `sourcesBrief()` 现在只消费 `data_source_status`，并明确处理 `connected`、`needs_attention`、`paused`、`excluded`、`not_detected` 与不可用状态；
- 低额度决定文案改为中性提示，不再指名推荐 Claude/GLM 或要求切换；
- 总览合同测试和 KPI 测试新增了来源状态映射、月度数据独立性和中性建议回归断言。

验证通过：

- `npm --prefix apps/desktop/ui-dev run verify`
- `node scripts/verify-workbench-overview-contract.mjs`
- `node scripts/verify-workbench-kpi-decide.mjs`
- `node scripts/verify-workbench-visibility.mjs`
- `node scripts/verify-workbench-fold-bridge.mjs`
- `git diff --check`

原生 `.app` 与 Authority 数据库验收仍属于后续集成验证，不在本轮浏览器合同测试中冒充完成。

### Verdict: APPROVED

## UAT Round 3 — 2026-09-14

**Scope**: 总览与设置页面浏览器 UAT、跨层回归、发布阻断审计

已在本地 Vite 页面完成关键路径走查：总览 KPI、今日/本月窗口、来源健康、预算、决策卡、计费明细、最近几天、设置分区导航、数据源展开、预算设置和诊断区均可见；进入设置后才加载设置专用读取。

验证通过：

- `npm --prefix apps/desktop/ui-dev run verify`
- `node scripts/verify-workbench-kpi-decide.mjs`
- `python3 -m unittest discover -s tests -p 'test_*' -v`（1189 passed，208 skipped）
- `cargo test --release`
- `cargo test --release -p agent-vitals-runtime -p agent-vitals-harnesses`
- `cargo clippy --release --all-targets -- -D warnings`
- `cargo build --release`
- `git diff --check`

当前仍不能判定为完整发布交付：规格要求的真实桌面 `.app` 在 Authority 数据库上的“有数据 + 空/异常数据”截图级人工验收尚未完成。Vite mock 页面和自动化测试不能替代这一项，因此发布结论为 **CONDITIONAL**，待原生 `.app` UAT 完成后再转为可发布。
