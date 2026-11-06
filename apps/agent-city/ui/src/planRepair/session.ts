/**
 * 规划修复会话（docs/CITY_PLAN_MANUAL_REPAIR_SPEC.md §13）：把补丁层接到 CityEngine 与存档。
 *
 * 编辑 UI（planRepair/PlanRepairPanel + controller）与开发控制台入口（`window.__cityPlan`）共用这个会话：
 * 校验 → 写补丁 → 引擎重建 → 存档。道路编辑一律先过 planRoadRules 的硬规则，再追加一条道路日志。
 * 开关：已于 2026-10-14 移除（原 `?cityPlan` / `cityPlanDev=1`），修复规划默认开启：
 * 存档始终读取，补丁随会话生效；没有补丁时引擎的 planPatch 为空，地图与未编辑时逐字节一致。
 */
import { roadWidthFor } from "../engine/roadStandard";
import type { CityEngine } from "../engine/CityEngine";
import { auditLayout, tagAuditOrigins, type PlanIssue } from "../engine/planAudit";
import { surfaceHoles, testDrive } from "./testDrive";
import { proposeBridgeFix, type BridgeFixProposal, type BridgeFixResult } from "../engine/planBridgeFix";
import type { DriveReport } from "./controller";
import { appendHighwayOp, appendRoadOp, appendSiteOp, applyPlanPatch, bridgeChain, bridgeChainPolyline, buildingRect, edgeLocked, emptyPlanPatch, filletAt, hashPlanPatch, highwayCutWindow, highwayHit, patchGeneratorVersion, patchMatchesLayout, planPatchEmpty, pruneStalePatch, validateBuildingMove, VIADUCT_DECK_WIDTH, type PlanPatchV1, type RoadOp } from "../engine/planPatch";
import { autoPlaceFree, formatFreeTarget, listSites, parseFreeTarget, pickSite, siteBox, siteClassOf, siteMoveProblem, siteTargets, type SiteInfo, type SiteTarget } from "../engine/planSites";
import { accessRoadFor, siteTouchesRoad, strandedAccessEdges } from "../engine/planAccess";
import { worldBox, worldOverhead, worldParts } from "../engine/planFootprint";
import { curvePoints } from "../engine/planGeometry";

const quantizePoint = (p: Vec2): Vec2 => ({ x: Math.round(p.x * 100) / 100, z: Math.round(p.z * 100) / 100 });
import { remapPlanPatch, type RemapReport } from "../engine/planRemap";
import type { RepairRay } from "../engine/CityEngine";
import { bulldozeForRoads } from "../engine/planBulldozer";
import { nearestEdgeAt, roadRun, snapPoint, validateEdgeDrop, validateHighwayAdd, validateHighwayCut, validateNodeMove, validateRestyle, validateRoadAdd, type RoadVerdict, type SnapPoint } from "../engine/planRoadRules";
import type { CityLayout, Parcel, Vec2 } from "../engine/cityLayout";
import { cityPlanPatchStore, emptyPlanPatchStore, type PlanPatchStoreV1 } from "../data/planPatch";

/** 修复规划默认开启（2026-10-14 起去掉 ?cityPlan / cityPlanDev=1 开发开关）：城市设置里始终有入口，
 *  存档始终读取，引擎里 planPatch 随会话生效。函数保留是为了让 hook 的单一判断点不变。 */
export function planDevEnabled(): boolean {
  return true;
}

export type RepairCandidate = { parcelId: string; x: number; z: number; yaw: number; width: number; depth: number; distance: number; warnings: string[] };

export type EditResult = { ok: true; patch: PlanPatchV1; warnings: string[] } | { ok: false; reason: string; blockers?: string[] };
/** 设施搬家后 id 可能变（背景楼的 id 由地块决定），成功时带回新 id 供编辑器重新选中。 */
export type SiteEditResult = EditResult & { siteId?: string; strandedEdges?: string[] };

/** 平面矩形（叠加层画标记用）。round：圆形占地（自由级设施），按外接圆画。 */
/** shape：有真实占地的自由级设施的两层投影（世界坐标；overhead 以 ground 开头，见 planFootprint）。 */
export type PlanRect = { x: number; z: number; yaw: number; width: number; depth: number; round?: boolean;
  shape?: { ground: Vec2[][]; overhead: Vec2[][] } };
/** 设施在 (at, yaw) 处的标记矩形：有真实占地带多边形，名义圆标 round。 */
export function siteMarkRect(site: SiteInfo, at: Vec2 = site, yaw = site.yaw): PlanRect {
  const footprint = site.footprint;
  if (!footprint) return site.level === "free" ? { x: at.x, z: at.z, yaw, width: site.width, depth: site.depth, round: true } : { ...siteBox(site) };
  const box = worldBox(footprint, at, yaw);
  if (!footprint.exact) return { ...box, round: true };
  return { ...box, shape: { ground: worldParts(footprint, at, yaw).map((p) => [...p]), overhead: worldOverhead(footprint, at, yaw).map((p) => [...p]) } };
}
/** 道路编辑的确切后果（推土机试算，和确认后实际发生的一致）。 */
export type ImpactPreview = { bulldozed: PlanRect[]; relocated: Array<{ from: PlanRect; to: PlanRect }>; homeless: PlanRect[] };
/** path：这一笔实际会铺成的折线（起点是路尽头且拐弯时带倒圆弧，SPEC §17.3）；预览按它画。 */
export type RoadPreview = RoadVerdict & { impact?: ImpactPreview; path?: Vec2[]; /** 推平/安置计数是估计（未跑推土机试算）。 */ estimate?: boolean };
export type RoadPurpose = "waterfront";
/** 选中建筑后悬停的落位试算：目标占地 + 能不能放。 */
export type PlacementGhost = { targetId: string; rect: PlanRect; blockers: string[]; warnings: string[] };
/** 路口工具点选的路口：位置与关联路段（预览时把朝向它的一端换成鼠标位置）。 */
export type NodeHandle = { id: string; x: number; z: number; locked: boolean; edges: Array<{ points: Vec2[]; width: number; atStart: boolean }> };

const UNDO_LIMIT = 100;
const SAVE_DEBOUNCE_MS = 400;

