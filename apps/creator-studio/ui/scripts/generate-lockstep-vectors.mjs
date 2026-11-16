#!/usr/bin/env node
// 锁步向量生成器（E5 验收：同一输入，SDK-TS 原生路径与嵌入式路径诊断逐字节一致）。
//
// 本脚本在 Node/V8 下通过 Studio 适配器同一条 import 链执行 gate 入口
// （embeddedGate → sdkValidation / cityWorldOperations → city-sdk），把每个向量
// 的 citySdkGate.invoke() 返回字符串**原样**写入
// apps/desktop/src-tauri/embedded_city_sdk/lockstep-vectors.json。Rust 侧
// （embedded_city_sdk.rs 的锁步测试）在同一份向量上用 rquickjs（Bellard QuickJS）
// 重放并逐字节比对——这是「TS 路径 = 嵌入式路径」两面证明的 TS 权威面。
//
// 向量结构复用 W1 spike（evals/wasm-spike/vectors.mjs）的验收集，并扩展 S1 正则
// 修复向量与 world/scene/game/worldParameters 直连入口。
// （落位在 apps/creator-studio/ui/scripts/ 是为了让 @agent-vitals/city-sdk 沿
// ui/node_modules 解析；桌面工程链上没有 node_modules。）
//
// 用法（仓库根或本目录均可）：
//   node --experimental-transform-types --import scripts/mecha-ts-register.mjs \
//     apps/creator-studio/ui/scripts/generate-lockstep-vectors.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ARID_DUNES_WORLD_V2, CREATOR_TEMPLATES_V1, FIXED_WING_VEHICLE_PRESET_V1, ORNITHOPTER_VEHICLE_PRESET_V1 } from "@agent-vitals/city-sdk";
import { citySdkGate } from "../src/embeddedGate.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, "../../../desktop/src-tauri/embedded_city_sdk");
const OUT = resolve(OUT_DIR, "lockstep-vectors.json");
const OUT_LOCK = resolve(OUT_DIR, "lockstep-vectors.lock.json");

const invoke = (entry, args) => citySdkGate.invoke(entry, JSON.stringify(args));
const clone = value => JSON.parse(JSON.stringify(value));

const orni = clone(ORNITHOPTER_VEHICLE_PRESET_V1);
const fixed = clone(FIXED_WING_VEHICLE_PRESET_V1);
const dunes = {
  schemaVersion: 1, id: "arid-dunes", version: 1, biome: "arid",
  geography: { generator: "arid-dunes-v1", parameters: { dunes: { duneScale: 190, duneAmplitude: 11, orientationDeg: 18 } } },
  visuals: { themeId: "desert" },
};
const cityDoc = {
  schemaVersion: 1, cityId: "city-lockstep", revision: 3, name: "锁步城", seed: 20261115, profile: dunes,
};
const flightPack = clone(CREATOR_TEMPLATES_V1.find(item => item.id === "flight-checkpoint").pack);
const outOfBounds = clone(orni); outOfBounds.physics.maxSpeedMps = 999;
const unphysical = clone(orni); unphysical.physics.wingAreaM2 = 2.0;
const unknownKey = clone(orni); unknownKey.extra = 1;
const schema2 = clone(orni); schema2.schemaVersion = 2;
const hyphenLabel = clone(orni); hyphenLabel.label = "扑翼-原型机(wing)-01";

