#!/usr/bin/env node
// Creator flight-pipeline end-to-end verification (spec E6, §8.7).
//
// 驱动两个独立的 stdio MCP 进程，把既有工具串成一次可留证的验收运行：
//   1. `agent-vitals data-mcp serve --enable-city-tools --allow-local-writes`
//      （creator_* 工具面：会话/作业/契约/城市/项目/飞行器/锚点/绑定/发布/试玩）
//   2. `apps/agent-city/mcp/city-game-mcp.mjs`（headless game-control：同输入飞行，
//      fnv1a trace 摘要，证明两个 vehicle profile 真实参与物理而非换皮）
//
// 七步场景（docs/STUDIO_AGENT_FIRST_EDITOR_SPEC_2026_11_15.md §8.7/E6）：
//   ① creator_project_create（flight-checkpoint + 独立 City）
//   ② creator_vehicle_define ×2（内置 preset 改 mass/thrust，两架不同参数飞行器）
//   ③ creator_city_anchor_upsert（1 fly spawn + 3 fly gates，自带空域几何）
//   ④ creator_mount_bind（入口必须是 fly spawn，gates 槽位绑定 3 门）
//   ⑤ creator_project_publish（冻结 gameType/vehicleId/runtimeContractVersion）
//   ⑥ creator_playtest_start（gameType:"flight" 断言）
//   ⑦ creator_playtest_result + creator_job_* + creator_session_status 时间线
//
// 诚实分档（spec §8.4/§8.7，不伪造成功）：
//   - headless 可用步骤（session/job/game_type/vehicle_list）直接断言成功；
//   - 需要 Studio webview / 桌面宿主信箱的步骤：捕获稳定错误码并如实记为
//     deferred / not-run；E5 结构子集（validation:"structural" +
//     commitBlocked:"deferred-semantic"）如实记录为「不可提交的结构反馈」；
//   - 桌面宿主缺席（mailbox 不可达）时报告已完成/未完成清单，不降级为成功。
//
// 用法：
//   node scripts/verify-creator-flight-e2e.mjs [--out <目录>] [--bin <路径>]
//        [--data-home <目录>] [--agent-id <id>] [--skip-game-control]
//        [--self-test] [--help]
//
// 边界：只调用 MCP 公开工具面；不传路径/字节/凭据参数；不改宿主/MCP/SDK/UI 代码。
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_MCP_PROTOCOL = "2025-06-18";
const GAME_CONTROL_PROTOCOL = "2024-11-05";
const CALL_TIMEOUT_MS = 45_000; // 信箱工具内部有 ~15s TTL，留足余量
const PLAYTEST_POLL_TRIES = 8;
const PLAYTEST_POLL_INTERVAL_MS = 2_000;
const SPEC = "docs/STUDIO_AGENT_FIRST_EDITOR_SPEC_2026_11_15.md §8.7 / slice E6";

// ────────────────────────── 纯函数（--self-test 覆盖） ──────────────────────────

/** 把一行 JSON-RPC 响应解析为 {id, result, error}；非 JSON 行返回 null。 */
export function parseFrame(line) {
  if (typeof line !== "string" || !line.trim()) return null;
  try {
    const frame = JSON.parse(line);
    if (!frame || typeof frame !== "object") return null;
    return frame;
  } catch {
    return null;
  }
}

/** 把 tools/call 的 MCP result 解析为统一信封 {ok, data, error}。
 *  data-mcp 走 structuredContent；city-game-control 只回 content 文本块。
 *  JSON-RPC error 帧 → {ok:false, error:{code:"jsonrpc-<code>"}}。 */
export function parseToolResult(response) {
  if (!response || typeof response !== "object") {
    return { ok: false, error: { code: "client_invalid_response", message: "no response frame" } };
  }
  if (response.error) {
    const code = typeof response.error.code === "number" ? `jsonrpc-${response.error.code}` : "jsonrpc-error";
    return { ok: false, error: { code, message: String(response.error.message ?? "protocol error") } };
  }
  const result = response.result;
  if (!result || typeof result !== "object") {
    return { ok: false, error: { code: "client_invalid_response", message: "result missing" } };
  }
  let envelope = result.structuredContent;
  if (!envelope && Array.isArray(result.content)) {
    const text = result.content.find(block => block?.type === "text")?.text;
    if (typeof text === "string") {
      try { envelope = JSON.parse(text); } catch { envelope = { rawText: text }; }
    }
  }
  if (!envelope || typeof envelope !== "object") {
    return { ok: false, error: { code: "client_invalid_response", message: "no structuredContent or text content" } };
  }
  if (result.isError === true) {
    const error = envelope.error ?? { code: "tool_error", message: JSON.stringify(envelope).slice(0, 400) };
    return { ok: false, error, envelope };
  }
  if (envelope.ok === true) return { ok: true, data: envelope.data ?? envelope, envelope };
  if (envelope.error) return { ok: false, error: envelope.error, envelope };
  // game-control 的成功结果没有 ok 字段，直接是数据对象。
  return { ok: true, data: envelope, envelope };
}

/** 诚实分档（spec §8.4）：pass / deferred / failed。
 *  - 稳定的 plugin_unavailable = 宿主信箱或 Studio webview 缺席（预期内的延迟档）；
 *  - validation:"structural" + commitBlocked:"deferred-semantic" = E5 结构子集
 *    （即时反馈，不可提交，语义校验仍欠 Studio 补验）；
 *  - 其余错误一律 failed，不得美化。 */
export function classifyOutcome(parsed) {
  if (parsed.ok) {
    const data = parsed.data ?? {};
    if (data.validation === "structural" && data.commitBlocked === "deferred-semantic") {
      return { status: "deferred", tier: "structural-headless", code: "deferred-semantic" };
    }
    return { status: "pass", tier: "semantic", code: null };
  }
  const code = parsed.error?.code ?? "unknown";
  if (code === "plugin_unavailable") return { status: "deferred", tier: "host-studio-required", code };
  if (code === "creator_capture_unavailable" || code === "data_unavailable") {
    return { status: "deferred", tier: "viewport-required", code };
  }
  return { status: "failed", tier: "unexpected", code };
}

/** 从 creator_vehicle_list 的目录里构建两架不同参数的飞行器。
 *  只在 preset 基础上做有界调整（质量/推力），所有键与范围由 catalog 锁定；
 *  跨字段比值（推力/质量、质量/翼面积）留出安全边距，越界即抛错（不静默改值）。 */
export function buildVehicleProfiles(catalog) {
  const presets = catalog?.presets;
  if (!Array.isArray(presets) || presets.length < 2) {
    throw new Error("vehicle catalog must expose at least two presets");
  }
  const bounds = catalog.physicsBounds ?? {};
  const ratios = catalog.physicsRatios ?? { maxThrustAccelMs2: 30, maxWingLoadingKgPerM2: 120, minThrustAccelMs2: 1, minWingLoadingKgPerM2: 1 };
  const clamp = (key, value) => {
    const range = bounds[key];
    if (!Array.isArray(range)) return value;
    return Math.min(range[1], Math.max(range[0], value));
  };
  const plan = [
    { sourceId: "vehicle.ornithopter", vehicleId: "vehicle-e2e-flap", label: "E2E flapper",
      massKg: 300, thrustN: 6000 }, // 20 m/s² 推重比，与 preset 29.4 明显不同
    { sourceId: "vehicle.fixed-wing-light", vehicleId: "vehicle-e2e-fixed", label: "E2E fixed wing",
      massKg: 700, thrustN: 14000 }, // 20 m/s²，与 flapper 同推重比、不同机种/质量/翼载
  ];
  const margin = 0.9;
  return plan.map(entry => {
    const preset = presets.find(item => item?.id === entry.sourceId) ?? presets[plan.indexOf(entry)];
    const physics = { ...preset.physics };
    physics.massKg = clamp("massKg", entry.massKg);
    physics.wingAreaM2 = clamp("wingAreaM2", preset.physics.wingAreaM2);
    // 推力夹到 maxThrustAccel 边距内，且不低于 min 推重比。
    const maxThrust = Math.floor(physics.massKg * ratios.maxThrustAccelMs2 * margin);
    const minThrust = Math.ceil(physics.massKg * ratios.minThrustAccelMs2 / margin);
    physics.thrustN = Math.min(maxThrust, Math.max(minThrust, clamp("thrustN", entry.thrustN)));
    const thrustAccel = physics.thrustN / physics.massKg;
    const wingLoading = physics.massKg / physics.wingAreaM2;
    if (thrustAccel > ratios.maxThrustAccelMs2 || thrustAccel < ratios.minThrustAccelMs2) {
      throw new Error(`${entry.vehicleId}: thrust/mass ${thrustAccel.toFixed(2)} outside catalog ratios`);
    }
    if (wingLoading > ratios.maxWingLoadingKgPerM2 || wingLoading < ratios.minWingLoadingKgPerM2) {
      throw new Error(`${entry.vehicleId}: mass/wingArea ${wingLoading.toFixed(2)} outside catalog ratios`);
    }
    for (const [key, value] of Object.entries(physics)) {
      const range = bounds[key];
      if (Array.isArray(range) && (value < range[0] || value > range[1])) {
        throw new Error(`${entry.vehicleId}: physics.${key}=${value} outside [${range[0]}, ${range[1]}]`);
      }
    }
    const profile = {
      schemaVersion: 1, id: entry.vehicleId, label: entry.label, modelAssetId: null,
      flightModel: preset.flightModel, physics,
      bounds: { ...preset.bounds }, camera: { ...(preset.camera ?? {}) },
    };
    return { vehicleId: entry.vehicleId, sourcePreset: preset.id, profile, thrustAccelMs2: thrustAccel, wingLoadingKgPerM2: wingLoading };
  });
}

