import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { buildSync } = createRequire(path.join(repo, "apps/desktop/ui-dev/package.json"))("esbuild");
function load(file) {
  const source = buildSync({ entryPoints: [path.join(repo, "apps/agent-city/ui/src", file)], bundle: true,
    write: false, format: "cjs", platform: "node" }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, console, Date });
  return module.exports;
}
const { replayStartMs } = load("replayRange.ts");
const from = new Date(2025, 9, 3).getTime(), to = new Date(2026, 9, 3).getTime();
const event = new Date(2026, 8, 15, 12).toISOString();
assert.equal(replayStartMs([{ first_event_at: event }], from, to), Date.parse(event));
assert.equal(replayStartMs([{ first_event_at: new Date(2026, 8, 20).toISOString() }, { first_event_at: event }], from, to), Date.parse(event));
assert.equal(replayStartMs([], from, to), from);
assert.equal(replayStartMs([{ first_event_at: "bad" }], from, to), from);
assert.equal(replayStartMs([{ first_event_at: new Date(from - 86400000).toISOString() }], from, to), from);
assert.equal(replayStartMs([{ first_event_at: new Date(to + 86400000).toISOString() }], from, to), from);
const { CityWildlife } = load("engine/cityWildlife.ts");
const { CityAmbient } = load("engine/cityAmbient.ts");
const loop = [{ x: 0, z: 0 }, { x: 100, z: 0 }, { x: 100, z: 100 }, { x: 0, z: 100 }];
const wildlife = new CityWildlife({ x: 50, z: 50 }, 150, [], [], [loop], () => 3);
const wings = wildlife.group.getObjectByName("city-bird-wings");
const birds = wildlife.group.getObjectByName("city-birds");
// 街头行人已在 dfdf9ea6 移除（改为 cityParts 的静态海滩人 city-beach-people）；
// 鸟群仍是 CityWildlife 中唯一带动画的实例组。
assert.equal(wildlife.group.getObjectByName("city-pedestrians"), undefined);
assert.equal(wings.count, birds.count * 2);
wings.geometry.computeBoundingBox();
assert.ok(wings.geometry.boundingBox.max.y - wings.geometry.boundingBox.min.y >= 0.05, "bird wings retain visible low-poly thickness");
birds.geometry.computeBoundingBox();
assert.ok(birds.geometry.boundingBox.max.x > 1 && birds.geometry.boundingBox.min.x < -1, "bird silhouette includes beak and tail");
wildlife.setNight(0, to); wildlife.update(0, 0);
const birdStart = Array.from(birds.instanceMatrix.array);
const wingStart = Array.from(wings.instanceMatrix.array);
const birdPositions = Array.from({ length: birds.count }, (_, i) => [birdStart[i * 16 + 12], birdStart[i * 16 + 13], birdStart[i * 16 + 14]]);
let nearestBirds = Infinity;
for (let i = 0; i < birdPositions.length; i += 1) for (let j = i + 1; j < birdPositions.length; j += 1) {
  nearestBirds = Math.min(nearestBirds, Math.hypot(
    birdPositions[i][0] - birdPositions[j][0],
    birdPositions[i][1] - birdPositions[j][1],
    birdPositions[i][2] - birdPositions[j][2],
  ));
}
const { m, REAL, VISUAL_BOOST } = load("engine/worldScale.ts");
// Separation is a physical clearance: preserve at least one rendered wingspan after the world-scale migration.
assert.ok(nearestBirds > m(REAL.bird.wingspan * VISUAL_BOOST.bird), `bird instances must remain visually separated (nearest: ${nearestBirds.toFixed(1)})`);
const firstFlockY = birdPositions.slice(0, 7).reduce((sum, p) => sum + p[1], 0) / 7;
const secondFlockY = birdPositions.slice(7).reduce((sum, p) => sum + p[1], 0) / 7;
assert.ok(Math.abs(secondFlockY - firstFlockY) > 30, "separate flocks occupy distinct altitude bands");
wildlife.update(1, 1);
assert.notDeepEqual(Array.from(birds.instanceMatrix.array), birdStart, "flock follows a moving route");
assert.notDeepEqual(Array.from(wings.instanceMatrix.array), wingStart);
wildlife.update(0, 0);
assert.deepEqual(Array.from(birds.instanceMatrix.array), birdStart, "flight path rewinds deterministically");
assert.deepEqual(Array.from(wings.instanceMatrix.array), wingStart, "wing phase rewinds deterministically");
let disposed = 0;
for (const mesh of [birds, wings]) {
  mesh.geometry.addEventListener("dispose", () => disposed++);
  mesh.material.addEventListener("dispose", () => disposed++);
}
wildlife.dispose(); assert.equal(disposed, 4);
const empty = new CityWildlife({ x: 0, z: 0 }, 150, [], [], [], () => 0);
assert.equal(empty.group.getObjectByName("city-pedestrians"), undefined); empty.dispose();
const ambient = new CityAmbient({ x: 0, z: 0 }, 150, () => -10, []);
const balloons = ambient.group.children.filter((child) => child.name === "city-hot-air-balloon");
assert.equal(balloons.length, 3);
for (const balloon of balloons) {
  assert.equal(balloon.children.length, 6, "balloon envelope, basket, cables, burner, and two night lights");
  const envelope = balloon.children[0], basket = balloon.children[1];
  assert.ok(envelope.geometry.getAttribute("color"), "balloon envelope has panel colors");
  assert.ok(basket.geometry.getAttribute("color"), "basket has woven bands");
  envelope.geometry.computeBoundingBox();
  assert.ok(envelope.geometry.boundingBox.max.y - envelope.geometry.boundingBox.min.y >= 21, "balloon envelope has a tapered upright profile");
  const balloonLights = balloon.children.filter((child) => child.isPointLight);
  assert.equal(balloonLights.length, 2, "balloon includes envelope and basket point lights");
}
ambient.setNight(0.8);
assert.ok(balloons.every((balloon) => balloon.children.filter((child) => child.isPointLight).every((light) => light.visible && light.intensity > 0)), "balloon warm lights switch on at night");
ambient.setNight(0);
assert.ok(balloons.every((balloon) => balloon.children.filter((child) => child.isPointLight).every((light) => !light.visible)), "balloon lights switch off during daytime");
ambient.dispose();
console.log("City migration: passed (replay, wildlife motion/formation, balloon geometry, rewind, disposal, empty scene).");
