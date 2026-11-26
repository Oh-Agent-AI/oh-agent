import test from "node:test";
import assert from "node:assert/strict";

const memory = new Map<string, string>();
let failWrites = false;
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => { if (failWrites) throw new Error("quota"); memory.set(key, value); },
} });
const windowStub: Record<string, unknown> = {};
windowStub.parent = windowStub;
Object.defineProperty(globalThis, "window", { configurable: true, value: windowStub });
const { cityPlanPatchStore } = await import("../src/data/planPatch.ts");
const { PlanRepairSession } = await import("../src/planRepair/session.ts");
const { emptyPlanPatch } = await import("../src/engine/planPatch.ts");

test("disposing a repair session flushes its pending change before the next session loads", async () => {
  memory.clear(); failWrites = false;
  const patch = { ...emptyPlanPatch(42, 1), buildingMoves: { building: "parcel" } };
  memory.set("city.plan-patch", JSON.stringify({ version: 1, patches: { "42": patch } }));
  const makeEngine = () => ({ currentLayout: { seed: 42 }, planPatch: null as unknown, setPlanPatch(value: unknown) { this.planPatch = value; } });
  const oldEngine = makeEngine();
  const old = new PlanRepairSession(oldEngine as never);
  await old.load(42);
  assert.ok(oldEngine.planPatch);
  old.reset();
  assert.equal(old.status().savePending, true);
  old.dispose();
  const freshEngine = makeEngine();
  const fresh = new PlanRepairSession(freshEngine as never);
  await fresh.load(42);
  assert.equal(freshEngine.planPatch, null);
  assert.deepEqual(JSON.parse(memory.get("city.plan-patch")!).patches, {});
  fresh.dispose();
});

test("a failed local write is not reported as success because an older store exists", async () => {
  memory.clear(); failWrites = false;
  const old = { version: 1 as const, patches: { "42": emptyPlanPatch(42, 1) } };
  assert.ok(await cityPlanPatchStore("write", old));
  const previous = memory.get("city.plan-patch");
  failWrites = true;
  assert.equal(await cityPlanPatchStore("write", { version: 1, patches: {} }), null);
  assert.equal(memory.get("city.plan-patch"), previous);
  failWrites = false;
});

test("in-flight and disposal writes stay ordered before a new session reads", async () => {
  const patch = { ...emptyPlanPatch(42, 1), buildingMoves: { building: "parcel" } };
  let persisted = { version: 1 as const, patches: { "42": patch } };
  let releaseFirst!: () => void;
  const firstWrite = new Promise<void>(resolve => { releaseFirst = resolve; });
  let writes = 0;
  const persistence: typeof cityPlanPatchStore = async (action, store) => {
    if (action === "read") return structuredClone(persisted);
    writes++;
    if (writes === 1) await firstWrite;
    persisted = structuredClone(store!) as typeof persisted;
    return structuredClone(persisted);
  };
  const makeEngine = () => ({ currentLayout: { seed: 42 }, planPatch: null as unknown, setPlanPatch(value: unknown) { this.planPatch = value; } });
  const session = new PlanRepairSession(makeEngine() as never, persistence);
  await session.load(42);
  session.reset();
  await new Promise(resolve => setTimeout(resolve, 450));
  assert.equal(writes, 1);
  assert.equal(session.undo(), true);
  session.dispose();
  const nextEngine = makeEngine();
  const next = new PlanRepairSession(nextEngine as never, persistence);
  const loading = next.load(42);
  releaseFirst();
  await loading;
  assert.equal(writes, 2);
  assert.deepEqual(nextEngine.planPatch, patch);
  next.dispose();
});

test("concurrent sessions preserve other seeds and reject conflicting edits to the same seed", async () => {
  const patch42 = { ...emptyPlanPatch(42, 1), buildingMoves: { a: "p1" } };
  const patch7 = { ...emptyPlanPatch(7, 1), buildingMoves: { b: "p2" } };
  let persisted = { version: 1 as const, patches: { "42": patch42, "7": patch7 } };
  const persistence: typeof cityPlanPatchStore = async (action, store) => {
    if (action === "write") persisted = structuredClone(store!) as typeof persisted;
    return structuredClone(persisted);
  };
  const makeEngine = (seed: number) => ({ currentLayout: { seed }, planPatch: null as unknown, setPlanPatch(value: unknown) { this.planPatch = value; } });
  const first = new PlanRepairSession(makeEngine(42) as never, persistence);
  const second = new PlanRepairSession(makeEngine(7) as never, persistence);
  await Promise.all([first.load(42), second.load(7)]);
  first.reset(); second.reset(); first.dispose(); second.dispose();
  const afterEngine = makeEngine(42);
  const after = new PlanRepairSession(afterEngine as never, persistence);
  await after.load(42);
  assert.deepEqual(persisted.patches, {});
  after.dispose();

  persisted = { version: 1, patches: { "42": patch42, "7": patch7 } };
  const winner = new PlanRepairSession(makeEngine(42) as never, persistence);
  const loser = new PlanRepairSession(makeEngine(42) as never, persistence);
  await Promise.all([winner.load(42), loser.load(42)]);
  winner.reset(); loser.reset(); assert.equal(loser.undo(), true);
  winner.dispose(); loser.dispose();
  const verify = new PlanRepairSession(makeEngine(42) as never, persistence);
  await verify.load(42);
  assert.equal(loser.status().saveFailed, true);
  assert.equal(persisted.patches["42"], undefined);
  assert.deepEqual(persisted.patches["7"], patch7);
  verify.dispose();
});

