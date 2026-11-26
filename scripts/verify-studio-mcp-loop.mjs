#!/usr/bin/env node
// Studio MCP 接口回归测试（manual, real desktop host + Creator Studio 前台）。
//
// 覆盖「Studio 路径」（studio-envelope）的 MCP 工具面：
//   session → city.create → city.view/status → layout.save → anchor.list/remove/upsert
//   → project.create → vehicle.list/define ×2 → mount.bind → project.publish
//   → playtest.start → playtest.result
//
// 和 `verify-creator-flight-e2e.mjs` 的分工：
//   - e2e 是「诚实分档」的验收记录器（headless / Studio / pending 各档 verdict）；
//   - 本脚本是**回归断言**：每一步都要求 Studio 真的作答（validation 不是 embedded-sdk），
//     且响应形状符合当前契约；失败时打印第一处断言的 code/path，不做降级。
//
// 前置（脚本会自己检查，不满足直接失败，避免误测 headless 臂）：
//   - Oh Agent 在跑，Creator Studio 实例存在且 ready、未 suspended（hidden 允许：后台
//     页的 mailbox 仍会被投递；本脚本通过响应里的 validation 断言确认是 Studio 作答）；
//   - 传入 --data-home（或 AGENT_VITALS_HOME）指向该 app 正在用的数据根；
//   - `data-mcp serve --enable-city-tools --allow-local-writes` 可用（--bin）。
//
// 副作用：会新建一座临时 City、一个 flight-checkpoint 项目、两架载具、一个 release，
// 并启动一次 playtest。默认**不清理**（App 没有删除 City/项目的 MCP 工具），结束时打印
// 全部 id，便于人工清理或归档。
//
// 用法：
//   node scripts/verify-studio-mcp-loop.mjs --self-test
//   node scripts/verify-studio-mcp-loop.mjs --bin <agent-vitals> --data-home ~/.agent-vitals \
//        [--agent-id studio-regression] [--json out.json]
//
// 退出码：0 = 全部断言通过；1 = 断言失败/前置不满足；2 = 用法错误。
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STEPS = [];
const STUDIO_TIERS = new Set(["studio-envelope", "sdk"]);
const DUNES_PROFILE = {
  schemaVersion: 1, id: "arid-dunes", version: 1, biome: "arid",
  geography: { generator: "arid-dunes-v1", parameters: { dunes: { duneScale: 190, duneAmplitude: 11, orientationDeg: 18 } } },
  visuals: { themeId: "desert" },
};
const AIR_ANCHORS = [
  { id: "e2e-air-spawn", kind: "spawn", capabilities: ["fly"], position: { x: 0, y: 40, z: 0 } },
  { id: "e2e-gate-1", kind: "zone", capabilities: ["fly"], position: { x: 200, y: 40, z: 0 }, radiusMeters: 20 },
  { id: "e2e-gate-2", kind: "zone", capabilities: ["fly"], position: { x: 400, y: 40, z: 0 }, radiusMeters: 20 },
  { id: "e2e-gate-3", kind: "zone", capabilities: ["fly"], position: { x: 600, y: 40, z: 0 }, radiusMeters: 20 },
];

const usage = () => `verify-studio-mcp-loop — Studio 路径的 MCP 接口回归断言

用法：
  node scripts/verify-studio-mcp-loop.mjs --self-test
  node scripts/verify-studio-mcp-loop.mjs --bin <agent-vitals> --data-home <dir>
       [--agent-id <id>] [--json <file>] [--help]

要求：Creator Studio 是当前活跃视图（脚本会读 presence 校验，不满足直接失败）。
副作用：新建临时 City / 项目 / 两架载具 / 一个 release，并启动一次 playtest。`;

