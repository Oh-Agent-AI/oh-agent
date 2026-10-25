/** Mechs and monsters standing on the city scene. The rules board stays in cell space. */
import { useEffect, useRef } from "react";
import * as THREE from "three";
import type { CityEngine } from "../engine/CityEngine";
import { CITY_CELL, cellWorld, type CityMechaSite } from "./mecha/citySite";
import { createAssault, createBoss, createGunner, createSupport, disposeMechaModel } from "./mecha/models";
import type { Cell, MechId } from "./mecha/rules";

export type CityMechaView = {
  figures: Array<{ id: MechId; x: number; y: number; alive: boolean; selected: boolean }>;
  boss: { x: number; y: number; alive: boolean };
  raiders: Array<{ id: string; x: number; y: number; alive: boolean }>;
  buildings: Array<{ id: string; cells: Cell[]; hp: number; maxHp: number }>;
  telegraph: Cell[];
  reach: Cell[];
  move: Cell | null;
};

const ROLES = ["empty", "reach", "move", "building", "rubble", "telegraph"] as const;
type Role = (typeof ROLES)[number];

const ROLE_COLOR: Record<Role, string> = {
  empty: "#d5e4f2",
  reach: "#8fd4ff",
  move: "#ffe08a",
  building: "#e2b15a",
  rubble: "#2c2824",
  telegraph: "#ff3b3b",
};

const ROLE_OPACITY: Record<Role, number> = {
  empty: 0.14,
  reach: 0.48,
  move: 0.78,
  building: 0.42,
  rubble: 0.55,
  telegraph: 0.7,
};