export class PlanRepairSession {
  private store: PlanPatchStoreV1 = emptyPlanPatchStore();
  private loaded = false;
  private undoStack: Array<PlanPatchV1 | null> = [];
  private redoStack: Array<PlanPatchV1 | null> = [];
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private saveFailed = false;
  private savePending = false;
  /** 存档写完（成功或失败）后回调：面板据此把「保存中」换成「已保存 / 仅临时」。 */
  onSaveSettled: (() => void) | null = null;
  private loadTicket = 0;
  private dryRunMemo: { key: string; preview: RoadPreview } | null = null;
  /** 最近一次跨档重定位的报告（面板横幅读它；用户点「知道了」清掉）。 */
  private lastRemap: RemapReport | null = null;

  constructor(private readonly engine: CityEngine) {}

  /** 读存档并把该种子的补丁交给引擎。存档读不到/损坏 → 空库（诚实降级，不抛）。 */
  async load(seed: number): Promise<void> {
    // 序号守卫：初始种子与存档种子会连发两次 load，读存档是异步的，乱序返回时旧的不能覆盖新的。
    const ticket = ++this.loadTicket;
    let store: PlanPatchStoreV1;
    try { store = (await cityPlanPatchStore("read")) ?? emptyPlanPatchStore(); } catch { store = emptyPlanPatchStore(); }
    if (ticket !== this.loadTicket) return;
    this.store = store;
    this.loaded = true;
    this.undoStack = []; this.redoStack = [];
    this.engine.setPlanPatch(this.store.patches[String(seed)] ?? null);
  }

  private get seed(): number | null {
    return this.engine.currentLayout?.seed ?? null;
  }

  /** 当前补丁；没有则按当前档位建一份空的。档位对不上（城市已扩容）→ 不静默覆盖旧补丁，要求先 reset。 */
  private working(): { ok: true; patch: PlanPatchV1 } | { ok: false; reason: string } {
    const layout = this.engine.currentLayout;
    if (!layout || !this.engine.currentModel) return { ok: false, reason: "city-not-ready" };
    const existing = this.engine.planPatch;
    // 岛半径随补丁记下（跨档重定位的缩放比，路线图 SPEC P0-2）；旧补丁在同档的下一次编辑时补上。
    if (!existing) return { ok: true, patch: { ...emptyPlanPatch(layout.seed, layout.scaleTier), islandRadius: layout.islandRadius } };
    if (existing.scaleTier !== layout.scaleTier) return { ok: false, reason: `patch-tier-${existing.scaleTier}-vs-city-tier-${layout.scaleTier}: reset() first` };
    // 生成器换代同理：旧补丁的 id 指向上一版地图，在它上面追加新操作会混出两代 id，不静默覆盖。
    if (!patchMatchesLayout(existing, layout.scaleTier)) return { ok: false, reason: `patch-generator-${patchGeneratorVersion(existing)}-vs-city-generator: reset() first` };
    return { ok: true, patch: existing.islandRadius ? existing : { ...existing, islandRadius: layout.islandRadius } };
  }

  private commit(next: PlanPatchV1 | null): void {
    this.undoStack.push(this.engine.planPatch);
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.apply(next);
  }

  private apply(next: PlanPatchV1 | null): void {
    const patch = !next || planPatchEmpty(next) ? null : next;
    this.engine.setPlanPatch(patch);
    const seed = this.seed;
    if (seed === null) return;
    if (patch) this.store.patches[String(seed)] = patch; else delete this.store.patches[String(seed)];
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (!this.loaded) return; // 没读过存档就写会覆盖其它种子的补丁
    clearTimeout(this.saveTimer);
    this.savePending = true;
    this.saveTimer = setTimeout(() => {
      this.savePending = true;
      void cityPlanPatchStore("write", this.store).then((result) => { this.saveFailed = result === null; }).catch(() => { this.saveFailed = true; })
        .finally(() => { this.savePending = false; this.onSaveSettled?.(); });
    }, SAVE_DEBOUNCE_MS);
  }

  /** 搬一栋会话楼到另一个地块。硬阻止（压路/重叠/被占/坡地/不可建/高架）直接拒绝并给出原因。 */
  moveBuilding(buildingId: string, parcelId: string): EditResult {
    const base = this.working();
    if (!base.ok) return base;
    const layout = this.engine.currentLayout!; const model = this.engine.currentModel!;
    const verdict = validateBuildingMove(layout, model, base.patch, buildingId, parcelId);
    if (verdict.blockers.length) return { ok: false, reason: "blocked", blockers: verdict.blockers };
    const target = this.nearestParcelById(parcelId);
    const patch = { ...base.patch, updatedAt: Date.now(), buildingMoves: { ...base.patch.buildingMoves, [buildingId]: parcelId },
      ...(target ? { moveAnchors: { ...base.patch.moveAnchors, [buildingId]: { x: target.x, z: target.z } } } : {}) };
    this.commit(patch);
    return { ok: true, patch, warnings: verdict.warnings };
  }

  /** 拖一个路口（传当前 id，即屏幕上看到的）。先过硬规则：锁定/撞车/过短/入水/穿楼/锐角。 */
  moveNode(nodeId: string, x: number, z: number): EditResult {
    const base = this.working();
    if (!base.ok) return base;
    const verdict = this.surfaceVerdict({ t: "move", node: nodeId, to: { x, z } }, validateNodeMove(this.engine.currentLayout!, this.engine.currentModel!, nodeId, { x, z }), true);
    if (verdict.blockers.length) return { ok: false, reason: "blocked", blockers: verdict.blockers };
    const node = this.engine.currentLayout!.roadNodes.find((candidate) => candidate.id === nodeId);
    return this.commitWithBulldozer(appendRoadOp(base.patch, { t: "move", node: nodeId, to: { x, z }, ...(node ? { anchor: { x: node.x, z: node.z } } : {}) }), verdict.warnings);
  }

