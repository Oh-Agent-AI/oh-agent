#!/usr/bin/env node
// Generic, headless game-control MCP for the City runtime. No network, no UI, no
// Three.js: an Agent opens a session, feeds inputs, and reads back state, events and a
// deterministic trace. Flight and driving share ONE vocabulary so the same test script
// can exercise either game type.
//
// 设计约束（沿用 mecha-combat MCP 的惯例）：
// - 只读 + 进程内会话：不写盘、不留存、不联网；
// - 固定步长（默认 1/60 s），同参数同轨迹，trace 带 fnv1a 摘要供 Agent 比对；
// - 规则判定复用 `MountedMiniGameControllerV1`（与 UI 内试玩同一份 SDK runner），
//   这里不重新解释 creator pack；
// - 输入/坐标一律用**米**（与 creator pack、锚点几何同一量纲），内部换算成世界单位。
import readline from "node:readline";
import { FIXED_WING_VEHICLE_PRESET_V1, ORNITHOPTER_VEHICLE_PRESET_V1, validateVehicleProfileV1 } from "../../../packages/agent-vitals-city-sdk/src/vehicleProfile.ts";
import { initialSimState, stepFlight, vehicleFlightParams } from "../ui/src/game/FlightSimulation.ts";
import { initialDrivingState, stepDriving } from "../ui/src/game/DrivingSimulation.ts";
import { createMountedMiniGamePlan, MountedMiniGameControllerV1 } from "../ui/src/game/activity/mountedMiniGame.ts";
import { EMPTY_INPUT } from "../ui/src/game/types.ts";
import { m as worldUnits, toMeters } from "../ui/src/engine/worldScale.ts";
import { resolveRelease } from "./releaseStore.mjs";
import { resolveExperience } from "./experienceStore.mjs";

const PROTOCOL = "2024-11-05";
const DT_SECONDS = 1 / 60;
const MAX_TICK_BUDGET = 36_000;
const MAX_STEP_TICKS = 600;
const MAX_TRACE_SAMPLES = 512;
const TRACE_EVERY_TICKS = 6;

/** 会话表：进程内生命周期，没有任何持久化。 */
const sessions = new Map();
let nextSession = 0;

const ok = text => ({ content: [{ type: "text", text: JSON.stringify(text) }] });
const fail = (message, extra = {}) => ({ isError: true, content: [{ type: "text", text: JSON.stringify({ error: message, ...extra }) }] });

const PRESETS = Object.freeze({ ornithopter: ORNITHOPTER_VEHICLE_PRESET_V1, "fixed-wing": FIXED_WING_VEHICLE_PRESET_V1 });

/** 通用输入词表：油门/刹车/左右转向为两套载具共有，俯仰只对飞行有效。
 *  同时接受 flight（throttleUp…）与 driving（forward…）两套别名，避免 Agent 记两套 schema。 */
function normalizeInput(raw) {
  const value = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const flag = key => value[key] === true;
  return {
    throttleUp: flag("throttleUp") || flag("forward"),
    throttleDown: flag("throttleDown") || flag("backward"),
    turnLeft: flag("turnLeft") || flag("left"),
    turnRight: flag("turnRight") || flag("right"),
    pitchUp: flag("pitchUp"),
    pitchDown: flag("pitchDown"),
  };
}

const toFlightInput = input => ({ ...EMPTY_INPUT, throttleUp: input.throttleUp, throttleDown: input.throttleDown,
  turnLeft: input.turnLeft, turnRight: input.turnRight, pitchUp: input.pitchUp, pitchDown: input.pitchDown });
const toDrivingInput = input => ({ forward: input.throttleUp, backward: input.throttleDown, left: input.turnLeft, right: input.turnRight });

/** 无碰撞平面：MCP 里没有城市障碍内容，驾驶门测试只关心规则与运动学。
 *  返回结构按 stepDriving 的 `DrivingEnvironment` 契约（含 blocked/contact/pitch/roll）。 */
const FREE_PLANE = Object.freeze({
  move: (previous, desired) => ({ x: desired.x, y: 0, z: desired.z, heading: desired.heading, pitch: 0, roll: 0, surfaceId: "pad",
    blocked: false, contact: false, travelledDistance: Math.hypot(desired.x - previous.x, desired.z - previous.z), speedFraction: 1 }),
});

