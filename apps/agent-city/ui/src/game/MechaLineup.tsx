import { BOARD } from "./mecha/rules";
/** Rules board in world units. 1 unit = 2 m, one cell = 16 m. The grid underneath stays the input. */
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { MechaPerformancePlayer } from "../render/mecha/animation";
import type { MechaPerformanceView } from "./CityMechaWorld";
import { MECHA_FACTION_COLORS, createAssault, createBoss, createGunner, createRaider, createSupport, disposeMechaModel } from "../render/mecha/models";

const CELL = 8;
const BOARD_SPAN = CELL * BOARD;

export type MechaBoardView = {
  figures: Array<{ id: "Assault" | "Gunner" | "Support"; x: number; y: number; alive: boolean; selected: boolean }>;
  boss: { x: number; y: number; alive: boolean };
  raiders?: Array<{ id: string; x: number; y: number; alive: boolean }>;
  covers: Array<{ x: number; y: number }>;
  telegraph: Array<{ x: number; y: number }>;
};

function cellTop(x: number, y: number, lift = 0): THREE.Vector3 {
  return new THREE.Vector3((x + 0.5) * CELL, lift, (y + 0.5) * CELL);
}

export function MechaLineup({ label, view, performance, paused, onPerformanceComplete }: {
  label: string;
  view: MechaBoardView;
  performance: MechaPerformanceView | null;
  paused: boolean;
  onPerformanceComplete: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef(view);
  const performanceRef = useRef(performance);
  const pausedRef = useRef(paused);
  const completeRef = useRef(onPerformanceComplete);
  viewRef.current = view;
  performanceRef.current = performance;
  pausedRef.current = paused;
  completeRef.current = onPerformanceComplete;

  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return undefined;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight("#c5d7ea", "#24180f", 1.05));
    const sun = new THREE.DirectionalLight("#fff4e0", 1.45);
    sun.position.set(30, 48, 18);
    scene.add(sun);

    const deck = new THREE.Mesh(
      new THREE.BoxGeometry(BOARD_SPAN, 0.3, BOARD_SPAN),
      new THREE.MeshStandardMaterial({ color: "#12283c", roughness: 0.92 }),
    );
    deck.position.set(BOARD_SPAN / 2, -0.16, BOARD_SPAN / 2);
    scene.add(deck);

    const tile = new THREE.InstancedMesh(
      new THREE.BoxGeometry(7.2, 0.06, 7.2),
      new THREE.MeshStandardMaterial({ color: "#1b3a52", roughness: 0.86 }),
      100,
    );
    const dummy = new THREE.Object3D();
    let n = 0;
    for (let y = 0; y < BOARD; y += 1) {
      for (let x = 0; x < BOARD; x += 1) {
        dummy.position.copy(cellTop(x, y, 0.02));
        dummy.updateMatrix();
        tile.setMatrixAt(n, dummy.matrix);
        n += 1;
      }
    }
    tile.instanceMatrix.needsUpdate = true;
    scene.add(tile);

    const gridGeo = new THREE.BufferGeometry();
    const pts: number[] = [];
    for (let i = 0; i <= BOARD; i += 1) {
      pts.push(i * CELL, 0.08, 0, i * CELL, 0.08, BOARD_SPAN);
      pts.push(0, 0.08, i * CELL, BOARD_SPAN, 0.08, i * CELL);
    }
    gridGeo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    const grid = new THREE.LineSegments(gridGeo, new THREE.LineBasicMaterial({ color: "#3e6280" }));
    scene.add(grid);

    const coverMat = new THREE.MeshStandardMaterial({ color: "#5c6b4a", roughness: 0.9 });
    const covers = pool(scene, 8, coverMat, 0.12);
    const telegraphMat = new THREE.MeshStandardMaterial({ color: "#ff4d4d", emissive: "#8a1c1c", emissiveIntensity: 0.45, transparent: true, opacity: 0.72 });
    const telegraphs = pool(scene, 8, telegraphMat, 0.2);
    const selectMat = new THREE.MeshStandardMaterial({ color: "#f4f7fb", emissive: "#d7e6f5", emissiveIntensity: 0.3 });
    const selected = new THREE.Mesh(new THREE.BoxGeometry(7.4, 0.08, 7.4), selectMat);
    scene.add(selected);

    const assault = createAssault();
    const gunner = createGunner();
    const support = createSupport();
    const boss = createBoss();
    const raiderWest = createRaider();
    const raiderEast = createRaider();
    const figures = { Assault: assault, Gunner: gunner, Support: support };
    const markers = {
      Assault: factionMarker(MECHA_FACTION_COLORS.friendly, 3.4, 4.2),
      Gunner: factionMarker(MECHA_FACTION_COLORS.friendly, 3.4, 4.2),
      Support: factionMarker(MECHA_FACTION_COLORS.friendly, 3.4, 4.2),
      boss: factionMarker(MECHA_FACTION_COLORS.enemy, 5.6, 6.6, 4),
      raiderWest: factionMarker(MECHA_FACTION_COLORS.enemy, 2.7, 3.4, 4),
      raiderEast: factionMarker(MECHA_FACTION_COLORS.enemy, 2.7, 3.4, 4),
    };
    for (const figure of [assault, gunner, support, boss, raiderWest, raiderEast]) scene.add(figure);
    for (const ring of Object.values(markers)) scene.add(ring);

    const camera = new THREE.PerspectiveCamera(36, 1, 0.5, 500);
    const center = new THREE.Vector3(BOARD_SPAN / 2, 2, 40);
    camera.position.set(92, 58, 118);
    camera.lookAt(center);

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const actors = { Assault: assault, Gunner: gunner, Support: support, boss, "raider-w": raiderWest, "raider-e": raiderEast };
    const actorMarkers = { Assault: markers.Assault, Gunner: markers.Gunner, Support: markers.Support, boss: markers.boss, "raider-w": markers.raiderWest, "raider-e": markers.raiderEast };
    const resolveCell = (cell: { x: number; y: number }, actor: string) => actor === "boss" ? new THREE.Vector3((cell.x + 1) * CELL, 0, (cell.y + 1) * CELL) : cellTop(cell.x, cell.y);
    let player: MechaPerformancePlayer | null = null;
    let playing: MechaPerformanceView | null = null;
    let lastFrame = globalThis.performance.now();
    let frame = 0;
    const draw = () => {
      const now = globalThis.performance.now();
      const dt = Math.min(0.08, (now - lastFrame) / 1000);
      lastFrame = now;
      const width = parent.clientWidth;
      const height = parent.clientHeight;
      if (width > 0 && height > 0) {
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      }
      const current = viewRef.current;
      placePads(covers, current.covers, 0.14);
      placePads(telegraphs, current.telegraph, 0.22);
      let marked = false;
      for (const figure of current.figures) {
        const mesh = figures[figure.id];
        const spot = cellTop(figure.x, figure.y, 0);
        slide(mesh, spot, reduce);
        mesh.visible = figure.alive;
        const ring = markers[figure.id];
        ring.visible = figure.alive;
        ring.position.set(spot.x, 0.12, spot.z);
        ring.scale.setScalar(figure.selected ? 1.15 : 1);
        ring.material.color.set(figure.selected ? "#f4f7fb" : MECHA_FACTION_COLORS.friendly);
        if (figure.selected && figure.alive) {
          selected.visible = true;
          selected.position.set(spot.x, 0.18, spot.z);
          marked = true;
        }
      }
      if (!marked) selected.visible = false;
      const bossSpot = new THREE.Vector3((current.boss.x + 1) * CELL, 0, (current.boss.y + 1) * CELL);
      slide(boss, bossSpot, reduce);
      boss.visible = current.boss.alive;
      markers.boss.visible = current.boss.alive;
      markers.boss.position.set(bossSpot.x, 0.12, bossSpot.z);
      const small = [raiderWest, raiderEast];
      const smallMarkers = [markers.raiderWest, markers.raiderEast];
      const raiders = current.raiders ?? [];
      for (let i = 0; i < small.length; i += 1) {
        const mesh = small[i];
        const ring = smallMarkers[i];
        const raider = raiders[i];
        if (!mesh || !ring) continue;
        if (!raider) {
          mesh.visible = false;
          ring.visible = false;
          continue;
        }
        const spot = cellTop(raider.x, raider.y, 0);
        slide(mesh, spot, reduce);
        mesh.visible = raider.alive;
        ring.visible = raider.alive;
        ring.position.set(spot.x, 0.12, spot.z);
      }
      if (playing !== performanceRef.current) {
        player?.dispose();
        player = null;
        playing = performanceRef.current;
        if (playing) player = new MechaPerformancePlayer(actors, playing.events, resolveCell, scene, () => completeRef.current());
      }
      if (player) {
        player.update(reduce ? Number.POSITIVE_INFINITY : pausedRef.current ? 0 : dt);
        for (const [id, marker] of Object.entries(actorMarkers)) {
          const actor = actors[id as keyof typeof actors];
          marker.position.set(actor.position.x, 0.12, actor.position.z);
          marker.visible = actor.visible;
        }
      }
      renderer.render(scene, camera);
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
      player?.dispose();
      for (const figure of [assault, gunner, support, boss, raiderWest, raiderEast]) disposeMechaModel(figure);
      disposeMesh(deck);
      tile.geometry.dispose();
      (tile.material as THREE.Material).dispose();
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      disposePool(covers, coverMat);
      disposePool(telegraphs, telegraphMat);
      disposeMesh(selected);
      for (const ring of Object.values(markers)) disposeMesh(ring);
      renderer.dispose();
    };
  }, []);

  return (
    <div className="mecha-stage">
      <canvas ref={canvasRef} aria-label={label} />
    </div>
  );
}

