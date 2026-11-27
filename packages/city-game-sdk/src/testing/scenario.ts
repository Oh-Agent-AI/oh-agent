import type { GameDiagnosticV1 } from "../protocol/diagnostics";
import { deepFreeze } from "../protocol/freeze";
import type { ResultV1 } from "../protocol/result";

/**
 * PR06 scenario/assertion contract: separating "the headless run executed
 * fine" from "the game passed". A scenario is a bounded, closed-vocabulary
 * list of assertions the runner evaluates from its own view of the run —
 * final `GameTelemetryV1` plus the end-of-run tick budget. There is
 * deliberately no escape hatch into game code: an assertion the runner
 * cannot evaluate reports `"unknown"` and the verdict degrades to
 * `"inconclusive"`, never a silent pass.
 *
 * Evaluation point of every kind (all at end-of-run, deterministic):
 * - `outcome`              → `telemetry.outcome` (the game's own finish()
 *                            verdict; `"success" | "failure" | null`. The host
 *                            closes `GameOutcomeV1` to success/failure, so
 *                            expecting any other string can never pass).
 * - `entityCountAtLeast`   → `telemetry.entities` (live entity count at the
 *   `entityCountAtMost`      end of the run).
 * - `hudFlag`              → `telemetry.hud[key]` (final published HUD; the
 *                            host keeps HUD last-write-wins, no per-tick
 *                            history is retained).
 * - `counterAtLeast`       → `telemetry.counters[key]` (host aggregate
 *   `counterEquals`          counters; monotone within a run, so end-of-run
 *                            is also their maximum).
 * - `finishedWithinTicks`  → `telemetry.tick` (authoritative tick count at
 *                            the end of the run).
 *
 * Per-tick assertions (e.g. "entity present at tick N") are not representable
 * yet: the runner keeps no per-tick history. That is a documented limitation,
 * not an omission of the closed vocabulary.
 */

export const GAME_TEST_ASSERTION_KINDS_V1 = [
  "outcome",
  "entityCountAtLeast",
  "entityCountAtMost",
  "hudFlag",
  "counterAtLeast",
  "counterEquals",
  "finishedWithinTicks",
] as const;
export type GameTestAssertionKindV1 = (typeof GAME_TEST_ASSERTION_KINDS_V1)[number];

/** The host counter record is closed (`GameTelemetryV1.counters`); assertion
 * keys are validated against it so a typo can never evaluate to `unknown`. */
export const GAME_TEST_COUNTER_KEYS_V1 = [
  "spawns",
  "destroys",
  "fixedUpdates",
  "hudUpdates",
  "audioPlays",
  "events",
  "errors",
] as const;
export type GameTestCounterKeyV1 = (typeof GAME_TEST_COUNTER_KEYS_V1)[number];

export const GAME_TEST_ASSERTION_STATUSES_V1 = ["passed", "failed", "unknown"] as const;
export type GameTestAssertionStatusV1 = (typeof GAME_TEST_ASSERTION_STATUSES_V1)[number];

export const GAME_TEST_VERDICTS_V1 = ["passed", "failed", "inconclusive"] as const;
export type GameTestVerdictV1 = (typeof GAME_TEST_VERDICTS_V1)[number];

export const GAME_TEST_VERDICT_REASONS_V1 = ["tick_budget_exhausted", "unresolved_assertions"] as const;
export type GameTestVerdictReasonV1 = (typeof GAME_TEST_VERDICT_REASONS_V1)[number];

/** Bounded on purpose: a scenario travels inline through MCP argv and is
 * small enough to audit by eye. */
export const MAX_SCENARIO_ID = 128;
export const MAX_SCENARIO_DESCRIPTION = 256;
export const MAX_ASSERTION_ID = 64;
export const MAX_SCENARIO_ASSERTIONS = 8;
export const MAX_SCENARIO_TICKS = 3_600;
export const MAX_SCENARIO_SEED = 4_294_967_295;
const MAX_HUD_KEY = 64;
const MAX_COUNT = 1_000_000;

/** Same identifier shape as the desktop rule ids: letters/digits first, then
 * `.`, `_`, `:` and `-` allowed. */
const SCENARIO_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const ASSERTION_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/;

export type GameTestAssertionV1 = Readonly<{
  id: string;
  kind: GameTestAssertionKindV1;
  /** kind = "outcome": expected `GameOutcomeV1`. */
  expectOutcome?: "success" | "failure";
  /** kind = "entityCountAtLeast" / "entityCountAtMost". */
  count?: number;
  /** kind = "hudFlag" (HUD key) / "counterAtLeast" / "counterEquals"
   * (closed host counter key). */
  key?: string;
  /** kind = "hudFlag": required HUD value (JSON scalar for determinism). */
  equals?: string | number | boolean | null;
  /** kind = "counterAtLeast" / "counterEquals". */
  value?: number;
  /** kind = "finishedWithinTicks". */
  max?: number;
}>;

