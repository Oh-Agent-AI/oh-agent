/**
 * 规划修复模式的 React 胶水：会话（加载/保存补丁）+ 状态机 + 引擎钩子 + 叠加层 + 键盘 + 光标。
 *
 * 开发开关（planDevEnabled）未开启时本 hook 什么都不做：不读存档、不挂 window、不碰引擎。
 * 与游戏/航拍/导出互斥（SPEC §8）：`blocked` 变真即退出修复模式，进入也被拒。
 */
import { roadWidthFor, EXPRESSWAY_DECK_WIDTH } from "../engine/roadStandard";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { CityModel } from "../cityModel";
import type { CityEngine } from "../engine/CityEngine";
import type { PlanIssue } from "../engine/planAudit";
import { RepairController, type DrawMode, type RepairState, type RepairTool, type RoadType } from "./controller";
import { ParcelOverlay, type OverlayMarker, type OverlayRibbon, type OverlaySiteMark } from "./overlay";
import { installPlanRepairDebug, planDevEnabled, siteMarkRect, type PlanRect, type PlanRepairSession } from "./session";
import type { RemapReport } from "../engine/planRemap";

export type RepairInfo = {
  counts: { buildingMoves: number; roadOps: number; highwayOps: number; roadAdds: number; roadDrops: number; siteOps: number; suppressedContext: number } | null;
  staleCount: number;
  /** 补丁对不上当前地图（写于别的档位，或别的生成器版本）：整份失效。重定位成功后为 false，改由 remap 报告。 */
  tierChanged: boolean;
  /** 档位没变、是生成器换了版本（generatorVersion.ts）——只决定提示文案。 */
  generatorChanged: boolean;
  /** 最近一次跨档重定位的结果。 */
  remap: RemapReport | null;
  canUndo: boolean;
  canRedo: boolean;
  saveFailed: boolean;
  savePending: boolean;
};

const INACTIVE: RepairState = { active: false, tool: "build", buildingId: null, candidates: [], site: null, siteTargets: [], drawStart: null, dragNode: null, stranded: [], proposal: null, roadType: "local", viaduct: [], drawMode: "straight", drawVia: null, siteTurn: 0, preview: null, message: null };
const NO_INFO: RepairInfo = { counts: null, staleCount: 0, tierChanged: false, generatorChanged: false, remap: null, canUndo: false, canRedo: false, saveFailed: false, savePending: false };

