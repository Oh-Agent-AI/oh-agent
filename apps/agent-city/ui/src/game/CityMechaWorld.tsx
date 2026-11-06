/** Mechs and monsters standing on the city scene. The rules board stays in cell space. */
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as THREE from "three";
import type { DeclaredAttack, InspectionSegment } from "./mecha/cellInspection";
import { declaredIntentSegments } from "./mecha/enemyIntentPresentation";
import { tacticalAttackTrims, tacticalAttackWidths, tacticalMarkerMaterial, TACTICAL_COLORS } from "../render/mecha/tacticalMarkers";
import { unitHealth } from "./mecha/unitHealth";
import { describeUnitIdentity } from "./mecha/unitIdentity";
import type { GameLocale } from "./gameCopy";
import type { CityEngine } from "../engine/CityEngine";
import { boardToWorld, cellWorld, type CityMechaSite } from "./mecha/citySite";
import { MechaBattleAnimator, MechaPerformancePlayer, faceMechaTarget, type MechaCombatCue } from "../render/mecha/animation";
import { MECHA_FACTION_COLORS, createAssault, createBoss, createGunner, createRaider, createSupport, disposeMechaModel, ensureMechaGlbAsset, getMechaGlbAsset } from "../render/mecha/models";
import { createAssaultBattleHeight, createAssaultBattlePlayer } from "../render/mecha/assaultBattlePlayer";
import { useConnectedAssault } from "../render/mecha/connectedAssaultMode";
import { createAssaultCityGround } from "./assaultCityGround";
import { positionPerformanceActors } from "./mecha/positionPerformanceActors";
import { createMonsterSpeciesPresentation } from "./mecha/presentation/monsters/MonsterSpeciesPresentation";
import { terrainSurfaceHeight } from "../engine/surface/terrainSampling";
import { applyMechaUnitLight, setMechaUnitLight } from "../render/mecha/unitLight";
import type { MechaPerformanceEvent } from "./mecha/performance";
import { performanceDelta, type ReplaySpeed } from "./mecha/replayPlayback";
import type { HealthTimeline } from "./mecha/healthTimeline";
import type { PresentationChanges } from "./mecha/presentationChanges";
import { healthKey, performanceHealthSchedule } from "./mecha/performanceHealth";
import { BOARD, type Cell, type MechId } from "./mecha/rules";

export type CityMechaView = {
  figures: Array<{ id: MechId; x: number; y: number; alive: boolean; selected: boolean; hp?: number; maxHp?: number }>;
  boss: { x: number; y: number; alive: boolean; hp?: number; maxHp?: number };
  /** Optional presentation-only identity, projected from the displayed match. */
  bossSpeciesId?: string;
  raiders: Array<{ id: string; x: number; y: number; alive: boolean; hp?: number; maxHp?: number }>;
  buildings: Array<{ id: string; cells: Cell[]; hp: number; maxHp: number }>;
  focusedBuilding?: string | null;
  /** Current enemy declarations, independent of the draft simulation. */
  declaredTelegraph: Cell[];
  /** Attributed current intentions; never derived from projected enemyOrder. */
  declaredIntents?: DeclaredAttack[];
  /** null means unknown; an empty array means a successful prediction with no threats. */
  projectedTelegraph: Cell[] | null;
  /** Existing interaction/focus projection, retained for compatibility. */
  telegraph: Cell[];
  focusedTelegraph: Cell[];
  inspectedCell?: Cell | null;
  inspectionSegments?: InspectionSegment[];
  inspectedThreats?: Cell[];
  deployment?: boolean;
  focus: Cell[];
  reach: Cell[];
  move: Cell | null;
  targets: Cell[];
  targetIds: string[];
  /** Committed fields in the displayed snapshot, never the boss intent or forecast. */
  corrodeFields?: Array<{ id: string; cell: Cell }>;
  /** Rescue objective supplied by the caller; null/absent means no objective marker. */
  missionTarget?: Cell | null;
  /** Actual selected target anchor; shove is supplied only for a verified displacement. */
  targetPreview?: { target: Cell; shove?: { from: Cell; to: Cell; blocked?: boolean } };
  /** Mouse or list focus; other enemies' threats remain visible. */
  hoveredEnemy?: string | null;
  /** Position is the event's verified attack-time origin, not the current actor position. */
  enemyOrder?: Array<{ actor: string; cells: Cell[]; position?: Cell }>;
  combat?: { id: number; actions: MechaCombatCue[]; reset?: true; healthTimeline?: HealthTimeline; presentationChanges?: PresentationChanges };
  /** 规则里的障碍格（场景楼、斜放楼）。缺省当空。 */
  obstacles?: Cell[];
};

const ROLES = ["empty", "water", "mountain", "road", "move", "building", "rubble", "obstacle", "focus", "telegraph", "target"] as const;
type Role = (typeof ROLES)[number];

