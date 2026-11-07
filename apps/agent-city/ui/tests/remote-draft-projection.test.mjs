// Run from apps/agent-city/ui: node --test tests/remote-draft-projection.test.mjs
// Browser tests use a synthetic client and real rule implementations.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import { createServer } from "vite";
const require = createRequire(new URL("../../../desktop/ui-dev/package.json", import.meta.url));
const { chromium } = require("playwright");
const server = await createServer({ server: { port: 0, host: "127.0.0.1" }, optimizeDeps: { noDiscovery: true, include: ["react", "react/jsx-runtime", "react-dom/client"] }, logLevel: "error" });
await server.listen();
const { remoteDraftProjection } = await server.ssrLoadModule("/src/remote/RemoteApp.tsx");
const { createMatch, legalActions, validateAndApplyPlan } = await server.ssrLoadModule("/src/game/mecha/rules.ts");
const { emit, swapEventSink } = await server.ssrLoadModule("/src/game/mecha/board.ts");
const base = `http://127.0.0.1:${server.httpServer.address().port}`;
const land = Array.from({ length: 10 }, () => Array(10).fill("land"));
const heights = Array.from({ length: 10 }, () => Array(10).fill(0));
const fresh = () => Object.fromEntries(["Assault", "Gunner", "Support"].map((id) => [id, { moveTo: null, action: { kind: "skip" }, explicit: false }]));
function pve() {
  const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], terrain: land, heights, buildings: [], obstacles: [],
    mechs: [{ id: "Assault", pos: { x: 4, y: 6 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 8, y: 9 } }], boss: { x: 4, y: 2 }, raiders: [{ id: "r1", pos: { x: 8, y: 2 } }] });
  state.phase = "player_plan";
  return state;
}
test.after(async () => { await server.close(); });

test("PvE actions use post-move positions without mutating authority", () => {
  for (const [state, target] of [[pve(), "boss"]]) {
    const before = structuredClone(state), draft = fresh();
    assert.equal(legalActions(remoteDraftProjection(state, draft).state, "Assault").some((a) => a.kind === "melee"), false);
    draft.Assault = { moveTo: { x: 4, y: 4 }, action: { kind: "melee", target }, explicit: true };
    const moved = remoteDraftProjection(state, draft);
    assert.equal(moved.movement.status, "ok"); assert.equal(moved.plan.status, "ok");
    assert.deepEqual(moved.invalid, []);
    assert.ok(legalActions(moved.state, "Assault").some((a) => a.kind === "melee"));
    draft.Assault.moveTo = { x: 4, y: 6 };
    const stale = remoteDraftProjection(state, draft);
    assert.deepEqual(stale.invalid, ["Assault"]); assert.equal(stale.plan.status, "rejected");
    assert.deepEqual(state, before);
  }
});

test("implicit draft actions hold in both local and remote planning", () => {
  for (const state of [pve()]) {
    const draft = fresh();
    // An unconfirmed or stale action is not a command, even if present in draft memory.
    draft.Assault.action = { kind: "melee", target: "invalid" };
    const result = remoteDraftProjection(state, draft);
    assert.equal(result.movement.status, "ok");
    assert.equal(result.plan.status, "ok");
    assert.deepEqual(result.invalid, []);
  }
});

test("movement conflicts, unreachable cells, following and swaps follow authority", () => {
  for (const state of [pve()]) {
    const draft = fresh();
    draft.Assault.moveTo = { x: 2, y: 8 }; draft.Gunner.moveTo = { x: 2, y: 8 };
    let result = remoteDraftProjection(state, draft);
    assert.equal(result.movement.status, "rejected"); assert.equal(result.movement.fault.cause, "occupied"); assert.equal(result.state, null);
    draft.Gunner.moveTo = { x: 9, y: 9 };
    assert.equal(remoteDraftProjection(state, draft).movement.status, "rejected");
    const actors = state.mechs ?? state.units.filter((u) => u.side === "A");
    const get = (id) => actors.find((a) => (a.kind ?? a.id) === id);
    get("Assault").pos = { x: 3, y: 7 }; get("Gunner").pos = { x: 4, y: 7 };
    draft.Assault.moveTo = { x: 4, y: 7 }; draft.Gunner.moveTo = { x: 3, y: 7 };
    result = remoteDraftProjection(state, draft);
    assert.equal(result.movement.status, "ok"); assert.deepEqual(result.state.mechs.find((m) => m.id === "Assault").pos, { x: 4, y: 7 });
    draft.Gunner.moveTo = { x: 5, y: 7 };
    assert.equal(remoteDraftProjection(state, draft).movement.status, "ok");
    draft.Gunner.moveTo = null;
    assert.equal(remoteDraftProjection(state, draft).movement.status, "rejected");
  }
});

