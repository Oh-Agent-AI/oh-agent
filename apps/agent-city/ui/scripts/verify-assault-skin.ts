import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as THREE from "three";
import { measureAssaultStride } from "../src/render/mecha/assaultStride.ts";
import { createAssaultGaitPlan, sampleAssaultGait } from "../src/render/mecha/assaultGait.ts";
import { useConnectedAssault } from "../src/render/mecha/connectedAssaultMode.ts";
import { AssaultContactSampler, measureAssaultContacts } from "../src/render/mecha/assaultContact.ts";
import { AssaultFootGrounding } from "../src/render/mecha/assaultFootGrounding.ts";
import { AssaultGroundController } from "../src/render/mecha/assaultGroundController.ts";
import { assaultGroundOrientation } from "../src/render/mecha/assaultGround.ts";
import { AssaultPoseTransition, captureAssaultPose } from "../src/render/mecha/assaultPoseTransition.ts";
import { AssaultTurnIK } from "../src/render/mecha/assaultTurnIK.ts";
import { AssaultWalkIK } from "../src/render/mecha/assaultWalkIK.ts";
import { createConnectedAssaultPreviewPlayer, ASSAULT_STRIDE_MULTIPLIER, ASSAULT_WALK_IK_MAX_FACTOR, ASSAULT_WALK_CYCLE_SECONDS, ASSAULT_TRANSITION_SECONDS, assaultTurnDuration, fastAssaultStrideProfile } from "../src/render/mecha/connectedAssaultPreview.ts";
import { createAssault, createBoss, createGunner, createRaider, createSupport, disposeMechaModel, ensureMechaGlbAsset, getMechaGlbAsset, installMechaGlbProvider, upgradeMechaModelToGlb } from "../src/render/mecha/models.ts";
import { createMechaController } from "../src/game/mecha/controller.ts";
import { positionPerformanceActors } from "../src/game/mecha/positionPerformanceActors.ts";
import { poseMechaModel, setMechaRig } from "../src/render/mecha/animation.ts";
import { validateAssaultSkin } from "../src/render/mecha/assaultSkinContract.ts";
import { MechaGlbError, instantiateMechaGlb, parseMechaManifest } from "../src/render/mecha/glbModels.ts";
import { parseAssaultSkinGlb } from "../src/render/mecha/assaultSkinGlb.ts";
import { buildCityModel } from "../src/cityModel.ts";
import { layoutCity } from "../src/engine/cityLayout.ts";
import { MIAMI_COASTAL } from "../src/engine/citySeaside.ts";
import { terrainSurfaceHeight } from "../src/engine/surface/terrainSampling.ts";
import { compileGroundRoadSurface } from "../src/engine/surface/groundRoadCompiler.ts";
import { createAssaultCityGround } from "../src/game/assaultCityGround.ts";
import { anchorsFromCity, cellWorld, siteFightShapes } from "../src/game/mecha/citySite.ts";
import { sampleAssaultTerrainSafety } from "../src/game/mecha/assaultTerrainSafety.ts";
import { matchFromSite } from "../src/game/mecha/matchFromSite.ts";
import { bossPrepare, validateAndApplyPlan } from "../src/game/mecha/rules.ts";

function fixture() {
  const parents: Record<string, string | null> = {
    pelvis: null, chest: "pelvis", head: "chest",
    upper_armL: "chest", forearmL: "upper_armL", handL: "forearmL",
    upper_armR: "chest", forearmR: "upper_armR", handR: "forearmR",
    thighL: "pelvis", shinL: "thighL", footL: "shinL", toeL: "footL",
    thighR: "pelvis", shinR: "thighR", footR: "shinR", toeR: "footR",
  };
  const bones = new Map<string, THREE.Bone>();
  const scene = new THREE.Group();
  for (const [name, parent] of Object.entries(parents)) {
    const bone = new THREE.Bone(); bone.name = name; bones.set(name, bone);
    (parent ? bones.get(parent)! : scene).add(bone);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial()); mesh.name = "armor"; scene.add(mesh);
  mesh.bind(new THREE.Skeleton([...bones.values()]));
  const tracks: THREE.KeyframeTrack[] = [];
  for (const name of bones.keys()) {
    tracks.push(new THREE.VectorKeyframeTrack(`${name}.position`, [0, 1], [0, 0, 0, 0, 0, 0]));
    tracks.push(new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]));
    tracks.push(new THREE.VectorKeyframeTrack(`${name}.scale`, [0, 1], [1, 1, 1, 1, 1, 1]));
  }
  return { scene, bones, mesh, clips: [new THREE.AnimationClip("move", 1, tracks)] };
}
const check = (f: ReturnType<typeof fixture>) => validateAssaultSkin(f.scene, f.clips, { move: 1 });
const rejected = (f: ReturnType<typeof fixture>, pattern: RegExp) => assert.throws(() => check(f), (e: unknown) => e instanceof MechaGlbError && pattern.test(e.message));

test("connected Assault is the production and default development model", () => {
  assert.equal(useConnectedAssault(false, ""), true);
  assert.equal(useConnectedAssault(false, "?assaultTrial=1"), true);
  assert.equal(useConnectedAssault(true, ""), true);
  for (const key of ["assaultTrial", "assaultGaitPreview", "assaultLiftPreview"]) {
    assert.equal(useConnectedAssault(true, `?${key}=1`), false);
    assert.equal(useConnectedAssault(true, `?${key}=1&assaultConnectedPreview=1`), true);
  }
});

test("Assault skin validates bone hierarchy, rigid weights and complete clips", () => {
  check(fixture());
  const missing = fixture(); missing.bones.get("footL")!.name = "broken"; rejected(missing, /missing bone footL/);
  const parent = fixture(); parent.bones.get("pelvis")!.add(parent.bones.get("footL")!); rejected(parent, /bone footL has wrong parent/);
  const duplicate = fixture(); duplicate.scene.add(Object.assign(new THREE.Group(), { name: "shinL" })); rejected(duplicate, /duplicate node shinL/);
});

test("Assault skin rejects mixed vertices, cross-bone faces and incompatible skeletons", () => {
  const supported = fixture(); const foot = [...supported.bones.keys()].indexOf("footL"), toe = [...supported.bones.keys()].indexOf("toeL");
  const joints = supported.mesh.geometry.getAttribute("skinIndex"), weights = supported.mesh.geometry.getAttribute("skinWeight");
  for (let i = 0; i < 3; i++) { joints.setXY(i, foot, toe); weights.setXY(i, .5, .5); }
  check(supported);
  const mixed = fixture(); mixed.mesh.geometry.getAttribute("skinIndex").setY(0, 1); mixed.mesh.geometry.getAttribute("skinWeight").setXY(0, .5, .5); rejected(mixed, /unsupported or unnormalised/);
  const triangle = fixture(); triangle.mesh.geometry.getAttribute("skinIndex").setX(1, 1); rejected(triangle, /cross-bone/);
  const index = fixture(); index.mesh.geometry.getAttribute("skinIndex").setX(1, 999); rejected(index, /invalid weight or bone index/);
  const other = fixture(); const mesh = new THREE.SkinnedMesh(other.mesh.geometry, other.mesh.material); mesh.name = "other"; other.scene.add(mesh); mesh.bind(new THREE.Skeleton([new THREE.Bone()])); rejected(other, /different skeleton/);
});

test("Assault skin rejects missing, duplicate, mismatched and malformed motion tracks", () => {
  const missing = fixture(); missing.clips[0]!.tracks.pop(); rejected(missing, /missing track toeR.scale/);
  const duplicate = fixture(); duplicate.clips[0]!.tracks.push(duplicate.clips[0]!.tracks[0]!); rejected(duplicate, /duplicate track/);
  const duration = fixture(); duration.clips[0]!.duration = 2; rejected(duration, /duration mismatch/);
  const constant = fixture(); constant.clips[0]!.tracks[0] = new THREE.VectorKeyframeTrack("pelvis.position", [0], [0, 0, 0]); check(constant);
  const values = fixture(); values.clips[0]!.tracks[0]!.values[0] = NaN; rejected(values, /invalid track/);
  const malformed = fixture(); malformed.clips[0]!.tracks[0]!.values = new Float32Array([0, 0, 0]); rejected(malformed, /invalid track/);
  const late = fixture(); late.clips[0]!.tracks[0]!.times[0] = .1; rejected(late, /invalid track/);
  const clips = fixture(); clips.clips.push(clips.clips[0]!); rejected(clips, /missing or duplicated/);
  const root = fixture(); root.clips[0]!.tracks.push(new THREE.VectorKeyframeTrack("armor.position", [0, 1], [0, 0, 0, 0, 0, 0])); rejected(root, /unexpected track armor.position/);
});

test("the skin loader rejects bad declarations and invalid binary data", async () => {
  const clip = (loop: boolean) => ({ duration: 1, loop });
  const manifest = parseMechaManifest({ id: "candidate", version: 1, role: "Assault", footprint: [1, 1], forward: "-Z", heightMeters: 10, maxExtentMeters: [15, 15], clips: { idle: clip(true), move: clip(true), attack: clip(false), hit: clip(false), defeat: clip(false), turn_left: clip(false), turn_right: clip(false) }, actionMap: { repair: "attack" } });
  const data = new ArrayBuffer(16);
  await assert.rejects(parseAssaultSkinGlb(data, manifest, { scale: NaN, sourceForward: "+Z" }), /invalid Assault skin manifest/);
  await assert.rejects(parseAssaultSkinGlb(data, { ...manifest, role: "Gunner" }, { scale: 1, sourceForward: "+Z" }), /invalid Assault skin manifest/);
  await assert.rejects(parseAssaultSkinGlb(data, { ...manifest, clips: { ...manifest.clips, move: clip(false) } }, { scale: 1, sourceForward: "+Z" }), /invalid Assault skin clip move/);
  await assert.rejects(parseAssaultSkinGlb(data, { ...manifest, clips: { ...manifest.clips, turn_left: undefined! } }, { scale: 1, sourceForward: "+Z" }), /all seven clips/);
  await assert.rejects(parseAssaultSkinGlb(data, manifest, { scale: 1, sourceForward: "+Z" }), /cannot parse Assault skin GLB/);
});

