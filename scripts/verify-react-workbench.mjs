#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ui = path.join(repo, "apps/desktop/ui-dev");
const reactSource = path.join(ui, "react/src");
const dist = path.join(repo, "apps/desktop/src-tauri/ui-react-dist");

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exitCode = 1;
}

for (const required of [
  path.join(ui, "vite.react.config.js"),
  path.join(ui, "react/index.html"),
  path.join(reactSource, "main.tsx"),
  path.join(reactSource, "lib/tauri.ts"),
  path.join(reactSource, "components/ui/StatusPill.tsx"),
  path.join(reactSource, "features/overview/OverviewPage.tsx"),
  path.join(reactSource, "features/trust/TrustPage.tsx"),
  path.join(reactSource, "features/findings/FindingsPage.tsx"),
  path.join(reactSource, "features/findings/DecisionMatrixSection.tsx"),
  path.join(reactSource, "features/usage/UsagePage.tsx"),
  path.join(reactSource, "features/sessions/SessionsPage.tsx"),
  path.join(reactSource, "features/sessions/SessionDetail.tsx"),
  path.join(reactSource, "features/test/TestPage.tsx"),
  path.join(reactSource, "features/skills/SkillsPage.tsx"),
  path.join(reactSource, "features/settings/SettingsPage.tsx"),
  path.join(repo, "apps/desktop/src-tauri/src/store.rs"),
  path.join(dist, "index.html"),
]) {
  if (!fs.existsSync(required)) fail(`缺少 React 迁移产物：${path.relative(repo, required)}`);
}

const sourceFiles = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(ts|tsx|css)$/.test(entry.name)) sourceFiles.push(full);
  }
}
walk(reactSource);

