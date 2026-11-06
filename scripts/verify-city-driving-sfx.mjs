#!/usr/bin/env node
// Driving sfx contract: module interface + pure frequency/volume mapping. Web Audio
// is unavailable under Node, so the audio graph silently degrades to null (verified:
// no throw) and the numeric mapping is asserted directly on the exported pure helpers.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import vm from "node:vm";
const require = createRequire(new URL("../apps/agent-city/ui/package.json", import.meta.url));
const { buildSync } = require("esbuild");
const code = buildSync({ entryPoints: [new URL("../apps/agent-city/ui/src/game/driving/DrivingSfx.ts", import.meta.url).pathname], bundle: true, write: false, platform: "node", format: "cjs" }).outputFiles[0].text;
const mod = { exports: {} };
vm.runInNewContext(code, { module: mod, exports: mod.exports, require, console });
const { DrivingSfx, engineFrequency, engineVolume } = mod.exports;

// --- engineFrequency: idle floor 42Hz, max 180Hz, |speed| normalized by maxSpeed.
assert.ok(Math.abs(engineFrequency(0, 13) - 42) < 1e-9, "idle floor keeps zero speed audible");
assert.ok(Math.abs(engineFrequency(13, 13) - 180) < 1e-9, "full forward speed reaches max pitch");
assert.ok(Math.abs(engineFrequency(-13, 13) - 180) < 1e-9, "pitch uses absolute (signed) speed");
assert.ok(Math.abs(engineFrequency(6.5, 13) - 111) < 1e-9, "midpoint maps linearly");
assert.ok(Math.abs(engineFrequency(-4, 4) - 180) < 1e-9, "reverse max normalizes by its own maxSpeed");
let prev = -Infinity;
for (let s = 0; s <= 13; s += 0.5) {
  const f = engineFrequency(s, 13);
  assert.ok(f > prev, "frequency strictly increases with speed");
  assert.ok(f >= 42 - 1e-9 && f <= 180 + 1e-9, "frequency stays in [idleFloor, maxPitch]");
  prev = f;
}

// --- Extreme / malformed inputs must converge to bounds, never throw.
assert.ok(Math.abs(engineFrequency(1e9, 13) - 180) < 1e-9);
assert.ok(Math.abs(engineFrequency(-1e9, 13) - 180) < 1e-9);
assert.ok(Math.abs(engineFrequency(NaN, 13) - 42) < 1e-9);
assert.ok(Math.abs(engineFrequency(Infinity, 13) - 180) < 1e-9);
assert.ok(engineFrequency(5, 0) >= 42 && engineFrequency(5, 0) <= 180 + 1e-9, "zero maxSpeed does not divide by zero");

// --- engineVolume: quiet at idle (never silent), louder at speed.
const vIdle = engineVolume(0, 13);
const vMax = engineVolume(13, 13);
assert.ok(vIdle > 0, "idle volume is quiet but not silent");
assert.ok(vMax > vIdle, "volume grows with speed");
assert.ok(vMax <= 1, "volume stays <= 1");
assert.ok(engineVolume(-13, 13) === vMax, "volume uses absolute speed");
assert.ok(engineVolume(NaN, 13) === vIdle && engineVolume(1e9, 13) === vMax, "volume extremes converge");

// --- Interface contract under Node (no AudioContext): silent degradation, no throws.
const sfx = new DrivingSfx();
assert.equal(sfx.isMuted, false);
sfx.update({ speed: 0, maxSpeed: 13, braking: false, reversing: false });
sfx.update({ speed: 13, maxSpeed: 13, braking: true, reversing: false });
sfx.update({ speed: -4, maxSpeed: 13, braking: false, reversing: true });
for (const speed of [NaN, Infinity, -Infinity, 1e9, -1e9, 0]) {
  sfx.update({ speed, maxSpeed: 13, braking: true, reversing: true });
  sfx.update({ speed, maxSpeed: 0, braking: false, reversing: false });
}
sfx.collision();
sfx.setMuted(true);
assert.equal(sfx.isMuted, true);
sfx.update({ speed: 5, maxSpeed: 13, braking: false, reversing: false });
sfx.collision();
sfx.setMuted(false);
assert.equal(sfx.isMuted, false);
sfx.dispose();
sfx.dispose();  // idempotent
sfx.update({ speed: 5, maxSpeed: 13, braking: false, reversing: false });  // post-dispose is a no-op
sfx.collision();
sfx.setMuted(true);
console.log("Driving sfx verified: idle floor 42Hz, max 180Hz, monotonic mapping, extreme-input convergence, silent degradation without AudioContext, idempotent dispose.");
