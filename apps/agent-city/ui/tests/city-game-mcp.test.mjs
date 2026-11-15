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
