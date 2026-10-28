/**
 * GLB 机甲资产的运行时合同（规格 §5）：清单校验、资产校验、原地升级、确定性采样、失败回退、释放。
 * node 里没有图片解码，所以先把贴图引用从 GLB 里剥掉——这些检查只关心节点、片段和几何。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import {
  MechaBattleAnimator, MechaAnimator, mechaActionDuration, mechaActionSpan, poseMechaModel, type MechaAction,
} from "../src/render/mecha/animation.ts";
import { MechaGlbError, instantiateMechaGlb, parseMechaGlb, parseMechaManifest, type MechaGlbAsset } from "../src/render/mecha/glbModels.ts";
import {
  MECHA_METERS_PER_UNIT, createAssault, createGunner, disposeMechaModel, installMechaGlbProvider, upgradeMechaModelToGlb,
} from "../src/render/mecha/models.ts";
import {
  MECHA_NIGHT_FILL, MECHA_NIGHT_RIM, MECHA_UNIT_LIGHT, applyMechaUnitLight, setMechaUnitLight,
} from "../src/render/mecha/unitLight.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ASSET = resolve(here, "../src/assets/mecha");
const glbBytes = readFileSync(resolve(ASSET, "assault.glb"));
const manifestJson = JSON.parse(readFileSync(resolve(ASSET, "assault.manifest.json"), "utf8"));
const CELL = 8;
const ACTIONS: MechaAction[] = ["idle", "move", "attack", "repair", "hit", "defeat"];

/** 读/写 GLB 的 JSON 块；mutate 可以改它，用来造「坏资产」。贴图引用一律剥掉。 */
function glbWith(mutate?: (json: any) => void): ArrayBuffer {
  const jsonLength = glbBytes.readUInt32LE(12);
  const json = JSON.parse(glbBytes.subarray(20, 20 + jsonLength).toString("utf8"));
  const rest = glbBytes.subarray(20 + jsonLength);
  for (const material of json.materials ?? []) {
    const pbr = material.pbrMetallicRoughness ?? {};
    delete pbr.baseColorTexture; delete pbr.metallicRoughnessTexture; delete material.emissiveTexture;
  }
  delete json.textures; delete json.images; delete json.samplers;
  mutate?.(json);
  let text = Buffer.from(JSON.stringify(json), "utf8");
  text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(20 + text.length + rest.length, 8);
  header.writeUInt32LE(text.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  const out = Buffer.concat([header, text, rest]);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}
const manifestWith = (mutate: (m: any) => void) => { const m = structuredClone(manifestJson); mutate(m); return m; };
async function loadAsset(): Promise<MechaGlbAsset> {
  return parseMechaGlb(glbWith(), parseMechaManifest(manifestJson));
}
async function rejects(promise: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(promise, (error: unknown) => error instanceof MechaGlbError && pattern.test(error.message), String(pattern));
}
/**
 * 按顶点算的包围盒（precise）。默认的 setFromObject 是把每个网格的局部包围盒转到世界再合并，网格一转，
 * 盒角会远低于真实顶点：Assault 加护膝后小腿的局部盒变大，move 被误报下沉 0.08 m，真实最低点在 1.6 m。
 */
const box = (root: THREE.Object3D) => { root.updateMatrixWorld(true); return new THREE.Box3().setFromObject(root, true); };

test("the shipped manifest parses and an invalid one is refused with every problem named", () => {
  const manifest = parseMechaManifest(manifestJson);
  assert.equal(manifest.role, "Assault");
  assert.deepEqual(manifest.footprint, [1, 1]);
  assert.equal(manifest.actionMap?.repair, "attack");
  assert.throws(() => parseMechaManifest(manifestWith((m) => { delete m.clips.hit; })), /clip hit missing/);
  assert.throws(() => parseMechaManifest(manifestWith((m) => { m.actionMap.repair = "nope"; })), /not a clip/);
  assert.throws(() => parseMechaManifest(manifestWith((m) => { delete m.actionMap; })), /repair has neither a clip nor an actionMap/);
  assert.throws(() => parseMechaManifest(manifestWith((m) => { m.forward = "+Z"; })), /forward/);
  assert.throws(() => parseMechaManifest(manifestWith((m) => { m.clips.idle.duration = 0; })), /clip idle/);
  assert.throws(() => parseMechaManifest(manifestWith((m) => { m.maxExtentMeters = [30, 9]; })), /exceeds 1.5/);
  assert.throws(() => parseMechaManifest(manifestWith((m) => { m.maxExtentMeters = [20]; })), /maxExtentMeters/);
  assert.throws(() => parseMechaManifest(null), MechaGlbError);
});

test("the shipped GLB satisfies the node, clip, size and facing contract", async () => {
  const asset = await loadAsset();
  const rest = box(asset.scene);
  assert.ok(Math.abs(rest.min.y) < 0.05, `feet ${rest.min.y}`);
  assert.ok(Math.abs(rest.getSize(new THREE.Vector3()).y - manifestJson.heightMeters) < 0.5);
  const size = rest.getSize(new THREE.Vector3());
  const [maxX, maxZ] = manifestJson.maxExtentMeters as [number, number];
  assert.ok(size.x <= maxX && size.z <= maxZ, `within the declared overhang extent, got ${size.x.toFixed(2)}×${size.z.toFixed(2)}`);
  assert.ok(size.x <= 16 * 1.5 && size.z <= 16 * 1.5, "overhang is at most half a cell");
  assert.deepEqual(asset.clips.map((c) => c.name).sort(), ["attack", "defeat", "hit", "idle", "move"]);
});

test("a GLB that breaks the contract is refused, not half-used", async () => {
  const manifest = parseMechaManifest(manifestJson);
  const nodeIndex = (json: any, name: string) => json.nodes.findIndex((n: any) => n.name === name);
  await rejects(parseMechaGlb(glbWith((j) => { j.nodes[nodeIndex(j, "forearm_r")].name = "forearm_x"; }), manifest), /missing node forearm_r/);
  await rejects(parseMechaGlb(glbWith((j) => { j.nodes[nodeIndex(j, "front")].name = "face"; }), manifest), /missing marker node front/);
  await rejects(parseMechaGlb(glbWith((j) => { j.nodes[nodeIndex(j, "shin_l")].name = "body"; }), manifest), /missing node shin_l/);
  await rejects(parseMechaGlb(glbWith((j) => { j.nodes[nodeIndex(j, "head")].rotation = [0, 0.3, 0, 0.95]; }), manifest), /head rest rotation/);
  await rejects(parseMechaGlb(glbWith((j) => { j.animations.splice(j.animations.findIndex((a: any) => a.name === "hit"), 1); }), manifest), /clip hit is in the manifest but not in the GLB/);
  await rejects(parseMechaGlb(glbWith(), parseMechaManifest(manifestWith((m) => { m.clips.attack.duration = 1.4; }))), /clip attack lasts/);
  await rejects(parseMechaGlb(glbWith(), parseMechaManifest(manifestWith((m) => { m.heightMeters = 30; }))), /height/);
  // 声明了外伸范围就按声明放行；声明得比模型小、或没声明（回到「占格 − 1 m」），都必须被拒
  await rejects(parseMechaGlb(glbWith(), parseMechaManifest(manifestWith((m) => { m.maxExtentMeters = [18, 9.8]; }))), /width .* declared extent/);
  await rejects(parseMechaGlb(glbWith(), parseMechaManifest(manifestWith((m) => { m.maxExtentMeters = [20.5, 8]; }))), /depth .* declared extent/);
  await rejects(parseMechaGlb(glbWith(), parseMechaManifest(manifestWith((m) => { delete m.maxExtentMeters; }))), /does not fit 1×1 cell/);
  await rejects(parseMechaGlb(glbWith(), parseMechaManifest(manifestWith((m) => { m.footprint = [1, 1]; m.role = "Support"; }))), /no GLB contract for role Support/);
  await rejects(parseMechaGlb(new ArrayBuffer(32), manifest), /cannot parse GLB/);
});

test("upgrading keeps the root, scale and animator key; the model stays in its cell, on the ground", async () => {
  const asset = await loadAsset();
  const root = createAssault();
  const animator = new MechaAnimator(root);
  root.position.set(3, 1, -2); root.rotation.y = 0.7; root.scale.setScalar(2);
  const before = { p: root.position.clone(), r: root.rotation.y, s: root.scale.x, id: root.id };
  assert.equal(upgradeMechaModelToGlb(root, asset), true);
  assert.equal(root.userData.glb, true);
  assert.deepEqual([root.position.toArray(), root.rotation.y, root.scale.x, root.id], [before.p.toArray(), before.r, before.s, before.id]);
  assert.equal(root.getObjectByName("mecha-visual"), undefined, "procedural visual is gone");
  assert.equal(root.getObjectByName("gauntlet-right")?.type, "Mesh");
  root.position.set(0, 0, 0); root.rotation.y = 0; root.scale.setScalar(1);
  const b = box(root);
  assert.ok(b.min.y > -0.05 && b.min.y < 0.05, `feet ${b.min.y}`);
  const [maxX, maxZ] = (manifestJson.maxExtentMeters as [number, number]).map((m) => m / MECHA_METERS_PER_UNIT);
  assert.ok(b.max.x - b.min.x <= maxX && b.max.z - b.min.z <= maxZ, "stays within its declared extent");
  assert.ok(b.max.x - b.min.x < CELL * 1.5 && b.max.z - b.min.z < CELL * 1.5, "overhang is at most half a cell");
  assert.ok(Math.abs(b.max.y - manifestJson.heightMeters / MECHA_METERS_PER_UNIT) < 0.3, `height ${b.max.y}`);
  const front = new THREE.Vector3(); root.getObjectByName("front")!.getWorldPosition(front);
  assert.ok(front.z < -0.5, "faces -Z like the procedural models");
  animator.play("attack"); animator.update(0.4);
  assert.notEqual(upgradeMechaModelToGlb(root, asset), true, "a second upgrade is a no-op");
  disposeMechaModel(root);
});

test("every action at every sample time is finite, grounded and leaves the board-owned root alone", async () => {
  const asset = await loadAsset();
  const root = createAssault();
  upgradeMechaModelToGlb(root, asset);
  const rest = box(root);
  for (const action of ACTIONS) {
    for (const time of [0, 0.2, 0.5, 0.79, 0.85, 3.2, 99]) {
      poseMechaModel(root, action, time);
      root.updateMatrixWorld(true);
      root.traverse((n) => assert.ok(n.matrixWorld.elements.every(Number.isFinite), `${action}@${time} ${n.name}`));
      assert.deepEqual(root.position.toArray(), [0, 0, 0]);
      assert.equal(root.rotation.y, 0);
      assert.ok(box(root).min.y > -0.05, `${action}@${time} sinks to ${box(root).min.y}`);
    }
  }
  poseMechaModel(root, "idle", 0);
  assert.ok(rest.min.distanceTo(box(root).min) < 1e-5 && rest.max.distanceTo(box(root).max) < 1e-5, "idle@0 is the bind pose");
  poseMechaModel(root, "move", 0.3, true);
  assert.ok(rest.max.distanceTo(box(root).max) < 1e-5, "reduced motion shows the still model");
  disposeMechaModel(root);
});

test("sampling is deterministic, loops seamlessly, and a finished one-shot can be sampled again", async () => {
  const asset = await loadAsset();
  const root = createAssault();
  upgradeMechaModelToGlb(root, asset);
  const hand = root.getObjectByName("gauntlet-right")!;
  const at = (action: MechaAction, t: number) => { poseMechaModel(root, action, t); root.updateMatrixWorld(true); return hand.matrixWorld.elements.slice(); };
  const first = at("attack", 0.45);
  at("idle", 1); at("defeat", 5); at("attack", 2);        // 播完的单次片段不能把后面的采样卡在 0 秒；倒地的抬高也不能残留到下一个片段
  assert.deepEqual(at("attack", 0.45), first);
  assert.notDeepEqual(at("attack", 0.45), at("attack", 0), "the fist actually moves");
  const wrap = at("move", 0.79 - 1e-4).map((v, i) => Math.abs(v - at("move", 0)[i]));
  assert.ok(Math.max(...wrap) < 0.05, "move loop has no seam");
  disposeMechaModel(root);
});

test("durations come from the manifest, loops have no end, and repair maps to attack", async () => {
  const asset = await loadAsset();
  const root = createAssault();
  assert.equal(mechaActionDuration(root, "attack"), 0.95, "procedural default before the upgrade");
  upgradeMechaModelToGlb(root, asset);
  assert.equal(mechaActionDuration(root, "attack"), manifestJson.clips.attack.duration);
  assert.equal(mechaActionDuration(root, "repair"), manifestJson.clips.attack.duration, "actionMap, not the procedural 1.2 s");
  assert.equal(mechaActionDuration(root, "hit"), manifestJson.clips.hit.duration);
  assert.equal(mechaActionDuration(root, "defeat"), manifestJson.clips.defeat.duration);
  assert.equal(mechaActionDuration(root, "idle"), undefined);
  assert.equal(mechaActionDuration(root, "move"), undefined);
  assert.equal(mechaActionSpan(root, "idle"), manifestJson.clips.idle.duration, "scrubbing a loop still has a length");
  disposeMechaModel(root);
});

test("a fallen model rests above the ground, holds the final pose, and respawn restores it", async () => {
  const asset = await loadAsset();
  const root = createAssault();
  upgradeMechaModelToGlb(root, asset);
  poseMechaModel(root, "defeat", 5);
  const visual = root.getObjectByName("visual")!;
  assert.ok(Math.abs(visual.rotation.x - Math.PI / 2) < 0.05, `fell to ${visual.rotation.x}`);
  assert.ok(box(root).min.y > -0.05, "lifted by the runtime, not by the clip");
  assert.equal(visual.position.y, 0, "the lift never touches the animated node");
  poseMechaModel(root, "defeat", 0.1, true);
  assert.ok(Math.abs(visual.rotation.x - Math.PI / 2) < 0.05, "reduced motion shows the final pose");
  const battle = new MechaBattleAnimator(root);
  battle.sync(14, 0);
  battle.sync(0, 1, "attack");
  for (let i = 0; i < 70; i++) { battle.sync(0, 1, "attack"); battle.update(1 / 60, false); }
  assert.equal(battle.animator.action, "hit", "attack 0.95 s then hit, timed by the manifest");
  for (let i = 0; i < 80; i++) battle.update(1 / 60, false);
  assert.equal(battle.animator.action, "defeat");
  battle.sync(14, 2);
  battle.update(0, false);
  assert.equal(battle.animator.action, "idle");
  assert.ok(Math.abs(visual.rotation.x) < 1e-6, "standing again");
  disposeMechaModel(root);
});

test("instances share geometry and materials; disposing one leaves the others (and the cache) intact", async () => {
  const asset = await loadAsset();
  const a = createAssault(), b = createAssault();
  upgradeMechaModelToGlb(a, asset); upgradeMechaModelToGlb(b, asset);
  const meshOf = (r: THREE.Object3D) => r.getObjectByName("gauntlet-right") as THREE.Mesh;
  assert.equal(meshOf(a).geometry, meshOf(b).geometry);
  assert.equal(meshOf(a).material, meshOf(b).material);
  let disposed = 0;
  meshOf(a).geometry.addEventListener("dispose", () => { disposed++; });
  disposeMechaModel(a);
  assert.equal(disposed, 0, "shared geometry belongs to the cache");
  assert.equal(a.parent, null);
  poseMechaModel(b, "attack", 0.3);
  assert.ok(box(b).max.y > 5, "the other instance still animates");
  assert.equal(upgradeMechaModelToGlb(a, asset), false, "a disposed model is not resurrected");
  disposeMechaModel(b);
});

test("failure falls back to the procedural model: bad asset, failed load, no provider, unknown role", async () => {
  const asset = await loadAsset();
  const bad = { ...asset, scene: asset.scene.clone(true) } as MechaGlbAsset;
  bad.scene.getObjectByName("visual")!.name = "nope";
  const root = createAssault();
  const warn = console.warn; console.warn = () => undefined;
  try {
    assert.equal(upgradeMechaModelToGlb(root, bad), false);
    assert.throws(() => instantiateMechaGlb(bad, 2), MechaGlbError);
  } finally { console.warn = warn; }
  assert.ok(root.getObjectByName("mecha-visual"), "still the procedural model");
  poseMechaModel(root, "attack", 0.45);
  assert.ok(root.userData.glb !== true);
  disposeMechaModel(root);

  let loads = 0;
  installMechaGlbProvider({ has: () => true, peek: () => null, load: () => { loads++; return Promise.reject(new MechaGlbError("offline")); } });
  const stuck = createAssault();
  await new Promise((resolveTick) => setTimeout(resolveTick, 0));
  assert.equal(loads, 1);
  assert.ok(stuck.getObjectByName("mecha-visual") && !stuck.userData.glb, "load failure leaves the procedural model, nothing thrown");
  disposeMechaModel(stuck);

  installMechaGlbProvider({ has: (role) => role === "Assault", peek: () => asset, load: () => Promise.resolve(asset) });
  assert.equal(createGunner().userData.glb, undefined, "a role without a registered GLB stays procedural");
  const born = createAssault();
  assert.equal(born.userData.glb, true, "an already-loaded asset is used at birth, no procedural flash");
  disposeMechaModel(born);

  let resolveLate!: (a: MechaGlbAsset) => void;
  installMechaGlbProvider({ has: () => true, peek: () => null, load: () => new Promise((r) => { resolveLate = r; }) });
  const early = createAssault();
  disposeMechaModel(early);                       // 在资产回来之前就销毁（比如用户关掉了 City）
  resolveLate(asset);
  await new Promise((resolveTick) => setTimeout(resolveTick, 0));
  assert.ok(early.userData.glb !== true, "a model destroyed before the asset arrived is not upgraded");
  installMechaGlbProvider(null);
});

// ---- Gunner（规格 §8 的第一个角色；Assault 之后接入）
const gunnerBytes = readFileSync(resolve(ASSET, "gunner.glb"));
const gunnerManifestJson = JSON.parse(readFileSync(resolve(ASSET, "gunner.manifest.json"), "utf8"));
const gunnerGlb = (mutate?: (json: any) => void) => {
  const jsonLength = gunnerBytes.readUInt32LE(12);
  const json = JSON.parse(gunnerBytes.subarray(20, 20 + jsonLength).toString("utf8"));
  const rest = gunnerBytes.subarray(20 + jsonLength);
  for (const material of json.materials ?? []) {
    const pbr = material.pbrMetallicRoughness ?? {};
    delete pbr.baseColorTexture; delete pbr.metallicRoughnessTexture; delete material.emissiveTexture;
  }
  delete json.textures; delete json.images; delete json.samplers;
  mutate?.(json);
  let text = Buffer.from(JSON.stringify(json), "utf8");
  text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(20 + text.length + rest.length, 8);
  header.writeUInt32LE(text.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  const out = Buffer.concat([header, text, rest]);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
};

test("the Gunner GLB satisfies its contract: railgun under body, front marker, declared cannon overhang", async () => {
  const manifest = parseMechaManifest(gunnerManifestJson);
  assert.equal(manifest.role, "Gunner");
  const asset = await parseMechaGlb(gunnerGlb(), manifest);
  assert.equal(asset.scene.getObjectByName("railgun")?.parent?.name, "body");
  const size = box(asset.scene).getSize(new THREE.Vector3());
  const [maxX, maxZ] = gunnerManifestJson.maxExtentMeters as [number, number];
  assert.ok(size.x <= maxX && size.z <= maxZ, `within the declared extent, got ${size.x.toFixed(2)}×${size.z.toFixed(2)}`);
  assert.ok(size.z > 15, "the rail cannon reaches past the cell, as the concept silhouette has it");
  const nodeIndex = (json: any, name: string) => json.nodes.findIndex((n: any) => n.name === name);
  await rejects(parseMechaGlb(gunnerGlb((j) => { j.nodes[nodeIndex(j, "railgun")].name = "cannon_x"; }), manifest), /missing node railgun/);
  await rejects(parseMechaGlb(gunnerGlb(), parseMechaManifest({ ...gunnerManifestJson, maxExtentMeters: undefined })), /does not fit 1×1 cell/);
});

test("a Gunner upgrades in place, recoils its railgun on attack and stays grounded", async () => {
  const asset = await parseMechaGlb(gunnerGlb(), parseMechaManifest(gunnerManifestJson));
  const root = createGunner();
  assert.equal(upgradeMechaModelToGlb(root, asset), true);
  const rail = root.getObjectByName("railgun")!;
  const at = (action: MechaAction, s: number) => { poseMechaModel(root, action, s); root.updateMatrixWorld(true); return rail.getWorldPosition(new THREE.Vector3()); };
  const rest = at("idle", 0), mid = at("attack", 0.6);
  assert.ok(mid.z - rest.z > 0.2, `railgun slides back on attack (${(mid.z - rest.z).toFixed(2)} units)`);
  for (const action of ["idle", "move", "attack", "hit"] as MechaAction[]) {
    for (let i = 0; i <= 8; i++) {
      poseMechaModel(root, action, (mechaActionSpan(root, action) * i) / 8);
      assert.ok(box(root).min.y > -0.05, `${action} sinks below the ground at step ${i}`);
    }
  }
  disposeMechaModel(root);
});

test("night unit light is off by default, ramps with night and patches each shared material once", async () => {
  const asset = await parseMechaGlb(gunnerGlb(), parseMechaManifest(gunnerManifestJson));
  const a = createGunner(), b = createGunner();
  upgradeMechaModelToGlb(a, asset); upgradeMechaModelToGlb(b, asset);
  assert.equal(MECHA_UNIT_LIGHT.mechaFill.value, 0, "pages that never set it (model preview, tests) look unchanged");
  applyMechaUnitLight(a); applyMechaUnitLight(b); applyMechaUnitLight(a);
  const mats = new Set<THREE.Material>();
  a.traverse((o: any) => { if (o.isMesh) mats.add(o.material); });
  for (const m of mats) assert.match(m.customProgramCacheKey(), /^[^|]*\|mecha-unit-light$/, "patched exactly once (no repeated suffix)");
  setMechaUnitLight(1);
  assert.equal(MECHA_UNIT_LIGHT.mechaFill.value, MECHA_NIGHT_FILL);
  setMechaUnitLight(3);
  assert.equal(MECHA_UNIT_LIGHT.mechaRim.value, MECHA_NIGHT_RIM, "clamped to full night");
  setMechaUnitLight(0);
  assert.equal(MECHA_UNIT_LIGHT.mechaRim.value, 0, "daytime adds nothing");
  disposeMechaModel(a); disposeMechaModel(b);
});