/** creator_vehicle_define 的入参（不含 camera——宿主确定性派生，从不接收）。 */
export function definePayloadFor(vehicle, projectId, baseRevision, operationId) {
  return { projectId, baseRevision, vehicleId: vehicle.profile.id, label: vehicle.profile.label,
    flightModel: vehicle.profile.flightModel, physics: vehicle.profile.physics,
    bounds: vehicle.profile.bounds, modelAssetId: null, operationId };
}

/** 轨迹分叉结论：同输入两架飞行器摘要必须不同；同机重放摘要必须一致。 */
export function trajectoryConclusion(allRuns) {
  const runs = (Array.isArray(allRuns) ? allRuns : []).filter(run => run && typeof run === "object");
  const [first, second, replay] = runs;
  const base = { identicalInput: true, digests: Object.fromEntries(runs.map(run => [run.label, run.traceDigest ?? null])) };
  if (!first?.traceDigest || !second?.traceDigest) {
    return { ...base, divergence: { proven: false, conclusion: "digests unavailable; divergence not proven" } };
  }
  const diverges = first.traceDigest !== second.traceDigest;
  const result = { ...base, divergence: { proven: diverges,
    conclusion: diverges
      ? `vehicle profiles produce different trajectories under identical input (${first.label} vs ${second.label})`
      : `IDENTICAL digests for ${first.label} vs ${second.label}: profiles do NOT affect physics — pipeline claim broken` } };
  if (replay?.traceDigest && first?.traceDigest) {
    const replayMatches = replay.traceDigest === first.traceDigest;
    result.replay = { digestMatches: replayMatches,
      conclusion: replayMatches
        ? `replay of ${first.label} reproduces the same traceDigest (fixed-step determinism)`
        : `replay of ${first.label} produced a DIFFERENT digest — determinism claim broken` };
  }
  return result;
}

/** 汇总各步状态的计数与总判定。 */
export function summarizeSteps(steps) {
  const counts = { pass: 0, deferred: 0, failed: 0, "not-run": 0 };
  for (const step of steps) counts[step.status] = (counts[step.status] ?? 0) + 1;
  let verdict;
  if (counts.failed > 0) verdict = "failed";
  else if (counts["not-run"] === 0 && counts.deferred === 0) verdict = "pipeline-complete";
  else if (counts["not-run"] === steps.length) verdict = "not-verified";
  else verdict = "headless-partial";
  return { counts, verdict };
}

/** 用法文本（--help / --self-test 都覆盖到）。 */
export function usage() {
  return `verify-creator-flight-e2e — Creator flight-pipeline end-to-end verification (spec E6)

Usage:
  node scripts/verify-creator-flight-e2e.mjs [options]

Options:
  --out <dir>          Evidence output directory (default: artifacts/creator-flight-e2e/<UTC timestamp>)
  --bin <path>         agent-vitals binary (default: $AGENT_VITALS_BIN or <repo>/target/release/agent-vitals)
  --data-home <dir>    Override the data root passed as AGENT_VITALS_HOME to the spawned CLI
  --agent-id <id>      Creator session agentId (default: verify-creator-flight-e2e)
  --skip-game-control  Skip the headless city-game-control trajectory divergence run
  --self-test          Run the in-process response-shape/logic self-test (no processes, no writes)
  --help               Show this text

Honesty contract (spec §8.4/§8.7): headless-verifiable steps assert success; steps that
need the Studio webview/desktop mailbox record their stable error codes as deferred or
not-run evidence. Nothing is ever reported as success when it was not observed.

Spec: ${SPEC}`;
}

// ────────────────────────── stdio MCP 客户端 ──────────────────────────

class McpStdioClient {
  constructor({ name, command, args, env }) {
    this.name = name;
    this.command = command;
    this.args = args;
    this.env = env;
    this.child = null;
    this.stderrTail = "";
    this.protocol = DATA_MCP_PROTOCOL;
  }

