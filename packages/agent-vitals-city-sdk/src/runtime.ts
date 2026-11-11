import type { DiagnosticV1, HeadlessRunInputV1, MiniGamePackV1, PlaytestEvidenceV1, PlayerRuleInputV1, Result, RuleEventV1, RuleGraphV1, RuleStateV1, RuleStepV1 } from "./types";
import { validateMount } from "./validate";
import { validateMiniGamePack } from "./content";

export interface CompiledRulesV1 { graph: RuleGraphV1; pack: MiniGamePackV1 }
export interface RuleRunV1 {
  step(tick: number, inputs?: ReadonlyArray<PlayerRuleInputV1>): Result<RuleStepV1>;
  snapshot(): Readonly<RuleStateV1>;
  stop(): void;
}

const diagnostic = (code: string, path: string, message: string, objectId?: string): DiagnosticV1 => ({ code, severity: "error", path, message, ...(objectId ? { objectId } : {}) });
const hasOwn = (value: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const RULE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

export function compileRules(value: unknown): Result<CompiledRulesV1> {
  const validation = validateMiniGamePack(value);
  if (!validation.ok) return validation;
  const pack = validation.value;
  const diagnostics: DiagnosticV1[] = [];
  const graph = pack.rules;
  if (pack.schemaVersion !== 1 || pack.rulesVersion !== 1) diagnostics.push(diagnostic("schema_unsupported", "$", "Only City SDK rules version 1 is supported."));
  if (Object.keys(graph.counters).length > 32 || graph.nodes.length > 128) diagnostics.push(diagnostic("rule_budget_exceeded", "rules", "Rule graph exceeds the version 1 size budget."));
  for (const [name, counter] of Object.entries(graph.counters)) {
    if (!name || !Number.isInteger(counter.initial) || !Number.isInteger(counter.max) || counter.max < 0 || counter.initial < 0 || counter.initial > counter.max) diagnostics.push(diagnostic("rule_invalid_counter", `rules.counters.${name}`, "Counter bounds must be non-negative integers and initial must not exceed max."));
  }
  const timers = new Set<string>();
  for (const [index, node] of graph.nodes.entries()) {
    const path = `rules.nodes[${index}]`;
    if (!node.id || node.actions.length > 16) diagnostics.push(diagnostic("rule_budget_exceeded", path, "Each rule needs an ID and may contain at most 16 actions.", node.id));
    if (node.on.type === "zone.entered" || node.on.type === "item.collected") {
      if (!hasOwn(pack.slots, node.on.slot)) diagnostics.push(diagnostic("rule_slot_not_found", `${path}.on.slot`, "Rule references an undeclared slot.", node.id));
      else if (node.on.type === "zone.entered" && pack.slots[node.on.slot].kind !== "zone") diagnostics.push(diagnostic("rule_slot_kind_mismatch", `${path}.on.slot`, "zone.entered rules require a zone slot.", node.id));
    }
    for (const guard of node.when ?? []) if (!hasOwn(graph.counters, guard.counter)) diagnostics.push(diagnostic("rule_counter_not_found", `${path}.when`, "Guard references an undeclared counter.", node.id));
    for (const action of node.actions) {
      if (action.op === "counter.add") {
        if (!hasOwn(graph.counters, action.counter) || !Number.isInteger(action.amount)) diagnostics.push(diagnostic("rule_counter_not_found", `${path}.actions`, "Counter action requires a declared counter and integer amount.", node.id));
      }
      if (action.op === "timer.start") {
        timers.add(action.timerId);
        if (typeof action.durationTicks === "number" && (!Number.isInteger(action.durationTicks) || action.durationTicks < 1)) diagnostics.push(diagnostic("rule_invalid_timer", `${path}.actions`, "Timer duration must be a positive integer.", node.id));
        if (typeof action.durationTicks !== "number" && !(action.durationTicks.parameter in (pack.integerParameters ?? {}))) diagnostics.push(diagnostic("rule_parameter_not_found", `${path}.actions`, "Timer references an undeclared integer parameter.", node.id));
      }
    }
  }
  return diagnostics.length ? { ok: false, diagnostics } : { ok: true, value: { graph, pack }, diagnostics };
}

export function createRun(input: { rules: CompiledRulesV1; mount: { bindings: Record<string, string[]>; parameterOverrides: Record<string, number> }; seed: number }): RuleRunV1 {
  const counters: Record<string, number> = Object.fromEntries(Object.entries(input.rules.graph.counters).map(([name, value]) => [name, value.initial]));
  const timers = new Map<string, number>();
  const hints: string[] = [];
  let currentTick = -1;
  let outcome: "success" | "failure" | null = null;
  let stopped = false;
  const snapshot = (): RuleStateV1 => ({ tick: currentTick, counters: { ...counters }, outcome, hints: [...hints] });
  const dispatch = (event: RuleEventV1) => {
    for (const node of input.rules.graph.nodes) {
      const matches = node.on.type === event.type && (
        event.type === "run.started" ||
        (event.type === "timer.expired" && node.on.type === "timer.expired" && node.on.timerId === event.timerId) ||
        ((event.type === "zone.entered" || event.type === "item.collected") && (node.on.type === "zone.entered" || node.on.type === "item.collected") && node.on.type === event.type && node.on.slot === event.slot)
      );
      if (!matches || outcome) continue;
      const guards = node.when ?? [];
      if (!guards.every(guard => guard.op === "counter.eq" ? counters[guard.counter] === guard.value : event.type !== "run.started" && event.type !== "timer.expired" && counters[guard.counter] === event.index)) continue;
      for (const action of node.actions) {
        if (action.op === "counter.add") {
          const counter = input.rules.graph.counters[action.counter];
          const value = counters[action.counter] + action.amount;
          if (value < 0 || value > counter.max) throw new Error(`rule counter budget exceeded: ${node.id}`);
          counters[action.counter] = value;
        } else if (action.op === "timer.start") {
          const duration = typeof action.durationTicks === "number" ? action.durationTicks : input.mount.parameterOverrides[action.durationTicks.parameter] ?? input.rules.pack.integerParameters?.[action.durationTicks.parameter]?.default;
          if (!Number.isInteger(duration) || (duration as number) < 1) throw new Error(`invalid timer duration: ${node.id}`);
          timers.set(action.timerId, currentTick + (duration as number));
        } else if (action.op === "hud.hint") {
          hints.push(action.text.slice(0, 160));
          if (hints.length > 32) hints.shift();
        }
        else { outcome = action.outcome; break; }
      }
    }
  };
  return {
    step(tick, inputs = []) {
      if (stopped) return { ok: false, diagnostics: [diagnostic("run_stopped", "run", "This rule run has stopped.")] };
      if (!Number.isInteger(tick) || tick !== currentTick + 1) return { ok: false, diagnostics: [diagnostic("rule_tick_out_of_order", "tick", "Ticks must be consecutive integers starting at zero.")] };
      if (tick > 100_000) return { ok: false, diagnostics: [diagnostic("rule_budget_exceeded", "tick", "Rule run exceeded the version 1 step budget.")] };
      if (!Array.isArray(inputs) || inputs.length > 64) return { ok: false, diagnostics: [diagnostic("rule_budget_exceeded", "inputs", "A step may contain at most 64 input events.")] };
      for (const [index, rawInput] of inputs.entries()) {
        const path = `inputs[${index}]`;
        if (!isRecord(rawInput) || Object.keys(rawInput).some(key => !["type", "tick", "slot", "index"].includes(key))
          || (rawInput.type !== "zone.entered" && rawInput.type !== "item.collected")
          || !Number.isSafeInteger(rawInput.tick) || rawInput.tick !== tick
          || typeof rawInput.slot !== "string" || !RULE_ID.test(rawInput.slot)
          || !Number.isSafeInteger(rawInput.index) || (rawInput.index as number) < 0) {
          return { ok: false, diagnostics: [diagnostic("rule_input_invalid", path, "Input must be a supported zone/item event with the current tick and a stable slot ID.")] };
        }
        const bound = input.mount.bindings[rawInput.slot];
        if (!bound || (rawInput.index as number) >= bound.length) return { ok: false, diagnostics: [diagnostic("rule_input_out_of_range", path, "Input index is outside the bound slot.")] };
      }
      currentTick = tick;
      const emitted: RuleEventV1[] = [];
      const before = { counters: { ...counters }, timers: new Map(timers), hints: [...hints], outcome, currentTick: tick - 1 };
      try {
        if (tick === 0) { const event = { type: "run.started", tick } as const; emitted.push(event); dispatch(event); }
        for (const [timerId, due] of [...timers.entries()].filter(([, due]) => due <= tick).sort(([a], [b]) => a.localeCompare(b))) {
          timers.delete(timerId);
          const event = { type: "timer.expired", timerId, tick } as const; emitted.push(event); dispatch(event);
        }
        if (!outcome) for (const inputEvent of inputs) {
          const event: PlayerRuleInputV1 = { type: inputEvent.type, tick, slot: inputEvent.slot, index: inputEvent.index };
          emitted.push(event); dispatch(event);
          if (outcome) break;
        }
      } catch (error) {
        Object.assign(counters, before.counters);
        timers.clear();
        for (const [timerId, due] of before.timers) timers.set(timerId, due);
        hints.splice(0, hints.length, ...before.hints);
        outcome = before.outcome;
        currentTick = before.currentTick;
        return { ok: false, diagnostics: [diagnostic("rule_budget_exceeded", "rules", error instanceof Error ? error.message : "Rule execution failed.")] };
      }
      return { ok: true, value: { state: snapshot(), emitted }, diagnostics: [] };
    },
    snapshot,
    stop() { stopped = true; timers.clear(); },
  };
}

export function runHeadless(input: HeadlessRunInputV1): Result<PlaytestEvidenceV1> {
  if (!isRecord(input) || !Number.isSafeInteger(input.seed) || !Array.isArray(input.trace) || input.trace.length === 0) {
    return { ok: false, diagnostics: [diagnostic("playtest_invalid_input", "$", "Headless run requires an integer seed and a non-empty trace array.")] };
  }
  const trace = input.trace as unknown[];
  if (trace.length > 100_001) return { ok: false, diagnostics: [diagnostic("rule_budget_exceeded", "trace", "Trace exceeds the version 1 step budget.")] };
  for (const [index, step] of trace.entries()) {
    if (!isRecord(step) || Object.keys(step).some(key => !["tick", "inputs"].includes(key)) || !Number.isSafeInteger(step.tick)
      || (step.inputs !== undefined && (!Array.isArray(step.inputs) || step.inputs.length > 64))) {
      return { ok: false, diagnostics: [diagnostic("playtest_invalid_trace", `trace[${index}]`, "Trace steps must contain an integer tick and up to 64 input events.")] };
    }
  }
  const compiled = compileRules(input.game);
  if (!compiled.ok) return { ok: false, diagnostics: compiled.diagnostics };
  const mountResult = validateMount({ layout: input.layout, game: compiled.value.pack, mount: input.mount });
  if (!mountResult.ok) return { ok: false, diagnostics: mountResult.diagnostics };
  const run = createRun({ rules: compiled.value, mount: input.mount, seed: input.seed });
  const failures: DiagnosticV1[] = [];
  let finalState = run.snapshot();
  for (let index = 0; index < input.trace.length; index += 1) {
    const traceStep = input.trace[index]!;
    if (traceStep.tick !== index) {
      failures.push(diagnostic("rule_tick_out_of_order", `trace[${index}].tick`, "Trace ticks must be consecutive integers starting at zero."));
      break;
    }
    const stepped = run.step(traceStep.tick, traceStep.inputs ?? []);
    if (!stepped.ok) { failures.push(...stepped.diagnostics); break; }
    finalState = stepped.value.state;
    if (finalState.outcome) break;
  }
  if (!failures.length && input.expected) {
    if ("outcome" in input.expected && finalState.outcome !== input.expected.outcome) failures.push(diagnostic("playtest_expectation_failed", "expected.outcome", `Expected ${String(input.expected.outcome)}, received ${String(finalState.outcome)}.`));
    for (const [counter, value] of Object.entries(input.expected.counters ?? {})) {
      if (finalState.counters[counter] !== value) failures.push(diagnostic("playtest_expectation_failed", `expected.counters.${counter}`, `Expected ${value}, received ${String(finalState.counters[counter])}.`));
    }
  }
  run.stop();
  const evidence: PlaytestEvidenceV1 = { schemaVersion: 1, passed: failures.length === 0, seed: input.seed, stepCount: Math.max(0, finalState.tick + 1), finalState, failures };
  return { ok: true, value: evidence, diagnostics: failures };
}