test("moving an ally invalidates repair and unrelated targets are not accepted", () => {
  for (const state of [pve()]) {
    const actors = state.mechs ?? state.units.filter((u) => u.side === "A");
    const get = (id) => actors.find((a) => (a.kind ?? a.id) === id);
    get("Support").pos = { x: 2, y: 8 }; get("Gunner").pos = { x: 2, y: 7 };
    const draft = fresh();
    draft.Support = { moveTo: null, action: { kind: "repair", target: "Gunner" }, explicit: true };
    assert.deepEqual(remoteDraftProjection(state, draft).invalid, []);
    draft.Gunner.moveTo = { x: 0, y: 7 };
    assert.deepEqual(remoteDraftProjection(state, draft).invalid, ["Support"]);
    draft.Support.action = { kind: "skip" }; draft.Gunner.moveTo = null;
    draft.Assault = { moveTo: { x: 4, y: 4 }, action: { kind: "melee", target: "nonexistent" }, explicit: true };
    assert.deepEqual(remoteDraftProjection(state, draft).invalid, ["Assault"]);
  }
});

test("unknown exceptions never appear as a legal projection", () => {
  const state = pve(), clone = globalThis.structuredClone;
  try {
    globalThis.structuredClone = () => { throw new Error("synthetic failure"); };
    const result = remoteDraftProjection(state, fresh());
    assert.equal(result.movement.status, "unknown"); assert.equal(result.state, null);
  } finally { globalThis.structuredClone = clone; }
  let count = 0;
  let cloneCalls = 0;
  try {
    globalThis.structuredClone = (value) => { cloneCalls++; return clone(value); };
    const baseline = remoteDraftProjection(state, fresh());
    assert.equal(baseline.plan.status, "ok");
    count = 0;
    globalThis.structuredClone = (value) => { if (++count === cloneCalls) throw new Error("plan check failed"); return clone(value); };
    const result = remoteDraftProjection(state, fresh());
    assert.equal(result.movement.status, "ok"); assert.equal(result.plan.status, "unknown");
    assert.ok(result.state);
  } finally { globalThis.structuredClone = clone; }
});

test("PvE preflights do not leak events and restore the enclosing sink on rejection or exception", () => {
  const state = pve(), draft = fresh(), outer = [], previous = swapEventSink(outer);
  const clone = globalThis.structuredClone;
  const marker = { type: "move", mechId: "Gunner", from: { x: 0, y: 9 }, to: { x: 0, y: 8 } };
  try {
    draft.Assault = { moveTo: { x: 4, y: 4 }, action: { kind: "melee", target: "boss" }, explicit: true };
    const plan = { revision: state.revision, items: Object.entries(draft).map(([mechId, item]) => ({ mechId, moveTo: item.moveTo, action: item.action })) };
    assert.equal(validateAndApplyPlan(clone(state), plan).ok, true);
    assert.ok(outer.some((event) => event.type === "move"));
    assert.ok(outer.some((event) => event.type === "act"));
    outer.length = 0;
    assert.equal(remoteDraftProjection(state, draft).plan.status, "ok");
    assert.deepEqual(outer, []);
    emit(marker); assert.deepEqual(outer, [marker]); outer.length = 0;
    draft.Assault.action = { kind: "melee", target: "missing" };
    const badPlan = { ...plan, items: plan.items.map((item) => item.mechId === "Assault" ? { ...item, action: draft.Assault.action } : item) };
    assert.equal("ok" in validateAndApplyPlan(clone(state), badPlan), false);
    assert.ok(outer.some((event) => event.type === "move"), "direct rejection emits trial movement");
    outer.length = 0;
    const rejected = remoteDraftProjection(state, draft);
    assert.equal(rejected.movement.status, "ok"); assert.equal(rejected.plan.status, "rejected");
    assert.deepEqual(outer, []);
    emit(marker); assert.deepEqual(outer, [marker]); outer.length = 0;
    // The movement phase emits before action validation reads kind and throws.
    draft.Assault.action = { get kind() { throw new Error("action failure"); } };
    const actionFailure = remoteDraftProjection(state, draft);
    assert.equal(actionFailure.movement.status, "ok");
    assert.equal(actionFailure.actionUnknown, true);
    assert.equal(actionFailure.plan.status, "unknown");
    assert.deepEqual(outer, []);
    emit(marker); assert.deepEqual(outer, [marker]); outer.length = 0;
    globalThis.structuredClone = () => { throw new Error("preflight failure"); };
    assert.equal(remoteDraftProjection(state, draft).movement.status, "unknown");
    assert.deepEqual(outer, []);
    emit(marker); assert.deepEqual(outer, [marker]);
  } finally {
    globalThis.structuredClone = clone;
    assert.equal(swapEventSink(previous), outer);
  }
});

