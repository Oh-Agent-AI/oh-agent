import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { FxSection } from "./FxSection";
import { PriceCardSection } from "./PriceCardSection";
import { QuoteVariantsSection } from "./QuoteVariantsSection";
import { harnessName } from "../../lib/harnessNames";
import { stable } from "../../lib/stable";
import { ToolbarActions } from "../../components/ui/ToolbarActions";
import { formatMinorMoney, languagePreference, message, message as translate, setLanguagePreference, useLanguage, type AppLanguage, type LanguagePreference, type MessageKey } from "../../lib/i18n";
import { isEditableCurrency, minorToEditableInput, suggestedInputCurrency, type EditableCurrency } from "../../lib/currencyPreference";
import { FOLLOW_SYSTEM_TIMEZONE, fetchWatcherHealth, type WatcherHealthStatus, addCustomSourceRoot, amendBillingDeclaration, checkForUpdates, clearBudgetSnooze, deleteImportedSourceData, disableBudgetProfile, invoke, listenAppEvents, makeInvalidationGate, openTrustedReleasesPage, pickCustomSourceRoot, previewBillingDeclaration, readAboutDiagnostics, readBillingSettings, readBudgetSettings, readCustomSourceConfig, readMonthlyExportSummary, readQuotaReminderConfig, readSourceHealth, readSourceHarnessControls, readSyncRequestStatus, readStatisticsSettings, readStatisticsTimezone, removeCustomSourceRoot, resolveBillingImportCandidate, retryBillingRecalculation, revokeBillingDeclaration, safeUiError, saveBudgetProfile, saveBillingDeclaration, saveDiagnosticPackage, saveQuotaReminderConfig, saveRetentionMonths, saveStatisticsTimezone, setSourceHarnessExcluded, setSyncPaused, snoozeBudgetCurrentPeriod, triggerSync, type AboutDiagnosticsReport, type BillingSettingsReport, type BudgetSettingsReport, type CustomSourceReport, type MonthlyExportSummary, type QuotaReminderConfig, type SourceConnectionState, type SourceErrorKind, type SourceHealthReport, type SourceHarnessControls, type StatisticsSettingsReport, type UpdateCheckResult } from "../../lib/tauri";

type McpSetupInfo = { cli_path: string | null; cli_version: string | null; data_home: string; tools: Array<{ name: string; description: string }> };
const SETTINGS_SECTION_IDS = ["settings-sources", "settings-billing", "settings-budget", "settings-notifications", "settings-data", "settings-about", "settings-mcp"] as const;
type SettingsSectionId = typeof SETTINGS_SECTION_IDS[number];

function mcpCodexConfig(cliPath: string): string {
  return `[mcp_servers.agent-vitals]\ncommand = ${JSON.stringify(cliPath)}\nargs = ["data-mcp", "serve", "--allow-local-writes"]`;
}

function mcpClaudeCommand(cliPath: string): string {
  const executable = cliPath.includes(" ") ? JSON.stringify(cliPath) : cliPath;
  return `claude mcp add agent-vitals -- ${executable} data-mcp serve --allow-local-writes`;
}

function mcpJsonConfig(cliPath: string): string {
  return JSON.stringify({ mcpServers: { "agent-vitals": { command: cliPath, args: ["data-mcp", "serve", "--allow-local-writes"] } } }, null, 2);
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.appendChild(field);
    field.select();
    const copied = document.execCommand("copy");
    field.remove();
    return copied;
  }
}

function sourceStateLabel(state: SourceConnectionState, language: AppLanguage): string {
  return message(`source.state.${state}` as MessageKey, language);
}

function sourceErrorLabel(error: SourceErrorKind, language: AppLanguage): string {
  return message(`source.error.${error}` as MessageKey, language);
}