/** 无依赖的确定性摘要：同一份 trace → 同一个 hex（Agent 用它判断两次运行是否逐位一致）。 */
function traceDigest(samples) {
  let hash = 0xcbf29ce484222325n;
  const text = samples.map(sample => [sample.tick, sample.x.toFixed(4), sample.y.toFixed(4), sample.z.toFixed(4),
    sample.speed.toFixed(4), sample.heading.toFixed(4)].join(",")).join(";");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

function clampInteger(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

function finite(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function sessionOf(args) {
  const session = sessions.get(args?.sessionId);
  if (!session) throw new Error("session_not_found");
  return session;
}

/** 用显式门（米）合成一个可信布局视图，走与 UI 相同的 mount/plan 校验路径：
 *  这里不发明第二套规则装配，只是把 Agent 给的门摆进一个沙箱布局。 */
function buildRules(session, gates, capability, slotsHint) {
  const pack = session.pack;
  const slotNames = Object.keys(pack.slots).filter(name => pack.slots[name]?.kind === "zone");
  if (!slotNames.length) throw new Error("pack_has_no_zone_slots");
  const bindings = slotsHint && typeof slotsHint === "object" && !Array.isArray(slotsHint)
    ? Object.fromEntries(slotNames.map(name => [name, [...(slotsHint[name] ?? [])]]))
    : (slotNames.length === 1 ? { [slotNames[0]]: gates.map((_gate, index) => index) } : null);
  if (!bindings) throw new Error("bindings_required");
  const anchorIds = gates.map((_gate, index) => `gate-${index}`);
  const anchors = [{ id: "spawn", kind: "spawn", capabilities: [capability], geometryRef: "g:spawn" },
    ...anchorIds.map((id, index) => ({ id, kind: "zone", capabilities: [capability], geometryRef: `g:${id}` }))];
  const links = anchorIds.map((id, index) => ({ id: `link-${index}`, fromAnchorId: "spawn", toAnchorId: id, capabilities: [capability] }));
  const geometry = new Map([["g:spawn", { positionMeters: { x: 0, y: 0, z: 0 } }],
    ...gates.map((gate, index) => [`g:${anchorIds[index]}`, { positionMeters: { x: gate.x, y: gate.y, z: gate.z }, activationRadiusMeters: gate.radius }])]);
  const view = { layout: { schemaVersion: 1, id: "mcp-sandbox", coordinateSystem: "city-local-m-v1", anchors, links },
    geometry, roadSegments: [], preferredStartMeters: { x: 0, z: 0 }, seed: session.seed, worldRevision: "mcp-sandbox" };
  const mount = { schemaVersion: 1, mountId: "mcp-sandbox", layout: { kind: "city-layout", id: "mcp-sandbox", version: "1", digest: "mcp-sandbox" },
    game: { kind: "city-minigame", id: pack.id, version: "1", digest: "mcp-sandbox" }, entryAnchorId: "spawn",
    bindings: Object.fromEntries(slotNames.map(name => [name, bindings[name].map(index => `gate-${index}`)])), parameterOverrides: {} };
  const plan = createMountedMiniGamePlan({ view, packageJson: JSON.stringify(pack), mount, gameRef: mount.game, seed: session.seed, capability });
  if (!plan.ok) throw new Error(plan.diagnostics[0]?.code ?? "mini_game_plan_invalid");
  return new MountedMiniGameControllerV1(plan.value, () => {});
}

function poseOf(session) {
  const state = session.state;
  return { x: toMeters(state.x), y: toMeters(state.y), z: toMeters(state.z), heading: state.heading,
    speed: session.gameType === "flight" ? toMeters(state.speed) : state.speed };
}

function summary(session) {
  const snapshot = session.controller?.snapshot ?? null;
  return {
    sessionId: session.id, gameType: session.gameType, tick: session.tick, phase: session.phase,
    ...(session.release ? { release: session.release } : {}),
    vehicle: session.vehicleId, seed: session.seed, dtSeconds: DT_SECONDS, pose: poseOf(session),
    outcome: snapshot?.state?.outcome ?? null,
    counters: snapshot ? { ...snapshot.state.counters } : null,
    // passed 与 UI 里 Creator 试玩同一口径：计数器之和（不是另算一遍门数）。
    gates: snapshot ? { passed: session.gatesPassed, total: session.gatesTotal } : null,
    reason: snapshot?.reason ?? session.reason ?? null,
    traceSamples: session.trace.length,
  };
}

/** 走一步固定步长并把新机位喂给共享规则 runner（顺序与 GameSession.updateFixed 一致）。 */
function advance(session, input) {
  if (session.phase !== "running") return;
  if (session.tick >= session.maxTicks) { session.phase = "finished"; session.reason = session.reason ?? "tick_budget_exhausted"; return; }
  if (session.gameType === "flight") {
    session.state = stepFlight(session.state, toFlightInput(input), DT_SECONDS, session.params);
  } else {
    session.state = stepDriving(session.state, toDrivingInput(input), FREE_PLANE);
  }
  session.tick += 1;
  if (session.controller) {
    const pose = poseOf(session);
    session.controller.fixedStep({ x: pose.x, y: pose.y, z: pose.z });
    const status = session.controller.snapshot.status;
    if (status === "success" || status === "failure" || status === "error") {
      session.phase = "finished";
      session.reason = session.controller.snapshot.reason;
    }
    session.gatesPassed = Object.values(session.controller.snapshot.state.counters).reduce((sum, value) => sum + value, 0);
  }
  if (session.tick % TRACE_EVERY_TICKS === 0 && session.trace.length < MAX_TRACE_SAMPLES) {
    session.trace.push({ tick: session.tick, ...poseOf(session) });
  }
}

const tools = [
  { name: "game_types", description: "List the game types this server can drive headlessly and the shared input vocabulary.",
    inputSchema: { type: "object", properties: {} } },
  { name: "game_open", description: "Open one headless game session from a game type, an optional vehicle profile/preset and an optional creator pack with explicit gates. Coordinates are metres. Pass `experience` to launch a self-contained experience package instead of reading a Creator store.",
    inputSchema: { type: "object", properties: {
      gameType: { type: "string", enum: ["flight", "driving"], description: "required unless releaseId is given (the release freezes it)" },
      releaseId: { type: "string", description: "read a published release: vehicle, pack and gates come from the frozen snapshot" },
      experience: { type: "string", description: "city-experience package directory: self-contained release + v3 layout + assets, verified byte-for-byte; no Creator store needed (clean client)" },
      experienceId: { type: "string", description: "installed experience id: resolved to <dataHome>/state/creator/content/experience/<id>/<version>" },
      experienceVersion: { type: "string", description: "installed experience version (required with experienceId)" },
      dataHome: { type: "string", description: "Creator store home (default $AV_DATA_HOME or ~/.agent-vitals)" },
      vehicle: { description: "flight only: preset id or a full VehicleProfileV1", oneOf: [{ type: "string", enum: ["ornithopter", "fixed-wing"] }, { type: "object" }] },
      pack: { type: "object", description: "optional creator mini-game pack (same JSON as the Studio game editor)" },
      gates: { type: "array", maxItems: 64, items: { type: "object", required: ["x", "z"], properties: {
        x: { type: "number" }, y: { type: "number" }, z: { type: "number" }, radius: { type: "number", description: "trigger radius in metres (default 8)" } } } },
      bindings: { type: "object", description: "slotName -> gate indexes; required when the pack has more than one zone slot" },
      spawn: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" }, heading: { type: "number" } } },
      seed: { type: "number" }, maxTicks: { type: "number", description: "hard budget, default 3600 (60 s)" },
    } } },
  { name: "game_step", description: "Advance N fixed ticks (default 1) holding one input; returns state, counters and the gate count.",
    inputSchema: { type: "object", required: ["sessionId"], properties: { sessionId: { type: "string" },
      ticks: { type: "number", description: "1..600, default 1" }, input: { type: "object", description: "throttleUp|throttleDown|turnLeft|turnRight|pitchUp|pitchDown (forward|backward|left|right accepted as aliases)" } } } },
  { name: "game_script", description: "Run a whole input script in one call and return the final state plus the deterministic trace digest.",
    inputSchema: { type: "object", required: ["sessionId", "script"], properties: { sessionId: { type: "string" },
      script: { type: "array", maxItems: 512, items: { type: "object", required: ["ticks"], properties: { ticks: { type: "number" }, input: { type: "object" } } } } } } },
  { name: "game_state", description: "Read the current authoritative state of a session.", inputSchema: { type: "object", required: ["sessionId"], properties: { sessionId: { type: "string" } } } },
  { name: "game_trace", description: "Read the sampled trace (10 Hz, bounded) and its digest; two runs with identical inputs must match.",
    inputSchema: { type: "object", required: ["sessionId"], properties: { sessionId: { type: "string" } } } },
  { name: "game_close", description: "Close a session and release its runner.", inputSchema: { type: "object", required: ["sessionId"], properties: { sessionId: { type: "string" } } } },
];

/** release 模式：载具与 pack 来自发布快照（只读），门来自布局快照里的 geometry。
 *  快照没有 geometry（v1/v2 的历史数据）时**不猜位置**，要求调用方显式给 gates。 */
function resolveReleaseArgs(args) {
  // 已安装的体验包：Agent 只拿 id+version（不暴露路径），按客户端的固定布局解析。
  const experienceDir = typeof args.experience === "string" && args.experience ? args.experience
    : typeof args.experienceId === "string" && typeof args.experienceVersion === "string"
      ? `${(typeof args.dataHome === "string" && args.dataHome ? args.dataHome : process.env.AV_DATA_HOME || `${process.env.HOME}/.agent-vitals`)}/state/creator/content/experience/${args.experienceId}/${args.experienceVersion}`
      : null;
  const release = experienceDir
    ? resolveExperience({ dir: experienceDir })
    : resolveRelease({ dataHome: (typeof args.dataHome === "string" && args.dataHome ? args.dataHome
      : process.env.AV_DATA_HOME || `${process.env.HOME}/.agent-vitals`), releaseId: args.releaseId });
  if (args.gameType !== undefined && args.gameType !== release.gameType) throw new Error("release_game_type_mismatch");
  if (!release.gates && !Array.isArray(args.gates)) {
    // 把绑定了哪些锚点如实回给 Agent：它需要自己给出这些门的世界坐标（米）。
    throw Object.assign(new Error("gates_required"), { detail: { boundAnchors: release.boundAnchors, warnings: release.warnings,
      hint: "the release layout snapshot has no gate geometry; pass `gates` in metres (bound anchors listed in boundAnchors)" } });
  }
  return { release, gameType: release.gameType, vehicle: args.vehicle ?? release.vehicle ?? null,
    pack: args.pack ?? release.game, gates: Array.isArray(args.gates) ? args.gates : release.gates };
}

function open(args) {
  const fromRelease = typeof args.releaseId === "string" || typeof args.experience === "string" || typeof args.experienceId === "string" ? resolveReleaseArgs(args) : null;
  const gameType = fromRelease ? fromRelease.gameType
    : args.gameType === "driving" ? "driving" : args.gameType === "flight" ? "flight" : null;
  if (!gameType) throw new Error("game_type_invalid");
  const vehicleInput = fromRelease ? fromRelease.vehicle : args.vehicle;
  const packInput = fromRelease ? fromRelease.pack : args.pack;
  const gatesInput = fromRelease ? fromRelease.gates : args.gates;
  const seed = clampInteger(args.seed ?? 7, 0, 2 ** 31 - 1);
  const session = { id: `game-${++nextSession}`, gameType, seed, tick: 0, phase: "running", reason: null,
    trace: [], maxTicks: clampInteger(args.maxTicks ?? 3600, 1, MAX_TICK_BUDGET), controller: null,
    gatesPassed: 0, gatesTotal: 0, pack: null, params: null, vehicleId: null, state: null };
  if (fromRelease) {
    session.release = { releaseId: fromRelease.release.releaseId, projectId: fromRelease.release.projectId,
      ...(fromRelease.release.experienceId ? { experienceId: fromRelease.release.experienceId, experienceVersion: fromRelease.release.version,
        contentDigest: fromRelease.release.contentDigest } : {}),
      revision: fromRelease.release.revision, gameType: fromRelease.release.gameType,
      gateSource: Array.isArray(args.gates) ? "caller" : fromRelease.release.gateSource,
      boundAnchors: fromRelease.release.boundAnchors, warnings: fromRelease.release.warnings };
  }
  if (gameType === "flight") {
    let profile = vehicleInput ?? "fixed-wing";
    if (typeof profile === "string") {
      const preset = PRESETS[profile];
      if (!preset) throw new Error("vehicle_preset_unknown");
      profile = preset;
    }
    const checked = validateVehicleProfileV1(profile);
    if (!checked.ok) throw new Error(checked.diagnostics[0]?.code ?? "vehicle_profile_invalid");
    session.vehicleId = checked.value.id;
    session.params = vehicleFlightParams(checked.value);
    const spawn = args.spawn ?? {};
    // 默认停在 40 m 巡航高度上，避免出生在地面/楼里；Agent 可以显式覆盖。
    const spawnY = finite(spawn.y, 40);
    session.state = initialSimState({ x: worldUnits(finite(spawn.x, 0)), y: worldUnits(spawnY), z: worldUnits(finite(spawn.z, 0)),
      heading: finite(spawn.heading, 0) }, session.params);
  } else {
    const spawn = args.spawn ?? {};
    session.state = initialDrivingState(worldUnits(finite(spawn.x, 0)), worldUnits(finite(spawn.z, 0)), finite(spawn.heading, 0));
  }
  if (packInput) {
    session.pack = packInput;
    const gates = (Array.isArray(gatesInput) ? gatesInput : []).map(gate => ({ x: finite(gate?.x, 0), y: finite(gate?.y, 0),
      z: finite(gate?.z, 0), radius: Math.max(0.5, finite(gate?.radius, 8)) }));
    if (!gates.length) throw new Error("gates_required");
    session.controller = buildRules(session, gates, gameType === "flight" ? "fly" : "drive", args.bindings);
    session.gatesTotal = gates.length;
  }
  sessions.set(session.id, session);
  return summary(session);
}

function step(args) {
  const session = sessionOf(args);
  const ticks = clampInteger(args.ticks ?? 1, 1, MAX_STEP_TICKS);
  const input = normalizeInput(args.input);
  for (let index = 0; index < ticks && session.phase === "running"; index += 1) advance(session, input);
  return summary(session);
}

function script(args) {
  const session = sessionOf(args);
  const entries = Array.isArray(args.script) ? args.script : [];
  let executed = 0;
  for (const entry of entries) {
    if (session.phase !== "running") break;
    const ticks = clampInteger(entry?.ticks ?? 0, 0, MAX_STEP_TICKS);
    const input = normalizeInput(entry?.input);
    for (let index = 0; index < ticks && session.phase === "running"; index += 1) { advance(session, input); executed += 1; }
  }
  return { ...summary(session), executedTicks: executed, traceDigest: traceDigest(session.trace) };
}

function callTool(name, args = {}) {
  if (name === "game_types") return ok({ types: [
    { gameType: "flight", vehicles: Object.keys(PRESETS), note: "vehicle profiles are validated against VehicleProfileV1; physics is the same `vehicleFlightParams` the UI uses" },
    { gameType: "driving", vehicles: [], note: "fixed arcade bicycle model; free-plane collision (no city obstacles)" },
  ], input: { keys: ["throttleUp", "throttleDown", "turnLeft", "turnRight", "pitchUp", "pitchDown"],
    aliases: { forward: "throttleUp", backward: "throttleDown", left: "turnLeft", right: "turnRight" } },
    coordinates: "metres; the trace and pose report metres, speed in m/s (flight) or units/s (driving)",
    determinism: "fixed 1/60 s step; identical session arguments + identical script ⇒ identical traceDigest" });
  if (name === "game_open") return ok(open(args));
  if (name === "game_step") return ok(step(args));
  if (name === "game_script") return ok(script(args));
  if (name === "game_state") return ok(summary(sessionOf(args)));
  if (name === "game_trace") { const session = sessionOf(args); return ok({ sessionId: session.id, trace: session.trace, traceDigest: traceDigest(session.trace) }); }
  if (name === "game_close") { const session = sessionOf(args); session.controller?.stop(); sessions.delete(session.id); return ok({ closed: true, sessionId: session.id }); }
  throw new Error("unknown_tool");
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined) return; // notifications
  let response;
  try {
    if (message.method === "initialize") response = { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "city-game-control", version: "1.0.0" } };
    else if (message.method === "ping") response = {};
    else if (message.method === "tools/list") response = { tools };
    // 工具执行错误走 MCP 的 isError 结果（Agent 能读到原因），不用 JSON-RPC error——
    // 后者在客户端里和协议故障混在一起，测试脚本会分不清"参数不对"和"服务器坏了"。
    else if (message.method === "tools/call") {
      try { response = callTool(message.params?.name, message.params?.arguments ?? {}); }
      catch (error) { response = fail(error.message, error.detail ?? {}); }
    }
    else throw Object.assign(new Error("method_not_found"), { code: -32601 });
  } catch (error) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: error.code ?? -32603, message: error.message } }) + "\n");
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: response }) + "\n");
});
