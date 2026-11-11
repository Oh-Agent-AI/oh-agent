import { test } from "node:test";
import assert from "node:assert/strict";
import { applyStatus, endStatusTurn, removeStatus, statusBlocks, type Status } from "../src/game/mecha/statusEffects.ts";
const poison: Status = { kind: "poison", target: "Assault", source: "boss", magnitude: 3, remainingTurns: 2 };

test("statuses retain source, refresh independently, and do not mutate inputs", () => {
  const input = [structuredClone(poison)], before = structuredClone(input);
  const refresh = applyStatus(input, { ...poison, magnitude: 1, remainingTurns: 4 });
  assert.ok(refresh.ok); assert.deepEqual(input, before);
  assert.deepEqual(refresh.statuses[0], { ...poison, remainingTurns: 4 });
  assert.equal(refresh.events[0]?.type, "status_refreshed");
  const other = applyStatus(refresh.statuses, { ...poison, source: "raider" });
  assert.ok(other.ok); assert.equal(other.statuses.length, 2);
});

test("periodic damage and expiry occur on the affected actor's turn only", () => {
  const other = endStatusTurn([poison], "Gunner"); assert.ok(other.ok); assert.deepEqual(other.statuses, [poison]); assert.deepEqual(other.events, []);
  const first = endStatusTurn([poison], "Assault"); assert.ok(first.ok);
  assert.deepEqual(first.events, [{ type: "status_damage", target: "Assault", source: "boss", kind: "poison", amount: 3 }, { type: "status_advanced", status: { ...poison, remainingTurns: 1 } }]);
  const last = endStatusTurn(first.statuses, "Assault"); assert.ok(last.ok); assert.deepEqual(last.statuses, []);
  assert.deepEqual(last.events.map(e => e.type), ["status_damage", "status_expired"]);
});

test("freeze blocks movement, stun also blocks actions, and removal is source scoped by kind", () => {
  const freeze: Status = { ...poison, kind: "freeze", magnitude: 0 };
  const stun: Status = { ...freeze, kind: "stun", source: "raider" };
  assert.deepEqual(statusBlocks([freeze], "Assault"), { move: true, action: false });
  assert.deepEqual(statusBlocks([freeze, stun], "Assault"), { move: true, action: true });
  const result = removeStatus([freeze, stun], "Assault", "stun"); assert.ok(result.ok);
  assert.deepEqual(result.statuses, [freeze]); assert.equal(result.events[0]?.type, "status_removed");
});

test("invalid or duplicate input fails closed without partial status changes", () => {
  assert.equal(applyStatus([], { ...poison, remainingTurns: 0 }).ok, false);
  assert.equal(endStatusTurn([poison, poison], "Assault").ok, false);
  assert.equal(statusBlocks([{ ...poison, magnitude: NaN }], "Assault"), null);
});

test("poison and burn retain distinct sources and deterministic damage order", () => {
  const burn: Status = { ...poison, kind: "burn", source: "flame", magnitude: 2, remainingTurns: 1 };
  const result = endStatusTurn([poison, burn], "Assault"); assert.ok(result.ok);
  assert.deepEqual(result.events.map(e => e.type), ["status_damage", "status_advanced", "status_damage", "status_expired"]);
  assert.deepEqual(result.events.filter(e => e.type === "status_damage").map(e => e.type === "status_damage" ? [e.kind, e.amount, e.source] : null), [["poison", 3, "boss"], ["burn", 2, "flame"]]);
  assert.deepEqual(result.statuses, [{ ...poison, remainingTurns: 1 }]);
});