test("remote UI keeps input locked until the visible 3D turn finishes", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ locale: "en-US" }), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const state = pve();
    const { playTurn } = await server.ssrLoadModule("/src/game/mecha/rules.ts");
    const plan = { revision: state.revision, items: state.mechs.map((mech) => ({ mechId: mech.id, moveTo: null, action: { kind: "skip" } })) };
    const result = playTurn(state, plan);
    assert.equal(result.ok, true);
    const snapshot = { state, mode: "pve", matchId: "m1", revision: state.revision, status: "active", ruleset: state.ruleset, players: [{ playerId: "owner", side: "A", role: "host" }] };
    const turn = { type: "turn.resolved", protocol: "mecha-net:v1", matchId: "m1", playerId: "owner", commandId: "t1", revision: result.state.revision, state: result.state, log: result.log, presentationStages: result.presentationStages };
    await page.addInitScript(({ snapshot, turn }) => { globalThis.testSnapshot = snapshot; globalThis.testTurn = turn; globalThis.appliedRevisions = []; }, { snapshot, turn });
    await page.route("**/src/remote/remoteAccess.ts*", (route) => route.fulfill({ contentType: "text/javascript", body: `const client = { snapshot: async () => ({ok:true,value:globalThis.testSnapshot}), onStatus: fn => { fn("online"); return () => {}; }, subscribe: fn => {globalThis.emitMatchEvent=fn;return () => {};}, dispose: () => {} }; export function useRemoteAccess() { return { client, playerId:"owner", status:"ready", error:"" }; }` }));
    await page.route("**/src/game/mecha/presentation/RemoteBattleScene.ts*", (route) => route.fulfill({ contentType: "text/javascript", body: `export class RemoteBattleScene { applySnapshot(s) {globalThis.appliedRevisions.push(s.revision)} setPaused() {} dispose() {} playTurn() {return new Promise(resolve => {globalThis.finishTurn=resolve})} }` }));
    await page.goto(`${base}/remote.html?match=m1`);
    const mech = page.locator(".remote-mechs button").first();
    await mech.waitFor(); await page.waitForFunction(() => !document.querySelector(".remote-mechs button").disabled);
    await page.evaluate(() => { globalThis.testSnapshot = { ...globalThis.testSnapshot, revision: globalThis.testTurn.revision, state: globalThis.testTurn.state }; globalThis.emitMatchEvent({ type: "turn.resolved", result: globalThis.testTurn }); });
    await page.getByText("Playing turn; input paused").waitFor();
    assert.equal(await mech.isDisabled(), true);
    await page.getByText("Online", { exact: true }).click();
    assert.deepEqual(await page.evaluate(() => globalThis.appliedRevisions), [state.revision]);
    assert.equal(await mech.isDisabled(), true);
    await page.evaluate(() => globalThis.finishTurn());
    await page.waitForFunction(() => !document.querySelector(".remote-mechs button").disabled);
    assert.deepEqual(errors, []);
    await page.close();
  } finally { await browser.close(); }
});