const source = sourceFiles.map((file) => fs.readFileSync(file, "utf8")).join("\n");
const settingsPage = fs.readFileSync(path.join(reactSource, "features/settings/SettingsPage.tsx"), "utf8");
const tauriBridge = fs.readFileSync(path.join(reactSource, "lib/tauri.ts"), "utf8");
const trustPage = fs.readFileSync(path.join(reactSource, "features/trust/TrustPage.tsx"), "utf8");
const i18nTextPins = ["上一次对比结果","未形成新的可判定结果","上一次可读报告","上一次路线质量结果","发现新鲜度暂不可用","导出脱敏 JSON","高级扫描设置","不会自动上传"];
const trustI18n = fs.readFileSync(path.join(reactSource, "lib/i18n.ts"), "utf8");
const findingsPage = fs.readFileSync(path.join(reactSource, "features/findings/FindingsPage.tsx"), "utf8");
const decisionMatrix = fs.readFileSync(path.join(reactSource, "features/findings/DecisionMatrixSection.tsx"), "utf8");
const sessionsPage = fs.readFileSync(path.join(reactSource, "features/sessions/SessionsPage.tsx"), "utf8");
const sessionDetailPage = fs.readFileSync(path.join(reactSource, "features/sessions/SessionDetail.tsx"), "utf8");
const appFile = fs.readFileSync(path.join(reactSource, "app/App.tsx"), "utf8");
const usagePage = fs.readFileSync(path.join(reactSource, "features/usage/UsagePage.tsx"), "utf8");
const skillsPage = fs.readFileSync(path.join(reactSource, "features/skills/SkillsPage.tsx"), "utf8");
const testPage = fs.readFileSync(path.join(reactSource, "features/test/TestPage.tsx"), "utf8");
if ((source.match(/https?:\/\//g) || []).length) fail("React 源码包含远端 URL");
const appSource = sourceFiles
  .filter((file) => !file.endsWith(path.join("lib", "tauri.ts")))
  .map((file) => fs.readFileSync(file, "utf8"))
  .join("\n");
if (appSource.includes("__TAURI__")) fail("组件绕过 local bridge 直接访问 __TAURI__");
if (!source.includes("components/ui/StatusPill") || !source.includes("inline-flex items-center")) fail("React 应用壳未使用受控 StatusPill primitive");
if (!source.includes('"findings_groups_safe"')) fail("React Findings 未使用版本化安全 DTO command");
if (!source.includes('"decision_matrix_safe"')) fail("React Findings 未使用版本化 decision matrix DTO command");
if (!source.includes('"trust_monitor_config"') || !source.includes('"save_trust_monitor_config"') || !source.includes('"trust_runtime_snapshot"')) fail("React Trust 未使用版本化 monitor DTO commands");
if (!source.includes('"trust_profile_proposal_status"') || !source.includes('"trust_profile_approve"') || !source.includes('"trust_profile_reject"') || !source.includes('"trust_profile_revoke"') || !source.includes('"trust_suppression_list"') || !source.includes('"trust_suppression_revoke"')) fail("React Trust 未接通 Profile 授权与通知抑制生命周期");
if (!trustPage.includes("profileApprovalIsSafe") || !trustPage.includes("tr.manifestVer") || !trustPage.includes("source_scope_preview") || !trustPage.includes("trust_scope_preview")) fail("React Trust Profile 批准缺少脱敏范围预览或哈希确认");
if (!trustPage.includes("tr.approveDisabled") || !trustPage.includes("tr.doneRevoked") || !trustPage.includes("tr.suppressTitle") || !trustI18n.includes("范围无法安全预览，已禁用批准") || !trustI18n.includes("历史证据保留") || !trustI18n.includes("Trust 通知抑制") || !trustI18n.includes("historical evidence is kept")) fail("React Trust 未明确不可观察授权范围、撤销边界或 suppression 控制");
if (!findingsPage.includes("group.manual_follow_up && !group.read_only") || !findingsPage.includes("onNavigateToAction(group.action_kind)") || !appFile.includes("settings-billing") || !appFile.includes("settings-budget") || !appFile.includes("settings-sources")) fail("React Findings 待办缺少安全 action_kind 到设置分区的导航");
if (!appFile.includes('value.startsWith("settings-")') || !appFile.includes('return "settings"')) fail("设置分区 hash 未映射回设置页，点击设置内锚点会丢失当前页面");
if (!source.includes("aria-labelledby=\"trust-monitor-title\"")) fail("React Trust 缺少 monitor 控件可访问标题");
if (!source.includes("查看明细") || !source.includes("evidence-detail")) fail("React Trust 缺少可展开的证据明细");
if (!source.includes("查看证据") || !source.includes("finding-evidence-detail") || !source.includes("evidence_level") || !source.includes("上传尝试不等于远端接收、留存或训练")) fail("React Findings 缺少可核验的脱敏证据明细");
for (const pin of i18nTextPins) if (!trustI18n.includes(pin)) fail(`i18n 表缺少被页面引用的文案：${pin}`);
if (!decisionMatrix.includes("hasStaleReport") || !decisionMatrix.includes("dm.prevResult") || !decisionMatrix.includes("dm.incomplete") || !decisionMatrix.includes("section-heading-side")) fail("React 决策矩阵刷新未标注旧窗口、旧结果或响应式状态");
if (!source.includes("listenAppEvents") || !source.includes('"app-event"') || !source.includes("agent-vitals-source-data-deleted") || !findingsPage.includes("eventRefreshTimer") || findingsPage.includes('listen("sync-status-updated"') || findingsPage.includes('listen("usage-fold-updated"') || findingsPage.includes('listen("trust-monitor-updated"') || findingsPage.includes('listen("source-data-deleted"')) fail("React 事件刷新未统一到 app-event 或缺少跨进程删除 fallback");
if (!source.includes("safeUiError") || [findingsPage, trustPage, sessionsPage, sessionDetailPage].some((page) => /reason\.message/.test(page))) fail("React Findings/Trust/会话错误面未统一脱敏");
if (!appFile.includes("safeUiError") || /reason\.message/.test(appFile)) fail("React 壳层错误面未统一脱敏");
const unsafeErrorPattern = /(?:setError|setActionError|setExportError|setCustomError|setBudgetError|setBillingError|setDataError|setAboutError|setSourceError)\([^;\n]*reason\.message/u;
if ([usagePage, settingsPage, skillsPage, testPage].some((page) => unsafeErrorPattern.test(page))) fail("React 用量/设置/Skill/测试错误面仍直接渲染底层异常");
if (!skillsPage.includes("reportStale && scanning") || !skillsPage.includes("sk.noNewResult") || !skillsPage.includes("selectedHarnessNotScanned") || !skillsPage.includes("reportMatchesHarness") || !skillsPage.includes("report && reportMatchesHarness") || !source.includes("skill scan harness_selection 不匹配") || !skillsPage.includes("sk.scanCancelled") || skillsPage.includes("setReport(null)")) fail("React Skill 扫描未保留旧报告、隔离执行环境或把不可用误判为空结果");
if (testPage.includes("setReport(null)") || !testPage.includes("qt.refreshing") || !testPage.includes("qt.prevResultAria") || !testPage.includes("reportWindow(report)") || !testPage.includes("loading && !report")) fail("React 测试页刷新未保留旧路线质量报告、原始窗口或缺少 stale 状态");
if (!findingsPage.includes("requestGeneration") || !findingsPage.includes("Promise.allSettled") || !findingsPage.includes("fd.freshUnavail")) fail("React Findings 刷新缺少请求代数或部分失败降级");
if (!trustPage.includes("auditLoadingHarness") || !trustPage.includes("auditRequest") || !trustPage.includes("tr.refreshingHarness") || !trustPage.includes("tr.lastAudit") || !trustI18n.includes("上一次可读报告") || !trustI18n.includes("上一次审计结果") || !trustPage.includes('event.type !== "TrustMonitorInvalidated"') || !trustPage.includes("setReport(null)")) fail("React Trust 必须在手动审计失败时保留旧报告，并在监测失效后解除旧报告以显示新历史证据");
if (!source.includes("today_tokens_sql") || !source.includes("overview-harness-panel")) fail("React 总览未消费权威 token/执行环境投影");
if (!source.includes('if (page !== "overview") return;')) fail("React 总览查询未按可见 tab 生命周期隔离");
if (!source.includes("readOverviewDetails") || !source.includes("data_daily_summary") || !source.includes("tokens_by_harness") || !source.includes("actual_spend_by_basis")) fail("React 总览未消费月度/今日安全 summary DTO");
if (!source.includes("token totals 不守恒") || !source.includes("cache hit ratio 不安全") || !source.includes("部分总览数据不可用")) fail("React 总览缺少 token 守恒、缓存比率或部分失败可见性");
if (!source.includes("refreshSeq") || !source.includes("requestId === refreshSeq.current")) fail("React 总览刷新缺少请求代数保护");
if (!source.includes('"read_calendar_month"') || !source.includes('"read_hourly_distribution"') || !source.includes('"data_monthly_summary"') || !source.includes('"statistics_timezone_config"')) fail("React 用量未使用日历/小时/来源/统计时区安全 DTO command");
if (!source.includes("usage-calendar-grid") || !source.includes("UsageTrendChart") || !source.includes("total_actual_spend") || !source.includes("aria-selected") || !source.includes("dsh_tokens") || !source.includes("claude_tokens") || !source.includes("codex_tokens") || !source.includes("usage-harness-summary") || !usagePage.includes("sourceForDisplayedMonth.tokens_by_harness") || !usagePage.includes('"usage.noObservedHarnesses"')) fail("React 用量缺少日历、小时、币种、选择状态、动态执行环境拆分或空数据诚实态");
if (!source.includes("loadedCalendarMonth") || !source.includes("sourceError") || !source.includes("不会把上一月份来源数据冒充为当前月份") || !source.includes("mounted.current") || !source.includes("monthRequest.current += 1")) fail("React 用量刷新未隔离月份投影、来源失败态或卸载中的请求");
if (!usagePage.includes("sourceForDisplayedMonth") || !usagePage.includes("sourceForPanel") || !usagePage.includes('"usage.sourceUnaligned"') || !usagePage.includes('"usage.unresolved"') || !usagePage.includes('message("usage.window", language, { month: monthTitle(sourceForPanel.month) })')) fail("React 用量未显式区分匹配月份摘要与来源窗口证据");
if (!source.includes('"sessions_list"') || !source.includes("session_ref") || !source.includes("sessions-table") || !source.includes("window_session_count") || !sessionsPage.includes("readStatisticsTimezone") || !sessionsPage.includes("Intl.DateTimeFormat") || !sessionsPage.includes('resolvedOptions().timeZone || "UTC"') || sessionsPage.includes('DEFAULT_STATISTICS_TIMEZONE = "Asia/Shanghai"')) fail("React 会话未使用安全列表 DTO、窗口守恒字段或统计时区");
if (!source.includes("加载更多") || !source.includes("cost_status") || !source.includes("requestInFlight") || !source.includes("pendingRefresh")) fail("React 会话缺少成本状态、分页或竞态保护");
if (!source.includes('"sessions_read"') || !source.includes("workflow_timeline") || !source.includes("billing_breakdown") || !source.includes("session-detail-panel")) fail("React 会话详情缺少安全摘要、计费桶或脱敏时间线");
// Tauri 2 命令参数只绑定 camelCase；snake key 会静默变成 None（真机日志证实）。
if (!source.includes("pageSize: 200") || source.includes("const args: Record<string, unknown> = { sessionRef, limit: 200 }") || !sessionDetailPage.includes("detail.next_cursor")) fail("React 会话详情未使用桌面分页字段或未透传 cursor");
if (!source.includes("session detail session_ref 不匹配") || !source.includes("paginationError") || !source.includes("已有详情仍可用，请重试")) fail("React 会话详情缺少分页错配保护或可重试的局部错误态");
if (source.includes('"sessions_issues"')) fail("React Findings 直接消费 legacy 宽 DTO");
if (!source.includes('"routes_quality"') || !source.includes("readRouteQuality") || !source.includes("test-quality-harness")) fail("React 测试页未使用只读路线质量 DTO");
if (!source.includes("route quality 时间范围不安全") || !source.includes("reportWindow(report)")) fail("React 路线质量未校验报告时间顺序或未展示原始报告窗口");
if (source.includes('"probe_run_start"')) fail("React 测试页越过 mutation 边界调用主动探针");
if (!source.includes("只读") || !source.includes("不发请求") || !source.includes("无官方基准")) fail("React 测试页缺少主动探针边界或无基准诚实状态");
if (!source.includes('text === "<synthetic>"') || !source.includes('text === "<unknown>"')) fail("React 路线质量未保留合法哨兵模型标识");
if (!source.includes('"data_source_status"') || !source.includes("readSourceHealth") || !source.includes("settings-source-row")) fail("React 设置未使用安全数据源状态 DTO");
if (!source.includes('"source_harness_controls"') || !source.includes("supported_harnesses") || !source.includes('"set_source_harness_excluded"') || !source.includes("setSourceHarnessExcluded") || !source.includes("supportedHarnesses.includes(source.harness)") || !source.includes("停止读取只影响后续同步") || !source.includes("已导入数据未删除")) fail("React 设置缺少来源能力声明、停止/恢复读取的安全回执或边界文案");
if (!source.includes('"delete_imported_source_data"') || !source.includes("deleteImportedSourceData") || !source.includes("确认删除") || !source.includes("原始日志未修改") || !source.includes("删除未完成；原始日志未修改")) fail("React 设置缺少二次确认、删除回执或失败保护");
if (!source.includes("triggerSync") || !source.includes("setSyncPaused") || !source.includes("readSyncRequestStatus")) fail("React 设置缺少同步控制与回执轮询");
if (!source.includes("readCustomSourceConfig") || !source.includes("addCustomSourceRoot") || !source.includes("removeCustomSourceRoot") || !source.includes("pickCustomSourceRoot")) fail("React 设置缺少自定义读取位置桥接");
if (!source.includes("readBudgetSettings") || !source.includes("saveBudgetProfile") || !source.includes("disableBudgetProfile") || !source.includes('"disable_budget_profile"') || !source.includes("snoozeBudgetCurrentPeriod") || !source.includes("clearBudgetSnooze")) fail("React 设置缺少预算状态、保存、停用或静默桥接");
if (!source.includes("预算（订阅 + 按量）") || !source.includes("80% 和 100%") || !source.includes("warning_ratio_bp: 8000")) fail("React 设置预算未固定新表单与阈值契约");
if (!source.includes("再次确认停用估算预算") || !source.includes("历史用量与已确认预算保留")) fail("React 设置预算停用缺少二次确认或历史保留语义");
if (!source.includes("readQuotaReminderConfig") || !source.includes("saveQuotaReminderConfig") || !source.includes('"quota_reminder_config"') || !source.includes('"save_quota_reminder_config"') || !source.includes("Claude Pro 额度窗口提醒") || !source.includes("系统通知未授权") || !source.includes("恢复为关闭并修复配置")) fail("React 设置缺少额度窗口提醒的只读/写入回执、权限状态或损坏配置恢复入口");
if (source.includes('"save_budget_config"') || source.includes('"save_harness_bill"')) fail("React 设置越过预算旧配置或账单 mutation 边界");
if (!source.includes("readBillingSettings") || !source.includes('"billing_confirmation_groups"') || !source.includes('"harness_bills_for_period"')) fail("React 设置缺少计费只读 DTO");
if (!source.includes("resolveBillingImportCandidate") || !source.includes('"resolve_billing_import_candidate"') || !source.includes("不是我的") || !source.includes("重新打开") || !source.includes("未修改历史金额") || !source.includes("hasCandidateHistory")) fail("React 设置缺少可逆计费候选处置回执或 dismissed-only 可见性");
if (!source.includes("previewBillingDeclaration") || !source.includes("saveBillingDeclaration") || !source.includes('"billing_candidate_impact_preview"') || !source.includes('"save_billing_declaration_revision"') || !source.includes("声明归属") || !source.includes("确认并保存声明") || !source.includes("重算任务已入队") || !source.includes("重算未入队") || !source.includes("当前数字仍是旧结果")) fail("React 设置缺少计费声明的影响预览、确认保存或重算回执");
if (!source.includes("retryBillingRecalculation") || !source.includes('"retry_billing_recalculation"') || !source.includes("重试重算") || !source.includes("旧结果仍可读") || !source.includes("重算任务已重新入队")) fail("React 设置缺少失败重算的安全重试回执或旧结果保留语义");
if (!source.includes("revokeBillingDeclaration") || !source.includes('"revoke_billing_declaration"') || !source.includes("再次确认撤销") || !source.includes("历史事实保留") || !source.includes("未来归因将按未声明状态重算")) fail("React 设置缺少计费声明的二次确认撤销或历史保留语义");
if (!source.includes("amendBillingDeclaration") || !source.includes('"official_subscription"') || !source.includes("修改订阅") || !source.includes("历史月份不变") || !source.includes("范围沿用当前声明") || !source.includes("currentMonthStart") || !source.includes("statisticsMonth(timezone)") || !source.includes("statisticsDay(timezone)") || !source.includes("await readStatisticsTimezone()")) fail("React 设置缺少订阅修订的范围保留、当前月起点、历史月份和重算回执语义");
if (tauriBridge.includes('timeZone: "Asia/Shanghai"') || !tauriBridge.includes('currentBudgetMonth((await readStatisticsTimezone()).timezone)') || !tauriBridge.includes('const timezone = (await readStatisticsTimezone()).timezone;')) fail("React 账期边界必须采用权威统计时区，不得固定上海时区");
if (!settingsPage.includes('setMonthly(""); setDaily(""); setMessage(tr("budget.currencyChanged"))')) fail("切换预算币种必须清除旧金额并提示重新输入");
if (["resolve_billing_import_candidate", "save_billing_declaration_revision", "revoke_billing_declaration", "save_harness_bill", "save_harness_bills", "delete_harness_bill"].some((command) => appSource.includes(`\"${command}\"`))) fail("React 设置越过计费归因或账单写入 mutation 边界");
if (!source.includes("readStatisticsSettings") || !source.includes('"retention_config"') || !source.includes('"statistics_timezone_config"') || !source.includes('"public_pricing_catalog_status"')) fail("React 设置缺少统计、保留期或价格目录只读 DTO");
if (!source.includes("readMonthlyExportSummary") || !source.includes("当前月摘要 CSV") || !source.includes("settings-data-section")) fail("React 设置缺少安全月度摘要导出面");
if (!source.includes("readAboutDiagnostics") || !source.includes("saveDiagnosticPackage") || !source.includes("checkForUpdates") || !source.includes("openTrustedReleasesPage") || !source.includes("settings-about-section")) fail("React 设置缺少关于与诊断安全桥接");
if (!source.includes("readSkillScan") || !source.includes("cancelSkillScan") || !source.includes("saveSkillsSnapshot") || !source.includes("readSkillsDiff") || !source.includes("readSkillsScanSettings") || !source.includes("saveSkillsScanSettings") || !source.includes("exportSkillsRedacted") || !source.includes('"skills_snapshot_save"') || !source.includes('"skills_diff_latest"') || !source.includes('"skills_scan_settings"') || !source.includes('"skills_export_redacted"') || !source.includes("upload_performed !== false") || !source.includes("快照未脱敏") || !source.includes("基线路径") || !source.includes("dropped_rows") || !source.includes("status === \"partial\"") || !source.includes("skills-page-header") || !source.includes('"skills_doctor_report"')) fail("React Skill 页未使用用户触发的安全扫描、快照、设置或导出安全 DTO");
if (!skillsPage.includes("sk.exportJson") || !skillsPage.includes("sk.advanced") || !skillsPage.includes("harnessOptions") || !skillsPage.includes("sk.exported")) fail("React Skill 页缺少脱敏导出、高级设置或动态执行环境体验");
if (["skills_export_redacted", "skills_export_pick_path", "save_skills_scan_settings", "disable_skill", "delete_skill"].some((command) => appSource.includes(`\"${command}\"`))) fail("React Skill 页越过导出、配置或修改 skill mutation 边界");
if (["save_public_pricing_catalog_policy", "update_public_pricing_catalog", "delete_retained_data", "clear_retention"].some((command) => appSource.includes(`\"${command}\"`))) fail("React 设置越过价格联网或数据删除 mutation 边界");
if (!source.includes("sx.showPath") || !source.includes("settings-custom-form")) fail("React 设置缺少本机位置的人机可读路径展示");
if (!source.includes('status === "unavailable" ? []')) fail("React 设置未隔离自定义位置配置不可用态");
if (!source.includes("尚未导入") || !source.includes("没有读取权限") || !source.includes("sx.srcUnavailable")) fail("React 设置缺少来源空态、错误映射或不可用态");
if (!source.includes("Promise.allSettled") || !source.includes("sync_pause_state") || !source.includes("read_overview")) fail("React 设置未保留来源状态的部分失败降级");
if (!settingsPage.includes("SettingsLoadingState") || !settingsPage.includes('message("settings.loadingRetain", language)')) fail("React 设置刷新未保留旧数据并明确 stale 状态");
if (/set(?:Report|CustomReport|BudgetReport|BillingReport|DataReport|AboutReport)\(null\)/u.test(settingsPage)) fail("React 设置刷新失败时清空了已有投影");
const routeQualityType = source.match(/export type RouteQualityModel[\s\S]*?\};/u)?.[0] || "";
if (/provider_raw|provider_id|credential_ref|endpoint_base_url/u.test(routeQualityType)) fail("React 路线质量模型投影携带了 provider/credential/endpoint 字段");

const html = fs.readFileSync(path.join(dist, "index.html"), "utf8");
if (!html.includes("<div id=\"root\"></div>")) fail("React production entry 缺少 root");
// React's production runtime contains documentation URLs and SVG namespace
// strings. The relevant offline gate is that our source does not create a
// network client or reference an external resource, not that vendor strings
// are absent from minified output.
if (/\b(fetch|WebSocket|EventSource|XMLHttpRequest)\s*\(/.test(source)) fail("React source creates an unapproved network client");
if (/<(?:script|link)[^>]+https?:\/\//i.test(html)) fail("React entry references an external resource");

if (!process.exitCode) console.log("React Workbench contract: OK (isolated build, typed bridge, offline bundle)");
