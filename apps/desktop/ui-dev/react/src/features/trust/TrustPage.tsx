import { harnessName } from "../../lib/harnessNames";
import { stable } from "../../lib/stable";
import { useEffect, useRef, useState } from "react";
import { ToolbarActions } from "../../components/ui/ToolbarActions";
import { message, resolvedLanguage, useLanguage, type MessageKey } from "../../lib/i18n";
import {
  auditTrust,
  approveTrustProfile,
  rejectTrustProfile,
  discoverTrust,
  listenAppEvents,
  readTrustProfileStatus,
  readTrustSuppressions,
  readTrustEvidence,
  readTrustMonitorConfig,
  revokeTrustProfile,
  revokeTrustSuppression,
  runTrustRuntimeSnapshot,
  dismissTrustMonitorPrompt, saveTrustMonitorConfig,
  safeUiError,
  type TrustAuditReport,
  type TrustEvidence,
  type TrustHarnessCandidate,
  type TrustMonitorConfig,
  type TrustRuntimeSnapshot,
  type TrustProfileSummary,
  type TrustProfileStatus,
  type TrustSuppression,
} from "../../lib/tauri";

function bytes(value: number | null): string {
  if (value == null) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

// 文案在调用时按应用语言解析；TrustPage 用 useLanguage() 订阅切换。
const tx = (key: MessageKey, params: Record<string, string | number> = {}): string => message(key, resolvedLanguage(), params);
const isEn = (): boolean => resolvedLanguage() === "en";
const listSep = (): string => (isEn() ? ", " : "、");
const appLocale = (): string => (isEn() ? "en-US" : "zh-CN");

function localTime(value: number): string {
  return new Intl.DateTimeFormat(appLocale(), { dateStyle: "short", timeStyle: "medium" }).format(new Date(value));
}

function levelTone(level: string): string {
  return level === "E3" || level === "E4" ? "status-pill-warning" : "";
}

function evidenceLevelLabel(level: string): string {
  return ({ E0: tx("tr.e0"), E1: tx("tr.e1"), E2: tx("tr.e2"), E3: tx("tr.e3"), E4: tx("tr.e4"), E5: tx("tr.e5") } as Record<string, string>)[level] ?? tx("tr.eUnk");
}

function evidenceStageLabel(stage: string): string {
  return ({ read_observed: tx("tr.sRead"), package_observed: tx("tr.sPack"), credential_observed: tx("tr.sCred"), egress_attempted: tx("tr.sAttempt"), egress_transmitted: tx("tr.sTransmit"), remote_accepted: tx("tr.sAccepted") } as Record<string, string>)[stage] ?? tx("tr.sUnk");
}

function evidenceKindLabel(kind: string): string {
  return ({ file_scope: tx("tr.kFile"), package: tx("tr.kPkg"), credential: tx("tr.kCred"), connection: tx("tr.kConn"), outbound_bytes: tx("tr.kBytes"), remote_ack: tx("tr.kAck"), consent_state: tx("tr.kConsent"), retry: tx("tr.kRetry") } as Record<string, string>)[kind] ?? tx("tr.kUnk");
}

function evidenceOriginLabel(origin: string): string {
  return ({ local_artifact: tx("tr.oLocal"), client_state_claim: tx("tr.oClient"), runtime_process_metadata: tx("tr.oRuntime"), network_metadata: tx("tr.oNet"), verified_receipt: tx("tr.oReceipt"), unknown_legacy: tx("tr.oLegacy") } as Record<string, string>)[origin] ?? tx("tr.oUnk");
}

function destinationLabel(destination: string | null): string {
  return ({ vendor_api: tx("tr.dVendor"), object_storage: tx("tr.dStorage"), telemetry: tx("tr.dTelemetry"), eval: tx("tr.dEval"), model_api: tx("tr.dModel"), unknown: tx("tr.dUnk") } as Record<string, string>)[destination ?? ""] ?? tx("tr.undeclared");
}

function errorMessage(reason: unknown): string {
  return safeUiError(reason, tx("tr.dataUnavailable"));
}

function capabilityLabel(value: TrustMonitorConfig["capability"]): string {
  return { not_started: tx("tr.cNotStarted"), available: tx("tr.cAvail"), partial: tx("tr.cPartial"), unavailable: tx("tr.unavailable") }[value];
}

function snapshotCapabilityLabel(value: string): string {
  return value === "macos_lsof_partial" ? tx("tr.snapLsof") : value === "runtime_sensor_unavailable_on_this_platform" ? tx("tr.snapNoSensor") : tx("tr.snapUnavail");
}

function monitorUpdatedAt(value: number | null): string {
  return value == null ? tx("tr.notWritten") : localTime(value);
}

function monitorReasonLabel(value: TrustMonitorConfig["reason"], error: TrustMonitorConfig["last_error_code"] = null): string {
  if (value === "authority_unavailable") return tx("tr.rAuthority");
  if (value === "monitor_state_unavailable") return tx("tr.rNotInit");
  return error === "sensor_unavailable" ? tx("tr.rSensorUnavail") : error === "snapshot_failed" ? tx("tr.rSnapFailed") : error === "sensor_partial" ? tx("tr.rSensorPartial") : tx("tr.rStateUnavail");
}

function rootClassLabel(value: string): string {
  return ({
    git_metadata: tx("tr.cGit"),
    workspace_or_project: tx("tr.cWorkspace"),
    home_relative_app_data: tx("tr.cAppData"),
    filesystem_root: tx("tr.cFsRoot"),
    parent_traversal: tx("tr.cParent"),
    home_directory: tx("tr.cHome"),
    home_relative: tx("tr.cHomeRel"),
    absolute_home_path: tx("tr.cAbsHome"),
    absolute_system_path: tx("tr.cAbsSys"),
    relative_path: tx("tr.cRelWork"),
  } as Record<string, string>)[value] ?? tx("tr.cUnk");
}

function profileApprovalIsSafe(profile: TrustProfileSummary): boolean {
  const source = profile.source_scope_preview;
  const trust = profile.trust_scope_preview;
  if (!source || !trust || !source.roots_count || !trust.roots_count) return false;
  if (source.covers_full_filesystem || source.may_leave_home_directory) return false;
  return source.root_classes.every((item) => ["home_relative", "home_directory", "absolute_home_path"].includes(item))
    && trust.root_classes.every((item) => item === "home_relative_app_data" || item === "workspace_or_project" || item === "git_metadata");
}

function profileScopeText(profile: TrustProfileSummary): string {
  const source = profile.source_scope_preview;
  const trust = profile.trust_scope_preview;
  if (!source || !trust) return tx("tr.scopeNoPreview");
  const sourceClasses = source.root_classes.map(rootClassLabel).join(listSep()) || tx("tr.noClass");
  const trustClasses = trust.root_classes.map(rootClassLabel).join(listSep()) || tx("tr.noClass");
  return tx("tr.scopeText", { srcRoots: source.roots_count, srcClasses: sourceClasses, patterns: profile.discovery_include_count, trRoots: trust.roots_count, trClasses: trustClasses, terms: profile.artifact_terms_count, exts: profile.extensions_count });
}

export function TrustPage() {
  useLanguage();
  const [candidates, setCandidates] = useState<TrustHarnessCandidate[]>([]);
  const [profileErrors, setProfileErrors] = useState<string[]>([]);
  const [selectedHarness, setSelectedHarness] = useState<string | null>(null);
  const [report, setReport] = useState<TrustAuditReport | null>(null);
  const [evidenceHistory, setEvidenceHistory] = useState<TrustEvidence[]>([]);
  const [evidenceCursor, setEvidenceCursor] = useState<string | null>(null);
  const [evidenceLoading, setEvidenceLoading] = useState(true);
  const [evidenceLoadingMore, setEvidenceLoadingMore] = useState(false);
  const [evidenceError, setEvidenceError] = useState<string | null>(null);
  const [loading, setLoading] = useState(tx("tr.discovering"));
  const [error, setError] = useState<string | null>(null);
  const [monitor, setMonitor] = useState<TrustMonitorConfig | null>(null);
  const [monitorDraft, setMonitorDraft] = useState({ enabled: false, interval_seconds: 30, notifications_enabled: false });
  const [monitorLoading, setMonitorLoading] = useState(true);
  const [monitorSaving, setMonitorSaving] = useState(false);
  const [monitorFeedback, setMonitorFeedback] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<TrustRuntimeSnapshot | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [expandedEvidence, setExpandedEvidence] = useState<string | null>(null);
  const [auditLoadingHarness, setAuditLoadingHarness] = useState<string | null>(null);
  const [profileStatus, setProfileStatus] = useState<TrustProfileStatus>({ pending: [], approved: [] });
  const [suppressions, setSuppressions] = useState<TrustSuppression[]>([]);
  const [controlsLoading, setControlsLoading] = useState(true);
  const [controlsError, setControlsError] = useState<string | null>(null);
  const [controlsFeedback, setControlsFeedback] = useState<string | null>(null);
  const [profileConfirmation, setProfileConfirmation] = useState<{ action: "approve" | "reject" | "revoke"; slug: string; manifestHash: string } | null>(null);
  const [profileFeedback, setProfileFeedback] = useState<{ section: "pending" | "approved"; error: boolean; message: string } | null>(null);
  const [profileAction, setProfileAction] = useState<string | null>(null);
  const [suppressionAction, setSuppressionAction] = useState<string | null>(null);
  const controlsRequest = useRef(0);
  const auditRequest = useRef(0);
  const evidenceRequest = useRef(0);

  const discover = () => {
    setLoading(tx("tr.discovering"));
    setError(null);
    void discoverTrust()
      .then((result) => { setCandidates(result.candidates); setProfileErrors(result.profile_errors); setLoading(""); })
      .catch((reason: unknown) => { setError(errorMessage(reason)); setLoading(""); });
  };

  const loadTrustControls = async () => {
    const requestId = ++controlsRequest.current;
    setControlsLoading(true);
    setControlsError(null);
    const [profiles, rules] = await Promise.allSettled([readTrustProfileStatus(), readTrustSuppressions()]);
    if (requestId !== controlsRequest.current) return false;
    const errors: string[] = [];
    if (profiles.status === "fulfilled") setProfileStatus(profiles.value);
    else errors.push(safeUiError(profiles.reason, tx("tr.profileStatusUnavail")));
    if (rules.status === "fulfilled") setSuppressions(rules.value);
    else errors.push(safeUiError(rules.reason, tx("tr.suppressUnavail")));
    setControlsError(errors.length ? errors.join("；") : null);
    setControlsLoading(false);
    return profiles.status === "fulfilled";
  };

  // quiet = 失效事件触发的后台重取：不翻转 loading（不让列表被「正在读取」替换再换回来），
  // 内容没变就沿用旧引用，React 跳过渲染。
  const refreshEvidenceHistory = async (cursor: string | null = null, append = false, quiet = false) => {
    const requestId = ++evidenceRequest.current;
    if (append) setEvidenceLoadingMore(true); else if (!quiet) setEvidenceLoading(true);
    setEvidenceError(null);
    try {
      const history = await readTrustEvidence(null, 200, cursor);
      if (requestId !== evidenceRequest.current) return;
      setEvidenceHistory((current) => append ? current.concat(history.evidence) : stable(current, history.evidence));
      setEvidenceCursor(history.next_cursor);
    } catch (reason: unknown) {
      if (requestId === evidenceRequest.current) setEvidenceError(errorMessage(reason));
    } finally {
      if (requestId === evidenceRequest.current) {
        setEvidenceLoading(false);
        setEvidenceLoadingMore(false);
      }
    }
  };

  useEffect(() => { discover(); void loadTrustControls(); void refreshEvidenceHistory(); }, []);

  useEffect(() => () => { controlsRequest.current += 1; }, []);

  const refreshTrustPage = () => {
    discover();
    void loadTrustControls();
  };

  const requestProfileDecision = (profile: TrustProfileSummary, action: "approve" | "reject" | "revoke") => {
    const section = action === "revoke" ? "approved" : "pending";
    if (action === "approve" && !profileApprovalIsSafe(profile)) {
      setProfileFeedback({ section, error: true, message: tx("tr.approveUnsafe") });
      return;
    }
    setProfileFeedback(null);
    setProfileConfirmation({ action, slug: profile.slug, manifestHash: profile.manifest_hash });
  };

  const decideProfile = async (profile: TrustProfileSummary, action: "approve" | "reject" | "revoke") => {
    const section = action === "revoke" ? "approved" : "pending";
    if (profileConfirmation?.action !== action || profileConfirmation.slug !== profile.slug || profileConfirmation.manifestHash !== profile.manifest_hash) {
      setProfileFeedback({ section, error: true, message: tx("tr.manifestChanged") });
      setProfileConfirmation(null);
      return;
    }
    const actionKey = `${action}:${profile.slug}`;
    setProfileAction(actionKey);
    setProfileConfirmation(null);
    setProfileFeedback({ section, error: false, message: tx(action === "approve" ? "tr.approving2" : action === "reject" ? "tr.rejecting2" : "tr.revoking2", { name: profile.display_name }) });
    try {
      if (action === "approve") await approveTrustProfile(profile);
      else if (action === "reject") await rejectTrustProfile(profile);
      else await revokeTrustProfile(profile);
      discover();
      const refreshed = await loadTrustControls();
      setProfileFeedback({ section, error: !refreshed, message: refreshed
        ? `${profile.display_name}: ${tx(action === "approve" ? "tr.doneApproved" : action === "reject" ? "tr.doneRejected" : "tr.doneRevoked")}`
        : tx("tr.actionDoneRefreshFailed", { name: profile.display_name }) });
    } catch (reason: unknown) {
      setProfileFeedback({ section, error: true, message: tx("tr.actionFailed", { error: safeUiError(reason, tx("tr.profileOpFailed")) }) });
    } finally {
      setProfileAction(null);
    }
  };

  const revokeSuppression = async (suppression: TrustSuppression) => {
    if (!window.confirm(tx("tr.restoreConfirm", { type: suppression.issue_type }))) return;
    setSuppressionAction(suppression.suppression_id);
    setControlsFeedback(null);
    try {
      const status = await revokeTrustSuppression(suppression.suppression_id);
      setControlsFeedback(status === "revoked" ? tx("tr.restored", { type: suppression.issue_type }) : tx("tr.suppressGone"));
      await loadTrustControls();
    } catch (reason: unknown) {
      setControlsFeedback(tx("tr.revokeFailed", { error: safeUiError(reason, tx("tr.notifySettingsUnavail")) }));
    } finally {
      setSuppressionAction(null);
    }
  };

  useEffect(() => {
    let active = true;
    void readTrustMonitorConfig()
      .then((value) => {
        if (!active) return;
        setMonitor(value);
        setMonitorDraft({ enabled: value.enabled, interval_seconds: value.interval_seconds, notifications_enabled: value.notifications_enabled });
      })
      .catch((reason: unknown) => { if (active) setMonitorFeedback(errorMessage(reason)); })
      .finally(() => { if (active) setMonitorLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    let cleanup: (() => void) | null = null;
    void listenAppEvents((event) => {
      if (!active || event.type !== "SourceDataDeleted") return;
      auditRequest.current += 1;
      setReport(() => null);
      setSelectedHarness(null);
      setExpandedEvidence(null);
      setAuditLoadingHarness(null);
      setMonitorFeedback(tx("tr.projDeleted"));
      setEvidenceHistory([]);
      void refreshEvidenceHistory();
      discover();
    })
      .then((unsubscribe) => { if (active) cleanup = unsubscribe; else unsubscribe(); });
    return () => { active = false; cleanup?.(); };
  }, []);

  useEffect(() => {
    let active = true;
    let cleanup: (() => void) | null = null;
    void listenAppEvents((event) => {
      if (!active || event.type !== "TrustMonitorInvalidated") return;
      setReport(null);
      setSelectedHarness(null);
      void refreshEvidenceHistory(null, false, true);
      void readTrustMonitorConfig().then((value) => {
        if (!active) return;
        setMonitor((previous) => stable(previous, value));
        setMonitorDraft({ enabled: value.enabled, interval_seconds: value.interval_seconds, notifications_enabled: value.notifications_enabled });
        setMonitorFeedback(tx("tr.monitorRefreshed"));
      }).catch(() => undefined);
    }).then((unsubscribe) => { if (active) cleanup = unsubscribe; else unsubscribe(); });
    return () => { active = false; cleanup?.(); };
  }, []);

  // R6a（REFRESH_STORM）：一次性知情询问——仅 enabled_source === 'legacy_default'
  // （迁移前存量库、从未显式选择过）时展示；任何选择都离开该态（开启/保持
  // 关闭 → user，稍后 → dismissed 永不再问）。三要素文案：本机进程观察 /
  // 仅本地存 7 天 / 零网络外发。
  const askEnable = async () => {
    setMonitorSaving(true);
    try {
      const value = await saveTrustMonitorConfig({ enabled: true, interval_seconds: monitorDraft.interval_seconds, notifications_enabled: false });
      setMonitor(value);
      setMonitorDraft({ enabled: value.enabled, interval_seconds: value.interval_seconds, notifications_enabled: value.notifications_enabled });
      setMonitorFeedback(value.enabled ? tx("tr.monOn") : tx("tr.monOff"));
    } catch (reason: unknown) { setMonitorFeedback(tx("tr.saveFailed", { error: errorMessage(reason) })); }
    finally { setMonitorSaving(false); }
  };
  const askDisable = async () => {
    setMonitorSaving(true);
    try {
      const value = await saveTrustMonitorConfig({ enabled: false, interval_seconds: monitorDraft.interval_seconds, notifications_enabled: false });
      setMonitor(value);
      setMonitorDraft({ enabled: value.enabled, interval_seconds: value.interval_seconds, notifications_enabled: value.notifications_enabled });
      setMonitorFeedback(tx("tr.keptOff"));
    } catch (reason: unknown) { setMonitorFeedback(tx("tr.saveFailed", { error: errorMessage(reason) })); }
    finally { setMonitorSaving(false); }
  };
  const askLater = async () => {
    try {
      const value = await dismissTrustMonitorPrompt();
      setMonitor(value);
      setMonitorFeedback(tx("tr.skipped"));
    } catch (reason: unknown) { setMonitorFeedback(tx("tr.opFailed", { error: errorMessage(reason) })); }
  };

  const saveMonitor = (next: { enabled: boolean; interval_seconds: number; notifications_enabled: boolean }) => {
    if (monitorSaving || monitor?.status !== "ok") return;
    setMonitorDraft(next);
    setMonitorSaving(true);
    setMonitorFeedback(tx("tr.applying"));
    void saveTrustMonitorConfig(next)
      .then((value) => {
        setMonitor(value);
        setMonitorDraft({ enabled: value.enabled, interval_seconds: value.interval_seconds, notifications_enabled: value.notifications_enabled });
        setMonitorFeedback(value.enabled ? tx("tr.monOn") : tx("tr.monOff"));
      })
      .catch((reason: unknown) => {
        if (monitor) setMonitorDraft({ enabled: monitor.enabled, interval_seconds: monitor.interval_seconds, notifications_enabled: monitor.notifications_enabled });
        setMonitorFeedback(tx("tr.saveFailed", { error: errorMessage(reason) }));
      })
      .finally(() => setMonitorSaving(false));
  };

  const runSnapshot = () => {
    setSnapshotLoading(true);
    setMonitorFeedback(null);
    void runTrustRuntimeSnapshot()
      .then((value) => {
        setSnapshot(value);
        setReport(null);
        setSelectedHarness(null);
        void refreshEvidenceHistory();
        setMonitorFeedback(value.observations > 0
          ? tx("tr.snapRecorded", { n: value.observations })
          : tx("tr.snapNone", { reason: snapshotCapabilityLabel(value.capability) }));
      })
      .catch((reason: unknown) => setMonitorFeedback(tx("tr.snapFailed", { error: errorMessage(reason) })))
      .finally(() => setSnapshotLoading(false));
  };

  const runAudit = (harness: string) => {
    const requestId = ++auditRequest.current;
    setSelectedHarness(harness);
    setExpandedEvidence(null);
    setAuditLoadingHarness(harness);
    setLoading(tx("tr.readingHarness", { harness }));
    setError(null);
    void auditTrust(harness)
      .then(async (result) => { if (requestId === auditRequest.current) { setReport(result); setLoading(""); await refreshEvidenceHistory(); } })
      .catch((reason: unknown) => { if (requestId === auditRequest.current) { setError(errorMessage(reason)); setLoading(""); } })
      .finally(() => { if (requestId === auditRequest.current) setAuditLoadingHarness(null); });
  };

  const displayedEvidence = report?.evidence ?? evidenceHistory;

  return <section className="trust-page" aria-labelledby="trust-page-title">
    <h2 id="trust-page-title" className="visually-hidden">{tx("tr.pageTitle")}</h2>
    <ToolbarActions>
      <button className="button button-secondary" type="button" onClick={refreshTrustPage} disabled={Boolean(loading) || controlsLoading}>{tx("tr.rediscover")}</button>
    </ToolbarActions>
    {loading && <p className="inline-status" role="status">{loading}</p>}
    {error && <div className="error-banner" role="alert">{error}</div>}
    {auditLoadingHarness && report && <div className="trust-refresh-status" role="status">{tx("tr.refreshingHarness", { harness: auditLoadingHarness })}</div>}
    {!auditLoadingHarness && error && report && <div className="trust-refresh-status trust-refresh-status-error" role="status">{tx("tr.auditIncomplete", { harness: report.harness })}</div>}
    {profileErrors.length > 0 && <div className="callout"><strong>{tx("tr.partialConfig")}</strong><span>{tx("tr.configWarnings", { n: profileErrors.length })}</span></div>}
    <details className="trust-control-disclosure">
      <summary>{tx("tr.controlsSummary")} <span>{tx("tr.pendingEnabled", { pending: profileStatus.pending.length, enabled: profileStatus.approved.length })}</span></summary>
    <section className="trust-control-card" aria-labelledby="trust-profile-controls-title">
      <div className="trust-card-heading"><div><p className="eyebrow">{tx("tr.localUiAuth")}</p><h3 id="trust-profile-controls-title">{tx("tr.profileSuppress")}</h3></div><button className="button button-secondary button-small" type="button" onClick={() => void loadTrustControls()} disabled={controlsLoading || profileAction !== null || suppressionAction !== null}>{controlsLoading ? tx("tr.loadingDots") : tx("tr.refreshAuth")}</button></div>
      <p className="trust-control-copy">{tx("tr.authCopy")}</p>
      {controlsError && <div className="error-banner" role="alert">{controlsError} · {tx("tr.keepingLast")}</div>}
      {controlsFeedback && <p className="monitor-feedback" role="status">{controlsFeedback}</p>}
      <div className="trust-control-columns">
        <section className="trust-control-group" aria-labelledby="trust-pending-title">
          <div className="trust-control-group-heading"><h4 id="trust-pending-title">{tx("tr.pendingProfiles")}</h4><span className="count-badge">{profileStatus.pending.length}</span></div>
          {profileFeedback?.section === "pending" && <p className={`trust-profile-feedback ${profileFeedback.error ? "trust-profile-feedback-error" : ""}`} role={profileFeedback.error ? "alert" : "status"}>{profileFeedback.message}</p>}
          {profileStatus.pending.length === 0 ? <p className="trust-control-empty">{tx("tr.noPending")}</p> : profileStatus.pending.map((profile) => {
            const canApprove = profile.state === "pending" && profileApprovalIsSafe(profile);
            return <article className={`trust-profile-row ${profile.state === "invalid" ? "trust-profile-row-invalid" : ""}`} key={`${profile.slug}:${profile.manifest_hash}`}>
              <div className="trust-profile-heading"><div><strong>{profile.display_name}</strong><span>{profile.slug} · {profile.state === "invalid" ? tx("tr.manifestInvalid") : tx("tr.awaiting")}</span></div><code title={tx("tr.boundManifest")}>{profile.manifest_hash}</code></div>
              {profile.state === "invalid" ? <p className="trust-profile-warning">{tx("tr.invalidProposal")}</p> : <>
                <p className="trust-profile-scope">{tx("tr.logScope")}{profile.source_scope_preview ? tx("tr.logScopeVal", { roots: profile.source_scope_preview.roots_count, classes: profile.source_scope_preview.root_classes.map(rootClassLabel).join(listSep()) || tx("tr.noClass"), patterns: profile.discovery_include_count }) : tx("tr.unsafePreview")}</p>
                <p className="trust-profile-scope">{tx("tr.trustScan")}{profile.trust_scope_preview ? tx("tr.trustScanVal", { roots: profile.trust_scope_preview.roots_count, classes: profile.trust_scope_preview.root_classes.map(rootClassLabel).join(listSep()) || tx("tr.noClass"), terms: profile.artifact_terms_count, exts: profile.extensions_count }) : tx("tr.unsafePreview")}</p>
                {(profile.source_scope_preview?.covers_full_filesystem || profile.source_scope_preview?.may_leave_home_directory || profile.source_scope_preview?.may_include_git_metadata || profile.trust_scope_preview?.may_include_git_metadata) && <p className="trust-profile-warning">{tx("tr.broadWarn")}</p>}
                <small className="trust-profile-disclaimer">{tx("tr.redactedNote")}</small>
              </>}
              <div className="trust-profile-actions">
                <button className="button button-primary-small" type="button" onClick={() => requestProfileDecision(profile, "approve")} disabled={!canApprove || profileAction !== null || controlsLoading}>{profileAction === `approve:${profile.slug}` ? tx("tr.approving") : tx("tr.approveEnable")}</button>
                <button className="button button-secondary button-small" type="button" onClick={() => requestProfileDecision(profile, "reject")} disabled={profileAction !== null || controlsLoading}>{profileAction === `reject:${profile.slug}` ? tx("tr.rejecting") : tx("tr.reject")}</button>
                {!canApprove && profile.state === "pending" && <span className="trust-profile-warning-inline">{tx("tr.approveDisabled")}</span>}
              </div>
              {profileConfirmation?.slug === profile.slug && profileConfirmation.manifestHash === profile.manifest_hash && profileConfirmation.action !== "revoke" && <div className="trust-profile-confirm" role="group" aria-label={tx("tr.confirmAria", { name: profile.display_name })}>
                <p><strong>{tx(profileConfirmation.action === "approve" ? "tr.confirmApprove" : "tr.confirmReject", { name: profile.display_name })}</strong> {profileConfirmation.action === "approve" ? `${profileScopeText(profile)}${tx("tr.afterApprove")}` : tx("tr.afterReject")}{tx("tr.manifestVer", { hash: profile.manifest_hash })}</p>
                <div className="trust-profile-actions"><button className="button button-primary-small" type="button" onClick={() => void decideProfile(profile, profileConfirmation.action)} disabled={profileAction !== null || controlsLoading}>{tx(profileConfirmation.action === "approve" ? "tr.confirmApproveBtn" : "tr.confirmRejectBtn")}</button><button className="button button-secondary button-small" type="button" onClick={() => { setProfileConfirmation(null); setProfileFeedback({ section: "pending", error: false, message: tx("tr.cancelledUnchanged") }); }}>{tx("tr.cancel")}</button></div>
              </div>}
            </article>;
          })}
        </section>
        <section className="trust-control-group" aria-labelledby="trust-approved-title">
          <div className="trust-control-group-heading"><h4 id="trust-approved-title">{tx("tr.enabledProfiles")}</h4><span className="count-badge">{profileStatus.approved.length}</span></div>
          {profileFeedback?.section === "approved" && <p className={`trust-profile-feedback ${profileFeedback.error ? "trust-profile-feedback-error" : ""}`} role={profileFeedback.error ? "alert" : "status"}>{profileFeedback.message}</p>}
          {profileStatus.approved.length === 0 ? <p className="trust-control-empty">{tx("tr.noEnabled")}</p> : profileStatus.approved.map((profile) => <article className="trust-profile-row" key={`${profile.slug}:${profile.manifest_hash}`}>
            <div className="trust-profile-heading"><div><strong>{profile.display_name}</strong><span>{profile.slug} · {tx("tr.enabled")}</span></div><code title={tx("tr.revokeBound")}>{profile.manifest_hash}</code></div>
            <p className="trust-profile-scope">{profileScopeText(profile)}</p>
            {(profile.source_scope_preview?.may_leave_home_directory || profile.source_scope_preview?.may_include_git_metadata || profile.trust_scope_preview?.may_include_git_metadata) && <p className="trust-profile-warning">{tx("tr.broadEnabled")}</p>}
            <div className="trust-profile-actions"><button className="button button-secondary button-small" type="button" onClick={() => requestProfileDecision(profile, "revoke")} disabled={profileAction !== null || controlsLoading}>{profileAction === `revoke:${profile.slug}` ? tx("tr.revoking") : tx("tr.revokeEnable")}</button></div>
            {profileConfirmation?.action === "revoke" && profileConfirmation.slug === profile.slug && profileConfirmation.manifestHash === profile.manifest_hash && <div className="trust-profile-confirm" role="group" aria-label={tx("tr.revokeAria", { name: profile.display_name })}>
              <p><strong>{tx("tr.confirmRevoke", { name: profile.display_name })}</strong> {tx("tr.revokeNote")}{tx("tr.manifestVer", { hash: profile.manifest_hash })}</p>
              <div className="trust-profile-actions"><button className="button button-primary-small" type="button" onClick={() => void decideProfile(profile, "revoke")} disabled={profileAction !== null || controlsLoading}>{tx("tr.confirmRevokeBtn")}</button><button className="button button-secondary button-small" type="button" onClick={() => { setProfileConfirmation(null); setProfileFeedback({ section: "approved", error: false, message: tx("tr.cancelledStillOn") }); }}>{tx("tr.cancel")}</button></div>
            </div>}
          </article>)}
        </section>
      </div>
      <section className="trust-control-group trust-suppression-group" aria-labelledby="trust-suppression-title">
        <div className="trust-control-group-heading"><div><h4 id="trust-suppression-title">{tx("tr.suppressTitle")}</h4><p>{tx("tr.suppressNote")}</p></div><span className="count-badge">{suppressions.length}</span></div>
        {suppressions.length === 0 ? <p className="trust-control-empty">{tx("tr.noSuppress")}</p> : <ul className="trust-suppression-list">{suppressions.map((suppression) => <li key={suppression.suppression_id}>
          <div><strong>{suppression.issue_type}</strong><span>{new Date(suppression.created_at_ms).toLocaleString(appLocale())} · {suppression.revoked_at_ms === null ? tx("tr.ignored") : tx("tr.restoredLabel")}</span></div>
          {suppression.revoked_at_ms === null && <button className="button button-secondary button-small" type="button" onClick={() => void revokeSuppression(suppression)} disabled={suppressionAction !== null || controlsLoading}>{suppressionAction === suppression.suppression_id ? tx("tr.restoring") : tx("tr.restoreBtn")}</button>}
        </li>)}</ul>}
      </section>
    </section>
    </details>
    <section className="trust-monitor-card" aria-labelledby="trust-monitor-title">
      <div className="trust-card-heading"><div><p className="eyebrow">Runtime monitor</p><h3 id="trust-monitor-title">{tx("tr.monitorTitle")}</h3></div>
      <span className={`status-pill ${monitor?.status === "ok" && monitor.enabled ? "status-pill-success" : monitor?.status === "unavailable" ? "status-pill-warning" : ""}`}><span aria-hidden="true" className="status-dot" />{monitorLoading ? tx("tr.loadingShort") : monitor?.status === "unavailable" ? tx("tr.cannotConfirm") : monitor?.enabled ? tx("tr.on") : tx("tr.offDefault")}</span></div>
      {monitor?.status === "ok" && monitor.enabled_source === "legacy_default" && (
        <div className="trust-banner" role="note" data-testid="trust-rollout-ask">
          <p><strong>{tx("tr.askTitle")}</strong>{tx("tr.askBody")}</p>
          <div className="trust-banner-actions">
            <button className="button button-primary-small" type="button" onClick={askEnable} disabled={monitorSaving}>{tx("tr.turnOn")}</button>
            <button className="button button-secondary" type="button" onClick={askDisable} disabled={monitorSaving}>{tx("tr.keepOff")}</button>
            <button className="button button-ghost" type="button" onClick={askLater} disabled={monitorSaving}>{tx("tr.later")}</button>
          </div>
        </div>
      )}
      <p className="monitor-copy">{tx("tr.monitorCopy")}</p>
      {monitor?.status === "unavailable" && <div className="callout monitor-unavailable" role="status"><strong>{tx("tr.monitorUnavail")}</strong><span>{monitorReasonLabel(monitor.reason, monitor.last_error_code)}{tx("tr.monitorUnavailTail")}</span></div>}
      <div className="monitor-controls">
        <label className="monitor-check"><input aria-describedby="trust-monitor-title" type="checkbox" checked={monitorDraft.enabled} onChange={(event) => saveMonitor({ ...monitorDraft, enabled: event.target.checked, notifications_enabled: event.target.checked && monitorDraft.notifications_enabled })} disabled={monitorLoading || monitorSaving || monitor?.status !== "ok"} /><span>{tx("tr.enableMonitor")}</span></label>
        <label className="monitor-check"><input type="checkbox" checked={monitorDraft.notifications_enabled} onChange={(event) => saveMonitor({ ...monitorDraft, notifications_enabled: event.target.checked })} disabled={!monitorDraft.enabled || monitorLoading || monitorSaving || monitor?.status !== "ok"} /><span>{tx("tr.notifyOnChain")}</span></label>
      </div>
      <div className="monitor-meta"><span>{tx("tr.capability")}{monitor?.status === "ok" ? monitor.enabled && monitor.capability === "not_started" ? tx("tr.firstSampling") : capabilityLabel(monitor.capability) : tx("tr.notObservable")}</span><span>{tx("tr.lastState")}{monitor?.last_error_code ? monitorReasonLabel(monitor.reason, monitor.last_error_code) : monitor?.status === "ok" ? tx("tr.noError") : tx("tr.notObservable")}</span><span>{tx("tr.updated")}{monitorUpdatedAt(monitor?.updated_at_ms ?? null)}</span></div>
      <div className="monitor-snapshot">
        <div><strong>{tx("tr.snapshotTitle")}</strong><p>{tx("tr.snapshotDesc")}</p></div>
        <button className="button button-secondary" type="button" onClick={runSnapshot} disabled={snapshotLoading}>{snapshotLoading ? tx("tr.collecting") : tx("tr.collectNow")}</button>
      </div>
      {snapshot && <div className="snapshot-result" role="status"><strong>{snapshotCapabilityLabel(snapshot.capability)}</strong><span>{tx("tr.candProcs")} {snapshot.candidate_processes}</span><span>{tx("tr.redactedEv")} {snapshot.observations}</span><span>{tx("tr.newFindings")} {snapshot.findings_upserted}</span><span>{tx("tr.notifCands")} {snapshot.notification_candidates}</span></div>}
      {monitorFeedback && <p className="monitor-feedback" role="status">{monitorFeedback}</p>}
    </section>
    <div className="trust-layout">
      <section className="trust-card" aria-label={tx("tr.discoveredHarnesses")}>
        <div className="trust-card-heading"><div><p className="eyebrow">{tx("tr.coverage")}</p><h3>{tx("tr.localHarnesses")}</h3></div><span className="count-badge">{candidates.length}</span></div>
        {candidates.length === 0 && !loading ? <div className="mini-empty">{tx("tr.noHarnesses")}</div> : <div className="harness-list">
          {candidates.map((candidate) => <article className={`harness-row ${selectedHarness === candidate.id ? "harness-row-selected" : ""}`} key={candidate.id}>
            <div><strong>{candidate.id}</strong><p>{tx(candidate.detected ? "tr.dirFound" : "tr.dirNotFound")} · {candidate.coverage_state}</p></div>
            <button className="button button-primary-small" type="button" disabled={!candidate.detected || !candidate.artifact_profile_available || Boolean(loading)} onClick={() => runAudit(candidate.id)}>{selectedHarness === candidate.id && report ? tx("tr.done") : tx("tr.localAudit")}</button>
          </article>)}
        </div>}
      </section>
      <section className="trust-card" aria-label={tx("tr.auditResult")} aria-live="polite">
          <div className="trust-card-heading"><div><p className="eyebrow">{report ? `${harnessName(report.harness)} · ${tx(report.harness === selectedHarness ? "tr.justAudited" : "tr.lastAudit")}` : tx("tr.historyEvidence")}</p><h3>{displayedEvidence.length}{evidenceCursor && !report ? "+" : ""} {tx("tr.evidenceWord", { n: displayedEvidence.length })}</h3></div><div className="trust-evidence-actions"><span className={`status-pill ${report ? "status-pill-success" : ""}`}><span aria-hidden="true" className="status-dot" />{report ? tx("tr.localResult") : tx("tr.readOnlyHistory")}</span><button className="button button-secondary button-small" type="button" onClick={() => { setReport(null); setSelectedHarness(null); void refreshEvidenceHistory(); }} disabled={evidenceLoading}>{evidenceLoading ? tx("tr.loadingDots") : tx("tr.refreshHistory")}</button></div></div>
          {report && <div className="trust-summary"><span>{tx("tr.inserted")} {report.inserted}</span><span>{tx("tr.duplicate")} {report.duplicate}</span><span>{tx("tr.findingUpdates")} {report.findings_upserted}</span></div>}
          {evidenceError && <div className="error-banner" role="alert">{tx("tr.historyUnavail", { error: evidenceError })}</div>}
          {evidenceLoading && <p className="inline-status" role="status">{tx("tr.readingSaved")}</p>}
          {!evidenceLoading && displayedEvidence.length === 0 ? <div className="mini-empty">{report ? tx("tr.noTimeline") : tx("tr.noSavedEvidence")}</div> : <ol className="evidence-timeline">
            {displayedEvidence.map((item, index) => {
              const evidenceKey = `${item.collector_id}-${item.observed_at_ms}-${index}`;
              const isExpanded = expandedEvidence === evidenceKey;
              return <li className="evidence-row" key={evidenceKey}>
              <div className="evidence-marker" aria-hidden="true" />
              <div className="evidence-main"><div className="evidence-title"><strong>{evidenceKindLabel(item.kind)} · {evidenceStageLabel(item.stage)}</strong><div className="evidence-title-actions"><span className={`status-pill ${levelTone(item.evidence_level)}`} title={evidenceLevelLabel(item.evidence_level)}>{item.evidence_level} · {evidenceLevelLabel(item.evidence_level)}</span><button className="button button-secondary button-small evidence-detail-button" type="button" aria-expanded={isExpanded} aria-controls={`trust-evidence-detail-${index}`} onClick={() => setExpandedEvidence(isExpanded ? null : evidenceKey)}>{tx(isExpanded ? "tr.hideDetail" : "tr.showDetail")}</button></div></div><p>{localTime(item.observed_at_ms)} · {tx("tr.originWord")} {evidenceOriginLabel(item.evidence_origin)} · {item.collector_id}</p><p>{tx("tr.scopeWord")}{item.scope_classes.length ? item.scope_classes.join(listSep()) : tx("tr.undeclared")} · {tx("tr.filesWord")} {item.file_count ?? "—"} · {tx("tr.sizeWord")} {bytes(item.byte_count)}</p><p>{tx("tr.safeRef")}{item.native_event_ref ?? item.workspace_ref ?? tx("tr.unavailable")}</p>
                {isExpanded && <div className="evidence-detail" id={`trust-evidence-detail-${index}`} role="region" aria-label={tx("tr.evidenceDetail")}><div><span>{tx("tr.dPosition")}</span><strong>{evidenceStageLabel(item.stage)}</strong></div><div><span>{tx("tr.dOrigin")}</span><strong>{evidenceOriginLabel(item.evidence_origin)}</strong></div><div><span>{tx("tr.dDest")}</span><strong>{destinationLabel(item.destination_class)}</strong></div><div><span>{tx("tr.dCollector")}</span><strong>{item.collector_id}</strong></div><div><span>{tx("tr.dSafeRef")}</span><code>{item.native_event_ref ?? item.workspace_ref ?? tx("tr.unavailable")}</code></div><p>{tx("tr.detailNote")}</p></div>}
              </div>
            </li>;
            })}
          </ol>}
          {evidenceCursor && !report && <div className="sessions-more"><button className="button button-secondary" type="button" onClick={() => void refreshEvidenceHistory(evidenceCursor, true)} disabled={evidenceLoadingMore}>{evidenceLoadingMore ? tx("tr.loadingOlder") : tx("tr.loadOlder", { n: evidenceHistory.length })}</button></div>}

      </section>
    </div>
  </section>;
}