export type GameTestScenarioV1 = Readonly<{
  schemaVersion: 1;
  scenarioId: string;
  description?: string;
  /** Overrides the runner request's seed for this scenario. */
  seed?: number;
  /** Overrides the requested tick budget (still capped at MAX_SCENARIO_TICKS). */
  maxTicks?: number;
  assertions: readonly GameTestAssertionV1[];
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Scenario diagnostics reuse the closed `game_argument_invalid` code: a
 * scenario is a runner argument (the headless script maps an invalid one to
 * `game_argument_invalid`), so no new diagnostic vocabulary is introduced. */
const invalid = (field: string, message: string): GameDiagnosticV1 =>
  Object.freeze({
    code: "game_argument_invalid" as const,
    severity: "error" as const,
    stage: "test" as const,
    message: `${field}: ${message}`,
  });

function checkExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  field: string,
  diagnostics: GameDiagnosticV1[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) diagnostics.push(invalid(`${field}.${key}`, "Unsupported field."));
  }
  for (const key of required) {
    if (!(key in value)) diagnostics.push(invalid(`${field}.${key}`, "Missing required field."));
  }
}

function checkBoundedString(value: unknown, field: string, max: number, pattern: RegExp, diagnostics: GameDiagnosticV1[]): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    diagnostics.push(invalid(field, `Must be a non-empty string of at most ${max} characters.`));
    return false;
  }
  if (!pattern.test(value)) {
    diagnostics.push(invalid(field, "Must be a stable identifier: letters/digits first, then `.`/`_`/`:`/`-`."));
    return false;
  }
  return true;
}

function checkBoundedInteger(value: unknown, field: string, min: number, max: number, diagnostics: GameDiagnosticV1[]): boolean {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    diagnostics.push(invalid(field, `Must be an integer from ${min} to ${max}.`));
    return false;
  }
  return true;
}

function checkAssertion(input: unknown, index: number, diagnostics: GameDiagnosticV1[]): GameTestAssertionV1 | null {
  const field = `assertions[${index}]`;
  if (!isRecord(input)) {
    diagnostics.push(invalid(field, "Assertion must be a JSON object."));
    return null;
  }
  const allowed = ["id", "kind", "expectOutcome", "count", "key", "equals", "value", "max"] as const;
  const required = ["id", "kind"] as const;
  checkExactKeys(input, allowed, required, field, diagnostics);
  checkBoundedString(input.id, `${field}.id`, MAX_ASSERTION_ID, ASSERTION_ID, diagnostics);
  const kind = input.kind;
  if (typeof kind !== "string" || !(GAME_TEST_ASSERTION_KINDS_V1 as readonly string[]).includes(kind)) {
    diagnostics.push(invalid(`${field}.kind`, `Must be one of: ${GAME_TEST_ASSERTION_KINDS_V1.join(", ")}.`));
    return null;
  }
  const assertion: Record<string, unknown> = { id: input.id, kind };
  switch (kind as GameTestAssertionKindV1) {
    case "outcome":
      if (input.expectOutcome !== "success" && input.expectOutcome !== "failure") {
        diagnostics.push(invalid(`${field}.expectOutcome`, `Must be "success" or "failure".`));
      } else {
        assertion.expectOutcome = input.expectOutcome;
      }
      break;
    case "entityCountAtLeast":
    case "entityCountAtMost":
      if (checkBoundedInteger(input.count, `${field}.count`, 0, MAX_COUNT, diagnostics)) assertion.count = input.count;
      break;
    case "hudFlag":
      if (checkBoundedString(input.key, `${field}.key`, MAX_HUD_KEY, /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/, diagnostics)) {
        assertion.key = input.key;
      }
      if (input.equals === null || ["string", "number", "boolean"].includes(typeof input.equals)) {
        assertion.equals = input.equals as string | number | boolean | null;
      } else {
        diagnostics.push(invalid(`${field}.equals`, "Must be a JSON scalar (string, number, boolean or null)."));
      }
      break;
    case "counterAtLeast":
    case "counterEquals":
      if (typeof input.key !== "string" || !(GAME_TEST_COUNTER_KEYS_V1 as readonly string[]).includes(input.key)) {
        diagnostics.push(invalid(`${field}.key`, `Must be one of: ${GAME_TEST_COUNTER_KEYS_V1.join(", ")}.`));
      } else {
        assertion.key = input.key;
      }
      if (checkBoundedInteger(input.value, `${field}.value`, 0, MAX_COUNT, diagnostics)) assertion.value = input.value;
      break;
    case "finishedWithinTicks":
      if (checkBoundedInteger(input.max, `${field}.max`, 1, MAX_SCENARIO_TICKS, diagnostics)) assertion.max = input.max;
      break;
  }
  return assertion as GameTestAssertionV1;
}