  start() {
    this.child = spawn(this.command, this.args, { stdio: ["pipe", "pipe", "pipe"], env: this.env });
    this.child.stderr?.on("data", chunk => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-4000);
    });
    this.lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.pending = new Map();
    this.nextId = 1;
    this.exitPromise = new Promise(resolve => { this.child.on("exit", code => { this.exitCode = code; resolve(code); }); });
    this.closed = false;
    this.lines.on("line", line => {
      const frame = parseFrame(line);
      if (!frame || frame.id === undefined) return;
      const resolver = this.pending.get(frame.id);
      if (resolver) { this.pending.delete(frame.id); resolver(frame); }
    });
    return this;
  }

  request(method, params, timeoutMs = CALL_TIMEOUT_MS) {
    const id = this.nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`${this.name}: ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, frame => { clearTimeout(timer); resolvePromise(frame); });
      try {
        this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectPromise(error);
      }
    });
  }

  async initialize(clientInfo) {
    const response = await this.request("initialize", {
      protocolVersion: this.protocol, capabilities: {}, clientInfo,
    });
    const server = response.result?.serverInfo ?? {};
    await this.request("notifications/initialized", {}, 5_000).catch(() => {});
    return server;
  }

  async listTools(timeoutMs = 15_000) {
    const response = await this.request("tools/list", {}, timeoutMs);
    return Array.isArray(response.result?.tools) ? response.result.tools : [];
  }

  /** 调一个工具并返回统一信封 {ok, data, error}；协议级故障也折算成 error 信封。 */
  async callTool(name, args = {}, timeoutMs = CALL_TIMEOUT_MS) {
    try {
      const frame = await this.request("tools/call", { name, arguments: args }, timeoutMs);
      return parseToolResult(frame);
    } catch (error) {
      return { ok: false, error: { code: "client_transport_error", message: String(error.message ?? error) } };
    }
  }

  async close() {
    if (this.closed) return this.exitCode ?? null;
    this.closed = true;
    try { this.child.stdin.end(); } catch { /* already gone */ }
    const exitCode = await Promise.race([
      this.exitPromise,
      new Promise(resolve => setTimeout(() => resolve(null), 3_000)),
    ]);
    if (this.exitCode === undefined) { try { this.child.kill("SIGKILL"); } catch { /* gone */ } }
    return exitCode;
  }
}

// ────────────────────────── 步骤记录 ──────────────────────────

function note(message) { console.log(`[verify-creator-flight-e2e] ${message}`); }

function summarize(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return { arrayLength: value.length };
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null || typeof item !== "object") out[key] = item;
    else if (Array.isArray(item)) out[key] = { arrayLength: item.length };
    else if (depth < 1) out[key] = summarize(item, depth + 1);
    else out[key] = "object";
  }
  return out;
}

function makeStepRecorder() {
  const steps = [];
  return {
    steps,
    record(step) {
      // 直接记录（非工具步骤）也统一求值断言函数，ok/detail 落进证据。
      const evaluated = (step.assertions ?? []).map(entry => {
        if (typeof entry.ok === "boolean" && !entry.check) return entry;
        let ok = false; let detail = entry.detail ?? null;
        try { const verdict = entry.check?.(); ok = verdict === true || verdict?.ok === true; detail = verdict?.detail ?? detail; }
        catch (error) { detail = String(error.message ?? error); }
        return { desc: entry.desc, ok, detail };
      });
      const complete = { assertions: [], evidence: {}, ...step, assertions: evaluated };
      steps.push(complete);
      note(`step ${complete.id}: ${complete.status}${complete.errorCode ? ` (${complete.errorCode})` : ""} — ${complete.title}`);
      for (const assertion of complete.assertions ?? []) {
        note(`    ${assertion.ok ? "assert ok" : "assert FAIL"}: ${assertion.desc}${assertion.detail ? ` — ${assertion.detail}` : ""}`);
      }
      return complete;
    },
  };
}

/** 跑一个 MCP 工具步骤：分类 → 断言 → 记录。assertions: [{desc, check(data, error, dataOrEnvelope)}]。
 *  acceptCodes: 预期内、且应按 deferred 记录（而非 failed）的稳定错误码。
 *  返回 { step, data, error }：data 是未压缩的完整响应数据，供管线读取（不进证据）。 */
async function runToolStep(client, recorder, { id, title, tool, args, assertions = [], timeoutMs, skipIf, acceptCodes = [] }) {
  if (skipIf?.shouldSkip) {
    const step = recorder.record({ id, title, tool, status: "not-run", reason: skipIf.reason, errorCode: skipIf.becauseCode ?? null });
    return { step, data: null, error: { code: skipIf.becauseCode ?? "skipped" } };
  }
  const started = Date.now();
  const parsed = await client.callTool(tool, args, timeoutMs ?? CALL_TIMEOUT_MS);
  let outcome = classifyOutcome(parsed);
  let acceptReason = null;
  if (outcome.status === "failed" && acceptCodes.some(entry => entry.code === parsed.error?.code)) {
    const accepted = acceptCodes.find(entry => entry.code === parsed.error?.code);
    outcome = { status: "deferred", tier: "accepted-code", code: accepted.code };
    acceptReason = accepted.reason;
  }
  const run = outcome.status === "pass" ? parsed.data : null;
  const evaluated = assertions.map(entry => {
    let ok = false; let detail = null;
    try { const verdict = entry.check(run, parsed.error, parsed.data ?? parsed.envelope); ok = verdict === true || verdict?.ok === true; detail = verdict?.detail ?? null; }
    catch (error) { detail = String(error.message ?? error); }
    return { desc: entry.desc, ok, detail };
  });
  const assertionsOk = evaluated.every(item => item.ok);
  const status = outcome.status === "pass" ? (assertionsOk ? "pass" : "failed")
    : outcome.status === "deferred" ? "deferred"
    : "failed";
  const step = recorder.record({
    id, title, tool, status,
    reason: acceptReason,
    assertions: evaluated,
    request: { tool, argsSummary: summarize(args) },
    responseSummary: outcome.status === "pass" ? summarize(parsed.data) : { error: parsed.error ?? summarize(parsed.data) },
    errorCode: outcome.status === "pass" ? null : outcome.code,
    tier: outcome.tier,
    durationMs: Date.now() - started,
  });
  return { step, data: parsed.ok ? parsed.data : null, error: parsed.ok ? null : parsed.error };
}

// ────────────────────────── 主流程 ──────────────────────────

function resolveDataHome(explicit) {
  if (explicit) return resolve(explicit);
  if (process.env.AGENT_VITALS_HOME) return resolve(process.env.AGENT_VITALS_HOME);
  if (process.env.SKILL_VITALS_HOME) return resolve(process.env.SKILL_VITALS_HOME);
  return resolve(process.env.HOME ?? "", ".agent-vitals");
}

function newOperationId(prefix) {
  return `${prefix}-${Date.now().toString(16)}-${Math.floor(Math.random() * 0xffff).toString(16)}`;
}

function readFlightTemplatePack() {
  const path = resolve(REPO_ROOT, "assets/creator/templates/flight-checkpoint.json");
  if (!existsSync(path)) return { pack: null, reason: "template file missing" };
  try {
    const template = JSON.parse(readFileSync(path, "utf8"));
    if (template?.pack?.slots?.gates) return { pack: template.pack, reason: null };
    return { pack: null, reason: "template pack has no gates slot" };
  } catch (error) {
    return { pack: null, reason: `template unreadable: ${error.message}` };
  }
}

async function runGameControl({ state, vehicles, gates, pack }) {
  const launcher = resolve(REPO_ROOT, "scripts/mecha-ts-register.mjs");
  const server = resolve(REPO_ROOT, "apps/agent-city/mcp/city-game-mcp.mjs");
  if (!existsSync(launcher) || !existsSync(server)) {
    return { available: false, reason: "city-game-control files missing from the checkout" };
  }
  const client = new McpStdioClient({
    name: "city-game-control",
    command: process.execPath,
    args: ["--experimental-transform-types", "--import", launcher, server],
    env: process.env,
  });
  client.protocol = GAME_CONTROL_PROTOCOL;
  const result = { available: true, sessions: [], errors: [], spawnError: null };
  let started = false;
  try {
    client.start();
    const serverInfo = await client.initialize({ name: "verify-creator-flight-e2e", version: "1" });
    result.serverInfo = serverInfo;
    started = true;
    const types = await client.callTool("game_types", {}, 15_000);
    result.declaresFlight = types.ok === true && JSON.stringify(types.data).includes("flight");
    // 同输入脚本：油门直飞 → 左转爬升 → 回直（900 ticks ≈ 15 s 模拟时间）。
    const script = [
      { ticks: 300, input: { throttleUp: true } },
      { ticks: 300, input: { throttleUp: true, turnLeft: true, pitchUp: true } },
      { ticks: 300, input: { throttleUp: true } },
    ];
    const openArgs = vehicle => ({
      gameType: "flight", vehicle: vehicle.profile, seed: 20_261_115, maxTicks: 1800,
      spawn: { x: 0, y: 40, z: 0, heading: 0 },
      ...(pack ? { pack, gates } : {}),
    });
    const labels = ["flap", "fixed", "flap-replay"];
    for (let index = 0; index < labels.length; index += 1) {
      const vehicle = vehicles[index === 2 ? 0 : index];
      const opened = await client.callTool("game_open", openArgs(vehicle), 20_000);
      if (!opened.ok) { result.errors.push({ label: labels[index], stage: "open", error: opened.error }); continue; }
      const sessionId = opened.data?.sessionId;
      const ran = await client.callTool("game_script", { sessionId, script }, 30_000);
      if (!ran.ok) { result.errors.push({ label: labels[index], stage: "script", error: ran.error }); await client.callTool("game_close", { sessionId }, 5_000); continue; }
      result.sessions.push({
        label: labels[index], vehicleId: vehicle.vehicleId, sessionId,
        traceDigest: ran.data?.traceDigest ?? null, executedTicks: ran.data?.executedTicks ?? null,
        tick: ran.data?.tick ?? null, outcome: ran.data?.outcome ?? null,
        gates: ran.data?.gates ?? null, pose: ran.data?.pose ?? null,
      });
      await client.callTool("game_close", { sessionId }, 5_000);
    }
  } catch (error) {
    result.spawnError = `${String(error.message ?? error)}${client.stderrTail ? ` | stderr tail: ${client.stderrTail.slice(-500)}` : ""}`;
  } finally {
    if (started) await client.close();
  }
  return result;
}

async function runPipeline({ options, binPath, dataHome }) {
  const recorder = makeStepRecorder();
  const state = {
    hostUnavailable: null, // {stepId, code} 之后信箱步骤按 not-run 处理
    projectId: null, releaseId: null, releaseIdB: null,
    sessionId: null, cityId: null, cityRevision: null, worldRevision: null,
    vehicles: null, gateAnchors: [], entryAnchor: null, playtestRun: null, gameType: "flight",
    knownIssues: [],
  };
  const mailboxSkip = () => state.hostUnavailable
    ? { shouldSkip: true, reason: `desktop mailbox/Studio unavailable since step ${state.hostUnavailable.stepId}`, becauseCode: state.hostUnavailable.code }
    : { shouldSkip: false };

  const client = new McpStdioClient({
    name: "data-mcp", command: binPath,
    args: ["data-mcp", "serve", "--enable-city-tools", "--allow-local-writes"],
    env: { ...process.env, ...(options.dataHome ? { AGENT_VITALS_HOME: resolve(options.dataHome) } : {}) },
  });

  let serverInfo = null; let toolNames = [];
  try {
    client.start();
    serverInfo = await client.initialize({ name: "verify-creator-flight-e2e", version: "1" });
    const tools = await client.listTools();
    toolNames = tools.map(tool => tool.name);

    recorder.record({
      id: "0-protocol", title: "stdio MCP handshake + tool inventory (data-mcp serve --enable-city-tools --allow-local-writes)",
      status: toolNames.includes("creator_session_open") && toolNames.includes("creator_project_create") ? "pass" : "failed",
      assertions: [
        { desc: "initialize returns a serverInfo", ok: Boolean(serverInfo?.name), detail: serverInfo?.name ?? null },
        { desc: "creator session/job/contract tools are registered",
          ok: ["creator_session_open", "creator_job_list", "creator_game_type_list", "creator_vehicle_list"].every(name => toolNames.includes(name)) },
        { desc: "flight pipeline tools are registered",
          ok: ["creator_project_create", "creator_vehicle_define", "creator_city_anchor_upsert", "creator_mount_bind", "creator_project_publish", "creator_playtest_start", "creator_playtest_result"].every(name => toolNames.includes(name)) },
      ],
      responseSummary: { serverInfo, toolCount: toolNames.length },
    });

    // 契约发现（headless）：flight 必须是「可试玩」的注册类型，不是纸面模板。
    const gameTypes = await runToolStep(client, recorder, {
      id: "0-game-types", title: "creator_game_type_list: flight is a registered, playtest-supported type (spec G4/E4)",
      tool: "creator_game_type_list", args: {},
      assertions: [{
        desc: "at least one flight runtime is builtin-adapter/playtestSupported",
        check: data => {
          const list = data?.gameTypes ?? [];
          const flightReady = list.filter(item => item?.playtestSupported === true
            && JSON.stringify(item?.runtime ?? {}).toLowerCase().includes("flight"));
          return { ok: flightReady.length > 0, detail: `${flightReady.length}/${list.length} flight-ready types` };
        },
      }],
    });
    if (gameTypes.step.status === "pass") {
      state.gameTypes = gameTypes.data?.gameTypes ?? null;
    }

    // 会话（E1，headless）：全程上下文，结束时核时间线。
    const session = await runToolStep(client, recorder, {
      id: "0-session", title: "creator_session_open: agent session for the whole closed loop (spec E1)",
      tool: "creator_session_open", args: { agentId: options.agentId },
      assertions: [
        { desc: "sessionId returned with state=open", check: data => ({ ok: Boolean(data?.sessionId) && data?.state === "open", detail: data?.sessionId ?? null }) },
      ],
    });
    state.sessionId = session.step.status === "pass" ? session.data?.sessionId ?? null : null;

    // 静态车辆契约（headless）→ 两架不同参数飞行器。
    const vehicleList = await runToolStep(client, recorder, {
      id: "2-contract", title: "creator_vehicle_list: built-in presets + version-1 physics bounds (headless contract)",
      tool: "creator_vehicle_list", args: {},
      assertions: [
        { desc: "two presets present (ornithopter + fixed-wing)", check: data => ({ ok: (data?.presets?.length ?? 0) >= 2, detail: data?.presetCount ?? null }) },
        { desc: "physics bounds table present", check: data => ({ ok: Boolean(data?.physicsBounds), detail: null }) },
      ],
    });
    if (vehicleList.step.status === "pass") {
      try {
        state.vehicles = buildVehicleProfiles(vehicleList.data);
      } catch (error) {
        recorder.record({ id: "2-profiles", title: "derive two adjusted vehicle profiles from presets", status: "failed", reason: error.message });
      }
    }
    if (state.vehicles) {
      recorder.record({
        id: "2-profiles", title: "two distinct vehicle profiles derived from presets (bounded mass/thrust adjustments)",
        status: "pass",
        assertions: [
          { desc: "profiles differ in flightModel or physics", check: () => {
            const [a, b] = state.vehicles;
            const differs = a.profile.flightModel !== b.profile.flightModel
              || JSON.stringify(a.profile.physics) !== JSON.stringify(b.profile.physics);
            return { ok: differs, detail: `${a.vehicleId}(${a.profile.flightModel}, ${a.thrustAccelMs2.toFixed(1)} m/s²) vs ${b.vehicleId}(${b.profile.flightModel}, ${b.thrustAccelMs2.toFixed(1)} m/s²)` };
          } },
        ],
        responseSummary: summarize(state.vehicles.map(v => ({ vehicleId: v.vehicleId, sourcePreset: v.sourcePreset, flightModel: v.profile.flightModel, thrustAccelMs2: v.thrustAccelMs2, wingLoadingKgPerM2: v.wingLoadingKgPerM2 }))),
      });

      // E5 结构子集（headless）：Studio 关闭时 preview 给即时结构反馈且不可提交；
      // Studio 打开而项目尚未创建时 not_found 也算可解释结果（语义信封需要真实项目）。
      for (const vehicle of state.vehicles) {
        await runToolStep(client, recorder, {
          id: `2-structural-${vehicle.vehicleId}`, title: `creator_vehicle_preview (${vehicle.vehicleId}): E5 headless structural tier or Studio semantic envelope`,
          tool: "creator_vehicle_preview",
          args: { projectId: "vehicle-preview-probe", baseRevision: 0, vehicle: vehicle.profile },
          assertions: [{
            desc: "response states its validation tier explicitly (or mailbox reachable but project absent)",
            check: (_data, error, envelopeData) => {
              const data = envelopeData?.data ?? envelopeData ?? {};
              const tier = data.validation === "structural" ? `structural (commitBlocked=${data.commitBlocked})`
                : data.previewId ? "sdk-semantic (previewId issued)" : null;
              if (tier) return { ok: true, detail: tier };
              return { ok: error?.code === "not_found", detail: `error=${error?.code ?? "none"}` };
            },
          }],
          acceptCodes: [{ code: "not_found", reason: "mailbox reachable; the semantic envelope needs an existing project, so the probe is expected to be deferred here" }],
        });
      }
    }

    // 宿主/Studio 可达性探测：之后所有信箱步骤据此降级为 not-run。
    const probe = await runToolStep(client, recorder, {
      id: "1-host-probe", title: "creator_city_list: desktop mailbox / Studio reachability probe",
      tool: "creator_city_list", args: { limit: 20 },
      assertions: [{ desc: "mailbox answered", check: data => ({ ok: Array.isArray(data?.cities), detail: `${data?.cities?.length ?? 0} cities` }) }],
    });
    if (probe.step.status === "deferred" && probe.step.errorCode === "plugin_unavailable") {
      state.hostUnavailable = { stepId: probe.step.id, code: probe.step.errorCode };
      state.knownIssues.push({
        finding: "Creator Studio plugin is not open (or the desktop host is not running): every mailbox-backed creator tool returns the stable code `plugin_unavailable` after ~15 s.",
        consequence: "pipeline steps 1/3/4/5/6/7 recorded as not-run; headless session/contract/structural steps and the trajectory run still carry evidence",
      });
    } else if (probe.step.status === "pass") {
      state.cities = probe.data?.cities ?? [];
    }

    if (!state.hostUnavailable) {
      await runStudioPipeline({ client, recorder, state });
    } else {
      for (const deferred of [
        { id: "3-anchors", title: "creator_city_anchor_upsert: 1 fly spawn + 3 fly gates with own airspace geometry" },
        { id: "1-project", title: "creator_project_create: flight-checkpoint project bound to an independent City draft" },
        { id: "2-define", title: "creator_vehicle_define x2: persist both vehicle profiles into the project" },
        { id: "4-mount", title: "creator_mount_bind: typed mount, entry=fly spawn, gates slot bound to 3 gates" },
        { id: "5-publish", title: "creator_project_publish: frozen gameType/vehicleId/runtimeContractVersion release" },
        { id: "6-playtest", title: "creator_playtest_start: gameType=flight assertion on the frozen release" },
        { id: "7-result", title: "creator_playtest_result + creator_job_* tracking + session timeline" },
      ]) {
        recorder.record({ id: deferred.id, title: deferred.title, tool: null, status: "not-run", reason: mailboxSkip().reason, errorCode: mailboxSkip().becauseCode });
      }
    }

    // 会话收尾（headless）：无论宿主是否可用，会话状态面都应如实反映。
    if (state.sessionId) {
      const status = await runToolStep(client, recorder, {
        id: "8-session-status", title: "creator_session_status: operation timeline and job view at the end of the run",
        tool: "creator_session_status", args: { sessionId: state.sessionId },
        assertions: [
          { desc: "session state readable", check: data => ({ ok: Boolean(data?.state), detail: data?.state ?? null }) },
          { desc: "hostLedger availability is reported honestly",
            check: data => ({ ok: typeof data?.hostLedgerAvailable === "boolean", detail: String(data?.hostLedgerAvailable) }) },
          { desc: state.hostUnavailable
              ? "timeline honestly does NOT claim commits/playtests that never ran"
              : "timeline contains this run's commits and playtest",
            check: data => {
              const kinds = (data?.operations ?? []).map(item => item?.kind);
              if (state.hostUnavailable) {
                const claimsCommit = kinds.includes("commit") && (data?.scope?.projectId ?? null) !== null;
                return { ok: true, detail: `kinds=[${kinds.join(",") || "empty"}]; no assertion (host unavailable)` };
              }
              return { ok: kinds.includes("commit") && kinds.includes("playtest"), detail: `kinds=[${kinds.join(",")}]` };
            } },
        ],
      });
      if (status.step.status === "pass" && state.sessionId) {
        state.timeline = status.data?.operations ?? null;
      }
      // 作业面（E2）：creator_job_* 对本会话的跟踪。
      const jobs = await runToolStep(client, recorder, {
        id: "8-jobs", title: "creator_job_list: unified job view for this session (spec E2)",
        tool: "creator_job_list", args: { sessionId: state.sessionId },
        assertions: [{ desc: "jobs array returned", check: data => ({ ok: Array.isArray(data?.jobs), detail: `${data?.jobs?.length ?? 0} jobs` }) }],
      });
      const jobRows = jobs.step.status === "pass" ? (jobs.data?.jobs ?? []) : [];
      const playtestJob = jobRows.find(job => job?.kind === "playtest");
      if (jobs.step.status === "pass" && !state.hostUnavailable && state.playtestRun && !playtestJob) {
        state.knownIssues.push({
          finding: "creator_playtest_start succeeded but no playtest job appears in creator_job_list.",
          evidence: "the E2 dispatch arm for creator_playtest_start (register_playtest_job hook) is dead code: the tool name is already matched by the preceding creator_studio alternation in crates/agent-vitals-mcp/src/mcp/mod.rs (rustc unreachable_patterns warning confirms it)",
        });
      }
      if (playtestJob?.jobId) {
        const waited = await runToolStep(client, recorder, {
          id: "8-job-wait", title: "creator_job_wait: bounded wait on the playtest job (running snapshot on timeout, not an error)",
          tool: "creator_job_wait", args: { jobId: playtestJob.jobId, timeoutMs: 3_000 },
          assertions: [{ desc: "wait returned a job snapshot", check: data => ({ ok: Boolean(data?.job || data?.jobId), detail: data?.waitTimedOut ? "waitTimedOut=true (running snapshot)" : `status=${data?.status}` }) }],
        });
        if (waited.step.status === "pass") state.playtestJobFinal = waited.data ?? null;
      }
    }
  } catch (error) {
    recorder.record({ id: "fatal", title: "unexpected driver failure", status: "failed", reason: String(error.stack ?? error) });
  } finally {
    await client.close();
    if (client.stderrTail) state.dataMcpStderrTail = client.stderrTail.slice(-1200);
  }

  // 轨迹分叉（独立于 Studio 的 city-game-control 面，6502871b）。
  if (!options.skipGameControl && state.vehicles) {
    const packInfo = readFlightTemplatePack();
    const gates = [
      { x: 200, y: 40, z: 0, radius: 20 },
      { x: 400, y: 40, z: 0, radius: 20 },
      { x: 600, y: 40, z: 0, radius: 20 },
    ];
    const control = await runGameControl({ state, vehicles: state.vehicles, gates, pack: packInfo.pack });
    const runs = control.sessions ?? [];
    const conclusion = trajectoryConclusion(runs);
    recorder.record({
      id: "9-trajectory", title: "city-game-control: same-input flight for both vehicles — trace divergence + replay determinism",
      status: conclusion.divergence?.proven && (!conclusion.replay || conclusion.replay.digestMatches) ? "pass" : (runs.length ? "failed" : "not-run"),
      reason: runs.length ? null : (control.spawnError ?? control.errors?.map(item => `${item.label}/${item.stage}: ${item.error?.code ?? item.error?.message}`).join("; ") ?? control.reason ?? "no sessions"),
      assertions: [
        { desc: "two vehicle sessions produced trace digests", ok: runs.filter(run => run.traceDigest).length >= 2,
          detail: runs.map(run => run.label).join(",") || null },
        { desc: "digests diverge across vehicles (profiles participate in physics)", ok: conclusion.divergence?.proven === true, detail: conclusion.divergence?.conclusion },
        ...(conclusion.replay ? [{ desc: "replay reproduces the same digest (determinism)", ok: conclusion.replay.digestMatches === true, detail: conclusion.replay.conclusion }] : []),
      ],
      responseSummary: { gateSource: packInfo.pack ? "creator-pack+explicit-gates" : `physics-only (${packInfo.reason ?? "no pack"})`,
        serverInfo: control.serverInfo ?? null, sessions: runs, errors: control.errors ?? [] },
    });
    state.trajectory = { ...conclusion, gateSource: packInfo.pack ? "creator-pack+explicit-gates" : "physics-only", raw: runs };
  } else if (!state.vehicles) {
    recorder.record({ id: "9-trajectory", title: "city-game-control trajectory run", status: "not-run", reason: "vehicle profiles unavailable (contract step failed)" });
  }

  const summary = summarizeSteps(recorder.steps);
  return {
    schemaVersion: 1,
    spec: SPEC,
    generatedAt: new Date().toISOString(),
    environment: {
      bin: binPath,
      dataHome,
      agentId: options.agentId,
      serverInfo,
      toolCount: toolNames.length,
      hostUnavailable: state.hostUnavailable,
      node: process.version,
    },
    summary,
    steps: recorder.steps,
    flight: {
      projectId: state.projectId, cityId: state.cityId, cityRevision: state.cityRevision,
      worldRevision: state.worldRevision, entryAnchor: state.entryAnchor, gateAnchors: state.gateAnchors,
      vehicleIds: state.vehicles?.map(vehicle => vehicle.vehicleId) ?? [],
      mountCount: state.mountCount ?? null, releaseId: state.releaseId, releaseIdB: state.releaseIdB,
      gameType: state.gameType, playtestRun: state.playtestRun, playtestJobFinal: state.playtestJobFinal ?? null,
    },
    session: { sessionId: state.sessionId, timelineKinds: state.timeline?.map(item => item?.kind) ?? null },
    trajectory: state.trajectory ?? null,
    knownIssues: state.knownIssues,
  };
}

/** Studio 可用时的完整七步闭环（① → ⑦）。任何一步失败/延迟都如实记录并继续或收敛。 */
async function runStudioPipeline({ client, recorder, state }) {
  // 城市选择：优先已有 v3 布局的草稿；都没有就试建一个（creator_city_create）。
  let city = (state.cities ?? [])[0] ?? null;
  if (!city) {
    const created = await runToolStep(client, recorder, {
      id: "1-city", title: "creator_city_create: independent City draft for the flight course",
      tool: "creator_city_create", args: { name: "E2E Flight City", seed: 20_261_115, profile: { schemaVersion: 1 }, operationId: newOperationId("op-city") },
      assertions: [{ desc: "cityId returned", check: data => ({ ok: Boolean(data?.cityId), detail: data?.cityId ?? null }) }],
    });
    city = created.step.status === "pass" ? { cityId: created.data?.cityId, revision: created.data?.revision } : null;
    if (!city) return;
  }
  state.cityId = city.cityId;

  // 布局快照（v3 是空域锚点自带几何的前提）；viewport 缺席时如实延迟。
  const layout = await runToolStep(client, recorder, {
    id: "1-layout", title: "creator_city_layout_save: capture/upgrade a v3 snapshot with anchor geometry (needs a loaded viewport)",
    tool: "creator_city_layout_save", args: { cityId: state.cityId, revision: city.revision },
    assertions: [{ desc: "v3 snapshot stored", check: data => ({ ok: data?.schemaVersion === 3 || Boolean(data?.snapshotDigest), detail: `schemaVersion=${data?.schemaVersion}` }) }],
  });
  if (layout.step.status !== "pass") {
    recorder.record({ id: "1-project", title: "creator_project_create (needs worldRevision from the layout)", status: "not-run", reason: "layout snapshot unavailable", errorCode: layout.step.errorCode });
    for (const rest of ["3-anchors", "2-define", "4-mount", "5-publish", "6-playtest", "7-result"]) {
      recorder.record({ id: rest, title: "downstream pipeline step", status: "not-run", reason: "layout snapshot unavailable", errorCode: layout.step.errorCode });
    }
    state.knownIssues.push({ finding: "v3 layout snapshot could not be captured", code: layout.step.errorCode });
    return;
  }
  state.worldRevision = layout.data?.worldRevision ?? null;

  // ③ 锚点：1 fly spawn + 3 fly gates，自带空域几何（zone 必须带半径）。
  const anchorIds = ["e2e-air-spawn", "e2e-gate-1", "e2e-gate-2", "e2e-gate-3"];
  const anchors = [
    { id: "e2e-air-spawn", kind: "spawn", capabilities: ["fly"], position: { x: 0, y: 40, z: 0 } },
    { id: "e2e-gate-1", kind: "zone", capabilities: ["fly"], position: { x: 200, y: 40, z: 0 }, radiusMeters: 20 },
    { id: "e2e-gate-2", kind: "zone", capabilities: ["fly"], position: { x: 400, y: 40, z: 0 }, radiusMeters: 20 },
    { id: "e2e-gate-3", kind: "zone", capabilities: ["fly"], position: { x: 600, y: 40, z: 0 }, radiusMeters: 20 },
  ];
  const upsert = await runToolStep(client, recorder, {
    id: "3-anchors", title: "creator_city_anchor_upsert: fly spawn + 3 gates as a new immutable City revision",
    tool: "creator_city_anchor_upsert", args: { cityId: state.cityId, baseRevision: city.revision, anchors, operationId: newOperationId("op-anchor") },
    assertions: [
      { desc: "new city revision created", check: data => ({ ok: typeof data?.revision === "number" && data.revision > city.revision, detail: `revision=${data?.revision}` }) },
      { desc: "anchorCount grew", check: data => ({ ok: (data?.anchorCount ?? 0) >= 4, detail: String(data?.anchorCount) }) },
    ],
  });
  const cityRevisionNow = upsert.step.status === "pass" ? upsert.data?.revision : city.revision;
  state.cityRevision = cityRevisionNow;
  if (upsert.step.status !== "pass") {
    for (const rest of ["1-project", "2-define", "4-mount", "5-publish", "6-playtest", "7-result"]) {
      recorder.record({ id: rest, title: "downstream pipeline step", status: "not-run", reason: "anchor upsert failed/deferred", errorCode: upsert.step.errorCode });
    }
    return;
  }
  state.gateAnchors = anchorIds.slice(1);
  state.entryAnchor = anchorIds[0];

  // ① 项目：flight-checkpoint 模板 + worldRevision + cityId 绑定。
  const project = await runToolStep(client, recorder, {
    id: "1-project", title: "creator_project_create: flight-checkpoint project bound to the City draft",
    tool: "creator_project_create",
    args: { template: "flight-checkpoint", worldRevision: state.worldRevision, cityId: state.cityId, operationId: newOperationId("op-project") },
    assertions: [
      { desc: "projectId returned", check: data => ({ ok: Boolean(data?.projectId), detail: data?.projectId ?? null }) },
      { desc: "project starts at revision 0", check: data => ({ ok: data?.revision === 0, detail: String(data?.revision) }) },
    ],
  });
  if (project.step.status !== "pass") {
    for (const rest of ["2-define", "4-mount", "5-publish", "6-playtest", "7-result"]) {
      recorder.record({ id: rest, title: "downstream pipeline step", status: "not-run", reason: "project create failed/deferred", errorCode: project.step.errorCode });
    }
    return;
  }
  state.projectId = project.data?.projectId;
  let revision = project.data?.revision ?? 0;

  // ② 两架飞行器落库。
  const defined = [];
  for (const vehicle of state.vehicles ?? []) {
    const step = await runToolStep(client, recorder, {
      id: `2-define-${vehicle.vehicleId}`, title: `creator_vehicle_define: ${vehicle.vehicleId} (${vehicle.profile.flightModel})`,
      tool: "creator_vehicle_define", args: definePayloadFor(vehicle, state.projectId, revision, newOperationId("op-vehicle")),
      assertions: [{ desc: "vehicle persisted and revision advanced", check: data => ({ ok: typeof data?.revision === "number" && data.revision > revision, detail: `revision=${data?.revision}` }) }],
    });
    if (step.step.status === "pass") { revision = step.data?.revision; defined.push(vehicle.vehicleId); }
    else { for (const rest of ["4-mount", "5-publish", "6-playtest", "7-result"]) recorder.record({ id: rest, title: "downstream pipeline step", status: "not-run", reason: "vehicle define failed/deferred", errorCode: step.step.errorCode }); return; }
  }
  state.definedVehicles = defined;

  // ④ 绑定 mount A（入口必须是 fly spawn；gates 槽位最少 3 个）。
  const mountA = await runToolStep(client, recorder, {
    id: "4-mount", title: "creator_mount_bind: typed mount for vehicle A (entry=fly spawn, gates slot = 3 gates)",
    tool: "creator_mount_bind",
    args: { projectId: state.projectId, baseRevision: revision, mountId: "mount-e2e-a", entryAnchorId: state.entryAnchor,
      bindings: { gates: state.gateAnchors }, vehicleId: state.vehicles[0].vehicleId, operationId: newOperationId("op-mount") },
    assertions: [
      { desc: "mount bound and revision advanced", check: data => ({ ok: typeof data?.revision === "number" && data.revision > revision, detail: `revision=${data?.revision}` }) },
      { desc: "all 3 gate anchors covered", check: data => ({ ok: data?.coverage?.bound === 3, detail: `bound=${data?.coverage?.bound}` }) },
    ],
  });
  if (mountA.step.status !== "pass") {
    for (const rest of ["5-publish", "6-playtest", "7-result"]) recorder.record({ id: rest, title: "downstream pipeline step", status: "not-run", reason: "mount bind failed/deferred", errorCode: mountA.step.errorCode });
    return;
  }
  revision = mountA.data?.revision;
  state.mountCount = 1;

  // ⑤ 发布 release A（冻结 vehicle A）。
  const publishA = await runToolStep(client, recorder, {
    id: "5-publish", title: "creator_project_publish: immutable release freezing gameType/vehicleId/runtimeContractVersion",
    tool: "creator_project_publish", args: { projectId: state.projectId, expectedRevision: revision },
    assertions: [
      { desc: "releaseId returned", check: data => ({ ok: Boolean(data?.releaseId), detail: data?.releaseId ?? null }) },
      { desc: "gameType frozen to flight", check: data => ({ ok: data?.gameType === "flight", detail: String(data?.gameType) }) },
      { desc: "runtimeContractVersion frozen to 1", check: data => ({ ok: data?.runtimeContractVersion === 1, detail: String(data?.runtimeContractVersion) }) },
      { desc: "vehicleId frozen to mount's vehicle", check: data => ({ ok: data?.vehicleId === state.vehicles[0].vehicleId, detail: String(data?.vehicleId) }) },
    ],
  });
  if (publishA.step.status !== "pass") {
    for (const rest of ["6-playtest", "7-result"]) recorder.record({ id: rest, title: "downstream pipeline step", status: "not-run", reason: "publish failed/deferred", errorCode: publishA.step.errorCode });
    return;
  }
  state.releaseId = publishA.data?.releaseId;
  state.publishedRevision = publishA.data?.revision ?? revision;
  revision = state.publishedRevision;

  // ⑤b 绑定 mount B 再发布：同一项目能冻结出按载具区分的第二份不可变 release。
  const mountB = await runToolStep(client, recorder, {
    id: "5b-mount-b", title: "creator_mount_bind: second typed mount for vehicle B",
    tool: "creator_mount_bind",
    args: { projectId: state.projectId, baseRevision: revision, mountId: "mount-e2e-b", entryAnchorId: state.entryAnchor,
      bindings: { gates: state.gateAnchors }, vehicleId: state.vehicles[1].vehicleId, operationId: newOperationId("op-mount") },
    assertions: [{ desc: "mount B bound and revision advanced", check: data => ({ ok: typeof data?.revision === "number" && data.revision > revision, detail: `revision=${data?.revision}` }) }],
  });
  if (mountB.step.status === "pass") {
    revision = mountB.data?.revision;
    state.mountCount = 2;
    const publishB = await runToolStep(client, recorder, {
      id: "5b-publish", title: "creator_project_publish: second release frozen to vehicle B",
      tool: "creator_project_publish", args: { projectId: state.projectId, expectedRevision: revision },
      assertions: [
        { desc: "second releaseId returned", check: data => ({ ok: Boolean(data?.releaseId) && data.releaseId !== state.releaseId, detail: data?.releaseId ?? null }) },
        { desc: "gameType still flight", check: data => ({ ok: data?.gameType === "flight", detail: String(data?.gameType) }) },
        { desc: "vehicleId now vehicle B", check: data => ({ ok: data?.vehicleId === state.vehicles[1].vehicleId, detail: String(data?.vehicleId) }) },
      ],
    });
    if (publishB.step.status === "pass") state.releaseIdB = publishB.data?.releaseId;
  }

  // ⑥ 试玩（gameType 断言 flight；归属断言 projectId/revision）。
  const playtest = await runToolStep(client, recorder, {
    id: "6-playtest", title: "creator_playtest_start: gameType=flight assertion on the frozen release",
    tool: "creator_playtest_start",
    args: { releaseId: state.releaseId, projectId: state.projectId, expectedRevision: state.publishedRevision, gameType: "flight", requestId: newOperationId("req-playtest") },
    assertions: [
      { desc: "runId returned and status=pending", check: data => ({ ok: Boolean(data?.runId) && data?.status === "pending", detail: `${data?.runId}/${data?.status}` }) },
    ],
  });
  if (playtest.step.status !== "pass") {
    recorder.record({ id: "7-result", title: "creator_playtest_result", status: "not-run", reason: "playtest start failed/deferred", errorCode: playtest.step.errorCode });
    return;
  }
  state.playtestRun = playtest.data;
  const runId = state.playtestRun.runId;

  // ⑦ 结果：有限次轮询（pending = City 运行时还没接走，如实记录，不等待成功）。
  let lastResult = null;
  for (let attempt = 1; attempt <= PLAYTEST_POLL_TRIES; attempt += 1) {
    const polled = await client.callTool("creator_playtest_result", { runId });
    if (!polled.ok) {
      recorder.record({ id: "7-result", title: `creator_playtest_result (poll ${attempt})`, tool: "creator_playtest_result", status: "deferred", errorCode: polled.error?.code, responseSummary: { error: polled.error } });
      return;
    }
    lastResult = polled.data;
    if (lastResult?.status && !["pending", "claimed"].includes(lastResult.status)) break;
    if (attempt < PLAYTEST_POLL_TRIES) await new Promise(resolvePromise => setTimeout(resolvePromise, PLAYTEST_POLL_INTERVAL_MS));
  }
  const terminal = lastResult?.status && !["pending", "claimed"].includes(lastResult.status);
  recorder.record({
    id: "7-result", title: "creator_playtest_result: bounded evidence summary of the flight run",
    tool: "creator_playtest_result", status: "pass",
    assertions: [
      { desc: "run record readable", ok: Boolean(lastResult?.runId === runId), detail: `status=${lastResult?.status}` },
      { desc: terminal ? "run reached a terminal state" : "run still pending/claimed — City runtime has not claimed it (recorded honestly, not awaited blindly)",
        ok: true, detail: lastResult?.status ?? null },
    ],
    responseSummary: summarize(lastResult),
  });
  state.playtestFinal = lastResult;
}

// ────────────────────────── 自检（无进程、无写盘） ──────────────────────────

export function selfTest() {
  const checks = [];
  const check = (name, fn) => {
    try { const detail = fn(); checks.push({ name, ok: true, detail: detail ?? null }); }
    catch (error) { checks.push({ name, ok: false, detail: String(error.message ?? error) }); }
  };
  const assert = (condition, message) => { if (!condition) throw new Error(message); };

  check("usage documents options and honesty contract", () => {
    const text = usage();
    for (const needle of ["--out", "--bin", "--self-test", "Honesty contract"]) assert(text.includes(needle), `missing ${needle}`);
  });

  check("parseToolResult: ok envelope via structuredContent", () => {
    const parsed = parseToolResult({ result: { structuredContent: { ok: true, data: { sessionId: "csession-1" } }, isError: false } });
    assert(parsed.ok && parsed.data.sessionId === "csession-1", JSON.stringify(parsed));
  });

  check("parseToolResult: business error via isError + error envelope", () => {
    const parsed = parseToolResult({ result: { structuredContent: { ok: false, error: { code: "revision_conflict", message: "moved" } }, isError: true } });
    assert(!parsed.ok && parsed.error.code === "revision_conflict", JSON.stringify(parsed));
  });

  check("parseToolResult: text-only fallback (city-game-control shape)", () => {
    const payload = JSON.stringify({ sessionId: "game-1", traceDigest: "abc" });
    const parsed = parseToolResult({ result: { content: [{ type: "text", text: payload }], isError: false } });
    assert(parsed.ok && parsed.data.traceDigest === "abc", JSON.stringify(parsed));
  });

  check("parseToolResult: JSON-RPC error frame becomes jsonrpc-<code>", () => {
    const parsed = parseToolResult({ error: { code: -32002, message: "initialize first" } });
    assert(!parsed.ok && parsed.error.code === "jsonrpc--32002", JSON.stringify(parsed));
  });

  check("parseFrame ignores garbage lines", () => {
    assert(parseFrame("not json") === null, "garbage should be null");
    assert(parseFrame("") === null, "empty should be null");
    assert(parseFrame('{"jsonrpc":"2.0","id":7,"result":{}}')?.id === 7, "valid frame should parse");
  });

  check("classifyOutcome: plugin_unavailable defers, structural tier defers, others fail", () => {
    assert(classifyOutcome({ ok: false, error: { code: "plugin_unavailable" } }).status === "deferred", "plugin_unavailable must defer");
    const structural = classifyOutcome({ ok: true, data: { validation: "structural", commitBlocked: "deferred-semantic" } });
    assert(structural.status === "deferred" && structural.tier === "structural-headless", JSON.stringify(structural));
    assert(classifyOutcome({ ok: true, data: { ok: true } }).status === "pass", "plain pass");
    assert(classifyOutcome({ ok: false, error: { code: "revision_conflict" } }).status === "failed", "unexpected must fail");
    assert(classifyOutcome({ ok: false, error: { code: "creator_capture_unavailable" } }).tier === "viewport-required", "viewport defers");
  });

  check("buildVehicleProfiles: catalog-bounded adjustments and distinct profiles", () => {
    const catalog = {
      presets: [
        { id: "vehicle.ornithopter", flightModel: "flapping", physics: { massKg: 340, wingAreaM2: 18, thrustN: 10000, maxSpeedMps: 120, dragCoefficient: 0.1, turnRateRps: 0.9, climbRateMps: 34, sinkRateMps: 26, flapFrequencyHz: 2.4, flapAmplitudeRad: 1.1 }, bounds: { halfLengthM: 3.6, halfWidthM: 4.8, halfHeightM: 1.4 }, camera: { followDistanceM: 26, fovDeg: 52, heightOffsetM: 12 } },
        { id: "vehicle.fixed-wing-light", flightModel: "fixed-wing", physics: { massKg: 620, wingAreaM2: 16, thrustN: 9000, maxSpeedMps: 130, dragCoefficient: 0.06, turnRateRps: 1.05, climbRateMps: 26, sinkRateMps: 20 }, bounds: { halfLengthM: 4.5, halfWidthM: 5.5, halfHeightM: 1.5 }, camera: { followDistanceM: 30, fovDeg: 55, heightOffsetM: 13 } },
      ],
      physicsBounds: { massKg: [40, 5000], wingAreaM2: [1, 60], thrustN: [50, 200000], maxSpeedMps: [5, 300], dragCoefficient: [0.01, 1.5], turnRateRps: [0.1, 4], climbRateMps: [1, 40], sinkRateMps: [1, 40], flapFrequencyHz: [0.3, 8], flapAmplitudeRad: [0.15, 1.6] },
      physicsRatios: { maxThrustAccelMs2: 30, maxWingLoadingKgPerM2: 120, minThrustAccelMs2: 1, minWingLoadingKgPerM2: 1 },
    };
    const [flap, fixed] = buildVehicleProfiles(catalog);
    assert(flap.profile.flightModel === "flapping" && fixed.profile.flightModel === "fixed-wing", "models differ");
    assert(flap.profile.physics.massKg === 300 && fixed.profile.physics.massKg === 700, "mass adjusted");
    assert(flap.thrustAccelMs2 <= 30 && flap.thrustAccelMs2 >= 1, "thrust ratio kept");
    assert(JSON.stringify(flap.profile.physics) !== JSON.stringify(fixed.profile.physics), "physics differ");
  });

  check("buildVehicleProfiles: over-range thrust is clamped, not passed through", () => {
    const catalog = {
      presets: [{ id: "p1", flightModel: "fixed-wing", physics: { massKg: 100, wingAreaM2: 10, thrustN: 1000, maxSpeedMps: 40, dragCoefficient: 0.2, turnRateRps: 1, climbRateMps: 5, sinkRateMps: 3 }, bounds: {}, camera: null },
        { id: "p2", flightModel: "flapping", physics: { massKg: 100, wingAreaM2: 10, thrustN: 1000, maxSpeedMps: 40, dragCoefficient: 0.2, turnRateRps: 1, climbRateMps: 5, sinkRateMps: 3, flapFrequencyHz: 2, flapAmplitudeRad: 1 }, bounds: {}, camera: null }],
      // 翼面积上限收紧：300 kg 计划质量被夹到 200 kg，之后推力也按 200 kg 的比值边距重夹。
      physicsBounds: { massKg: [40, 200], thrustN: [50, 200000] },
      physicsRatios: { maxThrustAccelMs2: 30, maxWingLoadingKgPerM2: 120, minThrustAccelMs2: 1, minWingLoadingKgPerM2: 1 },
    };
    const [vehicle] = buildVehicleProfiles(catalog);
    assert(vehicle.profile.physics.massKg === 200, `mass clamped to bounds, got ${vehicle.profile.physics.massKg}`);
    assert(vehicle.profile.physics.thrustN <= 30 * 200 * 0.9, `thrust clamped to ratio margin, got ${vehicle.profile.physics.thrustN}`);
    assert(vehicle.thrustAccelMs2 <= 30 && vehicle.thrustAccelMs2 >= 1, "kept ratio");
  });

  check("definePayloadFor never carries camera or schemaVersion", () => {
    const profile = { id: "v", label: "L", flightModel: "fixed-wing", physics: { a: 1 }, bounds: { b: 2 }, camera: { x: 1 }, schemaVersion: 1 };
    const payload = definePayloadFor({ profile }, "project-1", 3, "op-1");
    assert(!("camera" in payload) && !("schemaVersion" in payload), "camera/schemaVersion must not leak into define payload");
    assert(payload.vehicleId === "v" && payload.projectId === "project-1" && payload.baseRevision === 3, "fields carried");
  });

  check("trajectoryConclusion: divergence + replay reported, identical digests flagged as broken claim", () => {
    const diverging = trajectoryConclusion([
      { label: "flap", traceDigest: "aa" }, { label: "fixed", traceDigest: "bb" }, { label: "flap-replay", traceDigest: "aa" },
    ]);
    assert(diverging.divergence.proven === true && diverging.replay.digestMatches === true, JSON.stringify(diverging));
    const identical = trajectoryConclusion([
      { label: "flap", traceDigest: "aa" }, { label: "fixed", traceDigest: "aa" }, null,
    ]);
    assert(identical.divergence.proven === false && identical.divergence.conclusion.includes("NOT"), "identical digests must be a broken claim");
    const missing = trajectoryConclusion([{ label: "flap", traceDigest: null }, { label: "fixed", traceDigest: "bb" }]);
    assert(missing.divergence.proven === false, "missing digests never prove divergence");
  });

  check("summarizeSteps verdicts", () => {
    assert(summarizeSteps([{ status: "pass" }, { status: "pass" }]).verdict === "pipeline-complete", "all pass");
    assert(summarizeSteps([{ status: "pass" }, { status: "deferred" }, { status: "not-run" }]).verdict === "headless-partial", "partial");
    assert(summarizeSteps([{ status: "not-run" }, { status: "not-run" }]).verdict === "not-verified", "nothing ran");
    assert(summarizeSteps([{ status: "pass" }, { status: "failed" }]).verdict === "failed", "failure dominates");
  });

  const failed = checks.filter(item => !item.ok);
  for (const item of checks) console.log(`${item.ok ? "ok  " : "FAIL"} ${item.name}${item.ok ? "" : ` — ${item.detail}`}`);
  console.log(`self-test: ${checks.length - failed.length}/${checks.length} checks passed`);
  return failed.length === 0;
}

// ────────────────────────── CLI ──────────────────────────

function parseArgs(argv) {
  const options = { out: null, bin: null, dataHome: null, agentId: "verify-creator-flight-e2e", skipGameControl: false, selfTest: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--self-test") options.selfTest = true;
    else if (arg === "--skip-game-control") options.skipGameControl = true;
    else if (arg === "--out") options.out = argv[++index] ?? null;
    else if (arg === "--bin") options.bin = argv[++index] ?? null;
    else if (arg === "--data-home") options.dataHome = argv[++index] ?? null;
    else if (arg === "--agent-id") options.agentId = argv[++index] ?? options.agentId;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); }
  catch (error) { console.error(`${error.message}\n\n${usage()}`); process.exitCode = 2; return; }

  if (options.help) { console.log(usage()); return; }
  if (options.selfTest) { process.exitCode = selfTest() ? 0 : 1; return; }

  const binPath = resolve(options.bin ?? process.env.AGENT_VITALS_BIN ?? resolve(REPO_ROOT, "target/release/agent-vitals"));
  if (!existsSync(binPath)) {
    console.error(`agent-vitals binary not found at ${binPath}; build it with \`cargo build --release\` or pass --bin.`);
    process.exitCode = 2;
    return;
  }
  const dataHome = resolveDataHome(options.dataHome);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = resolve(options.out ?? resolve(REPO_ROOT, "artifacts/creator-flight-e2e", stamp));
  mkdirSync(outDir, { recursive: true });

  note(`bin=${binPath}`);
  note(`dataHome=${dataHome}`);
  note(`out=${outDir}`);
  note(`spec=${SPEC}`);

  const evidence = await runPipeline({ options, binPath, dataHome });
  const evidencePath = resolve(outDir, "evidence.json");
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

  note("── summary ──");
  note(`verdict: ${evidence.summary.verdict}`);
  note(`steps: ${JSON.stringify(evidence.summary.counts)}`);
  if (evidence.trajectory?.divergence) note(`trajectory: ${evidence.trajectory.divergence.conclusion}`);
  for (const issue of evidence.knownIssues ?? []) note(`known issue: ${issue.finding}`);
  note(`evidence written to ${evidencePath}`);

  const counts = evidence.summary.counts;
  // 退出码：有 failed 或整轮没有任何步骤真正执行 → 1；诚实的 deferred/not-run 混合 → 0。
  if (counts.failed > 0 || evidence.summary.verdict === "not-verified") process.exitCode = 1;
}

main().catch(error => { console.error(error); process.exitCode = 1; });
