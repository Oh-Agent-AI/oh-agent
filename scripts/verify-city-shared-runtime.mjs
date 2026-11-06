#!/usr/bin/env node
// Cross-vehicle foundation: same lifecycle/clock, configurable input, one
// deterministic environment source. No renderer, profile or private data.
import assert from "node:assert/strict";
import fs from "node:fs";
import { loadCity } from "./city-kit/index.mjs";
const { GameRuntime, FlightAdapter, KeyboardInput, CityEnvironment, weatherAt } = await loadCity({
  "game/runtime/GameRuntime.ts": ["GameRuntime"], "game/runtime/FlightAdapter.ts": ["FlightAdapter"],
  "game/runtime/KeyboardInput.ts": ["KeyboardInput"], "engine/environment/CityEnvironment.ts": ["CityEnvironment"],
  "engine/environment/WeatherState.ts": ["weatherAt"],
});
const runtimeSource = fs.readFileSync(new URL("../apps/agent-city/ui/src/game/runtime/GameRuntime.ts", import.meta.url), "utf8");
assert.doesNotMatch(runtimeSource, /from\s+["'][^"']*(?:DrivingSimulation|CarAdapter|FlightSimulation|three|react)["']/);

function fixture(kind, overrides = {}) {
  const state = { valid: true, hook: null, steps: 0, frames: [], releases: 0, disposals: 0, prepares: 0 };
  const revision = `world:${kind}`;
  const lease = { revision, isCurrent: () => state.valid, setFrameHook: (hook) => { state.hook = hook; },
    release: () => { state.releases++; state.hook = null; } };
  const binding = { isCurrent: () => state.valid, prepare: () => { state.prepares++; },
    fixedStep: () => { state.steps++; }, present: (alpha) => state.frames.push(alpha),
    settle() {}, reset() {}, dispose: () => { state.disposals++; }, ...overrides };
  const adapter = kind === "plane" ? new FlightAdapter(revision, binding) : { revision, ...binding };
  return { state, lease, adapter };
}
// One runtime alternates adapter/input shapes with no residual hook or ownership.
{
  const runtime = new GameRuntime();
  for (let n = 0; n < 20; n++) {
    const kind = n % 2 ? "plane" : "car", f = fixture(kind);
    assert.equal(kind === "plane" ? runtime.enterSync(f.lease, f.adapter) : await runtime.enter(f.lease, f.adapter), true);
    assert.equal(runtime.snapshot.phase, "paused"); runtime.resume();
    runtime.setInput(kind === "plane" ? { throttleUp: true, pitchUp: true } : { forward: true });
    f.state.hook(1 / 30); assert.equal(f.state.steps, 2);
    runtime.pause(); const before = f.state.steps; f.state.hook(0.5); assert.equal(f.state.steps, before);
    runtime.exit(); runtime.exit();
    assert.equal(f.state.releases, 1); assert.equal(f.state.disposals, 1); assert.equal(f.state.hook, null);
  }
  runtime.dispose();
}
// Activity transition discards catch-up without forcing a pause (countdown -> race).
{
  const f = fixture("plane"), runtime = new GameRuntime();
  runtime.enterSync(f.lease, f.adapter); runtime.resume(); f.state.hook(0.2);
  assert.equal(f.state.steps, 5, "bounded catch-up");
  // 2026-10-18 产品决定（赛车惯例，Ammo stepSimulation(dt, maxSubSteps) 同款）：过载丢弃
  // 超出 maxSteps 的墙钟并继续，不暂停打断玩家；原 fail-closed 暂停只保留 invalid-delta。
  assert.equal(runtime.snapshot.phase, "running", "overload drops excess wall-clock and continues"); runtime.dispose();
}

