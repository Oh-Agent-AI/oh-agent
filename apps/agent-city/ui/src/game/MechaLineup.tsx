/** Rules board in world units. 1 unit = 2 m, one cell = 16 m. The grid underneath stays the input. */
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { BOARD } from "./mecha/rules";
import { createAssault, createBoss, createGunner, createRaider, createSupport, disposeMechaModel } from "../render/mecha/models";

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

export function MechaLineup({ label, view }: { label: string; view: MechaBoardView }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

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
    // 小怪与城市视图同用 createRaider（原先是缩小的 createBoss，两处模型不一致）；城市视图也只对所有单位统一放大，不单独缩小
    const raiderWest = createRaider();
    const raiderEast = createRaider();
    const figures = { Assault: assault, Gunner: gunner, Support: support };
    for (const figure of [assault, gunner, support, boss, raiderWest, raiderEast]) scene.add(figure);

    const camera = new THREE.PerspectiveCamera(36, 1, 0.5, 500);
    const center = new THREE.Vector3(BOARD_SPAN / 2, 2, 40);
    camera.position.set(92, 58, 118);
    camera.lookAt(center);

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    const draw = () => {
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
      const small = [raiderWest, raiderEast];
      const raiders = current.raiders ?? [];
      for (let i = 0; i < small.length; i += 1) {
        const mesh = small[i];
        const raider = raiders[i];
        if (!mesh) continue;
        if (!raider) {
          mesh.visible = false;
          continue;
        }
        slide(mesh, cellTop(raider.x, raider.y, 0), reduce);
        mesh.visible = raider.alive;
      }
      renderer.render(scene, camera);
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame);
      for (const figure of [assault, gunner, support, boss, raiderWest, raiderEast]) disposeMechaModel(figure);
      disposeMesh(deck);
      tile.geometry.dispose();
      (tile.material as THREE.Material).dispose();
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      disposePool(covers, coverMat);
      disposePool(telegraphs, telegraphMat);
      disposeMesh(selected);
      renderer.dispose();
    };
  }, []);

  return (
    <div className="mecha-stage">
      <canvas ref={canvasRef} aria-label={label} />
    </div>
  );
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