test("uncertain submission stays locked on same-revision snapshots and retries the identical command", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const locale of ["en-US", "zh-CN"]) {
      const state = pve();
      const snapshot = { state, mode: "pve", matchId: "m1", revision: 0, status: "active", ruleset: state.ruleset, players: [{ playerId: "owner", side: "A", role: "host" }] };
      const page = await browser.newPage({ locale, viewport: { width: 390, height: 844 } });
      const errors = []; page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript((value) => { globalThis.testSnapshot = value; globalThis.submittedPlans = []; globalThis.responses = []; }, snapshot);
      await page.route("**/src/remote/remoteAccess.ts*", (route) => route.fulfill({ contentType: "text/javascript", body: `const client = { snapshot: async () => ({ok:true,value:structuredClone(globalThis.testSnapshot)}), submitPlan: command => { globalThis.submittedPlans.push(structuredClone(command)); return new Promise((resolve,reject) => globalThis.responses.push({resolve,reject})); }, onStatus: fn => { fn("online"); return () => {}; }, subscribe: fn => { globalThis.emitMatchEvent = fn; return () => {}; }, dispose: () => {} }; export function useRemoteAccess() { return { client, playerId:"owner", status:"ready", error:"" }; }` }));
      await page.route("**/src/game/mecha/presentation/RemoteBattleScene.ts*", (route) => route.fulfill({ contentType: "text/javascript", body: `export class RemoteBattleScene { applySnapshot() {} setPaused() {} dispose() {} async playTurn() {} }` }));
      await page.goto(`${base}/remote.html?match=m1`);
      for (let i = 0; i < 3; i++) {
        await page.locator(".remote-mechs button").nth(i).click();
        await page.locator(".remote-actions button").getByText("skip", { exact: true }).click();
      }
      await page.locator(".remote-submit").click();
      await page.evaluate(() => globalThis.responses[0].reject(new Error("host_offline")));
      await page.locator(".remote-pending").waitFor();
      assert.equal(await page.evaluate(() => { const e = new Event("beforeunload", {cancelable:true}); window.dispatchEvent(e); return e.defaultPrevented; }), true);
      await page.getByText(locale === "zh-CN" ? "同一标签页刷新后" : "This tab attempts to retain the pending lock", { exact: false }).waitFor();
      const retry = page.locator(".remote-pending button");
      await page.waitForFunction(() => !document.querySelector(".remote-pending button").disabled);
      assert.equal(await page.locator(".remote-submit").isDisabled(), true);
      assert.equal(await page.locator(".remote-mechs button").first().isDisabled(), true);
      if (process.env.MECHA_PENDING_SCREENSHOTS) await page.screenshot({ path: `${process.env.MECHA_PENDING_SCREENSHOTS}/pending-${locale}.png`, fullPage: true });
      await page.locator("header button").click();
      await page.waitForFunction(() => !document.querySelector(".remote-pending button").disabled);
      assert.equal(await page.locator(".remote-pending").count(), 1);
      await retry.click();
      await page.evaluate(() => globalThis.responses[1].resolve({ok:false,error:{code:"not_your_turn"}}));
      await page.waitForFunction(() => !document.querySelector(".remote-pending button").disabled);
      assert.equal(await page.locator(".remote-pending").count(), 1);
      assert.equal(await page.evaluate(() => Object.keys(sessionStorage).filter(k => k.startsWith("mecha-pending:v1:")).length), 1);
      await retry.click();
      const commands = await page.evaluate(() => globalThis.submittedPlans);
      assert.equal(commands.length, 3); assert.deepEqual(commands[0], commands[1]); assert.deepEqual(commands[0], commands[2]);
      const { playTurn } = await server.ssrLoadModule("/src/game/mecha/rules.ts");
      const played = playTurn(state, commands[0].plan); assert.equal(played.ok, true);
      const turn = { type: "turn.resolved", protocol: "mecha-net:v1", matchId: "m1", playerId: "owner", commandId: commands[0].commandId, revision: played.state.revision, state: played.state, log: played.log, presentationStages: played.presentationStages };
      // The event may arrive before the retry response, which must not undo it.
      await page.evaluate((value) => { globalThis.emitMatchEvent({type:"turn.resolved",result:value}); globalThis.responses[2].resolve({ok:false,error:{code:"unavailable"}}); }, turn);
      await page.waitForFunction(() => !document.querySelector(".remote-pending"));
      assert.equal(await page.evaluate(() => { const e = new Event("beforeunload", {cancelable:true}); window.dispatchEvent(e); return e.defaultPrevented; }), false);
      assert.match(await page.locator(".remote-status").innerText(), /rev 3/);
      assert.deepEqual(errors, []); await page.close();
    }
  } finally { await browser.close(); }
});

