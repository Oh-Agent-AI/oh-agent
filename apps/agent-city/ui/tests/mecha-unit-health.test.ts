import assert from "node:assert/strict";
import test from "node:test";
import { RAIDER_HP, SWARM_CHILD_HP, type MatchState } from "../src/game/mecha/board";
import { inspectCell } from "../src/game/mecha/cellInspection";
import { bossPrepare, createMatch, playTurn } from "../src/game/mecha/rules";
import { unitHealth, unitMaxHp } from "../src/game/mecha/unitHealth";

test("life maxima come from the combat rules, not the current injured life", () => {
  assert.equal(unitMaxHp("Assault"), 14);
  assert.equal(unitMaxHp("Gunner"), 11);
  assert.equal(unitMaxHp("Support"), 12);
  assert.equal(unitMaxHp("boss"), 40);
  for (const id of ["raider-w", "raider-e", "raider-west", "raider-east"]) assert.equal(unitMaxHp(id), RAIDER_HP);
  assert.equal(unitMaxHp("raider-unknown"), null);
  assert.equal(unitMaxHp("toString"), null);
  assert.deepEqual(unitHealth(7, unitMaxHp("Assault")), { known: true, ratio: 0.5, text: "7 / 14" });
});
test("life bars retain numeric evidence and clamp visual fill only", () => {
  assert.deepEqual(unitHealth(0, 14), { known: true, ratio: 0, text: "0 / 14" });
  assert.deepEqual(unitHealth(15, 14), { known: true, ratio: 1, text: "15 / 14" });
  assert.equal(unitHealth(3, 8).ratio, 0.375);
});
test("missing or invalid life is visibly unknown, never fabricated full/empty", () => {
  for (const [hp, max] of [[undefined, 14], [NaN, 14], [-1, 14], [Infinity, 14], [7, null], [7, 0], [7, NaN], [7, Infinity]] as Array<[number | undefined, number | null]>) {
    assert.deepEqual(unitHealth(hp, max), { known: false, ratio: null, text: "?" });
  }
});

test("authoritative L5 children show their initial, injured and zero health against the shared maximum", () => {
  const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash", difficulty: "hard",
    monsterContent: { speciesId: "swarm_mantle", contentVersion: 1 },
    boss: { x: 4, y: 4 }, covers: [], buildings: [],
    raiders: [{ id: "ordinary", pos: { x: 8, y: 8 } }],
    mechs: [
      { id: "Assault", pos: { x: 4, y: 2 } }, { id: "Gunner", pos: { x: 0, y: 9 } },
      { id: "Support", pos: { x: 1, y: 9 } },
    ],
  });
  bossPrepare(state);
  const result = playTurn(state, { revision: state.revision, items: state.mechs.map(mech =>
    ({ mechId: mech.id, moveTo: null, action: { kind: "skip" as const } })) });
  assert.ok(result.ok, JSON.stringify(result));
  const child = result.state.raiders.find(raider => raider.summon?.speciesId === "swarm_child");
  assert.ok(child, "the combat rules must actually spawn a child");
  assert.equal(SWARM_CHILD_HP, 2);
  assert.equal(child.hp, SWARM_CHILD_HP);
  assert.equal(unitMaxHp(child.id, result.state), SWARM_CHILD_HP);
  assert.deepEqual(unitHealth(child.hp, unitMaxHp(child.id, result.state)), { known: true, ratio: 1, text: "2 / 2" });
  assert.equal(inspectCell(result.state, child.pos, {}, child.id)?.unit?.maxHp, SWARM_CHILD_HP);
  child.hp = 1;
  assert.deepEqual(unitHealth(child.hp, unitMaxHp(child.id, result.state)), { known: true, ratio: 0.5, text: "1 / 2" });
  child.hp = 0;
  assert.deepEqual(unitHealth(child.hp, unitMaxHp(child.id, result.state)), { known: true, ratio: 0, text: "0 / 2" });
  assert.equal(unitMaxHp("ordinary", result.state), RAIDER_HP);
});

test("child maximum requires matching summon metadata, never an id prefix", () => {
  const state = createMatch({ preset: "covers_sparse_mid", script: "stationary_smash",
    boss: { x: 4, y: 4 }, covers: [], buildings: [], raiders: [], mechs: [
      { id: "Assault", pos: { x: 4, y: 2 } }, { id: "Gunner", pos: { x: 0, y: 9 } },
      { id: "Support", pos: { x: 1, y: 9 } },
    ],
  });
  const raider = { pos: { x: 2, y: 2 }, hp: 1, intent: null };
  const marker = { parentId: "boss" as const, speciesId: "swarm_child" as const, expiresAtRound: 3 };
  state.raiders = [
    { ...raider, id: "swarm:ordinary" },
    { ...raider, id: "custom-child", summon: marker },
    { ...raider, id: "raider-w", summon: marker },
    { ...raider, id: "unrelated", summon: { ...marker, speciesId: "other" } as unknown as NonNullable<MatchState["raiders"][number]["summon"]> },
    { ...raider, id: "wrong-parent", summon: { ...marker, parentId: "other" } as unknown as NonNullable<MatchState["raiders"][number]["summon"]> },
    { ...raider, id: "invalid-expiry", summon: { ...marker, expiresAtRound: NaN } },
    { ...raider, id: "early-expiry", summon: { ...marker, expiresAtRound: 2 } },
  ];
  assert.equal(unitMaxHp("swarm:ordinary", state), RAIDER_HP);
  assert.equal(unitMaxHp("swarm:missing", state), null);
  assert.equal(unitMaxHp("swarm:ordinary"), null);
  assert.equal(unitMaxHp("custom-child", state), SWARM_CHILD_HP);
  assert.equal(unitMaxHp("raider-w", state), SWARM_CHILD_HP);
  assert.equal(unitMaxHp("unrelated", state), RAIDER_HP);
  assert.equal(unitMaxHp("wrong-parent", state), RAIDER_HP);
  assert.equal(unitMaxHp("invalid-expiry", state), RAIDER_HP);
  assert.equal(unitMaxHp("early-expiry", state), RAIDER_HP);
  assert.equal(unitMaxHp("raider-east", state), RAIDER_HP);
});
