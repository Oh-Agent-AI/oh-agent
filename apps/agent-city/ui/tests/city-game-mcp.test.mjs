import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

// 通用游戏操控 MCP（apps/agent-city/mcp/city-game-mcp.mjs）：stdio、无 UI、固定步长。
// 这里只断言「Agent 真的能通过 MCP 打开一局、喂输入、读到结局与确定性 trace」——
// 规则由 createMountedMiniGamePlan + MountedMiniGameControllerV1 判定，服务器不重解释。
const server = new URL("../../mcp/city-game-mcp.mjs", import.meta.url);
const register = new URL("../../../../scripts/mecha-ts-register.mjs", import.meta.url);

function connect() {
  const child = spawn(process.execPath, ["--experimental-transform-types", "--import", register.pathname, server.pathname],
    { cwd: new URL("../", import.meta.url).pathname, stdio: ["pipe", "pipe", "inherit"] });
  let buffer = "", id = 0;
  const pending = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffer += chunk;
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      const message = JSON.parse(line);
      pending.get(message.id)?.(message); pending.delete(message.id);
    }
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    pending.set(requestId, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n");
    const timer = setTimeout(() => { if (pending.delete(requestId)) reject(new Error(`${method} timed out`)); }, 20000);
    timer.unref();
  });
  const call = async (name, args) => {
    const response = await request("tools/call", { name, arguments: args });
    const payload = JSON.parse(response.result.content[0].text);
    return { ...payload, isError: response.result.isError === true };
  };
  return { child, request, call, close: () => child.kill() };
}

const gatePack = capability => ({ schemaVersion: 1, id: "mcp-test", rulesVersion: 1,
  slots: { gates: { kind: "zone", min: 1, max: 2, requires: [capability] } },
  rules: { counters: { passed: { initial: 0, max: 1 } }, nodes: [
    { id: "gate", on: { type: "zone.entered", slot: "gates" }, actions: [
      { op: "counter.add", counter: "passed", amount: 1 }, { op: "run.finish", outcome: "success" }] },
  ] } });

test("stdio MCP exposes the generic game-control tools", async () => {
  const client = connect();
  try {
    const init = await client.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    assert.equal(init.result.serverInfo.name, "city-game-control");
    const tools = await client.request("tools/list");
    const names = tools.result.tools.map(tool => tool.name);
    for (const name of ["game_types", "game_open", "game_step", "game_script", "game_state", "game_trace", "game_close"]) {
      assert.ok(names.includes(name), `missing ${name}`);
    }
  } finally { client.close(); }
});

test("a flight session flies through a released gate and finishes with the pack's outcome", async () => {
  const client = connect();
  try {
    const opened = await client.call("game_open", { gameType: "flight", vehicle: "fixed-wing",
      pack: gatePack("fly"), gates: [{ x: 60, y: 40, z: 0, radius: 20 }] });
    assert.equal(opened.isError, false);
    assert.equal(opened.gameType, "flight");
    assert.equal(opened.gates.total, 1);
    let state = opened;
    for (let index = 0; index < 40 && state.phase === "running"; index += 1) {
      state = await client.call("game_step", { sessionId: opened.sessionId, ticks: 6, input: { throttleUp: true } });
    }
    assert.equal(state.phase, "finished");
    assert.equal(state.outcome, "success");
    assert.deepEqual(state.counters, { passed: 1 });
    assert.equal(state.gates.passed, 1);
    // 米制暴露：门在 60 m，穿过时的机位就在门附近，速度是 m/s 量级而不是世界单位。
    assert.ok(state.pose.x > 40 && state.pose.x < 80, `unexpected x ${state.pose.x}`);
    assert.ok(state.pose.speed > 50 && state.pose.speed < 100, `unexpected speed ${state.pose.speed}`);
  } finally { client.close(); }
});

