import assert from "node:assert/strict";
import test from "node:test";
import { resolveMechaMode, type MechaModeInput } from "../src/game/mecha/mode.ts";

const base = (overrides: Partial<MechaModeInput> = {}): MechaModeInput => ({
  dev: true,
  prod: false,
  debug: false,
  query: new URLSearchParams(),
  remoteStatus: "idle",
  nativeProbe: false,
  localTest: false,
  debugFixture: false,
  releaseChoice: "",
  releaseStatus: null,
  encounterActive: false,
  ...overrides,
});

test("development defaults to v1.5 and an explicit classic query preserves the legacy route", () => {
  assert.deepEqual(resolveMechaMode(base()), { kind: "sequential", reason: "development_query" });
  assert.deepEqual(resolveMechaMode(base({ query: new URLSearchParams("mechaV15=1") })), { kind: "sequential", reason: "development_query" });
  assert.deepEqual(resolveMechaMode(base({ query: new URLSearchParams("mechaV15=0") })), { kind: "classic", reason: "development_classic_override" });
});

test("debug probe and local fixture routes are explicit and gated by debug builds", () => {
  assert.deepEqual(resolveMechaMode(base({ dev: false, debug: true, nativeProbe: true })), { kind: "sequential", reason: "native_probe" });
  assert.deepEqual(resolveMechaMode(base({ dev: false, debug: true, localTest: true })), { kind: "sequential", reason: "local_test" });
  assert.deepEqual(resolveMechaMode(base({ dev: false, debug: true, debugFixture: true, query: new URLSearchParams("mechaV15=1") })), { kind: "sequential", reason: "development_query" });
  assert.deepEqual(resolveMechaMode(base({ dev: false, debug: false, nativeProbe: true })), { kind: "closed", reason: "unsupported_build" });
});

test("production exposes the release picker and honors each explicit choice", () => {
  const prod = { dev: false, prod: true };
  assert.deepEqual(resolveMechaMode(base(prod)), { kind: "picker" });
  assert.deepEqual(resolveMechaMode(base({ ...prod, releaseChoice: "classic" })), { kind: "classic", reason: "release_classic" });
  assert.deepEqual(resolveMechaMode(base({ ...prod, releaseChoice: "sequential" })), { kind: "sequential", reason: "release_sequential" });
  assert.deepEqual(resolveMechaMode(base({ ...prod, releaseChoice: "status" })), { kind: "status", reason: "release_status_picker", species: null });
  assert.deepEqual(resolveMechaMode(base({ ...prod, releaseChoice: "status", releaseStatus: "gravity_core" })), { kind: "status", reason: "release_status_challenge", species: "gravity_core" });
  assert.deepEqual(resolveMechaMode(base({ ...prod, query: new URLSearchParams("mechaV15=1") })), { kind: "picker" });
});

test("remote lifecycle no longer reroutes a v1.5 release back to classic", () => {
  for (const remoteStatus of ["starting", "active", "stopping", "unknown"] as const) {
    assert.deepEqual(resolveMechaMode(base({ dev: false, prod: true, remoteStatus, releaseChoice: "sequential" })), { kind: "sequential", reason: "release_sequential" });
  }
});

test("status challenge parameters are validated and cannot attach a query challenge to an encounter", () => {
  assert.deepEqual(resolveMechaMode(base({ query: new URLSearchParams("mechaV15=1&mechaStatus=prism_warden") })), { kind: "status", reason: "development_status_query", species: "prism_warden" });
  assert.deepEqual(resolveMechaMode(base({ query: new URLSearchParams("mechaV15=1&mechaStatus=unknown") })), { kind: "closed", reason: "invalid_status_species" });
  assert.deepEqual(resolveMechaMode(base({ query: new URLSearchParams("mechaV15=1&mechaStatus=spore_leaper"), encounterActive: true })), { kind: "closed", reason: "status_challenge_encounter" });
  assert.deepEqual(resolveMechaMode(base({ prod: true, dev: false, releaseChoice: "status", releaseStatus: "unknown" as MechaModeInput["releaseStatus"] })), { kind: "closed", reason: "invalid_status_species" });
});

test("invalid build and release inputs fail closed", () => {
  assert.deepEqual(resolveMechaMode(base({ dev: true, prod: true })), { kind: "closed", reason: "invalid_build_flags" });
  assert.deepEqual(resolveMechaMode(base({ releaseChoice: "preview" as MechaModeInput["releaseChoice"] })), { kind: "closed", reason: "invalid_release_choice" });
  assert.deepEqual(resolveMechaMode(base({ dev: false, prod: false, debug: false })), { kind: "closed", reason: "unsupported_build" });
});

test("practice routes stay explicit and reject unknown species", () => {
  const prod = { dev: false, prod: true };
  assert.deepEqual(resolveMechaMode(base({ ...prod, releaseChoice: "practice" })), { kind: "practice", reason: "release_practice_picker", species: null });
  assert.deepEqual(resolveMechaMode(base({ ...prod, releaseChoice: "practice", releaseMonster: "porous_shaper" })), { kind: "practice", reason: "release_practice", species: "porous_shaper" });
  assert.deepEqual(resolveMechaMode(base({ ...prod, releaseChoice: "practice", releaseMonster: "many_core" })), { kind: "closed", reason: "invalid_practice_species" });
  assert.deepEqual(resolveMechaMode(base({ ...prod, releaseChoice: "practice", releaseMonster: "spore_leaper" })), { kind: "practice", reason: "release_practice", species: "spore_leaper" });
});

test("development query can open a catalogued monster practice", () => {
  assert.deepEqual(resolveMechaMode(base({ query: new URLSearchParams("mechaMonster=porous_shaper") })), { kind: "practice", reason: "development_practice_query", species: "porous_shaper" });
  assert.deepEqual(resolveMechaMode(base({ query: new URLSearchParams("mechaMonster=unknown") })), { kind: "closed", reason: "invalid_practice_species" });
});
