import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { validateCityLayoutSnapshot, validateMount } from "../src/validate";
import { validateMiniGamePack } from "../src/content";
import { inspectGlbBytes } from "../src/model";

/**
 * Shared contract fixtures for the City SDK validation authority (design doc section 10:
 * valid, invalid and unauthorized input samples). Every fixture file maps to exactly one
 * validator entry point; invalid fixtures assert the first diagnostic code so ordering
 * regressions surface here.
 */
const fixturesDir = fileURLToPath(new URL("../fixtures", import.meta.url));
const load = (name: string): unknown => JSON.parse(fs.readFileSync(`${fixturesDir}/${name}`, "utf8"));

const assertFirstCode = (result: { ok: boolean; diagnostics: Array<{ code: string }> }, code: string) => {
  assert.equal(result.ok, false, `expected rejection with ${code}, got ok:true`);
  assert.equal(result.diagnostics.length > 0, true, "expected at least one diagnostic");
  assert.equal(result.diagnostics[0]?.code, code);
};

const runMount = (fixtureName: string) => {
  const input = load(fixtureName) as { layout: unknown; game: unknown; mount: unknown; resolvedRefs?: { layout: unknown; game: unknown } };
  return validateMount({ layout: input.layout, game: input.game, mount: input.mount, ...(input.resolvedRefs ? { resolvedRefs: input.resolvedRefs } : {}) });
};

test("fixture creator-game-pack.valid.json validates as a data-only mini-game pack", () => {
  const result = validateMiniGamePack(load("creator-game-pack.valid.json"));
  assert.equal(result.ok, true);
  assert.deepEqual(result.ok ? result.diagnostics : [], []);
  if (result.ok) {
    assert.equal(Object.isFrozen(result.value.rules), true);
    assert.deepEqual(Object.keys(result.value.slots), ["checkpoints", "boostPads"]);
    assert.equal(result.value.integerParameters?.timeLimitTicks?.default, 300);
  }
});

test("fixture creator-game-pack.invalid-unknown-action.json rejects unknown rule operations", () => {
  assertFirstCode(validateMiniGamePack(load("creator-game-pack.invalid-unknown-action.json")), "rule_operation_unsupported");
});

test("fixture creator-game-pack.invalid-script-injection.json rejects executable script payloads", () => {
  assertFirstCode(validateMiniGamePack(load("creator-game-pack.invalid-script-injection.json")), "rule_invalid_action");
});

test("fixture creator-game-pack.invalid-counter-range.json rejects counters beyond version 1 bounds", () => {
  const result = validateMiniGamePack(load("creator-game-pack.invalid-counter-range.json"));
  assertFirstCode(result, "rule_invalid_counter");
  assert.equal(result.ok === false && result.diagnostics[0]?.path, "rules.counters.collected");
});

test("fixture creator-mount.valid.json mounts a game onto a matching layout", () => {
  const result = runMount("creator-mount.valid.json");
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(Object.isFrozen(result.value.mount), true);
    assert.equal(result.value.mount.entryAnchorId, "spawn-a");
    assert.deepEqual(result.value.mount.bindings.checkpoints, ["zone-b"]);
  }
});

test("fixture creator-mount.invalid-slot-count.json rejects slot bindings outside the declared min/max", () => {
  assertFirstCode(runMount("creator-mount.invalid-slot-count.json"), "slot_binding_count");
});

test("fixture creator-mount.invalid-capability.json rejects anchors missing a required capability", () => {
  const result = runMount("creator-mount.invalid-capability.json");
  assertFirstCode(result, "anchor_capability_missing");
  assert.equal(result.ok === false && result.diagnostics[0]?.objectId, "walk-d");
});

test("fixture creator-mount.invalid-layout-digest.json rejects a stale layout content version", () => {
  const result = runMount("creator-mount.invalid-layout-digest.json");
  assertFirstCode(result, "content_ref_mismatch");
  assert.equal(result.ok === false && result.diagnostics[0]?.path, "mount.layout");
});

