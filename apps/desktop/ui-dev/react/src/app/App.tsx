import { stable, isBackground } from "../lib/stable";
import { hydrateHarnessNames, useHarnessNames } from "../lib/harnessNames";
import { Component, useCallback, useEffect, useLayoutEffect, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { invoke, listen, listenAppEvents, makeInvalidationGate, readOverviewDetails, readOverviewSnapshot, readSourceDataRevision, safeUiError, type OverviewDetails, type OverviewSnapshot } from "../lib/tauri";
import { FindingsPage } from "../features/findings/FindingsPage";
import { TrustPage } from "../features/trust/TrustPage";
import { UsagePage } from "../features/usage/UsagePage";
import { SessionsPage } from "../features/sessions/SessionsPage";
import { TestPage } from "../features/test/TestPage";
import { SettingsPage } from "../features/settings/SettingsPage";
import { SkillsPage } from "../features/skills/SkillsPage";
import { OverviewPage } from "../features/overview/OverviewPage";
import { usePlugin } from "./plugins/usePlugin";
import { plugins } from "./plugins/registry";
import { StatusPill } from "../components/ui/StatusPill";
import { hydrateLanguagePreference, message, useLanguage, type MessageKey } from "../lib/i18n";

type Page = string;
type SettingSection = "settings-sources" | "settings-billing" | "settings-budget";
type SessionNavigationTarget = { type: "sessionDetail"; session_ref: string; harness_kind: string } | { type: "sessionList"; harness_kind: string | null };

const navigation: Array<{ id: Page; label?: MessageKey; name?: string }> = [
  { id: "overview", label: "nav.overview" },
  ...plugins.map(({ id, name }) => ({ id, name })),
  { id: "usage", label: "nav.usage" },
  { id: "sessions", label: "nav.sessions" },
  { id: "findings", label: "nav.findings" },
  { id: "test", label: "nav.test" },
  { id: "trust", label: "nav.trust" },
  { id: "skills", label: "nav.skills" },
  { id: "settings", label: "nav.settings" },
];

function isPage(value: unknown): value is Page {
  return typeof value === "string" && navigation.some((item) => item.id === value);
}

function parseSessionNavigationTarget(value: unknown): SessionNavigationTarget | null {
  if (!value || typeof value !== "object") return null;
  const target = value as Record<string, unknown>;
  if (target.type === "sessionDetail" && typeof target.session_ref === "string" && /^sr_[A-Za-z0-9_-]{8,128}$/.test(target.session_ref) && typeof target.harness_kind === "string") {
    return { type: "sessionDetail", session_ref: target.session_ref, harness_kind: target.harness_kind };
  }
  if (target.type === "sessionList" && (target.harness_kind === null || typeof target.harness_kind === "string")) {
    return { type: "sessionList", harness_kind: target.harness_kind as string | null };
  }
  return null;
}

function pageFromHash(): Page {
  // R1 深链：hash 可带 query（#sessions?date=…）——页面判定只看路径段，
  // query 由目标页自行解析（lib/nav.ts 白名单）。
  const value = window.location.hash.replace(/^#\/?/, "").split("?")[0];
  if (value === "settings" || value.startsWith("settings-")) return "settings";
  return navigation.some((item) => item.id === value) ? value as Page : "overview";
}

class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, _info: ErrorInfo) {
    console.error("[workbench-react] render failure", error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <main className="main-content"><section className="empty-state" role="alert">
      <p className="eyebrow">{message("error.renderLead")}</p><h1>{message("error.renderTitle")}</h1>
      <p>{message("error.renderHelp")}</p>
      <button className="button button-secondary" type="button" onClick={() => window.location.reload()}>{message("error.reload")}</button>
    </section></main>;
  }
}

export function App() {
  const language = useLanguage();
  useHarnessNames();
  useEffect(() => {
    let active = true;
    let unsubscribe = () => {};
    const refresh = () => { if (active) void hydrateHarnessNames().catch(() => { /* Preserve the last known names. */ }); };
    refresh();
    const gate = makeInvalidationGate();
    void listenAppEvents((event) => { if (gate(event)) refresh(); }).then((cleanup) => {
      if (!active) cleanup(); else unsubscribe = cleanup;
    }).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, []);
  useEffect(() => { void hydrateLanguagePreference().catch(() => { /* Keep the existing local preference visible; Settings can retry. */ }); }, []);
  const [page, setPage] = useState<Page>(pageFromHash);
  const mainContent = useRef<HTMLElement | null>(null);
  const previousPage = useRef(page);
  const selectedPlugin = plugins.find((plugin) => plugin.id === page);
  const pluginSlot = usePlugin(!!selectedPlugin, selectedPlugin ?? { id: "", name: "" });
  const pageName = (item: (typeof navigation)[number] | undefined) => item?.name ?? message(item?.label ?? "nav.overview", language);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem("workbench.sidebarCollapsed") === "true"; } catch { return false; }
  });
  const [overviewRefresh, setOverviewRefresh] = useState(0);
  const [overviewRefreshing, setOverviewRefreshing] = useState(false);
  const nativeMac = /Mac/.test(navigator.platform) && "__TAURI_INTERNALS__" in window;
  const [overview, setOverview] = useState<OverviewSnapshot | null>(null);
  const [overviewDetails, setOverviewDetails] = useState<OverviewDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sessionTarget, setSessionTarget] = useState<SessionNavigationTarget | null>(null);
  const [focusSettingSection, setFocusSettingSection] = useState<SettingSection | null>(null);
  const refreshSeq = useRef(0);

  useLayoutEffect(() => {
    if (previousPage.current === page) return;
    previousPage.current = page;
    // The main element survives page switches, so its scroll offset otherwise
    // carries over (for example, opening Settings at the budget panel's tail).
    // Deep links to a settings subsection manage their own target scroll.
    if (page === "settings" && focusSettingSection) return;
    mainContent.current?.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [page, focusSettingSection]);

  const applyMenuTarget = useCallback(async () => {
    try {
      const tab: unknown = await invoke("peek_nav_target");
      const sectionTarget = tab === "settings#settings-budget" ? "settings-budget"
        : tab === "settings#settings-billing" ? "settings-billing"
        : tab === "settings#settings-sources" ? "settings-sources" : null;
      const page = sectionTarget ? "settings" : tab;
      if (isPage(page)) {
        window.location.hash = page;
        setPage(page);
        setFocusSettingSection(sectionTarget as SettingSection | null);
        await invoke("clear_nav_target");
      }
    } catch (reason: unknown) {
      console.warn("[workbench-react] 菜单页面目标读取失败", reason);
    }
    try {
      const value: unknown = await invoke("peek_focus_target");
      const target = parseSessionNavigationTarget(value);
      if (!target) return;
      setSessionTarget(target);
      window.location.hash = "sessions";
      setPage("sessions");
    } catch (reason: unknown) {
      console.warn("[workbench-react] 菜单会话目标读取失败", reason);
    }
  }, []);

  const clearSessionTarget = useCallback(() => {
    setSessionTarget(null);
    void invoke("clear_focus_target").catch((reason: unknown) => console.warn("[workbench-react] 菜单会话目标清理失败", reason));
  }, []);

  const clearSettingSectionTarget = useCallback(() => setFocusSettingSection(null), []);

  const navigateToFindingAction = useCallback((actionKind: string) => {
    const target: SettingSection | null = actionKind === "budget" ? "settings-budget"
      : actionKind === "billing" ? "settings-billing"
      : actionKind === "source" ? "settings-sources" : null;
    if (!target) return;
    setFocusSettingSection(target);
    navigate("settings");
  }, []);

  useEffect(() => {
    let active = true;
    const cleanups: Array<() => void> = [];
    const subscribe = (event: string) => listen(event, () => { if (active) void applyMenuTarget(); }).then((unsubscribe) => {
      if (active) cleanups.push(unsubscribe);
      else unsubscribe();
    }).catch((reason: unknown) => console.warn(`[workbench-react] ${event} 订阅失败，持久目标仍可在窗口恢复时读取`, reason));
    void Promise.all([subscribe("focus-tab"), subscribe("focus-target")]).then(() => {
      // Subscribe before the cold-start pull so a menu click racing app startup is
      // either observed by the listener or still present in the persistent slot.
      if (active) void applyMenuTarget();
    });
    const onVisible = () => { if (document.visibilityState === "visible") void applyMenuTarget(); };
    window.addEventListener("focus", applyMenuTarget);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      cleanups.forEach((unsubscribe) => unsubscribe());
      window.removeEventListener("focus", applyMenuTarget);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [applyMenuTarget]);

  useEffect(() => {
    let active = true;
    let lastRevision: number | null = null;
    const poll = () => {
      void readSourceDataRevision().then((revision) => {
        if (!active) return;
        if (lastRevision !== null && revision !== lastRevision) {
          // R1：携带 revision 的 CustomEvent——listenAppEvents 透传给 gate，
          // 与 Invalidated 同 revision 的重复刷新被水位吞掉（此前是无条件
          // 二次全量刷新）。真删除语义不受影响（无 revision 时保守放行）。
          window.dispatchEvent(new CustomEvent("agent-vitals-source-data-deleted", { detail: { revision } }));
        }
        lastRevision = revision;
      });
    };
    poll();
    const timer = window.setInterval(poll, 5_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (page !== "overview") return;
    let active = true;
    setError(null);
    // 后台刷新（失效事件）：不翻转 overviewRefreshing，内容没变就沿用旧引用——App 是根组件，
    // 每次换新对象都会让整棵树重渲染。首次进入与手动刷新（overviewRefresh 变化）照旧显示刷新态。
    const refresh = (background: unknown = false) => {
      const quiet = isBackground(background);
      const requestId = ++refreshSeq.current;
      setError(null);
      if (!quiet) setOverviewRefreshing(true);
      const snapshotRequest = readOverviewSnapshot()
        .then((value) => { if (active && requestId === refreshSeq.current) setOverview((previous) => stable(previous, value)); })
        .catch((reason: unknown) => { if (active && requestId === refreshSeq.current) setError(safeUiError(reason, "本地数据暂不可用")); });
      const detailsRequest = readOverviewDetails()
        .then((value) => { if (active && requestId === refreshSeq.current) setOverviewDetails((previous) => stable(previous, value)); })
        .catch((reason: unknown) => { if (active && requestId === refreshSeq.current) setError(safeUiError(reason, "总览明细暂不可用")); });
      void Promise.allSettled([snapshotRequest, detailsRequest]).then(() => {
        if (active && requestId === refreshSeq.current) setOverviewRefreshing(false);
      });
    };
    void refresh();
    let cleanups: Array<() => void> = [];
    // 总览壳层：数据失效（revision 前进）或同步状态变化才重拉；WatcherHealth /
    // Trust 类事件与总览无关，不再触发这里的两个 invoke。
    const gate = makeInvalidationGate();
    void listenAppEvents((event) => { if (gate(event) || event.type === "SyncStatusChanged" || event.type === "HarnessNavigationChanged") refresh(true); })
      .then((unsubscribe) => { if (active) cleanups = [unsubscribe]; else unsubscribe(); });
    return () => { active = false; cleanups.forEach((unsubscribe) => unsubscribe()); };
  }, [page, overviewRefresh]);

  useEffect(() => {
    const onHashChange = () => setPage(pageFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const navigate = (next: Page) => {
    window.location.hash = next;
    setPage(next);
  };

  const headerStatus = page === "overview"
    ? overview === null ? { tone: "neutral" as const, label: message("toolbar.loading", language) } : overview.sync.ok ? { tone: "success" as const, label: message("toolbar.synced", language) } : { tone: "warning" as const, label: message("toolbar.syncIssue", language) }
    : { tone: "success" as const, label: message("toolbar.local", language) };

  const toggleSidebar = () => {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    try { localStorage.setItem("workbench.sidebarCollapsed", String(next)); } catch { /* presentation preference only */ }
  };

  return <AppErrorBoundary><div className={`app-shell desktop-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${nativeMac ? "native-mac" : ""}`}>
    <header className="desktop-toolbar" data-tauri-drag-region>
      <button className="button button-secondary sidebar-toggle" type="button" aria-label={message(sidebarCollapsed ? "toolbar.expand" : "toolbar.collapse", language)} aria-expanded={!sidebarCollapsed} aria-controls="workbench-sidebar" onClick={toggleSidebar}><svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor"/><path d="M6 3v10" stroke="currentColor"/></svg></button>
      <span className="desktop-toolbar-title" data-tauri-drag-region>{pageName(navigation.find((item) => item.id === page))}</span>
      <span className="desktop-drag-space" data-tauri-drag-region />
      <div id="desktop-toolbar-actions" className="desktop-toolbar-actions">
        {pluginSlot.toolbar}
        {page === "overview" && <div className="header-actions"><StatusPill tone={headerStatus.tone}>{headerStatus.label}</StatusPill><button className="button button-secondary" type="button" disabled={overviewRefreshing} onClick={() => setOverviewRefresh((value) => value + 1)}>{message(overviewRefreshing ? "action.refreshing" : "action.refresh", language)}</button></div>}
      </div>
    </header>
    <aside id="workbench-sidebar" className="sidebar" aria-label={message("nav.label", language)} hidden={sidebarCollapsed}>
      <div className="brand"><span className="brand-mark" aria-hidden="true">OA</span><div><strong>Oh Agent</strong><span>{message("sidebar.workspace", language)}</span></div></div>
      <nav className="nav-list">
        {navigation.map((item) => <button key={item.id} className={`nav-item ${page === item.id ? "nav-item-active" : ""}`} aria-current={page === item.id ? "page" : undefined} type="button" onClick={() => navigate(item.id)}><span>{pageName(item)}</span></button>)}
      </nav>
      <div className="sidebar-footer"><StatusPill>{message("sidebar.offline", language)}</StatusPill><span>{message("sidebar.local", language)}</span></div>
    </aside>
    <main ref={mainContent} className={`main-content ${selectedPlugin ? "plugin-main-content" : ""}`}>
      <h1 className="visually-hidden">{pageName(navigation.find((item) => item.id === page))}</h1>
      {page === "overview" && error && <div className="error-banner" role="alert">{error} · {message("error.overviewStale", language)}</div>}
      {selectedPlugin ? pluginSlot.content : page === "overview" ? <OverviewPage overview={overview} details={overviewDetails} /> : page === "usage" ? <UsagePage /> : page === "sessions" ? <SessionsPage navigationTarget={sessionTarget} onNavigationTargetApplied={clearSessionTarget} /> : page === "trust" ? <TrustPage /> : page === "test" ? <TestPage /> : page === "skills" ? <SkillsPage /> : page === "settings" ? <SettingsPage focusSection={focusSettingSection} onSectionFocused={clearSettingSectionTarget} /> : <FindingsPage onNavigateToAction={navigateToFindingAction} />}
    </main>
  </div></AppErrorBoundary>;
}
