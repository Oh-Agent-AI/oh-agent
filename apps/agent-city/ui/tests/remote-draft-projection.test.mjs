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
const { createPvpMatch, playPvpTurn } = await server.ssrLoadModule("/src/game/mecha/rules/pvp.ts");
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
function pvp(side = "A") {
  const state = createPvpMatch({ terrain: land, heights, blocked: [], buildings: [] });
  const positions = { "A:Assault": [4, 6], "A:Gunner": [0, 9], "A:Support": [8, 9], "B:Assault": [4, 3], "B:Gunner": [0, 0], "B:Support": [8, 0] };
  for (const unit of state.units) unit.pos = { x: positions[unit.id][0], y: positions[unit.id][1] };
  state.activeSide = side;
  return state;
}
test.after(async () => { await server.close(); });

test("PvE and PvP actions use post-move positions without mutating authority", () => {
  for (const [state, target] of [[pve(), "boss"], [pvp(), "B:Assault"]]) {
    const before = structuredClone(state), draft = fresh();
    assert.equal(legalActions(remoteDraftProjection(state, "A", draft).state, "Assault").some((a) => a.kind === "melee"), false);
    draft.Assault = { moveTo: { x: 4, y: 4 }, action: { kind: "melee", target }, explicit: true };
    const moved = remoteDraftProjection(state, "A", draft);
    assert.equal(moved.movement.status, "ok"); assert.equal(moved.plan.status, "ok");
    assert.deepEqual(moved.invalid, []);
    assert.ok(legalActions(moved.state, "Assault").some((a) => a.kind === "melee"));
    draft.Assault.moveTo = { x: 4, y: 6 };
    const stale = remoteDraftProjection(state, "A", draft);
    assert.deepEqual(stale.invalid, ["Assault"]); assert.equal(stale.plan.status, "rejected");
    assert.deepEqual(state, before);
  }
});

test("implicit draft actions hold in both local and remote planning", () => {
  for (const state of [pve(), pvp()]) {
    const draft = fresh();
    // An unconfirmed or stale action is not a command, even if present in draft memory.
    draft.Assault.action = { kind: "melee", target: "invalid" };
    const result = remoteDraftProjection(state, "A", draft);
    assert.equal(result.movement.status, "ok");
    assert.equal(result.plan.status, "ok");
    assert.deepEqual(result.invalid, []);
  }
});

test("PvP guest uses its own side", () => {
  const draft = fresh();
  draft.Assault = { moveTo: { x: 4, y: 5 }, action: { kind: "melee", target: "A:Assault" }, explicit: true };
  const result = remoteDraftProjection(pvp("B"), "B", draft);
  assert.equal(result.movement.status, "ok"); assert.equal(result.plan.status, "ok"); assert.deepEqual(result.invalid, []);
});

test("movement conflicts, unreachable cells, following and swaps follow authority", () => {
  for (const state of [pve(), pvp()]) {
    const draft = fresh();
    draft.Assault.moveTo = { x: 2, y: 8 }; draft.Gunner.moveTo = { x: 2, y: 8 };
    let result = remoteDraftProjection(state, "A", draft);
    assert.equal(result.movement.status, "rejected"); assert.equal(result.movement.fault.cause, "occupied"); assert.equal(result.state, null);
    draft.Gunner.moveTo = { x: 9, y: 9 };
    assert.equal(remoteDraftProjection(state, "A", draft).movement.status, "rejected");
    const actors = state.mechs ?? state.units.filter((u) => u.side === "A");
    const get = (id) => actors.find((a) => (a.kind ?? a.id) === id);
    get("Assault").pos = { x: 3, y: 7 }; get("Gunner").pos = { x: 4, y: 7 };
    draft.Assault.moveTo = { x: 4, y: 7 }; draft.Gunner.moveTo = { x: 3, y: 7 };
    result = remoteDraftProjection(state, "A", draft);
    assert.equal(result.movement.status, "ok"); assert.deepEqual(result.state.mechs.find((m) => m.id === "Assault").pos, { x: 4, y: 7 });
    draft.Gunner.moveTo = { x: 5, y: 7 };
    assert.equal(remoteDraftProjection(state, "A", draft).movement.status, "ok");
    draft.Gunner.moveTo = null;
    assert.equal(remoteDraftProjection(state, "A", draft).movement.status, "rejected");
  }
});

