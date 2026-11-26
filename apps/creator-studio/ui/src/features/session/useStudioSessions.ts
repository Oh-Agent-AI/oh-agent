import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CreatorRequest } from "../../adapters/creatorHost";
import {
  applyStudioSessionPatch, filterStudioSessions, nextStudioSessionAfterArchive, nextStudioSessionLabel, parseStudioSessionList, readSelectedStudioSession,
  rememberSelectedStudioSession, sessionLabelValue, takeLegacyStudioSessionDraft, SESSION_DRAFT_MAX,
  type StudioSessionPatch, type StudioSessionScope, type StudioSessionSummary,
} from "./studioSessions";

const agentId = "creator-studio-local";
const scopePayload = (scope: StudioSessionScope) => scope.kind === "creator-project" ? { projectId: scope.projectId } : { cityId: scope.cityId };
// 打字时不要每次按键都打 Host；停手 700ms 才落一次草稿。
const draftDebounceMs = 700;

export function useStudioSessions(request: CreatorRequest, scope: StudioSessionScope | null, enabled = true) {
  const [sessions, setSessions] = useState<readonly StudioSessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [draftOverride, setDraftOverride] = useState<Readonly<{ sessionId: string; value: string }> | null>(null);
  const generation = useRef(0);
  // 同一 scope 的空列表只创建一次：StrictMode 会把挂载 effect 跑两遍，
  // 两边各自看到"空列表"就会并发出两个"创作会话 1"。
  const ensureSession = useRef<Promise<unknown> | null>(null);
  const draftTimer = useRef<number | null>(null);
  const pendingDraft = useRef<{ sessionId: string; value: string } | null>(null);
  const scopeKey = scope ? `${scope.kind}:${scope.kind === "creator-project" ? scope.projectId : scope.cityId}` : "";
  const scopeId = scope?.kind === "creator-project" ? scope.projectId : scope?.kind === "creator-city" ? scope.cityId : null;

  const selectSession = useCallback((sessionId: string) => {
    if (scopeKey) rememberSelectedStudioSession(scopeKey, sessionId);
    setActiveSessionId(sessionId);
  }, [scopeKey]);

  const refresh = useCallback(async () => {
    if (!scope || !enabled) return [];
    const current = generation.current;
    const rows = parseStudioSessionList(await request("creator.session.list", { agentId, ...scopePayload(scope), limit: 50 }));
    if (current === generation.current) setSessions(rows);
    return rows;
  }, [request, scope?.kind, scopeId, enabled]);

  /** 会话档案（名称 / 草稿 / 首选执行器）写 Host；失败只报错，不回退到第二份存储。 */
  const persistProfile = useCallback(async (sessionId: string, patch: StudioSessionPatch) => {
    setSaving(true);
    try {
      await request("creator.session.update", { agentId, sessionId, ...patch });
      setSessions(rows => applyStudioSessionPatch(rows, sessionId, patch));
      setError("");
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "creator_session_update_failed");
      return false;
    } finally { setSaving(false); }
  }, [request]);

  const flushDraft = useCallback(async (sessionId: string, value: string) => {
    if (await persistProfile(sessionId, { draft: value })) {
      setDraftOverride(current => current && current.sessionId === sessionId && current.value === value ? null : current);
    }
  }, [persistProfile]);
  // 定时器与卸载清理都要拿到最新 request 的闭包，但不能让它们成为 effect 依赖（否则每次
  // request 换身份都会重挂计时器、把一次输入拆成多次写）。
  const flushRef = useRef(flushDraft);
  useEffect(() => { flushRef.current = flushDraft; }, [flushDraft]);

  const flushPendingDraft = useCallback(() => {
    const pending = pendingDraft.current;
    pendingDraft.current = null;
    if (draftTimer.current !== null) { window.clearTimeout(draftTimer.current); draftTimer.current = null; }
    if (pending) void flushRef.current(pending.sessionId, pending.value);
  }, []);

  // 切会话或卸载时先把手上的草稿写掉，否则刚打的字会随旧会话一起消失。
  useEffect(() => flushPendingDraft, [activeSessionId, flushPendingDraft]);

  useEffect(() => {
    const current = ++generation.current;
    setSessions([]); setActiveSessionId(null); setError("");
    if (!scope || !enabled) { setLoading(false); return; }
    setLoading(true);
    void (async () => {
      let rows = await refresh();
      if (rows.length === 0) {
        ensureSession.current ??= request("creator.session.open", { agentId, ...scopePayload(scope), createNew: true, label: "创作会话 1",
          executor: "studio", transport: "studio-webview", capabilities: ["studio.webview", "preview.scene", "preview.game", "operation.review"] })
          .finally(() => { ensureSession.current = null; });
        await ensureSession.current;
        rows = await refresh();
      }
      if (current !== generation.current) return;
      const stored = readSelectedStudioSession(scopeKey);
      const active = rows.find(row => row.sessionId === stored) ?? rows[0];
      if (active) selectSession(active.sessionId);
    })().catch(cause => {
      if (current === generation.current) setError(cause instanceof Error ? cause.message : "creator_session_list_unavailable");
    }).finally(() => { if (current === generation.current) setLoading(false); });
    return () => { generation.current += 1; };
  }, [scope?.kind, scopeId, scopeKey, enabled, refresh, selectSession]);

  const createSession = async () => {
    if (!scope || creating) return null;
    setCreating(true); setError("");
    try {
      const opened = await request<{ sessionId: string }>("creator.session.open", { agentId, ...scopePayload(scope), createNew: true,
        label: nextStudioSessionLabel(sessions), executor: "studio", transport: "studio-webview",
        capabilities: ["studio.webview", "preview.scene", "preview.game", "operation.review"] });
      await refresh();
      selectSession(opened.sessionId);
      return opened.sessionId;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "creator_session_create_failed"); return null; }
    finally { setCreating(false); }
  };

  const renameSession = async (sessionId: string, label: string) => {
    const value = sessionLabelValue(label);
    if (!value) { setError("会话名称需要 1–80 个可见字符。"); return false; }
    return persistProfile(sessionId, { label: value });
  };

  /** 归档 = Host 的 close：会话行仍可恢复，只是不再占用 open 名额。 */
  const archiveSession = async (sessionId: string) => {
    setError("");
    try {
      await request("creator.session.close", { sessionId });
      const rows = await refresh();
      // 归档的不是当前会话就留在原地；只有当前会话被归档才需要换座位。
      if (sessionId !== activeSessionId) return true;
      const next = nextStudioSessionAfterArchive(rows, sessionId);
      if (next) selectSession(next);
      else await createSession();
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "creator_session_archive_failed"); return false; }
  };

  const restoreSession = async (sessionId: string) => {
    if (!scope || !enabled) return false;
    setError("");
    try {
      await request("creator.session.open", { agentId, ...scopePayload(scope), sessionId });
      await refresh();
      selectSession(sessionId);
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "creator_session_restore_failed"); return false; }
  };

  /** 首选执行器随会话存 Host：换机器/重开应用后同一个会话仍指向同一个 Agent。 */
  const savePreferredExecutor = async (executor: string) => {
    if (!activeSessionId) return;
    if ((sessions.find(row => row.sessionId === activeSessionId)?.preferredExecutor ?? "") === executor) return;
    await persistProfile(activeSessionId, { preferredExecutor: executor });
  };

  const activeSession = sessions.find(row => row.sessionId === activeSessionId) ?? null;
  const draft = draftOverride && draftOverride.sessionId === activeSessionId ? draftOverride.value : activeSession?.draft ?? "";
  const setDraft = useCallback((value: string) => {
    if (!activeSessionId) return;
    const text = value.slice(0, SESSION_DRAFT_MAX);
    setDraftOverride({ sessionId: activeSessionId, value: text });
    pendingDraft.current = { sessionId: activeSessionId, value: text };
    if (draftTimer.current !== null) window.clearTimeout(draftTimer.current);
    draftTimer.current = window.setTimeout(() => {
      draftTimer.current = null;
      const pending = pendingDraft.current;
      pendingDraft.current = null;
      if (pending) void flushRef.current(pending.sessionId, pending.value);
    }, draftDebounceMs);
  }, [activeSessionId]);

  // 旧 localStorage 草稿只在该会话 Host 草稿为空时接管一次（读走即删，避免旧值反盖新值）。
  useEffect(() => {
    if (!activeSession || activeSession.draft) return;
    const legacy = takeLegacyStudioSessionDraft(activeSession.sessionId);
    if (legacy) setDraft(legacy);
  }, [activeSession?.sessionId, activeSession?.draft, setDraft]);

  const visibleSessions = useMemo(() => filterStudioSessions(sessions, query), [sessions, query]);
  return { sessions: visibleSessions, allSessions: sessions, activeSession, activeSessionId,
    loading, creating, saving, error, query, setQuery, selectSession, createSession, refresh, draft, setDraft,
    renameSession, archiveSession, restoreSession, savePreferredExecutor };
}