test("the same inputs reproduce the same trace digest, and a different script does not", async () => {
  const client = connect();
  try {
    const open = () => client.call("game_open", { gameType: "flight", vehicle: "ornithopter", seed: 11 });
    const script = [{ ticks: 30, input: { throttleUp: true } }, { ticks: 20, input: { turnRight: true } }];
    const first = await open();
    const second = await open();
    const firstRun = await client.call("game_script", { sessionId: first.sessionId, script });
    const secondRun = await client.call("game_script", { sessionId: second.sessionId, script });
    assert.equal(firstRun.traceDigest, secondRun.traceDigest);
    assert.ok(firstRun.executedTicks > 0);
    const other = await open();
    const otherRun = await client.call("game_script", { sessionId: other.sessionId, script: [{ ticks: 30, input: { throttleUp: true } }] });
    assert.notEqual(firstRun.traceDigest, otherRun.traceDigest);
    const trace = await client.call("game_trace", { sessionId: first.sessionId });
    assert.ok(trace.trace.length > 0 && trace.trace.length <= 512);
    assert.equal(trace.traceDigest, firstRun.traceDigest);
  } finally { client.close(); }
});

test("a driving session runs the same gate pack on the drive capability", async () => {
  const client = connect();
  try {
    const opened = await client.call("game_open", { gameType: "driving", pack: gatePack("drive"),
      gates: [{ x: 20, y: 0, z: 0, radius: 4 }] });
    assert.equal(opened.isError, false);
    let state = opened;
    for (let index = 0; index < 60 && state.phase === "running"; index += 1) {
      state = await client.call("game_step", { sessionId: opened.sessionId, ticks: 6, input: { forward: true } });
    }
    assert.equal(state.outcome, "success");
    assert.equal(state.gates.passed, 1);
  } finally { client.close(); }
});

test("bad arguments and budgets fail closed instead of inventing a run", async () => {
  const client = connect();
  try {
    const unknownPreset = await client.call("game_open", { gameType: "flight", vehicle: "not-a-preset" });
    assert.equal(unknownPreset.isError, true);
    assert.match(unknownPreset.error, /vehicle_preset_unknown/);
    const packWithoutGates = await client.call("game_open", { gameType: "flight", pack: gatePack("fly"), gates: [] });
    assert.equal(packWithoutGates.isError, true);
    assert.match(packWithoutGates.error, /gates_required/);
    const unknownSession = await client.call("game_step", { sessionId: "game-404" });
    assert.equal(unknownSession.isError, true);
    // tick 预算：到点就停在 finished，理由如实给出。
    const budgeted = await client.call("game_open", { gameType: "flight", vehicle: "fixed-wing", maxTicks: 10 });
    const stopped = await client.call("game_step", { sessionId: budgeted.sessionId, ticks: 20, input: { throttleUp: true } });
    assert.equal(stopped.phase, "finished");
    assert.equal(stopped.reason, "tick_budget_exhausted");
    assert.equal(stopped.tick, 10);
  } finally { client.close(); }
});

// ── release 模式 ───────────────────────────────────────────────────────────────
// 用临时 Creator 库（与 Rust creator_store 同一 DDL）验证：载具/pack/门从发布快照来，
// 快照没有几何时如实拒绝并要求显式 gates，而不是编造门的位置。
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "@oh-agent/city-sdk";

const gamePack = { schemaVersion: 1, id: "creator.gates", rulesVersion: 1,
  slots: { gates: { kind: "zone", min: 1, max: 2, requires: ["fly"] } },
  rules: { counters: { passed: { initial: 0, max: 1 } }, nodes: [
    { id: "gate", on: { type: "zone.entered", slot: "gates" }, actions: [{ op: "counter.add", counter: "passed", amount: 1 }, { op: "run.finish", outcome: "success" }] },
  ] } };
const vehicle = { schemaVersion: 1, id: "vehicle-release", label: "Released flier", modelAssetId: null, flightModel: "fixed-wing",
  physics: { massKg: 620, wingAreaM2: 16, thrustN: 9000, maxSpeedMps: 130, dragCoefficient: 0.06, turnRateRps: 1.05, climbRateMps: 26, sinkRateMps: 20 },
  bounds: { halfLengthM: 4.5, halfWidthM: 5.5, halfHeightM: 1.5 }, camera: { followDistanceM: 35.75, heightOffsetM: 14.3, fovDeg: 55 } };