const vectors = [
  { id: "vehicle-ok", entry: "vehicle.profile.validate", args: { raw: orni } },
  { id: "vehicle-fixed-ok", entry: "vehicle.profile.validate", args: { raw: fixed } },
  { id: "vehicle-out-of-bounds", entry: "vehicle.profile.validate", args: { raw: outOfBounds } },
  { id: "vehicle-unphysical", entry: "vehicle.profile.validate", args: { raw: unphysical } },
  { id: "vehicle-unknown-key", entry: "vehicle.profile.validate", args: { raw: unknownKey } },
  { id: "vehicle-non-object", entry: "vehicle.profile.validate", args: { raw: 42 } },
  { id: "vehicle-schema2", entry: "vehicle.profile.validate", args: { raw: schema2 } },
  { id: "vehicle-hyphen-label", entry: "vehicle.profile.validate", args: { raw: hyphenLabel } },
  { id: "vehicle-normalize-ok", entry: "vehicle.validate", args: { raw: { id: "vehicle-e2e-flap", label: "E2E flapper",
    flightModel: "flapping", physics: orni.physics, bounds: orni.bounds, modelAssetId: null } } },
  { id: "vehicle-estimate-ok", entry: "vehicle.estimate", args: { raw: orni } },
  { id: "world-apply-ok", entry: "city.world.apply",
    args: { city: cityDoc, baseRevision: 3, operations: [{ op: "world.set", params: { "shape.family": "lobed", "shape.cores": 3 } }] } },
  { id: "world-apply-revision-mismatch", entry: "city.world.apply",
    args: { city: cityDoc, baseRevision: 2, operations: [{ op: "world.set", params: { "shape.family": "lobed" } }] } },
  { id: "world-apply-unknown-key", entry: "city.world.apply",
    args: { city: cityDoc, baseRevision: 3, operations: [{ op: "world.set", params: { "shape.unknown": 1 } }] } },
  { id: "world-apply-out-of-range", entry: "city.world.apply",
    args: { city: cityDoc, baseRevision: 3, operations: [{ op: "world.set", params: { "shape.cores": 9 } }] } },
  { id: "city-create-ok", entry: "city.create.validate",
    args: { name: "锁步城", seed: 20261115, profile: dunes } },
  { id: "city-create-bad-seed", entry: "city.create.validate",
    args: { name: "锁步城", seed: -1, profile: dunes } },
  { id: "scene-draft-invalid", entry: "scene.draft.validate",
    args: { raw: { schemaVersion: 1, objects: [{ id: "obj-1", kind: "not-a-kind" }] } } },
  { id: "game-pack-ok", entry: "game.pack.validate", args: { raw: flightPack } },
  { id: "game-pack-invalid", entry: "game.pack.validate", args: { raw: { ...flightPack, slots: {} } } },
  { id: "world-parameters-direct-ok", entry: "world.parameters.validate",
    args: { capability: ARID_DUNES_WORLD_V2, input: { "shape.family": "lobed", "shape.cores": 3 } } },
  { id: "world-parameters-direct-out-of-range", entry: "world.parameters.validate",
    args: { capability: ARID_DUNES_WORLD_V2, input: { "shape.cores": 9 } } },
];

const payload = {
  schemaVersion: 1,
  authority: "node-v8 (SDK-TS native path via the Studio adapter import chain)",
  note: "expected strings are the EXACT citySdkGate.invoke() outputs under Node/V8; the QuickJS side must reproduce them byte for byte",
  regenerate: "node --experimental-transform-types --import scripts/mecha-ts-register.mjs apps/creator-studio/ui/scripts/generate-lockstep-vectors.mjs",
  vectors: vectors.map(vector => ({ id: vector.id, entry: vector.entry, args: vector.args, expected: invoke(vector.entry, vector.args) })),
};

const failed = payload.vectors.filter(vector => typeof vector.expected !== "string");
if (failed.length > 0) { console.error(`non-string invoke outputs for: ${failed.map(item => item.id).join(", ")}`); process.exit(1); }

writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`);
const digest = createHash("sha256").update(readFileSync(OUT)).digest("hex");
writeFileSync(OUT_LOCK, `${JSON.stringify({ schemaVersion: 1, file: "lockstep-vectors.json", sha256: digest, vectorCount: payload.vectors.length }, null, 2)}\n`);
console.log(`${payload.vectors.length} lockstep vectors → ${OUT} (sha256:${digest.slice(0, 12)}…)`);
