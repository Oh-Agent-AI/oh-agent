import { AuditEvidenceStore } from "./driving/audit/AuditEvidenceStore";
import { buildFinalSurfaceBoundary, finalBoundaryEvidence } from "./driving/audit/FinalSurfaceBoundary";
import { publishDrivingGraph, type ReleasedDrivingGraph } from "./driving/audit/ReleasedDrivingGraph";
import type { RoadAuditDiagnostics } from "./RoadAuditDiagnostics";
export type RoadAuditPhase = "diagnostic" | "final-replay";
export type RoadAuditPublication = Readonly<{ status:"published"; graph:ReleasedDrivingGraph }> | Readonly<{ status:"not-published"; reason:string }>;
import type { CityDrivingSnapshot } from "../engine/surface/citySurfacePort";
import { buildSurfaceIndex } from "../engine/surface/SurfaceIndex";
import { buildSurfaceRegions } from "../engine/surface/surfaceRegions";
import { continuousAuditKeyFields, passabilityWorld } from "./driving/audit/RoadPassabilityAudit";
import { auditManifestForPlan, executeAuditPlan, planRoadAudit, type AuditPlan, type PlannerInput } from "./driving/audit/RoadAuditPlanner";
import { ROUTE_PILOT_CONTROLLER_VERSION } from "./driving/audit/RoutePilot";
import type { AuditKey } from "./driving/audit/contracts";

export type RoadAuditWorkerRequest = Readonly<{ snapshot: CityDrivingSnapshot; input: Omit<PlannerInput, "worldRevision">; runId: number }>;
export type RoadAuditWorkerMessage =
  | Readonly<{ type: "progress"; phase:RoadAuditPhase; runId: number; result: ReturnType<typeof executeAuditPlan>["results"][number]; index: number; total: number }>
  | Readonly<{ type: "complete"; runId: number; report: ReturnType<typeof executeAuditPlan>; plan: AuditPlan; manifest: ReturnType<typeof auditManifestForPlan>; key: AuditKey; phase:RoadAuditPhase; publication:RoadAuditPublication; diagnostics:RoadAuditDiagnostics }>
  | Readonly<{ type: "error"; runId: number; reason: string }>;

export function runRoadAuditWorker(request: RoadAuditWorkerRequest, postMessage: (message: RoadAuditWorkerMessage) => void): void {
  const { snapshot, input, runId } = request;
  try {
    const regions = buildSurfaceRegions(snapshot.surface, buildSurfaceIndex(snapshot.surface));
    const built = passabilityWorld(snapshot, regions, () => true);
    if (built.status !== "ready") {
      postMessage({ type: "error", runId, reason: "audit-world-unresolved" });
      return;
    }
    const plan = planRoadAudit({ ...input, worldRevision: snapshot.revision });
    const key: AuditKey = Object.freeze({ baseSnapshotHash: snapshot.revision, kernelBuildId: "city-road-audit-worker-v1",
      surfaceVersion: snapshot.surface.geometryVersion, controllerVersion: ROUTE_PILOT_CONTROLLER_VERSION,
      plannerVersion: plan.plannerVersion, observerVersion: 2, manifestHash: plan.manifestHash,
      releasePolicyVersion: 1, releaseBoundaryHash: null, ...continuousAuditKeyFields() });
    const owner = {};
    let evidence:AuditEvidenceStore|null=null;
    try { evidence=new AuditEvidenceStore(key,{ owner,isCurrent:()=>true,currentKey:()=>key },{
      maxTicksPerClip:120,maxFailureClips:8,maxSummaries:512,maxBytes:2*1024*1024 }); } catch { /* recording cannot change a verdict */ }
    try {
      let phase:RoadAuditPhase = "diagnostic";
      const progress = (result:ReturnType<typeof executeAuditPlan>["results"][number],index:number,total:number) =>
        postMessage({type:"progress",runId,phase,result,index:index+1,total});
      let finalKey = key;
      let report = executeAuditPlan(built.world,plan,()=>key,{evidence:evidence?.sink(owner)??undefined,onResult:progress});
      let manifest = auditManifestForPlan(built.world,plan,key);
      let publication:RoadAuditPublication = {status:"not-published",reason:"mandatory-coverage-incomplete"};
      // Do not turn a failed road into an exclusion, or certify a green subset.
      const complete = plan.routes.length > 0 && report.results.length === plan.routes.length &&
        report.results.every((result)=>result.verdict==="passed" && result.cause==="none");
      if (complete && plan.exclusions.length) publication={status:"not-published",reason:"excluded-units-require-physical-closure"};
      if (complete && !plan.exclusions.length) {
        const boundary = buildFinalSurfaceBoundary(built.world);
        if (!boundary) publication={status:"not-published",reason:"final-boundary-unavailable"};
        else {
          phase="final-replay";
          finalKey=Object.freeze({...key,releaseBoundaryHash:boundary.hash});
          report=executeAuditPlan(built.world,plan,()=>finalKey,{finalBoundary:boundary,
            evidence:evidence?.variantSink(owner,finalKey,"boundary-replay",null)??undefined,onResult:progress});
          manifest=auditManifestForPlan(built.world,plan,finalKey);
          if (!report.release.ready) publication={status:"not-published",reason:report.release.reasons[0]??"final-replay-incomplete"};
          else {
            const proof=finalBoundaryEvidence(boundary,built.world,manifest);
            const published=proof ? publishDrivingGraph(manifest,report.release,proof) : {ok:false as const,reason:"boundary-evidence-unavailable"};
            publication=published.ok ? {status:"published",graph:published.graph} : {status:"not-published",reason:published.reason};
          }
        }
      }
      const summaries=evidence?.summaries(owner)??[];
      const clips:RoadAuditDiagnostics["clips"][number][]=[];
      let clipBytes=0;
      for (const row of summaries) {
        if (!row.evidence) continue;
        const clip=evidence?.read(owner,row.evidence);
        if (!clip) continue;
        const size=JSON.stringify(clip).length*2;
        if (clipBytes+size>512*1024 || clips.length>=4) continue;
        clips.push({caseId:row.caseId,clip}); clipBytes+=size;
      }
      const stats=evidence?.stats(owner);
      const diagnostics:RoadAuditDiagnostics={summaries,clips,truncated:!evidence || !!stats &&
        (stats.droppedCaptures>0 || stats.evictedClips>0 || stats.evictedSummaries>0) || summaries.length>=512 ||
        summaries.some((row)=>row.truncated || row.evidenceStatus==="evicted") || summaries.filter((row)=>row.evidence).length>clips.length};
      postMessage({type:"complete",runId,report,plan,manifest,key:finalKey,phase,publication,diagnostics});
    } finally { evidence?.dispose(owner); }

  } catch (error) {
    void error;
    postMessage({ type: "error", runId, reason: "audit-worker-failed" });
  }
}

// Guarding this registration keeps importing the pure worker entry in Node-based
// contract tests free of DOM/self side effects.
if (typeof self !== "undefined") self.onmessage = (event: MessageEvent<RoadAuditWorkerRequest>) =>
  runRoadAuditWorker(event.data, (message) => self.postMessage(message));