test("unreadable storage does not permit destructive repair writes", async () => {
  let writes = 0;
  const persistence: typeof cityPlanPatchStore = async action => { if (action === "write") writes++; return null; };
  const engine = { currentLayout: { seed: 42 }, planPatch: emptyPlanPatch(42, 1) as unknown, setPlanPatch(value: unknown) { this.planPatch = value; } };
  const session = new PlanRepairSession(engine as never, persistence);
  await session.load(42);
  assert.equal(session.status().saveFailed, true);
  assert.equal(session.remapForTier(), null);
  assert.equal(session.pruneStale(), false);
  session.reset(); session.dispose();
  assert.equal(writes, 0);
});

test("a corrupt local store stays intact and blocks repair writes", async () => {
  memory.clear(); failWrites = false;
  memory.set("city.plan-patch", "{broken");
  const engine = { currentLayout: { seed: 42 }, planPatch: emptyPlanPatch(42, 1) as unknown, setPlanPatch(value: unknown) { this.planPatch = value; } };
  const session = new PlanRepairSession(engine as never);
  await session.load(42);
  assert.equal(session.status().saveFailed, true);
  session.reset(); session.dispose();
  assert.equal(memory.get("city.plan-patch"), "{broken");
});

test("a temporary save failure can retry without overwriting a concurrent edit", async () => {
  const patch = { ...emptyPlanPatch(42, 1), buildingMoves: { building: "parcel" } };
  let persisted = { version: 1 as const, patches: { "42": patch } };
  let fail = true;
  const persistence: typeof cityPlanPatchStore = async (action, store) => {
    if (action === "write") { if (fail) return null; persisted = structuredClone(store!) as typeof persisted; }
    return structuredClone(persisted);
  };
  const engine = { currentLayout: { seed: 42 }, planPatch: null as unknown, setPlanPatch(value: unknown) { this.planPatch = value; } };
  const session = new PlanRepairSession(engine as never, persistence);
  await session.load(42);
  let settled!: () => void;
  let finished = new Promise<void>(resolve => { settled = resolve; });
  session.onSaveSettled = () => { if (!session.status().savePending) settled(); };
  session.reset();
  await finished;
  assert.equal(session.status().saveFailed, true);
  assert.deepEqual(persisted.patches["42"], patch);
  fail = false;
  finished = new Promise<void>(resolve => { settled = resolve; });
  assert.equal(session.retrySave(), true);
  await finished;
  assert.equal(session.status().saveFailed, false);
  assert.equal(persisted.patches["42"], undefined);
  session.dispose();
});

test("a failed pending save blocks seed changes until the old snapshot is saved", async () => {
  const patch = { ...emptyPlanPatch(42, 1), buildingMoves: { building: "parcel" } };
  let persisted = { version: 1 as const, patches: { "42": patch } };
  let fail = true;
  const persistence: typeof cityPlanPatchStore = async (action, store) => {
    if (action === "write") { if (fail) return null; persisted = structuredClone(store!) as typeof persisted; }
    return structuredClone(persisted);
  };
  const engine = { currentLayout: { seed: 42 }, planPatch: null as unknown, setPlanPatch(value: unknown) { this.planPatch = value; } };
  const session = new PlanRepairSession(engine as never, persistence);
  await session.load(42);
  session.reset();
  engine.currentLayout.seed = 7;
  await session.load(7);
  assert.equal(session.status().saveFailed, true);
  assert.deepEqual(persisted.patches["42"], patch);
  fail = false;
  let settled!: () => void;
  const finished = new Promise<void>(resolve => { settled = resolve; });
  session.onSaveSettled = () => { if (!session.status().savePending) settled(); };
  assert.equal(session.retrySave(), true);
  await finished;
  await session.load(7);
  assert.equal(session.status().saveFailed, false);
  assert.equal(persisted.patches["42"], undefined);
  session.dispose();
});

test("a later read failure remains retryable after an earlier successful save", async () => {
  const patch = { ...emptyPlanPatch(42, 1), buildingMoves: { building: "parcel" } };
  let persisted = { version: 1 as const, patches: { "42": patch } };
  let failReads = false;
  const persistence: typeof cityPlanPatchStore = async (action, store) => {
    if (action === "read" && failReads) return null;
    if (action === "write") persisted = structuredClone(store!) as typeof persisted;
    return structuredClone(persisted);
  };
  const engine = { currentLayout: { seed: 42 }, planPatch: null as unknown, setPlanPatch(value: unknown) { this.planPatch = value; } };
  const session = new PlanRepairSession(engine as never, persistence);
  await session.load(42);
  session.reset();
  engine.currentLayout.seed = 7;
  await session.load(7);
  assert.equal(session.status().saveFailed, false);
  failReads = true; engine.currentLayout.seed = 8;
  await session.load(8);
  assert.equal(session.status().saveFailed, true);
  assert.equal(session.retrySave(), false);
  failReads = false;
  await session.load(8);
  assert.equal(session.status().saveFailed, false);
  session.dispose();
});