  /** 橡皮擦：删一段路（传当前 id）。 */
  dropEdge(edgeId: string): EditResult {
    const base = this.working();
    if (!base.ok) return base;
    const verdict = validateEdgeDrop(this.engine.currentLayout!, this.engine.currentModel!, edgeId);
    if (verdict.blockers.length) return { ok: false, reason: "blocked", blockers: verdict.blockers };
    const patch = appendRoadOp(base.patch, { t: "drop", edge: edgeId, ...this.edgeAnchor(edgeId) });
    this.commit(patch);
    return { ok: true, patch, warnings: verdict.warnings };
  }

  /** 改路型（路线图 P1-4）：一整段路（roadRun）改成目标路型，一步写入、一步撤销；变宽压到的楼走推土机。 */
  restyleRoad(edgeId: string, width: number, purpose?: RoadPurpose): EditResult {
    const base = this.working();
    if (!base.ok) return base;
    const layout = this.engine.currentLayout!;
    const run = roadRun(layout, edgeId);
    const verdict = validateRestyle(layout, this.engine.currentModel!, run, width, purpose);
    if (verdict.blockers.length) return { ok: false, reason: "blocked", blockers: verdict.blockers };
    return this.commitWithBulldozer(this.restyleOps(base.patch, run, width, purpose), verdict.warnings);
  }

  /** 改路型的悬停预览：整段路的折线 + 校验（变宽时停住后跑推土机试算）。 */
  restyleAt(x: number, z: number, width: number, purpose?: RoadPurpose, exact = true): { edges: Array<{ points: Vec2[]; width: number }>; verdict: RoadPreview } | null {
    const layout = this.engine.currentLayout; const model = this.engine.currentModel;
    const hit = this.edgeAt(x, z);
    if (!layout || !model || !hit) return null;
    const run = roadRun(layout, hit.id);
    const byId = new Map(layout.roadEdges.map((edge) => [edge.id, edge]));
    const edges = run.map((id) => byId.get(id)!).map((edge) => ({ points: edge.points, width: Math.max(edge.width, width) }));
    if (hit.locked) return { edges: [{ points: hit.points, width: hit.width }], verdict: { blockers: ["locked-edge"], warnings: [] } };
    const verdict = validateRestyle(layout, model, run, width, purpose);
    const widens = run.some((id) => (byId.get(id)?.width ?? width) < width);
    return { edges, verdict: widens ? this.dryRun(`restyle:${run.join(",")}:${width}:${purpose ?? ""}`, (patch) => this.restyleOps(patch, run, width, purpose), verdict, exact) : verdict };
  }

  private restyleOps(patch: PlanPatchV1, run: readonly string[], width: number, purpose?: RoadPurpose): PlanPatchV1 {
    return run.reduce((next, edge) => appendRoadOp(next, { t: "restyle", edge, width, ...(purpose ? { purpose } : {}), ...this.edgeAnchor(edge) }), patch);
  }

  /** 画路：from/to 是已吸附的坐标（snap() 的结果）。端点落在路段中间会把该路段拆成两半。purpose=waterfront 为滨海大道。 */
  addRoad(from: Vec2, to: Vec2, width: number, purpose?: RoadPurpose, via?: Vec2): EditResult {
    const base = this.working();
    if (!base.ok) return base;
    const bend = via ? quantizePoint(via) : undefined;
    const op: RoadOp = { t: "add", from, to, width, ...(purpose ? { purpose } : {}), ...(bend ? { via: bend } : {}) };
    const verdict = this.surfaceVerdict(op, validateRoadAdd(this.engine.currentLayout!, this.engine.currentModel!, from, to, width, purpose, [], bend), true);
    if (verdict.blockers.length) return { ok: false, reason: "blocked", blockers: verdict.blockers };
    return this.commitWithBulldozer(appendRoadOp(base.patch, op), verdict.warnings);
  }

  // ── 高架（SPEC §17.2）──

  /** 画一条高架（逐点折线）。首/尾点落在已有高架开口端附近会接上去。 */
  addHighway(points: readonly Vec2[]): EditResult {
    const base = this.working();
    if (!base.ok) return base;
    const verdict = validateHighwayAdd(this.engine.currentLayout!, this.engine.currentModel!, points);
    if (verdict.blockers.length) return { ok: false, reason: "blocked", blockers: verdict.blockers };
    return this.commitWithBulldozer(appendHighwayOp(base.patch, { t: "add", points: [...points] }), verdict.warnings);
  }

  validateHighway(points: readonly Vec2[], exact = true): RoadPreview {
    const layout = this.engine.currentLayout; const model = this.engine.currentModel;
    if (!layout || !model) return { blockers: ["city-not-ready"], warnings: [] };
    const verdict = validateHighwayAdd(layout, model, points);
    return this.dryRun(`viaduct:${JSON.stringify(points)}`, (patch) => appendHighwayOp(patch, { t: "add", points: [...points] }), verdict, exact);
  }

  /** 橡皮擦下的高架：切掉的那一截（两端点）与桥面宽。 */
  highwayAt(x: number, z: number): { points: Vec2[]; width: number } | null {
    const layout = this.engine.currentLayout;
    const hit = layout ? highwayHit(layout.highways ?? [], { x, z }) : null;
    if (!layout || !hit) return null;
    const cut = highwayCutWindow(layout.highways[hit.run], hit.segment, { x, z });
    return { points: [cut.from, cut.to], width: VIADUCT_DECK_WIDTH };
  }

  /** 橡皮擦切高架：一条断成两条，断口各自落地成匝道。 */
  cutHighway(x: number, z: number): EditResult {
    const base = this.working();
    if (!base.ok) return base;
    const verdict = validateHighwayCut(this.engine.currentLayout!, { x, z });
    if (verdict.blockers.length) return { ok: false, reason: "blocked", blockers: verdict.blockers };
    const patch = appendHighwayOp(base.patch, { t: "cut", at: { x: Math.round(x * 100) / 100, z: Math.round(z * 100) / 100 } });
    this.commit(patch);
    return { ok: true, patch, warnings: verdict.warnings };
  }