// Activity transition discards catch-up without forcing a pause (countdown -> race).
{
  let ticks = 0;
  const f = fixture("plane", { fixedStep: () => { ticks++; return false; } });
  const runtime = new GameRuntime(); runtime.enterSync(f.lease, f.adapter); runtime.resume();
  f.state.hook(0.08); assert.equal(ticks, 1); assert.equal(runtime.snapshot.phase, "running");
  f.state.hook(1 / 60); assert.equal(ticks, 2); runtime.dispose();
}
// Invalidations fail closed for the plane as well as the car; old callbacks die.
{
  let errors = 0;
  const f = fixture("plane"), runtime = new GameRuntime({ onError: () => { errors++; } });
  runtime.enterSync(f.lease, f.adapter); runtime.resume(); const old = f.state.hook;
  f.state.valid = false; old(1 / 60);
  assert.equal(runtime.snapshot.phase, "error"); assert.equal(errors, 1);
  assert.equal(f.state.steps, 0); assert.equal(f.state.releases, 1);
  const next = fixture("plane"); assert.equal(runtime.enterSync(next.lease, next.adapter), true);
  old(1 / 60); assert.equal(next.state.steps, 0); runtime.dispose();
}
// Sync admission cannot accidentally activate an async/unfinished adapter.
{
  const f = fixture("car", { prepare: async () => {} }), runtime = new GameRuntime();
  assert.equal(runtime.enterSync(f.lease, f.adapter), false);
  assert.equal(runtime.snapshot.reason, "async-adapter-in-sync-entry");
  assert.equal(f.state.releases, 1); assert.equal(f.state.hook, null);
}
// Late async preparation cannot replace a newly entered flight activity.
{
  let complete;
  const f = fixture("car", { prepare: () => new Promise((resolve) => { complete = resolve; }) }), runtime = new GameRuntime();
  const pending = runtime.enter(f.lease, f.adapter); runtime.exit();
  const next = fixture("plane"); runtime.enterSync(next.lease, next.adapter);
  complete(); assert.equal(await pending, false);
  assert.equal(runtime.snapshot.revision, next.lease.revision); assert.equal(f.state.releases, 1); runtime.dispose();
}
// Deterministic weather/sky facts, replay seeks, clear cinematic override, no timers.
{
  const f = fixture("plane", { settle: () => { throw new Error("settle-failed"); } }), runtime = new GameRuntime();
  runtime.enterSync(f.lease, f.adapter); runtime.resume(); runtime.pause();
  assert.equal(runtime.snapshot.phase, "error"); assert.equal(f.state.releases, 1); assert.equal(f.state.disposals, 1);
}
{
  const runtime = new GameRuntime(), next = fixture("plane");
  const f = fixture("plane", { reset: () => { runtime.exit(); runtime.enterSync(next.lease, next.adapter); } });
  runtime.enterSync(f.lease, f.adapter);
  assert.equal(runtime.reset(), false, "a replaced reset must not mutate the new session");
  assert.equal(runtime.snapshot.revision, next.lease.revision); assert.equal(runtime.snapshot.phase, "paused");
  assert.equal(f.state.releases, 1); runtime.dispose(); assert.equal(next.state.releases, 1);
}

