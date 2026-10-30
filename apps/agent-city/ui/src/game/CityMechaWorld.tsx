/** Mechs and monsters standing on the city scene. The rules board stays in cell space. */
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as THREE from "three";
import type { CityEngine } from "../engine/CityEngine";
import { boardToWorld, cellWorld, type CityMechaSite } from "./mecha/citySite";
import { createAssault, createBoss, createGunner, createRaider, createSupport, disposeMechaModel } from "../render/mecha/models";
import { MechaBattleAnimator, faceMechaTarget, mechaActionDuration, type MechaCombatCue } from "../render/mecha/animation";
import { trialMoveAlpha, trialMovementAllowed } from "../render/mecha/trialMotion";
import { AssaultTurnPlayer } from "./mecha/assaultTurnPlayer";
import { movementWaypoints } from "./mecha/movementRoute";
import type { PresentationStages } from "./mecha/presentationSnapshot";
import type { PresentationRoutes } from "./mecha/presentationRoutes";
import type { PresentationChanges } from "./mecha/presentationChanges";
import { applyMechaUnitLight, setMechaUnitLight } from "../render/mecha/unitLight";
import { BOARD, type Cell, type MechId } from "./mecha/rules";

export type CityMechaView = {
  combat: { id: number; actions: MechaCombatCue[]; reset?: true; presentationChanges?: PresentationChanges; presentationStages?: PresentationStages | null; presentationRoutes?: PresentationRoutes };
  paused?: boolean;
  figures: Array<{ id: MechId; x: number; y: number; alive: boolean; hp: number; selected: boolean }>;
  boss: { x: number; y: number; alive: boolean; hp: number };
  raiders: Array<{ id: string; x: number; y: number; alive: boolean; hp: number }>;
  buildings: Array<{ id: string; cells: Cell[]; hp: number; maxHp: number }>;
  telegraph: Cell[];
  focus: Cell[];
  reach: Cell[];
  move: Cell | null;
  targets: Cell[];
  targetIds: string[];
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
  empty: 0.05,
  water: 0.4,
  mountain: 0.4,
  road: 0.32,
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

export const CityMechaWorld = forwardRef<CityMechaWorldHandle, {
  engine: CityEngine;
  site: CityMechaSite;
  view: CityMechaView;
  onCell: (x: number, y: number) => void;
  onUnavailable?: () => void;
  onSequenceStatus?: (status: { id: number; state: "done" | "fault" }) => void;
}>(function CityMechaWorld({ engine, site, view, onCell, onUnavailable, onSequenceStatus }, ref) {
  const viewRef = useRef(view);
  const onCellRef = useRef(onCell);
  const onSequenceStatusRef = useRef(onSequenceStatus);
  const cameraCommands = useRef<CityMechaWorldHandle | null>(null);
  viewRef.current = view;
  onCellRef.current = onCell;
  onSequenceStatusRef.current = onSequenceStatus;
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
      Assault: marker("#e2b15a", 4.7, 6.3),
      Gunner: marker("#7eb6ff", 4.3, 5.8),
      Support: marker("#7dffa8", 4.3, 5.8),
      boss: marker("#eaff7a", 10.2, 13),
      raiderWest: marker("#d7a4ff", 2.9, 4.1),
      raiderEast: marker("#d7a4ff", 2.9, 4.1),
    };
    for (const figure of [assault, gunner, support, boss, raiderWest, raiderEast]) root.add(figure);
    for (const ring of Object.values(markers)) root.add(ring.mesh);

    const barGeo = new THREE.BoxGeometry(12, 0.5, 0.5);
    const barBg = new THREE.MeshStandardMaterial({ color: "#1b140f", roughness: 0.8 });
    const bars = new Map<string, { anchor: THREE.Group; fill: THREE.Mesh; fillMat: THREE.MeshStandardMaterial }>();
    for (const building of site.buildings) {
      const anchor = new THREE.Group();
      anchor.position.set(building.x, building.ground + building.height + 1.6, building.z);
      anchor.rotation.y = building.yaw;
      const back = new THREE.Mesh(barGeo, barBg);
      const fillMat = new THREE.MeshStandardMaterial({ color: "#e23d3d", emissive: "#7a1818", emissiveIntensity: 0.35, roughness: 0.45 });
      const fill = new THREE.Mesh(barGeo, fillMat);
      fill.scale.x = 1;
      anchor.add(back, fill);
      bars.set(building.id, { anchor, fill, fillMat });
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
    const grid = new THREE.LineSegments(gridGeo, new THREE.LineBasicMaterial({ color: "#9ec9ef", transparent: true, opacity: 0.28 }));
    root.add(grid);

    const camera = engine.renderCamera;
    // Sit on the squad side of the rotated board. The window is two lots per
    // cell, about 144 × 160, so the eye stays in board-local space. World +Z
    // is not south once the grid follows the street.
    const focus = cellWorld(site, { x: 4, y: 5 });
    const eye = boardToWorld(site, 4.5 * site.cellW + 36, 5.5 * site.cellD + 56);
    const home = {
      position: { x: eye.x, y: focus.y + 240, z: eye.z },
      target: { x: focus.x, y: focus.y + 2, z: focus.z },
      fov: 40,
      minDistance: 45,
      maxDistance: 520,
    };
    const resetCamera = () => lease.setOrbitView(home);
    cameraCommands.current = {
      resetCamera,
      rotateCamera: () => {
        const current = engine.photoView();
        const target = new THREE.Vector3().fromArray(current.target);
        const position = new THREE.Vector3().fromArray(current.position).sub(target).applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2).add(target);
        lease.setOrbitView({ position, target, fov: current.fov, minDistance: 45, maxDistance: 520 });
      },
    };
    resetCamera();

    const raycaster = new THREE.Raycaster();
    raycaster.layers.set(1);
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
      const cell = raycaster.intersectObjects(picks, false)[0]?.object.userData.cell as Cell | undefined;
      if (cell) onCellRef.current(cell.x, cell.y);
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const spot = new THREE.Vector3();
    const animators = new Map<THREE.Object3D, MechaBattleAnimator>([assault, gunner, support, boss, raiderWest, raiderEast].map((mesh) => [mesh, new MechaBattleAnimator(mesh)]));
    const litUnits = [assault, gunner, support, boss, raiderWest, raiderEast];
    const sequenceTrial = import.meta.env.DEV && new URLSearchParams(location.search).get("assaultTrial") === "1" && new URLSearchParams(location.search).get("assaultSequence") === "1";
    let sequence: AssaultTurnPlayer | null = null;
    let sequenceObserved = -1;
    let sequenceFault = false;
    let sequenceTarget: string | undefined;
    let previousFrame = performance.now();
    const animate = (mesh: THREE.Object3D, id: string, hp: number, moving: boolean, dt: number) => {
      if (viewRef.current.paused) return;
      const animator = animators.get(mesh)!;
      const cue = viewRef.current.combat;
      animator.sync(hp, cue.id, cue.actions.find((item) => item.actor === id)?.action);
      animator.update(dt, moving, reduce);
    };
    lease.setFrameHook(() => {
      const now = performance.now();
      const dt = Math.min(0.1, Math.max(0, (now - previousFrame) / 1000));
      previousFrame = now;
      // 夜间补光（见 unitLight.ts）。GLB 是异步原地升级的，升级后材质整套换掉，所以按 userData.glb 的变化重装
      setMechaUnitLight(engine.skyNight);
      for (const unit of litUnits) {
        const source = unit.userData.glb ?? "procedural";
        if (unit.userData.unitLightFor === source) continue;
        applyMechaUnitLight(unit);
        unit.userData.unitLightFor = source;
      }
      const current = viewRef.current;
      const animationDt = current.paused ? 0 : dt;
      const telegraph = new Set(current.telegraph.map(cellKey));
      const focus = new Set(current.focus.map(cellKey));
      const reach = new Set(current.reach.map(cellKey));
      const targets = new Set(current.targets.map(cellKey));
      const targetIds = new Set(current.targetIds);
      const buildingCells = new Map<string, "building" | "rubble">();
      for (const building of current.buildings) {
        const role = building.hp > 0 ? "building" : "rubble";
        for (const cell of building.cells) buildingCells.set(cellKey(cell), role);
      }
      const obstacleCells = new Set((current.obstacles ?? []).map(cellKey));
      const moveKey = current.move ? cellKey(current.move) : "";
      pads.forEach((pad, index) => {
        const x = index % BOARD;
        const y = Math.floor(index / BOARD);
        const id = `${x},${y}`;
        const ground = site.terrain[y]?.[x];
        const role: Role = targets.has(id) ? "target" : telegraph.has(id) ? "telegraph"
          : focus.has(id) ? "focus"
          : id === moveKey ? "move"
          : obstacleCells.has(id) ? "obstacle"
          : buildingCells.get(id) ?? (reach.has(id) ? "reach" : ground === "water" ? "water" : ground === "mountain" ? "mountain" : ground === "road" ? "road" : "empty");
        pad.material = padMat.get(role)!;
      });
      const bossFeet = footprintFeet(site, current.boss);
      const facingTarget = (id: string): THREE.Vector3 => {
        const action = animators.get(figures[id as MechId])?.animator.action;
        if (action !== "attack" && action !== "repair") return bossFeet;
        const target = current.combat.actions.find((cue) => cue.actor === id)?.target;
        if (id === "Assault" && import.meta.env.DEV && new URLSearchParams(location.search).get("assaultTrial") === "1") {
          if (target === "boss") return boss.position.clone();
          const raiderIndex = current.raiders.findIndex((raider) => raider.id === target);
          if (raiderIndex === 0) return raiderWest.position.clone();
          if (raiderIndex === 1) return raiderEast.position.clone();
        }
        const actor = current.figures.find((figure) => figure.id === target) ?? current.raiders.find((raider) => raider.id === target);
        if (!actor) return bossFeet;
        const feet = cellWorld(site, actor);
        return new THREE.Vector3(feet.x, feet.y, feet.z);
      };
      for (const figure of current.figures) {
        const mesh = figures[figure.id];
        const feet = cellWorld(site, { x: figure.x, y: figure.y });
        spot.set(feet.x, feet.y, feet.z);
        const moving = mesh.position.distanceToSquared(spot) > 0.01;
        const trial = figure.id === "Assault" && import.meta.env.DEV && new URLSearchParams(location.search).get("assaultTrial") === "1";
        const sequenced = trial && sequenceTrial && !reduce;
        if (sequenced) {
          if (!sequence) {
            // A scene can mount after a turn was committed. Start from that turn's
            // recorded position so it is played rather than silently skipped.
            const initial = current.combat.reset ? null : current.combat.presentationStages?.before.mechs.find((m) => m.id === "Assault");
            const start = initial ? cellWorld(site, initial.pos) : feet;
            const baseId = current.combat.reset ? current.combat.id : Math.max(0, current.combat.id - 1);
            mesh.position.set(start.x, start.y, start.z);
            sequence = new AssaultTurnPlayer(start, 32, baseId);
            sequenceObserved = baseId;
            animators.get(mesh)!.sync(initial?.hp ?? figure.hp, baseId);
          }
          if (current.combat.id !== sequenceObserved && current.combat.reset) {
            mesh.position.copy(spot);
            sequence = new AssaultTurnPlayer(feet, 32, current.combat.id);
            sequenceObserved = current.combat.id;
            sequenceFault = false;
            sequenceTarget = undefined;
            const freshAnimator = new MechaBattleAnimator(mesh);
            animators.set(mesh, freshAnimator);
            freshAnimator.sync(figure.hp, current.combat.id);
          }
          if (current.combat.id !== sequenceObserved && !sequenceFault) {
            const stages = current.combat.presentationStages;
            const routes = current.combat.presentationRoutes;
            if (!stages || !routes?.ok || !current.combat.presentationChanges?.ok) {
              sequenceFault = true;
              console.warn("[assault-sequence] missing or inconsistent turn data");
            } else {
              const before = stages.before.mechs.find((m) => m.id === "Assault");
              const afterMove = stages.afterMovement.mechs.find((m) => m.id === "Assault");
              const after = stages.afterPrepare.mechs.find((m) => m.id === "Assault");
              const route = routes.routes.find((r) => r.actor === "Assault");
              const cue = current.combat.actions.find((c) => c.actor === "Assault");
              const cells = route?.cells ?? (before ? [before.pos] : []);
              const points = movementWaypoints(site, cells);
              if (!before || !afterMove || !after || !points || cells.at(-1)?.x !== afterMove.pos.x || cells.at(-1)?.y !== afterMove.pos.y || afterMove.pos.x !== after.pos.x || afterMove.pos.y !== after.pos.y) {
                sequenceFault = true;
                console.warn("[assault-sequence] incomplete route or forced movement requires explicit choreography");
              } else {
                const actionSeconds = cue ? mechaActionDuration(mesh, cue.action) ?? 0 : 0;
                const reactionSeconds = after.hp < before.hp ? (mechaActionDuration(mesh, "hit") ?? .48) : 0;
                const defeatSeconds = after.hp <= 0 && before.hp > 0 ? (mechaActionDuration(mesh, "defeat") ?? .85) : 0;
                try { sequence.enqueue({ id: current.combat.id, points, action: cue?.action, actionDuration: actionSeconds + reactionSeconds + defeatSeconds, hp: after.hp, target: cue?.target }); }
                catch (error) { sequenceFault = true; console.warn("[assault-sequence] rejected discontinuous or missing turn", error); }
              }
            }
            sequenceObserved = current.combat.id;
            if (sequenceFault) onSequenceStatusRef.current?.({ id: current.combat.id, state: "fault" });
          }
          sequence.setPaused(Boolean(current.paused));
          if (!sequenceFault) {
            const old = mesh.position.clone();
            const frame = sequence.advance(dt);
            mesh.position.set(frame.position.x, frame.position.y, frame.position.z);
            if (frame.completed !== undefined) onSequenceStatusRef.current?.({ id: frame.completed, state: "done" });
            const animator = animators.get(mesh)!;
            if (frame.started) { sequenceTarget = frame.started.target; animator.sync(frame.started.hp, frame.started.id, frame.started.action); }
            if (!current.paused) animator.update(frame.started ? frame.actionElapsed ?? 0 : dt, frame.phase === "moving", reduce);
            if (!current.paused && frame.phase === "moving" && old.distanceToSquared(mesh.position) > 1e-10) faceMechaTarget(mesh, old, mesh.position);
            else if (!current.paused && frame.phase === "acting" && sequenceTarget === "boss") faceMechaTarget(mesh, mesh.position, boss.position);
          }
        } else if (trial) {
          animate(mesh, figure.id, figure.hp, moving && figure.alive, animationDt);
          if (!current.paused && (reduce || trialMovementAllowed(animators.get(mesh)!.animator.action))) slide(mesh, spot, reduce, dt, true);
        } else {
          if (!current.paused) slide(mesh, spot, reduce, dt);
          animate(mesh, figure.id, figure.hp, moving && figure.alive, animationDt);
        }
        mesh.visible = true;
        const ring = markers[figure.id];
        const targeted = targetIds.has(figure.id);
        ring.mesh.visible = figure.alive;
        ring.mesh.position.set(mesh.position.x, mesh.position.y + 0.55, mesh.position.z);
        ring.mesh.scale.setScalar(figure.selected ? 1.34 : targeted ? 1.2 : 1);
        ring.mat.opacity = figure.selected || targeted ? 1 : 0.48;
        if (!current.paused && figure.alive && !sequenced) faceMechaTarget(mesh, trial ? mesh.position : spot, facingTarget(figure.id));
      }
      const bossMoving = boss.position.distanceToSquared(bossFeet) > 0.01;
      if (!current.paused) slide(boss, bossFeet, reduce);
      animate(boss, "boss", current.boss.hp, bossMoving && current.boss.alive, animationDt);
      boss.visible = true;
      markers.boss.mesh.visible = current.boss.alive;
      markers.boss.mesh.position.set(boss.position.x, boss.position.y + 0.55, boss.position.z);
      markers.boss.mesh.scale.setScalar(targetIds.has("boss") ? 1.12 : 1);
      const nearest = current.figures.find((figure) => figure.alive);
      if (!current.paused && nearest && current.boss.alive) {
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
        if (!current.paused) slide(mesh, spot, reduce);
        animate(mesh, raider.id, raider.hp, moving && raider.alive, animationDt);
        mesh.visible = true;
        const ring = i === 0 ? markers.raiderWest : markers.raiderEast;
        ring.mesh.visible = raider.alive;
        ring.mesh.position.set(mesh.position.x, mesh.position.y + 0.55, mesh.position.z);
        ring.mesh.scale.setScalar(targetIds.has(raider.id) ? 1.2 : 1);
        ring.mat.opacity = targetIds.has(raider.id) ? 1 : 0.48;
        if (!current.paused && raider.alive) faceMechaTarget(mesh, spot, bossFeet);
      }
      if (!current.raiders[0]?.alive) markers.raiderWest.mesh.visible = false;
      if (!current.raiders[1]?.alive) markers.raiderEast.mesh.visible = false;
      for (const building of site.buildings) {
        const bar = bars.get(building.id);
        const live = current.buildings.find((item) => item.id === building.id);
        if (!bar) continue;
        bar.anchor.visible = Boolean(live);
        if (!live || live.maxHp <= 0) continue;
        const ratio = Math.max(0, Math.min(1, live.hp / live.maxHp));
        bar.fill.scale.x = Math.max(0.04, ratio);
        bar.fill.position.x = (ratio - 1) * 6;
        bar.fillMat.color.set(ratio > 0.5 ? "#d7b15a" : "#e23d3d");
      }
    });

    return () => {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      cameraCommands.current = null;
      try { lease.release(); } catch { /* host already disposed the scene */ }
      for (const figure of [assault, gunner, support, boss, raiderWest, raiderEast]) disposeMechaModel(figure);
      setMechaUnitLight(0);
      gridGeo.dispose();
      (grid.material as THREE.Material).dispose();
      padGeo.dispose();
      pickGeo.dispose();
      pickMat.dispose();
      barGeo.dispose();
      barBg.dispose();
      for (const mat of padMat.values()) mat.dispose();
      for (const bar of bars.values()) bar.fillMat.dispose();
      for (const ring of Object.values(markers)) {
        ring.geo.dispose();
        ring.mat.dispose();
      }
      if (engine.owner === "orbit") engine.restoreReturnView(saved);
    };
  }, [engine, site]);

  return null;
});

function marker(color: string, inner: number, outer: number): { mesh: THREE.Mesh; geo: THREE.BufferGeometry; mat: THREE.MeshBasicMaterial } {
  const geo = new THREE.RingGeometry(inner, outer, 28);
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

function slide(mesh: THREE.Object3D, goal: THREE.Vector3, snap: boolean, dt = 0, trial = false) {
  if (snap || mesh.position.distanceTo(goal) > 96) mesh.position.copy(goal);
  else mesh.position.lerp(goal, trial ? trialMoveAlpha(dt) : 0.22);
}
