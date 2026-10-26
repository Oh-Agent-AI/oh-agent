/** Synthetic mecha model review only; no host bridge or city data. Not a production entry. */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  MECHA_CELL_METERS, MECHA_METERS_PER_UNIT,
  createAssault, createBoss, createGunner, createRaider, createSupport, disposeMechaModel,
} from "../render/mecha/models";

import { MechaAnimator, type MechaAction } from "../render/mecha/animation";

type ModelId = "assault" | "gunner" | "support" | "boss" | "raider";
type ViewId = "hero" | "front" | "side" | "rear" | "top";

/** One tactics cell in world units (8 units = 16 m). */
const CELL = MECHA_CELL_METERS / MECHA_METERS_PER_UNIT;

const MODELS: Record<ModelId, { label: string; cells: number; create: () => THREE.Group }> = {
  assault: { label: "突击 Assault", cells: 1, create: createAssault },
  gunner: { label: "射手 Gunner", cells: 1, create: createGunner },
  support: { label: "支援 Support", cells: 1, create: createSupport },
  boss: { label: "大怪 Boss", cells: 2, create: createBoss },
  raider: { label: "袭扰者 Raider", cells: 1, create: createRaider },
};

const stage = document.querySelector<HTMLElement>("#stage")!;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
stage.append(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color("#07131e");
scene.fog = new THREE.Fog("#07131e", 140, 360);

const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 900);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.maxPolarAngle = Math.PI / 2 - 0.015;

scene.add(new THREE.HemisphereLight("#d5e9ff", "#1b1410", 1.45));
const key = new THREE.DirectionalLight("#fff1d6", 3.1);
key.position.set(30, 56, -24);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -56;
key.shadow.camera.right = 56;
key.shadow.camera.top = 56;
key.shadow.camera.bottom = -56;
key.shadow.camera.near = 1;
key.shadow.camera.far = 180;
key.shadow.normalBias = 0.35;
scene.add(key);
const rim = new THREE.DirectionalLight("#6fb7ff", 2.4);
rim.position.set(-34, 26, 38);
scene.add(rim);
const fill = new THREE.PointLight("#ffb86b", 160, 140, 2);
fill.position.set(0, 14, -30);
scene.add(fill);

const floorGeo = new THREE.CircleGeometry(110, 64);
const floorMat = new THREE.MeshStandardMaterial({ color: "#10222f", roughness: 0.96, metalness: 0.02 });
const floor = new THREE.Mesh(floorGeo, floorMat);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

const grid = new THREE.GridHelper(96, 12, "#2f5976", "#1b3a51");
grid.position.y = 0.012;
scene.add(grid);

const cellMat = new THREE.MeshBasicMaterial({ color: "#3fd6a0", transparent: true, opacity: 0.12, depthWrite: false });
const cell = new THREE.Mesh(new THREE.PlaneGeometry(CELL, CELL), cellMat);
cell.rotation.x = -Math.PI / 2;
cell.position.y = 0.02;
scene.add(cell);
const cellEdgeGeo = new THREE.EdgesGeometry(new THREE.PlaneGeometry(CELL, CELL));
const cellEdge = new THREE.LineSegments(cellEdgeGeo, new THREE.LineBasicMaterial({ color: "#3fd6a0", transparent: true, opacity: 0.7 }));
cellEdge.rotation.x = -Math.PI / 2;
cellEdge.position.y = 0.03;
scene.add(cellEdge);

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const modelSelect = element<HTMLSelectElement>("model");
const viewSelect = element<HTMLSelectElement>("view");
const actionSelect = element<HTMLSelectElement>("action");
const progress = element<HTMLInputElement>("progress");
const animate = element<HTMLInputElement>("animate");
const loop = element<HTMLInputElement>("loop");
const spin = element<HTMLInputElement>("spin");
const stats = element<HTMLOutputElement>("stats");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

for (const [id, model] of Object.entries(MODELS) as Array<[ModelId, (typeof MODELS)[ModelId]]>) {
  const option = document.createElement("option");
  option.value = id;
  option.textContent = model.label;
  modelSelect.append(option);
}
const params = new URLSearchParams(location.search);
const requestedModel = params.get("model");
const initialModel: ModelId = requestedModel && requestedModel in MODELS ? requestedModel as ModelId : "assault";
modelSelect.value = initialModel;
const requestedView = params.get("view");
if (requestedView && ["hero", "front", "side", "rear", "top"].includes(requestedView)) {
  viewSelect.value = requestedView;
}

let animator: MechaAnimator | null = null;
let restSize = new THREE.Vector3();
let modelRoot: THREE.Group | null = null;
let modelId: ModelId = "assault";
let lastStats = "";
let frame = 0;
let previous = 0;

function boxOf(root: THREE.Object3D): { size: THREE.Vector3; center: THREE.Vector3; radius: number } {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  return { size, center, radius: Math.max(size.x, size.y, size.z) };
}