export function usePlanRepair(engine: RefObject<CityEngine | null>, options: { seed: number; model: CityModel | null; blocked: boolean }) {
  const enabled = planDevEnabled();
  const installed = useRef<ReturnType<typeof installPlanRepairDebug> | null>(null);
  const controllerRef = useRef<RepairController | null>(null);
  const overlayRef = useRef<ParcelOverlay | null>(null);
  const loadedSeed = useRef<number | null>(null);
  const auditOpen = useRef(false);
  const [state, setState] = useState<RepairState>(INACTIVE);
  const [info, setInfo] = useState<RepairInfo>(NO_INFO);
  const [issues, setIssues] = useState<PlanIssue[] | null>(null);

  const syncInfo = useCallback(() => {
    const session = installed.current?.session;
    if (!session) return;
    let status = session.status();
    // 城市升/降了一档，或生成器换了版本：自动把补丁搬到新地图（路线图 SPEC P0-2），不等用户进修复模式。
    if (status.tierChanged && session.remapForTier()) { status = session.status(); controllerRef.current?.refresh(); }
    setInfo({ counts: status.counts, staleCount: status.stale.length, tierChanged: status.tierChanged, generatorChanged: status.generatorChanged, remap: status.remap, canUndo: status.canUndo, canRedo: status.canRedo, saveFailed: status.saveFailed, savePending: status.savePending });
    if (auditOpen.current) setIssues(session.audit());
  }, []);

  /** 会话与控制器按需建一次（StrictMode 的 挂载→卸载→再挂载 会销毁，故每次进入前检查）。 */
  const ensure = useCallback((): { session: PlanRepairSession; controller: RepairController } | null => {
    const current = engine.current;
    if (!enabled || !current) return null;
    if (!installed.current) { installed.current = installPlanRepairDebug(current); installed.current.session.onSaveSettled = syncInfo; }
    const session = installed.current.session;
    if (!controllerRef.current) {
      const controller = new RepairController({
        isSessionBuilding: (id) => session.parcelOf(id) !== null,
        candidates: (id) => session.candidates(id, 40),
        nearestParcel: (x, z) => session.nearestParcel(x, z),
        parcelOf: (id) => session.parcelOf(id),
        moveBuilding: (id, parcelId) => session.moveBuilding(id, parcelId),
        setSelected: (id) => current.setSelected(id),
        snap: (x, z) => session.snap(x, z),
        edgeAt: (x, z) => session.edgeAt(x, z),
        validateAdd: (from, to, width, purpose, exact, via) => session.validateAdd(from, to, width, purpose, exact, via),
        addRoad: (from, to, width, purpose, via) => session.addRoad(from, to, width, purpose, via),
        validateHighway: (points, exact) => session.validateHighway(points, exact),
        addHighway: (points) => session.addHighway(points),
        highwayAt: (x, z) => session.highwayAt(x, z),
        cutHighway: (x, z) => session.cutHighway(x, z),
        highwayEndAt: (x, z) => session.highwayEndAt(x, z),
        validateDrop: (id) => session.validateDrop(id),
        restyleAt: (x, z, width, purpose, exact) => session.restyleAt(x, z, width, purpose, exact),
        restyleRoad: (id, width, purpose) => session.restyleRoad(id, width, purpose),
        dropEdge: (id) => session.dropEdge(id),
        dropEdges: (ids) => session.dropEdges(ids),
        testDrive: (id) => session.testDrive(id),
        proposeBridgeFix: (id) => session.proposeBridgeFix(id),
        applyBridgeFix: (proposal) => session.applyBridgeFix(proposal),
        nodeAt: (x, z) => session.nodeAt(x, z),
        validateMove: (id, x, z, exact) => session.validateMove(id, x, z, exact),
        moveNode: (id, x, z) => session.moveNode(id, x, z),
        buildingGhost: (id, x, z) => session.buildingGhost(id, x, z),
        siteGhost: (site, x, z, turn) => session.siteGhost(site, x, z, turn),
        defer: (run, ms) => { const timer = window.setTimeout(run, ms); return () => window.clearTimeout(timer); },
        pickSite: (ray) => session.pickSite(ray),
        siteById: (id) => session.siteById(id),
        siteTargets: (site) => session.siteTargets(site),
        siteTargetAt: (site, x, z, turn) => session.siteTargetAt(site, x, z, turn),
        moveSite: (site, targetId) => session.moveSite(site, targetId),
        removeSite: (site) => session.removeSite(site),
      });
      controller.subscribe((next) => { setState(next); syncInfo(); }); // 点击触发的编辑也要同步补丁计数/撤销态
      controllerRef.current = controller;
    }
    return { session, controller: controllerRef.current };
  }, [enabled, engine, syncInfo]);

  // 种子/模型变化：读该种子的补丁交给引擎；换种子退出修复模式（候选与选中都属于旧城）。
  useEffect(() => {
    if (!enabled) return;
    const ready = ensure(); if (!ready) return;
    if (loadedSeed.current !== options.seed) {
      loadedSeed.current = options.seed;
      controllerRef.current?.exit();
      void ready.session.load(options.seed).then(() => { controllerRef.current?.refresh(); syncInfo(); });
    }
  }, [options.seed, options.model, enabled]);

  // 数据刷新（模型重算）后：选中的楼可能没了、候选/预览可能变了。
  useEffect(() => { controllerRef.current?.refresh(); syncInfo(); }, [options.model]);

  // 互斥：游戏/航拍/导出/忙碌时退出。
  useEffect(() => { if (options.blocked) controllerRef.current?.exit(); }, [options.blocked]);

  // 模式开关 → 引擎钩子 + 叠加层 + 键盘；退出时全部撤回。
  useEffect(() => {
    if (!state.active) return;
    const current = engine.current; const controller = controllerRef.current;
    if (!current || !controller) return;
    const overlay = new ParcelOverlay();
    current.addOverlay(overlay.group);
    current.setRepairHook({ onClick: (click) => controller.click(click), onMove: (ground, ray) => controller.hover(ground, ray), onSecondary: () => controller.back() });
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
      if (event.key === "Escape") { event.preventDefault(); controller.cancel(); return; }
      if (event.key === "Enter" && controller.snapshot.viaduct.length) { event.preventDefault(); controller.finishViaduct(); syncInfo(); return; }
      if ((event.key === "c" || event.key === "C") && !event.metaKey && !event.ctrlKey && controller.snapshot.tool === "draw" && controller.snapshot.roadType !== "viaduct") { event.preventDefault(); controller.setDrawMode(controller.snapshot.drawMode === "curve" ? "straight" : "curve"); return; }
      if ((event.key === "[" || event.key === "]") && controller.snapshot.site?.level === "free") { event.preventDefault(); controller.rotateSite(event.key === "]" ? 1 : -1); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        const session = installed.current?.session; if (!session) return;
        if (event.shiftKey ? session.redo() : session.undo()) { controller.refresh({ kind: "ok", text: event.shiftKey ? "已重做" : "已撤销" }); syncInfo(); }
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if ((event.key === "Delete" || event.key === "Backspace") && controller.snapshot.tool === "site" && controller.snapshot.site) { event.preventDefault(); controller.removeSelected(); syncInfo(); return; }
      const tool: Record<string, RepairTool> = { v: "build", r: "draw", e: "erase", t: "restyle", s: "site", n: "node", d: "drive" };
      if (tool[event.key.toLowerCase()]) { event.preventDefault(); controller.setTool(tool[event.key.toLowerCase()]); }
    };
    window.addEventListener("keydown", onKey);
    overlayRef.current = overlay;
    return () => {
      window.removeEventListener("keydown", onKey);
      current.setRepairHook(null);
      current.setCursor("");
      current.removeOverlay(overlay.group);
      overlay.dispose();
      overlayRef.current = null;
    };
  }, [state.active]);

  // 工具 → 光标：画路/橡皮擦/路口用十字，选择用默认。
  useEffect(() => { if (state.active) engine.current?.setCursor(state.tool === "build" ? "" : "crosshair"); }, [state.active, state.tool]);

  // 候选 / 预览 / 起点变化 → 刷新叠加层（贴在地形高度上）。
  useEffect(() => {
    const overlay = overlayRef.current; const layout = engine.current?.currentLayout;
    if (!overlay || !layout) return;
    const heightAt = (x: number, z: number) => layout.terrain.height(x, z);
    // 绿色目标：移楼工具看候选地块，设施工具看合法的空街区/空地块。
    const targets = state.tool === "site" ? state.siteTargets : state.candidates.map((candidate) => ({ x: candidate.x, z: candidate.z, yaw: candidate.yaw, width: candidate.width, depth: candidate.depth }));
    overlay.setParcels(targets.map((target) => ({
      x: target.x, z: target.z, y: Math.max(0, heightAt(target.x, target.z)),
      yaw: target.yaw, width: target.width, depth: target.depth,
    })));
    const marks: OverlaySiteMark[] = [];
    if (state.preview?.kind === "site") marks.push({ ...state.preview.rect, y: Math.max(0, heightAt(state.preview.rect.x, state.preview.rect.z)), tone: "hover" });
    if (state.site) { const rect = siteMarkRect(state.site); marks.push({ ...rect, y: Math.max(0, heightAt(state.site.x, state.site.z)), tone: "selected" }); }
    const mark = (rect: PlanRect, tone: OverlaySiteMark["tone"]): OverlaySiteMark => ({ ...rect, y: Math.max(0, heightAt(rect.x, rect.z)), tone });
    const { preview, drawStart } = state;
    if (preview?.kind === "ghost") marks.push(mark(preview.rect, preview.ok ? "ghost-ok" : "ghost-bad"));
    const ribbons: OverlayRibbon[] = []; const markers: OverlayMarker[] = [];
    // 道路编辑的后果（推土机试算）：推平红、安置琥珀（原址 → 新家连线）、无处安置深红。
    const impact = preview?.kind === "draw" || preview?.kind === "node" || preview?.kind === "viaduct" || preview?.kind === "restyle" ? preview.impact : null;
    if (impact && preview && "ok" in preview && preview.ok) {
      for (const rect of impact.bulldozed) marks.push(mark(rect, "doomed"));
      for (const { from, to } of impact.relocated) { marks.push(mark(from, "relocate-from"), mark(to, "relocate-to")); ribbons.push({ points: [from, to], width: 0.8, tone: "link" }); }
      for (const rect of impact.homeless) marks.push(mark(rect, "homeless"));
    }
    overlay.setSiteMarks(marks);
    const hasImpact = !!impact && (impact.bulldozed.length > 0 || impact.relocated.length > 0 || impact.homeless.length > 0);
    if (preview?.kind === "erase") ribbons.push({ points: preview.points, width: preview.width, tone: preview.ok ? "erase" : "erase-blocked" });
    if (preview?.kind === "proposal") {
      for (const points of preview.erase) ribbons.push({ points, width: roadWidthFor("local"), tone: "erase" });
      ribbons.push({ points: [preview.draw.from, preview.draw.to], width: preview.draw.width, tone: "draw" });
      markers.push({ ...preview.draw.from, tone: "snap" }, { ...preview.draw.to, tone: "snap" });
    }
    if (preview?.kind === "drive") {
      ribbons.push({ points: preview.points, width: preview.width, tone: preview.result === "passed" ? "draw" : preview.result === "blocked" ? "erase" : preview.result === "undetermined" ? "draw-warn" : "drive" });
      if (preview.blockedAt) markers.push({ ...preview.blockedAt, tone: "snap-blocked" });
    }
    if (preview?.kind === "restyle") for (const edge of preview.edges) ribbons.push({ points: edge.points, width: edge.width, tone: !preview.ok ? "draw-blocked" : preview.warning ? "draw-warn" : "draw" });
    // 画路预览按实际铺成的折线画（拐角倒圆时 path 从旧路尾端的切点开始，弧线一目了然）。
    if (preview?.kind === "draw") { ribbons.push({ points: preview.path ?? [preview.from, preview.to], width: preview.width, tone: !preview.ok ? "draw-blocked" : hasImpact ? "draw-warn" : "draw" }); markers.push({ ...preview.to, tone: preview.ok ? "snap" : "snap-blocked" }); }
    if (preview?.kind === "viaduct") {
      if (preview.points.length >= 2) ribbons.push({ points: preview.points, width: EXPRESSWAY_DECK_WIDTH, tone: !preview.ok ? "draw-blocked" : hasImpact ? "draw-warn" : "draw" });
      markers.push({ ...preview.points[preview.points.length - 1], tone: preview.ok ? "snap" : "snap-blocked" });
    }
    for (const point of state.viaduct) markers.push({ ...point, tone: "start" });
    if (preview?.kind === "node") { for (const edge of preview.edges) ribbons.push({ points: edge.points, width: edge.width, tone: !preview.ok ? "draw-blocked" : hasImpact ? "draw-warn" : "draw" }); markers.push({ ...preview.at, tone: preview.ok ? "snap" : "snap-blocked" }); }
    if (preview?.kind === "node-hover") markers.push({ ...preview.at, tone: preview.ok ? "snap" : "snap-blocked" });
    if (state.dragNode) markers.push({ x: state.dragNode.x, z: state.dragNode.z, tone: "start" });
    if (preview?.kind === "snap") markers.push({ ...preview.at, tone: preview.ok ? "snap" : "snap-blocked" });
    if (drawStart) markers.push({ x: drawStart.x, z: drawStart.z, tone: "start" });
    overlay.setPreview(ribbons, markers, heightAt);
  }, [state.candidates, state.siteTargets, state.site, state.preview, state.drawStart, state.dragNode, state.viaduct, state.active, state.tool]);

  useEffect(() => () => {
    controllerRef.current?.exit();
    installed.current?.dispose();
    installed.current = null; controllerRef.current = null; loadedSeed.current = null;
  }, []);

  const withSession = (run: (session: PlanRepairSession, controller: RepairController) => void) => {
    const ready = ensure(); if (!ready) return;
    run(ready.session, ready.controller); syncInfo();
  };

  return {
    enabled, state, info, issues,
    enter: () => { if (options.blocked || !options.model) return; withSession((_s, controller) => controller.enter()); },
    exit: () => { auditOpen.current = false; setIssues(null); controllerRef.current?.exit(); },
    setTool: (tool: RepairTool) => withSession((_s, controller) => controller.setTool(tool)),
    removeSelected: () => withSession((_s, controller) => controller.removeSelected()),
    setDrawMode: (mode: DrawMode) => withSession((_s, controller) => controller.setDrawMode(mode)),
    rotateSite: (direction: 1 | -1) => withSession((_s, controller) => controller.rotateSite(direction)),
    eraseStranded: () => withSession((_s, controller) => controller.eraseStranded()),
    dismissRemap: () => withSession((session) => session.dismissRemap()),
    pruneStale: () => withSession((session, controller) => { if (session.pruneStale()) controller.refresh({ kind: "ok", text: "已清除失效的修改（撤销可恢复）" }); }),
    setRoadType: (type: RoadType) => withSession((_s, controller) => controller.setRoadType(type)),
    finishViaduct: () => withSession((_s, controller) => controller.finishViaduct()),
    undo: () => withSession((session, controller) => { if (session.undo()) controller.refresh({ kind: "ok", text: "已撤销" }); }),
    redo: () => withSession((session, controller) => { if (session.redo()) controller.refresh({ kind: "ok", text: "已重做" }); }),
    reset: () => withSession((session, controller) => { session.reset(); controller.refresh({ kind: "ok", text: "已恢复生成" }); }),
    audit: () => withSession((session) => { auditOpen.current = true; setIssues(session.audit()); }),
    closeAudit: () => { auditOpen.current = false; setIssues(null); },
    locate: (issue: PlanIssue) => { if (issue.at) engine.current?.focusPoint(issue.at.x, issue.at.z); },
    /** 体检里的坏桥头：给出修复方案并飞过去看（P1-D）。 */
    proposeFix: (issue: PlanIssue) => withSession((_s, controller) => { controller.proposeBridgeFix(issue.entities[0]); if (issue.at) engine.current?.focusPoint(issue.at.x, issue.at.z); }),
    acceptProposal: () => withSession((session, controller) => { controller.acceptProposal(); if (auditOpen.current) setIssues(session.audit()); }),
    cancelProposal: () => withSession((_s, controller) => controller.cancel()),
  };
}

export type PlanRepairUi = ReturnType<typeof usePlanRepair>;
