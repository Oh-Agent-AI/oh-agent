import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import { readFileSync } from "node:fs";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { buildSync } = createRequire(path.join(repo, "apps/desktop/ui-dev/package.json"))("esbuild");
const THREE = createRequire(path.join(repo, "apps/agent-city/ui/package.json"))("three");
function load(file) {
  const source = buildSync({ entryPoints: [path.join(repo, "apps/agent-city/ui/src/engine", file)], bundle: true,
    write: false, outfile: path.join(repo, "target/camera-test.cjs"), format: "cjs", platform: "node",
    loader: { ".glb": "file", ".jpg": "file", ".png": "file" } }).outputFiles.find(item => item.path.endsWith(".cjs")).text;
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, console, Date });
  return module.exports;
}
const { buildingFrame, isSelectionGesture } = load("cityCameraInteraction.ts");
// Landing framing is presentation-only: native and standalone previews retain their overview.
const engineSource = readFileSync(path.join(repo, "apps/agent-city/ui/src/engine/CityEngine.ts"), "utf8");
const homeSource = engineSource.slice(engineSource.indexOf("  private homeView()"), engineSource.indexOf("  private flyTo("))
  .replace("private homeView(): { x: number; y: number; z: number }", "function homeView()").trim();
const framing = { boundsRadius: 200, cityCenter: { x: 0, z: 0 }, camera: { aspect: 1.5 }, layout: null };
const nativeHome = vm.runInNewContext(`(${homeSource})`, {}).call(framing);
const landingWindow = { parent: {}, location: { search: "?presentation=landing" } };
const landingHome = vm.runInNewContext(`(${homeSource})`, { window: landingWindow, URLSearchParams }).call(framing);
assert.ok(landingHome.y < nativeHome.y && landingHome.z < nativeHome.z, "landing frames the city more closely");
const standaloneWindow = { location: { search: "?presentation=landing" } };
standaloneWindow.parent = standaloneWindow;
const standaloneHome = vm.runInNewContext(`(${homeSource})`, { window: standaloneWindow, URLSearchParams }).call(framing);
assert.equal(standaloneHome.y, nativeHome.y, "standalone/native overview does not inherit landing framing");
assert.ok(buildingFrame(100, 10, 42, 0.5).distance > buildingFrame(100, 10, 42, 2).distance, "portrait views fit the horizontal FOV");
assert.ok(buildingFrame(10, 60, 42, 1).distance > buildingFrame(10, 6, 42, 1).distance, "wide buildings affect framing");
assert.ok(buildingFrame(4, 3, 42, 1).minDistance < 16, "small buildings permit closer inspection");
for (const [height, footprint, aspect] of [[1, 1, 0.1], [100, 10, 2], [10, 60, 1]]) {
  const frame = buildingFrame(height, footprint, 42, aspect);
  assert.ok(Number.isFinite(frame.distance) && frame.distance > frame.minDistance);
}
assert.equal(isSelectionGesture(0, true, 0, 150), true);
assert.equal(isSelectionGesture(2, true, 0, 150), false, "right click/pan never selects");
assert.equal(isSelectionGesture(1, true, 0, 150), false, "middle button never selects");
assert.equal(isSelectionGesture(0, false, 0, 150), false, "secondary touch never selects");
assert.equal(isSelectionGesture(0, true, 8, 150), false, "a drag that returns to its origin still is not a click");
assert.equal(isSelectionGesture(0, true, 0, 501), false);

const { CityParts } = load("cityParts.ts");
const parts = Object.create(CityParts.prototype);
Object.assign(parts, {
  anchorFor: () => ({ x: 0, z: 0, ground: 0, height: 20 }),
  formOf: () => "tower",
  runtimeById: new Map([["hotel", { building: { footprint: 4 }, display: 0.4,
    slot: { blockId: "hotel:test", width: 40, depth: 30 } }]]),
});
assert.ok(Math.abs(parts.focusAnchorFor("hotel").footprint - 36.8) < 1e-9, "hotel parcels override even tower-form width");
assert.equal(parts.focusAnchorFor("hotel").height, 8, "framing follows visible growth");