test("fixture creator-mount.invalid-anchor-not-in-layout.json rejects bindings referencing anchors outside the layout", () => {
  const result = runMount("creator-mount.invalid-anchor-not-in-layout.json");
  assertFirstCode(result, "anchor_not_found");
  assert.equal(result.ok === false && result.diagnostics[0]?.objectId, "zone-ghost");
});

test("fixture creator-layout-snapshot.valid.json validates as a versioned world snapshot", () => {
  const result = validateCityLayoutSnapshot(load("creator-layout-snapshot.valid.json"));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.worldRevision, "world-rev-2026-11-12-a");
    assert.equal(Object.isFrozen(result.value.layout), true);
    assert.equal(Object.isFrozen(result.value.layout.anchors), true);
  }
});

test("fixture creator-layout-snapshot.invalid-anchor.json rejects unsupported anchor kinds and capabilities", () => {
  const result = validateCityLayoutSnapshot(load("creator-layout-snapshot.invalid-anchor.json"));
  assertFirstCode(result, "layout_invalid_anchor_kind");
  assert.equal(result.ok === false && result.diagnostics.some(item => item.code === "layout_invalid_anchor_capabilities"), true);
});

const glbFixture = load("creator-glb-boundary.json") as { samples: Record<string, { byteLength: number; base64: string }> };
const glbSample = (name: string): Uint8Array => {
  const sample = glbFixture.samples[name];
  assert.ok(sample, `missing GLB fixture sample ${name}`);
  const bytes = Uint8Array.from(Buffer.from(sample.base64, "base64"));
  assert.equal(bytes.byteLength, sample.byteLength, `sample ${name} byteLength must match decoded bytes`);
  return bytes;
};

test("GLB fixture validMinimal inspects with a bounds warning", () => {
  const result = inspectGlbBytes(glbSample("validMinimal"));
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.diagnostics.length, 1);
  assert.equal(result.ok && result.diagnostics[0]?.code, "gltf_bounds_unavailable");
  assert.equal(result.ok && result.diagnostics[0]?.severity, "warning");
  if (result.ok) assert.equal(result.value.format, "glb-v2");
});

test("GLB fixture validWithBinaryChunk inspects an embedded buffer", () => {
  const result = inspectGlbBytes(glbSample("validWithBinaryChunk"));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.nodeCount, 0);
    assert.equal(result.value.triangleCount, 0);
  }
});

test("GLB fixture invalidMagic rejects non-GLB containers", () => {
  assertFirstCode(inspectGlbBytes(glbSample("invalidMagic")), "glb_magic_invalid");
});

test("GLB fixture unsupportedVersion rejects GLB version 1", () => {
  assertFirstCode(inspectGlbBytes(glbSample("unsupportedVersion")), "glb_version_unsupported");
});

test("GLB fixture lengthMismatch rejects declared length drift", () => {
  assertFirstCode(inspectGlbBytes(glbSample("lengthMismatch")), "glb_length_mismatch");
});

test("GLB fixture trailingJunkTruncatedChunk rejects truncated chunk headers", () => {
  assertFirstCode(inspectGlbBytes(glbSample("trailingJunkTruncatedChunk")), "glb_chunk_truncated");
});

test("GLB fixture invalidChunkJson rejects non-JSON chunk payloads", () => {
  assertFirstCode(inspectGlbBytes(glbSample("invalidChunkJson")), "glb_json_invalid");
});

test("GLB fixture missingAssetVersion rejects documents without glTF 2.0 asset version", () => {
  assertFirstCode(inspectGlbBytes(glbSample("missingAssetVersion")), "gltf_asset_invalid");
});

test("GLB fixture unsupportedRequiredExtension rejects declared extensions", () => {
  assertFirstCode(inspectGlbBytes(glbSample("unsupportedRequiredExtension")), "gltf_extension_unsupported");
});
