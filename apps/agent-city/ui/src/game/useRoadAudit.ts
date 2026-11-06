import { bindDrivingGraph } from "./driving/audit/ReleasedDrivingGraph";
import { loadRoadAuditHistory, makeRoadAuditHistory, makeInterruptedAuditHistory, saveRoadAuditHistory } from "./RoadAuditHistory";
import type { RoadAuditDiagnostics } from "./RoadAuditDiagnostics";
import type { RoadAuditPhase, RoadAuditPublication } from "./RoadAuditWorker";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CityEngine } from "../engine/CityEngine";
import type { ReadyCitySurfaceCapture } from "../engine/surface/citySurfacePort";
import type { AuditKey } from "./driving/audit/contracts";
import type { AuditPlan, AuditPlanReport } from "./driving/audit/RoadAuditPlanner";
import type { AuditManifest } from "./driving/audit/contracts";
import type { PassabilityResult } from "./driving/audit/RoadPassabilityAudit";
import type { PublishedDrivingGraph } from "./driving/audit/ReleasedDrivingGraph";
import type { RoadAuditWorkerMessage } from "./RoadAuditWorker";
import { auditMustInvalidate, clearOwnedCaptureResources, RoadAuditRunLock } from "./RoadAuditLifecycle";

export type RoadAuditStatus = "not-run" | "capturing" | "running" | "complete" | "stale" | "cancelled" | "error";
export type RoadAuditSnapshot = Readonly<{
  phase:RoadAuditPhase; publication:RoadAuditPublication|null; diagnostics:RoadAuditDiagnostics|null;
  status: RoadAuditStatus; results: readonly PassabilityResult[]; completed: number; total: number;
  report: AuditPlanReport | null; plan: AuditPlan | null; manifest: AuditManifest | null; key: AuditKey | null;
  reason: string | null; capture: ReadyCitySurfaceCapture | null; publishedGraph: PublishedDrivingGraph | null;
}>;
type WorldCapture = Extract<Awaited<ReturnType<CityEngine["captureDrivingWorld"]>>, { status: "ready" }>;
const MAX_AUDIT_MS = 5 * 60_000;

/** Bounded local audit runner. Heavy planning and simulation run in a worker;
 * terminating that worker is the cancellation primitive. A run retains its
 * frozen-world lease only while results are being inspected or consumed. */
