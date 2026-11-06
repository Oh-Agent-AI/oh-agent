#!/usr/bin/env node
// Canvas command contract, not screenshot/pixel or physical-model acceptance.
import assert from "node:assert/strict";
import { loadCity } from "./city-kit/index.mjs";
const { traceBlockSurface, subtractBlockSurfaceExclusions } = await loadCity({
  "engine/blockSurface.ts": ["traceBlockSurface", "subtractBlockSurfaceExclusions"],
});
const commands = [], stack = [];
const ctx = { globalCompositeOperation: "source-over", lineWidth: 1,
  save() { stack.push([this.globalCompositeOperation, this.lineWidth]); },
  restore() { [this.globalCompositeOperation, this.lineWidth] = stack.pop(); },
  beginPath() { commands.push(["begin"]); }, closePath() { commands.push(["close"]); },
  moveTo(x, z) { commands.push(["move", x, z]); }, lineTo(x, z) { commands.push(["line", x, z]); },
  arc(x, z, r) { commands.push(["arc", x, z, r]); },
  fill() { commands.push(["fill", this.globalCompositeOperation]); },
  stroke() { commands.push(["stroke", this.globalCompositeOperation, this.lineWidth, this.lineCap, this.lineJoin]); },
};
const point = (x, z) => ({ x, z });
const block = { polygon: [point(0, 0), point(80, 0), point(80, 80), point(0, 80)],
  holes: [[point(20, 20), point(20, 40), point(40, 40), point(40, 20)]],
  surfaceExclusions: [
    { kind: "road-corridor", id: "bent", points: [point(0, 0), point(40, 0), point(40, 80)], width: 9 },
    { kind: "site-circle", id: "owner", x: 55, z: 55, radius: 8 },
    { kind: "highway-corridor", id: "deck", points: [point(10, 0), point(10, 80)], width: 12.5 },
  ] };
const before = JSON.stringify(block), pixel = (x, z) => [x * 2 + 1, z * 2 + 3];
traceBlockSurface(ctx, block, pixel);
assert.equal(commands.filter(c => c[0] === "move").length, 2, "holes are explicit path rings");
assert.equal(commands.filter(c => c[0] === "close").length, 2);
commands.length = 0;
subtractBlockSurfaceExclusions(ctx, [block, block], pixel, 2);
assert.deepEqual(commands.filter(c => c[0] === "stroke"), [
  ["stroke", "destination-out", 18, "round", "round"],
  ["stroke", "destination-out", 25, "round", "round"],
], "deduplicate actual envelopes and do not add their margins again");
assert.ok(commands.some(c => JSON.stringify(c) === JSON.stringify(["line", 81, 3])), "keep the bent road's actual intermediate vertex");
assert.ok(commands.some(c => JSON.stringify(c) === JSON.stringify(["arc", 111, 113, 16])), "erase the real site reserve");
assert.ok(commands.filter(c => c[0] === "fill").every(c => c[1] === "destination-out"));
assert.equal(ctx.globalCompositeOperation, "source-over", "subtraction cannot leak to terrain or subsequent road painting");
assert.equal(stack.length, 0);
assert.equal(JSON.stringify(block), before);
console.log("City block surface: hole rings, real bent corridor/caps, exact provided margins, reserve subtraction, deduplication and state isolation passed; pixel/visual QA remains separate.");
