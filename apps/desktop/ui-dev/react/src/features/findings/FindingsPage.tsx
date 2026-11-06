import { harnessName } from "../../lib/harnessNames";
import { stable, isBackground } from "../../lib/stable";
import { useEffect, useMemo, useRef, useState } from "react";
import { createTrustSuppression, listenAppEvents, makeInvalidationGate, readDecisionMatrix, readFindings, readFindingsFreshness, safeUiError, type DecisionMatrixReport, type FindingGroup, type FindingSample, type FindingsFreshness, type FindingsReport } from "../../lib/tauri";
import { DecisionMatrixSection } from "./DecisionMatrixSection";
import { mergeFindingsPage } from "./contract";
import { ToolbarActions } from "../../components/ui/ToolbarActions";
import { message, resolvedLanguage, useLanguage, type MessageKey } from "../../lib/i18n";

const tx = (key: MessageKey, params: Record<string, string | number> = {}): string => message(key, resolvedLanguage(), params);
const isEn = (): boolean => resolvedLanguage() === "en";
const listSep = (): string => (isEn() ? ", " : "、");

type SeverityFilter = "all" | "critical" | "warning" | "info";

function timeLabel(value: number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return tx("fd.timeNA");
  return new Intl.DateTimeFormat(isEn() ? "en-US" : "zh-CN", { dateStyle: "short", timeStyle: "short" }).format(date);
}

function severityLabel(value: string): string {
  if (value === "critical") return tx("fd.critical");
  if (value === "warning") return tx("fd.warning");
  if (value === "info") return tx("fd.info");
  return value;
}

function severityClass(value: string): string {
  if (value === "critical") return "finding-severity finding-severity-critical";
  if (value === "warning") return "finding-severity finding-severity-warning";
  return "finding-severity";
}

function isTodo(group: FindingGroup): boolean {
  return group.manual_follow_up && !group.read_only && ["billing", "budget", "source"].includes(group.action_kind);
}

function remedyLabel(group: FindingGroup): string {
  if (group.read_only || !group.manual_follow_up) return tx("fd.readOnlyNoAction");
  if (group.action_kind === "billing") return tx("fd.reviewBilling");
  if (group.action_kind === "budget") return tx("fd.reviewBudget");
  if (group.action_kind === "source") return tx("fd.reviewSource");
  return tx("fd.reviewManual");
}

function evidenceLevelLabel(value: FindingSample["evidence_level"]): string {
  return value === "E0" ? tx("tr.e0") : value === "E1" ? tx("tr.e1") : value === "E2" ? tx("tr.e2") : value === "E3" ? tx("tr.e3") : value === "E4" ? tx("tr.e4") : value === "E5" ? tx("tr.e5") : tx("fd.unknown");
}

function evidenceStageLabel(value: FindingSample["stage"]): string {
  return value === "read_observed" ? tx("tr.sRead") : value === "package_observed" ? tx("tr.sPack") : value === "credential_observed" ? tx("tr.sCred") : value === "egress_attempted" ? tx("tr.sAttempt") : value === "egress_transmitted" ? tx("tr.sTransmit") : value === "remote_accepted" ? tx("tr.sAccepted") : tx("fd.unknown");
}

function evidenceOriginLabel(value: FindingSample["evidence_origin"]): string {
  return value === "local_artifact" ? tx("tr.oLocal") : value === "client_state_claim" ? tx("tr.oClient") : value === "runtime_process_metadata" ? tx("tr.oRuntime") : value === "network_metadata" ? tx("tr.oNet") : value === "verified_receipt" ? tx("tr.oReceipt") : value === "unknown_legacy" ? tx("tr.oLegacy") : tx("fd.unknown");
}

function destinationLabel(value: FindingSample["destination_class"]): string {
  return value === "vendor_api" ? tx("tr.dVendor") : value === "object_storage" ? tx("tr.dStorage") : value === "telemetry" ? tx("tr.dTelemetry") : value === "eval" ? tx("tr.dEval") : value === "model_api" ? tx("tr.dModel") : value === "unknown" ? tx("tr.dUnk") : tx("tr.undeclared");
}