export function useRoadAudit(engineRef: React.RefObject<CityEngine | null>, enabled: boolean) {
  const [snapshot, setSnapshot] = useState<RoadAuditSnapshot>({ phase:"diagnostic",publication:null,diagnostics:null,status: "not-run", results: [], completed: 0, total: 0,
    report: null, plan: null, manifest: null, key: null, reason: null, capture: null, publishedGraph: null });
  const [history,setHistory]=useState(loadRoadAuditHistory);
  const [historySaved,setHistorySaved]=useState(true);
  const snapshotRef=useRef(snapshot); snapshotRef.current=snapshot;
  const workerRef = useRef<Worker | null>(null);
  const captureRef = useRef<WorldCapture | null>(null);
  const captureAbortRef = useRef<AbortController | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const freshnessRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lifecycleRef = useRef(new RoadAuditRunLock());
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const releaseCapture = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    if (freshnessRef.current) clearInterval(freshnessRef.current);
    timeoutRef.current = null; freshnessRef.current = null;
    captureAbortRef.current?.abort(); captureAbortRef.current = null;
    captureRef.current?.release(); captureRef.current = null;
    workerRef.current?.terminate(); workerRef.current = null;
  }, []);
  const recordInterrupted=useCallback((reason:string)=>{
    if(!lifecycleRef.current.active)return;
    const current=snapshotRef.current;
    const entry=makeInterruptedAuditHistory(captureRef.current?.worldRevision??"capture-pending",current.phase,current.results,current.total,reason);
    const saved=saveRoadAuditHistory(entry);
    setHistory(saved?loadRoadAuditHistory():[entry]); setHistorySaved(saved);
  },[]);
  const cancel = useCallback((status: "cancelled" | "stale" = "cancelled", reason = "") => {
    recordInterrupted(reason||status);
    lifecycleRef.current.invalidate();
    releaseCapture();
    setSnapshot((old) => status === "stale"
      ? { phase:"diagnostic",publication:null,diagnostics:null,status, results: [], completed: 0, total: 0, report: null, plan: null, manifest: null, key: null, reason: reason || null, capture: null, publishedGraph: null }
      : { ...old, status, reason: reason || null, publication:null,diagnostics:null,capture: null, publishedGraph: null });
  }, [releaseCapture, recordInterrupted]);

  const run = useCallback(async () => {
    if (!engineRef.current) return;
    const runId = lifecycleRef.current.begin(enabledRef.current);
    if (runId === null) return;
    releaseCapture();
    setSnapshot({ phase:"diagnostic",publication:null,diagnostics:null,status: "capturing", results: [], completed: 0, total: 0, report: null, plan: null, manifest: null, key: null, reason: null, capture: null, publishedGraph: null });
    let captured: Awaited<ReturnType<CityEngine["captureDrivingWorld"]>>;
    const captureAbort = new AbortController();
    captureAbortRef.current = captureAbort;
    const captureTimeout = setTimeout(() => {
      if (lifecycleRef.current.isCurrent(runId)) cancel("cancelled", "audit-time-limit");
    }, MAX_AUDIT_MS);
    timeoutRef.current = captureTimeout;
    try { captured = await engineRef.current.captureDrivingWorld(captureAbort.signal); }
    catch {
      if (!clearOwnedCaptureResources(lifecycleRef.current.isCurrent(runId), timeoutRef, captureAbortRef, captureTimeout, captureAbort, clearTimeout)) return;
      recordInterrupted("capture-failed");
      if (lifecycleRef.current.finish(runId)) setSnapshot((old) => ({ ...old, status: "error", reason: "capture-failed" }));
      return;
    }
    if (!lifecycleRef.current.isCurrent(runId)) { if (captured.status === "ready") captured.release(); return; }
    clearOwnedCaptureResources(true, timeoutRef, captureAbortRef, captureTimeout, captureAbort, clearTimeout);
    if (captured.status !== "ready") { recordInterrupted(`capture-${captured.status}`); lifecycleRef.current.finish(runId); setSnapshot((old) => ({ ...old, status: "error", reason: `capture-${captured.status}` })); return; }
    captureRef.current = captured;
    const snapshot = captured.readWorld();
    const layout = engineRef.current?.currentLayout;
    if (!snapshot || !layout || !captured.isLeaseCurrent()) { recordInterrupted("capture-stale"); captured.release(); captureRef.current = null; lifecycleRef.current.finish(runId); setSnapshot((old) => ({ ...old, status: "stale", reason: "capture-stale" })); return; }
    const structurePaths: Record<string, readonly { x: number; z: number }[]> = {};
    layout.highways?.forEach((points, index) => { structurePaths[`expressway:${index}`] = points; });
    layout.highwayRamps?.forEach((ramp, index) => { structurePaths[`ramp:${index}`] = ramp.points; });
    let worker: Worker;
    try { worker = new Worker(new URL("./RoadAuditWorker.ts", import.meta.url), { type: "module" }); }
    catch { recordInterrupted("worker-unavailable"); captured.release(); captureRef.current = null; lifecycleRef.current.finish(runId); setSnapshot((old) => ({ ...old, status: "error", reason: "worker-unavailable" })); return; }
    workerRef.current = worker;
    setSnapshot((old) => ({ ...old, status: "running", capture: captured }));
    const workerTimeout = setTimeout(() => {
      if (lifecycleRef.current.isCurrent(runId)) cancel("cancelled", "audit-time-limit");
    }, MAX_AUDIT_MS);
    timeoutRef.current = workerTimeout;
    const freshness = setInterval(() => {
      if (lifecycleRef.current.sameGeneration(runId) && captureRef.current === captured && !captured.isLeaseCurrent())
        cancel("stale", "world-revision-changed");
    }, 500);
    freshnessRef.current = freshness;
    worker.onmessage = (event: MessageEvent<RoadAuditWorkerMessage>) => {
      const message = event.data;
      if (message.runId !== runId || !lifecycleRef.current.isCurrent(runId)) return;
      if (message.type === "progress") {
        if (!captured.isLeaseCurrent()) { cancel("stale", "world-revision-changed"); return; }
        setSnapshot((old) => old.status === "running" ? { ...old, phase:message.phase,results: old.phase === message.phase ? [...old.results,message.result] : [message.result], completed: message.index, total: message.total } : old);
      } else if (message.type === "complete") {
        if (!captured.isLeaseCurrent()) { cancel("stale", "world-revision-changed"); return; }
        let verified = false;
        try { verified = captured.verifyCurrent(); } catch { /* A failed deep check invalidates the result. */ }
        if (!captured.isLeaseCurrent() || !verified) { cancel("stale", "world-revision-changed"); return; }
        if (timeoutRef.current === workerTimeout) { clearTimeout(workerTimeout); timeoutRef.current = null; }
        worker.terminate(); workerRef.current = null;
        lifecycleRef.current.finish(runId);
        const graph=message.publication.status==="published" ? bindDrivingGraph(message.publication.graph,{
          isCurrent:()=>captured.isLeaseCurrent(),currentKey:()=>message.key }) : null;
        const archive=makeRoadAuditHistory(message.report,message.publication,message.phase,message.diagnostics);
        const saved=saveRoadAuditHistory(archive);
        setHistory(saved ? loadRoadAuditHistory() : [archive]);
        setHistorySaved(saved);
        setSnapshot((old) => ({ ...old, status: "complete", phase:message.phase,publication:message.publication,diagnostics:message.diagnostics,
          publishedGraph:graph?.isCurrent() ? graph : null, report: message.report, plan: message.plan, manifest: message.manifest, key: message.key,
          completed: message.report.results.length, total: message.plan.routes.length, capture: captured }));
      } else {
        recordInterrupted(message.reason);
        releaseCapture();
        lifecycleRef.current.finish(runId);
        setSnapshot((old) => ({ ...old, status: "error", reason: message.reason, capture: null }));
      }
    };
    worker.onerror = () => { if (lifecycleRef.current.isCurrent(runId)) cancel("cancelled", "audit-worker-failed"); };
    try {
      const request = structuredClone({ runId, snapshot, input: { roadEdges: layout.roadEdges, landings: snapshot.landings, structurePaths } });
      worker.postMessage(request);
    } catch {
      recordInterrupted("snapshot-not-cloneable");
      releaseCapture();
      lifecycleRef.current.finish(runId);
      setSnapshot((old) => ({ ...old, status: "error", reason: "snapshot-not-cloneable", capture: null }));
    }
  }, [cancel, engineRef, releaseCapture, recordInterrupted]);

  useEffect(() => {
    if (auditMustInvalidate(enabled, lifecycleRef.current.active, !!captureRef.current)) cancel("stale", "audit-disabled");
  }, [enabled, cancel, releaseCapture]);
  useEffect(() => () => { lifecycleRef.current.invalidate(); releaseCapture(); }, [releaseCapture]);
  return { snapshot, run, cancel, history, historySaved } as const;
}