test("moving an ally invalidates repair and unrelated targets are not accepted", () => {
  for (const state of [pve(), pvp()]) {
    const actors = state.mechs ?? state.units.filter((u) => u.side === "A");
    const get = (id) => actors.find((a) => (a.kind ?? a.id) === id);
    get("Support").pos = { x: 2, y: 8 }; get("Gunner").pos = { x: 2, y: 7 };
    const draft = fresh();
    draft.Support = { moveTo: null, action: { kind: "repair", target: "Gunner" }, explicit: true };
    assert.deepEqual(remoteDraftProjection(state, "A", draft).invalid, []);
    draft.Gunner.moveTo = { x: 0, y: 7 };
    assert.deepEqual(remoteDraftProjection(state, "A", draft).invalid, ["Support"]);
    draft.Support.action = { kind: "skip" }; draft.Gunner.moveTo = null;
    draft.Assault = { moveTo: { x: 4, y: 4 }, action: { kind: "melee", target: "nonexistent" }, explicit: true };
    assert.deepEqual(remoteDraftProjection(state, "A", draft).invalid, ["Assault"]);
  }
});

test("unknown exceptions never appear as a legal projection", () => {
  const state = pve(), clone = globalThis.structuredClone;
  try {
    globalThis.structuredClone = () => { throw new Error("synthetic failure"); };
    const result = remoteDraftProjection(state, "A", fresh());
    assert.equal(result.movement.status, "unknown"); assert.equal(result.state, null);
  } finally { globalThis.structuredClone = clone; }
  let count = 0;
  try {
    globalThis.structuredClone = (value) => { if (++count === 4) throw new Error("plan check failed"); return clone(value); };
    const result = remoteDraftProjection(state, "A", fresh());
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
    assert.equal(remoteDraftProjection(state, "A", draft).plan.status, "ok");
    assert.deepEqual(outer, []);
    emit(marker); assert.deepEqual(outer, [marker]); outer.length = 0;
    draft.Assault.action = { kind: "melee", target: "missing" };
    const badPlan = { ...plan, items: plan.items.map((item) => item.mechId === "Assault" ? { ...item, action: draft.Assault.action } : item) };
    assert.equal("ok" in validateAndApplyPlan(clone(state), badPlan), false);
    assert.ok(outer.some((event) => event.type === "move"), "direct rejection emits trial movement");
    outer.length = 0;
    const rejected = remoteDraftProjection(state, "A", draft);
    assert.equal(rejected.movement.status, "ok"); assert.equal(rejected.plan.status, "rejected");
    assert.deepEqual(outer, []);
    emit(marker); assert.deepEqual(outer, [marker]); outer.length = 0;
    // The movement phase emits before action validation reads kind and throws.
    draft.Assault.action = { get kind() { throw new Error("action failure"); } };
    const actionFailure = remoteDraftProjection(state, "A", draft);
    assert.equal(actionFailure.movement.status, "ok");
    assert.equal(actionFailure.actionUnknown, true);
    assert.equal(actionFailure.plan.status, "unknown");
    assert.deepEqual(outer, []);
    emit(marker); assert.deepEqual(outer, [marker]); outer.length = 0;
    globalThis.structuredClone = () => { throw new Error("preflight failure"); };
    assert.equal(remoteDraftProjection(state, "A", draft).movement.status, "unknown");
    assert.deepEqual(outer, []);
    emit(marker); assert.deepEqual(outer, [marker]);
  } finally {
    globalThis.structuredClone = clone;
    assert.equal(swapEventSink(previous), outer);
  }
});

test("a preflight-valid plan may still fizzle during ordered resolution", () => {
  const state = pvp(), draft = fresh();
  state.units.find((u) => u.id === "B:Assault").hp = 1;
  state.units.find((u) => u.id === "A:Assault").pos = { x: 4, y: 4 };
  state.units.find((u) => u.id === "A:Support").pos = { x: 5, y: 4 };
  draft.Assault = { moveTo: null, action: { kind: "melee", target: "B:Assault" }, explicit: true };
  draft.Support = { moveTo: null, action: { kind: "melee", target: "B:Assault" }, explicit: true };
  assert.equal(remoteDraftProjection(state, "A", draft).plan.status, "ok");
  const result = playPvpTurn(state, { revision: state.revision, items: Object.entries(draft).map(([mechId, item]) => ({ mechId, moveTo: item.moveTo, action: item.action })) });
  assert.equal(result.ok, true);
  assert.ok(result.log.some((event) => event.type === "act" && event.mechId === "Support" && event.fizzled));
});

