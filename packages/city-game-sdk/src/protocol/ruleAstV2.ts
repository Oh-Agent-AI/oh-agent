import type { DiagnosticV1, RuleGraphV1 } from "@oh-agent/city-sdk";

/**
 * ADR-01 spike draft (RFC §3.3, §8 [r1], §10 ADR-01): the minimal ConditionV2 /
 * GameEffectV2 / RuleV2 subset reverse-engineered from the checkpoint-race
 * template literals (`assets/creator/templates/checkpoint-race.json`), plus a
 * pure legacy mapper and a headless evaluator that mirrors the semantics of
 * `packages/agent-vitals-city-sdk/src/runtime.ts` for exactly this subset.
 *
 * This file is a proposal, not a contract: it is intentionally NOT re-exported
 * from `protocol/index.ts` (or any package barrel) until ADR-01 is adjudicated.
 *
 * Source-literal citations used below:
 *  - `[checkpoint-race]`  = a literal that actually appears in the
 *    checkpoint-race template. The flight-checkpoint template is structurally
 *    identical (same four nodes, same guards/effects; only the slot is named
 *    `gates` instead of `points`), so every mapping below covers both vertical
 *    slices by construction.
 *  - `[legacy op set]`    = present in the legacy `RuleGraphV1` vocabulary
 *    (`RuleGuardV1` / `RuleActionV1` in city-sdk types) and in the RFC §3.3
 *    sentence "counter.add / timer.start / hud.hint / outcome 仍有效", but not
 *    exercised by the checkpoint-race template itself.
 *  - `[RFC §3.3]`         = named in the RFC's ConditionV2/EffectV2 sketch but
 *    absent from every template; typed for the ADR-01 Guard/Effect boundary
 *    discussion. The spike evaluator deliberately does NOT certify these
 *    nodes (see `CERTIFIED_*` sets below).
 */

/** Same shape as the City SDK's `Result` so the spike does not invent a dialect. */
export type ResultV2<T> =
  | Readonly<{ ok: true; value: T; diagnostics: readonly DiagnosticV1[] }>
  | Readonly<{ ok: false; diagnostics: readonly DiagnosticV1[] }>;

/**
 * Legacy value literal, shared by `counter.max`, `counter.eq` guard values and
 * `timer.start` durations. `[checkpoint-race]`: `gateTarget` (guard value) and
 * `timeLimitTicks` (timer duration) both arrive as `{parameter}` refs resolved
 * at run time; `counter.add` amount is always a plain integer literal.
 */
export type RuleValueV2 = number | { readonly parameter: string };

/**
 * Operand of the generic comparison conditions. Three sources only — anything
 * richer (arithmetic, cross-event joins) is out of the minimal subset by
 * construction (ADR-01 keeps the AST finite and side-effect free).
 *  - `event`   : a field of the currently dispatching event (`slot`, `index`,
 *                `timerId`, `tick`). `[checkpoint-race]`: the legacy `on.slot`
 *                / `on.timerId` routing keys become `eq(event.<field>, …)`
 *                conditions because RFC §3.3 narrows `RuleV2.on` to plain
 *                event-type strings.
 *  - `literal` : static scalar. `[checkpoint-race]`: the slot/timer literals.
 *  - `parameter`: mount/pack integer parameter, resolved exactly like
 *                runtime.ts (`parameterOverrides[p] ?? pack.default`).
 */
export type ConditionOperandV2 =
  | Readonly<{ source: "event"; path: string }>
  | Readonly<{ literal: number | string }>
  | Readonly<{ parameter: string }>;

/**
 * Finite Condition AST. Leaves and combinators, no recursion budget needed
 * because `fromLegacyRuleGraphV1` only produces a flat `all` of leaves.
 */