  /** 已有高架开口端（画高架时起点/终点吸附上去接续）。 */
  highwayEndAt(x: number, z: number, radius = 12): Vec2 | null {
    let best: { p: Vec2; d: number } | null = null;
    for (const run of this.engine.currentLayout?.highways ?? []) {
      if (run.length < 2 || (run.length > 2 && Math.hypot(run[0].x - run[run.length - 1].x, run[0].z - run[run.length - 1].z) < 0.01)) continue;
      for (const p of [run[0], run[run.length - 1]]) { const d = Math.hypot(p.x - x, p.z - z); if (d <= radius && (!best || d < best.d)) best = { p, d }; }
    }
    return best ? { x: best.p.x, z: best.p.z } : null;
  }

  // ── 设施（非会话建筑）：市长管公共设施，会话楼由开发商盖 ──

  /** 射线下最近的可编辑设施（实例级拾取）。 */
  pickSite(ray: RepairRay): SiteInfo | null {
    const layout = this.engine.currentLayout;
    return layout ? pickSite(layout, ray) : null;
  }

  siteById(id: string): SiteInfo | null {
    const layout = this.engine.currentLayout;
    return layout ? listSites(layout).find((site) => site.id === id) ?? null : null;
  }

  siteTargets(site: SiteInfo, limit = 40): SiteTarget[] {
    const layout = this.engine.currentLayout;
    return layout ? siteTargets(layout, site, this.engine.planPatch?.suppressedContext ?? [], limit) : [];
  }

  /** 地面点落在哪个可接收的目标上：街区级设施取包含该点（或最近）的街区，地块级取最近地块。 */
  siteTargetAt(site: SiteInfo, x: number, z: number, turn = 0): string | null {
    const layout = this.engine.currentLayout;
    if (!layout) return null;
    // 自由级：贴路、正门朝路（autoPlaceFree）；turn = 用户额外转的 90° 次数。
    if (site.level === "free") return formatFreeTarget(autoPlaceFree(layout, site, { x, z }, turn));
    if (site.level === "parcel") return this.nearestParcel(x, z)?.id ?? null;
    let best: { id: string; d: number } | null = null;
    for (const block of layout.blocks) {
      if (!block.parcels.length) continue;
      const d = Math.hypot(block.x - x, block.z - z);
      if (d <= Math.max(block.width, block.depth) / 2 + 4 && (!best || d < best.d)) best = { id: block.id, d };
    }
    return best?.id ?? null;
  }

  moveSite(site: SiteInfo, targetId: string): SiteEditResult {
    const base = this.working();
    if (!base.ok) return base;
    const problem = siteMoveProblem(this.engine.currentLayout!, site, targetId, base.patch.suppressedContext);
    if (problem) return { ok: false, reason: "blocked", blockers: [problem] };
    const anchor = site.level === "free" ? null : this.targetAnchor(site, targetId);
    let patch = appendSiteOp(base.patch, { t: "move", id: site.id, at: { x: site.x, z: site.z }, to: targetId, cls: siteClassOf(site), ...(anchor ? { toAnchor: anchor } : {}) });
    if (site.level !== "free") {
      this.commit(patch);
      return { ok: true, patch, warnings: [], siteId: site.kind === "context" ? `context:${targetId}` : site.id };
    }
    // 自由级（地标/市政用地）：新位置补一条接入路（同一步撤销），并列出原址留下的断头接入路供一键擦掉（SPEC §16.3）。
    const generated = this.engine.generatedLayout; const model = this.engine.currentModel!;
    const before = this.engine.currentLayout!;
    const warnings: string[] = [];
    let stranded: string[] = [];
    if (generated) {
      const moved = applyPlanPatch(generated, patch).layout;
      const placed = listSites(moved).find((candidate) => candidate.id === site.id);
      const road = placed ? accessRoadFor(moved, model, placed) : null;
      if (road) { patch = appendRoadOp(patch, { t: "add", from: road.from, to: road.to, width: roadWidthFor("local") }); warnings.push(`access-road:${road.length}`); }
      else if (!placed || !siteTouchesRoad(moved, placed)) warnings.push("no-access-road");
      const after = road ? applyPlanPatch(generated, patch).layout : moved;
      const accessNode = (before.landmarks ?? []).find((landmark) => landmark.id === site.id)?.access?.nodeId
        ?? (before.publicSites ?? []).find((public_) => `public:${public_.id}` === site.id)?.access?.nodeId;
      // 只列编辑前就存在的路段：新补的接入路（以及它拆开的路段）不算原址遗留。
      const existing = new Set(moved.roadEdges.map((edge) => edge.id));
      stranded = strandedAccessEdges(after, { x: site.x, z: site.z }, site.radius ?? site.width / 2, accessNode, existing);
    }
    this.commit(patch);
    return { ok: true, patch, warnings, siteId: site.id, strandedEdges: stranded };
  }

  removeSite(site: SiteInfo): EditResult {
    const base = this.working();
    if (!base.ok) return base;
    const patch = appendSiteOp(base.patch, { t: "remove", id: site.id, at: { x: site.x, z: site.z }, cls: siteClassOf(site) });
    this.commit(patch);
    return { ok: true, patch, warnings: [] };
  }

  /** 道路改动连同推土机的后果一起提交（同一步撤销）：压到的设施推平、会话楼由开发商就近安置。
   *  warnings 里的预估计数（bulldoze:N / relocate:N）换成实际结果（bulldozed:N / relocated:N / homeless:N）。 */
  private commitWithBulldozer(patch: PlanPatchV1, warnings: string[]): EditResult {
    const generated = this.engine.generatedLayout; const before = this.engine.currentLayout; const model = this.engine.currentModel;
    const result = generated && before && model ? bulldozeForRoads(generated, model, before, patch) : { patch, bulldozed: [], relocated: [], homeless: [] };
    this.commit(result.patch);
    const facts = [
      ...warnings.filter((code) => !code.startsWith("bulldoze:") && !code.startsWith("relocate:")),
      ...(result.bulldozed.length ? [`bulldozed:${result.bulldozed.length}`] : []),
      ...(result.relocated.length ? [`relocated:${result.relocated.length}`] : []),
      ...(result.homeless.length ? [`homeless:${result.homeless.length}`] : []),
    ];
    return { ok: true, patch: result.patch, warnings: facts };
  }

  // ── 悬停预览用的只读包装（不写补丁）──
  snap(x: number, z: number): SnapPoint | null {
    const layout = this.engine.currentLayout;
    return layout ? snapPoint(layout, x, z) : null;
  }