test("remote UI permits post-move melee and blocks stale actions in PvE and PvP", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const [mode, state, target] of [["pve", pve(), "boss"], ["pvp", pvp(), "B:Assault"]]) {
      const page = await browser.newPage({ locale: "en-US" }), errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const snapshot = { state, mode, matchId: "m1", revision: 0, status: "active", ruleset: state.ruleset, players: [{ playerId: "owner", side: "A", role: "host" }, { playerId: "guest", side: "B", role: "guest" }] };
      await page.addInitScript((value) => { globalThis.testSnapshot = value; globalThis.submittedPlans = []; }, snapshot);
      await page.route("**/src/remote/remoteAccess.ts*", (route) => route.fulfill({ contentType: "text/javascript", body: `const client = { snapshot: async () => ({ok:true,value:globalThis.testSnapshot}), submitPlan: async command => { globalThis.submittedPlans.push(command); return {ok:false,error:{code:"synthetic"}}; }, onStatus: fn => { fn("online"); return () => {}; }, subscribe: () => () => {}, dispose: () => {} }; export function useRemoteAccess() { return { client, playerId:"owner", status:"ready", error:"" }; }` }));
      await page.route("**/src/game/mecha/presentation/RemoteBattleScene.ts*", (route) => route.fulfill({ contentType: "text/javascript", body: `export class RemoteBattleScene { applySnapshot() {} setPaused() {} dispose() {} playTurn() {} }` }));
      await page.goto(`${base}/remote.html?match=m1`);
      try { await page.locator(".remote-mechs button").first().waitFor({ timeout: 5000 }); } catch (e) { console.error("PAGE ERRORS:", errors, "BODY:", await page.locator("body").innerText()); throw e; }
      await page.locator(".remote-board summary").click();
      const cell = (x, y) => page.locator(`.remote-board button[aria-label="${x},${y}"]`);
      const action = (label) => page.locator(".remote-actions button").getByText(label, { exact: true });
      assert.equal(await action("melee").count(), 0, mode);
      if (mode === "pvp") assert.equal(await cell(4, 3).innerText(), "E");
      await cell(4, 4).click(); assert.equal(await cell(4, 4).innerText(), "突");
      await action("melee").click(); await cell(4, 3).click();
      await page.locator(".remote-mechs button").nth(1).click(); await action("skip").click();
      await page.locator(".remote-mechs button").nth(2).click(); await action("skip").click();
      const submit = page.locator(".remote-submit"); assert.equal(await submit.isEnabled(), true, mode);
      await page.locator(".remote-mechs button").first().click(); await cell(4, 6).click();
      assert.match(await page.locator('.remote-controls [role="status"]').innerText(), /Actions invalid after movement/);
      assert.equal(await submit.isDisabled(), true);
      await cell(4, 4).click(); assert.equal(await submit.isEnabled(), true); await submit.click();
      const plans = await page.evaluate(() => globalThis.submittedPlans);
      await page.waitForFunction(() => Object.keys(sessionStorage).filter(k => k.startsWith("mecha-pending:v1:")).length === 0);
      assert.equal(plans.length, 1); assert.deepEqual(plans[0].plan.items.find((i) => i.mechId === "Assault").action, { kind: "melee", target });
      assert.equal(mode === "pvp" ? playPvpTurn(state, plans[0].plan).ok : validateAndApplyPlan(structuredClone(state), plans[0].plan).ok, true);
      // Force a simultaneous destination conflict by cancelling an ally's move
      // after another unit has planned to follow into its starting cell.
      await page.evaluate(() => {
        const state = globalThis.testSnapshot.state;
        const gunner = state.mechs ? state.mechs.find((m) => m.id === "Gunner") : state.units.find((m) => m.id === "A:Gunner");
        gunner.pos = { x: 4, y: 7 };
      });
      await page.getByRole("button", { name: "Online", exact: true }).click();
      await page.locator(".remote-mechs button").nth(1).click(); await cell(3, 7).click();
      await page.locator(".remote-mechs button").first().click(); await cell(4, 7).click();
      await page.locator(".remote-mechs button").nth(1).click();
      await page.getByRole("button", { name: "Clear selected move" }).click();
      assert.match(await page.locator('.remote-controls [role="status"]').innerText(), /Movement draft rejected/);
      assert.equal(await page.locator(".remote-actions button").count(), 0);
      assert.equal(await submit.isDisabled(), true);
      await page.locator(".remote-mechs button").first().click();
      await page.getByRole("button", { name: "Clear selected move" }).click();
      // A thrown validator must not be shown as a valid movement or legal actions.
      await page.evaluate(() => { globalThis.savedClone = structuredClone; globalThis.structuredClone = () => { throw new Error("synthetic"); }; });
      await cell(4, 4).click();
      assert.match(await page.locator('.remote-controls [role="status"]').innerText(), /Movement check unavailable/);
      assert.equal(await page.locator(".remote-actions button").count(), 0);
      assert.equal(await submit.isDisabled(), true);
      await page.evaluate(() => { globalThis.structuredClone = globalThis.savedClone; });
      await page.getByRole("button", { name: "Clear selected move" }).click();
      assert.match(await page.locator('.remote-controls [role="status"]').innerText(), /projected positions/);
      assert.deepEqual(errors, []); await page.close();
    }
  } finally { await browser.close(); }
});


