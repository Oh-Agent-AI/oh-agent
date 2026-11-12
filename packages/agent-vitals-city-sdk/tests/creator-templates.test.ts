import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { validateMiniGamePack } from "../src/content";
import { CREATOR_CAPABILITIES_V1, CREATOR_OPERATIONS_V1 } from "../src/creatorCapabilities";
import { CREATOR_TEMPLATES_V1 } from "../src/creatorTemplates";

/**
 * Creator descriptor/template source-of-truth guards (design doc
 * docs/AGENT_CREATOR_RUST_BOUNDARY_OPTIMIZATION_2026_11_12.md §5.1/§7 P1 去硬编码).
 *
 * These constants are the single human-maintained entry point: build tooling
 * (scripts/generate-creator-capabilities.mjs) renders them to assets/creator/*,
 * which Rust include_str! consumes. These tests pin the contract the generated
 * assets and the Rust side rely on; drift here breaks generation, not runtime.
 */

const assetsDir = fileURLToPath(new URL("../../../assets/creator", import.meta.url));
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as object).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
};

test("descriptor: schema/operation kinds stay within the protocol envelope", () => {
  assert.equal(CREATOR_CAPABILITIES_V1.schemaVersion, 1);
  assert.equal(typeof CREATOR_CAPABILITIES_V1.capabilityVersion, "string");
  assert.ok(CREATOR_CAPABILITIES_V1.capabilityVersion.length > 0);
  const allowedKinds = new Set(["upsert", "remove", "bind", "set"]);
  const allowedTargets = new Set(["scene.objects", "mounts", "skinId", "cityPatch"]);
  for (const operation of CREATOR_OPERATIONS_V1) {
    assert.ok(allowedKinds.has(operation.kind), `${operation.id}: kind ${operation.kind} not allowed`);
    assert.ok(allowedTargets.has(operation.target), `${operation.id}: target ${operation.target} not allowed`);
    // Collection-target removes address one entry by primary key; singleton
    // targets (cityPatch, skinId) replace/clear the whole value and need no idField.
    const singletonTargets = new Set(["cityPatch", "skinId"]);
    if (operation.kind === "remove" && !singletonTargets.has(operation.target)) {
      assert.ok(operation.idField, `${operation.id}: collection remove needs idField`);
    }
  }
});

test("templates: every pack passes validateMiniGamePack and template ids are unique", () => {
  const seen = new Set<string>();
  for (const template of CREATOR_TEMPLATES_V1) {
    assert.ok(!seen.has(template.id), `duplicate template id ${template.id}`);
    seen.add(template.id);
    const verdict = validateMiniGamePack(template.pack);
    assert.deepEqual(verdict.diagnostics, [], `${template.id}: pack must validate cleanly`);
    assert.ok(template.label.length > 0, `${template.id}: label required (project title source)`);
  }
  assert.deepEqual(seen, new Set(CREATOR_CAPABILITIES_V1.content.templates), "descriptor content.templates must list every template");
});

test("skins: descriptor content lists at least one skin (default-skin source)", () => {
  assert.ok(CREATOR_CAPABILITIES_V1.content.skins.length >= 1, "need at least one skin for project defaults");
  assert.ok(new Set(CREATOR_CAPABILITIES_V1.content.skins).size === CREATOR_CAPABILITIES_V1.content.skins.length, "skin ids must be unique");
});

test("generated assets on disk match the SDK constants (generator must have run)", () => {
  const capabilities = JSON.parse(fs.readFileSync(`${assetsDir}/capabilities.json`, "utf8")) as Record<string, unknown>;
  assert.deepEqual(capabilities, JSON.parse(JSON.stringify(canonical(CREATOR_CAPABILITIES_V1))), "capabilities.json drifted from CREATOR_CAPABILITIES_V1");
  for (const template of CREATOR_TEMPLATES_V1) {
    const rendered = JSON.parse(fs.readFileSync(`${assetsDir}/templates/${template.id}.json`, "utf8")) as Record<string, unknown>;
    assert.deepEqual(rendered, JSON.parse(JSON.stringify(canonical({
      schemaVersion: 1, templateId: template.id, label: template.label, pack: template.pack
    }))), `templates/${template.id}.json drifted from CREATOR_TEMPLATES_V1`);
  }
});