const { CityEngine } = load("CityEngine.ts");
const engine = Object.create(CityEngine.prototype);
const locks = [];
Object.assign(engine, {
  camera: new THREE.PerspectiveCamera(42, 1, 1.5, 8000),
  controls: { target: new THREE.Vector3(), enableDamping: true, enablePan: true, zoomToCursor: true, update() {} },
  parts: { focusAnchorFor: id => id === "session" ? { x: 12, z: 20, ground: 5, height: 8, footprint: 4 } : null, setSelected() {} },
  model: { buildings: [{ id: "session", footprint: 4 }] },
  boundsRadius: 150, elapsed: 0, orbitLockedId: null, tween: null,
  options: { onOrbitLock: id => locks.push(id) },
});
engine.camera.position.set(100, 60, 100);
assert.equal(engine.focusBuilding("missing"), false);
assert.equal(engine.focusBuilding("session"), true);
assert.equal(engine.selectedId, "session", "menu focus synchronizes the F-key target and selection ring");
assert.equal(engine.controls.enablePan, false);
assert.equal(engine.controls.zoomToCursor, false, "zoom must not shift a locked pivot");
assert.deepEqual(Array.from(engine.tween.toTarget.toArray()), [12, 9, 20]);
const position = engine.camera.position.toArray();
engine.interruptCameraFlight();
assert.equal(engine.tween, null);
assert.deepEqual(engine.camera.position.toArray(), position, "manual input immediately owns position");
assert.deepEqual(engine.controls.target.toArray(), [12, 9, 20], "interrupting focus retains the building pivot");
engine.releaseOrbitLock();
assert.equal(engine.controls.enablePan, true);
assert.equal(engine.controls.zoomToCursor, true);
assert.equal(locks.at(-1), null);
assert.deepEqual(engine.camera.position.toArray(), position, "unlock does not reset view");
engine.focusBuilding("session"); engine.setSelected(null);
assert.equal(engine.tween, null, "clearing selection cancels unfinished flight");
assert.equal(engine.orbitLockedId, null);
engine.homeView = () => ({ x: 100, y: 120, z: 100 });
engine.cityCenter = { x: 0, z: 0 };
engine.resetView();
assert.ok(engine.tween, "reset view retains its own flight after clearing selection");
engine.setSelected(null);
assert.ok(engine.tween, "refreshing empty selection does not cancel an unrelated camera flight");
engine.noteActivity = () => {};
assert.equal(engine.lockSelection("session"), true);
assert.deepEqual(Array.from(engine.tween.fromPos.toArray()), Array.from(engine.tween.toPos.toArray()), "selection animates orientation only, never position");
assert.equal(engine.tween.duration, 0.36, "selection uses a short smooth pivot transition");
assert.deepEqual(engine.camera.position.toArray(), position, "selection never moves the camera");
assert.deepEqual(Array.from(engine.tween.toTarget.toArray()), [12, 9, 20]);
engine.interruptCameraFlight();
engine.pickedDecor = { id: "decor:landmark:test", point: new THREE.Vector3(30, 12, 40) };
engine.pick = () => "decor:landmark:test";
engine.handleClick();
assert.equal(engine.orbitLockedId, "decor:landmark:test", "introduced decorations also lock");
assert.deepEqual(Array.from(engine.tween.toTarget.toArray()), [30, 12, 40]);
assert.deepEqual(engine.camera.position.toArray(), position, "decoration click does not zoom or fly");
engine.updateDaylight = () => {};
engine.updateCinematic = () => false;
engine.parts.update = () => false;
engine.elapsed = 0.18;
engine.updateScene(0.18);
assert.deepEqual(engine.controls.target.toArray(), [21, 10.5, 30], "halfway through easing the pivot is halfway, not an instant jump");
assert.deepEqual(engine.camera.position.toArray(), position, "orientation animation preserves position on intermediate frames");
engine.elapsed = 0.36;
engine.updateScene(0.18);
assert.equal(engine.tween, null);
assert.deepEqual(engine.controls.target.toArray(), [30, 12, 40]);
engine.releaseOrbitLock();
engine.pickedDecor = null;
assert.equal(engine.lockSelection("decor:landmark:test"), true, "F can re-lock a decoration after hover moves away");
engine.pick = () => null;
engine.handleClick();
assert.equal(engine.orbitLockedId, null, "empty-space click unlocks");
assert.equal(engine.selectedId, null, "empty-space click clears the introduction");
assert.deepEqual(engine.camera.position.toArray(), position, "empty-space click retains camera position");
engine.pickedDecor = { id: "decor:seaside", point: new THREE.Vector3(NaN, NaN, NaN) };
assert.equal(engine.lockSelection("decor:seaside"), false, "invalid decoration intersection cannot become a camera target");
assert.deepEqual(engine.camera.position.toArray(), position);
engine.camera.position.set(NaN, NaN, NaN);
engine.controls.target.set(NaN, NaN, NaN);
engine.camera.quaternion.set(NaN, NaN, NaN, NaN);
engine.controls.maxDistance = NaN;
engine.resetView();
assert.deepEqual(engine.camera.position.toArray(), [100, 120, 100], "reset recovers a damaged view instead of lerping NaN");
assert.ok(engine.camera.quaternion.toArray().every(Number.isFinite));
assert.ok(engine.controls.target.toArray().every(Number.isFinite));
assert.ok(Number.isFinite(engine.controls.maxDistance));
delete engine.pick;
engine.pointerClient = { x: 0, y: 0 };
engine.parts.raycastTargets = []; engine.parts.decorTargets = [];
engine.parts.idAt = () => null;
engine.parts.decorAt = () => "decor:volcano";
engine.raycaster = { setFromCamera() {}, intersectObjects() { return [
  { distance: NaN, point: new THREE.Vector3(NaN, NaN, NaN), object: {} },
  { distance: 10, point: new THREE.Vector3(1, 2, 3), object: {} },
]; } };
assert.equal(engine.pick(), "decor:volcano", "picking skips invalid intersections and continues to a real hit");
assert.deepEqual(engine.pickedDecor.point.toArray(), [1, 2, 3]);
console.log("City camera interaction: passed (framing, gesture classification, locked pivot, interrupt, unlock and selection cleanup).");