test("3D snapshot picks and 2D draft picks use their displayed positions in PvE and PvP", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const [mode, state] of [["pve", pve()], ["pvp", pvp()]]) {
      const gunner = state.mechs ? state.mechs.find((m) => m.id === "Gunner") : state.units.find((u) => u.id === "A:Gunner");
      gunner.pos = { x: 3, y: 6 };
      const snapshot = { state, mode, matchId: "m1", revision: 0, status: "active", ruleset: state.ruleset, players: [{ playerId: "owner", side: "A", role: "host" }, { playerId: "guest", side: "B", role: "guest" }] };
      const page = await browser.newPage({ locale: "en-US" }), errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript((value) => { globalThis.testSnapshot = value; }, snapshot);
      await page.route("**/src/remote/remoteAccess.ts*", (route) => route.fulfill({ contentType: "text/javascript", body: `const client = { snapshot: async () => ({ok:true,value:globalThis.testSnapshot}), onStatus: fn => { fn("online"); return () => {}; }, subscribe: () => () => {}, dispose: () => {} }; export function useRemoteAccess() { return { client, playerId:"owner", status:"ready", error:"" }; }` }));
      // Exercise the real RemoteApp-to-scene callback, without depending on WebGL raycasting.
      await page.route("**/src/game/mecha/presentation/RemoteBattleScene.ts*", (route) => route.fulfill({ contentType: "text/javascript", body: `export class RemoteBattleScene { constructor(canvas, onCell) { globalThis.pickSceneCell = onCell; } applySnapshot() {} setPaused() {} dispose() {} playTurn() {} }` }));
      await page.goto(`${base}/remote.html?match=m1`);
      await page.locator(".remote-mechs button").first().waitFor();
      await page.locator(".remote-board summary").click();
      const cell = (x, y) => page.locator(`.remote-board button[aria-label="${x},${y}"]`);
      const selected = (index) => page.locator(`.remote-mechs button:nth-child(${index}).selected`);
      const scenePick = (x, y) => page.evaluate(({ x, y }) => globalThis.pickSceneCell({ x, y }), { x, y });
      // Assault is visibly at (4,6) in 3D and at (4,4) on the draft board.
      await cell(4, 4).click();
      assert.equal(await cell(4, 4).innerText(), "突");
      assert.equal(await cell(4, 6).innerText(), "·");
      await page.locator(".remote-mechs button").nth(1).click();
      await scenePick(4, 6); await selected(1).waitFor();
      await page.locator(".remote-mechs button").nth(1).click();
      await cell(4, 4).click(); await selected(1).waitFor();
      // That same cell is empty in 3D: it is a destination, not a phantom pick.
      await page.locator(".remote-mechs button").nth(1).click();
      await scenePick(4, 4);
      await page.locator('.remote-controls [role="status"]').getByText(/Movement draft rejected/).waitFor();
      assert.equal(await selected(2).count(), 1);
      await page.getByRole("button", { name: "Clear selected move" }).click();
      // The vacated cell is empty on 2D and can be used as a following move.
      await cell(4, 6).click();
      assert.equal(await cell(4, 6).innerText(), "射");
      assert.match(await page.locator('.remote-controls [role="status"]').innerText(), /projected positions/);
      // The same cell still picks the visible Assault in 3D, not projected Gunner.
      await scenePick(4, 6); await selected(1).waitFor();
      await cell(4, 6).click(); await selected(2).waitFor();
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
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
      const state = pvp();
      const snapshot = { state, mode: "pvp", matchId: "m1", revision: 0, status: "active", ruleset: state.ruleset, players: [{ playerId: "owner", side: "A", role: "host" }, { playerId: "guest", side: "B", role: "guest" }] };
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
      const played = playPvpTurn(state, commands[0].plan); assert.equal(played.ok, true);
      const turn = { type: "turn.resolved", protocol: "mecha-net:v1", matchId: "m1", playerId: "owner", commandId: commands[0].commandId, revision: played.state.revision, state: played.state, log: played.log, presentationStages: played.presentationStages };
      // The event may arrive before the retry response, which must not undo it.
      await page.evaluate((value) => { globalThis.emitMatchEvent({type:"turn.resolved",result:value}); globalThis.responses[2].resolve({ok:false,error:{code:"unavailable"}}); }, turn);
      await page.waitForFunction(() => !document.querySelector(".remote-pending"));
      assert.equal(await page.evaluate(() => { const e = new Event("beforeunload", {cancelable:true}); window.dispatchEvent(e); return e.defaultPrevented; }), false);
      assert.match(await page.locator(".remote-status").innerText(), /rev 1/);
      assert.deepEqual(errors, []); await page.close();
    }
  } finally { await browser.close(); }
});

