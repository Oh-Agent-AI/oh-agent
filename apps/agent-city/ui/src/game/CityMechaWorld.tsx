/** Mechs and monsters standing on the city scene. The rules board stays in cell space. */
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as THREE from "three";
import type { InspectionSegment } from "./mecha/cellInspection";
import { unitHealth } from "./mecha/unitHealth";
import { describeUnitIdentity } from "./mecha/unitIdentity";
import type { GameLocale } from "./gameCopy";
import type { CityEngine } from "../engine/CityEngine";
import { boardToWorld, cellWorld, type CityMechaSite } from "./mecha/citySite";
import { MechaBattleAnimator, MechaPerformancePlayer, faceMechaTarget, type MechaCombatCue } from "../render/mecha/animation";
import { MECHA_FACTION_COLORS, createAssault, createBoss, createGunner, createRaider, createSupport, disposeMechaModel, ensureMechaGlbAsset, getMechaGlbAsset } from "../render/mecha/models";
import { AssaultGroundController } from "../render/mecha/assaultGroundController";
import type { MechaGlbAsset } from "../render/mecha/glbModels";
import { createConnectedAssaultPreviewPlayer } from "../render/mecha/connectedAssaultPreview";
import { useConnectedAssault } from "../render/mecha/connectedAssaultMode";
import { createAssaultCityGround } from "./assaultCityGround";
import { positionPerformanceActors } from "./mecha/positionPerformanceActors";
import { terrainSurfaceHeight } from "../engine/surface/terrainSampling";
import { applyMechaUnitLight, setMechaUnitLight } from "../render/mecha/unitLight";
import type { MechaPerformanceEvent } from "./mecha/performance";
import { BOARD, type Cell, type MechId } from "./mecha/rules";

export type CityMechaView = {
  figures: Array<{ id: MechId; x: number; y: number; alive: boolean; selected: boolean; hp?: number; maxHp?: number }>;
  boss: { x: number; y: number; alive: boolean; hp?: number; maxHp?: number };
  raiders: Array<{ id: string; x: number; y: number; alive: boolean; hp?: number; maxHp?: number }>;
  buildings: Array<{ id: string; cells: Cell[]; hp: number; maxHp: number }>;
  focusedBuilding?: string | null;
  /** Current enemy declarations, independent of the draft simulation. */
  declaredTelegraph: Cell[];
  /** null means unknown; an empty array means a successful prediction with no threats. */
  projectedTelegraph: Cell[] | null;
  /** Existing interaction/focus projection, retained for compatibility. */
  telegraph: Cell[];
  focusedTelegraph: Cell[];
  inspectedCell?: Cell | null;
  inspectionSegments?: InspectionSegment[];
  inspectedThreats?: Cell[];
  focus: Cell[];
  reach: Cell[];
  move: Cell | null;
  targets: Cell[];
  targetIds: string[];
  /** Actual selected target anchor; shove is supplied only for a verified displacement. */
  targetPreview?: { target: Cell; shove?: { from: Cell; to: Cell } };
  /** Mouse or list focus; other enemies' threats remain visible. */
  hoveredEnemy?: string | null;
  /** Position is the event's verified attack-time origin, not the current actor position. */
  enemyOrder?: Array<{ actor: string; cells: Cell[]; position?: Cell }>;
  combat?: { id: number; actions: MechaCombatCue[]; reset?: true };
  /** 规则里的障碍格（场景楼、斜放楼）。缺省当空。 */
  obstacles?: Cell[];
};

const ROLES = ["empty", "water", "mountain", "road", "reach", "move", "building", "rubble", "obstacle", "focus", "telegraph", "target"] as const;
type Role = (typeof ROLES)[number];

const ROLE_COLOR: Record<Role, string> = {
  empty: "#d5e4f2",
  water: "#2f86b8",
  mountain: "#a56b45",
  road: "#f2c14b",
  reach: "#8fd4ff",
  move: "#ffe08a",
  building: "#e2b15a",
  rubble: "#2c2824",
  obstacle: "#4a4f57",
  focus: "#39d6a3",
  telegraph: "#ff3b3b",
  target: "#ffd166",
};

const ROLE_OPACITY: Record<Role, number> = {
  empty: 0.24,
  water: 0.4,
  mountain: 0.4,
  road: 0.38,
  reach: 0.56,
  move: 0.82,
  building: 0.34,
  rubble: 0.4,
  obstacle: 0.45,
  focus: 0.82,
  telegraph: 0.78,
  target: 0.88,
};

export type CityMechaWorldHandle = {
  resetCamera: () => void;
  rotateCamera: () => void;
};

export type MechaPerformanceView = { events: MechaPerformanceEvent[] };

