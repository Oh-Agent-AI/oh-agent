/** Synthetic model review only; no host bridge or real city data. Not a production entry. */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CarVisuals } from "../game/CarVisuals";

const stage = document.querySelector<HTMLElement>("#stage")!;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
stage.append(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color("#e9e6de");
const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 100);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.52, 0); controls.minDistance = 3; controls.maxDistance = 12;
controls.maxPolarAngle = Math.PI / 2 - 0.02;
const fill = new THREE.HemisphereLight("#eef6ff", "#777963", 2.6); scene.add(fill);
const sun = new THREE.DirectionalLight("#fff0d8", 4);
sun.position.set(3, 7, 5); sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024); sun.shadow.camera.left = -4; sun.shadow.camera.right = 4;
sun.shadow.camera.top = 4; sun.shadow.camera.bottom = -4; sun.shadow.normalBias = 0.025;
scene.add(sun);
const car = new CarVisuals(); scene.add(car.root);
const floorGeometry = new THREE.CylinderGeometry(2.5, 2.5, 0.08, 64);
const floorMaterial = new THREE.MeshStandardMaterial({ color: "#bcc7b5", roughness: 0.96 });
const floor = new THREE.Mesh(floorGeometry, floorMaterial); floor.position.y = -0.045; floor.receiveShadow = true; scene.add(floor);
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const steering = element<HTMLInputElement>("steering");
const brake = element<HTMLInputElement>("brake");
const reverse = element<HTMLInputElement>("reverse");
const night = element<HTMLInputElement>("night");
const button = element<HTMLButtonElement>("rolling");
let rolling = false; let distance = 0; let previous = 0; let frame = 0;
const resize = () => {
  renderer.setSize(stage.clientWidth, stage.clientHeight);
  camera.aspect = stage.clientWidth / stage.clientHeight; camera.updateProjectionMatrix();
};
const view = () => {
  const positions: Record<string, [number, number, number]> = {
    hero: [4.6, 2.7, 4.4], front: [6, 1.8, 0], side: [0, 1.7, 6], rear: [-5, 2.1, 3.5],
  };
  camera.position.set(...positions[element<HTMLSelectElement>("view").value]); controls.update();
};
const toggle = () => {
  rolling = !rolling; button.textContent = rolling ? "暂停车轮" : "播放车轮";
  button.setAttribute("aria-pressed", String(rolling));
};
button.addEventListener("click", toggle);
element<HTMLSelectElement>("view").addEventListener("change", view);
window.addEventListener("resize", resize);
const motion = matchMedia("(prefers-reduced-motion: reduce)");
const stopMotion = () => { if (motion.matches && rolling) toggle(); };
motion.addEventListener("change", stopMotion);
const tick = (now: number) => {
  const dt = previous ? Math.min(0.05, (now - previous) / 1000) : 0; previous = now;
  if (rolling && !brake.checked) distance += dt * (reverse.checked ? -1 : 1) * 1.8;
  car.update({ x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, steering: Number(steering.value), distance, braking: brake.checked, reversing: reverse.checked });
  (scene.background as THREE.Color).set(night.checked ? "#182927" : "#e9e6de");
  document.body.classList.toggle("night", night.checked);
  fill.intensity = night.checked ? 0.9 : 2.6; sun.intensity = night.checked ? 0.7 : 4;
  renderer.render(scene, camera);
  element<HTMLOutputElement>("stats").value = `车模 11 draws · ${renderer.info.render.triangles.toLocaleString()} 场景三角形`;
  frame = requestAnimationFrame(tick);
};
resize(); view(); frame = requestAnimationFrame(tick);
window.addEventListener("pagehide", () => {
  cancelAnimationFrame(frame); motion.removeEventListener("change", stopMotion);
  window.removeEventListener("resize", resize); controls.dispose(); car.dispose();
  floorGeometry.dispose(); floorMaterial.dispose(); renderer.dispose();
}, { once: true });
