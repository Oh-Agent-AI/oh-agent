import { RoadAuditHistoryPanel } from "./RoadAuditHistoryPanel";
import type { RoadAuditHistoryEntry } from "../RoadAuditHistory";
import { useState } from "react";
import type { CityEngine } from "../../engine/CityEngine";
import type { RoadAuditSnapshot } from "../useRoadAudit";
import { buildRoadAuditViewRows } from "../RoadAuditView";

export function RoadAuditPanel({ snapshot, run, cancel, engineRef, locale, canRun, close, history, historySaved }: {
  snapshot: RoadAuditSnapshot; run: () => void; cancel: () => void;
  engineRef: React.RefObject<CityEngine | null>; locale: "en" | "zh-Hans"; canRun: boolean; close: () => void;
  history:readonly RoadAuditHistoryEntry[]; historySaved:boolean;
}) {
  const [visibleCount, setVisibleCount] = useState(60);
  const en = locale === "en";
  const rows = snapshot.plan ? buildRoadAuditViewRows(snapshot.plan, snapshot.results) : [];
  const locate = (id: string) => {
    if (!snapshot.capture?.isLeaseCurrent()) return;
    const point = rows.find((row) => row.id === id)?.location;
    if (point) engineRef.current?.focusPoint(point.x, point.z);
  };
  const statusText = snapshot.status === "not-run" ? (en ? "Not run" : "未运行")
    : snapshot.status === "capturing" ? (en ? "Freezing displayed city…" : "正在冻结当前城市…")
      : snapshot.status === "running" ? (en ? `${snapshot.phase === "final-replay" ? "Final replay" : "Diagnostic run"} ${snapshot.completed}/${snapshot.total || "…"}` : `${snapshot.phase === "final-replay" ? "最终边界复跑" : "诊断试跑"} ${snapshot.completed}/${snapshot.total || "…"}`)
        : snapshot.status === "complete" ? (snapshot.publishedGraph?.isCurrent() ? (en ? "Strict audit graph published" : "严格审计图已发布") : (en ? "Diagnostics complete; not published" : "诊断完成，未发布"))
          : snapshot.status === "stale" ? (en ? "Snapshot changed; results discarded" : "城市快照已变化，结果失效")
            : snapshot.status === "cancelled" ? (en ? "Cancelled" : "已取消")
              : (en ? `Unavailable: ${snapshot.reason ?? "audit failed"}` : `不可用：${snapshot.reason ?? "审计失败"}`);
  return <aside className="city-road-audit" aria-label={en ? "Road audit" : "道路审计"}
    style={{ position: "absolute", zIndex: 10, top: 82, right: 16, width: "min(360px, calc(100% - 32px))",
      maxHeight: "calc(100% - 98px)", overflowY: "auto", padding: 12, border: "1px solid #45617f",
      borderRadius: 10, color: "#edf3fc", background: "rgba(12, 22, 36, 0.94)", backdropFilter: "blur(10px)" }}>
    <header><strong>{en ? "Local road audit" : "本地道路审计"}</strong><span role="status">{statusText}</span></header>
    <div className="city-road-audit-actions">
      <button type="button" onClick={close}>{en ? "Close" : "关闭"}</button>
      <button type="button" disabled={!canRun || snapshot.status === "running" || snapshot.status === "capturing"} onClick={run}>{en ? "Run audit" : "运行审计"}</button>
      {(snapshot.status === "running" || snapshot.status === "capturing") && <button type="button" onClick={cancel}>{en ? "Cancel" : "取消"}</button>}
      {(snapshot.status === "running" || snapshot.status === "complete") && <button type="button" onClick={cancel}>{en ? "Release snapshot" : "释放快照"}</button>}
    </div>
    {snapshot.status === "complete" && snapshot.publication?.status === "not-published" && <p role="status">{en?"Publication refused":"发布未通过"}：{snapshot.publication.reason}</p>}
    <RoadAuditHistoryPanel entries={history} saved={historySaved} capture={snapshot.capture} engineRef={engineRef} en={en} />
    {snapshot.report && <>
      <p>{snapshot.report.summary}</p>
      <p className="city-road-audit-note">{en ? "Results apply only to this frozen snapshot and the strict audit policy. Gameplay uses a different policy; this panel never grants gameplay admission." : "结果仅适用于当前冻结快照与严格审计策略。游玩策略不同，本面板不会授予正式驾驶准入。"}</p>
      {(() => {
        const ranked = [...rows].sort((a, b) => {
          const rank = (status: string) => status === "blocked" ? 0 : status === "inconclusive" ? 1 : status === "excluded" ? 2 : 3;
          return rank(a.status) - rank(b.status) || a.id.localeCompare(b.id);
        });
        const counts = { passed: 0, blocked: 0, inconclusive: 0, excluded: 0 };
        for (const row of rows) counts[row.status] += 1;
        return <>
          <p>{en ? `Passed ${counts.passed} · blocked ${counts.blocked} · no conclusion ${counts.inconclusive} · excluded ${counts.excluded}` : `通过 ${counts.passed} · 阻塞 ${counts.blocked} · 无结论 ${counts.inconclusive} · 排除 ${counts.excluded}`}</p>
          {ranked.slice(0, visibleCount).map((row) => {
        const result = row.result;
        const verdict = row.status;
        const label = verdict === "passed" ? (en ? "Passed" : "通过") : verdict === "blocked" ? (en ? "Blocked" : "阻塞") : verdict === "excluded" ? (en ? "Excluded" : "排除") : (en ? "No conclusion" : "无结论");
        return <details key={row.id} className={`city-road-audit-case is-${verdict}`}>
          <summary><span>{label}</span><code>{row.id}</code><small>{result?.cause ?? row.reason}</small></summary>
          <p>{row.reason}</p>
          {result && <>{result.witness?.kind === "cut" && <p>{en ? "Blocking cut" : "阻断截面"} · {result.witness.layerId} · {result.witness.widest.toFixed(2)} / {result.witness.required.toFixed(2)}</p>}
            {result.witness?.kind === "topology" && <p>{en ? "Disconnected regions" : "不连通区域"} · {result.witness.startRegion} → {result.witness.exitRegion}</p>}
            {result.run?.diagnostic && <p>{result.run.diagnostic.stage}: {result.run.diagnostic.reason} · tick {result.run.diagnostic.tick}</p>}</>}
          {verdict !== "passed" && verdict !== "excluded" && <button type="button" disabled={!snapshot.capture?.isLeaseCurrent()} onClick={() => locate(row.id)}>{en ? "Locate on map" : "在地图中定位"}</button>}
        </details>;
          })}
          {ranked.length > visibleCount && <button type="button" onClick={() => setVisibleCount((count) => count + 60)}>{en ? `Show 60 more (${ranked.length - visibleCount} left)` : `再显示 60 项（剩余 ${ranked.length - visibleCount}）`}</button>}
        </>;
      })()}
    </>}
  </aside>;
}