test("candidate manifest matches the packaged GLB and its embedded materials", () => {
  const bytes = readFileSync(new URL("../src/assets/mecha/assault-connected-candidate.glb", import.meta.url));
  const manifest = JSON.parse(readFileSync(new URL("../src/assets/mecha/assault-connected-candidate.manifest.json", import.meta.url), "utf8"));
  const json = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString("utf8"));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), manifest.source.glb_sha256);
  assert.deepEqual(json.materials.map((material: { name: string }) => material.name), manifest.materials);
  assert.ok(json.images.length > 0);
  for (const image of json.images) {
    assert.equal(image.mimeType, "image/webp");
    assert.ok(Number.isInteger(image.bufferView) && json.bufferViews[image.bufferView]);
    assert.equal(image.uri, undefined);
  }
});

test("candidate stride sampling uses an isolated skeleton and follows the stance direction", async () => {
  const bytes = readFileSync(new URL("../src/assets/mecha/assault-connected-candidate.glb", import.meta.url));
  const length = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + length).toString("utf8"));
  for (const material of json.materials ?? []) {
    const pbr = material.pbrMetallicRoughness ?? {};
    delete pbr.baseColorTexture; delete pbr.metallicRoughnessTexture; delete material.emissiveTexture;
  }
  delete json.textures; delete json.images; delete json.samplers;
  let text = Buffer.from(JSON.stringify(json), "utf8");
  text = Buffer.concat([text, Buffer.alloc((4 - text.length % 4) % 4, 0x20)]);
  const rest = bytes.subarray(20 + length), header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(20 + text.length + rest.length, 8);
  header.writeUInt32LE(text.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  const binary = Buffer.concat([header, text, rest]);
  const manifest = parseMechaManifest(JSON.parse(readFileSync(new URL("../src/assets/mecha/assault-connected-candidate.manifest.json", import.meta.url), "utf8")));
  const asset = await parseAssaultSkinGlb(binary.buffer.slice(binary.byteOffset, binary.byteOffset + binary.byteLength), manifest, { scale: 21.245691361301702, sourceForward: "+Z" });
  const instance = instantiateMechaGlb(asset, 2), root = new THREE.Group();
  root.add(instance.wrapper); setMechaRig(root, instance.rig);
  poseMechaModel(root, "attack", 0.45);
  root.position.set(4, 1, -2); root.rotation.y = 0.37; root.updateMatrixWorld(true);
  const hand = root.getObjectByName("handR")!, before = hand.matrixWorld.clone();
  try {
    const reference = instantiateMechaGlb(asset, 2), referenceRoot = new THREE.Group();
    referenceRoot.add(reference.wrapper); setMechaRig(referenceRoot, reference.rig);
    try {
      const bones: THREE.Bone[] = [], referenceBones: THREE.Bone[] = [];
      root.traverse((object) => { if ((object as THREE.Bone).isBone) bones.push(object as THREE.Bone); });
      referenceRoot.traverse((object) => { if ((object as THREE.Bone).isBone) referenceBones.push(object as THREE.Bone); });
      for (const [action, time] of [["idle", 0], ["idle", 0], ["move", .3], ["move", .3], ["attack", .45], ["hit", .2], ["idle", 0], ["defeat", .5], ["idle", 0]] as const) {
        poseMechaModel(root, action, time); poseMechaModel(referenceRoot, action, time);
        bones.forEach((bone, i) => {
          const expected = referenceBones[i]!;
          assert.ok(bone.position.distanceTo(expected.position) < 1e-9, `${action}: ${bone.name} position`);
          assert.ok(bone.quaternion.toArray().every((value, j) => Math.abs(value - expected.quaternion.toArray()[j]!) < 1e-9), `${action}: ${bone.name} quaternion`);
          assert.ok(bone.scale.distanceTo(expected.scale) < 1e-9, `${action}: ${bone.name} scale`);
          bone.position.x += .1; bone.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), .3)); bone.scale.x += .1;
        });
      }
    } finally { reference.dispose(); }
    poseMechaModel(root, "attack", .45); root.updateMatrixWorld(true);
    const measured = measureAssaultStride(asset);
    assert.ok(measured.stride > 0.01 && measured.stride < 10, `stride ${measured.stride}`);
    assert.equal(measureAssaultStride(asset), measured);
    const samples = measureAssaultContacts(asset), contact = new AssaultContactSampler(root, asset);
    assert.equal(measureAssaultContacts(asset), samples);
    assert.ok(samples.reduce((sum, pair) => sum + pair[0].length + pair[1].length, 0) < 1000);
    root.updateMatrixWorld(true);
    assert.deepEqual(hand.matrixWorld.elements, before.elements);
    root.position.set(0, 0, 0); root.rotation.y = 0;
    const meshes: THREE.SkinnedMesh[] = [];
    root.traverse((object) => { if ((object as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(object as THREE.SkinnedMesh); });
    root.scale.setScalar(2);
    for (const slope of [0, .1, .3, .5]) for (const yaw of [0, Math.PI / 2]) {
      const height = (x: number) => slope * x;
      for (let i = 0; i <= 20; i++) {
        root.quaternion.copy(assaultGroundOrientation(0, 0, yaw, height, 2, .5));
        poseMechaModel(root, "defeat", i / 20 * manifest.clips.defeat!.duration);
        root.updateMatrixWorld(true);
        let clearance = Infinity;
        for (const mesh of meshes) {
          const point = new THREE.Vector3();
          for (let vertex = 0; vertex < mesh.geometry.getAttribute("position").count; vertex++) {
            mesh.getVertexPosition(vertex, point); mesh.localToWorld(point);
            clearance = Math.min(clearance, point.y - height(point.x));
          }
        }
        assert.ok(clearance >= -.001 && clearance < .03, `defeat clearance ${clearance} at ${i / 20}, slope ${slope}, yaw ${yaw}`);
      }
    }
    root.scale.setScalar(1); root.rotation.set(0, 0, 0);
    for (const phase of [0, .125, .25, .375, .5, .625, .75, .875]) {
      poseMechaModel(root, "move", phase * manifest.clips.move!.duration);
      root.updateMatrixWorld(true);
      for (const side of [0, 1] as const) for (const height of [() => 0, (x: number, z: number) => .03 * x - .02 * z]) {
        let minimum = Infinity;
        for (const mesh of meshes) {
          const index = mesh.geometry.getAttribute("skinIndex"), weight = mesh.geometry.getAttribute("skinWeight"), point = new THREE.Vector3();
          for (let i = 0; i < index.count; i++) {
            let foot = false;
            for (let j = 0; j < 4; j++) {
              const name = mesh.skeleton.bones[index.getComponent(i, j)]?.name;
              if (weight.getComponent(i, j) > 1e-6 && (name === `foot${side ? "R" : "L"}` || name === `toe${side ? "R" : "L"}`)) foot = true;
            }
            if (!foot) continue;
            mesh.getVertexPosition(i, point); mesh.localToWorld(point);
            minimum = Math.min(minimum, point.y - height(point.x, point.z));
          }
        }
        const sampled = contact.clearance(side, height);
        assert.ok(sampled >= minimum - 1e-7 && sampled - minimum < .02, `sample error ${sampled - minimum} at ${phase}, side ${side}`);
      }
    }
    assert.throws(() => contact.clearance(0, () => NaN), /height/);
    const grounding = new AssaultFootGrounding(root, asset);
    root.scale.setScalar(2);
    const legs = (["L", "R"] as const).map((side) => ["thigh", "shin", "foot"].map((name) => root.getObjectByName(`${name}${side}`)!));
    const position = (object: THREE.Object3D) => object.getWorldPosition(new THREE.Vector3());
    for (const phase of [.125, .25, .375, .625, .75, .875]) for (const height of [() => .02, (x: number, z: number) => .02 + .01 * x - .01 * z]) {
      poseMechaModel(root, "move", phase * manifest.clips.move!.duration);
      root.updateMatrixWorld(true);
      const before = legs.map(([thigh, shin, foot]) => ({
        upper: position(thigh!).distanceTo(position(shin!)), lower: position(shin!).distanceTo(position(foot!)),
        rotation: foot!.getWorldQuaternion(new THREE.Quaternion()),
      }));
      grounding.sample(phase, height, .3);
      for (const side of [0, 1] as const) {
        const [thigh, shin, foot] = legs[side]!, previous = before[side]!;
        assert.ok(Math.abs(position(thigh!).distanceTo(position(shin!)) - previous.upper) < 1e-5);
        assert.ok(Math.abs(position(shin!).distanceTo(position(foot!)) - previous.lower) < 1e-5);
        assert.ok(Math.abs(foot!.getWorldQuaternion(new THREE.Quaternion()).dot(previous.rotation)) > 1 - 1e-8);
        assert.ok(contact.clearance(side, height) >= -1e-4, `ground penetration at ${phase}, side ${side}`);
      }
    }
    poseMechaModel(root, "move", .25 * manifest.clips.move!.duration);
    root.updateMatrixWorld(true);
    const saved = legs.flat().map((bone) => bone.quaternion.clone());
    const leftCount = samples.reduce((sum, pair) => sum + pair[0].length, 0);
    let calls = 0, leftWasChanged = false;
    assert.throws(() => grounding.sample(.25, () => {
      if (++calls <= leftCount * 3) return .02;
      leftWasChanged = legs[0]!.some((bone, i) => Math.abs(bone.quaternion.dot(saved[i]!)) < 1 - 1e-10);
      return NaN;
    }, .3), /height/);
    assert.ok(leftWasChanged, "the first leg must be corrected before the second leg fails");
    legs.flat().forEach((bone, i) => assert.ok(Math.abs(bone.quaternion.dot(saved[i]!)) > 1 - 1e-12));
    assert.throws(() => grounding.sample(.25, () => 100, .3), /unreachable ankle/);
    legs.flat().forEach((bone, i) => assert.ok(Math.abs(bone.quaternion.dot(saved[i]!)) > 1 - 1e-12));
    assert.throws(() => grounding.sample(1, () => 0, .3), /parameters/);
    root.scale.setScalar(1);
    for (const [name, start, end] of [["toeL", .125, .5], ["toeR", .5625, .875]] as const) {
      const foot = root.getObjectByName(name)!;
      let reference: THREE.Vector3 | undefined;
      for (let i = 0; i <= 60; i++) {
        const phase = start + (end - start) * i / 60;
        poseMechaModel(root, "move", phase * manifest.clips.move!.duration);
        root.position.z = -measured.stride * measured.profile(phase);
        root.updateMatrixWorld(true);
        const p = foot.getWorldPosition(new THREE.Vector3());
        reference ??= p;
        assert.ok(Math.abs(p.z - reference.z) < .05, `${name} longitudinal support drift at ${phase}: ${p.z - reference.z}`);
      }
    }
    // Exercise the actual retargeting at the full range of quantized step sizes.
    const walkIK = new AssaultWalkIK(root, measured.toeStartZ);
    for (const factor of [.01, .25, .5, 1, 1.5, 2, 2.5, ASSAULT_WALK_IK_MAX_FACTOR]) {
      for (let i = 0; i < 400; i++) {
        poseMechaModel(root, "move", i / 400 * manifest.clips.move!.duration);
        root.position.set(0, 0, 0); root.updateMatrixWorld(true);
        const bones = ["L", "R"].map((side) => ["thigh", "shin", "foot", "toe"].map((name) => root.getObjectByName(`${name}${side}`)!));
        const position = (node: THREE.Object3D) => node.getWorldPosition(new THREE.Vector3());
        const before = bones.map(([thigh, shin, foot, toe]) => ({
          upper: position(thigh!).distanceTo(position(shin!)), lower: position(shin!).distanceTo(position(foot!)),
          toe: position(toe!), rotation: foot!.getWorldQuaternion(new THREE.Quaternion()),
        }));
        walkIK.sample(factor);
        bones.forEach(([thigh, shin, foot, toe], side) => {
          const original = before[side]!;
          assert.ok(Math.abs(position(thigh!).distanceTo(position(shin!)) - original.upper) < 1e-6);
          assert.ok(Math.abs(position(shin!).distanceTo(position(foot!)) - original.lower) < 1e-6);
          assert.ok(foot!.getWorldQuaternion(new THREE.Quaternion()).angleTo(original.rotation) < 1e-6);
          const expected = measured.toeStartZ[side]! + (original.toe.z - measured.toeStartZ[side]!) * factor;
          assert.ok(Math.abs(position(toe!).z - expected) < 1e-6, `retargeted toe ${side} phase ${i / 400}`);
        });
      }
    }
    const fastProfile = fastAssaultStrideProfile(measured.profile);
    assert.equal(fastProfile(0), 0); assert.equal(fastProfile(1), 1);
    for (let i = 1; i <= 100; i++) assert.ok(fastProfile(i / 100) > fastProfile((i - 1) / 100), "fast movement keeps advancing between steps");
    for (const [name, start, end] of [["toeL", .125, .5], ["toeR", .5625, .875]] as const) {
      const foot = root.getObjectByName(name)!;
      const actualStride = 14.4 / Math.ceil(14.4 / (measured.stride * 2 * ASSAULT_STRIDE_MULTIPLIER));
      const factor = Math.min(ASSAULT_WALK_IK_MAX_FACTOR, actualStride / (measured.stride * 2));
      root.scale.setScalar(2);
      let reference: THREE.Vector3 | undefined;
      for (let i = 0; i <= 60; i++) {
        const phase = start + (end - start) * i / 60;
        poseMechaModel(root, "move", phase * manifest.clips.move!.duration);
        root.position.set(0, 0, -actualStride * fastProfile(phase));
        walkIK.sample(factor);
        const p = foot.getWorldPosition(new THREE.Vector3());
        reference ??= p;
        const expectedSlip = -actualStride * (fastProfile(phase) - fastProfile(start)) + measured.stride * 2 * factor * (measured.profile(phase) - measured.profile(start));
        assert.ok(Math.abs(p.z - reference.z - expectedSlip) < .05 * factor * 2 + 1e-6, `${name} unexpected support drift at ${phase}`);
        if (i === 60) assert.ok(Math.abs(p.z - reference.z) > .1, `${name} should permit controlled slip for faster movement`);
      }
    }
    const oneCell = createAssaultGaitPlan([{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -14.4 }], 0,
      measured.stride * 2 * ASSAULT_STRIDE_MULTIPLIER, ASSAULT_WALK_CYCLE_SECONDS, assaultTurnDuration, ASSAULT_TRANSITION_SECONDS);
    const walking = oneCell.stages.find((stage) => stage.kind === "walk");
    assert.ok(walking && walking.kind === "walk");
    assert.equal(walking.cycles, 2, "one City cell should take two gait cycles");
    assert.ok(walking.duration <= 1, `one-cell walking takes ${walking.duration}s`);
    assert.ok(oneCell.duration < 1.7, `one-cell movement takes ${oneCell.duration}s`);
    const withTurn = createAssaultGaitPlan([{ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -14.4 }], Math.PI / 2,
      measured.stride * 2 * ASSAULT_STRIDE_MULTIPLIER, ASSAULT_WALK_CYCLE_SECONDS, assaultTurnDuration, ASSAULT_TRANSITION_SECONDS);
    assert.ok(withTurn.duration < 3.4, `one-cell movement with a 90-degree turn takes ${withTurn.duration}s`);
  } finally { instance.dispose(); }

  const actor = createAssault(), effects = new THREE.Group(), boss = new THREE.Group();
  assert.equal(upgradeMechaModelToGlb(actor, asset), true);
  assert.equal(getMechaGlbAsset(actor), asset);
  actor.scale.setScalar(2); actor.rotation.y = .37;
  const events = [
    { kind: "move" as const, actor: "Assault", path: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], duration: .48 },
    { kind: "attack" as const, actor: "Assault", attack: "melee" as const, from: { x: 1, y: 1 }, target: { x: 2, y: 1 }, targetIds: ["boss"], duration: .62 },
    { kind: "death" as const, actor: "Assault", at: { x: 1, y: 1 }, duration: .85 },
  ];
  const cell = (c: { x: number; y: number }) => new THREE.Vector3(c.x * 8, 0, c.y * 8);
  let completed = 0, minimum = Infinity;
  const preview = createConnectedAssaultPreviewPlayer({ Assault: actor, boss }, events, cell, effects, () => completed++);
  try {
    preview.player.update(.2);
    assert.ok(Math.abs(actor.rotation.y - .37) < 1e-7, "candidate turn keeps the root heading while its legs turn");
    const paused = actor.position.clone(), knee = actor.getObjectByName("shinL")!.getWorldPosition(new THREE.Vector3());
    preview.player.update(0);
    assert.deepEqual(actor.position, paused);
    assert.ok(knee.distanceTo(actor.getObjectByName("shinL")!.getWorldPosition(new THREE.Vector3())) < 1e-7);
    for (let i = 0; i < 2000 && !completed; i++) {
      preview.player.update(1 / 60);
      actor.updateMatrixWorld(true);
      minimum = Math.min(minimum, new THREE.Box3().setFromObject(actor, true).min.y);
    }
    assert.equal(completed, 1);
    assert.ok(minimum >= -.001, `flat playback penetrates by ${-minimum}`);
    assert.deepEqual(actor.position.toArray(), [8, 0, 8]);
    preview.player.update(Infinity);
    assert.equal(completed, 1);
  } finally { preview.player.dispose(); preview.release(); disposeMechaModel(actor); }
  assert.equal(getMechaGlbAsset(actor), undefined);
  assert.equal(effects.children.length, 0);

  const plannedAssault = createAssault(), plannedGunner = createGunner(), plannedBoss = new THREE.Group(), plannedEffects = new THREE.Group();
  assert.equal(upgradeMechaModelToGlb(plannedAssault, asset), true);
  plannedAssault.scale.setScalar(2);
  plannedAssault.position.set(8, 0, 0);
  const plannedActors = { Assault: plannedAssault, Gunner: plannedGunner, boss: plannedBoss };
  positionPerformanceActors(plannedActors, {
    figures: [{ id: "Assault", x: 0, y: 0 }, { id: "Gunner", x: 0, y: 1 }],
    boss: { x: 2, y: 1 }, raiders: [],
  }, cell);
  const delayedEvents = [
    { kind: "move" as const, actor: "Gunner", path: [{ x: 0, y: 1 }, { x: 1, y: 1 }], duration: .5 },
    { kind: "move" as const, actor: "Assault", path: [{ x: 0, y: 0 }, { x: 1, y: 0 }], duration: .5 },
  ];
  let delayedDone = 0, assaultMoved = false;
  const delayedPlayback = createConnectedAssaultPreviewPlayer(plannedActors, delayedEvents, cell, plannedEffects, () => delayedDone++, { height: () => 0, terrain: () => 0, radius: 2, maxGrade: .5, maxDrop: .3 });
  try {
    delayedPlayback.player.update(.25);
    assert.deepEqual([plannedAssault.position.x, plannedAssault.position.z], [0, 0], "Assault waits at the committed start while Gunner moves");
    const waitingContact = new AssaultContactSampler(plannedAssault, asset);
    for (const side of [0, 1] as const) assert.ok(Math.abs(waitingContact.clearance(side, () => 0)) < 1e-4, `waiting foot ${side} is grounded`);
    assert.ok(plannedGunner.position.x > 0 && plannedGunner.position.x < 8);
    for (let i = 0; i < 2000 && !delayedDone; i++) {
      delayedPlayback.player.update(1 / 60);
      if (plannedAssault.position.x > 0 && plannedAssault.position.x < 8) assaultMoved = true;
    }
    assert.equal(delayedDone, 1);
    assert.ok(assaultMoved, "Assault follows its route after Gunner");
    assert.deepEqual([plannedAssault.position.x, plannedAssault.position.z], [8, 0]);
    for (const side of [0, 1] as const) assert.ok(Math.abs(waitingContact.clearance(side, () => 0)) < 1e-4, `settled foot ${side} is grounded`);
  } finally { delayedPlayback.player.dispose(); delayedPlayback.release(); disposeMechaModel(plannedAssault); disposeMechaModel(plannedGunner); }
  assert.equal(plannedEffects.children.length, 0);

  const standingActor = createAssault();
  assert.equal(upgradeMechaModelToGlb(standingActor, asset), true);
  standingActor.scale.setScalar(2);
  const basin = (x: number, z: number) => -.15 * (1 - Math.exp(-(x * x + z * z) / 2));
  const standingGround = new AssaultGroundController(standingActor, { asset, height: basin, terrain: () => 0, radius: 2, maxGrade: .5, maxDrop: .3 });
  const standingContact = new AssaultContactSampler(standingActor, asset);
  const standingBones = ["thighL", "shinL", "footL", "thighR", "shinR", "footR"].map((name) => standingActor.getObjectByName(name)!);
  const world = (bone: THREE.Object3D) => bone.getWorldPosition(new THREE.Vector3());
  try {
    for (let i = 0; i < 180; i++) {
      poseMechaModel(standingActor, "idle", i / 60); standingGround.align(.4); standingActor.updateMatrixWorld(true);
      const lengths = [world(standingBones[0]!).distanceTo(world(standingBones[1]!)), world(standingBones[1]!).distanceTo(world(standingBones[2]!)), world(standingBones[3]!).distanceTo(world(standingBones[4]!)), world(standingBones[4]!).distanceTo(world(standingBones[5]!))];
      standingGround.stand();
      const gap = Math.min(standingContact.clearance(0, basin), standingContact.clearance(1, basin));
      assert.ok(gap >= -1e-4 && gap < 1e-4, `standing clearance ${gap} at frame ${i}`);
      for (const side of [0, 1] as const) {
        const j = side * 3;
        const upperAfter = world(standingBones[j]!).distanceTo(world(standingBones[j + 1]!));
        assert.ok(Math.abs(upperAfter - lengths[side * 2]!) < 1e-5, `frame=${i} side=${side} upper before=${lengths[side * 2]} after=${upperAfter} quaternion lengths=${standingBones.map((bone) => bone.quaternion.length()).join(",")}`);
        assert.ok(Math.abs(world(standingBones[j + 1]!).distanceTo(world(standingBones[j + 2]!)) - lengths[side * 2 + 1]!) < 1e-5);
      }
    }
    poseMechaModel(standingActor, "idle", 0); standingGround.align(.4);
    standingActor.position.y += .5; standingActor.updateMatrixWorld(true);
    const lengths = [world(standingBones[0]!).distanceTo(world(standingBones[1]!)), world(standingBones[1]!).distanceTo(world(standingBones[2]!)), world(standingBones[3]!).distanceTo(world(standingBones[4]!)), world(standingBones[4]!).distanceTo(world(standingBones[5]!))];
    const rotations = [standingBones[2]!, standingBones[5]!].map((bone) => bone.getWorldQuaternion(new THREE.Quaternion()));
    standingGround.support();
    const gap = Math.min(standingContact.clearance(0, basin), standingContact.clearance(1, basin));
    assert.ok(gap >= -1e-5 && gap < 1e-5, `support clearance ${gap}`);
    for (const side of [0, 1] as const) {
      const j = side * 3;
      assert.ok(Math.abs(world(standingBones[j]!).distanceTo(world(standingBones[j + 1]!)) - lengths[side * 2]!) < 1e-5);
      assert.ok(Math.abs(world(standingBones[j + 1]!).distanceTo(world(standingBones[j + 2]!)) - lengths[side * 2 + 1]!) < 1e-5);
      const before = rotations[side]!.clone().normalize(), after = standingBones[j + 2]!.getWorldQuaternion(new THREE.Quaternion()).normalize();
      assert.ok(after.angleTo(before) < 1e-5, `support foot angle ${after.angleTo(before)}`);
    }
    standingActor.position.y += .5; standingActor.updateMatrixWorld(true);
    const beforeY = standingActor.position.y, beforeBones = standingBones.map((bone) => bone.quaternion.clone());
    const internal = standingGround as unknown as { grounding: { sample: (...args: unknown[]) => unknown } };
    const sample = internal.grounding.sample;
    internal.grounding.sample = () => { standingBones[0]!.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), .5); throw new Error("forced support failure"); };
    try { assert.throws(() => standingGround.support(), /forced support failure/); }
    finally { internal.grounding.sample = sample; }
    assert.equal(standingActor.position.y, beforeY);
    standingBones.forEach((bone, i) => assert.deepEqual(bone.quaternion.toArray(), beforeBones[i]!.toArray()));
  } finally { disposeMechaModel(standingActor); }

  const slopeActor = createAssault(), slopeEffects = new THREE.Group(), slopeBoss = new THREE.Group();
  assert.equal(upgradeMechaModelToGlb(slopeActor, asset), true);
  slopeActor.scale.setScalar(2); slopeActor.rotation.y = .37;
  const height = (x: number, z: number) => .015 * x - .01 * z;
  const slopeCell = (c: { x: number; y: number }) => new THREE.Vector3(c.x * 8, height(c.x * 8, c.y * 8), c.y * 8);
  const slopeContact = new AssaultContactSampler(slopeActor, asset);
  let slopeDone = 0, slopeMinimum = Infinity, sawMove = false, sawAttack = false;
  const slopePreview = createConnectedAssaultPreviewPlayer({ Assault: slopeActor, boss: slopeBoss }, events.slice(0, 2), slopeCell, slopeEffects, () => slopeDone++, { height, terrain: height, radius: 2, maxGrade: .5, maxDrop: .3 });
  try {
    for (let i = 0; i < 2000 && !slopeDone; i++) {
      slopePreview.player.update(1 / 60);
      slopeActor.updateMatrixWorld(true);
      if (slopeActor.position.x > 0 && slopeActor.position.x < 8) sawMove = true;
      if (slopeActor.position.x > 8.01) sawAttack = true;
      for (const side of [0, 1] as const) slopeMinimum = Math.min(slopeMinimum, slopeContact.clearance(side, height));
    }
    assert.equal(slopeDone, 1); assert.ok(sawMove && sawAttack);
    assert.ok(slopeMinimum >= -1e-4, `slope playback foot penetration ${slopeMinimum}`);
    for (const side of [0, 1] as const) assert.ok(Math.abs(slopeContact.clearance(side, height)) < 1e-4, `settled slope foot ${side}`);
    const completedPosition = slopeActor.position.clone();
    slopePreview.player.update(0);
    assert.ok(slopeActor.position.distanceTo(completedPosition) < 1e-8, "paused settled pose remains stable");
    const idleGround = new AssaultGroundController(slopeActor, { asset, height, terrain: height, radius: 2, maxGrade: .5, maxDrop: .3 });
    for (const yaw of [-2.4, -.4, 0, .4, 2.4]) {
      idleGround.align(yaw);
      assert.ok(Math.abs(Math.atan2(Math.sin(idleGround.heading() - yaw), Math.cos(idleGround.heading() - yaw))) < 1e-10, `slope heading ${yaw}`);
    }
    slopePreview.player.dispose();
    for (let i = 0; i < 30; i++) {
      slopeActor.position.lerp(slopeCell({ x: 1, y: 1 }), .22);
      poseMechaModel(slopeActor, "idle", i / 60);
      slopeActor.rotation.set(0, .4, 0);
      idleGround.align(.4);
      idleGround.stand();
      assert.ok(Math.hypot(slopeActor.position.x - completedPosition.x, slopeActor.position.z - completedPosition.z) < 1e-8, "handoff must keep the completed cell");
      for (const side of [0, 1] as const) assert.ok(Math.abs(slopeContact.clearance(side, height)) < 1e-4, "idle foot must stay grounded");
    }
  } finally { slopePreview.player.dispose(); slopePreview.release(); disposeMechaModel(slopeActor); }
  assert.equal(slopeEffects.children.length, 0);

  for (const grade of [0, .25, .4, .49, .65, .89]) for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    const actor = createAssault(), effects = new THREE.Group();
    assert.equal(upgradeMechaModelToGlb(actor, asset), true);
    actor.scale.setScalar(2);
    const height = (x: number) => grade * x;
    const cell = (c: { x: number; y: number }) => new THREE.Vector3(c.x * 8, height(c.x * 8), c.y * 8);
    const contact = new AssaultContactSampler(actor, asset);
    const leg = ["thighL", "shinL", "footL", "thighR", "shinR", "footR"].map((name) => actor.getObjectByName(name)!);
    const position = (bone: THREE.Object3D) => bone.getWorldPosition(new THREE.Vector3());
    let done = 0, minimum = Infinity, lengthError = 0;
    const lift = [0, 0], fullLift = [0, 0];
    const feet: { mesh: THREE.SkinnedMesh; indices: number[][] }[] = [];
    if (grade === 0) actor.traverse((object) => {
      const mesh = object as THREE.SkinnedMesh;
      if (!mesh.isSkinnedMesh) return;
      const skinIndex = mesh.geometry.getAttribute("skinIndex"), weight = mesh.geometry.getAttribute("skinWeight"), indices: number[][] = [[], []];
      for (let vertex = 0; vertex < skinIndex.count; vertex++) for (let joint = 0; joint < 4; joint++) {
        if (weight.getComponent(vertex, joint) <= 1e-6) continue;
        const name = mesh.skeleton.bones[skinIndex.getComponent(vertex, joint)]?.name;
        const side = name === "footL" || name === "toeL" ? 0 : name === "footR" || name === "toeR" ? 1 : -1;
        if (side >= 0) { indices[side]!.push(vertex); break; }
      }
      feet.push({ mesh, indices });
    });
    const move = [{ kind: "move" as const, actor: "Assault", path: [{ x: 0, y: 0 }, { x: dx!, y: dy! }], duration: .48 }];
    const preview = createConnectedAssaultPreviewPlayer({ Assault: actor }, move, cell, effects, () => done++, { height, terrain: height, radius: 2, maxGrade: .9, maxDrop: .3 });
    try {
      actor.updateMatrixWorld(true);
      const lengths = [position(leg[0]!).distanceTo(position(leg[1]!)), position(leg[1]!).distanceTo(position(leg[2]!)), position(leg[3]!).distanceTo(position(leg[4]!)), position(leg[4]!).distanceTo(position(leg[5]!))];
      for (let i = 0; i < 1500 && !done; i++) {
        preview.player.update(1 / 60);
        actor.updateMatrixWorld(true);
        for (const side of [0, 1] as const) {
          const clearance = contact.clearance(side, height);
          minimum = Math.min(minimum, clearance);
          if (Math.hypot(actor.position.x, actor.position.z) > .05 && Math.hypot(actor.position.x - dx! * 8, actor.position.z - dy! * 8) > .05) {
            lift[side] = Math.max(lift[side]!, clearance);
            if (grade === 0 && clearance > .05 && fullLift[side]! <= .05) {
              let fullClearance = Infinity;
              for (const { mesh, indices } of feet) {
                const point = new THREE.Vector3();
                for (const vertex of indices[side]!) {
                  mesh.getVertexPosition(vertex, point); mesh.localToWorld(point);
                  fullClearance = Math.min(fullClearance, point.y - height(point.x));
                }
              }
              fullLift[side] = Math.max(fullLift[side]!, fullClearance);
            }
          }
          const j = side * 3;
          lengthError = Math.max(lengthError, Math.abs(position(leg[j]!).distanceTo(position(leg[j + 1]!)) - lengths[side * 2]!), Math.abs(position(leg[j + 1]!).distanceTo(position(leg[j + 2]!)) - lengths[side * 2 + 1]!));
        }
      }
      assert.equal(done, 1, `grade ${grade}, direction ${dx},${dy}`);
      if (grade === 0) for (const side of [0, 1] as const) {
        assert.ok(lift[side]! > .05, `foot ${side} did not lift during movement ${dx},${dy}: ${lift[side]}`);
        assert.ok(fullLift[side]! > .05, `full foot ${side} did not lift during movement ${dx},${dy}: ${fullLift[side]}`);
      }
      assert.ok(minimum >= -1e-4, `grade ${grade}, direction ${dx},${dy}, clearance ${minimum}`);
      assert.ok(lengthError < .002, `grade ${grade}, direction ${dx},${dy}, leg error ${lengthError}`);
    } finally { preview.player.dispose(); preview.release(); disposeMechaModel(actor); }
  }

  for (const grade of [.65, .89]) for (const direction of [-1, 1]) {
    const actor = createAssault(), effects = new THREE.Group();
    assert.equal(upgradeMechaModelToGlb(actor, asset), true);
    actor.scale.setScalar(2);
    const height = (x: number) => grade * x;
    const cell = (c: { x: number; y: number }) => new THREE.Vector3(c.x * 8, height(c.x * 8), c.y * 8);
    let done = 0;
    const move = [{ kind: "move" as const, actor: "Assault", path: [{ x: 0, y: 0 }, { x: direction, y: 0 }], duration: .48 }];
    const preview = createConnectedAssaultPreviewPlayer({ Assault: actor }, move, cell, effects, () => done++, { height, terrain: height, radius: 2, maxGrade: .9, maxDrop: .3 });
    const meshes: THREE.SkinnedMesh[] = [];
    actor.traverse((object) => { if ((object as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(object as THREE.SkinnedMesh); });
    try {
      for (let i = 0; i < 1500 && !done; i++) {
        preview.player.update(1 / 60);
        if (i % 10 !== 0) continue;
        actor.updateMatrixWorld(true);
        for (const mesh of meshes) {
          const point = new THREE.Vector3();
          for (let vertex = 0; vertex < mesh.geometry.attributes.position.count; vertex++) {
            mesh.getVertexPosition(vertex, point); mesh.localToWorld(point);
            assert.ok(point.y - height(point.x) >= -.02, `grade ${grade}, direction ${direction}, vertex clearance ${point.y - height(point.x)}`);
          }
        }
      }
      assert.equal(done, 1);
    } finally { preview.player.dispose(); preview.release(); disposeMechaModel(actor); }
  }

  const knockedActor = createAssault(), knockedEffects = new THREE.Group();
  assert.equal(upgradeMechaModelToGlb(knockedActor, asset), true);
  knockedActor.scale.setScalar(2);
  // Knockback preserves the unit's existing heading; it is a passive slide.
  const initialKnockbackYaw = .61;
  knockedActor.rotation.y = initialKnockbackYaw;
  const knockback = [{ kind: "knockback" as const, actor: "Assault", path: [{ x: 0, y: 0 }, { x: 1, y: 0 }], duration: .32 }];
  let knockedDone = 0;
  const knockedPreview = createConnectedAssaultPreviewPlayer({ Assault: knockedActor }, knockback, slopeCell, knockedEffects, () => knockedDone++, { height, terrain: height, radius: 2, maxGrade: .5, maxDrop: .3 });
  const knockedContact = new AssaultContactSampler(knockedActor, asset);
  try {
    for (let i = 1; i < 20; i++) {
      knockedPreview.player.update(.016);
      const pulse = Math.sin(Math.PI * i * .016 / .32);
      assert.ok(Math.abs(knockedActor.position.y - height(knockedActor.position.x, knockedActor.position.z) - .6 * pulse) < 1e-8);
      knockedActor.updateMatrixWorld(true);
      for (const side of [0, 1] as const) assert.ok(knockedContact.clearance(side, height) >= -1e-4);
      if (i === 10) {
        const expected = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(-.015, 1, .01).normalize())
          .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), initialKnockbackYaw))
          .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -.18));
        assert.ok(Math.abs(expected.dot(knockedActor.quaternion)) > 1 - 1e-9);
      }
    }
    knockedPreview.player.update(.016);
    assert.equal(knockedDone, 1);
    const settledOrientation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(-.015, 1, .01).normalize())
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), initialKnockbackYaw));
    assert.ok(Math.abs(settledOrientation.dot(knockedActor.quaternion)) > 1 - 1e-9, "knockback must preserve heading after it settles");
    const destination = slopeCell({ x: 1, y: 0 });
    assert.ok(Math.hypot(knockedActor.position.x - destination.x, knockedActor.position.z - destination.z) < 1e-8);
    for (const side of [0, 1] as const) assert.ok(Math.abs(knockedContact.clearance(side, height)) < 1e-4);
  } finally { knockedPreview.player.dispose(); knockedPreview.release(); disposeMechaModel(knockedActor); }
  assert.equal(knockedEffects.children.length, 0);

  const steppedActor = createAssault(), steppedEffects = new THREE.Group();
  assert.equal(upgradeMechaModelToGlb(steppedActor, asset), true);
  steppedActor.scale.setScalar(2);
  const steppedGround = (x: number, z: number) => height(x, z) + (x > 4 ? .04 : 0);
  const steppedPreview = createConnectedAssaultPreviewPlayer({ Assault: steppedActor }, knockback, slopeCell, steppedEffects, () => {}, { height: steppedGround, terrain: height, radius: 2, maxGrade: .5, maxDrop: .3 });
  const steppedContact = new AssaultContactSampler(steppedActor, asset);
  try {
    for (let i = 0; i < 19; i++) {
      steppedPreview.player.update(.016);
      steppedActor.updateMatrixWorld(true);
      for (const side of [0, 1] as const) {
        const clearance = steppedContact.clearance(side, steppedGround);
        assert.ok(clearance >= -1e-4, `step clearance ${clearance} frame ${i} side ${side}`);
      }
    }
    steppedPreview.player.update(Infinity);
    for (const side of [0, 1] as const) assert.ok(Math.abs(steppedContact.clearance(side, steppedGround)) < 1e-4);
  } finally { steppedPreview.player.dispose(); steppedPreview.release(); disposeMechaModel(steppedActor); }

  const fallenActor = createAssault(), fallenEffects = new THREE.Group(), enemy = new THREE.Group();
  assert.equal(upgradeMechaModelToGlb(fallenActor, asset), true);
  fallenActor.scale.setScalar(2);
  const fallenEvents = [events[2]!, { kind: "attack" as const, actor: "boss", attack: "shoot" as const, from: { x: 2, y: 1 }, target: { x: 1, y: 1 }, targetIds: [], duration: .7 }];
  fallenActor.position.copy(slopeCell({ x: 1, y: 1 }));
  const fallenPreview = createConnectedAssaultPreviewPlayer({ Assault: fallenActor, boss: enemy }, fallenEvents, slopeCell, fallenEffects, () => {}, { height, terrain: height, radius: 2, maxGrade: .5, maxDrop: .3 });
  try {
    const fallingMeshes: THREE.SkinnedMesh[] = [];
    fallenActor.traverse((object) => { if ((object as THREE.SkinnedMesh).isSkinnedMesh) fallingMeshes.push(object as THREE.SkinnedMesh); });
    const head = fallenActor.getObjectByName("head")!;
    let initialHead: THREE.Vector3 | undefined, finalHead: THREE.Vector3 | undefined;
    for (let frame = 0; frame <= 20; frame++) {
      fallenPreview.player.update(frame ? events[2]!.duration / 20 : 0);
      fallenActor.updateMatrixWorld(true);
      const headPosition = head.getWorldPosition(new THREE.Vector3());
      initialHead ??= headPosition.clone();
      finalHead = headPosition;
      let clearance = Infinity;
      for (const mesh of fallingMeshes) {
        const point = new THREE.Vector3();
        for (let vertex = 0; vertex < mesh.geometry.getAttribute("position").count; vertex++) {
          mesh.getVertexPosition(vertex, point); mesh.localToWorld(point);
          clearance = Math.min(clearance, point.y - height(point.x, point.z));
        }
      }
      assert.ok(clearance >= -.001 && clearance < .03, `battle defeat clearance ${clearance} at frame ${frame}`);
    }
    assert.ok(initialHead!.distanceTo(finalHead!) > 1, "death playback must visibly change the head position");
    fallenPreview.player.update(.15);
    const foot = fallenActor.getObjectByName("footL")!, before = foot.getWorldPosition(new THREE.Vector3());
    fallenPreview.player.update(.1);
    assert.ok(before.distanceTo(foot.getWorldPosition(new THREE.Vector3())) < 1e-7, "fallen pose must not receive standing leg correction");
    fallenPreview.player.update(Infinity);
    assert.ok(Math.abs(fallenActor.position.y - height(fallenActor.position.x, fallenActor.position.z)) < 1e-8);
    const fallenGround = new AssaultGroundController(fallenActor, { asset, height, terrain: height, radius: 2, maxGrade: .5, maxDrop: .3 });
    const fallenHeading = fallenGround.heading();
    fallenPreview.player.dispose();
    fallenPreview.release();
    fallenActor.rotation.set(0, fallenHeading, 0);
    const nextRound = createConnectedAssaultPreviewPlayer({ Assault: fallenActor, boss: enemy }, [fallenEvents[1]!], slopeCell, fallenEffects, () => {}, { height, terrain: height, radius: 2, maxGrade: .5, maxDrop: .3 }, ["Assault"]);
    try {
      nextRound.player.update(.2);
      assert.ok(before.distanceTo(foot.getWorldPosition(new THREE.Vector3())) < 1e-7, "an initially fallen actor stays down in the next round");
      nextRound.player.update(Infinity);
      assert.ok(before.distanceTo(foot.getWorldPosition(new THREE.Vector3())) < 1e-7);
    } finally { nextRound.player.dispose(); nextRound.release(); }
  } finally { fallenPreview.player.dispose(); fallenPreview.release(); disposeMechaModel(fallenActor); }

  const battle = createMechaController({ animate: true });
  const battleActors = { Assault: createAssault(), Gunner: createGunner(), Support: createSupport(), boss: createBoss(), "raider-w": createRaider(), "raider-e": createRaider() };
  const battleEffects = new THREE.Group();
  assert.equal(upgradeMechaModelToGlb(battleActors.Assault, asset), true);
  for (const model of Object.values(battleActors)) model.scale.setScalar(2);
  const initial = battle.getState().match;
  for (const mech of initial.mechs) battleActors[mech.id].position.copy(slopeCell(mech.pos));
  for (const raider of initial.raiders) battleActors[raider.id as "raider-w" | "raider-e"].position.copy(slopeCell(raider.pos));
  battleActors.boss.position.copy(slopeCell(initial.boss.anchor));
  let rounds = 0, battleMoves = 0, enemyAttacks = 0;
  try {
    for (let round = 0; round < 3 && !battle.getState().match.outcome; round++) {
      if (round) battle.applyDoctrine();
      battle.submit();
      if (battle.getState().holdConfirmation) battle.confirmHold();
      const state = battle.getState(), performance = state.performance;
      assert.ok(performance, `round ${round + 1} did not produce a performance`);
      battleMoves += performance.events.filter((event) => event.kind === "move" && event.actor === "Assault").length;
      enemyAttacks += performance.events.filter((event) => event.kind === "attack" && (event.actor === "boss" || event.actor.startsWith("raider-"))).length;
      const fallen = [
        ...performance.before.mechs.filter((unit) => unit.hp <= 0).map((unit) => unit.id),
        ...performance.before.raiders.filter((unit) => unit.hp <= 0).map((unit) => unit.id),
        ...(performance.before.boss.hp <= 0 ? ["boss"] : []),
      ];
      let finished = 0;
      const play = createConnectedAssaultPreviewPlayer(battleActors, performance.events, slopeCell, battleEffects, () => { finished++; battle.finishPerformance(); }, { height, terrain: height, radius: 2, maxGrade: .5, maxDrop: .3 }, fallen);
      try {
        for (let frame = 0; frame < 6000 && !finished; frame++) play.player.update(1 / 30);
        assert.equal(finished, 1, `round ${round + 1} did not complete`);
        assert.equal(battle.getState().performance, null);
        const final = battle.getState().match;
        for (const mech of final.mechs.filter((unit) => unit.hp > 0)) {
          const actor = battleActors[mech.id], destination = slopeCell(mech.pos);
          if (mech.id === "Assault") {
            assert.ok(Math.hypot(actor.position.x - destination.x, actor.position.z - destination.z) < 1e-7, "Assault final cell");
            const contact = new AssaultContactSampler(actor, asset);
            for (const side of [0, 1] as const) assert.ok(Math.abs(contact.clearance(side, height)) < 1e-4, `Assault final foot ${side}`);
          } else assert.ok(actor.position.distanceTo(destination) < 1e-7, `${mech.id} final position`);
        }
        for (const raider of final.raiders.filter((unit) => unit.hp > 0)) assert.ok(battleActors[raider.id as "raider-w" | "raider-e"].position.distanceTo(slopeCell(raider.pos)) < 1e-7, `${raider.id} final position`);
        if (final.boss.hp > 0) assert.ok(battleActors.boss.position.distanceTo(slopeCell(final.boss.anchor)) < 1e-7, "boss final position");
        rounds++;
      } finally { play.player.dispose(); play.release(); }
    }
    assert.ok(rounds >= 2, `only ${rounds} rounds completed`);
    assert.ok(battleMoves > 0, "the battle must exercise Assault movement");
    assert.ok(enemyAttacks > 0, "the battle must exercise enemy attacks");
  } finally { for (const model of Object.values(battleActors)) disposeMechaModel(model); }
  assert.equal(battleEffects.children.length, 0);

  const now = Date.UTC(2026, 9, 7), day = 86400000;
  const rows = Array.from({ length: 80 }, (_, i) => ({
    session_ref: `s:${i}`, harness: i % 2 ? "harness:claude" : "harness:zcode", title: null, title_source: null,
    first_event_at: new Date(now - day * 20 + i * 3600000).toISOString(), last_event_at: new Date(now - day * 20 + (i + 2) * 3600000).toISOString(), event_count: 10, model_ids: [],
    tokens: { uncached_input_tokens: 50000 + i * 900000, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0, total: 50000 + i * 900000 }, peak_tokens: 50000 + i * 900000,
    cost_minor: null, cost_status: { state: "unavailable" as const, reason: "test", has_unresolved: false },
  }));
  const city = buildCityModel({ rows, findings: [], windowStartMs: now - 30 * day, windowEndMs: now, windowLabel: "30d", totalSessions: rows.length, truncated: false, generatedAt: now });
  const layout = layoutCity(city, null, 64, MIAMI_COASTAL, "off");
  const ridge = siteFightShapes(layout.terrain, anchorsFromCity(layout, city), layout.roadEdges).ridge;
  assert.ok(ridge);
  const terrain = (x: number, z: number) => terrainSurfaceHeight(layout, x, z);
  const ridgeHeight = createAssaultCityGround(layout, compileGroundRoadSurface(layout));
  for (const [fromCell, toCell, yaw] of [[{ x: 7, y: 7 }, { x: 7, y: 8 }, 0], [{ x: 6, y: 3 }, { x: 6, y: 4 }, Math.PI / 2], [{ x: 7, y: 5 }, { x: 7, y: 6 }, Math.PI]] as const) {
    const transitionActor = createAssault(); assert.equal(upgradeMechaModelToGlb(transitionActor, asset), true); transitionActor.scale.setScalar(2);
    const start = cellWorld(ridge, fromCell), end = cellWorld(ridge, toCell);
    const targetYaw = Math.atan2(start.x - end.x, start.z - end.z), delta = Math.atan2(Math.sin(targetYaw - yaw), Math.cos(targetYaw - yaw));
    const config = { asset, height: ridgeHeight, terrain, radius: 2, maxGrade: .5, maxDrop: .3 };
    const controller = new AssaultGroundController(transitionActor, config), contacts = new AssaultContactSampler(transitionActor, asset);
    try {
      transitionActor.position.set(start.x, start.y, start.z); transitionActor.rotation.y = yaw;
      poseMechaModel(transitionActor, "idle", 0); controller.align(yaw); transitionActor.updateMatrixWorld(true);
      transitionActor.position.y -= Math.min(.8, Math.max(0, contacts.clearance(0, ridgeHeight), contacts.clearance(1, ridgeHeight)));
      controller.feet(0, 0);
      new AssaultTurnIK(transitionActor, .012 * 21.245691361301702, .022 * 21.245691361301702).sample(delta, 1);
      controller.feet(0, 0); controller.support();
      const a = captureAssaultPose(transitionActor);
      transitionActor.position.set(start.x, start.y, start.z); transitionActor.rotation.y = targetYaw;
      poseMechaModel(transitionActor, "move", 0); controller.align(targetYaw); controller.feet(0, .3); controller.support();
      const b = captureAssaultPose(transitionActor), transition = new AssaultPoseTransition(transitionActor, a, b, config);
      const legs = ["thighL", "shinL", "footL", "thighR", "shinR", "footR"].map((name) => transitionActor.getObjectByName(name)!);
      const samples: THREE.Vector3[][] = []; let previous: THREE.Vector3[] | undefined, lengths: number[] | undefined, previousGaps: number[] | undefined;
      let maxStep = 0, supportDrift = 0;
      for (let frame = 0; frame <= 60; frame++) {
        transition.sample(frame / 60); const points = legs.map((bone) => bone.getWorldPosition(new THREE.Vector3())); samples.push(points);
        const currentLengths = [points[0]!.distanceTo(points[1]!), points[1]!.distanceTo(points[2]!), points[3]!.distanceTo(points[4]!), points[4]!.distanceTo(points[5]!)];
        lengths ??= currentLengths;
        currentLengths.forEach((value, i) => assert.ok(Math.abs(value - lengths![i]!) < 1e-4));
        const gaps = [contacts.clearance(0, ridgeHeight), contacts.clearance(1, ridgeHeight)];
        assert.ok(Math.min(...gaps) >= -1e-5 && Math.min(...gaps) < 1e-5, `transition support ${gaps}`);
        if (previous && previousGaps) {
          points.forEach((point, i) => { maxStep = Math.max(maxStep, point.distanceTo(previous![i]!)); });
          for (const side of [0, 1]) if (gaps[side]! < 1e-4 && previousGaps[side]! < 1e-4) supportDrift += Math.hypot(points[side * 3 + 2]!.x - previous[side * 3 + 2]!.x, points[side * 3 + 2]!.z - previous[side * 3 + 2]!.z);
        }
        previous = points; previousGaps = gaps;
      }
      assert.ok(maxStep < .1, `transition bone step ${maxStep}`);
      assert.ok(supportDrift < .005, `transition planted drift ${supportDrift}`);
      for (let frame = 60; frame >= 0; frame--) {
        transition.sample(frame / 60);
        legs.forEach((bone, i) => assert.ok(bone.getWorldPosition(new THREE.Vector3()).distanceTo(samples[frame]![i]!) < 1e-8));
      }
      assert.throws(() => transition.sample(NaN), /phase/);
      const other = createAssault(); assert.equal(upgradeMechaModelToGlb(other, asset), true);
      try { assert.throws(() => new AssaultPoseTransition(transitionActor, a, captureAssaultPose(other), config), /incompatible/); }
      finally { disposeMechaModel(other); }
      let rejectGround = false;
      const failingTransition = new AssaultPoseTransition(transitionActor, a, b, { ...config, height: (x, z) => rejectGround ? NaN : ridgeHeight(x, z) });
      const rawBone = transitionActor.getObjectByName("shinL")!, q = rawBone.quaternion; q.set(q.x * .9999, q.y * .9999, q.z * .9999, q.w * .9999);
      const savedPosition = transitionActor.position.toArray(), savedQuaternion = transitionActor.quaternion.toArray();
      const savedBones: { bone: THREE.Bone; position: number[]; quaternion: number[]; scale: number[] }[] = [];
      transitionActor.traverse((object) => { if ((object as THREE.Bone).isBone) savedBones.push({ bone: object as THREE.Bone, position: object.position.toArray(), quaternion: object.quaternion.toArray(), scale: object.scale.toArray() }); });
      rejectGround = true;
      assert.throws(() => failingTransition.sample(.5), /height/);
      assert.deepEqual(transitionActor.position.toArray(), savedPosition);
      assert.deepEqual(transitionActor.quaternion.toArray(), savedQuaternion);
      savedBones.forEach((value) => {
        assert.deepEqual(value.bone.position.toArray(), value.position);
        assert.deepEqual(value.bone.quaternion.toArray(), value.quaternion);
        assert.deepEqual(value.bone.scale.toArray(), value.scale);
      });
    } finally { disposeMechaModel(transitionActor); }
  }
  const safety = sampleAssaultTerrainSafety(ridge, terrain, 2, .5, .25);
  const match = matchFromSite({ ...ridge, assaultTerrainSafety: safety }, { preset: "covers_sparse_mid", script: "siege" });
  const from = { x: 7, y: 5 }, to = { x: 7, y: 6 };
  match.mechs.find((mech) => mech.id === "Assault")!.pos = from;
  bossPrepare(match);
  assert.equal(validateAndApplyPlan(match, { revision: match.revision, items: match.mechs.map((mech) => ({ mechId: mech.id, moveTo: mech.id === "Assault" ? to : null, action: { kind: "skip" as const } })) }).ok, true);
  const ridgeActor = createAssault(), ridgeEffects = new THREE.Group();
  assert.equal(upgradeMechaModelToGlb(ridgeActor, asset), true); ridgeActor.scale.setScalar(2);
  const ridgeCell = (cell: { x: number; y: number }) => { const p = cellWorld(ridge, cell); return new THREE.Vector3(p.x, p.y, p.z); };
  ridgeActor.position.copy(ridgeCell(from));
  const ridgeContact = new AssaultContactSampler(ridgeActor, asset);
  let ridgeDone = 0, minClearance = Infinity, maxSupportGap = 0;
  const ridgeStride = measureAssaultStride(asset);
  const ridgeGait = createAssaultGaitPlan([ridgeCell(from), ridgeCell(to)], 0, ridgeStride.stride * 2 * ASSAULT_STRIDE_MULTIPLIER, ASSAULT_WALK_CYCLE_SECONDS, assaultTurnDuration, ASSAULT_TRANSITION_SECONDS);
  let ridgeElapsed = 0;
  const ridgePlayer = createConnectedAssaultPreviewPlayer({ Assault: ridgeActor }, [{ kind: "move", actor: "Assault", path: [from, to], duration: .5 }], ridgeCell, ridgeEffects, () => ridgeDone++, { height: ridgeHeight, terrain, radius: 2, maxGrade: .5, maxDrop: .3 });
  try {
    for (let frame = 0; frame < 2000 && !ridgeDone; frame++) {
      ridgePlayer.player.update(1 / 60); ridgeElapsed = Math.min(ridgeGait.duration, ridgeElapsed + 1 / 60); ridgeActor.updateMatrixWorld(true);
      const gaps = [ridgeContact.clearance(0, ridgeHeight), ridgeContact.clearance(1, ridgeHeight)];
      minClearance = Math.min(minClearance, ...gaps);
      if (sampleAssaultGait(ridgeGait, ridgeElapsed, ridgeStride.profile).kind === "walk") maxSupportGap = Math.max(maxSupportGap, Math.min(...gaps));
    }
    assert.equal(ridgeDone, 1);
    assert.ok(minClearance >= -1e-4, `ridge foot penetration ${minClearance}`);
    assert.ok(maxSupportGap < 1e-4, `ridge walk lost support ${maxSupportGap}`);
    const end = ridgeCell(to);
    assert.ok(Math.hypot(ridgeActor.position.x - end.x, ridgeActor.position.z - end.z) < 1e-7);
    for (const side of [0, 1] as const) assert.ok(Math.abs(ridgeContact.clearance(side, ridgeHeight)) < 1e-4, `ridge settled foot ${side}`);
  } finally { ridgePlayer.player.dispose(); ridgePlayer.release(); disposeMechaModel(ridgeActor); }

  for (const [start, end, yaw] of [[{ x: 8, y: 9 }, { x: 8, y: 8 }, 0], [{ x: 6, y: 3 }, { x: 6, y: 4 }, Math.PI / 2]] as const) {
    const actor = createAssault(), effects = new THREE.Group();
    assert.equal(upgradeMechaModelToGlb(actor, asset), true);
    actor.scale.setScalar(2); actor.position.copy(ridgeCell(start)); actor.rotation.y = yaw;
    const contact = new AssaultContactSampler(actor, asset);
    const plan = createAssaultGaitPlan([ridgeCell(start), ridgeCell(end)], yaw, ridgeStride.stride * 2 * ASSAULT_STRIDE_MULTIPLIER, ASSAULT_WALK_CYCLE_SECONDS, assaultTurnDuration, ASSAULT_TRANSITION_SECONDS);
    const bones = ["thighL", "shinL", "footL", "thighR", "shinR", "footR"].map((name) => actor.getObjectByName(name)!);
    let done = 0, elapsed = 0, previous: THREE.Vector3[] | undefined, worst = 0;
    const player = createConnectedAssaultPreviewPlayer({ Assault: actor }, [{ kind: "move", actor: "Assault", path: [start, end], duration: .5 }], ridgeCell, effects, () => done++, { height: ridgeHeight, terrain, radius: 2, maxGrade: .5, maxDrop: .3 });
    try {
      for (let frame = 0; frame < 2000 && !done; frame++) {
        elapsed = Math.min(plan.duration, elapsed + 1 / 60); player.player.update(1 / 60);
        const points = bones.map((bone) => bone.getWorldPosition(new THREE.Vector3()));
        if (sampleAssaultGait(plan, elapsed, ridgeStride.profile).kind === "walk") {
          if (previous) points.forEach((point, i) => { worst = Math.max(worst, point.distanceTo(previous![i]!)); });
          const gaps = [contact.clearance(0, ridgeHeight), contact.clearance(1, ridgeHeight)];
          assert.ok(Math.min(...gaps) >= -1e-4 && Math.min(...gaps) < 1e-4, `ridge walk contact ${gaps}`);
        }
        previous = points;
      }
      assert.equal(done, 1);
      assert.ok(worst < .65, `ridge walk bone step ${worst}`);
    } finally { player.player.dispose(); player.release(); disposeMechaModel(actor); }
  }

  const straightStart = ridgeCell(from), straightEnd = ridgeCell(to);
  const straightYaw = Math.atan2(-(straightEnd.x - straightStart.x), -(straightEnd.z - straightStart.z));
  for (const idleTime of [0, .25, .5, .75, 1, 1.5, 2]) for (const yaw of [0, straightYaw]) {
    const actor = createAssault(), effects = new THREE.Group();
    assert.equal(upgradeMechaModelToGlb(actor, asset), true);
    actor.scale.setScalar(2); actor.position.copy(ridgeCell(from)); actor.rotation.y = yaw;
    const ground = new AssaultGroundController(actor, { asset, height: ridgeHeight, terrain, radius: 2, maxGrade: .5, maxDrop: .3 });
    poseMechaModel(actor, "idle", idleTime); ground.align(yaw); ground.stand();
    const bones = ["thighL", "shinL", "footL", "thighR", "shinR", "footR", "handR"].map((name) => actor.getObjectByName(name)!);
    const before = bones.map((bone) => bone.getWorldPosition(new THREE.Vector3()));
    actor.position.copy(ridgeCell(from)); actor.rotation.set(0, yaw, 0);
    const player = createConnectedAssaultPreviewPlayer({ Assault: actor }, [{ kind: "move", actor: "Assault", path: [from, to], duration: .5 }], ridgeCell, effects, () => {}, { height: ridgeHeight, terrain, radius: 2, maxGrade: .5, maxDrop: .3 });
    try {
      for (const step of [0, 1 / 60]) {
        player.player.update(step);
        bones.forEach((bone, i) => {
          const distance = bone.getWorldPosition(new THREE.Vector3()).distanceTo(before[i]!);
          assert.ok(distance < .1, `idle handoff ${idleTime} ${step} ${bone.name}: ${distance}`);
        });
      }
    } finally { player.player.dispose(); player.release(); disposeMechaModel(actor); }
  }

  {
    const actor = createAssault(), effects = new THREE.Group();
    assert.equal(upgradeMechaModelToGlb(actor, asset), true);
    actor.scale.setScalar(2); actor.position.copy(straightStart); actor.rotation.y = straightYaw;
    const contact = new AssaultContactSampler(actor, asset);
    const plan = createAssaultGaitPlan([straightStart, straightEnd], straightYaw, ridgeStride.stride * 2 * ASSAULT_STRIDE_MULTIPLIER, ASSAULT_WALK_CYCLE_SECONDS, assaultTurnDuration, ASSAULT_TRANSITION_SECONDS);
    assert.equal(plan.stages[0]!.kind, "transition");
    const bones = ["thighL", "shinL", "footL", "thighR", "shinR", "footR"].map((name) => actor.getObjectByName(name)!);
    let done = 0, previous: THREE.Vector3[] | undefined, worst = 0, elapsed = 0;
    const player = createConnectedAssaultPreviewPlayer({ Assault: actor }, [{ kind: "move", actor: "Assault", path: [from, to], duration: .5 }], ridgeCell, effects, () => done++, { height: ridgeHeight, terrain, radius: 2, maxGrade: .5, maxDrop: .3 });
    try {
      for (let frame = 0; frame < 2000 && !done; frame++) {
        player.player.update(1 / 60); elapsed += 1 / 60;
        const points = bones.map((bone) => bone.getWorldPosition(new THREE.Vector3()));
        if (previous) points.forEach((point, i) => { worst = Math.max(worst, point.distanceTo(previous![i]!)); });
        const sample = sampleAssaultGait(plan, elapsed, ridgeStride.profile);
        if (sample.kind === "transition" || sample.kind === "walk") {
          const gaps = [contact.clearance(0, ridgeHeight), contact.clearance(1, ridgeHeight)];
          assert.ok(Math.min(...gaps) >= -1e-4 && Math.min(...gaps) < 1e-4, `straight start contact ${gaps}`);
        }
        previous = points;
      }
      assert.equal(done, 1);
      assert.ok(worst < .65, `straight start bone step ${worst}`);
      assert.ok(Math.hypot(actor.position.x - straightEnd.x, actor.position.z - straightEnd.z) < 1e-7);
    } finally { player.player.dispose(); player.release(); disposeMechaModel(actor); }
  }

  const timelineActors = [createAssault(), createAssault()];
  const timelineEffects = [new THREE.Group(), new THREE.Group()];
  const timelinePlayers = timelineActors.map((actor, i) => {
    assert.equal(upgradeMechaModelToGlb(actor, asset), true); actor.scale.setScalar(2); actor.position.copy(ridgeCell(from));
    return createConnectedAssaultPreviewPlayer({ Assault: actor }, [{ kind: "move", actor: "Assault", path: [from, to], duration: .5 }], ridgeCell, timelineEffects[i]!, () => {}, { height: ridgeHeight, terrain, radius: 2, maxGrade: .5, maxDrop: .3 });
  });
  try {
    const plan = createAssaultGaitPlan([ridgeCell(from), ridgeCell(to)], 0, ridgeStride.stride * 2 * ASSAULT_STRIDE_MULTIPLIER, ASSAULT_WALK_CYCLE_SECONDS, assaultTurnDuration, ASSAULT_TRANSITION_SECONDS);
    const stage = plan.stages.find((value) => value.kind === "transition"); assert.ok(stage && stage.kind === "transition");
    const names = ["thighL", "shinL", "footL", "thighR", "shinR", "footR"];
    const points = (actor: THREE.Group) => names.map((name) => actor.getObjectByName(name)!.getWorldPosition(new THREE.Vector3()));
    const check = (a: THREE.Vector3[], b: THREE.Vector3[], max: number) => a.forEach((value, i) => assert.ok(value.distanceTo(b[i]!) < max, `${names[i]} transition displacement ${value.distanceTo(b[i]!)}`));
    timelinePlayers[0]!.player.update(stage.start - 1e-5);
    const turnEnd = points(timelineActors[0]!);
    timelinePlayers[0]!.player.update(2e-5);
    check(turnEnd, points(timelineActors[0]!), .01);
    timelinePlayers[0]!.player.update(stage.duration / 2 - 1e-5);
    timelinePlayers[1]!.player.update(stage.start + stage.duration / 2);
    check(points(timelineActors[0]!), points(timelineActors[1]!), 1e-5);
    const paused = points(timelineActors[0]!); timelinePlayers[0]!.player.update(0); check(paused, points(timelineActors[0]!), 1e-8);
    timelinePlayers[0]!.player.update(stage.duration / 2 - 1e-5);
    const transitionEnd = points(timelineActors[0]!);
    timelinePlayers[0]!.player.update(2e-5);
    check(transitionEnd, points(timelineActors[0]!), .01);
  } finally { timelinePlayers.forEach((player) => { player.player.dispose(); player.release(); }); timelineActors.forEach(disposeMechaModel); }

  let resolveLate!: (value: typeof asset) => void;
  installMechaGlbProvider({ has: (role) => role === "Assault", peek: () => null, load: () => new Promise((resolve) => { resolveLate = resolve; }) });
  const fallback = createAssault(), fallbackEffects = new THREE.Group();
  assert.throws(() => createConnectedAssaultPreviewPlayer({ Assault: fallback }, events, cell, fallbackEffects, () => {}, { height, terrain: height, radius: 2, maxGrade: .5, maxDrop: .3 }), /candidate is not ready/);
  const waiting = createConnectedAssaultPreviewPlayer({ Assault: fallback }, events, cell, fallbackEffects, () => {});
  try {
    resolveLate(asset);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(getMechaGlbAsset(fallback), undefined);
    waiting.player.update(.1);
    waiting.player.dispose();
    waiting.release();
    assert.equal(getMechaGlbAsset(fallback), asset);
  } finally { waiting.release(); disposeMechaModel(fallback); installMechaGlbProvider(null); }

  let resolveAsset!: (value: typeof asset) => void;
  const delayed = new Promise<typeof asset>((resolve) => { resolveAsset = resolve; });
  installMechaGlbProvider({ has: () => true, peek: () => null, load: () => delayed });
  const loadingActor = createAssault();
  let isReady = false;
  const readiness = ensureMechaGlbAsset(loadingActor, "Assault", manifest.id).then(() => { isReady = true; });
  await Promise.resolve();
  assert.equal(isReady, false);
  resolveAsset(asset);
  await readiness;
  assert.equal(getMechaGlbAsset(loadingActor), asset);
  disposeMechaModel(loadingActor);

  let resolveDisposed!: (value: typeof asset) => void;
  const disposedLoad = new Promise<typeof asset>((resolve) => { resolveDisposed = resolve; });
  installMechaGlbProvider({ has: () => true, peek: () => null, load: () => disposedLoad });
  const disposedActor = createAssault();
  const disposedReadiness = ensureMechaGlbAsset(disposedActor, "Assault", manifest.id);
  disposeMechaModel(disposedActor);
  resolveDisposed(asset);
  await assert.rejects(disposedReadiness, /disposed while loading/);
  assert.equal(getMechaGlbAsset(disposedActor), undefined);

  installMechaGlbProvider({ has: () => true, peek: () => asset, load: async () => asset });
  const wrongActor = createAssault();
  await assert.rejects(ensureMechaGlbAsset(wrongActor, "Assault", "wrong-id"), /unexpected Assault/);
  disposeMechaModel(wrongActor);
  installMechaGlbProvider(null);
});