test("same-revision mode replacement cannot retry an old plan into an older host", async () => {
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
    const replacementState = pvp();
    const replacement = { ...snapshot, mode: "pvp", ruleset: replacementState.ruleset, state: replacementState, players: [...snapshot.players, { playerId: "guest", side: "B", role: "guest" }] };
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


test("remote PvP explains disabled legacy concession on mobile in both languages", async () => {
  const browser = await chromium.launch({ headless: true });
  const output = "../../../artifacts/mecha-clarity-p0/remote-concede-synthetic-2026-11-03";
  await mkdir(output, { recursive: true });
  try {
    const state = pvp();
    const snapshot = { state, mode: "pvp", matchId: "m1", revision: 0, status: "active", ruleset: state.ruleset, players: [{ playerId: "owner", side: "A", role: "host" }, { playerId: "guest", side: "B", role: "guest" }] };
    for (const [locale, label, note] of [["zh-CN", "认输暂不可用", "停止远程对局"], ["en-US", "Concede unavailable", "stop remote play"]]) {
      const page = await browser.newPage({ locale, viewport: { width: 390, height: 844 } });
      const errors = []; page.on("pageerror", error => errors.push(error.message));
      await page.addInitScript(value => { globalThis.testSnapshot = value; }, snapshot);
      await page.route("**/src/remote/remoteAccess.ts*", route => route.fulfill({ contentType: "text/javascript", body: `const client = { snapshot: async () => ({ok:true,value:structuredClone(globalThis.testSnapshot)}), onStatus: fn => { fn("online"); return () => {}; }, subscribe: () => () => {}, dispose: () => {} }; export function useRemoteAccess() { return { client, playerId:"owner", status:"ready", error:"" }; }` }));
      await page.route("**/src/game/mecha/presentation/RemoteBattleScene.ts*", route => route.fulfill({ contentType: "text/javascript", body: `export class RemoteBattleScene { applySnapshot() {} setPaused() {} dispose() {} async playTurn() {} }` }));
      await page.goto(`${base}/remote.html?match=m1`);
      const button = page.getByRole("button", { name: label, exact: true });
      await button.waitFor(); assert.equal(await button.isDisabled(), true);
      assert.match(await page.locator("#remote-concede-note").innerText(), new RegExp(note));
      assert.equal(await button.getAttribute("aria-describedby"), "remote-concede-note");
      const geometry = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth }));
      assert.ok(geometry.document <= geometry.viewport, `horizontal overflow: ${JSON.stringify(geometry)}`);
      await page.screenshot({ path: `${output}/${locale}.png`, fullPage: true });
      assert.deepEqual(errors, []); await page.close();
    }
  } finally { await browser.close(); }
});