function fixtureStore({ withGeometry }) {
  const dataHome = mkdtempSync(join(tmpdir(), "city-game-mcp-"));
  mkdirSync(join(dataHome, "state", "creator"), { recursive: true });
  const db = new DatabaseSync(join(dataHome, "state", "creator", "projects.sqlite"));
  db.exec(`CREATE TABLE creator_releases (
      release_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, revision INTEGER NOT NULL,
      layout_id TEXT NOT NULL, world_revision TEXT NOT NULL, snapshot_json TEXT NOT NULL,
      snapshot_digest TEXT NOT NULL, created_at_ms INTEGER NOT NULL, UNIQUE(project_id, revision));
    CREATE TABLE creator_city_layouts_v2 (
      city_id TEXT NOT NULL, city_revision INTEGER NOT NULL, world_revision TEXT NOT NULL,
      layout_id TEXT NOT NULL, snapshot_json TEXT NOT NULL, snapshot_digest TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL, PRIMARY KEY(city_id,city_revision,world_revision));`);
  const digest = `sha256:${createHash("sha256").update(canonicalJson(gamePack)).digest("hex")}`;
  const snapshot = { projectId: "project-release", revision: 1, title: "Release", gameType: "flight",
    runtimeContractVersion: 1, vehicleId: "vehicle-release", vehicle, layoutId: "layout-1", worldRevision: "world-1",
    game: gamePack, mounts: [{ schemaVersion: 1, mountId: "mount-1", layout: { kind: "city-layout", id: "layout-1", version: "1", digest: "world-1" },
      game: { kind: "city-minigame", id: gamePack.id, version: "1", digest }, entryAnchorId: "spawn", bindings: { gates: ["gate-1"] }, parameterOverrides: {} }],
    cityId: "city-fixture", cityRevision: 1 };
  db.prepare("INSERT INTO creator_releases VALUES (?,?,?,?,?,?,?,?)").run("release-fixture", "project-release", 1, "layout-1", "world-1",
    JSON.stringify(snapshot), `sha256:${"c".repeat(64)}`, 1);
  const layout = { schemaVersion: 3, cityId: "city-fixture", cityRevision: 1, worldRevision: "world-1", seed: 42,
    layout: { schemaVersion: 1, id: "layout-1", coordinateSystem: "city-local-m-v1",
      anchors: [{ id: "spawn", kind: "spawn", capabilities: ["fly"], geometryRef: "g:spawn" },
        { id: "gate-1", kind: "zone", capabilities: ["fly"], geometryRef: "g:gate-1" }], links: [] },
    ...(withGeometry ? { geometry: [
      { geometryRef: "g:spawn", positionMeters: { x: 0, y: 40, z: 0 } },
      { geometryRef: "g:gate-1", positionMeters: { x: 60, y: 40, z: 0 }, activationRadiusMeters: 20 },
    ] } : {}) };
  db.prepare("INSERT INTO creator_city_layouts_v2 VALUES (?,?,?,?,?,?,?)").run("city-fixture", 1, "world-1", "layout-1",
    JSON.stringify(layout), `sha256:${"d".repeat(64)}`, 1);
  db.close();
  return dataHome;
}

test("release mode opens the frozen vehicle and pack, resolving gates from layout geometry", async () => {
  const dataHome = fixtureStore({ withGeometry: true });
  const client = connect();
  try {
    const opened = await client.call("game_open", { releaseId: "release-fixture", dataHome });
    assert.equal(opened.isError, false, JSON.stringify(opened));
    assert.equal(opened.gameType, "flight");
    assert.equal(opened.vehicle, "vehicle-release");
    assert.equal(opened.release.gateSource, "layout-geometry");
    assert.deepEqual(opened.release.boundAnchors, [{ mountId: "mount-1", slot: "gates", anchorIds: ["gate-1"] }]);
    assert.equal(opened.gates.total, 1);
    let state = opened;
    for (let index = 0; index < 40 && state.phase === "running"; index += 1) {
      state = await client.call("game_step", { sessionId: opened.sessionId, ticks: 6, input: { throttleUp: true } });
    }
    assert.equal(state.outcome, "success");
    assert.equal(state.gates.passed, 1);
  } finally { client.close(); rmSync(dataHome, { recursive: true, force: true }); }
});