export const CityMechaWorld = forwardRef<CityMechaWorldHandle, {
  engine: CityEngine;
  site: CityMechaSite;
  locale?: GameLocale;
  view: CityMechaView;
  performance: MechaPerformanceView | null;
  paused: boolean;
  onPerformanceComplete: () => void;
  onCell: (x: number, y: number, input: "mouse" | "touch") => void;
  onHoverCell?: (cell: Cell | null) => void;
  onHoverEnemy?: (id: string | null) => void;
  onUnavailable?: (reason?: "preview" | "asset") => void;
  onPreviewLoading?: (loading: boolean) => void;
}>(function CityMechaWorld({ engine, site, locale = "zh-Hans", view, performance, paused, onPerformanceComplete, onCell, onHoverCell, onHoverEnemy, onUnavailable, onPreviewLoading }, ref) {
  const badgeLayerRef = useRef<HTMLDivElement>(null);
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const viewRef = useRef(view);
  const performanceRef = useRef(performance);
  const pausedRef = useRef(paused);
  const onCellRef = useRef(onCell);
  const onHoverEnemyRef = useRef(onHoverEnemy);
  const onHoverCellRef = useRef(onHoverCell);
  const onPerformanceCompleteRef = useRef(onPerformanceComplete);
  const cameraCommands = useRef<CityMechaWorldHandle | null>(null);
  viewRef.current = view;
  performanceRef.current = performance;
  pausedRef.current = paused;
  onCellRef.current = onCell;
  onHoverEnemyRef.current = onHoverEnemy;
  onHoverCellRef.current = onHoverCell;
  onPerformanceCompleteRef.current = onPerformanceComplete;
  useImperativeHandle(ref, () => ({
    resetCamera: () => cameraCommands.current?.resetCamera(),
    rotateCamera: () => cameraCommands.current?.rotateCamera(),
  }), []);

  useEffect(() => {
    const canvas = engine.domCanvas;
    if (!(canvas instanceof HTMLCanvasElement)) return undefined;
    const saved = engine.captureReturnView();
    // One token owns camera + frame hook + scene objects. A conflicting mode makes
    // this return null; the board then runs without the 3D layer instead of
    // overwriting another owner's camera.
    const lease = engine.acquireModeLease({ camera: "orbit" });
    if (!lease) {
      onUnavailable?.();
      return undefined;
    }
    const root = new THREE.Group();
    root.name = "mecha-city";
    lease.setBattleClarity(true);

    const padGeo = new THREE.BoxGeometry(site.cellW - 0.44, 0.08, site.cellD - 0.48);
    const padMat = new Map<Role, THREE.MeshStandardMaterial>();
    for (const role of ROLES) {
      padMat.set(role, new THREE.MeshStandardMaterial({
        color: ROLE_COLOR[role],
        transparent: true,
        opacity: ROLE_OPACITY[role],
        roughness: 1,
        metalness: 0,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -3,
        polygonOffsetUnits: -3,
        emissive: role === "telegraph" ? "#8a1c1c" : role === "focus" ? "#146b52" : role === "target" ? "#b97a12" : "#000000",
        emissiveIntensity: role === "telegraph" ? 0.4 : role === "focus" ? 0.45 : role === "target" ? 0.55 : 0,
      }));
    }
    const pads: THREE.Mesh[] = [];
    // Independent layers keep danger, movement reach and legal targets legible
    // on the same tile. All cells share geometry/materials and are disposed below.
    const w = (site.cellW - 0.44) / 2;
    const d = (site.cellD - 0.48) / 2;
    const lines = (points: Array<[number, number]>) => new THREE.BufferGeometry().setFromPoints(points.map(([x, z]) => new THREE.Vector3(x, 0, z)));
    const threatGeo = new THREE.BufferGeometry();
    const stripe = (a: number, b: number) => [
      a - w * .08, 0, -d * .8, b - w * .08, 0, d * .8, a + w * .08, 0, -d * .8,
      a + w * .08, 0, -d * .8, b - w * .08, 0, d * .8, b + w * .08, 0, d * .8,
    ];
    threatGeo.setAttribute("position", new THREE.Float32BufferAttribute([...stripe(-w * .72, -w * .12), ...stripe(w * .12, w * .72)], 3));
    // A segmented inner diamond encodes the draft projection without relying
    // on colour. It can coexist with the declaration stripes on the same tile.
    const projectedGeo = new THREE.BufferGeometry();
    const projectedSegments: number[] = [];
    const diamond: Array<[number, number]> = [[0, -d * .64], [w * .64, 0], [0, d * .64], [-w * .64, 0], [0, -d * .64]];
    for (let edge = 0; edge < 4; edge += 1) {
      const [x1, z1] = diamond[edge]!;
      const [x2, z2] = diamond[edge + 1]!;
      for (const start of [0, .5]) {
        const end = start + .3;
        const dx = x2 - x1, dz = z2 - z1;
        const nx = -dz * .055, nz = dx * .055;
        const ax = x1 + dx * start, az = z1 + dz * start;
        const bx = x1 + dx * end, bz = z1 + dz * end;
        projectedSegments.push(ax + nx, 0, az + nz, ax - nx, 0, az - nz, bx + nx, 0, bz + nz,
          bx + nx, 0, bz + nz, ax - nx, 0, az - nz, bx - nx, 0, bz - nz);
      }
    }
    projectedGeo.setAttribute("position", new THREE.Float32BufferAttribute(projectedSegments, 3));
    // WebGL lines are one physical pixel wide. Filled corner brackets remain
    // visible at the fitted 640×480 view and differ in shape from danger stripes.
    const targetGeo = new THREE.BufferGeometry();
    const rect = (x1: number, z1: number, x2: number, z2: number) => [
      x1, 0, z1, x2, 0, z1, x2, 0, z2,
      x1, 0, z1, x2, 0, z2, x1, 0, z2,
    ];
    const corners: number[] = [];
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      corners.push(...rect(sx * w * .98, sz * d * .98, sx * w * .68, sz * d * .88));
      corners.push(...rect(sx * w * .98, sz * d * .88, sx * w * .88, sz * d * .68));
    }
    targetGeo.setAttribute("position", new THREE.Float32BufferAttribute(corners, 3));
    // Four inward-pointing arrowheads mark reach independently of the pad's
    // terrain/building colour, including when another tactical layer is present.
    const reachGeo = new THREE.BufferGeometry();
    reachGeo.setAttribute("position", new THREE.Float32BufferAttribute([
      -w * .24, 0, -d * .96, w * .24, 0, -d * .96, 0, 0, -d * .70,
      -w * .24, 0, d * .96, w * .24, 0, d * .96, 0, 0, d * .70,
      -w * .96, 0, -d * .24, -w * .96, 0, d * .24, -w * .70, 0, 0,
      w * .96, 0, -d * .24, w * .96, 0, d * .24, w * .70, 0, 0,
    ], 3));
    const focusGeo = lines([[-w * .75, -d * .75], [w * .75, -d * .75], [w * .75, -d * .75], [w * .75, d * .75], [w * .75, d * .75], [-w * .75, d * .75], [-w * .75, d * .75], [-w * .75, -d * .75]]);
    // A filled diamond ring survives at small board sizes; WebGL line width is
    // otherwise one physical pixel. Keep the center open for other layers.
    const moveGeo = new THREE.BufferGeometry();
    const moveDiamond = (radius: number): Array<[number, number]> => [[0, -d * radius], [w * radius, 0], [0, d * radius], [-w * radius, 0]];
    const outerMove = moveDiamond(.50), innerMove = moveDiamond(.34), moveVertices: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const next = (i + 1) % 4;
      const [ax, az] = outerMove[i]!, [bx, bz] = outerMove[next]!;
      const [cx, cz] = innerMove[i]!, [dx, dz] = innerMove[next]!;
      moveVertices.push(ax, 0, az, bx, 0, bz, cx, 0, cz, bx, 0, bz, dx, 0, dz, cx, 0, cz);
    }
    moveGeo.setAttribute("position", new THREE.Float32BufferAttribute(moveVertices, 3));
    const threatMat = new THREE.MeshBasicMaterial({ color: "#ff5656", transparent: true, opacity: .9, depthWrite: false, side: THREE.DoubleSide });
    const subduedThreatMat = new THREE.MeshBasicMaterial({ color: "#ff9292", transparent: true, opacity: .55, depthWrite: false, side: THREE.DoubleSide });
    const focusThreatMat = new THREE.MeshBasicMaterial({ color: "#fff0e0", transparent: true, opacity: 1, depthWrite: false, side: THREE.DoubleSide });
    const projectedMat = new THREE.MeshBasicMaterial({ color: "#7fe5ff", transparent: true, opacity: 1, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true, toneMapped: false });
    const focusedProjectedMat = new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 1, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true, toneMapped: false });
    const subduedProjectedMat = new THREE.MeshBasicMaterial({ color: "#5597a9", transparent: true, opacity: .72, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true, toneMapped: false });
    const targetMat = new THREE.MeshBasicMaterial({ color: "#ffd166", transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true, toneMapped: false });
    const reachMat = new THREE.MeshBasicMaterial({ color: "#155b82", transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true, toneMapped: false });
    const focusMat = new THREE.LineBasicMaterial({ color: "#39d6a3", depthWrite: false });
    const moveMat = new THREE.MeshBasicMaterial({ color: "#ffe08a", transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true, toneMapped: false });
    // Ground stripes respect scene depth. A small screen-facing warning at the
    // cell corner remains visible when a mech or building covers those stripes.
    const warningCanvas = document.createElement("canvas");
    warningCanvas.width = warningCanvas.height = 96;
    const warningContext = warningCanvas.getContext("2d");
    if (warningContext) {
      warningContext.beginPath();
      warningContext.moveTo(48, 7); warningContext.lineTo(91, 84); warningContext.lineTo(5, 84); warningContext.closePath();
      warningContext.fillStyle = "#d7192d"; warningContext.fill();
      warningContext.lineWidth = 4; warningContext.strokeStyle = "#fff4d2"; warningContext.stroke();
      warningContext.font = "bold 42px sans-serif"; warningContext.textAlign = "center"; warningContext.textBaseline = "middle";
      warningContext.fillStyle = "#fff"; warningContext.fillText("!", 48, 54);
    }
    const warningTexture = new THREE.CanvasTexture(warningCanvas);
    const warningMat = new THREE.SpriteMaterial({ map: warningTexture, transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false, fog: false, toneMapped: false });
    const subduedWarningMat = new THREE.SpriteMaterial({ map: warningTexture, color: "#b8b8b8", transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false, fog: false, toneMapped: false });
    const focusWarningMat = new THREE.SpriteMaterial({ map: warningTexture, color: "#fff2a5", transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false, fog: false, toneMapped: false });
    // The square P badge stays visible even when terrain or units occlude the
    // ground marker; its silhouette differs from the declaration triangle.
    const projectedCanvas = document.createElement("canvas");
    projectedCanvas.width = projectedCanvas.height = 96;
    const projectedContext = projectedCanvas.getContext("2d");
    if (projectedContext) {
      projectedContext.fillStyle = "#07526d"; projectedContext.fillRect(9, 9, 78, 78);
      projectedContext.lineWidth = 5; projectedContext.strokeStyle = "#e3fbff"; projectedContext.strokeRect(9, 9, 78, 78);
      projectedContext.font = "bold 54px sans-serif"; projectedContext.textAlign = "center"; projectedContext.textBaseline = "middle";
      projectedContext.fillStyle = "#fff"; projectedContext.fillText("P", 48, 51);
    }
    const projectedTexture = new THREE.CanvasTexture(projectedCanvas);
    const projectedWarningMat = new THREE.SpriteMaterial({ map: projectedTexture, transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false, fog: false, toneMapped: false });
    const focusedProjectedWarningMat = new THREE.SpriteMaterial({ map: projectedTexture, color: "#ffffff", transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false, fog: false, toneMapped: false });
    const subduedProjectedWarningMat = new THREE.SpriteMaterial({ map: projectedTexture, color: "#999999", transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false, fog: false, toneMapped: false });
    // A single combined badge avoids two overlapping icons on shared cells.
    // The hexagonal !P is distinct from both the triangle and the square.
    const combinedCanvas = document.createElement("canvas");
    combinedCanvas.width = combinedCanvas.height = 96;
    const combinedContext = combinedCanvas.getContext("2d");
    if (combinedContext) {
      combinedContext.beginPath();
      combinedContext.moveTo(21, 8); combinedContext.lineTo(75, 8); combinedContext.lineTo(91, 48);
      combinedContext.lineTo(75, 88); combinedContext.lineTo(21, 88); combinedContext.lineTo(5, 48); combinedContext.closePath();
      combinedContext.fillStyle = "#493347"; combinedContext.fill();
      combinedContext.lineWidth = 5; combinedContext.strokeStyle = "#fff4d2"; combinedContext.stroke();
      combinedContext.font = "bold 42px sans-serif"; combinedContext.textAlign = "center"; combinedContext.textBaseline = "middle";
      combinedContext.fillStyle = "#fff"; combinedContext.fillText("!P", 48, 50);
    }
    const combinedTexture = new THREE.CanvasTexture(combinedCanvas);
    const combinedWarningMat = new THREE.SpriteMaterial({ map: combinedTexture, transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false, fog: false, toneMapped: false });
    const threatLines: THREE.Mesh[] = [];
    const projectedLines: THREE.Mesh[] = [];
    const projectedWarnings: THREE.Sprite[] = [];
    const projectedWarningPositions: THREE.Vector3[] = [];
    const threatWarnings: THREE.Sprite[] = [];
    const targetLines: THREE.Mesh[] = [];
    // A single instanced draw covers every reachable cell (at most BOARD²).
    const reachMarks = new THREE.InstancedMesh(reachGeo, reachMat, BOARD * BOARD);
    reachMarks.count = 0;
    reachMarks.renderOrder = 4;
    reachMarks.frustumCulled = false;
    root.add(reachMarks);
    const reachMatrices: THREE.Matrix4[] = [];
    let reachSignature = "";
    const focusLines: THREE.LineSegments[] = [];
    const moveLines: THREE.Mesh[] = [];
    const addLines = (geo: THREE.BufferGeometry, mat: THREE.LineBasicMaterial, world: { x: number; y: number; z: number }, height: number) => {
      const line = new THREE.LineSegments(geo, mat);
      line.position.set(world.x, world.y + height, world.z);
      line.rotation.y = site.yaw;
      line.renderOrder = 3;
      line.visible = false;
      root.add(line);
      return line;
    };
    // Continuous selected frame differs in shape from the legal-target corners.
    const previewGeo = new THREE.BufferGeometry();
    previewGeo.setAttribute("position", new THREE.Float32BufferAttribute([
      ...rect(-w, -d, w, -d * .88), ...rect(-w, d * .88, w, d),
      ...rect(-w, -d * .88, -w * .88, d * .88), ...rect(w * .88, -d * .88, w, d * .88),
    ], 3));
    const previewMat = new THREE.MeshBasicMaterial({ color: "#fff5b4", transparent: true, forceSinglePass: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    const previewFrame = new THREE.Mesh(previewGeo, previewMat);
    previewFrame.renderOrder = 11; previewFrame.visible = false; root.add(previewFrame);
    // An outlined arrow uses only supplied simulation endpoints, never collision inference.
    const shoveGeo = new THREE.BufferGeometry();
    shoveGeo.setAttribute("position", new THREE.Float32BufferAttribute([
      0, 0, -.18, .62, 0, -.18, .62, 0, .18, 0, 0, -.18, .62, 0, .18, 0, 0, .18,
      .55, 0, -.42, 1, 0, 0, .55, 0, .42,
    ], 3));
    const shoveOutlineMat = new THREE.MeshBasicMaterial({ color: "#172936", transparent: true, forceSinglePass: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    const shoveMat = new THREE.MeshBasicMaterial({ color: "#fff5b4", transparent: true, forceSinglePass: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    const shoveOutline = new THREE.Mesh(shoveGeo, shoveOutlineMat), shoveArrow = new THREE.Mesh(shoveGeo, shoveMat);
    shoveOutline.renderOrder = 12; shoveArrow.renderOrder = 13;
    shoveOutline.visible = shoveArrow.visible = false; root.add(shoveOutline, shoveArrow);
    const attackRouteMat = new THREE.MeshBasicMaterial({ color: "#ff7668", depthTest: false, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    const moveRouteMat = new THREE.MeshBasicMaterial({ color: "#82e5af", depthTest: false, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    const inspectionArrows: Array<{ outline: THREE.Mesh; arrow: THREE.Mesh }> = [];
    const inspectionFrameMat = new THREE.LineBasicMaterial({ color: "#f1f5e8", depthTest: false, depthWrite: false, toneMapped: false });
    const inspectionFrame = new THREE.LineSegments(focusGeo, inspectionFrameMat);
    inspectionFrame.renderOrder = 14; inspectionFrame.visible = false; root.add(inspectionFrame);
    const pickGeo = new THREE.BoxGeometry(site.cellW - 0.16, 0.6, site.cellD - 0.16);
    const pickMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
    const picks: THREE.Mesh[] = [];
    for (let y = 0; y < BOARD; y += 1) {
      for (let x = 0; x < BOARD; x += 1) {
        const world = cellWorld(site, { x, y });
        const pad = new THREE.Mesh(padGeo, padMat.get("empty")!);
        pad.position.set(world.x, world.y + 0.22, world.z);
        pad.rotation.y = site.yaw;
        pad.name = `mecha-cell-${x}-${y}`;
        pads.push(pad);
        root.add(pad);
        const threat = new THREE.Mesh(threatGeo, threatMat);
        threat.position.set(world.x, world.y + 0.30, world.z);
        threat.rotation.y = site.yaw;
        threat.renderOrder = 3;
        threat.visible = false;
        threatLines.push(threat);
        root.add(threat);
        const projected = new THREE.Mesh(projectedGeo, projectedMat);
        projected.position.set(world.x, world.y + 0.305, world.z);
        projected.rotation.y = site.yaw;
        projected.renderOrder = 4;
        projected.visible = false;
        projectedLines.push(projected);
        root.add(projected);
        const projectedWarning = new THREE.Sprite(projectedWarningMat);
        const projectedAt = boardToWorld(site, (x + 0.82) * site.cellW, (y + 0.82) * site.cellD);
        projectedWarning.position.set(projectedAt.x, world.y + 0.7, projectedAt.z);
        projectedWarning.renderOrder = 9;
        projectedWarning.visible = false;
        projectedWarnings.push(projectedWarning);
        projectedWarningPositions.push(projectedWarning.position.clone());
        root.add(projectedWarning);
        const warning = new THREE.Sprite(warningMat);
        const warningAt = boardToWorld(site, (x + 0.18) * site.cellW, (y + 0.18) * site.cellD);
        warning.position.set(warningAt.x, world.y + 0.7, warningAt.z);
        warning.scale.set(4.5, 4.5, 1);
        warning.renderOrder = 9;
        warning.visible = false;
        threatWarnings.push(warning);
        root.add(warning);
        const reachTransform = new THREE.Object3D();
        reachTransform.position.set(world.x, world.y + 0.31, world.z);
        reachTransform.rotation.y = site.yaw;
        reachTransform.updateMatrix();
        reachMatrices.push(reachTransform.matrix.clone());
        const target = new THREE.Mesh(targetGeo, targetMat);
        target.position.set(world.x, world.y + 0.32, world.z);
        target.rotation.y = site.yaw;
        target.renderOrder = 5;
        target.visible = false;
        targetLines.push(target);
        root.add(target);
        focusLines.push(addLines(focusGeo, focusMat, world, 0.32));
        const move = new THREE.Mesh(moveGeo, moveMat);
        move.position.set(world.x, world.y + 0.33, world.z);
        move.rotation.y = site.yaw;
        move.renderOrder = 6;
        move.visible = false;
        moveLines.push(move);
        root.add(move);
        const pick = new THREE.Mesh(pickGeo, pickMat);
        pick.position.set(world.x, world.y + 0.35, world.z);
        pick.rotation.y = site.yaw;
        pick.layers.set(1);
        pick.userData.cell = { x, y };
        picks.push(pick);
        root.add(pick);
      }
    }

    const assault = createAssault();
    const gunner = createGunner();
    const support = createSupport();
    const boss = createBoss();
    const raiderWest = createRaider();
    const raiderEast = createRaider();
    // Meshes are built for one lot (about 8 world units). The tactics cell is
    // two lots on a side, so the same mesh is drawn at 2×.
    const unitScale = 2;
    assault.scale.multiplyScalar(unitScale);
    gunner.scale.multiplyScalar(unitScale);
    support.scale.multiplyScalar(unitScale);
    boss.scale.multiplyScalar(unitScale);
    raiderWest.scale.multiplyScalar(unitScale);
    raiderEast.scale.multiplyScalar(unitScale);
    const figures: Record<MechId, THREE.Group> = { Assault: assault, Gunner: gunner, Support: support };
    const markers = {
      Assault: marker(MECHA_FACTION_COLORS.friendly, 4.7, 6.3),
      Gunner: marker(MECHA_FACTION_COLORS.friendly, 4.3, 5.8),
      Support: marker(MECHA_FACTION_COLORS.friendly, 4.3, 5.8),
      boss: marker(MECHA_FACTION_COLORS.enemy, 10.2, 13, 4),
      raiderWest: marker(MECHA_FACTION_COLORS.enemy, 2.9, 4.1, 4),
      raiderEast: marker(MECHA_FACTION_COLORS.enemy, 2.9, 4.1, 4),
    };
    for (const figure of [assault, gunner, support, boss, raiderWest, raiderEast]) root.add(figure);
    for (const figure of viewRef.current.figures) {
      const feet = cellWorld(site, { x: figure.x, y: figure.y });
      figures[figure.id].position.set(feet.x, feet.y, feet.z);
    }
    boss.position.copy(footprintFeet(site, viewRef.current.boss));
    for (const [index, raider] of viewRef.current.raiders.entries()) {
      const mesh = [raiderWest, raiderEast][index];
      if (!mesh) break;
      const feet = cellWorld(site, { x: raider.x, y: raider.y });
      mesh.position.set(feet.x, feet.y, feet.z);
    }
    for (const ring of Object.values(markers)) root.add(ring.mesh);
    // Screen-space life bars stay crisp outside the city's pixel/bloom pass.
    // It follows the actual model, not the projected destination, and cannot intercept picks.
    const badgeLayer = badgeLayerRef.current!;
    const badgePoint = new THREE.Vector3();
    let badgeViewport = { width: 1, height: 1 };
    const unitBadges = Array.from({ length: 6 }, () => {
      const label = document.createElement("div"); label.className = "mecha-world-healthbar";
      label.setAttribute("role", "meter");
      const fill = document.createElement("span"); fill.className = "mecha-world-healthbar__fill";
      label.append(fill); badgeLayer.append(label);
      return { label, fill, signature: "" };
    });
    const showUnitBadge = (index: number, id: string, unit: THREE.Object3D, alive: boolean, hp: number | undefined, maxHp: number | undefined, selected = false) => {
      const badge = unitBadges[index]!;
      const identity = describeUnitIdentity(id, localeRef.current);
      badge.label.hidden = !alive || Boolean(performanceRef.current);
      if (badge.label.hidden) return;
      const health = unitHealth(hp, maxHp);
      const signature = `${id}:${localeRef.current}:${health.text}:${selected}`;
      if (signature !== badge.signature) {
        badge.label.dataset.unitId = id; badge.label.dataset.side = identity.side;
        badge.label.dataset.healthState = health.known ? "known" : "unknown";
        badge.label.classList.toggle("is-selected", selected);
        badge.label.classList.toggle("is-boss", id === "boss");
        badge.label.setAttribute("aria-label", `${identity.label} · HP ${health.text}`);
        badge.label.setAttribute("aria-valuetext", health.text);
        if (health.known) {
          badge.label.setAttribute("aria-valuemin", "0");
          badge.label.setAttribute("aria-valuemax", String(maxHp));
          badge.label.setAttribute("aria-valuenow", String(Math.min(hp!, maxHp!)));
          badge.fill.style.width = `${health.ratio * 100}%`;
        } else {
          for (const attribute of ["aria-valuemin", "aria-valuemax", "aria-valuenow"]) badge.label.removeAttribute(attribute);
          badge.fill.style.width = "0%";
        }
        badge.signature = signature;
      }
      // Stay attached to the actual model's head. Never displace a health bar
      // into a remote identity card or use leader lines to map it back.
      badgePoint.copy(unit.position); badgePoint.y += id === "boss" ? 25 : 14;
      badgePoint.project(engine.renderCamera);
      if (badgePoint.z < -1 || badgePoint.z > 1 || Math.abs(badgePoint.x) > 1 || Math.abs(badgePoint.y) > 1) {
        badge.label.hidden = true; return;
      }
      const x = (badgePoint.x + 1) / 2 * badgeViewport.width;
      const y = (1 - badgePoint.y) / 2 * badgeViewport.height;
      badge.label.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%)`;
    };

    const barGeo = new THREE.BoxGeometry(12, 0.5, 0.5);
    const barBg = new THREE.MeshStandardMaterial({ color: "#1b140f", roughness: 0.8 });
    const buildingMarkerGeo = new THREE.RingGeometry(4.5, 6, 4);
    const buildingMarkerMat = new THREE.MeshBasicMaterial({ color: "#fff3a3", side: THREE.DoubleSide, depthTest: false });
    const bars = new Map<string, { anchor: THREE.Group; fill: THREE.Mesh; fillMat: THREE.MeshStandardMaterial; marker: THREE.Mesh }>();
    for (const building of site.buildings) {
      const anchor = new THREE.Group();
      anchor.position.set(building.x, building.ground + building.height + 1.6, building.z);
      anchor.rotation.y = building.yaw;
      const back = new THREE.Mesh(barGeo, barBg);
      const fillMat = new THREE.MeshStandardMaterial({ color: "#e23d3d", emissive: "#7a1818", emissiveIntensity: 0.35, roughness: 0.45 });
      const fill = new THREE.Mesh(barGeo, fillMat);
      fill.scale.x = 1;
      const marker = new THREE.Mesh(buildingMarkerGeo, buildingMarkerMat);
      marker.rotation.x = -Math.PI / 2;
      marker.position.y = 2;
      marker.renderOrder = 10;
      marker.visible = false;
      anchor.add(back, fill, marker);
      bars.set(building.id, { anchor, fill, fillMat, marker });
      root.add(anchor);
    }

    lease.attach([root]);
    const gridPts: number[] = [];
    const corner = (x: number, y: number) => {
      const neighbors = [
        cellWorld(site, { x: Math.min(9, x), y: Math.min(9, y) }),
        cellWorld(site, { x: Math.max(0, x - 1), y: Math.min(9, y) }),
        cellWorld(site, { x: Math.min(9, x), y: Math.max(0, y - 1) }),
        cellWorld(site, { x: Math.max(0, x - 1), y: Math.max(0, y - 1) }),
      ];
      return {
        ...boardToWorld(site, x * site.cellW, y * site.cellD),
        y: Math.max(...neighbors.map((item) => item.y)) + 0.4,
      };
    };
    for (let i = 0; i <= BOARD; i += 1) {
      for (let j = 0; j < BOARD; j += 1) {
        const a = corner(i, j);
        const b = corner(i, j + 1);
        const c = corner(j, i);
        const d = corner(j + 1, i);
        gridPts.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, d.x, d.y, d.z);
      }
    }
    const gridGeo = new THREE.BufferGeometry();
    gridGeo.setAttribute("position", new THREE.Float32BufferAttribute(gridPts, 3));
    const grid = new THREE.LineSegments(gridGeo, new THREE.LineBasicMaterial({ color: "#9ec9ef", transparent: true, opacity: 0.72, toneMapped: false }));
    root.add(grid);
    // One physical-width perimeter separates the real site from city streets.
    const perimeterPoints: number[] = [];
    const edge = (x1: number, y1: number, x2: number, y2: number, dx: number, dy: number) => {
      const a = corner(x1, y1), b = corner(x2, y2);
      const c = boardToWorld(site, x2 * site.cellW + dx, y2 * site.cellD + dy);
      const d = boardToWorld(site, x1 * site.cellW + dx, y1 * site.cellD + dy);
      perimeterPoints.push(a.x, a.y + .04, a.z, b.x, b.y + .04, b.z, c.x, b.y + .04, c.z,
        a.x, a.y + .04, a.z, c.x, b.y + .04, c.z, d.x, a.y + .04, d.z);
    };
    for (let i = 0; i < BOARD; i += 1) {
      edge(i, 0, i + 1, 0, 0, .35); edge(i, BOARD, i + 1, BOARD, 0, -.35);
      edge(0, i, 0, i + 1, .35, 0); edge(BOARD, i, BOARD, i + 1, -.35, 0);
    }
    const perimeterGeo = new THREE.BufferGeometry();
    perimeterGeo.setAttribute("position", new THREE.Float32BufferAttribute(perimeterPoints, 3));
    const perimeterMat = new THREE.MeshBasicMaterial({ color: "#c1e6f4", side: THREE.DoubleSide, depthWrite: false, toneMapped: false });
    const perimeter = new THREE.Mesh(perimeterGeo, perimeterMat); perimeter.renderOrder = 2; root.add(perimeter);

    const camera = engine.renderCamera;
    // Keep the eye on the squad side of the street-aligned site. The slight
    // pitch reduction makes units less top-down without a fixed close-up.
    const center = boardToWorld(site, BOARD * site.cellW / 2, BOARD * site.cellD / 2);
    const offset = boardToWorld(site, 36, 56);
    const origin = boardToWorld(site, 0, 0);
    const direction = new THREE.Vector3(offset.x - origin.x, 175, offset.z - origin.z).normalize();
    const fitPoints = [...gridPts];
    let low = Infinity, high = -Infinity;
    for (let y = 0; y < BOARD; y += 1) for (let x = 0; x < BOARD; x += 1) {
      const cell = cellWorld(site, { x, y });
      low = Math.min(low, cell.y); high = Math.max(high, cell.y);
      // Include actual pick tops as well as grid corners: on a ridge a cell can
      // be below the maximum-neighbour height used to draw its corners.
      fitPoints.push(cell.x, cell.y + 0.65, cell.z);
    }
    const homeTarget = new THREE.Vector3(center.x, (low + high) / 2 + 2, center.z);
    const home = { fov: 40, minDistance: 45, maxDistance: 520 };
    const resetCamera = () => {
      const rect = canvas.getBoundingClientRect();
      const distance = fitMechaCameraDistance(fitPoints, homeTarget, direction, home.fov, rect.width, rect.height, camera.near);
      const position = direction.clone().multiplyScalar(distance).add(homeTarget);
      lease.setOrbitView({ ...home, position, target: homeTarget, maxDistance: Math.max(home.maxDistance, distance * 1.2) });
    };
    cameraCommands.current = {
      resetCamera,
      rotateCamera: () => {
        const current = engine.photoView();
        const target = new THREE.Vector3().fromArray(current.target);
        const offset = new THREE.Vector3().fromArray(current.position).sub(target);
        const maxDistance = Math.max(520, offset.length() * 1.2);
        const position = offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2).add(target);
        lease.setOrbitView({ position, target, fov: current.fov, minDistance: 45, maxDistance });
      },
    };
    resetCamera();

    const raycaster = new THREE.Raycaster();
    raycaster.layers.set(1);
    // 格子拾取在 layer 1。机甲网格在默认层，悬停归属用另一条射线，避免被格子层滤掉。
    const hoverRay = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let down: { x: number; y: number } | null = null;
    const onDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      down = { x: event.clientX, y: event.clientY };
    };
    const onUp = (event: PointerEvent) => {
      const start = down;
      down = null;
      if (!start || event.button !== 0 || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      root.updateMatrixWorld(true);
      const tileHit = raycaster.intersectObjects(picks, false)[0];
      const unitHit = unitUnderPointer();
      const cell = unitHit && (!tileHit || unitHit.distance <= tileHit.distance) ? unitHit.cell : tileHit?.object.userData.cell as Cell | undefined;
      if (cell) onCellRef.current(cell.x, cell.y, event.pointerType === "touch" ? "touch" : "mouse");
    };
    let hoveredId: string | null = null;
    const unitUnderPointer = (): { id: string; cell: Cell; distance: number } | null => {
      hoverRay.setFromCamera(pointer, camera);
      root.updateMatrixWorld(true);
      const current = viewRef.current;
      const roots: Array<{ mesh: THREE.Object3D; id: string; cell: Cell }> = [];
      current.figures.forEach(unit => { if (unit.alive) roots.push({ mesh: figures[unit.id], id: unit.id, cell: { x: unit.x, y: unit.y } }); });
      if (current.boss.alive) roots.push({ mesh: boss, id: "boss", cell: { x: current.boss.x, y: current.boss.y } });
      const small = [raiderWest, raiderEast];
      current.raiders.forEach((raider, index) => {
        const mesh = small[index];
        if (mesh && raider.alive) roots.push({ mesh, id: raider.id, cell: { x: raider.x, y: raider.y } });
      });
      for (const hit of hoverRay.intersectObjects(roots.map(item => item.mesh), true)) {
        let obj: THREE.Object3D | null = hit.object;
        let match: (typeof roots)[number] | undefined;
        let visible = true;
        while (obj) {
          if (!obj.visible) visible = false;
          match ??= roots.find(item => item.mesh === obj);
          obj = obj.parent;
        }
        if (visible && match) return { id: match.id, cell: match.cell, distance: hit.distance };
      }
      return null;
    };
    const enemyUnderPointer = (event: PointerEvent): string | null => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      const hit = unitUnderPointer();
      return hit && (hit.id === "boss" || viewRef.current.raiders.some(r => r.id === hit.id)) ? hit.id : null;
    };
    let hoveredCellKey = "";
    let hoverFrame = 0;
    let pendingMove: PointerEvent | null = null;
    const onMove = (event: PointerEvent) => {
      if (event.buttons !== 0 || event.pointerType !== "mouse") return;
      pendingMove = event;
      if (hoverFrame) return;
      hoverFrame = requestAnimationFrame(() => {
        hoverFrame = 0;
        const current = pendingMove;
        pendingMove = null;
        if (!current) return;
        const next = enemyUnderPointer(current);
        if (next !== hoveredId) {
          hoveredId = next;
          onHoverEnemyRef.current?.(next);
        }
        raycaster.setFromCamera(pointer, camera);
        const cell = raycaster.intersectObjects(picks, false)[0]?.object.userData.cell as Cell | undefined;
        const key = cell ? `${cell.x},${cell.y}` : "";
        if (key !== hoveredCellKey) {
          hoveredCellKey = key;
          onHoverCellRef.current?.(cell ?? null);
        }
      });
    };
    const onLeave = () => {
      if (hoverFrame) cancelAnimationFrame(hoverFrame);
      hoverFrame = 0;
      pendingMove = null;
      hoveredCellKey = "";
      onHoverCellRef.current?.(null);
      if (hoveredId !== null) {
        hoveredId = null;
        onHoverEnemyRef.current?.(null);
      }
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const spot = new THREE.Vector3();
    const actors = { Assault: assault, Gunner: gunner, Support: support, boss, "raider-w": raiderWest, "raider-e": raiderEast };
    const litUnits = [assault, gunner, support, boss, raiderWest, raiderEast];
    const animators = new Map<THREE.Object3D, MechaBattleAnimator>([assault, gunner, support, boss, raiderWest, raiderEast].map((mesh) => [mesh, new MechaBattleAnimator(mesh)]));
    const animate = (mesh: THREE.Object3D, id: string, hp: number, moving: boolean, dt: number) => {
      const cue = viewRef.current.combat;
      const animator = animators.get(mesh)!;
      animator.sync(hp, cue?.id ?? 0, cue?.actions.find((item) => item.actor === id)?.action);
      animator.update(dt, moving, reduce);
    };
    const actorMarkers = { Assault: markers.Assault, Gunner: markers.Gunner, Support: markers.Support, boss: markers.boss, "raider-w": markers.raiderWest, "raider-e": markers.raiderEast };
    const resolveCell = (cell: Cell, actor: string) => {
      if (actor === "boss") return footprintFeet(site, cell);
      const feet = cellWorld(site, cell);
      return new THREE.Vector3(feet.x, feet.y, feet.z);
    };
    // Numbers are derived only from events that the whole-turn prediction actually emitted.
    const orderMarkers: Array<{ sprite: THREE.Sprite; texture: THREE.CanvasTexture; material: THREE.SpriteMaterial; actor: string; origin: THREE.Vector3; slot: number; slots: number }> = [];
    let orderKey = "";
    const clearOrderMarkers = () => {
      for (const marker of orderMarkers) {
        root.remove(marker.sprite);
        marker.material.dispose();
        marker.texture.dispose();
      }
      orderMarkers.length = 0;
    };
    const syncOrderMarkers = (order: NonNullable<CityMechaView["enemyOrder"]>) => {
      const key = JSON.stringify(order);
      if (key === orderKey) return;
      orderKey = key;
      clearOrderMarkers();
      const validPosition = (cell: Cell | undefined): cell is Cell => Boolean(cell
        && Number.isInteger(cell.x) && Number.isInteger(cell.y)
        && cell.x >= 0 && cell.y >= 0 && cell.x < BOARD && cell.y < BOARD);
      const occupied = new Map<string, number>();
      const totals = new Map<string, number>();
      order.forEach((event) => {
        if (validPosition(event.position)) totals.set(cellKey(event.position), (totals.get(cellKey(event.position)) ?? 0) + 1);
      });
      order.forEach((event, index) => {
        const cell = event.position;
        if (!validPosition(cell)) return;
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 96;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.fillStyle = "#641b25";
        ctx.strokeStyle = "#fff3ce";
        ctx.lineWidth = 5;
        ctx.beginPath(); ctx.arc(48, 48, 39, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
        ctx.font = "bold 54px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillStyle = "#fff"; ctx.fillText(String(index + 1), 48, 50);
        const texture = new THREE.CanvasTexture(canvas);
        const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false, fog: false, toneMapped: false });
        const sprite = new THREE.Sprite(material);
        const world = cellWorld(site, cell);
        const count = occupied.get(cellKey(cell)) ?? 0;
        occupied.set(cellKey(cell), count + 1);
        const origin = new THREE.Vector3(world.x, world.y + 5, world.z);
        sprite.position.copy(origin);
        sprite.scale.set(5, 5, 1);
        sprite.renderOrder = 10;
        root.add(sprite);
        orderMarkers.push({ sprite, texture, material, actor: event.actor, origin, slot: count, slots: totals.get(cellKey(cell))! });
      });
    };
    let player: MechaPerformancePlayer | null = null;
    let releasePreview: (() => void) | null = null;
    const connectedPreview = useConnectedAssault(import.meta.env.DEV, location.search);
    const source = connectedPreview ? engine.captureMechaGroundSource() : null;
    let previewGround: Parameters<typeof createConnectedAssaultPreviewPlayer>[5] | undefined;
    let previewGroundError: unknown = null;
    if (connectedPreview) {
      try {
        if (!source) throw new Error("rendered city ground unavailable");
        const { layout, ground } = source.source;
        previewGround = {
          height: createAssaultCityGround(layout, ground, source.isCurrent),
          terrain: (x, z) => { if (!source.isCurrent()) throw new Error("Assault ground source is stale"); return terrainSurfaceHeight(layout, x, z); },
          radius: 2, maxGrade: .5, maxDrop: .3,
        };
      } catch (error) { previewGroundError = error; }
    }
    let playing: MechaPerformanceView | null = null;
    let idleGroundAsset: MechaGlbAsset | undefined;
    let idleGround: AssaultGroundController | undefined;
    let idleHeading: number | undefined;
    let previewFailed = false;
    let active = true;
    let candidateReady = !connectedPreview;
    if (connectedPreview) {
      onPreviewLoading?.(true);
      assault.visible = false;
      ensureMechaGlbAsset(assault, "Assault", "assault-connected-candidate").then(() => {
        if (!active) return;
        candidateReady = true;
        onPreviewLoading?.(false);
      }, (error) => {
        if (!active) return;
        previewFailed = true;
        console.error("[mecha] connected Assault candidate unavailable:", error);
        onPreviewLoading?.(false);
        onUnavailable?.("asset");
      });
    }
    const failPreview = (error: unknown) => {
      if (previewFailed) return;
      previewFailed = true;
      console.error("[mecha] connected Assault preview failed:", error);
      player?.dispose(); player = null;
      releasePreview?.(); releasePreview = null;
      onUnavailable?.("preview");
    };
    let lastFrame = globalThis.performance.now();
    const cameraRight = new THREE.Vector3();
    const cameraUp = new THREE.Vector3();
    const cameraPosition = new THREE.Vector3();
    lease.setFrameHook(() => {
      if (previewFailed) return;
      const now = globalThis.performance.now();
      const dt = Math.min(0.08, (now - lastFrame) / 1000);
      lastFrame = now;
      if (!candidateReady) return;
      // 夜间补光（见 unitLight.ts）。GLB 是异步原地升级的，升级后材质整套换掉，所以按 userData.glb 的变化重装
      setMechaUnitLight(engine.skyNight);
      for (const unit of litUnits) {
        const source = unit.userData.glb ?? "procedural";
        if (unit.userData.unitLightFor === source) continue;
        applyMechaUnitLight(unit);
        unit.userData.unitLightFor = source;
      }
      const current = viewRef.current;
      syncOrderMarkers(!performanceRef.current && current.projectedTelegraph != null ? (current.enemyOrder ?? []) : []);
      // Keep labels readable when a narrow view fits the board from farther
      // away. Non-attenuated sprite size is view-space; convert CSS pixels
      // using the vertical field of view and canvas height.
      const badgeBounds = canvas.getBoundingClientRect();
      badgeViewport = { width: badgeBounds.width, height: badgeBounds.height };
      const pixelScale = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / Math.max(1, canvas.getBoundingClientRect().height);
      const warningSize = pixelScale * 16;
      const orderSize = pixelScale * 24;
      camera.updateMatrixWorld();
      cameraRight.setFromMatrixColumn(camera.matrixWorld, 0);
      cameraUp.setFromMatrixColumn(camera.matrixWorld, 1);
      for (const marker of orderMarkers) {
        // Separate same-cell numbers in screen space, including at portrait
        // zoom levels and after rotation. Their order still comes from events.
        cameraPosition.copy(marker.origin).applyMatrix4(camera.matrixWorldInverse);
        const worldPerPixel = pixelScale * -cameraPosition.z;
        const offset = (marker.slot - (marker.slots - 1) / 2) * 27 * worldPerPixel;
        marker.sprite.position.copy(marker.origin).addScaledVector(cameraRight, offset).addScaledVector(cameraUp, 22 * worldPerPixel);
        marker.sprite.scale.set(orderSize, orderSize, 1);
        marker.material.opacity = !current.hoveredEnemy || current.hoveredEnemy === marker.actor ? 1 : 0.8;
      }
      // Old callers can still supply telegraph during the HUD migration. An
      // explicit empty declaration must not fall back to the interaction layer.
      const telegraph = new Set((performanceRef.current ? [] : (current.declaredTelegraph ?? current.telegraph)).map(cellKey));
      const projectedTelegraph = new Set((performanceRef.current ? [] : (current.projectedTelegraph ?? [])).map(cellKey));
      const focusedTelegraph = new Set([...current.focusedTelegraph, ...(current.inspectedThreats ?? [])].map(cellKey));
      const focus = new Set(current.focus.map(cellKey));
      const reach = new Set(current.reach.map(cellKey));
      const nextReachSignature = [...reach].sort().join(";");
      if (nextReachSignature !== reachSignature) {
        let count = 0;
        for (let index = 0; index < reachMatrices.length; index += 1) {
          if (reach.has(`${index % BOARD},${Math.floor(index / BOARD)}`)) {
            reachMarks.setMatrixAt(count++, reachMatrices[index]!);
          }
        }
        reachMarks.count = count;
        reachMarks.instanceMatrix.needsUpdate = true;
        reachSignature = nextReachSignature;
      }
      const targets = new Set(current.targets.map(cellKey));
      const targetIds = new Set(current.targetIds);
      const buildingCells = new Map<string, "building" | "rubble">();
      for (const building of current.buildings) {
        const role = building.hp > 0 ? "building" : "rubble";
        for (const cell of building.cells) buildingCells.set(cellKey(cell), role);
      }
      const obstacleCells = new Set((current.obstacles ?? []).map(cellKey));
      // Dense threat fields remain a readable board rather than a blanket of
      // floating badges. Ground patterns still show every cell; retain badges
      // where models/buildings can obscure them.
      const denseThreats = new Set([...telegraph, ...projectedTelegraph]).size > 24;
      const occupiedCells = new Set<string>();
      for (const figure of current.figures) if (figure.alive) occupiedCells.add(cellKey(figure));
      for (const raider of current.raiders) if (raider.alive) occupiedCells.add(cellKey(raider));
      if (current.boss.alive) for (let dy = 0; dy < 2; dy += 1) for (let dx = 0; dx < 2; dx += 1) {
        occupiedCells.add(cellKey({ x: current.boss.x + dx, y: current.boss.y + dy }));
      }
      const moveKey = !performanceRef.current && current.move ? cellKey(current.move) : "";
      pads.forEach((pad, index) => {
        const x = index % BOARD;
        const y = Math.floor(index / BOARD);
        const id = `${x},${y}`;
        const ground = site.terrain[y]?.[x];
        const role: Role = obstacleCells.has(id) ? "obstacle"
          : buildingCells.get(id) ?? (reach.has(id) ? "reach" : ground === "water" ? "water" : ground === "mountain" ? "mountain" : ground === "road" ? "road" : "empty");
        pad.material = padMat.get(role)!;
        const threat = threatLines[index]!;
        threat.visible = telegraph.has(id);
        // focusedTelegraph follows the compatibility layer: projection after a
        // successful preview, declaration only when the projection is unknown.
        // Do not imply attribution to the same enemy in both layers on overlap.
        const focusedDeclaration = current.projectedTelegraph == null;
        threat.material = focusedDeclaration && focusedTelegraph.has(id) ? focusThreatMat : focusedDeclaration && current.hoveredEnemy ? subduedThreatMat : threatMat;
        const warning = threatWarnings[index]!;
        const projected = projectedLines[index]!;
        projected.visible = projectedTelegraph.has(id);
        projected.material = !focusedDeclaration && focusedTelegraph.has(id) ? focusedProjectedMat : !focusedDeclaration && current.hoveredEnemy ? subduedProjectedMat : projectedMat;
        const overlap = threat.visible && projected.visible;
        const showBadge = !denseThreats || occupiedCells.has(id) || buildingCells.has(id) || obstacleCells.has(id);
        warning.visible = threat.visible && !overlap && showBadge;
        if (warning.visible) warning.scale.set(warningSize, warningSize, 1);
        warning.material = focusedDeclaration && focusedTelegraph.has(id) ? focusWarningMat : focusedDeclaration && current.hoveredEnemy ? subduedWarningMat : warningMat;
        const projectedWarning = projectedWarnings[index]!;
        projectedWarning.visible = projected.visible && showBadge;
        projectedWarning.material = overlap ? combinedWarningMat : focusedTelegraph.has(id) ? focusedProjectedWarningMat : current.hoveredEnemy ? subduedProjectedWarningMat : projectedWarningMat;
        projectedWarning.position.copy(overlap ? warning.position : projectedWarningPositions[index]!);
        if (projectedWarning.visible) {
          const size = warningSize * (overlap ? 1.125 : .875);
          projectedWarning.scale.set(size, size, 1);
        }
        targetLines[index]!.visible = targets.has(id);
        focusLines[index]!.visible = focus.has(id);
        moveLines[index]!.visible = id === moveKey;
      });
      const bossFeet = footprintFeet(site, current.boss);
      const performing = Boolean(performanceRef.current);
      if (!performing && playing) {
        try {
          const asset = connectedPreview ? getMechaGlbAsset(assault) : undefined;
          if (asset?.manifest.id === "assault-connected-candidate") {
            if (!previewGround) throw previewGroundError ?? new Error("Assault preview ground unavailable");
            if (idleGroundAsset !== asset || !idleGround) {
              idleGround = new AssaultGroundController(assault, { ...previewGround, asset });
              idleGroundAsset = asset;
            }
            idleHeading = idleGround.heading();
          }
          player?.dispose(); player = null;
          releasePreview?.(); releasePreview = null;
          playing = null;
        } catch (error) { failPreview(error); return; }
      }
      const validCell = (cell: Cell, span = 1) => Number.isInteger(cell.x) && Number.isInteger(cell.y)
        && cell.x >= 0 && cell.y >= 0 && cell.x + span <= BOARD && cell.y + span <= BOARD;
      const preview = performing ? undefined : current.targetPreview;
      const isBoss = Boolean(preview && current.boss.alive && preview.target.x === current.boss.x && preview.target.y === current.boss.y);
      const matchesUnit = Boolean(preview && (isBoss || current.figures.some(unit => unit.alive && unit.x === preview.target.x && unit.y === preview.target.y)
        || current.raiders.some(unit => unit.alive && unit.x === preview.target.x && unit.y === preview.target.y)));
      const span = isBoss ? 2 : 1;
      previewFrame.visible = Boolean(preview && matchesUnit && validCell(preview.target, span));
      shoveOutline.visible = shoveArrow.visible = false;
      if (preview && previewFrame.visible) {
        const at = isBoss ? footprintFeet(site, preview.target) : cellWorld(site, preview.target);
        let top = at.y;
        for (let dy = 0; dy < span; dy++) for (let dx = 0; dx < span; dx++) top = Math.max(top, cellWorld(site, { x: preview.target.x + dx, y: preview.target.y + dy }).y);
        previewFrame.position.set(at.x, top + .6, at.z); previewFrame.rotation.y = site.yaw; previewFrame.scale.set(span, 1, span);
        const shove = preview.shove;
        if (shove && validCell(shove.from, span) && validCell(shove.to, span) && (shove.from.x !== shove.to.x || shove.from.y !== shove.to.y)) {
          const from = isBoss ? footprintFeet(site, shove.from) : cellWorld(site, shove.from);
          const to = isBoss ? footprintFeet(site, shove.to) : cellWorld(site, shove.to);
          const dx = to.x - from.x, dz = to.z - from.z, length = Math.hypot(dx, dz);
          for (const [mesh, width] of [[shoveOutline, 4.2], [shoveArrow, 2.6]] as const) {
            mesh.visible = true; mesh.position.set(from.x, Math.max(from.y, to.y) + 1, from.z);
            mesh.rotation.y = -Math.atan2(dz, dx); mesh.scale.set(length, 1, width);
          }
        }
      }
      inspectionFrame.visible = Boolean(!performing && current.inspectedCell);
      if (inspectionFrame.visible && current.inspectedCell) {
        const at = cellWorld(site, current.inspectedCell);
        inspectionFrame.position.set(at.x, at.y + .8, at.z); inspectionFrame.rotation.y = site.yaw;
      }
      const segments = performing ? [] : current.inspectionSegments ?? [];
      while (inspectionArrows.length < segments.length) {
        const outline = new THREE.Mesh(shoveGeo, shoveOutlineMat), arrow = new THREE.Mesh(shoveGeo, attackRouteMat);
        outline.renderOrder = 15; arrow.renderOrder = 16; root.add(outline, arrow);
        inspectionArrows.push({ outline, arrow });
      }
      let drawnRoutes = 0;
      inspectionArrows.forEach(({ outline, arrow }, index) => {
        const segment = segments[index];
        outline.visible = arrow.visible = false;
        if (!segment) return;
        const from = cellWorld(site, segment.from), to = cellWorld(site, segment.to);
        // Fractional origins are footprint centers, so sample the underlying
        // integer tile for height rather than pretending a fractional row exists.
        from.y = cellWorld(site, { x: Math.floor(segment.from.x), y: Math.floor(segment.from.y) }).y;
        const dx = to.x - from.x, dz = to.z - from.z, length = Math.hypot(dx, dz);
        if (length < .01) return;
        arrow.material = segment.kind === "attack" ? attackRouteMat : moveRouteMat;
        for (const [mesh, width] of [[outline, 5.8], [arrow, 3.7]] as const) {
          mesh.visible = true; mesh.position.set(from.x, Math.max(from.y, to.y) + 1.2, from.z);
          mesh.rotation.y = -Math.atan2(dz, dx); mesh.scale.set(length, 1, width);
        }
        drawnRoutes++;
      });
      badgeLayer.dataset.inspectionRoutes = String(drawnRoutes);
      badgeLayer.dataset.inspectionRouteKind = segments[0]?.kind ?? "none";
      for (const figure of current.figures) {
        const mesh = figures[figure.id];
        const feet = cellWorld(site, { x: figure.x, y: figure.y });
        spot.set(feet.x, feet.y, feet.z);
        const candidate = connectedPreview && figure.id === "Assault" ? getMechaGlbAsset(mesh) : undefined;
        const connected = candidate?.manifest.id === "assault-connected-candidate";
        const moving = !connected && mesh.position.distanceToSquared(spot) > 0.01;
        if (!performing) {
          if (!pausedRef.current) slide(mesh, spot, reduce || connected);
          animate(mesh, figure.id, figure.alive ? 1 : 0, moving && figure.alive, pausedRef.current ? 0 : dt);
          if (connected) {
            try {
              if (!previewGround) throw previewGroundError ?? new Error("Assault preview ground unavailable");
              if (idleGroundAsset !== candidate || !idleGround) {
                idleGround = new AssaultGroundController(mesh, { ...previewGround, asset: candidate });
                idleGroundAsset = candidate;
                idleHeading = mesh.rotation.y;
              }
              const dx = bossFeet.x - spot.x, dz = bossFeet.z - spot.z;
              if (figure.alive && Math.hypot(dx, dz) > 1e-6) idleHeading = Math.atan2(-dx, -dz);
              idleGround.align(idleHeading ?? 0);
              if (figure.alive) idleGround.stand();
            } catch (error) { failPreview(error); return; }
          } else if (figure.alive) faceMechaTarget(mesh, spot, bossFeet);
        }
        mesh.visible = true;
        const ring = markers[figure.id];
        const targeted = targetIds.has(figure.id);
        ring.mesh.visible = figure.alive;
        ring.mesh.position.set(mesh.position.x, mesh.position.y + 0.55, mesh.position.z);
        ring.mesh.scale.setScalar(figure.selected ? 1.34 : targeted ? 1.2 : 1);
        ring.mat.color.set(figure.selected ? "#ffe08a" : MECHA_FACTION_COLORS.friendly);
        ring.mat.opacity = figure.selected || targeted ? 1 : 0.68;
      }
      const bossMoving = boss.position.distanceToSquared(bossFeet) > 0.01;
      if (!performing) {
        if (!pausedRef.current) slide(boss, bossFeet, reduce);
        animate(boss, "boss", current.boss.alive ? 1 : 0, bossMoving && current.boss.alive, pausedRef.current ? 0 : dt);
      }
      boss.visible = true;
      markers.boss.mesh.visible = current.boss.alive;
      markers.boss.mesh.position.set(boss.position.x, boss.position.y + 0.55, boss.position.z);
      const bossHovered = current.hoveredEnemy === "boss";
      markers.boss.mesh.scale.setScalar(targetIds.has("boss") || bossHovered ? 1.18 : 1);
      markers.boss.mat.opacity = targetIds.has("boss") || bossHovered ? 1 : 0.68;
      const nearest = current.figures.find((figure) => figure.alive);
      if (!performing && nearest && current.boss.alive) {
        const feet = cellWorld(site, { x: nearest.x, y: nearest.y });
        faceMechaTarget(boss, bossFeet, new THREE.Vector3(feet.x, feet.y, feet.z));
      }
      const small = [raiderWest, raiderEast];
      for (let i = 0; i < small.length; i += 1) {
        const mesh = small[i];
        const raider = current.raiders[i];
        if (!mesh) continue;
        if (!raider) {
          mesh.visible = false;
          continue;
        }
        const feet = cellWorld(site, { x: raider.x, y: raider.y });
        spot.set(feet.x, feet.y, feet.z);
        const moving = mesh.position.distanceToSquared(spot) > 0.01;
        if (!performing) {
          if (!pausedRef.current) slide(mesh, spot, reduce);
          animate(mesh, raider.id, raider.alive ? 1 : 0, moving && raider.alive, pausedRef.current ? 0 : dt);
        }
        mesh.visible = true;
        const ring = i === 0 ? markers.raiderWest : markers.raiderEast;
        ring.mesh.visible = raider.alive;
        ring.mesh.position.set(mesh.position.x, mesh.position.y + 0.55, mesh.position.z);
        const raiderHovered = current.hoveredEnemy === raider.id;
        ring.mesh.scale.setScalar(targetIds.has(raider.id) || raiderHovered ? 1.28 : 1);
        ring.mat.opacity = targetIds.has(raider.id) || raiderHovered ? 1 : 0.68;
        if (raider.alive && !performing) faceMechaTarget(mesh, spot, bossFeet);
      }
      if (!current.raiders[0]?.alive) markers.raiderWest.mesh.visible = false;
      if (!current.raiders[1]?.alive) markers.raiderEast.mesh.visible = false;
      if (playing !== performanceRef.current) {
        player?.dispose();
        player = null;
        releasePreview?.();
        releasePreview = null;
        playing = performanceRef.current;
        if (playing) {
          positionPerformanceActors(actors, current, resolveCell);
          const onComplete = () => onPerformanceCompleteRef.current();
          const initiallyFallen = [
            ...current.figures.filter((figure) => !figure.alive).map((figure) => figure.id),
            ...current.raiders.filter((raider) => !raider.alive).map((raider) => raider.id),
            ...(current.boss.alive ? [] : ["boss"]),
          ];
          if (connectedPreview) {
            try {
              if (!previewGround) throw previewGroundError ?? new Error("Assault preview ground unavailable");
              if (idleHeading !== undefined) assault.rotation.set(0, idleHeading, 0);
              const preview = createConnectedAssaultPreviewPlayer(actors, playing.events, resolveCell, root, onComplete, previewGround, initiallyFallen);
              player = preview.player;
              releasePreview = preview.release;
            } catch (error) { failPreview(error); return; }
          } else player = new MechaPerformancePlayer(actors, playing.events, resolveCell, root, onComplete, undefined, initiallyFallen);
        }
      }
      if (player) {
        if (connectedPreview) {
          try { player.update(reduce ? Number.POSITIVE_INFINITY : pausedRef.current ? 0 : dt); }
          catch (error) { failPreview(error); return; }
        } else player.update(reduce ? Number.POSITIVE_INFINITY : pausedRef.current ? 0 : dt);
        for (const [id, marker] of Object.entries(actorMarkers)) {
          const actor = actors[id as keyof typeof actors];
          marker.mesh.position.set(actor.position.x, actor.position.y + 0.55, actor.position.z);
          marker.mesh.visible = actor.visible;
        }
      }
      for (let i = 0; i < 3; i++) {
        const id = (["Assault", "Gunner", "Support"] as const)[i]!;
        const figure = current.figures.find(item => item.id === id);
        showUnitBadge(i, id, figures[id], Boolean(figure?.alive), figure?.hp, figure?.maxHp, Boolean(figure?.selected));
      }
      showUnitBadge(3, "boss", boss, current.boss.alive, current.boss.hp, current.boss.maxHp);
      for (let i = 0; i < 2; i++) showUnitBadge(4 + i, current.raiders[i]?.id ?? "unknown-raider", small[i]!, Boolean(current.raiders[i]?.alive), current.raiders[i]?.hp, current.raiders[i]?.maxHp);
      for (const building of site.buildings) {
        const bar = bars.get(building.id);
        const live = current.buildings.find((item) => item.id === building.id);
        if (!bar) continue;
        bar.anchor.visible = Boolean(live);
        bar.marker.visible = Boolean(live) && current.focusedBuilding === building.id;
        if (!live || live.maxHp <= 0) continue;
        const ratio = Math.max(0, Math.min(1, live.hp / live.maxHp));
        bar.fill.scale.x = Math.max(0.04, ratio);
        bar.fill.position.x = (ratio - 1) * 6;
        bar.fillMat.color.set(ratio > 0.5 ? "#d7b15a" : "#e23d3d");
      }
    });

    return () => {
      active = false;
      if (hoverFrame) cancelAnimationFrame(hoverFrame);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
      cameraCommands.current = null;
      player?.dispose();
      clearOrderMarkers();
      try { lease.release(); } catch { /* host already disposed the scene */ }
      for (const figure of [assault, gunner, support, boss, raiderWest, raiderEast]) disposeMechaModel(figure);
      releasePreview?.();
      setMechaUnitLight(0);
      gridGeo.dispose();
      perimeterGeo.dispose(); perimeterMat.dispose();
      attackRouteMat.dispose(); moveRouteMat.dispose(); inspectionFrameMat.dispose();
      previewGeo.dispose(); previewMat.dispose(); shoveGeo.dispose(); shoveOutlineMat.dispose(); shoveMat.dispose();
      for (const badge of unitBadges) { badge.label.remove(); }
      (grid.material as THREE.Material).dispose();
      padGeo.dispose();
      reachMarks.dispose();
      for (const geo of [threatGeo, projectedGeo, targetGeo, reachGeo, focusGeo, moveGeo]) geo.dispose();
      for (const mat of [threatMat, subduedThreatMat, focusThreatMat, projectedMat, focusedProjectedMat, subduedProjectedMat, targetMat, reachMat, focusMat, moveMat, warningMat, subduedWarningMat, focusWarningMat, projectedWarningMat, focusedProjectedWarningMat, subduedProjectedWarningMat, combinedWarningMat]) mat.dispose();
      warningTexture.dispose();
      projectedTexture.dispose();
      combinedTexture.dispose();
      pickGeo.dispose();
      pickMat.dispose();
      barGeo.dispose();
      barBg.dispose();
      buildingMarkerGeo.dispose();
      buildingMarkerMat.dispose();
      for (const mat of padMat.values()) mat.dispose();
      for (const bar of bars.values()) bar.fillMat.dispose();
      for (const ring of Object.values(markers)) {
        ring.geo.dispose();
        ring.mat.dispose();
      }
      if (engine.owner === "orbit") engine.restoreReturnView(saved);
    };
  }, [engine, site]);

  return <div ref={badgeLayerRef} className="mecha-world-unit-labels" aria-hidden="true" />;
});

/** Fit all four reset-view quarter turns, not an assumed square/flat city lot. */
function fitMechaCameraDistance(points: number[], target: THREE.Vector3, direction: THREE.Vector3, fov: number, width: number, height: number, near: number): number {
  width = Math.max(1, width); height = Math.max(1, height);
  const horizontalFraction = Math.max(0.1, 1 - 28 / width);
  // Leave room for top controls; map focus remains necessary for overlapping HUD.
  const verticalMargin = Math.min(60, height * 0.16);
  const verticalFraction = Math.max(0.1, 1 - 2 * verticalMargin / height);
  const verticalTan = Math.tan(THREE.MathUtils.degToRad(fov / 2));
  const horizontalTan = verticalTan * width / height;
  const axis = new THREE.Vector3(0, 1, 0);
  const point = new THREE.Vector3();
  let distance = 45;
  for (let turn = 0; turn < 4; turn += 1) {
    const facing = direction.clone().applyAxisAngle(axis, turn * Math.PI / 2);
    const right = new THREE.Vector3().crossVectors(axis, facing).normalize();
    const up = new THREE.Vector3().crossVectors(facing, right).normalize();
    for (let i = 0; i < points.length; i += 3) {
      point.set(points[i]!, points[i + 1]!, points[i + 2]!).sub(target);
      const depth = point.dot(facing);
      distance = Math.max(distance, depth + Math.max(near, 1),
        depth + Math.abs(point.dot(right)) / (horizontalTan * horizontalFraction),
        depth + Math.abs(point.dot(up)) / (verticalTan * verticalFraction));
    }
  }
  return distance;
}

function marker(color: string, inner: number, outer: number, sides = 28): { mesh: THREE.Mesh; geo: THREE.BufferGeometry; mat: THREE.MeshBasicMaterial } {
  const geo = new THREE.RingGeometry(inner, outer, sides);
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.92, depthWrite: false, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 3;
  return { mesh, geo, mat };
}

function cellKey(cell: Cell): string {
  return `${cell.x},${cell.y}`;
}

function footprintFeet(site: CityMechaSite, anchor: { x: number; y: number }): THREE.Vector3 {
  const cells = [
    { x: anchor.x, y: anchor.y },
    { x: anchor.x + 1, y: anchor.y },
    { x: anchor.x, y: anchor.y + 1 },
    { x: anchor.x + 1, y: anchor.y + 1 },
  ];
  let y = 0;
  for (const cell of cells) y += cellWorld(site, cell).y;
  const at = boardToWorld(site, (anchor.x + 1) * site.cellW, (anchor.y + 1) * site.cellD);
  return new THREE.Vector3(at.x, y / cells.length, at.z);
}

function slide(mesh: THREE.Object3D, goal: THREE.Vector3, snap: boolean) {
  if (snap || mesh.position.distanceTo(goal) > 96) mesh.position.copy(goal);
  else mesh.position.lerp(goal, 0.22);
}