/** Bounded, fail-closed scenario validation: any diagnostic (unknown field,
 * missing field, cap violation, kind/key outside the closed vocabulary)
 * rejects the whole scenario. Deep semantics stay with the runner. */
export function validateGameTestScenarioV1(input: unknown): ResultV1<GameTestScenarioV1> {
  const diagnostics: GameDiagnosticV1[] = [];
  if (!isRecord(input)) {
    return { ok: false, diagnostics: Object.freeze([invalid("$", "Scenario must be a JSON object.")]) };
  }
  const allowed = ["schemaVersion", "scenarioId", "description", "seed", "maxTicks", "assertions"] as const;
  const required = ["schemaVersion", "scenarioId", "assertions"] as const;
  checkExactKeys(input, allowed, required, "$", diagnostics);
  if (input.schemaVersion !== 1) {
    diagnostics.push(invalid("$.schemaVersion", "Only scenario schema version 1 is supported by this validator."));
  }
  checkBoundedString(input.scenarioId, "$.scenarioId", MAX_SCENARIO_ID, SCENARIO_ID, diagnostics);
  if (input.description !== undefined) {
    if (typeof input.description !== "string" || input.description.length === 0 || input.description.length > MAX_SCENARIO_DESCRIPTION) {
      diagnostics.push(invalid("$.description", `Must be a non-empty string of at most ${MAX_SCENARIO_DESCRIPTION} characters.`));
    }
  }
  if (input.seed !== undefined) checkBoundedInteger(input.seed, "$.seed", 0, MAX_SCENARIO_SEED, diagnostics);
  if (input.maxTicks !== undefined) checkBoundedInteger(input.maxTicks, "$.maxTicks", 1, MAX_SCENARIO_TICKS, diagnostics);
  const assertions: GameTestAssertionV1[] = [];
  if (!Array.isArray(input.assertions) || input.assertions.length < 1 || input.assertions.length > MAX_SCENARIO_ASSERTIONS) {
    diagnostics.push(invalid("$.assertions", `Must be an array of 1..${MAX_SCENARIO_ASSERTIONS} assertions.`));
  } else {
    const seen = new Set<string>();
    for (const [index, item] of input.assertions.entries()) {
      const assertion = checkAssertion(item, index, diagnostics);
      if (assertion === null) continue;
      if (seen.has(assertion.id)) {
        diagnostics.push(invalid(`$.assertions[${index}].id`, "Duplicate assertion id."));
        continue;
      }
      seen.add(assertion.id);
      assertions.push(assertion);
    }
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics: Object.freeze(diagnostics) };
  const value: Record<string, unknown> = { schemaVersion: 1, scenarioId: input.scenarioId, assertions };
  if (input.description !== undefined) value.description = input.description;
  if (input.seed !== undefined) value.seed = input.seed;
  if (input.maxTicks !== undefined) value.maxTicks = input.maxTicks;
  return { ok: true, value: deepFreeze(value) as GameTestScenarioV1, diagnostics: Object.freeze([]) };
}

/** What the evaluator needs from the runner's view of one finished headless
 * run. `finishedWithinBudget` is false when the tick budget expired while the
 * game was still running (the game never reached its own end state). */
export type GameTestRunObservationV1 = Readonly<{
  outcome: string | null;
  tick: number;
  entities: number;
  hud: Readonly<Record<string, unknown>> | null;
  counters: Readonly<Record<string, number>>;
  finishedWithinBudget: boolean;
}>;

export type GameTestAssertionResultV1 = Readonly<{
  id: string;
  kind: GameTestAssertionKindV1;
  status: GameTestAssertionStatusV1;
  /** Bounded human-readable reason for `failed`/`unknown` results. */
  diagnostic?: string;
}>;

export type GameTestScenarioResultV1 = Readonly<{
  scenarioId: string;
  verdict: GameTestVerdictV1;
  /** Present exactly when the verdict is `inconclusive`. */
  verdictReason?: GameTestVerdictReasonV1;
  assertions: readonly GameTestAssertionResultV1[];
}>;

const diagnostic = (message: string): string => message.slice(0, 200);