test("same-revision match replacement cannot retry an old plan into changed authority", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const state = pve();
    const snapshot = { state, mode: "pve", matchId: "m1", revision: 0, status: "active", ruleset: state.ruleset, players: [{ playerId: "owner", side: "A", role: "host" }] };
    const page = await browser.newPage({ locale: "en-US" });
    await page.addInitScript((value) => { globalThis.testSnapshot = value; globalThis.submittedPlans = []; }, snapshot);
    await page.route("**/src/remote/remoteAccess.ts*", (route) => route.fulfill({ contentType: "text/javascript", body: `const client = { snapshot: async () => ({ok:true,value:structuredClone(globalThis.testSnapshot)}), submitPlan: async command => { globalThis.submittedPlans.push(command); throw new Error("host_offline"); }, onStatus: fn => { fn("online"); return () => {}; }, subscribe: fn => { globalThis.emitMatchEvent = fn; return () => {}; }, dispose: () => {} }; export function useRemoteAccess() { return { client, playerId:"owner", status:"ready", error:"" }; }` }));
    await page.route("**/src/game/mecha/presentation/RemoteBattleScene.ts*", (route) => route.fulfill({ contentType: "text/javascript", body: `export class RemoteBattleScene { applySnapshot() {} setPaused() {} dispose() {} async playTurn() {} }` }));
    await page.goto(`${base}/remote.html?match=m1`);
    for (let i = 0; i < 3; i++) { await page.locator(".remote-mechs button").nth(i).click(); await page.locator(".remote-actions button").getByText("skip", { exact: true }).click(); }
    await page.locator(".remote-submit").click(); await page.locator(".remote-pending").waitFor();
    const replacementState = pve(); replacementState.raiders[0].hp--;
    const replacement = { ...snapshot, state: replacementState };
    await page.evaluate((value) => globalThis.emitMatchEvent({type:"match.replaced",snapshot:value}), replacement);
    await page.getByText(/battlefield changed without a new revision/).waitFor();
    assert.equal(await page.locator(".remote-pending button").isDisabled(), true);
    assert.equal((await page.evaluate(() => globalThis.submittedPlans)).length, 1);
    // A newer authority snapshot makes the old base revision safe to retire.
    const newer = structuredClone(replacement); newer.revision = 1; newer.state.revision = 1;
    await page.evaluate((value) => globalThis.emitMatchEvent({type:"match.replaced",snapshot:value}), newer);
    await page.waitForFunction(() => !document.querySelector(".remote-pending"));
    await page.close();
  } finally { await browser.close(); }
});


test("pending deployment remains locked across same-revision phase replacement and remount", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const outcome of ["unknown", "forbidden"]) {
      const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", deployment: true });
      const snapshot = { state, mode: "pve", matchId: "m1", revision: state.revision, status: "active", ruleset: state.ruleset, players: [{ playerId: "owner", side: "A", role: "host" }] };
      const page = await browser.newPage({ locale: "en-US" });
      const errors = []; page.on("pageerror", error => errors.push(error.message));
      await page.addInitScript(value => { globalThis.testSnapshot = value; globalThis.commands = []; globalThis.responses = []; }, snapshot);
      await page.route("**/src/remote/remoteAccess.ts*", route => route.fulfill({ contentType: "text/javascript", body: `const client = { snapshot: async () => ({ok:true,value:structuredClone(globalThis.testSnapshot)}), submitDeployment: command => { globalThis.commands.push(structuredClone(command)); return new Promise((resolve,reject) => globalThis.responses.push({resolve,reject})); }, onStatus: fn => { fn("online"); return () => {}; }, subscribe: fn => { globalThis.emitMatchEvent = fn; return () => {}; }, dispose: () => {} }; export function useRemoteAccess() { return { client, playerId:"owner", status:"ready", error:"" }; }` }));
      await page.route("**/src/game/mecha/presentation/RemoteBattleScene.ts*", route => route.fulfill({ contentType: "text/javascript", body: `export class RemoteBattleScene { applySnapshot() {} setPaused() {} dispose() {} async playTurn() {} setDeploymentPreview() {} }` }));
      await page.goto(`${base}/remote.html?match=m1`);
      const legal = page.locator(".remote-row button.deployable");
      await page.waitForFunction(() => !document.querySelector(".remote-row button.deployable")?.disabled);
      await legal.nth(0).click();
      await page.getByRole("button", { name: /Gunner/ }).click(); await legal.nth(1).click();
      await page.getByRole("button", { name: /Support/ }).click(); await legal.nth(2).click();
      await page.getByRole("button", { name: "Confirm deployment" }).click();
      await page.waitForFunction(() => globalThis.commands.length === 1);
      assert.equal(await page.evaluate(() => { const e = new Event("beforeunload", {cancelable:true}); window.dispatchEvent(e); return e.defaultPrevented; }), true);
      const corrected = structuredClone(snapshot); corrected.state.phase = "player_plan";
      await page.evaluate(value => { globalThis.testSnapshot = value; globalThis.emitMatchEvent({type:"match.replaced",snapshot:value}); }, corrected);
      await page.getByText("A previous deployment is unconfirmed.", { exact: false }).waitFor();
      assert.equal(await page.locator(".remote-mechs button").first().isDisabled(), true);
      await page.evaluate(value => { globalThis.testSnapshot = value; globalThis.emitMatchEvent({type:"match.replaced",snapshot:value}); }, snapshot);
      await page.getByText("A previous deployment is unconfirmed.", { exact: false }).waitFor();
      assert.equal(await legal.first().isDisabled(), true);
      assert.equal(await page.getByRole("button", { name: "Confirm deployment" }).isDisabled(), true);
      if (outcome === "unknown") {
        await page.evaluate(() => globalThis.responses[0].reject(new Error("host_offline")));
        await page.waitForTimeout(100);
        assert.equal(await legal.first().isDisabled(), true);
        const newer = structuredClone(snapshot); newer.revision++; newer.state.revision++;
        await page.evaluate(value => globalThis.emitMatchEvent({type:"match.replaced",snapshot:value}), newer);
      } else {
        await page.evaluate(() => globalThis.responses[0].resolve({ok:false,error:{code:"forbidden"}}));
      }
      await page.waitForFunction(() => !document.querySelector(".remote-row button.deployable")?.disabled);
      assert.equal(await page.evaluate(() => { const e = new Event("beforeunload", {cancelable:true}); window.dispatchEvent(e); return e.defaultPrevented; }), false);
      assert.equal((await page.evaluate(() => globalThis.commands)).length, 1);
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
});