export type ConditionV2 =
  /**
   * `[checkpoint-race]` the legacy `node.when: RuleGuardV1[]` array is an
   * implicit AND; the mapper folds it into `all([...])`. An empty legacy
   * guard array maps to `all([])` (vacuously true, mirroring
   * `guards.every(...)` on an empty array in runtime.ts).
   */
  | Readonly<{ kind: "all"; conditions: readonly ConditionV2[] }>
  /** `[RFC §3.3]` combinator, no template literal yet. */
  | Readonly<{ kind: "any"; conditions: readonly ConditionV2[] }>
  /** `[RFC §3.3]` combinator, no template literal yet. */
  | Readonly<{ kind: "not"; condition: ConditionV2 }>
  /**
   * Generic equality on two operands. `[checkpoint-race]` used for the legacy
   * subscription routing keys (`on.slot: "points"`, `on.timerId: "timeout"`),
   * which RFC §3.3 cannot express inside `on: readonly string[]`.
   */
  | Readonly<{ kind: "eq"; left: ConditionOperandV2; right: ConditionOperandV2 }>
  /** `[RFC §3.3]` numeric `>=`; no template literal yet. Non-numeric operands evaluate to false. */
  | Readonly<{ kind: "gte"; left: ConditionOperandV2; right: ConditionOperandV2 }>
  /**
   * `[RFC §3.3]` City Interaction Guard candidate ("actor at anchor"). No
   * game-template literal: this is the City-side face of the ADR-01 boundary
   * and is not certified by the spike evaluator (no actor state exists in
   * runtime.ts).
   */
  | Readonly<{ kind: "at-place"; actor: string; anchor: string }>
  /** `[RFC §3.3]` inventory guard candidate; no template literal, not certified. */
  | Readonly<{ kind: "has-item"; item: string }>
  /**
   * `[checkpoint-race]` the finish rule's guard:
   * `{"op":"counter.eq","counter":"next","value":{"parameter":"gateTarget"}}`.
   * Value resolution mirrors runtime.ts exactly: literal number, or
   * `parameterOverrides[name] ?? pack.integerParameters[name].default`.
   */
  | Readonly<{ kind: "counter.eq"; counter: string; value: RuleValueV2 }>
  /**
   * `[checkpoint-race]` the advance rule's guard:
   * `{"op":"counter.eqEventIndex","counter":"next"}` — counter must equal the
   * `index` of the triggering zone/item event. runtime.ts makes this guard
   * false on `run.started` / `timer.expired` events; the evaluator mirrors
   * that, it does not throw.
   */
  | Readonly<{ kind: "counter.eqEventIndex"; counter: string }>;

/**
 * Effect whitelist (RFC §3.3 `set/inc/emit/...`; ADR-01 spike trims to these
 * six). Only the four certified ops can appear in an evaluator verdict — the
 * certified set is exactly what runtime.ts implements.
 */
export type GameEffectV2 =
  /**
   * `[RFC §3.3]` write a state address. No legacy literal maps to it
   * (`RuleActionV1` has no `set`), and the spike evaluator refuses it: giving
   * it ad-hoc semantics here would invent state-addressing rules ADR-01 has
   * not decided (`target` naming is itself an open question).
   */
  | Readonly<{ op: "set"; target: string; value: RuleValueV2 }>
  /**
   * `[checkpoint-race]` maps legacy `{"op":"counter.add","counter":"next",
   * "amount":1}`. Budget check mirrors runtime.ts: ceiling comes from
   * `counters[counter].max` (literal or parameter ref), and a resulting value
   * outside `[0, ceiling]` rolls the whole step back — it is a rejected step,
   * not a clamp.
   */
  | Readonly<{ op: "inc"; counter: string; amount: number }>
  /**
   * `[RFC §3.3]` emit a world event. No template literal and no runtime.ts
   * semantics; kept in the whitelist because it is the Game→City effect
   * candidate the ADR-01 boundary discussion needs (which effects may leave
   * the Game SDK and become City WorldEvents).
   */
  | Readonly<{ op: "emit"; eventType: string }>
  /**
   * `[checkpoint-race]` `start-timer` node:
   * `{"op":"timer.start","timerId":"timeout","durationTicks":{"parameter":"timeLimitTicks"}}`.
   * Duration resolution mirrors runtime.ts (literal, else overrides → pack
   * default; `< 1` or non-integer rejects the step). Expiry semantics (due
   * tick, timerId-sorted firing, delete-then-dispatch) live in the evaluator,
   * mirroring runtime.ts — the AST itself carries no scheduler.
   */
  | Readonly<{ op: "timer.start"; timerId: string; durationTicks: RuleValueV2 }>
  /**
   * `[checkpoint-race]` finish/timeout nodes: terminal. After a `run.finish`
   * fires, later rules in the same dispatch and later inputs in the same step
   * are skipped (mirrors runtime.ts `if (!matches || outcome) continue;`).
   */
  | Readonly<{ op: "run.finish"; outcome: "success" | "failure" }>
  /**
   * `[legacy op set, RFC §3.3]` bounded HUD text (runtime.ts truncates to 160
   * chars and retains the last 32). Not in the checkpoint-race template but
   * part of the certified subset because runtime.ts implements it and the
   * mapper must handle every legacy action op deterministically.
   */
  | Readonly<{ op: "hud.hint"; text: string }>;