function observedAt(value: number | null): string {
  if (value === null) return message("source.noRecord");
  return new Date(value).toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function syncLabel(report: SourceHealthReport, language: AppLanguage): string {
  if (report.sync.state === "ok") return report.sync.last_success_at ? message("sx.syncOkAt", language, { at: report.sync.last_success_at.slice(0, 16) }) : message("sx.syncOk", language);
  if (report.sync.state === "never") return message("sx.syncNever", language);
  if (report.sync.state === "failed") return message("sx.syncFailed", language);
  return message("sx.syncUnknown", language);
}

function sourceTone(state: SourceConnectionState): "success" | "warning" | "neutral" {
  if (state === "connected") return "success";
  if (state === "needs_attention") return "warning";
  return "neutral";
}

function sourceLabel(harness: string): string {
  return harnessName(harness);
}

function shortenPath(path: string): string {
  if (path.startsWith("~/")) return path;
  const parts = path.split(/[\\/]/u).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path;
}

function syncActionLabel(state: SourceConnectionState): string | null {
  if (state === "connected") return message("source.syncAll");
  if (state === "needs_attention") return message("source.resyncAll");
  if (state === "not_detected") return message("source.scanAll");
  return null;
}

function sourceControlLabel(state: SourceConnectionState): string | null {
  if (state === "excluded") return message("source.resumeRead");
  if (state === "connected" || state === "needs_attention" || state === "paused") return message("source.stopRead");
  return null;
}

function decimalToMinor(value: string): number | null {
  const text = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  try {
    const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
    if (minor <= 0n || minor > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(minor);
  } catch { return null; }
}

function decimalToMinorAllowZero(value: string): number | null {
  const text = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/u.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  try {
    const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
    return minor <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(minor) : null;
  } catch { return null; }
}

function minorToDecimal(value: number | null, currency: string, language?: AppLanguage): string {
  if (value === null || !Number.isSafeInteger(value)) return "—";
  if (isEditableCurrency(currency)) return formatMinorMoney(value, currency);
  return /^[A-Z]{3}$/u.test(currency) ? message("billing.minorUnitsUnknown", language, { currency, amount: value }) : "—";
}

function budgetStatusLabel(level: string, language: AppLanguage): string {
  const known = ["ok", "warn", "exceeded", "incomplete", "no_data", "disabled"];
  return message(known.includes(level) ? `budget.level.${level}` as MessageKey : "budget.level.unknown", language);
}

function budgetDate(value: number | null): string {
  if (value === null) return "";
  return new Date(value).toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function compactTokens(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function billingAmountText(amounts: Array<{ amount_minor: number; currency: string }>, language: AppLanguage): string {
  if (!amounts.length) return message("billing.noAvailableAmount", language);
  return amounts.map((amount) => minorToDecimal(amount.amount_minor, amount.currency, language)).join(" + ");
}

function statisticsMonth(timezone?: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit" }).format(new Date());
}

function statisticsDay(timezone?: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function pricingStateLabel(state: StatisticsSettingsReport["pricing"]["state"], language: AppLanguage): string {
  return message(`stats.priceState.${state}` as MessageKey, language);
}

function csvCell(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  const safe = /^[=+\-@]/u.test(text) ? `'${text}` : text;
  return /[",\n]/u.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

function exportCsv(summary: MonthlyExportSummary): string {
  const header = ["统计月份", "执行环境", "服务商", "tokens（执行环境汇总）", "计价口径", "币种", "金额", "未定价/待确认", "证据口径", "价格口径", "新鲜度"];
  const rows = summary.rows.map((row) => [summary.month, row.harness, row.provider ?? "执行环境汇总", row.tokens, row.basis, row.currency, row.amount === null ? null : row.amount.toFixed(6), row.unresolved ? "是" : "否", row.evidence_basis, row.pricing_method, row.freshness]);
  return [header, ...rows].map((line) => line.map(csvCell).join(",")).join("\n") + "\n";
}

function SettingsLoadingState({ loading, hasData, title, detail }: { loading: boolean; hasData: boolean; title: string; detail: string }) {
  const language = useLanguage();
  if (!loading) return null;
  // 已有数据时的后台刷新（每次同步 revision 前进都会触发七个区块同时重读）只给读屏提示，
  // 不再插入可见块——可见块出现/消失会改变页面高度，造成设置页反复抖动、跳位。
  if (hasData) return <span className="visually-hidden" role="status">{message("settings.loadingRefresh", language, { title })} {message("settings.loadingRetain", language)}</span>;
  return <div className="settings-source-state" role="status"><strong>{message("settings.loadingRead", language, { title })}</strong><span>{detail}</span></div>;
}

function useMountedRef() {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  return mounted;
}

type StatisticsDataSectionProps = { report: StatisticsSettingsReport | null; loading: boolean; error: string | null; onReload: () => void };

function StatisticsDataSection({ report, loading, error, onReload }: StatisticsDataSectionProps) {
  const language = useLanguage();
  const tr = (key: MessageKey, parameters: Record<string, string | number> = {}) => translate(key, language, parameters);
  const [timezone, setTimezone] = useState("");
  const [customTimezone, setCustomTimezone] = useState("");
  const [retention, setRetention] = useState("");
  const [savingTimezone, setSavingTimezone] = useState(false);
  const [savingRetention, setSavingRetention] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [exportSummary, setExportSummary] = useState<MonthlyExportSummary | null>(null);
  const [exportLoading, setExportLoading] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportPreview, setExportPreview] = useState(false);
  const mounted = useMountedRef();

  useEffect(() => {
    if (report?.timezone.status === "ok" && report.timezone.timezone) {
      const current = report.timezone.timezone;
      if (report.timezone.follows_system) setTimezone(FOLLOW_SYSTEM_TIMEZONE);
      else if (timezoneOptions.includes(current)) setTimezone(current);
      else { setTimezone("__custom__"); setCustomTimezone(current); }
    }
    if (report?.retention.status === "ok" && report.retention.months !== null) setRetention(String(report.retention.months));
  }, [report?.timezone.timezone, report?.timezone.follows_system, report?.retention.months]);

  const saveTimezone = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (savingTimezone) return;
    const next = timezone === "__custom__" ? customTimezone.trim() : timezone;
    setActionError(null); setMessage(null);
    if (!next) { setActionError(tr("stats.invalidTimezone")); return; }
    setSavingTimezone(true);
    try { const receipt = await saveStatisticsTimezone(next); if (!mounted.current) return; setTimezone(next === FOLLOW_SYSTEM_TIMEZONE ? FOLLOW_SYSTEM_TIMEZONE : receipt.timezone); setMessage(tr("stats.timezoneSaved", { timezone: receipt.timezone })); onReload(); }
    catch (reason: unknown) { if (mounted.current) setActionError(safeUiError(reason, tr("stats.timezoneSaveFailed"))); }
    finally { if (mounted.current) setSavingTimezone(false); }
  };

  const saveRetention = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (savingRetention || !report || report.retention.status !== "ok") return;
    const minimum = report.retention.minimum_months ?? 1;
    const maximum = report.retention.maximum_months ?? 60;
    const months = Number(retention);
    setActionError(null); setMessage(null);
    if (!Number.isSafeInteger(months) || months < minimum || months > maximum) { setActionError(tr("stats.invalidRetention", { min: minimum, max: maximum })); return; }
    setSavingRetention(true);
    try { const receipt = await saveRetentionMonths(months, minimum, maximum); if (!mounted.current) return; setRetention(String(receipt.months)); setMessage(tr("stats.retentionSaved", { months: receipt.months })); onReload(); }
    catch (reason: unknown) { if (mounted.current) setActionError(safeUiError(reason, tr("stats.retentionSaveFailed"))); }
    finally { if (mounted.current) setSavingRetention(false); }
  };

  const loadExport = async () => {
    if (exportLoading) return;
    setExportLoading(true); setExportError(null);
    const timezoneForExport = report?.timezone.status === "ok" ? report.timezone.timezone ?? undefined : undefined;
    try { const summary = await readMonthlyExportSummary(statisticsMonth(timezoneForExport)); if (!mounted.current) return; setExportSummary(summary); setExportPreview(true); }
    catch (reason: unknown) { if (mounted.current) { setExportSummary(null); setExportError(safeUiError(reason, tr("stats.exportReadFailed"))); } }
    finally { if (mounted.current) setExportLoading(false); }
  };

  const downloadExport = () => {
    if (!exportSummary) return;
    const blob = new Blob(["\uFEFF", exportCsv(exportSummary)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `agent-vitals-${exportSummary.month}-summary.csv`; anchor.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setMessage(tr("stats.exportSaved", { month: exportSummary.month }));
  };

  const timezoneOptions = ["UTC", "Asia/Shanghai", "Asia/Tokyo", "Asia/Singapore", "Europe/London", "America/Los_Angeles", "America/New_York"];
  return <section className="settings-data-section" id="settings-data" aria-labelledby="settings-data-title">
    <div className="settings-section-heading"><div><p className="eyebrow">{tr("stats.title")}</p><h3 id="settings-data-title">{tr("stats.title")}</h3><p>{tr("stats.description")}</p></div><button className="button button-secondary button-small" type="button" onClick={onReload} disabled={loading}>{tr(loading ? "billing.loading" : "stats.reload")}</button></div>
    {error && <div className="error-banner" role="alert">{tr("stats.error", { error })}<button className="button button-secondary button-small" type="button" onClick={onReload}>{tr("billing.retryButton")}</button></div>}
    <SettingsLoadingState loading={loading} hasData={Boolean(report)} title={tr("stats.settings")} detail={tr("stats.localOnly")} />
    {report && <>
      {report.timezone.system_timezone_fallback && <div className="error-banner" role="status">{tr("stats.fallbackUtc")}</div>}
      <div className="settings-data-grid">
        <form className="settings-data-card" onSubmit={saveTimezone} aria-labelledby="settings-timezone-title"><div className="settings-card-heading"><div><p className="eyebrow">{tr("stats.boundary")}</p><h4 id="settings-timezone-title">{tr("stats.timezone")}</h4></div>{report.timezone.status === "unavailable" && <span className="status-pill status-pill-warning">{tr("stats.unavailable")}</span>}</div>{report.timezone.status === "ok" && <><label><span>{tr("stats.timezoneField")}</span><select value={timezone === FOLLOW_SYSTEM_TIMEZONE ? "__system__" : timezoneOptions.includes(timezone) ? timezone : timezone ? "__custom__" : ""} onChange={(event) => { const value = event.target.value; setTimezone(value === "__system__" ? FOLLOW_SYSTEM_TIMEZONE : value); }}><option value="">{tr("stats.chooseTimezone")}</option><option value="__system__">{tr("stats.followSystem", { timezone: report.timezone.system_timezone ?? tr("stats.system") })}</option>{timezoneOptions.map((option) => <option value={option} key={option}>{option}</option>)}<option value="__custom__">{tr("stats.customIana")}</option></select></label>{timezone === "__custom__" && <label><span>{tr("stats.customTimezone")}</span><input value={customTimezone} onChange={(event) => setCustomTimezone(event.target.value)} placeholder={tr("stats.exampleTimezone")} autoComplete="off" /></label>}<p className="settings-data-help">{tr("stats.timezoneHelp")}</p><button className="button button-secondary" type="submit" disabled={savingTimezone || !timezone || timezone === "__custom__" && !customTimezone.trim()}>{tr(savingTimezone ? "billing.saving" : "stats.saveTimezone")}</button></>}</form>
        <form className="settings-data-card" onSubmit={saveRetention} aria-labelledby="settings-retention-title"><div className="settings-card-heading"><div><p className="eyebrow">{tr("stats.maintenance")}</p><h4 id="settings-retention-title">{tr("stats.retention")}</h4></div>{report.retention.status === "unavailable" && <span className="status-pill status-pill-warning">{tr("stats.unavailable")}</span>}</div>{report.retention.status === "ok" && <><label><span>{tr("stats.retentionMonths")}</span><input type="number" min={report.retention.minimum_months ?? 1} max={report.retention.maximum_months ?? 60} step="1" value={retention} onChange={(event) => setRetention(event.target.value)} /></label><p className="settings-data-help">{tr("stats.retentionHelp", { min: report.retention.minimum_months ?? 1, max: report.retention.maximum_months ?? 60 })}</p><button className="button button-secondary" type="submit" disabled={savingRetention || !retention}>{tr(savingRetention ? "billing.saving" : "stats.saveRetention")}</button></>}</form>
      </div>
      <div className="settings-data-card settings-pricing-card"><div className="settings-card-heading"><div><p className="eyebrow">{tr("stats.pricing")}</p><h4>{tr("stats.publicCatalog")}</h4></div>{report.pricing.status === "ok" && <span className={`status-pill status-pill-${report.pricing.available ? "success" : "warning"}`}>{pricingStateLabel(report.pricing.state, language)}</span>}</div>{report.pricing.status === "unavailable" ? <p className="settings-data-help">{tr("stats.pricingUnavailable")}</p> : <div className="settings-pricing-meta"><span>{tr("stats.version", { value: report.pricing.version ?? tr("stats.unknown") })}</span><span>{tr("stats.models", { value: report.pricing.model_count ?? tr("stats.unknown") })}</span><span>{tr("stats.lastSuccess", { value: report.pricing.last_success_at_ms ? new Date(report.pricing.last_success_at_ms).toLocaleString() : tr("stats.none") })}</span></div>}<p className="settings-data-help">{tr("stats.pricingHelp")}</p></div>
      <div className="settings-data-card settings-export-card"><div className="settings-card-heading"><div><p className="eyebrow">{tr("stats.export")}</p><h4>{tr("stats.currentCsv")}</h4></div><span className="status-pill">{tr("stats.noRaw")}</span></div><p className="settings-data-help">{tr("stats.exportHelp")}</p><div className="settings-export-actions"><button className="button button-secondary" type="button" onClick={loadExport} disabled={exportLoading}>{tr(exportLoading ? "billing.loading" : exportPreview ? "stats.refreshPreview" : "stats.previewFields")}</button><button className="button button-secondary" type="button" onClick={downloadExport} disabled={!exportSummary || exportSummary.freshness === "unavailable"}>{tr("stats.downloadCsv")}</button></div>{exportError && <p className="settings-data-error" role="alert">{exportError}</p>}{exportPreview && exportSummary && <div className="settings-export-preview" role="status"><strong>{tr("stats.exportRows", { month: exportSummary.month, count: exportSummary.rows.length })}</strong><span>{tr("stats.exportFields")}</span>{exportSummary.freshness === "unavailable" ? <small>{tr("stats.exportUnavailable")}</small> : exportSummary.rows.length === 0 && <small>{tr("stats.exportEmpty")}</small>}</div>}</div>
    </>}
    {actionError && <div className="error-banner" role="alert">{actionError}</div>}{message && <p className="settings-data-message" role="status" aria-live="polite">{message}</p>}
  </section>;
}

type AboutSectionProps = { report: AboutDiagnosticsReport | null; loading: boolean; error: string | null; onReload: () => void };

function AboutSection({ report, loading, error, onReload }: AboutSectionProps) {
  const language = useLanguage();
  const tr = (key: MessageKey, parameters: Record<string, string | number> = {}) => translate(key, language, parameters);
  const versionText = (value: string | null): string => value ?? tr("about.notAvailable");
  const [exporting, setExporting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [opening, setOpening] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [update, setUpdate] = useState<UpdateCheckResult | null>(null);
  const mounted = useMountedRef();

  const exportDiagnostics = async () => {
    if (exporting) return;
    setExporting(true); setActionError(null); setMessage(null);
    try { const receipt = await saveDiagnosticPackage(); if (mounted.current) setMessage(tr(receipt.status === "cancelled" ? "about.exportCancelled" : "about.exportSaved")); }
    catch (reason: unknown) { if (mounted.current) setActionError(safeUiError(reason, tr("about.exportFailed"))); }
    finally { if (mounted.current) setExporting(false); }
  };
  const describeUpdate = (result: UpdateCheckResult): string => {
    if (result.onLatestStable) return tr("about.updateLatestStable");
    if (result.status === "ok" && result.latestTag) return tr(result.updateAvailable ? "about.updateAvailable" : "about.updateCurrent", { current: result.currentVersion ?? tr("about.notAvailable"), latest: result.latestTag });
    return tr(result.status === "no_release" ? "about.updateNoRelease" : "about.updateUnavailable");
  };
  const checkUpdates = async () => {
    if (checking) return;
    setChecking(true); setActionError(null); setMessage(null);
    try { const result = await checkForUpdates(); if (mounted.current) { setUpdate(result); setMessage(describeUpdate(result)); } }
    catch (reason: unknown) { if (mounted.current) setActionError(safeUiError(reason, tr("about.updateFailed"))); }
    finally { if (mounted.current) setChecking(false); }
  };
  const openReleases = async () => {
    if (opening) return;
    setOpening(true); setActionError(null);
    try { await openTrustedReleasesPage(update?.updateAvailable ? update.releaseUrl : null); if (mounted.current) setMessage(tr("about.releasesOpened")); }
    catch (reason: unknown) { if (mounted.current) setActionError(safeUiError(reason, tr("about.releasesFailed"))); }
    finally { if (mounted.current) setOpening(false); }
  };
  return <section className="settings-about-section" id="settings-about" aria-labelledby="settings-about-title">
    <div className="settings-section-heading"><div><p className="eyebrow">{tr("about.title")}</p><h3 id="settings-about-title">{tr("about.title")}</h3><p>{tr("about.description")}</p></div><button className="button button-secondary button-small" type="button" onClick={onReload} disabled={loading}>{tr(loading ? "billing.loading" : "about.reload")}</button></div>
    {error && <div className="error-banner" role="alert">{tr("about.unavailable", { error })}<button className="button button-secondary button-small" type="button" onClick={onReload}>{tr("billing.retryButton")}</button></div>}
    <SettingsLoadingState loading={loading} hasData={Boolean(report)} title={tr("about.versions")} detail={tr("about.localOnly")} />
    {report && <div className="settings-about-card"><dl className="settings-version-list"><div><dt>App</dt><dd>{versionText(report.appVersion ?? null)}</dd></div><div><dt>CLI</dt><dd>{versionText(report.cliVersion ?? null)}</dd></div><div><dt>Engine</dt><dd>{versionText(report.engineVersion ?? null)}</dd></div><div><dt>Authority schema</dt><dd>{versionText(report.authoritySchema ?? null)}</dd></div><div><dt>{tr("about.pricing")}</dt><dd>{report.pricing?.version ? `${report.pricing.version}${report.pricing.capturedAtMs ? ` · ${new Date(report.pricing.capturedAtMs).toLocaleString()}` : ""}` : tr("about.noSnapshot")}</dd></div><div><dt>{tr("about.statisticsTimezone")}</dt><dd>{report.statisticsTimezone ?? tr("about.notAvailable")}</dd></div><div><dt>{tr("about.sync")}</dt><dd>{tr(report.sync.state === "ok" ? "about.syncOk" : report.sync.state === "needs_attention" ? "about.syncAttention" : "about.syncUnknown")}</dd></div></dl><div className="settings-about-actions"><button className="button button-secondary" type="button" onClick={exportDiagnostics} disabled={exporting}>{tr(exporting ? "about.exporting" : "about.export")}</button><button className="button button-secondary" type="button" onClick={checkUpdates} disabled={checking}>{tr(checking ? "about.checking" : "about.checkUpdates")}</button><button className="button button-secondary" type="button" onClick={openReleases} disabled={opening}>{tr(opening ? "about.opening" : "about.openReleases")}</button></div>{update && <p className="settings-about-update" role="status">{update.status === "unavailable" ? tr("about.updateNotAutomatic") : update.onLatestStable ? tr("about.releaseLatestStable") : update.status === "no_release" ? tr("about.releaseNotFound") : tr("about.releaseConfirmed", { latest: update.latestTag ?? tr("about.notAvailable") })}</p>}</div>}
    {actionError && <div className="error-banner" role="alert">{actionError}</div>}{message && <p className="settings-about-message" role="status" aria-live="polite">{message}</p>}
  </section>;
}

type BillingSectionProps = { report: BillingSettingsReport | null; loading: boolean; error: string | null; onReload: () => void };

function BillingSection({ report, loading, error, onReload }: BillingSectionProps) {
  const language = useLanguage();
  const tr = (key: MessageKey, parameters: Record<string, string | number> = {}) => translate(key, language, parameters);
  const [expanded, setExpanded] = useState(false);
  const [candidateBusy, setCandidateBusy] = useState<string | null>(null);
  const [candidateMessage, setCandidateMessage] = useState<string | null>(null);
  const [candidateError, setCandidateError] = useState<string | null>(null);
  const [declarationGroup, setDeclarationGroup] = useState<BillingSettingsReport["groups"][number] | null>(null);
  const [declarationKind, setDeclarationKind] = useState<"official_api" | "third_party" | "organization">("official_api");
  const [declarationImpact, setDeclarationImpact] = useState<import("../../lib/tauri").BillingImpactPreview | null>(null);
  const [declarationBusy, setDeclarationBusy] = useState<"preview" | "save" | null>(null);
  const [declarationError, setDeclarationError] = useState<string | null>(null);
  const [declarationMessage, setDeclarationMessage] = useState<string | null>(null);
  const [retryJobId, setRetryJobId] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [retryMessage, setRetryMessage] = useState<string | null>(null);
  const [revokeDeclarationId, setRevokeDeclarationId] = useState<string | null>(null);
  const [revokeBusy, setRevokeBusy] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [revokeMessage, setRevokeMessage] = useState<string | null>(null);
  const [amendDeclaration, setAmendDeclaration] = useState<BillingSettingsReport["declarations"][number] | null>(null);
  const [amendName, setAmendName] = useState("");
  const [amendAmount, setAmendAmount] = useState("");
  const [amendCurrency, setAmendCurrency] = useState<string>(() => suggestedInputCurrency());
  const [amendCurrencyChanged, setAmendCurrencyChanged] = useState(false);
  const [amendEnd, setAmendEnd] = useState("");
  const [amendBusy, setAmendBusy] = useState(false);
  const [amendError, setAmendError] = useState<string | null>(null);
  const [amendMessage, setAmendMessage] = useState<string | null>(null);
  const mounted = useMountedRef();
  const pendingGroups = report?.groups ?? [];
  const pendingCandidates = (report?.candidates ?? []).filter((candidate) => candidate.status === "pending");
  const dismissedCandidates = (report?.candidates ?? []).filter((candidate) => candidate.status === "dismissed");
  const hasPending = pendingGroups.length > 0 || pendingCandidates.length > 0;
  const hasCandidateHistory = hasPending || dismissedCandidates.length > 0;
  const failedJobs = (report?.jobs ?? []).filter((job) => job.status === "failed" || job.status === "cancelled");
  const changeCandidate = async (candidateId: string, decision: "dismiss" | "reopen") => {
    if (candidateBusy) return;
    setCandidateBusy(candidateId); setCandidateError(null); setCandidateMessage(null);
    try {
      const receipt = await resolveBillingImportCandidate(candidateId, decision);
      if (!mounted.current) return;
      setCandidateMessage(tr(receipt.changed ? decision === "dismiss" ? "billing.candidateDismissed" : "billing.candidateReopened" : "billing.candidateUnchanged"));
      onReload();
    } catch (reason: unknown) {
      if (mounted.current) setCandidateError(safeUiError(reason, tr("billing.candidateFailed")));
    } finally { if (mounted.current) setCandidateBusy(null); }
  };
  const retryJob = async (jobId: string) => {
    if (retryJobId) return;
    setRetryJobId(jobId); setRetryError(null); setRetryMessage(null);
    try {
      const receipt = await retryBillingRecalculation(jobId);
      if (!mounted.current) return;
      setRetryMessage(tr(receipt.changed ? "billing.retryQueued" : "billing.retryUnchanged", { id: receipt.job_id }));
      onReload();
    } catch (reason: unknown) {
      if (mounted.current) setRetryError(safeUiError(reason, tr("billing.retryFailed")));
    } finally { if (mounted.current) setRetryJobId(null); }
  };
  const revokeDeclaration = async (declaration: BillingSettingsReport["declarations"][number]) => {
    if (!declaration.current_revision_id || revokeBusy) return;
    if (revokeDeclarationId !== declaration.declaration_id) { setRevokeDeclarationId(declaration.declaration_id); setRevokeError(null); setRevokeMessage(null); return; }
    setRevokeBusy(declaration.declaration_id); setRevokeError(null); setRevokeMessage(null);
    try {
      const receipt = await revokeBillingDeclaration({ declaration_id: declaration.declaration_id, supersedes_revision_id: declaration.current_revision_id });
      if (!mounted.current) return;
      setRevokeMessage(tr(receipt.changed ? "billing.revokeSaved" : "billing.revokeUnchanged", { id: receipt.declaration_id }));
      setRevokeDeclarationId(null); onReload();
    } catch (reason: unknown) { if (mounted.current) setRevokeError(safeUiError(reason, tr("billing.revokeFailed"))); }
    finally { if (mounted.current) setRevokeBusy(null); }
  };
  const openAmendment = (declaration: BillingSettingsReport["declarations"][number]) => {
    setAmendDeclaration(declaration); setAmendName(declaration.subscription_name ?? ""); setAmendAmount(declaration.amount_minor === null || !isEditableCurrency(declaration.currency) ? "" : minorToEditableInput(declaration.amount_minor) ?? ""); setAmendCurrency(declaration.currency ?? suggestedInputCurrency()); setAmendCurrencyChanged(false); setAmendEnd(declaration.effective_end ?? ""); setAmendError(null); setAmendMessage(null);
  };
  const saveAmendment = async () => {
    if (!amendDeclaration || amendBusy || !amendDeclaration.current_revision_id) return;
    setAmendBusy(true); setAmendError(null); setAmendMessage(null);
    const amountMinor = amendAmount.trim() === "" ? null : decimalToMinorAllowZero(amendAmount);
    if (amendAmount.trim() !== "" && amountMinor === null) { setAmendError(tr("billing.amountInvalid")); setAmendBusy(false); return; }
    if (amendCurrencyChanged && amendDeclaration.amount_minor !== null && amountMinor === null) { setAmendError(tr("billing.currencyReentry")); setAmendBusy(false); return; }
    if (amendDeclaration.currency !== null && !isEditableCurrency(amendDeclaration.currency)) { setAmendError(tr("billing.currencyUnsupported")); setAmendBusy(false); return; }
    if (amountMinor !== null && !isEditableCurrency(amendCurrency)) { setAmendError(tr("billing.currencyChoose")); setAmendBusy(false); return; }
    const effectiveEnd = amendEnd.trim() === "" ? null : amendEnd.trim();
    try {
      const timezone = (await readStatisticsTimezone()).timezone;
      const currentMonthStart = `${statisticsMonth(timezone)}-01`;
      const effectiveStart = amendDeclaration.effective_start > currentMonthStart ? amendDeclaration.effective_start : currentMonthStart;
      if (effectiveEnd !== null && (!/^\d{4}-\d{2}-\d{2}$/u.test(effectiveEnd) || effectiveEnd < effectiveStart || effectiveEnd > statisticsDay(timezone))) { setAmendError(tr("billing.endInvalid")); return; }
      const receipt = await amendBillingDeclaration({ declaration_id: amendDeclaration.declaration_id, supersedes_revision_id: amendDeclaration.current_revision_id, provider_id: amendDeclaration.provider_id, subscription_name: amendName.trim() || null, amount_minor: amountMinor, currency: amountMinor === null ? null : amendCurrency, effective_start: effectiveStart, effective_end: effectiveEnd, source_candidate_id: amendDeclaration.source_candidate_id, scopes: amendDeclaration.scopes });
      if (!mounted.current) return;
      if (receipt.job?.status === "queued") setAmendMessage(tr("billing.amendQueued", { start: effectiveStart, id: receipt.job.job_id }));
      else if (receipt.job?.status === "enqueue_failed") setAmendMessage(tr("billing.amendEnqueueFailed"));
      else setAmendMessage(tr("billing.amendSaved"));
      setAmendDeclaration(null); onReload();
    } catch (reason: unknown) { if (mounted.current) setAmendError(safeUiError(reason, tr("billing.amendFailed"))); }
    finally { if (mounted.current) setAmendBusy(false); }
  };
  const openDeclaration = (group: BillingSettingsReport["groups"][number]) => {
    setDeclarationGroup(group); setDeclarationKind("official_api"); setDeclarationImpact(null); setDeclarationError(null); setDeclarationMessage(null);
  };
  const declarationScopes = declarationGroup?.model_id && declarationGroup.model_id !== "<unknown>"
    ? [{ scope_kind: "model" as const, scope_value: declarationGroup.model_id }]
    : [{ scope_kind: "provider" as const, scope_value: "unresolved" }];
  // No recognisable model means nothing to narrow the declaration with; declarations no longer bind to a harness,
  // so an unscoped one would become a catch-all for all usage. Block it here (the data layer rejects it too).
  const declarationUnbounded = declarationScopes.every((scope) => scope.scope_kind === "provider");
  const previewDeclaration = async () => {
    if (!declarationGroup || declarationBusy || declarationUnbounded) return;
    setDeclarationBusy("preview"); setDeclarationError(null); setDeclarationMessage(null);
    try {
      const impact = await previewBillingDeclaration({ provider_id: declarationGroup.provider_id, relationship_kind: declarationKind, effective_start: declarationGroup.effective_start, effective_end: declarationGroup.effective_end, scopes: declarationScopes });
      if (mounted.current) setDeclarationImpact(impact);
    } catch (reason: unknown) { if (mounted.current) setDeclarationError(safeUiError(reason, tr("billing.previewFailed"))); }
    finally { if (mounted.current) setDeclarationBusy(null); }
  };
  const saveDeclaration = async () => {
    if (!declarationGroup || !declarationImpact || declarationBusy || declarationUnbounded) return;
    setDeclarationBusy("save"); setDeclarationError(null); setDeclarationMessage(null);
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const receipt = await saveBillingDeclaration({ revision_id: `rev-react-${suffix}`, declaration_id: `decl-react-${suffix}`, provider_id: declarationGroup.provider_id, relationship_kind: declarationKind, effective_start: declarationGroup.effective_start, effective_end: declarationGroup.effective_end, source_candidate_id: null, evidence_ref: `react:confirmation-group:${declarationGroup.group_id}`, scopes: declarationScopes });
      if (!mounted.current) return;
      if (receipt.job?.status === "queued") {
        setDeclarationMessage(tr("billing.declarationQueued", { id: receipt.job.job_id }));
      } else if (receipt.job?.status === "enqueue_failed") {
        setDeclarationMessage(tr("billing.declarationEnqueueFailed"));
        setDeclarationError(tr("billing.declarationRetryHelp"));
      } else {
        setDeclarationMessage(tr("billing.declarationSaved"));
      }
      setDeclarationGroup(null); setDeclarationImpact(null); onReload();
    } catch (reason: unknown) { if (mounted.current) setDeclarationError(safeUiError(reason, tr("billing.declarationFailed"))); }
    finally { if (mounted.current) setDeclarationBusy(null); }
  };
  const amendmentCurrencyUnsupported = Boolean(amendDeclaration && amendDeclaration.currency !== null && !isEditableCurrency(amendDeclaration.currency));
  return <section className="settings-billing-section" id="settings-billing" aria-labelledby="settings-billing-title">
    <div className="settings-section-heading"><div><p className="eyebrow">{tr("billing.title")}</p><h3 id="settings-billing-title">{tr("billing.title")}</h3><p>{tr("billing.description")}</p></div><button className="button button-secondary button-small" type="button" onClick={onReload} disabled={loading}>{loading ? tr("billing.loading") : tr("billing.reload")}</button></div>
    {error && <div className="error-banner" role="alert">{tr("billing.unavailableError", { error })}<button className="button button-secondary button-small" type="button" onClick={onReload}>{tr("billing.retryButton")}</button></div>}
    <SettingsLoadingState loading={loading} hasData={Boolean(report)} title={tr("billing.status")} detail={tr("billing.readOnlyHelp")} />
    {report && <>
      {hasCandidateHistory && <div className="settings-billing-todo"><div><strong>{tr(hasPending ? "billing.pendingTitle" : "billing.dismissedTitle")}</strong><span>{hasPending ? tr("billing.pendingCount", { count: pendingGroups.length + pendingCandidates.length }) : tr("billing.dismissedCount", { count: dismissedCandidates.length })}</span></div><button className="button button-primary" type="button" onClick={() => setExpanded((value) => !value)}>{tr(expanded ? "billing.hideCandidates" : "billing.showCandidates")}</button></div>}
      {!hasPending && report.groups_status === "ok" && report.candidates_status === "ok" && <p className="settings-billing-empty">{tr("billing.noPending")}</p>}
      {expanded && <div className="settings-billing-pending" aria-label={tr("billing.pendingAria")}>
        {pendingGroups.slice(0, 32).map((group) => <article className="settings-billing-row" key={group.group_id}><div><strong>{group.harness} · {group.provider_id} · {group.model_id}</strong><span>{tr("billing.groupSummary", { tokens: compactTokens(group.tokens), sessions: group.session_count, amounts: billingAmountText(group.estimated_amounts, language), evidence: tr(group.evidence_state === "unresolved" ? "billing.evidenceUnresolved" : group.evidence_state === "determined" ? "billing.evidenceDetermined" : "billing.evidenceNeedsReview") })}</span></div><div className="settings-billing-row-actions"><small>{group.effective_start}{group.effective_end && group.effective_end !== group.effective_start ? ` – ${group.effective_end}` : ""}</small><button className="button button-secondary button-small" type="button" onClick={() => openDeclaration(group)} disabled={declarationBusy !== null}>{tr("billing.declare")}</button></div></article>)}
        {declarationGroup && <div className="settings-billing-declaration" role="dialog" aria-labelledby="settings-billing-declaration-title"><div className="settings-card-heading"><div><p className="eyebrow">{tr("billing.previewFirst")}</p><h4 id="settings-billing-declaration-title">{tr("billing.declareTitle", { provider: declarationGroup.provider_id, model: declarationGroup.model_id })}</h4></div><button className="button button-secondary button-small" type="button" onClick={() => setDeclarationGroup(null)} disabled={declarationBusy !== null}>{tr("billing.cancel")}</button></div><label><span>{tr("billing.relationship")}</span><select value={declarationKind} onChange={(event) => { setDeclarationKind(event.target.value as typeof declarationKind); setDeclarationImpact(null); }} disabled={declarationBusy !== null}><option value="official_api">{tr("billing.officialApi")}</option><option value="third_party">{tr("billing.thirdParty")}</option><option value="organization">{tr("billing.organization")}</option></select></label><p className="settings-data-help">{tr("billing.scopeDate", { scope: declarationScopes.map((scope) => `${scope.scope_kind}=${scope.scope_value}`).join(", "), start: declarationGroup.effective_start, end: declarationGroup.effective_end ? ` – ${declarationGroup.effective_end}` : tr("billing.continuing") })}</p>{declarationUnbounded && <p className="settings-budget-warning" role="alert">{tr("billing.needModel")}</p>}<div className="settings-billing-declaration-actions"><button className="button button-secondary" type="button" onClick={previewDeclaration} disabled={declarationBusy !== null || declarationUnbounded}>{tr(declarationBusy === "preview" ? "billing.previewing" : "billing.previewImpact")}</button>{declarationImpact && <button className="button button-primary" type="button" onClick={saveDeclaration} disabled={declarationBusy !== null}>{tr(declarationBusy === "save" ? "billing.saving" : "billing.confirmSave")}</button>}</div>{declarationImpact && <div className="settings-billing-preview" role="status"><strong>{tr("billing.impactCount", { tokens: compactTokens(declarationImpact.moved.tokens), sessions: declarationImpact.moved.session_count })}</strong><span>{tr(declarationImpact.changes_amounts ? "billing.impactMoney" : "billing.impactNoMoney")}</span>{declarationImpact.pending.tokens > 0 && <small>{tr("billing.pendingTokens", { tokens: compactTokens(declarationImpact.pending.tokens) })}</small>}</div>}
        </div>}
        {pendingCandidates.map((candidate) => <article className="settings-billing-row" key={candidate.candidate_id}><div><strong>{candidate.provider_id} · {tr("billing.perMonth", { amount: minorToDecimal(candidate.amount_minor, candidate.currency, language) })} · {candidate.harness}</strong><span>{tr("billing.candidateHistory", { start: candidate.billing_period_start, impact: candidate.impact ? tr("billing.candidateImpact", { tokens: compactTokens(candidate.impact.total_tokens), sessions: candidate.impact.session_count }) : "" })}</span></div><div className="settings-billing-row-actions"><small>{tr("billing.candidateNoChange")}</small><button className="button button-secondary button-small" type="button" onClick={() => changeCandidate(candidate.candidate_id, "dismiss")} disabled={candidateBusy !== null}>{tr(candidateBusy === candidate.candidate_id ? "billing.saving" : "billing.notMine")}</button></div></article>)}
        {dismissedCandidates.length > 0 && <div className="settings-billing-list"><div className="settings-setting-label">{tr("billing.dismissedList")}</div>{dismissedCandidates.slice(0, 32).map((candidate) => <article className="settings-billing-row" key={candidate.candidate_id}><div><strong>{candidate.provider_id} · {candidate.harness}</strong><span>{tr("billing.dismissedHelp")}</span></div><button className="button button-secondary button-small" type="button" onClick={() => changeCandidate(candidate.candidate_id, "reopen")} disabled={candidateBusy !== null}>{tr(candidateBusy === candidate.candidate_id ? "billing.saving" : "billing.reopen")}</button></article>)}</div>}
        <p className="settings-billing-deferred" role="note">{tr("billing.candidatePolicy")}</p>
      </div>}
      {report.declarations_status !== "unavailable" && report.declarations.length > 0 && <div className="settings-billing-list">
        <div className="settings-setting-label">{tr("billing.currentDeclarations")}</div>
        {report.declarations.slice(0, 32).map((declaration) => <article className="settings-billing-row" key={declaration.declaration_id}>
          <div><strong>{declaration.provider_id}</strong><span>{tr(declaration.relationship_kind === "official_subscription" ? "billing.officialSubscription" : declaration.relationship_kind === "official_api" ? "billing.officialMetered" : declaration.relationship_kind === "organization" ? "billing.organization" : declaration.relationship_kind === "third_party" ? "billing.thirdParty" : "billing.unknownRelationship")} · {declaration.subscription_name ?? tr("billing.unnamed")}{declaration.amount_minor !== null && declaration.currency ? ` · ${minorToDecimal(declaration.amount_minor, declaration.currency, language)}` : ""}</span><small>{declaration.effective_start}{declaration.effective_end ? ` – ${declaration.effective_end}` : tr("billing.continuing")} · {tr("billing.scopeCount", { count: declaration.scope_count })}</small></div>
          <div className="settings-billing-row-actions">{declaration.relationship_kind === "official_subscription" && declaration.current_revision_id && <button className="button button-secondary button-small" type="button" onClick={() => openAmendment(declaration)} disabled={amendBusy || revokeBusy !== null}>{tr("billing.editSubscription")}</button>}{declaration.current_revision_id && <button className="button button-secondary button-small" type="button" onClick={() => revokeDeclaration(declaration)} disabled={revokeBusy !== null || amendBusy}>{tr(revokeBusy === declaration.declaration_id ? "billing.revoking" : revokeDeclarationId === declaration.declaration_id ? "billing.confirmRevoke" : "billing.revoke")}</button>}</div>
          {amendDeclaration?.declaration_id === declaration.declaration_id && <div className="settings-billing-amendment" role="group" aria-labelledby={`billing-amendment-${declaration.declaration_id}`}>
            <h4 id={`billing-amendment-${declaration.declaration_id}`}>{tr("billing.amendTitle")}</h4><p>{tr("billing.amendHelp")}</p>
            {amendmentCurrencyUnsupported && <p role="alert">{tr("billing.amendUnsupported", { currency: declaration.currency ?? "" })}</p>}
            <label><span>{tr("billing.planName")}</span><input value={amendName} onChange={(event) => setAmendName(event.target.value)} disabled={amendBusy || amendmentCurrencyUnsupported} /></label>
            <div className="settings-billing-amendment-grid">
              <label><span>{tr("billing.monthlyFee")}</span><input inputMode="decimal" value={amendAmount} onChange={(event) => setAmendAmount(event.target.value)} placeholder={tr("billing.amountUnknown")} disabled={amendBusy || amendmentCurrencyUnsupported} /></label>
              <label><span>{tr("billing.currency")}</span><select value={amendCurrency} onChange={(event) => { setAmendCurrency(event.target.value as EditableCurrency); setAmendCurrencyChanged(true); setAmendAmount(""); }} disabled={amendBusy || amendmentCurrencyUnsupported}>
                {!isEditableCurrency(amendCurrency) && <option value={amendCurrency}>{amendCurrency} · {tr("billing.unsupportedOption")}</option>}
                <option value="CNY">CNY</option><option value="USD">USD</option>
              </select></label>
              <label><span>{tr("billing.endDate")}</span><input type="date" value={amendEnd} onChange={(event) => setAmendEnd(event.target.value)} disabled={amendBusy || amendmentCurrencyUnsupported} /></label>
            </div>
            <div className="settings-billing-declaration-actions"><button className="button button-primary" type="button" onClick={saveAmendment} disabled={amendBusy || amendmentCurrencyUnsupported}>{tr(amendBusy ? "billing.saving" : "billing.saveAmendment")}</button><button className="button button-secondary" type="button" onClick={() => setAmendDeclaration(null)} disabled={amendBusy}>{tr("billing.cancel")}</button></div>
            <small>{tr("billing.amendScope", { count: declaration.scope_count })}</small>
          </div>}
        </article>)}
      </div>}
      {failedJobs.length > 0 && <div className="settings-billing-job-warning" role="alert"><div><strong>{tr("billing.jobWarning")}</strong><span>{tr("billing.jobWarningHelp")}</span></div><div className="settings-billing-job-list">{failedJobs.slice(0, 32).map((job) => <article className="settings-billing-job-row" key={job.job_id}><div><strong>{job.job_id}</strong><span>{tr(job.status === "cancelled" ? "billing.jobCancelled" : "billing.jobFailed")}{job.error_code ? ` · ${job.error_code}` : ""} · {tr("billing.jobRequested", { date: observedAt(job.requested_at_ms) })}</span></div><button className="button button-secondary button-small" type="button" onClick={() => retryJob(job.job_id)} disabled={retryJobId !== null}>{tr(retryJobId === job.job_id ? "billing.retrying" : "billing.retry")}</button></article>)}</div><small>{tr("billing.retryHelp")}</small></div>}
      {report.bills_status !== "unavailable" && report.bills.length > 0 && <div className="settings-billing-list"><div className="settings-setting-label">{tr("billing.recordedBills")}</div>{report.bills.slice(0, 64).map((bill) => <div className="settings-billing-row" key={bill.bill_id}><div><strong>{bill.harness} · {bill.provider_id}</strong><span>{minorToDecimal(bill.amount_minor, bill.currency, language)} · {tr(bill.billing_basis === "fixed_subscription" ? "billing.billSubscription" : bill.billing_basis === "harness_billed" ? "billing.billHarnessBilled" : bill.billing_basis === "metered_actual" ? "billing.billMeteredActual" : "billing.unknownBasis")}</span></div><small>{bill.billing_period} · {tr(bill.has_evidence ? "billing.sourceRecorded" : "billing.sourceMissing")}</small></div>)}</div>}
      {(report.groups_status === "unavailable" || report.candidates_status === "unavailable") && <p className="settings-billing-unavailable" role="alert">{tr("billing.pendingUnavailable")}</p>}
      {report.declarations_status === "unavailable" && <p className="settings-billing-unavailable" role="alert">{tr("billing.declarationsUnavailable")}</p>}
      {report.jobs_status === "unavailable" && <p className="settings-billing-unavailable" role="alert">{tr("billing.jobsUnavailable")}</p>}
      {report.bills_status === "unavailable" && <p className="settings-billing-unavailable" role="alert">{tr("billing.billsUnavailable")}</p>}
      {(report.groups_status === "partial" || report.candidates_status === "partial" || report.declarations_status === "partial" || report.jobs_status === "partial" || report.bills_status === "partial") && <p className="settings-billing-unavailable" role="status">{tr("billing.partial")}</p>}
    </>}
    {candidateError && <div className="error-banner" role="alert">{candidateError}</div>}
    {candidateMessage && <p className="settings-data-message" role="status" aria-live="polite">{candidateMessage}</p>}
    {declarationError && <div className="error-banner" role="alert">{declarationError}</div>}
    {declarationMessage && <p className="settings-data-message" role="status" aria-live="polite">{declarationMessage}</p>}
    {retryError && <div className="error-banner" role="alert">{retryError}</div>}
    {retryMessage && <p className="settings-data-message" role="status" aria-live="polite">{retryMessage}</p>}
    {revokeError && <div className="error-banner" role="alert">{revokeError}</div>}
    {revokeMessage && <p className="settings-data-message" role="status" aria-live="polite">{revokeMessage}</p>}
    {amendError && <div className="error-banner" role="alert">{amendError}</div>}
    {amendMessage && <p className="settings-data-message" role="status" aria-live="polite">{amendMessage}</p>}
  </section>;
}

type BudgetSectionProps = { report: BudgetSettingsReport | null; loading: boolean; error: string | null; onReload: () => void };

function BudgetSection({ report, loading, error, onReload }: BudgetSectionProps) {
  const language = useLanguage();
  const tr = (key: MessageKey, parameters: Record<string, string | number> = {}) => translate(key, language, parameters);
  const [currency, setCurrency] = useState<string>(() => suggestedInputCurrency());
  const [monthly, setMonthly] = useState("");
  const [daily, setDaily] = useState("");
  const [saving, setSaving] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [disableArmed, setDisableArmed] = useState(false);
  const [snoozing, setSnoozing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const mounted = useMountedRef();

  useEffect(() => {
    const estimate = report?.estimate;
    if (estimate) {
      setCurrency(estimate.currency);
      setMonthly(minorToEditableInput(estimate.monthly_minor) ?? "");
      setDaily(estimate.daily_minor === null ? "" : minorToEditableInput(estimate.daily_minor) ?? "");
    } else if (report?.status === "ok") {
      setMonthly("");
      setDaily("");
      setDisableArmed(false);
    }
  }, [report?.estimate?.profile_id, report?.estimate?.updated_at_ms]);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    const monthlyMinor = decimalToMinor(monthly);
    const dailyMinor = daily.trim() === "" ? null : decimalToMinor(daily);
    setMessage(null);
    setActionError(null);
    if (!isEditableCurrency(currency)) { setActionError(tr("budget.currencyUnsupported")); return; }
    if (monthlyMinor === null) { setActionError(tr("budget.invalidMonthly")); return; }
    if (daily.trim() !== "" && dailyMinor === null) { setActionError(tr("budget.invalidDaily")); return; }
    setSaving(true);
    try {
      const receipt = await saveBudgetProfile({ currency, monthly_minor: monthlyMinor, daily_minor: dailyMinor });
      if (!mounted.current) return;
      setMessage(`${tr("budget.saved", { time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) })}${receipt.notification_permission === "granted" ? "" : ` ${tr("budget.notificationDenied")}`}`);
      onReload();
    } catch (reason: unknown) {
      if (mounted.current) setActionError(safeUiError(reason, "预算保存失败"));
    } finally { if (mounted.current) setSaving(false); }
  };

  const toggleSnooze = async () => {
    if (snoozing) return;
    setSnoozing(true); setMessage(null); setActionError(null);
    try {
      if (report?.snoozed_until_ms && report.snoozed_until_ms > Date.now()) {
        await clearBudgetSnooze();
        if (!mounted.current) return;
        setMessage(tr("budget.alertsResumed"));
      } else {
        await snoozeBudgetCurrentPeriod();
        if (!mounted.current) return;
        setMessage(tr("budget.alertsMuted"));
      }
      if (mounted.current) onReload();
    } catch (reason: unknown) { if (mounted.current) setActionError(safeUiError(reason, "预算提醒设置失败")); }
    finally { if (mounted.current) setSnoozing(false); }
  };

  const disable = async () => {
    if (disabling) return;
    if (!disableArmed) { setDisableArmed(true); setActionError(null); setMessage(tr("budget.confirmDisableHelp")); return; }
    setDisabling(true); setActionError(null); setMessage(null);
    try {
      const receipt = await disableBudgetProfile();
      if (!mounted.current) return;
      setDisableArmed(false);
      setMessage(tr(receipt.changed ? "budget.disabled" : "budget.alreadyDisabled"));
      onReload();
    } catch (reason: unknown) { if (mounted.current) setActionError(safeUiError(reason, "预算停用失败")); }
    finally { if (mounted.current) setDisabling(false); }
  };

  const estimate = report?.estimate;
  const unsupportedCurrency = Boolean(estimate && !isEditableCurrency(estimate.currency));
  const snoozed = report?.snoozed_until_ms !== null && report?.snoozed_until_ms !== undefined && report.snoozed_until_ms > Date.now();
  const availableReport = report?.status === "ok" ? report : null;
  return <section className="settings-budget-section" id="settings-budget" aria-labelledby="settings-budget-title">
    <div className="settings-section-heading"><div><p className="eyebrow">{tr("nav.settings")}</p><h3 id="settings-budget-title">{tr("budget.title")}</h3><p>{tr("budget.description")}</p></div><button className="button button-secondary button-small" type="button" onClick={onReload} disabled={loading}>{tr(loading ? "toolbar.loading" : "budget.reload")}</button></div>
    {error && <div className="error-banner" role="alert">{tr("budget.error", { error })}<button className="button button-secondary button-small" type="button" onClick={onReload}>{tr("action.refresh")}</button></div>}
    <SettingsLoadingState loading={loading} hasData={Boolean(report)} title={tr("budget.status")} detail={tr("budget.localOnly")} />
    {report?.legacy && !estimate && <div className="settings-budget-legacy" role="note"><strong>{tr("budget.legacy")}</strong><span>{tr("budget.legacyDetail", { amount: minorToDecimal(report.legacy.monthly_minor, "CNY") })}</span></div>}
    {report?.status === "unavailable" && <div className="settings-source-state"><strong>{tr("budget.status")}</strong><span>{tr("budget.unavailable")}</span></div>}
    {availableReport && <>
      <form className="settings-budget-form" onSubmit={save}>
        <label><span>{tr("budget.currency")}</span><select value={currency} onChange={(event) => { const next = event.target.value as EditableCurrency; if (next === currency) return; setCurrency(next); setMonthly(""); setDaily(""); setMessage(tr("budget.currencyChanged")); }} disabled={unsupportedCurrency}>{!isEditableCurrency(currency) && <option value={currency}>{tr("budget.unsupportedOption", { currency })}</option>}<option value="CNY">{tr("budget.cny")}</option><option value="USD">{tr("budget.usd")}</option></select></label>
        <label><span>{tr("budget.monthly")}</span><input inputMode="decimal" value={monthly} onChange={(event) => setMonthly(event.target.value)} placeholder={tr("budget.example")} aria-describedby="settings-budget-help" disabled={unsupportedCurrency} /><small id="settings-budget-help">{tr("budget.positiveTwoDecimals")}</small></label>
        <label><span>{tr("budget.daily")}</span><input inputMode="decimal" value={daily} onChange={(event) => setDaily(event.target.value)} placeholder={tr("budget.dailyPlaceholder")} disabled={unsupportedCurrency} /></label>
        <div className="settings-budget-threshold"><span>{tr("budget.threshold")}</span><strong>{tr("budget.eightyHundred")}</strong><small>{tr("budget.thresholdNote")}</small></div>
        <div className="settings-budget-form-actions"><button className="button button-secondary" type="submit" disabled={saving || disabling || unsupportedCurrency}>{tr(saving ? "budget.saving" : "budget.save")}</button>{estimate && <button className="button button-danger button-small" type="button" onClick={disable} disabled={saving || disabling}>{tr(disabling ? "budget.disabling" : disableArmed ? "budget.confirmDisable" : "budget.disable")}</button>}</div>
      </form>
      {unsupportedCurrency && estimate && <p className="settings-budget-warning" role="note">{tr("budget.unsupported", { currency: estimate.currency })}</p>}
      {estimate && <div className="settings-budget-summary"><div><span>{tr("budget.estimated")}</span><strong>{minorToDecimal(estimate.total_spent_minor, estimate.currency)} / {minorToDecimal(estimate.monthly_minor, estimate.currency)}</strong></div><span className={`status-pill status-pill-${estimate.level === "ok" ? "success" : estimate.level === "warn" ? "warning" : estimate.level === "exceeded" ? "danger" : "neutral"}`}>{budgetStatusLabel(estimate.level, language)}</span>{estimate.has_unresolved && <small className="settings-budget-warning">{tr("budget.unresolved")}</small>}<small className="settings-budget-basis-note">{tr("budget.basisNote")}</small></div>}
      {availableReport.confirmed && <div className="settings-budget-confirmed"><strong>{tr("budget.confirmed")}</strong><span>{minorToDecimal(availableReport.confirmed.total_spent_minor, availableReport.confirmed.currency)} / {minorToDecimal(availableReport.confirmed.monthly_minor, availableReport.confirmed.currency)} · {tr("budget.readOnly")}</span></div>}
      <div className="settings-budget-actions"><div><strong>{tr("budget.systemAlerts")}</strong><span>{tr("budget.systemAlertsNote")}</span></div><button className="button button-secondary button-small" type="button" onClick={toggleSnooze} disabled={snoozing}>{tr(snoozing ? "budget.processing" : snoozed ? "budget.resumeAlerts" : "budget.snoozeAlerts")}</button>{snoozed && <small>{tr("budget.snoozedUntil", { date: budgetDate(availableReport.snoozed_until_ms) })}</small>}</div>
    </>}
    {actionError && <div className="error-banner" role="alert">{actionError}</div>}
    {message && <p className="settings-budget-message" role="status" aria-live="polite">{message}</p>}
  </section>;
}

type QuotaReminderSectionProps = { config: QuotaReminderConfig | null; loading: boolean; error: string | null; onReload: () => void };

function QuotaReminderSection({ config, loading, error, onReload }: QuotaReminderSectionProps) {
  const language = useLanguage();
  const tr = (key: MessageKey, parameters: Record<string, string | number> = {}) => translate(key, language, parameters);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const mounted = useMountedRef();
  const available = config?.status === "ok";

  const toggle = async (event: ChangeEvent<HTMLInputElement>) => {
    if (!available || saving) return;
    const enabled = event.target.checked;
    setSaving(true); setActionError(null); setMessage(null);
    try {
      const receipt = await saveQuotaReminderConfig(enabled);
      if (!mounted.current) return;
      setMessage(tr(receipt.enabled ? receipt.notification_permission === "granted" ? "quota.enabledAlert" : "quota.enabledNoPermission" : "quota.disabledMessage"));
      onReload();
    } catch (reason: unknown) {
      if (mounted.current) setActionError(safeUiError(reason, tr("quota.saveFailed")));
    } finally { if (mounted.current) setSaving(false); }
  };

  const repair = async () => {
    if (saving) return;
    setSaving(true); setActionError(null); setMessage(null);
    try {
      const receipt = await saveQuotaReminderConfig(false);
      if (!mounted.current) return;
      setMessage(tr(receipt.enabled ? "quota.repairStillOn" : "quota.repaired"));
      onReload();
    } catch (reason: unknown) {
      if (mounted.current) setActionError(safeUiError(reason, tr("quota.repairFailed")));
    } finally { if (mounted.current) setSaving(false); }
  };

  return <section className="settings-notification-section" id="settings-notifications" aria-labelledby="settings-notifications-title">
    <div className="settings-section-heading"><div><p className="eyebrow">{tr("quota.eyebrow")}</p><h3 id="settings-notifications-title">{tr("quota.title")}</h3><p>{tr("quota.description")}</p></div><button className="button button-secondary button-small" type="button" onClick={onReload} disabled={loading}>{tr(loading ? "billing.loading" : "quota.reload")}</button></div>
    {error && <div className="error-banner" role="alert">{tr("quota.error", { error })}<button className="button button-secondary button-small" type="button" onClick={onReload}>{tr("billing.retryButton")}</button></div>}
    <SettingsLoadingState loading={loading} hasData={Boolean(config)} title={tr("quota.settings")} detail={tr("quota.localOnly")} />
    {config?.status === "unavailable" && <div className="settings-source-state"><strong>{tr("quota.unavailable")}</strong><span>{tr("quota.unavailableHelp")}</span><button className="button button-secondary button-small" type="button" onClick={repair} disabled={saving}>{tr(saving ? "quota.repairing" : "quota.repair")}</button></div>}
    <div className="settings-notification-card">
      <div><strong>{tr("quota.onExhausted")}</strong><p className="settings-notification-help">{tr(config?.notification_permission === "denied" ? "quota.permissionDenied" : config?.notification_permission === "granted" ? "quota.permissionGranted" : "quota.permissionUnknown")}</p></div>
      <label className="settings-notification-toggle"><input type="checkbox" checked={config?.enabled === true} onChange={toggle} disabled={!available || saving} aria-label={tr("quota.toggleAria")} /><span>{tr(saving ? "billing.saving" : config?.enabled ? "quota.enabled" : "quota.disabled")}</span></label>
    </div>
    {actionError && <div className="error-banner" role="alert">{actionError}</div>}
    {message && <p className="settings-data-message" role="status" aria-live="polite">{message}</p>}
  </section>;
}

function SourceRow({ source, syncing, sourceControlHarness, deleteConfirmHarness, deleteBusyHarness, supportedHarnesses, onSync, onToggleExcluded, onRequestDelete, onCancelDelete, onDelete }: { source: SourceHealthReport["sources"][number]; syncing: boolean; sourceControlHarness: string | null; deleteConfirmHarness: string | null; deleteBusyHarness: string | null; supportedHarnesses: string[]; onSync: () => void; onToggleExcluded: (source: SourceHealthReport["sources"][number]) => void; onRequestDelete: (source: SourceHealthReport["sources"][number]) => void; onCancelDelete: () => void; onDelete: (source: SourceHealthReport["sources"][number]) => void }) {
  const language = useLanguage();
  const tr = (key: MessageKey, parameters: Record<string, string | number> = {}) => message(key, language, parameters);
  const errorText = source.error_kinds.map((kind) => sourceErrorLabel(kind, language)).join(" · ");
  const imported = source.connection_state === "not_detected" && source.sessions === 0 ? tr("source.notImported") : tr("source.imported", { sessions: source.sessions, facts: source.facts });
  const label = sourceLabel(source.harness);
  const actionLabel = syncActionLabel(source.connection_state);
  const controlLabel = supportedHarnesses.includes(source.harness) ? sourceControlLabel(source.connection_state) : null;
  const controlBusy = sourceControlHarness === source.harness;
  const deleteAllowed = supportedHarnesses.includes(source.harness) && (source.facts > 0 || source.sessions > 0);
  const deleteConfirming = deleteConfirmHarness === source.harness;
  const deleteBusy = deleteBusyHarness === source.harness;
  return <article className="settings-source-row" tabIndex={0} aria-label={`${label}, ${sourceStateLabel(source.connection_state, language)}`}>
    <div className="settings-source-main">
      <div className={`settings-source-dot settings-source-dot-${sourceTone(source.connection_state)}`} aria-hidden="true" />
      <div className="settings-source-copy"><strong>{label}</strong><span>{sourceStateLabel(source.connection_state, language)}</span></div>
    </div>
    <div className="settings-source-metrics"><span>{imported}</span><span>{tr("source.latestRecord", { time: observedAt(source.last_event_at_ms) })}</span>{source.failed_sources > 0 && <span className="settings-source-error">{tr("source.readFailed")} · {errorText || tr("source.readFailed")}</span>}</div>
    <div className="settings-source-scan">{tr("source.scannedFiles", { count: source.source_count })}<br /><small>{source.last_scanned_at_ms === null ? tr("source.notScanned") : tr("source.lastScanned", { time: observedAt(source.last_scanned_at_ms) })}</small></div>
    <div className="settings-source-actions">{controlLabel && <button className="button button-secondary button-small settings-source-action" type="button" onClick={() => onToggleExcluded(source)} disabled={controlBusy || deleteBusy || syncing}>{controlBusy ? tr("source.saving") : controlLabel}</button>}{actionLabel && <button className="button button-secondary button-small settings-source-action" type="button" onClick={onSync} disabled={syncing || controlBusy || deleteBusy}>{syncing ? tr("source.syncing") : actionLabel}</button>}{deleteAllowed && !deleteConfirming && <button className="button button-danger button-small settings-source-action" type="button" onClick={() => onRequestDelete(source)} disabled={controlBusy || deleteBusy || syncing}>{tr("source.deleteImported")}</button>}{deleteConfirming && <div className="settings-source-delete-confirm" role="group" aria-label={tr("source.deleteConfirmAria", { harness: label })}><strong>{tr("source.deleteConfirm", { facts: source.facts, sessions: source.sessions })}</strong><span>{tr("source.deleteScope")}</span><div><button className="button button-secondary button-small" type="button" onClick={onCancelDelete} disabled={deleteBusy}>{tr("source.cancel")}</button><button className="button button-danger button-small" type="button" onClick={() => onDelete(source)} disabled={deleteBusy}>{tr(deleteBusy ? "source.deleting" : "source.confirmDelete")}</button></div></div>}</div>
  </article>;
}

type CustomSourceSectionProps = {
  report: CustomSourceReport | null;
  loading: boolean;
  error: string | null;
  onReload: () => void;
  onSync: () => Promise<boolean>;
};

function CustomSourceSection({ report, loading, error, onReload, onSync }: CustomSourceSectionProps) {
  const language = useLanguage();
  const tr = (key: MessageKey, parameters: Record<string, string | number> = {}) => translate(key, language, parameters);
  const [watcherHealth, setWatcherHealth] = useState<WatcherHealthStatus | null>(null);
  useEffect(() => {
    let active = true;
    let cleanup: (() => void) | undefined;
    void fetchWatcherHealth().then((status) => { if (active) setWatcherHealth(status); });
    void listenAppEvents((event) => {
      if (!active || event.type !== "WatcherHealthChanged") return;
      void fetchWatcherHealth().then((status) => { if (active) setWatcherHealth(status); });
    }).then((unsubscribe) => { if (active) cleanup = unsubscribe; else unsubscribe(); });
    return () => { active = false; cleanup?.(); };
  }, []);
  const [harness, setHarness] = useState<"codex" | "claude-code" | "dsh">("codex");
  const [root, setRoot] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const mounted = useMountedRef();

  const chooseRoot = async () => {
    setActionError(null);
    try {
      const selected = await pickCustomSourceRoot();
      if (!mounted.current) return;
      if (selected) {
        setRoot(selected);
        setMessage(tr("sx.folderChosen"));
      }
    } catch (reason: unknown) {
      if (mounted.current) setActionError(safeUiError(reason, "无法打开目录选择"));
    }
  };

  const addRoot = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setActionError(null);
    setMessage(null);
    try {
      const result = await addCustomSourceRoot(harness, root.trim());
      if (!mounted.current) return;
      setMessage(tr(result.changed ? "sx.folderSavedSyncing" : "sx.folderAlreadySyncing"));
      onReload();
      const synced = await onSync();
      if (mounted.current) setMessage(tr(synced ? "sx.folderSyncDone" : "sx.folderSyncPending"));
    } catch (reason: unknown) {
      if (mounted.current) setActionError(safeUiError(reason, "添加读取位置失败"));
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  const removeRoot = async (source: CustomSourceReport["sources"][number]) => {
    if (saving) return;
    setSaving(true);
    setActionError(null);
    setMessage(null);
    try {
      const result = await removeCustomSourceRoot(source.harness, source.root);
      if (!mounted.current) return;
      setMessage(tr(result.changed ? "sx.removed" : "sx.notInScope"));
      onReload();
    } catch (reason: unknown) {
      if (mounted.current) setActionError(safeUiError(reason, "移除读取位置失败"));
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  return <section className="settings-custom-section" aria-labelledby="settings-custom-title">
    <div className="settings-section-heading"><div><p className="eyebrow">{tr("sx.locEyebrow")}</p><h3 id="settings-custom-title">{tr("sx.locTitle")}</h3><p>{tr("sx.locDesc")}</p></div></div>
    <div className="settings-location-row" role="status" aria-live="polite"><strong>{tr("sx.liveWatch")}</strong><span>{watcherStatusLabel(watcherHealth, language)}</span></div>
    {error && <div className="error-banner" role="alert">{tr("sx.locUnavailableErr", { error })}<button className="button button-secondary button-small" type="button" onClick={onReload}>{tr("sx.retry")}</button></div>}
    <SettingsLoadingState loading={loading} hasData={Boolean(report)} title={tr("sx.locConfig")} detail={tr("sx.locNoRead")} />
    {report?.status === "unavailable" && <div className="settings-source-state"><strong>{tr("sx.locUnavailable")}</strong><span>{tr("sx.locUnavailableHelp")}</span></div>}
    {report?.status === "ok" && <>
      <div className="settings-location-list" aria-label={tr("sx.stdLocations")}>
        {Object.entries(report.locations).filter(([, path]) => path).map(([locationHarness, path]) => <div className="settings-location-row" key={locationHarness}><strong>{sourceLabel(locationHarness)}</strong><span>{shortenPath(path as string)}</span><details><summary>{tr("sx.showPath")}</summary><code>{path}</code></details></div>)}
      </div>
      <form className="settings-custom-form" onSubmit={addRoot}>
        <label><span>{tr("sx.tool")}</span><select value={harness} onChange={(event) => setHarness(event.target.value as typeof harness)}><option value="codex">Codex</option><option value="claude-code">Claude Code</option><option value="dsh">DeepSeek Harness</option></select></label>
        <label className="settings-custom-path"><span>{tr("sx.folder")}</span><input value={root} onChange={(event) => setRoot(event.target.value)} placeholder="/Volumes/…/sessions" autoComplete="off" /></label>
        <button className="button button-secondary" type="button" onClick={chooseRoot} disabled={saving}>{tr("sx.chooseFolder")}</button>
        <button className="button button-secondary" type="submit" disabled={saving || !root.trim()}>{saving ? tr("sx.saving") : tr("sx.addSync")}</button>
      </form>
      {report.sources.length > 0 && <div className="settings-custom-list" aria-label={tr("sx.addedLocations")}>{report.sources.map((source) => <div className="settings-custom-row" key={`${source.harness}:${source.root}`}><div><strong>{sourceLabel(source.harness)}</strong><span>{shortenPath(source.root)}</span><details><summary>{tr("sx.showPath")}</summary><code>{source.root}</code></details></div><button className="button button-secondary button-small" type="button" onClick={() => removeRoot(source)} disabled={saving}>{tr("sx.removeLocation")}</button></div>)}</div>}
      {report.sources.length === 0 && <p className="settings-custom-empty">{tr("sx.noneAdded")}</p>}
    </>}
    {actionError && <div className="error-banner" role="alert">{actionError}</div>}
    {message && <p className="settings-custom-message" role="status" aria-live="polite">{message}</p>}
  </section>;
}

/** watcher 健康的用户文案（HARDENING spec §5.6）：不指控、不暴露路径；
 * degraded/unavailable 统一为「定期检查」，periodic fallback 永远在场。 */
function watcherStatusLabel(health: WatcherHealthStatus | null, language: AppLanguage): string {
  if (!health) return message("sx.watchUnknown", language);
  // `throttled` 能与 `mode: "active"` 共存（REVIEW P4 自看护：watcher 后端
  // 本身没坏，只是本机 CPU 持续偏高，同步节流窗被自动拉长）——如实说明，
  // 不能让它落进「实时监听已启用」这句话里悄悄消失。
  const throttledSuffix = health.reasonCode === "throttled" ? message("sx.watchThrottled", language) : "";
  if (health.mode === "active" && health.pendingRoots === 0) return message("sx.watchActive", language) + throttledSuffix;
  if (health.mode === "active" && health.pendingRoots > 0) {
    return message("sx.watchPartial", language, { count: health.pendingRoots }) + throttledSuffix;
  }
  if (health.mode === "disabled") return message("sx.watchOff", language);
  return message("sx.watchDegraded", language);
}

export function SettingsPage({ focusSection = null, onSectionFocused }: { focusSection?: "settings-sources" | "settings-billing" | "settings-budget" | null; onSectionFocused?: () => void }) {
  const language = useLanguage();
  const [report, setReport] = useState<SourceHealthReport | null>(null);
  const [sourceControls, setSourceControls] = useState<SourceHarnessControls | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sourceControlHarness, setSourceControlHarness] = useState<string | null>(null);
  const [sourceControlError, setSourceControlError] = useState<string | null>(null);
  const [sourceControlMessage, setSourceControlMessage] = useState<string | null>(null);
  const [deleteConfirmHarness, setDeleteConfirmHarness] = useState<string | null>(null);
  const [deleteBusyHarness, setDeleteBusyHarness] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteMessage, setDeleteMessage] = useState<string | null>(null);
  const [customReport, setCustomReport] = useState<CustomSourceReport | null>(null);
  const [customError, setCustomError] = useState<string | null>(null);
  const [customLoading, setCustomLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [pauseSaving, setPauseSaving] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [budgetReport, setBudgetReport] = useState<BudgetSettingsReport | null>(null);
  const [budgetError, setBudgetError] = useState<string | null>(null);
  const [budgetLoading, setBudgetLoading] = useState(true);
  const [billingReport, setBillingReport] = useState<BillingSettingsReport | null>(null);
  const [billingError, setBillingError] = useState<string | null>(null);
  const [billingLoading, setBillingLoading] = useState(true);
  const [dataReport, setDataReport] = useState<StatisticsSettingsReport | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);
  const [dataLoading, setDataLoading] = useState(true);
  const [aboutReport, setAboutReport] = useState<AboutDiagnosticsReport | null>(null);
  const [aboutError, setAboutError] = useState<string | null>(null);
  const [aboutLoading, setAboutLoading] = useState(true);
  const [quotaReminder, setQuotaReminder] = useState<QuotaReminderConfig | null>(null);
  const [quotaReminderError, setQuotaReminderError] = useState<string | null>(null);
  const [quotaReminderLoading, setQuotaReminderLoading] = useState(true);
  const [mcpInfo, setMcpInfo] = useState<McpSetupInfo | null>(null);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [mcpCopyState, setMcpCopyState] = useState<string | null>(null);
  const [mcpLoading, setMcpLoading] = useState(true);
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(() => {
    const hashSection = window.location.hash.startsWith("#settings-") ? window.location.hash.slice(1) : "";
    return SETTINGS_SECTION_IDS.includes(hashSection as SettingsSectionId) ? hashSection as SettingsSectionId : "settings-sources";
  });
  const settingsMounted = useRef(true);
  const sourceRequest = useRef(0);
  const sourceControlsRequest = useRef(0);
  const customRequest = useRef(0);
  const budgetRequest = useRef(0);
  const billingRequest = useRef(0);
  const dataRequest = useRef(0);
  const aboutRequest = useRef(0);
  const quotaReminderRequest = useRef(0);

  useEffect(() => {
    if (!focusSection) return;
    setActiveSection(focusSection);
    const frame = window.requestAnimationFrame(() => {
      document.getElementById(focusSection)?.scrollIntoView({ behavior: "smooth", block: "start" });
      onSectionFocused?.();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusSection, onSectionFocused]);

  useEffect(() => {
    const updateActiveSection = () => {
      const hashSection = window.location.hash.startsWith("#settings-") ? window.location.hash.slice(1) : "";
      if (SETTINGS_SECTION_IDS.includes(hashSection as SettingsSectionId)) setActiveSection(hashSection as SettingsSectionId);
    };
    window.addEventListener("hashchange", updateActiveSection);
    return () => window.removeEventListener("hashchange", updateActiveSection);
  }, []);

  const refresh = (background: unknown = false) => {
    const sourceRequestId = ++sourceRequest.current;
    const sourceControlsRequestId = ++sourceControlsRequest.current;
    if (background !== true) setLoading(true);
    setError(null);
    void readSourceHarnessControls().then((next) => {
      if (settingsMounted.current && sourceControlsRequestId === sourceControlsRequest.current) setSourceControls((previous) => stable(previous, next));
    }).catch(() => {
      if (settingsMounted.current && sourceControlsRequestId === sourceControlsRequest.current) setSourceControls(null);
    });
    void readSourceHealth().then((next) => {
      if (settingsMounted.current && sourceRequestId === sourceRequest.current) setReport((previous) => stable(previous, next));
    }).catch((reason: unknown) => {
      if (settingsMounted.current && sourceRequestId === sourceRequest.current) setError(safeUiError(reason, "来源状态读取失败"));
    }).finally(() => {
      if (settingsMounted.current && sourceRequestId === sourceRequest.current) setLoading(false);
    });
  };

  const refreshCustom = (background: unknown = false) => {
    const requestId = ++customRequest.current;
    if (background !== true) setCustomLoading(true);
    setCustomError(null);
    void readCustomSourceConfig().then((next) => {
      if (settingsMounted.current && requestId === customRequest.current) setCustomReport((previous) => stable(previous, next));
    }).catch((reason: unknown) => {
      if (settingsMounted.current && requestId === customRequest.current) setCustomError(safeUiError(reason, "自定义来源配置读取失败"));
    }).finally(() => {
      if (settingsMounted.current && requestId === customRequest.current) setCustomLoading(false);
    });
  };

  const refreshBudget = (background: unknown = false) => {
    const requestId = ++budgetRequest.current;
    if (background !== true) setBudgetLoading(true);
    setBudgetError(null);
    void readBudgetSettings().then((next) => {
      if (settingsMounted.current && requestId === budgetRequest.current) setBudgetReport((previous) => stable(previous, next));
    }).catch((reason: unknown) => {
      if (settingsMounted.current && requestId === budgetRequest.current) setBudgetError(safeUiError(reason, "预算状态读取失败"));
    }).finally(() => {
      if (settingsMounted.current && requestId === budgetRequest.current) setBudgetLoading(false);
    });
  };

  const refreshBilling = (background: unknown = false) => {
    const requestId = ++billingRequest.current;
    if (background !== true) setBillingLoading(true);
    setBillingError(null);
    void readBillingSettings().then((next) => {
      if (settingsMounted.current && requestId === billingRequest.current) setBillingReport((previous) => stable(previous, next));
    }).catch((reason: unknown) => {
      if (settingsMounted.current && requestId === billingRequest.current) setBillingError(safeUiError(reason, "计费状态读取失败"));
    }).finally(() => {
      if (settingsMounted.current && requestId === billingRequest.current) setBillingLoading(false);
    });
  };

  const refreshData = (background: unknown = false) => {
    const requestId = ++dataRequest.current;
    if (background !== true) setDataLoading(true);
    setDataError(null);
    void readStatisticsSettings().then((next) => {
      if (settingsMounted.current && requestId === dataRequest.current) setDataReport((previous) => stable(previous, next));
    }).catch((reason: unknown) => {
      if (settingsMounted.current && requestId === dataRequest.current) setDataError(safeUiError(reason, "统计设置读取失败"));
    }).finally(() => {
      if (settingsMounted.current && requestId === dataRequest.current) setDataLoading(false);
    });
  };

  const refreshAbout = (background: unknown = false) => {
    const requestId = ++aboutRequest.current;
    if (background !== true) setAboutLoading(true);
    setAboutError(null);
    void readAboutDiagnostics().then((next) => {
      if (settingsMounted.current && requestId === aboutRequest.current) setAboutReport((previous) => stable(previous, next));
    }).catch((reason: unknown) => {
      if (settingsMounted.current && requestId === aboutRequest.current) setAboutError(safeUiError(reason, "版本诊断读取失败"));
    }).finally(() => {
      if (settingsMounted.current && requestId === aboutRequest.current) setAboutLoading(false);
    });
  };

  const refreshQuotaReminder = (background: unknown = false) => {
    const requestId = ++quotaReminderRequest.current;
    if (background !== true) setQuotaReminderLoading(true);
    setQuotaReminderError(null);
    void readQuotaReminderConfig().then((next) => {
      if (settingsMounted.current && requestId === quotaReminderRequest.current) setQuotaReminder((previous) => stable(previous, next));
    }).catch((reason: unknown) => {
      if (settingsMounted.current && requestId === quotaReminderRequest.current) setQuotaReminderError(safeUiError(reason, "额度窗口提醒读取失败"));
    }).finally(() => {
      if (settingsMounted.current && requestId === quotaReminderRequest.current) setQuotaReminderLoading(false);
    });
  };

  const runSync = async (): Promise<boolean> => {
    if (syncing) return false;
    setSyncing(true);
    setError(null);
    setSyncMessage(message("sx.syncStarted", language));
    try {
      const requestId = await triggerSync();
      if (!settingsMounted.current) return false;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const status = await readSyncRequestStatus(requestId);
        if (!settingsMounted.current) return false;
        if (status.failed) throw new Error("sync request expired");
        if (status.completed) {
          setSyncMessage(message("sx.syncDone", language));
          refresh();
          return true;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 250));
      }
      setSyncMessage(message("sx.syncBackground", language));
      return false;
    } catch (reason: unknown) {
      if (settingsMounted.current) {
        setSyncMessage(null);
        setError(safeUiError(reason, "同步请求未能完成"));
      }
      return false;
    } finally {
      if (settingsMounted.current) setSyncing(false);
    }
  };

  const togglePause = async () => {
    if (pauseSaving || report?.sync.paused === null || report?.sync.paused === undefined) return;
    setPauseSaving(true);
    setError(null);
    try {
      const paused = await setSyncPaused(!report.sync.paused);
      if (!settingsMounted.current) return;
      setSyncMessage(message(paused ? "sx.autoPausedMsg" : "sx.autoResumedMsg", language));
      refresh();
    } catch (reason: unknown) {
      if (settingsMounted.current) setError(safeUiError(reason, "自动同步设置未保存"));
    } finally {
      if (settingsMounted.current) setPauseSaving(false);
    }
  };

  const toggleSourceExcluded = async (source: SourceHealthReport["sources"][number]) => {
    if (sourceControlHarness) return;
    const excluded = source.connection_state !== "excluded";
    setSourceControlHarness(source.harness);
    setSourceControlError(null);
    setSourceControlMessage(null);
    try {
      const receipt = await setSourceHarnessExcluded(source.harness, excluded);
      if (!settingsMounted.current) return;
      setSourceControlMessage(message(receipt.excluded ? "sx.readStopped" : "sx.readResumed", language, { harness: sourceLabel(source.harness) }));
      refresh();
    } catch (reason: unknown) {
      if (settingsMounted.current) setSourceControlError(safeUiError(reason, "来源读取控制未保存"));
    } finally {
      if (settingsMounted.current) setSourceControlHarness(null);
    }
  };

  const deleteSourceData = async (source: SourceHealthReport["sources"][number]) => {
    if (deleteBusyHarness) return;
    setDeleteBusyHarness(source.harness);
    setDeleteError(null);
    setDeleteMessage(null);
    try {
      const receipt = await deleteImportedSourceData(source.harness);
      if (!settingsMounted.current) return;
      setDeleteMessage(message("sx.deleted", language, { facts: receipt.facts, sessions: receipt.sessions, files: receipt.source_files, trust: receipt.trust_observations, routes: receipt.route_evidence, excerpts: receipt.session_excerpts }));
      setDeleteConfirmHarness(null);
      refresh();
    } catch (reason: unknown) {
      if (settingsMounted.current) setDeleteError(`${message("sx.deleteFailed", language)} ${safeUiError(reason, message("sx.tryLater", language))}`);
    } finally {
      if (settingsMounted.current) setDeleteBusyHarness(null);
    }
  };

  useEffect(() => {
    settingsMounted.current = true;
    void invoke<McpSetupInfo>("mcp_setup_info").then((info) => {
      if (settingsMounted.current) setMcpInfo(info);
    }).catch((reason: unknown) => {
      if (settingsMounted.current) setMcpError(safeUiError(reason, "MCP 信息读取失败"));
    }).finally(() => {
      if (settingsMounted.current) setMcpLoading(false);
    });
    refresh();
    refreshCustom();
    refreshBudget();
    refreshBilling();
    refreshData();
    refreshAbout();
    refreshQuotaReminder();
    let active = true;
    let cleanups: Array<() => void> = [];
    let coalesceTimer: number | null = null;
    const gate = makeInvalidationGate();
    void listenAppEvents((event) => {
      if (!active) return;
      if (event.type === "SourceDataDeleted" && gate(event)) {
        // R1：轮询合成的事件带 revision，已被 Invalidated 覆盖的同 revision 重复
        // 被 gate 吞掉；真删除（无 revision）仍无条件放行。
        refresh(true); refreshData(true); refreshQuotaReminder(true);
      } else if (event.type === "SyncStatusChanged") {
        // 同步失败/恢复只体现在数据源健康（sync_runs 是记账写，不推进 revision）。
        refresh(true);
      } else if (gate(event)) {
        // 权威 revision 前进：预算/计费/数据面/关于页一起重拉——每 tick 至多一次，
        // 且同 revision 的重复事件被闸门吞掉（RUNTIME_INVALIDATION spec §6）。
        // 再加 1.2s 合并：Agent 活跃时同步一轮接一轮，逐条重读七个区块会让页面持续抖动。
        if (coalesceTimer !== null) window.clearTimeout(coalesceTimer);
        coalesceTimer = window.setTimeout(() => {
          coalesceTimer = null;
          if (!active) return;
          refresh(true); refreshCustom(true); refreshBudget(true); refreshBilling(true); refreshData(true); refreshAbout(true); refreshQuotaReminder(true);
        }, 1200);
      }
    }).then((unsubscribe) => {
      if (active) cleanups = [unsubscribe];
      else unsubscribe();
    });
    return () => { active = false; settingsMounted.current = false; if (coalesceTimer !== null) window.clearTimeout(coalesceTimer); cleanups.forEach((unsubscribe) => unsubscribe()); };
  }, []);

  const attentionCount = useMemo(() => report?.sources.filter((source) => source.connection_state === "needs_attention").length ?? 0, [report]);
  const reloadAll = () => { refresh(); refreshCustom(); refreshBudget(); refreshBilling(); refreshData(); refreshAbout(); refreshQuotaReminder(); };
  const sections: ReadonlyArray<readonly [SettingsSectionId, string]> = [["settings-sources", message("sx.navSources", language)], ["settings-billing", message("sx.navBilling", language)], ["settings-budget", message("sx.navBudget", language)], ["settings-notifications", message("sx.navAlerts", language)], ["settings-data", message("sx.navData", language)], ["settings-about", message("sx.navAbout", language)], ["settings-mcp", message("sx.navMcp", language)]];
  const selectSettingsSection = (id: SettingsSectionId) => {
    setActiveSection(id);
    window.history.replaceState(null, "", `#${id}`);
    document.querySelector<HTMLElement>(".main-content")?.scrollTo({ top: 0, left: 0, behavior: "instant" });
  };

  return <>
    <h2 id="settings-title" className="visually-hidden">{message("sx.pageTitle", language)}</h2>
    <section className="settings-data-card" aria-labelledby="settings-language-title">
      <div className="settings-card-heading"><div><p className="eyebrow">{message("language.title", language)}</p><h3 id="settings-language-title">{message("language.title", language)}</h3></div></div>
      <p className="settings-data-help">{message("language.description", language)}</p>
      <label><span>{message("language.title", language)}</span><select value={languagePreference()} onChange={(event) => { void setLanguagePreference(event.target.value as LanguagePreference).catch(() => setError(message("language.saveFailed", language))); }}>
        <option value="system">{message("language.system", language)}</option>
        <option value="en">{message("language.english", language)}</option>
        <option value="zh-Hans">{message("language.chinese", language)}</option>
      </select></label>
    </section>
    <ToolbarActions>
      <button className="button button-secondary" type="button" onClick={reloadAll} disabled={loading || customLoading || budgetLoading || billingLoading || dataLoading || aboutLoading || quotaReminderLoading}>{message("sx.reloadAll", language)}</button>
    </ToolbarActions>

    <nav className="settings-section-nav" role="tablist" aria-label={message("sx.sectionsAria", language)}>{sections.map(([id, label], index) => <button key={id} id={`settings-tab-${id}`} className={activeSection === id ? "settings-section-nav-active" : undefined} type="button" role="tab" aria-selected={activeSection === id} aria-controls={`settings-panel-${id}`} tabIndex={activeSection === id ? 0 : -1} onClick={() => selectSettingsSection(id)} onKeyDown={(event) => {
      const nextIndex = event.key === "ArrowRight" ? (index + 1) % sections.length : event.key === "ArrowLeft" ? (index + sections.length - 1) % sections.length : event.key === "Home" ? 0 : event.key === "End" ? sections.length - 1 : -1;
      if (nextIndex < 0) return;
      event.preventDefault();
      const nextId = sections[nextIndex][0];
      selectSettingsSection(nextId);
      document.getElementById(`settings-tab-${nextId}`)?.focus();
    }}>{label}</button>)}</nav>

    {activeSection === "settings-sources" && <div className="settings-tab-panel" id="settings-panel-settings-sources" role="tabpanel" aria-labelledby="settings-tab-settings-sources">
    <section className="settings-section" id="settings-sources" aria-labelledby="settings-sources-title">
      <div className="settings-section-heading"><div><p className="eyebrow">{message("sx.navSources", language)}</p><h3 id="settings-sources-title">{message("sx.srcTitle", language)}</h3><p>{message("sx.srcDesc", language)}</p></div>{report && <span className={`status-pill status-pill-${attentionCount ? "warning" : "success"}`}>{attentionCount ? message("sx.srcAttention", language, { count: attentionCount }) : message("sx.srcOk", language)}</span>}</div>
      {error && <div className="error-banner" role="alert">{message("sx.srcUnavailableErr", language, { error })}<button className="button button-secondary button-small" type="button" onClick={refresh}>{message("sx.retry", language)}</button></div>}
      <SettingsLoadingState loading={loading} hasData={Boolean(report)} title={message("sx.srcStatusName", language)} detail={message("sx.srcQueryOnly", language)} />
      {report?.status === "unavailable" && <div className="settings-source-state"><strong>{message("sx.srcUnavailable", language)}</strong><span>{message("sx.srcUnavailableHelp", language)}</span></div>}
      {report?.status === "ok" && <div className="settings-source-list">{report.sources.length ? report.sources.map((source) => <SourceRow key={source.harness} source={source} syncing={syncing} sourceControlHarness={sourceControlHarness} deleteConfirmHarness={deleteConfirmHarness} deleteBusyHarness={deleteBusyHarness} supportedHarnesses={sourceControls?.supported_harnesses ?? []} onSync={runSync} onToggleExcluded={toggleSourceExcluded} onRequestDelete={(item) => { setDeleteError(null); setDeleteMessage(null); setDeleteConfirmHarness(item.harness); }} onCancelDelete={() => setDeleteConfirmHarness(null)} onDelete={deleteSourceData} />) : <div className="settings-source-state"><strong>{message("sx.noSources", language)}</strong><span>{message("sx.noSourcesHelp", language)}</span></div>}</div>}
      {sourceControlError && <div className="error-banner" role="alert">{message("sx.ctrlUnsaved", language, { error: sourceControlError })}</div>}
      {sourceControlMessage && <p className="settings-sync-message" role="status" aria-live="polite">{sourceControlMessage}</p>}
      {deleteError && <div className="error-banner" role="alert">{deleteError}</div>}
      {deleteMessage && <p className="settings-sync-message" role="status" aria-live="polite">{deleteMessage}</p>}
      {report && <div className="settings-sync-summary"><span>{message("sx.lastSync", language, { value: syncLabel(report, language) })}</span><span>{message(report.sync.paused === true ? "sx.autoPaused" : report.sync.paused === false ? "sx.autoOn" : "sx.autoUnknown", language)}</span>{report.sync.paused !== null && <button className="button button-secondary button-small" type="button" onClick={togglePause} disabled={pauseSaving}>{pauseSaving ? message("sx.saving", language) : message(report.sync.paused ? "sx.autoResume" : "sx.autoPause", language)}</button>} {syncMessage && <small role="status">{syncMessage}</small>}<small>{message("sx.stopNote", language)}</small></div>}
    </section>

    <CustomSourceSection report={customReport} loading={customLoading} error={customError} onReload={refreshCustom} onSync={runSync} />
    </div>}

    {activeSection === "settings-billing" && <div className="settings-tab-panel" id="settings-panel-settings-billing" role="tabpanel" aria-labelledby="settings-tab-settings-billing"><BillingSection report={billingReport} loading={billingLoading} error={billingError} onReload={refreshBilling} /></div>}

    {activeSection === "settings-budget" && <div className="settings-tab-panel" id="settings-panel-settings-budget" role="tabpanel" aria-labelledby="settings-tab-settings-budget"><BudgetSection report={budgetReport} loading={budgetLoading} error={budgetError} onReload={refreshBudget} /></div>}

    {activeSection === "settings-notifications" && <div className="settings-tab-panel" id="settings-panel-settings-notifications" role="tabpanel" aria-labelledby="settings-tab-settings-notifications"><QuotaReminderSection config={quotaReminder} loading={quotaReminderLoading} error={quotaReminderError} onReload={refreshQuotaReminder} /></div>}

    {activeSection === "settings-data" && <div className="settings-tab-panel" id="settings-panel-settings-data" role="tabpanel" aria-labelledby="settings-tab-settings-data">
    <FxSection />

    <QuoteVariantsSection />

    <PriceCardSection />

    <StatisticsDataSection report={dataReport} loading={dataLoading} error={dataError} onReload={refreshData} />
    </div>}

    {activeSection === "settings-about" && <div className="settings-tab-panel" id="settings-panel-settings-about" role="tabpanel" aria-labelledby="settings-tab-settings-about"><AboutSection report={aboutReport} loading={aboutLoading} error={aboutError} onReload={refreshAbout} /></div>}

    {activeSection === "settings-mcp" && <div className="settings-tab-panel" id="settings-panel-settings-mcp" role="tabpanel" aria-labelledby="settings-tab-settings-mcp"><section className="settings-section" id="settings-mcp" aria-labelledby="settings-mcp-title">
      <div className="settings-section-heading"><div><p className="eyebrow">{message("sx.navMcp", language)}</p><h3 id="settings-mcp-title">{message("sx.mcpTitle", language)}</h3><p>{message("sx.mcpDescription", language)}</p></div></div>
      {mcpLoading && <p className="settings-data-help" role="status">{message("sx.mcpLoading", language)}</p>}
      {mcpError && <div className="error-banner" role="alert">{message("sx.mcpUnavailable", language, { error: mcpError })}</div>}
      {mcpInfo && <>
        <div className="settings-data-card">
          <p className="settings-data-help">{mcpInfo.cli_path ? message("sx.mcpCliFound", language, { path: mcpInfo.cli_path, version: mcpInfo.cli_version ? ` (${mcpInfo.cli_version})` : "" }) : message("sx.mcpCliMissing", language)}</p>
          <p className="settings-data-help">{message("sx.mcpDataHome", language, { path: mcpInfo.data_home })}</p>
          {mcpInfo.cli_path && <>
            {([["codex", message("sx.mcpCodexLabel", language), mcpCodexConfig(mcpInfo.cli_path)], ["claude", message("sx.mcpClaudeLabel", language), mcpClaudeCommand(mcpInfo.cli_path)], ["json", message("sx.mcpJsonLabel", language), mcpJsonConfig(mcpInfo.cli_path)]] as const).map(([client, label, config]) => <label key={client}><span>{label}</span><textarea className="settings-mcp-config" readOnly value={config} rows={client === "json" ? 5 : 3} /><button className="button button-secondary button-small" type="button" onClick={() => { void copyToClipboard(config).then((ok) => setMcpCopyState(ok ? client : `${client}-failed`)); }}>{mcpCopyState === client ? message("sx.mcpCopied", language) : message("sx.mcpCopy", language)}</button>{mcpCopyState === `${client}-failed` && <span role="alert">{message("sx.mcpCopyFailed", language)}</span>}</label>)}
          </>}
          <p className="settings-data-help">{message("sx.mcpCopyAllHelp", language)}</p>
        </div>
        <div className="settings-data-card"><strong>{message("sx.mcpTools", language)}</strong>{mcpInfo.tools.length ? <ul>{mcpInfo.tools.map((tool) => <li key={tool.name}><code>{tool.name}</code> — {tool.description.split(". ")[0]}</li>)}</ul> : <p className="settings-data-help">{message("sx.mcpNoTools", language)}</p>}</div>
        <p className="settings-data-help">{message("sx.mcpWriteNote", language)}</p>
      </>}
    </section>
    </div>}

    <section className="settings-placeholder" aria-label={message("sx.legacyAria", language)}><strong>{message("sx.legacyTitle", language)}</strong><span>{message("sx.legacyBody", language)}</span></section>
  </>;
}
