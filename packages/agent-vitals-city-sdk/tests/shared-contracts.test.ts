import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ACTOR_INTENT_KINDS_V1, TRAVEL_MODES_V1, WORLD_CAPABILITIES_V2,
  type ActorIntentV1,
} from "../src/contracts";
import {
  CITY_WORLD_PLAN_V1_JSON_SCHEMA, CITY_WORLD_SNAPSHOT_V4_JSON_SCHEMA,
} from "../src/schema";
import { validateCityJsonSchema, validateCityWorldSnapshot, validateWorldPlan } from "../src/sharedValidate";
import { compileWorldFixtureV1, createWorldCompilerFixtureV1 } from "../src/testing";
import { compileRules, createRun, runHeadless } from "../src/runtime";
import * as root from "../src/index";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const packageJson = JSON.parse(fs.readFileSync(`${packageRoot}/package.json`, "utf8")) as {
  name: string;
  exports: Record<string, { types: string; import: string }>;
};

test("package identity and all public entry points expose compatible built artifacts", async () => {
  assert.equal(packageJson.name, "@oh-agent/city-sdk");
  assert.deepEqual(Object.keys(packageJson.exports).sort(), [".", "./authoring", "./contracts", "./runtime", "./testing", "./validate"]);
  const [rootBuild, contracts, authoring, validation, testing, runtime] = await Promise.all([
    import("../dist/index.js"), import("../dist/contracts.js"), import("../dist/authoring.js"),
    import("../dist/validate.js"), import("../dist/testing.js"), import("../dist/runtime.js"),
  ]);
  assert.equal(typeof rootBuild.compileWorld, "function");
  assert.deepEqual(contracts.WORLD_CAPABILITIES_V2, WORLD_CAPABILITIES_V2);
  assert.equal(typeof authoring.compileWorld, "function");
  assert.equal(typeof validation.validateWorldPlan, "function");
  assert.equal(typeof validation.validateCityLayout, "function");
  assert.equal(testing.compileWorldFixtureV1().header.snapshotDigest, compileWorldFixtureV1().header.snapshotDigest);
  assert.equal(typeof runtime.compileRules, "function");
  assert.equal("canInvoke" in runtime, false);
});

test("legacy runtime imports and root exports retain their V1 surface", () => {
  assert.equal(root.compileRules, compileRules);
  assert.equal(root.createRun, createRun);
  assert.equal(root.runHeadless, runHeadless);
  assert.equal(typeof root.validateMiniGamePack, "function");
  assert.equal(typeof root.validateContentPackageManifestV2, "function");
  assert.equal(typeof root.validateWorldPlanPatch, "function");
});

test("schema enums and runtime validation share the contract constants", () => {
  const definitions = CITY_WORLD_PLAN_V1_JSON_SCHEMA.$defs as Record<string, { enum?: readonly string[] }>;
  assert.deepEqual(definitions.WorldCapabilityV2?.enum, WORLD_CAPABILITIES_V2);
  assert.deepEqual(definitions.ActorIntentV1?.properties, {
    kind: { enum: [...ACTOR_INTENT_KINDS_V1] }, targetId: { $ref: "#/$defs/StableIdV1" },
    payload: { type: "object", additionalProperties: { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] }, maxProperties: 128 },
  });
  const anchor = (CITY_WORLD_PLAN_V1_JSON_SCHEMA.$defs as Record<string, any>).AnchorDtoV2;
  assert.deepEqual(anchor.properties.travelModes.items.enum, TRAVEL_MODES_V1);
  assert.equal(CITY_WORLD_SNAPSHOT_V4_JSON_SCHEMA.$schema, "https://json-schema.org/draft/2020-12/schema");

  const fixture = createWorldCompilerFixtureV1();
  const plan = structuredClone(fixture.plan);
  plan.anchors[0]!.travelModes = ["teleport"] as never;
  assert.equal(validateWorldPlan(plan).ok, false);
  const intent: ActorIntentV1 = { kind: "speak", targetId: "resident:keeper", payload: { text: "hello", urgent: false } };
  assert.equal(validateCityJsonSchema(intent, { $ref: "#/$defs/ActorIntentV1", $defs: definitions }).ok, true);
});

test("compiled snapshots validate against the same schema used by the runtime", () => {
  const snapshot = compileWorldFixtureV1();
  assert.equal(validateCityJsonSchema(snapshot, CITY_WORLD_SNAPSHOT_V4_JSON_SCHEMA).ok, true);
  assert.equal(validateCityWorldSnapshot(snapshot).ok, true);
  const malformed = structuredClone(snapshot) as any;
  malformed.extra = true;
  assert.equal(validateCityWorldSnapshot(malformed).ok, false);
  malformed.extra = undefined;
  delete malformed.extra;
  malformed.header.capabilities = ["world.unknown"];
  assert.equal(validateCityWorldSnapshot(malformed).ok, false);
});

test("quaternions, ring normals, floats, and set-like arrays normalize deterministically", () => {
  const fixture = createWorldCompilerFixtureV1();
  const first = structuredClone(fixture.plan);
  first.objects[0]!.transform.rotation = [0, 0, 0, 2];
  first.volumes[1]!.geometry = {
    kind: "ring", center: [5, 1, 0], normal: [2, 0, 0],
    innerRadiusMeters: 1, outerRadiusMeters: 2, thicknessMeters: 1,
  };
  first.places[0]!.activities = ["trade", "meet"];
  first.residents[0]!.schedule![0]!.daysOfWeek = [5, 4, 3, 2, 1];
  const checked = validateWorldPlan(first);
  assert.equal(checked.ok, true);
  if (checked.ok) {
    assert.deepEqual(checked.value.objects[0]?.transform.rotation, [0, 0, 0, 1]);
    const ring = checked.value.volumes.find(volume => volume.id === "volume:harbor-ring");
    assert.deepEqual(ring?.geometry.kind === "ring" && ring.geometry.normal, [1, 0, 0]);
    assert.deepEqual(checked.value.places[0]?.activities, ["meet", "trade"]);
    assert.deepEqual(checked.value.residents[0]?.schedule?.[0]?.daysOfWeek, [1, 2, 3, 4, 5]);
  }
});

test("compile context capabilities are unique, declared, and canonically sorted", () => {
  const fixture = createWorldCompilerFixtureV1();
  const context = structuredClone(fixture.context);
  context.capabilities.reverse();
  const snapshot = root.compileWorld(fixture.plan, context);
  const expected = [...fixture.context.capabilities].sort();
  assert.deepEqual(snapshot.header.capabilities, expected);
  context.capabilities = ["world.snapshot", "world.snapshot"];
  assert.equal(root.compileWorldResult(fixture.plan, context).ok, false);
});

test("package lock identity follows package.json without dependency changes", () => {
  const lock = JSON.parse(fs.readFileSync(`${packageRoot}/package-lock.json`, "utf8")) as {
    name: string; packages: Record<string, { name?: string }>;
  };
  assert.equal(lock.name, packageJson.name);
  assert.equal(lock.packages[""]?.name, packageJson.name);
});