test("v3 concession keeps an uncertain command locked and ignores a late response after the terminal event", async () => {
  const browser = await chromium.launch({ headless: true });
  const { pvpRules } = await server.ssrLoadModule("/src/game/mecha/rules/pvp.ts");
  try {
    for (const locale of ["zh-CN", "en-US"]) {
      const state = pvp();
      const snapshot = { state, mode: "pvp", matchId: "m1", revision: 0, status: "active", ruleset: state.ruleset, players: [{ playerId: "owner", side: "A", role: "host" }, { playerId: "guest", side: "B", role: "guest" }] };
      const page = await browser.newPage({ locale, viewport: { width: 390, height: 844 } });
      const errors = []; page.on("pageerror", error => errors.push(error.message)); page.on("dialog", dialog => dialog.accept());
      await page.addInitScript(value => { globalThis.testSnapshot = value; globalThis.commands = []; globalThis.responses = []; }, snapshot);
      await page.route("**/src/remote/remoteAccess.ts*", route => route.fulfill({ contentType: "text/javascript", body: `const client = { snapshot: async () => ({ok:true,value:structuredClone(globalThis.testSnapshot)}), supportsSafeConcede: () => true, submitConcede: command => {globalThis.commands.push(structuredClone(command)); return new Promise((resolve,reject) => globalThis.responses.push({resolve,reject}));}, onStatus: fn => { fn("online"); return () => {}; }, subscribe: fn => { globalThis.emitMatchEvent = fn; return () => {}; }, dispose: () => {} }; export function useRemoteAccess() { return { client, playerId:"owner", status:"ready", error:"" }; }` }));
      await page.route("**/src/game/mecha/presentation/RemoteBattleScene.ts*", route => route.fulfill({ contentType: "text/javascript", body: `export class RemoteBattleScene { applySnapshot() {} setPaused() {} dispose() {} async playTurn() {} }` }));
      await page.goto(`${base}/remote.html?match=m1`);
      const concede = page.getByRole("button", { name: locale === "zh-CN" ? "认输" : "Concede", exact: true });
      await concede.waitFor(); await page.waitForFunction(() => !document.querySelector('.remote-submit').disabled || !document.querySelector('.remote-mechs button').disabled);
      await concede.click();
      await page.evaluate(() => globalThis.responses[0].reject(new Error("host_offline")));
      await page.locator(".remote-pending").waitFor();
      assert.equal(await page.locator(".remote-submit").isDisabled(), true);
      await page.locator("header button").click();
      await page.waitForFunction(() => !document.querySelector(".remote-pending button").disabled);
      await page.locator(".remote-pending button").click();
      const commands = await page.evaluate(() => globalThis.commands);
      assert.equal(commands.length, 2); assert.deepEqual(commands[0], commands[1]);
      const finished = pvpRules.concede(state, "A");
      const turn = { type: "turn.resolved", protocol: "mecha-net:v1", matchId: "m1", playerId: "owner", commandId: commands[0].commandId, revision: finished.revision, state: finished, log: [], presentationStages: null };
      await page.evaluate(value => globalThis.emitMatchEvent({ type: "turn.resolved", result: value }), turn);
      await page.waitForFunction(() => !document.querySelector(".remote-pending"));
      await page.evaluate(() => globalThis.responses[1].resolve({ok:false,error:{code:"not_your_turn"}}));
      await page.waitForTimeout(50);
      assert.equal(await page.locator(".remote-pending").count(), 0);
      assert.equal(await page.getByRole("button", { name: locale === "zh-CN" ? "认输" : "Concede", exact: true }).count(), 0);
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally { await browser.close(); }
});


test("same-revision corrections permanently disable plan and concession retries without losing late success", async () => {
  const browser = await chromium.launch({ headless: true });
  const { pvpRules } = await server.ssrLoadModule("/src/game/mecha/rules/pvp.ts");
  try {
    for (const kind of ["plan", "concede"]) for (const outcome of ["unknown", "success"]) {
      const state = pvp();
      const snapshot = { state, mode: "pvp", matchId: "m1", revision: 0, status: "active", ruleset: state.ruleset, players: [{ playerId: "owner", side: "A", role: "host" }, { playerId: "guest", side: "B", role: "guest" }] };
      const page = await browser.newPage({ locale: "en-US", viewport: { width: 390, height: 844 } });
      const errors = []; page.on("pageerror", error => errors.push(error.message)); page.on("dialog", dialog => dialog.accept());
      await page.addInitScript(value => { globalThis.testSnapshot = value; globalThis.commands = []; globalThis.responses = []; }, snapshot);
      await page.route("**/src/remote/remoteAccess.ts*", route => route.fulfill({ contentType: "text/javascript", body: `const send = command => { globalThis.commands.push(structuredClone(command)); return new Promise((resolve,reject) => globalThis.responses.push({resolve,reject})); }; const client = { snapshot: async () => ({ok:true,value:structuredClone(globalThis.testSnapshot)}), supportsSafeConcede: () => true, submitPlan: send, submitConcede: send, onStatus: fn => { fn("online"); return () => {}; }, subscribe: fn => { globalThis.emitMatchEvent = fn; return () => {}; }, dispose: () => {} }; export function useRemoteAccess() { return { client, playerId:"owner", status:"ready", error:"" }; }` }));
      await page.route("**/src/game/mecha/presentation/RemoteBattleScene.ts*", route => route.fulfill({ contentType: "text/javascript", body: `export class RemoteBattleScene { applySnapshot() {} setPaused() {} dispose() {} async playTurn() {} }` }));
      await page.goto(`${base}/remote.html?match=m1`);
      await page.waitForFunction(() => !document.querySelector(".remote-mechs button")?.disabled);
      if (kind === "plan") {
        for (let i = 0; i < 3; i++) { await page.locator(".remote-mechs button").nth(i).click(); await page.locator(".remote-actions button").getByText("skip", { exact: true }).click(); }
        await page.locator(".remote-submit").click();
      } else await page.getByRole("button", { name: "Concede", exact: true }).click();
      const command = (await page.evaluate(() => globalThis.commands))[0];
      const changed = structuredClone(snapshot); changed.state.units[0].hp -= 1;
      await page.evaluate(value => { globalThis.testSnapshot = value; globalThis.emitMatchEvent({type:"match.replaced", snapshot:value}); }, changed);
      await page.getByText(/battlefield changed without a new revision/).waitFor();
      assert.equal(await page.locator(".remote-pending button").isDisabled(), true);
      if (outcome === "unknown") {
        await page.evaluate(() => globalThis.responses[0].reject(new Error("host_offline")));
        await page.waitForFunction(() => !document.querySelector(".remote-submit") || !document.querySelector(".remote-submit").textContent.includes("Resolving"));
        await page.evaluate(value => { globalThis.testSnapshot = value; globalThis.emitMatchEvent({type:"match.replaced", snapshot:value}); }, snapshot);
        await page.waitForTimeout(100);
        assert.equal(await page.locator(".remote-pending button").isDisabled(), true);
        assert.equal(await page.locator(".remote-mechs button").first().isDisabled(), true);
        const newer = structuredClone(snapshot); newer.revision = 1; newer.state.revision = 1;
        await page.evaluate(value => globalThis.emitMatchEvent({type:"match.replaced", snapshot:value}), newer);
      } else {
        const played = kind === "plan" ? playPvpTurn(state, command.plan) : {ok:true, state:pvpRules.concede(state, "A"), log:[], presentationStages:null};
        assert.equal(played.ok, true);
        const turn = { type:"turn.resolved", protocol:"mecha-net:v1", matchId:"m1", playerId:"owner", commandId:command.commandId, revision:played.state.revision, state:played.state, log:played.log, presentationStages:played.presentationStages };
        await page.evaluate(value => globalThis.responses[0].resolve({ok:true,value}), turn);
      }
      await page.waitForFunction(() => !document.querySelector(".remote-pending"));
      assert.equal((await page.evaluate(() => globalThis.commands)).length, 1);
      assert.deepEqual(errors, []);
      await page.close();
    }
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
test("reload restores deployment, plan and concession locks until authority advances", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const kind of ["deployment", "plan", "concede", "guest-concede"]) {
      const player = kind === "guest-concede" ? "guest" : "owner";
      const state = kind === "deployment" ? createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", deployment: true }) : pvp();
      const snapshot = { state, mode: kind === "deployment" ? "pve" : "pvp", matchId: "m1", revision: state.revision, status: "active", ruleset: state.ruleset, players: [{ playerId: "owner", side: "A", role: "host" }, { playerId: "guest", side: "B", role: "guest" }] };
      const page = await browser.newPage({ locale: "en-US" });
      const errors = []; page.on("pageerror", e => errors.push(e.message)); page.on("dialog", dialog => dialog.accept());
      await page.addInitScript(value => { globalThis.testSnapshot = value; globalThis.commands = []; }, snapshot);
      await page.route("**/src/remote/remoteAccess.ts*", route => route.fulfill({ contentType: "text/javascript", body: `const send = command => { globalThis.commands.push(structuredClone(command)); return new Promise(() => {}); }; const client = { snapshot: async () => ({ok:true,value:structuredClone(globalThis.testSnapshot)}), submitPlan: send, submitDeployment: send, submitConcede: send, supportsSafeConcede: () => true, onStatus: fn => { fn("online"); return () => {}; }, subscribe: fn => { globalThis.emitMatchEvent = fn; return () => {}; }, dispose: () => {} }; export function useRemoteAccess() { return { client, playerId:${JSON.stringify(player)}, status:"ready", error:"" }; }` }));
      await page.route("**/src/game/mecha/presentation/RemoteBattleScene.ts*", route => route.fulfill({ contentType: "text/javascript", body: `export class RemoteBattleScene { applySnapshot() {} setPaused() {} dispose() {} async playTurn() {} setDeploymentPreview() {} }` }));
      await page.goto(`${base}/remote.html?match=m1&capability=mecha:v3`);
      await page.waitForFunction(() => document.querySelector(".remote-mechs button") && !document.querySelector(".remote-mechs button").disabled);
      if (kind === "deployment") {
        const legal = page.locator(".remote-row button.deployable");
        await legal.nth(0).click(); await page.getByRole("button", { name: /Gunner/ }).click(); await legal.nth(1).click();
        await page.getByRole("button", { name: /Support/ }).click(); await legal.nth(2).click();
        await page.getByRole("button", { name: "Confirm deployment" }).click();
      } else if (kind === "plan") {
        for (let i = 0; i < 3; i++) { await page.locator(".remote-mechs button").nth(i).click(); await page.locator(".remote-actions button").getByText("skip", { exact: true }).click(); }
        await page.locator(".remote-submit").click();
      } else await page.getByRole("button", { name: "Concede", exact: true }).click();
      await page.waitForFunction(() => globalThis.commands.length === 1);
      const marker = await page.evaluate(() => JSON.parse(sessionStorage.getItem(Object.keys(sessionStorage).find(key => key.startsWith("mecha-pending:v1:")))));
      assert.equal(marker.kind, kind === "guest-concede" ? "concede" : kind); assert.equal(marker.playerId, player); assert.deepEqual(Object.keys(marker).sort(), ["baseRevision", "commandId", "kind", "matchId", "playerId", "version"].sort());
      await page.reload();
      await page.getByText("A request from before reload is unconfirmed", { exact: false }).waitFor();
      assert.equal(await page.locator(".remote-mechs button").first().isDisabled(), true, kind);
      assert.equal(await page.locator(".remote-pending button").count(), 0, kind);
      assert.equal(await page.evaluate(() => globalThis.commands.length), 0, kind);
      await page.locator("header button").click();
      await page.waitForFunction(() => document.querySelector(".remote-status")?.textContent.includes("rev 0"));
      assert.equal(await page.locator(".remote-mechs button").first().isDisabled(), true, kind);
      const newer = structuredClone(snapshot); newer.revision++; newer.state.revision++;
      await page.evaluate(value => { globalThis.testSnapshot = value; globalThis.emitMatchEvent({type:"match.replaced",snapshot:value}); }, newer);
      await page.waitForFunction(() => !document.querySelector(".remote-mechs button")?.disabled);
      assert.equal(await page.getByText("A request from before reload is unconfirmed", { exact: false }).count(), 0);
      assert.equal(await page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith("mecha-pending:v1:")).length), 0);
      assert.deepEqual(errors, []); await page.close();
    }
  } finally { await browser.close(); }
});

