import { test } from "node:test";
import assert from "node:assert/strict";
import { isSafeNeuralReplayLedger } from "../src/game/mecha/neuralReplayValidation.ts";

const ledger = () => ({ version: 1, nextLinkId: 1, links: [{ id: "neural-link:0", sourceId: "boss", targetId: "raider:a", range: 3, attackBonus: 2, expiresAtRound: 3 }], resolvedActions: ["neural:1"], pending: { version: 1, round: 2, request: { skillId: "neural_link", actionId: "neural:2", actorId: "boss", targetId: "raider:a", range: 3, attackBonus: 2, lifetime: 2 } }, journal: [{ type: "link_created", round: 1, actionId: "neural:1", link: { id: "neural-link:0", sourceId: "boss", targetId: "raider:a", range: 3, attackBonus: 2, expiresAtRound: 3 } }] });
test("accepts plain bounded neural evidence", () => assert.equal(isSafeNeuralReplayLedger(ledger()), true));
test("rejects nested accessors without executing them", () => {
  const v = ledger(); let reads = 0;
  Object.defineProperty(v.journal[0].link, "targetId", { enumerable: true, get() { reads++; return "x"; } });
  assert.equal(isSafeNeuralReplayLedger(v), false); assert.equal(reads, 0);
});
test("rejects inherited, hidden and sparse evidence", () => {
  const a = ledger(); Object.setPrototypeOf(a.pending.request, { extra: 1 }); assert.equal(isSafeNeuralReplayLedger(a), false);
  const b = ledger(); Object.defineProperty(b.links[0], "hidden", { value: true }); assert.equal(isSafeNeuralReplayLedger(b), false);
  const c = ledger(); delete c.links[0]; assert.equal(isSafeNeuralReplayLedger(c), false);
});
test("rejects inconsistent journal, identities and active state", () => {
  const a = ledger(); a.links[0].targetId = "raider:other"; assert.equal(isSafeNeuralReplayLedger(a), false);
  const b = ledger(); b.nextLinkId = 2; assert.equal(isSafeNeuralReplayLedger(b), false);
  const c = ledger(); c.resolvedActions.push("neural:1"); assert.equal(isSafeNeuralReplayLedger(c), false);
  const d = ledger(); d.journal[0].link.id = "neural-link:9"; assert.equal(isSafeNeuralReplayLedger(d), false);
});