/**
 * RFC §3.3 RuleV2 shape, verbatim. Note what is deliberately NOT here:
 * the counters/timers state table. The legacy graph's `counters` record
 * (initial/max, with parameter-referencing max) is a graph-level state
 * declaration, not a per-rule property — the spike passes it to the evaluator
 * through `RuleEvalContextV2` and flags the placement as a RuleSetV2 decision.
 */
export interface RuleV2 {
  readonly schemaVersion: 2;
  /** `[checkpoint-race]` legacy `node.id` (`start-timer` / `advance` / `finish` / `timeout`). */
  readonly id: string;
  /**
   * Synthesized `"1"`: the legacy graph carries no per-node version. A real
   * RuleSetV2 layer must decide where version identity lives (rule vs
   * ruleset vs package digest) — flagged as a semantic gap, not solved here.
   */
  readonly version: string;
  /**
   * Namespaced event-type subscription. `[checkpoint-race]` the spike keeps
   * the legacy event vocabulary verbatim (`run.started`, `zone.entered`,
   * `item.collected`, `timer.expired`) so the对照 consumes the same event
   * objects as runtime.ts; V3 namespacing (e.g. `city.world.zone.entered`)
   * is a renaming decision that must not change semantics.
   */
  readonly on: readonly string[];
  /**
   * Finite guard AST. The legacy per-`on` routing key (`slot` / `timerId`)
   * is folded in here as an `eq(event.<field>, literal)` condition, keeping
   * the guard order-insensitive relative to the legacy `when` array.
   */
  readonly when: ConditionV2;
  readonly effects: readonly GameEffectV2[];
  /**
   * Per-rule failure policy. The certified subset only ever fails a rule via
   * effect budget violations, and legacy runtime.ts has no per-rule policy —
   * it rolls back the whole step (equivalent to `reject`). `"skip"` is typed
   * per RFC §3.3 but its semantics (skip remaining effects of this rule,
   * still deliver earlier effects of the same rule) are a spike proposal.
   */
  readonly onFailure: "reject" | "skip";
}

/** Unchanged structural twin of the legacy `RuleGraphV1` input the mapper consumes. */
export type LegacyRuleGraphV1 = RuleGraphV1;

/**
 * Evaluation context. `counters` is the legacy graph's state table passed
 * through unchanged (structurally identical to `RuleGraphV1["counters"]`);
 * the two parameter layers mirror runtime.ts resolution order
 * (`parameterOverrides[name] ?? packParameters[name].default`, then `??` falls
 * through to `undefined`, which makes guards false and budgets reject — the
 * same as runtime.ts, including the undefined case).
 */
export interface RuleEvalContextV2 {
  readonly counters?: Readonly<Record<string, Readonly<{ initial: number; max: RuleValueV2 }>>>;
  readonly parameterOverrides?: Readonly<Record<string, number>>;
  readonly packParameters?: Readonly<Record<string, Readonly<{ min: number; max: number; default: number }>>>;
}

/** One headless trace step — same shape as city-sdk `HeadlessTraceStepV1`. */
export interface RuleTraceStepV2 {
  readonly tick: number;
  readonly inputs?: readonly RuleInputEventV2[];
}

/** Player input event, same shape as city-sdk `PlayerRuleInputV1`. */
export type RuleInputEventV2 = Readonly<{ type: "zone.entered" | "item.collected"; tick: number; slot: string; index: number }>;

/** Derived + input events, same shape as city-sdk `RuleEventV1`. */
export type RuleEventV2 =
  | Readonly<{ type: "run.started"; tick: number }>
  | Readonly<{ type: "zone.entered" | "item.collected"; tick: number; slot: string; index: number }>
  | Readonly<{ type: "timer.expired"; tick: number; timerId: string }>;

/** Final observable state, structurally identical to city-sdk `RuleStateV1` plus the emitted stream. */
export interface RuleOutcomeV2 {
  readonly tick: number;
  readonly counters: Readonly<Record<string, number>>;
  readonly outcome: "success" | "failure" | null;
  readonly hints: readonly string[];
  readonly emitted: readonly RuleEventV2[];
}