test("journal write, corruption and cleanup failures block new remote commands", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const failure of ["read", "write", "corrupt", "cleanup"]) {
      const state = pvp();
      const snapshot = { state, mode: "pvp", matchId: "m1", revision: 0, status: "active", ruleset: state.ruleset, players: [{ playerId: "owner", side: "A", role: "host" }, { playerId: "guest", side: "B", role: "guest" }] };
      const page = await browser.newPage({ locale: "en-US" }); page.on("dialog", dialog => dialog.accept());
      await page.addInitScript(({ value, failure }) => {
        globalThis.testSnapshot = value; globalThis.commands = [];
        const key = `mecha-pending:v1:${JSON.stringify(["mecha:v3", "m1", "owner", "", "", ""])}`;
        if (failure === "corrupt") sessionStorage.setItem(key, "{broken");
        const get = Storage.prototype.getItem, set = Storage.prototype.setItem, remove = Storage.prototype.removeItem;
        Storage.prototype.getItem = function(k) { if (failure === "read" && k.startsWith("mecha-pending:v1:")) throw Error("storage unavailable"); return get.call(this, k); };
        Storage.prototype.setItem = function(k, v) { if (failure === "write" && k.startsWith("mecha-pending:v1:")) throw Error("storage unavailable"); return set.call(this, k, v); };
        Storage.prototype.removeItem = function(k) { if (failure === "cleanup" && k.startsWith("mecha-pending:v1:")) throw Error("storage unavailable"); return remove.call(this, k); };
      }, { value: snapshot, failure });
      await page.route("**/src/remote/remoteAccess.ts*", route => route.fulfill({ contentType: "text/javascript", body: `const client = { snapshot: async () => ({ok:true,value:structuredClone(globalThis.testSnapshot)}), submitConcede: command => { globalThis.commands.push(command); return new Promise(() => {}); }, supportsSafeConcede: () => true, onStatus: fn => { fn("online"); return () => {}; }, subscribe: fn => { globalThis.emitMatchEvent = fn; return () => {}; }, dispose: () => {} }; export function useRemoteAccess() { return { client, playerId:"owner", status:"ready", error:"" }; }` }));
      await page.route("**/src/game/mecha/presentation/RemoteBattleScene.ts*", route => route.fulfill({ contentType: "text/javascript", body: `export class RemoteBattleScene { applySnapshot() {} setPaused() {} dispose() {} async playTurn() {} }` }));
      await page.goto(`${base}/remote.html?match=m1&capability=mecha:v3`);
      const concede = page.getByRole("button", { name: "Concede", exact: true }); await concede.waitFor();
      if (failure !== "corrupt" && failure !== "read") {
        await page.waitForFunction(() => ![...document.querySelectorAll("button")].find(b => b.textContent === "Concede")?.disabled);
        await concede.click();
      }
      if (failure === "cleanup") {
        await page.waitForFunction(() => globalThis.commands.length === 1);
        const newer = structuredClone(snapshot); newer.revision++; newer.state.revision++;
        await page.evaluate(value => globalThis.emitMatchEvent({type:"match.replaced",snapshot:value}), newer);
      }
      await page.getByText("Pending-request storage is unavailable or identity changed", { exact: false }).waitFor();
      assert.equal(await concede.isDisabled(), true, failure);
      assert.equal(await page.evaluate(() => globalThis.commands.length), failure === "cleanup" ? 1 : 0);
      await page.close();
    }
  } finally { await browser.close(); }
});