  edgeAt(x: number, z: number): { id: string; points: Vec2[]; width: number; locked: boolean } | null {
    const layout = this.engine.currentLayout;
    const edge = layout ? nearestEdgeAt(layout, x, z) : null;
    // 桥面：橡皮擦擦的是整座桥，悬停高亮整座（bridgeChain，与校验/重放同一口径）。
    const points = edge && edgeLocked(edge) ? bridgeChainPolyline(bridgeChain(layout!.roadEdges, edge)) : edge?.points;
    return edge ? { id: edge.id, points: points!, width: edge.width, locked: edge.bridge === true || edge.structure === "deck" || edge.structure === "ground-approach" || edge.purpose === "waterfront" } : null;
  }

  /** 坏桥头的一键修复方案（P1-D）：只产出候选，不写补丁。 */
  proposeBridgeFix(deckId: string): BridgeFixResult {
    const base = this.working();
    const generated = this.engine.generatedLayout; const current = this.engine.currentLayout; const model = this.engine.currentModel;
    if (!base.ok || !generated || !current || !model) { const code = base.ok ? "city-not-ready" : base.reason; return { ok: false, reason: "missing-bridge", codes: [code], detail: code }; }
    return proposeBridgeFix(generated, current, model, base.patch, deckId);
  }

  /** 采用方案：擦桥 + 擦残路 + 画桥作为一步写进补丁（一步撤销）；画桥压到的楼照常走推土机。 */
  applyBridgeFix(proposal: BridgeFixProposal): EditResult {
    const base = this.working();
    if (!base.ok) return base;
    const verdict = validateEdgeDrop(this.engine.currentLayout!, this.engine.currentModel!, proposal.deckId);
    if (verdict.blockers.length) return { ok: false, reason: "blocked", blockers: verdict.blockers };
    const patch = proposal.ops.reduce((next, op) => appendRoadOp(next, op.t === "drop" ? { ...op, ...this.edgeAnchor(op.edge) } : op), base.patch);
    return this.commitWithBulldozer(patch, proposal.warnings);
  }

  /** 试驾（P1-E）：在当前生效布局上沿这条路/整座桥双向各开一遍（驾驶面按布局缓存，同一布局第二次起不再编译）。 */
  testDrive(edgeId: string): DriveReport | null {
    const layout = this.engine.currentLayout;
    const result = layout ? testDrive(layout, edgeId) : null;
    if (!result) return null;
    const leg = result.forward.result === "blocked" ? result.forward : result.back.result === "blocked" ? result.back : result.forward.result !== "ok" ? result.forward : result.back;
    return { verdict: result.verdict, path: result.target.path, width: result.target.width, blockedAt: result.verdict === "blocked" ? leg.at : null, reason: leg.reason, kind: result.target.kind };
  }

  validateDrop(edgeId: string): RoadVerdict {
    const layout = this.engine.currentLayout; const model = this.engine.currentModel;
    return layout && model ? validateEdgeDrop(layout, model, edgeId) : { blockers: ["city-not-ready"], warnings: [] };
  }

  validateAdd(from: Vec2, to: Vec2, width: number, purpose?: RoadPurpose, exact = true, via?: Vec2): RoadPreview {
    const layout = this.engine.currentLayout; const model = this.engine.currentModel;
    if (!layout || !model) return { blockers: ["city-not-ready"], warnings: [] };
    const bend = via ? quantizePoint(via) : undefined;
    const op = { t: "add" as const, from, to, width, ...(purpose ? { purpose } : {}), ...(bend ? { via: bend } : {}) };
    const preview = this.dryRun(JSON.stringify(op), (patch) => appendRoadOp(patch, op), this.surfaceVerdict(op, validateRoadAdd(layout, model, from, to, width, purpose, [], bend), exact), exact);
    // 弧线：预览画重放会铺的同一条折线；直路：起点是路尽头且拐弯时画倒圆后的折线。
    const path = bend ? curvePoints(quantizePoint(from), bend, quantizePoint(to)) : this.bendPath(from, to, width);
    return path ? { ...preview, path } : preview;
  }

  /** 起点是路尽头且这一笔拐弯：实际铺成的折线（倒圆弧 → 终点），与重放用同一个 filletAt。 */
  private bendPath(from: Vec2, to: Vec2, width: number): Vec2[] | null {
    const layout = this.engine.currentLayout;
    if (!layout) return null;
    const node = layout.roadNodes.find((candidate) => Math.hypot(candidate.x - from.x, candidate.z - from.z) < 1);
    if (!node) return null;
    const incident = layout.roadEdges.filter((edge) => edge.from === node.id || edge.to === node.id);
    if (incident.length !== 1 || edgeLocked(incident[0])) return null;
    const pts = incident[0].to === node.id ? incident[0].points : [...incident[0].points].reverse();
    const fillet = filletAt(pts[pts.length - 2], node, to, Math.min(incident[0].width, width));
    return fillet ? [...fillet.before, fillet.mid, ...fillet.after, to] : null;
  }

  /**
   * 驾驶面安全网（2026-10-21）：把这一笔套上，编译它附近的驾驶面；新出现解不出边界的路面片（车开到那里脚下没有路）就拦
   * surface-unresolved。规则层（坡度/夹角/桥头）挡不住编译器自己的失败——弧线接到路上偶尔生成一块解不出的路口面片
   * （玩家式编辑抽样 ~2/100）。只在停住后的确切预览与提交时跑（局部编译 ~0.1–0.3 s），本来就有的洞不算这一笔的。
   */
  private surfaceVerdict(op: RoadOp, verdict: RoadVerdict, exact: boolean): RoadVerdict {
    if (!exact || verdict.blockers.length) return verdict;
    const base = this.working(); const generated = this.engine.generatedLayout; const before = this.engine.currentLayout;
    if (!base.ok || !generated || !before) return verdict;
    const key = `${hashPlanPatch(base.patch)}|${JSON.stringify(op)}`;
    const cached = this.surfaceCache.get(key);
    let holes: boolean;
    if (cached !== undefined) holes = cached;
    else {
      const after = applyPlanPatch(generated, appendRoadOp(base.patch, op)).layout;
      const known = new Set(before.roadEdges.map((edge) => edge.id));
      const touched = after.roadEdges.filter((edge) => !known.has(edge.id)).map((edge) => edge.points);
      holes = touched.length > 0 && surfaceHoles(after, touched) > surfaceHoles(before, touched);
      if (this.surfaceCache.size > 64) this.surfaceCache.clear();
      this.surfaceCache.set(key, holes);
    }
    return holes ? { ...verdict, blockers: [...verdict.blockers, "surface-unresolved"] } : verdict;
  }
  private readonly surfaceCache = new Map<string, boolean>();

