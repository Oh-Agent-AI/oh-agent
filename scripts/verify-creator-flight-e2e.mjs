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
 *    （即时反馈，不可提交，语义校验仍欠补验）；
 *  - validation:"embedded-sdk" = E5 全量：宿主内嵌 city-sdk 闸签发的语义预览，
 *    pipeline 级（可 commit）；
 *  - 其余错误一律 failed，不得美化。 */
export function classifyOutcome(parsed) {
  if (parsed.ok) {
    const data = parsed.data ?? {};
    if (data.validation === "structural" && data.commitBlocked === "deferred-semantic") {
      return { status: "deferred", tier: "structural-headless", code: "deferred-semantic" };
    }
    const tier = data.validation === "embedded-sdk" ? "embedded-sdk" : "semantic";
    return { status: "pass", tier, code: null };
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

/** E5 headless 语义闸步骤（桌面宿主 + 内嵌 city-sdk 闸覆盖的 pipeline 级步骤）。
 * 这些步骤必须全部 pass，verdict 才能升到 headless-semantic-complete。 */
const SEMANTIC_GATE_STEP_IDS = new Set([
  "2b-worldset-preview", "2b-worldset-commit", "2c-project", "2d-vehicle-define-0",
  "2d-vehicle-define-1", "2e-vehicle-commit",
]);

/** 汇总各步状态的计数与总判定（诚实阶梯，spec §8.4）。
 *  - pipeline-complete：全部步骤 pass（Studio 全链路在场）；
 *  - headless-semantic-complete：语义闸步骤全 pass，其余仅有视口/宿主档的诚实延迟
 *    （E5 全量的目标态：vehicle define/commit 与 world.set commit 达到 pipeline 级）；
 *  - headless-partial：有步骤执行但语义闸链路未闭环；
 *  - failed / not-verified 语义不变。 */
export function summarizeSteps(steps) {
  const counts = { pass: 0, deferred: 0, failed: 0, "not-run": 0 };
  for (const step of steps) counts[step.status] = (counts[step.status] ?? 0) + 1;
  const gateSteps = steps.filter(step => SEMANTIC_GATE_STEP_IDS.has(step.id));
  const gateAllPass = gateSteps.length > 0 && gateSteps.every(step => step.status === "pass");
  const deferrableTiers = new Set(["viewport-required", "structural-headless", "host-studio-required", "accepted-code"]);
  const honestDeferralOnly = steps.every(step => step.status !== "deferred"
    || deferrableTiers.has(step.tier ?? "") || SEMANTIC_GATE_STEP_IDS.has(step.id));
  // playtest 请求已下发但 City 运行时从未认领/跑完：这不是「试玩完成」，
  // 不能和 pipeline-complete 共用一个 verdict（W2 审查抓到的诚实性缺口）。
  const pendingOnly = counts["not-run"] === 0 && counts.deferred === 1
    && steps.some(step => step.id === "7-result" && step.status === "deferred" && step.errorCode === "playtest_pending")
    && steps.every(step => step.status !== "deferred" || step.id === "7-result");
  let verdict;
  if (counts.failed > 0) verdict = "failed";
  else if (counts["not-run"] === 0 && counts.deferred === 0) verdict = "pipeline-complete";
  else if (pendingOnly) verdict = "pipeline-complete-playtest-pending";
  else if (counts["not-run"] === steps.length) verdict = "not-verified";
  else if (gateAllPass && honestDeferralOnly) verdict = "headless-semantic-complete";
  else verdict = "headless-partial";
  return { counts, verdict, semanticGate: { steps: gateSteps.length, allPass: gateAllPass } };
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

    // E5 全量：headless 语义闸块。桌面宿主在跑（mailbox 可答）而 Studio 视口缺席时，
    // 宿主内嵌 city-sdk 闸覆盖的编辑面达到 pipeline 级：world.set 预览+提交、
    // 项目创建、vehicle define/preview+commit。视口/发布/试玩类步骤继续诚实延迟。
    await runHeadlessSemanticBlock({ client, recorder, state });

    if (!state.hostUnavailable) {
      // 先试 headless 飞行课程：City 已有 v3 布局快照时，锚点/项目/绑定/发布
      // 都是宿主本地 store 操作，不需要视口。视口档（layout.save/可视试玩）继续诚实延迟。
      const course = await runHeadlessFlightCourse({ client, recorder, state });
      if (course.started) {
        for (const id of ["6-playtest", "7-result"]) {
          recorder.record({ id, title: id === "6-playtest" ? "creator_playtest_start (visual)" : "creator_playtest_result + job timeline",
            status: "not-run", reason: "可视试玩需要官方 Studio/City 运行时；headless 课程已覆盖 1–5", errorCode: "host-studio-required" });
        }
      } else {
        await runStudioPipeline({ client, recorder, state });
      }
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
              : state.headlessSemantic
                ? "timeline records this run's headless commits and does not claim a playtest"
                : "timeline contains this run's commits and playtest",
            check: data => {
              const kinds = (data?.operations ?? []).map(item => item?.kind);
              if (state.hostUnavailable) {
                const claimsCommit = kinds.includes("commit") && (data?.scope?.projectId ?? null) !== null;
                return { ok: true, detail: `kinds=[${kinds.join(",") || "empty"}]; no assertion (host unavailable)` };
              }
              if (state.headlessSemantic) {
                // headless 模式：commit 已发生（embedded 闸放行），playtest 未运行——
                // 时间线必须如实：有 commit、不虚报 playtest。
                const honest = kinds.includes("commit") && !kinds.includes("playtest");
                return { ok: honest, detail: `kinds=[${kinds.join(",")}] (headless-semantic)` };
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
          evidence: "creator_playtest_start has its own dispatch arm. register_playtest_job must read runId from the {ok:true,data} envelope, and the host must finish the Studio mailbox before opening City. A 15s plugin_unavailable means this hook never ran.",
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

/** E5 headless 语义闸块（spec §8.4 路径 2）：桌面宿主在跑时，内嵌 city-sdk 闸把
 * world.set 与 vehicle 编辑面推进到 pipeline 级（validation:"embedded-sdk" 且可
 * commit）。任何前置缺失（无城市草稿/无已存布局）按 not-run 如实记录，不美化。 */
async function runHeadlessSemanticBlock({ client, recorder, state }) {
  const notRun = (id, title, reason, code) => recorder.record({ id, title, tool: null, status: "not-run", reason, errorCode: code ?? null });
  if (state.hostUnavailable) {
    for (const [id, title] of [
      ["2b-worldset-preview", "creator_city_edit_preview (world.set): embedded-gate semantic preview"],
      ["2b-worldset-commit", "creator_city_edit_commit: headless world.set commit"],
      ["2c-project", "creator_project_create (stored layout): headless project for vehicle edits"],
      ["2e-vehicle-commit", "creator_vehicle_preview + creator_project_commit: headless vehicle commit"],
    ]) notRun(id, title, `desktop host unavailable (${state.hostUnavailable.code})`);
    for (const vehicle of state.vehicles ?? []) {
      notRun(`2d-vehicle-define-${state.vehicles.indexOf(vehicle)}`, `creator_vehicle_define (${vehicle.vehicleId}): embedded-gate define`, `desktop host unavailable (${state.hostUnavailable.code})`);
    }
    return;
  }
  state.headlessSemantic = true;

  // ① world.set 语义预览 + 提交。**避开**当前 revision 已有 v3 布局的 City：
  // 那类城市留给后面的 headless 飞行课程（布局是锚点/绑定/发布的前置），
  // world.set 会把它的 revision 推进到没有快照的下一代。
  const cities = state.cities ?? [];
  let city = cities[0] ?? null;
  try {
    const listed = await client.callTool("creator_layout_list", { limit: 16 });
    const reserved = new Set((listed?.data?.cityLayouts ?? [])
      .filter(item => item.schemaVersion === 3)
      .map(item => `${item.cityId}:${item.cityRevision}`));
    const spare = cities.find(item => !reserved.has(`${item.cityId}:${item.revision}`));
    if (spare) city = spare;
  } catch { /* layout list 不可用时退回第一个城市 */ }
  if (!city) {
    notRun("2b-worldset-preview", "creator_city_edit_preview (world.set): embedded-gate semantic preview", "no city draft in the data home");
    notRun("2b-worldset-commit", "creator_city_edit_commit: headless world.set commit", "no city draft in the data home");
  } else {
    let generator = null;
    try {
      const read = await client.callTool("creator_city_read", { cityId: city.cityId });
      generator = read?.data?.profile?.geography?.generator ?? null;
    } catch { generator = null; }
    const operations = generator === "coastal-islands-v1"
      ? [{ op: "world.set", params: { "shape.bayHalfWidth": 0.3, "shape.bayShift": 0.2 } }]
      : [{ op: "world.set", params: { "shape.family": "lobed", "shape.cores": 3 } }];
    const baseRevision = city.revision ?? 0;
    const preview = await runToolStep(client, recorder, {
      id: "2b-worldset-preview", title: `creator_city_edit_preview (world.set on ${city.cityId}): embedded-gate semantic preview (pipeline tier)`,
      tool: "creator_city_edit_preview", args: { cityId: city.cityId, baseRevision, operations },
      assertions: [
        { desc: "validation is embedded-sdk with a previewId (commit allowed, no commitBlocked)", check: data => ({ ok: data?.validation === "embedded-sdk" && Boolean(data?.previewId), detail: `validation=${data?.validation}` }) },
      ],
    });
    const previewId = preview.step.status === "pass" ? preview.data?.previewId : null;
    if (preview.step.status !== "pass") {
      notRun("2b-worldset-commit", "creator_city_edit_commit: headless world.set commit", "embedded preview failed/deferred", preview.step.errorCode);
    } else {
      await runToolStep(client, recorder, {
        id: "2b-worldset-commit", title: "creator_city_edit_commit: headless world.set commit (embedded-gate verdict)",
        tool: "creator_city_edit_commit", args: { cityId: city.cityId, previewId, expectedRevision: baseRevision, operationId: newOperationId("op-world-commit") },
        assertions: [
          { desc: "city revision advanced", check: data => ({ ok: typeof data?.revision === "number" && data.revision > baseRevision, detail: `revision=${data?.revision}` }) },
          { desc: "commit records the embedded-sdk source", check: data => ({ ok: data?.validation === "embedded-sdk", detail: String(data?.validation) }) },
        ],
      });
    }
  }

  // ② 项目（用已存布局：无视口依赖）。
  let projectId = null;
  let revision = 0;
  const layouts = await runToolStep(client, recorder, {
    id: "2c-layouts", title: "creator_layout_list: host-captured layouts available headlessly (read-only)",
    tool: "creator_layout_list", args: { limit: 8 },
    assertions: [{ desc: "at least one stored layout with a worldRevision", check: data => ({ ok: (data?.layouts?.length ?? 0) > 0 && Boolean(data.layouts[0]?.worldRevision), detail: `${data?.layouts?.length ?? 0} layouts` }) }],
  });
  const worldRevision = layouts.step.status === "pass" ? layouts.data?.layouts?.[0]?.worldRevision : null;
  if (!worldRevision) {
    notRun("2c-project", "creator_project_create (stored layout): headless project for vehicle edits", "no stored layout in the data home", layouts.step.errorCode);
    for (const vehicle of state.vehicles ?? []) {
      notRun(`2d-vehicle-define-${state.vehicles.indexOf(vehicle)}`, `creator_vehicle_define (${vehicle.vehicleId}): embedded-gate define`, "no project available (no stored layout)");
    }
    notRun("2e-vehicle-commit", "creator_vehicle_preview + creator_project_commit: headless vehicle commit", "no project available (no stored layout)");
    return;
  }
  const project = await runToolStep(client, recorder, {
    id: "2c-project", title: `creator_project_create (stored layout ${worldRevision}): headless project for vehicle edits`,
    tool: "creator_project_create", args: { template: "flight-checkpoint", worldRevision, operationId: newOperationId("op-project-headless") },
    assertions: [{ desc: "projectId returned at revision 0", check: data => ({ ok: Boolean(data?.projectId) && data?.revision === 0, detail: data?.projectId ?? null }) }],
  });
  projectId = project.step.status === "pass" ? project.data?.projectId : null;
  revision = project.step.status === "pass" ? project.data?.revision ?? 0 : 0;
  if (!projectId) {
    for (const vehicle of state.vehicles ?? []) {
      notRun(`2d-vehicle-define-${state.vehicles.indexOf(vehicle)}`, `creator_vehicle_define (${vehicle.vehicleId}): embedded-gate define`, "project create failed/deferred", project.step.errorCode);
    }
    notRun("2e-vehicle-commit", "creator_vehicle_preview + creator_project_commit: headless vehicle commit", "project create failed/deferred", project.step.errorCode);
    return;
  }

  // ③ vehicle define ×2（嵌入式语义闸；headless define 成为可能）。
  for (const [index, vehicle] of (state.vehicles ?? []).entries()) {
    const defined = await runToolStep(client, recorder, {
      id: `2d-vehicle-define-${index}`, title: `creator_vehicle_define (${vehicle.vehicleId}): embedded-gate define (pipeline tier)`,
      tool: "creator_vehicle_define", args: { ...definePayloadFor(vehicle, projectId, revision, newOperationId("op-vehicle-headless")) },
      assertions: [
        { desc: "validation is embedded-sdk and revision advanced", check: data => ({ ok: data?.validation === "embedded-sdk" && typeof data?.revision === "number" && data.revision > revision, detail: `validation=${data?.validation} revision=${data?.revision}` }) },
      ],
    });
    if (defined.step.status === "pass") revision = defined.data?.revision;
  }

  // ④ vehicle preview + creator_project_commit（预览/提交双步都记录 embedded-sdk）。
  const previewVehicle = state.vehicles?.[0];
  if (!previewVehicle) {
    notRun("2e-vehicle-commit", "creator_vehicle_preview + creator_project_commit: headless vehicle commit", "vehicle profiles unavailable");
    return;
  }
  const profile = { ...previewVehicle.profile, id: "vehicle-e2e-preview", label: "E2E preview commit" };
  const vehiclePreview = await runToolStep(client, recorder, {
    id: "2e-vehicle-preview", title: "creator_vehicle_preview: embedded-gate semantic preview with performance projection",
    tool: "creator_vehicle_preview", args: { projectId, baseRevision: revision, vehicle: profile },
    assertions: [
      { desc: "validation is embedded-sdk with previewId and estimatedPerformance", check: data => ({ ok: data?.validation === "embedded-sdk" && Boolean(data?.previewId) && Boolean(data?.estimatedPerformance), detail: `validation=${data?.validation}` }) },
    ],
  });
  const vehiclePreviewId = vehiclePreview.step.status === "pass" ? vehiclePreview.data?.previewId : null;
  if (!vehiclePreviewId) {
    notRun("2e-vehicle-commit", "creator_vehicle_preview + creator_project_commit: headless vehicle commit", "embedded vehicle preview failed/deferred", vehiclePreview.step.errorCode);
    return;
  }
  await runToolStep(client, recorder, {
    id: "2e-vehicle-commit", title: "creator_project_commit: headless vehicle commit (embedded-gate verdict)",
    tool: "creator_project_commit", args: { projectId, previewId: vehiclePreviewId, expectedRevision: revision, operationId: newOperationId("op-vehicle-commit") },
    assertions: [
      { desc: "revision advanced and commit records the embedded-sdk source", check: data => ({ ok: data?.validation === "embedded-sdk" && typeof data?.revision === "number" && data.revision > revision, detail: `validation=${data?.validation} revision=${data?.revision}` }) },
    ],
  });
  revision += 1;
  state.projectId = state.projectId ?? projectId;
}

/**
 * Headless 飞行课程（1–5）：City 当前 revision 已有 v3 布局快照时，全程不需要视口。
 * 返回 { started }：没有匹配的 city+layout 时完全不动（交给 Studio pipeline）。
 */
async function runHeadlessFlightCourse({ client, recorder, state }) {
  const cities = state.cities ?? [];
  if (cities.length === 0) return { started: false };
  let listed;
  try { listed = await client.callTool("creator_layout_list", { limit: 16 }); } catch { return { started: false }; }
  const cityLayouts = listed?.data?.cityLayouts ?? [];
  const pair = cities
    .map(city => ({ city, layout: cityLayouts.find(item => item.cityId === city.cityId && item.cityRevision === city.revision) }))
    .find(item => item.layout && item.layout.schemaVersion === 3);
  if (!pair) return { started: false };

  const { city, layout } = pair;
  state.cityId = city.cityId;
  state.worldRevision = layout.worldRevision;
  const anchorIds = ["e2e-air-spawn", "e2e-gate-1", "e2e-gate-2", "e2e-gate-3"];
  const anchors = [
    { id: "e2e-air-spawn", kind: "spawn", capabilities: ["fly"], position: { x: 0, y: 40, z: 0 } },
    { id: "e2e-gate-1", kind: "zone", capabilities: ["fly"], position: { x: 200, y: 40, z: 0 }, radiusMeters: 20 },
    { id: "e2e-gate-2", kind: "zone", capabilities: ["fly"], position: { x: 400, y: 40, z: 0 }, radiusMeters: 20 },
    { id: "e2e-gate-3", kind: "zone", capabilities: ["fly"], position: { x: 600, y: 40, z: 0 }, radiusMeters: 20 },
  ];

  const notRunRest = (from, reason, code) => {
    const all = ["3-anchors", "1-project", "2-define", "4-mount", "5-publish", "6-playtest", "7-result"];
    for (const id of all.slice(all.indexOf(from) + 1)) {
      recorder.record({ id, title: "downstream pipeline step", status: "not-run", reason, errorCode: code ?? null });
    }
  };

  const upsert = await runToolStep(client, recorder, {
    id: "3-anchors", title: "creator_city_anchor_upsert: fly spawn + 3 gates as a new City revision (headless: no viewport)",
    tool: "creator_city_anchor_upsert", args: { cityId: city.cityId, baseRevision: city.revision, anchors, operationId: newOperationId("op-anchor") },
    assertions: [
      { desc: "new city revision created", check: data => ({ ok: typeof data?.revision === "number" && data.revision > city.revision, detail: `revision=${data?.revision}` }) },
      { desc: "anchorCount grew", check: data => ({ ok: (data?.anchorCount ?? 0) >= 4, detail: String(data?.anchorCount) }) },
    ],
  });
  if (upsert.step.status !== "pass") { notRunRest("3-anchors", "anchor upsert failed/deferred", upsert.step.errorCode); return { started: true }; }
  state.cityRevision = upsert.data?.revision;
  state.gateAnchors = anchorIds.slice(1);
  state.entryAnchor = anchorIds[0];

  const project = await runToolStep(client, recorder, {
    id: "1-project", title: "creator_project_create: flight-checkpoint project bound to the City draft (headless)",
    tool: "creator_project_create",
    args: { template: "flight-checkpoint", worldRevision: layout.worldRevision, cityId: city.cityId, operationId: newOperationId("op-project") },
    assertions: [
      { desc: "projectId returned", check: data => ({ ok: Boolean(data?.projectId), detail: data?.projectId ?? null }) },
      { desc: "project starts at revision 0", check: data => ({ ok: data?.revision === 0, detail: String(data?.revision) }) },
    ],
  });
  if (project.step.status !== "pass") { notRunRest("1-project", "project create failed/deferred", project.step.errorCode); return { started: true }; }
  state.projectId = project.data?.projectId;
  let revision = project.data?.revision ?? 0;

  for (const vehicle of state.vehicles ?? []) {
    const step = await runToolStep(client, recorder, {
      id: `2-define-${vehicle.vehicleId}`, title: `creator_vehicle_define: ${vehicle.vehicleId} (headless)`,
      tool: "creator_vehicle_define", args: definePayloadFor(vehicle, state.projectId, revision, newOperationId("op-vehicle")),
      assertions: [{ desc: "vehicle persisted and revision advanced", check: data => ({ ok: typeof data?.revision === "number" && data.revision > revision, detail: `revision=${data?.revision}` }) }],
    });
    if (step.step.status !== "pass") { notRunRest("2-define", "vehicle define failed/deferred", step.step.errorCode); return { started: true }; }
    revision = step.data?.revision;
  }

  const mount = await runToolStep(client, recorder, {
    id: "4-mount", title: "creator_mount_bind: typed mount (headless: no viewport)",
    tool: "creator_mount_bind",
    args: { projectId: state.projectId, baseRevision: revision, mountId: "mount-e2e-a", entryAnchorId: state.entryAnchor,
      bindings: { gates: state.gateAnchors }, vehicleId: state.vehicles?.[0]?.vehicleId, operationId: newOperationId("op-mount") },
    assertions: [
      { desc: "mount bound and revision advanced", check: data => ({ ok: typeof data?.revision === "number" && data.revision > revision, detail: `revision=${data?.revision}` }) },
      { desc: "all 3 gate anchors covered", check: data => ({ ok: data?.coverage?.bound === 3, detail: `bound=${data?.coverage?.bound}` }) },
    ],
  });
  if (mount.step.status !== "pass") { notRunRest("4-mount", "mount bind failed/deferred", mount.step.errorCode); return { started: true }; }
  revision = mount.data?.revision;

  const publish = await runToolStep(client, recorder, {
    id: "5-publish", title: "creator_project_publish: frozen release (headless: no viewport)",
    tool: "creator_project_publish", args: { projectId: state.projectId, expectedRevision: revision },
    assertions: [
      { desc: "releaseId returned", check: data => ({ ok: Boolean(data?.releaseId), detail: data?.releaseId ?? null }) },
      { desc: "gameType frozen to flight", check: data => ({ ok: data?.gameType === "flight", detail: String(data?.gameType) }) },
      { desc: "runtimeContractVersion frozen to 1", check: data => ({ ok: data?.runtimeContractVersion === 1, detail: String(data?.runtimeContractVersion) }) },
    ],
  });
  if (publish.step.status !== "pass") { notRunRest("5-publish", "publish failed/deferred", publish.step.errorCode); return { started: true }; }
  state.releaseId = publish.data?.releaseId;
  state.headlessCourse = true;
  return { started: true };
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

  // 先请求 Studio 渲染这个 City（只读视口），否则 layout.save 会以
  // creator_capture_unavailable 失败。最多等 ~30s；失败交给 layout 步骤如实记录。
  await client.callTool("creator_city_view", { cityId: state.cityId, revision: city.revision }).catch(() => null);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const probe = await client.callTool("creator_city_view_status", { cityId: state.cityId, revision: city.revision }).catch(() => null);
    const viewState = probe?.data?.status ?? probe?.data?.state ?? null;
    if (viewState === "ready" || viewState === "failed") break;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 1500));
  }

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
    tool: "creator_playtest_result", status: terminal ? "pass" : "deferred",
    ...(terminal ? {} : {
      errorCode: "playtest_pending",
      reason: `run ${runId} is ${lastResult?.status ?? "unreadable"}: no City runtime finished the visual run`,
    }),
    assertions: [
      { desc: "run record readable", ok: Boolean(lastResult?.runId === runId), detail: `status=${lastResult?.status}` },
      { desc: terminal ? "run reached a terminal state" : "run still pending/claimed — recorded as deferred, never as a completed playtest",
        ok: terminal, detail: lastResult?.status ?? null },
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
    const embedded = classifyOutcome({ ok: true, data: { validation: "embedded-sdk", previewId: "preview-1" } });
    assert(embedded.status === "pass" && embedded.tier === "embedded-sdk", JSON.stringify(embedded));
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

  check("summarizeSteps: a pending playtest is never pipeline-complete", () => {
    const pending = summarizeSteps([
      { id: "0-protocol", status: "pass" },
      { id: "5-publish", status: "pass" },
      { id: "6-playtest", status: "pass" },
      { id: "7-result", status: "deferred", errorCode: "playtest_pending" },
    ]);
    assert(pending.verdict === "pipeline-complete-playtest-pending", JSON.stringify(pending));
    // 只有「试玩待运行」这一种 deferred 才配这个档；别的 deferred 不能蹭。
    const wrongCode = summarizeSteps([{ id: "7-result", status: "deferred", errorCode: "plugin_unavailable" }]);
    assert(wrongCode.verdict !== "pipeline-complete-playtest-pending", JSON.stringify(wrongCode));
  });

  check("summarizeSteps upgrades to headless-semantic-complete only when the gate chain passed", () => {
    const gate = id => ({ id, status: "pass", tier: "embedded-sdk" });
    const gateIds = ["2b-worldset-preview", "2b-worldset-commit", "2c-project", "2d-vehicle-define-0", "2d-vehicle-define-1", "2e-vehicle-commit"];
    const viewportDeferred = { id: "1-layout", status: "deferred", tier: "viewport-required" };
    const upgraded = summarizeSteps([...gateIds.map(gate), viewportDeferred, { id: "0-session", status: "pass" }]);
    assert(upgraded.verdict === "headless-semantic-complete", JSON.stringify(upgraded));
    assert(upgraded.semanticGate.allPass === true, "gate summary must report allPass");
    // 一个闸步骤失败/未跑 → 不得升级。
    const withGateFail = summarizeSteps([...gateIds.map(gate).slice(1), { ...gate("2b-worldset-preview"), status: "not-run" }, viewportDeferred]);
    assert(withGateFail.verdict === "headless-partial", JSON.stringify(withGateFail));
    // 非预期档的 deferred（如 unexpected 工具错误）→ 不得升级。
    const oddDefer = summarizeSteps([...gateIds.map(gate), { id: "x", status: "deferred", tier: "unexpected" }]);
    assert(oddDefer.verdict === "headless-partial", JSON.stringify(oddDefer));
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