function confidenceLabel(value: FindingSample["confidence"]): string {
  return value === "high" ? tx("fd.confHigh") : value === "medium" ? tx("fd.confMed") : value === "low" ? tx("fd.confLow") : tx("fd.unknown");
}

function sampleTimeLabel(first: number | null, last: number | null): string {
  if (first == null) return tx("fd.obsTimeNA");
  const start = timeLabel(first);
  return last != null && last !== first ? `${start} ${tx("fd.to")} ${timeLabel(last)}` : start;
}

function sampleBytes(value: number | null): string {
  if (value == null) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function FindingEvidenceDetail({ sample, index }: { sample: FindingSample; index: number }) {
  return <article className="finding-evidence-detail" aria-label={tx("fd.redactedEv", { n: index + 1 })}>
    <div className="finding-evidence-detail-header"><strong>{tx("fd.redactedEv", { n: index + 1 })}</strong><span className={`status-pill ${sample.has_evidence ? "status-pill-success" : "status-pill-warning"}`}><span aria-hidden="true" className="status-dot" />{sample.has_evidence ? tx("tr.cAvail") : tx("fd.fieldNA")}</span></div>
    <div className="finding-evidence-grid">
      <div><span>{tx("fd.fObsTime")}</span><strong>{sampleTimeLabel(sample.observed_first_at_ms, sample.observed_last_at_ms)}</strong></div>
      <div><span>{tx("fd.fLevel")}</span><strong>{sample.evidence_level ? `${sample.evidence_level} · ${evidenceLevelLabel(sample.evidence_level)}` : tx("fd.unknown")}</strong></div>
      <div><span>{tx("fd.fStage")}</span><strong>{evidenceStageLabel(sample.stage)}</strong></div>
      <div><span>{tx("fd.fOrigin")}</span><strong>{evidenceOriginLabel(sample.evidence_origin)}</strong></div>
      <div><span>{tx("fd.fScope")}</span><strong>{sample.scope_classes.length ? sample.scope_classes.join(listSep()) : tx("tr.undeclared")}</strong></div>
      <div><span>{tx("fd.fDest")}</span><strong>{destinationLabel(sample.destination_class)}</strong></div>
      <div><span>{tx("fd.fCount")}</span><strong>{sample.observation_count ?? "—"}</strong></div>
      <div><span>{tx("fd.fFileSize")}</span><strong>{sample.file_count ?? "—"} / {sampleBytes(sample.byte_count)}</strong></div>
      <div><span>{tx("fd.fConf")}</span><strong>{confidenceLabel(sample.confidence)}</strong></div>
      <div><span>{tx("fd.fRef")}</span><code>{sample.reference ?? tx("tr.unavailable")}</code></div>
    </div>
    <p>{tx("fd.detailNote")}</p>
  </article>;
}

function freshnessLabel(freshness: FindingsFreshness): string {
  if (freshness.status !== "ok") return tx("fd.freshNA");
  if (freshness.state === "not_yet_synced") return tx("fd.freshNever");
  if (freshness.state === "unknown") return tx("fd.freshUnknown");
  const parts = [];
  if (freshness.syncing) parts.push(tx("fd.syncing"));
  if (freshness.last_successful_sync_at) parts.push(tx("fd.asOf", { at: freshness.last_successful_sync_at }));
  if (freshness.stale_harnesses.length) parts.push(tx("fd.stale", { harnesses: freshness.stale_harnesses.join(listSep()) }));
  return parts.length ? tx("fd.freshParts", { parts: parts.join(" · ") }) : tx("fd.freshOk");
}

function StatusSummary({ group }: { group: FindingGroup }) {
  const status = group.status_rollup;
  return <div className="finding-status-summary" aria-label={tx("fd.statusAria")}>
    <span>{tx("fd.open")} {status.open}</span><span>{tx("fd.later")} {status.later}</span><span>{tx("fd.acked")} {status.acknowledged}</span>
  </div>;
}

function FindingRow({ group, onNavigateToAction }: { group: FindingGroup; onNavigateToAction?: (actionKind: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [suppressionBusy, setSuppressionBusy] = useState(false);
  const [suppressionMessage, setSuppressionMessage] = useState<string | null>(null);
  const canExpand = group.sample_evidence.length > 0;
  const canSuppressNotifications = /^SV70[1-9]$|^SV710$/.test(group.rule);
  const suppressNotifications = async () => {
    if (!window.confirm(tx("fd.suppressConfirm", { rule: group.rule }))) return;
    setSuppressionBusy(true);
    setSuppressionMessage(null);
    try {
      await createTrustSuppression(group.rule);
      setSuppressionMessage(tx("fd.suppressed"));
    } catch (reason: unknown) {
      setSuppressionMessage(safeUiError(reason, tx("fd.suppressFailed")));
    } finally {
      setSuppressionBusy(false);
    }
  };
  return <article className="finding-row">
    <div className="finding-row-main">
      <div className="finding-row-title"><strong>{group.rule}</strong><span className={severityClass(group.severity)}>{severityLabel(group.severity)}</span></div>
      <p className="finding-row-subtitle">{harnessName(group.harness)} · {group.evidence_class}</p>
      <p className="finding-row-copy">{tx("fd.hitsLine", { n: group.count, sessions: group.sessions_count, from: timeLabel(group.first_seen_at_ms), to: timeLabel(group.last_seen_at_ms) })}</p>
      <p className="finding-row-copy">{remedyLabel(group)} · {group.sample_evidence.length ? tx("fd.haveSummaries", { n: group.sample_evidence.length }) : tx("fd.refNA")}</p>
      {group.manual_follow_up && !group.read_only && onNavigateToAction && <button className="button button-secondary button-small finding-evidence-toggle" type="button" onClick={() => onNavigateToAction(group.action_kind)}>{tx("fd.openSettings")}</button>}
      {canExpand && <button className="button button-secondary button-small finding-evidence-toggle" type="button" aria-expanded={expanded} aria-controls={`finding-evidence-${group.group_id.replace(/[^a-z0-9-]/gi, "-")}`} onClick={() => setExpanded((value) => !value)}>{expanded ? tx("fd.hideEvidence") : tx("fd.showEvidence")}</button>}
      {canSuppressNotifications && <button className="button button-secondary button-small finding-evidence-toggle" type="button" onClick={() => void suppressNotifications()} disabled={suppressionBusy}>{suppressionBusy ? tx("fd.savingSuppress") : tx("fd.ignoreRule")}</button>}
      {suppressionMessage && <p className="finding-suppression-feedback" role="status">{suppressionMessage}</p>}
      {expanded && <div className="finding-evidence-details" id={`finding-evidence-${group.group_id.replace(/[^a-z0-9-]/gi, "-")}`}>{group.sample_evidence.map((sample, index) => <FindingEvidenceDetail key={sample.reference ?? index} sample={sample} index={index} />)}</div>}
    </div>
    <div className="finding-row-side"><StatusSummary group={group} />
      {group.manual_follow_up && !group.read_only ? <span className="status-pill status-pill-warning"><span aria-hidden="true" className="status-dot" />{tx("fd.needsSettings")}</span> : <span className="status-pill"><span aria-hidden="true" className="status-dot" />{tx("fd.readOnlyPill")}</span>}
    </div>
  </article>;
}

export function FindingsPage({ onNavigateToAction }: { onNavigateToAction?: (actionKind: string) => void }) {
  useLanguage();
  const [report, setReport] = useState<FindingsReport | null>(null);
  const [freshness, setFreshness] = useState<FindingsFreshness>({ status: "unavailable", state: "unknown", last_successful_sync_at: null, stale_harnesses: [], syncing: false });
  const [matrix, setMatrix] = useState<DecisionMatrixReport | null>(null);
  const [matrixLoading, setMatrixLoading] = useState(true);
  const [matrixError, setMatrixError] = useState<string | null>(null);
  const [loading, setLoading] = useState(tx("fd.loading"));
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [severity, setSeverity] = useState<SeverityFilter>("all");
  const [rule, setRule] = useState("all");
  const requestGeneration = useRef(0);
  const matrixGeneration = useRef(0);
  const eventRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 后台刷新（失效事件）不翻转 loading / matrixLoading（它们会让「正在读取」提示块出现又消失），
  // 数据内容没变就沿用旧引用，React 跳过渲染。手动重新读取照旧显示读取状态。
  const load = (background: unknown = false) => {
    const quiet = isBackground(background);
    const requestId = ++requestGeneration.current;
    const matrixRequestId = ++matrixGeneration.current;
    if (!quiet) setLoading(tx("fd.loadingProj"));
    setLoadingMore(false);
    setError(null);
    void Promise.allSettled([readFindings(), readFindingsFreshness()])
      .then(([reportResult, freshnessResult]) => {
        if (requestId !== requestGeneration.current) return;
        const errors: string[] = [];
        if (reportResult.status === "fulfilled") setReport((previous) => stable(previous, reportResult.value));
        else errors.push(safeUiError(reportResult.reason, tx("fd.unavail")));
        if (freshnessResult.status === "fulfilled") setFreshness((previous) => stable(previous, freshnessResult.value));
        else errors.push(safeUiError(freshnessResult.reason, tx("fd.freshUnavail")));
        setError(errors.length ? errors.join("；") : null);
        setLoading("");
      });
    if (!quiet) setMatrixLoading(true);
    setMatrixError(null);
    void readDecisionMatrix()
      .then((nextMatrix) => { if (matrixRequestId === matrixGeneration.current) { setMatrix((previous) => stable(previous, nextMatrix)); setMatrixLoading(false); } })
      .catch((reason: unknown) => { if (matrixRequestId === matrixGeneration.current) { setMatrixError(safeUiError(reason, tx("fd.matrixUnavail"))); setMatrixLoading(false); } });
  };

  const loadMore = () => {
    const cursor = report?.next_cursor;
    if (!cursor || loadingMore || Boolean(loading)) return;
    const requestId = ++requestGeneration.current;
    setLoadingMore(true);
    setError(null);
    void readFindings(cursor)
      .then((nextReport) => {
        if (requestId !== requestGeneration.current) return;
        setReport((current) => mergeFindingsPage(current, nextReport));
        setLoadingMore(false);
      })
      .catch((reason: unknown) => {
        if (requestId !== requestGeneration.current) return;
        setError(`${safeUiError(reason, tx("fd.moreUnavail"))} · ${tx("fd.keepRead")}`);
        setLoadingMore(false);
      });
  };

  useEffect(() => { load(); }, []);

  useEffect(() => {
    let active = true;
    let cleanups: Array<() => void> = [];
    const queueRefresh = () => {
      if (!active || eventRefreshTimer.current !== null) return;
      eventRefreshTimer.current = setTimeout(() => {
        eventRefreshTimer.current = null;
        if (active) load(true);
      }, 150);
    };
    const gate = makeInvalidationGate();
    // Findings 读 issue 表：数据失效（含 TrustMonitorEvent 之后的 revision 前进）才重拉；
    // 150ms 合并窗保留，兜同一 tick 内 Invalidated + SourceDataDeleted 相邻到达。
    void listenAppEvents((event) => { if (gate(event)) queueRefresh(); })
      .then((unsubscribe) => { if (active) cleanups = [unsubscribe]; else unsubscribe(); });
    return () => {
      active = false;
      requestGeneration.current += 1;
      matrixGeneration.current += 1;
      if (eventRefreshTimer.current !== null) clearTimeout(eventRefreshTimer.current);
      eventRefreshTimer.current = null;
      cleanups.forEach((unsubscribe) => unsubscribe());
    };
  }, []);

  const groups = report?.issues ?? [];
  const todoGroups = useMemo(() => groups.filter(isTodo), [groups]);
  const visibleGroups = useMemo(() => groups.filter((group) => (severity === "all" || group.severity === severity) && (rule === "all" || group.rule === rule)), [groups, rule, severity]);

  return <section className="findings-page" aria-labelledby="findings-page-title">
    <h2 id="findings-page-title" className="visually-hidden">{tx("fd.pageTitle")}</h2>
    <ToolbarActions><button className="button button-secondary" type="button" onClick={load} disabled={Boolean(loading)}>{tx("fd.reload")}</button></ToolbarActions>
    <div className="freshness-bar" role="status">{freshnessLabel(freshness)}</div>
    {loading && <p className="inline-status" role="status">{loading}</p>}
    {error && <div className="error-banner" role="alert">{error} · {tx("fd.keepLast")}</div>}
    {report && <div className="finding-stats" aria-label={tx("fd.summaryAria")}><article><span className="eyebrow">{tx("fd.groups")}</span><strong>{report.totals.issues}</strong><small>{tx("fd.affected", { n: report.totals.sessions })}</small></article><article><span className="eyebrow">{tx("fd.critical")}</span><strong>{report.totals.critical}</strong><small>{tx("fd.lookFirst")}</small></article><article><span className="eyebrow">{tx("fd.toWatch")}</span><strong>{report.totals.warning}</strong><small>{tx("fd.actionable")}</small></article><article><span className="eyebrow">{tx("fd.rules")}</span><strong>{report.rules.length}</strong><small>{tx("fd.detRules")}</small></article></div>}
    <section className="finding-section" aria-labelledby="todo-title"><div className="section-heading"><div><p className="eyebrow">{tx("fd.actionSurface")}</p><h3 id="todo-title">{tx("fd.todos")}</h3></div><span className="count-badge">{todoGroups.length}</span></div>{todoGroups.length ? <div className="finding-list">{todoGroups.map((group) => <FindingRow key={group.group_id} group={group} onNavigateToAction={onNavigateToAction} />)}</div> : <div className="finding-empty"><strong>{tx("fd.noTodos")}</strong><p>{tx("fd.noTodosNote")}</p></div>}</section>
    <DecisionMatrixSection report={matrix} loading={matrixLoading} error={matrixError} />
    <section className="finding-section" aria-labelledby="evidence-title"><div className="section-heading"><div><p className="eyebrow">{tx("fd.verifySurface")}</p><h3 id="evidence-title">{tx("fd.evidenceDetails")}</h3></div><div className="finding-filters"><label>{tx("fd.level")}<select value={severity} onChange={(event) => setSeverity(event.target.value as SeverityFilter)}><option value="all">{tx("fd.all")}</option><option value="critical">{tx("fd.critical")}</option><option value="warning">{tx("fd.warning")}</option><option value="info">{tx("fd.info")}</option></select></label><label>{tx("fd.rules")}<select value={rule} onChange={(event) => setRule(event.target.value)}><option value="all">{tx("fd.allRules")}</option>{(report?.rules ?? []).map((item) => <option key={item.rule} value={item.rule}>{item.rule}</option>)}</select></label></div></div>{visibleGroups.length ? <div className="finding-list">{visibleGroups.map((group) => <FindingRow key={group.group_id} group={group} onNavigateToAction={onNavigateToAction} />)}</div> : <div className="finding-empty"><strong>{report ? tx("fd.noMatch") : tx("fd.preparing")}</strong><p>{report ? tx("fd.noMatchHelp") : tx("fd.redactedOnly")}</p></div>}{report?.next_cursor && <div className="finding-pagination"><button className="button button-secondary" type="button" onClick={loadMore} disabled={loadingMore || Boolean(loading)}>{loadingMore ? tx("fd.loadingMore") : tx("fd.loadMore")}</button><span>{loadingMore ? tx("fd.keepCurrent") : tx("fd.paged")}</span></div>}</section>
  </section>;
}