function factionMarker(color: string, inner: number, outer: number, sides = 28): THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial> {
  const geo = new THREE.RingGeometry(inner, outer, sides);
  geo.rotateX(-Math.PI / 2);
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.82, depthWrite: false, side: THREE.DoubleSide }));
}

function pool(scene: THREE.Scene, count: number, material: THREE.Material, y: number): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  for (let i = 0; i < count; i += 1) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(7.2, 0.1, 7.2), material);
    mesh.visible = false;
    mesh.position.y = y;
    scene.add(mesh);
    meshes.push(mesh);
  }
  return meshes;
}

function placePads(meshes: THREE.Mesh[], cells: Array<{ x: number; y: number }>, y: number) {
  meshes.forEach((mesh, index) => {
    const cell = cells[index];
    mesh.visible = Boolean(cell);
    if (!cell) return;
    mesh.position.set((cell.x + 0.5) * CELL, y, (cell.y + 0.5) * CELL);
  });
}

function slide(mesh: THREE.Object3D, goal: THREE.Vector3, snap: boolean) {
  if (snap || mesh.position.distanceTo(goal) > 24) mesh.position.copy(goal);
  else mesh.position.lerp(goal, 0.22);
}

function disposeMesh(mesh: THREE.Mesh) {
  mesh.geometry.dispose();
  const material = mesh.material;
  if (Array.isArray(material)) material.forEach((item) => item.dispose());
  else material.dispose();
}

function disposePool(meshes: THREE.Mesh[], material: THREE.Material) {
  for (const mesh of meshes) mesh.geometry.dispose();
  material.dispose();
}
