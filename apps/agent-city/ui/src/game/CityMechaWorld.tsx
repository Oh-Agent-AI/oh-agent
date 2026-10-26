/** Mechs and monsters standing on the city scene. The rules board stays in cell space. */
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as THREE from "three";
import type { CityEngine } from "../engine/CityEngine";
import { boardToWorld, cellWorld, type CityMechaSite } from "./mecha/citySite";
import { createAssault, createBoss, createGunner, createRaider, createSupport, disposeMechaModel } from "../render/mecha/models";
import { MechaBattleAnimator, faceMechaTarget, type MechaCombatCue } from "../render/mecha/animation";
import { BOARD, type Cell, type MechId } from "./mecha/rules";

export type CityMechaView = {
  combat: { id: number; actions: MechaCombatCue[] };
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
}>(function CityMechaWorld({ engine, site, view, onCell, onUnavailable }, ref) {
  const viewRef = useRef(view);
  const onCellRef = useRef(onCell);
  const cameraCommands = useRef<CityMechaWorldHandle | null>(null);
  viewRef.current = view;
  onCellRef.current = onCell;
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
    let previousFrame = performance.now();
    const animate = (mesh: THREE.Object3D, id: string, hp: number, moving: boolean, dt: number) => {
      const animator = animators.get(mesh)!;
      const cue = viewRef.current.combat;
      animator.sync(hp, cue.id, cue.actions.find((item) => item.actor === id)?.action);
      animator.update(dt, moving, reduce);
    };
    lease.setFrameHook(() => {
      const now = performance.now();
      const dt = Math.min(0.1, Math.max(0, (now - previousFrame) / 1000));
      previousFrame = now;
      const current = viewRef.current;
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
        slide(mesh, spot, reduce);
        animate(mesh, figure.id, figure.hp, moving && figure.alive, dt);
        mesh.visible = true;
        const ring = markers[figure.id];
        const targeted = targetIds.has(figure.id);
        ring.mesh.visible = figure.alive;
        ring.mesh.position.set(mesh.position.x, mesh.position.y + 0.55, mesh.position.z);
        ring.mesh.scale.setScalar(figure.selected ? 1.34 : targeted ? 1.2 : 1);
        ring.mat.opacity = figure.selected || targeted ? 1 : 0.48;
        if (figure.alive) faceMechaTarget(mesh, spot, facingTarget(figure.id));
      }
      const bossMoving = boss.position.distanceToSquared(bossFeet) > 0.01;
      slide(boss, bossFeet, reduce);
      animate(boss, "boss", current.boss.hp, bossMoving && current.boss.alive, dt);
      boss.visible = true;
      markers.boss.mesh.visible = current.boss.alive;
      markers.boss.mesh.position.set(boss.position.x, boss.position.y + 0.55, boss.position.z);
      markers.boss.mesh.scale.setScalar(targetIds.has("boss") ? 1.12 : 1);
      const nearest = current.figures.find((figure) => figure.alive);
      if (nearest && current.boss.alive) {
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
        slide(mesh, spot, reduce);
        animate(mesh, raider.id, raider.hp, moving && raider.alive, dt);
        mesh.visible = true;
        const ring = i === 0 ? markers.raiderWest : markers.raiderEast;
        ring.mesh.visible = raider.alive;
        ring.mesh.position.set(mesh.position.x, mesh.position.y + 0.55, mesh.position.z);
        ring.mesh.scale.setScalar(targetIds.has(raider.id) ? 1.2 : 1);
        ring.mat.opacity = targetIds.has(raider.id) ? 1 : 0.48;
        if (raider.alive) faceMechaTarget(mesh, spot, bossFeet);
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

function slide(mesh: THREE.Object3D, goal: THREE.Vector3, snap: boolean) {
  if (snap || mesh.position.distanceTo(goal) > 96) mesh.position.copy(goal);
  else mesh.position.lerp(goal, 0.22);
}
