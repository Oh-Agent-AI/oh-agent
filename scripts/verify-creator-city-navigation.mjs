// Browser interaction regression using a synthetic host; no user City data.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "../apps/desktop/ui-dev/node_modules/playwright/index.mjs";

const port = await new Promise((resolve, reject) => {
  const server = createServer().listen(0, "127.0.0.1", () => {
    const value = server.address().port;
    server.close(() => resolve(value));
  });
  server.on("error", reject);
});
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
  cwd: new URL("../apps/creator-studio/ui/", import.meta.url), stdio: "ignore",
});
let browser;
try {
  const url = `http://127.0.0.1:${port}/`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error("Studio test server exited");
    try { if ((await fetch(url)).ok) { ready = true; break; } } catch { /* wait for Vite */ }
    await delay(100);
  }
  if (!ready) throw new Error("Studio test server did not start");
  browser = await chromium.launch({ headless: true, ...(process.env.CREATOR_TEST_CHROME ? { executablePath: process.env.CREATOR_TEST_CHROME } : {}), args: ["--use-gl=angle", "--use-angle=swiftshader"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => {
    const city = { schemaVersion: 1, cityId: "city-test", revision: 0, name: "测试沙漠", seed: 42,
      profile: { schemaVersion: 1, id: "arid-dunes", version: 1, biome: "arid", geography: { generator: "arid-dunes-v1", parameters: { dunes: { duneScale: 190, duneAmplitude: 11, orientationDeg: 18 } } }, visuals: { themeId: "desert" } } };
    const project = { projectId: "project-test", revision: 0, title: "测试项目", kind: "city-minigame-project", game: {}, mounts: [], scene: { schemaVersion: 1, objects: [] } };
    window.__testProject = project;
    let latestOperations = [];
    window.__testResponses = []; window.__testCommits = 0;
    window.__bindTestCity = revision => { project.cityId = city.cityId; project.cityRevision = city.revision; project.cityLayout = { seed: city.seed, worldRevision: revision, layout: { schemaVersion: 1, id: "synthetic-layout", coordinateSystem: "city-local-m-v1", anchors: [], links: [] } }; window.dispatchEvent(new Event("__CREATOR_PROJECT_CHANGED__")); };
    window.__AV_PLUGIN_INSTANCE__ = "studio-test";
    window.__TAURI__ = { core: { invoke: async (command, args) => {
      if (command !== "plugin_request") return {};
      const request = args.request;
      if (request.method === "plugin.call.respond") { window.__testResponses.push(request.payload); return { version: 1, requestId: request.requestId, ok: true, result: {} }; }
      if (request.method === "creator.scene.preview") latestOperations = structuredClone(request.payload.operations);
      if (request.method === "creator.project.commit") {
        window.__testCommits++; project.revision++;
        for (const operation of latestOperations) if (operation.op === "city.patch.upsert") project.cityPatch = structuredClone(operation.patch);
      }
      const results = { "creator.city.list": { cities: [{ cityId: city.cityId, revision: 0, name: city.name }], nextCursor: null },
        "creator.city.read": city, "creator.city.diagnostic.record": {}, "creator.project.list": { projects: [{ projectId: project.projectId, revision: project.revision, title: project.title }] }, "creator.project.read": project, "creator.layout.list": { layouts: [] },
        "creator.scene.preview": { previewId: "preview-test", projectId: project.projectId, baseRevision: request.payload.baseRevision, expiresInMs: 600000, changedObjects: [{ id: "skinId", action: "updated" }] },
        "creator.city.source.export": { directoryName: "city-source-1234", cityRevision: 0 } };
      return { version: 1, requestId: request.requestId, ok: true, result: results[request.method] ?? {} };
    } } };
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "项目", exact: true }).first().click();
  await page.getByRole("button", { name: /测试沙漠/ }).click();
  const back = page.getByRole("button", { name: "返回项目视图" });
  await back.waitFor();
  await page.waitForFunction(() => window.__CITY_VIEWPORT_PROBE__?.().worldRevision, null, { timeout: 60000 });
  const worldRevision = await page.evaluate(() => window.__CITY_VIEWPORT_PROBE__().worldRevision);
  const road = await page.evaluate(() => window.__CITY_VIEWPORT_PROBE__().roadCandidate);
  if (!road) throw new Error("Synthetic City has no editable road for preview test");
  await page.getByRole("button", { name: "导出城市源码…" }).click();
  await page.getByText(/城市源码已导出/).waitFor();
  await back.click();
  if (await back.count()) throw new Error("City preview did not close");
  await page.getByRole("button", { name: /测试项目/ }).click();
  const sendCall = async (id, method, payload) => page.evaluate(({ id, method, payload }) => {
    window.dispatchEvent(new CustomEvent("__AV_PLUGIN_EVENT__", { detail: { version: 1, source: "host", payload: { kind: "plugin.call.request", call: { callId: `pc_${id.repeat(32)}`, method, payload } } } }));
  }, { id, method, payload });
  await sendCall("a", "creator.scene.preview", { projectId: "project-test", baseRevision: 0, operations: [{ op: "skin.select", skinId: "miami-vice" }] });
  await page.waitForFunction(() => window.__testResponses.some(item => item.callId === `pc_${"a".repeat(32)}`));
  await sendCall("b", "creator.project.commit", { projectId: "project-test", previewId: "preview-test", expectedRevision: 0, operationId: "op-test" });
  await page.getByRole("group", { name: "等待确认的 Agent 修改" }).waitFor();
  await page.waitForFunction(() => window.__testResponses.some(item => item.callId === `pc_${"b".repeat(32)}` && item.response.error?.code === "creator_confirmation_required"));
  await sendCall("e", "creator.operation.status", { projectId: "project-test", operationId: "op-test" });
  await page.waitForFunction(() => window.__testResponses.some(item => item.callId === `pc_${"e".repeat(32)}` && item.response.result?.status === "awaiting_confirmation"));
  if (await page.evaluate(() => window.__testCommits) !== 0) throw new Error("Agent commit ran without confirmation");
  await page.getByRole("button", { name: "确认保存" }).click();
  await page.getByText(/Agent 修改已确认并保存/).waitFor();
  if (await page.evaluate(() => window.__testCommits) !== 1) throw new Error("User approval did not commit exactly once");
  await sendCall("c", "creator.scene.preview", { projectId: "project-test", baseRevision: 1, operations: [{ op: "skin.select", skinId: "miami-vice" }] });
  await page.waitForFunction(() => window.__testResponses.some(item => item.callId === `pc_${"c".repeat(32)}`));
  await sendCall("d", "creator.project.commit", { projectId: "project-test", previewId: "preview-test", expectedRevision: 1, operationId: "op-cancel" });
  const approval = page.getByRole("group", { name: "等待确认的 Agent 修改" });
  await approval.getByRole("button", { name: "取消" }).click();
  if (await page.evaluate(() => window.__testCommits) !== 1) throw new Error("Cancelled edit changed the project");
  const patch = { version: 1, seed: 42, scaleTier: 1, updatedAt: 0, roadOps: [], siteOps: [], buildingMoves: { building: "parcel" }, suppressedContext: [] };
  await sendCall("f", "creator.scene.preview", { projectId: "project-test", baseRevision: 1, operations: [{ op: "city.patch.upsert", patch }] });
  await page.waitForFunction(() => window.__testResponses.some(item => item.callId === `pc_${"f".repeat(32)}`));
  await sendCall("9", "creator.project.commit", { projectId: "project-test", previewId: "preview-test", expectedRevision: 1, operationId: "op-no-viewport" });
  const unavailable = page.getByRole("group", { name: "等待确认的 Agent 修改" });
  await unavailable.waitFor();
  if (!await unavailable.getByRole("button", { name: "确认保存" }).isDisabled()) throw new Error("City patch approval was enabled without a 3D preview");
  await unavailable.getByRole("button", { name: "取消" }).click();
  await page.evaluate(revision => window.__bindTestCity(revision), worldRevision);
  await page.waitForFunction(() => window.__CITY_VIEWPORT_PROBE__?.().worldRevision, null, { timeout: 60000 });
  await sendCall("1", "creator.scene.preview", { projectId: "project-test", baseRevision: 1, operations: [{ op: "city.patch.upsert", patch: { ...patch, buildingMoves: {}, generatorVersion: 6 } }] });
  await page.waitForFunction(() => window.__testResponses.some(item => item.callId === `pc_${"1".repeat(32)}`));
  await sendCall("2", "creator.project.commit", { projectId: "project-test", previewId: "preview-test", expectedRevision: 1, operationId: "op-city-preview" });
  const cityApproval = page.getByRole("group", { name: "等待确认的 Agent 修改" });
  await cityApproval.getByText(/三维临时预览已显示/).waitFor({ timeout: 60000 });
  if (await page.evaluate(() => window.__testCommits) !== 1) throw new Error("3D preview persisted without approval");
  await cityApproval.getByRole("button", { name: "取消" }).click();
  if (await page.evaluate(() => window.__testCommits) !== 1) throw new Error("Cancelling the 3D preview persisted changes");
  await sendCall("3", "creator.scene.preview", { projectId: "project-test", baseRevision: 1, operations: [{ op: "city.patch.upsert", patch: { ...patch, buildingMoves: {}, generatorVersion: 6, siteOps: [{ t: "remove", id: "missing-site" }] } }] });
  await page.waitForFunction(() => window.__testResponses.some(item => item.callId === `pc_${"3".repeat(32)}`));
  await sendCall("4", "creator.project.commit", { projectId: "project-test", previewId: "preview-test", expectedRevision: 1, operationId: "op-stale-preview" });
  const stale = page.getByRole("group", { name: "等待确认的 Agent 修改" });
  await stale.getByText(/预览失败或包含失效项/).waitFor({ timeout: 60000 });
  if (!await stale.getByRole("button", { name: "确认保存" }).isDisabled()) throw new Error("Stale City patch was enabled for approval");
  await stale.getByRole("button", { name: "取消" }).click();
  if (await page.evaluate(() => window.__testCommits) !== 1) throw new Error("Stale preview persisted changes");
  const roadPatch = { ...patch, buildingMoves: {}, generatorVersion: 6, roadOps: [{ t: "restyle", edge: road.id, width: road.width === 5 ? 8 : 5 }] };
  await sendCall("5", "creator.scene.preview", { projectId: "project-test", baseRevision: 1, operations: [{ op: "city.patch.upsert", patch: roadPatch }] });
  await page.waitForFunction(() => window.__testResponses.some(item => item.callId === `pc_${"5".repeat(32)}`));
  await sendCall("6", "creator.project.commit", { projectId: "project-test", previewId: "preview-test", expectedRevision: 1, operationId: "op-road-preview" });
  const roadApproval = page.getByRole("group", { name: "等待确认的 Agent 修改" });
  await roadApproval.getByText(/基准路网已匹配，三维临时预览已显示/).waitFor({ timeout: 60000 });
  if (await roadApproval.getByRole("button", { name: "确认保存" }).isDisabled()) throw new Error("Valid road change was not available for confirmation");
  if (await page.evaluate(() => window.__testCommits) !== 1) throw new Error("Road preview persisted changes");
  await roadApproval.getByRole("button", { name: "确认保存" }).click();
  await page.getByText(/Agent 修改已确认并保存/).waitFor();
  if (await page.evaluate(() => window.__testCommits) !== 2) throw new Error("Confirmed road edit did not commit exactly once");
  const savedRoad = await page.evaluate(() => window.__testProject.cityPatch?.roadOps?.[0]);
  if (savedRoad?.edge !== road.id || savedRoad?.width !== roadPatch.roadOps[0].width) throw new Error("Confirmed road edit did not survive project reload");
  console.log("Creator Studio synthetic browser: city navigation and Agent confirmation passed.");
} finally {
  await browser?.close();
  server.kill("SIGTERM");
}