export function CityMechaWorld({
  engine, site, view, onCell,
}: {
  engine: CityEngine;
  site: CityMechaSite;
  view: CityMechaView;
  onCell: (x: number, y: number) => void;
}) {
  const viewRef = useRef(view);
  const onCellRef = useRef(onCell);
  viewRef.current = view;
  onCellRef.current = onCell;

  useEffect(() => {
    const canvas = engine.domCanvas;
    if (!(canvas instanceof HTMLCanvasElement)) return undefined;
    const saved = engine.captureReturnView();
    const owned = engine.setCameraOwner("game");
    const root = new THREE.Group();
    root.name = "mecha-city";

    const padGeo = new THREE.BoxGeometry(CITY_CELL - 0.7, 0.08, CITY_CELL - 0.7);
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
        emissive: role === "telegraph" ? "#8a1c1c" : "#000000",
        emissiveIntensity: role === "telegraph" ? 0.4 : 0,
      }));
    }
    const pads: THREE.Mesh[] = [];
    const pickGeo = new THREE.BoxGeometry(CITY_CELL - 0.2, 0.6, CITY_CELL - 0.2);
    const pickMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
    const picks: THREE.Mesh[] = [];
    for (let y = 0; y < 10; y += 1) {
      for (let x = 0; x < 10; x += 1) {
        const world = cellWorld(site, { x, y });
        const pad = new THREE.Mesh(padGeo, padMat.get("empty")!);
        pad.position.set(world.x, world.y + 0.22, world.z);
        pad.name = `mecha-cell-${x}-${y}`;
        pads.push(pad);
        root.add(pad);
        const pick = new THREE.Mesh(pickGeo, pickMat);
        pick.position.set(world.x, world.y + 0.35, world.z);
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
    const raiderWest = createBoss();
    const raiderEast = createBoss();
    // Models are built for a 16 m cell. The city cell is 32 m, so the same
    // mesh fills the larger footprint. Support already carries 1.22.
    const unitScale = 2;
    assault.scale.multiplyScalar(unitScale);
    gunner.scale.multiplyScalar(unitScale);
    support.scale.multiplyScalar(unitScale);
    boss.scale.multiplyScalar(unitScale);
    raiderWest.scale.setScalar(0.38 * unitScale);
    raiderEast.scale.setScalar(0.38 * unitScale);
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

    const barGeo = new THREE.BoxGeometry(6, 0.5, 0.5);
    const barBg = new THREE.MeshStandardMaterial({ color: "#1b140f", roughness: 0.8 });
    const bars = new Map<string, { anchor: THREE.Group; fill: THREE.Mesh; fillMat: THREE.MeshStandardMaterial }>();
    for (const building of site.buildings) {
      const anchor = new THREE.Group();
      anchor.position.set(building.x, building.ground + building.height + 1.6, building.z);
      const back = new THREE.Mesh(barGeo, barBg);
      const fillMat = new THREE.MeshStandardMaterial({ color: "#e23d3d", emissive: "#7a1818", emissiveIntensity: 0.35, roughness: 0.45 });
      const fill = new THREE.Mesh(barGeo, fillMat);
      fill.scale.x = 1;
      anchor.add(back, fill);
      bars.set(building.id, { anchor, fill, fillMat });
      root.add(anchor);
    }

    engine.attachGameObjects(root);
    const gridPts: number[] = [];
    const corner = (x: number, y: number) => {
      const neighbors = [
        cellWorld(site, { x: Math.min(9, x), y: Math.min(9, y) }),
        cellWorld(site, { x: Math.max(0, x - 1), y: Math.min(9, y) }),
        cellWorld(site, { x: Math.min(9, x), y: Math.max(0, y - 1) }),
        cellWorld(site, { x: Math.max(0, x - 1), y: Math.max(0, y - 1) }),
      ];
      return {
        x: site.originX + x * CITY_CELL,
        y: Math.max(...neighbors.map((item) => item.y)) + 0.4,
        z: site.originZ + y * CITY_CELL,
      };
    };
    for (let i = 0; i <= 10; i += 1) {
      for (let j = 0; j < 10; j += 1) {
        const a = corner(i, j);
        const b = corner(i, j + 1);
        const c = corner(j, i);
        const d = corner(j + 1, i);
        gridPts.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, d.x, d.y, d.z);
      }
    }
    const gridGeo = new THREE.BufferGeometry();
    gridGeo.setAttribute("position", new THREE.Float32BufferAttribute(gridPts, 3));
    const grid = new THREE.LineSegments(gridGeo, new THREE.LineBasicMaterial({ color: "#9ec9ef", transparent: true, opacity: 0.85 }));
    root.add(grid);

    const camera = engine.renderCamera;
    // The board is twice as wide as the first city window. Keep the same
    // south-west aim and step the camera back by that same factor, or the
    // squad sits under the panel and the boss leaves the top of the frame.
    const aimCell = cellWorld(site, { x: 1, y: 8 });
    const aim = new THREE.Vector3(aimCell.x, aimCell.y + 2, aimCell.z);
    const frameCamera = () => {
      camera.position.set(aimCell.x + 44, aimCell.y + 168, aimCell.z + 88);
      camera.up.set(0, 1, 0);
      camera.fov = 36;
      camera.updateProjectionMatrix();
      camera.lookAt(aim);
    };
    if (owned) frameCamera();

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
    engine.setGameFrameHook(() => {
      if (owned) frameCamera();
      const current = viewRef.current;
      const telegraph = new Set(current.telegraph.map(cellKey));
      const reach = new Set(current.reach.map(cellKey));
      const buildingCells = new Map<string, "building" | "rubble">();
      for (const building of current.buildings) {
        const role = building.hp > 0 ? "building" : "rubble";
        for (const cell of building.cells) buildingCells.set(cellKey(cell), role);
      }
      const moveKey = current.move ? cellKey(current.move) : "";
      pads.forEach((pad, index) => {
        const x = index % 10;
        const y = Math.floor(index / 10);
        const id = `${x},${y}`;
        const role: Role = telegraph.has(id) ? "telegraph"
          : id === moveKey ? "move"
          : buildingCells.get(id) ?? (reach.has(id) ? "reach" : "empty");
        pad.material = padMat.get(role)!;
      });
      const bossFeet = footprintFeet(site, current.boss);
      for (const figure of current.figures) {
        const mesh = figures[figure.id];
        const feet = cellWorld(site, { x: figure.x, y: figure.y });
        spot.set(feet.x, feet.y, feet.z);
        slide(mesh, spot, reduce);
        mesh.visible = figure.alive;
        const ring = markers[figure.id];
        ring.mesh.visible = figure.alive;
        ring.mesh.position.set(mesh.position.x, mesh.position.y + 0.55, mesh.position.z);
        ring.mesh.scale.setScalar(figure.selected ? 1.28 : 1);
        if (figure.alive) face(mesh, spot, bossFeet);
      }
      slide(boss, bossFeet, reduce);
      boss.visible = current.boss.alive;
      markers.boss.mesh.visible = current.boss.alive;
      markers.boss.mesh.position.set(boss.position.x, boss.position.y + 0.55, boss.position.z);
      const nearest = current.figures.find((figure) => figure.alive);
      if (nearest && current.boss.alive) {
        const feet = cellWorld(site, { x: nearest.x, y: nearest.y });
        face(boss, bossFeet, new THREE.Vector3(feet.x, feet.y, feet.z));
      }
      const small = [raiderWest, raiderEast];
      for (let i = 0; i < small.length; i += 1) {
        const mesh = small[i];
        const raider = current.raiders[i];
        if (!mesh) continue;
        if (!raider?.alive) {
          mesh.visible = false;
          continue;
        }
        const feet = cellWorld(site, { x: raider.x, y: raider.y });
        spot.set(feet.x, feet.y, feet.z);
        slide(mesh, spot, reduce);
        mesh.visible = true;
        const ring = i === 0 ? markers.raiderWest : markers.raiderEast;
        ring.mesh.visible = true;
        ring.mesh.position.set(mesh.position.x, mesh.position.y + 0.55, mesh.position.z);
        face(mesh, spot, bossFeet);
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
        bar.fill.position.x = (ratio - 1) * 3;
        bar.fillMat.color.set(ratio > 0.5 ? "#d7b15a" : "#e23d3d");
      }
    });

    return () => {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      try { engine.setGameFrameHook(null); } catch { /* host already released the frame */ }
      try { engine.detachGameObjects(root); } catch { /* scene lease ended with the host */ }
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
      if (owned) {
        engine.setCameraOwner("orbit");
        engine.restoreReturnView(saved);
      }
    };
  }, [engine, site]);

  return null;
}

function marker(color: string, inner: number, outer: number): { mesh: THREE.Mesh; geo: THREE.BufferGeometry; mat: THREE.Material } {
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
  return new THREE.Vector3(
    site.originX + (anchor.x + 1) * CITY_CELL,
    y / cells.length,
    site.originZ + (anchor.y + 1) * CITY_CELL,
  );
}

function face(mesh: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3) {
  mesh.rotation.y = Math.atan2(to.x - from.x, -(to.z - from.z));
}

function slide(mesh: THREE.Object3D, goal: THREE.Vector3, snap: boolean) {
  if (snap || mesh.position.distanceTo(goal) > 48) mesh.position.copy(goal);
  else mesh.position.lerp(goal, 0.22);
}