/**
 * Pure, deterministic evaluation of a validated scenario against one run's
 * final observation. Verdict rules (the contract the MCP response and the
 * test record both carry):
 * - any assertion `unknown`            → `inconclusive` (`unresolved_assertions`)
 * - any assertion `failed`             → `failed` (decisive even if the run
 *                                        was cut off by the tick budget)
 * - all passed, game still running at
 *   budget end                         → `inconclusive` (`tick_budget_exhausted`;
 *                                        more ticks might have flipped an
 *                                        assertion, so never `passed`)
 * - all passed, game reached its own
 *   end state                          → `passed`
 */
export function evaluateGameTestScenarioV1(
  scenario: GameTestScenarioV1,
  observation: GameTestRunObservationV1,
): GameTestScenarioResultV1 {
  const assertions = scenario.assertions.map((assertion): GameTestAssertionResultV1 => {
    const base = { id: assertion.id, kind: assertion.kind };
    switch (assertion.kind) {
      case "outcome": {
        if (observation.outcome === null) {
          return { ...base, status: "failed", diagnostic: diagnostic("The game never finished (outcome was null).") };
        }
        if (observation.outcome !== assertion.expectOutcome) {
          return { ...base, status: "failed", diagnostic: diagnostic(`Outcome was ${observation.outcome}.`) };
        }
        return { ...base, status: "passed" };
      }
      case "entityCountAtLeast":
      case "entityCountAtMost": {
        if (typeof observation.entities !== "number" || !Number.isFinite(observation.entities)) {
          return { ...base, status: "unknown", diagnostic: diagnostic("The run reported no entity count.") };
        }
        const passed = assertion.kind === "entityCountAtLeast"
          ? observation.entities >= (assertion.count as number)
          : observation.entities <= (assertion.count as number);
        return passed ? { ...base, status: "passed" } : {
          ...base,
          status: "failed",
          diagnostic: diagnostic(`Entity count was ${observation.entities}.`),
        };
      }
      case "hudFlag": {
        if (observation.hud === null || typeof observation.hud !== "object") {
          return { ...base, status: "failed", diagnostic: diagnostic("The game never published a HUD.") };
        }
        const key = assertion.key as string;
        if (!(key in observation.hud)) {
          return { ...base, status: "failed", diagnostic: diagnostic(`HUD has no \`${key}\` key.`) };
        }
        return observation.hud[key] === assertion.equals ? { ...base, status: "passed" } : {
          ...base,
          status: "failed",
          diagnostic: diagnostic(`HUD \`${key}\` was ${JSON.stringify(observation.hud[key]) ?? "unrepresentable"}.`),
        };
      }
      case "counterAtLeast":
      case "counterEquals": {
        const key = assertion.key as string;
        const actual = observation.counters[key];
        if (typeof actual !== "number" || !Number.isFinite(actual)) {
          return { ...base, status: "unknown", diagnostic: diagnostic(`Counter \`${key}\` was not reported as a number.`) };
        }
        const passed = assertion.kind === "counterAtLeast"
          ? actual >= (assertion.value as number)
          : actual === (assertion.value as number);
        return passed ? { ...base, status: "passed" } : {
          ...base,
          status: "failed",
          diagnostic: diagnostic(`Counter \`${key}\` was ${actual}.`),
        };
      }
      case "finishedWithinTicks": {
        if (typeof observation.tick !== "number" || !Number.isFinite(observation.tick)) {
          return { ...base, status: "unknown", diagnostic: diagnostic("The run reported no tick count.") };
        }
        return observation.tick <= (assertion.max as number) ? { ...base, status: "passed" } : {
          ...base,
          status: "failed",
          diagnostic: diagnostic(`The run stopped at tick ${observation.tick}.`),
        };
      }
      default:
        // Unreachable for validated scenarios; defensive so an unknown kind
        // can never silently pass.
        return { ...base, status: "unknown", diagnostic: diagnostic("Unsupported assertion kind.") };
    }
  });
  if (assertions.some((result) => result.status === "unknown")) {
    return deepFreeze({
      scenarioId: scenario.scenarioId,
      verdict: "inconclusive",
      verdictReason: "unresolved_assertions",
      assertions,
    });
  }
  if (assertions.some((result) => result.status === "failed")) {
    return deepFreeze({ scenarioId: scenario.scenarioId, verdict: "failed", assertions });
  }
  if (!observation.finishedWithinBudget) {
    return deepFreeze({
      scenarioId: scenario.scenarioId,
      verdict: "inconclusive",
      verdictReason: "tick_budget_exhausted",
      assertions,
    });
  }
  return deepFreeze({ scenarioId: scenario.scenarioId, verdict: "passed", assertions });
}