test("a release whose layout snapshot has no geometry is refused, not guessed", async () => {
  const dataHome = fixtureStore({ withGeometry: false });
  const client = connect();
  try {
    const opened = await client.call("game_open", { releaseId: "release-fixture", dataHome });
    assert.equal(opened.isError, true);
    assert.match(opened.error, /gates_required/);
    // 如实告诉 Agent 绑定了哪些锚点，它才能自己给坐标。
    assert.deepEqual(opened.boundAnchors, [{ mountId: "mount-1", slot: "gates", anchorIds: ["gate-1"] }]);
    assert.ok(opened.warnings.includes("gate_geometry_not_serialized"));
    // 显式给门就能跑（大门放在出生航线上）。
    const manual = await client.call("game_open", { releaseId: "release-fixture", dataHome, gates: [{ x: 60, y: 40, z: 0, radius: 20 }] });
    assert.equal(manual.isError, false, JSON.stringify(manual));
    assert.equal(manual.release.gateSource, "caller");
  } finally { client.close(); rmSync(dataHome, { recursive: true, force: true }); }
});

test("a gate whose City geometry has no measured radius gets the documented default, flagged", async () => {
  // 空域门复用路网节点 → 几何没有半径。这里断言：不失败、用与 City 试玩同一份默认值、
  // 并在 gate 上标注 radiusDefaulted + warning，调用方不会把它当测量值。
  const dataHome = fixtureStore({ withGeometry: true });
  // 把车间的半径去掉，模拟 road-node 几何。
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(dataHome, "state", "creator", "projects.sqlite"));
  const row = db.prepare("SELECT snapshot_json FROM creator_city_layouts_v2").get();
  const snapshot = JSON.parse(row.snapshot_json);
  snapshot.geometry = snapshot.geometry.map(entry => entry.geometryRef === "g:gate-1" ? { geometryRef: entry.geometryRef, positionMeters: entry.positionMeters } : entry);
  db.prepare("UPDATE creator_city_layouts_v2 SET snapshot_json=?").run(JSON.stringify(snapshot));
  db.close();
  const client = connect();
  try {
    const opened = await client.call("game_open", { releaseId: "release-fixture", dataHome });
    assert.equal(opened.isError, false, JSON.stringify(opened));
    assert.ok(opened.release.warnings.includes("gate_radius_defaulted"));
    // 走到门附近仍然能触发（默认 12 m 触发球覆盖出生航线）。
    let state = await client.call("game_step", { sessionId: opened.sessionId, ticks: 6, input: { throttleUp: true } });
    for (let index = 0; index < 40 && state.phase === "running"; index += 1) {
      state = await client.call("game_step", { sessionId: opened.sessionId, ticks: 6, input: { throttleUp: true } });
    }
    assert.equal(state.outcome, "success");
  } finally { client.close(); rmSync(dataHome, { recursive: true, force: true }); }
});

test("release integrity failures are reported instead of opening a different game", async () => {
  const client = connect();
  try {
    const missing = await client.call("game_open", { releaseId: "release-missing", dataHome: tmpdir() });
    assert.equal(missing.isError, true);
    assert.match(missing.error, /creator_store_unavailable|release_not_found/);
  } finally { client.close(); }
});

// ── 体验包模式（city-experience）：干净客户端只拿一个目录就能启动 ───────────────
// 这里用合成包钉住形状：release.json（冻结快照）+ layout.json（v3，带锚点几何）。
// 真实打包/安装流程见 scripts/build-experience-package.mjs 与
// scripts/verify-experience-package.mjs；本测试只负责「服务器怎么读包、怎么拒坏包」。
import { readFileSync, writeFileSync } from "node:fs";