function frameModel(): void {
  if (!modelRoot) return;
  const { center, radius } = boxOf(modelRoot);
  const view = viewSelect.value as ViewId;
  const offsets: Record<ViewId, [number, number, number]> = {
    hero: [radius * 1.55, radius * 0.72, -radius * 2.15],
    front: [0, radius * 0.42, -radius * 2.8],
    side: [radius * 2.8, radius * 0.42, 0],
    rear: [0, radius * 0.42, radius * 2.8],
    top: [0.001, radius * 3.4, 0.001],
  };
  const [ox, oy, oz] = offsets[view];
  camera.position.set(center.x + ox, center.y + oy, center.z + oz);
  controls.target.copy(center);
  controls.minDistance = radius * 0.85;
  controls.maxDistance = radius * 7;
  camera.near = Math.max(0.1, radius / 200);
  camera.far = Math.max(200, radius * 40);
  camera.updateProjectionMatrix();
  controls.update();
  lastStats = "";
}

function loadModel(id: ModelId): void {
  if (modelRoot) {
    scene.remove(modelRoot);
    disposeMechaModel(modelRoot);
    modelRoot = null;
  }
  modelId = id;
  modelRoot = MODELS[id].create();
  modelRoot.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      object.castShadow = true;
      object.receiveShadow = true;
    }
  });
  scene.add(modelRoot);
  restSize = boxOf(modelRoot).size;
  animator = new MechaAnimator(modelRoot);
  const repairOption = actionSelect.querySelector<HTMLOptionElement>('option[value="repair"]')!;
  repairOption.disabled = id !== "support";
  if (id !== "support" && actionSelect.value === "repair") actionSelect.value = "attack";
  animator.play(actionSelect.value as MechaAction);
  progress.value = "0";
  const cells = MODELS[id].cells;
  cell.scale.setScalar(cells);
  cellEdge.scale.setScalar(cells);
  frameModel();
}

function updateStats(): void {
  if (!modelRoot) return;
  const size = restSize;
  const m = (units: number) => (units * MECHA_METERS_PER_UNIT).toFixed(1);
  const text = `${MODELS[modelId].label} · ${m(size.x)} × ${m(size.z)} × ${m(size.y)} m（宽 × 深 × 高） · ${renderer.info.render.triangles.toLocaleString()} 三角形 · ${renderer.info.render.calls} draws`;
  if (text !== lastStats) {
    lastStats = text;
    stats.value = text;
  }
}

const resize = () => {
  const width = stage.clientWidth;
  const height = stage.clientHeight;
  if (width <= 0 || height <= 0) return;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
};

const tick = (now: number) => {
  const dt = previous ? Math.min(0.05, (now - previous) / 1000) : 0;
  previous = now;
  controls.autoRotate = spin.checked && !reduceMotion.matches;
  controls.autoRotateSpeed = 0.9;
  controls.update(dt);
  if (animate.checked) animator?.update(dt, reduceMotion.matches, loop.checked);
  renderer.render(scene, camera);
  updateStats();
  frame = requestAnimationFrame(tick);
};

const requestedAction = params.get("action");
if (["idle", "move", "attack", "repair", "hit", "defeat"].includes(requestedAction ?? "")) actionSelect.value = requestedAction!;
actionSelect.addEventListener("change", () => {
  animator?.play(actionSelect.value as MechaAction, true);
  if (!animate.checked) animator?.seek(Number(progress.value) / 100, reduceMotion.matches);
});
progress.addEventListener("input", () => {
  animate.checked = false;
  animator?.play(actionSelect.value as MechaAction);
  animator?.seek(Number(progress.value) / 100, reduceMotion.matches);
});
element<HTMLButtonElement>("replay").addEventListener("click", () => { animator?.play(actionSelect.value as MechaAction, true); animate.checked = true; });
modelSelect.addEventListener("change", () => loadModel(modelSelect.value as ModelId));
viewSelect.addEventListener("change", frameModel);
element<HTMLButtonElement>("reframe").addEventListener("click", frameModel);
window.addEventListener("resize", resize);
const observer = new ResizeObserver(resize);
observer.observe(stage);

loadModel(initialModel);
resize();
frame = requestAnimationFrame(tick);

window.addEventListener("pagehide", () => {
  cancelAnimationFrame(frame);
  observer.disconnect();
  window.removeEventListener("resize", resize);
  controls.dispose();
  if (modelRoot) disposeMechaModel(modelRoot);
  floorGeo.dispose(); floorMat.dispose();
  grid.geometry.dispose();
  (grid.material as THREE.Material).dispose();
  cell.geometry.dispose(); cellMat.dispose();
  cellEdgeGeo.dispose();
  (cellEdge.material as THREE.Material).dispose();
  renderer.dispose();
}, { once: true });
