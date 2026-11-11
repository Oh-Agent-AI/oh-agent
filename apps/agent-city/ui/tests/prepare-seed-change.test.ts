import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareSeedChange, SeedChangeError } from "../src/engine/prepareSeedChange.ts";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

test("new seed is planned before persistence and synchronous engine rebuild", async () => {
  const events: string[] = [], wait = deferred(), model = { id: "a" };
  const engine = { currentModel: model, setSeed(seed: number) { events.push(`apply:${seed}`); } };
  const task = prepareSeedChange({ seed: 42, signal: new AbortController().signal, currentEngine: () => engine,
    beforeWork: async () => { events.push("busy"); },
    prepare: async (_model, seed) => { events.push(`prepare:${seed}`); await wait.promise; },
    persist: async (seed) => { events.push(`persist:${seed}`); } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(events, ["busy", "prepare:42"], "event loop remains free while preparation is pending");
  wait.resolve();
  assert.equal(await task, "applied");
  assert.deepEqual(events, ["busy", "prepare:42", "persist:42", "busy", "apply:42"]);
});

test("model or engine changes force re-preparation before applying, even after persistence", async () => {
  const events: string[] = [], saving = deferred(), a = { id: "a" }, b = { id: "b" };
  let engine = { currentModel: a, setSeed(seed: number) { events.push(`old:${seed}`); } };
  const task = prepareSeedChange({ seed: 42, signal: new AbortController().signal, currentEngine: () => engine,
    beforeWork: async () => {}, prepare: async (model) => { events.push(`prepare:${model.id}`); },
    persist: async () => { events.push("save"); await saving.promise; } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  engine = { currentModel: b, setSeed(seed) { events.push(`new:${seed}`); } };
  saving.resolve();
  assert.equal(await task, "applied");
  assert.deepEqual(events, ["prepare:a", "save", "prepare:b", "new:42"]);
});

test("aborting pending preparation or persistence prevents engine mutation", async () => {
  for (const stage of ["prepare", "persist"]) {
    const controller = new AbortController(), wait = deferred(), calls: string[] = [];
    const engine = { currentModel: {}, setSeed() { calls.push("apply"); } };
    const task = prepareSeedChange({ seed: 42, signal: controller.signal, currentEngine: () => engine,
      beforeWork: async () => {},
      prepare: async () => { calls.push("prepare"); if (stage === "prepare") await wait.promise; },
      persist: async () => { calls.push("persist"); if (stage === "persist") await wait.promise; } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(); wait.resolve();
    assert.equal(await task, "cancelled");
    assert.equal(calls.includes("apply"), false);
    if (stage === "prepare") assert.equal(calls.includes("persist"), false);
  }
});

test("failure reports whether persistence already happened and never applies prematurely", async () => {
  for (const stage of ["prepare", "persist", "apply"]) {
    const calls: string[] = [];
    const engine = { currentModel: {}, setSeed() { calls.push("apply"); if (stage === "apply") throw Error("apply"); } };
    await assert.rejects(prepareSeedChange({ seed: 42, signal: new AbortController().signal, currentEngine: () => engine,
      beforeWork: async () => {},
      prepare: async () => { if (stage === "prepare") throw Error("prepare"); },
      persist: async () => { if (stage === "persist") throw Error("persist"); } }),
    (error: unknown) => error instanceof SeedChangeError && error.saved === (stage === "apply") && error.persistAttempted === (stage !== "prepare"));
    assert.equal(calls.includes("apply"), stage === "apply");
  }
});

test("when the model changes before the first preparation finishes it is never persisted prematurely", async () => {
  const events: string[] = [], wait = deferred();
  const engine = { currentModel: { id: "a" }, setSeed() { events.push("apply"); } };
  const task = prepareSeedChange({ seed: 42, signal: new AbortController().signal, currentEngine: () => engine,
    beforeWork: async () => {}, prepare: async (model) => { events.push(`prepare:${model.id}`); if (model.id === "a") await wait.promise; },
    persist: async () => { events.push("persist"); } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  engine.currentModel = { id: "b" }; wait.resolve();
  assert.equal(await task, "applied");
  assert.deepEqual(events, ["prepare:a", "prepare:b", "persist", "apply"]);
});