  /** 推土机试算：把这一笔道路操作连同推平/安置算一遍但不提交。悬停每动一下都会调用，按（补丁, 操作）记住上一次结果。 */
  private dryRun(opKey: string, next: (patch: PlanPatchV1) => PlanPatchV1, verdict: RoadVerdict, exact = true): RoadPreview {
    if (verdict.blockers.length || !verdict.warnings.some((code) => code.startsWith("bulldoze:") || code.startsWith("relocate:"))) return verdict;
    if (!exact) return { ...verdict, estimate: true }; // 悬停移动中：先给 roadImpact 的估计，停住后控制器再要确切的（P0-1）
    const generated = this.engine.generatedLayout; const before = this.engine.currentLayout; const model = this.engine.currentModel;
    const base = this.working();
    if (!generated || !before || !model || !base.ok) return verdict;
    const key = `${hashPlanPatch(base.patch)}|${opKey}`;
    if (this.dryRunMemo?.key === key) return this.dryRunMemo.preview;
    const result = bulldozeForRoads(generated, model, before, next(base.patch));
    const sites = new Map(listSites(before).map((site) => [site.id, site]));
    const slots = new Map(before.districts.flatMap((district) => [...district.slots]));
    const buildings = new Map(model.buildings.map((building) => [building.id, building]));
    const rectOfSite = (id: string): PlanRect | null => { const site = sites.get(id); return site ? siteMarkRect(site) : null; };
    const rectOfBuilding = (id: string): PlanRect | null => { const slot = slots.get(id); const building = buildings.get(id); return slot && building ? buildingRect(building, slot) : null; };
    const parcels = new Map(before.blocks.flatMap((block) => block.parcels).map((parcel) => [parcel.id, parcel]));
    const impact: ImpactPreview = {
      bulldozed: result.bulldozed.map(rectOfSite).filter((rect): rect is PlanRect => !!rect),
      relocated: result.relocated.flatMap(({ id, to }) => { const from = rectOfBuilding(id); const parcel = parcels.get(to); return from && parcel ? [{ from, to: { x: parcel.x, z: parcel.z, yaw: parcel.yaw, width: parcel.width, depth: parcel.depth } }] : []; }),
      homeless: result.homeless.map(rectOfBuilding).filter((rect): rect is PlanRect => !!rect),
    };
    // 预估计数（roadImpact 按悬停时的布局数，含生成器残余、不知道安置链会腾出地方）换成试算的确切数字。
    const warnings = [
      ...verdict.warnings.filter((code) => !code.startsWith("bulldoze:") && !code.startsWith("relocate:")),
      ...(result.bulldozed.length ? [`bulldoze:${result.bulldozed.length}`] : []),
      ...(result.relocated.length ? [`relocate:${result.relocated.length}`] : []),
      ...(result.homeless.length ? [`homeless-risk:${result.homeless.length}`] : []),
    ];
    const preview = { blockers: verdict.blockers, warnings, impact };
    this.dryRunMemo = { key, preview };
    return preview;
  }

  /** 拖路口的悬停校验（含推土机试算）。 */
  validateMove(nodeId: string, x: number, z: number, exact = true): RoadPreview {
    const layout = this.engine.currentLayout; const model = this.engine.currentModel;
    if (!layout || !model) return { blockers: ["city-not-ready"], warnings: [] };
    const op = { t: "move" as const, node: nodeId, to: { x, z } };
    return this.dryRun(JSON.stringify(op), (patch) => appendRoadOp(patch, op), this.surfaceVerdict(op, validateNodeMove(layout, model, nodeId, { x, z }), exact), exact);
  }

  /** 地面点附近（radius 内）最近的路口。 */
  nodeAt(x: number, z: number, radius = 10): NodeHandle | null {
    const layout = this.engine.currentLayout;
    if (!layout) return null;
    let best: { id: string; x: number; z: number; d: number } | null = null;
    for (const node of layout.roadNodes) {
      const d = Math.hypot(node.x - x, node.z - z);
      if (d <= radius && (!best || d < best.d)) best = { id: node.id, x: node.x, z: node.z, d };
    }
    if (!best) return null;
    const id = best.id;
    const incident = layout.roadEdges.filter((edge) => edge.from === id || edge.to === id);
    if (!incident.length) return null;
    return { id, x: best.x, z: best.z, locked: incident.some(edgeLocked), edges: incident.map((edge) => ({ points: edge.points, width: edge.width, atStart: edge.from === id })) };
  }

  /** 选中会话楼后悬停：最近地块的落位试算。 */
  buildingGhost(buildingId: string, x: number, z: number): PlacementGhost | null {
    const layout = this.engine.currentLayout; const model = this.engine.currentModel;
    const parcel = layout ? this.nearestParcelInfo(x, z) : null;
    if (!layout || !model || !parcel) return null;
    const building = model.buildings.find((candidate) => candidate.id === buildingId);
    const rect = building ? buildingRect(building, parcel) : { x: parcel.x, z: parcel.z, yaw: parcel.yaw, width: parcel.width, depth: parcel.depth };
    if (parcel.id === this.parcelOf(buildingId)) return { targetId: parcel.id, rect, blockers: ["unchanged"], warnings: [] };
    const verdict = validateBuildingMove(layout, model, this.engine.planPatch ?? emptyPlanPatch(layout.seed, layout.scaleTier), buildingId, parcel.id);
    return { targetId: parcel.id, rect, blockers: verdict.blockers, warnings: verdict.warnings };
  }

