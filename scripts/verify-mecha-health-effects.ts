import assert from "node:assert/strict";
import test from "node:test";
import { bossPrepare, createMatch, playTurn, type ArenaPlan, type MatchState } from "../apps/agent-city/ui/src/game/mecha/rules.ts";
import { healthSnapshot } from "../apps/agent-city/ui/src/game/mecha/board.ts";
import { buildHealthTimeline } from "../apps/agent-city/ui/src/game/mecha/healthTimeline.ts";
import { presentationSnapshot } from "../apps/agent-city/ui/src/game/mecha/presentationSnapshot.ts";
import { buildPresentationRoutes } from "../apps/agent-city/ui/src/game/mecha/presentationRoutes.ts";
import { planForDoctrine } from "../apps/agent-city/ui/src/game/mecha/ai.ts";

const key = (kind: string, id: string) => `${kind}:${id}`;
function verify(state: MatchState, plan: ArenaPlan) {
  const health = new Map(healthSnapshot(state).map((v) => [key(v.kind, v.id), v.after]));
  const result = playTurn(state, plan);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("plan rejected");
  assert.ok(result.presentationStages, "accepted turns must expose presentation stages");
  assert.deepEqual(result.presentationStages.before, presentationSnapshot(state));
  assert.deepEqual(result.presentationStages.afterPrepare, presentationSnapshot(result.state));
  assert.equal(buildPresentationRoutes(state, result.log).ok, true, "accepted movement has a rules-consistent route");
  const timeline = buildHealthTimeline(state, result.state, result.log);
  assert.equal(timeline.ok, true, timeline.ok ? "" : timeline.reason);
  const effects = result.log.flatMap((event) => "effects" in event ? event.effects ?? [] : []).sort((a, b) => a.order - b.order);
  effects.forEach((effect, i) => {
    assert.equal(effect.order, i, "effect ordering must be contiguous, including nested shoves");
    const k = key(effect.kind, effect.id);
    assert.equal(health.get(k), effect.before, `before value for ${k} at effect ${i}`);
    assert.notEqual(effect.before, effect.after);
    health.set(k, effect.after);
  });
  assert.deepEqual([...health], healthSnapshot(result.state).map((v) => [key(v.kind, v.id), v.after]));
  return result;
}

test("event effects capture damage, multi-target collisions and capped repair", () => {
  const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], boss: { x: 4, y: 0 }, mechs: [
    { id: "Assault", pos: { x: 3, y: 1 } }, { id: "Gunner", pos: { x: 6, y: 0 } }, { id: "Support", pos: { x: 7, y: 0 } },
  ] });
  state.mechs.find((m) => m.id === "Gunner")!.hp = 9;
  bossPrepare(state);
  const result = verify(state, { revision: state.revision, items: [
    { mechId: "Assault", moveTo: null, action: { kind: "melee", target: "boss" } },
    { mechId: "Gunner", moveTo: null, action: { kind: "skip" } },
    { mechId: "Support", moveTo: null, action: { kind: "repair", target: "Gunner" } },
  ] });
  const shove = result.log.find((event) => event.type === "shove" && event.unit === "boss");
  assert.ok(shove && shove.type === "shove");
  assert.ok(shove.effects?.some((effect) => effect.kind === "boss"));
  assert.ok(shove.effects?.some((effect) => effect.kind === "mech" && effect.id === "Gunner"));
  const heal = result.log.find((event) => event.type === "act" && event.action === "repair");
  assert.ok(heal && heal.type === "act");
  assert.ok(heal.effects?.some((effect) => effect.id === "Gunner" && effect.after > effect.before));
});

test("effects reconstruct health throughout automated siege and non-siege matches", () => {
  for (const script of ["stationary_smash", "cadence_ssw", "siege"] as const) for (const doctrine of ["tunnel", "peel"] as const) {
    let state = createMatch({ preset: "covers_sparse_mid", script });
    bossPrepare(state);
    for (let i = 0; i < 15 && !state.outcome; i++) {
      const result = verify(state, planForDoctrine(state, doctrine));
      state = result.state;
    }
  }
});


test("a missing, duplicated or malformed effect refuses presentation replay", () => {
  const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", covers: [], boss: { x: 4, y: 0 }, mechs: [
    { id: "Assault", pos: { x: 3, y: 1 } }, { id: "Gunner", pos: { x: 0, y: 9 } }, { id: "Support", pos: { x: 8, y: 9 } },
  ] });
  bossPrepare(state);
  const result = verify(state, { revision: state.revision, items: [
    { mechId: "Assault", moveTo: null, action: { kind: "melee", target: "boss" } },
    { mechId: "Gunner", moveTo: null, action: { kind: "skip" } },
    { mechId: "Support", moveTo: null, action: { kind: "skip" } },
  ] });
  const missing = structuredClone(result.log);
  for (const event of missing) if ("effects" in event) delete event.effects;
  assert.equal(buildHealthTimeline(state, result.state, missing).ok, false);
  const duplicate = structuredClone(result.log);
  const damaged = duplicate.find((event) => "effects" in event && event.effects?.length);
  if (!damaged || !("effects" in damaged) || !damaged.effects) throw new Error("missing damage");
  damaged.effects.push({ ...damaged.effects[0]! });
  assert.equal(buildHealthTimeline(state, result.state, duplicate).ok, false);
});