const digest = value => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function experienceFixture() {
  const dir = mkdtempSync(join(tmpdir(), "mcp-experience-"));
  mkdirSync(join(dir, "assets"), { recursive: true });
  const game = { schemaVersion: 1, id: "creator.experience-test", rulesVersion: 1,
    slots: { gates: { kind: "zone", min: 1, max: 3, requires: ["fly"] } },
    rules: { counters: { next: { initial: 0, max: 3 } }, nodes: [
      { id: "pass", on: { type: "zone.entered", slot: "gates" }, actions: [{ op: "counter.add", counter: "next", amount: 1 }] },
      { id: "finish", on: { type: "zone.entered", slot: "gates" }, when: [{ op: "counter.eq", counter: "next", value: 3 }], actions: [{ op: "run.finish", outcome: "success" }] } ] } };
  const gameDigest = digest(canonicalJson(game));
  const layout = { schemaVersion: 3, cityId: "city-exp", cityRevision: 1, worldRevision: "world-exp", seed: 7,
    layout: { schemaVersion: 1, id: "layout-exp", coordinateSystem: "city-local-m-v1",
      anchors: [{ id: "spawn-air", kind: "spawn", capabilities: ["fly"], geometryRef: "creator-air:spawn" },
        { id: "air-gate:1", kind: "zone", capabilities: ["fly"], geometryRef: "creator-air:g1" },
        { id: "air-gate:2", kind: "zone", capabilities: ["fly"], geometryRef: "creator-air:g2" },
        { id: "air-gate:3", kind: "zone", capabilities: ["fly"], geometryRef: "creator-air:g3" }],
      links: [{ id: "l1", fromAnchorId: "spawn-air", toAnchorId: "air-gate:1", capabilities: ["fly"] },
        { id: "l2", fromAnchorId: "spawn-air", toAnchorId: "air-gate:2", capabilities: ["fly"] },
        { id: "l3", fromAnchorId: "spawn-air", toAnchorId: "air-gate:3", capabilities: ["fly"] }] },
    geometry: [{ geometryRef: "creator-air:spawn", positionMeters: { x: 0, y: 40, z: 0 } },
      { geometryRef: "creator-air:g1", positionMeters: { x: 150, y: 40, z: 0 }, activationRadiusMeters: 20 },
      { geometryRef: "creator-air:g2", positionMeters: { x: 300, y: 40, z: 0 }, activationRadiusMeters: 20 },
      { geometryRef: "creator-air:g3", positionMeters: { x: 450, y: 40, z: 0 }, activationRadiusMeters: 20 }] };
  const release = { projectId: "project-exp", revision: 1, title: "Experience", gameType: "flight", vehicleId: "vehicle-exp",
    vehicle: { schemaVersion: 1, id: "vehicle-exp", label: "Exp flier", modelAssetId: null, flightModel: "fixed-wing",
      physics: { massKg: 620, wingAreaM2: 16, thrustN: 9000, maxSpeedMps: 130, dragCoefficient: 0.06, turnRateRps: 1.05, climbRateMps: 26, sinkRateMps: 20 },
      bounds: { halfLengthM: 4.5, halfWidthM: 5.5, halfHeightM: 1.5 }, camera: { followDistanceM: 35.75, heightOffsetM: 14.3, fovDeg: 55 } },
    skinId: "miami-vice", game, scene: { schemaVersion: 1, objects: [] }, assets: { schemaVersion: 1, entries: [] }, assetRefs: [],
    layoutId: "layout-exp", worldRevision: "world-exp", cityId: "city-exp", cityRevision: 1, cityLayoutId: "layout-exp",
    mounts: [{ schemaVersion: 1, mountId: "mount-exp", layout: { kind: "city-layout", id: "layout-exp", version: "1", digest: "world-exp" },
      game: { kind: "city-minigame", id: game.id, version: "1", digest: gameDigest },
      entryAnchorId: "spawn-air", bindings: { gates: ["air-gate:1", "air-gate:2", "air-gate:3"] }, parameterOverrides: {} }] };
  const files = [];
  const write = (name, value) => { const bytes = Buffer.from(JSON.stringify(value)); writeFileSync(join(dir, name), bytes); files.push({ path: name, digest: digest(bytes), byteLength: bytes.length }); return bytes; };
  write("release.json", release);
  write("layout.json", layout);
  const manifest = { schemaVersion: 1, kind: "city-experience", experienceId: "experience-test", version: "1.0.0",
    world: { cityId: "city-exp", cityRevision: 1, seed: 7, profile: "egypt-desert", worldRevision: "world-exp", layoutId: "layout-exp", layoutRevision: "layout-exp" },
    release: { releaseId: "release-exp", projectId: "project-exp", revision: 1, gameType: "flight", vehicleId: "vehicle-exp" },
    assets: [], files: files.slice() };
  manifest.contentDigest = digest(canonicalJson(manifest));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  return { dir, manifest, release, layout, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("game_open launches a self-contained experience package without a Creator store", async () => {
  const fixture = experienceFixture();
  const mcp = connect();
  try {
    const opened = await mcp.call("game_open", { experience: fixture.dir });
    assert.equal(opened.isError, false, JSON.stringify(opened.error));
    assert.equal(opened.gates.total, 3);
    assert.equal(opened.release.gateSource, "layout-geometry");
    assert.deepEqual(opened.release.warnings, []);
    const ran = await mcp.call("game_script", { sessionId: opened.sessionId, script: [{ ticks: 400, input: { throttleUp: true } }] });
    assert.equal(ran.outcome, "success");
    assert.equal(ran.gates.passed, 3);
  } finally { mcp.close(); fixture.cleanup(); }
});

test("a tampered or incomplete experience package is rejected before it can run", async () => {
  // 1) 字节被改：摘要必须发现（不是"重新算一遍摘要就算对"）。
  {
    const fixture = experienceFixture();
    const mcp = connect();
    try {
      writeFileSync(join(fixture.dir, "layout.json"), readFileSync(join(fixture.dir, "layout.json")).subarray(0, -2));
      const opened = await mcp.call("game_open", { experience: fixture.dir });
      assert.equal(opened.isError, true);
      assert.equal(opened.error, "experience_file_digest_mismatch");
    } finally { mcp.close(); fixture.cleanup(); }
  }
  // 2) metadata 被改而 contentDigest 未重算：contentDigest 覆盖 manifest 全文。
  {
    const fixture = experienceFixture();
    const mcp = connect();
    try {
      const manifest = { ...fixture.manifest, version: "9.9.9" };
      writeFileSync(join(fixture.dir, "manifest.json"), JSON.stringify(manifest));
      const opened = await mcp.call("game_open", { experience: fixture.dir });
      assert.equal(opened.error, "experience_digest_mismatch");
    } finally { mcp.close(); fixture.cleanup(); }
  }
  // 3) 布局是 v2（没有锚点几何）：包在干净客户端上无法定位门，必须拒绝而不是跑一局没有门的游戏。
  {
    const fixture = experienceFixture();
    const mcp = connect();
    try {
      const v2 = { ...fixture.layout, schemaVersion: 2 };
      delete v2.geometry;
      const bytes = Buffer.from(JSON.stringify(v2));
      writeFileSync(join(fixture.dir, "layout.json"), bytes);
      const manifest = { ...fixture.manifest,
        files: fixture.manifest.files.map(file => file.path === "layout.json"
          ? { ...file, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, byteLength: bytes.length } : file) };
      const { contentDigest: _ignored, ...rest } = manifest;
      manifest.contentDigest = `sha256:${createHash("sha256").update(canonicalJson(rest)).digest("hex")}`;
      writeFileSync(join(fixture.dir, "manifest.json"), JSON.stringify(manifest));
      const opened = await mcp.call("game_open", { experience: fixture.dir });
      assert.equal(opened.error, "experience_layout_incomplete");
    } finally { mcp.close(); fixture.cleanup(); }
  }
});