  /** 选中设施后悬停：目标街区/地块/空地的落位试算。 */
  siteGhost(site: SiteInfo, x: number, z: number, turn = 0): PlacementGhost | null {
    const layout = this.engine.currentLayout;
    if (!layout) return null;
    const targetId = this.siteTargetAt(site, x, z, turn);
    if (!targetId) return null;
    let rect: PlanRect | null = null;
    if (site.level === "free") {
      const at = parseFreeTarget(targetId)!; const yaw = at.yaw ?? site.yaw;
      rect = siteMarkRect(site, at, yaw);
    }
    else if (site.level === "block") { const block = layout.blocks.find((candidate) => candidate.id === targetId); if (block) rect = { x: block.x, z: block.z, yaw: block.parcels[0]?.yaw ?? 0, width: block.width, depth: block.depth }; }
    else { const parcel = layout.blocks.flatMap((block) => block.parcels).find((candidate) => candidate.id === targetId); if (parcel) rect = { x: parcel.x, z: parcel.z, yaw: parcel.yaw, width: site.width, depth: site.depth }; }
    if (!rect) return null;
    const problem = siteMoveProblem(layout, site, targetId, this.engine.planPatch?.suppressedContext ?? []);
    return { targetId, rect, blockers: problem ? [problem] : [], warnings: [] };
  }

  /** 一次擦掉几段路（搬走地标后原址的断头接入路）——同一步撤销。 */
  dropEdges(edgeIds: readonly string[]): EditResult {
    const base = this.working();
    if (!base.ok) return base;
    const layout = this.engine.currentLayout!;
    const ids = edgeIds.filter((id) => { const edge = layout.roadEdges.find((candidate) => candidate.id === id); return !!edge && !edgeLocked(edge); });
    if (!ids.length) return { ok: false, reason: "blocked", blockers: ["missing-edge"] };
    let patch = base.patch;
    for (const id of ids) patch = appendRoadOp(patch, { t: "drop", edge: id, ...this.edgeAnchor(id) });
    this.commit(patch);
    return { ok: true, patch, warnings: [] };
  }

  /**
   * 跨档重定位（路线图 SPEC P0-2）：当前补丁写于别的档位时，把它逐条搬到新档并提交（不可撤销，见下），原补丁归档到存档的
   * archive[种子][旧档]。没有档位差时什么都不做、返回 null。数据刷新后由界面胶水调用（城市一升档就搬，用户不必进修复模式）。
   * 生成器换代（generatorVersion.ts）走同一条路：档位没变而地图被新版生成器重排，同样按锚点搬到新地图；
   * 归档键带上旧版本（`<档>@g<版本>`），不覆盖同档的跨档归档。
   */
  remapForTier(): RemapReport | null {
    const patch = this.engine.planPatch; const layout = this.engine.generatedLayout; const model = this.engine.currentModel;
    if (!patch || !layout || !model || patch.seed !== layout.seed || patchMatchesLayout(patch, layout.scaleTier)) return null;
    const { patch: next, report } = remapPlanPatch(layout, model, patch);
    const seed = String(layout.seed);
    const archiveKey = patch.scaleTier === layout.scaleTier ? `${patch.scaleTier}@g${patchGeneratorVersion(patch)}` : String(patch.scaleTier);
    this.store.archive = { ...this.store.archive, [seed]: { ...this.store.archive?.[seed], [archiveKey]: patch } };
    // 不进撤销栈：撤销回旧档补丁在新地图上画不出来，下一次同步又会自动重定位——撤销等于空转。原补丁已在存档里。
    // 旧档的撤销历史同理作废（那些补丁都是旧地图上的）。
    this.undoStack = []; this.redoStack = [];
    this.apply(next);
    this.lastRemap = report;
    return report;
  }

  dismissRemap(): void {
    this.lastRemap = null;
  }

  /** 清除失效修改（含跨档整份失效）。可撤销。 */
  pruneStale(): boolean {
    const patch = this.engine.planPatch; const stale = this.engine.planPatched?.stale ?? [];
    if (!patch || !stale.length) return false;
    this.commit(pruneStalePatch(patch, stale));
    return true;
  }

  undo(): boolean {
    if (!this.undoStack.length) return false;
    this.redoStack.push(this.engine.planPatch);
    this.apply(this.undoStack.pop() ?? null);
    return true;
  }

  redo(): boolean {
    if (!this.redoStack.length) return false;
    this.undoStack.push(this.engine.planPatch);
    this.apply(this.redoStack.pop() ?? null);
    return true;
  }

  /** 恢复生成：清掉当前种子的全部补丁（可撤销）。 */
  reset(): void {
    if (this.engine.planPatch) this.commit(null);
  }