// Deterministic weather/sky facts, replay seeks, clear cinematic override, no timers.
{
  const environment = new CityEnvironment();
  const t = new Date(2026, 8, 4, 10, 30).getTime();
  const snapshot = environment.sample(t);
  assert.equal(environment.sample(t + 200), snapshot);
  assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.weather));
  assert.deepEqual(snapshot.weather, weatherAt(t));
  assert.equal(snapshot.rainIntensity, snapshot.weather.kind === "rain" ? snapshot.weather.intensity : 0);
  const cinematic = environment.sample(t, 18.5);
  assert.equal(cinematic.hour, 18.5); assert.equal(cinematic.rainIntensity, 0); assert.equal(cinematic.weather.kind, "clear");
  assert.deepEqual(environment.sample(t), snapshot);
  assert.deepEqual(environment.sample(t - 86400000), new CityEnvironment().sample(t - 86400000));
  assert.throws(() => environment.sample(NaN), /invalid-environment-time/);
}
// Input aliases, focused canvas, IME/modifiers, unconditional key-up and teardown.
{
  const emitter = () => {
    const map = new Map();
    return { addEventListener(type, fn) { const set = map.get(type) ?? new Set(); set.add(fn); map.set(type, set); },
      removeEventListener(type, fn) { map.get(type)?.delete(fn); }, fire(type, event) { for (const fn of [...(map.get(type) ?? [])]) fn(event); },
      count() { return [...map.values()].reduce((n, set) => n + set.size, 0); } };
  };
  globalThis.HTMLElement = class {};
  globalThis.window = emitter(); globalThis.document = { ...emitter(), visibilityState: "visible" };
  let focused = true; const interruptions = []; let canvasBlurred = false; let canvasFocusCalls = 0;
  const canvasTarget = Object.assign(new HTMLElement(), { focus() { canvasFocusCalls += 1; }, blur() { canvasBlurred = true; } });
  document.activeElement = null;
  const source = new KeyboardInput({ keys: { KeyW: "forward", ArrowUp: "forward" }, emptyInput: () => ({ forward: false }),
    isFocused: () => focused, blurFocusTarget: () => canvasTarget, onInterrupt: (reason) => interruptions.push(reason) });
  const key = (code, extra = {}) => ({ code, target: null, prevented: false, stopped: false,
    preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...extra });
  source.attach(); source.attach();
  assert.equal(canvasFocusCalls, 0, "attaching gameplay input never focuses the canvas");
  const composing = key("KeyW", { isComposing: true }); window.fire("keydown", composing);
  assert.equal(composing.prevented, true, "canvas focus consumes a mapped composing gameplay keydown");
  assert.equal(source.snapshot().forward, true, "a physical game key still works during IME composition");
  document.fire("compositionupdate", { preventDefault() {}, stopImmediatePropagation() {} });
  assert.equal(source.snapshot().forward, true, "composition updates do not cancel a held physical control");
  window.fire("keyup", key("KeyW"));
  assert.equal(source.snapshot().forward, false);
  const composing229 = key("KeyW", { keyCode: 229 }); window.fire("keydown", composing229);
  assert.equal(composing229.prevented, true, "canvas focus consumes the legacy IME keyCode 229 event");
  assert.equal(source.snapshot().forward, true, "a mapped physical code still drives during keyCode 229");
  window.fire("keyup", key("KeyW"));
  window.fire("keydown", key("KeyW"));
  const unidentified = key("Unidentified", { isComposing: true }); window.fire("keydown", unidentified);
  assert.equal(unidentified.prevented, true, "unidentified composing keys are consumed rather than treated as controls");
  assert.equal(source.snapshot().forward, false, "an unidentified IME key clears any stale held control");
  window.fire("keydown", key("KeyW", { metaKey: true })); assert.equal(source.snapshot().forward, false);
  window.fire("keydown", key("KeyW")); window.fire("keydown", key("ArrowUp"));
  window.fire("keyup", key("KeyW")); assert.equal(source.snapshot().forward, true, "other alias still held");
  document.fire("focusin", { target: new HTMLElement() });
  assert.equal(source.snapshot().forward, false, "moving focus to a HUD control clears held vehicle input");
  const textTarget = Object.assign(new HTMLElement(), { tagName: "INPUT", type: "text", isContentEditable: false });
  document.activeElement = textTarget;
  const textKey = key("KeyW", { target: textTarget }); window.fire("keydown", textKey);
  assert.equal(textKey.prevented, false, "a genuinely focused text field keeps normal typing");
  const textImeKey = key("KeyW", { target: textTarget, isComposing: true, keyCode: 229 }); window.fire("keydown", textImeKey);
  assert.equal(textImeKey.prevented, false, "IME keydown in an ordinary text field remains available");
  const composition = { target: textTarget, inputType: "insertText", prevented: false, stopped: false,
    preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
  document.fire("compositionstart", composition); document.fire("beforeinput", composition);
  assert.equal(composition.prevented, false, "composition and beforeinput remain available to ordinary text fields");
  const inputSwitch = key("Space", { ctrlKey: true }); window.fire("keydown", inputSwitch, true);
  assert.equal(inputSwitch.prevented, false, "a text field keeps the input-source shortcut");
  window.fire("keyup", key("ArrowUp")); assert.equal(source.snapshot().forward, false);
  document.activeElement = null;
  const focusedComposition = key("KeyW", { isComposing: true }); window.fire("keydown", focusedComposition);
  assert.equal(focusedComposition.prevented, true, "window-focused gameplay consumes composing physical keydown without canvas focus");
  const focusedTextTarget = Object.assign(new HTMLElement(), { tagName: "TEXTAREA", isContentEditable: false });
  document.fire("focusin", { target: canvasTarget });
  assert.equal(canvasBlurred, true, "the game canvas is blurred if a click gives it focus");
  assert.equal(canvasFocusCalls, 0, "the input layer never restores canvas focus");
  document.activeElement = null;
  const focusedTextKey = key("KeyW", { target: focusedTextTarget }); window.fire("keydown", focusedTextKey);
  assert.equal(focusedTextKey.prevented, true, "a transient WebKit IME target is suppressed during gameplay");
  assert.equal(source.snapshot().forward, true, "physical WASD works without focusing the canvas");
  window.fire("keyup", key("KeyW", { target: focusedTextTarget }));
  const focusedUnmappedTextKey = key("KeyQ", { key: "q", target: focusedTextTarget }); window.fire("keydown", focusedUnmappedTextKey);
  assert.equal(focusedUnmappedTextKey.prevented, true, "unmapped printable keys are suppressed during gameplay");
  const focusedCompositionEvent = { target: focusedTextTarget, prevented: false, stopped: false,
    preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
  document.fire("compositionstart", focusedCompositionEvent);
  assert.equal(focusedCompositionEvent.prevented && focusedCompositionEvent.stopped, true, "composition events are suppressed during gameplay without canvas focus");
  focused = true; window.fire("keydown", key("KeyW")); window.fire("blur", {});
  assert.equal(source.snapshot().forward, false); assert.equal(interruptions.at(-1), "focus-lost");
  document.visibilityState = "hidden"; document.fire("visibilitychange", {}); assert.equal(interruptions.at(-1), "host-hidden");
  window.fire("__AV_PLUGIN_SUSPENDED__", {}); assert.equal(interruptions.at(-1), "host-suspended");
  source.detach(); source.detach(); assert.equal(window.count() + document.count(), 0, "detach releases every window/document listener");
  focused = false;
  const canvas = Object.assign(new HTMLElement(), { blur() {} });
  const steal = new KeyboardInput({ keys: { KeyW: "forward" }, emptyInput: () => ({ forward: false }),
    isFocused: () => focused, blurFocusTarget: () => canvas, onInterrupt: () => {} });
  steal.attach();
  focused = false;
  const firstDrive = key("KeyW");
  window.fire("keydown", firstDrive);
  assert.equal(focused, false, "an inactive host window cannot control the vehicle");
  assert.equal(steal.snapshot().forward, false, "no key is accepted after the host loses focus");
  steal.detach();
  delete globalThis.window; delete globalThis.document; delete globalThis.HTMLElement;
}
console.log("Shared vehicle runtime: alternating adapters, activity boundaries, cancellation/stale cleanup, deterministic environment and keyboard ownership passed.");