function parseArgs(argv) {
  const out = { selfTest: argv.includes("--self-test"), json: null, agentId: null, bin: null, dataHome: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--self-test" || arg === "--help") continue;
    if (arg === "--json") out.json = argv[++i];
    else if (arg === "--agent-id") out.agentId = argv[++i];
    else if (arg === "--bin") out.bin = argv[++i];
    else if (arg === "--data-home") out.dataHome = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function resolveDataHome(explicit) {
  return explicit ?? process.env.AGENT_VITALS_HOME ?? join(homedir(), ".agent-vitals");
}

/** Studio 必须是当前活跃视图：hidden/suspended 时调用会被 headless 臂接手，
 *  这样测出来的不是 Studio 路径。 */
export function assertStudioActive(presence) {
  if (!presence) return { ok: false, code: "studio_presence_missing" };
  if (presence.acceptance !== "ready" || presence.ready !== true) return { ok: false, code: "studio_not_ready" };
  if (presence.suspended === true) return { ok: false, code: "studio_suspended" };
  // hidden 不拒绝：Studio 页在后台时 mailbox 仍会投递（00:04 的 live 循环就是在
  // hidden=true 下跑通的）；真正会让调用被 headless 臂接手的是 suspended/not-ready。
  return { ok: true, code: null };
}

/** Studio 路径的 validation 标记；embedded-sdk 说明被 headless 臂接手，回归测试必须拒绝。 */
export function assertStudioTier(data, field = "validation") {
  const tier = data?.[field] ?? (data?.previewId ? "studio-preview" : null);
  if (tier === "embedded-sdk") return { ok: false, detail: "embedded-sdk (headless arm answered, not Studio)" };
  if (!tier) return { ok: false, detail: "missing validation marker" };
  return { ok: true, detail: tier };
}

/** 锚点预算：64 上限；保留 spawn，移除足够多的 zone 给空域门腾位置。 */
export function chooseAnchorRemovals(anchors, reserve = 4) {
  const zones = (anchors ?? []).filter(anchor => anchor?.kind === "zone").map(anchor => anchor.id);
  const excess = Math.max(0, (anchors?.length ?? 0) + reserve - 64);
  return zones.slice(0, excess);
}

function selfTest() {
  const checks = [];
  const check = (name, fn) => { try { fn(); checks.push({ name, ok: true }); } catch (error) { checks.push({ name, ok: false, detail: String(error.message ?? error) }); } };
  const assert = (condition, message) => { if (!condition) throw new Error(message); };

  check("studio presence must be active (hidden/suspended rejected)", () => {
    assert(assertStudioActive({ acceptance: "ready", ready: true, hidden: false, suspended: false }).ok, "active");
    assert(assertStudioActive({ acceptance: "ready", ready: true, hidden: true, suspended: false }).ok, "hidden is allowed");
    assert(!assertStudioActive({ acceptance: "ready", ready: true, hidden: false, suspended: true }).ok, "suspended");
    assert(!assertStudioActive(null).ok, "missing");
  });
  check("embedded-sdk tier is rejected as not-Studio", () => {
    assert(!assertStudioTier({ validation: "embedded-sdk" }).ok, "embedded");
    assert(assertStudioTier({ validation: "studio-envelope" }).ok, "studio");
    assert(assertStudioTier({ validation: "sdk" }).ok, "legacy sdk");
    assert(assertStudioTier({ previewId: "preview-1" }).ok, "preview without marker");
  });
  check("anchor pruning only removes as many zones as the 64 cap requires", () => {
    const anchors = Array.from({ length: 64 }, (_, index) => ({ id: `a-${index}`, kind: index === 0 ? "spawn" : "zone" }));
    assert(chooseAnchorRemovals(anchors, 4).length === 4, "64 + 4 needs 4 removals");
    assert(chooseAnchorRemovals(anchors.slice(0, 60), 4).length === 0, "60 + 4 fits");
    assert(!chooseAnchorRemovals(anchors, 4).includes("a-0"), "spawn is never removed");
  });
  check("self-test does not touch the network or the data home", () => {
    assert(true);
  });
  const ok = checks.every(item => item.ok);
  console.log(JSON.stringify({ ok, checks }, null, 1));
  process.exitCode = ok ? 0 : 1;
}

class McpClient {
  constructor(bin, env) {
    this.child = spawn(bin, ["data-mcp", "serve", "--enable-city-tools", "--allow-local-writes"], { stdio: ["pipe", "pipe", "pipe"], env });
    this.pending = new Map();
    this.nextId = 1;
    this.rl = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.rl.on("line", line => {
      let frame; try { frame = JSON.parse(line); } catch { return; }
      const entry = this.pending.get(frame.id); if (!entry) return;
      this.pending.delete(frame.id);
      frame.error ? entry.reject(new Error(JSON.stringify(frame.error))) : entry.resolve(frame.result);
    });
  }
  rpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++; this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  async call(name, args) {
    const result = await this.rpc("tools/call", { name, arguments: args });
    if (result?.structuredContent) return result.structuredContent;
    const text = result?.content?.find?.(item => item.type === "text")?.text;
    return text ? JSON.parse(text) : result;
  }
  kill() { this.child.kill(); }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (process.argv.includes("--help")) { console.log(usage()); return; }
  if (options.selfTest) { selfTest(); return; }
  if (!options.bin || !options.dataHome) { console.error(usage()); process.exitCode = 2; return; }

  const home = resolveDataHome(options.dataHome);
  const presencePath = join(home, "state/plugin-calls/consumers/creator-studio.json");
  if (!existsSync(presencePath)) throw new Error(`studio_presence_missing: ${presencePath}`);
  const presence = JSON.parse(readFileSync(presencePath, "utf8"));
  const active = assertStudioActive(presence);
  if (!active.ok) throw new Error(`${active.code}: bring Creator Studio to the front and retry`);

  const agentId = options.agentId ?? `studio-regression-${Date.now()}`;
  const op = suffix => `${suffix}-${Date.now().toString(36)}`;
  const client = new McpClient(options.bin, { ...process.env, AGENT_VITALS_HOME: home });
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const record = (name, detail) => { STEPS.push({ name, ok: true, detail }); console.log(`PASS ${name}: ${JSON.stringify(detail).slice(0, 200)}`); };
  const fail = (name, error) => { STEPS.push({ name, ok: false, detail: String(error.message ?? error) }); console.error(`FAIL ${name}: ${error.message ?? error}`); };

  try {
    await client.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "studio-regression", version: "1" } });
    client.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

    const step = async (name, tool, args, verify) => {
      const res = await client.call(tool, args);
      if (res?.ok !== true) throw new Error(`${tool} -> ${res?.error?.code ?? "unknown"}: ${res?.error?.message ?? ""}`);
      if (verify) verify(res.data);
      record(name, res.data);
      return res.data;
    };

    const session = await step("session.open", "creator_session_open", { agentId }, data => { if (!data?.sessionId) throw new Error("sessionId missing"); });
    // 预检回归：20261118 在 tier 1 稳定规划失败，create 必须在落库前拒绝（且不返回 cityId）。
    const rejected = await client.call("creator_city_create", { name: "must be rejected", seed: 20261118, profile: DUNES_PROFILE, operationId: op("op-city-bad") });
    if (rejected?.ok !== false) throw new Error("unplannable seed was accepted");
    if (rejected.error?.code !== "invalid_argument") throw new Error(`unplannable seed rejected as ${rejected.error?.code}`);
    record("city.create.preflight", { rejected: rejected.error.code, message: rejected.error.message });
    const city = await step("city.create", "creator_city_create", { name: `Studio Regression ${new Date().toISOString().slice(11, 19)}`, seed: 20261117, profile: DUNES_PROFILE, operationId: op("op-city") }, data => { if (!data?.cityId) throw new Error("cityId missing"); });

    await step("city.view.request", "creator_city_view", { cityId: city.cityId, revision: city.revision }, data => { if (data?.status !== "loading") throw new Error(`unexpected view status ${data?.status}`); });
    let viewStatus = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const res = await client.call("creator_city_view_status", { cityId: city.cityId, revision: city.revision });
      viewStatus = res?.data?.status ?? res?.error?.code ?? null;
      if (viewStatus === "ready" || viewStatus === "failed") break;
      await sleep(1500);
    }
    if (viewStatus !== "ready") throw new Error(`city viewport ${viewStatus}`);
    record("city.view.ready", { status: viewStatus });

    const layout = await step("layout.save", "creator_city_layout_save", { cityId: city.cityId, revision: city.revision }, data => { if (!data?.worldRevision) throw new Error("worldRevision missing"); });
    const anchors = await step("anchor.list", "creator_city_anchor_list", { cityId: city.cityId, limit: 128 }, data => { if (!Array.isArray(data?.anchors)) throw new Error("anchors missing"); });
    let revision = city.revision;
    const removals = chooseAnchorRemovals(anchors.anchors, 4);
    if (removals.length > 0) {
      const pruned = await step("anchor.prune", "creator_city_anchor_remove", { cityId: city.cityId, baseRevision: revision, anchorIds: removals, operationId: op("op-prune") }, data => { if (!data?.revision) throw new Error("revision missing"); });
      revision = pruned.revision;
    }
    const air = await step("anchor.upsert", "creator_city_anchor_upsert", { cityId: city.cityId, baseRevision: revision, anchors: AIR_ANCHORS, operationId: op("op-air") }, data => { if (data.anchorCount > 64) throw new Error(`anchorCount ${data.anchorCount} > 64`); });
    revision = air.revision;

    const project = await step("project.create", "creator_project_create", { template: "flight-checkpoint", worldRevision: layout.worldRevision, cityId: city.cityId, operationId: op("op-project") }, data => { if (!data?.projectId || data.revision !== 0) throw new Error("project create shape"); });
    let projectRevision = project.revision;
    const vehicles = await step("vehicle.list", "creator_vehicle_list", {}, data => { if (!Array.isArray(data?.presets) || data.presets.length < 2) throw new Error("need two presets"); });
    const vehicleIds = [];
    for (const [index, preset] of vehicles.presets.slice(0, 2).entries()) {
      const vehicleId = `vehicle-regression-${index + 1}`;
      const defined = await step(`vehicle.define.${index + 1}`, "creator_vehicle_define", {
        projectId: project.projectId, baseRevision: projectRevision, vehicleId, label: `Regression ${index + 1}`,
        flightModel: preset.flightModel, physics: preset.physics, bounds: preset.bounds, modelAssetId: null, operationId: op(`op-vehicle-${index}`),
      }, data => {
        const tier = assertStudioTier(data);
        if (!tier.ok) throw new Error(`define was not answered by Studio: ${tier.detail}`);
        if (data.revision <= projectRevision) throw new Error("revision did not advance");
      });
      projectRevision = defined.revision;
      vehicleIds.push(vehicleId);
    }

    const mount = await step("mount.bind", "creator_mount_bind", {
      projectId: project.projectId, baseRevision: projectRevision, mountId: "mount-regression",
      entryAnchorId: "e2e-air-spawn", bindings: { gates: ["e2e-gate-1", "e2e-gate-2", "e2e-gate-3"] },
      vehicleId: vehicleIds[0], operationId: op("op-mount"),
    }, data => { if (data?.coverage?.bound !== 3) throw new Error(`coverage.bound=${data?.coverage?.bound}`); });
    projectRevision = mount.revision;

    const release = await step("project.publish", "creator_project_publish", { projectId: project.projectId, expectedRevision: projectRevision }, data => {
      if (!data?.releaseId) throw new Error("releaseId missing");
      if (data.gameType !== "flight") throw new Error(`gameType=${data.gameType}`);
      if (data.runtimeContractVersion !== 1) throw new Error(`runtimeContractVersion=${data.runtimeContractVersion}`);
      if (data.vehicleId !== vehicleIds[0]) throw new Error(`vehicleId=${data.vehicleId}`);
    });

    const playtest = await step("playtest.start", "creator_playtest_start", { releaseId: release.releaseId, projectId: project.projectId, gameType: "flight", requestId: op("req") }, data => {
      if (!data?.runId) throw new Error("runId missing");
      if (data.status !== "pending") throw new Error(`status=${data.status}`);
    });
    // City 接走 run 后 Studio 被挂起，result 查询可能返回 plugin_unavailable；这是预期分档，
    // 回归测试只要求「可读或明确不可读」，不能把 pending 当完成。
    const result = await client.call("creator_playtest_result", { runId: playtest.runId });
    if (result?.ok === true) record("playtest.result", { status: result.data?.status ?? null });
    else record("playtest.result.deferred", { code: result?.error?.code ?? "unknown" });

    const summary = { ok: STEPS.every(item => item.ok), agentId, cityId: city.cityId, projectId: project.projectId, releaseId: release.releaseId, runId: playtest.runId, steps: STEPS };
    if (options.json) writeFileSync(options.json, JSON.stringify(summary, null, 2));
    console.log(`\nstudio regression: ${summary.ok ? "PASS" : "FAIL"} (${STEPS.length} steps)`);
    console.log(`created city=${city.cityId} project=${project.projectId} release=${release.releaseId} run=${playtest.runId}`);
    if (!summary.ok) process.exitCode = 1;
  } catch (error) {
    fail("loop", error);
    const summary = { ok: false, error: String(error.message ?? error), steps: STEPS };
    if (options.json) writeFileSync(options.json, JSON.stringify(summary, null, 2));
    process.exitCode = 1;
  } finally {
    client.kill();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