const ROLE_COLOR: Record<Role, string> = {
  empty: "#d5e4f2",
  water: "#2f86b8",
  mountain: "#a56b45",
  road: "#f2c14b",
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
  performanceSpeed?: ReplaySpeed;
  onPerformanceComplete: () => void;
  onCell: (x: number, y: number, input: "mouse" | "touch") => void;
  onHoverCell?: (cell: Cell | null) => void;
  onHoverEnemy?: (id: string | null) => void;
  onUnavailable?: (reason?: "preview" | "asset") => void;
  onPreviewLoading?: (loading: boolean) => void;
}>(function CityMechaWorld({ engine, site, locale = "zh-Hans", view, performance, paused, performanceSpeed = 1, onPerformanceComplete, onCell, onHoverCell, onHoverEnemy, onUnavailable, onPreviewLoading }, ref) {
  const badgeLayerRef = useRef<HTMLDivElement>(null);
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const viewRef = useRef(view);
  const performanceRef = useRef(performance);
  const pausedRef = useRef(paused);
  const performanceSpeedRef = useRef(performanceSpeed);
  const onCellRef = useRef(onCell);
  const onHoverEnemyRef = useRef(onHoverEnemy);
  const onHoverCellRef = useRef(onHoverCell);
  const onPerformanceCompleteRef = useRef(onPerformanceComplete);
  const cameraCommands = useRef<CityMechaWorldHandle | null>(null);
  viewRef.current = view;
  performanceRef.current = performance;
  pausedRef.current = paused;
  performanceSpeedRef.current = performanceSpeed;
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
    const padMat = new Map<Role, THREE.MeshStandardMaterial | THREE.MeshBasicMaterial>();
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
    // Many narrow red hatches read as an attacked area, not two route arrows.
    const threatVertices: number[] = [];
    for (const offset of [-1.2, -.8, -.4, 0, .4, .8, 1.2]) {
      const az = Math.max(-.8, -.8 - offset), bz = Math.min(.8, .8 - offset);
      const ax = az + offset, bx = bz + offset, n = .025;
      threatVertices.push((ax - n) * w, 0, (az + n) * d, (ax + n) * w, 0, (az - n) * d, (bx - n) * w, 0, (bz + n) * d,
        (bx - n) * w, 0, (bz + n) * d, (ax + n) * w, 0, (az - n) * d, (bx + n) * w, 0, (bz - n) * d);
    }
    threatGeo.setAttribute("position", new THREE.Float32BufferAttribute(threatVertices, 3));
    // Forecasts stay near the tile rim, leaving the attack hatches unobstructed.
    // Their thin dashed outline is secondary to the solid current-danger frame.
    const projectedGeo = new THREE.BufferGeometry();
    const projectedSegments: number[] = [];
    const predictionBox: Array<[number, number]> = [[-w * .83, -d * .83], [w * .83, -d * .83], [w * .83, d * .83], [-w * .83, d * .83], [-w * .83, -d * .83]];
    for (let edge = 0; edge < 4; edge += 1) {
      const [x1, z1] = predictionBox[edge]!, [x2, z2] = predictionBox[edge + 1]!;
      for (const start of [0, .36, .72]) {
        const end = start + .24, dx = x2 - x1, dz = z2 - z1;
        const nx = -dz * .022, nz = dx * .022;
        const ax = x1 + dx * start, az = z1 + dz * start, bx = x1 + dx * end, bz = z1 + dz * end;
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
    const dangerFrameGeo = new THREE.BufferGeometry();
    dangerFrameGeo.setAttribute("position", new THREE.Float32BufferAttribute([
      ...rect(-w, -d, w, -d * .925), ...rect(-w, d * .925, w, d),
      ...rect(-w, -d * .925, -w * .925, d * .925), ...rect(w * .925, -d * .925, w, d * .925),
    ], 3));
    // An open-corner footprint identifies the attacker; a closed striped tile
    // identifies the victim. Do not outline both with the same danger square.
    const sourceGeo = new THREE.BufferGeometry();
    const sourceCorners: number[] = [];
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      sourceCorners.push(...rect(sx * w, sz * d, sx * w * .70, sz * d * .925));
      sourceCorners.push(...rect(sx * w, sz * d * .925, sx * w * .925, sz * d * .70));
    }
    sourceGeo.setAttribute("position", new THREE.Float32BufferAttribute(sourceCorners, 3));
    const dangerFillGeo = new THREE.BufferGeometry();
    dangerFillGeo.setAttribute("position", new THREE.Float32BufferAttribute(rect(-w, -d, w, d), 3));
    const dangerFrameMat = tacticalMarkerMaterial(TACTICAL_COLORS.declared, 1, false);
    const subduedDangerFrameMat = tacticalMarkerMaterial(TACTICAL_COLORS.declared, .65, false);
    const dangerFillMat = tacticalMarkerMaterial(TACTICAL_COLORS.declared, .24);
    const focusedDangerFillMat = tacticalMarkerMaterial(TACTICAL_COLORS.declared, .38);
    const subduedDangerFillMat = tacticalMarkerMaterial(TACTICAL_COLORS.declared, .15);
    const sourceMat = tacticalMarkerMaterial(TACTICAL_COLORS.declared, 1, false);
    const subduedSourceMat = tacticalMarkerMaterial(TACTICAL_COLORS.declared, .65, false);
    const subduedAttackRouteMat = tacticalMarkerMaterial(TACTICAL_COLORS.attack, .60, false);
    const subduedRouteOutlineMat = tacticalMarkerMaterial(TACTICAL_COLORS.outline, .60, false);

    // Reach is a quiet, continuous tile wash, not four movement arrows per cell.
    // Independent of terrain pads, so legal road/building cells retain their base
    // identity. Actual direction appears only on the inspected/planned route.
    const reachGeo = new THREE.BufferGeometry();
    reachGeo.setAttribute("position", new THREE.Float32BufferAttribute(rect(-w, -d, w, d), 3));
    // Two solid diamonds mark a reachable danger cell without tinting away
    // the hatching. They are not route arrows or the hollow destination.
    const overlapReachDiamonds = (scale: number) => {
      const vertices: number[] = [];
      for (const x of [-w * .55, w * .55]) {
        const rx = w * .25 * scale, rz = d * .25 * scale;
        vertices.push(x, 0, -rz, x + rx, 0, 0, x, 0, rz,
          x, 0, -rz, x, 0, rz, x - rx, 0, 0);
      }
      return new THREE.Float32BufferAttribute(vertices, 3);
    };
    const overlapReachRimGeo = new THREE.BufferGeometry();
    overlapReachRimGeo.setAttribute("position", overlapReachDiamonds(1));
    const overlapReachGeo = new THREE.BufferGeometry();
    overlapReachGeo.setAttribute("position", overlapReachDiamonds(.68));
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
    // Rescue is a separate layer, not a movement, attack or threat tile. The
    // octagonal rim leaves the center available for overlapping tactical marks.
    const missionGeo = new THREE.BufferGeometry();
    const missionVertices: number[] = [];
    const octagon = (radius: number): Array<[number, number]> => Array.from({ length: 8 }, (_, i) => {
      const angle = Math.PI / 8 + i * Math.PI / 4;
      return [Math.cos(angle) * w * radius, Math.sin(angle) * d * radius];
    });
    const missionOuter = octagon(.78), missionInner = octagon(.65);
    for (let i = 0; i < 8; i += 1) {
      const [ax, az] = missionOuter[i]!, [bx, bz] = missionOuter[(i + 1) % 8]!;
      const [cx, cz] = missionInner[i]!, [dx, dz] = missionInner[(i + 1) % 8]!;
      missionVertices.push(ax, 0, az, bx, 0, bz, cx, 0, cz, bx, 0, bz, dx, 0, dz, cx, 0, cz);
    }
    missionGeo.setAttribute("position", new THREE.Float32BufferAttribute(missionVertices, 3));
    const missionMat = tacticalMarkerMaterial("#c98cff");
    const missionRim = new THREE.Mesh(missionGeo, missionMat);
    missionRim.name = "mecha-mission-target-rim";
    missionRim.renderOrder = 9; missionRim.visible = false; root.add(missionRim);
    // A purple rescue cross remains legible over units/terrain without relying
    // only on color. Like the existing danger badges it faces the camera.
    const missionCanvas = document.createElement("canvas");
    missionCanvas.width = missionCanvas.height = 96;
    const missionContext = missionCanvas.getContext("2d");
    if (missionContext) {
      missionContext.beginPath();
      missionContext.moveTo(48, 4); missionContext.lineTo(88, 21); missionContext.lineTo(88, 65);
      missionContext.lineTo(48, 92); missionContext.lineTo(8, 65); missionContext.lineTo(8, 21); missionContext.closePath();
      missionContext.fillStyle = "#632a9c"; missionContext.fill();
      missionContext.lineWidth = 5; missionContext.strokeStyle = "#f5e4ff"; missionContext.stroke();
      missionContext.fillStyle = "#ffffff";
      missionContext.fillRect(39, 21, 18, 50); missionContext.fillRect(23, 37, 50, 18);
    }
    const missionTexture = new THREE.CanvasTexture(missionCanvas);
    const missionBadgeMat = new THREE.SpriteMaterial({ map: missionTexture, transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false, fog: false, toneMapped: false });
    const missionBadge = new THREE.Sprite(missionBadgeMat);
    missionBadge.name = "mecha-mission-target-badge";
    missionBadge.renderOrder = 10; missionBadge.visible = false; root.add(missionBadge);
    // Persistent corroded ground is independent of targeting and danger layers.
    // Sparse broken strokes leave the tile center readable; the fixed-size badge
    // identifies the field even when terrain or a unit obscures the ground.
    const corrodeGeo = new THREE.BufferGeometry();
    const corrodeVertices: number[] = [];
    const stroke = (x1: number, z1: number, x2: number, z2: number) => {
      const dx = x2 - x1, dz = z2 - z1, length = Math.hypot(dx, dz);
      const nx = -dz / length * .035, nz = dx / length * .035;
      corrodeVertices.push((x1 + nx) * w, 0, (z1 + nz) * d, (x1 - nx) * w, 0, (z1 - nz) * d, (x2 + nx) * w, 0, (z2 + nz) * d,
        (x2 + nx) * w, 0, (z2 + nz) * d, (x1 - nx) * w, 0, (z1 - nz) * d, (x2 - nx) * w, 0, (z2 - nz) * d);
    };
    stroke(-.72, -.45, -.45, -.22); stroke(-.45, -.22, -.55, .08); stroke(-.55, .08, -.3, .34);
    stroke(.68, .48, .4, .24); stroke(.4, .24, .5, -.04); stroke(.5, -.04, .25, -.32);
    corrodeGeo.setAttribute("position", new THREE.Float32BufferAttribute(corrodeVertices, 3));
    const corrodeMat = tacticalMarkerMaterial("#b7ef65", .9);
    const corrodeCanvas = document.createElement("canvas");
    corrodeCanvas.width = corrodeCanvas.height = 96;
    const corrodeContext = corrodeCanvas.getContext("2d");
    if (corrodeContext) {
      corrodeContext.beginPath(); corrodeContext.moveTo(48, 4); corrodeContext.lineTo(89, 26);
      corrodeContext.lineTo(89, 70); corrodeContext.lineTo(48, 92); corrodeContext.lineTo(7, 70); corrodeContext.lineTo(7, 26); corrodeContext.closePath();
      corrodeContext.fillStyle = "#315728"; corrodeContext.fill();
      corrodeContext.lineWidth = 5; corrodeContext.strokeStyle = "#dcff9c"; corrodeContext.stroke();
      corrodeContext.beginPath(); corrodeContext.moveTo(57, 18); corrodeContext.lineTo(39, 42); corrodeContext.lineTo(54, 49); corrodeContext.lineTo(37, 77);
      corrodeContext.lineWidth = 8; corrodeContext.lineJoin = "round"; corrodeContext.strokeStyle = "#ffffff"; corrodeContext.stroke();
    }
    const corrodeTexture = new THREE.CanvasTexture(corrodeCanvas);
    const corrodeBadgeMat = new THREE.SpriteMaterial({ map: corrodeTexture, transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false, fog: false, toneMapped: false });
    const corrodeMarks: Array<{ ground: THREE.Mesh; badge: THREE.Sprite; cell: Cell }> = [];
    for (let y = 0; y < BOARD; y++) for (let x = 0; x < BOARD; x++) {
      const cell = { x, y }, at = cellWorld(site, cell);
      const ground = new THREE.Mesh(corrodeGeo, corrodeMat);
      ground.name = `mecha-corrode-ground-${x}-${y}`;
      ground.position.set(at.x, at.y + .34, at.z); ground.rotation.y = site.yaw;
      ground.renderOrder = 8; ground.visible = false;
      const badge = new THREE.Sprite(corrodeBadgeMat);
      badge.name = `mecha-corrode-badge-${x}-${y}`;
      badge.renderOrder = 10; badge.visible = false;
      root.add(ground, badge); corrodeMarks.push({ ground, badge, cell });
    }
    const threatMat = tacticalMarkerMaterial(TACTICAL_COLORS.declared, .9);
    const subduedThreatMat = tacticalMarkerMaterial(TACTICAL_COLORS.declared, .6);
    const focusThreatMat = tacticalMarkerMaterial(TACTICAL_COLORS.declared);
    const projectedMat = tacticalMarkerMaterial(TACTICAL_COLORS.projected, .85);
    const overlapProjectedMat = tacticalMarkerMaterial(TACTICAL_COLORS.projected, .58);
    const focusedProjectedMat = tacticalMarkerMaterial("#e3fbff");
    const subduedProjectedMat = tacticalMarkerMaterial(TACTICAL_COLORS.projected, .65);
    const targetMat = tacticalMarkerMaterial("#ffd166");
    const reachMat = tacticalMarkerMaterial(TACTICAL_COLORS.reach, .32);
    const overlapReachRimMat = tacticalMarkerMaterial("#102b23");
    const overlapReachMat = tacticalMarkerMaterial("#a4ffd0");
    const focusMat = new THREE.LineBasicMaterial({ color: "#39d6a3", depthWrite: false, fog: false, toneMapped: false });
    const moveMat = tacticalMarkerMaterial("#ffe08a");
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
    // The square warning stays visible even when terrain or units occlude the
    // ground marker; its silhouette differs from the declaration triangle.
    const projectedCanvas = document.createElement("canvas");
    projectedCanvas.width = projectedCanvas.height = 96;
    const projectedContext = projectedCanvas.getContext("2d");
    if (projectedContext) {
      projectedContext.fillStyle = "#07526d"; projectedContext.fillRect(9, 9, 78, 78);
      projectedContext.lineWidth = 5; projectedContext.strokeStyle = "#e3fbff"; projectedContext.setLineDash([14, 7]); projectedContext.strokeRect(9, 9, 78, 78);
      projectedContext.font = "bold 54px sans-serif"; projectedContext.textAlign = "center"; projectedContext.textBaseline = "middle";
      projectedContext.fillStyle = "#fff"; projectedContext.fillText("!", 48, 51);
    }
    const projectedTexture = new THREE.CanvasTexture(projectedCanvas);
    const projectedWarningMat = new THREE.SpriteMaterial({ map: projectedTexture, transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false, fog: false, toneMapped: false });
    const focusedProjectedWarningMat = new THREE.SpriteMaterial({ map: projectedTexture, color: "#ffffff", transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false, fog: false, toneMapped: false });
    const subduedProjectedWarningMat = new THREE.SpriteMaterial({ map: projectedTexture, color: "#999999", transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false, fog: false, toneMapped: false });
    // On overlap, one red warning with a cyan dashed rim replaces two badges.
    // No unexplained P/!P initials; the two ground layers remain independent.
    const combinedCanvas = document.createElement("canvas");
    combinedCanvas.width = combinedCanvas.height = 96;
    const combinedContext = combinedCanvas.getContext("2d");
    if (combinedContext) {
      combinedContext.fillStyle = "#d7192d"; combinedContext.fillRect(9, 9, 78, 78);
      combinedContext.lineWidth = 5; combinedContext.strokeStyle = "#92e6ff";
      combinedContext.setLineDash([14, 7]); combinedContext.strokeRect(9, 9, 78, 78);
      combinedContext.font = "bold 54px sans-serif"; combinedContext.textAlign = "center"; combinedContext.textBaseline = "middle";
      combinedContext.fillStyle = "#fff"; combinedContext.fillText("!", 48, 51);
    }
    const combinedTexture = new THREE.CanvasTexture(combinedCanvas);
    const combinedWarningMat = new THREE.SpriteMaterial({ map: combinedTexture, transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false, fog: false, toneMapped: false });
    const threatLines: THREE.Mesh[] = [];
    const dangerFrames: THREE.Mesh[] = [];
    const dangerFills: THREE.Mesh[] = [];
    const intentSources: Array<{ frame: THREE.Mesh; outline: THREE.Mesh }> = [];
    const intentArrows: Array<{ outline: THREE.Mesh; arrow: THREE.Mesh }> = [];
    const emptyIntents: DeclaredAttack[] = [];
    let lastIntents: DeclaredAttack[] | undefined;
    let lastIntentFocus: string | null | undefined;
    let lastInspectingAttack = false;
    let overviewRays: Array<InspectionSegment & { actor: string; footprint: number }> = [];
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
    const overlapReachRims = new THREE.InstancedMesh(overlapReachRimGeo, overlapReachRimMat, BOARD * BOARD);
    const overlapReachMarks = new THREE.InstancedMesh(overlapReachGeo, overlapReachMat, BOARD * BOARD);
    for (const [mesh, order] of [[overlapReachRims, 9], [overlapReachMarks, 10]] as const) {
      mesh.count = 0; mesh.renderOrder = order; mesh.frustumCulled = false; root.add(mesh);
    }
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
    const shoveOutlineMat = tacticalMarkerMaterial(TACTICAL_COLORS.outline, 1, false);
    const shoveMat = tacticalMarkerMaterial(TACTICAL_COLORS.shove, 1, false);
    const shoveOutline = new THREE.Mesh(shoveGeo, shoveOutlineMat), shoveArrow = new THREE.Mesh(shoveGeo, shoveMat);
    shoveOutline.renderOrder = 12; shoveArrow.renderOrder = 13;
    shoveOutline.visible = shoveArrow.visible = false; root.add(shoveOutline, shoveArrow);
    // Corner brackets mark the ACTUAL final footprint, not the attempted cell.
    const shoveLandingGeo = new THREE.BufferGeometry();
    shoveLandingGeo.setAttribute("position", new THREE.Float32BufferAttribute([
      ...rect(-w, -d, -w * .48, -d * .88), ...rect(w * .48, -d, w, -d * .88),
      ...rect(-w, d * .88, -w * .48, d), ...rect(w * .48, d * .88, w, d),
      ...rect(-w, -d * .88, -w * .88, -d * .48), ...rect(w * .88, -d * .88, w, -d * .48),
      ...rect(-w, d * .48, -w * .88, d * .88), ...rect(w * .88, d * .48, w, d * .88),
    ], 3));
    const collisionMat = tacticalMarkerMaterial(TACTICAL_COLORS.attack, 1, false);
    const shoveLanding = new THREE.Mesh(shoveLandingGeo, shoveMat);
    shoveLanding.renderOrder = 14; shoveLanding.visible = false; root.add(shoveLanding);
    const collisionGeo = new THREE.BufferGeometry();
    collisionGeo.setAttribute("position", new THREE.Float32BufferAttribute(rect(-1, -.1, 1, .1), 3));
    const collisionCross = [new THREE.Mesh(collisionGeo, collisionMat), new THREE.Mesh(collisionGeo, collisionMat)];
    for (const mesh of collisionCross) { mesh.renderOrder = 15; mesh.visible = false; root.add(mesh); }
    const attackRouteMat = tacticalMarkerMaterial(TACTICAL_COLORS.attack, 1, false);
    const moveRouteMat = tacticalMarkerMaterial(TACTICAL_COLORS.move, 1, false);
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
        threat.renderOrder = 6;
        threat.visible = false;
        threatLines.push(threat);
        root.add(threat);
        const dangerFill = new THREE.Mesh(dangerFillGeo, dangerFillMat);
        dangerFill.position.set(world.x, world.y + .29, world.z); dangerFill.rotation.y = site.yaw;
        dangerFill.renderOrder = 5; dangerFill.visible = false; dangerFills.push(dangerFill); root.add(dangerFill);
        const dangerFrame = new THREE.Mesh(dangerFrameGeo, dangerFrameMat);
        dangerFrame.position.set(world.x, world.y + .33, world.z); dangerFrame.rotation.y = site.yaw;
        dangerFrame.renderOrder = 7; dangerFrame.visible = false; dangerFrames.push(dangerFrame); root.add(dangerFrame);
        const projected = new THREE.Mesh(projectedGeo, projectedMat);
        projected.position.set(world.x, world.y + 0.305, world.z);
        projected.rotation.y = site.yaw;
        projected.renderOrder = 8;
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
    // Meshes are built for one lot (about 8 world units). The tactics cell is
    // two lots on a side, so the same mesh is drawn at 2×.
    const unitScale = 2;
    assault.scale.multiplyScalar(unitScale);
    gunner.scale.multiplyScalar(unitScale);
    support.scale.multiplyScalar(unitScale);
    boss.scale.multiplyScalar(unitScale);
    const figures: Record<MechId, THREE.Group> = { Assault: assault, Gunner: gunner, Support: support };
    const markers = {
      Assault: marker(MECHA_FACTION_COLORS.friendly, 4.7, 6.3),
      Gunner: marker(MECHA_FACTION_COLORS.friendly, 4.3, 5.8),
      Support: marker(MECHA_FACTION_COLORS.friendly, 4.3, 5.8),
      boss: marker(MECHA_FACTION_COLORS.enemy, 10.2, 13, 4),
    };
    // Align the square marker to the board and size it to the 2×2 footprint.
    markers.boss.geo.rotateY(Math.PI / 4);
    markers.boss.mesh.rotation.y = site.yaw;
    for (const figure of [assault, gunner, support, boss]) root.add(figure);
    let displayedBossSpecies = viewRef.current.bossSpeciesId;
    let bossSpeciesVisual = createMonsterSpeciesPresentation(boss, displayedBossSpecies, { visualScale: Math.min(site.cellW, site.cellD) / 8 });
    for (const figure of viewRef.current.figures) {
      const feet = cellWorld(site, { x: figure.x, y: figure.y });
      figures[figure.id].position.set(feet.x, feet.y, feet.z);
    }
    boss.position.copy(footprintFeet(site, viewRef.current.boss));
    for (const ring of Object.values(markers)) root.add(ring.mesh);
    // Screen-space life bars stay crisp outside the city's pixel/bloom pass.
    // It follows the actual model, not the projected destination, and cannot intercept picks.
    const badgeLayer = badgeLayerRef.current!;
    const badgePoint = new THREE.Vector3();
    let badgeViewport = { width: 1, height: 1 };
    const createUnitBadge = () => {
      const label = document.createElement("div"); label.className = "mecha-world-healthbar";
      label.setAttribute("role", "meter");
      const fill = document.createElement("span"); fill.className = "mecha-world-healthbar__fill";
      label.append(fill); badgeLayer.append(label);
      return { label, fill, signature: "" };
    };
    const unitBadges = Array.from({ length: 4 }, createUnitBadge);
    const showUnitBadge = (badge: ReturnType<typeof createUnitBadge>, id: string, unit: THREE.Object3D, alive: boolean, hp: number | undefined, maxHp: number | undefined, selected = false, raider?: { id: string }) => {
      const identity = describeUnitIdentity(id, localeRef.current, raider);
      badge.label.hidden = !alive || (Boolean(performanceRef.current) && !performanceHealth);
      if (badge.label.hidden) return;
      const health = unitHealth(hp, maxHp);
      const signature = `${id}:${localeRef.current}:${identity.side}:${identity.label}:${health.text}:${selected}`;
      if (signature !== badge.signature) {
        badge.label.dataset.unitId = id; badge.label.dataset.side = identity.side;
        badge.label.dataset.healthState = health.known ? "known" : "unknown";
        badge.label.classList.toggle("is-selected", selected);
        badge.label.classList.toggle("is-boss", id === "boss");
        badge.label.setAttribute("aria-label", `${identity.label} · ${identity.sideLabel} · HP ${health.text}`);
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
    // Keep the eye on the squad side of the street-aligned site. Equal rise
    // and horizontal reach give a 45-degree view instead of a near-overhead one.
    // Distance is still fitted to the terrain and viewport, not a fixed close-up.
    const center = boardToWorld(site, BOARD * site.cellW / 2, BOARD * site.cellD / 2);
    const offset = boardToWorld(site, 36, 56);
    const origin = boardToWorld(site, 0, 0);
    const dx = offset.x - origin.x, dz = offset.z - origin.z;
    const direction = new THREE.Vector3(dx, Math.hypot(dx, dz), dz).normalize();
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
      if (current.boss.alive) {
        const cell = { x: current.boss.x, y: current.boss.y };
        roots.push({ mesh: boss, id: "boss", cell });
        // The geometric body is a sibling of the animation rig, but is the
        // same rule entity. Include its actual silhouette in pointer picking.
        if (bossSpeciesVisual.pickRoot) roots.push({ mesh: bossSpeciesVisual.pickRoot, id: "boss", cell });
      }
      current.raiders.forEach(raider => {
        const mesh = raiderModels.get(raider.id)?.mesh;
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
    // IDs, not array slots, own a model for the lifetime of a displayed actor.
    // A null prototype also permits arbitrary IDs without object-prototype collisions.
    const actors: Record<string, THREE.Group> = Object.assign(Object.create(null), { Assault: assault, Gunner: gunner, Support: support, boss });
    const litUnits = [assault, gunner, support, boss];
    const animators = new Map<THREE.Object3D, MechaBattleAnimator>(litUnits.map((mesh) => [mesh, new MechaBattleAnimator(mesh)]));
    const raiderModels = new Map<string, { mesh: THREE.Group; ring: ReturnType<typeof marker>; badge: ReturnType<typeof createUnitBadge> }>();
    const removeRaider = (id: string) => {
      const model = raiderModels.get(id);
      if (!model) return;
      model.mesh.removeFromParent(); model.ring.mesh.removeFromParent();
      disposeMechaModel(model.mesh);
      model.ring.geo.dispose(); model.ring.mat.dispose(); model.badge.label.remove();
      animators.delete(model.mesh); delete actors[id]; raiderModels.delete(id);
    };
    const syncRaiders = (raiders: CityMechaView["raiders"], retainPlaybackActors: boolean) => {
      const ids = new Set(raiders.map(raider => raider.id));
      for (const [id, model] of raiderModels) if (!ids.has(id)) {
        model.mesh.visible = false; model.ring.mesh.visible = false; model.badge.label.hidden = true;
        // The player owns a fixed set of actor references until disposed.
        if (!retainPlaybackActors) removeRaider(id);
      }
      for (const raider of raiders) {
        if (raiderModels.has(raider.id) || Object.hasOwn(actors, raider.id)) continue;
        const mesh = createRaider();
        mesh.scale.multiplyScalar(unitScale);
        const feet = cellWorld(site, raider);
        mesh.position.set(feet.x, feet.y, feet.z);
        const ring = marker(MECHA_FACTION_COLORS.enemy, 2.9, 4.1, 4);
        const badge = createUnitBadge();
        root.add(mesh, ring.mesh);
        raiderModels.set(raider.id, { mesh, ring, badge });
        actors[raider.id] = mesh;
        animators.set(mesh, new MechaBattleAnimator(mesh));
      }
    };
    const animate = (mesh: THREE.Object3D, id: string, hp: number, moving: boolean, dt: number) => {
      const cue = viewRef.current.combat;
      const animator = animators.get(mesh)!;
      animator.sync(hp, cue?.id ?? 0, cue?.actions.find((item) => item.actor === id)?.action);
      animator.update(dt, moving, reduce);
    };
    const actorMarkers = { Assault: markers.Assault, Gunner: markers.Gunner, Support: markers.Support, boss: markers.boss };
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
    // Presentation-only health, advanced on settled animation cues. Never edits match state.
    let performanceHealth: Map<string, number> | null = null;
    let performanceFields: Map<string, Cell> | null = null;
    let releasePreview: (() => void) | null = null;
    const connectedPreview = useConnectedAssault(import.meta.env.DEV, location.search);
    let roadHeight: ((x: number, z: number) => number) | undefined;
    let terrainHeight: ((x: number, z: number) => number) | undefined;
    if (connectedPreview) {
      try {
        const source = engine.captureMechaGroundSource();
        if (source) {
          const { layout, ground } = source.source;
          terrainHeight = (x, z) => { if (!source.isCurrent()) throw new Error("stale city terrain"); return terrainSurfaceHeight(layout, x, z); };
          roadHeight = createAssaultCityGround(layout, ground, source.isCurrent);
        }
      } catch { /* Detailed ground is optional for board-driven battle playback. */ }
    }
    const battleHeight = createAssaultBattleHeight(roadHeight, terrainHeight);
    let playing: MechaPerformanceView | null = null;
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
      const current = viewRef.current;
      if (playing !== performanceRef.current) {
        player?.dispose(); player = null;
        releasePreview?.(); releasePreview = null;
      }
      // Pre-create only actors justified by verified spawn cues. They remain
      // hidden until the player reaches that cue and are not added to picking.
      const births = (performanceRef.current?.events ?? []).filter(event => event.kind === "raider_spawn");
      const currentRaiderIds = new Set(current.raiders.map(raider => raider.id));
      const playbackRaiders: CityMechaView["raiders"] = [...current.raiders, ...births
        .filter(event => !currentRaiderIds.has(event.actor))
        .map(event => ({ id: event.actor, x: event.at.x, y: event.at.y, alive: true, hp: event.hp, maxHp: event.hp }))];
      syncRaiders(playbackRaiders, Boolean(player));
      // 夜间补光（见 unitLight.ts）。GLB 是异步原地升级的，升级后材质整套换掉，所以按 userData.glb 的变化重装
      setMechaUnitLight(engine.skyNight);
      for (const unit of [...litUnits, ...Array.from(raiderModels.values(), model => model.mesh)]) {
        const source = unit.userData.glb ?? "procedural";
        if (unit.userData.unitLightFor === source) continue;
        applyMechaUnitLight(unit);
        unit.userData.unitLightFor = source;
      }
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
      // Keep danger prominent, but don't hide reachability on danger cells.
      const plainReach = [...reach].filter(id => !telegraph.has(id)).sort();
      const dangerReach = [...reach].filter(id => telegraph.has(id)).sort();
      const nextReachSignature = `${plainReach.join(";")}|${dangerReach.join(";")}`;
      if (nextReachSignature !== reachSignature) {
        let count = 0, overlapCount = 0;
        for (let index = 0; index < reachMatrices.length; index += 1) {
          const id = `${index % BOARD},${Math.floor(index / BOARD)}`;
          if (!reach.has(id)) continue;
          if (telegraph.has(id)) {
            overlapReachRims.setMatrixAt(overlapCount, reachMatrices[index]!);
            overlapReachMarks.setMatrixAt(overlapCount++, reachMatrices[index]!);
          } else {
            reachMarks.setMatrixAt(count++, reachMatrices[index]!);
          }
        }
        reachMarks.count = count;
        overlapReachRims.count = overlapReachMarks.count = overlapCount;
        reachMarks.instanceMatrix.needsUpdate = true;
        overlapReachRims.instanceMatrix.needsUpdate = overlapReachMarks.instanceMatrix.needsUpdate = true;
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
      // Empty terrain is already explained by its ground pattern. Screen-facing
      // warnings are an occlusion fallback on units/buildings, not a second
      // blanket of symbols across every threatened tile.
      const occupiedCells = new Set<string>();
      for (const figure of current.figures) if (figure.alive) occupiedCells.add(cellKey(figure));
      for (const raider of current.raiders) if (raider.alive) occupiedCells.add(cellKey(raider));
      if (current.boss.alive) for (let dy = 0; dy < 2; dy += 1) for (let dx = 0; dx < 2; dx += 1) {
        occupiedCells.add(cellKey({ x: current.boss.x + dx, y: current.boss.y + dy }));
      }
      const moveKey = !performanceRef.current && current.move ? cellKey(current.move) : "";
      const declaredFocus = new Set((current.inspectedThreats ?? []).map(cellKey));
      pads.forEach((pad, index) => {
        const x = index % BOARD;
        const y = Math.floor(index / BOARD);
        const id = `${x},${y}`;
        const ground = site.terrain[y]?.[x];
        const role: Role = obstacleCells.has(id) ? "obstacle"
          : buildingCells.get(id) ?? (ground === "water" ? "water" : ground === "mountain" ? "mountain" : ground === "road" ? "road" : "empty");
        pad.material = padMat.get(role)!;
        const threat = threatLines[index]!;
        threat.visible = telegraph.has(id);
        // Red focus uses the inspected current declaration. Blue focus follows
        // the compatibility forecast layer. Overlap is not shared attribution.
        const focusedDeclaration = current.projectedTelegraph == null;
        const focused = declaredFocus.has(id), subdued = Boolean(current.hoveredEnemy && !focused);
        threat.material = focused ? focusThreatMat : subdued ? subduedThreatMat : threatMat;
        dangerFrames[index]!.visible = dangerFills[index]!.visible = threat.visible;
        dangerFrames[index]!.material = subdued ? subduedDangerFrameMat : dangerFrameMat;
        dangerFills[index]!.material = focused ? focusedDangerFillMat : subdued ? subduedDangerFillMat : dangerFillMat;
        const warning = threatWarnings[index]!;
        const projected = projectedLines[index]!;
        projected.visible = projectedTelegraph.has(id);
        const overlap = threat.visible && projected.visible;
        projected.material = overlap ? overlapProjectedMat : !focusedDeclaration && focusedTelegraph.has(id) ? focusedProjectedMat : !focusedDeclaration && current.hoveredEnemy ? subduedProjectedMat : projectedMat;
        const showBadge = occupiedCells.has(id) || buildingCells.has(id) || obstacleCells.has(id);
        warning.visible = threat.visible && !overlap && showBadge;
        if (warning.visible) warning.scale.set(warningSize, warningSize, 1);
        warning.material = focused ? focusWarningMat : subdued ? subduedWarningMat : warningMat;
        const projectedWarning = projectedWarnings[index]!;
        projectedWarning.visible = projected.visible && showBadge;
        projectedWarning.material = overlap ? combinedWarningMat : focusedTelegraph.has(id) ? focusedProjectedWarningMat : current.hoveredEnemy ? subduedProjectedWarningMat : projectedWarningMat;
        projectedWarning.position.copy(overlap ? warning.position : projectedWarningPositions[index]!);
        if (projectedWarning.visible) {
          const size = warningSize * (overlap ? 1 : .875);
          projectedWarning.scale.set(size, size, 1);
        }
        targetLines[index]!.visible = targets.has(id);
        focusLines[index]!.visible = focus.has(id);
        moveLines[index]!.visible = id === moveKey;
      });
      const mission = current.missionTarget;
      const hasMission = mission != null && Number.isInteger(mission.x) && Number.isInteger(mission.y)
        && mission.x >= 0 && mission.y >= 0 && mission.x < BOARD && mission.y < BOARD;
      missionRim.visible = missionBadge.visible = hasMission;
      if (hasMission) {
        const world = cellWorld(site, mission);
        missionRim.position.set(world.x, world.y + .36, world.z);
        missionRim.rotation.y = site.yaw;
        // Board-local top edge keeps this badge apart from corner warnings.
        const badgeAt = boardToWorld(site, (mission.x + .5) * site.cellW, (mission.y + .18) * site.cellD);
        missionBadge.position.set(badgeAt.x, world.y + .8, badgeAt.z);
        // Lift the screen-facing symbol above the cell so its 20px silhouette
        // does not blanket the move and danger marks on small boards.
        cameraPosition.copy(missionBadge.position).applyMatrix4(camera.matrixWorldInverse);
        missionBadge.position.addScaledVector(cameraUp, pixelScale * -cameraPosition.z * 14);
        missionBadge.scale.set(pixelScale * 20, pixelScale * 20, 1);
      }
      const bossFeet = footprintFeet(site, current.boss);
      const performing = Boolean(performanceRef.current);
      if (!performing && playing) {
        try {
          player?.dispose(); player = null;
          releasePreview?.(); releasePreview = null;
          playing = null;
          performanceHealth = null;
          performanceFields = null;
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
      shoveLanding.visible = false;
      for (const mesh of collisionCross) mesh.visible = false;
      if (preview && previewFrame.visible) {
        const at = isBoss ? footprintFeet(site, preview.target) : cellWorld(site, preview.target);
        let top = at.y;
        for (let dy = 0; dy < span; dy++) for (let dx = 0; dx < span; dx++) top = Math.max(top, cellWorld(site, { x: preview.target.x + dx, y: preview.target.y + dy }).y);
        previewFrame.position.set(at.x, top + .6, at.z); previewFrame.rotation.y = site.yaw; previewFrame.scale.set(span, 1, span);
        const shove = preview.shove;
        if (shove && validCell(shove.from, span) && validCell(shove.to, span)) {
          const landed = isBoss ? footprintFeet(site, shove.to) : cellWorld(site, shove.to);
          let landingTop = landed.y;
          for (let dy = 0; dy < span; dy++) for (let dx = 0; dx < span; dx++) landingTop = Math.max(landingTop, cellWorld(site, { x: shove.to.x + dx, y: shove.to.y + dy }).y);
          shoveLanding.visible = true; shoveLanding.material = shove.blocked ? collisionMat : shoveMat;
          shoveLanding.position.set(landed.x, landingTop + 1.2, landed.z);
          shoveLanding.rotation.y = site.yaw; shoveLanding.scale.set(span, 1, span);
          if (shove.blocked) for (const [i, mesh] of collisionCross.entries()) {
            mesh.visible = true; mesh.position.set(landed.x, landingTop + 1.4, landed.z);
            mesh.rotation.y = site.yaw + (i === 0 ? Math.PI / 4 : -Math.PI / 4);
            mesh.scale.set(Math.min(w, d) * span * .62, 1, Math.min(w, d) * span * .62);
          }
        }
        if (shove && !shove.blocked && validCell(shove.from, span) && validCell(shove.to, span) && (shove.from.x !== shove.to.x || shove.from.y !== shove.to.y)) {
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
        const intent = (current.declaredIntents ?? emptyIntents).find(i =>
          i.origin.x + (i.footprint - 1) / 2 === segment.from.x && i.origin.y + (i.footprint - 1) / 2 === segment.from.y);
        const [startTrim, endTrim] = segment.kind === "attack"
          ? tacticalAttackTrims(length, segment.to.x - segment.from.x, segment.to.y - segment.from.y, site.cellW, site.cellD, intent?.footprint ?? 1) : [0, 0];
        arrow.material = segment.kind === "attack" ? attackRouteMat : moveRouteMat;
        spot.set(from.x, Math.max(from.y, to.y), from.z).applyMatrix4(camera.matrixWorldInverse);
        const [outlineWidth, arrowWidth] = segment.kind === "attack"
          ? tacticalAttackWidths(pixelScale * Math.abs(spot.z), Math.min(site.cellW, site.cellD)) : [4.8, 3.7];
        for (const [mesh, width] of [[outline, outlineWidth], [arrow, arrowWidth]] as const) {
          mesh.visible = true; mesh.position.set(from.x + dx * startTrim / length, Math.max(from.y, to.y) + 1.2, from.z + dz * startTrim / length);
          mesh.rotation.y = -Math.atan2(dz, dx); mesh.scale.set(length - startTrim - endTrim, 1, width);
        }
        drawnRoutes++;
      });
      badgeLayer.dataset.inspectionRoutes = String(drawnRoutes);
      badgeLayer.dataset.inspectionRouteKind = segments[0]?.kind ?? "none";
      // Default overview is attributed to the current living enemy, even when
      // the friendly draft predicts its death. Area targets remain a set; only
      // boundary/central aim rays are drawn, never a fictitious traversal.
      const intents = performing ? emptyIntents : current.declaredIntents ?? emptyIntents;
      while (intentSources.length < intents.length) {
        const outline = new THREE.Mesh(sourceGeo, shoveOutlineMat), frame = new THREE.Mesh(sourceGeo, sourceMat);
        outline.renderOrder = 17; frame.renderOrder = 18; root.add(outline, frame); intentSources.push({ outline, frame });
      }
      intentSources.forEach(({ outline, frame }, index) => {
        const intent = intents[index]; outline.visible = frame.visible = Boolean(intent);
        if (!intent) return;
        const at = cellWorld(site, { x: intent.origin.x + (intent.footprint - 1) / 2, y: intent.origin.y + (intent.footprint - 1) / 2 });
        let height = cellWorld(site, intent.origin).y;
        for (let y = 0; y < intent.footprint; y++) for (let x = 0; x < intent.footprint; x++) {
          height = Math.max(height, cellWorld(site, { x: intent.origin.x + x, y: intent.origin.y + y }).y);
        }
        const subdued = Boolean(current.hoveredEnemy && current.hoveredEnemy !== intent.actor);
        frame.material = subdued ? subduedSourceMat : sourceMat; outline.material = subdued ? subduedRouteOutlineMat : shoveOutlineMat;
        for (const [mesh, size] of [[outline, 1.035], [frame, 1]] as const) {
          mesh.position.set(at.x, height + .8, at.z); mesh.rotation.y = site.yaw; mesh.scale.set(intent.footprint * size, 1, intent.footprint * size);
        }
      });
      const inspectingAttack = segments.some(s => s.kind === "attack");
      if (intents !== lastIntents || current.hoveredEnemy !== lastIntentFocus || inspectingAttack !== lastInspectingAttack) {
        overviewRays = intents.flatMap(intent => {
          // The existing inspection renderer already draws this actor's rays.
          if (current.hoveredEnemy === intent.actor && inspectingAttack) return [];
          return declaredIntentSegments(intent).map(segment => ({ ...segment, actor: intent.actor, footprint: intent.footprint }));
        });
        lastIntents = intents; lastIntentFocus = current.hoveredEnemy; lastInspectingAttack = inspectingAttack;
      }
      while (intentArrows.length < overviewRays.length) {
        const outline = new THREE.Mesh(shoveGeo, shoveOutlineMat), arrow = new THREE.Mesh(shoveGeo, attackRouteMat);
        outline.renderOrder = 15; arrow.renderOrder = 16; root.add(outline, arrow); intentArrows.push({ outline, arrow });
      }
      intentArrows.forEach(({ outline, arrow }, index) => {
        const ray = overviewRays[index]; outline.visible = arrow.visible = false;
        if (!ray) return;
        const from = cellWorld(site, ray.from), to = cellWorld(site, ray.to);
        from.y = cellWorld(site, { x: Math.floor(ray.from.x), y: Math.floor(ray.from.y) }).y;
        const dx = to.x - from.x, dz = to.z - from.z, length = Math.hypot(dx, dz);
        if (length < .01) return;
        // Same footprint/landing insets as selected attacks, so selection does
        // not jump the route back through the model or the landing's hatch.
        const [startTrim, endTrim] = tacticalAttackTrims(length, ray.to.x - ray.from.x, ray.to.y - ray.from.y, site.cellW, site.cellD, ray.footprint);
        const subdued = Boolean(current.hoveredEnemy && current.hoveredEnemy !== ray.actor);
        arrow.material = subdued ? subduedAttackRouteMat : attackRouteMat; outline.material = subdued ? subduedRouteOutlineMat : shoveOutlineMat;
        spot.set(from.x, Math.max(from.y, to.y), from.z).applyMatrix4(camera.matrixWorldInverse);
        const [outlineWidth, arrowWidth] = tacticalAttackWidths(pixelScale * Math.abs(spot.z), Math.min(site.cellW, site.cellD));
        for (const [mesh, width] of [[outline, outlineWidth], [arrow, arrowWidth]] as const) {
          mesh.visible = true; mesh.position.set(from.x + dx * startTrim / length, Math.max(from.y, to.y) + 1.2, from.z + dz * startTrim / length);
          mesh.rotation.y = -Math.atan2(dz, dx); mesh.scale.set(length - startTrim - endTrim, 1, width);
        }
      });
      badgeLayer.dataset.declaredIntentActors = intents.map(i => i.actor).join(",");
      badgeLayer.dataset.declaredIntentRoutes = String(intentArrows.filter(r => r.arrow.visible).length);
      badgeLayer.dataset.declaredDangerCells = String(dangerFrames.filter(m => m.visible).length);

      for (const id of ["Assault", "Gunner", "Support"] as const) {
        if (!current.figures.some(f => f.id === id)) { figures[id].visible = false; markers[id].mesh.visible = false; }
      }
      for (const figure of current.figures) {
        const mesh = figures[figure.id];
        const feet = cellWorld(site, { x: figure.x, y: figure.y });
        spot.set(feet.x, feet.y, feet.z);
        if (!mesh.visible && current.deployment) mesh.position.copy(spot);
        const candidate = connectedPreview && figure.id === "Assault" ? getMechaGlbAsset(mesh) : undefined;
        const connected = candidate?.manifest.id === "assault-connected-candidate";
        // Draft movement uses the same slide + walk for every mech. Ground
        // height sampling must not force Assault to snap or keep it walking at rest.
        const moving = (mesh.position.x - spot.x) ** 2 + (mesh.position.z - spot.z) ** 2 > 0.01;
        if (!performing) {
          if (!pausedRef.current) slide(mesh, spot, reduce);
          animate(mesh, figure.id, figure.alive ? 1 : 0, moving && figure.alive, pausedRef.current ? 0 : dt);
          if (connected) mesh.position.y = battleHeight(mesh.position.x, mesh.position.z, spot.y);
          if (figure.alive) faceMechaTarget(mesh, spot, bossFeet);
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
      const bossMarkerEmphasis = targetIds.has("boss") || bossHovered ? 1.18 : 1;
      markers.boss.mesh.scale.set(site.cellW * Math.SQRT2 / 13 * bossMarkerEmphasis, 1, site.cellD * Math.SQRT2 / 13 * bossMarkerEmphasis);
      markers.boss.mat.opacity = targetIds.has("boss") || bossHovered ? 1 : 0.68;
      const nearest = current.figures.find((figure) => figure.alive);
      if (!performing && nearest && current.boss.alive) {
        const feet = cellWorld(site, { x: nearest.x, y: nearest.y });
        faceMechaTarget(boss, bossFeet, new THREE.Vector3(feet.x, feet.y, feet.z));
      }
      for (const raider of current.raiders) {
        const model = raiderModels.get(raider.id);
        if (!model) continue;
        const { mesh, ring } = model;
        const feet = cellWorld(site, { x: raider.x, y: raider.y });
        spot.set(feet.x, feet.y, feet.z);
        const moving = mesh.position.distanceToSquared(spot) > 0.01;
        if (!performing) {
          if (!pausedRef.current) slide(mesh, spot, reduce);
          animate(mesh, raider.id, raider.alive ? 1 : 0, moving && raider.alive, pausedRef.current ? 0 : dt);
        }
        if (!performing) mesh.visible = true;
        ring.mesh.visible = raider.alive && mesh.visible;
        ring.mesh.position.set(mesh.position.x, mesh.position.y + 0.55, mesh.position.z);
        const raiderHovered = current.hoveredEnemy === raider.id;
        ring.mesh.scale.setScalar(targetIds.has(raider.id) || raiderHovered ? 1.28 : 1);
        ring.mat.opacity = targetIds.has(raider.id) || raiderHovered ? 1 : 0.68;
        if (raider.alive && !performing) faceMechaTarget(mesh, spot, bossFeet);
      }
      if (playing !== performanceRef.current) {
        playing = performanceRef.current;
        performanceHealth = null;
        performanceFields = playing ? new Map((current.corrodeFields ?? []).map(field => [field.id, field.cell])) : null;
        if (playing) {
          // Playback snapshots the actor dictionary: roster changes during an
          // existing performance must not mutate the player's position table.
          const performanceActors = Object.assign(Object.create(null), actors) as Record<string, THREE.Group>;
          positionPerformanceActors(performanceActors, current, resolveCell);
          const schedule = performanceHealthSchedule(playing.events, current.combat?.healthTimeline, current.combat?.presentationChanges);
          const initial = new Map<string, number>();
          for (const unit of current.figures) if (unit.hp !== undefined) initial.set(healthKey("mech", unit.id), unit.hp);
          if (current.boss.hp !== undefined) initial.set(healthKey("boss", "boss"), current.boss.hp);
          for (const unit of current.raiders) if (unit.hp !== undefined) initial.set(healthKey("raider", unit.id), unit.hp);
          for (const building of current.buildings) initial.set(healthKey("building", building.id), building.hp);
          // A missing or mismatched snapshot is not safe to display as current health.
          const verified = new Map(initial);
          const valid = schedule?.every((effects, index) => {
            const cue = playing?.events[index];
            const id = cue && (cue.kind === "raider_spawn" || cue.kind === "raider_remove") ? healthKey("raider", cue.actor) : null;
            if (cue?.kind === "raider_spawn" && id) {
              if (verified.has(id)) return false;
              verified.set(id, cue.hp);
            }
            if (!effects.every((effect) => {
              const key = healthKey(effect.kind, effect.id);
              if (verified.get(key) !== effect.before) return false;
              verified.set(key, effect.after);
              return true;
            })) return false;
            if (cue?.kind === "raider_remove" && id) {
              if (verified.get(id) !== cue.hp) return false;
              verified.delete(id);
            }
            return true;
          });
          if (valid) performanceHealth = initial;
          const onEventSettled = (index: number) => {
            const event = playing?.events[index];
            if (performanceHealth && schedule) {
              if (event?.kind === "raider_spawn") performanceHealth.set(healthKey("raider", event.actor), event.hp);
              for (const effect of schedule[index] ?? []) performanceHealth.set(healthKey(effect.kind, effect.id), effect.after);
              if (event?.kind === "raider_remove") performanceHealth.delete(healthKey("raider", event.actor));
            }
            if (event?.kind === "corrode_field" && performanceFields) {
              if (event.change === "created") performanceFields.set(event.fieldId, event.cell);
              else {
                const previous = performanceFields.get(event.fieldId);
                if (previous && previous.x === event.cell.x && previous.y === event.cell.y) performanceFields.delete(event.fieldId);
              }
            }
          };
          const onComplete = () => onPerformanceCompleteRef.current();
          const initiallyFallen = [
            ...current.figures.filter((figure) => !figure.alive).map((figure) => figure.id),
            ...current.raiders.filter((raider) => !raider.alive).map((raider) => raider.id),
            ...(current.boss.alive ? [] : ["boss"]),
          ];
          if (connectedPreview) {
            try {
              const preview = createAssaultBattlePlayer(performanceActors, playing.events, resolveCell, root, onComplete, battleHeight, initiallyFallen, onEventSettled);
              player = preview.player;
              releasePreview = preview.release;
            } catch (error) { failPreview(error); return; }
          } else player = new MechaPerformancePlayer(performanceActors, playing.events, resolveCell, root, onComplete, undefined, initiallyFallen, onEventSettled);
        }
      }
      if (player) {
        const performanceDt = performanceDelta(dt, pausedRef.current, reduce, performanceSpeedRef.current);
        if (connectedPreview) {
          try { player.update(performanceDt); }
          catch (error) { failPreview(error); return; }
        } else player.update(performanceDt);
        for (const [id, marker] of Object.entries(actorMarkers)) {
          const actor = actors[id]!;
          marker.mesh.position.set(actor.position.x, actor.position.y + 0.55, actor.position.z);
          marker.mesh.visible = actor.visible;
        }
        for (const { mesh, ring } of raiderModels.values()) {
          ring.mesh.position.set(mesh.position.x, mesh.position.y + 0.55, mesh.position.z);
          ring.mesh.visible = mesh.visible;
        }
      }
      // Apply settled cues in this same frame. An interrupted or completed
      // playback instead takes its fields directly from the displayed snapshot.
      const visibleFields = new Set((performanceFields ? Array.from(performanceFields.values()) : (current.corrodeFields ?? []).map(field => field.cell))
        .filter(cell => validCell(cell)).map(cellKey));
      for (const mark of corrodeMarks) {
        mark.ground.visible = mark.badge.visible = visibleFields.has(cellKey(mark.cell));
        if (!mark.badge.visible) continue;
        const at = cellWorld(site, mark.cell);
        const corner = boardToWorld(site, (mark.cell.x + .2) * site.cellW, (mark.cell.y + .8) * site.cellD);
        mark.badge.position.set(corner.x, at.y + .8, corner.z);
        cameraPosition.copy(mark.badge.position).applyMatrix4(camera.matrixWorldInverse);
        mark.badge.position.addScaledVector(cameraUp, pixelScale * -cameraPosition.z * 8);
        mark.badge.scale.set(pixelScale * 14, pixelScale * 14, 1);
      }
      // The player may move or rotate the rig; sync its visual sibling last.
      if (current.bossSpeciesId !== displayedBossSpecies) {
        bossSpeciesVisual.dispose();
        displayedBossSpecies = current.bossSpeciesId;
        bossSpeciesVisual = createMonsterSpeciesPresentation(boss, displayedBossSpecies, { visualScale: Math.min(site.cellW, site.cellD) / 8 });
      }
      const bossDisplayHp = performanceHealth?.get(healthKey("boss", "boss")) ?? current.boss.hp;
      const bossHealth = bossDisplayHp !== undefined && current.boss.maxHp !== undefined
        ? { hp: bossDisplayHp, maxHp: current.boss.maxHp } : undefined;
      bossSpeciesVisual.update(pausedRef.current ? 0 : dt, reduce, bossHealth);
      for (let i = 0; i < 3; i++) {
        const id = (["Assault", "Gunner", "Support"] as const)[i]!;
        const figure = current.figures.find(item => item.id === id);
        const hp = performanceHealth?.get(healthKey("mech", id)) ?? figure?.hp;
        showUnitBadge(unitBadges[i]!, id, figures[id], Boolean(figure?.alive), hp, figure?.maxHp, Boolean(figure?.selected));
      }
      showUnitBadge(unitBadges[3]!, "boss", boss, current.boss.alive, performanceHealth?.get(healthKey("boss", "boss")) ?? current.boss.hp, current.boss.maxHp);
      // The raider list proves enemy side, but this view does not carry summon metadata.
      for (const raider of playbackRaiders) {
        const model = raiderModels.get(raider.id);
        if (model) showUnitBadge(model.badge, raider.id, model.mesh, raider.alive && model.mesh.visible,
          performanceHealth?.get(healthKey("raider", raider.id)) ?? raider.hp, raider.maxHp, false, raider);
      }
      for (const building of site.buildings) {
        const bar = bars.get(building.id);
        const live = current.buildings.find((item) => item.id === building.id);
        if (!bar) continue;
        bar.anchor.visible = Boolean(live) && (!playing || Boolean(performanceHealth));
        bar.marker.visible = Boolean(live) && current.focusedBuilding === building.id;
        if (!live || live.maxHp <= 0) continue;
        const hp = performanceHealth?.get(healthKey("building", building.id)) ?? live.hp;
        const ratio = Math.max(0, Math.min(1, hp / live.maxHp));
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
      bossSpeciesVisual.dispose();
      clearOrderMarkers();
      try { lease.release(); } catch { /* host already disposed the scene */ }
      for (const id of raiderModels.keys()) removeRaider(id);
      for (const figure of [assault, gunner, support, boss]) disposeMechaModel(figure);
      releasePreview?.();
      setMechaUnitLight(0);
      gridGeo.dispose();
      perimeterGeo.dispose(); perimeterMat.dispose();
      attackRouteMat.dispose(); moveRouteMat.dispose(); inspectionFrameMat.dispose();
      previewGeo.dispose(); previewMat.dispose(); shoveGeo.dispose(); shoveOutlineMat.dispose(); shoveMat.dispose();
      shoveLandingGeo.dispose(); collisionGeo.dispose(); collisionMat.dispose();
      for (const badge of unitBadges) { badge.label.remove(); }
      (grid.material as THREE.Material).dispose();
      padGeo.dispose();
      reachMarks.dispose(); overlapReachRims.dispose(); overlapReachMarks.dispose();
      for (const geo of [threatGeo, projectedGeo, targetGeo, reachGeo, overlapReachRimGeo, overlapReachGeo, focusGeo, moveGeo, sourceGeo, dangerFrameGeo, dangerFillGeo]) geo.dispose();
      for (const mat of [dangerFrameMat, subduedDangerFrameMat, dangerFillMat, focusedDangerFillMat, subduedDangerFillMat, sourceMat, subduedSourceMat, subduedAttackRouteMat, subduedRouteOutlineMat, threatMat, subduedThreatMat, focusThreatMat, projectedMat, overlapProjectedMat, focusedProjectedMat, subduedProjectedMat, targetMat, reachMat, overlapReachRimMat, overlapReachMat, focusMat, moveMat, warningMat, subduedWarningMat, focusWarningMat, projectedWarningMat, focusedProjectedWarningMat, subduedProjectedWarningMat, combinedWarningMat]) mat.dispose();
      missionGeo.dispose(); missionMat.dispose(); missionBadgeMat.dispose(); missionTexture.dispose();
      corrodeGeo.dispose(); corrodeMat.dispose(); corrodeBadgeMat.dispose(); corrodeTexture.dispose();
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
