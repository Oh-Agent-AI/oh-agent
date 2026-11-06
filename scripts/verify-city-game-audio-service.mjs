#!/usr/bin/env node
// Device races and graph ownership, including the real plane/car sound clients.
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
const { GameAudioService, GameSfx, DrivingSfx } = await loadCity({
  "game/audio/GameAudioService.ts": ["GameAudioService"], "game/GameSfx.ts": ["GameSfx"],
  "game/driving/DrivingSfx.ts": ["DrivingSfx"],
});
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
function fixture() {
  const timers = new Map(); let serial = 0, devices = 0;
  const sources = [], nodes = [];
  const param = () => ({ value: 0, setTargetAtTime(value) { assert.ok(Number.isFinite(value)); this.value = value; },
    setValueAtTime(value) { assert.ok(Number.isFinite(value)); this.value = value; },
    exponentialRampToValueAtTime(value) { assert.ok(Number.isFinite(value)); this.value = value; }, cancelScheduledValues() {} });
  const node = () => {
    const result = { gain: param(), frequency: param(), Q: param(), disconnected: false,
      connect(target) { return target; }, disconnect() { this.disconnected = true; } };
    nodes.push(result); return result;
  };
  const source = () => {
    const result = Object.assign(node(), { stopped: false, starts: 0, start() { this.starts++; }, stop(at) {
      if (at === undefined) { this.stopped = true; this.onended?.(); }
    } });
    sources.push(result); return result;
  };
  const ctx = { state: "running", currentTime: 1, sampleRate: 100, destination: {}, resumes: 0, suspends: 0, closes: 0,
    createGain: node, createBiquadFilter: node, createOscillator: source, createBufferSource: source,
    createBuffer: (_channels, length) => ({ getChannelData: () => new Float32Array(length) }),
    resume() { this.resumes++; this.state = "running"; return Promise.resolve(); },
    suspend() { this.suspends++; this.state = "suspended"; return Promise.resolve(); },
    close() { this.closes++; this.state = "closed"; return Promise.resolve(); } };
  const service = new GameAudioService({ createContext: () => { devices++; return ctx; },
    schedule: (callback) => { const id = ++serial; timers.set(id, callback); return id; }, cancel: (id) => timers.delete(id) });
  return { ctx, service, sources, nodes, timers, get devices() { return devices; },
    runTimers() { const callbacks = [...timers.values()]; timers.clear(); for (const callback of callbacks) callback(); } };
}

// Constructors and telemetry are pure until a start gesture; both real clients
// subsequently share one device, and every loop is stopped on exit.
{
  const f = fixture(), plane = new GameSfx(f.service), car = new DrivingSfx(f.service);
  assert.equal(f.devices, 0);
  car.update({ speed: 3, maxSpeed: 13, braking: false, reversing: false });
  assert.equal(f.devices, 0, "telemetry cannot request the device");
  plane.start(); car.start(); assert.equal(f.devices, 1);
  assert.equal(f.service.snapshot.channels, 2);
  // The shared car graph owns engine/sub/LFO, brake noise, rain noise and VTOL noise.
  assert.equal(f.service.snapshot.sources, 10);
  plane.suspend(); f.runTimers(); await flush();
  assert.equal(f.ctx.suspends, 0, "plane cannot suspend an active car device");
  car.update({ speed: 5, maxSpeed: 13, braking: true, reversing: false, rainIntensity: 0.8 });
  const before = f.service.snapshot.sources; car.collision(); car.collision();
  assert.equal(f.service.snapshot.sources, before + 2, "continuous contact is throttled");
  car.suspend(); const mutedCount = f.service.snapshot.sources; car.collision();
  assert.equal(f.service.snapshot.sources, mutedCount, "paused contact cannot emit sound");
  plane.dispose(); car.dispose();
  assert.equal(f.service.snapshot.sources, 0); assert.equal(f.service.snapshot.channels, 0);
  assert.ok(f.sources.every((source) => source.stopped), "all noise loops and tones stopped");
  assert.ok(f.nodes.every((node) => node.disconnected), "all owned graph nodes disconnected");
  assert.equal(f.ctx.closes, 0, "vehicle release never closes the shared device");
  f.service.dispose(); assert.equal(f.ctx.closes, 1);
}

// A cancelled timer can still be delivered by a host. It must not mute the next
// channel; a stale channel's setActive/release cannot claim that new channel.
{
  const f = fixture(), old = f.service.acquire(); old.setActive(true); old.setActive(false);
  const lateTimer = [...f.timers.values()].at(-1); old.release();
  const next = f.service.acquire(); next.setActive(true); lateTimer();
  old.setActive(false); old.release(); f.runTimers(); await flush();
  assert.equal(f.ctx.suspends, 0); assert.equal(f.service.snapshot.activeChannels, 1);
  next.release(); f.runTimers(); await flush(); assert.equal(f.ctx.suspends, 1);
  f.service.dispose();
}

// A native suspend already in flight can complete AFTER a new vehicle starts.
// Reconciliation must wake the device, without reviving a released graph.
{
  const f = fixture(); let finishSuspend;
  f.ctx.suspend = function () { this.suspends++; return new Promise((resolve) => {
    finishSuspend = () => { this.state = "suspended"; resolve(); };
  }); };
  const old = f.service.acquire(); old.setActive(true); old.release(); f.runTimers();
  const next = f.service.acquire(); next.setActive(true);
  finishSuspend(); await flush();
  assert.equal(f.ctx.state, "running"); assert.equal(f.ctx.resumes, 1);
  assert.equal(f.service.snapshot.channels, 1); next.release(); f.service.dispose();
}

// Repeated restarts do not accumulate graphs or require a new audio device.
{
  const f = fixture(), plane = new GameSfx(f.service), car = new DrivingSfx(f.service);
  for (let i = 0; i < 20; i++) {
    const client = i % 2 ? plane : car; client.start(); client.stop();
    assert.equal(f.service.snapshot.channels, 0); assert.equal(f.service.snapshot.sources, 0);
  }
  assert.equal(f.devices, 1); assert.ok(f.sources.every((source) => source.stopped));
  plane.dispose(); car.dispose(); f.service.dispose();
}

// Device/autoplay failure degrades without interrupting gameplay.
{
  const service = new GameAudioService({ createContext: () => { throw new Error("no-device"); } });
  const car = new DrivingSfx(service); assert.doesNotThrow(() => car.start());
  assert.equal(car.available, false); car.suspend(); car.dispose(); service.dispose();
}
console.log("Game audio: one lazy device, isolated channels, stale timer/native suspend races, real vehicle cleanup and 20 restart cycles passed.");