export type RuleVerdictV2 = ResultV2<RuleOutcomeV2>;

const diagnostic = (code: string, path: string, message: string, objectId?: string): DiagnosticV1 =>
  ({ code, severity: "error", path, message, ...(objectId ? { objectId } : {}) });
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hasOwn = (value: Record<string, unknown>, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

/** Codes used by the spike; proposal-only vocabulary, not in any frozen list yet. */
const CODE_UNSUPPORTED_OP = "legacy_rule_operation_unsupported";
const CODE_REFERENCE_MISSING = "legacy_rule_reference_missing";
const CODE_INVALID_NODE = "legacy_rule_invalid_node";
const CODE_AST_UNSUPPORTED_NODE = "v2_ast_unsupported_node";
const CODE_TICK_ORDER = "rule_tick_out_of_order";
const CODE_BUDGET = "rule_budget_exceeded";

const EVENT_FIELD_OPERAND = (field: "slot" | "timerId"): ConditionOperandV2 => ({ source: "event", path: field });
const LITERAL_OPERAND = (value: number | string): ConditionOperandV2 => ({ literal: value });

/** Effects the spike evaluator certifies — exactly what runtime.ts implements. */
const CERTIFIED_EFFECT_OPS: ReadonlySet<string> = new Set(["inc", "timer.start", "hud.hint", "run.finish"]);
/** Conditions the spike evaluator certifies — runtime.ts implements counter.eq / counter.eqEventIndex; the generic eq/gte/all/any/not carry no new runtime semantics (pure boolean/numeric comparisons over the same operand resolution). */
const CERTIFIED_CONDITION_KINDS: ReadonlySet<string> = new Set(["all", "any", "not", "eq", "gte", "counter.eq", "counter.eqEventIndex"]);

const deepFreeze = <T,>(value: T): T => {
  if (Array.isArray(value)) {
    value.forEach(deepFreeze);
    return Object.freeze(value);
  }
  if (isRecord(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
  }
  return value;
};

const isParameterValue = (value: unknown): value is RuleValueV2 =>
  typeof value === "number" || (isRecord(value) && typeof value.parameter === "string" && value.parameter.length > 0);

/**
 * Map a legacy `RuleGraphV1` (the checkpoint-race / flight-checkpoint shape)
 * onto the minimal `RuleV2` draft. Pure: never throws, never mutates the
 * input; every unrecognized `on.type` / guard op / action op becomes a
 * diagnostic, and the result is not ok while any diagnostic exists — a
 * partially-mapped rule set must never masquerade as a complete verdict
 * (V3-12 semantics).
 *
 * Known gaps flagged, not solved (see ADR-01 spike report):
 *  - the legacy per-node version does not exist; `"1"` is synthesized;
 *  - the counters state table stays outside `RuleV2` (graph-level concern);
 *  - the legacy `on.slot` / `on.timerId` routing keys move into `when` as
 *    `eq(event.<field>, literal)` conditions because `RuleV2.on` carries
 *    event types only.
 */
export function fromLegacyRuleGraphV1(graph: unknown): ResultV2<readonly RuleV2[]> {
  const diagnostics: DiagnosticV1[] = [];
  if (!isRecord(graph) || !isRecord(graph.counters) || !Array.isArray(graph.nodes)) {
    return { ok: false, diagnostics: [diagnostic(CODE_INVALID_NODE, "rules", "Legacy rule graph must contain counters and nodes records.")] };
  }
  const counters = graph.counters as Record<string, unknown>;
  const rules: RuleV2[] = [];

  graph.nodes.forEach((rawNode, index) => {
    const path = `rules.nodes[${index}]`;
    if (!isRecord(rawNode) || typeof rawNode.id !== "string" || rawNode.id.length === 0) {
      diagnostics.push(diagnostic(CODE_INVALID_NODE, path, "Legacy rule node needs an id."));
      return;
    }
    const nodeId = rawNode.id;

    // --- on: subscription type + routing key ---------------------------------
    const on = rawNode.on;
    if (!isRecord(on) || typeof on.type !== "string") {
      diagnostics.push(diagnostic(CODE_UNSUPPORTED_OP, `${path}.on`, "Legacy rule node is missing an event type.", nodeId));
      return;
    }
    const onPath = `${path}.on`;
    let subscription: readonly string[];
    let routing: ConditionV2[] = [];
    if (on.type === "run.started") {
      subscription = ["run.started"];
    } else if (on.type === "zone.entered" || on.type === "item.collected") {
      if (typeof on.slot !== "string" || on.slot.length === 0) {
        diagnostics.push(diagnostic(CODE_INVALID_NODE, `${onPath}.slot`, "Zone/item subscriptions need a slot routing key.", nodeId));
        return;
      }
      subscription = [on.type];
      // `[checkpoint-race]` `on.slot: "points"` → eq(event.slot, "points").
      routing = [{ kind: "eq", left: EVENT_FIELD_OPERAND("slot"), right: LITERAL_OPERAND(on.slot) }];
    } else if (on.type === "timer.expired") {
      if (typeof on.timerId !== "string" || on.timerId.length === 0) {
        diagnostics.push(diagnostic(CODE_INVALID_NODE, `${onPath}.timerId`, "Timer subscriptions need a timerId routing key.", nodeId));
        return;
      }
      subscription = ["timer.expired"];
      // `[checkpoint-race]` `on.timerId: "timeout"` → eq(event.timerId, "timeout").
      routing = [{ kind: "eq", left: EVENT_FIELD_OPERAND("timerId"), right: LITERAL_OPERAND(on.timerId) }];
    } else {
      diagnostics.push(diagnostic(CODE_UNSUPPORTED_OP, `${onPath}.type`, `Legacy event type "${on.type}" is outside the V2 minimal subset.`, nodeId));
      return;
    }

    // --- when: implicit AND of legacy guards ---------------------------------
    const whenConditions: ConditionV2[] = [...routing];
    const legacyWhen = rawNode.when;
    if (legacyWhen !== undefined && legacyWhen !== null && !Array.isArray(legacyWhen)) {
      diagnostics.push(diagnostic(CODE_INVALID_NODE, `${path}.when`, "Legacy guards must be an array.", nodeId));
      return;
    }
    for (const [guardIndex, rawGuard] of (legacyWhen ?? []).entries()) {
      const guardPath = `${path}.when[${guardIndex}]`;
      if (!isRecord(rawGuard) || typeof rawGuard.op !== "string") {
        diagnostics.push(diagnostic(CODE_UNSUPPORTED_OP, `${guardPath}.op`, "Legacy guard is missing an operation.", nodeId));
        return;
      }
      if (rawGuard.op === "counter.eq") {
        if (typeof rawGuard.counter !== "string" || !hasOwn(counters, rawGuard.counter)) {
          diagnostics.push(diagnostic(CODE_REFERENCE_MISSING, guardPath, "Guard references an undeclared counter.", nodeId));
          return;
        }
        if (!isParameterValue(rawGuard.value)) {
          diagnostics.push(diagnostic(CODE_INVALID_NODE, `${guardPath}.value`, "counter.eq value must be a number or a parameter reference.", nodeId));
          return;
        }
        // `[checkpoint-race]` finish guard value: `{"parameter":"gateTarget"}`.
        whenConditions.push({
          kind: "counter.eq",
          counter: rawGuard.counter,
          value: typeof rawGuard.value === "number" ? rawGuard.value : { parameter: rawGuard.value.parameter },
        });
        continue;
      }
      if (rawGuard.op === "counter.eqEventIndex") {
        if (typeof rawGuard.counter !== "string" || !hasOwn(counters, rawGuard.counter)) {
          diagnostics.push(diagnostic(CODE_REFERENCE_MISSING, guardPath, "Guard references an undeclared counter.", nodeId));
          return;
        }
        // `[checkpoint-race]` advance guard: `{"op":"counter.eqEventIndex","counter":"next"}`.
        whenConditions.push({ kind: "counter.eqEventIndex", counter: rawGuard.counter });
        continue;
      }
      diagnostics.push(diagnostic(CODE_UNSUPPORTED_OP, `${guardPath}.op`, `Legacy guard op "${rawGuard.op}" is outside the V2 minimal subset.`, nodeId));
      return;
    }

    // --- effects: legacy actions, unknown ops become diagnostics -------------
    const legacyActions = rawNode.actions;
    if (!Array.isArray(legacyActions)) {
      diagnostics.push(diagnostic(CODE_INVALID_NODE, `${path}.actions`, "Legacy actions must be an array.", nodeId));
      return;
    }
    const effects: GameEffectV2[] = [];
    for (const [actionIndex, rawAction] of legacyActions.entries()) {
      const actionPath = `${path}.actions[${actionIndex}]`;
      if (!isRecord(rawAction) || typeof rawAction.op !== "string") {
        diagnostics.push(diagnostic(CODE_UNSUPPORTED_OP, `${actionPath}.op`, "Legacy action is missing an operation.", nodeId));
        return;
      }
      // Note the deliberate divergence from runtime.ts: its dispatch `else`
      // branch would treat any unknown action as run.finish(undefined); the
      // legacy compileRules rejects unknown ops before dispatch, and this
      // mapper makes the rejection explicit instead of inheriting the trap.
      if (rawAction.op === "counter.add") {
        const amount = rawAction.amount;
        if (typeof rawAction.counter !== "string" || !hasOwn(counters, rawAction.counter) || typeof amount !== "number" || !Number.isInteger(amount)) {
          diagnostics.push(diagnostic(CODE_REFERENCE_MISSING, actionPath, "counter.add requires a declared counter and integer amount.", nodeId));
          return;
        }
        // `[checkpoint-race]` advance action: `{"op":"counter.add","counter":"next","amount":1}`.
        effects.push({ op: "inc", counter: rawAction.counter, amount });
        continue;
      }
      if (rawAction.op === "timer.start") {
        if (typeof rawAction.timerId !== "string" || rawAction.timerId.length === 0 || !isParameterValue(rawAction.durationTicks)) {
          diagnostics.push(diagnostic(CODE_INVALID_NODE, actionPath, "timer.start needs a timerId and a number-or-parameter duration.", nodeId));
          return;
        }
        // `[checkpoint-race]` start-timer action: durationTicks `{"parameter":"timeLimitTicks"}`.
        effects.push({
          op: "timer.start",
          timerId: rawAction.timerId,
          durationTicks: typeof rawAction.durationTicks === "number" ? rawAction.durationTicks : { parameter: rawAction.durationTicks.parameter },
        });
        continue;
      }
      if (rawAction.op === "hud.hint") {
        if (typeof rawAction.text !== "string") {
          diagnostics.push(diagnostic(CODE_INVALID_NODE, actionPath, "hud.hint needs text.", nodeId));
          return;
        }
        effects.push({ op: "hud.hint", text: rawAction.text });
        continue;
      }
      if (rawAction.op === "run.finish") {
        if (rawAction.outcome !== "success" && rawAction.outcome !== "failure") {
          diagnostics.push(diagnostic(CODE_INVALID_NODE, actionPath, "run.finish outcome must be success or failure.", nodeId));
          return;
        }
        effects.push({ op: "run.finish", outcome: rawAction.outcome });
        continue;
      }
      diagnostics.push(diagnostic(CODE_UNSUPPORTED_OP, `${actionPath}.op`, `Legacy action op "${rawAction.op}" is outside the V2 minimal subset.`, nodeId));
      return;
    }

    rules.push(deepFreeze({
      schemaVersion: 2 as const,
      id: nodeId,
      version: "1",
      on: subscription,
      when: { kind: "all", conditions: whenConditions } satisfies ConditionV2,
      effects,
      onFailure: "reject" as const,
    }));
  });

  return diagnostics.length
    ? { ok: false, diagnostics }
    : { ok: true, value: deepFreeze(rules), diagnostics: [] };
}

// --- evaluator ---------------------------------------------------------------

/**
 * Concrete dispatch event: the union of the legacy event shapes with every
 * payload field optional, so `run.started` / `timer.expired` / player inputs
 * flow through one dispatch path exactly like runtime.ts. Constructed events
 * are always exact `RuleEventV2` members.
 */
interface DispatchEvent {
  readonly type: "run.started" | "zone.entered" | "item.collected" | "timer.expired";
  readonly tick: number;
  readonly slot?: string;
  readonly index?: number;
  readonly timerId?: string;
}

class StepError extends Error {}

/** Guard/effects kinds the evaluator refuses outright (fail-closed, no verdict). */
const scanForUnsupportedNodes = (rules: readonly RuleV2[]): DiagnosticV1[] => {
  const diagnostics: DiagnosticV1[] = [];
  const walkCondition = (condition: ConditionV2, path: string): void => {
    if (!CERTIFIED_CONDITION_KINDS.has(condition.kind)) {
      diagnostics.push(diagnostic(CODE_AST_UNSUPPORTED_NODE, `${path}.kind`, `Condition "${condition.kind}" is not certified by the ADR-01 spike evaluator (City Guard candidate, kept out of the game verdict).`));
      return;
    }
    if (condition.kind === "all" || condition.kind === "any") condition.conditions.forEach((child, i) => walkCondition(child, `${path}.conditions[${i}]`));
    if (condition.kind === "not") walkCondition(condition.condition, `${path}.condition`);
  };
  rules.forEach((rule, ruleIndex) => {
    const path = `rules[${ruleIndex}] (${rule.id})`;
    walkCondition(rule.when, `${path}.when`);
    rule.effects.forEach((effect, effectIndex) => {
      if (!CERTIFIED_EFFECT_OPS.has(effect.op)) {
        diagnostics.push(diagnostic(CODE_AST_UNSUPPORTED_NODE, `${path}.effects[${effectIndex}].op`, `Effect "${effect.op}" is in the V2 whitelist but is not certified by the ADR-01 spike evaluator (no runtime.ts semantics).`));
      }
    });
  });
  return diagnostics;
};

/**
 * Headless对照 evaluator: mirrors `runtime.ts` `createRun`/`step` semantics for
 * exactly the certified subset above, with the same event derivation order
 * (`run.started` at tick 0 → timer expiry, timerId-sorted, due ≤ tick →
 * player inputs, only while no outcome), the same parameter resolution
 * (overrides → pack default), the same counter budget/rollback behavior and
 * the same hud.hint truncation/retention. Binding-level input validation
 * (`rule_input_invalid` / `rule_input_out_of_range`) is deliberately absent:
 * it depends on the mount's slot bindings, which belong to the host, not the
 * rule AST (gap noted in the ADR-01 report).
 */
export function evaluateRuleAstV2(
  rules: readonly RuleV2[],
  steps: readonly RuleTraceStepV2[],
  context: RuleEvalContextV2 = {},
): RuleVerdictV2 {
  const unsupported = scanForUnsupportedNodes(rules);
  if (unsupported.length) return { ok: false, diagnostics: unsupported };

  const counters: Record<string, number> = Object.fromEntries(
    Object.entries(context.counters ?? {}).map(([name, spec]) => [name, spec.initial]),
  );
  const timers = new Map<string, number>();
  const hints: string[] = [];
  const emitted: RuleEventV2[] = [];
  let currentTick = -1;
  let outcome: "success" | "failure" | null = null;

  const resolveParameter = (name: string): number | undefined =>
    context.parameterOverrides?.[name] ?? context.packParameters?.[name]?.default;

  const resolveOperand = (operand: ConditionOperandV2, event: DispatchEvent): number | string | undefined => {
    if ("literal" in operand) return operand.literal;
    if ("parameter" in operand) return resolveParameter(operand.parameter);
    return (event as unknown as Record<string, unknown>)[operand.path] as number | string | undefined;
  };

  const evalCondition = (condition: ConditionV2, event: DispatchEvent): boolean => {
    switch (condition.kind) {
      case "all": return condition.conditions.every(child => evalCondition(child, event));
      case "any": return condition.conditions.some(child => evalCondition(child, event));
      case "not": return !evalCondition(condition.condition, event);
      case "eq": return resolveOperand(condition.left, event) === resolveOperand(condition.right, event);
      case "gte": {
        const left = resolveOperand(condition.left, event);
        const right = resolveOperand(condition.right, event);
        return typeof left === "number" && typeof right === "number" && left >= right;
      }
      case "counter.eq": {
        const target = typeof condition.value === "number" ? condition.value : resolveParameter(condition.value.parameter);
        return counters[condition.counter] === target;
      }
      // runtime.ts: non-counter.eq guards are false on run.started/timer.expired.
      case "counter.eqEventIndex":
        return event.type !== "run.started" && event.type !== "timer.expired" && counters[condition.counter] === event.index;
      default:
        return false; // unreachable: scanForUnsupportedNodes rejects other kinds first
    }
  };

  const dispatch = (event: DispatchEvent): void => {
    for (const rule of rules) {
      if (!rule.on.includes(event.type) || outcome) continue;
      if (!evalCondition(rule.when, event)) continue;
      for (const effect of rule.effects) {
        if (effect.op === "inc") {
          const spec = context.counters?.[effect.counter];
          // runtime.ts: ceiling from literal max, else overrides → pack default.
          const ceiling = spec ? (typeof spec.max === "number" ? spec.max : resolveParameter(spec.max.parameter)) : undefined;
          const value = counters[effect.counter] + effect.amount;
          if (typeof ceiling !== "number" || !Number.isInteger(ceiling) || value < 0 || value > ceiling) throw new StepError(`rule counter budget exceeded: ${rule.id}`);
          counters[effect.counter] = value;
        } else if (effect.op === "timer.start") {
          const duration = typeof effect.durationTicks === "number" ? effect.durationTicks : resolveParameter(effect.durationTicks.parameter);
          if (!Number.isInteger(duration) || (duration as number) < 1) throw new StepError(`invalid timer duration: ${rule.id}`);
          timers.set(effect.timerId, currentTick + (duration as number));
        } else if (effect.op === "hud.hint") {
          hints.push(effect.text.slice(0, 160));
          if (hints.length > 32) hints.shift();
        } else if (effect.op === "run.finish") {
          outcome = effect.outcome;
          break;
        } else {
          // Unreachable: set/emit are rejected by the pre-scan. Fail closed
          // instead of inheriting runtime.ts's unknown-op-as-run.finish trap.
          throw new StepError(`unsupported effect op: ${rule.id}`);
        }
      }
    }
  };

  const stepBudget = 100_000;
  for (const [stepIndex, step] of steps.entries()) {
    if (!Number.isInteger(step.tick) || step.tick !== currentTick + 1) {
      return { ok: false, diagnostics: [diagnostic(CODE_TICK_ORDER, `steps[${stepIndex}].tick`, "Ticks must be consecutive integers starting at zero.")] };
    }
    if (step.tick > stepBudget) {
      return { ok: false, diagnostics: [diagnostic(CODE_BUDGET, `steps[${stepIndex}].tick`, "Rule run exceeded the version 1 step budget.")] };
    }
    const inputs = step.inputs ?? [];
    if (!Array.isArray(inputs) || inputs.length > 64) {
      return { ok: false, diagnostics: [diagnostic(CODE_BUDGET, `steps[${stepIndex}].inputs`, "A step may contain at most 64 input events.")] };
    }
    const before = {
      counters: { ...counters },
      timers: new Map(timers),
      hints: [...hints],
      emittedCount: emitted.length,
      outcome,
      currentTick,
    };
    try {
      const tick = step.tick;
      currentTick = tick;
      if (tick === 0) {
        const event: RuleEventV2 = { type: "run.started", tick };
        emitted.push(event);
        dispatch(event);
      }
      for (const [timerId] of [...timers.entries()].filter(([, due]) => due <= tick).sort(([a], [b]) => a.localeCompare(b))) {
        timers.delete(timerId);
        const event: RuleEventV2 = { type: "timer.expired", timerId, tick };
        emitted.push(event);
        dispatch(event);
      }
      if (!outcome) {
        for (const input of inputs) {
          if (input.tick !== tick) throw new StepError(`input tick mismatch: ${String(input.tick)} != ${String(tick)}`);
          const event: RuleEventV2 = { type: input.type, tick, slot: input.slot, index: input.index };
          emitted.push(event);
          dispatch(event);
          if (outcome) break;
        }
      }
    } catch (error) {
      // runtime.ts rollback: snapshots never expose partial actions.
      Object.assign(counters, before.counters);
      timers.clear();
      for (const [timerId, due] of before.timers) timers.set(timerId, due);
      hints.splice(0, hints.length, ...before.hints);
      emitted.splice(before.emittedCount, emitted.length - before.emittedCount);
      outcome = before.outcome;
      currentTick = before.currentTick;
      return {
        ok: false,
        diagnostics: [diagnostic(CODE_BUDGET, "rules", error instanceof Error ? error.message : "Rule execution failed.")],
      };
    }
    if (outcome) break; // runHeadless parity: stop consuming the trace once settled
  }

  return {
    ok: true,
    value: { tick: currentTick, counters: { ...counters }, outcome, hints: [...hints], emitted },
    diagnostics: [],
  };
}