// Synthetic client and authority; not a production relay or real-device test.
test("journal read, write and corruption failures block remote PvE plans", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const failure of ["read", "write", "corrupt"]) {
      const state = pve();
      const snapshot = { state, mode: "pve", matchId: "m1", revision: 0, status: "active", ruleset: state.ruleset, players: [{ playerId: "owner", side: "A", role: "host" }] };
      const page = await browser.newPage({ locale: "en-US" });
      await page.addInitScript(({ value, failure }) => {
        globalThis.testSnapshot = value; globalThis.commands = [];
        const key = `mecha-pending:v1:${JSON.stringify(["mecha:v3", "m1", "owner", "", "", ""])}`;
        if (failure === "corrupt") sessionStorage.setItem(key, "{broken");
        const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
        Storage.prototype.getItem = function(k) { if (failure === "read" && k.startsWith("mecha-pending:v1:")) throw Error("storage unavailable"); return get.call(this, k); };
        Storage.prototype.setItem = function(k, v) { if (failure === "write" && k.startsWith("mecha-pending:v1:")) throw Error("storage unavailable"); return set.call(this, k, v); };
      }, { value: snapshot, failure });
      await page.route("**/src/remote/remoteAccess.ts*", route => route.fulfill({ contentType: "text/javascript", body: `const client = { snapshot: async () => ({ok:true,value:structuredClone(globalThis.testSnapshot)}), submitPlan: command => { globalThis.commands.push(command); return new Promise(() => {}); }, onStatus: fn => { fn("online"); return () => {}; }, subscribe: fn => { globalThis.emitMatchEvent = fn; return () => {}; }, dispose: () => {} }; export function useRemoteAccess() { return { client, playerId:"owner", status:"ready", error:"" }; }` }));
      await page.route("**/src/game/mecha/presentation/RemoteBattleScene.ts*", route => route.fulfill({ contentType: "text/javascript", body: `export class RemoteBattleScene { applySnapshot() {} setPaused() {} dispose() {} async playTurn() {} }` }));
      await page.goto(`${base}/remote.html?match=m1&capability=mecha:v3`);
      if (failure === "write") {
        for (let i = 0; i < 3; i++) {
          await page.locator(".remote-mechs button").nth(i).click();
          await page.locator(".remote-actions button").getByText("skip", { exact: true }).click();
        }
        await page.locator(".remote-submit").click();
      }
      await page.getByText("Pending-request storage is unavailable or identity changed", { exact: false }).waitFor();
      assert.equal(await page.locator(".remote-submit").isDisabled(), true, failure);
      assert.equal(await page.evaluate(() => globalThis.commands.length), 0, failure);
      await page.close();
    }
  } finally { await browser.close(); }
});
