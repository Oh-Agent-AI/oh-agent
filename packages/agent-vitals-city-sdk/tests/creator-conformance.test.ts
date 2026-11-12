import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { validateSceneDraft, validateMount } from "../src/validate";
import { validateMiniGamePack } from "../src/content";

/**
 * Creator validation conformance corpus (design doc
 * docs/AGENT_CREATOR_RUST_BOUNDARY_OPTIMIZATION_2026_11_12.md §3.3/§3.4/§7 P0 item 2).
 *
 * Every case in <repo>/fixtures/creator/conformance records the city-sdk validator's
 * accept/reject verdict for one shared input sample. The same JSON corpus is the
 * baseline a later Rust-side test consumes, so the `expectTs` annotations must keep
 * matching real TS behavior: when the validator drifts, the failing assertion prints
 * the actual first diagnostic code so the corpus can be re-annotated deliberately.
 *
 * rustNote values are static-reading conclusions about
 * apps/desktop/src-tauri/src/creator_projects.rs (validate_game / validate_scene_object /
 * validate_mount); they are expectations, not executed Rust assertions.
 */
interface ConformanceCase {
  ruleFamily: "game" | "scene" | "mount";
  case: string;
  expectTs: string;
  input: Record<string, unknown>;
  rustNote: string;
}

const casesDir = fileURLToPath(new URL("../../../fixtures/creator/conformance", import.meta.url));
const caseNames = fs.readdirSync(casesDir).filter(name => name.endsWith(".json")).sort();
const loadCase = (name: string): ConformanceCase => JSON.parse(fs.readFileSync(`${casesDir}/${name}`, "utf8")) as ConformanceCase;

const runCase = (fixture: ConformanceCase): { ok: boolean; diagnostics: Array<{ code: string; path?: string; objectId?: string }> } => {
  if (fixture.ruleFamily === "game") return validateMiniGamePack(fixture.input);
  if (fixture.ruleFamily === "scene") return validateSceneDraft(fixture.input);
  const input = fixture.input as {
    layout: unknown; game: unknown; mount: unknown;
    resolvedRefs?: { layout: unknown; game: unknown };
  };
  return validateMount({
    layout: input.layout,
    game: input.game,
    mount: input.mount,
    ...(input.resolvedRefs ? { resolvedRefs: input.resolvedRefs as never } : {})
  });
};

test("conformance corpus shape: at least 16 cases across all three rule families", () => {
  assert.ok(caseNames.length >= 16, `expected at least 16 corpus cases, found ${caseNames.length}`);
  const families = new Set(caseNames.map(name => loadCase(name).ruleFamily));
  assert.deepEqual([...families].sort(), ["game", "mount", "scene"]);
  for (const name of caseNames) {
    const fixture = loadCase(name);
    assert.equal(fixture.ruleFamily === "game" || fixture.ruleFamily === "scene" || fixture.ruleFamily === "mount", true, `${name}: unknown ruleFamily`);
    assert.equal(typeof fixture.case, "string", `${name}: missing case name`);
    assert.equal(fixture.expectTs === "ok" || fixture.expectTs.startsWith("error:"), true, `${name}: expectTs must be "ok" or "error:<code>"`);
    assert.equal(typeof fixture.input, "object", `${name}: missing input`);
    assert.equal(typeof fixture.rustNote === "string" && fixture.rustNote.length > 0, true, `${name}: missing rustNote`);
  }
});

for (const name of caseNames) {
  test(`conformance ${name} matches its recorded TS verdict`, () => {
    const fixture = loadCase(name);
    const result = runCase(fixture);
    const actual = result.ok ? "ok" : `error:${result.diagnostics[0]?.code}`;
    if (fixture.expectTs === "ok") {
      assert.equal(result.ok, true, `${name}: expected TS to accept, actual first diagnostic: ${actual}`);
    } else {
      const expectedCode = fixture.expectTs.slice("error:".length);
      assert.equal(result.ok, false, `${name}: expected TS rejection ${fixture.expectTs}, got ok:true`);
      assert.equal(
        result.diagnostics[0]?.code, expectedCode,
        `${name}: expected first diagnostic code ${expectedCode}, actual: ${actual} (update expectTs only after a reviewed contract change)`
      );
    }
  });
}