  /** 离某栋楼最近的、可以搬过去的空地块（试搬用）。按距离从近到远逐个校验，凑够 limit 个就停——
   *  曾先校验全城再截断，真实城市 4000 地块 × 上千路段的校验每次选楼都要卡一下。 */
  candidates(buildingId: string, limit = 8, maxDistance = 160): RepairCandidate[] {
    const layout = this.engine.currentLayout; const model = this.engine.currentModel;
    const home = layout?.districts.flatMap((district) => [...district.slots]).find(([id]) => id === buildingId)?.[1];
    if (!layout || !model || !home) return [];
    const patch = this.engine.planPatch ?? emptyPlanPatch(layout.seed, layout.scaleTier);
    const sorted = layout.blocks.flatMap((block) => block.parcels)
      .map((parcel) => ({ parcel, distance: Math.hypot(parcel.x - home.x, parcel.z - home.z) }))
      .filter(({ parcel, distance }) => parcel.id !== home.id && distance <= maxDistance)
      .sort((a, b) => a.distance - b.distance || (a.parcel.id < b.parcel.id ? -1 : 1));
    const out: RepairCandidate[] = [];
    for (const { parcel, distance } of sorted) {
      const verdict = validateBuildingMove(layout, model, patch, buildingId, parcel.id);
      if (verdict.blockers.length) continue;
      out.push({ parcelId: parcel.id, x: parcel.x, z: parcel.z, yaw: parcel.yaw, width: parcel.width, depth: parcel.depth, distance: Math.round(distance), warnings: verdict.warnings });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** 某栋会话楼当前所在地块（生效布局）。 */
  parcelOf(buildingId: string): string | null {
    return this.engine.currentLayout?.districts.flatMap((district) => [...district.slots]).find(([id]) => id === buildingId)?.[1].id ?? null;
  }

  /** 点到地面一处时最近的地块（半径内）；含酒店地块。 */
  nearestParcel(x: number, z: number, radius = 14): { id: string; x: number; z: number } | null {
    const layout = this.engine.currentLayout;
    if (!layout) return null;
    let best: { id: string; x: number; z: number } | null = null; let bestD = radius;
    const consider = (parcel: { id: string; x: number; z: number }) => {
      const d = Math.hypot(parcel.x - x, parcel.z - z);
      if (d < bestD) { bestD = d; best = parcel; }
    };
    for (const block of layout.blocks) for (const parcel of block.parcels) consider(parcel);
    for (const district of layout.districts) for (const parcel of district.slots.values()) consider(parcel);
    return best;
  }

  /** 路段折线的中点（删路的锚点）。 */
  private edgeAnchor(edgeId: string): { anchor?: Vec2 } {
    const edge = this.engine.currentLayout?.roadEdges.find((candidate) => candidate.id === edgeId);
    if (!edge) return {};
    const lengths = edge.points.slice(1).map((p, i) => Math.hypot(p.x - edge.points[i].x, p.z - edge.points[i].z));
    let half = lengths.reduce((sum, l) => sum + l, 0) / 2;
    for (let i = 0; i < lengths.length; i += 1) {
      if (half <= lengths[i] || i === lengths.length - 1) { const t = lengths[i] ? Math.min(1, half / lengths[i]) : 0; const a = edge.points[i]; const b = edge.points[i + 1]; return { anchor: { x: Math.round((a.x + (b.x - a.x) * t) * 100) / 100, z: Math.round((a.z + (b.z - a.z) * t) * 100) / 100 } }; }
      half -= lengths[i];
    }
    return {};
  }

  /** 街区/地块目标的中心（设施搬家的锚点）。 */
  private targetAnchor(site: SiteInfo, targetId: string): Vec2 | null {
    const layout = this.engine.currentLayout;
    if (!layout) return null;
    if (site.level === "block") { const block = layout.blocks.find((candidate) => candidate.id === targetId); return block ? { x: block.x, z: block.z } : null; }
    return this.nearestParcelById(targetId);
  }

  private nearestParcelById(parcelId: string): Vec2 | null {
    const layout = this.engine.currentLayout;
    if (!layout) return null;
    for (const block of layout.blocks) for (const parcel of block.parcels) if (parcel.id === parcelId) return { x: parcel.x, z: parcel.z };
    for (const district of layout.districts) for (const parcel of district.slots.values()) if (parcel.id === parcelId) return { x: parcel.x, z: parcel.z };
    return null;
  }

  /** 同 nearestParcel，但带回地块的朝向与尺寸（落位试算画占地用）。 */
  private nearestParcelInfo(x: number, z: number, radius = 14): Parcel | null {
    const layout = this.engine.currentLayout;
    if (!layout) return null;
    let best: Parcel | null = null; let bestD = radius;
    const consider = (parcel: Parcel) => { const d = Math.hypot(parcel.x - x, parcel.z - z); if (d < bestD) { bestD = d; best = parcel; } };
    for (const block of layout.blocks) for (const parcel of block.parcels) consider(parcel);
    for (const district of layout.districts) for (const parcel of district.slots.values()) consider(parcel);
    return best;
  }

  /** 全城布局级体检（含补丁失效条目）。 */
  audit(): PlanIssue[] {
    const layout = this.engine.currentLayout; const model = this.engine.currentModel;
    if (!layout || !model) return [];
    const issues = auditLayout(layout, model, this.engine.planPatched?.stale ?? []);
    // 同一问题在未编辑的生成城市里就有 → 标「生成时就有」，否则是用户的修改造成的：用户据此判断该撤销自己的修改还是接受生成器的残余。
    const generated = this.engine.generatedLayout;
    return tagAuditOrigins(issues, generated && this.engine.planPatch ? auditLayout(generated, model, []) : null);
  }

  status() {
    const layout = this.engine.currentLayout;
    const patch = this.engine.planPatch;
    return {
      ready: !!layout, seed: layout?.seed ?? null, cityTier: layout?.scaleTier ?? null, patchTier: patch?.scaleTier ?? null,
      patch, stale: this.engine.planPatched?.stale ?? [], saveFailed: this.saveFailed, savePending: this.savePending,
      // tierChanged = 「补丁对不上当前地图、需要重定位」：跨档或生成器换代都算（界面胶水据此自动调 remapForTier）。
      // generatorChanged 只用来选文案：档位没变、是生成器换了。
      tierChanged: !!patch && !!layout && !patchMatchesLayout(patch, layout.scaleTier),
      generatorChanged: !!patch && !!layout && patch.scaleTier === layout.scaleTier && !patchMatchesLayout(patch, layout.scaleTier),
      remap: this.lastRemap,
      canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0,
      counts: patch ? { buildingMoves: Object.keys(patch.buildingMoves).length, roadOps: patch.roadOps.length, highwayOps: patch.highwayOps?.length ?? 0, roadAdds: patch.roadOps.filter((op) => op.t === "add").length, roadDrops: patch.roadOps.filter((op) => op.t === "drop").length, siteOps: patch.siteOps.length, suppressedContext: patch.suppressedContext.length } : null,
    };
  }

  dispose(): void {
    clearTimeout(this.saveTimer);
  }
}

declare global {
  interface Window { __cityPlan?: PlanRepairSession }
}

/** 把会话挂到 `window.__cityPlan`；返回卸载函数。 */
export function installPlanRepairDebug(engine: CityEngine): { session: PlanRepairSession; dispose: () => void } {
  const session = new PlanRepairSession(engine);
  window.__cityPlan = session;
  console.info("[city-plan] window.__cityPlan 已就绪：status() candidates(id) moveBuilding(id, parcelId) moveNode(id,x,z) dropEdge(id) undo() redo() reset() audit()");
  return { session, dispose: () => { session.dispose(); if (window.__cityPlan === session) delete window.__cityPlan; } };
}
